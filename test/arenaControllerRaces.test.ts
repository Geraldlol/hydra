import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  after,
  before,
  test,
  type TestContext,
} from "node:test";
import * as vscode from "vscode";
import {
  runArenaController,
  type ArenaControllerProcessContext,
  type ArenaControllerProcessSpec,
} from "../src/arenaController";
import type { ArenaFakeHeadRequest } from "../src/arenaFakeHeadCli";
import {
  ArenaGitExecutor,
  runArenaGitCommand,
  type ArenaGitAdmission,
} from "../src/arenaGit";
import {
  ARENA_POLICY_ID,
  canonicalArenaManifestJson,
  type ArenaRunLockedPayload,
} from "../src/arenaRunManifest";
import {
  arenaContestantArtifactPath,
  openFileArenaManifestStore,
} from "../src/arenaStore";
import {
  arenaProcessEnvironmentPolicySha256,
  arenaProcessFileIdentitySha256,
  sha256ArenaProcessUtf8,
} from "../src/arenaProcessSupervisor";
import { resolveGitExecutable } from "../src/gitExecutable";

const BASE_CONTENT = "Hydra Arena controller race base.\n";
const HEAD_CONTENT = "Hydra Arena controller race result.\n";
const UNTRACKED_CONTENT = "Hydra Arena controller race evidence.\n";
const FIXTURE_PREFIX = "hydra-arena-controller-race-";

const workspace = vscode.workspace as typeof vscode.workspace & {
  isTrusted?: boolean;
};
let originalTrust: PropertyDescriptor | undefined;

before(() => {
  originalTrust = Object.getOwnPropertyDescriptor(workspace, "isTrusted");
  Object.defineProperty(workspace, "isTrusted", {
    configurable: true,
    writable: true,
    value: true,
  });
});

after(() => {
  if (originalTrust) {
    Object.defineProperty(workspace, "isTrusted", originalTrust);
  } else {
    delete (workspace as unknown as { isTrusted?: boolean }).isTrusted;
  }
});

test(
  "a source mutation inside process preparation reaches no provider and retains recovery authority",
  { timeout: 120_000 },
  async (t: TestContext) => {
    const fixture = await createFixture(t, "preparation");
    if (!fixture) return;
    const worktrees = new Map<string, string>();
    let mutation: Promise<void> | undefined;

    await assert.rejects(
      runArenaController({
        runId: fixture.runId,
        workspaceRoot: fixture.sourceRoot,
        privateWorkspaceRoot: fixture.privateRoot,
        repositoryLeaseRoot: fixture.leaseRoot,
        gitResolutionRoot: process.cwd(),
        lock: fixture.lock,
        assertMissionAuthority: () => {},
        createProcess: async (context) => {
          worktrees.set(
            context.contestant.contestantId,
            context.worktree.worktreePath,
          );
          fixture.worktrees.add(context.worktree.worktreePath);
          mutation ??= fs.writeFile(
            path.join(fixture.sourceRoot, "fixture.txt"),
            "Hydra Arena controller race source mutation.\n",
            "utf8",
          );
          await mutation;
          return fixture.processSpec(context, false);
        },
      }),
      /source controls changed during process preparation/i,
    );

    assert.equal(worktrees.size, 2);
    assert.equal(
      await fs.readFile(
        path.join(fixture.sourceRoot, "fixture.txt"),
        "utf8",
      ),
      "Hydra Arena controller race source mutation.\n",
    );
    for (const worktreePath of worktrees.values()) {
      assert.equal(
        await fs.readFile(path.join(worktreePath, "fixture.txt"), "utf8"),
        BASE_CONTENT,
        "no fake head received stdin or edited its tracked fixture",
      );
      await assert.rejects(
        fs.lstat(path.join(worktreePath, "evidence.txt")),
        { code: "ENOENT" },
      );
    }
    assert.deepEqual(
      await listPrivateFiles(path.join(
        fixture.privateRoot,
        "arena",
        "support",
        "dispatch",
        fixture.runId,
      )),
      [],
      "preparation rejection publishes neither intent nor submission receipts",
    );

    const replay = await (
      await openFileArenaManifestStore(fixture.privateRoot)
    ).load(fixture.runId);
    assert.ok(replay);
    assert.equal(replay.finalization, undefined);
    assert.equal(replay.state, "running");
    assert.equal(
      replay.contestants.every((contestant) =>
        contestant.worktreeRegistered !== undefined
        && contestant.started === undefined),
      true,
      "the manifest retains both registered targets without claiming a start",
    );
    const leaseEvents = await readLeaseEvents(fixture.leaseRoot);
    assert.equal(leaseEvents.at(-1)?.type, "claimAcquired");
    assert.equal(
      leaseEvents.some((event) => event.type === "claimReleased"),
      false,
      "an incomplete registered run intentionally retains repository authority",
    );
  },
);

