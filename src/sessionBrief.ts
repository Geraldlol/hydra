import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "./fileQueue";
import type { DecisionPacket } from "./decisions";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";
import type { NativeActionReceipt } from "./nativeActions";
import type { VerificationResult } from "./verification";
import { verificationPassed, verificationSummary } from "./verification";
import type { WorkQueueItem } from "./workQueue";
import { displayNameFor } from "./agentRegistry";

export interface SessionBriefMessage {
  role: "user" | AgentId | "system";
  phase?: Phase;
  text: string;
  timestamp: string;
}

export interface SessionBriefInput {
  generatedAt: string;
  workspaceRoot: string;
  phaseLabel: string;
  transport: "oneShot" | "terminalBridge";
  objective: string;
  latestDecision?: DecisionPacket;
  latestVerification?: VerificationResult;
  workQueue: WorkQueueItem[];
  recentNativeActions: NativeActionReceipt[];
  recentMessages: SessionBriefMessage[];
}

export function sessionBriefPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".hydra", "session-brief.md");
}

export async function writeSessionBrief(filePath: string, markdown: string): Promise<void> {
  await atomicWriteFile(filePath, markdown);
}

export function renderSessionBrief(input: SessionBriefInput): string {
  const lines: string[] = [
    "# Hydra Session Brief",
    "",
    `Generated: ${input.generatedAt}`,
    `Workspace: ${input.workspaceRoot}`,
    `Phase: ${input.phaseLabel}`,
    `Transport: ${input.transport === "terminalBridge" ? "Experimental terminal bridge" : "Safe one-shot"}`,
    "",
    "## Objective",
    "",
    input.objective.trim() || "No pinned objective.",
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
    "## Recent Room Messages",
    "",
    ...renderMessages(input.recentMessages),
    "",
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderWorkQueue(items: WorkQueueItem[]): string[] {
  if (items.length === 0) return ["Queue clear."];
  return items.map((item) => `- [${item.severity}] ${item.title}: ${item.detail}`);
}

function renderDecision(decision: DecisionPacket | undefined): string[] {
  if (!decision) return ["No decision packet captured yet."];
  return [
    `Agent: ${labelAgent(decision.agent)}${decision.phase ? ` (${decision.phase})` : ""}`,
    `Timestamp: ${decision.timestamp}`,
    `Recommendation: ${singleLine(decision.recommendation) || "none"}`,
    `Default next action: ${singleLine(decision.defaultNextAction) || "none"}`,
    `Decision needed from user: ${singleLine(decision.decisionNeededFromUser) || "none"}`,
    `Blockers: ${singleLine(decision.blockers) || "none"}`,
  ];
}

function renderVerification(verification: VerificationResult | undefined): string[] {
  if (!verification) return ["No verification run recorded yet."];
  return [
    `Status: ${verificationPassed(verification) ? "passed" : "failed"}`,
    `Summary: ${verificationSummary(verification)}`,
    `Command: ${verification.command}`,
    `Timestamp: ${verification.timestamp}`,
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
      .map((hint) => `${labelAgent(hint.agent)}:${hint.sessionId ?? hint.pathLabel ?? hint.source}`)
      .join(", ");
    return `- ${action.status}: ${agents}${attachments ? ` (${attachments})` : ""}${sessionHints ? ` [sessions: ${singleLine(sessionHints)}]` : ""} - ${singleLine(action.instruction) || "[no instruction]"}`;
  });
}

function renderMessages(messages: SessionBriefMessage[]): string[] {
  if (messages.length === 0) return ["No room messages loaded."];
  return messages.map((message) => {
    const phase = message.phase ? `/${message.phase}` : "";
    return `- ${labelAgent(message.role)}${phase}: ${singleLine(message.text) || "[empty]"}`;
  });
}

function labelAgent(value: AgentId | "user" | "system"): string {
  if (value === "user") return "You";
  if (value === "system") return "System";
  return displayNameFor(value);
}

function singleLine(value: string): string {
  const compacted = value.trim().replace(/\s+/g, " ");
  return compacted.length > 220 ? `${compacted.slice(0, 217)}...` : compacted;
}
