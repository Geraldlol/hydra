import * as cp from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import {
  constants as fsConstants,
  watch as watchFileSystem,
  type BigIntStats,
  type FSWatcher,
  type Stats,
} from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveGitExecutable } from "./gitExecutable";

export const DUEL_WORKSPACE_FINGERPRINT_VERSION = "hydra-workspace-sha256-v1" as const;

export type DuelWorkspaceIntegrityErrorCode =
  | "gitUnavailable"
  | "gitFailed"
  | "gitTimedOut"
  | "gitOutputTooLarge"
  | "tooManyFiles"
  | "fileTooLarge"
  | "workspaceTooLarge"
  | "unsafePath"
  | "linkedWorkspace"
  | "unsupportedFileType"
  | "fileUnreadable"
  | "workspaceChangedDuringCapture";

export class DuelWorkspaceIntegrityError extends Error {
  constructor(
    public readonly code: DuelWorkspaceIntegrityErrorCode,
    message: string,
    public readonly filePath?: string,
  ) {
    super(message);
    this.name = "DuelWorkspaceIntegrityError";
  }
}

export interface DuelWorkspaceFingerprintOptions {
  /** Include ignored-file/directory metadata. Defaults true for duel integrity. */
  includeWorkspaceMetadata?: boolean;
  /** Hash only Git-dirty tracked worktree files; index OIDs still cover every tracked file. */
  hashOnlyChangedTrackedFiles?: boolean;
  maxFiles?: number;
  maxMetadataEntries?: number;
  maxFileBytes?: number;
  maxTotalFileBytes?: number;
  maxGitOutputBytes?: number;
  gitTimeoutMs?: number;
}

export interface DuelWorkspaceFingerprint {
  version: typeof DUEL_WORKSPACE_FINGERPRINT_VERSION;
  algorithm: "sha256";
  sha256: string;
  head: string;
  trackedFileCount: number;
  untrackedFileCount: number;
  workspaceEntryCount: number;
  totalFileBytes: number;
}

interface RequiredFingerprintOptions {
  maxFiles: number;
  maxMetadataEntries: number;
  maxFileBytes: number;
  maxTotalFileBytes: number;
  maxGitOutputBytes: number;
  gitTimeoutMs: number;
}

interface IndexEntry {
  mode: string;
  oid: string;
  stage: number;
  gitPath: string;
}

interface CaptureBudget {
  gitOutputBytes: number;
  fileBytes: number;
}

const DEFAULT_OPTIONS: RequiredFingerprintOptions = {
  maxFiles: 20_000,
  maxMetadataEntries: 100_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalFileBytes: 512 * 1024 * 1024,
  maxGitOutputBytes: 16 * 1024 * 1024,
  gitTimeoutMs: 30_000,
};
const MAX_GIT_RECORD_BYTES = 64 * 1024;
const FILE_READ_CHUNK_BYTES = 64 * 1024;
const MAX_GIT_STDERR_BYTES = 64 * 1024;
const SAFE_GIT_PREFIX = [
  "--no-pager",
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", "diff.external=",
  "-c", "diff.trustExitCode=false",
] as const;

/**
 * Capture a deterministic digest of Git HEAD, the logical index, indexed
 * worktree entries, and non-ignored untracked files/link targets.
 *
 * The full duel capture avoids `git status` and `git diff`. The reduced
 * scoring profile may use guarded `git diff --name-only` with fsmonitor,
 * external-diff, and textconv hooks disabled. File contents are streamed under
 * explicit limits and symbolic links are never followed.
 */
