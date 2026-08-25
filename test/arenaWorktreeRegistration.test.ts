import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
  ARENA_WORKTREE_REGISTRATION_MAX_BYTES,
  ARENA_WORKTREE_REGISTRATION_MAX_CONTESTANTS,
  ARENA_WORKTREE_REGISTRATION_SCHEMA_VERSION,
  ArenaWorktreeRegistrationError,
  FileArenaWorktreeRegistrationStore,
  arenaWorktreeRegistrationPaths,
  createArenaWorktreeRegistrationReceipt,
  type ArenaWorktreeRegistrationIntent,
  type ArenaWorktreeRegistrationIntentDraft,
  type ArenaWorktreeRegistrationReceiptDraft,
} from "../src/arenaWorktreeRegistration";
import {
  canonicalArenaManifestJson,
} from "../src/arenaRunManifest";
import {
  arenaContestantWorktreePath,
} from "../src/arenaStore";

const RUN_ID = "arena-registration-run";
const CONTESTANT_ID = "contestant-codex";
const TIME = "2026-07-25T14:00:00.000Z";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function tempRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "hydra-arena-registration-"),
  );
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function intentDraft(
  root: string,
  contestantId = CONTESTANT_ID,
  overrides: Partial<ArenaWorktreeRegistrationIntentDraft> = {},
): ArenaWorktreeRegistrationIntentDraft {
  return {
    intentId: `intent-${contestantId}`,
    runId: RUN_ID,
    contestantId,
    worktreeId: `worktree-${contestantId}`,
    occurredAt: TIME,
    sourceDirectoryIdentitySha256: digest("source-directory"),
    repositoryIdentitySha256: digest("repository"),
    repositoryControlSha256: digest("repository-control"),
    repositoryStaticControlSha256: digest("repository-static-control"),
    worktreeRegistrySha256: digest("worktree-registry"),
    baseRevision: {
      objectFormat: "sha1",
      oid: "a".repeat(40),
    },
    baseContentSha256: digest("base-content"),
    worktreePath: arenaContestantWorktreePath(
      root,
      RUN_ID,
      contestantId,
    ),
    lockReason: `Hydra Arena ${RUN_ID}/${contestantId}`,
    ...overrides,
  };
}

function receiptDraft(
  intent: ArenaWorktreeRegistrationIntent,
  overrides: Partial<ArenaWorktreeRegistrationReceiptDraft> = {},
): ArenaWorktreeRegistrationReceiptDraft {
  return {
    intentSha256: intent.intentSha256,
    runId: intent.runId,
    contestantId: intent.contestantId,
    worktreeId: intent.worktreeId,
    registeredAt: "2026-07-25T14:01:00.000Z",
    realWorktreePathSha256: digest("real-worktree-path"),
    directoryIdentitySha256: digest("directory-identity"),
    gitRegistrationSha256: digest("git-registration"),
    head: intent.baseRevision,
    initialFingerprintSha256: intent.baseContentSha256,
    ...overrides,
  };
}

function hasRegistrationCode(
  code: ArenaWorktreeRegistrationError["code"],
  pattern?: RegExp,
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof ArenaWorktreeRegistrationError
    && error.code === code
    && (pattern === undefined || pattern.test(error.message));
}

