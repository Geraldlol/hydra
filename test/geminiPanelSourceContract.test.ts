import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";

const root = process.cwd();

describe("Gemini panel transport source contract", () => {
  test("ships stdin headless JSON defaults for every phase", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
    };
    const properties = pkg.contributes.configuration.properties;
    for (const phase of ["Discussion", "Build", "Review"]) {
      assert.deepEqual(
        properties[`hydraRoom.geminiExecArgs${phase}`]?.default,
        ["--output-format", "json"],
      );
    }
  });

  test("detects, normalizes, and records explicitly requested Gemini JSON", () => {
    const source = fs.readFileSync(path.join(root, "src", "panel.ts"), "utf8");
    const prepareStart = source.indexOf("private async prepareOneShotRequestFiles(");
    const prepareEnd = source.indexOf("private prepareTerminalBridgeSpawn(", prepareStart);
    const normalizeStart = source.indexOf("private async normalizeOneShotResult(");
    const normalizeEnd = source.indexOf("private async normalizeTerminalBridgeResult(", normalizeStart);
    const usageStart = source.indexOf("private async extractAndRecordUsage(");
    const usageEnd = source.indexOf("private async buildNextPromptPreviewEnvelope(", usageStart);
    assert.ok(prepareStart >= 0 && prepareEnd > prepareStart);
    assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart);
    assert.ok(usageStart >= 0 && usageEnd > usageStart);

    const prepare = source.slice(prepareStart, prepareEnd);
    assert.match(prepare, /agentKind === "gemini" && shouldUseGeminiJson\(spawn\.args\)/);
    assert.match(prepare, /\? "geminiJson"/);

    const normalize = source.slice(normalizeStart, normalizeEnd);
    assert.match(normalize, /prepared\.outputMode === "geminiJson"/);
    assert.match(normalize, /adapterForKind\(definition\.kind\)\.parseReply/);

    const usage = source.slice(usageStart, usageEnd);
    assert.match(usage, /agentKind === "gemini" && outputMode === "geminiJson"/);
    assert.match(usage, /adapterForKind\(definition\.kind\)\.parseUsage/);
    assert.match(usage, /source: "geminiJson"/);
  });

  test("never streams or mirrors Gemini's single protocol envelope", () => {
    const liveText = fs.readFileSync(path.join(root, "src", "liveText.ts"), "utf8");
    const liveChannel = fs.readFileSync(path.join(root, "src", "liveChannel.ts"), "utf8");
    assert.match(liveText, /mode === "geminiJson"\) return SUPPRESS_LIVE_TEXT/);
    assert.match(liveChannel, /outputMode === "geminiJson"\) return undefined/);
  });
});
