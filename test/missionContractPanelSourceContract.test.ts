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
const webview = fs.readFileSync(path.join(process.cwd(), "media", "webview.js"), "utf8");
const webviewMessages = fs.readFileSync(path.join(process.cwd(), "src", "webviewMessages.ts"), "utf8");

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
      /const snapshot = await controller\.refresh\(\);[\s\S]*return this\.missionBoundAuthorization\(snapshot\.binding, dispatchId\)/,
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
    assert.match(
      panel,
      /runBuildPhase\(\s*builder,\s*previousState,\s*preparedFlight/,
    );
    assert.match(
      panel,
      /runParallelReviewPhase\(\s*parallelAgents,\s*previousState,\s*preparedFlight/,
    );
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

  test("contributes and registers the complete local-user lifecycle", () => {
    const commands = [
      "manageMissionContract",
      "proposeMissionContract",
      "admitMissionProposal",
      "confirmMissionContract",
      "dismissMissionContractProposal",
      "retireMissionContract",
    ];
    for (const command of commands) {
      assert.match(manifest, new RegExp(`"command": "hydraRoom\\.${command}"`));
      assert.match(extension, new RegExp(`"hydraRoom\\.${command}"`));
      assert.match(webviewMessages, new RegExp(`type: "${command}"`));
    }
    assert.match(panel, /"Confirm Mission Contract"/);
    assert.match(panel, /"Admit Mission Proposal"/);
    assert.match(panel, /Admission did not activate it/);
  });

  test("renders complete active, pending, and ephemeral terms with exact hashes", () => {
    assert.match(webview, /function renderMissionActive\(binding, ready, error\)/);
    assert.match(webview, /function renderMissionProposals\(proposals\)/);
    assert.match(webview, /function renderMissionCandidates\(candidates, ready\)/);
    assert.match(webview, /Document SHA-256:/);
    assert.match(webview, /Binding SHA-256:/);
    assert.match(webview, /Base binding SHA-256:/);
    assert.match(webview, /terms\.textContent = JSON\.stringify\(contract, null, 2\)/);
    assert.match(panel, /missionProposalReviewDetail\(selected\)/);
    assert.match(panel, /requireExactPendingMissionProposal\(snapshot, selectedChoice\)/);
    assert.match(panel, /requireExactActiveMission\(snapshot, selectedChoice\)/);
  });

  test("parses successful top-level replies into bounded ephemeral candidates only", () => {
    const finalizeStart = panel.indexOf("private async finalizePendingMessage(");
    const finalizeEnd = panel.indexOf("private async recordWikiUsageTelemetry(", finalizeStart);
    const finalize = panel.slice(finalizeStart, finalizeEnd);
    assert.match(finalize, /parseMissionContractProposalIntent\(m\.text\)/);
    assert.match(finalize, /isAgentMessageRole\(m\.role\) && !m\.error && !m\.cancelled/);
    assert.match(finalize, /pendingAgentMissionBindings\.get\(messageId\)/);
    assert.match(finalize, /responseSha256 = sha256\(rawAgentReplyText\)/);
    assert.match(finalize, /boundedMissionCandidates\(/);
    assert.doesNotMatch(finalize, /admitAgentProposalAfterLocalApproval/);
    assert.doesNotMatch(finalize, /confirmProposalAfterLocalApproval/);
  });

  test("keeps legacy unbound Build routed through the normal frozen sentinel authorization", () => {
    const buildStart = panel.indexOf("private async runBuildPhase(");
    const buildEnd = panel.indexOf("private async runParallelBuildPhase(", buildStart);
    const build = panel.slice(buildStart, buildEnd);
    assert.match(build, /this\.runTurn\(async \(ctrl, registerPending, authorization, flightTurn\)/);
    assert.match(build, /this\.callAgent\([\s\S]*"build"[\s\S]*authorization/);
    assert.doesNotMatch(build, /binding\.state\s*!==\s*"active"/);
    assert.doesNotMatch(build, /requires an active Mission Contract/i);
  });
});
