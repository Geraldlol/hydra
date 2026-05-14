import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import {
  nativeDataSnapshotPath,
  redactedJson,
  renderNativeDataSnapshot,
  writeNativeDataSnapshot,
} from "../src/nativeDataSnapshot";

describe("native data snapshot", () => {
  test("resolves the workspace snapshot path", () => {
    assert.equal(nativeDataSnapshotPath("/repo"), path.join("/repo", ".hydra", "native-data-snapshot.md"));
  });

  test("redacts sensitive keys recursively", () => {
    assert.deepEqual(redactedJson({
      token: "secret",
      nested: { apiKey: "secret", ok: "visible" },
      list: [{ refresh_token: "secret" }],
    }), {
      token: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", ok: "visible" },
      list: [{ refresh_token: "[REDACTED]" }],
    });
  });

  test("renders redacted native data summaries", () => {
    const markdown = renderNativeDataSnapshot({
      generatedAt: "2026-05-10T12:00:00.000Z",
      workspaceRoot: "/repo",
      codex: {
        home: "/home/user/.codex",
        config: { model: "gpt-5.5", windows: { sandbox: "elevated" } },
        enabledPlugins: ["github@openai-curated"],
        trustedWorkspace: true,
        modelCatalog: {
          fetchedAt: "now",
          clientVersion: "0.130.0",
          count: 1,
          models: [{
            slug: "gpt-5.5",
            displayName: "GPT-5.5",
            defaultReasoning: "medium",
            supportedReasoning: ["low", "medium", "high", "xhigh"],
            contextWindow: 272000,
            maxContextWindow: 1000000,
            serviceTiers: ["priority"],
            inputModalities: ["text", "image"],
            supportsSearch: true,
            supportsImages: true,
            supportsParallelTools: true,
            supportsVerbosity: true,
            applyPatchToolType: "freeform",
            webSearchToolType: "text_and_image",
          }],
        },
        stateTables: [{ name: "threads", rows: 1, columns: ["id", "title"] }],
        logsTables: [],
        sessionCount: 2,
        skillNames: ["openai-docs"],
      },
      claude: {
        home: "/home/user/.claude",
        settings: { enabledPlugins: { "superpowers@claude-plugins-official": true } },
        localSettings: { mcpServers: { salesforce: "[configured]" } },
        enabledPlugins: ["superpowers@claude-plugins-official"],
        installedPlugins: ["superpowers@claude-plugins-official"],
        marketplaces: ["claude-plugins-official"],
        mcpServerNames: ["salesforce"],
        policyLimits: { restrictions: {} },
        liveSessions: [{ sessionId: "abc", cwd: "/repo", kind: "terminal", status: "running" }],
        projectCount: 1,
        projectTranscriptCount: 2,
        projectSummaries: [{
          project: "C--repo",
          transcriptCount: 2,
          subagentTranscriptCount: 3,
          subagentMetaCount: 1,
          sessionIds: ["abc"],
          firstEventTypes: ["last-prompt"],
          firstEventKeys: ["leafUuid", "sessionId", "type"],
          subagentTypes: ["general-purpose"],
        }],
        skillNames: ["monday-ticket-inbox"],
        commandNames: ["monday-tickets"],
      },
    });

    assert.match(markdown, /# Hydra Native Data Snapshot/);
    assert.match(markdown, /Trusted workspace: yes/);
    assert.match(markdown, /github@openai-curated/);
    assert.match(markdown, /gpt-5\.5/);
    assert.match(markdown, /reasoning=medium \[low, medium, high, xhigh\]/);
    assert.match(markdown, /### Codex Model Capability Matrix/);
    assert.match(markdown, /Search-capable: gpt-5\.5/);
    assert.match(markdown, /Apply patch tool: gpt-5\.5:freeform/);
    assert.match(markdown, /threads: rows=1/);
    assert.match(markdown, /MCP servers: salesforce/);
    assert.match(markdown, /### Claude Projects/);
    assert.match(markdown, /C--repo: transcripts=2, subagentTranscripts=3, subagentMeta=1/);
    assert.match(markdown, /subagentTypes=general-purpose/);
    assert.match(markdown, /Credential files, auth tokens/);
  });

  test("writes the snapshot to disk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-native-data-"));
    const file = nativeDataSnapshotPath(dir);
    await writeNativeDataSnapshot(file, "# Native Data\n");
    assert.equal(await fs.readFile(file, "utf8"), "# Native Data\n");
  });
});
