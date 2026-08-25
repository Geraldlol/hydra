import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as vscode from "vscode";
import {
  autopilotOnStart,
  autoAdvanceActionableDefaults,
  autoRequestReviewAfterPassingVerification,
  autoScorePassingBuilds,
  autoSkipCloserOnAgreement,
  autoVerifyAfterBuild,
  configuredAutoAdvanceActionableDefaults,
  manyHeadsMode,
  normalizeRoomRoster,
  preferTerminalBridgeOnStart,
  reviewConvergence,
  reviewParticipation,
  roomRoster,
  shouldClearLegacyAgentTimeout,
  workspaceExecutionControlsAllowed,
} from "../src/roomSettings";

describe("room settings", () => {
  test("clears tiny agent timeout values", () => {
    assert.equal(shouldClearLegacyAgentTimeout(1000), true);
    assert.equal(shouldClearLegacyAgentTimeout(1), true);
  });

  test("preserves deliberate positive timeout values above the tiny cap", () => {
    assert.equal(shouldClearLegacyAgentTimeout(0), false);
    assert.equal(shouldClearLegacyAgentTimeout(1001), false);
    assert.equal(shouldClearLegacyAgentTimeout(45_000), false);
    assert.equal(shouldClearLegacyAgentTimeout(120_000), false);
    assert.equal(shouldClearLegacyAgentTimeout(600_000), false);
    assert.equal(shouldClearLegacyAgentTimeout(undefined), false);
  });

  test("normalizes an ordered room roster to valid unique agent IDs", () => {
    assert.deepEqual(
      normalizeRoomRoster(["gemini", "codex", "gemini", "bad id", "system", 42, "claude"]),
      ["gemini", "codex", "claude"],
    );
  });

  test("falls back to the two built-in heads when fewer than two IDs survive", () => {
    assert.deepEqual(normalizeRoomRoster(undefined), ["codex", "claude"]);
    assert.deepEqual(normalizeRoomRoster([]), ["codex", "claude"]);
    assert.deepEqual(normalizeRoomRoster(["gemini", "gemini", "bad id"]), ["codex", "claude"]);
  });

  test("reads the application-scoped ordered room roster at runtime", () => {
    const config = (vscode as unknown as { currentConfig: Record<string, unknown> }).currentConfig;
    const previous = config.roomRoster;
    try {
      config.roomRoster = ["gemini", "codex", "claude"];
      assert.deepEqual(roomRoster(), ["gemini", "codex", "claude"]);
    } finally {
      if (previous === undefined) delete config.roomRoster;
      else config.roomRoster = previous;
    }
  });

  test("reads review convergence and participation with safe fallbacks", () => {
    const config = (vscode as unknown as { currentConfig: Record<string, unknown> }).currentConfig;
    const previousConvergence = config.reviewConvergence;
    const previousParticipation = config.reviewParticipation;
    try {
      config.reviewConvergence = "majority";
      config.reviewParticipation = "single";
      assert.equal(reviewConvergence(), "majority");
      assert.equal(reviewParticipation(), "serial");

      config.reviewConvergence = "invented";
      config.reviewParticipation = "invented";
      assert.equal(reviewConvergence(), "human");
      assert.equal(reviewParticipation(), "all");
    } finally {
      if (previousConvergence === undefined) delete config.reviewConvergence;
      else config.reviewConvergence = previousConvergence;
      if (previousParticipation === undefined) delete config.reviewParticipation;
      else config.reviewParticipation = previousParticipation;
    }
  });

  test("defaults agent-default auto-advance off while preserving an explicit trusted opt-in", () => {
    const workspace = vscode.workspace as typeof vscode.workspace & { isTrusted?: boolean };
    const originalTrust = Object.getOwnPropertyDescriptor(workspace, "isTrusted");
    const config = (vscode as unknown as { currentConfig: Record<string, unknown> }).currentConfig;
    const previous = config.autoAdvanceActionableDefaults;
    try {
      Object.defineProperty(workspace, "isTrusted", { configurable: true, writable: true, value: true });
      delete config.autoAdvanceActionableDefaults;
      assert.equal(configuredAutoAdvanceActionableDefaults(), false);
      assert.equal(autoAdvanceActionableDefaults(), false);

      config.autoAdvanceActionableDefaults = true;
      assert.equal(configuredAutoAdvanceActionableDefaults(), true);
      assert.equal(autoAdvanceActionableDefaults(), true);

      config.autoAdvanceActionableDefaults = false;
      assert.equal(configuredAutoAdvanceActionableDefaults(), false);
      assert.equal(autoAdvanceActionableDefaults(), false);

      for (const malformed of ["true", "false", 1, { enabled: true }, [true]]) {
        config.autoAdvanceActionableDefaults = malformed;
        assert.equal(
          configuredAutoAdvanceActionableDefaults(),
          false,
          `only the literal boolean true may arm auto-advance; rejected ${JSON.stringify(malformed)}`,
        );
        assert.equal(
          autoAdvanceActionableDefaults(),
          false,
          `only the literal boolean true may enable auto-advance; rejected ${JSON.stringify(malformed)}`,
        );
      }
    } finally {
      if (previous === undefined) delete config.autoAdvanceActionableDefaults;
      else config.autoAdvanceActionableDefaults = previous;
      if (originalTrust) Object.defineProperty(workspace, "isTrusted", originalTrust);
      else delete (workspace as unknown as { isTrusted?: boolean }).isTrusted;
    }
  });

  test("forces automatic execution controls to safe values when Workspace Trust is false", () => {
    const workspace = vscode.workspace as typeof vscode.workspace & { isTrusted?: boolean };
    const originalTrust = Object.getOwnPropertyDescriptor(workspace, "isTrusted");
    const config = (vscode as unknown as { currentConfig: Record<string, unknown> }).currentConfig;
    const originalConfig = { ...config };
    Object.assign(config, {
      autopilotOnStart: true,
      manyHeadsMode: true,
      preferTerminalBridgeOnStart: true,
      autoVerifyAfterBuild: true,
      autoSkipCloserOnAgreement: false,
      autoRequestReviewAfterPassingVerification: true,
      autoScorePassingBuilds: true,
      autoAdvanceActionableDefaults: true,
    });

    try {
      Object.defineProperty(workspace, "isTrusted", { configurable: true, writable: true, value: false });
      assert.equal(workspaceExecutionControlsAllowed(), false);
      assert.equal(autopilotOnStart(), false);
      assert.equal(manyHeadsMode(), false);
      assert.equal(preferTerminalBridgeOnStart(), false);
      assert.equal(autoVerifyAfterBuild(), false);
      assert.equal(autoRequestReviewAfterPassingVerification(), false);
      assert.equal(autoScorePassingBuilds(), false);
      assert.equal(autoAdvanceActionableDefaults(), false);
      assert.equal(autoSkipCloserOnAgreement(), true, "safe value skips the extra closer dispatch");

      Object.defineProperty(workspace, "isTrusted", { configurable: true, writable: true, value: true });
      assert.equal(workspaceExecutionControlsAllowed(), true);
      assert.equal(autopilotOnStart(), true);
      assert.equal(manyHeadsMode(), true);
      assert.equal(preferTerminalBridgeOnStart(), true);
      assert.equal(autoVerifyAfterBuild(), true);
      assert.equal(autoRequestReviewAfterPassingVerification(), true);
      assert.equal(autoScorePassingBuilds(), true);
      assert.equal(autoAdvanceActionableDefaults(), true);
      assert.equal(autoSkipCloserOnAgreement(), false);
    } finally {
      for (const key of Object.keys(config)) delete config[key];
      Object.assign(config, originalConfig);
      if (originalTrust) Object.defineProperty(workspace, "isTrusted", originalTrust);
      else delete (workspace as unknown as { isTrusted?: boolean }).isTrusted;
    }
  });
});
