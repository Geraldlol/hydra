import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import {
  assertArenaPrivateDirectory,
  assertArenaPrivateParent,
  createArenaPrivateFile,
  ensureArenaPrivateDirectory,
  prepareArenaPrivateStorage,
  readArenaPrivateFile,
  serializeArenaPrivateWork,
  syncArenaDirectoryEntry,
  type ArenaDirectoryIdentity,
  type ArenaPrivateStorageBoundary,
} from "./arenaPrivateStorage";
import type { ArenaStagedEvidenceFile } from "./arenaGit";
import {
  recoverArenaEvidenceStageTemps,
  releaseArenaEvidenceStageName,
  reserveArenaEvidenceStageName,
} from "./arenaEvidenceStageRecovery";
import { arenaContestantArtifactPath } from "./arenaStore";
import {
  arenaArtifactSetSha256,
  canonicalArenaManifestJson,
  type ArenaEvidencePreservedPayload,
  type ArenaGitObjectId,
} from "./arenaRunManifest";

const MAX_UNTRACKED_PATH_BYTES = 4_096;
const MAX_UNTRACKED_PATHS = 10_000;
const MAX_UNTRACKED_PATH_LIST_BYTES = 16 * 1024 * 1024;
const MAX_ARENA_PATCH_BYTES = 64 * 1024 * 1024;
const MAX_UNTRACKED_ARCHIVE_BYTES = 64 * 1024 * 1024;
// Safe Git paths exclude control bytes, so JSON escaping can at most double
// the bounded path listing. This leaves ample room for 10,000 fixed records.
const MAX_UNTRACKED_INVENTORY_BYTES = 64 * 1024 * 1024;
const MAX_UNTRACKED_PARENT_DEPTH = 64;
const MAX_UNTRACKED_PARENT_COMPONENT_CHECKS = 200_000;
const ARCHIVE_MAGIC = Buffer.from("HYDRA-ARENA-UNTRACKED-V2\0", "ascii");
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface ArenaEvidenceCaptureInput {
  readonly privateWorkspaceRoot: string;
  readonly runId: string;
  readonly contestantId: string;
  readonly worktreePath: string;
  readonly patch: ArenaStagedEvidenceFile;
  readonly untrackedPaths: ArenaStagedEvidenceFile;
  readonly receiptsRootSha256: string;
  readonly quiescenceReceiptSha256: string | null;
  readonly quiescenceWorkspaceFingerprintSha256: string | null;
  readonly finalHead: ArenaGitObjectId;
  readonly finalWorkspaceFingerprintSha256: string;
  /**
   * Revalidate the worktree and its mutation sentinel after all worktree
   * bytes are staged but before any authoritative artifact name is published.
   */
  readonly confirmSnapshotBeforePublication: () => Promise<void>;
  /**
   * Revalidate again after the immutable artifact-set receipt is durable.
   * A rejection leaves the coherent private artifact set available for
   * recovery, but prevents the controller from granting manifest authority.
   */
  readonly confirmSnapshotAfterPublication: () => Promise<void>;
}

export interface ArenaEvidenceCaptureResult {
  readonly payload: ArenaEvidencePreservedPayload;
  readonly artifactDirectory: string;
}

export interface ArenaArtifactSetVerificationInput {
  readonly privateWorkspaceRoot: string;
  readonly runId: string;
  readonly contestantId: string;
  readonly payload: ArenaEvidencePreservedPayload;
}

interface UntrackedEntry {
  readonly gitPath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mode: number;
}

interface ParentDirectorySnapshot {
  readonly path: string;
  readonly stat: Stats;
}

interface ArenaArtifactGeneration {
  readonly inventoryName: "inventory.v1.json" | "inventory.v2.json";
  readonly archiveName: "untracked.v1.bin" | "untracked.v2.bin";
}

interface RetainedVerifiedEvidenceFile {
  readonly filePath: string;
  readonly label: string;
  readonly handle: fs.FileHandle;
  readonly snapshot: Stats;
}

/**
 * Copies comparison artifacts out of the disposable worktree and publishes an
 * immutable artifact-set receipt last. Untracked entries are opened no-follow,
 * must have one link, and are identity-checked before and after every read.
 */
export async function preserveArenaEvidence(
  input: ArenaEvidenceCaptureInput,
): Promise<ArenaEvidenceCaptureResult> {
  assertStagedEvidenceFile(input.patch, "patch");
  assertStagedEvidenceFile(input.untrackedPaths, "untracked path listing");

  try {
    return await preserveReservedArenaEvidence(input);
  } finally {
    // Calling preservation transfers both reservations to this operation.
    // Release them even when private-boundary/path setup fails before the
    // cleanup-capable portion starts; any surviving stages are then eligible
    // for strict same-session recovery rather than remaining live forever.
    releaseArenaEvidenceStageName(input.patch.path);
    releaseArenaEvidenceStageName(input.untrackedPaths.path);
  }
}

