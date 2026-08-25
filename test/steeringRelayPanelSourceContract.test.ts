import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";

const panel = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
const telegram = fs.readFileSync(path.join(process.cwd(), "src", "telegramController.ts"), "utf8");
const manifest = fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8");

describe("steering relay panel integration source contract", () => {
  test("loads the relay authentication key only through per-workspace SecretStorage", () => {
    const start = panel.indexOf("loadOrCreateSteeringRelayAuthenticationKey({");
    const end = panel.indexOf("relayKey?.fill(0)", start);
    const initialization = panel.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(initialization, /secrets: this\.context\.secrets/);
    assert.match(initialization, /privateWorkspaceRoot: this\.workspacePrivateStorageRoot\(\)/);
    assert.doesNotMatch(initialization, /workspaceState|globalState|getConfiguration|transcript/);
    assert.match(panel, /relayKey\?\.fill\(0\)/);
  });

  test("refreshes owner advertisements on exact native-handle lifecycle changes", () => {
    const start = panel.indexOf("private createSteerableNativeRunner(");
    const end = panel.indexOf("private async runAgentTransport(", start);
    const method = panel.slice(start, end);
    assert.match(method, /onRegistrationChanged: \(\) => \{[\s\S]*steeringRelayRuntime\?\.notifyOwnerTargetsChanged\(\)/);
    assert.match(panel, /void this\.steeringRelayRuntime\?\.dispose\(\)/);
    assert.match(panel, /if \(this\.disposed\) \{\s*steeringOwnerLease\.dispose\(\);\s*return;/);
    assert.match(panel, /if \(this\.disposed\) \{\s*await steeringRelayRuntime\.dispose\(\);\s*return;/);
  });

  test("routes Telegram steering only after the existing durable room routing boundary", () => {
    const recordsRead = telegram.indexOf("readTelegramInboxForRoom(paths");
    const steeringHook = telegram.indexOf("handleInboundSteering?.(", recordsRead);
    const ordinaryTurn = telegram.indexOf("sendInboundUserMessage(telegramPrompt", steeringHook);
    assert.ok(recordsRead >= 0 && steeringHook > recordsRead && ordinaryTurn > steeringHook);
    assert.match(telegram.slice(steeringHook, ordinaryTurn), /acknowledgeTelegramInboxRecord/);
    assert.match(panel, /isTelegramSteeringRelaySourceAuthorized\(this\.telegramSteeringPolicy\(\), source\)/);
    assert.match(panel, /policy\.botKey !== routedBotKey/);
    assert.match(panel, /buildTelegramSteeringSubmission\(policy, update/);
    assert.match(panel, /relay\.submitTelegramSteering\(submission\)/);
  });

  test("keeps Telegram live steering separately opt-in and application-scoped", () => {
    assert.match(manifest, /"hydraRoom\.telegramLiveSteeringEnabled"[\s\S]*?"scope": "application"[\s\S]*?"default": false/);
    assert.match(manifest, /"hydraRoom\.telegramLiveSteeringCommandPrefix"[\s\S]*?"scope": "application"[\s\S]*?"default": "\/steer"/);
    assert.match(panel, /telegramLiveSteeringEnabled\(\)/);
    assert.match(panel, /telegramInboundAllowedSenderIds\(\)/);
  });
});
