import { createHmac, timingSafeEqual } from "node:crypto";
import {
  STEERING_LIMITS,
  isBoundedIdentifier,
  isCanonicalTimestamp,
  isMissionBindingPair,
  isSha256,
  isSteeringCapability,
  sha256Utf8,
  validateSteeringText,
  type SteeringIntent,
  type SteeringCapability,
  type SteeringWorkClass,
} from "./steeringProtocol";

export { sha256Utf8 } from "./steeringProtocol";

export const STEERING_RELAY_SCHEMA_VERSION = 1 as const;

export const STEERING_RELAY_LIMITS = Object.freeze({
  maxPendingMessages: STEERING_LIMITS.maxUnresolvedMessagesPerRoom,
  maxPendingBytes: STEERING_LIMITS.maxUnresolvedBytes,
  maxReceipts: 256,
  maxProducers: 64,
  maxAdvertisements: 32,
  maxAdvertisementTargets: STEERING_LIMITS.maxTargetsPerRequest,
  maxStateBytes: 4 * 1024 * 1024,
  maxMessageLifetimeMs: 5 * 60_000,
  maxFutureSkewMs: 30_000,
  claimLeaseMs: 60_000,
  minAuthenticationKeyBytes: 32,
  maxAuthenticationKeyBytes: 1024,
  maxProducerIdChars: 64,
});

export type SteeringRelayTransport = "window" | "telegram";

/**
 * Deliberately contains only a one-way principal digest. Telegram chat IDs,
 * sender IDs, bot tokens, and window-local authentication material never enter
 * the relay state.
 */
export interface SteeringRelaySource {
  readonly transport: SteeringRelayTransport;
  readonly principalSha256: string;
}

export interface SteeringRelaySubmissionInput {
  readonly workspaceId: string;
  readonly destinationOwnerId: string;
  readonly producerId: string;
  readonly sequence: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly source: SteeringRelaySource;
  readonly intent: SteeringIntent;
  readonly roomTurnId: string;
  readonly text: string;
  readonly targets: readonly SteeringTargetSelection[];
}

/**
 * Structural copy of SteeringTargetSelection kept at the transport boundary
 * so the relay does not import or instantiate the live controller. A value
 * returned by SteeringController.targetSelections() is assignable directly.
 */
export interface SteeringTargetSelection {
  readonly callId: string;
  readonly generation: string;
  readonly agentId: string;
  readonly roomTurnId: string;
  readonly missionDocumentSha256: string | null;
  readonly missionBindingSha256: string;
  readonly authoritySha256: string;
  readonly initialPromptSha256: string;
  readonly ownerId: string;
  readonly workClass: SteeringWorkClass;
  readonly capability: SteeringCapability;
  readonly phaseSnapshot: string;
  readonly timeoutDeadlineMs?: number;
  readonly selectionSha256: string;
}

export interface AuthenticatedSteeringRelayEnvelope extends SteeringRelaySubmissionInput {
  readonly schemaVersion: typeof STEERING_RELAY_SCHEMA_VERSION;
  readonly messageId: string;
  readonly workspaceId: string;
  readonly destinationOwnerId: string;
  readonly authTag: string;
}

export type SteeringRelayReceiptOutcome =
  | "delivered"
  | "rejected"
  | "deliveryUnknown"
  | "expired";

export type SteeringRelayReceiptCode =
  | "acknowledged"
  | "controllerRejected"
  | "authorizationRevoked"
  | "messageExpired"
  | "claimExpired"
  | "handlerFailed";

export interface SteeringRelayReceipt {
  readonly schemaVersion: typeof STEERING_RELAY_SCHEMA_VERSION;
  readonly messageId: string;
  readonly producerId: string;
  readonly sequence: number;
  readonly envelopeSha256: string;
  readonly completedAt: string;
  readonly outcome: SteeringRelayReceiptOutcome;
  readonly code: SteeringRelayReceiptCode;
  readonly steeringId?: string;
  readonly resultSha256?: string;
}

export interface SteeringRelayClaim {
  readonly claimId: string;
  readonly claimedAt: string;
  readonly claimExpiresAt: string;
  readonly envelope: AuthenticatedSteeringRelayEnvelope;
}

