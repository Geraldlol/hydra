import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
  STEERING_SCHEMA_VERSION,
  computeSteeringChainSha256,
  steeringTextMetrics,
  type SteeringRequestedEvent,
  type SteeringTargetOutcomeEvent,
} from "../src/steeringProtocol";
import {
  openFileSteeringPersistence,
  resolveOrphanedSteeringOnStartup,
  startSteeringOwnerLease,
  steeringPersistencePaths,
} from "../src/steeringPersistence";
import {
  PersistedSteeringStore,
  SteeringValidationError,
} from "../src/steeringStore";

const TIME = "2026-07-24T12:00:00.000Z";
const TEXT = "Use the deterministic acceptance check.";
const MISSION_DOCUMENT = "0".repeat(64);
const MISSION_BINDING = "1".repeat(64);
const AUTHORITY = "2".repeat(64);
const PROMPT = "3".repeat(64);

function requestEvent(
  suffix = "orphan",
  text = TEXT,
  ownerId = "extension-host-one",
): SteeringRequestedEvent {
  const metrics = steeringTextMetrics(text);
  return {
    schemaVersion: STEERING_SCHEMA_VERSION,
    type: "steeringRequested",
    eventId: `event-request-${suffix}`,
    occurredAt: TIME,
    steeringId: `steering-${suffix}`,
    source: "localUser",
    intent: "steer",
    roomTurnId: `room-turn-${suffix}`,
    textSha256: metrics.sha256,
    textCharacters: metrics.characters,
    textBytes: metrics.bytes,
    targets: [{
      callId: `call-${suffix}`,
      generation: `generation-${suffix}`,
      agentId: "codex",
      roomTurnId: `room-turn-${suffix}`,
      sequence: 1,
      expectedDelivery: "sameTurn",
      missionDocumentSha256: MISSION_DOCUMENT,
      missionBindingSha256: MISSION_BINDING,
      authoritySha256: AUTHORITY,
      initialPromptSha256: PROMPT,
      ownerId,
      workClass: "build",
    }],
  };
}

function deliveryStartedEvent(request: SteeringRequestedEvent) {
  const target = request.targets[0]!;
  return {
    schemaVersion: STEERING_SCHEMA_VERSION,
    type: "steeringDeliveryStarted",
    eventId: "event-start-orphan",
    occurredAt: TIME,
    steeringId: request.steeringId,
    callId: target.callId,
    generation: target.generation,
    sequence: target.sequence,
    priorSteeringChainSha256: computeSteeringChainSha256(PROMPT, []),
    priorChainIndeterminate: false,
  } as const;
}

async function privateRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-steering-private-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function outcomes(
  events: ReturnType<PersistedSteeringStore["events"]>,
): SteeringTargetOutcomeEvent[] {
  return events.filter(
    (event): event is SteeringTargetOutcomeEvent => event.type === "steeringTargetOutcome",
  );
}