test(
  "a parent Stop during process preparation cancels both heads before dispatch and cleans partial evidence",
  { timeout: 120_000 },
  async (t: TestContext) => {
    const fixture = await createFixture(t, "pre-spawn-stop");
    if (!fixture) return;
    const controller = new AbortController();
    const worktrees = new Map<string, string>();
    let releasePreparation!: () => void;
    const preparationStopped = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const running = runArenaController({
      runId: fixture.runId,
      workspaceRoot: fixture.sourceRoot,
      privateWorkspaceRoot: fixture.privateRoot,
      repositoryLeaseRoot: fixture.leaseRoot,
      gitResolutionRoot: process.cwd(),
      lock: fixture.lock,
      signal: controller.signal,
      assertMissionAuthority: () => {},
      createProcess: async (context) => {
        worktrees.set(
          context.contestant.contestantId,
          context.worktree.worktreePath,
        );
        fixture.worktrees.add(context.worktree.worktreePath);
        if (worktrees.size === fixture.lock.contestants.length) {
          controller.abort(new Error("synthetic pre-spawn local-user Stop"));
          releasePreparation();
        }
        await preparationStopped;
        return fixture.processSpec(context, false);
      },
    });
    const result = await running;

    assert.equal(worktrees.size, 2);
    assert.equal(result.contestantResults.length, 2);
    assert.equal(
      result.contestantResults.every((contestant) =>
        contestant.stage === "beforeDispatch"
        && contestant.traceId === null
        && contestant.status === "cancelled"
        && contestant.failureCode === "cancelled"
        && contestant.terminationConfirmed
        && contestant.submission === null
        && contestant.submissionReceiptSha256 === null
        && contestant.quiescence === null
        && contestant.quiescenceReceiptSha256 === null
        && contestant.quiescenceWorkspaceFingerprintSha256 === null),
      true,
    );
    assert.equal(result.replay.state, "cleanupComplete");
    const finalization = result.replay.finalization?.payload as
      | {
          readonly outcome: string;
          readonly comparison: string;
          readonly reasonCode: string | null;
          readonly evidenceMatrixSha256: string | null;
        }
      | undefined;
    assert.deepEqual(finalization, {
      payloadType: "runFinalized",
      outcome: "cancelled",
      comparison: "incomplete",
      reasonCode: "userCancelled",
      evidenceMatrixSha256: null,
    });
    assert.equal(
      result.replay.contestants.every((contestant) => {
        const evidence = contestant.evidencePreserved?.payload as
          | {
              readonly quiescenceReceiptSha256?: string | null;
              readonly quiescenceWorkspaceFingerprintSha256?: string | null;
              readonly patchBytes?: number;
              readonly untrackedArchiveBytes?: number;
            }
          | undefined;
        return evidence?.quiescenceReceiptSha256 === null
          && evidence.quiescenceWorkspaceFingerprintSha256 === null
          && evidence.patchBytes === 0
          && evidence.untrackedArchiveBytes === 0
          && contestant.cleanup.status === "complete";
      }),
      true,
      "each never-dispatched head retains an explicit partial evidence receipt",
    );

    const dispatchFiles = await listPrivateFiles(path.join(
      fixture.privateRoot,
      "arena",
      "support",
      "dispatch",
      fixture.runId,
    ));
    assert.equal(
      dispatchFiles.filter((file) => file.endsWith("intent.v1.json")).length,
      2,
    );
    assert.equal(
      dispatchFiles.some((file) => file.endsWith("submission.v1.json")),
      false,
    );
    assert.equal(
      dispatchFiles.some((file) => file.endsWith("quiescence.v1.json")),
      false,
    );
    for (const contestant of fixture.lock.contestants) {
      const artifactDirectory = arenaContestantArtifactPath(
        fixture.privateRoot,
        fixture.runId,
        contestant.contestantId,
      );
      assert.deepEqual(
        (await fs.readdir(artifactDirectory)).sort(),
        [
          "artifact-set.v1.json",
          "inventory.v1.json",
          "patch.bin",
        ],
      );
      assert.equal(
        (await fs.lstat(path.join(artifactDirectory, "patch.bin"))).size,
        0,
      );
      const worktreePath = worktrees.get(contestant.contestantId);
      assert.ok(worktreePath);
      await assert.rejects(fs.lstat(worktreePath), { code: "ENOENT" });
    }
    assert.equal(
      await fs.readFile(
        path.join(fixture.sourceRoot, "fixture.txt"),
        "utf8",
      ),
      BASE_CONTENT,
    );
    await assert.rejects(
      fs.lstat(path.join(fixture.sourceRoot, "evidence.txt")),
      { code: "ENOENT" },
    );
    const leaseEvents = await readLeaseEvents(fixture.leaseRoot);
    assert.equal(leaseEvents.at(-1)?.type, "claimReleased");
    assert.equal(
      (leaseEvents.at(-1)?.payload as { readonly runId?: string }).runId,
      fixture.runId,
    );
  },
);

