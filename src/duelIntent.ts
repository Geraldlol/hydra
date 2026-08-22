import { createHash } from "node:crypto";
import { isValidAgentId } from "./agentValidation";
import { DUEL_MAX_SHARED_EVIDENCE_PACKET_BYTES } from "./duels";

export const AGENT_DUEL_CHALLENGE_MARKER = "HYDRA_DUEL_CHALLENGE_V1:";
export const AGENT_DUEL_DOMAINS = [
  "runtime",
  "architecture",
  "security",
  "ux",
  "requirements",
  "research",
] as const;

export type AgentDuelDomain = typeof AGENT_DUEL_DOMAINS[number];

export interface AgentDuelIntent {
  readonly opponentId: string;
  readonly domain: AgentDuelDomain;
  readonly proposition: string;
  readonly evidenceContract: string;
  readonly rationale: string;
}

export type AgentDuelIntentParseResult =
  | { readonly kind: "none"; readonly cleanedText: string }
  | { readonly kind: "invalid"; readonly cleanedText: string; readonly error: string }
  | { readonly kind: "challenge"; readonly cleanedText: string; readonly intent: AgentDuelIntent };

const DOMAIN_SET = new Set<string>(AGENT_DUEL_DOMAINS);
const EXACT_KEYS = ["domain", "evidenceContract", "opponentId", "proposition", "rationale"] as const;
const MAX_MARKER_BYTES = 8 * 1024;

/**
 * Parses the one machine-readable line a reactor or closer may place directly
 * before its Decision Packet. The visible reply is returned without the
 * control line so machine protocol never enters the transcript or later
 * prompts.
 */
export function parseAgentDuelIntent(text: string, expectedOpponentId: string): AgentDuelIntentParseResult {
  const lines = text.split(/\r?\n/);
  const markerIndexes = lines.flatMap((line, index) => line.startsWith(AGENT_DUEL_CHALLENGE_MARKER) ? [index] : []);
  if (markerIndexes.length === 0) return { kind: "none", cleanedText: text };

  const cleanedText = lines
    .filter((_line, index) => !markerIndexes.includes(index))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (markerIndexes.length !== 1) {
    return { kind: "invalid", cleanedText, error: "A reply may request at most one formal duel." };
  }

  const markerIndex = markerIndexes[0]!;
  const packetLines = lines.slice(markerIndex + 1).filter((line) => line.trim().length > 0).map((line) => line.trim());
  const requiredDecisionHeadings = [
    "Recommendation:",
    "Default next action:",
    "Decision needed from user:",
    "Blockers:",
  ] as const;
  let previousHeadingIndex = -1;
  const completeDecisionPacket = requiredDecisionHeadings.every((heading, headingIndex) => {
    const lineIndex = packetLines.findIndex((line, index) => index > previousHeadingIndex && line.startsWith(heading));
    if (lineIndex < 0 || (headingIndex === 0 && lineIndex !== 0)) return false;
    previousHeadingIndex = lineIndex;
    return packetLines[lineIndex]!.slice(heading.length).trim().length > 0;
  });
  if (!completeDecisionPacket) {
    return {
      kind: "invalid",
      cleanedText,
      error: "The duel challenge line must appear immediately before one complete Decision Packet.",
    };
  }

  const line = lines[markerIndex]!;
  if (Buffer.byteLength(line, "utf8") > MAX_MARKER_BYTES) {
    return { kind: "invalid", cleanedText, error: "The duel challenge packet is too large." };
  }
  const rawJson = line.slice(AGENT_DUEL_CHALLENGE_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { kind: "invalid", cleanedText, error: "The duel challenge packet is not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", cleanedText, error: "The duel challenge packet must be a JSON object." };
  }

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== EXACT_KEYS.length || keys.some((key, index) => key !== EXACT_KEYS[index])) {
    return {
      kind: "invalid",
      cleanedText,
      error: "The duel challenge packet must contain only opponentId, domain, proposition, evidenceContract, and rationale.",
    };
  }
  if (!isValidAgentId(record.opponentId) || record.opponentId !== expectedOpponentId) {
    return {
      kind: "invalid",
      cleanedText,
      error: `The challenge opponent must be the head this reply directly answered (${expectedOpponentId}).`,
    };
  }
  if (typeof record.domain !== "string" || !DOMAIN_SET.has(record.domain)) {
    return {
      kind: "invalid",
      cleanedText,
      error: `The duel domain must be one of: ${AGENT_DUEL_DOMAINS.join(", ")}.`,
    };
  }

  const proposition = boundedTrimmedString(record.proposition, "proposition", 2_000);
  if (typeof proposition === "string") return { kind: "invalid", cleanedText, error: proposition };
  const evidenceContract = boundedTrimmedString(record.evidenceContract, "evidenceContract", 2_000);
  if (typeof evidenceContract === "string") return { kind: "invalid", cleanedText, error: evidenceContract };
  const rationale = boundedTrimmedString(record.rationale, "rationale", 1_000);
  if (typeof rationale === "string") return { kind: "invalid", cleanedText, error: rationale };

  return {
    kind: "challenge",
    cleanedText,
    intent: {
      opponentId: record.opponentId,
      domain: record.domain as AgentDuelDomain,
      proposition: proposition.value,
      evidenceContract: evidenceContract.value,
      rationale: rationale.value,
    },
  };
}