async function preserveReservedArenaEvidence(
  input: ArenaEvidenceCaptureInput,
): Promise<ArenaEvidenceCaptureResult> {
  const boundary = await prepareArenaPrivateStorage(
    input.privateWorkspaceRoot,
  );
  const artifactDirectory = arenaContestantArtifactPath(
    input.privateWorkspaceRoot,
    input.runId,
    input.contestantId,
  );
  await ensureArenaPrivateDirectory(
    boundary,
    ["artifacts", input.runId, input.contestantId],
  );
  await assertArenaPrivateDirectory(artifactDirectory, boundary);

  assertExpectedStagePath(input.patch.path, artifactDirectory, "patch.bin");
  assertExpectedStagePath(
    input.untrackedPaths.path,
    artifactDirectory,
    "untracked-paths.v1.bin",
  );
  let archiveForCleanup: ArenaStagedEvidenceFile | null = null;
  try {
    assertDigest(input.receiptsRootSha256, "receipts root");
    if ((input.quiescenceReceiptSha256 === null)
        !== (input.quiescenceWorkspaceFingerprintSha256 === null)) {
      throw new Error(
        "Arena quiescence receipt and fingerprint must both be present or absent.",
      );
    }
    if (input.quiescenceReceiptSha256 !== null) {
      assertDigest(input.quiescenceReceiptSha256, "quiescence receipt");
      assertDigest(
        input.quiescenceWorkspaceFingerprintSha256!,
        "quiescence fingerprint",
      );
    }
    assertDigest(input.finalWorkspaceFingerprintSha256, "final fingerprint");
    if (input.quiescenceWorkspaceFingerprintSha256 !== null
      && input.quiescenceWorkspaceFingerprintSha256
        !== input.finalWorkspaceFingerprintSha256) {
      throw new Error(
        "Arena evidence requires quiescence and final fingerprints to match.",
      );
    }
    if (input.patch.bytes > MAX_ARENA_PATCH_BYTES) {
      throw new Error("Arena patch exceeds its byte limit.");
    }
    if (input.untrackedPaths.bytes > MAX_UNTRACKED_PATH_LIST_BYTES) {
      throw new Error("Arena untracked path listing exceeds its byte limit.");
    }
    if (typeof input.confirmSnapshotBeforePublication !== "function") {
      throw new Error("Arena evidence requires a snapshot confirmation gate.");
    }
    if (typeof input.confirmSnapshotAfterPublication !== "function") {
      throw new Error(
        "Arena evidence requires a post-publication snapshot confirmation gate.",
      );
    }
    assertObjectId(input.finalHead);
    const pathsZ = await readAndVerifyStagedFile(
      input.untrackedPaths,
      MAX_UNTRACKED_PATH_LIST_BYTES,
      boundary,
    );
    await discardStagedFile(input.untrackedPaths, boundary);
    const capturedUntracked = await captureUntrackedEntries(
      input.worktreePath,
      pathsZ,
      artifactDirectory,
      boundary,
    );
    const entries = capturedUntracked.entries;
    const inventory = Buffer.from(`${canonicalArenaManifestJson({
      schemaVersion: 2,
      entries: entries.map((entry) => ({
        path: entry.gitPath,
        bytes: entry.bytes,
        mode: entry.mode,
        sha256: entry.sha256,
      })),
    })}\n`, "utf8");
    if (inventory.byteLength > MAX_UNTRACKED_INVENTORY_BYTES) {
      throw new Error("Arena untracked inventory exceeds its byte limit.");
    }
    const archive = capturedUntracked.archive;
    archiveForCleanup = archive;
    const patchSha256 = input.patch.sha256;
    const inventorySha256 = digest(inventory);
    const archiveSha256 = archive?.sha256 ?? null;
    const withoutArtifactSet = {
      payloadType: "evidencePreserved",
      contestantId: input.contestantId,
      receiptsRootSha256: input.receiptsRootSha256,
      patchSha256,
      patchBytes: input.patch.bytes,
      untrackedArchiveSha256: archiveSha256,
      untrackedArchiveBytes: archive?.bytes ?? 0,
      inventorySha256,
      quiescenceReceiptSha256: input.quiescenceReceiptSha256,
      quiescenceWorkspaceFingerprintSha256:
        input.quiescenceWorkspaceFingerprintSha256,
      finalHead: input.finalHead,
      finalWorkspaceFingerprintSha256:
        input.finalWorkspaceFingerprintSha256,
    } satisfies Omit<ArenaEvidencePreservedPayload, "artifactSetSha256">;
    const payload: ArenaEvidencePreservedPayload = Object.freeze({
      ...withoutArtifactSet,
      artifactSetSha256: arenaArtifactSetSha256(withoutArtifactSet),
    });
    const receipt = Buffer.from(`${canonicalArenaManifestJson({
      schemaVersion: 1,
      recordType: "arenaArtifactSet",
      payload,
    })}\n`, "utf8");
    // An authoritative receipt from an earlier attempt is checked before any
    // new final name can appear. A changed retry therefore cannot leave an
    // unbound archive beside the already-authoritative artifact set.
    const receiptPath = path.join(
      artifactDirectory,
      "artifact-set.v1.json",
    );
    return await serializeArenaPrivateWork(
      boundary,
      receiptPath,
      async () => {
        await assertExistingArtifactSetCompatible(
          receiptPath,
          receipt,
          boundary,
        );

        await input.confirmSnapshotBeforePublication();
        await publishStagedExact(
          path.join(artifactDirectory, "patch.bin"),
          input.patch,
          boundary,
        );
        if (archive) {
          await publishStagedExact(
            path.join(artifactDirectory, "untracked.v2.bin"),
            archive,
            boundary,
          );
        }
        await publishExact(
          path.join(artifactDirectory, "inventory.v2.json"),
          inventory,
          boundary,
        );

        // Last private publication: a crash can leave a partial file set, but
        // never a receipt claiming incomplete artifacts are authoritative.
        await publishExact(receiptPath, receipt, boundary);
        await verifyArenaArtifactSetUnlocked(
          {
            privateWorkspaceRoot: input.privateWorkspaceRoot,
            runId: input.runId,
            contestantId: input.contestantId,
            payload,
          },
          boundary,
          artifactDirectory,
        );
        await input.confirmSnapshotAfterPublication();
        return Object.freeze({ payload, artifactDirectory });
      },
    );
  } catch (error) {
    const cleanup = await Promise.allSettled([
      discardStagedFileIfPresent(input.patch, boundary),
      discardStagedFileIfPresent(input.untrackedPaths, boundary),
      archiveForCleanup
        ? discardStagedFileIfPresent(archiveForCleanup, boundary)
        : Promise.resolve(),
    ]);
    const cleanupErrors = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Arena evidence preservation and stage cleanup both failed.",
      );
    }
    throw error;
  }
}

/** Verify every retained byte named by one authoritative evidence payload. */
export async function verifyArenaArtifactSet(
  input: ArenaArtifactSetVerificationInput,
): Promise<void> {
  // Reject forged resource claims before touching private storage.
  assertArenaArtifactSetVerificationInput(input);
  const boundary = await prepareArenaPrivateStorage(
    input.privateWorkspaceRoot,
  );
  const artifactDirectory = arenaContestantArtifactPath(
    input.privateWorkspaceRoot,
    input.runId,
    input.contestantId,
  );
  const receiptPath = path.join(
    artifactDirectory,
    "artifact-set.v1.json",
  );
  await serializeArenaPrivateWork(boundary, receiptPath, async () => {
    await verifyArenaArtifactSetUnlocked(
      input,
      boundary,
      artifactDirectory,
    );
  });
}

