import assert from "node:assert/strict";
import * as cp from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  after,
  before,
  describe,
  test,
  type TestContext,
} from "node:test";
import * as vscode from "vscode";
import {
  ArenaGitError,
  ArenaGitExecutor,
  arenaWorktreeLockReason,
  parseArenaWorktreeListPorcelainZ,
  runArenaGitCommand,
} from "../src/arenaGit";
import {
  arenaContestantWorktreePath,
  type FileArenaManifestStore,
  openFileArenaManifestStore,
} from "../src/arenaStore";
import {
  ARENA_POLICY_ID,
  type ArenaRunLockedPayload,
} from "../src/arenaRunManifest";
import {
  FileArenaWorktreeRegistrationStore,
  type ArenaWorktreeRegistrationIntent,
} from "../src/arenaWorktreeRegistration";
import { HANG_NET_TIMEOUT_MS } from "./testBudgets";

const RUN_ID = "arena-git-run";
const FIRST_CONTESTANT = "contestant-one";
const SECOND_CONTESTANT = "contestant-two";
const FIRST_WORKTREE = "worktree-one";
const SECOND_WORKTREE = "worktree-two";
const TIME = "2026-07-25T14:00:00.000Z";

interface ProcessResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number;
}

interface RepositoryFixture {
  readonly root: string;
  readonly workspace: string;
  readonly privateRoot: string;
  readonly leaseRoot: string;
  readonly unrelatedWorktree?: string;
}

const workspace = vscode.workspace as typeof vscode.workspace & {
  isTrusted?: boolean;
};
let originalTrust: PropertyDescriptor | undefined;
let nativeGitAvailable = false;

before(async () => {
  originalTrust = Object.getOwnPropertyDescriptor(workspace, "isTrusted");
  Object.defineProperty(workspace, "isTrusted", {
    configurable: true,
    writable: true,
    value: true,
  });
  try {
    await runProcess("git", ["--version"], process.cwd());
    nativeGitAvailable = true;
  } catch {
    nativeGitAvailable = false;
  }
});

after(() => {
  if (originalTrust) {
    Object.defineProperty(workspace, "isTrusted", originalTrust);
  } else {
    delete (workspace as unknown as { isTrusted?: boolean }).isTrusted;
  }
});

async function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  allowedExitCodes: readonly number[] = [0],
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = cp.spawn(executable, [...args], {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const exitCode = code ?? -1;
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode,
      };
      if (!allowedExitCodes.includes(exitCode)) {
        reject(new Error(
          `${path.basename(executable)} ${args.join(" ")} exited ${exitCode}: ${
            result.stderr.toString("utf8")
          }`,
        ));
        return;
      }
      resolve(result);
    });
  });
}

async function git(
  cwd: string,
  args: readonly string[],
  allowedExitCodes: readonly number[] = [0],
): Promise<ProcessResult> {
  return runProcess("git", args, cwd, allowedExitCodes);
}

