// Typed parser and summarizer for `codex exec --json` output.
//
// Mirrors codex-rs/exec/src/exec_events.rs (Apache-2.0). Each line of stdout
// is one ThreadEvent; this module gives Hydra a TypeScript contract over
// that shape so callers can consume Codex output structurally instead of
// regex-matching free text.
//
// Source pinning:
//   - ThreadEvent + ThreadItem grammar: codex-rs/exec/src/exec_events.rs
//   - Documented in docs/native-internals/codex-wire-protocol.md
//
// Both `parseCodexEventLine` and `summarizeCodexEvents` are total: malformed
// JSON returns null (and is counted in the summary), unknown event types
// flow through as `unknown` items so we don't drop new events the CLI adds
// in future versions.

import { mapBoundedNonEmptyLines } from "./fileQueue";

// ---------- Top-level event grammar ----------

export type ThreadEventType =
  | "thread.started"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "item.started"
  | "item.updated"
  | "item.completed"
  | "error";

export interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export interface ThreadStartedEvent {
  type: "thread.started";
  thread_id: string;
}

export interface TurnStartedEvent {
  type: "turn.started";
}

export interface TurnCompletedEvent {
  type: "turn.completed";
  usage: CodexUsage;
}

export interface TurnFailedEvent {
  type: "turn.failed";
  error: { message: string };
}

export interface ItemStartedEvent {
  type: "item.started";
  item: ThreadItem;
}

export interface ItemUpdatedEvent {
  type: "item.updated";
  item: ThreadItem;
}

export interface ItemCompletedEvent {
  type: "item.completed";
  item: ThreadItem;
}

export interface ThreadErrorEvent {
  type: "error";
  message: string;
}

export type ThreadEvent =
  | ThreadStartedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ItemStartedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent
  | ThreadErrorEvent;

// ---------- Thread item grammar ----------

export type ThreadItemType =
  | "agent_message"
  | "reasoning"
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "collab_tool_call"
  | "web_search"
  | "todo_list"
  | "error";

export type CommandExecutionStatus = "in_progress" | "completed" | "failed" | "declined";
export type PatchApplyStatus = "in_progress" | "completed" | "failed";
export type PatchChangeKind = "add" | "delete" | "update";
export type McpToolCallStatus = "in_progress" | "completed" | "failed";
export type CollabToolCallStatus = "in_progress" | "completed" | "failed";
export type CollabTool = "spawn_agent" | "send_input" | "wait" | "close_agent";
export type CollabAgentStatus =
  | "pending_init"
  | "running"
  | "interrupted"
  | "completed"
  | "errored"
  | "shutdown"
  | "not_found";

export interface AgentMessageItem {
  id: string;
  type: "agent_message";
  text: string;
}

export interface ReasoningItem {
  id: string;
  type: "reasoning";
  text: string;
}

export interface CommandExecutionItem {
  id: string;
  type: "command_execution";
  command: string;
  aggregated_output: string;
  exit_code: number | null;
  status: CommandExecutionStatus;
}

export interface FileUpdateChange {
  path: string;
  kind: PatchChangeKind;
}

export interface FileChangeItem {
  id: string;
  type: "file_change";
  changes: FileUpdateChange[];
  status: PatchApplyStatus;
}

export interface McpToolCallItemResult {
  content: unknown[];
  structured_content?: unknown;
}

export interface McpToolCallItem {
  id: string;
  type: "mcp_tool_call";
  server: string;
  tool: string;
  arguments?: unknown;
  result?: McpToolCallItemResult;
  error?: { message: string };
  status: McpToolCallStatus;
}

export interface CollabAgentState {
  status: CollabAgentStatus;
  message?: string;
}

export interface CollabToolCallItem {
  id: string;
  type: "collab_tool_call";
  tool: CollabTool;
  sender_thread_id: string;
  receiver_thread_ids: string[];
  prompt?: string;
  agents_states: Record<string, CollabAgentState>;
  status: CollabToolCallStatus;
}

export interface WebSearchItem {
  id: string;
  type: "web_search";
  query: string;
  // `action` mirrors codex_protocol::models::WebSearchAction. We keep it
  // opaque so Hydra doesn't have to track WebSearchAction's full shape.
  action: unknown;
}

export interface TodoEntry {
  text: string;
  completed: boolean;
}

export interface TodoListItem {
  id: string;
  type: "todo_list";
  items: TodoEntry[];
}

export interface ThreadErrorItem {
  id: string;
  type: "error";
  message: string;
}

