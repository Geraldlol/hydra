import { createHash } from "node:crypto";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import {
  assertArenaPrivateDirectory,
  prepareArenaPrivateStorage,
  readArenaPrivateFile,
} from "./arenaPrivateStorage";
import { verifyArenaArtifactSet } from "./arenaEvidence";
import { arenaContestantArtifactPath } from "./arenaStore";
import {
  canonicalArenaManifestJson,
  type ArenaEvidencePreservedPayload,
} from "./arenaRunManifest";
import type { ArenaPromotionPreview } from "./arenaPromotion";

const MAX_PATCH_BYTES = 64 * 1024 * 1024;
const MAX_INVENTORY_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_PATH_BYTES = 4_096;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const V1_MAGIC = Buffer.from("HYDRA-ARENA-UNTRACKED-V1\0", "ascii");
const V2_MAGIC = Buffer.from("HYDRA-ARENA-UNTRACKED-V2\0", "ascii");
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const MAX_OPERATOR_PATCH_PREVIEW_BYTES = 1024 * 1024;

export interface ArenaPromotionUntrackedEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mode: number;
  readonly content: Buffer;
}

export interface ArenaPromotionCandidate {
  readonly patch: Buffer;
  readonly patchSha256: string;
  readonly untrackedEntries: readonly ArenaPromotionUntrackedEntry[];
  readonly artifactSetSha256: string;
}

/**
 * Loads an immutable promotion candidate from the retained evidence set. The
 * artifact set is verified both before and after reading; only copied bytes
 * whose inventory/archive framing agrees exactly are returned.
 */
export async function loadArenaPromotionCandidate(input: {
  readonly privateWorkspaceRoot: string;
  readonly runId: string;
  readonly contestantId: string;
  readonly payload: ArenaEvidencePreservedPayload;
}): Promise<ArenaPromotionCandidate> {
  const verification = {
    privateWorkspaceRoot: input.privateWorkspaceRoot,
    runId: input.runId,
    contestantId: input.contestantId,
    payload: input.payload,
  } as const;
  await verifyArenaArtifactSet(verification);
  const boundary = await prepareArenaPrivateStorage(input.privateWorkspaceRoot);
  const artifactDirectory = arenaContestantArtifactPath(
    input.privateWorkspaceRoot,
    input.runId,
    input.contestantId,
  );
  await assertArenaPrivateDirectory(artifactDirectory, boundary);
  const generation = await exactGeneration(
    artifactDirectory,
    input.payload.untrackedArchiveSha256 !== null,
  );
  const patch = await readArenaPrivateFile(
    path.join(artifactDirectory, "patch.bin"),
    Math.max(1, Math.min(MAX_PATCH_BYTES, input.payload.patchBytes)),
    boundary,
  );
  if (patch.byteLength !== input.payload.patchBytes
    || digest(patch) !== input.payload.patchSha256) {
    throw new Error("Arena promotion patch bytes changed after verification.");
  }
  const inventory = await readArenaPrivateFile(
    path.join(artifactDirectory, generation.inventoryName),
    MAX_INVENTORY_BYTES,
    boundary,
  );
  if (digest(inventory) !== input.payload.inventorySha256) {
    throw new Error("Arena promotion inventory changed after verification.");
  }
  const parsedInventory = parseInventory(inventory, generation.version);
  let untrackedEntries: readonly ArenaPromotionUntrackedEntry[];
  if (input.payload.untrackedArchiveSha256 === null) {
    if (parsedInventory.length !== 0 || input.payload.untrackedArchiveBytes !== 0) {
      throw new Error("Arena promotion inventory requires a missing archive.");
    }
    untrackedEntries = Object.freeze([]);
  } else {
    const archive = await readArenaPrivateFile(
      path.join(artifactDirectory, generation.archiveName),
      Math.max(1, Math.min(
        MAX_ARCHIVE_BYTES,
        input.payload.untrackedArchiveBytes,
      )),
      boundary,
    );
    if (archive.byteLength !== input.payload.untrackedArchiveBytes
      || digest(archive) !== input.payload.untrackedArchiveSha256) {
      throw new Error("Arena promotion archive changed after verification.");
    }
    untrackedEntries = parseArchive(archive, parsedInventory, generation.version);
  }
  await verifyArenaArtifactSet(verification);
  return Object.freeze({
    patch: Buffer.from(patch),
    patchSha256: input.payload.patchSha256,
    untrackedEntries,
    artifactSetSha256: input.payload.artifactSetSha256,
  });
}

