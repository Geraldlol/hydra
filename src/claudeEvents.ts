// Typed parser and summarizer for `claude --print --output-format stream-json
// --verbose` output.
//
// Mirrors the wire grammar documented in docs/native-internals/wire-protocol.md
// and the bundle code under chunk-0366. Each line of stdout is one JSON object
// with a `type` field; this module gives Hydra a TypeScript contract over that
// shape so callers can consume Claude output structurally instead of
// inspecting raw envelopes inline.
//
// Source pinning:
//   - Outer envelope: 13 types, 11 system subtypes (Fl_ run loop, ~line 394585
//     of chunk-0366 after reformat)
//   - SSE delta types: VV6 dispatcher (~line 3466)
//   - Result subtypes + permission modes: same Fl_ loop
//   - Documented in docs/native-internals/wire-protocol.md
//
// Both `parseClaudeEventLine` and `summarizeClaudeEvents` are total: malformed
// JSON returns null (counted as `malformedJsonLines` in the summary), unknown
// envelope types flow through as forward-compat passthrough so the parser
// doesn't drop events Claude adds in future versions.

// ---------- Outer envelope ----------

export type ClaudeEnvelopeType =
  | "system"
  | "user"
  | "assistant"
  | "result"
  | "stream_event"
  | "keep_alive"
  | "prompt_suggestion"
  | "transcript_mirror"
  | "auth_status"
  | "rate_limit_event"
  | "control_request"
  | "control_response"
  | "control_cancel_request";

export type ClaudeSystemSubtype =
  | "init"
  | "status"
  | "session_state_changed"
  | "task_notification"
  | "task_started"
  | "task_updated"
  | "task_progress"
  | "task_summary"
  | "notification"
  | "post_turn_summary"
  | "compact_boundary"
  | "api_retry"
  | "plugin_install"
  | "elicitation_complete"
  | "hook_started"
  | "hook_progress"
  | "hook_response";

export type ClaudeResultSubtype =
  | "success"
  | "error_during_execution"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "error_max_structured_output_retries";

export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "auto"
  | "dontAsk";

export interface ClaudeEnvelopeBase {
  type: ClaudeEnvelopeType | string;
  uuid?: string;
  session_id?: string;
}

// We don't try to fully type each envelope variant -- the API surface is
// large and many fields are model-dependent. Keep type narrow on the
// discriminator (`type` / `subtype`) and bring in payload fields lazily.
export type ClaudeEvent = ClaudeEnvelopeBase & Record<string, unknown>;

// ---------- Inner SSE delta types ----------

export type ClaudeDeltaType =
  | "text_delta"
  | "citations_delta"
  | "input_json_delta"
  | "thinking_delta"
  | "signature_delta"
  | "compaction_delta";

// ---------- Parser ----------

// Returns null for empty / whitespace lines, malformed JSON, or non-object
// payloads. Returns the parsed event for any object with a string `type`.
// Unknown `type` values still parse so callers preserve forward-compat.
export function parseClaudeEventLine(line: string): ClaudeEvent | null {
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
  if (typeof record.type !== "string") return null;
  return record as ClaudeEvent;
}

export function parseClaudeEventStream(stdout: string): Array<ClaudeEvent | null> {
  // Why: drop whitespace-only lines (CRLF remnants, blank-padded streams)
  // BEFORE they reach the parser, so they don't surface as nulls and inflate
  // `malformedJsonLines`. parseClaudeEventLine trims internally anyway.
  return stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => parseClaudeEventLine(line));
}

// ---------- Summary ----------

export interface ClaudeToolUseRecord {
  name: string;
  id?: string;
}

export interface ClaudeTaskNotificationRecord {
  status?: string;
  summary?: string;
  taskId?: string;
  toolUseId?: string;
}

