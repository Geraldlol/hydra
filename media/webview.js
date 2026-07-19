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
const railSecondaryWrap = document.getElementById("railSecondaryWrap");
const railOverflowBtn = document.getElementById("railOverflowBtn");
const messagesEl = document.getElementById("messages");
const srAnnounce = document.getElementById("srAnnounce");
const composer = document.getElementById("composer");
const transportChip = document.getElementById("transportChip");
const phaseChip = document.getElementById("phaseChip");
const objectiveText = document.getElementById("objectiveText");
const objectiveTextShim = document.getElementById("objectiveTextShim");
const resetObjectiveBtn = document.getElementById("resetObjectiveBtn");
const agentStatusRail = document.getElementById("agentStatusRail");
const authorityRail = document.getElementById("authorityRail");
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
const handoffStrip = document.getElementById("handoffStrip");
const handoffTitle = document.getElementById("handoffTitle");
const handoffSource = document.getElementById("handoffSource");
const handoffAction = document.getElementById("handoffAction");
const handoffConfirmBtn = document.getElementById("handoffConfirmBtn");
const handoffPreviewBtn = document.getElementById("handoffPreviewBtn");
const handoffDismissBtn = document.getElementById("handoffDismissBtn");
const autoAdvanceDefaultsBtn = document.getElementById("autoAdvanceDefaultsBtn");
const openerBtn = document.getElementById("openerBtn");
const commandCenterBtn = document.getElementById("commandCenterBtn");
const browserBtn = document.getElementById("browserBtn");
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
const builderButtons = document.getElementById("builderButtons");
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
const standingsRail = document.getElementById("standingsRail");
const standingsPanelCount = document.getElementById("standingsPanelCount");
const standingsBoard = document.getElementById("standingsBoard");
const recordVerdictBtn = document.getElementById("recordVerdictBtn");
const adjudicatePendingBtn = document.getElementById("adjudicatePendingBtn");
const openEvidenceBtn = document.getElementById("openEvidenceBtn");
const reverseVerdictBtn = document.getElementById("reverseVerdictBtn");
const openStandingsBtn = document.getElementById("openStandingsBtn");
const duelsRail = document.getElementById("duelsRail");
const duelsPanelCount = document.getElementById("duelsPanelCount");
const duelsBoard = document.getElementById("duelsBoard");
const agentDuelMode = document.getElementById("agentDuelMode");
const openDuelAuditBtn = document.getElementById("openDuelAuditBtn");
const correctDuelResultBtn = document.getElementById("correctDuelResultBtn");
if (usageRail) {
  const open = () => openPanel("usage");
  usageRail.addEventListener("click", open);
  usageRail.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
}
if (standingsRail) {
  const open = () => openPanel("standings");
  standingsRail.addEventListener("click", open);
  standingsRail.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
}
if (duelsRail) {
  const open = () => openPanel("duels");
  duelsRail.addEventListener("click", open);
  duelsRail.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
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
const DEFAULT_WEBVIEW_ROSTER = [
  { id: "codex", displayName: "Codex", colorIndex: 1 },
  { id: "claude", displayName: "Claude", colorIndex: 2 }
];
let lastMessages = [];
let pendingLocalUserMessages = [];
let lastFilteredNativeActions = [];
let defaultOpener = "codex";
let selectedOpener = "codex";
let hasOpenerOverride = false;
let lastHandoffKey = null;
let transport = "oneShot";
let lastNativeActions = [];
let lastState = {};
/** Roster metadata ({id, displayName, colorIndex}) keyed by agent id, sent by
 *  the host in state.roster (see listAgentDefinitions in src/agentRegistry.ts).
 *  The ordered roster starts with the legacy two-head fallback; this lookup is
 *  populated from the first normalized state payload. */
let rosterById = {};
let currentRoster = DEFAULT_WEBVIEW_ROSTER.slice();
let ribbonsMinimized = !!webviewState.ribbonsMinimized;
let railExpanded = !!webviewState.railExpanded;
let collapsedRibbons = new Set(Array.isArray(webviewState.collapsedRibbons)
  ? webviewState.collapsedRibbons
  : ["setupStrip", "verificationStrip", "nativeActionStrip", "workQueueStrip"]);
/** Cheap signature of the rendered message list. renderMessages() bails early
 *  when it matches, so unrelated state pushes (the 5s elapsed-label ticker,
 *  usage/status/work-queue updates) skip the DOM reconcile entirely. Starts as
 *  null (never equal to a real signature) so the first render always runs and
 *  replaces the ship-time "Loading the room..." placeholder. */
let lastRenderSignature = null;
/** Tracks whether the last agent-activity announcement has already fired per
 *  message id, so the screen-reader live region is not spammed on every push. */
let lastAnnouncedActivity = new Map();
/** Element focus to restore when a dialog/palette closes (the opener). */
let dialogRestoreFocus = null;

const ACTIONS = [
  { id: "send", group: "Suggested", name: "Send", what: "Start a Hydra turn with the current opener", acc: "Ctrl+Enter", run: () => sendBtn.click(), enabled: () => !sendBtn.disabled },
  { id: "stop", group: "Suggested", name: "Stop Current Turn", what: "Cancel the active agent call", acc: "Esc", run: () => stopBtn.click(), enabled: () => !stopBtn.classList.contains("hidden") && !stopBtn.disabled },
  { id: "open-browser", group: "Suggested", name: "Open Integrated Browser", what: "Open a URL inside VS Code", run: () => browserBtn.click() },
  { id: "toggle-browser-control", group: "Workflow", name: "Toggle Agent Browser Control", what: "Grant or revoke session-only control of Hydra browser tabs", run: () => vscode.postMessage({ type: "toggleBrowserControl" }) },
  { id: "pin-objective", group: "Objective", name: "Pin Objective", what: "Use composer text as room objective", run: () => setObjectiveBtn.click(), enabled: () => !setObjectiveBtn.disabled },
  { id: "preview-prompt", group: "Objective", name: "Preview Prompt", what: "Inspect the exact next prompt", run: () => previewPromptBtn.click(), enabled: () => !previewPromptBtn.disabled },
  { id: "open-last-prompt", group: "Objective", name: "Open Last Prompt", what: "Reopen the latest persisted prompt envelope", run: () => openLastPromptBtn.click(), enabled: () => !openLastPromptBtn.disabled },
  { id: "attach-files", group: "Objective", name: "Attach Files", what: "Attach files or documents to the next room turn", run: () => attachFilesBtn.click(), enabled: () => !attachFilesBtn.disabled },
  { id: "clean-workspace-state", group: "Objective", name: "Clean Workspace State", what: "Compact old prompt bodies and prune stale .hydra diagnostics", run: () => vscode.postMessage({ type: "cleanWorkspaceState" }), enabled: () => !lastState.canOpenFolder },
  { id: "archive-chat", group: "Objective", name: "Archive Chat", what: "Archive transcript and clear room", run: () => archiveChatBtn.click(), enabled: () => !archiveChatBtn.disabled },
  { id: "accept-default", group: "Workflow", name: "Accept Default", what: "Run the latest decision default", run: () => acceptDefaultBtn.click(), enabled: () => !acceptDefaultBtn.disabled },
  { id: "toggle-auto-accept-default", group: "Workflow", name: "Toggle Safe-default Auto-advance", what: "Turn automatic advancement of safe, unblocked defaults on or off", run: () => autoAdvanceDefaultsBtn.click(), enabled: () => !autoAdvanceDefaultsBtn.disabled },
  { id: "assign-codex", group: "Workflow", name: "Assign Builder: Codex", what: "Let Codex edit files", run: () => vscode.postMessage({ type: "assignBuilder", builder: "codex" }), enabled: () => canAssignRegisteredBuilder("codex") },
  { id: "assign-claude", group: "Workflow", name: "Assign Builder: Claude", what: "Let Claude edit files", run: () => vscode.postMessage({ type: "assignBuilder", builder: "claude" }), enabled: () => canAssignRegisteredBuilder("claude") },
  { id: "assign-both", group: "Workflow", name: "Assign Builders: All Configured Heads", what: "Run every configured Hydra head as a parallel Build worker", run: () => assignBothBtn.click(), enabled: () => !assignBothBtn.classList.contains("hidden") && !assignBothBtn.disabled },
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
  { id: "open-standings-panel", group: "Panels", name: "Open Evidence Scoreboard", what: "Inspect the passive, evidence-backed scoreboard and head standings", run: () => openPanel("standings") },
  { id: "open-duels-panel", group: "Panels", name: "Open Formal Duels", what: "Inspect agent-initiated domain competition without changing authority", run: () => openPanel("duels") },
  { id: "open-usage-panel", group: "Panels", name: "Open Usage Panel", what: "Inspect session tokens, cache, reasoning, and estimated cost", run: () => openPanel("usage") },
  { id: "open-terminal-panel", group: "Panels", name: "Open Terminal Sessions Panel", what: "Inspect terminal sessions", run: () => openPanel("term") },
  { id: "toggle-ribbons", group: "Panels", name: "Toggle Status Ribbons", what: "Minimize or restore the status ribbons above the composer", run: () => toggleRibbonsBtn.click() },
  { id: "open-objective", group: "Files", name: "Open Objective", what: "Open the pinned room objective file", run: () => vscode.postMessage({ type: "openObjective" }), enabled: () => !lastState.canOpenFolder },
  { id: "open-native-actions-file", group: "Files", name: "Open Native Actions Log", what: "Open durable native action log", run: () => openNativeActionsFooterBtn.click(), enabled: () => !openNativeActionsFooterBtn.disabled },
  { id: "open-agent-calls", group: "Files", name: "Open Agent Call Log", what: "Open native dispatch traces and stderr previews", run: () => vscode.postMessage({ type: "openAgentCalls" }), enabled: () => !lastState.canOpenFolder },
  { id: "open-decisions", group: "Files", name: "Open Decisions", what: "Open decisions log", run: () => openDecisionsBtn.click(), enabled: () => !openDecisionsBtn.disabled },
  { id: "open-standings", group: "Files", name: "Open Scoreboard Markdown", what: "Open the derived passive scoreboard and standings mirror", run: () => vscode.postMessage({ type: "openStandings" }), enabled: () => !lastState.canOpenFolder },
  { id: "open-score-evidence", group: "Files", name: "Review Score Evidence", what: "Inspect every active claim, source, and rationale driving the standings", run: () => vscode.postMessage({ type: "openScoreEvidence" }), enabled: () => !lastState.canOpenFolder },
  { id: "open-duel-audit", group: "Files", name: "Open Duel Audit", what: "Open the derived formal-duel audit", run: () => vscode.postMessage({ type: "openDuelAudit" }), enabled: () => !lastState.canOpenFolder },
  { id: "cancel-duel", group: "Workflow", name: "Cancel Formal Duel", what: "Cancel an accepted unresolved duel without changing Elo", run: () => vscode.postMessage({ type: "cancelDuel" }), enabled: () => !lastState.canOpenFolder },
  { id: "correct-duel-result", group: "Workflow", name: "Correct Duel Result", what: "Append an audited correction to a resolved duel", run: () => vscode.postMessage({ type: "correctDuelResult" }), enabled: () => !lastState.canOpenFolder },
  { id: "record-score-verdict", group: "Workflow", name: "Record Evidence Verdict", what: "Adjudicate one falsifiable claim without changing head authority", run: () => vscode.postMessage({ type: "recordScoreVerdict" }), enabled: () => !lastState.canOpenFolder },
  { id: "adjudicate-pending-score-claim", group: "Workflow", name: "Adjudicate Pending Score Claim", what: "Attach a corrected verdict to a claim whose earlier verdict was reversed", run: () => vscode.postMessage({ type: "adjudicatePendingScoreClaim" }), enabled: () => !lastState.canOpenFolder },
  { id: "reverse-score-verdict", group: "Workflow", name: "Reverse Evidence Verdict", what: "Append an audited reversal so a bad verdict no longer affects standings", run: () => vscode.postMessage({ type: "reverseScoreVerdict" }), enabled: () => !lastState.canOpenFolder },
  { id: "open-verification-file", group: "Files", name: "Open Verification Log", what: "Open the durable verification result log", run: () => openVerificationBtn.click(), enabled: () => !openVerificationBtn.disabled },
  { id: "open-transcript", group: "Files", name: "Open Transcript", what: "Open the Hydra transcript", run: () => openTranscriptBtn.click(), enabled: () => !openTranscriptBtn.disabled },
  { id: "session-brief", group: "Files", name: "Session Brief", what: "Open the current session brief", run: () => openSessionBriefBtn.click(), enabled: () => !openSessionBriefBtn.disabled },
  { id: "wiki-context", group: "Files", name: "Wiki Context", what: "Open the persistent compiled wiki context", run: () => vscode.postMessage({ type: "openWikiContext" }), enabled: () => !lastState.canOpenFolder },
  { id: "wiki-wrapup-now", group: "Files", name: "Run Wiki Wrapup Now", what: "Force a wiki wrapup from the latest completed room turn", run: () => vscode.postMessage({ type: "runWikiWrapupNow" }), enabled: () => !!lastState.canRunWikiWrapup },
  { id: "choose-model", group: "Settings", name: "Choose Model", what: "Pick Codex or Claude model overrides", run: () => vscode.postMessage({ type: "chooseModel" }), enabled: () => !lastState.canOpenFolder },
  { id: "choose-effort", group: "Settings", name: "Choose Thinking Level", what: "Pick Codex reasoning or Claude effort overrides", run: () => vscode.postMessage({ type: "chooseEffort" }), enabled: () => !lastState.canOpenFolder },
  { id: "toggle-many-heads", group: "Settings", name: "Toggle Claude Worker Fanout", what: "Run parallel Claude workers; this does not add independent Hydra heads", run: () => vscode.postMessage({ type: "toggleManyHeadsMode" }), enabled: () => !lastState.canOpenFolder },
  { id: "many-heads-workers", group: "Settings", name: "Set Claude Fanout Workers", what: "Choose the local subscription-backed Claude worker count", run: () => vscode.postMessage({ type: "configureManyHeadsWorkers" }), enabled: () => !lastState.canOpenFolder },
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
  selectedOpener = nextRosterAgent(selectedOpener);
  hasOpenerOverride = selectedOpener !== defaultOpener;
  renderOpenerButton();
});
commandCenterBtn.addEventListener("click", () => {
  if (cmdOverlay.dataset.open === "true") closePalette();
  else openPalette();
});
browserBtn.addEventListener("click", () => vscode.postMessage({ type: "openBrowser" }));
toggleRibbonsBtn.addEventListener("click", () => setRibbonsMinimized(!ribbonsMinimized));
railOverflowBtn.addEventListener("click", () => setRailExpanded(!railExpanded));
ribbonStack.addEventListener("click", (event) => {
  const button = event.target && event.target.closest ? event.target.closest("[data-ribbon-toggle]") : undefined;
  if (!button) return;
  toggleRibbonCollapsed(button.dataset.ribbonToggle || "");
});
setRibbonsMinimized(ribbonsMinimized);
setRailExpanded(railExpanded);
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
assignBothBtn.addEventListener("click", () => vscode.postMessage({ type: "assignParallelBuilders" }));
reviewBtn.addEventListener("click", () => vscode.postMessage({ type: "requestReview" }));
acceptDefaultBtn.addEventListener("click", () => vscode.postMessage({ type: "acceptDefaultDecision" }));
handoffConfirmBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "confirmHandoff", action: handoffAction.value });
});
handoffPreviewBtn.addEventListener("click", () => vscode.postMessage({ type: "previewHandoff" }));
handoffDismissBtn.addEventListener("click", () => vscode.postMessage({ type: "dismissHandoff" }));
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
if (recordVerdictBtn) recordVerdictBtn.addEventListener("click", () => vscode.postMessage({ type: "recordScoreVerdict" }));
if (adjudicatePendingBtn) adjudicatePendingBtn.addEventListener("click", () => vscode.postMessage({ type: "adjudicatePendingScoreClaim" }));
if (openEvidenceBtn) openEvidenceBtn.addEventListener("click", () => vscode.postMessage({ type: "openScoreEvidence" }));
if (reverseVerdictBtn) reverseVerdictBtn.addEventListener("click", () => vscode.postMessage({ type: "reverseScoreVerdict" }));
if (openStandingsBtn) openStandingsBtn.addEventListener("click", () => vscode.postMessage({ type: "openStandings" }));
if (openDuelAuditBtn) openDuelAuditBtn.addEventListener("click", () => vscode.postMessage({ type: "openDuelAudit" }));
if (correctDuelResultBtn) correctDuelResultBtn.addEventListener("click", () => vscode.postMessage({ type: "correctDuelResult" }));
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
  // Why: one malformed inbound message must not throw and kill the listener
  // for the rest of the session — guard the shape before reading msg.type.
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "openPanel" && msg.panel === "duels") openPanel("duels");
  else if (msg.type === "state") renderState(msg);
  else if (msg.type === "chunk") appendChunk(msg.messageId, msg.text);
  else if (msg.type === "replaceMessageText") replaceMessageText(msg.messageId, msg.text);
  else if (msg.type === "liveChannelEvent") appendLiveChannelEvent(msg.messageId, msg.event);
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

