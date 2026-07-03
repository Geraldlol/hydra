import type { AgentAdapter, AgentDefinition, InvocationContext, Invocation, AdapterRawOutput } from "./agentAdapter";
import type { UsageTokens, ModelPrices } from "./usage";
import { numberOr, DEFAULT_PRICES_BY_KIND } from "./usage";
import { expandWorkspaceValue } from "./cli";

export function openaiHeaders(def: AgentDefinition): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  for (const [k, v] of Object.entries(def.headers ?? {})) {
    // Why: header values may reference ${env:NAME}; expand them here. "" root
    // is fine — expandWorkspaceValue only substitutes env for this path.
    headers[k] = expandWorkspaceValue(v, "");
  }
  if (def.apiKeyEnv) {
    const key = process.env[def.apiKeyEnv];
    if (key) headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

export function buildOpenAiChatBody(def: AgentDefinition, prompt: string): Record<string, unknown> {
  return {
    model: def.model ?? "",
    messages: [{ role: "user", content: prompt }],
    stream: true,
    stream_options: { include_usage: true },
  };
}

export function parseOpenAiReply(rawJson: string): string {
  try {
    const parsed = JSON.parse(rawJson) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
  } catch {
    // Not a single JSON object (e.g. transport already assembled plain text).
  }
  return rawJson;
}

export function parseOpenAiUsage(rawJson: string): UsageTokens | undefined {
  try {
    const parsed = JSON.parse(rawJson) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const u = parsed.usage;
    if (!u) return undefined;
    const input = numberOr(u.prompt_tokens, 0);
    const output = numberOr(u.completion_tokens, 0);
    const cacheRead = numberOr(u.prompt_tokens_details?.cached_tokens, 0);
    if (input + output === 0) return undefined;
    return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheCreateTokens: 0, reasoningTokens: 0 };
  } catch {
    return undefined;
  }
}

export const openaiCompatibleAdapter: AgentAdapter = {
  kind: "openai-compatible",
  buildInvocation(def: AgentDefinition, ctx: InvocationContext): Invocation {
    const base = (def.baseUrl ?? "").replace(/\/+$/, "");
    return {
      transport: "http",
      url: `${base}/chat/completions`,
      method: "POST",
      headers: openaiHeaders(def),
      body: buildOpenAiChatBody(def, ctx.prompt),
    };
  },
  parseReply(raw: AdapterRawOutput): string {
    return parseOpenAiReply(raw.stdout);
  },
  parseUsage(raw: AdapterRawOutput): UsageTokens | undefined {
    return parseOpenAiUsage(raw.stdout);
  },
  pricing(def: AgentDefinition): ModelPrices {
    return def.pricing ?? DEFAULT_PRICES_BY_KIND["openai-compatible"];
  },
  authority(def: AgentDefinition, _ctx: InvocationContext) {
    return {
      level: "readOnly" as const,
      label: "Remote endpoint",
      detail: `OpenAI-compatible head posts the transcript to ${def.baseUrl}; it returns text only and cannot touch the local workspace.`,
      warnings: [`This head sends prompt/transcript to ${def.baseUrl}.`],
    };
  },
};
