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
  "captureNativeCapabilitiesBtn",
  "captureNativeDataSnapshotBtn",
  "claudeAuthority",
  "claudeCommandBtn",
  "claudeRawLineBtn",
  "claudeStatus",
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
  "captureNativeCapabilities",
  "captureNativeDataSnapshot",
  "chooseEffort",
  "chooseModel",
  "changeCapabilityProfile",
  "testTelegram",
  "fixClaudePath",
  "fixCodexPath",
  "handBack",
  "nativeAction",
  "openAgentCalls",
  "openRunFailureFile",
  "openObjective",
  "openLastPrompt",
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
  testTelegram: [/id: "test-telegram"/, /type: "testTelegram"/],
  changeCapabilityProfile: [/id: "change-profile"/, /type: "changeCapabilityProfile"/],
  requestReview: [/id: "request-review"/, /type: "requestReview"/],
  handBack: [/id: "hand-back"/, /type: "handBack"/],
  runVerification: [/id: "verification"/, /type: "runVerification"/],
  nativeAction: [/id: "native-action"/, /type: "nativeAction"/],
  pokeBothTerminalsWithDiff: [/id="pokeBothDiffBtn"/, /pokeBothDiffBtn\.addEventListener\("click"/],
  openObjective: [/id: "open-objective"/, /type: "openObjective"/],
  openLastPrompt: [/id: "open-last-prompt"/, /type: "openLastPrompt"/],
  openVerification: [/id: "open-verification-file"/, /type: "openVerification"/],
  openDecisions: [/id: "open-decisions"/, /type: "openDecisions"/],
  openSessionBrief: [/id: "session-brief"/, /type: "openSessionBrief"/],
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
    assert.match(surface, /commandCenterBtn\.focus\(\)/);
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
      "choose-model",
      "test-telegram",
      "fix-codex",
      "fix-claude",
    ]) {
      assert.match(surface, new RegExp(`id: "${id}"`), `missing command action ${id}`);
    }
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
});
