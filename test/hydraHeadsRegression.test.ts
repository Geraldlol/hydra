import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { transition, pickReviewers, DEFAULT_ROSTER } from "../src/phases";
import { getAgentDefinition, adapterForKind } from "../src/agentRegistry";
import type { AgentDefinition, InvocationContext } from "../src/agentAdapter";
import type { Phase } from "../src/prompts";
import "../src/geminiAdapter"; // ensure registration side-effect

const ALL_PHASES: Phase[] = ["opener", "reactor", "closer", "parallel", "build", "review"];

describe("hydra heads SP1 regression", () => {
  test("default room still runs opener -> reactor -> closer -> awaiting with codex+claude", () => {
    let s = transition({ name: "Idle" }, { type: "userSent", opener: "codex" });
    assert.equal(s.name, "Opener");
    assert.equal((s as any).opener, "codex");
    assert.equal((s as any).reactor, "claude");
    s = transition(s, { type: "openerDone" });
    assert.equal(s.name, "Reactor");
    s = transition(s, { type: "reactorDone" });
    assert.equal(s.name, "Closer");
    s = transition(s, { type: "closerDone" });
    assert.equal(s.name, "AwaitingUser");
  });

  test("build -> review handoff still names the other head as reviewer", () => {
    const built = transition({ name: "AwaitingUser" }, { type: "assignBuilder", builder: "codex" });
    const done = transition(built, { type: "buildDone" });
    const review = transition(done, { type: "requestReview" });
    assert.equal(review.name, "Review");
    assert.equal((review as any).reviewer, "claude");
    assert.deepEqual(pickReviewers("codex", [...DEFAULT_ROSTER]), ["claude"]);
  });

  test("gemini is selectable and yields a correctly-wired spawn invocation for every phase", () => {
    const registered = getAgentDefinition("gemini");
    assert.ok(registered, "gemini must be a registered head");
    // Why: the registered built-in def has no `model` yet (hydraRoom.geminiModel
    // lands in a later task, see src/geminiAdapter.ts), so a model is set here
    // the same way test/geminiAdapter.test.ts does, to exercise the --model
    // injection path this test is meant to discriminate on.
    const def: AgentDefinition = { ...registered!, model: "gemini-2.5-pro" };
    const command = "gemini";
    for (const phase of ALL_PHASES) {
      const ctx: InvocationContext = {
        phase, workspaceRoot: "C:/repo", prompt: "hi", command, rawArgs: ["-p", "-"],
      };
      const inv = adapterForKind(def.kind).buildInvocation(def, ctx);
      assert.equal(inv.transport, "spawn", `phase ${phase} must spawn`);
      if (inv.transport !== "spawn") continue;
      assert.equal(inv.command, command, `phase ${phase} must use the configured command`);
      const modelIndex = inv.args.indexOf("--model");
      assert.ok(
        modelIndex >= 0 && inv.args[modelIndex + 1] === def.model,
        `phase ${phase} must inject --model ${def.model} into argv, got ${JSON.stringify(inv.args)}`
      );
    }
  });
});
