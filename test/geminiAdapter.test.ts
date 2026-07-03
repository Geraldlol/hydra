import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as vscode from "vscode";
import { geminiAdapter } from "../src/geminiAdapter";
import { adapterForKind } from "../src/agentRegistry";
import { DEFAULT_PRICES_BY_KIND } from "../src/usage";
import type { AgentDefinition, InvocationContext } from "../src/agentAdapter";

// agentArgs.ts's withModelArgs (which geminiAdapter.buildInvocation now calls)
// reads vscode.workspace.getConfiguration("hydraRoom").get(...) at runtime;
// node:test substitutes a stub (scripts/setup-vscode-stub.js) exposing
// `currentConfig` so tests can simulate hydraRoom.geminiModel being set.
const currentConfig = (vscode as unknown as { currentConfig: Record<string, unknown> }).currentConfig;

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
    delete currentConfig.geminiModel; // guard against a leaked hydraRoom.geminiModel from another test
    const inv = geminiAdapter.buildInvocation({ ...geminiDef, model: "gemini-2.5-pro" }, ctx());
    assert.equal(inv.transport, "spawn");
    if (inv.transport !== "spawn") return;
    const mi = inv.args.indexOf("--model");
    assert.ok(mi >= 0 && inv.args[mi + 1] === "gemini-2.5-pro");
    assert.equal(inv.args[inv.args.length - 1], "-", "--model must land before the stdin sentinel");
  });

  test("does not double-inject --model when rawArgs already declares one", () => {
    delete currentConfig.geminiModel;
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
    delete currentConfig.geminiModel;
    const inv = geminiAdapter.buildInvocation(geminiDef, ctx());
    assert.equal(inv.transport, "spawn");
    if (inv.transport !== "spawn") return;
    assert.ok(!inv.args.includes("--model"));
  });

  test("hydraRoom.geminiModel setting is injected as --model when configured", () => {
    currentConfig.geminiModel = "gemini-2.5-pro";
    try {
      const inv = geminiAdapter.buildInvocation(geminiDef, ctx());
      assert.equal(inv.transport, "spawn");
      if (inv.transport !== "spawn") return;
      assert.equal(inv.args.filter((a) => a === "--model").length, 1);
      assert.equal(inv.args[inv.args.indexOf("--model") + 1], "gemini-2.5-pro");
    } finally {
      delete currentConfig.geminiModel;
    }
  });

  test("hydraRoom.geminiModel setting wins over def.model, without a duplicate --model", () => {
    currentConfig.geminiModel = "gemini-2.5-pro";
    try {
      const inv = geminiAdapter.buildInvocation({ ...geminiDef, model: "gemini-2.5-flash" }, ctx());
      assert.equal(inv.transport, "spawn");
      if (inv.transport !== "spawn") return;
      assert.equal(inv.args.filter((a) => a === "--model").length, 1);
      assert.equal(inv.args[inv.args.indexOf("--model") + 1], "gemini-2.5-pro");
    } finally {
      delete currentConfig.geminiModel;
    }
  });

  test("an explicit --model already in rawArgs still wins over hydraRoom.geminiModel", () => {
    currentConfig.geminiModel = "gemini-2.5-pro";
    try {
      const inv = geminiAdapter.buildInvocation(
        geminiDef,
        ctx({ rawArgs: ["-p", "--model", "gemini-2.5-flash", "-"] }),
      );
      assert.equal(inv.transport, "spawn");
      if (inv.transport !== "spawn") return;
      assert.equal(inv.args.filter((a) => a === "--model").length, 1);
      assert.equal(inv.args[inv.args.indexOf("--model") + 1], "gemini-2.5-flash");
    } finally {
      delete currentConfig.geminiModel;
    }
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

  test("pricing falls back to the gemini price row (not the codex floor) when no model/pricing is set", () => {
    assert.deepEqual(geminiAdapter.pricing(geminiDef), DEFAULT_PRICES_BY_KIND.gemini);
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
