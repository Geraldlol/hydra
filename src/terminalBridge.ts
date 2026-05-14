import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { stripAnsi, type RunResult } from "./agents";
import type { AgentSpawn } from "./agents";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";
import { expandRequestFileSpawn, resolveAgentCommand } from "./cli";
import { appendHydraEvent, createHydraEvent } from "./events";
import {
  createTerminalSession,
  formatCommandForSession,
  TERMINAL_NAMES,
  TerminalSession,
  TerminalSessionPatch,
  updateTerminalSession,
  writeTerminalSession,
} from "./sessionState";
import {
  buildPowerShellDispatchCommand,
  buildPowerShellDispatchInvocation,
  HYDRA_SYNTHETIC_ECHO_COMMAND,
  buildTerminalReadyCommand,
  buildTerminalPromptFile,
  expandTerminalCommand,
  parseTerminalReply,
  terminalProtocolPaths,
} from "./terminalProtocol";

interface ManagedTerminal {
  terminal: vscode.Terminal;
}

export interface TerminalBridgeOptions {
  onSessionUpdate?: (session: TerminalSession) => void;
  postDispatchSettleMs?: number;
}

export interface TerminalBridgeSelfTestResult {
  ok: boolean;
  message: string;
  logPath: string;
  replyPath: string;
  checks: {
    logBomFree: boolean;
    replyStartsWithJsonObject: boolean;
    outputNotDuplicated: boolean;
    replyParsed: boolean;
  };
}


