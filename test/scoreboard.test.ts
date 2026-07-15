import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  aggregateScoreboard,
  listActiveScoreEvidence,
  listPendingScoreClaims,
  listReversedScoreEvidence,
  MIN_INDEPENDENT_ROUNDS,
  ScoreboardValidationError,
  SOURCE_WEIGHT,
  validateScoreboardEvents,
  type ClaimRegisteredEvent,
  type CorrectnessOutcome,
  type ScoreboardEvent,
  type VerdictRecordedEvent,
  type VerdictSourceStrength,
} from "../src/scoreboard";

const OCCURRED_AT = "2026-07-14T12:00:00.000Z";

function claim(
  claimId: string,
  options: Partial<Pick<ClaimRegisteredEvent, "roundId" | "agentId" | "domain" | "statement" | "confidence">> = {},
): ClaimRegisteredEvent {
  return {
    type: "claimRegistered",
    eventId: `event-claim-${claimId}`,
    occurredAt: OCCURRED_AT,
    claimId,
    roundId: options.roundId ?? `round-${claimId}`,
    agentId: options.agentId ?? "codex",
    domain: options.domain ?? "runtime",
    statement: options.statement ?? `Claim ${claimId}`,
    confidence: options.confidence === undefined ? 0.5 : options.confidence,
  };
}

function verdict(
  verdictId: string,
  claimId: string,
  outcome: CorrectnessOutcome,
  source: VerdictSourceStrength = "deterministic",
  adjudicatorId = source === "peer" ? "claude" : `${source}-judge`,
): VerdictRecordedEvent {
  return {
    type: "verdictRecorded",
    eventId: `event-verdict-${verdictId}`,
    occurredAt: OCCURRED_AT,
    verdictId,
    claimId,
    outcome,
    source,
    adjudicatorId,
    evidenceRef: source === "deterministic" ? `verification:${verdictId}` : `${source}:${adjudicatorId}`,
    rationale: `Evidence for ${verdictId}`,
  };
}

function standing(events: readonly ScoreboardEvent[], domain = "runtime") {
  const result = aggregateScoreboard(events).standings.find((row) => row.agentId === "codex" && row.domain === domain);
  assert.ok(result);
  return result;
}

function assertNear(actual: number | null, expected: number): void {
  assert.notEqual(actual, null);
  assert.ok(Math.abs((actual ?? 0) - expected) < 1e-12, `expected ${String(actual)} to be near ${expected}`);
}

