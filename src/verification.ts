import * as cp from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveGitExecutable } from "./gitExecutable";
import { findExecutableOnPath, windowsSystemExecutable } from "./executablePath";
import { quoteForCmd, stripAnsi, terminateProcessTree } from "./agents";
import { appendFileSafely, ensureFile, readFileHead, readJsonlGuarded, serializePerFile } from "./fileQueue";

const MAX_VERIFICATION_PACKAGE_JSON_BYTES = 1024 * 1024;
const VERIFICATION_SCORING_PLAN_VERSION = "hydra-verification-scoring-plan-v1";
const VERIFICATION_CONTROL_FINGERPRINT_VERSION = "hydra-verification-controls-sha256-v1";
const MAX_VERIFICATION_CONTROL_ENTRIES = 50_000;
const MAX_VERIFICATION_CONTROL_FILES = 5_000;
const MAX_VERIFICATION_CONTROL_FILE_BYTES = 16 * 1024 * 1024;
const MAX_VERIFICATION_CONTROL_TOTAL_BYTES = 128 * 1024 * 1024;
const SKIPPED_VERIFICATION_CONTROL_DIRECTORIES = new Set([
  ".git",
  ".hydra",
  ".next",
  ".nuxt",
  ".cache",
  ".pnpm-store",
  ".turbo",
  ".venv",
  ".vscode-test",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv",
]);
const VERIFICATION_CONTROL_DIRECTORIES = new Set([
  ".github",
  ".vscode",
  ".yarn",
  "__tests__",
  "config",
  "scripts",
  "spec",
  "specs",
  "test",
  "tests",
  "tools",
]);

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

export type ResolvedVerificationCommand = Extract<
  VerificationCommandResolution,
  { kind: "explicit" | "inferred" }
>;

export interface VerificationControlFingerprint {
  readonly sha256: string;
  readonly fileCount: number;
}

export interface VerificationScoringPlan {
  readonly command: string;
  readonly resolutionKind: ResolvedVerificationCommand["kind"];
  readonly planSha256: string;
  readonly eligible: boolean;
  readonly controlSha256?: string;
  readonly controlFileCount?: number;
  readonly ineligibleReason?: string;
}

export interface VerificationScoringPlanOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

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

/**
 * Latch the exact command and capture a bounded conventional verifier-control
 * surface before a builder receives write access.
 *
 * Hydra still permits arbitrary application-scoped verification commands, but
 * only a deliberately small package-runner grammar is eligible for automatic
 * scoring. Static dependency discovery for an arbitrary shell program is not
 * reliable enough to support a deterministic standings claim.
 */
