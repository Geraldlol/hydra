import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AuthorityLevel } from "./authority";
import type { CapabilityProfileId } from "./capabilityProfiles";
import {
  appendFileSafely,
  readJsonlGuarded,
  rewriteFileLinesAtomically,
  serializePerFileAcrossProcesses,
} from "./fileQueue";
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
  renderedPromptOmitted?: boolean;
  renderedPromptOriginalChars?: number;
  renderedPromptOmittedAt?: string;
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

// Why: directories we've already mkdir'd this process, so the hot append path
// skips the redundant per-write fs.mkdir. We still mkdir once per path so the
// first append on a fresh workspace is safe.
const ensuredDirs = new Set<string>();

async function ensureDirOnce(dir: string): Promise<void> {
  if (ensuredDirs.has(dir)) return;
  await fs.mkdir(dir, { recursive: true });
  ensuredDirs.add(dir);
}

export async function appendPromptEnvelope(workspaceRoot: string, envelope: PromptEnvelope): Promise<void> {
  const indexPath = promptEnvelopeIndexPath(workspaceRoot);
  await serializePerFileAcrossProcesses(indexPath, async () => {
    await ensureDirOnce(path.dirname(indexPath));
    await appendFileSafely(indexPath, `${JSON.stringify(envelope)}\n`);
  });
}

export interface PromptBodyCompactionSummary {
  totalRecords: number;
  compactedRecords: number;
  alreadyCompactedRecords: number;
  retainedBodyRecords: number;
  malformedLines: number;
  missing: boolean;
}

export interface CompactPromptBodiesOptions {
  retentionDays: number;
  now?: Date;
}

export async function compactPromptEnvelopeBodies(
  workspaceRoot: string,
  options: CompactPromptBodiesOptions
): Promise<PromptBodyCompactionSummary> {
  const indexPath = promptEnvelopeIndexPath(workspaceRoot);
  return serializePerFileAcrossProcesses(indexPath, async () => {
    try {
      await fs.stat(indexPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return emptyCompactionSummary(true);
    }

    const now = options.now ?? new Date();
    const retentionDays = Number.isFinite(options.retentionDays) ? Math.max(0, options.retentionDays) : 3;
    const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    const summary = emptyCompactionSummary(false);
    let changed = false;

    await rewriteFileLinesAtomically(indexPath, (line) => {
      if (!line.trim()) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        summary.malformedLines++;
        return line;
      }
      if (!isObjectRecord(parsed)) {
        summary.malformedLines++;
        return line;
      }

      summary.totalRecords++;
      const renderedPrompt = parsed.renderedPrompt;
      if (typeof renderedPrompt !== "string" || renderedPrompt.length === 0 || parsed.renderedPromptOmitted === true) {
        summary.alreadyCompactedRecords++;
        return JSON.stringify(parsed);
      }

      const timestampMs = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
      if (!Number.isFinite(timestampMs) || timestampMs > cutoffMs) {
        summary.retainedBodyRecords++;
        return JSON.stringify(parsed);
      }

      summary.compactedRecords++;
      changed = true;
      return JSON.stringify({
        ...parsed,
        renderedPrompt: "",
        renderedPromptOmitted: true,
        renderedPromptOriginalChars: renderedPrompt.length,
        renderedPromptOmittedAt: now.toISOString(),
      });
    }, () => changed);
    return summary;
  });
}

// A rendered prompt can legitimately be hundreds of KiB. Keep enough room for
// a large newest envelope while still enforcing a hard startup/read ceiling.
const PROMPT_TAIL_READ_BYTES = 8 * 1024 * 1024;

export async function readLatestPromptEnvelope(workspaceRoot: string): Promise<PromptEnvelope | undefined> {
  const indexPath = promptEnvelopeIndexPath(workspaceRoot);
  const newest = await readJsonlGuarded(indexPath, isPromptEnvelopeRecord, {
    limit: 1,
    maxBytes: PROMPT_TAIL_READ_BYTES,
  });
  return newest[0];
}

function isPromptEnvelopeRecord(value: unknown): value is PromptEnvelope {
  if (!isObjectRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.timestamp === "string"
    && typeof value.agent === "string"
    && typeof value.phase === "string"
    && typeof value.renderedPrompt === "string";
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
    renderedPromptBodyForPreview(envelope),
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
    if (match?.[1] !== undefined) ranges.push({ label: match[1], startLine: index });
  });

  const sections: PromptBudgetSection[] = [];
  for (let i = 0; i < ranges.length; i++) {
    // Why: i is bounded by 0..ranges.length-1, so ranges[i] is always present.
    const range = ranges[i]!;
    const startLine = range.startLine;
    const endLine = ranges[i + 1]?.startLine ?? lines.length;
    const text = lines.slice(startLine, endLine).join("\n").trim();
    if (!text) continue;
    sections.push({
      label: range.label,
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

function renderedPromptBodyForPreview(envelope: PromptEnvelope): string {
  if (!envelope.renderedPromptOmitted) return envelope.renderedPrompt;
  const chars = envelope.renderedPromptOriginalChars !== undefined
    ? ` Original body was ${envelope.renderedPromptOriginalChars} chars.`
    : "";
  const omittedAt = envelope.renderedPromptOmittedAt ? ` Omitted at ${envelope.renderedPromptOmittedAt}.` : "";
  return `[Rendered prompt body omitted by Hydra workspace cleanup.${chars}${omittedAt}]`;
}

function emptyCompactionSummary(missing: boolean): PromptBodyCompactionSummary {
  return {
    totalRecords: 0,
    compactedRecords: 0,
    alreadyCompactedRecords: 0,
    retainedBodyRecords: 0,
    malformedLines: 0,
    missing,
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
