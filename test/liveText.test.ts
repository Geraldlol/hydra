import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { createLiveTextExtractor } from "../src/liveText";

// The live-text extractor turns raw JSONL stdout chunks (claude
// --output-format stream-json / codex exec --json) into displayable text
// increments for the webview while a call is still running. Chunks arrive at
// arbitrary byte boundaries (cp.spawn data events / terminal log polls), so
// the extractor must buffer partial lines across pushes.

function claudeTextDelta(text: string): string {
  return JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  });
}

function claudeAssistant(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
}

function codexAgentMessage(eventType: "item.started" | "item.updated" | "item.completed", id: string, text: string): string {
  return JSON.stringify({ type: eventType, item: { id, type: "agent_message", text } });
}

describe("createLiveTextExtractor", () => {
  test("returns undefined for plain output mode (raw stdout is already displayable)", () => {
    assert.equal(createLiveTextExtractor("plain"), undefined);
  });
});

describe("claude live text extraction", () => {
  test("emits text from a complete text_delta line", () => {
    const extractor = createLiveTextExtractor("claudeStreamJson")!;
    assert.equal(extractor.push(claudeTextDelta("Hello") + "\n"), "Hello");
  });

  test("buffers a JSONL line split across chunk boundaries", () => {
    const extractor = createLiveTextExtractor("claudeStreamJson")!;
    const line = claudeTextDelta("split across chunks") + "\n";
    const cut = Math.floor(line.length / 2);
    const first = extractor.push(line.slice(0, cut));
    const second = extractor.push(line.slice(cut));
    assert.equal(first + second, "split across chunks");
  });

  test("handles CRLF line endings", () => {
    const extractor = createLiveTextExtractor("claudeStreamJson")!;
    assert.equal(extractor.push(claudeTextDelta("a") + "\r\n" + claudeTextDelta("b") + "\r\n"), "ab");
  });

  test("ignores thinking and tool-input deltas", () => {
    const extractor = createLiveTextExtractor("claudeStreamJson")!;
    const thinking = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
    });
    const toolInput = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"cmd\":" } },
    });
    assert.equal(extractor.push(thinking + "\n" + toolInput + "\n"), "");
  });

  test("ignores malformed JSON lines without throwing", () => {
    const extractor = createLiveTextExtractor("claudeStreamJson")!;
    assert.equal(extractor.push("{not json}\n"), "");
    assert.equal(extractor.push(claudeTextDelta("still works") + "\n"), "still works");
  });

  test("falls back to assistant envelope text when no deltas streamed (partial messages off)", () => {
    const extractor = createLiveTextExtractor("claudeStreamJson")!;
    assert.equal(extractor.push(claudeAssistant("First message.") + "\n"), "First message.");
    assert.equal(extractor.push(claudeAssistant("Second message.") + "\n"), "\n\nSecond message.");
  });

  test("suppresses assistant envelope text once deltas have streamed it", () => {
    const extractor = createLiveTextExtractor("claudeStreamJson")!;
    assert.equal(extractor.push(claudeTextDelta("streamed live") + "\n"), "streamed live");
    assert.equal(extractor.push(claudeAssistant("streamed live") + "\n"), "");
  });

  test("separates delta-streamed messages on message_start (separator attaches to the next text)", () => {
    const extractor = createLiveTextExtractor("claudeStreamJson")!;
    const messageStart = JSON.stringify({ type: "stream_event", event: { type: "message_start" } });
    assert.equal(extractor.push(messageStart + "\n"), "");
    assert.equal(extractor.push(claudeTextDelta("interim narration") + "\n"), "interim narration");
    // Why lazy: emitting "\n\n" at message_start would compound with the
    // assistant-fallback separator into a quadruple newline when the next
    // message has no deltas - the separator must ride on the next emission.
    assert.equal(extractor.push(messageStart + "\n"), "");
    assert.equal(extractor.push(claudeTextDelta("final reply") + "\n"), "\n\nfinal reply");
  });

  test("message_start re-arms the assistant-envelope fallback for the next message", () => {
    // Regression: sawTextDelta was sticky across messages, so a later
    // assistant-only message (text materialized without deltas) was dropped
    // from the live stream entirely.
    const extractor = createLiveTextExtractor("claudeStreamJson")!;
    const messageStart = JSON.stringify({ type: "stream_event", event: { type: "message_start" } });
    assert.equal(extractor.push(claudeTextDelta("first via delta") + "\n"), "first via delta");
    assert.equal(extractor.push(messageStart + "\n"), "");
    assert.equal(extractor.push(claudeAssistant("second via envelope") + "\n"), "\n\nsecond via envelope");
  });

  test("caps cumulative live output and stops emitting past the cap", () => {
    // Why: a prompt-injected CLI can flood text_delta events; the live path
    // must stay bounded (the authoritative reply replaces it at completion).
    const extractor = createLiveTextExtractor("claudeStreamJson")!;
    const block = "x".repeat(2000);
    let total = "";
    for (let i = 0; i < 1100; i++) {
      total += extractor.push(claudeTextDelta(block) + "\n");
    }
    assert.ok(total.length <= 2_000_000 + 200, `live output not capped: ${total.length}`);
    assert.match(total, /\[Hydra: live stream truncated/);
    assert.equal(extractor.push(claudeTextDelta("after cap") + "\n"), "");
  });

  test("discards an oversized newline-less partial line instead of buffering it forever", () => {
    // Why: the agents.ts 16MB stdout cap does not bound the extractor's
    // internal partial-line buffer - raw chunks keep flowing to onChunk even
    // after result truncation. An over-cap unterminated line must be dropped,
    // not assembled once its newline finally arrives.
    const extractor = createLiveTextExtractor("claudeStreamJson")!;
    const giant = claudeTextDelta("z".repeat(1_100_000));
    assert.equal(extractor.push(giant.slice(0, 1_050_000)), "");
    assert.equal(extractor.push(giant.slice(1_050_000) + "\n"), "");
    // The poisoned partial line was dropped; a subsequent well-formed line
    // still extracts.
    assert.equal(extractor.push(claudeTextDelta("recovered") + "\n"), "recovered");
  });
});

