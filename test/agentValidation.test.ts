import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  isEnvVarName,
  isSecretShaped,
  isLoopbackOrPrivateHost,
  baseUrlAllowed,
  validateAgentDefinition,
  mergeAgentDefinitions,
} from "../src/agentValidation";
import { BUILTIN_AGENT_DEFINITIONS } from "../src/agentRegistry";

describe("agent definition validation", () => {
  test("isEnvVarName accepts POSIX identifiers, rejects key-shaped values", () => {
    assert.equal(isEnvVarName("OPENAI_API_KEY"), true);
    assert.equal(isEnvVarName("OLLAMA_KEY_1"), true);
    assert.equal(isEnvVarName("sk-abc123"), false);
    assert.equal(isEnvVarName("has space"), false);
    assert.equal(isEnvVarName(""), false);
  });

  test("isSecretShaped flags common inlined credential shapes", () => {
    assert.equal(isSecretShaped("sk-proj-0123456789abcdef0123"), true);
    assert.equal(isSecretShaped("Bearer eyJhbGciOi.aaaa.bbbb"), true);
    assert.equal(isSecretShaped("ghp_0123456789abcdefABCDEF0123456789abcd"), true);
    assert.equal(isSecretShaped("qwen2.5-coder"), false);
    assert.equal(isSecretShaped("${env:OPENAI_API_KEY}"), false);
  });

  test("isLoopbackOrPrivateHost recognizes local model servers", () => {
    assert.equal(isLoopbackOrPrivateHost("localhost"), true);
    assert.equal(isLoopbackOrPrivateHost("127.0.0.1"), true);
    assert.equal(isLoopbackOrPrivateHost("::1"), true);
    assert.equal(isLoopbackOrPrivateHost("192.168.1.50"), true);
    assert.equal(isLoopbackOrPrivateHost("10.0.0.4"), true);
    assert.equal(isLoopbackOrPrivateHost("workstation.local"), true);
    assert.equal(isLoopbackOrPrivateHost("api.openrouter.ai"), false);
  });

  test("baseUrlAllowed: https anywhere, http only for local", () => {
    assert.equal(baseUrlAllowed("https://api.openrouter.ai/v1").ok, true);
    assert.equal(baseUrlAllowed("http://localhost:11434/v1").ok, true);
    assert.equal(baseUrlAllowed("http://192.168.1.9:1234/v1").ok, true);
    assert.equal(baseUrlAllowed("http://api.openrouter.ai/v1").ok, false);
    assert.equal(baseUrlAllowed("ftp://localhost/v1").ok, false);
  });

  test("isLoopbackOrPrivateHost rejects DNS names that merely start with a private-looking prefix", () => {
    assert.equal(isLoopbackOrPrivateHost("192.168.evil.test"), false);
    assert.equal(isLoopbackOrPrivateHost("10.attacker.example"), false);
    assert.equal(isLoopbackOrPrivateHost("127.0.0.1.evil.test"), false);
    assert.equal(isLoopbackOrPrivateHost("169.254.169.254.evil.test"), false);
  });

  test("isLoopbackOrPrivateHost tolerates a single trailing dot", () => {
    assert.equal(isLoopbackOrPrivateHost("localhost."), true);
  });

  test("baseUrlAllowed rejects spoofed private-looking public hosts over http", () => {
    assert.equal(baseUrlAllowed("http://192.168.evil.test/v1").ok, false);
    assert.equal(baseUrlAllowed("http://10.attacker.example/v1").ok, false);
    assert.equal(baseUrlAllowed("http://127.0.0.1.evil.test/v1").ok, false);
    assert.equal(baseUrlAllowed("http://169.254.169.254.evil.test/v1").ok, false);
  });

  test("baseUrlAllowed still allows genuine local/private hosts over http", () => {
    assert.equal(baseUrlAllowed("http://192.168.1.5/v1").ok, true);
    assert.equal(baseUrlAllowed("http://10.0.0.1/v1").ok, true);
    assert.equal(baseUrlAllowed("http://172.16.0.1/v1").ok, true);
    assert.equal(baseUrlAllowed("http://127.0.0.1:11434/v1").ok, true);
    assert.equal(baseUrlAllowed("http://localhost:1234/v1").ok, true);
    assert.equal(baseUrlAllowed("http://[::1]:1234/v1").ok, true);
    assert.equal(baseUrlAllowed("http://localhost./v1").ok, true);
  });

  test("baseUrlAllowed still allows https for public hosts", () => {
    assert.equal(baseUrlAllowed("https://api.openai.com/v1").ok, true);
  });

  test("isLoopbackOrPrivateHost treats 0.0.0.0 and IPv6 ULA addresses as local", () => {
    assert.equal(isLoopbackOrPrivateHost("0.0.0.0"), true);
    assert.equal(isLoopbackOrPrivateHost("fd12:3456::1"), true);
    assert.equal(isLoopbackOrPrivateHost("fc00::1"), true);
  });

  test("isLoopbackOrPrivateHost still rejects spoofed DNS names after the local-host fix", () => {
    assert.equal(isLoopbackOrPrivateHost("192.168.evil.test"), false);
    assert.equal(isLoopbackOrPrivateHost("10.attacker.example"), false);
  });

  test("baseUrlAllowed allows 0.0.0.0 and IPv6 ULA bind addresses over http", () => {
    assert.equal(baseUrlAllowed("http://0.0.0.0:11434/v1").ok, true);
    assert.equal(baseUrlAllowed("http://[fd12:3456::1]:1234/v1").ok, true);
  });

  test("baseUrlAllowed rejects a baseUrl carrying inline userinfo credentials", () => {
    const result = baseUrlAllowed("https://user:sk-live-x@host/v1");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /credential/i);
  });

  test("baseUrlAllowed rejects a baseUrl carrying a secret-shaped query parameter", () => {
    const result = baseUrlAllowed("https://host/v1?api_key=sk-proj-abc123def456");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /secret/i);
  });

  test("baseUrlAllowed still allows clean baseUrls with no credentials or secret-shaped query", () => {
    assert.equal(baseUrlAllowed("https://host/v1").ok, true);
    assert.equal(baseUrlAllowed("http://localhost:11434/v1").ok, true);
  });

  test("isSecretShaped treats a `${env:NAME}` placeholder embedded in a larger value as non-secret", () => {
    assert.equal(isSecretShaped("Bearer ${env:MY_TOKEN}"), false);
    assert.equal(isSecretShaped("Bearer sk-live-realkey00000"), true);
  });

  test("validateAgentDefinition accepts a well-formed openai-compatible head", () => {
    const { def, error } = validateAgentDefinition(
      { id: "ollama-qwen", displayName: "Qwen (local)", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder" },
      new Set(),
    );
    assert.equal(error, undefined);
    assert.equal(def?.id, "ollama-qwen");
  });

  test("rejects an inlined api key in apiKeyEnv", () => {
    const { def, error } = validateAgentDefinition(
      { id: "bad", displayName: "Bad", kind: "openai-compatible", baseUrl: "https://x/v1", apiKeyEnv: "sk-proj-0123456789abcdef" },
      new Set(),
    );
    assert.equal(def, undefined);
    assert.match(error ?? "", /apiKeyEnv/);
  });

  test("rejects an inlined secret in a header value", () => {
    const { error } = validateAgentDefinition(
      { id: "bad2", displayName: "Bad2", kind: "openai-compatible", baseUrl: "https://x/v1", headers: { Authorization: "Bearer sk-proj-0123456789abcdef" } },
      new Set(),
    );
    assert.match(error ?? "", /secret|inline|Authorization/i);
  });

  test("accepts a header value that references an env var via ${env:NAME}, even with a Bearer prefix", () => {
    const { def, error } = validateAgentDefinition(
      { id: "ok-header", displayName: "OK", kind: "openai-compatible", baseUrl: "https://x/v1", headers: { Authorization: "Bearer ${env:MY_TOKEN}" } },
      new Set(),
    );
    assert.equal(error, undefined);
    assert.equal(def?.headers?.Authorization, "Bearer ${env:MY_TOKEN}");
  });

  test("still rejects a baseUrl carrying inline credentials or a secret-shaped query on validateAgentDefinition", () => {
    assert.match(
      validateAgentDefinition({ id: "cred", displayName: "Cred", kind: "openai-compatible", baseUrl: "https://user:sk-live-x@host/v1" }, new Set()).error ?? "",
      /credential/i,
    );
    assert.match(
      validateAgentDefinition({ id: "q", displayName: "Q", kind: "openai-compatible", baseUrl: "https://host/v1?api_key=sk-proj-abc123def456" }, new Set()).error ?? "",
      /secret/i,
    );
  });

  test("rejects an agent id that is itself secret-shaped", () => {
    const { def, error } = validateAgentDefinition(
      { id: "AKIAIOSFODNN7EXAMPLE", kind: "openai-compatible", baseUrl: "https://x/v1" },
      new Set(),
    );
    assert.equal(def, undefined);
    assert.match(error ?? "", /secret/i);
  });

  test("rejects duplicate id, missing baseUrl, missing command/argsTemplate, bad kind", () => {
    assert.match(validateAgentDefinition({ id: "codex", displayName: "X", kind: "openai-compatible", baseUrl: "https://x/v1" }, new Set(["codex"])).error ?? "", /id/);
    assert.match(validateAgentDefinition({ id: "a", displayName: "A", kind: "openai-compatible" }, new Set()).error ?? "", /baseUrl/);
    assert.match(validateAgentDefinition({ id: "b", displayName: "B", kind: "cli-template", command: "tool" }, new Set()).error ?? "", /argsTemplate/);
    assert.match(validateAgentDefinition({ id: "c", displayName: "C", kind: "totally-fake" }, new Set()).error ?? "", /kind/);
  });

  test("mergeAgentDefinitions overrides a built-in by id and appends new heads", () => {
    const raw = [
      { id: "codex", displayName: "Codex (custom cmd)", kind: "codex", command: "codex-wrapper" },
      { id: "ollama-qwen", displayName: "Qwen", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
      { id: "bogus", displayName: "Bogus", kind: "openai-compatible" }, // dropped: no baseUrl
    ];
    const { defs, warnings } = mergeAgentDefinitions([...BUILTIN_AGENT_DEFINITIONS], raw);
    const ids = defs.map((d) => d.id);
    assert.deepEqual(ids, ["codex", "claude", "gemini", "ollama-qwen"]);
    assert.equal(defs.find((d) => d.id === "codex")?.command, "codex-wrapper");
    assert.equal(defs.find((d) => d.id === "codex")?.colorIndex, 1); // registry order preserved
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /bogus/);
  });
});
