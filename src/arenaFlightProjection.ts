import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import {
  canonicalArenaManifestJson,
  type ArenaBrowserJourneyRecordedPayload,
  type ArenaContestantFinishedPayload,
  type ArenaEvidencePreservedPayload,
  type ArenaMainWorkspaceObservedPayload,
  type ArenaManifestEvent,
  type ArenaManifestReplay,
  type ArenaRunFinalizedPayload,
  type ArenaRunLockedPayload,
  type ArenaVerificationRecordedPayload,
  type ArenaWorktreeProvisionedPayload,
} from "./arenaRunManifest";
import type { ArenaCleanupStepPayload } from "./arenaCleanup";
import type { ArenaManifestStore } from "./arenaStore";
import {
  createArenaPrivateFile,
  ensureArenaPrivateDirectory,
  prepareArenaPrivateStorage,
  readArenaPrivateFile,
  serializeArenaPrivateWork,
  type ArenaPrivateStorageBoundary,
} from "./arenaPrivateStorage";

export const ARENA_FLIGHT_PROJECTION_SCHEMA_ID =
  "hydra.flight.arena.v1" as const;
export const ARENA_FLIGHT_PROJECTION_SCHEMA_VERSION = 1 as const;
export const ARENA_FLIGHT_PROJECTION_LIMITS = Object.freeze({
  maxRecords: 10_000,
  maxRecordBytes: 16 * 1024,
  maxDirectoryEntries: 20_000,
});
export const ARENA_FLIGHT_PROJECTION_GENESIS_SHA256 = createHash("sha256")
  .update("hydra.flight.arena.v1.genesis\u0000", "utf8")
  .digest("hex");

const PROJECTION_HASH_DOMAIN = "hydra.flight.arena.v1.record\u0000";
const RECORD_NAME_PATTERN = /^(\d{8})\.v1\.json$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const STATUS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface ArenaFlightProjectionRecord {
  readonly schemaId: typeof ARENA_FLIGHT_PROJECTION_SCHEMA_ID;
  readonly schemaVersion: typeof ARENA_FLIGHT_PROJECTION_SCHEMA_VERSION;
  readonly runId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly arenaEventType: ArenaManifestEvent["type"];
  readonly arenaEventSha256: string;
  readonly missionBindingSha256: string;
  readonly contestantId: string | null;
  readonly status: string;
  readonly receiptSha256: string | null;
  readonly artifactSetSha256: string | null;
  readonly evidenceMatrixSha256: string | null;
  readonly previousProjectionSha256: string;
  readonly projectionSha256: string;
}

export interface ArenaFlightProjectionReplay {
  readonly runId: string;
  readonly records: readonly ArenaFlightProjectionRecord[];
  readonly latestProjectionSha256: string;
}

export interface ArenaFlightProjectionSink {
  project(event: ArenaManifestEvent): Promise<ArenaFlightProjectionRecord>;
}

export interface ArenaFlightProjectionStore extends ArenaFlightProjectionSink {
  load(runId: string): Promise<ArenaFlightProjectionReplay>;
}

/**
 * A non-authoritative manifest decorator. Arena appends complete first; Flight
 * projection is then serialized in manifest order and fenced on its first
 * failure so a diagnostic outage can neither cancel nor duplicate Arena work.
 */
export interface ArenaFlightProjectingManifestStore extends ArenaManifestStore {
  readonly projectionComplete: boolean;
  flushProjection(): Promise<boolean>;
}

export function createArenaFlightProjectingManifestStore(
  source: ArenaManifestStore,
  sink: ArenaFlightProjectionSink,
  onProjectionFailure?: (
    error: unknown,
    event: ArenaManifestEvent,
  ) => void,
): ArenaFlightProjectingManifestStore {
  let projectionComplete = true;
  let projectionTail: Promise<void> = Promise.resolve();

  const projected: ArenaFlightProjectingManifestStore = {
    append: async (draft: Parameters<ArenaManifestStore["append"]>[0]) => {
      const event = await source.append(draft);
      projectionTail = projectionTail.then(async () => {
        if (!projectionComplete) return;
        try {
          await sink.project(event);
        } catch (error) {
          projectionComplete = false;
          try {
            onProjectionFailure?.(error, event);
          } catch {
            // A diagnostic callback is not allowed to regain Arena authority.
          }
        }
      });
      return event;
    },
    load: (runId: string) => source.load(runId),
    listRunIds: () => source.listRunIds(),
    get projectionComplete() {
      return projectionComplete;
    },
    async flushProjection() {
      await projectionTail;
      return projectionComplete;
    },
  };
  return Object.freeze(projected);
}

