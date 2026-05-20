import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { detectNativeReplyLeak, formatNativeReplyLeakError } from "../src/nativeReplyGuard";

describe("native reply guard", () => {
  test("detects leaked Hydra prompt envelope tails", () => {
    const leak = detectNativeReplyLeak([
      "launches sandboxed reactor (no I/O).",
      "",
      "--- End Hydra prompt ---",
      "",
      "After your reply, exit so the wrapper can capture the transcript.",
    ].join("\n"));
    assert.equal(leak?.marker, "--- End Hydra prompt ---");
    assert.match(formatNativeReplyLeakError(leak!), /prompt-envelope text/);
  });

  test("detects leaked wrapper exit instruction without the section marker", () => {
    const leak = detectNativeReplyLeak("After your reply, exit so the wrapper can capture the transcript.");
    assert.equal(leak?.marker, "After your reply, exit so the wrapper can capture the transcript.");
  });

  test("allows quoted native CLI profile prompt sections", () => {
    const leak = detectNativeReplyLeak([
      "I found the relevant files.",
      "",
      "--- Codex native CLI profile ---",
      "Hydra invokes your real native CLI with this phase's configured authority.",
      "- Codex CLI via hydraRoom.codexExecArgs* for this phase; Hydra passes raw native args through.",
    ].join("\n"));
    assert.equal(leak, undefined);
  });

  test("detects leaked decision packet template placeholders", () => {
    const leak = detectNativeReplyLeak("Recommendation: <one concrete recommendation>\nDefault next action: <what Hydra should do next if the user does not redirect>");
    assert.equal(leak?.marker, "Recommendation: <one concrete recommendation>");
  });

  test("allows normal assistant replies", () => {
    assert.equal(detectNativeReplyLeak("Recommendation: keep the item in backlog.\nBlockers: none"), undefined);
  });

  test("allows mid-body marker quotes when substantive content follows", () => {
    // Why: a reply that quotes a leak marker (e.g., a security audit referencing
    // the prompt envelope) must not be rejected. Only tail-position leaks count.
    const tail = "Recommendation: tighten the marker set\nDefault next action: land the patch\nDecision needed from user: none\nBlockers: none";
    const padding = "x".repeat(600);
    const body = [
      "I reviewed the guard. It catches strings like:",
      "--- End Hydra prompt ---",
      "and",
      "After your reply, exit so the wrapper can capture the transcript.",
      "However these can appear in legitimate replies.",
      padding,
      tail,
    ].join("\n");
    assert.equal(detectNativeReplyLeak(body), undefined);
  });
});
