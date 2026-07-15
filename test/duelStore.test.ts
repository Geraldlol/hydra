import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createDuelAcceptance,
  createDuelAdmission,
  createDuelChallenge,
  createDuelCommitment,
  createDuelReveal,
  DUEL_FULL_ACCESS_POLICY_ID,
  DUEL_LEGACY_RATING_POLICY,
  hashDuelAgentResponse,
  hashDuelSharedEvidencePacket,
  type DuelAgentCallReceipt,
  type DuelAcceptedEvent,
  type DuelChallengedEvent,
  type DuelEvent,
  type DuelOutcome,
  type DuelResolvedEvent,
} from "../src/duels";
import {
  appendDuelEvents,
  ensureDuelLedger,
  loadDuelEvents,
  privateDuelLedgerPath,
  renderDuelMarkdown,
  writeDuelMirror,
} from "../src/duelStore";

const BASE_TIME = Date.parse("2026-07-14T12:00:00.000Z");

function at(offsetSeconds: number): string {
  return new Date(BASE_TIME + (offsetSeconds * 1_000)).toISOString();
}

function agentReceipt(
  agentId: string,
  traceId: string,
  response: { duelId: string; commitmentId: string; answer: string; confidence: number },
): DuelAgentCallReceipt {
  return {
    traceId,
    agentId,
    agentKind: agentId === "claude" ? "claude" : "codex",
    transport: "oneShot",
    startedAt: at(0),
    completedAt: at(1),
    promptSha256: "4".repeat(64),
    sharedEvidenceSha256: hashDuelSharedEvidencePacket(`Shared ${response.duelId.replace(/^duel-/, "")} verification facts supplied identically to both heads.`),
    capabilityPolicy: DUEL_FULL_ACCESS_POLICY_ID,
    responseSha256: hashDuelAgentResponse({ participantId: agentId, ...response }),
    invocationSha256: "6".repeat(64),
    workspaceFingerprintSha256: "b".repeat(64),
    capabilityLockSha256: agentId === "claude" ? "2".repeat(64) : "1".repeat(64),
  };
}

function challenge(suffix: string, offsetSeconds = 0): DuelEvent {
  return createDuelChallenge({
    eventId: `event-challenge-${suffix}`,
    occurredAt: at(offsetSeconds),
    duelId: `duel-${suffix}`,
    challengerId: "codex",
    challengedId: "claude",
    domain: "runtime",
    proposition: `The ${suffix} implementation passes its verification contract.`,
    sharedEvidencePacket: `Shared ${suffix} verification facts supplied identically to both heads.`,
    evidenceContract: "Hydra verification receipt must pass for the exact committed proposition.",
    adjudicatorType: "human",
    adjudicatorId: "local-user",
  });
}

function agentChallenge(suffix: string, offsetSeconds = 0): DuelChallengedEvent {
  const occurredAt = at(offsetSeconds);
  return createDuelChallenge({
    eventId: `event-challenge-${suffix}`,
    occurredAt,
    duelId: `duel-${suffix}`,
    challengerId: "codex",
    challengedId: "claude",
    domain: "runtime",
    proposition: `The ${suffix} implementation passes its verification contract.`,
    sharedEvidencePacket: `Shared ${suffix} verification facts supplied identically to both heads.`,
    evidenceContract: "Hydra verification receipt must pass for the exact committed proposition.",
    adjudicatorType: "human",
    adjudicatorId: "local-user",
    createdBy: "hydra-runtime",
    initiation: {
      protocol: "agent-intent-v1",
      agentId: "codex",
      sourceTraceId: `trace-${suffix}-source`,
      sourceMessageTimestamp: occurredAt,
      sourceMessageSha256: "a".repeat(64),
      disputedMessageTimestamp: occurredAt,
      workspaceFingerprintSha256: "b".repeat(64),
      capabilityLocks: [
        { agentId: "codex", agentKind: "codex", profileSha256: "1".repeat(64) },
        { agentId: "claude", agentKind: "claude", profileSha256: "2".repeat(64) },
      ],
    },
  });
}

function legacyChallenge(suffix: string, offsetSeconds = 0): DuelChallengedEvent {
  return {
    ...(challenge(suffix, offsetSeconds) as DuelChallengedEvent),
    ratingPolicy: DUEL_LEGACY_RATING_POLICY,
  };
}

