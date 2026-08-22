import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ArenaGitError,
  ArenaGitExecutor,
  type ArenaOwnedWorktree,
  type ArenaProvisionedWorktree,
  runArenaGitCommand,
} from "./arenaGit";
import {
  ARENA_CLEANUP_STEPS,
  arenaCleanupPostconditionSha256,
  arenaCleanupStepReceiptSha256,
  type ArenaCleanupPostcondition,
  type ArenaCleanupStep,
  type ArenaCleanupStepPayload,
} from "./arenaCleanup";
import {
  assertArenaPrivateBoundary,
  assertArenaPrivateDirectory,
  createArenaPrivateFile,
  ensureArenaPrivateDirectory,
  prepareArenaPrivateStorage,
  type ArenaPrivateStorageBoundary,
} from "./arenaPrivateStorage";
import {
  arenaContestantArtifactPath,
  arenaContestantWorktreePath,
  openFileArenaManifestStore,
} from "./arenaStore";
import {
  ARENA_POLICY_ID,
  arenaArtifactSetSha256,
  arenaReceiptsRootSha256,
  type ArenaContestantFinishedPayload,
  type ArenaEvidencePreservedPayload,
  type ArenaGitObjectId,
  type ArenaManifestEvent,
  type ArenaRunLockedPayload,
  type ArenaWorktreeProvisionedPayload,
} from "./arenaRunManifest";
import { resolveGitExecutable } from "./gitExecutable";
import {
  assertArenaRepositoryLeaseBoundary,
  prepareArenaRepositoryLeaseRoot,
  type ArenaRepositoryLeaseBoundary,
} from "./arenaRepositoryLease";
import { runArenaControllerSmokeTest } from "./arenaControllerSmoke";

export const ARENA_SMOKE_SCHEMA_VERSION = 1 as const;

export type ArenaSmokeProgressStage =
  | "setup"
  | "repositoryInitialized"
  | "executorOpened"
  | "admitted"
  | "claimed"
  | "worktreesPlanned"
  | "firstWorktreeProvisioned"
  | "secondWorktreeProvisioned"
  | "worktreesProvisioned"
  | "registrationsReconciled"
  | "manifestFinalized"
  | "cleanupComplete"
  | "claimReleased"
  | "controllerSmokeStarted"
  | "controllerSmokeFinished"
  | "failed"
  | "finalCleanupStarted"
  | "provisionedCleanupFinished"
  | "claimAbandoned"
  | "unrelatedWorktreeRemoved"
  | "sourceStorageRemoved"
  | "privateStorageRemoved"
  | "leaseStorageRemoved"
  | "finalCleanupFinished";

export interface ArenaSmokeCheck {
  readonly id:
    | "admission"
    | "intentBeforeSideEffect"
    | "identicalDetachedWorktrees"
    | "durableRegistration"
    | "manifestReplay"
    | "exactCleanup"
    | "sourceUnchanged"
    | "unrelatedWorktreePreserved"
    | "supervisedHeadDispatch"
    | "continuousMainTreeMonitor"
    | "evidenceMatrix";
  readonly passed: boolean;
}

export interface ArenaSmokeReport {
  readonly schemaVersion: typeof ARENA_SMOKE_SCHEMA_VERSION;
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly passed: boolean;
  readonly checks: readonly ArenaSmokeCheck[];
  readonly observed: {
    readonly contestants: number;
    readonly manifestEvents: number;
    readonly cleanupState: "cleanupComplete" | "incomplete";
    readonly sourceHead: string;
  };
}

interface SmokeContestant {
  readonly contestantId: string;
  readonly worktreeId: string;
  readonly headId: "codex" | "claude";
}

const CONTESTANTS: readonly SmokeContestant[] = Object.freeze([
  {
    contestantId: "smoke-codex",
    worktreeId: "smoke-worktree-codex",
    headId: "codex",
  },
  {
    contestantId: "smoke-claude",
    worktreeId: "smoke-worktree-claude",
    headId: "claude",
  },
]);

