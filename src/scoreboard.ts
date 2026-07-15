/**
 * Passive, append-only scoring for Hydra heads.
 *
 * The event log is the source of truth. Aggregation replays it into derived
 * standings; callers never have to update (or erase) an earlier verdict when
 * an adjudication is reversed.
 */
import { isValidAgentId } from "./agentValidation";

export type CorrectnessOutcome = "correct" | "partial" | "incorrect" | "unresolved" | "void";
export type VerdictSourceStrength = "deterministic" | "human" | "peer";

export interface ClaimRegisteredEvent {
  readonly type: "claimRegistered";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly claimId: string;
  /** Stable id shared by every competing claim from the same room round. */
  readonly roundId: string;
  readonly agentId: string;
  readonly domain: string;
  readonly statement: string;
  /** The claimant's self-assessed confidence, retained for calibration only. */
  readonly confidence: number | null;
}

export interface VerdictRecordedEvent {
  readonly type: "verdictRecorded";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly verdictId: string;
  readonly claimId: string;
  readonly outcome: CorrectnessOutcome;
  readonly source: VerdictSourceStrength;
  /** Identity of the test, human, or peer that supplied the adjudication. */
  readonly adjudicatorId: string;
  /** Durable verification receipt, human decision, or peer assessment reference. */
  readonly evidenceRef: string;
  /** Required evidence note explaining why the outcome follows. */
  readonly rationale: string;
}

export interface VerdictReversedEvent {
  readonly type: "verdictReversed";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly targetVerdictId: string;
  readonly reversedBy: string;
  readonly reason: string;
}

export type ScoreboardEvent = ClaimRegisteredEvent | VerdictRecordedEvent | VerdictReversedEvent;

export const MIN_INDEPENDENT_ROUNDS = 5;
/** @deprecated Use MIN_INDEPENDENT_ROUNDS; retained for API compatibility. */
export const MIN_INDEPENDENTLY_RESOLVED_OUTCOMES = MIN_INDEPENDENT_ROUNDS;
/** One standard deviation: enough small-sample caution without hiding signal. */
export const SCORE_WILSON_Z = 1;

/** Public so a UI can explain exactly how a standing was calculated. */
export const OUTCOME_CREDIT: Readonly<Record<CorrectnessOutcome, number>> = Object.freeze({
  correct: 1,
  partial: 0.5,
  incorrect: 0,
  unresolved: 0,
  void: 0,
});

/**
 * Deterministic evidence carries the most weight, followed by a human
 * adjudication and then a peer review. These weights affect evidence quality;
 * the claimant's self-reported confidence never does.
 */
export const SOURCE_WEIGHT: Readonly<Record<VerdictSourceStrength, number>> = Object.freeze({
  deterministic: 1,
  human: 0.75,
  // Heads may critique each other, but peer votes cannot move the standings.
  // Duel rating will be a separate system when it is introduced.
  peer: 0,
});

export interface ScoreboardCounts {
  /** Claims registered for this head in this domain. */
  readonly claims: number;
  /** Historical verdict events, including verdicts later reversed. */
  readonly verdictsRecorded: number;
  readonly verdictsReversed: number;
  readonly activeVerdicts: number;
  /** Claims with no currently active verdict. */
  readonly pending: number;
  readonly correct: number;
  readonly partial: number;
  readonly incorrect: number;
  /** Resolved outcomes backed by deterministic evidence or human adjudication. */
  readonly trustedCorrect: number;
  readonly trustedPartial: number;
  readonly trustedIncorrect: number;
  readonly unresolved: number;
  readonly void: number;
  /** correct + partial + incorrect; at most one per distinct claim. */
  readonly independentlyResolved: number;
  /** Distinct resolved rounds that contribute to maturity and score. */
  readonly independentRounds: number;
  /** Resolved peer opinions retained for inspection but excluded from score. */
  readonly advisoryResolved: number;
}

export interface DomainStanding {
  readonly agentId: string;
  readonly domain: string;
  readonly counts: ScoreboardCounts;
  /** Sum of active resolved source weights. */
  readonly weightedResolvedEvidence: number;
  /** Sum of outcome credit multiplied by source weight. */
  readonly weightedCorrectness: number;
  /** null when the domain has no active resolved outcomes. */
  readonly weightedAccuracy: number | null;
  /**
   * Source-weighted evidence maturity, capped at one. This prevents a single
   * result from looking established while allowing more independent weak
   * evidence to accumulate into a reliable record.
   */
  readonly reliability: number | null;
  /** Wilson lower confidence bound over weighted accuracy; null with no evidence. */
  readonly score: number | null;
  readonly provisional: boolean;
}

