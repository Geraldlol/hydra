import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  acknowledgeTelegramInboxRecord,
  appendTelegramInboxRecord,
  appendTelegramRoutingRecord,
  ensureTelegramCoordinator,
  findTelegramRoutingRecord,
  persistTelegramInboxRecordAndOffset,
  readTelegramInboxForRoom,
  readTelegramOffset,
  telegramCoordinatorPaths,
  telegramRoomToken,
  withTelegramPollerLease,
  writeTelegramOffset,
  type TelegramPollerLease,
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

  test("keeps shared inbox records pending until processing is explicitly acknowledged", async () => {
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
      assert.equal((await readTelegramInboxForRoom(paths, { roomSessionId: "session-1", stateFile })).length, 1);
      await acknowledgeTelegramInboxRecord(stateFile, "in-1");
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

  test("elects one winner when pollers contend concurrently", async () => {
    const restore = await useTempAppData();
    try {
      const paths = telegramCoordinatorPaths("123:token");
      await ensureTelegramCoordinator(paths);
      let workCalls = 0;
      const contenders = Array.from({ length: 8 }, (_, index) =>
        withTelegramPollerLease(paths, `owner-${index}`, 60_000, async () => {
          workCalls += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          return index;
        })
      );
      const results = await Promise.all(contenders);
      assert.equal(workCalls, 1);
      assert.equal(results.filter((result) => result !== undefined).length, 1);
    } finally {
      restore();
    }
  });

  test("fences released lease tokens and never lets a stale completion lower or advance the offset", async () => {
    const restore = await useTempAppData();
    try {
      const paths = telegramCoordinatorPaths("123:token");
      await ensureTelegramCoordinator(paths);
      let stale: TelegramPollerLease | undefined;
      await withTelegramPollerLease(paths, "old-owner", 60_000, async (lease) => {
        stale = lease;
        assert.equal(await writeTelegramOffset(paths, lease, 10), true);
      });
      assert.ok(stale);
      assert.equal(stale.signal.aborted, true);

      await withTelegramPollerLease(paths, "new-owner", 60_000, async (lease) => {
        assert.equal(await writeTelegramOffset(paths, lease, 20), true);
        assert.equal(await writeTelegramOffset(paths, stale!, 5), false);
        assert.equal(await writeTelegramOffset(paths, stale!, 30), false);
        assert.equal(await readTelegramOffset(paths), 20);
      });
      assert.equal(await readTelegramOffset(paths), 20);
    } finally {
      restore();
    }
  });

  test("an expired owner cannot write or remove its successor's lease", async () => {
    const restore = await useTempAppData();
    let releaseOld: (() => void) | undefined;
    try {
      const paths = telegramCoordinatorPaths("123:token");
      await ensureTelegramCoordinator(paths);
      let oldLease: TelegramPollerLease | undefined;
      const oldRelease = new Promise<void>((resolve) => { releaseOld = resolve; });
      let signalOldStarted!: () => void;
      const oldStarted = new Promise<void>((resolve) => { signalOldStarted = resolve; });
      const oldRun = withTelegramPollerLease(paths, "old-owner", 35, async (lease) => {
        oldLease = lease;
        signalOldStarted();
        await oldRelease;
        return "old-finished";
      });
      await oldStarted;
      await new Promise<void>((resolve) => setTimeout(resolve, 60));

      const successor = await withTelegramPollerLease(paths, "new-owner", 1_000, async (lease) => {
        assert.ok(oldLease);
        assert.equal(oldLease.signal.aborted, true);
        assert.equal(await writeTelegramOffset(paths, oldLease, 10), false);
        assert.equal(await writeTelegramOffset(paths, lease, 20), true);
        releaseOld?.();
        assert.equal(await oldRun, "old-finished");
        // The old generation's finally block removed only its token file.
        assert.equal(await writeTelegramOffset(paths, lease, 30), true);
        return "new-finished";
      });
      assert.equal(successor, "new-finished");
      assert.equal(await readTelegramOffset(paths), 30);
    } finally {
      releaseOld?.();
      restore();
    }
  });

  test("ignores an oversized legacy offset JSON file", async () => {
    const restore = await useTempAppData();
    try {
      const paths = telegramCoordinatorPaths("123:token");
      await ensureTelegramCoordinator(paths);
      await fs.writeFile(
        paths.offsetFile,
        JSON.stringify({ offset: 123, padding: "x".repeat(70 * 1024) }),
        "utf8"
      );
      assert.equal(await readTelegramOffset(paths), undefined);
    } finally {
      restore();
    }
  });

  test("does not consume an inbox record when durable acknowledgement fails", async () => {
    const restore = await useTempAppData();
    try {
      const paths = telegramCoordinatorPaths("123:token");
      await ensureTelegramCoordinator(paths);
      const stateFile = path.join(paths.dir, "room", ".hydra", "telegram-state.json");
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      await appendTelegramInboxRecord(paths, inboxRecord("in-failure", 7));
      const ackFile = `${stateFile}.acks.jsonl`;
      await fs.mkdir(ackFile, { recursive: true });

      await assert.rejects(acknowledgeTelegramInboxRecord(stateFile, "in-failure"));
      assert.equal((await readTelegramInboxForRoom(paths, { roomSessionId: "session-1", stateFile })).length, 1);

      await fs.rm(ackFile, { recursive: true, force: true });
      await acknowledgeTelegramInboxRecord(stateFile, "in-failure");
      assert.equal((await readTelegramInboxForRoom(paths, { roomSessionId: "session-1", stateFile })).length, 0);
    } finally {
      restore();
    }
  });

  test("does not advance the Telegram offset when durable inbox persistence fails", async () => {
    const restore = await useTempAppData();
    try {
      const paths = telegramCoordinatorPaths("123:token");
      await ensureTelegramCoordinator(paths);
      await fs.rm(paths.inboxFile, { force: true });
      await fs.mkdir(paths.inboxFile);

      await withTelegramPollerLease(paths, "owner", 60_000, async (lease) => {
        await assert.rejects(persistTelegramInboxRecordAndOffset(paths, lease, inboxRecord("will-retry", 12), 13));
        assert.equal(await readTelegramOffset(paths), undefined);
      });
    } finally {
      restore();
    }
  });

  test("retries cleanly when per-room persistence succeeds before the legacy aggregate fails", async () => {
    const restore = await useTempAppData();
    try {
      const paths = telegramCoordinatorPaths("123:token");
      await ensureTelegramCoordinator(paths);
      const record = inboxRecord("partial-persist", 18);
      await fs.rm(paths.inboxFile, { force: true });
      await fs.mkdir(paths.inboxFile);

      await withTelegramPollerLease(paths, "owner", 2_000, async (lease) => {
        await assert.rejects(persistTelegramInboxRecordAndOffset(paths, lease, record, 19));
        assert.equal(await readTelegramOffset(paths), undefined);
        assert.deepEqual(
          (await readTelegramInboxForRoom(paths, {
            roomSessionId: "session-1",
            stateFile: path.join(paths.dir, "partial-state.json"),
          })).map((item) => item.id),
          [record.id],
        );

        await fs.rm(paths.inboxFile, { recursive: true, force: true });
        await fs.writeFile(paths.inboxFile, "", "utf8");
        assert.equal(await persistTelegramInboxRecordAndOffset(paths, lease, record, 19), true);
        assert.equal(await readTelegramOffset(paths), 19);
        const aggregate = (await fs.readFile(paths.inboxFile, "utf8")).trim().split(/\r?\n/);
        assert.equal(aggregate.length, 1);
      });
    } finally {
      restore();
    }
  });

  test("deduplicates a redelivered update before offset acknowledgement", async () => {
    const restore = await useTempAppData();
    try {
      const paths = telegramCoordinatorPaths("123:token");
      await ensureTelegramCoordinator(paths);
      const record = inboxRecord("same-update", 11);
      await Promise.all([
        appendTelegramInboxRecord(paths, record),
        appendTelegramInboxRecord(paths, record),
      ]);
      const lines = (await fs.readFile(paths.inboxFile, "utf8")).trim().split(/\r?\n/);
      assert.equal(lines.length, 1);
    } finally {
      restore();
    }
  });

  test("keeps a dormant room command after the legacy aggregate is replaced by other-room traffic", async () => {
    const restore = await useTempAppData();
    try {
      const paths = telegramCoordinatorPaths("123:token");
      await ensureTelegramCoordinator(paths);
      const target = inboxRecord("dormant-room", 1);
      await appendTelegramInboxRecord(paths, target);

      const unrelated = Array.from({ length: 650 }, (_, index) => ({
        ...inboxRecord(`other-${index}`, index + 2),
        roomSessionId: "other-room",
      }));
      await fs.writeFile(
        paths.inboxFile,
        unrelated.map((record) => JSON.stringify(record)).join("\n") + "\n",
        "utf8",
      );

      const pending = await readTelegramInboxForRoom(paths, {
        roomSessionId: "session-1",
        stateFile: path.join(paths.dir, "dormant-state.json"),
      });
      assert.deepEqual(pending.map((record) => record.id), ["dormant-room"]);
    } finally {
      restore();
    }
  });

  test("hardens coordinator directories and files on POSIX", { skip: process.platform === "win32" }, async () => {
    const restore = await useTempAppData();
    try {
      const paths = telegramCoordinatorPaths("123:token");
      await ensureTelegramCoordinator(paths);
      assert.equal((await fs.stat(paths.dir)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(paths.roomInboxDir)).mode & 0o777, 0o700);
      for (const file of [paths.offsetFile, paths.routingFile, paths.inboxFile]) {
        assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
      }
    } finally {
      restore();
    }
  });

  test("derives compact stable room tokens", () => {
    assert.equal(telegramRoomToken("1700000000000-abc123"), "00abc123");
  });
});

function inboxRecord(id: string, updateId: number) {
  return {
    id,
    updateId,
    botKey: "bot",
    chatId: "chat",
    roomSessionId: "session-1",
    workspace: "C:\\repo",
    command: "continue",
    message: { chatId: "chat", text: "continue", messageId: updateId },
    receivedAt: "2026-05-18T10:00:00.000Z",
  };
}

async function useTempAppData(): Promise<() => void> {
  const prior = process.env.APPDATA;
  const priorXdg = process.env.XDG_CONFIG_HOME;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-telegram-"));
  process.env.APPDATA = tempDir;
  process.env.XDG_CONFIG_HOME = tempDir;
  return () => {
    if (prior === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prior;
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorXdg;
  };
}
