import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, test, type TestContext } from "node:test";
import {
  captureDuelWorkspaceFingerprint,
  DuelWorkspaceIntegrityError,
  watchDuelWorkspaceMutations,
} from "../src/duelWorkspaceGuard";
import { resolveGitExecutable } from "../src/gitExecutable";

const execFileAsync = promisify(execFile);

interface TestRepository {
  root: string;
  git: string;
}

async function createRepository(t: TestContext): Promise<TestRepository> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-duel-workspace-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const git = await resolveGitExecutable(root);
  assert.ok(git, "Git must be available for workspace fingerprint tests");
  await runGit(git, root, "init", "--quiet");
  await runGit(git, root, "config", "user.name", "Hydra Test");
  await runGit(git, root, "config", "user.email", "hydra@example.invalid");
  await fs.writeFile(path.join(root, ".gitignore"), ".hydra/\nignored.log\n", "utf8");
  await fs.writeFile(path.join(root, "tracked.txt"), "committed\n", "utf8");
  await runGit(git, root, "add", ".gitignore", "tracked.txt");
  await runGit(git, root, "commit", "--quiet", "-m", "fixture");
  return { root, git };
}

async function runGit(git: string, cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync(git, args, { cwd, windowsHide: true });
}

describe("duel workspace integrity guard", () => {
  test("is stable for the same dirty tree and changes with tracked, index, deletion, and untracked state", async (t) => {
    const { root, git } = await createRepository(t);
    const tracked = path.join(root, "tracked.txt");
    const untracked = path.join(root, "untracked.txt");
    await fs.writeFile(tracked, "dirty one\n", "utf8");
    await fs.writeFile(untracked, "untracked one\n", "utf8");

    const first = await captureDuelWorkspaceFingerprint(root);
    const repeated = await captureDuelWorkspaceFingerprint(root);
    assert.equal(repeated.sha256, first.sha256);
    assert.equal(first.algorithm, "sha256");
    assert.equal(first.trackedFileCount, 2);
    assert.equal(first.untrackedFileCount, 1);

    await fs.writeFile(tracked, "dirty two\n", "utf8");
    const trackedMutation = await captureDuelWorkspaceFingerprint(root);
    assert.notEqual(trackedMutation.sha256, first.sha256);

    await runGit(git, root, "add", "tracked.txt");
    const indexMutation = await captureDuelWorkspaceFingerprint(root);
    assert.notEqual(indexMutation.sha256, trackedMutation.sha256);

    await fs.writeFile(untracked, "untracked two\n", "utf8");
    const untrackedMutation = await captureDuelWorkspaceFingerprint(root);
    assert.notEqual(untrackedMutation.sha256, indexMutation.sha256);

    await fs.rm(tracked);
    const deletion = await captureDuelWorkspaceFingerprint(root);
    assert.notEqual(deletion.sha256, untrackedMutation.sha256);
  });

  test("exempts Hydra-owned state but detects ignored project-file metadata changes", async (t) => {
    const { root } = await createRepository(t);
    const before = await captureDuelWorkspaceFingerprint(root);
    await fs.mkdir(path.join(root, ".hydra"));
    await fs.writeFile(path.join(root, ".hydra", "verification.jsonl"), "{\"ok\":true}\n", "utf8");
    const hydraChanged = await captureDuelWorkspaceFingerprint(root);
    assert.equal(hydraChanged.sha256, before.sha256);

    await fs.writeFile(path.join(root, "ignored.log"), "ignored too\n", "utf8");
    const after = await captureDuelWorkspaceFingerprint(root);
    assert.notEqual(after.sha256, before.sha256);
    assert.equal(after.untrackedFileCount, 0);
    assert.ok(after.workspaceEntryCount > before.workspaceEntryCount);
  });

  test("does not invoke configured fsmonitor, external diff, or textconv programs", async (t) => {
    const { root, git } = await createRepository(t);
    const impossible = path.join(root, "must-not-run-hydra-helper");
    await runGit(git, root, "config", "core.fsmonitor", impossible);
    await runGit(git, root, "config", "diff.external", impossible);
    await runGit(git, root, "config", "diff.hydra.textconv", impossible);
    await fs.writeFile(path.join(root, ".gitattributes"), "*.txt diff=hydra\n", "utf8");

    const result = await captureDuelWorkspaceFingerprint(root);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    assert.equal(result.untrackedFileCount, 1);
  });

  test("never follows an untracked symbolic link", async (t) => {
    const { root } = await createRepository(t);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-duel-workspace-outside-"));
    t.after(async () => {
      await fs.rm(outside, { recursive: true, force: true });
    });
    const target = path.join(outside, "secret.txt");
    await fs.writeFile(target, "first secret\n", "utf8");
    const before = await captureDuelWorkspaceFingerprint(root);
    try {
      await fs.symlink(target, path.join(root, "outside-link.txt"), "file");
    } catch (error) {
      t.skip(`symbolic-link creation unavailable: ${String(error)}`);
      return;
    }
    const linked = await captureDuelWorkspaceFingerprint(root);
    assert.notEqual(linked.sha256, before.sha256);
    assert.equal(linked.untrackedFileCount, 0);

    await fs.writeFile(target, "changed secret\n", "utf8");
    const targetChanged = await captureDuelWorkspaceFingerprint(root);
    assert.equal(targetChanged.sha256, linked.sha256);
  });

  test("live monitor catches write-then-revert activity while exempting Hydra state", async (t) => {
    const { root } = await createRepository(t);
    const projectFile = path.join(root, "ignored.log");
    await fs.writeFile(projectFile, "original\n", "utf8");
    const monitor = watchDuelWorkspaceMutations(root);
    t.after(() => monitor.close());

    await fs.mkdir(path.join(root, ".hydra"));
    await fs.writeFile(path.join(root, ".hydra", "duels.md"), "runtime mirror\n", "utf8");
    await monitor.settle();
    assert.equal(monitor.changed, false);

    await fs.writeFile(projectFile, "temporary mutation\n", "utf8");
    await fs.writeFile(projectFile, "original\n", "utf8");
    await monitor.settle();
    assert.equal(monitor.changed, true);
    assert.ok(monitor.changedPaths.some((entry) => entry === "ignored.log"));
  });

  test("fails closed when individual, aggregate, file-count, or Git-output bounds are exceeded", async (t) => {
    const { root } = await createRepository(t);
    await fs.writeFile(path.join(root, "large.bin"), Buffer.alloc(32, 0x61));

    await assert.rejects(
      captureDuelWorkspaceFingerprint(root, { maxFileBytes: 16 }),
      (error: unknown) => error instanceof DuelWorkspaceIntegrityError && error.code === "fileTooLarge",
    );
    await assert.rejects(
      captureDuelWorkspaceFingerprint(root, { maxTotalFileBytes: 10 }),
      (error: unknown) => error instanceof DuelWorkspaceIntegrityError && error.code === "workspaceTooLarge",
    );
    await assert.rejects(
      captureDuelWorkspaceFingerprint(root, { maxFiles: 1 }),
      (error: unknown) => error instanceof DuelWorkspaceIntegrityError && error.code === "tooManyFiles",
    );
    await assert.rejects(
      captureDuelWorkspaceFingerprint(root, { maxGitOutputBytes: 10 }),
      (error: unknown) => error instanceof DuelWorkspaceIntegrityError && error.code === "gitOutputTooLarge",
    );
  });
});