// Locate (or lazily create) the streaming text node for a message. A pending
// card that still shows its activity placeholder has no .text element yet, so
// the first chunk would otherwise be dropped — create it inside the card.
function ensureMessageTextEl(messageId) {
  const article = document.querySelector('[data-mid="' + cssEscape(messageId) + '"]');
  if (!article) return null;
  let el = article.querySelector(".text");
  if (el) return el;
  const card = article.querySelector(".message-card");
  if (!card) return null;
  el = document.createElement("pre");
  el.className = "text";
  card.append(el);
  return el;
}

function appendLiveChannelEvent(messageId, event) {
  if (!messageId || !event || typeof event !== "object") return;
  const message = lastMessages.find((m) => m && m.id === messageId);
  if (message) {
    const events = Array.isArray(message.liveChannelEvents) ? message.liveChannelEvents : [];
    events.push(event);
    message.liveChannelEvents = events.slice(-50);
  }
  const article = document.querySelector('[data-mid="' + cssEscape(messageId) + '"]');
  const card = article ? article.querySelector(".message-card") : null;
  if (!card) return;
  const scroll = captureMessageScroll();
  let list = card.querySelector(".live-channel-events");
  if (!list) {
    list = document.createElement("div");
    list.className = "live-channel-events";
    card.append(list);
  }
  list.append(renderLiveChannelEvent(event));
  while (list.children.length > 50 && list.firstElementChild) list.firstElementChild.remove();
  restoreMessageScroll(scroll);
}

function appendChunk(messageId, text) {
  const el = ensureMessageTextEl(messageId);
  if (!el) return;
  const scroll = captureMessageScroll();
  el.textContent += text;
  restoreMessageScroll(scroll);
}

function replaceMessageText(messageId, text) {
  const el = ensureMessageTextEl(messageId);
  if (!el) return;
  const scroll = captureMessageScroll();
  el.textContent = text;
  restoreMessageScroll(scroll);
}

