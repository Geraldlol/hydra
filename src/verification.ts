import * as cp from "node:child_process";
import * as path from "node:path";
import { resolveGitExecutable } from "./gitExecutable";
import { windowsSystemExecutable } from "./executablePath";
import { stripAnsi } from "./agents";
import { appendFileSafely, ensureFile, readFileHead, readJsonlGuarded, serializePerFile } from "./fileQueue";

const MAX_VERIFICATION_PACKAGE_JSON_BYTES = 1024 * 1024;

export interface VerificationResult {
  timestamp: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** True when Hydra could not observe the spawned process closing after cancellation. */
  terminationFailed?: boolean;
  // Git HEAD at the moment verification ran. Captured so reviewers can
  // detect a forged or stale verification record — if HEAD has moved
  // since the result was written, the diff being reviewed isn't the
  // diff that was tested. The .jsonl file is plain text and trivially
  // forgeable; HEAD provides one anchor a reviewer can cross-check.
  headSha?: string;
}

export interface VerificationRunOptions {
  cwd: string;
  command: string;
  timeoutMs: number;
  maxOutputChars: number;
  signal?: AbortSignal;
}

interface VerificationProcess {
  command: string;
  args: string[];
  shell: boolean | string;
}

export async function ensureVerificationFile(filePath: string): Promise<void> {
  await ensureFile(filePath);
}

export async function appendVerification(filePath: string, result: VerificationResult): Promise<void> {
  await serializePerFile(filePath, async () => {
    await appendFileSafely(filePath, `${JSON.stringify(result)}\n`);
  });
}

export async function readVerifications(filePath: string): Promise<VerificationResult[]> {
  return readJsonlGuarded(filePath, isVerificationResult);
}

