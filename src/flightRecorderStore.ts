import { createHash } from "node:crypto";
import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import {
  appendFileSafely,
  atomicWriteFile,
  ensureFile,
  readFileHead,
  serializePerFileAcrossProcesses,
} from "./fileQueue";
import {
  FLIGHT_LIMITS,
  FLIGHT_GENESIS_SHA256,
  FLIGHT_SCHEMA_VERSION,
  FlightTraceValidationError,
  canonicalFlightJson,
  createFlightRecord,
  isFlightRecord,
  isFlightTraceId,
  replayFlightTrace,
  type FlightLimitReason,
  type FlightRecord,
  type FlightRecordDraft,
  type FlightTraceFinishedPayload,
  type FlightTraceLimitedPayload,
  type FlightTraceReplay,
  type FlightTraceStartedPayload,
} from "./flightRecorderProtocol";

export interface FlightRecorderStoreLimits {
  readonly maxTraceBytes: number;
  readonly maxRecordsPerTrace: number;
  readonly maxRecordBytes: number;
  readonly reservedTerminalRecords: number;
  readonly reservedTerminalBytes: number;
}

export const DEFAULT_FLIGHT_STORE_LIMITS: FlightRecorderStoreLimits = Object.freeze({
  maxTraceBytes: FLIGHT_LIMITS.maxTraceBytes,
  maxRecordsPerTrace: FLIGHT_LIMITS.maxRecordsPerTrace,
  maxRecordBytes: FLIGHT_LIMITS.maxRecordBytes,
  reservedTerminalRecords: FLIGHT_LIMITS.reservedTerminalRecords,
  reservedTerminalBytes: FLIGHT_LIMITS.reservedTerminalBytes,
});

export interface FlightRecorderPaths {
  readonly rootPath: string;
  readonly tracesPath: string;
  readonly indexPath: string;
  readonly ownersPath: string;
}

export type FlightCapacityDecision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: Extract<FlightLimitReason,
      "recordCapacity" | "byteCapacity" | "recordSize"> };

export class FlightTraceCapacityError extends Error {
  constructor(
    readonly reason: Extract<FlightLimitReason,
      "recordCapacity" | "byteCapacity" | "recordSize">,
  ) {
    super(`Flight Recorder ${reason} reached its reserved bound.`);
    this.name = "FlightTraceCapacityError";
  }
}

export class FlightTraceFileError extends Error {
  constructor(
    readonly code:
      | "torn"
      | "malformed"
      | "unknownVersion"
      | "oversized"
      | "blankLine"
      | "recordCount"
      | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "FlightTraceFileError";
  }
}

export interface FlightRecorderStore {
  readonly limits: FlightRecorderStoreLimits;
  append(draft: FlightRecordDraft): Promise<FlightRecord>;
  load(traceId: string): Promise<FlightTraceReplay | undefined>;
  listTraceIds(): Promise<readonly string[]>;
}

export interface FlightTraceIndexEntry {
  readonly schemaVersion: typeof FLIGHT_SCHEMA_VERSION;
  readonly traceId: string;
  readonly completeness: "active" | "complete" | "limited" | "incomplete" | "invalid";
  readonly occurredAt: string | null;
  readonly recordCount: number;
  readonly traceBytes: number;
}

export interface FlightOwnerLease {
  readonly ownerId: string;
  isOwnerActive(ownerId: string): Promise<boolean>;
  dispose(): void;
}

export interface FlightRetentionResult {
  readonly removedTraceIds: readonly string[];
  readonly retainedTraceIds: readonly string[];
  readonly totalBytes: number;
}

const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 10_000;
const MAX_OWNER_LEASE_BYTES = 16 * 1024;
const OWNER_HEARTBEAT_MS = 5_000;
const OWNER_FRESH_MS = 20_000;
const activeLocalOwners = new Set<string>();