async function verifyArenaArtifactSetUnlocked(
  input: ArenaArtifactSetVerificationInput,
  boundary: ArenaPrivateStorageBoundary,
  artifactDirectory: string,
): Promise<void> {
  assertArenaArtifactSetVerificationInput(input);
  await assertArenaPrivateDirectory(artifactDirectory, boundary);
  const generations: readonly ArenaArtifactGeneration[] = [
    {
      inventoryName: "inventory.v1.json",
      archiveName: "untracked.v1.bin",
    },
    {
      inventoryName: "inventory.v2.json",
      archiveName: "untracked.v2.bin",
    },
  ];
  const hasArchive = input.payload.untrackedArchiveSha256 !== null;
  const expectedEntryCount = hasArchive ? 4 : 3;
  const recoverableNames = [
    "artifact-set.v1.json",
    "patch.bin",
    ...generations.flatMap((generation) => [
      generation.inventoryName,
      generation.archiveName,
    ]),
  ];
  // Normalize strict dead-publisher stages for either historical generation
  // before inferring one exact, coherent on-disk generation.
  await recoverArenaEvidenceStageTemps(
    artifactDirectory,
    recoverableNames,
    boundary,
  );
  await assertArenaPrivateDirectory(artifactDirectory, boundary);
  const directoryBefore = await fs.lstat(artifactDirectory);
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
    throw new Error("Arena artifact directory is linked or invalid.");
  }
  const initialEntries = await readExactArtifactDirectory(
    artifactDirectory,
    expectedEntryCount,
  );
  const matchingGenerations = generations.filter((generation) => {
    const expectedNames = artifactGenerationNames(generation, hasArchive);
    return exactArtifactDirectoryEntries(initialEntries, expectedNames);
  });
  if (matchingGenerations.length !== 1) {
    throw new Error(
      "Arena artifact directory does not exactly match one authoritative generation.",
    );
  }
  const generation = matchingGenerations[0]!;
  const expectedNames = artifactGenerationNames(generation, hasArchive);
  const receipt = Buffer.from(`${canonicalArenaManifestJson({
    schemaVersion: 1,
    recordType: "arenaArtifactSet",
    payload: input.payload,
  })}\n`, "utf8");
  const retained: RetainedVerifiedEvidenceFile[] = [];
  let primaryError: unknown;
  try {
    retained.push(await verifyPrivateEvidenceDigest(
      path.join(artifactDirectory, "artifact-set.v1.json"),
      receipt.byteLength,
      receipt.byteLength,
      digest(receipt),
      "artifact-set receipt",
      boundary,
    ));
    retained.push(await verifyPrivateEvidenceDigest(
      path.join(artifactDirectory, "patch.bin"),
      input.payload.patchBytes,
      MAX_ARENA_PATCH_BYTES,
      input.payload.patchSha256,
      "patch",
      boundary,
    ));
    retained.push(await verifyPrivateEvidenceDigest(
      path.join(artifactDirectory, generation.inventoryName),
      undefined,
      MAX_UNTRACKED_INVENTORY_BYTES,
      input.payload.inventorySha256,
      "inventory",
      boundary,
    ));
    if (hasArchive) {
      retained.push(await verifyPrivateEvidenceDigest(
        path.join(artifactDirectory, generation.archiveName),
        input.payload.untrackedArchiveBytes,
        MAX_UNTRACKED_ARCHIVE_BYTES,
        input.payload.untrackedArchiveSha256!,
        "untracked archive",
        boundary,
      ));
    }

    const finalEntries = await readExactArtifactDirectory(
      artifactDirectory,
      expectedEntryCount,
    );
    if (!exactArtifactDirectoryEntries(finalEntries, expectedNames)) {
      throw new Error(
        "Arena artifact directory does not exactly match its authoritative receipt.",
      );
    }
    await assertEvidenceArtifactDirectoryUnchanged(
      artifactDirectory,
      directoryBefore,
      boundary,
    );
    await Promise.all(retained.map((file) =>
      assertRetainedEvidenceFileUnchanged(file, boundary)));
    // A pathname replacement during the parallel file checks must still be
    // reflected by the directory snapshot before verification can succeed.
    await assertEvidenceArtifactDirectoryUnchanged(
      artifactDirectory,
      directoryBefore,
      boundary,
    );
  } catch (error) {
    primaryError = error;
  }
  const closeResults = await Promise.allSettled(
    retained.map((file) => file.handle.close()),
  );
  const closeErrors = closeResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []);
  const errors = [
    ...(primaryError === undefined ? [] : [primaryError]),
    ...closeErrors,
  ];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Arena artifact verification and retained-handle cleanup both failed.",
    );
  }
  if (errors.length === 1) throw errors[0];
}

function assertArenaArtifactSetVerificationInput(
  input: ArenaArtifactSetVerificationInput,
): void {
  if (input.payload.contestantId !== input.contestantId) {
    throw new Error("Arena artifact-set contestant identity is mismatched.");
  }
  assertArtifactByteCount(
    input.payload.patchBytes,
    MAX_ARENA_PATCH_BYTES,
    "patch",
  );
  assertArtifactByteCount(
    input.payload.untrackedArchiveBytes,
    MAX_UNTRACKED_ARCHIVE_BYTES,
    "untracked archive",
  );
  if ((input.payload.untrackedArchiveSha256 === null)
    !== (input.payload.untrackedArchiveBytes === 0)) {
    throw new Error("Arena untracked archive hash and byte count are inconsistent.");
  }
  const { artifactSetSha256, ...withoutArtifactSet } = input.payload;
  if (arenaArtifactSetSha256(withoutArtifactSet) !== artifactSetSha256) {
    throw new Error("Arena artifact-set payload hash is invalid.");
  }
  assertDigest(input.payload.patchSha256, "patch");
  assertDigest(input.payload.inventorySha256, "inventory");
  if (input.payload.untrackedArchiveSha256 !== null) {
    assertDigest(input.payload.untrackedArchiveSha256, "untracked archive");
  }
}

