import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import type { SteeringSendReceipt, SteeringTargetSelection } from "../src/steeringController";
import {
  loadOrCreateSteeringRelayAuthenticationKey,
  openSteeringRelayRuntime,
  steeringRelaySecretKey,
  steeringRelayWorkspaceId,
  type SteeringRelayController,
  type SteeringRelaySecretStorage,
} from "../src/steeringRelayRuntime";
import { steeringRelayPrincipalSha256 } from "../src/steeringRelay";
import {
  buildTelegramSteeringSubmission,
  configureTelegramSteering,
  isTelegramSteeringRelaySourceAuthorized,
} from "../src/telegramSteering";

const NOW = "2026-08-24T12:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);

describe("steering relay runtime integration", () => {
  test("uses one SecretStorage-only key across concurrent workspace windows", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-steering-runtime-secret-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const values = new Map<string, string>();
    let stores = 0;
    let generations = 0;
    const secrets: SteeringRelaySecretStorage = {
      get: async (key) => values.get(key),
      store: async (key, value) => {
        stores += 1;
        await Promise.resolve();
        values.set(key, value);
      },
    };
    const workspaceId = steeringRelayWorkspaceId(path.join(root, "workspace"));
    const input = {
      secrets,
      privateWorkspaceRoot: root,
      workspaceId,
      generate: () => Buffer.alloc(32, ++generations),
    };

    const [left, right] = await Promise.all([
      loadOrCreateSteeringRelayAuthenticationKey(input),
      loadOrCreateSteeringRelayAuthenticationKey(input),
    ]);

    assert.deepEqual(left, right);
    assert.equal(stores, 1);
    assert.equal(generations, 1);
    assert.equal(values.has(steeringRelaySecretKey(workspaceId)), true);
    assert.equal(await fs.readFile(path.join(root, "steering", ".relay-secret-bootstrap"), "utf8").catch(() => undefined), undefined);
  });

  test("publishes an owner, forwards from a second window, and pumps the exact controller target", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-steering-runtime-forward-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspaceId = steeringRelayWorkspaceId(path.join(root, "workspace"));
    const key = Buffer.alloc(32, 7);
    const target = selection("owner-target", "call-target");
    const delivered: Array<{ text: string; target: string }> = [];
    const ownerController = controller([target], async (input) => {
      delivered.push({ text: input.text, target: input.targets[0]?.selectionSha256 ?? "" });
      return receipt("steering-forwarded", target);
    });
    const senderController = controller([], async () => {
      throw new Error("sender controller must not receive owner delivery");
    });

    const owner = await openSteeringRelayRuntime({
      privateWorkspaceRoot: root,
      workspaceId,
      ownerId: "owner-target",
      authenticationKey: key,
      controller: ownerController,
      authorizeTelegramSource: () => false,
      now: () => NOW,
      startTimers: false,
    });
    const sender = await openSteeringRelayRuntime({
      privateWorkspaceRoot: root,
      workspaceId,
      ownerId: "owner-sender",
      authenticationKey: key,
      controller: senderController,
      authorizeTelegramSource: () => false,
      now: () => NOW,
      startTimers: false,
    });
    t.after(async () => {
      await sender.dispose();
      await owner.dispose();
    });

    const advertised = await sender.listAdvertisedLiveTargets();
    assert.deepEqual(advertised.map((entry) => entry.selectionSha256), [target.selectionSha256]);
    const queued = await sender.submitWindowSteering({ text: "redirect to the failing test", targets: advertised });
    assert.equal(queued.status, "queued");

    await owner.pumpOwnerClaims();
    assert.deepEqual(delivered, [{ text: "redirect to the failing test", target: target.selectionSha256 }]);
    assert.equal((await sender.listAdvertisedLiveTargets()).length, 1);
  });

  test("requires current owner targets and current Telegram source authorization at claim time", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-steering-runtime-auth-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspaceId = steeringRelayWorkspaceId(path.join(root, "workspace"));
    const key = Buffer.alloc(32, 9);
    const target = selection("owner-telegram", "call-telegram");
    const principal = steeringRelayPrincipalSha256("telegram", "authorized-principal");
    let telegramAuthorized = true;
    let deliveries = 0;
    const owner = await openSteeringRelayRuntime({
      privateWorkspaceRoot: root,
      workspaceId,
      ownerId: target.ownerId,
      authenticationKey: key,
      controller: controller([target], async () => {
        deliveries += 1;
        return receipt("steering-telegram", target);
      }),
      authorizeTelegramSource: (source) => telegramAuthorized && source.principalSha256 === principal,
      now: () => NOW,
      startTimers: false,
    });
    t.after(() => owner.dispose());

    telegramAuthorized = false;
    await assert.rejects(owner.submitTelegramSteering({
      workspaceId,
      destinationOwnerId: target.ownerId,
      producerId: "telegram-test-producer",
      sequence: 1,
      issuedAt: NOW,
      expiresAt: "2026-08-24T12:01:00.000Z",
      source: { transport: "telegram", principalSha256: principal },
      intent: "steer",
      roomTurnId: target.roomTurnId,
      text: "authorized text",
      targets: [target],
    }), /not authorized/i);
    assert.equal(deliveries, 0);
  });

  test("delivers an authorized Telegram update through the relay into the owning controller", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-steering-runtime-telegram-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspaceId = steeringRelayWorkspaceId(path.join(root, "workspace"));
    const target = selection("owner-telegram-live", "call-telegram-live");
    const policy = configureTelegramSteering({
      enabled: true,
      botKey: "1234567890abcdef",
      chatId: "-1001234",
      allowedSenderIds: ["987654321"],
      commandPrefix: "/steer",
    });
    const delivered: string[] = [];
    const runtime = await openSteeringRelayRuntime({
      privateWorkspaceRoot: root,
      workspaceId,
      ownerId: target.ownerId,
      authenticationKey: Buffer.alloc(32, 11),
      controller: controller([target], async (input) => {
        delivered.push(input.text);
        return receipt("steering-telegram-live", target);
      }),
      authorizeTelegramSource: (source) => isTelegramSteeringRelaySourceAuthorized(policy, source),
      now: () => NOW,
      startTimers: false,
    });
    t.after(() => runtime.dispose());
    const submission = buildTelegramSteeringSubmission(policy, {
      updateId: 73,
      message: {
        messageId: 91,
        chatId: "-1001234",
        fromId: "987654321",
        fromIsBot: false,
        text: "/steer inspect the retry boundary",
      },
    }, {
      issuedAt: NOW,
      workspaceId,
      destinationOwnerId: target.ownerId,
      roomTurnId: target.roomTurnId,
      targets: [target],
    });

    const accepted = await runtime.submitTelegramSteering(submission);
    assert.equal(accepted.status, "queued");
    assert.deepEqual(delivered, ["inspect the retry boundary"]);
    const duplicate = await runtime.submitTelegramSteering(submission);
    assert.equal(duplicate.status, "duplicateCompleted");
    assert.deepEqual(delivered, ["inspect the retry boundary"]);
  });

  test("zeroizes the relay-owned authentication key when runtime construction rejects invalid intervals", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-steering-runtime-constructor-cleanup-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspaceId = steeringRelayWorkspaceId(path.join(root, "workspace"));
    const callerKey = Buffer.alloc(32, 0x6c);
    const originalFrom = Buffer.from;
    let ownedKey: Buffer | undefined;
    Object.defineProperty(Buffer, "from", {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        const result = Reflect.apply(originalFrom, Buffer, args) as Buffer;
        if (args[0] === callerKey) ownedKey = result;
        return result;
      },
    });

    try {
      await assert.rejects(openSteeringRelayRuntime({
        privateWorkspaceRoot: root,
        workspaceId,
        ownerId: "owner-invalid-runtime",
        authenticationKey: callerKey,
        controller: controller([], async () => {
          throw new Error("invalid runtime must never deliver");
        }),
        authorizeTelegramSource: () => false,
        advertisementTtlMs: 1_000,
        advertisementRefreshMs: 1_000,
        startTimers: false,
      }), /advertisement refresh interval is invalid/i);
    } finally {
      Object.defineProperty(Buffer, "from", {
        configurable: true,
        writable: true,
        value: originalFrom,
      });
    }

    assert.ok(ownedKey, "lower-level relay must have taken an owned key copy");
    assert.deepEqual(ownedKey, Buffer.alloc(callerKey.length), "constructor failure must dispose and zeroize the relay");
    assert.deepEqual(callerKey, Buffer.alloc(callerKey.length, 0x6c), "caller retains ownership of its key");
  });
});