export async function captureDuelWorkspaceFingerprint(
  workspaceRoot: string,
  options: DuelWorkspaceFingerprintOptions = {},
): Promise<DuelWorkspaceFingerprint> {
  const limits = fingerprintOptions(options);
  const root = path.resolve(workspaceRoot);
  await assertUnlinkedWorkspaceRoot(root);

  const gitExecutable = await resolveGitExecutable(root);
  if (!gitExecutable) {
    throw new DuelWorkspaceIntegrityError(
      "gitUnavailable",
      "Git is unavailable or workspace Git execution is not trusted.",
    );
  }

  const budget: CaptureBudget = { gitOutputBytes: 0, fileBytes: 0 };
  const headOutput = await runGitBounded(
    gitExecutable,
    root,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    limits,
    budget,
    256,
  );
  const head = headOutput.toString("ascii").trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) {
    throw new DuelWorkspaceIntegrityError("gitFailed", "Git returned an invalid HEAD object id.");
  }

  const indexRecords = await runGitNulRecords(
    gitExecutable,
    root,
    ["ls-files", "--cached", "--stage", "-z", "--"],
    limits,
    budget,
  );
  const indexEntries = indexRecords.map(parseIndexEntry);
  const trackedPaths = uniqueSortedPaths(indexEntries.map((entry) => entry.gitPath));

  const untrackedRecords = await runGitNulRecords(
    gitExecutable,
    root,
    ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    limits,
    budget,
  );
  const untrackedPaths = uniqueSortedPaths(untrackedRecords.map(decodeGitPath));
  if (trackedPaths.length + untrackedPaths.length > limits.maxFiles) {
    throw new DuelWorkspaceIntegrityError(
      "tooManyFiles",
      `Workspace contains more than ${limits.maxFiles} tracked and untracked entries.`,
    );
  }

  const digest = createHash("sha256");
  hashText(digest, "version", DUEL_WORKSPACE_FINGERPRINT_VERSION);
  hashText(digest, "head", head);
  indexEntries
    .sort(compareIndexEntries)
    .forEach((entry) => hashText(digest, "index", JSON.stringify([
      entry.mode,
      entry.oid,
      entry.stage,
      entry.gitPath,
    ])));

  const trackedWorktreePaths = options.hashOnlyChangedTrackedFiles
    ? uniqueSortedPaths((await runGitNulRecords(
        gitExecutable,
        root,
        ["diff", "--name-only", "--no-ext-diff", "--no-textconv", "-z", "HEAD", "--"],
        limits,
        budget,
      )).map(decodeGitPath))
    : trackedPaths;
  if (options.hashOnlyChangedTrackedFiles) {
    hashText(digest, "tracked-worktree-scope", "git-dirty-only-v1");
  }
  for (const gitPath of trackedWorktreePaths) {
    await hashTrackedWorktreeEntry(digest, root, gitPath, limits, budget);
  }

  let untrackedFileCount = 0;
  for (const gitPath of untrackedPaths) {
    if (await hashUntrackedEntry(
      digest,
      root,
      gitPath,
      limits,
      budget,
      options.includeWorkspaceMetadata === false,
    )) {
      untrackedFileCount += 1;
    }
  }

  // Content hashing remains bounded to Git evidence, while this metadata pass
  // covers ignored files, links, directories, and special entries without
  // reading dependency/build trees into memory. ctime/mtime/type/link-target
  // changes make ordinary ignored-file mutations visible to the duel guard.
  const workspaceEntryCount = options.includeWorkspaceMetadata === false
    ? 0
    : await hashWorkspaceEntryMetadata(digest, root, limits);

  return {
    version: DUEL_WORKSPACE_FINGERPRINT_VERSION,
    algorithm: "sha256",
    sha256: digest.digest("hex"),
    head,
    trackedFileCount: trackedPaths.length,
    untrackedFileCount,
    workspaceEntryCount,
    totalFileBytes: budget.fileBytes,
  };
}

export interface DuelWorkspaceMutationMonitor {
  readonly changed: boolean;
  readonly changedPaths: readonly string[];
  readonly error?: string;
  settle(): Promise<void>;
  close(): void;
}

/**
 * Keep a best-effort recursive mutation sentinel alive across each native head
 * call. The stable before/after fingerprint remains authoritative; this
 * sentinel additionally catches write-then-revert and ignored-file activity.
 */
