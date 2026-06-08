import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
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
const MAX_TASK_OUTPUT_FILE_BYTES = 64_000;
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
  private processing: Promise<void> = Promise.resolve();
  private pending: Promise<void> = Promise.resolve();
  private dirEnsured = false;

  protected constructor(protected readonly args: LiveChannelWriterArgs) {
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
      this.enqueueLine(line);
    }
  }

  async flush(): Promise<void> {
    const trailing = this.buffer;
    this.buffer = "";
    if (trailing.trim()) this.enqueueLine(trailing);
    await this.processing;
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

  protected abstract processLine(line: string): void | Promise<void>;

  private enqueueLine(line: string): void {
    const run = async () => {
      try {
        await this.processLine(line);
      } catch {
        // Live channel parsing is best-effort. A malformed event or transient
        // task-output read problem should drop only that event.
      }
    };
    this.processing = this.processing.then(run, run);
  }

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

  protected async processLine(line: string): Promise<void> {
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
      if (subtype && TASK_SUBTYPES.has(subtype)) {
        this.emit(subtype, await taskPayload(event, this.args.workspaceRoot));
      }
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

async function taskPayload(record: Record<string, unknown>, workspaceRoot: string): Promise<Record<string, unknown>> {
  const outputFile = stringField(record, "output_file") ?? stringField(record, "outputFile") ?? stringField(record, "output-file");
  const payload: Record<string, unknown> = {
    subtype: stringField(record, "subtype"),
    status: stringField(record, "status"),
    summary: stringField(record, "summary"),
    taskId: stringField(record, "task_id") ?? stringField(record, "taskId"),
    toolUseId: stringField(record, "tool_use_id") ?? stringField(record, "toolUseId"),
    outputFile,
  };
  if (outputFile) Object.assign(payload, await readTaskOutputFile(outputFile, workspaceRoot));
  return payload;
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

async function readTaskOutputFile(filePath: string, workspaceRoot: string): Promise<Record<string, unknown>> {
  const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workspaceRoot, filePath);
  // Fast lexical reject: keeps obviously out-of-bounds (and non-existent) paths
  // returning blocked_path without a filesystem hit.
  if (!isAllowedTaskOutputPath(resolved, workspaceRoot)) {
    return { outputFileReadStatus: "blocked_path" };
  }
  let handle: fs.FileHandle | undefined;
  try {
    // Why: stat/open follow symlinks and Windows junctions, so a forged
    // task_notification could place a link *inside* the workspace or temp dir
    // that targets an out-of-bounds secret. Re-validate against the realpath'd
    // target so the allowlist is enforced on the true on-disk file, not the
    // link — closing the cross-agent exfiltration path the lexical check alone
    // could not. realpath throws on a missing target, which becomes read_error.
    const realTarget = await fs.realpath(resolved);
    if (!(await isRealTaskOutputPathAllowed(realTarget, workspaceRoot))) {
      return { outputFileReadStatus: "blocked_path" };
    }
    const stat = await fs.stat(realTarget);
    if (!stat.isFile()) return { outputFileReadStatus: "not_file" };
    handle = await fs.open(realTarget, "r");
    const buffer = Buffer.alloc(MAX_TASK_OUTPUT_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const sliceLen = Math.min(bytesRead, MAX_TASK_OUTPUT_FILE_BYTES);
    // Why: decode whole UTF-8 code points only — a byte-boundary cut would emit
    // a U+FFFD replacement char. StringDecoder drops a trailing partial sequence.
    const decoded = new StringDecoder("utf8").write(buffer.subarray(0, sliceLen));
    // Why: the emitted payload string is independently re-clamped to
    // MAX_PAYLOAD_STRING_CHARS by boundPayload, so compute the truncation flag
    // against what the reader actually receives — not the larger byte-read cap —
    // or files in the (MAX_PAYLOAD_STRING_CHARS, MAX_TASK_OUTPUT_FILE_BYTES]
    // window would be silently cut while the flag claimed completeness.
    const text = decoded.slice(0, MAX_PAYLOAD_STRING_CHARS);
    const truncated = decoded.length > text.length || stat.size > sliceLen;
    return {
      outputFileReadStatus: "ok",
      outputFileText: text,
      outputFileTruncated: truncated,
    };
  } catch {
    return { outputFileReadStatus: "read_error" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isAllowedTaskOutputPath(candidate: string, workspaceRoot: string): boolean {
  // Claude task output files are produced either in the workspace or in the OS
  // temp dir. Refuse arbitrary absolute paths so a forged task notification
  // cannot make Hydra mirror unrelated local files into .hydra/live.
  return [workspaceRoot, os.tmpdir()].some((root) => isPathInside(candidate, path.resolve(root)));
}

async function isRealTaskOutputPathAllowed(realCandidate: string, workspaceRoot: string): Promise<boolean> {
  // Compare the realpath'd target against realpath'd roots so a symlinked root
  // (e.g. macOS /tmp -> /private/tmp) does not falsely block a legitimate file.
  for (const root of [workspaceRoot, os.tmpdir()]) {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(root);
    } catch {
      realRoot = path.resolve(root);
    }
    if (isPathInside(realCandidate, realRoot)) return true;
  }
  return false;
}

function isPathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeForCompare(candidate);
  const normalizedRoot = normalizeForCompare(root);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown";
}
