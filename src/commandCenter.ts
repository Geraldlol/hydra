export type CommandCenterActionId =
  | "openWorkspaceFolder"
  | "stopCurrentTurn"
  | "acceptDefaultDecision"
  | "toggleAutoAdvanceActionableDefaults"
  | "archiveAndClearRoom"
  | "assignCodex"
  | "assignClaude"
  | "assignParallelBuilders"
  | "chooseModel"
  | "chooseEffort"
  | "toggleManyHeadsMode"
  | "configureManyHeadsWorkers"
  | "testTelegram"
  | "changeCapabilityProfile"
  | "requestReview"
  | "handBack"
  | "runVerification"
  | "nativeAction"
  | "pokeBothTerminalsWithDiff"
  | "openObjective"
  | "openLastPrompt"
  | "attachFiles"
  | "cleanWorkspaceState"
  | "openVerification"
  | "openDecisions"
  | "openSessionBrief"
  | "openWikiContext"
  | "runWikiWrapupNow"
  | "openSupportBundle"
  | "captureNativeCapabilities"
  | "captureNativeDataSnapshot"
  | "openNativeActions"
  | "openAgentCalls"
  | "openNativeTerminals"
  | "useTerminalBridge"
  | "useOneShotTransport"
  | "runDoctor"
  | "runAutopilotStart"
  | "runTerminalBridgeSelfTest"
  | "showTerminalBridgeHealth"
  | "showEffectiveAuthority"
  | "fixCodexPath"
  | "fixClaudePath"
  | "resetStuckTurn"
  | "openTranscript";

export interface CommandCenterAction {
  id: CommandCenterActionId;
  label: string;
  description: string;
  detail: string;
}

export interface CommandCenterWikiStatus {
  contextChars: number;
  contextMaxChars: number;
  promptChars: number;
  promptTruncated: boolean;
  promptFiles?: string[];
  rawTurnCount: number;
  lastWrapupDate?: string;
  lastWrapupTitle?: string;
  usageTelemetry?: CommandCenterWikiUsageStatus;
}

export interface CommandCenterWikiUsageStatus {
  sampleSize: number;
  minSampleSize: number;
  warmingUp: boolean;
  citationRate: number;
  mentionRate: number;
  citationReplies: number;
  mentionReplies: number;
}

export interface CommandCenterInput {
  workspaceReady: boolean;
  isWorkspaceTrusted?: boolean;
  canStop: boolean;
  canAcceptDefault: boolean;
  autoAdvanceActionableDefaults: boolean;
  canAssignBuilder: boolean;
  canRequestReview: boolean;
  canHandBack: boolean;
  canRunVerification: boolean;
  canRunWikiWrapup?: boolean;
  canPokeNativeTerminals: boolean;
  needsCodexPath: boolean;
  needsClaudePath: boolean;
  transport: "oneShot" | "terminalBridge";
  workQueueCount: number;
  nativeActionsCount: number;
  manyHeadsMode?: boolean;
  manyHeadsClaudeWorkerCount?: number;
  wikiStatus?: CommandCenterWikiStatus;
}

