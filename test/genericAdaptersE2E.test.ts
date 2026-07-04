import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mergeAgentDefinitions } from "../src/agentValidation";
import { BUILTIN_AGENT_DEFINITIONS, adapterForKind } from "../src/agentRegistry";
import "../src/openaiCompatibleAdapter";
import "../src/cliTemplateAdapter";
import { runHttpAgent } from "../src/httpTransport";
import type { Invocation, InvocationContext } from "../src/agentAdapter";

const ctx = (prompt: string): InvocationContext => ({ phase: "build", workspaceRoot: "C:/repo", prompt, command: "", rawArgs: [] });

describe("generic adapters end to end", () => {
  test("a user seats an Ollama head and a cli-template head via settings", () => {
    const { defs, warnings } = mergeAgentDefinitions([...BUILTIN_AGENT_DEFINITIONS], [
      { id: "ollama-qwen", displayName: "Qwen (local)", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder" },
      { id: "shell-llm", displayName: "Shell LLM", kind: "cli-template", command: "llm", argsTemplate: ["-m", "${model}", "${prompt}"], model: "local-7b", defaultAuthority: "full-native" },
    ]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(defs.map((d) => d.id), ["codex", "claude", "gemini", "ollama-qwen", "shell-llm"]);

    const ollama = defs.find((d) => d.id === "ollama-qwen")!;
    const httpInv = adapterForKind(ollama.kind).buildInvocation(ollama, ctx("build the thing"));
    assert.equal(httpInv.transport, "http");
    if (httpInv.transport === "http") assert.equal(httpInv.url, "http://localhost:11434/v1/chat/completions");

    const shell = defs.find((d) => d.id === "shell-llm")!;
    const spawnInv = adapterForKind(shell.kind).buildInvocation(shell, ctx("build the thing"));
    assert.equal(spawnInv.transport, "spawn");
    if (spawnInv.transport === "spawn") assert.deepEqual(spawnInv.args, ["-m", "local-7b", "build the thing"]);
    assert.equal(adapterForKind(shell.kind).authority(shell, ctx("")).level, "fullNative");
  });

  test("the http transport returns the assistant reply for a fake Ollama endpoint", async () => {
    const inv: Extract<Invocation, { transport: "http" }> = {
      transport: "http", url: "http://localhost:11434/v1/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json" }, body: {},
    };
    const fetchImpl = (async () => new Response(
      JSON.stringify({ choices: [{ message: { content: "ollama says hi" } }], usage: { prompt_tokens: 8, completion_tokens: 3 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
    const res = await runHttpAgent(inv, { timeoutMs: 5000, signal: new AbortController().signal, fetchImpl });
    assert.equal(res.stdout, "ollama says hi");
  });

  test("invalid and secret-inlining definitions are rejected with clear messages", () => {
    const { defs, warnings } = mergeAgentDefinitions([...BUILTIN_AGENT_DEFINITIONS], [
      { id: "no-url", displayName: "No URL", kind: "openai-compatible" },
      { id: "leaky", displayName: "Leaky", kind: "openai-compatible", baseUrl: "https://x/v1", headers: { Authorization: "Bearer sk-proj-0123456789abcdef" } },
      { id: "remote-http", displayName: "Remote HTTP", kind: "openai-compatible", baseUrl: "http://api.openrouter.ai/v1" },
    ]);
    assert.deepEqual(defs.map((d) => d.id), ["codex", "claude", "gemini"]); // none of the three seated
    assert.equal(warnings.length, 3);
    assert.match(warnings.join(" | "), /baseUrl/);
    assert.match(warnings.join(" | "), /secret|inline/i);
    assert.match(warnings.join(" | "), /https/i);
  });
});
