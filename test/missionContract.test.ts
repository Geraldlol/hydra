import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  MISSION_CONTRACT_LIMITS,
  MISSION_CONTRACT_SCHEMA_VERSION,
  UNBOUND_MISSION_BINDING_SHA256,
  canonicalMissionContractJson,
  evaluateMissionMutation,
  evaluateMissionMutationOnDisk,
  missionContractBindingSha256,
  missionContractSha256,
  normalizeMissionContract,
  normalizeMissionRelativePath,
  replayMissionContractEvents,
  type MissionContractConfirmedEvent,
  type MissionContractEvent,
  type MissionContractRetiredEvent,
} from "../src/missionContract";
import {
  TEST_OCCURRED_AT,
  localProposalFixture,
  missionContractFixture,
} from "./missionContractFixtures";

const NEXT_OCCURRED_AT = "2026-07-24T12:01:00.000Z";

function confirmation(
  proposal: ReturnType<typeof localProposalFixture>,
  eventId: string,
  previousBindingSha256: string,
  revision: number,
): MissionContractConfirmedEvent {
  return {
    schemaVersion: MISSION_CONTRACT_SCHEMA_VERSION,
    type: "missionContractConfirmed",
    eventId,
    occurredAt: NEXT_OCCURRED_AT,
    missionId: proposal.missionId,
    proposalId: proposal.proposalId,
    confirmationId: `confirmation-${revision}`,
    documentSha256: proposal.documentSha256,
    previousBindingSha256,
    revision,
    confirmedBy: "local-user",
  };
}

