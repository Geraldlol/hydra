import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  appendClaudeWorkerAssignment,
  buildParallelDiscussionWorkers,
  clampManyHeadsClaudeWorkerCount,
  claudeWorkerTraceIds,
} from "../src/claudeWorkers";
import type { AgentId } from "../src/phases";
import type { Phase } from "../src/prompts";

const trace = (agent: AgentId, phase: Phase) => `${agent}-${phase}-${Math.random().toString(16).slice(2, 6)}`;

describe("clampManyHeadsClaudeWorkerCount", () => {
  test("defaults invalid values to three local subscription workers", () => {
    assert.equal(clampManyHeadsClaudeWorkerCount(undefined), 3);
    assert.equal(clampManyHeadsClaudeWorkerCount(Number.NaN), 3);
    assert.equal(clampManyHeadsClaudeWorkerCount("5"), 3);
  });

  test("clamps to the supported local fanout range", () => {
    assert.equal(clampManyHeadsClaudeWorkerCount(0), 1);
    assert.equal(clampManyHeadsClaudeWorkerCount(2.9), 2);
    assert.equal(clampManyHeadsClaudeWorkerCount(99), 8);
  });
});

describe("buildParallelDiscussionWorkers", () => {
  test("falls back to one Codex and one Claude worker outside one-shot Many Heads mode", () => {
    const disabled = buildParallelDiscussionWorkers({
      manyHeads: false,
      transport: "oneShot",
      claudeWorkerCount: 5,
      makeTraceId: trace,
    });
    assert.deepEqual(disabled.map((worker) => worker.agent), ["codex", "claude"]);
    assert.equal(disabled.some((worker) => worker.manyHeadsDispatch), false);
    assert.deepEqual(claudeWorkerTraceIds(disabled), []);

    const bridge = buildParallelDiscussionWorkers({
      manyHeads: true,
      transport: "terminalBridge",
      claudeWorkerCount: 5,
      makeTraceId: trace,
    });
    assert.deepEqual(bridge.map((worker) => worker.agent), ["codex", "claude"]);
    assert.equal(bridge.some((worker) => worker.manyHeadsDispatch), false);
    assert.deepEqual(claudeWorkerTraceIds(bridge), []);
  });

  test("plans bounded local Claude fanout through the subscription-backed one-shot runtime", () => {
    const workers = buildParallelDiscussionWorkers({
      manyHeads: true,
      transport: "oneShot",
      claudeWorkerCount: 3,
      makeTraceId: (agent, phase) => `${agent}-${phase}-${workersSeen++}`,
    });
    assert.deepEqual(workers.map((worker) => worker.workerId), ["codex", "claude-1", "claude-2", "claude-3"]);
    assert.deepEqual(workers.map((worker) => worker.agent), ["codex", "claude", "claude", "claude"]);
    assert.equal(workers[0]?.manyHeadsDispatch, false);
    assert.equal(workers.slice(1).every((worker) => worker.manyHeadsDispatch), true);
    assert.equal(new Set(claudeWorkerTraceIds(workers)).size, 3);
  });

  test("worker assignment text only appears when more than one Claude worker runs", () => {
    const single = buildParallelDiscussionWorkers({
      manyHeads: true,
      transport: "oneShot",
      claudeWorkerCount: 1,
      makeTraceId: trace,
    })[1];
    assert.ok(single);
    assert.equal(appendClaudeWorkerAssignment("base", single), "base");

    const worker = buildParallelDiscussionWorkers({
      manyHeads: true,
      transport: "oneShot",
      claudeWorkerCount: 2,
      makeTraceId: trace,
    })[2];
    assert.ok(worker);
    const text = appendClaudeWorkerAssignment("base", worker);
    assert.match(text, /Claude worker 2 of 2/);
    assert.match(text, /Work independently/);
  });
});

let workersSeen = 0;
