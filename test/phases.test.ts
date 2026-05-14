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

  test("Build + buildDone -> BuildDone with same builder", () => {
    const next = transition({ name: "Build", builder: "codex" }, { type: "buildDone" });
    assert.equal(next.name, "BuildDone");
    assert.equal((next as any).builder, "codex");
  });

  test("BuildDone + requestReview -> Review with the other agent", () => {
    const next = transition({ name: "BuildDone", builder: "codex" }, { type: "requestReview" });
    assert.equal(next.name, "Review");
    assert.equal((next as any).reviewer, "claude");
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

  test("ReviewDone + handBack -> Build with the original builder", () => {
    const next = transition(
      { name: "ReviewDone", reviewer: "claude", approved: false },
      { type: "handBack" }
    );
    assert.equal(next.name, "Build");
    assert.equal((next as any).builder, "codex");
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
});
