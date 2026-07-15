import * as path from "node:path";
import type { AuthorityClassification } from "./authority";
import type { CapabilityProfile } from "./capabilityProfiles";
import type { DecisionPacket } from "./decisions";
import type { DoctorReport } from "./doctor";
import type { HydraEvent } from "./events";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";
import type { NativeActionReceipt } from "./nativeActions";
import type { NativeDataSnapshot } from "./nativeDataSnapshot";
import type { TerminalSession } from "./sessionState";
import { atomicWriteFile } from "./fileQueue";
import type { VerificationResult } from "./verification";
import { verificationPassed, verificationSummary } from "./verification";
import type { WorkQueueItem } from "./workQueue";
import { displayNameFor } from "./agentRegistry";

export interface SupportBundleMessage {
  role: "user" | AgentId | "system";
  phase?: Phase;
  text: string;
  timestamp: string;
  error?: boolean;
  cancelled?: boolean;
}

export interface SupportBundleAuthority {
  authority: AuthorityClassification;
  profile: CapabilityProfile;
}

export interface SupportBundleNativeRuntime {
  agent: AgentId;
  phase: Phase;
  command: string;
  args: string[];
  cwd: string;
  envKeys: string[];
  pathOverride: boolean;
}

export interface SupportBundleNativeDataSummary {
  codexTrustedWorkspace: boolean;
  codexModelCount: number;
  codexModels: string[];
  codexSearchModels: string[];
  codexImageModels: string[];
  codexParallelToolModels: string[];
  codexVerbosityModels: string[];
  codexApplyPatchModels: string[];
  codexServiceTierModels: string[];
  codexEnabledPlugins: string[];
  codexSkillNames: string[];
  codexSessionCount: number;
  codexStateTables: string[];
  claudeEnabledPlugins: string[];
  claudeInstalledPlugins: string[];
  claudeMarketplaces: string[];
  claudeMcpServerNames: string[];
  claudeSkillNames: string[];
  claudeCommandNames: string[];
  claudeLiveSessionCount: number;
  claudeProjectCount: number;
  claudeProjectTranscriptCount: number;
  claudeProjectSummaries: string[];
}

export interface SupportBundleInput {
  generatedAt: string;
  workspaceRoot: string;
  phaseLabel: string;
  transport: "oneShot" | "terminalBridge";
  doctorReport?: DoctorReport;
  authoritySummaries: Record<AgentId, SupportBundleAuthority>;
  nativeRuntime?: SupportBundleNativeRuntime[];
  nativeData?: SupportBundleNativeDataSummary;
  terminalSessions: TerminalSession[];
  latestDecision?: DecisionPacket;
  latestVerification?: VerificationResult;
  workQueue: WorkQueueItem[];
  recentNativeActions: NativeActionReceipt[];
  recentEvents?: HydraEvent[];
  recentMessages: SupportBundleMessage[];
}

export function supportBundlePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".hydra", "support-bundle.md");
}

export async function writeSupportBundle(filePath: string, markdown: string): Promise<void> {
  await atomicWriteFile(filePath, markdown);
}

