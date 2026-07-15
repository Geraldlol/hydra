import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DUEL_MAX_SHARED_EVIDENCE_PACKET_BYTES,
  DUEL_INITIAL_RATING,
  DUEL_FULL_ACCESS_POLICY_ID,
  DUEL_LEGACY_RATING_POLICY,
  DuelAcceptanceRejectedError,
  DuelValidationError,
  aggregateDuels,
  createDuelAdmission,
  createDuelAcceptance,
  createDuelChallenge,
  createDuelCommitment,
  createDuelReveal,
  duelPropositionFingerprint,
  hashDuelAgentResponse,
  hashDuelSharedEvidencePacket,
  parseDuelAgentCommitmentResponse,
  validateDuelEvents,
  type CreateDuelChallengeInput,
  type DuelAgentCallReceipt,
  type DuelChallengedEvent,
  type DuelCommitmentsRevealedEvent,
  type DuelEvent,
  type DuelOutcome,
  type DuelRating,
  type DuelResolutionReversedEvent,
  type DuelResolvedEvent,
  type DuelRevealPayload,
} from "../src/duels";

const EPOCH_MS = Date.parse("2026-01-01T00:00:00.000Z");

function at(day: number, minute = 0): string {
  return new Date(EPOCH_MS + day * 24 * 60 * 60 * 1_000 + minute * 60 * 1_000).toISOString();
}

function agentReceipt(
  agentId: string,
  traceId: string,
  response: { duelId: string; commitmentId: string; answer: string; confidence: number },
): DuelAgentCallReceipt {
  return {
    traceId,
    agentId,
    agentKind: agentId === "beta" || agentId === "claude" ? "claude" : "codex",
    transport: "oneShot",
    startedAt: at(0),
    completedAt: at(0, 1),
    promptSha256: "1".repeat(64),
    sharedEvidenceSha256: hashDuelSharedEvidencePacket(`Shared evidence packet for ${response.duelId}: both heads receive this exact bounded context before committing.`),
    capabilityPolicy: DUEL_FULL_ACCESS_POLICY_ID,
    responseSha256: hashDuelAgentResponse({ participantId: agentId, ...response }),
    invocationSha256: "3".repeat(64),
    workspaceFingerprintSha256: "b".repeat(64),
    capabilityLockSha256: capabilityLockForAgent(agentId),
  };
}

function capabilityLockForAgent(agentId: string): string {
  return duelPropositionFingerprint(`capability-lock:${agentId}`);
}

interface ChallengeOptions {
  challengerId?: string;
  challengedId?: string;
  domain?: string;
  proposition?: string;
  evidenceContract?: string;
  sharedEvidencePacket?: string;
  adjudicatorType?: "deterministic" | "human";
  adjudicatorId?: string;
}

function challenge(id: string, day = 0, options: ChallengeOptions = {}): DuelChallengedEvent {
  const input: CreateDuelChallengeInput = {
    eventId: `event-${id}-challenge`,
    occurredAt: at(day),
    duelId: id,
    challengerId: options.challengerId ?? "alpha",
    challengedId: options.challengedId ?? "beta",
    domain: options.domain ?? "runtime",
    proposition: options.proposition ?? `Proposition ${id} is established by the agreed evidence.`,
    evidenceContract: options.evidenceContract ?? `The identified human judge applies the locked evidence contract for ${id}.`,
    sharedEvidencePacket: options.sharedEvidencePacket ?? `Shared evidence packet for ${id}: both heads receive this exact bounded context before committing.`,
    adjudicatorType: options.adjudicatorType ?? "human",
    adjudicatorId: options.adjudicatorId ?? "human-judge",
  };
  return createDuelChallenge(input);
}

function agentChallenge(id: string, day = 0, options: ChallengeOptions = {}): DuelChallengedEvent {
  const challengerId = options.challengerId ?? "alpha";
  const challengedId = options.challengedId ?? "beta";
  const occurredAt = at(day);
  return createDuelChallenge({
    eventId: `event-${id}-challenge`,
    occurredAt,
    duelId: id,
    challengerId,
    challengedId,
    domain: options.domain ?? "runtime",
    proposition: options.proposition ?? `Proposition ${id} is established by the agreed evidence.`,
    evidenceContract: options.evidenceContract ?? `The identified human judge applies the locked evidence contract for ${id}.`,
    sharedEvidencePacket: options.sharedEvidencePacket ?? `Shared evidence packet for ${id}: both heads receive this exact bounded context before committing.`,
    adjudicatorType: options.adjudicatorType ?? "human",
    adjudicatorId: options.adjudicatorId ?? "human-judge",
    createdBy: "hydra-runtime",
    initiation: {
      protocol: "agent-intent-v1",
      agentId: challengerId,
      sourceTraceId: `trace-${id}-source`,
      sourceMessageTimestamp: occurredAt,
      sourceMessageSha256: "a".repeat(64),
      disputedMessageTimestamp: occurredAt,
      workspaceFingerprintSha256: "b".repeat(64),
      capabilityLocks: [
        { agentId: challengerId, agentKind: challengerId === "beta" ? "claude" : "codex", profileSha256: capabilityLockForAgent(challengerId) },
        { agentId: challengedId, agentKind: challengedId === "beta" ? "claude" : "codex", profileSha256: capabilityLockForAgent(challengedId) },
      ],
    },
  });
}

function legacyChallenge(id: string, day = 0, options: ChallengeOptions = {}): DuelChallengedEvent {
  return { ...challenge(id, day, options), ratingPolicy: DUEL_LEGACY_RATING_POLICY };
}

function legacyExhibitionAcceptance(
  duel: DuelChallengedEvent,
  day = 0,
  reasons: readonly ["voluntary-exhibition"] = ["voluntary-exhibition"],
): DuelEvent {
  return {
    type: "duelAccepted",
    eventId: `event-${duel.duelId}-accept`,
    occurredAt: at(day, 1),
    duelId: duel.duelId,
    acceptedBy: duel.challengedId,
    recordedBy: "local-user",
    ratingClass: "exhibition",
    eligibilityReasons: reasons,
  };
}

function resolution(
  duel: DuelChallengedEvent,
  outcome: DuelOutcome,
  day: number,
  suffix = "result",
): DuelResolvedEvent {
  return {
    type: "duelResolved",
    eventId: `event-${duel.duelId}-${suffix}`,
    occurredAt: at(day, 5),
    duelId: duel.duelId,
    resolutionId: `resolution-${duel.duelId}-${suffix}`,
    outcome,
    adjudicatorType: duel.adjudicatorType,
    adjudicatorId: duel.adjudicatorId,
    evidenceRef: `evidence:${duel.duelId}:${suffix}`,
    rationale: `The locked evidence contract supports ${outcome}.`,
    recordedBy: "local-user",
  };
}

