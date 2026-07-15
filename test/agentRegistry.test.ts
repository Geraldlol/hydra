import { afterEach, describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  BUILTIN_AGENT_DEFINITIONS,
  listAgentDefinitions,
  getAgentDefinition,
  displayNameFor,
  assignColorIndexes,
  reloadAgentDefinitions,
  agentDefinitionWarnings,
} from "../src/agentRegistry";

const vscodeStub = require("vscode") as typeof import("vscode") & {
  currentConfig: Record<string, unknown>;
};

afterEach(() => {
  delete vscodeStub.currentConfig.agents;
  reloadAgentDefinitions();
});

describe("agent registry", () => {
  test("ships codex, claude, gemini built-ins", () => {
    const ids = BUILTIN_AGENT_DEFINITIONS.map((d) => d.id);
    assert.deepEqual(ids, ["codex", "claude", "gemini"]);
  });

  test("built-in kinds map one-to-one", () => {
    assert.equal(getAgentDefinition("codex")?.kind, "codex");
    assert.equal(getAgentDefinition("claude")?.kind, "claude");
    assert.equal(getAgentDefinition("gemini")?.kind, "gemini");
  });

  test("colorIndex is assigned by registry order (codex=1, claude=2, gemini=3)", () => {
    const withColors = assignColorIndexes([...BUILTIN_AGENT_DEFINITIONS]);
    assert.equal(withColors[0]?.colorIndex, 1);
    assert.equal(withColors[1]?.colorIndex, 2);
    assert.equal(withColors[2]?.colorIndex, 3);
  });

  test("automatic color indexes wrap across the eight-color head ramp", () => {
    const defs = Array.from({ length: 10 }, (_, i) => ({
      id: `head-${i}`,
      displayName: `Head ${i}`,
      kind: "codex" as const,
    }));
    const withColors = assignColorIndexes(defs);
    assert.deepEqual(withColors.map((def) => def.colorIndex), [1, 2, 3, 4, 5, 6, 7, 8, 1, 2]);
  });

  test("displayNameFor falls back to the id for unknown heads", () => {
    assert.equal(displayNameFor("codex"), "Codex");
    assert.equal(displayNameFor("gemini"), "Gemini");
    assert.equal(displayNameFor("ollama-qwen"), "ollama-qwen");
  });

  test("listAgentDefinitions returns built-ins when no user agents configured", () => {
    assert.deepEqual(listAgentDefinitions().map((d) => d.id), ["codex", "claude", "gemini"]);
  });
});

describe("registry user-agent merge", () => {
  test("reloadAgentDefinitions + agentDefinitionWarnings exist and default clean", () => {
    reloadAgentDefinitions();
    // With no hydraRoom.agents configured (test stub), built-ins only and no warnings.
    assert.deepEqual(listAgentDefinitions().map((d) => d.id), ["codex", "claude", "gemini"]);
    assert.deepEqual(agentDefinitionWarnings(), []);
  });

  test("automatically refreshes when the configured agent roster changes", () => {
    vscodeStub.currentConfig.agents = [
      { id: "local-a", displayName: "Local A", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
    ];
    assert.ok(getAgentDefinition("local-a"));

    vscodeStub.currentConfig.agents = [
      { id: "local-b", displayName: "Local B", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
    ];
    assert.equal(getAgentDefinition("local-a"), undefined);
    assert.ok(getAgentDefinition("local-b"));
  });
});
