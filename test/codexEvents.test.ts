import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  formatCodexThreadSummary,
  parseCodexEventLine,
  parseCodexEventStream,
  summarizeCodexEvents,
} from "../src/codexEvents";

describe("parseCodexEventLine", () => {
  test("returns null for empty / whitespace lines", () => {
    assert.equal(parseCodexEventLine(""), null);
    assert.equal(parseCodexEventLine("   \t  "), null);
  });

  test("returns null for malformed JSON", () => {
    assert.equal(parseCodexEventLine("{not valid"), null);
  });

  test("returns null for non-objects (arrays, primitives)", () => {
    assert.equal(parseCodexEventLine("[1, 2, 3]"), null);
    assert.equal(parseCodexEventLine("42"), null);
    assert.equal(parseCodexEventLine("\"hello\""), null);
  });

  test("returns null for objects without a string `type`", () => {
    assert.equal(parseCodexEventLine("{\"foo\": 1}"), null);
  });

  test("parses thread.started event", () => {
    const event = parseCodexEventLine('{"type":"thread.started","thread_id":"abc-123"}');
    assert.equal(event?.type, "thread.started");
    if (event?.type === "thread.started") {
      assert.equal(event.thread_id, "abc-123");
    }
  });

  test("parses turn.completed with usage", () => {
    const event = parseCodexEventLine(
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":50,"reasoning_output_tokens":5}}'
    );
    assert.equal(event?.type, "turn.completed");
    if (event?.type === "turn.completed") {
      assert.equal(event.usage.input_tokens, 100);
      assert.equal(event.usage.reasoning_output_tokens, 5);
    }
  });

  test("preserves unknown event types as forward-compatible passthrough", () => {
    const event = parseCodexEventLine('{"type":"future.event","extra":"field"}');
    // Returned but not narrowed to a known variant; type field still present.
    assert.ok(event !== null);
    assert.equal((event as { type: string }).type, "future.event");
  });
});

describe("parseCodexEventStream", () => {
  test("splits CRLF and LF lines, preserves order, marks malformed as null", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t-1"}',
      '{not valid json',
      '{"type":"turn.started"}',
      '',
      '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":0}}',
    ].join("\r\n");
    const events = parseCodexEventStream(stdout);
    assert.equal(events.length, 4);
    assert.equal(events[0]?.type, "thread.started");
    assert.equal(events[1], null);
    assert.equal(events[2]?.type, "turn.started");
    assert.equal(events[3]?.type, "turn.completed");
  });

  test("bounds record floods while preserving thread setup and terminal completion", () => {
    const events = parseCodexEventStream([
      '{"type":"thread.started","thread_id":"t-1"}',
      ...Array.from({ length: 20_100 }, (_, index) =>
        JSON.stringify({ type: "item.updated", item: { id: `r-${index}`, type: "reasoning", text: "" } })),
      '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}',
    ].join("\n"));
    assert.equal(events.length, 20_000);
    assert.equal(events[0]?.type, "thread.started");
    assert.equal(events.at(-1)?.type, "turn.completed");
  });

  test("skips newline-dense padding without losing the final event", () => {
    const events = parseCodexEventStream("\n".repeat(250_000) + '{"type":"turn.failed","error":{"message":"final"}}');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "turn.failed");
  });
});