interface AddedDuel {
  challenge: DuelChallengedEvent;
  challengerPayload: DuelRevealPayload;
  challengedPayload: DuelRevealPayload;
  resolution?: DuelResolvedEvent;
}

function addAcceptedDuel(
  events: DuelEvent[],
  id: string,
  day: number,
  options: ChallengeOptions = {},
): { challenge: DuelChallengedEvent } {
  const created = agentChallenge(id, day, options);
  events.push(created);
  events.push(createDuelAdmission(events, {
    eventId: `event-${id}-admit`,
    occurredAt: at(day, 1),
    duelId: id,
  }));
  return { challenge: created };
}

function addPreparedDuel(
  events: DuelEvent[],
  id: string,
  day: number,
  options: ChallengeOptions = {},
): AddedDuel {
  const { challenge: created } = addAcceptedDuel(events, id, day, options);
  const challenger = createDuelCommitment({
    eventId: `event-${id}-seal-challenger`,
    occurredAt: at(day, 2),
    duelId: id,
    commitmentId: `commitment-${id}-challenger`,
    participantId: created.challengerId,
    captureType: "agent-call",
    captureRef: `agent-call:trace-${id}-challenger`,
    agentReceipt: agentReceipt(created.challengerId, `trace-${id}-challenger`, {
      duelId: id,
      commitmentId: `commitment-${id}-challenger`,
      answer: `Answer from ${created.challengerId} for ${id}`,
      confidence: 0.7,
    }),
    answer: `Answer from ${created.challengerId} for ${id}`,
    confidence: 0.7,
    nonce: `nonce-${id}-challenger`,
  });
  const challenged = createDuelCommitment({
    eventId: `event-${id}-seal-challenged`,
    occurredAt: at(day, 3),
    duelId: id,
    commitmentId: `commitment-${id}-challenged`,
    participantId: created.challengedId,
    captureType: "agent-call",
    captureRef: `agent-call:trace-${id}-challenged`,
    agentReceipt: agentReceipt(created.challengedId, `trace-${id}-challenged`, {
      duelId: id,
      commitmentId: `commitment-${id}-challenged`,
      answer: `Answer from ${created.challengedId} for ${id}`,
      confidence: 0.6,
    }),
    answer: `Answer from ${created.challengedId} for ${id}`,
    confidence: 0.6,
    nonce: `nonce-${id}-challenged`,
  });
  events.push(challenger.event, challenged.event);
  events.push(createDuelReveal(events, {
    eventId: `event-${id}-reveal`,
    occurredAt: at(day, 4),
    duelId: id,
    payloads: [challenger.payload, challenged.payload],
    recordedBy: "hydra-runtime",
  }));
  return {
    challenge: created,
    challengerPayload: challenger.payload,
    challengedPayload: challenged.payload,
  };
}

function addResolvedDuel(
  events: DuelEvent[],
  id: string,
  day: number,
  outcome: DuelOutcome,
  options: ChallengeOptions = {},
): AddedDuel {
  const prepared = addPreparedDuel(events, id, day, options);
  const result = resolution(prepared.challenge, outcome, day);
  events.push(result);
  return { ...prepared, resolution: result };
}

function addLegacyExhibitionResolvedDuel(
  events: DuelEvent[],
  id: string,
  day: number,
  outcome: DuelOutcome,
  options: ChallengeOptions = {},
): AddedDuel {
  const created = legacyChallenge(id, day, options);
  events.push(created, legacyExhibitionAcceptance(created, day));
  const challenger = createDuelCommitment({
    eventId: `event-${id}-seal-challenger`,
    occurredAt: at(day, 2),
    duelId: id,
    commitmentId: `commitment-${id}-challenger`,
    participantId: created.challengerId,
    captureType: "operator",
    captureRef: "operator:local-user",
    answer: `Legacy operator answer for ${created.challengerId}`,
    confidence: 0.5,
    nonce: `nonce-${id}-challenger`,
  });
  const challenged = createDuelCommitment({
    eventId: `event-${id}-seal-challenged`,
    occurredAt: at(day, 3),
    duelId: id,
    commitmentId: `commitment-${id}-challenged`,
    participantId: created.challengedId,
    captureType: "operator",
    captureRef: "operator:local-user",
    answer: `Legacy operator answer for ${created.challengedId}`,
    confidence: 0.5,
    nonce: `nonce-${id}-challenged`,
  });
  events.push(challenger.event, challenged.event);
  events.push(createDuelReveal(events, {
    eventId: `event-${id}-reveal`,
    occurredAt: at(day, 4),
    duelId: id,
    payloads: [challenger.payload, challenged.payload],
  }));
  const result = resolution(created, outcome, day);
  events.push(result);
  return {
    challenge: created,
    challengerPayload: challenger.payload,
    challengedPayload: challenged.payload,
    resolution: result,
  };
}

function rating(
  events: readonly DuelEvent[],
  agentId: string,
  domain = "runtime",
): DuelRating {
  const row = aggregateDuels(events).ratings.find((candidate) =>
    candidate.agentId === agentId && candidate.domain === domain
  );
  assert.ok(row, `missing ${domain} rating for ${agentId}`);
  return row;
}

function ratingsSnapshot(events: readonly DuelEvent[]): string[] {
  return aggregateDuels(events).ratings.map((row) =>
    `${row.domain}:${row.agentId}:${row.rating}:${row.wins}:${row.draws}:${row.losses}:${row.ratedMatches}`
  );
}

