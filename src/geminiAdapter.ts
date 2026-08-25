import type {
  AdapterRawOutput,
  AgentAdapter,
  AgentDefinition,
  Invocation,
  InvocationContext,
} from "./agentAdapter";
import type { UsageTokens, ModelPrices } from "./usage";
import { buildAgentSpawn } from "./cli";
import { insertBeforeStdinDash, withModelArgs } from "./agentArgs";
import { classifyAgentAuthority } from "./authority";
import { resolveModelPrices, DEFAULT_PRICES_BY_KIND, coerceModelPrices } from "./usage";

export const geminiAdapter: AgentAdapter = {
  kind: "gemini",
  buildInvocation(def: AgentDefinition, ctx: InvocationContext): Invocation {
    const spawn = buildAgentSpawn(def.id, ctx.phase, ctx.command, ctx.rawArgs, ctx.workspaceRoot);
    // Why: same per-phase model resolution as codex/claude — withModelArgs
    // reads `hydraRoom.geminiModel` (string or per-phase object) and respects
    // an explicit --model/-m already present in rawArgs. def.model is only a
    // fallback for when neither the setting nor rawArgs supplied one, so the
    // model chooser's selection actually takes effect and we never emit two
    // --model flags.
    let args = withModelArgs(spawn, def.id, ctx.phase).args;
    if (def.model && !args.includes("--model") && !args.includes("-m")) {
      args = insertBeforeStdinDash(args, ["--model", def.model]);
    }
    return { transport: "spawn", command: spawn.command, args, stdin: ctx.prompt };
  },
  parseReply(raw: AdapterRawOutput): string {
    return raw.outputMode === "geminiJson"
      ? roomTextFromGeminiJson(raw.stdout)
      : raw.stdout;
  },
  parseUsage(raw: AdapterRawOutput): UsageTokens | undefined {
    return raw.outputMode === "geminiJson"
      ? parseGeminiUsage(raw.stdout)
      : undefined;
  },
  pricing(def: AgentDefinition): ModelPrices {
    // Why: unlike codex/claude (whose AgentId key matches a DEFAULT_PRICES
    // entry directly), "gemini" has no DEFAULT_PRICES key, so resolveModelPrices'
    // default agentDefaults param would silently floor to the codex row. Pass
    // the gemini row from DEFAULT_PRICES_BY_KIND explicitly as the fallback.
    const base = resolveModelPrices(
      "gemini",
      def.model,
      {},
      { gemini: DEFAULT_PRICES_BY_KIND.gemini },
    );
    return coerceModelPrices(def.pricing, base);
  },
  authority(def: AgentDefinition, ctx: InvocationContext) {
    return classifyAgentAuthority(def.id, ctx.phase, ctx.rawArgs, def.kind);
  },
};

/**
 * Extract the authoritative assistant reply from Gemini CLI's documented
 * `--output-format json` envelope. A malformed or version-incompatible
 * envelope falls back to the exact raw stdout so Hydra never silently erases
 * a provider response.
 */
export function roomTextFromGeminiJson(stdout: string): string {
  const payload = parseJsonRecord(stdout);
  return payload && typeof payload.response === "string"
    ? payload.response
    : stdout;
}

/** Resolve the effective (last) Gemini output-format flag in an argv vector. */
export function shouldUseGeminiJson(args: readonly string[]): boolean {
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output-format" || arg === "-o") {
      json = args[index + 1]?.toLowerCase() === "json";
      index += 1;
      continue;
    }
    if (arg?.startsWith("--output-format=") || arg?.startsWith("-o=")) {
      json = arg.slice(arg.indexOf("=") + 1).toLowerCase() === "json";
    }
  }
  return json;
}

/**
 * Normalize Gemini CLI SessionMetrics without double-counting cached input or
 * thinking tokens. Current CLIs report `tokens.input` as the uncached portion
 * of `tokens.prompt`; older SessionMetrics envelopes omit that derived field,
 * so Hydra recomputes it and validates it when present. Tool-use prompt tokens
 * are input, while thoughts are billed output and remain separately visible as
 * reasoning tokens.
 */
export function parseGeminiUsage(stdout: string): UsageTokens | undefined {
  const payload = parseJsonRecord(stdout);
  const stats = plainRecord(payload?.stats);
  const models = plainRecord(stats?.models);
  if (!models) return undefined;

  let inputTokens = 0;
  let candidatesTokens = 0;
  let cacheReadTokens = 0;
  let reasoningTokens = 0;
  let modelCount = 0;
  for (const metrics of Object.values(models)) {
    const tokens = plainRecord(plainRecord(metrics)?.tokens);
    if (!tokens) return undefined;
    const reportedInput = tokens.input === undefined
      ? undefined
      : safeTokenCount(tokens.input);
    const prompt = safeTokenCount(tokens.prompt);
    const candidates = safeTokenCount(tokens.candidates);
    const total = safeTokenCount(tokens.total);
    const cached = safeTokenCount(tokens.cached);
    const thoughts = safeTokenCount(tokens.thoughts);
    const tool = safeTokenCount(tokens.tool);
    if (
      (tokens.input !== undefined && reportedInput === undefined)
      || prompt === undefined
      || candidates === undefined
      || total === undefined
      || cached === undefined
      || thoughts === undefined
      || tool === undefined
      || cached > prompt
    ) {
      return undefined;
    }
    const uncachedPrompt = prompt - cached;
    if (reportedInput !== undefined && reportedInput !== uncachedPrompt) return undefined;
    const promptAndCandidates = checkedTokenSum(prompt, candidates);
    const thoughtsAndTool = checkedTokenSum(thoughts, tool);
    if (promptAndCandidates < 0 || thoughtsAndTool < 0) return undefined;
    const expectedTotal = checkedTokenSum(promptAndCandidates, thoughtsAndTool);
    if (expectedTotal < 0 || total !== expectedTotal) return undefined;
    const billedInput = checkedTokenSum(uncachedPrompt, tool);
    if (billedInput < 0) return undefined;
    inputTokens = checkedTokenSum(inputTokens, billedInput);
    candidatesTokens = checkedTokenSum(candidatesTokens, candidates);
    cacheReadTokens = checkedTokenSum(cacheReadTokens, cached);
    reasoningTokens = checkedTokenSum(reasoningTokens, thoughts);
    if (
      inputTokens < 0
      || candidatesTokens < 0
      || cacheReadTokens < 0
      || reasoningTokens < 0
    ) {
      return undefined;
    }
    modelCount += 1;
  }
  if (modelCount === 0) return undefined;
  const outputTokens = checkedTokenSum(candidatesTokens, reasoningTokens);
  if (outputTokens < 0) return undefined;
  if (inputTokens + outputTokens + cacheReadTokens === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens: 0,
    reasoningTokens,
  };
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    return plainRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeTokenCount(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

/** Return -1 on overflow so callers can fail the whole accounting record. */
function checkedTokenSum(left: number, right: number): number {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : -1;
}