export interface ScoreboardAggregate {
  readonly eventCount: number;
  readonly standings: readonly DomainStanding[];
  readonly overallStandings: readonly AgentStanding[];
}

export interface AgentStanding extends Omit<DomainStanding, "domain"> {
  readonly domains: readonly string[];
}

export interface ActiveScoreEvidence {
  readonly claim: ClaimRegisteredEvent;
  readonly verdict: VerdictRecordedEvent;
}

export interface ReversedScoreEvidence extends ActiveScoreEvidence {
  readonly reversal: VerdictReversedEvent;
}

export type ScoreboardValidationCode =
  | "invalidEvent"
  | "invalidType"
  | "invalidField"
  | "duplicateEvent"
  | "duplicateClaim"
  | "duplicateVerdict"
  | "unknownClaim"
  | "unknownVerdict"
  | "activeVerdictExists"
  | "verdictAlreadyReversed";

export interface ScoreboardValidationIssue {
  readonly index: number;
  readonly eventId?: string;
  readonly code: ScoreboardValidationCode;
  readonly message: string;
}

export class ScoreboardValidationError extends Error {
  readonly issues: readonly ScoreboardValidationIssue[];

  constructor(issues: readonly ScoreboardValidationIssue[]) {
    super(`Invalid scoreboard event log: ${issues.map((issue) => issue.message).join("; ")}`);
    this.name = "ScoreboardValidationError";
    this.issues = [...issues];
  }
}

const OUTCOMES = new Set<CorrectnessOutcome>(["correct", "partial", "incorrect", "unresolved", "void"]);
const SOURCES = new Set<VerdictSourceStrength>(["deterministic", "human", "peer"]);

interface ReplayState {
  readonly claims: Map<string, ClaimRegisteredEvent>;
  readonly verdicts: Map<string, VerdictRecordedEvent>;
  readonly activeVerdictByClaim: Map<string, string>;
  readonly reversedVerdicts: Set<string>;
}

/**
 * Validates both event shapes and append-order references. A verdict must
 * follow its claim, and a reversal must follow a currently active verdict.
 */
export function validateScoreboardEvents(events: readonly unknown[]): ScoreboardValidationIssue[] {
  return replay(events).issues;
}

/** Pure aggregation: the input array and every event inside it are left untouched. */
export function aggregateScoreboard(events: readonly ScoreboardEvent[]): ScoreboardAggregate {
  const replayed = replay(events);
  if (replayed.issues.length > 0) throw new ScoreboardValidationError(replayed.issues);

  const builders = new Map<string, StandingBuilder>();
  const overallBuilders = new Map<string, StandingBuilder>();
  const trustedRoundsByBuilder = new Map<StandingBuilder, Map<string, RoundEvidence>>();
  const domainsByAgent = new Map<string, Set<string>>();
  for (const claim of replayed.state.claims.values()) {
    for (const builder of standingBuildersForClaim(builders, overallBuilders, claim)) builder.claims += 1;
    const domains = domainsByAgent.get(claim.agentId) ?? new Set<string>();
    domains.add(claim.domain);
    domainsByAgent.set(claim.agentId, domains);
  }

  for (const verdict of replayed.state.verdicts.values()) {
    const claim = replayed.state.claims.get(verdict.claimId);
    // A valid replay guarantees this. Keep the guard so this module remains
    // safe if validation and aggregation evolve independently later.
    if (!claim) continue;
    for (const builder of standingBuildersForClaim(builders, overallBuilders, claim)) {
      builder.verdictsRecorded += 1;
      if (replayed.state.reversedVerdicts.has(verdict.verdictId)) builder.verdictsReversed += 1;
    }
  }

  for (const verdictId of replayed.state.activeVerdictByClaim.values()) {
    const verdict = replayed.state.verdicts.get(verdictId);
    if (!verdict) continue;
    const claim = replayed.state.claims.get(verdict.claimId);
    if (!claim) continue;
    for (const builder of standingBuildersForClaim(builders, overallBuilders, claim)) {
      builder.activeVerdicts += 1;
      builder[verdict.outcome] += 1;

      if (!isResolvedOutcome(verdict.outcome)) continue;
      const sourceWeight = SOURCE_WEIGHT[verdict.source];
      if (sourceWeight <= 0) {
        builder.advisoryResolved += 1;
        continue;
      }
      builder.independentlyResolved += 1;
      if (verdict.outcome === "correct") builder.trustedCorrect += 1;
      if (verdict.outcome === "partial") builder.trustedPartial += 1;
      if (verdict.outcome === "incorrect") builder.trustedIncorrect += 1;
      const rounds = trustedRoundsByBuilder.get(builder) ?? new Map<string, RoundEvidence>();
      const round = rounds.get(claim.roundId) ?? { weight: 0, weightedCorrectness: 0 };
      round.weight += sourceWeight;
      round.weightedCorrectness += sourceWeight * OUTCOME_CREDIT[verdict.outcome];
      rounds.set(claim.roundId, round);
      trustedRoundsByBuilder.set(builder, rounds);
    }
  }

  // One room round contributes at most one unit of evidence per head/standing.
  // Splitting a prediction into many correlated claims cannot manufacture
  // maturity. Multiple adjudications in the round contribute their weighted
  // average correctness under that single capped evidence unit.
  for (const [builder, rounds] of trustedRoundsByBuilder) {
    builder.independentRounds = rounds.size;
    for (const round of rounds.values()) {
      if (round.weight <= 0) continue;
      const effectiveWeight = Math.min(1, round.weight);
      builder.weightedResolvedEvidence += effectiveWeight;
      builder.weightedCorrectness += (round.weightedCorrectness / round.weight) * effectiveWeight;
    }
  }

  const standings = [...builders.values()]
    .map(toDomainStanding)
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.agentId.localeCompare(b.agentId));

  const overallStandings = [...overallBuilders.values()]
    .map((builder): AgentStanding => {
      const { domain: _domain, ...standing } = toDomainStanding(builder);
      return {
        ...standing,
        domains: [...(domainsByAgent.get(builder.agentId) ?? [])].sort(),
      };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.agentId.localeCompare(b.agentId));

  return { eventCount: events.length, standings, overallStandings };
}

