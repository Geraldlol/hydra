import * as cp from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import {
  bindProcessTreeIdentity,
  terminateProcessTree,
  waitForPosixProcessGroupQuiescence,
} from "./agents";
import {
  captureDuelWorkspaceFingerprint,
  watchDuelWorkspaceMutations,
  type DuelWorkspaceFingerprint,
} from "./duelWorkspaceGuard";
import {
  resolveGitExecutable,
  workspaceGitExecutionAllowed,
} from "./gitExecutable";
import {
  arenaContestantArtifactPath,
  arenaContestantWorktreePath,
  openFileArenaManifestStore,
} from "./arenaStore";
import { arenaPhysicalWorktreeSegment } from "./arenaPathBudget";
import {
  assertArenaPrivateDirectory,
  ensureArenaPrivateDirectory,
  isArenaPathWithin,
  prepareArenaPrivateStorage,
  sameArenaPath,
  serializeArenaPrivateWork,
  syncArenaDirectoryEntry,
  type ArenaPrivateStorageBoundary,
} from "./arenaPrivateStorage";
import {
  recoverArenaEvidenceStageTemps,
  releaseArenaEvidenceStageName,
  reserveArenaEvidenceStageName,
} from "./arenaEvidenceStageRecovery";
import {
  FileArenaRepositoryRunLeaseStore,
  prepareArenaRepositoryLeaseRoot,
  type ArenaRepositoryRunClaim,
} from "./arenaRepositoryLease";
import type { ArenaRecoveryActionProof } from "./arenaRecovery";
import {
  arenaWorktreeRegistrationPaths,
  FileArenaWorktreeRegistrationStore,
  type ArenaWorktreeRegistrationIntent,
  type ArenaWorktreeRegistrationReceipt,
} from "./arenaWorktreeRegistration";
import type {
  ArenaGitObjectFormat,
  ArenaGitObjectId,
  ArenaMainWorkspaceObservedPayload,
  ArenaWorktreeRegisteredPayload,
} from "./arenaRunManifest";
import type {
  ArenaCleanupPostcondition,
  ArenaCleanupStep,
} from "./arenaCleanup";
import type {
  ArenaPromotionPatchCheck,
  ArenaPromotionWorkspaceSnapshot,
} from "./arenaPromotion";
import type {
  ArenaPromotionCandidate,
  ArenaPromotionUntrackedEntry,
} from "./arenaPromotionCandidate";
import {
  ARENA_TRACKED_PATHS_MAX_BYTES,
  ArenaPathBudgetError,
  preflightArenaWorktreePathBudget,
} from "./arenaPathBudget";

export const ARENA_GIT_POLICY_VERSION = "hydra-arena-git-v1" as const;

const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_GIT_STDOUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_GIT_STDERR_BYTES = 64 * 1024;
const MAX_ARENA_PATCH_BYTES = 64 * 1024 * 1024;
const MAX_ARENA_UNTRACKED_PATH_BYTES = 16 * 1024 * 1024;
const MAX_WORKTREE_FIELDS = 100_000;
const MAX_WORKTREE_FIELD_BYTES = 64 * 1024;
const MAX_GIT_CONTROL_SCAN_ENTRIES = 20_000;
const MAX_GIT_CONTROL_SCAN_DEPTH = 16;
const SEQUENCER_PATHS = Object.freeze([
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "rebase-apply",
  "rebase-merge",
  "sequencer",
  "index.lock",
  "HEAD.lock",
  "config.lock",
  "packed-refs.lock",
  "shallow.lock",
] as const);

export type ArenaGitErrorCode =
  | "gitUnavailable"
  | "gitFailed"
  | "gitTimedOut"
  | "gitOutputTooLarge"
  | "gitCancelled"
  | "terminationUnconfirmed"
  | "unsafePath"
  | "unsupportedRepository"
  | "dirtyWorkspace"
  | "sequencerActive"
  | "sparseCheckout"
  | "submodules"
  | "indexFlags"
  | "configuredHelpers"
  | "pathBudget"
  | "worktreeExists"
  | "registrationMismatch"
  | "worktreeStateMismatch";

export class ArenaGitError extends Error {
  constructor(
    readonly code: ArenaGitErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArenaGitError";
  }
}

export interface ArenaGitWorktreeEntry {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly lockedReason: string | null;
  readonly prunableReason: string | null;
}

export interface ArenaGitAdmission {
  readonly policy: typeof ARENA_GIT_POLICY_VERSION;
  readonly gitExecutable: string;
  readonly sourceWorkspacePath: string;
  readonly commonDirectoryPath: string;
  readonly objectFormat: ArenaGitObjectFormat;
  readonly baseRevision: ArenaGitObjectId;
  readonly baseContentSha256: string;
  readonly sourceWorkspaceFingerprintSha256: string;
  readonly repositoryIdentitySha256: string;
  readonly repositoryControlSha256: string;
  readonly repositoryStaticControlSha256: string;
  readonly worktreeRegistrySha256: string;
  readonly sourceDirectoryIdentitySha256: string;
  readonly worktrees: readonly ArenaGitWorktreeEntry[];
}

export interface ArenaOwnedWorktree {
  readonly runId: string;
  readonly contestantId: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly realWorktreePath: string;
  readonly lockReason: string;
  readonly registrationSha256: string;
  readonly gitRegistrationSha256: string;
  readonly intentSha256: string;
  readonly repositoryIdentitySha256: string;
  readonly directoryIdentitySha256: string;
  readonly head: ArenaGitObjectId;
  readonly initialFingerprintSha256: string;
}

export interface ArenaProvisionedWorktree extends ArenaOwnedWorktree {
  readonly fingerprint: DuelWorkspaceFingerprint;
}

export interface ArenaVerifiedWorktree {
  readonly runId: string;
  readonly contestantId: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly realWorktreePath: string;
  readonly lockReason: string;
  readonly gitRegistrationSha256: string;
  readonly directoryIdentitySha256: string;
  readonly head: ArenaGitObjectId;
  readonly fingerprint: DuelWorkspaceFingerprint;
}

export interface ArenaOwnedEvidenceState {
  readonly finalHead: ArenaGitObjectId;
  readonly fingerprint: DuelWorkspaceFingerprint;
  readonly patch: ArenaStagedEvidenceFile;
  readonly untrackedPaths: ArenaStagedEvidenceFile;
}

export interface ArenaStagedEvidenceFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ArenaProvisionWorktreeInput {
  readonly runId: string;
  readonly contestantId: string;
  readonly worktreeId: string;
  readonly intentId: string;
  readonly occurredAt: string;
  readonly admission: ArenaGitAdmission;
  readonly signal?: AbortSignal;
}

export interface ArenaPlanWorktreesInput {
  readonly admission: ArenaGitAdmission;
  readonly contestants: readonly {
    readonly runId: string;
    readonly contestantId: string;
    readonly worktreeId: string;
    readonly intentId: string;
    readonly occurredAt: string;
  }[];
}

export interface ArenaGitCommandResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number;
}

export interface ArenaGitCommandOptions {
  readonly allowedExitCodes?: readonly number[];
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Exact bounded bytes written directly to Git stdin without a shell. */
  readonly stdin?: Buffer;
  /**
   * Consume stdout with backpressure instead of retaining it in memory.
   * The byte limit is enforced before each chunk reaches the sink.
   */
  readonly stdoutSink?: (chunk: Buffer) => Promise<void>;
}

export class ArenaGitExecutor {
  private readonly runClaims = new Map<string, ArenaRepositoryRunClaim>();

  private constructor(
    readonly workspaceRoot: string,
    readonly privateWorkspaceRoot: string,
    readonly gitExecutable: string,
    private readonly gitExecutableIdentitySha256: string,
    private readonly gitResolutionRoot: string,
    private readonly boundary: ArenaPrivateStorageBoundary,
    private readonly emptyHooksPath: string,
    private readonly registrations: FileArenaWorktreeRegistrationStore,
    private readonly repositoryLeases: FileArenaRepositoryRunLeaseStore,
  ) {}

  static async open(
    workspaceRoot: string,
    privateWorkspaceRoot: string,
    repositoryLeaseRoot: string,
    gitResolutionRoot = workspaceRoot,
  ): Promise<ArenaGitExecutor> {
    const root = path.resolve(workspaceRoot);
    const resolutionRoot = path.resolve(gitResolutionRoot);
    await assertRealDirectory(root, "Arena source workspace");
    await assertRealDirectory(resolutionRoot, "Arena Git resolution workspace");
    const gitExecutable = await resolveGitExecutable(resolutionRoot);
    if (!gitExecutable) {
      throw new ArenaGitError(
        "gitUnavailable",
        "Arena requires a trusted workspace and one resolved native Git executable.",
      );
    }
    if (!path.isAbsolute(gitExecutable)
      || (process.platform === "win32"
        && !/\.(?:exe|com)$/i.test(gitExecutable))) {
      throw new ArenaGitError(
        "gitUnavailable",
        "Arena Git executable must be one absolute native binary.",
      );
    }
    const realGitExecutable = await fs.realpath(gitExecutable);
    const gitStat = await fs.lstat(realGitExecutable);
    if (!gitStat.isFile() || gitStat.isSymbolicLink()) {
      throw new ArenaGitError(
        "gitUnavailable",
        "Arena Git executable must resolve to one real native file.",
      );
    }
    const preparedBoundary = await prepareArenaPrivateStorage(
      privateWorkspaceRoot,
    );
    // Windows hosted runners and user profiles may expose a stable directory
    // through an OS-managed junction. Use the authenticated real root for all
    // durable path derivation so Git and Hydra cannot name the same worktree
    // differently in registry hashes or receipts.
    const boundary = sameArenaPath(
      preparedBoundary.privateWorkspaceRoot,
      preparedBoundary.realPrivateWorkspaceRoot,
    )
      ? preparedBoundary
      : await prepareArenaPrivateStorage(
          preparedBoundary.realPrivateWorkspaceRoot,
        );
    const realWorkspace = await fs.realpath(root);
    const realResolutionRoot = await fs.realpath(resolutionRoot);
    if (isArenaPathWithin(realWorkspace, boundary.realRoot)
      || isArenaPathWithin(boundary.realRoot, realWorkspace)) {
      throw new ArenaGitError(
        "unsafePath",
        "Arena private storage and source workspace must not overlap.",
      );
    }
    if (isArenaPathWithin(realWorkspace, realGitExecutable)
      || isArenaPathWithin(boundary.realRoot, realGitExecutable)) {
      throw new ArenaGitError(
        "gitUnavailable",
        "Arena refuses a Git executable located inside source or private storage.",
      );
    }
    const emptyHooksPath = await ensureArenaPrivateDirectory(
      boundary,
      ["support", "empty-hooks"],
    );
    const leaseBoundary = await prepareArenaRepositoryLeaseRoot(
      repositoryLeaseRoot,
    );
    if (isArenaPathWithin(realWorkspace, leaseBoundary.realRoot)
      || isArenaPathWithin(leaseBoundary.realRoot, realWorkspace)) {
      throw new ArenaGitError(
        "unsafePath",
        "Arena repository leases must stay outside the source workspace.",
      );
    }
    if (isArenaPathWithin(boundary.realRoot, leaseBoundary.realRoot)
      || isArenaPathWithin(leaseBoundary.realRoot, boundary.realRoot)) {
      throw new ArenaGitError(
        "unsafePath",
        "Arena repository leases must use an external extension-global root.",
      );
    }
    const executor = new ArenaGitExecutor(
      realWorkspace,
      boundary.privateWorkspaceRoot,
      realGitExecutable,
      executableIdentitySha256(realGitExecutable, gitStat),
      realResolutionRoot,
      boundary,
      emptyHooksPath,
      new FileArenaWorktreeRegistrationStore(boundary.privateWorkspaceRoot),
      new FileArenaRepositoryRunLeaseStore(leaseBoundary),
    );
    await executor.assertWorktreeCapabilities();
    return executor;
  }

