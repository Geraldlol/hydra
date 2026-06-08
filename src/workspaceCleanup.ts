import * as fs from "node:fs/promises";
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
  const dir = path.join(workspaceRoot, target.relativeDir);
  const targetSummary: DiagnosticArtifactTargetSummary = {
    label: target.label,
    relativeDir: target.relativeDir.replace(/\\/g, "/"),
    scannedFiles: 0,
    deletedFiles: 0,
    deletedBytes: 0,
    failedDeletes: 0,
    missing: false,
  };

  // Why: a workspace can ship `.hydra/<subdir>` as a symlink that escapes
  // out of the workspace (e.g. `.hydra/replies -> ~/.config`). fs.readdir
  // follows symlinks on the path argument, so without this lstat guard the
  // cleanup would unlink user files outside the workspace. Mirrors the
  // symlink-refusal discipline in fileQueue.ts:refuseSymlink.
  let dirStat: import("node:fs").Stats;
  try {
    dirStat = await fs.lstat(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      targetSummary.missing = true;
      return targetSummary;
    }
    throw err;
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    targetSummary.failedDeletes++;
    return targetSummary;
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      targetSummary.missing = true;
      return targetSummary;
    }
    throw err;
  }

  for (const entry of entries) {
    await pruneDiagnosticEntry(dir, entry, target, cutoffMs, targetSummary);
  }

  return targetSummary;
}

async function pruneDiagnosticEntry(
  parentDir: string,
  entry: import("node:fs").Dirent,
  target: DiagnosticTarget,
  cutoffMs: number,
  targetSummary: DiagnosticArtifactTargetSummary
): Promise<void> {
  if (target.keepFileNames?.has(entry.name)) return;
  const entryPath = path.join(parentDir, entry.name);

  if (target.recursive && entry.isDirectory()) {
    let children: import("node:fs").Dirent[];
    try {
      children = await fs.readdir(entryPath, { withFileTypes: true });
    } catch {
      // Directory disappeared or became unreadable during best-effort cleanup.
      targetSummary.failedDeletes++;
      return;
    }
    for (const child of children) {
      await pruneDiagnosticEntry(entryPath, child, target, cutoffMs, targetSummary);
    }
    try {
      await fs.rmdir(entryPath);
    } catch {
      // Non-empty or locked attachment directories can be retried by a later cleanup.
    }
    return;
  }

  if (!entry.isFile()) return;
  targetSummary.scannedFiles++;
  let stats: import("node:fs").Stats;
  try {
    stats = await fs.stat(entryPath);
  } catch {
    // File disappeared between readdir and stat; another cleanup already handled it.
    targetSummary.failedDeletes++;
    return;
  }
  if (stats.mtimeMs > cutoffMs) return;
  try {
    await fs.unlink(entryPath);
    targetSummary.deletedFiles++;
    targetSummary.deletedBytes += stats.size;
  } catch {
    // Best-effort diagnostics cleanup should not block the room if a file is locked.
    targetSummary.failedDeletes++;
  }
}
