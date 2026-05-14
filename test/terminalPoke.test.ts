import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { buildDirectTerminalPokePrompt } from "../src/terminalPoke";

describe("direct terminal poke prompts", () => {
  test("speaks to one native CLI endpoint without invoking the full room loop", () => {
    const prompt = buildDirectTerminalPokePrompt({
      agent: "codex",
      otherAgent: "claude",
      roomContext: "--- Current terminal poke context ---\n[user] ship it",
      instruction: "Patch the terminal bridge.",
      editorContext: {
        label: "src/terminalBridge.ts",
        languageId: "typescript",
        selected: true,
        startLine: 10,
        endLine: 12,
        text: "callAgent();",
        originalChars: 12,
        truncated: false,
      },
      workspaceDiff: "diff --git a/a.ts b/a.ts\n+changed",
      latestDecisionDefault: "Codex patches, Claude reviews.",
      latestVerificationSummary: "npm test passed",
    });

    assert.match(prompt, /direct native-terminal poke/);
    assert.match(prompt, /directly to your native Codex CLI endpoint/);
    assert.match(prompt, /Do not wait for Claude/);
    assert.match(prompt, /Patch the terminal bridge/);
    assert.match(prompt, /Active editor context/);
    assert.match(prompt, /src\/terminalBridge\.ts/);
    assert.match(prompt, /callAgent\(\);/);
    assert.match(prompt, /Working tree diff/);
    assert.match(prompt, /\+changed/);
    assert.match(prompt, /Latest verification: npm test passed/);
  });
});
