import { createHash, randomUUID } from "node:crypto";
import {
  ArenaGitExecutor,
  type ArenaGitAdmission,
  type ArenaOwnedEvidenceState,
  type ArenaProvisionedWorktree,
} from "./arenaGit";
import { runArenaContestantBatch } from "./arenaContestantBatch";
import { runArenaCleanupTarget } from "./arenaCleanupRunner";
import { persistArenaDispatchReceipt } from "./arenaDispatchReceipts";
import {
  discardArenaEvidenceCaptureStages,
  preserveArenaEvidence,
  verifyArenaArtifactSet,
} from "./arenaEvidence";
import {
  assertArenaAcceptancePlanSet,
  runArenaBrowserJourneyAttempt,
  runArenaVerificationAttempt,
  type ArenaAcceptanceWorkspaceState,
  type ArenaBrowserJourneyExecutionPlan,
  type ArenaBrowserJourneyExecutorInput,
  type ArenaBrowserJourneyExecutorResult,
  type ArenaVerificationExecutionPlan,
  type ArenaVerificationExecutorInput,
  type ArenaVerificationExecutorResult,
} from "./arenaAcceptance";
import {
  createArenaFlightProjectingManifestStore,
  openFileArenaFlightProjectionStore,
  type ArenaFlightProjectingManifestStore,
  type ArenaFlightProjectionSink,
} from "./arenaFlightProjection";
import {
  startArenaMainWorkspaceMonitor,
  type ArenaMainWorkspaceMonitor,
} from "./arenaMainWorkspaceMonitor";
import { persistArenaMonitorReceipt } from "./arenaMonitorReceiptStore";
import { watchDuelWorkspaceMutations } from "./duelWorkspaceGuard";
import {
  arenaProcessFileIdentitySha256,
  prepareArenaProcessIntent,
  sha256ArenaProcessUtf8,
  supervisePreparedArenaProcess,
  type ArenaBundledProcessHelper,
  type ArenaNativeProcessQuiescenceBroker,
  type ArenaProcessSupervisorInput,
  type ArenaSupervisedProcessResult,
} from "./arenaProcessSupervisor";
import {
  openFileArenaManifestStore,
  type ArenaManifestStore,
} from "./arenaStore";
import {
  arenaEvidenceMatrixSha256,
  arenaReceiptsRootSha256,
  canonicalArenaManifestJson,
  type ArenaContestantLock,
  type ArenaEvidencePreservedPayload,
  type ArenaManifestEvent,
  type ArenaManifestReplay,
  type ArenaMissionLock,
  type ArenaFinalizationReason,
  type ArenaRunLockedPayload,
} from "./arenaRunManifest";

const ARENA_SAFETY_CAPTURE_TIMEOUT_MS = 120_000;

export interface ArenaControllerProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly contextSha256: string;
  readonly timeoutMs: number;
  /**
   * Hydra's bounded fake provider is the compatibility path. A native adapter
   * is admitted only through the exact executable/platform broker below.
   */
  readonly bundledHelper?: ArenaBundledProcessHelper;
  readonly nativeAdapterKind?: string;
  readonly nativeQuiescenceBroker?: ArenaNativeProcessQuiescenceBroker;
}

export interface ArenaControllerProcessContext {
  readonly runId: string;
  readonly contestant: ArenaContestantLock;
  readonly worktree: ArenaProvisionedWorktree;
  readonly traceId: string;
  readonly processGenerationId: string;
}

export interface ArenaControllerInput {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly privateWorkspaceRoot: string;
  readonly repositoryLeaseRoot: string;
  readonly gitResolutionRoot?: string;
  readonly lock: ArenaRunLockedPayload;
  readonly signal?: AbortSignal;
  readonly assertMissionAuthority: (
    mission: ArenaMissionLock,
  ) => void | Promise<void>;
  readonly createProcess: (
    context: ArenaControllerProcessContext,
  ) => ArenaControllerProcessSpec | Promise<ArenaControllerProcessSpec>;
  readonly verificationPlans?: readonly ArenaVerificationExecutionPlan[];
  readonly browserJourneyPlans?: readonly ArenaBrowserJourneyExecutionPlan[];
  readonly executeVerification?: (
    input: ArenaVerificationExecutorInput,
  ) => Promise<ArenaVerificationExecutorResult>;
  readonly executeBrowserJourney?: (
    input: ArenaBrowserJourneyExecutorInput,
  ) => Promise<ArenaBrowserJourneyExecutorResult>;
  /** Defaults to Hydra's private metadata-only Arena Flight extension. */
  readonly flightProjectionSink?: ArenaFlightProjectionSink;
}

export interface ArenaControllerResult {
  readonly replay: ArenaManifestReplay;
  readonly admission: ArenaGitAdmission;
  readonly contestantResults: readonly ArenaSupervisedProcessResult[];
  /** False means Arena completed but its non-authoritative Flight view is partial. */
  readonly flightProjectionComplete: boolean;
}

/**
 * Arena core orchestration. This controller deliberately has no panel,
 * steering, Terminal Bridge, winner, merge, commit, or promotion dependency.
 * All provider writes pass through the dedicated bounded process supervisor.
 */
