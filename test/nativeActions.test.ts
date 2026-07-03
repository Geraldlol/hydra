import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendNativeAction,
  collectNativeSessionHints,
  ensureNativeActionsFile,
  nativeActionsPath,
  nativeActionSummary,
  readNativeActions,
  writeNativeActions,
  type NativeActionReceipt,
} from "../src/nativeActions";
import { displayNameFor } from "../src/agentRegistry";

describe("native action receipts", () => {
  test("resolves the workspace-native action log path", () => {
    assert.equal(
      nativeActionsPath(path.join("C:", "repo")),
      path.join("C:", "repo", ".hydra", "native-actions.jsonl")
    );
  });

  test("creates, appends, and reads native action receipts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-native-actions-"));
    const file = path.join(dir, ".hydra", "native-actions.jsonl");

    await ensureNativeActionsFile(file);
    assert.deepEqual(await readNativeActions(file), []);

    const receipt: NativeActionReceipt = {
      id: "action-1",
      timestamp: "2026-05-09T20:00:00.000Z",
      agents: ["codex", "claude"],
      instruction: "Review the current diff.",
      includeEditorContext: true,
      includeWorkspaceDiff: true,
      editorContext: {
        label: "src/panel.ts",
        selected: false,
        startLine: 1,
        endLine: 200,
        chars: 1200,
        originalChars: 1200,
        truncated: false,
      },
      workspaceDiffChars: 2400,
      promptEnvelopeIds: ["env-1", "env-2"],
      nativeSessionHints: [{
        agent: "claude",
        source: "claude-live-session",
        sessionId: "claude-session",
        status: "idle",
        kind: "interactive",
        entrypoint: "cli",
        updatedAt: "2026-05-09T20:01:00.000Z",
        pathLabel: "123.json",
      }],
      status: "completed",
    };

    await appendNativeAction(file, receipt);
    await fs.appendFile(file, "\nnot json\n", "utf8");

    assert.deepEqual(await readNativeActions(file), [receipt]);
  });

  test("summarizes the latest native action receipt", () => {
    assert.equal(nativeActionSummary(undefined), "No native actions yet");
    assert.equal(
      nativeActionSummary({
        id: "action-1",
        timestamp: "2026-05-09T20:00:00.000Z",
        agents: ["codex"],
        instruction: "Inspect this file.",
        includeEditorContext: true,
        includeWorkspaceDiff: false,
        promptEnvelopeIds: ["env-1"],
        status: "failed",
      }),
      "failed: Codex (editor)"
    );
    // Before this task, nativeActionSummary's agent-name ternary mislabeled
    // any non-codex agent (including gemini) as "Claude".
    assert.equal(
      nativeActionSummary({
        id: "action-2",
        timestamp: "2026-05-09T20:00:00.000Z",
        agents: ["gemini"],
        instruction: "Inspect this file.",
        includeEditorContext: false,
        includeWorkspaceDiff: false,
        promptEnvelopeIds: ["env-2"],
        status: "completed",
      }),
      "completed: Gemini"
    );
  });

  test("rewrites native action receipts after clearing rows", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-native-actions-clear-"));
    const file = path.join(dir, ".hydra", "native-actions.jsonl");
    const first: NativeActionReceipt = {
      id: "action-1",
      timestamp: "2026-05-09T20:00:00.000Z",
      agents: ["codex"],
      instruction: "Keep me.",
      includeEditorContext: false,
      includeWorkspaceDiff: false,
      promptEnvelopeIds: ["env-1"],
      status: "completed",
    };
    const second: NativeActionReceipt = {
      id: "action-2",
      timestamp: "2026-05-09T20:01:00.000Z",
      agents: ["claude"],
      instruction: "Clear me.",
      includeEditorContext: false,
      includeWorkspaceDiff: false,
      promptEnvelopeIds: ["env-2"],
      status: "failed",
    };

    await writeNativeActions(file, [first, second]);
    await writeNativeActions(file, (await readNativeActions(file)).filter((action) => action.id !== "action-2"));

    assert.deepEqual(await readNativeActions(file), [first]);
  });

  test("collects redacted native session hints", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-native-session-hints-"));
    const codexDir = path.join(home, ".codex");
    const claudeSessionsDir = path.join(home, ".claude", "sessions");
    await fs.mkdir(codexDir, { recursive: true });
    await fs.mkdir(claudeSessionsDir, { recursive: true });
    await fs.writeFile(path.join(codexDir, "session_index.jsonl"), [
      JSON.stringify({ id: "codex-old", thread_name: "ignored", updated_at: "2026-05-09T19:00:00.000Z" }),
      JSON.stringify({ id: "codex-new", thread_name: "ignored", updated_at: "2026-05-09T20:00:00.000Z" }),
      "",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(claudeSessionsDir, "111.json"), JSON.stringify({
      sessionId: "claude-match",
      cwd: path.join("C:", "repo"),
      status: "idle",
      kind: "interactive",
      entrypoint: "cli",
      updatedAt: 1778415678408,
    }), "utf8");
    await fs.writeFile(path.join(claudeSessionsDir, "222.json"), JSON.stringify({
      sessionId: "claude-other",
      cwd: path.join("C:", "elsewhere"),
      status: "idle",
    }), "utf8");

    const hints = await collectNativeSessionHints(path.join("C:", "repo"), ["codex", "claude"], home);

    assert.deepEqual(hints.map((hint) => [hint.agent, hint.source, hint.sessionId]), [
      ["codex", "codex-session-index", "codex-old"],
      ["codex", "codex-session-index", "codex-new"],
      ["claude", "claude-live-session", "claude-match"],
    ]);
    assert.equal(hints.find((hint) => hint.agent === "claude")?.pathLabel, "111.json");
  });
});

describe("multi-head display labels", () => {
  test("a gemini head is labeled Gemini, not Claude", () => {
    // Before this task, agent === "codex" ? "Codex" : "Claude" mislabeled gemini.
    assert.equal(displayNameFor("gemini"), "Gemini");
    assert.equal(displayNameFor("codex"), "Codex");
    assert.equal(displayNameFor("claude"), "Claude");
  });
});