test(
  "a Stop with one submitted head drains the later queued head before dispatch",
  { timeout: 120_000 },
  async (t: TestContext) => {
    const fixture = await createFixture(t, "mixed-queue-stop");
    if (!fixture) return;
    const controller = new AbortController();
    const worktrees = new Map<string, string>();
    let releaseLaterHead!: () => void;
    const laterHeadReleased = new Promise<void>((resolve) => {
      releaseLaterHead = resolve;
    });
    let laterHeadBlocked = false;
    const running = runArenaController({
      runId: fixture.runId,
      workspaceRoot: fixture.sourceRoot,
      privateWorkspaceRoot: fixture.privateRoot,
      repositoryLeaseRoot: fixture.leaseRoot,
      gitResolutionRoot: process.cwd(),
      lock: fixture.lock,
      signal: controller.signal,
      assertMissionAuthority: async () => {
        const receiptFiles = await listPrivateFiles(path.join(
          fixture.privateRoot,
          "arena",
          "support",
          "dispatch",
          fixture.runId,
        ));
        const submissions = receiptFiles.filter((file) =>
          file.endsWith("submission.v1.json")).length;
        if (submissions === 1 && !laterHeadBlocked) {
          laterHeadBlocked = true;
          await laterHeadReleased;
        }
      },
      createProcess: (context) => {
        worktrees.set(
          context.contestant.contestantId,
          context.worktree.worktreePath,
        );
        fixture.worktrees.add(context.worktree.worktreePath);
        return fixture.processSpec(context, true);
      },
    });

    let earlyFailure: unknown;
    void running.catch((error: unknown) => {
      earlyFailure = error;
    });
    try {
      await waitFor(async () => {
        if (earlyFailure !== undefined) throw earlyFailure;
        return laterHeadBlocked;
      }, "exactly one durable Arena submission");
    } catch (error) {
      controller.abort(error);
      releaseLaterHead();
      await running.catch(() => undefined);
      throw error;
    }
    controller.abort(new Error("synthetic mixed-queue local-user Stop"));
    releaseLaterHead();
    const result = await running;

    assert.equal(laterHeadBlocked, true);
    assert.equal(worktrees.size, 2);
    assert.equal(result.contestantResults.length, 2);
    const executed = result.contestantResults.filter((contestant) =>
      contestant.stage === "execution");
    const queued = result.contestantResults.filter((contestant) =>
      contestant.stage === "beforeDispatch");
    assert.equal(executed.length, 1);
    assert.equal(queued.length, 1);
    assert.equal(executed[0]?.status, "cancelled");
    assert.equal(executed[0]?.failureCode, "cancelled");
    assert.equal(executed[0]?.terminationConfirmed, true);
    assert.notEqual(executed[0]?.submissionReceiptSha256, null);
    assert.notEqual(executed[0]?.quiescenceReceiptSha256, null);
    assert.notEqual(
      executed[0]?.quiescenceWorkspaceFingerprintSha256,
      null,
    );
    assert.equal(queued[0]?.status, "cancelled");
    assert.equal(queued[0]?.failureCode, "cancelled");
    assert.equal(queued[0]?.terminationConfirmed, true);
    assert.equal(queued[0]?.traceId, null);
    assert.equal(queued[0]?.submission, null);
    assert.equal(queued[0]?.submissionReceiptSha256, null);
    assert.equal(queued[0]?.quiescence, null);
    assert.equal(queued[0]?.quiescenceReceiptSha256, null);
    assert.equal(
      queued[0]?.quiescenceWorkspaceFingerprintSha256,
      null,
    );

    assert.equal(result.replay.state, "cleanupComplete");
    const finalization = result.replay.finalization?.payload as
      | {
          readonly outcome: string;
          readonly comparison: string;
          readonly reasonCode: string | null;
          readonly evidenceMatrixSha256: string | null;
        }
      | undefined;
    assert.deepEqual(finalization, {
      payloadType: "runFinalized",
      outcome: "cancelled",
      comparison: "incomplete",
      reasonCode: "userCancelled",
      evidenceMatrixSha256: null,
    });
    assert.equal(
      result.replay.contestants.every((contestant) =>
        contestant.evidencePreserved !== undefined
        && contestant.cleanup.status === "complete"),
      true,
    );
    const replayStarted = result.replay.contestants.filter((contestant) =>
      contestant.started !== undefined);
    assert.equal(replayStarted.length, 1);
    assert.equal(replayStarted[0]?.lock.contestantId, executed[0]?.contestantId);

    const dispatchFiles = await listPrivateFiles(path.join(
      fixture.privateRoot,
      "arena",
      "support",
      "dispatch",
      fixture.runId,
    ));
    assert.equal(
      dispatchFiles.filter((file) => file.endsWith("intent.v1.json")).length,
      2,
    );
    assert.equal(
      dispatchFiles.filter((file) =>
        file.endsWith("submission.v1.json")).length,
      1,
    );
    assert.equal(
      dispatchFiles.filter((file) =>
        file.endsWith("quiescence.v1.json")).length,
      1,
    );
    for (const contestant of fixture.lock.contestants) {
      const artifactDirectory = arenaContestantArtifactPath(
        fixture.privateRoot,
        fixture.runId,
        contestant.contestantId,
      );
      assert.equal(
        (await fs.readdir(artifactDirectory)).includes(
          "artifact-set.v1.json",
        ),
        true,
      );
      const worktreePath = worktrees.get(contestant.contestantId);
      assert.ok(worktreePath);
      await assert.rejects(fs.lstat(worktreePath), { code: "ENOENT" });
    }
    assert.equal(
      await fs.readFile(
        path.join(fixture.sourceRoot, "fixture.txt"),
        "utf8",
      ),
      BASE_CONTENT,
    );
    await assert.rejects(
      fs.lstat(path.join(fixture.sourceRoot, "evidence.txt")),
      { code: "ENOENT" },
    );
    const leaseEvents = await readLeaseEvents(fixture.leaseRoot);
    assert.equal(leaseEvents.at(-1)?.type, "claimReleased");
    assert.equal(
      (leaseEvents.at(-1)?.payload as { readonly runId?: string }).runId,
      fixture.runId,
    );
  },
);

