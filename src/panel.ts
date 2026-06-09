import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { runAgent, AgentSpawn, RunResult } from "./agents";
import { parseGitStatusEntries, type WorkspaceChange } from "./gitStatus";
import { State, Event, AgentId, transition, isInFlight, shouldRunParallelDiscussion } from "./phases";
import { Phase, buildPrompt, APPROVED_SENTINEL_RE, SOFT_APPROVAL_RE } from "./prompts";
import {
  appendMessage,
  archiveAndResetTranscript,
  buildPromptContextWindow,
  ensureGitignore,
  ensureTranscriptFile,
  readTranscript,
  TranscriptContextWindow,
  TranscriptMessage,
} from "./transcript";
import {
  argsSettingKey,
  profileForPhase,
  applySpawnEnvironment,
  buildAgentSpawn,
  expandRequestFileSpawn,
  hasRequestFilePlaceholders,
  mergeNativeEnv,
  mergeNativePathPrepend,
  nativeCapabilitySummary,
  resolveAgentCommand,
  splitNativeArgs,
  type CliProfile,
} from "./cli";
import { classifyAgentAuthority, validateNativeArgs, type AuthorityClassification } from "./authority";
import {
  evaluateFullNativeConsent,
  resolveFullNativeConsentChoice,
  fullNativeConsentKey,
  FULL_NATIVE_CONSENT_RUN_ONCE,
  FULL_NATIVE_CONSENT_ALWAYS,
  FULL_NATIVE_CONSENT_CANCEL,
} from "./fullNativeConsent";
import { formatClaudeStreamSummary, parseClaudeEventStream, summarizeClaudeEvents, type ClaudeStreamSummary } from "./claudeEvents";
import { formatCodexThreadSummary, parseCodexEventStream, summarizeCodexEvents } from "./codexEvents";
import {
  argsForCapabilityProfile,
  capabilityProfilePreset,
  capabilityProfileShortLabel,
  configurableCapabilityProfiles,
  describeCapabilityProfile,
  isConfigurableCapabilityProfileId,
  profileSettingKey,
  type CapabilityProfile,
  type ConfigurableCapabilityProfileId,
} from "./capabilityProfiles";
import { buildCommandCenterActions, type CommandCenterActionId, type CommandCenterWikiStatus } from "./commandCenter";
import { shouldAutoSkipCloserOnAgreement } from "./closerSkip";
import { formatElapsed, formatPendingAgentActivity } from "./agentActivity";
import { createLiveTextExtractor } from "./liveText";
import { createLiveChannelWriter, liveChannelPath, type LiveChannelEvent } from "./liveChannel";
import {
  appendDecision,
  decisionHasNoUserBlockers,
  detectRiskySignals,
  isNoneValue,
  DecisionAction,
  DecisionPacket,
  ensureDecisionsFile,
  parseDecisionPacket,
  readDecisions,
  resolveDecisionAction,
} from "./decisions";
import {
  appendNativeAction,
  collectNativeSessionHints,
  ensureNativeActionsFile,
  nativeActionSummary,
  NativeActionReceipt,
  NativeActionStatus,
  readNativeActions,
  writeNativeActions,
} from "./nativeActions";
import {
  nativeCapabilitiesPath,
  readNativeIntegrationSummary,
  renderNativeCapabilitySnapshot,
  shouldIncludeNativeIntegrationSummary,
  writeNativeCapabilities,
  type NativeCapabilityProbe,
} from "./nativeCapabilities";
import {
  collectNativeDataSnapshot,
  nativeDataSnapshotPath,
  renderNativeDataSnapshot,
  writeNativeDataSnapshot,
} from "./nativeDataSnapshot";
import { NATIVE_COMMAND_CATALOG } from "./nativeCommandCatalog";
import {
  formatDoctorReport,
  runHydraDoctor,
  TRUST_SCOPED_SETTINGS,
  trustScopeWarnings,
  type DoctorArgsValidation,
  type DoctorReport,
} from "./doctor";
import { EditorContextAttachment, truncateEditorContext } from "./editorContext";
import { appendHydraEvent, createHydraEvent, ensureHydraEventsFile, hydraEventsPath, readHydraEvents, type HydraEventKind } from "./events";
import { ensureFile, readJsonlGuarded, serializePerFile } from "./fileQueue";
import { detectNativeReplyLeak, formatNativeReplyLeakError } from "./nativeReplyGuard";
import { ensureObjectiveFile, objectiveAsContext, readObjective, writeObjective } from "./objective";
import { TerminalBridge } from "./terminalBridge";
import { buildDirectTerminalPokePrompt } from "./terminalPoke";
import { buildTerminalPromptFile, terminalProtocolPaths } from "./terminalProtocol";
import type { TerminalSession } from "./sessionState";
import {
  appendPromptEnvelope,
  createPromptEnvelope,
  PromptEnvelope,
  readLatestPromptEnvelope,
  renderPromptEnvelopePreview,
} from "./promptPreview";
import { cleanWorkspaceState as cleanWorkspaceStateFiles } from "./workspaceCleanup";
import {
  appendVerification,
  captureGitHead,
  ensureVerificationFile,
  resolveVerificationCommand,
  readVerifications,
  runVerificationCommand,
  verificationAsReviewContext,
  verificationPassed,
  VerificationResult,
  verificationSummary,
} from "./verification";
import { buildWorkQueue, type WorkQueueItem } from "./workQueue";
import {
  addRecordToSummary,
  appendUsageRecord,
  boundUsageRecords,
  buildUsageRecord,
  claudeAutomationSpendThisMonth,
  coerceModelPrices,
  DEFAULT_PRICES,
  loadUsageRecords,
  parseCodexTextTokens,
  resolveModelPrices,
  summarizeUsage,
  usageCutoffIso,
  usageFromClaudeSummary,
  usageFromCodexSummary,
  type ModelPrices,
  type UsageRecord,
  type UsageSummary,
} from "./usage";
import {
  loadCodexModelsSnapshot,
  type CodexModelsSnapshot,
} from "./codexModels";
import { chooseEffortInteractively } from "./effortChooser";
import { chooseModelInteractively, refreshCodexModelCatalog, type ModelChooserDeps } from "./modelChooser";
import { effectivePhasedNumberSetting, summarizePhasedSetting } from "./phasedSetting";
import {
  agentTimeoutMs,
  attachmentMaxBytes,
  attachmentPreviewMaxChars,
  attachmentTotalMaxBytes,
  autoAdvanceActionableDefaults,
  autoAdvanceSendInstructionMaxConsecutive,
  autopilotOnStart,
  autoRequestReviewAfterPassingVerification,
  autoSkipCloserOnAgreement,
  autoVerifyAfterBuild,
  claudeAgentCreditCapUsd,
  claudeAgentEstimatedRunCostUsd,
  claudeAutomationCreditGuard,
  diagnosticRetentionDays,
  diffMaxLines,
  discussionMode,
  editorContextMaxChars,
  preferTerminalBridgeOnStart,
  promptBodyRetentionDays,
  manyHeadsMode,
  manyHeadsClaudeWorkerCount,
  sessionCostCapUsd,
  telegramConfig,
  terminalBridgeTimeoutMs,
  terminalBridgeWorkspaceInstructionsMaxChars,
  verificationMaxOutputChars,
  verificationTimeoutMs,
  wikiContextMaxChars,
  wikiPromptIncludeLog,
  wikiRawTurnsKeepDays,
  wikiWrapupEnabled,
  wikiWrapupMaxSourceChars,
  wikiWrapupTimeoutMs,
} from "./roomSettings";
import { modelForPhase, withEffortArgs, withModelArgs } from "./agentArgs";
import {
  CLAUDE_AUTH_STATUS_PROBE_ARGS,
  evaluateClaudeAutomationGuard,
  parseClaudeAuthStatus,
  type ClaudeAuthStatus,
  type ClaudeAutomationGuardResult,
} from "./claudeAuth";
import {
  appendClaudeWorkerAssignment,
  buildParallelDiscussionWorkers,
  claudeWorkerTraceIds,
} from "./claudeWorkers";
import {
  appendManyHeadsSmokeReport,
  buildManyHeadsSmokeReport,
  ensureManyHeadsSmokeFile,
  formatManyHeadsSmokeReport,
  isManyHeadsSmokeAgentCall,
  manyHeadsSmokePath,
  type ManyHeadsSmokeAgentCall,
  type ManyHeadsSmokeLiveFile,
} from "./manyHeadsSmoke";
import type { WebviewMessage } from "./webviewMessages";
import {
  attachmentDisplaySummary,
  prepareRoomAttachment,
  renderRoomAttachmentsForPrompt,
  roomAttachmentSummaries,
  type PendingRoomAttachment,
} from "./attachments";
import {
  shouldCaptureCodexLastMessage,
  shouldUseCodexJson,
  withCodexJsonArgs,
  withCodexLastMessageArgs,
  withCodexSkipGitRepoCheckArgs,
} from "./codexTransport";
import {
  shouldCreateClaudeRequestFiles,
  shouldUseClaudeStreamJson,
  withClaudeStreamJsonArgs,
} from "./claudeTransport";
import {
  TelegramController,
  formatTelegramInboundPrompt,
  type TelegramInboundTurnOutcome,
} from "./telegramController";
import { readWorkspaceInstructions, workspaceInstructionsAsContext } from "./workspaceInstructions";
import {
  appendWorkQueueDisposition,
  applyWorkQueueDispositions,
  ensureWorkQueueStateFile,
  readWorkQueueDispositions,
  type WorkQueueDisposition,
} from "./workQueueState";
import { summarizeHydraWikiUsage, summarizeHydraWikiUsageEvents } from "./wikiTelemetry";
import {
  applyHydraWikiWrapupDraft,
  buildHydraWikiWrapupPrompt,
  ensureHydraWikiFiles,
  hydraWikiContextRefreshSourceFromMessages,
  hydraWikiContextPath,
  hydraWikiWrapupSourceFromMessages,
  hydraWikiWrapupSourcePath,
  parseHydraWikiWrapupResponse,
  pruneHydraWikiRawTurns,
  readHydraWikiFiles,
  readHydraWikiPromptContext,
  readHydraWikiStatus,
  type HydraWikiWrapupSource,
  writeHydraWikiWrapupSource,
} from "./hydraWiki";
import { renderSessionBrief, sessionBriefPath, writeSessionBrief } from "./sessionBrief";
import {
  renderSupportBundle,
  supportBundlePath,
  supportBundleNativeDataSummary,
  writeSupportBundle,
  type SupportBundleNativeRuntime,
} from "./supportBundle";
import type { HydraStatusBarSnapshot } from "./statusBar";
import { renderHtml, type HydraHeadAssets } from "./webview.html";
import {
  createRunFailureCard,
  isSafeRunFailureRequestPath,
  type RunFailureCard,
  type RunFailureRequestFileKind,
} from "./runFailureCard";

interface UiMessage extends TranscriptMessage {
  id: string;
  pending?: boolean;
  activity?: string;
  runFailure?: RunFailureCard;
  liveChannelEvents?: LiveChannelEvent[];
}

interface PromptContextSnapshot {
  text: string;
  transcriptWindow: PromptTranscriptWindowStats;
}

interface PromptTranscriptWindowStats {
  cap: number;
  originalChars: number;
  keptChars: number;
  omittedMessages: number;
  omittedChars: number;
  truncated: boolean;
}

const AGENT_NAMES: Record<AgentId, string> = { codex: "Codex", claude: "Claude" };
// Why: skip the per-append mkdir(recursive) syscall on the agent-call trace
// once its parent .hydra/ dir is known to exist. First write still creates it.
const ensuredAgentCallDirs = new Set<string>();

// Keep only the well-formed (finite, non-negative) price fields the user
// actually supplied so the override stays partial — resolveModelPrices fills
// any omitted/dropped field from the correct per-model/per-agent base.
function sanitizePartialModelPrices(v: Partial<ModelPrices>): Partial<ModelPrices> {
  const out: Partial<ModelPrices> = {};
  const keys = ["inputPerMTok", "outputPerMTok", "cacheReadPerMTok", "cacheCreatePerMTok"] as const;
  for (const key of keys) {
    const n = v[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}
const PROMPT_TRANSCRIPT_MAX_CHARS_DEFAULTS = {
  discussion: 80000,
  build: 400000,
  review: 400000,
} as const;
const ONE_SHOT_WORKSPACE_INSTRUCTIONS_MAX_CHARS_DEFAULTS = {
  discussion: 12000,
  build: 12000,
  review: 12000,
} as const;

function promptTranscriptScope(phase: Phase): "discussion" | "build" | "review" {
  if (phase === "build") return "build";
  if (phase === "review") return "review";
  return "discussion";
}

// Surfaced when a code path tries to use the native terminal bridge before
// it has initialized (panel just opened, workspace not trusted, etc.). One
// shared phrasing so the three call sites stay in sync and the user always
// sees an actionable next step (reopen panel or fall back to one-shot).
const TERMINAL_BRIDGE_NOT_READY =
  "Native terminal action unavailable: terminal bridge has not started. " +
  "Reopen the Hydra panel, or run \"Hydra: Use One-Shot Transport\" (Command Palette) to bypass the bridge.";

function isClaudeTaskLiveEvent(event: LiveChannelEvent): boolean {
  return event.agent === "claude" && typeof event.kind === "string" && event.kind.startsWith("task_");
}

type AgentStatusState = "idle" | "running" | "replied" | "error";
interface AgentStatus {
  state: AgentStatusState;
  detail: string;
}

interface AgentAuthoritySummary {
  authority: AuthorityClassification;
  profile: CapabilityProfile;
}

interface NativeTerminalPokeOptions {
  includeEditorContext?: boolean;
  includeWorkspaceDiff?: boolean;
}

interface WikiWrapupOptions {
  force?: boolean;
  manual?: boolean;
  sourceOverride?: HydraWikiWrapupSource;
}

interface NativeActionPick extends vscode.QuickPickItem {
  plainLabel: string;
  agents: AgentId[];
  options: NativeTerminalPokeOptions;
  actionKind: "prompt" | "command" | "rawLine";
  presetLine?: string;
}

interface PreparedOneShotSpawn {
  spawn: AgentSpawn;
  promptPath?: string;
  replyPath?: string;
  logPath?: string;
  outputMode: "plain" | "claudeStreamJson" | "codexJson";
}

interface QueuedUserMessage {
  displayText: string;
  promptText: string;
  opener: AgentId;
  timestamp: string;
  telegramChatId?: string;
}

interface PreparedRoomMessage {
  displayText: string;
  promptText: string;
}

// SSRF block-list for handoff webhook destinations. Hostnames are compared
// case-insensitive; numeric IPv4 ranges cover RFC1918, loopback, link-local,
// and cloud metadata services. This is best-effort — DNS rebinding can still
// resolve a public name to a private IP at request time; the fetch's
// redirect: "error" option closes that hop. If a user genuinely needs an
// internal webhook target, they can route it through an https proxy with a
// public hostname.
export function isBlockedWebhookHost(hostname: string): boolean {
  if (!hostname) return true;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "0.0.0.0" || host === "::" || host === "::1") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === "169.254.169.254" || /^169\.254\./.test(host)) return true;
  if (host === "metadata.google.internal" || host === "metadata") return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (/^fe80:/i.test(host) || /^fc[0-9a-f]{2}:/i.test(host) || /^fd[0-9a-f]{2}:/i.test(host)) return true;
  return false;
}

// Strip control chars and prompt-injection markers from network-attacker-
// controlled error strings before they land in transcript.md (which feeds
// back into agent prompts on the next turn).
export function sanitizeWebhookError(message: string): string {
  return message
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/<\/?system[^>]*>/gi, "[redacted-tag]")
    .replace(/```/g, "`​``")
    .slice(0, 300);
}

// Re-exported from telegramController.ts (the Telegram cluster's new home) so
// existing test imports of `formatTelegramInboundPrompt` from src/panel keep
// working after the extraction.
export { formatTelegramInboundPrompt };

export class HydraRoomPanel {
  private static readonly viewType = "hydraRoom.panel";
  private static instance: HydraRoomPanel | undefined;
  private static statusBarUpdater: ((snapshot: HydraStatusBarSnapshot) => void) | undefined;

  private readonly context: vscode.ExtensionContext;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private state: State = { name: "Idle" };
  private messages: UiMessage[] = [];
  // Why: O(1) id->message index for the streaming hot path (per-stdout-chunk
  // lookups in runAgentTransport). this.messages stays the source of truth for
  // order/serialization; this map is a pure index kept in sync at every
  // append/replace/clear site. Mutate both together via setMessages/pushMessage.
  private messagesById = new Map<string, UiMessage>();
  private readonly pendingRunFailures = new Map<string, RunFailureCard>();
  private readonly pendingPromptTranscriptWindows = new Map<string, PromptTranscriptWindowStats>();
  private wikiWrapupInFlight = false;
  private lastWikiWrapupSourceKey: string | undefined;
  private lastWikiRefreshTranscriptBucket = 0;
  private wikiMaintenanceQueue: Promise<void> = Promise.resolve();
  // Why: background wiki maintenance runs off the turn critical path, so it is
  // NOT covered by currentAbort (which the turn-runner clears once the room
  // turn settles). Give it a dedicated controller so Stop/archive/reset/dispose
  // can terminate an in-flight wiki call instead of letting it run to
  // wikiWrapupTimeoutMs and bill the session cost cap.
  private wikiMaintenanceAbort: AbortController | undefined;
  private transcriptUri!: vscode.Uri;
  private objectiveUri!: vscode.Uri;
  private decisionsUri!: vscode.Uri;
  private verificationUri!: vscode.Uri;
  private nativeActionsUri!: vscode.Uri;
  private eventsUri!: vscode.Uri;
  private agentCallsUri!: vscode.Uri;
  private manyHeadsSmokeUri!: vscode.Uri;
  private nativeCapabilitiesUri!: vscode.Uri;
  private nativeDataSnapshotUri!: vscode.Uri;
  private workQueueUri!: vscode.Uri;
  private sessionBriefUri!: vscode.Uri;
  private wikiContextUri!: vscode.Uri;
  private supportBundleUri!: vscode.Uri;
  private telegramInboundStateUri!: vscode.Uri;
  private objective = "";
  private workspaceInstructions = "";
  private workspaceInstructionsByAgent: Record<AgentId, string> = { codex: "", claude: "" };
  private decisions: DecisionPacket[] = [];
  private acceptedDefaultDecisionTimestamp: string | undefined;
  private verifications: VerificationResult[] = [];
  private nativeActions: NativeActionReceipt[] = [];
  private workQueueDispositions: WorkQueueDisposition[] = [];
  private latestDoctorReport: DoctorReport | undefined;
  private queuedUserMessages: QueuedUserMessage[] = [];
  private pendingAttachments: PendingRoomAttachment[] = [];
  private drainingQueuedUserMessages = false;
  private verificationRunning = false;
  private autopilotRunning = false;
  private autopilotSummary = "Not run";
  private terminalPokeInFlight = false;
  private workspaceRoot!: string;
  private workspaceReady = false;
  private currentAbort: AbortController | undefined;
  // Why: a monotonic counter bumped each time a user Stop actually aborts an
  // in-flight turn. The Telegram inbound path snapshots it before dispatching a
  // turn and re-reads it after, so it can skip the auto-reply when the user
  // cancelled mid-turn (rather than replying about a cancelled/partial turn).
  private stopRequestCount = 0;
  private suggestedBuilder: AgentId | undefined;
  private autoAdvanceSendInstructionCount = 0;
  private autoAdvanceInProgress = false;
  private usageUri!: vscode.Uri;
  private readonly sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  private usageRecords: UsageRecord[] = [];
  private sessionUsage: UsageSummary | undefined;
  private weeklyUsage: UsageSummary | undefined;
  // Claude Agent SDK credit guard (Slice 3): the sanitized auth probe result is
  // cached for the session (auth class rarely changes mid-session), and the
  // over-cap warning fires once so warn mode does not spam every Claude turn.
  private claudeAuthStatus: ClaudeAuthStatus | undefined;
  private claudeAuthStatusPromise: Promise<ClaudeAuthStatus | undefined> | undefined;
  // Pre-dispatch estimate for Claude calls currently in flight. This is not a
  // billing ledger; usageRecords remain authoritative once each call completes.
  private claudeCreditReservedUsd = 0;
  private claudeCreditWarned = false;
  private codexModelsUri!: vscode.Uri;
  private codexModelsSnapshot: CodexModelsSnapshot | undefined;
  private terminalBridge: TerminalBridge | undefined;
  private transport: "oneShot" | "terminalBridge" = "oneShot";
  // Owns the Telegram inbound poll loop and outbound notify/test/reply paths
  // (extracted from this god-object). Constructed in the constructor (after the
  // sessionId field initializer has run); its deps read panel state through
  // closures so the lazily-set .hydra paths resolve at call time.
  private readonly telegram: TelegramController;
  private agentStatuses: Record<AgentId, AgentStatus> = {
    codex: { state: "idle", detail: "Idle" },
    claude: { state: "idle", detail: "Idle" },
  };
  private gitAvailable = false;
  private workspaceChanges: WorkspaceChange[] = [];
  private workspaceChangesRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly initPromise: Promise<void>;