describe("file steering persistence", () => {
  test("places authoritative files beneath the supplied private workspace root", async (t) => {
    const root = await privateRoot(t);
    const privateWorkspaceRoot = path.join(root, "extension-storage", "workspace-hash");
    const expected = {
      eventsPath: path.join(
        privateWorkspaceRoot,
        "steering",
        "events.v1.jsonl",
      ),
      pendingPath: path.join(
        privateWorkspaceRoot,
        "steering",
        "pending.v1.json",
      ),
      orphanRecoveryPath: path.join(
        privateWorkspaceRoot,
        "steering",
        "orphan-recovery.v1",
      ),
    };

    assert.deepEqual(steeringPersistencePaths(privateWorkspaceRoot), expected);
    const { paths } = await openFileSteeringPersistence(privateWorkspaceRoot);
    assert.deepEqual(paths, expected);
    assert.equal(await fs.readFile(paths.eventsPath, "utf8"), "");
    assert.deepEqual(
      JSON.parse(await fs.readFile(paths.pendingPath, "utf8")),
      { schemaVersion: STEERING_SCHEMA_VERSION, messages: [] },
    );
    assert.equal(path.relative(privateWorkspaceRoot, paths.eventsPath).startsWith(".."), false);
    assert.equal(path.relative(privateWorkspaceRoot, paths.pendingPath).startsWith(".."), false);
    assert.equal(path.relative(privateWorkspaceRoot, paths.orphanRecoveryPath).startsWith(".."), false);
  });

  test("fails closed on malformed and torn ledger records", async (t) => {
    const legacy = requestEvent("legacy");
    const legacyTarget = {
      ...legacy.targets[0],
      missionContractSha256: legacy.targets[0]!.missionBindingSha256,
    } as Record<string, unknown>;
    delete legacyTarget.missionDocumentSha256;
    delete legacyTarget.missionBindingSha256;
    for (const [name, content] of [
      ["malformed", "{not-json}\n"],
      ["torn", '{"schemaVersion":1,"type":"steeringRequested"'],
      ["legacy-ambiguous-mission-hash", `${JSON.stringify({
        ...legacy,
        targets: [legacyTarget],
      })}\n`],
    ] as const) {
      const root = path.join(await privateRoot(t), name);
      const { persistence, paths } = await openFileSteeringPersistence(root);
      await fs.writeFile(paths.eventsPath, content, "utf8");

      await assert.rejects(
        () => PersistedSteeringStore.open(persistence),
        (error: unknown) => error instanceof SteeringValidationError
          && error.issues.some((issue) => issue.code === "invalidEvent"),
      );
    }
  });

  test("rejects oversized records and bounded-file truncation before replay", async (t) => {
    const root = await privateRoot(t);
    const { persistence, paths } = await openFileSteeringPersistence(root);

    await fs.writeFile(paths.eventsPath, `${"x".repeat(1_000_001)}\n`, "utf8");
    await assert.rejects(
      () => persistence.loadEvents(),
      /oversized record/,
    );

    await fs.truncate(paths.pendingPath, (512 * 1024) + 1);
    await assert.rejects(
      () => persistence.loadPending(),
      /exceeds its bound/,
    );
  });

  test("classifies a pre-submit orphan as missed-window without replay", async (t) => {
    const root = await privateRoot(t);
    const { persistence, paths } = await openFileSteeringPersistence(root);
    const store = await PersistedSteeringStore.open(persistence);
    const request = requestEvent();
    await store.recordRequest(request, TEXT);
    assert.equal(store.pending().messages.length, 1);

    assert.equal(await resolveOrphanedSteeringOnStartup(store), 1);
    const terminal = outcomes(store.events());
    assert.equal(terminal.length, 1);
    assert.deepEqual(
      {
        outcome: terminal[0]?.outcome,
        disposition: terminal[0]?.disposition,
        code: terminal[0]?.code,
      },
      {
        outcome: "missedWindow",
        disposition: "rejected",
        code: "endedBeforeAcceptance",
      },
    );
    assert.equal(
      store.events().filter((event) => event.type === "steeringDeliveryStarted").length,
      1,
      "recovery records the fail-closed transition, but must not send to a provider",
    );
    assert.equal(store.pending().messages.length, 0);
    assert.equal((await fs.readFile(paths.pendingPath, "utf8")).includes(TEXT), false);
    assert.deepEqual(
      JSON.parse(await fs.readFile(paths.pendingPath, "utf8")),
      { schemaVersion: STEERING_SCHEMA_VERSION, messages: [] },
    );

    const eventCount = store.events().length;
    assert.equal(await resolveOrphanedSteeringOnStartup(store), 0);
    assert.equal(store.events().length, eventCount);
    const reopened = await PersistedSteeringStore.open(persistence);
    assert.equal(await resolveOrphanedSteeringOnStartup(reopened), 0);
    assert.equal(reopened.events().length, eventCount);
  });

  test("classifies a submitted orphan as delivery-unknown and never retries it", async (t) => {
    const root = await privateRoot(t);
    const { persistence, paths } = await openFileSteeringPersistence(root);
    const store = await PersistedSteeringStore.open(persistence);
    const request = requestEvent();
    await store.recordRequest(request, TEXT);
    await store.recordEvent(deliveryStartedEvent(request));

    assert.equal(await resolveOrphanedSteeringOnStartup(store), 1);
    const terminal = outcomes(store.events());
    assert.equal(terminal.length, 1);
    assert.deepEqual(
      {
        outcome: terminal[0]?.outcome,
        disposition: terminal[0]?.disposition,
        code: terminal[0]?.code,
        chainIndeterminate: terminal[0]?.chainIndeterminate,
      },
      {
        outcome: "deliveryUnknown",
        disposition: "deliveryUnknown",
        code: "processExit",
        chainIndeterminate: true,
      },
    );
    assert.equal(
      store.events().filter((event) => event.type === "steeringDeliveryStarted").length,
      1,
      "startup recovery must not issue a second delivery attempt",
    );
    assert.equal(store.pending().messages.length, 0);
    assert.equal((await fs.readFile(paths.pendingPath, "utf8")).includes(TEXT), false);

    const eventCount = store.events().length;
    assert.equal(await resolveOrphanedSteeringOnStartup(store), 0);
    assert.equal(store.events().length, eventCount);
    const reopened = await PersistedSteeringStore.open(persistence);
    assert.equal(await resolveOrphanedSteeringOnStartup(reopened), 0);
    assert.equal(reopened.events().length, eventCount);
  });

  test("does not recover another live extension-host owner's request", async (t) => {
    const root = await privateRoot(t);
    const { persistence } = await openFileSteeringPersistence(root);
    const store = await PersistedSteeringStore.open(persistence);
    const lease = await startSteeringOwnerLease(root, "extension-host-one");
    const request = requestEvent();
    await store.recordRequest(request, TEXT);

    assert.equal(
      await resolveOrphanedSteeringOnStartup(
        store,
        (ownerId) => lease.isOwnerActive(ownerId),
      ),
      0,
    );
    assert.equal(store.pending().messages.length, 1);
    assert.equal(outcomes(store.events()).length, 0);

    lease.dispose();
    assert.equal(await lease.isOwnerActive("extension-host-one"), false);
    assert.equal(
      await resolveOrphanedSteeringOnStartup(
        store,
        (ownerId) => lease.isOwnerActive(ownerId),
      ),
      1,
    );
    assert.equal(store.pending().messages.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test("merges concurrent host pending snapshots without dropping either body", async (t) => {
    const root = await privateRoot(t);
    const firstPersistence = await openFileSteeringPersistence(root);
    const secondPersistence = await openFileSteeringPersistence(root);
    const firstStore = await PersistedSteeringStore.open(firstPersistence.persistence);
    const secondStore = await PersistedSteeringStore.open(secondPersistence.persistence);
    const first = requestEvent("host-a", "Steer host A.", "owner-host-a");
    const second = requestEvent("host-b", "Steer host B.", "owner-host-b");

    await Promise.all([
      firstStore.recordRequest(first, "Steer host A."),
      secondStore.recordRequest(second, "Steer host B."),
    ]);

    const pendingAfterBoth = JSON.parse(
      await fs.readFile(firstPersistence.paths.pendingPath, "utf8"),
    ) as { messages: Array<{ steeringId: string }> };
    assert.deepEqual(
      pendingAfterBoth.messages.map((message) => message.steeringId).sort(),
      ["steering-host-a", "steering-host-b"],
    );

    assert.equal(
      await resolveOrphanedSteeringOnStartup(
        firstStore,
        async (ownerId) => ownerId === "owner-host-b",
      ),
      1,
    );
    const pendingAfterFirstResolved = JSON.parse(
      await fs.readFile(firstPersistence.paths.pendingPath, "utf8"),
    ) as { messages: Array<{ steeringId: string }> };
    assert.deepEqual(
      pendingAfterFirstResolved.messages.map((message) => message.steeringId),
      ["steering-host-b"],
    );

    const reopenedPersistence = await openFileSteeringPersistence(root);
    const reopened = await PersistedSteeringStore.open(reopenedPersistence.persistence);
    assert.deepEqual(
      reopened.pending().messages.map((message) => message.steeringId),
      ["steering-host-b"],
    );
    assert.equal(reopened.events().filter((event) => event.type === "steeringRequested").length, 2);
  });

  test("elects one cross-window orphan recovery and reloads before classification", async (t) => {
    const root = await privateRoot(t);
    const initialPersistence = await openFileSteeringPersistence(root);
    const initialStore = await PersistedSteeringStore.open(initialPersistence.persistence);
    const request = requestEvent("recovery-race", "Recover exactly once.", "dead-owner");
    await initialStore.recordRequest(request, "Recover exactly once.");

    // Both extension hosts intentionally open the same unresolved baseline
    // before either begins recovery. Without the distinct recovery election,
    // both stale stores append deliveryStarted + terminal outcome pairs and
    // permanently poison strict replay.
    const firstPersistence = await openFileSteeringPersistence(root);
    const secondPersistence = await openFileSteeringPersistence(root);
    const firstStore = await PersistedSteeringStore.open(firstPersistence.persistence);
    const secondStore = await PersistedSteeringStore.open(secondPersistence.persistence);

    const recovered = await Promise.all([
      resolveOrphanedSteeringOnStartup(firstStore, async () => false),
      resolveOrphanedSteeringOnStartup(secondStore, async () => false),
    ]);
    assert.deepEqual([...recovered].sort(), [0, 1]);

    const reopenedPersistence = await openFileSteeringPersistence(root);
    const reopened = await PersistedSteeringStore.open(reopenedPersistence.persistence);
    const events = reopened.events();
    assert.equal(events.filter((event) => event.type === "steeringRequested").length, 1);
    assert.equal(events.filter((event) => event.type === "steeringDeliveryStarted").length, 1);
    assert.equal(events.filter((event) => event.type === "steeringTargetOutcome").length, 1);
    assert.equal(reopened.pending().messages.length, 0);
    assert.equal(await resolveOrphanedSteeringOnStartup(reopened, async () => false), 0);
  });
});