export async function runArenaController(
  input: ArenaControllerInput,
): Promise<ArenaControllerResult> {
  assertControllerLock(input);
  const signal = input.signal ?? new AbortController().signal;
  await input.assertMissionAuthority(input.lock.mission);
  const executor = await ArenaGitExecutor.open(
    input.workspaceRoot,
    input.privateWorkspaceRoot,
    input.repositoryLeaseRoot,
    input.gitResolutionRoot ?? input.workspaceRoot,
  );
  // The executor authenticates and canonicalizes an upstream directory alias.
  // Every controller-owned store and receipt must use that one spelling or the
  // same physical run can acquire divergent path-bound identities.
  const privateWorkspaceRoot = executor.privateWorkspaceRoot;
  const admission = await executor.inspectAdmission(signal);
  assertLockMatchesAdmission(input.lock, admission);
  const authoritativeStore = await openFileArenaManifestStore(privateWorkspaceRoot);
  if (await authoritativeStore.load(input.runId)) {
    throw new Error("Arena controller refuses to reuse an existing run.");
  }
  let flightProjectionAvailable = true;
  let projectingStore: ArenaFlightProjectingManifestStore | undefined;
  let store: ArenaManifestStore = authoritativeStore;
  try {
    const projectionSink = input.flightProjectionSink
      ?? await openFileArenaFlightProjectionStore(privateWorkspaceRoot);
    projectingStore = createArenaFlightProjectingManifestStore(
      authoritativeStore,
      projectionSink,
      () => {
        flightProjectionAvailable = false;
      },
    );
    store = projectingStore;
  } catch {
    // Flight is a derived diagnostic surface, never Arena execution authority.
    flightProjectionAvailable = false;
  }
  const runId = input.runId;
  const lockEvent = await append(store, runId, "arenaRunLocked", input.lock);

  let claimActive = false;
  let monitor: ArenaMainWorkspaceMonitor | undefined;
  let planned = false;
  const worktrees: ArenaProvisionedWorktree[] = [];
  const evidenceStates = new Map<string, ArenaOwnedEvidenceState>();
  const contestantMonitors = new Map<
    string,
    ReturnType<typeof watchDuelWorkspaceMutations>
  >();
  try {
    const claim = await executor.claimRepositoryRun(runId, admission);
    if (claim.status !== "active") {
      throw new Error("Arena controller run was already released.");
    }
    claimActive = true;

    monitor = startArenaMainWorkspaceMonitor(
      admission.sourceWorkspacePath,
      {
        runId,
        sourceWorkspaceFingerprintSha256:
          admission.sourceWorkspaceFingerprintSha256,
        repositoryControlSha256: admission.repositoryControlSha256,
        head: admission.baseRevision,
      },
      () => executor.captureSourceState(
        admission,
        planned ? runId : undefined,
        boundedArenaSafetySignal(),
      ),
      {
        persistReceipt: (receipt) =>
          persistArenaMonitorReceipt(
            privateWorkspaceRoot,
            receipt,
          ).then(() => undefined),
      },
    );
    const monitorStarted = await monitor.observe("monitorStarted");
    await append(
      store,
      runId,
      "arenaMainWorkspaceObserved",
      monitorStarted,
    );
    if (monitorStarted.status !== "unchanged") {
      await finalizeWithoutTargets(
        store,
        executor,
        runId,
        reasonForMonitor(monitorStarted.reasonCode),
      );
      claimActive = false;
      return {
        replay: await requiredReplay(store, runId),
        admission,
        contestantResults: Object.freeze([]),
        flightProjectionComplete: await completeFlightProjection(
          projectingStore,
          flightProjectionAvailable,
        ),
      };
    }

    const intents = await executor.planWorktrees({
      admission,
      contestants: input.lock.contestants.map((contestant) => ({
        runId,
        contestantId: contestant.contestantId,
        worktreeId: contestant.worktreeId,
        intentId: opaqueId("intent", runId, contestant.contestantId),
        occurredAt: new Date().toISOString(),
      })),
    });
    planned = true;
    for (const intent of intents) {
      const checkpoint = await monitor.observe("checkpoint");
      await append(
        store,
        runId,
        "arenaMainWorkspaceObserved",
        checkpoint,
      );
      if (checkpoint.status !== "unchanged") {
        throw new Error(
          "Arena source controls changed before worktree provisioning.",
        );
      }
      const worktree = await executor.provisionPlannedWorktree(intent, signal);
      worktrees.push(worktree);
      await append(store, runId, "arenaWorktreeRegistered", {
        payloadType: "worktreeRegistered",
        contestantId: worktree.contestantId,
        worktreeId: worktree.worktreeId,
        baseRevision: worktree.head,
        registrationSha256: worktree.registrationSha256,
        initialFingerprintSha256: worktree.fingerprint.sha256,
      });
      await append(store, runId, "arenaWorktreeProvisioned", {
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
      });
    }

    const preDispatch = await monitor.observe("checkpoint");
    await append(
      store,
      runId,
      "arenaMainWorkspaceObserved",
      preDispatch,
    );
    if (preDispatch.status !== "unchanged") {
      throw new Error("Arena source controls changed before dispatch.");
    }

    const preparationSettled = await Promise.allSettled(
      input.lock.contestants.map(
        async (contestant) => {
          const worktree = requiredWorktree(
            worktrees,
            contestant.contestantId,
          );
          const traceId = opaqueId("trace", runId, contestant.contestantId);
          const processGenerationId = opaqueId(
            "generation",
            runId,
            contestant.contestantId,
            randomUUID(),
          );
          const spec = await input.createProcess({
            runId,
            contestant,
            worktree,
            traceId,
            processGenerationId,
          });
          assertDigest(spec.contextSha256, "process context");
          assertControllerProcessSpec(spec, contestant);
          await input.assertMissionAuthority(input.lock.mission);
          return {
            contestant,
            worktree,
            traceId,
            processGenerationId,
            spec,
          };
        },
      ),
    );
    const preparationFailure = preparationSettled.find(
      (candidate): candidate is PromiseRejectedResult =>
        candidate.status === "rejected",
    );
    if (preparationFailure) throw preparationFailure.reason;
    const prepared = preparationSettled.map((candidate) =>
      (candidate as PromiseFulfilledResult<{
        readonly contestant: ArenaContestantLock;
        readonly worktree: ArenaProvisionedWorktree;
        readonly traceId: string;
        readonly processGenerationId: string;
        readonly spec: ArenaControllerProcessSpec;
      }>).value);

    // Process factories are intentionally provider-write-free, but may perform
    // slow local preparation. Recheck the source after every factory is ready
    // so a mutation during preparation reaches no head.
    const postPreparation = await monitor.observe("checkpoint");
    await append(
      store,
      runId,
      "arenaMainWorkspaceObserved",
      postPreparation,
    );
    if (postPreparation.status !== "unchanged") {
      throw new Error(
        "Arena source controls changed during process preparation.",
      );
    }

    // Every start event becomes durable inside its supervisor's submission
    // gate before that provider receives stdin. Individual process tasks repeat
    // the Mission authority check immediately before intent and spawn.
    let dispatchGate: Promise<void> = Promise.resolve();
    const withDispatchGate = async <T>(work: () => Promise<T>): Promise<T> => {
      const previous = dispatchGate;
      let release!: () => void;
      dispatchGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    };
    const contestantResults = await runArenaContestantBatch(
      prepared,
      signal,
      async (item, batch) => {
        await input.assertMissionAuthority(input.lock.mission);
        const commandFileIdentitySha256 =
          await arenaProcessFileIdentitySha256(item.spec.command);
        let dispatchBoundaryReached!: () => void;
        const dispatchBoundary = new Promise<void>((resolve) => {
          dispatchBoundaryReached = resolve;
        });
        let startedPublished = false;
        const supervisorInput: ArenaProcessSupervisorInput = {
          runId,
          contestantId: item.contestant.contestantId,
          traceId: item.traceId,
          registrationSha256: item.worktree.registrationSha256,
          worktreePath: item.worktree.worktreePath,
          worktreeDirectoryIdentitySha256:
            item.worktree.directoryIdentitySha256,
          command: item.spec.command,
          commandFileIdentitySha256,
          args: item.spec.args,
          stdin: item.spec.stdin,
          environmentPolicySha256: input.lock.environmentPolicySha256,
          invocationSha256: item.contestant.invocationSha256,
           timeoutMs: item.spec.timeoutMs,
           signal: batch.signal,
           processGenerationId: item.processGenerationId,
           ...(item.spec.bundledHelper
             ? { bundledHelper: item.spec.bundledHelper }
             : {}),
           ...(item.spec.nativeAdapterKind
             ? { nativeAdapterKind: item.spec.nativeAdapterKind }
             : {}),
           ...(item.spec.nativeQuiescenceBroker
             ? { nativeQuiescenceBroker: item.spec.nativeQuiescenceBroker }
             : {}),
          onSubmission: async (submission) => {
            let published = false;
            try {
              await append(store, runId, "arenaContestantStarted", {
                payloadType: "contestantStarted",
                contestantId: item.contestant.contestantId,
                traceId: item.traceId,
                inputBundleSha256: input.lock.inputBundleSha256,
                environmentPolicySha256:
                  input.lock.environmentPolicySha256,
                budgetSha256: input.lock.budgetSha256,
                promptSha256: sha256ArenaProcessUtf8(item.spec.stdin),
                contextSha256: item.spec.contextSha256,
                invocationSha256: item.contestant.invocationSha256,
                authoritySha256: item.contestant.authoritySha256,
                preparedFingerprintSha256: item.worktree.fingerprint.sha256,
                steering: "disabled",
              });
              startedPublished = true;
              await persistArenaDispatchReceipt(
                privateWorkspaceRoot,
                submission,
              );
              published = true;
            } finally {
              // A failed publication keeps the serialized dispatch gate until
              // the supervisor has terminated and classified this process.
              // That prevents a sibling spawn without racing classification
              // against a synchronous batch abort.
              if (published) dispatchBoundaryReached();
            }
          },
          postProcessFingerprintSha256: async () => {
            const state = await executor.captureOwnedEvidenceState(
              item.worktree,
              boundedArenaSafetySignal(),
            );
            evidenceStates.set(item.contestant.contestantId, state);
            return state.fingerprint.sha256;
          },
        };
        const intent = await prepareArenaProcessIntent(supervisorInput);
        const { resultPromise } = await withDispatchGate(async () => {
          if (batch.signal.aborted) {
            // A queued contestant that never reached spawn is a typed,
            // drain-complete beforeDispatch cancellation rather than a thrown
            // task. Persist the intent, let the pre-aborted supervisor prove
            // that no child was accepted, and preserve partial evidence below.
            await persistArenaDispatchReceipt(
              privateWorkspaceRoot,
              intent,
            );
            return {
              resultPromise: supervisePreparedArenaProcess(
                supervisorInput,
                intent,
              ),
            };
          }
          await input.assertMissionAuthority(input.lock.mission);
          const beforeIntent = await monitor!.observe("checkpoint");
          await append(
            store,
            runId,
            "arenaMainWorkspaceObserved",
            beforeIntent,
          );
          if (beforeIntent.status !== "unchanged") {
            throw new Error(
              "Arena source controls changed before contestant intent.",
            );
          }

          await persistArenaDispatchReceipt(
            privateWorkspaceRoot,
            intent,
          );

          // Persisting an intent can block on another VS Code window. Perform
          // one final source capture after it and immediately before spawn.
          const beforeSpawn = await monitor!.observe("checkpoint");
          await append(
            store,
            runId,
            "arenaMainWorkspaceObserved",
            beforeSpawn,
          );
          if (beforeSpawn.status !== "unchanged") {
            throw new Error(
              "Arena source controls changed before contestant spawn.",
            );
          }
          await input.assertMissionAuthority(input.lock.mission);
          const resultPromise = supervisePreparedArenaProcess(
            supervisorInput,
            intent,
          );
          await Promise.race([
            dispatchBoundary,
            resultPromise.then(
              (result) => {
                if (shouldAbortArenaBatch(result)) {
                  batch.abort(
                    new Error(
                      "Arena contestant failed before a safely supervised dispatch.",
                    ),
                  );
                }
              },
              (error) => batch.abort(error),
            ),
          ]);
          return { resultPromise };
        });
        const result = await resultPromise;
        if (result.submission !== null && !startedPublished) {
          throw new Error(
            "Arena process submission could not bind a durable start event.",
          );
        }
        if (result.intentSha256 !== intent.intentSha256) {
          throw new Error(
            "Arena process supervisor changed the durable intent.",
          );
        }
        if (result.submission) {
          await persistArenaDispatchReceipt(
            privateWorkspaceRoot,
            result.submission,
          );
        }
        if (result.quiescence) {
          await persistArenaDispatchReceipt(
            privateWorkspaceRoot,
            result.quiescence,
          );
        }
        if (shouldAbortArenaBatch(result)) {
          batch.abort(
            new Error(
              "Arena contestant failed before a safely supervised dispatch.",
            ),
          );
        }
        return result;
      },
    );

    for (const item of prepared) {
      const result = requiredResult(
        contestantResults,
        item.contestant.contestantId,
      );
      if (!evidenceStates.has(result.contestantId)
        && isConfirmedBeforeDispatch(result)) {
        evidenceStates.set(
          result.contestantId,
          await executor.captureOwnedEvidenceState(
            item.worktree,
            boundedArenaSafetySignal(),
          ),
        );
      }
    }
    if (contestantResults.some((result) =>
      !hasArenaCleanupProof(result)
      || !evidenceStates.has(result.contestantId))) {
      throw new Error(
        "Arena process delivery or descendant quiescence is unconfirmed; the run remains retained for recovery.",
      );
    }

    // Start one continuous sentinel per contestant before publishing terminal
    // state. It remains live through acceptance receipts and evidence
    // publication, closing the write/revert gaps between those phases.
    for (const item of prepared) {
      contestantMonitors.set(
        item.contestant.contestantId,
        watchDuelWorkspaceMutations(
          item.worktree.worktreePath,
          { excludeHydraState: false },
        ),
      );
    }

    const finishedEvents = new Map<string, ArenaManifestEvent>();
    const verificationEvents = new Map<
      string,
      Map<string, ArenaManifestEvent[]>
    >();
    const browserJourneyEvents = new Map<
      string,
      Map<string, ArenaManifestEvent[]>
    >();
    for (const item of prepared) {
      const result = requiredResult(
        contestantResults,
        item.contestant.contestantId,
      );
      const state = evidenceStates.get(item.contestant.contestantId)!;
      const finished = await append(store, runId, "arenaContestantFinished", {
        payloadType: "contestantFinished",
        contestantId: item.contestant.contestantId,
        stage: result.stage,
        traceId: result.traceId,
        status: result.status,
        failureCode: result.failureCode,
        finalHead: state.finalHead,
        finalWorkspaceFingerprintSha256: state.fingerprint.sha256,
        outputSha256: result.outputSha256,
        outputBytes: result.outputBytes,
      });
      finishedEvents.set(item.contestant.contestantId, finished);
      verificationEvents.set(item.contestant.contestantId, new Map());
      browserJourneyEvents.set(item.contestant.contestantId, new Map());
    }

    const verificationPlans = input.verificationPlans ?? [];
    const browserJourneyPlans = input.browserJourneyPlans ?? [];
    const acceptanceConfigured = verificationPlans.length > 0
      || browserJourneyPlans.length > 0;
    if (acceptanceConfigured
      && contestantResults.every((result) => result.status === "succeeded")) {
      for (const item of prepared) {
        const result = requiredResult(
          contestantResults,
          item.contestant.contestantId,
        );
        if (result.stage !== "execution") {
          throw new Error(
            "Arena acceptance cannot execute for a contestant that never reached dispatch.",
          );
        }
        const state = evidenceStates.get(item.contestant.contestantId)!;
        const expectedState: ArenaAcceptanceWorkspaceState = Object.freeze({
          head: state.finalHead,
          workspaceFingerprintSha256: state.fingerprint.sha256,
        });
        const acceptanceMonitor = contestantMonitors.get(
          item.contestant.contestantId,
        )!;
        const assertNoAcceptanceMutation = async (phase: string) => {
          await acceptanceMonitor.settle();
          if (acceptanceMonitor.error || acceptanceMonitor.changed) {
            throw new Error(
              `Arena contestant changed during locked acceptance ${phase}; the run remains retained for recovery.`,
            );
          }
        };
        const captureState = async (): Promise<ArenaAcceptanceWorkspaceState> => {
          const observed = await executor.captureOwnedEvidenceIdentity(
            item.worktree,
            boundedArenaSafetySignal(),
          );
          return Object.freeze({
            head: observed.finalHead,
            workspaceFingerprintSha256: observed.fingerprint.sha256,
          });
        };
        await assertNoAcceptanceMutation("preflight");
        for (const [index, plan] of verificationPlans.entries()) {
          await input.assertMissionAuthority(input.lock.mission);
          const attempt = await runArenaVerificationAttempt({
            privateWorkspaceRoot,
            runId,
            contestantId: item.contestant.contestantId,
            worktreePath: item.worktree.worktreePath,
            plan,
            locked: input.lock.verificationChecks[index]!,
            attempt: 1,
            expectedState,
            signal,
            captureState,
            execute: input.executeVerification!,
          });
          await assertNoAcceptanceMutation(`verification ${plan.checkId}`);
          const event = await append(
            store,
            runId,
            "arenaVerificationRecorded",
            attempt.payload,
          );
          appendAcceptanceEvent(
            verificationEvents.get(item.contestant.contestantId)!,
            plan.checkId,
            event,
          );
          await assertNoAcceptanceMutation(
            `verification ${plan.checkId} publication`,
          );
          assertAcceptanceStateMatchesExpected(
            attempt.payload.head,
            attempt.payload.workspaceFingerprintSha256,
            expectedState,
            `verification ${plan.checkId}`,
          );
          if (!attempt.receipt.terminationConfirmed) {
            throw new Error(
              `Arena verification ${plan.checkId} did not prove descendant-process quiescence; the run remains retained for recovery.`,
            );
          }
        }
        for (const [index, plan] of browserJourneyPlans.entries()) {
          await input.assertMissionAuthority(input.lock.mission);
          const attempt = await runArenaBrowserJourneyAttempt({
            privateWorkspaceRoot,
            runId,
            contestantId: item.contestant.contestantId,
            worktreePath: item.worktree.worktreePath,
            plan,
            locked: input.lock.browserJourneys[index]!,
            attempt: 1,
            expectedState,
            signal,
            captureState,
            execute: input.executeBrowserJourney!,
          });
          await assertNoAcceptanceMutation(`browser journey ${plan.journeyId}`);
          const event = await append(
            store,
            runId,
            "arenaBrowserJourneyRecorded",
            attempt.payload,
          );
          appendAcceptanceEvent(
            browserJourneyEvents.get(item.contestant.contestantId)!,
            plan.journeyId,
            event,
          );
          await assertNoAcceptanceMutation(
            `browser journey ${plan.journeyId} publication`,
          );
          assertAcceptanceStateMatchesExpected(
            attempt.payload.head,
            attempt.payload.workspaceFingerprintSha256,
            expectedState,
            `browser journey ${plan.journeyId}`,
          );
        }
      }
    }

    const evidenceEvents = new Map<string, ArenaManifestEvent>();
    const evidencePayloads = new Map<string, ArenaEvidencePreservedPayload>();
    for (const item of prepared) {
      const result = requiredResult(
        contestantResults,
        item.contestant.contestantId,
      );
      const state = evidenceStates.get(item.contestant.contestantId)!;
      const finished = finishedEvents.get(item.contestant.contestantId)!;
      const contestantVerificationEvents = verificationEvents.get(
        item.contestant.contestantId,
      )!;
      const contestantBrowserEvents = browserJourneyEvents.get(
        item.contestant.contestantId,
      )!;
      const evidenceMonitor = contestantMonitors.get(
        item.contestant.contestantId,
      )!;
      let captured: Awaited<ReturnType<typeof preserveArenaEvidence>>;
      try {
        const confirmEvidenceSnapshot = async (
          phase: "staging" | "publication",
        ): Promise<void> => {
          await assertArenaEvidenceIdentity(executor, item.worktree, state);
          await evidenceMonitor.settle();
          if (evidenceMonitor.error || evidenceMonitor.changed) {
            throw new Error(
              `Arena contestant changed during private evidence ${phase}${
                evidenceMonitor.changedPaths.length > 0
                  ? `: ${evidenceMonitor.changedPaths.join(", ")}`
                  : "."
              }`,
            );
          }
        };
        await confirmEvidenceSnapshot("staging");
        captured = await preserveArenaEvidence({
          privateWorkspaceRoot,
          runId,
          contestantId: item.contestant.contestantId,
          worktreePath: item.worktree.worktreePath,
          patch: state.patch,
          untrackedPaths: state.untrackedPaths,
          receiptsRootSha256: arenaReceiptsRootSha256({
            finished,
            verifications: contestantVerificationEvents,
            browserJourneys: contestantBrowserEvents,
          }),
          quiescenceReceiptSha256: result.quiescenceReceiptSha256,
          quiescenceWorkspaceFingerprintSha256:
            result.quiescenceWorkspaceFingerprintSha256,
          finalHead: state.finalHead,
          finalWorkspaceFingerprintSha256: state.fingerprint.sha256,
          confirmSnapshotBeforePublication: () =>
            confirmEvidenceSnapshot("staging"),
          confirmSnapshotAfterPublication: () =>
            confirmEvidenceSnapshot("publication"),
        });
      } finally {
        evidenceMonitor.close();
        contestantMonitors.delete(item.contestant.contestantId);
      }
      await verifyArenaArtifactSet({
        privateWorkspaceRoot,
        runId,
        contestantId: item.contestant.contestantId,
        payload: captured.payload,
      });
      const evidence = await append(
        store,
        runId,
        "arenaEvidencePreserved",
        captured.payload,
      );
      evidenceEvents.set(item.contestant.contestantId, evidence);
      evidencePayloads.set(item.contestant.contestantId, captured.payload);
    }

    // Evidence integrity is a precondition of terminal comparability. Perform
    // one all-contestant pass before the fresh post-evidence source snapshot
    // so the potentially long byte reads do not create an unmonitored gap.
    for (const item of prepared) {
      await verifyArenaArtifactSet({
        privateWorkspaceRoot,
        runId,
        contestantId: item.contestant.contestantId,
        payload: evidencePayloads.get(item.contestant.contestantId)!,
      });
    }

    const beforeFinalization = await requiredReplay(store, runId);

    const postEvidencePayload = await monitor.observe("postEvidence");
    const postEvidence = await append(
      store,
      runId,
      "arenaMainWorkspaceObserved",
      postEvidencePayload,
    );
    const publicationSealPayload = await monitor.sealPublication({
      postEvidenceEventSha256: postEvidence.eventSha256,
      postEvidenceReceiptSha256: postEvidencePayload.monitorReceiptSha256,
    });
    await append(
      store,
      runId,
      "arenaMainWorkspaceObserved",
      publicationSealPayload,
    );
    monitor = undefined;
    const terminalClassification = classifyArenaControllerStatuses(
      contestantResults.map((result) => result.status),
      signal.aborted,
    );
    const allSucceeded = terminalClassification.outcome === "completed";
    let matrixSha256: string | null = null;
    if (allSucceeded) {
      matrixSha256 = arenaEvidenceMatrixSha256({
        lockEventSha256: lockEvent.eventSha256,
        postEvidenceEventSha256: postEvidence.eventSha256,
        contestants: input.lock.contestants.map((contestant) => ({
          contestantId: contestant.contestantId,
          finishedEventSha256:
            finishedEvents.get(contestant.contestantId)!.eventSha256,
          verificationEventSha256s: input.lock.verificationChecks.flatMap(
            (check) => (
              verificationEvents.get(contestant.contestantId)!
                .get(check.checkId) ?? []
            ).map((event) => event.eventSha256),
          ),
          browserJourneyEventSha256s: input.lock.browserJourneys.flatMap(
            (journey) => (
              browserJourneyEvents.get(contestant.contestantId)!
                .get(journey.journeyId) ?? []
            ).map((event) => event.eventSha256),
          ),
          evidenceEventSha256:
            evidenceEvents.get(contestant.contestantId)!.eventSha256,
        })),
      });
    }
    const postEvidenceCompromised = postEvidencePayload.status !== "unchanged";
    const publicationSealCompromised =
      publicationSealPayload.status !== "unchanged";
    const compromised = beforeFinalization.compromised
      || postEvidenceCompromised
      || publicationSealCompromised;
    await append(store, runId, "arenaRunFinalized", {
      payloadType: "runFinalized",
      outcome: terminalClassification.outcome,
      comparison: allSucceeded
        ? compromised
          ? "compromised"
          : "comparable"
        : "incomplete",
      reasonCode: allSucceeded
        ? compromised
          ? postEvidenceCompromised
            ? reasonForMonitor(postEvidencePayload.reasonCode)
            : publicationSealCompromised
              ? reasonForMonitor(publicationSealPayload.reasonCode)
            : reasonForReplay(beforeFinalization)
          : null
        : terminalClassification.reasonCode,
      evidenceMatrixSha256: matrixSha256,
    });

    for (const item of prepared) {
      const result = requiredResult(
        contestantResults,
        item.contestant.contestantId,
      );
      await runArenaCleanupTarget({
        executor,
        store,
        worktree: item.worktree,
        processQuiescence: {
          kind: "processQuiescence",
          processOwnerSha256: result.processOwnerSha256,
          terminationConfirmed: true,
          activeProcessCount: 0,
        },
        // A user Stop terminates the provider; once quiescence and evidence
        // exist, exact cleanup is a separate safety operation.
        signal: signal.aborted ? undefined : signal,
      });
    }
    await executor.releaseRepositoryRun(runId);
    claimActive = false;
    const replay = await requiredReplay(store, runId);
    return Object.freeze({
      replay,
      admission,
      contestantResults: Object.freeze(contestantResults),
      flightProjectionComplete: await completeFlightProjection(
        projectingStore,
        flightProjectionAvailable,
      ),
    });
  } catch (error) {
    const evidenceCleanup = await Promise.allSettled(
      [...evidenceStates.entries()].map(([contestantId, state]) =>
        discardArenaEvidenceCaptureStages({
          privateWorkspaceRoot,
          runId,
          contestantId,
          patch: state.patch,
          untrackedPaths: state.untrackedPaths,
        })),
    );
    const evidenceCleanupErrors = evidenceCleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []);
    // Never infer that a provider did not receive input. The durable intent,
    // any submission receipt, worktrees, and repository claim remain available
    // for an explicit recovery flow; this controller does not retry.
    if (claimActive) {
      try {
        const replay = await store.load(runId);
        const hasRegisteredTarget = replay?.contestants.some((contestant) =>
          contestant.worktreeRegistered !== undefined) === true;
        if (replay && !replay.finalization && !hasRegisteredTarget) {
          await append(store, runId, "arenaRunFinalized", {
            payloadType: "runFinalized",
            outcome: signal.aborted ? "cancelled" : "failed",
            comparison: "incomplete",
            reasonCode: signal.aborted ? "userCancelled" : "unknown",
            evidenceMatrixSha256: null,
          });
          await executor.releaseRepositoryRun(runId);
          claimActive = false;
        }
      } catch {
        // A receipt may exist in the intent/manifest crash window. Releasing
        // would be unsafe; preserve ownership for explicit reconciliation.
      }
    }
    if (claimActive) executor.abandonRepositoryRun(runId);
    if (evidenceCleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...evidenceCleanupErrors],
        "Arena controller failure also left evidence stages uncleaned.",
      );
    }
    throw error;
  } finally {
    await projectingStore?.flushProjection();
    for (const contestantMonitor of contestantMonitors.values()) {
      contestantMonitor.close();
    }
    contestantMonitors.clear();
    monitor?.close();
  }
}