function legacyExhibitionAcceptance(challengeEvent: DuelChallengedEvent, offsetSeconds = 1): DuelAcceptedEvent {
  return {
    type: "duelAccepted",
    eventId: `event-accept-${challengeEvent.duelId}`,
    occurredAt: at(offsetSeconds),
    duelId: challengeEvent.duelId,
    acceptedBy: challengeEvent.challengedId,
    recordedBy: "local-user",
    ratingClass: "exhibition",
    eligibilityReasons: ["voluntary-exhibition"],
  };
}

function completeDuel(suffix: string, outcome: DuelOutcome = "challengerWin", offsetSeconds = 0): DuelEvent[] {
  const issued = agentChallenge(suffix, offsetSeconds);
  const accepted = createDuelAdmission([issued], {
    eventId: `event-admit-${suffix}`,
    occurredAt: at(offsetSeconds + 1),
    duelId: `duel-${suffix}`,
  });
  const first = createDuelCommitment({
    eventId: `event-seal-codex-${suffix}`,
    occurredAt: at(offsetSeconds + 2),
    duelId: `duel-${suffix}`,
    commitmentId: `commitment-codex-${suffix}`,
    participantId: "codex",
    captureType: "agent-call",
    captureRef: `agent-call:trace-codex-${suffix}`,
    agentReceipt: agentReceipt("codex", `trace-codex-${suffix}`, {
      duelId: `duel-${suffix}`,
      commitmentId: `commitment-codex-${suffix}`,
      answer: `Codex sealed answer ${suffix}`,
      confidence: 0.8,
    }),
    answer: `Codex sealed answer ${suffix}`,
    confidence: 0.8,
    nonce: `nonce-codex-${suffix}`,
  });
  const second = createDuelCommitment({
    eventId: `event-seal-claude-${suffix}`,
    occurredAt: at(offsetSeconds + 3),
    duelId: `duel-${suffix}`,
    commitmentId: `commitment-claude-${suffix}`,
    participantId: "claude",
    captureType: "agent-call",
    captureRef: `agent-call:trace-claude-${suffix}`,
    agentReceipt: agentReceipt("claude", `trace-claude-${suffix}`, {
      duelId: `duel-${suffix}`,
      commitmentId: `commitment-claude-${suffix}`,
      answer: `Claude sealed answer ${suffix}`,
      confidence: 0.6,
    }),
    answer: `Claude sealed answer ${suffix}`,
    confidence: 0.6,
    nonce: `nonce-claude-${suffix}`,
  });
  const beforeReveal: DuelEvent[] = [issued, accepted, first.event, second.event];
  const reveal = createDuelReveal(beforeReveal, {
    eventId: `event-reveal-${suffix}`,
    occurredAt: at(offsetSeconds + 4),
    duelId: `duel-${suffix}`,
    payloads: [first.payload, second.payload],
    recordedBy: "hydra-runtime",
  });
  const resolution: DuelResolvedEvent = {
    type: "duelResolved",
    eventId: `event-resolution-${suffix}`,
    occurredAt: at(offsetSeconds + 5),
    duelId: `duel-${suffix}`,
    resolutionId: `resolution-${suffix}`,
    outcome,
    adjudicatorType: "human",
    adjudicatorId: "local-user",
    evidenceRef: `verification:${suffix}`,
    rationale: `The ${suffix} verification receipt adjudicates the committed proposition.`,
    recordedBy: "local-user",
  };
  return [...beforeReveal, reveal, resolution];
}

