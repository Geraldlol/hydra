import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { shouldRunParallelDiscussion, transition } from "../src/phases";

describe("transition()", () => {
  test("Idle + userSent -> Opener with paired reactor", () => {
    const next = transition({ name: "Idle" }, { type: "userSent", opener: "codex" });
    assert.equal(next.name, "Opener");
    assert.equal((next as any).opener, "codex");
    assert.equal((next as any).reactor, "claude");
  });

  test("Opener + openerDone -> Reactor with same agents", () => {
    const next = transition({ name: "Opener", opener: "claude", reactor: "codex" }, { type: "openerDone" });
    assert.equal(next.name, "Reactor");
    assert.equal((next as any).opener, "claude");
    assert.equal((next as any).reactor, "codex");
  });

  test("Reactor + reactorDone -> Closer with same agents", () => {
    const next = transition({ name: "Reactor", opener: "codex", reactor: "claude" }, { type: "reactorDone" });
    assert.equal(next.name, "Closer");
    assert.equal((next as any).opener, "codex");
    assert.equal((next as any).reactor, "claude");
  });

  test("Closer + closerDone -> AwaitingUser", () => {
    const next = transition({ name: "Closer", opener: "codex", reactor: "claude" }, { type: "closerDone" });
    assert.equal(next.name, "AwaitingUser");
  });

  test("Idle + parallel userSent -> ParallelDiscussion", () => {
    const next = transition({ name: "Idle" }, { type: "userSent", opener: "codex", parallel: true });
    assert.equal(next.name, "ParallelDiscussion");
    assert.deepEqual((next as any).agents, ["codex", "claude"]);
  });

  test("ParallelDiscussion + parallelDone -> AwaitingUser", () => {
    const next = transition({ name: "ParallelDiscussion", agents: ["codex", "claude"] }, { type: "parallelDone" });
    assert.equal(next.name, "AwaitingUser");
  });

  test("AwaitingUser + userSent -> Opener (loop)", () => {
    const next = transition({ name: "AwaitingUser" }, { type: "userSent", opener: "claude" });
    assert.equal(next.name, "Opener");
    assert.equal((next as any).opener, "claude");
    assert.equal((next as any).reactor, "codex");
  });

  test("AwaitingUser + assignBuilder(claude) -> Build claude", () => {
    const next = transition({ name: "AwaitingUser" }, { type: "assignBuilder", builder: "claude" });
    assert.equal(next.name, "Build");
    assert.equal((next as any).builder, "claude");
  });

  test("AwaitingUser + assignBuilders -> ParallelBuild", () => {
    const next = transition({ name: "AwaitingUser" }, { type: "assignBuilders", agents: ["codex", "claude"] });
    assert.equal(next.name, "ParallelBuild");
    assert.deepEqual((next as any).agents, ["codex", "claude"]);
  });

  test("Build + buildDone -> BuildDone with same builder", () => {
    const next = transition({ name: "Build", builder: "codex" }, { type: "buildDone" });
    assert.equal(next.name, "BuildDone");
    assert.equal((next as any).builder, "codex");
  });

  test("ParallelBuild + parallelBuildDone -> ParallelBuildDone", () => {
    const next = transition({ name: "ParallelBuild", agents: ["codex", "claude"] }, { type: "parallelBuildDone" });
    assert.equal(next.name, "ParallelBuildDone");
    assert.deepEqual((next as any).agents, ["codex", "claude"]);
  });

  test("BuildDone + requestReview -> Review with the other agent", () => {
    const next = transition({ name: "BuildDone", builder: "codex" }, { type: "requestReview" });
    assert.equal(next.name, "Review");
    assert.equal((next as any).reviewer, "claude");
  });

  test("ParallelBuildDone + requestReview -> ParallelReview", () => {
    const next = transition({ name: "ParallelBuildDone", agents: ["codex", "claude"] }, { type: "requestReview" });
    assert.equal(next.name, "ParallelReview");
    assert.deepEqual((next as any).agents, ["codex", "claude"]);
  });

  test("BuildDone + requestReviewSkipped -> AwaitingUser", () => {
    const next = transition({ name: "BuildDone", builder: "codex" }, { type: "requestReviewSkipped" });
    assert.equal(next.name, "AwaitingUser");
  });

  test("ParallelBuildDone + requestReviewSkipped -> AwaitingUser", () => {
    const next = transition({ name: "ParallelBuildDone", agents: ["codex", "claude"] }, { type: "requestReviewSkipped" });
    assert.equal(next.name, "AwaitingUser");
  });

  test("requestReviewSkipped is identity on non-BuildDone states", () => {
    // Spot-check; the exhaustive sweep below covers the remaining states.
    assert.equal(transition({ name: "Idle" }, { type: "requestReviewSkipped" }).name, "Idle");
    assert.equal(transition({ name: "Build", builder: "codex" }, { type: "requestReviewSkipped" }).name, "Build");
    assert.equal(transition({ name: "Review", reviewer: "claude" }, { type: "requestReviewSkipped" }).name, "Review");
  });

  test("BuildDone + userSent -> Opener (chat unlocks after build)", () => {
    const next = transition({ name: "BuildDone", builder: "codex" }, { type: "userSent", opener: "claude" });
    assert.equal(next.name, "Opener");
    assert.equal((next as any).opener, "claude");
    assert.equal((next as any).reactor, "codex");
  });

  test("BuildDone + parallel userSent -> ParallelDiscussion", () => {
    const next = transition({ name: "BuildDone", builder: "codex" }, { type: "userSent", opener: "codex", parallel: true });
    assert.equal(next.name, "ParallelDiscussion");
    assert.deepEqual((next as any).agents, ["codex", "claude"]);
  });

  test("Review + reviewDone(approved) -> ReviewDone approved", () => {
    const next = transition({ name: "Review", reviewer: "claude" }, { type: "reviewDone", approved: true });
    assert.equal(next.name, "ReviewDone");
    assert.equal((next as any).approved, true);
  });

  test("ParallelReview + parallelReviewDone -> ParallelReviewDone approved", () => {
    const next = transition({ name: "ParallelReview", agents: ["codex", "claude"] }, { type: "parallelReviewDone", approved: true });
    assert.equal(next.name, "ParallelReviewDone");
    assert.equal((next as any).approved, true);
    assert.deepEqual((next as any).agents, ["codex", "claude"]);
  });

  test("ReviewDone + handBack -> Build with the original builder", () => {
    const next = transition(
      { name: "ReviewDone", reviewer: "claude", approved: false },
      { type: "handBack" }
    );
    assert.equal(next.name, "Build");
    assert.equal((next as any).builder, "codex");
  });

  test("ParallelReviewDone + handBack -> ParallelBuild with same agents", () => {
    const next = transition(
      { name: "ParallelReviewDone", agents: ["codex", "claude"], approved: false },
      { type: "handBack" }
    );
    assert.equal(next.name, "ParallelBuild");
    assert.deepEqual((next as any).agents, ["codex", "claude"]);
  });

  test("ReviewDone + userSent -> Opener (next discussion)", () => {
    const next = transition(
      { name: "ReviewDone", reviewer: "claude", approved: true },
      { type: "userSent", opener: "codex" }
    );
    assert.equal(next.name, "Opener");
    assert.equal((next as any).opener, "codex");
  });

  for (const inFlight of [
    { name: "Opener" as const, opener: "codex" as const, reactor: "claude" as const },
    { name: "Reactor" as const, opener: "codex" as const, reactor: "claude" as const },
    { name: "Closer" as const, opener: "codex" as const, reactor: "claude" as const },
    { name: "ParallelDiscussion" as const, agents: ["codex", "claude"] as const },
    { name: "ParallelBuild" as const, agents: ["codex", "claude"] as const },
    { name: "ParallelReview" as const, agents: ["codex", "claude"] as const },
  ]) {
    test(`${inFlight.name} + stop -> AwaitingUser`, () => {
      const next = transition(inFlight, { type: "stop" });
      assert.equal(next.name, "AwaitingUser");
    });
  }

  test("Build + stop -> AwaitingUser", () => {
    const next = transition({ name: "Build", builder: "codex" }, { type: "stop" });
    assert.equal(next.name, "AwaitingUser");
  });

  test("Review + stop -> AwaitingUser", () => {
    const next = transition({ name: "Review", reviewer: "claude" }, { type: "stop" });
    assert.equal(next.name, "AwaitingUser");
  });

  test("stop in non-flight state is a no-op", () => {
    const next = transition({ name: "Idle" }, { type: "stop" });
    assert.equal(next.name, "Idle");
  });

  test("unrelated events in a state are no-ops", () => {
    const next = transition({ name: "Idle" }, { type: "openerDone" });
    assert.equal(next.name, "Idle");
  });
});