async function assertArenaEvidenceIdentity(
  executor: ArenaGitExecutor,
  worktree: ArenaProvisionedWorktree,
  expected: ArenaOwnedEvidenceState,
): Promise<void> {
  const observed = await executor.captureOwnedEvidenceIdentity(
    worktree,
    boundedArenaSafetySignal(),
  );
  if (observed.fingerprint.sha256 !== expected.fingerprint.sha256
    || observed.finalHead.objectFormat !== expected.finalHead.objectFormat
    || observed.finalHead.oid !== expected.finalHead.oid) {
    throw new Error(
      "Arena contestant state changed during private evidence preservation.",
    );
  }
}

async function finalizeWithoutTargets(
  store: ArenaManifestStore,
  executor: ArenaGitExecutor,
  runId: string,
  reasonCode: ArenaFinalizationReason,
): Promise<void> {
  await append(store, runId, "arenaRunFinalized", {
    payloadType: "runFinalized",
    outcome: "failed",
    comparison: "incomplete",
    reasonCode,
    evidenceMatrixSha256: null,
  });
  await executor.releaseRepositoryRun(runId);
}

function assertControllerLock(input: ArenaControllerInput): void {
  if (input.lock.preparationPlanSha256 !== null
    || input.lock.steering !== "disabled") {
    throw new Error(
      "Arena core supports no preparation or steering plan.",
    );
  }
  const verificationPlans = input.verificationPlans ?? [];
  const browserJourneyPlans = input.browserJourneyPlans ?? [];
  assertArenaAcceptancePlanSet(
    input.lock,
    verificationPlans,
    browserJourneyPlans,
  );
  if (verificationPlans.length > 0
    && typeof input.executeVerification !== "function") {
    throw new Error(
      "Arena locked verification plans require a trusted worktree executor.",
    );
  }
  if (browserJourneyPlans.length > 0
    && typeof input.executeBrowserJourney !== "function") {
    throw new Error(
      "Arena locked browser journeys require an owned browser broker executor.",
    );
  }
}

