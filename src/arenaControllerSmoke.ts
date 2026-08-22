import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runArenaController } from "./arenaController";
import { type ArenaFakeHeadRequest } from "./arenaFakeHeadCli";
import { ArenaGitExecutor, runArenaGitCommand } from "./arenaGit";
import {
  prepareArenaPrivateStorage,
  type ArenaPrivateStorageBoundary,
} from "./arenaPrivateStorage";
import {
  ARENA_POLICY_ID,
  canonicalArenaManifestJson,
  type ArenaRunLockedPayload,
} from "./arenaRunManifest";
import {
  prepareArenaRepositoryLeaseRoot,
  type ArenaRepositoryLeaseBoundary,
} from "./arenaRepositoryLease";
import {
  arenaProcessEnvironmentPolicySha256,
  arenaProcessFileIdentitySha256,
  sha256ArenaProcessUtf8,
} from "./arenaProcessSupervisor";
import { resolveGitExecutable } from "./gitExecutable";

export interface ArenaControllerSmokeReport {
  readonly passed: boolean;
  readonly manifestEvents: number;
  readonly contestants: number;
  readonly comparable: boolean;
  readonly cleanupComplete: boolean;
  readonly sourceUnchanged: boolean;
  readonly fakeHeadsSupervised: boolean;
}

export async function runArenaControllerSmokeTest(options: {
  readonly privateWorkspaceRoot: string;
  readonly repositoryLeaseRoot: string;
  readonly gitResolutionRoot: string;
  readonly signal?: AbortSignal;
}): Promise<ArenaControllerSmokeReport> {
  if (options.signal?.aborted) {
    throw new Error("Arena controller smoke was cancelled before setup.");
  }
  const tempRoot = await fs.realpath(os.tmpdir());
  const sourceParent = await fs.mkdtemp(
    path.join(tempRoot, "hydra-arena-controller-source-"),
  );
  const sourceRoot = path.join(sourceParent, "source");
  let privateBoundary: ArenaPrivateStorageBoundary | undefined;
  let leaseBoundary: ArenaRepositoryLeaseBoundary | undefined;
  let privateRoot = "";
  let leaseRoot = "";
  let controllerStarted = false;
  let cleanupAuthorized = false;
  try {
    await fs.mkdir(sourceRoot);
    privateBoundary = await prepareArenaPrivateStorage(
      options.privateWorkspaceRoot,
    );
    privateRoot = await fs.mkdtemp(
      path.join(privateBoundary.realPrivateWorkspaceRoot, "c-"),
    );
    leaseBoundary = await prepareArenaRepositoryLeaseRoot(
      options.repositoryLeaseRoot,
    );
    leaseRoot = await fs.mkdtemp(path.join(leaseBoundary.realRoot, "c-"));
    const git = await resolveGitExecutable(options.gitResolutionRoot);
    if (!git) throw new Error("Arena controller smoke could not resolve Git.");
    await initializeRepository(git, sourceRoot, options.signal);

    const inspector = await ArenaGitExecutor.open(
      sourceRoot,
      privateRoot,
      leaseRoot,
      options.gitResolutionRoot,
    );
    const admission = await inspector.inspectAdmission(options.signal);
    const runId = `controller-smoke-${randomUUID()}`;
    const lock = smokeLock(runId, admission);
    const fakeHelper = path.resolve(__dirname, "arenaFakeHeadCli.js");
    const fakeHelperIdentitySha256 =
      await arenaProcessFileIdentitySha256(fakeHelper);
    controllerStarted = true;
    const result = await runArenaController({
      runId,
      workspaceRoot: sourceRoot,
      privateWorkspaceRoot: privateRoot,
      repositoryLeaseRoot: leaseRoot,
      gitResolutionRoot: options.gitResolutionRoot,
      lock,
      signal: options.signal,
      assertMissionAuthority: (mission) => {
        if (mission.bindingSha256 !== lock.mission.bindingSha256) {
          throw new Error("Arena controller smoke Mission binding changed.");
        }
      },
      createProcess: (context) => {
        const input = "Identical locked Arena smoke input.";
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
          fixtureContent: "Arena stage-3 supervised result.\n",
          untrackedRelativePath: "evidence.txt",
          untrackedContent: "Arena stage-3 untracked evidence.\n",
          delayMs: 5,
          exitCode: 0,
          hang: false,
        };
        return {
          command: path.resolve(process.execPath),
          args: [fakeHelper],
          stdin: `${canonicalArenaManifestJson(request)}\n`,
          contextSha256: digest(
            `${runId}:${context.contestant.contestantId}:context`,
          ),
          timeoutMs: 15_000,
          bundledHelper: {
            scriptPath: fakeHelper,
            scriptFileIdentitySha256: fakeHelperIdentitySha256,
          },
        };
      },
    });
    const sourceContent = await fs.readFile(
      path.join(sourceRoot, "fixture.txt"),
      "utf8",
    );
    const comparable = result.replay.finalization !== undefined
      && (result.replay.finalization.payload as {
        readonly comparison?: string;
      }).comparison === "comparable";
    const cleanupComplete = result.replay.state === "cleanupComplete";
    const sourceUnchanged =
      sourceContent === "Hydra Arena controller smoke base.\n";
    const fakeHeadsSupervised = result.contestantResults.length === 2
      && result.contestantResults.every((candidate) =>
        candidate.status === "succeeded"
        && candidate.terminationConfirmed
        && candidate.submissionReceiptSha256 !== null
        && candidate.quiescenceReceiptSha256 !== null);
    const report = {
      passed: comparable
        && cleanupComplete
        && sourceUnchanged
        && fakeHeadsSupervised,
      manifestEvents: result.replay.records.length,
      contestants: result.replay.contestants.length,
      comparable,
      cleanupComplete,
      sourceUnchanged,
      fakeHeadsSupervised,
    };
    cleanupAuthorized = result.replay.state === "cleanupComplete";
    return Object.freeze(report);
  } finally {
    // If dispatch became ambiguous or cleanup did not replay completely,
    // preserve every root. Removing the source repository could destroy the
    // Git common directory still needed to authenticate retained worktrees.
    const mayRemove = !controllerStarted || cleanupAuthorized;
    if (sourceParent && mayRemove) {
      await removeExactTemporaryDirectory(
        sourceParent,
        tempRoot,
        "hydra-arena-controller-source-",
      );
    }
    if (privateRoot && privateBoundary && mayRemove) {
      await removeExactTemporaryDirectory(
        privateRoot,
        privateBoundary.realPrivateWorkspaceRoot,
        "c-",
      );
    }
    if (leaseRoot && leaseBoundary && mayRemove) {
      await removeExactTemporaryDirectory(
        leaseRoot,
        leaseBoundary.realRoot,
        "c-",
      );
    }
  }
}

