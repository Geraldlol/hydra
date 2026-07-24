import { createHash } from "node:crypto";

export const STEERING_SCHEMA_VERSION = 1 as const;

export const STEERING_LIMITS = Object.freeze({
  maxMessageBytes: 64 * 1024,
  maxTargetsPerRequest: 32,
  maxUnresolvedMessagesPerRoom: 32,
  maxUnresolvedMessagesPerRun: 8,
  maxUnresolvedBytes: 256 * 1024,
  maxIdentifierChars: 256,
  maxReasonChars: 512,
});

export type SteeringDelivery =
  | "sameTurn"
  | "yieldThenNext"
  | "sameSessionNextTurn"
  | "nextHydraTurn"
  | "unsupported";

export type LiveSteeringDelivery = Exclude<SteeringDelivery, "nextHydraTurn" | "unsupported">;

/**
 * Provider capability is deliberately three-way. A queue-only adapter is not
 * presented as live steering, and a disabled adapter cannot be invoked.
 */
export type SteeringCapability =
  | {
      readonly kind: "live";
      readonly delivery: LiveSteeringDelivery;
      readonly protocol: string;
    }
  | {
      readonly kind: "nextDispatch";
      readonly delivery: "nextHydraTurn";
      readonly reason: string;
    }
  | {
      readonly kind: "disabled";
      readonly delivery: "unsupported";
      readonly reason: string;
    };

export type SteeringWorkClass =
  | "discussion"
  | "build"
  | "review"
  | "missionTask"
  | "nestedWorker"
  | "sealedJury"
  | "formalDuel"
  | "deterministicReferee"
  | "hiddenMaintenance"
  | "verification"
  | "arenaLocked";

export type SteeringIntent = "steer" | "queue";

export type SteeringTerminalOutcome =
  | "acknowledged"
  | "sentUnconfirmed"
  | "missedWindow"
  | "unsupported"
  | "rejected"
  | "failed"
  | "deliveryUnknown";

export type SteeringDisposition =
  | "acceptedCurrent"
  | "yieldedThenAccepted"
  | "queuedProvider"
  | "queuedHydra"
  | "rejected"
  | "deliveryUnknown";

export type SteeringOutcomeCode =
  | "acknowledged"
  | "queueFull"
  | "staleHandle"
  | "endedBeforeAcceptance"
  | "unsupported"
  | "sealedWork"
  | "lockedArena"
  | "nonInteractiveWork"
  | "missionHashMismatch"
  | "authorityHashMismatch"
  | "remoteOwner"
  | "providerRejected"
  | "providerFailure"
  | "processExit"
  | "acknowledgementTimeout"
  | "malformedAcknowledgement";

export interface SteeringTextMetrics {
  readonly sha256: string;
  readonly characters: number;
  readonly bytes: number;
}

export interface SteeringTargetBinding {
  readonly callId: string;
  readonly generation: string;
  readonly agentId: string;
  readonly roomTurnId: string;
  readonly sequence: number;
  readonly expectedDelivery: SteeringDelivery;
  readonly missionContractSha256: string;
  readonly authoritySha256: string;
  readonly initialPromptSha256: string;
  readonly ownerId: string;
  readonly workClass: SteeringWorkClass;
}

export interface SteeringRequestedEvent {
  readonly schemaVersion: typeof STEERING_SCHEMA_VERSION;
  readonly type: "steeringRequested";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly steeringId: string;
  readonly source: "localUser";
  readonly intent: SteeringIntent;
  readonly roomTurnId: string;
  readonly textSha256: string;
  readonly textCharacters: number;
  readonly textBytes: number;
  readonly targets: readonly SteeringTargetBinding[];
}

export interface SteeringDeliveryStartedEvent {
  readonly schemaVersion: typeof STEERING_SCHEMA_VERSION;
  readonly type: "steeringDeliveryStarted";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly steeringId: string;
  readonly callId: string;
  readonly generation: string;
  readonly sequence: number;
  readonly priorSteeringChainSha256: string;
  readonly priorChainIndeterminate: boolean;
}