export function renderAgentDuelChallengeInstructions(opponentId: string, opponentName: string): string {
  return [
    "Agent-initiated formal duels:",
    `You may challenge only the specific head you are directly answering: ${opponentName} (durable id \`${opponentId}\`).`,
    "Challenge only a consequential disagreement that affects the active objective, can be expressed as one falsifiable proposition, and can be settled by objective evidence. Ordinary dissent, style preferences, rank farming, and safety/authority disputes are not duel material.",
    "Except when the user explicitly requested an exact or minimal reply, the visible `Challenge:` prefix is reserved for that formal commitment. If your reply starts with `Challenge:`, you MUST add exactly one unindented challenge line immediately before the Decision Packet. If you disagree but do not intend a sealed formal duel, start with `Amend:` instead.",
    "When the disagreement meets the criteria and you are willing to defend it independently, use the formal challenge rather than leaving a consequential `Challenge:` as ordinary prose:",
    `${AGENT_DUEL_CHALLENGE_MARKER} {\"opponentId\":\"${opponentId}\",\"domain\":\"runtime|architecture|security|ux|requirements|research\",\"proposition\":\"one falsifiable claim\",\"evidenceContract\":\"objective evidence and decision rule\",\"rationale\":\"why this disagreement matters now\"}`,
    "A valid request is policy-checked and, if admitted, Hydra automatically runs both sealed commitments. The user judges the revealed evidence. Do not emit the line when the user requested an exact or minimal reply.",
  ].join("\n");
}

/**
 * A top-level `Challenge:` is a deliberate visible commitment only while the
 * formal-duel prompt is enabled. Keep this separate from parsing so quoted,
 * fenced, indented, or disabled-mode prose can never mint a duel by itself.
 */
export function hasReservedAgentDuelChallengePrefix(text: string): boolean {
  return text.startsWith("Challenge:");
}

export interface AgentDuelEvidenceInput {
  readonly challengerId: string;
  readonly challengedId: string;
  readonly sourceReplyTimestamp: string;
  readonly disputedMessageTimestamp: string;
  readonly disputedMessage: string;
  readonly latestUserMessage?: string;
  readonly intent: AgentDuelIntent;
}

/** Build a bounded, host-selected common starting brief for both heads. */
export function buildAgentDuelEvidencePacket(input: AgentDuelEvidenceInput): string {
  const packet = JSON.stringify({
    protocol: "hydra-agent-duel-evidence-v1",
    challengerId: input.challengerId,
    challengedId: input.challengedId,
    sourceReplyTimestamp: input.sourceReplyTimestamp,
    disputedMessageTimestamp: input.disputedMessageTimestamp,
    proposition: input.intent.proposition,
    evidenceContract: input.intent.evidenceContract,
    challengerRationale: input.intent.rationale,
    latestUserRequest: boundedExcerpt(input.latestUserMessage ?? "", 2_000),
    disputedHeadMessage: boundedExcerpt(input.disputedMessage, 4_000),
  });
  if (Buffer.byteLength(packet, "utf8") > DUEL_MAX_SHARED_EVIDENCE_PACKET_BYTES) {
    throw new Error("Hydra could not fit the host-bound duel evidence into the shared packet limit.");
  }
  return packet;
}

export function hashAgentDuelSource(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Remove control lines before assistant text is written to durable diagnostics. */
export function stripAgentDuelChallengeControlLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(AGENT_DUEL_CHALLENGE_MARKER))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function boundedTrimmedString(
  value: unknown,
  field: string,
  maxChars: number,
): { readonly value: string } | string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim() || value.length > maxChars) {
    return `${field} must contain 1-${maxChars} trimmed characters.`;
  }
  if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) {
    return `${field} must be one plain-text line without control characters.`;
  }
  return { value };
}

function boundedExcerpt(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}
