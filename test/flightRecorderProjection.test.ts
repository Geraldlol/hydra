import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildFlightNativeActionProjection,
  buildFlightProviderTelemetryProjection,
  buildFlightUsageProjection,
  buildFlightVerificationProjection,
  type BuildFlightVerificationProjectionInput,
} from "../src/flightRecorderProjection";
import type { NativeActionReceipt, NativeActionStatus } from "../src/nativeActions";
import type { UsageRecord } from "../src/usage";

const SOURCE_CHAIN = Object.freeze({
  sha256: "a".repeat(64),
  indeterminate: true,
});

function verificationInput(
  result: BuildFlightVerificationProjectionInput["result"],
): BuildFlightVerificationProjectionInput {
  return {
    verificationId: "verification-one",
    resolution: { kind: "explicit", command: "npm test" },
    timeoutMs: 60_000,
    maxOutputChars: 4_096,
    result,
    source: {
      runId: "run-one",
      steeringChain: SOURCE_CHAIN,
    },
    platform: "linux",
  };
}

function verificationResult(
  partial: Partial<BuildFlightVerificationProjectionInput["result"]> = {},
): BuildFlightVerificationProjectionInput["result"] {
  return {
    timestamp: "2026-07-24T12:00:00.000Z",
    command: "npm test",
    cwd: "/workspace",
    exitCode: 0,
    timedOut: false,
    durationMs: 125,
    stdout: "retained stdout tail",
    stderr: "retained stderr tail",
    stdoutBytes: 8_192,
    stdoutSha256: "b".repeat(64),
    stderrBytes: 4_096,
    stderrSha256: "c".repeat(64),
    headSha: "d".repeat(40),
    ...partial,
  };
}

function usageRecord(partial: Partial<UsageRecord> = {}): UsageRecord {
  return {
    timestamp: "2026-07-24T12:00:00.000Z",
    sessionId: "session-one",
    agent: "codex",
    agentKind: "codex",
    phase: "build",
    requestId: "run-one",
    model: "gpt-test",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheCreateTokens: 4,
    reasoningTokens: 5,
    totalTokens: 154,
    costUsd: 0.0123,
    costSource: "computed",
    source: "codexJson",
    ...partial,
  };
}

function nativeReceipt(status: NativeActionStatus): NativeActionReceipt {
  return {
    id: `native-${status}`,
    timestamp: "2026-07-24T12:00:00.000Z",
    agents: ["codex", "claude"],
    instruction: "NATIVE-INSTRUCTION-CONTENT-CANARY",
    includeEditorContext: true,
    includeWorkspaceDiff: true,
    editorContext: {
      label: "EDITOR-PATH-CONTENT-CANARY",
      selected: true,
      startLine: 2,
      endLine: 3,
      chars: 24,
      originalChars: 24,
      truncated: false,
    },
    workspaceDiffChars: 512,
    promptEnvelopeIds: ["prompt-envelope-one"],
    nativeSessionHints: [{
      agent: "codex",
      source: "codex-session-index",
      sessionId: "PRIVATE-SESSION-CONTENT-CANARY",
      pathLabel: "PRIVATE-PATH-CONTENT-CANARY",
    }],
    status,
  };
}