export type ThreadItem =
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | CollabToolCallItem
  | WebSearchItem
  | TodoListItem
  | ThreadErrorItem;

// ---------- Parser ----------

const MAX_CODEX_EVENT_LINE_CHARS = 1_000_000;
const MAX_CODEX_STREAM_RECORDS = 20_000;

// Returns null for empty lines, malformed JSON, or non-object payloads.
// Returns the parsed event for any object with a recognized `type`. Unknown
// `type` values still parse as a generic ThreadEvent so callers can preserve
// forward-compatibility -- the `type` field will just not narrow.
export function parseCodexEventLine(line: string): ThreadEvent | null {
  if (line.length > MAX_CODEX_EVENT_LINE_CHARS) return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (!type) return null;
  return record as unknown as ThreadEvent;
}

// ---------- Summary ----------

export interface CommandExecutionSummary {
  id: string;
  command: string;
  status: CommandExecutionStatus | "unknown";
  exitCode: number | null;
}

export interface FileChangeSummary {
  id: string;
  changes: FileUpdateChange[];
  status: PatchApplyStatus | "unknown";
}

export interface McpToolCallSummary {
  id: string;
  server: string;
  tool: string;
  status: McpToolCallStatus | "unknown";
  errorMessage?: string;
}

export interface CodexThreadSummary {
  threadId?: string;
  lineCount: number;
  malformedJsonLines: number;
  unknownEventTypes: Record<string, number>;
  eventCounts: Record<string, number>;
  itemCounts: Record<string, number>;
  turns: { started: number; completed: number; failed: number };
  // Text of the last terminal agent_message item seen, in stream order: each
  // agent_message item event (started/updated/completed) overwrites this, so
  // the final value is the most recent message's text — NOT a concatenation of
  // all messages. Mirrors how `--output-last-message` behaves (last wins).
  lastAgentMessage?: string;
  // Last reasoning summary, if any.
  lastReasoning?: string;
  commandExecutions: CommandExecutionSummary[];
  fileChanges: FileChangeSummary[];
  mcpToolCalls: McpToolCallSummary[];
  webSearchQueries: string[];
  todoList: TodoEntry[];
  errors: string[];
  usage: CodexUsage;
}

const ZERO_USAGE: CodexUsage = {
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
};

// Roll up a stream of events into the kind of summary Hydra surfaces in
// status / supportBundle / receipts. Mirrors panel.ts's Claude
// stream-summary in shape so a future unifier can speak both.
export function summarizeCodexEvents(events: Array<ThreadEvent | null>): CodexThreadSummary {
  const summary: CodexThreadSummary = {
    lineCount: events.length,
    malformedJsonLines: events.filter((e) => e === null).length,
    unknownEventTypes: {},
    eventCounts: {},
    itemCounts: {},
    turns: { started: 0, completed: 0, failed: 0 },
    commandExecutions: [],
    fileChanges: [],
    mcpToolCalls: [],
    webSearchQueries: [],
    todoList: [],
    errors: [],
    usage: { ...ZERO_USAGE },
  };

  // We track items by id so item.updated and item.completed can mutate the
  // summary in place.
  const commandsById = new Map<string, CommandExecutionSummary>();
  const fileChangesById = new Map<string, FileChangeSummary>();
  const mcpById = new Map<string, McpToolCallSummary>();

  for (const event of events) {
    if (event === null) continue;
    const type = (event as { type?: unknown }).type;
    const typeStr = typeof type === "string" ? type : "";
    if (!typeStr) continue;
    increment(summary.eventCounts, typeStr);

    switch (typeStr) {
      case "thread.started":
        summary.threadId = (event as ThreadStartedEvent).thread_id;
        break;
      case "turn.started":
        summary.turns.started++;
        break;
      case "turn.completed":
        summary.turns.completed++;
        mergeUsage(summary.usage, (event as TurnCompletedEvent).usage);
        break;
      case "turn.failed":
        summary.turns.failed++;
        summary.errors.push((event as TurnFailedEvent).error?.message ?? "turn failed");
        break;
      case "item.started":
      case "item.updated":
      case "item.completed":
        applyItemEvent(event as ItemStartedEvent | ItemUpdatedEvent | ItemCompletedEvent, summary, commandsById, fileChangesById, mcpById);
        break;
      case "error":
        summary.errors.push((event as ThreadErrorEvent).message ?? "stream error");
        break;
      default:
        increment(summary.unknownEventTypes, typeStr);
        break;
    }
  }

  summary.commandExecutions = Array.from(commandsById.values());
  summary.fileChanges = Array.from(fileChangesById.values());
  summary.mcpToolCalls = Array.from(mcpById.values());
  return summary;
}