  static open(context: vscode.ExtensionContext): HydraRoomPanel {
    if (HydraRoomPanel.instance) {
      HydraRoomPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      return HydraRoomPanel.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      HydraRoomPanel.viewType,
      "Hydra Room",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    HydraRoomPanel.instance = new HydraRoomPanel(context, panel);
    return HydraRoomPanel.instance;
  }

  static current(): HydraRoomPanel | undefined {
    return HydraRoomPanel.instance;
  }

  static setStatusBarUpdater(updater: ((snapshot: HydraStatusBarSnapshot) => void) | undefined): void {
    HydraRoomPanel.statusBarUpdater = updater;
  }

  ready(): Promise<void> {
    return this.initPromise;
  }

  private hydraHeadAssets(): HydraHeadAssets {
    const head = (name: string) =>
      this.panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "media", "hydra-heads", `${name}.png`)
      ).toString();
    return {
      cspSource: this.panel.webview.cspSource,
      brand: head("guard"),
      codex: head("codex"),
      claude: head("claude"),
      system: head("system"),
      user: head("user"),
    };
  }

  private constructor(context: vscode.ExtensionContext, panel: vscode.WebviewPanel) {
    this.context = context;
    this.panel = panel;
    this.telegram = new TelegramController({
      sessionId: this.sessionId,
      workspaceRoot: () => this.workspaceRoot,
      isWorkspaceReady: () => this.workspaceReady,
      telegramInboundStateFsPath: () => this.telegramInboundStateUri.fsPath,
      getFirstSpeaker: () => this.getFirstSpeaker(),
      getMessages: () => this.messages,
      appendSystemMessage: (text) => this.appendSystemMessage(text),
      recordEvent: (kind, detail, data) => this.recordEvent(kind, detail, data),
      postState: () => this.postState(),
      ready: () => this.ready(),
      sendInboundUserMessage: (text, opener, options) => this.sendInboundUserMessage(text, opener, options),
    });
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    };
    const scriptUri = this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.js"))
      .toString();
    this.panel.webview.html = renderHtml(makeNonce(), this.hydraHeadAssets(), scriptUri);
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m) => void this.onWebviewMessage(m)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("hydraRoom.telegram")) {
          void this.telegram.restartInboundPolling();
        }
      })
    );
    this.initPromise = this.initialize();
  }

  dispose(): void {
    HydraRoomPanel.instance = undefined;
    if (this.workspaceChangesRefreshTimer) {
      clearTimeout(this.workspaceChangesRefreshTimer);
      this.workspaceChangesRefreshTimer = undefined;
    }
    this.currentAbort?.abort();
    this.wikiMaintenanceAbort?.abort();
    this.telegram.dispose();
    // TerminalBridge is constructed inside initialize() so it isn't in the
    // disposables array. Dispose explicitly to close cached terminals
    // (otherwise they accumulate as ghost terminals across panel reopens).
    this.terminalBridge?.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private async initialize(): Promise<void> {
    const workspaceRoot = resolveWorkspaceRoot(this.context);
    if (!workspaceRoot) {
      this.workspaceReady = false;
      this.setMessages([{
        id: "system-no-workspace",
        role: "system",
        text: "Hydra needs a project folder so it can write `.hydra/transcript.md` and run Codex/Claude from the project root. Click Open Folder, choose your project, then run Hydra: Start again.",
        timestamp: new Date().toISOString(),
      }]);
      this.postState();
      return;
    }

    this.workspaceReady = true;
    this.workspaceRoot = workspaceRoot;
    await this.migrateLegacyAgentTimeoutDefaults();
    this.terminalBridge = this.createTerminalBridge();
    this.transcriptUri = this.resolveTranscriptUri();
    this.objectiveUri = vscode.Uri.file(path.join(this.workspaceRoot, ".hydra", "objective.md"));
    this.decisionsUri = vscode.Uri.file(path.join(this.workspaceRoot, ".hydra", "decisions.jsonl"));
    this.verificationUri = vscode.Uri.file(path.join(this.workspaceRoot, ".hydra", "verification.jsonl"));
    this.nativeActionsUri = vscode.Uri.file(path.join(this.workspaceRoot, ".hydra", "native-actions.jsonl"));
    this.eventsUri = vscode.Uri.file(hydraEventsPath(this.workspaceRoot));
    this.agentCallsUri = vscode.Uri.file(path.join(this.workspaceRoot, ".hydra", "agent-calls.jsonl"));
    this.manyHeadsSmokeUri = vscode.Uri.file(manyHeadsSmokePath(this.workspaceRoot));
    this.usageUri = vscode.Uri.file(path.join(this.workspaceRoot, ".hydra", "usage.jsonl"));
    this.codexModelsUri = vscode.Uri.file(path.join(this.workspaceRoot, ".hydra", "codex-models.json"));
    this.nativeCapabilitiesUri = vscode.Uri.file(nativeCapabilitiesPath(this.workspaceRoot));
    this.nativeDataSnapshotUri = vscode.Uri.file(nativeDataSnapshotPath(this.workspaceRoot));
    this.workQueueUri = vscode.Uri.file(path.join(this.workspaceRoot, ".hydra", "work-queue.jsonl"));
    this.sessionBriefUri = vscode.Uri.file(sessionBriefPath(this.workspaceRoot));
    this.wikiContextUri = vscode.Uri.file(hydraWikiContextPath(this.workspaceRoot));
    this.supportBundleUri = vscode.Uri.file(supportBundlePath(this.workspaceRoot));
    this.telegramInboundStateUri = vscode.Uri.file(path.join(this.workspaceRoot, ".hydra", "telegram-inbox-state.json"));
    await ensureGitignore(this.workspaceRoot);
    await ensureTranscriptFile(this.transcriptUri.fsPath);
    await ensureObjectiveFile(this.objectiveUri.fsPath);
    await ensureDecisionsFile(this.decisionsUri.fsPath);
    await ensureVerificationFile(this.verificationUri.fsPath);
    await ensureNativeActionsFile(this.nativeActionsUri.fsPath);
    await ensureHydraEventsFile(this.eventsUri.fsPath);
    await ensureJsonlFile(this.agentCallsUri.fsPath);
    await ensureManyHeadsSmokeFile(this.manyHeadsSmokeUri.fsPath);
    await ensureJsonlFile(this.usageUri.fsPath);
    await ensureFile(this.telegramInboundStateUri.fsPath, "{\"seenIds\":[]}\n");
    // Why: usage.jsonl keeps full durable history, but the in-memory replay is
    // bounded (last 30 days OR last K rows, window >= the 7-day weekly cutoff)
    // so a long-lived workspace doesn't grow this array without limit.
    this.usageRecords = boundUsageRecords(await loadUsageRecords(this.usageUri.fsPath));
    this.sessionUsage = summarizeUsage(this.usageRecords, this.sessionId);
    this.weeklyUsage = summarizeUsage(this.usageRecords, undefined, usageCutoffIso(7));
    this.codexModelsSnapshot = await loadCodexModelsSnapshot(this.codexModelsUri.fsPath);
    await ensureWorkQueueStateFile(this.workQueueUri.fsPath);
    this.objective = await readObjective(this.objectiveUri.fsPath);
    this.workspaceInstructions = await readWorkspaceInstructions(this.workspaceRoot, 0);
    this.workspaceInstructionsByAgent = {
      codex: await readWorkspaceInstructions(this.workspaceRoot, 0, undefined, { agent: "codex" }),
      claude: await readWorkspaceInstructions(this.workspaceRoot, 0, undefined, { agent: "claude" }),
    };
    this.decisions = await readDecisions(this.decisionsUri.fsPath);
    this.verifications = await readVerifications(this.verificationUri.fsPath);
    this.nativeActions = await readNativeActions(this.nativeActionsUri.fsPath);
    this.workQueueDispositions = await readWorkQueueDispositions(this.workQueueUri.fsPath);
    this.gitAvailable = await isGitWorkspace(this.workspaceRoot);
    await this.refreshWorkspaceChanges();
    if (this.gitAvailable) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.workspaceRoot, "**/*"));
      const schedule = (uri: vscode.Uri) => {
        // Why: Hydra's own .hydra writes (transcript, events, decisions, etc.)
        // would otherwise re-trigger this watcher and flood-schedule redundant
        // git status runs. node_modules/.git churn is equally irrelevant to the
        // workspace-change panel, so drop those before re-arming the debounce.
        if (this.isIgnoredWatchPath(uri.fsPath)) return;
        this.scheduleWorkspaceChangesRefresh();
      };
      this.disposables.push(
        watcher,
        watcher.onDidCreate(schedule),
        watcher.onDidChange(schedule),
        watcher.onDidDelete(schedule),
      );
    }
    const existing = await readTranscript(this.transcriptUri.fsPath);
    this.setMessages(existing.map((m, i) => ({ ...m, id: `prev-${i}` })));
    this.postState();
    this.telegram.startInboundPolling();
    if (autopilotOnStart()) {
      setTimeout(() => void this.runAutopilotStart(), 0);
    }
  }

  // ---------------- public command entry points ----------------

  async sendUserMessage(
    text: string,
    opener: AgentId = this.getFirstSpeaker(),
    options: { telegramChatId?: string; consumePendingAttachments?: boolean } = {}
  ): Promise<void> {
    await this.ready();
    const prepared = this.prepareUserMessageWithAttachments(text, !!options.consumePendingAttachments);
    if (!prepared.displayText) return;
    if (!this.workspaceReady) {
      this.appendSystemMessageToUi("Hydra cannot send yet because no workspace folder is ready. Open a project folder, then send again.");
      this.postState();
      return;
    }
    const selectedOpener = normalizeAgentId(opener, this.getFirstSpeaker());
    if (this.terminalPokeInFlight) {
      const queued = this.appendUserMessageToUi(prepared.displayText);
      this.queuedUserMessages.push({ ...prepared, opener: selectedOpener, timestamp: queued.timestamp, telegramChatId: options.telegramChatId });
      await this.appendSystemMessage("Hydra queued your message until the native terminal action finishes.");
      this.postState();
      return;
    }
    if (isInFlight(this.state)) {
      const queued = this.appendUserMessageToUi(prepared.displayText);
      this.queuedUserMessages.push({ ...prepared, opener: selectedOpener, timestamp: queued.timestamp, telegramChatId: options.telegramChatId });
      await this.appendSystemMessage("Hydra queued your message until the current turn finishes.");
      this.postState();
      return;
    }
    if (!isSendable(this.state)) {
      await this.appendSystemMessage(`Hydra ignored a send request because the room is not in a sendable state: ${this.state.name}.`);
      this.postState();
      return;
    }
    if (!this.autoAdvanceInProgress) this.autoAdvanceSendInstructionCount = 0;
    await this.startUserMessageTurn(prepared.displayText, prepared.promptText, selectedOpener, { alreadyAppended: false });
  }

  // Telegram-inbound entry point: dispatch a user turn exactly like
  // sendUserMessage, but report the pre-turn transcript index (so the auto-reply
  // can window only this turn's output) and whether the user pressed Stop while
  // the turn was running (so the controller can skip the reply instead of
  // replying about a cancelled turn). When the message is queued behind active
  // work it returns cancelled=false; the controller then sends the "queued" ack,
  // and the eventual reply is sent later from drainQueuedUserMessages.
  private async sendInboundUserMessage(
    text: string,
    opener: AgentId,
    options: { telegramChatId?: string }
  ): Promise<TelegramInboundTurnOutcome> {
    await this.ready();
    const beforeReplyAt = this.messages.length;
    const stopCountBefore = this.stopRequestCount;
    await this.sendUserMessage(text, opener, { telegramChatId: options.telegramChatId });
    return { beforeReplyAt, cancelled: this.stopRequestCount !== stopCountBefore };
  }

  private async startUserMessageTurn(
    displayText: string,
    promptText: string,
    selectedOpener: AgentId,
    options: { alreadyAppended: boolean; timestamp?: string }
  ): Promise<void> {
    const parallel = shouldRunParallelDiscussion(promptText, discussionMode());
    // Transition state synchronously BEFORE any await. A second concurrent
    // sendUserMessage hitting after this.ready() but during appendUserMessage
    // would otherwise pass the guard above and orphan the first turn's
    // currentAbort. Now the second call sees an in-flight discussion and bails at
    // isSendable.
    this.applyEvent({ type: "userSent", opener: selectedOpener, parallel });
    let timestamp = options.timestamp;
    if (!options.alreadyAppended) timestamp = (await this.appendUserMessage(displayText)).timestamp;
    if (parallel) {
      await this.runParallelDiscussionTurn(promptText, displayText, timestamp);
    } else {
      await this.runDiscussionTurn(selectedOpener, promptText, displayText, timestamp);
    }
    await this.drainQueuedUserMessages();
  }

  async stop(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    // Background wiki maintenance runs off the turn critical path and is not
    // reflected in the in-flight guards below, so abort it unconditionally
    // (a no-op when nothing is running) before the early return.
    this.wikiMaintenanceAbort?.abort();
    if (
      !isInFlight(this.state) &&
      !this.terminalPokeInFlight &&
      !this.verificationRunning &&
      !this.autopilotRunning
    ) {
      return;
    }
    // Aborting propagates to the active runAgent / runVerificationCommand /
    // autopilot calls, which kill their child processes and resolve with
    // cancelled=true. The in-flight method then observes ctrl.signal.aborted,
    // cleans up, and posts state.
    this.stopRequestCount++;
    this.currentAbort?.abort();
  }

  async assignBuilder(builder: AgentId): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (this.state.name !== "AwaitingUser") return;
    await this.appendSystemMessage(
      `${AGENT_NAMES[builder]} assigned as builder. This is explicit user build authority; previous survey or planning defaults no longer block implementation.`
    );
    this.applyEvent({ type: "assignBuilder", builder });
    await this.runBuildPhase(builder);
    await this.drainQueuedUserMessages();
  }

  async assignParallelBuilders(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (this.state.name !== "AwaitingUser") return;
    const agents: AgentId[] = ["codex", "claude"];
    await this.appendSystemMessage(
      "Codex and Claude assigned as parallel room builders. Hydra will dispatch both Build workers at once with the same room objective and transcript context."
    );
    this.applyEvent({ type: "assignBuilders", agents });
    await this.runParallelBuildPhase(agents);
    await this.drainQueuedUserMessages();
  }

  async requestReview(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (this.state.name !== "BuildDone" && this.state.name !== "ParallelBuildDone") return;
    if (!this.gitAvailable) {
      await this.appendSystemMessage(
        "Review unavailable: workspace is not a git repository. Returning to discussion — build edits remain in the working tree for manual review."
      );
      this.applyEvent({ type: "requestReviewSkipped" });
      return;
    }
    let parallelAgents: AgentId[] | undefined;
    let reviewer: AgentId | undefined;
    if (this.state.name === "ParallelBuildDone") {
      parallelAgents = [...this.state.agents];
    } else {
      reviewer = otherAgent(this.state.builder);
    }
    this.applyEvent({ type: "requestReview" });
    if (parallelAgents) {
      await this.runParallelReviewPhase(parallelAgents);
    } else if (reviewer) {
      await this.runReviewPhase(reviewer);
    }
    await this.drainQueuedUserMessages();
  }

  async runVerification(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    await this.runVerificationInternal("manual");
  }

  private async runVerificationInternal(reason: "manual" | "afterBuild"): Promise<VerificationResult | undefined> {
    if (isInFlight(this.state) || this.verificationRunning) {
      await this.appendSystemMessage("Verification is paused because Hydra is already running work.");
      this.postState();
      return undefined;
    }

    const cfg = vscode.workspace.getConfiguration("hydraRoom");
    const resolution = await resolveVerificationCommand({
      configured: cfg.get<string>("verifyCommand", ""),
      isWorkspaceTrusted: vscode.workspace.isTrusted,
      workspaceRoot: this.workspaceRoot,
    });
    if (resolution.kind === "refusedUntrustedInference") {
      await this.appendSystemMessage(
        "Verification unavailable: this workspace is not trusted, so Hydra will not run inferred package.json scripts. Set hydraRoom.verifyCommand in User or Machine Settings to opt in, or grant Workspace Trust."
      );
      this.postState();
      return undefined;
    }
    if (resolution.kind === "missing") {
      await this.appendSystemMessage(
        "Verification unavailable: set `hydraRoom.verifyCommand` or add a package.json script named `check`, `test`, or `lint`."
      );
      this.postState();
      return undefined;
    }
    const command = resolution.command;

    const ctrl = new AbortController();
    this.currentAbort = ctrl;
    this.verificationRunning = true;
    this.postState();
    await this.recordEvent("verificationStarted", `${reason === "afterBuild" ? "Auto-verification" : "Verification"} started`, {
      command,
      reason,
    });
    await this.appendSystemMessage(
      `${reason === "afterBuild" ? "Hydra auto-verification started after build" : "Hydra verification started"}:\n${command}`
    );
    let verification: VerificationResult | undefined;
    try {
      const result = await runVerificationCommand({
        cwd: this.workspaceRoot,
        command,
        timeoutMs: verificationTimeoutMs(),
        maxOutputChars: verificationMaxOutputChars(),
        signal: ctrl.signal,
      });
      if (result.cancelled) {
        await this.appendSystemMessage("Hydra verification cancelled by user.");
      } else {
        // Anchor the verification to the git HEAD that was tested. A
        // reviewer prompt can compare to current HEAD to detect a stale
        // (or forged) verification record.
        if (this.gitAvailable) {
          const head = await captureGitHead(this.workspaceRoot);
          if (head) result.headSha = head;
        }
        verification = result;
        this.verifications.push(result);
        await appendVerification(this.verificationUri.fsPath, result);
        await this.appendSystemMessage(
          [
            `Hydra verification ${verificationPassed(result) ? "passed" : "failed"}.`,
            verificationSummary(result),
            result.stdout ? `\nStdout:\n${result.stdout}` : "",
            result.stderr ? `\nStderr:\n${result.stderr}` : "",
          ].filter(Boolean).join("\n")
        );
        await this.recordEvent("verificationFinished", `Verification ${verificationPassed(result) ? "passed" : "failed"}`, {
          command,
          reason,
          exitCode: result.exitCode ?? null,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
        });
      }
    } finally {
      this.verificationRunning = false;
      if (this.currentAbort === ctrl) this.currentAbort = undefined;
      this.postState();
    }
    return verification;
  }

  async acceptDefaultDecision(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady || isInFlight(this.state)) return;
    const action = this.currentDecisionAction();
    if (action.kind === "none") return;

    this.acceptedDefaultDecisionTimestamp = action.sourceTimestamp;
    this.postState();
    await this.appendSystemMessage(`Accepted default decision: ${action.detail}`);
    if (action.kind === "assignBuilder" && action.builder && this.state.name === "AwaitingUser") {
      await this.assignBuilder(action.builder);
      return;
    }
    if (action.kind === "requestReview" && (this.state.name === "BuildDone" || this.state.name === "ParallelBuildDone")) {
      await this.requestReview();
      return;
    }
    if (action.kind === "handBack" && (this.state.name === "ReviewDone" || this.state.name === "ParallelReviewDone")) {
      await this.handBack();
      return;
    }
    if (action.kind === "sendInstruction" && action.instruction && isSendable(this.state)) {
      await this.sendUserMessage(action.instruction, this.getFirstSpeaker());
      return;
    }
    this.postState();
  }

  async toggleAutoAdvanceActionableDefaults(): Promise<void> {
    await this.ready();
    const resource = this.workspaceReady ? vscode.Uri.file(this.workspaceRoot) : undefined;
    const cfg = vscode.workspace.getConfiguration("hydraRoom", resource);
    const current = cfg.get<boolean>("autoAdvanceActionableDefaults", true);
    const inspected = cfg.inspect<boolean>("autoAdvanceActionableDefaults");
    const target = inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

    await cfg.update("autoAdvanceActionableDefaults", !current, target);
    await this.appendSystemMessage(
      `Auto Accept Default is now ${!current ? "on" : "off"} (${configurationTargetLabel(target)} setting).`
    );
    this.postState();
  }

  async handBack(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (this.state.name !== "ReviewDone" && this.state.name !== "ParallelReviewDone") return;
    const previousState = this.state;
    this.applyEvent({ type: "handBack" });
    if (previousState.name === "ParallelReviewDone") {
      await this.runParallelBuildPhase([...previousState.agents]);
    } else {
      const builder: AgentId = previousState.reviewer === "codex" ? "claude" : "codex";
      await this.runBuildPhase(builder);
    }
    await this.drainQueuedUserMessages();
  }

  private async drainQueuedUserMessages(): Promise<void> {
    if (this.drainingQueuedUserMessages) return;
    this.drainingQueuedUserMessages = true;
    try {
      while (
        this.queuedUserMessages.length > 0 &&
        this.workspaceReady &&
        !this.terminalPokeInFlight &&
        !isInFlight(this.state) &&
        isSendable(this.state)
      ) {
        const next = this.queuedUserMessages.shift();
        if (!next) break;
        const beforeReplyAt = this.messages.length;
        await appendMessage(this.transcriptUri.fsPath, {
          role: "user",
          text: next.displayText,
          timestamp: next.timestamp,
        });
        await this.startUserMessageTurn(next.displayText, next.promptText, next.opener, {
          alreadyAppended: true,
          timestamp: next.timestamp,
        });
        if (next.telegramChatId) {
          const cfg = telegramConfig();
          if (cfg) await this.telegram.sendInboundReply({ ...cfg, chatId: next.telegramChatId }, beforeReplyAt);
        }
      }
    } finally {
      this.drainingQueuedUserMessages = false;
      this.postState();
    }
  }

  async openTranscript(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    const doc = await vscode.workspace.openTextDocument(this.transcriptUri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
  }

  async archiveAndClearRoom(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (
      isInFlight(this.state) ||
      this.terminalPokeInFlight ||
      this.verificationRunning ||
      this.autopilotRunning
    ) {
      vscode.window.showWarningMessage("Hydra can archive the room after the current work finishes or is stopped.");
      return;
    }
    this.wikiMaintenanceAbort?.abort(); // cancel any in-flight background wiki wrapup before wiping the room

    const result = await archiveAndResetTranscript(this.transcriptUri.fsPath);
    this.setMessages([]);
    this.state = { name: "AwaitingUser" };
    this.suggestedBuilder = undefined;
    this.setAgentStatus("codex", "idle", "Idle");
    this.setAgentStatus("claude", "idle", "Idle");

    const archiveLabel = path.relative(this.workspaceRoot, result.archivePath).replace(/\\/g, "/");
    await this.appendSystemMessage(
      `Archived ${result.archivedMessages} room message${result.archivedMessages === 1 ? "" : "s"} to \`${archiveLabel}\`. Room window cleared.`
    );
    try {
      await this.appendSystemMessage(await this.runWorkspaceStateCleanup());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.appendSystemMessage(`Hydra workspace cleanup after archive failed: ${message}`);
    }
    this.postState();

    const picked = await vscode.window.showInformationMessage(
      `Hydra archived room history to ${archiveLabel}.`,
      "Open Archive"
    );
    if (picked === "Open Archive") {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(result.archivePath));
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }
  }

  async openDecisions(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    const doc = await vscode.workspace.openTextDocument(this.decisionsUri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
  }

  async openVerification(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    const doc = await vscode.workspace.openTextDocument(this.verificationUri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
  }

  async openNativeActions(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    const doc = await vscode.workspace.openTextDocument(this.nativeActionsUri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
  }

  async openAgentCalls(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    await ensureJsonlFile(this.agentCallsUri.fsPath);
    const doc = await vscode.workspace.openTextDocument(this.agentCallsUri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
  }

  async openWorkspaceChange(relativePath: string): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    const normalized = relativePath.replace(/\\/g, "/");
    if (!normalized || path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
      await this.appendSystemMessage("Hydra refused to open an invalid workspace change path.");
      this.postState();
      return;
    }
    const absolute = path.resolve(this.workspaceRoot, normalized);
    const root = path.resolve(this.workspaceRoot);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      await this.appendSystemMessage("Hydra refused to open a path outside the workspace.");
      this.postState();
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.appendSystemMessage(`Hydra could not open \`${normalized}\`: ${message}`);
      this.postState();
    }
  }

  async openRunFailureFile(relativePath: string): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    const normalized = relativePath.replace(/\\/g, "/");
    if (!isSafeRunFailureRequestPath(normalized)) {
      await this.appendSystemMessage("Hydra refused to open an invalid run diagnostic path.");
      this.postState();
      return;
    }
    const absolute = path.resolve(this.workspaceRoot, normalized);
    const root = path.resolve(this.workspaceRoot);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      await this.appendSystemMessage("Hydra refused to open a run diagnostic path outside the workspace.");
      this.postState();
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.appendSystemMessage(`Hydra could not open \`${normalized}\`: ${message}`);
      this.postState();
    }
  }

  async copyRunFailurePromptSha(sha: string): Promise<void> {
    await this.ready();
    if (!/^[a-f0-9]{64}$/i.test(sha)) return;
    await vscode.env.clipboard.writeText(sha);
    void vscode.window.showInformationMessage("Prompt SHA copied.");
  }

  async openObjective(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    // ensureObjectiveFile is also called during initialize, but be defensive
    // if a user deleted it manually between init and this command firing.
    await ensureObjectiveFile(this.objectiveUri.fsPath);
    const doc = await vscode.workspace.openTextDocument(this.objectiveUri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
  }

  async openSessionBrief(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    const markdown = renderSessionBrief({
      generatedAt: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      phaseLabel: phaseLabel(this.state),
      transport: this.transportMode(),
      objective: this.objective,
      latestDecision: this.decisions[this.decisions.length - 1],
      latestVerification: this.latestVerification(),
      workQueue: this.currentWorkQueue(),
      recentNativeActions: this.nativeActions.slice(-5).reverse(),
      recentMessages: this.messages.slice(-8).map((message) => ({
        role: message.role,
        phase: message.phase,
        text: message.text,
        timestamp: message.timestamp,
      })),
    });
    await writeSessionBrief(this.sessionBriefUri.fsPath, markdown);
    await this.appendSystemMessage("Hydra session brief refreshed at `.hydra/session-brief.md`.");
    const doc = await vscode.workspace.openTextDocument(this.sessionBriefUri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    this.postState();
  }

  async openWikiContext(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    await ensureHydraWikiFiles(this.workspaceRoot);
    const doc = await vscode.workspace.openTextDocument(this.wikiContextUri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
  }

  async runWikiWrapupNow(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    await this.maybeRunWikiWrapup("manual command", { force: true, manual: true });
  }

  async openSupportBundle(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    const report = this.latestDoctorReport ?? (await this.buildDoctorReport(false)).report;
    this.latestDoctorReport = report;
    const nativeData = await collectNativeDataSnapshot(this.workspaceRoot);
    const markdown = renderSupportBundle({
      generatedAt: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      phaseLabel: phaseLabel(this.state),
      transport: this.transportMode(),
      doctorReport: report,
      authoritySummaries: this.currentAuthoritySummaries(),
      nativeRuntime: await this.nativeRuntimeDiagnostics(),
      nativeData: supportBundleNativeDataSummary(nativeData),
      terminalSessions: this.terminalBridge?.getSessions() ?? [],
      latestDecision: this.decisions[this.decisions.length - 1],
      latestVerification: this.latestVerification(),
      workQueue: this.currentWorkQueue(),
      recentNativeActions: this.nativeActions.slice(-8).reverse(),
      recentEvents: (await readHydraEvents(this.eventsUri.fsPath, 40)).reverse(),
      recentMessages: this.messages.slice(-12).map((message) => ({
        role: message.role,
        phase: message.phase,
        text: message.text,
        timestamp: message.timestamp,
        error: message.error,
        cancelled: message.cancelled,
      })),
    });
    await writeSupportBundle(this.supportBundleUri.fsPath, markdown);
    await this.appendSystemMessage("Hydra support bundle refreshed at `.hydra/support-bundle.md`.");
    const doc = await vscode.workspace.openTextDocument(this.supportBundleUri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    this.postState();
  }

  async captureNativeCapabilities(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (isInFlight(this.state) || this.terminalPokeInFlight) return;
    const ctrl = new AbortController();
    this.currentAbort = ctrl;
    this.terminalPokeInFlight = true;
    this.postState();
    const probes: NativeCapabilityProbe[] = [];
    const probeArgs: Record<AgentId, Array<{ label: string; args: string[] }>> = {
      codex: [
        { label: "version", args: ["--version"] },
        { label: "help", args: ["--help"] },
        { label: "mcp list json", args: ["mcp", "list", "--json"] },
        { label: "plugin help", args: ["plugin", "--help"] },
        { label: "features list", args: ["features", "list"] },
        { label: "login status", args: ["login", "status"] },
      ],
      claude: [
        { label: "version", args: ["--version"] },
        { label: "help", args: ["--help"] },
        { label: "mcp list", args: ["mcp", "list"] },
        { label: "plugin list json", args: ["plugin", "list", "--json"] },
        { label: "auth status", args: ["auth", "status"] },
      ],
    };
    try {
      await this.appendSystemMessage("Capturing native Codex and Claude capability snapshot...");
      for (const agent of ["codex", "claude"] as AgentId[]) {
        for (const probe of probeArgs[agent]) {
          const started = Date.now();
          const spawn = await this.buildNativeCommandSpawn(agent, probe.args);
          const result = await runAgent(spawn, "", 30000, () => {}, ctrl.signal);
          probes.push({
            agent,
            label: probe.label,
            command: spawn.command,
            args: spawn.args,
            cwd: spawn.cwd,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: Date.now() - started,
            output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
          });
        }
      }
      const markdown = renderNativeCapabilitySnapshot({
        generatedAt: new Date().toISOString(),
        workspaceRoot: this.workspaceRoot,
        probes,
      });
      await writeNativeCapabilities(this.nativeCapabilitiesUri.fsPath, markdown);
      await this.appendSystemMessage("Native capability snapshot refreshed at `.hydra/native-capabilities.md`.");
      const doc = await vscode.workspace.openTextDocument(this.nativeCapabilitiesUri);
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    } finally {
      this.terminalPokeInFlight = false;
      if (this.currentAbort === ctrl) this.currentAbort = undefined;
      this.postState();
      await this.drainQueuedUserMessages();
    }
  }

  async captureNativeDataSnapshot(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (isInFlight(this.state) || this.terminalPokeInFlight) return;
    this.terminalPokeInFlight = true;
    this.postState();
    try {
      await this.appendSystemMessage("Capturing redacted native CLI data snapshot...");
      const markdown = renderNativeDataSnapshot(await collectNativeDataSnapshot(this.workspaceRoot));
      await writeNativeDataSnapshot(this.nativeDataSnapshotUri.fsPath, markdown);
      await this.appendSystemMessage("Native data snapshot refreshed at `.hydra/native-data-snapshot.md`.");
      const doc = await vscode.workspace.openTextDocument(this.nativeDataSnapshotUri);
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    } finally {
      this.terminalPokeInFlight = false;
      this.postState();
      await this.drainQueuedUserMessages();
    }
  }

  async refreshCodexModels(): Promise<void> {
    await this.ready();
    await refreshCodexModelCatalog(this.modelChooserDeps());
  }

  async chooseModel(): Promise<void> {
    await this.ready();
    await chooseModelInteractively(this.modelChooserDeps());
  }

  async chooseModelOrEffort(): Promise<void> {
    await this.ready();
    const pick = await vscode.window.showQuickPick(
      [
        { label: "Choose Model", description: "Pick Codex or Claude model overrides", value: "model" },
        { label: "Choose Thinking Level", description: "Pick Codex reasoning or Claude effort overrides", value: "effort" },
      ],
      { placeHolder: "What do you want to change?" },
    );
    if (!pick) return;
    if (pick.value === "effort") {
      await this.chooseEffort();
    } else {
      await this.chooseModel();
    }
  }

  async chooseEffort(): Promise<void> {
    await this.ready();
    await chooseEffortInteractively({
      appendSystemMessage: (text) => this.appendSystemMessage(text),
      postState: () => this.postState(),
    });
  }

  async toggleManyHeadsMode(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    const next = !manyHeadsMode();
    await vscode.workspace
      .getConfiguration("hydraRoom")
      .update("manyHeadsMode", next, vscode.ConfigurationTarget.Workspace);
    await this.appendSystemMessage(
      next
        ? `Many Heads Mode enabled for this workspace. Parallel discussion will launch ${manyHeadsClaudeWorkerCount()} local Claude workers through the subscription-backed runtime.`
        : "Many Heads Mode disabled for this workspace."
    );
    this.postState();
  }

  async configureManyHeadsWorkers(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    const current = manyHeadsClaudeWorkerCount();
    const choices = Array.from({ length: 8 }, (_, index) => {
      const value = index + 1;
      return {
        label: `${value}`,
        description: value === current ? "current" : undefined,
        detail: `${value} local subscription-backed Claude worker${value === 1 ? "" : "s"} in Many Heads parallel discussion`,
        value,
      };
    });
    const pick = await vscode.window.showQuickPick(choices, {
      title: "Many Heads Claude Workers",
      placeHolder: "Choose local Claude worker fanout (1-8)",
      ignoreFocusOut: true,
    });
    if (!pick) return;
    await vscode.workspace
      .getConfiguration("hydraRoom")
      .update("manyHeadsClaudeWorkerCount", pick.value, vscode.ConfigurationTarget.Global);
    await this.appendSystemMessage(`Many Heads Claude worker count set to ${pick.value}.`);
    this.postState();
  }

  async runManyHeadsSmokeTest(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (isInFlight(this.state) || this.terminalPokeInFlight || this.verificationRunning || this.autopilotRunning) {
      await this.appendSystemMessage("Many Heads smoke test skipped because Hydra is already running work.");
      this.postState();
      return;
    }
    if (!isSendable(this.state)) {
      await this.appendSystemMessage(`Many Heads smoke test skipped because the room is not in a sendable state: ${this.state.name}.`);
      this.postState();
      return;
    }

    const prompt = [
      "Codex and Claude, run a Hydra Many Heads smoke test.",
      "Do not edit files or run long commands.",
      "Codex: inspect only the Many Heads live-channel pointers in your prompt and reply with SMOKE_CODEX_OK plus any live-channel evidence you can see.",
      "Claude workers: each of you should use one Task/subagent call if available with the instruction `Return SMOKE_TASK_OK only.` Then reply with SMOKE_CLAUDE_OK.",
      "Keep all replies under 8 lines and include no Decision Packet.",
    ].join(" ");
    const cfg = vscode.workspace.getConfiguration("hydraRoom");
    const previousManyHeadsWorkspaceValue = cfg.inspect<boolean>("manyHeadsMode")?.workspaceValue;
    const previousAutoAdvanceWorkspaceValue = cfg.inspect<boolean>("autoAdvanceActionableDefaults")?.workspaceValue;
    const previousTransport = this.transportMode();
    const expectedClaudeWorkers = manyHeadsClaudeWorkerCount();
    const startedAt = new Date().toISOString();
    const messageStartIndex = this.messages.length;
    let turnError: string | undefined;

    await this.appendSystemMessage(
      `Hydra Many Heads smoke test started. Temporarily enabling Many Heads Mode with ${expectedClaudeWorkers} Claude worker(s); report will be written to \`.hydra/many-heads-smoke.jsonl\`.`
    );
    await this.recordEvent("commandInvoked", "Hydra Many Heads smoke test started.", {
      expectedClaudeWorkers,
      previousTransport,
    });

    try {
      if (previousTransport !== "oneShot") {
        this.transport = "oneShot";
        this.terminalBridge?.dispose();
        this.terminalBridge = undefined;
        await this.appendSystemMessage("Many Heads smoke test switched this room to safe one-shot transport; Many Heads worker fanout does not run through terminal bridge.");
      }
      await cfg.update("manyHeadsMode", true, vscode.ConfigurationTarget.Workspace);
      await cfg.update("autoAdvanceActionableDefaults", false, vscode.ConfigurationTarget.Workspace);
      this.postState();
      await this.sendUserMessage(prompt, "codex");
    } catch (err) {
      turnError = err instanceof Error ? err.message : String(err);
      await this.appendSystemMessage(`Many Heads smoke test turn failed before report collection: ${turnError}`);
    } finally {
      await cfg.update("manyHeadsMode", previousManyHeadsWorkspaceValue, vscode.ConfigurationTarget.Workspace);
      await cfg.update("autoAdvanceActionableDefaults", previousAutoAdvanceWorkspaceValue, vscode.ConfigurationTarget.Workspace);
      this.postState();
    }

    const completedAt = new Date().toISOString();
    const agentCalls = (await readJsonlGuarded(
      this.agentCallsUri.fsPath,
      isManyHeadsSmokeAgentCall,
      { limit: 500 }
    )).filter((call) => isSmokeWindowCall(call, startedAt));
    const liveFiles = await this.readManyHeadsSmokeLiveFiles(agentCalls);
    const forwardedTaskEvents = this.messages
      .slice(messageStartIndex)
      .reduce((sum, message) => sum + (message.liveChannelEvents?.length ?? 0), 0);
    const report = buildManyHeadsSmokeReport({
      startedAt,
      completedAt,
      prompt,
      expectedClaudeWorkers,
      agentCalls,
      liveFiles,
      forwardedTaskEvents,
    });
    await appendManyHeadsSmokeReport(this.manyHeadsSmokeUri.fsPath, report);
    const formatted = formatManyHeadsSmokeReport(report);
    await this.appendSystemMessage(
      [
        formatted,
        `Report: \`.hydra/many-heads-smoke.jsonl\``,
        turnError ? `Turn error: ${turnError}` : "",
      ].filter(Boolean).join("\n")
    );
    await this.recordEvent(report.passed ? "commandInvoked" : "error", `Hydra Many Heads smoke test ${report.passed ? "passed" : "failed"}.`, {
      expectedClaudeWorkers,
      claudeStarts: report.observed.claudeStarts,
      liveFiles: report.observed.liveFiles,
      forwardedTaskEvents: report.observed.forwardedTaskEvents,
      guardBlocks: report.observed.guardBlocks,
      passed: report.passed,
    });
    if (report.passed) {
      vscode.window.showInformationMessage("Hydra Many Heads smoke test passed.");
    } else {
      vscode.window.showWarningMessage("Hydra Many Heads smoke test failed. See .hydra/many-heads-smoke.jsonl.");
    }
    this.postState();
  }

  private modelChooserDeps(): ModelChooserDeps {
    return {
      workspaceRoot: this.workspaceRoot,
      codexModelsPath: this.codexModelsUri.fsPath,
      getCodexModelsSnapshot: () => this.codexModelsSnapshot,
      setCodexModelsSnapshot: (snapshot) => {
        this.codexModelsSnapshot = snapshot;
      },
      appendSystemMessage: (text) => this.appendSystemMessage(text),
      postState: () => this.postState(),
    };
  }

  private effortSummaryForRail(agent: AgentId): string {
    const key = agent === "claude" ? "claudeEffort" : "codexReasoning";
    return summarizePhasedSetting(
      vscode.workspace.getConfiguration("hydraRoom").get<unknown>(key),
    );
  }

  private profileSummaryForRail(agent: AgentId): { text: string; title: string } {
    const cfg = vscode.workspace.getConfiguration("hydraRoom");
    const phases: Array<{ key: CliProfile; label: string }> = [
      { key: "discussion", label: "Discussion" },
      { key: "build", label: "Build" },
      { key: "review", label: "Review" },
    ];
    const labels = phases.map((phase) => {
      const configured = cfg.get<string>(profileSettingKey(agent, phase.key), "custom");
      const id = isConfigurableCapabilityProfileId(configured) ? configured : "custom";
      const preset = capabilityProfilePreset(id);
      return {
        short: capabilityProfileShortLabel(id),
        title: `${phase.label}: ${preset?.label ?? "Custom"}`,
      };
    });
    return {
      text: labels.map((label) => label.short).join("/"),
      title: labels.map((label) => label.title).join(", "),
    };
  }

  private modelSummaryForRail(agent: AgentId): string {
    return summarizePhasedSetting(
      vscode.workspace.getConfiguration("hydraRoom").get<unknown>(`${agent}Model`),
      { fallback: "default" },
    );
  }

  async insertPromptTemplate(): Promise<void> {
    await this.ready();
    const raw = vscode.workspace.getConfiguration("hydraRoom").get<unknown>("promptTemplates");
    const templates: Array<{ name: string; body: string }> = [];
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (entry && typeof entry === "object") {
          const e = entry as { name?: unknown; body?: unknown };
          if (typeof e.name === "string" && typeof e.body === "string" && e.name.trim() && e.body.trim()) {
            templates.push({ name: e.name, body: e.body });
          }
        }
      }
    }
    if (templates.length === 0) {
      const action = await vscode.window.showInformationMessage(
        "No prompt templates configured. Add some under hydraRoom.promptTemplates in settings.",
        "Open Settings",
      );
      if (action === "Open Settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "hydraRoom.promptTemplates");
      }
      return;
    }
    const pick = await vscode.window.showQuickPick(
      templates.map((t) => ({ label: t.name, detail: t.body.length > 120 ? `${t.body.slice(0, 117)}…` : t.body, body: t.body })),
      { placeHolder: "Pick a prompt template to load into the composer" },
    );
    if (!pick) return;
    this.panel.webview.postMessage({ type: "setComposerText", text: pick.body });
    this.panel.reveal(vscode.ViewColumn.Beside);
  }

  async showCommandCenter(): Promise<void> {
    await this.ready();
    let wikiStatus: CommandCenterWikiStatus | undefined;
    if (this.workspaceReady) {
      try {
        const status = await readHydraWikiStatus(this.workspaceRoot, wikiContextMaxChars(), {
          includeLog: wikiPromptIncludeLog(),
        });
        // Why: read a wider window so the wiki-usage rollup can still fill on
        // event-heavy sessions, where high-frequency events (e.g. phaseTransition)
        // would otherwise push the wiki events out of a smaller tail.
        const usageTelemetry = summarizeHydraWikiUsageEvents(await readHydraEvents(this.eventsUri.fsPath, 1000));
        wikiStatus = { ...status, usageTelemetry };
      } catch {
        // Wiki status is advisory; keep Command Center usable if wiki files are hand-edited mid-read.
      }
    }
    const actions = buildCommandCenterActions({
      workspaceReady: this.workspaceReady,
      canStop: isInFlight(this.state) || this.terminalPokeInFlight || this.verificationRunning || this.autopilotRunning,
      canAcceptDefault: this.workspaceReady && !isInFlight(this.state) && !this.terminalPokeInFlight && this.currentDecisionAction().kind !== "none",
      autoAdvanceActionableDefaults: autoAdvanceActionableDefaults(),
      canAssignBuilder: this.workspaceReady && this.state.name === "AwaitingUser",
      canRequestReview: this.workspaceReady && (this.state.name === "BuildDone" || this.state.name === "ParallelBuildDone") && this.gitAvailable,
      canHandBack: this.workspaceReady && (this.state.name === "ReviewDone" || this.state.name === "ParallelReviewDone") && !this.state.approved,
      canRunVerification: this.workspaceReady && !isInFlight(this.state) && !this.terminalPokeInFlight && !this.verificationRunning,
      canRunWikiWrapup: this.canRunManualWikiWrapup(),
      canPokeNativeTerminals: this.workspaceReady && !isInFlight(this.state) && !this.terminalPokeInFlight,
      needsCodexPath: checkFailed(this.latestDoctorReport, "codex-command"),
      needsClaudePath: checkFailed(this.latestDoctorReport, "claude-command"),
      transport: this.transportMode(),
      workQueueCount: this.workspaceReady ? this.currentWorkQueue().length : 0,
      nativeActionsCount: this.nativeActions.length,
      manyHeadsMode: manyHeadsMode(),
      manyHeadsClaudeWorkerCount: manyHeadsClaudeWorkerCount(),
      wikiStatus,
    });
    const pick = await vscode.window.showQuickPick(
      actions.map((item) => ({
        ...item,
        alwaysShow: true,
      })),
      {
        title: "Hydra Command Center",
        placeHolder: "Pick the next room action",
        ignoreFocusOut: true,
      }
    );
    if (!pick) return;
    await this.runCommandCenterAction(pick.id);
  }

  private async runCommandCenterAction(action: CommandCenterActionId): Promise<void> {
    switch (action) {
      case "openWorkspaceFolder":
        await this.openWorkspaceFolder();
        return;
      case "stopCurrentTurn":
        await this.stop();
        return;
      case "acceptDefaultDecision":
        await this.acceptDefaultDecision();
        return;
      case "toggleAutoAdvanceActionableDefaults":
        await this.toggleAutoAdvanceActionableDefaults();
        return;
      case "archiveAndClearRoom":
        await this.archiveAndClearRoom();
        return;
      case "assignCodex":
        await this.assignBuilder("codex");
        return;
      case "assignClaude":
        await this.assignBuilder("claude");
        return;
      case "assignParallelBuilders":
        await this.assignParallelBuilders();
        return;
      case "chooseModel":
        await this.chooseModel();
        return;
      case "chooseEffort":
        await this.chooseEffort();
        return;
      case "toggleManyHeadsMode":
        await this.toggleManyHeadsMode();
        return;
      case "configureManyHeadsWorkers":
        await this.configureManyHeadsWorkers();
        return;
      case "testTelegram":
        await this.sendTestTelegramMessage();
        return;
      case "requestReview":
        await this.requestReview();
        return;
      case "handBack":
        await this.handBack();
        return;
      case "runVerification":
        await this.runVerification();
        return;
      case "nativeAction":
        await this.showNativeActionPicker();
        return;
      case "pokeBothTerminalsWithDiff":
        await this.pokeNativeTerminals(["codex", "claude"], "", { includeWorkspaceDiff: true });
        return;
      case "openObjective":
        await this.openObjective();
        return;
      case "openVerification":
        await this.openVerification();
        return;
      case "openDecisions":
        await this.openDecisions();
        return;
      case "openSessionBrief":
        await this.openSessionBrief();
        return;
      case "openWikiContext":
        await this.openWikiContext();
        return;
      case "runWikiWrapupNow":
        await this.runWikiWrapupNow();
        return;
      case "openSupportBundle":
        await this.openSupportBundle();
        return;
      case "captureNativeCapabilities":
        await this.captureNativeCapabilities();
        return;
      case "captureNativeDataSnapshot":
        await this.captureNativeDataSnapshot();
        return;
      case "openNativeActions":
        await this.openNativeActions();
        return;
      case "openAgentCalls":
        await this.openAgentCalls();
        return;
      case "openNativeTerminals":
        await this.openNativeTerminals();
        return;
      case "useTerminalBridge":
        await this.useTerminalBridge();
        return;
      case "useOneShotTransport":
        await this.useOneShotTransport();
        return;
      case "runDoctor":
        await this.runDoctor();
        return;
      case "runAutopilotStart":
        await this.runAutopilotStart();
        return;
      case "runTerminalBridgeSelfTest":
        await this.runTerminalBridgeSelfTest();
        return;
      case "showTerminalBridgeHealth":
        await this.showTerminalBridgeHealth();
        return;
      case "showEffectiveAuthority":
        await this.showEffectiveAuthority();
        return;
      case "changeCapabilityProfile":
        await this.changeCapabilityProfile();
        return;
      case "fixCodexPath":
        await this.fixAgentCommand("codex");
        return;
      case "fixClaudePath":
        await this.fixAgentCommand("claude");
        return;
      case "resetStuckTurn":
        await this.resetStuckTurn();
        return;
      case "openTranscript":
        await this.openTranscript();
        return;
      case "openLastPrompt":
        await this.openLastPrompt();
        return;
      case "attachFiles":
        await this.attachFiles();
        return;
      case "cleanWorkspaceState":
        await this.cleanWorkspaceState();
        return;
    }
  }

  async previewNextPrompt(draftText = "", opener: AgentId = this.getFirstSpeaker()): Promise<void> {
    await this.ready();
    if (!this.workspaceReady || isInFlight(this.state)) return;
    const envelope = await this.buildNextPromptPreviewEnvelope(draftText, opener);
    const doc = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: renderPromptEnvelopePreview(envelope),
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }

  async openLastPrompt(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    const envelope = await readLatestPromptEnvelope(this.workspaceRoot);
    if (!envelope) {
      vscode.window.showInformationMessage("Hydra has not written any prompt envelopes yet.");
      return;
    }
    const doc = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: renderPromptEnvelopePreview(envelope),
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }

  async cleanWorkspaceState(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    const message = await this.runWorkspaceStateCleanup();
    await this.appendSystemMessage(message);
    vscode.window.showInformationMessage(message.replace(/`/g, ""));
    this.postState();
  }

  private async runWorkspaceStateCleanup(): Promise<string> {
    const promptRetentionDays = promptBodyRetentionDays();
    const diagnosticDays = diagnosticRetentionDays();
    const summary = await cleanWorkspaceStateFiles(this.workspaceRoot, {
      promptBodyRetentionDays: promptRetentionDays,
      diagnosticRetentionDays: diagnosticDays,
    });
    const prompt = summary.promptBodies;
    const diagnostics = summary.diagnostics;
    const promptSummary = prompt.missing
      ? "Hydra workspace cleanup found no prompt index yet."
      : [
          `Hydra workspace cleanup compacted ${prompt.compactedRecords} old prompt bod${prompt.compactedRecords === 1 ? "y" : "ies"} from \`.hydra/prompts/index.jsonl\`.`,
          `Prompt body retention: ${promptRetentionDays} day${promptRetentionDays === 1 ? "" : "s"}.`,
          `Records: ${prompt.totalRecords} parsed, ${prompt.retainedBodyRecords} still keeping bodies, ${prompt.alreadyCompactedRecords} already compacted${prompt.malformedLines ? `, ${prompt.malformedLines} malformed preserved` : ""}.`,
        ].join(" ");
    const message = [
      promptSummary,
      `Deleted ${diagnostics.deletedFiles} stale diagnostic file${diagnostics.deletedFiles === 1 ? "" : "s"} (${formatBytes(diagnostics.deletedBytes)}) from terminal request prompts, replies, logs, dispatch scripts, and room attachments.`,
      `Diagnostic retention: ${diagnosticDays} day${diagnosticDays === 1 ? "" : "s"}.`,
    ].join(" ");
    return message;
  }

  async attachFiles(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    const picks = await vscode.window.showOpenDialog({
      title: "Hydra: Attach Files",
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Attach",
    });
    if (!picks?.length) return;

    const turnId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
    const relativeDir = path.posix.join(".hydra", "attachments", turnId);
    const attachmentDir = path.join(this.workspaceRoot, ".hydra", "attachments", turnId);
    const added: PendingRoomAttachment[] = [];
    const failed: string[] = [];
    const maxFileBytes = attachmentMaxBytes();
    const maxTotalBytes = attachmentTotalMaxBytes();
    let pendingTotalBytes = this.pendingAttachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
    for (const uri of picks) {
      if (uri.scheme !== "file") {
        failed.push(`${uri.toString()} is not a local file.`);
        continue;
      }
      try {
        const stats = await fs.stat(uri.fsPath);
        if (Number.isFinite(maxTotalBytes) && maxTotalBytes >= 0 && pendingTotalBytes + stats.size > maxTotalBytes) {
          failed.push(`${this.attachmentSourceLabel(uri)} would exceed the ${formatBytes(maxTotalBytes)} total attachment limit.`);
          continue;
        }
        added.push(await prepareRoomAttachment({
          id: `${turnId}-${added.length}`,
          sourcePath: uri.fsPath,
          sourceLabel: this.attachmentSourceLabel(uri),
          attachmentDir,
          relativeAttachmentDir: relativeDir,
          previewMaxChars: attachmentPreviewMaxChars(),
          maxBytes: maxFileBytes,
        }));
        pendingTotalBytes += stats.size;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push(message);
      }
    }
    if (added.length > 0) {
      this.pendingAttachments.push(...added);
      void vscode.window.showInformationMessage(`Hydra attached ${added.length} file${added.length === 1 ? "" : "s"}.`);
    }
    if (failed.length > 0) {
      await this.appendSystemMessage(`Hydra could not attach ${failed.length} file${failed.length === 1 ? "" : "s"}: ${failed.join("; ")}`);
    }
    this.postState();
  }

  async clearAttachment(id: string): Promise<void> {
    await this.ready();
    if (!id) return;
    this.pendingAttachments = this.pendingAttachments.filter((attachment) => attachment.id !== id);
    this.postState();
  }

  async clearAttachments(): Promise<void> {
    await this.ready();
    if (this.pendingAttachments.length === 0) return;
    this.pendingAttachments = [];
    this.postState();
  }

  async setObjective(text: string): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    this.objective = trimmed;
    await writeObjective(this.objectiveUri.fsPath, this.objective);
    await this.appendSystemMessage(
      `Room objective pinned. This is context only; press Send when you want Codex and Claude to answer.\n\n${this.objective}`
    );
    this.postState();
  }

  async resetObjective(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (!this.objective.trim()) return;
    this.objective = "";
    await writeObjective(this.objectiveUri.fsPath, "");
    await this.appendSystemMessage("Room objective reset.");
    this.postState();
  }

  async openNativeTerminals(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    await this.terminalBridge?.openAll();
    vscode.window.showInformationMessage("Hydra native terminals opened.");
    this.postState();
  }

  async pokeNativeTerminal(
    agent: AgentId,
    text: string,
    options: NativeTerminalPokeOptions | boolean = {}
  ): Promise<void> {
    await this.pokeNativeTerminals([agent], text, options);
  }

  async runNativeCliCommand(agent: AgentId, argsLine: string): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (isInFlight(this.state) || this.terminalPokeInFlight) return;
    const rawArgs = splitNativeArgs(argsLine.trim());
    if (rawArgs.length === 0) return;

    const actionId = `na-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    let status: NativeActionStatus = "failed";
    const ctrl = new AbortController();
    this.currentAbort = ctrl;
    this.terminalPokeInFlight = true;
    const commandLine = `${agent} ${rawArgs.join(" ")}`;
    try {
      await this.appendUserMessage(`[Native ${AGENT_NAMES[agent]} command]\n\n${commandLine}`);
      const messageId = this.openPendingMessage(agent, "opener");
      const spawn = await this.buildNativeCommandSpawn(agent, rawArgs);
      const result = await this.runAgentTransport(
        agent,
        "opener",
        spawn,
        "",
        messageId,
        agentTimeoutMs("build"),
        ctrl.signal,
        this.transportMode() === "terminalBridge"
      );
      await this.finalizePendingMessage(messageId, result);
      status = ctrl.signal.aborted ? "cancelled" : didAgentFail(result) ? "failed" : "completed";
    } finally {
      await this.recordNativeAction({
        id: actionId,
        agents: [agent],
        instruction: commandLine,
        includeEditorContext: false,
        includeWorkspaceDiff: false,
        promptEnvelopeIds: [],
        status,
      });
      this.terminalPokeInFlight = false;
      this.currentAbort = undefined;
      this.postState();
      await this.drainQueuedUserMessages();
    }
  }

  async sendRawTerminalLine(agent: AgentId, line: string): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (isInFlight(this.state) || this.terminalPokeInFlight) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    if (!this.terminalBridge) {
      await this.appendSystemMessage(TERMINAL_BRIDGE_NOT_READY);
      this.postState();
      return;
    }

    const actionId = `na-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    let status: NativeActionStatus = "failed";
    this.terminalPokeInFlight = true;
    try {
      await this.appendUserMessage(`[Raw ${AGENT_NAMES[agent]} terminal line]\n\n${trimmed}`);
      await this.terminalBridge.sendRawLine(agent, trimmed);
      await this.appendSystemMessage(`Sent raw line to ${AGENT_NAMES[agent]} terminal. Continue interaction in the visible terminal if the CLI is interactive.`);
      status = "completed";
    } finally {
      await this.recordNativeAction({
        id: actionId,
        agents: [agent],
        instruction: `[raw terminal] ${trimmed}`,
        includeEditorContext: false,
        includeWorkspaceDiff: false,
        promptEnvelopeIds: [],
        status,
      });
      this.terminalPokeInFlight = false;
      this.postState();
      await this.drainQueuedUserMessages();
    }
  }

  async pokeNativeTerminals(
    agents: AgentId[],
    text: string,
    options: NativeTerminalPokeOptions | boolean = {}
  ): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (isInFlight(this.state) || this.terminalPokeInFlight) return;
    const targetAgents = uniqueAgents(agents);
    if (targetAgents.length === 0) return;
    const pokeOptions = normalizePokeOptions(options);
    const editorContext = pokeOptions.includeEditorContext ? this.activeEditorContext() : undefined;
    if (pokeOptions.includeEditorContext && !editorContext) {
      await this.appendSystemMessage("No active editor context is available. Open a file or select text, then try the native terminal poke again.");
      this.postState();
      return;
    }
    let workspaceDiff: string | undefined;
    if (pokeOptions.includeWorkspaceDiff) {
      if (!this.gitAvailable) {
        await this.appendSystemMessage("Working-tree poke unavailable: workspace is not a git repository.");
        this.postState();
        return;
      }
      const diff = await captureGitDiff(this.workspaceRoot, diffMaxLines());
      if (diff === null) {
        await this.appendSystemMessage("Working-tree poke unavailable: git diff failed.");
        this.postState();
        return;
      }
      workspaceDiff = diff.trim() || "[git working tree clean]";
    }
    const instruction = text.trim() || defaultPokeInstruction(editorContext, workspaceDiff);
    if (!instruction) return;
    if (!this.terminalBridge) {
      await this.appendSystemMessage(TERMINAL_BRIDGE_NOT_READY);
      this.postState();
      return;
    }

    const actionId = `na-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const promptEnvelopeIds: string[] = [];
    let status: NativeActionStatus = "failed";
    const ctrl = new AbortController();
    this.currentAbort = ctrl;
    this.terminalPokeInFlight = true;
    try {
      // Why: targetAgents is non-empty here — pokeNativeTerminals returns early
      // above when uniqueAgents() yields length 0, so [0] is always defined.
      const firstAgent = targetAgents[0]!;
      const targetLabel = targetAgents.length === 2
        ? "Codex and Claude terminals"
        : `${AGENT_NAMES[firstAgent]} terminal`;
      const attachmentSummary = [
        editorContext
          ? `Attached editor context: ${editorContext.label} (${editorContext.selected ? "selection" : "active file"}, ${editorContext.text.length} chars${editorContext.truncated ? " truncated" : ""})`
          : "",
        workspaceDiff !== undefined
          ? `Attached working-tree diff: ${workspaceDiff.length} chars`
          : "",
      ].filter(Boolean).join("\n");
      const attachmentBlock = attachmentSummary ? `\n\n${attachmentSummary}` : "";
      await this.appendUserMessage(`[Direct to ${targetLabel}]${attachmentBlock}\n\n${instruction}`);
      await this.terminalBridge.openAll();
      const calls: Promise<{ text: string; result: RunResult }>[] = [];
      for (const agent of targetAgents) {
        const envelope = await this.buildDirectTerminalPokeEnvelope(agent, instruction, editorContext, workspaceDiff);
        promptEnvelopeIds.push(envelope.id);
        await this.persistPromptEnvelope(envelope);
        const messageId = this.openPendingMessage(agent, "opener");
        const pending = this.messagesById.get(messageId);
        if (pending) pending.activity = `${AGENT_NAMES[agent]} native terminal poke running...`;
        calls.push(this.callAgent(agent, "opener", envelope.renderedPrompt, messageId, ctrl.signal, true));
      }
      this.postState();
      const results = await Promise.all(calls);
      status = ctrl.signal.aborted
        ? "cancelled"
        : results.some(({ result }) => didAgentFail(result))
          ? "failed"
          : "completed";
    } finally {
      await this.recordNativeAction({
        id: actionId,
        agents: targetAgents,
        instruction,
        includeEditorContext: !!pokeOptions.includeEditorContext,
        includeWorkspaceDiff: !!pokeOptions.includeWorkspaceDiff,
        editorContext,
        workspaceDiff,
        promptEnvelopeIds,
        status,
      });
      this.terminalPokeInFlight = false;
      this.currentAbort = undefined;
      this.postState();
      await this.drainQueuedUserMessages();
    }
  }

  async showNativeActionPicker(draftText = ""): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (isInFlight(this.state) || this.terminalPokeInFlight) return;

    const pick = await vscode.window.showQuickPick(nativeActionPicks(), {
      title: "Hydra: Native Action",
      placeHolder: "Choose who gets the direct native-terminal instruction and what context to attach.",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!pick) return;

    // Why: every NativeActionPick from nativeActionPicks() is built with a
    // non-empty agents array; the command/rawLine kinds are always single-agent.
    const firstAgent = pick.agents[0];
    if (firstAgent === undefined) return;

    let instruction = pick.presetLine ?? draftText.trim();
    if (!instruction) {
      const input = await vscode.window.showInputBox({
        title: `Hydra: ${pick.plainLabel}`,
        prompt: pick.actionKind === "command"
          ? `Native args/subcommand to run after ${AGENT_NAMES[firstAgent]}'s configured executable. Example: doctor or mcp list.`
          : pick.actionKind === "rawLine"
          ? `Raw PowerShell line to send to the visible ${AGENT_NAMES[firstAgent]} terminal. Use this for interactive native CLI flows.`
          : pick.options.includeEditorContext || pick.options.includeWorkspaceDiff
          ? "Optional instruction. Leave blank to use only the attached context."
          : "Instruction to send to the selected native terminal endpoint.",
        ignoreFocusOut: true,
      });
      if (input === undefined) return;
      instruction = input;
    }

    if (pick.actionKind === "command") {
      await this.runNativeCliCommand(firstAgent, instruction);
    } else if (pick.actionKind === "rawLine") {
      await this.sendRawTerminalLine(firstAgent, instruction);
    } else {
      await this.pokeNativeTerminals(pick.agents, instruction, pick.options);
    }
  }

  async rerunNativeAction(id: string): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (isInFlight(this.state) || this.terminalPokeInFlight) return;
    const receipt = this.nativeActions.find((action) => action.id === id);
    if (!receipt) {
      await this.appendSystemMessage(`Native action unavailable: no receipt found for ${id}.`);
      this.postState();
      return;
    }
    await this.pokeNativeTerminals(receipt.agents, receipt.instruction, {
      includeEditorContext: receipt.includeEditorContext,
      includeWorkspaceDiff: receipt.includeWorkspaceDiff,
    });
  }

  async clearNativeActions(ids: string[]): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (this.terminalPokeInFlight) {
      await this.appendSystemMessage("Native actions cannot be cleared while a native terminal action is running.");
      this.postState();
      return;
    }
    const targetIds = new Set(ids.map((id) => id.trim()).filter(Boolean));
    if (targetIds.size === 0) return;
    const previous = this.nativeActions;
    const next = previous.filter((action) => !targetIds.has(action.id));
    const removed = previous.length - next.length;
    if (removed === 0) return;

    this.nativeActions = next;
    try {
      await writeNativeActions(this.nativeActionsUri.fsPath, next);
    } catch (err) {
      this.nativeActions = previous;
      const message = err instanceof Error ? err.message : String(err);
      await this.appendSystemMessage(`Native actions failed to clear: ${message}`);
    }
    this.postState();
  }

  async discussLatestVerificationFailure(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady || isInFlight(this.state) || this.terminalPokeInFlight) return;
    const latest = this.latestVerification();
    if (!latest || verificationPassed(latest) || !isSendable(this.state)) return;
    await this.sendUserMessage(
      [
        "Diagnose and fix the latest Hydra verification failure.",
        "",
        verificationAsReviewContext(latest),
      ].join("\n"),
      this.getFirstSpeaker()
    );
  }

  async dismissWorkQueueItem(id: string): Promise<void> {
    await this.recordWorkQueueDisposition({
      id,
      kind: "dismissed",
      timestamp: new Date().toISOString(),
    });
  }

  async snoozeWorkQueueItem(id: string, minutes = 60): Promise<void> {
    const now = Date.now();
    await this.recordWorkQueueDisposition({
      id,
      kind: "snoozed",
      timestamp: new Date(now).toISOString(),
      until: new Date(now + Math.max(1, minutes) * 60 * 1000).toISOString(),
    });
  }

  private async recordNativeAction(input: {
    id: string;
    agents: AgentId[];
    instruction: string;
    includeEditorContext: boolean;
    includeWorkspaceDiff: boolean;
    editorContext?: EditorContextAttachment;
    workspaceDiff?: string;
    promptEnvelopeIds: string[];
    status: NativeActionStatus;
  }): Promise<void> {
    const receipt: NativeActionReceipt = {
      id: input.id,
      timestamp: new Date().toISOString(),
      agents: input.agents,
      instruction: input.instruction,
      includeEditorContext: input.includeEditorContext,
      includeWorkspaceDiff: input.includeWorkspaceDiff,
      editorContext: input.editorContext
        ? {
          label: input.editorContext.label,
          selected: input.editorContext.selected,
          startLine: input.editorContext.startLine,
          endLine: input.editorContext.endLine,
          chars: input.editorContext.text.length,
          originalChars: input.editorContext.originalChars,
          truncated: input.editorContext.truncated,
        }
        : undefined,
      workspaceDiffChars: input.workspaceDiff?.length,
      promptEnvelopeIds: input.promptEnvelopeIds,
      nativeSessionHints: await collectNativeSessionHints(this.workspaceRoot, input.agents),
      status: input.status,
    };
    this.nativeActions.push(receipt);
    try {
      await appendNativeAction(this.nativeActionsUri.fsPath, receipt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.appendSystemMessage(`Native action receipt failed to write: ${message}`);
      } catch {
        // Keep cleanup paths from being blocked by a secondary receipt warning.
      }
    }
  }

  private async recordWorkQueueDisposition(disposition: WorkQueueDisposition): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    this.workQueueDispositions.push(disposition);
    try {
      await appendWorkQueueDisposition(this.workQueueUri.fsPath, disposition);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.appendSystemMessage(`Work queue state failed to write: ${message}`);
    }
    this.postState();
  }

  async useTerminalBridge(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    this.terminalBridge ??= this.createTerminalBridge();
    if (this.transportMode() === "terminalBridge") {
      await this.terminalBridge?.openAll();
      vscode.window.showInformationMessage("Hydra is already using the experimental terminal bridge.");
      await this.runTerminalBridgeSelfTest();
      return;
    }
    this.transport = "terminalBridge";
    await this.terminalBridge?.openAll();
    await this.appendSystemMessage(
      "Experimental terminal bridge enabled. Hydra is running a self-test before using it for agent turns."
    );
    this.postState();
    await this.runTerminalBridgeSelfTest();
  }

  async runTerminalBridgeSelfTest(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (!this.terminalBridge) {
      await this.appendSystemMessage(TERMINAL_BRIDGE_NOT_READY);
      this.transport = "oneShot";
      this.postState();
      return;
    }
    await this.terminalBridge.openAll();
    const result = await this.terminalBridge.selfTest(terminalBridgeTimeoutMs());
    if (!result.ok) this.transport = "oneShot";
    await this.appendSystemMessage(
      [
        result.message,
        `Log: ${result.logPath}`,
        `Reply: ${result.replyPath}`,
        `Checks: logBomFree=${result.checks.logBomFree}, replyStartsWithJsonObject=${result.checks.replyStartsWithJsonObject}, outputNotDuplicated=${result.checks.outputNotDuplicated}, replyParsed=${result.checks.replyParsed}`,
        result.ok
          ? "Future agent calls will be injected into visible native terminals and read from `.hydra/replies/*.json`."
          : "Hydra switched back to Safe One-Shot transport.",
      ].join("\n")
    );
    this.postState();
  }

  async showTerminalBridgeHealth(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    await this.appendSystemMessage(formatTerminalBridgeHealth(this.terminalBridge?.getSessions() ?? []));
    this.postState();
  }

  async showEffectiveAuthority(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    await this.appendSystemMessage(formatEffectiveAuthority(this.currentAuthoritySummaries()));
    this.postState();
  }

  async changeCapabilityProfile(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;

    const agentPick = await vscode.window.showQuickPick(
      [
        { label: "Codex", agent: "codex" as AgentId },
        { label: "Claude", agent: "claude" as AgentId },
      ],
      { placeHolder: "Choose the native CLI to configure" }
    );
    if (!agentPick) return;

    const scopePick = await vscode.window.showQuickPick(
      [
        { label: "Discussion", profile: "discussion" as const, detail: "Opener, reactor, closer, and parallel discussion turns" },
        { label: "Build", profile: "build" as const, detail: "Builder turns that may edit files" },
        { label: "Review", profile: "review" as const, detail: "Review turns over the current diff" },
      ],
      { placeHolder: `Choose the ${agentPick.label} phase profile` }
    );
    if (!scopePick) return;

    const cfg = vscode.workspace.getConfiguration("hydraRoom");
    const current = cfg.get<string>(profileSettingKey(agentPick.agent, scopePick.profile), "custom");
    const profilePick = await vscode.window.showQuickPick(
      configurableCapabilityProfiles().map((profile) => ({
        label: profile.label,
        description: profile.id === current ? "current" : profile.warningLevel,
        detail: profile.detail,
        profileId: profile.id,
      })),
      { placeHolder: `Choose ${agentPick.label} ${scopePick.label} capability profile` }
    );
    if (!profilePick) return;

    const profileId = profilePick.profileId as ConfigurableCapabilityProfileId;
    const settingKey = profileSettingKey(agentPick.agent, scopePick.profile);
    await cfg.update(settingKey, profileId, vscode.ConfigurationTarget.Global);

    const phase: Phase = scopePick.profile === "build" ? "build" : scopePick.profile === "review" ? "review" : "opener";
    const spawn = this.buildSpawn(agentPick.agent, phase);
    await this.appendSystemMessage(
      [
        `${agentPick.label} ${scopePick.label} profile changed to ${profilePick.label}.`,
        `Effective command: ${spawn.command} ${spawn.args.join(" ")}`.trim(),
      ].join("\n")
    );
    this.postState();
  }

  async useOneShotTransport(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (this.transportMode() === "oneShot") {
      vscode.window.showInformationMessage("Hydra is already using safe one-shot transport.");
      this.postState();
      return;
    }
    this.transport = "oneShot";
    this.terminalBridge?.dispose();
    this.terminalBridge = undefined;
    await this.appendSystemMessage("Safe one-shot transport enabled. Hydra will call Codex and Claude directly instead of injecting into native terminals.");
    this.postState();
  }

  async runAutopilotStart(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady || this.autopilotRunning) return;
    if (isInFlight(this.state)) {
      await this.appendSystemMessage("Hydra Autopilot skipped because a turn is already running.");
      this.postState();
      return;
    }

    const ctrl = new AbortController();
    this.currentAbort = ctrl;
    this.autopilotRunning = true;
    this.autopilotSummary = "Checking workspace, native CLIs, and terminal bridge";
    this.postState();
    try {
      const preferBridge = preferTerminalBridgeOnStart();
      const { report } = await this.buildDoctorReport(true);
      if (ctrl.signal.aborted) {
        await this.appendSystemMessage("Hydra Autopilot cancelled by user.");
        return;
      }
      this.latestDoctorReport = report;
      const codexReady = checkPassed(report, "codex-command");
      const claudeReady = checkPassed(report, "claude-command");
      const bridgeReady = checkPassed(report, "terminal-bridge");
      const coreReady =
        checkPassed(report, "workspace") &&
        checkPassed(report, "hydra-writable") &&
        codexReady &&
        claudeReady;

      if (coreReady && preferBridge && bridgeReady) {
        this.transport = "terminalBridge";
        await this.terminalBridge?.openAll();
        this.autopilotSummary = "Ready: native terminal bridge";
      } else if (coreReady) {
        this.transport = "oneShot";
        this.autopilotSummary = bridgeReady
          ? "Ready: safe one-shot"
          : "Ready: safe one-shot; terminal bridge self-test failed";
      } else {
        this.transport = "oneShot";
        this.autopilotSummary = "Needs setup";
      }

      if (ctrl.signal.aborted) {
        await this.appendSystemMessage("Hydra Autopilot cancelled by user.");
        return;
      }
      await this.appendSystemMessage(formatAutopilotReport(report, this.autopilotSummary));
    } finally {
      this.autopilotRunning = false;
      if (this.currentAbort === ctrl) this.currentAbort = undefined;
      this.postState();
    }
  }

  async runDoctor(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) {
      // No transcriptUri yet, so we can't appendSystemMessage. Pushing
      // directly to this.messages would break the single-source-of-truth
      // invariant (in-memory entry with no disk record disappears on
      // panel close). Surface via the VS Code error toast instead.
      vscode.window.showErrorMessage(
        "Hydra Doctor: open a workspace folder first."
      );
      return;
    }
    if (isInFlight(this.state)) {
      await this.appendSystemMessage("Hydra Doctor is paused because a turn is running. Stop or reset the turn, then run Doctor again.");
      this.postState();
      return;
    }

    const { report, bridgeOk } = await this.buildDoctorReport(true);
    this.latestDoctorReport = report;
    if (!bridgeOk && this.transportMode() === "terminalBridge") {
      this.transport = "oneShot";
    }
    await this.appendSystemMessage(formatDoctorReport(report));
    this.postState();
  }

  async fixAgentCommand(agent: AgentId): Promise<void> {
    await this.ready();
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: `Use as ${AGENT_NAMES[agent]} CLI`,
      title: `Select ${AGENT_NAMES[agent]} CLI executable or wrapper`,
    });
    const file = picked?.[0]?.fsPath;
    if (!file) return;
    await vscode.workspace
      .getConfiguration("hydraRoom")
      .update(`${agent}Command`, file, vscode.ConfigurationTarget.Global);
    await this.appendSystemMessage(
      `${AGENT_NAMES[agent]} CLI path saved to User settings: ${file}\nHydra Autopilot is rechecking the room.`
    );
    await this.runAutopilotStart();
  }

  async resetStuckTurn(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    this.currentAbort?.abort();
    this.wikiMaintenanceAbort?.abort();
    let changed = false;
    for (const message of this.messages) {
      if (!message.pending) continue;
      changed = true;
      message.pending = false;
      message.cancelled = true;
      message.activity = undefined;
      if (message.text.length > 0 && !message.text.endsWith("\n")) message.text += "\n";
      message.text += "[cancelled by Hydra reset]";
      await appendMessage(this.transcriptUri.fsPath, {
        role: message.role,
        text: message.text,
        timestamp: message.timestamp,
        phase: message.phase,
        cancelled: true,
      });
    }
    this.currentAbort = undefined;
    this.queuedUserMessages = [];
    if (isInFlight(this.state)) this.applyEvent({ type: "stop" });
    this.setAgentStatus("codex", "idle", "Idle");
    this.setAgentStatus("claude", "idle", "Idle");
    await this.appendSystemMessage(
      changed
        ? "Hydra reset the stuck turn. Pending agent bubbles were marked cancelled and control returned to you."
        : "Hydra reset requested, but no pending agent bubble was active."
    );
    this.postState();
  }

  async openWorkspaceFolder(): Promise<void> {
    await this.ready();
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Open Folder for Hydra",
      title: "Hydra needs a workspace folder",
    });
    if (picked?.[0]) {
      await vscode.commands.executeCommand("vscode.openFolder", picked[0], false);
    }
  }

  // ---------------- phase orchestration ----------------

  // Shared scaffold for every phase-turn method (serial opener/reactor/closer,
  // parallel discussion, build, and review). Owns the AbortController lifecycle
  // and the finalize-in-finally bookkeeping that every turn duplicated: assign
  // currentAbort, run the phase-specific body, then in finally finalize any
  // still-pending bubbles the body registered and clear currentAbort + repost
  // state if it's still ours. The serial-vs-parallel split and the per-phase
  // failure messaging live in each body; only the controller/finalize boilerplate
  // is shared here. applyEvent stays the sole state mutator inside the bodies, so
  // the transition() invariant is untouched.
  private async runTurn(
    body: (ctrl: AbortController, registerPending: (finalize: () => Promise<void>) => void) => Promise<void>,
    options?: { clearSuggestedBuilder?: boolean }
  ): Promise<void> {
    const ctrl = new AbortController();
    this.currentAbort = ctrl;
    if (options?.clearSuggestedBuilder) this.suggestedBuilder = undefined;
    let finalizePending: (() => Promise<void>) | undefined;
    try {
      await body(ctrl, (fn) => {
        finalizePending = fn;
      });
    } finally {
      // Safety net: the body registers a finalizer that finalizes whatever
      // bubbles it left pending (a synchronous throw mid-await). Happy-path and
      // early-return branches inside the body already cleared currentAbort and
      // posted state; the guard below makes that work a no-op in those cases.
      if (finalizePending) await finalizePending();
      if (this.currentAbort === ctrl) {
        this.currentAbort = undefined;
        this.postState();
      }
    }
  }

  private async runDiscussionTurn(
    opener: AgentId,
    currentUserMessage: string,
    displayUserMessage: string,
    currentUserTimestamp?: string
  ): Promise<void> {
    await this.runTurn(async (ctrl, registerPending) => {
      // Track pending message ids opened in this method so a synchronous throw
      // mid-await (template render, ENOSPC on persist, etc.) can finalize each
      // bubble's spinner. The happy-path branches NULL these as they're consumed.
      const reactor = otherAgent(opener);
      let openerId: string | undefined;
      let reactorId: string | undefined;
      let closerId: string | undefined;
      registerPending(async () => {
        const stillPending = [openerId, reactorId, closerId].filter(
          (id): id is string => typeof id === "string",
        );
        if (stillPending.length > 0) {
          const failure = agentCallFailureResult("Hydra turn aborted before this agent could finish (internal error).");
          for (const id of stillPending) {
            await this.finalizePendingMessage(id, failure);
          }
        }
      });
      const openerContext = this.buildPromptContextSnapshotForCurrentTurn(
        "opener",
        opener,
        currentUserMessage,
        displayUserMessage,
        currentUserTimestamp
      );
      const openerEnvelope = await this.buildPromptEnvelope({
        agent: opener,
        otherAgent: reactor,
        phase: "opener",
        transcript: openerContext.text,
        currentUserMessage,
      });
      await this.persistPromptEnvelope(openerEnvelope);
      openerId = this.openPendingMessage(opener, "opener");
      this.pendingPromptTranscriptWindows.set(openerId, openerContext.transcriptWindow);
      this.postState();

      const openerResult = await this.callAgent(opener, "opener", openerEnvelope.renderedPrompt, openerId, ctrl.signal);
      openerId = undefined; // callAgent finalized the pending bubble.

      if (ctrl.signal.aborted || didAgentFail(openerResult.result)) {
        this.applyEvent({ type: "stop" });
        this.currentAbort = undefined;
        this.postState();
        return;
      }

      this.applyEvent({ type: "openerDone" });

      // Build the reactor prompt only after the opener has finalized into
      // the transcript. This ordering is what makes the second head actually
      // respond to the first instead of reading a stale snapshot.
      const reactorContext = this.buildPromptContextSnapshotForCurrentTurn(
        "reactor",
        reactor,
        currentUserMessage,
        displayUserMessage,
        currentUserTimestamp
      );
      const reactorEnvelope = await this.buildPromptEnvelope({
        agent: reactor,
        otherAgent: opener,
        phase: "reactor",
        transcript: reactorContext.text,
        currentUserMessage,
      });
      await this.persistPromptEnvelope(reactorEnvelope);
      reactorId = this.openPendingMessage(reactor, "reactor");
      this.pendingPromptTranscriptWindows.set(reactorId, reactorContext.transcriptWindow);
      this.postState();

      const reactorMessageId = reactorId;
      const reactorResult = await this.callAgent(reactor, "reactor", reactorEnvelope.renderedPrompt, reactorId, ctrl.signal);
      reactorId = undefined;

      if (ctrl.signal.aborted || didAgentFail(reactorResult.result)) {
        this.applyEvent({ type: "stop" });
        this.currentAbort = undefined;
        this.postState();
        return;
      }

      this.applyEvent({ type: "reactorDone" });

      if (autoSkipCloserOnAgreement() && shouldAutoSkipCloserOnAgreement(reactorResult.text, {
        agent: reactor,
        phase: "reactor",
        sourceMessageTimestamp: this.messagesById.get(reactorMessageId)?.timestamp ?? new Date().toISOString(),
      })) {
        this.applyEvent({ type: "closerDone" });
        this.currentAbort = undefined;
        this.postState();
        this.enqueueWikiMaintenanceAfterTurn("discussion");
        await this.autoAdvanceActionableDefault("discussion");
        return;
      }

      // Build the closer prompt only after the reactor has finalized into the
      // transcript. The opener owns this short final turn so critique becomes an
      // action decision instead of a dangling handoff.
      const closerContext = this.buildPromptContextSnapshotForCurrentTurn(
        "closer",
        opener,
        currentUserMessage,
        displayUserMessage,
        currentUserTimestamp
      );
      const closerEnvelope = await this.buildPromptEnvelope({
        agent: opener,
        otherAgent: reactor,
        phase: "closer",
        transcript: closerContext.text,
        currentUserMessage,
      });
      await this.persistPromptEnvelope(closerEnvelope);
      closerId = this.openPendingMessage(opener, "closer");
      this.pendingPromptTranscriptWindows.set(closerId, closerContext.transcriptWindow);
      this.postState();

      const closerResult = await this.callAgent(opener, "closer", closerEnvelope.renderedPrompt, closerId, ctrl.signal);
      closerId = undefined;

      if (ctrl.signal.aborted || didAgentFail(closerResult.result)) {
        this.applyEvent({ type: "stop" });
        this.currentAbort = undefined;
        this.postState();
        return;
      }

      // Consensus-driver heuristic. If the reactor expressed soft approval
      // ("I'd approve...") and the closer did not retract, the opener drove
      // consensus and is the natural builder suggestion. If the closer also
      // signals approval (mutual) or neither does (still divergent), suggest
      // nothing — the user picks freely.
      const reactorApproves = SOFT_APPROVAL_RE.test(reactorResult.text);
      const closerApproves = SOFT_APPROVAL_RE.test(closerResult.text);
      if (reactorApproves && !closerApproves) {
        this.suggestedBuilder = opener;
      } else if (closerApproves && !reactorApproves) {
        this.suggestedBuilder = reactor;
      } else {
        this.suggestedBuilder = undefined;
      }
      this.applyEvent({ type: "closerDone" });
      this.currentAbort = undefined;
      this.postState();
      this.enqueueWikiMaintenanceAfterTurn("discussion");
      await this.autoAdvanceActionableDefault("discussion");
    }, { clearSuggestedBuilder: true });
  }

  private async runParallelDiscussionTurn(
    currentUserMessage: string,
    displayUserMessage: string,
    currentUserTimestamp?: string
  ): Promise<void> {
    await this.runTurn(async (ctrl, registerPending) => {
      // Track every pending bubble opened in the prep loop so we can finalize
      // them in the finally block if buildPromptEnvelope/persistPromptEnvelope
      // throws between opening one and dispatching the callAgent that owns it.
      const openedIds: string[] = [];
      let promiseStarted = false;
      registerPending(async () => {
        if (!promiseStarted && openedIds.length > 0) {
          // Threw during prep — those bubbles never had a callAgent assigned.
          const failure = agentCallFailureResult("Hydra parallel turn aborted before this agent could be dispatched (internal error).");
          for (const id of openedIds) {
            await this.finalizePendingMessage(id, failure);
          }
        }
      });
      const workers = buildParallelDiscussionWorkers({
        manyHeads: manyHeadsMode(),
        transport: this.transportMode(),
        claudeWorkerCount: manyHeadsClaudeWorkerCount(),
        makeTraceId,
      });
      const claudeLiveRequestIds = claudeWorkerTraceIds(workers);
      const calls: Promise<{ text: string; result: RunResult }>[] = [];
      for (const worker of workers) {
        const agent = worker.agent;
        const context = this.buildPromptContextSnapshotForCurrentTurn(
          "parallel",
          agent,
          currentUserMessage,
          displayUserMessage,
          currentUserTimestamp
        );
        const transcriptWithLiveChannels = agent === "codex" && claudeLiveRequestIds.length > 0
          ? appendManyHeadsLiveChannelContext(context.text, this.workspaceRoot, claudeLiveRequestIds)
          : context.text;
        const transcript = appendClaudeWorkerAssignment(transcriptWithLiveChannels, worker);
        const envelope = await this.buildPromptEnvelope({
          agent,
          otherAgent: otherAgent(agent),
          phase: "parallel",
          transcript,
          currentUserMessage,
        });
        await this.persistPromptEnvelope(envelope);
        const messageId = this.openPendingMessage(agent, "parallel");
        this.pendingPromptTranscriptWindows.set(messageId, context.transcriptWindow);
        openedIds.push(messageId);
        calls.push(
          this.callAgent(
            agent,
            "parallel",
            envelope.renderedPrompt,
            messageId,
            ctrl.signal,
            false,
            worker.traceIdOverride,
            worker.manyHeadsDispatch
          )
        );
      }
      this.postState();
      // Once Promise.all is awaited, callAgent finalizes each bubble. Any
      // throw inside Promise.all itself would still leave bubbles pending,
      // but callAgent has its own try/finally — so once we start awaiting,
      // ownership transfers to those calls and we don't double-finalize.
      promiseStarted = true;

      const results = await Promise.all(calls);
      if (ctrl.signal.aborted || results.some(({ result }) => didAgentFail(result))) {
        this.applyEvent({ type: "stop" });
      } else {
        this.applyEvent({ type: "parallelDone" });
      }
      this.currentAbort = undefined;
      this.postState();
      if (!ctrl.signal.aborted && results.every(({ result }) => !didAgentFail(result))) {
        this.enqueueWikiMaintenanceAfterTurn("parallel discussion");
      }
      await this.autoAdvanceActionableDefault("parallel discussion");
    }, { clearSuggestedBuilder: true });
  }

  private async runBuildPhase(builder: AgentId): Promise<void> {
    await this.runTurn(async (ctrl, registerPending) => {
      let buildId: string | undefined;
      registerPending(async () => {
        if (buildId) {
          const failure = agentCallFailureResult("Hydra build turn aborted before the builder could finish (internal error).");
          await this.finalizePendingMessage(buildId, failure);
        }
      });
      // Snapshot the transcript BEFORE opening the pending bubble, otherwise the
      // builder's own empty entry would appear at the tail of its prompt context.
      const buildContext = this.buildPromptContextSnapshot("build", undefined, builder);
      const otherAgent: AgentId = builder === "codex" ? "claude" : "codex";
      const buildEnvelope = await this.buildPromptEnvelope({
        agent: builder,
        otherAgent,
        phase: "build",
        transcript: buildContext.text,
      });
      await this.persistPromptEnvelope(buildEnvelope);
      buildId = this.openPendingMessage(builder, "build");
      this.pendingPromptTranscriptWindows.set(buildId, buildContext.transcriptWindow);
      this.postState();
      const result = await this.callAgent(builder, "build", buildEnvelope.renderedPrompt, buildId, ctrl.signal);
      buildId = undefined; // callAgent finalized the pending bubble.

      if (ctrl.signal.aborted || didAgentFail(result.result)) {
        this.applyEvent({ type: "stop" });
      } else {
        this.applyEvent({ type: "buildDone" });
      }
      this.currentAbort = undefined;
      this.postState();
      if (!ctrl.signal.aborted && !didAgentFail(result.result)) {
        await this.afterSuccessfulBuild();
      }
    });
  }

  private async runParallelBuildPhase(agents: AgentId[]): Promise<void> {
    await this.runTurn(async (ctrl, registerPending) => {
      const openedIds: string[] = [];
      let promiseStarted = false;
      registerPending(async () => {
        if (!promiseStarted && openedIds.length > 0) {
          const failure = agentCallFailureResult("Hydra parallel build aborted before this worker could be dispatched (internal error).");
          for (const id of openedIds) {
            await this.finalizePendingMessage(id, failure);
          }
        }
      });
      // Snapshot the transcript before opening pending bubbles so neither
      // worker sees the other's empty pending message as context.
      const calls: Promise<{ text: string; result: RunResult }>[] = [];
      for (const agent of agents) {
        const buildContext = this.buildPromptContextSnapshot("build", undefined, agent);
        const buildEnvelope = await this.buildPromptEnvelope({
          agent,
          otherAgent: otherAgent(agent),
          phase: "build",
          transcript: buildContext.text,
        });
        await this.persistPromptEnvelope(buildEnvelope);
        const messageId = this.openPendingMessage(agent, "build");
        this.pendingPromptTranscriptWindows.set(messageId, buildContext.transcriptWindow);
        openedIds.push(messageId);
        calls.push(this.callAgent(agent, "build", buildEnvelope.renderedPrompt, messageId, ctrl.signal));
      }
      this.postState();
      promiseStarted = true;

      const results = await Promise.all(calls);
      if (ctrl.signal.aborted || results.some(({ result }) => didAgentFail(result))) {
        this.applyEvent({ type: "stop" });
      } else {
        this.applyEvent({ type: "parallelBuildDone" });
      }
      this.currentAbort = undefined;
      this.postState();
      if (!ctrl.signal.aborted && results.every(({ result }) => !didAgentFail(result))) {
        await this.afterSuccessfulBuild();
      }
    });
  }

  private async afterSuccessfulBuild(): Promise<void> {
    if (!autoVerifyAfterBuild()) return;
    const result = await this.runVerificationInternal("afterBuild");
    if (
      verificationPassed(result) &&
      autoRequestReviewAfterPassingVerification() &&
      (this.state.name === "BuildDone" || this.state.name === "ParallelBuildDone")
    ) {
      await this.appendSystemMessage("Hydra auto-review started because verification passed after build.");
      await this.requestReview();
    }
  }

  private enqueueWikiMaintenanceAfterTurn(source: string): void {
    const wrapupSource = hydraWikiWrapupSourceFromMessages(this.messages, wikiWrapupMaxSourceChars());
    const cap = this.wikiContextRefreshTranscriptMaxChars();
    const refreshSource = cap > 0
      ? hydraWikiContextRefreshSourceFromMessages(this.messages, cap)
      : undefined;

    const run = async () => {
      await this.maybeRunWikiWrapup(source, wrapupSource ? { sourceOverride: wrapupSource } : {});
      await this.maybeRunWikiContextRefresh(source, { cap, sourceOverride: refreshSource });
    };
    const previous = this.wikiMaintenanceQueue.catch(() => {
      // Earlier background wiki maintenance errors are recorded per run below.
    });
    this.wikiMaintenanceQueue = previous.then(run).catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      await this.recordEvent("error", `Hydra background wiki maintenance failed after ${source}: ${message}`, { source });
    });
  }

  private async maybeRunWikiWrapup(source: string, options: WikiWrapupOptions = {}): Promise<void> {
    const force = !!options.force;
    const manual = !!options.manual;
    const skip = async (reason: string, detail: string, data: Record<string, string | number | boolean | null> = {}) => {
      await this.recordEvent("diagnostic", `Hydra wiki wrapup skipped after ${source}: ${detail}`, {
        source,
        reason,
        forced: force,
        manual,
        ...data,
      });
      if (manual) {
        await this.appendSystemMessage(`Hydra wiki wrapup skipped: ${detail}`);
        this.postState();
      }
    };

    if (!force && !wikiWrapupEnabled()) {
      await skip("disabled", "hydraRoom.wikiWrapupEnabled is false");
      return;
    }
    if (!this.workspaceReady) {
      await skip("workspace-not-ready", "no workspace folder is ready");
      return;
    }
    if (this.wikiWrapupInFlight) {
      await skip("already-running", "another wiki wrapup is already running");
      return;
    }
    if (this.sessionCostCapExceeded()) {
      await skip("cost-cap", "the session cost cap has been reached");
      return;
    }
    const wrapupSource = options.sourceOverride ?? hydraWikiWrapupSourceFromMessages(this.messages, wikiWrapupMaxSourceChars());
    if (!wrapupSource) {
      await skip("no-source", "no completed room turn with an agent reply is available");
      return;
    }
    if (!force && wrapupSource.key === this.lastWikiWrapupSourceKey) {
      await skip("duplicate-source", "the latest room turn was already considered", {
        sourceSha256: wrapupSource.sha256,
        sourceKind: wrapupSource.kind,
      });
      return;
    }

    this.lastWikiWrapupSourceKey = wrapupSource.key;
    this.wikiWrapupInFlight = true;
    // Per-run controller so Stop/archive/reset/dispose can cancel this wrapup
    // mid-flight; cleared in the finally below.
    const wikiAbort = new AbortController();
    this.wikiMaintenanceAbort = wikiAbort;
    const agent = this.wikiWrapupAgent();
    const traceSource = `${source} wiki wrapup`;
    try {
      await this.recordEvent("diagnostic", `Hydra wiki wrapup started after ${source}.`, {
        agent,
        source: traceSource,
        forced: force,
        manual,
        sourceSha256: wrapupSource.sha256,
        sourceKind: wrapupSource.kind,
        sourceChars: wrapupSource.markdown.length,
        sourceTruncated: wrapupSource.truncated,
      });
      if (manual) {
        await this.appendSystemMessage(`Hydra wiki wrapup started with ${AGENT_NAMES[agent]}.`);
        this.postState();
      }
      const files = await readHydraWikiFiles(this.workspaceRoot);
      const nowIso = new Date().toISOString();
      const sourcePath = hydraWikiWrapupSourcePath(wrapupSource, nowIso);
      const prompt = buildHydraWikiWrapupPrompt({
        nowIso,
        files,
        source: { ...wrapupSource, rawSourcePath: sourcePath },
      });
      const result = await this.runWikiWrapupAgent(agent, prompt, wikiAbort.signal);
      if (didAgentFail(result.result)) {
        await this.recordEvent("error", `Hydra wiki wrapup failed after ${source}.`, {
          agent,
          exitCode: result.result.exitCode,
          timedOut: result.result.timedOut,
        });
        if (manual) {
          await this.appendSystemMessage(
            `Hydra wiki wrapup failed: exitCode=${result.result.exitCode ?? "null"}, timedOut=${result.result.timedOut ? "true" : "false"}.`
          );
        }
        return;
      }

      const draft = parseHydraWikiWrapupResponse(result.text);
      if (!draft) {
        await this.recordEvent("error", `Hydra wiki wrapup returned unparseable JSON after ${source}.`, { agent });
        if (manual) {
          await this.appendSystemMessage("Hydra wiki wrapup failed: the maintainer agent returned unparseable JSON.");
        }
        return;
      }
      const storedSource = draft.changed
        ? await writeHydraWikiWrapupSource(this.workspaceRoot, wrapupSource, nowIso)
        : undefined;
      const applied = await applyHydraWikiWrapupDraft(this.workspaceRoot, draft, nowIso, storedSource);
      const pruned = await pruneHydraWikiRawTurns(this.workspaceRoot, nowIso, wikiRawTurnsKeepDays());
      if (pruned.invalidNowIso) {
        await this.recordEvent("error", "Hydra wiki raw source pruning skipped because the current timestamp was unparseable.", {
          agent,
          source: traceSource,
          nowIso: pruned.invalidNowIso,
        });
      }
      if (applied.changed) {
        const data: Record<string, string | number | boolean | null> = {
          agent,
          source: traceSource,
          contextChanged: applied.contextChanged,
          indexChanged: applied.indexChanged,
          logAppended: applied.logAppended,
          rawSourcesPruned: pruned.prunedPaths.length,
        };
        if (applied.rawSourcePath) data.rawSourcePath = applied.rawSourcePath;
        if (applied.rawSourceSha256) data.rawSourceSha256 = applied.rawSourceSha256;
        await this.recordEvent("commandInvoked", `Hydra wiki wrapup updated ${applied.title}.`, {
          ...data,
        });
        if (manual) {
          const raw = applied.rawSourcePath ? ` Raw source: \`${applied.rawSourcePath}\`.` : "";
          await this.appendSystemMessage(`Hydra wiki wrapup updated \`${applied.title}\`.${raw}`);
        }
      } else if (pruned.prunedPaths.length > 0) {
        await this.recordEvent("commandInvoked", `Hydra wiki pruned ${pruned.prunedPaths.length} raw source snapshot(s).`, {
          agent,
          source: traceSource,
          rawSourcesPruned: pruned.prunedPaths.length,
        });
        if (manual) {
          await this.appendSystemMessage(`Hydra wiki wrapup made no content changes and pruned ${pruned.prunedPaths.length} raw source snapshot(s).`);
        }
      } else {
        await this.recordEvent("diagnostic", `Hydra wiki wrapup completed with no durable wiki changes after ${source}.`, {
          agent,
          source: traceSource,
          rawSourcesPruned: 0,
        });
        if (manual) {
          await this.appendSystemMessage("Hydra wiki wrapup completed with no durable wiki changes.");
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.recordEvent("error", `Hydra wiki wrapup failed after ${source}: ${message}`, { agent });
      if (manual) {
        await this.appendSystemMessage(`Hydra wiki wrapup failed: ${message}`);
      }
    } finally {
      this.wikiWrapupInFlight = false;
      if (this.wikiMaintenanceAbort === wikiAbort) this.wikiMaintenanceAbort = undefined;
      this.postState();
    }
  }

  private async maybeRunWikiContextRefresh(
    source: string,
    options: { cap?: number; sourceOverride?: HydraWikiWrapupSource } = {}
  ): Promise<void> {
    const cap = options.cap ?? this.wikiContextRefreshTranscriptMaxChars();
    if (cap <= 0) {
      this.lastWikiRefreshTranscriptBucket = 0;
      return;
    }

    const refreshSource = options.sourceOverride ?? hydraWikiContextRefreshSourceFromMessages(this.messages, cap);
    if (!refreshSource || refreshSource.originalChars < cap) {
      this.lastWikiRefreshTranscriptBucket = 0;
      return;
    }

    const bucket = Math.floor(refreshSource.originalChars / cap);
    if (bucket <= this.lastWikiRefreshTranscriptBucket) return;
    this.lastWikiRefreshTranscriptBucket = bucket;

    await this.recordEvent("diagnostic", `Hydra wiki context refresh threshold reached after ${source}.`, {
      source,
      transcriptChars: refreshSource.originalChars,
      promptTranscriptMaxChars: cap,
      bucket,
      sourceSha256: refreshSource.sha256,
    });
    await this.maybeRunWikiWrapup(`${source} context refresh`, { sourceOverride: refreshSource });
  }

  private async runWikiWrapupAgent(
    agent: AgentId,
    prompt: string,
    signal: AbortSignal
  ): Promise<{ text: string; result: RunResult }> {
    const phase: Phase = "opener";
    const traceId = `${makeTraceId(agent, phase)}-wiki-wrapup`;
    const startedAt = Date.now();
    const promptSha256 = sha256(prompt);
    let spawn = this.buildSpawn(agent, phase);
    spawn = { ...spawn, command: await resolveAgentCommand(agent, spawn.command) };
    const consent = await this.ensureFullNativeConsent(agent, phase, spawn);
    if (!consent.allowed) {
      await this.appendAgentCallTrace({
        id: traceId,
        event: "fullNativeConsentDenied",
        kind: "wikiWrapup",
        timestamp: new Date().toISOString(),
        agent,
        phase,
        transport: "oneShot",
        promptChars: prompt.length,
        promptSha256,
      });
      return {
        text: consent.message ?? "",
        result: {
          stdout: "",
          stderr: consent.message ?? "Hydra cancelled the wiki wrapup call because full native authority was not confirmed.",
          exitCode: null,
          timedOut: false,
          cancelled: true,
        },
      };
    }
    const prepared = await this.prepareOneShotRequestFiles(agent, phase, spawn, prompt);
    // Wiki path is headless: no onChunk/onReplaceText room bubbles and no
    // run-failure card. traceKind tags every agent-call trace as "wikiWrapup".
    const normalized = await this.runOneShotPipeline(
      agent,
      phase,
      prepared,
      prompt,
      wikiWrapupTimeoutMs(),
      signal,
      traceId,
      startedAt,
      { traceKind: "wikiWrapup" }
    );
    return { text: normalized.stdout, result: normalized };
  }

  // Shared one-shot agent-transport body for both the room turn path
  // (runAgentTransport) and the headless wiki path (runWikiWrapupAgent). opts
  // toggles the optional, room-only hooks: onChunk streams live stdout into the
  // pending bubble, onReplaceText swaps in a normalized native reply, and
  // recordFailureCard pins a failure card. The wiki path passes none of these
  // (and traceKind:"wikiWrapup") to keep its no-room-bubble behavior.
  private async runOneShotPipeline(
    agent: AgentId,
    phase: Phase,
    prepared: PreparedOneShotSpawn,
    prompt: string,
    timeout: number,
    signal: AbortSignal,
    traceId: string,
    startedAt: number,
    opts: {
      traceKind?: "wikiWrapup";
      onChunk?: (chunk: string) => void;
      onReplaceText?: (text: string) => void;
      onLiveChannelEvent?: (event: LiveChannelEvent) => void;
      recordFailureCard?: (result: RunResult) => void;
    } = {}
  ): Promise<RunResult> {
    const { traceKind, onChunk, onReplaceText, onLiveChannelEvent, recordFailureCard } = opts;
    const spawn = prepared.spawn;
    const promptSha256 = sha256(prompt);
    await this.appendAgentCallTrace({
      id: traceId,
      event: "started",
      ...(traceKind ? { kind: traceKind } : {}),
      timestamp: new Date(startedAt).toISOString(),
      agent,
      phase,
      transport: "oneShot",
      cwd: spawn.cwd,
      command: spawn.command,
      args: spawn.args,
      envKeys: Object.keys(spawn.env ?? {}).sort(),
      timeoutMs: timeout,
      promptChars: prompt.length,
      promptSha256,
      requestFiles: requestFileTrace(prepared),
      outputMode: prepared.outputMode,
    });
    // claudeStreamJson/codexJson stdout is typed JSONL, not displayable text -
    // extract assistant-text increments and stream those to the webview while
    // the call runs. The normalized result still replaces the streamed text at
    // completion via onReplaceText, so live text is cosmetic-only.
    const liveText = createLiveTextExtractor(prepared.outputMode);
    // Why: the shared live channel is opt-in (Many Heads Mode). Off by default
    // it writes nothing, so ordinary turns don't accumulate .hydra/live files.
    const liveChannel = manyHeadsMode()
      ? createLiveChannelWriter({
          workspaceRoot: this.workspaceRoot,
          requestId: traceId,
          agent,
          phase,
          outputMode: prepared.outputMode,
          onEvent: onLiveChannelEvent,
        })
      : undefined;
    const result = await runAgent(spawn, prompt, timeout, (chunk) => {
      liveChannel?.push(chunk);
      const text = liveText ? liveText.push(chunk) : chunk;
      if (text) onChunk?.(text);
    }, signal);
    await liveChannel?.flush();
    const normalized = await this.normalizeOneShotResult(prepared, result);
    if (prepared.outputMode === "claudeStreamJson") {
      await this.appendAgentCallTrace({
        id: traceId,
        event: "streamSummary",
        ...(traceKind ? { kind: traceKind } : {}),
        timestamp: new Date().toISOString(),
        agent,
        phase,
        transport: "oneShot",
        summary: summarizeClaudeEvents(parseClaudeEventStream(result.stdout)),
      });
    } else if (prepared.outputMode === "codexJson") {
      await this.appendAgentCallTrace({
        id: traceId,
        event: "streamSummary",
        ...(traceKind ? { kind: traceKind } : {}),
        timestamp: new Date().toISOString(),
        agent,
        phase,
        transport: "oneShot",
        summary: summarizeCodexEvents(parseCodexEventStream(result.stdout)),
      });
    }
    if (onReplaceText && normalized.stdout !== result.stdout) {
      onReplaceText(normalized.stdout);
    }
    recordFailureCard?.(normalized);
    await this.appendAgentCallTrace(
      traceKind
        ? { ...completedAgentCallTrace(traceId, agent, phase, "oneShot", startedAt, normalized), kind: traceKind }
        : completedAgentCallTrace(traceId, agent, phase, "oneShot", startedAt, normalized)
    );
    // Why: usage must parse the RAW stdout. normalizeOneShotResult swaps in
    // the --output-last-message reply text for plain Codex, which drops the
    // trailing "tokens used" footer and silently disabled Codex usage rows.
    await this.extractAndRecordUsage({ agent, phase, requestId: traceId, result, outputMode: prepared.outputMode });
    return normalized;
  }

  private autoAdvanceExplainer(): string {
    const latest = this.decisions[this.decisions.length - 1];
    if (!latest) return "";
    const truncate = (s: string | undefined, n: number) => {
      const v = (s ?? "").replace(/\s+/g, " ").trim();
      if (!v) return "(none)";
      return v.length > n ? `${v.slice(0, n - 1).trimEnd()}…` : v;
    };
    return [
      "\n  why: ",
      `${latest.agent}${latest.phase ? ` ${latest.phase}` : ""} @ ${latest.timestamp}`,
      ` · default="${truncate(latest.defaultNextAction, 80)}"`,
      ` · needs-user=${truncate(latest.decisionNeededFromUser, 30)}`,
      ` · blockers=${truncate(latest.blockers, 30)}`,
    ].join("");
  }

  private async autoAdvanceActionableDefault(source: string): Promise<void> {
    if (!autoAdvanceActionableDefaults()) return;
    if (!this.workspaceReady || isInFlight(this.state) || this.terminalPokeInFlight || this.verificationRunning) return;
    const latest = this.decisions[this.decisions.length - 1];
    if (!decisionHasNoUserBlockers(latest)) return;
    if (this.sessionCostCapExceeded()) {
      await this.appendSystemMessage(
        `Hydra auto-advance paused: session cost ${this.sessionUsage ? `$${this.sessionUsage.costUsd.toFixed(4)}` : "(unknown)"} reached hydraRoom.sessionCostCapUsd ($${sessionCostCapUsd().toFixed(2)}). Lift the cap, manually click Accept Default, or send a new message to continue.`,
      );
      return;
    }

    // Why: a Decision Packet's defaultNextAction/recommendation is agent-controlled
    // text and therefore prompt-injectable from any repo file an agent reads
    // (CLAUDE.md, AGENTS.md, source comments). Auto-executing a default that contains
    // high-blast-radius verbs (deploy/publish/force-push/migration/drop-table…) would
    // defeat the human checkpoint, so we refuse to auto-advance risky defaults and
    // require an explicit manual Accept Default. detectRiskySignals (decisions.ts)
    // documents this gate as mandatory for any caller that auto-advances a phase.
    const risk = detectRiskySignals(latest);
    if (risk.risky) {
      await this.appendSystemMessage(
        `Hydra auto-advance paused: the agent's default action contains high-risk signals (${risk.reasons.join(", ")}). Review it and click Accept Default to run it manually.`,
      );
      return;
    }

    const action = this.currentDecisionAction();
    if (action.kind === "assignBuilder" && action.builder && this.state.name === "AwaitingUser") {
      this.autoAdvanceSendInstructionCount = 0;
      this.acceptedDefaultDecisionTimestamp = action.sourceTimestamp;
      await this.appendSystemMessage(
        `Hydra auto-advanced after ${source}: ${action.detail}${this.autoAdvanceExplainer()}`
      );
      await this.assignBuilder(action.builder);
      return;
    }
    if (action.kind === "requestReview" && (this.state.name === "BuildDone" || this.state.name === "ParallelBuildDone")) {
      this.autoAdvanceSendInstructionCount = 0;
      this.acceptedDefaultDecisionTimestamp = action.sourceTimestamp;
      await this.appendSystemMessage(
        `Hydra auto-advanced after ${source}: ${action.detail}${this.autoAdvanceExplainer()}`
      );
      await this.requestReview();
      return;
    }
    if (action.kind === "handBack" && (this.state.name === "ReviewDone" || this.state.name === "ParallelReviewDone")) {
      this.autoAdvanceSendInstructionCount = 0;
      this.acceptedDefaultDecisionTimestamp = action.sourceTimestamp;
      await this.appendSystemMessage(
        `Hydra auto-advanced after ${source}: ${action.detail}${this.autoAdvanceExplainer()}`
      );
      await this.handBack();
      return;
    }
    if (action.kind === "sendInstruction" && action.instruction && isSendable(this.state)) {
      const cap = autoAdvanceSendInstructionMaxConsecutive();
      if (this.autoAdvanceSendInstructionCount >= cap) {
        await this.appendSystemMessage(
          `Hydra auto-advance paused after ${cap} consecutive send-instruction turn(s). Click Accept Default to continue or send a new message.`
        );
        return;
      }
      this.autoAdvanceSendInstructionCount += 1;
      this.acceptedDefaultDecisionTimestamp = action.sourceTimestamp;
      await this.appendSystemMessage(
        `Hydra auto-advanced after ${source} (send-instruction ${this.autoAdvanceSendInstructionCount}/${cap}): ${action.detail}${this.autoAdvanceExplainer()}`
      );
      this.autoAdvanceInProgress = true;
      try {
        await this.sendUserMessage(action.instruction, this.getFirstSpeaker());
      } finally {
        this.autoAdvanceInProgress = false;
      }
    }
  }

  private async runReviewPhase(reviewer: AgentId): Promise<void> {
    await this.runTurn(async (ctrl, registerPending) => {
      let reviewId: string | undefined;
      let reviewIdFinalized = false;
      registerPending(async () => {
        if (reviewId && !reviewIdFinalized) {
          const failure = agentCallFailureResult("Hydra review turn aborted before the reviewer could finish (internal error).");
          await this.finalizePendingMessage(reviewId, failure);
        }
      });
      // Snapshot the transcript BEFORE opening the pending bubble, otherwise the
      // reviewer's own empty entry would appear at the tail of its prompt context.
      const reviewContext = this.buildPromptContextSnapshot("review", undefined, reviewer);
      reviewId = this.openPendingMessage(reviewer, "review");
      this.pendingPromptTranscriptWindows.set(reviewId, reviewContext.transcriptWindow);
      this.postState();

      const diff = await captureGitDiff(this.workspaceRoot, diffMaxLines());
      if (diff === null) {
        // git was available at init but failed now — treat as a recoverable error,
        // mark the pending review bubble, and bail out without calling runAgent.
        const m = this.messagesById.get(reviewId);
        if (m) {
          m.pending = false;
          m.error = true;
          m.text = "[git diff failed; cannot review]";
          await appendMessage(this.transcriptUri.fsPath, {
            role: m.role, text: m.text, timestamp: m.timestamp, phase: m.phase, error: true,
          });
        }
        this.pendingPromptTranscriptWindows.delete(reviewId);
        reviewIdFinalized = true;
        this.applyEvent({ type: "reviewDone", approved: false });
        this.currentAbort = undefined;
        this.postState();
        return;
      }
      const otherAgent: AgentId = reviewer === "codex" ? "claude" : "codex";
      // Capture current HEAD so the review prompt can flag verification
      // records made against a different commit than what's now being reviewed.
      const currentHead = this.gitAvailable ? await captureGitHead(this.workspaceRoot) : undefined;
      const reviewEnvelope = await this.buildPromptEnvelope({
        agent: reviewer,
        otherAgent,
        phase: "review",
        transcript: reviewContext.text,
        diff,
        verification: verificationAsReviewContext(this.latestVerification(), currentHead),
      });
      await this.persistPromptEnvelope(reviewEnvelope);
      const result = await this.callAgent(reviewer, "review", reviewEnvelope.renderedPrompt, reviewId, ctrl.signal);
      reviewIdFinalized = true;

      if (ctrl.signal.aborted) {
        this.applyEvent({ type: "stop" });
      } else {
        const approved = APPROVED_SENTINEL_RE.test(result.text);
        this.applyEvent({ type: "reviewDone", approved });
      }
      this.currentAbort = undefined;
      this.postState();
    });
  }

  private async runParallelReviewPhase(reviewers: AgentId[]): Promise<void> {
    await this.runTurn(async (ctrl, registerPending) => {
      const openedIds: string[] = [];
      let promiseStarted = false;
      registerPending(async () => {
        if (!promiseStarted && openedIds.length > 0) {
          const failure = agentCallFailureResult("Hydra parallel review aborted before this reviewer could finish (internal error).");
          for (const id of openedIds) {
            await this.finalizePendingMessage(id, failure);
          }
        }
      });
      const diff = await captureGitDiff(this.workspaceRoot, diffMaxLines());
      if (diff === null) {
        await this.appendSystemMessage("[git diff failed; cannot review]");
        this.applyEvent({ type: "parallelReviewDone", approved: false });
        this.currentAbort = undefined;
        this.postState();
        return;
      }
      const currentHead = this.gitAvailable ? await captureGitHead(this.workspaceRoot) : undefined;
      const calls: Promise<{ text: string; result: RunResult }>[] = [];
      for (const reviewer of reviewers) {
        const reviewContext = this.buildPromptContextSnapshot("review", undefined, reviewer);
        const reviewEnvelope = await this.buildPromptEnvelope({
          agent: reviewer,
          otherAgent: otherAgent(reviewer),
          phase: "review",
          transcript: reviewContext.text,
          diff,
          verification: verificationAsReviewContext(this.latestVerification(), currentHead),
        });
        await this.persistPromptEnvelope(reviewEnvelope);
        const messageId = this.openPendingMessage(reviewer, "review");
        this.pendingPromptTranscriptWindows.set(messageId, reviewContext.transcriptWindow);
        openedIds.push(messageId);
        calls.push(this.callAgent(reviewer, "review", reviewEnvelope.renderedPrompt, messageId, ctrl.signal));
      }
      this.postState();
      promiseStarted = true;

      const results = await Promise.all(calls);
      if (ctrl.signal.aborted || results.some(({ result }) => didAgentFail(result))) {
        this.applyEvent({ type: "stop" });
      } else {
        const approved = results.every(({ text }) => APPROVED_SENTINEL_RE.test(text));
        this.applyEvent({ type: "parallelReviewDone", approved });
      }
      this.currentAbort = undefined;
      this.postState();
    });
  }

  // ---------------- agent call helper ----------------

  private async callAgent(
    agent: AgentId,
    phase: Phase,
    prompt: string,
    messageId: string,
    signal: AbortSignal,
    forceTerminalBridge = false,
    traceIdOverride?: string,
    manyHeadsDispatch = false
  ): Promise<{ text: string; result: RunResult }> {
    let releaseClaudeCreditReservation: (() => void) | undefined;
    // Claude Agent SDK credit guard: evaluate BEFORE any spawn (timeout/pending
    // activity, consent, transport) so a `block` decision prevents
    // subscription-credit spend instead of only stopping auto-advance after the
    // spend already happened. Only Claude dispatch draws from that pool.
    if (agent === "claude") {
      const projectedDispatchUsd = claudeAgentEstimatedRunCostUsd();
      releaseClaudeCreditReservation = this.reserveClaudeCreditEstimate(projectedDispatchUsd);
      let guard: ClaudeAutomationGuardResult | undefined;
      try {
        guard = await this.evaluateClaudeCreditGuard(signal, manyHeadsDispatch);
      } catch (err) {
        releaseClaudeCreditReservation();
        releaseClaudeCreditReservation = undefined;
        throw err;
      }
      if (guard?.decision === "block") {
        releaseClaudeCreditReservation();
        releaseClaudeCreditReservation = undefined;
        const traceId = traceIdOverride ?? makeTraceId(agent, phase);
        await this.appendAgentCallTrace({
          id: traceId,
          event: "claudeCreditGuardBlocked",
          timestamp: new Date().toISOString(),
          agent,
          phase,
          transport: this.transportMode(),
          promptChars: prompt.length,
          promptSha256: sha256(prompt),
          reason: guard.reason,
        });
        await this.appendSystemMessage(
          `Hydra blocked the Claude ${phase} call to protect the Agent SDK credit pool: ${guard.reason}`
        );
        const result: RunResult = { stdout: "", stderr: guard.reason, exitCode: null, timedOut: false, cancelled: true };
        await this.finalizePendingMessage(messageId, result);
        const finalized = this.messagesById.get(messageId);
        return { text: finalized?.text ?? "", result };
      }
      if (guard?.decision === "warn" && !this.claudeCreditWarned) {
        this.claudeCreditWarned = true;
        await this.appendSystemMessage(`Hydra Claude automation credit warning: ${guard.reason}`);
      }
    }
    const timeout = agentTimeoutMs(phase);
    const activity = this.startPendingActivity(messageId, agent, phase, timeout);
    let spawn: AgentSpawn;
    try {
      spawn = this.buildSpawn(agent, phase);
      spawn = { ...spawn, command: await resolveAgentCommand(agent, spawn.command) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const traceId = makeTraceId(agent, phase);
      const startedAt = Date.now();
      await this.appendAgentCallTrace({
        id: traceId,
        event: "resolveFailed",
        timestamp: new Date().toISOString(),
        agent,
        phase,
        transport: this.transportMode(),
        promptChars: prompt.length,
        promptSha256: sha256(prompt),
        error: message,
      });
      const result: RunResult = {
        stdout: "",
        stderr: message,
        exitCode: null,
        timedOut: false,
        cancelled: false,
      };
      this.recordRunFailureCard(messageId, {
        id: traceId,
        agent,
        phase,
        transport: this.transportMode(),
        startedAt,
        result,
        promptSha256: sha256(prompt),
      });
      await this.finalizePendingMessage(messageId, result);
      activity.stop();
      releaseClaudeCreditReservation?.();
      releaseClaudeCreditReservation = undefined;
      const finalized = this.messagesById.get(messageId);
      return { text: finalized?.text ?? "", result };
    }
    let consent: { allowed: boolean; message?: string };
    try {
      consent = await this.ensureFullNativeConsent(agent, phase, spawn);
    } catch (err) {
      // ensureFullNativeConsent awaits VS Code modal/state APIs that can reject;
      // this await sits outside the final try/finally, so release the in-flight
      // Claude credit reservation here or it stays elevated for the session.
      activity.stop();
      releaseClaudeCreditReservation?.();
      releaseClaudeCreditReservation = undefined;
      throw err;
    }
    if (!consent.allowed) {
      const message = consent.message ?? `Hydra cancelled the ${agent} ${phase} call because full native authority was not confirmed.`;
      await this.appendAgentCallTrace({
        id: makeTraceId(agent, phase),
        event: "fullNativeConsentDenied",
        timestamp: new Date().toISOString(),
        agent,
        phase,
        transport: this.transportMode(),
        promptChars: prompt.length,
        promptSha256: sha256(prompt),
      });
      const result: RunResult = {
        stdout: "",
        stderr: message,
        exitCode: null,
        timedOut: false,
        cancelled: true,
      };
      await this.finalizePendingMessage(messageId, result);
      activity.stop();
      releaseClaudeCreditReservation?.();
      releaseClaudeCreditReservation = undefined;
      const finalized = this.messagesById.get(messageId);
      return { text: finalized?.text ?? "", result };
    }
    try {
      const result = await this.runAgentTransport(agent, phase, spawn, prompt, messageId, timeout, signal, forceTerminalBridge, traceIdOverride, activity.markOutput);
      await this.finalizePendingMessage(messageId, result);
      const finalized = this.messagesById.get(messageId);
      return { text: finalized?.text ?? "", result };
    } finally {
      activity.stop();
      releaseClaudeCreditReservation?.();
    }
  }

  private async ensureFullNativeConsent(
    agent: AgentId,
    phase: Phase,
    spawn: AgentSpawn
  ): Promise<{ allowed: boolean; message?: string }> {
    const authority = classifyAgentAuthority(agent, phase, spawn.args);
    const stateKey = fullNativeConsentKey(agent);
    const alreadyConsented = this.context.workspaceState.get<boolean>(stateKey, false);
    const decision = evaluateFullNativeConsent({
      agent,
      authorityLevel: authority.level,
      alreadyConsented,
    });
    if (decision.kind === "allow") return { allowed: true };

    const choice = await vscode.window.showWarningMessage(
      `Run ${agent} with full native authority? This bypasses sandbox approvals; the CLI can read, edit, and run commands without further prompts.`,
      { modal: true, detail: `${authority.label} — ${authority.detail}` },
      FULL_NATIVE_CONSENT_RUN_ONCE,
      FULL_NATIVE_CONSENT_ALWAYS,
      FULL_NATIVE_CONSENT_CANCEL
    );
    const resolution = resolveFullNativeConsentChoice(choice);
    if (resolution.kind === "allow") {
      if (resolution.persist) {
        await this.context.workspaceState.update(stateKey, true);
        await this.appendSystemMessage(
          `Full native authority approved for ${agent} in this workspace. Hydra will not prompt again until consent is revoked.`
        );
      } else {
        await this.appendSystemMessage(
          `Full native authority approved for one ${agent} call.`
        );
      }
      return { allowed: true };
    }
    const message = `Hydra cancelled the ${agent} ${phase} call because full native authority was not confirmed.`;
    await this.appendSystemMessage(message);
    return { allowed: false, message };
  }

  private async runAgentTransport(
    agent: AgentId,
    phase: Phase,
    spawn: AgentSpawn,
    prompt: string,
    messageId: string,
    timeout: number,
    signal: AbortSignal,
    forceTerminalBridge = false,
    traceIdOverride?: string,
    markOutput?: () => void
  ): Promise<RunResult> {
    const traceId = traceIdOverride ?? makeTraceId(agent, phase);
    const startedAt = Date.now();
    const promptSha256 = sha256(prompt);
    try {
      if (forceTerminalBridge || this.transportMode() === "terminalBridge") {
        if (!this.terminalBridge) {
          return agentCallFailureResult("Terminal bridge is not available because no workspace terminal was initialized.");
        }
        const terminalPrepared = this.prepareTerminalBridgeSpawn(agent, spawn);
        await this.appendAgentCallTrace({
          id: traceId,
          event: "started",
          timestamp: new Date(startedAt).toISOString(),
          agent,
          phase,
          transport: "terminalBridge",
          cwd: terminalPrepared.spawn.cwd,
          command: terminalPrepared.spawn.command,
          args: terminalPrepared.spawn.args,
          envKeys: Object.keys(terminalPrepared.spawn.env ?? {}).sort(),
          timeoutMs: timeout,
          promptChars: prompt.length,
          promptSha256,
          outputMode: terminalPrepared.outputMode,
        });
        // JSON-mode bridge logs are typed JSONL - extract assistant-text
        // increments for live display, then REPLACE with the authoritative
        // normalized reply at completion (streamed text is cosmetic-only).
        // Plain mode deliberately passes NO chunk callback: the ANSI-stripped
        // log stream and the raw reply.text are not byte-identical, so
        // waitForReply's unstreamedTail de-dup can diverge and double-render
        // the reply into the transcript - keep the pre-streaming single
        // append for that mode.
        const liveText = createLiveTextExtractor(terminalPrepared.outputMode);
        const onLiveChunk = liveText
          ? (chunk: string) => {
              markOutput?.();
              const text = liveText.push(chunk);
              if (!text) return;
              const live = this.messagesById.get(messageId);
              if (live) live.text += text;
              this.panel.webview.postMessage({ type: "chunk", messageId, text });
            }
          : undefined;
        const result = await this.terminalBridge.callAgent(
          agent,
          phase,
          terminalPrepared.spawn,
          prompt,
          timeout,
          signal,
          onLiveChunk
        );
        const normalized = await this.normalizeTerminalBridgeResult(terminalPrepared.outputMode, result);
        const m = this.messagesById.get(messageId);
        if (m && normalized.stdout) {
          if (terminalPrepared.outputMode === "plain") {
            m.text += normalized.stdout;
            this.panel.webview.postMessage({ type: "chunk", messageId, text: normalized.stdout });
          } else {
            m.text = normalized.stdout;
            this.panel.webview.postMessage({ type: "replaceMessageText", messageId, text: normalized.stdout });
          }
        }
        this.recordRunFailureCard(messageId, {
          id: traceId,
          agent,
          phase,
          transport: "terminalBridge",
          startedAt,
          result: normalized,
          promptSha256,
          requestFiles: requestFileTrace(normalized),
        });
        await this.appendAgentCallTrace(completedAgentCallTrace(traceId, agent, phase, "terminalBridge", startedAt, normalized));
        await this.extractAndRecordUsage({
          agent,
          phase,
          requestId: traceId,
          result: await this.terminalBridgeUsageResult(normalized),
          outputMode: terminalPrepared.outputMode,
        });
        return normalized;
      }

      const prepared = await this.prepareOneShotRequestFiles(agent, phase, spawn, prompt);
      return await this.runOneShotPipeline(agent, phase, prepared, prompt, timeout, signal, traceId, startedAt, {
        onChunk: (chunk) => {
          markOutput?.();
          const m = this.messagesById.get(messageId);
          if (m) m.text += chunk;
          this.panel.webview.postMessage({ type: "chunk", messageId, text: chunk });
        },
        onReplaceText: (text) => {
          const m = this.messagesById.get(messageId);
          if (m) {
            m.text = text;
            this.panel.webview.postMessage({ type: "replaceMessageText", messageId, text });
          }
        },
        onLiveChannelEvent: (event) => this.appendMessageLiveChannelEvent(messageId, event),
        recordFailureCard: (normalized) => {
          this.recordRunFailureCard(messageId, {
            id: traceId,
            agent,
            phase,
            transport: "oneShot",
            startedAt,
            result: normalized,
            promptSha256,
            requestFiles: requestFileTrace(prepared),
          });
        },
      });
    } catch (err) {
      const result = agentCallFailureResult(err instanceof Error ? err.message : String(err));
      this.recordRunFailureCard(messageId, {
        id: traceId,
        agent,
        phase,
        transport: this.transportMode(),
        startedAt,
        result,
        promptSha256,
      });
      await this.appendAgentCallTrace(completedAgentCallTrace(traceId, agent, phase, this.transportMode(), startedAt, result));
      return result;
    }
  }

  private async prepareOneShotRequestFiles(
    agent: AgentId,
    phase: Phase,
    spawn: AgentSpawn,
    prompt: string
  ): Promise<PreparedOneShotSpawn> {
    const codexJson = agent === "codex" && shouldUseCodexJson(spawn);
    // codexJson supersedes codexCaptureLastMessage: the --json stream
    // already carries the final agent_message item, so the extra
    // --output-last-message file is redundant when codexJson is on.
    const codexLastMessage = agent === "codex" && !codexJson && shouldCaptureCodexLastMessage(spawn);
    const claudeStreamJson = agent === "claude" && shouldUseClaudeStreamJson(spawn);
    const needsRequestFiles =
      hasRequestFilePlaceholders(spawn) ||
      codexLastMessage ||
      (agent === "claude" && shouldCreateClaudeRequestFiles(spawn));
    if (!needsRequestFiles) {
      let preparedSpawn = spawn;
      if (claudeStreamJson) preparedSpawn = withClaudeStreamJsonArgs(preparedSpawn);
      if (codexJson) preparedSpawn = withCodexJsonArgs(preparedSpawn);
      const outputMode = claudeStreamJson ? "claudeStreamJson" : codexJson ? "codexJson" : "plain";
      return {
        spawn: preparedSpawn,
        outputMode,
      };
    }
    const requestId = `${Date.now()}-${crypto.randomUUID()}`;
    const paths = terminalProtocolPaths(this.workspaceRoot, requestId, agent, phase);
    await fs.mkdir(path.dirname(paths.promptPath), { recursive: true });
    await fs.mkdir(path.dirname(paths.replyPath), { recursive: true });
    await fs.mkdir(path.dirname(paths.logPath), { recursive: true });
    await fs.writeFile(paths.promptPath, buildTerminalPromptFile(agent, phase, prompt, paths.replyPath), "utf8");
    await fs.writeFile(paths.logPath, "", "utf8");
    let preparedSpawn = expandRequestFileSpawn(spawn, {
      hydraPromptFile: paths.promptPath,
      hydraReplyFile: paths.replyPath,
      hydraLogFile: paths.logPath,
    });
    if (codexLastMessage) preparedSpawn = withCodexLastMessageArgs(preparedSpawn, paths.replyPath);
    if (codexJson) preparedSpawn = withCodexJsonArgs(preparedSpawn);
    if (claudeStreamJson) preparedSpawn = withClaudeStreamJsonArgs(preparedSpawn, paths.logPath);
    const outputMode = claudeStreamJson ? "claudeStreamJson" : codexJson ? "codexJson" : "plain";
    return {
      spawn: preparedSpawn,
      promptPath: paths.promptPath,
      replyPath: paths.replyPath,
      logPath: paths.logPath,
      outputMode,
    };
  }

  private prepareTerminalBridgeSpawn(
    agent: AgentId,
    spawn: AgentSpawn
  ): { spawn: AgentSpawn; outputMode: "plain" | "claudeStreamJson" | "codexJson" } {
    if (agent === "claude" && shouldUseClaudeStreamJson(spawn)) {
      return { spawn: withClaudeStreamJsonArgs(spawn), outputMode: "claudeStreamJson" };
    }
    if (agent === "codex" && spawn.args.includes("exec")) {
      // Why: users may prefix global codex flags (e.g. `--config sandbox_mode=...`)
      // before `exec`. The previous `args[0] === "exec"` check missed those argv
      // shapes, so the terminal bridge fell back to plain output and re-leaked the
      // full prompt transcript into the visible terminal — the exact symptom the
      // codexJson force-on was added to fix.
      return {
        spawn: spawn.args.includes("--json") || spawn.args.includes("--experimental-json")
          ? spawn
          : withCodexJsonArgs(spawn),
        outputMode: "codexJson",
      };
    }
    return { spawn, outputMode: "plain" };
  }

  private async normalizeOneShotResult(prepared: PreparedOneShotSpawn, result: RunResult): Promise<RunResult> {
    let stdout = result.stdout;
    if (prepared.outputMode === "claudeStreamJson") {
      stdout = roomTextFromClaudeStreamJson(result.stdout);
    } else if (prepared.outputMode === "codexJson") {
      stdout = roomTextFromCodexJson(result.stdout);
    }
    if (prepared.replyPath) {
      try {
        const replyText = (await fs.readFile(prepared.replyPath, "utf8")).trimEnd();
        if (replyText.trim()) stdout = replyText;
      } catch {
        // Older CLIs and failed runs may not produce a native reply file.
      }
    }
    return guardNativeReply({ ...result, stdout });
  }

  private async normalizeTerminalBridgeResult(
    outputMode: "plain" | "claudeStreamJson" | "codexJson",
    result: RunResult & { promptPath?: string; logPath?: string; replyPath?: string }
  ): Promise<RunResult & { promptPath?: string; logPath?: string; replyPath?: string }> {
    let stdout = result.stdout;
    const raw = await this.terminalBridgeRawOutput(result);
    if (outputMode === "claudeStreamJson") {
      stdout = roomTextFromClaudeStreamJson(raw);
    } else if (outputMode === "codexJson") {
      stdout = roomTextFromCodexJson(raw);
    }
    return guardNativeReply({ ...result, stdout });
  }

  private async terminalBridgeUsageResult(result: RunResult & { logPath?: string }): Promise<RunResult> {
    return { ...result, stdout: await this.terminalBridgeRawOutput(result) };
  }

  private async terminalBridgeRawOutput(result: RunResult & { logPath?: string }): Promise<string> {
    if (!result.logPath) return result.stdout;
    try {
      const raw = await fs.readFile(result.logPath, "utf8");
      return raw || result.stdout;
    } catch {
      // Terminal logs are best-effort diagnostics; fall back to the parsed reply.
      return result.stdout;
    }
  }

  private buildSpawn(agent: AgentId, phase: Phase): AgentSpawn {
    const cfg = vscode.workspace.getConfiguration("hydraRoom");
    const command = cfg.get<string>(`${agent}Command`, agent);
    const argsKey = argsSettingKey(agent, phase);
    const cliProfile = profileForPhase(phase);
    const configuredProfile = cfg.get<string>(profileSettingKey(agent, cliProfile), "custom");
    const presetArgs = isConfigurableCapabilityProfileId(configuredProfile)
      ? argsForCapabilityProfile(agent, configuredProfile)
      : undefined;
    const rawArgs = presetArgs ?? cfg.get<string[]>(argsKey, []);
    let spawn = buildAgentSpawn(agent, phase, command, rawArgs, this.workspaceRoot);
    if (agent === "codex") spawn = withCodexSkipGitRepoCheckArgs(spawn);
    spawn = withModelArgs(spawn, agent, phase);
    spawn = withEffortArgs(spawn, agent, phase);
    return applySpawnEnvironment(
      spawn,
      this.workspaceRoot,
      mergeNativeEnv(
        cfg.get<Record<string, string>>("nativeEnv", {}),
        cfg.get<Record<string, string>>(`${agent}NativeEnv`, {})
      ),
      mergeNativePathPrepend(
        cfg.get<string[]>("nativePathPrepend", []),
        cfg.get<string[]>(`${agent}NativePathPrepend`, [])
      )
    );
  }

  private async buildNativeCommandSpawn(agent: AgentId, rawArgs: string[]): Promise<AgentSpawn> {
    const cfg = vscode.workspace.getConfiguration("hydraRoom");
    const command = cfg.get<string>(`${agent}Command`, agent);
    let spawn = buildAgentSpawn(agent, "opener", command, rawArgs, this.workspaceRoot);
    spawn = applySpawnEnvironment(
      spawn,
      this.workspaceRoot,
      mergeNativeEnv(
        cfg.get<Record<string, string>>("nativeEnv", {}),
        cfg.get<Record<string, string>>(`${agent}NativeEnv`, {})
      ),
      mergeNativePathPrepend(
        cfg.get<string[]>("nativePathPrepend", []),
        cfg.get<string[]>(`${agent}NativePathPrepend`, [])
      )
    );
    try {
      return { ...spawn, command: await resolveAgentCommand(agent, spawn.command) };
    } catch {
      return spawn;
    }
  }

  private async nativeRuntimeDiagnostics(): Promise<SupportBundleNativeRuntime[]> {
    const phases: Phase[] = ["opener", "build", "review"];
    const diagnostics: SupportBundleNativeRuntime[] = [];
    for (const agent of ["codex", "claude"] as AgentId[]) {
      for (const phase of phases) {
        const spawn = this.buildSpawn(agent, phase);
        let command = spawn.command;
        try {
          command = await resolveAgentCommand(agent, spawn.command);
        } catch {
          // The bundle should remain useful when a native binary is missing:
          // Doctor reports the failure, while this section records intent.
        }
        const envKeys = Object.keys(spawn.env ?? {}).sort((a, b) => a.localeCompare(b));
        diagnostics.push({
          agent,
          phase,
          command,
          args: spawn.args,
          cwd: spawn.cwd,
          envKeys,
          pathOverride: envKeys.some((key) => key.toLowerCase() === "path"),
        });
      }
    }
    return diagnostics;
  }

  private latestVerification(): VerificationResult | undefined {
    return this.verifications[this.verifications.length - 1];
  }

  private async buildPromptEnvelope(input: {
    agent: AgentId;
    otherAgent: AgentId;
    phase: Phase;
    transcript: string;
    diff?: string;
    verification?: string;
    currentUserMessage?: string;
    attachments?: ReturnType<typeof roomAttachmentSummaries>;
  }): Promise<PromptEnvelope> {
    const renderedPrompt = buildPrompt({
      agent: input.agent,
      otherAgent: input.otherAgent,
      phase: input.phase,
      transcript: input.transcript,
      diff: input.diff,
      verification: input.verification,
      nativeCapabilities: await this.nativeCapabilityPromptContext(input.agent, [
        input.currentUserMessage,
        this.objective,
        input.transcript,
        input.diff,
        input.verification,
      ]),
    });
    const spawn = this.buildSpawn(input.agent, input.phase);
    const authority = classifyAgentAuthority(input.agent, input.phase, spawn.args);
    const profile = describeCapabilityProfile(input.agent, input.phase, spawn.args, authority);
    let command = spawn.command;
    try {
      command = await resolveAgentCommand(input.agent, spawn.command);
    } catch {
      // Preview should still work even when the CLI is missing; Doctor owns
      // command repair and the actual call path surfaces spawn failures.
    }
    return createPromptEnvelope({
      id: `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${input.agent}-${input.phase}`,
      agent: input.agent,
      otherAgent: input.otherAgent,
      phase: input.phase,
      transport: this.transportMode(),
      cwd: spawn.cwd,
      command,
      args: spawn.args,
      authority: `${authority.label} - ${authority.detail}`,
      authorityLevel: authority.level,
      capabilityProfile: profile.id,
      capabilityProfileLabel: profile.label,
      capabilityProfileDetail: profile.detail,
      objective: this.objective,
      currentUserMessage: input.currentUserMessage,
      attachments: input.attachments,
      latestDecisionDefault: this.decisions[this.decisions.length - 1]?.defaultNextAction,
      latestVerificationSummary: verificationSummary(this.latestVerification()),
      renderedPrompt,
    });
  }

  private async nativeCapabilityPromptContext(agent: AgentId, taskContext: Array<string | undefined>): Promise<string> {
    const base = nativeCapabilitySummary(agent);
    if (!shouldIncludeNativeIntegrationSummary(...taskContext)) return base;
    const integration = await readNativeIntegrationSummary(this.nativeCapabilitiesUri.fsPath);
    if (!integration) return base;
    return [
      base,
      "",
      "Latest native integration probe summary from `.hydra/native-capabilities.md`:",
      integration,
    ].join("\n");
  }

  private async buildDirectTerminalPokeEnvelope(
    agent: AgentId,
    instruction: string,
    editorContext?: EditorContextAttachment,
    workspaceDiff?: string
  ): Promise<PromptEnvelope> {
    const phase: Phase = "opener";
    const other = otherAgent(agent);
    const renderedPrompt = buildDirectTerminalPokePrompt({
      agent,
      otherAgent: other,
      roomContext: this.buildPromptContext(phase, "terminalBridge", agent, "terminalPoke"),
      instruction,
      editorContext,
      workspaceDiff,
      latestDecisionDefault: this.decisions[this.decisions.length - 1]?.defaultNextAction,
      latestVerificationSummary: verificationSummary(this.latestVerification()),
    });
    const spawn = this.buildSpawn(agent, phase);
    const authority = classifyAgentAuthority(agent, phase, spawn.args);
    const profile = describeCapabilityProfile(agent, phase, spawn.args, authority);
    let command = spawn.command;
    try {
      command = await resolveAgentCommand(agent, spawn.command);
    } catch {
      // The actual terminal call owns command failure; the envelope should
      // still show the user's intended native CLI endpoint.
    }
    return createPromptEnvelope({
      id: `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${agent}-terminal-poke`,
      agent,
      otherAgent: other,
      phase,
      transport: "terminalBridge",
      cwd: spawn.cwd,
      command,
      args: spawn.args,
      authority: `${authority.label} - ${authority.detail}`,
      authorityLevel: authority.level,
      capabilityProfile: profile.id,
      capabilityProfileLabel: profile.label,
      capabilityProfileDetail: profile.detail,
      objective: this.objective,
      currentUserMessage: instruction,
      latestDecisionDefault: this.decisions[this.decisions.length - 1]?.defaultNextAction,
      latestVerificationSummary: verificationSummary(this.latestVerification()),
      renderedPrompt,
    });
  }

  private async persistPromptEnvelope(envelope: PromptEnvelope): Promise<void> {
    try {
      await appendPromptEnvelope(this.workspaceRoot, envelope);
    } catch {
      // Prompt indexing is audit metadata; do not fail the user turn if the
      // prompt directory is temporarily unavailable. Doctor covers .hydra I/O.
    }
  }

  private async appendAgentCallTrace(record: Record<string, unknown>): Promise<void> {
    const filePath = this.agentCallsUri.fsPath;
    try {
      await serializePerFile(filePath, async () => {
        if (!ensuredAgentCallDirs.has(filePath)) {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          ensuredAgentCallDirs.add(filePath);
        }
        await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
      });
    } catch {
      // Flight recording is diagnostic metadata. Never fail the user's agent
      // call because the trace file is temporarily unavailable.
    }
  }

  private recordRunFailureCard(messageId: string, input: Omit<Parameters<typeof createRunFailureCard>[0], "workspaceRoot">): void {
    const card = createRunFailureCard({ ...input, workspaceRoot: this.workspaceRoot });
    if (card) this.pendingRunFailures.set(messageId, card);
    else this.pendingRunFailures.delete(messageId);
  }

  private modelPrices(): { agentDefaults: Record<AgentId, ModelPrices>; modelOverrides: Record<string, Partial<ModelPrices>> } {
    const raw = vscode.workspace.getConfiguration("hydraRoom").get<Record<string, unknown>>("modelPrices");
    const agentDefaults: Record<AgentId, ModelPrices> = {
      claude: { ...DEFAULT_PRICES.claude },
      codex: { ...DEFAULT_PRICES.codex },
    };
    const modelOverrides: Record<string, Partial<ModelPrices>> = {};
    if (raw && typeof raw === "object") {
      for (const [key, value] of Object.entries(raw)) {
        if (!value || typeof value !== "object") continue;
        const v = value as Partial<ModelPrices>;
        if (key === "claude" || key === "codex") {
          // Why: coerce each field through the model-base rather than spreading
          // raw user input, so a NaN/negative agent override can't poison the
          // cost meter base it's merged into.
          agentDefaults[key] = coerceModelPrices(v, DEFAULT_PRICES[key]);
        } else {
          // Why: keep the override PARTIAL — resolveModelPrices merges it over
          // the matching per-model/per-agent base at billing time, so an
          // omitted Codex cache rate no longer inherits Claude's default.
          modelOverrides[key.toLowerCase()] = sanitizePartialModelPrices(v);
        }
      }
    }
    return { agentDefaults, modelOverrides };
  }

  private async recordUsage(input: {
    agent: AgentId;
    phase: Phase;
    requestId?: string;
    model?: string;
    source: UsageRecord["source"];
    tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number; reasoningTokens: number };
    nativeCostUsd?: number;
  }): Promise<void> {
    const { agentDefaults, modelOverrides } = this.modelPrices();
    const record = buildUsageRecord({
      sessionId: this.sessionId,
      agent: input.agent,
      phase: input.phase,
      requestId: input.requestId,
      model: input.model,
      source: input.source,
      tokens: input.tokens,
      nativeCostUsd: input.nativeCostUsd,
      prices: agentDefaults,
      modelPriceOverrides: modelOverrides,
    });
    try {
      await appendUsageRecord(this.usageUri.fsPath, record);
    } catch {
      // Usage tracking is best-effort. A write failure must not break a turn.
    }
    this.usageRecords.push(record);
    // Why: the new record always belongs to this.sessionId, so fold it into the
    // session total incrementally instead of re-scanning the whole array. The
    // weekly window is time-bounded (records age out as `now` advances), so it
    // still needs the full filtered scan to stay correct.
    this.sessionUsage = this.sessionUsage
      ? addRecordToSummary(this.sessionUsage, record)
      : summarizeUsage(this.usageRecords, this.sessionId);
    this.weeklyUsage = summarizeUsage(this.usageRecords, undefined, usageCutoffIso(7));
    // Keep the in-memory array bounded; usage.jsonl retains full history. The
    // 30-day window stays >= the 7-day weekly cutoff so the recompute above is
    // unaffected, and current-session rows are never older than the window.
    this.usageRecords = boundUsageRecords(this.usageRecords);
    this.postState();
  }

  private async extractAndRecordUsage(args: {
    agent: AgentId;
    phase: Phase;
    requestId?: string;
    result: RunResult;
    outputMode?: "plain" | "claudeStreamJson" | "codexJson" | "passthrough";
  }): Promise<void> {
    if (args.result.cancelled || args.result.timedOut) return;
    const { agent, phase, requestId, result, outputMode } = args;
    const model = modelForPhase(agent, phase) || undefined;
    if (agent === "claude" && outputMode === "claudeStreamJson") {
      const summary = summarizeClaudeEvents(parseClaudeEventStream(result.stdout));
      const tokens = usageFromClaudeSummary(summary.usage);
      if (tokens) {
        await this.recordUsage({ agent, phase, requestId, model, source: "claudeStreamJson", tokens, nativeCostUsd: summary.totalCostUsd });
        return;
      }
    }
    if (agent === "codex" && outputMode === "codexJson") {
      const summary = summarizeCodexEvents(parseCodexEventStream(result.stdout));
      const tokens = usageFromCodexSummary(summary.usage);
      if (tokens) {
        await this.recordUsage({ agent, phase, requestId, model, source: "codexJson", tokens });
        return;
      }
    }
    if (agent === "codex") {
      // Why: `codex exec` prints the "tokens used" footer to STDERR (stdout
      // carries only the agent reply); parsing stdout alone never matched, so
      // plain Codex turns recorded no usage row. Terminal-bridge merges the raw
      // log into stdout, so concatenating both covers oneShot and bridge.
      const total = parseCodexTextTokens(`${result.stdout}\n${result.stderr}`);
      if (total !== undefined && total > 0) {
        // Why: the plain-text footer is the session TOTAL (input + cached +
        // output + reasoning) with no split. Agentic sessions are dominated
        // by (cached) input, so billing the whole total as output inflated
        // the cost estimate ~8x (gpt-5.5: $10/MTok out vs $1.25/MTok in).
        // Bill at the input rate instead; enable hydraRoom.codexJson for
        // exact splits from turn.completed events.
        await this.recordUsage({
          agent,
          phase,
          requestId,
          model,
          source: "codexTextTokens",
          tokens: { inputTokens: total, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
        });
      }
    }
  }

  private async buildNextPromptPreviewEnvelope(draftText: string, opener: AgentId): Promise<PromptEnvelope> {
    const draftWithAttachments = this.prepareUserMessageWithAttachments(draftText, false);
    if (this.state.name === "BuildDone" && this.gitAvailable) {
      const reviewer: AgentId = this.state.builder === "codex" ? "claude" : "codex";
      const diff = await captureGitDiff(this.workspaceRoot, diffMaxLines());
      return await this.buildPromptEnvelope({
        agent: reviewer,
        otherAgent: this.state.builder,
        phase: "review",
        transcript: this.buildPromptContext("review", undefined, reviewer),
        diff: diff ?? "[git diff failed; preview cannot include diff]",
        verification: verificationAsReviewContext(this.latestVerification()),
      });
    }

    if (this.state.name === "ParallelBuildDone" && this.gitAvailable) {
      const diff = await captureGitDiff(this.workspaceRoot, diffMaxLines());
      return await this.buildPromptEnvelope({
        agent: "codex",
        otherAgent: "claude",
        phase: "review",
        transcript: this.buildPromptContext("review", undefined, "codex"),
        diff: diff ?? "[git diff failed; preview cannot include diff]",
        verification: verificationAsReviewContext(this.latestVerification()),
      });
    }

    if (this.state.name === "ReviewDone" && !this.state.approved && !draftText.trim()) {
      const builder: AgentId = this.state.reviewer === "codex" ? "claude" : "codex";
      return await this.buildPromptEnvelope({
        agent: builder,
        otherAgent: this.state.reviewer,
        phase: "build",
        transcript: this.buildPromptContext("build", undefined, builder),
      });
    }

    if (this.state.name === "ParallelReviewDone" && !this.state.approved && !draftText.trim()) {
      return await this.buildPromptEnvelope({
        agent: "codex",
        otherAgent: "claude",
        phase: "build",
        transcript: this.buildPromptContext("build", undefined, "codex"),
      });
    }

    const selectedOpener = normalizeAgentId(opener, this.getFirstSpeaker());
    const reactor = otherAgent(selectedOpener);
    const trimmed = draftWithAttachments.promptText.trim();
    const previewMessages = trimmed
      ? [
          ...this.messages,
          {
            role: "user" as const,
            text: trimmed,
            timestamp: new Date().toISOString(),
          },
        ]
      : this.messages;
    const phase: Phase = shouldRunParallelDiscussion(trimmed, discussionMode()) ? "parallel" : "opener";
    return await this.buildPromptEnvelope({
      agent: selectedOpener,
      otherAgent: reactor,
      phase,
      transcript: this.buildPromptContextFromMessages(previewMessages, phase, undefined, selectedOpener),
      currentUserMessage: trimmed,
      attachments: roomAttachmentSummaries(this.pendingAttachments),
    });
  }

  private currentDecisionAction(): DecisionAction {
    const latest = this.decisions[this.decisions.length - 1];
    if (latest && latest.timestamp === this.acceptedDefaultDecisionTimestamp) {
      return { kind: "none", label: "Default Accepted", detail: "The latest decision default has already been accepted." };
    }
    const action = resolveDecisionAction(latest, this.state.name);
    if (action.kind === "assignBuilder" && this.state.name !== "AwaitingUser") {
      return {
        kind: "sendInstruction",
        label: "Accept Default",
        detail: "Builder assignment is only automatic while Hydra is awaiting user input.",
        instruction: latest ? `Accepted default next action:\n\n${latest.defaultNextAction}` : undefined,
        sourceTimestamp: action.sourceTimestamp,
      };
    }
    if (action.kind === "requestReview" && this.state.name !== "BuildDone" && this.state.name !== "ParallelBuildDone") {
      return {
        kind: "sendInstruction",
        label: "Accept Default",
        detail: "Review can only be requested after a build; Hydra will send the default as an instruction.",
        instruction: latest ? `Accepted default next action:\n\n${latest.defaultNextAction}` : undefined,
        sourceTimestamp: action.sourceTimestamp,
      };
    }
    if (action.kind === "handBack" && this.state.name !== "ReviewDone" && this.state.name !== "ParallelReviewDone") {
      return {
        kind: "sendInstruction",
        label: "Accept Default",
        detail: "Hand back is only automatic after review; Hydra will send the default as an instruction.",
        instruction: latest ? `Accepted default next action:\n\n${latest.defaultNextAction}` : undefined,
        sourceTimestamp: action.sourceTimestamp,
      };
    }
    return action;
  }

  private currentWorkQueue(): WorkQueueItem[] {
    const items = buildWorkQueue({
      decisionAction: this.currentDecisionAction(),
      latestVerification: this.latestVerification(),
      nativeActions: this.nativeActions,
      maxItems: 12,
    });
    return applyWorkQueueDispositions(items, this.workQueueDispositions).slice(0, 6);
  }

  private currentAuthoritySummaries(): Record<AgentId, AgentAuthoritySummary> {
    return {
      codex: this.authoritySummaryForAgent("codex"),
      claude: this.authoritySummaryForAgent("claude"),
    };
  }

  private authoritySummaryForAgent(agent: AgentId): AgentAuthoritySummary {
    const phase = this.authorityPhaseForAgent(agent);
    const spawn = this.buildSpawn(agent, phase);
    const authority = classifyAgentAuthority(agent, phase, spawn.args);
    const profile = describeCapabilityProfile(agent, phase, spawn.args, authority);
    return { authority, profile };
  }

  private authorityPhaseForAgent(agent: AgentId): Phase {
    switch (this.state.name) {
      case "Build":
        return this.state.builder === agent ? "build" : "opener";
      case "ParallelBuild":
        return "build";
      case "BuildDone":
        return otherAgent(this.state.builder) === agent ? "review" : "build";
      case "ParallelBuildDone":
        return "review";
      case "Review":
        return this.state.reviewer === agent ? "review" : "opener";
      case "ParallelReview":
        return "review";
      case "ParallelReviewDone":
        return "build";
      case "ReviewDone":
        return this.state.reviewer === agent ? "review" : "build";
      case "ParallelDiscussion":
        return "parallel";
      default:
        return "opener";
    }
  }

  private activeEditorContext(): EditorContextAttachment | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const document = editor.document;
    if (document.isClosed) return undefined;
    // Workspace-boundary check. Without this, a file opened in a split
    // editor from outside the workspace root (e.g. ~/.ssh/id_rsa, or any
    // sensitive file the user has open elsewhere) would flow into the
    // prompt envelope and persist to .hydra/prompts/index.jsonl. Hydra's
    // attachment scope is the current workspace only.
    if (!this.isInsideWorkspace(document.uri)) return undefined;

    const selected = !editor.selection.isEmpty;
    const rawText = selected ? document.getText(editor.selection) : document.getText();
    const trimmed = rawText.trim();
    if (!trimmed) return undefined;

    const truncated = truncateEditorContext(rawText, editorContextMaxChars());
    return {
      label: this.editorContextLabel(document),
      languageId: document.languageId,
      selected,
      startLine: selected ? editor.selection.start.line + 1 : 1,
      endLine: selected ? editor.selection.end.line + 1 : Math.max(1, document.lineCount),
      text: truncated.text,
      originalChars: truncated.originalChars,
      truncated: truncated.truncated,
    };
  }

  private isInsideWorkspace(uri: vscode.Uri): boolean {
    if (uri.scheme !== "file") return false;
    if (!this.workspaceRoot) return false;
    const filePath = uri.fsPath;
    const root = this.workspaceRoot;
    if (filePath === root) return true;
    // Normalize separators so the prefix check works on Windows.
    const normalizedFile = filePath.replace(/\\/g, "/").toLowerCase();
    const normalizedRoot = root.replace(/\\/g, "/").toLowerCase();
    const rootWithSep = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
    return normalizedFile.startsWith(rootWithSep);
  }

  private editorContextLabel(document: vscode.TextDocument): string {
    if (document.uri.scheme === "file") {
      return vscode.workspace.asRelativePath(document.uri, false);
    }
    return document.uri.toString();
  }

  private attachmentSourceLabel(uri: vscode.Uri): string {
    return this.isInsideWorkspace(uri) ? vscode.workspace.asRelativePath(uri, false) : path.basename(uri.fsPath);
  }

  private prepareUserMessageWithAttachments(text: string, consume: boolean): PreparedRoomMessage {
    const trimmed = text.trim();
    const attachments = consume ? this.pendingAttachments.splice(0) : [...this.pendingAttachments];
    if (attachments.length === 0) return { displayText: trimmed, promptText: trimmed };
    const attachmentBlock = renderRoomAttachmentsForPrompt(attachments);
    const instruction = trimmed || "Please inspect the attached file(s).";
    const displaySummary = attachmentDisplaySummary(attachments);
    const displayText = trimmed ? `${trimmed}\n\n${displaySummary}` : displaySummary;
    return {
      displayText,
      promptText: `${instruction}\n\n${attachmentBlock}`,
    };
  }

  private async buildDoctorReport(includeTerminalBridge: boolean): Promise<{ report: DoctorReport; bridgeOk: boolean }> {
    const cfg = vscode.workspace.getConfiguration("hydraRoom");
    const codexCommand = cfg.get<string>("codexCommand", "codex") || "codex";
    const claudeCommand = cfg.get<string>("claudeCommand", "claude") || "claude";
    const [codexResolvedRaw, claudeResolvedRaw] = await Promise.all([
      resolveAgentCommand("codex", codexCommand),
      resolveAgentCommand("claude", claudeCommand),
    ]);
    // resolveAgentCommand echoes the bare name back when nothing was found.
    // The doctor contract is "undefined when not found", so collapse the
    // bare-name-echo case to undefined here instead of letting commandCheck
    // re-derive it.
    const collapseUnresolved = (configured: string, resolved: string): string | undefined => {
      if (!resolved) return undefined;
      if (resolved === configured && !resolved.includes("/") && !resolved.includes("\\")) return undefined;
      return resolved;
    };
    const codexResolvedCommand = collapseUnresolved(codexCommand, codexResolvedRaw);
    const claudeResolvedCommand = collapseUnresolved(claudeCommand, claudeResolvedRaw);
    const bridgeResult = includeTerminalBridge && this.terminalBridge
      ? await this.terminalBridge.selfTest(terminalBridgeTimeoutMs())
      : undefined;
    const argsValidation = collectArgsValidation(cfg);
    const report = await runHydraDoctor({
      workspaceRoot: this.workspaceRoot,
      gitAvailable: this.gitAvailable,
      codexCommand,
      codexResolvedCommand,
      claudeCommand,
      claudeResolvedCommand,
      trustWarnings: this.collectTrustScopeWarnings(),
      terminalBridge: bridgeResult ? { ok: bridgeResult.ok, message: bridgeResult.message } : undefined,
      argsValidation,
    });
    return { report, bridgeOk: bridgeResult?.ok ?? false };
  }

  private collectTrustScopeWarnings(): string[] {
    const cfg = vscode.workspace.getConfiguration("hydraRoom");
    return trustScopeWarnings(TRUST_SCOPED_SETTINGS.map((key) => {
      const inspection = cfg.inspect(key);
      return {
        key,
        workspaceValue: inspection?.workspaceValue,
        workspaceFolderValue: inspection?.workspaceFolderValue,
      };
    }));
  }

  private transportMode(): "oneShot" | "terminalBridge" {
    return this.transport;
  }

  private async migrateLegacyAgentTimeoutDefaults(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("hydraRoom");
    await this.clearLegacyAgentTimeoutSetting(cfg, "discussionTimeoutMs");
    await this.clearLegacyAgentTimeoutSetting(cfg, "oneShotTimeoutMs");
  }

  private async clearLegacyAgentTimeoutSetting(
    cfg: vscode.WorkspaceConfiguration,
    key: "discussionTimeoutMs" | "oneShotTimeoutMs"
  ): Promise<void> {
    const inspected = cfg.inspect<number>(key);
    const scopes: Array<[vscode.ConfigurationTarget, number | undefined]> = [
      [vscode.ConfigurationTarget.Global, inspected?.globalValue],
      [vscode.ConfigurationTarget.Workspace, inspected?.workspaceValue],
      [vscode.ConfigurationTarget.WorkspaceFolder, inspected?.workspaceFolderValue],
    ];
    for (const [target, value] of scopes) {
      if (!shouldClearLegacyAgentTimeout(value)) continue;
      try {
        await cfg.update(key, 0, target);
      } catch {
        // If VS Code refuses to write a scope, agentTimeoutMs still coerces
        // known legacy defaults at runtime so the room does not fall back to a
        // stale wall-clock cap.
      }
    }
  }

  private sessionCostCapExceeded(): boolean {
    const cap = sessionCostCapUsd();
    if (cap <= 0) return false;
    return (this.sessionUsage?.costUsd ?? 0) >= cap;
  }

  /**
   * Probe `claude auth status --json` once per session and cache the SANITIZED
   * result. Sanitization happens at capture time (parseClaudeAuthStatus drops
   * email/orgId/orgName), so the cached field never holds raw auth JSON. A
   * failed/unparseable probe leaves the status undefined; the guard then treats
   * auth as unknown (non-subscription -> allow) rather than stranding the turn.
   */
  private async ensureClaudeAuthStatus(signal: AbortSignal): Promise<ClaudeAuthStatus | undefined> {
    if (this.claudeAuthStatusPromise) return this.claudeAuthStatusPromise;
    this.claudeAuthStatusPromise = (async () => {
      try {
        const spawn = await this.buildNativeCommandSpawn("claude", [...CLAUDE_AUTH_STATUS_PROBE_ARGS]);
        const result = await runAgent(spawn, "", 30000, () => {}, signal);
        // Some CLI builds print status to stdout, others to stderr; try both.
        this.claudeAuthStatus = parseClaudeAuthStatus(result.stdout) ?? parseClaudeAuthStatus(result.stderr);
      } catch {
        // Probe failure (binary missing, --json unsupported, timeout, abort):
        // leave auth class unknown so the credit guard fails open.
        this.claudeAuthStatus = undefined;
      }
      return this.claudeAuthStatus;
    })();
    return this.claudeAuthStatusPromise;
  }

  private reserveClaudeCreditEstimate(amountUsd: number): () => void {
    const reserved = typeof amountUsd === "number" && Number.isFinite(amountUsd) ? Math.max(0, amountUsd) : 0;
    if (reserved <= 0) return () => {};
    this.claudeCreditReservedUsd += reserved;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.claudeCreditReservedUsd = Math.max(0, this.claudeCreditReservedUsd - reserved);
    };
  }

  /**
   * Evaluate the Claude Agent SDK credit guard for a pending Claude dispatch.
   * Returns undefined when no action is needed (guard off). `mode === "off"`
   * short-circuits before the auth probe so opting out also skips its overhead.
   */
  private async evaluateClaudeCreditGuard(
    signal: AbortSignal,
    manyHeads = false
  ): Promise<ClaudeAutomationGuardResult | undefined> {
    const mode = claudeAutomationCreditGuard();
    if (mode === "off") return undefined;
    const status = (await this.ensureClaudeAuthStatus(signal)) ?? { isApiKey: false, isSubscription: false };
    const monthSpendUsd = claudeAutomationSpendThisMonth(this.usageRecords);
    return evaluateClaudeAutomationGuard({
      mode,
      capUsd: claudeAgentCreditCapUsd(),
      monthSpendUsd,
      pendingReservationUsd: this.claudeCreditReservedUsd,
      status,
      manyHeads,
    });
  }

  private buildPromptContext(
    phase: Phase,
    transport: "oneShot" | "terminalBridge" = this.transportMode(),
    agent?: AgentId,
    use: "room" | "terminalPoke" = "room"
  ): string {
    return this.buildPromptContextSnapshot(phase, transport, agent, use).text;
  }

  private buildPromptContextSnapshot(
    phase: Phase,
    transport: "oneShot" | "terminalBridge" = this.transportMode(),
    agent?: AgentId,
    use: "room" | "terminalPoke" = "room"
  ): PromptContextSnapshot {
    return this.buildPromptContextSnapshotFromMessages(this.messages, phase, transport, agent, use);
  }

  private buildPromptContextSnapshotForCurrentTurn(
    phase: Phase,
    agent: AgentId,
    promptText: string,
    displayText: string,
    timestamp?: string
  ): PromptContextSnapshot {
    if (promptText === displayText) {
      return this.buildPromptContextSnapshot(phase, undefined, agent);
    }
    const messages = this.messages.map((message) => {
      const isCurrentUserMessage = message.role === "user" && (
        timestamp ? message.timestamp === timestamp : message.text === displayText
      );
      return isCurrentUserMessage ? { ...message, text: promptText } : message;
    });
    return this.buildPromptContextSnapshotFromMessages(messages, phase, this.transportMode(), agent);
  }

  private buildPromptContextFromMessages(
    messages: TranscriptMessage[],
    phase: Phase,
    transport: "oneShot" | "terminalBridge" = this.transportMode(),
    agent?: AgentId,
    use: "room" | "terminalPoke" = "room"
  ): string {
    return this.buildPromptContextSnapshotFromMessages(messages, phase, transport, agent, use).text;
  }

  private buildPromptContextSnapshotFromMessages(
    messages: TranscriptMessage[],
    phase: Phase,
    transport: "oneShot" | "terminalBridge" = this.transportMode(),
    agent?: AgentId,
    use: "room" | "terminalPoke" = "room"
  ): PromptContextSnapshot {
    const contextTitle = use === "terminalPoke"
      ? "--- Current terminal poke transcript ---"
      : "--- Full transcript ---";
    const workspaceInstructionsMaxChars = transport === "terminalBridge"
      ? terminalBridgeWorkspaceInstructionsMaxChars()
      : this.oneShotWorkspaceInstructionsMaxChars(phase);
    const sections = [objectiveAsContext(this.objective)];
    if (transport !== "terminalBridge" || workspaceInstructionsMaxChars > 0) {
      // Why: the recipient CLI (Claude Code → CLAUDE.md, Codex → AGENTS.md /
      // .codex/instructions.md) auto-loads its own native instruction file
      // from cwd, so re-inlining it here is duplicated tokens on every turn.
      // Filter agent-side regardless of transport.
      const workspaceInstructions = agent
        ? this.workspaceInstructionsByAgent[agent]
        : this.workspaceInstructions;
      sections.push(
        "",
        workspaceInstructionsAsContext(workspaceInstructions, { maxChars: workspaceInstructionsMaxChars })
      );
    }
    const wikiContext = readHydraWikiPromptContext(this.workspaceRoot, wikiContextMaxChars(), {
      includeLog: wikiPromptIncludeLog(),
    });
    if (wikiContext) {
      sections.push("", wikiContext.markdown);
    }
    const transcriptCap = use === "terminalPoke" ? 0 : this.promptTranscriptMaxChars(phase);
    const transcriptWindow = buildPromptContextWindow(
      messages,
      phase,
      2,
      24 * 60 * 60 * 1000,
      Date.now(),
      transcriptCap
    );
    sections.push(
      "",
      contextTitle,
      transcriptWindow.markdown
    );
    return {
      text: sections.join("\n"),
      transcriptWindow: this.promptTranscriptWindowStats(transcriptWindow, transcriptCap),
    };
  }

  private oneShotWorkspaceInstructionsMaxChars(phase: Phase): number {
    const scope = promptTranscriptScope(phase);
    const raw = vscode.workspace.getConfiguration("hydraRoom").get<unknown>(
      "oneShotWorkspaceInstructionsMaxChars",
      ONE_SHOT_WORKSPACE_INSTRUCTIONS_MAX_CHARS_DEFAULTS
    );
    const fallback = ONE_SHOT_WORKSPACE_INSTRUCTIONS_MAX_CHARS_DEFAULTS[scope];
    return Math.max(0, Math.floor(effectivePhasedNumberSetting(raw, scope, fallback)));
  }

  private promptTranscriptMaxChars(phase: Phase): number {
    const scope = promptTranscriptScope(phase);
    const raw = vscode.workspace.getConfiguration("hydraRoom").get<unknown>(
      "promptTranscriptMaxChars",
      PROMPT_TRANSCRIPT_MAX_CHARS_DEFAULTS
    );
    const fallback = PROMPT_TRANSCRIPT_MAX_CHARS_DEFAULTS[scope];
    return Math.max(0, Math.floor(effectivePhasedNumberSetting(raw, scope, fallback)));
  }

  private wikiContextRefreshTranscriptMaxChars(): number {
    const raw = vscode.workspace.getConfiguration("hydraRoom").get<unknown>(
      "promptTranscriptMaxChars",
      PROMPT_TRANSCRIPT_MAX_CHARS_DEFAULTS
    );
    const values = (["discussion", "build", "review"] as const).map((scope) =>
      Math.max(0, Math.floor(effectivePhasedNumberSetting(raw, scope, PROMPT_TRANSCRIPT_MAX_CHARS_DEFAULTS[scope])))
    );
    return Math.max(...values);
  }

  private promptTranscriptWindowStats(
    window: TranscriptContextWindow,
    cap: number
  ): PromptTranscriptWindowStats {
    return {
      cap,
      originalChars: window.originalChars,
      keptChars: window.keptChars,
      omittedMessages: window.omittedMessages,
      omittedChars: window.omittedChars,
      truncated: window.truncated,
    };
  }

  private wikiWrapupAgent(): AgentId {
    const configured = vscode.workspace.getConfiguration("hydraRoom").get<string>("wikiWrapupAgent", "auto").trim();
    if (configured === "codex" || configured === "claude") return configured;
    const { agentDefaults, modelOverrides } = this.modelPrices();
    const score = (agent: AgentId) => {
      const prices = resolveModelPrices(agent, modelForPhase(agent, "opener") || undefined, modelOverrides, agentDefaults);
      return prices.inputPerMTok + prices.outputPerMTok * 0.25;
    };
    return score("codex") <= score("claude") ? "codex" : "claude";
  }

  // ---------------- message lifecycle ----------------

  // Why: single chokepoints so this.messages (order/serialization source of
  // truth) and this.messagesById (the O(1) lookup index) can never drift.
  private setMessages(next: UiMessage[]): void {
    this.messages = next;
    this.messagesById = new Map(next.map((m) => [m.id, m]));
  }

  private pushMessage(msg: UiMessage): void {
    this.messages.push(msg);
    this.messagesById.set(msg.id, msg);
  }

  private async readManyHeadsSmokeLiveFiles(agentCalls: readonly ManyHeadsSmokeAgentCall[]): Promise<ManyHeadsSmokeLiveFile[]> {
    const started = agentCalls.filter((call) =>
      call.event === "started" &&
      call.phase === "parallel" &&
      (call.agent === "codex" || call.agent === "claude")
    );
    const seen = new Set<string>();
    const summaries: ManyHeadsSmokeLiveFile[] = [];
    for (const call of started) {
      const agent = call.agent as AgentId;
      const key = `${call.id}\0${agent}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const filePath = liveChannelPath(this.workspaceRoot, call.id, agent);
      const records = await readJsonlGuarded(filePath, isSmokeLiveChannelRecord);
      let exists = records.length > 0;
      if (!exists) {
        try {
          const stat = await fs.stat(filePath);
          exists = stat.isFile();
        } catch {
          exists = false;
        }
      }
      if (!exists) continue;
      summaries.push({
        requestId: call.id,
        agent,
        path: vscode.workspace.asRelativePath(filePath, false),
        eventCount: records.length,
        taskEventCount: records.filter((record) => record.agent === "claude" && record.kind.startsWith("task_")).length,
      });
    }
    return summaries;
  }

  private appendMessageLiveChannelEvent(messageId: string, event: LiveChannelEvent): void {
    if (!isClaudeTaskLiveEvent(event)) return;
    const message = this.messagesById.get(messageId);
    if (!message) return;
    const events = message.liveChannelEvents ?? [];
    events.push(event);
    // Keep the room state bounded even if a Claude run emits a long task loop.
    message.liveChannelEvents = events.slice(-50);
    this.panel.webview.postMessage({ type: "liveChannelEvent", messageId, event });
  }

  private openPendingMessage(role: AgentId, phase: Phase): string {
    const id = `m-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const msg: UiMessage = {
      id,
      role,
      text: "",
      timestamp: new Date().toISOString(),
      phase,
      pending: true,
    };
    this.pushMessage(msg);
    this.setAgentStatus(role, "running", `${phase} running`);
    return id;
  }

  private startPendingActivity(
    messageId: string,
    agent: AgentId,
    phase: Phase,
    timeoutMs: number
  ): { markOutput: () => void; stop: () => void } {
    const startedAt = Date.now();
    let lastOutputAt = startedAt;
    const update = () => {
      const message = this.messagesById.get(messageId);
      if (!message?.pending) return;
      const elapsedMs = Date.now() - startedAt;
      message.activity = formatPendingAgentActivity({
        agentLabel: AGENT_NAMES[agent],
        phase,
        elapsedMs,
        timeoutMs,
        outputIdleMs: Date.now() - lastOutputAt,
      });
      this.setAgentStatus(agent, "running", `${phase} running ${formatElapsed(elapsedMs)}`);
      this.postState();
    };
    const handle = setInterval(update, 5000);
    update();
    return {
      markOutput: () => {
        lastOutputAt = Date.now();
      },
      stop: () => clearInterval(handle),
    };
  }

  private async finalizePendingMessage(messageId: string, result: RunResult): Promise<void> {
    const m = this.messagesById.get(messageId);
    if (!m) return;
    if (!m.pending && m.cancelled) {
      this.pendingPromptTranscriptWindows.delete(messageId);
      return;
    }
    const promptTranscriptWindow = this.pendingPromptTranscriptWindows.get(messageId);
    m.pending = false;
    const runFailure = this.pendingRunFailures.get(messageId);
    this.pendingRunFailures.delete(messageId);
    if (runFailure) m.runFailure = runFailure;
    const timedOutDiscussion =
      result.timedOut && (m.phase === "opener" || m.phase === "reactor" || m.phase === "closer" || m.phase === "parallel");
    if (result.cancelled || timedOutDiscussion) {
      m.cancelled = true;
      if (m.text.length > 0 && !m.text.endsWith("\n")) m.text += "\n";
      m.text += result.cancelled
        ? "[cancelled by user]"
        : `[cancelled: timed out after ${result.timeoutMs ?? agentTimeoutMs()}ms]`;
    } else if (result.timedOut) {
      m.error = true;
      m.text += `\n[timed out after ${result.timeoutMs ?? agentTimeoutMs()}ms]`;
    } else if (result.exitCode !== 0) {
      // exitCode === null without timedOut/cancelled means the spawn itself failed
      // (e.g. CLI not on PATH). Surface that as an error rather than [no output].
      m.error = true;
      const code = result.exitCode === null ? "spawn-failed" : String(result.exitCode);
      m.text += `\n[exit ${code}]${result.stderr ? "\n" + result.stderr : ""}`;
    }
    if (m.text.trim() === "") m.text = "[no output]";
    if (m.role === "codex" || m.role === "claude") {
      this.setAgentStatus(
        m.role,
        m.error || m.cancelled ? "error" : "replied",
        m.cancelled ? `${m.phase ?? "turn"} cancelled` : m.error ? `${m.phase ?? "turn"} error` : `${m.phase ?? "turn"} replied`
      );
    }
    await this.captureDecisionPacket(m);
    await this.refreshWorkspaceChanges();
    await appendMessage(this.transcriptUri.fsPath, {
      role: m.role,
      text: m.text,
      timestamp: m.timestamp,
      phase: m.phase,
      error: m.error,
      cancelled: m.cancelled,
    });
    await this.recordWikiUsageTelemetry(m, promptTranscriptWindow);
    this.pendingPromptTranscriptWindows.delete(messageId);
  }

  private async recordWikiUsageTelemetry(
    message: UiMessage,
    promptTranscriptWindow?: PromptTranscriptWindowStats
  ): Promise<void> {
    if (!this.workspaceReady) return;
    if (message.role !== "codex" && message.role !== "claude") return;
    if (message.error || message.cancelled) return;
    const wikiContext = readHydraWikiPromptContext(this.workspaceRoot, wikiContextMaxChars(), {
      includeLog: wikiPromptIncludeLog(),
    });
    if (!wikiContext) return;

    const telemetry = summarizeHydraWikiUsage(message.text);
    await this.recordEvent(
      "diagnostic",
      `Hydra wiki usage telemetry: ${AGENT_NAMES[message.role]} ${message.phase ?? "turn"} reply ${telemetry.hasCitationSignal ? "cited wiki sources" : telemetry.hasMentionSignal ? "mentioned wiki memory" : "had no wiki usage signal"}.`,
      {
        agent: message.role,
        phase: message.phase ?? null,
        hasSignal: telemetry.hasSignal,
        hasCitationSignal: telemetry.hasCitationSignal,
        hasMentionSignal: telemetry.hasMentionSignal,
        sourceCitationCount: telemetry.sourceCitationCount,
        distinctSourceCitationCount: telemetry.distinctSourceCitationCount,
        sourceIds: telemetry.sourceIds.join(","),
        mentionsWikiByName: telemetry.mentionsWikiByName,
        mentionsHydraWikiPath: telemetry.mentionsHydraWikiPath,
        replyChars: telemetry.replyChars,
        promptChars: wikiContext.markdown.length,
        promptFiles: wikiContext.files.join(","),
        transcriptCap: promptTranscriptWindow?.cap ?? null,
        transcriptOriginalChars: promptTranscriptWindow?.originalChars ?? null,
        transcriptKeptChars: promptTranscriptWindow?.keptChars ?? null,
        transcriptOmittedChars: promptTranscriptWindow?.omittedChars ?? null,
        transcriptOmittedMessages: promptTranscriptWindow?.omittedMessages ?? null,
        transcriptTruncated: promptTranscriptWindow?.truncated ?? null,
      }
    );
  }

  private async captureDecisionPacket(message: UiMessage): Promise<void> {
    if (message.role !== "codex" && message.role !== "claude") return;
    if (message.error || message.cancelled) return;
    const packet = parseDecisionPacket(message.text, {
      agent: message.role,
      phase: message.phase,
      sourceMessageTimestamp: message.timestamp,
    });
    if (!packet) return;
    // Append to disk first; only mutate the in-memory array if the write
    // succeeds. Previous order pushed before await — a thrown appendDecision
    // would split RAM and disk, and the next session reload would silently
    // reverse the captured decision.
    await appendDecision(this.decisionsUri.fsPath, packet);
    this.decisions.push(packet);
    void this.maybeFireHandoffWebhook(packet);
  }

  private handoffNotifiedPacketTimestamps = new Set<string>();

  // Forwards to the Telegram controller for the send; the VS Code toast +
  // "Open Settings" action stays here because the controller is UI-free.
  async sendTestTelegramMessage(): Promise<void> {
    const outcome = await this.telegram.sendTestMessage();
    if (outcome.ok) return;
    if (outcome.reason === "unconfigured") {
      const action = await vscode.window.showWarningMessage(
        "Telegram isn't configured. Set hydraRoom.telegramBotToken and hydraRoom.telegramChatId (or TELEGRAM_BOT_TOKEN env + chat id).",
        "Open Settings",
      );
      if (action === "Open Settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "hydraRoom.telegram");
      }
      return;
    }
    // send-failed: the controller already wrote the failure to the transcript;
    // pop a toast with an action button so the user can fix the setting.
    const choice = await vscode.window.showErrorMessage(
      "Telegram test failed. Double-check hydraRoom.telegramBotToken and hydraRoom.telegramChatId.",
      "Open Settings",
    );
    if (choice === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "hydraRoom.telegram");
    }
  }

  private async maybeFireHandoffWebhook(packet: DecisionPacket): Promise<void> {
    const needs = packet.decisionNeededFromUser?.trim();
    if (!needs || isNoneValue(needs)) return;
    if (this.handoffNotifiedPacketTimestamps.has(packet.timestamp)) return;
    this.handoffNotifiedPacketTimestamps.add(packet.timestamp);
    // Both transports run in parallel; one can fail without affecting the other.
    await Promise.all([
      this.fireWebhookForDecision(packet, needs),
      this.fireTelegramForDecision(packet, needs),
    ]);
  }

  private async fireWebhookForDecision(packet: DecisionPacket, needs: string): Promise<void> {
    const url = vscode.workspace.getConfiguration("hydraRoom").get<string>("handoffWebhookUrl", "").trim();
    if (!url) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      await this.surfaceWebhookConfigError("Handoff webhook ignored: hydraRoom.handoffWebhookUrl is not a valid URL.");
      return;
    }
    if (parsed.protocol !== "https:") {
      await this.surfaceWebhookConfigError("Handoff webhook ignored: hydraRoom.handoffWebhookUrl must be an https:// URL.");
      return;
    }
    if (isBlockedWebhookHost(parsed.hostname)) {
      await this.surfaceWebhookConfigError("Handoff webhook ignored: private/loopback/metadata hosts are blocked for SSRF safety.");
      return;
    }
    const payload = {
      event: "hydra.decision_needed",
      timestamp: packet.timestamp,
      workspace: this.workspaceRoot,
      agent: packet.agent,
      phase: packet.phase,
      decisionNeededFromUser: needs,
      defaultNextAction: packet.defaultNextAction,
      recommendation: packet.recommendation,
      blockers: packet.blockers,
      objective: this.objective,
    };
    try {
      const res = await fetch(parsed, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const detail = `Handoff webhook returned HTTP ${res.status}; agent decision needs user attention. Check hydraRoom.handoffWebhookUrl.`;
        await this.appendSystemMessage(detail);
        const choice = await vscode.window.showErrorMessage(detail, "Open Settings");
        if (choice === "Open Settings") {
          await vscode.commands.executeCommand("workbench.action.openSettings", "hydraRoom.handoffWebhookUrl");
        }
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // Why: error message is network-attacker-controlled (TLS alert text, server
      // response bodies on some failure modes) and otherwise flows into agent
      // prompts via transcript.md on the next turn.
      const msg = sanitizeWebhookError(raw);
      const detail = `Handoff webhook failed (${msg}); decision needs user attention regardless. Check hydraRoom.handoffWebhookUrl.`;
      await this.appendSystemMessage(detail);
      const choice = await vscode.window.showErrorMessage(detail, "Open Settings");
      if (choice === "Open Settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "hydraRoom.handoffWebhookUrl");
      }
    }
  }

  private async surfaceWebhookConfigError(detail: string): Promise<void> {
    await this.appendSystemMessage(detail);
    const choice = await vscode.window.showErrorMessage(detail, "Open Settings");
    if (choice === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "hydraRoom.handoffWebhookUrl");
    }
  }

  // Forwards to the Telegram controller; the VS Code toast on send failure
  // stays here because the controller is UI-free.
  private async fireTelegramForDecision(packet: DecisionPacket, needs: string): Promise<void> {
    const notifyEnabled = vscode.workspace
      .getConfiguration("hydraRoom")
      .get<boolean>("telegramNotifyOnDecisionNeeded", true);
    const outcome = await this.telegram.fireForDecision(packet, needs, notifyEnabled);
    if ("ok" in outcome && !outcome.ok) {
      const choice = await vscode.window.showErrorMessage(
        "Telegram notify failed. Check hydraRoom.telegramBotToken and hydraRoom.telegramChatId.",
        "Open Settings",
      );
      if (choice === "Open Settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "hydraRoom.telegram");
      }
    }
  }

  private setAgentStatus(agent: AgentId, state: AgentStatusState, detail: string): void {
    this.agentStatuses[agent] = { state, detail };
  }

  private appendUserMessageToUi(text: string): UiMessage {
    const id = `u-${Date.now()}`;
    const msg: UiMessage = {
      id,
      role: "user",
      text,
      timestamp: new Date().toISOString(),
    };
    this.pushMessage(msg);
    return msg;
  }

  private async appendUserMessage(text: string): Promise<UiMessage> {
    const msg = this.appendUserMessageToUi(text);
    await appendMessage(this.transcriptUri.fsPath, {
      role: "user",
      text,
      timestamp: msg.timestamp,
    });
    this.postState();
    return msg;
  }

  private appendSystemMessageToUi(text: string): UiMessage {
    const id = `s-${Date.now()}`;
    const msg: UiMessage = {
      id,
      role: "system",
      text,
      timestamp: new Date().toISOString(),
    };
    this.pushMessage(msg);
    return msg;
  }

  private async appendSystemMessage(text: string): Promise<void> {
    const msg = this.appendSystemMessageToUi(text);
    await appendMessage(this.transcriptUri.fsPath, {
      role: "system",
      text,
      timestamp: msg.timestamp,
    });
  }

  private async recordEvent(
    kind: HydraEventKind,
    detail: string,
    data?: Record<string, string | number | boolean | null>
  ): Promise<void> {
    try {
      await appendHydraEvent(this.eventsUri.fsPath, createHydraEvent({ kind, detail, data }));
    } catch {
      // Event logging is diagnostic-only. It should never block the room.
    }
  }

  // ---------------- webview I/O ----------------

  private async onWebviewMessage(msg: WebviewMessage): Promise<void> {
    // Why: the webview is a separate iframe; a drifted/forged postMessage could
    // arrive without a string .type. Narrow at runtime so the switch never reads
    // .type off a non-object and so unknown types surface (default arm) instead
    // of silently no-op'ing.
    if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
      return;
    }
    try {
      switch (msg.type) {
        case "ready":
          // Wait for init so the first state push reflects loaded transcript and gitAvailable.
          await this.ready();
          this.postState();
          break;
        case "send":
          await this.sendUserMessage(msg.text, normalizeAgentId(msg.opener, this.getFirstSpeaker()), { consumePendingAttachments: true });
          break;
        case "attachFiles":
          await this.attachFiles();
          break;
        case "clearAttachment":
          await this.clearAttachment(String(msg.id ?? ""));
          break;
        case "clearAttachments":
          await this.clearAttachments();
          break;
        case "setObjective":
          await this.setObjective(msg.text);
          break;
        case "resetObjective":
          await this.resetObjective();
          break;
        case "stop":
          await this.stop();
          break;
        case "assignBuilder":
          await this.assignBuilder(msg.builder);
          break;
        case "assignParallelBuilders":
          await this.assignParallelBuilders();
          break;
        case "requestReview":
          await this.requestReview();
          break;
        case "runVerification":
          await this.runVerification();
          break;
        case "openVerification":
          await this.openVerification();
          break;
        case "openNativeActions":
          await this.openNativeActions();
          break;
        case "openAgentCalls":
          await this.openAgentCalls();
          break;
        case "openWorkspaceChange":
          await this.openWorkspaceChange(String(msg.path ?? ""));
          break;
        case "openRunFailureFile":
          await this.openRunFailureFile(String(msg.path ?? ""));
          break;
        case "copyRunFailurePromptSha":
          await this.copyRunFailurePromptSha(String(msg.sha ?? ""));
          break;
        case "clearNativeAction":
          await this.clearNativeActions([msg.id ?? ""]);
          break;
        case "clearNativeActions":
          await this.clearNativeActions(Array.isArray(msg.ids) ? msg.ids : []);
          break;
        case "openObjective":
          await this.openObjective();
          break;
        case "openSessionBrief":
          await this.openSessionBrief();
          break;
        case "openWikiContext":
          await this.openWikiContext();
          break;
        case "runWikiWrapupNow":
          await this.runWikiWrapupNow();
          break;
        case "openSupportBundle":
          await this.openSupportBundle();
          break;
        case "captureNativeCapabilities":
          await this.captureNativeCapabilities();
          break;
        case "captureNativeDataSnapshot":
          await this.captureNativeDataSnapshot();
          break;
        case "showCommandCenter":
          await this.showCommandCenter();
          break;
        case "previewNextPrompt":
          await this.previewNextPrompt(msg.text ?? "", normalizeAgentId(msg.opener, this.getFirstSpeaker()));
          break;
        case "openLastPrompt":
          await this.openLastPrompt();
          break;
        case "cleanWorkspaceState":
          await this.cleanWorkspaceState();
          break;
        case "acceptDefaultDecision":
          await this.acceptDefaultDecision();
          break;
        case "toggleAutoAdvanceActionableDefaults":
          await this.toggleAutoAdvanceActionableDefaults();
          break;
        case "handBack":
          await this.handBack();
          break;
        case "openTranscript":
          await this.openTranscript();
          break;
        case "archiveAndClearRoom":
          await this.archiveAndClearRoom();
          break;
        case "openDecisions":
          await this.openDecisions();
          break;
        case "chooseModelOrEffort":
          await this.chooseModelOrEffort();
          break;
        case "chooseModel":
          await this.chooseModel();
          break;
        case "chooseEffort":
          await this.chooseEffort();
          break;
        case "toggleManyHeadsMode":
          await this.toggleManyHeadsMode();
          break;
        case "configureManyHeadsWorkers":
          await this.configureManyHeadsWorkers();
          break;
        case "testTelegram":
          await this.sendTestTelegramMessage();
          break;
        case "openNativeTerminals":
          await this.openNativeTerminals();
          break;
        case "pokeNativeTerminal":
          await this.pokeNativeTerminal(
            normalizeAgentId(msg.agent, this.getFirstSpeaker()),
            msg.text ?? "",
            {
              includeEditorContext: !!msg.includeEditorContext,
              includeWorkspaceDiff: !!msg.includeWorkspaceDiff,
            }
          );
          break;
        case "runNativeCommand":
          await this.runNativeCliCommand(
            normalizeAgentId(msg.agent, this.getFirstSpeaker()),
            msg.text ?? ""
          );
          break;
        case "sendRawTerminalLine":
          await this.sendRawTerminalLine(
            normalizeAgentId(msg.agent, this.getFirstSpeaker()),
            msg.text ?? ""
          );
          break;
        case "pokeNativeTerminals":
          await this.pokeNativeTerminals(["codex", "claude"], msg.text ?? "", {
            includeEditorContext: !!msg.includeEditorContext,
            includeWorkspaceDiff: !!msg.includeWorkspaceDiff,
          });
          break;
        case "nativeAction":
          await this.showNativeActionPicker(msg.text ?? "");
          break;
        case "rerunNativeAction":
          await this.rerunNativeAction(String(msg.id ?? ""));
          break;
        case "discussVerification":
          await this.discussLatestVerificationFailure();
          break;
        case "dismissWorkQueueItem":
          await this.dismissWorkQueueItem(String(msg.id ?? ""));
          break;
        case "snoozeWorkQueueItem":
          await this.snoozeWorkQueueItem(String(msg.id ?? ""));
          break;
        case "useTerminalBridge":
          await this.useTerminalBridge();
          break;
        case "useOneShotTransport":
          await this.useOneShotTransport();
          break;
        case "runTerminalBridgeSelfTest":
          await this.runTerminalBridgeSelfTest();
          break;
        case "showTerminalBridgeHealth":
          await this.showTerminalBridgeHealth();
          break;
        case "showEffectiveAuthority":
          await this.showEffectiveAuthority();
          break;
        case "changeCapabilityProfile":
          await this.changeCapabilityProfile();
          break;
        case "runDoctor":
          await this.runDoctor();
          break;
        case "runAutopilotStart":
          await this.runAutopilotStart();
          break;
        case "fixCodexPath":
          await this.fixAgentCommand("codex");
          break;
        case "fixClaudePath":
          await this.fixAgentCommand("claude");
          break;
        case "resetStuckTurn":
          await this.resetStuckTurn();
          break;
        case "openWorkspaceFolder":
          await this.openWorkspaceFolder();
          break;
        default: {
          // Why: a message type the host doesn't handle means webview/host
          // protocol drift. Record it loudly (diagnostic event) rather than
          // silently dropping it, so the mismatch is visible in events.jsonl.
          const unknownType = (msg as { type?: unknown }).type;
          void this.recordEvent("diagnostic", `Unknown webview message type: ${String(unknownType)}`);
          break;
        }
      }
    } catch (err) {
      // Init failures (e.g. no workspace folder open) reach here as a rejected
      // initPromise. Surface clearly instead of silently dead panel, and offer
      // a one-click hop into the Doctor since most catch-all reachers here are
      // setup problems (workspace, CLI path, transcript permissions).
      const message = err instanceof Error ? err.message : String(err);
      const action = await vscode.window.showErrorMessage(
        `Hydra Room hit an error: ${message}`,
        "Run Doctor",
      );
      if (action === "Run Doctor") {
        await vscode.commands.executeCommand("hydraRoom.runDoctor");
      }
    }
  }

  private postState(): void {
    const workQueue = this.workspaceReady ? this.currentWorkQueue() : [];
    const canStop =
      isInFlight(this.state) ||
      this.terminalPokeInFlight ||
      this.verificationRunning ||
      this.autopilotRunning;
    const authoritySummaries = this.workspaceReady ? this.currentAuthoritySummaries() : unavailableAuthoritySummaries();
    HydraRoomPanel.statusBarUpdater?.({
      workspaceReady: this.workspaceReady,
      phaseLabel: phaseLabel(this.state),
      transport: this.transportMode(),
      workQueueCount: workQueue.length,
      canStop,
      verificationRunning: this.verificationRunning,
      autopilotRunning: this.autopilotRunning,
    });
    // postMessage throws if the webview has been disposed mid-flight
    // (e.g. user closed the panel while a phase was running). Swallow that
    // here — there's nothing left to update.
    const latestDecision = this.decisions[this.decisions.length - 1];
    const latestDecisionAccepted = !!latestDecision && latestDecision.timestamp === this.acceptedDefaultDecisionTimestamp;
    try {
      this.panel.webview.postMessage({
        type: "state",
        messages: this.messages,
        phaseLabel: phaseLabel(this.state),
        isIdle: this.state.name === "Idle",
        canSend: this.workspaceReady && !this.terminalPokeInFlight && (isSendable(this.state) || isInFlight(this.state)),
        canStop,
        queuedUserMessageCount: this.queuedUserMessages.length,
        canPokeNativeTerminals: this.workspaceReady && !isInFlight(this.state) && !this.terminalPokeInFlight,
        canClearNativeActions: this.workspaceReady && !this.terminalPokeInFlight,
        canAssignBuilder: this.workspaceReady && this.state.name === "AwaitingUser",
        canRequestReview: this.workspaceReady && (this.state.name === "BuildDone" || this.state.name === "ParallelBuildDone") && this.gitAvailable,
        canRunVerification: this.workspaceReady && !isInFlight(this.state) && !this.terminalPokeInFlight && !this.verificationRunning,
        canRunWikiWrapup: this.canRunManualWikiWrapup(),
        canPreviewPrompt: this.workspaceReady && !isInFlight(this.state) && !this.terminalPokeInFlight,
        canArchiveRoom: this.workspaceReady && !canStop,
        canAttachFiles: this.workspaceReady && !isInFlight(this.state) && !this.terminalPokeInFlight,
        pendingAttachments: this.pendingAttachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          relativePath: attachment.relativePath,
          sizeBytes: attachment.sizeBytes,
          binary: attachment.binary,
          previewChars: attachment.previewText?.length ?? 0,
        })),
        canHandBack: this.workspaceReady && (this.state.name === "ReviewDone" || this.state.name === "ParallelReviewDone") && !this.state.approved,
        canOpenFolder: !this.workspaceReady,
        suggestedBuilder: this.state.name === "AwaitingUser" ? this.suggestedBuilder : undefined,
        firstSpeaker: this.getFirstSpeaker(),
        transport: this.transportMode(),
        objective: this.objective,
        agentStatuses: this.agentStatuses,
        authoritySummaries,
        terminalSessions: this.terminalBridge?.getSessions() ?? [],
        sessionUsage: this.sessionUsage,
        weeklyUsage: this.weeklyUsage,
        recentUsageRecords: this.usageRecords.filter((record) => record.sessionId === this.sessionId).slice(-12).reverse(),
        models: {
          claude: this.modelSummaryForRail("claude"),
          codex: this.modelSummaryForRail("codex"),
        },
        capabilityProfiles: {
          claude: this.profileSummaryForRail("claude"),
          codex: this.profileSummaryForRail("codex"),
        },
        efforts: {
          claude: this.effortSummaryForRail("claude"),
          codex: this.effortSummaryForRail("codex"),
        },
        manyHeads: {
          enabled: manyHeadsMode(),
          claudeWorkerCount: manyHeadsClaudeWorkerCount(),
        },
        latestDecision,
        latestDecisionAccepted,
        latestDecisionRisky: latestDecisionAccepted ? { risky: false, reasons: [] } : detectRiskySignals(latestDecision),
        recentDecisions: this.decisions.slice(-5).reverse(),
        decisionsCount: this.decisions.length,
        decisionAction: this.currentDecisionAction(),
        canAcceptDefault: this.workspaceReady && !isInFlight(this.state) && !this.terminalPokeInFlight && this.currentDecisionAction().kind !== "none",
        autoAdvanceActionableDefaults: autoAdvanceActionableDefaults(),
        latestVerification: this.latestVerification(),
        verificationSummary: verificationSummary(this.latestVerification()),
        verificationRunning: this.verificationRunning,
        latestNativeAction: this.nativeActions[this.nativeActions.length - 1],
        nativeActionSummary: nativeActionSummary(this.nativeActions[this.nativeActions.length - 1]),
        recentNativeActions: this.nativeActions.slice(-10).reverse(),
        nativeActionsCount: this.nativeActions.length,
        workspaceChanges: this.workspaceChanges,
        workspaceChangesCount: this.workspaceChanges.length,
        workQueue,
        latestDoctorReport: this.latestDoctorReport,
        autopilotRunning: this.autopilotRunning,
        autopilotSummary: this.autopilotSummary,
        needsCodexPath: checkFailed(this.latestDoctorReport, "codex-command"),
        needsClaudePath: checkFailed(this.latestDoctorReport, "claude-command"),
      });
    } catch {
      // panel disposed; nothing to do
    }
  }

  private applyEvent(event: Event): void {
    const prev = this.state;
    this.state = transition(this.state, event);
    if (this.state !== prev) {
      // Best-effort phase-transition trail for telemetry. recordEvent swallows
      // its own write errors and must never block the room, so fire-and-forget.
      void this.recordEvent("phaseTransition", `${prev.name} -> ${this.state.name}`);
    }
  }

  private canRunManualWikiWrapup(): boolean {
    if (!this.workspaceReady || isInFlight(this.state) || this.terminalPokeInFlight || this.verificationRunning || this.autopilotRunning || this.wikiWrapupInFlight) {
      return false;
    }
    return !!hydraWikiWrapupSourceFromMessages(this.messages, wikiWrapupMaxSourceChars());
  }

  private async refreshWorkspaceChanges(): Promise<void> {
    if (!this.gitAvailable) {
      this.workspaceChanges = [];
      return;
    }
    const changes = await captureGitStatusChanges(this.workspaceRoot);
    this.workspaceChanges = changes ?? [];
  }

  private isIgnoredWatchPath(fsPath: string): boolean {
    // Compare against workspace-relative path segments so a sibling dir whose
    // name merely starts with ".hydra" isn't falsely matched. .hydra is the
    // workspace-local state dir (the self-trigger source); node_modules/.git
    // churn anywhere under the root is irrelevant to the workspace-change panel.
    const relative = path.relative(this.workspaceRoot, fsPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
    const segments = relative.split(/[\\/]/);
    if (segments[0] === ".hydra") return true;
    return segments.includes("node_modules") || segments.includes(".git");
  }

  private scheduleWorkspaceChangesRefresh(): void {
    if (this.workspaceChangesRefreshTimer) clearTimeout(this.workspaceChangesRefreshTimer);
    this.workspaceChangesRefreshTimer = setTimeout(() => {
      this.workspaceChangesRefreshTimer = undefined;
      void this.refreshWorkspaceChanges().then(() => this.postState());
    }, 350);
  }

  private resolveTranscriptUri(): vscode.Uri {
    const configured = vscode.workspace
      .getConfiguration("hydraRoom")
      .get<string>("transcriptPath", ".hydra/transcript.md");
    if (path.isAbsolute(configured)) return vscode.Uri.file(configured);
    return vscode.Uri.file(path.join(this.workspaceRoot, configured));
  }

  private getFirstSpeaker(): AgentId {
    const configured = vscode.workspace
      .getConfiguration("hydraRoom")
      .get<string>("firstSpeaker", "codex");
    return normalizeAgentId(configured, "codex");
  }

  private createTerminalBridge(): TerminalBridge {
    return new TerminalBridge(this.workspaceRoot, {
      onSessionUpdate: () => this.postState(),
    });
  }
}

