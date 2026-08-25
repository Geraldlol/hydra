import * as cp from "node:child_process";
import * as path from "node:path";
import { windowsSystemExecutable } from "./executablePath";
import {
  TERMINATION_CONFIRM_WINDOW_MS,
  TERMINATION_FORCE_GRACE_MS,
  WINDOWS_PROCESS_TREE_TERMINATION_HELPER_TIMEOUT_MS,
} from "./processTreeBudgets";

export {
  TERMINATION_CONFIRM_WINDOW_MS,
  TERMINATION_FORCE_GRACE_MS,
} from "./processTreeBudgets";

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
  // A provider-bound write may have crossed the transport boundary, but Hydra
  // cannot prove whether the provider accepted or completed it. Never retry.
  deliveryUnknown?: boolean;
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
  return spawnIdentityBoundProcess(
    windowsSystemExecutable("cmd.exe"),
    ["/d", "/s", "/c", wrapped],
    {
    ...options,
    windowsVerbatimArguments: true,
    },
  );
}

function spawnAgentChild(spawn: AgentSpawn): cp.ChildProcess {
  if (isWindowsBatchCommand(spawn.command)) {
    return spawnViaCmdShim(spawn.command, spawn.args, {
      cwd: spawn.cwd,
      windowsHide: true,
      env: { ...process.env, ...(spawn.env ?? {}) },
    });
  }
  return spawnIdentityBoundProcess(spawn.command, spawn.args, {
    cwd: spawn.cwd,
    windowsHide: true,
    env: { ...process.env, ...(spawn.env ?? {}) },
    // POSIX: become a process-group leader so terminateProcessTree
    // can signal the whole group (kills grandchildren too). Windows
    // uses an identity-bound native snapshot and handle termination.
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
            // Windows already used forceful identity-bound termination, so no
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
        }, TERMINATION_CONFIRM_WINDOW_MS);
      }, TERMINATION_FORCE_GRACE_MS);
    };

    const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
    const timer = hasTimeout
      ? setTimeout(() => {
          if (!settled && !terminationStarted) {
            timedOut = true;
            beginTermination();
          }
        }, timeoutMs)
      : undefined;

    const abortHandler = () => {
      if (!settled && !terminationStarted) {
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
const WINDOWS_PROCESS_CREATION_IDENTITIES = new WeakMap<
  cp.ChildProcess,
  Promise<string | undefined>
>();
const WINDOWS_LAZY_IDENTITY_PROBES = new WeakMap<
  cp.ChildProcess,
  typeof cp.spawn
>();
const WINDOWS_PROCESS_HOST_READY = new WeakSet<cp.ChildProcess>();

const WINDOWS_PROCESS_HOST_SPEC_ENV =
  "HYDRA_WINDOWS_PROCESS_TREE_HOST_V1";

function stdioMode(
  stdio: cp.StdioOptions | undefined,
  index: 0 | 1 | 2,
): "pipe" | "ignore" | "inherit" {
  const entry = Array.isArray(stdio)
    ? stdio[index]
    : stdio ?? "pipe";
  if (entry === "pipe" || entry === "ignore" || entry === "inherit") {
    return entry;
  }
  throw new Error(
    "Hydra's Windows process host supports only pipe, ignore, or inherit stdio.",
  );
}

/**
 * Spawn through a bundled Windows host that authenticates its own creation
 * generation before starting the requested command. POSIX callers retain the
 * ordinary detached-process-group path.
 */
export function spawnIdentityBoundProcess(
  command: string,
  args: readonly string[],
  options: cp.SpawnOptions = {},
): cp.ChildProcess {
  if (process.platform !== "win32") {
    return cp.spawn(command, [...args], options);
  }
  const targetEnvironment = options.env ?? process.env;
  if (Object.prototype.hasOwnProperty.call(
    targetEnvironment,
    WINDOWS_PROCESS_HOST_SPEC_ENV,
  )) {
    throw new Error(
      `Refusing reserved process environment variable ${WINDOWS_PROCESS_HOST_SPEC_ENV}.`,
    );
  }
  const stdinMode = stdioMode(options.stdio, 0);
  const stdoutMode = stdioMode(options.stdio, 1);
  const stderrMode = stdioMode(options.stdio, 2);
  const electronRunAsNodePresent = Object.prototype.hasOwnProperty.call(
    targetEnvironment,
    "ELECTRON_RUN_AS_NODE",
  );
  const spec = Buffer.from(JSON.stringify({
    args: [...args],
    command,
    cwd: typeof options.cwd === "string" ? options.cwd : process.cwd(),
    electronRunAsNode: {
      present: electronRunAsNodePresent,
      value: electronRunAsNodePresent
        ? targetEnvironment.ELECTRON_RUN_AS_NODE ?? ""
        : null,
    },
    shell: typeof options.shell === "string"
      ? options.shell
      : options.shell === true,
    stdinMode,
    windowsVerbatimArguments: options.windowsVerbatimArguments === true,
  }), "utf8").toString("base64");
  if (Buffer.byteLength(spec, "ascii") > 256 * 1024) {
    throw new Error("Hydra Windows process launch specification is oversized.");
  }
  const hostEnvironment: NodeJS.ProcessEnv = {
    ...targetEnvironment,
    ELECTRON_RUN_AS_NODE: "1",
    [WINDOWS_PROCESS_HOST_SPEC_ENV]: spec,
  };
  const hostPath = path.join(__dirname, "windowsProcessTreeHost.js");
  const child = cp.spawn(process.execPath, [hostPath], {
    cwd: typeof options.cwd === "string" ? options.cwd : undefined,
    env: hostEnvironment,
    shell: false,
    windowsHide: true,
    stdio: [stdinMode, stdoutMode, stderrMode, "pipe"],
  });
  WINDOWS_PROCESS_CREATION_IDENTITIES.set(
    child,
    receiveWindowsHostCreationIdentity(child),
  );
  child.once("close", (code) => {
    if (code !== 125 || WINDOWS_PROCESS_HOST_READY.has(child)) return;
    const error = Object.assign(
      new Error(`spawn ${command} failed inside Hydra's Windows process host`),
      { code: "ENOENT" },
    );
    child.emit("error", error);
  });
  return child;
}

function receiveWindowsHostCreationIdentity(
  child: cp.ChildProcess,
): Promise<string | undefined> {
  const receipt = child.stdio[3];
  if (!receipt || typeof (receipt as NodeJS.ReadableStream).on !== "function") {
    return Promise.resolve(undefined);
  }
  return new Promise<string | undefined>((resolve) => {
    let output = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const lines = output.trim().split(/\r?\n/u);
      const value = lines[0] ?? "";
      if (lines.length !== 2
        || lines[1] !== "READY"
        || !/^[1-9][0-9]{0,18}$/u.test(value)) {
        resolve(undefined);
        return;
      }
      try {
        if (BigInt(value) <= 9_223_372_036_854_775_807n) {
          WINDOWS_PROCESS_HOST_READY.add(child);
          resolve(value);
        } else {
          resolve(undefined);
        }
      } catch {
        resolve(undefined);
      }
    };
    receipt.on("data", (chunk: Buffer | string) => {
      if (output.length < 64) {
        output += (Buffer.isBuffer(chunk) ? chunk.toString("ascii") : chunk)
          .slice(0, 64 - output.length);
      }
    });
    receipt.once("error", finish);
    receipt.once("end", finish);
    child.once("error", finish);
    child.once("close", finish);
  });
}

/**
 * Register a direct Windows child for identity capture only if termination is
 * later requested. The capture is bracketed by liveness checks against Node's
 * retained process handle, so ordinary exit/reuse during the PID probe fails
 * closed. This avoids paying a PowerShell startup for the common successful
 * path of trusted short-lived probes while preserving generation-bound
 * teardown on timeout, cancellation, or output overflow. Untrusted native
 * providers still use spawnIdentityBoundProcess() and its pre-spawn receipt.
 */
export function bindProcessTreeIdentity(
  child: cp.ChildProcess,
  spawnProcess: typeof cp.spawn = cp.spawn,
): void {
  if (process.platform !== "win32"
    || !child.pid
    || WINDOWS_PROCESS_CREATION_IDENTITIES.has(child)) return;
  WINDOWS_LAZY_IDENTITY_PROBES.set(child, spawnProcess);
}

async function captureLiveWindowsChildIdentity(
  child: cp.ChildProcess,
  spawnProcess: typeof cp.spawn,
): Promise<string | undefined> {
  if (!child.pid
    || child.exitCode !== null
    || child.signalCode !== null
    || !windowsChildHandleIsLive(child)) {
    return undefined;
  }
  const identity = await captureWindowsProcessCreationIdentity(
    child.pid,
    spawnProcess,
  );
  if (!identity
    || child.exitCode !== null
    || child.signalCode !== null) {
    return undefined;
  }
  try {
    // libuv checks the retained process handle here. An ordinary exit during
    // the PID-based probe therefore fails even if Windows has already reused
    // the numeric PID for an unrelated process.
    return windowsChildHandleIsLive(child) ? identity : undefined;
  } catch {
    return undefined;
  }
}

function windowsChildHandleIsLive(child: cp.ChildProcess): boolean {
  try {
    return child.kill(0);
  } catch {
    return false;
  }
}

export async function captureWindowsProcessCreationIdentity(
  pid: number,
  spawnProcess: typeof cp.spawn = cp.spawn,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) {
    return undefined;
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "try {",
    `  $process=[System.Diagnostics.Process]::GetProcessById(${pid})`,
    "  $identity=$process.StartTime.ToFileTimeUtc()",
    "  if($identity -le 0){exit 1}",
    "  [Console]::Out.Write($identity.ToString())",
    "  exit 0",
    "} catch { exit 1 }",
  ].join("\n");
  return new Promise<string | undefined>((resolve) => {
    let probe: cp.ChildProcess;
    try {
      probe = spawnProcess(
        windowsSystemExecutable("powershell.exe"),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      resolve(undefined);
      return;
    }
    let output = "";
    let done = false;
    const finish = (value: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(value);
    };
    probe.stdout?.on("data", (chunk: Buffer | string) => {
      if (output.length >= 64) return;
      output += (Buffer.isBuffer(chunk) ? chunk.toString("ascii") : chunk)
        .slice(0, 64 - output.length);
    });
    const timeout = setTimeout(() => {
      try {
        probe.kill();
      } catch {
        // The identity probe may have exited between timeout and termination.
      }
      probe.stdout?.destroy();
      probe.unref();
      finish(undefined);
    }, 2_000);
    probe.once("error", () => finish(undefined));
    probe.once("close", (code) => {
      const value = output.trim();
      if (code !== 0 || !/^[1-9][0-9]{0,18}$/u.test(value)) {
        finish(undefined);
        return;
      }
      try {
        if (BigInt(value) > 9_223_372_036_854_775_807n) {
          finish(undefined);
          return;
        }
      } catch {
        finish(undefined);
        return;
      }
      finish(value);
    });
  });
}

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
    let identityWork = WINDOWS_PROCESS_CREATION_IDENTITIES.get(child);
    if (!identityWork) {
      const probeSpawner = WINDOWS_LAZY_IDENTITY_PROBES.get(child);
      if (probeSpawner) {
        identityWork = captureLiveWindowsChildIdentity(child, probeSpawner);
        WINDOWS_PROCESS_CREATION_IDENTITIES.set(child, identityWork);
        WINDOWS_LAZY_IDENTITY_PROBES.delete(child);
      }
    }
    const expectedCreationIdentity = await identityWork;
    if (!expectedCreationIdentity) {
      // The retained ChildProcess handle can safely address the direct child,
      // but no PID-only tree walk is allowed without a spawn-generation bind.
      try {
        child.kill(signal);
      } catch {
        // Direct-handle termination is best effort; tree proof remains false.
      }
      return false;
    }
    return terminateWindowsProcessTreeSnapshot(
      child.pid,
      expectedCreationIdentity,
      cp.spawn,
      WINDOWS_PROCESS_HOST_READY.has(child),
    );
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

/**
 * Confirm that one POSIX process group has no remaining members. Sending a
 * signal is not proof: the group leader can close while a descendant ignores
 * SIGTERM. EPERM and other probe failures stay ambiguous and therefore false.
 */
export async function waitForPosixProcessGroupQuiescence(
  processGroupId: number,
  timeoutMs: number,
  pollMs = 25,
): Promise<boolean> {
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 1) return false;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return true;
      // Darwin can report EPERM while a process group contains only zombies:
      // no member is signalable, but the group has not been reaped yet. Keep
      // that ambiguity bounded by the existing deadline; never accept it as
      // proof of quiescence.
      if (code !== "EPERM") return false;
    }
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(
      resolve,
      Math.max(1, Math.min(pollMs, deadline - Date.now())),
    ));
  }
}

