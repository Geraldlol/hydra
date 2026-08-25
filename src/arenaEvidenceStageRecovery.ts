import type { Dirent, Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  assertArenaPrivateDirectory,
  syncArenaDirectoryEntry,
  type ArenaPrivateStorageBoundary,
} from "./arenaPrivateStorage";

const MAX_EVIDENCE_STAGE_DIRECTORY_ENTRIES = 4_096;
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EVIDENCE_STAGE_SESSION_ID = randomUUID();
const ACTIVE_EVIDENCE_STAGES = new Set<string>();

export interface ArenaEvidenceStageReservation {
  readonly name: string;
}

export function reserveArenaEvidenceStageName(
  artifactName: string,
): ArenaEvidenceStageReservation {
  assertArtifactName(artifactName);
  if (ACTIVE_EVIDENCE_STAGES.size >= MAX_EVIDENCE_STAGE_DIRECTORY_ENTRIES) {
    throw new Error("Arena evidence has too many active staging files.");
  }
  const name = `.${artifactName}.${process.pid}-${EVIDENCE_STAGE_SESSION_ID}-${randomUUID()}.tmp`;
  ACTIVE_EVIDENCE_STAGES.add(evidenceStageReservationKey(name));
  return Object.freeze({ name });
}

export function releaseArenaEvidenceStageName(filePath: string): void {
  ACTIVE_EVIDENCE_STAGES.delete(evidenceStageReservationKey(filePath));
}

/**
 * Recover only Hydra-owned evidence stages from publishers that are definitely
 * gone. Live or ambiguous publishers fail closed; nlink=2 is accepted only
 * when the exact final artifact is the other name for the same inode.
 */
export async function recoverArenaEvidenceStageTemps(
  artifactDirectory: string,
  artifactNames: readonly string[],
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  if (artifactNames.length === 0) return;
  for (const name of artifactNames) assertArtifactName(name);
  await assertArenaPrivateDirectory(artifactDirectory, boundary);
  const directoryBefore = await fs.lstat(artifactDirectory);
  assertDirectory(directoryBefore, artifactDirectory);
  const patterns = artifactNames.map((artifactName) => ({
    artifactName,
    pattern: new RegExp(
      `^\\.${escapeRegExp(artifactName)}\\.([1-9][0-9]*)-(${UUID_PATTERN})(?:-(${UUID_PATTERN}))?\\.tmp$`,
      process.platform === "win32" ? "i" : "",
    ),
  }));
  const entries = await readBoundedDirectory(artifactDirectory);
  for (const entry of entries) {
    const matched = patterns
      .map((candidate) => ({
        ...candidate,
        match: candidate.pattern.exec(entry.name),
      }))
      .find((candidate) => candidate.match !== null);
    if (!matched) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(
        `Arena evidence stage is linked or invalid: ${entry.name}`,
      );
    }
    const publisherPid = Number(matched.match![1]);
    if (!Number.isSafeInteger(publisherPid)
      || publisherPid <= 0
      || publisherPid > 0x7fff_ffff) {
      throw new Error(
        `Arena evidence stage has an invalid publisher: ${entry.name}`,
      );
    }
    const publisherSessionId = matched.match![2]!;
    const hasSessionGeneration = matched.match![3] !== undefined;
    if (!isEvidenceStagePublisherDefinitelyInactive(
      entry.name,
      publisherPid,
      publisherSessionId,
      hasSessionGeneration,
    )) {
      throw new Error(
        `Arena evidence stage publisher may still be alive: ${entry.name}`,
      );
    }
    await assertSameDirectory(
      artifactDirectory,
      directoryBefore,
      boundary,
    );
    const stagePath = path.join(artifactDirectory, entry.name);
    const stage = await fs.lstat(stagePath);
    assertRegularStage(stage, stagePath);
    if (stage.nlink === 2) {
      const finalPath = path.join(
        artifactDirectory,
        matched.artifactName,
      );
      const final = await fs.lstat(finalPath);
      assertRegularStage(final, finalPath);
      if (final.nlink !== 2 || !sameFile(stage, final)) {
        throw new Error(
          `Arena evidence stage publication is ambiguous: ${entry.name}`,
        );
      }
    } else if (stage.nlink !== 1) {
      throw new Error(
        `Arena evidence stage has an unsafe link count: ${entry.name}`,
      );
    }
    await assertSameDirectory(
      artifactDirectory,
      directoryBefore,
      boundary,
    );
    const current = await fs.lstat(stagePath);
    if (!sameFile(stage, current) || current.nlink !== stage.nlink) {
      throw new Error(
        `Arena evidence stage changed during recovery: ${entry.name}`,
      );
    }
    await fs.unlink(stagePath);
    if (stage.nlink === 2) {
      const finalPath = path.join(
        artifactDirectory,
        matched.artifactName,
      );
      const normalized = await fs.lstat(finalPath);
      assertRegularStage(normalized, finalPath);
      if (normalized.nlink !== 1 || !sameFile(stage, normalized)) {
        throw new Error(
          `Arena evidence final changed during recovery: ${matched.artifactName}`,
        );
      }
    }
    // Make each individual recovery durable before inspecting a later entry
    // that may force the scan to fail closed.
    await syncArenaDirectoryEntry(
      artifactDirectory,
      directoryIdentity(directoryBefore),
      "Arena evidence artifact directory",
    );
  }
  await assertSameDirectory(
    artifactDirectory,
    directoryBefore,
    boundary,
  );
}

