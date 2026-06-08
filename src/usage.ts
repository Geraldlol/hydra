import { promises as fs } from "node:fs";
import * as path from "node:path";
import { serializePerFile } from "./fileQueue";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";

// Why: skip the per-append mkdir(recursive) syscall once a usage file's parent
// directory is known to exist. First write still creates it; the durable
// .hydra/ dir is never deleted mid-session.
const ensuredUsageDirs = new Set<string>();

export interface UsageRecord {
  timestamp: string;
  sessionId: string;
  agent: AgentId;
  phase: Phase;
  requestId?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  costSource: "native" | "computed";
  source: "claudeStreamJson" | "codexJson" | "codexTextTokens" | "unknown";
}

export interface ModelPrices {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /** USD per million cache-read tokens. Claude prompt caching. */
  cacheReadPerMTok: number;
  /** USD per million cache-write tokens. Claude prompt caching. */
  cacheCreatePerMTok: number;
}

export const DEFAULT_PRICES: Record<AgentId, ModelPrices> = {
  // Per-agent fallback when no model is known. Sonnet 4.6 / GPT-5.
  claude: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheCreatePerMTok: 3.75 },
  codex: { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheCreatePerMTok: 1.25 },
};

/**
 * Per-model prices for the cost meter. Aliases (sonnet/opus/haiku) resolve
 * to the current default version of that family. Override any of these via
 * the hydraRoom.modelPrices setting (same shape: model-name → ModelPrices).
 * Cache numbers follow Claude's public pricing for prompt caching; Codex
 * cache numbers are estimates since the CLI's plain-text output doesn't
 * split cache reads.
 */
export const DEFAULT_MODEL_PRICES: Record<string, ModelPrices> = {
  // Claude family
  sonnet: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheCreatePerMTok: 3.75 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheCreatePerMTok: 3.75 },
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheCreatePerMTok: 3.75 },
  opus: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheCreatePerMTok: 6.25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheCreatePerMTok: 6.25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheCreatePerMTok: 6.25 },
  "claude-opus-4-5": { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheCreatePerMTok: 6.25 },
  haiku: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheCreatePerMTok: 1.25 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheCreatePerMTok: 1.25 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheCreatePerMTok: 1.25 },
  // Codex / OpenAI family. The 5.x rates here are best-effort estimates
  // since OpenAI has not published official pricing for every variant the
  // Codex CLI exposes. Set hydraRoom.modelPrices["gpt-5.5"] etc. to pin
  // exact rates. Run `codex debug models` to see what your install offers.
  "gpt-5.5": { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheCreatePerMTok: 1.25 },
  "gpt-5.4": { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheCreatePerMTok: 1.25 },
  "gpt-5.4-mini": { inputPerMTok: 0.25, outputPerMTok: 2, cacheReadPerMTok: 0.025, cacheCreatePerMTok: 0.25 },
  "gpt-5.3-codex": { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheCreatePerMTok: 1.25 },
  "gpt-5.3-codex-spark": { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheCreatePerMTok: 1.25 },
  "gpt-5.2": { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheCreatePerMTok: 1.25 },
  // Older / commonly-seen IDs kept for users on different Codex CLI versions.
  "gpt-5": { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheCreatePerMTok: 1.25 },
  "gpt-5-codex": { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheCreatePerMTok: 1.25 },
  "gpt-5-pro": { inputPerMTok: 15, outputPerMTok: 120, cacheReadPerMTok: 1.5, cacheCreatePerMTok: 15 },
  "gpt-5-mini": { inputPerMTok: 0.25, outputPerMTok: 2, cacheReadPerMTok: 0.025, cacheCreatePerMTok: 0.25 },
  "gpt-5-nano": { inputPerMTok: 0.05, outputPerMTok: 0.4, cacheReadPerMTok: 0.005, cacheCreatePerMTok: 0.05 },
  o3: { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5, cacheCreatePerMTok: 2 },
  "o3-mini": { inputPerMTok: 1.1, outputPerMTok: 4.4, cacheReadPerMTok: 0.55, cacheCreatePerMTok: 1.1 },
  "o4-mini": { inputPerMTok: 1.1, outputPerMTok: 4.4, cacheReadPerMTok: 0.275, cacheCreatePerMTok: 1.1 },
  "codex-mini-latest": { inputPerMTok: 1.5, outputPerMTok: 6, cacheReadPerMTok: 0.375, cacheCreatePerMTok: 1.5 },
};

