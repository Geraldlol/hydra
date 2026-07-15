import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  DUEL_SECRET_ORPHAN_GRACE_MS,
  deleteDuelCommitmentSecrets,
  duelCommitmentIndexPath,
  duelCommitmentSecretKey,
  loadDuelCommitmentIndex,
  loadDuelCommitmentSecret,
  storeDuelCommitmentSecret,
  sweepDuelCommitmentSecrets,
  type DuelSecretStorage,
  type StoredDuelCommitmentPayload,
} from "../src/duelSecrets";
import {
  createDuelChallenge,
  createDuelCommitment,
  createDuelReveal,
  hashDuelSharedEvidencePacket,
  DUEL_LEGACY_RATING_POLICY,
  type DuelAcceptedEvent,
  type DuelChallengedEvent,
  type DuelEvent,
} from "../src/duels";

const digest = "a".repeat(64);

function agentReceipt(agentId: string, traceId: string) {
  return {
    traceId,
    agentId,
    agentKind: agentId,
    transport: "oneShot" as const,
    startedAt: "2026-07-01T10:01:00.000Z",
    completedAt: "2026-07-01T10:01:01.000Z",
    promptSha256: digest,
    sharedEvidenceSha256: hashDuelSharedEvidencePacket("The isolated race fixture passes and its ordered receipts show the stale write losing."),
    responseSha256: "b".repeat(64),
    invocationSha256: "c".repeat(64),
  };
}

class MemorySecrets implements DuelSecretStorage {
  readonly values = new Map<string, string>();
  failDeletes = false;
  get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  delete(key: string): Promise<void> {
    if (this.failDeletes) return Promise.reject(new Error("delete unavailable"));
    this.values.delete(key);
    return Promise.resolve();
  }
}

class GatedStoreSecrets extends MemorySecrets {
  readonly storeStarted: Promise<void>;
  private signalStoreStarted!: () => void;
  private readonly releaseStorePromise: Promise<void>;
  private releaseStore!: () => void;

  constructor() {
    super();
    this.storeStarted = new Promise((resolve) => { this.signalStoreStarted = resolve; });
    this.releaseStorePromise = new Promise((resolve) => { this.releaseStore = resolve; });
  }

  override async store(key: string, value: string): Promise<void> {
    this.signalStoreStarted();
    await this.releaseStorePromise;
    this.values.set(key, value);
  }

  unblockStore(): void { this.releaseStore(); }
}

const payload: StoredDuelCommitmentPayload = {
  commitmentId: "commitment-one",
  participantId: "codex",
  captureType: "agent-call",
  captureRef: "agent-call:trace-one",
  agentReceipt: agentReceipt("codex", "trace-one"),
  answer: "The race is caused by a non-atomic read-modify-write.",
  confidence: 0.82,
  nonce: "9f6e9571-9c35-4191-bb6a-aa4dd3c9421e",
};

