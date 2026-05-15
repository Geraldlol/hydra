import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  formatClaudeStreamSummary,
  parseClaudeEventLine,
  parseClaudeEventStream,
  summarizeClaudeEvents,
} from "../src/claudeEvents";

describe("parseClaudeEventLine", () => {
  test("returns null for empty / whitespace lines", () => {
    assert.equal(parseClaudeEventLine(""), null);
    assert.equal(parseClaudeEventLine("   \t  "), null);
  });

  test("returns null for malformed JSON", () => {
    assert.equal(parseClaudeEventLine("{not valid"), null);
  });

  test("returns null for non-objects", () => {
    assert.equal(parseClaudeEventLine("[1,2]"), null);
    assert.equal(parseClaudeEventLine("42"), null);
  });

  test("returns null for objects without a string `type`", () => {
    assert.equal(parseClaudeEventLine('{"subtype":"status"}'), null);
  });

  test("parses a system status envelope", () => {
    const event = parseClaudeEventLine(
      '{"type":"system","subtype":"status","permissionMode":"acceptEdits","session_id":"s1","uuid":"u1"}'
    );
    assert.equal(event?.type, "system");
    assert.equal(event?.session_id, "s1");
    assert.equal(event?.uuid, "u1");
  });

  test("preserves unknown envelope types as forward-compat passthrough", () => {
    const event = parseClaudeEventLine('{"type":"future.thing","payload":1}');
    assert.equal(event?.type, "future.thing");
  });
});

describe("parseClaudeEventStream", () => {
  test("splits LF/CRLF and counts blanks as removed", () => {
    const stdout = [
      '{"type":"system","subtype":"status","session_id":"s1"}',
      "",
      '{"type":"user","session_id":"s1","message":{"role":"user","content":"hi"}}',
      '{not valid}',
    ].join("\r\n");
    const events = parseClaudeEventStream(stdout);
    assert.equal(events.length, 3);
    assert.equal(events[0]?.type, "system");
    assert.equal(events[1]?.type, "user");
    assert.equal(events[2], null);
  });
});

