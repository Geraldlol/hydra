import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, type TestContext } from "node:test";
import { FlightRecorderController } from "../src/flightRecorderController";
import {
  createFlightRecorderRuntime,
  mapFlightRunResult,
  type BeginFlightAgentRunInput,
  type FlightRecorderRuntimeNotice,
} from "../src/flightRecorderRuntime";
import {
  flightTracePath,
  openFileFlightRecorderStore,
  type FlightRecorderStore,
} from "../src/flightRecorderStore";

const MISSION = "1".repeat(64);
const DOCUMENT = "2".repeat(64);
const AUTHORITY = "3".repeat(64);
const PROMPT = "4".repeat(64);
const CONTEXT = "5".repeat(64);
const INITIAL_CHAIN = "6".repeat(64);
const TERMINAL_CHAIN = "7".repeat(64);
const EMPTY_OUTPUT = Object.freeze({
  bytes: 0,
  sha256: createHash("sha256").update("", "utf8").digest("hex"),
});

async function tempRoot(
  t: TestContext,
  prefix = "hydra-flight-runtime-",
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function agentInput(runId = "run-one"): BeginFlightAgentRunInput {
  return {
    runId,
    headId: "codex",
    agentKind: "codex",
    phase: "Build",
    provider: "openai",
    model: "gpt-test",
    plannedTransport: "appServer",
    authorityClass: "workspaceWrite",
    authoritySha256: AUTHORITY,
    promptSha256: PROMPT,
    contextSha256: CONTEXT,
    promptCharacters: 123,
    telemetryDetail: "structured",
    initialSteeringChain: {
      sha256: INITIAL_CHAIN,
      indeterminate: false,
    },
    evidenceClass: "hydraObserved",
  };
}

function mustSettlePromptly<T>(
  promise: Promise<T>,
  timeoutMs = 1_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Recorder lifecycle call blocked on persistence."));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

describe("Flight Recorder runtime", () => {
  test("records a staged room/phase/agent lifecycle and preserves the exact terminal steering chain", async (t) => {
    const root = await tempRoot(t);
    const mirrorPath = path.join(root, "workspace-mirror", "flight-recorder.md");
    const runtime = await createFlightRecorderRuntime({
      privateWorkspaceRoot: root,
      ownerId: "extension-host-one",
      mirrorPath,
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    });
    t.after(() => runtime.dispose());
    assert.equal(runtime.enabled, true);
    assert.equal(runtime.notice, undefined);

    const room = await runtime.beginRoomTurn({
      traceId: "trace-runtime-lifecycle",
      roomTurnId: "room-turn-one",
      phase: "Build",
      missionDocumentSha256: DOCUMENT,
      missionBindingSha256: MISSION,
      source: "localUser",
      baseRevisionSha: "a".repeat(40),
    });
    assert.equal(room.recorded, true);

    const agent = await runtime.beginAgentRun(room, agentInput());
    assert.equal(agent.recorded, true);
    assert.equal(await runtime.finishAgentRun(agent, {
      status: "succeeded",
      failureCode: null,
      output: EMPTY_OUTPUT,
      terminalSteeringChain: {
        sha256: TERMINAL_CHAIN,
        indeterminate: true,
      },
      actualTransport: "appServer",
      evidenceClass: "providerObserved",
    }), true);
    assert.equal(await runtime.finishRoomTurn(room, {
      status: "succeeded",
      failureCode: null,
    }), true);
    await runtime.flushDerivedWork(room.traceId);

    const store = await openFileFlightRecorderStore(root);
    const replay = await store.load(room.traceId);
    assert.equal(replay?.completeness, "complete");
    assert.deepEqual(
      replay?.records.map((record) => record.recordType),
      [
        "traceStarted",
        "operationStarted",
        "operationStarted",
        "operationFinished",
        "operationFinished",
        "traceFinished",
      ],
    );
    const agentStart = replay?.records.find((record) =>
      record.recordType === "operationStarted"
      && record.operationKind === "agentRun"
    );
    assert.deepEqual(
      agentStart?.payload.payloadType === "operationStarted"
        ? agentStart.payload.subject
        : undefined,
      { kind: "agentRun", ...agentInput() },
    );
    const agentFinish = replay?.records.find((record) =>
      record.recordType === "operationFinished"
      && record.operationKind === "agentRun"
    );
    assert.deepEqual(
      agentFinish?.payload.payloadType === "operationFinished"
        ? {
            steeringChain: agentFinish.payload.steeringChain,
            actualTransport: agentFinish.payload.actualTransport,
          }
        : undefined,
      {
        steeringChain: {
          sha256: TERMINAL_CHAIN,
          indeterminate: true,
        },
        actualTransport: "appServer",
      },
    );

    const traceText = await fs.readFile(
      flightTracePath(root, room.traceId),
      "utf8",
    );
    for (const forbiddenKey of [
      "\"stdout\"",
      "\"stderr\"",
      "\"argv\"",
      "\"env\"",
      "\"cwd\"",
      "\"promptBody\"",
      "\"resultBody\"",
    ]) {
      assert.equal(traceText.includes(forbiddenKey), false);
    }
    const mirror = await fs.readFile(mirrorPath, "utf8");
    assert.match(mirror, /Disposable metadata-only mirror/);
    assert.equal(mirror.includes(MISSION), false);
    assert.equal(mirror.includes(PROMPT), false);
  });

  test("records phase plus usage, verification, and native-action children in exact lifecycle order", async (t) => {
    const root = await tempRoot(t);
    const runtime = await createFlightRecorderRuntime({
      privateWorkspaceRoot: root,
      ownerId: "extension-host-auxiliary-lifecycle",
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    });
    t.after(() => runtime.dispose());

    const room = await runtime.beginRoomTurn({
      traceId: "trace-runtime-auxiliary-lifecycle",
      roomTurnId: "room-turn-auxiliary-lifecycle",
      phase: "Opener",
      missionDocumentSha256: DOCUMENT,
      missionBindingSha256: MISSION,
      source: "localUser",
      baseRevisionSha: "a".repeat(40),
    });
    assert.equal(await runtime.recordPhaseTransition(room, {
      fromPhase: "AwaitingUser",
      toPhase: "Opener",
      trigger: "userSent",
      occurredAt: "2026-07-24T11:59:59.000Z",
    }), true);

    const runId = "run-auxiliary-lifecycle";
    const agent = await runtime.beginAgentRun(room, agentInput(runId));
    const terminalSteeringChain = {
      sha256: TERMINAL_CHAIN,
      indeterminate: true,
    } as const;
    const usage = await runtime.beginAuxiliaryOperation(room, {
      parentOperationId: agent.operationId,
      subject: {
        kind: "usage",
        usageId: "usage-auxiliary-lifecycle",
        runId,
        model: "gpt-test",
        source: "native",
        evidenceClass: "providerObserved",
      },
    });
    assert.equal(usage.recorded, true);
    assert.equal(usage.parentOperationId, agent.operationId);
    assert.equal(await runtime.finishAuxiliaryOperation(usage, {
      status: "succeeded",
      failureCode: null,
      observation: {
        kind: "usage",
        observationType: "usageSummary",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
        reasoningTokens: 5,
        totalCostUsd: 0.25,
        costSource: "native",
        steeringChain: terminalSteeringChain,
        evidenceClass: "providerObserved",
      },
    }), true);
    assert.equal(await runtime.finishAgentRun(agent, {
      status: "succeeded",
      failureCode: null,
      output: EMPTY_OUTPUT,
      terminalSteeringChain,
      actualTransport: "appServer",
      evidenceClass: "providerObserved",
    }), true);

    const verification = await runtime.beginAuxiliaryOperation(room, {
      subject: {
        kind: "verification",
        verificationId: "verification-auxiliary-lifecycle",
        planSha256: "8".repeat(64),
        invocationShapeSha256: "9".repeat(64),
        sourceRunId: runId,
        sourceSteeringChain: terminalSteeringChain,
        evidenceClass: "hydraObserved",
      },
    });
    assert.equal(verification.recorded, true);
    assert.equal(verification.parentOperationId, room.phaseOperationId);
    assert.equal(await runtime.finishAuxiliaryOperation(verification, {
      status: "succeeded",
      failureCode: null,
      observation: {
        kind: "verification",
        observationType: "verificationReceipt",
        receiptSha256: "a".repeat(64),
        headRevisionSha: "b".repeat(40),
        exitCode: 0,
        stdout: EMPTY_OUTPUT,
        stderr: EMPTY_OUTPUT,
        sourceSteeringChain: terminalSteeringChain,
        evidenceClass: "hydraObserved",
      },
    }), true);

    const nativeAction = await runtime.beginAuxiliaryOperation(room, {
      subject: {
        kind: "nativeAction",
        nativeActionId: "native-action-auxiliary-lifecycle",
        actionKind: "prompt",
        headCount: 2,
        attachmentCount: 1,
        evidenceClass: "hydraObserved",
      },
    });
    assert.equal(nativeAction.recorded, true);
    assert.equal(nativeAction.parentOperationId, room.phaseOperationId);
    assert.equal(await runtime.finishAuxiliaryOperation(nativeAction, {
      status: "succeeded",
      failureCode: null,
      observation: {
        kind: "nativeAction",
        observationType: "nativeActionReceipt",
        receiptSha256: "c".repeat(64),
        status: "recorded",
        evidenceClass: "hydraObserved",
      },
    }), true);

    assert.equal(await runtime.finishRoomTurn(room, {
      status: "succeeded",
      failureCode: null,
    }), true);
    const replay = await runtime.inspectTrace(room.traceId);
    assert.ok(replay);
    assert.equal(replay.completeness, "complete");
    assert.deepEqual(
      replay.records.map((record) => [
        record.recordType,
        record.operationKind,
        record.operationId ?? null,
        record.parentOperationId ?? null,
      ]),
      [
        ["traceStarted", "roomTurn", null, null],
        ["operationStarted", "phase", room.phaseOperationId, null],
        ["operationEvent", "phase", room.phaseOperationId, null],
        ["operationStarted", "agentRun", agent.operationId, room.phaseOperationId],
        ["operationStarted", "usage", usage.operationId, agent.operationId],
        ["operationEvent", "usage", usage.operationId, agent.operationId],
        ["operationFinished", "usage", usage.operationId, agent.operationId],
        ["operationFinished", "agentRun", agent.operationId, room.phaseOperationId],
        ["operationStarted", "verification", verification.operationId, room.phaseOperationId],
        ["operationEvent", "verification", verification.operationId, room.phaseOperationId],
        ["operationFinished", "verification", verification.operationId, room.phaseOperationId],
        ["operationStarted", "nativeAction", nativeAction.operationId, room.phaseOperationId],
        ["operationEvent", "nativeAction", nativeAction.operationId, room.phaseOperationId],
        ["operationFinished", "nativeAction", nativeAction.operationId, room.phaseOperationId],
        ["operationFinished", "phase", room.phaseOperationId, null],
        ["traceFinished", "roomTurn", null, null],
      ],
    );

    const phaseEvent = replay.records.find((record) =>
      record.recordType === "operationEvent"
      && record.operationKind === "phase"
    );
    assert.deepEqual(
      phaseEvent?.payload.payloadType === "operationEvent"
        ? phaseEvent.payload.observation
        : undefined,
      {
        kind: "phase",
        observationType: "phaseTransition",
        fromPhase: "AwaitingUser",
        toPhase: "Opener",
        trigger: "userSent",
      },
    );
    assert.equal(phaseEvent?.occurredAt, "2026-07-24T11:59:59.000Z");

    const usageEvent = replay.records.find((record) =>
      record.recordType === "operationEvent"
      && record.operationKind === "usage"
    );
    const agentFinish = replay.records.find((record) =>
      record.recordType === "operationFinished"
      && record.operationKind === "agentRun"
    );
    const usageSteeringChain =
      usageEvent?.payload.payloadType === "operationEvent"
      && usageEvent.payload.observation.observationType === "usageSummary"
        ? usageEvent.payload.observation.steeringChain
        : undefined;
    const agentSteeringChain =
      agentFinish?.payload.payloadType === "operationFinished"
        ? agentFinish.payload.steeringChain
        : undefined;
    assert.deepEqual(usageSteeringChain, terminalSteeringChain);
    assert.deepEqual(agentSteeringChain, terminalSteeringChain);
    assert.deepEqual(usageSteeringChain, agentSteeringChain);
  });

  test("rejects wrong auxiliary observations and every lifecycle mutation after finish", async (t) => {
    const root = await tempRoot(t);
    const runtime = await createFlightRecorderRuntime({
      privateWorkspaceRoot: root,
      ownerId: "extension-host-auxiliary-rejection",
    });
    t.after(() => runtime.dispose());

    const room = await runtime.beginRoomTurn({
      traceId: "trace-runtime-auxiliary-rejection",
      roomTurnId: "room-turn-auxiliary-rejection",
      phase: "Build",
      missionDocumentSha256: DOCUMENT,
      missionBindingSha256: MISSION,
      source: "localUser",
      baseRevisionSha: null,
    });
    const nativeAction = await runtime.beginAuxiliaryOperation(room, {
      subject: {
        kind: "nativeAction",
        nativeActionId: "native-action-auxiliary-rejection",
        actionKind: "rawLine",
        headCount: 1,
        attachmentCount: 0,
        evidenceClass: "hydraObserved",
      },
    });

    assert.equal(await runtime.finishAuxiliaryOperation(nativeAction, {
      status: "succeeded",
      failureCode: null,
      observation: {
        kind: "usage",
        observationType: "usageSummary",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        totalCostUsd: 0,
        costSource: "computed",
        steeringChain: {
          sha256: TERMINAL_CHAIN,
          indeterminate: false,
        },
        evidenceClass: "hydraObserved",
      },
    }), false);
    assert.equal(await runtime.finishAuxiliaryOperation(nativeAction, {
      status: "succeeded",
      failureCode: null,
      observation: {
        kind: "nativeAction",
        observationType: "nativeActionReceipt",
        receiptSha256: "d".repeat(64),
        status: "recorded",
        evidenceClass: "hydraObserved",
      },
    }), true);
    assert.equal(await runtime.finishAuxiliaryOperation(nativeAction, {
      status: "succeeded",
      failureCode: null,
      observation: {
        kind: "nativeAction",
        observationType: "nativeActionReceipt",
        receiptSha256: "d".repeat(64),
        status: "recorded",
        evidenceClass: "hydraObserved",
      },
    }), false);
    assert.equal(await runtime.finishRoomTurn(room, {
      status: "succeeded",
      failureCode: null,
    }), true);
    assert.equal(await runtime.recordPhaseTransition(room, {
      fromPhase: "Build",
      toPhase: "BuildDone",
      trigger: "buildDone",
    }), false);

    const afterFinish = await runtime.beginAuxiliaryOperation(room, {
      subject: {
        kind: "verification",
        verificationId: "verification-after-finish",
        planSha256: "e".repeat(64),
        invocationShapeSha256: "f".repeat(64),
        sourceRunId: null,
        sourceSteeringChain: null,
        evidenceClass: "hydraObserved",
      },
    });
    assert.equal(afterFinish.recorded, false);
    assert.equal(await runtime.finishAuxiliaryOperation(afterFinish, {
      status: "succeeded",
      failureCode: null,
      observation: {
        kind: "verification",
        observationType: "verificationReceipt",
        receiptSha256: "1".repeat(64),
        headRevisionSha: null,
        exitCode: 0,
        stdout: EMPTY_OUTPUT,
        stderr: EMPTY_OUTPUT,
        sourceSteeringChain: null,
        evidenceClass: "hydraObserved",
      },
    }), false);
    assert.equal(await runtime.finishRoomTurn(room, {
      status: "succeeded",
      failureCode: null,
    }), false);

    const replay = await runtime.inspectTrace(room.traceId);
    assert.ok(replay);
    assert.equal(
      replay.records.filter((record) =>
        record.recordType === "operationEvent"
        && record.operationKind === "nativeAction"
      ).length,
      1,
    );
    assert.equal(await runtime.inspectTrace("not a valid trace id"), undefined);
    assert.equal(runtime.notice, undefined);
  });

  test(
    "lifecycle admission stays prompt behind blocked I/O and flush preserves exact record order",
    { timeout: 10_000 },
    async (t) => {
      const root = await tempRoot(t);
      const runtime = await createFlightRecorderRuntime({
        privateWorkspaceRoot: root,
        ownerId: "extension-host-blocked-io",
      });
      t.after(() => runtime.dispose());
      await runtime.flushDerivedWork("trace-startup-barrier");

      const inner = await openFileFlightRecorderStore(root);
      let releaseAppend!: () => void;
      let signalAppendStarted!: () => void;
      const appendGate = new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
      const appendStarted = new Promise<void>((resolve) => {
        signalAppendStarted = resolve;
      });
      t.after(() => releaseAppend());
      const appendedTypes: string[] = [];
      let blockNextAppend = true;
      const blockedStore: FlightRecorderStore = {
        limits: inner.limits,
        async append(draft) {
          appendedTypes.push(draft.recordType);
          if (blockNextAppend) {
            blockNextAppend = false;
            signalAppendStarted();
            await appendGate;
          }
          return inner.append(draft);
        },
        load: (traceId) => inner.load(traceId),
        listTraceIds: () => inner.listTraceIds(),
      };
      const blockedController = new FlightRecorderController({
        store: blockedStore,
      });
      assert.equal(Reflect.set(runtime, "controller", blockedController), true);

      const room = await mustSettlePromptly(runtime.beginRoomTurn({
        traceId: "trace-runtime-blocked-io",
        roomTurnId: "room-turn-blocked-io",
        phase: "Build",
        missionDocumentSha256: DOCUMENT,
        missionBindingSha256: MISSION,
        source: "localUser",
        baseRevisionSha: null,
      }));
      await appendStarted;
      const agent = await mustSettlePromptly(
        runtime.beginAgentRun(room, agentInput("run-blocked-io")),
      );
      assert.equal(await mustSettlePromptly(runtime.finishAgentRun(agent, {
        status: "succeeded",
        failureCode: null,
        output: EMPTY_OUTPUT,
        terminalSteeringChain: {
          sha256: TERMINAL_CHAIN,
          indeterminate: false,
        },
        actualTransport: "appServer",
      })), true);
      assert.equal(await mustSettlePromptly(runtime.finishRoomTurn(room, {
        status: "succeeded",
        failureCode: null,
      })), true);
      assert.deepEqual(appendedTypes, ["traceStarted"]);

      releaseAppend();
      await runtime.flushDerivedWork(room.traceId);
      const replay = await inner.load(room.traceId);
      assert.deepEqual(
        replay?.records.map((record) => [
          record.recordType,
          record.operationKind,
        ]),
        [
          ["traceStarted", "roomTurn"],
          ["operationStarted", "phase"],
          ["operationStarted", "agentRun"],
          ["operationFinished", "agentRun"],
          ["operationFinished", "phase"],
          ["traceFinished", "roomTurn"],
        ],
      );
    },
  );

  test("startup stale recovery and retention run after runtime availability", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileFlightRecorderStore(root);
    const stale = new FlightRecorderController({ store });
    assert.equal((await stale.startTrace({
      traceId: "trace-runtime-async-recovery",
      roomTurnId: "room-turn-async-recovery",
      ownerId: "extension-host-gone",
      missionDocumentSha256: DOCUMENT,
      missionBindingSha256: MISSION,
      source: "localUser",
      baseRevisionSha: null,
    })).ok, true);
    assert.equal((await stale.startOperation({
      traceId: "trace-runtime-async-recovery",
      operationId: "phase-runtime-async-recovery",
      operationKind: "phase",
      subject: { kind: "phase", phase: "Build" },
      missionBindingSha256: MISSION,
    })).ok, true);

    const runtime = await createFlightRecorderRuntime({
      privateWorkspaceRoot: root,
      ownerId: "extension-host-live",
    });
    t.after(() => runtime.dispose());
    assert.equal(runtime.enabled, true);
    assert.deepEqual(runtime.status().recoveredTraceIds, []);

    await runtime.flushDerivedWork("trace-runtime-async-recovery");
    assert.deepEqual(runtime.status().recoveredTraceIds, [
      "trace-runtime-async-recovery",
    ]);
    const replay = await store.load("trace-runtime-async-recovery");
    assert.equal(replay?.state, "finished");
    assert.equal(replay?.completeness, "limited");
    assert.equal(replay?.incomplete, true);
  });

  test("maps process outcomes without importing or retaining output bodies", () => {
    assert.deepEqual(mapFlightRunResult({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    }), {
      status: "succeeded",
      failureCode: null,
    });
    assert.deepEqual(mapFlightRunResult({
      exitCode: 7,
      timedOut: false,
      cancelled: false,
    }), {
      status: "failed",
      failureCode: "providerFailure",
    });
    assert.deepEqual(mapFlightRunResult({
      exitCode: null,
      timedOut: false,
      cancelled: false,
    }), {
      status: "failed",
      failureCode: "transportFailure",
    });
    assert.deepEqual(mapFlightRunResult({
      exitCode: null,
      timedOut: true,
      cancelled: false,
    }), {
      status: "timedOut",
      failureCode: "timeout",
    });
    assert.deepEqual(mapFlightRunResult({
      exitCode: null,
      timedOut: true,
      cancelled: true,
    }), {
      status: "cancelled",
      failureCode: "cancelled",
    });
    assert.deepEqual(mapFlightRunResult({
      exitCode: 0,
      timedOut: false,
      cancelled: true,
      terminationFailed: true,
    }), {
      status: "deliveryUnknown",
      failureCode: "terminationUnconfirmed",
    });
    assert.deepEqual(mapFlightRunResult({
      exitCode: 1,
      timedOut: false,
      cancelled: false,
      deliveryUnknown: true,
    }), {
      status: "deliveryUnknown",
      failureCode: "deliveryUnknown",
    });
  });

  test("initialization failure returns no-op handles and one sanitized notice instead of throwing", async (t) => {
    const root = await tempRoot(t);
    const blockedRoot = path.join(root, "SECRET-PATH-CANARY");
    await fs.writeFile(blockedRoot, "not a directory", "utf8");
    const notices: FlightRecorderRuntimeNotice[] = [];
    const runtime = await createFlightRecorderRuntime({
      privateWorkspaceRoot: blockedRoot,
      ownerId: "extension-host-broken",
      onNotice: (notice) => {
        notices.push(notice);
        throw new Error("presentation failure");
      },
    });
    t.after(() => runtime.dispose());

    assert.equal(runtime.enabled, false);
    assert.deepEqual(runtime.notice, {
      code: "initializationFailed",
      traceId: null,
    });
    const room = await runtime.beginRoomTurn({
      roomTurnId: "room-turn-disabled",
      phase: "Build",
      missionDocumentSha256: DOCUMENT,
      missionBindingSha256: MISSION,
      source: "localUser",
      baseRevisionSha: null,
    });
    assert.equal(room.recorded, false);
    const agent = await runtime.beginAgentRun(room, agentInput("run-disabled"));
    assert.equal(agent.recorded, false);

    const providerResult = {
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    };
    assert.equal(await runtime.finishAgentRun(agent, {
      ...mapFlightRunResult(providerResult),
      output: null,
      terminalSteeringChain: {
        sha256: TERMINAL_CHAIN,
        indeterminate: false,
      },
      actualTransport: "appServer",
    }), false);
    assert.deepEqual(providerResult, {
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    });
    assert.equal(notices.length, 1);
    assert.deepEqual(Object.keys(notices[0]!).sort(), ["code", "traceId"]);
    assert.equal(JSON.stringify(notices).includes("SECRET-PATH-CANARY"), false);
  });

  test("latches corrupt-store degradation while caller work and handles remain usable", async (t) => {
    const root = await tempRoot(t);
    const notices: FlightRecorderRuntimeNotice[] = [];
    const runtime = await createFlightRecorderRuntime({
      privateWorkspaceRoot: root,
      ownerId: "extension-host-corrupt",
      onNotice: (notice) => notices.push(notice),
    });
    t.after(() => runtime.dispose());
    const room = await runtime.beginRoomTurn({
      traceId: "trace-runtime-corrupt",
      roomTurnId: "room-turn-corrupt",
      phase: "Build",
      missionDocumentSha256: DOCUMENT,
      missionBindingSha256: MISSION,
      source: "localUser",
      baseRevisionSha: null,
    });
    assert.equal(room.recorded, true);
    await runtime.flushDerivedWork(room.traceId);
    await fs.writeFile(
      flightTracePath(root, room.traceId),
      "SECRET-CONTENT-CANARY\n",
      "utf8",
    );

    const agent = await runtime.beginAgentRun(room, agentInput("run-corrupt"));
    assert.equal(agent.recorded, true);
    let callerCompleted = false;
    callerCompleted = true;
    assert.equal(await runtime.finishAgentRun(agent, {
      status: "succeeded",
      failureCode: null,
      output: EMPTY_OUTPUT,
      terminalSteeringChain: {
        sha256: TERMINAL_CHAIN,
        indeterminate: false,
      },
      actualTransport: "appServer",
    }), true);
    assert.equal(await runtime.finishRoomTurn(room, {
      status: "succeeded",
      failureCode: null,
    }), true);
    assert.equal(callerCompleted, true);
    await runtime.flushDerivedWork(room.traceId);
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0], {
      code: "recordingDegraded",
      traceId: "trace-runtime-corrupt",
      recorderCode: "invalidTrace",
    });
    assert.equal(JSON.stringify(notices).includes("SECRET-CONTENT-CANARY"), false);
  });

  test("dispose drains an admitted open trace to an explicit incomplete finish before releasing ownership", async (t) => {
    const root = await tempRoot(t);
    const first = await createFlightRecorderRuntime({
      privateWorkspaceRoot: root,
      ownerId: "extension-host-stale",
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    });
    const room = await first.beginRoomTurn({
      traceId: "trace-runtime-recovery",
      roomTurnId: "room-turn-recovery",
      phase: "Build",
      missionDocumentSha256: DOCUMENT,
      missionBindingSha256: MISSION,
      source: "localUser",
      baseRevisionSha: null,
    });
    assert.equal(room.recorded, true);
    first.dispose();
    await first.flushDerivedWork(room.traceId);

    const disposedReplay = await (await openFileFlightRecorderStore(root)).load(
      "trace-runtime-recovery",
    );
    assert.equal(disposedReplay?.state, "finished");
    assert.equal(disposedReplay?.completeness, "incomplete");
    assert.equal(disposedReplay?.limited, false);
    assert.equal(disposedReplay?.openOperationCount, 1);

    const second = await createFlightRecorderRuntime({
      privateWorkspaceRoot: root,
      ownerId: "extension-host-recovery",
      now: () => new Date("2026-07-24T12:01:00.000Z"),
    });
    t.after(() => second.dispose());
    await second.flushDerivedWork("trace-runtime-recovery");
    assert.deepEqual(second.status().recoveredTraceIds, []);
  });

  test("enforces file retention after each terminal trace without pruning an active trace", async (t) => {
    const root = await tempRoot(t);
    let tick = Date.parse("2026-07-24T12:00:00.000Z");
    const runtime = await createFlightRecorderRuntime({
      privateWorkspaceRoot: root,
      ownerId: "extension-host-retention",
      retention: {
        maxFiles: 1,
        maxTotalBytes: 1024 * 1024,
      },
      now: () => new Date(tick++),
    });
    t.after(() => runtime.dispose());

    for (const suffix of ["a", "b"]) {
      const room = await runtime.beginRoomTurn({
        traceId: `trace-runtime-retention-${suffix}`,
        roomTurnId: `room-turn-retention-${suffix}`,
        phase: "Build",
        missionDocumentSha256: DOCUMENT,
        missionBindingSha256: MISSION,
        source: "localUser",
        baseRevisionSha: null,
      });
      assert.equal(room.recorded, true);
      assert.equal(await runtime.finishRoomTurn(room, {
        status: "succeeded",
        failureCode: null,
      }), true);
      await runtime.flushDerivedWork(room.traceId);
    }

    const store = await openFileFlightRecorderStore(root);
    assert.deepEqual(await store.listTraceIds(), [
      "trace-runtime-retention-b",
    ]);
    assert.deepEqual(runtime.status().retention?.removedTraceIds, [
      "trace-runtime-retention-a",
    ]);
  });

  test("derived mirror failure is nonthrowing and cannot change the authoritative terminal outcome", async (t) => {
    const root = await tempRoot(t);
    const notices: FlightRecorderRuntimeNotice[] = [];
    const runtime = await createFlightRecorderRuntime({
      privateWorkspaceRoot: root,
      ownerId: "extension-host-derived-failure",
      mirrorPath: root,
      onNotice: (notice) => notices.push(notice),
    });
    t.after(() => runtime.dispose());
    const room = await runtime.beginRoomTurn({
      traceId: "trace-runtime-derived-failure",
      roomTurnId: "room-turn-derived-failure",
      phase: "Build",
      missionDocumentSha256: DOCUMENT,
      missionBindingSha256: MISSION,
      source: "localUser",
      baseRevisionSha: null,
    });

    assert.equal(await runtime.finishRoomTurn(room, {
      status: "succeeded",
      failureCode: null,
    }), true);

    await runtime.flushDerivedWork(room.traceId);
    assert.deepEqual(notices, [{
      code: "recordingDegraded",
      traceId: "trace-runtime-derived-failure",
      recorderCode: "mirrorFailed",
    }]);
    assert.equal(
      (await (await openFileFlightRecorderStore(root)).load(room.traceId))
        ?.completeness,
      "complete",
    );
  });

  test("promotes a specific child terminal outcome over coarse parent success or provider failure", async (t) => {
    const cases = [
      {
        suffix: "timeout",
        child: { status: "timedOut", failureCode: "timeout" },
        parent: { status: "succeeded", failureCode: null },
      },
      {
        suffix: "blocked",
        child: { status: "blocked", failureCode: "guardBlocked" },
        parent: { status: "failed", failureCode: "providerFailure" },
      },
      {
        suffix: "denied",
        child: { status: "denied", failureCode: "consentDenied" },
        parent: { status: "succeeded", failureCode: null },
      },
      {
        suffix: "validation",
        child: { status: "failed", failureCode: "validationFailure" },
        parent: { status: "failed", failureCode: "unknown" },
      },
      {
        suffix: "recorder",
        child: { status: "incomplete", failureCode: "recorderFailure" },
        parent: { status: "succeeded", failureCode: null },
      },
    ] as const;

    for (const scenario of cases) {
      const root = await tempRoot(t, `hydra-flight-${scenario.suffix}-`);
      const runtime = await createFlightRecorderRuntime({
        privateWorkspaceRoot: root,
        ownerId: `extension-host-${scenario.suffix}`,
      });
      t.after(() => runtime.dispose());
      const room = await runtime.beginRoomTurn({
        traceId: `trace-runtime-${scenario.suffix}`,
        roomTurnId: `room-turn-${scenario.suffix}`,
        phase: "Build",
        missionDocumentSha256: DOCUMENT,
        missionBindingSha256: MISSION,
        source: "localUser",
        baseRevisionSha: null,
      });
      const agent = await runtime.beginAgentRun(
        room,
        agentInput(`run-${scenario.suffix}`),
      );
      assert.equal(await runtime.finishAgentRun(agent, {
        ...scenario.child,
        output: null,
        terminalSteeringChain: {
          sha256: TERMINAL_CHAIN,
          indeterminate: false,
        },
        actualTransport: "appServer",
      }), true);
      assert.equal(await runtime.finishRoomTurn(room, scenario.parent), true);
      await runtime.flushDerivedWork(room.traceId);

      const replay = await (await openFileFlightRecorderStore(root)).load(
        room.traceId,
      );
      const phaseFinish = replay?.records.find((record) =>
        record.recordType === "operationFinished"
        && record.operationKind === "phase"
      );
      assert.deepEqual(
        phaseFinish?.payload.payloadType === "operationFinished"
          ? {
              status: phaseFinish.payload.status,
              failureCode: phaseFinish.payload.failureCode,
            }
          : undefined,
        scenario.child,
      );
      const traceFinish = replay?.records.at(-1)?.payload;
      assert.equal(
        traceFinish?.payloadType === "traceFinished"
          ? traceFinish.status
          : undefined,
        scenario.child.status,
      );
      assert.equal(
        replay?.incomplete,
        scenario.child.status === "incomplete",
      );
    }
  });

  test("explicit parent cancellation is not overridden by a child terminal failure", async (t) => {
    const root = await tempRoot(t);
    const runtime = await createFlightRecorderRuntime({
      privateWorkspaceRoot: root,
      ownerId: "extension-host-parent-cancel",
    });
    t.after(() => runtime.dispose());
    const room = await runtime.beginRoomTurn({
      traceId: "trace-runtime-parent-cancel",
      roomTurnId: "room-turn-parent-cancel",
      phase: "Build",
      missionDocumentSha256: DOCUMENT,
      missionBindingSha256: MISSION,
      source: "localUser",
      baseRevisionSha: null,
    });
    const agent = await runtime.beginAgentRun(
      room,
      agentInput("run-parent-cancel"),
    );
    assert.equal(await runtime.finishAgentRun(agent, {
      status: "timedOut",
      failureCode: "timeout",
      output: null,
      terminalSteeringChain: {
        sha256: TERMINAL_CHAIN,
        indeterminate: false,
      },
      actualTransport: "appServer",
    }), true);
    assert.equal(await runtime.finishRoomTurn(room, {
      status: "cancelled",
      failureCode: "cancelled",
    }), true);
    await runtime.flushDerivedWork(room.traceId);

    const replay = await (await openFileFlightRecorderStore(root)).load(
      room.traceId,
    );
    const phaseFinish = replay?.records.find((record) =>
      record.recordType === "operationFinished"
      && record.operationKind === "phase"
    );
    assert.deepEqual(
      phaseFinish?.payload.payloadType === "operationFinished"
        ? {
            status: phaseFinish.payload.status,
            failureCode: phaseFinish.payload.failureCode,
          }
        : undefined,
      {
        status: "cancelled",
        failureCode: "cancelled",
      },
    );
  });

  test("termination uncertainty outranks parent cancellation", async (t) => {
    const root = await tempRoot(t);
    const runtime = await createFlightRecorderRuntime({
      privateWorkspaceRoot: root,
      ownerId: "extension-host-termination-uncertain",
    });
    t.after(() => runtime.dispose());
    const room = await runtime.beginRoomTurn({
      traceId: "trace-runtime-termination-uncertain",
      roomTurnId: "room-turn-termination-uncertain",
      phase: "Build",
      missionDocumentSha256: DOCUMENT,
      missionBindingSha256: MISSION,
      source: "localUser",
      baseRevisionSha: null,
    });
    const agent = await runtime.beginAgentRun(
      room,
      agentInput("run-termination-uncertain"),
    );
    assert.equal(await runtime.finishAgentRun(agent, {
      status: "deliveryUnknown",
      failureCode: "terminationUnconfirmed",
      output: null,
      terminalSteeringChain: {
        sha256: TERMINAL_CHAIN,
        indeterminate: true,
      },
      actualTransport: "terminalBridge",
    }), true);
    assert.equal(await runtime.finishRoomTurn(room, {
      status: "cancelled",
      failureCode: "cancelled",
    }), true);
    await runtime.flushDerivedWork(room.traceId);

    const replay = await (await openFileFlightRecorderStore(root)).load(
      room.traceId,
    );
    const phaseFinish = replay?.records.find((record) =>
      record.recordType === "operationFinished"
      && record.operationKind === "phase"
    );
    assert.deepEqual(
      phaseFinish?.payload.payloadType === "operationFinished"
        ? {
            status: phaseFinish.payload.status,
            failureCode: phaseFinish.payload.failureCode,
          }
        : undefined,
      {
        status: "deliveryUnknown",
        failureCode: "terminationUnconfirmed",
      },
    );
    const traceFinish = replay?.records.at(-1)?.payload;
    assert.equal(
      traceFinish?.payloadType === "traceFinished"
        ? traceFinish.status
        : undefined,
      "deliveryUnknown",
    );
  });
});