export async function runArenaSmokeTest(options: {
  readonly privateWorkspaceRoot: string;
  readonly repositoryLeaseRoot: string;
  readonly gitResolutionRoot: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (
    stage: ArenaSmokeProgressStage,
  ) => void | Promise<void>;
}): Promise<ArenaSmokeReport> {
  if (!path.isAbsolute(options.privateWorkspaceRoot)
    || !path.isAbsolute(options.repositoryLeaseRoot)
    || !path.isAbsolute(options.gitResolutionRoot)) {
    throw new Error("Arena smoke storage and resolution roots must be absolute.");
  }
  const startedAt = new Date().toISOString();
  const runId = `arena-smoke-${randomUUID()}`;
  let tempParent = "";
  let sourceContainer = "";
  let sourceRoot = "";
  let unrelatedPath = "";
  let outerBoundary: ArenaPrivateStorageBoundary | undefined;
  let realSmokeParent = "";
  let privateRoot = "";
  let leaseParentBoundary: ArenaRepositoryLeaseBoundary | undefined;
  let smokeLeaseRoot = "";
  let recoveryCatalogPath = "";
  const checks = new Map<ArenaSmokeCheck["id"], boolean>();
  const provisioned: ArenaProvisionedWorktree[] = [];
  let executor: ArenaGitExecutor | undefined;
  let gitExecutable: string | undefined;
  let manifestEvents = 0;
  let cleanupState: ArenaSmokeReport["observed"]["cleanupState"] =
    "incomplete";
  let sourceHead = "";
  let repositoryClaimActive = false;
  let primaryFailure: unknown;

  try {
    if (options.signal?.aborted) {
      throw new Error("Arena smoke test was cancelled before setup.");
    }
    tempParent = await fs.realpath(os.tmpdir());
    sourceContainer = await fs.mkdtemp(
      path.join(tempParent, "hydra-arena-smoke-source-"),
    );
    sourceRoot = path.join(sourceContainer, "source");
    unrelatedPath = path.join(sourceContainer, "unrelated");
    outerBoundary = await prepareArenaPrivateStorage(
      options.privateWorkspaceRoot,
    );
    await ensureArenaPrivateDirectory(
      outerBoundary,
      ["support", "smoke"],
    );
    // Keep the physical Git worktree path comfortably below Git for
    // Windows' internal GIT_DIR limit. The caller supplies a short,
    // workspace-keyed extension-global root; nesting the synthetic run under
    // arena/support/smoke would consume most of that path budget before the
    // run and contestant identifiers are appended.
    realSmokeParent = outerBoundary.realPrivateWorkspaceRoot;
    privateRoot = await fs.mkdtemp(
      path.join(realSmokeParent, "s-"),
    );
    leaseParentBoundary = await prepareArenaRepositoryLeaseRoot(
      options.repositoryLeaseRoot,
    );
    smokeLeaseRoot = await fs.mkdtemp(path.join(
      leaseParentBoundary.realRoot,
      "hydra-arena-smoke-lease-",
    ));
    recoveryCatalogPath = await recordSmokeRecovery({
      boundary: outerBoundary,
      runId,
      sourceContainer,
      privateRoot,
      repositoryLeaseRoot: smokeLeaseRoot,
    });
    await options.onProgress?.("setup");
    await fs.mkdir(sourceRoot, { mode: 0o700 });
    gitExecutable = await resolveGitExecutable(options.gitResolutionRoot);
    if (!gitExecutable) {
      throw new Error("Arena smoke could not resolve trusted native Git.");
    }
    await initializeSmokeRepository(
      gitExecutable,
      sourceRoot,
      options.signal,
    );
    await runSmokeGit(gitExecutable, sourceRoot, [
      "worktree",
      "add",
      "--detach",
      "--no-relative-paths",
      "--",
      unrelatedPath,
      "HEAD",
    ], [0], options.signal);
    await options.onProgress?.("repositoryInitialized");

    executor = await ArenaGitExecutor.open(
      sourceRoot,
      privateRoot,
      smokeLeaseRoot,
      options.gitResolutionRoot,
    );
    await options.onProgress?.("executorOpened");
    const admission = await executor.inspectAdmission();
    await options.onProgress?.("admitted");
    sourceHead = admission.baseRevision.oid;
    checks.set("admission", admission.worktrees.some((entry) =>
      samePath(entry.path, unrelatedPath)));

    const store = await openFileArenaManifestStore(privateRoot);
    const lock = smokeLock(admission, runId);
    const lockEvent = await store.append({
      eventId: `${runId}-lock`,
      runId,
      occurredAt: new Date().toISOString(),
      type: "arenaRunLocked",
      payload: lock,
    });
    const claim = await executor.claimRepositoryRun(runId, admission);
    if (claim.status !== "active"
      || claim.claimSha256.length !== 64
      || lockEvent.eventSha256.length !== 64) {
      throw new Error("Arena smoke could not establish the exact run claim.");
    }
    repositoryClaimActive = true;
    await options.onProgress?.("claimed");
    await store.append({
      eventId: `${runId}-monitor`,
      runId,
      occurredAt: new Date().toISOString(),
      type: "arenaMainWorkspaceObserved",
      payload: {
        payloadType: "mainWorkspaceObserved",
        observationKind: "monitorStarted",
        monitorEpochId: `${runId}-monitor`,
        monitorReceiptSha256: digest(`${runId}:monitor`),
        status: "unchanged",
        sourceWorkspaceFingerprintSha256:
          admission.sourceWorkspaceFingerprintSha256,
        repositoryControlSha256: admission.repositoryControlSha256,
        head: admission.baseRevision,
        watcherChanged: false,
        reasonCode: null,
      },
    });

    const intents = await executor.planWorktrees({
      admission,
      contestants: CONTESTANTS.map((contestant) => ({
        runId,
        contestantId: contestant.contestantId,
        worktreeId: contestant.worktreeId,
        intentId: `${runId}-${contestant.contestantId}-intent`,
        occurredAt: new Date().toISOString(),
      })),
    });
    await options.onProgress?.("worktreesPlanned");
    checks.set(
      "intentBeforeSideEffect",
      intents.length === CONTESTANTS.length
        && await everyPathMissing(CONTESTANTS.map((contestant) =>
          arenaContestantWorktreePath(
            privateRoot,
            runId,
            contestant.contestantId,
          ))),
    );

    for (const intent of intents) {
      const worktree = await executor.provisionPlannedWorktree(
        intent,
        options.signal,
      );
      provisioned.push(worktree);
      await options.onProgress?.(
        provisioned.length === 1
          ? "firstWorktreeProvisioned"
          : "secondWorktreeProvisioned",
      );
      if (worktree.contestantId === CONTESTANTS[0]!.contestantId) {
        await store.append({
        eventId: `${runId}-${worktree.contestantId}-registered`,
        runId,
        occurredAt: new Date().toISOString(),
        type: "arenaWorktreeRegistered",
        payload: {
          payloadType: "worktreeRegistered",
          contestantId: worktree.contestantId,
          worktreeId: worktree.worktreeId,
          baseRevision: worktree.head,
          registrationSha256: worktree.registrationSha256,
          initialFingerprintSha256: worktree.fingerprint.sha256,
        },
        });
      }
    }
    await options.onProgress?.("worktreesProvisioned");
    const reconciled = await executor.reconcileRunRegistrations(
      runId,
      options.signal,
    );
    if (reconciled !== 1) {
      throw new Error("Arena smoke did not recover the receipt/manifest crash window.");
    }
    await options.onProgress?.("registrationsReconciled");
    for (const worktree of provisioned) {
      const provisionedPayload: ArenaWorktreeProvisionedPayload = {
        payloadType: "worktreeProvisioned",
        contestantId: worktree.contestantId,
        worktreeId: worktree.worktreeId,
        baseRevision: worktree.head,
        registrationSha256: worktree.registrationSha256,
        initialFingerprintSha256: worktree.fingerprint.sha256,
        preparationPlanSha256: null,
        preparationStatus: "succeeded",
        preparationReceiptSha256: null,
        preparedFingerprintSha256: worktree.fingerprint.sha256,
      };
      await store.append({
        eventId: `${runId}-${worktree.contestantId}-provisioned`,
        runId,
        occurredAt: new Date().toISOString(),
        type: "arenaWorktreeProvisioned",
        payload: provisionedPayload,
      });
    }
    checks.set(
      "identicalDetachedWorktrees",
      provisioned.length === CONTESTANTS.length
        && provisioned.every((worktree) =>
          worktree.head.oid === sourceHead
          && worktree.fingerprint.sha256 === admission.baseContentSha256),
    );
    const recovered = await executor.recoverProvisionedWorktree(
      runId,
      CONTESTANTS[0]!.contestantId,
      options.signal,
    );
    checks.set(
      "durableRegistration",
      recovered?.registrationSha256
        === provisioned[0]?.registrationSha256,
    );

    for (const worktree of provisioned) {
      const finished = await store.append({
        eventId: `${runId}-${worktree.contestantId}-finished`,
        runId,
        occurredAt: new Date().toISOString(),
        type: "arenaContestantFinished",
        payload: smokeBeforeDispatchFinish(worktree),
      });
      await preserveSmokeEvidence(
        privateRoot,
        runId,
        worktree,
        finished,
        store,
      );
    }
    await store.append({
      eventId: `${runId}-finalized`,
      runId,
      occurredAt: new Date().toISOString(),
      type: "arenaRunFinalized",
      payload: {
        payloadType: "runFinalized",
        outcome: "cancelled",
        comparison: "incomplete",
        reasonCode: "userCancelled",
        evidenceMatrixSha256: null,
      },
    });
    await options.onProgress?.("manifestFinalized");
    const beforeCleanup = await store.load(runId);
    checks.set(
      "manifestReplay",
      beforeCleanup?.state === "finalized"
        && beforeCleanup.contestants.every((contestant) =>
          contestant.worktreeRegistered !== undefined
          && contestant.worktreeProvisioned !== undefined
          && contestant.evidencePreserved !== undefined),
    );

    for (const worktree of provisioned) {
      for (const step of ARENA_CLEANUP_STEPS) {
        const result = await executeSmokeCleanupStep(
          executor,
          worktree,
          step,
          options.signal,
        );
        const replay = await store.load(runId);
        const contestant = replay?.contestants.find((candidate) =>
          candidate.lock.contestantId === worktree.contestantId);
        const evidenceEvent = contestant?.evidencePreserved;
        if (!evidenceEvent) {
          throw new Error("Arena smoke lost evidence before cleanup.");
        }
        const cleanupWithoutReceipt = {
          payloadType: "cleanupStepRecorded" as const,
          runId,
          cleanupId: `${runId}-${worktree.contestantId}-cleanup`,
          contestantId: worktree.contestantId,
          registrationSha256: worktree.registrationSha256,
          evidenceEventSha256: evidenceEvent.eventSha256,
          step,
          attempt: 1,
          outcome: result.outcome,
          failureCode: null,
          retryDelayMs: null,
          postcondition: result.postcondition,
          postconditionSha256: arenaCleanupPostconditionSha256(
            result.postcondition,
          ),
        } satisfies Omit<ArenaCleanupStepPayload, "stepReceiptSha256">;
        await store.append({
          eventId: `${runId}-${worktree.contestantId}-cleanup-${step}`,
          runId,
          occurredAt: new Date().toISOString(),
          type: "arenaCleanupStepRecorded",
          payload: {
            ...cleanupWithoutReceipt,
            stepReceiptSha256: arenaCleanupStepReceiptSha256(
              cleanupWithoutReceipt,
            ),
          },
        });
      }
    }
    const finalReplay = await store.load(runId);
    manifestEvents = finalReplay?.records.length ?? 0;
    cleanupState = finalReplay?.state === "cleanupComplete"
      ? "cleanupComplete"
      : "incomplete";
    await options.onProgress?.("cleanupComplete");
    checks.set(
      "exactCleanup",
      cleanupState === "cleanupComplete"
        && await everyPathMissing(provisioned.map((value) =>
          value.worktreePath)),
    );
    await executor.releaseRepositoryRun(runId);
    repositoryClaimActive = false;
    await options.onProgress?.("claimReleased");
    const finalAdmission = await executor.inspectAdmission();
    checks.set(
      "sourceUnchanged",
      finalAdmission.baseRevision.oid === sourceHead
        && finalAdmission.baseContentSha256 === admission.baseContentSha256
        && finalAdmission.repositoryControlSha256
          === admission.repositoryControlSha256,
    );
    checks.set(
      "unrelatedWorktreePreserved",
      finalAdmission.worktrees.some((entry) =>
        samePath(entry.path, unrelatedPath))
        && await isRealDirectory(unrelatedPath),
    );
  } catch (error) {
    primaryFailure = error;
    await options.onProgress?.("failed");
    throw error;
  } finally {
    await options.onProgress?.("finalCleanupStarted");
    let preserveForRecovery =
      hasArenaTerminationUnconfirmed(primaryFailure);
    let cleanupFailure: unknown = preserveForRecovery
      ? primaryFailure
      : undefined;
    if (executor && repositoryClaimActive && !preserveForRecovery) {
      for (const worktree of [...provisioned].reverse()) {
        try {
          await executor.unlockOwnedWorktree(worktree);
          await executor.removeOwnedWorktree(worktree);
        } catch (error) {
          preserveForRecovery = true;
          cleanupFailure ??= error;
          break;
        }
      }
    }
    await options.onProgress?.("provisionedCleanupFinished");
    if (executor && repositoryClaimActive) {
      executor.abandonRepositoryRun(runId);
      await options.onProgress?.("claimAbandoned");
    }
    if (gitExecutable && !preserveForRecovery) {
      try {
        await runSmokeGit(
          gitExecutable,
          sourceRoot,
          ["worktree", "remove", "--force", "--", unrelatedPath],
          [0, 128],
          undefined,
        );
      } catch (error) {
        preserveForRecovery = true;
        cleanupFailure ??= error;
      }
      if (!preserveForRecovery) {
        await options.onProgress?.("unrelatedWorktreeRemoved");
      }
    }
    if (!preserveForRecovery) {
      if (sourceContainer) {
        await removeExactSmokeDirectory(
          sourceContainer,
          tempParent,
          "hydra-arena-smoke-source-",
        );
        await options.onProgress?.("sourceStorageRemoved");
      }
      if (privateRoot) {
        await removeExactSmokeDirectory(
          privateRoot,
          realSmokeParent,
          "s-",
        );
        await options.onProgress?.("privateStorageRemoved");
      }
      if (smokeLeaseRoot && leaseParentBoundary) {
        await removeExactSmokeDirectory(
          smokeLeaseRoot,
          leaseParentBoundary.realRoot,
          "hydra-arena-smoke-lease-",
        );
        await options.onProgress?.("leaseStorageRemoved");
      }
      if (recoveryCatalogPath && outerBoundary) {
        await removeSmokeRecoveryCatalog(
          recoveryCatalogPath,
          outerBoundary,
        );
        recoveryCatalogPath = "";
      }
    }
    if (cleanupFailure) throw cleanupFailure;
    if (outerBoundary) await assertArenaPrivateBoundary(outerBoundary);
    if (leaseParentBoundary) {
      await assertArenaRepositoryLeaseBoundary(leaseParentBoundary);
    }
    await options.onProgress?.("finalCleanupFinished");
  }

  await options.onProgress?.("controllerSmokeStarted");
  const controllerSmoke = await runArenaControllerSmokeTest({
    privateWorkspaceRoot: options.privateWorkspaceRoot,
    repositoryLeaseRoot: options.repositoryLeaseRoot,
    gitResolutionRoot: options.gitResolutionRoot,
    signal: options.signal,
  });
  await options.onProgress?.("controllerSmokeFinished");
  checks.set(
    "supervisedHeadDispatch",
    controllerSmoke.fakeHeadsSupervised,
  );
  checks.set(
    "continuousMainTreeMonitor",
    controllerSmoke.sourceUnchanged,
  );
  checks.set(
    "evidenceMatrix",
    controllerSmoke.comparable && controllerSmoke.cleanupComplete,
  );
  manifestEvents += controllerSmoke.manifestEvents;
  cleanupState = cleanupState === "cleanupComplete"
      && controllerSmoke.cleanupComplete
    ? "cleanupComplete"
    : "incomplete";

  const orderedChecks = ([
    "admission",
    "intentBeforeSideEffect",
    "identicalDetachedWorktrees",
    "durableRegistration",
    "manifestReplay",
    "exactCleanup",
    "sourceUnchanged",
    "unrelatedWorktreePreserved",
    "supervisedHeadDispatch",
    "continuousMainTreeMonitor",
    "evidenceMatrix",
  ] as const).map((id) => Object.freeze({
    id,
    passed: checks.get(id) === true,
  }));
  return Object.freeze({
    schemaVersion: ARENA_SMOKE_SCHEMA_VERSION,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    passed: orderedChecks.every((check) => check.passed),
    checks: Object.freeze(orderedChecks),
    observed: Object.freeze({
      contestants: CONTESTANTS.length,
      manifestEvents,
      cleanupState,
      sourceHead,
    }),
  });
}

