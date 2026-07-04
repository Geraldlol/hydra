import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as vscode from "vscode";
import { claudeAdapter } from "../src/claudeAdapter";
import type { AgentDefinition, InvocationContext } from "../src/agentAdapter";

// agentArgs.ts's withModelArgs (which claudeAdapter.buildInvocation calls)
// reads vscode.workspace.getConfiguration("hydraRoom").get(...) at runtime;
// node:test substitutes a stub (scripts/setup-vscode-stub.js) exposing
// `currentConfig` so tests can simulate hydraRoom.claudeModel / an undeclared
// hydraRoom.<id>Model being set.
const currentConfig = (vscode as unknown as { currentConfig: Record<string, unknown> }).currentConfig;

const claudeDef: AgentDefinition = { id: "claude", displayName: "Claude", kind: "claude" };
const ctx = (over: Partial<InvocationContext> = {}): InvocationContext => ({
  phase: "build",
  workspaceRoot: "C:/repo",
  prompt: "do the thing",
  command: "claude",
  rawArgs: ["-p", "--permission-mode", "acceptEdits", "-"],
  ...over,
});

describe("claude adapter", () => {
  test("buildInvocation produces a spawn invocation reading stdin", () => {
    const inv = claudeAdapter.buildInvocation(claudeDef, ctx());
    assert.equal(inv.transport, "spawn");
    if (inv.transport !== "spawn") return;
    assert.equal(inv.command, "claude");
    assert.equal(inv.args[0], "-p");
    // Codex-only guard must never leak onto the Claude argv.
    assert.ok(!inv.args.includes("--skip-git-repo-check"));
    assert.equal(inv.args[inv.args.length - 1], "-");
    assert.equal(inv.stdin, "do the thing");
  });

  test("parseReply returns raw stdout", () => {
    assert.equal(claudeAdapter.parseReply({ stdout: "hello", stderr: "", exitCode: 0, outputMode: "plain" }), "hello");
  });

  test("parseUsage returns undefined for empty stdout", () => {
    const usage = claudeAdapter.parseUsage({ stdout: "", stderr: "", exitCode: 0, outputMode: "claudeStreamJson" });
    assert.equal(usage, undefined);
  });

  test("parseUsage reads the usage block off a stream-json result event", () => {
    const stdout = `${JSON.stringify({ type: "system", subtype: "init" })}\n${JSON.stringify({
      type: "result",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
    })}\n`;
    const usage = claudeAdapter.parseUsage({ stdout, stderr: "", exitCode: 0, outputMode: "claudeStreamJson" });
    assert.deepEqual(usage, {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreateTokens: 1,
      reasoningTokens: 0,
    });
  });

  test("kind is claude", () => {
    assert.equal(claudeAdapter.kind, "claude");
  });

  test("custom vendor-kind head (non-builtin id) reads model from def.model, ignoring an undeclared hydraRoom.<id>Model setting", () => {
    currentConfig.myclaudeModel = "should-be-ignored";
    try {
      const customDef: AgentDefinition = {
        id: "myclaude",
        displayName: "My Claude",
        kind: "claude",
        model: "custom-model-x",
        command: "claude",
      };
      const inv = claudeAdapter.buildInvocation(customDef, ctx());
      assert.equal(inv.transport, "spawn");
      if (inv.transport !== "spawn") return;
      assert.equal(inv.args.filter((a) => a === "--model").length, 1);
      assert.equal(inv.args[inv.args.indexOf("--model") + 1], "custom-model-x");
      assert.ok(!inv.args.includes("should-be-ignored"), "the undeclared per-id setting value must never appear in argv");
    } finally {
      delete currentConfig.myclaudeModel;
    }
  });

  test("builtin claude ignores def.model (no fallback) -- built-in model resolution stays exactly hydraRoom.claudeModel-driven", () => {
    delete currentConfig.claudeModel;
    const inv = claudeAdapter.buildInvocation({ ...claudeDef, model: "should-not-be-used" }, ctx());
    assert.equal(inv.transport, "spawn");
    if (inv.transport !== "spawn") return;
    assert.ok(!inv.args.includes("--model"));
  });

  test("builtin claude still reads hydraRoom.claudeModel (byte-identical)", () => {
    currentConfig.claudeModel = "opus";
    try {
      const inv = claudeAdapter.buildInvocation(claudeDef, ctx());
      assert.equal(inv.transport, "spawn");
      if (inv.transport !== "spawn") return;
      assert.equal(inv.args.filter((a) => a === "--model").length, 1);
      assert.equal(inv.args[inv.args.indexOf("--model") + 1], "opus");
    } finally {
      delete currentConfig.claudeModel;
    }
  });
});