function buildRosterById(roster) {
  // Why: Object.create(null) has no prototype, so a future roster id of
  // "__proto__" can't be used to pollute Object.prototype via map[def.id] = def.
  const map = Object.create(null);
  for (const def of Array.isArray(roster) ? roster : []) {
    if (def && typeof def.id === "string") map[def.id] = def;
  }
  return map;
}

function normalizeRoster(roster) {
  const source = Array.isArray(roster) && roster.length > 0 ? roster : DEFAULT_WEBVIEW_ROSTER;
  const normalized = [];
  const seen = new Set();
  for (const candidate of source) {
    if (!candidate || typeof candidate.id !== "string") continue;
    const id = candidate.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = typeof candidate.displayName === "string" && candidate.displayName.trim()
      ? candidate.displayName.trim()
      : id;
    const colorIndex = Number.isInteger(candidate.colorIndex) && candidate.colorIndex >= 1 && candidate.colorIndex <= 8
      ? candidate.colorIndex
      : (normalized.length % 8) + 1;
    normalized.push({ id, displayName, colorIndex });
  }
  return normalized.length > 0 ? normalized : DEFAULT_WEBVIEW_ROSTER.slice();
}

function renderState(state) {
  lastState = state;
  currentRoster = normalizeRoster(state.roster);
  rosterById = buildRosterById(currentRoster);
  const hostMessages = state.messages || [];
  pendingLocalUserMessages = pendingLocalUserMessages.filter((pending) => !hostMessages.some((m) => sameUserMessage(m, pending)));
  lastMessages = hostMessages.concat(pendingLocalUserMessages);
  renderMessages();
  transport = state.transport || "oneShot";
  const requestedOpener = state.firstSpeaker || state.defaultOpener || currentRoster[0].id;
  defaultOpener = rosterById[requestedOpener] ? requestedOpener : currentRoster[0].id;
  if (!hasOpenerOverride || !rosterById[selectedOpener]) {
    selectedOpener = defaultOpener;
    hasOpenerOverride = false;
  } else {
    hasOpenerOverride = selectedOpener !== defaultOpener;
  }
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
  renderHandoff(state.pendingHandoff);
  renderAutoAdvanceDefaults(!!state.autoAdvanceActionableDefaults);
  renderDecisionAction(state.decisionAction, !!state.canAcceptDefault, !!state.latestDecisionAccepted, !!state.canStop);
  renderStandings(state.standings || {});
  renderDuels(state.duels || {});
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
  openerBtn.disabled = !state.canSend || currentRoster.length < 2;
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
  renderBuilderButtons(!!state.canAssignBuilder, state.suggestedBuilder);
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
  if (recordVerdictBtn) recordVerdictBtn.disabled = !!state.canOpenFolder;
  if (adjudicatePendingBtn) adjudicatePendingBtn.disabled = !!state.canOpenFolder;
  if (openEvidenceBtn) openEvidenceBtn.disabled = !!state.canOpenFolder;
  if (reverseVerdictBtn) reverseVerdictBtn.disabled = !!state.canOpenFolder;
  if (openStandingsBtn) openStandingsBtn.disabled = !!state.canOpenFolder;
  if (openDuelAuditBtn) openDuelAuditBtn.disabled = !!state.canOpenFolder;
  if (correctDuelResultBtn) correctDuelResultBtn.disabled = !!state.canOpenFolder;
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
  toggleRibbonsBtn.textContent = ribbonsMinimized ? "Show status" : "Hide status";
  toggleRibbonsBtn.title = ribbonsMinimized ? "Show pinned room status" : "Hide pinned room status";
  toggleRibbonsBtn.setAttribute("aria-expanded", String(!ribbonsMinimized));
  persistWebviewState();
  updateRibbonMinimizedSummary(lastState || {});
}

function setRailExpanded(value) {
  railExpanded = !!value;
  railSecondaryWrap.classList.toggle("is-expanded", railExpanded);
  railOverflowBtn.textContent = railExpanded ? "Compact" : "All status";
  railOverflowBtn.title = railExpanded ? "Show only active operational status" : "Show every operational status";
  railOverflowBtn.setAttribute("aria-expanded", String(railExpanded));
  persistWebviewState();
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
    const label = button.dataset.ribbonLabel || "status";
    const el = document.getElementById(id);
    const collapsed = collapsedRibbons.has(id);
    if (el) el.classList.toggle("is-collapsed", collapsed);
    button.textContent = collapsed ? "+" : "\u2212";
    button.title = (collapsed ? "Expand " : "Collapse ") + label;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-expanded", String(!collapsed));
  });
}

function persistWebviewState(extra) {
  if (!vscode.setState) return;
  const base = Object.assign({}, vscode.getState ? (vscode.getState() || {}) : {});
  vscode.setState(Object.assign(base, {
    ribbonsMinimized,
    collapsedRibbons: Array.from(collapsedRibbons),
    railExpanded
  }, extra || {}));
}

function updateRibbonMinimizedSummary(state) {
  const ribbonIds = ["setupStrip", "verificationStrip", "nativeActionStrip", "workQueueStrip", "decisionStrip", "handoffStrip"];
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

/** Cheap per-message fingerprint. Streaming chunks land via appendChunk (which
 *  mutates .text directly without a renderMessages pass), so textLen is enough
 *  to catch a structural change like the first chunk flipping a placeholder
 *  card into a text card without forcing a rebuild on every appended token. */
function messageSignature(m) {
  const liveEvents = Array.isArray(m.liveChannelEvents) ? m.liveChannelEvents : [];
  return [
    m.id,
    m.role || "system",
    m.phase || "",
    (m.text || "").length,
    liveEvents.length,
    liveEvents.map((event) => String(event.kind || "") + ":" + liveEventPayloadText(event).length).join(","),
    m.pending ? (m.activity || "running") : "",
    m.error ? "e" : "",
    m.cancelled ? "c" : "",
    m.runFailure ? "f" : ""
  ].join("");
}

function renderSignature() {
  const parts = [];
  for (const m of lastMessages) parts.push(messageSignature(m));
  return parts.join("");
}

function buildMessageArticle(m) {
  const article = document.createElement("article");
  article.dataset.mid = m.id;
  applyMessageArticle(article, m);
  return article;
}

// Rebuild an article's class + inner content from a message. Reused for both
// freshly created and recycled (keyed by mid) nodes so long transcripts skip a
// full relayout — only changed/added/removed cards touch the DOM.
function applyMessageArticle(article, m) {
  const cls = ["message", m.role || "system"];
  if (m.pending) cls.push("pending");
  if (m.error) cls.push("error");
  if (m.cancelled) cls.push("cancelled");
  article.className = cls.join(" ");

  const time = document.createElement("time");
  time.className = "message-time";
  time.textContent = new Date(m.timestamp).toLocaleTimeString();

  const card = document.createElement("div");
  card.className = "message-card";
  const head = document.createElement("div");
  head.className = "message-head";
  const art = document.createElement("span");
  art.className = "head-art " + headColorClass(m.role);
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
  speaker.textContent = agentDisplayName(m.role || "system");
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
  const liveEvents = renderLiveChannelEvents(m.liveChannelEvents);
  if (liveEvents) card.append(liveEvents);
  if (m.runFailure) card.append(renderRunFailureCard(m.runFailure));

  article.replaceChildren(time, card);
}

function renderLiveChannelEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const list = document.createElement("div");
  list.className = "live-channel-events";
  for (const event of events.slice(-50)) list.append(renderLiveChannelEvent(event));
  return list;
}

function renderLiveChannelEvent(event) {
  const payload = event && event.payload && typeof event.payload === "object" ? event.payload : {};
  const item = document.createElement("section");
  item.className = "live-channel-event";
  const status = typeof payload.status === "string" ? payload.status : liveChannelKindLabel(event && event.kind);
  const title = document.createElement("div");
  title.className = "live-channel-title";
  const name = document.createElement("span");
  name.textContent = liveChannelKindLabel(event && event.kind);
  const meta = document.createElement("span");
  meta.textContent = status || "update";
  title.append(name, meta);
  item.append(title);

  const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
  if (summary) {
    const line = document.createElement("div");
    line.className = "live-channel-summary";
    line.textContent = summary;
    item.append(line);
  }

  const outputText = liveEventPayloadText(event);
  if (outputText) {
    const output = document.createElement("pre");
    output.className = "live-channel-output";
    output.textContent = outputText;
    item.append(output);
  } else if (payload.outputFileReadStatus && payload.outputFileReadStatus !== "ok") {
    const line = document.createElement("div");
    line.className = "live-channel-summary muted";
    line.textContent = "output file " + payload.outputFileReadStatus;
    item.append(line);
  }

  if (payload.outputFileTruncated) {
    const truncated = document.createElement("div");
    truncated.className = "live-channel-summary muted";
    truncated.textContent = "output truncated";
    item.append(truncated);
  }
  return item;
}

function liveEventPayloadText(event) {
  const payload = event && event.payload && typeof event.payload === "object" ? event.payload : {};
  return typeof payload.outputFileText === "string" ? payload.outputFileText : "";
}

function liveChannelKindLabel(kind) {
  if (kind === "task_notification") return "agent result";
  if (kind === "task_started") return "agent started";
  if (kind === "task_progress") return "agent progress";
  if (kind === "task_summary") return "agent summary";
  if (kind === "task_updated") return "agent update";
  return "agent event";
}

