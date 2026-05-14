import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { renderSupportBundle, supportBundlePath, writeSupportBundle } from "../src/supportBundle";

const authority = {
  authority: {
    level: "workspaceWrite" as const,
    label: "Workspace write",
    detail: "Can edit files in the workspace.",
    warnings: [],
  },
  profile: {
    id: "nativeDiscussion" as const,
    label: "Native discussion",
    detail: "Uses native CLI args.",
  },
};

describe("support bundle", () => {
  test("resolves the workspace support bundle path", () => {
    assert.equal(supportBundlePath("/repo"), path.join("/repo", ".hydra", "support-bundle.md"));
  });

  test("renders diagnostics sections", () => {
    const markdown = renderSupportBundle({
      generatedAt: "2026-05-09T12:00:00.000Z",
      workspaceRoot: "/repo",
      phaseLabel: "Awaiting user",
      transport: "terminalBridge",
      doctorReport: {
        ok: true,
        createdAt: "2026-05-09T11:59:00.000Z",
        summary: "Hydra Doctor passed.",
        checks: [{ id: "workspace", label: "Workspace folder", status: "pass", detail: "/repo" }],
      },
      authoritySummaries: { codex: authority, claude: authority },
      nativeRuntime: [{
        agent: "codex",
        phase: "opener",
        command: "codex",
        args: ["exec", "--full-auto"],
        cwd: "/repo",
        envKeys: ["DOTNET_ROOT", "Path"],
        pathOverride: true,
      }],
      nativeData: {
        codexTrustedWorkspace: true,
        codexModelCount: 2,
        codexModels: ["gpt-5.5", "gpt-5.4"],
        codexSearchModels: ["gpt-5.5"],
        codexImageModels: ["gpt-5.5"],
        codexParallelToolModels: ["gpt-5.5", "gpt-5.4"],
        codexVerbosityModels: ["gpt-5.5"],
        codexApplyPatchModels: ["gpt-5.5:freeform"],
        codexServiceTierModels: ["gpt-5.5:priority"],
        codexEnabledPlugins: ["github@openai-curated"],
        codexSkillNames: ["openai-docs"],
        codexSessionCount: 7,
        codexStateTables: ["threads(3)"],
        claudeEnabledPlugins: ["superpowers@claude-plugins-official"],
        claudeInstalledPlugins: ["superpowers@claude-plugins-official"],
        claudeMarketplaces: ["claude-plugins-official"],
        claudeMcpServerNames: ["salesforce-dx"],
        claudeSkillNames: ["monday-ticket-inbox"],
        claudeCommandNames: ["monday-tickets"],
        claudeLiveSessionCount: 1,
        claudeProjectCount: 2,
        claudeProjectTranscriptCount: 3,
        claudeProjectSummaries: ["C--repo: transcripts=2, subagents=3, meta=1, types=general-purpose"],
      },
      terminalSessions: [{
        agent: "codex",
        terminalName: "Hydra Codex",
        state: "ready",
        detail: "Ready",
        updatedAt: "2026-05-09T12:00:00.000Z",
        currentCommand: "codex exec -",
      }],
      latestDecision: {
        timestamp: "2026-05-09T12:00:00.000Z",
        agent: "claude",
        phase: "reactor",
        recommendation: "Run tests.",
        defaultNextAction: "Hydra runs verification.",
        decisionNeededFromUser: "none",
        blockers: "none",
        sourceMessageTimestamp: "2026-05-09T11:59:59.000Z",
      },
      latestVerification: {
        timestamp: "2026-05-09T12:01:00.000Z",
        command: "npm test",
        cwd: "/repo",
        exitCode: 1,
        timedOut: false,
        durationMs: 1500,
        stdout: "fail",
        stderr: "",
      },
      workQueue: [],
      recentNativeActions: [],
      recentEvents: [{
        timestamp: "2026-05-09T12:01:30.000Z",
        kind: "terminalSessionChanged",
        agent: "codex",
        phase: "opener",
        detail: "opener replied",
        data: { state: "replied", hasError: false },
      }],
      recentMessages: [{
        role: "codex",
        phase: "opener",
        text: "Investigating terminal bridge.",
        timestamp: "2026-05-09T12:02:00.000Z",
      }],
    });

    assert.match(markdown, /# Hydra Support Bundle/);
    assert.match(markdown, /Hydra Doctor passed/);
    assert.match(markdown, /## Native Authority/);
    assert.match(markdown, /Workspace write/);
    assert.match(markdown, /## Native Runtime/);
    assert.match(markdown, /### Codex opener/);
    assert.match(markdown, /Env keys: DOTNET_ROOT, Path/);
    assert.match(markdown, /PATH override: yes/);
    assert.match(markdown, /## Native Data/);
    assert.match(markdown, /Trusted workspace: yes/);
    assert.match(markdown, /Models: 2 \(gpt-5\.5, gpt-5\.4\)/);
    assert.match(markdown, /Search-capable models: gpt-5\.5/);
    assert.match(markdown, /Apply-patch modes: gpt-5\.5:freeform/);
    assert.match(markdown, /MCP servers: salesforce-dx/);
    assert.match(markdown, /Project transcript files: 3/);
    assert.match(markdown, /Project metadata: C--repo: transcripts=2, subagents=3, meta=1, types=general-purpose/);
    assert.match(markdown, /## Terminal Sessions/);
    assert.match(markdown, /Command: codex exec -/);
    assert.match(markdown, /Default next action: Hydra runs verification\./);
    assert.match(markdown, /Status: failed/);
    assert.match(markdown, /## Recent Events/);
    assert.match(markdown, /terminalSessionChanged \(Codex\/opener\): opener replied \[state=replied, hasError=false\]/);
    assert.match(markdown, /Codex \(opener\): Investigating terminal bridge\./);
  });

  test("writes the support bundle to disk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-support-bundle-"));
    const file = supportBundlePath(dir);
    await writeSupportBundle(file, "# Support\n");
    assert.equal(await fs.readFile(file, "utf8"), "# Support\n");
  });
});
