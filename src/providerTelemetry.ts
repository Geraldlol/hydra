import { createHash } from "node:crypto";

export type FlightTelemetryProvider = "codex" | "claude";
export type ProviderToolCategory =
  | "shell"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "browser"
  | "mcp"
  | "collaboration"
  | "other";

export type ProviderTelemetryObservation =
  | {
      readonly observationType: "providerLifecycle";
      readonly provider: FlightTelemetryProvider;
      readonly stage: "turnStarted" | "turnFinished";
      readonly status: "started" | "succeeded" | "failed";
      readonly evidenceClass: "providerObserved";
    }
  | {
      readonly observationType: "providerToolStarted";
      readonly provider: FlightTelemetryProvider;
      readonly providerOperationIdSha256: string;
      readonly toolCategory: ProviderToolCategory;
      readonly argumentBytes: number;
      readonly evidenceClass: "providerObserved";
    }
  | {
      readonly observationType: "providerToolFinished";
      readonly provider: FlightTelemetryProvider;
      readonly providerOperationIdSha256: string;
      readonly toolCategory: ProviderToolCategory;
      readonly status: "succeeded" | "failed" | "unknown";
      readonly resultBytes: number;
      readonly evidenceClass: "providerObserved";
    }
  | {
      readonly observationType: "providerEditBatch";
      readonly provider: FlightTelemetryProvider;
      readonly createCount: number;
      readonly updateCount: number;
      readonly deleteCount: number;
      readonly pathCount: number;
      readonly evidenceClass: "providerObserved";
    }
  | {
      readonly observationType: "providerUsage";
      readonly provider: FlightTelemetryProvider;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheCreationTokens: number;
      readonly reasoningTokens: number;
      readonly totalCostUsd: number | null;
      readonly evidenceClass: "providerObserved";
    }
  | {
      readonly observationType: "providerPermissionSummary";
      readonly provider: "claude";
      readonly deniedCount: number;
      readonly evidenceClass: "providerObserved";
    }
  | {
      readonly observationType: "providerTelemetryLimited";
      readonly provider: FlightTelemetryProvider;
      readonly reason: "observationFlood" | "lineBytes" | "streamBytes" | "openOperations";
      readonly droppedObservationsAtLeast: 1;
      readonly evidenceClass: "providerObserved";
    }
  | {
      readonly observationType: "providerTelemetryUnavailable";
      readonly provider: FlightTelemetryProvider;
      readonly reason: "plainOutput" | "unsupported" | "malformed";
      readonly evidenceClass: "providerObserved";
    };

export interface ProviderTelemetryNormalizer {
  push(chunk: string): readonly ProviderTelemetryObservation[];
  finish(): readonly ProviderTelemetryObservation[];
  unavailable(
    reason: Extract<ProviderTelemetryObservation, {
      observationType: "providerTelemetryUnavailable";
    }>["reason"],
  ): readonly ProviderTelemetryObservation[];
  readonly limited: boolean;
}

export interface ProviderTelemetryNormalizerOptions {
  readonly maxObservations?: number;
  readonly maxLineBytes?: number;
  readonly maxStreamBytes?: number;
  readonly maxOpenOperations?: number;
}

export interface NormalizedProviderTelemetry {
  readonly observations: readonly ProviderTelemetryObservation[];
  readonly limited: boolean;
}

