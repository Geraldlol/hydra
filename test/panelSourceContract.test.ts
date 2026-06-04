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

describe("auto-advance security gate source contract", () => {
  test("autoAdvanceActionableDefault refuses risky decision defaults before acting", () => {
    // Why: a Decision Packet's defaultNextAction/recommendation is agent-controlled and
    // prompt-injectable from any repo file an agent reads. Auto-advance MUST consult
    // detectRiskySignals and bail BEFORE currentDecisionAction(), or a hostile repo file
    // could drive deploy/publish/force-push/migration defaults into the room loop with no
    // human checkpoint. decisions.ts:detectRiskySignals documents this gate as mandatory.
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private async autoAdvanceActionableDefault(");
    assert.ok(methodStart >= 0, "autoAdvanceActionableDefault method not found");
    const methodEnd = source.indexOf("private async runReviewPhase(", methodStart);
    assert.ok(methodEnd > methodStart, "could not bound autoAdvanceActionableDefault body");
    const method = source.slice(methodStart, methodEnd);

    const riskIdx = method.indexOf("detectRiskySignals(");
    const actionIdx = method.indexOf("this.currentDecisionAction()");
    assert.ok(riskIdx >= 0, "auto-advance must call detectRiskySignals");
    assert.ok(actionIdx >= 0, "auto-advance must read currentDecisionAction");
    assert.ok(riskIdx < actionIdx, "risky-signal gate must run before any decision action is taken");
    assert.match(method, /if \(risk\.risky\)/);
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
    const methodEnd = source.indexOf("private oneShotWorkspaceInstructionsMaxChars(", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart);

    const method = source.slice(methodStart, methodEnd);
    // terminalBridgeWorkspaceInstructionsMaxChars moved to src/roomSettings.ts
    // (the read-only config getter extraction), so it is now a free-function
    // call rather than a method on the panel. The branch selection it gates is
    // unchanged.
    assert.match(method, /transport === "terminalBridge"\s*\?\s*terminalBridgeWorkspaceInstructionsMaxChars\(\)/);
    assert.match(method, /this\.oneShotWorkspaceInstructionsMaxChars\(phase\)/);
    assert.match(method, /transport !== "terminalBridge" \|\| workspaceInstructionsMaxChars > 0/);
    assert.match(method, /agent\s*\?\s*this\.workspaceInstructionsByAgent\[agent\]\s*:\s*this\.workspaceInstructions/);
    assert.doesNotMatch(method, /transport === "terminalBridge" && agent\s*\?\s*this\.workspaceInstructionsByAgent/);
    assert.match(method, /workspaceInstructionsAsContext\(workspaceInstructions, \{ maxChars: workspaceInstructionsMaxChars \}\)/);
  });

  test("prompt transcript cap resolves by phase and leaves terminal pokes unwindowed", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private buildPromptContextSnapshotFromMessages(");
    const methodEnd = source.indexOf("private oneShotWorkspaceInstructionsMaxChars(", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart);

    const method = source.slice(methodStart, methodEnd);
    assert.match(method, /const transcriptCap = transport === "terminalBridge" \? 0 : this\.promptTranscriptMaxChars\(phase\)/);
    assert.match(method, /buildPromptContextWindow\(/);
    assert.match(source, /function promptTranscriptScope\(phase: Phase\)/);
    assert.match(source, /effectivePhasedNumberSetting\(raw, scope, fallback\)/);
    assert.match(source, /wikiContextRefreshTranscriptMaxChars/);
    assert.match(source, /ONE_SHOT_WORKSPACE_INSTRUCTIONS_MAX_CHARS_DEFAULTS/);
  });

  test("model and effort choosers write application-scoped settings globally", () => {
    const modelSource = fs.readFileSync(path.join(process.cwd(), "src", "modelChooser.ts"), "utf8");
    const effortSource = fs.readFileSync(path.join(process.cwd(), "src", "effortChooser.ts"), "utf8");

    assert.match(modelSource, /\.update\(`\$\{agent\}Model`, nextSetting, vscode\.ConfigurationTarget\.Global\)/);
    assert.doesNotMatch(modelSource, /\.update\(`\$\{agent\}Model`, nextSetting, vscode\.ConfigurationTarget\.Workspace\)/);
    assert.match(effortSource, /\.update\(settingKey, next, vscode\.ConfigurationTarget\.Global\)/);
    assert.doesNotMatch(effortSource, /\.update\(settingKey, next, vscode\.ConfigurationTarget\.Workspace\)/);
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

describe("live streaming source contracts", () => {
  test("one-shot pipeline streams extracted live text instead of swallowing JSONL chunks", () => {
    // Why: claudeStreamJson/codexJson stdout is typed JSONL, not displayable
    // text. The old behavior suppressed ALL live chunks for those modes, so
    // the webview showed a static placeholder for the entire call (p50 ~60s
    // per discussion leg). Chunks must route through createLiveTextExtractor
    // so assistant-text increments stream into the bubble while the call runs;
    // the normalized result still replaces the streamed text at completion.
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    assert.match(source, /import \{ createLiveTextExtractor \} from "\.\/liveText"/);
    assert.doesNotMatch(source, /suppressLiveStdout/);

    const methodStart = source.indexOf("private async runOneShotPipeline(");
    const methodEnd = source.indexOf("private autoAdvanceExplainer(", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart, "could not bound runOneShotPipeline body");
    const method = source.slice(methodStart, methodEnd);
    assert.match(method, /createLiveTextExtractor\(prepared\.outputMode\)/);
    assert.doesNotMatch(method, /if \(prepared\.suppressLiveStdout\) return;/);
  });

  test("terminal bridge call site forwards live chunks for JSON modes and replaces with the normalized reply", () => {
    // Why: terminalBridge.callAgent has supported a live onChunk feed (the
    // .hydra/logs poll) since the bridge landed, but the panel call site
    // omitted it, discarding the feed - the webview stayed a placeholder for
    // the whole run. The call site must pass a chunk callback for JSON output
    // modes, and because JSON-mode streamed text is interim/cosmetic, the
    // authoritative normalized reply must REPLACE it at completion. Plain
    // mode must NOT pass a callback: passing onChunk flips waitForReply's
    // stdout to unstreamedTail(reply.text, streamed), whose byte-sensitive
    // de-dup diverges when the agent emits ANSI (stripped from the streamed
    // log but not from reply.text) and double-renders the reply into the
    // transcript.
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const branchStart = source.indexOf("if (forceTerminalBridge || this.transportMode() === \"terminalBridge\")");
    const branchEnd = source.indexOf("const prepared = await this.prepareOneShotRequestFiles", branchStart);
    assert.ok(branchStart >= 0 && branchEnd > branchStart);

    const branch = source.slice(branchStart, branchEnd);
    assert.match(branch, /createLiveTextExtractor\(terminalPrepared\.outputMode\)/);
    // The callback must exist only when an extractor exists (JSON modes).
    assert.match(branch, /const onLiveChunk = liveText\s*\?\s*\(chunk: string\) =>/);
    assert.match(branch, /:\s*undefined/);
    assert.match(branch, /onLiveChunk/);
    assert.match(branch, /type: "chunk"/);
    assert.match(branch, /type: "replaceMessageText"/);
  });
});

describe("workspace edit viewer source contracts", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");

  test("workspace edit viewer uses z-terminated git status parsing", () => {
    // The caller still lives in panel.ts and must use the z-terminated,
    // default-untracked-mode invocation (no -uall deep scan). The parser
    // itself moved to src/gitStatus.ts during the god-object decomposition,
    // so its internals are asserted against that module below.
    const callerStart = source.indexOf("async function captureGitStatusChanges(");
    const callerEnd = source.indexOf("async function runGit(", callerStart);
    assert.ok(callerStart >= 0, "missing captureGitStatusChanges");
    assert.ok(callerEnd > callerStart, "missing git status caller boundary");
    const caller = source.slice(callerStart, callerEnd);
    assert.match(caller, /\["status", "--porcelain=v1", "-z"\]/);
    assert.doesNotMatch(caller, /"-uall"/);
    assert.match(caller, /parseGitStatusEntries\(status\.out\)/);

    const parserSource = fs.readFileSync(path.join(process.cwd(), "src", "gitStatus.ts"), "utf8");
    const parserStart = parserSource.indexOf("export function parseGitStatusEntries(raw: string)");
    const parserEnd = parserSource.indexOf("export function gitStatusKind(", parserStart);
    assert.ok(parserStart >= 0, "missing parseGitStatusEntries in gitStatus.ts");
    assert.ok(parserEnd > parserStart, "missing git status parser boundary");
    const parser = parserSource.slice(parserStart, parserEnd);
    assert.match(parser, /raw\.split\("\\0"\)/);
    assert.match(parser, /status\.includes\("R"\) \|\| status\.includes\("C"\)/);
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

  test("only archiveAndClearRoom assigns this.state directly outside applyEvent", () => {
    // Why: every other phase change must route through transition() so the
    // state machine remains the single source of truth. archiveAndClearRoom
    // is the documented exception because it is a room-wide wipe (messages,
    // agent statuses, transcript) that incidentally resets the phase —
    // modeling it as a phase event would conflate concerns. Pin the count
    // so a future regression that adds a new direct mutation gets caught.
    // The regex deliberately matches literal-object assignments only, so the
    // canonical `this.state = transition(this.state, event)` inside applyEvent
    // is not counted.
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const literalMutations = [...source.matchAll(/this\.state\s*=\s*\{\s*name:/g)];
    assert.equal(
      literalMutations.length,
      1,
      `expected exactly 1 direct this.state literal assignment (archiveAndClearRoom), found ${literalMutations.length}`
    );
    const idx = literalMutations[0]?.index ?? -1;
    // Window widened from 600 to 1000: the wiki-maintenance cancellation
    // (this.wikiMaintenanceAbort?.abort()) added to archiveAndClearRoom's
    // proceed path pushed the lone `this.state = {…}` assignment ~626 chars
    // below the method declaration. The intent — that the single literal
    // assignment belongs to archiveAndClearRoom — is unchanged.
    const head = source.slice(Math.max(0, idx - 1000), idx);
    assert.match(head, /async archiveAndClearRoom/);
  });

  test("archiveAndClearRoom runs workspace cleanup after archiving", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const start = source.indexOf("async archiveAndClearRoom()");
    const end = source.indexOf("async openDecisions()", start);
    assert.ok(start >= 0 && end > start, "archiveAndClearRoom not found");
    const body = source.slice(start, end);
    assert.match(body, /archiveAndResetTranscript/);
    assert.match(body, /runWorkspaceStateCleanup\(\)/);
    assert.match(body, /Hydra workspace cleanup after archive failed/);
  });

  test("runVerificationInternal gates inferred commands on vscode.workspace.isTrusted", () => {
    // Why: a workspace's package.json scripts are attacker-controlled in
    // an untrusted workspace. The handler must short-circuit BEFORE
    // executing any inferred command. Source-grep ensures a future
    // refactor does not silently drop the gate.
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const start = source.indexOf("private async runVerificationInternal");
    assert.ok(start >= 0, "runVerificationInternal not found in panel.ts");
    // Match the method's closing brace at 2-space indent, EOL-agnostic
    // (Windows CRLF checkouts otherwise wouldn't match a bare "\n  }\n").
    const endOffset = source.slice(start).search(/\r?\n {2}\}\r?\n/);
    assert.ok(endOffset > 0, "runVerificationInternal body not delimited");
    const body = source.slice(start, start + endOffset);
    assert.match(body, /vscode\.workspace\.isTrusted/);
    assert.match(body, /resolveVerificationCommand/);
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

  test("wiki context refreshes run when transcript reaches the prompt cap", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private async maybeRunWikiContextRefresh(");
    const methodEnd = source.indexOf("private async runWikiWrapupAgent", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart);

    const method = source.slice(methodStart, methodEnd);
    assert.match(method, /hydraWikiContextRefreshSourceFromMessages\(this\.messages, cap\)/);
    assert.match(method, /refreshSource\.originalChars < cap/);
    assert.match(method, /lastWikiRefreshTranscriptBucket/);
    assert.match(method, /Hydra wiki context refresh threshold reached after \$\{source\}\./);
    assert.match(method, /sourceOverride: refreshSource/);
  });

  test("automatic wiki maintenance is queued off the turn critical path", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private enqueueWikiMaintenanceAfterTurn(");
    const methodEnd = source.indexOf("private async maybeRunWikiWrapup", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart);

    const method = source.slice(methodStart, methodEnd);
    // wikiWrapupMaxSourceChars moved to src/roomSettings.ts (read-only config
    // getter extraction); now a free-function call. The source-window cap it
    // feeds into is unchanged.
    assert.match(method, /hydraWikiWrapupSourceFromMessages\(this\.messages, wikiWrapupMaxSourceChars\(\)\)/);
    assert.match(method, /hydraWikiContextRefreshSourceFromMessages\(this\.messages, cap\)/);
    assert.match(method, /this\.wikiMaintenanceQueue = previous\.then\(run\)\.catch/);
    assert.match(method, /Hydra background wiki maintenance failed after \$\{source\}/);

    const discussionStart = source.indexOf("private async runDiscussionTurn(");
    const discussionEnd = source.indexOf("private async runParallelDiscussionTurn", discussionStart);
    const discussion = source.slice(discussionStart, discussionEnd);
    assert.match(discussion, /this\.enqueueWikiMaintenanceAfterTurn\("discussion"\);/);
    assert.doesNotMatch(discussion, /await this\.maybeRunWikiWrapup\("discussion"\)/);

    const parallelStart = source.indexOf("private async runParallelDiscussionTurn(");
    const parallelEnd = source.indexOf("private async runBuildPhase", parallelStart);
    const parallel = source.slice(parallelStart, parallelEnd);
    assert.match(parallel, /this\.enqueueWikiMaintenanceAfterTurn\("parallel discussion"\);/);
    assert.doesNotMatch(parallel, /await this\.maybeRunWikiWrapup\("parallel discussion"\)/);
  });

  test("agent replies emit wiki usage telemetry after transcript persistence", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private async finalizePendingMessage(");
    const methodEnd = source.indexOf("private async recordWikiUsageTelemetry", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart);

    const method = source.slice(methodStart, methodEnd);
    assert.match(method, /await appendMessage\(this\.transcriptUri\.fsPath/);
    assert.match(method, /const promptTranscriptWindow = this\.pendingPromptTranscriptWindows\.get\(messageId\)/);
    assert.match(method, /await this\.recordWikiUsageTelemetry\(m, promptTranscriptWindow\)/);
    assert.match(method, /this\.pendingPromptTranscriptWindows\.delete\(messageId\)/);
  });

  test("wiki usage telemetry records citation and prompt-file counts", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private async recordWikiUsageTelemetry(");
    const methodEnd = source.indexOf("private async captureDecisionPacket", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart);

    const method = source.slice(methodStart, methodEnd);
    // wikiContextMaxChars moved to src/roomSettings.ts (read-only config getter
    // extraction); now a free-function call. The workspace root and char cap it
    // passes into the wiki prompt-context reader are unchanged.
    assert.match(method, /readHydraWikiPromptContext\(this\.workspaceRoot, wikiContextMaxChars\(\)/);
    assert.match(method, /summarizeHydraWikiUsage\(message\.text\)/);
    assert.match(method, /Hydra wiki usage telemetry:/);
    assert.match(method, /hasCitationSignal: telemetry\.hasCitationSignal/);
    assert.match(method, /hasMentionSignal: telemetry\.hasMentionSignal/);
    assert.match(method, /sourceCitationCount: telemetry\.sourceCitationCount/);
    assert.match(method, /mentionsWikiByName: telemetry\.mentionsWikiByName/);
    assert.match(method, /promptFiles: wikiContext\.files\.join\(","\)/);
    assert.match(method, /transcriptKeptChars: promptTranscriptWindow\?\.keptChars \?\? null/);
    assert.match(method, /transcriptOmittedChars: promptTranscriptWindow\?\.omittedChars \?\? null/);
    assert.doesNotMatch(method, /mentionsWikiContext: telemetry\.mentionsWikiContext/);
  });
});
