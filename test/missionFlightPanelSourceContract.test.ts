import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function methodSlice(
  source: string,
  startAnchor: string,
  endAnchor: string,
): string {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  assert.ok(start >= 0 && end > start, `could not bound ${startAnchor}`);
  return source.slice(start, end);
}

describe("Mission/Flight panel integration source contracts", () => {
  test("registers the isolated smoke command and routes it through the panel", () => {
    const pkg = JSON.parse(read("package.json")) as {
      contributes?: { commands?: Array<{ command?: string; title?: string }> };
    };
    const extension = read("src/extension.ts");
    const command = pkg.contributes?.commands?.find(
      (candidate) =>
        candidate.command === "hydraRoom.runMissionFlightSmokeTest",
    );

    assert.equal(
      command?.title,
      "Hydra: Advanced: Run Mission + Flight Recorder Smoke Test",
    );
    assert.match(extension, /"hydraRoom\.runMissionFlightSmokeTest"/);
    assert.match(extension, /await panel\.runMissionFlightSmokeTest\(\)/);
  });

  test("runs the smoke in private storage without live runtime dependencies", () => {
    const source = read("src/panel.ts");
    const method = methodSlice(
      source,
      "async runMissionFlightSmokeTest()",
      "async runManyHeadsSmokeTest()",
    );

    assert.match(method, /this\.missionFlightSmokeRunning = true/);
    assert.match(method, /runIsolatedMissionFlightSmokeTest\(\{\s*privateWorkspaceRoot: this\.workspacePrivateStorageRoot\(\)/);
    assert.doesNotMatch(method, /privateWorkspaceRoot: this\.workspaceRoot/);
    assert.match(method, /formatMissionFlightSmokeReport\(report\)/);
    assert.match(method, /this\.missionFlightSmokeRunning = false/);
  });

  test("binds every normal phase transition to the explicit prepared trace", () => {
    const source = read("src/panel.ts");
    const prepare = methodSlice(
      source,
      "private async prepareInitiatingFlightTurn(",
      "private releaseInitiatingFlightTurnReservation(",
    );
    assert.ok(
      prepare.indexOf("this.flightTransitionReservationInFlight = true")
        < prepare.indexOf("await this.prepareFlightTurn("),
    );

    const startTurn = methodSlice(
      source,
      "private async startUserMessageTurn(",
      "async stop()",
    );
    assert.ok(
      startTurn.indexOf("await this.prepareInitiatingFlightTurn(")
        < startTurn.indexOf("this.applyEvent({"),
    );
    assert.match(startTurn, /preparedFlight\.flightTurn/);
    assert.match(startTurn, /flightSource,\s*preparedFlight/);

    const runnerBounds: ReadonlyArray<readonly [string, string]> = [
      ["private async runDiscussionTurn(", "private async runParallelDiscussionTurn("],
      ["private async runParallelDiscussionTurn(", "private async runBuildPhase("],
      ["private async runBuildPhase(", "private async runParallelBuildPhase("],
      ["private async runParallelBuildPhase(", "private async afterSuccessfulBuild("],
      ["private async runReviewPhase(", "private async runParallelReviewPhase("],
      ["private async runParallelReviewPhase(", "// ---------------- agent call helper"],
    ];
    for (const [start, end] of runnerBounds) {
      const runner = methodSlice(source, start, end);
      const calls = [...runner.matchAll(/this\.applyEvent\(([\s\S]*?)\);/g)];
      assert.ok(calls.length > 0, `${start} must transition state`);
      for (const call of calls) {
        assert.match(call[0], /flightTurn/);
      }
      assert.match(runner, /preparedFlight/);
    }
  });

  test("reset records and terminalizes the exact stuck trace before severing ownership", () => {
    const source = read("src/panel.ts");
    const reset = methodSlice(
      source,
      "async resetStuckTurn()",
      "async openWorkspaceFolder()",
    );
    const snapshot = reset.indexOf(
      "const activeFlightTurns = [...this.activeFlightTurns]",
    );
    const transition = reset.indexOf(
      'this.applyEvent({ type: "stop" }, resetFlightTurn)',
    );
    const finish = reset.indexOf(
      "this.finishActiveFlightTurn(active",
    );
    const sever = reset.indexOf("this.currentFlightTurn = undefined");
    assert.ok(snapshot >= 0 && snapshot < transition);
    assert.ok(transition < finish && finish < sever);
    assert.match(reset, /const activeFlightTurns = \[\.\.\.this\.activeFlightTurns\]/);
    assert.match(reset, /this\.flightResetGeneration \+= 1/);
    assert.match(reset, /active\.cancellationReason = "reset"/);
    assert.match(reset, /active\.abortController\?\.abort\(\)/);
    assert.match(reset, /for \(const active of activeFlightTurns\.reverse\(\)\)/);
    assert.match(
      reset,
      /status: "incomplete",\s*failureCode: "unknown"/,
    );
  });

  test("reset fences prepared turns across transcript persistence gaps", () => {
    const source = read("src/panel.ts");
    const prepare = methodSlice(
      source,
      "private async prepareInitiatingFlightTurn(",
      "private releaseInitiatingFlightTurnReservation(",
    );
    assert.match(prepare, /const resetGeneration = this\.flightResetGeneration/);
    assert.match(prepare, /const stopGeneration = this\.flightStopGeneration/);
    assert.match(prepare, /this\.activeFlightTurns\.push\(activeFlightTurn\)/);
    assert.match(
      prepare,
      /this\.flightResetGeneration !== resetGeneration[\s\S]*finishPreparedFlightTurn/,
    );
    assert.match(
      prepare,
      /this\.flightStopGeneration !== stopGeneration[\s\S]*finishPreparedFlightTurn/,
    );

    const gaps: ReadonlyArray<readonly [string, string]> = [
      ["private async startUserMessageTurn(", "async stop()"],
      ["async assignBuilder(", "async assignParallelBuilders("],
      ["async assignParallelBuilders(", "async requestReview("],
      ["async requestReview(", "async runVerification("],
    ];
    for (const [start, end] of gaps) {
      const method = methodSlice(source, start, end);
      const persistence = method.search(
        /await this\.(?:appendUserMessage|appendSystemMessage)\(/,
      );
      const resetCheck = method.indexOf(
        "this.preparedFlightWasCancelled(preparedFlight)",
        persistence,
      );
      assert.ok(persistence >= 0 && resetCheck > persistence, start);
    }
  });

  test("Stop cancels a reserved or persisted pre-dispatch turn without launching it", () => {
    const source = read("src/panel.ts");
    const stop = methodSlice(source, "async stop()", "async assignBuilder(");
    const mark = stop.indexOf(
      'activeFlightTurn.cancellationReason ??= "stop"',
    );
    const transition = stop.indexOf(
      'this.applyEvent({ type: "stop" }, activeFlightTurn.flightTurn)',
    );
    const finish = stop.indexOf(
      "await this.finishActiveFlightTurn(",
    );

    assert.match(stop, /this\.flightTransitionReservationInFlight/);
    assert.match(stop, /!activeFlightTurn\.dispatchStarted/);
    assert.match(stop, /this\.flightStopGeneration \+= 1/);
    assert.ok(mark >= 0 && mark < transition && transition < finish);
    assert.match(
      stop,
      /status: "cancelled",\s*failureCode: "cancelled"/,
    );

    const runTurn = methodSlice(
      source,
      "private async runTurn(",
      "private async runDiscussionTurn(",
    );
    assert.ok(
      runTurn.indexOf("this.preparedFlightWasCancelled(preparedFlight)")
        < runTurn.indexOf("const ctrl = new AbortController()"),
    );
  });

  test("verification owns an abort controller before its first preflight await", () => {
    const source = read("src/panel.ts");
    const verify = methodSlice(
      source,
      "private async runVerificationInternal(",
      "async acceptDefaultDecision(",
    );
    const reserve = verify.indexOf("this.verificationRunning = true");
    const ctrl = verify.indexOf("const ctrl = new AbortController()", reserve);
    const bind = verify.indexOf("this.currentAbort = ctrl", ctrl);
    const resolve = verify.indexOf("await resolveVerificationCommand(", bind);

    assert.ok(reserve >= 0 && reserve < ctrl && ctrl < bind && bind < resolve);
    assert.match(verify, /if \(ctrl\.signal\.aborted\) return undefined/);
    assert.match(
      verify,
      /if \(this\.currentAbort === ctrl\) this\.currentAbort = previousAbort/,
    );
  });

  test("Stop fences post-phase automation and native poke preflight", () => {
    const source = read("src/panel.ts");
    const stop = methodSlice(source, "async stop()", "async assignBuilder(");
    assert.match(
      stop,
      /activeFlightPending =\s*activeFlightTurn !== undefined && !activeFlightTurn\.terminalized/,
    );
    assert.match(stop, /!activeFlightPending/);

    const discussion = methodSlice(
      source,
      "private async runDiscussionTurn(",
      "private async runParallelDiscussionTurn(",
    );
    assert.match(
      discussion,
      /autoAdvanceActionableDefault\("discussion", ctrl\.signal\)/,
    );

    const afterBuild = methodSlice(
      source,
      "private async afterSuccessfulBuild(",
      "private async captureSerialBuildScoreContext(",
    );
    assert.match(afterBuild, /if \(signal\?\.aborted\) return/);
    assert.match(
      afterBuild,
      /runVerificationInternal\([\s\S]*signal,\s*\)/,
    );
    assert.match(afterBuild, /await this\.requestReview\(signal\)/);

    const autoAdvance = methodSlice(
      source,
      "private async autoAdvanceActionableDefault(",
      "private async runReviewPhase(",
    );
    assert.match(autoAdvance, /signal\?: AbortSignal/);
    assert.match(autoAdvance, /await this\.assignBuilder\(action\.builder, signal\)/);
    assert.match(autoAdvance, /await this\.requestReview\(signal\)/);
    assert.match(autoAdvance, /\{ signal \}/);

    const poke = methodSlice(
      source,
      "async pokeNativeTerminals(",
      "async showNativeActionPicker(",
    );
    for (const [start, end] of [
      ["async runNativeCliCommand(", "async sendRawTerminalLine("],
      ["async sendRawTerminalLine(", "async pokeNativeTerminals("],
      ["async pokeNativeTerminals(", "async showNativeActionPicker("],
    ] as const) {
      assert.match(methodSlice(source, start, end), /this\.verificationRunning/);
    }
    const nativeCommand = methodSlice(
      source,
      "async runNativeCliCommand(",
      "async sendRawTerminalLine(",
    );
    assert.ok(
      nativeCommand.indexOf("submissionSettled = true")
        < nativeCommand.indexOf("await this.finalizePendingMessage("),
    );
    assert.match(
      nativeCommand,
      /ctrl\.signal\.aborted && !submissionSettled/,
    );
    const rawLine = methodSlice(
      source,
      "async sendRawTerminalLine(",
      "async pokeNativeTerminals(",
    );
    assert.ok(
      rawLine.indexOf("submissionSettled = true")
        < rawLine.indexOf("await this.appendSystemMessage(`Sent raw line"),
    );
    assert.match(rawLine, /ctrl\.signal\.aborted && !submissionSettled/);

    const reserve = poke.indexOf("this.terminalPokeInFlight = true");
    const ctrl = poke.indexOf("const ctrl = new AbortController()", reserve);
    const bind = poke.indexOf("this.currentAbort = ctrl", ctrl);
    const diff = poke.indexOf(
      "await captureGitDiff(this.workspaceRoot, diffMaxLines())",
      bind,
    );
    const abortCheck = poke.indexOf("if (ctrl.signal.aborted) return", diff);
    const authorize = poke.indexOf(
      "await this.freshMissionAuthorization(actionId)",
      abortCheck,
    );
    assert.ok(
      reserve >= 0
        && reserve < ctrl
        && ctrl < bind
        && bind < diff
        && diff < abortCheck
        && abortCheck < authorize,
    );
  });
});