describe("transition exhaustive sweep", () => {
  type SweepState =
    | { name: "Idle" }
    | { name: "Opener"; opener: "codex"; reactor: "claude" }
    | { name: "Reactor"; opener: "codex"; reactor: "claude" }
    | { name: "Closer"; opener: "codex"; reactor: "claude" }
    | { name: "ParallelDiscussion"; agents: ReadonlyArray<"codex" | "claude"> }
    | { name: "AwaitingUser" }
    | { name: "Build"; builder: "codex" }
    | { name: "BuildDone"; builder: "codex" }
    | { name: "Review"; reviewer: "claude" }
    | { name: "ReviewDone"; reviewer: "claude"; approved: boolean };

  type SweepEvent =
    | { type: "userSent"; opener: "codex"; parallel?: false }
    | { type: "userSent"; opener: "codex"; parallel: true }
    | { type: "openerDone" }
    | { type: "reactorDone" }
    | { type: "closerDone" }
    | { type: "parallelDone" }
    | { type: "assignBuilder"; builder: "claude" }
    | { type: "buildDone" }
    | { type: "requestReview" }
    | { type: "reviewDone"; approved: boolean }
    | { type: "handBack" }
    | { type: "requestReviewSkipped" }
    | { type: "stop" };

  const states: ReadonlyArray<SweepState> = [
    { name: "Idle" },
    { name: "Opener", opener: "codex", reactor: "claude" },
    { name: "Reactor", opener: "codex", reactor: "claude" },
    { name: "Closer", opener: "codex", reactor: "claude" },
    { name: "ParallelDiscussion", agents: ["codex", "claude"] },
    { name: "AwaitingUser" },
    { name: "Build", builder: "codex" },
    { name: "BuildDone", builder: "codex" },
    { name: "Review", reviewer: "claude" },
    { name: "ReviewDone", reviewer: "claude", approved: false },
  ];

  const events: ReadonlyArray<SweepEvent> = [
    { type: "userSent", opener: "codex" },
    { type: "userSent", opener: "codex", parallel: true },
    { type: "openerDone" },
    { type: "reactorDone" },
    { type: "closerDone" },
    { type: "parallelDone" },
    { type: "assignBuilder", builder: "claude" },
    { type: "buildDone" },
    { type: "requestReview" },
    { type: "reviewDone", approved: true },
    { type: "handBack" },
    { type: "requestReviewSkipped" },
    { type: "stop" },
  ];

  type Expected = "identity" | { name: string };

  // Per-event expectations for each state.
  // - "identity" means transition returns the input state (no-op / rejected event).
  // - { name: "X" } means the transition lands in a state whose discriminator is X.
  const expectations: Record<string, Record<string, Expected>> = {
    Idle: {
      "userSent": { name: "Opener" },
      "userSent:parallel": { name: "ParallelDiscussion" },
      "openerDone": "identity",
      "reactorDone": "identity",
      "closerDone": "identity",
      "parallelDone": "identity",
      "assignBuilder": "identity",
      "buildDone": "identity",
      "requestReview": "identity",
      "reviewDone": "identity",
      "handBack": "identity",
      "requestReviewSkipped": "identity",
      "stop": "identity",
    },
    Opener: {
      "userSent": "identity",
      "userSent:parallel": "identity",
      "openerDone": { name: "Reactor" },
      "reactorDone": "identity",
      "closerDone": "identity",
      "parallelDone": "identity",
      "assignBuilder": "identity",
      "buildDone": "identity",
      "requestReview": "identity",
      "reviewDone": "identity",
      "handBack": "identity",
      "requestReviewSkipped": "identity",
      "stop": { name: "AwaitingUser" },
    },
    Reactor: {
      "userSent": "identity",
      "userSent:parallel": "identity",
      "openerDone": "identity",
      "reactorDone": { name: "Closer" },
      "closerDone": "identity",
      "parallelDone": "identity",
      "assignBuilder": "identity",
      "buildDone": "identity",
      "requestReview": "identity",
      "reviewDone": "identity",
      "handBack": "identity",
      "requestReviewSkipped": "identity",
      "stop": { name: "AwaitingUser" },
    },
    Closer: {
      "userSent": "identity",
      "userSent:parallel": "identity",
      "openerDone": "identity",
      "reactorDone": "identity",
      "closerDone": { name: "AwaitingUser" },
      "parallelDone": "identity",
      "assignBuilder": "identity",
      "buildDone": "identity",
      "requestReview": "identity",
      "reviewDone": "identity",
      "handBack": "identity",
      "requestReviewSkipped": "identity",
      "stop": { name: "AwaitingUser" },
    },
    ParallelDiscussion: {
      "userSent": "identity",
      "userSent:parallel": "identity",
      "openerDone": "identity",
      "reactorDone": "identity",
      "closerDone": "identity",
      "parallelDone": { name: "AwaitingUser" },
      "assignBuilder": "identity",
      "buildDone": "identity",
      "requestReview": "identity",
      "reviewDone": "identity",
      "handBack": "identity",
      "requestReviewSkipped": "identity",
      "stop": { name: "AwaitingUser" },
    },
    AwaitingUser: {
      "userSent": { name: "Opener" },
      "userSent:parallel": { name: "ParallelDiscussion" },
      "openerDone": "identity",
      "reactorDone": "identity",
      "closerDone": "identity",
      "parallelDone": "identity",
      "assignBuilder": { name: "Build" },
      "buildDone": "identity",
      "requestReview": "identity",
      "reviewDone": "identity",
      "handBack": "identity",
      "requestReviewSkipped": "identity",
      "stop": "identity",
    },
    Build: {
      "userSent": "identity",
      "userSent:parallel": "identity",
      "openerDone": "identity",
      "reactorDone": "identity",
      "closerDone": "identity",
      "parallelDone": "identity",
      "assignBuilder": "identity",
      "buildDone": { name: "BuildDone" },
      "requestReview": "identity",
      "reviewDone": "identity",
      "handBack": "identity",
      "requestReviewSkipped": "identity",
      "stop": { name: "AwaitingUser" },
    },
    BuildDone: {
      "userSent": { name: "Opener" },
      "userSent:parallel": { name: "ParallelDiscussion" },
      "openerDone": "identity",
      "reactorDone": "identity",
      "closerDone": "identity",
      "parallelDone": "identity",
      "assignBuilder": "identity",
      "buildDone": "identity",
      "requestReview": { name: "Review" },
      "reviewDone": "identity",
      "handBack": "identity",
      "requestReviewSkipped": { name: "AwaitingUser" },
      "stop": "identity",
    },
    Review: {
      "userSent": "identity",
      "userSent:parallel": "identity",
      "openerDone": "identity",
      "reactorDone": "identity",
      "closerDone": "identity",
      "parallelDone": "identity",
      "assignBuilder": "identity",
      "buildDone": "identity",
      "requestReview": "identity",
      "reviewDone": { name: "ReviewDone" },
      "handBack": "identity",
      "requestReviewSkipped": "identity",
      "stop": { name: "AwaitingUser" },
    },
    ReviewDone: {
      "userSent": { name: "Opener" },
      "userSent:parallel": { name: "ParallelDiscussion" },
      "openerDone": "identity",
      "reactorDone": "identity",
      "closerDone": "identity",
      "parallelDone": "identity",
      "assignBuilder": "identity",
      "buildDone": "identity",
      "requestReview": "identity",
      "reviewDone": "identity",
      "handBack": { name: "Build" },
      "requestReviewSkipped": "identity",
      "stop": "identity",
    },
  };

  const eventKey = (e: SweepEvent): string =>
    e.type === "userSent" && e.parallel ? "userSent:parallel" : e.type;

  const cases: Array<{ from: SweepState; event: SweepEvent; expected: Expected }> = [];
  for (const from of states) {
    for (const event of events) {
      const stateExpectations = expectations[from.name];
      assert.ok(stateExpectations, `missing expectations for state ${from.name}`);
      const expected = stateExpectations[eventKey(event)];
      assert.ok(expected, `missing expectation for ${from.name} + ${eventKey(event)}`);
      cases.push({ from, event, expected });
    }
  }

  for (const { from, event, expected } of cases) {
    const label =
      expected === "identity"
        ? `${from.name} + ${eventKey(event)} -> identity (no-op)`
        : `${from.name} + ${eventKey(event)} -> ${expected.name}`;
    test(label, () => {
      const result = transition(from, event);
      if (expected === "identity") {
        assert.equal(result, from, `expected reference-equal identity for ${from.name} + ${eventKey(event)}`);
      } else {
        assert.equal(result.name, expected.name, `expected ${expected.name} for ${from.name} + ${eventKey(event)}, got ${result.name}`);
      }
    });
  }
});

describe("shouldRunParallelDiscussion()", () => {
  test("detects explicit both-agent requests", () => {
    assert.equal(shouldRunParallelDiscussion("okay both of you do xyz"), true);
    assert.equal(shouldRunParallelDiscussion("You both review the plan"), true);
    assert.equal(shouldRunParallelDiscussion("you and Claude run checks"), true);
    assert.equal(shouldRunParallelDiscussion("Codex and Claude, investigate this"), true);
    assert.equal(shouldRunParallelDiscussion("Claude and Codex analyze the diff"), true);
  });

  test("leaves ordinary discussion routed through the serial loop", () => {
    assert.equal(shouldRunParallelDiscussion("why are Codex and Claude different?"), false);
    assert.equal(shouldRunParallelDiscussion("Codex should open, Claude can react"), false);
    assert.equal(shouldRunParallelDiscussion("what should we do next?"), false);
  });

  test("honors explicit discussion mode overrides", () => {
    assert.equal(shouldRunParallelDiscussion("what should we do next?", "parallel"), true);
    assert.equal(shouldRunParallelDiscussion("both of you review this", "serial"), false);
    assert.equal(shouldRunParallelDiscussion("both of you review this", "parallelOnBoth"), true);
  });
});
