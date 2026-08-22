import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  startArenaMainWorkspaceMonitor,
  type ArenaMainWorkspaceBaseline,
  type ArenaMainWorkspaceSnapshot,
} from "../src/arenaMainWorkspaceMonitor";
import type { DuelWorkspaceMutationMonitor } from "../src/duelWorkspaceGuard";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const HEAD = {
  objectFormat: "sha1" as const,
  oid: "1".repeat(40),
};

function watcher(): DuelWorkspaceMutationMonitor & {
  setChanged(value: boolean): void;
  setError(value: string | undefined): void;
} {
  let changed = false;
  let error: string | undefined;
  return {
    get changed() { return changed || error !== undefined; },
    get changedPaths() { return changed ? ["secret/path.ts"] : []; },
    get error() { return error; },
    setChanged(value) { changed = value; },
    setError(value) { error = value; },
    async settle() {},
    close() {},
  };
}

function baseline(): ArenaMainWorkspaceBaseline {
  return {
    runId: "arena-run",
    sourceWorkspaceFingerprintSha256: SHA_A,
    repositoryControlSha256: SHA_B,
    head: HEAD,
  };
}

describe("Arena main workspace monitor", () => {
  test("starts before observations and emits hash-only unchanged receipts", async () => {
    const sentinel = watcher();
    const monitor = startArenaMainWorkspaceMonitor(
      "C:\\workspace",
      baseline(),
      async () => baseline(),
      {
        watch: () => sentinel,
        randomId: () => "epoch",
        persistReceipt: (receipt) => {
          assert.equal(receipt.runId, "arena-run");
          assert.equal(receipt.receiptSha256.length, 64);
        },
      },
    );
    const first = await monitor.observe("monitorStarted");
    assert.equal(first.status, "unchanged");
    assert.equal(first.reasonCode, null);
    assert.equal(first.monitorEpochId, "arena-monitor-epoch");
    assert.match(first.monitorReceiptSha256, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(first), /secret\/path/u);
    monitor.close();
  });

  test("latches write-and-revert events even when the snapshot is unchanged", async () => {
    const sentinel = watcher();
    const monitor = startArenaMainWorkspaceMonitor(
      "C:\\workspace",
      baseline(),
      async () => baseline(),
      { watch: () => sentinel, randomId: () => "epoch" },
    );
    await monitor.observe("monitorStarted");
    sentinel.setChanged(true);
    const checkpoint = await monitor.observe("checkpoint");
    assert.equal(checkpoint.status, "changed");
    assert.equal(checkpoint.reasonCode, "watcherChanged");
    assert.equal(monitor.compromised, true);
  });

  test("distinguishes fingerprint, HEAD, repository, and monitor failures", async () => {
    const cases = [
      {
        snapshot: {
          ...baseline(),
          sourceWorkspaceFingerprintSha256: "c".repeat(64),
        },
        reason: "workspaceFingerprintChanged",
      },
      {
        snapshot: {
          ...baseline(),
          head: { ...HEAD, oid: "2".repeat(40) },
        },
        reason: "headChanged",
      },
      {
        snapshot: {
          ...baseline(),
          repositoryControlSha256: "d".repeat(64),
        },
        reason: "repositoryControlChanged",
      },
    ] as const;
    for (const candidate of cases) {
      const sentinel = watcher();
      const monitor = startArenaMainWorkspaceMonitor(
        "C:\\workspace",
        baseline(),
        async () => candidate.snapshot,
        { watch: () => sentinel, randomId: () => candidate.reason },
      );
      const observed = await monitor.observe("monitorStarted");
      assert.equal(observed.status, "changed");
      assert.equal(observed.reasonCode, candidate.reason);
    }

    const failed = watcher();
    failed.setError("raw watcher detail");
    const monitor = startArenaMainWorkspaceMonitor(
      "C:\\workspace",
      baseline(),
      async () => baseline(),
      { watch: () => failed, randomId: () => "failed" },
    );
    const observed = await monitor.observe("monitorStarted");
    assert.equal(observed.status, "unverifiable");
    assert.equal(observed.reasonCode, "monitorFailed");
    assert.doesNotMatch(JSON.stringify(observed), /raw watcher detail/u);
  });

  test("requires one initial monitorStarted and refuses use after close", async () => {
    const sentinel = watcher();
    const monitor = startArenaMainWorkspaceMonitor(
      "C:\\workspace",
      baseline(),
      async () => baseline(),
      { watch: () => sentinel, randomId: () => "epoch" },
    );
    await assert.rejects(
      monitor.observe("checkpoint"),
      /must begin/,
    );

    const second = startArenaMainWorkspaceMonitor(
      "C:\\workspace",
      baseline(),
      async () => baseline(),
      { watch: () => watcher(), randomId: () => "epoch-2" },
    );
    await second.observe("monitorStarted");
    await assert.rejects(second.observe("monitorStarted"), /only once/);
    second.close();
    await assert.rejects(second.observe("checkpoint"), /closed/);
  });
});