describe("codex live text extraction", () => {
  test("emits agent_message text from item.completed", () => {
    const extractor = createLiveTextExtractor("codexJson")!;
    assert.equal(extractor.push(codexAgentMessage("item.completed", "m1", "Done.") + "\n"), "Done.");
  });

  test("emits only the new suffix as item.updated grows the same message", () => {
    const extractor = createLiveTextExtractor("codexJson")!;
    assert.equal(extractor.push(codexAgentMessage("item.started", "m1", "Hel") + "\n"), "Hel");
    assert.equal(extractor.push(codexAgentMessage("item.updated", "m1", "Hello wor") + "\n"), "lo wor");
    assert.equal(extractor.push(codexAgentMessage("item.completed", "m1", "Hello world") + "\n"), "ld");
  });

  test("item.completed repeating already-streamed text emits nothing", () => {
    const extractor = createLiveTextExtractor("codexJson")!;
    assert.equal(extractor.push(codexAgentMessage("item.updated", "m1", "complete text") + "\n"), "complete text");
    assert.equal(extractor.push(codexAgentMessage("item.completed", "m1", "complete text") + "\n"), "");
  });

  test("separates distinct agent_message items with a blank line", () => {
    const extractor = createLiveTextExtractor("codexJson")!;
    assert.equal(extractor.push(codexAgentMessage("item.completed", "m1", "First.") + "\n"), "First.");
    assert.equal(extractor.push(codexAgentMessage("item.completed", "m2", "Second.") + "\n"), "\n\nSecond.");
  });

  test("ignores reasoning items and lifecycle events", () => {
    const extractor = createLiveTextExtractor("codexJson")!;
    const reasoning = JSON.stringify({ type: "item.updated", item: { id: "r1", type: "reasoning", text: "thinking..." } });
    const turnStarted = JSON.stringify({ type: "turn.started" });
    assert.equal(extractor.push(reasoning + "\n" + turnStarted + "\n"), "");
  });

  test("buffers split lines across pushes", () => {
    const extractor = createLiveTextExtractor("codexJson")!;
    const line = codexAgentMessage("item.completed", "m1", "split message") + "\n";
    const cut = Math.floor(line.length / 3);
    const out = extractor.push(line.slice(0, cut)) + extractor.push(line.slice(cut));
    assert.equal(out, "split message");
  });
});