function assertControllerProcessSpec(
  spec: ArenaControllerProcessSpec,
  contestant: ArenaContestantLock,
): void {
  const bundled = spec.bundledHelper !== undefined;
  const nativeAdapter = spec.nativeAdapterKind !== undefined;
  const nativeBroker = spec.nativeQuiescenceBroker !== undefined;
  if (bundled && (nativeAdapter || nativeBroker)) {
    throw new Error(
      "Arena cannot combine its bounded helper with a native process broker.",
    );
  }
  if (!bundled && (!nativeAdapter || !nativeBroker)) {
    throw new Error(
      "Arena native admission requires an exact adapter and descendant-quiescence broker.",
    );
  }
  if (nativeAdapter
    && (spec.nativeAdapterKind !== contestant.agentKind
      || spec.nativeQuiescenceBroker!.adapterKind
        !== contestant.agentKind)) {
    throw new Error(
      "Arena native process broker does not match the locked contestant adapter.",
    );
  }
}

function appendAcceptanceEvent(
  events: Map<string, ArenaManifestEvent[]>,
  acceptanceId: string,
  event: ArenaManifestEvent,
): void {
  const attempts = events.get(acceptanceId) ?? [];
  attempts.push(event);
  events.set(acceptanceId, attempts);
}

function assertAcceptanceStateMatchesExpected(
  head: ArenaAcceptanceWorkspaceState["head"],
  workspaceFingerprintSha256: string,
  expected: ArenaAcceptanceWorkspaceState,
  label: string,
): void {
  if (head.objectFormat !== expected.head.objectFormat
    || head.oid !== expected.head.oid
    || workspaceFingerprintSha256
      !== expected.workspaceFingerprintSha256) {
    throw new Error(
      `Arena ${label} changed the contestant worktree; the run remains retained for recovery.`,
    );
  }
}