export async function discardArenaEvidenceCaptureStages(input: {
  readonly privateWorkspaceRoot: string;
  readonly runId: string;
  readonly contestantId: string;
  readonly patch: ArenaStagedEvidenceFile;
  readonly untrackedPaths: ArenaStagedEvidenceFile;
}): Promise<void> {
  assertStagedEvidenceFile(input.patch, "patch");
  assertStagedEvidenceFile(input.untrackedPaths, "untracked path listing");
  try {
    await discardReservedArenaEvidenceCaptureStages(input);
  } finally {
    // Cleanup is the terminal owner of these reservations. Missing parents,
    // boundary failures, identity failures, and unlink/fsync failures must not
    // leave an in-memory reservation that blocks later strict recovery.
    releaseArenaEvidenceStageName(input.patch.path);
    releaseArenaEvidenceStageName(input.untrackedPaths.path);
  }
}

async function discardReservedArenaEvidenceCaptureStages(input: {
  readonly privateWorkspaceRoot: string;
  readonly runId: string;
  readonly contestantId: string;
  readonly patch: ArenaStagedEvidenceFile;
  readonly untrackedPaths: ArenaStagedEvidenceFile;
}): Promise<void> {
  const boundary = await prepareArenaPrivateStorage(
    input.privateWorkspaceRoot,
  );
  const artifactDirectory = arenaContestantArtifactPath(
    input.privateWorkspaceRoot,
    input.runId,
    input.contestantId,
  );
  try {
    await assertArenaPrivateDirectory(artifactDirectory, boundary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  assertExpectedStagePath(input.patch.path, artifactDirectory, "patch.bin");
  assertExpectedStagePath(
    input.untrackedPaths.path,
    artifactDirectory,
    "untracked-paths.v1.bin",
  );
  const cleanup = await Promise.allSettled([
    discardStagedFileIfPresent(input.patch, boundary),
    discardStagedFileIfPresent(input.untrackedPaths, boundary),
  ]);
  const errors = cleanup.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Arena evidence stage cleanup failed.");
  }
}

async function captureUntrackedEntries(
  worktreePath: string,
  pathsZ: Buffer,
  artifactDirectory: string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<{
  readonly entries: readonly UntrackedEntry[];
  readonly archive: ArenaStagedEvidenceFile | null;
}> {
  if (pathsZ.byteLength > MAX_UNTRACKED_PATH_LIST_BYTES) {
    throw new Error("Arena untracked path listing exceeds its byte limit.");
  }
  const root = path.resolve(worktreePath);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Arena evidence worktree root is linked or invalid.");
  }
  const realRoot = await fs.realpath(root);
  const parentCheckBudget = {
    remaining: MAX_UNTRACKED_PARENT_COMPONENT_CHECKS,
  };
  const rawPaths = parsePathsZ(pathsZ);
  const sorted = [...rawPaths].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  if (new Set(sorted).size !== sorted.length) {
    throw new Error("Arena untracked path listing contains duplicates.");
  }
  await recoverArenaEvidenceStageTemps(
    artifactDirectory,
    ["untracked.v2.bin"],
    boundary,
  );
  if (sorted.length === 0) {
    const finalArchivePath = path.join(
      artifactDirectory,
      "untracked.v2.bin",
    );
    try {
      await fs.lstat(finalArchivePath);
      throw new Error(
        "Arena untracked archive exists for an empty evidence inventory.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return Object.freeze({ entries: Object.freeze([]), archive: null });
  }
  const entries: UntrackedEntry[] = [];
  const archiveStage = await createEvidenceOutputStage(
    artifactDirectory,
    "untracked.v2.bin",
    boundary,
  );
  const archiveHash = createHash("sha256");
  let archiveBytes = 0;
  const writeArchive = async (chunk: Buffer): Promise<void> => {
    if (archiveBytes + chunk.byteLength > MAX_UNTRACKED_ARCHIVE_BYTES) {
      throw new Error("Arena untracked archive exceeds its encoded limit.");
    }
    archiveHash.update(chunk);
    await writeEvidenceChunk(archiveStage.handle, chunk);
    archiveBytes += chunk.byteLength;
  };
  try {
    await writeArchive(ARCHIVE_MAGIC);
    for (const [index, gitPath] of sorted.entries()) {
      const absolute = path.resolve(root, ...gitPath.split("/"));
      if (!isWithin(root, absolute)) {
        throw new Error(`Arena untracked entry ${index + 1} escapes its worktree.`);
      }
      const parentSnapshots = await captureUnlinkedParents(
        root,
        absolute,
        parentCheckBudget,
      );
      const before = await fs.lstat(absolute);
      assertSingleRegularFile(before, index);
      const encodedPath = Buffer.from(gitPath, "utf8");
      const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
        ? fsConstants.O_NOFOLLOW
        : 0;
      const handle = await fs.open(
        absolute,
        fsConstants.O_RDONLY | noFollow,
      );
      try {
        const opened = await handle.stat();
        assertSingleRegularFile(opened, index);
        if (!sameEvidenceFileSnapshot(before, opened)) {
          throw new Error(`Arena untracked entry ${index + 1} changed while opening.`);
        }
        await assertRootAndParentsUnchanged(
          root,
          rootStat,
          parentSnapshots,
          parentCheckBudget,
        );
        const realEntry = await fs.realpath(absolute);
        if (!isWithin(realRoot, realEntry)) {
          throw new Error(
            `Arena untracked entry ${index + 1} escaped its authenticated root.`,
          );
        }
        const mode = opened.mode & 0o777;
        const header = Buffer.allocUnsafe(16);
        header.writeUInt32BE(encodedPath.byteLength, 0);
        header.writeBigUInt64BE(BigInt(opened.size), 4);
        header.writeUInt32BE(mode, 12);
        if (archiveBytes + header.byteLength + encodedPath.byteLength + opened.size
          > MAX_UNTRACKED_ARCHIVE_BYTES) {
          throw new Error("Arena untracked archive exceeds its byte limit.");
        }
        await writeArchive(header);
        await writeArchive(encodedPath);
        const entryHash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, opened.size)));
        let offset = 0;
        while (offset < opened.size) {
          const read = await handle.read(
            buffer,
            0,
            Math.min(buffer.byteLength, opened.size - offset),
            offset,
          );
          if (read.bytesRead === 0) {
            throw new Error(
              `Arena untracked entry ${index + 1} was truncated during capture.`,
            );
          }
          const chunk = buffer.subarray(0, read.bytesRead);
          entryHash.update(chunk);
          await writeArchive(chunk);
          offset += read.bytesRead;
        }
        const [after, entryAfter] = await Promise.all([
          handle.stat(),
          fs.lstat(absolute),
        ]);
        await assertRootAndParentsUnchanged(
          root,
          rootStat,
          parentSnapshots,
          parentCheckBudget,
        );
        assertSingleRegularFile(after, index);
        assertSingleRegularFile(entryAfter, index);
        if (!sameFile(opened, after)
          || !sameFile(opened, entryAfter)
          || after.size !== opened.size
          || after.mtimeMs !== opened.mtimeMs
          || after.ctimeMs !== opened.ctimeMs
          || entryAfter.size !== opened.size
          || entryAfter.mtimeMs !== opened.mtimeMs
          || entryAfter.ctimeMs !== opened.ctimeMs
          || (after.mode & 0o777) !== mode
          || (entryAfter.mode & 0o777) !== mode) {
          throw new Error(
            `Arena untracked entry ${index + 1} changed during capture.`,
          );
        }
        entries.push(Object.freeze({
          gitPath,
          bytes: opened.size,
          mode,
          sha256: entryHash.digest("hex"),
        }));
      } finally {
        await handle.close();
      }
    }
    const archive = await sealEvidenceOutputStage(
      archiveStage,
      archiveBytes,
      archiveHash.digest("hex"),
      boundary,
    );
    return Object.freeze({ entries: Object.freeze(entries), archive });
  } catch (error) {
    try {
      await discardMutableEvidenceStage(archiveStage, boundary);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Arena untracked archive capture and cleanup both failed.",
      );
    }
    throw error;
  }
}