describe("summarizeClaudeEvents", () => {
  test("collects type counts, system subtypes, session id, and permission mode", () => {
    const events = parseClaudeEventStream(
      [
        '{"type":"system","subtype":"status","permissionMode":"acceptEdits","session_id":"sess-1","uuid":"u-1"}',
        '{"type":"system","subtype":"task_started","session_id":"sess-1","uuid":"u-2"}',
        '{"type":"system","subtype":"status","permissionMode":"plan","session_id":"sess-1","uuid":"u-3"}',
      ].join("\n")
    );
    const summary = summarizeClaudeEvents(events);
    assert.equal(summary.sessionId, "sess-1");
    assert.equal(summary.types.system, 3);
    assert.equal(summary.systemSubtypes.status, 2);
    assert.equal(summary.systemSubtypes.task_started, 1);
    assert.equal(summary.lastPermissionMode, "plan");
  });

  test("extracts tool_use blocks from assistant messages", () => {
    const events = parseClaudeEventStream(
      [
        '{"type":"assistant","session_id":"s","message":{"role":"assistant","content":[{"type":"text","text":"thinking"},{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}]}}',
        '{"type":"assistant","session_id":"s","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_2","name":"Read","input":{"file_path":"/x"}}]}}',
      ].join("\n")
    );
    const summary = summarizeClaudeEvents(events);
    assert.equal(summary.toolUses.length, 2);
    assert.equal(summary.toolUses[0].name, "Bash");
    assert.equal(summary.toolUses[0].id, "tu_1");
    assert.equal(summary.toolUses[1].name, "Read");
  });

  test("dedupes identical (id, name) tool-use entries across envelopes", () => {
    const dup =
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_x","name":"Edit"}]}}';
    const events = parseClaudeEventStream([dup, dup].join("\n"));
    const summary = summarizeClaudeEvents(events);
    assert.equal(summary.toolUses.length, 1);
  });

  test("captures task notifications from system subtype task_notification", () => {
    const events = parseClaudeEventStream(
      '{"type":"system","subtype":"task_notification","task_id":"t-1","tool_use_id":"tu-1","status":"completed","summary":"all good","session_id":"s","uuid":"u"}'
    );
    const summary = summarizeClaudeEvents(events);
    assert.equal(summary.taskNotifications.length, 1);
    assert.equal(summary.taskNotifications[0].taskId, "t-1");
    assert.equal(summary.taskNotifications[0].toolUseId, "tu-1");
    assert.equal(summary.taskNotifications[0].status, "completed");
    assert.equal(summary.taskNotifications[0].summary, "all good");
  });

  test("counts SSE inner event types from stream_event envelopes", () => {
    const events = parseClaudeEventStream(
      [
        '{"type":"stream_event","event":{"type":"message_start","message":{}}}',
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}}',
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}}',
      ].join("\n")
    );
    const summary = summarizeClaudeEvents(events);
    assert.equal(summary.streamEvents.message_start, 1);
    assert.equal(summary.streamEvents.content_block_delta, 2);
  });

  test("captures result subtype, stop_reason, usage, and final text", () => {
    const events = parseClaudeEventStream(
      '{"type":"result","subtype":"success","stop_reason":"end_turn","is_error":false,"usage":{"input_tokens":100,"output_tokens":40,"cache_creation_input_tokens":5,"cache_read_input_tokens":10},"result":"final answer text","session_id":"s","uuid":"u"}'
    );
    const summary = summarizeClaudeEvents(events);
    assert.equal(summary.resultSubtype, "success");
    assert.equal(summary.stopReason, "end_turn");
    assert.equal(summary.usage?.input_tokens, 100);
    assert.equal(summary.usage?.cache_read_input_tokens, 10);
    assert.equal(summary.lastAssistantText, "final answer text");
  });

  test("sums permission_denials arrays across envelopes", () => {
    const events = parseClaudeEventStream(
      [
        '{"type":"result","subtype":"success","permission_denials":[{"tool":"Bash"},{"tool":"Edit"}]}',
        '{"type":"result","subtype":"success","permission_denials":[{"tool":"Write"}]}',
      ].join("\n")
    );
    const summary = summarizeClaudeEvents(events);
    assert.equal(summary.permissionDenials, 3);
    assert.equal(summary.permissionDenialRecords.length, 3);
    assert.equal(summary.permissionDenialRecords[0].tool, "Bash");
    // No decisionReason was present so reason-bucket counts stay empty.
    assert.deepEqual(summary.permissionDenialsByReason, {});
  });

  test("buckets permission denials by decisionReason.type", () => {
    const events = parseClaudeEventStream(
      [
        '{"type":"result","subtype":"success","permission_denials":[' +
          '{"tool":"Bash","message":"blocked by mode","decisionReason":{"type":"mode","mode":"dontAsk"}},' +
          '{"tool":"Edit","decisionReason":{"type":"rule","rule":{"ruleBehavior":"deny"}}},' +
          '{"tool":"WebFetch","decisionReason":{"type":"sandboxOverride"}},' +
          '{"tool":"Bash","decisionReason":{"type":"safetyCheck","reason":"Dangerous rm operation"}}' +
        ']}',
      ].join("\n")
    );
    const summary = summarizeClaudeEvents(events);
    assert.equal(summary.permissionDenials, 4);
    assert.deepEqual(summary.permissionDenialsByReason, {
      mode: 1,
      rule: 1,
      sandboxOverride: 1,
      safetyCheck: 1,
    });
    assert.equal(summary.permissionDenialRecords[0].reasonType, "mode");
    assert.equal(summary.permissionDenialRecords[0].message, "blocked by mode");
    assert.equal(summary.permissionDenialRecords[3].reasonType, "safetyCheck");
    // Raw decisionReason is preserved for callers that need rule details.
    assert.deepEqual(summary.permissionDenialRecords[1].decisionReason, {
      type: "rule",
      rule: { ruleBehavior: "deny" },
    });
  });

  test("caps permissionDenialRecords at 100 while preserving the total count", () => {
    // Spread 150 denials across three envelopes (50 each) to exercise the
    // cross-envelope accumulation path. Each denial carries a synthetic
    // index in its tool name so we can verify which records survived.
    const makeEnvelope = (start: number, count: number): string => {
      const denials = Array.from({ length: count }, (_, i) => {
        const idx = start + i;
        return `{"tool":"Tool${idx}","decisionReason":{"type":"rule"}}`;
      }).join(",");
      return `{"type":"result","subtype":"success","permission_denials":[${denials}]}`;
    };
    const rawJsonl = [makeEnvelope(0, 50), makeEnvelope(50, 50), makeEnvelope(100, 50)].join("\n");
    const summary = summarizeClaudeEvents(parseClaudeEventStream(rawJsonl));

    // The records array is capped at 100; the counter still reports the true total.
    assert.equal(summary.permissionDenialRecords.length, 100);
    assert.equal(summary.permissionDenials, 150);
    // We keep the first 100 (initial pattern), not the last 100.
    assert.equal(summary.permissionDenialRecords[0].tool, "Tool0");
    assert.equal(summary.permissionDenialRecords[99].tool, "Tool99");
    // The by-reason buckets still reflect every denial seen.
    assert.equal(summary.permissionDenialsByReason.rule, 150);
  });

  test("formatClaudeStreamSummary surfaces permission denial breakdown", () => {
    const events = parseClaudeEventStream(
      '{"type":"result","subtype":"success","permission_denials":[' +
        '{"tool":"Bash","message":"Dangerous rm","decisionReason":{"type":"safetyCheck"}},' +
        '{"tool":"Edit","decisionReason":{"type":"rule"}}' +
      ']}'
    );
    const text = formatClaudeStreamSummary(summarizeClaudeEvents(events));
    assert.match(text, /Permission denials: 2 \(.*safetyCheck=1.*rule=1|rule=1.*safetyCheck=1/);
    assert.match(text, /\[safetyCheck\] Bash: Dangerous rm/);
    assert.match(text, /\[rule\] Edit/);
  });

  test("counts malformedJsonLines from null entries", () => {
    const events = parseClaudeEventStream("oops\n{still bad}\n{\"type\":\"keep_alive\"}");
    const summary = summarizeClaudeEvents(events);
    assert.equal(summary.malformedJsonLines, 2);
    assert.equal(summary.types.keep_alive, 1);
  });
});