describe("summarizeCodexEvents", () => {
  test("counts events, items, turns, and parses thread id + usage", () => {
    const events = parseCodexEventStream([
      '{"type":"thread.started","thread_id":"thread-42"}',
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"id":"i1","type":"agent_message","text":"Hello"}}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Hello, world."}}',
      '{"type":"turn.completed","usage":{"input_tokens":300,"cached_input_tokens":100,"output_tokens":40,"reasoning_output_tokens":12}}',
    ].join("\n"));

    const summary = summarizeCodexEvents(events);
    assert.equal(summary.threadId, "thread-42");
    assert.equal(summary.lineCount, 5);
    assert.equal(summary.malformedJsonLines, 0);
    assert.equal(summary.turns.started, 1);
    assert.equal(summary.turns.completed, 1);
    assert.equal(summary.eventCounts["thread.started"], 1);
    assert.equal(summary.eventCounts["item.completed"], 1);
    assert.equal(summary.itemCounts["agent_message"], 1);
    assert.equal(summary.lastAgentMessage, "Hello, world.");
    assert.equal(summary.usage.input_tokens, 300);
    assert.equal(summary.usage.cached_input_tokens, 100);
  });

  test("lastAgentMessage is the last terminal agent_message, not a concatenation", () => {
    // Two distinct agent_message item ids. The contract (mirroring
    // `--output-last-message`) is that the FINAL message's text wins outright —
    // we must not concatenate "First message." + "Second message.".
    // item.started increments the count; item.completed carries the terminal
    // text. The second message's completed text must win.
    const events = parseCodexEventStream([
      '{"type":"item.started","item":{"id":"a1","type":"agent_message","text":"First "}}',
      '{"type":"item.completed","item":{"id":"a1","type":"agent_message","text":"First message."}}',
      '{"type":"item.started","item":{"id":"a2","type":"agent_message","text":"Second "}}',
      '{"type":"item.completed","item":{"id":"a2","type":"agent_message","text":"Second message."}}',
    ].join("\n"));
    const summary = summarizeCodexEvents(events);
    assert.equal(summary.lastAgentMessage, "Second message.");
    assert.equal(summary.itemCounts["agent_message"], 2);
  });

  test("tracks command_execution lifecycle from in_progress to completed", () => {
    const events = parseCodexEventStream([
      '{"type":"item.started","item":{"id":"c1","type":"command_execution","command":"ls -la","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
      '{"type":"item.updated","item":{"id":"c1","type":"command_execution","command":"ls -la","aggregated_output":"file1\\nfile2","exit_code":null,"status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"ls -la","aggregated_output":"file1\\nfile2","exit_code":0,"status":"completed"}}',
    ].join("\n"));

    const summary = summarizeCodexEvents(events);
    assert.equal(summary.commandExecutions.length, 1);
    const cmd = summary.commandExecutions[0];
    assert.ok(cmd);
    assert.equal(cmd.command, "ls -la");
    assert.equal(cmd.status, "completed");
    assert.equal(cmd.exitCode, 0);
  });

  test("collects file_change items with their patch shape", () => {
    const events = parseCodexEventStream([
      '{"type":"item.completed","item":{"id":"fc1","type":"file_change","changes":[{"path":"a.ts","kind":"update"},{"path":"b.ts","kind":"add"}],"status":"completed"}}',
    ].join("\n"));
    const summary = summarizeCodexEvents(events);
    assert.equal(summary.fileChanges.length, 1);
    const fc = summary.fileChanges[0];
    assert.ok(fc);
    assert.equal(fc.changes.length, 2);
    const change0 = fc.changes[0];
    const change1 = fc.changes[1];
    assert.ok(change0);
    assert.ok(change1);
    assert.equal(change0.path, "a.ts");
    assert.equal(change1.kind, "add");
    assert.equal(fc.status, "completed");
  });

  test("tracks mcp_tool_call status and surfaces errors", () => {
    const events = parseCodexEventStream([
      '{"type":"item.started","item":{"id":"m1","type":"mcp_tool_call","server":"memory","tool":"create_entities","arguments":{},"status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"m1","type":"mcp_tool_call","server":"memory","tool":"create_entities","status":"failed","error":{"message":"server is offline"}}}',
    ].join("\n"));
    const summary = summarizeCodexEvents(events);
    assert.equal(summary.mcpToolCalls.length, 1);
    const mcp = summary.mcpToolCalls[0];
    assert.ok(mcp);
    assert.equal(mcp.server, "memory");
    assert.equal(mcp.tool, "create_entities");
    assert.equal(mcp.status, "failed");
    assert.equal(mcp.errorMessage, "server is offline");
  });

  test("collects web search queries on item.started", () => {
    const events = parseCodexEventStream([
      '{"type":"item.started","item":{"id":"ws1","type":"web_search","query":"how to write a deterministic match engine","action":{}}}',
    ].join("\n"));
    const summary = summarizeCodexEvents(events);
    assert.deepEqual(summary.webSearchQueries, ["how to write a deterministic match engine"]);
  });

  test("captures the latest todo list snapshot", () => {
    const events = parseCodexEventStream([
      '{"type":"item.started","item":{"id":"t1","type":"todo_list","items":[{"text":"a","completed":false}]}}',
      '{"type":"item.updated","item":{"id":"t1","type":"todo_list","items":[{"text":"a","completed":true},{"text":"b","completed":false}]}}',
    ].join("\n"));
    const summary = summarizeCodexEvents(events);
    assert.equal(summary.todoList.length, 2);
    const todo0 = summary.todoList[0];
    const todo1 = summary.todoList[1];
    assert.ok(todo0);
    assert.ok(todo1);
    assert.equal(todo0.completed, true);
    assert.equal(todo1.text, "b");
  });

  test("collects errors from turn.failed, item type=error, and stream-level error events", () => {
    const events = parseCodexEventStream([
      '{"type":"turn.failed","error":{"message":"model rejected"}}',
      '{"type":"item.completed","item":{"id":"e1","type":"error","message":"file not found"}}',
      '{"type":"error","message":"connection reset"}',
    ].join("\n"));
    const summary = summarizeCodexEvents(events);
    assert.deepEqual(summary.errors, ["model rejected", "file not found", "connection reset"]);
  });

  test("reports unknown event types in unknownEventTypes without dropping them", () => {
    const events = parseCodexEventStream([
      '{"type":"future.kind","payload":{}}',
    ].join("\n"));
    const summary = summarizeCodexEvents(events);
    assert.equal(summary.unknownEventTypes["future.kind"], 1);
    assert.equal(summary.eventCounts["future.kind"], 1);
  });

  test("counts malformedJsonLines from null entries in the stream", () => {
    const events = parseCodexEventStream("oops not json\n{still bad}\n{\"type\":\"turn.started\"}");
    const summary = summarizeCodexEvents(events);
    assert.equal(summary.malformedJsonLines, 2);
    assert.equal(summary.turns.started, 1);
  });
});

