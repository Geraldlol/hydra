import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { UNBOUND_MISSION_BINDING_SHA256 } from "../src/missionContract";
import {
  FLIGHT_GENESIS_SHA256,
  FLIGHT_LIMITS,
  FLIGHT_SCHEMA_VERSION,
  FlightTraceValidationError,
  canonicalFlightJson,
  computeFlightRecordSha256,
  createFlightRecord,
  isFlightMissionBindingPair,
  isFlightRecord,
  replayFlightTrace,
  type FlightAgentRunSubject,
  type FlightOperationFinishedPayload,
  type FlightRecord,
  type FlightRecordDraft,
} from "../src/flightRecorderProtocol";

const TIME = "2026-07-24T12:00:00.000Z";
const MISSION = "1".repeat(64);
const DOCUMENT = "2".repeat(64);
const CHAIN = "3".repeat(64);

function traceStart(traceId = "trace-protocol"): FlightRecordDraft {
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
      ownerId: "extension-host-one",
      source: "localUser",
      contentCapture: "off",
      baseRevisionSha: "a".repeat(40),
      missionDocumentSha256: DOCUMENT,
      missionBindingSha256: MISSION,
    },
  };
}

function agentSubject(): FlightAgentRunSubject {
  return {
    kind: "agentRun",
    runId: "run-one",
    headId: "codex",
    agentKind: "codex",
    phase: "Build",
    provider: "openai",
    model: "gpt-test",
    plannedTransport: "appServer",
    authorityClass: "workspaceWrite",
    authoritySha256: "4".repeat(64),
    promptSha256: "5".repeat(64),
    contextSha256: "6".repeat(64),
    promptCharacters: 123,
    telemetryDetail: "structured",
    initialSteeringChain: { sha256: CHAIN, indeterminate: false },
    evidenceClass: "hydraObserved",
  };
}

function append(records: FlightRecord[], draft: FlightRecordDraft): FlightRecord {
  const record = createFlightRecord(
    draft,
    records.length + 1,
    records.at(-1)?.recordSha256 ?? FLIGHT_GENESIS_SHA256,
  );
  records.push(record);
  return record;
}

function agentStart(
  traceId = "trace-protocol",
  operationId = "operation-agent",
  parentOperationId?: string,
): FlightRecordDraft {
  return {
    recordId: `record-start-${operationId}`,
    traceId,
    occurredAt: TIME,
    recordType: "operationStarted",
    operationKind: "agentRun",
    operationId,
    ...(parentOperationId === undefined ? {} : { parentOperationId }),
    missionBindingSha256: MISSION,
    payload: { payloadType: "operationStarted", subject: agentSubject() },
  };
}

function agentFinish(
  traceId = "trace-protocol",
  operationId = "operation-agent",
  parentOperationId?: string,
): FlightRecordDraft {
  const payload: FlightOperationFinishedPayload = {
    payloadType: "operationFinished",
    status: "succeeded",
    durationMs: 10,
    failureCode: null,
    output: { bytes: 0, sha256: createHash("sha256").update("").digest("hex") },
    steeringChain: { sha256: CHAIN, indeterminate: false },
    actualTransport: "appServer",
    evidenceClass: "providerObserved",
  };
  return {
    recordId: `record-finish-${operationId}`,
    traceId,
    occurredAt: TIME,
    recordType: "operationFinished",
    operationKind: "agentRun",
    operationId,
    ...(parentOperationId === undefined ? {} : { parentOperationId }),
    missionBindingSha256: MISSION,
    payload,
  };
}

function traceFinish(
  records: readonly FlightRecord[],
  options: { incomplete?: boolean; limited?: boolean } = {},
): FlightRecordDraft {
  const incomplete = options.incomplete ?? false;
  const operationIds = new Set(
    records.flatMap((record) => record.operationId ? [record.operationId] : []),
  );
  const finishedIds = new Set(
    records
      .filter((record) => record.recordType === "operationFinished")
      .flatMap((record) => record.operationId ? [record.operationId] : []),
  );
  return {
    recordId: "record-trace-finish",
    traceId: records[0]?.traceId ?? "trace-protocol",
    occurredAt: TIME,
    recordType: "traceFinished",
    operationKind: "roomTurn",
    missionBindingSha256: MISSION,
    payload: {
      payloadType: "traceFinished",
      status: incomplete ? "incomplete" : "succeeded",
      durationMs: 10,
      operationCount: operationIds.size,
      openOperationCount: [...operationIds].filter((id) => !finishedIds.has(id)).length,
      recordCount: records.length + 1,
      limited: options.limited ?? false,
      incomplete,
    },
  };
}