function smokeLock(
  runId: string,
  admission: Awaited<ReturnType<ArenaGitExecutor["inspectAdmission"]>>,
): ArenaRunLockedPayload {
  const contestants = ["codex", "claude"] as const;
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
    contestants: contestants.map((contestantId) => ({
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
  signal?: AbortSignal,
): Promise<void> {
  await runGit(git, sourceRoot, [
    "init",
    "--quiet",
    "--initial-branch=main",
  ], signal);
  await runGit(git, sourceRoot, [
    "config",
    "--local",
    "user.name",
    "Hydra Arena Controller Smoke",
  ], signal);
  await runGit(git, sourceRoot, [
    "config",
    "--local",
    "user.email",
    "arena-controller-smoke@invalid.local",
  ], signal);
  await fs.writeFile(
    path.join(sourceRoot, "fixture.txt"),
    "Hydra Arena controller smoke base.\n",
    { encoding: "utf8", mode: 0o600 },
  );
  await runGit(git, sourceRoot, ["add", "--", "fixture.txt"], signal);
  await runGit(
    git,
    sourceRoot,
    ["commit", "--quiet", "-m", "Arena controller smoke base"],
    signal,
  );
}

async function runGit(
  git: string,
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
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
    { timeoutMs: 30_000, signal },
  );
}

async function removeExactTemporaryDirectory(
  target: string,
  expectedParent: string,
  prefix: string,
): Promise<void> {
  const absoluteTarget = path.resolve(target);
  const realParent = await fs.realpath(expectedParent);
  if (path.dirname(absoluteTarget) !== path.resolve(expectedParent)
    || !path.basename(absoluteTarget).startsWith(prefix)) {
    throw new Error("Arena controller smoke cleanup target is outside its root.");
  }
  let stat;
  try {
    stat = await fs.lstat(absoluteTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || path.dirname(await fs.realpath(absoluteTarget)) !== realParent) {
    throw new Error("Arena controller smoke cleanup target changed identity.");
  }
  await fs.rm(absoluteTarget, {
    recursive: true,
    force: false,
    maxRetries: 20,
    retryDelay: 100,
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