export function watchDuelWorkspaceMutations(workspaceRoot: string): DuelWorkspaceMutationMonitor {
  const root = path.resolve(workspaceRoot);
  const changedPaths = new Set<string>();
  let watcher: FSWatcher;
  let watcherError: string | undefined;
  try {
    watcher = watchFileSystem(root, { recursive: true }, (_eventType, filename) => {
      const relative = typeof filename === "string" ? filename.replace(/\\/g, "/") : "";
      if (!relative) {
        watcherError ??= "Workspace watcher emitted an event without a path.";
        return;
      }
      const top = relative.split("/", 1)[0]?.toLowerCase();
      // Git metadata may be refreshed by read-only Git commands, and .hydra
      // is Hydra's own live state/mirror surface. Project evidence elsewhere
      // is never exempt, even when ignored by Git.
      if (top === ".git" || top === ".hydra") return;
      changedPaths.add(relative.slice(0, 512));
    });
  } catch (error) {
    throw new DuelWorkspaceIntegrityError(
      "fileUnreadable",
      `Could not start the recursive duel workspace mutation monitor${isNodeError(error) && error.code ? ` (${error.code})` : ""}.`,
      root,
    );
  }
  watcher.on("error", (error) => {
    watcherError = `Workspace mutation monitor failed${isNodeError(error) && error.code ? ` (${error.code})` : ""}.`;
  });
  return {
    get changed() { return changedPaths.size > 0 || watcherError !== undefined; },
    get changedPaths() { return [...changedPaths].sort(compareGitPaths).slice(0, 20); },
    get error() { return watcherError; },
    async settle() {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    },
    close() {
      watcher.close();
    },
  };
}

const METADATA_EXCLUDED_ROOTS = new Set([".git", ".hydra"]);

async function hashWorkspaceEntryMetadata(
  digest: Hash,
  root: string,
  limits: RequiredFingerprintOptions,
): Promise<number> {
  let count = 0;
  const walk = async (directory: string, parentSegments: readonly string[]): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw unreadableError(parentSegments.join("/") || root, error);
    }
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")));
    for (const entry of entries) {
      if (parentSegments.length === 0 && METADATA_EXCLUDED_ROOTS.has(entry.name.toLowerCase())) continue;
      if (!entry.name || entry.name.includes("\0") || entry.name.includes("/") || (process.platform === "win32" && entry.name.includes("\\"))) {
        throw new DuelWorkspaceIntegrityError("unsafePath", "Workspace contains an unsafe directory entry name.");
      }
      count += 1;
      if (count > limits.maxMetadataEntries) {
        throw new DuelWorkspaceIntegrityError(
          "tooManyFiles",
          `Workspace contains more than ${limits.maxMetadataEntries} metadata entries outside .git and .hydra.`,
        );
      }
      const segments = [...parentSegments, entry.name];
      const gitPath = segments.join("/");
      validateGitPath(gitPath);
      const fullPath = path.join(root, ...segments);
      let before: BigIntStats;
      try {
        before = await fs.lstat(fullPath, { bigint: true });
      } catch (error) {
        throw unreadableError(gitPath, error);
      }
      const kind = metadataKind(before);
      let linkTarget: string | null = null;
      if (before.isSymbolicLink()) {
        try {
          linkTarget = await fs.readlink(fullPath, "utf8");
        } catch (error) {
          throw unreadableError(gitPath, error);
        }
      }
      hashText(digest, "workspace-metadata", JSON.stringify([
        gitPath,
        kind,
        before.dev.toString(),
        before.ino.toString(),
        before.mode.toString(),
        before.size.toString(),
        before.mtimeNs.toString(),
        before.ctimeNs.toString(),
        linkTarget,
      ]));
      if (before.isDirectory() && !before.isSymbolicLink()) await walk(fullPath, segments);
      let after: BigIntStats;
      try {
        after = await fs.lstat(fullPath, { bigint: true });
      } catch (error) {
        throw new DuelWorkspaceIntegrityError(
          "workspaceChangedDuringCapture",
          `Workspace entry disappeared during metadata capture: ${gitPath}`,
          gitPath,
        );
      }
      if (!sameBigIntFileIdentity(before, after) || metadataKind(after) !== kind) {
        throw new DuelWorkspaceIntegrityError(
          "workspaceChangedDuringCapture",
          `Workspace entry changed during metadata capture: ${gitPath}`,
          gitPath,
        );
      }
    }
  };
  await walk(root, []);
  return count;
}

