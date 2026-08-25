import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { serializePerFileAcrossProcesses } from "../src/fileQueue";
import {
  createSteeringRelayGrantAuthorizer,
  openAuthenticatedSteeringRelay,
  steeringRelayPrincipalSha256,
  type SteeringRelayAuthorizationGrant,
} from "../src/steeringRelay";
import { sha256Utf8, type SteeringTargetSelection } from "../src/steeringRelayProtocol";

const NOW = "2026-08-24T12:00:00.000Z";
const LATER = "2026-08-24T12:02:00.000Z";
const OWNER = "window-owner";
const WORKSPACE = sha256Utf8("workspace-a");
const PRINCIPAL = steeringRelayPrincipalSha256("window", "window-sender");
const KEY = Buffer.alloc(32, 0x5a);

describe("authenticated steering relay", () => {
  test("zeroizes its owned authentication-key copy when setup fails before relay construction", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-steering-relay-key-cleanup-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const blockedRoot = path.join(root, "not-a-directory");
    await fs.writeFile(blockedRoot, "file blocks mkdir\n", "utf8");
    const callerKey = Buffer.alloc(32, 0x6b);
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
      await assert.rejects(openAuthenticatedSteeringRelay({
        privateWorkspaceRoot: blockedRoot,
        workspaceId: WORKSPACE,
        authenticationKey: callerKey,
        authorize: () => true,
        now: () => NOW,
      }));
    } finally {
      Object.defineProperty(Buffer, "from", {
        configurable: true,
        writable: true,
        value: originalFrom,
      });
    }

    assert.ok(ownedKey, "relay must take an owned copy of the authentication key");
    assert.deepEqual(ownedKey, Buffer.alloc(callerKey.length), "failed setup must zeroize the owned key copy");
    assert.deepEqual(callerKey, Buffer.alloc(callerKey.length, 0x6b), "the caller retains ownership of its key");
  });

  test("forwards an exact advertised target across relay instances and deduplicates retries", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-steering-relay-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = targetSelection();
    const grant = authorizationGrant(target);
    const authorize = createSteeringRelayGrantAuthorizer([grant], () => NOW);
    const sender = await openAuthenticatedSteeringRelay({
      privateWorkspaceRoot: root,
      workspaceId: WORKSPACE,
      authenticationKey: KEY,
      authorize,
      now: () => NOW,
      newId: () => "claim-fixed",
    });
    const owner = await openAuthenticatedSteeringRelay({
      privateWorkspaceRoot: root,
      workspaceId: WORKSPACE,
      authenticationKey: KEY,
      authorize,
      now: () => NOW,
      newId: () => "claim-fixed",
    });
    t.after(() => {
      sender.dispose();
      owner.dispose();
    });

    await owner.publishOwnerTargets({
      ownerId: OWNER,
      targets: [target],
      expiresAt: LATER,
    });
    assert.deepEqual(await sender.listActiveTargets(), [target]);

    const queued = await sender.enqueue({
      workspaceId: WORKSPACE,
      destinationOwnerId: OWNER,
      producerId: "window-sender",
      sequence: 1,
      issuedAt: NOW,
      expiresAt: LATER,
      source: { transport: "window", principalSha256: PRINCIPAL },
      intent: "steer",
      roomTurnId: target.roomTurnId,
      text: "Use the failing test as the next checkpoint.",
      targets: [target],
    });
    assert.equal(queued.status, "queued");
    assert.equal(queued.envelope.messageId, "window-sender-0000000000000001");

    const duplicate = await sender.ingest(queued.envelope);
    assert.equal(duplicate.status, "duplicatePending");

    const claim = await owner.claimNext(OWNER);
    assert.ok(claim);
    assert.equal(claim.envelope.messageId, queued.envelope.messageId);
    assert.equal(claim.envelope.targets[0]?.agentId, "codex");
    assert.equal(await owner.claimNext(OWNER), undefined);

    const receipt = await owner.completeClaim(claim, {
      outcome: "delivered",
      code: "acknowledged",
      steeringId: "steering-1",
      resultSha256: sha256Utf8("controller receipt"),
    });
    assert.equal(receipt.outcome, "delivered");
    assert.equal((await sender.receipt(queued.envelope.messageId))?.steeringId, "steering-1");

    const completedDuplicate = await sender.ingest(queued.envelope);
    assert.equal(completedDuplicate.status, "duplicateCompleted");

    const next = await sender.enqueueNext({
      workspaceId: WORKSPACE,
      destinationOwnerId: OWNER,
      producerId: "window-sender",
      issuedAt: NOW,
      expiresAt: LATER,
      source: { transport: "window", principalSha256: PRINCIPAL },
      intent: "steer",
      roomTurnId: target.roomTurnId,
      text: "Now run the whole focused suite.",
      targets: [target],
    });
    assert.equal(next.envelope.sequence, 2);
    assert.ok(next.envelope.messageId > queued.envelope.messageId);
    const processed = await owner.processNext(OWNER, async (envelope) => {
      assert.equal(envelope.targets[0]?.missionBindingSha256, target.missionBindingSha256);
      assert.equal(envelope.targets[0]?.authoritySha256, target.authoritySha256);
      return {
        outcome: "delivered",
        code: "acknowledged",
        steeringId: "steering-2",
      };
    });
    assert.equal(processed?.steeringId, "steering-2");
  });

  test("rejects unauthorized, stale, conflicting, expired, and tampered messages without persisting secrets", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-steering-relay-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = targetSelection();
    const grant = authorizationGrant(target);
    const relay = await openAuthenticatedSteeringRelay({
      privateWorkspaceRoot: root,
      workspaceId: WORKSPACE,
      authenticationKey: KEY,
      authorize: createSteeringRelayGrantAuthorizer([grant], () => NOW),
      now: () => NOW,
    });
    t.after(() => relay.dispose());

    const accepted = await relay.enqueue({
      workspaceId: WORKSPACE,
      destinationOwnerId: OWNER,
      producerId: "window-sender",
      sequence: 4,
      issuedAt: NOW,
      expiresAt: LATER,
      source: { transport: "window", principalSha256: PRINCIPAL },
      intent: "steer",
      roomTurnId: target.roomTurnId,
      text: "first",
      targets: [target],
    });

    await assert.rejects(
      relay.enqueue({
        workspaceId: WORKSPACE,
        destinationOwnerId: OWNER,
        producerId: "window-sender",
        sequence: 4,
        issuedAt: NOW,
        expiresAt: LATER,
        source: { transport: "window", principalSha256: PRINCIPAL },
        intent: "steer",
        roomTurnId: target.roomTurnId,
        text: "different body",
        targets: [target],
      }),
      /sequence was already used/i,
    );
    await assert.rejects(
      relay.enqueue({
        workspaceId: WORKSPACE,
        destinationOwnerId: OWNER,
        producerId: "window-sender",
        sequence: 3,
        issuedAt: NOW,
        expiresAt: LATER,
        source: { transport: "window", principalSha256: PRINCIPAL },
        intent: "steer",
        roomTurnId: target.roomTurnId,
        text: "stale",
        targets: [target],
      }),
      /sequence is stale/i,
    );
    await assert.rejects(
      relay.enqueue({
        workspaceId: WORKSPACE,
        destinationOwnerId: OWNER,
        producerId: "unauthorized-window",
        sequence: 1,
        issuedAt: NOW,
        expiresAt: LATER,
        source: {
          transport: "window",
          principalSha256: steeringRelayPrincipalSha256("window", "not-granted"),
        },
        intent: "steer",
        roomTurnId: target.roomTurnId,
        text: "unauthorized",
        targets: [target],
      }),
      /not authorized/i,
    );
    await assert.rejects(
      relay.enqueue({
        workspaceId: WORKSPACE,
        destinationOwnerId: OWNER,
        producerId: "window-mission-mismatch",
        sequence: 1,
        issuedAt: NOW,
        expiresAt: LATER,
        source: { transport: "window", principalSha256: PRINCIPAL },
        intent: "steer",
        roomTurnId: target.roomTurnId,
        text: "must not cross changed authority",
        targets: [{ ...target, authoritySha256: sha256Utf8("changed-authority") }],
      }),
      /not authorized/i,
    );

    const tampered = {
      ...accepted.envelope,
      text: "tampered after signing",
    };
    await assert.rejects(relay.ingest(tampered), /authentication failed/i);

    const expiredRelay = await openAuthenticatedSteeringRelay({
      privateWorkspaceRoot: root,
      workspaceId: WORKSPACE,
      authenticationKey: KEY,
      authorize: createSteeringRelayGrantAuthorizer([grant], () => "2026-08-24T12:03:00.000Z"),
      now: () => "2026-08-24T12:03:00.000Z",
    });
    t.after(() => expiredRelay.dispose());
    await assert.rejects(
      expiredRelay.enqueue({
        workspaceId: WORKSPACE,
        destinationOwnerId: OWNER,
        producerId: "other-window",
        sequence: 1,
        issuedAt: NOW,
        expiresAt: LATER,
        source: { transport: "window", principalSha256: PRINCIPAL },
        intent: "steer",
        roomTurnId: target.roomTurnId,
        text: "expired",
        targets: [target],
      }),
      /expired/i,
    );

    const stateText = await fs.readFile(path.join(root, "steering", "relay.v1.json"), "utf8");
    assert.equal(stateText.includes(KEY.toString("hex")), false);
    assert.equal(stateText.includes("unauthorized"), false);
    assert.equal(stateText.includes("tampered after signing"), false);
  });

  test("enforces queue bounds and closes abandoned claims as delivery-unknown without replay", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-steering-relay-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    let clock = NOW;
    let claimId = 0;
    const target = targetSelection();
    const relay = await openAuthenticatedSteeringRelay({
      privateWorkspaceRoot: root,
      workspaceId: WORKSPACE,
      authenticationKey: KEY,
      authorize: createSteeringRelayGrantAuthorizer([authorizationGrant(target)], () => clock),
      now: () => clock,
      newId: () => `claim-${++claimId}`,
      limits: { maxPendingMessages: 1, claimLeaseMs: 1_000 },
    });
    t.after(() => relay.dispose());

    await relay.enqueue({
      workspaceId: WORKSPACE,
      destinationOwnerId: OWNER,
      producerId: "window-sender",
      sequence: 1,
      issuedAt: NOW,
      expiresAt: LATER,
      source: { transport: "window", principalSha256: PRINCIPAL },
      intent: "steer",
      roomTurnId: target.roomTurnId,
      text: "one",
      targets: [target],
    });
    await assert.rejects(
      relay.enqueue({
        workspaceId: WORKSPACE,
        destinationOwnerId: OWNER,
        producerId: "window-two",
        sequence: 1,
        issuedAt: NOW,
        expiresAt: LATER,
        source: { transport: "window", principalSha256: PRINCIPAL },
        intent: "steer",
        roomTurnId: target.roomTurnId,
        text: "two",
        targets: [target],
      }),
      /queue is full/i,
    );

    const claim = await relay.claimNext(OWNER);
    assert.ok(claim);
    clock = "2026-08-24T12:00:02.000Z";
    const lateCompletion = await relay.completeClaim(claim, {
      outcome: "delivered",
      code: "acknowledged",
      steeringId: "must-not-be-accepted",
    });
    assert.equal(lateCompletion.outcome, "deliveryUnknown");
    assert.equal(lateCompletion.code, "claimExpired");
    assert.equal(lateCompletion.steeringId, undefined);
    assert.equal(await relay.claimNext(OWNER), undefined);
    const receipt = await relay.receipt(claim.envelope.messageId);
    assert.equal(receipt?.outcome, "deliveryUnknown");
    assert.equal(receipt?.code, "claimExpired");

    await relay.enqueue({
      workspaceId: WORKSPACE,
      destinationOwnerId: OWNER,
      producerId: "window-sender",
      sequence: 2,
      issuedAt: clock,
      expiresAt: LATER,
      source: { transport: "window", principalSha256: PRINCIPAL },
      intent: "steer",
      roomTurnId: target.roomTurnId,
      text: "handler failure",
      targets: [target],
    });
    const failed = await relay.processNext(OWNER, async () => {
      throw new Error("provider leaked-token-marker");
    });
    assert.equal(failed?.outcome, "deliveryUnknown");
    assert.equal(failed?.code, "handlerFailed");

    await relay.enqueue({
      workspaceId: WORKSPACE,
      destinationOwnerId: OWNER,
      producerId: "window-sender",
      sequence: 3,
      issuedAt: clock,
      expiresAt: LATER,
      source: { transport: "window", principalSha256: PRINCIPAL },
      intent: "steer",
      roomTurnId: target.roomTurnId,
      text: "lock-wait expiry",
      targets: [target],
    });
    const contendedClaim = await relay.claimNext(OWNER);
    assert.ok(contendedClaim);
    let signalLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      signalLockHeld = resolve;
    });
    let releaseLock!: () => void;
    const mayRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holder = serializePerFileAcrossProcesses(relay.paths.statePath, async () => {
      signalLockHeld();
      await mayRelease;
    });
    await lockHeld;
    const contendedCompletion = relay.completeClaim(contendedClaim, {
      outcome: "delivered",
      code: "acknowledged",
      steeringId: "must-not-cross-lock-expiry",
    });
    clock = "2026-08-24T12:00:04.000Z";
    releaseLock();
    await holder;
    const expiredAfterLockWait = await contendedCompletion;
    assert.equal(expiredAfterLockWait.outcome, "deliveryUnknown");
    assert.equal(expiredAfterLockWait.code, "claimExpired");
    assert.equal(expiredAfterLockWait.steeringId, undefined);

    const state = await fs.readFile(path.join(root, "steering", "relay.v1.json"), "utf8");
    assert.equal(state.includes("leaked-token-marker"), false);
  });

  test("fails closed when the private relay state is modified without its authentication key", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-steering-relay-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = targetSelection();
    const relay = await openAuthenticatedSteeringRelay({
      privateWorkspaceRoot: root,
      workspaceId: WORKSPACE,
      authenticationKey: KEY,
      authorize: createSteeringRelayGrantAuthorizer([authorizationGrant(target)], () => NOW),
      now: () => NOW,
    });
    relay.dispose();
    const statePath = path.join(root, "steering", "relay.v1.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<string, unknown>;
    state.workspaceId = sha256Utf8("other-workspace");
    await fs.writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");

    await assert.rejects(
      openAuthenticatedSteeringRelay({
        privateWorkspaceRoot: root,
        workspaceId: WORKSPACE,
        authenticationKey: KEY,
        authorize: () => true,
        now: () => NOW,
      }),
      /workspace binding|authentication/i,
    );
  });
});