// ---------------- pure helpers ----------------

function isSendable(state: State): boolean {
  // Quiescent states (nothing in flight, no agent owes a reply) accept
  // a freeform user message. From BuildDone or ReviewDone the message
  // routes through transition() into Opener/ParallelDiscussion so the
  // user isn't forced to pick Request Review / Hand Back / Reset just
  // to ask a follow-up.
  return (
    state.name === "Idle" ||
    state.name === "AwaitingUser" ||
    state.name === "BuildDone" ||
    state.name === "ParallelBuildDone" ||
    state.name === "ReviewDone" ||
    state.name === "ParallelReviewDone"
  );
}

function phaseLabel(state: State): string {
  switch (state.name) {
    case "Idle": return "Idle";
    case "Opener": return `Discussion - ${AGENT_NAMES[state.opener]} opening`;
    case "Reactor": return `Discussion - ${AGENT_NAMES[state.reactor]} reacting`;
    case "Closer": return `Discussion - ${AGENT_NAMES[state.opener]} closing`;
    case "ParallelDiscussion": return "Discussion - Codex and Claude running in parallel";
    case "AwaitingUser": return "Awaiting your reply";
    case "Build": return `Build — ${AGENT_NAMES[state.builder]} is editing`;
    case "ParallelBuild": return "Build — Codex and Claude editing in parallel";
    case "BuildDone": return `Build done — request review`;
    case "ParallelBuildDone": return "Parallel build done — request review";
    case "Review": return `Review — ${AGENT_NAMES[state.reviewer]} is reading the diff`;
    case "ParallelReview": return "Review — Codex and Claude reading the diff";
    case "ParallelReviewDone":
      return state.approved
        ? "Parallel review approved â€” you can push when ready"
        : "Parallel review raised blockers â€” reply or hand back";
    case "ReviewDone":
      return state.approved
        ? "Review approved — you can push when ready"
        : "Review raised blockers — reply or hand back";
  }
}