async function repositoryFixture(
  t: TestContext,
  options: { readonly unrelatedWorktree?: boolean } = {},
): Promise<RepositoryFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-git-"));
  const workspaceRoot = path.join(root, "source");
  const privateRoot = path.join(root, "private");
  const leaseRoot = path.join(root, "global-leases");
  await fs.mkdir(workspaceRoot);
  t.after(async () => {
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  await git(workspaceRoot, [
    "init",
    "--initial-branch=main",
    "--object-format=sha1",
  ]);
  await git(workspaceRoot, ["config", "user.name", "Hydra Arena Test"]);
  await git(workspaceRoot, ["config", "user.email", "arena@example.invalid"]);
  await fs.writeFile(
    path.join(workspaceRoot, "tracked.txt"),
    "locked base content\n",
    "utf8",
  );
  await git(workspaceRoot, ["add", "--", "tracked.txt"]);
  await git(workspaceRoot, ["commit", "-m", "test base"]);

  let unrelatedWorktree: string | undefined;
  if (options.unrelatedWorktree) {
    unrelatedWorktree = path.join(root, "unrelated-worktree");
    await git(workspaceRoot, [
      "worktree",
      "add",
      "--detach",
      unrelatedWorktree,
      "HEAD",
    ]);
  }
  return {
    root,
    workspace: workspaceRoot,
    privateRoot,
    leaseRoot,
    unrelatedWorktree,
  };
}

function requireNativeGit(t: TestContext): boolean {
  if (nativeGitAvailable) return true;
  t.skip("native Git is unavailable on PATH");
  return false;
}

function planRows(): readonly [
  {
    readonly runId: string;
    readonly contestantId: string;
    readonly worktreeId: string;
    readonly intentId: string;
    readonly occurredAt: string;
  },
  {
    readonly runId: string;
    readonly contestantId: string;
    readonly worktreeId: string;
    readonly intentId: string;
    readonly occurredAt: string;
  },
] {
  return [
    {
      runId: RUN_ID,
      contestantId: FIRST_CONTESTANT,
      worktreeId: FIRST_WORKTREE,
      intentId: "intent-one",
      occurredAt: TIME,
    },
    {
      runId: RUN_ID,
      contestantId: SECOND_CONTESTANT,
      worktreeId: SECOND_WORKTREE,
      intentId: "intent-two",
      occurredAt: TIME,
    },
  ];
}

async function planTwo(
  executor: ArenaGitExecutor,
  t: TestContext,
): Promise<readonly [
  ArenaWorktreeRegistrationIntent,
  ArenaWorktreeRegistrationIntent,
]> {
  const admission = await executor.inspectAdmission();
  await claimAdmission(executor, t, admission);
  const intents = await executor.planWorktrees({
    admission,
    contestants: planRows(),
  });
  assert.equal(intents.length, 2);
  const first = intents[0];
  const second = intents[1];
  assert.ok(first);
  assert.ok(second);
  return [first, second];
}

async function claimAdmission(
  executor: ArenaGitExecutor,
  t: TestContext,
  admission: Awaited<ReturnType<ArenaGitExecutor["inspectAdmission"]>>,
  options: {
    readonly runId?: string;
    readonly contestants?: ArenaRunLockedPayload["contestants"];
    readonly startMonitor?: boolean;
  } = {},
): Promise<FileArenaManifestStore> {
  const runId = options.runId ?? RUN_ID;
  const store = await openFileArenaManifestStore(
    executor.privateWorkspaceRoot,
  );
  const lock: ArenaRunLockedPayload = {
    payloadType: "runLocked",
    policy: ARENA_POLICY_ID,
    mission: {
      missionId: "arena-git-mission",
      revision: 1,
      documentSha256: testDigest("mission-document"),
      bindingSha256: testDigest("mission-binding"),
    },
    base: {
      revision: admission.baseRevision,
      repositoryIdentitySha256: admission.repositoryIdentitySha256,
      baseContentSha256: admission.baseContentSha256,
      sourceWorkspaceFingerprintSha256:
        admission.sourceWorkspaceFingerprintSha256,
      repositoryControlSha256: admission.repositoryControlSha256,
    },
    inputBundleSha256: testDigest("input"),
    preparationPlanSha256: null,
    environmentPolicySha256: testDigest("environment"),
    budgetSha256: testDigest("budget"),
    verificationChecks: [],
    browserJourneys: [],
    contestants: options.contestants ?? [
      {
        contestantId: FIRST_CONTESTANT,
        headId: "codex",
        agentKind: "codex",
        headConfigSha256: testDigest("codex-config"),
        authoritySha256: testDigest("codex-authority"),
        invocationSha256: testDigest("codex-invocation"),
        worktreeId: FIRST_WORKTREE,
      },
      {
        contestantId: SECOND_CONTESTANT,
        headId: "claude",
        agentKind: "claude",
        headConfigSha256: testDigest("claude-config"),
        authoritySha256: testDigest("claude-authority"),
        invocationSha256: testDigest("claude-invocation"),
        worktreeId: SECOND_WORKTREE,
      },
    ],
    steering: "disabled",
    confirmation: {
      actorId: "local-user",
      action: "Confirm Arena Run",
      confirmationId: "arena-git-confirmation",
    },
  };
  await store.append({
    eventId: `${runId}-arena-git-lock`,
    runId,
    occurredAt: TIME,
    type: "arenaRunLocked",
    payload: lock,
  });
  const claim = await executor.claimRepositoryRun(runId, admission);
  assert.equal(claim.status, "active");
  if (options.startMonitor !== false) {
    await appendMonitorStarted(store, runId, admission);
  }
  t.after(() => executor.abandonRepositoryRun(runId));
  return store;
}

async function appendMonitorStarted(
  store: FileArenaManifestStore,
  runId: string,
  admission: Awaited<ReturnType<ArenaGitExecutor["inspectAdmission"]>>,
): Promise<void> {
  await store.append({
    eventId: `${runId}-monitor-started`,
    runId,
    occurredAt: TIME,
    type: "arenaMainWorkspaceObserved",
    payload: {
      payloadType: "mainWorkspaceObserved",
      observationKind: "monitorStarted",
      monitorEpochId: `${runId}-monitor-epoch`,
      monitorReceiptSha256: testDigest(`${runId}-monitor-started`),
      status: "unchanged",
      sourceWorkspaceFingerprintSha256:
        admission.sourceWorkspaceFingerprintSha256,
      repositoryControlSha256: admission.repositoryControlSha256,
      head: admission.baseRevision,
      watcherChanged: false,
      reasonCode: null,
    },
  });
}

function testDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function gitError(code: ArenaGitError["code"]): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof ArenaGitError && error.code === code;
}

