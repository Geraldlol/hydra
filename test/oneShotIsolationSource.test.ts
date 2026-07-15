import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("one-shot request artifact isolation source contracts", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");

  test("prepares request files beneath workspace-specific extension storage", () => {
    const start = source.indexOf("private async prepareOneShotRequestFiles(");
    const end = source.indexOf("private prepareTerminalBridgeSpawn(", start);
    assert.ok(start >= 0 && end > start, "could not bound prepareOneShotRequestFiles");
    const method = source.slice(start, end);
    assert.match(method, /const artifactRoot = this\.oneShotArtifactRoot\(\)/);
    assert.match(method, /terminalProtocolStoragePaths\(artifactRoot,/);
    assert.match(method, /this\.prepareOneShotArtifactBoundary\(artifactRoot\)/);
    assert.match(method, /createPrivateArtifact\(/);
    assert.doesNotMatch(method, /terminalProtocolPaths\(this\.workspaceRoot/);
    assert.doesNotMatch(method, /fs\.writeFile\(/);
    const helperStart = source.indexOf("private async prepareOneShotArtifactBoundary(");
    const helperEnd = source.indexOf("private createTerminalBridge(", helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart);
    assert.match(source.slice(helperStart, helperEnd), /preparePrivateArtifactRoot\(/);
  });

  test("bounds reply reads and cleans every prepared artifact in a finally block", () => {
    const pipelineStart = source.indexOf("private async runOneShotPipeline(");
    const pipelineEnd = source.indexOf("private async runHttpPipeline(", pipelineStart);
    const normalizeStart = source.indexOf("private async normalizeOneShotResult(");
    const normalizeEnd = source.indexOf("private async normalizeTerminalBridgeResult(", normalizeStart);
    assert.ok(pipelineStart >= 0 && pipelineEnd > pipelineStart);
    assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart);
    const pipeline = source.slice(pipelineStart, pipelineEnd);
    const normalize = source.slice(normalizeStart, normalizeEnd);
    assert.match(pipeline, /finally \{[\s\S]*cleanupPrivateArtifacts\(privatePaths, prepared\.privateArtifacts\.boundary\)/);
    assert.match(normalize, /readPrivateArtifactUtf8\(/);
    assert.match(normalize, /MAX_AGENT_STDOUT_BYTES/);
    assert.doesNotMatch(normalize, /fs\.readFile\(prepared\.replyPath/);
  });

  test("durable traces contain redacted labels and argv, not private absolute paths", () => {
    const prepareStart = source.indexOf("private async prepareOneShotRequestFiles(");
    const prepareEnd = source.indexOf("private prepareTerminalBridgeSpawn(", prepareStart);
    const pipelineStart = source.indexOf("private async runOneShotPipeline(");
    const pipelineEnd = source.indexOf("private async runHttpPipeline(", pipelineStart);
    const prepare = source.slice(prepareStart, prepareEnd);
    const pipeline = source.slice(pipelineStart, pipelineEnd);
    assert.match(prepare, /promptPath: `\[private extension storage\]\/\$\{path\.basename\(paths\.promptPath\)\}`/);
    assert.match(pipeline, /args: redactPrivateArtifactArgs\(spawn\.args, privatePaths\)/);
    assert.match(pipeline, /const traceStdout = redactPrivateArtifactText\(result\.stdout, privatePaths\)/);
  });
});