export interface SteeringRelayOwnerAdvertisement {
  readonly schemaVersion: typeof STEERING_RELAY_SCHEMA_VERSION;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly publishedAt: string;
  readonly expiresAt: string;
  readonly targets: readonly SteeringTargetSelection[];
}

const PRODUCER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const AUTH_TAG_PATTERN = /^[a-f0-9]{64}$/;
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

export function steeringRelayPrincipalSha256(
  transport: SteeringRelayTransport,
  stablePrincipal: string,
): string {
  if ((transport !== "window" && transport !== "telegram")
    || typeof stablePrincipal !== "string"
    || stablePrincipal.length < 1
    || stablePrincipal.length > 1024
    || /[\u0000]/u.test(stablePrincipal)) {
    throw new Error("Steering relay principal input is invalid.");
  }
  return sha256Utf8(`hydra-steering-relay-principal-v1\u0000${transport}\u0000${stablePrincipal}`);
}

export function steeringRelayMessageId(producerId: string, sequence: number): string {
  if (!isSteeringRelayProducerId(producerId) || !isPositiveSafeInteger(sequence)) {
    throw new Error("Steering relay producer sequence is invalid.");
  }
  return `${producerId}-${String(sequence).padStart(16, "0")}`;
}

export function createAuthenticatedSteeringRelayEnvelope(
  input: SteeringRelaySubmissionInput,
  authenticationKey: Uint8Array,
): AuthenticatedSteeringRelayEnvelope {
  assertAuthenticationKey(authenticationKey);
  if (!isSha256(input.workspaceId)) throw new Error("Steering relay workspace binding is invalid.");
  if (destinationOwner(input.targets) !== input.destinationOwnerId) {
    throw new Error("Steering relay destination owner does not match its exact targets.");
  }
  const unsigned = {
    schemaVersion: STEERING_RELAY_SCHEMA_VERSION,
    messageId: steeringRelayMessageId(input.producerId, input.sequence),
    workspaceId: input.workspaceId,
    destinationOwnerId: input.destinationOwnerId,
    producerId: input.producerId,
    sequence: input.sequence,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    source: { ...input.source },
    intent: input.intent,
    roomTurnId: input.roomTurnId,
    text: input.text,
    targets: input.targets.map(cloneTargetSelection),
  };
  if (!isUnsignedEnvelope(unsigned)) {
    throw new Error("Steering relay submission is malformed or has inconsistent bindings.");
  }
  return {
    ...unsigned,
    authTag: hmacSha256(authenticationKey, canonicalEnvelope(unsigned)),
  };
}

export function authenticateSteeringRelayEnvelope(
  value: unknown,
  authenticationKey: Uint8Array,
): value is AuthenticatedSteeringRelayEnvelope {
  assertAuthenticationKey(authenticationKey);
  if (!isAuthenticatedSteeringRelayEnvelope(value)) return false;
  const { authTag, ...unsigned } = value;
  const expected = hmacSha256(authenticationKey, canonicalEnvelope(unsigned));
  return safeHexEqual(authTag, expected);
}

export function isAuthenticatedSteeringRelayEnvelope(
  value: unknown,
): value is AuthenticatedSteeringRelayEnvelope {
  const record = asRecord(value);
  if (!record || !hasExactKeys(record, [
    "schemaVersion",
    "messageId",
    "workspaceId",
    "destinationOwnerId",
    "producerId",
    "sequence",
    "issuedAt",
    "expiresAt",
    "source",
    "intent",
    "roomTurnId",
    "text",
    "targets",
    "authTag",
  ])) return false;
  if (!AUTH_TAG_PATTERN.test(String(record.authTag ?? ""))) return false;
  const { authTag: _authTag, ...unsigned } = record;
  return isUnsignedEnvelope(unsigned);
}

