import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, type TestContext } from "node:test";
import { preserveArenaEvidence } from "../src/arenaEvidence";
import {
  loadArenaPromotionCandidate,
  renderArenaPromotionCandidateMarkdown,
} from "../src/arenaPromotionCandidate";
import type { ArenaPromotionPreview } from "../src/arenaPromotion";
import {
  ensureArenaPrivateDirectory,
  prepareArenaPrivateStorage,
} from "../src/arenaPrivateStorage";
import { arenaContestantArtifactPath } from "../src/arenaStore";
import type { ArenaStagedEvidenceFile } from "../src/arenaGit";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-promotion-candidate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const privateRoot = path.join(root, "private");
  const worktree = path.join(root, "worktree");
  await fs.mkdir(worktree, { recursive: true });
  const boundary = await prepareArenaPrivateStorage(privateRoot);
  const artifactDirectory = await ensureArenaPrivateDirectory(boundary, [
    "artifacts",
    "run-one",
    "codex",
  ]);
  const stage = async (name: string, bytes: Buffer): Promise<ArenaStagedEvidenceFile> => {
    const file = path.join(
      artifactDirectory,
      `.${name}.${process.pid}-${randomUUID()}-${randomUUID()}.tmp`,
    );
    const handle = await fs.open(file, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return Object.freeze({
      path: file,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  };
  return { privateRoot, worktree, artifactDirectory, stage };
}

async function preserve(
  value: Awaited<ReturnType<typeof fixture>>,
  gitPath: string,
  content: Buffer,
) {
  const target = path.join(value.worktree, ...gitPath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, { mode: 0o640 });
  return preserveArenaEvidence({
    privateWorkspaceRoot: value.privateRoot,
    runId: "run-one",
    contestantId: "codex",
    worktreePath: value.worktree,
    patch: await value.stage("patch.bin", Buffer.from("retained patch\n", "utf8")),
    untrackedPaths: await value.stage(
      "untracked-paths.v1.bin",
      Buffer.from(`${gitPath}\0`, "utf8"),
    ),
    receiptsRootSha256: "a".repeat(64),
    quiescenceReceiptSha256: "b".repeat(64),
    quiescenceWorkspaceFingerprintSha256: "c".repeat(64),
    finalHead: { objectFormat: "sha1", oid: "1".repeat(40) },
    finalWorkspaceFingerprintSha256: "c".repeat(64),
    confirmSnapshotBeforePublication: async () => {},
    confirmSnapshotAfterPublication: async () => {},
  });
}

describe("Arena promotion candidate loading", () => {
  test("returns only inventory-bound copies of retained patch and untracked bytes", async (t) => {
    const value = await fixture(t);
    const content = Buffer.from("new file\n", "utf8");
    const retained = await preserve(value, "nested/new.txt", content);

    const candidate = await loadArenaPromotionCandidate({
      privateWorkspaceRoot: value.privateRoot,
      runId: "run-one",
      contestantId: "codex",
      payload: retained.payload,
    });

    assert.equal(candidate.patch.toString("utf8"), "retained patch\n");
    assert.equal(candidate.artifactSetSha256, retained.payload.artifactSetSha256);
    assert.equal(candidate.untrackedEntries.length, 1);
    assert.equal(candidate.untrackedEntries[0]?.path, "nested/new.txt");
    assert.deepEqual(candidate.untrackedEntries[0]?.content, content);
    const markdown = renderArenaPromotionCandidateMarkdown({
      preview: {
        patchSha256: candidate.patchSha256,
        patchBytes: candidate.patch.byteLength,
        artifactSetSha256: candidate.artifactSetSha256,
        untrackedArchiveSha256: retained.payload.untrackedArchiveSha256,
        untrackedArchiveBytes: retained.payload.untrackedArchiveBytes,
        contestantId: "codex",
        missionDecision: "retireAfterVerifiedPromotion",
      } as ArenaPromotionPreview,
      candidate,
      targetWorkspace: value.worktree,
      targetHead: "1".repeat(40),
    });
    assert.match(markdown, /retained patch/u);
    assert.match(markdown, /nested\/new\.txt/u);
    assert.match(markdown, /requested postcondition/u);
    assert.match(markdown, /does not retire Mission authority/u);
  });

  test("rejects Git-control paths even when they were retained as evidence", async (t) => {
    const value = await fixture(t);
    const retained = await preserve(
      value,
      ".git/config",
      Buffer.from("untrusted", "utf8"),
    );
    await assert.rejects(
      loadArenaPromotionCandidate({
        privateWorkspaceRoot: value.privateRoot,
        runId: "run-one",
        contestantId: "codex",
        payload: retained.payload,
      }),
      /promotion path is unsafe/,
    );
  });

  test("does not return bytes after retained evidence is modified", async (t) => {
    const value = await fixture(t);
    const retained = await preserve(value, "new.txt", Buffer.from("safe", "utf8"));
    await fs.writeFile(
      path.join(arenaContestantArtifactPath(
        value.privateRoot,
        "run-one",
        "codex",
      ), "patch.bin"),
      "changed",
      "utf8",
    );
    await assert.rejects(
      loadArenaPromotionCandidate({
        privateWorkspaceRoot: value.privateRoot,
        runId: "run-one",
        contestantId: "codex",
        payload: retained.payload,
      }),
      /patch|retained/i,
    );
  });
});
