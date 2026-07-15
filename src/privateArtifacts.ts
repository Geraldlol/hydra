import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface PrivateArtifactBoundary {
  logicalRoot: string;
  realRoot: string;
}

const MAX_PRIVATE_ARTIFACT_READ_BYTES = 32 * 1024 * 1024;

/**
 * Establish an extension-owned artifact boundary and its fixed child
 * directories. The resolved boundary must remain outside the workspace so a
 * repository watcher, backup, or accidental commit cannot capture prompts or
 * native replies.
 */
export async function preparePrivateArtifactRoot(
  workspaceRoot: string,
  artifactRoot: string,
  directories: readonly string[]
): Promise<PrivateArtifactBoundary> {
  const logicalWorkspace = path.resolve(workspaceRoot);
  const logicalRoot = path.resolve(artifactRoot);
  if (isPathWithin(logicalWorkspace, logicalRoot)) {
    throw new Error("Private artifact root must be outside the workspace.");
  }
  await fs.mkdir(logicalRoot, { recursive: true, mode: 0o700 });

  const rootStat = await fs.lstat(logicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Private artifact root must be a real directory, not a link.");
  }

  const [realWorkspace, realRoot] = await Promise.all([
    fs.realpath(logicalWorkspace),
    fs.realpath(logicalRoot),
  ]);
  if (isPathWithin(realWorkspace, realRoot)) {
    throw new Error("Private artifact root resolves inside the workspace.");
  }

  await fs.chmod(logicalRoot, 0o700).catch(() => undefined);
  for (const directory of directories) {
    if (!directory || path.isAbsolute(directory) || directory.split(/[\\/]/).includes("..")) {
      throw new Error(`Invalid private artifact directory: ${directory}`);
    }
    const child = path.join(logicalRoot, directory);
    await fs.mkdir(child, { recursive: true, mode: 0o700 });
    const childStat = await fs.lstat(child);
    if (!childStat.isDirectory() || childStat.isSymbolicLink()) {
      throw new Error(`Private artifact directory is linked or invalid: ${child}`);
    }
    const realChild = await fs.realpath(child);
    if (!isPathWithin(realRoot, realChild)) {
      throw new Error(`Private artifact directory escapes storage root: ${child}`);
    }
    await fs.chmod(child, 0o700).catch(() => undefined);
  }

  return { logicalRoot, realRoot };
}

/** Create a new private regular file without following an existing link. */
export async function createPrivateArtifact(
  filePath: string,
  content: string,
  boundary: PrivateArtifactBoundary
): Promise<void> {
  await assertArtifactParent(filePath, boundary);
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    // Revalidate after opening: a sibling process may have swapped the parent
    // between the first containment check and `open`. Path and handle identity
    // must both still resolve inside the extension-owned storage boundary.
    await assertArtifactParent(filePath, boundary);
    const realFile = await fs.realpath(filePath);
    if (!isPathWithin(boundary.realRoot, realFile)) {
      throw new Error(`Private artifact resolves outside storage root: ${filePath}`);
    }
    const [opened, entry] = await Promise.all([handle.stat(), fs.lstat(filePath)]);
    if (!opened.isFile() || opened.nlink !== 1 || entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
      throw new Error(`Refused a linked or non-regular private artifact: ${filePath}`);
    }
    if (opened.dev !== entry.dev || opened.ino !== entry.ino) {
      throw new Error(`Private artifact changed while it was created: ${filePath}`);
    }
    await handle.writeFile(content, "utf8");
    await handle.chmod(0o600).catch(() => undefined);
  } finally {
    await handle.close();
  }
}