describe("Mission Contract canonical domain", () => {
  test("pins the domain-separated canonical document hash with a golden vector", () => {
    const contract = missionContractFixture();
    assert.equal(
      missionContractSha256(contract),
      "220f6a475eef5dc62086666b9a37e85adc3d6d420d7912607072befc7745f23f",
    );
    assert.match(canonicalMissionContractJson(contract), /^\{"schemaVersion":1,"title":/);
    assert.equal(
      UNBOUND_MISSION_BINDING_SHA256,
      "5de67848e9afe4067946767f75b16b7832a9bea9c2c1e6b91f167fd5fe7b951b",
    );
  });

  test("normalizes NFC, CRLF, path separators, set-like ordering, and defends against caller mutation", () => {
    const raw = {
      ...structuredClone(missionContractFixture()),
      title: "Cafe\u0301\r\nMission",
      allowedMutations: [
        {
          id: "z",
          path: "src\\z",
          includeDescendants: true,
          operations: ["rename", "create", "modify"],
          reason: "Z",
        },
        {
          id: "a",
          path: "src\\a",
          includeDescendants: false,
          operations: ["modify", "create"],
          reason: "A",
        },
      ],
    };
    const normalized = normalizeMissionContract(raw);
    assert.equal(normalized.title, "Café\nMission");
    assert.deepEqual(normalized.allowedMutations.map((rule) => rule.path), ["src/a", "src/z"]);
    assert.deepEqual(normalized.allowedMutations[1]?.operations, ["create", "modify", "rename"]);
    raw.title = "Mutated after normalization";
    assert.equal(normalized.title, "Café\nMission");
    assert.throws(() => {
      (normalized as { title: string }).title = "attempted mutation";
    }, TypeError);
    const composed = normalizeMissionContract({
      ...raw,
      title: "Café\nMission",
    });
    assert.equal(missionContractSha256(normalized), missionContractSha256(composed));
  });

  test("rejects unknown keys at every strict boundary and invalid references", () => {
    const contract = structuredClone(missionContractFixture()) as MissionContractDocumentWithUnknown;
    contract.unknown = true;
    assert.throws(() => normalizeMissionContract(contract), /unknown unknown/);

    const nested = structuredClone(missionContractFixture()) as MissionContractDocumentWithUnknown;
    (nested.budgets as unknown as Record<string, unknown>).extra = 1;
    assert.throws(() => normalizeMissionContract(nested), /budgets.*unknown extra/);

    const unknownRef = structuredClone(missionContractFixture());
    unknownRef.evidenceRequirements[0]!.acceptanceCheckIds = ["does-not-exist"];
    assert.throws(() => normalizeMissionContract(unknownRef), /unknown acceptance check/);

    const proposal = localProposalFixture();
    assert.throws(
      () => replayMissionContractEvents([{ ...proposal, injected: "authority" }]),
      /unknown injected/,
    );
  });

  test("rejects unsafe Unicode, numeric values, and document-size overflow", () => {
    assert.throws(
      () => normalizeMissionContract({ ...structuredClone(missionContractFixture()), title: "safe\u202eevil" }),
      /bidirectional control/,
    );
    assert.throws(
      () => normalizeMissionContract({
        ...structuredClone(missionContractFixture()),
        budgets: {
          ...missionContractFixture().budgets,
          maxCostUsd: -0,
        },
      }),
      /negative zero/,
    );
    assert.throws(
      () => normalizeMissionContract({
        ...structuredClone(missionContractFixture()),
        outcome: "x".repeat(MISSION_CONTRACT_LIMITS.outcomeChars + 1),
      }),
      /must not exceed/,
    );
  });

  test("accepts the UTF-8 document cap minus one and rejects cap plus one", () => {
    const raw = {
      schemaVersion: 1,
      title: "Boundary",
      outcome: "Boundary",
      acceptanceChecks: [{
        id: "check",
        kind: "manual",
        label: "Check",
        instructions: "Check",
      }],
      protectedPaths: [],
      allowedMutations: [],
      budgets: {
        maxCostUsd: null,
        maxAgentCalls: null,
        maxWallClockMs: null,
        maxRetries: null,
      },
      evidenceRequirements: Array.from({ length: 20 }, (_, index) => ({
        id: `evidence-${index}`,
        kind: "humanDecision",
        description: "x",
        acceptanceCheckIds: ["check"],
      })),
      nonGoals: [],
    };
    const baseBytes = Buffer.byteLength(canonicalMissionContractJson(raw), "utf8");
    let remaining = (MISSION_CONTRACT_LIMITS.contractBytes - 1) - baseBytes;
    assert.ok(remaining > 0);
    for (const requirement of raw.evidenceRequirements) {
      const addition = Math.min(
        remaining,
        MISSION_CONTRACT_LIMITS.longTextChars - requirement.description.length,
      );
      requirement.description += "x".repeat(addition);
      remaining -= addition;
    }
    assert.equal(remaining, 0);
    const capMinusOne = normalizeMissionContract(raw);
    assert.equal(
      Buffer.byteLength(canonicalMissionContractJson(capMinusOne), "utf8"),
      MISSION_CONTRACT_LIMITS.contractBytes - 1,
    );
    const adjustable = raw.evidenceRequirements.find(
      (requirement) => requirement.description.length
        <= MISSION_CONTRACT_LIMITS.longTextChars - 2,
    );
    assert.ok(adjustable);
    adjustable.description += "xx";
    assert.throws(() => normalizeMissionContract(raw), /canonical encoding must not exceed/);
  });

  test("rejects traversal, reserved metadata, ADS, ambiguous Windows names, and device paths", () => {
    const unsafe = [
      "../outside",
      "..\\outside",
      "src/../outside",
      "C:\\outside",
      "\\\\server\\share",
      "/absolute",
      "src//double",
      "src/.git/config",
      "src/.HYDRA/state",
      "src/file:stream",
      "src/trailing.",
      "src/trailing ",
      "src/CON",
      "src/com1.txt",
      "src/\u202espoof",
    ];
    unsafe.forEach((candidate) => {
      assert.throws(() => normalizeMissionRelativePath(candidate), { message: /./ }, candidate);
    });
    assert.equal(normalizeMissionRelativePath("src\\safe\\file.ts"), "src/safe/file.ts");
  });

  test("protected paths win, unmatched paths fail, and rename checks both sides", () => {
    const contract = missionContractFixture();
    assert.equal(
      evaluateMissionMutation(contract, { operation: "modify", path: "src/main.ts" }).allowed,
      true,
    );
    assert.match(
      evaluateMissionMutation(contract, { operation: "modify", path: "secrets/key.txt" }).reason,
      /protected path/,
    );
    assert.equal(
      evaluateMissionMutation(contract, { operation: "delete", path: "src/main.ts" }).allowed,
      false,
    );
    assert.equal(
      evaluateMissionMutation(contract, {
        operation: "rename",
        fromPath: "src/old.ts",
        toPath: "test/new.ts",
      }).allowed,
      true,
    );
    assert.match(
      evaluateMissionMutation(contract, {
        operation: "rename",
        fromPath: "src/old.ts",
        toPath: "docs/new.ts",
      }).reason,
      /destination denied/,
    );
    assert.equal(
      evaluateMissionMutation(contract, {
        operation: "rename",
        fromPath: ".git/config",
        toPath: "src/config",
      }).allowed,
      false,
    );
  });

  test("on-disk evaluation rejects a symlink or junction escaping the workspace", async (t) => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-mission-path-"));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const workspace = path.join(temp, "workspace");
    const outside = path.join(temp, "outside");
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    try {
      await fs.symlink(outside, path.join(workspace, "src", "escape"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Host does not permit creating a test junction.");
        return;
      }
      throw error;
    }
    const decision = await evaluateMissionMutationOnDisk(
      workspace,
      missionContractFixture(),
      { operation: "create", path: "src/escape/payload.ts" },
    );
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /outside the workspace/);
  });
});