describe("formatClaudeStreamSummary", () => {
  test("renders a populated summary with each section", () => {
    const events = parseClaudeEventStream(
      [
        '{"type":"system","subtype":"status","permissionMode":"acceptEdits","session_id":"sess","uuid":"u1"}',
        '{"type":"stream_event","event":{"type":"message_start","message":{}}}',
        '{"type":"assistant","session_id":"sess","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Bash"}]}}',
        '{"type":"result","subtype":"success","stop_reason":"end_turn","usage":{"input_tokens":50,"output_tokens":20},"result":"done","session_id":"sess","uuid":"u2"}',
      ].join("\n")
    );
    const text = formatClaudeStreamSummary(summarizeClaudeEvents(events));
    assert.match(text, /^Claude stream-json summary/);
    assert.match(text, /Session: sess/);
    assert.match(text, /Lines: 4 \(0 malformed\)/);
    assert.match(text, /Result: success \(stop_reason=end_turn\)/);
    assert.match(text, /Permission mode \(last seen\): acceptEdits/);
    assert.match(text, /SSE inner events: message_start=1/);
    assert.match(text, /Tool uses: 1/);
    assert.match(text, /- Bash \(tu1\)/);
    assert.match(text, /Usage: input=50, output=20/);
    assert.match(text, /Last assistant text: done/);
  });

  test("omits empty sections from an empty summary", () => {
    const text = formatClaudeStreamSummary(summarizeClaudeEvents([]));
    assert.match(text, /^Claude stream-json summary/);
    assert.match(text, /Lines: 0/);
    assert.equal(/Tool uses:/.test(text), false);
    assert.equal(/Usage:/.test(text), false);
    assert.equal(/Result:/.test(text), false);
  });
});

