import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildUsageRecord,
  computeCostUsd,
  DEFAULT_MODEL_PRICES,
  DEFAULT_PRICES,
  parseCodexTextTokens,
  resolveModelPrices,
  summarizeUsage,
  usageFromClaudeSummary,
  usageFromCodexSummary,
} from "../src/usage";

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
    const opus = resolveModelPrices("claude", "claude-opus-4-7");
    assert.equal(opus.inputPerMTok, 15);
    assert.equal(opus.outputPerMTok, 75);
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
    assert.equal(lower.inputPerMTok, DEFAULT_MODEL_PRICES.sonnet.inputPerMTok);
  });
});

describe("buildUsageRecord stores the model and prices accordingly", () => {
  test("records the model and bills at that model's rate", () => {
    const r = buildUsageRecord({
      sessionId: "s",
      agent: "claude",
      phase: "build",
      source: "claudeStreamJson",
      model: "claude-opus-4-7",
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
    });
    assert.equal(r.model, "claude-opus-4-7");
    // 1M Opus input @ $15/M
    assert.equal(r.costUsd, 15);
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
});