export function flightRecorderPaths(privateWorkspaceRoot: string): FlightRecorderPaths {
  const rootPath = path.resolve(privateWorkspaceRoot, "flight");
  return {
    rootPath,
    tracesPath: path.join(rootPath, "traces"),
    indexPath: path.join(rootPath, "index.v1.jsonl"),
    ownersPath: path.join(rootPath, "owners"),
  };
}

export function flightTracePath(privateWorkspaceRoot: string, traceId: string): string {
  if (!isFlightTraceId(traceId)) {
    throw new Error("Flight trace ID is not safe for private storage.");
  }
  const { tracesPath } = flightRecorderPaths(privateWorkspaceRoot);
  const candidate = path.resolve(tracesPath, `${traceId}.v1.jsonl`);
  if (path.dirname(candidate) !== tracesPath) {
    throw new Error("Flight trace path escapes the private trace directory.");
  }
  return candidate;
}

export function evaluateFlightAppendCapacity(
  input: {
    readonly currentRecords: number;
    readonly currentBytes: number;
    readonly candidateBytes: number;
    readonly recordType: FlightRecord["recordType"];
  },
  limits: FlightRecorderStoreLimits = DEFAULT_FLIGHT_STORE_LIMITS,
): FlightCapacityDecision {
  validateStoreLimits(limits);
  if (input.candidateBytes > limits.maxRecordBytes) {
    return { accepted: false, reason: "recordSize" };
  }
  const nextRecords = input.currentRecords + 1;
  const nextBytes = input.currentBytes + input.candidateBytes;
  if (nextRecords > limits.maxRecordsPerTrace) {
    return { accepted: false, reason: "recordCapacity" };
  }
  if (nextBytes > limits.maxTraceBytes) {
    return { accepted: false, reason: "byteCapacity" };
  }

  if (input.recordType === "traceFinished") return { accepted: true };
  if (input.recordType === "traceLimited") {
    if (nextRecords > limits.maxRecordsPerTrace - 1) {
      return { accepted: false, reason: "recordCapacity" };
    }
    if (nextBytes > limits.maxTraceBytes - limits.maxRecordBytes) {
      return { accepted: false, reason: "byteCapacity" };
    }
    return { accepted: true };
  }
  if (nextRecords > limits.maxRecordsPerTrace - limits.reservedTerminalRecords) {
    return { accepted: false, reason: "recordCapacity" };
  }
  if (nextBytes > limits.maxTraceBytes - limits.reservedTerminalBytes) {
    return { accepted: false, reason: "byteCapacity" };
  }
  return { accepted: true };
}

export class FileFlightRecorderStore implements FlightRecorderStore {
  readonly limits: FlightRecorderStoreLimits;
  readonly paths: FlightRecorderPaths;

  constructor(
    readonly privateWorkspaceRoot: string,
    limits: FlightRecorderStoreLimits = DEFAULT_FLIGHT_STORE_LIMITS,
  ) {
    validateStoreLimits(limits);
    this.limits = Object.freeze({ ...limits });
    this.paths = flightRecorderPaths(privateWorkspaceRoot);
  }

  async append(draft: FlightRecordDraft): Promise<FlightRecord> {
    const filePath = flightTracePath(this.privateWorkspaceRoot, draft.traceId);
    return serializePerFileAcrossProcesses(filePath, async () => {
      await ensureFile(filePath);
      const loaded = await loadTraceFile(filePath, this.limits);
      const existing = loaded.records.find((record) => record.recordId === draft.recordId);
      if (existing) {
        if (canonicalFlightJson(recordToDraft(existing)) === canonicalFlightJson(draft)) {
          return existing;
        }
        throw new FlightTraceFileError(
          "invalid",
          `Flight record ID ${draft.recordId} collided with different metadata.`,
        );
      }
      const previous = loaded.records.at(-1);
      const candidate = createFlightRecord(
        draft,
        loaded.records.length + 1,
        previous?.recordSha256
          ?? FLIGHT_GENESIS_SHA256,
      );
      const line = `${canonicalFlightJson(candidate)}\n`;
      const candidateBytes = Buffer.byteLength(line, "utf8");
      const capacity = evaluateFlightAppendCapacity({
        currentRecords: loaded.records.length,
        currentBytes: loaded.totalBytes,
        candidateBytes,
        recordType: candidate.recordType,
      }, this.limits);
      if (!capacity.accepted) throw new FlightTraceCapacityError(capacity.reason);

      const candidateRecords = [...loaded.records, candidate];
      replayFlightTrace(candidateRecords);
      await appendFileSafely(filePath, line);
      return candidate;
    });
  }