export function renderArenaPromotionCandidateMarkdown(input: {
  readonly preview: ArenaPromotionPreview;
  readonly candidate: ArenaPromotionCandidate;
  readonly targetWorkspace: string;
  readonly targetHead: string;
}): string {
  if (input.candidate.patchSha256 !== input.preview.patchSha256
    || input.candidate.artifactSetSha256 !== input.preview.artifactSetSha256
    || input.candidate.patch.byteLength !== input.preview.patchBytes) {
    throw new Error("Arena operator preview candidate does not bind the promotion preview.");
  }
  if (input.candidate.patch.byteLength > MAX_OPERATOR_PATCH_PREVIEW_BYTES) {
    throw new Error(
      `Arena patch exceeds the ${MAX_OPERATOR_PATCH_PREVIEW_BYTES}-byte operator preview bound. Promotion is refused until the exact retained patch is inspected externally.`,
    );
  }
  let patchEncoding: "utf8" | "base64" = "utf8";
  let patchText: string;
  try {
    patchText = UTF8.decode(input.candidate.patch);
    if (!Buffer.from(patchText, "utf8").equals(input.candidate.patch)) {
      throw new Error("round-trip mismatch");
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(patchText)) {
      throw new Error("unsafe display controls");
    }
  } catch {
    patchEncoding = "base64";
    patchText = input.candidate.patch.toString("base64");
  }
  const inventory = canonicalArenaManifestJson({
    entries: input.candidate.untrackedEntries.map((entry) => ({
      path: entry.path,
      bytes: entry.bytes,
      mode: entry.mode,
      sha256: entry.sha256,
    })),
  });
  const targetWorkspace = JSON.stringify(input.targetWorkspace);
  const fence = codeFence(`${targetWorkspace}\n${patchText}\n${inventory}`);
  return [
    "# Hydra Arena Promotion Preview",
    "",
    "Target workspace (JSON-encoded exact path):",
    "",
    fence,
    targetWorkspace,
    fence,
    "",
    `Source HEAD (unchanged by promotion): \`${markdownCode(input.targetHead)}\``,
    `Winner: \`${markdownCode(input.preview.contestantId)}\``,
    `Artifact set: \`${input.preview.artifactSetSha256}\``,
    `Patch: \`${input.preview.patchSha256}\` (${input.preview.patchBytes} bytes)`,
    `Untracked archive: \`${input.preview.untrackedArchiveSha256 ?? "none"}\` (${input.preview.untrackedArchiveBytes} bytes)`,
    `Mission decision request: **${input.preview.missionDecision}**`,
    "",
    "The Mission decision is recorded as a requested postcondition. This promotion does not retire Mission authority.",
    "This operation changes workspace files only. It does not commit, push, publish, deploy, or delete retained evidence.",
    "",
    `## Exact retained patch (${patchEncoding})`,
    "",
    fence,
    patchText,
    fence,
    "",
    "## Exact untracked inventory",
    "",
    fence,
    inventory,
    fence,
    "",
  ].join("\n");
}

function codeFence(value: string): string {
  const runs = value.match(/`+/gu) ?? [];
  const longest = runs.reduce((maximum, run) => Math.max(maximum, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

function markdownCode(value: string): string {
  return value.replace(/`/gu, "ˋ").replace(/[\u0000-\u001f\u007f]/gu, " ");
}

export const ARENA_PROMOTION_OPERATOR_PREVIEW_LIMITS = Object.freeze({
  maxPatchBytes: MAX_OPERATOR_PATCH_PREVIEW_BYTES,
});

interface InventoryEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mode: number;
}

async function exactGeneration(
  directory: string,
  hasArchive: boolean,
): Promise<{
  readonly version: 1 | 2;
  readonly inventoryName: "inventory.v1.json" | "inventory.v2.json";
  readonly archiveName: "untracked.v1.bin" | "untracked.v2.bin";
}> {
  const entries = await import("node:fs/promises").then((fs) =>
    fs.readdir(directory, { withFileTypes: true }));
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("Arena promotion artifact directory contains a non-file entry.");
  }
  const names = entries.map((entry) => entry.name).sort(compareUtf8);
  const generations = ([1, 2] as const).map((version) => ({
    version,
    inventoryName: `inventory.v${version}.json` as const,
    archiveName: `untracked.v${version}.bin` as const,
  })).filter((generation) => {
    const expected = [
      "artifact-set.v1.json",
      generation.inventoryName,
      "patch.bin",
      ...(hasArchive ? [generation.archiveName] : []),
    ].sort(compareUtf8);
    return expected.length === names.length
      && expected.every((name, index) => name === names[index]);
  });
  if (generations.length !== 1) {
    throw new Error("Arena promotion requires one exact artifact generation.");
  }
  return generations[0]!;
}

