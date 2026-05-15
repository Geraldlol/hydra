import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stripAnsi } from "./agents";
import { ensureFile, readJsonlGuarded, serializePerFile } from "./fileQueue";

export interface VerificationResult {
  timestamp: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
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

export async function ensureVerificationFile(filePath: string): Promise<void> {
  await ensureFile(filePath);
}

export async function appendVerification(filePath: string, result: VerificationResult): Promise<void> {
  await serializePerFile(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(result)}\n`, "utf8");
  });
}

export async function readVerifications(filePath: string): Promise<VerificationResult[]> {
  return readJsonlGuarded(filePath, isVerificationResult);
}

export async function inferVerificationCommand(workspaceRoot: string): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object") return undefined;
  const scriptNames = new Set(Object.keys(scripts));
  if (scriptNames.has("check") && scriptNames.has("test")) return "npm run check && npm test";
  if (scriptNames.has("test")) return "npm test";
  if (scriptNames.has("check")) return "npm run check";
  if (scriptNames.has("lint")) return "npm run lint";
  return undefined;
}

export interface VerificationResultWithCancel extends VerificationResult {
  cancelled?: boolean;
}

export async function runVerificationCommand(options: VerificationRunOptions): Promise<VerificationResultWithCancel> {
  const started = Date.now();
  return new Promise<VerificationResultWithCancel>((resolve) => {
    const child = cp.spawn(options.command, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
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
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, options.timeoutMs);

    const abortHandler = signal
      ? () => {
          if (!settled) {
            cancelled = true;
            terminateProcessTree(child);
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

export async function captureGitHead(cwd: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const child = cp.spawn("git", ["rev-parse", "HEAD"], { cwd, windowsHide: true, env: process.env });
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
    `Duration: ${formatDuration(result.durationMs)}`,
    headLine,
    result.stdout ? `Stdout:\n${result.stdout}` : "Stdout: <empty>",
    result.stderr ? `Stderr:\n${result.stderr}` : "Stderr: <empty>",
  ].join("\n");
}

export function verificationSummary(result: VerificationResult | undefined): string {
  if (!result) return "No verification yet";
  const status = result.timedOut
    ? "timed out"
    : result.exitCode === 0
      ? "passed"
      : "failed";
  return `${status}: ${result.command} (${formatDuration(result.durationMs)})`;
}

export function verificationPassed(result: VerificationResult | undefined): boolean {
  return !!result && !result.timedOut && result.exitCode === 0;
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
    typeof result.stderr === "string"
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

function terminateProcessTree(child: cp.ChildProcess): void {
  if (!child.pid) {
    child.kill();
    return;
  }
  if (process.platform === "win32") {
    const killer = cp.spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    killer.on("error", () => child.kill());
    return;
  }
  child.kill();
}
