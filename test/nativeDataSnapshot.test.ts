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

  test("redacts extended secret key patterns", () => {
    assert.deepEqual(redactedJson({
      privateKey: "PEM",
      private_key: "PEM",
      sshKey: "rsa",
      ssh_key: "rsa",
      passphrase: "open",
      signature: "abc",
      cookie: "session",
      // Non-secret cousins should pass through unchanged.
      cookieName: "tasty",
      privateKeyId: "id",
      ok: "visible",
    }), {
      privateKey: "[REDACTED]",
      private_key: "[REDACTED]",
      sshKey: "[REDACTED]",
      ssh_key: "[REDACTED]",
      passphrase: "[REDACTED]",
      signature: "[REDACTED]",
      cookie: "[REDACTED]",
      // Substring match still redacts these — that's the intentional fail-closed
      // behavior: better to over-redact a benign field than leak a near-miss.
      cookieName: "[REDACTED]",
      privateKeyId: "[REDACTED]",
      ok: "visible",
    });
  });

  test("redacts inline header-credential shapes on a hydraRoom.agents-style headers map", () => {
    // Why: a custom `hydraRoom.agents` head can carry inline `headers`
    // credentials if a user bypasses validation via user-settings; if that
    // definition is ever serialized into a generated snapshot/support
    // bundle, these header names must not leak the credential value.
    const out = redactedJson({
      headers: {
        Authorization: "Bearer sk-secret",
        "X-Api-Key": "sk-secret",
        "X-Auth-Key": "sk-secret",
        Authentication: "sk-secret",
        "WWW-Authenticate": "sk-secret",
        Auth: "sk-secret",
      },
      apiKeyEnv: "OPENAI_API_KEY",
    }) as { headers: Record<string, string>; apiKeyEnv: string };
    assert.deepEqual(out.headers, {
      Authorization: "[REDACTED]",
      "X-Api-Key": "[REDACTED]",
      "X-Auth-Key": "[REDACTED]",
      Authentication: "[REDACTED]",
      "WWW-Authenticate": "[REDACTED]",
      Auth: "[REDACTED]",
    });
    // apiKeyEnv is an env-var NAME, not a secret, but is redacted defensively too.
    assert.equal(out.apiKeyEnv, "[REDACTED]");
  });

  test("does not over-redact benign auth-adjacent fields", () => {
    // Guards the new bare-"auth" coverage against catching unrelated fields
    // like a git commit author.
    assert.deepEqual(redactedJson({ author: "Jane Doe", authorId: "123" }), {
      author: "Jane Doe",
      authorId: "123",
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
