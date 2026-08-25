import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants as fsConstants, type PathLike } from "node:fs";
import * as fs from "node:fs/promises";
import fsPromises = require("node:fs/promises");
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
  FileArenaRepositoryRunLeaseStore,
  prepareArenaRepositoryLeaseRoot,
  type ArenaRepositoryRunClaimInput,
} from "../src/arenaRepositoryLease";
import {
  classifyArenaRecovery,
  requireArenaRecoveryAction,
} from "../src/arenaRecovery";
import { arenaProductReplayFixture } from "./arenaProductFixture";

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

function restartProof() {
  const recovery = classifyArenaRecovery({
    replay: arenaProductReplayFixture("comparable", "running"),
    generations: [],
    interruptedPromotionIds: [],
  });
  return requireArenaRecoveryAction(
    recovery,
    recovery.recoveryStateSha256,
    "resume",
  );
}

function mockLeaseRootSyncFailures(
  t: TestContext,
  leaseRoot: string,
  failures: number,
  code = "EIO",
): { readonly attempts: () => number } {
  const originalOpen = fsPromises.open.bind(fsPromises) as unknown as (
    filePath: PathLike,
    flags: string | number,
    mode?: number,
  ) => Promise<fs.FileHandle>;
  let remainingFailures = failures;
  let attempts = 0;
  t.mock.method(
    fsPromises,
    "open",
    (async (filePath: PathLike, flags: string | number, mode?: number) => {
      if (path.resolve(String(filePath)) === path.resolve(leaseRoot)
        && flags === fsConstants.O_RDONLY) {
        attempts += 1;
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw Object.assign(new Error("injected owner-ledger directory flush failure"), {
            code,
          });
        }
      }
      return originalOpen(filePath, flags, mode);
    }) as typeof fsPromises.open,
  );
  return { attempts: () => attempts };
}

