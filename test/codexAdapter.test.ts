import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { codexAdapter } from "../src/codexAdapter";
import type { AgentDefinition, InvocationContext } from "../src/agentAdapter";

const codexDef: AgentDefinition = { id: "codex", displayName: "Codex", kind: "codex" };
const ctx = (over: Partial<InvocationContext> = {}): InvocationContext => ({
  phase: "build",
  workspaceRoot: "C:/repo",
  prompt: "do the thing",
  command: "codex",
  rawArgs: ["exec", "--sandbox", "workspace-write", "-"],
  ...over,
});

describe("codex adapter", () => {
  test("buildInvocation produces a spawn invocation reading stdin", () => {
    const inv = codexAdapter.buildInvocation(codexDef, ctx());
    assert.equal(inv.transport, "spawn");
    if (inv.transport !== "spawn") return;
    assert.equal(inv.command, "codex");
    assert.equal(inv.args[0], "exec");
    // skip-git-repo-check is injected before the trailing stdin dash
    assert.ok(inv.args.includes("--skip-git-repo-check"));
    assert.equal(inv.args[inv.args.length - 1], "-");
    assert.equal(inv.stdin, "do the thing");
  });

  test("parseUsage reads codex token summary fields", () => {
    const usage = codexAdapter.parseUsage({
      stdout: "",
      stderr: "",
      exitCode: 0,
      outputMode: "codexJson",
      // parseUsage delegates to usageFromCodexSummary via a token block on stdout;
      // this asserts the plain-total path returns undefined for empty output.
    });
    assert.equal(usage, undefined);
  });

  test("kind is codex", () => {
    assert.equal(codexAdapter.kind, "codex");
  });
});
