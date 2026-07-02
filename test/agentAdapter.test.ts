import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { KNOWN_AGENT_KINDS, isAgentKind } from "../src/agentAdapter";

describe("agent adapter contract", () => {
  test("KNOWN_AGENT_KINDS lists the five kinds in spec order", () => {
    assert.deepEqual(
      [...KNOWN_AGENT_KINDS],
      ["codex", "claude", "gemini", "openai-compatible", "cli-template"],
    );
  });

  test("isAgentKind narrows only known kinds", () => {
    assert.equal(isAgentKind("gemini"), true);
    assert.equal(isAgentKind("codex"), true);
    assert.equal(isAgentKind("ollama-qwen"), false);
    assert.equal(isAgentKind(""), false);
  });
});
