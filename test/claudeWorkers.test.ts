import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  appendClaudeBuildAdvisories,
  appendClaudeBuildWorkerAssignment,
  appendClaudeReviewWorkerAssignment,
  appendClaudeWorkerAssignment,
  buildClaudeBuildWorkers,
  buildClaudeReviewWorkers,
  buildParallelDiscussionWorkers,
  clampManyHeadsClaudeWorkerCount,
  claudeWorkerTraceIds,
  collapseClaudeReviewWorkerVerdicts,
  restrictClaudeWorkerInvocation,
} from "../src/claudeWorkers";
import type { Invocation } from "../src/agentAdapter";
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

  test("runs every seated head exactly once when Claude fanout is disabled", () => {
    const workers = buildParallelDiscussionWorkers({
      roster: ["codex", "claude", "gemini"],
      manyHeads: false,
      transport: "oneShot",
      claudeWorkerCount: 3,
      makeTraceId: trace,
    });
    assert.deepEqual(workers.map((worker) => worker.agent), ["codex", "claude", "gemini"]);
  });

  test("Claude-only fanout preserves every other seated head", () => {
    const workers = buildParallelDiscussionWorkers({
      roster: ["gemini", "claude", "codex"],
      manyHeads: true,
      transport: "oneShot",
      claudeWorkerCount: 2,
      makeTraceId: trace,
    });
    assert.deepEqual(workers.map((worker) => worker.agent), ["gemini", "claude", "claude", "codex"]);
  });
});

describe("Claude Build worker fanout", () => {
  test("plans bounded read-only advisers before one ordinary lead", () => {
    const plan = buildClaudeBuildWorkers({
      agent: "claude",
      eligible: true,
      manyHeads: true,
      transport: "oneShot",
      claudeWorkerCount: 99,
      makeTraceId: (agent, phase) => `${agent}-${phase}-${workersSeen++}`,
    });

    assert.equal(plan.lead.workerId, "claude");
    assert.equal(plan.lead.role, "lead");
    assert.equal(plan.lead.restrictedReadOnly, false);
    assert.equal(plan.lead.manyHeadsDispatch, false);
    assert.equal(plan.advisers.length, 7, "the eight-worker cap includes the lead");
    assert.equal(plan.advisers.every((worker) => worker.role === "adviser"), true);
    assert.equal(plan.advisers.every((worker) => worker.restrictedReadOnly), true);
    assert.equal(plan.advisers.every((worker) => worker.manyHeadsDispatch), true);
    assert.equal(new Set(plan.advisers.map((worker) => worker.traceIdOverride)).size, 7);
  });

  test("keeps the legacy single Build call when fanout is unavailable", () => {
    for (const input of [
      { eligible: false, manyHeads: true, transport: "oneShot" as const },
      { eligible: true, manyHeads: false, transport: "oneShot" as const },
      { eligible: true, manyHeads: true, transport: "terminalBridge" as const },
    ]) {
      const plan = buildClaudeBuildWorkers({
        agent: "claude",
        ...input,
        claudeWorkerCount: 5,
        makeTraceId: trace,
      });
      assert.equal(plan.advisers.length, 0);
      assert.equal(plan.lead.workerId, "claude");
      assert.equal(plan.lead.restrictedReadOnly, false);
    }
  });

  test("bounds and orders advisory context deterministically", () => {
    const forward = appendClaudeBuildAdvisories("base", [
      { workerId: "claude-build-3", text: "third" },
      { workerId: "claude-build-2", text: "x".repeat(20_000) },
    ]);
    const reverse = appendClaudeBuildAdvisories("base", [
      { workerId: "claude-build-2", text: "x".repeat(20_000) },
      { workerId: "claude-build-3", text: "third" },
    ]);
    assert.equal(forward, reverse);
    assert.ok(forward.indexOf("claude-build-2") < forward.indexOf("claude-build-3"));
    assert.ok(forward.length < 20_000, "worker output must not grow the lead prompt without a cap");
    assert.match(forward, /truncated/);
  });

  test("labels advisers as non-writing inputs to the sole lead", () => {
    const worker = buildClaudeBuildWorkers({
      agent: "claude",
      eligible: true,
      manyHeads: true,
      transport: "oneShot",
      claudeWorkerCount: 3,
      makeTraceId: trace,
    }).advisers[0];
    assert.ok(worker);
    const prompt = appendClaudeBuildWorkerAssignment("base", worker);
    assert.match(prompt, /read-only advisory/i);
    assert.match(prompt, /must not edit/i);
    assert.match(prompt, /sole lead/i);
  });
});