async function completeFlightProjection(
  store: ArenaFlightProjectingManifestStore | undefined,
  available: boolean,
): Promise<boolean> {
  return available && store !== undefined && await store.flushProjection();
}

function assertLockMatchesAdmission(
  lock: ArenaRunLockedPayload,
  admission: ArenaGitAdmission,
): void {
  if (lock.base.revision.objectFormat !== admission.baseRevision.objectFormat
    || lock.base.revision.oid !== admission.baseRevision.oid
    || lock.base.repositoryIdentitySha256
      !== admission.repositoryIdentitySha256
    || lock.base.baseContentSha256 !== admission.baseContentSha256
    || lock.base.sourceWorkspaceFingerprintSha256
      !== admission.sourceWorkspaceFingerprintSha256
    || lock.base.repositoryControlSha256
      !== admission.repositoryControlSha256) {
    throw new Error("Arena lock does not bind the admitted repository state.");
  }
}

async function append(
  store: ArenaManifestStore,
  runId: string,
  type: Parameters<ArenaManifestStore["append"]>[0]["type"],
  payload: Parameters<ArenaManifestStore["append"]>[0]["payload"],
): Promise<ArenaManifestEvent> {
  return store.append({
    eventId: opaqueId("event", runId, type, String(
      (payload as { readonly contestantId?: string }).contestantId ?? "",
    ), canonicalArenaManifestJson(payload)),
    runId,
    occurredAt: new Date().toISOString(),
    type,
    payload,
  });
}