describe("duel persistence", () => {
  test("creates, appends, replays, and aggregates the authoritative ledger", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-duels-"));
    const file = path.join(dir, "duel-events.jsonl");
    await ensureDuelLedger(file);
    assert.deepEqual(await loadDuelEvents(file), []);

    const events = completeDuel("persist");
    const aggregate = await appendDuelEvents(file, events);
    assert.equal(aggregate.eventCount, events.length);
    assert.equal(aggregate.ratings.length, 2);
    assert.deepEqual(await loadDuelEvents(file), events);
    assert.equal(privateDuelLedgerPath(dir), path.join(dir, "competition", "duel-events.jsonl"));
  });

  test("serializes concurrent logical batches without losing either challenge", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-duels-race-"));
    const file = path.join(dir, "duel-events.jsonl");
    await ensureDuelLedger(file);
    await Promise.all([
      appendDuelEvents(file, [challenge("race-a", 0)]),
      appendDuelEvents(file, [challenge("race-b", 1)]),
    ]);
    const events = await loadDuelEvents(file);
    assert.equal(events.length, 2);
    assert.deepEqual(new Set(events.map((event) => event.duelId)), new Set(["duel-race-a", "duel-race-b"]));
  });

  test("fails closed on malformed or referentially invalid history", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-duels-invalid-"));
    const malformed = path.join(dir, "malformed.jsonl");
    await fs.writeFile(malformed, "{not-json}\n", "utf8");
    await assert.rejects(loadDuelEvents(malformed), /malformed JSON/);

    const invalid = path.join(dir, "invalid.jsonl");
    const unknownAcceptance = {
      type: "duelAccepted",
      eventId: "event-accept-unknown",
      occurredAt: at(1),
      duelId: "duel-missing",
      acceptedBy: "claude",
      recordedBy: "local-user",
      ratingClass: "rated",
      eligibilityReasons: [],
    };
    await fs.writeFile(invalid, `${JSON.stringify(unknownAcceptance)}\n`, "utf8");
    await assert.rejects(loadDuelEvents(invalid), /unknown or later duel|before its challenge/i);
  });

  test("never exposes a one-sided seal and reveals both answers only as a pair", () => {
    const issued = challenge("privacy");
    const accepted = createDuelAcceptance([issued], {
      eventId: "event-accept-privacy",
      occurredAt: at(1),
      duelId: "duel-privacy",
    });
    const first = createDuelCommitment({
      eventId: "event-seal-privacy",
      occurredAt: at(2),
      duelId: "duel-privacy",
      commitmentId: "commitment-privacy-codex",
      participantId: "codex",
      captureType: "agent-call",
      captureRef: "agent-call:trace-privacy-codex",
      agentReceipt: agentReceipt("codex", "trace-privacy-codex", {
        duelId: "duel-privacy", commitmentId: "commitment-privacy-codex", answer: "THIS-FIRST-ANSWER-MUST-STAY-SEALED", confidence: 0.91,
      }),
      answer: "THIS-FIRST-ANSWER-MUST-STAY-SEALED",
      confidence: 0.91,
      nonce: "nonce-privacy-codex",
    });
    const sealedMarkdown = renderDuelMarkdown([issued, accepted, first.event], (id) => id);
    assert.match(sealedMarkdown, /1\/2 sealed/);
    assert.doesNotMatch(sealedMarkdown, /THIS-FIRST-ANSWER-MUST-STAY-SEALED/);
    assert.doesNotMatch(sealedMarkdown, new RegExp(first.event.commitmentHash));

    const second = createDuelCommitment({
      eventId: "event-seal-privacy-claude",
      occurredAt: at(3),
      duelId: "duel-privacy",
      commitmentId: "commitment-privacy-claude",
      participantId: "claude",
      captureType: "agent-call",
      captureRef: "agent-call:trace-privacy-claude",
      agentReceipt: agentReceipt("claude", "trace-privacy-claude", {
        duelId: "duel-privacy", commitmentId: "commitment-privacy-claude", answer: "SECOND-ANSWER-REVEALED-WITH-FIRST", confidence: 0.72,
      }),
      answer: "SECOND-ANSWER-REVEALED-WITH-FIRST",
      confidence: 0.72,
      nonce: "nonce-privacy-claude",
    });
    const beforeReveal: DuelEvent[] = [issued, accepted, first.event, second.event];
    const reveal = createDuelReveal(beforeReveal, {
      eventId: "event-reveal-privacy",
      occurredAt: at(4),
      duelId: "duel-privacy",
      payloads: [first.payload, second.payload],
    });
    const revealedMarkdown = renderDuelMarkdown([...beforeReveal, reveal], (id) => id);
    assert.match(revealedMarkdown, /THIS-FIRST-ANSWER-MUST-STAY-SEALED/);
    assert.match(revealedMarkdown, /SECOND-ANSWER-REVEALED-WITH-FIRST/);
    assert.match(revealedMarkdown, /91%/);
    assert.match(revealedMarkdown, /72%/);
  });

  test("renders competitive ratings, evidence, and an explicit no-authority boundary", async () => {
    const events = completeDuel("mirror");
    const markdown = renderDuelMarkdown(events, (id) => id === "codex" ? "Codex" : id === "claude" ? "Claude" : id, at(20));
    assert.match(markdown, /Competitive rating only/);
    assert.match(markdown, /never grant filesystem, terminal, network, approval, safety, builder, speaking-order, or orchestration authority/);
    assert.match(markdown, /prove Hydra dispatched the configured head and bound its response, not provider-signed model identity/);
    assert.match(markdown, /Heads initiate new v3 duels from their own room replies/);
    assert.match(markdown, /Hydra admits or rejects them by policy/);
    assert.match(markdown, /no human initiation, manual answer, or exhibition fallback is created/);
    assert.match(markdown, /Historical exhibition\/operator rows remain visible as legacy unranked evidence/);
    assert.match(markdown, /\| runtime \| Provisional #1 \| Codex \| 1012 \| 0 Elo · defend \| 1W \/ 0D \/ 0L \| provisional \|/);
    assert.match(markdown, /\| runtime \| #2 \| Claude \| 988 \| 24 Elo to #1 \| 0W \/ 0D \/ 1L \| provisional \|/);
    assert.match(markdown, /verification:mirror/);
    assert.match(markdown, /Hydra-bound head run/);
    assert.match(markdown, /agent-call:trace-codex-mirror \(Hydra-bound; not provider-signed; capability:hydra-duel-full-native-v1; shared evidence sha256:[a-f0-9]{64}\)/);
    assert.match(markdown, /Codex sealed answer mirror/);
    assert.match(markdown, /Claude sealed answer mirror/);

    const tied = renderDuelMarkdown(completeDuel("tie-mirror", "tie"), (id) => id === "codex" ? "Codex" : id === "claude" ? "Claude" : id, at(20));
    assert.match(tied, /\| runtime \| Joint provisional #1 \| Codex \| 1000 \| 0 Elo · joint \| 0W \/ 1D \/ 0L \| provisional \|/);
    assert.match(tied, /\| runtime \| Joint provisional #1 \| Claude \| 1000 \| 0 Elo · joint \| 0W \/ 1D \/ 0L \| provisional \|/);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-duels-mirror-"));
    const mirror = path.join(dir, "duels.md");
    await writeDuelMirror(mirror, events, (id) => id, at(20));
    assert.equal(await fs.readFile(mirror, "utf8"), renderDuelMarkdown(events, (id) => id, at(20)));
  });

  test("renders legacy unranked history, cancellations, and result corrections", () => {
    const issued = legacyChallenge("exhibition");
    const exhibition = legacyExhibitionAcceptance(issued);
    const cancelled: DuelEvent = {
      type: "duelCancelled",
      eventId: "event-cancel-exhibition",
      occurredAt: at(2),
      duelId: "duel-exhibition",
      cancelledBy: "local-user",
      reason: "One participant withdrew before commitments.",
    };
    const resolved = completeDuel("corrected", "challengedWin", 20);
    const reversed: DuelEvent = {
      type: "duelResolutionReversed",
      eventId: "event-reverse-corrected",
      occurredAt: at(30),
      duelId: "duel-corrected",
      targetResolutionId: "resolution-corrected",
      reversedBy: "local-user",
      reason: "The verification receipt covered a different revision.",
    };
    const markdown = renderDuelMarkdown([issued, exhibition, cancelled, ...resolved, reversed], (id) => id);
    assert.match(markdown, /voluntary-exhibition/);
    assert.match(markdown, /One participant withdrew before commitments/);
    assert.match(markdown, /result reversed/);
    assert.match(markdown, /The verification receipt covered a different revision/);
  });

  test("labels legacy operator-captured answers without implying a provider receipt", () => {
    const issued = legacyChallenge("operator-capture");
    const accepted = legacyExhibitionAcceptance(issued);
    const first = createDuelCommitment({
      eventId: "event-seal-operator-codex",
      occurredAt: at(2),
      duelId: "duel-operator-capture",
      commitmentId: "commitment-operator-codex",
      participantId: "codex",
      captureType: "operator",
      captureRef: "operator:local-user",
      answer: "Operator-entered Codex answer",
      confidence: 0.7,
      nonce: "nonce-operator-codex",
    });
    const second = createDuelCommitment({
      eventId: "event-seal-operator-claude",
      occurredAt: at(3),
      duelId: "duel-operator-capture",
      commitmentId: "commitment-operator-claude",
      participantId: "claude",
      captureType: "operator",
      captureRef: "operator:local-user",
      answer: "Operator-entered Claude answer",
      confidence: 0.6,
      nonce: "nonce-operator-claude",
    });
    const beforeReveal: DuelEvent[] = [issued, accepted, first.event, second.event];
    const reveal = createDuelReveal(beforeReveal, {
      eventId: "event-reveal-operator-capture",
      occurredAt: at(4),
      duelId: "duel-operator-capture",
      payloads: [first.payload, second.payload],
    });
    const markdown = renderDuelMarkdown([...beforeReveal, reveal], (id) => id);
    assert.match(markdown, /legacy operator entry \(unranked history only\)/);
    assert.match(markdown, /\| not applicable \| Operator-entered Codex answer \|/);
    assert.doesNotMatch(markdown, /operator:local-user/);
  });
});
