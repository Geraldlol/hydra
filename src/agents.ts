import * as cp from "node:child_process";

// Cap accumulated agent stdout per call. A poisoned CLAUDE.md / AGENTS.md
// can prompt-inject the CLI into emitting hundreds of MB of stream-json
// events in one turn; without a cap, the extension host OOMs. The cap is
// intentionally generous (~16M UTF-16 chars ≈ 4M tokens of text) — well
// above any legitimate turn but well below V8's string limit (~512M chars)
// where further appends would throw ERR_STRING_TOO_LONG.
// Why "chars" not "bytes": appendBoundedStream accounts in JS string length
// (state.text.length / chunk.length), i.e. UTF-16 code units, not encoded
// byte length. The constant keeps the legacy *_BYTES name (an exported test
// imports it) but the unit is chars; for ASCII the two coincide.
export const MAX_AGENT_STDOUT_BYTES = 16 * 1024 * 1024;
// Stderr is bounded much tighter: it's a diagnostic surface, not a data
// channel, so legitimate output is rarely more than a few KB. Same UTF-16
// char accounting as the stdout cap above.
export const MAX_AGENT_STDERR_BYTES = 1 * 1024 * 1024;

export interface BoundedStreamState {
  text: string;
  truncated: boolean;
}

// Append `chunk` to `state.text` without exceeding `maxBytes`. Once the
// cap is hit, a single truncation marker line is appended and subsequent
// chunks are dropped. The marker is sandwiched in newlines so the stream-
// json parsers downstream skip it as a non-JSON line.
export function appendBoundedStream(
  state: BoundedStreamState,
  chunk: string,
  maxBytes: number,
  marker: string
): void {
  if (state.truncated) return;
  if (state.text.length + chunk.length > maxBytes) {
    const remaining = maxBytes - state.text.length;
    if (remaining > 0) state.text += chunk.slice(0, remaining);
    state.text += `\n${marker}\n`;
    state.truncated = true;
    return;
  }
  state.text += chunk;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  timeoutMs?: number;
}

export interface AgentSpawn {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
}

// Strip ANSI escape sequences. Covers:
//   - OSC / DCS / APC / SOS / PM strings: ESC ] | P | X | ^ | _  ... <ST>
//     where ST is BEL (\x07) or ESC \ (\x1B\x5C). Listed FIRST because the
//     C1 single-char rule below would otherwise greedily eat just the
//     "ESC P" / "ESC ]" intro and leave the body in place.
//   - CSI parameter sequences:  ESC [ <params> <intermediates> <final byte>
//   - C1 single-char escapes:   ESC @-Z, ESC \, ESC _
//
// Modern Claude Code and Codex emit OSC sequences in terminal-bridge mode
// (OSC 9 for working-directory notifications, OSC 133 for shell-integration
// marks). Without the OSC branch they leak into transcripts as garbage.
const ANSI_RE = /\x1B(?:[\]PX^_][^\x07\x1B]*(?:\x07|\x1B\\)|\[[0-?]*[ -\/]*[@-~]|[@-Z\\-_])/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

/**
 * Quote a single argument for cmd.exe /d /s /c. Required because Node's
 * CVE-2024-27980 mitigation (Node 18.20.0+, 20.12.0+, 21.7.0+) refuses to
 * spawn .cmd/.bat shims directly with `shell: false`, and `shell: true`
 * passes args through cmd.exe's argument parser — which would mangle
 * special characters unless we quote them ourselves.
 */