test(
  "aborting after both hanging heads edit yields quiescent evidence-bound cancellation and exact cleanup",
  { timeout: 120_000 },
  async (t: TestContext) => {
    const fixture = await createFixture(t, "cancel");
    if (!fixture) return;
    const controller = new AbortController();
    const worktrees = new Map<string, string>();
    const running = runArenaController({
      runId: fixture.runId,
      workspaceRoot: fixture.sourceRoot,
      privateWorkspaceRoot: fixture.privateRoot,
      repositoryLeaseRoot: fixture.leaseRoot,
      gitResolutionRoot: process.cwd(),
      lock: fixture.lock,
      signal: controller.signal,
      assertMissionAuthority: () => {},
      createProcess: (context) => {
        worktrees.set(
          context.contestant.contestantId,
          context.worktree.worktreePath,
        );
        fixture.worktrees.add(context.worktree.worktreePath);
        return fixture.processSpec(context, true);
      },
    });

    await waitFor(async () => {
      if (worktrees.size !== 2) return false;
      return (
        await Promise.all([...worktrees.values()].map(async (worktreePath) =>
          await readIfPresent(path.join(worktreePath, "fixture.txt"))
            === HEAD_CONTENT
          && await readIfPresent(path.join(worktreePath, "evidence.txt"))
            === UNTRACKED_CONTENT))
      ).every(Boolean);
    }, "both fake heads to receive stdin and finish their edits");
    controller.abort(new Error("synthetic local-user Stop"));
    const result = await running;

    assert.equal(result.contestantResults.length, 2);
    assert.equal(
      result.contestantResults.every((contestant) =>
        contestant.status === "cancelled"
        && contestant.failureCode === "cancelled"
        && contestant.terminationConfirmed
        && contestant.submissionReceiptSha256 !== null
        && contestant.quiescenceReceiptSha256 !== null
        && contestant.quiescenceWorkspaceFingerprintSha256 !== null),
      true,
    );
    assert.equal(result.replay.state, "cleanupComplete");
    const finalization = result.replay.finalization?.payload as
      | {
          readonly outcome: string;
          readonly comparison: string;
          readonly reasonCode: string | null;
          readonly evidenceMatrixSha256: string | null;
        }
      | undefined;
    assert.deepEqual(finalization, {
      payloadType: "runFinalized",
      outcome: "cancelled",
      comparison: "incomplete",
      reasonCode: "userCancelled",
      evidenceMatrixSha256: null,
    });
    assert.equal(
      result.replay.contestants.every((contestant) =>
        contestant.evidencePreserved !== undefined
        && contestant.cleanup.status === "complete"),
      true,
    );

    for (const contestant of fixture.lock.contestants) {
      const artifactDirectory = arenaContestantArtifactPath(
        fixture.privateRoot,
        fixture.runId,
        contestant.contestantId,
      );
      assert.deepEqual(
        (await fs.readdir(artifactDirectory)).sort(),
        [
          "artifact-set.v1.json",
          "inventory.v1.json",
          "patch.bin",
          "untracked.v1.bin",
        ],
      );
      const worktreePath = worktrees.get(contestant.contestantId);
      assert.ok(worktreePath);
      await assert.rejects(fs.lstat(worktreePath), { code: "ENOENT" });
    }
    const dispatchFiles = await listPrivateFiles(path.join(
      fixture.privateRoot,
      "arena",
      "support",
      "dispatch",
      fixture.runId,
    ));
    assert.equal(
      dispatchFiles.filter((file) => file.endsWith("intent.v1.json")).length,
      2,
    );
    assert.equal(
      dispatchFiles.filter((file) =>
        file.endsWith("submission.v1.json")).length,
      2,
    );
    assert.equal(
      dispatchFiles.filter((file) =>
        file.endsWith("quiescence.v1.json")).length,
      2,
    );
    assert.equal(
      await fs.readFile(
        path.join(fixture.sourceRoot, "fixture.txt"),
        "utf8",
      ),
      BASE_CONTENT,
    );
    await assert.rejects(
      fs.lstat(path.join(fixture.sourceRoot, "evidence.txt")),
      { code: "ENOENT" },
    );
    const leaseEvents = await readLeaseEvents(fixture.leaseRoot);
    assert.equal(leaseEvents.at(-1)?.type, "claimReleased");
    assert.equal(
      (leaseEvents.at(-1)?.payload as { readonly runId?: string }).runId,
      fixture.runId,
    );
  },
);

