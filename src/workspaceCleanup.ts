import * as fs from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
import * as path from "node:path";
import {
  compactPromptEnvelopeBodies,
  type PromptBodyCompactionSummary,
} from "./promptPreview";

export interface WorkspaceCleanupOptions {
  promptBodyRetentionDays: number;
  diagnosticRetentionDays: number;
  now?: Date;
}

export interface WorkspaceCleanupSummary {
  promptBodies: PromptBodyCompactionSummary;
  diagnostics: DiagnosticArtifactPruneSummary;
}

export interface DiagnosticArtifactPruneSummary {
  retentionDays: number;
  cutoffIso: string;
  scannedFiles: number;
  deletedFiles: number;
  deletedBytes: number;
  failedDeletes: number;
  missingDirs: number;
  targets: DiagnosticArtifactTargetSummary[];
}

export interface DiagnosticArtifactTargetSummary {
  label: string;
  relativeDir: string;
  scannedFiles: number;
  deletedFiles: number;
  deletedBytes: number;
  failedDeletes: number;
  missing: boolean;
}

interface DiagnosticTarget {
  label: string;
  relativeDir: string;
  keepFileNames?: Set<string>;
  recursive?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const DIAGNOSTIC_TARGETS: DiagnosticTarget[] = [
  {
    label: "terminal request prompts",
    relativeDir: path.join(".hydra", "prompts"),
    keepFileNames: new Set(["index.jsonl"]),
  },
  { label: "terminal replies", relativeDir: path.join(".hydra", "replies") },
  { label: "terminal logs", relativeDir: path.join(".hydra", "logs") },
  { label: "terminal dispatch scripts", relativeDir: path.join(".hydra", "dispatch") },
  { label: "room attachments", relativeDir: path.join(".hydra", "attachments"), recursive: true },
  { label: "live agent channels", relativeDir: path.join(".hydra", "live"), recursive: true },
];

export async function cleanWorkspaceState(
  workspaceRoot: string,
  options: WorkspaceCleanupOptions
): Promise<WorkspaceCleanupSummary> {
  const now = options.now ?? new Date();
  const promptBodies = await compactPromptEnvelopeBodies(workspaceRoot, {
    retentionDays: options.promptBodyRetentionDays,
    now,
  });
  const diagnostics = await pruneDiagnosticArtifacts(workspaceRoot, {
    retentionDays: options.diagnosticRetentionDays,
    now,
  });
  return { promptBodies, diagnostics };
}

export interface PruneDiagnosticArtifactsOptions {
  retentionDays: number;
  now?: Date;
}

export async function pruneDiagnosticArtifacts(
  workspaceRoot: string,
  options: PruneDiagnosticArtifactsOptions
): Promise<DiagnosticArtifactPruneSummary> {
  const now = options.now ?? new Date();
  const retentionDays = Number.isFinite(options.retentionDays) ? Math.max(0, Math.floor(options.retentionDays)) : 7;
  const cutoffMs = now.getTime() - retentionDays * DAY_MS;
  const summary: DiagnosticArtifactPruneSummary = {
    retentionDays,
    cutoffIso: new Date(cutoffMs).toISOString(),
    scannedFiles: 0,
    deletedFiles: 0,
    deletedBytes: 0,
    failedDeletes: 0,
    missingDirs: 0,
    targets: [],
  };

  for (const target of DIAGNOSTIC_TARGETS) {
    const targetSummary = await pruneDiagnosticTarget(workspaceRoot, target, cutoffMs);
    summary.targets.push(targetSummary);
    summary.scannedFiles += targetSummary.scannedFiles;
    summary.deletedFiles += targetSummary.deletedFiles;
    summary.deletedBytes += targetSummary.deletedBytes;
    summary.failedDeletes += targetSummary.failedDeletes;
    if (targetSummary.missing) summary.missingDirs++;
  }

  return summary;
}

async function pruneDiagnosticTarget(
  workspaceRoot: string,
  target: DiagnosticTarget,
  cutoffMs: number
): Promise<DiagnosticArtifactTargetSummary> {
  const targetSummary: DiagnosticArtifactTargetSummary = {
    label: target.label,
    relativeDir: target.relativeDir.replace(/\\/g, "/"),
    scannedFiles: 0,
    deletedFiles: 0,
    deletedBytes: 0,
    failedDeletes: 0,
    missing: false,
  };

  let boundary: DiagnosticPruneBoundary | undefined;
  try {
    boundary = await establishDiagnosticPruneBoundary(workspaceRoot, target.relativeDir);
  } catch (err) {
    if (!(err instanceof UnsafeDiagnosticCleanupPathError)) throw err;
    targetSummary.failedDeletes++;
    return targetSummary;
  }
  if (!boundary) {
    targetSummary.missing = true;
    return targetSummary;
  }

  let entries: import("node:fs").Dirent[];
  try {
    await assertDiagnosticPruneBoundary(boundary);
    entries = await fs.readdir(boundary.logicalTargetRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // The target existed when the boundary was established. Disappearing
      // now is a replacement race rather than an initially missing target.
      targetSummary.failedDeletes++;
      return targetSummary;
    }
    if (err instanceof UnsafeDiagnosticCleanupPathError) {
      targetSummary.failedDeletes++;
      return targetSummary;
    }
    throw err;
  }

  for (const entry of entries) {
    await pruneDiagnosticEntry(boundary, [], entry, target, cutoffMs, targetSummary);
  }

  return targetSummary;
}

async function pruneDiagnosticEntry(
  boundary: DiagnosticPruneBoundary,
  nestedDirectories: CleanupDirectoryIdentity[],
  entry: import("node:fs").Dirent,
  target: DiagnosticTarget,
  cutoffMs: number,
  targetSummary: DiagnosticArtifactTargetSummary
): Promise<void> {
  if (target.keepFileNames?.has(entry.name)) return;
  if (!isSafeDirectoryEntryName(entry.name)) {
    targetSummary.failedDeletes++;
    return;
  }

  if (target.recursive && entry.isDirectory()) {
    let childDirectory: CleanupDirectoryIdentity;
    try {
      childDirectory = await establishSafeNestedDirectory(boundary, nestedDirectories, entry.name);
    } catch {
      targetSummary.failedDeletes++;
      return;
    }
    let children: import("node:fs").Dirent[];
    try {
      const childChain = [...nestedDirectories, childDirectory];
      await assertSafeDiagnosticDirectoryChain(boundary, childChain);
      children = await fs.readdir(childDirectory.logicalPath, { withFileTypes: true });
      for (const child of children) {
        await pruneDiagnosticEntry(boundary, childChain, child, target, cutoffMs, targetSummary);
      }
      await removeSafeEmptyDiagnosticDirectory(boundary, childChain);
    } catch {
      // A directory that disappears, is replaced, or becomes unreadable is
      // left for a future cleanup. Never follow its replacement.
      targetSummary.failedDeletes++;
    }
    return;
  }

  if (entry.isSymbolicLink()) {
    targetSummary.failedDeletes++;
    return;
  }
  if (!entry.isFile()) return;
  targetSummary.scannedFiles++;
  try {
    const result = await unlinkSafeDiagnosticFile(boundary, nestedDirectories, entry.name, cutoffMs);
    if (result.kind === "deleted") {
      targetSummary.deletedFiles++;
      targetSummary.deletedBytes += result.bytes;
    } else if (result.kind === "refused") {
      targetSummary.failedDeletes++;
    }
  } catch {
    // Best-effort diagnostics cleanup should not block the room if a file is
    // locked, disappears, or fails a safety revalidation.
    targetSummary.failedDeletes++;
  }
}

interface CleanupDirectoryIdentity {
  logicalPath: string;
  realPath: string;
  dev: number;
  ino: number;
}

interface DiagnosticPruneBoundary {
  logicalWorkspaceRoot: string;
  realWorkspaceRoot: string;
  workspaceDev: number;
  workspaceIno: number;
  logicalTargetRoot: string;
  realTargetRoot: string;
  parents: CleanupDirectoryIdentity[];
}

type DiagnosticUnlinkResult =
  | { kind: "deleted"; bytes: number }
  | { kind: "kept" }
  | { kind: "refused" };

class UnsafeDiagnosticCleanupPathError extends Error {}

async function establishDiagnosticPruneBoundary(
  workspaceRoot: string,
  relativeDir: string
): Promise<DiagnosticPruneBoundary | undefined> {
  const logicalWorkspaceRoot = path.resolve(workspaceRoot);
  const logicalTargetRoot = path.resolve(logicalWorkspaceRoot, relativeDir);
  if (
    samePath(logicalWorkspaceRoot, logicalTargetRoot)
    || !isPathWithin(logicalWorkspaceRoot, logicalTargetRoot)
  ) {
    throw unsafeDiagnosticCleanupPath(logicalTargetRoot);
  }

  let realWorkspaceRoot: string;
  let workspaceStats: Stats;
  try {
    realWorkspaceRoot = await fs.realpath(logicalWorkspaceRoot);
    workspaceStats = await fs.stat(realWorkspaceRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  if (!workspaceStats.isDirectory()) throw unsafeDiagnosticCleanupPath(logicalWorkspaceRoot);

  const segments = path.normalize(relativeDir).split(path.sep).filter(Boolean);
  const expectedRealTarget = path.resolve(realWorkspaceRoot, ...segments);
  if (
    samePath(realWorkspaceRoot, expectedRealTarget)
    || !isPathWithin(realWorkspaceRoot, expectedRealTarget)
  ) {
    throw unsafeDiagnosticCleanupPath(expectedRealTarget);
  }

  const parents: CleanupDirectoryIdentity[] = [];
  let logicalParent = logicalWorkspaceRoot;
  let expectedRealParent = realWorkspaceRoot;
  for (const segment of segments) {
    logicalParent = path.join(logicalParent, segment);
    expectedRealParent = path.join(expectedRealParent, segment);
    let identity: CleanupDirectoryIdentity;
    try {
      identity = await inspectStableDirectory(logicalParent, expectedRealParent, realWorkspaceRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    parents.push(identity);
  }

  const realTargetRoot = parents.at(-1)?.realPath;
  if (!realTargetRoot) throw unsafeDiagnosticCleanupPath(logicalTargetRoot);
  return {
    logicalWorkspaceRoot,
    realWorkspaceRoot,
    workspaceDev: workspaceStats.dev,
    workspaceIno: workspaceStats.ino,
    logicalTargetRoot,
    realTargetRoot,
    parents,
  };
}

async function assertDiagnosticPruneBoundary(boundary: DiagnosticPruneBoundary): Promise<void> {
  let realWorkspaceRoot: string;
  let workspaceStats: Stats;
  try {
    realWorkspaceRoot = await fs.realpath(boundary.logicalWorkspaceRoot);
    workspaceStats = await fs.stat(realWorkspaceRoot);
  } catch {
    throw unsafeDiagnosticCleanupPath(boundary.logicalWorkspaceRoot);
  }
  if (
    !workspaceStats.isDirectory()
    || workspaceStats.dev !== boundary.workspaceDev
    || workspaceStats.ino !== boundary.workspaceIno
    || !samePath(realWorkspaceRoot, boundary.realWorkspaceRoot)
  ) {
    throw unsafeDiagnosticCleanupPath(boundary.logicalWorkspaceRoot);
  }

  for (const expected of boundary.parents) {
    let current: CleanupDirectoryIdentity;
    try {
      current = await inspectStableDirectory(
        expected.logicalPath,
        expected.realPath,
        boundary.realWorkspaceRoot
      );
    } catch {
      throw unsafeDiagnosticCleanupPath(expected.logicalPath);
    }
    if (!sameDirectoryIdentity(current, expected)) {
      throw unsafeDiagnosticCleanupPath(expected.logicalPath);
    }
  }
}

async function assertSafeDiagnosticDirectoryChain(
  boundary: DiagnosticPruneBoundary,
  nestedDirectories: CleanupDirectoryIdentity[]
): Promise<void> {
  await assertDiagnosticPruneBoundary(boundary);
  for (const expected of nestedDirectories) {
    let current: CleanupDirectoryIdentity;
    try {
      current = await inspectStableDirectory(
        expected.logicalPath,
        expected.realPath,
        boundary.realWorkspaceRoot
      );
    } catch {
      throw unsafeDiagnosticCleanupPath(expected.logicalPath);
    }
    if (
      !sameDirectoryIdentity(current, expected)
      || !isPathWithin(boundary.realTargetRoot, current.realPath)
    ) {
      throw unsafeDiagnosticCleanupPath(expected.logicalPath);
    }
  }
}

async function establishSafeNestedDirectory(
  boundary: DiagnosticPruneBoundary,
  nestedDirectories: CleanupDirectoryIdentity[],
  entryName: string
): Promise<CleanupDirectoryIdentity> {
  await assertSafeDiagnosticDirectoryChain(boundary, nestedDirectories);
  const parent = nestedDirectories.at(-1) ?? boundary.parents.at(-1);
  if (!parent) throw unsafeDiagnosticCleanupPath(boundary.logicalTargetRoot);
  const logicalPath = path.resolve(parent.logicalPath, entryName);
  const expectedRealPath = path.resolve(parent.realPath, entryName);
  if (
    !isPathWithin(boundary.logicalTargetRoot, logicalPath)
    || !isPathWithin(boundary.realTargetRoot, expectedRealPath)
  ) {
    throw unsafeDiagnosticCleanupPath(logicalPath);
  }

  const identity = await inspectStableDirectory(logicalPath, expectedRealPath, boundary.realWorkspaceRoot);
  await assertSafeDiagnosticDirectoryChain(boundary, nestedDirectories);
  const confirmed = await inspectStableDirectory(logicalPath, expectedRealPath, boundary.realWorkspaceRoot);
  if (!sameDirectoryIdentity(identity, confirmed)) throw unsafeDiagnosticCleanupPath(logicalPath);
  return identity;
}

async function removeSafeEmptyDiagnosticDirectory(
  boundary: DiagnosticPruneBoundary,
  directoryChain: CleanupDirectoryIdentity[]
): Promise<void> {
  const directory = directoryChain.at(-1);
  if (!directory) return;
  await assertSafeDiagnosticDirectoryChain(boundary, directoryChain);
  const remaining = await fs.readdir(directory.logicalPath);
  if (remaining.length > 0) return;
  await assertSafeDiagnosticDirectoryChain(boundary, directoryChain);
  await fs.rmdir(directory.logicalPath);
}

async function unlinkSafeDiagnosticFile(
  boundary: DiagnosticPruneBoundary,
  nestedDirectories: CleanupDirectoryIdentity[],
  entryName: string,
  cutoffMs: number
): Promise<DiagnosticUnlinkResult> {
  await assertSafeDiagnosticDirectoryChain(boundary, nestedDirectories);
  const parent = nestedDirectories.at(-1) ?? boundary.parents.at(-1);
  if (!parent) return { kind: "refused" };
  const filePath = path.resolve(parent.logicalPath, entryName);
  const expectedRealPath = path.resolve(parent.realPath, entryName);
  if (
    !isPathWithin(boundary.logicalTargetRoot, filePath)
    || !isPathWithin(boundary.realTargetRoot, expectedRealPath)
  ) {
    return { kind: "refused" };
  }

  let before: Stats;
  let beforeRealPath: string;
  try {
    before = await fs.lstat(filePath);
    beforeRealPath = await fs.realpath(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "refused" };
    throw err;
  }
  if (
    !isSafeDiagnosticFile(before)
    || !samePath(beforeRealPath, expectedRealPath)
    || !isPathWithin(boundary.realTargetRoot, beforeRealPath)
    || !isPathWithin(boundary.realWorkspaceRoot, beforeRealPath)
  ) {
    return { kind: "refused" };
  }
  if (before.mtimeMs > cutoffMs) return { kind: "kept" };

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return { kind: "refused" };
    throw err;
  }

  try {
    const opened = await handle.stat();
    if (!isSafeDiagnosticFile(opened) || !sameStableFile(before, opened)) {
      return { kind: "refused" };
    }

    // Hold the candidate open while revalidating every parent and the final
    // pathname. A symlink/junction or rename introduced after readdir must not
    // redirect the subsequent unlink outside the original workspace tree.
    await assertSafeDiagnosticDirectoryChain(boundary, nestedDirectories);
    let current: Stats;
    let currentRealPath: string;
    try {
      current = await fs.lstat(filePath);
      currentRealPath = await fs.realpath(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "refused" };
      throw err;
    }
    if (
      !isSafeDiagnosticFile(current)
      || !sameStableFile(opened, current)
      || !samePath(currentRealPath, expectedRealPath)
      || !isPathWithin(boundary.realTargetRoot, currentRealPath)
    ) {
      return { kind: "refused" };
    }

    await assertSafeDiagnosticDirectoryChain(boundary, nestedDirectories);
    const openedBeforeUnlink = await handle.stat();
    const pathBeforeUnlink = await fs.lstat(filePath);
    const realPathBeforeUnlink = await fs.realpath(filePath);
    if (
      !isSafeDiagnosticFile(openedBeforeUnlink)
      || !isSafeDiagnosticFile(pathBeforeUnlink)
      || !sameStableFile(opened, openedBeforeUnlink)
      || !sameStableFile(openedBeforeUnlink, pathBeforeUnlink)
      || !samePath(realPathBeforeUnlink, expectedRealPath)
      || !isPathWithin(boundary.realTargetRoot, realPathBeforeUnlink)
    ) {
      return { kind: "refused" };
    }
    await assertSafeDiagnosticDirectoryChain(boundary, nestedDirectories);
    await fs.unlink(filePath);
    return { kind: "deleted", bytes: opened.size };
  } finally {
    await handle.close();
  }
}

async function inspectStableDirectory(
  logicalPath: string,
  expectedRealPath: string,
  realWorkspaceRoot: string
): Promise<CleanupDirectoryIdentity> {
  const before = await fs.lstat(logicalPath);
  if (before.isSymbolicLink() || !before.isDirectory()) throw unsafeDiagnosticCleanupPath(logicalPath);
  const realPath = await fs.realpath(logicalPath);
  const after = await fs.lstat(logicalPath);
  const realStats = await fs.stat(realPath);
  if (
    after.isSymbolicLink()
    || !after.isDirectory()
    || !realStats.isDirectory()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || after.dev !== realStats.dev
    || after.ino !== realStats.ino
    || !samePath(realPath, expectedRealPath)
    || !isPathWithin(realWorkspaceRoot, realPath)
  ) {
    throw unsafeDiagnosticCleanupPath(logicalPath);
  }
  return { logicalPath, realPath, dev: after.dev, ino: after.ino };
}

function isSafeDiagnosticFile(stats: Stats): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1;
}

function sameStableFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameDirectoryIdentity(left: CleanupDirectoryIdentity, right: CleanupDirectoryIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && samePath(left.logicalPath, right.logicalPath)
    && samePath(left.realPath, right.realPath);
}

function isSafeDirectoryEntryName(entryName: string): boolean {
  return entryName.length > 0
    && entryName !== "."
    && entryName !== ".."
    && path.basename(entryName) === entryName
    && !entryName.includes("/")
    && !entryName.includes("\\");
}

function unsafeDiagnosticCleanupPath(filePath: string): UnsafeDiagnosticCleanupPathError {
  return new UnsafeDiagnosticCleanupPathError(
    `Refusing diagnostic cleanup through a linked, replaced, or external path: ${filePath}`
  );
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isPathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
  const normalizedCandidate = process.platform === "win32"
    ? path.resolve(candidate).toLowerCase()
    : path.resolve(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