function configurationTargetLabel(target: vscode.ConfigurationTarget): string {
  if (target === vscode.ConfigurationTarget.WorkspaceFolder) return "workspace-folder";
  if (target === vscode.ConfigurationTarget.Workspace) return "workspace";
  return "user";
}

function otherAgent(agent: AgentId): AgentId {
  return agent === "codex" ? "claude" : "codex";
}

function normalizeAgentId(value: unknown, fallback: AgentId): AgentId {
  return value === "codex" || value === "claude" ? value : fallback;
}

async function ensureJsonlFile(filePath: string): Promise<void> {
  await ensureFile(filePath);
}

function makeTraceId(agent: AgentId, phase: Phase): string {
  return `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${agent}-${phase}`;
}

function appendManyHeadsLiveChannelContext(transcript: string, workspaceRoot: string, claudeRequestIds: readonly string[]): string {
  const claudeLivePaths = claudeRequestIds.map((requestId) => liveChannelPath(workspaceRoot, requestId, "claude"));
  return [
    transcript,
    "",
    "--- Many Heads live channel ---",
    "Many Heads Mode is on. Claude parallel structured streams are mirrored to these files while the Claude workers run:",
    ...claudeLivePaths,
    "You may inspect or tail those files with your normal tools during this parallel turn. They may not exist yet when you start; retry briefly instead of treating that as a failure.",
  ].join("\n");
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function requestFileTrace(input: {
  promptPath?: string;
  replyPath?: string;
  logPath?: string;
}): Partial<Record<RunFailureRequestFileKind, string>> | undefined {
  const trace: Partial<Record<RunFailureRequestFileKind, string>> = {};
  if (input.promptPath) trace.prompt = input.promptPath;
  if (input.replyPath) trace.reply = input.replyPath;
  if (input.logPath) trace.log = input.logPath;
  return Object.keys(trace).length > 0 ? trace : undefined;
}

function completedAgentCallTrace(
  id: string,
  agent: AgentId,
  phase: Phase,
  transport: "oneShot" | "terminalBridge",
  startedAt: number,
  result: RunResult
): Record<string, unknown> {
  return {
    id,
    event: "completed",
    timestamp: new Date().toISOString(),
    agent,
    phase,
    transport,
    durationMs: Date.now() - startedAt,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    timeoutMs: result.timeoutMs,
    stdoutChars: result.stdout.length,
    stderrChars: result.stderr.length,
    stderrPreview: result.stderr ? truncateForTrace(result.stderr, 1200) : undefined,
  };
}

function truncateForTrace(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function uniqueAgents(agents: AgentId[]): AgentId[] {
  const seen = new Set<AgentId>();
  const result: AgentId[] = [];
  for (const agent of agents) {
    if (seen.has(agent)) continue;
    seen.add(agent);
    result.push(agent);
  }
  return result;
}

function nativeActionPicks(): NativeActionPick[] {
  return [
    nativeActionPick("Codex", ["codex"], {}, "Direct instruction to Codex's native CLI"),
    nativeActionPick("Claude", ["claude"], {}, "Direct instruction to Claude's native CLI"),
    nativeActionPick("Both", ["codex", "claude"], {}, "Same direct instruction to both native CLIs in parallel"),
    nativeActionPick("Codex Command", ["codex"], {}, "Run exact Codex native args/subcommand and capture stdout", "command"),
    nativeActionPick("Claude Command", ["claude"], {}, "Run exact Claude native args/subcommand and capture stdout", "command"),
    nativeActionPick("Codex Raw Terminal Line", ["codex"], {}, "Send a raw line to the visible Codex terminal for interactive flows", "rawLine"),
    nativeActionPick("Claude Raw Terminal Line", ["claude"], {}, "Send a raw line to the visible Claude terminal for interactive flows", "rawLine"),
    ...NATIVE_COMMAND_CATALOG.map((item) => nativeActionPick(
      item.label,
      [item.agent],
      {},
      item.detail,
      item.mode,
      item.line,
      item.description
    )),
    nativeActionPick("Codex + Editor", ["codex"], { includeEditorContext: true }, "Attach active selection or active file"),
    nativeActionPick("Claude + Editor", ["claude"], { includeEditorContext: true }, "Attach active selection or active file"),
    nativeActionPick("Both + Editor", ["codex", "claude"], { includeEditorContext: true }, "Attach active selection or active file"),
    nativeActionPick("Codex + Diff", ["codex"], { includeWorkspaceDiff: true }, "Attach working-tree diff plus untracked files"),
    nativeActionPick("Claude + Diff", ["claude"], { includeWorkspaceDiff: true }, "Attach working-tree diff plus untracked files"),
    nativeActionPick("Both + Diff", ["codex", "claude"], { includeWorkspaceDiff: true }, "Attach working-tree diff plus untracked files"),
  ];
}

function nativeActionPick(
  plainLabel: string,
  agents: AgentId[],
  options: NativeTerminalPokeOptions,
  detail: string,
  actionKind: "prompt" | "command" | "rawLine" = "prompt",
  presetLine?: string,
  description?: string
): NativeActionPick {
  return {
    label: plainLabel,
    plainLabel,
    agents,
    options,
    actionKind,
    presetLine,
    description: description ?? (agents.length === 2 ? "Codex + Claude" : agents[0] ? AGENT_NAMES[agents[0]] : ""),
    detail,
  };
}

function normalizePokeOptions(options: NativeTerminalPokeOptions | boolean): NativeTerminalPokeOptions {
  if (typeof options === "boolean") return { includeEditorContext: options };
  return options;
}

function defaultPokeInstruction(
  editorContext: EditorContextAttachment | undefined,
  workspaceDiff: string | undefined
): string {
  if (editorContext && workspaceDiff !== undefined) {
    return "Use the attached editor context and working-tree diff.";
  }
  if (editorContext) {
    return `Use the attached ${editorContext.selected ? "selection" : "active file"} context.`;
  }
  if (workspaceDiff !== undefined) {
    return "Use the attached working-tree diff.";
  }
  return "";
}

function didAgentFail(result: RunResult): boolean {
  return result.cancelled || result.timedOut || result.exitCode !== 0;
}

function agentCallFailureResult(message: string): RunResult {
  return {
    stdout: "",
    stderr: message,
    exitCode: null,
    timedOut: false,
    cancelled: false,
  };
}

function guardNativeReply<T extends RunResult>(result: T): T {
  const leak = detectNativeReplyLeak(result.stdout);
  if (!leak) return result;
  return {
    ...result,
    stderr: [result.stderr.trim(), formatNativeReplyLeakError(leak)].filter(Boolean).join("\n"),
    exitCode: result.exitCode === 0 ? 1 : result.exitCode,
  };
}

function checkPassed(report: DoctorReport | undefined, id: string): boolean {
  return report?.checks.some((check) => check.id === id && check.status === "pass") ?? false;
}

function checkFailed(report: DoctorReport | undefined, id: string): boolean {
  return report?.checks.some((check) => check.id === id && check.status === "fail") ?? false;
}

// Read each user-configured args slot (codex/claude × discussion/build/review)
// and run validateNativeArgs against it. Doctor consumes the rows and turns
// any non-empty warning lists into a "Native CLI args" check. Cheap
// (six config reads + six pure validations) and runs once per Doctor pass.
function isSmokeWindowCall(call: ManyHeadsSmokeAgentCall, startedAt: string): boolean {
  if (typeof call.timestamp !== "string") return false;
  const callTime = Date.parse(call.timestamp);
  const startTime = Date.parse(startedAt);
  return Number.isFinite(callTime) && Number.isFinite(startTime) && callTime >= startTime;
}

function isSmokeLiveChannelRecord(value: unknown): value is LiveChannelEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<LiveChannelEvent>;
  return record.version === 1 &&
    typeof record.timestamp === "string" &&
    typeof record.requestId === "string" &&
    (record.agent === "codex" || record.agent === "claude") &&
    typeof record.phase === "string" &&
    typeof record.kind === "string";
}

function collectArgsValidation(cfg: vscode.WorkspaceConfiguration): DoctorArgsValidation[] {
  const profiles: Array<{ profile: string; key: (agent: AgentId) => string }> = [
    { profile: "discussion", key: (agent) => `${agent}ExecArgsDiscussion` },
    { profile: "build", key: (agent) => `${agent}ExecArgsBuild` },
    { profile: "review", key: (agent) => `${agent}ExecArgsReview` },
  ];
  const rows: DoctorArgsValidation[] = [];
  for (const agent of ["codex", "claude"] as AgentId[]) {
    for (const { profile, key } of profiles) {
      const args = cfg.get<string[]>(key(agent), []);
      rows.push({ agent, profile, warnings: validateNativeArgs(agent, args) });
    }
  }
  return rows;
}

function formatAutopilotReport(report: DoctorReport, summary: string): string {
  return [
    `Hydra Autopilot: ${summary}`,
    formatDoctorReport(report),
    summary === "Needs setup"
      ? "Use the Fix Codex Path / Fix Claude Path buttons if a native CLI check failed."
      : "The room is ready. Send one message when you want Codex and Claude to work.",
  ].join("\n\n");
}

function formatTerminalBridgeHealth(sessions: TerminalSession[]): string {
  const lines = ["Terminal Bridge Health"];
  for (const session of sessions) {
    lines.push(
      "",
      `${AGENT_NAMES[session.agent]}: ${session.state}`,
      `Detail: ${session.detail}`,
      `Command: ${session.currentCommand ?? "none"}`,
      `Phase: ${session.currentPhase ?? "none"}`,
      `Last activity: ${session.lastActivityAt ?? "none"}`,
      `Prompt: ${session.lastPromptPath ?? "none"}`,
      `Reply: ${session.lastReplyPath ?? "none"}`,
      `Log: ${session.lastLogPath ?? "none"}`,
      `Error: ${session.lastError ?? "none"}`
    );
  }
  return lines.join("\n");
}

function formatEffectiveAuthority(summaries: Record<AgentId, AgentAuthoritySummary>): string {
  const lines = ["Effective Native CLI Authority"];
  for (const agent of ["codex", "claude"] as AgentId[]) {
    const summary = summaries[agent];
    lines.push(
      "",
      `${AGENT_NAMES[agent]}: ${summary.authority.label}`,
      `Profile: ${summary.profile.label}`,
      `Detail: ${summary.authority.detail}`,
      `Profile detail: ${summary.profile.detail}`
    );
    // Each warning gets its own bulleted line so multi-warning output
    // (e.g. when validateNativeArgs flags several arg issues at once)
    // stays scannable instead of running together as one wall of text.
    if (summary.authority.warnings.length === 0) {
      lines.push("Warnings: none");
    } else if (summary.authority.warnings.length === 1) {
      lines.push(`Warnings: ${summary.authority.warnings[0]}`);
    } else {
      lines.push("Warnings:");
      for (const warning of summary.authority.warnings) {
        lines.push(`  - ${warning}`);
      }
    }
  }
  return lines.join("\n");
}

function unavailableAuthoritySummaries(): Record<AgentId, AgentAuthoritySummary> {
  return {
    codex: unavailableAuthoritySummary("codex"),
    claude: unavailableAuthoritySummary("claude"),
  };
}

function unavailableAuthoritySummary(agent: AgentId): AgentAuthoritySummary {
  return {
    authority: {
      level: "unknown",
      label: "Unavailable",
      detail: "Open a workspace folder before Hydra can resolve native CLI authority.",
      warnings: [],
    },
    profile: {
      id: "custom",
      label: "Unavailable",
      detail: `${AGENT_NAMES[agent]} CLI authority is unavailable until a workspace folder is open.`,
    },
  };
}

function roomTextFromClaudeStreamJson(raw: string): string {
  const summary = summarizeClaudeEvents(parseClaudeEventStream(raw));
  const text = summary.lastAssistantText?.trimEnd();
  if (text) return text;
  return formatClaudeStreamSummary(summary);
}

function roomTextFromCodexJson(raw: string): string {
  const summary = summarizeCodexEvents(parseCodexEventStream(raw));
  const text = summary.lastAgentMessage?.trimEnd();
  if (text) return text;
  return formatCodexThreadSummary(summary);
}

function resolveWorkspaceRoot(context: vscode.ExtensionContext): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) return folder.uri.fsPath;
  const envRoot = process.env.HYDRA_WORKSPACE_ROOT?.trim();
  if (envRoot) return envRoot;
  const configured = vscode.workspace.getConfiguration("hydraRoom").get<string>("workspaceRoot", "").trim();
  if (configured) return path.isAbsolute(configured) ? configured : path.resolve(configured);
  return inferDevelopmentWorkspaceRoot(context);
}

