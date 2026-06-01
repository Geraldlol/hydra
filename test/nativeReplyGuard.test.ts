import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { detectNativeReplyLeak, formatNativeReplyLeakError, PROMPT_ENVELOPE_MARKERS } from "../src/nativeReplyGuard";
import { buildPrompt } from "../src/prompts";

describe("native reply guard", () => {
  test("every prompt-envelope marker is a real substring of a built prompt (guards against drift)", () => {
    // Why: the markers must track prompts.ts. If a prompt template is reworded this fails
    // loudly so the marker set is updated rather than silently going dead (the old set had
    // two markers that no longer appeared in any prompt Hydra sends).
    const base = { agent: "codex", otherAgent: "claude", transcript: "" } as const;
    const corpus =
      buildPrompt({ ...base, phase: "opener" }) + "\n" + buildPrompt({ ...base, phase: "build" });
    for (const marker of PROMPT_ENVELOPE_MARKERS) {
      assert.ok(
        corpus.includes(marker),
        `prompt-envelope marker not found in any real prompt (drifted dead?): ${marker}`,
      );
    }
  });

  test("detects a leaked decision-packet template tail", () => {
    const leak = detectNativeReplyLeak(
      [
        "Recommendation: <one concrete recommendation>",
        "Default next action: <what Hydra should do next if the user does not redirect>",
        "Decision needed from user: <one narrow decision, or `none`>",
        "Blockers: <real blockers, or `none`>",
      ].join("\n"),
    );
    assert.equal(leak?.marker, "Recommendation: <one concrete recommendation>");
    assert.match(formatNativeReplyLeakError(leak!), /prompt-envelope text/);
  });

  test("detects a leaked build-prompt instruction tail", () => {
    const leak = detectNativeReplyLeak(
      "Here is the plan I would follow...\nEnd with a one-paragraph summary of what you changed.",
    );
    assert.equal(leak?.marker, "End with a one-paragraph summary of what you changed.");
  });

  test("allows quoted native CLI profile prompt sections", () => {
    const leak = detectNativeReplyLeak(
      [
        "I found the relevant files.",
        "",
        "--- Codex native CLI profile ---",
        "Hydra invokes your real native CLI with this phase's configured authority.",
        "- Codex CLI via hydraRoom.codexExecArgs* for this phase; Hydra passes raw native args through.",
      ].join("\n"),
    );
    assert.equal(leak, undefined);
  });

  test("allows normal assistant replies that fill in the packet", () => {
    assert.equal(
      detectNativeReplyLeak(
        "Recommendation: keep the item in backlog.\nDefault next action: ship the patch.\nDecision needed from user: none\nBlockers: none",
      ),
      undefined,
    );
  });

  test("allows mid-body marker quotes when substantive content follows", () => {
    // Why: a reply that quotes a leak marker (e.g. a security audit referencing the prompt
    // envelope) must not be rejected. Only tail-position leaks count.
    const tail =
      "Recommendation: keep the guard\nDefault next action: land the patch\nDecision needed from user: none\nBlockers: none";
    const padding = "x".repeat(600);
    const body = [
      "I reviewed the guard. It catches template tails like:",
      "Recommendation: <one concrete recommendation>",
      "However these can appear in legitimate replies.",
      padding,
      tail,
    ].join("\n");
    assert.equal(detectNativeReplyLeak(body), undefined);
  });
});