export async function createVerificationScoringPlan(
  workspaceRoot: string,
  resolution: ResolvedVerificationCommand,
  options: VerificationScoringPlanOptions = {},
): Promise<VerificationScoringPlan> {
  const parsed = parseAutomaticScoringCommand(resolution.command);
  if (!parsed) {
    return {
      command: resolution.command,
      resolutionKind: resolution.kind,
      planSha256: verificationScoringPlanSha256(resolution.kind, resolution.command),
      eligible: false,
      ineligibleReason: "the configured command is dynamic or outside Hydra's bounded package-script scoring grammar",
    };
  }
  const platform = options.platform ?? process.platform;
  const resolvedManagers = new Map<string, string>();
  for (const invocation of parsed) {
    if (resolvedManagers.has(invocation.manager)) continue;
    const executable = await findExecutableOnPath(invocation.manager, {
      env: options.env,
      platform,
      forbiddenRoots: [workspaceRoot],
    });
    const quoted = executable ? quoteVerificationExecutableForShell(executable, platform) : undefined;
    if (!quoted) {
      return {
        command: resolution.command,
        resolutionKind: resolution.kind,
        planSha256: verificationScoringPlanSha256(resolution.kind, resolution.command),
        eligible: false,
        ineligibleReason: `package manager '${invocation.manager}' could not be resolved safely outside the workspace`,
      };
    }
    resolvedManagers.set(invocation.manager, quoted);
  }
  const command = parsed
    .map((invocation) => `${resolvedManagers.get(invocation.manager)} ${invocation.arguments}`)
    .join(" && ");
  const planSha256 = verificationScoringPlanSha256(resolution.kind, command);
  try {
    const controls = await captureVerificationControlFingerprint(workspaceRoot);
    return {
      command,
      resolutionKind: resolution.kind,
      planSha256,
      eligible: true,
      controlSha256: controls.sha256,
      controlFileCount: controls.fileCount,
    };
  } catch (error) {
    return {
      command,
      resolutionKind: resolution.kind,
      planSha256,
      eligible: false,
      ineligibleReason: `the verification control surface could not be captured safely: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function verificationScoringPlanSha256(
  resolutionKind: ResolvedVerificationCommand["kind"],
  command: string,
): string {
  return createHash("sha256").update(JSON.stringify([
    VERIFICATION_SCORING_PLAN_VERSION,
    resolutionKind,
    command,
  ]), "utf8").digest("hex");
}

export async function captureVerificationControlFingerprint(
  workspaceRoot: string,
): Promise<VerificationControlFingerprint> {
  const root = path.resolve(workspaceRoot);
  const digest = createHash("sha256");
  digest.update(VERIFICATION_CONTROL_FINGERPRINT_VERSION, "utf8");
  let entryCount = 0;
  let fileCount = 0;
  let totalBytes = 0;

  const walk = async (directory: string, segments: readonly string[]): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")));
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_VERIFICATION_CONTROL_ENTRIES) {
        throw new Error(`workspace enumeration exceeded ${MAX_VERIFICATION_CONTROL_ENTRIES} entries`);
      }
      if (!entry.name || entry.name.includes("\0") || entry.name.includes("/") || (process.platform === "win32" && entry.name.includes("\\"))) {
        throw new Error("workspace contains an unsafe verification-control path");
      }
      const nextSegments = [...segments, entry.name];
      const relativePath = nextSegments.join("/");
      if (entry.isDirectory()) {
        if (!shouldSkipVerificationControlDirectory(nextSegments)) {
          await walk(path.join(directory, entry.name), nextSegments);
        }
        continue;
      }
      if (!isVerificationControlPath(nextSegments)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`verification control is not a regular file: ${relativePath}`);
      }
      fileCount += 1;
      if (fileCount > MAX_VERIFICATION_CONTROL_FILES) {
        throw new Error(`verification control inventory exceeded ${MAX_VERIFICATION_CONTROL_FILES} files`);
      }
      const fullPath = path.join(directory, entry.name);
      const before = await fs.lstat(fullPath);
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new Error(`verification control is not a stable regular file: ${relativePath}`);
      }
      if (before.size > MAX_VERIFICATION_CONTROL_FILE_BYTES) {
        throw new Error(`verification control exceeds ${MAX_VERIFICATION_CONTROL_FILE_BYTES} bytes: ${relativePath}`);
      }
      totalBytes += before.size;
      if (totalBytes > MAX_VERIFICATION_CONTROL_TOTAL_BYTES) {
        throw new Error(`verification controls exceed ${MAX_VERIFICATION_CONTROL_TOTAL_BYTES} total bytes`);
      }
      const handle = await fs.open(fullPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || !sameVerificationControlIdentity(before, opened)) {
          throw new Error(`verification control changed before capture: ${relativePath}`);
        }
        bytes = await handle.readFile();
        const after = await handle.stat();
        if (!sameVerificationControlIdentity(opened, after) || bytes.length !== opened.size) {
          throw new Error(`verification control changed during capture: ${relativePath}`);
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
      const pathBytes = Buffer.from(relativePath, "utf8");
      const header = Buffer.allocUnsafe(8);
      header.writeUInt32BE(pathBytes.length, 0);
      header.writeUInt32BE(bytes.length, 4);
      digest.update(header);
      digest.update(pathBytes);
      digest.update(bytes);
    }
  };

  await walk(root, []);
  return { sha256: digest.digest("hex"), fileCount };
}

interface ParsedAutomaticScoringInvocation {
  readonly manager: "npm" | "pnpm" | "yarn";
  readonly arguments: string;
}

function parseAutomaticScoringCommand(command: string): ParsedAutomaticScoringInvocation[] | undefined {
  const invocations = command.split(/\s*&&\s*/);
  if (invocations.length === 0) return undefined;
  const parsed: ParsedAutomaticScoringInvocation[] = [];
  for (const invocation of invocations) {
    const match = /^(npm|pnpm|yarn)(?:\.cmd)?\s+(run\s+[A-Za-z0-9:_-]+|test)$/i.exec(invocation);
    if (!match?.[1] || !match[2]) return undefined;
    parsed.push({
      manager: match[1].toLowerCase() as ParsedAutomaticScoringInvocation["manager"],
      arguments: match[2],
    });
  }
  return parsed;
}

export function quoteVerificationExecutableForShell(executable: string, platform: NodeJS.Platform): string | undefined {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(executable) || /[\0\r\n]/.test(executable)) return undefined;
  if (platform === "win32") {
    // cmd.exe expands percent variables and delayed-exclamation variables even
    // inside ordinary quotes. Reject those rare paths instead of pretending a
    // quoted batch-shim invocation is stable.
    if (/[%!]/.test(executable)) return undefined;
    return quoteForCmd(executable);
  }
  return `'${executable.replace(/'/g, `'"'"'`)}'`;
}

function shouldSkipVerificationControlDirectory(segments: readonly string[]): boolean {
  const basename = segments.at(-1)?.toLowerCase() ?? "";
  if (SKIPPED_VERIFICATION_CONTROL_DIRECTORIES.has(basename)) return true;
  return segments.length >= 2
    && segments.at(-2)?.toLowerCase() === ".yarn"
    && (basename === "cache" || basename === "unplugged");
}

function isVerificationControlPath(segments: readonly string[]): boolean {
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  if (lowerSegments.some((segment) => VERIFICATION_CONTROL_DIRECTORIES.has(segment))) return true;
  const basename = lowerSegments.at(-1) ?? "";
  if (/^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(basename)) return true;
  if (/^(?:\.npmrc|\.yarnrc(?:\..+)?|\.pnp\..+|pnpm-workspace\.ya?ml|\.pnpmfile(?:\..+)?)$/.test(basename)) return true;
  if (/^(?:makefile|justfile|taskfile(?:\.ya?ml)?)$/.test(basename)) return true;
  if (/\.(?:cmd|bat|ps1|sh)$/.test(basename)) return true;
  if (/(?:^|[._-])(?:test|tests|spec|specs)(?:[._-]|$)/.test(basename)) return true;
  if (/(?:^|[._-])(?:verify|verifier|verification|check|lint)(?:[._-]|$)/.test(basename)) return true;
  return /^(?:tsconfig|jsconfig|vitest|vite|jest|playwright|cypress|eslint|prettier|babel|webpack|rollup|ava|mocha|nyc|tap)(?:\..+)?$/.test(basename)
    || /^\.(?:eslintrc|prettierrc|babelrc)(?:\..+)?$/.test(basename)
    || /^(?:turbo|nx)\.json$/.test(basename);
}

function sameVerificationControlIdentity(left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }, right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
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