  async claimRepositoryRun(
    runId: string,
    admission: ArenaGitAdmission,
  ): Promise<
    | {
        readonly status: "active";
        readonly ownerId: string;
        readonly claimSha256: string;
      }
    | {
        readonly status: "released";
        readonly completionReceiptSha256: string;
      }
  > {
    this.assertAdmissionMatchesExecutor(admission);
    if (this.runClaims.has(runId)) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena repository run is already claimed by this executor.",
      );
    }
    const manifestStore = await openFileArenaManifestStore(
      this.privateWorkspaceRoot,
    );
    const manifest = await manifestStore.load(runId);
    const lockEvent = manifest?.records[0];
    if (!manifest
      || !lockEvent
      || lockEvent.type !== "arenaRunLocked"
      || manifest.lock.base.repositoryIdentitySha256
        !== admission.repositoryIdentitySha256
      || manifest.lock.base.repositoryControlSha256
        !== admission.repositoryControlSha256
      || manifest.lock.base.sourceWorkspaceFingerprintSha256
        !== admission.sourceWorkspaceFingerprintSha256
      || manifest.lock.base.baseContentSha256 !== admission.baseContentSha256
      || manifest.lock.base.revision.objectFormat
        !== admission.baseRevision.objectFormat
      || manifest.lock.base.revision.oid !== admission.baseRevision.oid) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena repository claim requires one matching active locked manifest.",
      );
    }
    const claimInput = {
      runId,
      repositoryIdentitySha256: admission.repositoryIdentitySha256,
      sourceDirectoryIdentitySha256:
        admission.sourceDirectoryIdentitySha256,
      privateStorageIdentitySha256: hashCanonical(
        "hydra.arena.private-storage-identity.v1\u0000",
        {
          realRoot: canonicalPath(this.boundary.realRoot),
          privateWorkspaceIdentity:
            this.boundary.privateWorkspaceIdentity,
          rootIdentity: this.boundary.rootIdentity,
        },
      ),
      repositoryControlSha256: admission.repositoryControlSha256,
      baseRevisionSha256: hashCanonical(
        "hydra.arena.git.base-revision.v1\u0000",
        admission.baseRevision,
      ),
      manifestLockEventSha256: lockEvent.eventSha256,
      // Fresh claims never carry restart authority. Recovery uses the separate
      // typed proof path after strict process-generation replay.
      recoveryProofSha256: null,
    } as const;
    const releasedCompletion =
      await this.repositoryLeases.releasedCompletion(claimInput);
    if (releasedCompletion) {
      return Object.freeze({
        status: "released",
        completionReceiptSha256: releasedCompletion,
      });
    }
    let claim: ArenaRepositoryRunClaim;
    try {
      claim = await this.repositoryLeases.claim(claimInput);
    } catch (error) {
      throw new ArenaGitError(
        "registrationMismatch",
        error instanceof Error ? error.message : "Arena repository claim failed.",
        { cause: error },
      );
    }
    this.runClaims.set(runId, claim);
    return Object.freeze({
      status: "active",
      ownerId: claim.ownerId,
      claimSha256: claim.claimSha256,
    });
  }

  async recoverRepositoryRun(
    runId: string,
    admission: ArenaGitAdmission,
    proof: ArenaRecoveryActionProof,
  ): Promise<{
    readonly status: "active";
    readonly ownerId: string;
    readonly claimSha256: string;
    readonly authorizedAction: ArenaRecoveryActionProof["action"];
  }> {
    this.assertAdmissionMatchesExecutor(admission);
    if (this.runClaims.has(runId)) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena repository run is already claimed by this executor.",
      );
    }
    const manifest = await (await openFileArenaManifestStore(
      this.privateWorkspaceRoot,
    )).load(runId);
    const lockEvent = manifest?.records[0];
    if (!manifest
      || !lockEvent
      || lockEvent.type !== "arenaRunLocked"
      || proof.runId !== runId
      || proof.manifestLockEventSha256 !== lockEvent.eventSha256
      || manifest.lock.base.repositoryIdentitySha256
        !== admission.repositoryIdentitySha256
      || manifest.lock.base.sourceWorkspaceFingerprintSha256
        !== admission.sourceWorkspaceFingerprintSha256
      || manifest.lock.base.baseContentSha256 !== admission.baseContentSha256
      || manifest.lock.base.revision.objectFormat
        !== admission.baseRevision.objectFormat
      || manifest.lock.base.revision.oid !== admission.baseRevision.oid) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena restart recovery requires the exact locked source and proof.",
      );
    }
    const repositoryControls = await this.captureRegisteredRunControlWithoutLease(
      runId,
      admission.repositoryIdentitySha256,
      undefined,
      true,
    );
    if (repositoryControls !== manifest.lock.base.repositoryControlSha256) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena restart recovery repository controls do not match the lock.",
      );
    }
    const claimInput = {
      runId,
      repositoryIdentitySha256: admission.repositoryIdentitySha256,
      sourceDirectoryIdentitySha256: admission.sourceDirectoryIdentitySha256,
      privateStorageIdentitySha256: hashCanonical(
        "hydra.arena.private-storage-identity.v1\u0000",
        {
          realRoot: canonicalPath(this.boundary.realRoot),
          privateWorkspaceIdentity: this.boundary.privateWorkspaceIdentity,
          rootIdentity: this.boundary.rootIdentity,
        },
      ),
      repositoryControlSha256: manifest.lock.base.repositoryControlSha256,
      baseRevisionSha256: hashCanonical(
        "hydra.arena.git.base-revision.v1\u0000",
        admission.baseRevision,
      ),
      manifestLockEventSha256: lockEvent.eventSha256,
      recoveryProofSha256: proof.recoveryProofSha256,
    } as const;
    let claim: ArenaRepositoryRunClaim;
    try {
      claim = await this.repositoryLeases.recover(claimInput, proof);
    } catch (error) {
      throw new ArenaGitError(
        "registrationMismatch",
        error instanceof Error ? error.message : "Arena repository recovery failed.",
        { cause: error },
      );
    }
    this.runClaims.set(runId, claim);
    return Object.freeze({
      status: "active" as const,
      ownerId: claim.ownerId,
      claimSha256: claim.claimSha256,
      authorizedAction: proof.action,
    });
  }

  async releaseRepositoryRun(
    runId: string,
  ): Promise<void> {
    const claim = this.runClaims.get(runId);
    if (!claim) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena repository run has no active local claim.",
      );
    }
    try {
      await claim.releaseWithProof(
        () => this.verifyRepositoryRunRelease(runId, claim.claimSha256),
      );
      this.runClaims.delete(runId);
    } catch (error) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena repository run claim could not be released safely.",
        { cause: error },
      );
    }
  }

  abandonRepositoryRun(runId: string): void {
    const claim = this.runClaims.get(runId);
    if (!claim) return;
    claim.abandon();
    this.runClaims.delete(runId);
  }

  async reconcileRunRegistrations(
    runId: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const localClaim = this.runClaims.get(runId);
    if (!localClaim) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena registration reconciliation requires the active run claim.",
      );
    }
    return this.withRepositoryLease(
      localClaim.repositoryIdentitySha256,
      runId,
      async () => {
        const states = await this.registrations.listRun(runId);
        if (states.length === 0) return 0;
        const store = await openFileArenaManifestStore(
          this.privateWorkspaceRoot,
        );
        let replay = await store.load(runId);
        if (!replay) {
          throw new ArenaGitError(
            "registrationMismatch",
            "Arena cannot reconcile registrations without a locked manifest.",
          );
        }
        let recovered = 0;
        for (const state of states) {
          if (!state.receipt) continue;
          const existing = replay.contestants.find((contestant) =>
            contestant.lock.contestantId === state.intent.contestantId)
            ?.worktreeRegistered;
          if (existing) {
            const payload = existing.payload as {
              readonly registrationSha256: string;
            };
            if (payload.registrationSha256
                !== state.receipt.registrationSha256) {
              throw new ArenaGitError(
                "registrationMismatch",
                "Arena manifest registration differs from its durable receipt.",
              );
            }
            continue;
          }
          const verified = await this.verifyRegisteredWorktree({
            runId: state.intent.runId,
            contestantId: state.intent.contestantId,
            worktreeId: state.intent.worktreeId,
            baseRevision: state.intent.baseRevision,
            expectedBaseContentSha256:
              state.intent.baseContentSha256,
            target: state.intent.worktreePath,
            lockReason: state.intent.lockReason,
            signal,
          });
          this.bindDurableReceipt(
            state.intent,
            state.receipt,
            verified,
          );
          await store.append({
            eventId: `registration-recovery-${
              state.receipt.registrationSha256.slice(0, 48)
            }`,
            runId,
            occurredAt: new Date().toISOString(),
            type: "arenaWorktreeRegistered",
            payload: {
              payloadType: "worktreeRegistered",
              contestantId: state.intent.contestantId,
              worktreeId: state.intent.worktreeId,
              baseRevision: state.intent.baseRevision,
              registrationSha256: state.receipt.registrationSha256,
              initialFingerprintSha256:
                state.receipt.initialFingerprintSha256,
            },
          });
          recovered += 1;
          replay = (await store.load(runId))!;
        }
        return recovered;
      },
    );
  }

  async inspectAdmission(signal?: AbortSignal): Promise<ArenaGitAdmission> {
    await assertRealDirectory(this.workspaceRoot, "Arena source workspace");
    const realWorkspace = await fs.realpath(this.workspaceRoot);
    const topLevel = await this.gitText(
      this.workspaceRoot,
      ["rev-parse", "--show-toplevel"],
      signal,
    );
    const realTopLevel = await fs.realpath(path.resolve(this.workspaceRoot, topLevel));
    if (!sameArenaPath(realWorkspace, realTopLevel)) {
      throw new ArenaGitError(
        "unsupportedRepository",
        "Arena requires the repository's exact top-level main worktree.",
      );
    }
    const superproject = await this.gitText(
      this.workspaceRoot,
      ["rev-parse", "--show-superproject-working-tree"],
      signal,
    );
    if (superproject !== "") {
      throw new ArenaGitError(
        "unsupportedRepository",
        "Arena MVP does not admit a repository nested inside a superproject.",
      );
    }

    const bare = await this.gitText(
      this.workspaceRoot,
      ["rev-parse", "--is-bare-repository"],
      signal,
    );
    if (bare !== "false") {
      throw new ArenaGitError(
        "unsupportedRepository",
        "Arena does not admit bare repositories.",
      );
    }

    const [gitDirectoryText, commonDirectoryText] = await Promise.all([
      this.gitText(this.workspaceRoot, ["rev-parse", "--git-dir"], signal),
      this.gitText(this.workspaceRoot, ["rev-parse", "--git-common-dir"], signal),
    ]);
    const gitDirectory = path.resolve(this.workspaceRoot, gitDirectoryText);
    const commonDirectory = path.resolve(this.workspaceRoot, commonDirectoryText);
    const [realGitDirectory, realCommonDirectory] = await Promise.all([
      fs.realpath(gitDirectory),
      fs.realpath(commonDirectory),
    ]);
    if (!sameArenaPath(realGitDirectory, realCommonDirectory)) {
      throw new ArenaGitError(
        "unsupportedRepository",
        "Arena MVP requires the repository's main worktree, not a linked worktree.",
      );
    }
    await assertRealDirectory(realCommonDirectory, "Git common directory");
    const [workspaceStatAtStart, commonStatAtStart] = await Promise.all([
      fs.lstat(realWorkspace),
      fs.lstat(realCommonDirectory),
    ]);
    const expectedGitDirectory = path.join(realWorkspace, ".git");
    const expectedGitStat = await fs.lstat(expectedGitDirectory);
    if (!expectedGitStat.isDirectory()
      || expectedGitStat.isSymbolicLink()
      || !sameArenaPath(realGitDirectory, await fs.realpath(expectedGitDirectory))) {
      throw new ArenaGitError(
        "unsupportedRepository",
        "Arena MVP requires a real .git directory in the exact source workspace.",
      );
    }

    const objectFormatText = await this.gitText(
      this.workspaceRoot,
      ["rev-parse", "--show-object-format=storage"],
      signal,
    );
    if (objectFormatText !== "sha1" && objectFormatText !== "sha256") {
      throw new ArenaGitError(
        "unsupportedRepository",
        `Arena does not support Git object format ${objectFormatText || "(empty)"}.`,
      );
    }
    const objectFormat: ArenaGitObjectFormat = objectFormatText;
    const head = await this.gitText(
      this.workspaceRoot,
      ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
      signal,
    );
    assertObjectId(objectFormat, head, "source HEAD");
    const baseRevision: ArenaGitObjectId = {
      objectFormat,
      oid: head,
    };

    const status = await this.git(
      this.workspaceRoot,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
        "--no-renames",
      ],
      { signal },
    );
    if (status.stdout.length !== 0) {
      throw new ArenaGitError(
        "dirtyWorkspace",
        "Arena requires no staged, tracked, deleted, renamed, or untracked workspace changes.",
      );
    }

    await this.assertNoSequencerState(realCommonDirectory, signal);
    await this.assertNoGitControlLocks(realCommonDirectory);
    await this.assertNoSparseCheckout(signal);
    await this.assertNoSubmodules(signal);
    await this.assertNoSpecialIndexFlags(signal);
    await this.assertNoConfiguredFilters(signal);
    await this.assertNoLocalIncludes(signal);

    const worktrees = await this.listWorktrees(signal);
    const seenWorktreePaths = new Set<string>();
    for (const entry of worktrees) {
      const key = canonicalPath(entry.path);
      if (seenWorktreePaths.has(key) || entry.prunableReason !== null) {
        throw new ArenaGitError(
          "registrationMismatch",
          "Git worktree registry contains duplicate or prunable entries.",
        );
      }
      seenWorktreePaths.add(key);
    }
    const mainEntry = worktrees.find((entry) =>
      sameArenaPath(entry.path, realWorkspace));
    if (!mainEntry
      || mainEntry.bare
      || mainEntry.detached && mainEntry.branch !== null
      || mainEntry.head !== head) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Git worktree registry does not match the source workspace and locked HEAD.",
      );
    }

    const fingerprint = await this.captureFingerprint(
      this.workspaceRoot,
      signal,
    );
    if (fingerprint.head !== head) {
      throw new ArenaGitError(
        "worktreeStateMismatch",
        "Source workspace HEAD changed during Arena admission.",
      );
    }
    const [commonStat, workspaceStat] = await Promise.all([
      fs.lstat(realCommonDirectory),
      fs.lstat(realWorkspace),
    ]);
    if (hashCanonical(
      "hydra.arena.git.admission-common-identity.v1\u0000",
      statIdentity(commonStatAtStart),
    ) !== hashCanonical(
      "hydra.arena.git.admission-common-identity.v1\u0000",
      statIdentity(commonStat),
    )
      || hashCanonical(
        "hydra.arena.git.admission-source-identity.v1\u0000",
        statIdentity(workspaceStatAtStart),
      ) !== hashCanonical(
        "hydra.arena.git.admission-source-identity.v1\u0000",
        statIdentity(workspaceStat),
      )) {
      throw new ArenaGitError(
        "worktreeStateMismatch",
        "Arena source or Git common-directory identity changed during admission.",
      );
    }
    const commonDirectoryIdentity = statIdentity(commonStat);
    if (commonDirectoryIdentity.dev === "0"
      || commonDirectoryIdentity.ino === "0") {
      throw new ArenaGitError(
        "unsupportedRepository",
        "Arena requires a stable filesystem identity for the Git common directory.",
      );
    }
    const repositoryIdentitySha256 = hashCanonical(
      "hydra.arena.git.repository.v1\u0000",
      {
        commonDirectoryIdentity,
        objectFormat,
      },
    );
    const sourceDirectoryIdentitySha256 = hashCanonical(
      "hydra.arena.git.source-directory.v1\u0000",
      {
        sourceWorkspace: canonicalPath(realWorkspace),
        sourceDirectoryIdentity: statIdentity(workspaceStat),
      },
    );
    const sourceWorkspaceFingerprintSha256 = hashCanonical(
      "hydra.arena.git.source-workspace.v1\u0000",
      {
        baseContentSha256: fingerprint.sha256,
        sourceDirectoryIdentitySha256,
      },
    );
    const repositoryStaticControlSha256 =
      await this.captureRepositoryStaticControlSha256(signal);
    const worktreeRegistrySha256 = arenaWorktreeRegistrySha256(worktrees);
    return Object.freeze({
      policy: ARENA_GIT_POLICY_VERSION,
      gitExecutable: this.gitExecutable,
      sourceWorkspacePath: realWorkspace,
      commonDirectoryPath: realCommonDirectory,
      objectFormat,
      baseRevision,
      baseContentSha256: fingerprint.sha256,
      sourceWorkspaceFingerprintSha256,
      repositoryIdentitySha256,
      repositoryControlSha256: arenaRepositoryControlSha256(
        repositoryStaticControlSha256,
        worktreeRegistrySha256,
      ),
      repositoryStaticControlSha256,
      worktreeRegistrySha256,
      sourceDirectoryIdentitySha256,
      worktrees,
    });
  }

  async provisionWorktree(
    input: ArenaProvisionWorktreeInput,
  ): Promise<ArenaProvisionedWorktree> {
    const intents = await this.planWorktrees({
      admission: input.admission,
      contestants: [{
        runId: input.runId,
        contestantId: input.contestantId,
        worktreeId: input.worktreeId,
        intentId: input.intentId,
        occurredAt: input.occurredAt,
      }],
    });
    const intent = intents[0];
    if (!intent) {
      throw new ArenaGitError(
        "gitFailed",
        "Arena failed to create its durable worktree intent.",
      );
    }
    return this.ensureIntentProvisioned(intent, input.signal);
  }

  async planWorktrees(
    input: ArenaPlanWorktreesInput,
  ): Promise<readonly ArenaWorktreeRegistrationIntent[]> {
    this.assertAdmissionMatchesExecutor(input.admission);
    if (input.contestants.length === 0 || input.contestants.length > 8) {
      throw new ArenaGitError(
        "gitFailed",
        "Arena requires between one and eight worktree plans.",
      );
    }
    const baseRevision = input.admission.baseRevision;
    assertObjectId(
      baseRevision.objectFormat,
      baseRevision.oid,
      "Arena base revision",
    );
    const runId = input.contestants[0]?.runId;
    if (!runId
      || input.contestants.some((contestant) => contestant.runId !== runId)) {
      throw new ArenaGitError(
        "registrationMismatch",
        "One Arena worktree plan cannot cross run identities.",
      );
    }
    const seenContestants = new Set<string>();
    const seenWorktrees = new Set<string>();
    const seenTargets = new Set<string>();
    const drafts: Parameters<
      FileArenaWorktreeRegistrationStore["planMany"]
    >[0][number][] = [];
    const targets: {
      readonly contestant: ArenaPlanWorktreesInput["contestants"][number];
      readonly target: string;
    }[] = [];
    for (const contestant of input.contestants) {
      if (seenContestants.has(contestant.contestantId)
        || seenWorktrees.has(contestant.worktreeId)) {
        throw new ArenaGitError(
          "gitFailed",
          "Arena worktree plans require unique contestants and worktree IDs.",
        );
      }
      seenContestants.add(contestant.contestantId);
      seenWorktrees.add(contestant.worktreeId);
      const target = arenaContestantWorktreePath(
        this.privateWorkspaceRoot,
        contestant.runId,
        contestant.contestantId,
      );
      const targetKey = canonicalPath(target);
      if (seenTargets.has(targetKey)) {
        throw new ArenaGitError(
          "registrationMismatch",
          "Arena physical worktree identities collided.",
        );
      }
      seenTargets.add(targetKey);
      targets.push({ contestant, target });
    }

    // This must precede parent creation, intent publication, and every Git
    // worktree side effect. `core.longpaths=true` is not sufficient for all
    // linked-worktree code paths, so Hydra fails closed using the tracked
    // repository's worst-case legacy Windows path budget.
    if (process.platform === "win32") {
      const tracked = await this.git(
        this.workspaceRoot,
        ["ls-files", "--cached", "-z", "--"],
        { maxStdoutBytes: ARENA_TRACKED_PATHS_MAX_BYTES },
      );
      for (const { target } of targets) {
        try {
          const report = preflightArenaWorktreePathBudget(
            path.resolve(target),
            tracked.stdout,
          );
          if (!report.accepted) {
            throw new ArenaGitError(
              "pathBudget",
              `Arena worktree path exceeds the conservative Windows budget (${
                report.worstCaseUtf16UnitsWithMargin
              } > ${report.maxPathUtf16Units} UTF-16 units, reason ${
                report.reason
              }). Use a shorter extension storage location or shorten tracked repository paths.`,
            );
          }
        } catch (error) {
          if (error instanceof ArenaGitError) throw error;
          if (error instanceof ArenaPathBudgetError) {
            throw new ArenaGitError(
              "pathBudget",
              `Arena could not validate its Windows worktree path budget (${error.code}).`,
              { cause: error },
            );
          }
          throw error;
        }
      }
    }

    const parent = await ensureArenaPrivateDirectory(
      this.boundary,
      ["worktrees", "p"],
    );
    for (const { contestant, target } of targets) {
      if (!sameArenaPath(path.dirname(target), parent)
        || input.admission.worktrees.some((entry) =>
          sameArenaPath(entry.path, target))) {
        throw new ArenaGitError(
          "worktreeExists",
          "Arena refuses a plan whose exact private worktree target is already registered.",
        );
      }
      const lockReason = arenaWorktreeLockReason(
        contestant.runId,
        contestant.contestantId,
        contestant.worktreeId,
      );
      drafts.push({
        ...contestant,
        sourceDirectoryIdentitySha256:
          input.admission.sourceDirectoryIdentitySha256,
        repositoryIdentitySha256: input.admission.repositoryIdentitySha256,
        repositoryControlSha256: input.admission.repositoryControlSha256,
        repositoryStaticControlSha256:
          input.admission.repositoryStaticControlSha256,
        worktreeRegistrySha256: input.admission.worktreeRegistrySha256,
        baseRevision,
        baseContentSha256: input.admission.baseContentSha256,
        worktreePath: target,
        lockReason,
      });
    }
    return this.withRepositoryLease(
      input.admission.repositoryIdentitySha256,
      runId,
      () => this.registrations.planMany(drafts),
    );
  }

  async provisionPlannedWorktree(
    intent: ArenaWorktreeRegistrationIntent,
    signal?: AbortSignal,
  ): Promise<ArenaProvisionedWorktree> {
    return this.ensureIntentProvisioned(intent, signal);
  }

  async recoverProvisionedWorktree(
    runId: string,
    contestantId: string,
    signal?: AbortSignal,
  ): Promise<ArenaProvisionedWorktree | undefined> {
    const state = await this.registrations.load(runId, contestantId);
    if (!state) return undefined;
    return this.ensureIntentProvisioned(state.intent, signal);
  }

  /**
   * Reconstruct an authenticated cleanup handle after a restart without
   * requiring the contestant worktree to remain pristine. Candidate edits,
   * commits, and a prior exact unlock are permitted; path/directory identity,
   * durable intent/receipt, and Git registry ownership remain mandatory.
   */
  async recoverOwnedWorktree(
    runId: string,
    contestantId: string,
    signal?: AbortSignal,
  ): Promise<ArenaOwnedWorktree | undefined> {
    const state = await this.registrations.load(runId, contestantId);
    if (!state?.receipt) return undefined;
    return this.withRepositoryLease(
      state.intent.repositoryIdentitySha256,
      runId,
      () => this.bindOwnedReceipt(state.intent, state.receipt!, signal),
    );
  }

  /**
   * Capture the source controls through the same hardened Git runner used for
   * admission. Once a run owns registrations, repository controls exclude only
   * that run's authenticated worktrees.
   */
  async captureSourceState(
    admission: ArenaGitAdmission,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly sourceWorkspaceFingerprintSha256: string;
    readonly contentFingerprintSha256: string;
    readonly repositoryControlSha256: string;
    readonly head: ArenaGitObjectId;
  }> {
    this.assertAdmissionMatchesExecutor(admission);
    const sourceStat = await fs.lstat(this.workspaceRoot);
    const sourceDirectoryIdentitySha256 = hashCanonical(
      "hydra.arena.git.source-directory.v1\u0000",
      {
        sourceWorkspace: canonicalPath(this.workspaceRoot),
        sourceDirectoryIdentity: statIdentity(sourceStat),
      },
    );
    if (sourceDirectoryIdentitySha256
        !== admission.sourceDirectoryIdentitySha256) {
      throw new ArenaGitError(
        "worktreeStateMismatch",
        "Arena source workspace directory identity changed after admission.",
      );
    }
    const fingerprint = await this.captureFingerprint(
      this.workspaceRoot,
      signal,
    );
    const repositoryControlSha256 = runId && this.runClaims.has(runId)
      ? await this.captureRunRepositoryControlSha256(runId, signal)
      : await this.captureExactRepositoryControlSha256(signal);
    return Object.freeze({
      sourceWorkspaceFingerprintSha256: hashCanonical(
        "hydra.arena.git.source-workspace.v1\u0000",
        {
          baseContentSha256: fingerprint.sha256,
          sourceDirectoryIdentitySha256,
        },
      ),
      contentFingerprintSha256: fingerprint.sha256,
      repositoryControlSha256,
      head: {
        objectFormat: admission.objectFormat,
        oid: fingerprint.head,
      },
    });
  }

  async inspectPromotionWorkspace(
    admission: ArenaGitAdmission,
    runId: string,
    signal?: AbortSignal,
  ): Promise<ArenaPromotionWorkspaceSnapshot> {
    this.assertAdmissionMatchesExecutor(admission);
    const before = await this.captureSourceState(admission, undefined, signal);
    const status = await this.git(
      this.workspaceRoot,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
        "--no-renames",
      ],
      { signal },
    );
    const [registrationStates, worktrees, after] = await Promise.all([
      this.registrations.listRun(runId),
      this.listWorktrees(signal),
      this.captureSourceState(admission, undefined, signal),
    ]);
    if (canonicalJson(before) !== canonicalJson(after)) {
      throw new ArenaGitError(
        "worktreeStateMismatch",
        "Arena promotion source state changed during inspection.",
      );
    }
    const registeredPaths = new Set(registrationStates.map((state) =>
      canonicalPath(state.intent.worktreePath)));
    const arenaWorktreesAbsent = worktrees.every((entry) =>
      !registeredPaths.has(canonicalPath(entry.path)));
    return Object.freeze({
      head: after.head,
      sourceWorkspaceFingerprintSha256:
        after.sourceWorkspaceFingerprintSha256,
      contentFingerprintSha256: after.contentFingerprintSha256,
      repositoryControlSha256: after.repositoryControlSha256,
      arenaWorktreesAbsent,
      workspaceClean: status.stdout.length === 0,
    });
  }

  async runPromotionExclusive<T>(
    admission: ArenaGitAdmission,
    work: () => Promise<T>,
  ): Promise<T> {
    this.assertAdmissionMatchesExecutor(admission);
    return this.repositoryLeases.withUnownedRepository(
      admission.repositoryIdentitySha256,
      work,
    );
  }

  async checkPromotionCandidate(
    candidateInput: ArenaPromotionCandidate,
    signal?: AbortSignal,
  ): Promise<ArenaPromotionPatchCheck> {
    const candidate = validatePromotionCandidate(candidateInput);
    const conflicts = await promotionUntrackedConflicts(
      this.workspaceRoot,
      candidate.untrackedEntries,
    );
    let applicable = true;
    if (candidate.patch.byteLength > 0) {
      const result = await this.git(
        this.workspaceRoot,
        ["apply", "--check", "--binary", "--whitespace=nowarn", "-"],
        { allowedExitCodes: [0, 1], stdin: candidate.patch, signal },
      );
      applicable = result.exitCode === 0;
    }
    return Object.freeze({
      applicable,
      conflictPaths: Object.freeze([]),
      untrackedConflictPaths: conflicts,
    });
  }

  async applyPromotionCandidate(
    candidateInput: ArenaPromotionCandidate,
    signal?: AbortSignal,
  ): Promise<void> {
    const candidate = validatePromotionCandidate(candidateInput);
    const check = await this.checkPromotionCandidate(candidate, signal);
    if (!check.applicable
      || check.conflictPaths.length > 0
      || check.untrackedConflictPaths.length > 0) {
      throw new ArenaGitError(
        "worktreeStateMismatch",
        "Arena promotion candidate no longer applies without conflicts.",
      );
    }
    if (candidate.patch.byteLength > 0) {
      await this.git(
        this.workspaceRoot,
        ["apply", "--binary", "--whitespace=nowarn", "-"],
        { stdin: candidate.patch, signal },
      );
    }
    const conflicts = await promotionUntrackedConflicts(
      this.workspaceRoot,
      candidate.untrackedEntries,
    );
    if (conflicts.length > 0) {
      throw new ArenaGitError(
        "worktreeStateMismatch",
        "Arena promotion untracked targets changed during application.",
      );
    }
    for (const entry of candidate.untrackedEntries) {
      await publishPromotionUntrackedEntry(this.workspaceRoot, entry);
    }
  }

  /**
   * Capture comparison artifacts only after the caller's process supervisor
   * has proven quiescence. The patch is binary/full-index and untracked paths
   * are NUL framed; no shell, textconv, or external diff is involved.
   */
  async captureOwnedEvidenceState(
    owned: ArenaOwnedWorktree,
    signal?: AbortSignal,
  ): Promise<ArenaOwnedEvidenceState> {
    return this.withRepositoryLease(
      owned.repositoryIdentitySha256,
      owned.runId,
      async () => {
        await this.authenticateDurableWorktree(owned);
        await this.assertOwnedRegistration(owned, signal, false);
        const artifactDirectory = arenaContestantArtifactPath(
          this.privateWorkspaceRoot,
          owned.runId,
          owned.contestantId,
        );
        await ensureArenaPrivateDirectory(
          this.boundary,
          ["artifacts", owned.runId, owned.contestantId],
        );
        await assertArenaPrivateDirectory(artifactDirectory, this.boundary);
        await recoverArenaEvidenceStageTemps(
          artifactDirectory,
          ["patch.bin", "untracked-paths.v1.bin"],
          this.boundary,
        );
        const patch = await createArenaEvidenceStage(
          artifactDirectory,
          "patch.bin",
          this.boundary,
        );
        let untrackedPaths: MutableArenaEvidenceStage;
        try {
          untrackedPaths = await createArenaEvidenceStage(
            artifactDirectory,
            "untracked-paths.v1.bin",
            this.boundary,
          );
        } catch (error) {
          try {
            await discardArenaEvidenceStage(patch, this.boundary);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Arena evidence staging and cleanup both failed.",
            );
          }
          throw error;
        }
        const patchHash = createHash("sha256");
        const untrackedHash = createHash("sha256");
        let mutationMonitor: ReturnType<typeof watchDuelWorkspaceMutations>
          | undefined;
        let operations: readonly Promise<unknown>[] = [];
        try {
          mutationMonitor = watchDuelWorkspaceMutations(
            owned.worktreePath,
            { excludeHydraState: false },
          );
          const before = await this.captureFingerprint(
            owned.worktreePath,
            signal,
          );
          const patchWork = this.git(
              owned.worktreePath,
              [
                "diff",
                "--binary",
                "--full-index",
                "--no-ext-diff",
                "--no-textconv",
                owned.head.oid,
                "--",
              ],
              {
                maxStdoutBytes: MAX_ARENA_PATCH_BYTES,
                signal,
                stdoutSink: async (chunk) => {
                  patchHash.update(chunk);
                  await writeArenaEvidenceChunk(patch.handle, chunk);
                },
              },
            );
          const untrackedWork = this.git(
              owned.worktreePath,
              ["ls-files", "--others", "--exclude-standard", "-z", "--"],
              {
                maxStdoutBytes: MAX_ARENA_UNTRACKED_PATH_BYTES,
                signal,
                stdoutSink: async (chunk) => {
                  untrackedHash.update(chunk);
                  await writeArenaEvidenceChunk(untrackedPaths.handle, chunk);
                },
              },
            );
          const ignoredWork = this.git(
            owned.worktreePath,
            [
              "ls-files",
              "--others",
              "--ignored",
              "--exclude-standard",
              "-z",
              "--",
            ],
            {
              maxStdoutBytes: MAX_ARENA_UNTRACKED_PATH_BYTES,
              signal,
            },
          );
          operations = [patchWork, untrackedWork, ignoredWork];
          await Promise.all(operations);
          const ignored = await ignoredWork;
          if (ignored.stdout.byteLength > 0) {
            throw new ArenaGitError(
              "worktreeStateMismatch",
              "Arena stage 3 refuses ignored contestant files because their bytes are outside the retained evidence set.",
            );
          }
          const fingerprint = await this.captureFingerprint(
            owned.worktreePath,
            signal,
          );
          await mutationMonitor.settle();
          if (mutationMonitor.error || mutationMonitor.changed) {
            throw new ArenaGitError(
              "worktreeStateMismatch",
              `Arena contestant changed during evidence capture${
                mutationMonitor.changedPaths.length > 0
                  ? `: ${mutationMonitor.changedPaths.join(", ")}`
                  : "."
              }`,
            );
          }
          if (before.sha256 !== fingerprint.sha256
            || before.head !== fingerprint.head) {
            throw new ArenaGitError(
              "worktreeStateMismatch",
              "Arena contestant fingerprint changed during evidence capture.",
            );
          }
          const sealedPatch = await sealArenaEvidenceStage(
            patch,
            patchHash.digest("hex"),
            this.boundary,
          );
          const sealedUntrackedPaths = await sealArenaEvidenceStage(
            untrackedPaths,
            untrackedHash.digest("hex"),
            this.boundary,
          );
          assertObjectId(
            owned.head.objectFormat,
            fingerprint.head,
            "contestant HEAD",
          );
          return Object.freeze({
            finalHead: {
              objectFormat: owned.head.objectFormat,
              oid: fingerprint.head,
            },
            fingerprint,
            patch: sealedPatch,
            untrackedPaths: sealedUntrackedPaths,
          });
        } catch (error) {
          await Promise.allSettled(operations);
          const cleanup = await Promise.allSettled([
            discardArenaEvidenceStage(patch, this.boundary),
            discardArenaEvidenceStage(untrackedPaths, this.boundary),
          ]);
          const cleanupErrors = cleanup.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []);
          if (cleanupErrors.length > 0) {
            throw new AggregateError(
              [error, ...cleanupErrors],
              "Arena evidence capture and cleanup both failed.",
            );
          }
          throw error;
        } finally {
          mutationMonitor?.close();
        }
      },
    );
  }

  async captureOwnedEvidenceIdentity(
    owned: ArenaOwnedWorktree,
    signal?: AbortSignal,
  ): Promise<Pick<ArenaOwnedEvidenceState, "finalHead" | "fingerprint">> {
    return this.withRepositoryLease(
      owned.repositoryIdentitySha256,
      owned.runId,
      async () => {
        await this.authenticateDurableWorktree(owned);
        await this.assertOwnedRegistration(owned, signal, false);
        const [headText, fingerprint, ignored] = await Promise.all([
          this.gitText(
            owned.worktreePath,
            ["rev-parse", "--verify", "HEAD^{commit}"],
            signal,
          ),
          this.captureFingerprint(owned.worktreePath, signal),
          this.git(
            owned.worktreePath,
            [
              "ls-files",
              "--others",
              "--ignored",
              "--exclude-standard",
              "-z",
              "--",
            ],
            {
              maxStdoutBytes: MAX_ARENA_UNTRACKED_PATH_BYTES,
              signal,
            },
          ),
        ]);
        if (ignored.stdout.byteLength > 0) {
          throw new ArenaGitError(
            "worktreeStateMismatch",
            "Arena stage 3 refuses ignored contestant files because their bytes are outside the retained evidence set.",
          );
        }
        assertObjectId(owned.head.objectFormat, headText, "contestant HEAD");
        if (fingerprint.head !== headText) {
          throw new ArenaGitError(
            "worktreeStateMismatch",
            "Arena contestant HEAD changed during evidence recheck.",
          );
        }
        return Object.freeze({
          finalHead: {
            objectFormat: owned.head.objectFormat,
            oid: headText,
          },
          fingerprint,
        });
      },
    );
  }

  async verifyRegisteredWorktree(
    input: {
      readonly runId: string;
      readonly contestantId: string;
      readonly worktreeId: string;
      readonly baseRevision: ArenaGitObjectId;
      readonly expectedBaseContentSha256: string;
      readonly target?: string;
      readonly lockReason?: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<ArenaVerifiedWorktree> {
    const target = input.target ?? arenaContestantWorktreePath(
      this.privateWorkspaceRoot,
      input.runId,
      input.contestantId,
    );
    const expectedLockReason = input.lockReason ?? arenaWorktreeLockReason(
      input.runId,
      input.contestantId,
      input.worktreeId,
    );
    await this.assertExactWorktreeTarget(
      target,
      input.runId,
      input.contestantId,
    );
    const realTarget = await fs.realpath(target);
    const entry = (await this.listWorktrees(input.signal)).find((candidate) =>
      sameArenaPath(candidate.path, realTarget));
    if (!entry
      || entry.bare
      || !entry.detached
      || entry.branch !== null
      || entry.head !== input.baseRevision.oid
      || entry.lockedReason !== expectedLockReason) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena worktree registration, lock reason, detached state, or HEAD does not match the locked target.",
      );
    }
    const head = await this.gitText(
      target,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      input.signal,
    );
    if (head !== input.baseRevision.oid) {
      throw new ArenaGitError(
        "worktreeStateMismatch",
        "Arena worktree HEAD does not match the locked base.",
      );
    }
    const symbolicHead = await this.git(
      target,
      ["symbolic-ref", "-q", "HEAD"],
      { allowedExitCodes: [0, 1], signal: input.signal },
    );
    if (symbolicHead.exitCode === 0 || symbolicHead.stdout.length !== 0) {
      throw new ArenaGitError(
        "worktreeStateMismatch",
        "Arena worktree HEAD is not detached.",
      );
    }
    const fingerprint = await this.captureFingerprint(target, input.signal);
    if (fingerprint.sha256 !== input.expectedBaseContentSha256
      || fingerprint.head !== input.baseRevision.oid) {
      throw new ArenaGitError(
        "worktreeStateMismatch",
        "Arena worktree initial content does not match the locked base content.",
      );
    }
    const stat = await fs.lstat(realTarget);
    const directoryIdentitySha256 = hashCanonical(
      "hydra.arena.git.worktree-directory.v1\u0000",
      {
        path: canonicalPath(realTarget),
        identity: statIdentity(stat),
      },
    );
    const gitRegistrationSha256 = hashCanonical(
      "hydra.arena.git.worktree-registration.v1\u0000",
      {
        worktreeId: input.worktreeId,
        directoryIdentitySha256,
        head: input.baseRevision,
        lockReason: expectedLockReason,
        detached: true,
      },
    );
    return Object.freeze({
      runId: input.runId,
      contestantId: input.contestantId,
      worktreeId: input.worktreeId,
      worktreePath: target,
      realWorktreePath: realTarget,
      lockReason: expectedLockReason,
      gitRegistrationSha256,
      directoryIdentitySha256,
      head: input.baseRevision,
      fingerprint,
    });
  }

  private async ensureIntentProvisioned(
    intent: ArenaWorktreeRegistrationIntent,
    signal?: AbortSignal,
  ): Promise<ArenaProvisionedWorktree> {
    const paths = arenaWorktreeRegistrationPaths(
      this.privateWorkspaceRoot,
      intent.runId,
      intent.contestantId,
    );
    return this.withRepositoryLease(
      intent.repositoryIdentitySha256,
      intent.runId,
      () => serializeArenaPrivateWork(
        this.boundary,
        paths.operationLeasePath,
        async () => {
        const state = await this.registrations.load(
          intent.runId,
          intent.contestantId,
        );
        if (!state || state.intent.intentSha256 !== intent.intentSha256) {
          throw new ArenaGitError(
            "registrationMismatch",
            "Arena provisioning lost or changed its durable registration intent.",
          );
        }
        const admission = await this.inspectAdmission(signal);
        const runStates = await this.registrations.listRun(intent.runId);
        await this.assertIntentMatchesAdmission(
          intent,
          admission,
          runStates,
          signal,
        );
        await this.assertProvisioningManifestAuthority(
          intent,
          runStates,
          admission,
        );

        if (state.receipt) {
          const verified = await this.verifyRegisteredWorktree({
            runId: intent.runId,
            contestantId: intent.contestantId,
            worktreeId: intent.worktreeId,
            baseRevision: intent.baseRevision,
            expectedBaseContentSha256: intent.baseContentSha256,
            target: intent.worktreePath,
            lockReason: intent.lockReason,
            signal,
          });
          return this.bindDurableReceipt(intent, state.receipt, verified);
        }

        const entries = admission.worktrees.filter((entry) =>
          sameArenaPath(entry.path, intent.worktreePath));
        if (entries.length > 1) {
          throw new ArenaGitError(
            "registrationMismatch",
            "Arena worktree target has duplicate Git registrations.",
          );
        }
        let targetExists = false;
        try {
          const stat = await fs.lstat(intent.worktreePath);
          targetExists = true;
          if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new ArenaGitError(
              "unsafePath",
              "Arena refuses a linked or non-directory worktree target.",
            );
          }
        } catch (error) {
          if (error instanceof ArenaGitError) throw error;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        if (entries.length === 0) {
          if (targetExists) {
            throw new ArenaGitError(
              "worktreeExists",
              "Arena refuses an unregistered directory at its exact worktree target.",
            );
          }
          // The manifest is independently append-only and is not serialized by
          // the repository lease. Replay it again at the final mutation
          // boundary so a compromise, finalization, or authority change that
          // raced admission cannot authorize `git worktree add`.
          const currentAdmission = await this.inspectAdmission(signal);
          const currentRunStates = await this.registrations.listRun(
            intent.runId,
          );
          await this.assertIntentMatchesAdmission(
            intent,
            currentAdmission,
            currentRunStates,
            signal,
          );
          await this.assertProvisioningManifestAuthority(
            intent,
            currentRunStates,
            currentAdmission,
          );
          await this.git(
            this.workspaceRoot,
            [
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
            ],
            { signal, timeoutMs: 120_000 },
          );
        }

        if (entries.length === 0 || targetExists) {
          const privateWorktreePath = await ensureArenaPrivateDirectory(
            this.boundary,
            [
              "worktrees",
              "p",
              arenaPhysicalWorktreeSegment(
                intent.runId,
                intent.contestantId,
              ),
            ],
          );
          if (!sameArenaPath(privateWorktreePath, intent.worktreePath)) {
            throw new ArenaGitError(
              "registrationMismatch",
              "Arena worktree target does not match its private directory binding.",
            );
          }
        }

        const verified = await this.verifyRegisteredWorktree({
          runId: intent.runId,
          contestantId: intent.contestantId,
          worktreeId: intent.worktreeId,
          baseRevision: intent.baseRevision,
          expectedBaseContentSha256: intent.baseContentSha256,
          target: intent.worktreePath,
          lockReason: intent.lockReason,
          signal,
        });
        const receipt = await this.registrations.recordReceipt({
          intentSha256: intent.intentSha256,
          runId: intent.runId,
          contestantId: intent.contestantId,
          worktreeId: intent.worktreeId,
          registeredAt: new Date().toISOString(),
          realWorktreePathSha256: hashCanonical(
            "hydra.arena.git.real-worktree-path.v1\u0000",
            canonicalPath(verified.realWorktreePath),
          ),
          directoryIdentitySha256: verified.directoryIdentitySha256,
          gitRegistrationSha256: verified.gitRegistrationSha256,
          head: verified.head,
          initialFingerprintSha256: verified.fingerprint.sha256,
        });
        return this.bindDurableReceipt(intent, receipt, verified);
        },
      ),
    );
  }

  private async assertProvisioningManifestAuthority(
    intent: ArenaWorktreeRegistrationIntent,
    runStates: readonly {
      readonly intent: ArenaWorktreeRegistrationIntent;
      readonly receipt?: ArenaWorktreeRegistrationReceipt;
    }[],
    admission: ArenaGitAdmission,
  ): Promise<void> {
    const store = await openFileArenaManifestStore(
      this.privateWorkspaceRoot,
    );
    const replay = await store.load(intent.runId);
    const lockedContestant = replay?.lock.contestants.find((candidate) =>
      candidate.contestantId === intent.contestantId);
    const contestant = replay?.contestants.find((candidate) =>
      candidate.lock.contestantId === intent.contestantId);
    const firstObservation = replay?.mainWorkspaceObservations[0];
    const latestObservation = replay?.mainWorkspaceObservations.at(-1);
    const firstObservationPayload = firstObservation?.payload as
      | ArenaMainWorkspaceObservedPayload
      | undefined;
    const latestObservationPayload = latestObservation?.payload as
      | ArenaMainWorkspaceObservedPayload
      | undefined;
    const expectedTarget = arenaContestantWorktreePath(
      this.privateWorkspaceRoot,
      intent.runId,
      intent.contestantId,
    );

    if (!replay
      || replay.finalization
      || replay.compromised
      || !lockedContestant
      || !contestant
      || lockedContestant.worktreeId !== intent.worktreeId
      || !sameArenaPath(expectedTarget, intent.worktreePath)
      || replay.lock.base.repositoryIdentitySha256
        !== intent.repositoryIdentitySha256
      || replay.lock.base.repositoryIdentitySha256
        !== admission.repositoryIdentitySha256
      || replay.lock.base.sourceWorkspaceFingerprintSha256
        !== admission.sourceWorkspaceFingerprintSha256
      || replay.lock.base.repositoryControlSha256
        !== intent.repositoryControlSha256
      || replay.lock.base.baseContentSha256 !== intent.baseContentSha256
      || replay.lock.base.baseContentSha256
        !== admission.baseContentSha256
      || replay.lock.base.revision.objectFormat
        !== intent.baseRevision.objectFormat
      || replay.lock.base.revision.oid !== intent.baseRevision.oid
      || replay.lock.base.revision.objectFormat
        !== admission.baseRevision.objectFormat
      || replay.lock.base.revision.oid !== admission.baseRevision.oid
      || firstObservationPayload?.observationKind !== "monitorStarted"
      || latestObservationPayload === undefined
      || latestObservationPayload.monitorEpochId
        !== firstObservationPayload.monitorEpochId
      || latestObservationPayload.observationKind === "postEvidence"
      || latestObservationPayload.status !== "unchanged"
      || latestObservationPayload.watcherChanged
      || latestObservationPayload.reasonCode !== null
      || latestObservationPayload.sourceWorkspaceFingerprintSha256
        !== replay.lock.base.sourceWorkspaceFingerprintSha256
      || latestObservationPayload.repositoryControlSha256
        !== replay.lock.base.repositoryControlSha256
      || latestObservationPayload.head === null
      || latestObservationPayload.head.objectFormat
        !== replay.lock.base.revision.objectFormat
      || latestObservationPayload.head.oid
        !== replay.lock.base.revision.oid
      || replay.contestants.some((candidate) =>
        candidate.started !== undefined
        || candidate.finished !== undefined
        || candidate.evidencePreserved !== undefined)) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena provisioning requires current uncompromised, unfinalized manifest authority and its original live monitor epoch.",
      );
    }

    for (const state of runStates) {
      const locked = replay.lock.contestants.find((candidate) =>
        candidate.contestantId === state.intent.contestantId);
      const replayed = replay.contestants.find((candidate) =>
        candidate.lock.contestantId === state.intent.contestantId);
      const derivedTarget = arenaContestantWorktreePath(
        this.privateWorkspaceRoot,
        intent.runId,
        state.intent.contestantId,
      );
      const registered = replayed?.worktreeRegistered?.payload as
        | ArenaWorktreeRegisteredPayload
        | undefined;
      if (state.intent.runId !== intent.runId
        || !locked
        || !replayed
        || locked.worktreeId !== state.intent.worktreeId
        || !sameArenaPath(derivedTarget, state.intent.worktreePath)
        || (!state.receipt && registered !== undefined)
        || (state.receipt !== undefined
          && registered !== undefined
          && registered.registrationSha256
            !== state.receipt.registrationSha256)) {
        throw new ArenaGitError(
          "registrationMismatch",
          "Arena provisioning refuses an unauthorized or manifest-divergent durable worktree intent.",
        );
      }
    }
    for (const replayed of replay.contestants) {
      const registered = replayed.worktreeRegistered?.payload as
        | ArenaWorktreeRegisteredPayload
        | undefined;
      if (!registered) continue;
      const durable = runStates.find((state) =>
        state.intent.contestantId === replayed.lock.contestantId);
      if (!durable?.receipt
        || durable.receipt.registrationSha256
          !== registered.registrationSha256) {
        throw new ArenaGitError(
          "registrationMismatch",
          "Arena provisioning refuses a manifest registration without its exact durable receipt.",
        );
      }
    }
  }

  private bindDurableReceipt(
    intent: ArenaWorktreeRegistrationIntent,
    receipt: ArenaWorktreeRegistrationReceipt,
    verified: ArenaVerifiedWorktree,
  ): ArenaProvisionedWorktree {
    const realPathSha256 = hashCanonical(
      "hydra.arena.git.real-worktree-path.v1\u0000",
      canonicalPath(verified.realWorktreePath),
    );
    if (receipt.intentSha256 !== intent.intentSha256
      || receipt.runId !== verified.runId
      || receipt.contestantId !== verified.contestantId
      || receipt.worktreeId !== verified.worktreeId
      || receipt.realWorktreePathSha256 !== realPathSha256
      || receipt.directoryIdentitySha256
        !== verified.directoryIdentitySha256
      || receipt.gitRegistrationSha256 !== verified.gitRegistrationSha256
      || receipt.head.objectFormat !== verified.head.objectFormat
      || receipt.head.oid !== verified.head.oid
      || receipt.initialFingerprintSha256 !== verified.fingerprint.sha256) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena durable registration receipt no longer matches the exact Git worktree.",
      );
    }
    return Object.freeze({
      ...verified,
      intentSha256: intent.intentSha256,
      repositoryIdentitySha256: intent.repositoryIdentitySha256,
      registrationSha256: receipt.registrationSha256,
      initialFingerprintSha256: receipt.initialFingerprintSha256,
    });
  }

  private async bindOwnedReceipt(
    intent: ArenaWorktreeRegistrationIntent,
    receipt: ArenaWorktreeRegistrationReceipt,
    signal?: AbortSignal,
  ): Promise<ArenaOwnedWorktree> {
    await this.assertExactWorktreeTarget(
      intent.worktreePath,
      intent.runId,
      intent.contestantId,
    );
    const realWorktreePath = await fs.realpath(intent.worktreePath);
    const stat = await fs.lstat(realWorktreePath);
    const directoryIdentitySha256 = hashCanonical(
      "hydra.arena.git.worktree-directory.v1\u0000",
      {
        path: canonicalPath(realWorktreePath),
        identity: statIdentity(stat),
      },
    );
    const realWorktreePathSha256 = hashCanonical(
      "hydra.arena.git.real-worktree-path.v1\u0000",
      canonicalPath(realWorktreePath),
    );
    const expectedGitRegistrationSha256 = hashCanonical(
      "hydra.arena.git.worktree-registration.v1\u0000",
      {
        worktreeId: intent.worktreeId,
        directoryIdentitySha256,
        head: intent.baseRevision,
        lockReason: intent.lockReason,
        detached: true,
      },
    );
    const entry = (await this.listWorktrees(signal)).find((candidate) =>
      sameArenaPath(candidate.path, realWorktreePath));
    if (!entry
      || entry.bare
      || (entry.lockedReason !== null
        && entry.lockedReason !== intent.lockReason)
      || receipt.intentSha256 !== intent.intentSha256
      || receipt.runId !== intent.runId
      || receipt.contestantId !== intent.contestantId
      || receipt.worktreeId !== intent.worktreeId
      || receipt.realWorktreePathSha256 !== realWorktreePathSha256
      || receipt.directoryIdentitySha256 !== directoryIdentitySha256
      || receipt.gitRegistrationSha256
        !== expectedGitRegistrationSha256
      || receipt.head.objectFormat !== intent.baseRevision.objectFormat
      || receipt.head.oid !== intent.baseRevision.oid
      || receipt.initialFingerprintSha256 !== intent.baseContentSha256) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena durable registration no longer identifies the exact owned worktree.",
      );
    }
    const owned: ArenaOwnedWorktree = Object.freeze({
      runId: intent.runId,
      contestantId: intent.contestantId,
      worktreeId: intent.worktreeId,
      worktreePath: intent.worktreePath,
      realWorktreePath,
      lockReason: intent.lockReason,
      registrationSha256: receipt.registrationSha256,
      gitRegistrationSha256: receipt.gitRegistrationSha256,
      intentSha256: intent.intentSha256,
      repositoryIdentitySha256: intent.repositoryIdentitySha256,
      directoryIdentitySha256,
      head: intent.baseRevision,
      initialFingerprintSha256: receipt.initialFingerprintSha256,
    });
    await this.authenticateDurableWorktree(owned);
    return owned;
  }

  private async assertIntentMatchesAdmission(
    intent: ArenaWorktreeRegistrationIntent,
    admission: ArenaGitAdmission,
    runStates: readonly {
      readonly intent: ArenaWorktreeRegistrationIntent;
      readonly receipt?: ArenaWorktreeRegistrationReceipt;
    }[],
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertAdmissionMatchesExecutor(admission);
    if (intent.sourceDirectoryIdentitySha256
        !== admission.sourceDirectoryIdentitySha256
      || intent.repositoryIdentitySha256
        !== admission.repositoryIdentitySha256
      || intent.repositoryStaticControlSha256
        !== admission.repositoryStaticControlSha256
      || intent.baseContentSha256 !== admission.baseContentSha256
      || intent.baseRevision.objectFormat
        !== admission.baseRevision.objectFormat
      || intent.baseRevision.oid !== admission.baseRevision.oid) {
      throw new ArenaGitError(
        "worktreeStateMismatch",
        "Arena source identity, controls, HEAD, or content changed after registration intent.",
      );
    }
    const ownedPaths = new Map<string, typeof runStates[number]>();
    for (const state of runStates) {
      if (state.intent.repositoryIdentitySha256
          !== intent.repositoryIdentitySha256
        || state.intent.sourceDirectoryIdentitySha256
          !== intent.sourceDirectoryIdentitySha256
        || state.intent.repositoryStaticControlSha256
          !== intent.repositoryStaticControlSha256
        || state.intent.worktreeRegistrySha256
          !== intent.worktreeRegistrySha256
        || state.intent.baseRevision.objectFormat
          !== intent.baseRevision.objectFormat
        || state.intent.baseRevision.oid !== intent.baseRevision.oid
        || state.intent.baseContentSha256 !== intent.baseContentSha256) {
        throw new ArenaGitError(
          "registrationMismatch",
          "Arena run intents do not share one locked repository baseline.",
        );
      }
      const entry = admission.worktrees.find((candidate) =>
        sameArenaPath(candidate.path, state.intent.worktreePath));
      if (!entry) continue;
      if (!state.receipt
        && state.intent.intentSha256 !== intent.intentSha256) {
        throw new ArenaGitError(
          "registrationMismatch",
          "Arena must recover an earlier unreceipted worktree before provisioning another contestant.",
        );
      }
      if (!state.receipt) {
        ownedPaths.set(canonicalPath(state.intent.worktreePath), state);
        continue;
      }
      await this.verifyRegisteredWorktree({
        runId: state.intent.runId,
        contestantId: state.intent.contestantId,
        worktreeId: state.intent.worktreeId,
        baseRevision: state.intent.baseRevision,
        expectedBaseContentSha256: state.intent.baseContentSha256,
        target: state.intent.worktreePath,
        lockReason: state.intent.lockReason,
        signal,
      });
      ownedPaths.set(canonicalPath(state.intent.worktreePath), state);
    }
    for (const entry of admission.worktrees) {
      const state = ownedPaths.get(canonicalPath(entry.path));
      if (state && !state.receipt
        && state.intent.intentSha256 !== intent.intentSha256) {
        throw new ArenaGitError(
          "registrationMismatch",
          "Arena must recover an earlier unreceipted worktree before provisioning another contestant.",
        );
      }
    }
    const baseline = admission.worktrees.filter((entry) =>
      !ownedPaths.has(canonicalPath(entry.path)));
    if (arenaWorktreeRegistrySha256(baseline)
      !== intent.worktreeRegistrySha256) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena worktree registry changed outside the run's durable intents.",
      );
    }
    if (baseline.length === admission.worktrees.length
      && admission.repositoryControlSha256
        !== intent.repositoryControlSha256) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena repository controls changed before worktree creation.",
      );
    }
  }

  private assertAdmissionMatchesExecutor(admission: ArenaGitAdmission): void {
    if (admission.policy !== ARENA_GIT_POLICY_VERSION
      || !sameArenaPath(admission.gitExecutable, this.gitExecutable)
      || !sameArenaPath(admission.sourceWorkspacePath, this.workspaceRoot)) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena admission does not belong to this exact executor and source workspace.",
      );
    }
  }

  private async withRepositoryLease<T>(
    repositoryIdentitySha256: string,
    runId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(repositoryIdentitySha256)) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena repository lease identity is invalid.",
      );
    }
    const claim = this.runClaims.get(runId);
    if (!claim
      || claim.repositoryIdentitySha256 !== repositoryIdentitySha256) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena repository mutation requires the exact active full-run claim.",
      );
    }
    try {
      return await claim.runExclusive(work);
    } catch (error) {
      if (error instanceof ArenaGitError) throw error;
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena repository run claim was lost during an operation.",
        { cause: error },
      );
    }
  }

  async unlockOwnedWorktree(
    provisioned: ArenaOwnedWorktree,
    signal?: AbortSignal,
  ): Promise<"succeeded" | "notNeeded"> {
    return this.withRepositoryLease(
      provisioned.repositoryIdentitySha256,
      provisioned.runId,
      () => this.unlockOwnedWorktreeLeased(provisioned, signal),
    );
  }

  private async unlockOwnedWorktreeLeased(
    provisioned: ArenaOwnedWorktree,
    signal?: AbortSignal,
  ): Promise<"succeeded" | "notNeeded"> {
    await this.assertCleanupStepAuthorized(
      provisioned,
      "unlockGitWorktree",
    );
    await this.authenticateDurableWorktree(provisioned);
    const entry = await this.assertOwnedRegistration(provisioned, signal, false);
    if (entry.lockedReason === null) return "notNeeded";
    if (entry.lockedReason !== provisioned.lockReason) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena refuses to unlock a worktree with a different lock reason.",
      );
    }
    await this.git(
      this.workspaceRoot,
      ["worktree", "unlock", "--", provisioned.worktreePath],
      { signal },
    );
    const after = await this.assertOwnedRegistration(provisioned, signal, false);
    if (after.lockedReason !== null) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Git still reports the Arena worktree as locked.",
      );
    }
    return "succeeded";
  }

  async removeOwnedWorktree(
    provisioned: ArenaOwnedWorktree,
    signal?: AbortSignal,
  ): Promise<"succeeded" | "notNeeded"> {
    return this.withRepositoryLease(
      provisioned.repositoryIdentitySha256,
      provisioned.runId,
      () => this.removeOwnedWorktreeLeased(provisioned, signal),
    );
  }

  private async removeOwnedWorktreeLeased(
    provisioned: ArenaOwnedWorktree,
    signal?: AbortSignal,
  ): Promise<"succeeded" | "notNeeded"> {
    await this.assertCleanupStepAuthorized(
      provisioned,
      "removeGitWorktree",
    );
    await this.authenticateDurableWorktree(provisioned);
    const entries = await this.listWorktrees(signal);
    const existing = entries.find((entry) =>
      sameArenaPath(entry.path, provisioned.realWorktreePath));
    if (!existing) return "notNeeded";
    await this.assertOwnedRegistration(provisioned, signal, false);
    if (existing.lockedReason !== null) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena worktree must be exactly unlocked before removal.",
      );
    }
    await this.git(
      this.workspaceRoot,
      ["worktree", "remove", "--force", "--", provisioned.worktreePath],
      { signal, timeoutMs: 120_000 },
    );
    if ((await this.listWorktrees(signal)).some((entry) =>
      sameArenaPath(entry.path, provisioned.realWorktreePath))) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Git still reports the removed Arena worktree.",
      );
    }
    return "succeeded";
  }

  async removeResidualDirectory(
    provisioned: ArenaOwnedWorktree,
    signal?: AbortSignal,
  ): Promise<"succeeded" | "notNeeded"> {
    return this.withRepositoryLease(
      provisioned.repositoryIdentitySha256,
      provisioned.runId,
      () => this.removeResidualDirectoryLeased(provisioned, signal),
    );
  }

  private async removeResidualDirectoryLeased(
    provisioned: ArenaOwnedWorktree,
    signal?: AbortSignal,
  ): Promise<"succeeded" | "notNeeded"> {
    await this.assertCleanupStepAuthorized(
      provisioned,
      "removeResidualDirectory",
    );
    await this.authenticateDurableWorktree(provisioned);
    if ((await this.listWorktrees(signal)).some((entry) =>
      sameArenaPath(entry.path, provisioned.realWorktreePath))) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena refuses residual cleanup while Git still reports the worktree.",
      );
    }
    const expected = arenaContestantWorktreePath(
      this.privateWorkspaceRoot,
      provisioned.runId,
      provisioned.contestantId,
    );
    if (!sameArenaPath(expected, provisioned.worktreePath)) {
      throw new ArenaGitError(
        "unsafePath",
        "Arena residual cleanup target differs from its exact derived path.",
      );
    }
    const runParent = path.dirname(expected);
    await assertArenaPrivateDirectory(runParent, this.boundary);
    let targetStat: Stats;
    try {
      targetStat = await fs.lstat(expected);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "notNeeded";
      }
      throw error;
    }
    void targetStat;
    throw new ArenaGitError(
      "worktreeExists",
      "Arena found a residual worktree directory. Stage-2 integration fails closed instead of recursively deleting a path that could be swapped; exact quarantine cleanup remains pending.",
    );
  }

  async captureCleanupPostcondition(
    provisioned: ArenaOwnedWorktree,
    step: Exclude<ArenaCleanupStep, "quiesceProcesses">,
    signal?: AbortSignal,
  ): Promise<ArenaCleanupPostcondition> {
    const worktreePathSha256 = hashCanonical(
      "hydra.arena.cleanup-worktree-path.v1\u0000",
      canonicalPath(provisioned.worktreePath),
    );
    return this.withRepositoryLease(
      provisioned.repositoryIdentitySha256,
      provisioned.runId,
      async () => {
        await this.assertCleanupStepAuthorized(
          provisioned,
          step,
          true,
        );
        if (step === "verifyTarget") {
          await this.authenticateDurableWorktree(provisioned);
          await this.assertOwnedRegistration(provisioned, signal, false);
          return Object.freeze({
            kind: "ownedTarget",
            worktreePathSha256,
            directoryIdentitySha256:
              provisioned.directoryIdentitySha256,
            gitRegistrationSha256:
              provisioned.gitRegistrationSha256,
          });
        }
        const entries = await this.listWorktrees(signal);
        const entry = entries.find((candidate) =>
          sameArenaPath(candidate.path, provisioned.realWorktreePath));
        if (step === "unlockGitWorktree") {
          if (!entry || entry.lockedReason !== null) {
            throw new ArenaGitError(
              "registrationMismatch",
              "Arena cleanup receipt requires the exact unlocked Git row.",
            );
          }
          return Object.freeze({
            kind: "gitLockState",
            worktreePathSha256,
            gitRegistrationSha256:
              provisioned.gitRegistrationSha256,
            locked: false,
            registryEntrySha256: hashCanonical(
              "hydra.arena.cleanup-registry-entry.v1\u0000",
              entry,
            ),
          });
        }
        if (entry) {
          throw new ArenaGitError(
            "registrationMismatch",
            "Arena cleanup absence receipt found a surviving Git row.",
          );
        }
        if (step === "removeGitWorktree") {
          return Object.freeze({
            kind: "gitRemoval",
            worktreePathSha256,
            registryAbsent: true,
          });
        }
        if (step === "verifyGitRegistrationGone") {
          return Object.freeze({
            kind: "gitRegistryAbsence",
            worktreePathSha256,
            registrySha256: arenaWorktreeRegistrySha256(entries),
            absent: true,
          });
        }
        try {
          await fs.lstat(provisioned.worktreePath);
          throw new ArenaGitError(
            "worktreeExists",
            "Arena residual-directory receipt found a surviving path.",
          );
        } catch (error) {
          if (error instanceof ArenaGitError) throw error;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return Object.freeze({
          kind: "pathAbsence",
          worktreePathSha256,
          absent: true,
        });
      },
    );
  }

  async listWorktrees(signal?: AbortSignal): Promise<readonly ArenaGitWorktreeEntry[]> {
    const result = await this.git(
      this.workspaceRoot,
      ["worktree", "list", "--porcelain", "-z"],
      { signal },
    );
    return parseArenaWorktreeListPorcelainZ(result.stdout);
  }

  async captureRunRepositoryControlSha256(
    runId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const localClaim = this.runClaims.get(runId);
    if (!localClaim) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena control capture requires the active run claim.",
      );
    }
    return this.withRepositoryLease(
      localClaim.repositoryIdentitySha256,
      runId,
      () => this.captureRegisteredRunControlWithoutLease(
        runId,
        localClaim.repositoryIdentitySha256,
        signal,
      ),
    );
  }

  private async captureRegisteredRunControlWithoutLease(
    runId: string,
    repositoryIdentitySha256: string,
    signal?: AbortSignal,
    allowNoIntents = false,
  ): Promise<string> {
    const states = await this.registrations.listRun(runId);
    if (states.length === 0) {
      if (allowNoIntents) {
        return this.captureExactRepositoryControlSha256(signal);
      }
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena cannot exclude repository controls for a run without durable intents.",
      );
    }
    const worktrees = await this.listWorktrees(signal);
    const owned = new Set<string>();
    for (const state of states) {
      if (state.intent.repositoryIdentitySha256 !== repositoryIdentitySha256) {
        throw new ArenaGitError(
          "registrationMismatch",
          "Arena run registrations cross repository identities.",
        );
      }
      const registered = worktrees.some((entry) =>
        sameArenaPath(entry.path, state.intent.worktreePath));
      if (!state.receipt) {
        if (registered) {
          throw new ArenaGitError(
            "registrationMismatch",
            "Arena cannot exclude an unreceipted worktree registration.",
          );
        }
        continue;
      }
      await this.verifyMonitoredOwnedWorktree(
        state.intent,
        state.receipt,
        signal,
      );
      owned.add(canonicalPath(state.intent.worktreePath));
    }
    const repositoryStaticControlSha256 =
      await this.captureRepositoryStaticControlSha256(signal);
    return arenaRepositoryControlSha256(
      repositoryStaticControlSha256,
      arenaWorktreeRegistrySha256(worktrees.filter((entry) =>
        !owned.has(canonicalPath(entry.path)))),
    );
  }

  async captureExactRepositoryControlSha256(
    signal?: AbortSignal,
  ): Promise<string> {
    const [repositoryStaticControlSha256, worktrees] = await Promise.all([
      this.captureRepositoryStaticControlSha256(signal),
      this.listWorktrees(signal),
    ]);
    return arenaRepositoryControlSha256(
      repositoryStaticControlSha256,
      arenaWorktreeRegistrySha256(worktrees),
    );
  }

  private async verifyRepositoryRunRelease(
    runId: string,
    claimSha256: string,
  ): Promise<string> {
    const [store, states, worktrees] = await Promise.all([
      openFileArenaManifestStore(this.privateWorkspaceRoot),
      this.registrations.listRun(runId),
      this.listWorktrees(),
    ]);
    const replay = await store.load(runId);
    const registeredContestants = replay?.contestants.filter((contestant) =>
      contestant.worktreeRegistered !== undefined) ?? [];
    const receiptStates = states.filter((state) =>
      state.receipt !== undefined);
    const zeroTargetFinalized = replay?.state === "finalized"
      && receiptStates.length === 0
      && registeredContestants.length === 0;
    if (!replay
      || !replay.finalization
      || (!zeroTargetFinalized && replay.state !== "cleanupComplete")) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena run ownership cannot release before validated complete cleanup.",
      );
    }
    if (registeredContestants.length !== receiptStates.length
      || registeredContestants.some((contestant) =>
        contestant.cleanup.status !== "complete")) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena release requires one complete cleanup replay per durable registration.",
      );
    }
    const intentBindings: {
      readonly contestantId: string;
      readonly intentSha256: string;
      readonly registrationSha256: string | null;
    }[] = [];
    for (const contestant of replay.lock.contestants) {
      const derivedTarget = arenaContestantWorktreePath(
        this.privateWorkspaceRoot,
        runId,
        contestant.contestantId,
      );
      if (worktrees.some((entry) =>
        sameArenaPath(entry.path, derivedTarget))) {
        throw new ArenaGitError(
          "registrationMismatch",
          "Arena release refuses an unexpected derived worktree registration.",
        );
      }
      try {
        await fs.lstat(derivedTarget);
        throw new ArenaGitError(
          "worktreeExists",
          "Arena release refuses a residual derived worktree directory.",
        );
      } catch (error) {
        if (error instanceof ArenaGitError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const state of states) {
      const locked = replay.lock.contestants.find((candidate) =>
        candidate.contestantId === state.intent.contestantId);
      const contestant = registeredContestants.find((candidate) =>
        candidate.lock.contestantId === state.intent.contestantId);
      const payload = contestant?.worktreeRegistered?.payload as
        | { readonly registrationSha256?: string }
        | undefined;
      const expectedTarget = arenaContestantWorktreePath(
        this.privateWorkspaceRoot,
        runId,
        state.intent.contestantId,
      );
      if (!locked
        || locked.worktreeId !== state.intent.worktreeId
        || !sameArenaPath(expectedTarget, state.intent.worktreePath)
        || worktrees.some((entry) =>
          sameArenaPath(entry.path, state.intent.worktreePath))
        || (state.receipt
          ? (!contestant
            || payload?.registrationSha256
              !== state.receipt.registrationSha256
            || contestant.cleanup.status !== "complete")
          : contestant !== undefined)) {
        throw new ArenaGitError(
          "registrationMismatch",
          "Arena release proof does not match durable worktree registration state.",
        );
      }
      intentBindings.push({
        contestantId: state.intent.contestantId,
        intentSha256: state.intent.intentSha256,
        registrationSha256:
          state.receipt?.registrationSha256 ?? null,
      });
    }
    return hashCanonical(
      "hydra.arena.repository-run-release.v1\u0000",
      {
        runId,
        claimSha256,
        finalizationEventSha256: replay.finalization.eventSha256,
        latestManifestEventSha256: replay.latestEventSha256,
        intents: intentBindings.sort((left, right) =>
          compareUtf8(left.contestantId, right.contestantId)),
      },
    );
  }

  private async assertCleanupStepAuthorized(
    provisioned: ArenaOwnedWorktree,
    step: Exclude<ArenaCleanupStep, "quiesceProcesses">,
    allowCompletedProbe = false,
  ): Promise<void> {
    const store = await openFileArenaManifestStore(
      this.privateWorkspaceRoot,
    );
    const replay = await store.load(provisioned.runId);
    const contestant = replay?.contestants.find((candidate) =>
      candidate.lock.contestantId === provisioned.contestantId);
    const registration = contestant?.worktreeRegistered?.payload as
      | { readonly registrationSha256?: string }
      | undefined;
    if (!replay?.finalization
      || !contestant?.evidencePreserved
      || registration?.registrationSha256
        !== provisioned.registrationSha256) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena cleanup requires finalized, evidence-bound manifest authority.",
      );
    }
    const alreadyCompleted =
      contestant.cleanup.completedSteps.includes(step);
    if (contestant.cleanup.nextStep !== step
      && !(allowCompletedProbe && alreadyCompleted)) {
      throw new ArenaGitError(
        "registrationMismatch",
        `Arena cleanup step ${step} is not the authorized next operation.`,
      );
    }
  }

  private async verifyMonitoredOwnedWorktree(
    intent: ArenaWorktreeRegistrationIntent,
    receipt: ArenaWorktreeRegistrationReceipt,
    signal?: AbortSignal,
  ): Promise<void> {
    const owned = await this.bindOwnedReceipt(intent, receipt, signal);
    const entry = (await this.listWorktrees(signal)).find((candidate) =>
      sameArenaPath(candidate.path, owned.realWorktreePath));
    if (!entry
      || entry.bare
      || !entry.detached
      || entry.branch !== null
      || entry.head !== intent.baseRevision.oid
      || entry.lockedReason !== intent.lockReason
      || entry.prunableReason !== null) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena monitored worktree changed HEAD, branch, lock, or registry state.",
      );
    }
  }

  private async captureRepositoryStaticControlSha256(
    signal?: AbortSignal,
  ): Promise<string> {
    const [refs, config] = await Promise.all([
      this.git(
        this.workspaceRoot,
        [
          "for-each-ref",
          "--sort=refname",
          "--format=%(refname)%00%(objectname)%00%(symref)",
        ],
        { signal },
      ),
      this.git(
        this.workspaceRoot,
        ["config", "--local", "--null", "--list", "--show-origin", "--show-scope"],
        { signal },
      ),
    ]);
    return hashBuffers(
      "hydra.arena.git.repository-static-controls.v1\u0000",
      [
        refs.stdout,
        config.stdout,
      ],
    );
  }

  private async authenticateDurableWorktree(
    provisioned: ArenaOwnedWorktree,
  ): Promise<void> {
    const state = await this.registrations.load(
      provisioned.runId,
      provisioned.contestantId,
    );
    const intent = state?.intent;
    const receipt = state?.receipt;
    const realPathSha256 = hashCanonical(
      "hydra.arena.git.real-worktree-path.v1\u0000",
      canonicalPath(provisioned.realWorktreePath),
    );
    if (!intent
      || !receipt
      || intent.intentSha256 !== provisioned.intentSha256
      || intent.repositoryIdentitySha256
        !== provisioned.repositoryIdentitySha256
      || intent.runId !== provisioned.runId
      || intent.contestantId !== provisioned.contestantId
      || intent.worktreeId !== provisioned.worktreeId
      || !sameArenaPath(intent.worktreePath, provisioned.worktreePath)
      || intent.lockReason !== provisioned.lockReason
      || intent.baseRevision.objectFormat !== provisioned.head.objectFormat
      || intent.baseRevision.oid !== provisioned.head.oid
      || intent.baseContentSha256
        !== provisioned.initialFingerprintSha256
      || receipt.registrationSha256 !== provisioned.registrationSha256
      || receipt.gitRegistrationSha256
        !== provisioned.gitRegistrationSha256
      || receipt.directoryIdentitySha256
        !== provisioned.directoryIdentitySha256
      || receipt.realWorktreePathSha256 !== realPathSha256
      || receipt.head.objectFormat !== provisioned.head.objectFormat
      || receipt.head.oid !== provisioned.head.oid
      || receipt.initialFingerprintSha256
        !== provisioned.initialFingerprintSha256) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena refuses cleanup without an exact durable intent and registration receipt.",
      );
    }
  }

  private async assertOwnedRegistration(
    provisioned: ArenaOwnedWorktree,
    signal: AbortSignal | undefined,
    allowMissingDirectory: boolean,
  ): Promise<ArenaGitWorktreeEntry> {
    const expected = arenaContestantWorktreePath(
      this.privateWorkspaceRoot,
      provisioned.runId,
      provisioned.contestantId,
    );
    if (!sameArenaPath(expected, provisioned.worktreePath)) {
      throw new ArenaGitError(
        "unsafePath",
        "Arena cleanup target is not the exact derived contestant path.",
      );
    }
    const entry = (await this.listWorktrees(signal)).find((candidate) =>
      sameArenaPath(candidate.path, provisioned.realWorktreePath));
    if (!entry) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena-owned worktree is missing from Git's registry.",
      );
    }
    if (!allowMissingDirectory) {
      await this.assertExactWorktreeTarget(
        provisioned.worktreePath,
        provisioned.runId,
        provisioned.contestantId,
      );
      const real = await fs.realpath(provisioned.worktreePath);
      const stat = await fs.lstat(real);
      const currentIdentity = hashCanonical(
        "hydra.arena.git.worktree-directory.v1\u0000",
        {
          path: canonicalPath(real),
          identity: statIdentity(stat),
        },
      );
      if (currentIdentity !== provisioned.directoryIdentitySha256) {
        throw new ArenaGitError(
          "worktreeStateMismatch",
          "Arena worktree directory identity changed.",
        );
      }
    }
    if (entry.bare) {
      throw new ArenaGitError(
        "registrationMismatch",
        "Arena-owned cleanup target unexpectedly became a bare worktree.",
      );
    }
    return entry;
  }

  private async assertExactWorktreeTarget(
    target: string,
    runId: string,
    contestantId: string,
  ): Promise<void> {
    const expected = arenaContestantWorktreePath(
      this.privateWorkspaceRoot,
      runId,
      contestantId,
    );
    if (!sameArenaPath(target, expected)) {
      throw new ArenaGitError(
        "unsafePath",
        "Arena worktree target differs from its exact derived path.",
      );
    }
    const runParent = path.dirname(expected);
    await assertArenaPrivateDirectory(runParent, this.boundary);
    const targetStat = await fs.lstat(expected);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new ArenaGitError(
        "unsafePath",
        "Arena worktree target is linked or not a directory.",
      );
    }
    const realParent = await fs.realpath(runParent);
    const realTarget = await fs.realpath(expected);
    if (!isArenaPathWithin(realParent, realTarget)
      || sameArenaPath(realParent, realTarget)
      || !isArenaPathWithin(this.boundary.realRoot, realTarget)) {
      throw new ArenaGitError(
        "unsafePath",
        "Arena worktree target resolves outside private storage.",
      );
    }
  }

  private async assertNoSequencerState(
    realCommonDirectory: string,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const name of SEQUENCER_PATHS) {
      const resolvedText = await this.gitText(
        this.workspaceRoot,
        ["rev-parse", "--git-path", name],
        signal,
      );
      const resolved = path.resolve(this.workspaceRoot, resolvedText);
      const realParent = await fs.realpath(path.dirname(resolved));
      if (!isArenaPathWithin(realCommonDirectory, realParent)) {
        throw new ArenaGitError(
          "unsupportedRepository",
          `Git sequencer path ${name} resolves outside the common directory.`,
        );
      }
      try {
        await fs.lstat(resolved);
        throw new ArenaGitError(
          "sequencerActive",
          `Arena refuses an active Git sequencer state (${name}).`,
        );
      } catch (error) {
        if (error instanceof ArenaGitError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private async assertNoGitControlLocks(
    realCommonDirectory: string,
  ): Promise<void> {
    const roots = [
      { relative: "", recursive: false },
      { relative: "refs", recursive: true },
      { relative: path.join("objects", "pack"), recursive: false },
      { relative: "worktrees", recursive: true },
      { relative: "reftable", recursive: false },
    ] as const;
    let scanned = 0;
    for (const root of roots) {
      const candidate = path.join(realCommonDirectory, root.relative);
      let stat: Stats;
      try {
        stat = await fs.lstat(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new ArenaGitError(
          "unsupportedRepository",
          `Arena Git control path is linked or invalid: ${root.relative || ".git"}.`,
        );
      }
      const pending = [{ directory: candidate, depth: 0 }];
      while (pending.length > 0) {
        const current = pending.pop()!;
        const directory = await fs.opendir(current.directory);
        try {
          for await (const entry of directory) {
            scanned += 1;
            if (scanned > MAX_GIT_CONTROL_SCAN_ENTRIES) {
              throw new ArenaGitError(
                "unsupportedRepository",
                "Arena Git control scan exceeds its bounded entry limit.",
              );
            }
            const entryPath = path.join(current.directory, entry.name);
            const entryStat = await fs.lstat(entryPath);
            if (entryStat.isSymbolicLink()) {
              throw new ArenaGitError(
                "unsupportedRepository",
                "Arena Git control scan refuses linked entries.",
              );
            }
            if (entry.isDirectory()) {
              if (root.recursive) {
                if (current.depth >= MAX_GIT_CONTROL_SCAN_DEPTH) {
                  throw new ArenaGitError(
                    "unsupportedRepository",
                    "Arena Git control scan exceeds its depth limit.",
                  );
                }
                pending.push({
                  directory: entryPath,
                  depth: current.depth + 1,
                });
              }
              continue;
            }
            const inPackDirectory = root.relative
              === path.join("objects", "pack");
            if (entry.name.endsWith(".lock")
              || (inPackDirectory && entry.name.startsWith("tmp_"))) {
              throw new ArenaGitError(
                "sequencerActive",
                `Arena refuses active Git control file ${path.relative(
                  realCommonDirectory,
                  entryPath,
                )}.`,
              );
            }
          }
        } finally {
          await directory.close().catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") {
              throw error;
            }
          });
        }
      }
    }
  }

  private async assertNoSparseCheckout(signal?: AbortSignal): Promise<void> {
    for (const key of ["core.sparseCheckout", "core.sparseCheckoutCone"]) {
      const result = await this.git(
        this.workspaceRoot,
        ["config", "--bool", "--get", key],
        { allowedExitCodes: [0, 1], signal },
      );
      if (result.exitCode === 0
        && decodeUtf8(result.stdout, key).trim() === "true") {
        throw new ArenaGitError(
          "sparseCheckout",
          `Arena MVP does not support ${key}.`,
        );
      }
    }
  }

  private async assertNoSubmodules(signal?: AbortSignal): Promise<void> {
    const result = await this.git(
      this.workspaceRoot,
      ["ls-files", "--stage", "-z", "--"],
      { signal },
    );
    for (const record of splitNul(result.stdout, "Git index")) {
      const tab = record.indexOf(0x09);
      const metadata = tab < 0
        ? ""
        : record.subarray(0, tab).toString("ascii");
      const match = /^([0-7]{6}) [0-9a-f]{40}(?:[0-9a-f]{24})? ([0-3])$/
        .exec(metadata);
      if (!match) {
        throw new ArenaGitError(
          "gitFailed",
          "Git index emitted an invalid stage record.",
        );
      }
      if (match[1] === "160000") {
        throw new ArenaGitError(
          "submodules",
          "Arena MVP does not support Git submodules.",
        );
      }
      if (match[2] !== "0") {
        throw new ArenaGitError(
          "indexFlags",
          "Arena MVP does not admit unmerged index stages.",
        );
      }
    }
  }

  private async assertNoSpecialIndexFlags(signal?: AbortSignal): Promise<void> {
    const result = await this.git(
      this.workspaceRoot,
      ["ls-files", "-v", "-z", "--"],
      { signal },
    );
    for (const record of splitNul(result.stdout, "Git index flags")) {
      const tag = String.fromCharCode(record[0] ?? 0);
      if (tag === "S" || (tag >= "a" && tag <= "z")) {
        throw new ArenaGitError(
          "indexFlags",
          "Arena MVP does not support skip-worktree or assume-unchanged index entries.",
        );
      }
    }
  }

  private async assertNoConfiguredFilters(signal?: AbortSignal): Promise<void> {
    const result = await this.git(
      this.workspaceRoot,
      ["config", "--local", "--name-only", "--get-regexp", "^filter\\."],
      { allowedExitCodes: [0, 1], signal },
    );
    if (result.exitCode === 0 && result.stdout.length > 0) {
      throw new ArenaGitError(
        "configuredHelpers",
        "Arena MVP refuses configured Git clean, smudge, or process filters.",
      );
    }
  }

  private async assertNoLocalIncludes(signal?: AbortSignal): Promise<void> {
    const result = await this.git(
      this.workspaceRoot,
      [
        "config",
        "--local",
        "--name-only",
        "--get-regexp",
        "^(include|includeIf)\\.",
      ],
      { allowedExitCodes: [0, 1], signal },
    );
    if (result.exitCode === 0 && result.stdout.length > 0) {
      throw new ArenaGitError(
        "configuredHelpers",
        "Arena MVP refuses repository-local include and includeIf directives.",
      );
    }
  }

  private async assertWorktreeCapabilities(): Promise<void> {
    const result = await this.git(
      this.workspaceRoot,
      ["worktree", "add", "-h"],
      {
        allowedExitCodes: [0, 129],
        maxStdoutBytes: 256 * 1024,
        maxStderrBytes: 256 * 1024,
      },
    );
    const help = `${decodeUtf8Lossy(result.stdout)}\n${
      decodeUtf8Lossy(result.stderr)
    }`;
    for (const [label, spellings] of [
      ["--detach", ["--detach", "--[no-]detach"]],
      ["--lock", ["--lock", "--[no-]lock"]],
      ["--reason", ["--reason", "--[no-]reason"]],
      [
        "--no-relative-paths",
        ["--no-relative-paths", "--[no-]relative-paths"],
      ],
    ] as const) {
      if (!spellings.some((spelling) => help.includes(spelling))) {
        throw new ArenaGitError(
          "unsupportedRepository",
          `Resolved Git does not advertise required Arena worktree flag ${label}.`,
        );
      }
    }
  }

  private async gitText(
    cwd: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.git(cwd, args, {
      maxStdoutBytes: 1024 * 1024,
      signal,
    });
    return decodeUtf8(result.stdout, `git ${args[0] ?? "command"}`).trim();
  }

  private async captureFingerprint(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<DuelWorkspaceFingerprint> {
    return captureDuelWorkspaceFingerprint(cwd, {
      includeWorkspaceMetadata: false,
      hashOnlyChangedTrackedFiles: true,
      gitRunner: async (runnerCwd, args, limits) => {
        const result = await this.git(runnerCwd, args, {
          maxStdoutBytes: limits.maxStdoutBytes,
          timeoutMs: limits.timeoutMs,
          signal,
        });
        return { stdout: result.stdout };
      },
    });
  }

  private async git(
    cwd: string,
    args: readonly string[],
    options: ArenaGitCommandOptions = {},
  ): Promise<ArenaGitCommandResult> {
    if (!workspaceGitExecutionAllowed()) {
      throw new ArenaGitError(
        "gitUnavailable",
        "Arena Git execution is disabled until Workspace Trust is granted.",
      );
    }
    const current = await resolveGitExecutable(this.gitResolutionRoot);
    if (!current
      || !sameArenaPath(await fs.realpath(current), this.gitExecutable)) {
      throw new ArenaGitError(
        "gitUnavailable",
        "Arena's resolved Git executable changed after admission.",
      );
    }
    const executableStat = await fs.lstat(this.gitExecutable);
    if (!executableStat.isFile() || executableStat.isSymbolicLink()) {
      throw new ArenaGitError(
        "gitUnavailable",
        "Arena's resolved Git executable is no longer a real file.",
      );
    }
    if (executableIdentitySha256(this.gitExecutable, executableStat)
        !== this.gitExecutableIdentitySha256) {
      throw new ArenaGitError(
        "gitUnavailable",
        "Arena's resolved Git executable identity changed after admission.",
      );
    }
    const absoluteCwd = path.resolve(cwd);
    if (!sameArenaPath(absoluteCwd, this.workspaceRoot)) {
      if (!isArenaPathWithin(this.boundary.logicalRoot, absoluteCwd)
        || sameArenaPath(this.boundary.logicalRoot, absoluteCwd)) {
        throw new ArenaGitError(
          "unsafePath",
          "Arena Git cwd is outside the source workspace and private worktrees.",
        );
      }
      await assertArenaPrivateDirectory(absoluteCwd, this.boundary);
    }
    return runArenaGitCommand(
      this.gitExecutable,
      absoluteCwd,
      [
        "--no-pager",
        "--no-optional-locks",
        "--no-replace-objects",
        "--no-lazy-fetch",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        ...(process.platform === "win32"
          ? ["-c", "core.longpaths=true"]
          : []),
        "-c",
        "gc.worktreePruneExpire=never",
        "-c",
        "diff.external=",
        "-c",
        "diff.trustExitCode=false",
        "-c",
        `core.hooksPath=${this.emptyHooksPath}`,
        ...args,
      ],
      options,
    );
  }
}

function validatePromotionCandidate(
  value: ArenaPromotionCandidate,
): ArenaPromotionCandidate {
  if (!value
    || !Buffer.isBuffer(value.patch)
    || value.patch.byteLength > MAX_ARENA_PATCH_BYTES
    || !/^[a-f0-9]{64}$/u.test(value.patchSha256)
    || createHash("sha256").update(value.patch).digest("hex")
      !== value.patchSha256
    || !/^[a-f0-9]{64}$/u.test(value.artifactSetSha256)
    || !Array.isArray(value.untrackedEntries)
    || value.untrackedEntries.length > 10_000) {
    throw new ArenaGitError(
      "worktreeStateMismatch",
      "Arena promotion candidate is invalid or oversized.",
    );
  }
  const seen = new Set<string>();
  const entries = value.untrackedEntries.map((entry) => {
    const gitPath = validatePromotionGitPath(entry.path);
    const key = process.platform === "win32" ? gitPath.toLowerCase() : gitPath;
    if (seen.has(key)
      || !Buffer.isBuffer(entry.content)
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0
      || entry.bytes !== entry.content.byteLength
      || !Number.isSafeInteger(entry.mode)
      || entry.mode < 0
      || entry.mode > 0o777
      || !/^[a-f0-9]{64}$/u.test(entry.sha256)
      || createHash("sha256").update(entry.content).digest("hex")
        !== entry.sha256) {
      throw new ArenaGitError(
        "worktreeStateMismatch",
        "Arena promotion untracked entry is invalid.",
      );
    }
    seen.add(key);
    return Object.freeze({ ...entry, path: gitPath, content: Buffer.from(entry.content) });
  });
  return Object.freeze({
    patch: Buffer.from(value.patch),
    patchSha256: value.patchSha256,
    artifactSetSha256: value.artifactSetSha256,
    untrackedEntries: Object.freeze(entries),
  });
}

async function promotionUntrackedConflicts(
  workspaceRoot: string,
  entries: readonly ArenaPromotionUntrackedEntry[],
): Promise<readonly string[]> {
  const conflicts: string[] = [];
  for (const entry of entries) {
    const target = promotionTarget(workspaceRoot, entry.path);
    await assertPromotionParents(workspaceRoot, target, false);
    try {
      await fs.lstat(target);
      if (conflicts.length < 256) conflicts.push(entry.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return Object.freeze(conflicts);
}

async function publishPromotionUntrackedEntry(
  workspaceRoot: string,
  entry: ArenaPromotionUntrackedEntry,
): Promise<void> {
  const target = promotionTarget(workspaceRoot, entry.path);
  await assertPromotionParents(workspaceRoot, target, true);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
  const handle = await fs.open(
    target,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | noFollow,
    entry.mode,
  );
  try {
    await handle.writeFile(entry.content);
    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile()
      || written.isSymbolicLink()
      || written.nlink !== 1
      || written.size !== entry.bytes) {
      throw new ArenaGitError(
        "worktreeStateMismatch",
        "Arena promotion could not verify a newly created untracked file.",
      );
    }
  } finally {
    await handle.close();
  }
}

async function assertPromotionParents(
  workspaceRoot: string,
  target: string,
  createMissing: boolean,
): Promise<void> {
  const relativeParent = path.relative(workspaceRoot, path.dirname(target));
  const segments = relativeParent === "" ? [] : relativeParent.split(path.sep);
  let current = workspaceRoot;
  await assertRealDirectory(current, "Arena promotion workspace");
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new ArenaGitError(
          "unsafePath",
          "Arena promotion untracked parent is linked or invalid.",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!createMissing) continue;
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw mkdirError;
        }
      }
      const created = await fs.lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new ArenaGitError(
          "unsafePath",
          "Arena promotion untracked parent changed during creation.",
        );
      }
    }
  }
}