async function readBoundedDirectory(directoryPath: string): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  const directory = await fs.opendir(directoryPath);
  try {
    for await (const entry of directory) {
      if (entries.length >= MAX_EVIDENCE_STAGE_DIRECTORY_ENTRIES) {
        throw new Error(
          "Arena evidence artifact directory exceeds its recovery scan limit.",
        );
      }
      entries.push(entry);
    }
  } finally {
    await directory.close().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") {
        throw error;
      }
    });
  }
  return entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")));
}

async function assertSameDirectory(
  directoryPath: string,
  expected: Stats,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  await assertArenaPrivateDirectory(directoryPath, boundary);
  const current = await fs.lstat(directoryPath);
  assertDirectory(current, directoryPath);
  if (!sameFile(expected, current)) {
    throw new Error("Arena evidence artifact directory changed during recovery.");
  }
}

function assertArtifactName(name: string): void {
  if (!name
    || path.basename(name) !== name
    || name === "."
    || name === ".."
    || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error("Arena evidence recovery artifact name is invalid.");
  }
}

function assertDirectory(stat: Stats, directoryPath: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Arena evidence artifact directory is linked or invalid: ${directoryPath}`,
    );
  }
}

function assertRegularStage(stat: Stats, filePath: string): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Arena evidence stage is linked or invalid: ${filePath}`);
  }
  if (process.platform !== "win32"
    && ((stat.mode & 0o077) !== 0
      || (typeof process.getuid === "function"
        && stat.uid !== process.getuid()))) {
    throw new Error(
      `Arena evidence stage ownership or permissions are unsafe: ${filePath}`,
    );
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function directoryIdentity(stat: Stats): {
  readonly dev: string;
  readonly ino: string;
} {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function isProcessDefinitelyGone(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function isEvidenceStagePublisherDefinitelyInactive(
  stageName: string,
  publisherPid: number,
  publisherSessionId: string,
  hasSessionGeneration: boolean,
): boolean {
  if (publisherPid === process.pid) {
    if (!hasSessionGeneration) return false;
    if (normalizeEvidenceStageToken(publisherSessionId)
      !== normalizeEvidenceStageToken(EVIDENCE_STAGE_SESSION_ID)) {
      // This OS PID now belongs to this process, so a differently generated
      // Hydra session using the same PID is necessarily gone.
      return true;
    }
    return !ACTIVE_EVIDENCE_STAGES.has(evidenceStageReservationKey(stageName));
  }
  return isProcessDefinitelyGone(publisherPid);
}

function evidenceStageReservationKey(filePath: string): string {
  return normalizeEvidenceStageToken(path.basename(filePath));
}

function normalizeEvidenceStageToken(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
