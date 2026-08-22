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
import { preserveArenaEvidence } from "./arenaEvidence";
import {
  startArenaMainWorkspaceMonitor,
  type ArenaMainWorkspaceMonitor,
} from "./arenaMainWorkspaceMonitor";
import { persistArenaMonitorReceipt } from "./arenaMonitorReceiptStore";
import {
  createArenaProcessIntent,
  arenaProcessFileIdentitySha256,
  sha256ArenaProcessUtf8,
  superviseArenaProcess,
  type ArenaBundledProcessHelper,
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
   * Stage 3 admits only Hydra's bounded fake provider. Native head adapters
   * remain disabled until they can prove descendant-process quiescence.
   */
  readonly bundledHelper: ArenaBundledProcessHelper;
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
}

export interface ArenaControllerResult {
  readonly replay: ArenaManifestReplay;
  readonly admission: ArenaGitAdmission;
  readonly contestantResults: readonly ArenaSupervisedProcessResult[];
}

/**
 * Stage-3 Arena orchestration. This controller deliberately has no panel,
 * steering, Terminal Bridge, winner, merge, commit, or promotion dependency.
 * All provider writes pass through the dedicated bounded process supervisor.
 */
export async function runArenaController(
  input: ArenaControllerInput,
): Promise<ArenaControllerResult> {
  assertStageThreeLock(input.lock);
  const signal = input.signal ?? new AbortController().signal;
  await input.assertMissionAuthority(input.lock.mission);
  const executor = await ArenaGitExecutor.open(
    input.workspaceRoot,
    input.privateWorkspaceRoot,
    input.repositoryLeaseRoot,
    input.gitResolutionRoot ?? input.workspaceRoot,
  );
  const admission = await executor.inspectAdmission(signal);
  assertLockMatchesAdmission(input.lock, admission);
  const store = await openFileArenaManifestStore(input.privateWorkspaceRoot);
  if (await store.load(input.runId)) {
    throw new Error("Arena controller refuses to reuse an existing run.");
  }
  const runId = input.runId;
  const lockEvent = await append(store, runId, "arenaRunLocked", input.lock);

  let claimActive = false;
  let monitor: ArenaMainWorkspaceMonitor | undefined;
  let planned = false;
  const worktrees: ArenaProvisionedWorktree[] = [];
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
            input.privateWorkspaceRoot,
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
          if (!spec.bundledHelper) {
            throw new Error(
              "Arena stage 3 permits only the bounded bundled fake-head helper.",
            );
          }
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
    const evidenceStates = new Map<string, ArenaOwnedEvidenceState>();
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
          bundledHelper: item.spec.bundledHelper,
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
                input.privateWorkspaceRoot,
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
        const intent = createArenaProcessIntent({
          ...supervisorInput,
          processGenerationId: item.processGenerationId,
        });
        const { resultPromise } = await withDispatchGate(async () => {
          if (batch.signal.aborted) {
            // A queued contestant that never reached spawn is a typed,
            // drain-complete beforeDispatch cancellation rather than a thrown
            // task. Persist the intent, let the pre-aborted supervisor prove
            // that no child was accepted, and preserve partial evidence below.
            await persistArenaDispatchReceipt(
              input.privateWorkspaceRoot,
              intent,
            );
            return {
              resultPromise: superviseArenaProcess(supervisorInput),
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
            input.privateWorkspaceRoot,
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
          const resultPromise = superviseArenaProcess(supervisorInput);
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
            input.privateWorkspaceRoot,
            result.submission,
          );
        }
        if (result.quiescence) {
          await persistArenaDispatchReceipt(
            input.privateWorkspaceRoot,
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

    const finishedEvents = new Map<string, ArenaManifestEvent>();
    const evidenceEvents = new Map<string, ArenaManifestEvent>();
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
      const captured = await preserveArenaEvidence({
        privateWorkspaceRoot: input.privateWorkspaceRoot,
        runId,
        contestantId: item.contestant.contestantId,
        worktreePath: item.worktree.worktreePath,
        patch: state.patch,
        untrackedPathsZ: state.untrackedPathsZ,
        receiptsRootSha256: arenaReceiptsRootSha256({
          finished,
          verifications: new Map(),
          browserJourneys: new Map(),
        }),
        quiescenceReceiptSha256: result.quiescenceReceiptSha256,
        quiescenceWorkspaceFingerprintSha256:
          result.quiescenceWorkspaceFingerprintSha256,
        finalHead: state.finalHead,
        finalWorkspaceFingerprintSha256: state.fingerprint.sha256,
      });
      const evidenceRecheck = await executor.captureOwnedEvidenceState(
        item.worktree,
        boundedArenaSafetySignal(),
      );
      if (evidenceRecheck.fingerprint.sha256 !== state.fingerprint.sha256
        || evidenceRecheck.finalHead.objectFormat
          !== state.finalHead.objectFormat
        || evidenceRecheck.finalHead.oid !== state.finalHead.oid) {
        throw new Error(
          "Arena contestant state changed during private evidence preservation.",
        );
      }
      const evidence = await append(
        store,
        runId,
        "arenaEvidencePreserved",
        captured.payload,
      );
      evidenceEvents.set(item.contestant.contestantId, evidence);
    }

    const postEvidencePayload = await monitor.observe("postEvidence");
    const postEvidence = await append(
      store,
      runId,
      "arenaMainWorkspaceObserved",
      postEvidencePayload,
    );
    monitor.close();
    monitor = undefined;

    const beforeFinalization = await requiredReplay(store, runId);
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
          verificationEventSha256s: [],
          browserJourneyEventSha256s: [],
          evidenceEventSha256:
            evidenceEvents.get(contestant.contestantId)!.eventSha256,
        })),
      });
    }
    const compromised = beforeFinalization.compromised;
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
          ? reasonForReplay(beforeFinalization)
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
    return Object.freeze({
      replay: await requiredReplay(store, runId),
      admission,
      contestantResults: Object.freeze(contestantResults),
    });
  } catch (error) {
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
    throw error;
  } finally {
    monitor?.close();
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

function assertStageThreeLock(lock: ArenaRunLockedPayload): void {
  if (lock.preparationPlanSha256 !== null
    || lock.verificationChecks.length !== 0
    || lock.browserJourneys.length !== 0
    || lock.steering !== "disabled") {
    throw new Error(
      "Arena stage 3 supports no preparation, verification, browser journey, or steering plan.",
    );
  }
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
