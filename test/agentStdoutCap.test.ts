import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  appendBoundedStream,
  BoundedStreamState,
  MAX_AGENT_STDERR_BYTES,
  MAX_AGENT_STDOUT_BYTES,
} from "../src/agents";
import { summarizeClaudeEvents } from "../src/claudeEvents";
import { summarizeCodexEvents } from "../src/codexEvents";

describe("appendBoundedStream", () => {
  test("accepts chunks below the cap unchanged", () => {
    const state: BoundedStreamState = { text: "", truncated: false };
    appendBoundedStream(state, "hello ", 1024, "[trunc]");
    appendBoundedStream(state, "world", 1024, "[trunc]");
    assert.equal(state.truncated, false);
    assert.equal(state.text, "hello world");
  });

  test("truncates exactly at the cap and appends the marker line", () => {
    const state: BoundedStreamState = { text: "", truncated: false };
    const marker = "[trunc-marker]";
    // Send 17 MB total in 4 MB-ish chunks; cap is 16 MB.
    const chunk = "x".repeat(4 * 1024 * 1024);
    for (let i = 0; i < 4; i++) {
      appendBoundedStream(state, chunk, MAX_AGENT_STDOUT_BYTES, marker);
    }
    appendBoundedStream(state, chunk, MAX_AGENT_STDOUT_BYTES, marker);
    assert.equal(state.truncated, true);
    // text is bounded to cap + marker (sandwiched in newlines).
    const maxAllowed = MAX_AGENT_STDOUT_BYTES + marker.length + 2;
    assert.ok(
      state.text.length <= maxAllowed,
      `text grew past cap+marker: ${state.text.length} > ${maxAllowed}`
    );
    assert.ok(state.text.endsWith(`\n${marker}\n`), "marker should be appended");
  });

  test("drops subsequent chunks once truncated", () => {
    const state: BoundedStreamState = { text: "abc", truncated: true };
    appendBoundedStream(state, "MORE", 1024, "[trunc]");
    assert.equal(state.text, "abc");
    assert.equal(state.truncated, true);
  });

  test("stderr cap is tighter than stdout cap", () => {
    assert.ok(MAX_AGENT_STDERR_BYTES < MAX_AGENT_STDOUT_BYTES);
  });

  test("handles tiny caps without underflow when remaining hits zero", () => {
    const state: BoundedStreamState = { text: "abcdef", truncated: false };
    // text already exceeds the cap (6 > 4). The slice math must not produce
    // a negative remaining; the marker still gets appended once.
    appendBoundedStream(state, "ghi", 4, "[t]");
    assert.equal(state.truncated, true);
    assert.ok(state.text.endsWith("\n[t]\n"));
  });
});

describe("summarizer cardinality caps", () => {
  test("Claude summarizer caps distinct envelope types at 256 with overflow bucket", () => {
    const events = [] as Array<ReturnType<typeof JSON.parse>>;
    for (let i = 0; i < 400; i++) {
      events.push({ type: `injected_type_${i}` });
    }
    const summary = summarizeClaudeEvents(events);
    const keys = Object.keys(summary.types);
    assert.ok(keys.length <= 257, `expected <=257 keys, got ${keys.length}`);
    assert.ok("_overflow" in summary.types, "expected _overflow counter");
    assert.ok((summary.types._overflow ?? 0) > 0);
  });

  test("Codex summarizer caps distinct event/item types at 256 with overflow bucket", () => {
    const events = [] as Array<ReturnType<typeof JSON.parse>>;
    for (let i = 0; i < 400; i++) {
      events.push({ type: `injected_event_${i}` });
    }
    const summary = summarizeCodexEvents(events as Parameters<typeof summarizeCodexEvents>[0]);
    const keys = Object.keys(summary.eventCounts);
    assert.ok(keys.length <= 257, `expected <=257 keys, got ${keys.length}`);
    assert.ok("_overflow" in summary.eventCounts, "expected _overflow counter");
  });

  test("Codex summarizer caps distinct item.type values in itemCounts", () => {
    // 400 item.started events each carrying a distinct, attacker-chosen
    // item.type. itemCounts must stay bounded at the 256-key cap plus a single
    // _overflow marker, not balloon to 400 entries.
    const events = [] as Array<ReturnType<typeof JSON.parse>>;
    for (let i = 0; i < 400; i++) {
      events.push({ type: "item.started", item: { id: `i${i}`, type: `injected_item_${i}` } });
    }
    const summary = summarizeCodexEvents(events as Parameters<typeof summarizeCodexEvents>[0]);
    const keys = Object.keys(summary.itemCounts);
    assert.ok(keys.length <= 257, `expected <=257 item keys, got ${keys.length}`);
    assert.ok("_overflow" in summary.itemCounts, "expected _overflow counter in itemCounts");
    assert.ok((summary.itemCounts._overflow ?? 0) > 0);
  });
});

describe("Codex summarizer adversarial item lifecycles", () => {
  test("completed-then-failed for one id resolves latest-wins", () => {
    // Two terminal events for the same command id with conflicting status.
    // The summary tracks items by id, so the LAST event's status must win
    // rather than the first-seen "completed" sticking.
    const events = [
      { type: "item.completed", item: { id: "c1", type: "command_execution", command: "pytest", aggregated_output: "", exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "c1", type: "command_execution", command: "pytest", aggregated_output: "", exit_code: 1, status: "failed" } },
    ] as Array<ReturnType<typeof JSON.parse>>;
    const summary = summarizeCodexEvents(events as Parameters<typeof summarizeCodexEvents>[0]);
    assert.equal(summary.commandExecutions.length, 1);
    const cmd = summary.commandExecutions[0];
    assert.ok(cmd);
    assert.equal(cmd.status, "failed");
    assert.equal(cmd.exitCode, 1);
  });

  test("a string file_change.changes is ignored, not thrown", () => {
    // A poisoned stream sends `changes` as a string instead of an array. The
    // summarizer must not throw on the non-array shape; it leaves changes empty
    // but still records the file_change item and its status.
    const events = [
      { type: "item.completed", item: { id: "fc1", type: "file_change", changes: "not-an-array", status: "completed" } },
    ] as Array<ReturnType<typeof JSON.parse>>;
    const summary = summarizeCodexEvents(events as Parameters<typeof summarizeCodexEvents>[0]);
    assert.equal(summary.fileChanges.length, 1);
    const fc = summary.fileChanges[0];
    assert.ok(fc);
    assert.deepEqual(fc.changes, []);
    assert.equal(fc.status, "completed");
  });
});