function applyItemEvent(
  event: ItemStartedEvent | ItemUpdatedEvent | ItemCompletedEvent,
  summary: CodexThreadSummary,
  commandsById: Map<string, CommandExecutionSummary>,
  fileChangesById: Map<string, FileChangeSummary>,
  mcpById: Map<string, McpToolCallSummary>
): void {
  const item = event.item;
  if (!item || typeof item !== "object") return;
  const id = typeof item.id === "string" ? item.id : "";
  const itemType = typeof item.type === "string" ? item.type : "";
  if (!itemType) return;
  if (event.type === "item.started") increment(summary.itemCounts, itemType);

  switch (itemType) {
    case "agent_message":
      summary.lastAgentMessage = (item as AgentMessageItem).text ?? summary.lastAgentMessage;
      break;
    case "reasoning":
      summary.lastReasoning = (item as ReasoningItem).text ?? summary.lastReasoning;
      break;
    case "command_execution": {
      const cmd = item as CommandExecutionItem;
      const existing = commandsById.get(id);
      const next: CommandExecutionSummary = existing ?? {
        id,
        command: cmd.command ?? "",
        status: "unknown",
        exitCode: null,
      };
      if (typeof cmd.command === "string") next.command = cmd.command;
      if (typeof cmd.status === "string") next.status = cmd.status as CommandExecutionStatus;
      if (typeof cmd.exit_code === "number" || cmd.exit_code === null) next.exitCode = cmd.exit_code;
      commandsById.set(id, next);
      break;
    }
    case "file_change": {
      const fc = item as FileChangeItem;
      const next: FileChangeSummary = fileChangesById.get(id) ?? {
        id,
        changes: [],
        status: "unknown",
      };
      if (Array.isArray(fc.changes)) next.changes = fc.changes;
      if (typeof fc.status === "string") next.status = fc.status as PatchApplyStatus;
      fileChangesById.set(id, next);
      break;
    }
    case "mcp_tool_call": {
      const mcp = item as McpToolCallItem;
      const next: McpToolCallSummary = mcpById.get(id) ?? {
        id,
        server: mcp.server ?? "",
        tool: mcp.tool ?? "",
        status: "unknown",
      };
      if (typeof mcp.server === "string") next.server = mcp.server;
      if (typeof mcp.tool === "string") next.tool = mcp.tool;
      if (typeof mcp.status === "string") next.status = mcp.status as McpToolCallStatus;
      if (mcp.error?.message) next.errorMessage = mcp.error.message;
      mcpById.set(id, next);
      break;
    }
    case "web_search":
      if (event.type === "item.started") {
        const ws = item as WebSearchItem;
        if (typeof ws.query === "string") summary.webSearchQueries.push(ws.query);
      }
      break;
    case "todo_list": {
      const todo = item as TodoListItem;
      if (Array.isArray(todo.items)) summary.todoList = todo.items;
      break;
    }
    case "error":
      summary.errors.push((item as ThreadErrorItem).message ?? "item error");
      break;
    default:
      // Unknown item type -- still counted in summary.itemCounts.
      break;
  }
}

