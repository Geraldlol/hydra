import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import { constants as fsConstants, watch as watchFileSystem } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { runAgent, AgentSpawn, RunResult, MAX_AGENT_STDOUT_BYTES } from "./agents";
import type { IntegratedBrowserBroker } from "./browserBroker";
import { parseGitStatusEntries, type WorkspaceChange } from "./gitStatus";
import { resolveGitExecutable, workspaceGitExecutionAllowed } from "./gitExecutable";
import { State, Event, AgentId, transition, isInFlight, shouldRunParallelDiscussion, pickReviewers, DEFAULT_ROSTER } from "./phases";
import { Phase, buildPrompt, APPROVED_SENTINEL_RE, SOFT_APPROVAL_RE } from "./prompts";
import { adapterForKind, displayNameFor, getAgentDefinition, isBuiltinAgentId, listAgentDefinitions, reloadAgentDefinitions } from "./agentRegistry";
import type { AdapterRawOutput, Invocation } from "./agentAdapter";
import { runHttpAgent } from "./httpTransport";
import {
  appendMessage,
  archiveAndResetTranscript,
  buildPromptContextWindow,
  ensureGitignore,
  ensureTranscriptFile,
  isAgentMessageRole,
  readTranscript,
  TranscriptContextWindow,
  TranscriptMessage,
} from "./transcript";
import {
  argsSettingKey,
  profileForPhase,
  applySpawnEnvironment,
  buildAgentSpawn,
  effectiveSpawnEnvironment,
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
import { appendFileSafely, ensureFile, readJsonlGuarded, serializePerFile } from "./fileQueue";
import { detectNativeReplyLeak, formatNativeReplyLeakError } from "./nativeReplyGuard";
import { ensureObjectiveFile, objectiveAsContext, readObjective, writeObjective } from "./objective";
import { TerminalBridge, type TerminalBridgeRunResult } from "./terminalBridge";
import { buildDirectTerminalPokePrompt } from "./terminalPoke";
import { buildTerminalPromptFile, terminalProtocolStoragePaths } from "./terminalProtocol";
import {
  cleanupPrivateArtifacts,
  createPrivateArtifact,
  preparePrivateArtifactRoot,
  readPrivateArtifactUtf8,
  redactPrivateArtifactArgs,
  redactPrivateArtifactText,
  sweepPrivateArtifacts,
  type PrivateArtifactBoundary,
} from "./privateArtifacts";
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
  captureVerificationControlFingerprint,
  captureGitHead,
  createVerificationScoringPlan,
  ensureVerificationFile,
  resolveVerificationCommand,
  readVerifications,
  runVerificationCommand,
  verificationAsReviewContext,
  verificationPassed,
  VerificationResult,
  verificationSummary,
  type VerificationCommandResolution,
  type ResolvedVerificationCommand,
  type VerificationScoringPlan,
} from "./verification";
import { buildWorkQueue, type WorkQueueItem } from "./workQueue";
import {
  addRecordToSummary,
  appendUsageRecord,
  boundUsageRecords,
  buildUsageRecord,
  coerceModelPrices,
  DEFAULT_PRICES,
  loadClaudeAutomationSpendThisMonth,
  loadUsageRecords,
  parseCodexTextTokens,
  resolveModelPrices,
  seatDefinitionPrices,
  summarizeUsage,
  UNKNOWN_AGENT_PRICES,
  usageCalendarMonthKey,
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
import {
  aggregateScoreboard,
  listActiveScoreEvidence,
  listPendingScoreClaims,
  type CorrectnessOutcome,
  type ScoreboardAggregate,
  type ScoreboardEvent,
  type VerdictSourceStrength,
} from "./scoreboard";
import {
  appendScoreboardEvents,
  appendScoreboardEventsIfAbsent,
  ensureScoreboardLedger,
  loadScoreboardEvents,
  privateScoreboardPath,
  writeScoreEvidenceMirror,
  writeScoreboardMirror,
} from "./scoreboardStore";
import { scoreboardEventsForVerifiedBuild } from "./scoreboardAutomation";
import {
  aggregateDuels,
  createDuelAdmission,
  createDuelChallenge,
  createDuelCommitment,
  createDuelReveal,
  DUEL_AGENT_RATING_POLICY,
  DUEL_FULL_ACCESS_POLICY_ID,
  hashDuelSharedEvidencePacket,
  initialEmptyDuelAggregate,
  parseDuelAgentCommitmentResponse,
  DuelAcceptanceRejectedError,
  type DuelAgentCallReceipt,
  type DuelAgentCommitmentResponse,
  type DuelAggregate,
  type DuelEvent,
  type DuelOutcome,
  type DuelParticipantCapabilityLock,
  type DuelRevealPayload,
  type DuelView,
} from "./duels";
import {
  appendDuelEvents,
  ensureDuelLedger,
  loadDuelEvents,
  privateDuelLedgerPath,
  writeDuelMirror,
} from "./duelStore";
import {
  deleteDuelCommitmentSecrets,
  duelCommitmentIndexPath,
  ensureDuelCommitmentIndex,
  loadDuelCommitmentSecret,
  storeDuelCommitmentSecret,
  sweepDuelCommitmentSecrets,
} from "./duelSecrets";
import { renderDuelMotivationContext } from "./duelMotivation";
import {
  captureDuelWorkspaceFingerprint,
  watchDuelWorkspaceMutations,
  type DuelWorkspaceMutationMonitor,
} from "./duelWorkspaceGuard";
import {
  buildAgentDuelEvidencePacket,
  hasReservedAgentDuelChallengePrefix,
  hashAgentDuelSource,
  parseAgentDuelIntent,
  stripAgentDuelChallengeControlLines,
  type AgentDuelIntent,
} from "./duelIntent";
import {
  buildDuelCommitmentPrompt,
  duelCapabilityLockSha256,
  duelCommitmentFullAccessArgs,
  duelInvocationSha256,
  duelResponseSha256,
} from "./duelCommitment";
import { chooseEffortInteractively } from "./effortChooser";
import { chooseModelInteractively, refreshCodexModelCatalog, type ModelChooserDeps } from "./modelChooser";
import { effectivePhasedNumberSetting, summarizePhasedSetting } from "./phasedSetting";
import {
  agentTimeoutMs,
  agentInitiatedDuels,
  attachmentMaxBytes,
  attachmentPreviewMaxChars,
  attachmentTotalMaxBytes,
  autoAdvanceActionableDefaults,
  autoAdvanceSendInstructionMaxConsecutive,
  autopilotOnStart,
  autoRequestReviewAfterPassingVerification,
  autoScorePassingBuilds,
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
  roomRoster,
  manyHeadsMode,
  manyHeadsClaudeWorkerCount,
  sessionCostCapUsd,
  shouldClearLegacyAgentTimeout,
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
import { modelForPhase } from "./agentArgs";
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

// Why: skip the per-append mkdir(recursive) syscall on the agent-call trace
// once its parent .hydra/ dir is known to exist. First write still creates it.
const ensuredAgentCallDirs = new Set<string>();
const ONE_SHOT_ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DUEL_COMMITMENT_HEAD_TIMEOUT_MS = 180_000;
const DUEL_TERMINAL_LATE_SECRET_SWEEP_DELAY_MS = DUEL_COMMITMENT_HEAD_TIMEOUT_MS + 5_000;
const MAX_AGENT_DUEL_AUTOMATION_ATTEMPTS = 3;
const AGENT_DUEL_AUTOMATION_RETRY_DELAYS_MS = [5_000, 30_000] as const;

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
  /** Redacted labels only; safe for durable traces and failure cards. */
  promptPath?: string;
  replyPath?: string;
  logPath?: string;
  privateArtifacts?: {
    boundary: PrivateArtifactBoundary;
    promptPath: string;
    replyPath: string;
    logPath: string;
  };
  outputMode: "plain" | "claudeStreamJson" | "codexJson";
}

interface PendingAgentDuelContext {
  /** Latched from the exact dispatched prompt; never re-read from live config. */
  readonly duelProtocolExpected: boolean;
  readonly opponentId: AgentId;
  readonly opponentMessageId: string;
  readonly opponentMessageTimestamp: string;
  readonly opponentMessageText: string;
  readonly latestUserMessage?: string;
}

interface PendingAgentDuelRequest {
  readonly challengerId: AgentId;
  readonly sourceTraceId: string;
  readonly sourceMessageTimestamp: string;
  readonly sourceMessageText: string;
  readonly context: PendingAgentDuelContext;
  readonly intent: AgentDuelIntent;
}

interface HydraPromptEnvelope extends PromptEnvelope {
  /** Explicit provenance from the prompt builder; transcript text cannot forge it. */
  readonly duelProtocolExpected: boolean;
}

interface SerialBuildScoreContext {
  readonly builder: AgentId;
  /** Present only when a command existed before dispatch; otherwise auto-verification live-resolves without scoring. */
  readonly verificationResolution?: ResolvedVerificationCommand;
  readonly verificationScoringPlan?: VerificationScoringPlan;
  readonly beforeFingerprintSha256?: string;
  readonly postFingerprintSha256?: string;
  readonly preVerificationControlSha256?: string;
}

type HttpInvocation = Extract<Invocation, { transport: "http" }>;

interface DuelHeadCommitmentCapture {
  readonly response: DuelAgentCommitmentResponse;
  readonly receipt: DuelAgentCallReceipt;
}

// One turn leg's dispatch plan: either a fully-prepared native spawn (the
// existing one-shot/terminal-bridge path) or an http invocation destined for
// runHttpPipeline. Built in callAgent from buildInvocationFor's Invocation.
type AgentDispatchPlan =
  | { transport: "spawn"; spawn: AgentSpawn }
  | { transport: "http"; invocation: HttpInvocation };

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
  // Extension-host scoped: closing/reopening the webview must not clear a
  // process-termination failure. Only reloading VS Code resets this latch.
  private static unconfirmedNativeTerminationForHost = false;
  private static statusBarUpdater: ((snapshot: HydraStatusBarSnapshot) => void) | undefined;
  private static browserBroker: IntegratedBrowserBroker | undefined;

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
  private scoreEventsUri!: vscode.Uri;
  private scoreboardMirrorUri!: vscode.Uri;
  private scoreEvidenceMirrorUri!: vscode.Uri;
  private duelEventsUri!: vscode.Uri;
  private duelMirrorUri!: vscode.Uri;
  private duelCommitmentIndexUri!: vscode.Uri;
  private objective = "";
  private workspaceInstructions = "";
  private workspaceInstructionsByAgent: Record<AgentId, string> = {};
  private decisions: DecisionPacket[] = [];
  private acceptedDefaultDecisionTimestamp: string | undefined;
  private verifications: VerificationResult[] = [];
  private nativeActions: NativeActionReceipt[] = [];
  private workQueueDispositions: WorkQueueDisposition[] = [];
  private latestDoctorReport: DoctorReport | undefined;
  private scoreboard: ScoreboardAggregate = { eventCount: 0, standings: [], overallStandings: [] };
  private scoreboardError: string | undefined;
  private scoreboardMirrorError: string | undefined;
  private scoreboardRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private scoreboardRefreshRequested = false;
  private scoreboardRefreshFailureMessage: string | undefined;
  private scoreboardRefreshLoop: Promise<void> | undefined;
  private duels: DuelAggregate = initialEmptyDuelAggregate();
  private duelError: string | undefined;
  private duelMirrorError: string | undefined;
  private duelRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private duelCommitmentAbort: AbortController | undefined;
  private readonly pendingAgentDuelContexts = new Map<string, PendingAgentDuelContext>();
  private readonly pendingAgentTraceIds = new Map<string, string>();
  private readonly agentDuelAdmissionQueue: PendingAgentDuelRequest[] = [];
  private readonly agentDuelAutomationQueue: string[] = [];
  private readonly agentDuelAutomationAttempts = new Map<string, number>();
  private readonly agentDuelAutomationRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private agentDuelAutomationRunning = false;
  private drainingAgentDuelAutomation = false;
  private agentDuelAdmissionRunning = false;
  private drainingAgentDuelAdmissions = false;
  private duelSecretSweepTimer: ReturnType<typeof setTimeout> | undefined;
  private duelSecretSweepAtMs: number | undefined;
  private duelSecretCleanupWarningShown = false;
  private queuedUserMessages: QueuedUserMessage[] = [];
  private pendingAttachments: PendingRoomAttachment[] = [];
  private drainingQueuedUserMessages = false;
  private verificationRunning = false;
  private autopilotRunning = false;
  private autopilotSummary = "Not run";
  private terminalPokeInFlight = false;
  private terminalBridgeDispatchInFlight = 0;
  // Session-only overrides used by the smoke test. Persistent user toggles are
  // application-scoped and never written into a workspace settings file.
  private manyHeadsModeOverride: boolean | undefined;
  private autoAdvanceActionableDefaultsOverride: boolean | undefined;
  private get unconfirmedNativeTermination(): boolean {
    return HydraRoomPanel.unconfirmedNativeTerminationForHost;
  }

  private set unconfirmedNativeTermination(value: boolean) {
    HydraRoomPanel.unconfirmedNativeTerminationForHost = value;
  }
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
  // The credit guard must retain the complete UTC-month total even though the
  // UI/session replay below is intentionally tail/row bounded. It is seeded by
  // a bounded-memory full-ledger stream and then folded forward per call.
  private claudeCreditMonthKey = "";
  private claudeCreditMonthSpendUsd = 0;
  // Pre-dispatch estimate for Claude calls currently in flight. This is not a
  // billing ledger; claudeCreditMonthSpendUsd is authoritative once each call completes.
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
  private agentStatuses: Record<AgentId, AgentStatus> = {};
  private gitAvailable = false;
  private workspaceChanges: WorkspaceChange[] = [];
  private workspaceChangesRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private autopilotStartTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
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

  static setBrowserBroker(broker: IntegratedBrowserBroker | undefined): void {
    HydraRoomPanel.browserBroker = broker;
  }

  ready(): Promise<void> {
    return this.initPromise;
  }

  async availableHeads(): Promise<Array<{ id: AgentId; displayName: string }>> {
    await this.ready();
    return this.roster().map((id) => ({ id, displayName: displayNameFor(id) }));
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
        if (e.affectsConfiguration("hydraRoom.agents") || e.affectsConfiguration("hydraRoom.roomRoster")) {
          if (e.affectsConfiguration("hydraRoom.agents")) reloadAgentDefinitions();
          for (const agent of this.roster()) {
            this.agentStatuses[agent] ??= { state: "idle", detail: "Idle" };
          }
          this.postState();
        }
        if (e.affectsConfiguration("hydraRoom.agentInitiatedDuels")) {
          this.postState();
          if (agentInitiatedDuels()) {
            this.requeueOutstandingAgentDuels();
            queueMicrotask(() => void this.drainAgentDuelAdmissions());
            queueMicrotask(() => void this.drainAgentDuelAutomation());
          }
        }
      })
    );
    this.initPromise = this.initialize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.terminalBridgeDispatchInFlight > 0) {
      // Terminal.dispose() has no descendant-exit acknowledgement. Preserve
      // the fail-closed latch even if the user closes and reopens the panel.
      this.unconfirmedNativeTermination = true;
    }
    HydraRoomPanel.instance = undefined;
    if (this.workspaceChangesRefreshTimer) {
      clearTimeout(this.workspaceChangesRefreshTimer);
      this.workspaceChangesRefreshTimer = undefined;
    }
    if (this.duelRefreshTimer) {
      clearTimeout(this.duelRefreshTimer);
      this.duelRefreshTimer = undefined;
    }
    if (this.scoreboardRefreshTimer) {
      clearTimeout(this.scoreboardRefreshTimer);
      this.scoreboardRefreshTimer = undefined;
    }
    this.scoreboardRefreshRequested = false;
    this.scoreboardRefreshFailureMessage = undefined;
    if (this.duelSecretSweepTimer) {
      clearTimeout(this.duelSecretSweepTimer);
      this.duelSecretSweepTimer = undefined;
      this.duelSecretSweepAtMs = undefined;
    }
    for (const timer of this.agentDuelAutomationRetryTimers.values()) clearTimeout(timer);
    this.agentDuelAutomationRetryTimers.clear();
    if (this.autopilotStartTimer) {
      clearTimeout(this.autopilotStartTimer);
      this.autopilotStartTimer = undefined;
    }
    this.currentAbort?.abort();
    this.wikiMaintenanceAbort?.abort();
    this.duelCommitmentAbort?.abort();
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
    if (this.disposed) return;
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
    this.scoreEventsUri = vscode.Uri.file(privateScoreboardPath(this.workspacePrivateStorageRoot()));
    this.scoreboardMirrorUri = vscode.Uri.file(path.join(this.workspaceRoot, ".hydra", "scoreboard.md"));
    this.scoreEvidenceMirrorUri = vscode.Uri.file(path.join(this.workspaceRoot, ".hydra", "score-evidence.md"));
    this.duelEventsUri = vscode.Uri.file(privateDuelLedgerPath(this.workspacePrivateStorageRoot()));
    this.duelMirrorUri = vscode.Uri.file(path.join(this.workspaceRoot, ".hydra", "duels.md"));
    this.duelCommitmentIndexUri = vscode.Uri.file(duelCommitmentIndexPath(this.workspacePrivateStorageRoot()));
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
    await ensureScoreboardLedger(this.scoreEventsUri.fsPath);
    // Attach before the first replay, then replay through the same serialized
    // lane used by watch events. An append in another extension host cannot
    // land in the old load/watch gap or race an older replay into the UI.
    this.startScoreboardLedgerWatcher();
    await this.requestScoreboardRefreshFromLedger(
      "Private standings ledger failed validation; no scores were loaded.",
    );
    await ensureDuelLedger(this.duelEventsUri.fsPath);
    try {
      this.duels = aggregateDuels(await loadDuelEvents(this.duelEventsUri.fsPath));
      this.duelError = undefined;
    } catch {
      // Never replay a partial duel history: it could expose a one-sided seal
      // or award the wrong domain rating.
      this.duels = initialEmptyDuelAggregate();
      this.duelError = "Private duel ledger failed validation; challenges and ratings were not loaded.";
    }
    if (!this.duelError) await this.refreshDuelMirror();
    try {
      await ensureDuelCommitmentIndex(this.duelCommitmentIndexUri.fsPath);
      if (!this.duelError) await this.sweepDuelCommitmentSecretCleanup();
    } catch {
      this.duelSecretCleanupWarningShown = true;
      await vscode.window.showWarningMessage("Hydra could not initialize sealed-answer cleanup. Formal duels remain fail-closed until the private commitment index is available.");
      if (!this.disposed) this.scheduleDuelCommitmentSecretSweep(Date.now() + 60_000);
    }
    this.startDuelLedgerWatcher();
    const usageNow = new Date();
    this.claudeCreditMonthKey = usageCalendarMonthKey(usageNow);
    this.claudeCreditMonthSpendUsd = await loadClaudeAutomationSpendThisMonth(this.usageUri.fsPath, usageNow);
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
    this.workspaceInstructionsByAgent = Object.fromEntries(await Promise.all(
      this.roster().map(async (agent) => [
        agent,
        await readWorkspaceInstructions(this.workspaceRoot, 0, undefined, { agent }),
      ] as const),
    ));
    for (const agent of this.roster()) this.agentStatuses[agent] = { state: "idle", detail: "Idle" };
    this.decisions = await readDecisions(this.decisionsUri.fsPath);
    this.verifications = await readVerifications(this.verificationUri.fsPath);
    this.nativeActions = await readNativeActions(this.nativeActionsUri.fsPath);
    this.workQueueDispositions = await readWorkQueueDispositions(this.workQueueUri.fsPath);
    // `git status` can execute repository-configured helpers such as
    // core.fsmonitor. Never probe or watch Git until Workspace Trust is granted.
    this.gitAvailable = workspaceGitExecutionAllowed() && await isGitWorkspace(this.workspaceRoot);
    await this.refreshWorkspaceChanges();
    if (this.disposed) return;
    this.terminalBridge = this.createTerminalBridge();
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
    if (this.disposed) return;
    this.setMessages(existing.map((m, i) => ({ ...m, id: `prev-${i}` })));
    for (const duel of this.duels.activeDuels) {
      if (
        duel.createdBy === "hydra-runtime"
        && (duel.status === "awaiting_commitments" || duel.status === "awaiting_reveal")
        && !this.agentDuelAutomationQueue.includes(duel.duelId)
      ) {
        this.agentDuelAutomationQueue.push(duel.duelId);
      }
    }
    if (this.unconfirmedNativeTermination) {
      this.appendSystemMessageToUi(this.unconfirmedTerminationMessage());
    }
    this.postState();
    if (this.agentDuelAutomationQueue.length > 0) queueMicrotask(() => void this.drainAgentDuelAutomation());
    this.telegram.startInboundPolling();
    if (autopilotOnStart()) {
      this.autopilotStartTimer = setTimeout(() => {
        this.autopilotStartTimer = undefined;
        if (!this.disposed) void this.runAutopilotStart();
      }, 0);
    }
  }

  // ---------------- public command entry points ----------------

  async sendUserMessage(
    text: string,
    opener: AgentId = this.getFirstSpeaker(),
    options: { telegramChatId?: string; consumePendingAttachments?: boolean } = {}
  ): Promise<void> {
    await this.ready();
    if (this.unconfirmedNativeTermination) {
      this.appendSystemMessageToUi(this.unconfirmedTerminationMessage());
      this.postState();
      return;
    }
    const prepared = this.prepareUserMessageWithAttachments(text, !!options.consumePendingAttachments);
    if (!prepared.displayText) return;
    if (!this.workspaceReady) {
      this.appendSystemMessageToUi("Hydra cannot send yet because no workspace folder is ready. Open a project folder, then send again.");
      this.postState();
      return;
    }
    const selectedOpener = normalizeAgentId(opener, this.getFirstSpeaker(), this.roster());
    if (this.terminalPokeInFlight) {
      const queued = this.appendUserMessageToUi(prepared.displayText);
      this.queuedUserMessages.push({ ...prepared, opener: selectedOpener, timestamp: queued.timestamp, telegramChatId: options.telegramChatId });
      await this.appendSystemMessage("Hydra queued your message until the native terminal action finishes.");
      this.postState();
      return;
    }
    if (this.agentDuelAdmissionRunning || this.agentDuelAutomationRunning || this.duelCommitmentAbort) {
      const queued = this.appendUserMessageToUi(prepared.displayText);
      this.queuedUserMessages.push({ ...prepared, opener: selectedOpener, timestamp: queued.timestamp, telegramChatId: options.telegramChatId });
      await this.appendSystemMessage("Hydra queued your message until autonomous duel admission or sealed commitments finish.");
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
  // replying about a cancelled turn). Busy/non-sendable rooms defer the durable
  // inbox record for a later poll instead of acknowledging an in-memory queue.
  private async sendInboundUserMessage(
    text: string,
    opener: AgentId,
    options: { telegramChatId?: string }
  ): Promise<TelegramInboundTurnOutcome> {
    await this.ready();
    const beforeReplyAt = this.messages.length;
    // Telegram inbox acknowledgement happens only after this method reports a
    // completed/cancelled durable turn. Do not put remote input into the
    // in-memory queue: a window crash would otherwise lose already-acked work.
    if (
      !this.workspaceReady ||
      this.unconfirmedNativeTermination ||
      this.terminalPokeInFlight ||
      this.agentDuelAdmissionRunning ||
      this.agentDuelAutomationRunning ||
      !!this.duelCommitmentAbort ||
      isInFlight(this.state) ||
      !isSendable(this.state)
    ) {
      return { beforeReplyAt, cancelled: false, deferred: true };
    }
    const prepared = this.prepareUserMessageWithAttachments(text, false);
    if (!prepared.displayText) return { beforeReplyAt, cancelled: false, deferred: true };
    const selectedOpener = normalizeAgentId(opener, this.getFirstSpeaker(), this.roster());
    if (!this.autoAdvanceInProgress) this.autoAdvanceSendInstructionCount = 0;
    const stopCountBefore = this.stopRequestCount;
    // Call the reserving turn primitive directly. Going back through
    // sendUserMessage would await ready() a second time, allowing a local send
    // to win the gap and demote this durable remote item into an in-memory
    // queue that the controller would then incorrectly acknowledge.
    await this.startUserMessageTurn(prepared.displayText, prepared.promptText, selectedOpener, {
      alreadyAppended: false,
    });
    void options.telegramChatId;
    return { beforeReplyAt, cancelled: this.stopRequestCount !== stopCountBefore, deferred: false };
  }

  private async startUserMessageTurn(
    displayText: string,
    promptText: string,
    selectedOpener: AgentId,
    options: { alreadyAppended: boolean; timestamp?: string }
  ): Promise<void> {
    if (this.unconfirmedNativeTermination) {
      this.appendSystemMessageToUi(this.unconfirmedTerminationMessage());
      this.postState();
      return;
    }
    const parallel = shouldRunParallelDiscussion(promptText, discussionMode());
    // Transition state synchronously BEFORE any await. A second concurrent
    // sendUserMessage hitting after this.ready() but during appendUserMessage
    // would otherwise pass the guard above and orphan the first turn's
    // currentAbort. Now the second call sees an in-flight discussion and bails at
    // isSendable.
    const previousState = this.state;
    const roster = this.roster();
    this.applyEvent({
      type: "userSent",
      opener: selectedOpener,
      parallel,
      reactor: pickReviewers(selectedOpener, roster)[0] ?? selectedOpener,
      parallelAgents: parallel ? roster : undefined,
    });
    let timestamp = options.timestamp;
    if (!options.alreadyAppended) {
      try {
        timestamp = (await this.appendUserMessage(displayText)).timestamp;
      } catch (err) {
        this.applyEvent({ type: "reservationFailed", restore: previousState });
        this.postState();
        throw err;
      }
    }
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
    this.duelCommitmentAbort?.abort();
    if (
      !isInFlight(this.state) &&
      !this.terminalPokeInFlight &&
      !this.verificationRunning &&
      !this.autopilotRunning &&
      !this.agentDuelAutomationRunning &&
      !this.duelCommitmentAbort
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
    if (!this.isActiveAgent(builder)) {
      await this.appendSystemMessage(`Builder unavailable: ${displayNameFor(builder)} is not currently seated in this room.`);
      this.postState();
      return;
    }
    if (this.unconfirmedNativeTermination) {
      this.appendSystemMessageToUi(this.unconfirmedTerminationMessage());
      this.postState();
      return;
    }
    if (this.state.name !== "AwaitingUser") return;
    // Reserve the build synchronously. A double-click (or duplicate webview
    // message) must not pass the AwaitingUser guard twice while the transcript
    // append below is pending.
    const previousState = this.state;
    this.applyEvent({ type: "assignBuilder", builder });
    try {
      await this.appendSystemMessage(
        `${displayNameFor(builder)} assigned as builder. This is explicit user build authority; previous survey or planning defaults no longer block implementation.`
      );
    } catch (err) {
      this.applyEvent({ type: "reservationFailed", restore: previousState });
      this.postState();
      throw err;
    }
    await this.runBuildPhase(builder);
    await this.drainQueuedUserMessages();
  }

  async assignParallelBuilders(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (this.unconfirmedNativeTermination) {
      this.appendSystemMessageToUi(this.unconfirmedTerminationMessage());
      this.postState();
      return;
    }
    if (this.state.name !== "AwaitingUser") return;
    const agents = this.roster();
    const previousState = this.state;
    this.applyEvent({ type: "assignBuilders", agents });
    try {
      await this.appendSystemMessage(
        `${agents.map(displayNameFor).join(" + ")} assigned as parallel room builders. Hydra will dispatch all ${agents.length} Build workers with the same room objective and transcript context.`
      );
    } catch (err) {
      this.applyEvent({ type: "reservationFailed", restore: previousState });
      this.postState();
      throw err;
    }
    await this.runParallelBuildPhase(agents);
    await this.drainQueuedUserMessages();
  }

  async requestReview(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (this.unconfirmedNativeTermination) {
      this.appendSystemMessageToUi(this.unconfirmedTerminationMessage());
      this.postState();
      return;
    }
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
      reviewer = pickReviewers(this.state.builder, this.roster())[0] ?? this.state.builder;
    }
    this.applyEvent({ type: "requestReview", reviewers: parallelAgents ?? (reviewer ? [reviewer] : undefined) });
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

  private async runVerificationInternal(
    reason: "manual" | "afterBuild",
    latchedResolution?: VerificationCommandResolution,
  ): Promise<VerificationResult | undefined> {
    if (this.unconfirmedNativeTermination) {
      this.appendSystemMessageToUi(this.unconfirmedTerminationMessage());
      this.postState();
      return undefined;
    }
    if (isInFlight(this.state) || this.verificationRunning) {
      await this.appendSystemMessage("Verification is paused because Hydra is already running work.");
      this.postState();
      return undefined;
    }

    // Reserve before resolving an inferred command. Two rapid invocations
    // must not both pass the guard while package.json is being read.
    this.verificationRunning = true;
    this.postState();
    let ctrl: AbortController | undefined;
    let verification: VerificationResult | undefined;
    try {
      const resolution = latchedResolution ?? await resolveVerificationCommand({
        configured: vscode.workspace.getConfiguration("hydraRoom").get<string>("verifyCommand", ""),
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

      ctrl = new AbortController();
      this.currentAbort = ctrl;
      await this.recordEvent("verificationStarted", `${reason === "afterBuild" ? "Auto-verification" : "Verification"} started`, {
        command,
        reason,
      });
      await this.appendSystemMessage(
        `${reason === "afterBuild" ? "Hydra auto-verification started after build" : "Hydra verification started"}:\n${command}`
      );
      const result = await runVerificationCommand({
        cwd: this.workspaceRoot,
        command,
        timeoutMs: verificationTimeoutMs(),
        maxOutputChars: verificationMaxOutputChars(),
        signal: ctrl.signal,
      });
      if (this.latchUnconfirmedNativeTermination(result, "verification")) {
        verification = result;
        this.verifications.push(result);
        await appendVerification(this.verificationUri.fsPath, result);
        await this.appendSystemMessage(
          `${this.unconfirmedTerminationMessage()}${result.stderr ? `\n\n${result.stderr}` : ""}`
        );
      } else if (result.cancelled) {
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
      return verification;
    } finally {
      this.verificationRunning = false;
      if (ctrl && this.currentAbort === ctrl) this.currentAbort = undefined;
      this.postState();
    }
  }

  async acceptDefaultDecision(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady || isInFlight(this.state)) return;
    const action = this.currentDecisionAction();
    if (action.kind === "none") return;

    if (action.kind === "assignBuilder" && action.builder && !this.isActiveAgent(action.builder)) {
      await this.appendSystemMessage(
        `Default decision kept for history but not executed: ${displayNameFor(action.builder)} is no longer a registered, seated head.`,
      );
      this.postState();
      return;
    }

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
    if (vscode.workspace.isTrusted !== true) {
      await this.appendSystemMessage("Auto-advance safe defaults stays off until this workspace is trusted.");
      this.postState();
      return;
    }
    const cfg = vscode.workspace.getConfiguration("hydraRoom");
    const current = autoAdvanceActionableDefaults();
    await cfg.update("autoAdvanceActionableDefaults", !current, vscode.ConfigurationTarget.Global);
    await this.appendSystemMessage(
      `Auto-advance safe defaults is now ${!current ? "on" : "off"} (User setting).`
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
      await this.runParallelBuildPhase([...previousState.builders]);
    } else {
      await this.runBuildPhase(previousState.builder);
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
        !this.agentDuelAdmissionRunning &&
        !this.agentDuelAutomationRunning &&
        !this.duelCommitmentAbort &&
        !isInFlight(this.state) &&
        isSendable(this.state)
      ) {
        const next = this.queuedUserMessages.shift();
        if (!next) break;
        const beforeReplyAt = this.messages.length;
        await this.persistTranscriptMessage({
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
      this.autopilotRunning ||
      this.agentDuelAdmissionRunning ||
      this.agentDuelAutomationRunning ||
      !!this.duelCommitmentAbort
    ) {
      vscode.window.showWarningMessage("Hydra can archive the room after the current work finishes or is stopped.");
      return;
    }
    this.wikiMaintenanceAbort?.abort(); // cancel any in-flight background wiki wrapup before wiping the room

    const result = await archiveAndResetTranscript(this.transcriptUri.fsPath);
    this.setMessages([]);
    this.state = { name: "AwaitingUser" };
    this.suggestedBuilder = undefined;
    for (const agent of this.roster()) this.setAgentStatus(agent, "idle", "Idle");

    const archiveLabel = path.relative(this.workspaceRoot, result.archivePath).replace(/\\/g, "/");
    const archivedSummary = result.archivedMessages === undefined
      ? "room history"
      : `${result.archivedMessages} room message${result.archivedMessages === 1 ? "" : "s"}`;
    await this.appendSystemMessage(
      `Archived ${archivedSummary} to \`${archiveLabel}\`. Room window cleared.`
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

  async openStandings(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    try {
      this.scoreboard = aggregateScoreboard(await loadScoreboardEvents(this.scoreEventsUri.fsPath));
      this.scoreboardError = undefined;
    } catch {
      this.scoreboardError = "Private standings ledger failed validation; no scores were loaded.";
      this.postState();
      await vscode.window.showErrorMessage(this.scoreboardError);
      return;
    }
    if (!(await this.refreshScoreboardMirror())) {
      this.postState();
      await vscode.window.showErrorMessage(this.scoreboardMirrorError ?? "Hydra could not refresh the standings mirror.");
      return;
    }
    this.postState();
    const doc = await vscode.workspace.openTextDocument(this.scoreboardMirrorUri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }

  async openScoreEvidence(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    let events: ScoreboardEvent[];
    try {
      events = await loadScoreboardEvents(this.scoreEventsUri.fsPath);
      this.scoreboard = aggregateScoreboard(events);
      this.scoreboardError = undefined;
    } catch {
      this.scoreboardError = "Private standings ledger failed validation; evidence cannot be reviewed safely.";
      this.postState();
      await vscode.window.showErrorMessage(this.scoreboardError);
      return;
    }
    try {
      await writeScoreEvidenceMirror(this.scoreEvidenceMirrorUri.fsPath, events, displayNameFor);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`Hydra could not render the score evidence report: ${detail}`);
      return;
    }
    this.postState();
    const doc = await vscode.workspace.openTextDocument(this.scoreEvidenceMirrorUri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }

  private async refreshScoreboardMirror(): Promise<boolean> {
    try {
      await writeScoreboardMirror(this.scoreboardMirrorUri.fsPath, this.scoreboard, displayNameFor);
      this.scoreboardMirrorError = undefined;
      return true;
    } catch {
      // The private ledger remains authoritative. A disposable workspace
      // mirror failure must never hide valid scores or imply that an append
      // failed (which could cause the user to record the verdict twice).
      this.scoreboardMirrorError = "Standings are valid, but Hydra could not refresh `.hydra/scoreboard.md`.";
      return false;
    }
  }

  private startScoreboardLedgerWatcher(): void {
    try {
      const watcher = watchFileSystem(this.scoreEventsUri.fsPath, { persistent: false }, () => {
        if (this.disposed) return;
        if (this.scoreboardRefreshTimer) clearTimeout(this.scoreboardRefreshTimer);
        this.scoreboardRefreshTimer = setTimeout(() => {
          this.scoreboardRefreshTimer = undefined;
          void this.requestScoreboardRefreshFromLedger();
        }, 300);
      });
      // Commands in another extension host append under a cross-process lock;
      // this watcher makes those authoritative results visible here without a
      // panel reload. Synchronous command replays still work if watching fails.
      watcher.on("error", () => watcher.close());
      this.disposables.push({ dispose: () => watcher.close() });
    } catch {
      // Some remote/custom filesystems cannot be watched. Score commands remain
      // usable and perform a complete replay before every mutation.
    }
  }

  private requestScoreboardRefreshFromLedger(
    failureMessage = "Private standings ledger failed validation; cross-window scores were hidden.",
  ): Promise<void> {
    this.scoreboardRefreshRequested = true;
    this.scoreboardRefreshFailureMessage = failureMessage;
    if (this.scoreboardRefreshLoop) return this.scoreboardRefreshLoop;

    const loop = this.drainScoreboardRefreshRequests();
    this.scoreboardRefreshLoop = loop;
    const finish = () => {
      if (this.scoreboardRefreshLoop !== loop) return;
      this.scoreboardRefreshLoop = undefined;
      if (this.scoreboardRefreshRequested && !this.disposed) {
        void this.requestScoreboardRefreshFromLedger(
          this.scoreboardRefreshFailureMessage
            ?? "Private standings ledger failed validation; cross-window scores were hidden.",
        );
      }
    };
    void loop.then(finish, finish);
    return loop;
  }

  private async drainScoreboardRefreshRequests(): Promise<void> {
    while (this.scoreboardRefreshRequested && !this.disposed) {
      this.scoreboardRefreshRequested = false;
      const failureMessage = this.scoreboardRefreshFailureMessage
        ?? "Private standings ledger failed validation; cross-window scores were hidden.";
      this.scoreboardRefreshFailureMessage = undefined;
      await this.refreshScoreboardFromLedgerWatcher(failureMessage);
    }
  }

  private async refreshScoreboardFromLedgerWatcher(failureMessage: string): Promise<void> {
    if (this.disposed) return;
    try {
      this.scoreboard = aggregateScoreboard(await loadScoreboardEvents(this.scoreEventsUri.fsPath));
      this.scoreboardError = undefined;
      await this.refreshScoreboardMirror();
    } catch {
      // Fail closed instead of leaving another window's stale crown visible
      // after malformed or referentially invalid history reaches the ledger.
      this.scoreboard = { eventCount: 0, standings: [], overallStandings: [] };
      this.scoreboardError = failureMessage;
    }
    this.postState();
  }

  async recordScoreVerdict(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (this.scoreboardError) {
      await vscode.window.showErrorMessage(this.scoreboardError);
      return;
    }

    const claimant = await vscode.window.showQuickPick(
      this.roster().map((agentId) => ({ label: displayNameFor(agentId), description: agentId, agentId })),
      { title: "Hydra Standings: Select Claimant", placeHolder: "Which head made the claim?", ignoreFocusOut: true },
    );
    if (!claimant) return;

    const domainPick = await vscode.window.showQuickPick(
      [
        { label: "Runtime", value: "runtime", description: "Behavior, debugging, and implementation correctness" },
        { label: "Architecture", value: "architecture", description: "System design and tradeoff predictions" },
        { label: "Security", value: "security", description: "Threats, controls, and safety claims" },
        { label: "UX", value: "ux", description: "Usability and interface claims" },
        { label: "Requirements", value: "requirements", description: "Interpretation of the user's intent" },
        { label: "Research", value: "research", description: "Externally verifiable factual claims" },
        { label: "Custom…", value: "custom", description: "Enter another lowercase domain slug" },
      ],
      { title: "Hydra Standings: Domain", placeHolder: "What kind of claim was this?", ignoreFocusOut: true },
    );
    if (!domainPick) return;
    let domain = domainPick.value;
    if (domain === "custom") {
      const custom = await vscode.window.showInputBox({
        title: "Hydra Standings: Custom Domain",
        prompt: "Use a lowercase slug, for example database or product-strategy.",
        ignoreFocusOut: true,
        validateInput: (value) => /^[a-z][a-z0-9-]{0,31}$/.test(value.trim())
          ? undefined
          : "Use 1-32 lowercase letters, digits, or hyphens; start with a letter.",
      });
      if (custom === undefined) return;
      domain = custom.trim();
    }

    const outcomePick = await vscode.window.showQuickPick(
      [
        { label: "Correct", value: "correct" as CorrectnessOutcome, description: "The material claim held up" },
        { label: "Partially correct", value: "partial" as CorrectnessOutcome, description: "Useful core, but materially incomplete" },
        { label: "Incorrect", value: "incorrect" as CorrectnessOutcome, description: "The material claim failed" },
        { label: "Unresolved", value: "unresolved" as CorrectnessOutcome, description: "Not enough evidence yet; no score" },
        { label: "Void", value: "void" as CorrectnessOutcome, description: "Not falsifiable or invalid comparison; no score" },
      ],
      { title: "Hydra Standings: Outcome", placeHolder: "What did the evidence show?", ignoreFocusOut: true },
    );
    if (!outcomePick) return;

    const latestVerification = this.latestVerification();
    const deterministicEvidence = latestVerification && verificationPassed(latestVerification)
      ? latestVerification
      : undefined;
    const evidenceSources: Array<{ label: string; value: VerdictSourceStrength; description: string }> = [];
    if (deterministicEvidence && outcomePick.value === "correct") {
      evidenceSources.push({
        label: "Exact latest passing verification",
        value: "deterministic",
        description: `Creates a fixed claim for ${deterministicEvidence.command} at ${deterministicEvidence.timestamp}`,
      });
    }
    evidenceSources.push(
      { label: "Human adjudication", value: "human", description: "Your explicit review of the evidence" },
      { label: "Peer assessment (advisory)", value: "peer", description: "Recorded for discussion; contributes zero score" },
    );
    const sourcePick = await vscode.window.showQuickPick(
      evidenceSources,
      { title: "Hydra Standings: Evidence Source", placeHolder: "Who or what established the outcome?", ignoreFocusOut: true },
    );
    if (!sourcePick) return;

    let statement: string;
    if (sourcePick.value === "deterministic" && deterministicEvidence) {
      statement = `Hydra verification passed at ${deterministicEvidence.timestamp} for Git ${deterministicEvidence.headSha ?? "unrecorded HEAD"}: ${deterministicEvidence.command}`.slice(0, 2_000);
    } else {
      const enteredStatement = await vscode.window.showInputBox({
        title: "Hydra Standings: Claim",
        prompt: "Record the falsifiable claim being judged.",
        ignoreFocusOut: true,
        validateInput: (value) => value.trim().length === 0
          ? "A claim is required."
          : value.trim().length > 2_000
            ? "Keep the claim at 2,000 characters or fewer."
            : undefined,
      });
      if (enteredStatement === undefined) return;
      statement = enteredStatement.trim();
    }

    let adjudicatorId = sourcePick.value === "deterministic" ? "verification" : "local-user";
    if (sourcePick.value === "peer") {
      const peer = await vscode.window.showQuickPick(
        this.roster()
          .filter((agentId) => agentId !== claimant.agentId)
          .map((agentId) => ({ label: displayNameFor(agentId), description: agentId, agentId })),
        { title: "Hydra Standings: Peer", placeHolder: "Which other head made the advisory assessment?", ignoreFocusOut: true },
      );
      if (!peer) return;
      adjudicatorId = peer.agentId;
    }

    const rationale = await vscode.window.showInputBox({
      title: "Hydra Standings: Evidence Note",
      prompt: "Record why the cited evidence establishes this outcome.",
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length === 0
        ? "An evidence note is required."
        : value.trim().length > 2_000
          ? "Keep the note at 2,000 characters or fewer."
          : undefined,
    });
    if (rationale === undefined) return;

    const now = new Date().toISOString();
    const evidenceRef = sourcePick.value === "deterministic" && deterministicEvidence
      ? `verification:${deterministicEvidence.timestamp}:${deterministicEvidence.headSha ?? "no-head"}:${crypto.createHash("sha256").update(`${deterministicEvidence.command}\0${deterministicEvidence.stdout}\0${deterministicEvidence.stderr}`).digest("hex")}`
      : sourcePick.value === "human"
        ? `human:local-user:${now}`
        : `peer:${adjudicatorId}:${now}`;
    const latestUserMessage = [...this.messages].reverse().find((message) => message.role === "user");
    const roundId = `round-${(latestUserMessage?.timestamp ?? now).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 96)}`;
    const claimId = `claim-${crypto.randomUUID()}`;
    const verdictId = `verdict-${crypto.randomUUID()}`;
    const events: ScoreboardEvent[] = [
      {
        type: "claimRegistered",
        eventId: `event-${crypto.randomUUID()}`,
        occurredAt: now,
        claimId,
        roundId,
        agentId: claimant.agentId,
        domain,
        statement,
        confidence: null,
      },
      {
        type: "verdictRecorded",
        eventId: `event-${crypto.randomUUID()}`,
        occurredAt: now,
        verdictId,
        claimId,
        outcome: outcomePick.value,
        source: sourcePick.value,
        adjudicatorId,
        evidenceRef,
        rationale: rationale.trim(),
      },
    ];

    try {
      this.scoreboard = await appendScoreboardEvents(this.scoreEventsUri.fsPath, events);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`Hydra could not record the verdict: ${detail}`);
      return;
    }
    const mirrorOk = await this.refreshScoreboardMirror();
    this.postState();
    const mirrorNote = mirrorOk ? "" : " The verdict is safely recorded, but the Markdown mirror needs repair.";
    await vscode.window.showInformationMessage(
      `Recorded ${outcomePick.label.toLowerCase()} for ${displayNameFor(claimant.agentId)} in ${domain}${sourcePick.value === "peer" ? " (advisory only)" : ""}.${mirrorNote}`,
      "Open Standings",
    ).then((choice) => choice === "Open Standings" ? this.openStandings() : undefined);
  }

  async reverseScoreVerdict(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    let events: ScoreboardEvent[];
    try {
      events = await loadScoreboardEvents(this.scoreEventsUri.fsPath);
      this.scoreboardError = undefined;
    } catch {
      this.scoreboardError = "Private standings ledger failed validation; no verdict can be reversed safely.";
      this.postState();
      await vscode.window.showErrorMessage(this.scoreboardError);
      return;
    }

    const active = listActiveScoreEvidence(events);
    if (active.length === 0) {
      await vscode.window.showInformationMessage("Hydra has no active score verdicts to reverse.");
      return;
    }
    const selected = await vscode.window.showQuickPick(
      active.map(({ claim, verdict }) => ({
        label: `${displayNameFor(claim.agentId)} · ${verdict.outcome}`,
        description: `${claim.domain} · ${new Date(verdict.occurredAt).toLocaleString()}`,
        detail: claim.statement.length > 180 ? `${claim.statement.slice(0, 177)}…` : claim.statement,
        verdictId: verdict.verdictId,
      })),
      {
        title: "Hydra Standings: Reverse Verdict",
        placeHolder: "Select the active verdict whose evidence or adjudication was wrong",
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true,
      },
    );
    if (!selected) return;

    const reason = await vscode.window.showInputBox({
      title: "Hydra Standings: Reversal Reason",
      prompt: "Explain why this verdict should no longer affect the standings. The reversal is append-only and auditable.",
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length === 0
        ? "A reversal reason is required."
        : value.trim().length > 2_000
          ? "Keep the reason at 2,000 characters or fewer."
          : undefined,
    });
    if (reason === undefined) return;

    try {
      this.scoreboard = await appendScoreboardEvents(this.scoreEventsUri.fsPath, [{
        type: "verdictReversed",
        eventId: `event-${crypto.randomUUID()}`,
        occurredAt: new Date().toISOString(),
        targetVerdictId: selected.verdictId,
        reversedBy: "local-user",
        reason: reason.trim(),
      }]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`Hydra could not reverse the verdict: ${detail}`);
      return;
    }
    const mirrorOk = await this.refreshScoreboardMirror();
    this.postState();
    const mirrorNote = mirrorOk ? "" : " The reversal is safely recorded, but the Markdown mirror needs repair.";
    await vscode.window.showInformationMessage(
      `Verdict reversed. Its claim is now pending and no longer affects the standings.${mirrorNote}`,
      "Adjudicate Pending",
      "Review Evidence",
    ).then((choice) => choice === "Adjudicate Pending"
      ? this.adjudicatePendingScoreClaim()
      : choice === "Review Evidence"
        ? this.openScoreEvidence()
        : undefined);
  }

  async adjudicatePendingScoreClaim(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    let events: ScoreboardEvent[];
    try {
      events = await loadScoreboardEvents(this.scoreEventsUri.fsPath);
      this.scoreboardError = undefined;
    } catch {
      this.scoreboardError = "Private standings ledger failed validation; pending claims cannot be adjudicated safely.";
      this.postState();
      await vscode.window.showErrorMessage(this.scoreboardError);
      return;
    }

    const pending = listPendingScoreClaims(events);
    if (pending.length === 0) {
      await vscode.window.showInformationMessage("Hydra has no pending score claims.");
      return;
    }
    const selected = await vscode.window.showQuickPick(
      pending.map((claim) => ({
        label: displayNameFor(claim.agentId),
        description: `${claim.domain} · ${new Date(claim.occurredAt).toLocaleString()}`,
        detail: claim.statement.length > 180 ? `${claim.statement.slice(0, 177)}…` : claim.statement,
        claim,
      })),
      {
        title: "Hydra Standings: Adjudicate Pending Claim",
        placeHolder: "Select a claim whose previous verdict was reversed",
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true,
      },
    );
    if (!selected) return;

    const outcomePick = await vscode.window.showQuickPick(
      [
        { label: "Correct", value: "correct" as CorrectnessOutcome },
        { label: "Partially correct", value: "partial" as CorrectnessOutcome },
        { label: "Incorrect", value: "incorrect" as CorrectnessOutcome },
        { label: "Unresolved", value: "unresolved" as CorrectnessOutcome },
        { label: "Void", value: "void" as CorrectnessOutcome },
      ],
      { title: "Hydra Standings: Replacement Outcome", placeHolder: "What does the corrected evidence show?", ignoreFocusOut: true },
    );
    if (!outcomePick) return;

    const sourcePick = await vscode.window.showQuickPick(
      [
        { label: "Human adjudication", value: "human" as VerdictSourceStrength, description: "Your explicit review of the corrected evidence" },
        { label: "Peer assessment (advisory)", value: "peer" as VerdictSourceStrength, description: "Visible for discussion; contributes zero score" },
      ],
      { title: "Hydra Standings: Replacement Evidence", placeHolder: "Who established the corrected outcome?", ignoreFocusOut: true },
    );
    if (!sourcePick) return;

    let adjudicatorId = "local-user";
    if (sourcePick.value === "peer") {
      const peer = await vscode.window.showQuickPick(
        this.roster()
          .filter((agentId) => agentId !== selected.claim.agentId)
          .map((agentId) => ({ label: displayNameFor(agentId), description: agentId, agentId })),
        { title: "Hydra Standings: Replacement Peer", placeHolder: "Which other head supplied the advisory correction?", ignoreFocusOut: true },
      );
      if (!peer) return;
      adjudicatorId = peer.agentId;
    }

    const rationale = await vscode.window.showInputBox({
      title: "Hydra Standings: Corrected Evidence Note",
      prompt: "Explain why the replacement outcome follows from the corrected evidence.",
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length === 0
        ? "A corrected evidence note is required."
        : value.trim().length > 2_000
          ? "Keep the note at 2,000 characters or fewer."
          : undefined,
    });
    if (rationale === undefined) return;

    const now = new Date().toISOString();
    try {
      this.scoreboard = await appendScoreboardEvents(this.scoreEventsUri.fsPath, [{
        type: "verdictRecorded",
        eventId: `event-${crypto.randomUUID()}`,
        occurredAt: now,
        verdictId: `verdict-${crypto.randomUUID()}`,
        claimId: selected.claim.claimId,
        outcome: outcomePick.value,
        source: sourcePick.value,
        adjudicatorId,
        evidenceRef: sourcePick.value === "human"
          ? `human:local-user:${now}`
          : `peer:${adjudicatorId}:${now}`,
        rationale: rationale.trim(),
      }]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`Hydra could not adjudicate the pending claim: ${detail}`);
      return;
    }
    const mirrorOk = await this.refreshScoreboardMirror();
    this.postState();
    const mirrorNote = mirrorOk ? "" : " The replacement is safely recorded, but the Markdown mirror needs repair.";
    await vscode.window.showInformationMessage(
      `Replacement verdict recorded for ${displayNameFor(selected.claim.agentId)}${sourcePick.value === "peer" ? " (advisory only)" : ""}.${mirrorNote}`,
      "Review Evidence",
    ).then((choice) => choice === "Review Evidence" ? this.openScoreEvidence() : undefined);
  }

  async openDuelsPanel(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    try {
      this.duels = aggregateDuels(await loadDuelEvents(this.duelEventsUri.fsPath));
      this.duelError = undefined;
    } catch {
      this.duels = initialEmptyDuelAggregate();
      this.duelError = "Private duel ledger failed validation; formal duels and ratings were not loaded.";
      this.postState();
      await vscode.window.showErrorMessage(this.duelError);
      return;
    }
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.postState();
    await this.panel.webview.postMessage({ type: "openPanel", panel: "duels" });
  }

  async openDuelAudit(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    let events: DuelEvent[];
    try {
      events = await loadDuelEvents(this.duelEventsUri.fsPath);
      this.duels = aggregateDuels(events);
      this.duelError = undefined;
    } catch {
      this.duels = initialEmptyDuelAggregate();
      this.duelError = "Private duel ledger failed validation; the duel audit cannot be rendered safely.";
      this.postState();
      await vscode.window.showErrorMessage(this.duelError);
      return;
    }
    if (!(await this.refreshDuelMirror(events))) {
      this.postState();
      await vscode.window.showErrorMessage(this.duelMirrorError ?? "Hydra could not refresh the duel audit mirror.");
      return;
    }
    this.postState();
    const doc = await vscode.workspace.openTextDocument(this.duelMirrorUri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }

  private async refreshDuelMirror(events?: readonly DuelEvent[]): Promise<boolean> {
    try {
      const source = events ?? await loadDuelEvents(this.duelEventsUri.fsPath);
      await writeDuelMirror(this.duelMirrorUri.fsPath, source, displayNameFor);
      this.duelMirrorError = undefined;
      return true;
    } catch {
      // The append-only private ledger is authoritative. The workspace mirror
      // is disposable and a mirror error must not encourage a duplicate event.
      this.duelMirrorError = "Duels are valid, but Hydra could not refresh `.hydra/duels.md`.";
      return false;
    }
  }

  private async admitAgentInitiatedDuel(request: PendingAgentDuelRequest): Promise<void> {
    const challenger = request.challengerId;
    const challenged = request.context.opponentId;
    const reject = async (reason: string): Promise<void> => {
      const detail = `${displayNameFor(challenger)} challenge rejected: ${reason} No duel or Elo change occurred.`;
      await this.appendSystemMessage(detail);
      await this.recordEvent("diagnostic", detail, {
        challenger,
        challenged,
        sourceMessageSha256: hashAgentDuelSource(request.sourceMessageText),
        protocol: "agent-intent-v1",
      });
    };

    if (!agentInitiatedDuels()) {
      await reject("agent-initiated duels are paused in Hydra settings.");
      return;
    }
    if (!vscode.workspace.isTrusted) {
      await reject("the workspace is not trusted, so autonomous full-native calls are disabled.");
      return;
    }
    const roster = this.roster();
    if (!roster.includes(challenger) || !roster.includes(challenged) || challenger === challenged) {
      await reject("the Hydra-bound challenger/opponent pair is not a valid seated pair.");
      return;
    }
    if (!this.supportsFullAccessRatedDuel(challenger) || !this.supportsFullAccessRatedDuel(challenged)) {
      await reject("both heads must support Hydra's equal full-native rated profile; no exhibition fallback was created.");
      return;
    }
    const missingConsent = [challenger, challenged].filter((agent) =>
      !this.context.workspaceState.get<boolean>(fullNativeConsentKey(agent), false)
    );
    if (missingConsent.length > 0) {
      await reject(
        `persistent full-native consent is required for ${missingConsent.map(displayNameFor).join(", ")}; Hydra will not open a background consent prompt.`,
      );
      return;
    }
    if (this.sessionCostCapExceeded()) {
      await reject("the session cost cap has been reached.");
      return;
    }
    if (this.duelError) {
      await reject("the private duel ledger is unavailable or invalid.");
      return;
    }

    let packet: string;
    try {
      packet = buildAgentDuelEvidencePacket({
        challengerId: challenger,
        challengedId: challenged,
        sourceReplyTimestamp: request.sourceMessageTimestamp,
        disputedMessageTimestamp: request.context.opponentMessageTimestamp,
        disputedMessage: request.context.opponentMessageText,
        latestUserMessage: request.context.latestUserMessage,
        intent: request.intent,
      });
    } catch (error) {
      await reject(error instanceof Error ? error.message : String(error));
      return;
    }

    const occurredAt = new Date().toISOString();
    const duelId = `duel-${crypto.randomUUID()}`;
    const makeChallenge = (
      workspaceFingerprintSha256: string,
      capabilityLocks: readonly [DuelParticipantCapabilityLock, DuelParticipantCapabilityLock],
    ): DuelEvent & { type: "duelChallenged" } => createDuelChallenge({
        eventId: `event-${duelId}-challenge`,
        occurredAt,
        duelId,
        challengerId: challenger,
        challengedId: challenged,
        domain: request.intent.domain,
        proposition: request.intent.proposition,
        evidenceContract: request.intent.evidenceContract,
        sharedEvidencePacket: packet,
        adjudicatorType: "human",
        adjudicatorId: "local-user",
        createdBy: "hydra-runtime",
        initiation: {
          protocol: "agent-intent-v1",
          agentId: challenger,
          sourceTraceId: request.sourceTraceId,
          sourceMessageTimestamp: request.sourceMessageTimestamp,
          sourceMessageSha256: hashAgentDuelSource(request.sourceMessageText),
          disputedMessageTimestamp: request.context.opponentMessageTimestamp,
          workspaceFingerprintSha256,
          capabilityLocks,
        },
      });

    // Reject cheap policy conflicts before executable resolution or workspace
    // hashing. The final locked replay below repeats this check under append.
    try {
      const events = await loadDuelEvents(this.duelEventsUri.fsPath);
      const placeholderLocks = [challenger, challenged].map((agent): DuelParticipantCapabilityLock => ({
        agentId: agent,
        agentKind: getAgentDefinition(agent)?.kind ?? "unknown",
        profileSha256: "0".repeat(64),
      })) as [DuelParticipantCapabilityLock, DuelParticipantCapabilityLock];
      const provisional = makeChallenge("0".repeat(64), placeholderLocks);
      createDuelAdmission([...events, provisional], {
        eventId: `event-${duelId}-policy-check`,
        occurredAt,
        duelId,
      });
    } catch (error) {
      const reason = error instanceof DuelAcceptanceRejectedError
        ? `Hydra policy blocked it (${error.reasons.join(", ")}).`
        : error instanceof Error ? error.message : String(error);
      await reject(reason);
      return;
    }

    let capabilityLocks: [DuelParticipantCapabilityLock, DuelParticipantCapabilityLock];
    try {
      capabilityLocks = await Promise.all([
        this.captureFullAccessDuelHeadLock(challenger),
        this.captureFullAccessDuelHeadLock(challenged),
      ]);
    } catch (error) {
      await reject(`the equal full-native preflight failed (${error instanceof Error ? error.message : String(error)}).`);
      return;
    }
    let workspaceFingerprintSha256: string;
    try {
      workspaceFingerprintSha256 = (await captureDuelWorkspaceFingerprint(this.workspaceRoot)).sha256;
    } catch (error) {
      await reject(`Hydra could not lock one safe shared workspace state (${error instanceof Error ? error.message : String(error)}).`);
      return;
    }
    const challenge = makeChallenge(workspaceFingerprintSha256, capabilityLocks);

    try {
      const events = await loadDuelEvents(this.duelEventsUri.fsPath);
      const admission = createDuelAdmission([...events, challenge], {
        eventId: `event-${crypto.randomUUID()}`,
        occurredAt: new Date().toISOString(),
        duelId,
      });
      // One logical append means a concurrent cooldown winner cannot leave an
      // orphan challenge if this admission loses the cross-process race.
      this.duels = await appendDuelEvents(this.duelEventsUri.fsPath, [challenge, admission]);
      this.duelError = undefined;
    } catch (error) {
      const reason = error instanceof DuelAcceptanceRejectedError
        ? `Hydra policy blocked it (${error.reasons.join(", ")}).`
        : error instanceof Error
          ? error.message
          : String(error);
      await reject(reason);
      return;
    }

    await this.refreshDuelMirror();
    await this.appendSystemMessage(
      `${displayNameFor(challenger)} initiated a rated ${request.intent.domain} duel against ${displayNameFor(challenged)}. Hydra admitted it by policy and queued both equal full-native sealed commitments. Proposition: ${request.intent.proposition}`,
    );
    await this.recordEvent("diagnostic", "Hydra admitted an agent-initiated formal duel.", {
      duelId,
      challenger,
      challenged,
      protocol: "agent-intent-v1",
    });
    this.enqueueAgentDuelAutomation(duelId);
    this.postState();
  }

  private enqueueAgentDuelAutomation(duelId: string): void {
    if (!this.agentDuelAutomationQueue.includes(duelId)) this.agentDuelAutomationQueue.push(duelId);
    this.postState();
    queueMicrotask(() => void this.drainAgentDuelAutomation());
  }

  private enqueueAgentDuelAdmission(request: PendingAgentDuelRequest): void {
    this.agentDuelAdmissionQueue.push(request);
    this.postState();
    queueMicrotask(() => void this.drainAgentDuelAdmissions());
  }

  /**
   * Admission fingerprints a shared evidence state, so it must never race a
   * closer/build/review turn. Reactor and closer intents are collected during
   * finalization, then processed only after the room returns fully idle.
   */
  private async drainAgentDuelAdmissions(): Promise<void> {
    if (this.drainingAgentDuelAdmissions || this.disposed) return;
    if (
      !agentInitiatedDuels()
      || !this.workspaceReady
      || this.currentAbort
      || isInFlight(this.state)
      || this.terminalPokeInFlight
      || this.verificationRunning
      || this.autopilotRunning
      || this.agentDuelAutomationRunning
      || this.duelCommitmentAbort
      || this.queuedUserMessages.length > 0
    ) {
      return;
    }
    this.drainingAgentDuelAdmissions = true;
    try {
      while (
        agentInitiatedDuels()
        && this.agentDuelAdmissionQueue.length > 0
        && !this.currentAbort
        && !isInFlight(this.state)
        && this.queuedUserMessages.length === 0
      ) {
        const request = this.agentDuelAdmissionQueue.shift();
        if (!request) break;
        this.agentDuelAdmissionRunning = true;
        this.postState();
        try {
          await this.admitAgentInitiatedDuel(request);
        } catch (error) {
          const detail = boundedRuntimeDuelReason(error instanceof Error ? error.message : String(error));
          await this.appendSystemMessage(`Hydra could not process the agent's duel request: ${detail} No duel or Elo change occurred.`);
        } finally {
          this.agentDuelAdmissionRunning = false;
          this.postState();
        }
      }
    } finally {
      this.drainingAgentDuelAdmissions = false;
      this.postState();
      if (this.agentDuelAutomationQueue.length > 0) queueMicrotask(() => void this.drainAgentDuelAutomation());
      if (this.queuedUserMessages.length > 0) void this.drainQueuedUserMessages();
    }
  }

  private async drainAgentDuelAutomation(): Promise<void> {
    if (this.drainingAgentDuelAutomation || this.disposed) return;
    if (
      !agentInitiatedDuels()
      || !this.workspaceReady
      || this.agentDuelAdmissionRunning
      || this.drainingAgentDuelAdmissions
      || this.unconfirmedNativeTermination
      || this.terminalPokeInFlight
      || isInFlight(this.state)
      || this.queuedUserMessages.length > 0
      || this.verificationRunning
      || this.autopilotRunning
      || this.duelCommitmentAbort
    ) {
      return;
    }
    this.drainingAgentDuelAutomation = true;
    try {
      while (
        agentInitiatedDuels()
        && this.agentDuelAutomationQueue.length > 0
        && this.queuedUserMessages.length === 0
        && !isInFlight(this.state)
      ) {
        const duelId = this.agentDuelAutomationQueue.shift();
        if (!duelId) break;
        this.agentDuelAutomationRunning = true;
        this.postState();
        try {
          await this.runAgentDuelAutomation(duelId);
          this.agentDuelAutomationAttempts.delete(duelId);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await this.scheduleAgentDuelAutomationRetry(duelId, detail);
        } finally {
          this.agentDuelAutomationRunning = false;
          this.postState();
        }
      }
    } finally {
      this.drainingAgentDuelAutomation = false;
      this.postState();
      if (this.queuedUserMessages.length > 0) void this.drainQueuedUserMessages();
    }
  }

  private async scheduleAgentDuelAutomationRetry(duelId: string, detail: string): Promise<void> {
    const attempt = (this.agentDuelAutomationAttempts.get(duelId) ?? 0) + 1;
    this.agentDuelAutomationAttempts.set(duelId, attempt);
    const safeDetail = boundedRuntimeDuelReason(detail);
    if (attempt >= MAX_AGENT_DUEL_AUTOMATION_ATTEMPTS) {
      await this.appendSystemMessage(
        `Agent-initiated duel ${duelId} paused after ${attempt} automatic commitment attempts: ${safeDetail} No exhibition or manual answer was substituted. Fix the native head/profile, then re-enable agent challenges or reload Hydra to resume; cancellation remains available and Elo is unchanged.`,
      );
      return;
    }
    const delayMs = AGENT_DUEL_AUTOMATION_RETRY_DELAYS_MS[Math.min(
      attempt - 1,
      AGENT_DUEL_AUTOMATION_RETRY_DELAYS_MS.length - 1,
    )]!;
    await this.appendSystemMessage(
      `Agent-initiated duel ${duelId} commitment attempt ${attempt} failed: ${safeDetail} Hydra will retry automatically in ${Math.round(delayMs / 1_000)} seconds; no fallback answer or Elo change occurred.`,
    );
    const existing = this.agentDuelAutomationRetryTimers.get(duelId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.agentDuelAutomationRetryTimers.delete(duelId);
      if (!this.disposed) this.enqueueAgentDuelAutomation(duelId);
    }, delayMs);
    timer.unref();
    this.agentDuelAutomationRetryTimers.set(duelId, timer);
  }

  private requeueOutstandingAgentDuels(): void {
    for (const timer of this.agentDuelAutomationRetryTimers.values()) clearTimeout(timer);
    this.agentDuelAutomationRetryTimers.clear();
    this.agentDuelAutomationAttempts.clear();
    for (const duel of this.duels.activeDuels) {
      if (
        duel.createdBy === "hydra-runtime"
        && (duel.status === "awaiting_commitments" || duel.status === "awaiting_reveal")
        && !this.agentDuelAutomationQueue.includes(duel.duelId)
      ) {
        this.agentDuelAutomationQueue.push(duel.duelId);
      }
    }
    this.postState();
  }

  private async runAgentDuelAutomation(duelId: string): Promise<void> {
    let events = await loadDuelEvents(this.duelEventsUri.fsPath);
    let duel = aggregateDuels(events).activeDuels.find((candidate) => candidate.duelId === duelId);
    if (!duel || duel.createdBy !== "hydra-runtime") return;
    let mutationMonitor: DuelWorkspaceMutationMonitor;
    try {
      mutationMonitor = watchDuelWorkspaceMutations(this.workspaceRoot);
    } catch (error) {
      await this.cancelAgentDuelForIntegrity(
        duel,
        `Hydra could not start the live workspace mutation monitor: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    try {
    const workspaceFingerprintSha256 = duel.initiation?.workspaceFingerprintSha256;
    if (!workspaceFingerprintSha256) {
      await this.cancelAgentDuelForIntegrity(duel, "The agent challenge has no durable admission workspace fingerprint.");
      return;
    }
    if (!(await this.ensureAgentDuelWorkspaceIntegrity(duel, "before either commitment", mutationMonitor))) return;

    if (duel.status === "awaiting_commitments") {
      const sealed = new Set(events.flatMap((event) =>
        event.type === "duelCommitmentSealed" && event.duelId === duelId ? [event.participantId] : []
      ));
      for (const participant of [duel.challengerId, duel.challengedId]) {
        if (sealed.has(participant)) continue;
        const capabilityLock = duel.initiation?.capabilityLocks.find((lock) => lock.agentId === participant);
        if (!capabilityLock) {
          await this.cancelAgentDuelForIntegrity(duel, `No admission capability lock exists for ${displayNameFor(participant)}.`);
          return;
        }
        if (!(await this.sealDuelCommitment(
          duel,
          participant,
          false,
          workspaceFingerprintSha256,
          capabilityLock.profileSha256,
        ))) {
          throw new Error(`${displayNameFor(participant)} did not produce a durable sealed commitment.`);
        }
        if (!(await this.ensureAgentDuelWorkspaceIntegrity(
          duel,
          `after ${displayNameFor(participant)} committed`,
          mutationMonitor,
        ))) return;
        events = await loadDuelEvents(this.duelEventsUri.fsPath);
        duel = aggregateDuels(events).activeDuels.find((candidate) => candidate.duelId === duelId);
        if (!duel) return;
      }
    }

    if (duel.status === "awaiting_reveal") {
      if (!(await this.revealDuelCommitmentsIfReady(duelId, false))) {
        throw new Error("Hydra could not verify the paired commitment reveal.");
      }
    }
    const ready = this.duels.activeDuels.find((candidate) => candidate.duelId === duelId);
    if (ready?.status === "awaiting_adjudication") {
      await this.appendSystemMessage(
        `${displayNameFor(ready.challengerId)} vs ${displayNameFor(ready.challengedId)} is fully revealed and awaiting your independent evidence judgment.`,
      );
    }
    } finally {
      mutationMonitor.close();
    }
  }

  private async ensureAgentDuelWorkspaceIntegrity(
    duel: DuelView,
    stage: string,
    mutationMonitor?: DuelWorkspaceMutationMonitor,
  ): Promise<boolean> {
    const expected = duel.initiation?.workspaceFingerprintSha256;
    if (!expected) {
      await this.cancelAgentDuelForIntegrity(duel, `No admission workspace fingerprint was available ${stage}.`);
      return false;
    }
    try {
      if (mutationMonitor) {
        await mutationMonitor.settle();
        if (mutationMonitor.changed) {
          const detail = mutationMonitor.error
            ?? `workspace activity was observed at ${mutationMonitor.changedPaths.join(", ") || "an unknown path"}`;
          await this.cancelAgentDuelForIntegrity(
            duel,
            `The shared workspace changed ${stage}; ${detail}. Hydra refused to compare different evidence.`,
          );
          return false;
        }
      }
      const current = await captureDuelWorkspaceFingerprint(this.workspaceRoot);
      if (current.sha256 === expected) return true;
      await this.cancelAgentDuelForIntegrity(
        duel,
        `The shared Git workspace changed ${stage}; Hydra refused to let the other head evaluate different evidence.`,
      );
    } catch (error) {
      await this.cancelAgentDuelForIntegrity(
        duel,
        `Hydra could not verify the shared Git workspace ${stage}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return false;
  }

  private async cancelAgentDuelForIntegrity(duel: DuelView, reason: string): Promise<void> {
    const safeReason = boundedRuntimeDuelReason(reason);
    const events = await loadDuelEvents(this.duelEventsUri.fsPath);
    const current = aggregateDuels(events).activeDuels.find((candidate) => candidate.duelId === duel.duelId);
    if (!current) return;
    const cancellation: DuelEvent = {
      type: "duelCancelled",
      eventId: `event-${crypto.randomUUID()}`,
      occurredAt: new Date().toISOString(),
      duelId: duel.duelId,
      cancelledBy: "hydra-runtime",
      reason: safeReason,
    };
    this.duels = await appendDuelEvents(this.duelEventsUri.fsPath, [cancellation]);
    this.duelError = undefined;
    const secretRefs = events.flatMap((event) =>
      event.type === "duelCommitmentSealed" && event.duelId === duel.duelId
        ? [{ participantId: event.participantId, commitmentId: event.commitmentId }]
        : []
    );
    if (secretRefs.length > 0) {
      await deleteDuelCommitmentSecrets(
        this.context.secrets,
        this.duelCommitmentIndexUri.fsPath,
        duel.duelId,
        secretRefs,
      ).catch(() => this.scheduleDuelCommitmentSecretSweep(Date.now() + 60_000));
    }
    await this.refreshDuelMirror();
    await this.appendSystemMessage(`Hydra cancelled ${duel.duelId} for duel-integrity protection: ${safeReason} Elo is unchanged.`);
    await this.recordEvent("diagnostic", "Hydra cancelled an agent-initiated duel for workspace-integrity protection.", {
      duelId: duel.duelId,
      reason: safeReason,
    });
    this.postState();
  }

  private startDuelLedgerWatcher(): void {
    try {
      const watcher = watchFileSystem(this.duelEventsUri.fsPath, { persistent: false }, () => {
        if (this.disposed) return;
        if (this.duelRefreshTimer) clearTimeout(this.duelRefreshTimer);
        this.duelRefreshTimer = setTimeout(() => {
          this.duelRefreshTimer = undefined;
          void this.refreshDuelsFromLedgerWatcher();
        }, 300);
      });
      // Watch failure must not crash the extension host. Normal panel actions
      // still refresh synchronously; only cross-window freshness is lost.
      watcher.on("error", () => watcher.close());
      this.disposables.push({ dispose: () => watcher.close() });
    } catch {
      // Some remote/custom filesystems cannot be watched. Duel commands remain
      // usable and every command still performs a full replay before acting.
    }
  }

  private async refreshDuelsFromLedgerWatcher(): Promise<void> {
    if (this.disposed) return;
    try {
      const events = await loadDuelEvents(this.duelEventsUri.fsPath);
      this.duels = aggregateDuels(events);
      this.duelError = undefined;
      await this.sweepDuelCommitmentSecretCleanup(events);
    } catch {
      // Fail closed instead of keeping a stale crown after another process
      // writes malformed or referentially invalid history.
      this.duels = initialEmptyDuelAggregate();
      this.duelError = "Private duel ledger failed validation; cross-window ratings were hidden.";
    }
    this.postState();
  }

  private async sweepDuelCommitmentSecretCleanup(events?: readonly DuelEvent[]): Promise<void> {
    if (this.disposed || !this.workspaceReady) return;
    if (this.duelSecretSweepTimer) {
      clearTimeout(this.duelSecretSweepTimer);
      this.duelSecretSweepTimer = undefined;
      this.duelSecretSweepAtMs = undefined;
    }
    try {
      const source = events ?? await loadDuelEvents(this.duelEventsUri.fsPath);
      const result = await sweepDuelCommitmentSecrets(
        this.context.secrets,
        this.duelCommitmentIndexUri.fsPath,
        source,
      );
      if (this.disposed) return;
      if (result.failed === 0) this.duelSecretCleanupWarningShown = false;
      if (result.failed > 0 && !this.duelSecretCleanupWarningShown) {
        this.duelSecretCleanupWarningShown = true;
        await vscode.window.showWarningMessage("Hydra could not remove every terminal sealed-answer copy. Cleanup is indexed and will retry automatically.");
      }
      const retryAt = result.failed > 0
        ? Date.now() + 60_000
        : result.nextSweepAt === undefined
          ? undefined
          : Date.parse(result.nextSweepAt);
      if (retryAt !== undefined && Number.isFinite(retryAt)) this.scheduleDuelCommitmentSecretSweep(retryAt);
    } catch {
      if (!this.duelSecretCleanupWarningShown) {
        this.duelSecretCleanupWarningShown = true;
        await vscode.window.showWarningMessage("Hydra could not reconcile the private sealed-answer index. No cleanup decision was made from partial state; Hydra will retry automatically.");
      }
      if (!this.disposed) this.scheduleDuelCommitmentSecretSweep(Date.now() + 60_000);
    }
  }

  private scheduleDuelCommitmentSecretSweep(atMs: number): void {
    if (this.disposed) return;
    if (this.duelSecretSweepTimer && this.duelSecretSweepAtMs !== undefined && this.duelSecretSweepAtMs <= atMs) return;
    if (this.duelSecretSweepTimer) clearTimeout(this.duelSecretSweepTimer);
    this.duelSecretSweepAtMs = atMs;
    const delayMs = Math.max(1_000, Math.min(2_147_000_000, atMs - Date.now()));
    this.duelSecretSweepTimer = setTimeout(() => {
      this.duelSecretSweepTimer = undefined;
      this.duelSecretSweepAtMs = undefined;
      void this.sweepDuelCommitmentSecretCleanup();
    }, delayMs);
    this.duelSecretSweepTimer.unref();
  }

  async advanceDuel(duelId = ""): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    let events: DuelEvent[];
    try {
      events = await loadDuelEvents(this.duelEventsUri.fsPath);
      this.duels = aggregateDuels(events);
      this.duelError = undefined;
    } catch {
      this.duels = initialEmptyDuelAggregate();
      this.duelError = "Private duel ledger failed validation; no duel can advance safely.";
      this.postState();
      await vscode.window.showErrorMessage(this.duelError);
      return;
    }
    if (this.duels.activeDuels.length === 0) {
      await vscode.window.showInformationMessage("Hydra has no active formal duel to advance.");
      return;
    }

    let duel = duelId ? this.duels.activeDuels.find((candidate) => candidate.duelId === duelId) : undefined;
    if (duelId && !duel) {
      await vscode.window.showWarningMessage("That duel is no longer active. Refresh the Formal Duels panel.");
      return;
    }
    if (!duel) {
      const selected = await vscode.window.showQuickPick(
        this.duels.activeDuels.map((candidate) => ({
          label: `${displayNameFor(candidate.challengerId)} vs ${displayNameFor(candidate.challengedId)}`,
          description: `${candidate.domain} - ${candidate.status.replace(/_/g, " ")}`,
          detail: candidate.proposition,
          duel: candidate,
        })),
        { title: "Hydra Duels: Advance", placeHolder: "Select an active formal duel", matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true },
      );
      if (!selected) return;
      duel = selected.duel;
    }

    switch (duel.status) {
      case "awaiting_acceptance": {
        const action = await vscode.window.showWarningMessage(
          "This legacy operator-created challenge cannot enter the ladder. Hydra now admits only challenges initiated by a head during discussion.",
          "Decline Legacy Challenge",
        );
        if (action !== "Decline Legacy Challenge") return;
        const reason = await vscode.window.showInputBox({
          title: "Hydra Duels: Close Legacy Challenge",
          prompt: "Record why this obsolete operator-created challenge is being closed. No Elo changes.",
          ignoreFocusOut: true,
          validateInput: (value) => value.trim().length === 0
            ? "A reason is required."
            : value.trim().length > 2_000
              ? "Keep the reason at 2,000 characters or fewer."
              : undefined,
        });
        if (reason === undefined) return;
        const declined: DuelEvent = {
          type: "duelDeclined",
          eventId: `event-${crypto.randomUUID()}`,
          occurredAt: new Date().toISOString(),
          duelId: duel.duelId,
          declinedBy: duel.challengedId,
          recordedBy: "local-user",
          reason: `Legacy operator-created challenge closed: ${reason.trim()}`,
        };
        await this.appendDuelEventFromUi(declined, "close the legacy formal duel");
        return;
      }
      case "awaiting_commitments": {
        if (
          duel.createdBy !== "hydra-runtime"
          || duel.ratingPolicy !== DUEL_AGENT_RATING_POLICY
          || !duel.rated
        ) {
          await vscode.window.showErrorMessage(
            "Hydra preserves this legacy duel for audit but will not advance a human-created or pre-v3 match. Cancel it and let the heads initiate any future rated challenge during discussion.",
          );
          return;
        }
        this.enqueueAgentDuelAutomation(duel.duelId);
        await vscode.window.showInformationMessage("Hydra queued the remaining agent-initiated duel commitments. No operator-authored answer will be accepted.");
        return;
      }
      case "awaiting_reveal":
        if (duel.createdBy !== "hydra-runtime" || duel.ratingPolicy !== DUEL_AGENT_RATING_POLICY) {
          await vscode.window.showErrorMessage("Hydra will not reveal or advance a human-created legacy duel. Cancel it; future rated challenges must originate from a head.");
          return;
        }
        await this.revealDuelCommitmentsIfReady(duel.duelId);
        return;
      case "awaiting_adjudication":
        if (duel.createdBy !== "hydra-runtime" || duel.ratingPolicy !== DUEL_AGENT_RATING_POLICY) {
          await vscode.window.showErrorMessage("Hydra preserves this human-created legacy result for audit but excludes it from the current agent-initiated ladder.");
          return;
        }
        await this.adjudicateDuel(duel);
        return;
      default:
        return;
    }
  }

  private async sealDuelCommitment(
    duel: DuelView,
    participant: AgentId,
    interactive: boolean,
    workspaceFingerprintSha256?: string,
    capabilityLockSha256?: string,
  ): Promise<boolean> {
    const reportError = async (message: string): Promise<void> => {
      if (interactive) await vscode.window.showErrorMessage(message);
      else await this.appendSystemMessage(message);
    };
    if (!duel.rated) {
      await reportError("Hydra refused to seal an unranked or exhibition commitment.");
      return false;
    }
    if (this.duelCommitmentAbort) {
      if (interactive) await vscode.window.showInformationMessage("Another head is already generating a sealed duel commitment.");
      return false;
    }

    const commitmentId = `commitment-${crypto.randomUUID()}`;
    const controller = new AbortController();
    this.duelCommitmentAbort = controller;
    this.postState();
    let captured: DuelHeadCommitmentCapture;
    try {
      if (interactive) {
        captured = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `${displayNameFor(participant)} is independently evaluating the rated full-access duel`,
            cancellable: true,
          },
          async (_progress, token) => {
            const cancellation = token.onCancellationRequested(() => controller.abort());
            try {
              return await this.runDuelCommitmentHead(
                duel,
                participant,
                commitmentId,
                controller.signal,
                true,
                workspaceFingerprintSha256,
                capabilityLockSha256,
              );
            } finally {
              cancellation.dispose();
            }
          },
        );
      } else {
        captured = await this.runDuelCommitmentHead(
          duel,
          participant,
          commitmentId,
          controller.signal,
          false,
          workspaceFingerprintSha256,
          capabilityLockSha256,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await reportError(
        `${displayNameFor(participant)} could not produce a Hydra-bound full-access commitment: ${detail} Hydra did not substitute a manual or unranked answer.`,
      );
      return false;
    } finally {
      if (this.duelCommitmentAbort === controller) this.duelCommitmentAbort = undefined;
      this.postState();
    }

    const captureRef = `agent-call:${captured.receipt.traceId}`;
    const created = createDuelCommitment({
      eventId: `event-${crypto.randomUUID()}`,
      occurredAt: new Date().toISOString(),
      duelId: duel.duelId,
      commitmentId,
      participantId: participant,
      captureType: "agent-call",
      captureRef,
      agentReceipt: captured.receipt,
      answer: captured.response.answer,
      confidence: captured.response.confidence,
    });
    try {
      await this.appendRequiredDuelReceipt({
        id: captured.receipt.traceId,
        event: "duelCommitmentBound",
        kind: "duelCommitment",
        sensitive: true,
        timestamp: new Date().toISOString(),
        agent: participant,
        agentKind: captured.receipt.agentKind,
        transport: captured.receipt.transport,
        duelId: duel.duelId,
        commitmentId,
        commitmentHash: created.event.commitmentHash,
        promptSha256: captured.receipt.promptSha256,
        sharedEvidenceSha256: captured.receipt.sharedEvidenceSha256,
        invocationSha256: captured.receipt.invocationSha256,
        workspaceFingerprintSha256: captured.receipt.workspaceFingerprintSha256,
        capabilityLockSha256: captured.receipt.capabilityLockSha256,
      });
    } catch {
      await reportError("Hydra could not durably bind the head execution receipt, so it refused to seal the rated answer.");
      return false;
    }

    try {
      // Store the preimage first. The public ledger receives only its hash;
      // no one-sided answer is ever written to the room or duel mirror.
      await storeDuelCommitmentSecret(
        this.context.secrets,
        this.duelCommitmentIndexUri.fsPath,
        duel.duelId,
        created.payload,
      );
      this.duels = await appendDuelEvents(this.duelEventsUri.fsPath, [created.event]);
    } catch (error) {
      let sealIsDurable = false;
      try {
        sealIsDurable = (await loadDuelEvents(this.duelEventsUri.fsPath)).some((event) => event.eventId === created.event.eventId);
      } catch {
        // Preserve the secret on an unreadable ledger: deleting it could make a
        // successfully appended seal permanently unrevealable.
        sealIsDurable = true;
      }
      if (!sealIsDurable) {
        await deleteDuelCommitmentSecrets(this.context.secrets, this.duelCommitmentIndexUri.fsPath, duel.duelId, [{
          participantId: participant,
          commitmentId: created.payload.commitmentId,
        }]).catch(() => this.scheduleDuelCommitmentSecretSweep(Date.now() + 60_000));
      }
      const detail = error instanceof Error ? error.message : String(error);
      await reportError(`Hydra could not seal the commitment: ${detail}`);
      return false;
    }
    this.duelError = undefined;
    await this.refreshDuelMirror();
    this.postState();
    return true;
  }

  async cancelDuel(duelId = ""): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    let events: DuelEvent[];
    try {
      events = await loadDuelEvents(this.duelEventsUri.fsPath);
      this.duels = aggregateDuels(events);
      this.duelError = undefined;
    } catch {
      this.duelError = "Private duel ledger failed validation; no duel can be cancelled safely.";
      this.postState();
      await vscode.window.showErrorMessage(this.duelError);
      return;
    }
    const cancellable = this.duels.activeDuels.filter((duel) => duel.status !== "awaiting_acceptance");
    let duel = duelId ? cancellable.find((candidate) => candidate.duelId === duelId) : undefined;
    if (duelId && !duel) {
      await vscode.window.showWarningMessage("That duel is no longer cancellable. Pending challenges should be declined instead.");
      return;
    }
    if (!duel) {
      if (cancellable.length === 0) {
        await vscode.window.showInformationMessage("Hydra has no accepted unresolved duel to cancel.");
        return;
      }
      const selected = await vscode.window.showQuickPick(
        cancellable.map((candidate) => ({
          label: `${displayNameFor(candidate.challengerId)} vs ${displayNameFor(candidate.challengedId)}`,
          description: `${candidate.domain} - ${candidate.status.replace(/_/g, " ")}`,
          detail: candidate.proposition,
          duel: candidate,
        })),
        { title: "Hydra Duels: Cancel", placeHolder: "Select an accepted unresolved duel", matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true },
      );
      if (!selected) return;
      duel = selected.duel;
    }
    const reason = await vscode.window.showInputBox({
      title: "Hydra Duels: Cancellation Reason",
      prompt: "Explain why this accepted duel cannot finish. Cancellation changes no Elo and remains auditable.",
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length === 0
        ? "A cancellation reason is required."
        : value.trim().length > 2_000
          ? "Keep the reason at 2,000 characters or fewer."
          : undefined,
    });
    if (reason === undefined) return;
    const cancelled: DuelEvent = {
      type: "duelCancelled",
      eventId: `event-${crypto.randomUUID()}`,
      occurredAt: new Date().toISOString(),
      duelId: duel.duelId,
      cancelledBy: "local-user",
      reason: reason.trim(),
    };
    if (!(await this.appendDuelEventFromUi(cancelled, "cancel the formal duel"))) return;

    let cleanupEvents = events;
    let cleanupWarning = false;
    try {
      // Reload after the terminal event becomes durable. Another window may have
      // sealed a commitment while the cancellation dialog was open; the append
      // lock orders that seal before this cancellation, so the authoritative
      // replay now contains every secret reference that must be removed.
      cleanupEvents = await loadDuelEvents(this.duelEventsUri.fsPath);
    } catch {
      cleanupWarning = true;
      this.scheduleDuelCommitmentSecretSweep(Date.now() + 60_000);
    }
    const secretRefs = cleanupEvents.flatMap((event) =>
      event.type === "duelCommitmentSealed" && event.duelId === duel!.duelId
        ? [{ participantId: event.participantId, commitmentId: event.commitmentId }]
        : []
    );
    try {
      await deleteDuelCommitmentSecrets(this.context.secrets, this.duelCommitmentIndexUri.fsPath, duel.duelId, secretRefs);
    } catch {
      cleanupWarning = true;
    }
    if (cleanupWarning) {
      await vscode.window.showWarningMessage("The duel was cancelled safely, but Hydra could not verify removal of every local sealed-answer copy.");
    }
    // A different VS Code window may still be finishing a commitment call
    // that began before cancellation. Reconcile once its hard timeout has
    // elapsed; if the record is still inside orphan grace, the sweep schedules
    // the exact follow-up itself.
    this.scheduleDuelCommitmentSecretSweep(Date.now() + DUEL_TERMINAL_LATE_SECRET_SWEEP_DELAY_MS);
    await vscode.window.showInformationMessage("Formal duel cancelled. No Elo changed.");
  }

  async correctDuelResult(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    let events: DuelEvent[];
    try {
      events = await loadDuelEvents(this.duelEventsUri.fsPath);
      this.duels = aggregateDuels(events);
      this.duelError = undefined;
    } catch {
      this.duelError = "Private duel ledger failed validation; no result can be corrected safely.";
      this.postState();
      await vscode.window.showErrorMessage(this.duelError);
      return;
    }
    const resolved = this.duels.recentDuels.filter((duel) => duel.status === "resolved" && duel.resolution);
    if (resolved.length === 0) {
      await vscode.window.showInformationMessage("Hydra has no active formal duel result to correct.");
      return;
    }
    const selected = await vscode.window.showQuickPick(
      resolved.map((duel) => ({
        label: `${displayNameFor(duel.challengerId)} vs ${displayNameFor(duel.challengedId)}`,
        description: `${duel.domain} - ${duel.resolution!.outcome}`,
        detail: duel.proposition,
        duel,
      })),
      { title: "Hydra Duels: Correct Result", placeHolder: "Select the ruling to reverse", matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true },
    );
    if (!selected) return;
    const reason = await vscode.window.showInputBox({
      title: "Hydra Duels: Correction Reason",
      prompt: "Explain why this ruling must stop affecting Elo. History remains append-only.",
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length === 0
        ? "A correction reason is required."
        : value.trim().length > 2_000
          ? "Keep the reason at 2,000 characters or fewer."
          : undefined,
    });
    if (reason === undefined) return;
    const reversal: DuelEvent = {
      type: "duelResolutionReversed",
      eventId: `event-${crypto.randomUUID()}`,
      occurredAt: new Date().toISOString(),
      duelId: selected.duel.duelId,
      targetResolutionId: selected.duel.resolution!.resolutionId,
      reversedBy: "local-user",
      reason: reason.trim(),
    };
    if (!(await this.appendDuelEventFromUi(reversal, "correct the duel result"))) return;
    const choice = await vscode.window.showInformationMessage(
      "Duel result reversed. Its Elo effect was removed by full replay.",
      "Record Replacement",
    );
    if (choice === "Record Replacement") await this.advanceDuel(selected.duel.duelId);
  }

  private async appendDuelEventFromUi(event: DuelEvent, operation: string): Promise<boolean> {
    try {
      this.duels = await appendDuelEvents(this.duelEventsUri.fsPath, [event]);
      this.duelError = undefined;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`Hydra could not ${operation}: ${detail}`);
      return false;
    }
    await this.refreshDuelMirror();
    this.postState();
    return true;
  }

  private async revealDuelCommitmentsIfReady(duelId: string, interactive = true): Promise<boolean> {
    const reportError = async (message: string): Promise<void> => {
      if (interactive) await vscode.window.showErrorMessage(message);
      else await this.appendSystemMessage(message);
    };
    let events: DuelEvent[];
    let duel: DuelView | undefined;
    try {
      events = await loadDuelEvents(this.duelEventsUri.fsPath);
      const aggregate = aggregateDuels(events);
      duel = aggregate.activeDuels.find((candidate) => candidate.duelId === duelId);
      this.duels = aggregate;
    } catch {
      this.duelError = "Private duel ledger failed validation; commitments cannot be revealed safely.";
      this.postState();
      await reportError(this.duelError);
      return false;
    }
    if (!duel || duel.status !== "awaiting_reveal") return false;

    const participantIds = [duel.challengerId, duel.challengedId] as const;
    const locatedSealRefs = participantIds.flatMap((participantId) => {
      const seal = events.find((event): event is Extract<DuelEvent, { type: "duelCommitmentSealed" }> =>
        event.type === "duelCommitmentSealed"
        && event.duelId === duelId
        && event.participantId === participantId
      );
      return seal ? [{ participantId, commitmentId: seal.commitmentId }] : [];
    });
    if (locatedSealRefs.length !== 2) {
      await reportError("Hydra refused the reveal because the validated duel is missing a durable participant seal.");
      return false;
    }
    const sealRefs = locatedSealRefs as [
      { participantId: string; commitmentId: string },
      { participantId: string; commitmentId: string },
    ];
    let payloads: [DuelRevealPayload, DuelRevealPayload];
    try {
      const challenger = await loadDuelCommitmentSecret(
        this.context.secrets,
        duelId,
        sealRefs[0].participantId,
        sealRefs[0].commitmentId,
      );
      const challenged = await loadDuelCommitmentSecret(
        this.context.secrets,
        duelId,
        sealRefs[1].participantId,
        sealRefs[1].commitmentId,
      );
      if (!challenger || !challenged) throw new Error("A sealed commitment preimage is unavailable.");
      payloads = [challenger, challenged];
    } catch {
      if (!interactive) {
        await reportError("Hydra cannot verify both sealed commitment preimages. The duel remains pending for recovery; Elo is unchanged.");
        return false;
      }
      const choice = await vscode.window.showWarningMessage(
        "Hydra cannot verify both sealed commitment preimages. Keep the duel pending for recovery, or cancel it without changing Elo.",
        { modal: true },
        "Keep Pending",
        "Cancel Duel",
      );
      if (choice === "Cancel Duel") {
        const reason = await vscode.window.showInputBox({
          title: "Hydra Duels: Cancellation Reason",
          value: "A sealed commitment could not be recovered or verified.",
          ignoreFocusOut: true,
          validateInput: (value) => value.trim().length === 0
            ? "A cancellation reason is required."
            : value.trim().length > 2_000
              ? "Keep the reason at 2,000 characters or fewer."
              : undefined,
        });
        if (reason !== undefined) {
          const cancelled: DuelEvent = {
            type: "duelCancelled",
            eventId: `event-${crypto.randomUUID()}`,
            occurredAt: new Date().toISOString(),
            duelId,
            cancelledBy: "local-user",
            reason: reason.trim(),
          };
          if (await this.appendDuelEventFromUi(cancelled, "cancel the unrecoverable duel")) {
            await deleteDuelCommitmentSecrets(
              this.context.secrets,
              this.duelCommitmentIndexUri.fsPath,
              duelId,
              sealRefs,
            ).catch(() => this.scheduleDuelCommitmentSecretSweep(Date.now() + 60_000));
            this.scheduleDuelCommitmentSecretSweep(Date.now() + DUEL_TERMINAL_LATE_SECRET_SWEEP_DELAY_MS);
          }
        }
      }
      return false;
    }

    let reveal;
    try {
      reveal = createDuelReveal(events, {
        eventId: `event-${crypto.randomUUID()}`,
        occurredAt: new Date().toISOString(),
        duelId,
        payloads,
        recordedBy: duel.createdBy === "hydra-runtime" ? "hydra-runtime" : "local-user",
      });
      this.duels = await appendDuelEvents(this.duelEventsUri.fsPath, [reveal]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await reportError(`Hydra could not verify and reveal the paired commitments: ${detail}`);
      return false;
    }
    // Delete only after the single paired reveal is durably appended.
    await deleteDuelCommitmentSecrets(
      this.context.secrets,
      this.duelCommitmentIndexUri.fsPath,
      duelId,
      sealRefs,
    ).catch(async () => {
      this.scheduleDuelCommitmentSecretSweep(Date.now() + 60_000);
      if (interactive) await vscode.window.showWarningMessage("Both commitments were revealed safely, but Hydra could not remove their local secret copies.");
      else await this.appendSystemMessage("Both commitments were revealed safely, but Hydra could not remove their local secret copies; cleanup will retry.");
    });
    this.scheduleDuelCommitmentSecretSweep(Date.now() + DUEL_TERMINAL_LATE_SECRET_SWEEP_DELAY_MS);
    this.duelError = undefined;
    await this.refreshDuelMirror();
    this.postState();
    if (interactive) await vscode.window.showInformationMessage("Both commitments verified and revealed together. The locked evidence contract can now be adjudicated.");
    return true;
  }

  private async adjudicateDuel(duel: DuelView): Promise<void> {
    if (!duel.commitments || duel.commitments.length !== 2) {
      await vscode.window.showErrorMessage("Hydra refused adjudication because both commitments are not publicly revealed together.");
      return;
    }
    if (duel.adjudicatorType !== "human") {
      await vscode.window.showWarningMessage(
        "This legacy duel requests an automated deterministic adjudicator, but v1 has no machine-readable outcome mapping. Hydra will not let a human-selected winner borrow an unrelated verification receipt; cancel it and let the heads initiate any future human-adjudicated challenge during discussion.",
      );
      return;
    }
    const [challenger, challenged] = duel.commitments;
    const outcome = await vscode.window.showQuickPick(
      [
        { label: `${displayNameFor(duel.challengerId)} wins`, value: "challengerWin" as DuelOutcome, description: challenger.answer },
        { label: `${displayNameFor(duel.challengedId)} wins`, value: "challengedWin" as DuelOutcome, description: challenged.answer },
        { label: "Tie", value: "tie" as DuelOutcome, description: "Rated draw with exactly zero Elo delta" },
        { label: "Unresolved", value: "unresolved" as DuelOutcome, description: "Evidence cannot settle the proposition; no Elo change" },
        { label: "Void", value: "void" as DuelOutcome, description: "Invalid or unfalsifiable comparison; no Elo change" },
      ],
      {
        title: "Hydra Duels: Apply Locked Evidence Contract",
        placeHolder: duel.evidenceContract,
        matchOnDescription: true,
        ignoreFocusOut: true,
      },
    );
    if (!outcome) return;

    const evidenceRef = await vscode.window.showInputBox({
      title: "Hydra Duels: Durable Ruling Evidence",
      prompt: "Cite the evidence that satisfies the locked contract: a workspace-relative artifact, HTTPS URL, command/receipt ID, or other durable reference.",
      placeHolder: ".hydra/verification.jsonl#receipt-id or https://…",
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length === 0
        ? "A durable evidence reference is required."
        : value.trim().length > 512
          ? "Keep the evidence reference at 512 characters or fewer."
          : /^human:local-user:\d{4}-\d{2}-\d{2}t/i.test(value.trim())
            ? "A timestamp alone is not evidence; cite the artifact, URL, command, or receipt that settles the contract."
            : undefined,
    });
    if (evidenceRef === undefined) return;
    const rationale = await vscode.window.showInputBox({
      title: "Hydra Duels: Ruling Rationale",
      prompt: `Explain how the locked contract supports ${outcome.label}.`,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length === 0
        ? "A rationale is required."
        : value.trim().length > 2_000
          ? "Keep the rationale at 2,000 characters or fewer."
          : undefined,
    });
    if (rationale === undefined) return;
    const resolved: DuelEvent = {
      type: "duelResolved",
      eventId: `event-${crypto.randomUUID()}`,
      occurredAt: new Date().toISOString(),
      duelId: duel.duelId,
      resolutionId: `resolution-${crypto.randomUUID()}`,
      outcome: outcome.value,
      adjudicatorType: duel.adjudicatorType,
      adjudicatorId: duel.adjudicatorId,
      evidenceRef: evidenceRef.trim(),
      rationale: rationale.trim(),
      recordedBy: "local-user",
    };
    if (!(await this.appendDuelEventFromUi(resolved, "record the duel result"))) return;
    const refreshed = this.duels.recentDuels.find((candidate) => candidate.duelId === duel.duelId);
    const deltas = Object.entries(refreshed?.resolution?.ratingDeltas ?? {});
    const ratingNote = !duel.rated || deltas.length === 0
      ? " No Elo changed."
      : ` ${deltas.map(([agentId, delta]) => `${displayNameFor(agentId)} ${delta >= 0 ? "+" : ""}${delta} Elo`).join(", ")}.`;
    await vscode.window.showInformationMessage(`Formal duel resolved: ${outcome.label}.${ratingNote}`);
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
    if (this.unconfirmedNativeTermination) {
      this.appendSystemMessageToUi(this.unconfirmedTerminationMessage());
      this.postState();
      return;
    }
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
        // Why: probeArgs is keyed by the now-widened AgentId; the loop above only
        // ever iterates the two built-in ids, so this fallback is unreachable.
        for (const probe of probeArgs[agent] ?? []) {
          const started = Date.now();
          const spawn = await this.buildNativeCommandSpawn(agent, probe.args);
          const result = await runAgent(spawn, "", 30000, () => {}, ctrl.signal);
          if (this.latchUnconfirmedNativeTermination(result, `${agent} capability probe`, agent)) {
            await this.appendSystemMessage(this.unconfirmedTerminationMessage());
            return;
          }
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
    if (this.unconfirmedNativeTermination) {
      this.appendSystemMessageToUi(this.unconfirmedTerminationMessage());
      this.postState();
      return;
    }
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
    if (vscode.workspace.isTrusted !== true) {
      await this.appendSystemMessage("Claude Worker Fanout stays off until this workspace is trusted.");
      this.postState();
      return;
    }
    const next = !manyHeadsMode();
    await vscode.workspace
      .getConfiguration("hydraRoom")
      .update("manyHeadsMode", next, vscode.ConfigurationTarget.Global);
    await this.appendSystemMessage(
      next
        ? `Claude Worker Fanout enabled for this workspace. Parallel discussion will launch ${manyHeadsClaudeWorkerCount()} local subscription-backed Claude workers; they are not independent Hydra head identities.`
        : "Claude Worker Fanout disabled for this workspace."
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
        detail: `${value} local subscription-backed Claude worker${value === 1 ? "" : "s"} in parallel discussion`,
        value,
      };
    });
    const pick = await vscode.window.showQuickPick(choices, {
      title: "Claude Worker Fanout",
      placeHolder: "Choose local Claude worker fanout (1-8)",
      ignoreFocusOut: true,
    });
    if (!pick) return;
    await vscode.workspace
      .getConfiguration("hydraRoom")
      .update("manyHeadsClaudeWorkerCount", pick.value, vscode.ConfigurationTarget.Global);
    await this.appendSystemMessage(`Claude Worker Fanout count set to ${pick.value}.`);
    this.postState();
  }

  async runManyHeadsSmokeTest(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    if (vscode.workspace.isTrusted !== true) {
      await this.appendSystemMessage("Claude Worker Fanout smoke test requires a trusted workspace.");
      this.postState();
      return;
    }
    if (isInFlight(this.state) || this.terminalPokeInFlight || this.verificationRunning || this.autopilotRunning) {
      await this.appendSystemMessage("Claude Worker Fanout smoke test skipped because Hydra is already running work.");
      this.postState();
      return;
    }
    if (!isSendable(this.state)) {
      await this.appendSystemMessage(`Claude Worker Fanout smoke test skipped because the room is not in a sendable state: ${this.state.name}.`);
      this.postState();
      return;
    }

    const prompt = [
      "Codex and Claude, run a Hydra Claude Worker Fanout smoke test.",
      "Do not edit files or run long commands.",
      "Codex: inspect only the Claude worker fanout live-channel pointers in your prompt and reply with SMOKE_CODEX_OK plus any live-channel evidence you can see.",
      "Claude workers: each of you should use one Task/subagent call if available with the instruction `Return SMOKE_TASK_OK only.` Then reply with SMOKE_CLAUDE_OK.",
      "Keep all replies under 8 lines and include no Decision Packet.",
    ].join(" ");
    const previousManyHeadsOverride = this.manyHeadsModeOverride;
    const previousAutoAdvanceOverride = this.autoAdvanceActionableDefaultsOverride;
    const previousTransport = this.transportMode();
    const expectedClaudeWorkers = manyHeadsClaudeWorkerCount();
    const startedAt = new Date().toISOString();
    const messageStartIndex = this.messages.length;
    let turnError: string | undefined;

    await this.appendSystemMessage(
      `Hydra Claude Worker Fanout smoke test started with ${expectedClaudeWorkers} Claude worker(s); report will be written to \`.hydra/many-heads-smoke.jsonl\`.`
    );
    await this.recordEvent("commandInvoked", "Hydra Claude Worker Fanout smoke test started.", {
      expectedClaudeWorkers,
      previousTransport,
    });

    try {
      if (previousTransport !== "oneShot") {
        this.transport = "oneShot";
        this.terminalBridge?.dispose();
        this.terminalBridge = undefined;
        await this.appendSystemMessage("Claude Worker Fanout smoke test switched this room to safe one-shot transport; worker fanout does not run through terminal bridge.");
      }
      this.manyHeadsModeOverride = true;
      this.autoAdvanceActionableDefaultsOverride = false;
      this.postState();
      await this.sendUserMessage(prompt, "codex");
    } catch (err) {
      turnError = err instanceof Error ? err.message : String(err);
      await this.appendSystemMessage(`Claude Worker Fanout smoke test turn failed before report collection: ${turnError}`);
    } finally {
      this.manyHeadsModeOverride = previousManyHeadsOverride;
      this.autoAdvanceActionableDefaultsOverride = previousAutoAdvanceOverride;
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
    await this.recordEvent(report.passed ? "commandInvoked" : "error", `Hydra Claude Worker Fanout smoke test ${report.passed ? "passed" : "failed"}.`, {
      expectedClaudeWorkers,
      claudeStarts: report.observed.claudeStarts,
      liveFiles: report.observed.liveFiles,
      forwardedTaskEvents: report.observed.forwardedTaskEvents,
      guardBlocks: report.observed.guardBlocks,
      passed: report.passed,
    });
    if (report.passed) {
      vscode.window.showInformationMessage("Hydra Claude Worker Fanout smoke test passed.");
    } else {
      vscode.window.showWarningMessage("Hydra Claude Worker Fanout smoke test failed. See .hydra/many-heads-smoke.jsonl.");
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
      onUnconfirmedTermination: () => {
        this.latchUnconfirmedNativeTermination(
          { terminationFailed: true },
          "Codex model discovery",
          "codex"
        );
      },
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
    const browserStatus = HydraRoomPanel.browserBroker?.status();
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
      isWorkspaceTrusted: vscode.workspace.isTrusted === true,
      canStop: isInFlight(this.state) || this.terminalPokeInFlight || this.verificationRunning || this.autopilotRunning,
      canAcceptDefault: this.workspaceReady && !isInFlight(this.state) && !this.terminalPokeInFlight && this.currentDecisionAction().kind !== "none",
      autoAdvanceActionableDefaults: this.effectiveAutoAdvanceActionableDefaults(),
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
      browserControlAvailable: browserStatus?.agentControlAvailable ?? false,
      browserControlEnabled: browserStatus?.enabled ?? false,
      manyHeadsMode: this.effectiveManyHeadsMode(),
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
      case "openBrowser":
        await this.openBrowser();
        return;
      case "toggleBrowserControl":
        await this.toggleBrowserControl();
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

  async openBrowser(): Promise<void> {
    if (!HydraRoomPanel.browserBroker) {
      await vscode.window.showWarningMessage("Hydra browser integration is unavailable in this extension host.");
      return;
    }
    await HydraRoomPanel.browserBroker.openBrowser();
  }

  async toggleBrowserControl(): Promise<void> {
    if (!HydraRoomPanel.browserBroker) {
      await vscode.window.showWarningMessage("Hydra browser integration is unavailable in this extension host.");
      return;
    }
    await HydraRoomPanel.browserBroker.toggleAgentControl();
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
        const remainingTotalBytes = Math.max(0, maxTotalBytes - pendingTotalBytes);
        const attachment = await prepareRoomAttachment({
          id: `${turnId}-${added.length}`,
          sourcePath: uri.fsPath,
          sourceLabel: this.attachmentSourceLabel(uri),
          attachmentDir,
          relativeAttachmentDir: relativeDir,
          previewMaxChars: attachmentPreviewMaxChars(),
          // Enforce both limits from the same verified source handle used for
          // the copy. A path-based pre-stat can become stale before copy.
          maxBytes: Math.min(maxFileBytes, remainingTotalBytes),
        });
        added.push(attachment);
        pendingTotalBytes += attachment.sizeBytes;
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
    if (this.unconfirmedNativeTermination) {
      this.appendSystemMessageToUi(this.unconfirmedTerminationMessage());
      this.postState();
      return;
    }
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
    if (!this.isActiveAgent(agent)) {
      await this.appendSystemMessage(`Native command unavailable: ${displayNameFor(agent)} is not currently seated in this room.`);
      this.postState();
      return;
    }
    if (this.unconfirmedNativeTermination) {
      this.appendSystemMessageToUi(this.unconfirmedTerminationMessage());
      this.postState();
      return;
    }
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
      await this.appendUserMessage(`[Native ${displayNameFor(agent)} command]\n\n${commandLine}`);
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
    if (!this.isActiveAgent(agent)) {
      await this.appendSystemMessage(`Raw terminal send unavailable: ${displayNameFor(agent)} is not currently seated in this room.`);
      this.postState();
      return;
    }
    if (this.unconfirmedNativeTermination) {
      this.appendSystemMessageToUi(this.unconfirmedTerminationMessage());
      this.postState();
      return;
    }
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
      await this.appendUserMessage(`[Raw ${displayNameFor(agent)} terminal line]\n\n${trimmed}`);
      await this.terminalBridge.sendRawLine(agent, trimmed);
      await this.appendSystemMessage(`Sent raw line to ${displayNameFor(agent)} terminal. Continue interaction in the visible terminal if the CLI is interactive.`);
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
    if (this.unconfirmedNativeTermination) {
      this.appendSystemMessageToUi(this.unconfirmedTerminationMessage());
      this.postState();
      return;
    }
    if (isInFlight(this.state) || this.terminalPokeInFlight) return;
    const targetAgents = uniqueAgents(agents).filter((agent) => this.isActiveAgent(agent));
    if (targetAgents.length === 0) return;
    // Reserve before diff/editor preflight, both of which can await. Otherwise
    // two rapid pokes can pass the guard and dispatch overlapping terminal work.
    this.terminalPokeInFlight = true;
    this.postState();
    let ctrl: AbortController | undefined;
    try {
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
      ctrl = new AbortController();
      this.currentAbort = ctrl;
      try {
      // Why: targetAgents is non-empty here — pokeNativeTerminals returns early
      // above when uniqueAgents() yields length 0, so [0] is always defined.
      const firstAgent = targetAgents[0]!;
      const targetLabel = targetAgents.length === 2
        ? "Codex and Claude terminals"
        : `${displayNameFor(firstAgent)} terminal`;
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
        if (pending) pending.activity = `${displayNameFor(agent)} native terminal poke running...`;
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
        if (this.currentAbort === ctrl) this.currentAbort = undefined;
      }
    } finally {
      this.terminalPokeInFlight = false;
      if (ctrl && this.currentAbort === ctrl) this.currentAbort = undefined;
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
          ? `Native args/subcommand to run after ${displayNameFor(firstAgent)}'s configured executable. Example: doctor or mcp list.`
          : pick.actionKind === "rawLine"
          ? `Raw PowerShell line to send to the visible ${displayNameFor(firstAgent)} terminal. Use this for interactive native CLI flows.`
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
    if (this.unconfirmedNativeTermination) {
      this.appendSystemMessageToUi(this.unconfirmedTerminationMessage());
      this.postState();
      return;
    }
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
    if (this.unconfirmedNativeTermination) {
      this.appendSystemMessageToUi(this.unconfirmedTerminationMessage());
      this.postState();
      return;
    }
    if (!this.terminalBridge) {
      await this.appendSystemMessage(TERMINAL_BRIDGE_NOT_READY);
      this.transport = "oneShot";
      this.postState();
      return;
    }
    await this.terminalBridge.openAll();
    const result = await this.terminalBridge.selfTest(terminalBridgeTimeoutMs());
    this.latchUnconfirmedNativeTermination(result, "terminal bridge self-test", "codex");
    if (!result.ok) this.transport = "oneShot";
    await this.appendSystemMessage(
      [
        result.message,
        `Log: [private extension storage]/${path.basename(result.logPath)}`,
        `Reply: [private extension storage]/${path.basename(result.replyPath)}`,
        `Checks: logBomFree=${result.checks.logBomFree}, replyStartsWithJsonObject=${result.checks.replyStartsWithJsonObject}, outputNotDuplicated=${result.checks.outputNotDuplicated}, replyParsed=${result.checks.replyParsed}`,
        result.ok
          ? "Future agent calls will be injected into visible native terminals; replies stay in VS Code's private extension storage."
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
    if (this.terminalBridgeDispatchInFlight > 0) {
      await this.appendSystemMessage("Safe one-shot switching is paused until the active terminal-bridge call finishes or is stopped.");
      this.postState();
      return;
    }
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
      openLabel: `Use as ${displayNameFor(agent)} CLI`,
      title: `Select ${displayNameFor(agent)} CLI executable or wrapper`,
    });
    const file = picked?.[0]?.fsPath;
    if (!file) return;
    await vscode.workspace
      .getConfiguration("hydraRoom")
      .update(`${agent}Command`, file, vscode.ConfigurationTarget.Global);
    await this.appendSystemMessage(
      `${displayNameFor(agent)} CLI path saved to User settings: ${file}\nHydra Autopilot is rechecking the room.`
    );
    await this.runAutopilotStart();
  }

  async resetStuckTurn(): Promise<void> {
    await this.ready();
    if (!this.workspaceReady) return;
    this.currentAbort?.abort();
    this.wikiMaintenanceAbort?.abort();
    this.duelCommitmentAbort?.abort();
    let changed = false;
    for (const message of this.messages) {
      if (!message.pending) continue;
      changed = true;
      message.pending = false;
      message.cancelled = true;
      message.activity = undefined;
      if (message.text.length > 0 && !message.text.endsWith("\n")) message.text += "\n";
      message.text += "[cancelled by Hydra reset]";
      await this.persistTranscriptMessage({
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
    for (const agent of this.roster()) this.setAgentStatus(agent, "idle", "Idle");
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
      if (this.agentDuelAdmissionQueue.length > 0) {
        queueMicrotask(() => void this.drainAgentDuelAdmissions());
      }
      if (this.agentDuelAutomationQueue.length > 0) {
        queueMicrotask(() => void this.drainAgentDuelAutomation());
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
      const reactor = pickReviewers(opener, this.roster())[0] ?? opener;
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

      const openerMessageId = openerId;
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
      this.bindPendingAgentDuelContext(
        reactorId,
        opener,
        openerMessageId,
        reactorEnvelope.duelProtocolExpected,
      );
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
      this.bindPendingAgentDuelContext(
        closerId,
        reactor,
        reactorMessageId,
        closerEnvelope.duelProtocolExpected,
      );
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
        roster: this.roster(),
        manyHeads: this.effectiveManyHeadsMode(),
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
          otherAgent: pickReviewers(agent, this.roster())[0] ?? agent,
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
      const scoreContext: SerialBuildScoreContext | undefined =
        autoScorePassingBuilds() && autoVerifyAfterBuild()
          ? await this.captureSerialBuildScoreContext(builder)
          : undefined;
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
      const otherAgent = pickReviewers(builder, this.roster())[0] ?? builder;
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
        await this.afterSuccessfulBuild(scoreContext
          ? {
              ...scoreContext,
              postFingerprintSha256: await this.captureScorableWorkspaceFingerprint("after build"),
            }
          : undefined);
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
          otherAgent: pickReviewers(agent, this.roster())[0] ?? agent,
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

  private async afterSuccessfulBuild(scoreContext?: SerialBuildScoreContext): Promise<void> {
    if (!autoVerifyAfterBuild()) return;
    const preVerificationControlSha256 = scoreContext?.verificationScoringPlan?.eligible
      ? await this.captureCurrentVerificationControlSha256("before verification")
      : undefined;
    const result = await this.runVerificationInternal("afterBuild", scoreContext?.verificationResolution);
    if (result && verificationPassed(result) && autoScorePassingBuilds() && scoreContext) {
      await this.recordAutomaticVerifiedBuildScore(result, {
        ...scoreContext,
        preVerificationControlSha256,
      });
    }
    if (
      verificationPassed(result) &&
      autoRequestReviewAfterPassingVerification() &&
      (this.state.name === "BuildDone" || this.state.name === "ParallelBuildDone")
    ) {
      await this.appendSystemMessage("Hydra auto-review started because verification passed after build.");
      await this.requestReview();
    }
  }

  private async captureSerialBuildScoreContext(builder: AgentId): Promise<SerialBuildScoreContext> {
    const preBuildResolution = await resolveVerificationCommand({
      configured: vscode.workspace.getConfiguration("hydraRoom").get<string>("verifyCommand", ""),
      isWorkspaceTrusted: vscode.workspace.isTrusted,
      workspaceRoot: this.workspaceRoot,
    });
    const verificationScoringPlan = preBuildResolution.kind === "explicit" || preBuildResolution.kind === "inferred"
      ? await createVerificationScoringPlan(this.workspaceRoot, preBuildResolution)
      : undefined;
    const verificationResolution = preBuildResolution.kind === "explicit" || preBuildResolution.kind === "inferred"
      ? {
          ...preBuildResolution,
          // Eligible plans execute the exact pre-dispatch absolute command
          // whose digest enters the score evidence. Ineligible commands remain
          // ordinary latched verification but can never create score events.
          command: verificationScoringPlan?.eligible
            ? verificationScoringPlan.command
            : preBuildResolution.command,
        }
      : undefined;
    return {
      builder,
      verificationResolution,
      verificationScoringPlan,
      beforeFingerprintSha256: await this.captureScorableWorkspaceFingerprint("before build"),
    };
  }

  private async captureCurrentVerificationControlSha256(stage: string): Promise<string | undefined> {
    try {
      return (await captureVerificationControlFingerprint(this.workspaceRoot)).sha256;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.recordEvent("diagnostic", `Hydra skipped the ${stage} verifier-control fingerprint: ${detail}`, {
        stage,
      });
      return undefined;
    }
  }

  private async captureScorableWorkspaceFingerprint(stage: string): Promise<string | undefined> {
    if (!this.gitAvailable) return undefined;
    try {
      return (await captureDuelWorkspaceFingerprint(this.workspaceRoot, {
        // Verification routinely writes ignored build output. Passive scoring
        // binds source/index/untracked content without treating those artifacts
        // as a builder change or a post-verification mismatch.
        includeWorkspaceMetadata: false,
        hashOnlyChangedTrackedFiles: true,
      })).sha256;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.recordEvent("diagnostic", `Hydra skipped the ${stage} scoreboard fingerprint: ${detail}`, {
        stage,
      });
      return undefined;
    }
  }

  private async recordAutomaticVerifiedBuildScore(
    verification: VerificationResult,
    context: SerialBuildScoreContext,
  ): Promise<void> {
    const plan = context.verificationScoringPlan;
    if (!plan) {
      await this.appendSystemMessage("Hydra did not score this passing build because no verification command was available before builder dispatch.");
      return;
    }
    if (!plan.eligible || !plan.controlSha256) {
      await this.appendSystemMessage(
        `Hydra did not score this passing build because its bounded conventional verifier-control plan could not be captured before builder dispatch${plan.ineligibleReason ? `: ${plan.ineligibleReason}` : "."}`,
      );
      return;
    }
    if (context.preVerificationControlSha256 !== plan.controlSha256) {
      await this.appendSystemMessage("Hydra did not score this passing build because the builder changed, or Hydra could not re-confirm, the pre-dispatch verification controls.");
      return;
    }
    if (!context.beforeFingerprintSha256 || !context.postFingerprintSha256) {
      await this.appendSystemMessage("Hydra did not score this passing build because a stable Git-visible workspace fingerprint was unavailable.");
      return;
    }
    if (context.beforeFingerprintSha256 === context.postFingerprintSha256) {
      await this.appendSystemMessage("Hydra did not score this passing build because the serial builder made no Git-visible workspace change.");
      return;
    }
    const verifiedFingerprintSha256 = await this.captureScorableWorkspaceFingerprint("after verification");
    if (!verifiedFingerprintSha256 || verifiedFingerprintSha256 !== context.postFingerprintSha256) {
      await this.appendSystemMessage("Hydra did not score this passing build because verification changed, or could not re-confirm, the Git-visible post-build state.");
      return;
    }
    const postVerificationControlSha256 = await this.captureCurrentVerificationControlSha256("after verification");
    if (postVerificationControlSha256 !== plan.controlSha256) {
      await this.appendSystemMessage("Hydra did not score this passing build because verification changed, or could not re-confirm, the pre-dispatch verification controls.");
      return;
    }

    const events = scoreboardEventsForVerifiedBuild({
      agentId: context.builder,
      verification,
      postBuild: {
        fingerprintSha256: context.postFingerprintSha256,
        didChange: true,
      },
      verifier: {
        resolutionKind: plan.resolutionKind,
        planSha256: plan.planSha256,
        controlSha256: plan.controlSha256,
        controlsUnchanged: true,
      },
    });
    if (events.length === 0) return;
    const validScoreboardBeforeAppend = this.scoreboard;
    const scoreboardErrorBeforeAppend = this.scoreboardError;
    try {
      this.scoreboard = await appendScoreboardEventsIfAbsent(this.scoreEventsUri.fsPath, events);
      this.scoreboardError = undefined;
      await this.refreshScoreboardMirror();
      await this.appendSystemMessage(
        `Hydra confirmed deterministic passive-score evidence for ${displayNameFor(context.builder)}: the changed serial build passed \`${verification.command}\`.`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // An append can fail for transient I/O or lock reasons while the replay
      // already shown in this window remains valid. Preserve that known-good
      // state; a watcher/next command will replay the authoritative ledger.
      this.scoreboard = validScoreboardBeforeAppend;
      this.scoreboardError = scoreboardErrorBeforeAppend;
      await this.appendSystemMessage(
        `Hydra could not record automatic passive-score evidence; current valid standings were preserved: ${detail}`,
      );
    }
    this.postState();
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
        await this.appendSystemMessage(`Hydra wiki wrapup started with ${displayNameFor(agent)}.`);
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
    spawn = {
      ...spawn,
      command: await resolveAgentCommand(agent, spawn.command, effectiveSpawnEnvironment(spawn)),
    };
    const consent = await this.ensureFullNativeConsent(agent, phase, spawn.args);
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

  private async runDuelCommitmentHead(
    duel: DuelView,
    participantId: AgentId,
    commitmentId: string,
    signal: AbortSignal,
    allowConsentPrompt = true,
    workspaceFingerprintSha256?: string,
    capabilityLockSha256?: string,
  ): Promise<DuelHeadCommitmentCapture> {
    if (this.unconfirmedNativeTermination) {
      throw new Error(this.unconfirmedTerminationMessage());
    }
    if (this.sessionCostCapExceeded()) {
      throw new Error("The session cost cap has been reached; Hydra will not spend another head call on this duel.");
    }
    const definition = getAgentDefinition(participantId);
    if (!definition) throw new Error(`Head "${participantId}" is not registered.`);
    if (duel.ratingPolicy === DUEL_AGENT_RATING_POLICY && !workspaceFingerprintSha256) {
      throw new Error("Agent-initiated commitments require the workspace fingerprint locked at admission.");
    }
    if (duel.ratingPolicy === DUEL_AGENT_RATING_POLICY && !capabilityLockSha256) {
      throw new Error("Agent-initiated commitments require the participant capability lock captured at admission.");
    }

    const phase: Phase = "review";
    const sharedEvidencePacket = duel.sharedEvidencePacket;
    if (!sharedEvidencePacket) {
      throw new Error("Legacy packetless duels cannot run under the rated full-access protocol.");
    }
    const prompt = buildDuelCommitmentPrompt({
      duelId: duel.duelId,
      commitmentId,
      participantId,
      participantName: displayNameFor(participantId),
      domain: duel.domain,
      proposition: duel.proposition,
      evidenceContract: duel.evidenceContract,
      sharedEvidencePacket,
      rankingMotivation: renderDuelMotivationContext(participantId, this.duels.ratings, displayNameFor),
    });
    const traceId = `${makeTraceId(participantId, phase)}-duel-commitment`;
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const promptSha256 = sha256(prompt);
    const invocation = this.buildDuelCommitmentInvocation(participantId, prompt);
      let invocationSha256 = duelInvocationSha256(invocation);
      if (!allowConsentPrompt && !this.context.workspaceState.get<boolean>(fullNativeConsentKey(participantId), false)) {
        throw new Error("Persistent full-native consent is required before Hydra can run an autonomous duel commitment.");
      }
      const consent = allowConsentPrompt
        ? await this.ensureFullNativeConsent(
            participantId,
            phase,
            invocation.transport === "spawn" ? invocation.args : [],
          )
        : { allowed: true };
      if (!consent.allowed) throw new Error(consent.message ?? "Native head execution was not approved.");

      let releaseClaudeCreditReservation: (() => void) | undefined;
      if (definition.kind === "claude") {
        releaseClaudeCreditReservation = this.reserveClaudeCreditEstimate(claudeAgentEstimatedRunCostUsd());
        let guard: ClaudeAutomationGuardResult | undefined;
        try {
          guard = await this.evaluateClaudeCreditGuard(signal, false);
        } catch (error) {
          releaseClaudeCreditReservation();
          releaseClaudeCreditReservation = undefined;
          throw error;
        }
        if (guard?.decision === "block") {
          releaseClaudeCreditReservation();
          releaseClaudeCreditReservation = undefined;
          throw new Error(`Hydra blocked the Claude duel call to protect the Agent SDK credit pool: ${guard.reason}`);
        }
        if (guard?.decision === "warn" && !this.claudeCreditWarned) {
          this.claudeCreditWarned = true;
          await this.appendSystemMessage(`Hydra Claude automation credit warning: ${guard.reason}`);
        }
      }

      let result: RunResult;
      let transport: "oneShot" | "http";
      try {
        if (invocation.transport === "http") {
          transport = "http";
          result = await this.runHeadlessDuelHttpAgent(
            participantId,
            phase,
            invocation,
            prompt,
            DUEL_COMMITMENT_HEAD_TIMEOUT_MS,
            signal,
            traceId,
            startedAtMs,
          );
        } else {
          transport = "oneShot";
          let spawn = this.applyConfiguredSpawnEnvironment(participantId, {
            command: invocation.command,
            args: invocation.args,
            cwd: this.workspaceRoot,
            stdin: invocation.stdin ?? "",
          });
          spawn = {
            ...spawn,
            command: await resolveAgentCommand(participantId, spawn.command, effectiveSpawnEnvironment(spawn)),
          };
          const actualCapabilityLock = this.capabilityLockForSpawn(participantId, spawn);
          if (capabilityLockSha256 && actualCapabilityLock.profileSha256 !== capabilityLockSha256) {
            throw new Error("The participant's effective native command, model, arguments, working directory, or environment changed after duel admission.");
          }
          const prepared = await this.prepareOneShotRequestFiles(participantId, phase, spawn, prompt);
          // Fingerprint the command Hydra will actually execute, after structured
          // output flags and private request-file expansions have been applied.
          invocationSha256 = duelInvocationSha256({
            transport: "spawn",
            command: prepared.spawn.command,
            args: prepared.spawn.args,
            stdin: prepared.spawn.stdin,
          }, {
            cwd: prepared.spawn.cwd,
            env: effectiveSpawnEnvironment(prepared.spawn),
          });
          result = await this.runOneShotPipeline(
            participantId,
            phase,
            prepared,
            prompt,
            DUEL_COMMITMENT_HEAD_TIMEOUT_MS,
            signal,
            traceId,
            startedAtMs,
            { traceKind: "duelCommitment", captureLiveChannel: false, sensitive: true },
          );
        }
      } finally {
        releaseClaudeCreditReservation?.();
      }

      if (didAgentFail(result)) {
        throw new Error(
          result.cancelled
            ? "The participant head call was cancelled."
            : result.timedOut
              ? "The participant head call timed out."
              : `The participant head exited unsuccessfully (${result.exitCode ?? "no exit code"}).`,
        );
      }
      const response = parseDuelAgentCommitmentResponse(result.stdout, {
        duelId: duel.duelId,
        participantId,
        commitmentId,
      });
      return {
        response,
        receipt: {
          traceId,
          agentId: participantId,
          agentKind: definition.kind,
          ...((modelForPhase(participantId, phase) || definition.model)
            ? { model: modelForPhase(participantId, phase) || definition.model }
            : {}),
          transport,
          startedAt,
          completedAt: new Date().toISOString(),
          promptSha256,
          sharedEvidenceSha256: hashDuelSharedEvidencePacket(sharedEvidencePacket),
          capabilityPolicy: DUEL_FULL_ACCESS_POLICY_ID,
          responseSha256: duelResponseSha256(response),
          invocationSha256,
          ...(workspaceFingerprintSha256 ? { workspaceFingerprintSha256 } : {}),
          ...(capabilityLockSha256 ? { capabilityLockSha256 } : {}),
        },
      };
  }

  private async runHeadlessDuelHttpAgent(
    agent: AgentId,
    phase: Phase,
    invocation: HttpInvocation,
    prompt: string,
    timeout: number,
    signal: AbortSignal,
    traceId: string,
    startedAt: number,
  ): Promise<RunResult> {
    await this.appendAgentCallTrace({
      id: traceId,
      event: "started",
      kind: "duelCommitment",
      sensitive: true,
      timestamp: new Date(startedAt).toISOString(),
      agent,
      phase,
      transport: "http",
      command: invocation.url,
      args: [],
      envKeys: [],
      timeoutMs: timeout,
      promptChars: prompt.length,
      promptSha256: sha256(prompt),
      outputMode: "openaiJson",
    });
    let normalized: RunResult;
    let raw: AdapterRawOutput | undefined;
    try {
      const result = await runHttpAgent(invocation, { timeoutMs: timeout, signal });
      const definition = getAgentDefinition(agent);
      const adapter = definition ? adapterForKind(definition.kind) : undefined;
      raw = { stdout: result.rawBody, stderr: result.stderr, exitCode: result.exitCode, outputMode: "openaiJson" };
      const replyText = adapter && result.exitCode === 0 ? adapter.parseReply(raw) : result.stdout;
      normalized = { ...result, stdout: replyText };
      if (!result.cancelled && !result.timedOut) {
        const tokens = adapter?.parseUsage(raw);
        if (tokens) {
          await this.recordUsage({ agent, phase, requestId: traceId, model: definition?.model, source: "unknown", tokens });
        }
      }
    } catch (error) {
      normalized = agentCallFailureResult(error instanceof Error ? error.message : String(error));
    }
    const completed = completedAgentCallTrace(traceId, agent, phase, "http", startedAt, normalized);
    delete completed.stderrPreview;
    await this.appendAgentCallTrace({ ...completed, kind: "duelCommitment", sensitive: true });
    return normalized;
  }

  private buildDuelCommitmentInvocation(agent: AgentId, prompt: string): Invocation {
    const phase: Phase = "review";
    const definition = getAgentDefinition(agent);
    if (!definition) throw new Error(`Head "${agent}" is not registered.`);
    const adapter = adapterForKind(definition.kind);
    const configuredInvocation = this.buildInvocationFor(agent, phase, prompt);
    if (configuredInvocation.transport !== "spawn") {
      throw new Error(`Head "${agent}" is not configured for a native full-tool spawn.`);
    }
    const fullAccessArgs = duelCommitmentFullAccessArgs(definition.kind, configuredInvocation.args);
    if (fullAccessArgs) {
      return adapter.buildInvocation(definition, {
        phase,
        workspaceRoot: this.workspaceRoot,
        prompt,
        command: configuredInvocation.command,
        rawArgs: fullAccessArgs,
      });
    }
    throw new Error(
      `Head "${agent}" has no Hydra full-access rated duel profile. Hydra will not create an unequal or unranked fallback.`,
    );
  }

  private supportsFullAccessRatedDuel(agent: AgentId): boolean {
    const definition = getAgentDefinition(agent);
    return !!definition && duelCommitmentFullAccessArgs(definition.kind) !== undefined;
  }

  private async captureFullAccessDuelHeadLock(agent: AgentId): Promise<DuelParticipantCapabilityLock> {
    const invocation = this.buildDuelCommitmentInvocation(agent, "{}");
    if (invocation.transport !== "spawn") {
      throw new Error(`${displayNameFor(agent)} is not configured for a native full-tool spawn.`);
    }
    let spawn = this.applyConfiguredSpawnEnvironment(agent, {
      command: invocation.command,
      args: invocation.args,
      cwd: this.workspaceRoot,
      stdin: invocation.stdin ?? "",
    });
    spawn = {
      ...spawn,
      command: await resolveAgentCommand(agent, spawn.command, effectiveSpawnEnvironment(spawn)),
    };
    return this.capabilityLockForSpawn(agent, spawn);
  }

  private capabilityLockForSpawn(agent: AgentId, spawn: AgentSpawn): DuelParticipantCapabilityLock {
    const definition = getAgentDefinition(agent);
    if (!definition) throw new Error(`Head "${agent}" is not registered.`);
    return {
      agentId: agent,
      agentKind: definition.kind,
      profileSha256: duelCapabilityLockSha256({
        agentId: agent,
        agentKind: definition.kind,
        ...(modelForPhase(agent, "review") || definition.model
          ? { model: modelForPhase(agent, "review") || definition.model }
          : {}),
        command: spawn.command,
        args: spawn.args,
        cwd: spawn.cwd,
        env: effectiveSpawnEnvironment(spawn),
      }),
    };
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
      traceKind?: "wikiWrapup" | "duelCommitment";
      captureLiveChannel?: boolean;
      sensitive?: boolean;
      onChunk?: (chunk: string) => void;
      onReplaceText?: (text: string) => void;
      onLiveChannelEvent?: (event: LiveChannelEvent) => void;
      recordFailureCard?: (result: RunResult) => void;
    } = {}
  ): Promise<RunResult> {
    const { traceKind, captureLiveChannel = true, sensitive = false, onChunk, onReplaceText, onLiveChannelEvent, recordFailureCard } = opts;
    const spawn = prepared.spawn;
    const promptSha256 = sha256(prompt);
    const privatePaths = prepared.privateArtifacts
      ? [
          prepared.privateArtifacts.promptPath,
          prepared.privateArtifacts.replyPath,
          prepared.privateArtifacts.logPath,
        ]
      : [];
    try {
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
        args: redactPrivateArtifactArgs(spawn.args, privatePaths),
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
      const liveChannel = captureLiveChannel && !sensitive && this.effectiveManyHeadsMode()
        ? createLiveChannelWriter({
            workspaceRoot: this.workspaceRoot,
            requestId: traceId,
            agent,
            phase,
            outputMode: prepared.outputMode,
            onEvent: onLiveChannelEvent,
          })
        : undefined;
      const browserBroker = HydraRoomPanel.browserBroker;
      const browserRedactor = browserBroker?.createAgentOutputRedactor(agent);
      const emitBrowserSafeChunk = (browserSafeChunk: string): void => {
        if (!browserSafeChunk) return;
        const chunk = redactPrivateArtifactText(browserSafeChunk, privatePaths);
        liveChannel?.push(chunk);
        const text = liveText ? liveText.push(chunk) : chunk;
        if (text) onChunk?.(text);
      };
      const rawResult = await runAgent(spawn, prompt, timeout, (rawChunk) => {
        const browserSafeChunk = browserRedactor
          ? browserRedactor.push(rawChunk)
          : browserBroker?.redactAgentText(agent, rawChunk) ?? rawChunk;
        emitBrowserSafeChunk(browserSafeChunk);
      }, signal);
      emitBrowserSafeChunk(browserRedactor?.flush() ?? "");
      const result = browserBroker?.redactAgentResult(agent, rawResult) ?? rawResult;
      await liveChannel?.flush();
      const normalizedRaw = await this.normalizeOneShotResult(prepared, result);
      const normalized = HydraRoomPanel.browserBroker?.redactAgentResult(agent, normalizedRaw) ?? normalizedRaw;
      this.latchUnconfirmedNativeTermination(normalized, `${agent} ${phase}`, agent);
      const traceStdout = redactPrivateArtifactText(result.stdout, privatePaths);
      // Stream summaries intentionally include final assistant text for normal
      // room diagnostics. A sealed duel answer must not reach the workspace
      // before paired reveal, so sensitive calls omit the summary entirely.
      if (!sensitive && prepared.outputMode === "claudeStreamJson") {
        const summary = summarizeClaudeEvents(parseClaudeEventStream(traceStdout));
        if ((phase === "reactor" || phase === "closer") && summary.lastAssistantText) {
          summary.lastAssistantText = stripAgentDuelChallengeControlLines(summary.lastAssistantText);
        }
        await this.appendAgentCallTrace({
          id: traceId,
          event: "streamSummary",
          ...(traceKind ? { kind: traceKind } : {}),
          timestamp: new Date().toISOString(),
          agent,
          phase,
          transport: "oneShot",
          summary,
        });
      } else if (!sensitive && prepared.outputMode === "codexJson") {
        const summary = summarizeCodexEvents(parseCodexEventStream(traceStdout));
        if ((phase === "reactor" || phase === "closer") && summary.lastAgentMessage) {
          summary.lastAgentMessage = stripAgentDuelChallengeControlLines(summary.lastAgentMessage);
        }
        await this.appendAgentCallTrace({
          id: traceId,
          event: "streamSummary",
          ...(traceKind ? { kind: traceKind } : {}),
          timestamp: new Date().toISOString(),
          agent,
          phase,
          transport: "oneShot",
          summary,
        });
      }
      if (onReplaceText && normalized.stdout !== result.stdout) {
        onReplaceText(normalized.stdout);
      }
      recordFailureCard?.(normalized);
      const completedTrace = completedAgentCallTrace(traceId, agent, phase, "oneShot", startedAt, normalized);
      if (sensitive) delete completedTrace.stderrPreview;
      await this.appendAgentCallTrace(traceKind ? { ...completedTrace, kind: traceKind } : completedTrace);
      // Why: usage must parse the RAW stdout. normalizeOneShotResult swaps in
      // the --output-last-message reply text for plain Codex, which drops the
      // trailing "tokens used" footer and silently disabled Codex usage rows.
      await this.extractAndRecordUsage({ agent, phase, requestId: traceId, result, outputMode: prepared.outputMode });
      return normalized;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const browserSafeMessage = HydraRoomPanel.browserBroker?.redactAgentText(agent, message) ?? message;
      throw new Error(redactPrivateArtifactText(browserSafeMessage, privatePaths));
    } finally {
      if (prepared.privateArtifacts) {
        await cleanupPrivateArtifacts(privatePaths, prepared.privateArtifacts.boundary);
      }
    }
  }

  // Sibling of runOneShotPipeline for http-transport heads (openai-compatible):
  // same trace / live-chunk / failure-card / usage plumbing, but the reply
  // comes from runHttpAgent instead of a spawned CLI, and reply/usage parsing
  // routes through the head's registry adapter.
  private async runHttpPipeline(
    agent: AgentId,
    phase: Phase,
    invocation: HttpInvocation,
    prompt: string,
    messageId: string,
    timeout: number,
    signal: AbortSignal,
    traceIdOverride?: string,
    markOutput?: () => void
  ): Promise<RunResult> {
    const traceId = traceIdOverride ?? makeTraceId(agent, phase);
    const startedAt = Date.now();
    const promptSha256 = sha256(prompt);
    await this.appendAgentCallTrace({
      id: traceId,
      event: "started",
      timestamp: new Date(startedAt).toISOString(),
      agent,
      phase,
      transport: "http",
      // Why: record the endpoint URL only — the invocation's header map can
      // carry an Authorization credential and must never reach the trace.
      command: invocation.url,
      args: [],
      envKeys: [],
      timeoutMs: timeout,
      promptChars: prompt.length,
      promptSha256,
      outputMode: "openaiJson",
    });
    try {
      const result = await runHttpAgent(invocation, {
        timeoutMs: timeout,
        signal,
        onChunk: (chunk) => {
          markOutput?.();
          const m = this.messagesById.get(messageId);
          if (m) m.text += chunk;
          this.panel.webview.postMessage({ type: "chunk", messageId, text: chunk });
        },
      });
      const def = getAgentDefinition(agent);
      const adapter = def ? adapterForKind(def.kind) : undefined;
      const raw: AdapterRawOutput = { stdout: result.rawBody, stderr: result.stderr, exitCode: result.exitCode, outputMode: "openaiJson" };
      // Why: parse the reply only on success — on an HTTP error rawBody holds
      // the error body, and on abort/timeout the streamed partial text in
      // result.stdout is already the best reply we have.
      const replyText = adapter && result.exitCode === 0 ? adapter.parseReply(raw) : result.stdout;
      const normalized: RunResult = { ...result, stdout: replyText };
      const m = this.messagesById.get(messageId);
      if (m && replyText && replyText !== m.text) {
        m.text = replyText;
        this.panel.webview.postMessage({ type: "replaceMessageText", messageId, text: replyText });
      }
      this.recordRunFailureCard(messageId, { id: traceId, agent, phase, transport: "http", startedAt, result: normalized, promptSha256 });
      await this.appendAgentCallTrace(completedAgentCallTrace(traceId, agent, phase, "http", startedAt, normalized));
      if (!result.cancelled && !result.timedOut) {
        const tokens = adapter?.parseUsage(raw);
        if (tokens) {
          await this.recordUsage({ agent, phase, requestId: traceId, model: def?.model, source: "unknown", tokens });
        }
      }
      return normalized;
    } catch (err) {
      // runHttpAgent resolves failures as results; this mirrors
      // runAgentTransport's belt-and-suspenders catch for anything it throws.
      const result = agentCallFailureResult(err instanceof Error ? err.message : String(err));
      this.recordRunFailureCard(messageId, { id: traceId, agent, phase, transport: "http", startedAt, result, promptSha256 });
      await this.appendAgentCallTrace(completedAgentCallTrace(traceId, agent, phase, "http", startedAt, result));
      return result;
    }
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
    if (!this.effectiveAutoAdvanceActionableDefaults()) return;
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
      if (!this.isActiveAgent(action.builder)) {
        await this.appendSystemMessage(
          `Hydra auto-advance paused: ${displayNameFor(action.builder)} is not currently registered and seated, so the historical default cannot dispatch it.`,
        );
        return;
      }
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
          await this.persistTranscriptMessage({
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
      const otherAgent = pickReviewers(reviewer, this.roster())[0] ?? reviewer;
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
          otherAgent: pickReviewers(reviewer, this.roster())[0] ?? reviewer,
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

  private async finishBlockedAgentCall(messageId: string): Promise<{ text: string; result: RunResult }> {
    const result: RunResult = {
      stdout: "",
      stderr: this.unconfirmedTerminationMessage(),
      exitCode: null,
      timedOut: false,
      cancelled: false,
      terminationFailed: true,
    };
    await this.finalizePendingMessage(messageId, result);
    const finalized = this.messagesById.get(messageId);
    return { text: finalized?.text ?? "", result };
  }

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
    if (this.unconfirmedNativeTermination) {
      return this.finishBlockedAgentCall(messageId);
    }
    const boundTraceId = traceIdOverride ?? makeTraceId(agent, phase);
    this.pendingAgentTraceIds.set(messageId, boundTraceId);
    let releaseClaudeCreditReservation: (() => void) | undefined;
    // Claude Agent SDK credit guard: evaluate BEFORE any spawn (timeout/pending
    // activity, consent, transport) so a `block` decision prevents
    // subscription-credit spend instead of only stopping auto-advance after the
    // spend already happened. Only Claude dispatch draws from that pool.
    if (getAgentDefinition(agent)?.kind === "claude") {
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
        const traceId = boundTraceId;
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
    if (this.unconfirmedNativeTermination) {
      releaseClaudeCreditReservation?.();
      return this.finishBlockedAgentCall(messageId);
    }
    const timeout = agentTimeoutMs(phase);
    const activity = this.startPendingActivity(messageId, agent, phase, timeout);
    let dispatch: AgentDispatchPlan;
    let browserPreparedSpawn: AgentSpawn | undefined;
    try {
      // Why: dispatch argv must come from the REAL prompt so a cli-template
      // head's ${prompt} placeholder expands; the empty-prompt buildSpawn is
      // for previews/diagnostics only. For codex/claude the argv is
      // prompt-independent (prompt rides stdin), so this is byte-identical to
      // the old buildSpawn path — pinned by test/hydraHeadsRegression.test.ts.
      const inv = this.buildInvocationFor(agent, phase, prompt);
      if (inv.transport === "http") {
        dispatch = { transport: "http", invocation: inv };
      } else {
        let spawn = this.applyConfiguredSpawnEnvironment(agent, {
          command: inv.command,
          args: inv.args,
          cwd: this.workspaceRoot,
          stdin: inv.stdin ?? "",
        });
        spawn = HydraRoomPanel.browserBroker?.prepareAgentSpawn(agent, getAgentDefinition(agent)?.kind ?? "cli-template", spawn) ?? spawn;
        browserPreparedSpawn = spawn;
        spawn = {
          ...spawn,
          command: await resolveAgentCommand(agent, spawn.command, effectiveSpawnEnvironment(spawn)),
        };
        dispatch = { transport: "spawn", spawn };
      }
    } catch (err) {
      if (browserPreparedSpawn) HydraRoomPanel.browserBroker?.revokeAgentSpawn(browserPreparedSpawn);
      const message = err instanceof Error ? err.message : String(err);
      const traceId = boundTraceId;
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
      consent = await this.ensureFullNativeConsent(agent, phase, dispatch.transport === "spawn" ? dispatch.spawn.args : []);
    } catch (err) {
      // ensureFullNativeConsent awaits VS Code modal/state APIs that can reject;
      // this await sits outside the final try/finally, so release the in-flight
      // Claude credit reservation here or it stays elevated for the session.
      activity.stop();
      releaseClaudeCreditReservation?.();
      releaseClaudeCreditReservation = undefined;
      if (dispatch.transport === "spawn") HydraRoomPanel.browserBroker?.revokeAgentSpawn(dispatch.spawn);
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
      if (dispatch.transport === "spawn") HydraRoomPanel.browserBroker?.revokeAgentSpawn(dispatch.spawn);
      const finalized = this.messagesById.get(messageId);
      return { text: finalized?.text ?? "", result };
    }
    try {
      const rawResult =
        dispatch.transport === "http"
          ? await this.runHttpPipeline(agent, phase, dispatch.invocation, prompt, messageId, timeout, signal, boundTraceId, activity.markOutput)
          : await this.runAgentTransport(agent, phase, dispatch.spawn, prompt, messageId, timeout, signal, forceTerminalBridge, boundTraceId, activity.markOutput);
      const result = HydraRoomPanel.browserBroker?.redactAgentResult(agent, rawResult) ?? rawResult;
      await this.finalizePendingMessage(messageId, result);
      const finalized = this.messagesById.get(messageId);
      return { text: finalized?.text ?? "", result };
    } finally {
      activity.stop();
      releaseClaudeCreditReservation?.();
      if (dispatch.transport === "spawn") HydraRoomPanel.browserBroker?.revokeAgentSpawn(dispatch.spawn);
    }
  }

  private async ensureFullNativeConsent(
    agent: AgentId,
    phase: Phase,
    args: string[]
  ): Promise<{ allowed: boolean; message?: string }> {
    // Why: authority comes from the head's registry adapter — codex/claude
    // delegate to classifyAgentAuthority (identical result to before), while
    // cli-template returns its definition's authority (fullNative by default),
    // which is what routes custom CLI heads through this consent modal.
    const def = getAgentDefinition(agent);
    const authority = def
      ? adapterForKind(def.kind).authority(def, { phase, workspaceRoot: this.workspaceRoot, prompt: "", command: "", rawArgs: args })
      : classifyAgentAuthority(agent, phase, args);
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
      const browserRequiresOneShot = !!spawn.env?.HYDRA_BROWSER_TOKEN;
      if (!browserRequiresOneShot && (forceTerminalBridge || this.transportMode() === "terminalBridge")) {
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
              const rawText = liveText.push(chunk);
              const text = HydraRoomPanel.browserBroker?.redactAgentText(agent, rawText) ?? rawText;
              if (!text) return;
              const live = this.messagesById.get(messageId);
              if (live) live.text += text;
              this.panel.webview.postMessage({ type: "chunk", messageId, text });
            }
          : undefined;
        let result: TerminalBridgeRunResult;
        this.terminalBridgeDispatchInFlight += 1;
        try {
          const rawResult = await this.terminalBridge.callAgent(
            agent,
            phase,
            terminalPrepared.spawn,
            prompt,
            timeout,
            signal,
            onLiveChunk
          );
          result = HydraRoomPanel.browserBroker?.redactAgentResult(agent, rawResult) ?? rawResult;
        } finally {
          this.terminalBridgeDispatchInFlight = Math.max(0, this.terminalBridgeDispatchInFlight - 1);
        }
        const normalizedRaw = await this.normalizeTerminalBridgeResult(terminalPrepared.outputMode, result);
        const normalized = HydraRoomPanel.browserBroker?.redactAgentResult(agent, normalizedRaw) ?? normalizedRaw;
        this.latchUnconfirmedNativeTermination(normalized, `${agent} ${phase} terminal bridge`, agent);
        const m = this.messagesById.get(messageId);
        if (m) {
          if (terminalPrepared.outputMode === "plain") {
            if (normalized.stdout) {
              m.text += normalized.stdout;
              this.panel.webview.postMessage({ type: "chunk", messageId, text: normalized.stdout });
            }
          } else {
            // Structured live text is cosmetic and unauthenticated. Always
            // replace it, including with an empty guarded result, so an HMAC
            // failure/timeout cannot leave unverified streamed text in the
            // persisted transcript.
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
    const agentKind = getAgentDefinition(agent)?.kind;
    const codexJson = agentKind === "codex" && shouldUseCodexJson(spawn);
    // codexJson supersedes codexCaptureLastMessage: the --json stream
    // already carries the final agent_message item, so the extra
    // --output-last-message file is redundant when codexJson is on.
    const codexLastMessage = agentKind === "codex" && !codexJson && shouldCaptureCodexLastMessage(spawn);
    const claudeStreamJson = agentKind === "claude" && shouldUseClaudeStreamJson(spawn);
    const needsRequestFiles =
      hasRequestFilePlaceholders(spawn) ||
      codexLastMessage ||
      (agentKind === "claude" && shouldCreateClaudeRequestFiles(spawn));
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
    const artifactRoot = this.oneShotArtifactRoot();
    const boundary = await this.prepareOneShotArtifactBoundary(artifactRoot);
    await sweepPrivateArtifacts(
      boundary,
      ["prompts", "replies", "logs"],
      ONE_SHOT_ARTIFACT_RETENTION_MS
    );

    const requestId = `${Date.now()}-${crypto.randomUUID()}`;
    const paths = terminalProtocolStoragePaths(artifactRoot, requestId, agent, phase);
    const artifactPaths = [paths.promptPath, paths.replyPath, paths.logPath];
    try {
      await createPrivateArtifact(
        paths.promptPath,
        buildTerminalPromptFile(agent, phase, prompt, paths.replyPath),
        boundary
      );
      await createPrivateArtifact(paths.logPath, "", boundary);
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
        promptPath: `[private extension storage]/${path.basename(paths.promptPath)}`,
        replyPath: `[private extension storage]/${path.basename(paths.replyPath)}`,
        logPath: `[private extension storage]/${path.basename(paths.logPath)}`,
        privateArtifacts: {
          boundary,
          promptPath: paths.promptPath,
          replyPath: paths.replyPath,
          logPath: paths.logPath,
        },
        outputMode,
      };
    } catch (err) {
      await cleanupPrivateArtifacts(artifactPaths, boundary);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(redactPrivateArtifactText(message, artifactPaths));
    }
  }

  private prepareTerminalBridgeSpawn(
    agent: AgentId,
    spawn: AgentSpawn
  ): { spawn: AgentSpawn; outputMode: "plain" | "claudeStreamJson" | "codexJson" } {
    const agentKind = getAgentDefinition(agent)?.kind;
    if (agentKind === "claude" && shouldUseClaudeStreamJson(spawn)) {
      return { spawn: withClaudeStreamJsonArgs(spawn), outputMode: "claudeStreamJson" };
    }
    if (agentKind === "codex" && spawn.args.includes("exec")) {
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
    if (prepared.privateArtifacts) {
      try {
        const replyText = (
          await readPrivateArtifactUtf8(
            prepared.privateArtifacts.replyPath,
            prepared.privateArtifacts.boundary,
            MAX_AGENT_STDOUT_BYTES
          )
        ).trimEnd();
        if (replyText.trim()) stdout = replyText;
      } catch {
        // Older CLIs and failed runs may not produce a native reply file.
      }
    }
    const privatePaths = prepared.privateArtifacts
      ? [
          prepared.privateArtifacts.promptPath,
          prepared.privateArtifacts.replyPath,
          prepared.privateArtifacts.logPath,
        ]
      : [];
    stdout = redactPrivateArtifactText(stdout, privatePaths);
    result = { ...result, stderr: redactPrivateArtifactText(result.stderr, privatePaths) };
    return guardNativeReply({ ...result, stdout });
  }

  private async normalizeTerminalBridgeResult(
    outputMode: "plain" | "claudeStreamJson" | "codexJson",
    result: RunResult & { promptPath?: string; logPath?: string; replyPath?: string; verifiedLog?: string }
  ): Promise<RunResult & { promptPath?: string; logPath?: string; replyPath?: string; verifiedLog?: string }> {
    let stdout = result.stdout;
    const raw = await this.terminalBridgeRawOutput(result);
    if (outputMode === "claudeStreamJson") {
      stdout = roomTextFromClaudeStreamJson(raw);
    } else if (outputMode === "codexJson") {
      stdout = roomTextFromCodexJson(raw);
    }
    return guardNativeReply({ ...result, stdout });
  }

  private async terminalBridgeUsageResult(result: RunResult & { logPath?: string; verifiedLog?: string }): Promise<RunResult> {
    return { ...result, stdout: await this.terminalBridgeRawOutput(result) };
  }

  private async terminalBridgeRawOutput(result: RunResult & { logPath?: string; verifiedLog?: string }): Promise<string> {
    if (result.verifiedLog !== undefined) return result.verifiedLog || result.stdout;
    // Never re-read a mutable path after reply authentication. Legacy results
    // without an HMAC-bound snapshot fall back to their validated reply text.
    return result.stdout;
  }

  private roster(): AgentId[] {
    const known = new Set(listAgentDefinitions().map((definition) => definition.id));
    const seated = roomRoster().filter((agent) => known.has(agent));
    if (seated.length >= 2) return seated;
    const fallback = DEFAULT_ROSTER.filter((agent) => known.has(agent));
    return fallback.length >= 2
      ? [...fallback]
      : listAgentDefinitions().slice(0, 2).map((definition) => definition.id);
  }

  private isActiveAgent(agent: AgentId): boolean {
    return this.roster().includes(agent) && !!getAgentDefinition(agent);
  }

  private buildInvocationFor(agent: AgentId, phase: Phase, prompt: string): Invocation {
    // The vendor argv chain (buildAgentSpawn → skip-git-repo-check → model →
    // effort) lives inside each kind's adapter now, so a new head dispatches
    // through the exact same path as codex/claude.
    const def = getAgentDefinition(agent) ?? { id: agent, displayName: agent, kind: "codex" as const };
    const cfg = vscode.workspace.getConfiguration("hydraRoom");
    // Why: `${agent}Command`/exec-args/profile keys are declared, trust-scoped
    // settings only for built-in head ids. For a custom head id those keys are
    // UNDECLARED — settable from an untrusted workspace's settings.json — so a
    // custom head's command/args come solely from the trust-scoped
    // hydraRoom.agents definition (SP1 final-review carry-in constraint).
    if (!isBuiltinAgentId(agent)) {
      return adapterForKind(def.kind).buildInvocation(def, {
        phase,
        workspaceRoot: this.workspaceRoot,
        prompt,
        command: def.command ?? agent,
        rawArgs: [],
      });
    }
    const command = cfg.get<string>(`${agent}Command`, agent);
    const argsKey = argsSettingKey(agent, phase);
    const cliProfile = profileForPhase(phase);
    const configuredProfile = cfg.get<string>(profileSettingKey(agent, cliProfile), "custom");
    const presetArgs = isConfigurableCapabilityProfileId(configuredProfile)
      ? argsForCapabilityProfile(agent, configuredProfile)
      : undefined;
    const rawArgs = presetArgs ?? cfg.get<string[]>(argsKey, []);
    return adapterForKind(def.kind).buildInvocation(def, {
      phase,
      workspaceRoot: this.workspaceRoot,
      prompt,
      command,
      rawArgs,
    });
  }

  private buildSpawn(agent: AgentId, phase: Phase): AgentSpawn {
    // Why: prompt is deliberately empty — buildSpawn argv is the display /
    // diagnostic surface (previews, doctor, envelopes, wiki wrapup). Turn
    // dispatch calls buildInvocationFor with the REAL prompt instead, so a
    // cli-template head's ${prompt} placeholder expands there and never here.
    const inv = this.buildInvocationFor(agent, phase, "");
    if (inv.transport !== "spawn") {
      throw new Error(`Agent "${agent}" uses the HTTP transport and has no spawn argv`);
    }
    // No stdin here: buildSpawn consumers (wiki wrapup, probes) rely on
    // runAgent's prompt-argument fallback.
    return this.applyConfiguredSpawnEnvironment(agent, { command: inv.command, args: inv.args, cwd: this.workspaceRoot });
  }

  private applyConfiguredSpawnEnvironment(agent: AgentId, spawn: AgentSpawn): AgentSpawn {
    const cfg = vscode.workspace.getConfiguration("hydraRoom");
    // Why: same undeclared-key fence as buildInvocationFor — per-agent env /
    // PATH keys are only declared (and trust-scoped) for built-in head ids.
    const perAgent = isBuiltinAgentId(agent);
    return applySpawnEnvironment(
      spawn,
      this.workspaceRoot,
      mergeNativeEnv(
        cfg.get<Record<string, string>>("nativeEnv", {}),
        perAgent ? cfg.get<Record<string, string>>(`${agent}NativeEnv`, {}) : {}
      ),
      mergeNativePathPrepend(
        cfg.get<string[]>("nativePathPrepend", []),
        perAgent ? cfg.get<string[]>(`${agent}NativePathPrepend`, []) : []
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
      return {
        ...spawn,
        command: await resolveAgentCommand(agent, spawn.command, effectiveSpawnEnvironment(spawn)),
      };
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
          command = await resolveAgentCommand(agent, spawn.command, effectiveSpawnEnvironment(spawn));
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
  }): Promise<HydraPromptEnvelope> {
    const duelProtocolExpected = agentInitiatedDuels()
      && (input.phase === "reactor" || input.phase === "closer");
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
      allowAgentDuelChallenge: duelProtocolExpected,
    });
    let spawn = this.buildSpawn(input.agent, input.phase);
    const agentKind = getAgentDefinition(input.agent)?.kind ?? "cli-template";
    // Prompt previews shape the visible argv without minting or revoking a
    // dispatch bearer. Authorization is created only on the real call path.
    spawn = HydraRoomPanel.browserBroker?.previewAgentSpawn(agentKind, spawn) ?? spawn;
    const authority = classifyAgentAuthority(input.agent, input.phase, spawn.args);
    const profile = describeCapabilityProfile(input.agent, input.phase, spawn.args, authority);
    let command = spawn.command;
    try {
      command = await resolveAgentCommand(input.agent, spawn.command, effectiveSpawnEnvironment(spawn));
    } catch {
      // Preview should still work even when the CLI is missing; Doctor owns
      // command repair and the actual call path surfaces spawn failures.
    }
    return {
      ...createPromptEnvelope({
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
      }),
      duelProtocolExpected,
    };
  }

  private async nativeCapabilityPromptContext(agent: AgentId, taskContext: Array<string | undefined>): Promise<string> {
    const base = nativeCapabilitySummary(agent);
    const sections = [base];
    if (shouldIncludeNativeIntegrationSummary(...taskContext)) {
      const integration = await readNativeIntegrationSummary(this.nativeCapabilitiesUri.fsPath);
      if (integration) {
        sections.push(
          "Latest native integration probe summary from `.hydra/native-capabilities.md`:",
          integration,
        );
      }
    }
    const agentKind = getAgentDefinition(agent)?.kind ?? "cli-template";
    const browser = agentKind === "openai-compatible"
      ? ""
      : HydraRoomPanel.browserBroker?.promptContext(agent, agentKind);
    if (browser) sections.push(browser);
    return sections.join("\n\n");
  }

  private async buildDirectTerminalPokeEnvelope(
    agent: AgentId,
    instruction: string,
    editorContext?: EditorContextAttachment,
    workspaceDiff?: string
  ): Promise<PromptEnvelope> {
    const phase: Phase = "opener";
    const other = pickReviewers(agent, this.roster())[0] ?? agent;
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
      command = await resolveAgentCommand(agent, spawn.command, effectiveSpawnEnvironment(spawn));
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
        await appendFileSafely(filePath, `${JSON.stringify(record)}\n`);
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
    // Why: DEFAULT_PRICES is keyed by the now-widened AgentId, so a literal
    // .claude/.codex access types as possibly-undefined; UNKNOWN_AGENT_PRICES
    // is the same floor resolveModelPrices falls back to, unreachable here
    // since both built-in entries are always present.
    const agentDefaults: Record<AgentId, ModelPrices> = {
      claude: { ...(DEFAULT_PRICES.claude ?? UNKNOWN_AGENT_PRICES) },
      codex: { ...(DEFAULT_PRICES.codex ?? UNKNOWN_AGENT_PRICES) },
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
          agentDefaults[key] = coerceModelPrices(v, DEFAULT_PRICES[key] ?? UNKNOWN_AGENT_PRICES);
        } else {
          // Why: keep the override PARTIAL — resolveModelPrices merges it over
          // the matching per-model/per-agent base at billing time, so an
          // omitted Codex cache rate no longer inherits Claude's default.
          modelOverrides[key.toLowerCase()] = sanitizePartialModelPrices(v);
        }
      }
    }
    return { agentDefaults: seatDefinitionPrices(agentDefaults, listAgentDefinitions()), modelOverrides };
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
      agentKind: getAgentDefinition(input.agent)?.kind,
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
    if (record.agent === "claude" || record.agentKind === "claude") {
      const recordDate = new Date(record.timestamp);
      if (Number.isFinite(recordDate.getTime()) && usageCalendarMonthKey(recordDate) === this.claudeCreditMonthKey) {
        this.claudeCreditMonthSpendUsd = Math.round((this.claudeCreditMonthSpendUsd + Math.max(0, record.costUsd || 0)) * 10_000) / 10_000;
      }
    }
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
    const agentKind = getAgentDefinition(agent)?.kind;
    const model = modelForPhase(agent, phase) || undefined;
    if (agentKind === "claude" && outputMode === "claudeStreamJson") {
      const summary = summarizeClaudeEvents(parseClaudeEventStream(result.stdout));
      const tokens = usageFromClaudeSummary(summary.usage);
      if (tokens) {
        await this.recordUsage({ agent, phase, requestId, model, source: "claudeStreamJson", tokens, nativeCostUsd: summary.totalCostUsd });
        return;
      }
    }
    if (agentKind === "codex" && outputMode === "codexJson") {
      const summary = summarizeCodexEvents(parseCodexEventStream(result.stdout));
      const tokens = usageFromCodexSummary(summary.usage);
      if (tokens) {
        await this.recordUsage({ agent, phase, requestId, model, source: "codexJson", tokens });
        return;
      }
    }
    if (agentKind === "codex") {
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
      const reviewer = pickReviewers(this.state.builder, this.roster())[0] ?? this.state.builder;
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
      const reviewer = this.state.agents[0] ?? this.getFirstSpeaker();
      const otherAgent = this.state.agents.find((agent) => agent !== reviewer) ?? reviewer;
      return await this.buildPromptEnvelope({
        agent: reviewer,
        otherAgent,
        phase: "review",
        transcript: this.buildPromptContext("review", undefined, reviewer),
        diff: diff ?? "[git diff failed; preview cannot include diff]",
        verification: verificationAsReviewContext(this.latestVerification()),
      });
    }

    if (this.state.name === "ReviewDone" && !this.state.approved && !draftText.trim()) {
      const builder = this.state.builder;
      return await this.buildPromptEnvelope({
        agent: builder,
        otherAgent: this.state.reviewer,
        phase: "build",
        transcript: this.buildPromptContext("build", undefined, builder),
      });
    }

    if (this.state.name === "ParallelReviewDone" && !this.state.approved && !draftText.trim()) {
      const builder = this.state.builders[0] ?? this.getFirstSpeaker();
      const otherAgent = this.state.builders.find((agent) => agent !== builder) ?? builder;
      return await this.buildPromptEnvelope({
        agent: builder,
        otherAgent,
        phase: "build",
        transcript: this.buildPromptContext("build", undefined, builder),
      });
    }

    const selectedOpener = normalizeAgentId(opener, this.getFirstSpeaker(), this.roster());
    const reactor = pickReviewers(selectedOpener, this.roster())[0] ?? selectedOpener;
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
    return Object.fromEntries(
      this.roster().map((agent) => [agent, this.authoritySummaryForAgent(agent)]),
    );
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
        return (pickReviewers(this.state.builder, this.roster())[0] ?? this.state.builder) === agent ? "review" : "build";
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
    const codexSpawn = this.applyConfiguredSpawnEnvironment("codex", {
      command: codexCommand,
      args: [],
      cwd: this.workspaceRoot,
    });
    const claudeSpawn = this.applyConfiguredSpawnEnvironment("claude", {
      command: claudeCommand,
      args: [],
      cwd: this.workspaceRoot,
    });
    const resolveForDoctor = async (agent: AgentId, spawn: AgentSpawn): Promise<string | undefined> => {
      try {
        return await resolveAgentCommand(agent, spawn.command, effectiveSpawnEnvironment(spawn));
      } catch {
        return undefined;
      }
    };
    const [codexResolvedCommand, claudeResolvedCommand] = await Promise.all([
      resolveForDoctor("codex", codexSpawn),
      resolveForDoctor("claude", claudeSpawn),
    ]);
    const bridgeResult = includeTerminalBridge && !this.unconfirmedNativeTermination && this.terminalBridge
      ? await this.terminalBridge.selfTest(terminalBridgeTimeoutMs())
      : undefined;
    if (bridgeResult) {
      this.latchUnconfirmedNativeTermination(bridgeResult, "Doctor terminal bridge self-test", "codex");
    }
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

  private effectiveManyHeadsMode(): boolean {
    if (vscode.workspace.isTrusted !== true) return false;
    return this.manyHeadsModeOverride ?? manyHeadsMode();
  }

  private effectiveAutoAdvanceActionableDefaults(): boolean {
    if (vscode.workspace.isTrusted !== true) return false;
    return this.autoAdvanceActionableDefaultsOverride ?? autoAdvanceActionableDefaults();
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
        // tiny brick values at runtime so the room does not fall back to a
        // stale 1-second wall-clock cap.
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
        if (this.latchUnconfirmedNativeTermination(result, "Claude auth-status probe", "claude")) {
          this.claudeAuthStatus = undefined;
          return undefined;
        }
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
    const monthSpendUsd = await this.currentClaudeCreditMonthSpend();
    return evaluateClaudeAutomationGuard({
      mode,
      capUsd: claudeAgentCreditCapUsd(),
      monthSpendUsd,
      pendingReservationUsd: this.claudeCreditReservedUsd,
      status,
      manyHeads,
    });
  }

  private async currentClaudeCreditMonthSpend(now = new Date()): Promise<number> {
    const monthKey = usageCalendarMonthKey(now);
    if (monthKey === this.claudeCreditMonthKey) return this.claudeCreditMonthSpendUsd;
    // A room may stay open across a UTC month boundary. Re-seed from the full
    // ledger before its first dispatch in the new month, then resume the
    // incremental fold. Reset the one-shot warning for the new credit period.
    this.claudeCreditMonthSpendUsd = await loadClaudeAutomationSpendThisMonth(this.usageUri.fsPath, now);
    this.claudeCreditMonthKey = monthKey;
    this.claudeCreditWarned = false;
    return this.claudeCreditMonthSpendUsd;
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
    if (agent && use === "room" && agentInitiatedDuels()) {
      // Ratings are a visible motivation signal only. No decision, phase,
      // authority, or builder-selection path reads this block.
      sections.push("", renderDuelMotivationContext(agent, this.duels.ratings, displayNameFor));
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

  /** Persist one room message and mirror an automatic transcript rotation in
   * the live panel. Reloading the new active file avoids assuming that another
   * window or a manual edit left disk records aligned with the UI prefix. */
  private async persistTranscriptMessage(message: TranscriptMessage): Promise<void> {
    const archived = await appendMessage(this.transcriptUri.fsPath, message);
    if (!archived) return;

    const previous = [...this.messages];
    const candidates = new Map<string, UiMessage[]>();
    for (const item of previous) {
      if (item.pending) continue;
      const key = transcriptMessageIdentity(item);
      const matches = candidates.get(key) ?? [];
      matches.push(item);
      candidates.set(key, matches);
    }
    const active = await readTranscript(this.transcriptUri.fsPath);
    const restored = active.map((item, index): UiMessage => {
      const matches = candidates.get(transcriptMessageIdentity(item));
      const existing = matches?.shift();
      return existing ?? { ...item, id: `active-${Date.now()}-${index}` };
    });
    const pending = previous.filter((item) => item.pending);
    for (const item of pending) {
      const itemTime = Date.parse(item.timestamp);
      const insertAt = restored.findIndex((activeItem) => {
        const activeTime = Date.parse(activeItem.timestamp);
        return Number.isFinite(itemTime) && Number.isFinite(activeTime) && activeTime > itemTime;
      });
      if (insertAt >= 0) restored.splice(insertAt, 0, item);
      else restored.push(item);
    }
    this.setMessages(restored);
    this.lastWikiWrapupSourceKey = undefined;
    this.lastWikiRefreshTranscriptBucket = 0;
    const archiveDetail = archived.archivedMessages === undefined
      ? "Hydra auto-archived transcript history; the exact message count exceeded the bounded read window."
      : `Hydra auto-archived ${archived.archivedMessages} transcript message(s).`;
    await this.recordEvent("diagnostic", archiveDetail, {
      archiveFile: path.basename(archived.archivePath),
      archivedBytes: archived.archivedBytes,
      ...(archived.archivedMessages === undefined ? {} : { archivedMessages: archived.archivedMessages }),
    });
    this.postState();
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

  private bindPendingAgentDuelContext(
    messageId: string,
    opponentId: AgentId,
    opponentMessageId: string,
    duelProtocolExpected: boolean,
  ): void {
    const opponentMessage = this.messagesById.get(opponentMessageId);
    if (
      !opponentMessage
      || opponentMessage.role !== opponentId
      || opponentMessage.pending
      || opponentMessage.error
      || opponentMessage.cancelled
    ) {
      return;
    }
    const latestUserMessage = [...this.messages]
      .reverse()
      .find((message) => message.role === "user" && Date.parse(message.timestamp) <= Date.parse(opponentMessage.timestamp));
    this.pendingAgentDuelContexts.set(messageId, {
      duelProtocolExpected,
      opponentId,
      opponentMessageId,
      opponentMessageTimestamp: opponentMessage.timestamp,
      opponentMessageText: opponentMessage.text,
      ...(latestUserMessage ? { latestUserMessage: latestUserMessage.text } : {}),
    });
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
        agentLabel: displayNameFor(agent),
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
    const duelContext = this.pendingAgentDuelContexts.get(messageId);
    this.pendingAgentDuelContexts.delete(messageId);
    const sourceTraceId = this.pendingAgentTraceIds.get(messageId);
    this.pendingAgentTraceIds.delete(messageId);
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
    if (result.terminationFailed) {
      m.error = true;
      if (m.text.length > 0 && !m.text.endsWith("\n")) m.text += "\n";
      m.text += `[process termination unconfirmed]\n${this.unconfirmedTerminationMessage()}`;
      if (result.stderr && !m.text.includes(result.stderr)) m.text += `\n${result.stderr}`;
    } else if (result.cancelled || timedOutDiscussion) {
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
    let agentDuelRequest: PendingAgentDuelRequest | undefined;
    let agentDuelProtocolError: string | undefined;
    if (
      duelContext
      && isAgentMessageRole(m.role)
      && (m.phase === "reactor" || m.phase === "closer")
      && !m.error
      && !m.cancelled
    ) {
      const rawAgentReplyText = m.text;
      const parsed = parseAgentDuelIntent(m.text, duelContext.opponentId);
      if (parsed.kind !== "none") {
        m.text = parsed.cleanedText;
        this.panel.webview.postMessage({ type: "replaceMessageText", messageId, text: m.text });
      }
      if (parsed.kind === "invalid") {
        agentDuelProtocolError = parsed.error;
      } else if (parsed.kind === "challenge") {
        if (!sourceTraceId) {
          agentDuelProtocolError = "Hydra could not bind the challenge to its originating agent-call trace.";
        } else {
          agentDuelRequest = {
            challengerId: m.role,
            sourceTraceId,
            sourceMessageTimestamp: m.timestamp,
            // Bind admission to the exact head output including its stripped
            // machine control line. The completed trace stores the same raw
            // stdout digest while the visible transcript remains clean.
            sourceMessageText: rawAgentReplyText,
            context: duelContext,
            intent: parsed.intent,
          };
        }
      } else if (
        duelContext.duelProtocolExpected
        && hasReservedAgentDuelChallengePrefix(m.text)
        && parseDecisionPacket(m.text, {
          agent: m.role,
          phase: m.phase,
          sourceMessageTimestamp: m.timestamp,
        })
      ) {
        agentDuelProtocolError = "the reply used the reserved `Challenge:` prefix but omitted the required HYDRA_DUEL_CHALLENGE_V1 control record; use `Amend:` for ordinary disagreement.";
      }
    }
    if (m.text.trim() === "") m.text = "[no output]";
    if (isAgentMessageRole(m.role)) {
      this.setAgentStatus(
        m.role,
        m.error || m.cancelled ? "error" : "replied",
        m.cancelled ? `${m.phase ?? "turn"} cancelled` : m.error ? `${m.phase ?? "turn"} error` : `${m.phase ?? "turn"} replied`
      );
    }
    await this.captureDecisionPacket(m);
    await this.refreshWorkspaceChanges();
    await this.persistTranscriptMessage({
      role: m.role,
      text: m.text,
      timestamp: m.timestamp,
      phase: m.phase,
      error: m.error,
      cancelled: m.cancelled,
    });
    await this.recordWikiUsageTelemetry(m, promptTranscriptWindow);
    this.pendingPromptTranscriptWindows.delete(messageId);
    if (agentDuelProtocolError) {
      await this.appendSystemMessage(
        `${displayNameFor(m.role as AgentId)} duel request rejected: ${agentDuelProtocolError} No duel or Elo change occurred.`,
      );
    } else if (agentDuelRequest) {
      this.enqueueAgentDuelAdmission(agentDuelRequest);
    }
  }

  private async recordWikiUsageTelemetry(
    message: UiMessage,
    promptTranscriptWindow?: PromptTranscriptWindowStats
  ): Promise<void> {
    if (!this.workspaceReady) return;
    if (!isAgentMessageRole(message.role)) return;
    if (message.error || message.cancelled) return;
    const wikiContext = readHydraWikiPromptContext(this.workspaceRoot, wikiContextMaxChars(), {
      includeLog: wikiPromptIncludeLog(),
    });
    if (!wikiContext) return;

    const telemetry = summarizeHydraWikiUsage(message.text);
    await this.recordEvent(
      "diagnostic",
      `Hydra wiki usage telemetry: ${displayNameFor(message.role)} ${message.phase ?? "turn"} reply ${telemetry.hasCitationSignal ? "cited wiki sources" : telemetry.hasMentionSignal ? "mentioned wiki memory" : "had no wiki usage signal"}.`,
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
    if (!isAgentMessageRole(message.role)) return;
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
    const id = `u-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
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
    try {
      await this.persistTranscriptMessage({
        role: "user",
        text,
        timestamp: msg.timestamp,
      });
    } catch (err) {
      this.setMessages(this.messages.filter((candidate) => candidate !== msg));
      this.postState();
      throw err;
    }
    this.postState();
    return msg;
  }

  private appendSystemMessageToUi(text: string): UiMessage {
    const id = `s-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
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
    try {
      await this.persistTranscriptMessage({
        role: "system",
        text,
        timestamp: msg.timestamp,
      });
    } catch (err) {
      this.setMessages(this.messages.filter((candidate) => candidate !== msg));
      this.postState();
      throw err;
    }
  }

  private async appendRequiredDuelReceipt(record: Record<string, unknown>): Promise<void> {
    const filePath = this.agentCallsUri.fsPath;
    await serializePerFile(filePath, async () => {
      if (!ensuredAgentCallDirs.has(filePath)) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        ensuredAgentCallDirs.add(filePath);
      }
      await appendFileSafely(filePath, `${JSON.stringify(record)}\n`);
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
          await this.sendUserMessage(msg.text, normalizeAgentId(msg.opener, this.getFirstSpeaker(), this.roster()), { consumePendingAttachments: true });
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
          await this.assignBuilder(normalizeAgentId(msg.builder, this.getFirstSpeaker(), this.roster()));
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
        case "openBrowser":
          await this.openBrowser();
          break;
        case "toggleBrowserControl":
          await this.toggleBrowserControl();
          break;
        case "previewNextPrompt":
          await this.previewNextPrompt(msg.text ?? "", normalizeAgentId(msg.opener, this.getFirstSpeaker(), this.roster()));
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
        case "openStandings":
          await this.openStandings();
          break;
        case "openScoreEvidence":
          await this.openScoreEvidence();
          break;
        case "recordScoreVerdict":
          await this.recordScoreVerdict();
          break;
        case "reverseScoreVerdict":
          await this.reverseScoreVerdict();
          break;
        case "adjudicatePendingScoreClaim":
          await this.adjudicatePendingScoreClaim();
          break;
        case "openDuels":
          await this.openDuelsPanel();
          break;
        case "advanceDuel":
          await this.advanceDuel(String(msg.duelId ?? ""));
          break;
        case "cancelDuel":
          await this.cancelDuel(String(msg.duelId ?? ""));
          break;
        case "openDuelAudit":
          await this.openDuelAudit();
          break;
        case "correctDuelResult":
          await this.correctDuelResult();
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
            normalizeAgentId(msg.agent, this.getFirstSpeaker(), this.roster()),
            msg.text ?? "",
            {
              includeEditorContext: !!msg.includeEditorContext,
              includeWorkspaceDiff: !!msg.includeWorkspaceDiff,
            }
          );
          break;
        case "runNativeCommand":
          await this.runNativeCliCommand(
            normalizeAgentId(msg.agent, this.getFirstSpeaker(), this.roster()),
            msg.text ?? ""
          );
          break;
        case "sendRawTerminalLine":
          await this.sendRawTerminalLine(
            normalizeAgentId(msg.agent, this.getFirstSpeaker(), this.roster()),
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
    if (this.disposed) return;
    const workQueue = this.workspaceReady ? this.currentWorkQueue() : [];
    const automationReady = this.workspaceReady && !this.unconfirmedNativeTermination;
    const duelCommitmentBusy = this.agentDuelAutomationRunning || !!this.duelCommitmentAbort;
    const duelAutomationBusy = this.agentDuelAdmissionRunning || duelCommitmentBusy;
    const canStop =
      isInFlight(this.state) ||
      this.terminalPokeInFlight ||
      this.verificationRunning ||
      this.autopilotRunning ||
      duelCommitmentBusy;
    const authoritySummaries = this.workspaceReady
      ? this.currentAuthoritySummaries()
      : unavailableAuthoritySummaries(this.roster());
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
        canSend: automationReady && !this.terminalPokeInFlight && (isSendable(this.state) || isInFlight(this.state)),
        canStop,
        unconfirmedNativeTermination: this.unconfirmedNativeTermination,
        queuedUserMessageCount: this.queuedUserMessages.length,
        canPokeNativeTerminals: automationReady && !isInFlight(this.state) && !this.terminalPokeInFlight && !duelAutomationBusy,
        canClearNativeActions: this.workspaceReady && !this.terminalPokeInFlight,
        canAssignBuilder: automationReady && this.state.name === "AwaitingUser",
        canRequestReview: automationReady && (this.state.name === "BuildDone" || this.state.name === "ParallelBuildDone") && this.gitAvailable,
        canRunVerification: automationReady && !isInFlight(this.state) && !this.terminalPokeInFlight && !this.verificationRunning && !duelAutomationBusy,
        canRunWikiWrapup: this.canRunManualWikiWrapup(),
        canPreviewPrompt: automationReady && !isInFlight(this.state) && !this.terminalPokeInFlight && !duelAutomationBusy,
        canArchiveRoom: this.workspaceReady && !canStop && !duelAutomationBusy,
        canAttachFiles: automationReady && !isInFlight(this.state) && !this.terminalPokeInFlight,
        pendingAttachments: this.pendingAttachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          relativePath: attachment.relativePath,
          sizeBytes: attachment.sizeBytes,
          binary: attachment.binary,
          previewChars: attachment.previewText?.length ?? 0,
        })),
        canHandBack: automationReady && (this.state.name === "ReviewDone" || this.state.name === "ParallelReviewDone") && !this.state.approved,
        canOpenFolder: !this.workspaceReady,
        suggestedBuilder: this.state.name === "AwaitingUser" ? this.suggestedBuilder : undefined,
        firstSpeaker: this.getFirstSpeaker(),
        transport: this.transportMode(),
        objective: this.objective,
        roster: this.roster().map((id) => {
          const definition = getAgentDefinition(id);
          return { id, displayName: definition?.displayName ?? id, colorIndex: definition?.colorIndex };
        }),
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
          enabled: this.effectiveManyHeadsMode(),
          claudeWorkerCount: manyHeadsClaudeWorkerCount(),
        },
        latestDecision,
        latestDecisionAccepted,
        latestDecisionRisky: latestDecisionAccepted ? { risky: false, reasons: [] } : detectRiskySignals(latestDecision),
        recentDecisions: this.decisions.slice(-5).reverse(),
        decisionsCount: this.decisions.length,
        standings: {
          eventCount: this.scoreboard.eventCount,
          error: this.scoreboardError,
          mirrorError: this.scoreboardMirrorError,
          overall: this.scoreboard.overallStandings,
          byDomain: this.scoreboard.standings,
        },
        duels: {
          agentInitiatedEnabled: agentInitiatedDuels(),
          automationRunning: this.agentDuelAdmissionRunning || this.agentDuelAutomationRunning,
          automationQueued: this.agentDuelAdmissionQueue.length + this.agentDuelAutomationQueue.length,
          eventCount: this.duels.eventCount,
          error: this.duelError,
          mirrorError: this.duelMirrorError,
          activeTotal: this.duels.activeDuels.length,
          ratingsTotal: this.duels.ratings.length,
          recentTotal: this.duels.recentDuels.length,
          ratedDuelCount: Math.floor(this.duels.ratings.reduce((total, rating) => total + rating.ratedMatches, 0) / 2),
          active: this.duels.activeDuels.slice(0, 50),
          ratings: this.duels.ratings.slice(0, 200),
          recent: this.duels.recentDuels.slice(0, 20),
        },
        decisionAction: this.currentDecisionAction(),
        canAcceptDefault: automationReady && !isInFlight(this.state) && !this.terminalPokeInFlight && this.currentDecisionAction().kind !== "none",
        autoAdvanceActionableDefaults: this.effectiveAutoAdvanceActionableDefaults(),
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
    if (!this.workspaceReady || this.unconfirmedNativeTermination || isInFlight(this.state) || this.terminalPokeInFlight || this.verificationRunning || this.autopilotRunning || this.wikiWrapupInFlight) {
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
    const roster = this.roster();
    const configured = vscode.workspace
      .getConfiguration("hydraRoom")
      .get<string>("firstSpeaker", "codex");
    return normalizeAgentId(configured, roster[0] ?? "codex", roster);
  }

  private oneShotArtifactRoot(): string {
    return path.join(this.workspacePrivateStorageRoot(), "one-shot");
  }

  private workspacePrivateStorageRoot(): string {
    return this.context.storageUri?.fsPath ?? path.join(
      this.context.globalStorageUri.fsPath,
      "workspaces",
      crypto.createHash("sha256").update(this.workspaceRoot).digest("hex").slice(0, 24),
    );
  }

  private latchUnconfirmedNativeTermination(
    result: { terminationFailed?: boolean },
    context: string,
    agent?: AgentId
  ): boolean {
    if (!result.terminationFailed) return false;
    if (!this.unconfirmedNativeTermination) {
      this.unconfirmedNativeTermination = true;
      if (agent) this.setAgentStatus(agent, "error", "Process termination unconfirmed");
      void this.recordEvent(
        "error",
        `Native process termination was not confirmed during ${context}; Hydra automation is blocked until VS Code restarts.`
      );
    }
    this.postState();
    return true;
  }

  private unconfirmedTerminationMessage(): string {
    return "Hydra blocked new automation because a previous native process did not confirm that it exited. Restart VS Code before continuing.";
  }

  private async prepareOneShotArtifactBoundary(artifactRoot: string): Promise<PrivateArtifactBoundary> {
    try {
      return await preparePrivateArtifactRoot(
        this.workspaceRoot,
        artifactRoot,
        ["prompts", "replies", "logs"]
      );
    } catch {
      // This message can be copied into .hydra/agent-calls.jsonl and a failure
      // card. Do not include an ExtensionContext storage path in it.
      throw new Error("Hydra could not prepare private one-shot request storage.");
    }
  }

  private createTerminalBridge(): TerminalBridge {
    const workspaceStorageRoot = this.workspacePrivateStorageRoot();
    return new TerminalBridge(this.workspaceRoot, {
      artifactRoot: path.join(workspaceStorageRoot, "terminal-bridge"),
      onSessionUpdate: () => this.postState(),
    });
  }
}

// ---------------- pure helpers ----------------

function transcriptMessageIdentity(message: Pick<UiMessage, "role" | "text" | "timestamp" | "phase" | "error" | "cancelled">): string {
  return JSON.stringify([
    message.role,
    message.text,
    message.timestamp,
    message.phase ?? null,
    !!message.error,
    !!message.cancelled,
  ]);
}

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
    case "Opener": return `Discussion - ${displayNameFor(state.opener)} opening`;
    case "Reactor": return `Discussion - ${displayNameFor(state.reactor)} reacting`;
    case "Closer": return `Discussion - ${displayNameFor(state.opener)} closing`;
    case "ParallelDiscussion": return `Discussion - ${state.agents.map(displayNameFor).join(" + ")} running in parallel`;
    case "AwaitingUser": return "Awaiting your reply";
    case "Build": return `Build — ${displayNameFor(state.builder)} is editing`;
    case "ParallelBuild": return `Build — ${state.agents.map(displayNameFor).join(" + ")} editing in parallel`;
    case "BuildDone": return `Build done — request review`;
    case "ParallelBuildDone": return "Parallel build done — request review";
    case "Review": return `Review — ${displayNameFor(state.reviewer)} is reading the diff`;
    case "ParallelReview": return `Review — ${state.agents.map(displayNameFor).join(" + ")} reading the diff`;
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

function normalizeAgentId(value: unknown, fallback: AgentId, allowed: ReadonlyArray<AgentId> = DEFAULT_ROSTER): AgentId {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
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
    "--- Claude Worker Fanout live channel ---",
    "Claude Worker Fanout is on. Parallel structured streams are mirrored to these files while the Claude workers run:",
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
  transport: "oneShot" | "terminalBridge" | "http",
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
    terminationFailed: result.terminationFailed ?? false,
    timeoutMs: result.timeoutMs,
    stdoutChars: result.stdout.length,
    stdoutSha256: sha256(result.stdout),
    stderrChars: result.stderr.length,
    stderrPreview: result.stderr ? truncateForTrace(result.stderr, 1200) : undefined,
  };
}

function truncateForTrace(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function boundedRuntimeDuelReason(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return "Hydra's duel-integrity policy stopped the autonomous comparison.";
  return normalized.length <= 1_900 ? normalized : `${normalized.slice(0, 1_899).trimEnd()}…`;
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
    description: description ?? (agents.length === 2 ? "Codex + Claude" : agents[0] ? displayNameFor(agents[0]) : ""),
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
  return !!result.terminationFailed || result.cancelled || result.timedOut || result.exitCode !== 0;
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
      `${displayNameFor(session.agent)}: ${session.state}`,
      `Detail: ${session.detail}`,
      `Command: ${session.currentCommand ?? "none"}`,
      `Phase: ${session.currentPhase ?? "none"}`,
      `Last activity: ${session.lastActivityAt ?? "none"}`,
      `Prompt: ${session.lastPromptPath ? `[private extension storage]/${path.basename(session.lastPromptPath)}` : "none"}`,
      `Reply: ${session.lastReplyPath ? `[private extension storage]/${path.basename(session.lastReplyPath)}` : "none"}`,
      `Log: ${session.lastLogPath ? `[private extension storage]/${path.basename(session.lastLogPath)}` : "none"}`,
      `Error: ${session.lastError ?? "none"}`
    );
  }
  return lines.join("\n");
}

function formatEffectiveAuthority(summaries: Record<AgentId, AgentAuthoritySummary>): string {
  const lines = ["Effective Native CLI Authority"];
  for (const agent of ["codex", "claude"] as AgentId[]) {
    const summary = summaries[agent];
    // Why: summaries is keyed by the now-widened AgentId; the loop above only
    // ever iterates the two built-in ids, so this is unreachable today.
    if (!summary) continue;
    lines.push(
      "",
      `${displayNameFor(agent)}: ${summary.authority.label}`,
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

function unavailableAuthoritySummaries(roster: ReadonlyArray<AgentId> = DEFAULT_ROSTER): Record<AgentId, AgentAuthoritySummary> {
  return Object.fromEntries(roster.map((agent) => [agent, unavailableAuthoritySummary(agent)]));
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
      detail: `${displayNameFor(agent)} CLI authority is unavailable until a workspace folder is open.`,
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
  const tracked = await runGit(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD"]);
  if (!tracked || tracked.code !== 0) return null;

  const untracked = await runGit(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (!untracked || untracked.code !== 0) return null;

  const lines: string[] = [];
  appendLimitedLines(lines, tracked.out, maxLines);
  const files = untracked.out.split(/\r?\n/).filter((line) => line.length > 0);
  for (const file of files) {
    if (lines.length >= maxLines) break;
    const diff = await synthesizeUntrackedFileDiff(cwd, file, maxLines - lines.length);
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
  // Defense in depth for every panel Git caller. Repository-local config can
  // turn nominally read-only commands into native execution (core.fsmonitor,
  // textconv, external diff), so trust must be checked immediately before the
  // executable is resolved/spawned rather than only during panel startup.
  if (!workspaceGitExecutionAllowed()) return null;
  const gitExecutable = await resolveGitExecutable(cwd);
  if (!gitExecutable) return null;
  return new Promise((resolve) => {
    const child = cp.spawn(gitExecutable, args, { cwd, windowsHide: true });
    let out = "";
    let truncated = false;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, 30_000);
    const finish = (value: { code: number | null; out: string } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout.on("data", (b: Buffer) => {
      if (truncated) return;
      const chunk = b.toString("utf8");
      const remaining = MAX_GIT_OUTPUT_CHARS - out.length;
      if (chunk.length <= remaining) {
        out += chunk;
        return;
      }
      out += `${chunk.slice(0, Math.max(0, remaining))}\n[... git output truncated ...]\n`;
      truncated = true;
    });
    // Always drain stderr. Leaving the pipe unread can block Git once its
    // kernel buffer fills, even though Hydra does not surface this stream.
    child.stderr?.resume();
    child.on("error", () => finish(null));
    child.on("close", (code) => finish({ code, out }));
  });
}

const MAX_GIT_OUTPUT_CHARS = 8 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;

export async function synthesizeUntrackedFileDiff(
  cwd: string,
  relativeFile: string,
  remainingLines = 2_000,
): Promise<string> {
  const gitPath = relativeFile.replace(/\\/g, "/");
  const logicalWorkspaceRoot = path.resolve(cwd);
  const workspaceRoot = await fs.realpath(logicalWorkspaceRoot).catch(() => logicalWorkspaceRoot);
  const absolute = path.resolve(logicalWorkspaceRoot, relativeFile);
  if (!isPathInsideRoot(absolute, logicalWorkspaceRoot)) {
    return omittedUntrackedDiff(gitPath, "path escapes the workspace");
  }

  let handle: fs.FileHandle | undefined;
  try {
    const before = await fs.lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      return omittedUntrackedDiff(gitPath, "links and non-regular files are not read");
    }
    const realFile = await fs.realpath(absolute);
    if (!isPathInsideRoot(realFile, workspaceRoot)) {
      return omittedUntrackedDiff(gitPath, "resolved path escapes the workspace");
    }

    handle = await fs.open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      return omittedUntrackedDiff(gitPath, "file changed while it was being inspected");
    }
    const currentRealFile = await fs.realpath(absolute);
    if (!isPathInsideRoot(currentRealFile, workspaceRoot) || currentRealFile !== realFile) {
      return omittedUntrackedDiff(gitPath, "file changed or escaped while it was being inspected");
    }
    const maxBytes = Math.min(
      MAX_UNTRACKED_FILE_BYTES,
      Math.max(64 * 1024, Math.max(1, remainingLines) * 4_096),
    );
    const readBuffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(readBuffer, 0, readBuffer.length, 0);
    const truncated = bytesRead > maxBytes;
    const buffer = readBuffer.subarray(0, Math.min(bytesRead, maxBytes));

    if (buffer.includes(0)) {
      return omittedUntrackedDiff(gitPath, "binary file omitted from review prompt");
    }

    const text = `${buffer.toString("utf8")}${truncated ? "\n[... untracked file truncated ...]" : ""}`;
    const body = text.split(/\r?\n/).map((line) => `+${line}`).join("\n");
    return `diff --git a/${gitPath} b/${gitPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${gitPath}\n@@\n${body}`;
  } catch {
    return omittedUntrackedDiff(gitPath, "file could not be read safely");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function omittedUntrackedDiff(gitPath: string, reason: string): string {
  return `diff --git a/${gitPath} b/${gitPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${gitPath}\n@@\n+[Hydra omitted untracked file: ${reason}]`;
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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
  if (!workspaceGitExecutionAllowed()) return false;
  const gitExecutable = await resolveGitExecutable(cwd);
  if (!gitExecutable) return false;
  return new Promise<boolean>((resolve) => {
    const child = cp.spawn(gitExecutable, ["rev-parse", "--is-inside-work-tree"], { cwd, windowsHide: true });
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