export function resolveModelPrices(
  agent: AgentId,
  model: string | undefined,
  modelOverrides: Record<string, Partial<ModelPrices>> = {},
  agentDefaults: Record<AgentId, ModelPrices> = DEFAULT_PRICES,
): ModelPrices {
  const key = (model ?? "").trim().toLowerCase();
  const agentBase = agentDefaults[agent] ?? DEFAULT_PRICES[agent];
  if (key && modelOverrides[key]) {
    // Why: merge the partial override over the most specific known base — the
    // built-in per-model rate if we have one, else the per-agent default — so
    // an override that omits e.g. the cache rate inherits the right model's
    // value (a partial Codex override no longer falls through to Claude's).
    const base = DEFAULT_MODEL_PRICES[key] ?? agentBase;
    return coerceModelPrices(modelOverrides[key], base);
  }
  if (key && DEFAULT_MODEL_PRICES[key]) return DEFAULT_MODEL_PRICES[key];
  return agentBase;
}

/**
 * Apply a (possibly partial, possibly hand-edited) price override on top of a
 * trusted base, accepting only finite non-negative numbers. A negative or
 * NaN/string field falls back to the base so a malformed hydraRoom.modelPrices
 * entry can't credit the meter or poison the cost with NaN.
 */
export function coerceModelPrices(override: Partial<ModelPrices> | undefined, base: ModelPrices): ModelPrices {
  return {
    inputPerMTok: nonNegNumberOr(override?.inputPerMTok, base.inputPerMTok),
    outputPerMTok: nonNegNumberOr(override?.outputPerMTok, base.outputPerMTok),
    cacheReadPerMTok: nonNegNumberOr(override?.cacheReadPerMTok, base.cacheReadPerMTok),
    cacheCreatePerMTok: nonNegNumberOr(override?.cacheCreatePerMTok, base.cacheCreatePerMTok),
  };
}

export function computeCostUsd(
  agent: AgentId,
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number },
  prices: Record<AgentId, ModelPrices> | ModelPrices = DEFAULT_PRICES,
): number {
  const p: ModelPrices = "inputPerMTok" in prices ? (prices as ModelPrices) : ((prices as Record<AgentId, ModelPrices>)[agent] ?? DEFAULT_PRICES[agent]);
  const cost =
    (tokens.inputTokens * p.inputPerMTok +
      tokens.outputTokens * p.outputPerMTok +
      tokens.cacheReadTokens * p.cacheReadPerMTok +
      tokens.cacheCreateTokens * p.cacheCreatePerMTok) /
    1_000_000;
  return Math.round(cost * 10_000) / 10_000;
}

/**
 * Parse the "tokens used" line Codex prints at the end of `codex exec`
 * plain-text output. Returns the total token count or undefined if not found.
 * Codex prints two lines like:
 *   tokens used
 *   10,298
 * The number may include commas. We take the LAST such block in case multiple
 * runs concatenated into one log.
 */
export function parseCodexTextTokens(stdout: string): number | undefined {
  const matches = [...stdout.matchAll(/tokens used\s*\n\s*([\d,]+)/gi)];
  const last = matches[matches.length - 1];
  if (last === undefined) return undefined;
  // Why: capture group 1 ([\d,]+) is required for the regex to match, so it is
  // always present on a successful match; default to "" defensively for the type.
  const raw = (last[1] ?? "").replace(/,/g, "");
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

export interface ClaudeUsageInput {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function usageFromClaudeSummary(usage: ClaudeUsageInput | undefined): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  reasoningTokens: number;
} | undefined {
  if (!usage) return undefined;
  const input = numberOr(usage.input_tokens, 0);
  const output = numberOr(usage.output_tokens, 0);
  const cacheRead = numberOr(usage.cache_read_input_tokens, 0);
  const cacheCreate = numberOr(usage.cache_creation_input_tokens, 0);
  if (input + output + cacheRead + cacheCreate === 0) return undefined;
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheCreateTokens: cacheCreate, reasoningTokens: 0 };
}