export function buildCommandCenterActions(input: CommandCenterInput): CommandCenterAction[] {
  if (!input.workspaceReady) {
    return [
      action("openWorkspaceFolder", "Open Folder", "Required", "Choose a project folder so Hydra can write .hydra state and run the native CLIs."),
      ...(input.isWorkspaceTrusted === false ? [] : [
        action(
          "toggleAutoAdvanceActionableDefaults",
          input.autoAdvanceActionableDefaults ? "Turn Off Auto-advance Safe Defaults" : "Turn On Auto-advance Safe Defaults",
          "Workflow",
          "Toggle whether Hydra automatically runs unblocked Decision Packet defaults."
        ),
      ]),
      action("runDoctor", "Run Doctor", "Diagnose", "Show setup checks for the current VS Code window."),
    ];
  }

  const actions: CommandCenterAction[] = [];
  if (input.canStop) {
    actions.push(
      action("stopCurrentTurn", "Stop Current Turn", "Recovery", "Cancel the active agent call or verification run."),
      action("resetStuckTurn", "Reset Stuck Turn", "Recovery", "Cancel pending room bubbles and return control to the user.")
    );
  }
  if (input.canAcceptDefault) {
    actions.push(action("acceptDefaultDecision", "Accept Default Decision", "Work Queue", "Run the latest decision packet's default next action."));
  }
  if (input.canAssignBuilder) {
    actions.push(
      action("assignCodex", "Assign Codex Builder", "Build flow", "Give Codex explicit build authority for the next implementation turn."),
      action("assignClaude", "Assign Claude Builder", "Build flow", "Give Claude explicit build authority for the next implementation turn."),
      action("assignParallelBuilders", "Assign Both Builders", "Build flow", "Dispatch Codex and Claude as parallel room-level Build workers.")
    );
  }
  if (input.canRequestReview) {
    actions.push(action("requestReview", "Request Review", "Build flow", "Ask the non-builder head to review the current diff."));
  }
  if (input.canHandBack) {
    actions.push(action("handBack", "Hand Back To Builder", "Build flow", "Return a rejected review to the other head for another build pass."));
  }
  if (input.canRunVerification) {
    actions.push(action("runVerification", "Run Verification", "Build flow", "Run Hydra's configured check/test command from the workspace root."));
  }
  if (input.needsCodexPath) {
    actions.push(action("fixCodexPath", "Fix Codex Path", "Setup", "Update the configured Codex CLI command."));
  }
  if (input.needsClaudePath) {
    actions.push(action("fixClaudePath", "Fix Claude Path", "Setup", "Update the configured Claude CLI command."));
  }
  if (input.canPokeNativeTerminals) {
    actions.push(
      action("nativeAction", "Native Action...", "Native CLIs", "Pick Codex, Claude, both heads, editor context, or working-tree diff."),
      action("pokeBothTerminalsWithDiff", "Poke Both With Diff", "Native CLIs", "Send one instruction with the current working-tree diff to both native terminals.")
    );
  }

  actions.push(
    action("openObjective", "Open Objective", "State", "Open the pinned room objective file."),
    action("openLastPrompt", "Open Last Prompt", "State", "Open the latest persisted prompt envelope preview."),
    action("attachFiles", "Attach Files", "Composer", "Copy user-selected files into .hydra/attachments for the next room turn."),
    action("cleanWorkspaceState", "Clean Workspace State", "State", "Compact old prompt bodies and delete stale terminal diagnostics from .hydra."),
    action("openVerification", "Open Verification Log", "State", "Open the durable verification result log."),
    action("openDecisions", "Open Decisions", "State", "Open the durable decision packet log."),
    action("openSessionBrief", "Open Session Brief", "State", "Refresh and open the compact room snapshot."),
    action(
      "openWikiContext",
      "Open Wiki Context",
      input.wikiStatus ? wikiStatusDescription(input.wikiStatus) : "State",
      input.wikiStatus ? wikiStatusDetail(input.wikiStatus) : "Open the persistent compiled wiki that Hydra injects into prompts."
    ),
    ...(input.canRunWikiWrapup
      ? [action("runWikiWrapupNow", "Run Wiki Wrapup Now", "State", "Force one wiki wrapup from the latest completed room turn and record diagnostics.")]
      : []),
    action("openSupportBundle", "Open Support Bundle", "Diagnostics", "Refresh and open Doctor, authority, terminal, queue, and recent-action diagnostics."),
    action("chooseModel", "Choose Model", "Settings", "Pick Codex or Claude model overrides."),
    action("chooseEffort", "Choose Thinking Level", "Settings", "Pick Codex reasoning or Claude effort overrides."),
    ...(input.isWorkspaceTrusted === false ? [] : [
      action(
        "toggleManyHeadsMode",
        input.manyHeadsMode ? "Turn Off Claude Worker Fanout" : "Turn On Claude Worker Fanout",
        input.manyHeadsMode ? `Claude Worker Fanout on (${input.manyHeadsClaudeWorkerCount ?? 3} workers)` : "Claude Worker Fanout off",
        "Toggle experimental parallel discussion fanout through local subscription-backed Claude workers."
      ),
      action(
        "configureManyHeadsWorkers",
        "Set Claude Worker Fanout Count",
        `${input.manyHeadsClaudeWorkerCount ?? 3} Claude workers`,
        "Choose how many local subscription-backed Claude workers launch in parallel discussion. These are workers, not independent Hydra head identities."
      ),
    ]),
    action("testTelegram", "Send Test Telegram", "Settings", "Send a Telegram test ping using the configured bot token and chat id."),
    ...(input.isWorkspaceTrusted === false ? [] : [
      action(
        "toggleAutoAdvanceActionableDefaults",
        input.autoAdvanceActionableDefaults ? "Turn Off Auto-advance Safe Defaults" : "Turn On Auto-advance Safe Defaults",
        "Settings",
        "Toggle whether Hydra automatically runs unblocked Decision Packet defaults."
      ),
    ]),
    action("changeCapabilityProfile", "Change Capability Profile", "Settings", "Pick safe, native, review, full-native, or custom CLI profiles."),
    action("captureNativeCapabilities", "Capture Native Capabilities", "Native CLIs", "Snapshot configured Codex and Claude version/help output into .hydra."),
    action("captureNativeDataSnapshot", "Capture Native Data Snapshot", "Native CLIs", "Snapshot redacted Codex/Claude config, plugin, model, state, and session metadata."),
    action("openNativeActions", "Open Native Action Log", `${input.nativeActionsCount} recorded`, "Open the durable direct native action receipt log."),
    action("openAgentCalls", "Open Agent Call Log", "Flight recorder", "Open the durable native dispatch trace with args, timeouts, request files, and stderr previews."),
    action("openNativeTerminals", "Open Native Terminals", "Native CLIs", "Bring the visible Codex and Claude terminals forward."),
    input.transport === "terminalBridge"
      ? action("useOneShotTransport", "Use Safe One-Shot", "Transport", "Switch future agent calls back to direct one-shot process execution.")
      : action("useTerminalBridge", "Use Terminal Bridge", "Transport", "Route future agent calls through visible native terminals after a self-test."),
    action("runTerminalBridgeSelfTest", "Run Bridge Self-Test", "Diagnostics", "Validate terminal bridge logging, replies, and parsing."),
    action("showTerminalBridgeHealth", "Show Bridge Health", "Diagnostics", "Append visible native terminal session health to the room."),
    action("showEffectiveAuthority", "Show Effective Authority", "Diagnostics", "Append current Codex and Claude native authority to the room."),
    action("runDoctor", "Run Doctor", "Diagnostics", "Run workspace, CLI, trust-scope, git, and bridge checks."),
    action("runAutopilotStart", "Retry Autopilot", "Diagnostics", "Re-run startup checks and terminal bridge selection."),
    action("openTranscript", "Open Transcript", input.workQueueCount ? `${input.workQueueCount} queue items` : "History", "Open the full Markdown room transcript."),
    action("archiveAndClearRoom", "Archive Chat", "State", "Archive the current transcript and clear the room window.")
  );

  return actions;
}