export function formatArenaSmokeReport(report: ArenaSmokeReport): string {
  const passed = report.checks.filter((check) => check.passed).length;
  return `Arena worktree smoke test ${
    report.passed ? "passed" : "failed"
  }. Checks ${passed}/${report.checks.length}; contestants ${
    report.observed.contestants
  }; manifest events ${report.observed.manifestEvents}; cleanup ${
    report.observed.cleanupState
  }.`;
}

async function initializeSmokeRepository(
  gitExecutable: string,
  sourceRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  await runSmokeGit(gitExecutable, sourceRoot, [
    "init",
    "--quiet",
    "--initial-branch=main",
  ], [0], signal);
  await runSmokeGit(gitExecutable, sourceRoot, [
    "config",
    "--local",
    "user.name",
    "Hydra Arena Smoke",
  ], [0], signal);
  await runSmokeGit(gitExecutable, sourceRoot, [
    "config",
    "--local",
    "user.email",
    "arena-smoke@invalid.local",
  ], [0], signal);
  await fs.writeFile(
    path.join(sourceRoot, "smoke.txt"),
    "Hydra Arena isolated smoke fixture.\n",
    { encoding: "utf8", mode: 0o600 },
  );
  await runSmokeGit(
    gitExecutable,
    sourceRoot,
    ["add", "--", "smoke.txt"],
    [0],
    signal,
  );
  await runSmokeGit(gitExecutable, sourceRoot, [
    "commit",
    "--quiet",
    "-m",
    "Hydra Arena smoke base",
  ], [0], signal);
}