function parseInventory(bytes: Buffer, version: 1 | 2): readonly InventoryEntry[] {
  if (bytes.at(-1) !== 0x0a) {
    throw new Error("Arena promotion inventory is not newline terminated.");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error("Arena promotion inventory is not canonical UTF-8.");
  }
  const value = JSON.parse(text.slice(0, -1)) as unknown;
  if (!isPlainRecord(value)
    || value.schemaVersion !== version
    || !Array.isArray(value.entries)
    || value.entries.length > MAX_ENTRIES) {
    throw new Error("Arena promotion inventory schema is invalid.");
  }
  if (`${canonicalArenaManifestJson(value)}\n` !== text) {
    throw new Error("Arena promotion inventory is not canonical JSON.");
  }
  const seen = new Set<string>();
  const result = value.entries.map((entry, index) => {
    if (!isPlainRecord(entry)) {
      throw new Error(`Arena promotion inventory entry ${index + 1} is invalid.`);
    }
    const expectedKeys = version === 2
      ? ["bytes", "mode", "path", "sha256"]
      : ["bytes", "path", "sha256"];
    assertExactKeys(entry, expectedKeys, "promotion inventory entry");
    const gitPath = safeGitPath(entry.path);
    const key = process.platform === "win32" ? gitPath.toLowerCase() : gitPath;
    if (seen.has(key)) throw new Error("Arena promotion inventory duplicates a path.");
    seen.add(key);
    if (!Number.isSafeInteger(entry.bytes)
      || (entry.bytes as number) < 0
      || (entry.bytes as number) > MAX_ARCHIVE_BYTES
      || typeof entry.sha256 !== "string"
      || !SHA256_PATTERN.test(entry.sha256)
      || (version === 2
        && (!Number.isSafeInteger(entry.mode)
          || (entry.mode as number) < 0
          || (entry.mode as number) > 0o777))) {
      throw new Error(`Arena promotion inventory entry ${index + 1} is invalid.`);
    }
    return Object.freeze({
      path: gitPath,
      bytes: entry.bytes as number,
      sha256: entry.sha256,
      mode: version === 2 ? entry.mode as number : 0o600,
    });
  });
  const sorted = [...result].sort((left, right) => compareUtf8(left.path, right.path));
  if (result.some((entry, index) => entry.path !== sorted[index]?.path)) {
    throw new Error("Arena promotion inventory paths are not sorted.");
  }
  return Object.freeze(result);
}

function parseArchive(
  archive: Buffer,
  inventory: readonly InventoryEntry[],
  version: 1 | 2,
): readonly ArenaPromotionUntrackedEntry[] {
  const magic = version === 2 ? V2_MAGIC : V1_MAGIC;
  if (!archive.subarray(0, magic.byteLength).equals(magic)) {
    throw new Error("Arena promotion archive magic is invalid.");
  }
  let offset = magic.byteLength;
  const result = inventory.map((expected, index) => {
    const headerBytes = version === 2 ? 16 : 12;
    if (offset + headerBytes > archive.byteLength) {
      throw new Error("Arena promotion archive is truncated before an entry header.");
    }
    const pathBytes = archive.readUInt32BE(offset);
    const contentBytes = Number(archive.readBigUInt64BE(offset + 4));
    const mode = version === 2 ? archive.readUInt32BE(offset + 12) : 0o600;
    offset += headerBytes;
    if (pathBytes < 1
      || pathBytes > MAX_PATH_BYTES
      || !Number.isSafeInteger(contentBytes)
      || contentBytes !== expected.bytes
      || mode !== expected.mode
      || offset + pathBytes + contentBytes > archive.byteLength) {
      throw new Error(`Arena promotion archive entry ${index + 1} is invalid.`);
    }
    let decoded: string;
    try {
      decoded = UTF8.decode(archive.subarray(offset, offset + pathBytes));
    } catch (error) {
      throw new Error("Arena promotion archive path is not valid UTF-8.", {
        cause: error,
      });
    }
    offset += pathBytes;
    const gitPath = safeGitPath(decoded);
    const content = Buffer.from(archive.subarray(offset, offset + contentBytes));
    offset += contentBytes;
    if (gitPath !== expected.path || digest(content) !== expected.sha256) {
      throw new Error(`Arena promotion archive entry ${index + 1} disagrees with inventory.`);
    }
    return Object.freeze({ ...expected, content });
  });
  if (offset !== archive.byteLength) {
    throw new Error("Arena promotion archive has trailing or uninventoryed bytes.");
  }
  return Object.freeze(result);
}

function safeGitPath(value: unknown): string {
  if (typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
    || value.startsWith("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f:]/u.test(value)) {
    throw new Error("Arena promotion path is unsafe.");
  }
  const segments = value.split("/");
  if (segments.some((segment) =>
    segment.length === 0
    || segment === "."
    || segment === ".."
    || segment.toLowerCase() === ".git"
    || /[. ]$/u.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) {
    throw new Error("Arena promotion path is unsafe.");
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length
    || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`Arena ${label} has an invalid exact schema.`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