export function renderSupportBundle(input: SupportBundleInput): string {
  const lines: string[] = [
    "# Hydra Support Bundle",
    "",
    `Generated: ${input.generatedAt}`,
    `Workspace: ${input.workspaceRoot}`,
    `Phase: ${input.phaseLabel}`,
    `Transport: ${input.transport}`,
    "",
    "## Doctor",
    "",
    ...renderDoctor(input.doctorReport),
    "",
    "## Native Authority",
    "",
    ...renderAuthority(input.authoritySummaries),
    "",
    "## Native Runtime",
    "",
    ...renderNativeRuntime(input.nativeRuntime ?? []),
    "",
    "## Native Data",
    "",
    ...renderNativeData(input.nativeData),
    "",
    "## Terminal Sessions",
    "",
    ...renderTerminalSessions(input.terminalSessions),
    "",
    "## Work Queue",
    "",
    ...renderWorkQueue(input.workQueue),
    "",
    "## Latest Decision",
    "",
    ...renderDecision(input.latestDecision),
    "",
    "## Latest Verification",
    "",
    ...renderVerification(input.latestVerification),
    "",
    "## Recent Native Actions",
    "",
    ...renderNativeActions(input.recentNativeActions),
    "",
    "## Recent Events",
    "",
    ...renderEvents(input.recentEvents ?? []),
    "",
    "## Recent Messages",
    "",
    ...renderMessages(input.recentMessages),
    "",
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

export function supportBundleNativeDataSummary(snapshot: NativeDataSnapshot): SupportBundleNativeDataSummary {
  return {
    codexTrustedWorkspace: snapshot.codex.trustedWorkspace,
    codexModelCount: snapshot.codex.modelCatalog.count,
    codexModels: snapshot.codex.modelCatalog.models.map((model) => model.slug),
    codexSearchModels: snapshot.codex.modelCatalog.models.filter((model) => model.supportsSearch).map((model) => model.slug),
    codexImageModels: snapshot.codex.modelCatalog.models.filter((model) => model.supportsImages).map((model) => model.slug),
    codexParallelToolModels: snapshot.codex.modelCatalog.models.filter((model) => model.supportsParallelTools).map((model) => model.slug),
    codexVerbosityModels: snapshot.codex.modelCatalog.models.filter((model) => model.supportsVerbosity).map((model) => model.slug),
    codexApplyPatchModels: snapshot.codex.modelCatalog.models.filter((model) => model.applyPatchToolType).map((model) => `${model.slug}:${model.applyPatchToolType}`),
    codexServiceTierModels: snapshot.codex.modelCatalog.models.flatMap((model) => model.serviceTiers.map((tier) => `${model.slug}:${tier}`)),
    codexEnabledPlugins: snapshot.codex.enabledPlugins,
    codexSkillNames: snapshot.codex.skillNames,
    codexSessionCount: snapshot.codex.sessionCount,
    codexStateTables: snapshot.codex.stateTables.map((table) => `${table.name}(${table.rows ?? "?"})`),
    claudeEnabledPlugins: snapshot.claude.enabledPlugins,
    claudeInstalledPlugins: snapshot.claude.installedPlugins,
    claudeMarketplaces: snapshot.claude.marketplaces,
    claudeMcpServerNames: snapshot.claude.mcpServerNames,
    claudeSkillNames: snapshot.claude.skillNames,
    claudeCommandNames: snapshot.claude.commandNames,
    claudeLiveSessionCount: snapshot.claude.liveSessions.length,
    claudeProjectCount: snapshot.claude.projectCount,
    claudeProjectTranscriptCount: snapshot.claude.projectTranscriptCount,
    claudeProjectSummaries: snapshot.claude.projectSummaries.map((project) =>
      `${project.project}: transcripts=${project.transcriptCount}, subagents=${project.subagentTranscriptCount}, meta=${project.subagentMetaCount}, types=${project.subagentTypes.join("|") || "none"}`
    ),
  };
}

function renderDoctor(report: DoctorReport | undefined): string[] {
  if (!report) return ["Doctor has not run in this session."];
  return [
    `Summary: ${report.summary}`,
    `Created: ${report.createdAt}`,
    ...report.checks.map((check) => `- ${check.status.toUpperCase()}: ${check.label} - ${singleLine(check.detail)}`),
  ];
}

function renderAuthority(summaries: Record<AgentId, SupportBundleAuthority>): string[] {
  return (["codex", "claude"] as AgentId[]).flatMap((agent) => {
    const summary = summaries[agent];
    if (!summary) {
      return [`### ${labelAgent(agent)}`, "", "Not initialized.", ""];
    }
    return [
      `### ${labelAgent(agent)}`,
      "",
      `Authority: ${summary.authority.label}`,
      `Authority detail: ${singleLine(summary.authority.detail)}`,
      `Profile: ${summary.profile.label}`,
      `Profile detail: ${singleLine(summary.profile.detail)}`,
      `Warnings: ${summary.authority.warnings.length ? singleLine(summary.authority.warnings.join(" ")) : "none"}`,
      "",
    ];
  }).filter((line, index, lines) => line !== "" || lines[index - 1] !== "");
}

function renderNativeRuntime(items: SupportBundleNativeRuntime[]): string[] {
  if (items.length === 0) return ["No native runtime diagnostics captured yet."];
  return items.flatMap((item) => [
    `### ${labelAgent(item.agent)} ${item.phase}`,
    "",
    `Command: ${singleLine(item.command)}`,
    `CWD: ${singleLine(item.cwd)}`,
    `Args: ${item.args.length ? item.args.map(singleLine).join(" ") : "none"}`,
    `Env keys: ${item.envKeys.length ? item.envKeys.map(singleLine).join(", ") : "none"}`,
    `PATH override: ${item.pathOverride ? "yes" : "no"}`,
    "",
  ]).filter((line, index, lines) => line !== "" || lines[index - 1] !== "");
}

function renderNativeData(summary: SupportBundleNativeDataSummary | undefined): string[] {
  if (!summary) return ["No native data snapshot captured for this bundle."];
  return [
    "### Codex",
    "",
    `Trusted workspace: ${summary.codexTrustedWorkspace ? "yes" : "no"}`,
    `Models: ${summary.codexModelCount}${summary.codexModels.length ? ` (${summary.codexModels.map(singleLine).join(", ")})` : ""}`,
    `Search-capable models: ${summary.codexSearchModels.length ? summary.codexSearchModels.map(singleLine).join(", ") : "none"}`,
    `Image-capable models: ${summary.codexImageModels.length ? summary.codexImageModels.map(singleLine).join(", ") : "none"}`,
    `Parallel-tool models: ${summary.codexParallelToolModels.length ? summary.codexParallelToolModels.map(singleLine).join(", ") : "none"}`,
    `Verbosity models: ${summary.codexVerbosityModels.length ? summary.codexVerbosityModels.map(singleLine).join(", ") : "none"}`,
    `Apply-patch modes: ${summary.codexApplyPatchModels.length ? summary.codexApplyPatchModels.map(singleLine).join(", ") : "none"}`,
    `Service tiers: ${summary.codexServiceTierModels.length ? summary.codexServiceTierModels.map(singleLine).join(", ") : "none"}`,
    `Enabled plugins: ${summary.codexEnabledPlugins.length ? summary.codexEnabledPlugins.map(singleLine).join(", ") : "none"}`,
    `Skills: ${summary.codexSkillNames.length ? summary.codexSkillNames.map(singleLine).join(", ") : "none"}`,
    `Session files: ${summary.codexSessionCount}`,
    `State tables: ${summary.codexStateTables.length ? summary.codexStateTables.map(singleLine).join(", ") : "none"}`,
    "",
    "### Claude",
    "",
    `Enabled plugins: ${summary.claudeEnabledPlugins.length ? summary.claudeEnabledPlugins.map(singleLine).join(", ") : "none"}`,
    `Installed plugins: ${summary.claudeInstalledPlugins.length ? summary.claudeInstalledPlugins.map(singleLine).join(", ") : "none"}`,
    `Marketplaces: ${summary.claudeMarketplaces.length ? summary.claudeMarketplaces.map(singleLine).join(", ") : "none"}`,
    `MCP servers: ${summary.claudeMcpServerNames.length ? summary.claudeMcpServerNames.map(singleLine).join(", ") : "none"}`,
    `Skills: ${summary.claudeSkillNames.length ? summary.claudeSkillNames.map(singleLine).join(", ") : "none"}`,
    `Commands: ${summary.claudeCommandNames.length ? summary.claudeCommandNames.map(singleLine).join(", ") : "none"}`,
    `Live sessions: ${summary.claudeLiveSessionCount}`,
    `Project roots: ${summary.claudeProjectCount}`,
    `Project transcript files: ${summary.claudeProjectTranscriptCount}`,
    `Project metadata: ${summary.claudeProjectSummaries.length ? summary.claudeProjectSummaries.map(singleLine).join("; ") : "none"}`,
  ];
}

function renderTerminalSessions(sessions: TerminalSession[]): string[] {
  if (sessions.length === 0) return ["No terminal sessions are initialized."];
  // Paths are emitted as basenames only — full paths exposed the OS user
  // and exact repo location, which is identifying info we don't need in
  // a "telemetry-free" diagnostic. lastError and currentCommand pass
  // through singleLine so any token or stack trace embedded in raw stderr
  // gets capped (240 chars) and collapsed onto one line.
  return sessions.flatMap((session) => [
    `### ${labelAgent(session.agent)}`,
    "",
    `State: ${session.state}`,
    `Detail: ${singleLine(session.detail)}`,
    `Command: ${session.currentCommand ? singleLine(session.currentCommand) : "none"}`,
    `Phase: ${session.currentPhase ?? "none"}`,
    `Last activity: ${session.lastActivityAt ?? "none"}`,
    `Prompt: ${pathBasename(session.lastPromptPath)}`,
    `Reply: ${pathBasename(session.lastReplyPath)}`,
    `Log: ${pathBasename(session.lastLogPath)}`,
    `Error: ${session.lastError ? singleLine(session.lastError) : "none"}`,
    "",
  ]);
}

function renderWorkQueue(items: WorkQueueItem[]): string[] {
  if (items.length === 0) return ["Queue clear."];
  return items.map((item) => `- [${item.severity}] ${item.kind}: ${item.title} - ${singleLine(item.detail)}`);
}

function renderDecision(decision: DecisionPacket | undefined): string[] {
  if (!decision) return ["No decision packet captured yet."];
  return [
    `Agent: ${labelAgent(decision.agent)}${decision.phase ? `/${decision.phase}` : ""}`,
    `Timestamp: ${decision.timestamp}`,
    `Default next action: ${singleLine(decision.defaultNextAction) || "none"}`,
    `Decision needed from user: ${singleLine(decision.decisionNeededFromUser) || "none"}`,
    `Blockers: ${singleLine(decision.blockers) || "none"}`,
  ];
}

function renderVerification(result: VerificationResult | undefined): string[] {
  if (!result) return ["No verification run recorded yet."];
  return [
    `Status: ${verificationPassed(result) ? "passed" : "failed"}`,
    `Summary: ${singleLine(verificationSummary(result))}`,
    // singleLine the command — it can contain env-var-substituted secrets
    // if the user's verifyCommand interpolates a token into argv.
    `Command: ${singleLine(result.command)}`,
    `Exit code: ${result.exitCode ?? "none"}`,
    `Timed out: ${result.timedOut}`,
  ];
}

function renderNativeActions(actions: NativeActionReceipt[]): string[] {
  if (actions.length === 0) return ["No native actions recorded yet."];
  return actions.map((action) => {
    const agents = action.agents.map(labelAgent).join(" + ");
    const attachments = [
      action.includeEditorContext ? "editor" : "",
      action.includeWorkspaceDiff ? "diff" : "",
    ].filter(Boolean).join(", ");
    const sessionHints = (action.nativeSessionHints ?? [])
      .map((hint) => `${labelAgent(hint.agent)}:${hint.sessionId ?? hint.pathLabel ?? hint.source}${hint.status ? `/${hint.status}` : ""}`)
      .join(", ");
    return `- ${action.status}: ${agents}${attachments ? ` (${attachments})` : ""}${sessionHints ? ` [sessions: ${singleLine(sessionHints)}]` : ""} - ${singleLine(action.instruction)}`;
  });
}

function renderEvents(events: HydraEvent[]): string[] {
  if (events.length === 0) return ["No local events recorded yet."];
  return events.map((event) => {
    const tags = [
      event.agent ? labelAgent(event.agent) : "",
      event.phase ?? "",
    ].filter(Boolean).join("/");
    const data = event.data ? renderEventData(event.data) : "";
    return `- ${event.timestamp} ${event.kind}${tags ? ` (${tags})` : ""}: ${singleLine(event.detail)}${data ? ` [${data}]` : ""}`;
  });
}

function renderEventData(data: Record<string, string | number | boolean | null>): string {
  return Object.entries(data)
    .map(([key, value]) => `${key}=${singleLine(String(value))}`)
    .join(", ");
}

function renderMessages(messages: SupportBundleMessage[]): string[] {
  if (messages.length === 0) return ["No room messages loaded."];
  return messages.map((message) => {
    const tags = [
      message.phase,
      message.cancelled ? "cancelled" : "",
      message.error ? "error" : "",
    ].filter(Boolean).join(", ");
    return `- ${message.timestamp} ${labelAgent(message.role)}${tags ? ` (${tags})` : ""}: ${singleLine(message.text) || "[empty]"}`;
  });
}

function labelAgent(value: AgentId | "user" | "system"): string {
  if (value === "user") return "You";
  if (value === "system") return "System";
  return displayNameFor(value);
}

function singleLine(value: string): string {
  const compacted = value.trim().replace(/\s+/g, " ");
  return compacted.length > 240 ? `${compacted.slice(0, 237)}...` : compacted;
}

function pathBasename(value: string | undefined): string {
  if (!value) return "none";
  // Strip directory components — full absolute paths leak OS username
  // and repo location into the bundle, which the "telemetry-free"
  // contract precludes.
  const trimmed = value.replace(/[\\/]+$/, "");
  const sep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return sep < 0 ? trimmed : trimmed.slice(sep + 1);
}
