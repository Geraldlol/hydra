import { describe, test, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { openaiCompatibleAdapter, buildOpenAiChatBody, openaiHeaders, parseOpenAiReply, parseOpenAiUsage } from "../src/openaiCompatibleAdapter";
import type { AgentDefinition, InvocationContext } from "../src/agentAdapter";

const def: AgentDefinition = {
  id: "ollama-qwen", displayName: "Qwen", kind: "openai-compatible",
  baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder",
};
const ctx: InvocationContext = { phase: "build", workspaceRoot: "C:/repo", prompt: "hello", command: "ollama-qwen", rawArgs: [] };

afterEach(() => { delete process.env.HYDRA_TEST_KEY; });

describe("openai-compatible adapter", () => {
  test("buildInvocation targets ${baseUrl}/chat/completions as http POST", () => {
    const inv = openaiCompatibleAdapter.buildInvocation(def, ctx);
    assert.equal(inv.transport, "http");
    if (inv.transport !== "http") return;
    assert.equal(inv.url, "http://localhost:11434/v1/chat/completions");
    assert.equal(inv.method, "POST");
    const body = inv.body as { model: string; messages: Array<{ role: string; content: string }>; stream: boolean };
    assert.equal(body.model, "qwen2.5-coder");
    assert.equal(body.messages[0]?.content, "hello");
    assert.equal(body.stream, true);
  });

  test("apiKeyEnv injects Authorization from the environment, never the raw key", () => {
    process.env.HYDRA_TEST_KEY = "sk-secret-value";
    const headers = openaiHeaders({ ...def, apiKeyEnv: "HYDRA_TEST_KEY" });
    assert.equal(headers.Authorization, "Bearer sk-secret-value");
    assert.equal(headers["Content-Type"], "application/json");
  });

  test("missing apiKeyEnv env var yields no Authorization header", () => {
    const headers = openaiHeaders({ ...def, apiKeyEnv: "HYDRA_TEST_KEY" });
    assert.equal(headers.Authorization, undefined);
  });

  test("parseOpenAiReply extracts the assistant message content", () => {
    const raw = JSON.stringify({ choices: [{ message: { role: "assistant", content: "the answer" } }] });
    assert.equal(parseOpenAiReply(raw), "the answer");
  });

  test("parseOpenAiUsage reads prompt/completion/cached token counts", () => {
    const raw = JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 25 } } });
    assert.deepEqual(parseOpenAiUsage(raw), {
      inputTokens: 100, outputTokens: 40, cacheReadTokens: 25, cacheCreateTokens: 0, reasoningTokens: 0,
    });
  });

  test("authority is read-only (remote endpoint cannot touch the local workspace)", () => {
    assert.equal(openaiCompatibleAdapter.authority(def, ctx).level, "readOnly");
  });
});
