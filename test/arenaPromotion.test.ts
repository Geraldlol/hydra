import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  createArenaPromotionConfirmation,
  createArenaPromotionPreview,
  executeArenaPromotion,
  type ArenaPromotionWorkspaceSnapshot,
} from "../src/arenaPromotion";
import {
  createArenaReveal,
  createArenaWinnerSelection,
} from "../src/arenaProduct";
import {
  ARENA_FIXTURE_TIME,
  arenaFixtureDigest as digest,
  arenaProductReplayFixture,
} from "./arenaProductFixture";

function sourceSnapshot(
  overrides: Partial<ArenaPromotionWorkspaceSnapshot> = {},
): ArenaPromotionWorkspaceSnapshot {
  return {
    head: { objectFormat: "sha1", oid: "a".repeat(40) },
    sourceWorkspaceFingerprintSha256: digest("source"),
    contentFingerprintSha256: digest("base"),
    repositoryControlSha256: digest("registry"),
    arenaWorktreesAbsent: true,
    workspaceClean: true,
    ...overrides,
  };
}

function productFixture() {
  const replay = arenaProductReplayFixture();
  const reveal = createArenaReveal(replay);
  const selection = createArenaWinnerSelection({
    reveal,
    contestantId: "contestant-codex",
    selectionId: "selection-one",
    occurredAt: ARENA_FIXTURE_TIME,
  });
  return { replay, reveal, selection };
}

