import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { createLiveChannelWriter, liveChannelPath, readTaskOutputFileForTests } from "../src/liveChannel";

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
    const taskOutputPath = path.join(root, "task-output.txt");
    fs.writeFileSync(taskOutputPath, "subagent result");
    const observed: string[] = [];
    const writer = createLiveChannelWriter({
      workspaceRoot: root,
      requestId: "turn/1",
      agent: "claude",
      phase: "reactor",
      outputMode: "claudeStreamJson",
      onEvent: (event) => observed.push(event.kind),
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
      output_file: taskOutputPath,
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
    assert.deepEqual(observed, ["text_delta", "task_notification", "tool_start", "done"]);
    assert.equal((records[0]!.payload as Record<string, unknown>).text, "hello");
    assert.equal((records[1]!.payload as Record<string, unknown>).taskId, "task-1");
    assert.equal((records[1]!.payload as Record<string, unknown>).outputFile, taskOutputPath);
    assert.equal((records[1]!.payload as Record<string, unknown>).outputFileReadStatus, "ok");
    assert.equal((records[1]!.payload as Record<string, unknown>).outputFileText, "subagent result");
    assert.equal((records[1]!.payload as Record<string, unknown>).outputFileTruncated, false);
    assert.equal((records[2]!.payload as Record<string, unknown>).name, "Task");
    assert.equal((records[3]!.payload as Record<string, unknown>).totalCostUsd, 0.12);
  });

  test("bounds inlined Claude task output-file content", async () => {
    const root = tempRoot();
    const taskOutputPath = path.join(root, "task-output.txt");
    fs.writeFileSync(taskOutputPath, "x".repeat(70_000));
    const writer = createLiveChannelWriter({
      workspaceRoot: root,
      requestId: "req",
      agent: "claude",
      phase: "parallel",
      outputMode: "claudeStreamJson",
    });
    assert.ok(writer);

    writer.push(`${JSON.stringify({
      type: "system",
      subtype: "task_notification",
      status: "done",
      output_file: taskOutputPath,
    })}\n`);
    await writer.flush();

    const payload = readJsonl(liveChannelPath(root, "req", "claude"))[0]!.payload as Record<string, unknown>;
    assert.equal(payload.outputFileReadStatus, "ok");
    assert.equal(typeof payload.outputFileText, "string");
    assert.equal((payload.outputFileText as string).length, 20_000);
    assert.equal(payload.outputFileTruncated, true);
  });

  test("does not inline Claude task output-file paths outside workspace or temp", async () => {
    const root = tempRoot();
    const parsed = path.parse(root);
    const outside = path.join(parsed.root, "hydra-live-channel-blocked-secret.txt");
    const writer = createLiveChannelWriter({
      workspaceRoot: root,
      requestId: "req",
      agent: "claude",
      phase: "parallel",
      outputMode: "claudeStreamJson",
    });
    assert.ok(writer);

    writer.push(`${JSON.stringify({
      type: "system",
      subtype: "task_notification",
      status: "done",
      output_file: outside,
    })}\n`);
    await writer.flush();

    const payload = readJsonl(liveChannelPath(root, "req", "claude"))[0]!.payload as Record<string, unknown>;
    assert.equal(payload.outputFile, outside);
    assert.equal(payload.outputFileReadStatus, "blocked_path");
    assert.equal(payload.outputFileText, undefined);
  });

  test("flags truncation for task output between the payload clamp and the read cap", async () => {
    // Why: the emitted text is re-clamped to MAX_PAYLOAD_STRING_CHARS (20_000)
    // by boundPayload, below the 64_000-byte read cap. A file in that window
    // must report outputFileTruncated:true so the reader is not told a clamped
    // payload is complete. Before the fix this asserted false.
    const root = tempRoot();
    const taskOutputPath = path.join(root, "mid.txt");
    fs.writeFileSync(taskOutputPath, "x".repeat(50_000));
    const writer = createLiveChannelWriter({
      workspaceRoot: root,
      requestId: "req",
      agent: "claude",
      phase: "parallel",
      outputMode: "claudeStreamJson",
    });
    assert.ok(writer);

    writer.push(`${JSON.stringify({
      type: "system",
      subtype: "task_notification",
      status: "done",
      output_file: taskOutputPath,
    })}\n`);
    await writer.flush();

    const payload = readJsonl(liveChannelPath(root, "req", "claude"))[0]!.payload as Record<string, unknown>;
    assert.equal(payload.outputFileReadStatus, "ok");
    assert.equal((payload.outputFileText as string).length, 20_000);
    assert.equal(payload.outputFileTruncated, true);
  });

  test("does not inline through a symlink whose target escapes the allowed roots", async () => {
    // Why: stat/open follow symlinks, so a forged task_notification could place
    // a link inside the workspace that points outside it. The realpath re-check
    // must block it. The repo's package.json is a stable file outside both the
    // temp workspace and os.tmpdir().
    const root = tempRoot();
    const linkPath = path.join(root, "leak.txt");
    const escapeTarget = path.join(process.cwd(), "package.json");
    try {
      fs.symlinkSync(escapeTarget, linkPath, "file");
    } catch (err) {
      // Windows requires privilege/developer mode to create symlinks; skip there.
      if ((err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    }
    const writer = createLiveChannelWriter({
      workspaceRoot: root,
      requestId: "req",
      agent: "claude",
      phase: "parallel",
      outputMode: "claudeStreamJson",
    });
    assert.ok(writer);

    writer.push(`${JSON.stringify({
      type: "system",
      subtype: "task_notification",
      status: "done",
      output_file: linkPath,
    })}\n`);
    await writer.flush();

    const payload = readJsonl(liveChannelPath(root, "req", "claude"))[0]!.payload as Record<string, unknown>;
    assert.equal(payload.outputFileReadStatus, "blocked_path");
    assert.equal(payload.outputFileText, undefined);
  });

  test("refuses a deterministic task-output replacement between lstat and open", async () => {
    const root = tempRoot();
    const target = path.join(root, "task-output.txt");
    const oldPath = path.join(root, "task-output.old.txt");
    const replacement = path.join(root, "replacement.txt");
    fs.writeFileSync(target, "expected");
    fs.writeFileSync(replacement, "must-not-be-read");

    const payload = await readTaskOutputFileForTests(target, root, () => {
      fs.renameSync(target, oldPath);
      fs.renameSync(replacement, target);
    });

    assert.equal(payload.outputFileReadStatus, "blocked_path");
    assert.equal(payload.outputFileText, undefined);
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

  test("bounds newline-dense chunks without promise-per-line amplification and retains done", async () => {
    const root = tempRoot();
    const writer = createLiveChannelWriter({
      workspaceRoot: root,
      requestId: "dense",
      agent: "claude",
      phase: "opener",
      outputMode: "claudeStreamJson",
    });
    assert.ok(writer);
    writer.push("\n".repeat(100_000) + JSON.stringify({
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
    }) + "\n");
    await writer.flush();

    const records = readJsonl(liveChannelPath(root, "dense", "claude"));
    assert.equal(records[0]!.kind, "stream_truncated");
    assert.equal(records.at(-1)!.kind, "done");
  });
});
