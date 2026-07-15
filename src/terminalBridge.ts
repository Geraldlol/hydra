import * as crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as vscode from "vscode";
import {
  appendBoundedStream,
  MAX_AGENT_STDOUT_BYTES,
  stripAnsi,
  type BoundedStreamState,
  type RunResult,
} from "./agents";
import type { AgentSpawn } from "./agents";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";
import { effectiveSpawnEnvironment, expandRequestFileSpawn, resolveAgentCommand } from "./cli";
import { appendHydraEvent, createHydraEvent } from "./events";
import {
  createTerminalSession,
  formatCommandForSession,
  TERMINAL_NAMES,
  TerminalSession,
  TerminalSessionPatch,
  terminalSessionPath,
  updateTerminalSession,
} from "./sessionState";
import {
  buildPowerShellDispatchCommand,
  buildPowerShellDispatchInvocation,
  HYDRA_SYNTHETIC_ECHO_COMMAND,
  buildTerminalReadyCommand,
  buildTerminalStartupProbeCommand,
  buildTerminalPromptFile,
  expandTerminalCommand,
  parseTerminalReply,
  terminalProtocolStoragePaths,
  type TerminalProtocolPaths,
  type TerminalReply,
} from "./terminalProtocol";

interface ManagedTerminal {
  terminal: vscode.Terminal;
  environmentFingerprint: string;
}

export interface TerminalBridgeOptions {
  onSessionUpdate?: (session: TerminalSession) => void;
  postDispatchSettleMs?: number;
  /** Extension-owned, per-workspace storage. Must not be inside workspaceRoot. */
  artifactRoot?: string;
}

interface ArtifactBoundary {
  logicalRoot: string;
  realRoot: string;
}

const MAX_TERMINAL_ARTIFACT_BYTES = MAX_AGENT_STDOUT_BYTES + 64 * 1024;

export interface TerminalBridgeSelfTestResult {
  ok: boolean;
  message: string;
  terminationFailed?: boolean;
  logPath: string;
  replyPath: string;
  checks: {
    logBomFree: boolean;
    replyStartsWithJsonObject: boolean;
    outputNotDuplicated: boolean;
    replyParsed: boolean;
  };
}

export interface TerminalBridgeRunResult extends RunResult {
  promptPath: string;
  logPath: string;
  replyPath: string;
  /** Immutable log snapshot authenticated by the terminal reply HMAC. */
  verifiedLog?: string;
}

export interface TerminalWaitResult extends RunResult {
  verifiedLog?: string;
}

