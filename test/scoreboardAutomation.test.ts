import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
  scoreboardEventsForVerifiedBuild,
  type VerifiedBuildScoreInput,
} from "../src/scoreboardAutomation";
import { validateScoreboardEvents } from "../src/scoreboard";
import type { VerificationResult } from "../src/verification";
import { verificationScoringPlanSha256 } from "../src/verification";

const FINGERPRINT = "a".repeat(64);
const CONTROL_FINGERPRINT = "c".repeat(64);

function verification(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    timestamp: "2026-07-16T12:00:00.000Z",
    command: "pnpm run verify:fast",
    cwd: "C:\\workspace",
    exitCode: 0,
    timedOut: false,
    durationMs: 1_234,
    stdout: "all tests passed",
    stderr: "",
    headSha: "1".repeat(40),
    ...overrides,
  };
}

function input(overrides: Partial<VerifiedBuildScoreInput> = {}): VerifiedBuildScoreInput {
  return {
    agentId: "codex",
    verification: verification(),
    postBuild: {
      fingerprintSha256: FINGERPRINT,
      didChange: true,
    },
    verifier: {
      resolutionKind: "inferred",
      planSha256: verificationScoringPlanSha256("inferred", "pnpm run verify:fast"),
      controlSha256: CONTROL_FINGERPRINT,
      controlsUnchanged: true,
    },
    ...overrides,
  };
}

function receiptHash(result: VerificationResult): string {
  return createHash("sha256").update(JSON.stringify([
    "hydra-verification-receipt-sha256-v1",
    result.timestamp,
    result.command,
    result.cwd,
    result.exitCode,
    result.timedOut,
    result.durationMs,
    result.stdout,
    result.stderr,
    result.terminationFailed ?? false,
    result.headSha ?? null,
  ]), "utf8").digest("hex");
}

describe("automatic verified-build scoring", () => {
  test("emits a valid deterministic claim and verdict bound to both receipts", () => {
    const request = input();
    const first = scoreboardEventsForVerifiedBuild(request);
    const retry = scoreboardEventsForVerifiedBuild(request);

    assert.deepEqual(retry, first);
    assert.equal(first.length, 2);
    const [claim, verdict] = first;
    assert.equal(claim.type, "claimRegistered");
    assert.equal(claim.agentId, "codex");
    assert.equal(claim.domain, "build-verification");
    assert.equal(claim.confidence, null);
    assert.match(claim.statement, /^Post-build Git-visible workspace state /);
    assert.doesNotMatch(claim.statement, /globally correct|overall correct/i);

    assert.equal(verdict.type, "verdictRecorded");
    assert.equal(verdict.claimId, claim.claimId);
    assert.equal(verdict.outcome, "correct");
    assert.equal(verdict.source, "deterministic");
    assert.equal(verdict.adjudicatorId, "hydra-verification");
    assert.equal(
      verdict.evidenceRef,
      `verification-sha256:${receiptHash(request.verification)};post-build-workspace-sha256:${FINGERPRINT};verification-plan-sha256:${request.verifier.planSha256};verification-controls-sha256:${CONTROL_FINGERPRINT}`,
    );
    assert.match(verdict.rationale, /command plan frozen before dispatch, and an unchanged bounded verifier-control inventory/i);
    assert.match(verdict.rationale, /only that the recorded state passed that command, not authorship of every change or global correctness/i);
    assert.deepEqual(validateScoreboardEvents(first), []);
  });

  test("keeps claims unique but correlates receipts under one verifier evidence regime", () => {
    const baseline = scoreboardEventsForVerifiedBuild(input());
    const changedVerification = scoreboardEventsForVerifiedBuild(input({
      verification: verification({ stdout: "different receipt output" }),
    }));
    const changedFingerprint = scoreboardEventsForVerifiedBuild(input({
      postBuild: { fingerprintSha256: "b".repeat(64), didChange: true },
    }));
    const changedControls = scoreboardEventsForVerifiedBuild(input({
      verifier: {
        ...input().verifier,
        controlSha256: "d".repeat(64),
      },
    }));
    const changedCommand = "pnpm run test";
    const changedPlan = scoreboardEventsForVerifiedBuild(input({
      verification: verification({ command: changedCommand }),
      verifier: {
        ...input().verifier,
        planSha256: verificationScoringPlanSha256("inferred", changedCommand),
      },
    }));
    const otherAgent = scoreboardEventsForVerifiedBuild(input({ agentId: "claude" }));

    assert.equal(baseline.length, 2);
    assert.equal(changedVerification.length, 2);
    assert.equal(changedFingerprint.length, 2);
    assert.equal(changedControls.length, 2);
    assert.equal(changedPlan.length, 2);
    assert.equal(otherAgent.length, 2);
    assert.notEqual(changedVerification[0].claimId, baseline[0].claimId);
    assert.notEqual(changedVerification[1].evidenceRef, baseline[1].evidenceRef);
    assert.notEqual(changedFingerprint[0].claimId, baseline[0].claimId);
    assert.notEqual(changedFingerprint[1].evidenceRef, baseline[1].evidenceRef);
    assert.notEqual(changedControls[0].claimId, baseline[0].claimId);
    assert.notEqual(changedControls[1].evidenceRef, baseline[1].evidenceRef);
    assert.notEqual(changedPlan[0].claimId, baseline[0].claimId);
    assert.notEqual(otherAgent[0].claimId, baseline[0].claimId);

    assert.equal(changedVerification[0].roundId, baseline[0].roundId);
    assert.equal(changedFingerprint[0].roundId, baseline[0].roundId);
    assert.equal(otherAgent[0].roundId, baseline[0].roundId);
    assert.notEqual(changedControls[0].roundId, baseline[0].roundId);
    assert.notEqual(changedPlan[0].roundId, baseline[0].roundId);
  });

  test("returns no events when the builder made no workspace change", () => {
    assert.deepEqual(scoreboardEventsForVerifiedBuild(input({
      postBuild: { fingerprintSha256: FINGERPRINT, didChange: false },
    })), []);
  });

  test("returns no events for every non-clean verification outcome", () => {
    for (const failed of [
      verification({ exitCode: 1 }),
      verification({ exitCode: null }),
      verification({ timedOut: true }),
      verification({ terminationFailed: true }),
    ]) {
      assert.deepEqual(scoreboardEventsForVerifiedBuild(input({ verification: failed })), []);
    }
  });

  test("returns no events when verifier controls changed or the plan does not bind the command", () => {
    assert.deepEqual(scoreboardEventsForVerifiedBuild(input({
      verifier: { ...input().verifier, controlsUnchanged: false },
    })), []);
    assert.deepEqual(scoreboardEventsForVerifiedBuild(input({
      verifier: { ...input().verifier, planSha256: "e".repeat(64) },
    })), []);
  });

  test("returns no events for malformed identities, fingerprints, or receipts", () => {
    const invalidInputs: VerifiedBuildScoreInput[] = [
      input({ agentId: "system" }),
      input({ postBuild: { fingerprintSha256: "not-a-sha256", didChange: true } }),
      input({ verifier: { ...input().verifier, controlSha256: "not-a-sha256" } }),
      input({ verification: verification({ timestamp: "not-a-date" }) }),
      input({ verification: verification({ durationMs: Number.NaN }) }),
      input({ verification: { ...verification(), stdout: undefined } as unknown as VerificationResult }),
    ];

    for (const invalid of invalidInputs) {
      assert.deepEqual(scoreboardEventsForVerifiedBuild(invalid), []);
    }
  });
});