/** Convenience for callers that only need the domain rows. */
export function aggregateDomainStandings(events: readonly ScoreboardEvent[]): readonly DomainStanding[] {
  return aggregateScoreboard(events).standings;
}

/** Active claim/verdict pairs for evidence inspection and append-only reversal. */
export function listActiveScoreEvidence(events: readonly ScoreboardEvent[]): readonly ActiveScoreEvidence[] {
  const replayed = replay(events);
  if (replayed.issues.length > 0) throw new ScoreboardValidationError(replayed.issues);
  const active: ActiveScoreEvidence[] = [];
  for (const verdictId of replayed.state.activeVerdictByClaim.values()) {
    const verdict = replayed.state.verdicts.get(verdictId);
    const claim = verdict ? replayed.state.claims.get(verdict.claimId) : undefined;
    if (claim && verdict) active.push({ claim, verdict });
  }
  return active.sort((a, b) => b.verdict.occurredAt.localeCompare(a.verdict.occurredAt));
}

/** Claims with no active verdict, ready for initial or replacement adjudication. */
export function listPendingScoreClaims(events: readonly ScoreboardEvent[]): readonly ClaimRegisteredEvent[] {
  const replayed = replay(events);
  if (replayed.issues.length > 0) throw new ScoreboardValidationError(replayed.issues);
  return [...replayed.state.claims.values()]
    .filter((claim) => !replayed.state.activeVerdictByClaim.has(claim.claimId))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

/** Full reversed verdict trail for human audit; these rows no longer affect scores. */
export function listReversedScoreEvidence(events: readonly ScoreboardEvent[]): readonly ReversedScoreEvidence[] {
  const replayed = replay(events);
  if (replayed.issues.length > 0) throw new ScoreboardValidationError(replayed.issues);
  const reversed: ReversedScoreEvidence[] = [];
  for (const reversal of events) {
    if (reversal.type !== "verdictReversed") continue;
    const verdict = replayed.state.verdicts.get(reversal.targetVerdictId);
    const claim = verdict ? replayed.state.claims.get(verdict.claimId) : undefined;
    if (claim && verdict) reversed.push({ claim, verdict, reversal });
  }
  return reversed.sort((a, b) => b.reversal.occurredAt.localeCompare(a.reversal.occurredAt));
}

function replay(events: readonly unknown[]): { issues: ScoreboardValidationIssue[]; state: ReplayState } {
  const issues: ScoreboardValidationIssue[] = [];
  const eventIds = new Set<string>();
  const state: ReplayState = {
    claims: new Map(),
    verdicts: new Map(),
    activeVerdictByClaim: new Map(),
    reversedVerdicts: new Set(),
  };

  for (let index = 0; index < events.length; index += 1) {
    const raw = events[index];
    if (!isRecord(raw)) {
      addIssue(issues, index, undefined, "invalidEvent", "event must be an object");
      continue;
    }

    const eventId = validRequiredString(raw.eventId) ? raw.eventId : undefined;
    let commonValid = true;
    if (!eventId) {
      addIssue(issues, index, undefined, "invalidField", "eventId must be a non-empty trimmed string");
      commonValid = false;
    } else if (eventIds.has(eventId)) {
      addIssue(issues, index, eventId, "duplicateEvent", `duplicate eventId "${eventId}"`);
      commonValid = false;
    }
    if (!validTimestamp(raw.occurredAt)) {
      addIssue(issues, index, eventId, "invalidField", "occurredAt must be a valid timestamp");
      commonValid = false;
    }
    if (eventId && !eventIds.has(eventId)) eventIds.add(eventId);

    if (raw.type === "claimRegistered") {
      validateClaim(raw, index, eventId, commonValid, state, issues);
    } else if (raw.type === "verdictRecorded") {
      validateVerdict(raw, index, eventId, commonValid, state, issues);
    } else if (raw.type === "verdictReversed") {
      validateReversal(raw, index, eventId, commonValid, state, issues);
    } else {
      addIssue(issues, index, eventId, "invalidType", `unknown scoreboard event type "${String(raw.type)}"`);
    }
  }

  return { issues, state };
}

function validateClaim(
  raw: Record<string, unknown>,
  index: number,
  eventId: string | undefined,
  commonValid: boolean,
  state: ReplayState,
  issues: ScoreboardValidationIssue[],
): void {
  let valid = commonValid;
  for (const field of ["claimId", "roundId", "agentId", "domain", "statement"] as const) {
    if (!validRequiredString(raw[field])) {
      addIssue(issues, index, eventId, "invalidField", `${field} must be a non-empty trimmed string`);
      valid = false;
    }
  }
  if (typeof raw.agentId === "string" && !isValidAgentId(raw.agentId)) {
    addIssue(issues, index, eventId, "invalidField", "agentId must be a valid durable Hydra head id");
    valid = false;
  }
  if (typeof raw.domain === "string" && !/^[a-z][a-z0-9-]{0,31}$/.test(raw.domain)) {
    addIssue(issues, index, eventId, "invalidField", "domain must be a lowercase slug up to 32 characters");
    valid = false;
  }
  for (const field of ["claimId", "roundId"] as const) {
    if (typeof raw[field] === "string" && raw[field].length > 128) {
      addIssue(issues, index, eventId, "invalidField", `${field} must be at most 128 characters`);
      valid = false;
    }
  }
  if (typeof raw.statement === "string" && raw.statement.length > 2_000) {
    addIssue(issues, index, eventId, "invalidField", "statement must be at most 2000 characters");
    valid = false;
  }
  if (raw.confidence !== null && (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1)) {
    addIssue(issues, index, eventId, "invalidField", "confidence must be null or a finite number from 0 through 1");
    valid = false;
  }
  const claimId = typeof raw.claimId === "string" ? raw.claimId : "";
  if (claimId && state.claims.has(claimId)) {
    addIssue(issues, index, eventId, "duplicateClaim", `duplicate claimId "${claimId}"`);
    valid = false;
  }
  if (valid) state.claims.set(claimId, raw as unknown as ClaimRegisteredEvent);
}

function validateVerdict(
  raw: Record<string, unknown>,
  index: number,
  eventId: string | undefined,
  commonValid: boolean,
  state: ReplayState,
  issues: ScoreboardValidationIssue[],
): void {
  let valid = commonValid;
  for (const field of ["verdictId", "claimId", "adjudicatorId"] as const) {
    if (!validRequiredString(raw[field])) {
      addIssue(issues, index, eventId, "invalidField", `${field} must be a non-empty trimmed string`);
      valid = false;
    }
  }
  if (typeof raw.outcome !== "string" || !OUTCOMES.has(raw.outcome as CorrectnessOutcome)) {
    addIssue(issues, index, eventId, "invalidField", `outcome must be one of ${[...OUTCOMES].join(", ")}`);
    valid = false;
  }
  if (typeof raw.source !== "string" || !SOURCES.has(raw.source as VerdictSourceStrength)) {
    addIssue(issues, index, eventId, "invalidField", `source must be one of ${[...SOURCES].join(", ")}`);
    valid = false;
  }
  if (raw.rationale !== undefined && typeof raw.rationale !== "string") {
    addIssue(issues, index, eventId, "invalidField", "rationale must be a string");
    valid = false;
  }
  for (const field of ["evidenceRef", "rationale"] as const) {
    if (!validRequiredString(raw[field])) {
      addIssue(issues, index, eventId, "invalidField", `${field} must be a non-empty trimmed string`);
      valid = false;
    }
  }
  if (typeof raw.evidenceRef === "string" && raw.evidenceRef.length > 512) {
    addIssue(issues, index, eventId, "invalidField", "evidenceRef must be at most 512 characters");
    valid = false;
  }
  if (typeof raw.rationale === "string" && raw.rationale.length > 2_000) {
    addIssue(issues, index, eventId, "invalidField", "rationale must be at most 2000 characters");
    valid = false;
  }

  const verdictId = typeof raw.verdictId === "string" ? raw.verdictId : "";
  const claimId = typeof raw.claimId === "string" ? raw.claimId : "";
  if (verdictId && state.verdicts.has(verdictId)) {
    addIssue(issues, index, eventId, "duplicateVerdict", `duplicate verdictId "${verdictId}"`);
    valid = false;
  }
  if (claimId && !state.claims.has(claimId)) {
    addIssue(issues, index, eventId, "unknownClaim", `verdict references unknown or later claim "${claimId}"`);
    valid = false;
  }
  const claim = state.claims.get(claimId);
  if (raw.source === "peer" && claim && raw.adjudicatorId === claim.agentId) {
    addIssue(issues, index, eventId, "invalidField", "a peer adjudicator must differ from the claimant");
    valid = false;
  }
  if (claimId && state.activeVerdictByClaim.has(claimId)) {
    addIssue(issues, index, eventId, "activeVerdictExists", `claim "${claimId}" already has an active verdict`);
    valid = false;
  }
  if (valid) {
    state.verdicts.set(verdictId, raw as unknown as VerdictRecordedEvent);
    state.activeVerdictByClaim.set(claimId, verdictId);
  }
}

function validateReversal(
  raw: Record<string, unknown>,
  index: number,
  eventId: string | undefined,
  commonValid: boolean,
  state: ReplayState,
  issues: ScoreboardValidationIssue[],
): void {
  let valid = commonValid;
  for (const field of ["targetVerdictId", "reversedBy", "reason"] as const) {
    if (!validRequiredString(raw[field])) {
      addIssue(issues, index, eventId, "invalidField", `${field} must be a non-empty trimmed string`);
      valid = false;
    }
  }
  if (typeof raw.reversedBy === "string" && raw.reversedBy.length > 128) {
    addIssue(issues, index, eventId, "invalidField", "reversedBy must be at most 128 characters");
    valid = false;
  }
  if (typeof raw.targetVerdictId === "string" && raw.targetVerdictId.length > 128) {
    addIssue(issues, index, eventId, "invalidField", "targetVerdictId must be at most 128 characters");
    valid = false;
  }
  if (typeof raw.reason === "string" && raw.reason.length > 2_000) {
    addIssue(issues, index, eventId, "invalidField", "reason must be at most 2000 characters");
    valid = false;
  }
  const targetVerdictId = typeof raw.targetVerdictId === "string" ? raw.targetVerdictId : "";
  const target = targetVerdictId ? state.verdicts.get(targetVerdictId) : undefined;
  if (targetVerdictId && !target) {
    addIssue(issues, index, eventId, "unknownVerdict", `reversal references unknown or later verdict "${targetVerdictId}"`);
    valid = false;
  } else if (target && state.reversedVerdicts.has(targetVerdictId)) {
    addIssue(issues, index, eventId, "verdictAlreadyReversed", `verdict "${targetVerdictId}" is already reversed`);
    valid = false;
  }
  if (valid && target) {
    state.reversedVerdicts.add(targetVerdictId);
    if (state.activeVerdictByClaim.get(target.claimId) === targetVerdictId) {
      state.activeVerdictByClaim.delete(target.claimId);
    }
  }
}

function addIssue(
  issues: ScoreboardValidationIssue[],
  index: number,
  eventId: string | undefined,
  code: ScoreboardValidationCode,
  message: string,
): void {
  issues.push(eventId === undefined ? { index, code, message } : { index, eventId, code, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRequiredString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function validTimestamp(value: unknown): value is string {
  return validRequiredString(value) && Number.isFinite(Date.parse(value));
}

function isResolvedOutcome(outcome: CorrectnessOutcome): outcome is "correct" | "partial" | "incorrect" {
  return outcome === "correct" || outcome === "partial" || outcome === "incorrect";
}

interface StandingBuilder {
  agentId: string;
  domain: string;
  claims: number;
  verdictsRecorded: number;
  verdictsReversed: number;
  activeVerdicts: number;
  correct: number;
  partial: number;
  incorrect: number;
  trustedCorrect: number;
  trustedPartial: number;
  trustedIncorrect: number;
  unresolved: number;
  void: number;
  independentlyResolved: number;
  independentRounds: number;
  advisoryResolved: number;
  weightedResolvedEvidence: number;
  weightedCorrectness: number;
}

function getStandingBuilder(builders: Map<string, StandingBuilder>, agentId: string, domain: string): StandingBuilder {
  const key = JSON.stringify([agentId, domain]);
  const existing = builders.get(key);
  if (existing) return existing;
  const created: StandingBuilder = {
    agentId,
    domain,
    claims: 0,
    verdictsRecorded: 0,
    verdictsReversed: 0,
    activeVerdicts: 0,
    correct: 0,
    partial: 0,
    incorrect: 0,
    trustedCorrect: 0,
    trustedPartial: 0,
    trustedIncorrect: 0,
    unresolved: 0,
    void: 0,
    independentlyResolved: 0,
    independentRounds: 0,
    advisoryResolved: 0,
    weightedResolvedEvidence: 0,
    weightedCorrectness: 0,
  };
  builders.set(key, created);
  return created;
}

function toDomainStanding(builder: StandingBuilder): DomainStanding {
  const weightedAccuracy = builder.weightedResolvedEvidence > 0
    ? builder.weightedCorrectness / builder.weightedResolvedEvidence
    : null;
  const reliability = builder.independentRounds === 0
    ? null
    : Math.min(1, builder.weightedResolvedEvidence / MIN_INDEPENDENT_ROUNDS);
  const score = weightedAccuracy === null
    ? null
    : wilsonLowerBound(builder.weightedCorrectness, builder.weightedResolvedEvidence, SCORE_WILSON_Z);

  return {
    agentId: builder.agentId,
    domain: builder.domain,
    counts: {
      claims: builder.claims,
      verdictsRecorded: builder.verdictsRecorded,
      verdictsReversed: builder.verdictsReversed,
      activeVerdicts: builder.activeVerdicts,
      pending: builder.claims - builder.activeVerdicts,
      correct: builder.correct,
      partial: builder.partial,
      incorrect: builder.incorrect,
      trustedCorrect: builder.trustedCorrect,
      trustedPartial: builder.trustedPartial,
      trustedIncorrect: builder.trustedIncorrect,
      unresolved: builder.unresolved,
      void: builder.void,
      independentlyResolved: builder.independentlyResolved,
      independentRounds: builder.independentRounds,
      advisoryResolved: builder.advisoryResolved,
    },
    weightedResolvedEvidence: builder.weightedResolvedEvidence,
    weightedCorrectness: builder.weightedCorrectness,
    weightedAccuracy,
    reliability,
    score,
    provisional: builder.independentRounds < MIN_INDEPENDENT_ROUNDS,
  };
}

interface RoundEvidence {
  weight: number;
  weightedCorrectness: number;
}

function wilsonLowerBound(successes: number, total: number, z: number): number {
  if (!(total > 0)) return 0;
  const proportion = Math.max(0, Math.min(1, successes / total));
  const zSquared = z * z;
  const denominator = 1 + (zSquared / total);
  const center = proportion + (zSquared / (2 * total));
  const margin = z * Math.sqrt((proportion * (1 - proportion) + (zSquared / (4 * total))) / total);
  return Math.max(0, Math.min(1, (center - margin) / denominator));
}

function standingBuildersForClaim(
  domainBuilders: Map<string, StandingBuilder>,
  overallBuilders: Map<string, StandingBuilder>,
  claim: ClaimRegisteredEvent,
): [StandingBuilder, StandingBuilder] {
  return [
    getStandingBuilder(domainBuilders, claim.agentId, claim.domain),
    getStandingBuilder(overallBuilders, claim.agentId, "__overall__"),
  ];
}