export class FileArenaFlightProjectionStore
  implements ArenaFlightProjectionStore {
  private boundaryPromise: Promise<ArenaPrivateStorageBoundary> | undefined;

  constructor(readonly privateWorkspaceRoot: string) {}

  async project(event: ArenaManifestEvent): Promise<ArenaFlightProjectionRecord> {
    validateManifestProjectionInput(event);
    const boundary = await this.boundary();
    const directory = await ensureArenaPrivateDirectory(boundary, [
      "support",
      "flight-projection",
      event.runId,
    ]);
    return serializeArenaPrivateWork(boundary, directory, async () => {
      const current = await loadProjectionRecords(
        boundary,
        directory,
        event.runId,
      );
      const existing = current[event.sequence - 1];
      const previousProjectionSha256 = event.sequence === 1
        ? ARENA_FLIGHT_PROJECTION_GENESIS_SHA256
        : current[event.sequence - 2]?.projectionSha256;
      if (!previousProjectionSha256) {
        throw new Error(
          "Arena Flight projection cannot skip a manifest sequence.",
        );
      }
      const missionBindingSha256 = event.sequence === 1
        ? (event.payload as ArenaRunLockedPayload).mission.bindingSha256
        : current[0]?.missionBindingSha256;
      if (!missionBindingSha256) {
        throw new Error("Arena Flight projection has no locked Mission binding.");
      }
      const candidate = createProjectionRecord(
        event,
        missionBindingSha256,
        previousProjectionSha256,
      );
      if (existing) {
        if (canonicalArenaManifestJson(existing)
          !== canonicalArenaManifestJson(candidate)) {
          throw new Error(
            "Arena Flight projection retry conflicts with durable state.",
          );
        }
        return existing;
      }
      if (current.length !== event.sequence - 1) {
        throw new Error(
          "Arena Flight projection history is ahead of the supplied event.",
        );
      }
      const filePath = arenaFlightProjectionRecordPath(
        this.privateWorkspaceRoot,
        event.runId,
        event.sequence,
      );
      const bytes = Buffer.from(
        `${canonicalArenaManifestJson(candidate)}\n`,
        "utf8",
      );
      if (bytes.byteLength > ARENA_FLIGHT_PROJECTION_LIMITS.maxRecordBytes) {
        throw new Error("Arena Flight projection record exceeds its byte bound.");
      }
      await createArenaPrivateFile(filePath, bytes, boundary);
      return candidate;
    });
  }

  async load(runId: string): Promise<ArenaFlightProjectionReplay> {
    assertIdentifier(runId, "run ID");
    const boundary = await this.boundary();
    const directory = projectionDirectory(this.privateWorkspaceRoot, runId);
    try {
      return await serializeArenaPrivateWork(boundary, directory, async () => {
        const records = await loadProjectionRecords(boundary, directory, runId);
        return Object.freeze({
          runId,
          records: Object.freeze(records),
          latestProjectionSha256:
            records.at(-1)?.projectionSha256
              ?? ARENA_FLIGHT_PROJECTION_GENESIS_SHA256,
        });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return Object.freeze({
          runId,
          records: Object.freeze([]),
          latestProjectionSha256: ARENA_FLIGHT_PROJECTION_GENESIS_SHA256,
        });
      }
      throw error;
    }
  }

  private boundary(): Promise<ArenaPrivateStorageBoundary> {
    this.boundaryPromise ??= prepareArenaPrivateStorage(
      this.privateWorkspaceRoot,
    );
    return this.boundaryPromise;
  }
}

export async function openFileArenaFlightProjectionStore(
  privateWorkspaceRoot: string,
): Promise<FileArenaFlightProjectionStore> {
  const store = new FileArenaFlightProjectionStore(privateWorkspaceRoot);
  const boundary = await prepareArenaPrivateStorage(privateWorkspaceRoot);
  await ensureArenaPrivateDirectory(boundary, ["support", "flight-projection"]);
  return store;
}

export function arenaFlightProjectionRecordPath(
  privateWorkspaceRoot: string,
  runId: string,
  sequence: number,
): string {
  assertIdentifier(runId, "run ID");
  if (!Number.isSafeInteger(sequence)
    || sequence < 1
    || sequence > ARENA_FLIGHT_PROJECTION_LIMITS.maxRecords) {
    throw new Error("Arena Flight projection sequence is outside its bound.");
  }
  return path.join(
    projectionDirectory(privateWorkspaceRoot, runId),
    `${String(sequence).padStart(8, "0")}.v1.json`,
  );
}

export async function verifyArenaFlightProjection(
  privateWorkspaceRoot: string,
  replay: ArenaManifestReplay,
): Promise<ArenaFlightProjectionReplay> {
  const projected = await new FileArenaFlightProjectionStore(
    privateWorkspaceRoot,
  ).load(replay.runId);
  if (projected.records.length !== replay.records.length) {
    throw new Error(
      "Arena Flight projection does not cover the complete manifest history.",
    );
  }
  let previous = ARENA_FLIGHT_PROJECTION_GENESIS_SHA256;
  const missionBindingSha256 = replay.lock.mission.bindingSha256;
  for (const [index, event] of replay.records.entries()) {
    const expected = createProjectionRecord(
      event,
      missionBindingSha256,
      previous,
    );
    const actual = projected.records[index];
    if (!actual
      || canonicalArenaManifestJson(actual)
        !== canonicalArenaManifestJson(expected)) {
      throw new Error(
        `Arena Flight projection record ${index + 1} does not bind its manifest event.`,
      );
    }
    previous = actual.projectionSha256;
  }
  return projected;
}

function createProjectionRecord(
  event: ArenaManifestEvent,
  missionBindingSha256: string,
  previousProjectionSha256: string,
): ArenaFlightProjectionRecord {
  assertDigest(missionBindingSha256, "Mission binding");
  assertDigest(previousProjectionSha256, "previous projection");
  const metadata = projectionMetadata(event);
  const withoutHash = {
    schemaId: ARENA_FLIGHT_PROJECTION_SCHEMA_ID,
    schemaVersion: ARENA_FLIGHT_PROJECTION_SCHEMA_VERSION,
    runId: event.runId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    arenaEventType: event.type,
    arenaEventSha256: event.eventSha256,
    missionBindingSha256,
    contestantId: metadata.contestantId,
    status: metadata.status,
    receiptSha256: metadata.receiptSha256,
    artifactSetSha256: metadata.artifactSetSha256,
    evidenceMatrixSha256: metadata.evidenceMatrixSha256,
    previousProjectionSha256,
  };
  return Object.freeze({
    ...withoutHash,
    projectionSha256: hashCanonical(PROJECTION_HASH_DOMAIN, withoutHash),
  });
}

function projectionMetadata(event: ArenaManifestEvent): {
  readonly contestantId: string | null;
  readonly status: string;
  readonly receiptSha256: string | null;
  readonly artifactSetSha256: string | null;
  readonly evidenceMatrixSha256: string | null;
} {
  const contestantId = "contestantId" in event.payload
    ? (event.payload as { readonly contestantId: string }).contestantId
    : null;
  let status: string;
  let receiptSha256: string | null = null;
  let artifactSetSha256: string | null = null;
  let evidenceMatrixSha256: string | null = null;
  switch (event.type) {
    case "arenaRunLocked":
      status = "locked";
      break;
    case "arenaMainWorkspaceObserved": {
      const payload = event.payload as ArenaMainWorkspaceObservedPayload;
      status = `${payload.observationKind}:${payload.status}`;
      receiptSha256 = payload.monitorReceiptSha256;
      break;
    }
    case "arenaWorktreeRegistered":
      status = "registered";
      receiptSha256 = (event.payload as { registrationSha256: string })
        .registrationSha256;
      break;
    case "arenaWorktreeProvisioned": {
      const payload = event.payload as ArenaWorktreeProvisionedPayload;
      status = payload.preparationStatus;
      receiptSha256 = payload.preparationReceiptSha256;
      break;
    }
    case "arenaContestantStarted":
      status = "started";
      break;
    case "arenaContestantFinished": {
      const payload = event.payload as ArenaContestantFinishedPayload;
      status = payload.status;
      receiptSha256 = payload.outputSha256;
      break;
    }
    case "arenaVerificationRecorded": {
      const payload = event.payload as ArenaVerificationRecordedPayload;
      status = payload.status;
      receiptSha256 = payload.receiptSha256;
      break;
    }
    case "arenaBrowserJourneyRecorded": {
      const payload = event.payload as ArenaBrowserJourneyRecordedPayload;
      status = payload.status;
      receiptSha256 = payload.receiptSha256;
      break;
    }
    case "arenaEvidencePreserved": {
      const payload = event.payload as ArenaEvidencePreservedPayload;
      status = "preserved";
      receiptSha256 = payload.receiptsRootSha256;
      artifactSetSha256 = payload.artifactSetSha256;
      break;
    }
    case "arenaRunFinalized": {
      const payload = event.payload as ArenaRunFinalizedPayload;
      status = `${payload.outcome}:${payload.comparison}`;
      evidenceMatrixSha256 = payload.evidenceMatrixSha256;
      break;
    }
    case "arenaCleanupStepRecorded": {
      const payload = event.payload as ArenaCleanupStepPayload;
      status = `${payload.step}:${payload.outcome}`;
      receiptSha256 = payload.stepReceiptSha256;
      break;
    }
  }
  return {
    contestantId,
    status,
    receiptSha256,
    artifactSetSha256,
    evidenceMatrixSha256,
  };
}

async function loadProjectionRecords(
  boundary: ArenaPrivateStorageBoundary,
  directory: string,
  runId: string,
): Promise<ArenaFlightProjectionRecord[]> {
  const handle = await fs.opendir(directory);
  const names: string[] = [];
  let seen = 0;
  try {
    for await (const entry of handle) {
      seen += 1;
      if (seen > ARENA_FLIGHT_PROJECTION_LIMITS.maxDirectoryEntries) {
        throw new Error("Arena Flight projection directory exceeds its scan bound.");
      }
      const match = RECORD_NAME_PATTERN.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(
          `Arena Flight projection directory contains an unexpected entry: ${entry.name}`,
        );
      }
      names.push(entry.name);
    }
  } finally {
    await handle.close().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error;
    });
  }
  names.sort();
  if (names.length > ARENA_FLIGHT_PROJECTION_LIMITS.maxRecords) {
    throw new Error("Arena Flight projection exceeds its record-count bound.");
  }
  const records: ArenaFlightProjectionRecord[] = [];
  let previous = ARENA_FLIGHT_PROJECTION_GENESIS_SHA256;
  for (const [index, name] of names.entries()) {
    const expectedName = `${String(index + 1).padStart(8, "0")}.v1.json`;
    if (name !== expectedName) {
      throw new Error("Arena Flight projection record sequence is not contiguous.");
    }
    const bytes = await readArenaPrivateFile(
      path.join(directory, name),
      ARENA_FLIGHT_PROJECTION_LIMITS.maxRecordBytes,
      boundary,
    );
    const record = parseProjectionRecord(bytes);
    if (record.runId !== runId
      || record.sequence !== index + 1
      || record.previousProjectionSha256 !== previous) {
      throw new Error("Arena Flight projection record crosses its run or hash chain.");
    }
    if (records.length > 0
      && record.missionBindingSha256 !== records[0]!.missionBindingSha256) {
      throw new Error("Arena Flight projection crosses Mission bindings.");
    }
    records.push(record);
    previous = record.projectionSha256;
  }
  return records;
}

