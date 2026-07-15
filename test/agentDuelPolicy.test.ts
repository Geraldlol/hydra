import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DUEL_AGENT_RATING_POLICY,
  DUEL_FULL_ACCESS_POLICY_ID,
  DUEL_RATING_POLICY,
  DuelAcceptanceRejectedError,
  DuelValidationError,
  aggregateDuels,
  createDuelAdmission,
  createDuelAcceptance,
  createDuelChallenge,
  createDuelCommitment,
  createDuelReveal,
  hashDuelAgentResponse,
  hashDuelSharedEvidencePacket,
  validateDuelEvents,
  type DuelChallengedEvent,
  type DuelEvent,
  type DuelResolvedEvent,
} from "../src/duels";

const base = Date.parse("2026-07-15T12:00:00.000Z");
const at = (minutes: number): string => new Date(base + minutes * 60_000).toISOString();

function agentChallenge(
  duelId: string,
  minute = 0,
  challengerId = "codex",
  challengedId = "claude",
): DuelChallengedEvent {
  const occurredAt = at(minute);
  return createDuelChallenge({
    eventId: `event-${duelId}-challenge`,
    occurredAt,
    duelId,
    challengerId,
    challengedId,
    domain: "runtime",
    proposition: `${duelId} performs exactly one durable write.`,
    evidenceContract: "Instrument the write function; exactly one call proves the proposition.",
    sharedEvidencePacket: JSON.stringify({ duelId, evidence: "host-bound transcript excerpt" }),
    adjudicatorType: "human",
    adjudicatorId: "local-user",
    createdBy: "hydra-runtime",
    initiation: {
      protocol: "agent-intent-v1",
      agentId: challengerId,
      sourceTraceId: `trace-${duelId}-source`,
      sourceMessageTimestamp: occurredAt,
      sourceMessageSha256: "a".repeat(64),
      disputedMessageTimestamp: at(Math.max(0, minute - 1)),
      workspaceFingerprintSha256: "b".repeat(64),
      capabilityLocks: [
        { agentId: challengerId, agentKind: challengerId === "claude" ? "claude" : "codex", profileSha256: "1".repeat(64) },
        { agentId: challengedId, agentKind: challengedId === "claude" ? "claude" : "codex", profileSha256: "2".repeat(64) },
      ],
    },
  });
}

function agentCommitment(
  challenge: DuelChallengedEvent,
  participantId: string,
  minute: number,
  workspaceFingerprintSha256: string,
  capabilityLockSha256 = challenge.initiation!.capabilityLocks.find((lock) => lock.agentId === participantId)!.profileSha256,
) {
  const commitmentId = `commitment-${challenge.duelId}-${participantId}`;
  const traceId = `trace-${challenge.duelId}-${participantId}`;
  const response = {
    duelId: challenge.duelId,
    participantId,
    commitmentId,
    answer: `${participantId} independently evaluated the locked workspace.`,
    confidence: 0.8,
  };
  return createDuelCommitment({
    eventId: `event-${challenge.duelId}-${participantId}-seal`,
    occurredAt: at(minute),
    duelId: challenge.duelId,
    commitmentId,
    participantId,
    captureType: "agent-call",
    captureRef: `agent-call:${traceId}`,
    agentReceipt: {
      traceId,
      agentId: participantId,
      agentKind: participantId === "claude" ? "claude" : "codex",
      transport: "oneShot",
      startedAt: at(minute),
      completedAt: at(minute + 1),
      promptSha256: "c".repeat(64),
      sharedEvidenceSha256: hashDuelSharedEvidencePacket(challenge.sharedEvidencePacket!),
      capabilityPolicy: DUEL_FULL_ACCESS_POLICY_ID,
      responseSha256: hashDuelAgentResponse(response),
      invocationSha256: "d".repeat(64),
      workspaceFingerprintSha256,
      capabilityLockSha256,
    },
    answer: response.answer,
    confidence: response.confidence,
    nonce: `nonce-${challenge.duelId}-${participantId}`,
  });
}