export interface CodexUsageInput {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export function usageFromCodexSummary(usage: CodexUsageInput | undefined): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  reasoningTokens: number;
} | undefined {
  if (!usage) return undefined;
  const input = numberOr(usage.input_tokens, 0);
  const cached = numberOr(usage.cached_input_tokens, 0);
  const output = numberOr(usage.output_tokens, 0);
  const reasoning = numberOr(usage.reasoning_output_tokens, 0);
  if (input + cached + output + reasoning === 0) return undefined;
  // Codex reports cached_input_tokens as a subset/credit, not a separate event.
  // Treat it as cache-read for cost purposes; remainder is fresh input.
  const freshInput = Math.max(0, input - cached);
  return {
    inputTokens: freshInput,
    outputTokens: output + reasoning,
    cacheReadTokens: cached,
    cacheCreateTokens: 0,
    reasoningTokens: reasoning,
  };
}

export function buildUsageRecord(input: {
  sessionId: string;
  agent: AgentId;
  phase: Phase;
  requestId?: string;
  model?: string;
  source: UsageRecord["source"];
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number; reasoningTokens: number };
  nativeCostUsd?: number;
  prices?: Record<AgentId, ModelPrices>;
  modelPriceOverrides?: Record<string, Partial<ModelPrices>>;
}): UsageRecord {
  const resolved = resolveModelPrices(
    input.agent,
    input.model,
    input.modelPriceOverrides ?? {},
    input.prices ?? DEFAULT_PRICES,
  );
  const nativeCostUsd =
    typeof input.nativeCostUsd === "number" && Number.isFinite(input.nativeCostUsd) && input.nativeCostUsd >= 0
      ? input.nativeCostUsd
      : undefined;
  const costUsd = nativeCostUsd ?? computeCostUsd(input.agent, input.tokens, resolved);
  const costSource = nativeCostUsd !== undefined ? "native" : "computed";
  const totalTokens =
    input.tokens.inputTokens +
    input.tokens.outputTokens +
    input.tokens.cacheReadTokens +
    input.tokens.cacheCreateTokens;
  return {
    timestamp: new Date().toISOString(),
    sessionId: input.sessionId,
    agent: input.agent,
    phase: input.phase,
    requestId: input.requestId,
    model: input.model?.trim() || undefined,
    inputTokens: input.tokens.inputTokens,
    outputTokens: input.tokens.outputTokens,
    cacheReadTokens: input.tokens.cacheReadTokens,
    cacheCreateTokens: input.tokens.cacheCreateTokens,
    reasoningTokens: input.tokens.reasoningTokens,
    totalTokens,
    costUsd,
    costSource,
    source: input.source,
  };
}

export async function appendUsageRecord(filePath: string, record: UsageRecord): Promise<void> {
  await serializePerFile(filePath, async () => {
    if (!ensuredUsageDirs.has(filePath)) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      ensuredUsageDirs.add(filePath);
    }
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
  });
}