/** Read a private UTF-8 artifact only when its on-disk byte size is bounded. */
export async function readPrivateArtifactUtf8(
  filePath: string,
  boundary: PrivateArtifactBoundary,
  maxBytes: number
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_PRIVATE_ARTIFACT_READ_BYTES) {
    throw new Error(`Private artifact read limit must be between 0 and ${MAX_PRIVATE_ARTIFACT_READ_BYTES} bytes.`);
  }
  await assertArtifactParent(filePath, boundary);
  const before = await fs.lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error(`Refused to read a linked or non-regular private artifact: ${filePath}`);
  }
  assertSizeLimit(before.size, maxBytes);

  const realFile = await fs.realpath(filePath);
  if (!isPathWithin(boundary.realRoot, realFile)) {
    throw new Error(`Private artifact resolves outside storage root: ${filePath}`);
  }

  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Private artifact changed while it was read: ${filePath}`);
    }
    assertSizeLimit(opened.size, maxBytes);
    return (await readHandleAtMost(handle, maxBytes)).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Best-effort cleanup for ephemeral request files. Paths outside the declared
 * boundary are ignored, and cleanup never follows a file symlink.
 */
export async function cleanupPrivateArtifacts(
  filePaths: readonly string[],
  boundary: PrivateArtifactBoundary
): Promise<void> {
  await Promise.all(filePaths.map(async (filePath) => {
    const absolute = path.resolve(filePath);
    if (!isPathWithin(boundary.logicalRoot, absolute) || absolute === boundary.logicalRoot) return;
    try {
      await assertArtifactParent(absolute, boundary);
      const stat = await fs.lstat(absolute);
      if (stat.isDirectory()) return;
      await fs.unlink(absolute);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // Request cleanup must never mask the agent result. A later storage
        // sweep can retry files held open by antivirus/indexers on Windows.
      }
    }
  }));
}

/** Remove abandoned regular request files older than the supplied cutoff. */
export async function sweepPrivateArtifacts(
  boundary: PrivateArtifactBoundary,
  directories: readonly string[],
  olderThanMs: number,
  nowMs = Date.now()
): Promise<void> {
  if (!Number.isFinite(olderThanMs) || olderThanMs < 0) return;
  for (const directory of directories) {
    const child = path.join(boundary.logicalRoot, directory);
    try {
      await assertArtifactDirectory(child, boundary);
      const entries = await fs.readdir(child, { withFileTypes: true });
      await Promise.all(entries.map(async (entry) => {
        if (!entry.isFile() && !entry.isSymbolicLink()) return;
        const filePath = path.join(child, entry.name);
        try {
          const stat = await fs.lstat(filePath);
          if (nowMs - stat.mtimeMs < olderThanMs) return;
          await fs.unlink(filePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            // Best effort: active/locked files remain for the next sweep.
          }
        }
      }));
    } catch {
      // A malformed child is rejected by normal request preparation; sweeping
      // it is intentionally non-destructive.
    }
  }
}

/** Replace private absolute paths before argv is written to durable traces. */
export function redactPrivateArtifactArgs(
  args: readonly string[],
  artifactPaths: readonly string[]
): string[] {
  return args.map((arg) => redactPrivateArtifactText(arg, artifactPaths));
}

/** Replace private paths in text that may be copied to durable diagnostics. */
export function redactPrivateArtifactText(value: string, artifactPaths: readonly string[]): string {
  const replacements = artifactPaths
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map((filePath) => ({
      filePath,
      label: `[private extension storage]/${path.basename(filePath)}`,
    }));
  let redacted = value;
  for (const replacement of replacements) {
    redacted = redacted.split(replacement.filePath).join(replacement.label);
  }
  return redacted;
}

async function assertArtifactDirectory(directory: string, boundary: PrivateArtifactBoundary): Promise<void> {
  const absolute = path.resolve(directory);
  if (!isPathWithin(boundary.logicalRoot, absolute) || absolute === boundary.logicalRoot) {
    throw new Error(`Private artifact directory escapes storage root: ${directory}`);
  }
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Private artifact directory is linked or invalid: ${directory}`);
  }
  const realDirectory = await fs.realpath(absolute);
  if (!isPathWithin(boundary.realRoot, realDirectory)) {
    throw new Error(`Private artifact directory escapes storage root: ${directory}`);
  }
}

async function assertArtifactParent(filePath: string, boundary: PrivateArtifactBoundary): Promise<void> {
  const absolute = path.resolve(filePath);
  if (!isPathWithin(boundary.logicalRoot, absolute) || absolute === boundary.logicalRoot) {
    throw new Error(`Private artifact path escapes storage root: ${filePath}`);
  }
  await assertArtifactDirectory(path.dirname(absolute), boundary);
}

function assertSizeLimit(size: number, maxBytes: number): void {
  if (size > maxBytes) {
    throw new Error(`Private artifact exceeded the ${maxBytes}-byte read limit.`);
  }
}

async function readHandleAtMost(handle: fs.FileHandle, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  assertSizeLimit(offset, maxBytes);
  return buffer.subarray(0, offset);
}

function isPathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
