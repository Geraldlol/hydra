import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  addRecordToSummary,
  boundUsageRecords,
  buildUsageRecord,
  claudeAutomationSpendThisMonth,
  computeCostUsd,
  DEFAULT_MODEL_PRICES,
  DEFAULT_PRICES,
  DEFAULT_PRICES_BY_KIND,
  parseCodexTextTokens,
  resolveModelPrices,
  seatDefinitionPrices,
  summarizeUsage,
  UNKNOWN_AGENT_PRICES,
  usageCutoffIso,
  usageFromClaudeSummary,
  usageFromCodexSummary,
  type UsageRecord,
} from "../src/usage";

function usageRow(partial: Partial<UsageRecord> & { agent: UsageRecord["agent"]; timestamp: string; costUsd: number }): UsageRecord {
  return {
    sessionId: "s",
    phase: "opener",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costSource: "computed",
    source: "unknown",
    ...partial,
  };
}

describe("parseCodexTextTokens", () => {
  test("parses the trailing tokens-used block Codex prints", () => {
    const log = [
      "codex",
      "Some reply text from Codex.",
      "tokens used",
      "10,298",
      "Some reply text from Codex.",
    ].join("\n");
    assert.equal(parseCodexTextTokens(log), 10298);
  });

  test("returns the last block when Codex emits more than one", () => {
    const log = "tokens used\n100\nfoo\ntokens used\n2,345\nbar";
    assert.equal(parseCodexTextTokens(log), 2345);
  });

  test("returns undefined when no tokens-used line is present", () => {
    assert.equal(parseCodexTextTokens("nothing here"), undefined);
  });

  test("handles unusual whitespace and commas", () => {
    assert.equal(parseCodexTextTokens("tokens used\n  1,234,567  "), 1234567);
  });
});