  async load(traceId: string): Promise<FlightTraceReplay | undefined> {
    const filePath = flightTracePath(this.privateWorkspaceRoot, traceId);
    return serializePerFileAcrossProcesses(filePath, async () => {
      let loaded: LoadedTraceFile;
      try {
        loaded = await loadTraceFile(filePath, this.limits);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      if (loaded.records.length === 0) return undefined;
      return replayFlightTrace(loaded.records);
    });
  }

  async listTraceIds(): Promise<readonly string[]> {
    await ensureFile(this.paths.indexPath);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.paths.tracesPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const traceIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".v1.jsonl")) continue;
      const traceId = entry.name.slice(0, -".v1.jsonl".length);
      if (isFlightTraceId(traceId)) traceIds.push(traceId);
      if (traceIds.length >= MAX_INDEX_ENTRIES) break;
    }
    return traceIds.sort();
  }
}

export async function openFileFlightRecorderStore(
  privateWorkspaceRoot: string,
  limits: FlightRecorderStoreLimits = DEFAULT_FLIGHT_STORE_LIMITS,
): Promise<FileFlightRecorderStore> {
  const store = new FileFlightRecorderStore(privateWorkspaceRoot, limits);
  await ensureFile(store.paths.indexPath);
  return store;
}

/**
 * Rebuildable discovery cache only. Trace load and replay never consult this
 * file, so a missing, stale, or malicious index cannot create eligibility.
 */
export async function rebuildFlightRecorderIndex(
  store: FileFlightRecorderStore,
): Promise<readonly FlightTraceIndexEntry[]> {
  const entries: FlightTraceIndexEntry[] = [];
  for (const traceId of await store.listTraceIds()) {
    const filePath = flightTracePath(store.privateWorkspaceRoot, traceId);
    let file: Awaited<ReturnType<typeof readFileHead>> | undefined;
    try {
      file = await readFileHead(filePath, store.limits.maxTraceBytes);
      const replay = await store.load(traceId);
      entries.push({
        schemaVersion: FLIGHT_SCHEMA_VERSION,
        traceId,
        completeness: replay?.completeness ?? "invalid",
        occurredAt: replay?.records.at(-1)?.occurredAt ?? null,
        recordCount: replay?.records.length ?? 0,
        traceBytes: file.totalBytes,
      });
    } catch {
      entries.push({
        schemaVersion: FLIGHT_SCHEMA_VERSION,
        traceId,
        completeness: "invalid",
        occurredAt: null,
        recordCount: 0,
        traceBytes: file?.totalBytes ?? 0,
      });
    }
  }

  const bounded: FlightTraceIndexEntry[] = [];
  let bytes = 0;
  for (const entry of entries.slice(0, MAX_INDEX_ENTRIES)) {
    const lineBytes = Buffer.byteLength(`${JSON.stringify(entry)}\n`, "utf8");
    if (bytes + lineBytes > MAX_INDEX_BYTES) break;
    bounded.push(entry);
    bytes += lineBytes;
  }
  const content = bounded.map((entry) => JSON.stringify(entry)).join("\n");
  await atomicWriteFile(store.paths.indexPath, content.length === 0 ? "" : `${content}\n`);
  return bounded;
}