function inferDevelopmentWorkspaceRoot(context: vscode.ExtensionContext): string | undefined {
  if (context.extensionMode !== vscode.ExtensionMode.Development) return undefined;
  const extensionRoot = context.extensionUri.fsPath;
  const extensionName = path.basename(extensionRoot);
  const parent = path.dirname(extensionRoot);
  if (extensionName === "vscode-hydra-room" && path.basename(parent) === "tools") {
    return path.dirname(parent);
  }
  return undefined;
}

async function captureGitDiff(cwd: string, maxLines: number): Promise<string | null> {
  const tracked = await runGit(cwd, ["diff", "--no-ext-diff", "--no-color", "HEAD"]);
  if (!tracked || tracked.code !== 0) return null;

  const untracked = await runGit(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (!untracked || untracked.code !== 0) return null;

  const lines: string[] = [];
  appendLimitedLines(lines, tracked.out, maxLines);
  const files = untracked.out.split(/\r?\n/).filter((line) => line.length > 0);
  for (const file of files) {
    if (lines.length >= maxLines) break;
    const diff = await synthesizeUntrackedFileDiff(cwd, file);
    appendLimitedLines(lines, diff, maxLines);
  }
  return lines.join("\n");
}

async function captureGitStatusChanges(cwd: string): Promise<WorkspaceChange[] | null> {
  // Why: -uall recursively walks every untracked file and this refresh is driven
  // by a broad workspace watcher. Default untracked mode keeps the UI signal
  // while avoiding deep scans and noisy local path disclosure.
  const status = await runGit(cwd, ["status", "--porcelain=v1", "-z"]);
  if (!status || status.code !== 0) return null;
  return parseGitStatusEntries(status.out).slice(0, 200);
}

async function runGit(cwd: string, args: string[]): Promise<{ code: number | null; out: string } | null> {
  return new Promise((resolve) => {
    const child = cp.spawn("git", args, { cwd, windowsHide: true });
    let out = "";
    let settled = false;
    const finish = (value: { code: number | null; out: string } | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.on("error", () => finish(null));
    child.on("close", (code) => finish({ code, out }));
  });
}

async function synthesizeUntrackedFileDiff(cwd: string, relativeFile: string): Promise<string> {
  const gitPath = relativeFile.replace(/\\/g, "/");
  const absolute = path.join(cwd, relativeFile);
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(absolute);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `diff --git a/${gitPath} b/${gitPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${gitPath}\n@@\n+[Hydra could not read untracked file: ${message}]`;
  }

  if (buffer.includes(0)) {
    return `diff --git a/${gitPath} b/${gitPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${gitPath}\n@@\n+[Binary untracked file omitted from Hydra review prompt]`;
  }

  const body = buffer
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => `+${line}`)
    .join("\n");
  return `diff --git a/${gitPath} b/${gitPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${gitPath}\n@@\n${body}`;
}

function appendLimitedLines(target: string[], text: string, maxLines: number): void {
  if (!text) return;
  const source = text.split(/\r?\n/);
  const remaining = Math.max(0, maxLines - target.length);
  target.push(...source.slice(0, remaining));
  if (source.length > remaining && target.length <= maxLines) {
    target.push(`[... truncated, ${source.length - remaining} more lines ...]`);
  }
}

async function isGitWorkspace(cwd: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = cp.spawn("git", ["rev-parse", "--is-inside-work-tree"], { cwd, windowsHide: true });
    let settled = false;
    child.on("error", () => { if (!settled) { settled = true; resolve(false); } });
    child.on("close", (code) => { if (!settled) { settled = true; resolve(code === 0); } });
  });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function makeNonce(): string {
  return crypto.randomBytes(16).toString("base64url");
}
