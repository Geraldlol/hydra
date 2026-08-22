import { createHash } from "node:crypto";
import { isValidAgentId } from "./agentValidation";
import {
  evaluateArenaCleanupStart,
  parseArenaCleanupStepPayload,
  replayArenaCleanupSteps,
  type ArenaCleanupStepPayload,
  type ArenaCleanupTargetReplay,
} from "./arenaCleanup";

export const ARENA_MANIFEST_SCHEMA_VERSION = 1 as const;
export const ARENA_POLICY_ID = "hydra-arena-v1" as const;
export const ARENA_MANIFEST_LIMITS = Object.freeze({
  maxEvents: 10_000,
  maxManifestBytes: 8 * 1024 * 1024,
  maxEventBytes: 64 * 1024,
  maxContestants: 8,
  maxVerificationChecks: 32,
  maxBrowserJourneys: 16,
  maxAttemptsPerCheck: 100,
  maxArtifactBytes: 512 * 1024 * 1024,
});

const ARENA_EVENT_HASH_DOMAIN = "hydra.arena.manifest.v1.event\u0000";
const ARENA_RECEIPTS_HASH_DOMAIN = "hydra.arena.manifest.v1.receipts\u0000";
const ARENA_MATRIX_HASH_DOMAIN = "hydra.arena.manifest.v1.matrix\u0000";
export const ARENA_MANIFEST_GENESIS_SHA256 = createHash("sha256")
  .update("hydra.arena.manifest.v1.genesis\u0000", "utf8")
  .digest("hex");

export type ArenaGitObjectFormat = "sha1" | "sha256";

export interface ArenaGitObjectId {
  readonly objectFormat: ArenaGitObjectFormat;
  readonly oid: string;
}

export interface ArenaMissionLock {
  readonly missionId: string;
  readonly revision: number;
  readonly documentSha256: string;
  readonly bindingSha256: string;
}

export interface ArenaBaseLock {
  readonly revision: ArenaGitObjectId;
  readonly repositoryIdentitySha256: string;
  readonly baseContentSha256: string;
  readonly sourceWorkspaceFingerprintSha256: string;
  readonly repositoryControlSha256: string;
}

export interface ArenaContestantLock {
  readonly contestantId: string;
  readonly headId: string;
  readonly agentKind: string;
  readonly headConfigSha256: string;
  readonly authoritySha256: string;
  readonly invocationSha256: string;
  readonly worktreeId: string;
}

export interface ArenaVerificationCheckLock {
  readonly checkId: string;
  readonly planSha256: string;
}

export interface ArenaBrowserJourneyLock {
  readonly journeyId: string;
  readonly planSha256: string;
}

export interface ArenaRunLockedPayload {
  readonly payloadType: "runLocked";
  readonly policy: typeof ARENA_POLICY_ID;
  readonly mission: ArenaMissionLock;
  readonly base: ArenaBaseLock;
  readonly inputBundleSha256: string;
  readonly preparationPlanSha256: string | null;
  readonly environmentPolicySha256: string;
  readonly budgetSha256: string;
  readonly verificationChecks: readonly ArenaVerificationCheckLock[];
  readonly browserJourneys: readonly ArenaBrowserJourneyLock[];
  readonly contestants: readonly ArenaContestantLock[];
  readonly steering: "disabled";
  readonly confirmation: {
    readonly actorId: "local-user";
    readonly action: "Confirm Arena Run";
    readonly confirmationId: string;
  };
}

export type ArenaWorkspaceObservationStatus =
  | "unchanged"
  | "changed"
  | "unverifiable";

export type ArenaWorkspaceObservationKind =
  | "monitorStarted"
  | "checkpoint"
  | "postEvidence";

export type ArenaWorkspaceObservationReason =
  | "watcherChanged"
  | "workspaceFingerprintChanged"
  | "headChanged"
  | "repositoryControlChanged"
  | "monitorFailed"
  | "fingerprintFailed"
  | "registryMismatch"
  | "unknown";

export interface ArenaMainWorkspaceObservedPayload {
  readonly payloadType: "mainWorkspaceObserved";
  readonly observationKind: ArenaWorkspaceObservationKind;
  readonly monitorEpochId: string;
  readonly monitorReceiptSha256: string;
  readonly status: ArenaWorkspaceObservationStatus;
  readonly sourceWorkspaceFingerprintSha256: string | null;
  readonly repositoryControlSha256: string | null;
  readonly head: ArenaGitObjectId | null;
  readonly watcherChanged: boolean;
  readonly reasonCode: ArenaWorkspaceObservationReason | null;
}

export type ArenaPreparationStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timedOut";

export interface ArenaWorktreeRegisteredPayload {
  readonly payloadType: "worktreeRegistered";
  readonly contestantId: string;
  readonly worktreeId: string;
  readonly baseRevision: ArenaGitObjectId;
  readonly registrationSha256: string;
  readonly initialFingerprintSha256: string;
}

export interface ArenaWorktreeProvisionedPayload {
  readonly payloadType: "worktreeProvisioned";
  readonly contestantId: string;
  readonly worktreeId: string;
  readonly baseRevision: ArenaGitObjectId;
  readonly registrationSha256: string;
  readonly initialFingerprintSha256: string;
  readonly preparationPlanSha256: string | null;
  readonly preparationStatus: ArenaPreparationStatus;
  readonly preparationReceiptSha256: string | null;
  readonly preparedFingerprintSha256: string;
}

export interface ArenaContestantStartedPayload {
  readonly payloadType: "contestantStarted";
  readonly contestantId: string;
  readonly traceId: string;
  readonly inputBundleSha256: string;
  readonly environmentPolicySha256: string;
  readonly budgetSha256: string;
  readonly promptSha256: string;
  readonly contextSha256: string;
  readonly invocationSha256: string;
  readonly authoritySha256: string;
  readonly preparedFingerprintSha256: string;
  readonly steering: "disabled";
}

export type ArenaContestantTerminalStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timedOut"
  | "deliveryUnknown";

export type ArenaContestantFailureCode =
  | "preparationFailed"
  | "dispatchRejected"
  | "providerFailure"
  | "transportFailure"
  | "missionMismatch"
  | "authorityMismatch"
  | "budgetExceeded"
  | "cancelled"
  | "timeout"
  | "terminationUnconfirmed"
  | "deliveryUnknown"
  | "unknown";

export type ArenaContestantTerminalStage = "beforeDispatch" | "execution";

export interface ArenaContestantFinishedPayload {
  readonly payloadType: "contestantFinished";
  readonly contestantId: string;
  readonly stage: ArenaContestantTerminalStage;
  readonly traceId: string | null;
  readonly status: ArenaContestantTerminalStatus;
  readonly failureCode: ArenaContestantFailureCode | null;
  readonly finalHead: ArenaGitObjectId;
  readonly finalWorkspaceFingerprintSha256: string;
  readonly outputSha256: string;
  readonly outputBytes: number;
}

export type ArenaVerificationStatus =
  | "passed"
  | "failed"
  | "cancelled"
  | "timedOut"
  | "unconfirmed";

export interface ArenaVerificationRecordedPayload {
  readonly payloadType: "verificationRecorded";
  readonly contestantId: string;
  readonly checkId: string;
  readonly attempt: number;
  readonly planSha256: string;
  readonly status: ArenaVerificationStatus;
  readonly receiptSha256: string;
  readonly head: ArenaGitObjectId;
  readonly workspaceFingerprintSha256: string;
}

export type ArenaBrowserJourneyStatus =
  | "passed"
  | "failed"
  | "cancelled"
  | "timedOut"
  | "denied"
  | "unavailable";

export interface ArenaBrowserJourneyRecordedPayload {
  readonly payloadType: "browserJourneyRecorded";
  readonly contestantId: string;
  readonly journeyId: string;
  readonly attempt: number;
  readonly planSha256: string;
  readonly status: ArenaBrowserJourneyStatus;
  readonly receiptSha256: string;
  readonly head: ArenaGitObjectId;
  readonly workspaceFingerprintSha256: string;
}

export interface ArenaEvidencePreservedPayload {
  readonly payloadType: "evidencePreserved";
  readonly contestantId: string;
  readonly artifactSetSha256: string;
  readonly receiptsRootSha256: string;
  readonly patchSha256: string;
  readonly patchBytes: number;
  readonly untrackedArchiveSha256: string | null;
  readonly untrackedArchiveBytes: number;
  readonly inventorySha256: string;
  readonly quiescenceReceiptSha256: string | null;
  readonly quiescenceWorkspaceFingerprintSha256: string | null;
  readonly finalHead: ArenaGitObjectId;
  readonly finalWorkspaceFingerprintSha256: string;
}

export interface ArenaEvidenceMatrixContestant {
  readonly contestantId: string;
  readonly finishedEventSha256: string;
  readonly verificationEventSha256s: readonly string[];
  readonly browserJourneyEventSha256s: readonly string[];
  readonly evidenceEventSha256: string;
}

export interface ArenaEvidenceMatrixInput {
  readonly lockEventSha256: string;
  readonly postEvidenceEventSha256: string;
  readonly contestants: readonly ArenaEvidenceMatrixContestant[];
}

export type ArenaRunOutcome = "completed" | "cancelled" | "failed";
export type ArenaComparisonClassification =
  | "comparable"
  | "compromised"
  | "incomplete";
export type ArenaFinalizationReason =
  | "userCancelled"
  | "provisioningFailed"
  | "contestantFailed"
  | "mainWorkspaceChanged"
  | "repositoryControlChanged"
  | "contestantHeadChanged"
  | "verificationMutatedWorkspace"
  | "browserMutatedWorkspace"
  | "evidenceStateMismatch"
  | "preparationStateMismatch"
  | "terminationUnconfirmed"
  | "monitorFailed"
  | "recorderFailure"
  | "unknown";

export interface ArenaRunFinalizedPayload {
  readonly payloadType: "runFinalized";
  readonly outcome: ArenaRunOutcome;
  readonly comparison: ArenaComparisonClassification;
  readonly reasonCode: ArenaFinalizationReason | null;
  readonly evidenceMatrixSha256: string | null;
}

export type ArenaManifestEventType =
  | "arenaRunLocked"
  | "arenaMainWorkspaceObserved"
  | "arenaWorktreeRegistered"
  | "arenaWorktreeProvisioned"
  | "arenaContestantStarted"
  | "arenaContestantFinished"
  | "arenaVerificationRecorded"
  | "arenaBrowserJourneyRecorded"
  | "arenaEvidencePreserved"
  | "arenaRunFinalized"
  | "arenaCleanupStepRecorded";

