import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as vscode from "vscode";
import {
  geminiAdapter,
  parseGeminiUsage,
  roomTextFromGeminiJson,
  shouldUseGeminiJson,
} from "../src/geminiAdapter";
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
  rawArgs: ["--output-format", "json"],
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
    assert.deepEqual(inv.args, ["--output-format", "json"]);
    assert.equal(inv.stdin, "do the thing");
  });

  test("model from the definition is injected as --model while the prompt stays on stdin", () => {
    delete currentConfig.geminiModel; // guard against a leaked hydraRoom.geminiModel from another test
    const inv = geminiAdapter.buildInvocation({ ...geminiDef, model: "gemini-2.5-pro" }, ctx());
    assert.equal(inv.transport, "spawn");
    if (inv.transport !== "spawn") return;
    const mi = inv.args.indexOf("--model");
    assert.ok(mi >= 0 && inv.args[mi + 1] === "gemini-2.5-pro");
    assert.deepEqual(inv.args.slice(-2), ["--model", "gemini-2.5-pro"]);
  });

  test("does not double-inject --model when rawArgs already declares one", () => {
    delete currentConfig.geminiModel;
    const inv = geminiAdapter.buildInvocation(
      { ...geminiDef, model: "gemini-2.5-pro" },
      ctx({ rawArgs: ["--output-format", "json", "--model", "gemini-2.5-flash"] }),
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
        ctx({ rawArgs: ["--output-format", "json", "--model", "gemini-2.5-flash"] }),
      );
      assert.equal(inv.transport, "spawn");
      if (inv.transport !== "spawn") return;
      assert.equal(inv.args.filter((a) => a === "--model").length, 1);
      assert.equal(inv.args[inv.args.indexOf("--model") + 1], "gemini-2.5-flash");
    } finally {
      delete currentConfig.geminiModel;
    }
  });

  test("parseReply passes plain stdout through unchanged", () => {
    const text = geminiAdapter.parseReply({ stdout: "hello world", stderr: "", exitCode: 0, outputMode: "plain" });
    assert.equal(text, "hello world");
  });

  test("parseReply extracts the documented JSON response", () => {
    const raw = JSON.stringify({ response: "hello world" });
    const text = geminiAdapter.parseReply({ stdout: raw, stderr: "", exitCode: 0, outputMode: "geminiJson" });
    assert.equal(text, "hello world");
  });

  test("parseReply preserves raw stdout for malformed or incompatible JSON", () => {
    assert.equal(roomTextFromGeminiJson("not json"), "not json");
    const missing = JSON.stringify({ error: { message: "failed" } });
    assert.equal(roomTextFromGeminiJson(missing), missing);
    assert.equal(roomTextFromGeminiJson(JSON.stringify({ response: 42 })), JSON.stringify({ response: 42 }));
  });

  test("parseUsage sums documented per-model metrics without double-counting", () => {
    assert.equal(geminiAdapter.parseUsage({ stdout: "", stderr: "", exitCode: 0, outputMode: "plain" }), undefined);
    const raw = JSON.stringify({
      response: "done",
      stats: {
        models: {
          "gemini-2.5-pro": {
            tokens: { input: 80, prompt: 100, candidates: 30, total: 147, cached: 20, thoughts: 15, tool: 2 },
          },
          "gemini-2.5-flash": {
            // Older Gemini CLI SessionMetrics omitted the derived `input`
            // field; Hydra accepts that exact shape and recomputes it.
            tokens: { prompt: 10, candidates: 4, total: 17, cached: 3, thoughts: 2, tool: 1 },
          },
        },
      },
    });
    assert.deepEqual(
      geminiAdapter.parseUsage({ stdout: raw, stderr: "", exitCode: 0, outputMode: "geminiJson" }),
      {
        inputTokens: 90,
        outputTokens: 51,
        cacheReadTokens: 23,
        cacheCreateTokens: 0,
        reasoningTokens: 17,
      },
    );
  });

  test("parseUsage rejects malformed, negative, inconsistent, empty, and overflowing metrics", () => {
    const envelope = (tokens: Record<string, unknown>): string => JSON.stringify({
      stats: { models: { model: { tokens } } },
    });
    const valid = { input: 8, prompt: 10, candidates: 3, total: 14, cached: 2, thoughts: 1, tool: 0 };
    assert.equal(parseGeminiUsage("not json"), undefined);
    assert.equal(parseGeminiUsage(JSON.stringify({ stats: { models: {} } })), undefined);
    assert.equal(parseGeminiUsage(envelope({ ...valid, input: -1 })), undefined);
    assert.equal(parseGeminiUsage(envelope({ ...valid, input: 9 })), undefined);
    assert.equal(parseGeminiUsage(envelope({ ...valid, total: 15 })), undefined);
    assert.equal(parseGeminiUsage(envelope({ ...valid, cached: 11 })), undefined);
    assert.equal(parseGeminiUsage(envelope({ ...valid, candidates: Number.MAX_SAFE_INTEGER + 1 })), undefined);
    assert.equal(parseGeminiUsage(envelope({ ...valid, thoughts: "1" })), undefined);
  });

  test("parseUsage ignores JSON envelopes unless geminiJson was explicitly requested", () => {
    const raw = JSON.stringify({
      stats: {
        models: {
          model: {
            tokens: { prompt: 10, candidates: 3, total: 14, cached: 2, thoughts: 1, tool: 0 },
          },
        },
      },
    });
    assert.equal(
      geminiAdapter.parseUsage({ stdout: raw, stderr: "", exitCode: 0, outputMode: "plain" }),
      undefined,
    );
  });

  test("detects the effective documented Gemini JSON output flag", () => {
    assert.equal(shouldUseGeminiJson(["--output-format", "json"]), true);
    assert.equal(shouldUseGeminiJson(["-o", "JSON"]), true);
    assert.equal(shouldUseGeminiJson(["--output-format=json"]), true);
    assert.equal(shouldUseGeminiJson(["-o=json"]), true);
    assert.equal(shouldUseGeminiJson(["--output-format", "json", "-o", "text"]), false);
    assert.equal(shouldUseGeminiJson(["--output-format", "stream-json"]), false);
    assert.equal(shouldUseGeminiJson([]), false);
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

  test("authority requires full-native consent semantics for YOLO on custom Gemini seats", () => {
    const result = geminiAdapter.authority(
      { ...geminiDef, id: "gemini-research" },
      ctx({ rawArgs: ["--output-format", "json", "--approval-mode=yolo"] }),
    );
    assert.equal(result.level, "fullNative");
    assert.match(result.detail, /auto-approves every tool/i);
  });
});