async function runSmokeGit(
  gitExecutable: string,
  cwd: string,
  args: readonly string[],
  allowedExitCodes: readonly number[] = [0],
  signal?: AbortSignal,
): Promise<void> {
  await runArenaGitCommand(
    gitExecutable,
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
    {
      allowedExitCodes,
      timeoutMs: 120_000,
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 64 * 1024,
      signal,
    },
  );
}

function hasArenaTerminationUnconfirmed(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (current instanceof ArenaGitError
      && current.code === "terminationUnconfirmed") {
      return true;
    }
    if (!current
      || (typeof current !== "object" && typeof current !== "function")
      || seen.has(current)) {
      return false;
    }
    seen.add(current);
    current = "cause" in current
      ? (current as { readonly cause?: unknown }).cause
      : undefined;
  }
  return false;
}

async function recordSmokeRecovery(input: {
  readonly boundary: ArenaPrivateStorageBoundary;
  readonly runId: string;
  readonly sourceContainer: string;
  readonly privateRoot: string;
  readonly repositoryLeaseRoot: string;
}): Promise<string> {
  const directory = await ensureArenaPrivateDirectory(
    input.boundary,
    ["support", "smoke-recovery"],
  );
  const occurredAt = new Date().toISOString();
  const body = {
    schemaVersion: 1,
    recordType: "arenaSmokeRecovery",
    runId: input.runId,
    occurredAt,
    sourceContainer: input.sourceContainer,
    privateRoot: input.privateRoot,
    repositoryLeaseRoot: input.repositoryLeaseRoot,
    // The catalog is published before any Git side effect. Recovery must
    // inspect the owner ledger rather than trusting a stale in-process flag,
    // so it conservatively treats a claim as possible for the full lifetime.
    repositoryClaimMayBeActive: true,
  } as const;
  const record = {
    ...body,
    recordSha256: digest(
      `hydra.arena.smoke-recovery.v1\u0000${JSON.stringify(body)}`,
    ),
  } as const;
  const recoveryPath = path.join(
    directory,
    `${input.runId}.v1.json`,
  );
  await createArenaPrivateFile(
    recoveryPath,
    `${JSON.stringify(record)}\n`,
    input.boundary,
  );
  return recoveryPath;
}

