import { createHash, randomBytes } from "node:crypto";
import { isValidAgentId } from "./agentValidation";

export type DuelAdjudicatorType = "deterministic" | "human";
export type DuelOutcome = "challengerWin" | "challengedWin" | "tie" | "unresolved" | "void";
export type DuelRatingClass = "rated" | "exhibition";
export type DuelCommitmentCaptureType = "agent-call" | "operator";
export type DuelCommitmentTransport = "oneShot" | "http";
export type DuelRatingPolicy = "elo-v1" | "elo-v2-full-capability" | "elo-v3-agent-initiated";
export type DuelEligibilityReason =
  | "missing-shared-evidence"
  | "repeat-proposition"
  | "pair-cooldown"
  | "head-domain-cap"
  | "head-active-duel"
  | "head-initiation-cooldown"
  | "head-daily-cap"
  | "voluntary-exhibition";
export type DuelStatus =
  | "awaiting_acceptance"
  | "awaiting_commitments"
  | "awaiting_reveal"
  | "awaiting_adjudication"
  | "resolved"
  | "declined"
  | "cancelled";

export const DUEL_LEGACY_RATING_POLICY = "elo-v1" as const;
export const DUEL_RATING_POLICY = "elo-v2-full-capability" as const;
export const DUEL_AGENT_RATING_POLICY = "elo-v3-agent-initiated" as const;
export const DUEL_FULL_ACCESS_POLICY_ID = "hydra-duel-full-native-v1" as const;
export const DUEL_INITIAL_RATING = 1000;
export const DUEL_ELO_K = 24;
export const MIN_DUEL_RATED_MATCHES = 5;
export const DUEL_PAIR_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const DUEL_HEAD_DOMAIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const DUEL_HEAD_DOMAIN_MAX_RATED = 3;
export const DUEL_PROPOSITION_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
export const DUEL_AGENT_INITIATION_COOLDOWN_MS = 60 * 60 * 1000;
export const DUEL_AGENT_INITIATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DUEL_AGENT_INITIATION_MAX_PER_WINDOW = 3;
export const DUEL_MAX_SHARED_EVIDENCE_PACKET_BYTES = 12 * 1024;

export interface DuelAgentInitiationReceipt {
  readonly protocol: "agent-intent-v1";
  readonly agentId: string;
  /** Normal room-call trace whose completed row carries sourceMessageSha256. */
  readonly sourceTraceId: string;
  readonly sourceMessageTimestamp: string;
  readonly sourceMessageSha256: string;
  readonly disputedMessageTimestamp: string;
  /** Git HEAD/index/working-tree state both heads must independently evaluate. */
  readonly workspaceFingerprintSha256: string;
  /** Effective maximum-native launch configuration locked independently per head. */
  readonly capabilityLocks: readonly [DuelParticipantCapabilityLock, DuelParticipantCapabilityLock];
}

export interface DuelParticipantCapabilityLock {
  readonly agentId: string;
  readonly agentKind: string;
  readonly profileSha256: string;
}

interface DuelEventBase {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly duelId: string;
}

export interface DuelChallengedEvent extends DuelEventBase {
  readonly type: "duelChallenged";
  readonly challengerId: string;
  readonly challengedId: string;
  readonly createdBy: "local-user" | "hydra-runtime";
  /** Required only for the agent-initiated v3 protocol. */
  readonly initiation?: DuelAgentInitiationReceipt;
  readonly domain: string;
  readonly proposition: string;
  readonly propositionFingerprint: string;
  readonly evidenceContract: string;
  /**
   * Identical bounded evidence supplied to both participants before either
   * commits. Optional only so packetless pre-feature ledger rows still replay.
   */
  readonly sharedEvidencePacket?: string;
  readonly adjudicatorType: DuelAdjudicatorType;
  readonly adjudicatorId: string;
  readonly ratingPolicy: DuelRatingPolicy;
}

export interface DuelAcceptedEvent extends DuelEventBase {
  readonly type: "duelAccepted";
  readonly acceptedBy: string;
  readonly recordedBy: "local-user";
  readonly ratingClass: DuelRatingClass;
  readonly eligibilityReasons: readonly DuelEligibilityReason[];
  /** Required for current rated duels; absent on legacy elo-v1 events. */
  readonly capabilityPolicy?: typeof DUEL_FULL_ACCESS_POLICY_ID;
}

/** V3 policy admission is not attributed to the challenged head or operator. */
export interface DuelAdmittedEvent extends DuelEventBase {
  readonly type: "duelAdmitted";
  readonly admittedBy: "hydra-runtime";
  readonly admissionMode: "policy-auto";
  readonly ratingClass: "rated";
  readonly eligibilityReasons: readonly [];
  readonly capabilityPolicy: typeof DUEL_FULL_ACCESS_POLICY_ID;
}

export interface DuelDeclinedEvent extends DuelEventBase {
  readonly type: "duelDeclined";
  readonly declinedBy: string;
  readonly recordedBy: "local-user";
  readonly reason: string;
}

export interface DuelCommitmentSealedEvent extends DuelEventBase {
  readonly type: "duelCommitmentSealed";
  readonly commitmentId: string;
  readonly participantId: string;
  /** How the answer was obtained. Rated duels require the actual head execution path. */
  readonly captureType: DuelCommitmentCaptureType;
  /** Durable receipt reference. Agent calls use `agent-call:<traceId>`; manual exhibitions use `operator:local-user`. */
  readonly captureRef: string;
  /** Private-ledger receipt proving which Hydra head execution produced the sealed answer. */
  readonly agentReceipt?: DuelAgentCallReceipt;
  readonly algorithm: "sha256-v1";
  readonly commitmentHash: string;
  readonly recordedBy: "hydra-runtime" | "local-user";
}

export interface DuelAgentCallReceipt {
  readonly traceId: string;
  readonly agentId: string;
  readonly agentKind: string;
  readonly model?: string;
  readonly transport: DuelCommitmentTransport;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly promptSha256: string;
  /** Hash of the exact locked shared evidence packet supplied to this head. */
  readonly sharedEvidenceSha256?: string;
  /** Full-access capability contract locked when the duel was accepted. */
  readonly capabilityPolicy?: typeof DUEL_FULL_ACCESS_POLICY_ID;
  readonly responseSha256: string;
  readonly invocationSha256: string;
  /** Required by v3 so both sealed calls are bound to the admission workspace state. */
  readonly workspaceFingerprintSha256?: string;
  /** Required by v3 so this call matches its participant's admission-time native profile. */
  readonly capabilityLockSha256?: string;
}

export interface DuelRevealPayload {
  readonly commitmentId: string;
  readonly participantId: string;
  readonly captureType: DuelCommitmentCaptureType;
  readonly captureRef: string;
  readonly agentReceipt?: DuelAgentCallReceipt;
  readonly answer: string;
  readonly confidence: number;
  readonly nonce: string;
}

export interface DuelCommitmentsRevealedEvent extends DuelEventBase {
  readonly type: "duelCommitmentsRevealed";
  readonly payloads: readonly [DuelRevealPayload, DuelRevealPayload];
  readonly recordedBy: "local-user" | "hydra-runtime";
}

export interface DuelResolvedEvent extends DuelEventBase {
  readonly type: "duelResolved";
  readonly resolutionId: string;
  readonly outcome: DuelOutcome;
  readonly adjudicatorType: DuelAdjudicatorType;
  readonly adjudicatorId: string;
  readonly evidenceRef: string;
  readonly rationale: string;
  readonly recordedBy: "local-user";
}

export interface DuelResolutionReversedEvent extends DuelEventBase {
  readonly type: "duelResolutionReversed";
  readonly targetResolutionId: string;
  readonly reversedBy: "local-user";
  readonly reason: string;
}

export interface DuelCancelledEvent extends DuelEventBase {
  readonly type: "duelCancelled";
  readonly cancelledBy: "local-user" | "hydra-runtime";
  readonly reason: string;
}

export type DuelEvent =
  | DuelChallengedEvent
  | DuelAcceptedEvent
  | DuelAdmittedEvent
  | DuelDeclinedEvent
  | DuelCommitmentSealedEvent
  | DuelCommitmentsRevealedEvent
  | DuelResolvedEvent
  | DuelResolutionReversedEvent
  | DuelCancelledEvent;

export interface DuelPublicCommitment {
  readonly agentId: string;
  readonly captureType: DuelCommitmentCaptureType;
  readonly captureRef: string;
  readonly agentReceipt?: DuelAgentCallReceipt;
  readonly answer: string;
  readonly confidence: number;
}

export interface DuelPublicResolution {
  readonly resolutionId: string;
  readonly outcome: DuelOutcome;
  readonly winnerId?: string;
  readonly source: DuelAdjudicatorType;
  readonly adjudicatorId: string;
  readonly evidenceRef: string;
  readonly rationale: string;
  readonly occurredAt: string;
  readonly ratingDeltas: Readonly<Record<string, number>>;
}

