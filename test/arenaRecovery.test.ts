import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  classifyArenaRecovery,
  requireArenaRecoveryAction,
  type ArenaRecoveryProcessGeneration,
} from "../src/arenaRecovery";
import {
  arenaFixtureDigest as digest,
  arenaProductReplayFixture,
} from "./arenaProductFixture";

function generation(
  contestantId: string,
  state: ArenaRecoveryProcessGeneration["state"] = "quiescent",
): ArenaRecoveryProcessGeneration {
  return {
    contestantId,
    processGenerationId: `generation-${contestantId}`,
    processOwnerSha256: digest(`owner-${contestantId}`),
    intentSha256: digest(`intent-${contestantId}`),
    submissionReceiptSha256: state === "intentOnly"
      ? null
      : digest(`submission-${contestantId}`),
    quiescenceReceiptSha256: state === "quiescent"
      ? digest(`quiescence-${contestantId}`)
      : null,
    state,
  };
}

describe("Arena restart recovery", () => {
  test("needs no lifecycle action after exact cleanup", () => {
    const recovery = classifyArenaRecovery({
      replay: arenaProductReplayFixture("comparable", "cleanupComplete"),
      generations: [
        generation("contestant-codex"),
        generation("contestant-claude"),
      ],
      interruptedPromotionIds: [],
    });

    assert.equal(recovery.classification, "noAction");
    assert.deepEqual(recovery.allowedActions, []);
    assert.equal(recovery.takeoverEligible, false);
  });

  test("offers exact resume or abort only when every submitted generation is quiescent", () => {
    const recovery = classifyArenaRecovery({
      replay: arenaProductReplayFixture("comparable", "running"),
      generations: [
        generation("contestant-codex"),
        generation("contestant-claude"),
      ],
      interruptedPromotionIds: [],
    });

    assert.equal(recovery.classification, "resumeOrAbort");
    assert.equal(recovery.takeoverEligible, true);
    assert.deepEqual(recovery.allowedActions, ["resume", "abort"]);
    const proof = requireArenaRecoveryAction(
      recovery,
      recovery.recoveryStateSha256,
      "resume",
    );
    assert.equal(proof.action, "resume");
    assert.equal(proof.allSubmittedGenerationsQuiescent, true);
    assert.match(proof.recoveryProofSha256, /^[a-f0-9]{64}$/u);
  });

  test("never treats intent-only or unquiesced submission state as safe takeover", () => {
    const replay = arenaProductReplayFixture("comparable", "running");
    const intentOnly = classifyArenaRecovery({
      replay,
      generations: [
        generation("contestant-codex", "intentOnly"),
        generation("contestant-claude"),
      ],
      interruptedPromotionIds: [],
    });
    const submitted = classifyArenaRecovery({
      replay,
      generations: [
        generation("contestant-codex", "submitted"),
        generation("contestant-claude"),
      ],
      interruptedPromotionIds: [],
    });

    assert.equal(intentOnly.classification, "deliveryUnknown");
    assert.equal(intentOnly.takeoverEligible, false);
    assert.deepEqual(intentOnly.allowedActions, ["inspect"]);
    assert.equal(submitted.classification, "processQuiescenceUnconfirmed");
    assert.equal(submitted.takeoverEligible, false);
    assert.throws(
      () => requireArenaRecoveryAction(
        submitted,
        submitted.recoveryStateSha256,
        "abort",
      ),
      /not authorized/u,
    );
  });

  test("resumes only the next cleanup step after finalized hard death", () => {
    const recovery = classifyArenaRecovery({
      replay: arenaProductReplayFixture("comparable", "finalized"),
      generations: [
        generation("contestant-codex"),
        generation("contestant-claude"),
      ],
      interruptedPromotionIds: [],
    });

    assert.equal(recovery.classification, "resumeCleanup");
    assert.deepEqual(recovery.allowedActions, ["resumeCleanup"]);
    assert.deepEqual(recovery.nextCleanup, [
      { contestantId: "contestant-codex", step: "quiesceProcesses", attempt: 1 },
      { contestantId: "contestant-claude", step: "quiesceProcesses", attempt: 1 },
    ]);
  });

  test("surfaces interrupted promotion without auto-reapplying it", () => {
    const recovery = classifyArenaRecovery({
      replay: arenaProductReplayFixture("comparable", "cleanupComplete"),
      generations: [],
      interruptedPromotionIds: ["promotion-one"],
    });

    assert.equal(recovery.classification, "promotionInterrupted");
    assert.deepEqual(recovery.allowedActions, ["inspectPromotion"]);
    assert.equal(recovery.takeoverEligible, false);
  });

  test("rejects stale UI recovery choices", () => {
    const recovery = classifyArenaRecovery({
      replay: arenaProductReplayFixture("comparable", "running"),
      generations: [
        generation("contestant-codex"),
        generation("contestant-claude"),
      ],
      interruptedPromotionIds: [],
    });

    assert.throws(
      () => requireArenaRecoveryAction(recovery, digest("stale"), "resume"),
      /changed; refresh/u,
    );
  });
});