function promotionTarget(workspaceRoot: string, gitPath: string): string {
  const safe = validatePromotionGitPath(gitPath);
  const target = path.resolve(workspaceRoot, ...safe.split("/"));
  const relative = path.relative(workspaceRoot, target);
  if (relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new ArenaGitError("unsafePath", "Arena promotion path escapes the workspace.");
  }
  return target;
}

function validatePromotionGitPath(value: string): string {
  if (typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > 4_096
    || value.startsWith("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f:]/u.test(value)
    || value.split("/").some((segment) =>
      segment.length === 0
      || segment === "."
      || segment === ".."
      || segment.toLowerCase() === ".git"
      || /[. ]$/u.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) {
    throw new ArenaGitError("unsafePath", "Arena promotion path is unsafe.");
  }
  return value;
}

export function arenaWorktreeLockReason(
  runId: string,
  contestantId: string,
  worktreeId: string,
): string {
  const digest = hashCanonical("hydra.arena.git.lock-reason.v1\u0000", {
    runId,
    contestantId,
    worktreeId,
  });
  return `hydra-arena-v1:${digest}`;
}

export function arenaWorktreeRegistrySha256(
  entries: readonly ArenaGitWorktreeEntry[],
): string {
  return hashCanonical(
    "hydra.arena.git.worktree-registry.v1\u0000",
    [...entries]
      .map((entry) => ({
        path: canonicalPath(entry.path),
        head: entry.head,
        branch: entry.branch,
        detached: entry.detached,
        bare: entry.bare,
        lockedReason: entry.lockedReason,
        prunableReason: entry.prunableReason,
      }))
      .sort((left, right) => compareUtf8(left.path, right.path)),
  );
}

export function arenaRepositoryControlSha256(
  repositoryStaticControlSha256: string,
  worktreeRegistrySha256: string,
): string {
  if (!/^[a-f0-9]{64}$/.test(repositoryStaticControlSha256)
    || !/^[a-f0-9]{64}$/.test(worktreeRegistrySha256)) {
    throw new ArenaGitError(
      "gitFailed",
      "Arena repository control inputs must be SHA-256 digests.",
    );
  }
  return hashCanonical(
    "hydra.arena.git.repository-controls.v1\u0000",
    {
      repositoryStaticControlSha256,
      worktreeRegistrySha256,
    },
  );
}

export function parseArenaWorktreeListPorcelainZ(
  value: Buffer | string,
): readonly ArenaGitWorktreeEntry[] {
  const buffer = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  if (buffer.length === 0 || buffer.at(-1) !== 0) {
    throw new ArenaGitError(
      "gitFailed",
      "Git worktree porcelain output is empty or not NUL-terminated.",
    );
  }
  const fields = splitNul(buffer, "Git worktree porcelain", true);
  const entries: ArenaGitWorktreeEntry[] = [];
  let current: MutableWorktreeEntry | undefined;
  for (const field of fields) {
    if (field.length === 0) {
      if (!current) continue;
      entries.push(finishWorktreeEntry(current));
      current = undefined;
      continue;
    }
    if (field.length > MAX_WORKTREE_FIELD_BYTES) {
      throw new ArenaGitError(
        "gitOutputTooLarge",
        "Git worktree porcelain field exceeds its bound.",
      );
    }
    const text = decodeUtf8(field, "Git worktree porcelain field");
    const space = text.indexOf(" ");
    const key = space < 0 ? text : text.slice(0, space);
    const payload = space < 0 ? "" : text.slice(space + 1);
    if (key === "worktree") {
      if (current) {
        throw new ArenaGitError(
          "gitFailed",
          "Git worktree porcelain entry lacks a record separator.",
        );
      }
      if (!path.isAbsolute(payload)) {
        throw new ArenaGitError(
          "gitFailed",
          "Git worktree porcelain path is not absolute.",
        );
      }
      current = {
        path: path.resolve(payload),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        lockedReason: null,
        prunableReason: null,
        keys: new Set(["worktree"]),
      };
      continue;
    }
    if (!current) {
      throw new ArenaGitError(
        "gitFailed",
        "Git worktree porcelain field appears before a worktree path.",
      );
    }
    if (current.keys.has(key)) {
      throw new ArenaGitError(
        "gitFailed",
        `Git worktree porcelain duplicates ${key}.`,
      );
    }
    current.keys.add(key);
    if (key === "HEAD") current.head = payload;
    else if (key === "branch") current.branch = payload;
    else if (key === "detached") {
      if (payload) throw invalidWorktreeField(key);
      current.detached = true;
    } else if (key === "bare") {
      if (payload) throw invalidWorktreeField(key);
      current.bare = true;
    } else if (key === "locked") current.lockedReason = payload || "";
    else if (key === "prunable") current.prunableReason = payload || "";
    else {
      throw new ArenaGitError(
        "gitFailed",
        `Git worktree porcelain emitted unsupported field ${key}.`,
      );
    }
  }
  if (current) {
    throw new ArenaGitError(
      "gitFailed",
      "Git worktree porcelain entry lacks its final NUL record separator.",
    );
  }
  if (entries.length === 0) {
    throw new ArenaGitError(
      "gitFailed",
      "Git worktree porcelain contains no worktrees.",
    );
  }
  const paths = new Set<string>();
  for (const entry of entries) {
    const key = canonicalPath(entry.path);
    if (paths.has(key)) {
      throw new ArenaGitError(
        "gitFailed",
        "Git worktree porcelain duplicates a worktree path.",
      );
    }
    paths.add(key);
  }
  return Object.freeze(entries);
}

export async function runArenaGitCommand(
  gitExecutable: string,
  cwd: string,
  args: readonly string[],
  options: ArenaGitCommandOptions = {},
): Promise<ArenaGitCommandResult> {
  const maxStdoutBytes = positiveBound(
    options.maxStdoutBytes,
    DEFAULT_GIT_STDOUT_BYTES,
  );
  const maxStderrBytes = positiveBound(
    options.maxStderrBytes,
    DEFAULT_GIT_STDERR_BYTES,
  );
  const timeoutMs = positiveBound(options.timeoutMs, DEFAULT_GIT_TIMEOUT_MS);
  const allowedExitCodes = new Set(options.allowedExitCodes ?? [0]);
  if (options.stdin !== undefined
    && options.stdin.byteLength > MAX_ARENA_PATCH_BYTES) {
    throw new ArenaGitError(
      "gitOutputTooLarge",
      `Arena Git stdin exceeded ${MAX_ARENA_PATCH_BYTES} bytes.`,
    );
  }
  if (options.signal?.aborted) {
    throw new ArenaGitError("gitCancelled", "Arena Git command was cancelled before spawn.");
  }
  return new Promise<ArenaGitCommandResult>((resolve, reject) => {
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(gitExecutable, [...args], {
        cwd,
        windowsHide: true,
        shell: false,
        detached: process.platform !== "win32",
        stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        env: sanitizedArenaGitEnvironment(),
      });
      bindProcessTreeIdentity(child);
    } catch (error) {
      reject(new ArenaGitError(
        "gitFailed",
        "Arena could not spawn the resolved Git executable.",
        { cause: error },
      ));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let stopReason: ArenaGitError | undefined;
    let terminationWork: Promise<boolean> | undefined;
    let stdoutSinkWork: Promise<void> = Promise.resolve();
    let stdoutSinkFailure: ArenaGitError | undefined;
    let rejectionWork: Promise<void> | undefined;

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finishReject = (error: ArenaGitError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finishRejectAfterStreamDrain = (error: ArenaGitError) => {
      if (settled || rejectionWork) return;
      rejectionWork = (async () => {
        // Make the sink chain finite before any caller is allowed to close or
        // unlink its destination. Data callbacks already queued have appended
        // their work synchronously; pausing and detaching prevents new ones.
        child.stdout?.pause();
        child.stdout?.removeAllListeners("data");
        child.stdout?.destroy();
        child.stderr?.removeAllListeners("data");
        child.stderr?.destroy();
        await stdoutSinkWork;
        finishReject(error);
      })();
      void rejectionWork.catch((drainError: unknown) => {
        finishReject(new ArenaGitError(
          "gitFailed",
          "Arena Git output shutdown failed.",
          { cause: drainError },
        ));
      });
    };
    const stop = (reason: ArenaGitError) => {
      stopReason ??= reason;
      if (terminationWork) return;
      terminationWork = (async () => {
        try {
          const firstRequest = await terminateProcessTree(child, false);
          if (process.platform === "win32") {
            if (firstRequest) return true;
            await waitFor(250);
            return terminateProcessTree(child, true);
          }
          if (child.pid
            && await waitForPosixProcessGroupQuiescence(child.pid, 250)) {
            return true;
          }
          await terminateProcessTree(child, true);
          return child.pid
            ? waitForPosixProcessGroupQuiescence(child.pid, 1_500)
            : false;
        } catch {
          return false;
        }
      })();
      void terminationWork.then((confirmed) => {
        if (!confirmed && !settled) {
          finishRejectAfterStreamDrain(new ArenaGitError(
            "terminationUnconfirmed",
            "Arena could not confirm Git process-tree termination.",
            { cause: stopReason },
          ));
        }
      });
    };
    const onAbort = () => stop(new ArenaGitError(
      "gitCancelled",
      "Arena Git command was cancelled.",
    ));
    const timer = setTimeout(() => {
      stop(new ArenaGitError(
        "gitTimedOut",
        `Arena Git command exceeded ${timeoutMs}ms.`,
      ));
    }, timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.stdin !== undefined) {
      child.stdin?.once("error", (error) => {
        if (settled) return;
        stop(new ArenaGitError(
          "gitFailed",
          "Arena could not write exact bytes to Git stdin.",
          { cause: error },
        ));
      });
      child.stdin?.end(options.stdin);
    }

    child.stdout?.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        stop(new ArenaGitError(
          "gitOutputTooLarge",
          `Arena Git stdout exceeded ${maxStdoutBytes} bytes.`,
        ));
        return;
      }
      if (!options.stdoutSink) {
        stdout.push(Buffer.from(chunk));
        return;
      }
      child.stdout?.pause();
      stdoutSinkWork = stdoutSinkWork
        .then(async () => {
          if (stdoutSinkFailure) return;
          await options.stdoutSink!(Buffer.from(chunk));
        })
        .catch((error: unknown) => {
          stdoutSinkFailure = new ArenaGitError(
            "gitFailed",
            "Arena Git stdout evidence sink failed.",
            { cause: error },
          );
          stop(stdoutSinkFailure);
        })
        .then(() => {
          if (!stopReason && !settled) child.stdout?.resume();
        });
    });
    child.stderr?.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (stderrBytes >= maxStderrBytes) return;
      const retained = chunk.subarray(0, maxStderrBytes - stderrBytes);
      stderr.push(Buffer.from(retained));
      stderrBytes += retained.length;
    });
    child.once("error", (error) => {
      const processError = new ArenaGitError(
        "gitFailed",
        "Arena Git process failed before completion.",
        { cause: error },
      );
      if (!child.pid) {
        finishRejectAfterStreamDrain(processError);
        return;
      }
      stop(processError);
      void terminationWork!.then((confirmed) => {
        finishRejectAfterStreamDrain(confirmed
          ? processError
          : new ArenaGitError(
              "terminationUnconfirmed",
              "Arena could not confirm Git process-tree termination after a process error.",
              { cause: processError },
            ));
      });
    });
    child.once("close", (code) => void (async () => {
      await stdoutSinkWork;
      if (settled) return;
      if (stopReason) {
        const terminationConfirmed = await (
          terminationWork ?? Promise.resolve(false)
        );
        finishReject(terminationConfirmed
          ? stopReason
          : new ArenaGitError(
              "terminationUnconfirmed",
              "Arena could not confirm Git process-tree termination.",
              { cause: stopReason },
            ));
        return;
      }
      if (stdoutSinkFailure) {
        finishReject(stdoutSinkFailure);
        return;
      }
      const exitCode = code ?? -1;
      if (!allowedExitCodes.has(exitCode)) {
        const detail = decodeUtf8Lossy(Buffer.concat(stderr, stderrBytes))
          .replace(/[\u0000-\u001f\u007f]+/g, " ")
          .trim()
          .slice(0, 1_000);
        finishReject(new ArenaGitError(
          "gitFailed",
          detail
            ? `Arena Git command failed: ${detail}`
            : `Arena Git command exited with code ${exitCode}.`,
        ));
        return;
      }
      settled = true;
      cleanup();
      resolve({
        stdout: options.stdoutSink
          ? Buffer.alloc(0)
          : Buffer.concat(stdout, stdoutBytes),
        stderr: Buffer.concat(stderr, stderrBytes),
        exitCode,
      });
    })());
  });
}