export interface SteeringTargetOutcomeEvent {
  readonly schemaVersion: typeof STEERING_SCHEMA_VERSION;
  readonly type: "steeringTargetOutcome";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly steeringId: string;
  readonly callId: string;
  readonly generation: string;
  readonly sequence: number;
  readonly outcome: SteeringTerminalOutcome;
  readonly disposition: SteeringDisposition;
  readonly code: SteeringOutcomeCode;
  readonly acknowledgedDelivery?: Exclude<SteeringDelivery, "unsupported">;
  readonly providerReceiptSha256?: string;
  readonly steeringChainSha256: string;
  readonly chainIndeterminate: boolean;
}

export type SteeringEvent =
  | SteeringRequestedEvent
  | SteeringDeliveryStartedEvent
  | SteeringTargetOutcomeEvent;

export interface SteeringProviderRequest {
  readonly schemaVersion: typeof STEERING_SCHEMA_VERSION;
  readonly steeringId: string;
  readonly source: "localUser";
  readonly intent: SteeringIntent;
  readonly text: string;
  readonly textSha256: string;
  readonly textCharacters: number;
  readonly textBytes: number;
  readonly target: SteeringTargetBinding;
}

export type SteeringProviderAcknowledgement =
  | {
      readonly schemaVersion: typeof STEERING_SCHEMA_VERSION;
      readonly status: "acknowledged";
      readonly steeringId: string;
      readonly callId: string;
      readonly generation: string;
      readonly sequence: number;
      readonly textSha256: string;
      readonly delivery: Exclude<SteeringDelivery, "unsupported">;
      readonly providerReceiptSha256: string;
    }
  | {
      readonly schemaVersion: typeof STEERING_SCHEMA_VERSION;
      readonly status: "rejected";
      readonly steeringId: string;
      readonly callId: string;
      readonly generation: string;
      readonly sequence: number;
      readonly textSha256: string;
      readonly delivery: SteeringDelivery;
      readonly reason: string;
    };

export interface SteeringChainBinding {
  readonly schemaVersion: typeof STEERING_SCHEMA_VERSION;
  readonly callId: string;
  readonly generation: string;
  readonly steeringChainSha256: string;
  readonly chainIndeterminate: boolean;
  readonly lastSequence: number;
  readonly lastTerminalSequence: number;
  readonly lastAcknowledgedSequence: number;
}

