import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import type { CommandCenterActionId } from "../src/commandCenter";
import { renderHtml } from "../src/webview.html";

const heads = {
  cspSource: "vscode-resource:",
  brand: "brand.png",
  codex: "codex.png",
  claude: "claude.png",
  system: "system.png",
  user: "user.png",
};

const boundIds = [
  "acceptDefaultBtn",
  "app",
  "archiveChatBtn",
  "archiveClearBtn",
  "agentStatusRail",
  "assignBothBtn",
  "autoAdvanceDefaultsBtn",
  "authorityRail",
  "authorityBtn",
  "autopilotText",
  "attachFilesBtn",
  "attachmentTray",
  "browserBtn",
  "captureNativeCapabilitiesBtn",
  "captureNativeDataSnapshotBtn",
  "claudeCommandBtn",
  "claudeRawLineBtn",
  "clearAttachmentsBtn",
  "clearNativeActionsBtn",
  "cmdOverlay",
  "codexCommandBtn",
  "codexRawLineBtn",
  "builderButtons",
  "commandCenterBtn",
  "commandList",
  "composer",
  "correctDuelResultBtn",
  "agentDuelMode",
  "decisionBlockers",
  "decisionBoard",
  "decisionCount",
  "decisionDefault",
  "decisionNeeded",
  "decisionPanelCount",
  "decisionRail",
  "decisionRecommendation",
  "decisionRiskChip",
  "decisionStrip",
  "doctorBtn",
  "duelsBoard",
  "duelsPanelCount",
  "duelsRail",
  "editBoard",
  "editsPanelCount",
  "editsRail",
  "fixClaudeBtn",
  "fixCodexBtn",
  "handBackBtn",
  "handoffStrip",
  "handoffTitle",
  "handoffSource",
  "handoffAction",
  "handoffConfirmBtn",
  "handoffPreviewBtn",
  "handoffDismissBtn",
  "messages",
  "modelRail",
  "nativeActionBoard",
  "nativeActionBtn",
  "nativeActionRail",
  "nativeActionText",
  "nativeAgentFilter",
  "nativePanelCount",
  "nativeStatusFilter",
  "nativeTerminalsBtn",
  "objectiveText",
  "objectiveTextShim",
  "openDecisionsBtn",
  "openDuelAuditBtn",
  "openerBtn",
  "openFolderBtn",
  "openLastPromptBtn",
  "openNativeActionsBtn",
  "openNativeActionsFooterBtn",
  "openNativeTerminalsBtn",
  "openSessionBriefBtn",
  "openSupportBundleBtn",
  "openTranscriptBtn",
  "openVerificationBtn",
  "openWorkQueuePanelBtn",
  "paletteInput",
  "panelOverlay",
  "phaseChip",
  "pokeBothBtn",
  "pokeBothDiffBtn",
  "pokeBothEditorBtn",
  "pokeClaudeBtn",
  "pokeClaudeDiffBtn",
  "pokeClaudeEditorBtn",
  "pokeCodexBtn",
  "pokeCodexDiffBtn",
  "pokeCodexEditorBtn",
  "previewPromptBtn",
  "profileBtn",
  "queuePanelCount",
  "railOverflowBtn",
  "railSecondaryWrap",
  "resetObjectiveBtn",
  "resetTurnBtn",
  "retryAutopilotBtn",
  "reviewBtn",
  "ribbonMinimizedSummary",
  "ribbonStack",
  "runVerificationBtn",
  "safeModeBtn",
  "sendBtn",
  "setObjectiveBtn",
  "setupStrip",
  "srAnnounce",
  "stopBtn",
  "terminalHealthBtn",
  "terminalPanelCount",
  "terminalSessions",
  "testBridgeBtn",
  "toggleRibbonsBtn",
  "transportChip",
  "usageRail",
  "usageBoard",
  "usagePanelCount",
  "usageSummary",
  "verificationDetails",
  "verificationRail",
  "verificationStrip",
  "verificationText",
  "workQueueBoard",
  "workQueueRail",
  "workQueueText",
] as const;

const hostMessages = [
  "acceptDefaultDecision",
  "archiveAndClearRoom",
  "attachFiles",
  "captureNativeCapabilities",
  "captureNativeDataSnapshot",
  "chooseEffort",
  "chooseModel",
  "chooseModelOrEffort",
  "changeCapabilityProfile",
  "configureManyHeadsWorkers",
  "confirmHandoff",
  "clearAttachment",
  "clearAttachments",
  "dismissHandoff",
  "resetObjective",
  "testTelegram",
  "fixClaudePath",
  "fixCodexPath",
  "handBack",
  "nativeAction",
  "openAgentCalls",
  "openBrowser",
  "openRunFailureFile",
  "openObjective",
  "openLastPrompt",
  "openWikiContext",
  "runWikiWrapupNow",
  "openSessionBrief",
  "openSupportBundle",
  "openTranscript",
  "openVerification",
  "previewNextPrompt",
  "previewHandoff",
  "copyRunFailurePromptSha",
  "requestReview",
  "resetStuckTurn",
  "runDoctor",
  "runNativeCommand",
  "runVerification",
  "send",
  "sendRawTerminalLine",
  "setObjective",
  "showEffectiveAuthority",
  "showTerminalBridgeHealth",
  "stop",
  "toggleManyHeadsMode",
  "toggleBrowserControl",
  "toggleAutoAdvanceActionableDefaults",
  "useOneShotTransport",
  "useTerminalBridge",
] as const;

