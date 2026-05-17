import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("codex transport source contracts", () => {
  test("Codex last-message capture is not disabled by unrelated -o flags", () => {
    // The guard previously lived in panel.ts; it moved to codexTransport.ts
    // when the agent transport cluster was extracted. The regression we
    // care about — a bare `-o` flag (unrelated to --output-last-message)
    // must not be treated as a duplicate of it — is checked by grepping
    // the function body in whichever module owns it.
    const source = fs.readFileSync(path.join(process.cwd(), "src", "codexTransport.ts"), "utf8");
    const guardStart = source.indexOf("export function shouldCaptureCodexLastMessage");
    const guardEnd = source.indexOf("export function withCodexLastMessageArgs", guardStart);
    assert.ok(guardStart >= 0 && guardEnd > guardStart);

    const guard = source.slice(guardStart, guardEnd);
    assert.match(guard, /spawn\.args\.includes\("--output-last-message"\)/);
    assert.doesNotMatch(guard, /spawn\.args\.includes\("-o"\)/);
  });
});

describe("terminal bridge usage source contracts", () => {
  test("terminal bridge usage is extracted from the raw log output", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const branchStart = source.indexOf("if (forceTerminalBridge || this.transportMode() === \"terminalBridge\")");
    const branchEnd = source.indexOf("const prepared = await this.prepareOneShotRequestFiles", branchStart);
    assert.ok(branchStart >= 0 && branchEnd > branchStart);

    const branch = source.slice(branchStart, branchEnd);
    assert.match(branch, /const terminalPrepared = this\.prepareTerminalBridgeSpawn\(agent, spawn\)/);
    assert.match(branch, /result: await this\.terminalBridgeUsageResult\(normalized\)/);
    assert.match(branch, /outputMode: terminalPrepared\.outputMode/);
    assert.doesNotMatch(branch, /outputMode: "passthrough"/);
  });
});