const DEFAULT_MAX_OBSERVATIONS = 2_048;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
const DEFAULT_MAX_STREAM_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_OPEN_OPERATIONS = 256;
const TERMINAL_OBSERVATION_RESERVE = 3;
const LIMIT_NOTICE_RESERVE = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function createProviderTelemetryNormalizer(
  provider: FlightTelemetryProvider,
  options: ProviderTelemetryNormalizerOptions = {},
): ProviderTelemetryNormalizer {
  const maxObservations = boundedOption(
    options.maxObservations,
    DEFAULT_MAX_OBSERVATIONS,
    5,
    DEFAULT_MAX_OBSERVATIONS,
  );
  const maxLineBytes = boundedOption(
    options.maxLineBytes,
    DEFAULT_MAX_LINE_BYTES,
    256,
    DEFAULT_MAX_LINE_BYTES,
  );
  const maxStreamBytes = boundedOption(
    options.maxStreamBytes,
    DEFAULT_MAX_STREAM_BYTES,
    maxLineBytes,
    DEFAULT_MAX_STREAM_BYTES,
  );
  const maxOpenOperations = boundedOption(
    options.maxOpenOperations,
    DEFAULT_MAX_OPEN_OPERATIONS,
    1,
    DEFAULT_MAX_OPEN_OPERATIONS,
  );

  let partial = "";
  let streamBytes = 0;
  let lineNumber = 0;
  let emitted = 0;
  let limited = false;
  let limitedEmitted = false;
  let unavailableEmitted = false;
  let discardingOversizedLine = false;
  let streamExhausted = false;
  let terminalEnvelopeSeen = false;
  const openTools = new Map<string, ProviderToolCategory>();
  const finishedTools = new Set<string>();

  const emitLimited = (
    reason: Extract<ProviderTelemetryObservation, {
      observationType: "providerTelemetryLimited";
    }>["reason"],
  ): ProviderTelemetryObservation[] => {
    limited = true;
    if (limitedEmitted || emitted >= maxObservations - TERMINAL_OBSERVATION_RESERVE) return [];
    limitedEmitted = true;
    emitted += 1;
    return [{
      observationType: "providerTelemetryLimited",
      provider,
      reason,
      droppedObservationsAtLeast: 1,
      evidenceClass: "providerObserved",
    }];
  };

  const emit = (
    observations: readonly ProviderTelemetryObservation[],
    terminal = false,
  ): ProviderTelemetryObservation[] => {
    const accepted: ProviderTelemetryObservation[] = [];
    for (const observation of observations) {
      if (limited && !terminal) break;
      const threshold = terminal
        ? maxObservations
        : maxObservations - TERMINAL_OBSERVATION_RESERVE - LIMIT_NOTICE_RESERVE;
      if (emitted >= threshold) {
        accepted.push(...emitLimited("observationFlood"));
        if (!terminal) break;
        continue;
      }
      emitted += 1;
      accepted.push(observation);
    }
    return accepted;
  };

  const processLine = (line: string): ProviderTelemetryObservation[] => {
    lineNumber += 1;
    if (line.trim().length === 0) return [];
    if (terminalEnvelopeSeen) return [];
    if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
      return emitLimited("lineBytes");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (limited || unavailableEmitted) return [];
      unavailableEmitted = true;
      return emit([{
        observationType: "providerTelemetryUnavailable",
        provider,
        reason: "malformed",
        evidenceClass: "providerObserved",
      }]);
    }
    if (limited) {
      const terminal = normalizeProviderTerminalEnvelope(provider, parsed);
      if (terminal.length === 0 || terminalEnvelopeSeen) return [];
      terminalEnvelopeSeen = true;
      return emit(terminal, true);
    }
    const normalized = provider === "codex"
      ? normalizeCodexEnvelope(parsed, lineNumber, openTools, finishedTools, maxOpenOperations)
      : normalizeClaudeEnvelope(parsed, lineNumber, openTools, finishedTools, maxOpenOperations);
    const output: ProviderTelemetryObservation[] = [];
    if (normalized.operationStateOverflow) output.push(...emitLimited("openOperations"));
    if (!limited) output.push(...emit(normalized.nonterminal));
    if (normalized.terminal.length > 0 && !terminalEnvelopeSeen) {
      terminalEnvelopeSeen = true;
      output.push(...emit(normalized.terminal, true));
    }
    return output;
  };

  return {
    push(chunk: string): readonly ProviderTelemetryObservation[] {
      if (typeof chunk !== "string" || chunk.length === 0 || streamExhausted) return [];
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (chunkBytes > maxStreamBytes - streamBytes) {
        streamBytes = maxStreamBytes;
        partial = "";
        discardingOversizedLine = false;
        streamExhausted = true;
        return emitLimited("streamBytes");
      }
      streamBytes += chunkBytes;
      const output: ProviderTelemetryObservation[] = [];
      partial += chunk;
      for (;;) {
        const newline = partial.indexOf("\n");
        if (newline < 0) break;
        const line = partial.slice(0, newline).replace(/\r$/u, "");
        partial = partial.slice(newline + 1);
        if (discardingOversizedLine) {
          discardingOversizedLine = false;
          continue;
        }
        output.push(...processLine(line));
      }
      if (Buffer.byteLength(partial, "utf8") > maxLineBytes) {
        partial = "";
        discardingOversizedLine = true;
        output.push(...emitLimited("lineBytes"));
      }
      return output;
    },
    finish(): readonly ProviderTelemetryObservation[] {
      if (streamExhausted) return [];
      if (discardingOversizedLine) {
        discardingOversizedLine = false;
        partial = "";
        return [];
      }
      const remaining = partial;
      partial = "";
      return remaining.length === 0 ? [] : processLine(remaining.replace(/\r$/u, ""));
    },
    unavailable(reason): readonly ProviderTelemetryObservation[] {
      if (limited || terminalEnvelopeSeen || unavailableEmitted) return [];
      unavailableEmitted = true;
      return emit([{
        observationType: "providerTelemetryUnavailable",
        provider,
        reason,
        evidenceClass: "providerObserved",
      }]);
    },
    get limited(): boolean {
      return limited;
    },
  };
}