describe("Flight Recorder metadata projections", () => {
  test("verification maps every terminal outcome without losing full-output metadata or source steering", () => {
    const cases: Array<{
      readonly name: string;
      readonly result: BuildFlightVerificationProjectionInput["result"];
      readonly expected: {
        readonly status: string;
        readonly failureCode: string | null;
      };
    }> = [
      {
        name: "success",
        result: verificationResult(),
        expected: { status: "succeeded", failureCode: null },
      },
      {
        name: "nonzero",
        result: verificationResult({ exitCode: 2 }),
        expected: { status: "failed", failureCode: "validationFailure" },
      },
      {
        name: "spawn failure",
        result: verificationResult({ exitCode: null }),
        expected: { status: "failed", failureCode: "transportFailure" },
      },
      {
        name: "timeout",
        result: verificationResult({ exitCode: null, timedOut: true }),
        expected: { status: "timedOut", failureCode: "timeout" },
      },
      {
        name: "cancel",
        result: verificationResult({ exitCode: null, cancelled: true }),
        expected: { status: "cancelled", failureCode: "cancelled" },
      },
      {
        name: "unconfirmed termination outranks cancellation",
        result: verificationResult({
          exitCode: null,
          cancelled: true,
          terminationFailed: true,
        }),
        expected: {
          status: "deliveryUnknown",
          failureCode: "terminationUnconfirmed",
        },
      },
    ];

    for (const scenario of cases) {
      const projection = buildFlightVerificationProjection(
        verificationInput(scenario.result),
      );
      assert.deepEqual(projection.outcome, scenario.expected, scenario.name);
      assert.equal(projection.observation.stdout.bytes, 8_192, scenario.name);
      assert.equal(
        projection.observation.stdout.sha256,
        "b".repeat(64),
        scenario.name,
      );
      assert.equal(projection.observation.stderr.bytes, 4_096, scenario.name);
      assert.equal(
        projection.observation.stderr.sha256,
        "c".repeat(64),
        scenario.name,
      );
      assert.equal(projection.subject.sourceRunId, "run-one", scenario.name);
      assert.deepEqual(
        projection.subject.sourceSteeringChain,
        SOURCE_CHAIN,
        scenario.name,
      );
      assert.deepEqual(
        projection.observation.sourceSteeringChain,
        SOURCE_CHAIN,
        scenario.name,
      );
    }
  });

  test("verification falls back to retained-output metadata and keeps an absent source pair null", () => {
    const stdout = "bounded stdout";
    const stderr = "bounded stderr";
    const input = verificationInput(verificationResult({
      stdout,
      stderr,
      stdoutBytes: undefined,
      stdoutSha256: undefined,
      stderrBytes: undefined,
      stderrSha256: undefined,
    }));
    const projection = buildFlightVerificationProjection({
      ...input,
      source: undefined,
    });

    assert.deepEqual(projection.observation.stdout, {
      bytes: Buffer.byteLength(stdout, "utf8"),
      sha256: createHash("sha256").update(stdout, "utf8").digest("hex"),
    });
    assert.deepEqual(projection.observation.stderr, {
      bytes: Buffer.byteLength(stderr, "utf8"),
      sha256: createHash("sha256").update(stderr, "utf8").digest("hex"),
    });
    assert.equal(projection.subject.sourceRunId, null);
    assert.equal(projection.subject.sourceSteeringChain, null);
    assert.equal(projection.observation.sourceSteeringChain, null);
  });

  test("usage binds the terminal steering chain and rejects malformed numeric metadata", () => {
    const projection = buildFlightUsageProjection({
      usageId: "usage-one",
      runId: "run-one",
      model: "gpt-test",
      record: usageRecord(),
      steeringChain: SOURCE_CHAIN,
    });
    assert.ok(projection);
    assert.equal(projection.subject.source, "computed");
    assert.deepEqual(projection.observation.steeringChain, SOURCE_CHAIN);
    assert.equal(projection.observation.cacheCreationTokens, 4);
    assert.equal(projection.observation.totalCostUsd, 0.0123);
    assert.deepEqual(projection.outcome, {
      status: "succeeded",
      failureCode: null,
    });

    for (const malformed of [
      usageRecord({ inputTokens: -1 }),
      usageRecord({ outputTokens: 1.5 }),
      usageRecord({ cacheReadTokens: Number.MAX_SAFE_INTEGER + 1 }),
      usageRecord({ cacheCreateTokens: Number.NaN }),
      usageRecord({ reasoningTokens: Number.POSITIVE_INFINITY }),
      usageRecord({ costUsd: -0.01 }),
      usageRecord({ costUsd: Number.NaN }),
    ]) {
      assert.equal(buildFlightUsageProjection({
        usageId: "usage-malformed",
        runId: "run-one",
        model: "gpt-test",
        record: malformed,
        steeringChain: SOURCE_CHAIN,
      }), undefined);
    }
  });

  test("native action maps status and exposes no instruction, editor, session, or path content", () => {
    const expected = {
      completed: { status: "succeeded", failureCode: null },
      cancelled: { status: "cancelled", failureCode: "cancelled" },
      failed: { status: "failed", failureCode: "providerFailure" },
    } as const;

    for (const status of ["completed", "cancelled", "failed"] as const) {
      const projection = buildFlightNativeActionProjection({
        receipt: nativeReceipt(status),
        receiptPersisted: true,
        actionKind: "prompt",
        attachmentCount: 2,
      });
      assert.deepEqual(projection.outcome, expected[status]);
      assert.equal(projection.subject.headCount, 2);
      assert.equal(projection.subject.attachmentCount, 2);
      assert.equal(projection.observation.status, "recorded");
      assert.match(projection.observation.receiptSha256, /^[0-9a-f]{64}$/);
      const serialized = JSON.stringify(projection);
      for (const canary of [
        "NATIVE-INSTRUCTION-CONTENT-CANARY",
        "EDITOR-PATH-CONTENT-CANARY",
        "PRIVATE-SESSION-CONTENT-CANARY",
        "PRIVATE-PATH-CONTENT-CANARY",
      ]) {
        assert.doesNotMatch(serialized, new RegExp(canary));
      }
    }

    const missingReceipt = buildFlightNativeActionProjection({
      receipt: nativeReceipt("completed"),
      receiptPersisted: false,
      actionKind: "command",
      attachmentCount: 0,
    });
    assert.deepEqual(missingReceipt.outcome, {
      status: "incomplete",
      failureCode: "recorderFailure",
    });
    assert.equal(missingReceipt.observation.status, "failed");
  });

  test("projects structured provider tool and edit metadata without content", () => {
    const operationId = "e".repeat(64);
    const projection = buildFlightProviderTelemetryProjection([
      {
        observationType: "providerToolStarted",
        provider: "codex",
        providerOperationIdSha256: operationId,
        toolCategory: "shell",
        argumentBytes: 42,
        evidenceClass: "providerObserved",
      },
      {
        observationType: "providerToolFinished",
        provider: "codex",
        providerOperationIdSha256: operationId,
        toolCategory: "shell",
        status: "succeeded",
        resultBytes: 84,
        evidenceClass: "providerObserved",
      },
      {
        observationType: "providerEditBatch",
        provider: "codex",
        createCount: 1,
        updateCount: 2,
        deleteCount: 0,
        pathCount: 3,
        evidenceClass: "providerObserved",
      },
    ], "b".repeat(64), "c".repeat(64));

    assert.equal(projection.childOperations.length, 2);
    assert.deepEqual(projection.childOperations[0], {
      subject: {
        kind: "toolCall",
        provider: "codex",
        toolName: "shell",
        providerOperationIdSha256: operationId,
        argumentBytes: 42,
        evidenceClass: "providerObserved",
      },
      observation: {
        kind: "toolCall",
        observationType: "toolCallResult",
        status: "succeeded",
        resultBytes: 84,
        evidenceClass: "providerObserved",
      },
      outcome: { status: "succeeded", failureCode: null },
    });
    assert.deepEqual(projection.childOperations[1], {
      subject: {
        kind: "editBatch",
        provider: "codex",
        createCount: 1,
        updateCount: 2,
        deleteCount: 0,
        pathCount: 3,
        workspaceBeforeSha256: "b".repeat(64),
        evidenceClass: "providerObserved",
      },
      observation: {
        kind: "editBatch",
        observationType: "workspaceMutation",
        createCount: 1,
        updateCount: 2,
        deleteCount: 0,
        pathCount: 3,
        workspaceAfterSha256: "c".repeat(64),
        evidenceClass: "providerObserved",
      },
      outcome: { status: "succeeded", failureCode: null },
    });
    assert.doesNotMatch(JSON.stringify(projection), /command|arguments|result body/i);
  });

  test("marks unmatched provider tools incomplete and refuses unbound edit hashes", () => {
    const operationId = "f".repeat(64);
    const projection = buildFlightProviderTelemetryProjection([
      {
        observationType: "providerToolStarted",
        provider: "claude",
        providerOperationIdSha256: operationId,
        toolCategory: "mcp",
        argumentBytes: 1,
        evidenceClass: "providerObserved",
      },
      {
        observationType: "providerEditBatch",
        provider: "claude",
        createCount: 0,
        updateCount: 1,
        deleteCount: 0,
        pathCount: 1,
        evidenceClass: "providerObserved",
      },
    ]);
    assert.equal(projection.childOperations.length, 1);
    assert.deepEqual(projection.childOperations[0]?.outcome, {
      status: "incomplete",
      failureCode: "unknown",
    });
    assert.deepEqual(projection.agentObservations, [{
      kind: "agentRun",
      observationType: "telemetryAvailability",
      detail: "unavailable",
      reason: "unsupported",
    }]);

    const finishOnly = buildFlightProviderTelemetryProjection([{
      observationType: "providerToolFinished",
      provider: "codex",
      providerOperationIdSha256: "a".repeat(64),
      toolCategory: "shell",
      status: "succeeded",
      resultBytes: 5,
      evidenceClass: "providerObserved",
    }]);
    assert.deepEqual(finishOnly.childOperations[0]?.outcome, {
      status: "incomplete",
      failureCode: "unknown",
    });
    assert.deepEqual(finishOnly.agentObservations, [{
      kind: "agentRun",
      observationType: "telemetryAvailability",
      detail: "unavailable",
      reason: "malformed",
    }]);
  });
});