async function withIndex<T>(run: (indexFilePath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "hydra-duel-secrets-"));
  try {
    return await run(duelCommitmentIndexPath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function duelEvents(id: string, reveal = false): {
  events: DuelEvent[];
  challengerPayload: StoredDuelCommitmentPayload;
  challengedPayload: StoredDuelCommitmentPayload;
} {
  const challenge: DuelChallengedEvent = {
    ...createDuelChallenge({
    eventId: `challenge-${id}`,
    occurredAt: "2026-07-01T10:00:00.000Z",
    duelId: id,
    challengerId: "codex",
    challengedId: "claude",
    domain: "correctness",
    proposition: "The fix prevents a stale write from winning.",
    sharedEvidencePacket: "The isolated race fixture passes and its ordered receipts show the stale write losing.",
    evidenceContract: "The operator compares the isolated race test.",
    adjudicatorType: "human",
    adjudicatorId: "local-user",
    }),
    ratingPolicy: DUEL_LEGACY_RATING_POLICY,
  };
  const accepted: DuelAcceptedEvent = {
    type: "duelAccepted",
    eventId: `accepted-${id}`,
    occurredAt: "2026-07-01T10:01:00.000Z",
    duelId: id,
    acceptedBy: "claude",
    recordedBy: "local-user",
    ratingClass: "exhibition",
    eligibilityReasons: ["voluntary-exhibition"],
  };
  const challenger = createDuelCommitment({
    eventId: `seal-${id}-codex`,
    occurredAt: "2026-07-01T10:02:00.000Z",
    duelId: id,
    commitmentId: `commitment-${id}-codex`,
    participantId: "codex",
    captureType: "operator",
    captureRef: "operator:local-user",
    answer: "Codex answer",
    confidence: 0.8,
    nonce: `nonce-${id}-codex`,
  });
  const challenged = createDuelCommitment({
    eventId: `seal-${id}-claude`,
    occurredAt: "2026-07-01T10:03:00.000Z",
    duelId: id,
    commitmentId: `commitment-${id}-claude`,
    participantId: "claude",
    captureType: "operator",
    captureRef: "operator:local-user",
    answer: "Claude answer",
    confidence: 0.7,
    nonce: `nonce-${id}-claude`,
  });
  const events: DuelEvent[] = [challenge, accepted, challenger.event, challenged.event];
  if (reveal) {
    events.push(createDuelReveal(events, {
      eventId: `reveal-${id}`,
      occurredAt: "2026-07-01T10:04:00.000Z",
      duelId: id,
      payloads: [challenger.payload, challenged.payload],
    }));
  }
  return {
    events,
    challengerPayload: challenger.payload,
    challengedPayload: challenged.payload,
  };
}

describe("duel SecretStorage payloads", () => {
  test("round-trips a provenance-bound sealed payload under an opaque deterministic key", () => withIndex(async (indexFilePath) => {
    const storage = new MemorySecrets();
    await storeDuelCommitmentSecret(storage, indexFilePath, "duel-one", payload);

    const key = duelCommitmentSecretKey("duel-one", "codex", "commitment-one");
    assert.match(key, /^hydra\.duel-commitment\.[a-f0-9]{64}$/);
    assert.doesNotMatch(key, /duel-one|codex/);
    assert.deepEqual(await loadDuelCommitmentSecret(storage, "duel-one", "codex", "commitment-one"), payload);
    assert.equal((await loadDuelCommitmentIndex(indexFilePath))[0]?.state, "stored");

    const indexText = await readFile(indexFilePath, "utf8");
    assert.doesNotMatch(indexText, /non-atomic|trace-one|9f6e9571/);
  }));

  test("fails closed on malformed, mismatched, oversized, or invalid-provenance payloads", async () => {
    const storage = new MemorySecrets();
    const key = duelCommitmentSecretKey("duel-one", "codex", "commitment-one");
    storage.values.set(key, "{bad-json");
    await assert.rejects(loadDuelCommitmentSecret(storage, "duel-one", "codex", "commitment-one"), /malformed/);

    storage.values.set(key, JSON.stringify({
      ...payload,
      participantId: "claude",
      agentReceipt: agentReceipt("claude", "trace-one"),
    }));
    await assert.rejects(loadDuelCommitmentSecret(storage, "duel-one", "codex", "commitment-one"), /another participant/);

    storage.values.set(key, JSON.stringify({ ...payload, commitmentId: "commitment-other" }));
    await assert.rejects(loadDuelCommitmentSecret(storage, "duel-one", "codex", "commitment-one"), /another commitment/);

    storage.values.set(key, JSON.stringify({ ...payload, captureRef: "operator:local-user" }));
    await assert.rejects(loadDuelCommitmentSecret(storage, "duel-one", "codex", "commitment-one"), /must start with agent-call/);

    storage.values.set(key, "x".repeat(16 * 1024 + 1));
    await assert.rejects(loadDuelCommitmentSecret(storage, "duel-one", "codex", "commitment-one"), /too large/);
  });

  test("deletes both participant secrets only after a durable reveal or cancellation", () => withIndex(async (indexFilePath) => {
    const storage = new MemorySecrets();
    await storeDuelCommitmentSecret(storage, indexFilePath, "duel-one", payload);
    await storeDuelCommitmentSecret(storage, indexFilePath, "duel-one", {
      ...payload,
      commitmentId: "commitment-two",
      participantId: "claude",
      captureRef: "agent-call:trace-two",
      agentReceipt: agentReceipt("claude", "trace-two"),
      answer: "The race is in the append path.",
    });
    await deleteDuelCommitmentSecrets(storage, indexFilePath, "duel-one", [
      { participantId: "codex", commitmentId: "commitment-one" },
      { participantId: "claude", commitmentId: "commitment-two" },
    ]);
    assert.equal(storage.values.size, 0);
    assert.deepEqual((await loadDuelCommitmentIndex(indexFilePath)).map((record) => record.state), ["deleted", "deleted"]);
  }));

  test("isolates competing same-participant attempts by commitment id", () => withIndex(async (indexFilePath) => {
    const storage = new MemorySecrets();
    const competing = { ...payload, commitmentId: "commitment-race", answer: "A competing answer." };
    await Promise.all([
      storeDuelCommitmentSecret(storage, indexFilePath, "duel-one", payload),
      storeDuelCommitmentSecret(storage, indexFilePath, "duel-one", competing),
    ]);

    await deleteDuelCommitmentSecrets(storage, indexFilePath, "duel-one", [{
      participantId: competing.participantId,
      commitmentId: competing.commitmentId,
    }]);

    assert.deepEqual(
      await loadDuelCommitmentSecret(storage, "duel-one", payload.participantId, payload.commitmentId),
      payload,
    );
    assert.equal(
      await loadDuelCommitmentSecret(storage, "duel-one", competing.participantId, competing.commitmentId),
      undefined,
    );
  }));

  test("a delete tombstone wins over an in-flight store of the same commitment", () => withIndex(async (indexFilePath) => {
    const storage = new GatedStoreSecrets();
    const storing = storeDuelCommitmentSecret(storage, indexFilePath, "duel-one", payload);
    await storage.storeStarted;

    await deleteDuelCommitmentSecrets(storage, indexFilePath, "duel-one", [{
      participantId: payload.participantId,
      commitmentId: payload.commitmentId,
    }]);
    storage.unblockStore();

    await assert.rejects(storing, /cancelled while its secret was being stored/);
    assert.equal(storage.values.size, 0);
    assert.equal((await loadDuelCommitmentIndex(indexFilePath))[0]?.state, "deleted");
  }));

  test("defers fresh unsealed records, then sweeps them after the cross-window grace period", () => withIndex(async (indexFilePath) => {
    const storage = new MemorySecrets();
    const storedAt = new Date();
    await storeDuelCommitmentSecret(storage, indexFilePath, "duel-orphan", payload);

    const fresh = await sweepDuelCommitmentSecrets(storage, indexFilePath, [], { now: storedAt });
    assert.equal(fresh.deferred, 1);
    assert.equal(fresh.deleted, 0);
    assert.ok(fresh.nextSweepAt);
    assert.equal(storage.values.size, 1);

    const stale = await sweepDuelCommitmentSecrets(storage, indexFilePath, [], {
      now: new Date(storedAt.getTime() + DUEL_SECRET_ORPHAN_GRACE_MS + 1_000),
    });
    assert.equal(stale.deleted, 1);
    assert.equal(storage.values.size, 0);
    assert.equal((await loadDuelCommitmentIndex(indexFilePath))[0]?.state, "deleted");
  }));

  test("retains an active durable seal and deletes it once paired reveal is durable", () => withIndex(async (indexFilePath) => {
    const storage = new MemorySecrets();
    const active = duelEvents("duel-terminal", false);
    await storeDuelCommitmentSecret(storage, indexFilePath, "duel-terminal", active.challengerPayload);
    await storeDuelCommitmentSecret(storage, indexFilePath, "duel-terminal", active.challengedPayload);

    const retained = await sweepDuelCommitmentSecrets(storage, indexFilePath, active.events, {
      now: new Date("2026-07-02T10:00:00.000Z"),
    });
    assert.equal(retained.retained, 2);
    assert.equal(retained.deleted, 0);
    assert.equal(storage.values.size, 2);

    const terminal = duelEvents("duel-terminal", true);
    const swept = await sweepDuelCommitmentSecrets(storage, indexFilePath, terminal.events, {
      now: new Date("2026-07-02T10:00:00.000Z"),
    });
    assert.equal(swept.deleted, 2);
    assert.equal(storage.values.size, 0);
  }));

  test("retries deletePending records after a SecretStorage failure", () => withIndex(async (indexFilePath) => {
    const storage = new MemorySecrets();
    await storeDuelCommitmentSecret(storage, indexFilePath, "duel-one", payload);
    storage.failDeletes = true;
    await assert.rejects(deleteDuelCommitmentSecrets(storage, indexFilePath, "duel-one", [{
      participantId: payload.participantId,
      commitmentId: payload.commitmentId,
    }]), /deletion failed/);
    assert.equal((await loadDuelCommitmentIndex(indexFilePath))[0]?.state, "deletePending");

    storage.failDeletes = false;
    const swept = await sweepDuelCommitmentSecrets(storage, indexFilePath, []);
    assert.equal(swept.deleted, 1);
    assert.equal(swept.failed, 0);
    assert.equal(storage.values.size, 0);
  }));

  test("cleans up terminal secrets created before the index existed", () => withIndex(async (indexFilePath) => {
    const storage = new MemorySecrets();
    const terminal = duelEvents("duel-legacy", true);
    for (const secret of [terminal.challengerPayload, terminal.challengedPayload]) {
      storage.values.set(
        duelCommitmentSecretKey("duel-legacy", secret.participantId, secret.commitmentId),
        JSON.stringify(secret),
      );
    }

    const swept = await sweepDuelCommitmentSecrets(storage, indexFilePath, terminal.events);
    assert.equal(swept.deleted, 2);
    assert.equal(storage.values.size, 0);
    assert.deepEqual((await loadDuelCommitmentIndex(indexFilePath)).map((record) => record.state), ["deleted", "deleted"]);
  }));
});
