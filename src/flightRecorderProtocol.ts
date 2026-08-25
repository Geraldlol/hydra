import { createHash } from "node:crypto";
import { UNBOUND_MISSION_BINDING_SHA256 } from "./missionContract";

export const FLIGHT_SCHEMA_ID = "hydra.flight.v1" as const;
export const FLIGHT_SCHEMA_VERSION = 1 as const;

export const FLIGHT_LIMITS = Object.freeze({
  maxTraceBytes: 8 * 1024 * 1024,
  maxRecordsPerTrace: 10_000,
  maxRecordBytes: 16 * 1024,
  reservedTerminalRecords: 2,
  reservedTerminalBytes: 2 * 16 * 1024,
  maxOpenOperations: 256,
  maxIdentifierChars: 256,
  maxLabelChars: 256,
});

export const FLIGHT_GENESIS_SHA256 = createHash("sha256")
  .update("hydra.flight.v1.genesis", "utf8")
  .digest("hex");

export type FlightRecordType =
  | "traceStarted"
  | "operationStarted"
  | "operationEvent"
  | "operationFinished"
  | "traceLimited"
  | "traceFinished";

export type FlightOperationKind =
  | "roomTurn"
  | "phase"
  | "agentRun"
  | "toolCall"
  | "editBatch"
  | "approval"
  | "steeringDelivery"
  | "verification"
  | "usage"
  | "nativeAction"
  | "browserAction"
  | "replay"
  | "evalCase";

export type FlightEvidenceClass = "hydraObserved" | "providerObserved";
export type FlightTelemetryDetail = "structured" | "unavailable" | "limited" | "notApplicable";
export type FlightTerminalStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timedOut"
  | "blocked"
  | "denied"
  | "deliveryUnknown"
  | "incomplete";

export type FlightFailureCode =
  | "cancelled"
  | "timeout"
  | "providerFailure"
  | "transportFailure"
  | "guardBlocked"
  | "consentDenied"
  | "terminationUnconfirmed"
  | "validationFailure"
  | "recorderFailure"
  | "unsupported"
  | "deliveryUnknown"
  | "unknown";

export type FlightLimitReason =
  | "recordCapacity"
  | "byteCapacity"
  | "recordSize"
  | "providerFlood"
  | "normalizerOverflow"
  | "openOperations"
  | "recorderFailure";

export interface FlightSteeringChainMetadata {
  readonly sha256: string;
  readonly indeterminate: boolean;
}

export interface FlightOutputMetadata {
  readonly bytes: number;
  readonly sha256: string;
}

export interface FlightTraceStartedPayload {
  readonly payloadType: "traceStarted";
  readonly roomTurnId: string;
  readonly ownerId: string;
  readonly source: "localUser" | "telegram" | "system" | "replay" | "eval";
  readonly contentCapture: "off";
  readonly baseRevisionSha: string | null;
  readonly missionDocumentSha256: string | null;
  readonly missionBindingSha256: string;
}

export interface FlightPhaseSubject {
  readonly kind: "phase";
  readonly phase: string;
}