export type ArenaManifestPayload =
  | ArenaRunLockedPayload
  | ArenaMainWorkspaceObservedPayload
  | ArenaWorktreeRegisteredPayload
  | ArenaWorktreeProvisionedPayload
  | ArenaContestantStartedPayload
  | ArenaContestantFinishedPayload
  | ArenaVerificationRecordedPayload
  | ArenaBrowserJourneyRecordedPayload
  | ArenaEvidencePreservedPayload
  | ArenaRunFinalizedPayload
  | ArenaCleanupStepPayload;

export interface ArenaManifestEventDraft {
  readonly eventId: string;
  readonly runId: string;
  readonly occurredAt: string;
  readonly type: ArenaManifestEventType;
  readonly payload: ArenaManifestPayload;
}

export interface ArenaManifestEvent extends ArenaManifestEventDraft {
  readonly schemaVersion: typeof ARENA_MANIFEST_SCHEMA_VERSION;
  readonly sequence: number;
  readonly previousEventSha256: string;
  readonly eventSha256: string;
}

export interface ArenaVerificationReplay {
  readonly checkId: string;
  readonly attempts: readonly ArenaManifestEvent[];
}

export interface ArenaBrowserJourneyReplay {
  readonly journeyId: string;
  readonly attempts: readonly ArenaManifestEvent[];
}

export interface ArenaContestantReplay {
  readonly lock: ArenaContestantLock;
  readonly worktreeRegistered?: ArenaManifestEvent;
  readonly worktreeProvisioned?: ArenaManifestEvent;
  readonly started?: ArenaManifestEvent;
  readonly finished?: ArenaManifestEvent;
  readonly verifications: readonly ArenaVerificationReplay[];
  readonly browserJourneys: readonly ArenaBrowserJourneyReplay[];
  readonly evidencePreserved?: ArenaManifestEvent;
  readonly cleanup: ArenaCleanupTargetReplay;
}

export interface ArenaManifestReplay {
  readonly runId: string;
  readonly records: readonly ArenaManifestEvent[];
  readonly lock: ArenaRunLockedPayload;
  readonly state:
    | "locked"
    | "running"
    | "finalized"
    | "cleanupComplete"
    | "cleanupBlocked";
  readonly contestants: readonly ArenaContestantReplay[];
  readonly mainWorkspaceObservations: readonly ArenaManifestEvent[];
  readonly compromised: boolean;
  readonly compromiseReasons: readonly string[];
  readonly finalization?: ArenaManifestEvent;
  readonly promotionEligible: boolean;
  readonly latestEventSha256: string;
}

export class ArenaManifestValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid Hydra Arena manifest: ${issues.join("; ")}`);
    this.name = "ArenaManifestValidationError";
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EVENT_TYPES = new Set<ArenaManifestEventType>([
  "arenaRunLocked",
  "arenaMainWorkspaceObserved",
  "arenaWorktreeRegistered",
  "arenaWorktreeProvisioned",
  "arenaContestantStarted",
  "arenaContestantFinished",
  "arenaVerificationRecorded",
  "arenaBrowserJourneyRecorded",
  "arenaEvidencePreserved",
  "arenaRunFinalized",
  "arenaCleanupStepRecorded",
]);
const WORKSPACE_STATUSES = new Set<ArenaWorkspaceObservationStatus>([
  "unchanged",
  "changed",
  "unverifiable",
]);
const WORKSPACE_OBSERVATION_KINDS = new Set<ArenaWorkspaceObservationKind>([
  "monitorStarted",
  "checkpoint",
  "postEvidence",
]);
const WORKSPACE_REASONS = new Set<ArenaWorkspaceObservationReason>([
  "watcherChanged",
  "workspaceFingerprintChanged",
  "headChanged",
  "repositoryControlChanged",
  "monitorFailed",
  "fingerprintFailed",
  "registryMismatch",
  "unknown",
]);
const PREPARATION_STATUSES = new Set<ArenaPreparationStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "timedOut",
]);
const CONTESTANT_STATUSES = new Set<ArenaContestantTerminalStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "timedOut",
  "deliveryUnknown",
]);
const CONTESTANT_FAILURE_CODES = new Set<ArenaContestantFailureCode>([
  "preparationFailed",
  "dispatchRejected",
  "providerFailure",
  "transportFailure",
  "missionMismatch",
  "authorityMismatch",
  "budgetExceeded",
  "cancelled",
  "timeout",
  "terminationUnconfirmed",
  "deliveryUnknown",
  "unknown",
]);
const CONTESTANT_TERMINAL_STAGES = new Set<ArenaContestantTerminalStage>([
  "beforeDispatch",
  "execution",
]);
const VERIFICATION_STATUSES = new Set<ArenaVerificationStatus>([
  "passed",
  "failed",
  "cancelled",
  "timedOut",
  "unconfirmed",
]);
const BROWSER_STATUSES = new Set<ArenaBrowserJourneyStatus>([
  "passed",
  "failed",
  "cancelled",
  "timedOut",
  "denied",
  "unavailable",
]);
const RUN_OUTCOMES = new Set<ArenaRunOutcome>(["completed", "cancelled", "failed"]);
const COMPARISON_CLASSIFICATIONS = new Set<ArenaComparisonClassification>([
  "comparable",
  "compromised",
  "incomplete",
]);
const FINALIZATION_REASONS = new Set<ArenaFinalizationReason>([
  "userCancelled",
  "provisioningFailed",
  "contestantFailed",
  "mainWorkspaceChanged",
  "repositoryControlChanged",
  "contestantHeadChanged",
  "verificationMutatedWorkspace",
  "browserMutatedWorkspace",
  "evidenceStateMismatch",
  "preparationStateMismatch",
  "terminationUnconfirmed",
  "monitorFailed",
  "recorderFailure",
  "unknown",
]);

interface MutableContestantReplay {
  readonly lock: ArenaContestantLock;
  worktreeRegistered?: ArenaManifestEvent;
  worktreeProvisioned?: ArenaManifestEvent;
  started?: ArenaManifestEvent;
  finished?: ArenaManifestEvent;
  readonly verifications: Map<string, ArenaManifestEvent[]>;
  readonly browserJourneys: Map<string, ArenaManifestEvent[]>;
  evidencePreserved?: ArenaManifestEvent;
  readonly cleanupRecords: ArenaCleanupStepPayload[];
}

export function createArenaManifestEvent(
  draft: ArenaManifestEventDraft,
  sequence: number,
  previousEventSha256: string,
): ArenaManifestEvent {
  const withoutHash = {
    schemaVersion: ARENA_MANIFEST_SCHEMA_VERSION,
    eventId: draft.eventId,
    runId: draft.runId,
    sequence,
    occurredAt: draft.occurredAt,
    type: draft.type,
    previousEventSha256,
    payload: draft.payload,
  };
  const event = {
    ...withoutHash,
    eventSha256: computeArenaManifestEventSha256(withoutHash),
  };
  return parseArenaManifestEvent(event);
}

export function computeArenaManifestEventSha256(
  value: Omit<ArenaManifestEvent, "eventSha256"> | Record<string, unknown>,
): string {
  const input = { ...value } as Record<string, unknown>;
  delete input.eventSha256;
  return createHash("sha256")
    .update(ARENA_EVENT_HASH_DOMAIN, "utf8")
    .update(canonicalArenaManifestJson(input), "utf8")
    .digest("hex");
}

export function canonicalArenaManifestJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error("Arena manifest hashes require finite numbers and reject negative zero.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalArenaManifestJson).join(",")}]`;
  }
  if (!isPlainRecord(value)) {
    throw new Error("Arena manifest hashes require JSON-compatible plain values.");
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => {
      const entry = value[key];
      if (entry === undefined) {
        throw new Error("Arena manifest hashes reject undefined values.");
      }
      return `${JSON.stringify(key)}:${canonicalArenaManifestJson(entry)}`;
    });
  return `{${entries.join(",")}}`;
}

export function isArenaManifestEvent(value: unknown): value is ArenaManifestEvent {
  try {
    const event = parseArenaManifestEvent(value);
    return computeArenaManifestEventSha256(event) === event.eventSha256;
  } catch {
    return false;
  }
}

export function parseArenaManifestEvent(
  value: unknown,
  index = 0,
): ArenaManifestEvent {
  const label = `events[${index}]`;
  const row = exactRecord(value, [
    "schemaVersion",
    "eventId",
    "runId",
    "sequence",
    "occurredAt",
    "type",
    "previousEventSha256",
    "eventSha256",
    "payload",
  ], label);
  literal(
    row.schemaVersion,
    ARENA_MANIFEST_SCHEMA_VERSION,
    `${label}.schemaVersion`,
  );
  const eventId = identifier(row.eventId, `${label}.eventId`);
  const runId = identifier(row.runId, `${label}.runId`);
  const sequence = positiveInteger(row.sequence, `${label}.sequence`);
  const occurredAt = timestamp(row.occurredAt, `${label}.occurredAt`);
  if (typeof row.type !== "string"
    || !EVENT_TYPES.has(row.type as ArenaManifestEventType)) {
    invalid(`${label}.type`, "must be a supported Arena manifest event type");
  }
  const type = row.type as ArenaManifestEventType;
  const previousEventSha256 = sha256(
    row.previousEventSha256,
    `${label}.previousEventSha256`,
  );
  const eventSha256 = sha256(row.eventSha256, `${label}.eventSha256`);
  const payload = parsePayload(type, row.payload, `${label}.payload`);
  return deepFreeze({
    schemaVersion: ARENA_MANIFEST_SCHEMA_VERSION,
    eventId,
    runId,
    sequence,
    occurredAt,
    type,
    previousEventSha256,
    eventSha256,
    payload,
  });
}