export function isSteeringRelayReceipt(value: unknown): value is SteeringRelayReceipt {
  const record = asRecord(value);
  if (!record) return false;
  const allowed = [
    "schemaVersion",
    "messageId",
    "producerId",
    "sequence",
    "envelopeSha256",
    "completedAt",
    "outcome",
    "code",
    "steeringId",
    "resultSha256",
  ] as const;
  const required = allowed.filter((key) => key !== "steeringId" && key !== "resultSha256");
  return hasOnlyKeys(record, allowed)
    && hasRequiredKeys(record, required)
    && record.schemaVersion === STEERING_RELAY_SCHEMA_VERSION
    && isBoundedIdentifier(record.messageId)
    && isSteeringRelayProducerId(record.producerId)
    && isPositiveSafeInteger(record.sequence)
    && isSha256(record.envelopeSha256)
    && isCanonicalTimestamp(record.completedAt)
    && ["delivered", "rejected", "deliveryUnknown", "expired"].includes(String(record.outcome))
    && [
      "acknowledged",
      "controllerRejected",
      "authorizationRevoked",
      "messageExpired",
      "claimExpired",
      "handlerFailed",
    ].includes(String(record.code))
    && (record.steeringId === undefined || isBoundedIdentifier(record.steeringId))
    && (record.resultSha256 === undefined || isSha256(record.resultSha256));
}

export function isSteeringRelayOwnerAdvertisement(
  value: unknown,
): value is SteeringRelayOwnerAdvertisement {
  const record = asRecord(value);
  return !!record
    && hasExactKeys(record, [
      "schemaVersion",
      "ownerId",
      "workspaceId",
      "publishedAt",
      "expiresAt",
      "targets",
    ])
    && record.schemaVersion === STEERING_RELAY_SCHEMA_VERSION
    && isBoundedIdentifier(record.ownerId)
    && isSha256(record.workspaceId)
    && isCanonicalTimestamp(record.publishedAt)
    && isCanonicalTimestamp(record.expiresAt)
    && Array.isArray(record.targets)
    && record.targets.length > 0
    && record.targets.length <= STEERING_RELAY_LIMITS.maxAdvertisementTargets
    && record.targets.every((target) =>
      isSteeringRelayTargetSelection(target)
      && target.ownerId === record.ownerId
    );
}

export function cloneTargetSelection(target: SteeringTargetSelection): SteeringTargetSelection {
  return {
    ...target,
    capability: { ...target.capability },
  };
}

export function isSteeringRelayTargetSelection(
  value: unknown,
): value is SteeringTargetSelection {
  const target = asRecord(value);
  if (!target) return false;
  const allowed = [
    "callId",
    "generation",
    "agentId",
    "roomTurnId",
    "missionDocumentSha256",
    "missionBindingSha256",
    "authoritySha256",
    "initialPromptSha256",
    "ownerId",
    "workClass",
    "capability",
    "phaseSnapshot",
    "timeoutDeadlineMs",
    "selectionSha256",
  ] as const;
  const required = allowed.filter((key) => key !== "timeoutDeadlineMs");
  return hasOnlyKeys(target, allowed)
    && hasRequiredKeys(target, required)
    && isBoundedIdentifier(target.callId)
    && isBoundedIdentifier(target.generation)
    && isBoundedIdentifier(target.agentId)
    && isBoundedIdentifier(target.roomTurnId)
    && isMissionBindingPair(target.missionDocumentSha256, target.missionBindingSha256)
    && isSha256(target.authoritySha256)
    && isSha256(target.initialPromptSha256)
    && isBoundedIdentifier(target.ownerId)
    && typeof target.workClass === "string"
    && WORK_CLASSES.has(target.workClass as SteeringWorkClass)
    && isSteeringCapability(target.capability)
    && isBoundedIdentifier(target.phaseSnapshot)
    && (target.timeoutDeadlineMs === undefined
      || (typeof target.timeoutDeadlineMs === "number"
        && Number.isSafeInteger(target.timeoutDeadlineMs)
        && target.timeoutDeadlineMs >= 0))
    && isSha256(target.selectionSha256);
}

export function canonicalEnvelope(
  envelope: Omit<AuthenticatedSteeringRelayEnvelope, "authTag">,
): string {
  return JSON.stringify([
    "hydra-authenticated-steering-relay-envelope-v1",
    envelope.schemaVersion,
    envelope.messageId,
    envelope.workspaceId,
    envelope.destinationOwnerId,
    envelope.producerId,
    envelope.sequence,
    envelope.issuedAt,
    envelope.expiresAt,
    [envelope.source.transport, envelope.source.principalSha256],
    envelope.intent,
    envelope.roomTurnId,
    envelope.text,
    envelope.targets.map(canonicalTarget),
  ]);
}

