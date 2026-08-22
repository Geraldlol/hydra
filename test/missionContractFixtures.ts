import {
  MISSION_CONTRACT_SCHEMA_VERSION,
  UNBOUND_MISSION_BINDING_SHA256,
  missionContractSha256,
  normalizeMissionContract,
  type MissionContractDocument,
  type MissionContractProposedEvent,
} from "../src/missionContract";

export const TEST_OCCURRED_AT = "2026-07-24T12:00:00.000Z";

export function missionContractFixture(
  overrides: Partial<Omit<MissionContractDocument, "schemaVersion">> = {},
): MissionContractDocument {
  return normalizeMissionContract({
    schemaVersion: MISSION_CONTRACT_SCHEMA_VERSION,
    title: "Ship the Mission Contract foundation",
    outcome: "Hydra binds every governed operation to an explicitly confirmed mission.",
    acceptanceChecks: [
      {
        id: "unit-tests",
        kind: "verificationCommand",
        label: "Focused tests pass",
        command: "node --test dist/test/missionContract.test.js",
        expectedExitCode: 0,
      },
      {
        id: "human-review",
        kind: "manual",
        label: "Human reviews scope",
        instructions: "Review commands, paths, budgets, evidence, and non-goals.",
      },
    ],
    protectedPaths: [
      {
        path: "secrets",
        includeDescendants: true,
        reason: "Never modify secret fixtures.",
      },
    ],
    allowedMutations: [
      {
        id: "source-write",
        path: "src",
        includeDescendants: true,
        operations: ["rename", "modify", "create"],
        reason: "Implement the requested source slice.",
      },
      {
        id: "test-write",
        path: "test",
        includeDescendants: true,
        operations: ["create", "modify", "rename"],
        reason: "Add focused verification.",
      },
    ],
    budgets: {
      maxCostUsd: 25,
      maxAgentCalls: 20,
      maxWallClockMs: 3_600_000,
      maxRetries: 2,
    },
    evidenceRequirements: [
      {
        id: "test-receipt",
        kind: "verificationReceipt",
        description: "Capture the exact focused test result.",
        acceptanceCheckIds: ["unit-tests"],
      },
      {
        id: "review-decision",
        kind: "humanDecision",
        description: "Record the explicit local review decision.",
        acceptanceCheckIds: ["human-review"],
      },
    ],
    nonGoals: ["No push, publish, deploy, or automatic authority expansion."],
    ...overrides,
  });
}

export function localProposalFixture(
  proposalId = "proposal-1",
  missionId = "mission-1",
  baseBindingSha256 = UNBOUND_MISSION_BINDING_SHA256,
  contract = missionContractFixture(),
): MissionContractProposedEvent {
  return {
    schemaVersion: MISSION_CONTRACT_SCHEMA_VERSION,
    type: "missionContractProposed",
    eventId: `event-${proposalId}`,
    occurredAt: TEST_OCCURRED_AT,
    missionId,
    proposalId,
    baseBindingSha256,
    proposedBy: { kind: "localUser", actorId: "local-user" },
    admittedBy: { actorId: "local-user", action: "Record Local Mission Contract Proposal" },
    documentSha256: missionContractSha256(contract),
    contract,
  };
}
