import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  missionContractBindingSha256,
  missionContractSha256,
  replayMissionContractEvents,
  UNBOUND_MISSION_BINDING_SHA256,
} from "../src/missionContract";
import {
  boundedMissionCandidates,
  MAX_EPHEMERAL_MISSION_CANDIDATES,
  missionContractDraftTemplate,
  requireExactActiveMission,
  requireExactMissionCandidate,
  requireExactPendingMissionProposal,
  type EphemeralMissionContractCandidate,
} from "../src/missionContractSurface";
import { localProposalFixture, missionContractFixture } from "./missionContractFixtures";

describe("Mission Contract operator surface protocol", () => {
  test("ships a valid conservative draft that grants no mutations", () => {
    const draft = missionContractDraftTemplate();
    assert.equal(draft.schemaVersion, 1);
    assert.deepEqual(draft.allowedMutations, []);
    assert.ok(draft.acceptanceChecks.length > 0);
    assert.ok(draft.evidenceRequirements.length > 0);
    assert.match(missionContractSha256(draft), /^[a-f0-9]{64}$/);
  });

  test("rejects a pending proposal choice after the active base changes", () => {
    const proposal = localProposalFixture();
    const pending = replayMissionContractEvents([proposal]);
    const choice = {
      proposalId: proposal.proposalId,
      expectedDocumentSha256: proposal.documentSha256,
      expectedBaseBindingSha256: proposal.baseBindingSha256,
    };
    assert.equal(requireExactPendingMissionProposal(pending, choice).proposal.proposalId, proposal.proposalId);

    const confirmation = {
      schemaVersion: 1 as const,
      type: "missionContractConfirmed" as const,
      eventId: "event-confirm",
      occurredAt: "2026-07-24T15:00:00.000Z",
      missionId: proposal.missionId,
      proposalId: proposal.proposalId,
      confirmationId: "confirmation-1",
      documentSha256: proposal.documentSha256,
      previousBindingSha256: proposal.baseBindingSha256,
      revision: 1,
      confirmedBy: "local-user" as const,
    };
    const active = replayMissionContractEvents([proposal, confirmation]);
    assert.throws(
      () => requireExactPendingMissionProposal(active, choice),
      /confirmed, not pending|stale/,
    );
  });

  test("rejects stale candidate admission and stale retirement choices", () => {
    const contract = missionContractFixture();
    const candidate: EphemeralMissionContractCandidate = {
      candidateId: "candidate-1",
      discoveredAt: "2026-07-24T15:00:00.000Z",
      expectedBaseBindingSha256: UNBOUND_MISSION_BINDING_SHA256,
      documentSha256: missionContractSha256(contract),
      contract,
      source: {
        agentId: "codex",
        callId: "call-1",
        messageId: "message-1",
        responseSha256: "a".repeat(64),
      },
    };
    assert.equal(
      requireExactMissionCandidate([candidate], UNBOUND_MISSION_BINDING_SHA256, {
        candidateId: candidate.candidateId,
        expectedDocumentSha256: candidate.documentSha256,
        expectedBaseBindingSha256: candidate.expectedBaseBindingSha256,
      }).candidateId,
      candidate.candidateId,
    );
    assert.throws(
      () => requireExactMissionCandidate([candidate], "b".repeat(64), {
        candidateId: candidate.candidateId,
        expectedDocumentSha256: candidate.documentSha256,
        expectedBaseBindingSha256: candidate.expectedBaseBindingSha256,
      }),
      /stale/,
    );

    const proposal = localProposalFixture("proposal-active", "mission-active");
    const confirmationEventId = "event-confirm-active";
    const active = replayMissionContractEvents([proposal, {
      schemaVersion: 1,
      type: "missionContractConfirmed",
      eventId: confirmationEventId,
      occurredAt: "2026-07-24T15:01:00.000Z",
      missionId: proposal.missionId,
      proposalId: proposal.proposalId,
      confirmationId: "confirmation-active",
      documentSha256: proposal.documentSha256,
      previousBindingSha256: proposal.baseBindingSha256,
      revision: 1,
      confirmedBy: "local-user",
    }]);
    if (active.binding.state !== "active") assert.fail("expected active binding");
    const retirement = {
      expectedMissionId: active.binding.missionId,
      expectedRevision: active.binding.revision,
      expectedDocumentSha256: active.binding.documentSha256,
      expectedBindingSha256: active.binding.bindingSha256,
    };
    assert.equal(requireExactActiveMission(active, retirement).missionId, proposal.missionId);
    assert.throws(
      () => requireExactActiveMission(active, { ...retirement, expectedRevision: 2 }),
      /stale/,
    );
    assert.equal(
      active.binding.bindingSha256,
      missionContractBindingSha256({
        missionId: proposal.missionId,
        revision: 1,
        confirmationEventId,
        documentSha256: proposal.documentSha256,
      }),
    );
  });

  test("bounds untrusted ephemeral candidates without writing authority", () => {
    const contract = missionContractFixture();
    const candidates = Array.from({ length: MAX_EPHEMERAL_MISSION_CANDIDATES + 3 }, (_, index) => ({
      candidateId: `candidate-${index}`,
      discoveredAt: "2026-07-24T15:00:00.000Z",
      expectedBaseBindingSha256: UNBOUND_MISSION_BINDING_SHA256,
      documentSha256: missionContractSha256(contract),
      contract,
      source: {
        agentId: "codex",
        callId: `call-${index}`,
        messageId: `message-${index}`,
        responseSha256: "a".repeat(64),
      },
    }));
    const bounded = boundedMissionCandidates(candidates);
    assert.equal(bounded.length, MAX_EPHEMERAL_MISSION_CANDIDATES);
    assert.equal(bounded[0]?.candidateId, "candidate-3");
  });
});
