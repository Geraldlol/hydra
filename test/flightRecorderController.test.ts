import { createHash } from "node:crypto";
import { describe, test, type TestContext } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  FlightRecorderController,
  renderFlightRecorderMirror,
  type FlightRecorderHealthNotice,
} from "../src/flightRecorderController";
import {
  DEFAULT_FLIGHT_STORE_LIMITS,
  openFileFlightRecorderStore,
  type FlightRecorderStore,
  type FlightRecorderStoreLimits,
} from "../src/flightRecorderStore";
import type {
  FlightAgentRunSubject,
  FlightRecord,
  FlightRecordDraft,
  FlightTraceReplay,
} from "../src/flightRecorderProtocol";

const TIME = "2026-07-24T12:00:00.000Z";
const MISSION = "1".repeat(64);
const DOCUMENT = "2".repeat(64);
const INITIAL_CHAIN = "3".repeat(64);
const TERMINAL_CHAIN = "4".repeat(64);

async function tempRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-flight-controller-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function traceInput(traceId: string) {
  return {
    traceId,
    roomTurnId: `room-${traceId}`,
    ownerId: "extension-host-one",
    missionDocumentSha256: DOCUMENT,
    missionBindingSha256: MISSION,
    source: "localUser" as const,
    baseRevisionSha: "a".repeat(40),
    occurredAt: TIME,
    recordId: `record-${traceId}-start`,
  };
}

function agentSubject(model = "gpt-test"): FlightAgentRunSubject {
  return {
    kind: "agentRun",
    runId: "run-one",
    headId: "codex",
    agentKind: "codex",
    phase: "Build",
    provider: "openai",
    model,
    plannedTransport: "appServer",
    authorityClass: "workspaceWrite",
    authoritySha256: "5".repeat(64),
    promptSha256: "6".repeat(64),
    contextSha256: "7".repeat(64),
    promptCharacters: 120,
    telemetryDetail: "structured",
    initialSteeringChain: { sha256: INITIAL_CHAIN, indeterminate: false },
    evidenceClass: "hydraObserved",
  };
}