describe("Claude Review worker fanout", () => {
  test("plans one canonical dispatch plus bounded duplicate workers for one roster identity", () => {
    const workers = buildClaudeReviewWorkers({
      agent: "claude",
      eligible: true,
      manyHeads: true,
      transport: "oneShot",
      claudeWorkerCount: 3,
      makeTraceId: trace,
    });
    assert.deepEqual(workers.map((worker) => worker.workerId), [
      "claude-review-1",
      "claude-review-2",
      "claude-review-3",
    ]);
    assert.equal(workers.every((worker) => worker.agent === "claude"), true);
    assert.equal(workers.every((worker) => worker.restrictedReadOnly), true);
    assert.deepEqual(workers.map((worker) => worker.manyHeadsDispatch), [false, true, true]);

    const prompt = appendClaudeReviewWorkerAssignment("base", workers[1]!);
    assert.match(prompt, /one Claude roster identity/i);
    assert.match(prompt, /counts once/i);
  });

  test("keeps the legacy reviewer unchanged outside one-shot Many Heads mode", () => {
    const workers = buildClaudeReviewWorkers({
      agent: "claude",
      eligible: true,
      manyHeads: true,
      transport: "terminalBridge",
      claudeWorkerCount: 4,
      makeTraceId: trace,
    });
    assert.equal(workers.length, 1);
    assert.equal(workers[0]?.workerId, "claude");
    assert.equal(workers[0]?.restrictedReadOnly, false);
    assert.equal(workers[0]?.traceIdOverride, undefined);
  });

  test("collapses duplicate verdicts to one fail-closed identity verdict", () => {
    const first = collapseClaudeReviewWorkerVerdicts([
      { workerId: "claude-review-3", approved: true },
      { workerId: "claude-review-1", approved: true },
      { workerId: "claude-review-2", approved: false },
    ]);
    const reordered = collapseClaudeReviewWorkerVerdicts([
      { workerId: "claude-review-2", approved: false },
      { workerId: "claude-review-3", approved: true },
      { workerId: "claude-review-1", approved: true },
    ]);
    assert.deepEqual(first, reordered);
    assert.equal(first.approved, false);
    assert.equal(first.approvals, 2);
    assert.equal(first.total, 3);
    assert.deepEqual(first.dissentingWorkerIds, ["claude-review-2"]);
    assert.equal(collapseClaudeReviewWorkerVerdicts([]).approved, false);
  });
});

describe("restrictClaudeWorkerInvocation", () => {
  test("forces an isolated no-tool Claude invocation despite write-capable configured args", () => {
    const invocation: Invocation = {
      transport: "spawn",
      command: "claude",
      args: [
        "-p",
        "--dangerously-skip-permissions",
        "--permission-mode",
        "acceptEdits",
        "--tools",
        "Bash,Edit,Read",
        "--allowedTools=Write",
        "--add-dir",
        "C:\\repo",
        "--mcp-config",
        "C:\\repo\\.mcp.json",
        "--plugin-url",
        "https://example.invalid/plugin.zip",
        "--worktree",
        "unsafe",
        "--chrome",
        "--",
        "--continue",
        "--permission-prompt-tool",
        "Bash",
        "--system-prompt-file",
        "C:\\repo\\prompt.txt",
        "--output-format",
        "stream-json",
      ],
      stdin: "prompt",
    };

    const restricted = restrictClaudeWorkerInvocation(invocation, "C:\\isolated\\worker-1");
    assert.equal(restricted.transport, "spawn");
    assert.equal(restricted.cwd, "C:\\isolated\\worker-1");
    assert.equal(restricted.disableBrowserBroker, true);
    assert.equal(restricted.args.includes("--dangerously-skip-permissions"), false);
    assert.equal(restricted.args.some((arg) => arg.startsWith("--allowedTools")), false);
    assert.equal(restricted.args.includes("C:\\repo"), false);
    assert.equal(restricted.args.includes("C:\\repo\\.mcp.json"), false);
    assert.equal(restricted.args.includes("https://example.invalid/plugin.zip"), false);
    assert.equal(restricted.args.includes("unsafe"), false);
    assert.equal(restricted.args.includes("--"), false, "an argv terminator must not neutralize appended enforcement flags");
    assert.equal(restricted.args.includes("--continue"), false);
    assert.equal(restricted.args.includes("--permission-prompt-tool"), false);
    assert.equal(restricted.args.includes("--system-prompt-file"), false);
    assert.equal(restricted.args.includes("C:\\repo\\prompt.txt"), false);
    assert.equal(restricted.args.includes("--chrome"), false);
    assert.equal(restricted.args.includes("--no-chrome"), true);
    assert.equal(restricted.args.includes("--disable-slash-commands"), true);
    assert.equal(restricted.args.includes("--strict-mcp-config"), true);
    assert.equal(restricted.args.includes("--no-session-persistence"), true);
    assert.deepEqual(restricted.args.slice(-12), [
      "--permission-mode", "plan",
      "--tools", "",
      "--setting-sources", "local",
      "--strict-mcp-config",
      "--mcp-config", '{"mcpServers":{}}',
      "--disable-slash-commands",
      "--no-session-persistence",
      "--no-chrome",
    ]);
    assert.deepEqual(restricted.args.slice(0, 3), ["-p", "--output-format", "stream-json"]);
  });
});

let workersSeen = 0;
