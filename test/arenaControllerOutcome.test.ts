import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyArenaControllerStatuses } from "../src/arenaController";

test("Arena controller terminal classification preserves causal failures", () => {
  assert.deepEqual(
    classifyArenaControllerStatuses(["succeeded", "succeeded"], true),
    { outcome: "completed", reasonCode: null },
    "a late Stop cannot rewrite already-complete contestants",
  );
  assert.deepEqual(
    classifyArenaControllerStatuses(["cancelled", "succeeded"], true),
    { outcome: "cancelled", reasonCode: "userCancelled" },
  );
  assert.deepEqual(
    classifyArenaControllerStatuses(["failed", "cancelled"], true),
    { outcome: "failed", reasonCode: "contestantFailed" },
    "a late Stop cannot hide an independent provider failure",
  );
  assert.deepEqual(
    classifyArenaControllerStatuses(["timedOut", "cancelled"], true),
    { outcome: "failed", reasonCode: "contestantFailed" },
    "a late Stop cannot hide an independent timeout",
  );
  assert.deepEqual(
    classifyArenaControllerStatuses(["cancelled", "succeeded"], false),
    { outcome: "failed", reasonCode: "contestantFailed" },
    "internal fail-fast cancellation is not local-user authority",
  );
  assert.throws(
    () => classifyArenaControllerStatuses([], true),
    /empty result set/u,
  );
});
