import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  scanArenaRecovery,
  type ArenaRecoveryScanDependencies,
} from "../src/arenaRecoveryScan";
import type { ArenaPromotionReceiptState } from "../src/arenaPromotionStore";
import { arenaProductReplayFixture } from "./arenaProductFixture";

function dependencies(
  overrides: Partial<ArenaRecoveryScanDependencies> = {},
): ArenaRecoveryScanDependencies {
  return {
    openManifestStore: async () => ({
      listRunIds: async () => ["run-one"],
      load: async () => arenaProductReplayFixture("comparable", "running"),
    }),
    loadDispatchGenerations: async () => [],
    loadPromotionReceipts: async () => [],
    ...overrides,
  };
}

describe("Arena hard-death startup scan", () => {
  test("classifies a replayed quiescent run without taking action", async () => {
    const scan = await scanArenaRecovery("ignored", dependencies());
    assert.equal(scan.length, 1);
    assert.equal(scan[0]?.status, "classified");
    if (scan[0]?.status === "classified") {
      assert.equal(scan[0].recovery.classification, "resumeOrAbort");
      assert.equal(scan[0].recovery.takeoverEligible, true);
    }
  });

  test("turns corrupt supporting receipts into inspect-only state", async () => {
    const scan = await scanArenaRecovery("ignored", dependencies({
      loadDispatchGenerations: async () => {
        throw new Error("corrupt receipt");
      },
    }));
    assert.equal(scan[0]?.status, "classified");
    if (scan[0]?.status === "classified") {
      assert.equal(scan[0].recovery.classification, "receiptStateInvalid");
      assert.equal(scan[0].recovery.takeoverEligible, false);
      assert.deepEqual(scan[0].recovery.allowedActions, ["inspect"]);
      assert.match(scan[0].recovery.supportStateErrorSha256 ?? "", /^[a-f0-9]{64}$/u);
    }
  });

  test("surfaces interrupted promotion and invalid manifest separately", async () => {
    const interrupted = await scanArenaRecovery("ignored", dependencies({
      loadPromotionReceipts: async () => [{
        promotionId: "promotion-one",
        state: "interrupted",
      } as ArenaPromotionReceiptState],
    }));
    assert.equal(interrupted[0]?.status, "classified");
    if (interrupted[0]?.status === "classified") {
      assert.equal(interrupted[0].recovery.classification, "promotionInterrupted");
      assert.deepEqual(interrupted[0].recovery.allowedActions, ["inspectPromotion"]);
    }

    const invalid = await scanArenaRecovery("ignored", dependencies({
      openManifestStore: async () => ({
        listRunIds: async () => ["run-one"],
        load: async () => {
          throw new Error("torn manifest");
        },
      }),
    }));
    assert.equal(invalid[0]?.status, "manifestInvalid");
    if (invalid[0]?.status === "manifestInvalid") {
      assert.match(invalid[0].errorSha256, /^[a-f0-9]{64}$/u);
    }
  });
});
