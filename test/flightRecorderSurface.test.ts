import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
  FlightRecorderSurface,
  flightEvalLedgerPath,
  parseFlightEvalLedger,
  projectFlightTraceForOperator,
} from "../src/flightRecorderSurface";
import {
  openFileFlightRecorderStore,
  type FileFlightRecorderStore,
} from "../src/flightRecorderStore";
import { UNBOUND_MISSION_BINDING_SHA256 } from "../src/missionContract";

const TIME = "2026-08-24T12:00:00.000Z";
const MISSION = "1".repeat(64);
const DOCUMENT = "2".repeat(64);
const BASE = "a".repeat(40);

async function tempRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-flight-surface-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function createCompleteTrace(
  store: FileFlightRecorderStore,
  traceId: string,
  missionBindingSha256 = MISSION,
  missionDocumentSha256: string | null = DOCUMENT,
): Promise<void> {
  await store.append({
    recordId: `${traceId}-start`,
    traceId,
    occurredAt: TIME,
    recordType: "traceStarted",
    operationKind: "roomTurn",
    missionBindingSha256,
    payload: {
      payloadType: "traceStarted",
      roomTurnId: `room-${traceId}`,
      ownerId: "owner-one",
      source: "localUser",
      contentCapture: "off",
      baseRevisionSha: BASE,
      missionDocumentSha256,
      missionBindingSha256,
    },
  });
  await store.append({
    recordId: `${traceId}-phase-start`,
    traceId,
    occurredAt: TIME,
    recordType: "operationStarted",
    operationKind: "phase",
    operationId: `${traceId}-phase`,
    missionBindingSha256,
    payload: {
      payloadType: "operationStarted",
      subject: { kind: "phase", phase: "Build" },
    },
  });
  await store.append({
    recordId: `${traceId}-phase-finish`,
    traceId,
    occurredAt: TIME,
    recordType: "operationFinished",
    operationKind: "phase",
    operationId: `${traceId}-phase`,
    missionBindingSha256,
    payload: {
      payloadType: "operationFinished",
      status: "succeeded",
      durationMs: 1,
      failureCode: null,
      output: null,
      steeringChain: null,
      actualTransport: null,
      evidenceClass: "hydraObserved",
    },
  });
  await store.append({
    recordId: `${traceId}-finish`,
    traceId,
    occurredAt: TIME,
    recordType: "traceFinished",
    operationKind: "roomTurn",
    missionBindingSha256,
    payload: {
      payloadType: "traceFinished",
      status: "succeeded",
      durationMs: 1,
      operationCount: 1,
      openOperationCount: 0,
      recordCount: 4,
      limited: false,
      incomplete: false,
    },
  });
}