function opaqueId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHash("sha256")
    .update(`hydra.arena.controller.${prefix}.v1\u0000`, "utf8")
    .update(canonicalArenaManifestJson(parts), "utf8")
    .digest("hex");
  return `${prefix}-${digest.slice(0, 48)}`;
}

function requiredWorktree(
  worktrees: readonly ArenaProvisionedWorktree[],
  contestantId: string,
): ArenaProvisionedWorktree {
  const worktree = worktrees.find((candidate) =>
    candidate.contestantId === contestantId);
  if (!worktree) throw new Error("Arena provisioned worktree is missing.");
  return worktree;
}

function requiredResult(
  results: readonly ArenaSupervisedProcessResult[],
  contestantId: string,
): ArenaSupervisedProcessResult {
  const result = results.find((candidate) =>
    candidate.contestantId === contestantId);
  if (!result) throw new Error("Arena contestant result is missing.");
  return result;
}

function isConfirmedBeforeDispatch(
  result: ArenaSupervisedProcessResult,
): boolean {
  return result.stage === "beforeDispatch"
    && result.terminationConfirmed
    && result.submission === null
    && result.submissionReceiptSha256 === null
    && result.quiescence === null
    && result.quiescenceReceiptSha256 === null
    && result.quiescenceWorkspaceFingerprintSha256 === null;
}

