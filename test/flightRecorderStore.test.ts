import { describe, test, type TestContext } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  FLIGHT_GENESIS_SHA256,
  FLIGHT_LIMITS,
  canonicalFlightJson,
  createFlightRecord,
  type FlightRecordDraft,
} from "../src/flightRecorderProtocol";
import { serializePerFileAcrossProcesses } from "../src/fileQueue";
import {
  FileFlightRecorderStore,
  FlightTraceCapacityError,
  FlightTraceFileError,
  cleanupFlightRecorderStorage,
  evaluateFlightAppendCapacity,
  flightRecorderPaths,
  flightTracePath,
  openFileFlightRecorderStore,
  rebuildFlightRecorderIndex,
  recoverStaleFlightTraces,
  startFlightRecorderOwnerLease,
  type FlightRecorderStoreLimits,
} from "../src/flightRecorderStore";

const TIME = "2026-07-24T12:00:00.000Z";
const MISSION = "1".repeat(64);
const DOCUMENT = "2".repeat(64);

async function tempRoot(t: TestContext, prefix = "hydra-flight-store-"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function startDraft(traceId: string, ownerId = "owner-one"): FlightRecordDraft {
  return {
    recordId: `record-${traceId}-start`,
    traceId,
    occurredAt: TIME,
    recordType: "traceStarted",
    operationKind: "roomTurn",
    missionBindingSha256: MISSION,
    payload: {
      payloadType: "traceStarted",
      roomTurnId: `room-${traceId}`,
      ownerId,
      source: "localUser",
      contentCapture: "off",
      baseRevisionSha: "a".repeat(40),
      missionDocumentSha256: DOCUMENT,
      missionBindingSha256: MISSION,
    },
  };
}

function phaseStartDraft(traceId: string, suffix: string): FlightRecordDraft {
  return {
    recordId: `record-${suffix}`,
    traceId,
    occurredAt: TIME,
    recordType: "operationStarted",
    operationKind: "phase",
    operationId: `operation-${suffix}`,
    missionBindingSha256: MISSION,
    payload: {
      payloadType: "operationStarted",
      subject: { kind: "phase", phase: `phase-${suffix}` },
    },
  };
}

async function finishEmptyTrace(
  store: FileFlightRecorderStore,
  traceId: string,
): Promise<void> {
  const replay = await store.load(traceId);
  assert.ok(replay);
  await store.append({
    recordId: `record-${traceId}-finish`,
    traceId,
    occurredAt: TIME,
    recordType: "traceFinished",
    operationKind: "roomTurn",
    missionBindingSha256: MISSION,
    payload: {
      payloadType: "traceFinished",
      status: "succeeded",
      durationMs: 0,
      operationCount: 0,
      openOperationCount: 0,
      recordCount: replay.records.length + 1,
      limited: false,
      incomplete: false,
    },
  });
}

describe("private Flight Recorder store", () => {
  test("contains trace paths beneath extension-private storage", async (t) => {
    const root = await tempRoot(t);
    const paths = flightRecorderPaths(root);
    assert.equal(paths.rootPath, path.resolve(root, "flight"));
    assert.equal(paths.tracesPath, path.resolve(root, "flight", "traces"));
    assert.equal(paths.indexPath, path.resolve(root, "flight", "index.v1.jsonl"));
    assert.equal(
      flightTracePath(root, "trace-safe"),
      path.resolve(root, "flight", "traces", "trace-safe.v1.jsonl"),
    );
    for (const unsafe of ["../escape", "..", "a/b", "a\\b", "", "."]) {
      assert.throws(() => flightTracePath(root, unsafe), /not safe|escapes/);
    }
  });

  test("reloads and validates under the cross-process lock before concurrent append", async (t) => {
    const root = await tempRoot(t);
    const first = await openFileFlightRecorderStore(root);
    const second = await openFileFlightRecorderStore(root);
    await first.append(startDraft("trace-race"));

    await Promise.all([
      first.append(phaseStartDraft("trace-race", "a")),
      second.append(phaseStartDraft("trace-race", "b")),
    ]);
    const replay = await first.load("trace-race");
    assert.ok(replay);
    assert.equal(replay.records.length, 3);
    assert.deepEqual(
      new Set(replay.operations.map((operation) => operation.operationId)),
      new Set(["operation-a", "operation-b"]),
    );
    assert.deepEqual(replay.records.map((record) => record.sequence), [1, 2, 3]);
  });

  test("makes an exact same-ID concurrent append idempotent without duplicating a row", async (t) => {
    const root = await tempRoot(t);
    const first = await openFileFlightRecorderStore(root);
    const second = await openFileFlightRecorderStore(root);
    await first.append(startDraft("trace-idempotent"));
    const draft = phaseStartDraft("trace-idempotent", "same");

    const [left, right] = await Promise.all([
      first.append(draft),
      second.append(draft),
    ]);
    assert.equal(left.recordSha256, right.recordSha256);
    assert.equal((await first.load("trace-idempotent"))?.records.length, 2);

    await assert.rejects(
      () => second.append({
        ...draft,
        payload: {
          payloadType: "operationStarted",
          subject: { kind: "phase", phase: "different" },
        },
      }),
      /collided with different metadata/,
    );
  });

  test("fails closed on torn, malformed, unknown-version, blank, and oversized rows", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileFlightRecorderStore(root);
    const traceId = "trace-invalid";
    const filePath = flightTracePath(root, traceId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const valid = createFlightRecord(startDraft(traceId), 1, FLIGHT_GENESIS_SHA256);
    const { traceId: reorderedTraceId, ...reorderedRest } = valid;

    const cases: Array<[string, string, FlightTraceFileError["code"]]> = [
      ["torn", JSON.stringify(valid), "torn"],
      ["malformed", "{not-json}\n", "malformed"],
      ["unknown", '{"schemaVersion":2}\n', "unknownVersion"],
      ["blank", "\n", "blankLine"],
      ["oversized", `${"x".repeat(FLIGHT_LIMITS.maxRecordBytes + 1)}\n`, "oversized"],
      ["noncanonical", `${JSON.stringify({ traceId: reorderedTraceId, ...reorderedRest })}\n`, "invalid"],
    ];
    for (const [, content, code] of cases) {
      await fs.writeFile(filePath, content, "utf8");
      await assert.rejects(
        () => store.load(traceId),
        (error: unknown) => error instanceof FlightTraceFileError && error.code === code,
      );
    }
    await fs.writeFile(filePath, Buffer.from([0xff, 0x0a]));
    await assert.rejects(
      () => store.load(traceId),
      (error: unknown) => error instanceof FlightTraceFileError
        && error.code === "malformed"
        && /UTF-8/.test(error.message),
    );
  });

  test("treats traceLimited as absorbing while preserving one incomplete finish", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileFlightRecorderStore(root);
    const traceId = "trace-absorbing-limit";
    await store.append(startDraft(traceId));
    await store.append({
      recordId: "record-limit",
      traceId,
      occurredAt: TIME,
      recordType: "traceLimited",
      operationKind: "roomTurn",
      missionBindingSha256: MISSION,
      payload: {
        payloadType: "traceLimited",
        reason: "providerFlood",
        droppedRecordsAtLeast: 1,
        telemetryCompleteness: "limited",
      },
    });
    await assert.rejects(
      () => store.append(phaseStartDraft(traceId, "after-limit")),
      /absorbing traceLimited/,
    );
    const beforeFinish = await store.load(traceId);
    assert.ok(beforeFinish);
    assert.equal(beforeFinish.completeness, "limited");
    await store.append({
      recordId: "record-finish",
      traceId,
      occurredAt: TIME,
      recordType: "traceFinished",
      operationKind: "roomTurn",
      missionBindingSha256: MISSION,
      payload: {
        payloadType: "traceFinished",
        status: "incomplete",
        durationMs: 0,
        operationCount: 0,
        openOperationCount: 0,
        recordCount: beforeFinish.records.length + 1,
        limited: true,
        incomplete: true,
      },
    });
    const replay = await store.load(traceId);
    assert.equal(replay?.completeness, "limited");
    assert.deepEqual(
      replay?.records.map((record) => record.recordType),
      ["traceStarted", "traceLimited", "traceFinished"],
    );
  });

  test("reserves exact count and byte capacity for one limit and one finish", () => {
    const limits = {
      maxTraceBytes: FLIGHT_LIMITS.maxTraceBytes,
      maxRecordsPerTrace: FLIGHT_LIMITS.maxRecordsPerTrace,
      maxRecordBytes: FLIGHT_LIMITS.maxRecordBytes,
      reservedTerminalRecords: FLIGHT_LIMITS.reservedTerminalRecords,
      reservedTerminalBytes: FLIGHT_LIMITS.reservedTerminalBytes,
    };
    assert.deepEqual(evaluateFlightAppendCapacity({
      currentRecords: FLIGHT_LIMITS.maxRecordsPerTrace - 3,
      currentBytes: 0,
      candidateBytes: 1,
      recordType: "operationEvent",
    }, limits), { accepted: true });
    assert.deepEqual(evaluateFlightAppendCapacity({
      currentRecords: FLIGHT_LIMITS.maxRecordsPerTrace - 2,
      currentBytes: 0,
      candidateBytes: 1,
      recordType: "operationEvent",
    }, limits), { accepted: false, reason: "recordCapacity" });
    assert.deepEqual(evaluateFlightAppendCapacity({
      currentRecords: 1,
      currentBytes: FLIGHT_LIMITS.maxTraceBytes - FLIGHT_LIMITS.reservedTerminalBytes - 100,
      candidateBytes: 100,
      recordType: "operationEvent",
    }, limits), { accepted: true });
    assert.deepEqual(evaluateFlightAppendCapacity({
      currentRecords: 1,
      currentBytes: FLIGHT_LIMITS.maxTraceBytes - FLIGHT_LIMITS.reservedTerminalBytes - 100,
      candidateBytes: 101,
      recordType: "operationEvent",
    }, limits), { accepted: false, reason: "byteCapacity" });
    assert.deepEqual(evaluateFlightAppendCapacity({
      currentRecords: FLIGHT_LIMITS.maxRecordsPerTrace - 2,
      currentBytes: 0,
      candidateBytes: 1,
      recordType: "traceLimited",
    }, limits), { accepted: true });
    assert.deepEqual(evaluateFlightAppendCapacity({
      currentRecords: FLIGHT_LIMITS.maxRecordsPerTrace - 1,
      currentBytes: 0,
      candidateBytes: 1,
      recordType: "traceFinished",
    }, limits), { accepted: true });
  });

  test("enforces smaller test bounds without permitting larger production bounds", async (t) => {
    const root = await tempRoot(t);
    const limits: FlightRecorderStoreLimits = {
      maxTraceBytes: 64 * 1024,
      maxRecordsPerTrace: 4,
      maxRecordBytes: 4 * 1024,
      reservedTerminalRecords: 2,
      reservedTerminalBytes: 8 * 1024,
    };
    const store = await openFileFlightRecorderStore(root, limits);
    await store.append(startDraft("trace-small"));
    await store.append(phaseStartDraft("trace-small", "one"));
    await assert.rejects(
      () => store.append(phaseStartDraft("trace-small", "two")),
      (error: unknown) => error instanceof FlightTraceCapacityError
        && error.reason === "recordCapacity",
    );
    assert.throws(
      () => new FileFlightRecorderStore(root, {
        ...limits,
        maxTraceBytes: FLIGHT_LIMITS.maxTraceBytes + 1,
      }),
      /hard bounds/,
    );
  });

  test("treats index as a rebuildable discovery cache, never trace authority", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileFlightRecorderStore(root);
    await store.append(startDraft("trace-index"));
    await finishEmptyTrace(store, "trace-index");

    const entries = await rebuildFlightRecorderIndex(store);
    assert.equal(entries[0]?.completeness, "complete");
    await fs.writeFile(store.paths.indexPath, "MALICIOUS CONTENT-CANARY\n", "utf8");
    assert.equal((await store.load("trace-index"))?.completeness, "complete");
    const rebuilt = await rebuildFlightRecorderIndex(store);
    assert.equal(rebuilt[0]?.traceId, "trace-index");
    assert.doesNotMatch(await fs.readFile(store.paths.indexPath, "utf8"), /CONTENT-CANARY/);
  });

  test("refuses a hard-linked trace artifact", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileFlightRecorderStore(root);
    const outside = path.join(root, "outside.jsonl");
    const tracePath = flightTracePath(root, "trace-hardlink");
    await fs.mkdir(path.dirname(tracePath), { recursive: true });
    await fs.writeFile(outside, "", "utf8");
    try {
      await fs.link(outside, tracePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Hard links are unavailable in this environment.");
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => store.append(startDraft("trace-hardlink")),
      /hard-linked|hard links|unsafe/i,
    );
  });

  test("owner lease fences active traces and stale recovery closes once as incomplete", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileFlightRecorderStore(root);
    const lease = await startFlightRecorderOwnerLease(root, "owner-live");
    await store.append(startDraft("trace-live", "owner-live"));
    assert.equal(await lease.isOwnerActive("owner-live"), true);
    assert.deepEqual(
      await recoverStaleFlightTraces(store, (owner) => lease.isOwnerActive(owner)),
      [],
    );

    lease.dispose();
    assert.equal(await lease.isOwnerActive("owner-live"), false);
    let nextId = 0;
    assert.deepEqual(
      await recoverStaleFlightTraces(
        store,
        (owner) => lease.isOwnerActive(owner),
        {
          now: () => TIME,
          newRecordId: () => `record-recovery-${++nextId}`,
        },
      ),
      ["trace-live"],
    );
    const replay = await store.load("trace-live");
    assert.equal(replay?.completeness, "limited");
    assert.equal(replay?.records.filter((record) => record.recordType === "traceLimited").length, 1);
    assert.deepEqual(
      await recoverStaleFlightTraces(store, async () => false),
      [],
    );
  });

  test("retention removes only finalized traces and preserves active owner traces", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileFlightRecorderStore(root);
    await store.append(startDraft("trace-active", "owner-live"));
    await store.append(startDraft("trace-finished", "owner-old"));
    await finishEmptyTrace(store, "trace-finished");
    const activeBytes = (await fs.stat(flightTracePath(root, "trace-active"))).size;

    const result = await cleanupFlightRecorderStorage(store, {
      maxFiles: 1,
      maxTotalBytes: Number.MAX_SAFE_INTEGER,
    });
    assert.deepEqual(result.removedTraceIds, ["trace-finished"]);
    assert.deepEqual(result.retainedTraceIds, ["trace-active"]);
    assert.equal(result.totalBytes, activeBytes);
    assert.ok(await store.load("trace-active"));
    assert.equal(await store.load("trace-finished"), undefined);
  });

  test("retention waits through an active append and cannot delete its transient torn line", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileFlightRecorderStore(root);
    const traceId = "trace-active-append";
    const tracePath = flightTracePath(root, traceId);
    const record = createFlightRecord(startDraft(traceId), 1, FLIGHT_GENESIS_SHA256);
    const line = `${canonicalFlightJson(record)}\n`;
    const splitAt = Math.max(1, Math.floor(line.length / 2));
    let releaseWriter!: () => void;
    const writerRelease = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let partialReady!: () => void;
    const partialWritten = new Promise<void>((resolve) => {
      partialReady = resolve;
    });

    const writer = serializePerFileAcrossProcesses(tracePath, async () => {
      await fs.mkdir(path.dirname(tracePath), { recursive: true });
      await fs.writeFile(tracePath, line.slice(0, splitAt), "utf8");
      partialReady();
      await writerRelease;
      await fs.appendFile(tracePath, line.slice(splitAt), "utf8");
    });
    await partialWritten;

    const cleanup = cleanupFlightRecorderStorage(store, {
      maxFiles: 0,
      maxTotalBytes: 0,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseWriter();
    await writer;

    const result = await cleanup;
    assert.deepEqual(result.removedTraceIds, []);
    assert.deepEqual(result.retainedTraceIds, [traceId]);
    assert.equal((await store.load(traceId))?.state, "active");
  });

  test("concurrent retention treats another cleaner's unlink as benign", async (t) => {
    const root = await tempRoot(t);
    const first = await openFileFlightRecorderStore(root);
    const second = await openFileFlightRecorderStore(root);
    const traceId = "trace-concurrent-cleanup";
    await first.append(startDraft(traceId));
    await finishEmptyTrace(first, traceId);

    const limits = { maxFiles: 0, maxTotalBytes: 0 };
    const [left, right] = await Promise.all([
      cleanupFlightRecorderStorage(first, limits),
      cleanupFlightRecorderStorage(second, limits),
    ]);

    assert.equal(
      left.removedTraceIds.includes(traceId) || right.removedTraceIds.includes(traceId),
      true,
    );
    assert.equal(await first.load(traceId), undefined);
  });

  test("retention counts and prunes a corrupt-file storm without touching active traces", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileFlightRecorderStore(root);
    await store.append(startDraft("trace-active-storm", "owner-live"));
    await fs.mkdir(store.paths.tracesPath, { recursive: true });
    const corruptIds = Array.from({ length: 8 }, (_, index) => `trace-corrupt-${index}`);
    for (const traceId of corruptIds) {
      await fs.writeFile(flightTracePath(root, traceId), '{"torn":true', "utf8");
    }

    const result = await cleanupFlightRecorderStorage(store, {
      maxFiles: 1,
      maxTotalBytes: Number.MAX_SAFE_INTEGER,
    });
    assert.deepEqual(new Set(result.removedTraceIds), new Set(corruptIds));
    assert.deepEqual(result.retainedTraceIds, ["trace-active-storm"]);
    assert.equal((await store.load("trace-active-storm"))?.state, "active");
    for (const traceId of corruptIds) {
      await assert.rejects(
        fs.stat(flightTracePath(root, traceId)),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
      );
    }
  });
});
