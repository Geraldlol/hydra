import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { shouldClearLegacyAgentTimeout } from "../src/roomSettings";

describe("room settings", () => {
  test("clears tiny agent timeout values", () => {
    assert.equal(shouldClearLegacyAgentTimeout(1000), true);
    assert.equal(shouldClearLegacyAgentTimeout(1), true);
  });

  test("preserves deliberate positive timeout values above the tiny cap", () => {
    assert.equal(shouldClearLegacyAgentTimeout(0), false);
    assert.equal(shouldClearLegacyAgentTimeout(1001), false);
    assert.equal(shouldClearLegacyAgentTimeout(45_000), false);
    assert.equal(shouldClearLegacyAgentTimeout(120_000), false);
    assert.equal(shouldClearLegacyAgentTimeout(600_000), false);
    assert.equal(shouldClearLegacyAgentTimeout(undefined), false);
  });
});
