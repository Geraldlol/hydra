import * as cp from "node:child_process";
import { windowsSystemExecutable } from "./executablePath";

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
): string {
  if (state.truncated) return "";
  const previousLength = state.text.length;
  if (state.text.length + chunk.length > maxBytes) {
    const remaining = maxBytes - state.text.length;
    if (remaining > 0) state.text += chunk.slice(0, remaining);
    state.text += `\n${marker}\n`;
    state.truncated = true;
    return state.text.slice(previousLength);
  }
  state.text += chunk;
  return state.text.slice(previousLength);
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  timeoutMs?: number;
  // Set only when Hydra exhausted graceful and forced termination attempts
  // without observing the child process close. Another turn must not start in
  // this extension host because the native CLI may still be running.
  terminationFailed?: boolean;
}

export interface AgentSpawn {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  // Why: when set, runAgent writes THIS to the child's stdin instead of the
  // prompt argument. cli-template heads bake ${prompt} into argv and pass ""
  // here so the prompt is not ALSO piped; vendor heads pass the prompt itself.
  stdin?: string;
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
  return cp.spawn(windowsSystemExecutable("cmd.exe"), ["/d", "/s", "/c", wrapped], {
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
    let forceBackstop: ReturnType<typeof setTimeout> | undefined;
    let failureBackstop: ReturnType<typeof setTimeout> | undefined;
    let terminationStarted = false;
    let terminationFailed = false;

    // After we ask a child to terminate (timeout or abort), guarantee the
    // returned Promise still resolves even if the child never emits a
    // "close" event — a wedged grandchild can hold the pipe open, or the
    // process group signal can no-op (ESRCH) and leave us hanging forever.
    // Give the initial request one second, force once, then return an explicit
    // lifecycle failure after a second unconfirmed interval.
    const beginTermination = () => {
      if (terminationStarted || settled) return;
      terminationStarted = true;
      void terminateProcessTree(child, false).then((requested) => {
        if (!requested && !settled) {
          appendTerminationDiagnostic("[Hydra could not confirm the initial process-tree termination request.]");
        }
      });
      forceBackstop = setTimeout(() => {
        void terminateProcessTree(child, true).then((requested) => {
          if (!requested && !settled) {
            appendTerminationDiagnostic("[Hydra could not confirm the forced process-tree termination request.]");
          }
        });
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
        // If `close` still never arrives, do not claim the process is gone.
        failureBackstop = setTimeout(() => {
          terminationFailed = true;
          appendTerminationDiagnostic(
            "[Hydra did not observe the native agent process close; it may still be running. Restart VS Code before starting more Hydra work.]"
          );
          finish(null);
        }, 1_000);
      }, 1_000);
    };

    const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
    const timer = hasTimeout
      ? setTimeout(() => {
          timedOut = true;
          beginTermination();
        }, timeoutMs)
      : undefined;

    const abortHandler = () => {
      if (!settled) {
        cancelled = true;
        beginTermination();
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
      const accepted = appendBoundedStream(
        stdoutState,
        text,
        MAX_AGENT_STDOUT_BYTES,
        `[Hydra: agent stdout truncated at ${MAX_AGENT_STDOUT_BYTES} bytes — likely prompt injection from CLAUDE.md/AGENTS.md or runaway tool output]`
      );
      try {
        // Keep live/UI output under the same cumulative cap as RunResult.
        // Forwarding the original chunk here would let a runaway process keep
        // growing the webview message after accumulation had stopped.
        if (accepted) onChunk(accepted);
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
      if (forceBackstop) clearTimeout(forceBackstop);
      if (failureBackstop) clearTimeout(failureBackstop);
      signal.removeEventListener("abort", abortHandler);
      resolve({
        stdout: stdoutState.text,
        stderr: stderrState.text,
        exitCode,
        timedOut,
        cancelled,
        timeoutMs,
        ...(terminationFailed ? { terminationFailed: true } : {}),
      });
    };

    const appendTerminationDiagnostic = (message: string) => {
      const prefix = stderrState.text && !stderrState.text.endsWith("\n") ? "\n" : "";
      appendBoundedStream(
        stderrState,
        `${prefix}${message}\n`,
        MAX_AGENT_STDERR_BYTES,
        `[Hydra: agent stderr truncated at ${MAX_AGENT_STDERR_BYTES} bytes]`
      );
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
        child.stdin.write(spawn.stdin ?? prompt);
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

/** @internal — shared by bounded native probes that must confirm teardown. */
export async function terminateProcessTree(child: cp.ChildProcess, force: boolean): Promise<boolean> {
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  if (!child.pid) {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
  if (process.platform === "win32") {
    return new Promise<boolean>((resolve) => {
      let killer: cp.ChildProcess;
      try {
        killer = cp.spawn(
          windowsSystemExecutable("taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true }
        );
      } catch {
        try {
          resolve(child.kill(signal));
        } catch {
          resolve(false);
        }
        return;
      }
      let done = false;
      const finish = (requested: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(killerTimeout);
        resolve(requested);
      };
      const fallback = () => {
        try {
          return child.kill(signal);
        } catch {
          return false;
        }
      };
      // Bound taskkill itself so a wedged helper cannot hang cancellation.
      const killerTimeout = setTimeout(() => {
        try {
          killer.kill();
        } catch {
          // The helper may have exited between the timeout and this kill.
        }
        finish(fallback());
      }, 750);
      killer.on("error", () => finish(fallback()));
      killer.on("close", (code) => finish(code === 0 ? true : fallback()));
    });
  }
  // POSIX: kill the process group (negative pid). Requires the child to
  // have been spawned with detached:true so it became a group leader.
  // Falls back to direct child.kill() if killing the group fails (e.g.
  // ESRCH because the child already exited).
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}