function hasArenaCleanupProof(
  result: ArenaSupervisedProcessResult,
): boolean {
  if (isConfirmedBeforeDispatch(result)) return true;
  return result.stage === "execution"
    && result.terminationConfirmed
    && result.submission !== null
    && result.submissionReceiptSha256 !== null
    && result.quiescence !== null
    && result.quiescenceReceiptSha256 !== null
    && result.quiescenceWorkspaceFingerprintSha256 !== null;
}

export function classifyArenaControllerStatuses(
  statuses: readonly ArenaSupervisedProcessResult["status"][],
  parentAborted: boolean,
): {
  readonly outcome: "completed" | "cancelled" | "failed";
  readonly reasonCode: null | "userCancelled" | "contestantFailed";
} {
  if (statuses.length === 0) {
    throw new Error("Arena controller cannot classify an empty result set.");
  }
  // Supervised contestant results are the terminal causal record. A Stop that
  // arrives after every contestant has already succeeded may still be visible
  // on the parent signal while evidence is being sealed, but it cannot
  // retroactively cancel those completed executions.
  if (statuses.every((status) => status === "succeeded")) {
    return Object.freeze({ outcome: "completed", reasonCode: null });
  }
  const hasIndependentFailure = statuses.some((status) =>
    status !== "succeeded" && status !== "cancelled");
  const userCancelled = parentAborted
    && !hasIndependentFailure
    && statuses.some((status) => status === "cancelled");
  return Object.freeze(userCancelled
    ? { outcome: "cancelled", reasonCode: "userCancelled" }
    : { outcome: "failed", reasonCode: "contestantFailed" });
}