export function assertAuthenticationKey(authenticationKey: Uint8Array): void {
  if (!(authenticationKey instanceof Uint8Array)
    || authenticationKey.byteLength < STEERING_RELAY_LIMITS.minAuthenticationKeyBytes
    || authenticationKey.byteLength > STEERING_RELAY_LIMITS.maxAuthenticationKeyBytes) {
    throw new Error("Steering relay authentication key must contain between 32 and 1024 bytes.");
  }
}

export function isSteeringRelayProducerId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= STEERING_RELAY_LIMITS.maxProducerIdChars
    && PRODUCER_PATTERN.test(value);
}

function isUnsignedEnvelope(
  value: unknown,
): value is Omit<AuthenticatedSteeringRelayEnvelope, "authTag"> {
  const record = asRecord(value);
  if (!record || !hasExactKeys(record, [
    "schemaVersion",
    "messageId",
    "workspaceId",
    "destinationOwnerId",
    "producerId",
    "sequence",
    "issuedAt",
    "expiresAt",
    "source",
    "intent",
    "roomTurnId",
    "text",
    "targets",
  ])) return false;
  if (record.schemaVersion !== STEERING_RELAY_SCHEMA_VERSION
    || !isSteeringRelayProducerId(record.producerId)
    || !isPositiveSafeInteger(record.sequence)
    || record.messageId !== steeringRelayMessageId(record.producerId, record.sequence)
    || !isSha256(record.workspaceId)
    || !isBoundedIdentifier(record.destinationOwnerId)
    || !isCanonicalTimestamp(record.issuedAt)
    || !isCanonicalTimestamp(record.expiresAt)
    || !isSteeringRelaySource(record.source)
    || (record.intent !== "steer" && record.intent !== "queue")
    || !isBoundedIdentifier(record.roomTurnId)
    || typeof record.text !== "string"
    || !Array.isArray(record.targets)
    || record.targets.length < 1
    || record.targets.length > STEERING_LIMITS.maxTargetsPerRequest) {
    return false;
  }
  try {
    validateSteeringText(record.text);
  } catch {
    return false;
  }
  const seen = new Set<string>();
  for (const candidate of record.targets) {
    if (!isSteeringRelayTargetSelection(candidate)
      || candidate.ownerId !== record.destinationOwnerId
      || candidate.roomTurnId !== record.roomTurnId) {
      return false;
    }
    const key = `${candidate.callId}\u0000${candidate.generation}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function isSteeringRelaySource(value: unknown): value is SteeringRelaySource {
  const source = asRecord(value);
  return !!source
    && hasExactKeys(source, ["transport", "principalSha256"])
    && (source.transport === "window" || source.transport === "telegram")
    && isSha256(source.principalSha256);
}

function destinationOwner(targets: readonly SteeringTargetSelection[]): string {
  if (!Array.isArray(targets) || targets.length < 1) {
    throw new Error("Steering relay submission requires at least one exact target.");
  }
  const first = targets[0];
  if (!first || !isBoundedIdentifier(first.ownerId)) {
    throw new Error("Steering relay target owner is invalid.");
  }
  if (targets.some((target) => target.ownerId !== first.ownerId)) {
    throw new Error("A steering relay message cannot cross native-handle owners.");
  }
  return first.ownerId;
}

function canonicalTarget(target: SteeringTargetSelection): readonly unknown[] {
  const capability = target.capability.kind === "live"
    ? [target.capability.kind, target.capability.delivery, target.capability.protocol]
    : [target.capability.kind, target.capability.delivery, target.capability.reason];
  return [
    target.callId,
    target.generation,
    target.agentId,
    target.roomTurnId,
    target.missionDocumentSha256,
    target.missionBindingSha256,
    target.authoritySha256,
    target.initialPromptSha256,
    target.ownerId,
    target.workClass,
    capability,
    target.phaseSnapshot,
    target.timeoutDeadlineMs ?? null,
    target.selectionSha256,
  ];
}

function hmacSha256(key: Uint8Array, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function safeHexEqual(left: string, right: string): boolean {
  if (!AUTH_TAG_PATTERN.test(left) || !AUTH_TAG_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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