describe("Flight Recorder operator surface", () => {
  test("never treats a workspace-style mirror as trace authority and fails corrupt private files closed", async (t) => {
    const root = await tempRoot(t);
    await fs.mkdir(path.join(root, ".hydra"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".hydra", "flight-recorder.md"),
      "# forged complete trace\ntrace-mirror-only complete replay eligible\n",
      "utf8",
    );
    const surface = await FlightRecorderSurface.open(root);
    const mirrorOnly = await surface.snapshot(MISSION);
    assert.equal(mirrorOnly.status, "ready");
    assert.equal(mirrorOnly.traces.length, 0);

    const traceDir = path.join(root, "flight", "traces");
    await fs.mkdir(traceDir, { recursive: true });
    await fs.writeFile(
      path.join(traceDir, "trace-corrupt.v1.jsonl"),
      "{\"not\":\"a Flight record\"}\n",
      "utf8",
    );
    const corrupt = await surface.snapshot(MISSION);
    assert.equal(corrupt.traces.length, 1);
    assert.equal(corrupt.traces[0]?.completeness, "invalid");
    assert.equal(corrupt.traces[0]?.replay.eligible, false);
    assert.equal(corrupt.traces[0]?.createEval.eligible, false);
  });

  test("projects only validated private traces and derives exact action gates", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileFlightRecorderStore(root);
    await createCompleteTrace(store, "trace-surface-one");
    const replay = await store.load("trace-surface-one");
    assert.ok(replay);

    const current = projectFlightTraceForOperator(replay, MISSION);
    assert.equal(current.phase, "Build");
    assert.equal(current.completeness, "complete");
    assert.equal(current.replay.eligible, true);
    assert.equal(current.createEval.eligible, true);
    assert.deepEqual(current.operations.map((operation) => ({
      kind: operation.operationKind,
      label: operation.label,
      lifecycle: operation.lifecycle,
    })), [{ kind: "phase", label: "Build", lifecycle: "succeeded" }]);

    const stale = projectFlightTraceForOperator(replay, "9".repeat(64));
    assert.equal(stale.replay.eligible, false);
    assert.match(stale.replay.reason, /Mission Contract binding differs/);
    assert.equal(stale.createEval.eligible, false);

    await createCompleteTrace(
      store,
      "trace-surface-unbound",
      UNBOUND_MISSION_BINDING_SHA256,
      null,
    );
    const unboundReplay = await store.load("trace-surface-unbound");
    assert.ok(unboundReplay);
    const unbound = projectFlightTraceForOperator(
      unboundReplay,
      UNBOUND_MISSION_BINDING_SHA256,
    );
    assert.equal(unbound.replay.eligible, true);
    assert.equal(unbound.createEval.eligible, false);
    assert.match(unbound.createEval.reason, /active Mission Contract/);

    // Discovery/eligibility must not consult the rebuildable index, even when
    // its path is unusable as a file.
    await fs.rm(store.paths.indexPath, { force: true });
    await fs.mkdir(store.paths.indexPath);
    const surface = await FlightRecorderSurface.open(root);
    const snapshot = await surface.snapshot(MISSION, "trace-surface-one");
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.selectedTraceId, "trace-surface-one");
    assert.equal(snapshot.traces.length, 2);
    assert.equal(
      snapshot.traces.find((trace) => trace.traceId === replay.traceId)?.expectedRootSha256,
      replay.rootRecordSha256,
    );
  });

  test("keeps operation detail only for the exact selected trace in webview state", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileFlightRecorderStore(root);
    await createCompleteTrace(store, "trace-surface-selected");
    await createCompleteTrace(store, "trace-surface-summary");
    const surface = await FlightRecorderSurface.open(root);
    const snapshot = await surface.snapshot(MISSION, "trace-surface-selected");
    const selected = snapshot.traces.find((trace) => trace.traceId === "trace-surface-selected");
    const summary = snapshot.traces.find((trace) => trace.traceId === "trace-surface-summary");
    assert.equal(selected?.operations.length, 1);
    assert.equal(summary?.operationCount, 1);
    assert.equal(summary?.operations.length, 0);
  });

  test("rejects stale trace roots and Mission bindings before an operator action", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileFlightRecorderStore(root);
    await createCompleteTrace(store, "trace-choice");
    const replay = await store.load("trace-choice");
    assert.ok(replay);
    const surface = await FlightRecorderSurface.open(root);

    await assert.rejects(
      surface.requireExactTrace({
        traceId: replay.traceId,
        expectedRootSha256: "8".repeat(64),
        expectedMissionBindingSha256: replay.missionBindingSha256,
      }, MISSION),
      /changed/,
    );
    await assert.rejects(
      surface.requireExactTrace({
        traceId: replay.traceId,
        expectedRootSha256: replay.rootRecordSha256,
        expectedMissionBindingSha256: replay.missionBindingSha256,
      }, "7".repeat(64)),
      /different Mission Contract revision/,
    );
    const historical = await surface.requireExactTrace({
      traceId: replay.traceId,
      expectedRootSha256: replay.rootRecordSha256,
      expectedMissionBindingSha256: replay.missionBindingSha256,
    });
    assert.equal(historical.rootRecordSha256, replay.rootRecordSha256);
  });

  test("creates a private human eval event bound to the exact source root", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileFlightRecorderStore(root);
    await createCompleteTrace(store, "trace-eval");
    const replay = await store.load("trace-eval");
    assert.ok(replay);
    const surface = await FlightRecorderSurface.open(root);

    const event = await surface.createEval({
      traceId: replay.traceId,
      expectedRootSha256: replay.rootRecordSha256,
      expectedMissionBindingSha256: replay.missionBindingSha256,
      currentMissionBindingSha256: MISSION,
      contractSha256: DOCUMENT,
      acceptancePlanSha256: "3".repeat(64),
      expectedOutcome: "succeeded",
      occurredAt: TIME,
      evalCaseId: "flight-eval-one",
      eventId: "flight-eval-event-one",
    });
    assert.equal(event.sourceRootSha256, replay.rootRecordSha256);
    assert.equal(event.outcomeSource, "human");
    const raw = await fs.readFile(flightEvalLedgerPath(root), "utf8");
    const loaded = parseFlightEvalLedger(raw);
    assert.deepEqual(loaded, [event]);
    assert.doesNotMatch(raw, /prompt|response|source code|argv/i);

    await assert.rejects(
      surface.createEval({
        traceId: replay.traceId,
        expectedRootSha256: replay.rootRecordSha256,
        expectedMissionBindingSha256: replay.missionBindingSha256,
        currentMissionBindingSha256: MISSION,
        contractSha256: DOCUMENT,
        acceptancePlanSha256: "3".repeat(64),
        expectedOutcome: "succeeded",
        occurredAt: TIME,
        evalCaseId: "flight-eval-one",
        eventId: "flight-eval-event-two",
      }),
      /already exists/,
    );

    const tampered = raw.replace(replay.rootRecordSha256, "f".repeat(64));
    assert.throws(() => parseFlightEvalLedger(tampered), /hash chain is invalid/);
    assert.throws(() => parseFlightEvalLedger(raw.trimEnd()), /torn/);
  });

  test("prepares an isolated derived replay without persisting replacement content", async (t) => {
    const root = await tempRoot(t);
    const privateRoot = path.join(root, "private");
    const workspaceRoot = path.join(root, "workspace");
    await fs.mkdir(workspaceRoot, { recursive: true });
    const store = await openFileFlightRecorderStore(privateRoot);
    await createCompleteTrace(store, "trace-replay");
    const replay = await store.load("trace-replay");
    assert.ok(replay);
    const surface = await FlightRecorderSurface.open(privateRoot);
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const replacementInput = "Re-run the acceptance checks against the repaired parser.";

    const prepared = await surface.prepareReplay({
      traceId: replay.traceId,
      expectedRootSha256: replay.rootRecordSha256,
      expectedMissionBindingSha256: replay.missionBindingSha256,
      currentMissionBindingSha256: MISSION,
      replacementInput,
      workspaceRoot,
      privateWorkspaceRoot: privateRoot,
      replayId: "flight-replay-one",
      now: () => new Date(TIME),
      runGit: async (args, cwd) => {
        calls.push({ args: [...args], cwd });
        if (args[0] === "worktree" && args[1] === "add") {
          await fs.mkdir(String(args[3]), { recursive: true });
        }
      },
    });
    assert.equal(prepared.plan.contentBinding, "derived");
    assert.equal(prepared.plan.exactContentAvailable, false);
    assert.equal(prepared.replacementInput, replacementInput);
    assert.deepEqual(calls[0]?.args.slice(0, 3), ["worktree", "add", "--detach"]);
    assert.equal(calls[0]?.args.at(-1), BASE);
    const planText = await fs.readFile(
      path.join(privateRoot, "flight", "replays", "flight-replay-one", "plan.v1.json"),
      "utf8",
    );
    assert.doesNotMatch(planText, new RegExp(replacementInput));
    assert.match(planText, new RegExp(prepared.plan.replacementInputSha256));

    await assert.rejects(
      surface.prepareReplay({
        traceId: replay.traceId,
        expectedRootSha256: replay.rootRecordSha256,
        expectedMissionBindingSha256: replay.missionBindingSha256,
        currentMissionBindingSha256: MISSION,
        replacementInput,
        workspaceRoot,
        privateWorkspaceRoot: path.join(root, "different-private-root"),
        replayId: "flight-replay-wrong-root",
        runGit: async () => undefined,
      }),
      /private storage binding changed/,
    );
  });
});
