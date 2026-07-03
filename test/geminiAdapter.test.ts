import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { geminiAdapter } from "../src/geminiAdapter";
import { adapterForKind } from "../src/agentRegistry";
import { UNKNOWN_AGENT_PRICES } from "../src/usage";
import type { AgentDefinition, InvocationContext } from "../src/agentAdapter";

const geminiDef: AgentDefinition = { id: "gemini", displayName: "Gemini", kind: "gemini" };
const ctx = (over: Partial<InvocationContext> = {}): InvocationContext => ({
  phase: "build",
  workspaceRoot: "C:/repo",
  prompt: "do the thing",
  command: "gemini",
  rawArgs: ["-p", "-"],
  ...over,
});

describe("gemini adapter", () => {
  test("kind is gemini", () => {
    assert.equal(geminiAdapter.kind, "gemini");
  });

  test("is resolvable from the registry via adapterForKind", () => {
    assert.equal(adapterForKind("gemini"), geminiAdapter);
  });

  test("buildInvocation spawns the gemini command with the prompt on stdin", () => {
    const inv = geminiAdapter.buildInvocation(geminiDef, ctx());
    assert.equal(inv.transport, "spawn");
    if (inv.transport !== "spawn") return;
    assert.equal(inv.command, "gemini");
    assert.deepEqual(inv.args, ["-p", "-"]);
    assert.equal(inv.stdin, "do the thing");
  });

  test("model from the definition is injected as --model before the trailing stdin dash", () => {
    const inv = geminiAdapter.buildInvocation({ ...geminiDef, model: "gemini-2.5-pro" }, ctx());
    assert.equal(inv.transport, "spawn");
    if (inv.transport !== "spawn") return;
    const mi = inv.args.indexOf("--model");
    assert.ok(mi >= 0 && inv.args[mi + 1] === "gemini-2.5-pro");
    assert.equal(inv.args[inv.args.length - 1], "-", "--model must land before the stdin sentinel");
  });

  test("does not double-inject --model when rawArgs already declares one", () => {
    const inv = geminiAdapter.buildInvocation(
      { ...geminiDef, model: "gemini-2.5-pro" },
      ctx({ rawArgs: ["-p", "--model", "gemini-2.5-flash", "-"] }),
    );
    assert.equal(inv.transport, "spawn");
    if (inv.transport !== "spawn") return;
    assert.equal(inv.args.filter((a) => a === "--model").length, 1);
    assert.equal(inv.args[inv.args.indexOf("--model") + 1], "gemini-2.5-flash");
  });

  test("no model configured -> args pass through unchanged", () => {
    const inv = geminiAdapter.buildInvocation(geminiDef, ctx());
    assert.equal(inv.transport, "spawn");
    if (inv.transport !== "spawn") return;
    assert.ok(!inv.args.includes("--model"));
  });

  // parseReply/parseUsage: Gemini's real JSON output shape is UNVERIFIED (no `gemini`
  // CLI install available to run `gemini -p ... --output-format json` and confirm it).
  // These tests only pin the safe-default passthrough/undefined behavior, not any
  // guessed JSON schema -- see the `Why:` comments in src/geminiAdapter.ts.
  test("parseReply passes plain stdout through unchanged", () => {
    const text = geminiAdapter.parseReply({ stdout: "hello world", stderr: "", exitCode: 0, outputMode: "plain" });
    assert.equal(text, "hello world");
  });

  test("parseReply passes stdout through unchanged even when outputMode claims geminiJson", () => {
    // Deliberately not parsing JSON here -- see Why: comment on parseReply.
    const raw = JSON.stringify({ response: "hello world" });
    const text = geminiAdapter.parseReply({ stdout: raw, stderr: "", exitCode: 0, outputMode: "geminiJson" });
    assert.equal(text, raw);
  });

  test("parseUsage returns undefined regardless of input", () => {
    assert.equal(geminiAdapter.parseUsage({ stdout: "", stderr: "", exitCode: 0, outputMode: "plain" }), undefined);
    const raw = JSON.stringify({ usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40 } });
    assert.equal(geminiAdapter.parseUsage({ stdout: raw, stderr: "", exitCode: 0, outputMode: "geminiJson" }), undefined);
  });

  test("pricing falls back to the unknown-agent floor when no model/pricing is set", () => {
    assert.deepEqual(geminiAdapter.pricing(geminiDef), UNKNOWN_AGENT_PRICES);
  });

  test("pricing respects an explicit def.pricing override", () => {
    const pricing = { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.2, cacheCreatePerMTok: 2 };
    assert.deepEqual(geminiAdapter.pricing({ ...geminiDef, pricing }), pricing);
  });

  test("authority delegates to classifyAgentAuthority without throwing", () => {
    const result = geminiAdapter.authority(geminiDef, ctx());
    assert.equal(typeof result.level, "string");
    assert.equal(typeof result.label, "string");
  });
});
