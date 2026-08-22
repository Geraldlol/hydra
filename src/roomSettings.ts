// Thin, pure, read-only configuration getters for the hydraRoom settings
// namespace. These were extracted from the HydraRoomPanel god-object: each one
// just reads vscode.workspace.getConfiguration("hydraRoom"), applies the
// runtime clamp (Number.isFinite + Math.max(min) + Math.floor) that guards
// against hand-edited / out-of-range settings, and returns a value. None of
// them touch panel state, cache into a field, or WRITE config — those stay on
// the class (e.g. migrateLegacyDiscussionTimeoutDefault writes, so it stayed).
//
// Phased readers (per-phase transcript/instruction caps) intentionally stay in
// panel.ts because their helper (promptTranscriptScope) and DEFAULTS constants
// are anchored there by the source contract test; this module covers the
// scalar/boolean/string cluster plus the telegram credential reader.

import * as vscode from "vscode";
import type { Phase } from "./prompts";
import { DEFAULT_ROSTER, type AgentId, type DiscussionMode } from "./phases";
import { isValidAgentId } from "./agentValidation";
import type { TelegramConfig } from "./telegram";
import { CLAUDE_AUTOMATION_GUARD_MODES, type ClaudeAutomationGuardMode } from "./claudeAuth";
import { clampManyHeadsClaudeWorkerCount } from "./claudeWorkers";

function normalizeAgentTimeoutMs(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const timeout = Math.floor(value);
  if (shouldClearLegacyAgentTimeout(timeout)) return 0;
  return timeout <= 0 ? 0 : Math.max(1000, timeout);
}

/**
 * Fail closed if a nonstandard host ever omits Workspace Trust. The node:test
 * VS Code stub declares the trusted default explicitly.
 */
export function workspaceExecutionControlsAllowed(): boolean {
  return vscode.workspace.isTrusted === true;
}

export function shouldClearLegacyAgentTimeout(value: number | undefined): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const timeout = Math.floor(value);
  // Why: tiny positive values are failed attempts to mean "effectively
  // uncapped" that instead brick every native call after the 1s clamp.
  return timeout > 0 && timeout <= 1000;
}

export function agentTimeoutMs(phase?: Phase): number {
  if (phase === "opener" || phase === "reactor" || phase === "closer" || phase === "parallel") {
    const configured = vscode.workspace.getConfiguration("hydraRoom").get<number>("discussionTimeoutMs", 0);
    return normalizeAgentTimeoutMs(configured, 0);
  }
  const oneShot = vscode.workspace.getConfiguration("hydraRoom").get<number>("oneShotTimeoutMs", 0);
  return normalizeAgentTimeoutMs(oneShot, 0);
}

export function terminalBridgeTimeoutMs(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("terminalBridgeTimeoutMs", 45000);
  return Number.isFinite(raw) ? Math.max(5000, Math.floor(raw)) : 45000;
}

export function autopilotOnStart(): boolean {
  if (!workspaceExecutionControlsAllowed()) return false;
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("autopilotOnStart", true);
}

// This setting launches extra native Claude workers as well as writing their
// live-channel metadata. Keep the runtime trust clamp even though VS Code also
// rejects resource-scoped overrides for its application-scoped declaration.
export function manyHeadsMode(): boolean {
  if (!workspaceExecutionControlsAllowed()) return false;
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("manyHeadsMode", false);
}

/** Autonomous rated challenges spend two full-native head calls when admitted. */
export function agentInitiatedDuels(): boolean {
  if (!workspaceExecutionControlsAllowed()) return false;
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("agentInitiatedDuels", true);
}

export function manyHeadsClaudeWorkerCount(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("manyHeadsClaudeWorkerCount", 3);
  return clampManyHeadsClaudeWorkerCount(raw);
}

export function preferTerminalBridgeOnStart(): boolean {
  if (!workspaceExecutionControlsAllowed()) return false;
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("preferTerminalBridgeOnStart", false);
}

export function diffMaxLines(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("diffMaxLines", 6000);
  return Number.isFinite(raw) ? Math.max(100, Math.floor(raw)) : 6000;
}

export function verificationTimeoutMs(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("verifyTimeoutMs", 600000);
  return Number.isFinite(raw) ? Math.max(1000, Math.floor(raw)) : 600000;
}

export function verificationMaxOutputChars(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("verifyMaxOutputChars", 12000);
  return Number.isFinite(raw) ? Math.max(1000, Math.floor(raw)) : 12000;
}

export function autoVerifyAfterBuild(): boolean {
  if (!workspaceExecutionControlsAllowed()) return false;
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("autoVerifyAfterBuild", true);
}

/** Record only changed serial builds backed by a clean Hydra verification. */
export function autoScorePassingBuilds(): boolean {
  if (!workspaceExecutionControlsAllowed()) return false;
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("autoScorePassingBuilds", true);
}

export function autoSkipCloserOnAgreement(): boolean {
  // The safe value is true here: skipping the closer prevents an additional
  // native agent dispatch in an untrusted workspace.
  if (!workspaceExecutionControlsAllowed()) return true;
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("autoSkipCloserOnAgreement", true);
}

export function discussionMode(): DiscussionMode {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<string>("discussionMode", "parallelOnBoth");
  return raw === "serial" || raw === "parallel" ? raw : "parallelOnBoth";
}

export function autoRequestReviewAfterPassingVerification(): boolean {
  if (!workspaceExecutionControlsAllowed()) return false;
  return vscode.workspace
    .getConfiguration("hydraRoom")
    .get<boolean>("autoRequestReviewAfterPassingVerification", false);
}

