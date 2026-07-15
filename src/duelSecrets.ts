import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import { isValidAgentId } from "./agentValidation";
import {
  aggregateDuels,
  type DuelAgentCallReceipt,
  type DuelCommitmentCaptureType,
  type DuelEvent,
} from "./duels";
import {
  atomicWriteFile,
  ensureFile,
  readFileHead,
  serializePerFileAcrossProcesses,
} from "./fileQueue";

export interface DuelSecretStorage {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface StoredDuelCommitmentPayload {
  readonly commitmentId: string;
  readonly participantId: string;
  readonly captureType: DuelCommitmentCaptureType;
  readonly captureRef: string;
  readonly agentReceipt?: DuelAgentCallReceipt;
  readonly answer: string;
  readonly confidence: number;
  readonly nonce: string;
}

export interface DuelCommitmentSecretRef {
  readonly participantId: string;
  readonly commitmentId: string;
}

export type DuelCommitmentIndexState = "prepared" | "stored" | "deletePending" | "deleted";

export interface DuelCommitmentIndexRecord extends DuelCommitmentSecretRef {
  readonly duelId: string;
  readonly state: DuelCommitmentIndexState;
  readonly operationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DuelCommitmentSweepResult {
  readonly deleted: number;
  readonly retained: number;
  readonly deferred: number;
  readonly failed: number;
  /** Earliest safe time to retry fresh, unsealed records without racing another live window. */
  readonly nextSweepAt?: string;
}

interface DuelCommitmentIndexFile {
  readonly version: 1;
  readonly records: readonly DuelCommitmentIndexRecord[];
}

const MAX_SECRET_PAYLOAD_CHARS = 16 * 1024;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_ACTIVE_INDEX_RECORDS = 10_000;
const MAX_DELETED_TOMBSTONES = 10_000;
export const DUEL_SECRET_ORPHAN_GRACE_MS = 5 * 60_000;

export function duelCommitmentIndexPath(workspacePrivateStorageRoot: string): string {
  return path.join(workspacePrivateStorageRoot, "competition", "duel-commitment-index.json");
}

/**
 * SecretStorage keys use a digest so user-controlled duel/head ids never
 * become keychain labels or reveal proposition details in OS credential UIs.
 */
export function duelCommitmentSecretKey(duelId: string, participantId: string, commitmentId: string): string {
  return `hydra.duel-commitment.${createHash("sha256").update(`${duelId}\0${participantId}\0${commitmentId}`, "utf8").digest("hex")}`;
}

export async function ensureDuelCommitmentIndex(indexFilePath: string): Promise<void> {
  await serializePerFileAcrossProcesses(indexFilePath, async () => {
    await ensureFile(indexFilePath, `${JSON.stringify(emptyIndex())}\n`);
    await readIndexFile(indexFilePath);
  });
}

export async function loadDuelCommitmentIndex(indexFilePath: string): Promise<readonly DuelCommitmentIndexRecord[]> {
  return serializePerFileAcrossProcesses(indexFilePath, async () => {
    await ensureFile(indexFilePath, `${JSON.stringify(emptyIndex())}\n`);
    return (await readIndexFile(indexFilePath)).records;
  });
}

export async function storeDuelCommitmentSecret(
  storage: DuelSecretStorage,
  indexFilePath: string,
  duelId: string,
  payload: StoredDuelCommitmentPayload,
): Promise<void> {
  assertValidPayload(duelId, payload);
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_SECRET_PAYLOAD_CHARS || Buffer.byteLength(serialized, "utf8") > MAX_SECRET_PAYLOAD_CHARS) {
    throw new Error("Duel commitment secret is too large.");
  }

  const operationId = `store-${randomUUID()}`;
  await mutateIndex(indexFilePath, (records, now) => {
    const key = commitmentRefKey(duelId, payload.participantId, payload.commitmentId);
    const existing = records.get(key);
    if (existing?.state === "deletePending" || existing?.state === "deleted") {
      throw new Error("Duel commitment has already been scheduled for deletion.");
    }
    if (existing) {
      throw new Error("Duel commitment is already being stored.");
    }
    if (activeRecordCount(records) >= MAX_ACTIVE_INDEX_RECORDS) {
      throw new Error("Duel commitment index is full; cleanup is required before sealing another answer.");
    }
    records.set(key, {
      duelId,
      participantId: payload.participantId,
      commitmentId: payload.commitmentId,
      state: "prepared",
      operationId,
      createdAt: now,
      updatedAt: now,
    });
  });

