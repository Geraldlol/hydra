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

  test("codex terminal bridge exec uses structured output even when global flags precede exec", () => {
    // Why: users sometimes prefix global codex flags (e.g. --config) before exec.
    // The previous `spawn.args[0] === "exec"` check missed those argv shapes and
    // let the bridge fall back to plain output, re-leaking the prompt transcript
    // into the visible terminal. The broader `args.includes("exec")` check fixes
    // that bypass.
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private prepareTerminalBridgeSpawn(");
    const methodEnd = source.indexOf("private async normalizeOneShotResult", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart);

    const method = source.slice(methodStart, methodEnd);
    assert.match(method, /agent === "codex" && spawn\.args\.includes\("exec"\)/);
    assert.doesNotMatch(method, /spawn\.args\[0\] === "exec"/);
    assert.match(method, /withCodexJsonArgs\(spawn\)/);
    assert.match(method, /outputMode: "codexJson"/);
  });

  test("normalized native replies pass through the prompt-envelope leak guard", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const oneShotStart = source.indexOf("private async normalizeOneShotResult");
    const terminalStart = source.indexOf("private async normalizeTerminalBridgeResult");
    const usageStart = source.indexOf("private async terminalBridgeUsageResult");
    assert.ok(oneShotStart >= 0 && terminalStart > oneShotStart && usageStart > terminalStart);

    const oneShot = source.slice(oneShotStart, terminalStart);
    const terminal = source.slice(terminalStart, usageStart);
    assert.match(source, /import \{ detectNativeReplyLeak, formatNativeReplyLeakError \} from "\.\/nativeReplyGuard"/);
    assert.match(oneShot, /return guardNativeReply\(\{ \.\.\.result, stdout \}\)/);
    assert.match(terminal, /return guardNativeReply\(\{ \.\.\.result, stdout \}\)/);
  });

  test("workspace instructions filter out the recipient agent's native instruction files in both transports", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private buildPromptContextFromMessages(");
    const methodEnd = source.indexOf("private oneShotWorkspaceInstructionsMaxChars()", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart);

    const method = source.slice(methodStart, methodEnd);
    assert.match(method, /transport === "terminalBridge"\s*\?\s*this\.terminalBridgeWorkspaceInstructionsMaxChars\(\)/);
    assert.match(method, /transport !== "terminalBridge" \|\| workspaceInstructionsMaxChars > 0/);
    assert.match(method, /agent\s*\?\s*this\.workspaceInstructionsByAgent\[agent\]\s*:\s*this\.workspaceInstructions/);
    assert.doesNotMatch(method, /transport === "terminalBridge" && agent\s*\?\s*this\.workspaceInstructionsByAgent/);
    assert.match(method, /workspaceInstructionsAsContext\(workspaceInstructions, \{ maxChars: workspaceInstructionsMaxChars \}\)/);
  });

  test("terminal bridge reply polling starts fast and backs off to the configured cap", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "terminalBridge.ts"), "utf8");
    const methodStart = source.indexOf("async function waitForReply(");
    const methodEnd = source.indexOf("async function readLogChunk", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart);

    const method = source.slice(methodStart, methodEnd);
    assert.match(method, /const maxPollMs = Math\.max\(1, Math\.floor\(pollMs\)\)/);
    assert.match(method, /let nextPollMs = Math\.min\(50, maxPollMs\)/);
    assert.match(method, /await sleepWithAbort\(nextPollMs\)/);
    assert.match(method, /nextPollMs = Math\.min\(maxPollMs, nextPollMs \* 2\)/);
  });

  test("terminal bridge caches resolved agent commands per agent and command", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "terminalBridge.ts"), "utf8");

    assert.match(source, /private readonly resolvedCommandCache = new Map<string, Promise<string>>\(\)/);

    const helperStart = source.indexOf("private async resolveAgentCommandCached(");
    const helperEnd = source.indexOf("private retireTerminal(", helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart, "missing resolveAgentCommandCached");
    const helper = source.slice(helperStart, helperEnd);
    assert.match(helper, /const cacheKey = `\$\{agent\}\\0\$\{command\}`/);
    assert.match(helper, /this\.resolvedCommandCache\.get\(cacheKey\)/);
    assert.match(helper, /this\.resolvedCommandCache\.delete\(cacheKey\)/);
    assert.match(helper, /this\.resolvedCommandCache\.set\(cacheKey, resolved\)/);

    const dispatchCall = /terminalSpawn = \{ \.\.\.spawn, command: await this\.resolveAgentCommandCached\(agent, spawn\.command\) \}/;
    assert.match(source, dispatchCall);
    assert.doesNotMatch(source, /command: await resolveAgentCommand\(agent, spawn\.command\)/);
  });

  test("terminal startup uses a readiness probe instead of a fixed 2.5 second sleep", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "terminalBridge.ts"), "utf8");
    const methodStart = source.indexOf("private async ensureTerminal(");
    const methodEnd = source.indexOf("private async setSession", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart);

    const method = source.slice(methodStart, methodEnd);
    assert.match(method, /buildTerminalStartupProbeCommand\(agent, this\.workspaceRoot, markerPath\)/);
    assert.match(method, /const ready = await waitForFile\(markerPath, this\.startupDelayMs\(\), 50\)/);
    assert.doesNotMatch(method, /await delay\(this\.startupDelayMs\(\)\)/);
    assert.match(source, /get<number>\("terminalStartupDelayMs", 1000\)/);
  });
});

