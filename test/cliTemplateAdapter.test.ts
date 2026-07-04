import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { cliTemplateAdapter, expandCliTemplateArgs } from "../src/cliTemplateAdapter";
import type { AgentDefinition, InvocationContext } from "../src/agentAdapter";

const base: AgentDefinition = {
  id: "my-tool", displayName: "My Tool", kind: "cli-template",
  command: "my-tool", argsTemplate: ["run", "--model", "${model}", "--prompt", "${prompt}"], model: "local-7b",
};
const ctx: InvocationContext = { phase: "build", workspaceRoot: "C:/repo", prompt: "do X", command: "my-tool", rawArgs: [] };

describe("cli-template adapter", () => {
  test("expandCliTemplateArgs substitutes prompt/model/workspaceFolder", () => {
    const args = expandCliTemplateArgs(["-C", "${workspaceFolder}", "-m", "${model}", "${prompt}"],
      { prompt: "hi there", model: "local-7b", workspaceRoot: "C:/repo" });
    assert.deepEqual(args, ["-C", "C:/repo", "-m", "local-7b", "hi there"]);
  });

  test("buildInvocation spawns command with expanded args; prompt in argv omits stdin", () => {
    const inv = cliTemplateAdapter.buildInvocation(base, ctx);
    assert.equal(inv.transport, "spawn");
    if (inv.transport !== "spawn") return;
    assert.equal(inv.command, "my-tool");
    assert.deepEqual(inv.args, ["run", "--model", "local-7b", "--prompt", "do X"]);
    assert.equal(inv.stdin, undefined); // ${prompt} consumed into argv
  });

  test("no ${prompt} placeholder -> prompt is written to stdin", () => {
    const inv = cliTemplateAdapter.buildInvocation({ ...base, argsTemplate: ["run", "-"] }, ctx);
    if (inv.transport !== "spawn") return;
    assert.deepEqual(inv.args, ["run", "-"]);
    assert.equal(inv.stdin, "do X");
  });

  test("authority defaults to fullNative and narrows to workspaceWrite when declared", () => {
    assert.equal(cliTemplateAdapter.authority(base, ctx).level, "fullNative");
    assert.equal(cliTemplateAdapter.authority({ ...base, defaultAuthority: "workspace-write" }, ctx).level, "workspaceWrite");
  });
});