describe("formal duel state and public commitment boundary", () => {
  test("advances through challenge, acceptance, paired seals, reveal, and resolution", () => {
    const events: DuelEvent[] = [];
    const created = agentChallenge("happy");
    events.push(created);

    let aggregate = aggregateDuels(events);
    assert.equal(aggregate.eventCount, 1);
    assert.equal(aggregate.activeDuels[0]?.status, "awaiting_acceptance");
    assert.equal(aggregate.activeDuels[0]?.rated, false);
    assert.equal(aggregate.activeDuels[0]?.commitmentCount, 0);

    events.push(createDuelAdmission(events, {
      eventId: "event-happy-admit",
      occurredAt: at(0, 1),
      duelId: "happy",
    }));
    assert.equal(aggregateDuels(events).activeDuels[0]?.status, "awaiting_commitments");
    assert.equal(aggregateDuels(events).activeDuels[0]?.rated, true);

    const first = createDuelCommitment({
      eventId: "event-happy-seal-alpha",
      occurredAt: at(0, 2),
      duelId: "happy",
      commitmentId: "commitment-happy-alpha",
      participantId: "alpha",
      captureType: "agent-call",
      captureRef: "agent-call:trace-happy-alpha",
      agentReceipt: agentReceipt("alpha", "trace-happy-alpha", {
        duelId: "happy", commitmentId: "commitment-happy-alpha", answer: "Alpha predicts the command exits zero.", confidence: 0.8,
      }),
      answer: "Alpha predicts the command exits zero.",
      confidence: 0.8,
      nonce: "nonce-happy-alpha",
    });
    const second = createDuelCommitment({
      eventId: "event-happy-seal-beta",
      occurredAt: at(0, 3),
      duelId: "happy",
      commitmentId: "commitment-happy-beta",
      participantId: "beta",
      captureType: "agent-call",
      captureRef: "agent-call:trace-happy-beta",
      agentReceipt: agentReceipt("beta", "trace-happy-beta", {
        duelId: "happy", commitmentId: "commitment-happy-beta", answer: "Beta predicts a non-zero exit.", confidence: 0.65,
      }),
      answer: "Beta predicts a non-zero exit.",
      confidence: 0.65,
      nonce: "nonce-happy-beta",
    });
    events.push(first.event, second.event);
    aggregate = aggregateDuels(events);
    assert.equal(aggregate.activeDuels[0]?.status, "awaiting_reveal");
    assert.equal(aggregate.activeDuels[0]?.commitmentCount, 2);
    assert.equal(aggregate.activeDuels[0]?.commitments, undefined);

    events.push(createDuelReveal(events, {
      eventId: "event-happy-reveal",
      occurredAt: at(0, 4),
      duelId: "happy",
      payloads: [first.payload, second.payload],
      recordedBy: "hydra-runtime",
    }));
    aggregate = aggregateDuels(events);
    assert.equal(aggregate.activeDuels[0]?.status, "awaiting_adjudication");
    assert.deepEqual(aggregate.activeDuels[0]?.commitments, [
      { agentId: "alpha", captureType: "agent-call", captureRef: "agent-call:trace-happy-alpha", agentReceipt: first.payload.agentReceipt, answer: first.payload.answer, confidence: 0.8 },
      { agentId: "beta", captureType: "agent-call", captureRef: "agent-call:trace-happy-beta", agentReceipt: second.payload.agentReceipt, answer: second.payload.answer, confidence: 0.65 },
    ]);

    events.push(resolution(created, "challengerWin", 0));
    aggregate = aggregateDuels(events);
    assert.equal(aggregate.activeDuels.length, 0);
    assert.equal(aggregate.recentDuels[0]?.status, "resolved");
    assert.equal(aggregate.recentDuels[0]?.resolution?.winnerId, "alpha");
    assert.deepEqual(aggregate.recentDuels[0]?.resolution?.ratingDeltas, { alpha: 12, beta: -12 });
    assert.equal(rating(events, "alpha").rating, 1012);
    assert.equal(rating(events, "beta").rating, 988);
  });

  test("locks one bounded shared evidence packet into every newly created challenge and public view", () => {
    const sharedEvidencePacket = "Fixture: verification receipt abc123. Both heads must reason from this exact packet.";
    const created = challenge("shared-evidence", 0, { sharedEvidencePacket });
    assert.equal(created.sharedEvidencePacket, sharedEvidencePacket);
    assert.equal(validateDuelEvents([created]).length, 0);

    const acceptance = createDuelAcceptance([created], {
      eventId: "event-shared-evidence-accept",
      occurredAt: at(0, 1),
      duelId: created.duelId,
    });
    assert.equal(acceptance.ratingClass, "rated");
    assert.deepEqual(acceptance.eligibilityReasons, []);
    assert.equal(acceptance.capabilityPolicy, DUEL_FULL_ACCESS_POLICY_ID);

    const view = aggregateDuels([created, acceptance]).activeDuels[0];
    assert.equal(view?.sharedEvidencePacket, sharedEvidencePacket);
    assert.equal(view?.rated, true);
    assert.equal(view?.capabilityPolicy, DUEL_FULL_ACCESS_POLICY_ID);

    const forgedExhibition: DuelEvent = {
      ...acceptance,
      eventId: "event-shared-evidence-forged-exhibition",
      ratingClass: "exhibition",
      eligibilityReasons: ["voluntary-exhibition"],
    };
    assert.ok(validateDuelEvents([created, forgedExhibition]).some((issue) =>
      /must be rated under the locked full-access capability policy/.test(issue.message)
    ));
  });

  test("keeps packetless elo-v1 history replay-valid but rejects a new rated acceptance", () => {
    const modern = legacyChallenge("legacy-packetless");
    const { sharedEvidencePacket, ...legacyFields } = modern;
    assert.ok(sharedEvidencePacket);
    const legacy: DuelChallengedEvent = legacyFields;
    const historicalRatedAcceptance: DuelEvent = {
      type: "duelAccepted",
      eventId: "event-legacy-packetless-accept",
      occurredAt: at(0, 1),
      duelId: legacy.duelId,
      acceptedBy: legacy.challengedId,
      recordedBy: "local-user",
      ratingClass: "rated",
      eligibilityReasons: [],
    };

    assert.equal(validateDuelEvents([legacy, historicalRatedAcceptance]).length, 0);
    const legacyView = aggregateDuels([legacy, historicalRatedAcceptance]).activeDuels[0];
    assert.equal(legacyView?.sharedEvidencePacket, undefined);
    assert.equal(legacyView?.rated, false);
    assert.match(legacyView?.ratingIneligibilityReason ?? "", /same bounded evidence packet for both heads/i);

    assert.throws(
      () => createDuelAcceptance([legacy], {
        eventId: "event-legacy-packetless-new-accept",
        occurredAt: at(0, 1),
        duelId: legacy.duelId,
      }),
      (error: unknown) => error instanceof DuelAcceptanceRejectedError
        && error.reasons.includes("missing-shared-evidence"),
    );
  });

  test("rejects empty and oversized shared evidence packets by UTF-8 bytes", () => {
    const exact = challenge("shared-evidence-exact", 0, {
      sharedEvidencePacket: "x".repeat(DUEL_MAX_SHARED_EVIDENCE_PACKET_BYTES),
    });
    assert.equal(validateDuelEvents([exact]).length, 0);

    const empty = challenge("shared-evidence-empty", 0, { sharedEvidencePacket: " " });
    assert.ok(validateDuelEvents([empty]).some((issue) => /sharedEvidencePacket/.test(issue.message)));

    const oversizedAscii = challenge("shared-evidence-ascii", 0, {
      sharedEvidencePacket: "x".repeat(DUEL_MAX_SHARED_EVIDENCE_PACKET_BYTES + 1),
    });
    assert.ok(validateDuelEvents([oversizedAscii]).some((issue) => /sharedEvidencePacket/.test(issue.message)));

    const oversizedUtf8 = challenge("shared-evidence-utf8", 0, {
      sharedEvidencePacket: "é".repeat((DUEL_MAX_SHARED_EVIDENCE_PACKET_BYTES / 2) + 1),
    });
    assert.ok(validateDuelEvents([oversizedUtf8]).some((issue) => /sharedEvidencePacket/.test(issue.message)));
  });

  test("never exposes one commitment or either plaintext answer before paired reveal", () => {
    const events: DuelEvent[] = [];
    const { challenge: created } = addAcceptedDuel(events, "redaction", 0);
    const first = createDuelCommitment({
      eventId: "event-redaction-first",
      occurredAt: at(0, 2),
      duelId: "redaction",
      commitmentId: "commitment-redaction-first",
      participantId: created.challengerId,
      captureType: "agent-call",
      captureRef: "agent-call:trace-redaction-first",
      agentReceipt: agentReceipt(created.challengerId, "trace-redaction-first", {
        duelId: "redaction", commitmentId: "commitment-redaction-first", answer: "This plaintext must remain sealed.", confidence: 0.9,
      }),
      answer: "This plaintext must remain sealed.",
      confidence: 0.9,
      nonce: "nonce-redaction-first",
    });
    events.push(first.event);

    const afterOne = aggregateDuels(events).activeDuels[0];
    assert.equal(afterOne?.commitmentCount, 1);
    assert.equal(afterOne?.commitments, undefined);
    assert.doesNotMatch(JSON.stringify(afterOne), /This plaintext must remain sealed/);

    const second = createDuelCommitment({
      eventId: "event-redaction-second",
      occurredAt: at(0, 3),
      duelId: "redaction",
      commitmentId: "commitment-redaction-second",
      participantId: created.challengedId,
      captureType: "agent-call",
      captureRef: "agent-call:trace-redaction-second",
      agentReceipt: agentReceipt(created.challengedId, "trace-redaction-second", {
        duelId: "redaction", commitmentId: "commitment-redaction-second", answer: "The second plaintext is also hidden.", confidence: 0.4,
      }),
      answer: "The second plaintext is also hidden.",
      confidence: 0.4,
      nonce: "nonce-redaction-second",
    });
    events.push(second.event);
    const afterTwo = aggregateDuels(events).activeDuels[0];
    assert.equal(afterTwo?.commitmentCount, 2);
    assert.equal(afterTwo?.commitments, undefined);
    assert.doesNotMatch(JSON.stringify(afterTwo), /plaintext/);
  });

  test("requires exactly two canonically ordered reveal payloads whose hashes match", () => {
    const events: DuelEvent[] = [];
    const prepared = addPreparedDuel(events, "hashes", 0);
    const validReveal = events.pop();
    assert.equal(validReveal?.type, "duelCommitmentsRevealed");

    const tampered: DuelCommitmentsRevealedEvent = {
      ...(validReveal as DuelCommitmentsRevealedEvent),
      eventId: "event-hashes-tampered",
      payloads: [
        { ...prepared.challengerPayload, answer: "Tampered after sealing" },
        prepared.challengedPayload,
      ],
    };
    const mismatch = validateDuelEvents([...events, tampered]);
    assert.ok(mismatch.some((issue) => issue.code === "hashMismatch"));
    assert.throws(
      () => createDuelReveal(events, {
        eventId: "event-hashes-helper-tampered",
        occurredAt: at(0, 4),
        duelId: "hashes",
        payloads: tampered.payloads,
      }),
      (error: unknown) => error instanceof DuelValidationError
        && error.issues.some((issue) => issue.code === "hashMismatch"),
    );

    const swapped: DuelCommitmentsRevealedEvent = {
      ...(validReveal as DuelCommitmentsRevealedEvent),
      eventId: "event-hashes-swapped",
      payloads: [prepared.challengedPayload, prepared.challengerPayload],
    };
    assert.ok(validateDuelEvents([...events, swapped]).some((issue) =>
      issue.code === "invalidField" && /canonical order/.test(issue.message)
    ));

    const onePayload = {
      ...(validReveal as DuelCommitmentsRevealedEvent),
      eventId: "event-hashes-one",
      payloads: [prepared.challengerPayload],
    };
    assert.ok(validateDuelEvents([...events, onePayload]).some((issue) =>
      /exactly two payloads/.test(issue.message)
    ));
  });

  test("requires actual head-call provenance and full-access binding while preserving legacy exhibitions", () => {
    const ratedEvents: DuelEvent[] = [];
    addAcceptedDuel(ratedEvents, "rated-provenance", 0);
    const manualRated = createDuelCommitment({
      eventId: "event-rated-provenance-seal",
      occurredAt: at(0, 2),
      duelId: "rated-provenance",
      commitmentId: "commitment-rated-provenance",
      participantId: "alpha",
      captureType: "operator",
      captureRef: "operator:local-user",
      answer: "An operator typed this answer.",
      confidence: 0.5,
      nonce: "nonce-rated-provenance",
    });
    assert.ok(validateDuelEvents([...ratedEvents, manualRated.event]).some((issue) =>
      /actual agent call/.test(issue.message)
    ));

    const mismatchedResponse = {
      duelId: "rated-provenance",
      commitmentId: "commitment-rated-mismatched-packet",
      answer: "The packet supports this answer.",
      confidence: 0.7,
    };
    const mismatchedPacket = createDuelCommitment({
      eventId: "event-rated-provenance-mismatched-packet",
      occurredAt: at(0, 2),
      participantId: "alpha",
      captureType: "agent-call",
      captureRef: "agent-call:trace-rated-provenance-mismatched-packet",
      agentReceipt: {
        ...agentReceipt("alpha", "trace-rated-provenance-mismatched-packet", mismatchedResponse),
        sharedEvidenceSha256: "f".repeat(64),
      },
      ...mismatchedResponse,
    });
    assert.ok(validateDuelEvents([...ratedEvents, mismatchedPacket.event]).some((issue) =>
      issue.code === "hashMismatch" && /shared evidence packet/.test(issue.message)
    ));

    const missingCapabilityResponse = {
      duelId: "rated-provenance",
      commitmentId: "commitment-rated-missing-capability",
      answer: "The evidence supports this answer.",
      confidence: 0.72,
    };
    const missingCapability = createDuelCommitment({
      eventId: "event-rated-provenance-missing-capability",
      occurredAt: at(0, 2),
      participantId: "alpha",
      captureType: "agent-call",
      captureRef: "agent-call:trace-rated-missing-capability",
      agentReceipt: {
        ...agentReceipt("alpha", "trace-rated-missing-capability", missingCapabilityResponse),
        capabilityPolicy: undefined,
      },
      ...missingCapabilityResponse,
    });
    assert.ok(validateDuelEvents([...ratedEvents, missingCapability.event]).some((issue) =>
      issue.code === "invalidField" && /full-access capability policy/.test(issue.message)
    ));

    const httpResponse = {
      duelId: "rated-provenance",
      commitmentId: "commitment-rated-http",
      answer: "This answer came through an otherwise valid HTTP head call.",
      confidence: 0.74,
    };
    const httpRated = createDuelCommitment({
      eventId: "event-rated-provenance-http",
      occurredAt: at(0, 2),
      participantId: "alpha",
      captureType: "agent-call",
      captureRef: "agent-call:trace-rated-http",
      agentReceipt: {
        ...agentReceipt("alpha", "trace-rated-http", httpResponse),
        transport: "http",
      },
      ...httpResponse,
    });
    const httpRatedIssues = validateDuelEvents([...ratedEvents, httpRated.event]);
    assert.ok(httpRatedIssues.some((issue) =>
      issue.code === "invalidField" && /local oneShot head receipt; HTTP transports cannot prove Hydra full-access execution/.test(issue.message)
    ));
    assert.throws(
      () => aggregateDuels([...ratedEvents, httpRated.event]),
      (error: unknown) => error instanceof DuelValidationError
        && error.issues.some((issue) => /HTTP transports cannot prove Hydra full-access execution/.test(issue.message)),
    );
    assert.deepEqual(aggregateDuels(ratedEvents).ratings, []);

    const exhibitionChallenge = legacyChallenge("manual-exhibition");
    const exhibitionEvents: DuelEvent[] = [
      exhibitionChallenge,
      legacyExhibitionAcceptance(exhibitionChallenge),
    ];
    const manualExhibition = createDuelCommitment({
      ...manualRated.payload,
      eventId: "event-manual-exhibition-seal",
      occurredAt: at(0, 2),
      duelId: "manual-exhibition",
      commitmentId: "commitment-manual-exhibition",
      nonce: "nonce-manual-exhibition",
    });
    assert.equal(validateDuelEvents([...exhibitionEvents, manualExhibition.event]).length, 0);

    const httpExhibitionResponse = {
      duelId: "manual-exhibition",
      commitmentId: "commitment-http-exhibition",
      answer: "HTTP evidence remains structurally auditable in an exhibition.",
      confidence: 0.58,
    };
    const httpExhibition = createDuelCommitment({
      eventId: "event-http-exhibition-seal",
      occurredAt: at(0, 2),
      participantId: "alpha",
      captureType: "agent-call",
      captureRef: "agent-call:trace-http-exhibition",
      agentReceipt: {
        ...agentReceipt("alpha", "trace-http-exhibition", httpExhibitionResponse),
        transport: "http",
      },
      ...httpExhibitionResponse,
    });
    assert.equal(validateDuelEvents([...exhibitionEvents, httpExhibition.event]).length, 0);
    assert.deepEqual(aggregateDuels([...exhibitionEvents, httpExhibition.event]).ratings, []);
  });

  test("strictly parses the bounded answer and confidence returned by a participant head", () => {
    const expected = { duelId: "duel-one", participantId: "alpha", commitmentId: "commitment-one" };
    assert.deepEqual(
      parseDuelAgentCommitmentResponse('```json\n{"duelId":"duel-one","participantId":"alpha","commitmentId":"commitment-one","answer":"Check the generation fence.","confidence":0.82}\n```', expected),
      { ...expected, answer: "Check the generation fence.", confidence: 0.82 },
    );
    assert.throws(() => parseDuelAgentCommitmentResponse('{"duelId":"duel-one","participantId":"alpha","commitmentId":"commitment-one","answer":"x","confidence":82}', expected), /0 through 1/);
    assert.throws(() => parseDuelAgentCommitmentResponse('{"duelId":"duel-one","participantId":"alpha","commitmentId":"commitment-one","answer":"x","confidence":0.8,"winner":"alpha"}', expected), /contain only/);
    assert.throws(() => parseDuelAgentCommitmentResponse('{"duelId":"duel-other","participantId":"alpha","commitmentId":"commitment-one","answer":"x","confidence":0.8}', expected), /does not match/);
    assert.throws(() => parseDuelAgentCommitmentResponse("not json", expected), /valid JSON/);
  });
});

