import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { renderSessionBrief, sessionBriefPath, writeSessionBrief } from "../src/sessionBrief";

describe("session brief", () => {
  test("resolves the workspace session brief path", () => {
    assert.equal(sessionBriefPath("/repo"), path.join("/repo", ".hydra", "session-brief.md"));
  });

  test("renders the operational snapshot", () => {
    const markdown = renderSessionBrief({
      generatedAt: "2026-05-09T12:00:00.000Z",
      workspaceRoot: "/repo",
      phaseLabel: "Awaiting user",
      transport: "terminalBridge",
      objective: "Ship Hydra.",
      latestDecision: {
        timestamp: "2026-05-09T12:00:00.000Z",
        agent: "codex",
        phase: "closer",
        recommendation: "Patch the bridge.",
        defaultNextAction: "Codex builds.",
        decisionNeededFromUser: "none",
        blockers: "none",
        sourceMessageTimestamp: "2026-05-09T11:59:59.000Z",
      },
      latestVerification: {
        timestamp: "2026-05-09T12:01:00.000Z",
        command: "npm test",
        cwd: "/repo",
        exitCode: 0,
        timedOut: false,
        durationMs: 2000,
        stdout: "ok",
        stderr: "",
      },
      workQueue: [{
        id: "w1",
        kind: "decision",
        severity: "info",
        title: "Accept Default",
        detail: "Codex builds.",
        actionType: "acceptDefaultDecision",
        actionLabel: "Accept",
      }],
      recentNativeActions: [{
        id: "n1",
        timestamp: "2026-05-09T12:02:00.000Z",
        agents: ["codex", "claude"],
        instruction: "Review it.",
        includeEditorContext: true,
        includeWorkspaceDiff: false,
        promptEnvelopeIds: ["p1"],
        status: "completed",
      }],
      recentMessages: [{
        role: "user",
        text: "Next pass.",
        timestamp: "2026-05-09T12:03:00.000Z",
      }],
    });

    assert.match(markdown, /# Hydra Session Brief/);
    assert.match(markdown, /Objective\n\nShip Hydra\./);
    assert.match(markdown, /\[info\] Accept Default: Codex builds\./);
    assert.match(markdown, /Default next action: Codex builds\./);
    assert.match(markdown, /Status: passed/);
    assert.match(markdown, /completed: Codex \+ Claude \(editor\) - Review it\./);
    assert.match(markdown, /You: Next pass\./);
  });

  test("writes the brief to disk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-session-brief-"));
    const file = sessionBriefPath(dir);
    await writeSessionBrief(file, "# Brief\n");
    assert.equal(await fs.readFile(file, "utf8"), "# Brief\n");
  });
});
