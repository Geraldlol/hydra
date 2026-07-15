// Incremental live-text extraction from agent CLI JSONL streams.
//
// Turns raw `claude --output-format stream-json` / `codex exec --json` stdout
// chunks into displayable text increments while a call is still running, so
// the webview can stream the reply instead of showing a placeholder until
// completion. Chunks arrive at arbitrary byte boundaries (cp.spawn data
// events, terminal-bridge log polls), so extractors buffer partial lines
// across pushes. The streamed text is cosmetic-only: the authoritative bubble
// content is still the normalized result that replaces it at completion
// (panel.ts onReplaceText / replaceMessageText).

import { parseClaudeEventLine } from "./claudeEvents";
import { parseCodexEventLine, type AgentMessageItem } from "./codexEvents";
import { BoundedLineScanner } from "./fileQueue";

export type LiveTextOutputMode = "plain" | "claudeStreamJson" | "codexJson";

export interface LiveTextExtractor {
  /** Feed a raw stdout chunk; returns displayable text extracted from it ("" if none). */
  push(chunk: string): string;
}

export function createLiveTextExtractor(mode: LiveTextOutputMode): LiveTextExtractor | undefined {
  if (mode === "claudeStreamJson") return new ClaudeLiveTextExtractor();
  if (mode === "codexJson") return new CodexLiveTextExtractor();
  // plain stdout is already displayable; callers forward it untransformed.
  return undefined;
}

// CLI stdout is untrusted (prompt-injectable from repo files), and the
// agents.ts MAX_AGENT_STDOUT_BYTES cap bounds only the accumulated RunResult -
// raw chunks keep flowing to onChunk after result truncation. Both caps below
// keep the live path bounded; dropping text here is safe because the
// normalized reply replaces the streamed text at completion.
const MAX_LIVE_TEXT_CHARS = 2_000_000;
const MAX_PARTIAL_LINE_CHARS = 1_000_000;
const MAX_TRACKED_CODEX_ITEMS = 2_048;
const LIVE_TRUNCATION_MARKER = "\n[Hydra: live stream truncated - full reply arrives at completion]";

// Splits buffered input into complete lines, retaining the trailing partial
// line until its newline arrives in a later push.
abstract class LineBufferedExtractor implements LiveTextExtractor {
  private readonly lines = new BoundedLineScanner({
    maxLineChars: MAX_PARTIAL_LINE_CHARS,
    headLinesPerPush: 3_072,
    tailLinesPerPush: 1_024,
  });
  private emittedChars = 0;
  private capped = false;

  push(chunk: string): string {
    if (this.capped) return "";
    const fragments: string[] = [];
    this.lines.push(chunk, (line) => {
      const extracted = this.extractFromLine(line);
      if (extracted) fragments.push(extracted);
    });
    let out = fragments.join("");
    if (!out) return "";
    this.emittedChars += out.length;
    if (this.emittedChars > MAX_LIVE_TEXT_CHARS) {
      this.capped = true;
      const over = this.emittedChars - MAX_LIVE_TEXT_CHARS;
      out = out.slice(0, Math.max(0, out.length - over)) + LIVE_TRUNCATION_MARKER;
    }
    return out;
  }

  protected abstract extractFromLine(line: string): string;
}

class ClaudeLiveTextExtractor extends LineBufferedExtractor {
  private emittedAny = false;
  private sawTextDelta = false;
  // Why lazy: emitting "\n\n" at message_start would compound with the
  // assistant-fallback separator into a quadruple newline when the next
  // message has no deltas - the separator rides on the next emission instead.
  private pendingSeparator = false;

  protected extractFromLine(line: string): string {
    const event = parseClaudeEventLine(line);
    if (!event) return "";
    if (event.type === "stream_event") {
      const inner = event.event;
      if (!inner || typeof inner !== "object") return "";
      const record = inner as Record<string, unknown>;
      if (record.type === "message_start") {
        // New message: re-arm the assistant-envelope fallback so a later
        // assistant-only message (text materialized without text_delta) is
        // not suppressed by deltas seen in a PRIOR message.
        this.sawTextDelta = false;
        this.pendingSeparator = true;
        return "";
      }
      if (record.type !== "content_block_delta") return "";
      const delta = record.delta;
      if (!delta || typeof delta !== "object") return "";
      const d = delta as Record<string, unknown>;
      if (d.type !== "text_delta" || typeof d.text !== "string") return "";
      this.sawTextDelta = true;
      return this.emit(d.text);
    }
    if (event.type === "assistant") {
      // Fallback for --include-partial-messages off: assistant envelopes are
      // the only text source. When deltas are flowing, the envelope is a
      // duplicate of text already streamed - suppress it.
      if (this.sawTextDelta) return "";
      const message = event.message;
      if (!message || typeof message !== "object") return "";
      const text = assistantText(message as Record<string, unknown>);
      if (!text) return "";
      const emitted = this.emit(text);
      // Consecutive assistant envelopes (no message_start in partial-off
      // mode) are distinct messages - separate the next one.
      this.pendingSeparator = true;
      return emitted;
    }
    return "";
  }

  private emit(text: string): string {
    if (!text) return "";
    const separator = this.pendingSeparator && this.emittedAny ? "\n\n" : "";
    this.pendingSeparator = false;
    this.emittedAny = true;
    return separator + text;
  }
}

function assistantText(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") text += record.text;
  }
  return text;
}

class CodexLiveTextExtractor extends LineBufferedExtractor {
  // Codex item events carry the message's CUMULATIVE text so far, not a
  // delta - emit only the unseen suffix per item id.
  private emittedByItemId = new Map<string, string>();
  private lastItemId: string | undefined;

  protected extractFromLine(line: string): string {
    const event = parseCodexEventLine(line);
    if (!event) return "";
    if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return "";
    const item = event.item;
    if (!item || typeof item !== "object" || item.type !== "agent_message") return "";
    const { id, text } = item as AgentMessageItem;
    if (typeof text !== "string" || typeof id !== "string") return "";
    if (!this.emittedByItemId.has(id) && this.emittedByItemId.size >= MAX_TRACKED_CODEX_ITEMS) {
      const oldest = this.emittedByItemId.keys().next().value as string | undefined;
      if (oldest !== undefined) this.emittedByItemId.delete(oldest);
    }
    const emitted = this.emittedByItemId.get(id) ?? "";
    if (!text.startsWith(emitted)) {
      // The item's text was rewritten rather than extended (shouldn't happen
      // per the wire contract, but never emit a garbled splice if it does).
      return "";
    }
    const suffix = text.slice(emitted.length);
    if (!suffix) return "";
    const separator = this.lastItemId !== undefined && this.lastItemId !== id && emitted === "" ? "\n\n" : "";
    this.emittedByItemId.set(id, text);
    this.lastItemId = id;
    return separator + suffix;
  }
}