interface MutableArenaEvidenceStage {
  readonly path: string;
  readonly handle: fs.FileHandle;
  readonly identity: Stats;
  readonly parentIdentity: Stats;
}

async function createArenaEvidenceStage(
  artifactDirectory: string,
  artifactName: string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<MutableArenaEvidenceStage> {
  await assertArenaPrivateDirectory(artifactDirectory, boundary);
  const parentIdentity = await fs.lstat(artifactDirectory);
  if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()) {
    throw new ArenaGitError(
      "unsafePath",
      "Arena evidence artifact directory is linked or invalid.",
    );
  }
  const reservation = reserveArenaEvidenceStageName(artifactName);
  const stagePath = path.join(artifactDirectory, reservation.name);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(stagePath, "wx", 0o600);
  } catch (error) {
    releaseArenaEvidenceStageName(stagePath);
    throw error;
  }
  try {
    const [opened, entry] = await Promise.all([
      handle.stat(),
      fs.lstat(stagePath),
    ]);
    if (!opened.isFile()
      || opened.isSymbolicLink()
      || opened.nlink !== 1
      || !isArenaEvidenceFilePermissionSafe(opened)
      || !entry.isFile()
      || entry.isSymbolicLink()
      || entry.nlink !== 1
      || !isArenaEvidenceFilePermissionSafe(entry)
      || !sameArenaEvidenceFileIdentity(opened, entry)) {
      throw new ArenaGitError(
        "unsafePath",
        "Arena evidence staging file is linked or changed identity.",
      );
    }
    await assertArenaEvidenceStageParent(
      artifactDirectory,
      parentIdentity,
      boundary,
    );
    await handle.chmod(0o600).catch(() => undefined);
    return Object.freeze({
      path: stagePath,
      handle,
      identity: opened,
      parentIdentity,
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    let opened: Stats | undefined;
    try {
      opened = await handle.stat();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await handle.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await assertArenaEvidenceStageParent(
        artifactDirectory,
        parentIdentity,
        boundary,
      );
      const entry = await fs.lstat(stagePath);
      if (!opened
        || !isArenaEvidenceFilePermissionSafe(opened)
        || !isArenaEvidenceFilePermissionSafe(entry)
        || !sameArenaEvidenceFileIdentity(opened, entry)) {
        throw new ArenaGitError(
          "unsafePath",
          "Arena evidence staging file changed before failed-open cleanup.",
        );
      }
      await fs.unlink(stagePath);
      await syncArenaDirectoryEntry(
        artifactDirectory,
        arenaEvidenceDirectoryIdentity(parentIdentity),
        "Arena evidence artifact directory",
      );
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        cleanupErrors.push(cleanupError);
      }
    }
    releaseArenaEvidenceStageName(stagePath);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Arena evidence stage creation and cleanup both failed.",
      );
    }
    throw error;
  }
}

