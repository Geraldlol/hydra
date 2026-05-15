import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureFile, readJsonlGuarded, serializePerFile } from "./fileQueue";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";

export interface DecisionPacket {
  timestamp: string;
  agent: AgentId;
  phase?: Phase;
  recommendation: string;
  defaultNextAction: string;
  decisionNeededFromUser: string;
  blockers: string;
  sourceMessageTimestamp: string;
}

export interface DecisionPacketMeta {
  agent: AgentId;
  phase?: Phase;
  sourceMessageTimestamp: string;
  timestamp?: string;
}

export type DecisionActionKind = "none" | "assignBuilder" | "requestReview" | "handBack" | "sendInstruction";

export interface DecisionAction {
  kind: DecisionActionKind;
  label: string;
  detail: string;
  builder?: AgentId;
  instruction?: string;
  // Stable identity for the decision action: the timestamp of the decision
  // packet that produced it. Downstream consumers (work queue) use this as
  // the item id so label/wording rephrases by the agent don't orphan the
  // user's previous dismiss/snooze. Undefined for actions derived from
  // a missing packet (kind: "none").
  sourceTimestamp?: string;
}

type PacketField = "recommendation" | "defaultNextAction" | "decisionNeededFromUser" | "blockers";

const FIELD_LABELS: Record<PacketField, string> = {
  recommendation: "Recommendation:",
  defaultNextAction: "Default next action:",
  decisionNeededFromUser: "Decision needed from user:",
  blockers: "Blockers:",
};

const REQUIRED_FIELDS: PacketField[] = [
  "recommendation",
  "defaultNextAction",
  "decisionNeededFromUser",
  "blockers",
];

export async function ensureDecisionsFile(filePath: string): Promise<void> {
  await ensureFile(filePath);
}