function parsePathsZ(value: Buffer): readonly string[] {
  if (value.byteLength === 0) return Object.freeze([]);
  if (value.at(-1) !== 0) {
    throw new Error("Arena untracked path listing is not NUL terminated.");
  }
  const paths: string[] = [];
  let start = 0;
  for (let cursor = 0; cursor < value.byteLength; cursor += 1) {
    if (value[cursor] !== 0) continue;
    if (cursor === start || paths.length >= MAX_UNTRACKED_PATHS) {
      throw new Error("Arena untracked path listing is empty or oversized.");
    }
    const bytes = value.subarray(start, cursor);
    if (bytes.byteLength > MAX_UNTRACKED_PATH_BYTES) {
      throw new Error("Arena untracked path entry exceeds its byte limit.");
    }
    let gitPath: string;
    try {
      gitPath = UTF8.decode(bytes);
    } catch (error) {
      throw new Error("Arena untracked path entry is not valid UTF-8.", {
        cause: error,
      });
    }
    if (gitPath.startsWith("/")
      || gitPath.endsWith("/")
      || gitPath.includes("\\")
      || gitPath.split("/").some((part) =>
        !part || part === "." || part === "..")
      || /[\u0000-\u001f\u007f]/u.test(gitPath)) {
      throw new Error("Arena untracked path entry is unsafe.");
    }
    paths.push(gitPath);
    start = cursor + 1;
  }
  return Object.freeze(paths);
}

async function publishExact(
  filePath: string,
  bytes: Buffer,
  boundary: Awaited<ReturnType<typeof prepareArenaPrivateStorage>>,
): Promise<void> {
  try {
    await createArenaPrivateFile(filePath, bytes, boundary);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const existing = await readArenaPrivateFile(
    filePath,
    Math.max(1, bytes.byteLength),
    boundary,
  );
  if (!existing.equals(bytes)) {
    throw new Error("Arena artifact retry conflicts with existing private evidence.");
  }
}

async function assertExistingArtifactSetCompatible(
  receiptPath: string,
  expected: Buffer,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  let existing: Buffer;
  try {
    existing = await readArenaPrivateFile(
      receiptPath,
      Math.max(1, expected.byteLength),
      boundary,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!existing.equals(expected)) {
    throw new Error(
      "Arena evidence retry conflicts with an authoritative artifact-set receipt.",
    );
  }
}

async function verifyPrivateEvidenceDigest(
  filePath: string,
  expectedBytes: number | undefined,
  maximumBytes: number,
  expectedSha256: string,
  label: string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<RetainedVerifiedEvidenceFile> {
  assertDigest(expectedSha256, "artifact digest");
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error(`Arena ${label} byte limit is invalid.`);
  }
  if (expectedBytes !== undefined
    && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)) {
    throw new Error(`Arena ${label} byte count is invalid.`);
  }
  if (expectedBytes !== undefined && expectedBytes > maximumBytes) {
    throw new Error(`Arena ${label} exceeds its byte limit.`);
  }
  await assertArenaPrivateParent(filePath, boundary);
  const before = await fs.lstat(filePath);
  assertPrivateEvidenceFile(before, filePath, 1);
  if (before.size > maximumBytes) {
    throw new Error(`Arena retained ${label} exceeds its byte limit.`);
  }
  if (expectedBytes !== undefined && before.size !== expectedBytes) {
    throw new Error(`Arena retained ${label} byte count is invalid.`);
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    assertPrivateEvidenceFile(opened, filePath, 1);
    if (!sameEvidenceFileSnapshot(before, opened)) {
      throw new Error(`Arena retained ${label} changed while opening.`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, opened.size - offset),
        offset,
      );
      if (read.bytesRead === 0) {
        throw new Error(`Arena retained ${label} was truncated during verification.`);
      }
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    await assertArenaPrivateParent(filePath, boundary);
    const [after, entryAfter] = await Promise.all([
      handle.stat(),
      fs.lstat(filePath),
    ]);
    assertPrivateEvidenceFile(after, filePath, 1);
    assertPrivateEvidenceFile(entryAfter, filePath, 1);
    if (!sameEvidenceFileSnapshot(opened, after)
      || !sameEvidenceFileSnapshot(opened, entryAfter)
      || hash.digest("hex") !== expectedSha256) {
      throw new Error(`Arena retained ${label} bytes do not match their receipt.`);
    }
    return Object.freeze({
      filePath,
      label,
      handle,
      snapshot: opened,
    });
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        `Arena retained ${label} verification and handle cleanup both failed.`,
      );
    }
    throw error;
  }
}