interface ControllerFixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly privateRoot: string;
  readonly leaseRoot: string;
  readonly git: string;
  readonly runId: string;
  readonly lock: ArenaRunLockedPayload;
  readonly worktrees: Set<string>;
  processSpec(
    context: ArenaControllerProcessContext,
    hang: boolean,
  ): ArenaControllerProcessSpec;
}

async function createFixture(
  t: TestContext,
  label: string,
): Promise<ControllerFixture | undefined> {
  const git = await resolveGitExecutable(process.cwd());
  if (!git) {
    t.skip("native Git is unavailable");
    return undefined;
  }
  const tempParent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempParent, FIXTURE_PREFIX));
  const sourceRoot = path.join(root, "source");
  const privateRoot = path.join(root, "private");
  const leaseRoot = path.join(root, "lease");
  const worktrees = new Set<string>();
  t.after(async () => {
    await removeFixtureExactly({
      tempParent,
      root,
      sourceRoot,
      privateRoot,
      git,
      worktrees,
    });
  });
  await fs.mkdir(sourceRoot);
  await initializeRepository(git, sourceRoot);
  const inspector = await ArenaGitExecutor.open(
    sourceRoot,
    privateRoot,
    leaseRoot,
    process.cwd(),
  );
  const admission = await inspector.inspectAdmission();
  const runId = `race-${label}-${randomUUID()}`;
  const lock = raceLock(runId, admission);
  const fakeHelper = path.resolve(
    __dirname,
    "..",
    "src",
    "arenaFakeHeadCli.js",
  );
  const fakeHelperIdentitySha256 =
    await arenaProcessFileIdentitySha256(fakeHelper);

  return {
    root,
    sourceRoot,
    privateRoot,
    leaseRoot,
    git,
    runId,
    lock,
    worktrees,
    processSpec(context, hang) {
      const input = "Identical controller race input.";
      const request: ArenaFakeHeadRequest = {
        schemaVersion: 1,
        requestType: "arenaFakeHead",
        runId,
        contestantId: context.contestant.contestantId,
        traceId: context.traceId,
        registrationSha256: context.worktree.registrationSha256,
        processGenerationId: context.processGenerationId,
        input,
        inputSha256: sha256ArenaProcessUtf8(input),
        fixtureRelativePath: "fixture.txt",
        fixtureContent: HEAD_CONTENT,
        untrackedRelativePath: "evidence.txt",
        untrackedContent: UNTRACKED_CONTENT,
        delayMs: 0,
        exitCode: 0,
        hang,
      };
      return {
        command: path.resolve(process.execPath),
        args: [fakeHelper],
        stdin: `${canonicalArenaManifestJson(request)}\n`,
        contextSha256: digest(
          `${runId}:${context.contestant.contestantId}:context`,
        ),
        timeoutMs: 30_000,
        bundledHelper: {
          scriptPath: fakeHelper,
          scriptFileIdentitySha256: fakeHelperIdentitySha256,
        },
      };
    },
  };
}

