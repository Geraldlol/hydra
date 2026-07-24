import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  STEERING_LIMITS,
  STEERING_SCHEMA_VERSION,
  computeSteeringChainSha256,
  isSteeringCapability,
  isSteeringEvent,
  isSteeringProviderAcknowledgement,
  sha256Utf8,
  steeringTextMetrics,
  validateSteeringText,
  type SteeringCapability,
  type SteeringProviderAcknowledgement,
  type SteeringProviderRequest,
  type SteeringRequestedEvent,
  type SteeringTargetOutcomeEvent,
  type SteeringWorkClass,
} from "../src/steeringProtocol";
import {
  InMemorySteeringStore,
  PersistedSteeringStore,
  SteeringValidationError,
  emptySteeringPendingSnapshot,
  recoverSteeringPendingSnapshot,
  validateSteeringEvents,
  type SteeringPendingSnapshot,
  type SteeringPersistence,
} from "../src/steeringStore";
import {
  SteeringController,
  SteeringProviderError,
  SteeringRequestRejectedError,
  type ActiveRunInspection,
  type ActiveSteeringHandle,
  type ActiveSteeringRunRegistration,
  type LiveActiveSteeringHandle,
  type SteeringAcknowledgementWaitResult,
  type SteeringTargetSelection,
} from "../src/steeringController";

const TIME = "2026-07-24T12:00:00.000Z";
const OWNER = "extension-host-one";
const MISSION = "1".repeat(64);
const AUTHORITY = "2".repeat(64);
const PROMPT = "3".repeat(64);
const RECEIPT = "4".repeat(64);

function metrics(text: string) {
  return steeringTextMetrics(text);
}

function requestEvent(
  steeringId = "steering-one",
  sequence = 1,
  text = "Redirect toward the deterministic test.",
): SteeringRequestedEvent {
  const bound = metrics(text);
  return {
    schemaVersion: STEERING_SCHEMA_VERSION,
    type: "steeringRequested",
    eventId: `event-request-${steeringId}`,
    occurredAt: TIME,
    steeringId,
    source: "localUser",
    intent: "steer",
    roomTurnId: "room-turn-one",
    textSha256: bound.sha256,
    textCharacters: bound.characters,
    textBytes: bound.bytes,
    targets: [{
      callId: "call-one",
      generation: "generation-one",
      agentId: "codex",
      roomTurnId: "room-turn-one",
      sequence,
      expectedDelivery: "sameTurn",
      missionContractSha256: MISSION,
      authoritySha256: AUTHORITY,
      initialPromptSha256: PROMPT,
      ownerId: OWNER,
      workClass: "build",
    }],
  };
}

function startedEvent(request: SteeringRequestedEvent) {
  const target = request.targets[0]!;
  return {
    schemaVersion: STEERING_SCHEMA_VERSION,
    type: "steeringDeliveryStarted",
    eventId: `event-start-${request.steeringId}`,
    occurredAt: TIME,
    steeringId: request.steeringId,
    callId: target.callId,
    generation: target.generation,
    sequence: target.sequence,
    priorSteeringChainSha256: computeSteeringChainSha256(PROMPT, []),
    priorChainIndeterminate: false,
  } as const;
}

function acknowledgedEvent(request: SteeringRequestedEvent): SteeringTargetOutcomeEvent {
  const target = request.targets[0]!;
  return {
    schemaVersion: STEERING_SCHEMA_VERSION,
    type: "steeringTargetOutcome",
    eventId: `event-outcome-${request.steeringId}`,
    occurredAt: TIME,
    steeringId: request.steeringId,
    callId: target.callId,
    generation: target.generation,
    sequence: target.sequence,
    outcome: "acknowledged",
    disposition: "acceptedCurrent",
    code: "acknowledged",
    acknowledgedDelivery: "sameTurn",
    providerReceiptSha256: RECEIPT,
    steeringChainSha256: computeSteeringChainSha256(PROMPT, [request.textSha256]),
    chainIndeterminate: false,
  };
}

