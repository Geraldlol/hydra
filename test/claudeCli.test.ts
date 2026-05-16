import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  claudeInvocationMode,
  claudePrintArgs,
  claudeReadsHydraPromptFromStdin,
  claudeUsesPrintModeArgs,
} from "../src/claudeCli";

function spawn(args: string[]) {
  return { command: "claude", args, cwd: "C:\\repo" };
}

describe("claudeCli print-mode helpers", () => {
  test("detects short and long print flags", () => {
    assert.equal(claudeUsesPrintModeArgs(["-p"]), true);
    assert.equal(claudeUsesPrintModeArgs(["--print"]), true);
  });

  test("classifies non-print invocations as interactive", () => {
    assert.equal(claudeUsesPrintModeArgs(["doctor"]), false);
    assert.equal(claudeInvocationMode(spawn(["doctor"])), "interactive");
  });

  test("classifies print invocations", () => {
    assert.equal(claudeInvocationMode(spawn(["-p", "--add-dir", "C:\\repo"])), "print");
  });

  test("keeps the current default print args explicit", () => {
    assert.deepEqual(claudePrintArgs(), ["-p"]);
  });

  test("centralizes Claude stdin prompt support behind print mode", () => {
    assert.equal(claudeReadsHydraPromptFromStdin(["-p"]), true);
    assert.equal(claudeReadsHydraPromptFromStdin(["doctor"]), false);
  });
});