function parseProjectionRecord(bytes: Buffer): ArenaFlightProjectionRecord {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Arena Flight projection is not valid UTF-8.");
  }
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
    throw new Error("Arena Flight projection is torn or multi-row.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    throw new Error("Arena Flight projection contains malformed JSON.");
  }
  if (!isRecord(value)) throw new Error("Arena Flight projection schema is invalid.");
  exactKeys(value, [
    "arenaEventSha256", "arenaEventType", "artifactSetSha256",
    "contestantId", "evidenceMatrixSha256", "missionBindingSha256",
    "occurredAt", "previousProjectionSha256", "projectionSha256", "receiptSha256",
    "runId", "schemaId", "schemaVersion", "sequence", "status",
  ]);
  if (value.schemaId !== ARENA_FLIGHT_PROJECTION_SCHEMA_ID
    || value.schemaVersion !== ARENA_FLIGHT_PROJECTION_SCHEMA_VERSION
    || typeof value.arenaEventType !== "string"
    || ![
      "arenaRunLocked", "arenaMainWorkspaceObserved", "arenaWorktreeRegistered",
      "arenaWorktreeProvisioned", "arenaContestantStarted", "arenaContestantFinished",
      "arenaVerificationRecorded", "arenaBrowserJourneyRecorded",
      "arenaEvidencePreserved", "arenaRunFinalized", "arenaCleanupStepRecorded",
    ].includes(value.arenaEventType)
    || !Number.isSafeInteger(value.sequence)
    || (value as { sequence: number }).sequence < 1
    || typeof value.occurredAt !== "string"
    || !isCanonicalTimestamp(value.occurredAt)
    || typeof value.status !== "string"
    || !STATUS_PATTERN.test(value.status)) {
    throw new Error("Arena Flight projection has invalid typed fields.");
  }
  const withoutHash = {
    schemaId: ARENA_FLIGHT_PROJECTION_SCHEMA_ID,
    schemaVersion: ARENA_FLIGHT_PROJECTION_SCHEMA_VERSION,
    runId: identifier(value.runId),
    sequence: value.sequence as number,
    occurredAt: value.occurredAt,
    arenaEventType: value.arenaEventType as ArenaManifestEvent["type"],
    arenaEventSha256: digest(value.arenaEventSha256),
    missionBindingSha256: digest(value.missionBindingSha256),
    contestantId: nullableIdentifier(value.contestantId),
    status: value.status,
    receiptSha256: nullableDigest(value.receiptSha256),
    artifactSetSha256: nullableDigest(value.artifactSetSha256),
    evidenceMatrixSha256: nullableDigest(value.evidenceMatrixSha256),
    previousProjectionSha256: digest(value.previousProjectionSha256),
  };
  const projectionSha256 = digest(value.projectionSha256);
  if (projectionSha256 !== hashCanonical(PROJECTION_HASH_DOMAIN, withoutHash)) {
    throw new Error("Arena Flight projection hash is invalid.");
  }
  const record = Object.freeze({ ...withoutHash, projectionSha256 });
  if (`${canonicalArenaManifestJson(record)}\n` !== text) {
    throw new Error("Arena Flight projection is not canonical.");
  }
  return record;
}