export async function startFlightRecorderOwnerLease(
  privateWorkspaceRoot: string,
  ownerId: string,
): Promise<FlightOwnerLease> {
  if (!isSafeOwnerId(ownerId)) throw new Error("Flight Recorder owner ID is invalid.");
  const paths = flightRecorderPaths(privateWorkspaceRoot);
  const leasePath = path.join(
    paths.ownersPath,
    `${hashOwnerId(ownerId)}.v1.json`,
  );
  let disposed = false;
  activeLocalOwners.add(ownerId);

  const writeLease = async (active: boolean): Promise<void> => {
    const record = {
      schemaVersion: FLIGHT_SCHEMA_VERSION,
      ownerId,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      active,
    };
    await serializePerFileAcrossProcesses(leasePath, () =>
      atomicWriteFile(leasePath, `${JSON.stringify(record)}\n`)
    );
  };
  await writeLease(true);
  const heartbeat = setInterval(() => {
    if (!disposed) void writeLease(true).catch(() => undefined);
  }, OWNER_HEARTBEAT_MS);
  heartbeat.unref();

  return {
    ownerId,
    async isOwnerActive(candidateOwnerId: string): Promise<boolean> {
      if (!isSafeOwnerId(candidateOwnerId)) return false;
      if (activeLocalOwners.has(candidateOwnerId)) return true;
      const candidatePath = path.join(
        paths.ownersPath,
        `${hashOwnerId(candidateOwnerId)}.v1.json`,
      );
      let file;
      try {
        file = await readFileHead(candidatePath, MAX_OWNER_LEASE_BYTES);
      } catch {
        return false;
      }
      if (file.truncated || file.totalBytes > MAX_OWNER_LEASE_BYTES) return false;
      let parsed: unknown;
      try {
        parsed = JSON.parse(file.text);
      } catch {
        return false;
      }
      if (!isOwnerLeaseRecord(parsed, candidateOwnerId)) return false;
      if (parsed.pid === process.pid) return activeLocalOwners.has(candidateOwnerId);
      const updatedAt = Date.parse(parsed.updatedAt);
      return Number.isFinite(updatedAt)
        && Math.abs(Date.now() - updatedAt) <= OWNER_FRESH_MS
        && processIsAlive(parsed.pid);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearInterval(heartbeat);
      activeLocalOwners.delete(ownerId);
      void writeLease(false).catch(() => undefined);
    },
  };
}