export class TerminalBridge {
  private readonly artifactRoot: string;
  private readonly artifactBoundary: Promise<ArtifactBoundary>;
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
  private readonly resolvedCommandCache = new Map<string, Promise<string>>();
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly options: TerminalBridgeOptions = {}
  ) {
    const configuredArtifactRoot = options.artifactRoot ?? defaultTerminalArtifactRoot(workspaceRoot);
    if (!path.isAbsolute(configuredArtifactRoot)) {
      throw new Error("Terminal bridge artifactRoot must be an absolute path.");
    }
    this.artifactRoot = path.resolve(configuredArtifactRoot);
    this.artifactBoundary = prepareTerminalArtifactRoot(workspaceRoot, this.artifactRoot);
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
    // Clear old extension-storage diagnostics without blocking construction.
    void this.artifactBoundary
      .then(() => sweepStaleDispatchArtifacts(this.artifactRoot))
      .catch(() => undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Best-effort retention cleanup on shutdown.
    void this.artifactBoundary
      .then(() => sweepStaleDispatchArtifacts(this.artifactRoot))
      .catch(() => undefined);
    while (this.disposables.length) this.disposables.pop()?.dispose();
    for (const managed of this.terminals.values()) {
      try { managed.terminal.dispose(); } catch { /* already gone */ }
    }
    this.terminals.clear();
  }

  async openAll(): Promise<void> {
    this.assertNotDisposed();
    await Promise.all([this.ensureTerminal("codex"), this.ensureTerminal("claude")]);
  }

  async sendRawLine(agent: AgentId, line: string): Promise<void> {
    this.assertNotDisposed();
    const terminal = await this.ensureTerminal(agent);
    this.assertNotDisposed();
    const expanded = expandTerminalCommand(line, this.workspaceRoot);
    terminal.sendText(expanded, true);
    await this.setSession(agent, {
      state: "ready",
      detail: "Raw terminal line sent",
      currentCommand: expanded,
    });
  }

  getSessions(): TerminalSession[] {
    // Why: sessions is keyed by the now-widened AgentId, so a literal .codex/.claude
    // access is typed as possibly-undefined even though both are always populated
    // by the field initializer; the fallback is unreachable in practice.
    return [this.sessions.codex ?? createTerminalSession("codex"), this.sessions.claude ?? createTerminalSession("claude")];
  }

  async callAgent(
    agent: AgentId,
    phase: Phase,
    spawn: AgentSpawn,
    prompt: string,
    timeoutMs: number,
    signal: AbortSignal,
    onChunk?: (chunk: string) => void
  ): Promise<TerminalBridgeRunResult> {
    const { result, paths } = await this.callAgentWithPaths(agent, phase, spawn, prompt, timeoutMs, signal, onChunk);
    return { ...result, promptPath: paths.promptPath, logPath: paths.logPath, replyPath: paths.replyPath };
  }

  async selfTest(timeoutMs: number, signal: AbortSignal = new AbortController().signal): Promise<TerminalBridgeSelfTestResult> {
    this.assertNotDisposed();
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
      (chunk) => chunks.push(chunk),
      true
    );

    this.assertNotDisposed();
    const boundary = await this.artifactBoundary;
    this.assertNotDisposed();
    const logBytes = await readPrivateArtifact(paths.logPath, boundary).catch(() => Buffer.alloc(0));
    const replyBytes = await readPrivateArtifact(paths.replyPath, boundary).catch(() => Buffer.alloc(0));
    const replyRaw = replyBytes.toString("utf8");
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
      ...(result.terminationFailed ? { terminationFailed: true } : {}),
    };
  }

  private async callAgentWithPaths(
    agent: AgentId,
    phase: Phase,
    spawn: AgentSpawn,
    prompt: string,
    timeoutMs: number,
    signal: AbortSignal,
    onChunk?: (chunk: string) => void,
    allowSyntheticSelfTest = false
  ): Promise<{ result: RunResult; paths: TerminalProtocolPaths }> {
    this.assertNotDisposed();
    if (signal.aborted) return this.cancelledCall(agent, phase);
    // Serialize per-agent: concurrent pokes against the same shell would
    // otherwise interleave PowerShell dispatch blocks and corrupt reply
    // routing. Each agent has its own chain; both can run in parallel
    // across agents (Promise.all on different agents still races).
    // Why: dispatchChains is keyed by the now-widened AgentId; fall back to an
    // already-resolved chain start for an id not yet seeded, matching the
    // field initializer's Promise.resolve() default.
    const previous = this.dispatchChains[agent] ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.dispatchChains[agent] = previous.then(() => next).catch(() => undefined);
    await previous;
    try {
      this.assertNotDisposed();
      if (signal.aborted) return this.cancelledCall(agent, phase);
      return await this.dispatchSinglePoke(
        agent,
        phase,
        spawn,
        prompt,
        timeoutMs,
        signal,
        onChunk,
        allowSyntheticSelfTest
      );
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
    onChunk?: (chunk: string) => void,
    allowSyntheticSelfTest = false
  ): Promise<{ result: RunResult; paths: TerminalProtocolPaths }> {
    // Time prefix is monotonic for ordering; UUID v4 is the collision guard.
    // Math.random's 24-bit hex tail had a real collision risk under rapid
    // pokes — collided requestId ⇒ collided file paths ⇒ stale reply file
    // parsed as new.
    const requestId = `${Date.now()}-${crypto.randomUUID()}`;
    const paths = terminalProtocolStoragePaths(this.artifactRoot, requestId, agent, phase);
    this.assertNotDisposed();
    if (signal.aborted) return { result: cancelledTerminalResult(), paths };
    const boundary = await this.artifactBoundary;
    this.assertNotDisposed();
    if (signal.aborted) return { result: cancelledTerminalResult(), paths };
    const promptFile = buildTerminalPromptFile(agent, phase, prompt, paths.replyPath);
    const creations = await Promise.allSettled([
      createPrivateArtifact(paths.promptPath, promptFile, boundary),
      createPrivateArtifact(paths.replyPath, "", boundary),
      createPrivateArtifact(paths.logPath, "", boundary),
      createPrivateArtifact(paths.lastMessagePath, "", boundary),
    ]);
    const failedCreation = creations.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failedCreation) {
      await cleanupRequestArtifacts(paths);
      throw failedCreation.reason;
    }
    if (this.disposed) {
      await cleanupRequestArtifacts(paths);
      throw new Error("Terminal bridge has been disposed.");
    }
    if (signal.aborted) {
      await cleanupRequestArtifacts(paths);
      return { result: cancelledTerminalResult(), paths };
    }

    let terminalSpawn: AgentSpawn;
    try {
      terminalSpawn = {
        ...spawn,
        command: allowSyntheticSelfTest && spawn.command === HYDRA_SYNTHETIC_ECHO_COMMAND
          ? HYDRA_SYNTHETIC_ECHO_COMMAND
          : await this.resolveAgentCommandCached(agent, spawn.command, effectiveSpawnEnvironment(spawn)),
      };
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
      await cleanupRequestArtifacts(paths);
      throw err;
    }
    if (this.disposed) {
      await cleanupRequestArtifacts(paths);
      throw new Error("Terminal bridge has been disposed.");
    }
    if (signal.aborted) {
      await cleanupRequestArtifacts(paths);
      return { result: cancelledTerminalResult(), paths };
    }
    // Spawn environment overrides are applied by VS Code when it creates the
    // terminal. They never need to be serialized into the dispatch script.
    let terminal: vscode.Terminal;
    try {
      terminal = await this.ensureTerminal(agent, terminalSpawn.env, true);
    } catch (err) {
      await cleanupRequestArtifacts(paths);
      throw err;
    }
    if (this.disposed) {
      await cleanupRequestArtifacts(paths);
      throw new Error("Terminal bridge has been disposed.");
    }
    if (signal.aborted) {
      await cleanupRequestArtifacts(paths);
      return { result: cancelledTerminalResult(), paths };
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
    if (this.disposed) {
      await cleanupRequestArtifacts(paths);
      throw new Error("Terminal bridge has been disposed.");
    }
    if (signal.aborted) {
      await cleanupRequestArtifacts(paths);
      return { result: cancelledTerminalResult(), paths };
    }
    // The per-request key exists only in the live PowerShell session. The
    // reply carries an HMAC over its text/error/final-log hash, never the key.
    const replyNonce = crypto.randomBytes(16).toString("base64url");
    let result: RunResult;
    try {
      const dispatchScript = buildPowerShellDispatchCommand(
        expandRequestFileSpawn(terminalSpawn, {
          hydraPromptFile: paths.promptPath,
          hydraReplyFile: paths.replyPath,
          hydraLogFile: paths.logPath,
        }),
        paths.promptPath,
        paths.replyPath,
        paths.logPath,
        sha256(promptFile)
      );
      this.assertNotDisposed();
      if (signal.aborted) {
        return { result: cancelledTerminalResult(), paths };
      }
      await createPrivateArtifact(paths.dispatchPath, dispatchScript, boundary);
      this.assertNotDisposed();
      if (signal.aborted) {
        return { result: cancelledTerminalResult(), paths };
      }
      terminal.sendText(
        buildPowerShellDispatchInvocation(paths.dispatchPath, replyNonce, sha256(dispatchScript)),
        true
      );
      const chunkHandler = onChunk
        ? (chunk: string) => {
            void this.setSession(agent, {
              state: "streaming",
              detail: `${phase} output streaming`,
            });
            onChunk(chunk);
          }
        : undefined;
      result = await waitForReply(
        paths.replyPath,
        paths.logPath,
        timeoutMs,
        signal,
        this.replyPollMs(),
        chunkHandler,
        replyNonce,
        boundary
      );
    } finally {
      // Prompt and launcher content are ephemeral. Logs and HMAC-authenticated
      // replies remain briefly for diagnostics and are swept by age.
      await Promise.all([
        unlinkIfExists(paths.dispatchPath),
        unlinkIfExists(paths.promptPath),
        unlinkIfExists(paths.lastMessagePath),
      ]);
    }
    if (this.disposed) {
      return { result: cancelledTerminalResult(), paths };
    }
    if (result.timedOut || result.cancelled) {
      // VS Code's Terminal API exposes disposal but no process-group handle or
      // descendant-exit acknowledgement. A CLI can ignore PTY teardown or
      // leave detached children behind, so never claim Stop/timeout proved the
      // native tree exited. The panel turns this into a session-fatal latch.
      result = markTerminalTerminationUnconfirmed(result);
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

  private cancelledCall(agent: AgentId, phase: Phase): { result: RunResult; paths: TerminalProtocolPaths } {
    const requestId = `${Date.now()}-${crypto.randomUUID()}`;
    return {
      result: cancelledTerminalResult(),
      paths: terminalProtocolStoragePaths(this.artifactRoot, requestId, agent, phase),
    };
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("Terminal bridge has been disposed.");
  }

  private postDispatchSettleMs(): number {
    return this.options.postDispatchSettleMs ?? 50;
  }

  private async resolveAgentCommandCached(
    agent: AgentId,
    command: string,
    env: NodeJS.ProcessEnv,
  ): Promise<string> {
    const pathValue = process.platform === "win32" ? env.Path ?? env.PATH ?? "" : env.PATH ?? "";
    const cacheKey = `${agent}\0${command}\0${pathValue}`;
    let resolved = this.resolvedCommandCache.get(cacheKey);
    if (!resolved) {
      resolved = resolveAgentCommand(agent, command, env).catch((err) => {
        this.resolvedCommandCache.delete(cacheKey);
        throw err;
      });
      this.resolvedCommandCache.set(cacheKey, resolved);
    }
    return resolved;
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

  private async ensureTerminal(
    agent: AgentId,
    env?: NodeJS.ProcessEnv,
    enforceEnvironment = false
  ): Promise<vscode.Terminal> {
    this.assertNotDisposed();
    await this.artifactBoundary;
    this.assertNotDisposed();
    const environmentFingerprint = terminalEnvironmentFingerprint(env);
    const existing = this.terminals.get(agent);
    if (existing && (!enforceEnvironment || existing.environmentFingerprint === environmentFingerprint)) {
      existing.terminal.show(true);
      await this.setSession(agent, {
        state: "ready",
        detail: "Native terminal ready",
      });
      return existing.terminal;
    }
    if (existing) {
      // A configuration change must take effect in the terminal process
      // environment. Only dispatch calls enforce the fingerprint;
      // openAll/sendRawLine keep the visible shell intact.
      this.retireTerminal(agent);
    }

    await this.setSession(agent, {
      state: "creating",
      detail: "Opening native terminal",
    });
    this.assertNotDisposed();
    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAMES[agent],
      cwd: this.workspaceRoot,
      env: terminalEnvironmentOverrides(env),
    });
    const managed: ManagedTerminal = { terminal, environmentFingerprint };
    this.terminals.set(agent, managed);
    terminal.show(true);

    const command = this.terminalCommand(agent);
    if (command.trim()) {
      const expanded = expandTerminalCommand(command, this.workspaceRoot);
      const markerPath = path.join(this.artifactRoot, "sessions", `${agent}-startup-${Date.now()}-${crypto.randomUUID()}.ready`);
      terminal.sendText(expanded, true);
      terminal.sendText(buildTerminalStartupProbeCommand(agent, this.workspaceRoot, markerPath), true);
      const ready = await waitForFile(markerPath, this.startupDelayMs(), 50);
      await unlinkIfExists(markerPath);
      this.assertNotDisposed();
      await this.setSession(agent, {
        state: "ready",
        detail: ready ? "Startup command completed; terminal ready" : "Startup command sent; readiness marker not observed",
        currentCommand: expanded,
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
    if (this.disposed) return;
    // Why: sessions is keyed by the now-widened AgentId; fall back to a fresh
    // session for an id not yet seeded (never happens for codex/claude, which
    // the constructor always populates).
    const previous = this.sessions[agent] ?? createTerminalSession(agent);
    const next = updateTerminalSession(previous, patch);
    this.sessions[agent] = next;
    try {
      const boundary = await this.artifactBoundary;
      if (this.disposed) return;
      await writePrivateArtifactSnapshot(
        terminalSessionPath(this.artifactRoot, next.agent),
        `${JSON.stringify(next, null, 2)}\n`,
        boundary
      );
      if (this.disposed) return;
      if (shouldRecordSessionEvent(previous, next)) {
        await appendHydraEvent(this.workspaceRoot, createHydraEvent({
          kind: "terminalSessionChanged",
          agent,
          phase: next.currentPhase,
          detail: next.detail,
          data: {
            state: next.state,
            requestId: next.requestId ?? null,
            hasCommand: !!next.currentCommand,
            hasError: !!next.lastError,
          },
        }));
      }
    } catch {
      // Session files are diagnostics, not a reason to fail the agent call.
      // Doctor covers terminal bridge setup as a separate health check.
    }
    this.options.onSessionUpdate?.(next);
  }

  private terminalCommand(agent: AgentId): string {
    const cfg = vscode.workspace.getConfiguration("hydraRoom");
    return cfg.get<string>(`${agent}TerminalCommand`, "");
  }

  private startupDelayMs(): number {
    return vscode.workspace.getConfiguration("hydraRoom").get<number>("terminalStartupDelayMs", 1000);
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

/** @internal — exported for tests */
export async function waitForReply(
  replyPath: string,
  logPath: string,
  timeoutMs: number,
  signal: AbortSignal,
  pollMs: number,
  onChunk?: (chunk: string) => void,
  replyNonce?: string,
  artifactBoundary?: ArtifactBoundary
): Promise<TerminalWaitResult> {
  const start = Date.now();
  let lastParseError = "";
  let logOffset = 0;
  const streamed: BoundedStreamState = { text: "", truncated: false };
  const logDecoder = new StringDecoder("utf8");
  const maxPollMs = Math.max(1, Math.floor(pollMs));
  let nextPollMs = Math.min(50, maxPollMs);
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;

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

  const consumeAvailableLog = async (): Promise<void> => {
    for (;;) {
      const chunk = await readLogChunk(logPath, logOffset, artifactBoundary);
      if (chunk.bytes.length === 0) return;
      logOffset = chunk.nextOffset;
      const text = stripAnsi(logDecoder.write(chunk.bytes));
      if (!text) continue;
      const accepted = appendBoundedStream(
        streamed,
        text,
        MAX_AGENT_STDOUT_BYTES,
        `[Hydra: terminal stream truncated at ${MAX_AGENT_STDOUT_BYTES} characters]`
      );
      if (accepted && onChunk) {
        try {
          onChunk(accepted);
        } catch {
          // Live rendering is cosmetic; reply polling and authentication continue.
        }
      }
    }
  };

  while (!hasTimeout || Date.now() - start < timeoutMs) {
    if (signal.aborted) {
      return { stdout: "", stderr: "", exitCode: null, timedOut: false, cancelled: true };
    }
    await consumeAvailableLog();
    try {
      const raw = artifactBoundary
        ? (await readPrivateArtifact(replyPath, artifactBoundary)).toString("utf8")
        : (await readBoundedArtifact(replyPath)).toString("utf8");
      const reply = parseTerminalReply(raw);
      if (replyNonce && !isAuthenticatedTerminalReply(reply, replyNonce)) {
        // Authenticated replies use the nonce as an HMAC key and never write
        // that key to disk. `reply.nonce` remains accepted for old fixtures.
        lastParseError = "reply authentication mismatch — possible spoofed terminal artifact";
        await sleepWithAbort(nextPollMs);
        nextPollMs = Math.min(maxPollMs, nextPollMs * 2);
        continue;
      }
      // Drain every chunk currently on disk before final de-duplication. A
      // single fixed-size read would leave >1 MiB logs partially streamed and
      // cause the final reply to be rendered twice.
      await consumeAvailableLog();
      let verifiedLog: string | undefined;
      if (reply.auth) {
        if (!reply.logSha256) {
          lastParseError = "authenticated terminal reply omitted its log hash";
          await sleepWithAbort(nextPollMs);
          nextPollMs = Math.min(maxPollMs, nextPollMs * 2);
          continue;
        }
        const logBytes = artifactBoundary
          ? await readPrivateArtifact(logPath, artifactBoundary)
          : await readBoundedArtifact(logPath);
        if (sha256Buffer(logBytes) !== reply.logSha256.toLowerCase()) {
          lastParseError = "terminal log integrity mismatch";
          await sleepWithAbort(nextPollMs);
          nextPollMs = Math.min(maxPollMs, nextPollMs * 2);
          continue;
        }
        verifiedLog = logBytes.toString("utf8");
      }
      // Live chunks are cosmetic and bounded. The returned stdout derives from
      // HMAC-validated reply.text; structured normalization uses verifiedLog,
      // the immutable log snapshot whose SHA-256 is covered by that HMAC.
      const stdout = onChunk ? unstreamedTail(reply.text, streamed.text) : reply.text;
      if (reply.error) {
        return { stdout, stderr: reply.error, exitCode: 1, timedOut: false, cancelled: false, verifiedLog };
      }
      return { stdout, stderr: "", exitCode: 0, timedOut: false, cancelled: false, verifiedLog };
    } catch (err) {
      if (isProbablyParseError(err)) {
        lastParseError = err instanceof Error ? err.message : String(err);
      }
    }
    await sleepWithAbort(nextPollMs);
    nextPollMs = Math.min(maxPollMs, nextPollMs * 2);
  }

  if (signal.aborted) {
    return { stdout: "", stderr: "", exitCode: null, timedOut: false, cancelled: true };
  }
  const stderr = lastParseError
    ? `Timed out waiting for terminal reply. Last parse error: ${lastParseError}`
    : "Timed out waiting for terminal reply file.";
  return { stdout: "", stderr, exitCode: null, timedOut: true, cancelled: false, timeoutMs };
}

async function readLogChunk(
  logPath: string,
  offset: number,
  artifactBoundary?: ArtifactBoundary
): Promise<{ bytes: Buffer; nextOffset: number }> {
  let handle: fs.FileHandle | undefined;
  try {
    if (artifactBoundary) await assertPrivateArtifactForRead(logPath, artifactBoundary);
    const before = await fs.lstat(logPath);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      return { bytes: Buffer.alloc(0), nextOffset: offset };
    }
    handle = await fs.open(logPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      return { bytes: Buffer.alloc(0), nextOffset: offset };
    }
    const start = opened.size < offset ? 0 : offset;
    const length = Math.min(
      opened.size - start,
      1024 * 1024,
      Math.max(0, MAX_TERMINAL_ARTIFACT_BYTES - start)
    );
    if (length <= 0) return { bytes: Buffer.alloc(0), nextOffset: start };
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return { bytes: buffer.subarray(0, bytesRead), nextOffset: start + bytesRead };
  } catch {
    return { bytes: Buffer.alloc(0), nextOffset: offset };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function cancelledTerminalResult(): RunResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: null,
    timedOut: false,
    cancelled: true,
  };
}

/** @internal — terminal disposal has no descendant-exit acknowledgement. */
export function markTerminalTerminationUnconfirmed(result: RunResult): RunResult {
  if (!result.timedOut && !result.cancelled) return result;
  return {
    ...result,
    terminationFailed: true,
    stderr: [
      result.stderr.trim(),
      "[Hydra disposed the terminal but cannot confirm that its native process tree exited. Restart VS Code before starting more Hydra work.]",
    ].filter(Boolean).join("\n"),
  };
}

/** @internal — exported for tests */
export function unstreamedTail(finalText: string, streamedText: string): string {
  if (!finalText) return "";
  if (!streamedText) return finalText;
  if (finalText.startsWith(streamedText)) return finalText.slice(streamedText.length);
  const trimmedStream = streamedText.trimEnd();
  const trimmedFinal = finalText.trimEnd();
  if (trimmedFinal === trimmedStream) return "";
  return finalText;
}

/** @internal — exported for tests */
export function isProbablyParseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return true;
  const code = (err as { code?: unknown }).code;
  return code !== "ENOENT";
}

/** @internal — exported for focused storage-boundary tests. */
export function defaultTerminalArtifactRoot(workspaceRoot: string): string {
  const identity = process.platform === "win32"
    ? path.resolve(workspaceRoot).toLowerCase()
    : path.resolve(workspaceRoot);
  const key = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return path.join(os.tmpdir(), "vscode-hydra-room", key, "terminal-bridge");
}

/** @internal — exported for focused storage-boundary tests. */
export async function prepareTerminalArtifactRoot(
  workspaceRoot: string,
  artifactRoot: string
): Promise<ArtifactBoundary> {
  if (!path.isAbsolute(artifactRoot)) {
    throw new Error("Terminal bridge artifact root must be absolute.");
  }
  const logicalWorkspace = path.resolve(workspaceRoot);
  const logicalRoot = path.resolve(artifactRoot);
  if (isPathWithin(logicalWorkspace, logicalRoot)) {
    throw new Error("Terminal bridge artifact root must be outside the workspace.");
  }

  await fs.mkdir(logicalRoot, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(logicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Terminal bridge artifact root must be a real directory, not a link.");
  }
  const [realWorkspace, realRoot] = await Promise.all([
    fs.realpath(logicalWorkspace),
    fs.realpath(logicalRoot),
  ]);
  if (isPathWithin(realWorkspace, realRoot)) {
    throw new Error("Terminal bridge artifact root resolves inside the workspace.");
  }

  await fs.chmod(logicalRoot, 0o700).catch(() => undefined);
  for (const name of ["prompts", "replies", "logs", "dispatch", "sessions"]) {
    const dir = path.join(logicalRoot, name);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Terminal bridge artifact directory is linked or invalid: ${dir}`);
    }
    const realDir = await fs.realpath(dir);
    if (!isPathWithin(realRoot, realDir)) {
      throw new Error(`Terminal bridge artifact directory escapes storage root: ${dir}`);
    }
    await fs.chmod(dir, 0o700).catch(() => undefined);
  }
  return { logicalRoot, realRoot };
}

async function createPrivateArtifact(
  filePath: string,
  content: string,
  boundary: ArtifactBoundary
): Promise<void> {
  await assertArtifactParent(filePath, boundary);
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    // Revalidate through the pathname after opening. A co-tenant can swap the
    // parent directory between the pre-open check and fs.open(); the open
    // handle remains valid, but we must not write unless that exact handle is
    // still reachable through a real parent inside the private root.
    await assertArtifactParent(filePath, boundary);
    const realFile = await fs.realpath(filePath);
    if (!isPathWithin(boundary.realRoot, realFile)) {
      throw new Error(`Terminal bridge artifact resolves outside storage root: ${filePath}`);
    }
    const [opened, entry] = await Promise.all([handle.stat(), fs.lstat(filePath)]);
    if (!opened.isFile() || opened.nlink !== 1 || entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
      throw new Error(`Terminal bridge refused a linked or non-regular artifact: ${filePath}`);
    }
    if (opened.dev !== entry.dev || opened.ino !== entry.ino) {
      throw new Error(`Terminal bridge artifact changed while it was created: ${filePath}`);
    }
    await handle.writeFile(content, "utf8");
    await handle.chmod(0o600).catch(() => undefined);
  } finally {
    await handle.close();
  }
}

async function writePrivateArtifactSnapshot(
  filePath: string,
  content: string,
  boundary: ArtifactBoundary
): Promise<void> {
  await assertArtifactParent(filePath, boundary);
  await assertReplaceablePrivateArtifact(filePath);
  const temporaryPath = `${filePath}.${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    await createPrivateArtifact(temporaryPath, content, boundary);
    await assertArtifactParent(filePath, boundary);
    await assertReplaceablePrivateArtifact(filePath);
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  } finally {
    await unlinkIfExists(temporaryPath);
  }
}

async function assertReplaceablePrivateArtifact(filePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Terminal bridge refused to replace a linked or non-regular artifact: ${filePath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

async function readPrivateArtifact(filePath: string, boundary: ArtifactBoundary): Promise<Buffer> {
  await assertPrivateArtifactForRead(filePath, boundary);
  const before = await fs.lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error(`Terminal bridge refused to read a linked or non-regular artifact: ${filePath}`);
  }
  const realFile = await fs.realpath(filePath);
  if (!isPathWithin(boundary.realRoot, realFile)) {
    throw new Error(`Terminal bridge artifact resolves outside storage root: ${filePath}`);
  }
  assertBoundedArtifactSize(before.size, filePath);
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Terminal bridge artifact changed while it was read: ${filePath}`);
    }
    assertBoundedArtifactSize(opened.size, filePath);
    return await readTerminalArtifactAtMost(handle, filePath);
  } finally {
    await handle.close();
  }
}

async function readBoundedArtifact(filePath: string): Promise<Buffer> {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Terminal bridge refused a linked or non-regular artifact: ${filePath}`);
    }
    assertBoundedArtifactSize(stat.size, filePath);
    return await readTerminalArtifactAtMost(handle, filePath);
  } finally {
    await handle.close();
  }
}

function assertBoundedArtifactSize(size: number, filePath: string): void {
  if (size > MAX_TERMINAL_ARTIFACT_BYTES) {
    throw new Error(
      `Terminal bridge artifact exceeded ${MAX_TERMINAL_ARTIFACT_BYTES} bytes and was not loaded: ${filePath}`
    );
  }
}

async function readTerminalArtifactAtMost(handle: fs.FileHandle, filePath: string): Promise<Buffer> {
  const buffer = Buffer.alloc(MAX_TERMINAL_ARTIFACT_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  assertBoundedArtifactSize(offset, filePath);
  return buffer.subarray(0, offset);
}

async function assertPrivateArtifactForRead(filePath: string, boundary: ArtifactBoundary): Promise<void> {
  await assertArtifactParent(filePath, boundary);
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Terminal bridge refused to read a linked or non-regular artifact: ${filePath}`);
  }
  const realFile = await fs.realpath(filePath);
  if (!isPathWithin(boundary.realRoot, realFile)) {
    throw new Error(`Terminal bridge artifact resolves outside storage root: ${filePath}`);
  }
}

async function assertArtifactParent(filePath: string, boundary: ArtifactBoundary): Promise<void> {
  const absolute = path.resolve(filePath);
  if (!isPathWithin(boundary.logicalRoot, absolute) || absolute === boundary.logicalRoot) {
    throw new Error(`Terminal bridge artifact path escapes storage root: ${filePath}`);
  }
  const parent = path.dirname(absolute);
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`Terminal bridge artifact parent is linked or invalid: ${parent}`);
  }
  const realParent = await fs.realpath(parent);
  if (!isPathWithin(boundary.realRoot, realParent)) {
    throw new Error(`Terminal bridge artifact parent escapes storage root: ${parent}`);
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function terminalEnvironmentOverrides(env?: NodeJS.ProcessEnv): Record<string, string | null | undefined> | undefined {
  if (!env) return undefined;
  const entries = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** @internal — exported to prove secrets are hashed, not serialized. */
export function terminalEnvironmentFingerprint(env?: NodeJS.ProcessEnv): string {
  const normalized = Object.entries(env ?? {})
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Buffer(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** @internal — exported for terminal reply authentication tests. */
export function terminalReplyAuth(reply: Pick<TerminalReply, "text" | "error" | "logSha256">, key: string): string {
  const material = `${reply.text}\0${reply.error ?? ""}\0${reply.logSha256 ?? ""}`;
  return crypto.createHmac("sha256", Buffer.from(key, "utf8")).update(material, "utf8").digest("hex");
}

function isAuthenticatedTerminalReply(reply: TerminalReply, key: string): boolean {
  if (!reply.auth) return reply.nonce === key;
  if (!/^[a-f0-9]{64}$/i.test(reply.auth)) return false;
  const actual = Buffer.from(reply.auth, "hex");
  const expected = Buffer.from(terminalReplyAuth(reply, key), "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function cleanupRequestArtifacts(paths: TerminalProtocolPaths): Promise<void> {
  await Promise.all([
    unlinkIfExists(paths.promptPath),
    unlinkIfExists(paths.replyPath),
    unlinkIfExists(paths.logPath),
    unlinkIfExists(paths.dispatchPath),
    unlinkIfExists(paths.lastMessagePath),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function waitForFile(filePath: string, timeoutMs: number, pollMs: number): Promise<boolean> {
  const start = Date.now();
  const maxMs = Math.max(0, timeoutMs);
  while (Date.now() - start < maxMs) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      // The startup marker is created by the terminal after its startup command finishes.
    }
    await delay(pollMs);
  }
  try {
    await fs.access(filePath);
    return true;
  } catch {
    // Timed out before the startup marker appeared; callers fall back to the existing best-effort behavior.
    return false;
  }
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // The marker may not exist if startup probing timed out.
  }
}

// Prompt and reply content can be sensitive, even in extension-owned storage.
// Live dispatches unlink prompts and launchers immediately; this retention
// sweep covers crashes plus the diagnostic replies/logs kept on the happy path.
// Per-request UUIDs prevent a stale reply from being accepted as a new one.
/** @internal — exported for tests */
export async function sweepStaleDispatchArtifacts(artifactRoot: string): Promise<void> {
  const STALE_MS = 60 * 60 * 1000;
  const dirs = [
    path.join(artifactRoot, "dispatch"),
    path.join(artifactRoot, "prompts"),
    path.join(artifactRoot, "replies"),
    path.join(artifactRoot, "logs"),
    path.join(artifactRoot, "sessions"),
  ];
  let realRoot: string;
  try {
    const rootStat = await fs.lstat(artifactRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;
    realRoot = await fs.realpath(artifactRoot);
  } catch {
    // Storage may not exist until the bridge is first used.
    return;
  }
  const now = Date.now();
  for (const dir of dirs) {
    let entries: import("node:fs").Dirent[];
    try {
      const dirStat = await fs.lstat(dir);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) continue;
      const realDir = await fs.realpath(dir);
      if (!isPathWithin(realRoot, realDir)) continue;
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Dir may not exist yet on first run, or the workspace may be read-only.
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = path.join(dir, entry.name);
      try {
        const st = await fs.lstat(full);
        if (!st.isSymbolicLink() && st.isFile() && st.nlink === 1 && now - st.mtimeMs > STALE_MS) {
          await fs.unlink(full);
        }
      } catch {
        // Best-effort: another process may have unlinked the file, or perms
        // may block us. Either way, not worth surfacing.
      }
    }
  }
}

function startsWithUtf8Bom(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

function normalizeOutput(value: string): string {
  return stripAnsi(value).replace(/\r\n/g, "\n").trim();
}