describe("duel validation and terminal transitions", () => {
  test("rejects self-duels, reserved identities, participant adjudicators, and forged actors", () => {
    const self = challenge("self", 0, { challengerId: "alpha", challengedId: "alpha" });
    assert.ok(validateDuelEvents([self]).some((issue) => /cannot duel itself/.test(issue.message)));

    const reserved = challenge("reserved", 0, { challengerId: "user" });
    assert.ok(validateDuelEvents([reserved]).some((issue) => /valid durable Hydra head id/.test(issue.message)));

    const selfJudged = challenge("self-judge", 0, { adjudicatorType: "human", adjudicatorId: "alpha" });
    assert.ok(validateDuelEvents([selfJudged]).some((issue) => /adjudicator must differ/.test(issue.message)));

    const forgedChallenge = { ...challenge("forged"), createdBy: "alpha" };
    assert.ok(validateDuelEvents([forgedChallenge]).some((issue) => /createdBy must be local-user/.test(issue.message)));

    const base: DuelEvent[] = [challenge("forged-accept")];
    const validAcceptance = createDuelAcceptance(base, {
      eventId: "event-forged-accept",
      occurredAt: at(0, 1),
      duelId: "forged-accept",
    });
    assert.ok(validateDuelEvents([...base, { ...validAcceptance, recordedBy: "alpha" }]).some((issue) =>
      /recordedBy must be local-user/.test(issue.message)
    ));
    assert.ok(validateDuelEvents([...base, { ...validAcceptance, acceptedBy: "alpha" }]).some((issue) =>
      /acceptedBy must be the challenged head/.test(issue.message)
    ));
  });

  test("rejects out-of-order seals, duplicate participants, early resolutions, and adjudicator drift", () => {
    const created = challenge("ordering");
    const earlyCommitment = createDuelCommitment({
      eventId: "event-ordering-early-seal",
      occurredAt: at(0, 1),
      duelId: "ordering",
      commitmentId: "commitment-ordering-early",
      participantId: "alpha",
      captureType: "agent-call",
      captureRef: "agent-call:trace-ordering-early",
      agentReceipt: agentReceipt("alpha", "trace-ordering-early", {
        duelId: "ordering", commitmentId: "commitment-ordering-early", answer: "Too soon", confidence: 0.5,
      }),
      answer: "Too soon",
      confidence: 0.5,
      nonce: "nonce-ordering-early",
    });
    assert.ok(validateDuelEvents([created, earlyCommitment.event]).some((issue) =>
      issue.code === "invalidTransition"
    ));

    const events: DuelEvent[] = [];
    const prepared = addPreparedDuel(events, "ordering-ready", 0);
    const reveal = events.pop();
    assert.equal(reveal?.type, "duelCommitmentsRevealed");

    const duplicate = createDuelCommitment({
      eventId: "event-ordering-duplicate",
      occurredAt: at(0, 4),
      duelId: "ordering-ready",
      commitmentId: "commitment-ordering-duplicate",
      participantId: prepared.challenge.challengerId,
      captureType: "agent-call",
      captureRef: "agent-call:trace-ordering-duplicate",
      agentReceipt: agentReceipt(prepared.challenge.challengerId, "trace-ordering-duplicate", {
        duelId: "ordering-ready", commitmentId: "commitment-ordering-duplicate", answer: "A second attempt", confidence: 0.1,
      }),
      answer: "A second attempt",
      confidence: 0.1,
      nonce: "nonce-ordering-duplicate",
    });
    assert.ok(validateDuelEvents([...events, duplicate.event]).some((issue) =>
      issue.code === "duplicateCommitment"
    ));

    const earlyResult = resolution(prepared.challenge, "tie", 0);
    assert.ok(validateDuelEvents([...events, earlyResult]).some((issue) =>
      issue.code === "invalidTransition" && /paired reveal/.test(issue.message)
    ));

    const wrongJudge = {
      ...resolution(prepared.challenge, "challengerWin", 0, "wrong-judge"),
      adjudicatorId: "different-judge",
    };
    assert.ok(validateDuelEvents([...events, reveal!, wrongJudge]).some((issue) =>
      /adjudicator must match/.test(issue.message)
    ));
  });

  test("fails closed on deterministic resolutions until an authoritative machine receipt exists", () => {
    const events: DuelEvent[] = [];
    const prepared = addPreparedDuel(events, "deterministic-v1-gap", 0, {
      adjudicatorType: "deterministic",
      adjudicatorId: "verification-runtime",
      evidenceContract: "A future machine mapping must bind an exact receipt to the committed proposition and outcome.",
    });
    const acceptance = events.find((event) => event.type === "duelAdmitted");
    assert.equal(acceptance?.type, "duelAdmitted");
    assert.equal(acceptance?.ratingClass, "rated");
    assert.equal(aggregateDuels(events).activeDuels[0]?.status, "awaiting_adjudication");
    assert.deepEqual(aggregateDuels(events).ratings, []);

    const operatorAttempt = resolution(prepared.challenge, "challengerWin", 0, "operator-deterministic");
    const operatorIssues = validateDuelEvents([...events, operatorAttempt]);
    assert.ok(operatorIssues.some((issue) =>
      issue.code === "invalidTransition" && /deterministic duel resolutions are unsupported in v1/.test(issue.message)
    ));
    assert.throws(
      () => aggregateDuels([...events, operatorAttempt]),
      (error: unknown) => error instanceof DuelValidationError
        && error.issues.some((issue) => /authoritative machine mapping receipt/.test(issue.message)),
    );

    const runtimeAttempt = {
      ...operatorAttempt,
      eventId: "event-deterministic-v1-gap-runtime-attempt",
      recordedBy: "hydra-runtime",
    };
    const runtimeIssues = validateDuelEvents([...events, runtimeAttempt]);
    assert.ok(runtimeIssues.some((issue) => /deterministic duel resolutions are unsupported in v1/.test(issue.message)));
  });

  test("supports human cancellation before resolution and makes decline/cancel terminal", () => {
    const pending = challenge("cancel-pending");
    const cancelled: DuelEvent = {
      type: "duelCancelled",
      eventId: "event-cancel-pending",
      occurredAt: at(0, 1),
      duelId: "cancel-pending",
      cancelledBy: "local-user",
      reason: "The sealed secret cannot be recovered.",
    };
    assert.equal(validateDuelEvents([pending, cancelled]).length, 0);
    const cancelledView = aggregateDuels([pending, cancelled]).recentDuels[0];
    assert.equal(cancelledView?.status, "cancelled");
    assert.equal(cancelledView?.cancellationReason, "The sealed secret cannot be recovered.");

    const acceptedAfterCancel = {
      type: "duelAccepted",
      eventId: "event-after-cancel",
      occurredAt: at(0, 2),
      duelId: "cancel-pending",
      acceptedBy: "beta",
      recordedBy: "local-user",
      ratingClass: "rated",
      eligibilityReasons: [],
    } as const;
    assert.ok(validateDuelEvents([pending, cancelled, acceptedAfterCancel]).some((issue) =>
      issue.code === "invalidTransition"
    ));

    const declinedChallenge = challenge("declined");
    const declined: DuelEvent = {
      type: "duelDeclined",
      eventId: "event-declined",
      occurredAt: at(0, 1),
      duelId: "declined",
      declinedBy: "beta",
      recordedBy: "local-user",
      reason: "The proposition is not useful enough to contest.",
    };
    const declinedView = aggregateDuels([declinedChallenge, declined]).recentDuels[0];
    assert.equal(declinedView?.status, "declined");
    assert.equal(declinedView?.declineReason, declined.reason);

    const forgedCancel = { ...cancelled, eventId: "event-forged-cancel", cancelledBy: "alpha" };
    assert.ok(validateDuelEvents([pending, forgedCancel]).some((issue) =>
      /only the local user, or Hydra integrity policy/.test(issue.message)
    ));

    const resolved: DuelEvent[] = [];
    addResolvedDuel(resolved, "cannot-cancel-result", 0, "tie");
    assert.ok(validateDuelEvents([...resolved, {
      ...cancelled,
      eventId: "event-cancel-after-result",
      occurredAt: at(1),
      duelId: "cannot-cancel-result",
    }]).some((issue) => /only an unresolved/.test(issue.message)));
  });

  test("fails closed on malformed, duplicate, unknown, and later-reference events", () => {
    const first = challenge("duplicates");
    const duplicateEvent = challenge("other");
    const duplicateDuel = { ...challenge("duplicates"), eventId: "event-duplicates-again" };
    const issues = validateDuelEvents([
      null,
      { type: "unknownDuelEvent", eventId: "event-unknown-type", occurredAt: at(0), duelId: "unknown-type" },
      first,
      { ...duplicateEvent, eventId: first.eventId },
      duplicateDuel,
      {
        type: "duelAccepted",
        eventId: "event-missing-duel",
        occurredAt: at(0),
        duelId: "missing",
        acceptedBy: "beta",
        recordedBy: "local-user",
        ratingClass: "rated",
        eligibilityReasons: [],
      },
      {
        type: "duelResolutionReversed",
        eventId: "event-missing-resolution",
        occurredAt: at(0),
        duelId: "duplicates",
        targetResolutionId: "missing-resolution",
        reversedBy: "local-user",
        reason: "No such resolution exists.",
      },
    ]);
    const codes = new Set(issues.map((issue) => issue.code));
    for (const code of ["invalidEvent", "invalidType", "duplicateEvent", "duplicateDuel", "unknownDuel", "unknownResolution"]) {
      assert.ok(codes.has(code as never), `missing validation code ${code}`);
    }
    assert.throws(
      () => aggregateDuels([first, duplicateDuel] as DuelEvent[]),
      (error: unknown) => error instanceof DuelValidationError
        && error.issues.some((issue) => issue.code === "duplicateDuel"),
    );
  });
});