function raceLock(
  runId: string,
  admission: ArenaGitAdmission,
): ArenaRunLockedPayload {
  return {
    payloadType: "runLocked",
    policy: ARENA_POLICY_ID,
    mission: {
      missionId: `${runId}-mission`,
      revision: 1,
      documentSha256: digest(`${runId}:mission-document`),
      bindingSha256: digest(`${runId}:mission-binding`),
    },
    base: {
      revision: admission.baseRevision,
      repositoryIdentitySha256: admission.repositoryIdentitySha256,
      baseContentSha256: admission.baseContentSha256,
      sourceWorkspaceFingerprintSha256:
        admission.sourceWorkspaceFingerprintSha256,
      repositoryControlSha256: admission.repositoryControlSha256,
    },
    inputBundleSha256: digest(`${runId}:input`),
    preparationPlanSha256: null,
    environmentPolicySha256:
      arenaProcessEnvironmentPolicySha256(process.env, true),
    budgetSha256: digest(`${runId}:budget`),
    verificationChecks: [],
    browserJourneys: [],
    contestants: ["codex", "claude"].map((contestantId) => ({
      contestantId,
      headId: contestantId,
      agentKind: contestantId,
      headConfigSha256: digest(`${runId}:${contestantId}:config`),
      authoritySha256: digest(`${runId}:${contestantId}:authority`),
      invocationSha256: digest(`${runId}:${contestantId}:invocation`),
      worktreeId: `${contestantId}-worktree`,
    })),
    steering: "disabled",
    confirmation: {
      actorId: "local-user",
      action: "Confirm Arena Run",
      confirmationId: `${runId}-confirmation`,
    },
  };
}

