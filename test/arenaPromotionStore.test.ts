import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, type TestContext } from "node:test";
import { strict as assert } from "node:assert";
import {
  loadArenaPromotionReceipts,
  persistArenaPromotionIntent,
  persistArenaPromotionResult,
} from "../src/arenaPromotionStore";
import {
  createArenaPromotionConfirmation,
  createArenaPromotionPreview,
  executeArenaPromotion,
  type ArenaPromotionIntentReceipt,
  type ArenaPromotionResultReceipt,
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

async function fixture(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-promotion-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function workspace(content = digest("base")): ArenaPromotionWorkspaceSnapshot {
  return {
    head: { objectFormat: "sha1", oid: "a".repeat(40) },
    sourceWorkspaceFingerprintSha256: digest("source"),
    contentFingerprintSha256: content,
    repositoryControlSha256: digest("registry"),
    arenaWorktreesAbsent: true,
    workspaceClean: content === digest("base"),
  };
}

async function receipts(): Promise<{
  readonly intent: ArenaPromotionIntentReceipt;
  readonly result: ArenaPromotionResultReceipt;
}> {
  const replay = arenaProductReplayFixture();
  const reveal = createArenaReveal(replay);
  const selection = createArenaWinnerSelection({
    reveal,
    contestantId: "contestant-codex",
    selectionId: "selection-one",
    occurredAt: ARENA_FIXTURE_TIME,
  });
  const preview = createArenaPromotionPreview({
    replay,
    reveal,
    selection,
    promotionId: "promotion-one",
    occurredAt: ARENA_FIXTURE_TIME,
    missionDecision: "keepActive",
    workspace: workspace(),
    patchCheck: { applicable: true, conflictPaths: [], untrackedConflictPaths: [] },
  });
  const confirmation = createArenaPromotionConfirmation({
    preview,
    confirmationId: "confirmation-one",
    occurredAt: ARENA_FIXTURE_TIME,
  });
  let capturedIntent: ArenaPromotionIntentReceipt | undefined;
  let inspections = 0;
  const result = await executeArenaPromotion({
    preview,
    confirmation,
    loadReplay: async () => replay,
    verifyArtifactSet: async () => undefined,
    inspectWorkspace: async () => {
      inspections += 1;
      return inspections < 3
        ? workspace()
        : workspace(digest("contestant-codex-workspace"));
    },
    checkPatch: async () => ({
      applicable: true,
      conflictPaths: [],
      untrackedConflictPaths: [],
    }),
    persistIntent: async (intent) => {
      capturedIntent = intent;
    },
    applyCandidate: async () => undefined,
    persistResult: async () => undefined,
    now: () => new Date(ARENA_FIXTURE_TIME),
  });
  return { intent: capturedIntent!, result };
}

describe("Arena promotion receipt storage", () => {
  test("retains an immutable intent/result pair and exact retries", async (t) => {
    const root = await fixture(t);
    const value = await receipts();

    await persistArenaPromotionIntent(root, value.intent);
    await persistArenaPromotionIntent(root, value.intent);
    await persistArenaPromotionResult(root, value.result);
    await persistArenaPromotionResult(root, value.result);
    const loaded = await loadArenaPromotionReceipts(root, "run-one");

    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0], {
      promotionId: "promotion-one",
      state: "succeeded",
      intent: value.intent,
      result: value.result,
    });
  });

  test("refuses a result without its exact durable intent", async (t) => {
    const root = await fixture(t);
    const value = await receipts();

    await assert.rejects(
      persistArenaPromotionResult(root, value.result),
      /requires its exact durable intent/u,
    );
  });

  test("surfaces intent-only crash recovery state", async (t) => {
    const root = await fixture(t);
    const value = await receipts();
    await persistArenaPromotionIntent(root, value.intent);

    const loaded = await loadArenaPromotionReceipts(root, "run-one");
    assert.equal(loaded[0]?.state, "interrupted");
    assert.equal(loaded[0]?.result, null);
  });
});