async function sealArenaEvidenceStage(
  stage: MutableArenaEvidenceStage,
  sha256: string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<ArenaStagedEvidenceFile> {
  let result: ArenaStagedEvidenceFile | undefined;
  let primaryError: unknown;
  try {
    await assertArenaEvidenceStageParent(
      path.dirname(stage.path),
      stage.parentIdentity,
      boundary,
    );
    await stage.handle.sync();
    const [sealed, entry] = await Promise.all([
      stage.handle.stat(),
      fs.lstat(stage.path),
    ]);
    if (!sealed.isFile()
      || sealed.isSymbolicLink()
      || sealed.nlink !== 1
      || !isArenaEvidenceFilePermissionSafe(sealed)
      || !entry.isFile()
      || entry.isSymbolicLink()
      || entry.nlink !== 1
      || !isArenaEvidenceFilePermissionSafe(entry)
      || !sameArenaEvidenceFileIdentity(stage.identity, sealed)
      || !sameArenaEvidenceFileIdentity(sealed, entry)
      || !/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new ArenaGitError(
        "unsafePath",
        "Arena evidence staging file changed before sealing.",
      );
    }
    await assertArenaEvidenceStageParent(
      path.dirname(stage.path),
      stage.parentIdentity,
      boundary,
    );
    result = Object.freeze({
      path: stage.path,
      bytes: sealed.size,
      sha256,
    });
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown;
  try {
    await stage.handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError && closeError) {
    throw new AggregateError(
      [primaryError, closeError],
      "Arena evidence stage sealing and close both failed.",
    );
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
  return result!;
}

async function discardArenaEvidenceStage(
  stage: MutableArenaEvidenceStage,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await stage.handle.close();
  } catch (error) {
    errors.push(error);
  }
  const parentPath = path.dirname(stage.path);
  try {
    await assertArenaEvidenceStageParent(
      parentPath,
      stage.parentIdentity,
      boundary,
    );
    const entry = await fs.lstat(stage.path);
    if (!isArenaEvidenceFilePermissionSafe(entry)
      || !sameArenaEvidenceFileIdentity(stage.identity, entry)) {
      throw new ArenaGitError(
        "unsafePath",
        "Arena evidence staging file changed before cleanup.",
      );
    }
    await fs.unlink(stage.path);
    await syncArenaDirectoryEntry(
      parentPath,
      arenaEvidenceDirectoryIdentity(stage.parentIdentity),
      "Arena evidence artifact directory",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push(error);
    }
  }
  releaseArenaEvidenceStageName(stage.path);
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Arena evidence stage cleanup failed.",
    );
  }
}

