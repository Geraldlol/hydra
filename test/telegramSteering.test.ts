import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildTelegramSteeringSubmission,
  configureTelegramSteering,
  isTelegramSteeringRelaySourceAuthorized,
  TelegramSteeringConfigError,
  TelegramSteeringRejectedError,
} from "../src/telegramSteering";
import type { TelegramUpdate } from "../src/telegram";
import { telegramBotKey } from "../src/telegramCoordinator";
import { sha256Utf8, type SteeringTargetSelection } from "../src/steeringRelayProtocol";

const NOW = "2026-08-24T12:00:00.000Z";
const OWNER = "window-owner";
const WORKSPACE = sha256Utf8("workspace-a");

describe("Telegram steering authorization", () => {
  test("requires an explicit sender allowlist and a non-empty command prefix", () => {
    assert.throws(
      () => configureTelegramSteering({
        enabled: true,
        botKey: telegramBotKey("123:secret-token"),
        chatId: "-1001",
        allowedSenderIds: [],
        commandPrefix: "/steer",
      }),
      (error: unknown) => error instanceof TelegramSteeringConfigError
        && error.code === "senderAllowlistRequired",
    );
    assert.throws(
      () => configureTelegramSteering({
        enabled: true,
        botKey: telegramBotKey("123:secret-token"),
        chatId: "-1001",
        allowedSenderIds: ["42"],
        commandPrefix: "",
      }),
      (error: unknown) => error instanceof TelegramSteeringConfigError
        && error.code === "invalidPrefix",
    );
    assert.deepEqual(configureTelegramSteering({ enabled: false }), { kind: "disabled" });
  });

  test("maps one authorized Telegram update to a bounded idempotent relay submission", () => {
    const botToken = "123:super-secret-token";
    const policy = configureTelegramSteering({
      enabled: true,
      botKey: telegramBotKey(botToken),
      chatId: "-1001",
      allowedSenderIds: ["42"],
      commandPrefix: "/steer",
      messageTtlMs: 60_000,
    });
    const update: TelegramUpdate = {
      updateId: 101,
      message: {
        messageId: 20,
        chatId: "-1001",
        fromId: "42",
        from: "Alice",
        text: "/steer Re-run the focused regression test.",
      },
    };
    const target = targetSelection();
    const first = buildTelegramSteeringSubmission(policy, update, {
      issuedAt: NOW,
      workspaceId: WORKSPACE,
      destinationOwnerId: OWNER,
      roomTurnId: target.roomTurnId,
      targets: [target],
    });
    const retry = buildTelegramSteeringSubmission(policy, update, {
      issuedAt: NOW,
      workspaceId: WORKSPACE,
      destinationOwnerId: OWNER,
      roomTurnId: target.roomTurnId,
      targets: [target],
    });

    assert.deepEqual(retry, first);
    assert.equal(first.sequence, 102);
    assert.equal(first.intent, "steer");
    assert.equal(first.text, "Re-run the focused regression test.");
    assert.equal(first.source.transport, "telegram");
    assert.match(first.source.principalSha256, /^[a-f0-9]{64}$/);
    assert.equal(isTelegramSteeringRelaySourceAuthorized(policy, first.source), true);
    assert.equal(isTelegramSteeringRelaySourceAuthorized(policy, {
      transport: "telegram",
      principalSha256: sha256Utf8("someone else"),
    }), false);
    const serialized = JSON.stringify(first);
    assert.equal(serialized.includes(botToken), false);
    assert.equal(serialized.includes("-1001"), false);
    assert.equal(serialized.includes('"42"'), false);
  });

  test("fails closed on the wrong chat, unauthorized or missing sender, bot messages, stale shape, and oversize text", () => {
    const policy = configureTelegramSteering({
      enabled: true,
      botKey: telegramBotKey("123:secret-token"),
      chatId: "-1001",
      allowedSenderIds: ["42"],
      commandPrefix: "/steer",
    });
    const target = targetSelection();
    const route = {
      issuedAt: NOW,
      workspaceId: WORKSPACE,
      destinationOwnerId: OWNER,
      roomTurnId: target.roomTurnId,
      targets: [target],
    } as const;
    const base: TelegramUpdate = {
      updateId: 5,
      message: { messageId: 1, chatId: "-1001", fromId: "42", text: "/steer proceed" },
    };

    assertRejected({ ...base, message: { ...base.message!, chatId: "-999" } }, "wrongChat");
    assertRejected({ ...base, message: { ...base.message!, fromId: "99" } }, "unauthorizedSender");
    assertRejected({ ...base, message: { ...base.message!, fromId: undefined } }, "unauthorizedSender");
    assertRejected({ ...base, message: { ...base.message!, fromIsBot: true } }, "botSender");
    assertRejected({ ...base, updateId: -1 }, "malformedUpdate");
    assertRejected({ ...base, message: { ...base.message!, text: "not a steer" } }, "prefixMismatch");
    assertRejected({ ...base, message: { ...base.message!, text: "/steer " } }, "emptyMessage");
    assertRejected({
      ...base,
      message: { ...base.message!, text: `/steer ${"x".repeat(64 * 1024 + 1)}` },
    }, "messageTooLarge");

    function assertRejected(update: TelegramUpdate, code: TelegramSteeringRejectedError["code"]): void {
      assert.throws(
        () => buildTelegramSteeringSubmission(policy, update, route),
        (error: unknown) => error instanceof TelegramSteeringRejectedError && error.code === code,
      );
    }
  });

  test("does not let Telegram text select a different run or change Mission and authority bindings", () => {
    const policy = configureTelegramSteering({
      enabled: true,
      botKey: telegramBotKey("123:secret-token"),
      chatId: "-1001",
      allowedSenderIds: ["42"],
      commandPrefix: "/steer",
    });
    const target = targetSelection();
    const submission = buildTelegramSteeringSubmission(policy, {
      updateId: 8,
      message: {
        messageId: 2,
        chatId: "-1001",
        fromId: "42",
        text: "/steer target=other-agent mission=override Continue safely.",
      },
    }, {
      issuedAt: NOW,
      workspaceId: WORKSPACE,
      destinationOwnerId: OWNER,
      roomTurnId: target.roomTurnId,
      targets: [target],
    });

    assert.deepEqual(submission.targets, [target]);
    assert.equal(submission.targets[0]?.agentId, "codex");
    assert.equal(submission.targets[0]?.missionBindingSha256, target.missionBindingSha256);
    assert.equal(submission.targets[0]?.authoritySha256, target.authoritySha256);
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
    timeoutDeadlineMs: Date.parse("2026-08-24T12:10:00.000Z"),
    selectionSha256: sha256Utf8("selection"),
  };
}
