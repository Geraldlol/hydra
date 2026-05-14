import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendWorkQueueDisposition,
  applyWorkQueueDispositions,
  ensureWorkQueueStateFile,
  readWorkQueueDispositions,
  workQueueStatePath,
  type WorkQueueDisposition,
} from "../src/workQueueState";
import type { WorkQueueItem } from "../src/workQueue";

const ITEM: WorkQueueItem = {
  id: "item-1",
  kind: "verification",
  severity: "error",
  title: "Fix failing verification",
  detail: "npm test failed",
  actionType: "discussVerification",
  actionLabel: "Discuss",
};

describe("work queue state", () => {
  test("resolves the workspace queue state path", () => {
    assert.equal(
      workQueueStatePath(path.join("C:", "repo")),
      path.join("C:", "repo", ".hydra", "work-queue.jsonl")
    );
  });

  test("creates, appends, and reads queue dispositions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-work-queue-"));
    const file = path.join(dir, ".hydra", "work-queue.jsonl");
    const disposition: WorkQueueDisposition = {
      id: "item-1",
      kind: "dismissed",
      timestamp: "2026-05-09T20:00:00.000Z",
    };

    await ensureWorkQueueStateFile(file);
    await appendWorkQueueDisposition(file, disposition);
    await fs.appendFile(file, "\nnot json\n", "utf8");

    assert.deepEqual(await readWorkQueueDispositions(file), [disposition]);
  });

  test("filters dismissed and active snoozed items", () => {
    const now = new Date("2026-05-09T20:00:00.000Z");
    assert.deepEqual(
      applyWorkQueueDispositions([ITEM], [{
        id: "item-1",
        kind: "dismissed",
        timestamp: "2026-05-09T19:00:00.000Z",
      }], now),
      []
    );

    assert.deepEqual(
      applyWorkQueueDispositions([ITEM], [{
        id: "item-1",
        kind: "snoozed",
        timestamp: "2026-05-09T19:00:00.000Z",
        until: "2026-05-09T21:00:00.000Z",
      }], now),
      []
    );
  });

  test("shows expired snoozed items", () => {
    const visible = applyWorkQueueDispositions([ITEM], [{
      id: "item-1",
      kind: "snoozed",
      timestamp: "2026-05-09T19:00:00.000Z",
      until: "2026-05-09T19:30:00.000Z",
    }], new Date("2026-05-09T20:00:00.000Z"));

    assert.deepEqual(visible, [ITEM]);
  });
});