function action(
  id: CommandCenterActionId,
  label: string,
  description: string,
  detail: string
): CommandCenterAction {
  return { id, label, description, detail };
}

function wikiStatusDescription(status: CommandCenterWikiStatus): string {
  if (status.contextMaxChars <= 0) return "Wiki disabled";
  const suffix = status.promptTruncated ? " clipped" : "";
  return `Wiki ${status.contextChars}/${status.contextMaxChars} chars${suffix}`;
}

function wikiStatusDetail(status: CommandCenterWikiStatus): string {
  const files = status.promptFiles?.length
    ? `; files ${status.promptFiles.map((file) => file.replace(/^.*\//, "")).join(", ")}`
    : "";
  const prompt = status.contextMaxChars <= 0
    ? "Prompt injection disabled"
    : `Prompt context ${status.promptChars}/${status.contextMaxChars} chars${status.promptTruncated ? " (truncated)" : ""}${files}`;
  const last = status.lastWrapupDate
    ? `last wrapup ${status.lastWrapupDate}${status.lastWrapupTitle ? ` | ${status.lastWrapupTitle}` : ""}`
    : "last wrapup none";
  return `${prompt}; raw turns ${status.rawTurnCount}; ${last}${wikiUsageDetail(status)}. Open the persistent compiled wiki.`;
}

function wikiUsageDetail(status: CommandCenterWikiStatus): string {
  const usage = status.usageTelemetry;
  if (!usage) return "";
  const sample = usage.warmingUp
    ? `signal warming up ${usage.sampleSize}/${usage.minSampleSize}`
    : `signal last ${usage.sampleSize}`;
  return `; ${sample}: citations ${formatPercent(usage.citationRate)} (${usage.citationReplies}), name/path mentions ${formatPercent(usage.mentionRate)} (${usage.mentionReplies})`;
}

function formatPercent(rate: number): string {
  return `${Math.round(Math.max(0, Math.min(1, rate)) * 100)}%`;
}