export async function terminateWindowsProcessTreeSnapshot(
  rootPid: number,
  expectedRootCreationIdentity: string,
  spawnProcess: typeof cp.spawn = cp.spawn,
  descendantsBoundToRootLifetime = false,
): Promise<boolean> {
  if (!Number.isSafeInteger(rootPid)
    || rootPid <= 0
    || rootPid > 0x7fff_ffff
    || !/^[1-9][0-9]{0,18}$/u.test(expectedRootCreationIdentity)) {
    return false;
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Collections.Generic;",
    "using System.ComponentModel;",
    "using System.Runtime.InteropServices;",
    "public sealed class HydraProcessRow { public int ProcessId; public int ParentProcessId; public long CreationIdentity; }",
    "public static class HydraProcessSnapshot {",
    "  private const uint TH32CS_SNAPPROCESS = 0x00000002;",
    "  private const uint PROCESS_TERMINATE = 0x0001;",
    "  private const uint SYNCHRONIZE = 0x00100000;",
    "  private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;",
    "  private const uint WAIT_OBJECT_0 = 0x00000000;",
    "  private const uint STILL_ACTIVE = 259;",
    "  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
    "  private struct PROCESSENTRY32 {",
    "    public uint dwSize; public uint cntUsage; public uint th32ProcessID;",
    "    public IntPtr th32DefaultHeapID; public uint th32ModuleID; public uint cntThreads;",
    "    public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;",
    "    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;",
    "  }",
    "  [StructLayout(LayoutKind.Sequential)] private struct FILETIME { public uint Low; public uint High; }",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);",
    "  [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);",
    "  [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);",
    "  [DllImport(\"kernel32.dll\")] private static extern bool CloseHandle(IntPtr handle);",
    "  private static long FileTimeIdentity(FILETIME value) { return ((long)value.High << 32) | value.Low; }",
    "  private static long ReadCreationIdentity(int processId) {",
    "    IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);",
    "    if (process == IntPtr.Zero) return 0;",
    "    try {",
    "      FILETIME creation, exit, kernel, user;",
    "      return GetProcessTimes(process, out creation, out exit, out kernel, out user) ? FileTimeIdentity(creation) : 0;",
    "    } finally { CloseHandle(process); }",
    "  }",
    "  public static HydraProcessRow[] Capture() {",
    "    IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);",
    "    if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());",
    "    try {",
    "      var rows = new List<HydraProcessRow>();",
    "      var entry = new PROCESSENTRY32(); entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));",
    "      if (!Process32FirstW(snapshot, ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error());",
    "      do { int pid = (int)entry.th32ProcessID; rows.Add(new HydraProcessRow { ProcessId = pid, ParentProcessId = (int)entry.th32ParentProcessID, CreationIdentity = ReadCreationIdentity(pid) }); entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32)); } while (Process32NextW(snapshot, ref entry));",
    "      return rows.ToArray();",
    "    } finally { CloseHandle(snapshot); }",
    "  }",
    "  public static int TerminateIfIdentityMatches(int processId, long expectedCreationIdentity) {",
    "    IntPtr process = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, processId);",
    "    if (process == IntPtr.Zero) { int error = Marshal.GetLastWin32Error(); return error == 87 ? 0 : -1; }",
    "    try {",
    "      FILETIME creation, exit, kernel, user;",
    "      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return -1;",
    "      if (expectedCreationIdentity <= 0 || FileTimeIdentity(creation) != expectedCreationIdentity) return 0;",
    "      if (!TerminateProcess(process, 1)) { uint exitCode; return GetExitCodeProcess(process, out exitCode) && exitCode != STILL_ACTIVE ? 0 : -1; }",
    "      return WaitForSingleObject(process, 1000) == WAIT_OBJECT_0 ? 1 : -1;",
    "    } finally { CloseHandle(process); }",
    "  }",
    "}",
    "'@",
    "function Get-HydraProcessRows{return @([HydraProcessSnapshot]::Capture())}",
    "try {",
    `  $rootProcessId=${rootPid}`,
    `  $expectedRootCreationIdentity=[long]${expectedRootCreationIdentity}`,
    "  $known=[System.Collections.Generic.Dictionary[int,long]]::new()",
    "  $ordered=[System.Collections.Generic.List[int]]::new()",
    "  $processes=@(Get-HydraProcessRows)",
    "  $rootRows=@($processes | Where-Object { [int]$_.ProcessId -eq $rootProcessId })",
    "  if($rootRows.Count -ne 1 -or [long]$rootRows[0].CreationIdentity -ne $expectedRootCreationIdentity){exit 2}",
    "  $known.Add($rootProcessId,[long]$rootRows[0].CreationIdentity)",
    "  [void]$ordered.Add($rootProcessId)",
    "  function Add-HydraDescendants($rows){$rowByPid=@{};foreach($candidate in $rows){$rowByPid[[int]$candidate.ProcessId]=$candidate};$added=$true;while($added){$added=$false;foreach($row in $rows){$childProcessId=[int]$row.ProcessId;$parentProcessId=[int]$row.ParentProcessId;$expectedParentIdentity=[long]0;if($known.TryGetValue($parentProcessId,[ref]$expectedParentIdentity)){$parentRow=$rowByPid[$parentProcessId];if($null -ne $parentRow -and [long]$parentRow.CreationIdentity -eq $expectedParentIdentity -and -not $known.ContainsKey($childProcessId)){if([long]$row.CreationIdentity -le 0){throw 'Process creation identity unavailable'};$known.Add($childProcessId,[long]$row.CreationIdentity);[void]$ordered.Add($childProcessId);$added=$true}}}}}",
    "  function Stop-HydraProcess([int]$targetProcessId){$expectedCreationIdentity=[long]$known[$targetProcessId];$outcome=[HydraProcessSnapshot]::TerminateIfIdentityMatches($targetProcessId,$expectedCreationIdentity);if($outcome -lt 0){throw 'Identity-bound process termination failed'}}",
    "  $maxPasses=4",
    "  for($pass=0;$pass -lt $maxPasses;$pass++){",
    "    Add-HydraDescendants $processes",
    "    for($index=$ordered.Count-1;$index -ge 0;$index--){Stop-HydraProcess $ordered[$index]}",
    "    $knownCountBeforeRefresh=$known.Count",
    "    $processes=@(Get-HydraProcessRows)",
    "    Add-HydraDescendants $processes",
    "    $alive=@($processes | Where-Object {$expectedCreationIdentity=[long]0;$known.TryGetValue([int]$_.ProcessId,[ref]$expectedCreationIdentity) -and [long]$_.CreationIdentity -eq $expectedCreationIdentity})",
    "    if($known.Count -eq $knownCountBeforeRefresh -and $alive.Count -eq 0){exit 0}",
    "  }",
    "  exit 1",
    "} catch {",
    "  exit 1",
    "}",
  ].join("\n");
  return new Promise<boolean>((resolve) => {
    let killer: cp.ChildProcess;
    try {
      killer = spawnProcess(
        windowsSystemExecutable("powershell.exe"),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, stdio: "ignore" },
      );
    } catch {
      resolve(false);
      return;
    }
    let done = false;
    const finish = (requested: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(requested);
    };
    const timeout = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // The helper may have exited between the timeout and this kill.
      }
      killer.unref();
      finish(false);
    }, WINDOWS_PROCESS_TREE_TERMINATION_HELPER_TIMEOUT_MS);
    killer.on("error", () => finish(false));
    // A PID snapshot can safely identity-bind every process it saw, but it
    // cannot prove that the root did not create and orphan a new descendant
    // between capture and root termination. Only the bundled host's
    // spawn-before-target KILL_ON_JOB_CLOSE binding closes that race.
    killer.on("close", (code) => finish(
      code === 0 && descendantsBoundToRootLifetime,
    ));
  });
}