const commandCenterActionCoverage: Record<CommandCenterActionId, readonly RegExp[]> = {
  openWorkspaceFolder: [/id: "open-folder"/, /type: "openWorkspaceFolder"/],
  openBrowser: [/id: "open-browser"/, /type: "openBrowser"/],
  toggleBrowserControl: [/id: "toggle-browser-control"/, /type: "toggleBrowserControl"/],
  stopCurrentTurn: [/id: "stop"/, /type: "stop"/],
  acceptDefaultDecision: [/id: "accept-default"/, /type: "acceptDefaultDecision"/],
  toggleAutoAdvanceActionableDefaults: [/id: "toggle-auto-accept-default"/, /type: "toggleAutoAdvanceActionableDefaults"/],
  archiveAndClearRoom: [/id: "archive-chat"/, /type: "archiveAndClearRoom"/],
  assignCodex: [/id: "assign-codex"/, /type: "assignBuilder", builder: "codex"/],
  assignClaude: [/id: "assign-claude"/, /type: "assignBuilder", builder: "claude"/],
  assignParallelBuilders: [/id: "assign-both"/, /type: "assignParallelBuilders"/],
  chooseEffort: [/id: "choose-effort"/, /type: "chooseEffort"/],
  chooseModel: [/id: "choose-model"/, /type: "chooseModel"/],
  toggleManyHeadsMode: [/id: "toggle-many-heads"/, /type: "toggleManyHeadsMode"/],
  configureManyHeadsWorkers: [/id: "many-heads-workers"/, /type: "configureManyHeadsWorkers"/],
  testTelegram: [/id: "test-telegram"/, /type: "testTelegram"/],
  changeCapabilityProfile: [/id: "change-profile"/, /type: "changeCapabilityProfile"/],
  requestReview: [/id: "request-review"/, /type: "requestReview"/],
  handBack: [/id: "hand-back"/, /type: "handBack"/],
  runVerification: [/id: "verification"/, /type: "runVerification"/],
  nativeAction: [/id: "native-action"/, /type: "nativeAction"/],
  pokeBothTerminalsWithDiff: [/id="pokeBothDiffBtn"/, /pokeBothDiffBtn\.addEventListener\("click"/],
  openObjective: [/id: "open-objective"/, /type: "openObjective"/],
  openLastPrompt: [/id: "open-last-prompt"/, /type: "openLastPrompt"/],
  attachFiles: [/id: "attach-files"/, /type: "attachFiles"/],
  cleanWorkspaceState: [/id: "clean-workspace-state"/, /type: "cleanWorkspaceState"/],
  openVerification: [/id: "open-verification-file"/, /type: "openVerification"/],
  openDecisions: [/id: "open-decisions"/, /type: "openDecisions"/],
  openSessionBrief: [/id: "session-brief"/, /type: "openSessionBrief"/],
  openWikiContext: [/id: "wiki-context"/, /type: "openWikiContext"/],
  runWikiWrapupNow: [/id: "wiki-wrapup-now"/, /type: "runWikiWrapupNow"/],
  openSupportBundle: [/id: "support-bundle"/, /type: "openSupportBundle"/],
  captureNativeCapabilities: [/id: "native-snapshot"/, /type: "captureNativeCapabilities"/],
  captureNativeDataSnapshot: [/id: "native-data"/, /type: "captureNativeDataSnapshot"/],
  openNativeActions: [/id: "open-native-actions-file"/, /type: "openNativeActions"/],
  openAgentCalls: [/id: "open-agent-calls"/, /type: "openAgentCalls"/],
  openNativeTerminals: [/id: "open-terminals"/, /type: "openNativeTerminals"/],
  useTerminalBridge: [/id: "toggle-transport"/, /"useTerminalBridge"/],
  useOneShotTransport: [/id: "safe-mode"/, /type: "useOneShotTransport"/],
  runDoctor: [/id: "doctor"/, /type: "runDoctor"/],
  runAutopilotStart: [/id: "retry-auto"/, /type: "runAutopilotStart"/],
  runTerminalBridgeSelfTest: [/id: "test-bridge"/, /type: "runTerminalBridgeSelfTest"/],
  showTerminalBridgeHealth: [/id: "terminal-health"/, /type: "showTerminalBridgeHealth"/],
  showEffectiveAuthority: [/id: "authority"/, /type: "showEffectiveAuthority"/],
  fixCodexPath: [/id: "fix-codex"/, /type: "fixCodexPath"/],
  fixClaudePath: [/id: "fix-claude"/, /type: "fixClaudePath"/],
  resetStuckTurn: [/id: "reset-turn"/, /type: "resetStuckTurn"/],
  openTranscript: [/id: "open-transcript"/, /type: "openTranscript"/],
};

describe("webview contract", () => {
  const html = renderHtml("nonce", heads, "vscode-resource:/media/webview.js");
  // The script body lives in media/webview.js (loaded externally via the
  // scriptUri above). Most contract assertions below check JS patterns
  // that now sit in that file, so we concatenate HTML + JS into a single
  // "rendered surface" string for the regex matchers. The DOM-binding
  // test below still uses just `html` because IDs are HTML attributes.
  const scriptBody = fs.readFileSync(path.join(process.cwd(), "media", "webview.js"), "utf8");
  const surface = `${html}\n${scriptBody}`;

  test("keeps every scripted DOM binding present in the rendered HTML", () => {
    for (const id of boundIds) {
      assert.match(html, new RegExp(`id="${id}"(?:\\s|>)`), `missing #${id}`);
    }
  });

  test("keeps Command Center accessibility hooks in place", () => {
    assert.match(html, /id="commandList" role="listbox"/);
    assert.match(html, /id="paletteInput" role="combobox"[^>]+aria-activedescendant=""/);
    assert.match(surface, /item\.setAttribute\("role", "option"\)/);
    assert.match(surface, /item\.setAttribute\("aria-selected", "false"\)/);
    assert.match(surface, /item\.setAttribute\("aria-disabled", enabled \? "false" : "true"\)/);
    // Closing the palette restores focus to its opener, falling back to the
    // Commands button when no opener was recorded.
    assert.match(surface, /restoreDialogFocus\(\)/);
    assert.match(surface, /dialogRestoreFocus[\s\S]*commandCenterBtn/);
  });

  test("keeps the dialog focus trap and aria-modal in place", () => {
    assert.match(html, /id="commandCenter" role="dialog" aria-modal="true"/);
    assert.match(html, /class="inspector" role="dialog" aria-modal="true"/);
    assert.match(surface, /function trapDialogTab\(event\)/);
    assert.match(surface, /event\.key === "Tab"/);
    assert.match(surface, /const activeView = Array\.from\(panelOverlay\.querySelectorAll\("\.panel-view"\)\)\.find\(\(view\) => view\.dataset\.view === panel\)/);
    assert.match(surface, /dialog\.setAttribute\("aria-label", heading && heading\.textContent \? heading\.textContent\.trim\(\) : "Hydra inspector"\)/);
  });

  test("keeps the screen-reader live region and announcer wired", () => {
    assert.match(html, /id="srAnnounce"[^>]+aria-live="polite"[^>]+aria-atomic="true"/);
    assert.match(surface, /function announce\(text\)/);
    assert.match(surface, /announceAgentTransition\(/);
  });

  test("guards the inbound message listener against malformed payloads", () => {
    assert.match(surface, /if \(!msg \|\| typeof msg !== "object"\) return;/);
  });

  test("renders Many Heads live-channel task events as nested message bubbles", () => {
    assert.match(surface, /msg\.type === "liveChannelEvent"/);
    assert.match(surface, /function appendLiveChannelEvent\(messageId, event\)/);
    assert.match(surface, /message\.liveChannelEvents = events\.slice\(-50\)/);
    assert.match(surface, /function renderLiveChannelEvents\(events\)/);
    assert.match(surface, /function renderLiveChannelEvent\(event\)/);
    assert.match(surface, /liveChannelKindLabel\(event && event\.kind\)/);
    assert.match(surface, /payload\.outputFileTruncated/);
    assert.match(html, /\.live-channel-events \{/);
    assert.match(html, /\.live-channel-event \{/);
    assert.match(html, /\.live-channel-output \{/);
  });

  test("keeps Command Center disabled-state rendering and guards in place", () => {
    assert.match(html, /\.command-option\[aria-disabled="true"\]/);
    assert.match(surface, /const reason = enabled \? "" : disabledReason\(action\)/);
    assert.match(surface, /class="command-why"> - /);
    assert.match(surface, /option\.getAttribute\("aria-disabled"\) === "true"/);
    assert.match(surface, /selected\.getAttribute\("aria-disabled"\) === "true"/);
  });

  test("keeps critical controls real buttons and the composer a textarea", () => {
    assert.match(html, /<textarea id="composer"/);
    assert.match(html, /<button id="sendBtn" type="button">/);
    assert.match(html, /<button id="stopBtn" class="danger" type="button">/);
    assert.doesNotMatch(html, /<button(?![^>]*\btype=)/);
  });

  test("keeps explicit responsive breakpoints for the stream-first shell", () => {
    for (const width of [900, 720, 480]) {
      assert.match(html, new RegExp(`@media \\(max-width: ${width}px\\)`), `missing ${width}px breakpoint`);
    }
  });

  test("keeps usage visible outside the overflow-clipped secondary rail", () => {
    const primaryStart = html.indexOf('<div class="rail-primary">');
    const secondaryStart = html.indexOf('class="rail-secondary"');
    const usage = html.indexOf('id="usageRail"');
    assert.ok(primaryStart >= 0, "missing primary rail");
    assert.ok(secondaryStart >= 0, "missing secondary rail");
    assert.ok(usage > primaryStart && usage < secondaryStart, "usage rail must stay in the always-visible primary rail");
    assert.match(html, /grid-template-areas:\s*"brand primary"\s*"secondary secondary"/);
    assert.match(html, /\.rail-primary \{[\s\S]*grid-area: primary;/);
    assert.match(html, /\.rail-secondary-wrap \{[\s\S]*grid-area: secondary;/);
  });

  test("keeps usage rail visually emphasized at zero usage", () => {
    assert.match(html, /\.rail-primary #usageRail \{/);
    assert.match(html, /\.rail-primary #usageRail \{[\s\S]*border-color: var\(--focus\);/);
    assert.match(html, /\.rail-primary #usageRail \{[\s\S]*font-weight: 650;/);
  });

  test("top rail can reset the pinned objective", () => {
    assert.match(html, /id="resetObjectiveBtn"[^>]+title="Clear the pinned room objective"/);
    assert.match(surface, /resetObjectiveBtn\.addEventListener\("click", \(\) => vscode\.postMessage\(\{ type: "resetObjective" \}\)\)/);
    assert.match(surface, /resetObjectiveBtn\.disabled = !!state\.canOpenFolder \|\| !\(state\.objective \|\| ""\)\.trim\(\)/);
  });

  test("centers the transcript at a readable measure without narrowing the shell", () => {
    assert.match(html, /--stream-width:\s*1120px/);
    assert.match(html, /\.message \{[\s\S]*width: min\(100%, var\(--stream-width\)\);[\s\S]*margin: 0 auto 13px;/);
    assert.match(html, /\.phase-mark \{[\s\S]*width: min\(100%, var\(--stream-width\)\);/);
    assert.doesNotMatch(html, /#messages \{[^}]*max-width:/);
  });

  test("keeps secondary rail overflow keyboard-scrollable and explicitly expandable", () => {
    assert.match(html, /class="rail-secondary" role="region" tabindex="0"[^>]+Scroll horizontally/);
    assert.match(html, /id="railOverflowBtn"[^>]+aria-expanded="false"/);
    assert.match(html, /\.rail-secondary-wrap:not\(\.is-expanded\)[\s\S]*\.optional:not\(\.warn\):not\(\.error\)/);
    assert.match(surface, /railOverflowBtn\.addEventListener\("click", \(\) => setRailExpanded\(!railExpanded\)\)/);
    assert.match(surface, /railSecondaryWrap\.classList\.toggle\("is-expanded", railExpanded\)/);
    const compactStart = html.indexOf("@media (max-width: 900px)");
    const compactEnd = html.indexOf("@media (max-width: 720px)", compactStart);
    const compactCss = html.slice(compactStart, compactEnd);
    assert.ok(compactStart >= 0 && compactEnd > compactStart);
    assert.doesNotMatch(compactCss, /\.rail-chip\.optional[^\{]*\{\s*display:\s*none/);
    assert.doesNotMatch(html, /\.rail-objective,\s*\.rail-chip\.optional/);
  });

  test("foregrounds an untruncated user decision and hides an unavailable no-op", () => {
    assert.match(html, /class="decision-field decision-needed"><strong>Needs your decision<\/strong>/);
    assert.match(html, /\.decision-needed span \{[\s\S]*white-space: normal;[\s\S]*overflow-wrap: anywhere;/);
    assert.match(surface, /const needsUser = hasUserQuestion && !accepted/);
    assert.match(surface, /decisionStrip\.classList\.toggle\("needs-user", needsUser\)/);
    assert.match(surface, /accepted \? "Decision accepted"/);
    assert.match(surface, /acceptDefaultBtn\.classList\.toggle\("hidden", noAction\)/);
  });

  test("uses compact status controls and names safe auto-advance and Claude fanout precisely", () => {
    assert.match(html, /id="toggleRibbonsBtn"[^>]*>Hide status<\/button>/);
    assert.match(html, /data-ribbon-label="Verification"[^>]+aria-label="Collapse Verification status"/);
    assert.match(surface, /Auto-advance safe defaults: On/);
    assert.match(surface, /Toggle Claude Worker Fanout/);
    assert.match(surface, /does not add independent Hydra heads/);
    assert.doesNotMatch(surface, />Auto Accept: (?:On|Off)</);
  });

  test("labels failure diagnostics and falls back to normalized reply output", () => {
    assert.match(surface, /card\.diagnosticPreview \|\| card\.stderrPreview/);
    assert.match(surface, /Normalized reply \/ stdout/);
    assert.match(surface, /No diagnostic output captured/);
    assert.doesNotMatch(surface, /No stderr captured/);
  });

  test("uses the host first-speaker preference and makes the advertised Escape shortcut real", () => {
    assert.match(surface, /const requestedOpener = state\.firstSpeaker \|\| state\.defaultOpener \|\| currentRoster\[0\]\.id/);
    assert.match(surface, /defaultOpener = rosterById\[requestedOpener\] \? requestedOpener : currentRoster\[0\]\.id/);
    assert.match(surface, /if \(lastState\.canStop && !stopBtn\.disabled && !stopBtn\.classList\.contains\("hidden"\)\)/);
    assert.match(surface, /event\.preventDefault\(\);\s*stopBtn\.click\(\);/);
  });

  test("provides persistent labels, visible keyboard focus, and high-contrast fallbacks", () => {
    assert.match(html, /<label class="visually-hidden" for="composer">Message Hydra heads<\/label>/);
    assert.match(html, /<label class="visually-hidden" for="nativeAgentFilter">/);
    assert.match(html, /<label class="visually-hidden" for="nativeStatusFilter">/);
    assert.match(html, /id="paletteInput"[^>]+aria-label="Search Hydra commands"/);
    assert.match(html, /\[role="button"\]:focus-visible/);
    assert.match(html, /body\.vscode-high-contrast/);
    assert.match(html, /@media \(forced-colors: active\)/);
    assert.doesNotMatch(html, /--text-faint:\s*#5E6E78/);
  });

  test("uses the current host message names for command actions", () => {
    for (const type of hostMessages) {
      assert.match(surface, new RegExp(`(?::|\\?) "${type}"`), `missing host message ${type}`);
    }
  });

  test("keeps operational files, setup, and model actions discoverable in Command Center", () => {
    for (const id of [
      "open-objective",
      "open-agent-calls",
      "open-verification-file",
      "attach-files",
      "wiki-context",
      "choose-model",
      "toggle-many-heads",
      "many-heads-workers",
      "test-telegram",
      "fix-codex",
      "fix-claude",
    ]) {
      assert.match(surface, new RegExp(`id: "${id}"`), `missing command action ${id}`);
    }
  });

  test("model rail opens model-or-thinking chooser", () => {
    assert.match(html, /id="modelRail"[^>]+title="Click to change model or thinking level\."/);
    assert.match(surface, /const open = \(\) => vscode\.postMessage\(\{ type: "chooseModelOrEffort" \}\)/);
  });

  test("keeps every host Command Center action covered by the webview Command Center or a direct control", () => {
    for (const [action, patterns] of Object.entries(commandCenterActionCoverage)) {
      for (const pattern of patterns) {
        assert.match(surface, pattern, `missing webview coverage for ${action}: ${pattern}`);
      }
    }
  });

  test("keeps message head art anchored to one rendering site", () => {
    assert.equal((html.match(/\.head-art \{/g) ?? []).length, 1, "missing or duplicated base head-art CSS");
    assert.equal((html.match(/\.head-art img \{/g) ?? []).length, 1, "missing or duplicated head-art image CSS");
    assert.equal((scriptBody.match(/className = "head-art "/g) ?? []).length, 1, "missing or duplicated head-art DOM creation");
  });

  test("head color class derives from roster colorIndex metadata", () => {
    assert.match(scriptBody, /function headColorClass\(/, "webview must map role -> head-<index> class");
    // The single head-art DOM site is preserved (also pinned elsewhere in this file).
    assert.equal((scriptBody.match(/className = "head-art "/g) ?? []).length, 1);
  });

  test("projects status and authority rails from the configured roster", () => {
    assert.match(html, /id="agentStatusRail"[^>]+role="list"[^>]+aria-label="Hydra head status"/);
    assert.match(html, /id="authorityRail"[^>]+role="list"[^>]+aria-label="Hydra head authority"/);
    assert.doesNotMatch(html, /id="(?:codex|claude)(?:Status|Authority)"/);
    assert.match(scriptBody, /currentRoster = normalizeRoster\(state\.roster\)/);
    assert.match(scriptBody, /currentRoster\.map\(\(def\) => renderAgentStatus\(def, statuses && statuses\[def\.id\]\)\)/);
    assert.match(scriptBody, /agentStatusRail\.replaceChildren\(\.\.\.nodes\)/);
    assert.match(scriptBody, /currentRoster\.map\(\(def\) => renderAuthorityBadge\(def, summaries && summaries\[def\.id\]\)\)/);
    assert.match(scriptBody, /authorityRail\.replaceChildren\(\.\.\.nodes\)/);

    const authorityStart = scriptBody.indexOf("function renderAuthorityBadge(");
    const authorityEnd = scriptBody.indexOf("function compactStatusDetail(", authorityStart);
    const authorityBlock = scriptBody.slice(authorityStart, authorityEnd);
    assert.match(authorityBlock, /name\.textContent = def\.displayName/);
    assert.match(authorityBlock, /document\.createTextNode\(/);
    assert.doesNotMatch(authorityBlock, /innerHTML/);
  });

  test("cycles opener and builder controls through every configured head", () => {
    assert.match(scriptBody, /selectedOpener = nextRosterAgent\(selectedOpener\)/);
    assert.match(scriptBody, /function nextRosterAgent\(agent\)[\s\S]*currentRoster\.findIndex\(\(def\) => def\.id === agent\)/);
    assert.doesNotMatch(scriptBody, /selectedOpener === "codex" \? "claude" : "codex"/);
    assert.match(html, /id="builderButtons"[^>]+role="group"[^>]+aria-label="Choose a Hydra builder"/);
    assert.match(scriptBody, /function renderBuilderButtons\(canAssignBuilder, suggestedBuilder\)/);
    assert.match(scriptBody, /for \(const def of currentRoster\)/);
    assert.match(scriptBody, /button\.dataset\.builderId = def\.id/);
    assert.match(scriptBody, /type: "assignBuilder", builder: def\.id/);
    assert.match(scriptBody, /currentRoster\.length === 2[\s\S]*"Assign Builders: Both"[\s\S]*"Assign Builders: All " \+ currentRoster\.length \+ " Heads"/);
    assert.match(scriptBody, /id: "assign-builder-" \+ def\.id/);
  });

  test("renders passive standings without granting operational authority", () => {
    assert.match(html, /id="standingsRail"[^>]+role="button"/);
    assert.match(html, /id="standingsRail" class="rail-chip"/);
    assert.match(html, /id="standingsRail"[^>]*aria-haspopup="dialog"[^>]*aria-controls="panelOverlay"/);
    assert.match(html, /id="standingsRail"[^>]*>scoreboard: unranked<\/span>/);
    assert.match(html, /<h3>Evidence Scoreboard<\/h3>/);
    assert.match(scriptBody, /name: "Open Evidence Scoreboard"/);
    assert.match(scriptBody, /name: "Open Scoreboard Markdown"/);
    assert.doesNotMatch(scriptBody, /standingsRail\.className = "rail-chip optional/);
    assert.match(html, /data-view="standings"/);
    assert.match(html, /Passive only: evidence scores never change native permissions, approval rights, builder assignment, or speaking order/);
    assert.match(scriptBody, /renderStandings\(state\.standings \|\| \{\}\)/);
    assert.match(scriptBody, /function renderStandings\(data\)/);
    assert.match(scriptBody, /const ranked = overall\.filter\(\(standing\) => typeof standing\.score === "number" && Number\.isFinite\(standing\.score\)\)/);
    assert.match(scriptBody, /const leaders = ranked\.filter\(\(standing\) => standing\.score === leader\.score\)/);
    assert.match(scriptBody, /const maturity = leadersProvisional \? "provisional " : ""/);
    assert.match(scriptBody, /"scoreboard: " \+ leaders\.length \+ "-way " \+ maturity \+ "tie #1 "/);
    assert.match(scriptBody, /setInteractiveRailState\(standingsRail, scoreboardText, "Open passive Hydra Scoreboard"\)/);
    assert.match(scriptBody, /this never changes native authority or speaking order/);
    assert.match(scriptBody, /if \(previousScore === undefined \|\| standing\.score !== previousScore\) visibleRank = scoredPosition/);
    assert.match(scriptBody, /rank\.textContent = scoreable \? "#" \+ visibleRank : "—"/);
    assert.match(scriptBody, /counts\.trustedCorrect \?\? counts\.correct/);
    assert.match(scriptBody, /data\.mirrorError/);
    assert.match(scriptBody, /vscode\.postMessage\(\{ type: "recordScoreVerdict" \}\)/);
    assert.match(scriptBody, /vscode\.postMessage\(\{ type: "openStandings" \}\)/);
    assert.match(scriptBody, /vscode\.postMessage\(\{ type: "openScoreEvidence" \}\)/);
    assert.match(scriptBody, /vscode\.postMessage\(\{ type: "reverseScoreVerdict" \}\)/);
    assert.match(scriptBody, /vscode\.postMessage\(\{ type: "adjudicatePendingScoreClaim" \}\)/);
    assert.match(html, /id="openEvidenceBtn"/);
    assert.match(html, /id="reverseVerdictBtn"/);
    assert.match(html, /id="adjudicatePendingBtn"/);

    const standingsStart = scriptBody.indexOf("function renderStandings(");
    const standingsEnd = scriptBody.indexOf("function renderDuels(", standingsStart);
    const standingsBlock = scriptBody.slice(standingsStart, standingsEnd);
    assert.ok(standingsStart >= 0 && standingsEnd > standingsStart);
    assert.match(standingsBlock, /standingsBoard\.replaceChildren\(\)/);
    assert.match(standingsBlock, /textContent/);
    assert.doesNotMatch(standingsBlock, /innerHTML/);
  });

  test("keeps formal duels separate, sealed, responsive, and non-authoritative", () => {
    assert.match(html, /id="duelsRail" class="rail-chip" role="button" tabindex="0"/);
    assert.match(html, /id="duelsRail"[^>]*aria-haspopup="dialog"[^>]*aria-controls="panelOverlay"/);
    assert.doesNotMatch(scriptBody, /duelsRail\.className = "rail-chip optional/);
    assert.match(html, /data-view="duels"/);
    assert.match(html, /Heads initiate their own formal duels from consequential, falsifiable disagreements in serial discussion/);
    assert.match(html, /Hydra admits or rejects each challenge by policy, then automatically runs both sealed commitments/);
    assert.match(html, /the human does not create, accept, or author either answer/);
    assert.match(html, /No duel is downgraded to an exhibition/);
    assert.match(html, /Both heads receive equal maximum Hydra-granted permissions/);
    assert.match(html, /Hydra locks each effective command, model, arguments, working directory, and environment digest/);
    assert.match(html, /vendor-native tool catalogs and provider capabilities can still differ/);
    assert.match(html, /live mutation monitoring outside <code>\.git<\/code> and Hydra-owned <code>\.hydra<\/code>/);
    assert.match(html, /not an absolute defense against a malicious same-user process/);
    assert.match(html, /Persistent full-native consent is still required/);
    assert.match(html, /The human independently judges the revealed evidence/);
    assert.match(html, /Results never change permissions, approvals, builder assignment, speaking order, safety policy, or orchestration authority/);
    assert.match(html, /id="agentDuelMode"[^>]*>Agent challenges: enabled<\/span>/);
    assert.doesNotMatch(html, /id="createDuelBtn"|>New Duel<\/button>/);
    assert.match(html, /id="openDuelAuditBtn"[^>]*>Open Audit<\/button>/);
    assert.match(html, /id="correctDuelResultBtn"[^>]*>Correct Result<\/button>/);
    assert.match(html, /\.duel-reveal \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(html, /@media \(max-width: 720px\)[\s\S]*\.duel-reveal \{ grid-template-columns: 1fr; \}/);

    assert.match(scriptBody, /renderDuels\(state\.duels \|\| \{\}\)/);
    assert.match(scriptBody, /function renderDuels\(data\)/);
    assert.match(scriptBody, /data && data\.agentInitiatedEnabled/);
    assert.match(scriptBody, /data && data\.automationRunning/);
    assert.match(scriptBody, /data && data\.automationQueued/);
    assert.match(scriptBody, /"Agent challenges: running"/);
    assert.match(scriptBody, /"Agent challenges: enabled"/);
    assert.match(scriptBody, /"Agent challenges: paused"/);
    const standingsRenderer = scriptBody.slice(
      scriptBody.indexOf("function renderStandings(data)"),
      scriptBody.indexOf("function renderDuels(data)"),
    );
    const duelRenderer = scriptBody.slice(
      scriptBody.indexOf("function renderDuels(data)"),
      scriptBody.indexOf("function duelSection("),
    );
    assert.doesNotMatch(standingsRenderer, /agentDuelMode/);
    assert.match(duelRenderer, /agentDuelMode/);
    assert.match(scriptBody, /duelsBoard\.replaceChildren\(\)/);
    assert.match(scriptBody, /activeTotal > active\.length/);
    assert.match(scriptBody, /ratingsTotal > ratings\.length/);
    assert.match(scriptBody, /recentTotal > recent\.length/);
    assert.match(scriptBody, /const safeCommitments = Array\.isArray\(duel && duel\.commitments\) && duel\.commitments\.length === 2 \? duel\.commitments : \[\]/);
    assert.match(scriptBody, /Answers remain hidden until both heads have committed/);
    assert.match(scriptBody, /if \(safeCommitments\.length === 2\)/);
    assert.match(scriptBody, /visibleRatedMatches = Math\.floor\(ratings\.reduce[\s\S]*\/ 2\)/);
    assert.match(scriptBody, /data && data\.ratedDuelCount/);
    assert.match(scriptBody, /duelStatus === "awaiting_acceptance"[\s\S]*\? "legacy closure pending"/);
    assert.match(scriptBody, /Historical operator-created challenge: close it without Elo/);
    assert.match(scriptBody, /"Legacy unranked history: " \+ String\(duel\.ratingIneligibilityReason\)/);
    assert.match(scriptBody, /hasSharedEvidencePacket[\s\S]*\? "Shared evidence starting brief"[\s\S]*: "No shared evidence brief · legacy unranked"/);
    assert.match(scriptBody, /Adjudication contract: /);
    assert.match(scriptBody, /duel && duel\.createdBy === "hydra-runtime"/);
    assert.match(scriptBody, /initiated this challenge from its own room reply/);
    assert.match(scriptBody, /Hydra policy admitted it/);
    assert.match(scriptBody, /duel && duel\.sharedEvidencePacket/);
    assert.match(scriptBody, /evidencePacketText\.tabIndex = 0/);
    assert.match(scriptBody, /Locked shared evidence packet text/);
    assert.match(scriptBody, /Legacy duel: no shared evidence brief was locked\. It cannot enter the current agent-initiated ladder and should be closed/);
    assert.match(html, /\.duel-evidence-packet pre/);
    assert.match(scriptBody, /textarea:not\(\[disabled\]\), summary, \[tabindex\]/);
    assert.match(scriptBody, /function duelActionLabel\(status, rated\)/);
    for (const label of ["Close Legacy Challenge", "Verify Paired Reveal", "Judge Revealed Duel"]) {
      assert.match(scriptBody, new RegExp(`return "${label}"`));
    }
    assert.match(scriptBody, /return rated[\s\S]*\? "Resume Agent Automation"[\s\S]*: "Close Legacy Challenge"/);
    assert.match(scriptBody, /automatic private calls to both configured heads/);
    assert.match(scriptBody, /historical operator-created duel cannot advance or enter the current ladder/);
    assert.match(scriptBody, /setInteractiveRailState\(duelsRail, "duels: " \+ active\.length \+ " active", "Open formal Hydra duels"\)/);
    assert.match(scriptBody, /Hydra-bound head run/);
    assert.match(scriptBody, /Legacy operator entry · unranked history only/);
    assert.match(scriptBody, /receipt\.capabilityPolicy/);
    assert.match(scriptBody, /commitment\.captureRef/);
    assert.match(scriptBody, /function duelOutcomeLabel\(value\)/);
    assert.match(scriptBody, /duel\.resolution\.ratingDeltas/);
    assert.match(scriptBody, /Elo: no change/);
    assert.match(scriptBody, /Ruling evidence:/);
    assert.match(scriptBody, /duel\.resolution\.evidenceRef/);
    assert.match(scriptBody, /function groupDuelRatingsByDomain\(ratings\)/);
    assert.match(scriptBody, /Supreme Head · #1/);
    assert.match(scriptBody, /Provisional #1/);
    assert.match(scriptBody, /Joint provisional #1/);
    assert.match(scriptBody, /Joint #1/);
    assert.match(scriptBody, /Elo to #1/);
    assert.match(scriptBody, /visibleRank = index \+ 1/);
    assert.match(scriptBody, /leaderRating - currentRating/);
    assert.match(scriptBody, /Competitive rank for this domain only\. It grants no Hydra authority/);
    assert.match(scriptBody, /document\.createElement\("h4"\)/);
    assert.match(scriptBody, /document\.createElement\("h5"\)/);
    assert.match(scriptBody, /setAttribute\("aria-labelledby",/);
    assert.match(scriptBody, /function duelHeadingId\(prefix, value\)/);
    assert.doesNotMatch(scriptBody, /vscode\.postMessage\(\{ type: "createDuel" \}\)/);
    assert.match(scriptBody, /vscode\.postMessage\(\{ type: "advanceDuel", duelId \}\)/);
    assert.match(scriptBody, /vscode\.postMessage\(\{ type: "cancelDuel", duelId \}\)/);
    assert.match(scriptBody, /vscode\.postMessage\(\{ type: "openDuelAudit" \}\)/);
    assert.match(scriptBody, /vscode\.postMessage\(\{ type: "correctDuelResult" \}\)/);
    assert.match(scriptBody, /msg\.type === "openPanel" && msg\.panel === "duels"\) openPanel\("duels"\)/);

    const duelsStart = scriptBody.indexOf("function renderDuels(");
    const duelsEnd = scriptBody.indexOf("function scorePercent(", duelsStart);
    const duelsBlock = scriptBody.slice(duelsStart, duelsEnd);
    assert.ok(duelsStart >= 0 && duelsEnd > duelsStart);
    assert.match(duelsBlock, /textContent/);
    assert.doesNotMatch(duelsBlock, /innerHTML/);
  });

  test("keeps competition surfaces visible before dynamic N-head rails", () => {
    const transport = html.indexOf('id="transportChip"');
    const standings = html.indexOf('id="standingsRail"');
    const duels = html.indexOf('id="duelsRail"');
    const statuses = html.indexOf('id="agentStatusRail"');
    const authority = html.indexOf('id="authorityRail"');
    assert.ok(transport >= 0 && transport < standings);
    assert.ok(standings < duels);
    assert.ok(duels < statuses);
    assert.ok(statuses < authority);
  });

  test("uses roster display names for historical messages, decisions, and usage", () => {
    assert.match(scriptBody, /speaker\.textContent = agentDisplayName\(m\.role \|\| "system"\)/);
    assert.match(scriptBody, /cell\(agentDisplayName\(decision\.agent\)/);
    assert.match(scriptBody, /for \(const head of currentRoster\)/);
    assert.match(scriptBody, /Object\.keys\(agents\)/);
    assert.doesNotMatch(scriptBody, /agentUsageLabel\("codex", agents\.codex\)/);
    assert.doesNotMatch(scriptBody, /agentUsageLabel\("claude", agents\.claude\)/);
  });

  test("keeps transcript scroll anchored unless the reader is already near the bottom", () => {
    assert.match(surface, /MESSAGE_BOTTOM_STICKY_PX = 32/);
    assert.match(surface, /let messageAutoStick = true/);
    assert.match(surface, /addEventListener\("scroll"[\s\S]*messageAutoStick = false[\s\S]*isNearMessageBottom\(\)[\s\S]*messageAutoStick = true/);
    assert.match(surface, /const scroll = captureMessageScroll\(\);[\s\S]*restoreMessageScroll\(scroll\);/);
    assert.match(surface, /function isNearMessageBottom\(\)[\s\S]*scrollHeight - messagesEl\.scrollTop - messagesEl\.clientHeight <= MESSAGE_BOTTOM_STICKY_PX/);
    assert.match(surface, /function captureMessageAnchor\(\)[\s\S]*querySelectorAll\("\.message\[data-mid\]"\)/);
    assert.match(surface, /function restoreMessageScroll\(scroll\)[\s\S]*setMessageScrollTop\(messagesEl\.scrollHeight\)/);
    assert.match(html, /#messages \{[\s\S]*scroll-behavior: auto;[\s\S]*overflow-anchor: none;/);
    assert.equal((scriptBody.match(/messagesEl\.scrollTop = messagesEl\.scrollHeight/g) ?? []).length, 0, "bottom snap must go through the scroll restorer");
  });

  test("renders the handoff confirm chip and wires its controls", () => {
    assert.match(html, /id="handoffStrip"/);
    assert.match(html, /<select id="handoffAction"/);
    assert.match(html, /<button id="handoffConfirmBtn" [^>]*type="button"/);
    assert.match(html, /<button id="handoffPreviewBtn" [^>]*type="button"/);
    assert.match(html, /<button id="handoffDismissBtn" [^>]*type="button"/);
    assert.match(surface, /vscode\.postMessage\(\{ type: "confirmHandoff", action: [^}]+\}\)/);
    assert.match(surface, /vscode\.postMessage\(\{ type: "dismissHandoff" \}\)/);
    assert.match(surface, /vscode\.postMessage\(\{ type: "previewHandoff" \}\)/);
  });
});