describe("steering protocol", () => {
  test("enforces UTF-8 message bounds and hashes exact content", () => {
    const exact = "x".repeat(STEERING_LIMITS.maxMessageBytes);
    assert.equal(validateSteeringText(exact).bytes, STEERING_LIMITS.maxMessageBytes);
    assert.throws(
      () => validateSteeringText(`${exact}x`),
      new RegExp(String(STEERING_LIMITS.maxMessageBytes)),
    );
    assert.throws(
      () => validateSteeringText("🙂".repeat((STEERING_LIMITS.maxMessageBytes / 4) + 1)),
      /UTF-8 bytes/,
    );
    assert.notEqual(sha256Utf8("steer A"), sha256Utf8("steer B"));
  });

  test("rejects impossible capability, event, and acknowledgement schemas", () => {
    assert.equal(isSteeringCapability({
      kind: "live",
      delivery: "sameTurn",
      protocol: "codex-app-server-v1",
    }), true);
    assert.equal(isSteeringCapability({
      kind: "live",
      delivery: "nextHydraTurn",
      protocol: "dishonest-live-label",
    }), false);
    assert.equal(isSteeringCapability({
      kind: "disabled",
      delivery: "unsupported",
      reason: "No parity proof.",
      unexpected: true,
    }), false);

    const valid = requestEvent();
    assert.equal(isSteeringEvent(valid), true);
    assert.equal(isSteeringEvent({ ...valid, schemaVersion: 2 }), false);
    assert.equal(isSteeringEvent({ ...valid, text: "must never enter ledger" }), false);
    assert.equal(isSteeringEvent({
      ...valid,
      targets: [{ ...valid.targets[0], expectedDelivery: "invented" }],
    }), false);

    const acknowledgement = providerAcknowledgement({
      steeringId: valid.steeringId,
      textSha256: valid.textSha256,
      target: valid.targets[0]!,
      text: "unused",
      textCharacters: valid.textCharacters,
      textBytes: valid.textBytes,
      source: "localUser",
      intent: "steer",
      schemaVersion: STEERING_SCHEMA_VERSION,
    });
    assert.equal(isSteeringProviderAcknowledgement(acknowledgement), true);
    assert.equal(isSteeringProviderAcknowledgement({ ...acknowledgement, extra: "forged" }), false);
  });
});

