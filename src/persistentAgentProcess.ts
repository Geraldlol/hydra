import * as cp from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  bindProcessTreeIdentity,
  MAX_AGENT_STDERR_BYTES,
  MAX_AGENT_STDOUT_BYTES,
  TERMINATION_CONFIRM_WINDOW_MS,
  TERMINATION_FORCE_GRACE_MS,
  appendBoundedStream,
  isWindowsBatchCommand,
  releaseUnconfirmedChildProcess,
  spawnIdentityBoundProcess,
  spawnViaCmdShim,
  stripAnsi,
  terminateProcessTree,
  type AgentSpawn,
  type BoundedStreamState,
  type RunResult,
} from "./agents";

/**
 * A bounded native process whose stdin remains under the caller's control.
 *
 * `runAgent` deliberately closes stdin after one prompt. Steering transports
 * need the same output caps, timeout/cancellation behavior, and process-tree
 * teardown while retaining a serialized stdin channel for provider protocol
 * messages. This helper owns only that lifecycle; provider JSONL parsing stays
 * in the focused Codex/Claude transport modules.
 */
export interface PersistentAgentProcess {
  readonly child: cp.ChildProcess | undefined;
  readonly result: Promise<RunResult>;
  readonly inputOpen: boolean;
  write(data: string): Promise<void>;
  endInput(): Promise<void>;
  terminate(): void;
}