function shouldAbortArenaBatch(
  result: ArenaSupervisedProcessResult,
): boolean {
  return !result.terminationConfirmed
    || (result.stage === "beforeDispatch" && result.status !== "cancelled")
    || result.diagnosticCode === "submissionPersistenceFailed";
}

function reasonForMonitor(
  reason: string | null,
): ArenaFinalizationReason {
  if (reason === "repositoryControlChanged") {
    return "repositoryControlChanged";
  }
  if (reason === "monitorFailed"
    || reason === "fingerprintFailed"
    || reason === "registryMismatch") {
    return "monitorFailed";
  }
  return "mainWorkspaceChanged";
}

function reasonForReplay(
  replay: ArenaManifestReplay,
): ArenaFinalizationReason {
  if (replay.compromiseReasons.includes("repositoryControlChanged")) {
    return "repositoryControlChanged";
  }
  if (replay.compromiseReasons.includes("contestantHeadChanged")) {
    return "contestantHeadChanged";
  }
  if (replay.compromiseReasons.includes("verificationMutatedWorkspace")) {
    return "verificationMutatedWorkspace";
  }
  if (replay.compromiseReasons.includes("browserMutatedWorkspace")) {
    return "browserMutatedWorkspace";
  }
  if (replay.compromiseReasons.some((reason) =>
    ["monitorFailed", "fingerprintFailed", "registryMismatch"].includes(reason))) {
    return "monitorFailed";
  }
  if (replay.compromiseReasons.includes("evidenceStateMismatch")) {
    return "evidenceStateMismatch";
  }
  return "mainWorkspaceChanged";
}

function assertDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Arena ${label} digest is invalid.`);
  }
}

async function requiredReplay(
  store: ArenaManifestStore,
  runId: string,
): Promise<ArenaManifestReplay> {
  const replay = await store.load(runId);
  if (!replay) throw new Error("Arena controller manifest disappeared.");
  return replay;
}

function boundedArenaSafetySignal(): AbortSignal {
  return AbortSignal.timeout(ARENA_SAFETY_CAPTURE_TIMEOUT_MS);
}