export async function loadUsageRecords(filePath: string): Promise<UsageRecord[]> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const out: UsageRecord[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") out.push(parsed as UsageRecord);
      } catch {
        // Skip malformed lines silently — they don't affect aggregates.
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export interface UsageSummary {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  byAgent: Record<AgentId, { turns: number; totalTokens: number; costUsd: number }>;
}

export function summarizeUsage(records: UsageRecord[], filterSessionId?: string, sinceIso?: string): UsageSummary {
  const sinceMs = sinceIso ? Date.parse(sinceIso) : undefined;
  const filtered = records.filter((r) => {
    if (filterSessionId && r.sessionId !== filterSessionId) return false;
    if (typeof sinceMs === "number" && Number.isFinite(sinceMs)) {
      const ts = Date.parse(r.timestamp);
      if (!Number.isFinite(ts) || ts < sinceMs) return false;
    }
    return true;
  });
  const summary: UsageSummary = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    byAgent: {
      codex: { turns: 0, totalTokens: 0, costUsd: 0 },
      claude: { turns: 0, totalTokens: 0, costUsd: 0 },
    },
  };
  // Why: historical .hydra/usage.jsonl records pre-date the reasoningTokens field; coerce every numeric field so an undefined doesn't poison the aggregate with NaN.
  for (const r of filtered) {
    summary.turns += 1;
    summary.inputTokens += r.inputTokens || 0;
    summary.outputTokens += r.outputTokens || 0;
    summary.cacheReadTokens += r.cacheReadTokens || 0;
    summary.cacheCreateTokens += r.cacheCreateTokens || 0;
    summary.reasoningTokens += r.reasoningTokens || 0;
    summary.totalTokens += r.totalTokens || 0;
    summary.costUsd += r.costUsd || 0;
    const a = summary.byAgent[r.agent];
    if (a) {
      a.turns += 1;
      a.totalTokens += r.totalTokens || 0;
      a.costUsd += r.costUsd || 0;
    }
  }
  summary.costUsd = Math.round(summary.costUsd * 10_000) / 10_000;
  for (const a of Object.values(summary.byAgent)) {
    a.costUsd = Math.round(a.costUsd * 10_000) / 10_000;
  }
  return summary;
}

export function usageCutoffIso(days: number, now = new Date()): string {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return cutoff.toISOString();
}

/**
 * Fold a single record into an existing summary in place, avoiding a full
 * re-scan of the in-memory record array on every append. The caller is
 * responsible for only passing records that belong to the summary's filter
 * (e.g. same sessionId); this does not re-check the filter.
 */
export function addRecordToSummary(summary: UsageSummary, record: UsageRecord): UsageSummary {
  summary.turns += 1;
  summary.inputTokens += record.inputTokens || 0;
  summary.outputTokens += record.outputTokens || 0;
  summary.cacheReadTokens += record.cacheReadTokens || 0;
  summary.cacheCreateTokens += record.cacheCreateTokens || 0;
  summary.reasoningTokens += record.reasoningTokens || 0;
  summary.totalTokens += record.totalTokens || 0;
  summary.costUsd = Math.round((summary.costUsd + (record.costUsd || 0)) * 10_000) / 10_000;
  const a = summary.byAgent[record.agent];
  if (a) {
    a.turns += 1;
    a.totalTokens += record.totalTokens || 0;
    a.costUsd = Math.round((a.costUsd + (record.costUsd || 0)) * 10_000) / 10_000;
  }
  return summary;
}

/**
 * Cap the in-memory usage array so a long-lived room session can't grow it
 * without bound. The durable .hydra/usage.jsonl keeps full history; this only
 * trims what Hydra holds in RAM and replays for aggregates. The retained
 * window is the larger of `windowDays` and `minRecords`, and `windowDays`
 * must stay >= the 7-day weekly cutoff so the weekly aggregate is unaffected.
 */
export function boundUsageRecords(
  records: UsageRecord[],
  options: { windowDays?: number; minRecords?: number; now?: Date } = {},
): UsageRecord[] {
  const windowDays = Math.max(7, options.windowDays ?? 30);
  const minRecords = Math.max(0, options.minRecords ?? 2000);
  const now = options.now ?? new Date();
  const cutoffMs = Date.parse(usageCutoffIso(windowDays, now));
  // Keep anything inside the time window OR within the last `minRecords` rows,
  // whichever is more generous, so a burst day with thousands of turns and a
  // quiet month both stay correctly bounded.
  const startByCount = Math.max(0, records.length - minRecords);
  let startByTime = records.length;
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record === undefined) continue;
    const ts = Date.parse(record.timestamp);
    // Why: a record with an unparseable timestamp is treated as "recent" so a
    // hand-edited line is never silently dropped from the in-memory view.
    if (!Number.isFinite(ts) || ts >= cutoffMs) {
      startByTime = i;
      break;
    }
  }
  const start = Math.min(startByCount, startByTime);
  return start > 0 ? records.slice(start) : records;
}

export function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export function formatCostUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
