import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderHydraStatusBar, type HydraStatusBarSnapshot } from "../src/statusBar";

const base: HydraStatusBarSnapshot = {
  workspaceReady: true,
  phaseLabel: "Awaiting your reply",
  transport: "oneShot",
  workQueueCount: 0,
  canStop: false,
  verificationRunning: false,
  autopilotRunning: false,
};

describe("status bar", () => {
  test("shows setup attention without a workspace", () => {
    const rendered = renderHydraStatusBar({ ...base, workspaceReady: false });
    assert.equal(rendered.text, "$(warning) Hydra setup");
    assert.equal(rendered.attention, "warning");
    assert.match(rendered.tooltip, /needs a workspace folder/);
  });

  test("shows active execution states before queue attention", () => {
    assert.equal(renderHydraStatusBar({ ...base, workQueueCount: 2, canStop: true }).text, "$(sync~spin) Hydra running");
    assert.equal(renderHydraStatusBar({ ...base, workQueueCount: 2, verificationRunning: true }).text, "$(sync~spin) Hydra verify");
    assert.equal(renderHydraStatusBar({ ...base, workQueueCount: 2, autopilotRunning: true }).text, "$(sync~spin) Hydra auto");
  });

  test("shows queue count when idle work exists", () => {
    const rendered = renderHydraStatusBar({ ...base, workQueueCount: 3, transport: "terminalBridge" });
    assert.equal(rendered.text, "$(warning) Hydra 3");
    assert.equal(rendered.attention, "warning");
    assert.match(rendered.tooltip, /terminal bridge/);
  });

  test("shows ready state when clear", () => {
    const rendered = renderHydraStatusBar(base);
    assert.equal(rendered.text, "$(hubot) Hydra");
    assert.equal(rendered.attention, "none");
  });
});
