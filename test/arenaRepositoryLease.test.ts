import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
  FileArenaRepositoryRunLeaseStore,
  prepareArenaRepositoryLeaseRoot,
  type ArenaRepositoryRunClaimInput,
} from "../src/arenaRepositoryLease";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function input(
  runId: string,
  overrides: Partial<ArenaRepositoryRunClaimInput> = {},
): ArenaRepositoryRunClaimInput {
  return {
    runId,
    repositoryIdentitySha256: digest("repository"),
    sourceDirectoryIdentitySha256: digest("source"),
    privateStorageIdentitySha256: digest("private"),
    repositoryControlSha256: digest("controls"),
    baseRevisionSha256: digest("base"),
    manifestLockEventSha256: digest(`manifest:${runId}`),
    recoveryProofSha256: null,
    ...overrides,
  };
}

async function fixture(t: TestContext): Promise<{
  readonly root: string;
  readonly store: FileArenaRepositoryRunLeaseStore;
}> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "hydra-arena-owner-ledger-"),
  );
  t.after(async () => {
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  return {
    root,
    store: new FileArenaRepositoryRunLeaseStore(
      await prepareArenaRepositoryLeaseRoot(path.join(root, "leases")),
    ),
  };
}

describe("Arena repository owner ledger", () => {
  test("serializes different runs and never steals an unreleased owner", async (t) => {
    const { root, store } = await fixture(t);
    const secondStore = new FileArenaRepositoryRunLeaseStore(
      await prepareArenaRepositoryLeaseRoot(path.join(root, "leases")),
    );
    const firstInput = input("run-one");
    const secondInput = input("run-two", {
      manifestLockEventSha256: digest("manifest:run-two"),
    });
    const raced = await Promise.allSettled([
      store.claim(firstInput),
      secondStore.claim(secondInput),
    ]);
    assert.equal(
      raced.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      raced.filter((result) => result.status === "rejected").length,
      1,
    );
    const winner = raced.find((result) =>
      result.status === "fulfilled");
    assert.ok(winner && winner.status === "fulfilled");
    await winner.value.releaseWithProof(async () => digest("complete"));
  });

  test("refuses restart takeover without a typed quiescence proof", async (t) => {
    const { store } = await fixture(t);
    const claimInput = input("run-restart");
    const first = await store.claim(claimInput);
    first.abandon();
    await assert.rejects(
      store.claim(claimInput),
      /restart takeover is disabled/,
    );
    await assert.rejects(
      store.claim({
        ...claimInput,
        recoveryProofSha256: digest("forged-quiescence"),
      }),
      /restart takeover is disabled/,
    );
  });

  test("releases idempotently and permanently rejects run-ID reuse", async (t) => {
    const { store } = await fixture(t);
    const claimInput = input("run-release");
    const claim = await store.claim(claimInput);
    const completion = digest("completion");
    await claim.releaseWithProof(async () => completion);
    await claim.releaseWithProof(async () => {
      throw new Error("idempotent release must not recompute proof");
    });
    assert.equal(
      await store.releasedCompletion(claimInput),
      completion,
    );
    await assert.rejects(
      store.claim(claimInput),
      /already released and cannot be reused/,
    );
  });

  test("rejects a changed binding and a replaced lease root", async (t) => {
    const { root, store } = await fixture(t);
    const claimInput = input("run-binding");
    const claim = await store.claim(claimInput);
    claim.abandon();
    await assert.rejects(
      store.claim({
        ...claimInput,
        privateStorageIdentitySha256: digest("other-private"),
      }),
      /remains owned by unreleased run/,
    );

    const leaseRoot = path.join(root, "leases");
    const moved = path.join(root, "leases-moved");
    await fs.rename(leaseRoot, moved);
    await fs.mkdir(leaseRoot);
    await assert.rejects(
      store.releasedCompletion(claimInput),
      /changed identity/,
    );
  });

  test("fails closed when the owner ledger gains another hard link", async (t) => {
    const { root, store } = await fixture(t);
    const claimInput = input("run-hardlink");
    const claim = await store.claim(claimInput);
    claim.abandon();
    const ledger = path.join(
      root,
      "leases",
      `${claimInput.repositoryIdentitySha256}.owner.v1.jsonl`,
    );
    try {
      await fs.link(ledger, path.join(root, "ledger-copy.jsonl"));
    } catch (error) {
      t.skip(`hard-link creation unavailable: ${String(error)}`);
      return;
    }
    await assert.rejects(
      store.releasedCompletion(claimInput),
      /unlinked regular file/,
    );
  });

  test("fails closed on a torn final owner-ledger row", async (t) => {
    const { root, store } = await fixture(t);
    const claimInput = input("run-torn-owner-row");
    const claim = await store.claim(claimInput);
    claim.abandon();
    const ledger = path.join(
      root,
      "leases",
      `${claimInput.repositoryIdentitySha256}.owner.v1.jsonl`,
    );
    await fs.appendFile(ledger, '{"schemaVersion":1', "utf8");
    await assert.rejects(
      store.releasedCompletion(claimInput),
      /torn final record/,
    );
  });
});
