import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";

const panel = fs.readFileSync(
  path.join(process.cwd(), "src", "panel.ts"),
  "utf8",
);
const nativeRuntime = fs.readFileSync(
  path.join(process.cwd(), "src", "nativeSteeringRuntime.ts"),
  "utf8",
);
const extension = fs.readFileSync(path.join(process.cwd(), "src", "extension.ts"), "utf8");
const manifest = fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8");
const webviewMessages = fs.readFileSync(
  path.join(process.cwd(), "src", "webviewMessages.ts"),
  "utf8",
);

describe("Flight Recorder staged panel integration source contract", () => {
  test("contributes and registers inspect, Replay, and Create Eval operator workflows", () => {
    for (const command of [
      "manageFlightRecorder",
      "replayFlightTrace",
      "createFlightEval",
    ]) {
      assert.match(manifest, new RegExp(`"command": "hydraRoom\\.${command}"`));
      assert.match(extension, new RegExp(`"hydraRoom\\.${command}"`));
      assert.match(webviewMessages, new RegExp(command));
    }
    assert.match(manifest, /"command": "hydraRoom\.replayFlightTrace"[\s\S]*?"enablement": "isWorkspaceTrusted"/);
    const replayStart = panel.indexOf("async replayFlightTrace(");
    const evalStart = panel.indexOf("async createFlightEval(", replayStart);
    const evalEnd = panel.indexOf("async openMissionContract(", evalStart);
    const replay = panel.slice(replayStart, evalStart);
    const createEval = panel.slice(evalStart, evalEnd);
    assert.match(replay, /controller\.withCurrentBinding\([\s\S]*surface\.prepareReplay\(/);
    assert.match(createEval, /controller\.withCurrentBinding\([\s\S]*surface\.createEval\(/);
  });

  test("initializes private Mission authority before Flight and steering", () => {
    const mission = panel.indexOf("MissionContractController.tryOpen");
    const flight = panel.indexOf("await createFlightRecorderRuntime", mission);
    const steering = panel.indexOf("await openFileSteeringPersistence", flight);
    assert.ok(mission >= 0);
    assert.ok(flight > mission);
    assert.ok(steering > flight);
    assert.match(panel, /privateWorkspaceRoot: this\.workspacePrivateStorageRoot\(\)/);
    assert.match(panel, /mirrorPath: this\.flightRecorderMirrorUri\.fsPath/);
    assert.match(panel, /this\.flightRecorderRuntime\?\.dispose\(\)/);
    assert.match(
      panel,
      /if \(this\.disposed\) \{\s*flightRecorderRuntime\.dispose\(\);\s*return;/,
    );
  });

  test("starts and terminalizes one Mission-bound staged room trace", () => {
    const start = panel.indexOf("private async runTurn(");
    const end = panel.indexOf("private async runDiscussionTurn(", start);
    const method = panel.slice(start, end);
    assert.match(method, /preparedFlight = await this\.prepareFlightTurn\(/);
    assert.match(method, /authorization,[\s\S]*flightTurn/);
    assert.match(
      method,
      /this\.finishActiveFlightTurn\(activeFlightEntry, outcome\)/,
    );
    assert.match(panel, /source: "telegram"/);
  });

  test("binds every staged callAgent completion to its terminal steering chain", () => {
    const start = panel.indexOf("private async callAgent(");
    const end = panel.indexOf("private async callAgentCore(", start);
    const method = panel.slice(start, end);
    assert.match(method, /computeSteeringChainSha256\(promptSha256, \[\]\)/);
    assert.match(method, /beginAgentRun\(flightTurn/);
    assert.match(method, /authoritySha256/);
    assert.match(method, /promptSha256/);
    assert.match(method, /contextSha256/);
    assert.match(method, /plannedTransport/);
    assert.match(method, /actualTransport: flightState\.actualTransport/);
    assert.match(method, /finishAgentRun\(flightOperation/);
    assert.match(method, /terminalSteeringChain: flightState\.terminalSteeringChain/);
    assert.match(panel, /flightState\.terminalSteeringChain = \{/);
    assert.match(nativeRuntime, /options\.onSteeringChain\?\.\(terminalChain\)/);
    assert.match(nativeRuntime, /options\.onTransportSelected\?\.\(transport\)/);
    assert.doesNotMatch(method, /hydra-flight-context-v1|authorization\.roomTurnId/);
  });

  test("normalizes provider tool metadata from raw transport evidence before reply reduction", () => {
    const oneShotStart = panel.indexOf("private async runOneShotPipeline(");
    const oneShotEnd = panel.indexOf("private async runHttpPipeline(", oneShotStart);
    const oneShot = panel.slice(oneShotStart, oneShotEnd);
    assert.ok(oneShotStart >= 0 && oneShotEnd > oneShotStart);
    const telemetry = oneShot.indexOf("flightProviderTelemetryFromOutput(");
    const normalizeReply = oneShot.indexOf("this.normalizeOneShotResult(");
    assert.ok(telemetry >= 0 && normalizeReply > telemetry);
    assert.match(oneShot, /prepared\.outputMode,[\s\S]*result\.stdout/);
    assert.match(panel, /const verifiedRawOutput = await this\.terminalBridgeRawOutput\(result\)/);
    assert.match(panel, /flightState\.providerTelemetry = flightProviderTelemetryFromOutput\(/);
    assert.match(panel, /if \(resultForFlight[\s\S]*&& flightState\.providerTelemetry\)/);
    assert.doesNotMatch(panel, /recordStructuredProviderFlightTelemetry\([\s\S]{0,160}resultForFlight\.stdout/);
  });

  test("uses ephemeral prompt-component commitments at every staged dispatch", () => {
    assert.match(panel, /withPrivateFlightContextCommitment\(/);
    assert.match(panel, /promptContextSha256\(\[/);
    assert.ok(
      (panel.match(/\.flightContextSha256/g) ?? []).length >= 9,
      "all nine staged prompt-envelope dispatches must pass their private context root",
    );
  });

  test("drains all started fanout calls before terminalizing their room trace", () => {
    assert.equal(
      (panel.match(/results = await settleAgentCalls\(calls, \(\) => ctrl\??\.abort\(\)\)/g) ?? []).length,
      5,
    );
    assert.match(panel, /const results = await settleAgentCalls\(calls, \(\) => ctrl\.abort\(\)\)/);
    assert.doesNotMatch(panel, /Promise\.all\(calls\)/);
    assert.equal((panel.match(/observeAgentCall\(\s*this\.callAgent\(/g) ?? []).length, 4);
    assert.match(panel, /const observed = calls\.map\(\(call\) => call\.catch/);
  });

  test("records actual transport and preserves known pre-submit outcomes", () => {
    const transportStart = panel.indexOf("private async runAgentTransport(");
    const transportEnd = panel.indexOf(
      "private async prepareOneShotRequestFiles(",
      transportStart,
    );
    const transport = panel.slice(transportStart, transportEnd);
    assert.match(transport, /onActualTransport\?\.\("terminalBridge"\)/);
    assert.match(transport, /onActualTransport\?\.\("oneShot"\)/);
    assert.match(transport, /onMissionRejected\?\.\(\)/);
    assert.match(panel, /actualTransport = "http"/);
    assert.match(panel, /failureCode: "guardBlocked"/);
    assert.match(panel, /failureCode: "consentDenied"/);
    assert.match(panel, /failureCode: "validationFailure"/);
    assert.match(panel, /err instanceof SubmissionCancelledBeforeWriteError[\s\S]*agentCallCancelledResult/);
    assert.match(
      panel,
      /flightState\.outcomeOverride = signal\.aborted[\s\S]*status: "cancelled"[\s\S]*failureCode: "validationFailure"/,
    );

    const oneShotStart = panel.indexOf("private async runOneShotPipeline(");
    const oneShotEnd = panel.indexOf("private async runHttpPipeline(", oneShotStart);
    assert.match(
      panel.slice(oneShotStart, oneShotEnd),
      /err instanceof MissionSubmissionRejectedError[\s\S]*\|\| err instanceof SubmissionCancelledBeforeWriteError[\s\S]*throw err;/,
    );
    assert.match(nativeRuntime, /"codexAppServer"/);
    assert.match(nativeRuntime, /"oneShotFallback"/);
    assert.match(nativeRuntime, /"claudeSession"/);
  });

  test("cannot mark a serial review phase successful when its child call failed", () => {
    const start = panel.indexOf("private async runReviewPhase(");
    const end = panel.indexOf("private async runParallelReviewPhase(", start);
    const method = panel.slice(start, end);
    assert.match(
      method,
      /ctrl\.signal\.aborted \|\| didAgentFail\(result\.result\)/,
    );
    assert.match(method, /setFlightOutcome\(\{ status: "failed", failureCode: "validationFailure" \}\)/);
    const turnStart = panel.indexOf("private async runTurn(");
    const turnEnd = panel.indexOf("private async runDiscussionTurn(", turnStart);
    const runTurn = panel.slice(turnStart, turnEnd);
    assert.match(runTurn, /bodyThrew \|\| finalizerThrew/);
    assert.ok(runTurn.indexOf("bodyThrew") < runTurn.indexOf("ctrl.signal.aborted"));
    assert.match(
      runTurn,
      /if \(\(bodyThrew \|\| finalizerThrew\) && isInFlight\(this\.state\)\) \{\s*this\.applyEvent\(\{ type: "stop" \}, flightTurn\);/,
    );
    assert.match(
      runTurn,
      /if \(finalizePending\) await finalizePending\(\);[\s\S]*finishActiveFlightTurn\(activeFlightEntry, outcome\)[\s\S]*this\.currentRoomTurnId = previousRoomTurnId/,
    );
    assert.match(runTurn, /if \(bodyThrew\) throw bodyError;[\s\S]*if \(finalizerThrew\) throw finalizerError;/);
  });

  test("records direct native pokes under their own fresh Mission-bound trace", () => {
    const start = panel.indexOf("async pokeNativeTerminals(");
    const end = panel.indexOf("async showNativeActionPicker(", start);
    const method = panel.slice(start, end);
    assert.match(method, /freshMissionAuthorization\(actionId\)/);
    assert.match(method, /beginFlightRoomTurn\([\s\S]*"nativeAction"/);
    assert.match(method, /this\.callAgent\([\s\S]*flightTurn/);
    assert.match(method, /finishRoomTurn\(/);
  });
});