// Mirrors `YC6` (PERMISSION_DECISION_REASON_TYPES) in the bundle:
// the eleven reason kinds Claude attaches to denied permission checks.
export type ClaudePermissionDecisionReasonType =
  | "rule"
  | "mode"
  | "subcommandResults"
  | "permissionPromptTool"
  | "hook"
  | "asyncAgent"
  | "sandboxOverride"
  | "workingDir"
  | "safetyCheck"
  | "classifier"
  | "other";

export interface ClaudePermissionDenialRecord {
  tool?: string;
  message?: string;
  // `decisionReason.type` from the live envelope, narrowed when recognized.
  reasonType?: ClaudePermissionDecisionReasonType | string;
  // The full decision-reason payload (rule details / mode / safetyCheck
  // reason text etc.) passed through opaquely.
  decisionReason?: unknown;
}

export interface ClaudeUsageSummary {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: unknown;
  iterations?: number;
}

export interface ClaudeStreamSummary {
  lineCount: number;
  malformedJsonLines: number;
  types: Record<string, number>;
  systemSubtypes: Record<string, number>;
  resultSubtype?: ClaudeResultSubtype | string;
  stopReason?: string;
  sessionId?: string;
  permissionDenials: number;
  // Per-denial detail extracted from each `result.permission_denials[]`
  // entry. Lets callers tell rule-denials from sandbox overrides from
  // safety-check classifier denials -- the count alone doesn't.
  permissionDenialRecords: ClaudePermissionDenialRecord[];
  // Per-reason-type bucket counts (rule=N, mode=M, ...). Empty if no
  // denials were recorded.
  permissionDenialsByReason: Record<string, number>;
  // Tool calls observed in assistant messages, in emission order, deduped
  // by `${id}:${name}` so item.started + item.completed pairs collapse to
  // one entry. Mirrors panel.ts's inline collector.
  toolUses: ClaudeToolUseRecord[];
  // Task-notification XML extractions Hydra forwards into the prompt.
  taskNotifications: ClaudeTaskNotificationRecord[];
  // Delta-event counts (from --include-partial-messages stream_event lines).
  streamEvents: Record<string, number>;
  // Last permission-mode value seen in a status update.
  lastPermissionMode?: ClaudePermissionMode | string;
  // Aggregated usage from the terminal result.
  usage?: ClaudeUsageSummary;
  // Authoritative cost from the terminal result, when Claude reports it.
  totalCostUsd?: number;
  // Final assistant text (concatenated from result/result-message paths).
  lastAssistantText?: string;
}