describe("domain Elo and non-rating outcomes", () => {
  test("awards an equal-rating decisive win as +12/-12", () => {
    const events: DuelEvent[] = [];
    const completed = addResolvedDuel(events, "equal", 0, "challengerWin");
    assert.equal(rating(events, completed.challenge.challengerId).rating, DUEL_INITIAL_RATING + 12);
    assert.equal(rating(events, completed.challenge.challengedId).rating, DUEL_INITIAL_RATING - 12);
    assert.equal(rating(events, completed.challenge.challengerId).wins, 1);
    assert.equal(rating(events, completed.challenge.challengedId).losses, 1);
  });

  test("keeps an upset zero-sum and gives the lower-rated winner the larger delta", () => {
    const events: DuelEvent[] = [];
    addResolvedDuel(events, "alpha-beats-charlie", 0, "challengerWin", {
      challengerId: "alpha",
      challengedId: "charlie",
      proposition: "Alpha predicts the first independent runtime result.",
    });
    addResolvedDuel(events, "delta-beats-beta", 1, "challengerWin", {
      challengerId: "delta",
      challengedId: "beta",
      proposition: "Delta predicts the second independent runtime result.",
    });
    const upset = addResolvedDuel(events, "beta-upsets-alpha", 2, "challengerWin", {
      challengerId: "beta",
      challengedId: "alpha",
      proposition: "Beta predicts the head-to-head runtime result.",
    });

    const view = aggregateDuels(events).recentDuels.find((duel) => duel.duelId === upset.challenge.duelId);
    assert.deepEqual(view?.resolution?.ratingDeltas, { beta: 13, alpha: -13 });
    assert.equal(Object.values(view?.resolution?.ratingDeltas ?? {}).reduce((sum, value) => sum + value, 0), 0);
    assert.equal(aggregateDuels(events).ratings.reduce((sum, row) => sum + row.rating, 0), 4 * DUEL_INITIAL_RATING);
  });

  test("records an unequal-rating tie as a rated draw with exact zero delta", () => {
    const events: DuelEvent[] = [];
    addResolvedDuel(events, "alpha-high", 0, "challengerWin", {
      challengerId: "alpha",
      challengedId: "charlie",
      proposition: "Alpha wins the setup match.",
    });
    addResolvedDuel(events, "delta-over-beta", 1, "challengerWin", {
      challengerId: "delta",
      challengedId: "beta",
      proposition: "Beta loses the setup match.",
    });
    const tied = addResolvedDuel(events, "unequal-tie", 2, "tie", {
      challengerId: "beta",
      challengedId: "alpha",
      proposition: "The unequal-rated heads produce equally supported commitments.",
    });

    const aggregate = aggregateDuels(events);
    const view = aggregate.recentDuels.find((duel) => duel.duelId === tied.challenge.duelId);
    assert.deepEqual(view?.resolution?.ratingDeltas, { beta: 0, alpha: 0 });
    assert.equal(rating(events, "alpha").rating, 1012);
    assert.equal(rating(events, "beta").rating, 988);
    assert.equal(rating(events, "alpha").draws, 1);
    assert.equal(rating(events, "beta").draws, 1);
    assert.equal(rating(events, "alpha").ratedMatches, 2);
    assert.equal(rating(events, "beta").ratedMatches, 2);
  });

  test("gives unresolved, void, and legacy exhibition results no match and no delta", () => {
    const events: DuelEvent[] = [];
    addResolvedDuel(events, "unresolved", 0, "unresolved", {
      challengerId: "alpha",
      challengedId: "beta",
      domain: "runtime",
    });
    addResolvedDuel(events, "void", 0, "void", {
      challengerId: "charlie",
      challengedId: "delta",
      domain: "security",
    });
    addLegacyExhibitionResolvedDuel(events, "exhibition", 0, "challengerWin", {
      challengerId: "echo",
      challengedId: "foxtrot",
      domain: "ux",
    });

    const aggregate = aggregateDuels(events);
    assert.deepEqual(aggregate.ratings, []);
    for (const duelId of ["unresolved", "void", "exhibition"]) {
      const view = aggregate.recentDuels.find((duel) => duel.duelId === duelId);
      assert.deepEqual(view?.resolution?.ratingDeltas, {});
    }
    assert.equal(aggregate.recentDuels.find((duel) => duel.duelId === "exhibition")?.rated, false);
  });

  test("isolates ratings by domain", () => {
    const events: DuelEvent[] = [];
    addResolvedDuel(events, "runtime-match", 0, "challengerWin", {
      challengerId: "alpha",
      challengedId: "beta",
      domain: "runtime",
      proposition: "Alpha wins the runtime contract.",
    });
    addResolvedDuel(events, "ux-match", 1, "challengedWin", {
      challengerId: "alpha",
      challengedId: "beta",
      domain: "ux",
      proposition: "Beta wins the UX contract.",
    });

    assert.equal(rating(events, "alpha", "runtime").rating, 1012);
    assert.equal(rating(events, "beta", "runtime").rating, 988);
    assert.equal(rating(events, "alpha", "ux").rating, 988);
    assert.equal(rating(events, "beta", "ux").rating, 1012);
  });
});

