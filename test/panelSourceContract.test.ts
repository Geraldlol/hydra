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

  test("prompt transcript cap resolves by phase and only leaves direct terminal pokes unwindowed", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private buildPromptContextSnapshotFromMessages(");
    const methodEnd = source.indexOf("private oneShotWorkspaceInstructionsMaxChars(", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart);

    const method = source.slice(methodStart, methodEnd);
    assert.match(method, /const transcriptCap = use === "terminalPoke" \? 0 : this\.promptTranscriptMaxChars\(phase\)/);
    assert.match(method, /buildPromptContextWindow\(/);
    assert.match(source, /function promptTranscriptScope\(phase: Phase\)/);
    assert.match(source, /effectivePhasedNumberSetting\(raw, scope, fallback\)/);
    assert.match(source, /wikiContextRefreshTranscriptMaxChars/);
    assert.match(source, /ONE_SHOT_WORKSPACE_INSTRUCTIONS_MAX_CHARS_DEFAULTS/);
    assert.match(source, /roomContext: this\.buildPromptContext\(phase, "terminalBridge", agent, "terminalPoke"\)/);
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

  test("one-shot pipeline mirrors structured streams to the shared live channel", () => {
    // Why: Many Heads Mode needs a stable file-backed channel that Codex can
    // inspect while Claude-side work is still streaming. The live channel is
    // metadata-only and separate from the cosmetic webview text stream, but it
    // must be fed from the same stdout chunks and flushed before the call
    // returns so readers never miss a trailing unterminated JSONL line.
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    assert.match(source, /import \{ createLiveChannelWriter, liveChannelPath, type LiveChannelEvent \} from "\.\/liveChannel"/);

    const methodStart = source.indexOf("private async runOneShotPipeline(");
    const methodEnd = source.indexOf("private autoAdvanceExplainer(", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart, "could not bound runOneShotPipeline body");
    const method = source.slice(methodStart, methodEnd);
    // Gated by Many Heads Mode so ordinary turns write no .hydra/live files.
    assert.match(method, /manyHeadsMode\(\)/);
    assert.match(method, /createLiveChannelWriter\(\{/);
    assert.match(method, /onEvent: onLiveChannelEvent/);
    assert.match(method, /liveChannel\?\.push\(chunk\)/);
    assert.match(method, /await liveChannel\?\.flush\(\)/);
  });

  test("room one-shot path forwards Claude task live-channel events to the parent message", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    assert.match(source, /function isClaudeTaskLiveEvent\(event: LiveChannelEvent\): boolean/);
    assert.match(source, /event\.agent === "claude"[\s\S]*event\.kind\.startsWith\("task_"\)/);

    const helperStart = source.indexOf("private appendMessageLiveChannelEvent(");
    const helperEnd = source.indexOf("private openPendingMessage(", helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart, "could not bound appendMessageLiveChannelEvent");
    const helper = source.slice(helperStart, helperEnd);
    assert.match(helper, /message\.liveChannelEvents = events\.slice\(-50\)/);
    assert.match(helper, /this\.panel\.webview\.postMessage\(\{ type: "liveChannelEvent", messageId, event \}\)/);

    const callStart = source.indexOf("return await this.runOneShotPipeline(agent, phase, prepared");
    const callEnd = source.indexOf("recordFailureCard: (normalized)", callStart);
    assert.ok(callStart >= 0 && callEnd > callStart, "could not bound room runOneShotPipeline call");
    const call = source.slice(callStart, callEnd);
    assert.match(call, /onLiveChannelEvent: \(event\) => this\.appendMessageLiveChannelEvent\(messageId, event\)/);
  });

  test("parallel Codex prompts can point at Claude worker live channels", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    assert.match(source, /import \{ createLiveChannelWriter, liveChannelPath, type LiveChannelEvent \} from "\.\/liveChannel"/);
    assert.match(source, /buildParallelDiscussionWorkers/);
    assert.match(source, /claudeWorkerTraceIds/);
    assert.match(source, /appendClaudeWorkerAssignment/);

    const methodStart = source.indexOf("private async runParallelDiscussionTurn(");
    const methodEnd = source.indexOf("private async runBuildPhase", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart, "could not bound runParallelDiscussionTurn body");
    const method = source.slice(methodStart, methodEnd);
    assert.match(method, /buildParallelDiscussionWorkers\(\{/);
    assert.match(method, /manyHeads: manyHeadsMode\(\)/);
    assert.match(method, /claudeWorkerCount: manyHeadsClaudeWorkerCount\(\)/);
    assert.match(method, /const claudeLiveRequestIds = claudeWorkerTraceIds\(workers\)/);
    assert.match(method, /agent === "codex" && claudeLiveRequestIds\.length > 0/);
    assert.match(method, /appendManyHeadsLiveChannelContext\(context\.text, this\.workspaceRoot, claudeLiveRequestIds\)/);
    assert.match(method, /appendClaudeWorkerAssignment\(transcriptWithLiveChannels, worker\)/);
    assert.match(method, /worker\.traceIdOverride/);
    assert.match(method, /worker\.manyHeadsDispatch/);

    const helperStart = source.indexOf("function appendManyHeadsLiveChannelContext(");
    const helperEnd = source.indexOf("function sha256(", helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart, "could not bound appendManyHeadsLiveChannelContext");
    const helper = source.slice(helperStart, helperEnd);
    assert.match(helper, /claudeRequestIds\.map/);
    assert.match(helper, /liveChannelPath\(workspaceRoot, requestId, "claude"\)/);
    assert.match(helper, /Many Heads live channel/);
    assert.match(helper, /tail those files/);
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

describe("usage tracker source contracts", () => {
  test("one-shot usage extraction parses the RAW result, not the normalized one", () => {
    // Why: normalizeOneShotResult swaps stdout for the --output-last-message
    // reply text on plain Codex runs. That text has no trailing "tokens used"
    // footer, so passing the normalized result to extractAndRecordUsage
    // silently disabled Codex usage tracking (zero codex rows in usage.jsonl
    // since May 2026 while claude rows kept flowing).
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private async runOneShotPipeline(");
    const methodEnd = source.indexOf("private autoAdvanceExplainer(", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart, "could not bound runOneShotPipeline body");
    const method = source.slice(methodStart, methodEnd);
    assert.match(method, /await this\.extractAndRecordUsage\(\{ agent, phase, requestId: traceId, result, outputMode: prepared\.outputMode \}\)/);
    assert.doesNotMatch(method, /usageResult/);
  });

  test("plain-text Codex token totals are billed at the input rate, not the output rate", () => {
    // Why: the "tokens used" footer is the session TOTAL (input + cached +
    // output + reasoning) with no split. Agentic sessions are dominated by
    // (cached) input, so billing the whole total as output inflated the cost
    // estimate roughly 8x (gpt-5.5: $10/MTok out vs $1.25/MTok in).
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private async extractAndRecordUsage(");
    const methodEnd = source.indexOf("private async buildNextPromptPreviewEnvelope(", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart, "could not bound extractAndRecordUsage body");
    const method = source.slice(methodStart, methodEnd);
    assert.match(method, /tokens: \{ inputTokens: total, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 \}/);
    assert.doesNotMatch(method, /inputTokens: 0, outputTokens: total/);
    // Why: `codex exec` prints the "tokens used" footer to STDERR; scanning
    // stdout alone is the exact silent-zero-rows bug class this fix closes.
    assert.match(method, /parseCodexTextTokens\(`\$\{result\.stdout\}\\n\$\{result\.stderr\}`\)/);
  });

  test("plain-text Codex usage parses stderr, where `codex exec` prints the footer", () => {
    // Why: `codex exec` writes the "tokens used" footer to STDERR; stdout
    // carries only the agent reply. Passing the raw result was necessary but
    // not sufficient — parsing result.stdout alone still matched nothing, so
    // plain Codex turns recorded zero usage rows. Confirmed empirically:
    // stdout="OK", stderr contained "tokens used\n15,607".
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private async extractAndRecordUsage(");
    const methodEnd = source.indexOf("private async buildNextPromptPreviewEnvelope(", methodStart);
    const method = source.slice(methodStart, methodEnd);
    assert.match(method, /parseCodexTextTokens\(`\$\{result\.stdout\}\\n\$\{result\.stderr\}`\)/);
    assert.doesNotMatch(method, /parseCodexTextTokens\(result\.stdout\)/);
  });

  test("usage display leads with cost and labels the cache-inflated total honestly", () => {
    // Why: totalTokens lumps cache reads (billed at ~10% of the input rate)
    // with fresh tokens — a 309K "total" turn is ~75K real tokens / $0.65.
    // The rail chip must lead with cost, and the panel must label the raw
    // total as cache-inclusive instead of presenting it as the headline.
    const source = fs.readFileSync(path.join(process.cwd(), "media", "webview.js"), "utf8");
    assert.match(source, /usageRail\.textContent = "session " \+ \(session\.turns \|\| 0\) \+ "t " \+ costStr \+ " · " \+ formatTokens\(fresh\) \+ " fresh \/ " \+ tokenStr \+ " w\/cache/);
    const costIdx = source.indexOf('"session cost"');
    const totalIdx = source.indexOf('"total incl. cache"');
    assert.ok(costIdx >= 0, "usage panel must keep a session cost stat");
    assert.ok(totalIdx >= 0, "usage panel must label the raw total as cache-inclusive");
    assert.ok(costIdx < totalIdx, "session cost must render before the cache-inclusive total");
    assert.doesNotMatch(source, /usageStat\(formatTokens\(summary\.totalTokens \|\| 0\), "session tokens"\)/);
  });
});

describe("claude automation credit guard source contract", () => {
  test("callAgent gates Claude dispatch through the credit guard before any spawn", () => {
    // Why: subscription-backed `claude -p` draws from the capped Agent SDK
    // credit pool after 2026-06-15. The guard MUST run before runAgentTransport
    // so a `block` decision prevents spend, not merely stops auto-advance after
    // the spend already happened. A regression that moves the gate below the
    // spawn would re-open exactly the hole Slice 3 closes.
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private async callAgent(");
    const methodEnd = source.indexOf("private async ensureFullNativeConsent(", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart, "could not bound callAgent body");
    const method = source.slice(methodStart, methodEnd);

    assert.match(method, /manyHeadsDispatch = false/);
    assert.match(method, /if \(agent === "claude"\)/);
    assert.match(method, /claudeAgentEstimatedRunCostUsd\(\)/);
    assert.match(method, /await this\.evaluateClaudeCreditGuard\(signal, manyHeadsDispatch\)/);
    assert.match(method, /this\.reserveClaudeCreditEstimate\(projectedDispatchUsd\)/);
    const guardIdx = method.indexOf("await this.evaluateClaudeCreditGuard(signal, manyHeadsDispatch)");
    const reserveIdx = method.indexOf("this.reserveClaudeCreditEstimate(projectedDispatchUsd)");
    const timeoutIdx = method.indexOf("agentTimeoutMs(phase)");
    const transportIdx = method.indexOf("this.runAgentTransport(");
    assert.ok(guardIdx >= 0, "callAgent must evaluate the Claude credit guard");
    assert.ok(reserveIdx >= 0, "callAgent must reserve estimated Claude credit");
    assert.ok(reserveIdx < guardIdx, "callAgent must reserve estimated Claude credit before awaiting the guard");
    assert.ok(timeoutIdx > reserveIdx, "the estimated Claude credit reservation must happen before pending activity/spawn setup");
    assert.ok(timeoutIdx > guardIdx, "the credit guard must run before the spawn timeout/pending activity");
    assert.ok(transportIdx > guardIdx, "the credit guard must run before runAgentTransport");

    // The block branch cancels the turn and finalizes the pending bubble
    // without ever reaching the transport.
    assert.match(method, /guard\?\.decision === "block"/);
    assert.match(method, /event: "claudeCreditGuardBlocked"/);
    assert.match(method, /cancelled: true/);
    assert.match(method, /await this\.finalizePendingMessage\(messageId, result\)/);
    assert.match(method, /guard\?\.decision === "warn"/);
    assert.match(method, /releaseClaudeCreditReservation\?\.\(\)/);
    assert.doesNotMatch(method, /evaluateClaudeCreditGuard\(signal, manyHeadsDispatch, projectedDispatchUsd\)/);
  });

  test("concurrent Claude fanout installs reservations before awaiting the shared auth probe", () => {
    // Why: Many Heads launches Claude workers under Promise.all. If each worker
    // awaited the shared auth probe before reserving, all guard continuations
    // could read the same stale reservation total and overshoot the cap.
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private async callAgent(");
    const methodEnd = source.indexOf("private async ensureFullNativeConsent(", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart, "could not bound callAgent body");
    const method = source.slice(methodStart, methodEnd);

    const reserveIdx = method.indexOf("releaseClaudeCreditReservation = this.reserveClaudeCreditEstimate(projectedDispatchUsd)");
    const guardIdx = method.indexOf("guard = await this.evaluateClaudeCreditGuard(signal, manyHeadsDispatch)");
    const blockIdx = method.indexOf('if (guard?.decision === "block")');
    assert.ok(reserveIdx >= 0, "callAgent must install the reservation before guard evaluation");
    assert.ok(guardIdx > reserveIdx, "guard evaluation must happen after reservation installation");
    assert.ok(blockIdx > guardIdx, "block decisions must be handled after guard evaluation");
    assert.match(method, /if \(guard\?\.decision === "block"\) \{\s*releaseClaudeCreditReservation\(\);/s);
  });

  test("the credit guard composes monthly Claude spend with the pure decision and short-circuits when off", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private async evaluateClaudeCreditGuard(");
    const methodEnd = source.indexOf("private buildPromptContext(", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart, "could not bound evaluateClaudeCreditGuard body");
    const method = source.slice(methodStart, methodEnd);

    // Off means the user opted out: skip the auth probe overhead entirely.
    assert.match(method, /if \(mode === "off"\) return undefined/);
    assert.match(method, /claudeAutomationCreditGuard\(\)/);
    assert.match(method, /claudeAutomationSpendThisMonth\(this\.usageRecords\)/);
    assert.match(method, /pendingReservationUsd: this\.claudeCreditReservedUsd/);
    assert.doesNotMatch(method, /projectedDispatchUsd/);
    assert.match(method, /capUsd: claudeAgentCreditCapUsd\(\)/);
    assert.match(method, /evaluateClaudeAutomationGuard\(\{/);
  });

  test("the auth probe requests JSON, sanitizes at capture time, and caches per session", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("private async ensureClaudeAuthStatus(");
    const methodEnd = source.indexOf("private async evaluateClaudeCreditGuard(", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart, "could not bound ensureClaudeAuthStatus body");
    const method = source.slice(methodStart, methodEnd);

    assert.match(method, /if \(this\.claudeAuthStatusPromise\) return this\.claudeAuthStatusPromise/);
    assert.match(method, /this\.claudeAuthStatusPromise = \(async \(\) =>/);
    assert.match(method, /buildNativeCommandSpawn\("claude", \[\.\.\.CLAUDE_AUTH_STATUS_PROBE_ARGS\]\)/);
    // Sanitization happens at capture time via parseClaudeAuthStatus (drops
    // email/orgId/orgName), so the cached field is never raw auth JSON.
    assert.match(method, /parseClaudeAuthStatus\(result\.stdout\)/);
  });
});

describe("many heads smoke command source contract", () => {
  test("command palette command routes to the panel smoke runner", () => {
    const extension = fs.readFileSync(path.join(process.cwd(), "src", "extension.ts"), "utf8");
    const pkg = fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8");

    assert.match(pkg, /"command": "hydraRoom\.runManyHeadsSmokeTest"/);
    assert.match(extension, /"hydraRoom\.runManyHeadsSmokeTest"/);
    assert.match(extension, /await panel\.runManyHeadsSmokeTest\(\)/);
  });

  test("auto accept setting supports folder-scoped command center toggles", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      contributes?: { configuration?: { properties?: Record<string, { scope?: string }> } };
    };
    const prop = pkg.contributes?.configuration?.properties?.["hydraRoom.autoAdvanceActionableDefaults"];
    assert.equal(prop?.scope, "resource");
  });

  test("panel smoke runner uses the real parallel turn path and durable report", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const methodStart = source.indexOf("async runManyHeadsSmokeTest(");
    const methodEnd = source.indexOf("private modelChooserDeps(", methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart, "could not bound runManyHeadsSmokeTest");
    const method = source.slice(methodStart, methodEnd);

    assert.match(method, /cfg\.update\("manyHeadsMode", true, vscode\.ConfigurationTarget\.Workspace\)/);
    assert.match(method, /cfg\.update\("autoAdvanceActionableDefaults", false, vscode\.ConfigurationTarget\.Workspace\)/);
    assert.match(method, /await this\.sendUserMessage\(prompt, "codex"\)/);
    assert.match(method, /readJsonlGuarded\(\s*this\.agentCallsUri\.fsPath,\s*isManyHeadsSmokeAgentCall/s);
    assert.match(method, /this\.readManyHeadsSmokeLiveFiles\(agentCalls\)/);
    assert.match(method, /buildManyHeadsSmokeReport\(\{/);
    assert.match(method, /appendManyHeadsSmokeReport\(this\.manyHeadsSmokeUri\.fsPath, report\)/);
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
