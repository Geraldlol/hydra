import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { transition, pickReviewers, DEFAULT_ROSTER } from "../src/phases";
import { getAgentDefinition, adapterForKind } from "../src/agentRegistry";
import "../src/geminiAdapter"; // ensure registration side-effect

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

  test("gemini is selectable and yields a spawn invocation for every phase", () => {
    const def = getAgentDefinition("gemini");
    assert.ok(def, "gemini must be a registered head");
    for (const phase of ["opener", "build", "review"] as const) {
      const inv = adapterForKind(def!.kind).buildInvocation(def!, {
        phase, workspaceRoot: "C:/repo", prompt: "hi", command: "gemini", rawArgs: ["-p", "-"],
      });
      assert.equal(inv.transport, "spawn");
    }
  });
});