function targetSelection(): SteeringTargetSelection {
  return {
    callId: "call-1",
    generation: "generation-1",
    agentId: "codex",
    roomTurnId: "turn-1",
    missionDocumentSha256: sha256Utf8("mission"),
    missionBindingSha256: sha256Utf8("mission-binding"),
    authoritySha256: sha256Utf8("authority"),
    initialPromptSha256: sha256Utf8("prompt"),
    ownerId: OWNER,
    workClass: "build",
    capability: { kind: "live", delivery: "sameTurn", protocol: "test" },
    phaseSnapshot: "building",
    timeoutDeadlineMs: Date.parse(LATER),
    selectionSha256: sha256Utf8("selection"),
  };
}

function authorizationGrant(target: SteeringTargetSelection): SteeringRelayAuthorizationGrant {
  return {
    grantId: "grant-1",
    source: { transport: "window", principalSha256: PRINCIPAL },
    workspaceId: WORKSPACE,
    destinationOwnerId: OWNER,
    roomTurnId: target.roomTurnId,
    missionDocumentSha256: target.missionDocumentSha256,
    missionBindingSha256: target.missionBindingSha256,
    authoritySha256: target.authoritySha256,
    intents: ["steer"],
    targets: [{
      callId: target.callId,
      generation: target.generation,
      agentId: target.agentId,
      selectionSha256: target.selectionSha256,
    }],
    expiresAt: LATER,
  };
}