function porcelainEntry(input: {
  readonly worktreePath: string;
  readonly head?: string;
  readonly branch?: string;
  readonly detached?: boolean;
  readonly locked?: string;
  readonly prunable?: string;
}): string {
  const fields = [`worktree ${input.worktreePath}`];
  if (input.head !== undefined) fields.push(`HEAD ${input.head}`);
  if (input.branch !== undefined) fields.push(`branch ${input.branch}`);
  if (input.detached) fields.push("detached");
  if (input.locked !== undefined) fields.push(`locked ${input.locked}`);
  if (input.prunable !== undefined) fields.push(`prunable ${input.prunable}`);
  return `${fields.join("\0")}\0\0`;
}

describe("Arena Git executor", () => {
  test("canonicalizes an upstream private-storage alias before registering worktrees", async (t) => {
    if (!requireNativeGit(t)) return;
    const fixture = await repositoryFixture(t);
    const realPrivateParent = path.join(fixture.root, "real-private-parent");
    const aliasPrivateParent = path.join(fixture.root, "alias-private-parent");
    await fs.mkdir(realPrivateParent);
    try {
      await fs.symlink(
        realPrivateParent,
        aliasPrivateParent,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      t.skip(`directory-link creation unavailable: ${String(error)}`);
      return;
    }
    const privateAlias = path.join(aliasPrivateParent, "workspace-storage");
    const executor = await ArenaGitExecutor.open(
      fixture.workspace,
      privateAlias,
      fixture.leaseRoot,
    );
    const [firstIntent] = await planTwo(executor, t);
    const first = await executor.provisionPlannedWorktree(firstIntent);

    assert.equal(
      first.worktreePath,
      arenaContestantWorktreePath(
        await fs.realpath(privateAlias),
        RUN_ID,
        FIRST_CONTESTANT,
      ),
    );
    assert.equal(first.realWorktreePath, await fs.realpath(first.worktreePath));
  });

  test("admits an exact trusted clean main worktree and snapshots an unrelated worktree", async (t) => {
    if (!requireNativeGit(t)) return;
    const fixture = await repositoryFixture(t, { unrelatedWorktree: true });
    const executor = await ArenaGitExecutor.open(
      fixture.workspace,
      fixture.privateRoot,
      fixture.leaseRoot,
    );
    const admission = await executor.inspectAdmission();

    assert.equal(admission.policy, "hydra-arena-git-v1");
    assert.equal(admission.objectFormat, "sha1");
    assert.match(admission.baseRevision.oid, /^[0-9a-f]{40}$/);
    assert.match(admission.baseContentSha256, /^[0-9a-f]{64}$/);
    assert.match(admission.repositoryIdentitySha256, /^[0-9a-f]{64}$/);
    assert.match(admission.repositoryControlSha256, /^[0-9a-f]{64}$/);
    assert.equal(admission.sourceWorkspacePath, await fs.realpath(fixture.workspace));
    assert.equal(admission.worktrees.length, 2);
    const unrelatedRealPath = await fs.realpath(fixture.unrelatedWorktree!);
    assert.ok(admission.worktrees.some((entry) =>
      entry.path === unrelatedRealPath));
  });

  test("batch-plans two durable intents before creating either worktree", async (t) => {
    if (!requireNativeGit(t)) return;
    const fixture = await repositoryFixture(t);
    const executor = await ArenaGitExecutor.open(
      fixture.workspace,
      fixture.privateRoot,
      fixture.leaseRoot,
    );
    const [first, second] = await planTwo(executor, t);

    assert.notEqual(first.intentSha256, second.intentSha256);
    assert.equal(
      first.worktreePath,
      arenaContestantWorktreePath(
        executor.privateWorkspaceRoot,
        RUN_ID,
        FIRST_CONTESTANT,
      ),
    );
    assert.equal(
      second.worktreePath,
      arenaContestantWorktreePath(
        executor.privateWorkspaceRoot,
        RUN_ID,
        SECOND_CONTESTANT,
      ),
    );
    await assert.rejects(fs.lstat(first.worktreePath), { code: "ENOENT" });
    await assert.rejects(fs.lstat(second.worktreePath), { code: "ENOENT" });

    const store = new FileArenaWorktreeRegistrationStore(
      executor.privateWorkspaceRoot,
    );
    const states = await store.listRun(RUN_ID);
    assert.equal(states.length, 2);
    assert.deepEqual(
      states.map((state) => state.intent.contestantId),
      [FIRST_CONTESTANT, SECOND_CONTESTANT],
    );
    assert.ok(states.every((state) => state.receipt === undefined));
  });

  test("tightens an unreceipted Git-created worktree before crash recovery", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX private-directory permissions");
      return;
    }
    if (!requireNativeGit(t)) return;
    const fixture = await repositoryFixture(t);
    const executor = await ArenaGitExecutor.open(
      fixture.workspace,
      fixture.privateRoot,
      fixture.leaseRoot,
    );
    const [intent] = await planTwo(executor, t);
    await git(fixture.workspace, [
      "worktree",
      "add",
      "--detach",
      "--lock",
      "--reason",
      intent.lockReason,
      "--no-relative-paths",
      "--",
      intent.worktreePath,
      intent.baseRevision.oid,
    ]);
    await fs.chmod(intent.worktreePath, 0o755);
    const provisioned = await executor.provisionPlannedWorktree(intent);

    const worktree = await fs.lstat(provisioned.worktreePath);
    assert.equal(worktree.mode & 0o077, 0);
  });

  test("rejects permission drift after a worktree receipt without repairing it", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX private-directory permissions");
      return;
    }
    if (!requireNativeGit(t)) return;
    const fixture = await repositoryFixture(t);
    const executor = await ArenaGitExecutor.open(
      fixture.workspace,
      fixture.privateRoot,
      fixture.leaseRoot,
    );
    const [intent] = await planTwo(executor, t);
    const provisioned = await executor.provisionPlannedWorktree(intent);
    await fs.chmod(provisioned.worktreePath, 0o755);

    await assert.rejects(
      executor.provisionPlannedWorktree(intent),
      gitError("registrationMismatch"),
    );
    const worktree = await fs.lstat(provisioned.worktreePath);
    assert.equal(worktree.mode & 0o077, 0o055);
  });

  test("provisions detached locked worktrees from the identical base", async (t) => {
    if (!requireNativeGit(t)) return;
    const fixture = await repositoryFixture(t);
    const executor = await ArenaGitExecutor.open(
      fixture.workspace,
      fixture.privateRoot,
      fixture.leaseRoot,
    );
    const [firstIntent, secondIntent] = await planTwo(executor, t);
    const first = await executor.provisionPlannedWorktree(firstIntent);
    const second = await executor.provisionPlannedWorktree(secondIntent);

    assert.equal(first.head.oid, second.head.oid);
    assert.equal(first.fingerprint.sha256, second.fingerprint.sha256);
    assert.equal(first.fingerprint.sha256, firstIntent.baseContentSha256);
    assert.equal(
      first.lockReason,
      arenaWorktreeLockReason(RUN_ID, FIRST_CONTESTANT, FIRST_WORKTREE),
    );
    assert.match(first.registrationSha256, /^[0-9a-f]{64}$/);
    assert.match(second.registrationSha256, /^[0-9a-f]{64}$/);

    for (const provisioned of [first, second]) {
      const symbolic = await git(
        provisioned.worktreePath,
        ["symbolic-ref", "-q", "HEAD"],
        [1],
      );
      assert.equal(symbolic.stdout.length, 0);
      assert.equal(
        (await git(
          provisioned.worktreePath,
          ["rev-parse", "--verify", "HEAD^{commit}"],
        )).stdout.toString("utf8").trim(),
        firstIntent.baseRevision.oid,
      );
      const entry = (await executor.listWorktrees()).find((candidate) =>
        candidate.path === provisioned.realWorktreePath);
      assert.ok(entry);
      assert.equal(entry.detached, true);
      assert.equal(entry.branch, null);
      assert.equal(entry.lockedReason, provisioned.lockReason);
    }
  });

  test("recovers a durable receipt idempotently but refuses unsafe restart takeover", async (t) => {
    if (!requireNativeGit(t)) return;
    const fixture = await repositoryFixture(t);
    const executor = await ArenaGitExecutor.open(
      fixture.workspace,
      fixture.privateRoot,
      fixture.leaseRoot,
    );
    const admission = await executor.inspectAdmission();
    await claimAdmission(executor, t, admission);
    const intents = await executor.planWorktrees({
      admission,
      contestants: planRows(),
    });
    const firstIntent = intents[0]!;
    const provisioned = await executor.provisionPlannedWorktree(firstIntent);

    const recovered = await executor.recoverProvisionedWorktree(
      RUN_ID,
      FIRST_CONTESTANT,
    );
    assert.ok(recovered);
    assert.equal(recovered.intentSha256, provisioned.intentSha256);
    assert.equal(
      recovered.registrationSha256,
      provisioned.registrationSha256,
    );
    assert.equal(
      recovered.gitRegistrationSha256,
      provisioned.gitRegistrationSha256,
    );
    assert.equal(
      recovered.directoryIdentitySha256,
      provisioned.directoryIdentitySha256,
    );

    const retried = await executor.provisionPlannedWorktree(firstIntent);
    assert.equal(retried.registrationSha256, provisioned.registrationSha256);
    assert.equal(
      (await executor.listWorktrees()).filter((entry) =>
        entry.path === provisioned.realWorktreePath).length,
      1,
    );

    executor.abandonRepositoryRun(RUN_ID);
    const reopened = await ArenaGitExecutor.open(
      fixture.workspace,
      fixture.privateRoot,
      fixture.leaseRoot,
    );
    await assert.rejects(
      reopened.claimRepositoryRun(RUN_ID, admission),
      gitError("registrationMismatch"),
    );
  });

  test("rejects cleanup before finalization and preserves an unrelated worktree", async (t) => {
    if (!requireNativeGit(t)) return;
    const fixture = await repositoryFixture(t, { unrelatedWorktree: true });
    const executor = await ArenaGitExecutor.open(
      fixture.workspace,
      fixture.privateRoot,
      fixture.leaseRoot,
    );
    const admission = await executor.inspectAdmission();
    await claimAdmission(executor, t, admission);
    const [firstIntent, secondIntent] = await executor.planWorktrees({
      admission,
      contestants: planRows(),
    });
    assert.ok(firstIntent);
    assert.ok(secondIntent);
    const first = await executor.provisionPlannedWorktree(firstIntent);
    const second = await executor.provisionPlannedWorktree(secondIntent);

    await assert.rejects(
      executor.unlockOwnedWorktree({
        ...first,
        registrationSha256: "f".repeat(64),
      }),
      gitError("registrationMismatch"),
    );
    await assert.rejects(
      executor.unlockOwnedWorktree(first),
      gitError("registrationMismatch"),
    );
    await assert.rejects(
      executor.removeOwnedWorktree(second),
      gitError("registrationMismatch"),
    );

    const remaining = await executor.listWorktrees();
    assert.equal(
      remaining.some((entry) => entry.path === first.realWorktreePath),
      true,
    );
    assert.equal(
      remaining.some((entry) => entry.path === second.realWorktreePath),
      true,
    );
    assert.ok(fixture.unrelatedWorktree);
    const unrelatedRealPath = await fs.realpath(fixture.unrelatedWorktree);
    assert.equal(
      remaining.some((entry) =>
        entry.path === unrelatedRealPath),
      true,
    );
    assert.equal(
      (await git(fixture.workspace, [
        "status",
        "--porcelain=v1",
        "-z",
      ])).stdout.length,
      0,
    );
    assert.equal(
      (await git(fixture.unrelatedWorktree, [
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ])).stdout.toString("utf8").trim(),
      admission.baseRevision.oid,
    );
  });

  test("rejects dirty source state and configured repository helpers", async (t) => {
    if (!requireNativeGit(t)) return;
    const fixture = await repositoryFixture(t);
    const executor = await ArenaGitExecutor.open(
      fixture.workspace,
      fixture.privateRoot,
      fixture.leaseRoot,
    );

    await fs.writeFile(path.join(fixture.workspace, "untracked.txt"), "dirty\n");
    await assert.rejects(
      executor.inspectAdmission(),
      gitError("dirtyWorkspace"),
    );
    await fs.rm(path.join(fixture.workspace, "untracked.txt"));

    await git(fixture.workspace, [
      "config",
      "filter.hydra-arena.clean",
      "node ignored.js",
    ]);
    await assert.rejects(
      executor.inspectAdmission(),
      gitError("configuredHelpers"),
    );
    await git(fixture.workspace, [
      "config",
      "--unset-all",
      "filter.hydra-arena.clean",
    ]);
    const refLock = path.join(
      fixture.workspace,
      ".git",
      "refs",
      "heads",
      "hydra-arena.lock",
    );
    await fs.writeFile(refLock, "active\n", "utf8");
    await assert.rejects(
      executor.inspectAdmission(),
      gitError("sequencerActive"),
    );
  });

  test("refuses provisioning after repository config changes from the durable intent", async (t) => {
    if (!requireNativeGit(t)) return;
    const fixture = await repositoryFixture(t);
    const executor = await ArenaGitExecutor.open(
      fixture.workspace,
      fixture.privateRoot,
      fixture.leaseRoot,
    );
    const admission = await executor.inspectAdmission();
    await claimAdmission(executor, t, admission);
    const intents = await executor.planWorktrees({
      admission,
      contestants: [planRows()[0]],
    });
    const intent = intents[0];
    assert.ok(intent);

    await git(fixture.workspace, ["config", "arena.changed", "true"]);
    await assert.rejects(
      executor.provisionPlannedWorktree(intent),
      gitError("worktreeStateMismatch"),
    );
    await assert.rejects(fs.lstat(intent.worktreePath), { code: "ENOENT" });
  });

  test("replays manifest authority at provisioning and leaves Git untouched when authority is invalid", async (t) => {
    if (!requireNativeGit(t)) return;

    await t.test("requires the pre-provision monitor epoch", async (st) => {
      const fixture = await repositoryFixture(st);
      const executor = await ArenaGitExecutor.open(
        fixture.workspace,
        fixture.privateRoot,
        fixture.leaseRoot,
      );
      const admission = await executor.inspectAdmission();
      await claimAdmission(executor, st, admission, {
        startMonitor: false,
      });
      const [intent] = await executor.planWorktrees({
        admission,
        contestants: [planRows()[0]],
      });
      assert.ok(intent);

      await assert.rejects(
        executor.provisionPlannedWorktree(intent),
        gitError("registrationMismatch"),
      );
      await assertNoProvisioningSideEffect(executor, intent);
    });

    await t.test("rejects a contestant/worktree pair absent from the lock", async (st) => {
      const fixture = await repositoryFixture(st);
      const executor = await ArenaGitExecutor.open(
        fixture.workspace,
        fixture.privateRoot,
        fixture.leaseRoot,
      );
      const admission = await executor.inspectAdmission();
      await claimAdmission(executor, st, admission);
      const [intent] = await executor.planWorktrees({
        admission,
        contestants: [{
          ...planRows()[0],
          worktreeId: "unauthorized-worktree",
        }],
      });
      assert.ok(intent);

      await assert.rejects(
        executor.provisionPlannedWorktree(intent),
        gitError("registrationMismatch"),
      );
      await assertNoProvisioningSideEffect(executor, intent);
    });

    await t.test("rejects a latched monitor compromise", async (st) => {
      const fixture = await repositoryFixture(st);
      const executor = await ArenaGitExecutor.open(
        fixture.workspace,
        fixture.privateRoot,
        fixture.leaseRoot,
      );
      const admission = await executor.inspectAdmission();
      const store = await claimAdmission(executor, st, admission);
      const [intent] = await executor.planWorktrees({
        admission,
        contestants: [planRows()[0]],
      });
      assert.ok(intent);
      await store.append({
        eventId: `${RUN_ID}-monitor-compromised`,
        runId: RUN_ID,
        occurredAt: TIME,
        type: "arenaMainWorkspaceObserved",
        payload: {
          payloadType: "mainWorkspaceObserved",
          observationKind: "checkpoint",
          monitorEpochId: `${RUN_ID}-monitor-epoch`,
          monitorReceiptSha256: testDigest(`${RUN_ID}-monitor-compromised`),
          status: "changed",
          sourceWorkspaceFingerprintSha256:
            admission.sourceWorkspaceFingerprintSha256,
          repositoryControlSha256: admission.repositoryControlSha256,
          head: admission.baseRevision,
          watcherChanged: true,
          reasonCode: "watcherChanged",
        },
      });

      await assert.rejects(
        executor.provisionPlannedWorktree(intent),
        gitError("registrationMismatch"),
      );
      await assertNoProvisioningSideEffect(executor, intent);
    });

    await t.test("rejects a finalized run", async (st) => {
      const fixture = await repositoryFixture(st);
      const executor = await ArenaGitExecutor.open(
        fixture.workspace,
        fixture.privateRoot,
        fixture.leaseRoot,
      );
      const admission = await executor.inspectAdmission();
      const store = await claimAdmission(executor, st, admission);
      const [intent] = await executor.planWorktrees({
        admission,
        contestants: [planRows()[0]],
      });
      assert.ok(intent);
      await store.append({
        eventId: `${RUN_ID}-cancelled`,
        runId: RUN_ID,
        occurredAt: TIME,
        type: "arenaRunFinalized",
        payload: {
          payloadType: "runFinalized",
          outcome: "cancelled",
          comparison: "incomplete",
          reasonCode: "userCancelled",
          evidenceMatrixSha256: null,
        },
      });

      await assert.rejects(
        executor.provisionPlannedWorktree(intent),
        gitError("registrationMismatch"),
      );
      await assertNoProvisioningSideEffect(executor, intent);
    });
  });

  test("releases an intent-only cancelled run and admits a new run on the repository", async (t) => {
    if (!requireNativeGit(t)) return;
    const fixture = await repositoryFixture(t);
    const executor = await ArenaGitExecutor.open(
      fixture.workspace,
      fixture.privateRoot,
      fixture.leaseRoot,
    );
    const admission = await executor.inspectAdmission();
    const firstStore = await claimAdmission(executor, t, admission);
    const [intent] = await executor.planWorktrees({
      admission,
      contestants: [planRows()[0]],
    });
    assert.ok(intent);
    await firstStore.append({
      eventId: `${RUN_ID}-intent-only-cancelled`,
      runId: RUN_ID,
      occurredAt: TIME,
      type: "arenaRunFinalized",
      payload: {
        payloadType: "runFinalized",
        outcome: "cancelled",
        comparison: "incomplete",
        reasonCode: "userCancelled",
        evidenceMatrixSha256: null,
      },
    });

    await executor.releaseRepositoryRun(RUN_ID);
    await assertNoProvisioningSideEffect(executor, intent);

    const nextRunId = "arena-git-run-next";
    const nextAdmission = await executor.inspectAdmission();
    await claimAdmission(executor, t, nextAdmission, {
      runId: nextRunId,
    });
    const [nextIntent] = await executor.planWorktrees({
      admission: nextAdmission,
      contestants: [{
        ...planRows()[0],
        runId: nextRunId,
        intentId: "next-run-intent",
      }],
    });
    assert.ok(nextIntent);
    assert.equal(nextIntent.runId, nextRunId);
    assert.notEqual(nextIntent.intentSha256, intent.intentSha256);
  });

  test("checks and applies exact promotion bytes without changing HEAD or Git controls", async (t) => {
    if (!requireNativeGit(t)) return;
    const fixture = await repositoryFixture(t);
    const executor = await ArenaGitExecutor.open(
      fixture.workspace,
      fixture.privateRoot,
      fixture.leaseRoot,
    );
    const admission = await executor.inspectAdmission();
    await fs.writeFile(
      path.join(fixture.workspace, "tracked.txt"),
      "promoted tracked content\n",
      "utf8",
    );
    const patch = (await git(fixture.workspace, [
      "diff",
      "--binary",
      "--full-index",
      "HEAD",
      "--",
    ])).stdout;
    await fs.writeFile(
      path.join(fixture.workspace, "tracked.txt"),
      "locked base content\n",
      "utf8",
    );
    const untracked = Buffer.from("promoted untracked content\n", "utf8");
    const candidate = Object.freeze({
      patch,
      patchSha256: createHash("sha256").update(patch).digest("hex"),
      artifactSetSha256: testDigest("promotion-artifacts"),
      untrackedEntries: Object.freeze([Object.freeze({
        path: "nested/promoted.txt",
        bytes: untracked.byteLength,
        sha256: createHash("sha256").update(untracked).digest("hex"),
        mode: 0o640,
        content: untracked,
      })]),
    });

    const before = await executor.inspectPromotionWorkspace(admission, RUN_ID);
    assert.equal(before.workspaceClean, true);
    assert.equal(before.arenaWorktreesAbsent, true);
    assert.deepEqual(await executor.checkPromotionCandidate(candidate), {
      applicable: true,
      conflictPaths: [],
      untrackedConflictPaths: [],
    });
    await executor.applyPromotionCandidate(candidate);

    assert.equal(
      await fs.readFile(path.join(fixture.workspace, "tracked.txt"), "utf8"),
      "promoted tracked content\n",
    );
    assert.equal(
      await fs.readFile(
        path.join(fixture.workspace, "nested", "promoted.txt"),
        "utf8",
      ),
      untracked.toString("utf8"),
    );
    const after = await executor.inspectPromotionWorkspace(admission, RUN_ID);
    assert.equal(after.head.oid, admission.baseRevision.oid);
    assert.equal(after.repositoryControlSha256, admission.repositoryControlSha256);
    assert.equal(after.arenaWorktreesAbsent, true);
    assert.equal(after.workspaceClean, false);
    assert.notEqual(after.contentFingerprintSha256, admission.baseContentSha256);
    assert.deepEqual(await executor.checkPromotionCandidate(candidate), {
      applicable: false,
      conflictPaths: [],
      untrackedConflictPaths: ["nested/promoted.txt"],
    });
  });
});

