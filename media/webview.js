// @ts-check
// Hydra webview client. Built as plain JS (with VS Code JS language-service
// type-checking via @ts-check) because the file uses DOM globals that the
// extension-host tsconfig deliberately excludes. The single dynamic value
// from the host — HEAD_ASSETS — is passed via a body data attribute.

const vscode = acquireVsCodeApi();
const webviewState = vscode.getState ? (vscode.getState() || {}) : {};
const MESSAGE_BOTTOM_STICKY_PX = 32;
const MESSAGE_SCROLL_EPSILON_PX = 2;
let messageAutoStick = true;
let lastObservedMessageScrollTop = 0;
let programmaticMessageScroll = false;
/** HEAD_ASSETS is injected by the host as JSON in a body data attribute.
 *  Parse defensively — a malformed attribute should not crash the webview;
 *  head art falls back to glyphs when the URLs are missing.
 */
const HEAD_ASSETS = (() => {
  try { return JSON.parse(document.body.dataset.headAssets || "{}"); }
  catch (_) { return {}; }
})();
const app = document.getElementById("app");
const ribbonStack = document.getElementById("ribbonStack");
const ribbonMinimizedSummary = document.getElementById("ribbonMinimizedSummary");
const toggleRibbonsBtn = document.getElementById("toggleRibbonsBtn");
const messagesEl = document.getElementById("messages");
const composer = document.getElementById("composer");
const transportChip = document.getElementById("transportChip");
const phaseChip = document.getElementById("phaseChip");
const objectiveText = document.getElementById("objectiveText");
const objectiveTextShim = document.getElementById("objectiveTextShim");
const resetObjectiveBtn = document.getElementById("resetObjectiveBtn");
const codexStatus = document.getElementById("codexStatus");
const claudeStatus = document.getElementById("claudeStatus");
const codexAuthority = document.getElementById("codexAuthority");
const claudeAuthority = document.getElementById("claudeAuthority");
const terminalSessions = document.getElementById("terminalSessions");
const setupStrip = document.getElementById("setupStrip");
const autopilotText = document.getElementById("autopilotText");
const decisionStrip = document.getElementById("decisionStrip");
const decisionCount = document.getElementById("decisionCount");
const decisionDefault = document.getElementById("decisionDefault");
const decisionRecommendation = document.getElementById("decisionRecommendation");
const decisionNeeded = document.getElementById("decisionNeeded");
const decisionBlockers = document.getElementById("decisionBlockers");
const decisionBoard = document.getElementById("decisionBoard");
const acceptDefaultBtn = document.getElementById("acceptDefaultBtn");
const autoAdvanceDefaultsBtn = document.getElementById("autoAdvanceDefaultsBtn");
const openerBtn = document.getElementById("openerBtn");
const commandCenterBtn = document.getElementById("commandCenterBtn");
const setObjectiveBtn = document.getElementById("setObjectiveBtn");
const previewPromptBtn = document.getElementById("previewPromptBtn");
const openLastPromptBtn = document.getElementById("openLastPromptBtn");
const attachFilesBtn = document.getElementById("attachFilesBtn");
const clearAttachmentsBtn = document.getElementById("clearAttachmentsBtn");
const attachmentTray = document.getElementById("attachmentTray");
const profileBtn = document.getElementById("profileBtn");
const nativeActionBtn = document.getElementById("nativeActionBtn");
const sendBtn = document.getElementById("sendBtn");
const stopBtn = document.getElementById("stopBtn");
const archiveChatBtn = document.getElementById("archiveChatBtn");
const assignCodexBtn = document.getElementById("assignCodexBtn");
const assignClaudeBtn = document.getElementById("assignClaudeBtn");
const assignBothBtn = document.getElementById("assignBothBtn");
const reviewBtn = document.getElementById("reviewBtn");
const handBackBtn = document.getElementById("handBackBtn");
const nativeTerminalsBtn = document.getElementById("nativeTerminalsBtn");
const openNativeTerminalsBtn = document.getElementById("openNativeTerminalsBtn");
const codexCommandBtn = document.getElementById("codexCommandBtn");
const claudeCommandBtn = document.getElementById("claudeCommandBtn");
const codexRawLineBtn = document.getElementById("codexRawLineBtn");
const claudeRawLineBtn = document.getElementById("claudeRawLineBtn");
const pokeCodexBtn = document.getElementById("pokeCodexBtn");
const pokeClaudeBtn = document.getElementById("pokeClaudeBtn");
const pokeCodexEditorBtn = document.getElementById("pokeCodexEditorBtn");
const pokeClaudeEditorBtn = document.getElementById("pokeClaudeEditorBtn");
const pokeCodexDiffBtn = document.getElementById("pokeCodexDiffBtn");
const pokeClaudeDiffBtn = document.getElementById("pokeClaudeDiffBtn");
const pokeBothBtn = document.getElementById("pokeBothBtn");
const pokeBothEditorBtn = document.getElementById("pokeBothEditorBtn");
const pokeBothDiffBtn = document.getElementById("pokeBothDiffBtn");
const testBridgeBtn = document.getElementById("testBridgeBtn");
const terminalHealthBtn = document.getElementById("terminalHealthBtn");
const authorityBtn = document.getElementById("authorityBtn");
const doctorBtn = document.getElementById("doctorBtn");
const resetTurnBtn = document.getElementById("resetTurnBtn");
const fixCodexBtn = document.getElementById("fixCodexBtn");
const fixClaudeBtn = document.getElementById("fixClaudeBtn");
const retryAutopilotBtn = document.getElementById("retryAutopilotBtn");
const safeModeBtn = document.getElementById("safeModeBtn");
const verificationStrip = document.getElementById("verificationStrip");
const verificationText = document.getElementById("verificationText");
const verificationRail = document.getElementById("verificationRail");
const verificationDetails = document.getElementById("verificationDetails");
const editsRail = document.getElementById("editsRail");
const editsPanelCount = document.getElementById("editsPanelCount");
const editBoard = document.getElementById("editBoard");
const nativeActionStrip = document.getElementById("nativeActionStrip");
const nativeActionText = document.getElementById("nativeActionText");
const nativeActionRail = document.getElementById("nativeActionRail");
const nativeActionBoard = document.getElementById("nativeActionBoard");
const nativePanelCount = document.getElementById("nativePanelCount");
const nativeAgentFilter = document.getElementById("nativeAgentFilter");
const nativeStatusFilter = document.getElementById("nativeStatusFilter");
const clearNativeActionsBtn = document.getElementById("clearNativeActionsBtn");
const workQueueStrip = document.getElementById("workQueueStrip");
const workQueueText = document.getElementById("workQueueText");
const workQueueRail = document.getElementById("workQueueRail");
const workQueueBoard = document.getElementById("workQueueBoard");
const queuePanelCount = document.getElementById("queuePanelCount");
const runVerificationBtn = document.getElementById("runVerificationBtn");
const openVerificationBtn = document.getElementById("openVerificationBtn");
const openNativeActionsBtn = document.getElementById("openNativeActionsBtn");
const openWorkQueuePanelBtn = document.getElementById("openWorkQueuePanelBtn");
const openFolderBtn = document.getElementById("openFolderBtn");
const openSessionBriefBtn = document.getElementById("openSessionBriefBtn");
const openSupportBundleBtn = document.getElementById("openSupportBundleBtn");
const captureNativeCapabilitiesBtn = document.getElementById("captureNativeCapabilitiesBtn");
const captureNativeDataSnapshotBtn = document.getElementById("captureNativeDataSnapshotBtn");
const openTranscriptBtn = document.getElementById("openTranscriptBtn");
const archiveClearBtn = document.getElementById("archiveClearBtn");
const openDecisionsBtn = document.getElementById("openDecisionsBtn");
const openNativeActionsFooterBtn = document.getElementById("openNativeActionsFooterBtn");
const decisionRail = document.getElementById("decisionRail");
const decisionRiskChip = document.getElementById("decisionRiskChip");
const decisionPanelCount = document.getElementById("decisionPanelCount");
const usageRail = document.getElementById("usageRail");
const usagePanelCount = document.getElementById("usagePanelCount");
const usageSummary = document.getElementById("usageSummary");
const usageBoard = document.getElementById("usageBoard");
const modelRail = document.getElementById("modelRail");
if (usageRail) {
  const open = () => openPanel("usage");
  usageRail.addEventListener("click", open);
  usageRail.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
}
if (modelRail) {
  const open = () => vscode.postMessage({ type: "chooseModelOrEffort" });
  modelRail.addEventListener("click", open);
  modelRail.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
}
if (editsRail) {
  const open = () => openPanel("edits");
  editsRail.addEventListener("click", open);
  editsRail.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
}
const cmdOverlay = document.getElementById("cmdOverlay");
const paletteInput = document.getElementById("paletteInput");
const commandList = document.getElementById("commandList");
const panelOverlay = document.getElementById("panelOverlay");

const labels = { user: "human", codex: "codex", claude: "claude", system: "system" };
let lastMessages = [];
let pendingLocalUserMessages = [];
let lastFilteredNativeActions = [];
let defaultOpener = "codex";
let selectedOpener = "codex";
let hasOpenerOverride = false;
let transport = "oneShot";
let lastNativeActions = [];
let lastState = {};
let ribbonsMinimized = !!webviewState.ribbonsMinimized;
let collapsedRibbons = new Set(Array.isArray(webviewState.collapsedRibbons) ? webviewState.collapsedRibbons : []);

