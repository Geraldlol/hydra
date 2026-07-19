import type { AgentId } from "./phases";
import type { HandoffAction } from "./handoffInbox";

/**
 * Discriminated union of every message the Hydra webview sends to the
 * extension host. Mirrors the `vscode.postMessage({ type: "..." })`
 * call sites in src/webview.html.ts.
 *
 * Important: this is a TYPE, not a runtime guard. TypeScript trusts
 * the cast but the webview can technically send malformed messages.
 * The handler in panel.ts already wraps untrusted field reads with
 * `?? ""`, `normalizeAgentId(...)`, and `String(...)` defenses;
 * those stay in place even with this type defined. Optional fields
 * here mirror the spots where the runtime code uses a default.
 */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string; opener?: string }
  | { type: "attachFiles" }
  | { type: "clearAttachment"; id?: string }
  | { type: "clearAttachments" }
  | { type: "setObjective"; text: string }
  | { type: "resetObjective" }
  | { type: "stop" }
  | { type: "assignBuilder"; builder: AgentId }
  | { type: "assignParallelBuilders" }
  | { type: "requestReview" }
  | { type: "runVerification" }
  | { type: "openVerification" }
  | { type: "openNativeActions" }
  | { type: "openAgentCalls" }
  | { type: "openWorkspaceChange"; path?: string }
  | { type: "openRunFailureFile"; path?: string }
  | { type: "copyRunFailurePromptSha"; sha?: string }
  | { type: "clearNativeAction"; id?: string }
  | { type: "clearNativeActions"; ids?: string[] }
  | { type: "openObjective" }
  | { type: "openSessionBrief" }
  | { type: "openWikiContext" }
  | { type: "runWikiWrapupNow" }
  | { type: "openSupportBundle" }
  | { type: "captureNativeCapabilities" }
  | { type: "captureNativeDataSnapshot" }
  | { type: "showCommandCenter" }
  | { type: "openBrowser" }
  | { type: "toggleBrowserControl" }
  | { type: "previewNextPrompt"; text?: string; opener?: string }
  | { type: "openLastPrompt" }
  | { type: "cleanWorkspaceState" }
  | { type: "acceptDefaultDecision" }
  | { type: "toggleAutoAdvanceActionableDefaults" }
  | { type: "handBack" }
  | { type: "confirmHandoff"; action?: HandoffAction }
  | { type: "dismissHandoff" }
  | { type: "previewHandoff" }
  | { type: "openTranscript" }
  | { type: "archiveAndClearRoom" }
  | { type: "openDecisions" }
  | { type: "openStandings" }
  | { type: "openScoreEvidence" }
  | { type: "recordScoreVerdict" }
  | { type: "reverseScoreVerdict" }
  | { type: "adjudicatePendingScoreClaim" }
  | { type: "openDuels" }
  | { type: "advanceDuel"; duelId?: string }
  | { type: "cancelDuel"; duelId?: string }
  | { type: "openDuelAudit" }
  | { type: "correctDuelResult" }
  | { type: "chooseModelOrEffort" }
  | { type: "chooseModel" }
  | { type: "chooseEffort" }
  | { type: "toggleManyHeadsMode" }
  | { type: "configureManyHeadsWorkers" }
  | { type: "testTelegram" }
  | { type: "openNativeTerminals" }
  | {
      type: "pokeNativeTerminal";
      agent: AgentId;
      text?: string;
      includeEditorContext?: boolean;
      includeWorkspaceDiff?: boolean;
    }
  | { type: "runNativeCommand"; agent: AgentId; text?: string }
  | { type: "sendRawTerminalLine"; agent: AgentId; text?: string }
  | {
      type: "pokeNativeTerminals";
      text?: string;
      includeEditorContext?: boolean;
      includeWorkspaceDiff?: boolean;
    }
  | { type: "nativeAction"; text?: string }
  | { type: "rerunNativeAction"; id?: string }
  | { type: "discussVerification" }
  | { type: "dismissWorkQueueItem"; id?: string }
  | { type: "snoozeWorkQueueItem"; id?: string }
  | { type: "useTerminalBridge" }
  | { type: "useOneShotTransport" }
  | { type: "runTerminalBridgeSelfTest" }
  | { type: "showTerminalBridgeHealth" }
  | { type: "showEffectiveAuthority" }
  | { type: "changeCapabilityProfile" }
  | { type: "runDoctor" }
  | { type: "runAutopilotStart" }
  | { type: "fixCodexPath" }
  | { type: "fixClaudePath" }
  | { type: "resetStuckTurn" }
  | { type: "openWorkspaceFolder" };

/** All known message types — handy for inspections and the test contract. */
export type WebviewMessageType = WebviewMessage["type"];
