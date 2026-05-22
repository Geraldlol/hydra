import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildCommandCenterActions } from "../src/commandCenter";

describe("command center", () => {
  test("prioritizes setup actions without a workspace", () => {
    const actions = buildCommandCenterActions({
      workspaceReady: false,
      canStop: false,
      canAcceptDefault: false,
      autoAdvanceActionableDefaults: true,
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

    assert.deepEqual(actions.map((action) => action.id), [
      "openWorkspaceFolder",
      "toggleAutoAdvanceActionableDefaults",
      "runDoctor",
    ]);
  });

  test("surfaces immediate work before general diagnostics", () => {
    const actions = buildCommandCenterActions({
      workspaceReady: true,
      canStop: false,
      canAcceptDefault: true,
      autoAdvanceActionableDefaults: false,
      canAssignBuilder: false,
      canRequestReview: false,
      canHandBack: false,
      canRunVerification: true,
      canRunWikiWrapup: true,
      canPokeNativeTerminals: true,
      needsCodexPath: false,
      needsClaudePath: false,
      transport: "oneShot",
      workQueueCount: 2,
      nativeActionsCount: 4,
      wikiStatus: {
        contextChars: 1200,
        contextMaxChars: 8000,
        promptChars: 2200,
        promptTruncated: false,
        promptFiles: [".hydra/wiki/context.md", ".hydra/wiki/index.md"],
        rawTurnCount: 7,
        lastWrapupDate: "2026-05-21",
        lastWrapupTitle: "Wiki consumer guidance",
        usageTelemetry: {
          sampleSize: 12,
          minSampleSize: 20,
          warmingUp: true,
          citationRate: 0.25,
          mentionRate: 0.75,
          citationReplies: 3,
          mentionReplies: 9,
        },
      },
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
    assert.ok(actions.some((action) => action.id === "openWikiContext"));
    assert.ok(actions.some((action) => action.id === "runWikiWrapupNow"));
    assert.ok(actions.some((action) => action.id === "chooseModel"));
    assert.ok(actions.some((action) => action.id === "chooseEffort"));
    assert.ok(actions.some((action) => action.id === "testTelegram"));
    assert.ok(actions.some((action) => action.id === "toggleAutoAdvanceActionableDefaults"));
    assert.ok(actions.some((action) => action.id === "runAutopilotStart"));
    const wiki = actions.find((action) => action.id === "openWikiContext");
    assert.ok(wiki);
    assert.equal(wiki.description, "Wiki 1200/8000 chars");
    assert.match(wiki.detail, /Prompt context 2200\/8000 chars/);
    assert.match(wiki.detail, /files context\.md, index\.md/);
    assert.match(wiki.detail, /raw turns 7/);
    assert.match(wiki.detail, /last wrapup 2026-05-21 \| Wiki consumer guidance/);
    assert.match(wiki.detail, /signal warming up 12\/20/);
    assert.match(wiki.detail, /citations 25% \(3\)/);
    assert.match(wiki.detail, /name\/path mentions 75% \(9\)/);
  });

  test("shows disabled wiki injection in Command Center status", () => {
    const actions = buildCommandCenterActions({
      workspaceReady: true,
      canStop: false,
      canAcceptDefault: false,
      autoAdvanceActionableDefaults: false,
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
      wikiStatus: {
        contextChars: 0,
        contextMaxChars: 0,
        promptChars: 0,
        promptTruncated: false,
        rawTurnCount: 0,
      },
    });

    const wiki = actions.find((action) => action.id === "openWikiContext");

    assert.ok(wiki);
    assert.equal(wiki.description, "Wiki disabled");
    assert.match(wiki.detail, /Prompt injection disabled/);
    assert.match(wiki.detail, /last wrapup none/);
  });

  test("offers build flow, recovery, and safe transport when terminal bridge is active", () => {
    const actions = buildCommandCenterActions({
      workspaceReady: true,
      canStop: true,
      canAcceptDefault: false,
      autoAdvanceActionableDefaults: true,
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
