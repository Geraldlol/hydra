import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendTelegramInboxRecord,
  appendTelegramRoutingRecord,
  ensureTelegramCoordinator,
  findTelegramRoutingRecord,
  readTelegramInboxForRoom,
  telegramCoordinatorPaths,
  telegramRoomToken,
  withTelegramPollerLease,
} from "../src/telegramCoordinator";

describe("telegram coordinator", () => {
  test("stores routing records and finds them by reply message or room token", async () => {
    const restore = await useTempAppData();
    try {
      const paths = telegramCoordinatorPaths("123:token");
      await ensureTelegramCoordinator(paths);
      await appendTelegramRoutingRecord(paths, {
        messageId: 42,
        botKey: "bot",
        chatId: "chat",
        roomSessionId: "session-1",
        roomToken: "abc123",
        workspace: "C:\\repo",
        timestamp: "2026-05-18T10:00:00.000Z",
      });

      assert.equal((await findTelegramRoutingRecord(paths, { chatId: "chat", messageId: 42 }))?.roomSessionId, "session-1");
      assert.equal((await findTelegramRoutingRecord(paths, { chatId: "chat", roomToken: "abc123" }))?.workspace, "C:\\repo");
      assert.equal(await findTelegramRoutingRecord(paths, { chatId: "other", messageId: 42 }), undefined);
    } finally {
      restore();
    }
  });

  test("delivers shared inbox records once per room session", async () => {
    const restore = await useTempAppData();
    try {
      const paths = telegramCoordinatorPaths("123:token");
      await ensureTelegramCoordinator(paths);
      const stateFile = path.join(paths.dir, "local-state.json");
      await appendTelegramInboxRecord(paths, {
        id: "in-1",
        updateId: 1,
        botKey: "bot",
        chatId: "chat",
        roomSessionId: "session-1",
        workspace: "C:\\repo",
        command: "continue",
        message: { chatId: "chat", text: "continue", messageId: 99 },
        receivedAt: "2026-05-18T10:00:00.000Z",
      });

      assert.equal((await readTelegramInboxForRoom(paths, { roomSessionId: "session-1", stateFile })).length, 1);
      assert.equal((await readTelegramInboxForRoom(paths, { roomSessionId: "session-1", stateFile })).length, 0);
    } finally {
      restore();
    }
  });

  test("allows only one active poller lease", async () => {
    const restore = await useTempAppData();
    try {
      const paths = telegramCoordinatorPaths("123:token");
      await ensureTelegramCoordinator(paths);
      const first = await withTelegramPollerLease(paths, "owner-1", 60_000, async () => {
        return await withTelegramPollerLease(paths, "owner-2", 60_000, async () => "second") ?? "first";
      });
      assert.equal(first, "first");
    } finally {
      restore();
    }
  });

  test("derives compact stable room tokens", () => {
    assert.equal(telegramRoomToken("1700000000000-abc123"), "00abc123");
  });
});

async function useTempAppData(): Promise<() => void> {
  const prior = process.env.APPDATA;
  process.env.APPDATA = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-telegram-"));
  return () => {
    if (prior === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prior;
  };
}
