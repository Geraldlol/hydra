import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { createLiveChannelWriter, liveChannelPath } from "../src/liveChannel";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hydra-live-channel-"));
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

describe("live channel writer", () => {
  test("returns undefined for plain output", () => {
    assert.equal(createLiveChannelWriter({
      workspaceRoot: tempRoot(),
      requestId: "req",
      agent: "claude",
      phase: "opener",
      outputMode: "plain",
    }), undefined);
  });

  test("writes Claude text, task, tool, and done events from split JSONL chunks", async () => {
    const root = tempRoot();
    const writer = createLiveChannelWriter({
      workspaceRoot: root,
      requestId: "turn/1",
      agent: "claude",
      phase: "reactor",
      outputMode: "claudeStreamJson",
    });
    assert.ok(writer);

    const textLine = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
    });
    const taskLine = JSON.stringify({
      type: "system",
      subtype: "task_notification",
      status: "done",
      summary: "checked",
      task_id: "task-1",
      tool_use_id: "tool-1",
      output_file: "C:\\tmp\\task.txt",
    });
    const toolLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool-1", name: "Task" }] },
    });
    const doneLine = JSON.stringify({
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2 },
      total_cost_usd: 0.12,
    });

    writer.push(`${textLine}\n${taskLine.slice(0, 20)}`);
    writer.push(`${taskLine.slice(20)}\n${toolLine}\n${doneLine}`);
    await writer.flush();

    const filePath = liveChannelPath(root, "turn/1", "claude");
    assert.equal(writer.filePath, filePath);
    const records = readJsonl(filePath);
    assert.equal(records.length, 4);
    assert.deepEqual(records.map((r) => r.kind), ["text_delta", "task_notification", "tool_start", "done"]);
    assert.equal((records[0]!.payload as Record<string, unknown>).text, "hello");
    assert.equal((records[1]!.payload as Record<string, unknown>).taskId, "task-1");
    assert.equal((records[1]!.payload as Record<string, unknown>).outputFile, "C:\\tmp\\task.txt");
    assert.equal((records[2]!.payload as Record<string, unknown>).name, "Task");
    assert.equal((records[3]!.payload as Record<string, unknown>).totalCostUsd, 0.12);
  });

  test("writes only unseen Codex agent-message suffixes", async () => {
    const root = tempRoot();
    const writer = createLiveChannelWriter({
      workspaceRoot: root,
      requestId: "req",
      agent: "codex",
      phase: "parallel",
      outputMode: "codexJson",
    });
    assert.ok(writer);

    writer.push(`${JSON.stringify({ type: "item.updated", item: { id: "m1", type: "agent_message", text: "Hel" } })}\n`);
    writer.push(`${JSON.stringify({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "Hello" } })}\n`);
    writer.push(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } })}\n`);
    await writer.flush();

    const records = readJsonl(liveChannelPath(root, "req", "codex"));
    assert.equal(records.length, 3);
    assert.deepEqual(records.map((r) => r.kind), ["text_delta", "text_delta", "usage"]);
    assert.equal((records[0]!.payload as Record<string, unknown>).text, "Hel");
    assert.equal((records[1]!.payload as Record<string, unknown>).text, "lo");
  });

  test("emits a stream_truncated marker instead of silently dropping an oversize partial line", async () => {
    const root = tempRoot();
    const writer = createLiveChannelWriter({
      workspaceRoot: root,
      requestId: "req",
      agent: "claude",
      phase: "opener",
      outputMode: "claudeStreamJson",
    });
    assert.ok(writer);

    // A runaway unterminated line over the 1MB cap: dropped, but visible.
    writer.push("x".repeat(1_000_001));
    await writer.flush();

    const records = readJsonl(liveChannelPath(root, "req", "claude"));
    assert.deepEqual(records.map((r) => r.kind), ["stream_truncated"]);
  });
});