describe("formatCodexThreadSummary", () => {
  test("renders a populated summary as a stable, sectioned block", () => {
    const events = parseCodexEventStream([
      '{"type":"thread.started","thread_id":"thr-1"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"ls","aggregated_output":"","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"fc1","type":"file_change","changes":[{"path":"a.ts","kind":"update"}],"status":"completed"}}',
      '{"type":"item.started","item":{"id":"ws1","type":"web_search","query":"q","action":{}}}',
      '{"type":"item.completed","item":{"id":"a1","type":"agent_message","text":"all done"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":5,"output_tokens":3,"reasoning_output_tokens":1}}',
    ].join("\n"));
    const text = formatCodexThreadSummary(summarizeCodexEvents(events));
    assert.match(text, /^Codex JSON stream summary/);
    assert.match(text, /Thread: thr-1/);
    assert.match(text, /Turns: 1 started, 1 completed/);
    assert.match(text, /Commands: 1/);
    assert.match(text, /\[completed, exit=0\] ls/);
    assert.match(text, /File changes: 1/);
    assert.match(text, /update a\.ts/);
    assert.match(text, /Web searches: 1/);
    assert.match(text, /Last agent message: all done/);
    assert.match(text, /Usage: input=10 \(cached 5\), output=3 \(reasoning 1\)/);
  });

  test("omits empty sections from a minimal summary", () => {
    const text = formatCodexThreadSummary(summarizeCodexEvents([]));
    assert.match(text, /^Codex JSON stream summary/);
    assert.match(text, /Lines: 0/);
    assert.equal(/Commands:/.test(text), false);
    assert.equal(/File changes:/.test(text), false);
    assert.equal(/Usage:/.test(text), false);
  });

  test("flags forward-compat unknown event types in a dedicated line", () => {
    const events = parseCodexEventStream('{"type":"future.kind"}');
    const text = formatCodexThreadSummary(summarizeCodexEvents(events));
    assert.match(text, /Unknown event types \(forward-compat passthrough\): future\.kind/);
  });
});

describe("codexEvents against real codex exec --json output", () => {
  // Captured from `codex exec --json --sandbox read-only` v0.130.0 on
  // 2026-05-10 by scripts/codex-json-probe.js. Locks in the real wire
  // format so a parser regression flips the test, not silently miscount.
  const fixturePath = path.join(__dirname, "fixtures", "codex-exec-json-real.jsonl");
  const stdout = fs.existsSync(fixturePath) ? fs.readFileSync(fixturePath, "utf8") : "";

  test("parses every line cleanly with no malformed JSON", () => {
    assert.ok(stdout.length > 0, "fixture must exist; copy it from a probe run if missing");
    const events = parseCodexEventStream(stdout);
    assert.equal(events.length, 8);
    assert.equal(events.filter((e) => e === null).length, 0);
  });

  test("summary captures thread id, command lifecycle, agent message, and usage", () => {
    const summary = summarizeCodexEvents(parseCodexEventStream(stdout));
    assert.equal(summary.threadId, "019e1380-05d5-76a0-bb6a-84237a3638a7");
    assert.equal(summary.turns.started, 1);
    assert.equal(summary.turns.completed, 1);
    assert.equal(summary.commandExecutions.length, 2);
    assert.ok(summary.commandExecutions.every((cmd) => cmd.status === "completed"));
    assert.ok(summary.commandExecutions.every((cmd) => cmd.exitCode === 0));
    assert.match(summary.lastAgentMessage ?? "", /cwd is .*main/);
    assert.equal(summary.usage.input_tokens, 36303);
    assert.equal(summary.usage.cached_input_tokens, 24320);
    assert.equal(summary.usage.output_tokens, 117);
  });
});