export interface DuelView {
  readonly duelId: string;
  readonly occurredAt: string;
  readonly updatedAt: string;
  readonly status: DuelStatus;
  readonly challengerId: string;
  readonly challengedId: string;
  readonly createdBy: "local-user" | "hydra-runtime";
  readonly initiation?: DuelAgentInitiationReceipt;
  readonly ratingPolicy: DuelRatingPolicy;
  readonly domain: string;
  readonly proposition: string;
  readonly propositionFingerprint: string;
  readonly evidenceContract: string;
  /** Absent only for legacy packetless challenges, which are exhibition-only. */
  readonly sharedEvidencePacket?: string;
  readonly adjudicatorType: DuelAdjudicatorType;
  readonly adjudicatorId: string;
  readonly rated: boolean;
  readonly ratingIneligibilityReason?: string;
  readonly capabilityPolicy?: typeof DUEL_FULL_ACCESS_POLICY_ID;
  readonly commitmentCount: number;
  /** Present only after the single paired reveal event validates both seals. */
  readonly commitments?: readonly [DuelPublicCommitment, DuelPublicCommitment];
  readonly resolution?: DuelPublicResolution;
  readonly declineReason?: string;
  readonly cancellationReason?: string;
}

export interface DuelRating {
  readonly agentId: string;
  readonly domain: string;
  readonly rating: number;
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  readonly ratedMatches: number;
  readonly provisional: boolean;
}

export interface DuelCorrection {
  readonly duelId: string;
  readonly resolution: DuelResolvedEvent;
  readonly reversal: DuelResolutionReversedEvent;
}

export interface DuelAggregate {
  readonly eventCount: number;
  readonly ratings: readonly DuelRating[];
  readonly activeDuels: readonly DuelView[];
  readonly recentDuels: readonly DuelView[];
  readonly corrections: readonly DuelCorrection[];
}

export type DuelValidationCode =
  | "invalidEvent"
  | "invalidType"
  | "invalidField"
  | "duplicateEvent"
  | "duplicateDuel"
  | "duplicateCommitment"
  | "duplicateResolution"
  | "unknownDuel"
  | "unknownResolution"
  | "invalidTransition"
  | "hashMismatch"
  | "resolutionAlreadyReversed";

export interface DuelValidationIssue {
  readonly index: number;
  readonly eventId?: string;
  readonly code: DuelValidationCode;
  readonly message: string;
}

export class DuelValidationError extends Error {
  readonly issues: readonly DuelValidationIssue[];
  constructor(issues: readonly DuelValidationIssue[]) {
    super(`Invalid duel event log: ${issues.map((issue) => issue.message).join("; ")}`);
    this.name = "DuelValidationError";
    this.issues = [...issues];
  }
}

export class DuelAcceptanceRejectedError extends Error {
  readonly reasons: readonly DuelEligibilityReason[];

  constructor(reasons: readonly DuelEligibilityReason[]) {
    const boundedReasons = reasons.slice(0, 4);
    super(`Formal duel cannot be accepted as rated: ${boundedReasons.join(", ")}.`);
    this.name = "DuelAcceptanceRejectedError";
    this.reasons = boundedReasons;
  }
}

export interface CreateDuelChallengeInput {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly duelId: string;
  readonly challengerId: string;
  readonly challengedId: string;
  readonly domain: string;
  readonly proposition: string;
  readonly evidenceContract: string;
  readonly sharedEvidencePacket: string;
  readonly adjudicatorType: DuelAdjudicatorType;
  readonly adjudicatorId: string;
  readonly createdBy?: "local-user" | "hydra-runtime";
  readonly initiation?: DuelAgentInitiationReceipt;
}

export interface CreateDuelAcceptanceInput {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly duelId: string;
}

export interface CreateDuelAdmissionInput {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly duelId: string;
}

export interface CreateDuelCommitmentInput {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly duelId: string;
  readonly commitmentId: string;
  readonly participantId: string;
  readonly captureType: DuelCommitmentCaptureType;
  readonly captureRef: string;
  readonly agentReceipt?: DuelAgentCallReceipt;
  readonly answer: string;
  readonly confidence: number;
  readonly nonce?: string;
}

export function initialEmptyDuelAggregate(): DuelAggregate {
  return { eventCount: 0, ratings: [], activeDuels: [], recentDuels: [], corrections: [] };
}