export async function recoverStaleFlightTraces(
  store: FlightRecorderStore,
  isOwnerActive: (ownerId: string) => Promise<boolean>,
  options: {
    readonly now?: () => string;
    readonly newRecordId?: () => string;
  } = {},
): Promise<readonly string[]> {
  const now = options.now ?? (() => new Date().toISOString());
  const newRecordId = options.newRecordId
    ?? (() => `flight-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const recovered: string[] = [];
  for (const traceId of await store.listTraceIds()) {
    let replay: FlightTraceReplay | undefined;
    try {
      replay = await store.load(traceId);
    } catch {
      continue;
    }
    if (!replay || replay.state !== "active") continue;
    const start = replay.records[0]?.payload as FlightTraceStartedPayload | undefined;
    if (!start || await isOwnerActive(start.ownerId)) continue;
    const occurredAt = monotonicTimestamp(now(), replay.records.at(-1)!.occurredAt);
    try {
      if (!replay.limited) {
        await store.append({
          recordId: newRecordId(),
          traceId,
          occurredAt,
          recordType: "traceLimited",
          operationKind: "roomTurn",
          missionBindingSha256: replay.missionBindingSha256,
          payload: {
            payloadType: "traceLimited",
            reason: "recorderFailure",
            droppedRecordsAtLeast: 1,
            telemetryCompleteness: "limited",
          },
        });
        replay = await store.load(traceId);
      }
      const firstTime = Date.parse(replay!.records[0]!.occurredAt);
      const endTime = Date.parse(occurredAt);
      await store.append({
        recordId: newRecordId(),
        traceId,
        occurredAt,
        recordType: "traceFinished",
        operationKind: "roomTurn",
        missionBindingSha256: replay!.missionBindingSha256,
        payload: {
          payloadType: "traceFinished",
          status: "incomplete",
          durationMs: Math.max(0, endTime - firstTime),
          operationCount: replay!.operationCount,
          openOperationCount: replay!.openOperationCount,
          recordCount: replay!.records.length + 1,
          limited: true,
          incomplete: true,
        },
      });
      recovered.push(traceId);
    } catch {
      // Recovery is best effort. A trace that cannot accept the explicit
      // terminal marker remains active/ineligible rather than being retried.
    }
  }
  return recovered;
}

export async function cleanupFlightRecorderStorage(
  store: FileFlightRecorderStore,
  limits: { readonly maxFiles: number; readonly maxTotalBytes: number },
): Promise<FlightRetentionResult> {
  if (!Number.isSafeInteger(limits.maxFiles)
    || limits.maxFiles < 0
    || !Number.isSafeInteger(limits.maxTotalBytes)
    || limits.maxTotalBytes < 0) {
    throw new Error("Flight Recorder retention bounds must be non-negative integers.");
  }
  const candidates: Array<{
    traceId: string;
    filePath: string;
    bytes: number;
    occurredAt: string;
    active: boolean;
  }> = [];
  for (const traceId of await store.listTraceIds()) {
    const filePath = flightTracePath(store.privateWorkspaceRoot, traceId);
    let stat;
    try {
      stat = await fs.lstat(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
    let replay: FlightTraceReplay | undefined;
    try {
      replay = await store.load(traceId);
    } catch {
      candidates.push({
        traceId,
        filePath,
        bytes: stat.size,
        occurredAt: new Date(stat.mtimeMs).toISOString(),
        active: false,
      });
      continue;
    }
    if (!replay) continue;
    candidates.push({
      traceId,
      filePath,
      bytes: stat.size,
      occurredAt: replay.records.at(-1)!.occurredAt,
      active: replay.state === "active",
    });
  }
  let totalBytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
  let totalFiles = candidates.length;
  const removable = candidates
    .filter((candidate) => !candidate.active)
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  const removedTraceIds: string[] = [];
  const missingTraceIds = new Set<string>();
  for (const candidate of removable) {
    if (totalFiles <= limits.maxFiles && totalBytes <= limits.maxTotalBytes) break;
    const decision = await serializePerFileAcrossProcesses(
      candidate.filePath,
      async (): Promise<
        | { readonly kind: "removed"; readonly bytes: number }
        | { readonly kind: "missing" }
        | { readonly kind: "retained"; readonly bytes: number }
      > => {
        let before: Stats;
        try {
          before = await fs.lstat(candidate.filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { kind: "missing" };
          }
          throw error;
        }
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
          return { kind: "retained", bytes: before.size };
        }

        let replay: FlightTraceReplay | undefined;
        try {
          const loaded = await loadTraceFile(candidate.filePath, store.limits);
          replay = loaded.records.length === 0
            ? undefined
            : replayFlightTrace(loaded.records);
        } catch {
          // A persistently corrupt private trace is retention-eligible. The
          // decision is still made under the append lock, so a valid active
          // trace can never be mistaken for a transient torn append.
        }
        if (replay?.state === "active") {
          return { kind: "retained", bytes: before.size };
        }

        let after: Stats;
        try {
          after = await fs.lstat(candidate.filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { kind: "missing" };
          }
          throw error;
        }
        if (!after.isFile()
          || after.isSymbolicLink()
          || after.nlink !== 1
          || !sameFlightTraceFile(before, after)) {
          return { kind: "retained", bytes: after.size };
        }
        try {
          await fs.unlink(candidate.filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { kind: "missing" };
          }
          throw error;
        }
        return { kind: "removed", bytes: after.size };
      },
    );

    if (decision.kind === "retained") {
      totalBytes += decision.bytes - candidate.bytes;
      continue;
    }
    totalFiles -= 1;
    totalBytes -= candidate.bytes;
    if (decision.kind === "missing") {
      missingTraceIds.add(candidate.traceId);
    } else {
      removedTraceIds.push(candidate.traceId);
    }
  }
  const removed = new Set(removedTraceIds);
  return {
    removedTraceIds,
    retainedTraceIds: candidates
      .map((candidate) => candidate.traceId)
      .filter((traceId) => !removed.has(traceId) && !missingTraceIds.has(traceId)),
    totalBytes,
  };
}

interface LoadedTraceFile {
  readonly records: readonly FlightRecord[];
  readonly totalBytes: number;
}

async function loadTraceFile(
  filePath: string,
  limits: FlightRecorderStoreLimits,
): Promise<LoadedTraceFile> {
  const file = await readFlightTraceHead(filePath, limits.maxTraceBytes);
  if (file.truncated || file.totalBytes > limits.maxTraceBytes) {
    throw new FlightTraceFileError("oversized", "Flight trace exceeds its 8 MiB bound.");
  }
  if (file.text.length === 0) return { records: [], totalBytes: 0 };
  if (!file.text.endsWith("\n")) {
    throw new FlightTraceFileError("torn", "Flight trace is missing its final newline.");
  }
  const lines = file.text.slice(0, -1).split("\n");
  if (lines.length > limits.maxRecordsPerTrace) {
    throw new FlightTraceFileError("recordCount", "Flight trace exceeds its record-count bound.");
  }
  const records: FlightRecord[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) {
      throw new FlightTraceFileError("blankLine", `Flight trace line ${index + 1} is blank.`);
    }
    if (Buffer.byteLength(`${line}\n`, "utf8") > limits.maxRecordBytes) {
      throw new FlightTraceFileError("oversized", `Flight trace line ${index + 1} is oversized.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new FlightTraceFileError("malformed", `Flight trace line ${index + 1} is malformed JSON.`);
    }
    if (typeof parsed === "object"
      && parsed !== null
      && "schemaVersion" in parsed
      && (parsed as { schemaVersion?: unknown }).schemaVersion !== FLIGHT_SCHEMA_VERSION) {
      throw new FlightTraceFileError(
        "unknownVersion",
        `Flight trace line ${index + 1} has an unknown schema version.`,
      );
    }
    if (!isFlightRecord(parsed)) {
      throw new FlightTraceFileError(
        "invalid",
        `Flight trace line ${index + 1} has an unknown or non-exact record shape.`,
      );
    }
    if (line !== canonicalFlightJson(parsed)) {
      throw new FlightTraceFileError(
        "invalid",
        `Flight trace line ${index + 1} is not canonical hydra.flight.v1 JSON.`,
      );
    }
    records.push(parsed);
  }
  if (records.length > 0) {
    try {
      replayFlightTrace(records);
    } catch (error) {
      if (error instanceof FlightTraceValidationError) {
        throw new FlightTraceFileError("invalid", error.message);
      }
      throw error;
    }
  }
  return { records, totalBytes: file.totalBytes };
}