export function summarizeClaudeEvents(events: Array<ClaudeEvent | null>): ClaudeStreamSummary {
  const summary: ClaudeStreamSummary = {
    lineCount: events.length,
    malformedJsonLines: 0,
    types: {},
    systemSubtypes: {},
    permissionDenials: 0,
    permissionDenialRecords: [],
    permissionDenialsByReason: {},
    toolUses: [],
    taskNotifications: [],
    streamEvents: {},
  };

  // Streaming text fallback. When a turn is interrupted before any
  // `result` or fully materialized `assistant` envelope arrives, the only
  // assistant text we have is concatenated text_delta chunks from the
  // partial-message stream. These get rolled in at the end only if
  // lastAssistantText was never set by a higher-fidelity source.
  const deltaTextChunks: string[] = [];

  for (const event of events) {
    if (event === null) {
      summary.malformedJsonLines++;
      continue;
    }
    const type = event.type;
    increment(summary.types, type);
    if (typeof event.session_id === "string") summary.sessionId = event.session_id;
    if (Array.isArray(event.permission_denials)) {
      summary.permissionDenials += event.permission_denials.length;
      for (const raw of event.permission_denials) {
        if (!raw || typeof raw !== "object") continue;
        const denial = raw as Record<string, unknown>;
        const reasonObj = denial.decisionReason && typeof denial.decisionReason === "object"
          ? (denial.decisionReason as Record<string, unknown>)
          : undefined;
        const reasonType = reasonObj && typeof reasonObj.type === "string" ? reasonObj.type : undefined;
        summary.permissionDenialRecords.push({
          tool: typeof denial.tool === "string" ? denial.tool : undefined,
          message: typeof denial.message === "string" ? denial.message : undefined,
          reasonType,
          decisionReason: denial.decisionReason,
        });
        if (reasonType) increment(summary.permissionDenialsByReason, reasonType);
      }
    }

    if (type === "result") {
      if (typeof event.subtype === "string") summary.resultSubtype = event.subtype;
      if (typeof event.stop_reason === "string") summary.stopReason = event.stop_reason;
      if (event.usage && typeof event.usage === "object") summary.usage = event.usage as ClaudeUsageSummary;
      if (typeof event.total_cost_usd === "number" && Number.isFinite(event.total_cost_usd) && event.total_cost_usd >= 0) {
        summary.totalCostUsd = event.total_cost_usd;
      }
      if (typeof event.result === "string") summary.lastAssistantText = event.result;
    } else if (type === "system") {
      const subtype = typeof event.subtype === "string" ? event.subtype : "unknown";
      increment(summary.systemSubtypes, subtype);
      if (subtype === "status" && typeof event.permissionMode === "string") {
        summary.lastPermissionMode = event.permissionMode;
      }
      if (subtype === "task_notification") {
        summary.taskNotifications.push({
          status: stringField(event, "status"),
          summary: stringField(event, "summary"),
          taskId: stringField(event, "task_id") ?? stringField(event, "taskId"),
          toolUseId: stringField(event, "tool_use_id") ?? stringField(event, "toolUseId"),
        });
      }
    } else if (type === "stream_event") {
      const event_ = event.event;
      if (event_ && typeof event_ === "object") {
        const inner = event_ as Record<string, unknown>;
        const innerType = inner.type;
        if (typeof innerType === "string") increment(summary.streamEvents, innerType);
        // text_delta chunks land here under content_block_delta envelopes.
        // Capture for the interrupted-run fallback at end of summarize.
        if (innerType === "content_block_delta") {
          const delta = inner.delta;
          if (delta && typeof delta === "object") {
            const d = delta as Record<string, unknown>;
            if (d.type === "text_delta" && typeof d.text === "string") {
              deltaTextChunks.push(d.text);
            }
          }
        }
      }
    } else if (type === "assistant") {
      const message = event.message;
      if (message && typeof message === "object") {
        collectAssistantToolUses(message as Record<string, unknown>, summary.toolUses);
        const text = extractAssistantText(message as Record<string, unknown>);
        if (text) summary.lastAssistantText = text;
      }
    } else if (type === "user") {
      // user envelopes pass through; we don't extract anything from them
      // beyond what's already in types.
    }
  }

  summary.toolUses = dedupeToolUses(summary.toolUses).slice(0, 100);
  summary.taskNotifications = summary.taskNotifications.slice(-100);
  // Keep the first 100 denials: they capture the initial denial pattern;
  // anything past that is usually the same rule firing repeatedly. The
  // `permissionDenials` counter above stays unbounded so callers still see
  // the true total even after the records array is capped.
  summary.permissionDenialRecords = summary.permissionDenialRecords.slice(0, 100);
  if (!summary.lastAssistantText && deltaTextChunks.length > 0) {
    summary.lastAssistantText = deltaTextChunks.join("");
  }
  return summary;
}

function collectAssistantToolUses(message: Record<string, unknown>, toolUses: ClaudeToolUseRecord[]): void {
  const content = message.content;
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "tool_use" && typeof record.name === "string") {
      toolUses.push({
        name: record.name,
        id: typeof record.id === "string" ? record.id : undefined,
      });
    }
  }
}

function extractAssistantText(message: Record<string, unknown>): string | undefined {
  const content = message.content;
  if (!Array.isArray(content)) return undefined;
  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") chunks.push(record.text);
  }
  return chunks.length > 0 ? chunks.join("") : undefined;
}

