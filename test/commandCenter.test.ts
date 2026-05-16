import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildCommandCenterActions } from "../src/commandCenter";

describe("command center", () => {
  test("prioritizes setup actions without a workspace", () => {
    const actions = buildCommandCenterActions({
      workspaceReady: false,
      canStop: false,
      canAcceptDefault: false,
      canAssignBuilder: false,
      canRequestReview: false,
      canHandBack: false,
      canRunVerification: false,
      canPokeNativeTerminals: false,
      needsCodexPath: false,
      needsClaudePath: false,
      transport: "oneShot",
      workQueueCount: 0,
      nativeActionsCount: 0,
    });

    assert.deepEqual(actions.map((action) => action.id), ["openWorkspaceFolder", "runDoctor"]);
  });

  test("surfaces immediate work before general diagnostics", () => {
    const actions = buildCommandCenterActions({
      workspaceReady: true,
      canStop: false,
      canAcceptDefault: true,
      canAssignBuilder: false,
      canRequestReview: false,
      canHandBack: false,
      canRunVerification: true,
      canPokeNativeTerminals: true,
      needsCodexPath: false,
      needsClaudePath: false,
      transport: "oneShot",
      workQueueCount: 2,
      nativeActionsCount: 4,
    });

    assert.deepEqual(actions.slice(0, 4).map((action) => action.id), [
      "acceptDefaultDecision",
      "runVerification",
      "nativeAction",
      "pokeBothTerminalsWithDiff",
    ]);
    assert.ok(actions.some((action) => action.id === "useTerminalBridge"));
    assert.ok(actions.some((action) => action.id === "openSupportBundle"));
    assert.ok(actions.some((action) => action.id === "captureNativeCapabilities"));
    assert.ok(actions.some((action) => action.id === "captureNativeDataSnapshot"));
    assert.ok(actions.some((action) => action.id === "openObjective"));
    assert.ok(actions.some((action) => action.id === "openLastPrompt"));
    assert.ok(actions.some((action) => action.id === "openVerification"));
    assert.ok(actions.some((action) => action.id === "openDecisions"));
    assert.ok(actions.some((action) => action.id === "chooseModel"));
    assert.ok(actions.some((action) => action.id === "chooseEffort"));
    assert.ok(actions.some((action) => action.id === "runAutopilotStart"));
  });

  test("offers build flow, recovery, and safe transport when terminal bridge is active", () => {
    const actions = buildCommandCenterActions({
      workspaceReady: true,
      canStop: true,
      canAcceptDefault: false,
      canAssignBuilder: true,
      canRequestReview: true,
      canHandBack: true,
      canRunVerification: false,
      canPokeNativeTerminals: false,
      needsCodexPath: true,
      needsClaudePath: true,
      transport: "terminalBridge",
      workQueueCount: 0,
      nativeActionsCount: 0,
    });

    assert.deepEqual(actions.slice(0, 2).map((action) => action.id), [
      "stopCurrentTurn",
      "resetStuckTurn",
    ]);
    assert.deepEqual(actions.slice(2, 7).map((action) => action.id), [
      "assignCodex",
      "assignClaude",
      "assignParallelBuilders",
      "requestReview",
      "handBack",
    ]);
    assert.ok(actions.some((action) => action.id === "fixCodexPath"));
    assert.ok(actions.some((action) => action.id === "fixClaudePath"));
    assert.ok(actions.some((action) => action.id === "useOneShotTransport"));
    assert.ok(actions.some((action) => action.id === "runTerminalBridgeSelfTest"));
    assert.ok(actions.some((action) => action.id === "showTerminalBridgeHealth"));
    assert.ok(actions.some((action) => action.id === "showEffectiveAuthority"));
  });
});