describe("steering replay and pending state", () => {
  test("replays a source-bound chain and removes terminal message bodies", async () => {
    const requested = requestEvent();
    const store = new InMemorySteeringStore();
    await store.recordRequest(requested, "Redirect toward the deterministic test.");
    assert.equal(store.pending().messages.length, 1);
    assert.equal(JSON.stringify(store.events()).includes("Redirect toward"), false);
    await store.recordEvent(startedEvent(requested));
    await store.recordEvent(acknowledgedEvent(requested));
    assert.equal(store.pending().messages.length, 0);
    assert.deepEqual(store.chainBinding("call-one", "generation-one"), {
      schemaVersion: STEERING_SCHEMA_VERSION,
      callId: "call-one",
      generation: "generation-one",
      steeringChainSha256: computeSteeringChainSha256(PROMPT, [requested.textSha256]),
      chainIndeterminate: false,
      lastSequence: 1,
      lastTerminalSequence: 1,
      lastAcknowledgedSequence: 1,
    });
  });

  test("fails closed on unknown versions, duplicates, torn references, and sequence gaps", () => {
    const requested = requestEvent();
    const duplicateId = { ...requestEvent("steering-two"), eventId: requested.eventId };
    const sequenceGap = requestEvent("steering-gap", 3);
    const orphanStart = { ...startedEvent(requested), steeringId: "missing-request", eventId: "event-orphan" };
    const issues = validateSteeringEvents([
      null,
      { ...requested, schemaVersion: 99 },
      requested,
      duplicateId,
      sequenceGap,
      orphanStart,
    ]);
    const codes = new Set(issues.map((entry) => entry.code));
    for (const code of [
      "invalidEvent",
      "unknownVersion",
      "duplicateEvent",
      "invalidSequence",
      "invalidReference",
    ]) {
      assert.equal(codes.has(code as never), true, `missing ${code}`);
    }
    assert.throws(
      () => new InMemorySteeringStore([requested, orphanStart], emptySteeringPendingSnapshot()),
      SteeringValidationError,
    );
  });

  test("recovers stale resolved pending targets but rejects missing, orphaned, or altered bodies", () => {
    const requested = requestEvent();
    const events = [requested, startedEvent(requested), acknowledgedEvent(requested)];
    const body: SteeringPendingSnapshot = {
      schemaVersion: STEERING_SCHEMA_VERSION,
      messages: [{
        steeringId: requested.steeringId,
        text: "Redirect toward the deterministic test.",
        textSha256: requested.textSha256,
        textCharacters: requested.textCharacters,
        textBytes: requested.textBytes,
        unresolvedTargets: [{
          callId: "call-one",
          generation: "generation-one",
          sequence: 1,
        }],
      }],
    };
    const recovered = recoverSteeringPendingSnapshot(events, body);
    assert.equal(recovered.issues.length, 0);
    assert.equal(recovered.changed, true);
    assert.deepEqual(recovered.snapshot.messages, []);

    const unresolvedMissing = recoverSteeringPendingSnapshot([requested], emptySteeringPendingSnapshot());
    assert.ok(unresolvedMissing.issues.some((entry) => entry.code === "missingPending"));

    const orphan = recoverSteeringPendingSnapshot([], body);
    assert.ok(orphan.issues.some((entry) => entry.code === "invalidPending"));

    const altered = recoverSteeringPendingSnapshot([requested], {
      ...body,
      messages: [{ ...body.messages[0]!, text: "Altered after hashing." }],
    });
    assert.ok(altered.issues.some((entry) => entry.code === "hashMismatch"));
  });

  test("bounds total pending content and unresolved room records", () => {
    const makePendingRequest = (index: number, text: string) => {
      const event = requestEvent(`steering-bounds-${index}`, 1, text);
      const target = {
        ...event.targets[0]!,
        callId: `call-bounds-${index}`,
        generation: `generation-bounds-${index}`,
      };
      return {
        event: { ...event, targets: [target] },
        pending: {
          steeringId: event.steeringId,
          text,
          textSha256: event.textSha256,
          textCharacters: event.textCharacters,
          textBytes: event.textBytes,
          unresolvedTargets: [{
            callId: target.callId,
            generation: target.generation,
            sequence: 1,
          }],
        },
      };
    };
    const atByteLimit = Array.from({ length: 4 }, (_, index) =>
      makePendingRequest(index, "x".repeat(STEERING_LIMITS.maxMessageBytes))
    );
    assert.equal(recoverSteeringPendingSnapshot(
      atByteLimit.map(({ event }) => event),
      {
        schemaVersion: STEERING_SCHEMA_VERSION,
        messages: atByteLimit.map(({ pending }) => pending),
      },
    ).issues.length, 0);
    const overByteLimit = [
      ...atByteLimit,
      makePendingRequest(4, "one byte beyond the aggregate bound"),
    ];
    assert.ok(recoverSteeringPendingSnapshot(
      overByteLimit.map(({ event }) => event),
      {
        schemaVersion: STEERING_SCHEMA_VERSION,
        messages: overByteLimit.map(({ pending }) => pending),
      },
    ).issues.some((entry) => entry.code === "boundsExceeded"));

    const roomOverflow = Array.from(
      { length: STEERING_LIMITS.maxUnresolvedMessagesPerRoom + 1 },
      (_, index) => makePendingRequest(index, `room item ${index}`),
    );
    assert.ok(validateSteeringEvents(roomOverflow.map(({ event }) => event)).some((entry) =>
      entry.code === "boundsExceeded"
    ));
  });

  test("persists request bodies before append and compacts only after terminal append", async () => {
    class FakePersistence implements SteeringPersistence {
      events: unknown[] = [];
      pendingValue: unknown = emptySteeringPendingSnapshot();
      operations: string[] = [];
      async loadEvents() { return this.events; }
      async loadPending() { return this.pendingValue; }
      async appendEvents(events: readonly unknown[]) {
        this.operations.push(`append:${(events[0] as { type: string }).type}`);
        this.events.push(...events);
      }
      async writePending(snapshot: SteeringPendingSnapshot) {
        this.operations.push(`pending:${snapshot.messages.length}`);
        this.pendingValue = snapshot;
      }
    }
    const persistence = new FakePersistence();
    const store = await PersistedSteeringStore.open(persistence);
    const requested = requestEvent();
    await store.recordRequest(requested, "Redirect toward the deterministic test.");
    await store.recordEvent(startedEvent(requested));
    await store.recordEvent(acknowledgedEvent(requested));
    assert.deepEqual(persistence.operations, [
      "pending:1",
      "append:steeringRequested",
      "append:steeringDeliveryStarted",
      "append:steeringTargetOutcome",
      "pending:0",
    ]);
    assert.equal(JSON.stringify(persistence.events).includes("Redirect toward"), false);
  });
});