function arenaEvidenceDirectoryIdentity(stat: Stats): {
  readonly dev: string;
  readonly ino: string;
} {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

async function assertArenaEvidenceStageParent(
  artifactDirectory: string,
  expected: Stats,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  await assertArenaPrivateDirectory(artifactDirectory, boundary);
  const current = await fs.lstat(artifactDirectory);
  if (!current.isDirectory()
    || current.isSymbolicLink()
    || !sameArenaEvidenceFileIdentity(expected, current)) {
    throw new ArenaGitError(
      "unsafePath",
      "Arena evidence artifact directory changed identity.",
    );
  }
}

async function writeArenaEvidenceChunk(
  handle: fs.FileHandle,
  chunk: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const write = await handle.write(chunk.subarray(offset));
    if (write.bytesWritten <= 0) {
      throw new Error("Arena evidence staging write made no progress.");
    }
    offset += write.bytesWritten;
  }
}

function sameArenaEvidenceFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isArenaEvidenceFilePermissionSafe(stat: Stats): boolean {
  if (process.platform === "win32") return true;
  if ((stat.mode & 0o077) !== 0) return false;
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

interface MutableWorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  lockedReason: string | null;
  prunableReason: string | null;
  keys: Set<string>;
}

function finishWorktreeEntry(
  entry: MutableWorktreeEntry,
): ArenaGitWorktreeEntry {
  if (entry.head !== null && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(entry.head)) {
    throw new ArenaGitError(
      "gitFailed",
      "Git worktree porcelain emitted an invalid HEAD object ID.",
    );
  }
  if (!entry.bare && entry.head === null) {
    throw new ArenaGitError(
      "gitFailed",
      "Git worktree porcelain omitted HEAD for a non-bare worktree.",
    );
  }
  if (entry.detached && entry.branch !== null) {
    throw new ArenaGitError(
      "gitFailed",
      "Git worktree porcelain claims both a branch and detached HEAD.",
    );
  }
  if (entry.branch !== null
    && (!entry.branch.startsWith("refs/")
      || /[\u0000-\u001f\u007f]/u.test(entry.branch))) {
    throw new ArenaGitError(
      "gitFailed",
      "Git worktree porcelain emitted an invalid branch ref.",
    );
  }
  if ((entry.lockedReason !== null
      && /[\u0000-\u001f\u007f]/u.test(entry.lockedReason))
    || (entry.prunableReason !== null
      && /[\u0000-\u001f\u007f]/u.test(entry.prunableReason))) {
    throw new ArenaGitError(
      "gitFailed",
      "Git worktree porcelain emitted an invalid reason.",
    );
  }
  return Object.freeze({
    path: entry.path,
    head: entry.head,
    branch: entry.branch,
    detached: entry.detached,
    bare: entry.bare,
    lockedReason: entry.lockedReason,
    prunableReason: entry.prunableReason,
  });
}

