import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import {
  extractNativeIntegrationSummary,
  nativeCapabilitiesPath,
  readNativeIntegrationSummary,
  renderNativeCapabilitySnapshot,
  shouldIncludeNativeIntegrationSummary,
  writeNativeCapabilities,
} from "../src/nativeCapabilities";

describe("native capability snapshot", () => {
  test("resolves the workspace snapshot path", () => {
    assert.equal(nativeCapabilitiesPath("/repo"), path.join("/repo", ".hydra", "native-capabilities.md"));
  });

  test("renders probe results", () => {
    const markdown = renderNativeCapabilitySnapshot({
      generatedAt: "2026-05-10T12:00:00.000Z",
      workspaceRoot: "/repo",
      probes: [{
        agent: "codex",
        label: "help",
        command: "codex",
        args: ["--help"],
        cwd: "/repo",
        exitCode: 0,
        timedOut: false,
        durationMs: 25,
        output: "Usage: codex [OPTIONS]",
      }, {
        agent: "claude",
        label: "plugin list json",
        command: "claude",
        args: ["plugin", "list", "--json"],
        cwd: "/repo",
        exitCode: 0,
        timedOut: false,
        durationMs: 30,
        output: "{\"plugins\":[{\"name\":\"superpowers\"}]}",
      }, {
        agent: "codex",
        label: "mcp list json",
        command: "codex",
        args: ["mcp", "list", "--json"],
        cwd: "/repo",
        exitCode: 0,
        timedOut: false,
        durationMs: 18,
        output: "{\"servers\":{\"github\":{\"command\":\"npx\"}}}",
      }],
    });

    assert.match(markdown, /# Hydra Native Capability Snapshot/);
    assert.match(markdown, /## Integration Probe Summary/);
    assert.match(markdown, /Claude plugin list json: ok, output=\d+ chars, plugins=1 \[superpowers\]/);
    assert.match(markdown, /Codex mcp list json: ok, output=\d+ chars, servers=1 \[github\]/);
    assert.match(markdown, /## Codex help/);
    assert.match(markdown, /Args: --help/);
    assert.match(markdown, /Exit code: 0/);
    assert.match(markdown, /Usage: codex/);
  });

  test("writes the snapshot to disk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-native-capabilities-"));
    const file = nativeCapabilitiesPath(dir);
    await writeNativeCapabilities(file, "# Native\n");
    assert.equal(await fs.readFile(file, "utf8"), "# Native\n");
  });

  test("extracts integration summary for prompt context", async () => {
    const markdown = [
      "# Hydra Native Capability Snapshot",
      "",
      "## Integration Probe Summary",
      "",
      "- Codex mcp list json: ok, output=40 chars, servers=1 [github]",
      "- Claude plugin list json: ok, output=36 chars, plugins=1 [superpowers]",
      "",
      "## Codex help",
      "",
      "raw help",
    ].join("\n");
    assert.equal(
      extractNativeIntegrationSummary(markdown),
      "- Codex mcp list json: ok, output=40 chars, servers=1 [github]\n- Claude plugin list json: ok, output=36 chars, plugins=1 [superpowers]"
    );

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-native-integration-"));
    const file = path.join(dir, "native-capabilities.md");
    await fs.writeFile(file, markdown, "utf8");
    assert.match(await readNativeIntegrationSummary(file, 80), /Codex mcp list json/);
    assert.match(await readNativeIntegrationSummary(file, 80), /\[truncated\]/);
  });

  test("detects when integration prompt context is relevant", () => {
    assert.equal(shouldIncludeNativeIntegrationSummary("Check MCP server auth."), true);
    assert.equal(shouldIncludeNativeIntegrationSummary("Install the Claude plugin from marketplace."), true);
    assert.equal(shouldIncludeNativeIntegrationSummary("Feature flags affect this connected tool."), true);
    assert.equal(shouldIncludeNativeIntegrationSummary("Refactor the room footer layout."), false);
    assert.equal(shouldIncludeNativeIntegrationSummary(undefined, ""), false);
  });
});