  try {
    await storage.store(duelCommitmentSecretKey(duelId, payload.participantId, payload.commitmentId), serialized);
  } catch (error) {
    // A SecretStorage implementation may reject after persisting. Recording
    // deletePending first makes any partial write recoverable on startup.
    await deleteDuelCommitmentSecrets(storage, indexFilePath, duelId, [{
      participantId: payload.participantId,
      commitmentId: payload.commitmentId,
    }]).catch(() => undefined);
    throw error;
  }

  let storeStillOwnsRecord = false;
  try {
    storeStillOwnsRecord = await mutateIndex(indexFilePath, (records, now) => {
      const key = commitmentRefKey(duelId, payload.participantId, payload.commitmentId);
      const existing = records.get(key);
      if (!existing || existing.operationId !== operationId || existing.state !== "prepared") return false;
      records.set(key, { ...existing, state: "stored", updatedAt: now });
      return true;
    });
  } catch (error) {
    await deleteDuelCommitmentSecrets(storage, indexFilePath, duelId, [{
      participantId: payload.participantId,
      commitmentId: payload.commitmentId,
    }]).catch(() => undefined);
    throw error;
  }

  if (!storeStillOwnsRecord) {
    // A terminal cleanup can race the SecretStorage write. Its tombstone wins;
    // delete again after the write so an old store cannot resurrect a secret.
    await storage.delete(duelCommitmentSecretKey(duelId, payload.participantId, payload.commitmentId));
    throw new Error("Duel commitment was cancelled while its secret was being stored.");
  }
}

export async function loadDuelCommitmentSecret(
  storage: DuelSecretStorage,
  duelId: string,
  participantId: string,
  commitmentId: string,
): Promise<StoredDuelCommitmentPayload | undefined> {
  assertValidIdentifier("duelId", duelId, 128);
  if (!isValidAgentId(participantId)) throw new Error("Duel participant id is invalid.");
  assertValidIdentifier("commitmentId", commitmentId, 128);
  const serialized = await storage.get(duelCommitmentSecretKey(duelId, participantId, commitmentId));
  if (serialized === undefined) return undefined;
  if (serialized.length > MAX_SECRET_PAYLOAD_CHARS || Buffer.byteLength(serialized, "utf8") > MAX_SECRET_PAYLOAD_CHARS) {
    throw new Error("Duel commitment secret is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Duel commitment secret is malformed.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Duel commitment secret is malformed.");
  }
  const payload = parsed as Partial<StoredDuelCommitmentPayload>;
  assertValidPayload(duelId, payload);
  if (payload.participantId !== participantId) {
    throw new Error("Duel commitment secret belongs to another participant.");
  }
  if (payload.commitmentId !== commitmentId) {
    throw new Error("Duel commitment secret belongs to another commitment.");
  }
  return payload as StoredDuelCommitmentPayload;
}

export async function deleteDuelCommitmentSecrets(
  storage: DuelSecretStorage,
  indexFilePath: string,
  duelId: string,
  commitments: readonly DuelCommitmentSecretRef[],
): Promise<void> {
  assertValidIdentifier("duelId", duelId, 128);
  const unique = uniqueCommitmentRefs(commitments);
  for (const commitment of unique) {
    if (!isValidAgentId(commitment.participantId)) throw new Error("Duel participant id is invalid.");
    assertValidIdentifier("commitmentId", commitment.commitmentId, 128);
  }
  if (unique.length === 0) return;

  const deleteOperationId = `delete-${randomUUID()}`;
  await mutateIndex(indexFilePath, (records, now) => {
    for (const commitment of unique) {
      const key = commitmentRefKey(duelId, commitment.participantId, commitment.commitmentId);
      const existing = records.get(key);
      if (existing?.state === "deleted") continue;
      records.set(key, {
        duelId,
        participantId: commitment.participantId,
        commitmentId: commitment.commitmentId,
        state: "deletePending",
        operationId: deleteOperationId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    }
  });

  const results = await Promise.allSettled(unique.map((commitment) => storage.delete(
    duelCommitmentSecretKey(duelId, commitment.participantId, commitment.commitmentId),
  )));
  const deleted = unique.filter((_, index) => results[index]?.status === "fulfilled");
  if (deleted.length > 0) {
    await mutateIndex(indexFilePath, (records, now) => {
      for (const commitment of deleted) {
        const key = commitmentRefKey(duelId, commitment.participantId, commitment.commitmentId);
        const existing = records.get(key);
        if (existing?.state !== "deletePending") continue;
        records.set(key, { ...existing, state: "deleted", operationId: deleteOperationId, updatedAt: now });
      }
    });
  }
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(failures.map((failure) => (failure as PromiseRejectedResult).reason), "Duel commitment secret deletion failed.");
  }
}

/**
 * Reconcile SecretStorage with the authoritative, fully validated duel ledger.
 * Answers are never read during the sweep. Fresh unsealed records receive a
 * grace period so one VS Code window cannot delete another window's in-flight
 * store before its seal append completes.
 */
export async function sweepDuelCommitmentSecrets(
  storage: DuelSecretStorage,
  indexFilePath: string,
  events: readonly DuelEvent[],
  options: { now?: Date; orphanGraceMs?: number } = {},
): Promise<DuelCommitmentSweepResult> {
  // Fail closed before making deletion decisions from a partial/corrupt replay.
  aggregateDuels(events);
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const requestedGrace = options.orphanGraceMs ?? DUEL_SECRET_ORPHAN_GRACE_MS;
  const orphanGraceMs = Number.isFinite(requestedGrace) ? Math.max(0, requestedGrace) : DUEL_SECRET_ORPHAN_GRACE_MS;
  const durableSeals = new Map<string, { duelId: string; participantId: string; commitmentId: string }>();
  const releasableDuels = new Set<string>();
  for (const event of events) {
    if (event.type === "duelCommitmentSealed") {
      durableSeals.set(commitmentRefKey(event.duelId, event.participantId, event.commitmentId), {
        duelId: event.duelId,
        participantId: event.participantId,
        commitmentId: event.commitmentId,
      });
    }
    if (
      event.type === "duelCommitmentsRevealed"
      || event.type === "duelResolved"
      || event.type === "duelCancelled"
      || event.type === "duelDeclined"
    ) {
      releasableDuels.add(event.duelId);
    }
  }

  const indexed = await loadDuelCommitmentIndex(indexFilePath);
  const indexedByKey = new Map(indexed.map((record) => [
    commitmentRefKey(record.duelId, record.participantId, record.commitmentId),
    record,
  ]));
  const candidates = new Map<string, { duelId: string; participantId: string; commitmentId: string }>();
  let retained = 0;
  let deferred = 0;
  let nextSweepAtMs: number | undefined;

  for (const record of indexed) {
    if (record.state === "deleted") continue;
    const key = commitmentRefKey(record.duelId, record.participantId, record.commitmentId);
    const isDurable = durableSeals.has(key);
    if (record.state === "deletePending" || releasableDuels.has(record.duelId)) {
      candidates.set(key, record);
      continue;
    }
    if (isDurable) {
      retained += 1;
      continue;
    }
    const eligibleAt = Date.parse(record.createdAt) + orphanGraceMs;
    if (eligibleAt <= nowMs) {
      candidates.set(key, record);
    } else {
      deferred += 1;
      nextSweepAtMs = nextSweepAtMs === undefined ? eligibleAt : Math.min(nextSweepAtMs, eligibleAt);
    }
  }

  // Upgrade cleanup for secrets created before the index existed. A durable
  // terminal seal is sufficient to derive its opaque SecretStorage key.
  for (const [key, seal] of durableSeals) {
    if (releasableDuels.has(seal.duelId) && indexedByKey.get(key)?.state !== "deleted") {
      candidates.set(key, seal);
    }
  }

  let deleted = 0;
  let failed = 0;
  for (const candidate of candidates.values()) {
    try {
      await deleteDuelCommitmentSecrets(storage, indexFilePath, candidate.duelId, [candidate]);
      deleted += 1;
    } catch {
      // The deletePending tombstone is durable; a later sweep will retry it.
      failed += 1;
    }
  }
  return {
    deleted,
    retained,
    deferred,
    failed,
    ...(nextSweepAtMs === undefined ? {} : { nextSweepAt: new Date(nextSweepAtMs).toISOString() }),
  };
}

async function mutateIndex<T>(
  indexFilePath: string,
  mutation: (records: Map<string, DuelCommitmentIndexRecord>, now: string) => T,
): Promise<T> {
  return serializePerFileAcrossProcesses(indexFilePath, async () => {
    await ensureFile(indexFilePath, `${JSON.stringify(emptyIndex())}\n`);
    const current = await readIndexFile(indexFilePath);
    const records = new Map(current.records.map((record) => [
      commitmentRefKey(record.duelId, record.participantId, record.commitmentId),
      record,
    ]));
    const result = mutation(records, new Date().toISOString());
    const next = compactIndex(records);
    const serialized = `${JSON.stringify({ version: 1, records: next } satisfies DuelCommitmentIndexFile)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_INDEX_BYTES) {
      throw new Error("Duel commitment index exceeds its safety limit.");
    }
    await atomicWriteFile(indexFilePath, serialized);
    return result;
  });
}

async function readIndexFile(indexFilePath: string): Promise<DuelCommitmentIndexFile> {
  const bounded = await readFileHead(indexFilePath, MAX_INDEX_BYTES + 1);
  if (bounded.truncated) throw new Error("Duel commitment index exceeds its safety limit.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bounded.text);
  } catch {
    throw new Error("Duel commitment index is malformed.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Duel commitment index is malformed.");
  }
  const file = parsed as Partial<DuelCommitmentIndexFile>;
  if (file.version !== 1 || !Array.isArray(file.records)) {
    throw new Error("Duel commitment index has an unsupported schema.");
  }
  const seen = new Set<string>();
  for (const raw of file.records) {
    assertValidIndexRecord(raw);
    const key = commitmentRefKey(raw.duelId, raw.participantId, raw.commitmentId);
    if (seen.has(key)) throw new Error("Duel commitment index contains duplicate records.");
    seen.add(key);
  }
  if (file.records.filter((record) => record.state !== "deleted").length > MAX_ACTIVE_INDEX_RECORDS) {
    throw new Error("Duel commitment index contains too many active records.");
  }
  return { version: 1, records: file.records };
}

function assertValidIndexRecord(raw: unknown): asserts raw is DuelCommitmentIndexRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Duel commitment index contains a malformed record.");
  const record = raw as Partial<DuelCommitmentIndexRecord>;
  assertValidIdentifier("duelId", record.duelId, 128);
  if (!isValidAgentId(record.participantId)) throw new Error("Duel commitment index participant id is invalid.");
  assertValidIdentifier("commitmentId", record.commitmentId, 128);
  if (!new Set<DuelCommitmentIndexState>(["prepared", "stored", "deletePending", "deleted"]).has(record.state as DuelCommitmentIndexState)) {
    throw new Error("Duel commitment index state is invalid.");
  }
  assertValidIdentifier("operationId", record.operationId, 128);
  assertValidTimestamp("createdAt", record.createdAt);
  assertValidTimestamp("updatedAt", record.updatedAt);
}

function compactIndex(records: Map<string, DuelCommitmentIndexRecord>): readonly DuelCommitmentIndexRecord[] {
  const all = [...records.values()];
  const active = all.filter((record) => record.state !== "deleted");
  const deleted = all
    .filter((record) => record.state === "deleted")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_DELETED_TOMBSTONES);
  return active.concat(deleted).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function activeRecordCount(records: Map<string, DuelCommitmentIndexRecord>): number {
  let count = 0;
  for (const record of records.values()) if (record.state !== "deleted") count += 1;
  return count;
}

function uniqueCommitmentRefs(commitments: readonly DuelCommitmentSecretRef[]): DuelCommitmentSecretRef[] {
  const unique = new Map<string, DuelCommitmentSecretRef>();
  for (const commitment of commitments) {
    unique.set(`${commitment.participantId}\0${commitment.commitmentId}`, commitment);
  }
  return [...unique.values()];
}

function commitmentRefKey(duelId: string, participantId: string, commitmentId: string): string {
  return `${duelId}\0${participantId}\0${commitmentId}`;
}

function emptyIndex(): DuelCommitmentIndexFile {
  return { version: 1, records: [] };
}

function assertValidPayload(
  duelId: string,
  payload: Partial<StoredDuelCommitmentPayload>,
): asserts payload is StoredDuelCommitmentPayload {
  assertValidIdentifier("duelId", duelId, 128);
  assertValidIdentifier("commitmentId", payload.commitmentId, 128);
  if (!isValidAgentId(payload.participantId)) throw new Error("Duel participant id is invalid.");
  if (payload.captureType !== "agent-call" && payload.captureType !== "operator") {
    throw new Error("Duel commitment capture type must be agent-call or operator.");
  }
  assertValidIdentifier("captureRef", payload.captureRef, 512);
  if (payload.captureType === "agent-call" && !payload.captureRef.startsWith("agent-call:")) {
    throw new Error("Agent-call commitment capture reference must start with agent-call:.");
  }
  if (payload.captureType === "operator" && payload.captureRef !== "operator:local-user") {
    throw new Error("Operator commitment capture reference must be operator:local-user.");
  }
  if (payload.captureType === "agent-call") {
    if (!validAgentReceipt(payload.agentReceipt) || payload.agentReceipt.agentId !== payload.participantId) {
      throw new Error("Agent-call duel commitment requires a complete receipt for the participant.");
    }
    if (payload.captureRef !== `agent-call:${payload.agentReceipt.traceId}`) {
      throw new Error("Agent-call commitment capture reference must identify its receipt.");
    }
  } else if (payload.agentReceipt !== undefined) {
    throw new Error("Operator duel commitment cannot include an agent-call receipt.");
  }
  if (typeof payload.answer !== "string" || payload.answer.trim().length === 0 || payload.answer.length > 4_000) {
    throw new Error("Duel commitment answer must contain 1-4000 characters.");
  }
  if (typeof payload.confidence !== "number" || !Number.isFinite(payload.confidence) || payload.confidence < 0 || payload.confidence > 1) {
    throw new Error("Duel commitment confidence must be a number from 0 through 1.");
  }
  assertValidIdentifier("nonce", payload.nonce, 256);
}

function assertValidIdentifier(field: string, value: unknown, maxLength: number): asserts value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty trimmed string of at most ${maxLength} characters.`);
  }
}

function assertValidTimestamp(field: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be a valid timestamp.`);
  }
}

function validAgentReceipt(raw: unknown): raw is DuelAgentCallReceipt {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const receipt = raw as Partial<DuelAgentCallReceipt>;
  return typeof receipt.traceId === "string"
    && receipt.traceId.trim() === receipt.traceId
    && receipt.traceId.length > 0
    && receipt.traceId.length <= 256
    && isValidAgentId(receipt.agentId)
    && typeof receipt.agentKind === "string"
    && receipt.agentKind.trim() === receipt.agentKind
    && receipt.agentKind.length > 0
    && receipt.agentKind.length <= 64
    && (receipt.model === undefined
      || (typeof receipt.model === "string" && receipt.model.trim() === receipt.model && receipt.model.length > 0 && receipt.model.length <= 256))
    && (receipt.transport === "oneShot" || receipt.transport === "http")
    && typeof receipt.startedAt === "string"
    && Number.isFinite(Date.parse(receipt.startedAt))
    && typeof receipt.completedAt === "string"
    && Number.isFinite(Date.parse(receipt.completedAt))
    && Date.parse(receipt.completedAt) >= Date.parse(receipt.startedAt)
    && typeof receipt.promptSha256 === "string"
    && /^[a-f0-9]{64}$/.test(receipt.promptSha256)
    && (receipt.sharedEvidenceSha256 === undefined
      || (typeof receipt.sharedEvidenceSha256 === "string" && /^[a-f0-9]{64}$/.test(receipt.sharedEvidenceSha256)))
    && typeof receipt.responseSha256 === "string"
    && /^[a-f0-9]{64}$/.test(receipt.responseSha256)
    && typeof receipt.invocationSha256 === "string"
    && /^[a-f0-9]{64}$/.test(receipt.invocationSha256);
}