async function assertRetainedEvidenceFileUnchanged(
  retained: RetainedVerifiedEvidenceFile,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  await assertArenaPrivateParent(retained.filePath, boundary);
  const [opened, entry] = await Promise.all([
    retained.handle.stat(),
    fs.lstat(retained.filePath),
  ]);
  assertPrivateEvidenceFile(opened, retained.filePath, 1);
  assertPrivateEvidenceFile(entry, retained.filePath, 1);
  if (!sameEvidenceFileSnapshot(retained.snapshot, opened)
    || !sameEvidenceFileSnapshot(retained.snapshot, entry)) {
    throw new Error(
      `Arena retained ${retained.label} changed after whole-set verification.`,
    );
  }
}

async function assertEvidenceArtifactDirectoryUnchanged(
  artifactDirectory: string,
  expected: Stats,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  await assertArenaPrivateDirectory(artifactDirectory, boundary);
  const current = await fs.lstat(artifactDirectory);
  if (!current.isDirectory()
    || current.isSymbolicLink()
    || !sameEvidenceDirectorySnapshot(expected, current)) {
    throw new Error("Arena evidence artifact directory changed during verification.");
  }
}

function artifactGenerationNames(
  generation: ArenaArtifactGeneration,
  hasArchive: boolean,
): readonly string[] {
  return [
    "artifact-set.v1.json",
    generation.inventoryName,
    "patch.bin",
    ...(hasArchive ? [generation.archiveName] : []),
  ].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
}

function exactArtifactDirectoryEntries(
  entries: readonly Dirent[],
  expectedNames: readonly string[],
): boolean {
  return entries.length === expectedNames.length
    && entries.every((entry, index) =>
      entry.name === expectedNames[index]
      && entry.isFile()
      && !entry.isSymbolicLink());
}