const ACTIONS = [
  { id: "send", group: "Suggested", name: "Send", what: "Start a Hydra turn with the current opener", acc: "Ctrl+Enter", run: () => sendBtn.click(), enabled: () => !sendBtn.disabled },
  { id: "stop", group: "Suggested", name: "Stop Current Turn", what: "Cancel the active agent call", acc: "Esc", run: () => stopBtn.click(), enabled: () => !stopBtn.classList.contains("hidden") && !stopBtn.disabled },
  { id: "pin-objective", group: "Objective", name: "Pin Objective", what: "Use composer text as room objective", run: () => setObjectiveBtn.click(), enabled: () => !setObjectiveBtn.disabled },
  { id: "preview-prompt", group: "Objective", name: "Preview Prompt", what: "Inspect the exact next prompt", run: () => previewPromptBtn.click(), enabled: () => !previewPromptBtn.disabled },
  { id: "open-last-prompt", group: "Objective", name: "Open Last Prompt", what: "Reopen the latest persisted prompt envelope", run: () => openLastPromptBtn.click(), enabled: () => !openLastPromptBtn.disabled },
  { id: "attach-files", group: "Objective", name: "Attach Files", what: "Attach files or documents to the next room turn", run: () => attachFilesBtn.click(), enabled: () => !attachFilesBtn.disabled },
  { id: "clean-workspace-state", group: "Objective", name: "Clean Workspace State", what: "Compact old prompt bodies and prune stale .hydra diagnostics", run: () => vscode.postMessage({ type: "cleanWorkspaceState" }), enabled: () => !lastState.canOpenFolder },
  { id: "archive-chat", group: "Objective", name: "Archive Chat", what: "Archive transcript and clear room", run: () => archiveChatBtn.click(), enabled: () => !archiveChatBtn.disabled },
  { id: "accept-default", group: "Workflow", name: "Accept Default", what: "Run the latest decision default", run: () => acceptDefaultBtn.click(), enabled: () => !acceptDefaultBtn.disabled },
  { id: "toggle-auto-accept-default", group: "Workflow", name: "Toggle Auto Accept Default", what: "Turn automatic default acceptance on or off", run: () => autoAdvanceDefaultsBtn.click(), enabled: () => !autoAdvanceDefaultsBtn.disabled },
  { id: "assign-codex", group: "Workflow", name: "Assign Builder: Codex", what: "Let Codex edit files", run: () => assignCodexBtn.click(), enabled: () => !assignCodexBtn.classList.contains("hidden") && !assignCodexBtn.disabled },
  { id: "assign-claude", group: "Workflow", name: "Assign Builder: Claude", what: "Let Claude edit files", run: () => assignClaudeBtn.click(), enabled: () => !assignClaudeBtn.classList.contains("hidden") && !assignClaudeBtn.disabled },
  { id: "assign-both", group: "Workflow", name: "Assign Builders: Both", what: "Run Codex and Claude as parallel Build workers", run: () => assignBothBtn.click(), enabled: () => !assignBothBtn.classList.contains("hidden") && !assignBothBtn.disabled },
  { id: "request-review", group: "Workflow", name: "Request Review", what: "Ask the non-builder to review the diff", run: () => reviewBtn.click(), enabled: () => !reviewBtn.classList.contains("hidden") && !reviewBtn.disabled },
  { id: "hand-back", group: "Workflow", name: "Hand Back to Builder", what: "Return review feedback to the builder", run: () => handBackBtn.click(), enabled: () => !handBackBtn.classList.contains("hidden") && !handBackBtn.disabled },
  { id: "reset-turn", group: "Workflow", name: "Reset Stuck Turn", what: "Recover from a stuck state", run: () => resetTurnBtn.click(), enabled: () => !resetTurnBtn.classList.contains("hidden") && !resetTurnBtn.disabled },
  { id: "native-action", group: "Terminals", name: "Native Action", what: "Choose a direct native terminal action", run: () => nativeActionBtn.click(), enabled: () => !nativeActionBtn.classList.contains("hidden") && !nativeActionBtn.disabled },
  { id: "toggle-transport", group: "Terminals", name: "Toggle Terminal Bridge", what: "Switch between safe one-shot and terminal bridge", run: () => nativeTerminalsBtn.click(), enabled: () => !nativeTerminalsBtn.disabled },
  { id: "open-terminals", group: "Terminals", name: "Open Native Terminals", what: "Open visible Codex and Claude terminals", run: () => openNativeTerminalsBtn.click(), enabled: () => !openNativeTerminalsBtn.disabled },
  { id: "codex-command", group: "Terminals", name: "Codex Command", what: "Run exact Codex native args from composer", run: () => codexCommandBtn.click(), enabled: () => !codexCommandBtn.disabled },
  { id: "claude-command", group: "Terminals", name: "Claude Command", what: "Run exact Claude native args from composer", run: () => claudeCommandBtn.click(), enabled: () => !claudeCommandBtn.disabled },
  { id: "codex-raw", group: "Terminals", name: "Codex Raw Line", what: "Send composer as raw terminal input", run: () => codexRawLineBtn.click(), enabled: () => !codexRawLineBtn.disabled },
  { id: "claude-raw", group: "Terminals", name: "Claude Raw Line", what: "Send composer as raw terminal input", run: () => claudeRawLineBtn.click(), enabled: () => !claudeRawLineBtn.disabled },
  { id: "poke-codex", group: "Terminals", name: "Poke Codex", what: "Send composer to Codex terminal", run: () => pokeCodexBtn.click(), enabled: () => !pokeCodexBtn.disabled },
  { id: "poke-claude", group: "Terminals", name: "Poke Claude", what: "Send composer to Claude terminal", run: () => pokeClaudeBtn.click(), enabled: () => !pokeClaudeBtn.disabled },
  { id: "poke-both", group: "Terminals", name: "Poke Both", what: "Send composer to both terminals", run: () => pokeBothBtn.click(), enabled: () => !pokeBothBtn.disabled },
  { id: "open-actions", group: "Panels", name: "Open Native Actions Panel", what: "Inspect recent native actions", run: () => openPanel("actions") },
  { id: "open-queue", group: "Panels", name: "Open Work Queue", what: "Inspect queued follow-ups", run: () => openPanel("queue") },
  { id: "open-edits", group: "Panels", name: "Open Edits Panel", what: "Inspect current workspace edits", run: () => openPanel("edits") },
  { id: "open-verify", group: "Panels", name: "Open Verification Details", what: "Inspect verification status", run: () => openPanel("verify") },
  { id: "open-decisions-panel", group: "Panels", name: "Open Decisions Panel", what: "Inspect decision packets", run: () => openPanel("decisions") },
  { id: "open-usage-panel", group: "Panels", name: "Open Usage Panel", what: "Inspect session tokens, cache, reasoning, and estimated cost", run: () => openPanel("usage") },
  { id: "open-terminal-panel", group: "Panels", name: "Open Terminal Sessions Panel", what: "Inspect terminal sessions", run: () => openPanel("term") },
  { id: "toggle-ribbons", group: "Panels", name: "Toggle Status Ribbons", what: "Minimize or restore the status ribbons above the composer", run: () => toggleRibbonsBtn.click() },
  { id: "open-objective", group: "Files", name: "Open Objective", what: "Open the pinned room objective file", run: () => vscode.postMessage({ type: "openObjective" }), enabled: () => !lastState.canOpenFolder },
  { id: "open-native-actions-file", group: "Files", name: "Open Native Actions Log", what: "Open durable native action log", run: () => openNativeActionsFooterBtn.click(), enabled: () => !openNativeActionsFooterBtn.disabled },
  { id: "open-agent-calls", group: "Files", name: "Open Agent Call Log", what: "Open native dispatch traces and stderr previews", run: () => vscode.postMessage({ type: "openAgentCalls" }), enabled: () => !lastState.canOpenFolder },
  { id: "open-decisions", group: "Files", name: "Open Decisions", what: "Open decisions log", run: () => openDecisionsBtn.click(), enabled: () => !openDecisionsBtn.disabled },
  { id: "open-verification-file", group: "Files", name: "Open Verification Log", what: "Open the durable verification result log", run: () => openVerificationBtn.click(), enabled: () => !openVerificationBtn.disabled },
  { id: "open-transcript", group: "Files", name: "Open Transcript", what: "Open the Hydra transcript", run: () => openTranscriptBtn.click(), enabled: () => !openTranscriptBtn.disabled },
  { id: "session-brief", group: "Files", name: "Session Brief", what: "Open the current session brief", run: () => openSessionBriefBtn.click(), enabled: () => !openSessionBriefBtn.disabled },
  { id: "wiki-context", group: "Files", name: "Wiki Context", what: "Open the persistent compiled wiki context", run: () => vscode.postMessage({ type: "openWikiContext" }), enabled: () => !lastState.canOpenFolder },
  { id: "wiki-wrapup-now", group: "Files", name: "Run Wiki Wrapup Now", what: "Force a wiki wrapup from the latest completed room turn", run: () => vscode.postMessage({ type: "runWikiWrapupNow" }), enabled: () => !!lastState.canRunWikiWrapup },
  { id: "choose-model", group: "Settings", name: "Choose Model", what: "Pick Codex or Claude model overrides", run: () => vscode.postMessage({ type: "chooseModel" }), enabled: () => !lastState.canOpenFolder },
  { id: "choose-effort", group: "Settings", name: "Choose Thinking Level", what: "Pick Codex reasoning or Claude effort overrides", run: () => vscode.postMessage({ type: "chooseEffort" }), enabled: () => !lastState.canOpenFolder },
  { id: "test-telegram", group: "Settings", name: "Send Test Telegram", what: "Verify Telegram decision notifications", run: () => vscode.postMessage({ type: "testTelegram" }), enabled: () => !lastState.canOpenFolder },
  { id: "change-profile", group: "Settings", name: "Change Capability Profile", what: "Pick safe, native build, review, full-native, or custom CLI profiles", run: () => profileBtn.click(), enabled: () => !profileBtn.disabled },
  { id: "fix-codex", group: "Setup", name: "Fix Codex Path", what: "Update the configured Codex CLI command", run: () => fixCodexBtn.click(), enabled: () => !!lastState.needsCodexPath },
  { id: "fix-claude", group: "Setup", name: "Fix Claude Path", what: "Update the configured Claude CLI command", run: () => fixClaudeBtn.click(), enabled: () => !!lastState.needsClaudePath },
  { id: "support-bundle", group: "Diagnostics", name: "Support Bundle", what: "Generate logs and state bundle", run: () => openSupportBundleBtn.click(), enabled: () => !openSupportBundleBtn.disabled },
  { id: "doctor", group: "Diagnostics", name: "Run Doctor", what: "Check Hydra setup", run: () => doctorBtn.click(), enabled: () => !doctorBtn.disabled },
  { id: "retry-auto", group: "Diagnostics", name: "Retry Autopilot", what: "Re-run startup checks", run: () => retryAutopilotBtn.click(), enabled: () => !retryAutopilotBtn.disabled },
  { id: "safe-mode", group: "Diagnostics", name: "Use Safe Mode", what: "Switch to safe one-shot transport", run: () => safeModeBtn.click(), enabled: () => !safeModeBtn.disabled },
  { id: "verification", group: "Diagnostics", name: "Run Verification", what: "Run configured verification", run: () => runVerificationBtn.click(), enabled: () => !runVerificationBtn.disabled },
  { id: "native-snapshot", group: "Diagnostics", name: "Native Snapshot", what: "Capture native capabilities", run: () => captureNativeCapabilitiesBtn.click(), enabled: () => !captureNativeCapabilitiesBtn.disabled },
  { id: "native-data", group: "Diagnostics", name: "Native Data", what: "Capture native data snapshot", run: () => captureNativeDataSnapshotBtn.click(), enabled: () => !captureNativeDataSnapshotBtn.disabled },
  { id: "terminal-health", group: "Diagnostics", name: "Terminal Health", what: "Show terminal bridge health", run: () => terminalHealthBtn.click(), enabled: () => !terminalHealthBtn.disabled },
  { id: "authority", group: "Diagnostics", name: "Authority", what: "Show effective native authority", run: () => authorityBtn.click(), enabled: () => !authorityBtn.disabled },
  { id: "test-bridge", group: "Diagnostics", name: "Test Bridge", what: "Run terminal bridge self-test", run: () => testBridgeBtn.click(), enabled: () => !testBridgeBtn.disabled },
  { id: "open-folder", group: "Diagnostics", name: "Open Folder", what: "Open a workspace folder", run: () => openFolderBtn.click(), enabled: () => !openFolderBtn.disabled }
];

