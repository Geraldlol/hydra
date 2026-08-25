import {
  MISSION_CONTRACT_SCHEMA_VERSION,
  type ActiveMissionContractBinding,
  type MissionContractDocument,
  type MissionContractProposalState,
  type MissionContractSnapshot,
} from "./missionContract";

export const MAX_EPHEMERAL_MISSION_CANDIDATES = 20;

export interface EphemeralMissionContractCandidate {
  candidateId: string;
  discoveredAt: string;
  expectedBaseBindingSha256: string;
  documentSha256: string;
  contract: MissionContractDocument;
  source: {
    agentId: string;
    callId: string;
    messageId: string;
    responseSha256: string;
  };
}

export interface MissionProposalChoice {
  proposalId: string;
  expectedDocumentSha256: string;
  expectedBaseBindingSha256: string;
}

export interface MissionCandidateChoice {
  candidateId: string;
  expectedDocumentSha256: string;
  expectedBaseBindingSha256: string;
}

export interface MissionRetirementChoice {
  expectedMissionId: string;
  expectedRevision: number;
  expectedDocumentSha256: string;
  expectedBindingSha256: string;
}

/**
 * A valid, deliberately conservative starting point for the operator editor.
 * It grants no mutations and leaves every budget bounded until edited.
 */
export function missionContractDraftTemplate(): MissionContractDocument {
  return {
    schemaVersion: MISSION_CONTRACT_SCHEMA_VERSION,
    title: "Describe the mission",
    outcome: "Describe the observable outcome Hydra must deliver.",
    acceptanceChecks: [
      {
        id: "human-review",
        kind: "manual",
        label: "Operator reviews the result",
        instructions: "Review the completed work against the exact Mission Contract.",
      },
    ],
    protectedPaths: [],
    allowedMutations: [],
    budgets: {
      maxCostUsd: 25,
      maxAgentCalls: 20,
      maxWallClockMs: 3_600_000,
      maxRetries: 2,
    },
    evidenceRequirements: [
      {
        id: "human-decision",
        kind: "humanDecision",
        description: "Record the operator's acceptance decision.",
        acceptanceCheckIds: ["human-review"],
      },
    ],
    nonGoals: ["No unlisted mutation or authority expansion."],
  };
}

export function requireExactPendingMissionProposal(
  snapshot: MissionContractSnapshot,
  choice: MissionProposalChoice,
): MissionContractProposalState {
  const selected = snapshot.proposals.find((candidate) =>
    candidate.proposal.proposalId === choice.proposalId
  );
  if (!selected) throw new Error(`Unknown Mission Contract proposal ${choice.proposalId}.`);
  if (selected.status !== "pending") {
    throw new Error(`Mission Contract proposal ${choice.proposalId} is ${selected.status}, not pending.`);
  }
  if (selected.proposal.documentSha256 !== choice.expectedDocumentSha256
    || selected.proposal.baseBindingSha256 !== choice.expectedBaseBindingSha256
    || snapshot.binding.bindingSha256 !== choice.expectedBaseBindingSha256) {
    throw new Error("Mission Contract proposal choice is stale; refresh and review the current exact terms.");
  }
  return structuredClone(selected);
}

export function requireExactMissionCandidate(
  candidates: readonly EphemeralMissionContractCandidate[],
  currentBindingSha256: string,
  choice: MissionCandidateChoice,
): EphemeralMissionContractCandidate {
  const selected = candidates.find((candidate) => candidate.candidateId === choice.candidateId);
  if (!selected) throw new Error(`Unknown or expired Mission proposal candidate ${choice.candidateId}.`);
  if (selected.documentSha256 !== choice.expectedDocumentSha256
    || selected.expectedBaseBindingSha256 !== choice.expectedBaseBindingSha256
    || currentBindingSha256 !== choice.expectedBaseBindingSha256) {
    throw new Error("Mission proposal candidate choice is stale; ask the agent to propose against the current binding.");
  }
  return structuredClone(selected);
}

export function requireExactActiveMission(
  snapshot: MissionContractSnapshot,
  choice: MissionRetirementChoice,
): ActiveMissionContractBinding {
  const binding = snapshot.binding;
  if (binding.state !== "active") throw new Error("There is no active Mission Contract to retire.");
  if (binding.missionId !== choice.expectedMissionId
    || binding.revision !== choice.expectedRevision
    || binding.documentSha256 !== choice.expectedDocumentSha256
    || binding.bindingSha256 !== choice.expectedBindingSha256) {
    throw new Error("Active Mission Contract choice is stale; refresh and review the current exact terms.");
  }
  return structuredClone(binding);
}

export function boundedMissionCandidates(
  candidates: readonly EphemeralMissionContractCandidate[],
): EphemeralMissionContractCandidate[] {
  return candidates.slice(-MAX_EPHEMERAL_MISSION_CANDIDATES).map((candidate) => structuredClone(candidate));
}