describe("anti-farming reservations", () => {
  test("rejects reciprocal pair rematches in the same domain for seven days", () => {
    const events: DuelEvent[] = [];
    addAcceptedDuel(events, "pair-first", 0, {
      challengerId: "alpha",
      challengedId: "beta",
      proposition: "The first pair proposition.",
    });
    const second = challenge("pair-second", 1, {
      challengerId: "beta",
      challengedId: "alpha",
      proposition: "A different proposition cannot bypass the pair cooldown.",
    });
    events.push(second);
    assert.throws(
      () => createDuelAcceptance(events, {
        eventId: "event-pair-second-accept",
        occurredAt: at(1, 1),
        duelId: second.duelId,
      }),
      (error: unknown) => error instanceof DuelAcceptanceRejectedError
        && error.reasons.includes("pair-cooldown"),
    );

    const forgedRated: DuelEvent = {
      type: "duelAccepted",
      eventId: "event-pair-second-forged-accept",
      occurredAt: at(1, 1),
      duelId: second.duelId,
      acceptedBy: second.challengedId,
      recordedBy: "local-user",
      ratingClass: "rated",
      eligibilityReasons: [],
      capabilityPolicy: DUEL_FULL_ACCESS_POLICY_ID,
    };
    assert.ok(validateDuelEvents([...events, forgedRated]).some((issue) =>
      /rejected by policy/.test(issue.message)
    ));
  });

  test("normalizes proposition repeats, expires them after 30 days, and ignores declined challenges", () => {
    const events: DuelEvent[] = [];
    addAcceptedDuel(events, "prop-first", 0, {
      challengerId: "alpha",
      challengedId: "beta",
      domain: "runtime",
      proposition: "The build passes all tests.",
    });
    const repeated = challenge("prop-repeat", 8, {
      challengerId: "alpha",
      challengedId: "charlie",
      domain: "security",
      proposition: "THE   BUILD passes all tests.",
    });
    assert.equal(repeated.propositionFingerprint, duelPropositionFingerprint("the build passes all tests."));
    events.push(repeated);
    assert.throws(
      () => createDuelAcceptance(events, {
        eventId: "event-prop-repeat-accept",
        occurredAt: at(8, 1),
        duelId: repeated.duelId,
      }),
      (error: unknown) => error instanceof DuelAcceptanceRejectedError
        && error.reasons.includes("repeat-proposition"),
    );

    const expired = challenge("prop-expired", 31, {
      challengerId: "alpha",
      challengedId: "delta",
      domain: "research",
      proposition: "The build passes all tests.",
    });
    events.push(expired);
    const expiredAcceptance = createDuelAcceptance(events, {
      eventId: "event-prop-expired-accept",
      occurredAt: at(31, 1),
      duelId: expired.duelId,
    });
    assert.equal(expiredAcceptance.ratingClass, "rated");

    const declined = challenge("declined-does-not-reserve", 40, {
      challengerId: "echo",
      challengedId: "foxtrot",
      proposition: "A declined proposition should not reserve rating capacity.",
    });
    events.push(declined, {
      type: "duelDeclined",
      eventId: "event-declined-does-not-reserve",
      occurredAt: at(40, 1),
      duelId: declined.duelId,
      declinedBy: "foxtrot",
      recordedBy: "local-user",
      reason: "Declined before accepting the reservation.",
    });
    const retried = challenge("declined-retry", 41, {
      challengerId: "echo",
      challengedId: "foxtrot",
      proposition: declined.proposition,
    });
    events.push(retried);
    assert.equal(createDuelAcceptance(events, {
      eventId: "event-declined-retry-accept",
      occurredAt: at(41, 1),
      duelId: retried.duelId,
    }).ratingClass, "rated");
  });

  test("caps an initiating head at three autonomous rated duels per day", () => {
    const events: DuelEvent[] = [];
    for (const [index, opponent] of ["beta", "charlie", "delta"].entries()) {
      const id = `cap-${index + 1}`;
      const day = (index * 2) / 24;
      const prepared = addPreparedDuel(events, id, day, {
        challengerId: "alpha",
        challengedId: opponent,
        domain: "runtime",
        proposition: `Unique cap proposition ${index + 1}.`,
      });
      events.push(resolution(prepared.challenge, "challengerWin", day));
    }
    const fourth = agentChallenge("cap-fourth", 6 / 24, {
      challengerId: "alpha",
      challengedId: "echo",
      domain: "runtime",
      proposition: "Unique cap proposition four.",
    });
    events.push(fourth);
    assert.throws(
      () => createDuelAdmission(events, {
        eventId: "event-cap-fourth-admit",
        occurredAt: at(6 / 24, 1),
        duelId: fourth.duelId,
      }),
      (error: unknown) => error instanceof DuelAcceptanceRejectedError
        && error.reasons.includes("head-daily-cap"),
    );
  });
});

