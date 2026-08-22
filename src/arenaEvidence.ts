import { constants as fsConstants, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import {
  assertArenaPrivateDirectory,
  createArenaPrivateFile,
  ensureArenaPrivateDirectory,
  prepareArenaPrivateStorage,
  readArenaPrivateFile,
} from "./arenaPrivateStorage";
import { arenaContestantArtifactPath } from "./arenaStore";
import {
  ARENA_MANIFEST_LIMITS,
  arenaArtifactSetSha256,
  canonicalArenaManifestJson,
  type ArenaEvidencePreservedPayload,
  type ArenaGitObjectId,
} from "./arenaRunManifest";

const MAX_UNTRACKED_PATH_BYTES = 4_096;
const MAX_UNTRACKED_PATHS = 10_000;
const MAX_UNTRACKED_ARCHIVE_BYTES = 64 * 1024 * 1024;
const ARCHIVE_MAGIC = Buffer.from("HYDRA-ARENA-UNTRACKED-V1\0", "ascii");
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface ArenaEvidenceCaptureInput {
  readonly privateWorkspaceRoot: string;
  readonly runId: string;
  readonly contestantId: string;
  readonly worktreePath: string;
  readonly patch: Buffer;
  readonly untrackedPathsZ: Buffer;
  readonly receiptsRootSha256: string;
  readonly quiescenceReceiptSha256: string | null;
  readonly quiescenceWorkspaceFingerprintSha256: string | null;
  readonly finalHead: ArenaGitObjectId;
  readonly finalWorkspaceFingerprintSha256: string;
}

export interface ArenaEvidenceCaptureResult {
  readonly payload: ArenaEvidencePreservedPayload;
  readonly artifactDirectory: string;
}

interface UntrackedEntry {
  readonly gitPath: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

/**
 * Copies comparison artifacts out of the disposable worktree and publishes an
 * immutable artifact-set receipt last. Untracked entries are opened no-follow,
 * must have one link, and are identity-checked before and after every read.
 */
export async function preserveArenaEvidence(
  input: ArenaEvidenceCaptureInput,
): Promise<ArenaEvidenceCaptureResult> {
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
  if (input.patch.byteLength > ARENA_MANIFEST_LIMITS.maxArtifactBytes) {
    throw new Error("Arena patch exceeds the artifact limit.");
  }
  assertObjectId(input.finalHead);

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

  const entries = await captureUntrackedEntries(
    input.worktreePath,
    input.untrackedPathsZ,
  );
  const inventory = Buffer.from(`${canonicalArenaManifestJson({
    schemaVersion: 1,
    entries: entries.map((entry) => ({
      path: entry.gitPath,
      bytes: entry.bytes.byteLength,
      sha256: entry.sha256,
    })),
  })}\n`, "utf8");
  const archive = entries.length === 0
    ? null
    : encodeUntrackedArchive(entries);
  const patchSha256 = digest(input.patch);
  const inventorySha256 = digest(inventory);
  const archiveSha256 = archive ? digest(archive) : null;

  await publishExact(
    path.join(artifactDirectory, "patch.bin"),
    input.patch,
    boundary,
  );
  if (archive) {
    await publishExact(
      path.join(artifactDirectory, "untracked.v1.bin"),
      archive,
      boundary,
    );
  }
  await publishExact(
    path.join(artifactDirectory, "inventory.v1.json"),
    inventory,
    boundary,
  );

  const withoutArtifactSet = {
    payloadType: "evidencePreserved",
    contestantId: input.contestantId,
    receiptsRootSha256: input.receiptsRootSha256,
    patchSha256,
    patchBytes: input.patch.byteLength,
    untrackedArchiveSha256: archiveSha256,
    untrackedArchiveBytes: archive?.byteLength ?? 0,
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
  // Last private publication: a crash can leave a partial file set, but never
  // a receipt claiming that incomplete artifacts are authoritative.
  await publishExact(
    path.join(artifactDirectory, "artifact-set.v1.json"),
    receipt,
    boundary,
  );
  return Object.freeze({ payload, artifactDirectory });
}

async function captureUntrackedEntries(
  worktreePath: string,
  pathsZ: Buffer,
): Promise<readonly UntrackedEntry[]> {
  if (pathsZ.byteLength > 16 * 1024 * 1024) {
    throw new Error("Arena untracked path listing exceeds its byte limit.");
  }
  const root = path.resolve(worktreePath);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Arena evidence worktree root is linked or invalid.");
  }
  const rawPaths = parsePathsZ(pathsZ);
  const sorted = [...rawPaths].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  if (new Set(sorted).size !== sorted.length) {
    throw new Error("Arena untracked path listing contains duplicates.");
  }
  const entries: UntrackedEntry[] = [];
  let totalBytes = 0;
  for (const [index, gitPath] of sorted.entries()) {
    const absolute = path.resolve(root, ...gitPath.split("/"));
    if (!isWithin(root, absolute)) {
      throw new Error(`Arena untracked entry ${index + 1} escapes its worktree.`);
    }
    await assertUnlinkedParents(root, absolute);
    const before = await fs.lstat(absolute);
    assertSingleRegularFile(before, index);
    totalBytes += before.size;
    if (totalBytes > MAX_UNTRACKED_ARCHIVE_BYTES) {
      throw new Error("Arena untracked archive exceeds its byte limit.");
    }
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
      if (!sameFile(before, opened)) {
        throw new Error(`Arena untracked entry ${index + 1} changed while opening.`);
      }
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (read.bytesRead === 0) {
          throw new Error(
            `Arena untracked entry ${index + 1} was truncated during capture.`,
          );
        }
        offset += read.bytesRead;
      }
      const [after, entryAfter] = await Promise.all([
        handle.stat(),
        fs.lstat(absolute),
      ]);
      assertSingleRegularFile(after, index);
      assertSingleRegularFile(entryAfter, index);
      if (!sameFile(opened, after)
        || !sameFile(opened, entryAfter)
        || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs) {
        throw new Error(
          `Arena untracked entry ${index + 1} changed during capture.`,
        );
      }
      entries.push(Object.freeze({
        gitPath,
        bytes,
        sha256: digest(bytes),
      }));
    } finally {
      await handle.close();
    }
  }
  return Object.freeze(entries);
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

function encodeUntrackedArchive(entries: readonly UntrackedEntry[]): Buffer {
  const chunks: Buffer[] = [ARCHIVE_MAGIC];
  let total = ARCHIVE_MAGIC.byteLength;
  for (const entry of entries) {
    const encodedPath = Buffer.from(entry.gitPath, "utf8");
    const header = Buffer.allocUnsafe(12);
    header.writeUInt32BE(encodedPath.byteLength, 0);
    header.writeBigUInt64BE(BigInt(entry.bytes.byteLength), 4);
    chunks.push(header, encodedPath, entry.bytes);
    total += header.byteLength + encodedPath.byteLength + entry.bytes.byteLength;
    if (total > MAX_UNTRACKED_ARCHIVE_BYTES) {
      throw new Error("Arena untracked archive exceeds its encoded limit.");
    }
  }
  return Buffer.concat(chunks, total);
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

async function assertUnlinkedParents(
  root: string,
  filePath: string,
): Promise<void> {
  const relative = path.relative(root, path.dirname(filePath));
  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Arena untracked entry has a linked or invalid parent.");
    }
  }
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
