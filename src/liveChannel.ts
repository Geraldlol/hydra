import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseClaudeEventLine } from "./claudeEvents";
import { parseCodexEventLine, type AgentMessageItem } from "./codexEvents";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";
import { serializePerFile } from "./fileQueue";

export type LiveChannelOutputMode = "plain" | "claudeStreamJson" | "codexJson";

export interface LiveChannelWriter {
  /** Feed a raw stdout chunk. Writes are queued asynchronously and never throw from this call. */
  push(chunk: string): void;
  /** Flush queued writes, including a trailing unterminated JSONL line. */
  flush(): Promise<void>;
  readonly filePath: string;
}

export interface LiveChannelWriterArgs {
  workspaceRoot: string;
  requestId: string;
  agent: AgentId;
  phase: Phase;
  outputMode: LiveChannelOutputMode;
}

interface LiveChannelEvent {
  version: 1;
  timestamp: string;
  requestId: string;
  agent: AgentId;
  phase: Phase;
  kind: string;
  payload?: unknown;
}

const MAX_PARTIAL_LINE_CHARS = 1_000_000;
const MAX_PAYLOAD_STRING_CHARS = 20_000;
const TASK_SUBTYPES = new Set(["task_started", "task_updated", "task_progress", "task_summary", "task_notification"]);

export function liveChannelPath(workspaceRoot: string, requestId: string, agent: AgentId): string {
  return path.join(workspaceRoot, ".hydra", "live", safePathSegment(requestId), `${safePathSegment(agent)}.jsonl`);
}

export function createLiveChannelWriter(args: LiveChannelWriterArgs): LiveChannelWriter | undefined {
  if (args.outputMode === "plain") return undefined;
  return args.outputMode === "claudeStreamJson" ? new ClaudeLiveChannelWriter(args) : new CodexLiveChannelWriter(args);
}

abstract class JsonlLiveChannelWriter implements LiveChannelWriter {
  readonly filePath: string;
  private buffer = "";
  private pending: Promise<void> = Promise.resolve();
  private dirEnsured = false;

  protected constructor(private readonly args: LiveChannelWriterArgs) {
    this.filePath = liveChannelPath(args.workspaceRoot, args.requestId, args.agent);
  }

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (this.buffer.length > MAX_PARTIAL_LINE_CHARS) {
      // Why: a single unterminated line over the cap is almost certainly a
      // runaway/garbled stream, not a real JSONL record. Drop it, but emit a
      // marker so readers see the gap instead of silently losing data.
      this.buffer = "";
      this.emit("stream_truncated", { droppedChars: MAX_PARTIAL_LINE_CHARS });
    }
    for (const line of lines) {
      this.processLine(line);
    }
  }

  async flush(): Promise<void> {
    const trailing = this.buffer;
    this.buffer = "";
    if (trailing.trim()) this.processLine(trailing);
    await this.pending;
  }

  protected emit(kind: string, payload?: unknown): void {
    const record: LiveChannelEvent = {
      version: 1,
      timestamp: new Date().toISOString(),
      requestId: this.args.requestId,
      agent: this.args.agent,
      phase: this.args.phase,
      kind,
      ...(payload === undefined ? {} : { payload: boundPayload(payload) }),
    };
    this.pending = this.pending.then(() => this.write(record), () => this.write(record));
  }

  protected abstract processLine(line: string): void;

  private async write(record: LiveChannelEvent): Promise<void> {
    try {
      await serializePerFile(this.filePath, async () => {
        if (!this.dirEnsured) {
          await fs.mkdir(path.dirname(this.filePath), { recursive: true });
          this.dirEnsured = true;
        }
        await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
      });
    } catch {
      // Live channel files are diagnostic/control-plane metadata. A transient
      // .hydra write failure must not fail the agent call itself.
    }
  }
}

class ClaudeLiveChannelWriter extends JsonlLiveChannelWriter {
  constructor(args: LiveChannelWriterArgs) {
    super(args);
  }

  protected processLine(line: string): void {
    const event = parseClaudeEventLine(line);
    if (!event) return;
    if (event.type === "stream_event") {
      const inner = objectRecord(event.event);
      if (!inner) return;
      if (inner.type === "content_block_delta") {
        const delta = objectRecord(inner.delta);
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          this.emit("text_delta", { text: delta.text });
        }
      }
      return;
    }
    if (event.type === "system") {
      const subtype = typeof event.subtype === "string" ? event.subtype : undefined;
      if (subtype && TASK_SUBTYPES.has(subtype)) this.emit(subtype, taskPayload(event));
      return;
    }
    if (event.type === "assistant") {
      for (const tool of assistantToolUses(objectRecord(event.message))) {
        this.emit("tool_start", tool);
      }
      return;
    }
    if (event.type === "result") {
      this.emit("done", {
        subtype: stringField(event, "subtype"),
        stopReason: stringField(event, "stop_reason"),
        totalCostUsd: numberField(event, "total_cost_usd"),
        usage: objectRecord(event.usage),
      });
    }
  }
}

class CodexLiveChannelWriter extends JsonlLiveChannelWriter {
  private emittedByItemId = new Map<string, string>();

  constructor(args: LiveChannelWriterArgs) {
    super(args);
  }

  protected processLine(line: string): void {
    const event = parseCodexEventLine(line);
    if (!event) return;
    if (event.type === "turn.completed") {
      this.emit("usage", { usage: event.usage });
      return;
    }
    if (event.type === "turn.failed") {
      this.emit("error", { message: event.error?.message });
      return;
    }
    if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return;
    const item = event.item;
    if (!item || typeof item !== "object") return;
    if (item.type === "agent_message") {
      const { id, text } = item as AgentMessageItem;
      if (typeof id !== "string" || typeof text !== "string") return;
      const emitted = this.emittedByItemId.get(id) ?? "";
      if (!text.startsWith(emitted)) return;
      const delta = text.slice(emitted.length);
      this.emittedByItemId.set(id, text);
      if (delta) this.emit("text_delta", { itemId: id, text: delta });
    } else if (item.type === "file_change") {
      this.emit("file_change", { itemId: item.id, status: item.status, changes: item.changes });
    } else if (item.type === "command_execution") {
      this.emit("tool_result", { itemId: item.id, status: item.status, exitCode: item.exit_code });
    }
  }
}

function taskPayload(record: Record<string, unknown>): Record<string, unknown> {
  return {
    subtype: stringField(record, "subtype"),
    status: stringField(record, "status"),
    summary: stringField(record, "summary"),
    taskId: stringField(record, "task_id") ?? stringField(record, "taskId"),
    toolUseId: stringField(record, "tool_use_id") ?? stringField(record, "toolUseId"),
    outputFile: stringField(record, "output_file") ?? stringField(record, "outputFile") ?? stringField(record, "output-file"),
  };
}

function assistantToolUses(message: Record<string, unknown> | undefined): Array<Record<string, string | undefined>> {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const tools: Array<Record<string, string | undefined>> = [];
  for (const part of content) {
    const record = objectRecord(part);
    if (record?.type === "tool_use" && typeof record.name === "string") {
      tools.push({ id: stringField(record, "id"), name: record.name });
    }
  }
  return tools;
}

function boundPayload(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, MAX_PAYLOAD_STRING_CHARS);
  if (Array.isArray(value)) return value.slice(0, 100).map(boundPayload);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    out[key] = boundPayload(child);
  }
  return out;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] as string : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] as number : undefined;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown";
}