const STEERING_DELIVERIES = new Set<SteeringDelivery>([
  "sameTurn",
  "yieldThenNext",
  "sameSessionNextTurn",
  "nextHydraTurn",
  "unsupported",
]);
const LIVE_STEERING_DELIVERIES = new Set<LiveSteeringDelivery>([
  "sameTurn",
  "yieldThenNext",
  "sameSessionNextTurn",
]);
const WORK_CLASSES = new Set<SteeringWorkClass>([
  "discussion",
  "build",
  "review",
  "missionTask",
  "nestedWorker",
  "sealedJury",
  "formalDuel",
  "deterministicReferee",
  "hiddenMaintenance",
  "verification",
  "arenaLocked",
]);
const TERMINAL_OUTCOMES = new Set<SteeringTerminalOutcome>([
  "acknowledged",
  "sentUnconfirmed",
  "missedWindow",
  "unsupported",
  "rejected",
  "failed",
  "deliveryUnknown",
]);
const DISPOSITIONS = new Set<SteeringDisposition>([
  "acceptedCurrent",
  "yieldedThenAccepted",
  "queuedProvider",
  "queuedHydra",
  "rejected",
  "deliveryUnknown",
]);
const OUTCOME_CODES = new Set<SteeringOutcomeCode>([
  "acknowledged",
  "queueFull",
  "staleHandle",
  "endedBeforeAcceptance",
  "unsupported",
  "sealedWork",
  "lockedArena",
  "nonInteractiveWork",
  "missionHashMismatch",
  "authorityHashMismatch",
  "remoteOwner",
  "providerRejected",
  "providerFailure",
  "processExit",
  "acknowledgementTimeout",
  "malformedAcknowledgement",
]);
const IDENTIFIER_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function steeringTextMetrics(text: string): SteeringTextMetrics {
  return {
    sha256: sha256Utf8(text),
    characters: Array.from(text).length,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

export function validateSteeringText(text: unknown): SteeringTextMetrics {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("Steering text must be a non-empty string.");
  }
  const metrics = steeringTextMetrics(text);
  if (metrics.bytes > STEERING_LIMITS.maxMessageBytes) {
    throw new Error(`Steering text exceeds ${STEERING_LIMITS.maxMessageBytes} UTF-8 bytes.`);
  }
  return metrics;
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The whole acknowledged hash list is included on each calculation so replay,
 * receipts, and crash recovery all derive the same chain without trusting an
 * increment supplied by a provider.
 */
export function computeSteeringChainSha256(
  initialPromptSha256: string,
  acknowledgedMessageHashes: readonly string[],
): string {
  if (!isSha256(initialPromptSha256) || !acknowledgedMessageHashes.every(isSha256)) {
    throw new Error("Steering chains require lowercase SHA-256 bindings.");
  }
  const hash = createHash("sha256");
  hash.update("hydra-steering-chain-v1\u0000", "utf8");
  hash.update(initialPromptSha256, "ascii");
  for (const messageSha256 of acknowledgedMessageHashes) {
    hash.update("\u0000", "ascii");
    hash.update(messageSha256, "ascii");
  }
  return hash.digest("hex");
}

export function steeringTargetKey(
  target: Pick<SteeringTargetBinding, "callId" | "generation">,
): string {
  return `${target.callId}\u0000${target.generation}`;
}

export function steeringRequestTargetKey(
  target: Pick<SteeringTargetBinding, "callId" | "generation" | "sequence">,
): string {
  return `${steeringTargetKey(target)}\u0000${target.sequence}`;
}

export function dispositionForDelivery(
  delivery: Exclude<SteeringDelivery, "unsupported">,
): Exclude<SteeringDisposition, "rejected" | "deliveryUnknown"> {
  switch (delivery) {
    case "sameTurn":
      return "acceptedCurrent";
    case "yieldThenNext":
      return "yieldedThenAccepted";
    case "sameSessionNextTurn":
      return "queuedProvider";
    case "nextHydraTurn":
      return "queuedHydra";
  }
}

export function isLiveSteeringDelivery(value: unknown): value is LiveSteeringDelivery {
  return typeof value === "string" && LIVE_STEERING_DELIVERIES.has(value as LiveSteeringDelivery);
}

export function isSteeringCapability(value: unknown): value is SteeringCapability {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "live") {
    return hasExactKeys(value, ["kind", "delivery", "protocol"])
      && isLiveSteeringDelivery(value.delivery)
      && isBoundedIdentifier(value.protocol);
  }
  if (value.kind === "nextDispatch") {
    return hasExactKeys(value, ["kind", "delivery", "reason"])
      && value.delivery === "nextHydraTurn"
      && isReason(value.reason);
  }
  if (value.kind === "disabled") {
    return hasExactKeys(value, ["kind", "delivery", "reason"])
      && value.delivery === "unsupported"
      && isReason(value.reason);
  }
  return false;
}

export function isSteeringTargetBinding(value: unknown): value is SteeringTargetBinding {
  if (!isRecord(value) || !hasExactKeys(value, [
    "callId",
    "generation",
    "agentId",
    "roomTurnId",
    "sequence",
    "expectedDelivery",
    "missionContractSha256",
    "authoritySha256",
    "initialPromptSha256",
    "ownerId",
    "workClass",
  ])) {
    return false;
  }
  return isBoundedIdentifier(value.callId)
    && isBoundedIdentifier(value.generation)
    && isBoundedIdentifier(value.agentId)
    && isBoundedIdentifier(value.roomTurnId)
    && isPositiveSafeInteger(value.sequence)
    && typeof value.expectedDelivery === "string"
    && STEERING_DELIVERIES.has(value.expectedDelivery as SteeringDelivery)
    && isSha256(value.missionContractSha256)
    && isSha256(value.authoritySha256)
    && isSha256(value.initialPromptSha256)
    && isBoundedIdentifier(value.ownerId)
    && typeof value.workClass === "string"
    && WORK_CLASSES.has(value.workClass as SteeringWorkClass);
}

export function isSteeringEvent(value: unknown): value is SteeringEvent {
  if (!isRecord(value) || value.schemaVersion !== STEERING_SCHEMA_VERSION || typeof value.type !== "string") {
    return false;
  }
  if (value.type === "steeringRequested") {
    if (!hasExactKeys(value, [
      "schemaVersion",
      "type",
      "eventId",
      "occurredAt",
      "steeringId",
      "source",
      "intent",
      "roomTurnId",
      "textSha256",
      "textCharacters",
      "textBytes",
      "targets",
    ])) {
      return false;
    }
    return isEventHeader(value)
      && isBoundedIdentifier(value.steeringId)
      && value.source === "localUser"
      && (value.intent === "steer" || value.intent === "queue")
      && isBoundedIdentifier(value.roomTurnId)
      && isSha256(value.textSha256)
      && isPositiveSafeInteger(value.textCharacters)
      && isPositiveSafeInteger(value.textBytes)
      && value.textCharacters <= value.textBytes
      && value.textBytes <= STEERING_LIMITS.maxMessageBytes
      && Array.isArray(value.targets)
      && value.targets.length > 0
      && value.targets.length <= STEERING_LIMITS.maxTargetsPerRequest
      && value.targets.every(isSteeringTargetBinding);
  }
  if (value.type === "steeringDeliveryStarted") {
    if (!hasExactKeys(value, [
      "schemaVersion",
      "type",
      "eventId",
      "occurredAt",
      "steeringId",
      "callId",
      "generation",
      "sequence",
      "priorSteeringChainSha256",
      "priorChainIndeterminate",
    ])) {
      return false;
    }
    return isEventHeader(value)
      && isTargetEventHeader(value)
      && isSha256(value.priorSteeringChainSha256)
      && typeof value.priorChainIndeterminate === "boolean";
  }
  if (value.type === "steeringTargetOutcome") {
    const optional = ["acknowledgedDelivery", "providerReceiptSha256"] as const;
    if (!hasOnlyKeys(value, [
      "schemaVersion",
      "type",
      "eventId",
      "occurredAt",
      "steeringId",
      "callId",
      "generation",
      "sequence",
      "outcome",
      "disposition",
      "code",
      "steeringChainSha256",
      "chainIndeterminate",
      ...optional,
    ]) || !hasRequiredKeys(value, [
      "schemaVersion",
      "type",
      "eventId",
      "occurredAt",
      "steeringId",
      "callId",
      "generation",
      "sequence",
      "outcome",
      "disposition",
      "code",
      "steeringChainSha256",
      "chainIndeterminate",
    ])) {
      return false;
    }
    return isEventHeader(value)
      && isTargetEventHeader(value)
      && typeof value.outcome === "string"
      && TERMINAL_OUTCOMES.has(value.outcome as SteeringTerminalOutcome)
      && typeof value.disposition === "string"
      && DISPOSITIONS.has(value.disposition as SteeringDisposition)
      && typeof value.code === "string"
      && OUTCOME_CODES.has(value.code as SteeringOutcomeCode)
      && (value.acknowledgedDelivery === undefined
        || (typeof value.acknowledgedDelivery === "string"
          && value.acknowledgedDelivery !== "unsupported"
          && STEERING_DELIVERIES.has(value.acknowledgedDelivery as SteeringDelivery)))
      && (value.providerReceiptSha256 === undefined || isSha256(value.providerReceiptSha256))
      && isSha256(value.steeringChainSha256)
      && typeof value.chainIndeterminate === "boolean";
  }
  return false;
}

export function isSteeringProviderAcknowledgement(
  value: unknown,
): value is SteeringProviderAcknowledgement {
  if (!isRecord(value) || value.schemaVersion !== STEERING_SCHEMA_VERSION) return false;
  if (value.status === "acknowledged") {
    return hasExactKeys(value, [
      "schemaVersion",
      "status",
      "steeringId",
      "callId",
      "generation",
      "sequence",
      "textSha256",
      "delivery",
      "providerReceiptSha256",
    ])
      && isProviderAcknowledgementHeader(value)
      && typeof value.delivery === "string"
      && value.delivery !== "unsupported"
      && STEERING_DELIVERIES.has(value.delivery as SteeringDelivery)
      && isSha256(value.providerReceiptSha256);
  }
  if (value.status === "rejected") {
    return hasExactKeys(value, [
      "schemaVersion",
      "status",
      "steeringId",
      "callId",
      "generation",
      "sequence",
      "textSha256",
      "delivery",
      "reason",
    ])
      && isProviderAcknowledgementHeader(value)
      && typeof value.delivery === "string"
      && STEERING_DELIVERIES.has(value.delivery as SteeringDelivery)
      && isReason(value.reason);
  }
  return false;
}

export function acknowledgementMatchesRequest(
  acknowledgement: SteeringProviderAcknowledgement,
  request: SteeringProviderRequest,
  expectedDelivery: Exclude<SteeringDelivery, "unsupported">,
): boolean {
  return acknowledgement.steeringId === request.steeringId
    && acknowledgement.callId === request.target.callId
    && acknowledgement.generation === request.target.generation
    && acknowledgement.sequence === request.target.sequence
    && acknowledgement.textSha256 === request.textSha256
    && acknowledgement.delivery === expectedDelivery;
}

export function lockedWorkCode(
  workClass: SteeringWorkClass,
): Extract<SteeringOutcomeCode, "sealedWork" | "lockedArena" | "nonInteractiveWork"> | undefined {
  switch (workClass) {
    case "sealedJury":
    case "formalDuel":
    case "deterministicReferee":
      return "sealedWork";
    case "arenaLocked":
      return "lockedArena";
    case "hiddenMaintenance":
    case "verification":
      return "nonInteractiveWork";
    default:
      return undefined;
  }
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= STEERING_LIMITS.maxIdentifierChars
    && value.trim() === value
    && IDENTIFIER_PATTERN.test(value);
}

export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isProviderAcknowledgementHeader(value: Record<string, unknown>): boolean {
  return isBoundedIdentifier(value.steeringId)
    && isBoundedIdentifier(value.callId)
    && isBoundedIdentifier(value.generation)
    && isPositiveSafeInteger(value.sequence)
    && isSha256(value.textSha256);
}

function isEventHeader(value: Record<string, unknown>): boolean {
  return isBoundedIdentifier(value.eventId) && isCanonicalTimestamp(value.occurredAt);
}

function isTargetEventHeader(value: Record<string, unknown>): boolean {
  return isBoundedIdentifier(value.steeringId)
    && isBoundedIdentifier(value.callId)
    && isBoundedIdentifier(value.generation)
    && isPositiveSafeInteger(value.sequence);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isReason(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= STEERING_LIMITS.maxReasonChars
    && !/[\u0000]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return hasOnlyKeys(value, keys) && hasRequiredKeys(value, keys);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasRequiredKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
