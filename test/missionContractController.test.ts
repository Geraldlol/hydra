import { describe, test, type TestContext } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { serializePerFileAcrossProcesses } from "../src/fileQueue";
import {
  UNBOUND_MISSION_BINDING_SHA256,
  type MissionContractBinding,
} from "../src/missionContract";
import {
  openMissionContractController,
  tryOpenMissionContractController,
  type MissionContractController,
  type MissionContractIdKind,
} from "../src/missionContractController";
import {
  loadMissionContractLedger,
  privateMissionContractLedgerPath,
} from "../src/missionContractStore";
import { parseMissionContractProposalIntent } from "../src/missionContractIntent";
import { localProposalFixture, missionContractFixture } from "./missionContractFixtures";

async function tempPrivateRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-mission-controller-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function deterministicIds(prefix: string): (kind: MissionContractIdKind) => string {
  let sequence = 0;
  return (kind) => `${prefix}-${kind}-${++sequence}`;
}

function fixedNow(): string {
  return "2026-07-24T15:00:00.000Z";
}

async function pendingLocalProposal(controller: MissionContractController) {
  return controller.recordLocalProposal({
    missionId: "mission-1",
    expectedBaseBindingSha256: controller.currentBindingSha256(),
    contract: missionContractFixture(),
  });
}

