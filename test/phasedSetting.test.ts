import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  applyPhasedSettingChange,
  describePhasedSettingCurrent,
  effectivePhasedNumberSetting,
  phasedSettingForScope,
  summarizePhasedSetting,
} from "../src/phasedSetting";

describe("phasedSettingForScope", () => {
  test("string value applies to 'all' scope only", () => {
    assert.equal(phasedSettingForScope("sonnet", "all"), "sonnet");
    assert.equal(phasedSettingForScope("sonnet", "discussion"), "");
    assert.equal(phasedSettingForScope("sonnet", "build"), "");
  });

  test("object value applies per-phase, not to 'all'", () => {
    const raw = { discussion: "sonnet", build: "opus" };
    assert.equal(phasedSettingForScope(raw, "discussion"), "sonnet");
    assert.equal(phasedSettingForScope(raw, "build"), "opus");
    assert.equal(phasedSettingForScope(raw, "review"), "");
    assert.equal(phasedSettingForScope(raw, "all"), "");
  });

  test("trims whitespace", () => {
    assert.equal(phasedSettingForScope("  sonnet  ", "all"), "sonnet");
    assert.equal(phasedSettingForScope({ build: "  opus  " }, "build"), "opus");
  });

  test("returns '' for missing/wrong-type values", () => {
    assert.equal(phasedSettingForScope(undefined, "all"), "");
    assert.equal(phasedSettingForScope(null, "build"), "");
    assert.equal(phasedSettingForScope(42, "all"), "");
    assert.equal(phasedSettingForScope({ build: 42 }, "build"), "");
  });
});

describe("applyPhasedSettingChange", () => {
  test("all-scope collapses to a single string", () => {
    assert.equal(applyPhasedSettingChange("anything", "all", "opus"), "opus");
    assert.equal(applyPhasedSettingChange({ build: "x" }, "all", "opus"), "opus");
    assert.equal(applyPhasedSettingChange("", "all", ""), "");
  });

  test("per-phase change broadcasts a previous string to all phases first", () => {
    // Previous "sonnet" applied to all phases; now change only build to opus.
    // Discussion and review should keep "sonnet".
    assert.deepEqual(
      applyPhasedSettingChange("sonnet", "build", "opus"),
      { discussion: "sonnet", build: "opus", review: "sonnet" },
    );
  });

  test("per-phase change preserves existing object phases", () => {
    assert.deepEqual(
      applyPhasedSettingChange({ discussion: "sonnet", review: "opus" }, "build", "haiku"),
      { discussion: "sonnet", review: "opus", build: "haiku" },
    );
  });

  test("empty value clears that scope", () => {
    assert.deepEqual(
      applyPhasedSettingChange({ discussion: "sonnet", build: "opus" }, "build", ""),
      { discussion: "sonnet" },
    );
  });

  test("clearing the last phase collapses to ''", () => {
    assert.equal(
      applyPhasedSettingChange({ discussion: "sonnet" }, "discussion", ""),
      "",
    );
  });
});

describe("effectivePhasedNumberSetting", () => {
  test("single number applies to every phase", () => {
    assert.equal(effectivePhasedNumberSetting(120000, "discussion", 80000), 120000);
    assert.equal(effectivePhasedNumberSetting(120000, "build", 400000), 120000);
  });

  test("object value applies per phase and falls back for missing phases", () => {
    const raw = { discussion: 80000, review: 400000 };
    assert.equal(effectivePhasedNumberSetting(raw, "discussion", 1), 80000);
    assert.equal(effectivePhasedNumberSetting(raw, "build", 400000), 400000);
    assert.equal(effectivePhasedNumberSetting(raw, "review", 1), 400000);
  });

  test("invalid values fall back", () => {
    assert.equal(effectivePhasedNumberSetting({ discussion: "nope" }, "discussion", 80000), 80000);
    assert.equal(effectivePhasedNumberSetting(null, "review", 400000), 400000);
  });
});

describe("summarizePhasedSetting", () => {
  test("empty -> fallback", () => {
    assert.equal(summarizePhasedSetting(undefined), "");
    assert.equal(summarizePhasedSetting(undefined, { fallback: "default" }), "default");
    assert.equal(summarizePhasedSetting("", { fallback: "default" }), "default");
    assert.equal(summarizePhasedSetting({}, { fallback: "default" }), "default");
  });

  test("single string -> that value", () => {
    assert.equal(summarizePhasedSetting("sonnet"), "sonnet");
    assert.equal(summarizePhasedSetting("  sonnet  "), "sonnet");
  });

  test("object with all phases equal -> that value", () => {
    assert.equal(
      summarizePhasedSetting({ discussion: "sonnet", build: "sonnet", review: "sonnet" }),
      "sonnet",
    );
  });

  test("object with mixed phases -> 'd=…/b=…/r=…' with chosen separator", () => {
    assert.equal(
      summarizePhasedSetting({ discussion: "high", build: "low" }),
      "d=high/b=low",
    );
    assert.equal(
      summarizePhasedSetting({ discussion: "high", build: "low" }, { separator: " · " }),
      "d=high · b=low",
    );
  });
});

describe("describePhasedSettingCurrent", () => {
  test("empty -> 'currently: <default>'", () => {
    assert.equal(describePhasedSettingCurrent(undefined), "currently: CLI default");
    assert.equal(describePhasedSettingCurrent("", "nothing set"), "currently: nothing set");
  });

  test("single string -> 'currently: X'", () => {
    assert.equal(describePhasedSettingCurrent("sonnet"), "currently: sonnet");
  });

  test("per-phase object -> 'currently: d=…, b=…, r=…'", () => {
    assert.equal(
      describePhasedSettingCurrent({ discussion: "high", build: "low" }),
      "currently: d=high, b=low",
    );
  });
});