sendBtn.addEventListener("click", () => {
  const text = composer.value.trim();
  const hasAttachments = Array.isArray(lastState.pendingAttachments) && lastState.pendingAttachments.length > 0;
  if (!text && !hasAttachments) return composer.focus();
  addOptimisticUserMessage(optimisticComposerText(text, lastState.pendingAttachments || []));
  vscode.postMessage({ type: "send", text, opener: selectedOpener });
  composer.value = "";
  hasOpenerOverride = false;
});
openerBtn.addEventListener("click", () => {
  selectedOpener = selectedOpener === "codex" ? "claude" : "codex";
  hasOpenerOverride = selectedOpener !== defaultOpener;
  renderOpenerButton();
});
commandCenterBtn.addEventListener("click", () => {
  if (cmdOverlay.dataset.open === "true") closePalette();
  else openPalette();
});
toggleRibbonsBtn.addEventListener("click", () => setRibbonsMinimized(!ribbonsMinimized));
ribbonStack.addEventListener("click", (event) => {
  const button = event.target && event.target.closest ? event.target.closest("[data-ribbon-toggle]") : undefined;
  if (!button) return;
  toggleRibbonCollapsed(button.dataset.ribbonToggle || "");
});
setRibbonsMinimized(ribbonsMinimized);
setObjectiveBtn.addEventListener("click", () => {
  const text = composer.value.trim();
  if (!text) return composer.focus();
  vscode.postMessage({ type: "setObjective", text });
});
resetObjectiveBtn.addEventListener("click", () => vscode.postMessage({ type: "resetObjective" }));
previewPromptBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "previewNextPrompt", text: composer.value, opener: selectedOpener });
});
openLastPromptBtn.addEventListener("click", () => vscode.postMessage({ type: "openLastPrompt" }));
attachFilesBtn.addEventListener("click", () => vscode.postMessage({ type: "attachFiles" }));
clearAttachmentsBtn.addEventListener("click", () => vscode.postMessage({ type: "clearAttachments" }));
nativeActionBtn.addEventListener("click", () => vscode.postMessage({ type: "nativeAction", text: composer.value }));
composer.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !sendBtn.disabled) {
    e.preventDefault();
    sendBtn.click();
  }
  if (e.key === "/" && composer.selectionStart === 0 && composer.selectionEnd === 0 && !composer.value) {
    e.preventDefault();
    openPalette();
  }
});
stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
assignCodexBtn.addEventListener("click", () => vscode.postMessage({ type: "assignBuilder", builder: "codex" }));
assignClaudeBtn.addEventListener("click", () => vscode.postMessage({ type: "assignBuilder", builder: "claude" }));
assignBothBtn.addEventListener("click", () => vscode.postMessage({ type: "assignParallelBuilders" }));
reviewBtn.addEventListener("click", () => vscode.postMessage({ type: "requestReview" }));
acceptDefaultBtn.addEventListener("click", () => vscode.postMessage({ type: "acceptDefaultDecision" }));
autoAdvanceDefaultsBtn.addEventListener("click", () => vscode.postMessage({ type: "toggleAutoAdvanceActionableDefaults" }));
handBackBtn.addEventListener("click", () => vscode.postMessage({ type: "handBack" }));
nativeTerminalsBtn.addEventListener("click", () => vscode.postMessage({ type: transport === "terminalBridge" ? "useOneShotTransport" : "useTerminalBridge" }));
openNativeTerminalsBtn.addEventListener("click", () => vscode.postMessage({ type: "openNativeTerminals" }));
codexCommandBtn.addEventListener("click", () => runNativeCommand("codex"));
claudeCommandBtn.addEventListener("click", () => runNativeCommand("claude"));
codexRawLineBtn.addEventListener("click", () => sendRawTerminalLine("codex"));
claudeRawLineBtn.addEventListener("click", () => sendRawTerminalLine("claude"));
pokeCodexBtn.addEventListener("click", () => pokeNativeTerminal("codex"));
pokeClaudeBtn.addEventListener("click", () => pokeNativeTerminal("claude"));
pokeCodexEditorBtn.addEventListener("click", () => pokeNativeTerminal("codex", true));
pokeClaudeEditorBtn.addEventListener("click", () => pokeNativeTerminal("claude", true));
pokeCodexDiffBtn.addEventListener("click", () => pokeNativeTerminal("codex", false, true));
pokeClaudeDiffBtn.addEventListener("click", () => pokeNativeTerminal("claude", false, true));
pokeBothBtn.addEventListener("click", () => pokeBothNativeTerminals());
pokeBothEditorBtn.addEventListener("click", () => pokeBothNativeTerminals(true));
pokeBothDiffBtn.addEventListener("click", () => pokeBothNativeTerminals(false, true));
testBridgeBtn.addEventListener("click", () => vscode.postMessage({ type: "runTerminalBridgeSelfTest" }));
terminalHealthBtn.addEventListener("click", () => vscode.postMessage({ type: "showTerminalBridgeHealth" }));
authorityBtn.addEventListener("click", () => vscode.postMessage({ type: "showEffectiveAuthority" }));
profileBtn.addEventListener("click", () => vscode.postMessage({ type: "changeCapabilityProfile" }));
doctorBtn.addEventListener("click", () => vscode.postMessage({ type: "runDoctor" }));
resetTurnBtn.addEventListener("click", () => vscode.postMessage({ type: "resetStuckTurn" }));
archiveChatBtn.addEventListener("click", () => vscode.postMessage({ type: "archiveAndClearRoom" }));
fixCodexBtn.addEventListener("click", () => vscode.postMessage({ type: "fixCodexPath" }));
fixClaudeBtn.addEventListener("click", () => vscode.postMessage({ type: "fixClaudePath" }));
retryAutopilotBtn.addEventListener("click", () => vscode.postMessage({ type: "runAutopilotStart" }));
safeModeBtn.addEventListener("click", () => vscode.postMessage({ type: "useOneShotTransport" }));
runVerificationBtn.addEventListener("click", () => vscode.postMessage({ type: "runVerification" }));
openVerificationBtn.addEventListener("click", () => vscode.postMessage({ type: "openVerification" }));
openNativeActionsBtn.addEventListener("click", () => openPanel("actions"));
openWorkQueuePanelBtn.addEventListener("click", () => openPanel("queue"));
openFolderBtn.addEventListener("click", () => vscode.postMessage({ type: "openWorkspaceFolder" }));
openSessionBriefBtn.addEventListener("click", () => vscode.postMessage({ type: "openSessionBrief" }));
openSupportBundleBtn.addEventListener("click", () => vscode.postMessage({ type: "openSupportBundle" }));
captureNativeCapabilitiesBtn.addEventListener("click", () => vscode.postMessage({ type: "captureNativeCapabilities" }));
captureNativeDataSnapshotBtn.addEventListener("click", () => vscode.postMessage({ type: "captureNativeDataSnapshot" }));
openTranscriptBtn.addEventListener("click", () => vscode.postMessage({ type: "openTranscript" }));
archiveClearBtn.addEventListener("click", () => vscode.postMessage({ type: "archiveAndClearRoom" }));
openDecisionsBtn.addEventListener("click", () => vscode.postMessage({ type: "openDecisions" }));
openNativeActionsFooterBtn.addEventListener("click", () => vscode.postMessage({ type: "openNativeActions" }));
nativeAgentFilter.addEventListener("change", () => renderNativeActions(lastState));
nativeStatusFilter.addEventListener("change", () => renderNativeActions(lastState));
clearNativeActionsBtn.addEventListener("click", () => {
  const ids = (lastFilteredNativeActions || []).map((action) => action.id).filter(Boolean);
  if (ids.length > 0) vscode.postMessage({ type: "clearNativeActions", ids });
});