describe("workspace edit viewer source contracts", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");

  test("workspace edit viewer uses z-terminated git status parsing", () => {
    const functionStart = source.indexOf("async function captureGitStatusChanges(");
    const functionEnd = source.indexOf("function gitStatusKind(", functionStart);
    assert.ok(functionStart >= 0, "missing captureGitStatusChanges");
    assert.ok(functionEnd > functionStart, "missing git status parser boundary");
    const section = source.slice(functionStart, functionEnd);
    assert.match(section, /\["status", "--porcelain=v1", "-z"\]/);
    assert.doesNotMatch(section, /"-uall"/);
    assert.match(section, /function parseGitStatusEntries\(raw: string\)/);
    assert.match(section, /raw\.split\("\\0"\)/);
    assert.match(section, /status\.includes\("R"\) \|\| status\.includes\("C"\)/);
  });

  test("workspace edit viewer rejects Windows drive-relative open paths", () => {
    assert.match(source, /\^\[A-Za-z\]:/);
    assert.match(source, /Hydra refused to open an invalid workspace change path/);
  });

  test("workspace edit viewer refreshes from a debounced file watcher", () => {
    assert.match(source, /createFileSystemWatcher\(new vscode\.RelativePattern\(this\.workspaceRoot, "\*\*\/\*"\)\)/);
    assert.match(source, /watcher\.onDidCreate\(schedule\)/);
    assert.match(source, /watcher\.onDidChange\(schedule\)/);
    assert.match(source, /watcher\.onDidDelete\(schedule\)/);
    assert.match(source, /private scheduleWorkspaceChangesRefresh\(\): void/);
    assert.match(source, /setTimeout\(\(\) => \{/);
    assert.match(source, /this\.refreshWorkspaceChanges\(\)\.then\(\(\) => this\.postState\(\)\)/);
  });
});

describe("wiki wrapup source contracts", () => {
  test("wiki wrapups emit start and no-change diagnostics", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private async maybeRunWikiWrapup(");
    const methodEnd = source.indexOf("private async runWikiWrapupAgent", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart);

    const method = source.slice(methodStart, methodEnd);
    assert.match(method, /Hydra wiki wrapup started after \$\{source\}\./);
    assert.match(method, /sourceSha256: wrapupSource\.sha256/);
    assert.match(method, /sourceTruncated: wrapupSource\.truncated/);
    assert.match(method, /Hydra wiki wrapup completed with no durable wiki changes after \$\{source\}\./);
    assert.match(method, /rawSourcesPruned: 0/);
  });

  test("agent replies emit wiki usage telemetry after transcript persistence", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private async finalizePendingMessage(");
    const methodEnd = source.indexOf("private async recordWikiUsageTelemetry", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart);

    const method = source.slice(methodStart, methodEnd);
    assert.match(method, /await appendMessage\(this\.transcriptUri\.fsPath/);
    assert.match(method, /await this\.recordWikiUsageTelemetry\(m\)/);
  });

  test("wiki usage telemetry records citation and prompt-file counts", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private async recordWikiUsageTelemetry(");
    const methodEnd = source.indexOf("private async captureDecisionPacket", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart);

    const method = source.slice(methodStart, methodEnd);
    assert.match(method, /readHydraWikiPromptContext\(this\.workspaceRoot, this\.wikiContextMaxChars\(\)/);
    assert.match(method, /summarizeHydraWikiUsage\(message\.text\)/);
    assert.match(method, /Hydra wiki usage telemetry:/);
    assert.match(method, /sourceCitationCount: telemetry\.sourceCitationCount/);
    assert.match(method, /promptFiles: wikiContext\.files\.join\(","\)/);
  });
});
