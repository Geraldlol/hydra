import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AuthorityLevel } from "./authority";
import type { CapabilityProfileId } from "./capabilityProfiles";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";

export type PromptTransport = "oneShot" | "terminalBridge";

export interface PromptEnvelope {
  id: string;
  timestamp: string;
  agent: AgentId;
  otherAgent: AgentId;
  phase: Phase;
  transport: PromptTransport;
  cwd: string;
  command: string;
  args: string[];
  authority: string;
  authorityLevel: AuthorityLevel;
  capabilityProfile: CapabilityProfileId;
  capabilityProfileLabel: string;
  capabilityProfileDetail: string;
  objective?: string;
  currentUserMessage?: string;
  latestDecisionDefault?: string;
  latestVerificationSummary?: string;
  attachments: PromptAttachmentSummary[];
  budget: PromptBudget;
  renderedPrompt: string;
}

export interface PromptAttachmentSummary {
  kind: string;
  label: string;
  chars: number;
}

export interface PromptBudget {
  chars: number;
  estimatedTokens: number;
  sections: PromptBudgetSection[];
  warnings: string[];
}

export interface PromptBudgetSection {
  label: string;
  chars: number;
  estimatedTokens: number;
}

export interface CreatePromptEnvelopeInput {
  id: string;
  timestamp?: string;
  agent: AgentId;
  otherAgent: AgentId;
  phase: Phase;
  transport: PromptTransport;
  cwd: string;
  command: string;
  args: string[];
  authority?: string;
  authorityLevel?: AuthorityLevel;
  capabilityProfile?: CapabilityProfileId;
  capabilityProfileLabel?: string;
  capabilityProfileDetail?: string;
  objective?: string;
  currentUserMessage?: string;
  latestDecisionDefault?: string;
  latestVerificationSummary?: string;
  attachments?: PromptAttachmentSummary[];
  renderedPrompt: string;
}

export function createPromptEnvelope(input: CreatePromptEnvelopeInput): PromptEnvelope {
  const budget = analyzePromptBudget(input.renderedPrompt);
  return {
    id: input.id,
    timestamp: input.timestamp ?? new Date().toISOString(),
    agent: input.agent,
    otherAgent: input.otherAgent,
    phase: input.phase,
    transport: input.transport,
    cwd: input.cwd,
    command: input.command,
    args: input.args,
    authority: input.authority ?? "Unknown/custom - Hydra could not classify this native CLI authority.",
    authorityLevel: input.authorityLevel ?? "unknown",
    capabilityProfile: input.capabilityProfile ?? "custom",
    capabilityProfileLabel: input.capabilityProfileLabel ?? "Custom",
    capabilityProfileDetail: input.capabilityProfileDetail ?? "Raw native CLI args do not match a known Hydra profile.",
    objective: emptyToUndefined(input.objective),
    currentUserMessage: emptyToUndefined(input.currentUserMessage),
    latestDecisionDefault: emptyToUndefined(input.latestDecisionDefault),
    latestVerificationSummary: emptyToUndefined(input.latestVerificationSummary),
    attachments: input.attachments ?? [],
    budget,
    renderedPrompt: input.renderedPrompt,
  };
}

export async function appendPromptEnvelope(workspaceRoot: string, envelope: PromptEnvelope): Promise<void> {
  const indexPath = promptEnvelopeIndexPath(workspaceRoot);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.appendFile(indexPath, `${JSON.stringify(envelope)}\n`, "utf8");
}

export async function readLatestPromptEnvelope(workspaceRoot: string): Promise<PromptEnvelope | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(promptEnvelopeIndexPath(workspaceRoot), "utf8");
  } catch {
    return undefined;
  }
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as PromptEnvelope;
    } catch {
      // Keep walking backward so one torn/legacy line does not hide the
      // latest usable prompt envelope from the user.
    }
  }
  return undefined;
}

export function promptEnvelopeIndexPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".hydra", "prompts", "index.jsonl");
}