describe("append-only result correction", () => {
  test("removes a reversed result and replays its replacement at the original rating slot", () => {
    const corrected: DuelEvent[] = [];
    const first = addResolvedDuel(corrected, "slot-one", 0, "challengerWin", {
      challengerId: "alpha",
      challengedId: "beta",
      proposition: "The original first-slot result.",
    });
    addResolvedDuel(corrected, "slot-two", 1, "challengerWin", {
      challengerId: "alpha",
      challengedId: "charlie",
      proposition: "A later result whose expectation depends on slot one.",
    });
    assert.ok(first.resolution);
    const reversal: DuelResolutionReversedEvent = {
      type: "duelResolutionReversed",
      eventId: "event-slot-one-reversal",
      occurredAt: at(2),
      duelId: first.challenge.duelId,
      targetResolutionId: first.resolution!.resolutionId,
      reversedBy: "local-user",
      reason: "The evidence receipt was matched to the wrong participant.",
    };
    corrected.push(reversal);
    const replacement = resolution(first.challenge, "challengedWin", 3, "replacement");
    corrected.push(replacement);

    const control: DuelEvent[] = [];
    addResolvedDuel(control, "slot-one", 0, "challengedWin", {
      challengerId: "alpha",
      challengedId: "beta",
      proposition: "The original first-slot result.",
    });
    addResolvedDuel(control, "slot-two", 1, "challengerWin", {
      challengerId: "alpha",
      challengedId: "charlie",
      proposition: "A later result whose expectation depends on slot one.",
    });

    const aggregate = aggregateDuels(corrected);
    assert.deepEqual(ratingsSnapshot(corrected), ratingsSnapshot(control));
    assert.equal(aggregate.corrections.length, 1);
    assert.equal(aggregate.corrections[0]?.resolution.resolutionId, first.resolution!.resolutionId);
    assert.equal(aggregate.corrections[0]?.reversal.targetResolutionId, first.resolution!.resolutionId);
    assert.equal(aggregate.recentDuels.find((duel) => duel.duelId === "slot-one")?.resolution?.resolutionId, replacement.resolutionId);
    assert.equal(aggregate.recentDuels.find((duel) => duel.duelId === "slot-one")?.resolution?.winnerId, "beta");
  });

  test("makes a reversed result pending again and permits only local-user reversal", () => {
    const events: DuelEvent[] = [];
    const completed = addResolvedDuel(events, "pending-correction", 0, "challengerWin");
    assert.ok(completed.resolution);
    const reversal: DuelResolutionReversedEvent = {
      type: "duelResolutionReversed",
      eventId: "event-pending-correction-reversal",
      occurredAt: at(1),
      duelId: completed.challenge.duelId,
      targetResolutionId: completed.resolution!.resolutionId,
      reversedBy: "local-user",
      reason: "The evidence was later invalidated.",
    };
    events.push(reversal);
    const aggregate = aggregateDuels(events);
    assert.equal(aggregate.activeDuels[0]?.status, "awaiting_adjudication");
    assert.equal(aggregate.activeDuels[0]?.resolution, undefined);
    assert.deepEqual(aggregate.ratings, []);

    const forged = { ...reversal, eventId: "event-pending-correction-forged", reversedBy: "alpha" };
    const originalEvents = events.slice(0, -1);
    assert.ok(validateDuelEvents([...originalEvents, forged]).some((issue) =>
      /human-only/.test(issue.message)
    ));
    assert.ok(validateDuelEvents([...events, { ...reversal, eventId: "event-pending-correction-twice" }]).some((issue) =>
      issue.code === "resolutionAlreadyReversed"
    ));
  });
});