export function autoAdvanceActionableDefaults(): boolean {
  if (!workspaceExecutionControlsAllowed()) return false;
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("autoAdvanceActionableDefaults", true);
}

/**
 * Ordered Hydra head identities that participate in this room. Invalid and
 * duplicate entries are ignored; fewer than two usable identities fails back
 * to the built-in two-head roster so a malformed user setting cannot strand
 * serialized discussion without a reactor.
 */
export function normalizeRoomRoster(raw: unknown): AgentId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_ROSTER];
  const seen = new Set<AgentId>();
  const roster: AgentId[] = [];
  for (const value of raw) {
    if (!isValidAgentId(value) || seen.has(value)) continue;
    seen.add(value);
    roster.push(value);
  }
  return roster.length >= 2 ? roster : [...DEFAULT_ROSTER];
}

export function roomRoster(): AgentId[] {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<unknown>("roomRoster", DEFAULT_ROSTER);
  return normalizeRoomRoster(raw);
}

export function sessionCostCapUsd(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("sessionCostCapUsd", 0);
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

// Why NOT scope:"application": these guard settings only feed Hydra's own cost/decision
// logic - they inject into no spawn/exec/env/PATH/terminal/webhook/Telegram
// path - so they follow the sessionCostCapUsd precedent as window/resource
// scoped settings and stay out of TRUST_SCOPED_SETTINGS.
export function claudeAutomationCreditGuard(): ClaudeAutomationGuardMode {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<string>("claudeAutomationCreditGuard", "warn");
  return (CLAUDE_AUTOMATION_GUARD_MODES as readonly string[]).includes(raw) ? (raw as ClaudeAutomationGuardMode) : "warn";
}

export function claudeAgentCreditCapUsd(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("claudeAgentCreditCapUsd", 200);
  // 0 disables the monthly threshold; negative/NaN falls back to the $200 default.
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 200;
}

export function claudeAgentEstimatedRunCostUsd(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("claudeAgentEstimatedRunCostUsd", 1);
  // 0 disables in-flight projection; negative/NaN falls back to the conservative $1 default.
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 1;
}

export function autoAdvanceSendInstructionMaxConsecutive(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("autoAdvanceSendInstructionMaxConsecutive", 3);
  return Math.max(1, Math.floor(raw));
}

export function terminalBridgeWorkspaceInstructionsMaxChars(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("terminalBridgeWorkspaceInstructionsMaxChars", 0);
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
}

export function editorContextMaxChars(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("editorContextMaxChars", 12000);
  return Number.isFinite(raw) ? Math.max(1000, Math.floor(raw)) : 12000;
}

export function attachmentPreviewMaxChars(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("attachmentPreviewMaxChars", 12000);
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 12000;
}

export function attachmentMaxBytes(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("attachmentMaxBytes", 10 * 1024 * 1024);
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 10 * 1024 * 1024;
}

export function attachmentTotalMaxBytes(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("attachmentTotalMaxBytes", 32 * 1024 * 1024);
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 32 * 1024 * 1024;
}

export function wikiContextMaxChars(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("wikiContextMaxChars", 8000);
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 8000;
}

export function wikiPromptIncludeLog(): boolean {
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("wikiPromptIncludeLog", false);
}

export function wikiWrapupEnabled(): boolean {
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("wikiWrapupEnabled", true);
}

export function wikiWrapupMaxSourceChars(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("wikiWrapupMaxSourceChars", 16000);
  return Number.isFinite(raw) ? Math.max(1000, Math.floor(raw)) : 16000;
}

export function wikiWrapupTimeoutMs(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("wikiWrapupTimeoutMs", 120000);
  return Number.isFinite(raw) ? Math.max(1000, Math.floor(raw)) : 120000;
}

export function wikiRawTurnsKeepDays(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("wikiRawTurnsKeepDays", 30);
  return Math.max(0, Math.floor(raw));
}

export function promptBodyRetentionDays(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("promptBodyRetentionDays", 3);
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 3;
}

export function diagnosticRetentionDays(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("diagnosticRetentionDays", 7);
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 7;
}

export function telegramConfig(): TelegramConfig | undefined {
  const cfg = vscode.workspace.getConfiguration("hydraRoom");
  const settingToken = cfg.get<string>("telegramBotToken", "").trim();
  const envToken = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const botToken = settingToken || envToken;
  const chatId = cfg.get<string>("telegramChatId", "").trim();
  if (!botToken || !chatId) return undefined;
  return { botToken, chatId };
}

export function telegramInboundEnabled(): boolean {
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("telegramInboundPollingEnabled", false);
}

export function telegramInboundPollIntervalMs(): number {
  const seconds = vscode.workspace.getConfiguration("hydraRoom").get<number>("telegramInboundPollIntervalSeconds", 10);
  return Math.max(5, seconds) * 1000;
}

export function telegramInboundPrefix(): string {
  return vscode.workspace.getConfiguration("hydraRoom").get<string>("telegramInboundCommandPrefix", "/hydra").trim();
}

// Optional per-sender allowlist for inbound Telegram. Empty (default) means
// every sender in the configured chat is allowed — for a group chatId that is
// every member. A non-empty list gates inbound commands to those Telegram user
// ids only. Coerce entries to trimmed strings (a hand-edited settings.json may
// enter numeric ids unquoted) and drop blanks.
export function telegramInboundAllowedSenderIds(): string[] {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<unknown>("telegramInboundAllowedSenderIds", []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
}