function legacyV2AgentCommitment(
  challenge: DuelChallengedEvent,
  participantId: string,
  minute: number,
) {
  const commitmentId = `commitment-${challenge.duelId}-${participantId}`;
  const traceId = `trace-${challenge.duelId}-${participantId}`;
  const response = {
    duelId: challenge.duelId,
    participantId,
    commitmentId,
    answer: `${participantId} supplied a historical v2 answer.`,
    confidence: 0.75,
  };
  return createDuelCommitment({
    eventId: `event-${challenge.duelId}-${participantId}-seal`,
    occurredAt: at(minute),
    duelId: challenge.duelId,
    commitmentId,
    participantId,
    captureType: "agent-call",
    captureRef: `agent-call:${traceId}`,
    agentReceipt: {
      traceId,
      agentId: participantId,
      agentKind: participantId === "claude" ? "claude" : "codex",
      transport: "oneShot",
      startedAt: at(minute),
      completedAt: at(minute + 1),
      promptSha256: "4".repeat(64),
      sharedEvidenceSha256: hashDuelSharedEvidencePacket(challenge.sharedEvidencePacket!),
      capabilityPolicy: DUEL_FULL_ACCESS_POLICY_ID,
      responseSha256: hashDuelAgentResponse(response),
      invocationSha256: "5".repeat(64),
    },
    answer: response.answer,
    confidence: response.confidence,
    nonce: `nonce-${challenge.duelId}-${participantId}`,
  });
}