function splitNul(
  buffer: Buffer,
  label: string,
  retainEmpty = false,
): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  while (start < buffer.length) {
    if (records.length >= MAX_WORKTREE_FIELDS) {
      throw new ArenaGitError(
        "gitOutputTooLarge",
        `${label} exceeds ${MAX_WORKTREE_FIELDS} records.`,
      );
    }
    const end = buffer.indexOf(0, start);
    if (end < 0) {
      throw new ArenaGitError(
        "gitFailed",
        `${label} contains an unterminated NUL record.`,
      );
    }
    if (retainEmpty || end > start) records.push(buffer.subarray(start, end));
    start = end + 1;
  }
  return records;
}

function sanitizedArenaGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  }
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_SYSTEM = nullDevice;
  env.GIT_CONFIG_GLOBAL = nullDevice;
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GCM_INTERACTIVE = "Never";
  env.LC_ALL = "C";
  env.LANG = "C";
  return env;
}

function assertObjectId(
  objectFormat: ArenaGitObjectFormat,
  oid: string,
  label: string,
): void {
  const expected = objectFormat === "sha1" ? 40 : 64;
  if (!new RegExp(`^[0-9a-f]{${expected}}$`).test(oid)) {
    throw new ArenaGitError(
      "gitFailed",
      `${label} is not a valid ${objectFormat} object ID.`,
    );
  }
}