async function readFlightTraceHead(
  filePath: string,
  maxBytes: number,
): Promise<{ readonly text: string; readonly totalBytes: number; readonly truncated: boolean }> {
  const before = await fs.lstat(filePath);
  assertSafeFlightTraceFile(before, filePath);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    assertSafeFlightTraceFile(opened, filePath);
    if (!sameFlightTraceFile(before, opened)) {
      throw new Error(`Refusing to read Flight Recorder trace after path swap: ${filePath}`);
    }
    if (opened.size > maxBytes) {
      return { text: "", totalBytes: opened.size, truncated: true };
    }

    const bytes = Buffer.allocUnsafe(opened.size);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const next = await handle.read(
        bytes,
        bytesRead,
        bytes.length - bytesRead,
        bytesRead,
      );
      if (next.bytesRead === 0) break;
      bytesRead += next.bytesRead;
    }

    const after = await fs.lstat(filePath);
    assertSafeFlightTraceFile(after, filePath);
    if (!sameFlightTraceFile(opened, after)
      || opened.size !== after.size
      || bytesRead !== opened.size) {
      throw new Error(`Refusing to read Flight Recorder trace during mutation: ${filePath}`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, bytesRead),
      );
    } catch {
      throw new FlightTraceFileError(
        "malformed",
        "Flight trace is not valid UTF-8.",
      );
    }
    return { text, totalBytes: opened.size, truncated: false };
  } finally {
    await handle.close();
  }
}