async function assertNoProvisioningSideEffect(
  executor: ArenaGitExecutor,
  intent: ArenaWorktreeRegistrationIntent,
): Promise<void> {
  await assert.rejects(fs.lstat(intent.worktreePath), { code: "ENOENT" });
  assert.equal(
    (await executor.listWorktrees()).some((entry) =>
      entry.path === intent.worktreePath),
    false,
  );
  assert.equal(
    (await git(executor.workspaceRoot, [
      "status",
      "--porcelain=v1",
      "-z",
    ])).stdout.length,
    0,
  );
}

describe("Arena worktree porcelain parser", () => {
  test("parses strict NUL records and preserves lock and prunable reasons", () => {
    const firstPath = path.resolve("arena-parser-main");
    const secondPath = path.resolve("arena-parser-linked");
    const parsed = parseArenaWorktreeListPorcelainZ(
      porcelainEntry({
        worktreePath: firstPath,
        head: "a".repeat(40),
        branch: "refs/heads/main",
      }) + porcelainEntry({
        worktreePath: secondPath,
        head: "b".repeat(40),
        detached: true,
        locked: "hydra lock",
        prunable: "missing working tree",
      }),
    );
    assert.deepEqual(parsed, [
      {
        path: firstPath,
        head: "a".repeat(40),
        branch: "refs/heads/main",
        detached: false,
        bare: false,
        lockedReason: null,
        prunableReason: null,
      },
      {
        path: secondPath,
        head: "b".repeat(40),
        branch: null,
        detached: true,
        bare: false,
        lockedReason: "hydra lock",
        prunableReason: "missing working tree",
      },
    ]);
  });

  test("fails closed on malformed, ambiguous, or non-canonical records", () => {
    const worktreePath = path.resolve("arena-parser-invalid");
    const head = "a".repeat(40);
    const cases: readonly {
      readonly label: string;
      readonly value: Buffer | string;
    }[] = [
      { label: "empty", value: "" },
      {
        label: "missing record terminator",
        value: `worktree ${worktreePath}\0HEAD ${head}\0`,
      },
      { label: "field before worktree", value: `HEAD ${head}\0\0` },
      {
        label: "relative worktree",
        value: `worktree relative\0HEAD ${head}\0\0`,
      },
      {
        label: "invalid HEAD",
        value: `worktree ${worktreePath}\0HEAD bad\0\0`,
      },
      {
        label: "duplicate HEAD",
        value: `worktree ${worktreePath}\0HEAD ${head}\0HEAD ${head}\0\0`,
      },
      {
        label: "unknown field",
        value: `worktree ${worktreePath}\0HEAD ${head}\0unknown value\0\0`,
      },
      {
        label: "detached with branch",
        value:
          `worktree ${worktreePath}\0HEAD ${head}\0detached\0branch refs/heads/main\0\0`,
      },
      {
        label: "control in lock reason",
        value: `worktree ${worktreePath}\0HEAD ${head}\0locked bad\nreason\0\0`,
      },
      {
        label: "duplicate path",
        value: porcelainEntry({
          worktreePath,
          head,
          detached: true,
        }) + porcelainEntry({
          worktreePath,
          head,
          detached: true,
        }),
      },
      {
        label: "malformed UTF-8",
        value: Buffer.concat([
          Buffer.from("worktree ", "utf8"),
          Buffer.from([0xff]),
          Buffer.from(`\0HEAD ${head}\0\0`, "utf8"),
        ]),
      },
    ];
    for (const { label, value } of cases) {
      assert.throws(
        () => parseArenaWorktreeListPorcelainZ(value),
        (error: unknown) => error instanceof ArenaGitError,
        label,
      );
    }
  });
});