async function assertRealDirectory(
  directory: string,
  label: string,
): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ArenaGitError(
      "unsafePath",
      `${label} must be a real directory, not a link.`,
    );
  }
}

function hashCanonical(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function hashBuffers(domain: string, values: readonly Buffer[]): string {
  const digest = createHash("sha256").update(domain, "utf8");
  for (const value of values) {
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(value.length));
    digest.update(length);
    digest.update(value);
  }
  return digest.digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null
    || typeof value === "string"
    || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error("Arena Git hashes require finite numbers and reject negative zero.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (!value
    || typeof value !== "object"
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Arena Git hashes require JSON-compatible values.");
  }
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => {
    if (row[key] === undefined) {
      throw new Error("Arena Git hashes reject undefined values.");
    }
    return `${JSON.stringify(key)}:${canonicalJson(row[key])}`;
  }).join(",")}}`;
}

function statIdentity(stat: Stats): {
  readonly dev: string;
  readonly ino: string;
} {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
  };
}

function executableIdentitySha256(filePath: string, stat: Stats): string {
  return hashCanonical("hydra.arena.git.executable-identity.v1\u0000", {
    path: canonicalPath(filePath),
    identity: statIdentity(stat),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function decodeUtf8(value: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(value);
  } catch (error) {
    throw new ArenaGitError(
      "gitFailed",
      `${label} is not valid UTF-8.`,
      { cause: error },
    );
  }
}

function decodeUtf8Lossy(value: Buffer): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(value);
}

function invalidWorktreeField(key: string): ArenaGitError {
  return new ArenaGitError(
    "gitFailed",
    `Git worktree porcelain ${key} field must not carry a value.`,
  );
}

function positiveBound(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Arena Git command bounds must be positive safe integers.");
  }
  return value;
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