describe("computeCostUsd", () => {
  test("Claude Sonnet defaults: 1M input + 500k output", () => {
    const cost = computeCostUsd("claude", {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
    // 1M * $3 + 0.5M * $15 = $3 + $7.50 = $10.50
    assert.equal(cost, 10.5);
  });

  test("Claude cache hits drop the input cost", () => {
    const fresh = computeCostUsd("claude", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
    const cached = computeCostUsd("claude", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreateTokens: 0,
    });
    assert.ok(cached < fresh, "cache-read should be cheaper than fresh input");
    // 1M cache read at $0.30 = $0.30
    assert.equal(cached, 0.3);
  });

  test("Codex defaults: 100k tokens billed as output via plain-text fallback", () => {
    const cost = computeCostUsd("codex", {
      inputTokens: 0,
      outputTokens: 100_000,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
    // 0.1M * $10 = $1.00
    assert.equal(cost, 1);
  });

  test("custom prices override defaults", () => {
    const cost = computeCostUsd(
      "claude",
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      { ...DEFAULT_PRICES, claude: { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 1, cacheCreatePerMTok: 1 } },
    );
    assert.equal(cost, 1);
  });
});

describe("usageFromClaudeSummary", () => {
  test("maps Claude stream-json usage fields into the canonical shape", () => {
    const u = usageFromClaudeSummary({
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 25,
    });
    assert.deepEqual(u, {
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreateTokens: 25,
      reasoningTokens: 0,
    });
  });

  test("returns undefined when every field is missing or zero", () => {
    assert.equal(usageFromClaudeSummary(undefined), undefined);
    assert.equal(usageFromClaudeSummary({}), undefined);
    assert.equal(
      usageFromClaudeSummary({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      undefined,
    );
  });
});

describe("usageFromCodexSummary", () => {
  test("treats cached_input_tokens as cache-read and subtracts from fresh input", () => {
    const u = usageFromCodexSummary({
      input_tokens: 1000,
      cached_input_tokens: 600,
      output_tokens: 200,
      reasoning_output_tokens: 50,
    });
    assert.deepEqual(u, {
      inputTokens: 400,
      outputTokens: 250,
      cacheReadTokens: 600,
      cacheCreateTokens: 0,
      reasoningTokens: 50,
    });
  });
});

describe("resolveModelPrices", () => {
  test("uses the per-model entry when the model name matches", () => {
    const opus = resolveModelPrices("claude", "claude-opus-4-8");
    assert.equal(opus.inputPerMTok, 5);
    assert.equal(opus.outputPerMTok, 25);
  });

  test("user overrides win over built-in per-model prices", () => {
    const overridden = resolveModelPrices(
      "codex",
      "gpt-5",
      { "gpt-5": { inputPerMTok: 9, outputPerMTok: 99, cacheReadPerMTok: 0.9, cacheCreatePerMTok: 9 } },
    );
    assert.equal(overridden.inputPerMTok, 9);
    assert.equal(overridden.outputPerMTok, 99);
  });

  test("a partial Codex override inherits the Codex per-model base, not Claude's", () => {
    // Only the input rate is overridden; the omitted cache rates must come from
    // the gpt-5 built-in (0.125 read), NOT Claude's default (0.3 read).
    const merged = resolveModelPrices("codex", "gpt-5", { "gpt-5": { inputPerMTok: 2 } });
    const gpt5 = DEFAULT_MODEL_PRICES["gpt-5"];
    assert.ok(gpt5);
    assert.equal(merged.inputPerMTok, 2, "explicit field wins");
    assert.equal(merged.outputPerMTok, gpt5.outputPerMTok);
    assert.equal(merged.cacheReadPerMTok, gpt5.cacheReadPerMTok);
    assert.equal(merged.cacheCreatePerMTok, gpt5.cacheCreatePerMTok);
  });

  test("a partial override for an unknown model fills omitted fields from the per-agent default", () => {
    const merged = resolveModelPrices("codex", "totally-new-codex", { "totally-new-codex": { inputPerMTok: 7 } });
    const codexDefault = DEFAULT_PRICES.codex;
    assert.ok(codexDefault);
    assert.equal(merged.inputPerMTok, 7);
    assert.equal(merged.outputPerMTok, codexDefault.outputPerMTok);
    assert.equal(merged.cacheReadPerMTok, codexDefault.cacheReadPerMTok);
  });

  test("rejects malformed override fields (NaN / negative) and keeps the base", () => {
    const merged = resolveModelPrices("claude", "opus", {
      opus: { inputPerMTok: Number.NaN, outputPerMTok: -5, cacheReadPerMTok: 0.05 },
    });
    const opus = DEFAULT_MODEL_PRICES.opus;
    assert.ok(opus);
    assert.equal(merged.inputPerMTok, opus.inputPerMTok, "NaN falls back to base");
    assert.equal(merged.outputPerMTok, opus.outputPerMTok, "negative falls back to base");
    assert.equal(merged.cacheReadPerMTok, 0.05, "valid field is applied");
  });

  test("falls back to agent default when model is unknown", () => {
    const unknown = resolveModelPrices("claude", "some-future-model-id");
    assert.deepEqual(unknown, DEFAULT_PRICES.claude);
  });

  test("ignores model when empty/undefined and uses agent default", () => {
    assert.deepEqual(resolveModelPrices("codex", ""), DEFAULT_PRICES.codex);
    assert.deepEqual(resolveModelPrices("codex", undefined), DEFAULT_PRICES.codex);
  });

  test("case-insensitive model lookup", () => {
    const lower = resolveModelPrices("claude", "Claude-Sonnet-4-6");
    const sonnet = DEFAULT_MODEL_PRICES.sonnet;
    assert.ok(sonnet);
    assert.equal(lower.inputPerMTok, sonnet.inputPerMTok);
  });

  test("prices the documented GPT-5.6 Codex family", () => {
    const sol = resolveModelPrices("codex", "gpt-5.6-sol");
    const alias = resolveModelPrices("codex", "gpt-5.6");
    const terra = resolveModelPrices("codex", "gpt-5.6-terra");
    const luna = resolveModelPrices("codex", "gpt-5.6-luna");
    assert.equal(sol.inputPerMTok, 5);
    assert.equal(sol.outputPerMTok, 30);
    assert.deepEqual(alias, sol);
    assert.equal(terra.inputPerMTok, 2.5);
    assert.equal(terra.outputPerMTok, 15);
    assert.equal(luna.inputPerMTok, 1);
    assert.equal(luna.outputPerMTok, 6);
  });
});

describe("buildUsageRecord stores the model and prices accordingly", () => {
  test("records the model and bills at that model's rate", () => {
    const r = buildUsageRecord({
      sessionId: "s",
      agent: "claude",
      phase: "build",
      source: "claudeStreamJson",
      model: "claude-opus-4-8",
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
    });
    assert.equal(r.model, "claude-opus-4-8");
    // 1M Opus 4.8 input @ $5/M
    assert.equal(r.costUsd, 5);
    assert.equal(r.costSource, "computed");
  });

  test("prefers native Claude cost when present", () => {
    const r = buildUsageRecord({
      sessionId: "s",
      agent: "claude",
      phase: "reactor",
      source: "claudeStreamJson",
      model: "claude-opus-4-8",
      tokens: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
      nativeCostUsd: 0.12,
    });
    assert.equal(r.costUsd, 0.12);
    assert.equal(r.costSource, "native");
  });

  test("accepts a native cost of exactly zero as authoritative", () => {
    // A native total_cost_usd of 0 (e.g. a fully cache-served turn) is a real
    // figure, not a missing one — believe it rather than fall back to estimate.
    const r = buildUsageRecord({
      sessionId: "s",
      agent: "claude",
      phase: "reactor",
      source: "claudeStreamJson",
      model: "claude-opus-4-8",
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
      nativeCostUsd: 0,
    });
    assert.equal(r.costUsd, 0);
    assert.equal(r.costSource, "native");
  });

  test("falls back to computed cost when native cost is negative", () => {
    const r = buildUsageRecord({
      sessionId: "s",
      agent: "claude",
      phase: "reactor",
      source: "claudeStreamJson",
      model: "claude-opus-4-8",
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
      nativeCostUsd: -1,
    });
    assert.equal(r.costUsd, 5);
    assert.equal(r.costSource, "computed");
  });

  test("falls back to computed cost when native cost is NaN or non-finite", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = buildUsageRecord({
        sessionId: "s",
        agent: "claude",
        phase: "reactor",
        source: "claudeStreamJson",
        model: "claude-opus-4-8",
        tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
        nativeCostUsd: bad,
      });
      assert.equal(r.costUsd, 5);
      assert.equal(r.costSource, "computed");
    }
  });
});

describe("claudeAutomationSpendThisMonth", () => {
  const now = new Date("2026-06-08T12:00:00.000Z");

  test("sums only Claude cost within the current calendar month", () => {
    const records = [
      usageRow({ agent: "claude", timestamp: "2026-06-01T00:00:00.000Z", costUsd: 1.5 }),
      usageRow({ agent: "claude", timestamp: "2026-06-08T11:00:00.000Z", costUsd: 2.25 }),
      // Codex spend is a separate (OpenAI) pool — excluded.
      usageRow({ agent: "codex", timestamp: "2026-06-02T00:00:00.000Z", costUsd: 99 }),
      // Last month — excluded.
      usageRow({ agent: "claude", timestamp: "2026-05-31T23:59:59.000Z", costUsd: 40 }),
    ];
    assert.equal(claudeAutomationSpendThisMonth(records, now), 3.75);
  });

  test("returns 0 when there is no Claude spend this month", () => {
    const records = [
      usageRow({ agent: "codex", timestamp: "2026-06-02T00:00:00.000Z", costUsd: 12 }),
      usageRow({ agent: "claude", timestamp: "2026-04-10T00:00:00.000Z", costUsd: 80 }),
    ];
    assert.equal(claudeAutomationSpendThisMonth(records, now), 0);
  });

  test("ignores rows with an unparseable timestamp rather than throwing", () => {
    const records = [
      usageRow({ agent: "claude", timestamp: "not-a-date", costUsd: 5 }),
      usageRow({ agent: "claude", timestamp: "2026-06-05T00:00:00.000Z", costUsd: 1 }),
    ];
    assert.equal(claudeAutomationSpendThisMonth(records, now), 1);
  });
});

describe("summarizeUsage", () => {
  test("sums tokens and cost; splits per agent; filters by sessionId", () => {
    const records = [
      buildUsageRecord({
        sessionId: "s1",
        agent: "codex",
        phase: "opener",
        source: "codexTextTokens",
        tokens: { inputTokens: 0, outputTokens: 10_000, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
        prices: DEFAULT_PRICES,
      }),
      buildUsageRecord({
        sessionId: "s1",
        agent: "claude",
        phase: "reactor",
        source: "claudeStreamJson",
        tokens: { inputTokens: 500_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
        prices: DEFAULT_PRICES,
      }),
      buildUsageRecord({
        sessionId: "s2-different",
        agent: "codex",
        phase: "build",
        source: "codexJson",
        tokens: { inputTokens: 0, outputTokens: 999_999, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
        prices: DEFAULT_PRICES,
      }),
    ];
    const summary = summarizeUsage(records, "s1");
    assert.equal(summary.turns, 2);
    assert.equal(summary.totalTokens, 10_000 + 500_000 + 100_000);
    assert.ok(summary.byAgent.codex);
    assert.ok(summary.byAgent.claude);
    assert.equal(summary.byAgent.codex.turns, 1);
    assert.equal(summary.byAgent.claude.turns, 1);
    // 10k Codex output @ $10/M = $0.10; 500k Claude input @ $3/M + 100k output @ $15/M = $1.5 + $1.5 = $3.00
    assert.equal(summary.costUsd, 3.1);
  });

  test("returns zero summary when no records match the session filter", () => {
    const summary = summarizeUsage([], "missing");
    assert.equal(summary.turns, 0);
    assert.equal(summary.totalTokens, 0);
    assert.equal(summary.costUsd, 0);
  });

  test("filters records by rolling usage cutoff", () => {
    const now = new Date("2026-05-15T12:00:00.000Z");
    const recent = buildUsageRecord({
      sessionId: "old-session",
      agent: "codex",
      phase: "opener",
      source: "codexJson",
      tokens: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
      prices: DEFAULT_PRICES,
    });
    recent.timestamp = "2026-05-14T12:00:00.000Z";
    const stale = buildUsageRecord({
      sessionId: "old-session",
      agent: "claude",
      phase: "reactor",
      source: "claudeStreamJson",
      tokens: { inputTokens: 999, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
      prices: DEFAULT_PRICES,
    });
    stale.timestamp = "2026-05-01T12:00:00.000Z";

    const summary = summarizeUsage([recent, stale], undefined, usageCutoffIso(7, now));

    assert.equal(summary.turns, 1);
    assert.equal(summary.totalTokens, 150);
    assert.ok(summary.byAgent.codex);
    assert.equal(summary.byAgent.codex.turns, 1);
    // Why: byAgent seats lazily now, so the stale claude record (excluded by
    // the cutoff filter before the fold loop even runs) never seats a claude
    // entry at all -- it's absent, not present-with-zero.
    assert.equal(summary.byAgent.claude, undefined);
  });
});

describe("addRecordToSummary", () => {
  test("incrementally folds a record into an existing summary, matching summarizeUsage", () => {
    const records = [
      buildUsageRecord({
        sessionId: "s1",
        agent: "codex",
        phase: "opener",
        source: "codexJson",
        tokens: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
        prices: DEFAULT_PRICES,
      }),
      buildUsageRecord({
        sessionId: "s1",
        agent: "claude",
        phase: "reactor",
        source: "claudeStreamJson",
        tokens: { inputTokens: 500_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
        prices: DEFAULT_PRICES,
      }),
    ];
    // Fold record 0 into a fresh summary, then record 1 — must match a full scan.
    const folded = summarizeUsage([], "s1");
    for (const r of records) addRecordToSummary(folded, r);
    const scanned = summarizeUsage(records, "s1");
    assert.deepEqual(folded, scanned);
  });
});

describe("boundUsageRecords", () => {
  const now = new Date("2026-05-15T12:00:00.000Z");
  const recordAt = (iso: string): ReturnType<typeof buildUsageRecord> => {
    const r = buildUsageRecord({
      sessionId: "s",
      agent: "codex",
      phase: "opener",
      source: "codexJson",
      tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
      prices: DEFAULT_PRICES,
    });
    r.timestamp = iso;
    return r;
  };

  test("keeps records inside the 30-day window and drops older ones when over minRecords", () => {
    const recent = recordAt("2026-05-14T12:00:00.000Z");
    const stale = recordAt("2026-01-01T12:00:00.000Z");
    const bounded = boundUsageRecords([stale, recent], { windowDays: 30, minRecords: 1, now });
    assert.deepEqual(bounded, [recent]);
  });

  test("keeps at least the 7-day weekly cutoff regardless of a smaller window request", () => {
    const sixDaysAgo = recordAt("2026-05-09T12:00:00.000Z");
    // Requesting windowDays:1 must be floored to 7 so the weekly aggregate stays intact.
    const bounded = boundUsageRecords([sixDaysAgo], { windowDays: 1, minRecords: 0, now });
    assert.deepEqual(bounded, [sixDaysAgo]);
  });

  test("retains the last minRecords rows even when older than the time window", () => {
    const old1 = recordAt("2026-01-01T12:00:00.000Z");
    const old2 = recordAt("2026-01-02T12:00:00.000Z");
    const old3 = recordAt("2026-01-03T12:00:00.000Z");
    const bounded = boundUsageRecords([old1, old2, old3], { windowDays: 30, minRecords: 2, now });
    assert.deepEqual(bounded, [old2, old3]);
  });

  test("treats an unparseable timestamp as recent (never silently dropped)", () => {
    const broken = recordAt("not-a-date");
    const stale = recordAt("2026-01-01T12:00:00.000Z");
    const bounded = boundUsageRecords([broken, stale], { windowDays: 30, minRecords: 0, now });
    // The broken row appears before the cutoff scan finds it, so it anchors the
    // window start and everything from there on is kept.
    assert.deepEqual(bounded, [broken, stale]);
  });
});

describe("registry-driven pricing", () => {
  test("per-kind defaults exist for codex, claude, gemini", () => {
    assert.ok(DEFAULT_PRICES_BY_KIND.codex.inputPerMTok > 0);
    assert.ok(DEFAULT_PRICES_BY_KIND.claude.inputPerMTok > 0);
    assert.ok(DEFAULT_PRICES_BY_KIND.gemini.inputPerMTok > 0);
  });

  test("summarizeUsage aggregates an arbitrary agent id without a hardcoded seat", () => {
    const rec = buildUsageRecord({
      sessionId: "s", agent: "gemini", phase: "build", source: "unknown",
      tokens: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
    });
    const summary = summarizeUsage([rec]);
    assert.equal(summary.byAgent.gemini?.turns, 1);
    assert.equal(summary.byAgent.gemini?.totalTokens, 150);
  });
});

describe("per-head pricing", () => {
  test("seatDefinitionPrices keeps existing seats and adds custom heads from def.pricing or per-kind default", () => {
    // Why: DEFAULT_PRICES is keyed by the widened AgentId, so a literal
    // .codex/.claude access types as possibly-undefined under
    // noUncheckedIndexedAccess; both are always present in practice.
    const base = { codex: DEFAULT_PRICES.codex ?? UNKNOWN_AGENT_PRICES, claude: DEFAULT_PRICES.claude ?? UNKNOWN_AGENT_PRICES };
    const custom = { inputPerMTok: 0.2, outputPerMTok: 0.4, cacheReadPerMTok: 0, cacheCreatePerMTok: 0 };
    const seated = seatDefinitionPrices(base, [
      { id: "codex", kind: "codex" },
      { id: "ollama-qwen", kind: "openai-compatible", pricing: custom },
      { id: "my-tool", kind: "cli-template" },
    ]);
    assert.equal(seated.codex, DEFAULT_PRICES.codex); // untouched
    assert.deepEqual(seated["ollama-qwen"], custom); // explicit per-head pricing
    assert.deepEqual(seated["my-tool"], DEFAULT_PRICES_BY_KIND["cli-template"]); // per-kind fallback
  });

  test("seatDefinitionPrices sanitizes a malformed def.pricing instead of poisoning the seat with NaN", () => {
    const base = { codex: DEFAULT_PRICES.codex ?? UNKNOWN_AGENT_PRICES, claude: DEFAULT_PRICES.claude ?? UNKNOWN_AGENT_PRICES };
    const seated = seatDefinitionPrices(base, [
      {
        id: "sketchy",
        kind: "openai-compatible",
        // @ts-expect-error - intentionally malformed, as a hand-edited setting could supply
        pricing: { inputPerMTok: "evil", outputPerMTok: -5, cacheReadPerMTok: 0.5, cacheCreatePerMTok: 1.25 },
      },
    ]);
    const kindDefault = DEFAULT_PRICES_BY_KIND["openai-compatible"];
    assert.deepEqual(seated.sketchy, {
      inputPerMTok: kindDefault.inputPerMTok, // bad (non-numeric) -> falls back
      outputPerMTok: kindDefault.outputPerMTok, // bad (negative) -> falls back
      cacheReadPerMTok: 0.5, // good -> kept
      cacheCreatePerMTok: 1.25, // good -> kept
    });
  });
});