export class TerminalBridge {
  private readonly terminals = new Map<AgentId, ManagedTerminal>();
  private readonly sessions: Record<AgentId, TerminalSession> = {
    codex: createTerminalSession("codex"),
    claude: createTerminalSession("claude"),
  };
  // Per-agent dispatch chain. Two pokes against the same shell would otherwise
  // race — the second sendText could land before the first PowerShell block
  // finishes, interleaving execution.
  private readonly dispatchChains: Record<AgentId, Promise<void>> = {
    codex: Promise.resolve(),
    claude: Promise.resolve(),
  };
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly options: TerminalBridgeOptions = {}
  ) {
    // Evict closed terminals from the cache so a manually-closed terminal
    // does not stay cached as a black hole that swallows subsequent
    // sendText calls and times out waitForReply.
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        for (const [agent, managed] of this.terminals) {
          if (managed.terminal === terminal) {
            this.terminals.delete(agent);
            void this.setSession(agent, {
              state: "idle",
              detail: "Terminal closed by user",
            });
            break;
          }
        }
      })
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    while (this.disposables.length) this.disposables.pop()?.dispose();
    for (const managed of this.terminals.values()) {
      try { managed.terminal.dispose(); } catch { /* already gone */ }
    }
    this.terminals.clear();
  }

  async openAll(): Promise<void> {
    await Promise.all([this.ensureTerminal("codex"), this.ensureTerminal("claude")]);
  }

  async sendRawLine(agent: AgentId, line: string): Promise<void> {
    const terminal = await this.ensureTerminal(agent);
    const expanded = expandTerminalCommand(line, this.workspaceRoot);
    terminal.sendText(expanded, true);
    await this.setSession(agent, {
      state: "ready",
      detail: "Raw terminal line sent",
      currentCommand: expanded,
    });
  }

  getSessions(): TerminalSession[] {
    return [this.sessions.codex, this.sessions.claude];
  }

  async callAgent(
    agent: AgentId,
    phase: Phase,
    spawn: AgentSpawn,
    prompt: string,
    timeoutMs: number,
    signal: AbortSignal,
    onChunk?: (chunk: string) => void
  ): Promise<RunResult> {
    return (await this.callAgentWithPaths(agent, phase, spawn, prompt, timeoutMs, signal, onChunk)).result;
  }

  async selfTest(timeoutMs: number, signal: AbortSignal = new AbortController().signal): Promise<TerminalBridgeSelfTestResult> {
    const expected = "hydra-terminal-bridge-self-test";
    const chunks: string[] = [];
    const { result, paths } = await this.callAgentWithPaths(
      "codex",
      "opener",
      {
        command: HYDRA_SYNTHETIC_ECHO_COMMAND,
        args: [expected],
        cwd: this.workspaceRoot,
      },
      "Hydra terminal bridge self-test.",
      timeoutMs,
      signal,
      (chunk) => chunks.push(chunk)
    );

    const logBytes = await readFileBytes(paths.logPath);
    const replyBytes = await readFileBytes(paths.replyPath);
    const replyRaw = await readFileText(paths.replyPath);
    let replyParsed = false;
    let replyText = "";
    try {
      const reply = parseTerminalReply(replyRaw);
      replyParsed = true;
      replyText = reply.text;
    } catch {
      replyParsed = false;
    }

    const rendered = chunks.join("") + result.stdout;
    const checks = {
      logBomFree: !startsWithUtf8Bom(logBytes),
      replyStartsWithJsonObject: (replyBytes[0] ?? 0) === 0x7b,
      outputNotDuplicated: normalizeOutput(rendered) === normalizeOutput(replyText),
      replyParsed,
    };
    const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled && Object.values(checks).every(Boolean);
    const failed = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);

    return {
      ok,
      message: ok
        ? "Terminal bridge self-test passed: log is BOM-free, reply JSON starts with `{`, and streamed output is not duplicated."
        : `Terminal bridge self-test failed${failed.length ? `: ${failed.join(", ")}` : ""}.${result.stderr ? ` ${result.stderr}` : ""}`,
      logPath: paths.logPath,
      replyPath: paths.replyPath,
      checks,
    };
  }

  private async callAgentWithPaths(
    agent: AgentId,
    phase: Phase,
    spawn: AgentSpawn,
    prompt: string,
    timeoutMs: number,
    signal: AbortSignal,
    onChunk?: (chunk: string) => void
  ): Promise<{ result: RunResult; paths: ReturnType<typeof terminalProtocolPaths> }> {
    // Serialize per-agent: concurrent pokes against the same shell would
    // otherwise interleave PowerShell dispatch blocks and corrupt reply
    // routing. Each agent has its own chain; both can run in parallel
    // across agents (Promise.all on different agents still races).
    const previous = this.dispatchChains[agent];
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.dispatchChains[agent] = previous.then(() => next).catch(() => undefined);
    await previous;
    try {
      return await this.dispatchSinglePoke(agent, phase, spawn, prompt, timeoutMs, signal, onChunk);
    } finally {
      release();
    }
  }

  private async dispatchSinglePoke(
    agent: AgentId,
    phase: Phase,
    spawn: AgentSpawn,
    prompt: string,
    timeoutMs: number,
    signal: AbortSignal,
    onChunk?: (chunk: string) => void
  ): Promise<{ result: RunResult; paths: ReturnType<typeof terminalProtocolPaths> }> {
    // Time prefix is monotonic for ordering; UUID v4 is the collision guard.
    // Math.random's 24-bit hex tail had a real collision risk under rapid
    // pokes — collided requestId ⇒ collided file paths ⇒ stale reply file
    // parsed as new.
    const requestId = `${Date.now()}-${crypto.randomUUID()}`;
    const paths = terminalProtocolPaths(this.workspaceRoot, requestId, agent, phase);
    await fs.mkdir(path.dirname(paths.promptPath), { recursive: true });
    await fs.mkdir(path.dirname(paths.replyPath), { recursive: true });
    await fs.mkdir(path.dirname(paths.logPath), { recursive: true });
    await fs.mkdir(path.dirname(paths.dispatchPath), { recursive: true });
    await fs.writeFile(paths.promptPath, buildTerminalPromptFile(agent, phase, prompt, paths.replyPath), "utf8");
    await fs.writeFile(paths.logPath, "", "utf8");

    const terminal = await this.ensureTerminal(agent);
    let terminalSpawn: AgentSpawn;
    try {
      terminalSpawn = { ...spawn, command: await resolveAgentCommand(agent, spawn.command) };
    } catch (err) {
      await this.setSession(agent, {
        state: "error",
        detail: `Failed to resolve ${agent} command`,
        currentPhase: phase,
        lastPromptPath: paths.promptPath,
        lastReplyPath: paths.replyPath,
        lastLogPath: paths.logPath,
        lastError: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    await this.setSession(agent, {
      state: "dispatching",
      detail: `${phase} dispatched`,
      requestId,
      currentPhase: phase,
      currentCommand: formatCommandForSession(terminalSpawn.command, terminalSpawn.args),
      lastPromptPath: paths.promptPath,
      lastReplyPath: paths.replyPath,
      lastLogPath: paths.logPath,
    });
    await fs.writeFile(
      paths.dispatchPath,
      buildPowerShellDispatchCommand(
        expandRequestFileSpawn(terminalSpawn, {
          hydraPromptFile: paths.promptPath,
          hydraReplyFile: paths.replyPath,
          hydraLogFile: paths.logPath,
        }),
        paths.promptPath,
        paths.replyPath,
        paths.logPath
      ),
      "utf8"
    );
    terminal.sendText(buildPowerShellDispatchInvocation(paths.dispatchPath), true);
    const chunkHandler = onChunk
      ? (chunk: string) => {
          void this.setSession(agent, {
            state: "streaming",
            detail: `${phase} output streaming`,
          });
          onChunk(chunk);
        }
      : undefined;
    const result = await waitForReply(paths.replyPath, paths.logPath, timeoutMs, signal, this.replyPollMs(), chunkHandler);
    if (result.timedOut || result.cancelled) {
      this.retireTerminal(agent);
    } else {
      // The reply file appears the moment the wrapper writes it, but PowerShell
      // still has a Write-Host + prompt repaint to finish. Settle briefly so
      // the next dispatch's sendText lands on a fresh prompt instead of
      // racing into the previous wrapper's tail.
      await new Promise((r) => setTimeout(r, this.postDispatchSettleMs()));
    }
    await this.setSession(agent, sessionPatchForResult(phase, result, result.timedOut || result.cancelled));
    return { result, paths };
  }

  private postDispatchSettleMs(): number {
    return this.options.postDispatchSettleMs ?? 250;
  }

  private retireTerminal(agent: AgentId): void {
    const managed = this.terminals.get(agent);
    if (!managed) return;
    this.terminals.delete(agent);
    try {
      managed.terminal.dispose();
    } catch {
      // The terminal may already be gone. Either way, Hydra must not reuse it.
    }
  }

  private async ensureTerminal(agent: AgentId): Promise<vscode.Terminal> {
    const existing = this.terminals.get(agent);
    if (existing) {
      existing.terminal.show(false);
      await this.setSession(agent, {
        state: "ready",
        detail: "Native terminal focused",
      });
      return existing.terminal;
    }

    await this.setSession(agent, {
      state: "creating",
      detail: "Opening native terminal",
    });
    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAMES[agent],
      cwd: this.workspaceRoot,
    });
    const managed: ManagedTerminal = { terminal };
    this.terminals.set(agent, managed);
    terminal.show(false);

    const command = this.terminalCommand(agent);
    if (command.trim()) {
      terminal.sendText(expandTerminalCommand(command, this.workspaceRoot), true);
      await delay(this.startupDelayMs());
      await this.setSession(agent, {
        state: "ready",
        detail: "Startup command sent; terminal ready",
        currentCommand: expandTerminalCommand(command, this.workspaceRoot),
      });
    } else {
      terminal.sendText(buildTerminalReadyCommand(agent, this.workspaceRoot), true);
      await this.setSession(agent, {
        state: "ready",
        detail: "Terminal ready for Hydra dispatch",
      });
    }
    return terminal;
  }

  private async setSession(agent: AgentId, patch: TerminalSessionPatch): Promise<void> {
    const previous = this.sessions[agent];
    const next = updateTerminalSession(this.sessions[agent], patch);
    this.sessions[agent] = next;
    try {
      await writeTerminalSession(this.workspaceRoot, next);
      if (shouldRecordSessionEvent(previous, next)) {
        await appendHydraEvent(this.workspaceRoot, createHydraEvent({
          kind: "terminalSessionChanged",
          agent,
          phase: next.currentPhase,
          detail: next.detail,
          data: {
            state: next.state,
            requestId: next.requestId ?? null,
            command: next.currentCommand ?? null,
            hasError: !!next.lastError,
          },
        }));
      }
    } catch {
      // Session files are diagnostics, not a reason to fail the agent call.
      // Doctor covers .hydra writability as a separate setup check.
    }
    this.options.onSessionUpdate?.(next);
  }

  private terminalCommand(agent: AgentId): string {
    const cfg = vscode.workspace.getConfiguration("hydraRoom");
    return cfg.get<string>(`${agent}TerminalCommand`, "");
  }

  private startupDelayMs(): number {
    return vscode.workspace.getConfiguration("hydraRoom").get<number>("terminalStartupDelayMs", 2500);
  }

  private replyPollMs(): number {
    return vscode.workspace.getConfiguration("hydraRoom").get<number>("terminalReplyPollMs", 500);
  }
}

