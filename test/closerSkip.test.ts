import assert from "node:assert/strict";
import test from "node:test";
import { shouldAutoSkipCloserOnAgreement } from "../src/closerSkip";

const META = {
  agent: "claude" as const,
  phase: "reactor" as const,
  sourceMessageTimestamp: "2026-05-18T10:00:00.000Z",
};

test("skips closer for clean reactor agreement", () => {
  const text = [
    "Agree: The opener's plan is sufficient.",
    "",
    "Recommendation: Keep the patch.",
    "Default next action: Hydra should wait for the user.",
    "Decision needed from user: none",
    "Blockers: none",
  ].join("\n");

  assert.equal(shouldAutoSkipCloserOnAgreement(text, META), true);
});

test("keeps closer when agreement has an open decision", () => {
  const text = [
    "Agree: The opener's plan is sufficient.",
    "",
    "Recommendation: Keep the patch.",
    "Default next action: Hydra should ask the user.",
    "Decision needed from user: choose the label",
    "Blockers: none",
  ].join("\n");

  assert.equal(shouldAutoSkipCloserOnAgreement(text, META), false);
});

test("keeps closer when reactor amends even without blockers", () => {
  const text = [
    "Amend: The opener missed one case.",
    "",
    "Recommendation: Patch the queued path.",
    "Default next action: Hydra should implement the fix.",
    "Decision needed from user: none",
    "Blockers: none",
  ].join("\n");

  assert.equal(shouldAutoSkipCloserOnAgreement(text, META), false);
});