describe("Arena repository owner ledger", () => {
  test("claim retry revalidates and re-syncs a row published before directory-sync failure", async (t) => {
    const { root, store } = await fixture(t);
    const claimInput = input("run-create-directory-sync");
    const leaseRoot = path.join(root, "leases");
    const sync = mockLeaseRootSyncFailures(t, leaseRoot, 1);

    await assert.rejects(
      store.claim(claimInput),
      /injected owner-ledger directory flush failure/,
    );
    const ledger = path.join(
      leaseRoot,
      `${claimInput.repositoryIdentitySha256}.owner.v1.jsonl`,
    );
    const body = await fs.readFile(ledger, "utf8");
    assert.equal(body.endsWith("\n"), true);
    const published = JSON.parse(body) as {
      readonly type: string;
      readonly payload: { readonly ownerId: string };
    };
    assert.equal(published.type, "claimAcquired");

    const recovered = await store.claim(claimInput);
    assert.equal(recovered.ownerId, published.payload.ownerId);
    assert.equal(sync.attempts(), 2);
    const rows = (await fs.readFile(ledger, "utf8")).trimEnd().split("\n");
    assert.equal(rows.length, 1);
    await recovered.runExclusive(async () => undefined);
    await recovered.releaseWithProof(async () => digest("complete"));
  });

  test("release retry revalidates and re-syncs a row published before directory-sync failure", async (t) => {
    const { root, store } = await fixture(t);
    const claimInput = input("run-replace-directory-sync");
    const claim = await store.claim(claimInput);
    const leaseRoot = path.join(root, "leases");
    const sync = mockLeaseRootSyncFailures(t, leaseRoot, 2);
    let receiptCalls = 0;

    await assert.rejects(
      claim.releaseWithProof(async () => {
        receiptCalls += 1;
        return digest("complete");
      }),
      /injected owner-ledger directory flush failure/,
    );
    const ledger = path.join(
      leaseRoot,
      `${claimInput.repositoryIdentitySha256}.owner.v1.jsonl`,
    );
    const rows = (await fs.readFile(ledger, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly type: string });
    assert.deepEqual(rows.map((row) => row.type), [
      "claimAcquired",
      "claimReleased",
    ]);

    await assert.rejects(
      claim.releaseWithProof(async () => {
        throw new Error("the published release must be reused on retry");
      }),
      /injected owner-ledger directory flush failure/,
    );
    await claim.releaseWithProof(async () => {
      throw new Error("the published release must be reused on retry");
    });
    assert.equal(receiptCalls, 1);
    assert.equal(sync.attempts(), 3);
  });

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

  test("allows promotion-exclusive work only while the repository is unowned", async (t) => {
    const { store } = await fixture(t);
    const claimInput = input("run-exclusive");
    const claim = await store.claim(claimInput);
    await assert.rejects(
      store.withUnownedRepository(
        claimInput.repositoryIdentitySha256,
        async () => undefined,
      ),
      /remains owned by unreleased run/,
    );
    await claim.releaseWithProof(async () => digest("complete"));
    let called = 0;
    await store.withUnownedRepository(
      claimInput.repositoryIdentitySha256,
      async () => {
        called += 1;
      },
    );
    assert.equal(called, 1);
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

  test("recovers only from a definitely dead owner with an exact typed proof", async (t) => {
    const { root, store } = await fixture(t);
    const proof = restartProof();
    const claimInput = input("run-one", {
      manifestLockEventSha256: proof.manifestLockEventSha256,
    });
    const first = await store.claim(claimInput);
    first.abandon();
    const recoveredInput = {
      ...claimInput,
      recoveryProofSha256: proof.recoveryProofSha256,
    };

    await assert.rejects(
      store.recover(recoveredInput, proof),
      /owner process is not definitely gone/,
    );

    const recoveryStore = new FileArenaRepositoryRunLeaseStore(
      await prepareArenaRepositoryLeaseRoot(path.join(root, "leases")),
      { isProcessDefinitelyGone: async () => true },
    );
    const recovered = await recoveryStore.recover(recoveredInput, proof);
    const rows = (await fs.readFile(path.join(
      root,
      "leases",
      `${claimInput.repositoryIdentitySha256}.owner.v1.jsonl`,
    ), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as {
      readonly type: string;
      readonly payload: { readonly priorClaimSha256: string | null };
      readonly previousEventSha256: string;
    });
    assert.deepEqual(rows.map((row) => row.type), [
      "claimAcquired",
      "claimRecovered",
    ]);
    assert.equal(rows[1]?.payload.priorClaimSha256, first.claimSha256);
    assert.equal(rows[1]?.previousEventSha256, first.claimSha256);
    await assert.rejects(
      first.runExclusive(async () => undefined),
      /no longer active|changed ownership/,
    );
    await recovered.releaseWithProof(async () => digest("complete"));
  });

  test("rejects forged, stale, or differently bound recovery proofs", async (t) => {
    const { root, store } = await fixture(t);
    const proof = restartProof();
    const claimInput = input("run-one", {
      manifestLockEventSha256: proof.manifestLockEventSha256,
    });
    const first = await store.claim(claimInput);
    first.abandon();
    const recoveryStore = new FileArenaRepositoryRunLeaseStore(
      await prepareArenaRepositoryLeaseRoot(path.join(root, "leases")),
      { isProcessDefinitelyGone: async () => true },
    );

    await assert.rejects(
      recoveryStore.recover({
        ...claimInput,
        recoveryProofSha256: digest("forged"),
      }, proof),
      /does not match the typed recovery proof/,
    );
    await assert.rejects(
      recoveryStore.recover({
        ...claimInput,
        recoveryProofSha256: proof.recoveryProofSha256,
      }, {
        ...proof,
        manifestLockEventSha256: digest("other-lock"),
      }),
      /recovery proof hash is invalid/,
    );
    await assert.rejects(
      recoveryStore.recover({
        ...claimInput,
        manifestLockEventSha256: digest("other-lock"),
        recoveryProofSha256: proof.recoveryProofSha256,
      }, proof),
      /does not bind the requested repository claim/,
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