export function normalizeDuelProposition(proposition: string): string {
  return proposition.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function duelPropositionFingerprint(proposition: string): string {
  return createHash("sha256").update(normalizeDuelProposition(proposition), "utf8").digest("hex");
}

export function hashDuelCommitment(duelId: string, payload: DuelRevealPayload): string {
  const canonical = JSON.stringify([
    "sha256-v1",
    duelId,
    payload.commitmentId,
    payload.participantId,
    payload.captureType,
    payload.captureRef,
    payload.agentReceipt
      ? [
          payload.agentReceipt.traceId,
          payload.agentReceipt.agentId,
          payload.agentReceipt.agentKind,
          payload.agentReceipt.model ?? null,
          payload.agentReceipt.transport,
          payload.agentReceipt.startedAt,
          payload.agentReceipt.completedAt,
          payload.agentReceipt.promptSha256,
          ...(payload.agentReceipt.sharedEvidenceSha256 ? [payload.agentReceipt.sharedEvidenceSha256] : []),
          ...(payload.agentReceipt.capabilityPolicy ? [payload.agentReceipt.capabilityPolicy] : []),
          payload.agentReceipt.responseSha256,
          payload.agentReceipt.invocationSha256,
          payload.agentReceipt.workspaceFingerprintSha256 ?? null,
          payload.agentReceipt.capabilityLockSha256 ?? null,
        ]
      : null,
    payload.answer,
    payload.confidence,
    payload.nonce,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface DuelAgentCommitmentResponse {
  readonly duelId: string;
  readonly participantId: string;
  readonly commitmentId: string;
  readonly answer: string;
  readonly confidence: number;
}

export function hashDuelAgentResponse(response: DuelAgentCommitmentResponse): string {
  return createHash("sha256").update(JSON.stringify([
    response.duelId,
    response.participantId,
    response.commitmentId,
    response.answer,
    response.confidence,
  ]), "utf8").digest("hex");
}

export function hashDuelSharedEvidencePacket(packet: string): string {
  return createHash("sha256").update(packet, "utf8").digest("hex");
}

/** Parse the bounded machine-readable reply produced by a participant head. */
export function parseDuelAgentCommitmentResponse(
  text: string,
  expected: Pick<DuelAgentCommitmentResponse, "duelId" | "participantId" | "commitmentId">,
): DuelAgentCommitmentResponse {
  if (typeof text !== "string" || text.length === 0 || text.length > 16 * 1024) {
    throw new Error("Duel commitment reply must contain at most 16,384 characters.");
  }
  let candidate = text.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("Duel participant did not return valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Duel participant reply must be a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ["answer", "commitmentId", "confidence", "duelId", "participantId"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Duel participant reply must contain only duelId, participantId, commitmentId, answer, and confidence.");
  }
  if (
    record.duelId !== expected.duelId
    || record.participantId !== expected.participantId
    || record.commitmentId !== expected.commitmentId
  ) {
    throw new Error("Duel participant reply does not match the assigned duel, head, and commitment nonce.");
  }
  if (typeof record.answer !== "string" || record.answer.trim().length === 0 || record.answer.length > 4_000) {
    throw new Error("Duel commitment answer must contain 1-4000 characters.");
  }
  if (
    typeof record.confidence !== "number"
    || !Number.isFinite(record.confidence)
    || record.confidence < 0
    || record.confidence > 1
  ) {
    throw new Error("Duel commitment confidence must be a number from 0 through 1.");
  }
  return {
    duelId: expected.duelId,
    participantId: expected.participantId,
    commitmentId: expected.commitmentId,
    answer: record.answer.trim(),
    confidence: record.confidence,
  };
}

export function createDuelChallenge(input: CreateDuelChallengeInput): DuelChallengedEvent {
  const createdBy = input.createdBy ?? "local-user";
  return {
    type: "duelChallenged",
    ...input,
    createdBy,
    ...(input.initiation ? { initiation: input.initiation } : {}),
    propositionFingerprint: duelPropositionFingerprint(input.proposition),
    ratingPolicy: createdBy === "hydra-runtime" ? DUEL_AGENT_RATING_POLICY : DUEL_RATING_POLICY,
  };
}

export function createDuelAcceptance(
  events: readonly DuelEvent[],
  input: CreateDuelAcceptanceInput,
): DuelAcceptedEvent {
  const replayed = replay(events);
  if (replayed.issues.length > 0) throw new DuelValidationError(replayed.issues);
  const duel = replayed.state.duels.get(input.duelId);
  if (!duel) throw new Error(`Unknown duel "${input.duelId}".`);
  if (duel.challenge.ratingPolicy === DUEL_AGENT_RATING_POLICY) {
    throw new Error("Agent-initiated challenges are admitted by Hydra policy, not accepted on behalf of either head.");
  }
  if (duel.challenge.ratingPolicy !== DUEL_RATING_POLICY && duel.challenge.sharedEvidencePacket !== undefined) {
    throw new Error("Legacy duel challenges cannot enter the current rated protocol; decline and recreate the challenge.");
  }
  const policyReasons = assessRatingEligibility(replayed.state, duel, input.occurredAt);
  if (policyReasons.length > 0) throw new DuelAcceptanceRejectedError(policyReasons);
  return {
    type: "duelAccepted",
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    duelId: input.duelId,
    acceptedBy: duel.challenge.challengedId,
    recordedBy: "local-user",
    ratingClass: "rated",
    eligibilityReasons: [],
    capabilityPolicy: DUEL_FULL_ACCESS_POLICY_ID,
  };
}

export function createDuelAdmission(
  events: readonly DuelEvent[],
  input: CreateDuelAdmissionInput,
): DuelAdmittedEvent {
  const replayed = replay(events);
  if (replayed.issues.length > 0) throw new DuelValidationError(replayed.issues);
  const duel = replayed.state.duels.get(input.duelId);
  if (!duel) throw new Error(`Unknown duel "${input.duelId}".`);
  if (duel.challenge.ratingPolicy !== DUEL_AGENT_RATING_POLICY || duel.challenge.createdBy !== "hydra-runtime") {
    throw new Error("Only a validated agent-initiated v3 challenge can be admitted automatically.");
  }
  const policyReasons = assessRatingEligibility(replayed.state, duel, input.occurredAt);
  if (policyReasons.length > 0) throw new DuelAcceptanceRejectedError(policyReasons);
  return {
    type: "duelAdmitted",
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    duelId: input.duelId,
    admittedBy: "hydra-runtime",
    admissionMode: "policy-auto",
    ratingClass: "rated",
    eligibilityReasons: [],
    capabilityPolicy: DUEL_FULL_ACCESS_POLICY_ID,
  };
}

export function createDuelCommitment(input: CreateDuelCommitmentInput): {
  event: DuelCommitmentSealedEvent;
  payload: DuelRevealPayload;
} {
  const payload: DuelRevealPayload = {
    commitmentId: input.commitmentId,
    participantId: input.participantId,
    captureType: input.captureType,
    captureRef: input.captureRef,
    ...(input.agentReceipt ? { agentReceipt: input.agentReceipt } : {}),
    answer: input.answer,
    confidence: input.confidence,
    nonce: input.nonce ?? randomBytes(32).toString("hex"),
  };
  return {
    event: {
      type: "duelCommitmentSealed",
      eventId: input.eventId,
      occurredAt: input.occurredAt,
      duelId: input.duelId,
      commitmentId: input.commitmentId,
      participantId: input.participantId,
      captureType: input.captureType,
      captureRef: input.captureRef,
      ...(input.agentReceipt ? { agentReceipt: input.agentReceipt } : {}),
      algorithm: "sha256-v1",
      commitmentHash: hashDuelCommitment(input.duelId, payload),
      recordedBy: input.captureType === "agent-call" ? "hydra-runtime" : "local-user",
    },
    payload,
  };
}

export function createDuelReveal(
  events: readonly DuelEvent[],
  input: Pick<DuelCommitmentsRevealedEvent, "eventId" | "occurredAt" | "duelId"> & {
    payloads: readonly [DuelRevealPayload, DuelRevealPayload];
    recordedBy?: DuelCommitmentsRevealedEvent["recordedBy"];
  },
): DuelCommitmentsRevealedEvent {
  const event: DuelCommitmentsRevealedEvent = {
    type: "duelCommitmentsRevealed",
    ...input,
    recordedBy: input.recordedBy ?? "local-user",
  };
  const issues = validateDuelEvents([...events, event]);
  if (issues.length > 0) throw new DuelValidationError(issues);
  return event;
}

export function validateDuelEvents(events: readonly unknown[]): DuelValidationIssue[] {
  return replay(events).issues;
}

export function aggregateDuels(events: readonly DuelEvent[]): DuelAggregate {
  const replayed = replay(events);
  if (replayed.issues.length > 0) throw new DuelValidationError(replayed.issues);
  const { ratings, deltasByResolution } = computeRatings(replayed.state);
  const views = [...replayed.state.duels.values()].map((duel) => toDuelView(duel, deltasByResolution));
  const activeDuels = views
    .filter((duel) => !["resolved", "declined", "cancelled"].includes(duel.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const recentDuels = views
    .filter((duel) => ["resolved", "declined", "cancelled"].includes(duel.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const corrections: DuelCorrection[] = [];
  for (const reversal of replayed.state.reversals) {
    const resolution = replayed.state.resolutions.get(reversal.targetResolutionId);
    if (resolution) corrections.push({ duelId: resolution.duelId, resolution, reversal });
  }
  corrections.sort((left, right) => right.reversal.occurredAt.localeCompare(left.reversal.occurredAt));
  return { eventCount: events.length, ratings, activeDuels, recentDuels, corrections };
}

interface DuelRecord {
  readonly challenge: DuelChallengedEvent;
  acceptance?: DuelAcceptedEvent | DuelAdmittedEvent;
  decline?: DuelDeclinedEvent;
  cancellation?: DuelCancelledEvent;
  readonly seals: Map<string, DuelCommitmentSealedEvent>;
  reveal?: DuelCommitmentsRevealedEvent;
  readonly resolutions: DuelResolvedEvent[];
  activeResolutionId?: string;
  firstResolutionIndex?: number;
  updatedAt: string;
}

interface DuelReplayState {
  readonly duels: Map<string, DuelRecord>;
  readonly resolutions: Map<string, DuelResolvedEvent>;
  readonly reversedResolutionIds: Set<string>;
  readonly reversals: DuelResolutionReversedEvent[];
}

const ADJUDICATOR_TYPES = new Set<DuelAdjudicatorType>(["deterministic", "human"]);
const OUTCOMES = new Set<DuelOutcome>(["challengerWin", "challengedWin", "tie", "unresolved", "void"]);
const RATING_CLASSES = new Set<DuelRatingClass>(["rated", "exhibition"]);
const RATING_POLICIES = new Set<DuelRatingPolicy>([
  DUEL_LEGACY_RATING_POLICY,
  DUEL_RATING_POLICY,
  DUEL_AGENT_RATING_POLICY,
]);
const ELIGIBILITY_REASONS = new Set<DuelEligibilityReason>([
  "missing-shared-evidence",
  "repeat-proposition",
  "pair-cooldown",
  "head-domain-cap",
  "head-active-duel",
  "head-initiation-cooldown",
  "head-daily-cap",
  "voluntary-exhibition",
]);

function replay(events: readonly unknown[]): { issues: DuelValidationIssue[]; state: DuelReplayState } {
  const issues: DuelValidationIssue[] = [];
  const eventIds = new Set<string>();
  const state: DuelReplayState = {
    duels: new Map(),
    resolutions: new Map(),
    reversedResolutionIds: new Set(),
    reversals: [],
  };
  for (let index = 0; index < events.length; index += 1) {
    const raw = events[index];
    if (!isRecord(raw)) {
      addIssue(issues, index, undefined, "invalidEvent", "event must be an object");
      continue;
    }
    const eventId = validString(raw.eventId, 128) ? raw.eventId : undefined;
    let valid = true;
    if (!eventId) {
      addIssue(issues, index, undefined, "invalidField", "eventId must be a non-empty trimmed string up to 128 characters");
      valid = false;
    } else if (eventIds.has(eventId)) {
      addIssue(issues, index, eventId, "duplicateEvent", `duplicate eventId "${eventId}"`);
      valid = false;
    }
    if (eventId && !eventIds.has(eventId)) eventIds.add(eventId);
    if (!validTimestamp(raw.occurredAt)) {
      addIssue(issues, index, eventId, "invalidField", "occurredAt must be a valid timestamp");
      valid = false;
    }
    if (!validString(raw.duelId, 128)) {
      addIssue(issues, index, eventId, "invalidField", "duelId must be a non-empty trimmed string up to 128 characters");
      valid = false;
    }

    switch (raw.type) {
      case "duelChallenged": validateChallenge(raw, index, eventId, valid, state, issues); break;
      case "duelAccepted": validateAcceptance(raw, index, eventId, valid, state, issues); break;
      case "duelAdmitted": validateAdmission(raw, index, eventId, valid, state, issues); break;
      case "duelDeclined": validateDecline(raw, index, eventId, valid, state, issues); break;
      case "duelCommitmentSealed": validateSeal(raw, index, eventId, valid, state, issues); break;
      case "duelCommitmentsRevealed": validateReveal(raw, index, eventId, valid, state, issues); break;
      case "duelResolved": validateResolution(raw, index, eventId, valid, state, issues); break;
      case "duelResolutionReversed": validateResolutionReversal(raw, index, eventId, valid, state, issues); break;
      case "duelCancelled": validateCancellation(raw, index, eventId, valid, state, issues); break;
      default: addIssue(issues, index, eventId, "invalidType", `unknown duel event type "${String(raw.type)}"`);
    }
  }
  return { issues, state };
}

function validateChallenge(
  raw: Record<string, unknown>,
  index: number,
  eventId: string | undefined,
  commonValid: boolean,
  state: DuelReplayState,
  issues: DuelValidationIssue[],
): void {
  let valid = commonValid;
  const duelId = typeof raw.duelId === "string" ? raw.duelId : "";
  for (const field of ["challengerId", "challengedId"] as const) {
    if (!isValidAgentId(raw[field])) {
      addIssue(issues, index, eventId, "invalidField", `${field} must be a valid durable Hydra head id`);
      valid = false;
    }
  }
  if (raw.challengerId === raw.challengedId) {
    addIssue(issues, index, eventId, "invalidField", "a head cannot duel itself");
    valid = false;
  }
  if (raw.createdBy === "local-user") {
    if (raw.initiation !== undefined) {
      addIssue(issues, index, eventId, "invalidField", "operator-created challenges cannot carry agent initiation provenance");
      valid = false;
    }
    if (raw.ratingPolicy === DUEL_AGENT_RATING_POLICY) {
      addIssue(issues, index, eventId, "invalidField", "agent-initiated rating policy requires Hydra runtime provenance");
      valid = false;
    }
  } else if (raw.createdBy === "hydra-runtime") {
    if (raw.ratingPolicy !== DUEL_AGENT_RATING_POLICY || !validAgentInitiation(raw.initiation, raw.challengerId, raw.challengedId, raw.occurredAt)) {
      addIssue(issues, index, eventId, "invalidField", "Hydra runtime challenges require a valid agent-intent-v1 receipt bound to the challenger and source reply");
      valid = false;
    }
  } else {
    addIssue(issues, index, eventId, "invalidField", "createdBy must be local-user or hydra-runtime");
    valid = false;
  }
  if (typeof raw.domain !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(raw.domain)) {
    addIssue(issues, index, eventId, "invalidField", "domain must be a lowercase slug up to 32 characters");
    valid = false;
  }
  if (!validString(raw.proposition, 2_000)) {
    addIssue(issues, index, eventId, "invalidField", "proposition must contain 1-2000 trimmed characters");
    valid = false;
  }
  if (!validString(raw.evidenceContract, 2_000)) {
    addIssue(issues, index, eventId, "invalidField", "evidenceContract must contain 1-2000 trimmed characters");
    valid = false;
  }
  if (raw.sharedEvidencePacket !== undefined && !validSharedEvidencePacket(raw.sharedEvidencePacket)) {
    addIssue(
      issues,
      index,
      eventId,
      "invalidField",
      `sharedEvidencePacket must contain 1-${DUEL_MAX_SHARED_EVIDENCE_PACKET_BYTES} UTF-8 bytes of trimmed text`,
    );
    valid = false;
  }
  if (
    (raw.ratingPolicy === DUEL_RATING_POLICY || raw.ratingPolicy === DUEL_AGENT_RATING_POLICY)
    && raw.sharedEvidencePacket === undefined
  ) {
    addIssue(issues, index, eventId, "invalidField", "current rated duel challenges require one locked shared evidence packet");
    valid = false;
  }
  if (typeof raw.adjudicatorType !== "string" || !ADJUDICATOR_TYPES.has(raw.adjudicatorType as DuelAdjudicatorType)) {
    addIssue(issues, index, eventId, "invalidField", "adjudicatorType must be deterministic or human");
    valid = false;
  }
  if (!validString(raw.adjudicatorId, 128)) {
    addIssue(issues, index, eventId, "invalidField", "adjudicatorId must be a non-empty trimmed string up to 128 characters");
    valid = false;
  } else if (raw.adjudicatorId === raw.challengerId || raw.adjudicatorId === raw.challengedId) {
    addIssue(issues, index, eventId, "invalidField", "the adjudicator must differ from both duel participants");
    valid = false;
  }
  if (typeof raw.ratingPolicy !== "string" || !RATING_POLICIES.has(raw.ratingPolicy as DuelRatingPolicy)) {
    addIssue(
      issues,
      index,
      eventId,
      "invalidField",
      `ratingPolicy must be ${DUEL_LEGACY_RATING_POLICY}, ${DUEL_RATING_POLICY}, or ${DUEL_AGENT_RATING_POLICY}`,
    );
    valid = false;
  }
  if (typeof raw.propositionFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.propositionFingerprint)) {
    addIssue(issues, index, eventId, "invalidField", "propositionFingerprint must be a lowercase SHA-256 digest");
    valid = false;
  } else if (typeof raw.proposition === "string" && raw.propositionFingerprint !== duelPropositionFingerprint(raw.proposition)) {
    addIssue(issues, index, eventId, "hashMismatch", "propositionFingerprint does not match the normalized proposition");
    valid = false;
  }
  if (duelId && state.duels.has(duelId)) {
    addIssue(issues, index, eventId, "duplicateDuel", `duplicate duelId "${duelId}"`);
    valid = false;
  }
  if (valid) {
    const challenge = raw as unknown as DuelChallengedEvent;
    state.duels.set(duelId, {
      challenge,
      seals: new Map(),
      resolutions: [],
      updatedAt: challenge.occurredAt,
    });
  }
}

function validateAcceptance(
  raw: Record<string, unknown>,
  index: number,
  eventId: string | undefined,
  commonValid: boolean,
  state: DuelReplayState,
  issues: DuelValidationIssue[],
): void {
  let valid = commonValid;
  const duel = getDuel(raw, index, eventId, state, issues);
  if (!duel) valid = false;
  if (duel && (duel.acceptance || duel.decline || duel.cancellation)) {
    addIssue(issues, index, eventId, "invalidTransition", "duel can only be accepted once while awaiting acceptance");
    valid = false;
  }
  if (duel?.challenge.ratingPolicy === DUEL_AGENT_RATING_POLICY) {
    addIssue(issues, index, eventId, "invalidTransition", "agent-initiated v3 challenges require Hydra policy admission, not head acceptance");
    valid = false;
  }
  if (duel && raw.acceptedBy !== duel.challenge.challengedId) {
    addIssue(issues, index, eventId, "invalidField", "acceptedBy must be the challenged head");
    valid = false;
  }
  if (raw.recordedBy !== "local-user") {
    addIssue(issues, index, eventId, "invalidField", "recordedBy must be local-user");
    valid = false;
  }
  if (typeof raw.ratingClass !== "string" || !RATING_CLASSES.has(raw.ratingClass as DuelRatingClass)) {
    addIssue(issues, index, eventId, "invalidField", "ratingClass must be rated or exhibition");
    valid = false;
  }
  const reasons = parseEligibilityReasons(raw.eligibilityReasons);
  if (!reasons) {
    addIssue(issues, index, eventId, "invalidField", "eligibilityReasons must be a unique array of known reason codes");
    valid = false;
  }
  if (raw.capabilityPolicy !== undefined && raw.capabilityPolicy !== DUEL_FULL_ACCESS_POLICY_ID) {
    addIssue(issues, index, eventId, "invalidField", `capabilityPolicy must be ${DUEL_FULL_ACCESS_POLICY_ID}`);
    valid = false;
  }
  if (duel && reasons && duel.challenge.ratingPolicy === DUEL_RATING_POLICY) {
    const required = assessRatingEligibility(state, duel, typeof raw.occurredAt === "string" ? raw.occurredAt : "");
    if (
      raw.ratingClass !== "rated"
      || reasons.length !== 0
      || raw.capabilityPolicy !== DUEL_FULL_ACCESS_POLICY_ID
    ) {
      addIssue(issues, index, eventId, "invalidField", "current formal duel acceptances must be rated under the locked full-access capability policy");
      valid = false;
    }
    if (required.length > 0) {
      addIssue(issues, index, eventId, "invalidTransition", `current formal duel acceptance is rejected by policy: ${required.join(", ")}`);
      valid = false;
    }
  } else if (duel && reasons && duel.challenge.sharedEvidencePacket !== undefined) {
    const required = assessRatingEligibility(state, duel, typeof raw.occurredAt === "string" ? raw.occurredAt : "");
    const expected = required.length > 0
      ? required
      : raw.ratingClass === "exhibition"
        ? ["voluntary-exhibition" as const]
        : [];
    const expectedClass: DuelRatingClass = expected.length === 0 ? "rated" : "exhibition";
    if (raw.ratingClass !== expectedClass || !sameStringArray(reasons, expected)) {
      addIssue(issues, index, eventId, "invalidField", "rating eligibility does not match the anti-farming policy at acceptance");
      valid = false;
    }
  }
  if (valid && duel) {
    const acceptance = raw as unknown as DuelAcceptedEvent;
    // Packetless challenges predate the shared-evidence contract. Preserve
    // their original ledger rows, but normalize replay state to exhibition so
    // old ratings cannot bypass the new fairness requirement.
    duel.acceptance = duel.challenge.ratingPolicy === DUEL_LEGACY_RATING_POLICY
      && duel.challenge.sharedEvidencePacket === undefined
      ? {
          ...acceptance,
          ratingClass: "exhibition",
          eligibilityReasons: [
            "missing-shared-evidence",
            ...acceptance.eligibilityReasons.filter((reason) => reason !== "missing-shared-evidence"),
          ],
        }
      : acceptance;
    duel.updatedAt = duel.acceptance.occurredAt;
  }
}

function validateAdmission(
  raw: Record<string, unknown>,
  index: number,
  eventId: string | undefined,
  commonValid: boolean,
  state: DuelReplayState,
  issues: DuelValidationIssue[],
): void {
  let valid = commonValid;
  const duel = getDuel(raw, index, eventId, state, issues);
  if (!duel) valid = false;
  if (duel && (duel.acceptance || duel.decline || duel.cancellation)) {
    addIssue(issues, index, eventId, "invalidTransition", "duel can only be admitted once while awaiting policy admission");
    valid = false;
  }
  if (duel && (duel.challenge.ratingPolicy !== DUEL_AGENT_RATING_POLICY || duel.challenge.createdBy !== "hydra-runtime")) {
    addIssue(issues, index, eventId, "invalidTransition", "only an agent-initiated v3 challenge can use automatic policy admission");
    valid = false;
  }
  if (raw.admittedBy !== "hydra-runtime" || raw.admissionMode !== "policy-auto") {
    addIssue(issues, index, eventId, "invalidField", "agent-initiated duels must be admitted automatically by hydra-runtime policy");
    valid = false;
  }
  if (raw.ratingClass !== "rated" || !Array.isArray(raw.eligibilityReasons) || raw.eligibilityReasons.length !== 0) {
    addIssue(issues, index, eventId, "invalidField", "automatic duel admission is rated-only and cannot carry eligibility exceptions");
    valid = false;
  }
  if (raw.capabilityPolicy !== DUEL_FULL_ACCESS_POLICY_ID) {
    addIssue(issues, index, eventId, "invalidField", `capabilityPolicy must be ${DUEL_FULL_ACCESS_POLICY_ID}`);
    valid = false;
  }
  if (duel) {
    const required = assessRatingEligibility(state, duel, typeof raw.occurredAt === "string" ? raw.occurredAt : "");
    if (required.length > 0) {
      addIssue(issues, index, eventId, "invalidTransition", `agent-initiated duel admission is rejected by policy: ${required.join(", ")}`);
      valid = false;
    }
  }
  if (valid && duel) {
    duel.acceptance = raw as unknown as DuelAdmittedEvent;
    duel.updatedAt = duel.acceptance.occurredAt;
  }
}

function validateDecline(
  raw: Record<string, unknown>,
  index: number,
  eventId: string | undefined,
  commonValid: boolean,
  state: DuelReplayState,
  issues: DuelValidationIssue[],
): void {
  let valid = commonValid;
  const duel = getDuel(raw, index, eventId, state, issues);
  if (!duel) valid = false;
  if (duel && (duel.acceptance || duel.decline || duel.cancellation)) {
    addIssue(issues, index, eventId, "invalidTransition", "duel can only be declined while awaiting acceptance");
    valid = false;
  }
  if (duel && raw.declinedBy !== duel.challenge.challengedId) {
    addIssue(issues, index, eventId, "invalidField", "declinedBy must be the challenged head");
    valid = false;
  }
  if (raw.recordedBy !== "local-user") {
    addIssue(issues, index, eventId, "invalidField", "recordedBy must be local-user");
    valid = false;
  }
  if (!validString(raw.reason, 2_000)) {
    addIssue(issues, index, eventId, "invalidField", "decline reason must contain 1-2000 trimmed characters");
    valid = false;
  }
  if (valid && duel) {
    duel.decline = raw as unknown as DuelDeclinedEvent;
    duel.updatedAt = duel.decline.occurredAt;
  }
}

function validateSeal(
  raw: Record<string, unknown>,
  index: number,
  eventId: string | undefined,
  commonValid: boolean,
  state: DuelReplayState,
  issues: DuelValidationIssue[],
): void {
  let valid = commonValid;
  const duel = getDuel(raw, index, eventId, state, issues);
  if (!duel) valid = false;
  if (duel && (!duel.acceptance || duel.decline || duel.cancellation || duel.reveal || duel.resolutions.length > 0)) {
    addIssue(issues, index, eventId, "invalidTransition", "commitments can only be sealed after acceptance and before reveal");
    valid = false;
  }
  if (!validString(raw.commitmentId, 128)) {
    addIssue(issues, index, eventId, "invalidField", "commitmentId must be a non-empty trimmed string up to 128 characters");
    valid = false;
  }
  if (duel && raw.participantId !== duel.challenge.challengerId && raw.participantId !== duel.challenge.challengedId) {
    addIssue(issues, index, eventId, "invalidField", "participantId must name one of the duel participants");
    valid = false;
  }
  if (duel && typeof raw.participantId === "string" && duel.seals.has(raw.participantId)) {
    addIssue(issues, index, eventId, "duplicateCommitment", `participant "${raw.participantId}" already sealed a commitment`);
    valid = false;
  }
  if (raw.captureType !== "agent-call" && raw.captureType !== "operator") {
    addIssue(issues, index, eventId, "invalidField", "captureType must be agent-call or operator");
    valid = false;
  }
  if (!validString(raw.captureRef, 512)) {
    addIssue(issues, index, eventId, "invalidField", "captureRef must be a non-empty trimmed string up to 512 characters");
    valid = false;
  } else if (raw.captureType === "agent-call" && !raw.captureRef.startsWith("agent-call:")) {
    addIssue(issues, index, eventId, "invalidField", "agent-call commitments require an agent-call receipt reference");
    valid = false;
  } else if (raw.captureType === "operator" && raw.captureRef !== "operator:local-user") {
    addIssue(issues, index, eventId, "invalidField", "operator commitments require the local operator receipt reference");
    valid = false;
  }
  if (raw.captureType === "agent-call") {
    if (!isRecord(raw.agentReceipt) || !validAgentReceipt(raw.agentReceipt)) {
      addIssue(issues, index, eventId, "invalidField", "agent-call commitments require a complete bounded Hydra execution receipt");
      valid = false;
    } else {
      if (raw.agentReceipt.agentId !== raw.participantId) {
        addIssue(issues, index, eventId, "invalidField", "agent-call receipt must belong to the duel participant");
        valid = false;
      }
      if (raw.captureRef !== `agent-call:${raw.agentReceipt.traceId}`) {
        addIssue(issues, index, eventId, "invalidField", "captureRef must identify the attached agent-call receipt");
        valid = false;
      }
      if (
        duel?.acceptance?.ratingClass === "rated"
        && typeof duel.challenge.sharedEvidencePacket === "string"
        && raw.agentReceipt.sharedEvidenceSha256 !== hashDuelSharedEvidencePacket(duel.challenge.sharedEvidencePacket)
      ) {
        addIssue(issues, index, eventId, "hashMismatch", "rated agent-call receipt must bind the exact shared evidence packet locked by the challenge");
        valid = false;
      }
      if (
        (duel?.challenge.ratingPolicy === DUEL_RATING_POLICY || duel?.challenge.ratingPolicy === DUEL_AGENT_RATING_POLICY)
        && raw.agentReceipt.capabilityPolicy !== duel.acceptance?.capabilityPolicy
      ) {
        addIssue(issues, index, eventId, "invalidField", "current rated duel receipts must bind the full-access capability policy locked at acceptance");
        valid = false;
      }
      if (
        duel?.challenge.ratingPolicy === DUEL_AGENT_RATING_POLICY
        && raw.agentReceipt.workspaceFingerprintSha256 !== duel.challenge.initiation?.workspaceFingerprintSha256
      ) {
        addIssue(issues, index, eventId, "hashMismatch", "agent-initiated duel receipts must bind the exact workspace fingerprint locked at admission");
        valid = false;
      }
      if (duel?.challenge.ratingPolicy === DUEL_AGENT_RATING_POLICY) {
        const capabilityLock = duel.challenge.initiation?.capabilityLocks.find((lock) => lock.agentId === raw.participantId);
        if (!capabilityLock || raw.agentReceipt.capabilityLockSha256 !== capabilityLock.profileSha256) {
          addIssue(issues, index, eventId, "hashMismatch", "agent-initiated duel receipts must bind the participant's exact admission capability lock");
          valid = false;
        }
      }
      if (duel?.acceptance?.ratingClass === "rated" && raw.agentReceipt.transport !== "oneShot") {
        addIssue(
          issues,
          index,
          eventId,
          "invalidField",
          "rated duel commitments require a local oneShot head receipt; HTTP transports cannot prove Hydra full-access execution",
        );
        valid = false;
      }
    }
  } else if (raw.agentReceipt !== undefined) {
    addIssue(issues, index, eventId, "invalidField", "operator commitments cannot attach an agent-call receipt");
    valid = false;
  }
  if (duel?.acceptance?.ratingClass === "rated" && raw.captureType !== "agent-call") {
    addIssue(issues, index, eventId, "invalidField", "rated duel commitments must be captured from the participant's actual agent call");
    valid = false;
  }
  if (raw.algorithm !== "sha256-v1" || typeof raw.commitmentHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.commitmentHash)) {
    addIssue(issues, index, eventId, "invalidField", "commitment seal must use sha256-v1 with a lowercase SHA-256 digest");
    valid = false;
  }
  const expectedRecorder = raw.captureType === "agent-call" ? "hydra-runtime" : "local-user";
  if (raw.recordedBy !== expectedRecorder) {
    addIssue(issues, index, eventId, "invalidField", `recordedBy must be ${expectedRecorder} for this commitment source`);
    valid = false;
  }
  if (valid && duel) {
    const seal = raw as unknown as DuelCommitmentSealedEvent;
    duel.seals.set(seal.participantId, seal);
    duel.updatedAt = seal.occurredAt;
  }
}

function validateReveal(
  raw: Record<string, unknown>,
  index: number,
  eventId: string | undefined,
  commonValid: boolean,
  state: DuelReplayState,
  issues: DuelValidationIssue[],
): void {
  let valid = commonValid;
  const duel = getDuel(raw, index, eventId, state, issues);
  if (!duel) valid = false;
  if (duel && (!duel.acceptance || duel.decline || duel.cancellation || duel.reveal || duel.resolutions.length > 0 || duel.seals.size !== 2)) {
    addIssue(issues, index, eventId, "invalidTransition", "paired reveal requires exactly two seals after acceptance and before resolution");
    valid = false;
  }
  const validRecorder = duel?.challenge.ratingPolicy === DUEL_AGENT_RATING_POLICY
    ? raw.recordedBy === "hydra-runtime"
    : raw.recordedBy === "local-user";
  if (!validRecorder) {
    addIssue(issues, index, eventId, "invalidField", "paired reveal recorder does not match the duel protocol");
    valid = false;
  }
  if (!Array.isArray(raw.payloads) || raw.payloads.length !== 2) {
    addIssue(issues, index, eventId, "invalidField", "paired reveal must contain exactly two payloads");
    valid = false;
  } else if (duel) {
    const expectedParticipants = [duel.challenge.challengerId, duel.challenge.challengedId];
    for (let payloadIndex = 0; payloadIndex < raw.payloads.length; payloadIndex += 1) {
      const payloadRaw = raw.payloads[payloadIndex];
      if (!isRecord(payloadRaw) || !validRevealPayload(payloadRaw)) {
        addIssue(issues, index, eventId, "invalidField", `reveal payload ${payloadIndex + 1} is invalid`);
        valid = false;
        continue;
      }
      const expectedParticipant = expectedParticipants[payloadIndex];
      const seal = expectedParticipant ? duel.seals.get(expectedParticipant) : undefined;
      if (
        !seal
        || payloadRaw.participantId !== expectedParticipant
        || payloadRaw.commitmentId !== seal.commitmentId
        || payloadRaw.captureType !== seal.captureType
        || payloadRaw.captureRef !== seal.captureRef
        || !sameAgentReceipt(payloadRaw.agentReceipt, seal.agentReceipt)
      ) {
        addIssue(issues, index, eventId, "invalidField", "reveal payloads must match the challenger and challenged seals in canonical order");
        valid = false;
        continue;
      }
      if (hashDuelCommitment(duel.challenge.duelId, payloadRaw as unknown as DuelRevealPayload) !== seal.commitmentHash) {
        addIssue(issues, index, eventId, "hashMismatch", `revealed commitment for ${expectedParticipant} does not match its seal`);
        valid = false;
      }
      if (
        payloadRaw.captureType === "agent-call"
        && isRecord(payloadRaw.agentReceipt)
        && typeof payloadRaw.agentReceipt.responseSha256 === "string"
        && payloadRaw.agentReceipt.responseSha256 !== hashDuelAgentResponse({
          duelId: duel.challenge.duelId,
          participantId: payloadRaw.participantId as string,
          commitmentId: payloadRaw.commitmentId as string,
          answer: payloadRaw.answer as string,
          confidence: payloadRaw.confidence as number,
        })
      ) {
        addIssue(issues, index, eventId, "hashMismatch", `agent-call response receipt for ${expectedParticipant} does not match the revealed answer`);
        valid = false;
      }
    }
  }
  if (valid && duel) {
    duel.reveal = raw as unknown as DuelCommitmentsRevealedEvent;
    duel.updatedAt = duel.reveal.occurredAt;
  }
}

function validateResolution(
  raw: Record<string, unknown>,
  index: number,
  eventId: string | undefined,
  commonValid: boolean,
  state: DuelReplayState,
  issues: DuelValidationIssue[],
): void {
  let valid = commonValid;
  const duel = getDuel(raw, index, eventId, state, issues);
  if (!duel) valid = false;
  if (duel && (!duel.reveal || duel.decline || duel.cancellation || duel.activeResolutionId)) {
    addIssue(issues, index, eventId, "invalidTransition", "resolution requires a paired reveal and no active result");
    valid = false;
  }
  if (!validString(raw.resolutionId, 128)) {
    addIssue(issues, index, eventId, "invalidField", "resolutionId must be a non-empty trimmed string up to 128 characters");
    valid = false;
  } else if (state.resolutions.has(raw.resolutionId)) {
    addIssue(issues, index, eventId, "duplicateResolution", `duplicate resolutionId "${raw.resolutionId}"`);
    valid = false;
  }
  if (typeof raw.outcome !== "string" || !OUTCOMES.has(raw.outcome as DuelOutcome)) {
    addIssue(issues, index, eventId, "invalidField", "outcome must be challengerWin, challengedWin, tie, unresolved, or void");
    valid = false;
  }
  if (raw.adjudicatorType === "deterministic") {
    // Deterministic is reserved in the schema, but v1 has no authoritative
    // event binding a machine result to this duel's proposition and outcome.
    // A label or runtime actor alone must never be enough to mint Elo.
    addIssue(
      issues,
      index,
      eventId,
      "invalidTransition",
      "deterministic duel resolutions are unsupported in v1 until Hydra records an authoritative machine mapping receipt",
    );
    valid = false;
  }
  if (duel && (raw.adjudicatorType !== duel.challenge.adjudicatorType || raw.adjudicatorId !== duel.challenge.adjudicatorId)) {
    addIssue(issues, index, eventId, "invalidField", "resolution adjudicator must match the evidence contract locked at challenge time");
    valid = false;
  }
  for (const field of ["evidenceRef", "rationale"] as const) {
    if (!validString(raw[field], field === "evidenceRef" ? 512 : 2_000)) {
      addIssue(issues, index, eventId, "invalidField", `${field} must be a non-empty trimmed string within its size limit`);
      valid = false;
    }
  }
  if (raw.recordedBy !== "local-user") {
    addIssue(issues, index, eventId, "invalidField", "recordedBy must be local-user");
    valid = false;
  }
  if (valid && duel) {
    const resolution = raw as unknown as DuelResolvedEvent;
    state.resolutions.set(resolution.resolutionId, resolution);
    duel.resolutions.push(resolution);
    duel.activeResolutionId = resolution.resolutionId;
    duel.firstResolutionIndex ??= index;
    duel.updatedAt = resolution.occurredAt;
  }
}

function validateResolutionReversal(
  raw: Record<string, unknown>,
  index: number,
  eventId: string | undefined,
  commonValid: boolean,
  state: DuelReplayState,
  issues: DuelValidationIssue[],
): void {
  let valid = commonValid;
  const duel = getDuel(raw, index, eventId, state, issues);
  if (!duel) valid = false;
  const target = typeof raw.targetResolutionId === "string" ? state.resolutions.get(raw.targetResolutionId) : undefined;
  if (!target || target.duelId !== raw.duelId) {
    addIssue(issues, index, eventId, "unknownResolution", "reversal must reference an earlier resolution from the same duel");
    valid = false;
  } else if (state.reversedResolutionIds.has(target.resolutionId)) {
    addIssue(issues, index, eventId, "resolutionAlreadyReversed", `resolution "${target.resolutionId}" is already reversed`);
    valid = false;
  } else if (duel?.activeResolutionId !== target.resolutionId) {
    addIssue(issues, index, eventId, "invalidTransition", "only the active duel result can be reversed");
    valid = false;
  }
  if (raw.reversedBy !== "local-user") {
    addIssue(issues, index, eventId, "invalidField", "duel result corrections are human-only in v1");
    valid = false;
  }
  if (!validString(raw.reason, 2_000)) {
    addIssue(issues, index, eventId, "invalidField", "reversal reason must contain 1-2000 trimmed characters");
    valid = false;
  }
  if (valid && duel && target) {
    const reversal = raw as unknown as DuelResolutionReversedEvent;
    state.reversedResolutionIds.add(target.resolutionId);
    state.reversals.push(reversal);
    duel.activeResolutionId = undefined;
    duel.updatedAt = reversal.occurredAt;
  }
}

function validateCancellation(
  raw: Record<string, unknown>,
  index: number,
  eventId: string | undefined,
  commonValid: boolean,
  state: DuelReplayState,
  issues: DuelValidationIssue[],
): void {
  let valid = commonValid;
  const duel = getDuel(raw, index, eventId, state, issues);
  if (!duel) valid = false;
  if (duel && (duel.decline || duel.cancellation || duel.resolutions.length > 0)) {
    addIssue(issues, index, eventId, "invalidTransition", "only an unresolved, non-declined duel can be cancelled");
    valid = false;
  }
  const runtimeCancellationAllowed = duel?.challenge.ratingPolicy === DUEL_AGENT_RATING_POLICY
    && duel.challenge.createdBy === "hydra-runtime";
  if (raw.cancelledBy !== "local-user" && !(raw.cancelledBy === "hydra-runtime" && runtimeCancellationAllowed)) {
    addIssue(issues, index, eventId, "invalidField", "only the local user, or Hydra integrity policy for a runtime-origin v3 duel, may cancel");
    valid = false;
  }
  if (!validString(raw.reason, 2_000)) {
    addIssue(issues, index, eventId, "invalidField", "cancellation reason must contain 1-2000 trimmed characters");
    valid = false;
  }
  if (valid && duel) {
    duel.cancellation = raw as unknown as DuelCancelledEvent;
    duel.updatedAt = duel.cancellation.occurredAt;
  }
}

function assessRatingEligibility(
  state: DuelReplayState,
  current: DuelRecord,
  occurredAt: string,
): DuelEligibilityReason[] {
  const currentMs = Date.parse(occurredAt);
  if (!Number.isFinite(currentMs)) return [];
  const participants = new Set([current.challenge.challengerId, current.challenge.challengedId]);
  const pair = duelPairKey(current.challenge.challengerId, current.challenge.challengedId);
  const allPriorRated = [...state.duels.values()].filter((candidate) =>
    candidate !== current
    && candidate.acceptance?.ratingClass === "rated"
  );
  // Legacy operator-created reservations remain replayable audit history but
  // cannot block, cool down, or farm the autonomous v3 ladder.
  const priorRated = current.challenge.ratingPolicy === DUEL_AGENT_RATING_POLICY
    ? allPriorRated.filter((candidate) =>
        candidate.challenge.ratingPolicy === DUEL_AGENT_RATING_POLICY
        && candidate.challenge.createdBy === "hydra-runtime"
      )
    : allPriorRated;
  const reasons: DuelEligibilityReason[] = [];
  const within = (candidate: DuelRecord, windowMs: number): boolean => {
    const priorMs = Date.parse(candidate.acceptance?.occurredAt ?? "");
    const age = currentMs - priorMs;
    return Number.isFinite(priorMs) && age >= 0 && age < windowMs;
  };

  if (current.challenge.sharedEvidencePacket === undefined) {
    reasons.push("missing-shared-evidence");
  }
  if (priorRated.some((candidate) =>
    within(candidate, DUEL_PROPOSITION_COOLDOWN_MS)
    && candidate.challenge.propositionFingerprint === current.challenge.propositionFingerprint
    && (participants.has(candidate.challenge.challengerId) || participants.has(candidate.challenge.challengedId))
  )) {
    reasons.push("repeat-proposition");
  }
  if (priorRated.some((candidate) =>
    within(candidate, DUEL_PAIR_COOLDOWN_MS)
    && candidate.challenge.domain === current.challenge.domain
    && duelPairKey(candidate.challenge.challengerId, candidate.challenge.challengedId) === pair
  )) {
    reasons.push("pair-cooldown");
  }
  const headAtCap = [...participants].some((participantId) =>
    priorRated.filter((candidate) =>
      within(candidate, DUEL_HEAD_DOMAIN_WINDOW_MS)
      && candidate.challenge.domain === current.challenge.domain
      && (candidate.challenge.challengerId === participantId || candidate.challenge.challengedId === participantId)
    ).length >= DUEL_HEAD_DOMAIN_MAX_RATED
  );
  if (headAtCap) reasons.push("head-domain-cap");
  if (current.challenge.ratingPolicy === DUEL_AGENT_RATING_POLICY) {
    const participantAlreadyActive = priorRated.some((candidate) =>
      !candidate.decline
      && !candidate.cancellation
      && candidate.activeResolutionId === undefined
      && (
        participants.has(candidate.challenge.challengerId)
        || participants.has(candidate.challenge.challengedId)
      )
    );
    if (participantAlreadyActive) reasons.push("head-active-duel");

    const priorInitiations = priorRated.filter((candidate) =>
      candidate.challenge.ratingPolicy === DUEL_AGENT_RATING_POLICY
      && candidate.challenge.challengerId === current.challenge.challengerId
    );
    if (priorInitiations.some((candidate) => within(candidate, DUEL_AGENT_INITIATION_COOLDOWN_MS))) {
      reasons.push("head-initiation-cooldown");
    }
    if (priorInitiations.filter((candidate) => within(candidate, DUEL_AGENT_INITIATION_WINDOW_MS)).length >= DUEL_AGENT_INITIATION_MAX_PER_WINDOW) {
      reasons.push("head-daily-cap");
    }
  }
  return reasons;
}

function computeRatings(state: DuelReplayState): {
  ratings: DuelRating[];
  deltasByResolution: Map<string, Readonly<Record<string, number>>>;
} {
  interface Builder {
    agentId: string;
    domain: string;
    rating: number;
    wins: number;
    draws: number;
    losses: number;
    ratedMatches: number;
  }
  const builders = new Map<string, Builder>();
  const deltasByResolution = new Map<string, Readonly<Record<string, number>>>();
  const eligible = [...state.duels.values()]
    .filter((duel) =>
      duel.challenge.ratingPolicy === DUEL_AGENT_RATING_POLICY
      && duel.challenge.createdBy === "hydra-runtime"
      && duel.acceptance?.ratingClass === "rated"
      && !!duel.activeResolutionId
    )
    .map((duel) => ({ duel, resolution: state.resolutions.get(duel.activeResolutionId!) }))
    .filter((entry): entry is { duel: DuelRecord; resolution: DuelResolvedEvent } => !!entry.resolution)
    .sort((left, right) =>
      (left.duel.firstResolutionIndex ?? Number.MAX_SAFE_INTEGER) - (right.duel.firstResolutionIndex ?? Number.MAX_SAFE_INTEGER)
      || left.resolution.occurredAt.localeCompare(right.resolution.occurredAt)
    );

  const builderFor = (agentId: string, domain: string): Builder => {
    const key = `${domain}\0${agentId}`;
    let builder = builders.get(key);
    if (!builder) {
      builder = { agentId, domain, rating: DUEL_INITIAL_RATING, wins: 0, draws: 0, losses: 0, ratedMatches: 0 };
      builders.set(key, builder);
    }
    return builder;
  };

  for (const { duel, resolution } of eligible) {
    if (resolution.outcome === "unresolved" || resolution.outcome === "void") continue;
    const challenger = builderFor(duel.challenge.challengerId, duel.challenge.domain);
    const challenged = builderFor(duel.challenge.challengedId, duel.challenge.domain);
    challenger.ratedMatches += 1;
    challenged.ratedMatches += 1;
    if (resolution.outcome === "tie") {
      challenger.draws += 1;
      challenged.draws += 1;
      deltasByResolution.set(resolution.resolutionId, {
        [challenger.agentId]: 0,
        [challenged.agentId]: 0,
      });
      continue;
    }
    const winner = resolution.outcome === "challengerWin" ? challenger : challenged;
    const loser = winner === challenger ? challenged : challenger;
    const expectedWinner = 1 / (1 + 10 ** ((loser.rating - winner.rating) / 400));
    const delta = Math.round(DUEL_ELO_K * (1 - expectedWinner));
    winner.rating += delta;
    loser.rating -= delta;
    winner.wins += 1;
    loser.losses += 1;
    deltasByResolution.set(resolution.resolutionId, {
      [winner.agentId]: delta,
      [loser.agentId]: -delta,
    });
  }

  const ratings = [...builders.values()]
    .map((builder): DuelRating => ({
      ...builder,
      provisional: builder.ratedMatches < MIN_DUEL_RATED_MATCHES,
    }))
    .sort((left, right) =>
      left.domain.localeCompare(right.domain)
      || right.rating - left.rating
      || left.agentId.localeCompare(right.agentId)
    );
  return { ratings, deltasByResolution };
}

function toDuelView(
  duel: DuelRecord,
  deltasByResolution: ReadonlyMap<string, Readonly<Record<string, number>>>,
): DuelView {
  const activeResolution = duel.activeResolutionId
    ? duel.resolutions.find((resolution) => resolution.resolutionId === duel.activeResolutionId)
    : undefined;
  const acceptance = duel.acceptance;
  const ratingIneligibilityReason = acceptance?.ratingClass === "exhibition"
    ? acceptance.eligibilityReasons.map(eligibilityReasonLabel).join(" ")
    : !acceptance
      ? "Rating eligibility is fixed when the challenged head accepts."
      : undefined;
  let commitments: readonly [DuelPublicCommitment, DuelPublicCommitment] | undefined;
  if (duel.reveal) {
    commitments = duel.reveal.payloads.map((payload): DuelPublicCommitment => ({
      agentId: payload.participantId,
      captureType: payload.captureType,
      captureRef: payload.captureRef,
      ...(payload.agentReceipt ? { agentReceipt: payload.agentReceipt } : {}),
      answer: payload.answer,
      confidence: payload.confidence,
    })) as [DuelPublicCommitment, DuelPublicCommitment];
  }
  const winnerId = activeResolution?.outcome === "challengerWin"
    ? duel.challenge.challengerId
    : activeResolution?.outcome === "challengedWin"
      ? duel.challenge.challengedId
      : undefined;
  const resolution: DuelPublicResolution | undefined = activeResolution
    ? {
      resolutionId: activeResolution.resolutionId,
      outcome: activeResolution.outcome,
      ...(winnerId ? { winnerId } : {}),
      source: activeResolution.adjudicatorType,
      adjudicatorId: activeResolution.adjudicatorId,
      evidenceRef: activeResolution.evidenceRef,
      rationale: activeResolution.rationale,
      occurredAt: activeResolution.occurredAt,
      ratingDeltas: deltasByResolution.get(activeResolution.resolutionId) ?? {},
    }
    : undefined;
  return {
    duelId: duel.challenge.duelId,
    occurredAt: duel.challenge.occurredAt,
    updatedAt: duel.updatedAt,
    status: duelStatus(duel),
    challengerId: duel.challenge.challengerId,
    challengedId: duel.challenge.challengedId,
    createdBy: duel.challenge.createdBy,
    ...(duel.challenge.initiation ? { initiation: duel.challenge.initiation } : {}),
    ratingPolicy: duel.challenge.ratingPolicy,
    domain: duel.challenge.domain,
    proposition: duel.challenge.proposition,
    propositionFingerprint: duel.challenge.propositionFingerprint,
    evidenceContract: duel.challenge.evidenceContract,
    ...(duel.challenge.sharedEvidencePacket !== undefined
      ? { sharedEvidencePacket: duel.challenge.sharedEvidencePacket }
      : {}),
    adjudicatorType: duel.challenge.adjudicatorType,
    adjudicatorId: duel.challenge.adjudicatorId,
    rated: acceptance?.ratingClass === "rated",
    ...(ratingIneligibilityReason ? { ratingIneligibilityReason } : {}),
    ...(acceptance?.capabilityPolicy ? { capabilityPolicy: acceptance.capabilityPolicy } : {}),
    commitmentCount: duel.seals.size,
    ...(commitments ? { commitments } : {}),
    ...(resolution ? { resolution } : {}),
    ...(duel.decline ? { declineReason: duel.decline.reason } : {}),
    ...(duel.cancellation ? { cancellationReason: duel.cancellation.reason } : {}),
  };
}

function duelStatus(duel: DuelRecord): DuelStatus {
  if (duel.decline) return "declined";
  if (duel.cancellation) return "cancelled";
  if (duel.activeResolutionId) return "resolved";
  if (duel.reveal) return "awaiting_adjudication";
  if (duel.seals.size === 2) return "awaiting_reveal";
  if (duel.acceptance) return "awaiting_commitments";
  return "awaiting_acceptance";
}

function eligibilityReasonLabel(reason: DuelEligibilityReason): string {
  switch (reason) {
    case "missing-shared-evidence": return "Exhibition: this legacy challenge did not lock the same bounded evidence packet for both heads.";
    case "repeat-proposition": return "Exhibition: this proposition was already reserved by a participant within 30 days.";
    case "pair-cooldown": return "Exhibition: this opponent pair already reserved a rated duel in the domain within 7 days.";
    case "head-domain-cap": return "Exhibition: a participant already reserved three rated duels in the domain within 7 days.";
    case "head-active-duel": return "Rejected: a participant already has an unresolved autonomous duel.";
    case "head-initiation-cooldown": return "Rejected: this challenger initiated another rated duel within the last hour.";
    case "head-daily-cap": return "Rejected: this challenger already initiated three rated duels in the last 24 hours.";
    case "voluntary-exhibition": return "Exhibition by operator choice.";
  }
}

function validAgentInitiation(
  value: unknown,
  challengerId: unknown,
  challengedId: unknown,
  occurredAt: unknown,
): value is DuelAgentInitiationReceipt {
  if (!isRecord(value)) return false;
  if (
    value.protocol !== "agent-intent-v1"
    || value.agentId !== challengerId
    || !validString(value.sourceTraceId, 256)
    || !validTimestamp(value.sourceMessageTimestamp)
    || !validTimestamp(value.disputedMessageTimestamp)
    || typeof value.sourceMessageSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(value.sourceMessageSha256)
    || typeof value.workspaceFingerprintSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(value.workspaceFingerprintSha256)
  ) {
    return false;
  }
  if (!Array.isArray(value.capabilityLocks) || value.capabilityLocks.length !== 2) return false;
  const participants = new Set([challengerId, challengedId]);
  const seen = new Set<string>();
  for (const candidate of value.capabilityLocks) {
    if (!isRecord(candidate)
      || !isValidAgentId(candidate.agentId)
      || !participants.has(candidate.agentId)
      || seen.has(candidate.agentId)
      || !validString(candidate.agentKind, 64)
      || typeof candidate.profileSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(candidate.profileSha256)) {
      return false;
    }
    seen.add(candidate.agentId);
  }
  if (seen.size !== 2) return false;
  const sourceMs = Date.parse(value.sourceMessageTimestamp as string);
  const disputedMs = Date.parse(value.disputedMessageTimestamp as string);
  const eventMs = Date.parse(typeof occurredAt === "string" ? occurredAt : "");
  return sourceMs <= eventMs && disputedMs <= sourceMs;
}

function validSharedEvidencePacket(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && value.length <= DUEL_MAX_SHARED_EVIDENCE_PACKET_BYTES
    && Buffer.byteLength(value, "utf8") <= DUEL_MAX_SHARED_EVIDENCE_PACKET_BYTES;
}

function getDuel(
  raw: Record<string, unknown>,
  index: number,
  eventId: string | undefined,
  state: DuelReplayState,
  issues: DuelValidationIssue[],
): DuelRecord | undefined {
  const duelId = typeof raw.duelId === "string" ? raw.duelId : "";
  const duel = state.duels.get(duelId);
  if (!duel) addIssue(issues, index, eventId, "unknownDuel", `event references unknown or later duel "${duelId}"`);
  return duel;
}

function parseEligibilityReasons(value: unknown): DuelEligibilityReason[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const reasons: DuelEligibilityReason[] = [];
  for (const reason of value) {
    if (typeof reason !== "string" || !ELIGIBILITY_REASONS.has(reason as DuelEligibilityReason)) return undefined;
    if (reasons.includes(reason as DuelEligibilityReason)) return undefined;
    reasons.push(reason as DuelEligibilityReason);
  }
  return reasons;
}

function validRevealPayload(raw: Record<string, unknown>): boolean {
  return validString(raw.commitmentId, 128)
    && isValidAgentId(raw.participantId)
    && (raw.captureType === "agent-call" || raw.captureType === "operator")
    && validString(raw.captureRef, 512)
    && (raw.captureType === "agent-call"
      ? isRecord(raw.agentReceipt) && validAgentReceipt(raw.agentReceipt)
      : raw.agentReceipt === undefined)
    && typeof raw.answer === "string"
    && raw.answer.trim().length > 0
    && raw.answer.length <= 4_000
    && typeof raw.confidence === "number"
    && Number.isFinite(raw.confidence)
    && raw.confidence >= 0
    && raw.confidence <= 1
    && validString(raw.nonce, 256);
}

function validAgentReceipt(raw: Record<string, unknown>): boolean {
  return validString(raw.traceId, 256)
    && isValidAgentId(raw.agentId)
    && validString(raw.agentKind, 64)
    && (raw.model === undefined || validString(raw.model, 256))
    && (raw.transport === "oneShot" || raw.transport === "http")
    && validTimestamp(raw.startedAt)
    && validTimestamp(raw.completedAt)
    && Date.parse(raw.completedAt) >= Date.parse(raw.startedAt)
    && typeof raw.promptSha256 === "string"
    && /^[a-f0-9]{64}$/.test(raw.promptSha256)
    && (raw.sharedEvidenceSha256 === undefined
      || (typeof raw.sharedEvidenceSha256 === "string" && /^[a-f0-9]{64}$/.test(raw.sharedEvidenceSha256)))
    && (raw.capabilityPolicy === undefined || raw.capabilityPolicy === DUEL_FULL_ACCESS_POLICY_ID)
    && typeof raw.responseSha256 === "string"
    && /^[a-f0-9]{64}$/.test(raw.responseSha256)
    && typeof raw.invocationSha256 === "string"
    && /^[a-f0-9]{64}$/.test(raw.invocationSha256)
    && (raw.workspaceFingerprintSha256 === undefined
      || (typeof raw.workspaceFingerprintSha256 === "string" && /^[a-f0-9]{64}$/.test(raw.workspaceFingerprintSha256)))
    && (raw.capabilityLockSha256 === undefined
      || (typeof raw.capabilityLockSha256 === "string" && /^[a-f0-9]{64}$/.test(raw.capabilityLockSha256)));
}

function sameAgentReceipt(left: unknown, right: DuelAgentCallReceipt | undefined): boolean {
  if (left === undefined || right === undefined) return left === undefined && right === undefined;
  if (!isRecord(left) || !validAgentReceipt(left)) return false;
  return left.traceId === right.traceId
    && left.agentId === right.agentId
    && left.agentKind === right.agentKind
    && left.model === right.model
    && left.transport === right.transport
    && left.startedAt === right.startedAt
    && left.completedAt === right.completedAt
    && left.promptSha256 === right.promptSha256
    && left.sharedEvidenceSha256 === right.sharedEvidenceSha256
    && left.capabilityPolicy === right.capabilityPolicy
    && left.responseSha256 === right.responseSha256
    && left.invocationSha256 === right.invocationSha256
    && left.workspaceFingerprintSha256 === right.workspaceFingerprintSha256
    && left.capabilityLockSha256 === right.capabilityLockSha256;
}

function duelPairKey(left: string, right: string): string {
  return [left, right].sort().join("\0");
}

function validString(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && Number.isFinite(Date.parse(value));
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function addIssue(
  issues: DuelValidationIssue[],
  index: number,
  eventId: string | undefined,
  code: DuelValidationCode,
  message: string,
): void {
  issues.push({ index, ...(eventId ? { eventId } : {}), code, message });
}