describe("claudeEvents against real claude --print stream-json output", () => {
  // Captured from `claude -p --permission-mode plan --output-format stream-json
  // --verbose` against v2.1.138 on 2026-05-10. Six lines covering:
  //   - hook_started / hook_response (SessionStart hook firing)
  //   - system / init (boot envelope with cwd, tools, model, permission mode)
  //   - assistant message containing a text block
  //   - rate_limit_event (allowed status, five_hour bucket)
  //   - result success with usage and permission_denials
  // The hook_response payload is redacted -- live skill-injection content
  // shouldn't ride in fixtures.
  const fixturePath = path.join(__dirname, "fixtures", "claude-stream-json-real.jsonl");
  const stdout = fs.existsSync(fixturePath) ? fs.readFileSync(fixturePath, "utf8") : "";

  test("parses every line cleanly with no malformed JSON", () => {
    assert.ok(stdout.length > 0, "fixture must exist; capture from a stream-json run if missing");
    const events = parseClaudeEventStream(stdout);
    assert.equal(events.length, 13);
    assert.equal(events.filter((e) => e === null).length, 0);
  });

  test("summary captures session id, init metadata, result, usage, and final text", () => {
    if (!stdout) return;
    const summary = summarizeClaudeEvents(parseClaudeEventStream(stdout));
    assert.equal(summary.sessionId, "72fcac0e-ed56-4595-ba64-d1187b99484d");
    assert.equal(summary.types.system, 4);
    assert.equal(summary.types.stream_event, 6);
    assert.equal(summary.types.assistant, 1);
    assert.equal(summary.types.rate_limit_event, 1);
    assert.equal(summary.types.result, 1);
    // hook_started, hook_response, init, status are all captured. `init` is
    // a real subtype the bundle emits; documented in ClaudeSystemSubtype.
    assert.equal(summary.systemSubtypes.hook_started, 1);
    assert.equal(summary.systemSubtypes.hook_response, 1);
    assert.equal(summary.systemSubtypes.init, 1);
    assert.equal(summary.systemSubtypes.status, 1);
    assert.equal(summary.resultSubtype, "success");
    assert.equal(summary.stopReason, "end_turn");
    assert.equal(summary.usage?.input_tokens, 6);
    assert.equal(summary.usage?.cache_creation_input_tokens, 19089);
    assert.equal(summary.usage?.cache_read_input_tokens, 20863);
    // The result envelope's `result` text wins as the final assistant text.
    assert.equal(summary.lastAssistantText, "ready");
    // permission_denials was an empty array
    assert.equal(summary.permissionDenials, 0);
  });

  test("captures all six SSE inner content_block_delta event types", () => {
    if (!stdout) return;
    const summary = summarizeClaudeEvents(parseClaudeEventStream(stdout));
    // The six message-level / content-block lifecycle events from a single
    // streamed assistant turn. These are the exact event names the
    // Anthropic Messages API SSE grammar defines, captured live -- a
    // future Claude release that drops or renames any of them will flip
    // this assertion.
    assert.equal(summary.streamEvents.message_start, 1);
    assert.equal(summary.streamEvents.content_block_start, 1);
    assert.equal(summary.streamEvents.content_block_delta, 1);
    assert.equal(summary.streamEvents.content_block_stop, 1);
    assert.equal(summary.streamEvents.message_delta, 1);
    assert.equal(summary.streamEvents.message_stop, 1);
  });
});
