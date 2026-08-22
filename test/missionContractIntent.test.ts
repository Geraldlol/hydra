import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  MAX_MISSION_CONTRACT_PROPOSAL_CONTROL_BYTES,
  MISSION_CONTRACT_PROPOSAL_MARKER,
  parseMissionContractProposalIntent,
} from "../src/missionContractIntent";
import { missionContractFixture } from "./missionContractFixtures";

function controlRecord(contract: unknown = missionContractFixture()): string {
  return `${MISSION_CONTRACT_PROPOSAL_MARKER}${JSON.stringify({
    schemaVersion: 1,
    contract,
  })}`;
}

describe("strict agent Mission Contract intent parser", () => {
  test("extracts one column-zero record into an ephemeral candidate and cleans visible text", () => {
    const result = parseMissionContractProposalIntent(
      `I drafted a bounded mission.\n\n${controlRecord()}\n\nPlease review it locally.`,
    );
    assert.equal(result.kind, "candidate");
    if (result.kind !== "candidate") assert.fail("expected candidate");
    assert.match(result.cleanedText, /I drafted a bounded mission/);
    assert.match(result.cleanedText, /Please review it locally/);
    assert.doesNotMatch(result.cleanedText, /HYDRA_MISSION_PROPOSAL/);
    assert.match(result.candidate.documentSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.candidate.contract.title, missionContractFixture().title);
  });

  test("ignores quoted, indented, list-nested, and fenced lookalikes", () => {
    const record = controlRecord();
    const samples = [
      `> ${record}`,
      `  ${record}`,
      `- ${record}`,
      `\`\`\`json\n${record}\n\`\`\``,
      `~~~\n${record}\n~~~`,
    ];
    for (const sample of samples) {
      assert.equal(parseMissionContractProposalIntent(sample).kind, "none", sample.slice(0, 30));
    }
  });

  test("rejects duplicates, malformed JSON, oversized payloads, and wrapper authority fields", () => {
    const duplicate = parseMissionContractProposalIntent(`${controlRecord()}\n${controlRecord()}`);
    assert.equal(duplicate.kind, "invalid");
    if (duplicate.kind === "invalid") assert.match(duplicate.error, /exactly one/);

    const malformed = parseMissionContractProposalIntent(`${MISSION_CONTRACT_PROPOSAL_MARKER}{bad}`);
    assert.equal(malformed.kind, "invalid");
    if (malformed.kind === "invalid") assert.match(malformed.error, /not valid JSON/);

    const oversized = parseMissionContractProposalIntent(
      `${MISSION_CONTRACT_PROPOSAL_MARKER}${"x".repeat(MAX_MISSION_CONTRACT_PROPOSAL_CONTROL_BYTES + 1)}`,
    );
    assert.equal(oversized.kind, "invalid");
    if (oversized.kind === "invalid") assert.match(oversized.error, /exceeds/);

    const authorityInjection = parseMissionContractProposalIntent(
      `${MISSION_CONTRACT_PROPOSAL_MARKER}${JSON.stringify({
        schemaVersion: 1,
        contract: missionContractFixture(),
        confirmedBy: "agent",
      })}`,
    );
    assert.equal(authorityInjection.kind, "invalid");
    if (authorityInjection.kind === "invalid") assert.match(authorityInjection.error, /exactly contract and schemaVersion/);
  });

  test("rejects unknown nested contract fields and wrong schema without partial acceptance", () => {
    const contract = structuredClone(missionContractFixture()) as unknown as Record<string, unknown>;
    contract.grantFullNative = true;
    const unknown = parseMissionContractProposalIntent(controlRecord(contract));
    assert.equal(unknown.kind, "invalid");
    if (unknown.kind === "invalid") assert.match(unknown.error, /unknown grantFullNative/);

    const wrongVersion = parseMissionContractProposalIntent(
      `${MISSION_CONTRACT_PROPOSAL_MARKER}${JSON.stringify({
        schemaVersion: 2,
        contract: missionContractFixture(),
      })}`,
    );
    assert.equal(wrongVersion.kind, "invalid");
    if (wrongVersion.kind === "invalid") assert.match(wrongVersion.error, /schemaVersion must equal 1/);
  });

  test("treats an ordinary reply as no intent without rewriting it", () => {
    const reply = "Normal agent prose.\r\nNo control record here.";
    assert.deepEqual(parseMissionContractProposalIntent(reply), {
      kind: "none",
      cleanedText: reply,
    });
  });
});