export function replayArenaManifest(values: readonly unknown[]): ArenaManifestReplay {
  if (values.length === 0) {
    invalid("events", "must begin with arenaRunLocked");
  }
  if (values.length > ARENA_MANIFEST_LIMITS.maxEvents) {
    invalid("events", `must not exceed ${ARENA_MANIFEST_LIMITS.maxEvents} events`);
  }
  const records = values.map((value, index) => parseArenaManifestEvent(value, index));
  let totalBytes = 0;
  let previousHash = ARENA_MANIFEST_GENESIS_SHA256;
  let runId: string | undefined;
  const eventIds = new Set<string>();

  records.forEach((record, index) => {
    const label = `events[${index}]`;
    const encodedBytes = Buffer.byteLength(
      `${canonicalArenaManifestJson(record)}\n`,
      "utf8",
    );
    totalBytes += encodedBytes;
    if (encodedBytes > ARENA_MANIFEST_LIMITS.maxEventBytes) {
      invalid(label, `exceeds ${ARENA_MANIFEST_LIMITS.maxEventBytes} bytes`);
    }
    if (record.sequence !== index + 1) {
      invalid(`${label}.sequence`, `must be ${index + 1}`);
    }
    if (record.previousEventSha256 !== previousHash) {
      invalid(`${label}.previousEventSha256`, "does not bind the previous event");
    }
    if (computeArenaManifestEventSha256(record) !== record.eventSha256) {
      invalid(`${label}.eventSha256`, "does not match the canonical event");
    }
    previousHash = record.eventSha256;
    runId ??= record.runId;
    if (record.runId !== runId) {
      invalid(`${label}.runId`, "crosses Arena run identities");
    }
    if (eventIds.has(record.eventId)) {
      invalid(`${label}.eventId`, `duplicates ${record.eventId}`);
    }
    eventIds.add(record.eventId);
  });
  if (totalBytes > ARENA_MANIFEST_LIMITS.maxManifestBytes) {
    invalid("events", `exceed ${ARENA_MANIFEST_LIMITS.maxManifestBytes} bytes`);
  }

  const first = records[0]!;
  if (first.type !== "arenaRunLocked") {
    invalid("events[0].type", "must be arenaRunLocked");
  }
  const lock = first.payload as ArenaRunLockedPayload;
  const contestants = new Map<string, MutableContestantReplay>(
    lock.contestants.map((contestant) => [
      contestant.contestantId,
      {
        lock: contestant,
        verifications: new Map<string, ArenaManifestEvent[]>(),
        browserJourneys: new Map<string, ArenaManifestEvent[]>(),
        cleanupRecords: [],
      },
    ]),
  );
  const cleanupOwners = new Map<string, string>();
  const mainWorkspaceObservations: ArenaManifestEvent[] = [];
  const monitorReceiptHashes = new Set<string>();
  const registrationHashes = new Set<string>();
  const compromiseReasons = new Set<string>();
  let finalization: ArenaManifestEvent | undefined;
  let latestEvidenceSequence = 0;
  let monitorEpochId: string | undefined;
  let preparedFingerprintSha256: string | undefined;
  let postEvidenceObservation: ArenaManifestEvent | undefined;

  records.slice(1).forEach((record, offset) => {
    const index = offset + 1;
    const label = `events[${index}]`;
    if (record.type === "arenaRunLocked") {
      invalid(`${label}.type`, "cannot lock one Arena run twice");
    }
    if (finalization && record.type !== "arenaCleanupStepRecorded") {
      invalid(`${label}.type`, "only cleanup records may follow arenaRunFinalized");
    }

    if (record.type === "arenaMainWorkspaceObserved") {
      const payload = record.payload as ArenaMainWorkspaceObservedPayload;
      if (monitorReceiptHashes.has(payload.monitorReceiptSha256)) {
        invalid(`${label}.payload.monitorReceiptSha256`, "duplicates a monitor receipt");
      }
      monitorReceiptHashes.add(payload.monitorReceiptSha256);
      if (payload.observationKind === "monitorStarted") {
        if (monitorEpochId !== undefined || mainWorkspaceObservations.length > 0) {
          invalid(label, "duplicates the pre-provision monitor start");
        }
        if ([...contestants.values()].some((candidate) =>
          candidate.worktreeProvisioned !== undefined)) {
          invalid(label, "the workspace monitor must start before worktree provisioning");
        }
        monitorEpochId = payload.monitorEpochId;
      } else {
        if (monitorEpochId === undefined) {
          invalid(label, "requires a pre-provision monitor start");
        }
        if (payload.monitorEpochId !== monitorEpochId) {
          invalid(`${label}.payload.monitorEpochId`, "does not match the locked monitor epoch");
        }
        if (payload.observationKind === "postEvidence"
          && (latestEvidenceSequence === 0
            || record.sequence <= latestEvidenceSequence)) {
          invalid(label, "postEvidence requires durable evidence recorded earlier");
        }
        if (payload.observationKind === "postEvidence") {
          if (postEvidenceObservation) {
            invalid(label, "duplicates the single final postEvidence observation");
          }
          postEvidenceObservation = record;
        }
      }
      mainWorkspaceObservations.push(record);
      if (payload.status === "unchanged") {
        if (payload.sourceWorkspaceFingerprintSha256
            !== lock.base.sourceWorkspaceFingerprintSha256
          || payload.repositoryControlSha256 !== lock.base.repositoryControlSha256
          || payload.head === null
          || !sameGitObject(payload.head, lock.base.revision)) {
          invalid(label, "claims unchanged while a locked source control differs");
        }
      } else {
        compromiseReasons.add(payload.reasonCode ?? "unknown");
      }
      return;
    }

    if (record.type === "arenaRunFinalized") {
      if (finalization) invalid(label, "duplicates arenaRunFinalized");
      const payload = record.payload as ArenaRunFinalizedPayload;
      const comparisonComplete = [...contestants.values()].every((contestant) =>
        hasComparableContestantEvidence(lock, contestant));
      const finalObservation = mainWorkspaceObservations.at(-1);
      const postEvidenceIsFresh = postEvidenceObservation !== undefined
        && postEvidenceObservation.sequence > latestEvidenceSequence;
      const finalObservationUnchanged =
        postEvidenceObservation !== undefined
        && finalObservation === postEvidenceObservation
        && postEvidenceIsFresh
        && (postEvidenceObservation.payload as ArenaMainWorkspaceObservedPayload)
          .status === "unchanged";
      const compromised = compromiseReasons.size > 0;
      const registeredRecoveryComplete = [...contestants.values()]
        .every((contestant) =>
          contestant.worktreeRegistered === undefined
          || (contestant.finished !== undefined
            && contestant.evidencePreserved !== undefined));

      if (payload.outcome === "completed") {
        if (!comparisonComplete) {
          invalid(
            label,
            "completed requires successful executions and durable complete evidence",
          );
        }
        if (!postEvidenceIsFresh) {
          invalid(
            label,
            "completed requires a postEvidence source observation after durable evidence",
          );
        }
        if (payload.evidenceMatrixSha256 === null) {
          invalid(`${label}.payload.evidenceMatrixSha256`, "completed requires a matrix hash");
        }
        const expectedMatrixSha256 = evidenceMatrixSha256ForReplay(
          first,
          postEvidenceObservation!,
          lock,
          contestants,
        );
        if (payload.evidenceMatrixSha256 !== expectedMatrixSha256) {
          invalid(
            `${label}.payload.evidenceMatrixSha256`,
            "does not bind the locked run and complete contestant evidence",
          );
        }
        if (payload.comparison === "incomplete") {
          invalid(`${label}.payload.comparison`, "completed cannot be incomplete");
        }
      } else {
        if (!registeredRecoveryComplete) {
          invalid(
            label,
            "cancelled/failed runs require terminal evidence for every registered cleanup target",
          );
        }
        if (payload.comparison !== "incomplete"
          || payload.reasonCode === null
          || payload.evidenceMatrixSha256 !== null) {
          invalid(label, "cancelled/failed runs must finalize incomplete with a reason and no matrix");
        }
      }
      if (payload.comparison === "comparable") {
        if (compromised
          || payload.outcome !== "completed"
          || payload.reasonCode !== null
          || !finalObservationUnchanged) {
          invalid(label, "comparable requires complete evidence and unchanged final controls");
        }
      }
      if (payload.comparison === "compromised") {
        if (!compromised
          || payload.outcome !== "completed"
          || payload.reasonCode === null) {
          invalid(label, "compromised requires a latched control failure and reason");
        }
        if (!allowedFinalizationReasons(compromiseReasons).has(payload.reasonCode)) {
          invalid(
            `${label}.payload.reasonCode`,
            "does not describe any latched compromise reason",
          );
        }
      }
      finalization = record;
      return;
    }

    if (record.type === "arenaCleanupStepRecorded") {
      if (!finalization) invalid(label, "cleanup cannot start before run finalization");
      const payload = record.payload as ArenaCleanupStepPayload;
      const contestant = requiredContestant(contestants, payload.contestantId, label);
      const start = evaluateArenaCleanupStart({
        manifestValid: true,
        runFinalized: true,
        worktreeRegistered: contestant.worktreeRegistered !== undefined,
        evidencePreserved: contestant.evidencePreserved !== undefined,
      });
      if (!start.allowed) {
        invalid(label, `cleanup start rejected: ${start.reason}`);
      }
      const registration = contestant.worktreeRegistered!.payload as
        ArenaWorktreeRegisteredPayload;
      if (payload.runId !== record.runId
        || payload.registrationSha256
          !== registration.registrationSha256
        || payload.evidenceEventSha256
          !== contestant.evidencePreserved!.eventSha256) {
        invalid(
          label,
          "cleanup receipt does not bind the run registration and preserved evidence",
        );
      }
      const priorOwner = cleanupOwners.get(payload.cleanupId);
      if (priorOwner !== undefined && priorOwner !== payload.contestantId) {
        invalid(`${label}.payload.cleanupId`, "is already bound to another contestant");
      }
      cleanupOwners.set(payload.cleanupId, payload.contestantId);
      contestant.cleanupRecords.push(payload);
      try {
        replayArenaCleanupSteps(
          record.runId,
          payload.contestantId,
          contestant.cleanupRecords,
        );
      } catch (error) {
        invalid(
          label,
          error instanceof Error ? error.message : "contains invalid cleanup history",
        );
      }
      return;
    }

    const contestantId = contestantIdForPayload(record.payload);
    const contestant = requiredContestant(contestants, contestantId, label);
    if (contestant.evidencePreserved) {
      invalid(label, "contestant records cannot follow durable evidence preservation");
    }

    if (record.type === "arenaWorktreeRegistered") {
      if (monitorEpochId === undefined) {
        invalid(label, "requires a pre-provision monitor start");
      }
      // A durable registration receipt can precede this manifest event across
      // a crash. Permit exact cleanup-target reconciliation any time before
      // finalization, including after another contestant terminalized or a
      // compromise latched. Provision/dispatch rules below remain strict.
      if (contestant.worktreeRegistered) {
        invalid(label, "duplicates worktree registration");
      }
      if (contestant.worktreeProvisioned) {
        invalid(label, "duplicates worktree provisioning");
      }
      const payload = record.payload as ArenaWorktreeRegisteredPayload;
      if (payload.worktreeId !== contestant.lock.worktreeId) {
        invalid(`${label}.payload.worktreeId`, "does not match the locked worktree");
      }
      if (!sameGitObject(payload.baseRevision, lock.base.revision)) {
        invalid(`${label}.payload.baseRevision`, "does not match the locked base");
      }
      if (payload.initialFingerprintSha256 !== lock.base.baseContentSha256) {
        invalid(
          `${label}.payload.initialFingerprintSha256`,
          "does not match the locked base content",
        );
      }
      if (registrationHashes.has(payload.registrationSha256)) {
        invalid(`${label}.payload.registrationSha256`, "duplicates a worktree registration");
      }
      registrationHashes.add(payload.registrationSha256);
      contestant.worktreeRegistered = record;
      return;
    }

    if (record.type === "arenaWorktreeProvisioned") {
      if (monitorEpochId === undefined) {
        invalid(label, "requires a pre-provision monitor start");
      }
      if (compromiseReasons.size > 0) {
        invalid(label, "cannot provision after a control compromise is latched");
      }
      if ([...contestants.values()].some((candidate) =>
        candidate.started !== undefined || candidate.finished !== undefined)) {
        invalid(label, "all worktrees must be prepared before any contestant dispatch");
      }
      if (!contestant.worktreeRegistered) {
        invalid(label, "requires a durable worktree registration");
      }
      if (contestant.worktreeProvisioned) {
        invalid(label, "duplicates worktree provisioning");
      }
      const payload = record.payload as ArenaWorktreeProvisionedPayload;
      const registered = contestant.worktreeRegistered
        .payload as ArenaWorktreeRegisteredPayload;
      if (payload.worktreeId !== contestant.lock.worktreeId
        || payload.worktreeId !== registered.worktreeId) {
        invalid(`${label}.payload.worktreeId`, "does not match the registered worktree");
      }
      if (!sameGitObject(payload.baseRevision, lock.base.revision)
        || !sameGitObject(payload.baseRevision, registered.baseRevision)) {
        invalid(`${label}.payload.baseRevision`, "does not match the registered base");
      }
      if (payload.registrationSha256 !== registered.registrationSha256) {
        invalid(`${label}.payload.registrationSha256`, "does not match durable registration");
      }
      if (payload.initialFingerprintSha256
        !== registered.initialFingerprintSha256) {
        invalid(
          `${label}.payload.initialFingerprintSha256`,
          "does not match the registered initial fingerprint",
        );
      }
      if (payload.preparationPlanSha256 !== lock.preparationPlanSha256) {
        invalid(`${label}.payload.preparationPlanSha256`, "does not match the locked plan");
      }
      if (payload.preparationStatus === "succeeded") {
        preparedFingerprintSha256 ??= payload.preparedFingerprintSha256;
        if (payload.preparedFingerprintSha256 !== preparedFingerprintSha256) {
          compromiseReasons.add("preparationStateMismatch");
        }
      }
      contestant.worktreeProvisioned = record;
      return;
    }

    if (record.type === "arenaContestantStarted") {
      if (compromiseReasons.size > 0) {
        invalid(label, "cannot dispatch after a control compromise is latched");
      }
      if (!contestant.worktreeProvisioned) {
        invalid(label, "requires a provisioned worktree");
      }
      if (![...contestants.values()].every((candidate) =>
        candidate.worktreeProvisioned !== undefined)) {
        invalid(label, "requires every locked worktree to be provisioned before dispatch");
      }
      if (![...contestants.values()].every((candidate) =>
        (candidate.worktreeProvisioned!.payload as ArenaWorktreeProvisionedPayload)
          .preparationStatus === "succeeded")) {
        invalid(label, "requires successful preparation for every locked worktree");
      }
      if ([...contestants.values()].some((candidate) =>
        candidate.finished !== undefined
        && (candidate.finished.payload as ArenaContestantFinishedPayload).stage
          === "beforeDispatch")) {
        invalid(label, "cannot dispatch after a pre-dispatch terminal outcome");
      }
      if (contestant.started) invalid(label, "duplicates contestant start");
      if (contestant.finished) invalid(label, "cannot start a terminal contestant");
      const payload = record.payload as ArenaContestantStartedPayload;
      const prepared = contestant.worktreeProvisioned
        .payload as ArenaWorktreeProvisionedPayload;
      if (payload.invocationSha256 !== contestant.lock.invocationSha256
        || payload.authoritySha256 !== contestant.lock.authoritySha256
        || payload.inputBundleSha256 !== lock.inputBundleSha256
        || payload.environmentPolicySha256 !== lock.environmentPolicySha256
        || payload.budgetSha256 !== lock.budgetSha256
        || payload.preparedFingerprintSha256 !== prepared.preparedFingerprintSha256) {
        invalid(
          label,
          "does not match the locked input, environment, budget, invocation, authority, and prepared state",
        );
      }
      contestant.started = record;
      return;
    }

    if (record.type === "arenaContestantFinished") {
      if (contestant.finished) invalid(label, "duplicates contestant finish");
      const payload = record.payload as ArenaContestantFinishedPayload;
      if (payload.stage === "beforeDispatch") {
        if (!contestant.worktreeRegistered) {
          invalid(label, "beforeDispatch requires a registered worktree");
        }
        if (contestant.started) {
          invalid(label, "beforeDispatch cannot follow a contestant start");
        }
        if (contestant.worktreeProvisioned) {
          const provisioned = contestant.worktreeProvisioned
            .payload as ArenaWorktreeProvisionedPayload;
          if (provisioned.preparationStatus === "failed"
            && (payload.status !== "failed"
              || payload.failureCode !== "preparationFailed")) {
            invalid(label, "failed preparation requires a preparationFailed terminal");
          }
          if (provisioned.preparationStatus === "cancelled"
            && (payload.status !== "cancelled"
              || payload.failureCode !== "cancelled")) {
            invalid(label, "cancelled preparation requires a cancelled terminal");
          }
          if (provisioned.preparationStatus === "timedOut"
            && (payload.status !== "timedOut"
              || payload.failureCode !== "timeout")) {
            invalid(label, "timed-out preparation requires a timedOut terminal");
          }
        }
      } else {
        if (!contestant.started) invalid(label, "execution requires a contestant start");
        const started = contestant.started.payload as ArenaContestantStartedPayload;
        if (payload.traceId !== started.traceId) {
          invalid(`${label}.payload.traceId`, "does not match the started trace");
        }
      }
      if (!sameGitObject(payload.finalHead, lock.base.revision)) {
        compromiseReasons.add("contestantHeadChanged");
      }
      if (payload.stage === "beforeDispatch"
        && payload.finalWorkspaceFingerprintSha256
          !== lock.base.baseContentSha256) {
        compromiseReasons.add("preparationStateMismatch");
      }
      if (payload.status === "deliveryUnknown"
        || payload.failureCode === "terminationUnconfirmed") {
        compromiseReasons.add("terminationUnconfirmed");
      }
      contestant.finished = record;
      return;
    }

    if (!contestant.finished) {
      invalid(label, "requires a terminal contestant");
    }
    const finished = contestant.finished.payload as ArenaContestantFinishedPayload;

    if (record.type === "arenaVerificationRecorded") {
      if (compromiseReasons.size > 0) {
        invalid(label, "cannot verify after a control compromise is latched");
      }
      if (finished.stage !== "execution") {
        invalid(label, "verification requires an executed contestant");
      }
      const payload = record.payload as ArenaVerificationRecordedPayload;
      const check = lock.verificationChecks.find((candidate) =>
        candidate.checkId === payload.checkId);
      if (!check || check.planSha256 !== payload.planSha256) {
        invalid(label, "does not bind one locked verification check");
      }
      const attempts = contestant.verifications.get(payload.checkId) ?? [];
      validateAttemptAppend(attempts, payload.attempt, payload.status === "passed", label);
      attempts.push(record);
      contestant.verifications.set(payload.checkId, attempts);
      if (!sameGitObject(payload.head, finished.finalHead)
        || payload.workspaceFingerprintSha256 !== finished.finalWorkspaceFingerprintSha256) {
        compromiseReasons.add("verificationMutatedWorkspace");
      }
      if (!sameGitObject(payload.head, lock.base.revision)) {
        compromiseReasons.add("contestantHeadChanged");
      }
      return;
    }

    if (record.type === "arenaBrowserJourneyRecorded") {
      if (compromiseReasons.size > 0) {
        invalid(label, "cannot run a browser journey after a control compromise is latched");
      }
      if (finished.stage !== "execution") {
        invalid(label, "browser journeys require an executed contestant");
      }
      const payload = record.payload as ArenaBrowserJourneyRecordedPayload;
      const journey = lock.browserJourneys.find((candidate) =>
        candidate.journeyId === payload.journeyId);
      if (!journey || journey.planSha256 !== payload.planSha256) {
        invalid(label, "does not bind one locked browser journey");
      }
      const attempts = contestant.browserJourneys.get(payload.journeyId) ?? [];
      validateAttemptAppend(attempts, payload.attempt, payload.status === "passed", label);
      attempts.push(record);
      contestant.browserJourneys.set(payload.journeyId, attempts);
      if (!sameGitObject(payload.head, finished.finalHead)
        || payload.workspaceFingerprintSha256 !== finished.finalWorkspaceFingerprintSha256) {
        compromiseReasons.add("browserMutatedWorkspace");
      }
      if (!sameGitObject(payload.head, lock.base.revision)) {
        compromiseReasons.add("contestantHeadChanged");
      }
      return;
    }

    const payload = record.payload as ArenaEvidencePreservedPayload;
    const expectedReceiptsRoot = arenaReceiptsRootSha256(contestant);
    if (payload.receiptsRootSha256 !== expectedReceiptsRoot) {
      invalid(`${label}.payload.receiptsRootSha256`, "does not bind the contestant receipts");
    }
    if (!sameGitObject(payload.finalHead, finished.finalHead)
      || payload.finalWorkspaceFingerprintSha256 !== finished.finalWorkspaceFingerprintSha256) {
      compromiseReasons.add("evidenceStateMismatch");
    }
    if (!sameGitObject(payload.finalHead, lock.base.revision)) {
      compromiseReasons.add("contestantHeadChanged");
    }
    const terminal = finished;
    const uncertainTermination = terminal.status === "deliveryUnknown"
      || terminal.failureCode === "terminationUnconfirmed"
      || terminal.failureCode === "deliveryUnknown";
    if (uncertainTermination) {
      invalid(
        label,
        "uncertain termination evidence remains disabled until a typed private process-quiescence receipt is replay-validated",
      );
    } else if ((payload.quiescenceReceiptSha256 === null)
      !== (payload.quiescenceWorkspaceFingerprintSha256 === null)) {
      invalid(
        label,
        "quiescence receipt and fingerprint must both be present or both be null",
      );
    }
    contestant.evidencePreserved = record;
    latestEvidenceSequence = Math.max(latestEvidenceSequence, record.sequence);
  });

  const contestantReplays = [...contestants.values()].map((contestant) =>
    freezeContestantReplay(runId!, lock, contestant));
  const cleanupTargets = contestantReplays
    .filter((contestant) => contestant.worktreeRegistered !== undefined);
  const cleanupBlocked = cleanupTargets.some((contestant) =>
    contestant.cleanup.status === "blocked");
  const cleanupComplete = cleanupTargets.length > 0
    && cleanupTargets.every((contestant) => contestant.cleanup.status === "complete");
  const anyStarted = contestantReplays.some((contestant) =>
    contestant.worktreeRegistered !== undefined
      || contestant.worktreeProvisioned !== undefined
      || contestant.started !== undefined);
  const state: ArenaManifestReplay["state"] = finalization
    ? cleanupBlocked
      ? "cleanupBlocked"
      : cleanupComplete
        ? "cleanupComplete"
        : "finalized"
    : anyStarted
      ? "running"
      : "locked";
  const finalPayload = finalization?.payload as ArenaRunFinalizedPayload | undefined;
  return deepFreeze({
    runId: runId!,
    records,
    lock,
    state,
    contestants: contestantReplays,
    mainWorkspaceObservations,
    compromised: compromiseReasons.size > 0,
    compromiseReasons: [...compromiseReasons].sort(),
    ...(finalization ? { finalization } : {}),
    promotionEligible: finalPayload?.comparison === "comparable",
    latestEventSha256: records.at(-1)!.eventSha256,
  });
}