function selection(ownerId: string, callId: string): SteeringTargetSelection {
  return {
    callId,
    generation: `generation-${callId}`,
    agentId: "codex",
    roomTurnId: "room-turn-runtime",
    missionDocumentSha256: HASH_A,
    missionBindingSha256: HASH_B,
    authoritySha256: HASH_C,
    initialPromptSha256: HASH_D,
    ownerId,
    workClass: "build",
    capability: { kind: "live", delivery: "sameTurn", protocol: "test" },
    phaseSnapshot: "build",
    selectionSha256: HASH_E,
  };
}

function controller(
  targets: readonly SteeringTargetSelection[],
  send: SteeringRelayController["send"],
): SteeringRelayController {
  return {
    targetSelections: () => targets.map((target) => ({ ...target, capability: { ...target.capability } })),
    send,
  };
}

function receipt(steeringId: string, target: SteeringTargetSelection): SteeringSendReceipt {
  return {
    steeringId,
    requestEventId: `event-${steeringId}`,
    outcomes: [{
      schemaVersion: 1,
      type: "steeringTargetOutcome",
      eventId: `event-outcome-${steeringId}`,
      occurredAt: NOW,
      steeringId,
      callId: target.callId,
      generation: target.generation,
      sequence: 1,
      outcome: "acknowledged",
      disposition: "acceptedCurrent",
      code: "acknowledged",
      acknowledgedDelivery: "sameTurn",
      providerReceiptSha256: HASH_A,
      steeringChainSha256: HASH_B,
      chainIndeterminate: false,
    }],
    chainBindings: [{
      schemaVersion: 1,
      callId: target.callId,
      generation: target.generation,
      steeringChainSha256: HASH_B,
      chainIndeterminate: false,
      lastSequence: 1,
      lastTerminalSequence: 1,
      lastAcknowledgedSequence: 1,
    }],
  };
}