workQueueBoard.addEventListener("click", (event) => {
  const target = event.target;
  const button = target && target.closest ? target.closest("button[data-work-action]") : undefined;
  if (!button) return;
  const action = button.dataset.workAction;
  if (action === "acceptDefaultDecision") vscode.postMessage({ type: "acceptDefaultDecision" });
  if (action === "discussVerification") vscode.postMessage({ type: "discussVerification" });
  if (action === "rerunNativeAction") vscode.postMessage({ type: "rerunNativeAction", id: button.dataset.actionId || "" });
  if (action === "dismiss") vscode.postMessage({ type: "dismissWorkQueueItem", id: button.dataset.itemId || "" });
  if (action === "snooze") vscode.postMessage({ type: "snoozeWorkQueueItem", id: button.dataset.itemId || "" });
});
nativeActionBoard.addEventListener("click", (event) => {
  const target = event.target;
  const button = target && target.closest ? target.closest("button[data-action-id]") : undefined;
  if (!button) return;
  const id = button.dataset.actionId;
  const action = (lastNativeActions || []).find((item) => item.id === id);
  if (!action) return;
  if (button.dataset.action === "rerun") vscode.postMessage({ type: "rerunNativeAction", id });
  if (button.dataset.action === "fork") {
    composer.value = action.instruction || "";
    composer.focus();
  }
  if (button.dataset.action === "objective") vscode.postMessage({ type: "setObjective", text: action.instruction || "" });
  if (button.dataset.action === "discuss") vscode.postMessage({ type: "send", text: action.instruction || "", opener: selectedOpener });
  if (button.dataset.action === "clear") vscode.postMessage({ type: "clearNativeAction", id });
});
if (editBoard) {
  editBoard.addEventListener("click", (event) => {
    const target = event.target;
    const button = target && target.closest ? target.closest("button[data-edit-path]") : undefined;
    if (!button) return;
    vscode.postMessage({ type: "openWorkspaceChange", path: button.dataset.editPath || "" });
  });
}
if (messagesEl) {
  lastObservedMessageScrollTop = messagesEl.scrollTop;
  messagesEl.addEventListener("scroll", () => {
    const nextScrollTop = messagesEl.scrollTop;
    if (programmaticMessageScroll) {
      lastObservedMessageScrollTop = nextScrollTop;
      return;
    }
    if (nextScrollTop < lastObservedMessageScrollTop - MESSAGE_SCROLL_EPSILON_PX) {
      messageAutoStick = false;
    } else if (isNearMessageBottom()) {
      messageAutoStick = true;
    }
    lastObservedMessageScrollTop = nextScrollTop;
  }, { passive: true });

  messagesEl.addEventListener("click", (event) => {
    const target = event.target;
    const button = target && target.closest ? target.closest("button[data-run-failure-action]") : undefined;
    if (!button) return;
    const action = button.dataset.runFailureAction || "";
    if (action === "open-file") vscode.postMessage({ type: "openRunFailureFile", path: button.dataset.runFailurePath || "" });
    if (action === "copy-sha") vscode.postMessage({ type: "copyRunFailurePromptSha", sha: button.dataset.runFailureSha || "" });
    if (action === "open-agent-calls") vscode.postMessage({ type: "openAgentCalls" });
  });
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.type === "state") renderState(msg);
  else if (msg.type === "chunk") appendChunk(msg.messageId, msg.text);
  else if (msg.type === "replaceMessageText") replaceMessageText(msg.messageId, msg.text);
  else if (msg.type === "setComposerText") {
    if (composer) {
      composer.value = msg.text || "";
      composer.focus();
      if (typeof composer.setSelectionRange === "function") {
        composer.setSelectionRange(composer.value.length, composer.value.length);
      }
    }
  }
});

function appendChunk(messageId, text) {
  const el = document.querySelector('[data-mid="' + messageId + '"] .text');
  if (!el) return;
  const scroll = captureMessageScroll();
  el.textContent += text;
  restoreMessageScroll(scroll);
}

function replaceMessageText(messageId, text) {
  const el = document.querySelector('[data-mid="' + messageId + '"] .text');
  if (!el) return;
  const scroll = captureMessageScroll();
  el.textContent = text;
  restoreMessageScroll(scroll);
}

function renderState(state) {
  lastState = state;
  const hostMessages = state.messages || [];
  pendingLocalUserMessages = pendingLocalUserMessages.filter((pending) => !hostMessages.some((m) => sameUserMessage(m, pending)));
  lastMessages = hostMessages.concat(pendingLocalUserMessages);
  renderMessages();
  transport = state.transport || "oneShot";
  defaultOpener = state.defaultOpener || "codex";
  if (!hasOpenerOverride) selectedOpener = defaultOpener;
  renderTransport();
  phaseChip.textContent = state.phaseLabel || state.phase || "Idle";
  phaseChip.className = "phase-chip" + (!state.canStop && state.canSend ? " idle" : "");
  app.classList.toggle("in-flight", !!state.canStop);
  objectiveText.textContent = state.objective || "Not set";
  objectiveText.title = state.objective || "";
  objectiveTextShim.textContent = state.objective || "Not set";
  resetObjectiveBtn.disabled = !!state.canOpenFolder || !(state.objective || "").trim();
  renderAgentStatuses(state.agentStatuses || {});
  renderAuthorityBadges(state.authoritySummaries || {});
  renderTerminalSessions(state.terminalSessions || [], transport);
  renderAutopilot(state);
  renderVerification(state);
  renderEdits(state);
  renderNativeActions(state);
  renderWorkQueue(state);
  renderDecision(state.latestDecision, state.decisionsCount || 0, state.latestDecisionRisky, !!state.latestDecisionAccepted);
  renderAutoAdvanceDefaults(!!state.autoAdvanceActionableDefaults);
  renderDecisionAction(state.decisionAction, !!state.canAcceptDefault, !!state.latestDecisionAccepted, !!state.canStop);
  renderSessionUsage(state.sessionUsage, state.weeklyUsage);
  renderModels(state.models, state.efforts);
  renderProfiles(state.capabilityProfiles);
  renderDecisionBoard(state.recentDecisions || []);
  renderAttachmentTray(state.pendingAttachments || []);
  const hasAttachments = Array.isArray(state.pendingAttachments) && state.pendingAttachments.length > 0;
  sendBtn.disabled = !state.canSend;
  sendBtn.textContent = state.canStop ? "QUEUE" : "SEND";
  sendBtn.title = state.canStop
    ? "Queue this follow-up and send it after the active turn finishes"
    : "Send message";
  openerBtn.disabled = !state.canSend;
  attachFilesBtn.disabled = !state.canAttachFiles;
  clearAttachmentsBtn.disabled = !hasAttachments;
  previewPromptBtn.disabled = !!state.canOpenFolder;
  openLastPromptBtn.disabled = !!state.canOpenFolder;
  setObjectiveBtn.disabled = !state.canSend;
  nativeActionBtn.classList.toggle("hidden", !!state.canOpenFolder);
  nativeActionBtn.disabled = !state.canPokeNativeTerminals;
  composer.disabled = !state.canSend;
  stopBtn.classList.toggle("hidden", !state.canStop);
  resetTurnBtn.classList.toggle("hidden", !state.canStop);
  assignCodexBtn.classList.toggle("hidden", !state.canAssignBuilder);
  assignClaudeBtn.classList.toggle("hidden", !state.canAssignBuilder);
  assignBothBtn.classList.toggle("hidden", !state.canAssignBuilder);
  reviewBtn.classList.toggle("hidden", !state.canRequestReview);
  handBackBtn.classList.toggle("hidden", !state.canHandBack);
  archiveChatBtn.disabled = !state.canArchiveRoom;
  nativeTerminalsBtn.classList.toggle("hidden", !!state.canOpenFolder);
  openNativeTerminalsBtn.classList.toggle("hidden", !!state.canOpenFolder);
  codexCommandBtn.classList.toggle("hidden", !!state.canOpenFolder);
  claudeCommandBtn.classList.toggle("hidden", !!state.canOpenFolder);
  codexRawLineBtn.classList.toggle("hidden", transport !== "terminalBridge" || !!state.canOpenFolder);
  claudeRawLineBtn.classList.toggle("hidden", transport !== "terminalBridge" || !!state.canOpenFolder);
  pokeCodexBtn.classList.toggle("hidden", !!state.canOpenFolder);
  pokeClaudeBtn.classList.toggle("hidden", !!state.canOpenFolder);
  pokeCodexEditorBtn.classList.toggle("hidden", !!state.canOpenFolder);
  pokeClaudeEditorBtn.classList.toggle("hidden", !!state.canOpenFolder);
  pokeCodexDiffBtn.classList.toggle("hidden", !!state.canOpenFolder);
  pokeClaudeDiffBtn.classList.toggle("hidden", !!state.canOpenFolder);
  pokeBothBtn.classList.toggle("hidden", !!state.canOpenFolder);
  pokeBothEditorBtn.classList.toggle("hidden", !!state.canOpenFolder);
  pokeBothDiffBtn.classList.toggle("hidden", !!state.canOpenFolder);
  openNativeTerminalsBtn.disabled = !state.canPokeNativeTerminals;
  codexRawLineBtn.disabled = !state.canPokeNativeTerminals;
  claudeRawLineBtn.disabled = !state.canPokeNativeTerminals;
  codexCommandBtn.disabled = !state.canPokeNativeTerminals;
  claudeCommandBtn.disabled = !state.canPokeNativeTerminals;
  pokeCodexBtn.disabled = !state.canPokeNativeTerminals;
  pokeClaudeBtn.disabled = !state.canPokeNativeTerminals;
  pokeCodexEditorBtn.disabled = !state.canPokeNativeTerminals;
  pokeClaudeEditorBtn.disabled = !state.canPokeNativeTerminals;
  pokeCodexDiffBtn.disabled = !state.canPokeNativeTerminals;
  pokeClaudeDiffBtn.disabled = !state.canPokeNativeTerminals;
  pokeBothBtn.disabled = !state.canPokeNativeTerminals;
  pokeBothEditorBtn.disabled = !state.canPokeNativeTerminals;
  pokeBothDiffBtn.disabled = !state.canPokeNativeTerminals;
  testBridgeBtn.classList.toggle("hidden", !!state.canOpenFolder);
  terminalHealthBtn.classList.toggle("hidden", !!state.canOpenFolder);
  authorityBtn.classList.toggle("hidden", !!state.canOpenFolder);
  profileBtn.classList.toggle("hidden", !!state.canOpenFolder);
  doctorBtn.disabled = !!state.canOpenFolder || !!state.canStop;
  retryAutopilotBtn.disabled = !!state.canOpenFolder || !!state.canStop || !!state.autopilotRunning;
  safeModeBtn.disabled = !!state.canOpenFolder || transport === "oneShot";
  runVerificationBtn.disabled = !state.canRunVerification;
  openVerificationBtn.disabled = !!state.canOpenFolder;
  openNativeActionsBtn.disabled = !!state.canOpenFolder;
  captureNativeCapabilitiesBtn.disabled = !!state.canOpenFolder || !!state.canStop;
  captureNativeDataSnapshotBtn.disabled = !!state.canOpenFolder || !!state.canStop;
  openTranscriptBtn.disabled = !!state.canOpenFolder;
  archiveClearBtn.disabled = !state.canArchiveRoom;
  openDecisionsBtn.disabled = !!state.canOpenFolder;
  openNativeActionsFooterBtn.disabled = !!state.canOpenFolder;
  assignCodexBtn.classList.toggle("suggested", state.suggestedBuilder === "codex");
  assignClaudeBtn.classList.toggle("suggested", state.suggestedBuilder === "claude");
  renderOpenerButton();
  renderPalette(paletteInput.value || "");
  applyCollapsedRibbons();
  updateRibbonMinimizedSummary(state);
}

function addOptimisticUserMessage(text) {
  const msg = {
    id: "local-u-" + Date.now() + "-" + Math.random().toString(36).slice(2),
    role: "user",
    text,
    timestamp: new Date().toISOString(),
    pending: true,
    activity: "sending"
  };
  pendingLocalUserMessages.push(msg);
  lastMessages = lastMessages.concat([msg]);
  messageAutoStick = true;
  renderMessages();
}