export function normalizeProviderTelemetry(
  provider: FlightTelemetryProvider,
  jsonl: string,
  options: ProviderTelemetryNormalizerOptions = {},
): NormalizedProviderTelemetry {
  const normalizer = createProviderTelemetryNormalizer(provider, options);
  const observations = [
    ...normalizer.push(jsonl),
    ...normalizer.finish(),
  ];
  return { observations, limited: normalizer.limited };
}

export function hashProviderOperationId(
  provider: FlightTelemetryProvider,
  providerOperationId: string,
): string {
  return createHash("sha256")
    .update("hydra.flight.v1.provider-operation\u0000", "utf8")
    .update(provider, "ascii")
    .update("\u0000", "ascii")
    .update(providerOperationId, "utf8")
    .digest("hex");
}

export function isProviderTelemetryObservation(
  value: unknown,
): value is ProviderTelemetryObservation {
  if (!isRecord(value)
    || typeof value.observationType !== "string"
    || (value.provider !== "codex" && value.provider !== "claude")
    || value.evidenceClass !== "providerObserved") {
    return false;
  }
  switch (value.observationType) {
    case "providerLifecycle":
      return hasExactKeys(value, [
        "observationType",
        "provider",
        "stage",
        "status",
        "evidenceClass",
      ])
        && (value.stage === "turnStarted" || value.stage === "turnFinished")
        && (value.status === "started" || value.status === "succeeded" || value.status === "failed")
        && ((value.stage === "turnStarted") === (value.status === "started"));
    case "providerToolStarted":
      return hasExactKeys(value, [
        "observationType",
        "provider",
        "providerOperationIdSha256",
        "toolCategory",
        "argumentBytes",
        "evidenceClass",
      ])
        && isSha256(value.providerOperationIdSha256)
        && isToolCategory(value.toolCategory)
        && isNonNegativeInteger(value.argumentBytes);
    case "providerToolFinished":
      return hasExactKeys(value, [
        "observationType",
        "provider",
        "providerOperationIdSha256",
        "toolCategory",
        "status",
        "resultBytes",
        "evidenceClass",
      ])
        && isSha256(value.providerOperationIdSha256)
        && isToolCategory(value.toolCategory)
        && (value.status === "succeeded" || value.status === "failed" || value.status === "unknown")
        && isNonNegativeInteger(value.resultBytes);
    case "providerEditBatch":
      return hasExactKeys(value, [
        "observationType",
        "provider",
        "createCount",
        "updateCount",
        "deleteCount",
        "pathCount",
        "evidenceClass",
      ])
        && [value.createCount, value.updateCount, value.deleteCount, value.pathCount]
          .every(isNonNegativeInteger)
        && value.pathCount === (value.createCount as number)
          + (value.updateCount as number)
          + (value.deleteCount as number);
    case "providerUsage":
      return hasExactKeys(value, [
        "observationType",
        "provider",
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheCreationTokens",
        "reasoningTokens",
        "totalCostUsd",
        "evidenceClass",
      ])
        && [
          value.inputTokens,
          value.outputTokens,
          value.cacheReadTokens,
          value.cacheCreationTokens,
          value.reasoningTokens,
        ].every(isNonNegativeInteger)
        && (value.totalCostUsd === null
          || (typeof value.totalCostUsd === "number"
            && Number.isFinite(value.totalCostUsd)
            && value.totalCostUsd >= 0));
    case "providerPermissionSummary":
      return hasExactKeys(value, [
        "observationType",
        "provider",
        "deniedCount",
        "evidenceClass",
      ])
        && value.provider === "claude"
        && isNonNegativeInteger(value.deniedCount);
    case "providerTelemetryLimited":
      return hasExactKeys(value, [
        "observationType",
        "provider",
        "reason",
        "droppedObservationsAtLeast",
        "evidenceClass",
      ])
        && (value.reason === "observationFlood"
          || value.reason === "lineBytes"
          || value.reason === "streamBytes"
          || value.reason === "openOperations")
        && value.droppedObservationsAtLeast === 1;
    case "providerTelemetryUnavailable":
      return hasExactKeys(value, [
        "observationType",
        "provider",
        "reason",
        "evidenceClass",
      ])
        && (value.reason === "plainOutput"
          || value.reason === "unsupported"
          || value.reason === "malformed");
    default:
      return false;
  }
}

