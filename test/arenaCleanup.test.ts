import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  ARENA_CLEANUP_RETRY_DELAYS_MS,
  ARENA_CLEANUP_STEPS,
  ArenaCleanupValidationError,
  arenaCleanupRetryDelayMs,
  evaluateArenaCleanupStart,
  isArenaCleanupRetryableFailure,
  parseArenaCleanupStepPayload,
  replayArenaCleanupSteps,
  validateArenaCleanupSteps,
  type ArenaCleanupFailureCode,
  type ArenaCleanupOutcome,
  type ArenaCleanupStep,
  type ArenaCleanupStepPayload,
} from "../src/arenaCleanup";

function record(
  step: ArenaCleanupStep,
  attempt: number,
  outcome: ArenaCleanupOutcome,
  failureCode: ArenaCleanupFailureCode | null = null,
  retryDelayMs: number | null = null,
  overrides: Partial<ArenaCleanupStepPayload> = {},
): ArenaCleanupStepPayload {
  return {
    payloadType: "cleanupStepRecorded",
    cleanupId: "cleanup-one",
    contestantId: "contestant-codex",
    step,
    attempt,
    outcome,
    failureCode,
    retryDelayMs,
    ...overrides,
  };
}

describe("Arena cleanup protocol", () => {
  test("requires a valid finalized manifest, provisioned worktree, and durable evidence", () => {
    assert.deepEqual(evaluateArenaCleanupStart({
      manifestValid: true,
      runFinalized: true,
      worktreeProvisioned: true,
      evidencePreserved: true,
    }), { allowed: true });
    assert.deepEqual(evaluateArenaCleanupStart({
      manifestValid: false,
      runFinalized: true,
      worktreeProvisioned: true,
      evidencePreserved: true,
    }), { allowed: false, reason: "invalidManifest" });
    assert.deepEqual(evaluateArenaCleanupStart({
      manifestValid: true,
      runFinalized: false,
      worktreeProvisioned: true,
      evidencePreserved: true,
    }), { allowed: false, reason: "runNotFinalized" });
    assert.deepEqual(evaluateArenaCleanupStart({
      manifestValid: true,
      runFinalized: true,
      worktreeProvisioned: false,
      evidencePreserved: true,
    }), { allowed: false, reason: "worktreeNotProvisioned" });
    assert.deepEqual(evaluateArenaCleanupStart({
      manifestValid: true,
      runFinalized: true,
      worktreeProvisioned: true,
      evidencePreserved: false,
    }), { allowed: false, reason: "evidenceNotPreserved" });
  });

  test("pins the bounded retry schedule and transient allowlist", () => {
    assert.deepEqual(ARENA_CLEANUP_RETRY_DELAYS_MS, [50, 100, 250, 500, 1_000, 2_000]);
    ARENA_CLEANUP_RETRY_DELAYS_MS.forEach((delay, index) => {
      assert.equal(arenaCleanupRetryDelayMs(index + 1), delay);
    });
    assert.equal(arenaCleanupRetryDelayMs(0), null);
    assert.equal(arenaCleanupRetryDelayMs(7), null);
    assert.equal(isArenaCleanupRetryableFailure("processStillRunning"), true);
    assert.equal(isArenaCleanupRetryableFailure("sharingViolation"), true);
    assert.equal(isArenaCleanupRetryableFailure("pathBusy"), true);
    assert.equal(isArenaCleanupRetryableFailure("directoryNotEmpty"), true);
    assert.equal(isArenaCleanupRetryableFailure("unsafePath"), false);
    assert.equal(isArenaCleanupRetryableFailure("gitRejected"), false);
  });

  test("replays exact ordered cleanup with retry and crash-recovery no-op", () => {
    const records: ArenaCleanupStepPayload[] = [
      record("quiesceProcesses", 1, "retryableFailure", "processStillRunning", 50),
      record("quiesceProcesses", 2, "succeeded"),
      record("verifyTarget", 1, "succeeded"),
      record("unlockGitWorktree", 1, "notNeeded"),
      record("removeGitWorktree", 1, "retryableFailure", "sharingViolation", 50),
      record("removeGitWorktree", 2, "notNeeded"),
      record("verifyGitRegistrationGone", 1, "succeeded"),
      record("removeResidualDirectory", 1, "notNeeded"),
    ];
    const replay = replayArenaCleanupSteps("contestant-codex", records);
    assert.equal(replay.status, "complete");
    assert.equal(replay.cleanupId, "cleanup-one");
    assert.deepEqual(replay.completedSteps, ARENA_CLEANUP_STEPS);
    assert.equal(replay.nextStep, null);
    assert.equal(replay.nextAttempt, null);
    assert.equal(replay.blockedFailureCode, null);
    assert.ok(Object.isFrozen(replay));
  });

  test("reports the next exact step and attempt for crash recovery", () => {
    const replay = replayArenaCleanupSteps("contestant-codex", [
      record("quiesceProcesses", 1, "succeeded"),
      record("verifyTarget", 1, "retryableFailure", "pathBusy", 50),
    ]);
    assert.equal(replay.status, "active");
    assert.equal(replay.nextStep, "verifyTarget");
    assert.equal(replay.nextAttempt, 2);
    assert.deepEqual(replay.completedSteps, ["quiesceProcesses"]);
  });

  test("terminally blocks without advancing or accepting later records", () => {
    const blocked = [
      record("quiesceProcesses", 1, "succeeded"),
      record("verifyTarget", 1, "blocked", "symlinkDetected"),
    ];
    const replay = replayArenaCleanupSteps("contestant-codex", blocked);
    assert.equal(replay.status, "blocked");
    assert.equal(replay.blockedFailureCode, "symlinkDetected");
    assert.equal(replay.nextStep, null);
    assert.throws(
      () => replayArenaCleanupSteps("contestant-codex", [
        ...blocked,
        record("verifyTarget", 2, "succeeded"),
      ]),
      /after cleanup reached a terminal state/,
    );
  });

  test("exhausts transient retries on the seventh attempt without fallthrough", () => {
    const attempts = ARENA_CLEANUP_RETRY_DELAYS_MS.map((delay, index) =>
      record(
        "quiesceProcesses",
        index + 1,
        "retryableFailure",
        "processStillRunning",
        delay,
      ));
    attempts.push(record("quiesceProcesses", 7, "blocked", "retryExhausted"));
    const replay = replayArenaCleanupSteps("contestant-codex", attempts);
    assert.equal(replay.status, "blocked");
    assert.equal(replay.blockedFailureCode, "retryExhausted");

    assert.throws(
      () => parseArenaCleanupStepPayload(
        record("quiesceProcesses", 7, "retryableFailure", "pathBusy", 2_000),
      ),
      /retry schedule is exhausted/,
    );
    assert.throws(
      () => parseArenaCleanupStepPayload(
        record("quiesceProcesses", 6, "blocked", "retryExhausted"),
      ),
      /valid only on attempt 7/,
    );
    assert.doesNotThrow(() => parseArenaCleanupStepPayload(
      record("quiesceProcesses", 7, "blocked", "identityMismatch"),
    ));
  });

  test("rejects wrong order, gaps, cross-target records, and cleanup-id changes", () => {
    assert.throws(
      () => replayArenaCleanupSteps("contestant-codex", [
        record("verifyTarget", 1, "succeeded"),
      ]),
      /must be quiesceProcesses/,
    );
    assert.throws(
      () => replayArenaCleanupSteps("contestant-codex", [
        record("quiesceProcesses", 1, "retryableFailure", "pathBusy", 50),
        record("quiesceProcesses", 3, "succeeded"),
      ]),
      /must be 2/,
    );
    assert.throws(
      () => replayArenaCleanupSteps("contestant-codex", [
        record("quiesceProcesses", 1, "succeeded", null, null, {
          contestantId: "contestant-claude",
        }),
      ]),
      /crosses cleanup target identities/,
    );
    assert.throws(
      () => replayArenaCleanupSteps("contestant-codex", [
        record("quiesceProcesses", 1, "succeeded"),
        record("verifyTarget", 1, "succeeded", null, null, {
          cleanupId: "cleanup-two",
        }),
      ]),
      /crosses cleanup attempt identities/,
    );
  });

  test("rejects unknown fields, invalid metadata combinations, and non-transient retries", () => {
    assert.throws(
      () => parseArenaCleanupStepPayload({
        ...record("quiesceProcesses", 1, "succeeded"),
        surprise: true,
      }),
      /unknown surprise/,
    );
    assert.throws(
      () => parseArenaCleanupStepPayload(
        record("quiesceProcesses", 1, "succeeded", "pathBusy"),
      ),
      /must not carry failure/,
    );
    assert.throws(
      () => parseArenaCleanupStepPayload(
        record("verifyTarget", 1, "retryableFailure", "unsafePath", 50),
      ),
      /allowlisted transient/,
    );
    assert.throws(
      () => parseArenaCleanupStepPayload(
        record("quiesceProcesses", 1, "retryableFailure", "pathBusy", 100),
      ),
      /fixed 50 ms/,
    );
    assert.throws(
      () => parseArenaCleanupStepPayload(
        record("verifyTarget", 1, "blocked", null),
      ),
      /requires one failure code/,
    );
    assert.throws(
      () => parseArenaCleanupStepPayload(
        record("verifyTarget", 1, "blocked", "pathBusy"),
      ),
      /must follow the bounded retry schedule/,
    );
  });

  test("returns stable validation issues instead of accepting malformed history", () => {
    const issues = validateArenaCleanupSteps("contestant-codex", [
      record("quiesceProcesses", 1, "succeeded"),
      record("removeGitWorktree", 1, "succeeded"),
    ]);
    assert.equal(issues.length, 1);
    assert.match(issues[0]!, /must be verifyTarget/);
    assert.throws(
      () => replayArenaCleanupSteps("bad contestant", []),
      ArenaCleanupValidationError,
    );
  });
});