class FakeHandle implements LiveActiveSteeringHandle {
  readonly requests: SteeringProviderRequest[] = [];
  readonly closes: Array<"completed" | "cancelled" | "failed"> = [];
  inspection: ActiveRunInspection;
  response?: (request: SteeringProviderRequest) => Promise<unknown>;

  constructor(
    callId: string,
    generation: string,
    readonly capability: Extract<SteeringCapability, { kind: "live" }> = {
      kind: "live",
      delivery: "sameTurn",
      protocol: "fake-live-v1",
    },
  ) {
    this.inspection = {
      callId,
      generation,
      active: true,
      ownerId: OWNER,
      missionContractSha256: MISSION,
      authoritySha256: AUTHORITY,
    };
  }

  async inspect() {
    return { ...this.inspection };
  }

  async steer(request: SteeringProviderRequest) {
    this.requests.push(request);
    if (this.response) return this.response(request);
    return providerAcknowledgement(request, this.capability.delivery);
  }

  async close(reason: "completed" | "cancelled" | "failed") {
    this.closes.push(reason);
    this.inspection = { ...this.inspection, active: false };
  }
}

function providerAcknowledgement(
  request: SteeringProviderRequest,
  delivery: Exclude<SteeringProviderAcknowledgement["delivery"], "unsupported"> = "sameTurn",
): SteeringProviderAcknowledgement {
  return {
    schemaVersion: STEERING_SCHEMA_VERSION,
    status: "acknowledged",
    steeringId: request.steeringId,
    callId: request.target.callId,
    generation: request.target.generation,
    sequence: request.target.sequence,
    textSha256: request.textSha256,
    delivery,
    providerReceiptSha256: sha256Utf8(`provider:${request.target.callId}:${request.target.sequence}`),
  };
}

function registration(
  handle: ActiveSteeringHandle,
  options: {
    callId?: string;
    generation?: string;
    agentId?: string;
    roomTurnId?: string;
    workClass?: SteeringWorkClass;
    phaseSnapshot?: string;
    timeoutDeadlineMs?: number;
  } = {},
): ActiveSteeringRunRegistration {
  return {
    callId: options.callId ?? "call-one",
    generation: options.generation ?? "generation-one",
    agentId: options.agentId ?? "codex",
    roomTurnId: options.roomTurnId ?? "room-turn-one",
    missionContractSha256: MISSION,
    authoritySha256: AUTHORITY,
    initialPromptSha256: PROMPT,
    ownerId: OWNER,
    workClass: options.workClass ?? "build",
    phaseSnapshot: options.phaseSnapshot ?? "Build",
    ...(options.timeoutDeadlineMs === undefined ? {} : { timeoutDeadlineMs: options.timeoutDeadlineMs }),
    handle,
  };
}

function controllerOptions(
  store = new InMemorySteeringStore(),
  overrides: Partial<ConstructorParameters<typeof SteeringController>[0]> = {},
) {
  let id = 0;
  return {
    store,
    ownerId: OWNER,
    now: () => TIME,
    newId: (kind: "steering" | "event") => `${kind}-${++id}`,
    acknowledgementTimeoutMs: 100,
    ...overrides,
  };
}