describe("Arena worktree registration store", () => {
  test("round-trips exact intent and receipt records with idempotent retries", async (t) => {
    const root = await tempRoot(t);
    const store = new FileArenaWorktreeRegistrationStore(root);
    const draft = intentDraft(root);

    const intent = await store.plan(draft);
    assert.equal(
      intent.schemaVersion,
      ARENA_WORKTREE_REGISTRATION_SCHEMA_VERSION,
    );
    assert.equal(intent.recordType, "worktreeRegistrationIntent");
    assert.match(intent.intentSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await store.plan(structuredClone(draft)), intent);
    assert.deepEqual(await store.load(RUN_ID, CONTESTANT_ID), { intent });

    const receiptInput = receiptDraft(intent);
    const receipt = await store.recordReceipt(receiptInput);
    assert.equal(receipt.recordType, "worktreeRegistrationReceipt");
    assert.match(receipt.registrationSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      await store.recordReceipt(structuredClone(receiptInput)),
      receipt,
    );
    assert.deepEqual(
      await store.load(RUN_ID, CONTESTANT_ID),
      { intent, receipt },
    );

    const paths = arenaWorktreeRegistrationPaths(
      root,
      RUN_ID,
      CONTESTANT_ID,
    );
    assert.equal(
      await fs.readFile(paths.intentPath, "utf8"),
      `${canonicalArenaManifestJson(intent)}\n`,
    );
    assert.equal(
      await fs.readFile(paths.receiptPath, "utf8"),
      `${canonicalArenaManifestJson(receipt)}\n`,
    );
  });

  test("derives private paths and rejects traversal identifiers", async (t) => {
    const root = await tempRoot(t);
    const paths = arenaWorktreeRegistrationPaths(
      root,
      RUN_ID,
      CONTESTANT_ID,
    );
    assert.equal(
      paths.registrationPath,
      path.join(
        path.resolve(root),
        "arena",
        "registrations",
        RUN_ID,
        CONTESTANT_ID,
      ),
    );
    assert.equal(paths.intentPath, path.join(paths.registrationPath, "intent.v1.json"));
    assert.equal(
      paths.receiptPath,
      path.join(paths.registrationPath, "receipt.v1.json"),
    );
    assert.throws(
      () => arenaWorktreeRegistrationPaths(root, "../escape", CONTESTANT_ID),
      /not safe|invalid/i,
    );
    assert.throws(
      () => arenaWorktreeRegistrationPaths(root, RUN_ID, ".."),
      /not safe|invalid/i,
    );
  });

  test("rejects a hash-valid intent copied from another private root", async (t) => {
    const firstRoot = await tempRoot(t);
    const secondRoot = await tempRoot(t);
    const first = new FileArenaWorktreeRegistrationStore(firstRoot);
    const second = new FileArenaWorktreeRegistrationStore(secondRoot);
    await first.plan(intentDraft(firstRoot));
    const source = arenaWorktreeRegistrationPaths(
      firstRoot,
      RUN_ID,
      CONTESTANT_ID,
    );
    const destination = arenaWorktreeRegistrationPaths(
      secondRoot,
      RUN_ID,
      CONTESTANT_ID,
    );
    await fs.mkdir(destination.registrationPath, {
      recursive: true,
      mode: 0o700,
    });
    await fs.copyFile(source.intentPath, destination.intentPath);
    await fs.chmod(destination.intentPath, 0o600);
    await assert.rejects(
      second.load(RUN_ID, CONTESTANT_ID),
      /does not use the derived worktree path/,
    );
  });

  test("rejects intent and receipt collisions instead of overwriting records", async (t) => {
    const root = await tempRoot(t);
    const store = new FileArenaWorktreeRegistrationStore(root);
    const intent = await store.plan(intentDraft(root));

    await assert.rejects(
      store.plan(intentDraft(root, CONTESTANT_ID, {
        occurredAt: "2026-07-25T14:00:01.000Z",
      })),
      hasRegistrationCode("collision", /intent collided/i),
    );

    const receipt = receiptDraft(intent);
    await store.recordReceipt(receipt);
    await assert.rejects(
      store.recordReceipt({
        ...receipt,
        registeredAt: "2026-07-25T14:01:01.000Z",
      }),
      hasRegistrationCode("collision", /receipt collided/i),
    );
  });

  test("rejects a receipt without its durable intent", async (t) => {
    const root = await tempRoot(t);
    const store = new FileArenaWorktreeRegistrationStore(root);
    const syntheticIntent = {
      ...intentDraft(root),
      schemaVersion: ARENA_WORKTREE_REGISTRATION_SCHEMA_VERSION,
      recordType: "worktreeRegistrationIntent" as const,
      intentSha256: digest("missing-intent"),
    };
    await assert.rejects(
      store.recordReceipt(receiptDraft(syntheticIntent)),
      hasRegistrationCode("missingIntent", /without its durable intent/i),
    );
  });

  test("rejects receipts that do not match the durable intent", async (t) => {
    const root = await tempRoot(t);
    const store = new FileArenaWorktreeRegistrationStore(root);
    const intent = await store.plan(intentDraft(root));
    const base = receiptDraft(intent);
    const mismatches: readonly Partial<ArenaWorktreeRegistrationReceiptDraft>[] = [
      { intentSha256: digest("other-intent") },
      { worktreeId: "worktree-other" },
      {
        head: {
          objectFormat: "sha1",
          oid: "b".repeat(40),
        },
      },
      { initialFingerprintSha256: digest("other-base-content") },
    ];
    for (const mismatch of mismatches) {
      await assert.rejects(
        store.recordReceipt({ ...base, ...mismatch }),
        hasRegistrationCode("mismatch", /does not match/i),
      );
    }
  });

  test("fails closed on torn, multiline, malformed UTF-8, and non-canonical intents", async (t) => {
    const root = await tempRoot(t);
    const store = new FileArenaWorktreeRegistrationStore(root);
    const intent = await store.plan(intentDraft(root));
    const intentPath = arenaWorktreeRegistrationPaths(
      root,
      RUN_ID,
      CONTESTANT_ID,
    ).intentPath;
    const canonical = `${canonicalArenaManifestJson(intent)}\n`;

    await fs.writeFile(intentPath, canonical.slice(0, -1), "utf8");
    await assert.rejects(
      store.load(RUN_ID, CONTESTANT_ID),
      hasRegistrationCode("invalid", /torn or multiline/i),
    );

    await fs.writeFile(intentPath, `${canonical}{}`, "utf8");
    await assert.rejects(
      store.load(RUN_ID, CONTESTANT_ID),
      hasRegistrationCode("invalid", /torn or multiline/i),
    );

    await fs.writeFile(intentPath, Buffer.from([0xff, 0x0a]));
    await assert.rejects(
      store.load(RUN_ID, CONTESTANT_ID),
      hasRegistrationCode("invalid", /not valid UTF-8/i),
    );

    await fs.writeFile(intentPath, ` ${canonical}`, "utf8");
    await assert.rejects(
      store.load(RUN_ID, CONTESTANT_ID),
      hasRegistrationCode("invalid", /not canonical/i),
    );
  });

  test("rejects forged hashes, extra fields, and oversized registration files", async (t) => {
    const root = await tempRoot(t);
    const store = new FileArenaWorktreeRegistrationStore(root);
    const intent = await store.plan(intentDraft(root));
    const intentPath = arenaWorktreeRegistrationPaths(
      root,
      RUN_ID,
      CONTESTANT_ID,
    ).intentPath;

    const forged = {
      ...structuredClone(intent),
      intentSha256: digest("forged-intent"),
    };
    await fs.writeFile(
      intentPath,
      `${canonicalArenaManifestJson(forged)}\n`,
      "utf8",
    );
    await assert.rejects(
      store.load(RUN_ID, CONTESTANT_ID),
      hasRegistrationCode("invalid", /hash does not match/i),
    );

    const withExtraField = {
      ...structuredClone(intent),
      forgedAuthority: true,
    };
    await fs.writeFile(
      intentPath,
      `${canonicalArenaManifestJson(withExtraField)}\n`,
      "utf8",
    );
    await assert.rejects(
      store.load(RUN_ID, CONTESTANT_ID),
      hasRegistrationCode("invalid", /unknown or missing fields/i),
    );

    await fs.writeFile(
      intentPath,
      Buffer.alloc(ARENA_WORKTREE_REGISTRATION_MAX_BYTES + 1, 0x61),
    );
    await assert.rejects(
      store.load(RUN_ID, CONTESTANT_ID),
      /exceeds its read limit/i,
    );
  });

  test("rejects a hash-valid persisted receipt that mismatches its intent", async (t) => {
    const root = await tempRoot(t);
    const store = new FileArenaWorktreeRegistrationStore(root);
    const intent = await store.plan(intentDraft(root));
    const receiptPath = arenaWorktreeRegistrationPaths(
      root,
      RUN_ID,
      CONTESTANT_ID,
    ).receiptPath;
    const mismatched = createArenaWorktreeRegistrationReceipt({
      ...receiptDraft(intent),
      intentSha256: digest("different-valid-intent"),
    });
    await fs.writeFile(
      receiptPath,
      `${canonicalArenaManifestJson(mismatched)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await assert.rejects(
      store.load(RUN_ID, CONTESTANT_ID),
      hasRegistrationCode("mismatch", /does not match/i),
    );
  });

  test("serializes concurrent stores and lists contestants in canonical order", async (t) => {
    const root = await tempRoot(t);
    const left = new FileArenaWorktreeRegistrationStore(root);
    const right = new FileArenaWorktreeRegistrationStore(root);
    const sharedDraft = intentDraft(root);
    const [leftIntent, rightIntent] = await Promise.all([
      left.plan(sharedDraft),
      right.plan(structuredClone(sharedDraft)),
    ]);
    assert.deepEqual(rightIntent, leftIntent);

    const sharedReceipt = receiptDraft(leftIntent);
    const [leftReceipt, rightReceipt] = await Promise.all([
      left.recordReceipt(sharedReceipt),
      right.recordReceipt(structuredClone(sharedReceipt)),
    ]);
    assert.deepEqual(rightReceipt, leftReceipt);

    for (const contestantId of ["contestant-zulu", "contestant-alpha"]) {
      await right.plan(intentDraft(root, contestantId));
    }
    const states = await left.listRun(RUN_ID);
    assert.deepEqual(
      states.map((state) => state.intent.contestantId),
      ["contestant-alpha", CONTESTANT_ID, "contestant-zulu"],
    );
    assert.equal(states[1]?.receipt?.registrationSha256, leftReceipt.registrationSha256);
  });

  test("fails closed when a run exceeds the contestant listing bound", async (t) => {
    const root = await tempRoot(t);
    const store = new FileArenaWorktreeRegistrationStore(root);
    const results = await Promise.allSettled(Array.from(
        { length: ARENA_WORKTREE_REGISTRATION_MAX_CONTESTANTS + 1 },
        (_, index) => store.plan(intentDraft(root, `contestant-${index}`)),
      ));
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.equal(
      hasRegistrationCode("capacity", /contestant limit/i)(rejected.reason),
      true,
    );
    assert.equal(
      (await store.listRun(RUN_ID)).length,
      ARENA_WORKTREE_REGISTRATION_MAX_CONTESTANTS,
    );
  });

  test("refuses a symbolic-linked intent file when the platform permits it", async (t) => {
    const root = await tempRoot(t);
    const store = new FileArenaWorktreeRegistrationStore(root);
    await store.plan(intentDraft(root));
    const intentPath = arenaWorktreeRegistrationPaths(
      root,
      RUN_ID,
      CONTESTANT_ID,
    ).intentPath;
    const outsidePath = path.join(root, "outside-intent.json");
    await fs.writeFile(outsidePath, await fs.readFile(intentPath));
    await fs.rm(intentPath);
    try {
      await fs.symlink(outsidePath, intentPath, "file");
    } catch (error) {
      t.skip(`symbolic-link creation unavailable: ${String(error)}`);
      return;
    }
    await assert.rejects(
      store.load(RUN_ID, CONTESTANT_ID),
      /linked|symbolic|invalid/i,
    );
  });

  test("refuses a hard-linked intent file when the platform permits it", async (t) => {
    const root = await tempRoot(t);
    const store = new FileArenaWorktreeRegistrationStore(root);
    await store.plan(intentDraft(root));
    const intentPath = arenaWorktreeRegistrationPaths(
      root,
      RUN_ID,
      CONTESTANT_ID,
    ).intentPath;
    const outsidePath = path.join(root, "outside-intent.json");
    await fs.writeFile(outsidePath, await fs.readFile(intentPath));
    await fs.rm(intentPath);
    try {
      await fs.link(outsidePath, intentPath);
    } catch (error) {
      t.skip(`hard-link creation unavailable: ${String(error)}`);
      return;
    }
    await assert.rejects(
      store.load(RUN_ID, CONTESTANT_ID),
      /hard|linked|invalid/i,
    );
  });
});