interface EnvelopeNormalization {
  readonly nonterminal: readonly ProviderTelemetryObservation[];
  readonly terminal: readonly ProviderTelemetryObservation[];
  readonly operationStateOverflow: boolean;
}

function normalizeProviderTerminalEnvelope(
  provider: FlightTelemetryProvider,
  value: unknown,
): ProviderTelemetryObservation[] {
  const envelope = isRecord(value) ? value : {};
  const terminal: ProviderTelemetryObservation[] = [];
  if (provider === "codex") {
    if (envelope.type === "turn.completed") {
      const usage = usageObservation("codex", envelope.usage, null);
      if (usage) terminal.push(usage);
      terminal.push(lifecycle("codex", "turnFinished", "succeeded"));
    } else if (envelope.type === "turn.failed") {
      terminal.push(lifecycle("codex", "turnFinished", "failed"));
    }
    return terminal;
  }
  if (envelope.type !== "result") return terminal;
  if (Array.isArray(envelope.permission_denials)) {
    terminal.push({
      observationType: "providerPermissionSummary",
      provider: "claude",
      deniedCount: envelope.permission_denials.length,
      evidenceClass: "providerObserved",
    });
  }
  const usage = usageObservation(
    "claude",
    envelope.usage,
    nonNegativeFiniteOrNull(envelope.total_cost_usd),
  );
  if (usage) terminal.push(usage);
  const failed = envelope.is_error === true
    || (typeof envelope.subtype === "string" && envelope.subtype !== "success");
  terminal.push(lifecycle(
    "claude",
    "turnFinished",
    failed ? "failed" : "succeeded",
  ));
  return terminal;
}

function normalizeCodexEnvelope(
  value: unknown,
  lineNumber: number,
  openTools: Map<string, ProviderToolCategory>,
  finishedTools: Set<string>,
  maxOpenOperations: number,
): EnvelopeNormalization {
  const envelope = isRecord(value) ? value : {};
  const nonterminal: ProviderTelemetryObservation[] = [];
  const terminal: ProviderTelemetryObservation[] = [];
  let operationStateOverflow = false;

  if (envelope.type === "turn.started") {
    nonterminal.push(lifecycle("codex", "turnStarted", "started"));
  } else if (envelope.type === "turn.completed") {
    terminal.push(...normalizeProviderTerminalEnvelope("codex", envelope));
  } else if (envelope.type === "turn.failed") {
    terminal.push(...normalizeProviderTerminalEnvelope("codex", envelope));
  } else if (envelope.type === "item.started"
    || envelope.type === "item.completed") {
    const item = isRecord(envelope.item) ? envelope.item : {};
    if (item.type === "file_change" && envelope.type === "item.completed") {
      const counts = editCounts(item.changes);
      nonterminal.push({
        observationType: "providerEditBatch",
        provider: "codex",
        ...counts,
        evidenceClass: "providerObserved",
      });
    } else {
      const category = codexToolCategory(item);
      if (category) {
        const rawId = typeof item.id === "string"
          ? item.id
          : `line-${lineNumber}-${category}`;
        const id = hashProviderOperationId("codex", rawId);
        if (envelope.type === "item.started") {
          if (!openTools.has(id) && !finishedTools.has(id)) {
            if (openTools.size + finishedTools.size >= maxOpenOperations) {
              operationStateOverflow = true;
            } else {
              openTools.set(id, category);
              nonterminal.push({
                observationType: "providerToolStarted",
                provider: "codex",
                providerOperationIdSha256: id,
                toolCategory: category,
                argumentBytes: codexArgumentBytes(item),
                evidenceClass: "providerObserved",
              });
            }
          }
        } else if (!finishedTools.has(id)) {
          const wasOpen = openTools.has(id);
          const remembered = openTools.get(id) ?? category;
          openTools.delete(id);
          if (!wasOpen && openTools.size + finishedTools.size >= maxOpenOperations) {
            operationStateOverflow = true;
          } else {
            finishedTools.add(id);
            nonterminal.push({
              observationType: "providerToolFinished",
              provider: "codex",
              providerOperationIdSha256: id,
              toolCategory: remembered,
              status: normalizedStatus(item.status, item.error),
              resultBytes: codexResultBytes(item),
              evidenceClass: "providerObserved",
            });
          }
        }
      }
    }
  }
  return { nonterminal, terminal, operationStateOverflow };
}

