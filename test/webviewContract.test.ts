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
  "assignClaudeBtn",
  "assignCodexBtn",
  "autoAdvanceDefaultsBtn",
  "authorityBtn",
  "autopilotText",
  "attachFilesBtn",
  "attachmentTray",
  "captureNativeCapabilitiesBtn",
  "captureNativeDataSnapshotBtn",
  "claudeAuthority",
  "claudeCommandBtn",
  "claudeRawLineBtn",
  "claudeStatus",
  "clearAttachmentsBtn",
  "clearNativeActionsBtn",
  "cmdOverlay",
  "codexAuthority",
  "codexCommandBtn",
  "codexRawLineBtn",
  "codexStatus",
  "commandCenterBtn",
  "commandList",
  "composer",
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
  "editBoard",
  "editsPanelCount",
  "editsRail",
  "fixClaudeBtn",
  "fixCodexBtn",
  "handBackBtn",
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
  "clearAttachment",
  "clearAttachments",
  "resetObjective",
  "testTelegram",
  "fixClaudePath",
  "fixCodexPath",
  "handBack",
  "nativeAction",
  "openAgentCalls",
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
  "toggleAutoAdvanceActionableDefaults",
  "useOneShotTransport",
  "useTerminalBridge",
] as const;

const commandCenterActionCoverage: Record<CommandCenterActionId, readonly RegExp[]> = {
  openWorkspaceFolder: [/id: "open-folder"/, /type: "openWorkspaceFolder"/],
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
    const secondaryStart = html.indexOf('<div class="rail-secondary">');
    const usage = html.indexOf('id="usageRail"');
    assert.ok(primaryStart >= 0, "missing primary rail");
    assert.ok(secondaryStart >= 0, "missing secondary rail");
    assert.ok(usage > primaryStart && usage < secondaryStart, "usage rail must stay in the always-visible primary rail");
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
});