function metadataKind(stat: BigIntStats): string {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symbolic-link";
  if (stat.isBlockDevice()) return "block-device";
  if (stat.isCharacterDevice()) return "character-device";
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  return "other";
}

function sameBigIntFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function fingerprintOptions(options: DuelWorkspaceFingerprintOptions): RequiredFingerprintOptions {
  const result: RequiredFingerprintOptions = {
    maxFiles: options.maxFiles ?? DEFAULT_OPTIONS.maxFiles,
    maxMetadataEntries: options.maxMetadataEntries ?? DEFAULT_OPTIONS.maxMetadataEntries,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_OPTIONS.maxFileBytes,
    maxTotalFileBytes: options.maxTotalFileBytes ?? DEFAULT_OPTIONS.maxTotalFileBytes,
    maxGitOutputBytes: options.maxGitOutputBytes ?? DEFAULT_OPTIONS.maxGitOutputBytes,
    gitTimeoutMs: options.gitTimeoutMs ?? DEFAULT_OPTIONS.gitTimeoutMs,
  };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer.`);
    }
  }
  return result;
}

async function assertUnlinkedWorkspaceRoot(root: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(root);
  } catch (error) {
    throw unreadableError(root, error);
  }
  if (stat.isSymbolicLink()) {
    throw new DuelWorkspaceIntegrityError(
      "linkedWorkspace",
      "Duel workspace fingerprinting refuses a symbolic-link workspace root.",
      root,
    );
  }
  if (!stat.isDirectory()) {
    throw new DuelWorkspaceIntegrityError(
      "unsupportedFileType",
      "Duel workspace root is not a directory.",
      root,
    );
  }
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG_COUNT",
  ]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_EXTERNAL_DIFF = "";
  env.GIT_DIFF_OPTS = "";
  return env;
}

async function runGitBounded(
  gitExecutable: string,
  cwd: string,
  args: readonly string[],
  limits: RequiredFingerprintOptions,
  budget: CaptureBudget,
  commandOutputLimit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let outputBytes = 0;
  await runGitStreaming(gitExecutable, cwd, args, limits, budget, (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > commandOutputLimit) {
      throw new DuelWorkspaceIntegrityError(
        "gitOutputTooLarge",
        `Git command output exceeded ${commandOutputLimit} bytes.`,
      );
    }
    chunks.push(Buffer.from(chunk));
  });
  return Buffer.concat(chunks, outputBytes);
}

async function runGitNulRecords(
  gitExecutable: string,
  cwd: string,
  args: readonly string[],
  limits: RequiredFingerprintOptions,
  budget: CaptureBudget,
): Promise<Buffer[]> {
  const records: Buffer[] = [];
  let parts: Buffer[] = [];
  let recordBytes = 0;
  await runGitStreaming(gitExecutable, cwd, args, limits, budget, (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      const nul = chunk.indexOf(0, offset);
      const end = nul >= 0 ? nul : chunk.length;
      const part = chunk.subarray(offset, end);
      if (part.length > 0) {
        recordBytes += part.length;
        if (recordBytes > MAX_GIT_RECORD_BYTES) {
          throw new DuelWorkspaceIntegrityError(
            "unsafePath",
            `Git emitted a record longer than ${MAX_GIT_RECORD_BYTES} bytes.`,
          );
        }
        parts.push(Buffer.from(part));
      }
      if (nul < 0) break;
      records.push(Buffer.concat(parts, recordBytes));
      parts = [];
      recordBytes = 0;
      offset = nul + 1;
    }
  });
  if (recordBytes !== 0 || parts.length !== 0) {
    throw new DuelWorkspaceIntegrityError("gitFailed", "Git emitted an unterminated path record.");
  }
  return records;
}

async function runGitStreaming(
  gitExecutable: string,
  cwd: string,
  args: readonly string[],
  limits: RequiredFingerprintOptions,
  budget: CaptureBudget,
  onStdout: (chunk: Buffer) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = cp.spawn(gitExecutable, [...SAFE_GIT_PREFIX, ...args], {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: sanitizedGitEnvironment(),
    });
    let stderr = "";
    let stderrBytes = 0;
    let failure: Error | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, limits.gitTimeoutMs);

    child.stdout.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      budget.gitOutputBytes += chunk.length;
      if (budget.gitOutputBytes > limits.maxGitOutputBytes) {
        failure ??= new DuelWorkspaceIntegrityError(
          "gitOutputTooLarge",
          `Git output exceeded ${limits.maxGitOutputBytes} bytes.`,
        );
        child.kill();
        return;
      }
      if (failure) return;
      try {
        onStdout(chunk);
      } catch (error) {
        failure = asError(error);
        child.kill();
      }
    });
    child.stderr.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (stderrBytes >= MAX_GIT_STDERR_BYTES) return;
      const kept = chunk.subarray(0, MAX_GIT_STDERR_BYTES - stderrBytes);
      stderr += kept.toString("utf8");
      stderrBytes += kept.length;
    });
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new DuelWorkspaceIntegrityError(
          "gitTimedOut",
          `Git did not finish within ${limits.gitTimeoutMs}ms.`,
        ));
        return;
      }
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim();
        reject(new DuelWorkspaceIntegrityError(
          "gitFailed",
          detail ? `Git command failed: ${detail}` : `Git command exited with code ${String(code)}.`,
        ));
        return;
      }
      resolve();
    });
  });
}

function parseIndexEntry(record: Buffer): IndexEntry {
  const tab = record.indexOf(0x09);
  if (tab <= 0) {
    throw new DuelWorkspaceIntegrityError("gitFailed", "Git emitted an invalid index record.");
  }
  const metadata = record.subarray(0, tab).toString("ascii");
  const match = /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])$/.exec(metadata);
  if (!match) {
    throw new DuelWorkspaceIntegrityError("gitFailed", "Git emitted invalid index metadata.");
  }
  const mode = match[1];
  const oid = match[2];
  const stageText = match[3];
  if (mode === undefined || oid === undefined || stageText === undefined) {
    throw new DuelWorkspaceIntegrityError("gitFailed", "Git emitted incomplete index metadata.");
  }
  return {
    mode,
    oid,
    stage: Number(stageText),
    gitPath: decodeGitPath(record.subarray(tab + 1)),
  };
}

function decodeGitPath(record: Buffer): string {
  if (record.length === 0 || record.includes(0)) {
    throw new DuelWorkspaceIntegrityError("unsafePath", "Git emitted an empty or invalid path.");
  }
  const gitPath = record.toString("utf8");
  if (!Buffer.from(gitPath, "utf8").equals(record)) {
    throw new DuelWorkspaceIntegrityError("unsafePath", "Git emitted a path that is not valid UTF-8.");
  }
  validateGitPath(gitPath);
  return gitPath;
}

function validateGitPath(gitPath: string): void {
  const segments = gitPath.split("/");
  if (
    path.posix.isAbsolute(gitPath)
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    || (process.platform === "win32" && gitPath.includes("\\"))
  ) {
    throw new DuelWorkspaceIntegrityError("unsafePath", `Git emitted an unsafe path: ${gitPath}`, gitPath);
  }
}

function uniqueSortedPaths(paths: string[]): string[] {
  return [...new Set(paths)].sort(compareGitPaths);
}

function compareGitPaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareIndexEntries(left: IndexEntry, right: IndexEntry): number {
  return compareGitPaths(left.gitPath, right.gitPath)
    || left.stage - right.stage
    || left.mode.localeCompare(right.mode)
    || left.oid.localeCompare(right.oid);
}

async function hashTrackedWorktreeEntry(
  digest: Hash,
  root: string,
  gitPath: string,
  limits: RequiredFingerprintOptions,
  budget: CaptureBudget,
): Promise<void> {
  const fullPath = await safeWorkspacePath(root, gitPath);
  let stat;
  try {
    stat = await fs.lstat(fullPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      hashText(digest, "tracked", JSON.stringify([gitPath, "missing"]));
      return;
    }
    throw unreadableError(gitPath, error);
  }
  if (stat.isSymbolicLink()) {
    const target = await readStableLink(fullPath, gitPath, stat, limits);
    hashText(digest, "tracked-link", JSON.stringify([gitPath, target]));
    return;
  }
  if (!stat.isFile()) {
    throw new DuelWorkspaceIntegrityError(
      "unsupportedFileType",
      `Tracked entry is not a regular file or symbolic link: ${gitPath}`,
      gitPath,
    );
  }
  await hashStableRegularFile(digest, fullPath, gitPath, "tracked-file", stat, limits, budget);
}

async function hashUntrackedEntry(
  digest: Hash,
  root: string,
  gitPath: string,
  limits: RequiredFingerprintOptions,
  budget: CaptureBudget,
  rejectUnsupportedType: boolean,
): Promise<boolean> {
  const fullPath = await safeWorkspacePath(root, gitPath);
  let stat;
  try {
    stat = await fs.lstat(fullPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new DuelWorkspaceIntegrityError(
        "workspaceChangedDuringCapture",
        `Untracked file disappeared during fingerprint capture: ${gitPath}`,
        gitPath,
      );
    }
    throw unreadableError(gitPath, error);
  }
  // Git lists untracked links, FIFOs, and device nodes too. Links are part of
  // Git-visible state, so bind their target text without ever following them.
  // The duel fingerprint's metadata pass covers other special entries. The
  // scoring profile deliberately omits that expensive pass, so it must reject
  // unsupported types instead of silently treating them as unchanged.
  if (stat.isSymbolicLink()) {
    if (rejectUnsupportedType) {
      const target = await readStableLink(fullPath, gitPath, stat, limits);
      hashText(digest, "untracked-link", JSON.stringify([gitPath, target]));
    }
    return false;
  }
  if (!stat.isFile()) {
    if (rejectUnsupportedType) {
      throw new DuelWorkspaceIntegrityError(
        "unsupportedFileType",
        `Untracked entry is not a regular file or symbolic link: ${gitPath}`,
        gitPath,
      );
    }
    return false;
  }
  await hashStableRegularFile(digest, fullPath, gitPath, "untracked-file", stat, limits, budget);
  return true;
}

async function safeWorkspacePath(root: string, gitPath: string): Promise<string> {
  validateGitPath(gitPath);
  const segments = gitPath.split("/");
  const fullPath = path.resolve(root, ...segments);
  const relative = path.relative(root, fullPath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new DuelWorkspaceIntegrityError("unsafePath", `Path escapes the workspace: ${gitPath}`, gitPath);
  }
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    let stat;
    try {
      stat = await fs.lstat(parent);
    } catch (error) {
      throw unreadableError(gitPath, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new DuelWorkspaceIntegrityError(
        "unsafePath",
        `Path has a linked or non-directory parent: ${gitPath}`,
        gitPath,
      );
    }
  }
  return fullPath;
}

async function readStableLink(
  fullPath: string,
  gitPath: string,
  before: Stats,
  limits: RequiredFingerprintOptions,
): Promise<string> {
  let target: string;
  try {
    target = await fs.readlink(fullPath, "utf8");
  } catch (error) {
    throw unreadableError(gitPath, error);
  }
  const bytes = Buffer.byteLength(target, "utf8");
  if (bytes > limits.maxFileBytes) {
    throw new DuelWorkspaceIntegrityError(
      "fileTooLarge",
      `Symbolic link exceeds ${limits.maxFileBytes} bytes: ${gitPath}`,
      gitPath,
    );
  }
  let after;
  try {
    after = await fs.lstat(fullPath);
  } catch (error) {
    throw unreadableError(gitPath, error);
  }
  if (!sameFileIdentity(before, after) || !after.isSymbolicLink()) {
    throw new DuelWorkspaceIntegrityError(
      "workspaceChangedDuringCapture",
      `Symbolic link changed during fingerprint capture: ${gitPath}`,
      gitPath,
    );
  }
  return target;
}

async function hashStableRegularFile(
  digest: Hash,
  fullPath: string,
  gitPath: string,
  domain: string,
  before: Stats,
  limits: RequiredFingerprintOptions,
  budget: CaptureBudget,
): Promise<void> {
  assertFileBudget(gitPath, before.size, limits, budget);
  let handle;
  try {
    handle = await fs.open(fullPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    throw unreadableError(gitPath, error);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new DuelWorkspaceIntegrityError(
        "workspaceChangedDuringCapture",
        `File changed before it could be read: ${gitPath}`,
        gitPath,
      );
    }
    hashText(digest, domain, JSON.stringify([
      gitPath,
      opened.size,
      (opened.mode & 0o111) !== 0,
    ]));
    const chunk = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK_BYTES, Math.max(1, opened.size)));
    let position = 0;
    while (position < opened.size) {
      const requested = Math.min(chunk.length, opened.size - position);
      const { bytesRead } = await handle.read(chunk, 0, requested, position);
      if (bytesRead === 0) {
        throw new DuelWorkspaceIntegrityError(
          "workspaceChangedDuringCapture",
          `File became shorter during fingerprint capture: ${gitPath}`,
          gitPath,
        );
      }
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const openedAfter = await handle.stat();
    let pathAfter;
    try {
      pathAfter = await fs.lstat(fullPath);
    } catch (error) {
      throw unreadableError(gitPath, error);
    }
    if (
      !sameFileIdentity(opened, openedAfter)
      || !sameFileIdentity(openedAfter, pathAfter)
      || openedAfter.size !== position
      || openedAfter.mtimeMs !== opened.mtimeMs
      || openedAfter.ctimeMs !== opened.ctimeMs
    ) {
      throw new DuelWorkspaceIntegrityError(
        "workspaceChangedDuringCapture",
        `File changed during fingerprint capture: ${gitPath}`,
        gitPath,
      );
    }
    budget.fileBytes += position;
  } catch (error) {
    if (error instanceof DuelWorkspaceIntegrityError) throw error;
    throw unreadableError(gitPath, error);
  } finally {
    await handle.close().catch(() => {
      // The read result is already complete; closing a private read handle is best-effort.
    });
  }
}

function assertFileBudget(
  gitPath: string,
  size: number,
  limits: RequiredFingerprintOptions,
  budget: CaptureBudget,
): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new DuelWorkspaceIntegrityError("fileUnreadable", `File has an invalid size: ${gitPath}`, gitPath);
  }
  if (size > limits.maxFileBytes) {
    throw new DuelWorkspaceIntegrityError(
      "fileTooLarge",
      `File exceeds the ${limits.maxFileBytes}-byte limit: ${gitPath}`,
      gitPath,
    );
  }
  if (budget.fileBytes + size > limits.maxTotalFileBytes) {
    throw new DuelWorkspaceIntegrityError(
      "workspaceTooLarge",
      `Workspace files exceed the ${limits.maxTotalFileBytes}-byte limit.`,
      gitPath,
    );
  }
}

function sameFileIdentity(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function hashText(digest: Hash, domain: string, value: string): void {
  const domainBytes = Buffer.from(domain, "utf8");
  const valueBytes = Buffer.from(value, "utf8");
  const header = Buffer.allocUnsafe(12);
  header.writeUInt32BE(domainBytes.length, 0);
  header.writeBigUInt64BE(BigInt(valueBytes.length), 4);
  digest.update(header);
  digest.update(domainBytes);
  digest.update(valueBytes);
}

function unreadableError(filePath: string, error: unknown): DuelWorkspaceIntegrityError {
  const detail = isNodeError(error) && typeof error.code === "string" ? ` (${error.code})` : "";
  return new DuelWorkspaceIntegrityError(
    "fileUnreadable",
    `Could not safely read ${filePath}${detail}.`,
    filePath,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