async function removeSmokeRecoveryCatalog(
  recoveryPath: string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  const directory = path.dirname(recoveryPath);
  await assertArenaPrivateDirectory(directory, boundary);
  const before = await fs.lstat(recoveryPath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error("Arena smoke recovery catalog became linked or invalid.");
  }
  await fs.unlink(recoveryPath);
  await assertArenaPrivateDirectory(directory, boundary);
}

function smokeLock(
  admission: Awaited<ReturnType<ArenaGitExecutor["inspectAdmission"]>>,
  runId: string,
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
    environmentPolicySha256: digest(`${runId}:environment`),
    budgetSha256: digest(`${runId}:budget`),
    verificationChecks: [],
    browserJourneys: [],
    contestants: CONTESTANTS.map((contestant) => ({
      contestantId: contestant.contestantId,
      headId: contestant.headId,
      agentKind: contestant.headId,
      headConfigSha256: digest(`${runId}:${contestant.headId}:config`),
      authoritySha256: digest(`${runId}:${contestant.headId}:authority`),
      invocationSha256: digest(`${runId}:${contestant.headId}:invocation`),
      worktreeId: contestant.worktreeId,
    })),
    steering: "disabled",
    confirmation: {
      actorId: "local-user",
      action: "Confirm Arena Run",
      confirmationId: `${runId}-confirmation`,
    },
  };
}