export function validateArenaManifestEvents(
  values: readonly unknown[],
): readonly string[] {
  try {
    replayArenaManifest(values);
    return [];
  } catch (error) {
    if (error instanceof ArenaManifestValidationError) return [...error.issues];
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function arenaReceiptsRootSha256(input: {
  readonly finished?: ArenaManifestEvent;
  readonly verifications: ReadonlyMap<string, readonly ArenaManifestEvent[]>;
  readonly browserJourneys: ReadonlyMap<string, readonly ArenaManifestEvent[]>;
}): string {
  if (!input.finished) {
    throw new ArenaManifestValidationError([
      "receipts: contestant must be terminal before receipt hashing",
    ]);
  }
  const canonical = {
    contestantFinishedEventSha256: input.finished.eventSha256,
    verificationEventSha256s: [...input.verifications.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .flatMap(([, attempts]) => attempts.map((event) => event.eventSha256)),
    browserJourneyEventSha256s: [...input.browserJourneys.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .flatMap(([, attempts]) => attempts.map((event) => event.eventSha256)),
  };
  return createHash("sha256")
    .update(ARENA_RECEIPTS_HASH_DOMAIN, "utf8")
    .update(canonicalArenaManifestJson(canonical), "utf8")
    .digest("hex");
}

export function arenaEvidenceMatrixSha256(
  input: ArenaEvidenceMatrixInput,
): string {
  const row = exactRecord(input, [
    "lockEventSha256",
    "postEvidenceEventSha256",
    "contestants",
  ], "matrix");
  const contestantRows = boundedArray(
    row.contestants,
    "matrix.contestants",
    ARENA_MANIFEST_LIMITS.maxContestants,
    2,
  );
  const contestantIds = new Set<string>();
  const contestants = contestantRows.map((candidate, index) => {
    const label = `matrix.contestants[${index}]`;
    const contestant = exactRecord(candidate, [
      "contestantId",
      "finishedEventSha256",
      "verificationEventSha256s",
      "browserJourneyEventSha256s",
      "evidenceEventSha256",
    ], label);
    const contestantId = identifier(contestant.contestantId, `${label}.contestantId`);
    if (contestantIds.has(contestantId)) {
      invalid(`${label}.contestantId`, `duplicates ${contestantId}`);
    }
    contestantIds.add(contestantId);
    return {
      contestantId,
      finishedEventSha256: sha256(
        contestant.finishedEventSha256,
        `${label}.finishedEventSha256`,
      ),
      verificationEventSha256s: digestArray(
        contestant.verificationEventSha256s,
        `${label}.verificationEventSha256s`,
      ),
      browserJourneyEventSha256s: digestArray(
        contestant.browserJourneyEventSha256s,
        `${label}.browserJourneyEventSha256s`,
      ),
      evidenceEventSha256: sha256(
        contestant.evidenceEventSha256,
        `${label}.evidenceEventSha256`,
      ),
    };
  });
  const canonical = {
    lockEventSha256: sha256(row.lockEventSha256, "matrix.lockEventSha256"),
    postEvidenceEventSha256: sha256(
      row.postEvidenceEventSha256,
      "matrix.postEvidenceEventSha256",
    ),
    contestants,
  };
  return createHash("sha256")
    .update(ARENA_MATRIX_HASH_DOMAIN, "utf8")
    .update(canonicalArenaManifestJson(canonical), "utf8")
    .digest("hex");
}

function parsePayload(
  type: ArenaManifestEventType,
  value: unknown,
  label: string,
): ArenaManifestPayload {
  switch (type) {
    case "arenaRunLocked":
      return parseRunLocked(value, label);
    case "arenaMainWorkspaceObserved":
      return parseMainWorkspaceObserved(value, label);
    case "arenaWorktreeRegistered":
      return parseWorktreeRegistered(value, label);
    case "arenaWorktreeProvisioned":
      return parseWorktreeProvisioned(value, label);
    case "arenaContestantStarted":
      return parseContestantStarted(value, label);
    case "arenaContestantFinished":
      return parseContestantFinished(value, label);
    case "arenaVerificationRecorded":
      return parseVerificationRecorded(value, label);
    case "arenaBrowserJourneyRecorded":
      return parseBrowserJourneyRecorded(value, label);
    case "arenaEvidencePreserved":
      return parseEvidencePreserved(value, label);
    case "arenaRunFinalized":
      return parseRunFinalized(value, label);
    case "arenaCleanupStepRecorded":
      return parseArenaCleanupStepPayload(value, label);
  }
}

function parseRunLocked(value: unknown, label: string): ArenaRunLockedPayload {
  const row = exactRecord(value, [
    "payloadType",
    "policy",
    "mission",
    "base",
    "inputBundleSha256",
    "preparationPlanSha256",
    "environmentPolicySha256",
    "budgetSha256",
    "verificationChecks",
    "browserJourneys",
    "contestants",
    "steering",
    "confirmation",
  ], label);
  literal(row.payloadType, "runLocked", `${label}.payloadType`);
  literal(row.policy, ARENA_POLICY_ID, `${label}.policy`);
  const missionRow = exactRecord(row.mission, [
    "missionId",
    "revision",
    "documentSha256",
    "bindingSha256",
  ], `${label}.mission`);
  const mission: ArenaMissionLock = {
    missionId: identifier(missionRow.missionId, `${label}.mission.missionId`),
    revision: positiveInteger(missionRow.revision, `${label}.mission.revision`),
    documentSha256: sha256(
      missionRow.documentSha256,
      `${label}.mission.documentSha256`,
    ),
    bindingSha256: sha256(
      missionRow.bindingSha256,
      `${label}.mission.bindingSha256`,
    ),
  };
  const baseRow = exactRecord(row.base, [
    "revision",
    "repositoryIdentitySha256",
    "baseContentSha256",
    "sourceWorkspaceFingerprintSha256",
    "repositoryControlSha256",
  ], `${label}.base`);
  const base: ArenaBaseLock = {
    revision: parseGitObject(baseRow.revision, `${label}.base.revision`),
    repositoryIdentitySha256: sha256(
      baseRow.repositoryIdentitySha256,
      `${label}.base.repositoryIdentitySha256`,
    ),
    baseContentSha256: sha256(
      baseRow.baseContentSha256,
      `${label}.base.baseContentSha256`,
    ),
    sourceWorkspaceFingerprintSha256: sha256(
      baseRow.sourceWorkspaceFingerprintSha256,
      `${label}.base.sourceWorkspaceFingerprintSha256`,
    ),
    repositoryControlSha256: sha256(
      baseRow.repositoryControlSha256,
      `${label}.base.repositoryControlSha256`,
    ),
  };
  const verificationChecks = parseLockedPlans(
    row.verificationChecks,
    "checkId",
    `${label}.verificationChecks`,
    ARENA_MANIFEST_LIMITS.maxVerificationChecks,
  ) as ArenaVerificationCheckLock[];
  const browserJourneys = parseLockedPlans(
    row.browserJourneys,
    "journeyId",
    `${label}.browserJourneys`,
    ARENA_MANIFEST_LIMITS.maxBrowserJourneys,
  ) as ArenaBrowserJourneyLock[];
  const contestantValues = boundedArray(
    row.contestants,
    `${label}.contestants`,
    ARENA_MANIFEST_LIMITS.maxContestants,
    2,
  );
  const contestants = contestantValues.map((candidate, index) =>
    parseContestantLock(candidate, `${label}.contestants[${index}]`));
  assertUnique(
    contestants.map((contestant) => contestant.contestantId),
    `${label}.contestants`,
    "contestantId",
  );
  assertUnique(
    contestants.map((contestant) => contestant.headId),
    `${label}.contestants`,
    "headId",
  );
  assertUnique(
    contestants.map((contestant) => contestant.worktreeId),
    `${label}.contestants`,
    "worktreeId",
  );
  const confirmationRow = exactRecord(row.confirmation, [
    "actorId",
    "action",
    "confirmationId",
  ], `${label}.confirmation`);
  return deepFreeze({
    payloadType: "runLocked",
    policy: ARENA_POLICY_ID,
    mission,
    base,
    inputBundleSha256: sha256(row.inputBundleSha256, `${label}.inputBundleSha256`),
    preparationPlanSha256: nullableSha256(
      row.preparationPlanSha256,
      `${label}.preparationPlanSha256`,
    ),
    environmentPolicySha256: sha256(
      row.environmentPolicySha256,
      `${label}.environmentPolicySha256`,
    ),
    budgetSha256: sha256(row.budgetSha256, `${label}.budgetSha256`),
    verificationChecks,
    browserJourneys,
    contestants,
    steering: literal(row.steering, "disabled", `${label}.steering`),
    confirmation: {
      actorId: literal(
        confirmationRow.actorId,
        "local-user",
        `${label}.confirmation.actorId`,
      ),
      action: literal(
        confirmationRow.action,
        "Confirm Arena Run",
        `${label}.confirmation.action`,
      ),
      confirmationId: identifier(
        confirmationRow.confirmationId,
        `${label}.confirmation.confirmationId`,
      ),
    },
  });
}

function parseMainWorkspaceObserved(
  value: unknown,
  label: string,
): ArenaMainWorkspaceObservedPayload {
  const row = exactRecord(value, [
    "payloadType",
    "observationKind",
    "monitorEpochId",
    "monitorReceiptSha256",
    "status",
    "sourceWorkspaceFingerprintSha256",
    "repositoryControlSha256",
    "head",
    "watcherChanged",
    "reasonCode",
  ], label);
  literal(row.payloadType, "mainWorkspaceObserved", `${label}.payloadType`);
  if (typeof row.observationKind !== "string"
    || !WORKSPACE_OBSERVATION_KINDS.has(
      row.observationKind as ArenaWorkspaceObservationKind,
    )) {
    invalid(`${label}.observationKind`, "must be a supported observation kind");
  }
  if (typeof row.status !== "string"
    || !WORKSPACE_STATUSES.has(row.status as ArenaWorkspaceObservationStatus)) {
    invalid(`${label}.status`, "must be a supported workspace observation status");
  }
  if (typeof row.watcherChanged !== "boolean") {
    invalid(`${label}.watcherChanged`, "must be a boolean");
  }
  if (row.reasonCode !== null
    && (typeof row.reasonCode !== "string"
      || !WORKSPACE_REASONS.has(row.reasonCode as ArenaWorkspaceObservationReason))) {
    invalid(`${label}.reasonCode`, "must be null or a supported reason");
  }
  const status = row.status as ArenaWorkspaceObservationStatus;
  const observationKind = row.observationKind as ArenaWorkspaceObservationKind;
  const monitorEpochId = identifier(row.monitorEpochId, `${label}.monitorEpochId`);
  const monitorReceiptSha256 = sha256(
    row.monitorReceiptSha256,
    `${label}.monitorReceiptSha256`,
  );
  const sourceWorkspaceFingerprintSha256 = nullableSha256(
    row.sourceWorkspaceFingerprintSha256,
    `${label}.sourceWorkspaceFingerprintSha256`,
  );
  const repositoryControlSha256 = nullableSha256(
    row.repositoryControlSha256,
    `${label}.repositoryControlSha256`,
  );
  const head = row.head === null ? null : parseGitObject(row.head, `${label}.head`);
  const watcherChanged = row.watcherChanged;
  const reasonCode = row.reasonCode as ArenaWorkspaceObservationReason | null;
  if (status === "unchanged") {
    if (sourceWorkspaceFingerprintSha256 === null
      || repositoryControlSha256 === null
      || head === null
      || watcherChanged
      || reasonCode !== null) {
      invalid(label, "unchanged requires complete hashes, no watcher change, and no reason");
    }
  } else if (reasonCode === null) {
    invalid(`${label}.reasonCode`, `${status} requires a reason`);
  }
  if (status === "changed"
    && (sourceWorkspaceFingerprintSha256 === null
      || repositoryControlSha256 === null
      || head === null)) {
    invalid(label, "changed requires the observed hashes and HEAD");
  }
  return deepFreeze({
    payloadType: "mainWorkspaceObserved",
    observationKind,
    monitorEpochId,
    monitorReceiptSha256,
    status,
    sourceWorkspaceFingerprintSha256,
    repositoryControlSha256,
    head,
    watcherChanged,
    reasonCode,
  });
}

function parseWorktreeProvisioned(
  value: unknown,
  label: string,
): ArenaWorktreeProvisionedPayload {
  const row = exactRecord(value, [
    "payloadType",
    "contestantId",
    "worktreeId",
    "baseRevision",
    "registrationSha256",
    "initialFingerprintSha256",
    "preparationPlanSha256",
    "preparationStatus",
    "preparationReceiptSha256",
    "preparedFingerprintSha256",
  ], label);
  literal(row.payloadType, "worktreeProvisioned", `${label}.payloadType`);
  if (typeof row.preparationStatus !== "string"
    || !PREPARATION_STATUSES.has(row.preparationStatus as ArenaPreparationStatus)) {
    invalid(`${label}.preparationStatus`, "must be a supported preparation status");
  }
  const preparationStatus = row.preparationStatus as ArenaPreparationStatus;
  const initialFingerprintSha256 = sha256(
    row.initialFingerprintSha256,
    `${label}.initialFingerprintSha256`,
  );
  const preparationPlanSha256 = nullableSha256(
    row.preparationPlanSha256,
    `${label}.preparationPlanSha256`,
  );
  const preparationReceiptSha256 = nullableSha256(
    row.preparationReceiptSha256,
    `${label}.preparationReceiptSha256`,
  );
  const preparedFingerprintSha256 = sha256(
    row.preparedFingerprintSha256,
    `${label}.preparedFingerprintSha256`,
  );
  if (preparationPlanSha256 === null) {
    if (preparationStatus !== "succeeded"
      || preparationReceiptSha256 !== null
      || preparedFingerprintSha256 !== initialFingerprintSha256) {
      invalid(
        label,
        "no preparation plan requires success, no receipt, and an unchanged fingerprint",
      );
    }
  } else if (preparationReceiptSha256 === null) {
    invalid(`${label}.preparationReceiptSha256`, "a preparation plan requires a receipt");
  }
  return deepFreeze({
    payloadType: "worktreeProvisioned",
    contestantId: identifier(row.contestantId, `${label}.contestantId`),
    worktreeId: identifier(row.worktreeId, `${label}.worktreeId`),
    baseRevision: parseGitObject(row.baseRevision, `${label}.baseRevision`),
    registrationSha256: sha256(
      row.registrationSha256,
      `${label}.registrationSha256`,
    ),
    initialFingerprintSha256,
    preparationPlanSha256,
    preparationStatus,
    preparationReceiptSha256,
    preparedFingerprintSha256,
  });
}

function parseWorktreeRegistered(
  value: unknown,
  label: string,
): ArenaWorktreeRegisteredPayload {
  const row = exactRecord(value, [
    "payloadType",
    "contestantId",
    "worktreeId",
    "baseRevision",
    "registrationSha256",
    "initialFingerprintSha256",
  ], label);
  literal(row.payloadType, "worktreeRegistered", `${label}.payloadType`);
  return deepFreeze({
    payloadType: "worktreeRegistered",
    contestantId: identifier(row.contestantId, `${label}.contestantId`),
    worktreeId: identifier(row.worktreeId, `${label}.worktreeId`),
    baseRevision: parseGitObject(row.baseRevision, `${label}.baseRevision`),
    registrationSha256: sha256(
      row.registrationSha256,
      `${label}.registrationSha256`,
    ),
    initialFingerprintSha256: sha256(
      row.initialFingerprintSha256,
      `${label}.initialFingerprintSha256`,
    ),
  });
}

function parseContestantStarted(
  value: unknown,
  label: string,
): ArenaContestantStartedPayload {
  const row = exactRecord(value, [
    "payloadType",
    "contestantId",
    "traceId",
    "inputBundleSha256",
    "environmentPolicySha256",
    "budgetSha256",
    "promptSha256",
    "contextSha256",
    "invocationSha256",
    "authoritySha256",
    "preparedFingerprintSha256",
    "steering",
  ], label);
  literal(row.payloadType, "contestantStarted", `${label}.payloadType`);
  return deepFreeze({
    payloadType: "contestantStarted",
    contestantId: identifier(row.contestantId, `${label}.contestantId`),
    traceId: identifier(row.traceId, `${label}.traceId`),
    inputBundleSha256: sha256(
      row.inputBundleSha256,
      `${label}.inputBundleSha256`,
    ),
    environmentPolicySha256: sha256(
      row.environmentPolicySha256,
      `${label}.environmentPolicySha256`,
    ),
    budgetSha256: sha256(row.budgetSha256, `${label}.budgetSha256`),
    promptSha256: sha256(row.promptSha256, `${label}.promptSha256`),
    contextSha256: sha256(row.contextSha256, `${label}.contextSha256`),
    invocationSha256: sha256(row.invocationSha256, `${label}.invocationSha256`),
    authoritySha256: sha256(row.authoritySha256, `${label}.authoritySha256`),
    preparedFingerprintSha256: sha256(
      row.preparedFingerprintSha256,
      `${label}.preparedFingerprintSha256`,
    ),
    steering: literal(row.steering, "disabled", `${label}.steering`),
  });
}

function parseContestantFinished(
  value: unknown,
  label: string,
): ArenaContestantFinishedPayload {
  const row = exactRecord(value, [
    "payloadType",
    "contestantId",
    "stage",
    "traceId",
    "status",
    "failureCode",
    "finalHead",
    "finalWorkspaceFingerprintSha256",
    "outputSha256",
    "outputBytes",
  ], label);
  literal(row.payloadType, "contestantFinished", `${label}.payloadType`);
  if (typeof row.stage !== "string"
    || !CONTESTANT_TERMINAL_STAGES.has(
      row.stage as ArenaContestantTerminalStage,
    )) {
    invalid(`${label}.stage`, "must be a supported contestant terminal stage");
  }
  if (typeof row.status !== "string"
    || !CONTESTANT_STATUSES.has(row.status as ArenaContestantTerminalStatus)) {
    invalid(`${label}.status`, "must be a supported contestant status");
  }
  if (row.failureCode !== null
    && (typeof row.failureCode !== "string"
      || !CONTESTANT_FAILURE_CODES.has(row.failureCode as ArenaContestantFailureCode))) {
    invalid(`${label}.failureCode`, "must be null or a supported contestant failure code");
  }
  const status = row.status as ArenaContestantTerminalStatus;
  const stage = row.stage as ArenaContestantTerminalStage;
  const failureCode = row.failureCode as ArenaContestantFailureCode | null;
  if ((status === "succeeded") !== (failureCode === null)) {
    invalid(label, "only succeeded may carry a null failure code");
  }
  if (status === "cancelled" && failureCode !== "cancelled") {
    invalid(`${label}.failureCode`, "cancelled requires the cancelled failure code");
  }
  if (status === "timedOut" && failureCode !== "timeout") {
    invalid(`${label}.failureCode`, "timedOut requires the timeout failure code");
  }
  if (status === "deliveryUnknown"
    && failureCode !== "deliveryUnknown"
    && failureCode !== "terminationUnconfirmed") {
    invalid(
      `${label}.failureCode`,
      "deliveryUnknown requires deliveryUnknown or terminationUnconfirmed",
    );
  }
  if (status === "failed"
    && (failureCode === "cancelled"
      || failureCode === "timeout"
      || failureCode === "deliveryUnknown"
      || failureCode === "terminationUnconfirmed")) {
    invalid(`${label}.failureCode`, "failed must not use a different terminal class");
  }
  const traceId = row.traceId === null
    ? null
    : identifier(row.traceId, `${label}.traceId`);
  if (stage === "beforeDispatch") {
    if (traceId !== null) {
      invalid(`${label}.traceId`, "beforeDispatch requires a null trace");
    }
    if (status !== "failed" && status !== "cancelled" && status !== "timedOut") {
      invalid(
        `${label}.status`,
        "beforeDispatch permits only failed, cancelled, or timedOut",
      );
    }
    if (status === "failed"
      && failureCode !== "preparationFailed"
      && failureCode !== "dispatchRejected"
      && failureCode !== "missionMismatch"
      && failureCode !== "authorityMismatch"
      && failureCode !== "budgetExceeded"
      && failureCode !== "unknown") {
      invalid(
        `${label}.failureCode`,
        "beforeDispatch failed requires a pre-dispatch failure code",
      );
    }
  } else if (traceId === null) {
    invalid(`${label}.traceId`, "execution requires a trace");
  }
  return deepFreeze({
    payloadType: "contestantFinished",
    contestantId: identifier(row.contestantId, `${label}.contestantId`),
    stage,
    traceId,
    status,
    failureCode,
    finalHead: parseGitObject(row.finalHead, `${label}.finalHead`),
    finalWorkspaceFingerprintSha256: sha256(
      row.finalWorkspaceFingerprintSha256,
      `${label}.finalWorkspaceFingerprintSha256`,
    ),
    outputSha256: sha256(row.outputSha256, `${label}.outputSha256`),
    outputBytes: boundedBytes(row.outputBytes, `${label}.outputBytes`),
  });
}

function parseVerificationRecorded(
  value: unknown,
  label: string,
): ArenaVerificationRecordedPayload {
  const row = exactRecord(value, [
    "payloadType",
    "contestantId",
    "checkId",
    "attempt",
    "planSha256",
    "status",
    "receiptSha256",
    "head",
    "workspaceFingerprintSha256",
  ], label);
  literal(row.payloadType, "verificationRecorded", `${label}.payloadType`);
  if (typeof row.status !== "string"
    || !VERIFICATION_STATUSES.has(row.status as ArenaVerificationStatus)) {
    invalid(`${label}.status`, "must be a supported verification status");
  }
  return deepFreeze({
    payloadType: "verificationRecorded",
    contestantId: identifier(row.contestantId, `${label}.contestantId`),
    checkId: identifier(row.checkId, `${label}.checkId`),
    attempt: boundedAttempt(row.attempt, `${label}.attempt`),
    planSha256: sha256(row.planSha256, `${label}.planSha256`),
    status: row.status as ArenaVerificationStatus,
    receiptSha256: sha256(row.receiptSha256, `${label}.receiptSha256`),
    head: parseGitObject(row.head, `${label}.head`),
    workspaceFingerprintSha256: sha256(
      row.workspaceFingerprintSha256,
      `${label}.workspaceFingerprintSha256`,
    ),
  });
}

function parseBrowserJourneyRecorded(
  value: unknown,
  label: string,
): ArenaBrowserJourneyRecordedPayload {
  const row = exactRecord(value, [
    "payloadType",
    "contestantId",
    "journeyId",
    "attempt",
    "planSha256",
    "status",
    "receiptSha256",
    "head",
    "workspaceFingerprintSha256",
  ], label);
  literal(row.payloadType, "browserJourneyRecorded", `${label}.payloadType`);
  if (typeof row.status !== "string"
    || !BROWSER_STATUSES.has(row.status as ArenaBrowserJourneyStatus)) {
    invalid(`${label}.status`, "must be a supported browser journey status");
  }
  return deepFreeze({
    payloadType: "browserJourneyRecorded",
    contestantId: identifier(row.contestantId, `${label}.contestantId`),
    journeyId: identifier(row.journeyId, `${label}.journeyId`),
    attempt: boundedAttempt(row.attempt, `${label}.attempt`),
    planSha256: sha256(row.planSha256, `${label}.planSha256`),
    status: row.status as ArenaBrowserJourneyStatus,
    receiptSha256: sha256(row.receiptSha256, `${label}.receiptSha256`),
    head: parseGitObject(row.head, `${label}.head`),
    workspaceFingerprintSha256: sha256(
      row.workspaceFingerprintSha256,
      `${label}.workspaceFingerprintSha256`,
    ),
  });
}

function parseEvidencePreserved(
  value: unknown,
  label: string,
): ArenaEvidencePreservedPayload {
  const row = exactRecord(value, [
    "payloadType",
    "contestantId",
    "artifactSetSha256",
    "receiptsRootSha256",
    "patchSha256",
    "patchBytes",
    "untrackedArchiveSha256",
    "untrackedArchiveBytes",
    "inventorySha256",
    "quiescenceReceiptSha256",
    "quiescenceWorkspaceFingerprintSha256",
    "finalHead",
    "finalWorkspaceFingerprintSha256",
  ], label);
  literal(row.payloadType, "evidencePreserved", `${label}.payloadType`);
  const untrackedArchiveSha256 = nullableSha256(
    row.untrackedArchiveSha256,
    `${label}.untrackedArchiveSha256`,
  );
  const untrackedArchiveBytes = boundedBytes(
    row.untrackedArchiveBytes,
    `${label}.untrackedArchiveBytes`,
  );
  if ((untrackedArchiveSha256 === null) !== (untrackedArchiveBytes === 0)) {
    invalid(label, "untracked archive hash is null exactly when its byte count is zero");
  }
  const quiescenceReceiptSha256 = nullableSha256(
    row.quiescenceReceiptSha256,
    `${label}.quiescenceReceiptSha256`,
  );
  const quiescenceWorkspaceFingerprintSha256 = nullableSha256(
    row.quiescenceWorkspaceFingerprintSha256,
    `${label}.quiescenceWorkspaceFingerprintSha256`,
  );
  if ((quiescenceReceiptSha256 === null)
    !== (quiescenceWorkspaceFingerprintSha256 === null)) {
    invalid(label, "quiescence receipt and fingerprint must both be present or both be null");
  }
  return deepFreeze({
    payloadType: "evidencePreserved",
    contestantId: identifier(row.contestantId, `${label}.contestantId`),
    artifactSetSha256: sha256(row.artifactSetSha256, `${label}.artifactSetSha256`),
    receiptsRootSha256: sha256(row.receiptsRootSha256, `${label}.receiptsRootSha256`),
    patchSha256: sha256(row.patchSha256, `${label}.patchSha256`),
    patchBytes: boundedBytes(row.patchBytes, `${label}.patchBytes`),
    untrackedArchiveSha256,
    untrackedArchiveBytes,
    inventorySha256: sha256(row.inventorySha256, `${label}.inventorySha256`),
    quiescenceReceiptSha256,
    quiescenceWorkspaceFingerprintSha256,
    finalHead: parseGitObject(row.finalHead, `${label}.finalHead`),
    finalWorkspaceFingerprintSha256: sha256(
      row.finalWorkspaceFingerprintSha256,
      `${label}.finalWorkspaceFingerprintSha256`,
    ),
  });
}

function parseRunFinalized(
  value: unknown,
  label: string,
): ArenaRunFinalizedPayload {
  const row = exactRecord(value, [
    "payloadType",
    "outcome",
    "comparison",
    "reasonCode",
    "evidenceMatrixSha256",
  ], label);
  literal(row.payloadType, "runFinalized", `${label}.payloadType`);
  if (typeof row.outcome !== "string"
    || !RUN_OUTCOMES.has(row.outcome as ArenaRunOutcome)) {
    invalid(`${label}.outcome`, "must be a supported Arena run outcome");
  }
  if (typeof row.comparison !== "string"
    || !COMPARISON_CLASSIFICATIONS.has(row.comparison as ArenaComparisonClassification)) {
    invalid(`${label}.comparison`, "must be a supported comparison classification");
  }
  if (row.reasonCode !== null
    && (typeof row.reasonCode !== "string"
      || !FINALIZATION_REASONS.has(row.reasonCode as ArenaFinalizationReason))) {
    invalid(`${label}.reasonCode`, "must be null or a supported finalization reason");
  }
  return deepFreeze({
    payloadType: "runFinalized",
    outcome: row.outcome as ArenaRunOutcome,
    comparison: row.comparison as ArenaComparisonClassification,
    reasonCode: row.reasonCode as ArenaFinalizationReason | null,
    evidenceMatrixSha256: nullableSha256(
      row.evidenceMatrixSha256,
      `${label}.evidenceMatrixSha256`,
    ),
  });
}

function parseContestantLock(value: unknown, label: string): ArenaContestantLock {
  const row = exactRecord(value, [
    "contestantId",
    "headId",
    "agentKind",
    "headConfigSha256",
    "authoritySha256",
    "invocationSha256",
    "worktreeId",
  ], label);
  if (!isValidAgentId(row.headId)) {
    invalid(`${label}.headId`, "must be a valid canonical Hydra agent id");
  }
  return deepFreeze({
    contestantId: identifier(row.contestantId, `${label}.contestantId`),
    headId: row.headId,
    agentKind: identifier(row.agentKind, `${label}.agentKind`),
    headConfigSha256: sha256(row.headConfigSha256, `${label}.headConfigSha256`),
    authoritySha256: sha256(row.authoritySha256, `${label}.authoritySha256`),
    invocationSha256: sha256(row.invocationSha256, `${label}.invocationSha256`),
    worktreeId: identifier(row.worktreeId, `${label}.worktreeId`),
  });
}

function parseLockedPlans(
  value: unknown,
  idKey: "checkId" | "journeyId",
  label: string,
  maximum: number,
): Array<ArenaVerificationCheckLock | ArenaBrowserJourneyLock> {
  const values = boundedArray(value, label, maximum);
  const plans = values.map((candidate, index) => {
    const row = exactRecord(candidate, [idKey, "planSha256"], `${label}[${index}]`);
    return deepFreeze({
      [idKey]: identifier(row[idKey], `${label}[${index}].${idKey}`),
      planSha256: sha256(row.planSha256, `${label}[${index}].planSha256`),
    });
  });
  assertUnique(
    plans.map((plan) => (plan as unknown as Record<string, string>)[idKey]!),
    label,
    idKey,
  );
  return plans as unknown as Array<
    ArenaVerificationCheckLock | ArenaBrowserJourneyLock
  >;
}

function parseGitObject(value: unknown, label: string): ArenaGitObjectId {
  const row = exactRecord(value, ["objectFormat", "oid"], label);
  if (row.objectFormat !== "sha1" && row.objectFormat !== "sha256") {
    invalid(`${label}.objectFormat`, "must be sha1 or sha256");
  }
  const expectedLength = row.objectFormat === "sha1" ? 40 : 64;
  if (typeof row.oid !== "string"
    || row.oid.length !== expectedLength
    || !/^[a-f0-9]+$/.test(row.oid)) {
    invalid(`${label}.oid`, `must be ${expectedLength} lowercase hexadecimal characters`);
  }
  return deepFreeze({
    objectFormat: row.objectFormat,
    oid: row.oid,
  });
}

function sameGitObject(left: ArenaGitObjectId, right: ArenaGitObjectId): boolean {
  return left.objectFormat === right.objectFormat && left.oid === right.oid;
}

function contestantIdForPayload(payload: ArenaManifestPayload): string {
  if ("contestantId" in payload && typeof payload.contestantId === "string") {
    return payload.contestantId;
  }
  invalid("payload.contestantId", "is required for a contestant event");
}

function requiredContestant(
  contestants: ReadonlyMap<string, MutableContestantReplay>,
  contestantId: string,
  label: string,
): MutableContestantReplay {
  const contestant = contestants.get(contestantId);
  if (!contestant) {
    invalid(`${label}.payload.contestantId`, "references an unknown contestant");
  }
  return contestant;
}

function validateAttemptAppend(
  attempts: readonly ArenaManifestEvent[],
  attempt: number,
  isPassing: boolean,
  label: string,
): void {
  if (attempt !== attempts.length + 1) {
    invalid(`${label}.payload.attempt`, `must be ${attempts.length + 1}`);
  }
  const previous = attempts.at(-1);
  if (previous) {
    const previousPayload = previous.payload as
      | ArenaVerificationRecordedPayload
      | ArenaBrowserJourneyRecordedPayload;
    if (previousPayload.status === "passed") {
      invalid(label, "cannot append an attempt after a passing receipt");
    }
  }
  if (isPassing && attempts.length >= ARENA_MANIFEST_LIMITS.maxAttemptsPerCheck) {
    invalid(label, "exceeds the bounded attempt count");
  }
}

function hasAllReceipts(
  lock: ArenaRunLockedPayload,
  contestant: MutableContestantReplay,
): boolean {
  return lock.verificationChecks.every((check) =>
    (contestant.verifications.get(check.checkId)?.length ?? 0) > 0)
    && lock.browserJourneys.every((journey) =>
      (contestant.browserJourneys.get(journey.journeyId)?.length ?? 0) > 0);
}

function evidenceMatrixSha256ForReplay(
  lockEvent: ArenaManifestEvent,
  postEvidenceObservation: ArenaManifestEvent,
  lock: ArenaRunLockedPayload,
  contestants: ReadonlyMap<string, MutableContestantReplay>,
): string {
  return arenaEvidenceMatrixSha256({
    lockEventSha256: lockEvent.eventSha256,
    postEvidenceEventSha256: postEvidenceObservation.eventSha256,
    contestants: lock.contestants.map((contestantLock) => {
      const contestant = contestants.get(contestantLock.contestantId)!;
      return {
        contestantId: contestantLock.contestantId,
        finishedEventSha256: contestant.finished!.eventSha256,
        verificationEventSha256s: lock.verificationChecks.flatMap((check) =>
          (contestant.verifications.get(check.checkId) ?? [])
            .map((event) => event.eventSha256)),
        browserJourneyEventSha256s: lock.browserJourneys.flatMap((journey) =>
          (contestant.browserJourneys.get(journey.journeyId) ?? [])
            .map((event) => event.eventSha256)),
        evidenceEventSha256: contestant.evidencePreserved!.eventSha256,
      };
    }),
  });
}

function hasComparableContestantEvidence(
  lock: ArenaRunLockedPayload,
  contestant: MutableContestantReplay,
): boolean {
  if (!contestant.started
    || !contestant.finished
    || !contestant.evidencePreserved
    || !hasAllReceipts(lock, contestant)) {
    return false;
  }
  const finished = contestant.finished.payload as ArenaContestantFinishedPayload;
  return finished.stage === "execution"
    && finished.status === "succeeded"
    && finished.failureCode === null;
}

function allowedFinalizationReasons(
  compromiseReasons: ReadonlySet<string>,
): ReadonlySet<ArenaFinalizationReason> {
  const allowed = new Set<ArenaFinalizationReason>();
  for (const reason of compromiseReasons) {
    if (reason === "watcherChanged"
      || reason === "workspaceFingerprintChanged"
      || reason === "headChanged") {
      allowed.add("mainWorkspaceChanged");
    } else if (reason === "repositoryControlChanged"
      || reason === "registryMismatch") {
      allowed.add("repositoryControlChanged");
    } else if (reason === "monitorFailed" || reason === "fingerprintFailed") {
      allowed.add("monitorFailed");
    } else if (reason === "preparationStateMismatch"
      || reason === "terminationUnconfirmed") {
      allowed.add(reason);
    } else if (reason === "contestantHeadChanged"
      || reason === "verificationMutatedWorkspace"
      || reason === "browserMutatedWorkspace"
      || reason === "evidenceStateMismatch"
      || reason === "unknown") {
      allowed.add(reason);
    }
  }
  return allowed;
}

function freezeContestantReplay(
  runId: string,
  lock: ArenaRunLockedPayload,
  contestant: MutableContestantReplay,
): ArenaContestantReplay {
  const cleanup = replayArenaCleanupSteps(
    runId,
    contestant.lock.contestantId,
    contestant.cleanupRecords,
  );
  return deepFreeze({
    lock: contestant.lock,
    ...(contestant.worktreeRegistered
      ? { worktreeRegistered: contestant.worktreeRegistered }
      : {}),
    ...(contestant.worktreeProvisioned
      ? { worktreeProvisioned: contestant.worktreeProvisioned }
      : {}),
    ...(contestant.started ? { started: contestant.started } : {}),
    ...(contestant.finished ? { finished: contestant.finished } : {}),
    verifications: lock.verificationChecks.map((check) => ({
      checkId: check.checkId,
      attempts: contestant.verifications.get(check.checkId) ?? [],
    })),
    browserJourneys: lock.browserJourneys.map((journey) => ({
      journeyId: journey.journeyId,
      attempts: contestant.browserJourneys.get(journey.journeyId) ?? [],
    })),
    ...(contestant.evidencePreserved
      ? { evidencePreserved: contestant.evidencePreserved }
      : {}),
    cleanup,
  });
}

function boundedArray(
  value: unknown,
  label: string,
  maximum: number,
  minimum = 0,
): unknown[] {
  if (!Array.isArray(value)) invalid(label, "must be an array");
  if (value.length < minimum || value.length > maximum) {
    invalid(label, `must contain ${minimum}-${maximum} items`);
  }
  return value;
}

function digestArray(value: unknown, label: string): readonly string[] {
  return boundedArray(value, label, ARENA_MANIFEST_LIMITS.maxEvents)
    .map((candidate, index) => sha256(candidate, `${label}[${index}]`));
}

function boundedAttempt(value: unknown, label: string): number {
  const attempt = positiveInteger(value, label);
  if (attempt > ARENA_MANIFEST_LIMITS.maxAttemptsPerCheck) {
    invalid(label, `must not exceed ${ARENA_MANIFEST_LIMITS.maxAttemptsPerCheck}`);
  }
  return attempt;
}

function boundedBytes(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)
    || (value as number) < 0
    || (value as number) > ARENA_MANIFEST_LIMITS.maxArtifactBytes
    || Object.is(value, -0)) {
    invalid(
      label,
      `must be a non-negative safe integer not exceeding ${ARENA_MANIFEST_LIMITS.maxArtifactBytes}`,
    );
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || Object.is(value, -0)) {
    invalid(label, "must be a positive safe integer");
  }
  return value as number;
}

function nullableSha256(value: unknown, label: string): string | null {
  return value === null ? null : sha256(value, label);
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid(label, "must be a lowercase SHA-256 hexadecimal digest");
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    invalid(label, `must match ${IDENTIFIER_PATTERN}`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(label, "must be a canonical UTC timestamp");
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    invalid(label, "must be a canonical UTC timestamp");
  }
  return value;
}

function literal<T extends string | number>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) invalid(label, `must equal ${JSON.stringify(expected)}`);
  return expected;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) invalid(label, "must be a plain object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    const missing = expected.filter((key) => !actual.includes(key));
    const unknown = actual.filter((key) => !expected.includes(key));
    const details = [
      missing.length > 0 ? `missing ${missing.join(", ")}` : "",
      unknown.length > 0 ? `unknown ${unknown.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    invalid(label, `must contain exactly [${expected.join(", ")}]${details ? ` (${details})` : ""}`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertUnique(
  values: readonly string[],
  label: string,
  field: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) invalid(label, `contains duplicate ${field} ${value}`);
    seen.add(value);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

function invalid(label: string, message: string): never {
  throw new ArenaManifestValidationError([`${label}: ${message}`]);
}