describe("agent-initiated duel policy", () => {
  test("records v3 provenance and Hydra policy admission without claiming head consent", () => {
    const challenge = agentChallenge("duel-agent");
    const admission = createDuelAdmission([challenge], {
      eventId: "event-duel-agent-admit",
      occurredAt: at(1),
      duelId: challenge.duelId,
    });
    assert.equal(challenge.ratingPolicy, DUEL_AGENT_RATING_POLICY);
    assert.equal(challenge.createdBy, "hydra-runtime");
    assert.equal(admission.admittedBy, "hydra-runtime");
    assert.equal(admission.capabilityPolicy, DUEL_FULL_ACCESS_POLICY_ID);
    assert.equal("acceptedBy" in admission, false);
    assert.deepEqual(validateDuelEvents([challenge, admission]), []);
    const view = aggregateDuels([challenge, admission]).activeDuels[0]!;
    assert.equal(view.status, "awaiting_commitments");
    assert.equal(view.createdBy, "hydra-runtime");
    assert.equal(view.rated, true);
  });

  test("rejects forged or missing runtime initiation provenance", () => {
    const valid = agentChallenge("duel-forged");
    const missing = { ...valid, initiation: undefined };
    const wrongAgent = { ...valid, initiation: { ...valid.initiation!, agentId: "claude" } };
    assert.ok(validateDuelEvents([missing]).some((issue) => issue.message.includes("agent-intent-v1")));
    assert.ok(validateDuelEvents([wrongAgent]).some((issue) => issue.message.includes("agent-intent-v1")));
  });

  test("accepts v3 receipts only when both bind the exact admission workspace fingerprint", () => {
    const challenge = agentChallenge("duel-workspace-binding");
    const admitted = createDuelAdmission([challenge], {
      eventId: "event-duel-workspace-binding-admit",
      occurredAt: at(1),
      duelId: challenge.duelId,
    });
    const fingerprint = challenge.initiation!.workspaceFingerprintSha256;
    const codex = agentCommitment(challenge, challenge.challengerId, 2, fingerprint);
    const claude = agentCommitment(challenge, challenge.challengedId, 3, fingerprint);
    const matchingEvents: DuelEvent[] = [challenge, admitted, codex.event, claude.event];

    assert.equal(codex.event.agentReceipt?.workspaceFingerprintSha256, fingerprint);
    assert.equal(claude.event.agentReceipt?.workspaceFingerprintSha256, fingerprint);
    assert.deepEqual(validateDuelEvents(matchingEvents), []);
    assert.equal(aggregateDuels(matchingEvents).activeDuels[0]?.status, "awaiting_reveal");

    const mismatched = agentCommitment(challenge, challenge.challengerId, 2, "e".repeat(64));
    const mismatchedEvents: DuelEvent[] = [challenge, admitted, mismatched.event];
    const issues = validateDuelEvents(mismatchedEvents);
    assert.ok(issues.some((issue) =>
      issue.code === "hashMismatch" && /exact workspace fingerprint locked at admission/.test(issue.message)
    ));
    assert.throws(
      () => aggregateDuels(mismatchedEvents),
      (error: unknown) => error instanceof DuelValidationError
        && error.issues.some((issue) => /exact workspace fingerprint locked at admission/.test(issue.message)),
    );
  });

  test("binds the sealed commitment hash to the admission workspace fingerprint", () => {
    const challenge = agentChallenge("duel-workspace-hash");
    const first = agentCommitment(challenge, challenge.challengerId, 2, "b".repeat(64));
    const second = agentCommitment(challenge, challenge.challengerId, 2, "e".repeat(64));

    assert.notEqual(first.event.commitmentHash, second.event.commitmentHash);
  });

  test("rejects a v3 receipt whose participant capability lock differs from admission", () => {
    const challenge = agentChallenge("duel-capability-binding");
    const admitted = createDuelAdmission([challenge], {
      eventId: "event-duel-capability-binding-admit",
      occurredAt: at(1),
      duelId: challenge.duelId,
    });
    const mismatched = agentCommitment(
      challenge,
      challenge.challengerId,
      2,
      challenge.initiation!.workspaceFingerprintSha256,
      "f".repeat(64),
    );
    const issues = validateDuelEvents([challenge, admitted, mismatched.event]);

    assert.ok(issues.some((issue) =>
      issue.code === "hashMismatch" && /participant's exact admission capability lock/.test(issue.message)
    ));
    assert.throws(
      () => aggregateDuels([challenge, admitted, mismatched.event]),
      (error: unknown) => error instanceof DuelValidationError
        && error.issues.some((issue) => /participant's exact admission capability lock/.test(issue.message)),
    );
  });

  test("keeps a resolved rated v2 duel in history without granting current rating or crown", () => {
    const challenge = createDuelChallenge({
      eventId: "event-duel-v2-history-challenge",
      occurredAt: at(0),
      duelId: "duel-v2-history",
      challengerId: "codex",
      challengedId: "claude",
      domain: "runtime",
      proposition: "A historical v2 proposition was judged correct.",
      evidenceContract: "The local judge checks the locked packet.",
      sharedEvidencePacket: "A bounded historical v2 evidence packet.",
      adjudicatorType: "human",
      adjudicatorId: "local-user",
    });
    const events: DuelEvent[] = [challenge];
    events.push(createDuelAcceptance(events, {
      eventId: "event-duel-v2-history-accept",
      occurredAt: at(1),
      duelId: challenge.duelId,
    }));
    const codex = legacyV2AgentCommitment(challenge, "codex", 2);
    const claude = legacyV2AgentCommitment(challenge, "claude", 3);
    events.push(codex.event, claude.event);
    events.push(createDuelReveal(events, {
      eventId: "event-duel-v2-history-reveal",
      occurredAt: at(4),
      duelId: challenge.duelId,
      payloads: [codex.payload, claude.payload],
    }));
    const resolution: DuelResolvedEvent = {
      type: "duelResolved",
      eventId: "event-duel-v2-history-resolution",
      occurredAt: at(5),
      duelId: challenge.duelId,
      resolutionId: "resolution-duel-v2-history",
      outcome: "challengerWin",
      adjudicatorType: "human",
      adjudicatorId: "local-user",
      evidenceRef: "evidence:duel-v2-history",
      rationale: "The historical judge favored Codex.",
      recordedBy: "local-user",
    };
    events.push(resolution);

    assert.equal(challenge.ratingPolicy, DUEL_RATING_POLICY);
    assert.deepEqual(validateDuelEvents(events), []);
    const aggregate = aggregateDuels(events);
    assert.equal(aggregate.recentDuels[0]?.status, "resolved");
    assert.deepEqual(aggregate.recentDuels[0]?.resolution?.ratingDeltas, {});
    assert.deepEqual(aggregate.ratings, []);
    assert.equal(aggregate.ratings[0], undefined);
  });

  test("does not let a legacy operator reservation constrain autonomous v3 admission", () => {
    const legacy = createDuelChallenge({
      eventId: "event-legacy-reservation-challenge",
      occurredAt: at(0),
      duelId: "legacy-reservation",
      challengerId: "codex",
      challengedId: "claude",
      domain: "runtime",
      proposition: "The shared proposition is true.",
      evidenceContract: "A human checks the historical packet.",
      sharedEvidencePacket: "Historical packet.",
      adjudicatorType: "human",
      adjudicatorId: "local-user",
    });
    const events: DuelEvent[] = [legacy];
    events.push(createDuelAcceptance(events, {
      eventId: "event-legacy-reservation-accept",
      occurredAt: at(1),
      duelId: legacy.duelId,
    }));
    const current = agentChallenge("autonomous-after-legacy", 2);
    const admitted = createDuelAdmission([...events, current], {
      eventId: "event-autonomous-after-legacy-admit",
      occurredAt: at(3),
      duelId: current.duelId,
    });
    assert.equal(admitted.type, "duelAdmitted");
    assert.deepEqual(admitted.eligibilityReasons, []);
  });

  test("requires Hydra runtime to publish a v3 paired reveal", () => {
    const challenge = agentChallenge("runtime-reveal-only");
    const admitted = createDuelAdmission([challenge], {
      eventId: "event-runtime-reveal-only-admit",
      occurredAt: at(1),
      duelId: challenge.duelId,
    });
    const fingerprint = challenge.initiation!.workspaceFingerprintSha256;
    const codex = agentCommitment(challenge, challenge.challengerId, 2, fingerprint);
    const claude = agentCommitment(challenge, challenge.challengedId, 3, fingerprint);
    const events: DuelEvent[] = [challenge, admitted, codex.event, claude.event];
    assert.throws(
      () => createDuelReveal(events, {
        eventId: "event-runtime-reveal-only-local",
        occurredAt: at(4),
        duelId: challenge.duelId,
        payloads: [codex.payload, claude.payload],
        recordedBy: "local-user",
      }),
      (error: unknown) => error instanceof DuelValidationError
        && error.issues.some((issue) => /recorder does not match/.test(issue.message)),
    );
  });

  test("does not admit a second unresolved autonomous duel for either head", () => {
    const first = agentChallenge("duel-first");
    const admitted = createDuelAdmission([first], {
      eventId: "event-duel-first-admit",
      occurredAt: at(1),
      duelId: first.duelId,
    });
    const second = agentChallenge("duel-second", 120, "codex", "gamma");
    assert.throws(
      () => createDuelAdmission([first, admitted, second] as DuelEvent[], {
        eventId: "event-duel-second-admit",
        occurredAt: at(121),
        duelId: second.duelId,
      }),
      (error: unknown) => error instanceof DuelAcceptanceRejectedError && error.reasons.includes("head-active-duel"),
    );
  });

  test("allows Hydra to cancel only its own v3 duel when integrity fails", () => {
    const challenge = agentChallenge("duel-integrity");
    const admitted = createDuelAdmission([challenge], {
      eventId: "event-duel-integrity-admit",
      occurredAt: at(1),
      duelId: challenge.duelId,
    });
    const cancelled: DuelEvent = {
      type: "duelCancelled",
      eventId: "event-duel-integrity-cancel",
      occurredAt: at(2),
      duelId: challenge.duelId,
      cancelledBy: "hydra-runtime",
      reason: "The workspace fingerprint changed between commitments.",
    };
    assert.deepEqual(validateDuelEvents([challenge, admitted, cancelled]), []);
    assert.equal(aggregateDuels([challenge, admitted, cancelled]).activeDuels.length, 0);

    const operatorChallenge = createDuelChallenge({
      eventId: "event-operator-challenge",
      occurredAt: at(3),
      duelId: "duel-operator",
      challengerId: "codex",
      challengedId: "claude",
      domain: "runtime",
      proposition: "A legacy operator proposition.",
      evidenceContract: "Review the evidence.",
      sharedEvidencePacket: "evidence",
      adjudicatorType: "human",
      adjudicatorId: "local-user",
    });
    const forgedRuntimeCancellation: DuelEvent = {
      ...cancelled,
      eventId: "event-operator-forged-cancel",
      occurredAt: at(4),
      duelId: operatorChallenge.duelId,
    };
    assert.ok(validateDuelEvents([operatorChallenge, forgedRuntimeCancellation])
      .some((issue) => issue.message.includes("Hydra integrity policy")));
  });
});