function renderMessages() {
  const signature = renderSignature();
  // Why: skip the reconcile entirely when nothing structural changed — the
  // host pushes full state on every ticker/usage/status tick, and those must
  // not relayout the transcript.
  if (signature === lastRenderSignature && messagesEl && messagesEl.childElementCount > 0) return;
  lastRenderSignature = signature;

  const scroll = captureMessageScroll();
  if (lastMessages.length === 0) {
    messagesEl.innerHTML = '<p class="empty">The room is quiet. Run Doctor if this is a fresh setup, then type one message below to bring everyone in.</p>';
    restoreMessageScroll(scroll);
    return;
  }

  // Index existing message articles by mid so we can recycle them in place
  // instead of rebuilding the whole list with innerHTML = "".
  const existing = new Map();
  for (const node of messagesEl.querySelectorAll(".message[data-mid]")) {
    existing.set(node.dataset.mid || "", node);
  }

  const ordered = [];
  let lastPhase = "";
  for (const m of lastMessages) {
    if (m.phase && m.phase !== lastPhase) {
      const mark = document.createElement("div");
      mark.className = "phase-mark";
      mark.innerHTML = "<span>" + escapeHtml(m.phase) + "</span>";
      ordered.push(mark);
      lastPhase = m.phase;
    }
    const sig = messageSignature(m);
    const prior = existing.get(m.id);
    if (prior) {
      existing.delete(m.id);
      // Recycle the node; only rebuild its content when its fingerprint moved.
      if (prior.dataset.sig !== sig) {
        applyMessageArticle(prior, m);
        prior.dataset.sig = sig;
      }
      ordered.push(prior);
    } else {
      const article = buildMessageArticle(m);
      article.dataset.sig = sig;
      ordered.push(article);
    }
  }

  // Drop any stale phase-marks/articles, then sync the DOM order to `ordered`.
  // replaceChildren keeps the recycled article nodes' identity (and their
  // scroll position / focus) while reordering and pruning in one pass.
  messagesEl.replaceChildren(...ordered);
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
    runFailureMeta("Transport", card.transport === "terminalBridge" ? "Terminal bridge" : card.transport === "http" ? "HTTP" : "One-shot"),
    runFailureMeta("Prompt", shortSha(card.promptSha256)),
    runFailureMeta("Preview source", runFailurePreviewSourceLabel(card))
  );

  const stderr = document.createElement("pre");
  stderr.className = "run-failure-stderr";
  const diagnosticPreview = card.diagnosticPreview || card.stderrPreview || "";
  stderr.textContent = diagnosticPreview || "No diagnostic output captured";
  if (!diagnosticPreview) stderr.classList.add("muted");

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

function runFailurePreviewSourceLabel(card) {
  if (card.diagnosticPreviewSource === "normalizedReplyOrStdout") return "Normalized reply / stdout";
  if (card.diagnosticPreviewSource === "stderr" || card.stderrPreview) return "stderr";
  return "none";
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
  const label = agentDisplayName(selectedOpener);
  openerBtn.textContent = hasOpenerOverride ? "Opener: " + label + " (this turn)" : "Opener: " + label;
  openerBtn.setAttribute("aria-label", "Choose next opener, currently " + label);
  openerBtn.title = currentRoster.length > 1
    ? "Choose the next configured opener for this turn only"
    : label + " is the only configured opener";
  openerBtn.classList.toggle("suggested", hasOpenerOverride);
}

function nextRosterAgent(agent) {
  if (currentRoster.length < 2) return currentRoster[0] ? currentRoster[0].id : agent;
  const index = currentRoster.findIndex((def) => def.id === agent);
  return currentRoster[(index + 1 + currentRoster.length) % currentRoster.length].id;
}

function agentDisplayName(agent) {
  const def = rosterById[agent];
  return def && def.displayName ? def.displayName : labels[agent] || agent || "Agent";
}

function canAssignRegisteredBuilder(agent) {
  return !!lastState.canAssignBuilder && !!rosterById[agent];
}

function availableActions() {
  const staticActions = ACTIONS.filter((action) => {
    if (action.id === "assign-codex") return currentRoster.some((def) => def.id === "codex");
    if (action.id === "assign-claude") return currentRoster.some((def) => def.id === "claude");
    return true;
  });
  const dynamicBuilders = currentRoster
    .filter((def) => def.id !== "codex" && def.id !== "claude")
    .map((def) => ({
      id: "assign-builder-" + def.id,
      group: "Workflow",
      name: "Assign Builder: " + def.displayName,
      what: "Let " + def.displayName + " edit files",
      run: () => vscode.postMessage({ type: "assignBuilder", builder: def.id }),
      enabled: () => canAssignRegisteredBuilder(def.id)
    }));
  return staticActions.concat(dynamicBuilders);
}

