import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  arenaCleanupPostconditionSha256,
  arenaCleanupStepReceiptSha256,
  replayArenaCleanupSteps,
  type ArenaCleanupStepPayload,
} from "../src/arenaCleanup";

function payload(
  step: ArenaCleanupStepPayload["step"],
  attempt: number,
  outcome: ArenaCleanupStepPayload["outcome"],
  failureCode: ArenaCleanupStepPayload["failureCode"],
  retryDelayMs: number | null,
): ArenaCleanupStepPayload {
  const postcondition = outcome === "retryableFailure" || outcome === "blocked"
    ? {
        kind: "cleanupFailure" as const,
        failureCode: failureCode!,
        observedStateSha256: "a".repeat(64),
      }
    : {
        kind: "processQuiescence" as const,
        processOwnerSha256: "b".repeat(64),
        terminationConfirmed: true as const,
        activeProcessCount: 0 as const,
      };
  const body = {
    payloadType: "cleanupStepRecorded" as const,
    runId: "run",
    cleanupId: "cleanup",
    contestantId: "codex",
    registrationSha256: "c".repeat(64),
    evidenceEventSha256: "d".repeat(64),
    step,
    attempt,
    outcome,
    failureCode,
    retryDelayMs,
    postcondition,
    postconditionSha256: arenaCleanupPostconditionSha256(postcondition),
  };
  return {
    ...body,
    stepReceiptSha256: arenaCleanupStepReceiptSha256(body),
  };
}

describe("Arena cleanup replay schedule used by the runner", () => {
  test("re-enters the exact step after a transient failure", () => {
    const replay = replayArenaCleanupSteps("run", "codex", [
      payload(
        "quiesceProcesses",
        1,
        "retryableFailure",
        "processStillRunning",
        50,
      ),
    ]);
    assert.equal(replay.nextStep, "quiesceProcesses");
    assert.equal(replay.nextAttempt, 2);
  });

  test("advances only after a typed postcondition succeeds", () => {
    const replay = replayArenaCleanupSteps("run", "codex", [
      payload("quiesceProcesses", 1, "succeeded", null, null),
    ]);
    assert.equal(replay.nextStep, "verifyTarget");
    assert.equal(replay.nextAttempt, 1);
  });
});