describe("Mission Contract controller", () => {
  test("keeps a proposal unbound until a separate exact local confirmation", async (t) => {
    const root = await tempPrivateRoot(t);
    const controller = await openMissionContractController({
      privateWorkspaceRoot: root,
      now: fixedNow,
      newId: deterministicIds("local"),
    });
    const proposal = await pendingLocalProposal(controller);
    assert.equal(proposal.snapshot.binding.state, "unbound");
    assert.equal(proposal.event.type, "missionContractProposed");
    if (proposal.event.type !== "missionContractProposed") assert.fail("expected proposal");

    const confirmed = await controller.confirmProposalAfterLocalApproval({
      proposalId: proposal.event.proposalId,
      expectedDocumentSha256: proposal.event.documentSha256,
      expectedBaseBindingSha256: UNBOUND_MISSION_BINDING_SHA256,
    });
    assert.equal(confirmed.snapshot.binding.state, "active");
    assert.equal(confirmed.event.type, "missionContractConfirmed");
    if (confirmed.event.type !== "missionContractConfirmed") assert.fail("expected confirmation");
    assert.deepEqual(Object.keys(confirmed.event).sort(), [
      "confirmationId",
      "confirmedBy",
      "documentSha256",
      "eventId",
      "missionId",
      "occurredAt",
      "previousBindingSha256",
      "proposalId",
      "revision",
      "schemaVersion",
      "type",
    ]);
    assert.doesNotMatch(JSON.stringify(confirmed.event), /node --test|verificationCommand/);
    if (confirmed.snapshot.binding.state !== "active") assert.fail("expected active binding");
    assert.equal(confirmed.snapshot.binding.documentSha256, proposal.event.documentSha256);
    assert.notEqual(confirmed.snapshot.binding.bindingSha256, proposal.event.documentSha256);
  });

  test("agent control parsing remains ephemeral until explicit local-user admission", async (t) => {
    const root = await tempPrivateRoot(t);
    const controller = await openMissionContractController({
      privateWorkspaceRoot: root,
      now: fixedNow,
      newId: deterministicIds("agent"),
    });
    const contract = missionContractFixture();
    const parsed = parseMissionContractProposalIntent(
      `Proposal follows.\nHYDRA_MISSION_PROPOSAL_V1:${JSON.stringify({ schemaVersion: 1, contract })}`,
    );
    assert.equal(parsed.kind, "candidate");
    if (parsed.kind !== "candidate") assert.fail("expected candidate");
    assert.equal((await loadMissionContractLedger(controller.ledgerPath)).events.length, 0);
    assert.equal(controller.currentBindingSha256(), UNBOUND_MISSION_BINDING_SHA256);

    const admitted = await controller.admitAgentProposalAfterLocalApproval({
      missionId: "mission-agent",
      expectedBaseBindingSha256: UNBOUND_MISSION_BINDING_SHA256,
      expectedDocumentSha256: parsed.candidate.documentSha256,
      contract: parsed.candidate.contract,
      source: {
        agentId: "claude",
        callId: "call-1",
        messageId: "message-1",
        responseSha256: "a".repeat(64),
      },
    });
    assert.equal(admitted.event.type, "missionContractProposed");
    if (admitted.event.type !== "missionContractProposed") assert.fail("expected admitted proposal");
    assert.equal(admitted.event.proposedBy.kind, "agent");
    assert.equal(admitted.event.admittedBy.actorId, "local-user");
    assert.equal(admitted.event.admittedBy.action, "Admit Agent Mission Contract Proposal");
    assert.equal(admitted.snapshot.binding.state, "unbound");
  });

  test("cross-window compare-and-append permits exactly one concurrent confirmation", async (t) => {
    const root = await tempPrivateRoot(t);
    const first = await openMissionContractController({
      privateWorkspaceRoot: root,
      now: fixedNow,
      newId: deterministicIds("first"),
    });
    const proposal = await pendingLocalProposal(first);
    assert.equal(proposal.event.type, "missionContractProposed");
    if (proposal.event.type !== "missionContractProposed") assert.fail("expected proposal");
    const second = await openMissionContractController({
      privateWorkspaceRoot: root,
      now: fixedNow,
      newId: deterministicIds("second"),
    });
    const input = {
      proposalId: proposal.event.proposalId,
      expectedDocumentSha256: proposal.event.documentSha256,
      expectedBaseBindingSha256: UNBOUND_MISSION_BINDING_SHA256,
    };
    const results = await Promise.allSettled([
      first.confirmProposalAfterLocalApproval(input),
      second.confirmProposalAfterLocalApproval(input),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await loadMissionContractLedger(first.ledgerPath)).snapshot.binding.state, "active");
  });

  test("linearizes provider submission against confirmation using the same ledger lease", async (t) => {
    const root = await tempPrivateRoot(t);
    const submitter = await openMissionContractController({
      privateWorkspaceRoot: root,
      now: fixedNow,
      newId: deterministicIds("submit"),
    });
    const proposal = await pendingLocalProposal(submitter);
    if (proposal.event.type !== "missionContractProposed") assert.fail("expected proposal");
    const confirmer = await openMissionContractController({
      privateWorkspaceRoot: root,
      now: fixedNow,
      newId: deterministicIds("confirm"),
    });

    let enterSubmit!: () => void;
    const entered = new Promise<void>((resolve) => { enterSubmit = resolve; });
    let releaseSubmit!: () => void;
    const release = new Promise<void>((resolve) => { releaseSubmit = resolve; });
    const order: string[] = [];
    const submit = submitter.withCurrentBinding(
      UNBOUND_MISSION_BINDING_SHA256,
      async (binding: MissionContractBinding) => {
        assert.equal(binding.state, "unbound");
        order.push("submit-enter");
        enterSubmit();
        await release;
        order.push("submit-exit");
      },
    );
    await entered;
    let confirmationSettled = false;
    const confirm = confirmer.confirmProposalAfterLocalApproval({
      proposalId: proposal.event.proposalId,
      expectedDocumentSha256: proposal.event.documentSha256,
      expectedBaseBindingSha256: UNBOUND_MISSION_BINDING_SHA256,
    }).then((result) => {
      confirmationSettled = true;
      order.push("confirm");
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(confirmationSettled, false);
    releaseSubmit();
    await submit;
    await confirm;
    assert.deepEqual(order, ["submit-enter", "submit-exit", "confirm"]);
  });

  test("corruption between legs rejects freshness and never degrades an active binding to unbound", async (t) => {
    const root = await tempPrivateRoot(t);
    const controller = await openMissionContractController({
      privateWorkspaceRoot: root,
      now: fixedNow,
      newId: deterministicIds("corrupt"),
    });
    const proposal = await pendingLocalProposal(controller);
    if (proposal.event.type !== "missionContractProposed") assert.fail("expected proposal");
    const confirmed = await controller.confirmProposalAfterLocalApproval({
      proposalId: proposal.event.proposalId,
      expectedDocumentSha256: proposal.event.documentSha256,
      expectedBaseBindingSha256: UNBOUND_MISSION_BINDING_SHA256,
    });
    if (confirmed.snapshot.binding.state !== "active") assert.fail("expected active");
    const activeBinding = confirmed.snapshot.binding.bindingSha256;
    await controller.assertCurrentBinding(activeBinding);

    await fs.appendFile(controller.ledgerPath, "{corrupt}\n", "utf8");
    await assert.rejects(controller.assertCurrentBinding(activeBinding), /malformed JSON/);
    assert.equal(controller.getStatus().status, "corrupt");
    assert.throws(() => controller.currentBinding(), /unavailable/);
    const reopened = await tryOpenMissionContractController({ privateWorkspaceRoot: root });
    assert.equal(reopened.status, "corrupt");
  });

  test("refresh observes another window and mirror failure cannot undo durable activation", async (t) => {
    const root = await tempPrivateRoot(t);
    const impossibleMirror = path.join(root, "mirror-as-directory");
    await fs.mkdir(impossibleMirror, { recursive: true });
    const writer = await openMissionContractController({
      privateWorkspaceRoot: root,
      mirrorPath: impossibleMirror,
      now: fixedNow,
      newId: deterministicIds("writer"),
    });
    const reader = await openMissionContractController({
      privateWorkspaceRoot: root,
      now: fixedNow,
      newId: deterministicIds("reader"),
    });
    const proposal = await pendingLocalProposal(writer);
    assert.equal(proposal.mirrorUpdated, false);
    assert.ok(proposal.mirrorError);
    if (proposal.event.type !== "missionContractProposed") assert.fail("expected proposal");
    const confirmed = await writer.confirmProposalAfterLocalApproval({
      proposalId: proposal.event.proposalId,
      expectedDocumentSha256: proposal.event.documentSha256,
      expectedBaseBindingSha256: UNBOUND_MISSION_BINDING_SHA256,
    });
    assert.equal(confirmed.snapshot.binding.state, "active");
    assert.equal(reader.currentBinding().state, "unbound");
    const refreshed = await reader.refresh();
    assert.equal(refreshed.binding.state, "active");
    assert.equal((await loadMissionContractLedger(writer.ledgerPath)).snapshot.binding.state, "active");
  });

  test("refresh, open, and tryOpen wait through another window's partial append", async (t) => {
    const root = await tempPrivateRoot(t);
    const controller = await openMissionContractController({
      privateWorkspaceRoot: root,
      now: fixedNow,
      newId: deterministicIds("reader"),
    });
    const row = Buffer.from(`${JSON.stringify(localProposalFixture())}\n`, "utf8");
    const splitAt = row.length - 1;
    let signalPartialWrite!: () => void;
    const partialWrite = new Promise<void>((resolve) => {
      signalPartialWrite = resolve;
    });
    let finishAppend!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      finishAppend = resolve;
    });

    const writer = serializePerFileAcrossProcesses(controller.ledgerPath, async () => {
      await fs.appendFile(controller.ledgerPath, row.subarray(0, splitAt));
      signalPartialWrite();
      await mayFinish;
      await fs.appendFile(controller.ledgerPath, row.subarray(splitAt));
    });
    await partialWrite;

    const settled = { refresh: false, open: false, tryOpen: false };
    const refresh = controller.refresh().then((snapshot) => {
      settled.refresh = true;
      return snapshot;
    });
    const open = openMissionContractController({
      privateWorkspaceRoot: root,
    }).then((opened) => {
      settled.open = true;
      return opened;
    });
    const tryOpen = tryOpenMissionContractController({
      privateWorkspaceRoot: root,
    }).then((result) => {
      settled.tryOpen = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(settled, { refresh: false, open: false, tryOpen: false });
    assert.equal(controller.getStatus().status, "ready");

    finishAppend();
    await writer;
    const [refreshed, opened, attempted] = await Promise.all([refresh, open, tryOpen]);
    assert.equal(refreshed.proposals.length, 1);
    assert.equal(opened.currentSnapshot().proposals.length, 1);
    assert.equal(attempted.status, "ready");
    if (attempted.status !== "ready") assert.fail("expected ready controller");
    assert.equal(attempted.controller.currentSnapshot().proposals.length, 1);
  });

  test("identical-document amendment changes the binding digest and exact retirement returns to sentinel", async (t) => {
    const root = await tempPrivateRoot(t);
    const controller = await openMissionContractController({
      privateWorkspaceRoot: root,
      now: fixedNow,
      newId: deterministicIds("revision"),
    });
    const firstProposal = await pendingLocalProposal(controller);
    if (firstProposal.event.type !== "missionContractProposed") assert.fail("expected proposal");
    const firstConfirmation = await controller.confirmProposalAfterLocalApproval({
      proposalId: firstProposal.event.proposalId,
      expectedDocumentSha256: firstProposal.event.documentSha256,
      expectedBaseBindingSha256: UNBOUND_MISSION_BINDING_SHA256,
    });
    if (firstConfirmation.snapshot.binding.state !== "active") assert.fail("expected active");
    const first = firstConfirmation.snapshot.binding;

    const amendment = await controller.recordLocalProposal({
      expectedBaseBindingSha256: first.bindingSha256,
      expectedDocumentSha256: first.documentSha256,
      contract: first.contract,
    });
    if (amendment.event.type !== "missionContractProposed") assert.fail("expected amendment");
    const secondConfirmation = await controller.confirmProposalAfterLocalApproval({
      proposalId: amendment.event.proposalId,
      expectedDocumentSha256: amendment.event.documentSha256,
      expectedBaseBindingSha256: first.bindingSha256,
    });
    if (secondConfirmation.snapshot.binding.state !== "active") assert.fail("expected amendment active");
    const second = secondConfirmation.snapshot.binding;
    assert.equal(second.documentSha256, first.documentSha256);
    assert.notEqual(second.bindingSha256, first.bindingSha256);
    assert.equal(second.revision, 2);

    const retired = await controller.retireActiveAfterLocalApproval({
      expectedMissionId: second.missionId,
      expectedRevision: second.revision,
      expectedDocumentSha256: second.documentSha256,
      expectedBindingSha256: second.bindingSha256,
      reason: "Explicitly retired after completion.",
    });
    assert.equal(retired.snapshot.binding.state, "unbound");
    assert.equal(retired.snapshot.binding.bindingSha256, UNBOUND_MISSION_BINDING_SHA256);
  });

  test("private path is workspace-specific and never points at the .hydra mirror", async (t) => {
    const root = await tempPrivateRoot(t);
    const ledger = privateMissionContractLedgerPath(root);
    assert.equal(ledger, path.join(root, "mission", "contract-events.v1.jsonl"));
    assert.doesNotMatch(ledger, /[\\/]\.hydra[\\/]/);
  });
});
