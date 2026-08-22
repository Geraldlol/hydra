import { describe, test, type TestContext } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { serializePerFileAcrossProcesses } from "../src/fileQueue";
import {
  MISSION_CONTRACT_LIMITS,
  UNBOUND_MISSION_BINDING_SHA256,
  replayMissionContractEvents,
  type MissionContractEvent,
  type MissionContractProposedEvent,
} from "../src/missionContract";
import {
  MAX_MISSION_CONTRACT_LEDGER_BYTES,
  MAX_MISSION_CONTRACT_LEDGER_EVENTS,
  MAX_MISSION_CONTRACT_LEDGER_LINE_BYTES,
  MISSION_CONTRACT_TERMINAL_EVENT_RESERVE_BYTES,
  assessMissionContractLedgerCapacity,
  inspectMissionContractLedger,
  loadMissionContractLedger,
  mutateMissionContractLedger,
  renderMissionContractMarkdown,
} from "../src/missionContractStore";
import { localProposalFixture, missionContractFixture } from "./missionContractFixtures";

async function tempLedger(t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-mission-store-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "private", "mission", "contract-events.v1.jsonl");
}

describe("Mission Contract private store", () => {
  test("creates a valid empty ledger whose state is explicitly unbound", async (t) => {
    const ledger = await tempLedger(t);
    const state = await loadMissionContractLedger(ledger);
    assert.equal(state.events.length, 0);
    assert.equal(state.snapshot.binding.state, "unbound");
    assert.equal(state.snapshot.binding.bindingSha256, UNBOUND_MISSION_BINDING_SHA256);
    assert.equal((await fs.readFile(ledger, "utf8")), "");
  });

  test("serializes concurrent compare-and-append proposals without losing either", async (t) => {
    const ledger = await tempLedger(t);
    const add = (suffix: string): Promise<unknown> => mutateMissionContractLedger(ledger, (state) => {
      assert.equal(state.snapshot.binding.state, "unbound");
      return [localProposalFixture(
        `proposal-${suffix}`,
        `mission-${suffix}`,
        state.snapshot.binding.bindingSha256,
      )];
    });
    await Promise.all([add("a"), add("b")]);
    const state = await loadMissionContractLedger(ledger);
    assert.equal(state.events.length, 2);
    assert.deepEqual(
      new Set(state.snapshot.proposals.map((proposal) => proposal.proposal.proposalId)),
      new Set(["proposal-a", "proposal-b"]),
    );
  });

  test("fails closed on torn, malformed, empty, unknown, oversized-row, and oversized-file histories", async (t) => {
    const ledger = await tempLedger(t);
    await fs.mkdir(path.dirname(ledger), { recursive: true });
    const proposal = localProposalFixture();

    await fs.writeFile(ledger, JSON.stringify(proposal), "utf8");
    await assert.rejects(loadMissionContractLedger(ledger), /torn final row/);

    await fs.writeFile(ledger, "{not-json}\n", "utf8");
    await assert.rejects(loadMissionContractLedger(ledger), /malformed JSON/);

    await fs.writeFile(ledger, "\n", "utf8");
    await assert.rejects(loadMissionContractLedger(ledger), /empty row/);

    await fs.writeFile(ledger, `${JSON.stringify({ ...proposal, extra: true })}\n`, "utf8");
    await assert.rejects(loadMissionContractLedger(ledger), /unknown extra/);

    const oversizedRow = JSON.stringify({ payload: "x".repeat(MAX_MISSION_CONTRACT_LEDGER_LINE_BYTES) });
    await fs.writeFile(ledger, `${oversizedRow}\n`, "utf8");
    await assert.rejects(loadMissionContractLedger(ledger), /oversized row/);

    const handle = await fs.open(ledger, "w");
    try {
      await handle.truncate(MAX_MISSION_CONTRACT_LEDGER_BYTES + 1);
    } finally {
      await handle.close();
    }
    await assert.rejects(loadMissionContractLedger(ledger), /exceeds/);
  });

  test("fatally rejects a truncated UTF-8 code point before JSON parsing", async (t) => {
    const ledger = await tempLedger(t);
    await fs.mkdir(path.dirname(ledger), { recursive: true });
    // Buffer.toString("utf8") replaces this incomplete three-byte prefix with
    // one U+FFFD whose encoded length is also three bytes. A byte-length
    // round-trip therefore cannot detect the corruption.
    const invalid = Buffer.concat([
      Buffer.from('{"payload":"', "utf8"),
      Buffer.from([0xf0, 0x9f, 0x92]),
      Buffer.from('"}\n', "utf8"),
    ]);
    await fs.writeFile(ledger, invalid);

    await assert.rejects(
      loadMissionContractLedger(ledger),
      /not valid canonical UTF-8/,
    );
  });

  test("leased readers wait for a cross-window append to become complete", async (t) => {
    const ledger = await tempLedger(t);
    await loadMissionContractLedger(ledger);
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

    const writer = serializePerFileAcrossProcesses(ledger, async () => {
      await fs.appendFile(ledger, row.subarray(0, splitAt));
      signalPartialWrite();
      await mayFinish;
      await fs.appendFile(ledger, row.subarray(splitAt));
    });
    await partialWrite;

    let readSettled = false;
    const reader = loadMissionContractLedger(ledger).then((state) => {
      readSettled = true;
      return state;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readSettled, false);

    finishAppend();
    await writer;
    const state = await reader;
    assert.equal(state.events.length, 1);
    assert.equal(state.snapshot.proposals[0]?.proposal.proposalId, "proposal-1");
  });

  test("distinguishes a corrupt ledger from a valid unbound state", async (t) => {
    const ledger = await tempLedger(t);
    const ready = await inspectMissionContractLedger(ledger);
    assert.equal(ready.status, "ready");
    if (ready.status !== "ready") assert.fail("expected ready ledger");
    assert.equal(ready.state.snapshot.binding.state, "unbound");

    await fs.writeFile(ledger, "{}\n", "utf8");
    const corrupt = await inspectMissionContractLedger(ledger);
    assert.equal(corrupt.status, "corrupt");
  });

  test("pins cap-minus-one reserve arithmetic for each pending proposal and active retirement", () => {
    const pending = 64;
    const active = true;
    const terminalEvents = pending + 1;
    const terminalBytes = terminalEvents * MISSION_CONTRACT_TERMINAL_EVENT_RESERVE_BYTES;
    const atEventBoundary = assessMissionContractLedgerCapacity({
      nextEventCount: MAX_MISSION_CONTRACT_LEDGER_EVENTS - terminalEvents,
      nextByteLength: 0,
      pendingProposalCount: pending,
      hasActiveBinding: active,
    });
    assert.equal(atEventBoundary.allowed, true);
    const overEventBoundary = assessMissionContractLedgerCapacity({
      nextEventCount: MAX_MISSION_CONTRACT_LEDGER_EVENTS - terminalEvents + 1,
      nextByteLength: 0,
      pendingProposalCount: pending,
      hasActiveBinding: active,
    });
    assert.equal(overEventBoundary.allowed, false);

    const atByteBoundary = assessMissionContractLedgerCapacity({
      nextEventCount: 0,
      nextByteLength: MAX_MISSION_CONTRACT_LEDGER_BYTES - terminalBytes,
      pendingProposalCount: pending,
      hasActiveBinding: active,
    });
    assert.equal(atByteBoundary.allowed, true);
    const overByteBoundary = assessMissionContractLedgerCapacity({
      nextEventCount: 0,
      nextByteLength: MAX_MISSION_CONTRACT_LEDGER_BYTES - terminalBytes + 1,
      pendingProposalCount: pending,
      hasActiveBinding: active,
    });
    assert.equal(overByteBoundary.allowed, false);

    const worstCaseDismissalRow = JSON.stringify({
      schemaVersion: 1,
      type: "missionContractProposalDismissed",
      eventId: "e".repeat(MISSION_CONTRACT_LIMITS.identifierChars),
      occurredAt: "2026-07-24T12:00:00.000Z",
      proposalId: "p".repeat(MISSION_CONTRACT_LIMITS.identifierChars),
      dismissalId: "d".repeat(MISSION_CONTRACT_LIMITS.identifierChars),
      dismissedBy: "local-user",
      reason: "\u0800".repeat(MISSION_CONTRACT_LIMITS.longTextChars),
    });
    assert.ok(
      Buffer.byteLength(worstCaseDismissalRow, "utf8")
        < MISSION_CONTRACT_TERMINAL_EVENT_RESERVE_BYTES,
    );
  });

  test("renders only the confirmed body and safe pending identifiers, never agent source binding", () => {
    const base = localProposalFixture("proposal-agent", "mission-agent");
    const agentProposal: MissionContractProposedEvent = {
      ...base,
      proposedBy: {
        kind: "agent",
        agentId: "claude",
        callId: "sensitive-call-binding",
        messageId: "sensitive-message-binding",
        responseSha256: "a".repeat(64),
      },
      admittedBy: {
        actorId: "local-user",
        action: "Admit Agent Mission Contract Proposal",
      },
    };
    const pending = replayMissionContractEvents([agentProposal]);
    const pendingMarkdown = renderMissionContractMarkdown(pending);
    assert.match(pendingMarkdown, /proposal\\-agent|proposal-agent/);
    assert.doesNotMatch(pendingMarkdown, /claude|sensitive-call-binding|sensitive-message-binding/);
    assert.doesNotMatch(pendingMarkdown, new RegExp(missionContractFixture().title));

    const confirmation: MissionContractEvent = {
      schemaVersion: 1,
      type: "missionContractConfirmed",
      eventId: "event-confirm-agent",
      occurredAt: "2026-07-24T12:01:00.000Z",
      missionId: agentProposal.missionId,
      proposalId: agentProposal.proposalId,
      confirmationId: "confirmation-agent",
      documentSha256: agentProposal.documentSha256,
      previousBindingSha256: UNBOUND_MISSION_BINDING_SHA256,
      revision: 1,
      confirmedBy: "local-user",
    };
    const activeMarkdown = renderMissionContractMarkdown(
      replayMissionContractEvents([agentProposal, confirmation]),
    );
    assert.match(activeMarkdown, /Ship the Mission Contract foundation/);
    assert.match(activeMarkdown, /private Mission Contract ledger is authoritative/i);
  });
});