function smokeBeforeDispatchFinish(
  worktree: ArenaProvisionedWorktree,
): ArenaContestantFinishedPayload {
  return {
    payloadType: "contestantFinished",
    contestantId: worktree.contestantId,
    stage: "beforeDispatch",
    traceId: null,
    status: "cancelled",
    failureCode: "cancelled",
    finalHead: worktree.head,
    finalWorkspaceFingerprintSha256: worktree.fingerprint.sha256,
    outputSha256: digest(`${worktree.contestantId}:output`),
    outputBytes: 0,
  };
}

async function preserveSmokeEvidence(
  privateRoot: string,
  runId: string,
  worktree: ArenaProvisionedWorktree,
  finished: ArenaManifestEvent,
  store: Awaited<ReturnType<typeof openFileArenaManifestStore>>,
): Promise<void> {
  const boundary = await prepareArenaPrivateStorage(privateRoot);
  const artifactPath = arenaContestantArtifactPath(
    privateRoot,
    runId,
    worktree.contestantId,
  );
  await ensureArenaPrivateDirectory(
    boundary,
    ["artifacts", runId, worktree.contestantId],
  );
  const patch = Buffer.alloc(0);
  const inventory = Buffer.from('{"entries":[]}\n', "utf8");
  await createArenaPrivateFile(
    path.join(artifactPath, "patch.bin"),
    patch,
    boundary,
  );
  await createArenaPrivateFile(
    path.join(artifactPath, "inventory.v1.json"),
    inventory,
    boundary,
  );
  const patchSha256 = bufferDigest(patch);
  const inventorySha256 = bufferDigest(inventory);
  const payloadWithoutArtifactSet = {
    payloadType: "evidencePreserved",
    contestantId: worktree.contestantId,
    receiptsRootSha256: arenaReceiptsRootSha256({
      finished,
      verifications: new Map(),
      browserJourneys: new Map(),
    }),
    patchSha256,
    patchBytes: patch.length,
    untrackedArchiveSha256: null,
    untrackedArchiveBytes: 0,
    inventorySha256,
    quiescenceReceiptSha256: null,
    quiescenceWorkspaceFingerprintSha256: null,
    finalHead: worktree.head,
    finalWorkspaceFingerprintSha256: worktree.fingerprint.sha256,
  } satisfies Omit<ArenaEvidencePreservedPayload, "artifactSetSha256">;
  const payload: ArenaEvidencePreservedPayload = {
    ...payloadWithoutArtifactSet,
    artifactSetSha256: arenaArtifactSetSha256(payloadWithoutArtifactSet),
  };
  await store.append({
    eventId: `${runId}-${worktree.contestantId}-evidence`,
    runId,
    occurredAt: new Date().toISOString(),
    type: "arenaEvidencePreserved",
    payload,
  });
}