function mergeUsage(target: CodexUsage, incoming: CodexUsage | undefined): void {
  if (!incoming) return;
  target.input_tokens += numberOr(incoming.input_tokens, 0);
  target.cached_input_tokens += numberOr(incoming.cached_input_tokens, 0);
  target.output_tokens += numberOr(incoming.output_tokens, 0);
  target.reasoning_output_tokens += numberOr(incoming.reasoning_output_tokens, 0);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Cap distinct keys per bucket. A poisoned stream can otherwise inflate
// `eventCounts`, `itemCounts`, or `unknownEventTypes` with attacker-chosen
// labels and balloon the summary object.
const MAX_DISTINCT_KEYS = 256;

function increment(counts: Record<string, number>, key: string): void {
  if (key in counts) {
    counts[key] = (counts[key] ?? 0) + 1;
    return;
  }
  if (Object.keys(counts).length >= MAX_DISTINCT_KEYS) {
    counts._overflow = (counts._overflow ?? 0) + 1;
    return;
  }
  counts[key] = 1;
}

// Convenience: parse a full stdout blob into ThreadEvents. Skips empty lines
// and counts malformed lines as nulls so summarizeCodexEvents can report
// `malformedJsonLines` honestly.
export function parseCodexEventStream(stdout: string): Array<ThreadEvent | null> {
  // Preserve thread setup from the prefix and favor the newest suffix so a
  // terminal turn.completed/turn.failed event survives intermediate floods.
  return mapBoundedNonEmptyLines(
    stdout,
    parseCodexEventLine,
    () => null,
    {
      maxRecords: MAX_CODEX_STREAM_RECORDS,
      headRecords: 4_000,
      maxLineChars: MAX_CODEX_EVENT_LINE_CHARS,
    },
  );
}

// Render a CodexThreadSummary into a stable, human-readable block. Used by
// support bundles, the effective-authority view, and any future Codex
// receipt panel. The rendering contract is intentionally compact -- one
// line per significant fact -- so it composes well with other status
// fragments.
export function formatCodexThreadSummary(summary: CodexThreadSummary): string {
  const lines: string[] = ["Codex JSON stream summary"];
  if (summary.threadId) lines.push(`Thread: ${summary.threadId}`);
  lines.push(`Lines: ${summary.lineCount} (${summary.malformedJsonLines} malformed)`);
  lines.push(
    `Turns: ${summary.turns.started} started, ${summary.turns.completed} completed, ${summary.turns.failed} failed`
  );
  if (Object.keys(summary.eventCounts).length) {
    const events = Object.entries(summary.eventCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`Events: ${events}`);
  }
  if (Object.keys(summary.itemCounts).length) {
    const items = Object.entries(summary.itemCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`Items: ${items}`);
  }
  if (Object.keys(summary.unknownEventTypes).length) {
    const unknown = Object.keys(summary.unknownEventTypes).join(", ");
    lines.push(`Unknown event types (forward-compat passthrough): ${unknown}`);
  }
  if (summary.commandExecutions.length) {
    lines.push(`Commands: ${summary.commandExecutions.length}`);
    for (const cmd of summary.commandExecutions.slice(0, 5)) {
      lines.push(`  - [${cmd.status}${cmd.exitCode === null ? "" : `, exit=${cmd.exitCode}`}] ${truncate(cmd.command, 120)}`);
    }
    if (summary.commandExecutions.length > 5) lines.push(`  ... ${summary.commandExecutions.length - 5} more`);
  }
  if (summary.fileChanges.length) {
    lines.push(`File changes: ${summary.fileChanges.length}`);
    for (const fc of summary.fileChanges.slice(0, 5)) {
      const paths = fc.changes.map((c) => `${c.kind} ${c.path}`).join(", ");
      lines.push(`  - [${fc.status}] ${truncate(paths, 120)}`);
    }
    if (summary.fileChanges.length > 5) lines.push(`  ... ${summary.fileChanges.length - 5} more`);
  }
  if (summary.mcpToolCalls.length) {
    lines.push(`MCP tool calls: ${summary.mcpToolCalls.length}`);
    for (const m of summary.mcpToolCalls.slice(0, 5)) {
      const error = m.errorMessage ? ` error="${truncate(m.errorMessage, 80)}"` : "";
      lines.push(`  - [${m.status}] ${m.server}/${m.tool}${error}`);
    }
    if (summary.mcpToolCalls.length > 5) lines.push(`  ... ${summary.mcpToolCalls.length - 5} more`);
  }
  if (summary.webSearchQueries.length) {
    lines.push(`Web searches: ${summary.webSearchQueries.length}`);
    for (const q of summary.webSearchQueries.slice(0, 3)) {
      lines.push(`  - ${truncate(q, 120)}`);
    }
  }
  if (summary.todoList.length) {
    const done = summary.todoList.filter((t) => t.completed).length;
    lines.push(`Todo list: ${done}/${summary.todoList.length} complete`);
  }
  if (summary.errors.length) {
    lines.push(`Errors: ${summary.errors.length}`);
    for (const err of summary.errors.slice(0, 3)) {
      lines.push(`  - ${truncate(err, 200)}`);
    }
  }
  if (summary.lastReasoning) lines.push(`Last reasoning: ${truncate(summary.lastReasoning, 200)}`);
  if (summary.lastAgentMessage) lines.push(`Last agent message: ${truncate(summary.lastAgentMessage, 200)}`);
  const u = summary.usage;
  if (u.input_tokens || u.output_tokens || u.cached_input_tokens || u.reasoning_output_tokens) {
    lines.push(
      `Usage: input=${u.input_tokens} (cached ${u.cached_input_tokens}), output=${u.output_tokens} (reasoning ${u.reasoning_output_tokens})`
    );
  }
  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}
