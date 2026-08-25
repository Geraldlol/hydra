import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, test, type TestContext } from "node:test";
import {
  captureDuelWorkspaceFingerprint,
  classifyDuelWorkspaceWatchPath,
  describeWorkspaceLockFailure,
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

  test("can exclude ignored workspace metadata for reproducible build scoring", async (t) => {
    const { root } = await createRepository(t);
    const options = { includeWorkspaceMetadata: false, hashOnlyChangedTrackedFiles: true };
    const before = await captureDuelWorkspaceFingerprint(root, options);
    await fs.writeFile(path.join(root, "ignored.log"), "generated test output\n", "utf8");
    const ignoredAfter = await captureDuelWorkspaceFingerprint(root, options);
    assert.equal(before.workspaceEntryCount, 0);
    assert.equal(ignoredAfter.workspaceEntryCount, 0);
    assert.equal(ignoredAfter.sha256, before.sha256);

    await fs.writeFile(path.join(root, "tracked.txt"), "builder change\n", "utf8");
    const changedAfter = await captureDuelWorkspaceFingerprint(root, options);
    assert.notEqual(changedAfter.sha256, before.sha256);
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

  test("binds untracked link targets when workspace metadata is excluded for scoring", async (t) => {
    const { root } = await createRepository(t);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-score-workspace-outside-"));
    t.after(async () => {
      await fs.rm(outside, { recursive: true, force: true });
    });
    const firstTarget = path.join(outside, "first.txt");
    const secondTarget = path.join(outside, "second.txt");
    await fs.writeFile(firstTarget, "first outside value\n", "utf8");
    await fs.writeFile(secondTarget, "second outside value\n", "utf8");
    const link = path.join(root, "untracked-link.txt");
    try {
      await fs.symlink(firstTarget, link, "file");
    } catch (error) {
      t.skip(`symbolic-link creation unavailable: ${String(error)}`);
      return;
    }

    const options = { includeWorkspaceMetadata: false, hashOnlyChangedTrackedFiles: true };
    const first = await captureDuelWorkspaceFingerprint(root, options);
    await fs.unlink(link);
    await fs.symlink(secondTarget, link, "file");
    const retargeted = await captureDuelWorkspaceFingerprint(root, options);
    assert.notEqual(retargeted.sha256, first.sha256);

    await fs.writeFile(secondTarget, "changed outside value\n", "utf8");
    const targetContentChanged = await captureDuelWorkspaceFingerprint(root, options);
    assert.equal(targetContentChanged.sha256, retargeted.sha256);
  });

  test("classifies watcher paths without confusing Hydra state and project evidence", () => {
    const root = path.resolve(path.join(os.tmpdir(), "hydra-watcher-canonical"));
    const logicalRoot = path.resolve(path.join(os.tmpdir(), "hydra-watcher-logical"));
    assert.deepEqual(
      classifyDuelWorkspaceWatchPath(root, logicalRoot, path.join(".hydra", "duels.md"), true),
      { changed: false },
    );
    assert.deepEqual(
      classifyDuelWorkspaceWatchPath(root, logicalRoot, path.join(".git", "index"), true),
      { changed: false },
    );
    assert.deepEqual(
      classifyDuelWorkspaceWatchPath(root, logicalRoot, path.join(".hydra", "contestant.txt"), false),
      { changed: true, relative: ".hydra/contestant.txt" },
    );
    assert.deepEqual(
      classifyDuelWorkspaceWatchPath(root, logicalRoot, path.join(logicalRoot, "project.txt"), true),
      { changed: true, relative: "project.txt" },
    );
    assert.deepEqual(
      classifyDuelWorkspaceWatchPath(root, logicalRoot, path.basename(root), true),
      {
        changed: true,
        error: "Workspace watcher emitted an event without an in-root path.",
      },
    );
    if (process.platform !== "win32") {
      const projectName = String.raw`.hydra\evidence`;
      assert.deepEqual(
        classifyDuelWorkspaceWatchPath(root, logicalRoot, projectName, true),
        { changed: true, relative: projectName },
      );
    }
  });

  test("live monitor catches write-then-revert activity and caps retained paths", async (t) => {
    const { root } = await createRepository(t);
    const projectFile = path.join(root, "ignored.log");
    await fs.writeFile(projectFile, "original\n", "utf8");
    const monitor = watchDuelWorkspaceMutations(root);
    t.after(() => monitor.close());
    await monitor.settle();
    await fs.writeFile(projectFile, "temporary mutation\n", "utf8");
    await fs.writeFile(projectFile, "original\n", "utf8");
    await monitor.settle();
    assert.equal(monitor.changed, true);
    assert.ok(
      monitor.changedPaths.some((entry) => entry === "ignored.log") || monitor.error,
      "the live mutation must be attributed or reported as an ambiguous fail-closed event",
    );

    await Promise.all(Array.from({ length: 64 }, (_value, index) =>
      fs.writeFile(path.join(root, `mutation-${index}.txt`), "changed\n", "utf8")));
    await monitor.settle();
    assert.ok(monitor.changedPaths.length <= 20);
  });

  test("live monitor exempts attributed Hydra events and fails closed on ambiguous ones", async (t) => {
    const { root } = await createRepository(t);
    await fs.mkdir(path.join(root, ".hydra"));
    const monitor = watchDuelWorkspaceMutations(root);
    t.after(() => monitor.close());
    await monitor.settle();

    await fs.writeFile(path.join(root, ".hydra", "duels.md"), "runtime mirror\n", "utf8");
    await monitor.settle();

    assert.equal(
      monitor.changed && monitor.error === undefined,
      false,
      "a Hydra path may be exempt or ambiguous, but must not be attributed as project evidence",
    );
    assert.equal(monitor.changedPaths.some((entry) => entry.startsWith(".hydra/")), false);
  });

  test("Arena-mode monitoring treats contestant .hydra writes as mutations", async (t) => {
    const { root } = await createRepository(t);
    const monitor = watchDuelWorkspaceMutations(root, {
      excludeHydraState: false,
    });
    t.after(() => monitor.close());

    await monitor.settle();
    await fs.mkdir(path.join(root, ".hydra"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".hydra", "unbound-output.txt"),
      "contestant output\n",
      "utf8",
    );
    await monitor.settle();

    assert.equal(monitor.changed, true);
    assert.ok(
      monitor.changedPaths.some((entry) => entry.startsWith(".hydra/")) || monitor.error,
      "the Arena mutation must be attributed or reported as an ambiguous fail-closed event",
    );
  });

  test("live monitor does not exempt a POSIX backslash filename", async (t) => {
    if (process.platform === "win32") {
      t.skip("Windows path separators cannot be literal filename characters");
      return;
    }
    const { root } = await createRepository(t);
    const monitor = watchDuelWorkspaceMutations(root);
    t.after(() => monitor.close());
    await monitor.settle();

    const projectName = String.raw`.hydra\evidence`;
    await fs.writeFile(path.join(root, projectName), "project evidence\n", "utf8");
    await monitor.settle();

    assert.equal(monitor.changed, true);
    assert.ok(
      monitor.changedPaths.includes(projectName) || monitor.error,
      "the project mutation must be attributed or reported as an ambiguous fail-closed event",
    );
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

describe("workspace lock failure description", () => {
  test("passes an integrity error through and localises anything else", () => {
    // An integrity error already names its condition; adding a frame would be
    // noise on a message that is already actionable.
    const integrity = new DuelWorkspaceIntegrityError(
      "gitFailed",
      "Git returned an invalid HEAD object id.",
    );
    assert.equal(
      describeWorkspaceLockFailure(integrity),
      "Git returned an invalid HEAD object id.",
    );
    assert.doesNotMatch(describeWorkspaceLockFailure(integrity), / - at /);

    // The case that motivated this: a bare TypeError message says nothing about
    // where it came from, so the class and originating frame get appended.
    let thrown: unknown;
    try {
      const missing = undefined as unknown as { toString(): string };
      missing.toString();
    } catch (error) {
      thrown = error;
    }
    const described = describeWorkspaceLockFailure(thrown);
    assert.match(described, /^TypeError: /, described);
    assert.match(described, /Cannot read propert/, described);
    assert.match(described, / - at /, `expected an originating frame, got: ${described}`);
  });

  test("survives a thrown non-Error and an Error with no stack", () => {
    assert.equal(describeWorkspaceLockFailure("plain string"), "plain string");
    const stackless = new Error("no stack here");
    stackless.stack = undefined;
    assert.equal(describeWorkspaceLockFailure(stackless), "Error: no stack here");
  });
});