function issueCodes(records: readonly FlightRecord[]): readonly string[] {
  try {
    replayFlightTrace(records);
    return [];
  } catch (error) {
    assert.ok(error instanceof FlightTraceValidationError);
    return error.issues.map((issue) => issue.code);
  }
}

describe("hydra.flight.v1 protocol", () => {
  test("creates a domain-separated canonical hash chain and replays a complete trace", () => {
    const records: FlightRecord[] = [];
    append(records, traceStart());
    append(records, agentStart());
    append(records, {
      recordId: "record-agent-dispatch",
      traceId: "trace-protocol",
      occurredAt: TIME,
      recordType: "operationEvent",
      operationKind: "agentRun",
      operationId: "operation-agent",
      missionBindingSha256: MISSION,
      payload: {
        payloadType: "operationEvent",
        observation: {
          kind: "agentRun",
          observationType: "dispatchDecision",
          decision: "submitted",
          code: null,
          invocationShapeSha256: "7".repeat(64),
        },
      },
    });
    append(records, agentFinish());
    append(records, traceFinish(records));

    const replay = replayFlightTrace(records);
    assert.equal(replay.completeness, "complete");
    assert.equal(replay.rootRecordSha256, records.at(-1)?.recordSha256);
    assert.equal(replay.openOperationCount, 0);
    assert.equal(records[0]?.previousRecordSha256, FLIGHT_GENESIS_SHA256);
    assert.equal(records[1]?.previousRecordSha256, records[0]?.recordSha256);

    const first = records[0]!;
    const withoutHash = { ...first } as Record<string, unknown>;
    delete withoutHash.recordSha256;
    const plainCanonicalHash = createHash("sha256")
      .update(canonicalFlightJson(withoutHash))
      .digest("hex");
    assert.notEqual(first.recordSha256, plainCanonicalHash);
    assert.equal(first.recordSha256, computeFlightRecordSha256(first));
  });

  test("rejects extra top-level and nested payload keys exactly", () => {
    const valid = createFlightRecord(traceStart(), 1, FLIGHT_GENESIS_SHA256);
    assert.equal(isFlightRecord(valid), true);
    assert.equal(isFlightRecord({ ...valid, detail: "forbidden" }), false);
    assert.equal(isFlightRecord({
      ...valid,
      payload: { ...valid.payload, prompt: "CONTENT-CANARY" },
    }), false);
    assert.equal(isFlightRecord({ ...valid, schemaVersion: 2 }), false);
  });

  test("requires planned and exact terminal transport evidence for agent runs", () => {
    const start = createFlightRecord(
      agentStart(),
      1,
      FLIGHT_GENESIS_SHA256,
    );
    assert.equal(isFlightRecord(start), true);
    assert.equal(isFlightRecord({
      ...start,
      payload: {
        ...start.payload,
        subject: {
          ...(start.payload as { subject: FlightAgentRunSubject }).subject,
          plannedTransport: undefined,
        },
      },
    }), false);

    const finish = createFlightRecord(
      agentFinish(),
      1,
      FLIGHT_GENESIS_SHA256,
    );
    assert.equal(isFlightRecord(finish), true);
    assert.equal(isFlightRecord({
      ...finish,
      payload: {
        ...finish.payload,
        actualTransport: null,
      },
    }), false);
  });

  test("detects hash, sequence, previous-hash, and mission corruption", () => {
    const records: FlightRecord[] = [];
    append(records, traceStart());
    append(records, agentStart());

    const hashTampered = records.map((record, index) =>
      index === 1 ? { ...record, recordSha256: "f".repeat(64) } : record
    );
    assert.ok(issueCodes(hashTampered).includes("invalidHash"));

    const sequenceTampered = records.map((record, index) =>
      index === 1
        ? { ...record, sequence: 9, recordSha256: computeFlightRecordSha256({ ...record, sequence: 9 }) }
        : record
    );
    assert.ok(issueCodes(sequenceTampered).includes("invalidSequence"));

    const previousTampered = records.map((record, index) =>
      index === 1
        ? {
            ...record,
            previousRecordSha256: "e".repeat(64),
            recordSha256: computeFlightRecordSha256({
              ...record,
              previousRecordSha256: "e".repeat(64),
            }),
          }
        : record
    );
    assert.ok(issueCodes(previousTampered).includes("invalidPreviousHash"));

    const missionTampered = records.map((record, index) => {
      if (index !== 1) return record;
      const changed = { ...record, missionBindingSha256: "9".repeat(64) };
      return { ...changed, recordSha256: computeFlightRecordSha256(changed) };
    });
    assert.ok(issueCodes(missionTampered).includes("missionMismatch"));
  });

  test("uses sequence as causality and accepts out-of-order canonical wall clocks", () => {
    const records: FlightRecord[] = [];
    append(records, traceStart("trace-clock"));
    append(records, {
      ...agentStart("trace-clock", "agent"),
      occurredAt: "2026-07-24T11:59:00.000Z",
    });
    append(records, {
      ...agentFinish("trace-clock", "agent"),
      occurredAt: "2026-07-24T11:58:00.000Z",
    });
    append(records, {
      ...traceFinish(records),
      traceId: "trace-clock",
      occurredAt: "2026-07-24T11:57:00.000Z",
    });
    assert.equal(replayFlightTrace(records).completeness, "complete");
  });

  test("fails closed across operation lifecycle permutations", () => {
    const orphan: FlightRecord[] = [];
    append(orphan, traceStart("trace-orphan"));
    append(orphan, {
      ...agentFinish("trace-orphan", "missing"),
      recordId: "record-orphan-finish",
    });
    assert.ok(issueCodes(orphan).includes("unknownOperation"));

    const duplicate: FlightRecord[] = [];
    append(duplicate, traceStart("trace-duplicate"));
    append(duplicate, agentStart("trace-duplicate", "same"));
    append(duplicate, {
      ...agentStart("trace-duplicate", "same"),
      recordId: "record-second-start",
    });
    assert.ok(issueCodes(duplicate).includes("duplicateOperationId"));

    const doubleFinish: FlightRecord[] = [];
    append(doubleFinish, traceStart("trace-double"));
    append(doubleFinish, agentStart("trace-double", "agent"));
    append(doubleFinish, agentFinish("trace-double", "agent"));
    append(doubleFinish, {
      ...agentFinish("trace-double", "agent"),
      recordId: "record-double-finish",
    });
    assert.ok(issueCodes(doubleFinish).includes("doubleOperationFinish"));

    const eventAfterFinish: FlightRecord[] = [];
    append(eventAfterFinish, traceStart("trace-after"));
    append(eventAfterFinish, agentStart("trace-after", "agent"));
    append(eventAfterFinish, agentFinish("trace-after", "agent"));
    append(eventAfterFinish, {
      recordId: "record-after-finish",
      traceId: "trace-after",
      occurredAt: TIME,
      recordType: "operationEvent",
      operationKind: "agentRun",
      operationId: "agent",
      missionBindingSha256: MISSION,
      payload: {
        payloadType: "operationEvent",
        observation: {
          kind: "agentRun",
          observationType: "telemetryAvailability",
          detail: "unavailable",
          reason: "plainOutput",
        },
      },
    });
    assert.ok(issueCodes(eventAfterFinish).includes("operationAfterFinish"));
  });

  test("rejects orphan and closed parents, parent changes, and operation-kind changes", () => {
    const orphanParent: FlightRecord[] = [];
    append(orphanParent, traceStart("trace-parent-orphan"));
    append(orphanParent, agentStart("trace-parent-orphan", "child", "missing"));
    assert.ok(issueCodes(orphanParent).includes("orphanParent"));

    const parentChange: FlightRecord[] = [];
    append(parentChange, traceStart("trace-parent-change"));
    append(parentChange, agentStart("trace-parent-change", "parent"));
    append(parentChange, agentStart("trace-parent-change", "child", "parent"));
    append(parentChange, {
      ...agentFinish("trace-parent-change", "child"),
      recordId: "record-parent-change",
    });
    assert.ok(issueCodes(parentChange).includes("parentMismatch"));

    const kindChange: FlightRecord[] = [];
    append(kindChange, traceStart("trace-kind-change"));
    append(kindChange, agentStart("trace-kind-change", "agent"));
    append(kindChange, {
      recordId: "record-kind-change",
      traceId: "trace-kind-change",
      occurredAt: TIME,
      recordType: "operationFinished",
      operationKind: "phase",
      operationId: "agent",
      missionBindingSha256: MISSION,
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
    assert.ok(issueCodes(kindChange).includes("operationKindMismatch"));

    const parentBeforeChild: FlightRecord[] = [];
    append(parentBeforeChild, traceStart("trace-parent-order"));
    append(parentBeforeChild, agentStart("trace-parent-order", "parent"));
    append(parentBeforeChild, agentStart("trace-parent-order", "child", "parent"));
    append(parentBeforeChild, agentFinish("trace-parent-order", "parent"));
    assert.ok(issueCodes(parentBeforeChild).includes("operationHasOpenChildren"));
  });

  test("bounds concurrently open operations and permits only explicit incomplete closure", () => {
    const records: FlightRecord[] = [];
    append(records, traceStart("trace-open-limit"));
    for (let index = 0; index <= FLIGHT_LIMITS.maxOpenOperations; index += 1) {
      append(records, agentStart("trace-open-limit", `agent-${index}`));
    }
    assert.ok(issueCodes(records).includes("openOperationLimit"));

    const incomplete: FlightRecord[] = [];
    append(incomplete, traceStart("trace-incomplete"));
    append(incomplete, agentStart("trace-incomplete", "agent"));
    append(incomplete, {
      recordId: "record-limit",
      traceId: "trace-incomplete",
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
    assert.equal(replayFlightTrace(incomplete).completeness, "limited");
    append(incomplete, traceFinish(incomplete, { incomplete: true, limited: true }));
    assert.equal(replayFlightTrace(incomplete).completeness, "limited");

    const recordAfterLimit: FlightRecord[] = [];
    append(recordAfterLimit, traceStart("trace-absorbing-limit"));
    append(recordAfterLimit, {
      recordId: "record-absorbing-limit",
      traceId: "trace-absorbing-limit",
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
    append(recordAfterLimit, agentStart("trace-absorbing-limit", "too-late"));
    assert.ok(issueCodes(recordAfterLimit).includes("recordAfterTraceLimit"));

    const falseComplete = incomplete.map((record, index) => {
      if (index !== incomplete.length - 1) return record;
      const changed = {
        ...record,
        payload: {
          ...(record.payload as Extract<FlightRecord["payload"], { payloadType: "traceFinished" }>),
          status: "succeeded" as const,
          incomplete: false,
        },
      };
      return { ...changed, recordSha256: computeFlightRecordSha256(changed) };
    });
    assert.ok(issueCodes(falseComplete).includes("invalidTraceFinish"));
  });

  test("rejects contradictory bound and unbound Mission hash pairs", () => {
    assert.equal(isFlightMissionBindingPair(null, UNBOUND_MISSION_BINDING_SHA256), true);
    assert.equal(isFlightMissionBindingPair(DOCUMENT, MISSION), true);
    assert.equal(isFlightMissionBindingPair(null, MISSION), false);
    assert.equal(
      isFlightMissionBindingPair(DOCUMENT, UNBOUND_MISSION_BINDING_SHA256),
      false,
    );

    assert.throws(
      () => createFlightRecord({
        ...traceStart("trace-bad-unbound"),
        payload: {
          ...(traceStart("trace-bad-unbound").payload as Extract<
            FlightRecordDraft["payload"],
            { payloadType: "traceStarted" }
          >),
          missionDocumentSha256: null,
        },
      }, 1, FLIGHT_GENESIS_SHA256),
      /invalid hydra\.flight\.v1 record/,
    );
    assert.throws(
      () => createFlightRecord({
        ...traceStart("trace-bad-bound"),
        missionBindingSha256: UNBOUND_MISSION_BINDING_SHA256,
        payload: {
          ...(traceStart("trace-bad-bound").payload as Extract<
            FlightRecordDraft["payload"],
            { payloadType: "traceStarted" }
          >),
          missionBindingSha256: UNBOUND_MISSION_BINDING_SHA256,
        },
      }, 1, FLIGHT_GENESIS_SHA256),
      /invalid hydra\.flight\.v1 record/,
    );
  });

  test("pins schema and hard capacity constants", () => {
    assert.equal(FLIGHT_SCHEMA_VERSION, 1);
    assert.equal(FLIGHT_LIMITS.maxTraceBytes, 8 * 1024 * 1024);
    assert.equal(FLIGHT_LIMITS.maxRecordsPerTrace, 10_000);
    assert.equal(FLIGHT_LIMITS.maxRecordBytes, 16 * 1024);
    assert.equal(FLIGHT_LIMITS.reservedTerminalRecords, 2);
    assert.equal(FLIGHT_LIMITS.reservedTerminalBytes, 32 * 1024);
  });
});