function optimisticComposerText(text, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return text;
  const names = attachments.map((attachment) => attachment && attachment.name ? attachment.name : "attachment").join(", ");
  const summary = `[Attached ${attachments.length} file${attachments.length === 1 ? "" : "s"}: ${names}]`;
  return text ? `${text}\n\n${summary}` : summary;
}

function sameUserMessage(a, b) {
  if (!a || !b || a.role !== "user" || b.role !== "user" || a.text !== b.text) return false;
  const aTime = Date.parse(a.timestamp || "");
  const bTime = Date.parse(b.timestamp || "");
  if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) return true;
  return Math.abs(aTime - bTime) < 5 * 60 * 1000;
}

function renderAttachmentTray(attachments) {
  if (!attachmentTray) return;
  attachmentTray.innerHTML = "";
  attachmentTray.classList.toggle("has-attachments", attachments.length > 0);
  for (const attachment of attachments) {
    const chip = document.createElement("span");
    chip.className = "attachment-chip";
    chip.title = (attachment.relativePath || attachment.name || "attachment") + " - " + formatBytes(attachment.sizeBytes || 0);
    const label = document.createElement("span");
    label.textContent = attachment.name || "attachment";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = "x";
    remove.title = "Remove attachment";
    remove.addEventListener("click", () => vscode.postMessage({ type: "clearAttachment", id: attachment.id || "" }));
    chip.append(label, remove);
    attachmentTray.append(chip);
  }
}

function setRibbonsMinimized(value) {
  ribbonsMinimized = !!value;
  ribbonStack.classList.toggle("is-minimized", ribbonsMinimized);
  toggleRibbonsBtn.textContent = ribbonsMinimized ? "Restore Panel" : "Minimize Panel";
  toggleRibbonsBtn.title = ribbonsMinimized ? "Restore pinned status panel" : "Minimize pinned status panel";
  toggleRibbonsBtn.setAttribute("aria-expanded", String(!ribbonsMinimized));
  persistWebviewState();
  updateRibbonMinimizedSummary(lastState || {});
}

function toggleRibbonCollapsed(id) {
  if (!id) return;
  if (collapsedRibbons.has(id)) collapsedRibbons.delete(id);
  else collapsedRibbons.add(id);
  persistWebviewState();
  applyCollapsedRibbons();
  updateRibbonMinimizedSummary(lastState || {});
}

function applyCollapsedRibbons() {
  document.querySelectorAll("[data-ribbon-toggle]").forEach((button) => {
    const id = button.dataset.ribbonToggle || "";
    const el = document.getElementById(id);
    const collapsed = collapsedRibbons.has(id);
    if (el) el.classList.toggle("is-collapsed", collapsed);
    button.textContent = collapsed ? "Restore" : "Minimize";
    button.title = collapsed ? "Restore this pinned strip" : "Minimize this pinned strip";
    button.setAttribute("aria-expanded", String(!collapsed));
  });
}

function persistWebviewState(extra) {
  if (!vscode.setState) return;
  const base = Object.assign({}, vscode.getState ? (vscode.getState() || {}) : {});
  vscode.setState(Object.assign(base, {
    ribbonsMinimized,
    collapsedRibbons: Array.from(collapsedRibbons)
  }, extra || {}));
}

function updateRibbonMinimizedSummary(state) {
  const ribbonIds = ["setupStrip", "verificationStrip", "nativeActionStrip", "workQueueStrip", "decisionStrip"];
  const hasVisibleRibbon = ribbonIds.some((id) => {
    const el = document.getElementById(id);
    return el && !el.classList.contains("hidden");
  });
  ribbonStack.classList.toggle("has-visible-ribbons", hasVisibleRibbon);
  const parts = [];
  if (state.autopilotRunning || state.autopilotSummary) parts.push("Autopilot: " + (state.autopilotRunning ? "running" : state.autopilotSummary));
  if (state.verificationRunning || state.verificationSummary) parts.push("Verify: " + (state.verificationRunning ? "running" : state.verificationSummary));
  if (state.workspaceChangesCount) parts.push("Edits: " + state.workspaceChangesCount);
  if (state.latestDecision) parts.push("Decision" + (state.decisionsCount ? " " + state.decisionsCount : "") + ": " + (state.latestDecision.defaultNextAction || "ready"));
  if (state.nativeActionsCount) parts.push("Actions: " + state.nativeActionsCount);
  if (state.workQueue && state.workQueue.length) parts.push("Queue: " + state.workQueue.length);
  ribbonMinimizedSummary.textContent = parts.length > 0 ? parts.join(" | ") : "Status ribbons hidden";
  ribbonMinimizedSummary.title = ribbonMinimizedSummary.textContent;
}

function renderMessages() {
  const scroll = captureMessageScroll();
  if (lastMessages.length === 0) {
    messagesEl.innerHTML = '<p class="empty">The room is quiet. Run Doctor if this is a fresh setup, then type one message below to bring everyone in.</p>';
    restoreMessageScroll(scroll);
    return;
  }
  messagesEl.innerHTML = "";
  let lastPhase = "";
  for (const m of lastMessages) {
    if (m.phase && m.phase !== lastPhase) {
      const mark = document.createElement("div");
      mark.className = "phase-mark";
      mark.innerHTML = "<span>" + escapeHtml(m.phase) + "</span>";
      messagesEl.append(mark);
      lastPhase = m.phase;
    }
    const article = document.createElement("article");
    const cls = ["message", m.role || "system"];
    if (m.pending) cls.push("pending");
    if (m.error) cls.push("error");
    if (m.cancelled) cls.push("cancelled");
    article.className = cls.join(" ");
    article.dataset.mid = m.id;

    const time = document.createElement("time");
    time.className = "message-time";
    time.textContent = new Date(m.timestamp).toLocaleTimeString();

    const card = document.createElement("div");
    card.className = "message-card";
    const head = document.createElement("div");
    head.className = "message-head";
    const art = document.createElement("span");
    art.className = "head-art " + (m.role || "system");
    const headSrc = headAsset(m.role);
    if (headSrc) {
      const img = document.createElement("img");
      img.src = headSrc;
      img.alt = "";
      art.append(img);
    } else {
      art.textContent = headGlyph(m.role);
    }
    const speaker = document.createElement("span");
    speaker.className = "speaker " + (m.role || "system");
    speaker.textContent = labels[m.role] || m.role || "system";
    const role = document.createElement("span");
    role.className = "role-tag";
    role.textContent = m.phase || "";
    const status = document.createElement("span");
    status.className = "message-status";
    status.textContent = m.pending ? (m.activity || "running") : "";
    head.append(art, speaker, role, status);

    const text = document.createElement("pre");
    text.className = "text";
    if (m.pending && !m.activity) text.dataset.placeholder = pendingPlaceholder(m);
    text.textContent = m.text || "";
    if (!m.pending || m.text || !m.activity) card.append(head, text);
    else card.append(head);
    if (m.runFailure) card.append(renderRunFailureCard(m.runFailure));
    article.append(time, card);
    messagesEl.append(article);
  }
  restoreMessageScroll(scroll);
}

function captureMessageScroll() {
  if (!messagesEl) return { stickToBottom: false, scrollTop: 0, anchor: undefined };
  const stickToBottom = messageAutoStick && isNearMessageBottom();
  return {
    stickToBottom,
    scrollTop: messagesEl.scrollTop,
    anchor: stickToBottom ? undefined : captureMessageAnchor()
  };
}

function isNearMessageBottom() {
  if (!messagesEl) return false;
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= MESSAGE_BOTTOM_STICKY_PX;
}

function captureMessageAnchor() {
  if (!messagesEl) return undefined;
  const containerRect = messagesEl.getBoundingClientRect();
  const messages = messagesEl.querySelectorAll(".message[data-mid]");
  for (const message of messages) {
    const rect = message.getBoundingClientRect();
    if (rect.bottom > containerRect.top + 1 && rect.top < containerRect.bottom - 1) {
      return {
        mid: message.dataset.mid || "",
        top: rect.top - containerRect.top
      };
    }
  }
  return undefined;
}

function restoreMessageScroll(scroll) {
  if (!messagesEl || !scroll) return;
  if (scroll.stickToBottom) {
    messageAutoStick = true;
    setMessageScrollTop(messagesEl.scrollHeight);
    return;
  }
  let nextScrollTop = scroll.scrollTop;
  if (scroll.anchor && scroll.anchor.mid) {
    const anchor = messagesEl.querySelector('[data-mid="' + cssEscape(scroll.anchor.mid) + '"]');
    if (anchor) {
      const containerRect = messagesEl.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      nextScrollTop += (anchorRect.top - containerRect.top) - scroll.anchor.top;
    }
  }
  const maxScrollTop = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
  setMessageScrollTop(Math.min(Math.max(0, nextScrollTop), maxScrollTop));
}

function setMessageScrollTop(value) {
  if (!messagesEl) return;
  programmaticMessageScroll = true;
  messagesEl.scrollTop = value;
  lastObservedMessageScrollTop = messagesEl.scrollTop;
  requestAnimationFrame(() => {
    programmaticMessageScroll = false;
    if (messagesEl) lastObservedMessageScrollTop = messagesEl.scrollTop;
  });
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function renderRunFailureCard(card) {
  const section = document.createElement("section");
  section.className = "run-failure";
  const header = document.createElement("div");
  header.className = "run-failure-head";
  const title = document.createElement("strong");
  title.textContent = "Run failed";
  const status = document.createElement("span");
  status.textContent = card.status || "Failed";
  header.append(title, status);

  const meta = document.createElement("div");
  meta.className = "run-failure-meta";
  meta.append(
    runFailureMeta("Duration", formatDuration(card.durationMs)),
    runFailureMeta("Transport", card.transport === "terminalBridge" ? "Terminal bridge" : "One-shot"),
    runFailureMeta("Prompt", shortSha(card.promptSha256))
  );

  const stderr = document.createElement("pre");
  stderr.className = "run-failure-stderr";
  stderr.textContent = card.stderrPreview || "No stderr captured";
  if (!card.stderrPreview) stderr.classList.add("muted");

  const actions = document.createElement("div");
  actions.className = "run-failure-actions";
  const files = Array.isArray(card.requestFiles) ? card.requestFiles : [];
  for (const file of files) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.dataset.runFailureAction = "open-file";
    button.dataset.runFailurePath = file.path || "";
    button.title = file.label || file.path || "";
    button.textContent = labelRequestFile(file.kind);
    actions.append(button);
  }
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "secondary";
  copy.dataset.runFailureAction = "copy-sha";
  copy.dataset.runFailureSha = card.promptSha256 || "";
  copy.textContent = "Copy SHA";
  actions.append(copy);
  const log = document.createElement("button");
  log.type = "button";
  log.className = "secondary";
  log.dataset.runFailureAction = "open-agent-calls";
  log.textContent = "Agent log";
  actions.append(log);

  section.append(header, meta, stderr, actions);
  return section;
}

