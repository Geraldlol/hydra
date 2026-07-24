import {
  MISSION_CONTRACT_LIMITS,
  MISSION_CONTRACT_SCHEMA_VERSION,
  missionContractSha256,
  normalizeMissionContract,
  type MissionContractDocument,
} from "./missionContract";

export const MISSION_CONTRACT_PROPOSAL_MARKER = "HYDRA_MISSION_PROPOSAL_V1:";
export const MAX_MISSION_CONTRACT_PROPOSAL_CONTROL_BYTES =
  (MISSION_CONTRACT_LIMITS.contractBytes * 2) + 4_096;

export interface MissionContractIntentCandidate {
  schemaVersion: typeof MISSION_CONTRACT_SCHEMA_VERSION;
  contract: MissionContractDocument;
  documentSha256: string;
}

export type MissionContractIntentParseResult =
  | {
      kind: "none";
      cleanedText: string;
    }
  | {
      kind: "invalid";
      cleanedText: string;
      error: string;
    }
  | {
      kind: "candidate";
      cleanedText: string;
      candidate: MissionContractIntentCandidate;
    };

/**
 * Extracts one strict top-level control record into an ephemeral candidate.
 * This function cannot write the authoritative ledger. The host must show the
 * candidate and call the controller's explicit local-user admission method.
 */
export function parseMissionContractProposalIntent(
  replyText: string,
): MissionContractIntentParseResult {
  const lines = replyText.replace(/\r\n?/g, "\n").split("\n");
  const candidates: Array<{ index: number; payload: string }> = [];
  let fence: { character: "`" | "~"; length: number } | undefined;

  lines.forEach((line, index) => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(?:[^`~]*)$/.exec(line);
    if (fenceMatch) {
      const sequence = fenceMatch[1]!;
      const character = sequence[0] as "`" | "~";
      if (!fence) {
        fence = { character, length: sequence.length };
      } else if (fence.character === character && sequence.length >= fence.length) {
        fence = undefined;
      }
      return;
    }
    if (!fence && line.startsWith(MISSION_CONTRACT_PROPOSAL_MARKER)) {
      candidates.push({
        index,
        payload: line.slice(MISSION_CONTRACT_PROPOSAL_MARKER.length),
      });
    }
  });

  if (candidates.length === 0) return { kind: "none", cleanedText: replyText };
  const removed = new Set(candidates.map((candidate) => candidate.index));
  const cleanedText = normalizeCleanedText(lines.filter((_, index) => !removed.has(index)).join("\n"));
  if (candidates.length !== 1) {
    return {
      kind: "invalid",
      cleanedText,
      error: "Agent reply must contain exactly one top-level Mission Contract proposal control record.",
    };
  }

  const payload = candidates[0]!.payload;
  if (!payload.trim()) {
    return { kind: "invalid", cleanedText, error: "Mission Contract proposal payload is empty." };
  }
  if (Buffer.byteLength(payload, "utf8") > MAX_MISSION_CONTRACT_PROPOSAL_CONTROL_BYTES) {
    return {
      kind: "invalid",
      cleanedText,
      error: `Mission Contract proposal control record exceeds ${MAX_MISSION_CONTRACT_PROPOSAL_CONTROL_BYTES} bytes.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { kind: "invalid", cleanedText, error: "Mission Contract proposal payload is not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", cleanedText, error: "Mission Contract proposal payload must be an object." };
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "contract" || keys[1] !== "schemaVersion") {
    return {
      kind: "invalid",
      cleanedText,
      error: "Mission Contract proposal payload must contain exactly contract and schemaVersion.",
    };
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== MISSION_CONTRACT_SCHEMA_VERSION) {
    return {
      kind: "invalid",
      cleanedText,
      error: `Mission Contract proposal schemaVersion must equal ${MISSION_CONTRACT_SCHEMA_VERSION}.`,
    };
  }
  try {
    const contract = normalizeMissionContract(record.contract);
    return {
      kind: "candidate",
      cleanedText,
      candidate: {
        schemaVersion: MISSION_CONTRACT_SCHEMA_VERSION,
        contract,
        documentSha256: missionContractSha256(contract),
      },
    };
  } catch (error) {
    return {
      kind: "invalid",
      cleanedText,
      error: error instanceof Error ? error.message : "Invalid Mission Contract proposal.",
    };
  }
}

function normalizeCleanedText(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n").trim();
}