function projectionDirectory(privateWorkspaceRoot: string, runId: string): string {
  assertIdentifier(runId, "run ID");
  return path.resolve(
    privateWorkspaceRoot,
    "arena",
    "support",
    "flight-projection",
    runId,
  );
}

function validateManifestProjectionInput(event: ArenaManifestEvent): void {
  assertIdentifier(event.runId, "run ID");
  assertDigest(event.eventSha256, "Arena event");
  if (!Number.isSafeInteger(event.sequence)
    || event.sequence < 1
    || event.sequence > ARENA_FLIGHT_PROJECTION_LIMITS.maxRecords) {
    throw new Error("Arena Flight projection event sequence is invalid.");
  }
  if (event.sequence === 1 && event.type !== "arenaRunLocked") {
    throw new Error("Arena Flight projection must begin with the locked run.");
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new Error("Arena Flight projection has unknown or missing fields.");
  }
}

function nullableIdentifier(value: unknown): string | null {
  return value === null ? null : identifier(value);
}

function identifier(value: unknown): string {
  assertIdentifier(value, "identifier");
  return value;
}

function nullableDigest(value: unknown): string | null {
  return value === null ? null : digest(value);
}

function digest(value: unknown): string {
  assertDigest(value, "digest");
  return value;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Arena Flight projection ${label} is invalid.`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`Arena Flight projection ${label} digest is invalid.`);
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hashCanonical(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(canonicalArenaManifestJson(value), "utf8")
    .digest("hex");
}
