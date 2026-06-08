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
import type { DiscussionMode } from "./phases";
import type { TelegramConfig } from "./telegram";
import { CLAUDE_AUTOMATION_GUARD_MODES, type ClaudeAutomationGuardMode } from "./claudeAuth";

export function agentTimeoutMs(phase?: Phase): number {
  if (phase === "opener" || phase === "reactor" || phase === "closer" || phase === "parallel") {
    const configured = vscode.workspace.getConfiguration("hydraRoom").get<number>("discussionTimeoutMs", 600000);
    // Why: preserve the legacy 2-minute -> 10-minute coercion BEFORE clamping
    // so an explicitly-saved 120000 still upgrades to the new default.
    const coerced = configured === 120000 ? 600000 : configured;
    return Number.isFinite(coerced) ? Math.max(1000, Math.floor(coerced)) : 600000;
  }
  const oneShot = vscode.workspace.getConfiguration("hydraRoom").get<number>("oneShotTimeoutMs", 600000);
  return Number.isFinite(oneShot) ? Math.max(1000, Math.floor(oneShot)) : 600000;
}

export function terminalBridgeTimeoutMs(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("terminalBridgeTimeoutMs", 45000);
  return Number.isFinite(raw) ? Math.max(5000, Math.floor(raw)) : 45000;
}

export function autopilotOnStart(): boolean {
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("autopilotOnStart", true);
}

export function preferTerminalBridgeOnStart(): boolean {
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
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("autoVerifyAfterBuild", true);
}

export function autoSkipCloserOnAgreement(): boolean {
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("autoSkipCloserOnAgreement", true);
}

export function discussionMode(): DiscussionMode {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<string>("discussionMode", "parallelOnBoth");
  return raw === "serial" || raw === "parallel" ? raw : "parallelOnBoth";
}

export function autoRequestReviewAfterPassingVerification(): boolean {
  return vscode.workspace
    .getConfiguration("hydraRoom")
    .get<boolean>("autoRequestReviewAfterPassingVerification", false);
}

export function autoAdvanceActionableDefaults(): boolean {
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("autoAdvanceActionableDefaults", true);
}

export function sessionCostCapUsd(): number {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<number>("sessionCostCapUsd", 0);
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

// Why NOT scope:"application": these two only feed Hydra's own cost/decision
// logic — they inject into no spawn/exec/env/PATH/terminal/webhook/Telegram
// path — so they follow the sessionCostCapUsd precedent as window/resource
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