describe("Arena bounded process runner", () => {
  test("returns bounded output and refuses a pre-aborted command", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-runner-"));
    t.after(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    const successful = await runArenaGitCommand(
      process.execPath,
      root,
      ["-e", "process.stdout.write('arena-ok')"],
      {
        maxStdoutBytes: 64,
        maxStderrBytes: 64,
        timeoutMs: HANG_NET_TIMEOUT_MS,
      },
    );
    assert.equal(successful.stdout.toString("utf8"), "arena-ok");
    assert.equal(successful.stderr.length, 0);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runArenaGitCommand(
        process.execPath,
        root,
        ["-e", "process.stdout.write('must-not-run')"],
        { signal: controller.signal },
      ),
      gitError("gitCancelled"),
    );
  });

  test("terminates a child whose stdout exceeds the configured bound", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-runner-"));
    t.after(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });
    await assert.rejects(
      runArenaGitCommand(
        process.execPath,
        root,
        ["-e", "process.stdout.write('x'.repeat(65536)); setInterval(() => {}, 1000)"],
        {
          maxStdoutBytes: 32,
          maxStderrBytes: 64,
          timeoutMs: HANG_NET_TIMEOUT_MS,
        },
      ),
      process.platform === "win32"
        ? (error: unknown) =>
          error instanceof ArenaGitError
          && error.code === "terminationUnconfirmed"
          && error.cause instanceof ArenaGitError
          && error.cause.code === "gitOutputTooLarge"
        : gitError("gitOutputTooLarge"),
    );
  });

  test("does not settle until a SIGTERM-ignoring descendant is gone", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX process-group semantics");
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-runner-"));
    const pidPath = path.join(root, "descendant.pid");
    let descendantPid: number | undefined;
    t.after(async () => {
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The expected path already proved the descendant is gone.
        }
      }
      await fs.rm(root, { recursive: true, force: true });
    });
    const script = [
      "const cp=require('node:child_process')",
      "const fs=require('node:fs')",
      "const child=cp.spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
      "fs.writeFileSync(process.argv[1],String(child.pid))",
      "setInterval(()=>{},1000)",
    ].join(";");

    await assert.rejects(
      runArenaGitCommand(
        process.execPath,
        root,
        ["-e", script, pidPath],
        {
          maxStdoutBytes: 64,
          maxStderrBytes: 64,
          timeoutMs: 250,
        },
      ),
      gitError("gitTimedOut"),
    );
    descendantPid = Number(await fs.readFile(pidPath, "utf8"));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.throws(
      () => process.kill(descendantPid!, 0),
      (error: unknown) =>
        (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  });

  test("streams bounded stdout to a backpressured sink without retaining it", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-runner-"));
    const outputPath = path.join(root, "evidence.bin");
    const output = await fs.open(outputPath, "wx");
    t.after(async () => {
      await output.close().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    });

    const result = await runArenaGitCommand(
      process.execPath,
      root,
      ["-e", "process.stdout.write(Buffer.alloc(1024*1024, 0x61))"],
      {
        maxStdoutBytes: 1024 * 1024,
        maxStderrBytes: 64,
        timeoutMs: HANG_NET_TIMEOUT_MS,
        stdoutSink: async (chunk) => {
          await output.write(chunk);
        },
      },
    );
    await output.sync();

    assert.equal(result.stdout.byteLength, 0);
    assert.equal((await output.stat()).size, 1024 * 1024);
    assert.deepEqual(
      (await fs.readFile(outputPath)).subarray(0, 4),
      Buffer.from("aaaa"),
    );
  });
});