export function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  // cmd.exe special chars: & | < > ^ " plus whitespace
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export function isWindowsBatchCommand(command: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

/**
 * Spawn a Windows `.cmd`/`.bat` shim through cmd.exe with proper quoting.
 *
 * Use this when isWindowsBatchCommand(command) is true. Direct cp.spawn on
 * a batch file is blocked by Node's CVE-2024-27980 mitigation, and
 * shell:true delegates quoting to cmd.exe's own parser which mangles
 * special characters.
 *
 * The outer double-quote wrap (`"${line}"`) is required because cmd /s /c
 * strips the FIRST and LAST quote on its command line (cmd quote-handling
 * rule 2, kicks in whenever /s is set). Without the outer pair, the
 * closing quote on the last quoted arg gets eaten and any path with
 * spaces gets split — e.g. cwd `C:\Users\…\Peerstar Salesforce Dev`
 * surfaces as `error: unexpected argument 'Dev"' found`.
 *
 * windowsVerbatimArguments tells Node not to re-quote our pre-quoted
 * string when it passes it to CreateProcess.
 */
export function spawnViaCmdShim(
  command: string,
  args: string[],
  options: Omit<cp.SpawnOptions, "windowsVerbatimArguments" | "shell">
): cp.ChildProcess {
  const line = [command, ...args].map(quoteForCmd).join(" ");
  const wrapped = `"${line}"`;
  return cp.spawn("cmd.exe", ["/d", "/s", "/c", wrapped], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

function spawnAgentChild(spawn: AgentSpawn): cp.ChildProcess {
  if (isWindowsBatchCommand(spawn.command)) {
    return spawnViaCmdShim(spawn.command, spawn.args, {
      cwd: spawn.cwd,
      windowsHide: true,
      env: { ...process.env, ...(spawn.env ?? {}) },
    });
  }
  return cp.spawn(spawn.command, spawn.args, {
    cwd: spawn.cwd,
    windowsHide: true,
    env: { ...process.env, ...(spawn.env ?? {}) },
    // POSIX: become a process-group leader so terminateProcessTree
    // can signal the whole group (kills grandchildren too). Windows
    // uses taskkill /T which has its own tree-walk semantics.
    detached: process.platform !== "win32",
  });
}

export async function runAgent(
  spawn: AgentSpawn,
  prompt: string,
  timeoutMs: number,
  onChunk: (chunk: string) => void,
  signal: AbortSignal
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let child: cp.ChildProcess;
    try {
      child = spawnAgentChild(spawn);
    } catch (err) {
      resolve({
        stdout: "",
        stderr: formatSpawnError(spawn, err),
        exitCode: null,
        timedOut: false,
        cancelled: false,
        timeoutMs,
      });
      return;
    }

    const stdoutState: BoundedStreamState = { text: "", truncated: false };
    const stderrState: BoundedStreamState = { text: "", truncated: false };
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let backstop: ReturnType<typeof setTimeout> | undefined;

    // After we ask a child to terminate (timeout or abort), guarantee the
    // returned Promise still resolves even if the child never emits a
    // "close" event — a wedged grandchild can hold the pipe open, or the
    // process group signal can no-op (ESRCH) and leave us hanging forever.
    // Why 2000ms: gives SIGTERM/taskkill time to land before we escalate
    // and force-settle, while keeping the worst-case hang bounded.
    const armBackstop = () => {
      if (backstop) return;
      backstop = setTimeout(() => {
        if (process.platform !== "win32" && child.pid) {
          try {
            // Last-resort escalation: SIGKILL the whole process group.
            // Windows already used taskkill /F /T (forceful), so no
            // equivalent step is needed there.
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // ESRCH: the group is already gone — nothing left to kill.
          }
        }
        // Unconditionally settle with a null exit code; timedOut/cancelled
        // were set before terminateProcessTree fired, so the caller still
        // classifies the outcome correctly.
        finish(null);
      }, 2000);
    };

    const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
    const timer = hasTimeout
      ? setTimeout(() => {
          timedOut = true;
          terminateProcessTree(child);
          armBackstop();
        }, timeoutMs)
      : undefined;

    const abortHandler = () => {
      if (!settled) {
        cancelled = true;
        terminateProcessTree(child);
        armBackstop();
      }
    };

    if (signal.aborted) {
      // Defer so the spawn handle is fully ready before child.kill() runs.
      // child.kill() on a not-yet-started process can silently no-op on Windows.
      queueMicrotask(abortHandler);
    } else {
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString("utf8"));
      appendBoundedStream(
        stdoutState,
        text,
        MAX_AGENT_STDOUT_BYTES,
        `[Hydra: agent stdout truncated at ${MAX_AGENT_STDOUT_BYTES} bytes — likely prompt injection from CLAUDE.md/AGENTS.md or runaway tool output]`
      );
      try {
        // Forward the raw text to the caller's callback even after we
        // stop accumulating: the live consumer may already be writing to
        // disk or another bounded sink, and dropping its feed mid-turn
        // would orphan partial state.
        onChunk(text);
      } catch {
        // Caller's callback failed (e.g. webview disposed mid-stream).
        // Keep draining stdout into the accumulated result so the final
        // RunResult is still useful; just stop notifying the dead consumer.
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      appendBoundedStream(
        stderrState,
        stripAnsi(chunk.toString("utf8")),
        MAX_AGENT_STDERR_BYTES,
        `[Hydra: agent stderr truncated at ${MAX_AGENT_STDERR_BYTES} bytes]`
      );
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (backstop) clearTimeout(backstop);
      signal.removeEventListener("abort", abortHandler);
      resolve({
        stdout: stdoutState.text,
        stderr: stderrState.text,
        exitCode,
        timedOut,
        cancelled,
        timeoutMs,
      });
    };

    child.on("error", (err) => {
      const prefix = stderrState.text ? "\n" : "";
      appendBoundedStream(
        stderrState,
        `${prefix}${formatSpawnError(spawn, err)}`,
        MAX_AGENT_STDERR_BYTES,
        `[Hydra: agent stderr truncated at ${MAX_AGENT_STDERR_BYTES} bytes]`
      );
      finish(null);
    });
    child.on("close", (exitCode) => {
      finish(exitCode);
    });

    if (child.stdin && !child.stdin.destroyed) {
      // Suppress EPIPE: a child that closes stdin before we finish writing
      // (e.g. fast-exit fixture, or the child rejected the prompt) emits
      // an unhandled 'error' event on the writable stream. Without this
      // listener Node crashes the extension host. The error itself is
      // surfaced via stderr / exitCode through the existing finish path.
      child.stdin.on("error", () => {});
      try {
        child.stdin.write(prompt);
        child.stdin.end();
      } catch {
        // Synchronous write to a half-closed pipe; same EPIPE class. Stderr
        // and close events still drive resolution.
      }
    }
  });
}

function formatSpawnError(spawn: AgentSpawn, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = typeof err === "object" && err && "code" in err ? String((err as { code?: unknown }).code) : "";
  const lines = [
    `Failed to start native CLI command: ${spawn.command}`,
    `Working directory: ${spawn.cwd}`,
    message,
  ];
  if (code === "ENOENT") {
    lines.push(
      "Hydra could not find this executable from the VS Code extension host environment.",
      "Install the CLI on VS Code's PATH or set hydraRoom.codexCommand / hydraRoom.claudeCommand to a full executable path."
    );
  }
  return lines.join("\n");
}

function terminateProcessTree(child: cp.ChildProcess): void {
  if (!child.pid) {
    child.kill();
    return;
  }
  if (process.platform === "win32") {
    try {
      child.kill();
    } catch {
      // taskkill below is the stronger Windows fallback.
    }
    const killer = cp.spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    killer.on("error", () => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    });
    return;
  }
  // POSIX: kill the process group (negative pid). Requires the child to
  // have been spawned with detached:true so it became a group leader.
  // Falls back to direct child.kill() if killing the group fails (e.g.
  // ESRCH because the child already exited).
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
}