describe("Arena promotion", () => {
  test("builds an eligible preview only from comparable immutable evidence and exact source controls", () => {
    const { replay, reveal, selection } = productFixture();
    const preview = createArenaPromotionPreview({
      replay,
      reveal,
      selection,
      promotionId: "promotion-one",
      occurredAt: ARENA_FIXTURE_TIME,
      missionDecision: "keepActive",
      workspace: sourceSnapshot(),
      patchCheck: {
        applicable: true,
        conflictPaths: [],
        untrackedConflictPaths: [],
      },
    });

    assert.equal(preview.eligible, true);
    assert.deepEqual(preview.blockingReasons, []);
    assert.equal(preview.patchSha256, digest("contestant-codex-patch"));
    assert.equal(preview.expectedFinalContentSha256, digest("contestant-codex-workspace"));
    assert.match(preview.previewSha256, /^[a-f0-9]{64}$/u);
  });

  test("keeps compromised, stale, conflicting, or uncleared-registry runs unpromotable", () => {
    const compromised = arenaProductReplayFixture("compromised");
    const reveal = createArenaReveal(compromised);
    const selection = createArenaWinnerSelection({
      reveal,
      contestantId: "contestant-codex",
      selectionId: "selection-compromised",
      occurredAt: ARENA_FIXTURE_TIME,
    });
    const preview = createArenaPromotionPreview({
      replay: compromised,
      reveal,
      selection,
      promotionId: "promotion-blocked",
      occurredAt: ARENA_FIXTURE_TIME,
      missionDecision: "keepActive",
      workspace: sourceSnapshot({
        sourceWorkspaceFingerprintSha256: digest("changed"),
        arenaWorktreesAbsent: false,
      }),
      patchCheck: {
        applicable: false,
        conflictPaths: ["src/conflict.ts"],
        untrackedConflictPaths: [],
      },
    });

    assert.equal(preview.eligible, false);
    assert.deepEqual(preview.blockingReasons, [
      "comparisonNotEligible",
      "sourceWorkspaceChanged",
      "arenaRegistryNotClear",
      "patchConflict",
    ]);
    assert.throws(
      () => createArenaPromotionConfirmation({
        preview,
        confirmationId: "confirm-blocked",
        occurredAt: ARENA_FIXTURE_TIME,
      }),
      /not eligible/u,
    );
  });

  test("requires a separate exact local confirmation", () => {
    const { replay, reveal, selection } = productFixture();
    const preview = createArenaPromotionPreview({
      replay,
      reveal,
      selection,
      promotionId: "promotion-one",
      occurredAt: ARENA_FIXTURE_TIME,
      missionDecision: "retireAfterVerifiedPromotion",
      workspace: sourceSnapshot(),
      patchCheck: { applicable: true, conflictPaths: [], untrackedConflictPaths: [] },
    });
    const confirmation = createArenaPromotionConfirmation({
      preview,
      confirmationId: "confirm-promotion",
      occurredAt: "2026-08-24T12:01:00.000Z",
    });

    assert.equal(confirmation.actorId, "local-user");
    assert.equal(confirmation.action, "Promote Arena Winner");
    assert.equal(confirmation.previewSha256, preview.previewSha256);
    assert.match(confirmation.confirmationSha256, /^[a-f0-9]{64}$/u);
  });

  test("rechecks evidence and workspace, records intent before mutation, and verifies exact final content", async () => {
    const { replay, reveal, selection } = productFixture();
    const before = sourceSnapshot();
    const after = sourceSnapshot({
      workspaceClean: false,
      contentFingerprintSha256: digest("contestant-codex-workspace"),
    });
    const preview = createArenaPromotionPreview({
      replay,
      reveal,
      selection,
      promotionId: "promotion-one",
      occurredAt: ARENA_FIXTURE_TIME,
      missionDecision: "keepActive",
      workspace: before,
      patchCheck: { applicable: true, conflictPaths: [], untrackedConflictPaths: [] },
    });
    const confirmation = createArenaPromotionConfirmation({
      preview,
      confirmationId: "confirm-promotion",
      occurredAt: "2026-08-24T12:01:00.000Z",
    });
    const calls: string[] = [];
    let inspections = 0;

    const result = await executeArenaPromotion({
      preview,
      confirmation,
      loadReplay: async () => {
        calls.push("load");
        return replay;
      },
      inspectWorkspace: async () => {
        inspections += 1;
        calls.push(`inspect-${inspections}`);
        return inspections < 3 ? before : after;
      },
      verifyArtifactSet: async () => {
        calls.push("verify-artifacts");
      },
      checkPatch: async () => {
        calls.push("check-patch");
        return { applicable: true, conflictPaths: [], untrackedConflictPaths: [] };
      },
      persistIntent: async () => {
        calls.push("persist-intent");
      },
      applyCandidate: async () => {
        calls.push("apply");
      },
      persistResult: async () => {
        calls.push("persist-result");
      },
      now: () => new Date("2026-08-24T12:02:00.000Z"),
    });

    assert.equal(result.outcome, "succeeded");
    assert.deepEqual(calls, [
      "load",
      "verify-artifacts",
      "inspect-1",
      "check-patch",
      "inspect-2",
      "persist-intent",
      "apply",
      "inspect-3",
      "persist-result",
    ]);
  });

  test("does not mutate when the source changes after confirmation", async () => {
    const { replay, reveal, selection } = productFixture();
    const preview = createArenaPromotionPreview({
      replay,
      reveal,
      selection,
      promotionId: "promotion-one",
      occurredAt: ARENA_FIXTURE_TIME,
      missionDecision: "keepActive",
      workspace: sourceSnapshot(),
      patchCheck: { applicable: true, conflictPaths: [], untrackedConflictPaths: [] },
    });
    const confirmation = createArenaPromotionConfirmation({
      preview,
      confirmationId: "confirm-promotion",
      occurredAt: "2026-08-24T12:01:00.000Z",
    });
    let applied = false;

    await assert.rejects(
      executeArenaPromotion({
        preview,
        confirmation,
        loadReplay: async () => replay,
        inspectWorkspace: async () => sourceSnapshot({
          contentFingerprintSha256: digest("concurrent-change"),
          workspaceClean: false,
        }),
        verifyArtifactSet: async () => undefined,
        checkPatch: async () => ({
          applicable: true,
          conflictPaths: [],
          untrackedConflictPaths: [],
        }),
        persistIntent: async () => undefined,
        applyCandidate: async () => {
          applied = true;
        },
        persistResult: async () => undefined,
      }),
      /changed after the promotion preview/u,
    );
    assert.equal(applied, false);
  });
});