function shouldRecordSessionEvent(previous: TerminalSession, next: TerminalSession): boolean {
  return previous.state !== next.state ||
    previous.detail !== next.detail ||
    previous.currentCommand !== next.currentCommand ||
    previous.currentPhase !== next.currentPhase ||
    previous.lastError !== next.lastError;
}

function sessionPatchForResult(phase: Phase, result: RunResult, terminalRetired = false): TerminalSessionPatch {
  const retiredSuffix = terminalRetired ? "; terminal reset for next request" : "";
  if (result.cancelled) {
    return {
      state: "cancelled",
      detail: `${phase} cancelled${retiredSuffix}`,
    };
  }
  if (result.timedOut) {
    return {
      state: "timedOut",
      detail: `${phase} timed out${retiredSuffix}`,
      lastError: result.stderr || `Timed out after ${result.timeoutMs ?? "unknown"}ms`,
    };
  }
  if (result.exitCode !== 0) {
    return {
      state: "error",
      detail: `${phase} failed`,
      lastError: result.stderr || `exit ${result.exitCode === null ? "spawn-failed" : result.exitCode}`,
    };
  }
  return {
    state: "replied",
    detail: `${phase} replied`,
  };
}

async function waitForReply(
  replyPath: string,
  logPath: string,
  timeoutMs: number,
  signal: AbortSignal,
  pollMs: number,
  onChunk?: (chunk: string) => void
): Promise<RunResult> {
  const start = Date.now();
  let lastParseError = "";
  let logOffset = 0;
  let streamed = "";

  // Race the polling delay against an abort signal so cancellation is
  // observed immediately rather than at most pollMs later.
  const sleepWithAbort = (ms: number): Promise<void> => {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      const onAbort = () => finish();
      if (signal.aborted) finish();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  while (Date.now() - start < timeoutMs) {
    if (signal.aborted) {
      return { stdout: "", stderr: "", exitCode: null, timedOut: false, cancelled: true };
    }
    const chunk = await readLogChunk(logPath, logOffset);
    if (chunk.text) {
      logOffset = chunk.nextOffset;
      streamed += chunk.text;
      onChunk?.(chunk.text);
    }
    try {
      const raw = await fs.readFile(replyPath, "utf8");
      const reply = parseTerminalReply(raw);
      const finalChunk = await readLogChunk(logPath, logOffset);
      if (finalChunk.text) {
        logOffset = finalChunk.nextOffset;
        streamed += finalChunk.text;
        onChunk?.(finalChunk.text);
      }
      const stdout = onChunk ? unstreamedTail(reply.text, streamed) : reply.text;
      if (reply.error) {
        return { stdout, stderr: reply.error, exitCode: 1, timedOut: false, cancelled: false };
      }
      return { stdout, stderr: "", exitCode: 0, timedOut: false, cancelled: false };
    } catch (err) {
      if (isProbablyParseError(err)) {
        lastParseError = err instanceof Error ? err.message : String(err);
      }
    }
    await sleepWithAbort(pollMs);
  }

  if (signal.aborted) {
    return { stdout: "", stderr: "", exitCode: null, timedOut: false, cancelled: true };
  }
  const stderr = lastParseError
    ? `Timed out waiting for terminal reply. Last parse error: ${lastParseError}`
    : "Timed out waiting for terminal reply file.";
  return { stdout: "", stderr, exitCode: null, timedOut: true, cancelled: false, timeoutMs };
}

async function readLogChunk(logPath: string, offset: number): Promise<{ text: string; nextOffset: number }> {
  try {
    const buffer = await fs.readFile(logPath);
    if (buffer.byteLength <= offset) return { text: "", nextOffset: offset };
    return {
      text: stripAnsi(buffer.subarray(offset).toString("utf8")),
      nextOffset: buffer.byteLength,
    };
  } catch {
    return { text: "", nextOffset: offset };
  }
}

function unstreamedTail(finalText: string, streamedText: string): string {
  if (!finalText) return "";
  if (!streamedText) return finalText;
  if (finalText.startsWith(streamedText)) return finalText.slice(streamedText.length);
  const trimmedStream = streamedText.trimEnd();
  const trimmedFinal = finalText.trimEnd();
  if (trimmedFinal === trimmedStream) return "";
  return finalText;
}

function isProbablyParseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return true;
  const code = (err as { code?: unknown }).code;
  return code !== "ENOENT";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function readFileBytes(filePath: string): Promise<Buffer> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return Buffer.alloc(0);
  }
}

async function readFileText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function startsWithUtf8Bom(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

function normalizeOutput(value: string): string {
  return stripAnsi(value).replace(/\r\n/g, "\n").trim();
}