function deterministicIds(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}-${++index}`;
}

describe("Flight Recorder controller", () => {
  test("exposes integration-friendly trace and operation lifecycle with steering binding", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileFlightRecorderStore(root);
    const controller = new FlightRecorderController({
      store,
      now: () => TIME,
      newRecordId: deterministicIds(),
    });
    const traceId = "trace-controller";

    assert.equal((await controller.startTrace(traceInput(traceId))).ok, true);
    assert.equal((await controller.startOperation({
      traceId,
      operationId: "operation-agent",
      operationKind: "agentRun",
      subject: agentSubject(),
      occurredAt: TIME,
      recordId: "record-agent-start",
    })).ok, true);
    assert.equal((await controller.recordEvent({
      traceId,
      operationId: "operation-agent",
      operationKind: "agentRun",
      observation: {
        kind: "agentRun",
        observationType: "dispatchDecision",
        decision: "submitted",
        code: null,
        invocationShapeSha256: "8".repeat(64),
      },
      occurredAt: TIME,
      recordId: "record-agent-dispatch",
    })).ok, true);
    assert.equal((await controller.finishOperation({
      traceId,
      operationId: "operation-agent",
      operationKind: "agentRun",
      status: "succeeded",
      durationMs: 10,
      failureCode: null,
      output: {
        bytes: 0,
        sha256: createHash("sha256").update("").digest("hex"),
      },
      steeringChain: { sha256: TERMINAL_CHAIN, indeterminate: true },
      actualTransport: "appServer",
      evidenceClass: "providerObserved",
      occurredAt: TIME,
      recordId: "record-agent-finish",
    })).ok, true);
    const finish = await controller.finishTrace({
      traceId,
      status: "succeeded",
      durationMs: 10,
      occurredAt: TIME,
      recordId: "record-trace-finish",
    });
    assert.equal(finish.ok, true);
    assert.equal(finish.health.completeness, "complete");

    const replay = await controller.currentReplaySnapshot(traceId);
    assert.equal(replay?.completeness, "complete");
    const agentFinish = replay?.records.find((record) =>
      record.recordType === "operationFinished"
    );
    assert.deepEqual(
      agentFinish?.payload.payloadType === "operationFinished"
        ? agentFinish.payload.steeringChain
        : undefined,
      { sha256: TERMINAL_CHAIN, indeterminate: true },
    );
    assert.deepEqual(await controller.flush(traceId), controller.currentHealth(traceId));
  });

  test("automatically consumes reserved slots with one limit and incomplete finish", async (t) => {
    const root = await tempRoot(t);
    const limits: FlightRecorderStoreLimits = {
      maxTraceBytes: 64 * 1024,
      maxRecordsPerTrace: 6,
      maxRecordBytes: 4 * 1024,
      reservedTerminalRecords: 2,
      reservedTerminalBytes: 8 * 1024,
    };
    const store = await openFileFlightRecorderStore(root, limits);
    const controller = new FlightRecorderController({
      store,
      now: () => TIME,
      newRecordId: deterministicIds(),
    });
    const traceId = "trace-capacity";
    await controller.startTrace(traceInput(traceId));
    await controller.startOperation({
      traceId,
      operationId: "operation-phase",
      operationKind: "phase",
      subject: { kind: "phase", phase: "Build" },
      occurredAt: TIME,
      recordId: "record-phase-start",
    });
    await controller.recordEvent({
      traceId,
      operationId: "operation-phase",
      operationKind: "phase",
      observation: {
        kind: "phase",
        observationType: "phaseTransition",
        fromPhase: "Opener",
        toPhase: "Build",
        trigger: "assignBuilder",
      },
      occurredAt: TIME,
      recordId: "record-phase-event",
    });
    await controller.finishOperation({
      traceId,
      operationId: "operation-phase",
      operationKind: "phase",
      status: "succeeded",
      durationMs: 1,
      failureCode: null,
      output: null,
      steeringChain: null,
      actualTransport: null,
      evidenceClass: "hydraObserved",
      occurredAt: TIME,
      recordId: "record-phase-finish",
    });

    const overflow = await controller.startOperation({
      traceId,
      operationId: "operation-overflow",
      operationKind: "phase",
      subject: { kind: "phase", phase: "Review" },
      occurredAt: TIME,
      recordId: "record-overflow",
    });
    assert.equal(overflow.ok, false);
    assert.equal(overflow.health.completeness, "incomplete");
    assert.equal(overflow.health.finalized, true);

    const replay = await store.load(traceId);
    assert.ok(replay);
    assert.equal(replay.records.length, 6);
    assert.equal(replay.completeness, "limited");
    assert.equal(replay.records.filter((record) => record.recordType === "traceLimited").length, 1);
    assert.equal(replay.records.at(-1)?.recordType, "traceFinished");
    assert.equal(replay.records.some((record) => record.recordId === "record-overflow"), false);
    const file = await fs.readFile(
      path.join(root, "flight", "traces", `${traceId}.v1.jsonl`),
    );
    assert.ok(file.byteLength <= limits.maxTraceBytes);
  });

  test("forces an explicitly limited trace to close as incomplete", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileFlightRecorderStore(root);
    const controller = new FlightRecorderController({
      store,
      now: () => TIME,
      newRecordId: deterministicIds(),
    });
    const traceId = "trace-explicit-limit";
    assert.equal((await controller.startTrace(traceInput(traceId))).ok, true);
    assert.equal((await controller.limitTrace({
      traceId,
      reason: "providerFlood",
      droppedRecordsAtLeast: 1,
      occurredAt: TIME,
    })).ok, true);

    const finish = await controller.finishTrace({
      traceId,
      status: "succeeded",
      durationMs: 1,
      occurredAt: TIME,
    });
    assert.equal(finish.ok, true);
    assert.equal(finish.health.completeness, "incomplete");
    const replay = await store.load(traceId);
    assert.equal(replay?.completeness, "limited");
    const payload = replay?.records.at(-1)?.payload;
    assert.deepEqual(
      payload?.payloadType === "traceFinished"
        ? {
            status: payload.status,
            limited: payload.limited,
            incomplete: payload.incomplete,
          }
        : undefined,
      { status: "incomplete", limited: true, incomplete: true },
    );
  });

  test("latches a nonthrowing start failure and emits one sanitized notice without retry", async () => {
    let appendCalls = 0;
    const notices: FlightRecorderHealthNotice[] = [];
    const store: FlightRecorderStore = {
      limits: DEFAULT_FLIGHT_STORE_LIMITS,
      async append(): Promise<FlightRecord> {
        appendCalls += 1;
        throw new Error("SECRET CONTENT-CANARY");
      },
      async load(): Promise<FlightTraceReplay | undefined> {
        return undefined;
      },
      async listTraceIds(): Promise<readonly string[]> {
        return [];
      },
    };
    const controller = new FlightRecorderController({
      store,
      now: () => TIME,
      onHealthNotice: (notice) => notices.push(notice),
    });
    const first = await controller.startTrace(traceInput("trace-failure"));
    const second = await controller.startTrace(traceInput("trace-failure"));
    assert.equal(first.ok, false);
    assert.equal(second.ok, false);
    assert.equal(first.health.completeness, "incomplete");
    assert.equal(appendCalls, 1);
    assert.deepEqual(notices, [{
      traceId: "trace-failure",
      code: "startFailed",
      completeness: "incomplete",
    }]);
    assert.doesNotMatch(JSON.stringify(first), /SECRET CONTENT-CANARY/);
  });

  test("does not retry a failed event or finish, but seals the trace once", async (t) => {
    for (const failedType of ["operationEvent", "operationFinished"] as const) {
      const root = await tempRoot(t);
      const inner = await openFileFlightRecorderStore(root);
      let failedCalls = 0;
      const wrapper: FlightRecorderStore = {
        limits: inner.limits,
        async append(draft: FlightRecordDraft): Promise<FlightRecord> {
          if (draft.recordType === failedType && failedCalls === 0) {
            failedCalls += 1;
            throw new Error("injected write failure");
          }
          return inner.append(draft);
        },
        load: (traceId) => inner.load(traceId),
        listTraceIds: () => inner.listTraceIds(),
      };
      const controller = new FlightRecorderController({
        store: wrapper,
        now: () => TIME,
        newRecordId: deterministicIds(),
      });
      const traceId = `trace-${failedType}`;
      await controller.startTrace(traceInput(traceId));
      await controller.startOperation({
        traceId,
        operationId: "operation-phase",
        operationKind: "phase",
        subject: { kind: "phase", phase: "Build" },
        occurredAt: TIME,
      });
      if (failedType === "operationEvent") {
        await controller.recordEvent({
          traceId,
          operationId: "operation-phase",
          operationKind: "phase",
          observation: {
            kind: "phase",
            observationType: "phaseTransition",
            fromPhase: "Opener",
            toPhase: "Build",
            trigger: "assignBuilder",
          },
          occurredAt: TIME,
        });
      } else {
        await controller.finishOperation({
          traceId,
          operationId: "operation-phase",
          operationKind: "phase",
          status: "succeeded",
          durationMs: 1,
          failureCode: null,
          output: null,
          steeringChain: null,
          actualTransport: null,
          evidenceClass: "hydraObserved",
          occurredAt: TIME,
        });
      }
      assert.equal(failedCalls, 1);
      const replay = await inner.load(traceId);
      assert.equal(replay?.completeness, "limited");
      assert.equal(replay?.records.filter((record) => record.recordType === "traceLimited").length, 1);
    }
  });

  test(
    "index and mirror projection failures do not rewrite authoritative completeness",
    { timeout: 5_000 },
    async (t) => {
      const root = await tempRoot(t);
      const store = await openFileFlightRecorderStore(root);
      const notices: FlightRecorderHealthNotice[] = [];
      let indexCalls = 0;
      let mirrorCalls = 0;
      let releaseIndex!: () => void;
      const indexGate = new Promise<void>((resolve) => {
        releaseIndex = resolve;
      });
      const controller = new FlightRecorderController({
        store,
        now: () => TIME,
        refreshIndex: async () => {
          indexCalls += 1;
          await indexGate;
          throw new Error("index failure");
        },
        writeMirror: async () => {
          mirrorCalls += 1;
          throw new Error("mirror failure");
        },
        onHealthNotice: (notice) => notices.push(notice),
      });
      const traceId = "trace-projection-failure";
      await controller.startTrace(traceInput(traceId));
      const receipt = await controller.finishTrace({
        traceId,
        status: "succeeded",
        durationMs: 0,
        occurredAt: TIME,
      });
      assert.equal(receipt.ok, true);
      assert.equal(receipt.health.completeness, "complete");
      assert.equal(receipt.health.indexHealthy, true);
      assert.equal(receipt.health.mirrorHealthy, true);
      assert.equal((await store.load(traceId))?.completeness, "complete");

      releaseIndex();
      const health = await controller.flush(traceId);
      assert.equal(health.completeness, "complete");
      assert.equal(health.indexHealthy, false);
      assert.equal(health.mirrorHealthy, false);
      assert.equal(indexCalls, 1);
      assert.equal(mirrorCalls, 1);
      assert.equal(notices.length, 1);
    },
  );

  test("metadata mirror omits content-derived hashes and payload strings", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileFlightRecorderStore(root);
    const controller = new FlightRecorderController({ store, now: () => TIME });
    const traceId = "trace-mirror";
    await controller.startTrace(traceInput(traceId));
    await controller.startOperation({
      traceId,
      operationId: "operation-agent",
      operationKind: "agentRun",
      subject: agentSubject("CONTENT-CANARY-MODEL"),
      occurredAt: TIME,
    });
    await controller.finishOperation({
      traceId,
      operationId: "operation-agent",
      operationKind: "agentRun",
      status: "succeeded",
      durationMs: 1,
      failureCode: null,
      output: null,
      steeringChain: { sha256: TERMINAL_CHAIN, indeterminate: false },
      actualTransport: "appServer",
      evidenceClass: "providerObserved",
      occurredAt: TIME,
    });
    await controller.finishTrace({
      traceId,
      status: "succeeded",
      durationMs: 1,
      occurredAt: TIME,
    });
    const replay = await store.load(traceId);
    assert.ok(replay);
    const mirror = renderFlightRecorderMirror(replay, TIME);
    assert.match(mirror, /metadata-only mirror/);
    assert.match(mirror, /agentRun/);
    for (const forbidden of [
      "CONTENT-CANARY-MODEL",
      MISSION,
      DOCUMENT,
      INITIAL_CHAIN,
      TERMINAL_CHAIN,
      "6".repeat(64),
      "7".repeat(64),
    ]) {
      assert.doesNotMatch(mirror, new RegExp(forbidden));
    }
  });
});