export interface FlightAgentRunSubject {
  readonly kind: "agentRun";
  readonly runId: string;
  readonly headId: string;
  readonly agentKind: string;
  readonly phase: string;
  readonly provider: string;
  readonly model: string;
  readonly plannedTransport: string;
  readonly authorityClass: "readOnly" | "workspaceWrite" | "fullNative" | "unknown";
  readonly authoritySha256: string;
  readonly promptSha256: string;
  readonly contextSha256: string;
  readonly promptCharacters: number;
  readonly telemetryDetail: FlightTelemetryDetail;
  readonly initialSteeringChain: FlightSteeringChainMetadata;
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightToolCallSubject {
  readonly kind: "toolCall";
  readonly provider: string;
  readonly toolName: string;
  readonly providerOperationIdSha256: string;
  readonly argumentBytes: number;
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightEditBatchSubject {
  readonly kind: "editBatch";
  readonly provider: string;
  readonly createCount: number;
  readonly updateCount: number;
  readonly deleteCount: number;
  readonly pathCount: number;
  readonly workspaceBeforeSha256: string;
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightApprovalSubject {
  readonly kind: "approval";
  readonly approvalKind: "browser" | "nativeAction" | "mission" | "mcpMutation" | "tool" | "other";
  readonly policy: string;
  readonly targetSha256: string;
  readonly source: "localUser" | "system";
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightSteeringDeliverySubject {
  readonly kind: "steeringDelivery";
  readonly steeringId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly deliveryClass:
    | "sameTurn"
    | "yieldThenNext"
    | "sameSessionNextTurn"
    | "nextHydraTurn"
    | "unsupported";
  readonly messageSha256: string;
  readonly messageBytes: number;
  readonly priorSteeringChain: FlightSteeringChainMetadata;
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightVerificationSubject {
  readonly kind: "verification";
  readonly verificationId: string;
  readonly planSha256: string;
  readonly invocationShapeSha256: string;
  readonly sourceRunId: string | null;
  readonly sourceSteeringChain: FlightSteeringChainMetadata | null;
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightUsageSubject {
  readonly kind: "usage";
  readonly usageId: string;
  readonly runId: string;
  readonly model: string;
  readonly source: "native" | "computed";
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightNativeActionSubject {
  readonly kind: "nativeAction";
  readonly nativeActionId: string;
  readonly actionKind: string;
  readonly headCount: number;
  readonly attachmentCount: number;
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightBrowserActionSubject {
  readonly kind: "browserAction";
  readonly requestId: string;
  readonly action: "navigate" | "click" | "type" | "screenshot" | "inspect" | "other";
  readonly targetSha256: string;
  readonly approvalRequired: boolean;
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightReplaySubject {
  readonly kind: "replay";
  readonly replayId: string;
  readonly sourceTraceId: string;
  readonly sourceRootSha256: string;
  readonly baseRevisionSha: string;
  readonly exactContentAvailable: boolean;
  readonly isolatedWorktree: true;
  readonly consentReceiptSha256: string;
  readonly costGateReceiptSha256: string;
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightEvalCaseSubject {
  readonly kind: "evalCase";
  readonly evalCaseId: string;
  readonly sourceTraceId: string;
  readonly sourceRootSha256: string;
  readonly caseVersion: number;
  readonly outcomeSource: "deterministicMapping" | "human";
  readonly evidenceClass: FlightEvidenceClass;
}

export type FlightOperationSubject =
  | FlightPhaseSubject
  | FlightAgentRunSubject
  | FlightToolCallSubject
  | FlightEditBatchSubject
  | FlightApprovalSubject
  | FlightSteeringDeliverySubject
  | FlightVerificationSubject
  | FlightUsageSubject
  | FlightNativeActionSubject
  | FlightBrowserActionSubject
  | FlightReplaySubject
  | FlightEvalCaseSubject;

export interface FlightOperationStartedPayload {
  readonly payloadType: "operationStarted";
  readonly subject: FlightOperationSubject;
}

export interface FlightPhaseTransitionObservation {
  readonly kind: "phase";
  readonly observationType: "phaseTransition";
  readonly fromPhase: string;
  readonly toPhase: string;
  readonly trigger: string;
}

export interface FlightDispatchDecisionObservation {
  readonly kind: "agentRun";
  readonly observationType: "dispatchDecision";
  readonly decision: "submitted" | "blocked" | "denied";
  readonly code: FlightFailureCode | null;
  readonly invocationShapeSha256: string;
}

export interface FlightTelemetryAvailabilityObservation {
  readonly kind: "agentRun";
  readonly observationType: "telemetryAvailability";
  readonly detail: FlightTelemetryDetail;
  readonly reason: "plainOutput" | "unsupported" | "malformed" | "providerFlood" | "notRequested";
}

export interface FlightToolCallResultObservation {
  readonly kind: "toolCall";
  readonly observationType: "toolCallResult";
  readonly status: "succeeded" | "failed" | "unknown";
  readonly resultBytes: number;
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightWorkspaceMutationObservation {
  readonly kind: "editBatch";
  readonly observationType: "workspaceMutation";
  readonly createCount: number;
  readonly updateCount: number;
  readonly deleteCount: number;
  readonly pathCount: number;
  readonly workspaceAfterSha256: string;
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightApprovalDecisionObservation {
  readonly kind: "approval";
  readonly observationType: "approvalDecision";
  readonly outcome: "allowed" | "denied" | "expired" | "revoked";
  readonly code: FlightFailureCode | null;
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightSteeringOutcomeObservation {
  readonly kind: "steeringDelivery";
  readonly observationType: "steeringOutcome";
  readonly steeringId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly outcome:
    | "acknowledged"
    | "sentUnconfirmed"
    | "missedWindow"
    | "unsupported"
    | "rejected"
    | "failed"
    | "deliveryUnknown";
  readonly code: string;
  readonly steeringChain: FlightSteeringChainMetadata;
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightVerificationReceiptObservation {
  readonly kind: "verification";
  readonly observationType: "verificationReceipt";
  readonly receiptSha256: string;
  readonly headRevisionSha: string | null;
  readonly exitCode: number | null;
  readonly stdout: FlightOutputMetadata;
  readonly stderr: FlightOutputMetadata;
  readonly sourceSteeringChain: FlightSteeringChainMetadata | null;
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightUsageSummaryObservation {
  readonly kind: "usage";
  readonly observationType: "usageSummary";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly reasoningTokens: number;
  readonly totalCostUsd: number | null;
  readonly costSource: "native" | "computed";
  readonly steeringChain: FlightSteeringChainMetadata;
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightNativeActionReceiptObservation {
  readonly kind: "nativeAction";
  readonly observationType: "nativeActionReceipt";
  readonly receiptSha256: string;
  readonly status: "recorded" | "started" | "succeeded" | "failed" | "rejected";
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightBrowserApprovalObservation {
  readonly kind: "browserAction";
  readonly observationType: "browserApproval";
  readonly outcome: "allowed" | "denied" | "expired" | "revoked" | "notRequired";
  readonly resultBytes: number;
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightReplayGateObservation {
  readonly kind: "replay";
  readonly observationType: "replayGate";
  readonly consent: "confirmed" | "denied";
  readonly costGate: "confirmed" | "denied";
  readonly contentBinding: "exact" | "derived" | "missing";
  readonly baseBinding: "exact" | "drifted";
}

export interface FlightEvalCaseBindingObservation {
  readonly kind: "evalCase";
  readonly observationType: "evalCaseBinding";
  readonly contractSha256: string;
  readonly acceptancePlanSha256: string;
  readonly status: "created" | "corrected" | "voided";
}

export type FlightOperationObservation =
  | FlightPhaseTransitionObservation
  | FlightDispatchDecisionObservation
  | FlightTelemetryAvailabilityObservation
  | FlightToolCallResultObservation
  | FlightWorkspaceMutationObservation
  | FlightApprovalDecisionObservation
  | FlightSteeringOutcomeObservation
  | FlightVerificationReceiptObservation
  | FlightUsageSummaryObservation
  | FlightNativeActionReceiptObservation
  | FlightBrowserApprovalObservation
  | FlightReplayGateObservation
  | FlightEvalCaseBindingObservation;

export interface FlightOperationEventPayload {
  readonly payloadType: "operationEvent";
  readonly observation: FlightOperationObservation;
}

export interface FlightOperationFinishedPayload {
  readonly payloadType: "operationFinished";
  readonly status: FlightTerminalStatus;
  readonly durationMs: number;
  readonly failureCode: FlightFailureCode | null;
  readonly output: FlightOutputMetadata | null;
  readonly steeringChain: FlightSteeringChainMetadata | null;
  /**
   * Runtime path selected for the operation. This is not proof that provider
   * bytes crossed the boundary; terminal status/failureCode carries the
   * authoritative zero-write or delivery-uncertainty classification.
   */
  readonly actualTransport: string | null;
  readonly evidenceClass: FlightEvidenceClass;
}

export interface FlightTraceLimitedPayload {
  readonly payloadType: "traceLimited";
  readonly reason: FlightLimitReason;
  readonly droppedRecordsAtLeast: number;
  readonly telemetryCompleteness: "limited";
}

export interface FlightTraceFinishedPayload {
  readonly payloadType: "traceFinished";
  readonly status: FlightTerminalStatus;
  readonly durationMs: number;
  readonly operationCount: number;
  readonly openOperationCount: number;
  readonly recordCount: number;
  readonly limited: boolean;
  readonly incomplete: boolean;
}

export type FlightRecordPayload =
  | FlightTraceStartedPayload
  | FlightOperationStartedPayload
  | FlightOperationEventPayload
  | FlightOperationFinishedPayload
  | FlightTraceLimitedPayload
  | FlightTraceFinishedPayload;

export interface FlightRecord {
  readonly schemaVersion: typeof FLIGHT_SCHEMA_VERSION;
  readonly recordId: string;
  readonly traceId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly recordType: FlightRecordType;
  readonly operationKind: FlightOperationKind;
  readonly operationId?: string;
  readonly parentOperationId?: string;
  readonly missionBindingSha256: string;
  readonly previousRecordSha256: string;
  readonly recordSha256: string;
  readonly payload: FlightRecordPayload;
}

export interface FlightRecordDraft {
  readonly recordId: string;
  readonly traceId: string;
  readonly occurredAt: string;
  readonly recordType: FlightRecordType;
  readonly operationKind: FlightOperationKind;
  readonly operationId?: string;
  readonly parentOperationId?: string;
  readonly missionBindingSha256: string;
  readonly payload: FlightRecordPayload;
}

export type FlightTraceValidationCode =
  | "emptyTrace"
  | "recordCount"
  | "traceBytes"
  | "recordBytes"
  | "invalidRecord"
  | "invalidHash"
  | "invalidSequence"
  | "invalidPreviousHash"
  | "duplicateRecordId"
  | "traceMismatch"
  | "missionMismatch"
  | "missingTraceStart"
  | "duplicateTraceStart"
  | "recordAfterTraceFinish"
  | "recordAfterTraceLimit"
  | "duplicateTraceLimit"
  | "duplicateOperationId"
  | "openOperationLimit"
  | "orphanParent"
  | "unknownOperation"
  | "operationKindMismatch"
  | "parentMismatch"
  | "operationHasOpenChildren"
  | "operationAfterFinish"
  | "doubleOperationFinish"
  | "invalidTraceFinish";

export interface FlightTraceValidationIssue {
  readonly code: FlightTraceValidationCode;
  readonly sequence?: number;
  readonly message: string;
}

export class FlightTraceValidationError extends Error {
  constructor(readonly issues: readonly FlightTraceValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "FlightTraceValidationError";
  }
}

export interface FlightOperationReplay {
  readonly operationId: string;
  readonly operationKind: Exclude<FlightOperationKind, "roomTurn">;
  readonly parentOperationId?: string;
  readonly startedSequence: number;
  readonly finishedSequence?: number;
}

export interface FlightTraceReplay {
  readonly traceId: string;
  readonly missionBindingSha256: string;
  readonly records: readonly FlightRecord[];
  readonly state: "active" | "finished";
  readonly completeness: "active" | "complete" | "limited" | "incomplete";
  readonly limited: boolean;
  readonly incomplete: boolean;
  readonly rootRecordSha256: string;
  readonly operationCount: number;
  readonly openOperationCount: number;
  readonly operations: readonly FlightOperationReplay[];
}

const RECORD_TYPES = new Set<FlightRecordType>([
  "traceStarted",
  "operationStarted",
  "operationEvent",
  "operationFinished",
  "traceLimited",
  "traceFinished",
]);
const OPERATION_KINDS = new Set<FlightOperationKind>([
  "roomTurn",
  "phase",
  "agentRun",
  "toolCall",
  "editBatch",
  "approval",
  "steeringDelivery",
  "verification",
  "usage",
  "nativeAction",
  "browserAction",
  "replay",
  "evalCase",
]);
const TERMINAL_STATUSES = new Set<FlightTerminalStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "timedOut",
  "blocked",
  "denied",
  "deliveryUnknown",
  "incomplete",
]);
const FAILURE_CODES = new Set<FlightFailureCode>([
  "cancelled",
  "timeout",
  "providerFailure",
  "transportFailure",
  "guardBlocked",
  "consentDenied",
  "terminationUnconfirmed",
  "validationFailure",
  "recorderFailure",
  "unsupported",
  "deliveryUnknown",
  "unknown",
]);
const LIMIT_REASONS = new Set<FlightLimitReason>([
  "recordCapacity",
  "byteCapacity",
  "recordSize",
  "providerFlood",
  "normalizerOverflow",
  "openOperations",
  "recorderFailure",
]);
const EVIDENCE_CLASSES = new Set<FlightEvidenceClass>([
  "hydraObserved",
  "providerObserved",
]);
const TELEMETRY_DETAILS = new Set<FlightTelemetryDetail>([
  "structured",
  "unavailable",
  "limited",
  "notApplicable",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PRINTABLE_IDENTIFIER_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;

export function createFlightRecord(
  draft: FlightRecordDraft,
  sequence: number,
  previousRecordSha256: string,
): FlightRecord {
  const withoutHash = {
    schemaVersion: FLIGHT_SCHEMA_VERSION,
    recordId: draft.recordId,
    traceId: draft.traceId,
    sequence,
    occurredAt: draft.occurredAt,
    recordType: draft.recordType,
    operationKind: draft.operationKind,
    ...(draft.operationId === undefined ? {} : { operationId: draft.operationId }),
    ...(draft.parentOperationId === undefined
      ? {}
      : { parentOperationId: draft.parentOperationId }),
    missionBindingSha256: draft.missionBindingSha256,
    previousRecordSha256,
    payload: draft.payload,
  };
  const record: FlightRecord = {
    ...withoutHash,
    recordSha256: computeFlightRecordSha256(withoutHash),
  };
  if (!isFlightRecord(record)) {
    throw new Error("Refusing to create an invalid hydra.flight.v1 record.");
  }
  return record;
}

export function computeFlightRecordSha256(
  record: Omit<FlightRecord, "recordSha256"> | Record<string, unknown>,
): string {
  const hashInput = { ...record } as Record<string, unknown>;
  delete hashInput.recordSha256;
  return createHash("sha256")
    .update("hydra.flight.v1.record\u0000", "utf8")
    .update(canonicalFlightJson(hashInput), "utf8")
    .digest("hex");
}

export function canonicalFlightJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Flight hashes require finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalFlightJson).join(",")}]`;
  }
  if (!isRecord(value)) throw new Error("Flight hashes require JSON-compatible values.");
  const entries = Object.keys(value)
    .sort()
    .map((key) => {
      const entry = value[key];
      if (entry === undefined) throw new Error("Flight hashes reject undefined values.");
      return `${JSON.stringify(key)}:${canonicalFlightJson(entry)}`;
    });
  return `{${entries.join(",")}}`;
}

export function isFlightRecord(value: unknown): value is FlightRecord {
  if (!isRecord(value)
    || value.schemaVersion !== FLIGHT_SCHEMA_VERSION
    || !isBoundedIdentifier(value.recordId)
    || !isFlightTraceId(value.traceId)
    || !isPositiveSafeInteger(value.sequence)
    || !isCanonicalTimestamp(value.occurredAt)
    || typeof value.recordType !== "string"
    || !RECORD_TYPES.has(value.recordType as FlightRecordType)
    || typeof value.operationKind !== "string"
    || !OPERATION_KINDS.has(value.operationKind as FlightOperationKind)
    || !isSha256(value.missionBindingSha256)
    || !isSha256(value.previousRecordSha256)
    || !isSha256(value.recordSha256)) {
    return false;
  }

  const baseKeys = [
    "schemaVersion",
    "recordId",
    "traceId",
    "sequence",
    "occurredAt",
    "recordType",
    "operationKind",
    "missionBindingSha256",
    "previousRecordSha256",
    "recordSha256",
    "payload",
  ];
  const hasOperation = typeof value.operationId === "string";
  const hasParent = typeof value.parentOperationId === "string";
  const expectedKeys = [
    ...baseKeys,
    ...(hasOperation ? ["operationId"] : []),
    ...(hasParent ? ["parentOperationId"] : []),
  ];
  if (!hasExactKeys(value, expectedKeys)
    || (hasOperation && !isBoundedIdentifier(value.operationId))
    || (hasParent && !isBoundedIdentifier(value.parentOperationId))) {
    return false;
  }

  const recordType = value.recordType as FlightRecordType;
  const operationKind = value.operationKind as FlightOperationKind;
  if (recordType === "traceStarted") {
    return !hasOperation
      && !hasParent
      && operationKind === "roomTurn"
      && isTraceStartedPayload(value.payload);
  }
  if (recordType === "traceLimited") {
    return !hasOperation
      && !hasParent
      && operationKind === "roomTurn"
      && isTraceLimitedPayload(value.payload);
  }
  if (recordType === "traceFinished") {
    return !hasOperation
      && !hasParent
      && operationKind === "roomTurn"
      && isTraceFinishedPayload(value.payload);
  }
  if (!hasOperation || operationKind === "roomTurn") return false;
  if (recordType === "operationStarted") {
    return isOperationStartedPayload(value.payload, operationKind);
  }
  if (recordType === "operationEvent") {
    return isOperationEventPayload(value.payload, operationKind);
  }
  return isOperationFinishedPayload(value.payload, operationKind);
}

export function replayFlightTrace(records: readonly FlightRecord[]): FlightTraceReplay {
  const issues: FlightTraceValidationIssue[] = [];
  if (records.length === 0) {
    throw new FlightTraceValidationError([{
      code: "emptyTrace",
      message: "A Flight Recorder trace must start with a traceStarted record.",
    }]);
  }
  if (records.length > FLIGHT_LIMITS.maxRecordsPerTrace) {
    issues.push({
      code: "recordCount",
      message: `Flight trace exceeds ${FLIGHT_LIMITS.maxRecordsPerTrace} records.`,
    });
  }

  const recordIds = new Set<string>();
  const operations = new Map<string, {
    operationKind: Exclude<FlightOperationKind, "roomTurn">;
    parentOperationId?: string;
    startedSequence: number;
    finishedSequence?: number;
  }>();
  let totalBytes = 0;
  let expectedTraceId: string | undefined;
  let expectedMission: string | undefined;
  let previousHash = FLIGHT_GENESIS_SHA256;
  let sawStart = false;
  let sawFinish = false;
  let sawLimit = false;

  records.forEach((record, index) => {
    const sequence = index + 1;
    const encodedBytes = Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8");
    totalBytes += encodedBytes;
    if (encodedBytes > FLIGHT_LIMITS.maxRecordBytes) {
      issues.push({
        code: "recordBytes",
        sequence,
        message: `Flight record ${sequence} exceeds ${FLIGHT_LIMITS.maxRecordBytes} bytes.`,
      });
    }
    if (!isFlightRecord(record)) {
      issues.push({
        code: "invalidRecord",
        sequence,
        message: `Flight record ${sequence} has an unknown or non-exact schema.`,
      });
      return;
    }
    if (computeFlightRecordSha256(record) !== record.recordSha256) {
      issues.push({
        code: "invalidHash",
        sequence,
        message: `Flight record ${sequence} has an invalid domain-separated hash.`,
      });
    }
    if (record.sequence !== sequence) {
      issues.push({
        code: "invalidSequence",
        sequence,
        message: `Flight record ${sequence} does not have the expected sequence number.`,
      });
    }
    if (record.previousRecordSha256 !== previousHash) {
      issues.push({
        code: "invalidPreviousHash",
        sequence,
        message: `Flight record ${sequence} does not bind the previous record hash.`,
      });
    }
    previousHash = record.recordSha256;

    if (recordIds.has(record.recordId)) {
      issues.push({
        code: "duplicateRecordId",
        sequence,
        message: `Flight record ID ${record.recordId} is duplicated.`,
      });
    }
    recordIds.add(record.recordId);

    expectedTraceId ??= record.traceId;
    expectedMission ??= record.missionBindingSha256;
    if (record.traceId !== expectedTraceId) {
      issues.push({
        code: "traceMismatch",
        sequence,
        message: `Flight record ${sequence} crosses trace identities.`,
      });
    }
    if (record.missionBindingSha256 !== expectedMission) {
      issues.push({
        code: "missionMismatch",
        sequence,
        message: `Flight record ${sequence} crosses Mission Contract bindings.`,
      });
    }
    if (sawFinish) {
      issues.push({
        code: "recordAfterTraceFinish",
        sequence,
        message: `Flight record ${sequence} appears after traceFinished.`,
      });
      return;
    }
    if (record.recordType === "traceStarted") {
      if (sawStart || sequence !== 1) {
        issues.push({
          code: "duplicateTraceStart",
          sequence,
          message: "traceStarted must appear exactly once at sequence 1.",
        });
      }
      if (record.previousRecordSha256 !== FLIGHT_GENESIS_SHA256) {
        issues.push({
          code: "invalidPreviousHash",
          sequence,
          message: "traceStarted must bind the Flight Recorder genesis hash.",
        });
      }
      const payload = record.payload as FlightTraceStartedPayload;
      if (payload.missionBindingSha256 !== record.missionBindingSha256) {
        issues.push({
          code: "missionMismatch",
          sequence,
          message: "traceStarted mission binding does not match the record envelope.",
        });
      }
      sawStart = true;
      return;
    }
    if (!sawStart) {
      issues.push({
        code: "missingTraceStart",
        sequence,
        message: `Flight record ${sequence} appears before traceStarted.`,
      });
      return;
    }
    if (sawLimit && record.recordType !== "traceFinished") {
      issues.push({
        code: record.recordType === "traceLimited"
          ? "duplicateTraceLimit"
          : "recordAfterTraceLimit",
        sequence,
        message: record.recordType === "traceLimited"
          ? "A hydra.flight.v1 trace may contain only one traceLimited record."
          : `Flight record ${sequence} appears after the absorbing traceLimited marker.`,
      });
      return;
    }
    if (record.recordType === "traceLimited") {
      sawLimit = true;
      return;
    }
    if (record.recordType === "traceFinished") {
      const payload = record.payload as FlightTraceFinishedPayload;
      const openCount = [...operations.values()]
        .filter((operation) => operation.finishedSequence === undefined)
        .length;
      if (payload.recordCount !== record.sequence
        || payload.operationCount !== operations.size
        || payload.openOperationCount !== openCount
        || payload.limited !== sawLimit
        || payload.incomplete !== (payload.status === "incomplete")
        || (sawLimit && (!payload.limited
          || !payload.incomplete
          || payload.status !== "incomplete"))
        || (!payload.incomplete && openCount !== 0)) {
        issues.push({
          code: "invalidTraceFinish",
          sequence,
          message: "traceFinished does not match the replayed trace lifecycle.",
        });
      }
      sawFinish = true;
      return;
    }

    const operationId = record.operationId!;
    if (record.recordType === "operationStarted") {
      if (operations.has(operationId)) {
        issues.push({
          code: "duplicateOperationId",
          sequence,
          message: `Operation ${operationId} is started more than once.`,
        });
        return;
      }
      const openCount = [...operations.values()]
        .filter((operation) => operation.finishedSequence === undefined)
        .length;
      if (openCount >= FLIGHT_LIMITS.maxOpenOperations) {
        issues.push({
          code: "openOperationLimit",
          sequence,
          message: `Trace exceeds ${FLIGHT_LIMITS.maxOpenOperations} concurrently open operations.`,
        });
        return;
      }
      if (record.parentOperationId !== undefined) {
        const parent = operations.get(record.parentOperationId);
        if (!parent || parent.finishedSequence !== undefined) {
          issues.push({
            code: "orphanParent",
            sequence,
            message: `Operation ${operationId} has an unknown or closed parent.`,
          });
          return;
        }
      }
      operations.set(operationId, {
        operationKind: record.operationKind as Exclude<FlightOperationKind, "roomTurn">,
        ...(record.parentOperationId === undefined
          ? {}
          : { parentOperationId: record.parentOperationId }),
        startedSequence: sequence,
      });
      return;
    }

    const operation = operations.get(operationId);
    if (!operation) {
      issues.push({
        code: "unknownOperation",
        sequence,
        message: `Flight record ${sequence} references an operation that was not started.`,
      });
      return;
    }
    if (operation.operationKind !== record.operationKind) {
      issues.push({
        code: "operationKindMismatch",
        sequence,
        message: `Operation ${operationId} changes kind during replay.`,
      });
    }
    if (operation.parentOperationId !== record.parentOperationId) {
      issues.push({
        code: "parentMismatch",
        sequence,
        message: `Operation ${operationId} changes parent during replay.`,
      });
    }
    if (operation.finishedSequence !== undefined) {
      issues.push({
        code: record.recordType === "operationFinished"
          ? "doubleOperationFinish"
          : "operationAfterFinish",
        sequence,
        message: `Operation ${operationId} receives a record after its terminal outcome.`,
      });
      return;
    }
    if (record.recordType === "operationFinished") {
      const hasOpenChild = [...operations.values()].some((candidate) =>
        candidate.parentOperationId === operationId
        && candidate.finishedSequence === undefined
      );
      if (hasOpenChild) {
        issues.push({
          code: "operationHasOpenChildren",
          sequence,
          message: `Operation ${operationId} cannot finish before its open children.`,
        });
        return;
      }
      operation.finishedSequence = sequence;
    }
  });

  if (totalBytes > FLIGHT_LIMITS.maxTraceBytes) {
    issues.push({
      code: "traceBytes",
      message: `Flight trace exceeds ${FLIGHT_LIMITS.maxTraceBytes} bytes.`,
    });
  }
  if (!sawStart) {
    issues.push({
      code: "missingTraceStart",
      message: "Flight trace has no traceStarted record.",
    });
  }
  if (issues.length > 0) throw new FlightTraceValidationError(issues);

  const operationRows: FlightOperationReplay[] = [...operations.entries()].map(
    ([operationId, operation]) => ({
      operationId,
      operationKind: operation.operationKind,
      ...(operation.parentOperationId === undefined
        ? {}
        : { parentOperationId: operation.parentOperationId }),
      startedSequence: operation.startedSequence,
      ...(operation.finishedSequence === undefined
        ? {}
        : { finishedSequence: operation.finishedSequence }),
    }),
  );
  const last = records.at(-1)!;
  const terminal = last.recordType === "traceFinished"
    ? last.payload as FlightTraceFinishedPayload
    : undefined;
  // A trace that crossed a recorder bound stays visibly limited both while
  // active and after its necessarily-incomplete terminal record. Test the
  // absorbing limit state before the generic terminal-incomplete flag.
  const completeness = sawLimit
    ? "limited"
    : terminal === undefined
      ? "active"
      : terminal.incomplete
        ? "incomplete"
        : "complete";
  return {
    traceId: expectedTraceId!,
    missionBindingSha256: expectedMission!,
    records: [...records],
    state: terminal ? "finished" : "active",
    completeness,
    limited: sawLimit,
    incomplete: terminal?.incomplete ?? false,
    rootRecordSha256: last.recordSha256,
    operationCount: operations.size,
    openOperationCount: operationRows.filter((operation) =>
      operation.finishedSequence === undefined
    ).length,
    operations: operationRows,
  };
}

export function isFlightTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID_PATTERN.test(value);
}

export function isFlightSha256(value: unknown): value is string {
  return isSha256(value);
}

function isTraceStartedPayload(value: unknown): value is FlightTraceStartedPayload {
  return isRecord(value)
    && hasExactKeys(value, [
      "payloadType",
      "roomTurnId",
      "ownerId",
      "source",
      "contentCapture",
      "baseRevisionSha",
      "missionDocumentSha256",
      "missionBindingSha256",
    ])
    && value.payloadType === "traceStarted"
    && isBoundedIdentifier(value.roomTurnId)
    && isBoundedIdentifier(value.ownerId)
    && (value.source === "localUser"
      || value.source === "telegram"
      || value.source === "system"
      || value.source === "replay"
      || value.source === "eval")
    && value.contentCapture === "off"
    && (value.baseRevisionSha === null || isRevisionHash(value.baseRevisionSha))
    && isFlightMissionBindingPair(
      value.missionDocumentSha256,
      value.missionBindingSha256,
    );
}

export function isFlightMissionBindingPair(
  documentSha256: unknown,
  bindingSha256: unknown,
): documentSha256 is string | null {
  if (!isSha256(bindingSha256)) return false;
  return documentSha256 === null
    ? bindingSha256 === UNBOUND_MISSION_BINDING_SHA256
    : isSha256(documentSha256) && bindingSha256 !== UNBOUND_MISSION_BINDING_SHA256;
}

function isOperationStartedPayload(
  value: unknown,
  operationKind: FlightOperationKind,
): value is FlightOperationStartedPayload {
  return isRecord(value)
    && hasExactKeys(value, ["payloadType", "subject"])
    && value.payloadType === "operationStarted"
    && isOperationSubject(value.subject, operationKind);
}

function isOperationSubject(value: unknown, operationKind: FlightOperationKind): boolean {
  if (!isRecord(value) || value.kind !== operationKind) return false;
  switch (operationKind) {
    case "phase":
      return hasExactKeys(value, ["kind", "phase"])
        && isBoundedLabel(value.phase);
    case "agentRun":
      return hasExactKeys(value, [
        "kind",
        "runId",
        "headId",
        "agentKind",
        "phase",
        "provider",
        "model",
        "plannedTransport",
        "authorityClass",
        "authoritySha256",
        "promptSha256",
        "contextSha256",
        "promptCharacters",
        "telemetryDetail",
        "initialSteeringChain",
        "evidenceClass",
      ])
        && isBoundedIdentifier(value.runId)
        && isBoundedIdentifier(value.headId)
        && isBoundedLabel(value.agentKind)
        && isBoundedLabel(value.phase)
        && isBoundedLabel(value.provider)
        && isBoundedLabel(value.model)
        && isBoundedLabel(value.plannedTransport)
        && (value.authorityClass === "readOnly"
          || value.authorityClass === "workspaceWrite"
          || value.authorityClass === "fullNative"
          || value.authorityClass === "unknown")
        && isSha256(value.authoritySha256)
        && isSha256(value.promptSha256)
        && isSha256(value.contextSha256)
        && isNonNegativeSafeInteger(value.promptCharacters)
        && typeof value.telemetryDetail === "string"
        && TELEMETRY_DETAILS.has(value.telemetryDetail as FlightTelemetryDetail)
        && isSteeringChain(value.initialSteeringChain)
        && isEvidenceClass(value.evidenceClass);
    case "toolCall":
      return hasExactKeys(value, [
        "kind",
        "provider",
        "toolName",
        "providerOperationIdSha256",
        "argumentBytes",
        "evidenceClass",
      ])
        && isBoundedLabel(value.provider)
        && isBoundedLabel(value.toolName)
        && isSha256(value.providerOperationIdSha256)
        && isNonNegativeSafeInteger(value.argumentBytes)
        && isEvidenceClass(value.evidenceClass);
    case "editBatch":
      return hasExactKeys(value, [
        "kind",
        "provider",
        "createCount",
        "updateCount",
        "deleteCount",
        "pathCount",
        "workspaceBeforeSha256",
        "evidenceClass",
      ])
        && isBoundedLabel(value.provider)
        && areNonNegativeIntegers(
          value.createCount,
          value.updateCount,
          value.deleteCount,
          value.pathCount,
        )
        && value.pathCount === (value.createCount as number)
          + (value.updateCount as number)
          + (value.deleteCount as number)
        && isSha256(value.workspaceBeforeSha256)
        && isEvidenceClass(value.evidenceClass);
    case "approval":
      return hasExactKeys(value, [
        "kind",
        "approvalKind",
        "policy",
        "targetSha256",
        "source",
        "evidenceClass",
      ])
        && (value.approvalKind === "browser"
          || value.approvalKind === "nativeAction"
          || value.approvalKind === "mission"
          || value.approvalKind === "mcpMutation"
          || value.approvalKind === "tool"
          || value.approvalKind === "other")
        && isBoundedLabel(value.policy)
        && isSha256(value.targetSha256)
        && (value.source === "localUser" || value.source === "system")
        && isEvidenceClass(value.evidenceClass);
    case "steeringDelivery":
      return hasExactKeys(value, [
        "kind",
        "steeringId",
        "runId",
        "sequence",
        "deliveryClass",
        "messageSha256",
        "messageBytes",
        "priorSteeringChain",
        "evidenceClass",
      ])
        && isBoundedIdentifier(value.steeringId)
        && isBoundedIdentifier(value.runId)
        && isPositiveSafeInteger(value.sequence)
        && (value.deliveryClass === "sameTurn"
          || value.deliveryClass === "yieldThenNext"
          || value.deliveryClass === "sameSessionNextTurn"
          || value.deliveryClass === "nextHydraTurn"
          || value.deliveryClass === "unsupported")
        && isSha256(value.messageSha256)
        && isPositiveSafeInteger(value.messageBytes)
        && isSteeringChain(value.priorSteeringChain)
        && isEvidenceClass(value.evidenceClass);
    case "verification":
      return hasExactKeys(value, [
        "kind",
        "verificationId",
        "planSha256",
        "invocationShapeSha256",
        "sourceRunId",
        "sourceSteeringChain",
        "evidenceClass",
      ])
        && isBoundedIdentifier(value.verificationId)
        && isSha256(value.planSha256)
        && isSha256(value.invocationShapeSha256)
        && (value.sourceRunId === null || isBoundedIdentifier(value.sourceRunId))
        && (value.sourceSteeringChain === null
          || isSteeringChain(value.sourceSteeringChain))
        && ((value.sourceRunId === null) === (value.sourceSteeringChain === null))
        && isEvidenceClass(value.evidenceClass);
    case "usage":
      return hasExactKeys(value, [
        "kind",
        "usageId",
        "runId",
        "model",
        "source",
        "evidenceClass",
      ])
        && isBoundedIdentifier(value.usageId)
        && isBoundedIdentifier(value.runId)
        && isBoundedLabel(value.model)
        && (value.source === "native" || value.source === "computed")
        && isEvidenceClass(value.evidenceClass);
    case "nativeAction":
      return hasExactKeys(value, [
        "kind",
        "nativeActionId",
        "actionKind",
        "headCount",
        "attachmentCount",
        "evidenceClass",
      ])
        && isBoundedIdentifier(value.nativeActionId)
        && isBoundedLabel(value.actionKind)
        && areNonNegativeIntegers(value.headCount, value.attachmentCount)
        && isEvidenceClass(value.evidenceClass);
    case "browserAction":
      return hasExactKeys(value, [
        "kind",
        "requestId",
        "action",
        "targetSha256",
        "approvalRequired",
        "evidenceClass",
      ])
        && isBoundedIdentifier(value.requestId)
        && (value.action === "navigate"
          || value.action === "click"
          || value.action === "type"
          || value.action === "screenshot"
          || value.action === "inspect"
          || value.action === "other")
        && isSha256(value.targetSha256)
        && typeof value.approvalRequired === "boolean"
        && isEvidenceClass(value.evidenceClass);
    case "replay":
      return hasExactKeys(value, [
        "kind",
        "replayId",
        "sourceTraceId",
        "sourceRootSha256",
        "baseRevisionSha",
        "exactContentAvailable",
        "isolatedWorktree",
        "consentReceiptSha256",
        "costGateReceiptSha256",
        "evidenceClass",
      ])
        && isBoundedIdentifier(value.replayId)
        && isFlightTraceId(value.sourceTraceId)
        && isSha256(value.sourceRootSha256)
        && isRevisionHash(value.baseRevisionSha)
        && typeof value.exactContentAvailable === "boolean"
        && value.isolatedWorktree === true
        && isSha256(value.consentReceiptSha256)
        && isSha256(value.costGateReceiptSha256)
        && isEvidenceClass(value.evidenceClass);
    case "evalCase":
      return hasExactKeys(value, [
        "kind",
        "evalCaseId",
        "sourceTraceId",
        "sourceRootSha256",
        "caseVersion",
        "outcomeSource",
        "evidenceClass",
      ])
        && isBoundedIdentifier(value.evalCaseId)
        && isFlightTraceId(value.sourceTraceId)
        && isSha256(value.sourceRootSha256)
        && isPositiveSafeInteger(value.caseVersion)
        && (value.outcomeSource === "deterministicMapping" || value.outcomeSource === "human")
        && isEvidenceClass(value.evidenceClass);
    case "roomTurn":
      return false;
  }
}

function isOperationEventPayload(
  value: unknown,
  operationKind: FlightOperationKind,
): value is FlightOperationEventPayload {
  return isRecord(value)
    && hasExactKeys(value, ["payloadType", "observation"])
    && value.payloadType === "operationEvent"
    && isOperationObservation(value.observation, operationKind);
}

function isOperationObservation(value: unknown, operationKind: FlightOperationKind): boolean {
  if (!isRecord(value) || value.kind !== operationKind || typeof value.observationType !== "string") {
    return false;
  }
  switch (value.observationType) {
    case "phaseTransition":
      return operationKind === "phase"
        && hasExactKeys(value, [
          "kind",
          "observationType",
          "fromPhase",
          "toPhase",
          "trigger",
        ])
        && isBoundedLabel(value.fromPhase)
        && isBoundedLabel(value.toPhase)
        && isBoundedLabel(value.trigger);
    case "dispatchDecision":
      return operationKind === "agentRun"
        && hasExactKeys(value, [
          "kind",
          "observationType",
          "decision",
          "code",
          "invocationShapeSha256",
        ])
        && (value.decision === "submitted"
          || value.decision === "blocked"
          || value.decision === "denied")
        && isFailureCodeOrNull(value.code)
        && ((value.decision === "submitted") === (value.code === null))
        && isSha256(value.invocationShapeSha256);
    case "telemetryAvailability":
      return operationKind === "agentRun"
        && hasExactKeys(value, [
          "kind",
          "observationType",
          "detail",
          "reason",
        ])
        && typeof value.detail === "string"
        && TELEMETRY_DETAILS.has(value.detail as FlightTelemetryDetail)
        && (value.reason === "plainOutput"
          || value.reason === "unsupported"
          || value.reason === "malformed"
          || value.reason === "providerFlood"
          || value.reason === "notRequested");
    case "toolCallResult":
      return operationKind === "toolCall"
        && hasExactKeys(value, [
          "kind",
          "observationType",
          "status",
          "resultBytes",
          "evidenceClass",
        ])
        && (value.status === "succeeded"
          || value.status === "failed"
          || value.status === "unknown")
        && isNonNegativeSafeInteger(value.resultBytes)
        && isEvidenceClass(value.evidenceClass);
    case "workspaceMutation":
      return operationKind === "editBatch"
        && hasExactKeys(value, [
          "kind",
          "observationType",
          "createCount",
          "updateCount",
          "deleteCount",
          "pathCount",
          "workspaceAfterSha256",
          "evidenceClass",
        ])
        && areNonNegativeIntegers(
          value.createCount,
          value.updateCount,
          value.deleteCount,
          value.pathCount,
        )
        && value.pathCount === (value.createCount as number)
          + (value.updateCount as number)
          + (value.deleteCount as number)
        && isSha256(value.workspaceAfterSha256)
        && isEvidenceClass(value.evidenceClass);
    case "approvalDecision":
      return operationKind === "approval"
        && hasExactKeys(value, [
          "kind",
          "observationType",
          "outcome",
          "code",
          "evidenceClass",
        ])
        && (value.outcome === "allowed"
          || value.outcome === "denied"
          || value.outcome === "expired"
          || value.outcome === "revoked")
        && isFailureCodeOrNull(value.code)
        && ((value.outcome === "allowed") === (value.code === null))
        && isEvidenceClass(value.evidenceClass);
    case "steeringOutcome":
      return operationKind === "steeringDelivery"
        && hasExactKeys(value, [
          "kind",
          "observationType",
          "steeringId",
          "runId",
          "sequence",
          "outcome",
          "code",
          "steeringChain",
          "evidenceClass",
        ])
        && isBoundedIdentifier(value.steeringId)
        && isBoundedIdentifier(value.runId)
        && isPositiveSafeInteger(value.sequence)
        && (value.outcome === "acknowledged"
          || value.outcome === "sentUnconfirmed"
          || value.outcome === "missedWindow"
          || value.outcome === "unsupported"
          || value.outcome === "rejected"
          || value.outcome === "failed"
          || value.outcome === "deliveryUnknown")
        && isBoundedLabel(value.code)
        && isSteeringChain(value.steeringChain)
        && isEvidenceClass(value.evidenceClass);
    case "verificationReceipt":
      return operationKind === "verification"
        && hasExactKeys(value, [
          "kind",
          "observationType",
          "receiptSha256",
          "headRevisionSha",
          "exitCode",
          "stdout",
          "stderr",
          "sourceSteeringChain",
          "evidenceClass",
        ])
        && isSha256(value.receiptSha256)
        && (value.headRevisionSha === null || isRevisionHash(value.headRevisionSha))
        && (value.exitCode === null || isSignedSafeInteger(value.exitCode))
        && isOutputMetadata(value.stdout)
        && isOutputMetadata(value.stderr)
        && (value.sourceSteeringChain === null || isSteeringChain(value.sourceSteeringChain))
        && isEvidenceClass(value.evidenceClass);
    case "usageSummary":
      return operationKind === "usage"
        && hasExactKeys(value, [
          "kind",
          "observationType",
          "inputTokens",
          "outputTokens",
          "cacheReadTokens",
          "cacheCreationTokens",
          "reasoningTokens",
          "totalCostUsd",
          "costSource",
          "steeringChain",
          "evidenceClass",
        ])
        && areNonNegativeIntegers(
          value.inputTokens,
          value.outputTokens,
          value.cacheReadTokens,
          value.cacheCreationTokens,
          value.reasoningTokens,
        )
        && (value.totalCostUsd === null || isNonNegativeFinite(value.totalCostUsd))
        && (value.costSource === "native" || value.costSource === "computed")
        && isSteeringChain(value.steeringChain)
        && isEvidenceClass(value.evidenceClass);
    case "nativeActionReceipt":
      return operationKind === "nativeAction"
        && hasExactKeys(value, [
          "kind",
          "observationType",
          "receiptSha256",
          "status",
          "evidenceClass",
        ])
        && isSha256(value.receiptSha256)
        && (value.status === "recorded"
          || value.status === "started"
          || value.status === "succeeded"
          || value.status === "failed"
          || value.status === "rejected")
        && isEvidenceClass(value.evidenceClass);
    case "browserApproval":
      return operationKind === "browserAction"
        && hasExactKeys(value, [
          "kind",
          "observationType",
          "outcome",
          "resultBytes",
          "evidenceClass",
        ])
        && (value.outcome === "allowed"
          || value.outcome === "denied"
          || value.outcome === "expired"
          || value.outcome === "revoked"
          || value.outcome === "notRequired")
        && isNonNegativeSafeInteger(value.resultBytes)
        && isEvidenceClass(value.evidenceClass);
    case "replayGate":
      return operationKind === "replay"
        && hasExactKeys(value, [
          "kind",
          "observationType",
          "consent",
          "costGate",
          "contentBinding",
          "baseBinding",
        ])
        && (value.consent === "confirmed" || value.consent === "denied")
        && (value.costGate === "confirmed" || value.costGate === "denied")
        && (value.contentBinding === "exact"
          || value.contentBinding === "derived"
          || value.contentBinding === "missing")
        && (value.baseBinding === "exact" || value.baseBinding === "drifted");
    case "evalCaseBinding":
      return operationKind === "evalCase"
        && hasExactKeys(value, [
          "kind",
          "observationType",
          "contractSha256",
          "acceptancePlanSha256",
          "status",
        ])
        && isSha256(value.contractSha256)
        && isSha256(value.acceptancePlanSha256)
        && (value.status === "created"
          || value.status === "corrected"
          || value.status === "voided");
    default:
      return false;
  }
}

function isOperationFinishedPayload(
  value: unknown,
  operationKind: FlightOperationKind,
): value is FlightOperationFinishedPayload {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "payloadType",
      "status",
      "durationMs",
      "failureCode",
      "output",
      "steeringChain",
      "actualTransport",
      "evidenceClass",
    ])
    || value.payloadType !== "operationFinished"
    || typeof value.status !== "string"
    || !TERMINAL_STATUSES.has(value.status as FlightTerminalStatus)
    || !isNonNegativeFinite(value.durationMs)
    || !isFailureCodeOrNull(value.failureCode)
    || !(value.output === null || isOutputMetadata(value.output))
    || !(value.steeringChain === null || isSteeringChain(value.steeringChain))
    || !(value.actualTransport === null || isBoundedLabel(value.actualTransport))
    || !isEvidenceClass(value.evidenceClass)) {
    return false;
  }
  const succeeded = value.status === "succeeded";
  if (succeeded !== (value.failureCode === null)) return false;
  return operationKind === "agentRun"
    ? value.steeringChain !== null && value.actualTransport !== null
    : value.actualTransport === null;
}

function isTraceLimitedPayload(value: unknown): value is FlightTraceLimitedPayload {
  return isRecord(value)
    && hasExactKeys(value, [
      "payloadType",
      "reason",
      "droppedRecordsAtLeast",
      "telemetryCompleteness",
    ])
    && value.payloadType === "traceLimited"
    && typeof value.reason === "string"
    && LIMIT_REASONS.has(value.reason as FlightLimitReason)
    && isPositiveSafeInteger(value.droppedRecordsAtLeast)
    && value.telemetryCompleteness === "limited";
}

function isTraceFinishedPayload(value: unknown): value is FlightTraceFinishedPayload {
  return isRecord(value)
    && hasExactKeys(value, [
      "payloadType",
      "status",
      "durationMs",
      "operationCount",
      "openOperationCount",
      "recordCount",
      "limited",
      "incomplete",
    ])
    && value.payloadType === "traceFinished"
    && typeof value.status === "string"
    && TERMINAL_STATUSES.has(value.status as FlightTerminalStatus)
    && isNonNegativeFinite(value.durationMs)
    && areNonNegativeIntegers(value.operationCount, value.openOperationCount)
    && isPositiveSafeInteger(value.recordCount)
    && typeof value.limited === "boolean"
    && typeof value.incomplete === "boolean";
}

function isSteeringChain(value: unknown): value is FlightSteeringChainMetadata {
  return isRecord(value)
    && hasExactKeys(value, ["sha256", "indeterminate"])
    && isSha256(value.sha256)
    && typeof value.indeterminate === "boolean";
}

function isOutputMetadata(value: unknown): value is FlightOutputMetadata {
  return isRecord(value)
    && hasExactKeys(value, ["bytes", "sha256"])
    && isNonNegativeSafeInteger(value.bytes)
    && isSha256(value.sha256);
}

function isEvidenceClass(value: unknown): value is FlightEvidenceClass {
  return typeof value === "string"
    && EVIDENCE_CLASSES.has(value as FlightEvidenceClass);
}

function isFailureCodeOrNull(value: unknown): value is FlightFailureCode | null {
  return value === null
    || (typeof value === "string" && FAILURE_CODES.has(value as FlightFailureCode));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isRevisionHash(value: unknown): value is string {
  return typeof value === "string" && REVISION_PATTERN.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= FLIGHT_LIMITS.maxIdentifierChars
    && value.trim() === value
    && PRINTABLE_IDENTIFIER_PATTERN.test(value);
}

function isBoundedLabel(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= FLIGHT_LIMITS.maxLabelChars
    && value.trim() === value
    && PRINTABLE_IDENTIFIER_PATTERN.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSignedSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function areNonNegativeIntegers(...values: readonly unknown[]): boolean {
  return values.every(isNonNegativeSafeInteger);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}
