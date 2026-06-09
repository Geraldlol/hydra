import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as path from "node:path";
import {
  buildManyHeadsSmokeReport,
  formatManyHeadsSmokeReport,
  isManyHeadsSmokeAgentCall,
  manyHeadsSmokePath,
} from "../src/manyHeadsSmoke";

describe("many heads smoke report", () => {
  test("passes when fanout, completions, live files, task forwarding, and guard evidence are present", () => {
    const report = buildManyHeadsSmokeReport({
      startedAt: "2026-06-09T10:00:00.000Z",
      completedAt: "2026-06-09T10:01:00.000Z",
      prompt: "smoke",
      expectedClaudeWorkers: 2,
      agentCalls: [
        call("codex-1", "started", "codex"),
        call("claude-1", "started", "claude"),
        call("claude-2", "started", "claude"),
        call("codex-1", "completed", "codex", { exitCode: 0 }),
        call("claude-1", "completed", "claude", { exitCode: 0 }),
        call("claude-2", "completed", "claude", { exitCode: 0 }),
      ],
      liveFiles: [
        { requestId: "codex-1", agent: "codex", path: ".hydra/live/codex-1/codex.jsonl", eventCount: 2, taskEventCount: 0 },
        { requestId: "claude-1", agent: "claude", path: ".hydra/live/claude-1/claude.jsonl", eventCount: 3, taskEventCount: 1 },
        { requestId: "claude-2", agent: "claude", path: ".hydra/live/claude-2/claude.jsonl", eventCount: 3, taskEventCount: 1 },
      ],
      forwardedTaskEvents: 2,
    });

    assert.equal(report.passed, true);
    assert.equal(report.observed.claudeStarts, 2);
    assert.equal(report.observed.liveEvents, 8);
    assert.match(formatManyHeadsSmokeReport(report), /Many Heads smoke test passed/);
  });

  test("fails loudly when task events never reach the live channel or webview forwarding path", () => {
    const report = buildManyHeadsSmokeReport({
      startedAt: "2026-06-09T10:00:00.000Z",
      completedAt: "2026-06-09T10:01:00.000Z",
      prompt: "smoke",
      expectedClaudeWorkers: 2,
      agentCalls: [
        call("codex-1", "started", "codex"),
        call("claude-1", "started", "claude"),
        call("claude-2", "started", "claude"),
        call("codex-1", "completed", "codex", { exitCode: 0 }),
        call("claude-1", "completed", "claude", { exitCode: 0 }),
        call("claude-2", "completed", "claude", { exitCode: 0 }),
      ],
      liveFiles: [
        { requestId: "codex-1", agent: "codex", path: ".hydra/live/codex-1/codex.jsonl", eventCount: 2, taskEventCount: 0 },
        { requestId: "claude-1", agent: "claude", path: ".hydra/live/claude-1/claude.jsonl", eventCount: 3, taskEventCount: 0 },
        { requestId: "claude-2", agent: "claude", path: ".hydra/live/claude-2/claude.jsonl", eventCount: 3, taskEventCount: 0 },
      ],
      forwardedTaskEvents: 0,
    });

    assert.equal(report.passed, false);
    assert.equal(report.checks.find((check) => check.name === "claude-task-events-forwarded")?.passed, false);
    assert.match(formatManyHeadsSmokeReport(report), /FAIL claude-task-events-forwarded/);
  });

  test("guards JSONL reads for smoke agent calls", () => {
    assert.equal(manyHeadsSmokePath("/repo"), path.join("/repo", ".hydra", "many-heads-smoke.jsonl"));
    assert.equal(isManyHeadsSmokeAgentCall({ id: "x", event: "started" }), true);
    assert.equal(isManyHeadsSmokeAgentCall({ id: "x" }), false);
  });
});

function call(
  id: string,
  event: string,
  agent: "codex" | "claude",
  extra: { exitCode?: number | null; timedOut?: boolean; cancelled?: boolean } = {}
) {
  return {
    id,
    event,
    timestamp: "2026-06-09T10:00:10.000Z",
    agent,
    phase: "parallel" as const,
    timedOut: false,
    cancelled: false,
    ...extra,
  };
}