export async function appendDecision(filePath: string, packet: DecisionPacket): Promise<void> {
  await serializePerFile(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(packet)}\n`, "utf8");
  });
}

export async function readDecisions(filePath: string): Promise<DecisionPacket[]> {
  return readJsonlGuarded(filePath, isDecisionPacket);
}

export function parseDecisionPacket(text: string, meta: DecisionPacketMeta): DecisionPacket | undefined {
  const values: Record<PacketField, string[]> = {
    recommendation: [],
    defaultNextAction: [],
    decisionNeededFromUser: [],
    blockers: [],
  };

  let current: PacketField | undefined;
  for (const line of text.split(/\r?\n/)) {
    const heading = matchHeading(line);
    if (heading) {
      current = heading.field;
      values[current].push(heading.value);
      continue;
    }
    if (current) values[current].push(line);
  }

  const packetValues = Object.fromEntries(
    REQUIRED_FIELDS.map((field) => [field, normalizeValue(values[field])])
  ) as Record<PacketField, string>;

  if (REQUIRED_FIELDS.some((field) => packetValues[field].length === 0)) {
    return undefined;
  }

  return {
    timestamp: meta.timestamp ?? new Date().toISOString(),
    agent: meta.agent,
    phase: meta.phase,
    recommendation: packetValues.recommendation,
    defaultNextAction: packetValues.defaultNextAction,
    decisionNeededFromUser: packetValues.decisionNeededFromUser,
    blockers: packetValues.blockers,
    sourceMessageTimestamp: meta.sourceMessageTimestamp,
  };
}

export function resolveDecisionAction(
  packet: DecisionPacket | undefined,
  stateName: string
): DecisionAction {
  if (!packet) return noDecisionAction("No decision packet is available.");
  const defaultAction = packet.defaultNextAction.trim();
  if (!defaultAction || isNoneValue(defaultAction)) {
    return noDecisionAction("The latest decision has no default action.");
  }

  const sourceTimestamp = packet.timestamp;
  const lower = defaultAction.toLowerCase();
  if (stateName === "BuildDone") {
    return {
      kind: "requestReview",
      label: "Accept Default: Request Review",
      detail: "The build is done, so accepting the default asks the other head to review the diff.",
      sourceTimestamp,
    };
  }

  if (stateName === "ReviewDone" && /\b(hand back|fix|address|return to builder|builder)\b/.test(lower)) {
    return {
      kind: "handBack",
      label: "Accept Default: Hand Back",
      detail: "The review raised follow-up work, so accepting the default hands the diff back to the builder.",
      sourceTimestamp,
    };
  }

  const builder = builderFromAction(defaultAction, packet.agent);
  if (builder) {
    return {
      kind: "assignBuilder",
      builder,
      label: `Accept Default: Build with ${builder === "codex" ? "Codex" : "Claude"}`,
      detail: `The default action names ${builder === "codex" ? "Codex" : "Claude"} as the implementation owner.`,
      sourceTimestamp,
    };
  }

  return {
    kind: "sendInstruction",
    label: "Accept Default",
    detail: "Send the default action back into the room as the next user instruction.",
    instruction: `Accepted default next action:\n\n${defaultAction}`,
    sourceTimestamp,
  };
}

export function decisionHasNoUserBlockers(packet: DecisionPacket | undefined): boolean {
  if (!packet) return false;
  return isNoneValue(packet.decisionNeededFromUser) && isNoneValue(packet.blockers);
}

export interface RiskySignals {
  risky: boolean;
  reasons: string[];
}

const RISKY_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bforce[- ]?push\b/i, label: "force-push" },
  { pattern: /\bpush --force\b/i, label: "force-push" },
  { pattern: /--no-verify\b/i, label: "skip-hooks" },
  { pattern: /git reset --hard\b/i, label: "hard-reset" },
  { pattern: /\brm -rf\b/i, label: "rm -rf" },
  { pattern: /\bdrop\s+(table|database|schema)\b/i, label: "drop-table" },
  { pattern: /\btruncate\s+table\b/i, label: "truncate" },
  { pattern: /\b(?:run|apply|execute)\s+(?:(?:a|the)\s+)?migration\b/i, label: "migration" },
  { pattern: /\bschema\s+(?:change|migration)\b/i, label: "schema-change" },
  { pattern: /\b(?:delete|remove)\s+(?:all|every|the\s+entire)\b/i, label: "bulk-delete" },
  { pattern: /\bgit\s+push\b(?!.*\bdry-run\b)/i, label: "push" },
  { pattern: /\bnpm\s+publish\b/i, label: "publish" },
  { pattern: /\b(?:overwrite|clobber)\s+(?:uncommitted|local\s+changes)\b/i, label: "overwrite-local" },
];

export function detectRiskySignals(packet: DecisionPacket | undefined): RiskySignals {
  if (!packet) return { risky: false, reasons: [] };
  const haystack = `${packet.defaultNextAction}\n${packet.recommendation}`;
  const reasons = new Set<string>();
  for (const { pattern, label } of RISKY_PATTERNS) {
    if (pattern.test(haystack)) reasons.add(label);
  }
  return { risky: reasons.size > 0, reasons: [...reasons] };
}

function matchHeading(line: string): { field: PacketField; value: string } | undefined {
  const trimmed = line.trimStart();
  for (const field of REQUIRED_FIELDS) {
    const label = FIELD_LABELS[field];
    if (trimmed.toLowerCase().startsWith(label.toLowerCase())) {
      return { field, value: trimmed.slice(label.length).trimStart() };
    }
  }
  return undefined;
}

function normalizeValue(lines: string[]): string {
  return lines.join("\n").trim();
}

function isDecisionPacket(value: unknown): value is DecisionPacket {
  if (!value || typeof value !== "object") return false;
  const packet = value as Partial<DecisionPacket>;
  return (
    (packet.agent === "codex" || packet.agent === "claude") &&
    typeof packet.timestamp === "string" &&
    typeof packet.sourceMessageTimestamp === "string" &&
    typeof packet.recommendation === "string" &&
    typeof packet.defaultNextAction === "string" &&
    typeof packet.decisionNeededFromUser === "string" &&
    typeof packet.blockers === "string"
  );
}

function builderFromAction(value: string, fallback?: AgentId): AgentId | undefined {
  const lower = value.toLowerCase();
  const mentionsCodex = /\bcodex\b/.test(lower);
  const mentionsClaude = /\bclaude\b/.test(lower);
  const buildIntent = /\b(build|builds|patch|patches|implement|implements|fix|fixes|edit|edits|land|lands|apply|applies|update|updates|ship|ships|run|runs|execute|executes|verify|verifies|test|tests|inspect|inspects|check|checks)\b/.test(lower);
  if (!buildIntent) return undefined;
  if (mentionsCodex && !mentionsClaude) return "codex";
  if (mentionsClaude && !mentionsCodex) return "claude";
  if (!mentionsCodex && !mentionsClaude) return fallback;
  return undefined;
}

export function isNoneValue(value: string): boolean {
  return /^(none|n\/a|no action|wait|do nothing)$/i.test(value.trim());
}

function noDecisionAction(detail: string): DecisionAction {
  return { kind: "none", label: "No Default Action", detail };
}