async function readExactArtifactDirectory(
  directoryPath: string,
  expectedEntries: number,
): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  const directory = await fs.opendir(directoryPath);
  try {
    for await (const entry of directory) {
      if (entries.length >= expectedEntries) {
        throw new Error(
          "Arena artifact directory exceeds its authoritative entry count.",
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

interface MutableEvidenceOutputStage {
  readonly path: string;
  readonly handle: fs.FileHandle;
  readonly identity: Stats;
  readonly parentIdentity: Stats;
}

async function createEvidenceOutputStage(
  artifactDirectory: string,
  artifactName: string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<MutableEvidenceOutputStage> {
  await assertArenaPrivateDirectory(artifactDirectory, boundary);
  const parentIdentity = await fs.lstat(artifactDirectory);
  if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()) {
    throw new Error("Arena evidence artifact directory is linked or invalid.");
  }
  const reservation = reserveArenaEvidenceStageName(artifactName);
  const stagePath = path.join(artifactDirectory, reservation.name);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(stagePath, "wx", 0o600);
  } catch (error) {
    releaseArenaEvidenceStageName(stagePath);
    throw error;
  }
  try {
    const [opened, entry] = await Promise.all([
      handle.stat(),
      fs.lstat(stagePath),
    ]);
    assertPrivateEvidenceFile(opened, stagePath, 1);
    assertPrivateEvidenceFile(entry, stagePath, 1);
    if (!sameFile(opened, entry)) {
      throw new Error("Arena evidence staging file changed while opening.");
    }
    await assertEvidenceStageParent(
      artifactDirectory,
      parentIdentity,
      boundary,
    );
    await handle.chmod(0o600).catch(() => undefined);
    return Object.freeze({
      path: stagePath,
      handle,
      identity: opened,
      parentIdentity,
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    let opened: Stats | undefined;
    try {
      opened = await handle.stat();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await handle.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await assertEvidenceStageParent(
        artifactDirectory,
        parentIdentity,
        boundary,
      );
      const entry = await fs.lstat(stagePath);
      if (!opened || !sameFile(opened, entry)) {
        throw new Error(
          "Arena evidence staging file changed before failed-open cleanup.",
        );
      }
      await fs.unlink(stagePath);
      await syncArenaDirectoryEntry(
        artifactDirectory,
        evidenceDirectoryIdentity(parentIdentity),
        "Arena evidence artifact directory",
      );
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        cleanupErrors.push(cleanupError);
      }
    }
    releaseArenaEvidenceStageName(stagePath);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Arena evidence stage creation and cleanup both failed.",
      );
    }
    throw error;
  }
}

async function sealEvidenceOutputStage(
  stage: MutableEvidenceOutputStage,
  bytes: number,
  sha256: string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<ArenaStagedEvidenceFile> {
  let result: ArenaStagedEvidenceFile | undefined;
  let primaryError: unknown;
  try {
    await assertEvidenceStageParent(
      path.dirname(stage.path),
      stage.parentIdentity,
      boundary,
    );
    await stage.handle.sync();
    const [sealed, entry] = await Promise.all([
      stage.handle.stat(),
      fs.lstat(stage.path),
    ]);
    assertPrivateEvidenceFile(sealed, stage.path, 1);
    assertPrivateEvidenceFile(entry, stage.path, 1);
    if (!sameFile(stage.identity, sealed)
      || !sameFile(sealed, entry)
      || sealed.size !== bytes) {
      throw new Error("Arena evidence staging file changed before sealing.");
    }
    await assertEvidenceStageParent(
      path.dirname(stage.path),
      stage.parentIdentity,
      boundary,
    );
    assertDigest(sha256, "staged evidence");
    result = Object.freeze({ path: stage.path, bytes, sha256 });
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown;
  try {
    await stage.handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError && closeError) {
    throw new AggregateError(
      [primaryError, closeError],
      "Arena evidence stage sealing and close both failed.",
    );
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
  return result!;
}

async function discardMutableEvidenceStage(
  stage: MutableEvidenceOutputStage,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await stage.handle.close();
  } catch (error) {
    errors.push(error);
  }
  const parentPath = path.dirname(stage.path);
  try {
    await assertEvidenceStageParent(
      parentPath,
      stage.parentIdentity,
      boundary,
    );
    const entry = await fs.lstat(stage.path);
    if (!sameFile(stage.identity, entry)) {
      throw new Error(
        "Arena evidence staging file changed before cleanup.",
      );
    }
    await fs.unlink(stage.path);
    await syncArenaDirectoryEntry(
      parentPath,
      evidenceDirectoryIdentity(stage.parentIdentity),
      "Arena evidence artifact directory",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push(error);
    }
  }
  releaseArenaEvidenceStageName(stage.path);
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Arena evidence stage cleanup failed.",
    );
  }
}

function assertStagedEvidenceFile(
  value: ArenaStagedEvidenceFile,
  label: string,
): void {
  if (!value
    || typeof value.path !== "string"
    || !path.isAbsolute(value.path)
    || !Number.isSafeInteger(value.bytes)
    || value.bytes < 0
    || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new Error(`Arena ${label} staging receipt is invalid.`);
  }
}

function assertExpectedStagePath(
  stagePath: string,
  artifactDirectory: string,
  artifactName: string,
): void {
  if (!samePath(path.dirname(stagePath), artifactDirectory)) {
    throw new Error("Arena evidence staging file escaped its artifact directory.");
  }
  const escaped = artifactName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^\\.${escaped}\\.${process.pid}-[0-9a-f-]{36}-[0-9a-f-]{36}\\.tmp$`,
    process.platform === "win32" ? "i" : "",
  );
  if (!pattern.test(path.basename(stagePath))) {
    throw new Error("Arena evidence staging file has an invalid publication name.");
  }
}

async function readAndVerifyStagedFile(
  staged: ArenaStagedEvidenceFile,
  maxBytes: number,
  boundary: ArenaPrivateStorageBoundary,
): Promise<Buffer> {
  const bytes = await readArenaPrivateFile(
    staged.path,
    Math.max(1, maxBytes),
    boundary,
  );
  if (bytes.byteLength !== staged.bytes || digest(bytes) !== staged.sha256) {
    throw new Error("Arena staged evidence changed before preservation.");
  }
  return bytes;
}

async function publishStagedExact(
  filePath: string,
  staged: ArenaStagedEvidenceFile,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  await assertArenaPrivateParent(filePath, boundary);
  const parentPath = path.dirname(filePath);
  if (!samePath(path.dirname(staged.path), parentPath)) {
    throw new Error("Arena staged evidence must publish within one directory.");
  }
  const parentStat = await fs.lstat(parentPath);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("Arena evidence artifact directory is linked or invalid.");
  }
  const parentIdentity = evidenceDirectoryIdentity(parentStat);
  let source = await verifyEvidenceFile(staged.path, staged, boundary, [1, 2]);
  let destination: Stats | undefined;
  try {
    destination = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (destination && destination.nlink === 2 && sameFile(source, destination)) {
    await discardStagedFile(staged, boundary, [1, 2]);
    await syncArenaDirectoryEntry(parentPath, parentIdentity, "Arena evidence artifact directory");
    await verifyEvidenceFile(filePath, staged, boundary, [1]);
    return;
  }
  if (destination) {
    if (destination.nlink === 2) {
      await readArenaPrivateFile(filePath, 1, boundary).catch((error: unknown) => {
        if (!/exceeds its read limit/u.test(String(error))) throw error;
      });
    }
    await verifyEvidenceFile(filePath, staged, boundary, [1]);
    await discardStagedFile(staged, boundary, [1]);
    await syncArenaDirectoryEntry(parentPath, parentIdentity, "Arena evidence artifact directory");
    return;
  }
  if (source.nlink !== 1) {
    throw new Error("Arena staged evidence has an ambiguous publication link.");
  }

  try {
    await fs.link(staged.path, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await verifyEvidenceFile(filePath, staged, boundary, [1]);
    await discardStagedFile(staged, boundary, [1]);
    await syncArenaDirectoryEntry(
      parentPath,
      parentIdentity,
      "Arena evidence artifact directory",
    );
    return;
  }
  try {
    const [linkedSource, linkedDestination] = await Promise.all([
      fs.lstat(staged.path),
      fs.lstat(filePath),
    ]);
    assertPrivateEvidenceFile(linkedSource, staged.path, 2);
    assertPrivateEvidenceFile(linkedDestination, filePath, 2);
    if (!sameFile(source, linkedSource)
      || !sameFile(linkedSource, linkedDestination)) {
      throw new Error("Arena staged evidence changed during publication.");
    }
    await syncArenaDirectoryEntry(parentPath, parentIdentity, "Arena evidence artifact directory");
    await discardStagedFile(staged, boundary, [2]);
    await syncArenaDirectoryEntry(parentPath, parentIdentity, "Arena evidence artifact directory");
    source = await verifyEvidenceFile(filePath, staged, boundary, [1]);
    if (!sameFile(linkedDestination, source)) {
      throw new Error("Arena evidence artifact changed after publication.");
    }
  } catch (error) {
    await discardStagedFile(staged, boundary, [1, 2]).catch(() => undefined);
    throw error;
  }
}

async function discardStagedFile(
  staged: ArenaStagedEvidenceFile,
  boundary: ArenaPrivateStorageBoundary,
  allowedLinks: readonly number[] = [1],
): Promise<void> {
  try {
    const parentPath = path.dirname(staged.path);
    await assertArenaPrivateDirectory(parentPath, boundary);
    const parentStat = await fs.lstat(parentPath);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error("Arena evidence stage parent is linked or invalid.");
    }
    const parentIdentity = evidenceDirectoryIdentity(parentStat);
    const opened = await verifyEvidenceFile(
      staged.path,
      staged,
      boundary,
      allowedLinks,
    );
    const current = await fs.lstat(staged.path);
    if (!sameFile(opened, current)) {
      throw new Error("Arena staged evidence changed before cleanup.");
    }
    await fs.unlink(staged.path);
    await syncArenaDirectoryEntry(
      parentPath,
      parentIdentity,
      "Arena evidence artifact directory",
    );
  } finally {
    releaseArenaEvidenceStageName(staged.path);
  }
}

async function discardStagedFileIfPresent(
  staged: ArenaStagedEvidenceFile,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  try {
    await discardStagedFile(staged, boundary, [1, 2]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      releaseArenaEvidenceStageName(staged.path);
      return;
    }
    throw error;
  }
}

async function verifyEvidenceFile(
  filePath: string,
  expected: ArenaStagedEvidenceFile,
  boundary: ArenaPrivateStorageBoundary,
  allowedLinks: readonly number[],
): Promise<Stats> {
  await assertArenaPrivateParent(filePath, boundary);
  const before = await fs.lstat(filePath);
  assertPrivateEvidenceFile(before, filePath, ...allowedLinks);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    assertPrivateEvidenceFile(opened, filePath, ...allowedLinks);
    if (!sameFile(before, opened) || opened.size !== expected.bytes) {
      throw new Error("Arena evidence file changed while opening.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, opened.size - offset),
        offset,
      );
      if (read.bytesRead === 0) {
        throw new Error("Arena evidence file was truncated during verification.");
      }
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const [after, entry] = await Promise.all([
      handle.stat(),
      fs.lstat(filePath),
    ]);
    assertPrivateEvidenceFile(after, filePath, ...allowedLinks);
    assertPrivateEvidenceFile(entry, filePath, ...allowedLinks);
    if (!sameFile(opened, after)
      || !sameFile(opened, entry)
      || after.size !== opened.size
      || hash.digest("hex") !== expected.sha256) {
      throw new Error("Arena evidence file changed during verification.");
    }
    return opened;
  } finally {
    await handle.close();
  }
}

function assertPrivateEvidenceFile(
  stat: Stats,
  filePath: string,
  ...allowedLinks: readonly number[]
): void {
  if (!stat.isFile()
    || stat.isSymbolicLink()
    || !allowedLinks.includes(stat.nlink)) {
    throw new Error(`Arena evidence file is linked or invalid: ${filePath}`);
  }
  if (process.platform !== "win32"
    && ((stat.mode & 0o077) !== 0
      || (typeof process.getuid === "function"
        && stat.uid !== process.getuid()))) {
    throw new Error(
      `Arena evidence file ownership or permissions are unsafe: ${filePath}`,
    );
  }
}

function evidenceDirectoryIdentity(stat: Stats): ArenaDirectoryIdentity {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function assertEvidenceStageParent(
  artifactDirectory: string,
  expected: Stats,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  await assertArenaPrivateDirectory(artifactDirectory, boundary);
  const current = await fs.lstat(artifactDirectory);
  if (!current.isDirectory()
    || current.isSymbolicLink()
    || !sameFile(expected, current)) {
    throw new Error("Arena evidence artifact directory changed identity.");
  }
}

async function writeEvidenceChunk(
  handle: fs.FileHandle,
  chunk: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const write = await handle.write(chunk.subarray(offset));
    if (write.bytesWritten <= 0) {
      throw new Error("Arena evidence archive write made no progress.");
    }
    offset += write.bytesWritten;
  }
}

async function captureUnlinkedParents(
  root: string,
  filePath: string,
  budget: { remaining: number },
): Promise<readonly ParentDirectorySnapshot[]> {
  const relative = path.relative(root, path.dirname(filePath));
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.length > MAX_UNTRACKED_PARENT_DEPTH) {
    throw new Error("Arena untracked entry exceeds its parent-depth limit.");
  }
  let current = root;
  const snapshots: ParentDirectorySnapshot[] = [];
  for (const segment of segments) {
    consumeParentCheckBudget(budget);
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Arena untracked entry has a linked or invalid parent.");
    }
    snapshots.push(Object.freeze({ path: current, stat }));
  }
  return Object.freeze(snapshots);
}

async function assertRootAndParentsUnchanged(
  root: string,
  expectedRoot: Stats,
  parents: readonly ParentDirectorySnapshot[],
  budget: { remaining: number },
): Promise<void> {
  consumeParentCheckBudget(budget);
  const currentRoot = await fs.lstat(root);
  if (!currentRoot.isDirectory()
    || currentRoot.isSymbolicLink()
    || !sameFile(expectedRoot, currentRoot)) {
    throw new Error("Arena evidence worktree root changed identity.");
  }
  for (const parent of parents) {
    consumeParentCheckBudget(budget);
    const current = await fs.lstat(parent.path);
    if (!current.isDirectory()
      || current.isSymbolicLink()
      || !sameFile(parent.stat, current)) {
      throw new Error("Arena untracked entry parent changed identity.");
    }
  }
}

function consumeParentCheckBudget(budget: { remaining: number }): void {
  if (budget.remaining <= 0) {
    throw new Error(
      "Arena untracked entries exceed the aggregate parent-check limit.",
    );
  }
  budget.remaining -= 1;
}

function assertSingleRegularFile(stat: Stats, index: number): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(
      `Arena untracked entry ${index + 1} is linked or not a regular file.`,
    );
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameEvidenceFileSnapshot(left: Stats, right: Stats): boolean {
  return sameFile(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && (left.mode & 0o777) === (right.mode & 0o777);
}

function sameEvidenceDirectorySnapshot(left: Stats, right: Stats): boolean {
  return sameFile(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && (left.mode & 0o777) === (right.mode & 0o777);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Arena ${label} is invalid.`);
  }
}

function assertArtifactByteCount(
  value: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Arena ${label} byte count is invalid.`);
  }
  if (value > maximum) {
    throw new Error(`Arena ${label} exceeds its byte limit.`);
  }
}

function assertObjectId(value: ArenaGitObjectId): void {
  const length = value.objectFormat === "sha1"
    ? 40
    : value.objectFormat === "sha256"
      ? 64
      : 0;
  if (!length || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value.oid)) {
    throw new Error("Arena final Git object ID is invalid.");
  }
}