function dedupeToolUses(toolUses: ClaudeToolUseRecord[]): ClaudeToolUseRecord[] {
  const seen = new Set<string>();
  const out: ClaudeToolUseRecord[] = [];
  for (const tool of toolUses) {
    const key = `${tool.id ?? ""}:${tool.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tool);
  }
  return out;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? (record[key] as string) : undefined;
}

// Cap distinct keys per bucket. A poisoned stream can otherwise inflate
// `types`, `systemSubtypes`, `streamEvents`, or `permissionDenialsByReason`
// with attacker-chosen labels and balloon the summary object.
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

// ---------- Rendering ----------

export function formatClaudeStreamSummary(summary: ClaudeStreamSummary): string {
  const lines: string[] = ["Claude stream-json summary"];
  if (summary.sessionId) lines.push(`Session: ${summary.sessionId}`);
  lines.push(`Lines: ${summary.lineCount} (${summary.malformedJsonLines} malformed)`);
  if (summary.resultSubtype) {
    const stop = summary.stopReason ? ` (stop_reason=${summary.stopReason})` : "";
    lines.push(`Result: ${summary.resultSubtype}${stop}`);
  }
  if (summary.permissionDenials > 0) {
    const byReason = Object.entries(summary.permissionDenialsByReason)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    const suffix = byReason ? ` (${byReason})` : "";
    lines.push(`Permission denials: ${summary.permissionDenials}${suffix}`);
    for (const denial of summary.permissionDenialRecords.slice(0, 5)) {
      const tool = denial.tool ?? "?";
      const reason = denial.reasonType ?? "?";
      const msg = denial.message ? `: ${truncate(denial.message, 120)}` : "";
      lines.push(`  - [${reason}] ${tool}${msg}`);
    }
    if (summary.permissionDenialRecords.length > 5) {
      lines.push(`  ... ${summary.permissionDenialRecords.length - 5} more`);
    }
  }
  if (summary.lastPermissionMode) lines.push(`Permission mode (last seen): ${summary.lastPermissionMode}`);
  if (Object.keys(summary.types).length) {
    const events = Object.entries(summary.types)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`Envelopes: ${events}`);
  }
  if (Object.keys(summary.systemSubtypes).length) {
    const subtypes = Object.entries(summary.systemSubtypes)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`System subtypes: ${subtypes}`);
  }
  if (Object.keys(summary.streamEvents).length) {
    const inner = Object.entries(summary.streamEvents)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`SSE inner events: ${inner}`);
  }
  if (summary.toolUses.length) {
    lines.push(`Tool uses: ${summary.toolUses.length}`);
    for (const tu of summary.toolUses.slice(0, 10)) {
      lines.push(`  - ${tu.name}${tu.id ? ` (${tu.id})` : ""}`);
    }
    if (summary.toolUses.length > 10) lines.push(`  ... ${summary.toolUses.length - 10} more`);
  }
  if (summary.taskNotifications.length) {
    lines.push(`Task notifications: ${summary.taskNotifications.length}`);
    for (const tn of summary.taskNotifications.slice(0, 5)) {
      lines.push(`  - [${tn.status ?? "?"}] ${truncate(tn.summary ?? "(no summary)", 100)}`);
    }
  }
  if (summary.usage) {
    const u = summary.usage;
    const cache =
      u.cache_creation_input_tokens || u.cache_read_input_tokens
        ? ` (cache creation ${u.cache_creation_input_tokens ?? 0}, cache read ${u.cache_read_input_tokens ?? 0})`
        : "";
    lines.push(`Usage: input=${u.input_tokens}, output=${u.output_tokens}${cache}`);
  }
  if (summary.lastAssistantText) lines.push(`Last assistant text: ${truncate(summary.lastAssistantText, 200)}`);
  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}
