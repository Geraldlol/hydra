import type { DecisionAction } from "./decisions";
import type { NativeActionReceipt } from "./nativeActions";
import { verificationPassed, verificationSummary, type VerificationResult } from "./verification";

export type WorkQueueItemKind = "decision" | "verification" | "nativeAction";
export type WorkQueueSeverity = "info" | "warning" | "error";
export type WorkQueueActionType = "acceptDefaultDecision" | "discussVerification" | "rerunNativeAction";

export interface WorkQueueItem {
  id: string;
  kind: WorkQueueItemKind;
  severity: WorkQueueSeverity;
  title: string;
  detail: string;
  actionType: WorkQueueActionType;
  actionLabel: string;
  actionId?: string;
}

export interface BuildWorkQueueInput {
  decisionAction: DecisionAction;
  latestVerification?: VerificationResult;
  nativeActions: NativeActionReceipt[];
  maxItems?: number;
}

export function buildWorkQueue(input: BuildWorkQueueInput): WorkQueueItem[] {
  const items: WorkQueueItem[] = [];

  if (input.decisionAction.kind !== "none" && input.decisionAction.kind !== "sendInstruction") {
    // Stable id derived from the source decision packet timestamp. Prior
    // version hashed label+detail; if the agent rephrased the same logical
    // decision, the hash changed and any prior dismiss/snooze was orphaned
    // — the item appeared to "come back" with new wording. Falling back to
    // the label+detail hash only when no source timestamp is available.
    const sourceKey = input.decisionAction.sourceTimestamp ?? stableHash(`${input.decisionAction.label}\n${input.decisionAction.detail}`);
    items.push({
      id: `decision-${sourceKey}`,
      kind: "decision",
      severity: "info",
      title: input.decisionAction.label,
      detail: input.decisionAction.detail,
      actionType: "acceptDefaultDecision",
      actionLabel: "Accept",
    });
  }

  if (input.latestVerification && !verificationPassed(input.latestVerification)) {
    items.push({
      id: `verification-${input.latestVerification.timestamp}`,
      kind: "verification",
      severity: "error",
      title: "Fix failing verification",
      detail: verificationSummary(input.latestVerification),
      actionType: "discussVerification",
      actionLabel: "Discuss",
    });
  }

  for (const action of [...input.nativeActions].reverse()) {
    if (action.status === "completed") continue;
    items.push({
      id: `native-action-${action.id}`,
      kind: "nativeAction",
      severity: action.status === "failed" ? "error" : "warning",
      title: `${capitalize(action.status)} native action`,
      detail: nativeActionDetail(action),
      actionType: "rerunNativeAction",
      actionLabel: "Rerun",
      actionId: action.id,
    });
  }

  // Default cap of 8 leaves room for the one-off decision + verification
  // entries plus several native actions without silently dropping any of
  // them. Order is decision → verification → native actions, so the
  // single-source items at the head are protected.
  return items.slice(0, input.maxItems ?? 8);
}

function nativeActionDetail(action: NativeActionReceipt): string {
  const agents = action.agents.map((agent) => agent === "codex" ? "Codex" : "Claude").join(" + ");
  const instruction = action.instruction.trim().replace(/\s+/g, " ");
  const shortInstruction = instruction.length > 120 ? `${instruction.slice(0, 117)}...` : instruction;
  return `${agents}: ${shortInstruction || "[no instruction]"}`;
}

function capitalize(value: string): string {
  return value.length ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
