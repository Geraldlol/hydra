import * as cp from "node:child_process";

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
function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  // cmd.exe special chars: & | < > ^ " plus whitespace
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function isWindowsBatchCommand(command: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

function spawnAgentChild(spawn: AgentSpawn): cp.ChildProcess {
  if (isWindowsBatchCommand(spawn.command)) {
    // Wrap through cmd.exe so Node's CVE-2024-27980 guard doesn't reject
    // the .cmd shim. Manual quoting keeps args verbatim across the cmd
    // boundary instead of relying on shell:true's auto-rewrite.
    //
    // The outer double-quote wrap is required because `cmd /s /c` strips
    // the FIRST and LAST quote on its command line (rule 2 of cmd's quote
    // handling — kicks in whenever /s is set). Without the outer pair, our
    // closing quote on the last quoted arg gets eaten and any path with
    // spaces gets split, producing errors like:
    //     error: unexpected argument 'Dev"' found
    // when the cwd is e.g. `C:\Users\…\Peerstar Salesforce Dev`.
    //
    // windowsVerbatimArguments tells Node not to re-quote our pre-quoted
    // string when it passes it to CreateProcess.
    const line = [spawn.command, ...spawn.args].map(quoteForCmd).join(" ");
    const wrapped = `"${line}"`;
    return cp.spawn("cmd.exe", ["/d", "/s", "/c", wrapped], {
      cwd: spawn.cwd,
      windowsHide: true,
      windowsVerbatimArguments: true,
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

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);

    const abortHandler = () => {
      if (!settled) {
        cancelled = true;
        terminateProcessTree(child);
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
      stdout += text;
      try {
        onChunk(text);
      } catch {
        // Caller's callback failed (e.g. webview disposed mid-stream).
        // Keep draining stdout into the accumulated result so the final
        // RunResult is still useful; just stop notifying the dead consumer.
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += stripAnsi(chunk.toString("utf8"));
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abortHandler);
      resolve({ stdout, stderr, exitCode, timedOut, cancelled, timeoutMs });
    };

    child.on("error", (err) => {
      stderr += `${stderr ? "\n" : ""}${formatSpawnError(spawn, err)}`;
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
