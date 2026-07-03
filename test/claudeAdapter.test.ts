import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { claudeAdapter } from "../src/claudeAdapter";
import type { AgentDefinition, InvocationContext } from "../src/agentAdapter";

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
});