async function executeSmokeCleanupStep(
  executor: ArenaGitExecutor,
  worktree: ArenaOwnedWorktree,
  step: ArenaCleanupStep,
  signal?: AbortSignal,
): Promise<{
  readonly outcome: "succeeded" | "notNeeded";
  readonly postcondition: ArenaCleanupPostcondition;
}> {
  if (step === "quiesceProcesses") {
    return {
      outcome: "succeeded",
      postcondition: {
        kind: "processQuiescence",
        processOwnerSha256: digest(
          `${worktree.runId}:${worktree.contestantId}:process-owner`,
        ),
        terminationConfirmed: true,
        activeProcessCount: 0,
      },
    };
  }
  if (step === "verifyTarget") {
    return {
      outcome: "succeeded",
      postcondition: await executor.captureCleanupPostcondition(
        worktree,
        step,
        signal,
      ),
    };
  }
  if (step === "unlockGitWorktree") {
    const outcome = await executor.unlockOwnedWorktree(worktree, signal);
    return {
      outcome,
      postcondition: await executor.captureCleanupPostcondition(
        worktree,
        step,
        signal,
      ),
    };
  }
  if (step === "removeGitWorktree") {
    const outcome = await executor.removeOwnedWorktree(worktree, signal);
    return {
      outcome,
      postcondition: await executor.captureCleanupPostcondition(
        worktree,
        step,
        signal,
      ),
    };
  }
  if (step === "verifyGitRegistrationGone") {
    return {
      outcome: "succeeded",
      postcondition: await executor.captureCleanupPostcondition(
        worktree,
        step,
        signal,
      ),
    };
  }
  if (step === "removeResidualDirectory") {
    const outcome = await executor.removeResidualDirectory(worktree, signal);
    return {
      outcome,
      postcondition: await executor.captureCleanupPostcondition(
        worktree,
        step,
        signal,
      ),
    };
  }
  return {
    outcome: "notNeeded",
    postcondition: await executor.captureCleanupPostcondition(
      worktree,
      step,
      signal,
    ),
  };
}

async function everyPathMissing(paths: readonly string[]): Promise<boolean> {
  return (await Promise.all(paths.map(async (candidate) =>
    !await pathExists(candidate)))).every(Boolean);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isRealDirectory(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(candidate);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function removeExactSmokeDirectory(
  target: string,
  expectedParent: string,
  prefix: string,
): Promise<void> {
  const absoluteTarget = path.resolve(target);
  const absoluteParent = path.resolve(expectedParent);
  if (path.dirname(absoluteTarget) !== absoluteParent
    || !path.basename(absoluteTarget).startsWith(prefix)) {
    throw new Error("Refusing broad Arena smoke cleanup.");
  }
  const stat = await fs.lstat(absoluteTarget).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Refusing linked Arena smoke cleanup.");
  }
  await fs.rm(absoluteTarget, { recursive: true, force: false });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bufferDigest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}