export async function inferVerificationCommand(workspaceRoot: string): Promise<string | undefined> {
  let parsed: unknown;
  try {
    const bounded = await readFileHead(
      path.join(workspaceRoot, "package.json"),
      MAX_VERIFICATION_PACKAGE_JSON_BYTES,
    );
    if (bounded.truncated) return undefined;
    parsed = JSON.parse(bounded.text);
  } catch {
    // No package.json, or it is unreadable/unparseable -> no command to infer.
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object") return undefined;
  const scriptNames = new Set(Object.keys(scripts));
  if (scriptNames.has("verify:fast")) return "npm run verify:fast";
  if (scriptNames.has("verify")) return "npm run verify";
  if (scriptNames.has("check") && scriptNames.has("test")) return "npm run check && npm test";
  if (scriptNames.has("test")) return "npm test";
  if (scriptNames.has("check")) return "npm run check";
  if (scriptNames.has("lint")) return "npm run lint";
  return undefined;
}

export type VerificationCommandResolution =
  | { kind: "explicit"; command: string }
  | { kind: "inferred"; command: string }
  | { kind: "refusedUntrustedInference" }
  | { kind: "missing" };

export async function resolveVerificationCommand(input: {
  configured: string;
  isWorkspaceTrusted: boolean;
  workspaceRoot: string;
}): Promise<VerificationCommandResolution> {
  const configured = input.configured.trim();
  if (configured) return { kind: "explicit", command: configured };
  // Why: package.json scripts in an untrusted workspace are
  // attacker-controlled. Refuse inference without ever reading
  // package.json so a hostile repo cannot probe Hydra's behavior either.
  if (!input.isWorkspaceTrusted) return { kind: "refusedUntrustedInference" };
  const inferred = await inferVerificationCommand(input.workspaceRoot);
  return inferred ? { kind: "inferred", command: inferred } : { kind: "missing" };
}

export interface VerificationResultWithCancel extends VerificationResult {
  cancelled?: boolean;
}

export async function runVerificationCommand(options: VerificationRunOptions): Promise<VerificationResultWithCancel> {
  const started = Date.now();
  return new Promise<VerificationResultWithCancel>((resolve) => {
    const processSpec = verificationProcessForCommand(options.command);
    const child = cp.spawn(processSpec.command, processSpec.args, {
      cwd: options.cwd,
      shell: processSpec.shell,
      windowsHide: true,
      env: process.env,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let forceBackstop: ReturnType<typeof setTimeout> | undefined;
    let failureBackstop: ReturnType<typeof setTimeout> | undefined;
    let terminationStarted = false;
    let terminationFailed = false;
    const signal = options.signal;
    const appendStdout = (text: string) => {
      stdout = truncateTail(stdout + text, options.maxOutputChars);
    };
    const appendStderr = (text: string) => {
      stderr = truncateTail(stderr + text, options.maxOutputChars);
    };
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceBackstop) clearTimeout(forceBackstop);
      if (failureBackstop) clearTimeout(failureBackstop);
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      resolve({
        timestamp: new Date().toISOString(),
        command: options.command,
        cwd: options.cwd,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        ...(cancelled ? { cancelled: true } : {}),
        ...(terminationFailed ? { terminationFailed: true } : {}),
      });
    };
    const beginTermination = () => {
      if (terminationStarted || settled) return;
      terminationStarted = true;
      void terminateProcessTree(child, false).then((requested) => {
        if (!requested && !settled) {
          appendStderr("\n[Hydra could not confirm the initial process-tree termination request.]\n");
        }
      });
      // `close` is the confirmation that inherited stdio handles are gone. If
      // it never arrives, escalate once, then return an explicitly failed
      // lifecycle result instead of silently claiming the run ended.
      forceBackstop = setTimeout(() => {
        void terminateProcessTree(child, true).then((requested) => {
          if (!requested && !settled) {
            appendStderr("\n[Hydra could not confirm the forced process-tree termination request.]\n");
          }
        });
        failureBackstop = setTimeout(() => {
          terminationFailed = true;
          appendStderr("\n[Hydra did not observe the verification process close; it may still be running.]\n");
          finish(null);
        }, 1_000);
      }, 1_000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      beginTermination();
    }, options.timeoutMs);

    const abortHandler = signal
      ? () => {
          if (!settled) {
            cancelled = true;
            beginTermination();
          }
        }
      : undefined;
    if (signal && abortHandler) {
      if (signal.aborted) queueMicrotask(abortHandler);
      else signal.addEventListener("abort", abortHandler, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => appendStdout(stripAnsi(chunk.toString("utf8"))));
    child.stderr?.on("data", (chunk: Buffer) => appendStderr(stripAnsi(chunk.toString("utf8"))));
    child.on("error", (err) => {
      appendStderr(err instanceof Error ? err.message : String(err));
      finish(null);
    });
    child.on("close", (exitCode) => finish(exitCode));
  });
}

export function verificationProcessForCommand(
  command: string,
  platform: NodeJS.Platform = process.platform
): VerificationProcess {
  // Windows `shell: true` goes through cmd.exe; PowerShell interpolation must
  // run under PowerShell or `$()` / `$env:NAME` are treated as plain cmd text.
  if (platform === "win32" && isPowerShellInterpolatedCommand(command)) {
    return {
      command: windowsSystemExecutable("powershell.exe"),
      args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      shell: false,
    };
  }
  return {
    command,
    args: [],
    shell: platform === "win32" ? windowsSystemExecutable("cmd.exe") : true,
  };
}

function isPowerShellInterpolatedCommand(command: string): boolean {
  return (
    /(^|[^`])\$\(/.test(command) ||
    /(^|[^`])\$env:[A-Za-z_][A-Za-z0-9_]*/i.test(command) ||
    /(^|[^`])\$\{env:[^}]+\}/i.test(command)
  );
}

export async function captureGitHead(cwd: string): Promise<string | undefined> {
  const gitExecutable = await resolveGitExecutable(cwd);
  if (!gitExecutable) return undefined;
  return new Promise<string | undefined>((resolve) => {
    const child = cp.spawn(gitExecutable, ["rev-parse", "HEAD"], { cwd, windowsHide: true, env: process.env });
    let out = "";
    let settled = false;
    const finish = (sha: string | undefined) => {
      if (settled) return;
      settled = true;
      resolve(sha);
    };
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => finish(undefined));
    child.on("close", (code) => {
      if (code !== 0) return finish(undefined);
      const sha = out.trim();
      finish(/^[0-9a-f]{40}$/i.test(sha) ? sha : undefined);
    });
  });
}

export function verificationAsReviewContext(result: VerificationResult | undefined, currentHead?: string): string {
  if (!result) return "No Hydra verification run has been recorded for this build.";
  const headLine = result.headSha
    ? `Head at verification: ${result.headSha}${
        currentHead && currentHead !== result.headSha
          ? ` (current HEAD is ${currentHead} — the diff under review is NOT the diff that was tested)`
          : ""
      }`
    : "Head at verification: <not captured> (verification artifact predates head tracking — treat as unverified)";
  return [
    `Command: ${result.command}`,
    `Exit code: ${result.exitCode === null ? "spawn-failed" : result.exitCode}`,
    `Timed out: ${result.timedOut}`,
    `Termination confirmed: ${result.terminationFailed ? "no" : "yes"}`,
    `Duration: ${formatDuration(result.durationMs)}`,
    headLine,
    result.stdout ? `Stdout:\n${result.stdout}` : "Stdout: <empty>",
    result.stderr ? `Stderr:\n${result.stderr}` : "Stderr: <empty>",
  ].join("\n");
}

export function verificationSummary(result: VerificationResult | undefined): string {
  if (!result) return "No verification yet";
  const status = result.terminationFailed
    ? "termination unconfirmed"
    : result.timedOut
      ? "timed out"
      : result.exitCode === 0
        ? "passed"
        : "failed";
  return `${status}: ${result.command} (${formatDuration(result.durationMs)})`;
}

export function verificationPassed(result: VerificationResult | undefined): boolean {
  return !!result && !result.timedOut && !result.terminationFailed && result.exitCode === 0;
}

function isVerificationResult(value: unknown): value is VerificationResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<VerificationResult>;
  return (
    typeof result.timestamp === "string" &&
    typeof result.command === "string" &&
    typeof result.cwd === "string" &&
    (typeof result.exitCode === "number" || result.exitCode === null) &&
    typeof result.timedOut === "boolean" &&
    typeof result.durationMs === "number" &&
    typeof result.stdout === "string" &&
    typeof result.stderr === "string" &&
    (result.terminationFailed === undefined || typeof result.terminationFailed === "boolean")
  );
}

function truncateTail(value: string, maxChars: number): string {
  if (maxChars <= 0 || value.length <= maxChars) return value;
  return `[... truncated ${value.length - maxChars} chars ...]\n${value.slice(-maxChars)}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest.toString().padStart(2, "0")}s`;
}

async function terminateProcessTree(child: cp.ChildProcess, force: boolean): Promise<boolean> {
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  if (!child.pid) {
    return child.kill(signal);
  }
  if (process.platform === "win32") {
    return new Promise<boolean>((resolve) => {
      const killer = cp.spawn(
        windowsSystemExecutable("taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true },
      );
      let done = false;
      const finish = (requested: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(killerTimeout);
        resolve(requested);
      };
      const killerTimeout = setTimeout(() => {
        killer.kill();
        const fallback = child.kill(signal);
        finish(fallback);
      }, 750);
      killer.on("error", () => finish(child.kill(signal)));
      killer.on("close", (code) => {
        if (code === 0) finish(true);
        else finish(child.kill(signal));
      });
    });
  }
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return child.kill(signal);
  }
}