describe("passive scoreboard", () => {
  test("aggregates weighted accuracy and reliability per head and domain", () => {
    const events: ScoreboardEvent[] = [
      claim("runtime-correct", { confidence: 0.01 }),
      verdict("runtime-correct", "runtime-correct", "correct", "deterministic"),
      claim("runtime-partial", { confidence: 0.99 }),
      verdict("runtime-partial", "runtime-partial", "partial", "human"),
      claim("runtime-incorrect"),
      verdict("runtime-incorrect", "runtime-incorrect", "incorrect", "peer"),
      claim("ux-correct", { domain: "ux" }),
      verdict("ux-correct", "ux-correct", "correct", "peer"),
      claim("claude-runtime", { agentId: "claude" }),
      verdict("claude-runtime", "claude-runtime", "correct", "human"),
    ];

    const aggregate = aggregateScoreboard(events);
    assert.equal(aggregate.eventCount, events.length);
    assert.deepEqual(aggregate.standings.map((row) => `${row.domain}:${row.agentId}`), [
      "runtime:claude",
      "runtime:codex",
      "ux:codex",
    ]);

    const runtime = standing(events);
    assert.deepEqual(runtime.counts, {
      claims: 3,
      verdictsRecorded: 3,
      verdictsReversed: 0,
      activeVerdicts: 3,
      pending: 0,
      correct: 1,
      partial: 1,
      incorrect: 1,
      trustedCorrect: 1,
      trustedPartial: 1,
      trustedIncorrect: 0,
      unresolved: 0,
      void: 0,
      independentlyResolved: 2,
      independentRounds: 2,
      advisoryResolved: 1,
    });
    assert.equal(runtime.weightedResolvedEvidence, 1 + SOURCE_WEIGHT.human);
    assert.equal(runtime.weightedCorrectness, 1 + (0.5 * SOURCE_WEIGHT.human));
    assertNear(runtime.weightedAccuracy, 1.375 / 1.75);
    assertNear(runtime.reliability, 1.75 / MIN_INDEPENDENT_ROUNDS);
    assert.ok((runtime.score ?? 1) < (runtime.weightedAccuracy ?? 0));
    assert.equal(runtime.provisional, true);

    const ux = standing(events, "ux");
    assert.equal(ux.counts.claims, 1);
    assert.equal(ux.counts.correct, 1);
    assert.equal(ux.weightedResolvedEvidence, SOURCE_WEIGHT.peer);
    assert.equal(ux.score, null);
    assert.deepEqual(aggregate.overallStandings.map((row) => row.agentId), ["claude", "codex"]);
  });

  test("keeps unresolved and void verdicts in counts but out of every score", () => {
    const events: ScoreboardEvent[] = [
      claim("unresolved"),
      verdict("unresolved", "unresolved", "unresolved", "deterministic"),
      claim("void"),
      verdict("void", "void", "void", "human"),
    ];

    const row = standing(events);
    assert.equal(row.counts.unresolved, 1);
    assert.equal(row.counts.void, 1);
    assert.equal(row.counts.independentlyResolved, 0);
    assert.equal(row.counts.independentRounds, 0);
    assert.equal(row.weightedResolvedEvidence, 0);
    assert.equal(row.weightedCorrectness, 0);
    assert.equal(row.weightedAccuracy, null);
    assert.equal(row.reliability, null);
    assert.equal(row.score, null);
    assert.equal(row.provisional, true);
  });

  test("stores claimant confidence without rewarding it", () => {
    const lowConfidence: ScoreboardEvent[] = [
      claim("same", { confidence: 0 }),
      verdict("same", "same", "correct", "human"),
    ];
    const highConfidence: ScoreboardEvent[] = [
      { ...claim("same", { confidence: 1 }), eventId: "event-claim-same" },
      verdict("same", "same", "correct", "human"),
    ];

    assert.equal((lowConfidence[0] as ClaimRegisteredEvent).confidence, 0);
    assert.equal((highConfidence[0] as ClaimRegisteredEvent).confidence, 1);
    assert.deepEqual(standing(lowConfidence), standing(highConfidence));
  });

  test("remains provisional through four independent outcomes and matures at five", () => {
    const events: ScoreboardEvent[] = [];
    for (let index = 1; index <= MIN_INDEPENDENT_ROUNDS; index += 1) {
      events.push(claim(`maturity-${index}`));
      events.push(verdict(`maturity-${index}`, `maturity-${index}`, "correct"));
    }

    const atFour = standing(events.slice(0, 8));
    assert.equal(atFour.counts.independentlyResolved, 4);
    assert.equal(atFour.counts.independentRounds, 4);
    assert.equal(atFour.provisional, true);
    assertNear(atFour.reliability, 0.8);

    const atFive = standing(events);
    assert.equal(atFive.counts.independentlyResolved, 5);
    assert.equal(atFive.counts.independentRounds, 5);
    assert.equal(atFive.provisional, false);
    assertNear(atFive.reliability, 1);
  });

  test("penalizes losses during the provisional period", () => {
    const oneWin: ScoreboardEvent[] = [
      claim("only-win"),
      verdict("only-win", "only-win", "correct"),
    ];
    const oneWinFourLosses = [...oneWin];
    for (let index = 1; index <= 4; index += 1) {
      oneWinFourLosses.push(claim(`loss-${index}`));
      oneWinFourLosses.push(verdict(`loss-${index}`, `loss-${index}`, "incorrect"));
    }

    const winning = standing(oneWin);
    const losing = standing(oneWinFourLosses);
    assert.ok((winning.score ?? 0) > (losing.score ?? 0));
    assertNear(winning.score, 0.5);
    assert.ok((losing.score ?? 1) < 0.1);
  });

  test("caps maturity and score evidence to one contribution per round", () => {
    const events: ScoreboardEvent[] = [
      claim("split-a", { roundId: "round-shared" }),
      verdict("split-a", "split-a", "correct"),
      claim("split-b", { roundId: "round-shared" }),
      verdict("split-b", "split-b", "incorrect"),
      claim("next-round", { roundId: "round-next" }),
      verdict("next-round", "next-round", "correct", "human"),
    ];

    const row = standing(events);
    assert.equal(row.counts.independentlyResolved, 3);
    assert.equal(row.counts.independentRounds, 2);
    assertNear(row.weightedResolvedEvidence, 1.75);
    assertNear(row.weightedCorrectness, 1.25);
    assert.equal(row.provisional, true);
  });

  test("reverses by appending an event and permits a replacement verdict", () => {
    const registered = Object.freeze(claim("reversible"));
    const originalVerdict = Object.freeze(verdict("original", "reversible", "correct"));
    const originalLog = Object.freeze<readonly ScoreboardEvent[]>([registered, originalVerdict]);
    const before = aggregateScoreboard(originalLog);

    const reversal = Object.freeze({
      type: "verdictReversed" as const,
      eventId: "event-reverse-original",
      occurredAt: OCCURRED_AT,
      targetVerdictId: "original",
      reversedBy: "local-user",
      reason: "The deterministic fixture was stale.",
    });
    const reversedLog: readonly ScoreboardEvent[] = [...originalLog, reversal];
    const reversed = standing(reversedLog);

    assert.equal(originalVerdict.outcome, "correct");
    assert.equal(before.standings[0]?.counts.correct, 1);
    assert.equal(reversed.counts.verdictsRecorded, 1);
    assert.equal(reversed.counts.verdictsReversed, 1);
    assert.equal(reversed.counts.activeVerdicts, 0);
    assert.equal(reversed.counts.pending, 1);
    assert.equal(reversed.counts.correct, 0);
    assert.equal(reversed.weightedAccuracy, null);

    const replacementLog: readonly ScoreboardEvent[] = [
      ...reversedLog,
      verdict("replacement", "reversible", "incorrect", "human"),
    ];
    const replacement = standing(replacementLog);
    assert.equal(replacement.counts.verdictsRecorded, 2);
    assert.equal(replacement.counts.verdictsReversed, 1);
    assert.equal(replacement.counts.activeVerdicts, 1);
    assert.equal(replacement.counts.incorrect, 1);
    assert.equal(replacement.weightedAccuracy, 0);
    assert.equal(replacement.score, 0);
    assert.deepEqual(aggregateScoreboard(replacementLog), aggregateScoreboard(replacementLog));
  });

  test("lists only active claim and verdict evidence after reversals", () => {
    const activeClaim = claim("active-evidence");
    const activeVerdict = verdict("active-evidence", "active-evidence", "correct", "human");
    const reversedClaim = claim("reversed-evidence");
    const reversedVerdict = verdict("reversed-evidence", "reversed-evidence", "incorrect");
    const events: readonly ScoreboardEvent[] = [
      activeClaim,
      activeVerdict,
      reversedClaim,
      reversedVerdict,
      {
        type: "verdictReversed",
        eventId: "event-reverse-evidence",
        occurredAt: OCCURRED_AT,
        targetVerdictId: reversedVerdict.verdictId,
        reversedBy: "local-user",
        reason: "The evidence was superseded.",
      },
    ];

    assert.deepEqual(listActiveScoreEvidence(events), [{ claim: activeClaim, verdict: activeVerdict }]);
    assert.deepEqual(listPendingScoreClaims(events), [reversedClaim]);
    assert.deepEqual(listReversedScoreEvidence(events), [{
      claim: reversedClaim,
      verdict: reversedVerdict,
      reversal: events[4],
    }]);
  });

  test("requires a valid reversal actor", () => {
    const registered = claim("reversal-actor");
    const recorded = verdict("reversal-actor", "reversal-actor", "correct");
    const baseReversal = {
      type: "verdictReversed",
      eventId: "event-reversal-actor",
      occurredAt: OCCURRED_AT,
      targetVerdictId: recorded.verdictId,
      reason: "The evidence was invalidated.",
    };

    const missing = validateScoreboardEvents([registered, recorded, baseReversal]);
    assert.ok(missing.some((issue) => /reversedBy/.test(issue.message)));

    const invalid = validateScoreboardEvents([
      registered,
      recorded,
      { ...baseReversal, reversedBy: " local-user " },
    ]);
    assert.ok(invalid.some((issue) => /reversedBy/.test(issue.message)));
  });

  test("validates identities, references, confidence, and append order", () => {
    const baseClaim = claim("base");
    const baseVerdict = verdict("base", "base", "correct");
    const invalid: unknown[] = [
      { ...baseClaim, confidence: 1.1 },
      verdict("unknown-claim", "missing", "correct"),
      baseClaim,
      baseVerdict,
      { ...verdict("second-active", "base", "partial"), eventId: baseVerdict.eventId },
      {
        type: "verdictReversed",
        eventId: "event-reverse-missing",
        occurredAt: OCCURRED_AT,
        targetVerdictId: "missing",
        reversedBy: "local-user",
        reason: "No such verdict.",
      },
    ];

    const codes = validateScoreboardEvents(invalid).map((issue) => issue.code);
    assert.ok(codes.includes("invalidField"));
    assert.ok(codes.includes("unknownClaim"));
    assert.ok(codes.includes("duplicateEvent"));
    assert.ok(codes.includes("unknownVerdict"));
    assert.throws(
      () => aggregateScoreboard(invalid as ScoreboardEvent[]),
      (error: unknown) => error instanceof ScoreboardValidationError && error.issues.length >= 4,
    );

    const missingEvidence = validateScoreboardEvents([
      claim("missing-evidence"),
      { ...verdict("missing-evidence", "missing-evidence", "correct"), evidenceRef: "", rationale: "" },
    ]);
    assert.ok(missingEvidence.some((issue) => /evidenceRef/.test(issue.message)));
    assert.ok(missingEvidence.some((issue) => /rationale/.test(issue.message)));
  });

  test("rejects self-adjudicated peers, concurrent verdicts, and double reversals", () => {
    const selfPeer = validateScoreboardEvents([
      claim("self-peer"),
      verdict("self-peer", "self-peer", "correct", "peer", "codex"),
    ]);
    assert.ok(selfPeer.some((issue) => /differ from the claimant/.test(issue.message)));

    const concurrent = validateScoreboardEvents([
      claim("concurrent"),
      verdict("first", "concurrent", "correct"),
      verdict("second", "concurrent", "incorrect", "human"),
    ]);
    assert.ok(concurrent.some((issue) => issue.code === "activeVerdictExists"));

    const doubleReversal = validateScoreboardEvents([
      claim("double-reverse"),
      verdict("double-reverse", "double-reverse", "correct"),
      {
        type: "verdictReversed",
        eventId: "event-reverse-once",
        occurredAt: OCCURRED_AT,
        targetVerdictId: "double-reverse",
        reversedBy: "local-user",
        reason: "First reversal.",
      },
      {
        type: "verdictReversed",
        eventId: "event-reverse-twice",
        occurredAt: OCCURRED_AT,
        targetVerdictId: "double-reverse",
        reversedBy: "local-user",
        reason: "Second reversal.",
      },
    ]);
    assert.ok(doubleReversal.some((issue) => issue.code === "verdictAlreadyReversed"));
  });
});