function renderBuilderButtons(canAssignBuilder, suggestedBuilder) {
  const existing = new Map(
    Array.from(builderButtons.querySelectorAll("button[data-builder-id]"))
      .map((button) => [button.dataset.builderId, button])
  );
  const retained = new Set();
  for (const def of currentRoster) {
    let button = existing.get(def.id);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.addEventListener("click", () => {
        const builder = button.dataset.builderId;
        if (builder && rosterById[builder]) vscode.postMessage({ type: "assignBuilder", builder });
      });
    }
    button.dataset.builderId = def.id;
    button.textContent = "Assign Builder: " + def.displayName;
    button.setAttribute("aria-label", "Assign " + def.displayName + " as the builder");
    button.classList.toggle("suggested", suggestedBuilder === def.id);
    button.disabled = !canAssignBuilder;
    builderButtons.append(button);
    retained.add(def.id);
  }
  for (const [id, button] of existing) {
    if (!retained.has(id)) button.remove();
  }
  builderButtons.classList.toggle("hidden", !canAssignBuilder || currentRoster.length === 0);

  const canAssignAll = canAssignBuilder && currentRoster.length > 1;
  assignBothBtn.classList.toggle("hidden", !canAssignAll);
  assignBothBtn.disabled = !canAssignAll;
  assignBothBtn.textContent = currentRoster.length === 2
    ? "Assign Builders: Both"
    : "Assign Builders: All " + currentRoster.length + " Heads";
  assignBothBtn.setAttribute("aria-label", "Assign all configured Hydra heads as parallel builders");
  assignBothBtn.title = "Assign all configured Hydra heads as parallel builders";
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
  const nodes = currentRoster.map((def) => renderAgentStatus(def, statuses && statuses[def.id]));
  agentStatusRail.replaceChildren(...nodes);
}
function renderAgentStatus(def, status) {
  const el = document.createElement("span");
  const state = ["idle", "running", "replied", "error"].includes(status && status.state) ? status.state : "idle";
  const detail = status && status.detail ? status.detail : "Idle";
  el.className = "agent-status " + headColorClass(def.id) + " " + state;
  el.dataset.agentId = def.id;
  el.setAttribute("role", "listitem");
  el.title = def.displayName + ": " + detail;
  el.textContent = def.displayName + ": " + compactStatusDetail(detail);
  announceAgentTransition(def.id, def.displayName, state, detail);
  return el;
}
function announceAgentTransition(agent, label, state, detail) {
  const prev = lastAnnouncedActivity.get(agent);
  lastAnnouncedActivity.set(agent, state);
  if (state === prev) return;
  if (state === "running") announce(label + " is working: " + compactStatusDetail(detail));
  else if (state === "replied") announce(label + " replied.");
  else if (state === "error") announce(label + " failed: " + compactStatusDetail(detail));
}
function renderAuthorityBadges(summaries) {
  const nodes = currentRoster.map((def) => renderAuthorityBadge(def, summaries && summaries[def.id]));
  authorityRail.replaceChildren(...nodes);
}
function renderAuthorityBadge(def, summary) {
  const el = document.createElement("span");
  const authority = summary && summary.authority ? summary.authority : { level: "unknown", label: "Unknown/custom", detail: "No authority data yet" };
  const profile = summary && summary.profile ? summary.profile : { label: "Custom" };
  const level = ["readOnly", "workspaceWrite", "fullNative", "unknown"].includes(authority.level) ? authority.level : "unknown";
  el.className = "authority-badge " + level;
  el.dataset.agentId = def.id;
  el.setAttribute("role", "listitem");
  el.title = def.displayName + ": " + (authority.label || "Unknown/custom") + " / " + (profile.label || "Custom") + "\n" + (authority.detail || "") + "\nProfile: " + (profile.detail || profile.label || "Custom");
  const value = document.createElement("span");
  value.className = "rail-value";
  const name = document.createElement("strong");
  name.textContent = def.displayName;
  value.append(name, document.createTextNode(" " + compactAuthority(authority, profile)));
  el.append(value);
  return el;
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
  const summary = state.autopilotSummary || "Not run";
  const summaryNeedsAttention = /fail|error|missing|not found|unavailable|blocked|needs attention/i.test(summary);
  const showSetup = !!state.autopilotRunning || !!state.needsCodexPath || !!state.needsClaudePath || summaryNeedsAttention;
  setupStrip.classList.toggle("hidden", !showSetup);
  autopilotText.textContent = state.autopilotRunning ? summary + "..." : summary;
  fixCodexBtn.classList.toggle("hidden", !state.needsCodexPath);
  fixClaudeBtn.classList.toggle("hidden", !state.needsClaudePath);
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
function setInteractiveRailState(element, text, actionLabel) {
  element.textContent = text;
  element.setAttribute("aria-label", text + ". " + actionLabel);
}
function renderStandings(data) {
  if (!standingsRail || !standingsPanelCount || !standingsBoard) return;
  const eventCount = Number(data && data.eventCount) || 0;
  const overall = Array.isArray(data && data.overall) ? data.overall : [];
  const error = data && typeof data.error === "string" ? data.error.trim() : "";
  const mirrorError = data && typeof data.mirrorError === "string" ? data.mirrorError.trim() : "";

  standingsPanelCount.textContent = eventCount + " event" + (eventCount === 1 ? "" : "s") + " / " + overall.length + " head" + (overall.length === 1 ? "" : "s");
  standingsBoard.replaceChildren();

  if (error) {
    setInteractiveRailState(standingsRail, "scoreboard: unavailable", "Open passive Hydra Scoreboard");
    standingsRail.className = "rail-chip warn";
    standingsRail.title = "The private evidence ledger failed validation. Scores are hidden until it is repaired.";
    const message = document.createElement("p");
    message.className = "empty";
    message.textContent = error;
    standingsBoard.append(message);
    return;
  }

  if (mirrorError) {
    const warning = document.createElement("p");
    warning.className = "standing-policy";
    warning.textContent = mirrorError + " The private evidence ledger and in-room standings remain valid.";
    standingsBoard.append(warning);
  }

  if (overall.length === 0) {
    setInteractiveRailState(standingsRail, "scoreboard: unranked", "Open passive Hydra Scoreboard");
    standingsRail.className = "rail-chip";
    standingsRail.title = "No independently adjudicated claims yet. Open the passive evidence scoreboard.";
    const message = document.createElement("p");
    message.className = "empty";
    message.textContent = "No evidence-backed verdicts yet. Record a falsifiable claim only after deterministic verification or explicit human adjudication.";
    standingsBoard.append(message);
    return;
  }

  const ranked = overall.filter((standing) => typeof standing.score === "number" && Number.isFinite(standing.score));
  if (ranked.length > 0) {
    const leader = ranked[0];
    const leaders = ranked.filter((standing) => standing.score === leader.score);
    const leaderEvidence = Math.min(...leaders.map((standing) => Number(standing && standing.counts && (standing.counts.independentRounds ?? standing.counts.independentlyResolved)) || 0));
    const leadersProvisional = leaders.some((standing) => standing.provisional);
    const maturity = leadersProvisional ? "provisional " : "";
    const scoreboardText = leaders.length === 1
      ? "scoreboard: " + maturity + "#1 " + agentDisplayName(leader.agentId) + " " + scorePercent(leader.score)
      : "scoreboard: " + leaders.length + "-way " + maturity + "tie #1 " + scorePercent(leader.score);
    setInteractiveRailState(standingsRail, scoreboardText, "Open passive Hydra Scoreboard");
    standingsRail.className = "rail-chip " + (leadersProvisional ? "warn" : "ok");
    standingsRail.title = "Passive evidence scoreboard only. " + (leadersProvisional ? "Provisional " : "") + (leaders.length === 1 ? "leader" : "joint leaders") + " have at least " + leaderEvidence + " independently resolved round" + (leaderEvidence === 1 ? "" : "s") + "; this never changes native authority or speaking order.";
  } else {
    setInteractiveRailState(standingsRail, "scoreboard: unranked", "Open passive Hydra Scoreboard");
    standingsRail.className = "rail-chip";
    standingsRail.title = "Claims exist, but none has deterministic or human-adjudicated evidence yet.";
  }

  let scoredPosition = 0;
  let visibleRank = 0;
  let previousScore;
  overall.forEach((standing) => {
    const counts = standing && standing.counts ? standing.counts : {};
    const trusted = Number(counts.independentlyResolved) || 0;
    const trustedRounds = Number(counts.independentRounds ?? counts.independentlyResolved) || 0;
    const advisory = Number(counts.advisoryResolved) || 0;
    const scoreable = typeof standing.score === "number" && Number.isFinite(standing.score);
    if (scoreable) {
      scoredPosition += 1;
      if (previousScore === undefined || standing.score !== previousScore) visibleRank = scoredPosition;
      previousScore = standing.score;
    }
    const row = document.createElement("div");
    row.className = "standing-row" + (scoreable && visibleRank === 1 ? " leader" : "");

    const rank = document.createElement("span");
    rank.className = "standing-rank";
    rank.textContent = scoreable ? "#" + visibleRank : "—";

    const identity = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = agentDisplayName(standing.agentId);
    const domains = document.createElement("div");
    domains.className = "standing-meta";
    domains.textContent = Array.isArray(standing.domains) && standing.domains.length > 0
      ? standing.domains.join(" · ")
      : "no scored domains";
    identity.append(name, domains);

    const score = document.createElement("span");
    score.className = "standing-score";
    score.textContent = scorePercent(standing.score);
    score.title = "Wilson lower confidence bound over source-weighted correctness";

    const evidence = document.createElement("div");
    const record = document.createElement("div");
    record.textContent = (Number(counts.trustedCorrect ?? counts.correct) || 0) + "W / " + (Number(counts.trustedPartial ?? counts.partial) || 0) + "P / " + (Number(counts.trustedIncorrect ?? counts.incorrect) || 0) + "L";
    const evidenceMeta = document.createElement("div");
    evidenceMeta.className = "standing-meta";
    evidenceMeta.textContent = trustedRounds + " round" + (trustedRounds === 1 ? "" : "s") + " · " + trusted + " outcome" + (trusted === 1 ? "" : "s") + (advisory ? " · " + advisory + " advisory" : "");
    evidence.append(record, evidenceMeta);

    const maturity = document.createElement("span");
    maturity.className = "standing-meta";
    maturity.textContent = standing.provisional ? "provisional" : "established";
    maturity.title = standing.provisional
      ? "Fewer than five independently resolved rounds"
      : "At least five independently resolved rounds";

    row.append(rank, identity, score, evidence, maturity);
    standingsBoard.append(row);
  });
}
function renderDuels(data) {
  if (!duelsRail || !duelsPanelCount || !duelsBoard) return;
  const eventCount = Number(data && data.eventCount) || 0;
  const active = Array.isArray(data && data.active) ? data.active : [];
  const ratings = Array.isArray(data && data.ratings) ? data.ratings : [];
  const recent = Array.isArray(data && data.recent) ? data.recent : [];
  const activeTotal = Math.max(active.length, Number(data && data.activeTotal) || 0);
  const ratingsTotal = Math.max(ratings.length, Number(data && data.ratingsTotal) || 0);
  const recentTotal = Math.max(recent.length, Number(data && data.recentTotal) || 0);
  const error = data && typeof data.error === "string" ? data.error.trim() : "";
  const mirrorError = data && typeof data.mirrorError === "string" ? data.mirrorError.trim() : "";
  if (agentDuelMode) {
    const enabled = !!(data && data.agentInitiatedEnabled);
    const running = !!(data && data.automationRunning);
    const queued = Math.max(0, Number(data && data.automationQueued) || 0);
    agentDuelMode.textContent = running
      ? "Agent challenges: running"
      : queued > 0
        ? "Agent challenges: " + queued + " queued"
        : enabled
          ? "Agent challenges: enabled"
          : "Agent challenges: paused";
    agentDuelMode.className = "duel-status" + (!enabled ? " warn" : "");
  }
  // Every rated duel increments both participants, so the ratings table's
  // match total is exactly twice the number of rated duels.
  const visibleRatedMatches = Math.floor(ratings.reduce((total, rating) => total + (Number(rating && rating.ratedMatches) || 0), 0) / 2);
  const ratedMatches = Number.isFinite(Number(data && data.ratedDuelCount))
    ? Math.max(0, Math.floor(Number(data.ratedDuelCount)))
    : visibleRatedMatches;

  duelsPanelCount.textContent = activeTotal + " active / " + ratingsTotal + " domain rating" + (ratingsTotal === 1 ? "" : "s") + " / " + eventCount + " event" + (eventCount === 1 ? "" : "s");
  duelsBoard.replaceChildren();

  if (error) {
    setInteractiveRailState(duelsRail, "duels: unavailable", "Open formal Hydra duels");
    duelsRail.className = "rail-chip warn";
    duelsRail.title = "The private duel ledger failed validation. Challenges and ratings are hidden until it is repaired.";
    const message = document.createElement("p");
    message.className = "empty";
    message.textContent = error;
    duelsBoard.append(message);
    return;
  }

  if (active.length > 0) {
    setInteractiveRailState(duelsRail, "duels: " + active.length + " active", "Open formal Hydra duels");
    duelsRail.className = "rail-chip warn";
    duelsRail.title = active.length + " formal duel" + (active.length === 1 ? " is" : "s are") + " waiting for action. Competitive ratings never change Hydra authority.";
  } else if (ratedMatches > 0) {
    setInteractiveRailState(duelsRail, "duels: " + ratedMatches + " rated", "Open formal Hydra duels");
    duelsRail.className = "rail-chip";
    duelsRail.title = "Formal duel history by domain. Ratings never change Hydra authority.";
  } else {
    setInteractiveRailState(duelsRail, "duels: none", "Open formal Hydra duels");
    duelsRail.className = "rail-chip";
    duelsRail.title = "No formal duels yet. Ordinary disagreement is not automatically a duel.";
  }

  if (mirrorError) {
    const warning = document.createElement("p");
    warning.className = "standing-policy";
    warning.textContent = mirrorError + " The private duel ledger and in-room ratings remain valid.";
    duelsBoard.append(warning);
  }

  const activeSection = duelSection("Active duels", active.length + " requiring attention");
  if (active.length === 0) {
    activeSection.body.append(duelEmpty("No active challenges. A reactor or closer head may initiate one consequential, falsifiable challenge; Hydra admits or rejects it automatically."));
  } else {
    active.forEach((duel) => activeSection.body.append(renderDuelCard(duel, true)));
    if (activeTotal > active.length) activeSection.body.append(duelEmpty("Showing " + active.length + " of " + activeTotal + " active duels. Open Audit for the complete history."));
  }
  duelsBoard.append(activeSection.section);

  const ratingSection = duelSection("Domain ratings", ratings.length + " entries");
  if (ratings.length === 0) {
    ratingSection.body.append(duelEmpty("No rated outcomes yet. Void and unresolved duels do not affect ratings."));
  } else {
    const groups = groupDuelRatingsByDomain(ratings);
    groups.forEach((group) => {
      const domainGroup = document.createElement("section");
      domainGroup.className = "duel-rating-domain";
      const groupHead = document.createElement("h5");
      groupHead.className = "duel-section-head";
      groupHead.id = duelHeadingId("duel-domain", group.domain);
      domainGroup.setAttribute("aria-labelledby", groupHead.id);
      const domain = document.createElement("strong");
      domain.textContent = group.domain;
      const count = document.createElement("span");
      count.textContent = group.ratings.length + " ranked head" + (group.ratings.length === 1 ? "" : "s");
      groupHead.append(domain, count);
      domainGroup.append(groupHead);

      const leaderRating = Number(group.ratings[0] && group.ratings[0].rating);
      const leaderCount = group.ratings.filter((rating) => Number(rating && rating.rating) === leaderRating).length;
      let visibleRank = 0;
      let previousRating;
      group.ratings.forEach((rating, index) => {
        const currentRating = Number(rating && rating.rating);
        if (previousRating === undefined || currentRating !== previousRating) visibleRank = index + 1;
        previousRating = currentRating;
        domainGroup.append(renderDuelRating(rating, {
          rank: visibleRank,
          gap: Math.max(0, Math.round(leaderRating - currentRating)),
          jointLeader: visibleRank === 1 && leaderCount > 1,
        }));
      });
      ratingSection.body.append(domainGroup);
    });
    if (ratingsTotal > ratings.length) ratingSection.body.append(duelEmpty("Showing " + ratings.length + " of " + ratingsTotal + " rating rows. Open Audit for the complete table."));
  }
  duelsBoard.append(ratingSection.section);

  const recentSection = duelSection("Recent outcomes", recent.length + " shown");
  if (recent.length === 0) {
    recentSection.body.append(duelEmpty("No completed, declined, or cancelled duels yet."));
  } else {
    recent.forEach((duel) => recentSection.body.append(renderDuelCard(duel, false)));
    if (recentTotal > recent.length) recentSection.body.append(duelEmpty("Showing " + recent.length + " of " + recentTotal + " recent outcomes. Open Audit for the complete history."));
  }
  duelsBoard.append(recentSection.section);
}
function duelSection(title, count) {
  const section = document.createElement("section");
  section.className = "duel-section";
  const heading = document.createElement("h4");
  heading.className = "duel-section-head";
  heading.id = duelHeadingId("duel-section", title);
  section.setAttribute("aria-labelledby", heading.id);
  const name = document.createElement("strong");
  name.textContent = title;
  const meta = document.createElement("span");
  meta.textContent = count;
  heading.append(name, meta);
  const body = document.createElement("div");
  body.className = "duel-section";
  section.append(heading, body);
  return { section, body };
}
function duelHeadingId(prefix, value) {
  const slug = String(value || "section").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return prefix + "-" + (slug || "section");
}
function duelEmpty(text) {
  const message = document.createElement("p");
  message.className = "empty";
  message.textContent = text;
  return message;
}
function renderDuelCard(duel, actionable) {
  const card = document.createElement("article");
  card.className = "duel-card" + (actionable ? " active" : "");

  const header = document.createElement("div");
  header.className = "duel-card-head";
  const chips = document.createElement("div");
  chips.className = "duel-card-head";
  const status = document.createElement("span");
  status.className = "duel-status";
  status.textContent = duelStatusLabel(duel && duel.status);
  const domain = document.createElement("span");
  domain.className = "duel-domain";
  domain.textContent = duelText(duel && duel.domain, "unclassified");
  const rated = document.createElement("span");
  rated.className = "duel-rated";
  const duelStatus = duelText(duel && duel.status, "unknown");
  const hasSharedEvidencePacket = !!(duel && typeof duel.sharedEvidencePacket === "string" && duel.sharedEvidencePacket.trim());
  rated.textContent = duelStatus === "awaiting_acceptance"
    ? "legacy closure pending"
    : duelStatus === "declined" || duelStatus === "cancelled"
      ? "no rating"
      : duel && duel.rated
        ? "rated · full access"
        : "legacy unranked";
  if (!(duel && duel.rated) && duel && duel.ratingIneligibilityReason) rated.title = String(duel.ratingIneligibilityReason);
  if (duel && duel.rated && duel.capabilityPolicy) rated.title = "Capability policy: " + String(duel.capabilityPolicy);
  chips.append(status, domain, rated);
  const duelId = duelText(duel && duel.duelId, "unknown duel");
  const id = document.createElement("span");
  id.className = "duel-meta";
  id.textContent = duelId;
  header.append(chips, id);

  const matchup = document.createElement("div");
  matchup.className = "duel-matchup";
  const challenger = document.createElement("span");
  challenger.textContent = agentDisplayName(duel && duel.challengerId);
  const versus = document.createElement("span");
  versus.className = "duel-meta";
  versus.textContent = "versus";
  const challenged = document.createElement("span");
  challenged.textContent = agentDisplayName(duel && duel.challengedId);
  matchup.append(challenger, versus, challenged);

  const origin = document.createElement("div");
  origin.className = "duel-meta";
  origin.textContent = duel && duel.createdBy === "hydra-runtime"
    ? agentDisplayName(duel.challengerId) + " initiated this challenge from its own room reply · Hydra policy admitted it"
    : "Legacy operator-created challenge";

  const proposition = document.createElement("p");
  proposition.className = "duel-proposition";
  proposition.textContent = duelText(duel && duel.proposition, "No proposition recorded");

  const evidence = document.createElement("div");
  evidence.className = "duel-meta";
  const adjudicator = duel && duel.adjudicatorId ? " by " + agentDisplayName(duel.adjudicatorId) : "";
  evidence.textContent = "Adjudication contract: " + duelText(duel && duel.evidenceContract, "not recorded") + " · " + duelText(duel && duel.adjudicatorType, "unknown") + adjudicator;

  const evidencePacket = document.createElement("details");
  evidencePacket.className = "duel-evidence-packet";
  const evidencePacketSummary = document.createElement("summary");
  evidencePacketSummary.textContent = hasSharedEvidencePacket
    ? "Shared evidence starting brief"
    : "No shared evidence brief · legacy unranked";
  const evidencePacketText = document.createElement("pre");
  evidencePacketText.tabIndex = 0;
  evidencePacketText.setAttribute("aria-label", "Locked shared evidence packet text");
  evidencePacketText.textContent = duelText(
    duel && duel.sharedEvidencePacket,
    "Legacy duel: no shared evidence brief was locked. It cannot enter the current agent-initiated ladder and should be closed.",
  );
  evidencePacket.append(evidencePacketSummary, evidencePacketText);

  const ratingNote = document.createElement("div");
  ratingNote.className = "duel-meta";
  ratingNote.textContent = duelStatus === "awaiting_acceptance"
    ? "Historical operator-created challenge: close it without Elo. New rated challenges originate only from agent discussion turns."
    : duelStatus === "declined" || duelStatus === "cancelled"
      ? ""
      : duel && !duel.rated && duel.ratingIneligibilityReason
        ? "Legacy unranked history: " + String(duel.ratingIneligibilityReason)
        : "";

  const commitmentCount = Math.max(0, Math.min(2, Number(duel && duel.commitmentCount) || 0));
  const safeCommitments = Array.isArray(duel && duel.commitments) && duel.commitments.length === 2 ? duel.commitments : [];
  const commitmentState = document.createElement("div");
  commitmentState.className = "duel-commitment-state";
  commitmentState.textContent = duelStatus === "declined"
    ? "Declined: " + duelText(duel && duel.declineReason, "no reason recorded")
    : duelStatus === "cancelled"
      ? "Cancelled: " + duelText(duel && duel.cancellationReason, "no reason recorded")
      : safeCommitments.length === 2
        ? "Both sealed commitments are recorded and revealed together below."
        : "Sealed commitments: " + commitmentCount + " / 2. Answers remain hidden until both heads have committed.";

  card.append(header, matchup, origin, proposition, evidence, evidencePacket);
  if (ratingNote.textContent) card.append(ratingNote);
  card.append(commitmentState);

  if (safeCommitments.length === 2) {
    const reveal = document.createElement("div");
    reveal.className = "duel-reveal";
    safeCommitments.forEach((commitment) => {
      const answer = document.createElement("div");
      answer.className = "duel-answer";
      const name = document.createElement("strong");
      name.textContent = agentDisplayName(commitment && (commitment.agentId || commitment.headId));
      const text = document.createElement("p");
      text.textContent = duelText(commitment && (commitment.answer ?? commitment.position), "No answer recorded");
      const confidence = document.createElement("div");
      confidence.className = "duel-meta";
      confidence.textContent = duelConfidence(commitment && commitment.confidence);
      const provenance = document.createElement("div");
      provenance.className = "duel-meta";
      const receipt = commitment && commitment.agentReceipt && typeof commitment.agentReceipt === "object" ? commitment.agentReceipt : null;
      const runtime = receipt
        ? [receipt.agentKind, receipt.model, receipt.transport].filter(Boolean).join(" / ")
        : "configured head";
      provenance.textContent = commitment && commitment.captureType === "agent-call"
        ? "Hydra-bound head run · " + runtime + " · " + duelText(commitment.captureRef, "receipt unavailable")
        : "Legacy operator entry · unranked history only";
      if (commitment && commitment.captureType === "agent-call" && receipt && typeof receipt.sharedEvidenceSha256 === "string") {
        provenance.textContent += " · packet " + receipt.sharedEvidenceSha256.slice(0, 12);
        provenance.title = "Shared evidence SHA-256: " + receipt.sharedEvidenceSha256;
      }
      if (receipt && typeof receipt.capabilityPolicy === "string") {
        provenance.textContent += " · " + receipt.capabilityPolicy;
        provenance.title = (provenance.title ? provenance.title + "\n" : "") + "Capability policy: " + receipt.capabilityPolicy;
      }
      answer.append(name, text, confidence, provenance);
      reveal.append(answer);
    });
    card.append(reveal);
  }

  if (duel && duel.resolution) {
    const resolution = document.createElement("div");
    resolution.className = "duel-resolution";
    const outcome = duelOutcomeLabel(duel.resolution.outcome);
    const winner = duel.resolution.winnerId ? " · winner: " + agentDisplayName(duel.resolution.winnerId) : "";
    const rationale = duel.resolution.rationale ? " · " + String(duel.resolution.rationale) : "";
    const rawDeltas = duel.resolution.ratingDeltas && typeof duel.resolution.ratingDeltas === "object"
      ? Object.entries(duel.resolution.ratingDeltas).filter(([, delta]) => Number.isFinite(Number(delta)))
      : [];
    const moved = rawDeltas.some(([, delta]) => Number(delta) !== 0);
    const elo = moved
      ? " / Elo: " + rawDeltas.map(([agentId, delta]) => agentDisplayName(agentId) + " " + (Number(delta) >= 0 ? "+" : "") + Math.round(Number(delta))).join(", ")
      : " / Elo: no change";
    resolution.textContent = "Result: " + outcome + winner + elo + rationale;
    const resolutionEvidence = document.createElement("div");
    resolutionEvidence.className = "duel-meta";
    resolutionEvidence.textContent = "Ruling evidence: "
      + duelText(duel.resolution.source, "human")
      + " by " + agentDisplayName(duel.resolution.adjudicatorId || duel.adjudicatorId)
      + " / " + duelText(duel.resolution.evidenceRef, "reference unavailable");
    card.append(resolution, resolutionEvidence);
  }

  if (actionable && duelId !== "unknown duel") {
    const actions = document.createElement("div");
    actions.className = "duel-card-actions";
    const advance = document.createElement("button");
    advance.type = "button";
    advance.className = "secondary";
    advance.textContent = duelActionLabel(duelStatus, !!(duel && duel.rated));
    const actionHint = duelActionHint(duelStatus, !!(duel && duel.rated));
    if (actionHint) advance.title = actionHint;
    advance.addEventListener("click", () => vscode.postMessage({ type: "advanceDuel", duelId }));
    actions.append(advance);
    if (duelStatus !== "awaiting_acceptance") {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "secondary";
      cancel.textContent = "Cancel Duel";
      cancel.addEventListener("click", () => vscode.postMessage({ type: "cancelDuel", duelId }));
      actions.append(cancel);
    }
    card.append(actions);
  }
  return card;
}
function renderDuelRating(rating, rankInfo) {
  const row = document.createElement("div");
  row.className = "duel-rating-row" + (rankInfo && rankInfo.rank === 1 ? " leader" : "");
  const identity = document.createElement("strong");
  identity.textContent = agentDisplayName(rating && rating.agentId);
  const chase = document.createElement("span");
  chase.className = "duel-rank-chase";
  chase.textContent = rankInfo && rankInfo.rank === 1
    ? (rating && rating.provisional
      ? (rankInfo.jointLeader ? "Joint provisional #1" : "Provisional #1")
      : (rankInfo.jointLeader ? "Joint #1" : "Supreme Head · #1"))
    : "#" + (rankInfo ? rankInfo.rank : "—") + " · " + (rankInfo ? rankInfo.gap : "—") + " Elo to #1";
  chase.title = "Competitive rank for this domain only. It grants no Hydra authority.";
  const value = document.createElement("span");
  value.className = "duel-rating-value";
  value.textContent = Number.isFinite(Number(rating && rating.rating)) ? String(Math.round(Number(rating.rating))) : "—";
  const record = document.createElement("span");
  record.textContent = (Number(rating && rating.wins) || 0) + "W / " + (Number(rating && rating.draws) || 0) + "D / " + (Number(rating && rating.losses) || 0) + "L";
  const maturity = document.createElement("span");
  maturity.className = "duel-meta";
  const matches = Number(rating && rating.ratedMatches) || 0;
  maturity.textContent = (rating && rating.provisional ? "provisional · " : "") + matches + " rated";
  row.append(identity, chase, value, record, maturity);
  return row;
}
function groupDuelRatingsByDomain(ratings) {
  const groups = new Map();
  ratings.forEach((rating) => {
    const domain = duelText(rating && rating.domain, "unclassified");
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(rating);
  });
  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([domain, domainRatings]) => ({
      domain,
      ratings: domainRatings.slice().sort((left, right) => {
        const ratingDifference = Number(right && right.rating) - Number(left && left.rating);
        return ratingDifference || agentDisplayName(left && left.agentId).localeCompare(agentDisplayName(right && right.agentId));
      }),
    }));
}
function duelStatusLabel(value) {
  const normalized = duelText(value, "unknown").replace(/[_-]+/g, " ").trim();
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "Unknown";
}
function duelActionLabel(status, rated) {
  if (status === "awaiting_acceptance") return "Close Legacy Challenge";
  if (status === "awaiting_commitments") return rated
    ? "Resume Agent Automation"
    : "Close Legacy Challenge";
  if (status === "awaiting_reveal") return "Verify Paired Reveal";
  if (status === "awaiting_adjudication") return "Judge Revealed Duel";
  return "Advance Duel";
}
function duelActionHint(status, rated) {
  if (status === "awaiting_commitments" && rated) {
    return "Resume Hydra's automatic private calls to both configured heads. The operator never authors a commitment, and rating never changes Hydra authority.";
  }
  if (status === "awaiting_acceptance" || (status === "awaiting_commitments" && !rated)) {
    return "This historical operator-created duel cannot advance or enter the current ladder. Close it without Elo; future challenges originate from agent discussion turns.";
  }
  return "";
}
function duelOutcomeLabel(value) {
  if (value === "challengerWin" || value === "challenger_win") return "Challenger win";
  if (value === "challengedWin" || value === "challenged_win") return "Challenged head win";
  if (value === "tie") return "Tie";
  if (value === "unresolved") return "Unresolved";
  if (value === "void") return "Void";
  return duelStatusLabel(value || "resolved");
}
function duelConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value ? "Confidence: " + String(value) : "Confidence not recorded";
  const percent = numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
  return "Confidence: " + Math.round(percent) + "%";
}
function duelText(value, fallback) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}
function scorePercent(value) {
  return typeof value === "number" && Number.isFinite(value) ? (value * 100).toFixed(1) + "%" : "—";
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
  // Why cost-first: totalTokens lumps cache reads (billed at ~10% of the
  // input rate) with fresh tokens, so the raw total reads ~4x scarier than
  // what the turn actually cost. "fresh" = input + output + cache writes.
  const fresh = (session.inputTokens || 0) + (session.outputTokens || 0) + (session.cacheCreateTokens || 0);
  usageRail.textContent = "session " + (session.turns || 0) + "t " + costStr + " · " + formatTokens(fresh) + " fresh | 7d " + formatCost(weekCost);
  usageRail.className = "rail-chip " + (Math.max(cost, weekCost) >= 1 ? "warn" : "ok");
  usageRail.title = "Open usage panel. Session cost " + costStr + ": fresh input " + formatTokens(session.inputTokens || 0) + ", output " + formatTokens(session.outputTokens || 0) + ", cache writes " + formatTokens(session.cacheCreateTokens || 0) + "; plus " + formatTokens(session.cacheReadTokens || 0) + " cache reads billed at ~10% of the input rate. Rolling 7-day cost " + formatCost(weekCost) + " (" + formatTokens(week.totalTokens || 0) + " tokens incl. cache).";
  renderUsagePanel(session, week, lastState.recentUsageRecords || []);
}
function renderUsagePanel(u, weekly, records) {
  if (!usagePanelCount || !usageSummary || !usageBoard) return;
  const summary = u || {};
  const week = weekly || {};
  const rows = records || [];
  usagePanelCount.textContent = (summary.turns || 0) + " session turns / " + (week.turns || 0) + " 7d turns";
  usageSummary.innerHTML = "";
  // Why cost-first: cache reads are billed at ~10% of the input rate, so the
  // raw cache-inclusive total is not the headline — cost is. The total stays
  // visible but labeled for what it is.
  usageSummary.append(
    usageStat(formatCost(summary.costUsd || 0), "session cost"),
    usageStat(formatCost(week.costUsd || 0), "7d cost"),
    usageStat(formatTokens(summary.inputTokens || 0), "fresh input"),
    // Why: usageFromCodexSummary folds reasoning into outputTokens already; Claude reports reasoningTokens=0. Adding them here double-counts Codex reasoning.
    usageStat(formatTokens(summary.outputTokens || 0), "output + reasoning"),
    usageStat(formatTokens(summary.cacheReadTokens || 0), "cache read (~10% rate)"),
    usageStat(formatTokens(summary.cacheCreateTokens || 0), "cache write")
  );
  const agents = summary.byAgent || {};
  const usageAgentIds = [];
  const seenAgents = new Set();
  for (const head of currentRoster) {
    if (!head || seenAgents.has(head.id)) continue;
    seenAgents.add(head.id);
    usageAgentIds.push(head.id);
  }
  for (const agentId of Object.keys(agents)) {
    if (seenAgents.has(agentId)) continue;
    seenAgents.add(agentId);
    usageAgentIds.push(agentId);
  }
  for (const agentId of usageAgentIds) {
    usageSummary.append(usageStat(agentUsageLabel(agentId, agents[agentId]), agentDisplayName(agentId)));
  }
  usageSummary.append(
    usageStat(formatTokens(summary.totalTokens || 0), "total incl. cache"),
    usageStat(formatTokens(week.totalTokens || 0), "7d total incl. cache")
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
      cell(record.agent ? agentDisplayName(record.agent) : "unknown"),
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
  const needed = String(decision.decisionNeededFromUser || "").trim();
  const hasUserQuestion = !!needed && !/^(?:none|n\/?a|not needed)$/i.test(needed);
  const needsUser = hasUserQuestion && !accepted;
  decisionStrip.classList.toggle("needs-user", needsUser);
  decisionCount.textContent = count > 0 ? "(" + count + ")" : "";
  decisionDefault.textContent = decision.defaultNextAction || "None";
  decisionRecommendation.textContent = decision.recommendation || "None";
  decisionNeeded.textContent = accepted ? "Decision accepted" : hasUserQuestion ? needed : "No user decision requested";
  decisionBlockers.textContent = decision.blockers || "none";
}
function renderHandoff(pending) {
  handoffStrip.classList.toggle("hidden", !pending);
  if (!pending) {
    lastHandoffKey = null;
    return;
  }
  handoffTitle.textContent = pending.title || "Untitled handoff";
  handoffSource.textContent = pending.source ? " (" + pending.source + ")" : "";
  // Why: only seed the select on a NEW packet -- re-renders (Telegram poll, git
  // refresh, watch events, the turn interval) must not clobber a user override
  // made after the packet arrived but before Confirm.
  const key = [pending.title, pending.source, pending.suggestedAction].join(" ");
  if (key !== lastHandoffKey) {
    lastHandoffKey = key;
    if (pending.suggestedAction) handoffAction.value = pending.suggestedAction;
  }
}
function renderDecisionAction(action, canAccept, accepted, running) {
  const label = accepted ? (running ? "Default Running" : "Default Accepted") : action && action.label ? action.label : "Accept Default";
  const detail = accepted ? "The latest decision default has already been accepted." : action && action.detail ? action.detail : "No default action is available";
  const noAction = !accepted && !canAccept && (!action || action.kind === "none" || /^no default action$/i.test(label));
  acceptDefaultBtn.textContent = label;
  acceptDefaultBtn.title = detail;
  acceptDefaultBtn.disabled = !canAccept;
  acceptDefaultBtn.classList.toggle("suggested", !!canAccept && !accepted);
  acceptDefaultBtn.classList.toggle("hidden", noAction);
}
function renderAutoAdvanceDefaults(enabled) {
  autoAdvanceDefaultsBtn.textContent = enabled ? "Auto-advance safe defaults: On" : "Auto-advance safe defaults: Off";
  autoAdvanceDefaultsBtn.setAttribute("aria-pressed", String(enabled));
  autoAdvanceDefaultsBtn.title = enabled
    ? "Turn off automatic advancement of safe, unblocked decision defaults"
    : "Turn on automatic advancement of safe, unblocked decision defaults";
}
function renderDecisionBoard(decisions) {
  decisionPanelCount.textContent = decisions.length + " decisions";
  decisionBoard.classList.toggle("hidden", decisions.length === 0);
  decisionBoard.innerHTML = "";
  for (const decision of decisions) {
    const row = document.createElement("div");
    row.className = "decision-row";
    row.append(cell(agentDisplayName(decision.agent) + (decision.phase ? " / " + decision.phase : "")), cell("Next: " + (decision.defaultNextAction || "none")), cell("Needs: " + (decision.decisionNeededFromUser || "none")), cell("Blockers: " + (decision.blockers || "none")));
    decisionBoard.append(row);
  }
}
function pendingPlaceholder(message) {
  const speaker = agentDisplayName(message.role);
  if (message.phase === "opener") return speaker + " is starting the opener...";
  if (message.phase === "reactor") return speaker + " is reading and reacting...";
  if (message.phase === "closer") return speaker + " is closing the loop...";
  if (message.phase === "parallel") return speaker + " is running an independent pass...";
  if (message.phase === "build") return speaker + " is starting the build...";
  if (message.phase === "review") return speaker + " is reviewing the diff...";
  return speaker + " is starting...";
}

// Tab-focus trap helpers. When a dialog is open, Tab/Shift+Tab cycle through
// the visible focusable controls inside it instead of escaping to the page.
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
function focusEl(el) {
  if (el && typeof el.focus === "function") el.focus();
}
function dialogFocusables(dialog) {
  if (!dialog) return [];
  return Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el) => {
    // Skip controls hidden by an inactive panel-view or the .hidden helper.
    return el.offsetParent !== null || el === document.activeElement;
  });
}
function activeDialog() {
  if (cmdOverlay.dataset.open === "true") return document.getElementById("commandCenter");
  if (panelOverlay.dataset.open === "true") return panelOverlay.querySelector(".inspector");
  return null;
}
function trapDialogTab(event) {
  if (event.key !== "Tab") return;
  const dialog = activeDialog();
  if (!dialog) return;
  const focusables = dialogFocusables(dialog);
  if (focusables.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (event.shiftKey) {
    if (active === first || !dialog.contains(active)) {
      event.preventDefault();
      focusEl(last);
    }
  } else if (active === last || !dialog.contains(active)) {
    event.preventDefault();
    focusEl(first);
  }
}
// Restore focus to the control that opened the dialog (falls back to the
// Commands button). Cleared after use so a stale node never gets focus.
function restoreDialogFocus() {
  const target = dialogRestoreFocus && document.contains(dialogRestoreFocus) ? dialogRestoreFocus : commandCenterBtn;
  dialogRestoreFocus = null;
  focusEl(target);
}

function openPalette() {
  dialogRestoreFocus = document.activeElement;
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
  restoreDialogFocus();
}
function openPanel(panel) {
  dialogRestoreFocus = document.activeElement;
  panelOverlay.dataset.panel = panel;
  panelOverlay.dataset.open = "true";
  panelOverlay.setAttribute("aria-hidden", "false");
  const dialog = panelOverlay.querySelector(".inspector");
  const activeView = Array.from(panelOverlay.querySelectorAll(".panel-view")).find((view) => view.dataset.view === panel);
  const heading = activeView && activeView.querySelector(".insp-head h3");
  if (dialog) dialog.setAttribute("aria-label", heading && heading.textContent ? heading.textContent.trim() : "Hydra inspector");
  // Move focus into the inspector so keyboard/SR users land inside the dialog.
  setTimeout(() => {
    const focusables = dialogFocusables(dialog);
    focusEl(focusables[0] || dialog || panelOverlay);
  }, 0);
}
function closePanel() {
  panelOverlay.dataset.open = "false";
  panelOverlay.setAttribute("aria-hidden", "true");
  restoreDialogFocus();
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
  if (event.key === "Tab" && (paletteOpen || panelOpen)) {
    trapDialogTab(event);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    paletteOpen ? closePalette() : openPalette();
    return;
  }
  if (event.key === "Escape") {
    if (panelOpen) { closePanel(); return; }
    if (paletteOpen) { closePalette(); return; }
    if (lastState.canStop && !stopBtn.disabled && !stopBtn.classList.contains("hidden")) {
      event.preventDefault();
      stopBtn.click();
      return;
    }
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
  const sorted = availableActions().filter((action) => fuzzyMatch(q, action.name + " " + action.what + " " + action.group));
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
  if (lastState.canAssignBuilder && action.id.indexOf("assign-") === 0) return true;
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
  if (action.id === "choose-model" || action.id === "choose-effort" || action.id === "toggle-many-heads" || action.id === "many-heads-workers" || action.id === "test-telegram" || action.id === "open-objective" || action.id === "open-agent-calls" || action.id === "clean-workspace-state") return "open a workspace folder first";
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
  const action = availableActions().find((item) => item.id === selected.dataset.actionId);
  if (!action) return;
  action.run();
  closePalette();
}
function headAsset(role) {
  return HEAD_ASSETS[role] || HEAD_ASSETS.system || "";
}
/** Many heads, one body: color comes from the roster's colorIndex (assigned
 *  by src/agentRegistry.ts:assignColorIndexes), never a hardcoded per-model
 *  literal. Falls back to the legacy codex/claude/user/system role classes
 *  when the role isn't in the roster (user/system) or before the first
 *  "state" message populates rosterById, so the CSS ramp still resolves. */
function headColorClass(role) {
  const def = rosterById[role];
  if (def && def.colorIndex) return "head-" + def.colorIndex;
  return role || "system";
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

// Push a message into the polite live region so screen-reader users hear
// agent activity start and reply completion without watching the transcript.
// Re-set the text after clearing so identical consecutive messages still fire.
function announce(text) {
  if (!srAnnounce || !text) return;
  srAnnounce.textContent = "";
  requestAnimationFrame(() => { if (srAnnounce) srAnnounce.textContent = text; });
}

vscode.postMessage({ type: "ready" });