export function startPersistentAgentProcess(
  spawn: AgentSpawn,
  timeoutMs: number,
  onChunk: (chunk: string) => void,
  signal: AbortSignal,
): PersistentAgentProcess {
  let child: cp.ChildProcess;
  try {
    child = spawnPersistentChild(spawn);
  } catch (err) {
    const result = Promise.resolve<RunResult>({
      stdout: "",
      stderr: formatSpawnError(spawn, err),
      exitCode: null,
      timedOut: false,
      cancelled: false,
      timeoutMs,
    });
    return {
      child: undefined,
      result,
      inputOpen: false,
      async write(): Promise<void> {
        throw new Error("The native agent process did not start.");
      },
      async endInput(): Promise<void> {},
      terminate(): void {},
    };
  }

  const stdoutState: BoundedStreamState = { text: "", truncated: false };
  const stderrState: BoundedStreamState = { text: "", truncated: false };
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let stdoutDecoderEnded = false;
  let stderrDecoderEnded = false;
  let timedOut = false;
  let cancelled = false;
  let settled = false;
  let inputOpen = !!child.stdin && !child.stdin.destroyed;
  let terminationStarted = false;
  let terminationFailed = false;
  let forceBackstop: ReturnType<typeof setTimeout> | undefined;
  let failureBackstop: ReturnType<typeof setTimeout> | undefined;
  let resolveResult!: (result: RunResult) => void;
  let writeTail: Promise<void> = Promise.resolve();

  const result = new Promise<RunResult>((resolve) => {
    resolveResult = resolve;
  });

  const appendTerminationDiagnostic = (message: string): void => {
    const prefix = stderrState.text && !stderrState.text.endsWith("\n") ? "\n" : "";
    appendBoundedStream(
      stderrState,
      `${prefix}${message}\n`,
      MAX_AGENT_STDERR_BYTES,
      `[Hydra: agent stderr truncated at ${MAX_AGENT_STDERR_BYTES} bytes]`,
    );
  };

  const appendStdout = (text: string): void => {
    if (!text) return;
    const accepted = appendBoundedStream(
      stdoutState,
      stripAnsi(text),
      MAX_AGENT_STDOUT_BYTES,
      `[Hydra: agent stdout truncated at ${MAX_AGENT_STDOUT_BYTES} bytes - likely prompt injection from CLAUDE.md/AGENTS.md or runaway tool output]`,
    );
    if (!accepted) return;
    try {
      onChunk(accepted);
    } catch {
      // A disposed webview must not stop draining the native process.
    }
  };

  const appendStderr = (text: string): void => {
    if (!text) return;
    appendBoundedStream(
      stderrState,
      stripAnsi(text),
      MAX_AGENT_STDERR_BYTES,
      `[Hydra: agent stderr truncated at ${MAX_AGENT_STDERR_BYTES} bytes]`,
    );
  };

  const flushDecoders = (): void => {
    if (!stdoutDecoderEnded) {
      stdoutDecoderEnded = true;
      appendStdout(stdoutDecoder.end());
    }
    if (!stderrDecoderEnded) {
      stderrDecoderEnded = true;
      appendStderr(stderrDecoder.end());
    }
  };

  const finish = (exitCode: number | null): void => {
    if (settled) return;
    flushDecoders();
    settled = true;
    inputOpen = false;
    if (timer) clearTimeout(timer);
    if (forceBackstop) clearTimeout(forceBackstop);
    if (failureBackstop) clearTimeout(failureBackstop);
    signal.removeEventListener("abort", abortHandler);
    resolveResult({
      stdout: stdoutState.text,
      stderr: stderrState.text,
      exitCode,
      timedOut,
      cancelled,
      timeoutMs,
      ...(terminationFailed ? { terminationFailed: true } : {}),
    });
  };

  const beginTermination = (): void => {
    if (terminationStarted || settled) return;
    terminationStarted = true;
    inputOpen = false;
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
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // ESRCH means the process group is already gone.
        }
      }
      failureBackstop = setTimeout(() => {
        terminationFailed = true;
        appendTerminationDiagnostic(
          "[Hydra did not observe the native agent process close; it may still be running. Restart VS Code before starting more Hydra work.]",
        );
        releaseUnconfirmedChildProcess(child);
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

  const abortHandler = (): void => {
    if (settled || terminationStarted) return;
    cancelled = true;
    beginTermination();
  };

  if (signal.aborted) {
    queueMicrotask(abortHandler);
  } else {
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  child.stdout?.on("data", (chunk: Buffer) => appendStdout(stdoutDecoder.write(chunk)));
  child.stdout?.on("end", () => {
    if (stdoutDecoderEnded) return;
    stdoutDecoderEnded = true;
    appendStdout(stdoutDecoder.end());
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    appendStderr(stderrDecoder.write(chunk));
  });
  child.stderr?.on("end", () => {
    if (stderrDecoderEnded) return;
    stderrDecoderEnded = true;
    appendStderr(stderrDecoder.end());
  });
  child.on("error", (err) => {
    const prefix = stderrState.text ? "\n" : "";
    appendBoundedStream(
      stderrState,
      `${prefix}${formatSpawnError(spawn, err)}`,
      MAX_AGENT_STDERR_BYTES,
      `[Hydra: agent stderr truncated at ${MAX_AGENT_STDERR_BYTES} bytes]`,
    );
    finish(null);
  });
  child.on("close", (exitCode) => finish(exitCode));
  child.stdin?.on("error", () => {
    // The queued write callback reports EPIPE to its caller. Retaining this
    // listener prevents an unhandled stream error from taking down VS Code.
  });

  const handle: PersistentAgentProcess = {
    child,
    result,
    get inputOpen(): boolean {
      return inputOpen && !settled && !!child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded;
    },
    write(data: string): Promise<void> {
      const next = writeTail.then(() => new Promise<void>((resolve, reject) => {
        const stdin = child.stdin;
        if (!inputOpen || settled || !stdin || stdin.destroyed || stdin.writableEnded) {
          reject(new Error("The native agent stdin channel is closed."));
          return;
        }
        try {
          stdin.write(data, "utf8", (err) => {
            if (err) reject(err);
            else resolve();
          });
        } catch (err) {
          reject(err);
        }
      }));
      writeTail = next.catch(() => undefined);
      return next;
    },
    async endInput(): Promise<void> {
      const close = writeTail.then(() => new Promise<void>((resolve) => {
        inputOpen = false;
        const stdin = child.stdin;
        if (!stdin || stdin.destroyed || stdin.writableEnded) {
          resolve();
          return;
        }
        try {
          stdin.end(resolve);
        } catch {
          resolve();
        }
      }));
      // Closing is serialized in the same lane as writes. A steer admitted
      // before endInput() therefore cannot be invalidated merely because an
      // earlier write was still draining when completion raced the close.
      writeTail = close.catch(() => undefined);
      await close;
    },
    terminate(): void {
      beginTermination();
    },
  };
  return handle;
}

function spawnPersistentChild(spawn: AgentSpawn): cp.ChildProcess {
  if (isWindowsBatchCommand(spawn.command)) {
    return spawnViaCmdShim(spawn.command, spawn.args, {
      cwd: spawn.cwd,
      windowsHide: true,
      env: { ...process.env, ...(spawn.env ?? {}) },
    });
  }
  const child = spawnIdentityBoundProcess(spawn.command, spawn.args, {
    cwd: spawn.cwd,
    windowsHide: true,
    env: { ...process.env, ...(spawn.env ?? {}) },
    detached: process.platform !== "win32",
  });
  bindProcessTreeIdentity(child);
  return child;
}

function formatSpawnError(spawn: AgentSpawn, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = typeof err === "object" && err && "code" in err
    ? String((err as { code?: unknown }).code)
    : "";
  const lines = [
    `Failed to start native CLI command: ${spawn.command}`,
    `Working directory: ${spawn.cwd}`,
    message,
  ];
  if (code === "ENOENT") {
    lines.push(
      "Hydra could not find this executable from the VS Code extension host environment.",
      "Install the CLI on VS Code's PATH or set the Hydra agent command to a full executable path.",
    );
  }
  return lines.join("\n");
}