describe("steering controller with deterministic providers", () => {
  test("targets exact call generations, preserves invariants, and binds ordered chain receipts", async () => {
    const handle = new FakeHandle("call-one", "generation-one");
    const controller = new SteeringController(controllerOptions());
    const original = registration(handle, {
      phaseSnapshot: "Build",
      timeoutDeadlineMs: 123456,
    });
    const selected = controller.registerRun(original);
    const first = await controller.send({
      source: "localUser",
      intent: "steer",
      roomTurnId: "room-turn-one",
      text: "First correction.",
      targets: [selected],
    });
    const second = await controller.send({
      source: "localUser",
      intent: "steer",
      roomTurnId: "room-turn-one",
      text: "Second correction.",
      targets: [selected],
    });
    assert.deepEqual(handle.requests.map((request) => request.target.sequence), [1, 2]);
    assert.ok(handle.requests.every((request) =>
      request.target.callId === "call-one"
      && request.target.generation === "generation-one"
      && request.target.agentId === "codex"
    ));
    const expected = computeSteeringChainSha256(PROMPT, [
      sha256Utf8("First correction."),
      sha256Utf8("Second correction."),
    ]);
    assert.equal(second.chainBindings[0]?.steeringChainSha256, expected);
    assert.equal(second.chainBindings[0]?.chainIndeterminate, false);
    assert.equal(first.outcomes[0]?.disposition, "acceptedCurrent");

    // No controller API can mutate these snapshots; the original transport
    // authority, phase, and deadline remain byte-for-byte unchanged.
    assert.equal(original.authoritySha256, AUTHORITY);
    assert.equal(original.phaseSnapshot, "Build");
    assert.equal(original.timeoutDeadlineMs, 123456);
    assert.equal(controller.targetSelections()[0]?.timeoutDeadlineMs, 123456);
  });

  test("serializes each run FIFO while broadcasts settle independently", async () => {
    const firstHandle = new FakeHandle("call-a", "generation-a");
    const secondHandle = new FakeHandle("call-b", "generation-b", {
      kind: "live",
      delivery: "sameSessionNextTurn",
      protocol: "fake-session-v1",
    });
    let releaseFirst!: (value: unknown) => void;
    firstHandle.response = (request) => new Promise((resolve) => {
      releaseFirst = () => resolve(providerAcknowledgement(request));
    });
    const controller = new SteeringController(controllerOptions());
    const firstSelection = controller.registerRun(registration(firstHandle, {
      callId: "call-a",
      generation: "generation-a",
      agentId: "codex",
    }));
    const secondSelection = controller.registerRun(registration(secondHandle, {
      callId: "call-b",
      generation: "generation-b",
      agentId: "claude",
    }));
    const broadcast = controller.send({
      source: "localUser",
      intent: "steer",
      roomTurnId: "room-turn-one",
      text: "Broadcast evidence.",
      targets: [firstSelection, secondSelection],
    });
    await tick();
    assert.equal(firstHandle.requests.length, 1);
    assert.equal(secondHandle.requests.length, 1);
    releaseFirst(undefined);
    const receipt = await broadcast;
    assert.deepEqual(
      receipt.outcomes.map((outcome) => outcome.disposition),
      ["acceptedCurrent", "queuedProvider"],
    );
  });

  test("labels live, next-dispatch, and disabled providers honestly", async () => {
    const live = new FakeHandle("call-live", "generation-live");
    const queuedInspection: ActiveRunInspection = {
      callId: "call-queue",
      generation: "generation-queue",
      active: true,
      ownerId: OWNER,
      missionContractSha256: MISSION,
      authoritySha256: AUTHORITY,
    };
    const queued: ActiveSteeringHandle = {
      capability: {
        kind: "nextDispatch",
        delivery: "nextHydraTurn",
        reason: "This CLI has no persistent control channel.",
      },
      inspect: () => ({ ...queuedInspection }),
      close: async () => undefined,
    };
    const disabled: ActiveSteeringHandle = {
      capability: {
        kind: "disabled",
        delivery: "unsupported",
        reason: "Invocation parity probe failed.",
      },
      inspect: () => ({
        ...queuedInspection,
        callId: "call-disabled",
        generation: "generation-disabled",
      }),
      close: async () => undefined,
    };
    const queuedRequests: SteeringProviderRequest[] = [];
    const controller = new SteeringController(controllerOptions(undefined, {
      queueNextHydraTurn: async (request) => {
        queuedRequests.push(request);
        return providerAcknowledgement(request, "nextHydraTurn");
      },
    }));
    const selections = [
      controller.registerRun(registration(live, {
        callId: "call-live",
        generation: "generation-live",
      })),
      controller.registerRun(registration(queued, {
        callId: "call-queue",
        generation: "generation-queue",
        agentId: "generic",
      })),
      controller.registerRun(registration(disabled, {
        callId: "call-disabled",
        generation: "generation-disabled",
        agentId: "disabled",
      })),
    ];
    const receipt = await controller.send({
      source: "localUser",
      intent: "steer",
      roomTurnId: "room-turn-one",
      text: "Use the corrected acceptance check.",
      targets: selections,
    });
    assert.deepEqual(receipt.outcomes.map(({ outcome, disposition }) => ({
      outcome,
      disposition,
    })), [
      { outcome: "acknowledged", disposition: "acceptedCurrent" },
      { outcome: "acknowledged", disposition: "queuedHydra" },
      { outcome: "unsupported", disposition: "rejected" },
    ]);
    assert.equal(queuedRequests.length, 1);
  });

  test("rejects target tampering and never silently retargets a stale generation", async () => {
    const firstHandle = new FakeHandle("reused-call", "generation-one");
    const controller = new SteeringController(controllerOptions());
    const first = controller.registerRun(registration(firstHandle, {
      callId: "reused-call",
      generation: "generation-one",
    }));
    const tampered = { ...first, agentId: "another-head" };
    await assert.rejects(
      controller.send({
        source: "localUser",
        intent: "steer",
        roomTurnId: "room-turn-one",
        text: "Tampered selection.",
        targets: [tampered],
      }),
      (error: unknown) => error instanceof SteeringRequestRejectedError
        && error.code === "invalidTarget",
    );
    await assert.rejects(
      controller.send({
        source: "localUser",
        intent: "steer",
        roomTurnId: "room-turn-one",
        text: "Extra target field.",
        targets: [{ ...first, unexpected: true } as SteeringTargetSelection],
      }),
      (error: unknown) => error instanceof SteeringRequestRejectedError
        && error.code === "invalidTarget",
    );

    await controller.closeRun(first, "completed");
    const secondHandle = new FakeHandle("reused-call", "generation-two");
    controller.registerRun(registration(secondHandle, {
      callId: "reused-call",
      generation: "generation-two",
    }));
    const stale = await controller.send({
      source: "localUser",
      intent: "steer",
      roomTurnId: "room-turn-one",
      text: "Must not reach generation two.",
      targets: [first],
    });
    assert.equal(stale.outcomes[0]?.code, "staleHandle");
    assert.equal(secondHandle.requests.length, 0);
  });

  test("rechecks mission, authority, and owner bindings before every provider write", async () => {
    for (const [field, replacement, expectedCode] of [
      ["missionContractSha256", "a".repeat(64), "missionHashMismatch"],
      ["authoritySha256", "b".repeat(64), "authorityHashMismatch"],
      ["ownerId", "another-extension-host", "remoteOwner"],
    ] as const) {
      const callId = `call-${field}`;
      const generation = `generation-${field}`;
      const handle = new FakeHandle(callId, generation);
      const controller = new SteeringController(controllerOptions());
      const selected = controller.registerRun(registration(handle, { callId, generation }));
      handle.inspection = { ...handle.inspection, [field]: replacement };
      const receipt = await controller.send({
        source: "localUser",
        intent: "steer",
        roomTurnId: "room-turn-one",
        text: `Reject changed ${field}.`,
        targets: [selected],
      });
      assert.equal(receipt.outcomes[0]?.code, expectedCode);
      assert.equal(handle.requests.length, 0);
    }
  });

  test("rejects sealed, referee, verification, and locked Arena work without provider writes", async () => {
    for (const [workClass, expectedCode] of [
      ["sealedJury", "sealedWork"],
      ["formalDuel", "sealedWork"],
      ["deterministicReferee", "sealedWork"],
      ["verification", "nonInteractiveWork"],
      ["hiddenMaintenance", "nonInteractiveWork"],
      ["arenaLocked", "lockedArena"],
    ] as const) {
      const callId = `call-${workClass}`;
      const generation = `generation-${workClass}`;
      const handle = new FakeHandle(callId, generation);
      const controller = new SteeringController(controllerOptions());
      const selected = controller.registerRun(registration(handle, {
        callId,
        generation,
        workClass,
      }));
      const receipt = await controller.send({
        source: "localUser",
        intent: "steer",
        roomTurnId: "room-turn-one",
        text: `Forbidden ${workClass} steering.`,
        targets: [selected],
      });
      assert.equal(receipt.outcomes[0]?.code, expectedCode);
      assert.equal(handle.requests.length, 0);
    }
  });

  test("marks acknowledgement loss indeterminate without retrying", async () => {
    const handle = new FakeHandle("call-one", "generation-one");
    handle.response = async () => new Promise(() => undefined);
    let waits = 0;
    const waitForAcknowledgement = async (): Promise<SteeringAcknowledgementWaitResult> => {
      waits += 1;
      return { kind: "timeout" };
    };
    const controller = new SteeringController(controllerOptions(undefined, {
      waitForAcknowledgement,
    }));
    const selected = controller.registerRun(registration(handle));
    const receipt = await controller.send({
      source: "localUser",
      intent: "steer",
      roomTurnId: "room-turn-one",
      text: "Acknowledge exactly once.",
      targets: [selected],
    });
    assert.equal(waits, 1);
    assert.equal(handle.requests.length, 1);
    assert.equal(receipt.outcomes[0]?.outcome, "deliveryUnknown");
    assert.equal(receipt.outcomes[0]?.code, "acknowledgementTimeout");
    assert.equal(receipt.chainBindings[0]?.chainIndeterminate, true);
    assert.equal(
      receipt.chainBindings[0]?.steeringChainSha256,
      computeSteeringChainSha256(PROMPT, []),
    );
  });

  test("treats malformed or mismatched acknowledgements as unknown, not success", async () => {
    const handle = new FakeHandle("call-one", "generation-one");
    handle.response = async (request) => ({
      ...providerAcknowledgement(request),
      generation: "wrong-generation",
    });
    const controller = new SteeringController(controllerOptions());
    const selected = controller.registerRun(registration(handle));
    const receipt = await controller.send({
      source: "localUser",
      intent: "steer",
      roomTurnId: "room-turn-one",
      text: "Bind the exact generation.",
      targets: [selected],
    });
    assert.equal(receipt.outcomes[0]?.code, "malformedAcknowledgement");
    assert.equal(receipt.outcomes[0]?.chainIndeterminate, true);
  });

  test("distinguishes known pre-write failures from uncertain provider exits", async () => {
    for (const [mayHaveOccurred, expected] of [
      [false, "failed"],
      [true, "deliveryUnknown"],
    ] as const) {
      const handle = new FakeHandle("call-one", "generation-one");
      handle.response = async () => {
        throw new SteeringProviderError("processExit", mayHaveOccurred, "Fake process exited.");
      };
      const controller = new SteeringController(controllerOptions());
      const selected = controller.registerRun(registration(handle));
      const receipt = await controller.send({
        source: "localUser",
        intent: "steer",
        roomTurnId: "room-turn-one",
        text: `Exit classification ${mayHaveOccurred}.`,
        targets: [selected],
      });
      assert.equal(receipt.outcomes[0]?.outcome, expected);
      assert.equal(receipt.outcomes[0]?.code, "processExit");
    }
  });

  test("enforces the monotonic per-run unresolved queue bound", async () => {
    const handle = new FakeHandle("call-one", "generation-one");
    let releaseFirst!: () => void;
    let first = true;
    handle.response = (request) => {
      if (!first) return Promise.resolve(providerAcknowledgement(request));
      first = false;
      return new Promise((resolve) => {
        releaseFirst = () => resolve(providerAcknowledgement(request));
      });
    };
    const controller = new SteeringController(controllerOptions());
    const selected = controller.registerRun(registration(handle));
    const pending: Promise<unknown>[] = [];
    for (let index = 0; index < STEERING_LIMITS.maxUnresolvedMessagesPerRun; index += 1) {
      pending.push(controller.send({
        source: "localUser",
        intent: "steer",
        roomTurnId: "room-turn-one",
        text: `Queued steer ${index + 1}.`,
        targets: [selected],
      }));
    }
    await tick();
    await assert.rejects(
      controller.send({
        source: "localUser",
        intent: "steer",
        roomTurnId: "room-turn-one",
        text: "This ninth steer must be rejected.",
        targets: [selected],
      }),
      (error: unknown) => error instanceof SteeringRequestRejectedError
        && error.code === "queueFull",
    );
    releaseFirst();
    await Promise.all(pending);
    assert.deepEqual(
      handle.requests.map((request) => request.target.sequence),
      Array.from({ length: STEERING_LIMITS.maxUnresolvedMessagesPerRun }, (_, index) => index + 1),
    );
  });

  test("completion closes acceptance and does not cancel or reset the provider run", async () => {
    const handle = new FakeHandle("call-one", "generation-one");
    const controller = new SteeringController(controllerOptions());
    const selected = controller.registerRun(registration(handle));
    await controller.closeRun(selected, "completed");
    assert.deepEqual(handle.closes, ["completed"]);
    assert.deepEqual(controller.targetSelections(), []);
    const receipt = await controller.send({
      source: "localUser",
      intent: "steer",
      roomTurnId: "room-turn-one",
      text: "Arrived after completion.",
      targets: [selected],
    });
    assert.equal(receipt.outcomes[0]?.code, "endedBeforeAcceptance");
    assert.equal(handle.requests.length, 0);
    assert.deepEqual(handle.closes, ["completed"]);
  });
});

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