function runFailureMeta(label, value) {
  const item = document.createElement("span");
  const key = document.createElement("b");
  key.textContent = label + ": ";
  const val = document.createElement("span");
  val.textContent = value || "none";
  item.append(key, val);
  return item;
}

function labelRequestFile(kind) {
  if (kind === "prompt") return "Prompt";
  if (kind === "reply") return "Reply";
  if (kind === "log") return "Log";
  return "File";
}

function shortSha(value) {
  const sha = String(value || "");
  return sha.length > 12 ? sha.slice(0, 12) : sha || "none";
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  const kib = n / 1024;
  if (kib < 1024) return kib.toFixed(1) + " KiB";
  return (kib / 1024).toFixed(1) + " MiB";
}

function formatDuration(ms) {
  const n = Number(ms) || 0;
  const totalSeconds = Math.max(0, Math.round(n / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return seconds + "s";
  return minutes + "m " + String(seconds).padStart(2, "0") + "s";
}

function renderOpenerButton() {
  const label = selectedOpener === "codex" ? "Codex" : "Claude";
  openerBtn.textContent = hasOpenerOverride ? "Opener: " + label + " (this turn)" : "Opener: " + label;
  openerBtn.setAttribute("aria-label", "Flip opener, currently " + label);
  openerBtn.classList.toggle("suggested", hasOpenerOverride);
}

function pokeNativeTerminal(agent, includeEditorContext, includeWorkspaceDiff) {
  const text = composer.value.trim();
  if (!text && !includeEditorContext && !includeWorkspaceDiff) return composer.focus();
  vscode.postMessage({ type: "pokeNativeTerminal", agent, text, includeEditorContext: !!includeEditorContext, includeWorkspaceDiff: !!includeWorkspaceDiff });
  composer.value = "";
}
function runNativeCommand(agent) {
  const text = composer.value.trim();
  if (!text) return composer.focus();
  vscode.postMessage({ type: "runNativeCommand", agent, text });
  composer.value = "";
}
function sendRawTerminalLine(agent) {
  const text = composer.value.trim();
  if (!text) return composer.focus();
  vscode.postMessage({ type: "sendRawTerminalLine", agent, text });
  composer.value = "";
}
function pokeBothNativeTerminals(includeEditorContext, includeWorkspaceDiff) {
  const text = composer.value.trim();
  if (!text && !includeEditorContext && !includeWorkspaceDiff) return composer.focus();
  vscode.postMessage({ type: "pokeNativeTerminals", text, includeEditorContext: !!includeEditorContext, includeWorkspaceDiff: !!includeWorkspaceDiff });
  composer.value = "";
}

function renderTransport() {
  const terminal = transport === "terminalBridge";
  transportChip.textContent = terminal ? "Terminal bridge" : "Safe one-shot";
  transportChip.className = "rail-chip" + (terminal ? " warn" : " ok");
  nativeTerminalsBtn.textContent = terminal ? "Use Safe One-Shot" : "Use Terminal Bridge";
  nativeTerminalsBtn.title = terminal ? "Switch back to the stable one-shot transport" : "Inject future calls into visible native terminals";
}
function renderAgentStatuses(statuses) {
  renderAgentStatus(codexStatus, "Codex", statuses.codex, "codex");
  renderAgentStatus(claudeStatus, "Claude", statuses.claude, "claude");
}
function renderAgentStatus(el, label, status, agent) {
  const state = status && status.state ? status.state : "idle";
  const detail = status && status.detail ? status.detail : "Idle";
  el.className = "agent-status " + agent + " " + state;
  el.title = label + ": " + detail;
  el.textContent = label + ": " + compactStatusDetail(detail);
}
function renderAuthorityBadges(summaries) {
  renderAuthorityBadge(codexAuthority, "Codex", summaries.codex);
  renderAuthorityBadge(claudeAuthority, "Claude", summaries.claude);
}
function renderAuthorityBadge(el, label, summary) {
  const authority = summary && summary.authority ? summary.authority : { level: "unknown", label: "Unknown/custom", detail: "No authority data yet" };
  const profile = summary && summary.profile ? summary.profile : { label: "Custom" };
  el.className = "authority-badge " + (authority.level || "unknown");
  el.title = label + ": " + (authority.label || "Unknown/custom") + " / " + (profile.label || "Custom") + "\\n" + (authority.detail || "") + "\\nProfile: " + (profile.detail || profile.label || "Custom");
  el.innerHTML = '<span class="rail-value"><strong>' + escapeHtml(label) + '</strong> ' + escapeHtml(compactAuthority(authority, profile)) + "</span>";
}
function compactStatusDetail(detail) {
  return String(detail || "Idle")
    .replace("running", "")
    .replace("replied", "done")
    .replace("cancelled", "stopped")
    .trim() || "idle";
}
function compactAuthority(authority, profile) {
  const level = authority && authority.level ? authority.level : "unknown";
  const profileLabel = profile && profile.label ? profile.label : "Custom";
  if (level === "workspaceWrite") return profileLabel.startsWith("Elevated") ? "write / elevated" : "write";
  if (level === "readOnly") return "read";
  if (level === "fullNative") return "full native";
  return "custom";
}
function renderTerminalSessions(sessions, currentTransport) {
  const visible = currentTransport === "terminalBridge" || sessions.some((s) => s.state && s.state !== "idle");
  terminalSessions.classList.toggle("hidden", !visible);
  document.getElementById("terminalPanelCount").textContent = sessions.length + " sessions";
  if (!visible) {
    terminalSessions.innerHTML = '<p class="empty">No active terminal sessions.</p>';
    return;
  }
  const byAgent = new Map(sessions.map((s) => [s.agent, s]));
  terminalSessions.innerHTML = "";
  for (const agent of ["codex", "claude"]) {
    const s = byAgent.get(agent) || { agent, terminalName: agent, state: "idle", detail: "Not opened" };
    const row = document.createElement("section");
    row.className = "terminal-session " + (s.state || "idle");
    row.append(sessionLine("Name", s.terminalName || (agent === "codex" ? "Hydra Codex" : "Hydra Claude")));
    row.append(sessionLine("State", s.state || "idle"));
    row.append(sessionLine("Detail", s.detail || "Idle"));
    row.append(sessionLine("Command", s.currentCommand || "No active command"));
    row.append(sessionLine("Last activity", s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleTimeString() : "none"));
    row.append(sessionLine("Log", s.lastLogPath || "none"));
    if (s.lastError) row.append(sessionLine("Error", s.lastError));
    terminalSessions.append(row);
  }
}
function sessionLine(label, value) {
  const line = document.createElement("div");
  line.className = "session-line";
  line.title = value || "";
  const strong = document.createElement("strong");
  strong.textContent = label + ": ";
  const span = document.createElement("span");
  span.textContent = value || "";
  line.append(strong, span);
  return line;
}
function renderAutopilot(state) {
  setupStrip.classList.toggle("hidden", !!state.canOpenFolder && !state.autopilotSummary);
  const summary = state.autopilotSummary || "Not run";
  autopilotText.textContent = state.autopilotRunning ? summary + "..." : summary;
  fixCodexBtn.classList.toggle("hidden", !state.needsCodexPath);
  fixClaudeBtn.classList.toggle("hidden", !state.needsClaudePath);
  setupStrip.classList.toggle("hidden", !state.needsCodexPath && !state.needsClaudePath && !state.autopilotRunning && !state.autopilotSummary);
}
function renderVerification(state) {
  const text = state.verificationRunning ? "running..." : (state.verificationSummary || "No verification yet");
  verificationText.textContent = text;
  verificationRail.textContent = "verify: " + (state.verificationSummary || (state.verificationRunning ? "running" : "none"));
  verificationRail.className = "rail-chip optional" + (text.toLowerCase().includes("fail") ? " error" : text.toLowerCase().includes("pass") ? " ok" : "");
  verificationStrip.classList.toggle("hidden", !state.verificationRunning && !state.verificationSummary);
  verificationStrip.classList.toggle("failed", text.toLowerCase().includes("fail"));
  verificationDetails.textContent = text;
}
function renderEdits(state) {
  const changes = state.workspaceChanges || [];
  const count = state.workspaceChangesCount || changes.length;
  if (editsRail) {
    editsRail.textContent = "edits: " + count;
    editsRail.className = "rail-chip optional" + (count > 0 ? " warn" : "");
    editsRail.title = count > 0 ? "Open current workspace edits" : "No current workspace edits";
  }
  if (!editsPanelCount || !editBoard) return;
  editsPanelCount.textContent = count + " file" + (count === 1 ? "" : "s");
  editBoard.classList.toggle("hidden", changes.length === 0);
  editBoard.innerHTML = "";
  if (changes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No workspace edits detected.";
    editBoard.append(empty);
    return;
  }
  for (const change of changes) {
    const row = document.createElement("div");
    row.className = "edit-row";
    row.title = change.path || "";
    row.append(cell(change.status || "?", "status " + (change.kind || "changed")), cell(change.kind || "changed"), cell(change.path || ""));
    const controls = document.createElement("span");
    controls.className = "edit-controls";
    const open = document.createElement("button");
    open.className = "secondary";
    open.textContent = "Open";
    open.dataset.editPath = change.path || "";
    open.disabled = change.kind === "deleted";
    controls.append(open);
    row.append(controls);
    editBoard.append(row);
  }
}
function renderNativeActions(state) {
  nativeActionText.textContent = state.nativeActionSummary || "No native actions yet";
  const count = state.nativeActionsCount || 0;
  if (count > 0) nativeActionText.textContent += " (" + count + ")";
  nativeActionRail.textContent = "actions: " + count;
  lastNativeActions = state.recentNativeActions || [];
  const filteredActions = lastNativeActions.filter(matchesNativeActionFilters);
  lastFilteredNativeActions = filteredActions;
  nativePanelCount.textContent = count + " actions";
  clearNativeActionsBtn.disabled = !state.canClearNativeActions || filteredActions.length === 0;
  nativeActionStrip.classList.toggle("hidden", count === 0);
  nativeActionBoard.classList.toggle("hidden", lastNativeActions.length === 0);
  nativeActionBoard.innerHTML = "";
  if (lastNativeActions.length > 0 && filteredActions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No native actions match the current filters.";
    nativeActionBoard.append(empty);
    return;
  }
  for (const action of filteredActions) {
    const row = document.createElement("div");
    row.className = "native-action-row";
    row.title = action.instruction || "";
    row.append(cell(action.status || "unknown", "status " + (action.status || "failed")));
    row.append(cell(action.timestamp ? new Date(action.timestamp).toLocaleTimeString() : "unknown"));
    row.append(cell(nativeActionTargets(action)));
    row.append(cell(nativeActionInstruction(action)));
    const controls = document.createElement("span");
    controls.className = "native-action-controls";
    controls.append(actionButton("Rerun", "rerun", action.id, !state.canPokeNativeTerminals), actionButton("Fork", "fork", action.id), actionButton("Objective", "objective", action.id, !state.canSend), actionButton("Discuss", "discuss", action.id, !state.canSend), actionButton("Clear", "clear", action.id, !state.canClearNativeActions));
    row.append(controls);
    nativeActionBoard.append(row);
  }
}
function actionButton(label, action, id, disabled) {
  const button = document.createElement("button");
  button.className = "secondary";
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.actionId = id;
  button.disabled = !!disabled;
  return button;
}
function cell(text, className) {
  const span = document.createElement("span");
  if (className) className.split(" ").forEach((c) => span.classList.add(c));
  span.textContent = text || "";
  return span;
}
function matchesNativeActionFilters(action) {
  const agentFilter = nativeAgentFilter.value || "all";
  const statusFilter = nativeStatusFilter.value || "all";
  const agents = action.agents || [];
  const agentMatches = agentFilter === "all" || (agentFilter === "both" ? agents.includes("codex") && agents.includes("claude") : agents.includes(agentFilter));
  const statusMatches = statusFilter === "all" || action.status === statusFilter;
  return agentMatches && statusMatches;
}
function nativeActionTargets(action) {
  const agents = action.agents || [];
  const names = agents.map((agent) => agent === "codex" ? "Codex" : agent === "claude" ? "Claude" : agent);
  const attachments = [action.includeEditorContext ? "editor" : "", action.includeWorkspaceDiff ? "diff" : ""].filter(Boolean);
  return names.join(" + ") + (attachments.length ? " / " + attachments.join(", ") : "");
}
function nativeActionInstruction(action) {
  const text = action.instruction || "";
  if (text.length <= 140) return text;
  return text.slice(0, 137) + "...";
}
function renderWorkQueue(state) {
  const items = state.workQueue || [];
  workQueueText.textContent = items.length === 0 ? "Queue clear" : items.length + " open item" + (items.length === 1 ? "" : "s");
  workQueueRail.textContent = items.length === 0 ? "queue clear" : "queue: " + items.length;
  queuePanelCount.textContent = items.length + " items";
  workQueueStrip.classList.toggle("hidden", items.length === 0);
  workQueueBoard.classList.toggle("hidden", items.length === 0);
  workQueueBoard.innerHTML = "";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "work-queue-row";
    row.title = item.detail || "";
    row.append(cell(item.kind || "item", "severity " + (item.severity || "info")), cell(item.title || ""), cell(item.detail || ""));
    const controls = document.createElement("span");
    controls.className = "work-queue-controls";
    const action = document.createElement("button");
    action.className = "secondary";
    action.textContent = item.actionLabel || "Open";
    action.dataset.workAction = item.actionType || "";
    if (item.actionId) action.dataset.actionId = item.actionId;
    action.disabled = workQueueActionDisabled(item, state);
    const snooze = document.createElement("button");
    snooze.className = "secondary";
    snooze.textContent = "Snooze";
    snooze.dataset.workAction = "snooze";
    snooze.dataset.itemId = item.id;
    const dismiss = document.createElement("button");
    dismiss.className = "secondary";
    dismiss.textContent = "Dismiss";
    dismiss.dataset.workAction = "dismiss";
    dismiss.dataset.itemId = item.id;
    controls.append(action, snooze, dismiss);
    row.append(controls);
    workQueueBoard.append(row);
  }
}
function workQueueActionDisabled(item, state) {
  if (item.actionType === "acceptDefaultDecision") return !state.canAcceptDefault;
  if (item.actionType === "discussVerification") return !state.canSend;
  if (item.actionType === "rerunNativeAction") return !state.canPokeNativeTerminals;
  return true;
}
function renderModels(models, efforts) {
  if (!modelRail) return;
  const claudeModel = models && models.claude ? models.claude : "default";
  const codexModel = models && models.codex ? models.codex : "default";
  const claudeEffort = efforts && efforts.claude ? efforts.claude : "";
  const codexEffort = efforts && efforts.codex ? efforts.codex : "";
  const claudePart = claudeEffort ? claudeModel + " @" + claudeEffort : claudeModel;
  const codexPart = codexEffort ? codexModel + " @" + codexEffort : codexModel;
  modelRail.textContent = "C: " + claudePart + " · Cx: " + codexPart;
}
function renderProfiles(profiles) {
  if (!profileBtn) return;
  const fallback = { text: "custom/custom/custom", title: "Discussion: Custom, Build: Custom, Review: Custom" };
  const claude = profiles && profiles.claude ? profiles.claude : fallback;
  const codex = profiles && profiles.codex ? profiles.codex : fallback;
  profileBtn.textContent = "profiles: C " + claude.text + " | Cx " + codex.text;
  profileBtn.title = "Change capability profiles. Claude: " + claude.title + ". Codex: " + codex.title + ".";
}
function renderSessionUsage(u, weekly) {
  if (!usageRail) return;
  const session = u || {};
  const week = weekly || {};
  if (!(session.turns || week.turns)) {
    usageRail.textContent = "usage: 0 turns";
    usageRail.className = "rail-chip";
    usageRail.title = "No usage recorded for this session or the rolling 7-day window yet.";
    renderUsagePanel(session, week, []);
    return;
  }
  const total = session.totalTokens || 0;
  const tokenStr = formatTokens(total);
  const cost = session.costUsd || 0;
  const costStr = formatCost(cost);
  u = session;
  const weekCost = week.costUsd || 0;
  usageRail.textContent = "session " + (session.turns || 0) + "t " + tokenStr + " tok " + costStr + " | 7d " + formatTokens(week.totalTokens || 0) + " tok " + formatCost(weekCost);
  usageRail.className = "rail-chip " + (Math.max(cost, weekCost) >= 1 ? "warn" : "ok");
  usageRail.title = "Open usage panel. Session input " + formatTokens(session.inputTokens || 0) + ", output " + formatTokens(session.outputTokens || 0) + ". Rolling 7-day total " + formatTokens(week.totalTokens || 0) + " tokens, " + formatCost(weekCost) + ".";
  renderUsagePanel(session, week, lastState.recentUsageRecords || []);
}
function renderUsagePanel(u, weekly, records) {
  if (!usagePanelCount || !usageSummary || !usageBoard) return;
  const summary = u || {};
  const week = weekly || {};
  const rows = records || [];
  usagePanelCount.textContent = (summary.turns || 0) + " session turns / " + (week.turns || 0) + " 7d turns";
  usageSummary.innerHTML = "";
  usageSummary.append(
    usageStat(formatTokens(summary.totalTokens || 0), "session tokens"),
    usageStat(formatCost(summary.costUsd || 0), "session cost"),
    usageStat(formatTokens(week.totalTokens || 0), "7d tokens"),
    usageStat(formatCost(week.costUsd || 0), "7d cost"),
    usageStat(formatTokens(summary.inputTokens || 0), "fresh input"),
    // Why: usageFromCodexSummary folds reasoning into outputTokens already; Claude reports reasoningTokens=0. Adding them here double-counts Codex reasoning.
    usageStat(formatTokens(summary.outputTokens || 0), "output + reasoning")
  );
  const agents = summary.byAgent || {};
  usageSummary.append(
    usageStat(agentUsageLabel("codex", agents.codex), "codex"),
    usageStat(agentUsageLabel("claude", agents.claude), "claude"),
    usageStat(formatTokens(summary.cacheReadTokens || 0), "cache read"),
    usageStat(formatTokens(summary.cacheCreateTokens || 0), "cache write")
  );
  usageBoard.classList.remove("hidden");
  usageBoard.innerHTML = "";
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No per-turn usage has been recorded for this session yet.";
    usageBoard.append(empty);
    return;
  }
  const header = document.createElement("div");
  header.className = "usage-row header";
  ["time", "agent", "phase", "input", "output", "cache", "reasoning", "cost"].forEach((label) => header.append(cell(label)));
  usageBoard.append(header);
  for (const record of rows) {
    const row = document.createElement("div");
    row.className = "usage-row";
    const cache = (record.cacheReadTokens || 0) + (record.cacheCreateTokens || 0);
    row.title = (record.model ? "model: " + record.model + "\n" : "") + "source: " + (record.source || "unknown");
    row.append(
      cell(record.timestamp ? new Date(record.timestamp).toLocaleTimeString() : "unknown"),
      cell(record.agent || "unknown"),
      cell(record.phase || ""),
      cell(formatTokens(record.inputTokens || 0)),
      cell(formatTokens(record.outputTokens || 0)),
      cell(formatTokens(cache)),
      cell(formatTokens(record.reasoningTokens || 0)),
      cell(formatCost(record.costUsd || 0))
    );
    usageBoard.append(row);
  }
}
function usageStat(value, label) {
  const el = document.createElement("div");
  el.className = "usage-stat";
  const strong = document.createElement("strong");
  strong.textContent = value;
  const span = document.createElement("span");
  span.textContent = label;
  el.append(strong, span);
  return el;
}
function agentUsageLabel(agent, value) {
  const u = value || {};
  return (u.turns || 0) + "t / " + formatTokens(u.totalTokens || 0) + " / " + formatCost(u.costUsd || 0);
}
function formatTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 10000) return (n / 1000).toFixed(0) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
function formatCost(value) {
  const n = Number(value) || 0;
  if (n < 0.01) return "$" + n.toFixed(4);
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}
function renderDecision(decision, count, risky, accepted) {
  decisionStrip.classList.toggle("hidden", !decision);
  decisionRail.textContent = decision ? "decision: " + (accepted ? "accepted" : decision.decisionNeededFromUser ? "needs user" : "ready") : "decision: none";
  decisionRail.className = "rail-chip optional" + (decision && !accepted && decision.decisionNeededFromUser ? " warn" : accepted ? " ok" : "");
  if (decisionRiskChip) {
    if (decision && risky && risky.risky && risky.reasons && risky.reasons.length) {
      decisionRiskChip.textContent = "risky: " + risky.reasons.join(", ");
      decisionRiskChip.style.display = "";
    } else {
      decisionRiskChip.style.display = "none";
    }
  }
  if (!decision) return;
  decisionCount.textContent = count > 0 ? "(" + count + ")" : "";
  decisionDefault.textContent = decision.defaultNextAction || "None";
  decisionRecommendation.textContent = decision.recommendation || "None";
  decisionNeeded.textContent = decision.decisionNeededFromUser || "none";
  decisionBlockers.textContent = decision.blockers || "none";
}
function renderDecisionAction(action, canAccept, accepted, running) {
  const label = accepted ? (running ? "Default Running" : "Default Accepted") : action && action.label ? action.label : "Accept Default";
  const detail = accepted ? "The latest decision default has already been accepted." : action && action.detail ? action.detail : "No default action is available";
  acceptDefaultBtn.textContent = label;
  acceptDefaultBtn.title = detail;
  acceptDefaultBtn.disabled = !canAccept;
}
function renderAutoAdvanceDefaults(enabled) {
  autoAdvanceDefaultsBtn.textContent = enabled ? "Auto Accept: On" : "Auto Accept: Off";
  autoAdvanceDefaultsBtn.title = enabled
    ? "Turn off automatic acceptance of unblocked decision defaults"
    : "Turn on automatic acceptance of unblocked decision defaults";
}
function renderDecisionBoard(decisions) {
  decisionPanelCount.textContent = decisions.length + " decisions";
  decisionBoard.classList.toggle("hidden", decisions.length === 0);
  decisionBoard.innerHTML = "";
  for (const decision of decisions) {
    const row = document.createElement("div");
    row.className = "decision-row";
    row.append(cell((labels[decision.agent] || decision.agent) + (decision.phase ? " / " + decision.phase : "")), cell("Next: " + (decision.defaultNextAction || "none")), cell("Needs: " + (decision.decisionNeededFromUser || "none")), cell("Blockers: " + (decision.blockers || "none")));
    decisionBoard.append(row);
  }
}
function pendingPlaceholder(message) {
  const speaker = labels[message.role] || message.role || "Agent";
  if (message.phase === "opener") return speaker + " is starting the opener...";
  if (message.phase === "reactor") return speaker + " is reading and reacting...";
  if (message.phase === "closer") return speaker + " is closing the loop...";
  if (message.phase === "parallel") return speaker + " is running an independent pass...";
  if (message.phase === "build") return speaker + " is starting the build...";
  if (message.phase === "review") return speaker + " is reviewing the diff...";
  return speaker + " is starting...";
}

