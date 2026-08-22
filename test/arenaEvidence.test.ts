import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, type TestContext } from "node:test";
import { preserveArenaEvidence } from "../src/arenaEvidence";
import { readArenaPrivateFile, prepareArenaPrivateStorage } from "../src/arenaPrivateStorage";

const SHA = "a".repeat(64);

async function fixture(t: TestContext): Promise<{
  privateRoot: string;
  worktree: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-evidence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const privateRoot = path.join(root, "private");
  const worktree = path.join(root, "worktree");
  await fs.mkdir(worktree, { recursive: true });
  return { privateRoot, worktree };
}

function input(
  value: Awaited<ReturnType<typeof fixture>>,
  untrackedPathsZ = Buffer.alloc(0),
) {
  return {
    privateWorkspaceRoot: value.privateRoot,
    runId: "run-one",
    contestantId: "codex",
    worktreePath: value.worktree,
    patch: Buffer.from("binary patch\n", "utf8"),
    untrackedPathsZ,
    receiptsRootSha256: SHA,
    quiescenceReceiptSha256: "b".repeat(64),
    quiescenceWorkspaceFingerprintSha256: "c".repeat(64),
    finalHead: {
      objectFormat: "sha1" as const,
      oid: "1".repeat(40),
    },
    finalWorkspaceFingerprintSha256: "c".repeat(64),
  };
}

describe("Arena evidence preservation", () => {
  test("publishes binary patch, deterministic untracked archive, inventory, and receipt", async (t) => {
    const value = await fixture(t);
    await fs.mkdir(path.join(value.worktree, "nested"));
    await fs.writeFile(path.join(value.worktree, "nested", "new.bin"), Buffer.from([0, 1, 2]));
    const result = await preserveArenaEvidence(input(
      value,
      Buffer.from("nested/new.bin\0", "utf8"),
    ));
    assert.match(result.payload.artifactSetSha256, /^[a-f0-9]{64}$/u);
    assert.equal(result.payload.untrackedArchiveBytes > 0, true);
    const boundary = await prepareArenaPrivateStorage(value.privateRoot);
    const receipt = await readArenaPrivateFile(
      path.join(result.artifactDirectory, "artifact-set.v1.json"),
      64 * 1024,
      boundary,
    );
    assert.match(receipt.toString("utf8"), /arenaArtifactSet/u);

    const retry = await preserveArenaEvidence(input(
      value,
      Buffer.from("nested/new.bin\0", "utf8"),
    ));
    assert.deepEqual(retry.payload, result.payload);
  });

  test("requires the quiescence fingerprint to equal the final capture", async (t) => {
    const value = await fixture(t);
    await assert.rejects(
      preserveArenaEvidence({
        ...input(value),
        finalWorkspaceFingerprintSha256: "d".repeat(64),
      }),
      /quiescence and final fingerprints/,
    );
  });

  test("rejects traversal, malformed framing, symlinks, and hard links", async (t) => {
    const value = await fixture(t);
    await assert.rejects(
      preserveArenaEvidence(input(value, Buffer.from("../escape\0"))),
      /unsafe/,
    );
    await assert.rejects(
      preserveArenaEvidence(input(value, Buffer.from("unterminated"))),
      /not NUL terminated/,
    );

    const source = path.join(value.worktree, "source.txt");
    await fs.writeFile(source, "secret");
    const linked = path.join(value.worktree, "linked.txt");
    try {
      await fs.symlink(source, linked);
      await assert.rejects(
        preserveArenaEvidence(input(value, Buffer.from("linked.txt\0"))),
        /linked or not a regular/,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }

    const hard = path.join(value.worktree, "hard.txt");
    await fs.link(source, hard);
    await assert.rejects(
      preserveArenaEvidence(input(value, Buffer.from("hard.txt\0"))),
      /linked or not a regular/,
    );
  });
});