function normalizeClaudeEnvelope(
  value: unknown,
  lineNumber: number,
  openTools: Map<string, ProviderToolCategory>,
  finishedTools: Set<string>,
  maxOpenOperations: number,
): EnvelopeNormalization {
  const envelope = isRecord(value) ? value : {};
  const nonterminal: ProviderTelemetryObservation[] = [];
  const terminal: ProviderTelemetryObservation[] = [];
  let operationStateOverflow = false;

  if (envelope.type === "system" && envelope.subtype === "init") {
    nonterminal.push(lifecycle("claude", "turnStarted", "started"));
  }

  const toolUses = claudeToolUses(envelope, maxOpenOperations + 1);
  for (const [index, toolUse] of toolUses.entries()) {
    const rawId = typeof toolUse.id === "string"
      ? toolUse.id
      : `line-${lineNumber}-tool-${index}`;
    const id = hashProviderOperationId("claude", rawId);
    if (openTools.has(id) || finishedTools.has(id)) continue;
    if (openTools.size + finishedTools.size >= maxOpenOperations) {
      operationStateOverflow = true;
      continue;
    }
    const category = classifyToolName(toolUse.name);
    openTools.set(id, category);
    nonterminal.push({
      observationType: "providerToolStarted",
      provider: "claude",
      providerOperationIdSha256: id,
      toolCategory: category,
      argumentBytes: jsonBytes(toolUse.input),
      evidenceClass: "providerObserved",
    });
  }

  for (const [index, result] of claudeToolResults(
    envelope,
    maxOpenOperations + 1,
  ).entries()) {
    const rawId = typeof result.tool_use_id === "string"
      ? result.tool_use_id
      : `line-${lineNumber}-result-${index}`;
    const id = hashProviderOperationId("claude", rawId);
    if (finishedTools.has(id)) continue;
    const wasOpen = openTools.has(id);
    const category = openTools.get(id) ?? "other";
    openTools.delete(id);
    if (!wasOpen && openTools.size + finishedTools.size >= maxOpenOperations) {
      operationStateOverflow = true;
    } else {
      finishedTools.add(id);
      nonterminal.push({
        observationType: "providerToolFinished",
        provider: "claude",
        providerOperationIdSha256: id,
        toolCategory: category,
        status: result.is_error === true ? "failed" : "succeeded",
        resultBytes: jsonBytes(result.content),
        evidenceClass: "providerObserved",
      });
    }
  }

  if (envelope.type === "result") {
    terminal.push(...normalizeProviderTerminalEnvelope("claude", envelope));
  }
  return { nonterminal, terminal, operationStateOverflow };
}

function claudeToolUses(
  envelope: Record<string, unknown>,
  limit: number,
): Record<string, unknown>[] {
  let candidates: readonly unknown[] = [];
  if (envelope.type === "assistant") {
    const message = isRecord(envelope.message) ? envelope.message : {};
    if (Array.isArray(message.content)) candidates = message.content;
  } else if (envelope.type === "stream_event") {
    const event = isRecord(envelope.event) ? envelope.event : {};
    if (event.type === "content_block_start") candidates = [event.content_block];
  }
  const accepted: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    if (isRecord(candidate) && candidate.type === "tool_use") {
      accepted.push(candidate);
      if (accepted.length >= limit) break;
    }
  }
  return accepted;
}

function claudeToolResults(
  envelope: Record<string, unknown>,
  limit: number,
): Record<string, unknown>[] {
  if (envelope.type !== "user") return [];
  const message = isRecord(envelope.message) ? envelope.message : {};
  if (!Array.isArray(message.content)) return [];
  const accepted: Record<string, unknown>[] = [];
  for (const candidate of message.content) {
    if (isRecord(candidate) && candidate.type === "tool_result") {
      accepted.push(candidate);
      if (accepted.length >= limit) break;
    }
  }
  return accepted;
}