export function renderPromptEnvelopePreview(envelope: PromptEnvelope): string {
  return [
    "# Hydra Prompt Preview",
    "",
    `Envelope: ${envelope.id}`,
    `Timestamp: ${envelope.timestamp}`,
    `Agent: ${envelope.agent}`,
    `Other agent: ${envelope.otherAgent}`,
    `Phase: ${envelope.phase}`,
    `Transport: ${envelope.transport}`,
    `CWD: ${envelope.cwd}`,
    `Command: ${formatCommand(envelope.command, envelope.args)}`,
    `Authority: ${envelope.authority}`,
    `Authority level: ${envelope.authorityLevel}`,
    `Capability profile: ${envelope.capabilityProfileLabel} (${envelope.capabilityProfile})`,
    `Profile detail: ${envelope.capabilityProfileDetail}`,
    envelope.objective ? `Objective: ${envelope.objective}` : "Objective: <none>",
    envelope.currentUserMessage ? `Current user message: ${envelope.currentUserMessage}` : "Current user message: <none>",
    envelope.latestDecisionDefault ? `Latest default decision: ${envelope.latestDecisionDefault}` : "Latest default decision: <none>",
    envelope.latestVerificationSummary ? `Latest verification: ${envelope.latestVerificationSummary}` : "Latest verification: <none>",
    "",
    "## Prompt Budget",
    "",
    `Total: ${envelope.budget.chars} chars (~${envelope.budget.estimatedTokens} tokens)`,
    envelope.budget.sections.length
      ? envelope.budget.sections.map((s) => `- ${s.label}: ${s.chars} chars (~${s.estimatedTokens} tokens)`).join("\n")
      : "No sections detected.",
    envelope.budget.warnings.length
      ? ["", "Warnings:", ...envelope.budget.warnings.map((w) => `- ${w}`)].join("\n")
      : "",
    "",
    "## Attachments",
    "",
    envelope.attachments.length
      ? envelope.attachments.map((a) => `- ${a.kind}: ${a.label} (${a.chars} chars)`).join("\n")
      : "No attachments.",
    "",
    "## Rendered Prompt",
    "",
    "```text",
    envelope.renderedPrompt,
    "```",
  ].join("\n");
}

export function analyzePromptBudget(prompt: string): PromptBudget {
  const sections = promptSections(prompt);
  const chars = prompt.length;
  const warnings: string[] = [];
  if (estimateTokens(chars) > 6000) {
    warnings.push("Prompt exceeds ~6000 tokens; trim context, diff, or attachments before dispatch.");
  }
  for (const section of sections) {
    if (section.label.toLowerCase().includes("shared context") && section.estimatedTokens > 2000) {
      warnings.push("Shared context exceeds ~2000 tokens; lower context turns or attach only the needed artifact.");
    }
    if (section.label.toLowerCase().includes("diff") && section.estimatedTokens > 3000) {
      warnings.push("Diff exceeds ~3000 tokens; narrow the review surface or lower hydraRoom.diffMaxLines.");
    }
  }
  return {
    chars,
    estimatedTokens: estimateTokens(chars),
    sections,
    warnings,
  };
}

function promptSections(prompt: string): PromptBudgetSection[] {
  const lines = prompt.split(/\r?\n/);
  const ranges: Array<{ label: string; startLine: number }> = [{ label: "Preamble", startLine: 0 }];
  lines.forEach((line, index) => {
    const match = /^--- (.+) ---$/.exec(line.trim());
    if (match) ranges.push({ label: match[1], startLine: index });
  });

  const sections: PromptBudgetSection[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const startLine = ranges[i].startLine;
    const endLine = ranges[i + 1]?.startLine ?? lines.length;
    const text = lines.slice(startLine, endLine).join("\n").trim();
    if (!text) continue;
    sections.push({
      label: ranges[i].label,
      chars: text.length,
      estimatedTokens: estimateTokens(text.length),
    });
  }
  return sections;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(formatCommandPart).join(" ");
}

function formatCommandPart(value: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
