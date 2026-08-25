import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  DEFAULT_ROSTER,
  pickReviewers,
  transition,
  type State,
} from "../src/phases";
import { buildParallelDiscussionWorkers } from "../src/claudeWorkers";
import { evaluateReviewConvergence, type ReviewVerdict } from "../src/reviewConvergence";

const ROSTER = ["codex", "claude", "gemini"] as const;
const verdict = (agent: string, approved: boolean): ReviewVerdict => ({ agent, approved });

describe("N-way room acceptance", () => {
  test("all-discuss seats every configured head", () => {
    const workers = buildParallelDiscussionWorkers({
      roster: ROSTER,
      manyHeads: false,
      transport: "oneShot",
      claudeWorkerCount: 3,
      makeTraceId: (agent) => `${agent}-trace`,
    });
    assert.deepEqual(workers.map((worker) => worker.agent), [...ROSTER]);
  });

  test("one builder fans out to all other heads and receives any hand-back", () => {
    const reviewers = pickReviewers("codex", ROSTER);
    assert.deepEqual(reviewers, ["claude", "gemini"]);
    let state: State = transition(
      { name: "AwaitingUser" },
      { type: "assignBuilder", builder: "codex" },
    );
    state = transition(state, { type: "buildDone" });
    state = transition(state, { type: "requestReview", reviewers });
    assert.deepEqual(state, {
      name: "ParallelReview",
      agents: ["claude", "gemini"],
      builders: ["codex"],
    });
    state = transition(state, { type: "parallelReviewDone", approved: false });
    assert.deepEqual(transition(state, { type: "handBack" }), {
      name: "Build",
      builder: "codex",
    });
  });

  test("convergence never auto-approves a split under human or unanimous policy", () => {
    const split = [verdict("claude", true), verdict("gemini", false)];
    const human = evaluateReviewConvergence(split, "human");
    assert.equal(human.approved, false);
    assert.equal(human.requiresHumanResolution, true);
    assert.equal(evaluateReviewConvergence(split, "unanimous").approved, false);
    assert.equal(evaluateReviewConvergence(split, "majority").approved, false);
  });
});

describe("default two-head room regression", () => {
  test("preserves the opener, reactor, closer sequence", () => {
    let state: State = transition({ name: "Idle" }, { type: "userSent", opener: "codex" });
    assert.deepEqual(state, { name: "Opener", opener: "codex", reactor: "claude" });
    state = transition(state, { type: "openerDone" });
    assert.deepEqual(state, { name: "Reactor", opener: "codex", reactor: "claude" });
    state = transition(state, { type: "reactorDone" });
    assert.deepEqual(state, { name: "Closer", opener: "codex", reactor: "claude" });
    assert.deepEqual(transition(state, { type: "closerDone" }), { name: "AwaitingUser" });
  });

  test("preserves a single non-builder reviewer and original hand-back target", () => {
    const reviewers = pickReviewers("codex", DEFAULT_ROSTER);
    assert.deepEqual(reviewers, ["claude"]);
    let state: State = transition(
      { name: "BuildDone", builder: "codex" },
      { type: "requestReview", reviewers },
    );
    assert.deepEqual(state, { name: "Review", reviewer: "claude", builder: "codex" });
    state = transition(state, { type: "reviewDone", approved: false });
    assert.deepEqual(transition(state, { type: "handBack" }), { name: "Build", builder: "codex" });
  });
});