function codexToolCategory(item: Record<string, unknown>): ProviderToolCategory | undefined {
  switch (item.type) {
    case "command_execution":
      return "shell";
    case "mcp_tool_call":
      return "mcp";
    case "web_search":
      return "search";
    case "collab_tool_call":
      return "collaboration";
    case "image_view":
      return "read";
    default:
      return undefined;
  }
}

function classifyToolName(name: unknown): ProviderToolCategory {
  if (typeof name !== "string") return "other";
  const normalized = name.toLowerCase();
  if (/bash|shell|powershell|terminal|command/u.test(normalized)) return "shell";
  if (/read|view|inspect|open/u.test(normalized)) return "read";
  if (/write|create/u.test(normalized)) return "write";
  if (/edit|patch|replace/u.test(normalized)) return "edit";
  if (/search|find|grep|glob/u.test(normalized)) return "search";
  if (/browser|chrome|playwright|navigate|click/u.test(normalized)) return "browser";
  if (/mcp/u.test(normalized)) return "mcp";
  if (/agent|task|collab/u.test(normalized)) return "collaboration";
  return "other";
}

function codexArgumentBytes(item: Record<string, unknown>): number {
  if (item.type === "command_execution") {
    return typeof item.command === "string" ? Buffer.byteLength(item.command, "utf8") : 0;
  }
  if (item.type === "web_search") {
    return typeof item.query === "string" ? Buffer.byteLength(item.query, "utf8") : 0;
  }
  return jsonBytes(item.arguments);
}

function codexResultBytes(item: Record<string, unknown>): number {
  if (typeof item.aggregated_output === "string") {
    return Buffer.byteLength(item.aggregated_output, "utf8");
  }
  if (item.result !== undefined) return jsonBytes(item.result);
  if (item.error !== undefined) return jsonBytes(item.error);
  return 0;
}

function editCounts(value: unknown): {
  createCount: number;
  updateCount: number;
  deleteCount: number;
  pathCount: number;
} {
  let createCount = 0;
  let updateCount = 0;
  let deleteCount = 0;
  if (Array.isArray(value)) {
    for (const candidate of value.slice(0, 10_000)) {
      const change = isRecord(candidate) ? candidate : {};
      if (change.kind === "add" || change.kind === "create") createCount += 1;
      else if (change.kind === "delete") deleteCount += 1;
      else updateCount += 1;
    }
  }
  return {
    createCount,
    updateCount,
    deleteCount,
    pathCount: createCount + updateCount + deleteCount,
  };
}

function usageObservation(
  provider: FlightTelemetryProvider,
  value: unknown,
  totalCostUsd: number | null,
): Extract<ProviderTelemetryObservation, { observationType: "providerUsage" }> | undefined {
  if (!isRecord(value)) return undefined;
  return {
    observationType: "providerUsage",
    provider,
    inputTokens: nonNegativeInteger(value.input_tokens),
    outputTokens: nonNegativeInteger(value.output_tokens),
    cacheReadTokens: nonNegativeInteger(
      value.cached_input_tokens ?? value.cache_read_input_tokens,
    ),
    cacheCreationTokens: nonNegativeInteger(value.cache_creation_input_tokens),
    reasoningTokens: nonNegativeInteger(value.reasoning_output_tokens),
    totalCostUsd,
    evidenceClass: "providerObserved",
  };
}

function lifecycle(
  provider: FlightTelemetryProvider,
  stage: "turnStarted" | "turnFinished",
  status: "started" | "succeeded" | "failed",
): Extract<ProviderTelemetryObservation, { observationType: "providerLifecycle" }> {
  return {
    observationType: "providerLifecycle",
    provider,
    stage,
    status,
    evidenceClass: "providerObserved",
  };
}

function normalizedStatus(status: unknown, error: unknown): "succeeded" | "failed" | "unknown" {
  if (error !== undefined
    || status === "failed"
    || status === "error"
    || status === "cancelled") {
    return "failed";
  }
  if (status === "completed" || status === "succeeded" || status === "success") {
    return "succeeded";
  }
  return "unknown";
}

function jsonBytes(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function nonNegativeFiniteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Provider telemetry bound must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function isToolCategory(value: unknown): value is ProviderToolCategory {
  return value === "shell"
    || value === "read"
    || value === "write"
    || value === "edit"
    || value === "search"
    || value === "browser"
    || value === "mcp"
    || value === "collaboration"
    || value === "other";
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}
