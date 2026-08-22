import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
  MISSION_FLIGHT_SMOKE_REPORT_MAX_BYTES,
  MissionFlightSmokeError,
  formatMissionFlightSmokeReport,
  missionFlightSmokeDiagnosticsRoot,
  missionFlightSmokeLatestReportPath,
  readMissionFlightSmokeLatestReport,
  runMissionFlightSmokeTest,
} from "../src/missionFlightSmoke";
import { MissionContractController } from "../src/missionContractController";

const EXPECTED_RECORD_ORDER = [
  "traceStarted:roomTurn",
  "operationStarted:phase",
  "operationEvent:phase",
  "operationStarted:agentRun",
  "operationStarted:usage",
  "operationEvent:usage",
  "operationFinished:usage",
  "operationFinished:agentRun",
  "operationStarted:verification",
  "operationEvent:verification",
  "operationFinished:verification",
  "operationStarted:nativeAction",
  "operationEvent:nativeAction",
  "operationFinished:nativeAction",
  "operationFinished:phase",
  "traceFinished:roomTurn",
] as const;

async function tempRoot(
  t: TestContext,
  prefix = "hydra-mission-flight-smoke-",
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

describe("Mission/Flight isolated smoke", () => {
  test("records a complete zero-cost synthetic lifecycle and leaves live ledgers untouched", async (t) => {
    const root = await tempRoot(t);
    const liveMission = await MissionContractController.open({
      privateWorkspaceRoot: root,
    });
    const liveLedgerBefore = await fs.readFile(
      liveMission.ledgerPath,
      "utf8",
    );

    const report = await runMissionFlightSmokeTest({
      privateWorkspaceRoot: root,
      now: () => new Date("2026-07-24T18:00:00.000Z"),
      runId:
        "mission-flight-smoke-11111111-1111-4111-8111-111111111111",
    });

    assert.equal(report.passed, true);
    assert.equal(report.failureStage, null);
    assert.equal(report.observed.missionEventCount, 4);
    assert.equal(report.observed.missionRevision, 2);
    assert.equal(report.observed.flightCompleteness, "complete");
    assert.equal(report.observed.flightRecordCount, 16);
    assert.deepEqual(
      report.observed.operationKinds,
      [
        "roomTurn",
        "phase",
        "agentRun",
        "usage",
        "verification",
        "nativeAction",
      ],
    );
    assert.deepEqual(
      report.observed.recordOrder,
      EXPECTED_RECORD_ORDER,
    );
    assert.equal(
      report.checks.every((check) => check.passed),
      true,
    );
    assert.match(
      formatMissionFlightSmokeReport(report),
      /Mission\/Flight smoke test passed/,
    );

    assert.equal(
      await fs.readFile(liveMission.ledgerPath, "utf8"),
      liveLedgerBefore,
    );
    await assert.rejects(
      fs.access(path.join(root, "flight")),
      { code: "ENOENT" },
    );

    const latest = await readMissionFlightSmokeLatestReport(root);
    assert.deepEqual(latest, report);
    const raw = await fs.readFile(
      missionFlightSmokeLatestReportPath(root),
    );
    assert.ok(
      raw.length <= MISSION_FLIGHT_SMOKE_REPORT_MAX_BYTES,
    );
    assert.equal(raw.includes(Buffer.from(root, "utf8")), false);
    assert.equal(
      raw.includes(
        Buffer.from(
          "HYDRA_MISSION_FLIGHT_PRIVATE_CONTENT_CANARY",
          "utf8",
        ),
      ),
      false,
    );

    const runs = await fs.readdir(
      path.join(missionFlightSmokeDiagnosticsRoot(root), "runs"),
    );
    assert.deepEqual(runs, []);
  });

  test("two concurrent runs use disjoint children and leave one strict atomic latest report", async (t) => {
    const root = await tempRoot(t);
    const runIds = [
      "mission-flight-smoke-22222222-2222-4222-8222-222222222222",
      "mission-flight-smoke-33333333-3333-4333-8333-333333333333",
    ] as const;
    const reports = await Promise.all(runIds.map((runId, index) =>
      runMissionFlightSmokeTest({
        privateWorkspaceRoot: root,
        now: () =>
          new Date(`2026-07-24T18:0${index + 1}:00.000Z`),
        runId,
      })));

    assert.equal(reports.every((report) => report.passed), true);
    const latest = await readMissionFlightSmokeLatestReport(root);
    assert.ok(latest);
    assert.ok(runIds.includes(latest.runId as typeof runIds[number]));
    assert.equal(latest.passed, true);
    assert.deepEqual(
      await fs.readdir(
        path.join(missionFlightSmokeDiagnosticsRoot(root), "runs"),
      ),
      [],
    );
    await assert.rejects(
      fs.access(path.join(root, "mission")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      fs.access(path.join(root, "flight")),
      { code: "ENOENT" },
    );
  });

  test("strict report loading rejects extra keys and oversized or malformed projections", async (t) => {
    const root = await tempRoot(t);
    const report = await runMissionFlightSmokeTest({
      privateWorkspaceRoot: root,
      runId:
        "mission-flight-smoke-44444444-4444-4444-8444-444444444444",
    });
    const latestPath = missionFlightSmokeLatestReportPath(root);

    await fs.writeFile(
      latestPath,
      `${JSON.stringify({ ...report, unexpected: true })}\n`,
      "utf8",
    );
    await assert.rejects(
      readMissionFlightSmokeLatestReport(root),
      (error: unknown) =>
        error instanceof MissionFlightSmokeError
        && error.code === "reportInvalid",
    );

    await fs.writeFile(latestPath, "{malformed}\n", "utf8");
    await assert.rejects(
      readMissionFlightSmokeLatestReport(root),
      (error: unknown) =>
        error instanceof MissionFlightSmokeError
        && error.code === "reportInvalid",
    );

    await fs.writeFile(
      latestPath,
      "x".repeat(MISSION_FLIGHT_SMOKE_REPORT_MAX_BYTES + 1),
      "utf8",
    );
    await assert.rejects(
      readMissionFlightSmokeLatestReport(root),
      (error: unknown) =>
        error instanceof MissionFlightSmokeError
        && error.code === "reportInvalid",
    );
  });

  test("storage failures surface only a sanitized stable code", async (t) => {
    const root = await tempRoot(t);
    const canaryPath = path.join(root, "SECRET-STORAGE-PATH-CANARY");
    await fs.writeFile(canaryPath, "not a directory", "utf8");

    await assert.rejects(
      runMissionFlightSmokeTest({
        privateWorkspaceRoot: canaryPath,
      }),
      (error: unknown) =>
        error instanceof MissionFlightSmokeError
        && error.code === "storageUnavailable"
        && !error.message.includes(canaryPath)
        && !error.message.includes("SECRET-STORAGE-PATH-CANARY"),
    );
  });

  test("the smoke helper has no provider, verifier, browser, panel, or workspace-log dependency", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src", "missionFlightSmoke.ts"),
      "utf8",
    );
    assert.doesNotMatch(source, /from "\.\/agents"/);
    assert.doesNotMatch(source, /from "\.\/verification"/);
    assert.doesNotMatch(source, /from "\.\/browserBroker"/);
    assert.doesNotMatch(source, /from "\.\/panel"/);
    assert.doesNotMatch(source, /\brunVerificationCommand\s*\(/);
    assert.doesNotMatch(source, /\brunAgent\s*\(/);
    assert.doesNotMatch(source, /node:child_process/);
    assert.doesNotMatch(source, /[\\/]\.hydra[\\/]/);
  });

  test("retains runtime ownership before any fallible synthetic lifecycle work", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src", "missionFlightSmoke.ts"),
      "utf8",
    );
    const methodStart = source.indexOf(
      "export async function runMissionFlightSmokeTest(",
    );
    const methodEnd = source.indexOf(
      "export async function readMissionFlightSmokeLatestReport(",
      methodStart,
    );
    const method = source.slice(methodStart, methodEnd);
    const runtimeAssignment = method.indexOf(
      "runtime = await createFlightRecorderRuntime(",
    );
    const lifecycle = method.indexOf(
      "const flight = await exerciseFlightLifecycle(",
    );
    const disposal = method.indexOf("runtime.dispose()", lifecycle);
    const cleanup = method.indexOf("await removeExactSmokeRun(storage)");
    assert.ok(runtimeAssignment >= 0 && runtimeAssignment < lifecycle);
    assert.ok(disposal > lifecycle && disposal < cleanup);
  });
});
