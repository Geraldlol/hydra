import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { transition, pickReviewers, DEFAULT_ROSTER } from "../src/phases";
import { getAgentDefinition, adapterForKind } from "../src/agentRegistry";
import type { AgentDefinition, Invocation, InvocationContext } from "../src/agentAdapter";
import type { Phase } from "../src/prompts";
import "../src/geminiAdapter"; // gemini registers via agentRegistry.ts's module body, not here

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

  test("codex and claude spawn argv is prompt-independent (dispatch argv == preview argv, prompt via stdin)", () => {
    // Why: SP2 Task 8 switched turn dispatch from the empty-prompt buildSpawn
    // to buildInvocationFor(REAL prompt). For the default codex+claude roster
    // that must be a no-op: vendor adapters carry the prompt on stdin, never
    // in argv, so dispatch argv stays byte-identical to the preview argv.
    for (const agent of ["codex", "claude"] as const) {
      const def = getAgentDefinition(agent);
      assert.ok(def, `${agent} must be a registered head`);
      const rawArgs = agent === "codex" ? ["exec", "-"] : ["-p"];
      for (const phase of ALL_PHASES) {
        // Why: the explicit return type breaks the inference circularity TS7022
        // creates when a closure captures an assertion-narrowed binding (def).
        const build = (prompt: string): Invocation =>
          adapterForKind(def!.kind).buildInvocation(def!, { phase, workspaceRoot: "C:/repo", prompt, command: agent, rawArgs });
        const real = build("real dispatch prompt");
        const preview = build("");
        assert.equal(real.transport, "spawn", `${agent} ${phase} must spawn`);
        assert.equal(preview.transport, "spawn", `${agent} ${phase} preview must spawn`);
        if (real.transport !== "spawn" || preview.transport !== "spawn") continue;
        assert.equal(real.command, preview.command, `${agent} ${phase} command must not depend on the prompt`);
        assert.deepEqual(real.args, preview.args, `${agent} ${phase} argv must not depend on the prompt`);
        assert.equal(real.stdin, "real dispatch prompt", `${agent} ${phase} must carry the prompt on stdin`);
      }
    }
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
