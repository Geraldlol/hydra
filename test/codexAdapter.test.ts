import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as vscode from "vscode";
import { codexAdapter } from "../src/codexAdapter";
import type { AgentDefinition, InvocationContext } from "../src/agentAdapter";

// agentArgs.ts's withModelArgs (which codexAdapter.buildInvocation calls)
// reads vscode.workspace.getConfiguration("hydraRoom").get(...) at runtime;
// node:test substitutes a stub (scripts/setup-vscode-stub.js) exposing
// `currentConfig` so tests can simulate hydraRoom.codexModel / an undeclared
// hydraRoom.<id>Model being set.
const currentConfig = (vscode as unknown as { currentConfig: Record<string, unknown> }).currentConfig;

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

  test("custom vendor-kind head (non-builtin id) reads model from def.model, ignoring an undeclared hydraRoom.<id>Model setting", () => {
    currentConfig.mycodexModel = "should-be-ignored";
    try {
      const customDef: AgentDefinition = {
        id: "mycodex",
        displayName: "My Codex",
        kind: "codex",
        model: "custom-model-y",
        command: "codex",
      };
      const inv = codexAdapter.buildInvocation(customDef, ctx());
      assert.equal(inv.transport, "spawn");
      if (inv.transport !== "spawn") return;
      assert.equal(inv.args.filter((a) => a === "--model").length, 1);
      assert.equal(inv.args[inv.args.indexOf("--model") + 1], "custom-model-y");
      assert.ok(!inv.args.includes("should-be-ignored"), "the undeclared per-id setting value must never appear in argv");
    } finally {
      delete currentConfig.mycodexModel;
    }
  });

  test("builtin codex ignores def.model (no fallback) -- built-in model resolution stays exactly hydraRoom.codexModel-driven", () => {
    delete currentConfig.codexModel;
    const inv = codexAdapter.buildInvocation({ ...codexDef, model: "should-not-be-used" }, ctx());
    assert.equal(inv.transport, "spawn");
    if (inv.transport !== "spawn") return;
    assert.ok(!inv.args.includes("--model"));
  });

  test("builtin codex still reads hydraRoom.codexModel (byte-identical)", () => {
    currentConfig.codexModel = "gpt-5.4";
    try {
      const inv = codexAdapter.buildInvocation(codexDef, ctx());
      assert.equal(inv.transport, "spawn");
      if (inv.transport !== "spawn") return;
      assert.equal(inv.args.filter((a) => a === "--model").length, 1);
      assert.equal(inv.args[inv.args.indexOf("--model") + 1], "gpt-5.4");
    } finally {
      delete currentConfig.codexModel;
    }
  });
});