async function initializeRepository(
  git: string,
  sourceRoot: string,
): Promise<void> {
  await runGit(git, sourceRoot, [
    "init",
    "--quiet",
    "--initial-branch=main",
  ]);
  await runGit(git, sourceRoot, [
    "config",
    "--local",
    "user.name",
    "Hydra Arena Controller Race",
  ]);
  await runGit(git, sourceRoot, [
    "config",
    "--local",
    "user.email",
    "arena-controller-race@invalid.local",
  ]);
  await fs.writeFile(
    path.join(sourceRoot, "fixture.txt"),
    BASE_CONTENT,
    "utf8",
  );
  await runGit(git, sourceRoot, ["add", "--", "fixture.txt"]);
  await runGit(
    git,
    sourceRoot,
    ["commit", "--quiet", "-m", "Arena controller race base"],
  );
}

async function runGit(
  git: string,
  cwd: string,
  args: readonly string[],
): Promise<void> {
  await runArenaGitCommand(
    git,
    cwd,
    [
      "--no-pager",
      "--no-optional-locks",
      "--no-replace-objects",
      "--no-lazy-fetch",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      ...args,
    ],
    { timeoutMs: 30_000 },
  );
}

async function listPrivateFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string, relative: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const childRelative = relative
        ? path.join(relative, entry.name)
        : entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(absolute, childRelative);
      } else {
        assert.equal(entry.isFile(), true);
        assert.equal(entry.isSymbolicLink(), false);
        files.push(childRelative);
      }
    }
  };
  await visit(root, "");
  return files.sort();
}

async function readLeaseEvents(
  leaseRoot: string,
): Promise<readonly {
  readonly type: string;
  readonly payload: unknown;
}[]> {
  const entries = await fs.readdir(leaseRoot);
  const ledgers = entries.filter((entry) =>
    entry.endsWith(".owner.v1.jsonl"));
  assert.equal(ledgers.length, 1);
  const body = await fs.readFile(path.join(leaseRoot, ledgers[0]!), "utf8");
  return body.trimEnd().split("\n").map((line) =>
    JSON.parse(line) as { readonly type: string; readonly payload: unknown });
}

async function waitFor(
  predicate: () => Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function removeFixtureExactly(input: {
  readonly tempParent: string;
  readonly root: string;
  readonly sourceRoot: string;
  readonly privateRoot: string;
  readonly git: string;
  readonly worktrees: ReadonlySet<string>;
}): Promise<void> {
  for (const worktreePath of input.worktrees) {
    let stat;
    try {
      stat = await fs.lstat(worktreePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const expectedParent = path.join(
      input.privateRoot,
      "arena",
      "worktrees",
      "p",
    );
    assert.equal(path.dirname(worktreePath), expectedParent);
    assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true);
    assert.equal(await fs.realpath(worktreePath), worktreePath);
    await runGit(input.git, input.sourceRoot, [
      "worktree",
      "remove",
      "--force",
      "--force",
      worktreePath,
    ]);
    await assert.rejects(fs.lstat(worktreePath), { code: "ENOENT" });
  }
  await runGit(input.git, input.sourceRoot, [
    "worktree",
    "prune",
    "--expire=now",
  ]);

  const absoluteRoot = path.resolve(input.root);
  assert.equal(path.dirname(absoluteRoot), input.tempParent);
  assert.equal(path.basename(absoluteRoot).startsWith(FIXTURE_PREFIX), true);
  const stat = await fs.lstat(absoluteRoot);
  assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true);
  assert.equal(await fs.realpath(absoluteRoot), absoluteRoot);
  await fs.rm(absoluteRoot, {
    recursive: true,
    force: false,
    maxRetries: 20,
    retryDelay: 100,
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