function assertSafeFlightTraceFile(stat: Stats, filePath: string): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(
      `Refusing to read unsafe linked or non-file Flight Recorder trace: ${filePath}`,
    );
  }
}

function sameFlightTraceFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function recordToDraft(record: FlightRecord): FlightRecordDraft {
  return {
    recordId: record.recordId,
    traceId: record.traceId,
    occurredAt: record.occurredAt,
    recordType: record.recordType,
    operationKind: record.operationKind,
    ...(record.operationId === undefined ? {} : { operationId: record.operationId }),
    ...(record.parentOperationId === undefined
      ? {}
      : { parentOperationId: record.parentOperationId }),
    missionBindingSha256: record.missionBindingSha256,
    payload: record.payload,
  };
}

function validateStoreLimits(limits: FlightRecorderStoreLimits): void {
  const values = [
    limits.maxTraceBytes,
    limits.maxRecordsPerTrace,
    limits.maxRecordBytes,
    limits.reservedTerminalRecords,
    limits.reservedTerminalBytes,
  ];
  if (!values.every((value) => Number.isSafeInteger(value) && value > 0)
    || limits.maxTraceBytes > FLIGHT_LIMITS.maxTraceBytes
    || limits.maxRecordsPerTrace > FLIGHT_LIMITS.maxRecordsPerTrace
    || limits.maxRecordBytes > FLIGHT_LIMITS.maxRecordBytes
    || limits.reservedTerminalRecords < 2
    || limits.reservedTerminalRecords >= limits.maxRecordsPerTrace
    || limits.reservedTerminalBytes < 2 * limits.maxRecordBytes
    || limits.reservedTerminalBytes >= limits.maxTraceBytes) {
    throw new Error("Flight Recorder store limits violate the hydra.flight.v1 hard bounds.");
  }
}

function isSafeOwnerId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= FLIGHT_LIMITS.maxIdentifierChars
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function hashOwnerId(ownerId: string): string {
  return createHash("sha256")
    .update("hydra.flight.v1.owner\u0000", "utf8")
    .update(ownerId, "utf8")
    .digest("hex");
}

function isOwnerLeaseRecord(
  value: unknown,
  ownerId: string,
): value is {
  schemaVersion: typeof FLIGHT_SCHEMA_VERSION;
  ownerId: string;
  pid: number;
  updatedAt: string;
  active: true;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const updatedAt = typeof record.updatedAt === "string"
    ? Date.parse(record.updatedAt)
    : Number.NaN;
  return keys.join("\u0000") === [
    "active",
    "ownerId",
    "pid",
    "schemaVersion",
    "updatedAt",
  ].join("\u0000")
    && record.schemaVersion === FLIGHT_SCHEMA_VERSION
    && record.ownerId === ownerId
    && Number.isSafeInteger(record.pid)
    && (record.pid as number) > 0
    && typeof record.updatedAt === "string"
    && Number.isFinite(updatedAt)
    && new Date(updatedAt).toISOString() === record.updatedAt
    && record.active === true;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function monotonicTimestamp(candidate: string, previous: string): string {
  const candidateMs = Date.parse(candidate);
  const previousMs = Date.parse(previous);
  if (!Number.isFinite(candidateMs)) return previous;
  return candidateMs < previousMs ? previous : new Date(candidateMs).toISOString();
}
