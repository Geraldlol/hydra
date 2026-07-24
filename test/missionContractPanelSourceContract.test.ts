import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const panel = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
const extension = fs.readFileSync(path.join(process.cwd(), "src", "extension.ts"), "utf8");
const manifest = fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8");
const dispatch = fs.readFileSync(path.join(process.cwd(), "src", "missionDispatch.ts"), "utf8");
const codex = fs.readFileSync(path.join(process.cwd(), "src", "codexAppServerTransport.ts"), "utf8");
const claude = fs.readFileSync(path.join(process.cwd(), "src", "claudeSessionTransport.ts"), "utf8");
const terminal = fs.readFileSync(path.join(process.cwd(), "src", "terminalBridge.ts"), "utf8");

describe("Mission Contract panel integration source contract", () => {
  test("opens the private Mission controller before steering persistence", () => {
    const missionOpen = panel.indexOf("MissionContractController.tryOpen");
    const steeringOpen = panel.indexOf("await openFileSteeringPersistence", missionOpen);
    assert.ok(missionOpen >= 0);
    assert.ok(steeringOpen > missionOpen);
  });

  test("passes one immutable binding through the room turn and exact submission gates", () => {
    assert.match(
      panel,
      /missionSnapshot = await missionController\.refresh\(\);[\s\S]*const authorization = this\.missionBoundAuthorization\(missionBinding, roomTurnId\)/,
    );
    assert.match(panel, /await body\([\s\S]*authorization/);
    assert.match(panel, /authorization: Extract<MissionDispatchAuthorization, \{ kind: "bound" \}>/);
    assert.match(dispatch, /MISSION_SUBMISSION_WRITTEN/);
    assert.match(dispatch, /startMissionBoundSubmission/);
    assert.match(panel, /startMissionBoundSubmission\([\s\S]*"native\.oneShot"/);
    assert.match(panel, /startMissionBoundSubmission\([\s\S]*"http\.request"/);
    assert.match(terminal, /submissionGate\.write\("terminal\.dispatch"/);
    assert.match(codex, /"codex\.turnStart"/);
    assert.match(codex, /"codex\.turnSteer"/);
    assert.match(claude, /turn\.kind === "initial" \? "claude\.initial" : "claude\.steer"/);
    assert.doesNotMatch(panel, /assertCurrentBinding\(binding\.bindingSha256\)/);
  });

  test("direct actions refresh their own binding and reset cannot reuse a room latch", () => {
    assert.match(panel, /const authorization = await this\.freshMissionAuthorization\(actionId\)/);
    assert.match(panel, /buildDirectTerminalPokeEnvelope\([\s\S]*authorization\.binding/);
    assert.match(panel, /authorization\.submissionGate/);
    const resetStart = panel.indexOf("async resetStuckTurn()");
    const resetEnd = panel.indexOf("async openWorkspaceFolder()", resetStart);
    const reset = panel.slice(resetStart, resetEnd);
    assert.match(reset, /this\.currentRoomTurnId = undefined/);
    assert.match(reset, /this\.currentMissionContractBinding = undefined/);
  });

  test("Mission admission failure restores the reserved predecessor phase", () => {
    const runTurnStart = panel.indexOf("private async runTurn(");
    const runTurnEnd = panel.indexOf("private async runDiscussionTurn(", runTurnStart);
    const runTurn = panel.slice(runTurnStart, runTurnEnd);
    assert.match(runTurn, /reservationFailed/);
    assert.match(runTurn, /restore: options\.restoreState/);
    assert.match(panel, /runBuildPhase\(builder, previousState\)/);
    assert.match(panel, /runParallelReviewPhase\(parallelAgents, previousState\)/);
  });

  test("binds steering and prompt provenance to document and active-binding hashes", () => {
    assert.match(panel, /missionDocumentSha256: missionBinding\.documentSha256/);
    assert.match(panel, /missionBindingSha256: missionBinding\.bindingSha256/);
    assert.match(panel, /renderMissionContractPromptContext\(binding\)/);
    assert.match(panel, /missionDocumentSha256: missionBinding\?\.documentSha256/);
  });

  test("renders the frozen Mission terms into autonomous wiki and duel prompts", () => {
    const wikiStart = panel.indexOf("private async runWikiWrapupAgent(");
    const wikiEnd = panel.indexOf("private async runDuelCommitmentHead(", wikiStart);
    const wiki = panel.slice(wikiStart, wikiEnd);
    assert.match(
      wiki,
      /freshMissionAuthorization\([\s\S]*renderMissionContractPromptContext\(authorization\.binding\)/,
    );

    const duelStart = wikiEnd;
    const duelEnd = panel.indexOf("private async runHeadlessDuelHttpAgent(", duelStart);
    const duel = panel.slice(duelStart, duelEnd);
    assert.match(
      duel,
      /freshMissionAuthorization\([\s\S]*renderMissionContractPromptContext\(authorization\.binding\)[\s\S]*buildDuelCommitmentPrompt/,
    );
  });

  test("registers an inspectable one-way Mission Contract mirror command", () => {
    assert.match(extension, /"hydraRoom\.openMissionContract"/);
    assert.match(manifest, /"command": "hydraRoom\.openMissionContract"/);
    assert.match(panel, /async openMissionContract\(\): Promise<void>/);
  });
});