function openPalette() {
  cmdOverlay.dataset.open = "true";
  cmdOverlay.setAttribute("aria-hidden", "false");
  renderPalette("");
  setTimeout(() => {
    paletteInput.value = "";
    paletteInput.focus();
  }, 0);
}
function closePalette() {
  cmdOverlay.dataset.open = "false";
  cmdOverlay.setAttribute("aria-hidden", "true");
  paletteInput.setAttribute("aria-activedescendant", "");
  commandCenterBtn.focus();
}
function openPanel(panel) {
  panelOverlay.dataset.panel = panel;
  panelOverlay.dataset.open = "true";
  panelOverlay.setAttribute("aria-hidden", "false");
}
function closePanel() {
  panelOverlay.dataset.open = "false";
  panelOverlay.setAttribute("aria-hidden", "true");
  commandCenterBtn.focus();
}
cmdOverlay.addEventListener("click", (event) => {
  if (event.target === cmdOverlay) closePalette();
});
panelOverlay.addEventListener("click", (event) => {
  if (event.target === panelOverlay || (event.target.classList && event.target.classList.contains("close"))) closePanel();
});
paletteInput.addEventListener("input", () => renderPalette(paletteInput.value));
commandList.addEventListener("click", (event) => {
  const option = event.target.closest ? event.target.closest(".command-option") : undefined;
  if (!option || option.getAttribute("aria-disabled") === "true") return;
  selectOption(option.id);
  activateSelection();
});
document.addEventListener("keydown", (event) => {
  const paletteOpen = cmdOverlay.dataset.open === "true";
  const panelOpen = panelOverlay.dataset.open === "true";
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    paletteOpen ? closePalette() : openPalette();
    return;
  }
  if (event.key === "Escape") {
    if (panelOpen) { closePanel(); return; }
    if (paletteOpen) { closePalette(); return; }
  }
  if (!paletteOpen) return;
  if (event.key === "ArrowDown") { event.preventDefault(); moveSelection(1); }
  if (event.key === "ArrowUp") { event.preventDefault(); moveSelection(-1); }
  if (event.key === "Enter") { event.preventDefault(); activateSelection(); }
});
function renderPalette(query) {
  const q = (query || "").trim();
  commandList.innerHTML = "";
  const groups = new Map();
  const sorted = ACTIONS.filter((action) => fuzzyMatch(q, action.name + " " + action.what + " " + action.group));
  const suggested = sorted.filter((action) => isSuggested(action));
  if (!q && suggested.length) groups.set("Suggested", suggested.slice(0, 5));
  for (const action of sorted) {
    if (!q && suggested.slice(0, 5).includes(action)) continue;
    if (!groups.has(action.group)) groups.set(action.group, []);
    groups.get(action.group).push(action);
  }
  if (groups.size === 0) {
    commandList.innerHTML = '<p class="empty">No commands match "' + escapeHtml(q) + '".</p>';
    return;
  }
  let firstId = "";
  for (const [group, actions] of groups) {
    const section = document.createElement("section");
    section.className = "command-group";
    const heading = document.createElement("h4");
    heading.textContent = group;
    section.append(heading);
    for (const action of actions) {
      const enabled = action.enabled ? !!action.enabled() : true;
      const item = document.createElement("div");
      item.className = "command-option";
      item.id = "cmd-" + action.id;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");
      item.setAttribute("aria-disabled", enabled ? "false" : "true");
      item.dataset.actionId = action.id;
      const reason = enabled ? "" : disabledReason(action);
      item.innerHTML = '<span><span class="command-name">' + escapeHtml(action.name) + '</span><span class="command-desc">' + escapeHtml(action.what || "") + '</span>' + (reason ? '<span class="command-why"> - ' + escapeHtml(reason) + '</span>' : "") + '</span><span class="palette-meta">' + escapeHtml(action.group) + '</span><span class="kbd">' + escapeHtml(action.acc || "Enter") + '</span>';
      section.append(item);
      if (!firstId && enabled) firstId = item.id;
    }
    commandList.append(section);
  }
  if (firstId) selectOption(firstId);
}
function isSuggested(action) {
  if (lastState.canOpenFolder && (action.id === "open-folder" || action.id === "doctor")) return true;
  if (lastState.needsCodexPath && action.id === "fix-codex") return true;
  if (lastState.needsClaudePath && action.id === "fix-claude") return true;
  if (lastState.canStop && ["stop", "open-actions", "open-queue"].includes(action.id)) return true;
  if (lastState.canAcceptDefault && action.id === "accept-default") return true;
  if (lastState.canAssignBuilder && (action.id === "assign-codex" || action.id === "assign-claude" || action.id === "assign-both")) return true;
  if (lastState.canRequestReview && action.id === "request-review") return true;
  if (String(lastState.verificationSummary || "").toLowerCase().includes("fail") && (action.id === "verification" || action.id === "open-verify")) return true;
  if (lastState.canSend && (action.id === "send" || action.id === "pin-objective")) return true;
  return false;
}
function disabledReason(action) {
  if (action.id === "send") return "composer is disabled";
  if (action.id === "stop") return "no active turn";
  if (action.id === "open-folder") return "workspace is already open";
  if (action.id === "fix-codex") return "Codex path check is not failing";
  if (action.id === "fix-claude") return "Claude path check is not failing";
  if (action.id === "choose-model" || action.id === "choose-effort" || action.id === "test-telegram" || action.id === "open-objective" || action.id === "open-agent-calls" || action.id === "clean-workspace-state") return "open a workspace folder first";
  if (action.id.indexOf("assign-") === 0) return "builder assignment unavailable";
  if (action.id === "request-review") return "no build ready for review";
  if (action.id.indexOf("poke-") === 0 || action.id.indexOf("-command") > 0 || action.id.indexOf("-raw") > 0 || action.id === "native-action") return "native terminal actions unavailable";
  if (action.id.indexOf("verification") >= 0) return "verification unavailable in this state";
  return "not available in this state";
}
function fuzzyMatch(q, hay) {
  if (!q) return true;
  q = q.toLowerCase();
  hay = hay.toLowerCase();
  let index = 0;
  for (const char of q) {
    index = hay.indexOf(char, index);
    if (index < 0) return false;
    index++;
  }
  return true;
}
function selectOption(id) {
  document.querySelectorAll(".command-option").forEach((item) => item.setAttribute("aria-selected", item.id === id ? "true" : "false"));
  paletteInput.setAttribute("aria-activedescendant", id || "");
}
function moveSelection(delta) {
  const items = Array.from(document.querySelectorAll('.command-option[aria-disabled="false"]'));
  if (!items.length) return;
  const current = items.findIndex((item) => item.getAttribute("aria-selected") === "true");
  const next = (current + delta + items.length) % items.length;
  selectOption(items[next].id);
  items[next].scrollIntoView({ block: "nearest" });
}
function activateSelection() {
  const selected = document.querySelector('.command-option[aria-selected="true"]');
  if (!selected || selected.getAttribute("aria-disabled") === "true") return;
  const action = ACTIONS.find((item) => item.id === selected.dataset.actionId);
  if (!action) return;
  action.run();
  closePalette();
}
function headAsset(role) {
  return HEAD_ASSETS[role] || HEAD_ASSETS.system || "";
}
function headGlyph(role) {
  if (role === "codex") return "C";
  if (role === "claude") return "C";
  if (role === "user") return "U";
  return "H";
}
function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

vscode.postMessage({ type: "ready" });