describe("Mission Contract append-only replay", () => {
  test("activates, amends an identical document with a fresh binding digest, retires, and starts a new mission", () => {
    const contract = missionContractFixture();
    const initialProposal = localProposalFixture("proposal-1", "mission-1", UNBOUND_MISSION_BINDING_SHA256, contract);
    const initialConfirmation = confirmation(
      initialProposal,
      "event-confirmation-1",
      UNBOUND_MISSION_BINDING_SHA256,
      1,
    );
    const initial = replayMissionContractEvents([initialProposal, initialConfirmation]);
    assert.equal(initial.binding.state, "active");
    if (initial.binding.state !== "active") assert.fail("expected active binding");
    assert.equal(initial.binding.documentSha256, initialProposal.documentSha256);
    const expectedInitialBinding = missionContractBindingSha256({
      missionId: "mission-1",
      revision: 1,
      confirmationEventId: "event-confirmation-1",
      documentSha256: initialProposal.documentSha256,
    });
    assert.equal(initial.binding.bindingSha256, expectedInitialBinding);

    const amendmentProposal = localProposalFixture(
      "proposal-2",
      "mission-1",
      initial.binding.bindingSha256,
      contract,
    );
    const amendmentConfirmation = {
      ...confirmation(amendmentProposal, "event-confirmation-2", initial.binding.bindingSha256, 2),
      confirmationId: "confirmation-2",
    };
    const amended = replayMissionContractEvents([
      initialProposal,
      initialConfirmation,
      amendmentProposal,
      amendmentConfirmation,
    ]);
    assert.equal(amended.binding.state, "active");
    if (amended.binding.state !== "active") assert.fail("expected amended binding");
    assert.equal(amended.binding.documentSha256, initial.binding.documentSha256);
    assert.notEqual(amended.binding.bindingSha256, initial.binding.bindingSha256);

    const retiredEvent: MissionContractRetiredEvent = {
      schemaVersion: MISSION_CONTRACT_SCHEMA_VERSION,
      type: "missionContractRetired",
      eventId: "event-retire-1",
      occurredAt: "2026-07-24T12:02:00.000Z",
      missionId: amended.binding.missionId,
      retirementId: "retirement-1",
      documentSha256: amended.binding.documentSha256,
      bindingSha256: amended.binding.bindingSha256,
      revision: amended.binding.revision,
      retiredBy: "local-user",
      reason: "Mission complete.",
    };
    const retired = replayMissionContractEvents([
      initialProposal,
      initialConfirmation,
      amendmentProposal,
      amendmentConfirmation,
      retiredEvent,
    ]);
    assert.equal(retired.binding.state, "unbound");
    assert.equal(retired.binding.bindingSha256, UNBOUND_MISSION_BINDING_SHA256);

    const replacementProposal = localProposalFixture(
      "proposal-3",
      "mission-2",
      UNBOUND_MISSION_BINDING_SHA256,
      contract,
    );
    const replacementConfirmation = {
      ...confirmation(
        replacementProposal,
        "event-confirmation-3",
        UNBOUND_MISSION_BINDING_SHA256,
        1,
      ),
      confirmationId: "confirmation-3",
    };
    const replacement = replayMissionContractEvents([
      initialProposal,
      initialConfirmation,
      amendmentProposal,
      amendmentConfirmation,
      retiredEvent,
      replacementProposal,
      replacementConfirmation,
    ]);
    assert.equal(replacement.binding.state, "active");
    if (replacement.binding.state !== "active") assert.fail("expected replacement binding");
    assert.equal(replacement.binding.documentSha256, initial.binding.documentSha256);
    assert.notEqual(replacement.binding.bindingSha256, initial.binding.bindingSha256);
    assert.notEqual(replacement.binding.bindingSha256, amended.binding.bindingSha256);
  });

  test("proposal-only input has no authority and agent source requires explicit local admission evidence", () => {
    const proposal = localProposalFixture();
    const pending = replayMissionContractEvents([proposal]);
    assert.equal(pending.binding.state, "unbound");
    assert.equal(pending.proposals[0]?.status, "pending");

    const agentProposal = {
      ...proposal,
      proposedBy: {
        kind: "agent",
        agentId: "claude",
        callId: "call-1",
        messageId: "message-1",
        responseSha256: "a".repeat(64),
      },
    };
    assert.throws(() => replayMissionContractEvents([agentProposal]), /Admit Agent Mission Contract Proposal/);
    assert.doesNotThrow(() => replayMissionContractEvents([{
      ...agentProposal,
      admittedBy: {
        actorId: "local-user",
        action: "Admit Agent Mission Contract Proposal",
      },
    }]));
  });

  test("rejects stale confirmation and caps outstanding proposals without blocking existing history", () => {
    const proposals: MissionContractEvent[] = [];
    for (let index = 0; index < MISSION_CONTRACT_LIMITS.outstandingProposals; index += 1) {
      proposals.push(localProposalFixture(`proposal-${index}`, `mission-${index}`));
    }
    assert.equal(replayMissionContractEvents(proposals).proposals.length, MISSION_CONTRACT_LIMITS.outstandingProposals);
    assert.throws(
      () => replayMissionContractEvents([
        ...proposals,
        localProposalFixture("proposal-overflow", "mission-overflow"),
      ]),
      /outstanding proposals/,
    );

    const first = proposals[0] as ReturnType<typeof localProposalFixture>;
    const confirmed = confirmation(first, "event-confirm-first", UNBOUND_MISSION_BINDING_SHA256, 1);
    const snapshot = replayMissionContractEvents([...proposals, confirmed]);
    assert.equal(snapshot.proposals[1]?.status, "stale");
    const second = proposals[1] as ReturnType<typeof localProposalFixture>;
    assert.throws(
      () => replayMissionContractEvents([
        ...proposals,
        confirmed,
        {
          ...confirmation(second, "event-confirm-stale", snapshot.binding.bindingSha256, 2),
          confirmationId: "confirmation-stale",
        },
      ]),
      /stale proposal/,
    );
  });
});

interface MissionContractDocumentWithUnknown {
  schemaVersion: 1;
  title: string;
  outcome: string;
  acceptanceChecks: ReturnType<typeof missionContractFixture>["acceptanceChecks"];
  protectedPaths: ReturnType<typeof missionContractFixture>["protectedPaths"];
  allowedMutations: ReturnType<typeof missionContractFixture>["allowedMutations"];
  budgets: ReturnType<typeof missionContractFixture>["budgets"];
  evidenceRequirements: ReturnType<typeof missionContractFixture>["evidenceRequirements"];
  nonGoals: string[];
  unknown?: unknown;
}
