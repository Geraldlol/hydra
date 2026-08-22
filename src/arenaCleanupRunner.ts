import { createHash } from "node:crypto";
import {
  arenaCleanupPostconditionSha256,
  arenaCleanupRetryDelayMs,
  arenaCleanupStepReceiptSha256,
  isArenaCleanupRetryableFailure,
  type ArenaCleanupFailureCode,
  type ArenaCleanupOutcome,
  type ArenaCleanupPostcondition,
  type ArenaCleanupStep,
  type ArenaCleanupStepPayload,
} from "./arenaCleanup";
import {
  ArenaGitError,
  type ArenaGitExecutor,
  type ArenaOwnedWorktree,
} from "./arenaGit";
import type { ArenaManifestStore } from "./arenaStore";
import {
  canonicalArenaManifestJson,
  type ArenaManifestReplay,
} from "./arenaRunManifest";

export interface ArenaCleanupRunnerInput {
  readonly executor: ArenaGitExecutor;
  readonly store: ArenaManifestStore;
  readonly worktree: ArenaOwnedWorktree;
  readonly processQuiescence: Extract<
    ArenaCleanupPostcondition,
    { readonly kind: "processQuiescence" }
  >;
  readonly signal?: AbortSignal;
  readonly wait?: (delayMs: number) => Promise<void>;
}

/**
 * Drives exactly the next cleanup operation authorized by manifest replay.
 * Every retry reloads replay state, so a crash after the side effect but before
 * its receipt simply re-enters an idempotent exact-target operation.
 */
export async function runArenaCleanupTarget(
  input: ArenaCleanupRunnerInput,
): Promise<ArenaManifestReplay> {
  const wait = input.wait ?? ((delayMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  while (true) {
    if (input.signal?.aborted) {
      throw new Error("Arena cleanup was cancelled.");
    }
    const replay = await requiredReplay(input.store, input.worktree.runId);
    const contestant = replay.contestants.find((candidate) =>
      candidate.lock.contestantId === input.worktree.contestantId);
    if (!contestant
      || !contestant.worktreeRegistered
      || !contestant.evidencePreserved) {
      throw new Error("Arena cleanup lacks registered, preserved authority.");
    }
    if (contestant.cleanup.status === "complete"
      || contestant.cleanup.status === "blocked") {
      return replay;
    }
    const step = contestant.cleanup.nextStep;
    const attempt = contestant.cleanup.nextAttempt;
    if (!step || !attempt) {
      throw new Error("Arena cleanup replay lacks an authorized next operation.");
    }
    const cleanupId = contestant.cleanup.cleanupId
      ?? `${input.worktree.runId}-${input.worktree.contestantId}-cleanup`;
    let outcome: ArenaCleanupOutcome;
    let failureCode: ArenaCleanupFailureCode | null = null;
    let retryDelayMs: number | null = null;
    let postcondition: ArenaCleanupPostcondition;
    try {
      const result = await executeStep(input, step);
      outcome = result.outcome;
      postcondition = result.postcondition;
    } catch (error) {
      failureCode = cleanupFailureCode(error);
      const delay = isArenaCleanupRetryableFailure(failureCode)
        ? arenaCleanupRetryDelayMs(attempt)
        : null;
      if (delay !== null) {
        outcome = "retryableFailure";
        retryDelayMs = delay;
      } else {
        outcome = "blocked";
        failureCode = isArenaCleanupRetryableFailure(failureCode)
          ? "retryExhausted"
          : failureCode;
      }
      postcondition = {
        kind: "cleanupFailure",
        failureCode,
        observedStateSha256: hash({
          step,
          attempt,
          failureCode,
          errorCode: errorCode(error),
        }),
      };
    }
    const withoutReceipt = {
      payloadType: "cleanupStepRecorded",
      runId: input.worktree.runId,
      cleanupId,
      contestantId: input.worktree.contestantId,
      registrationSha256: (
        contestant.worktreeRegistered.payload as {
          readonly registrationSha256: string;
        }
      ).registrationSha256,
      evidenceEventSha256: contestant.evidencePreserved.eventSha256,
      step,
      attempt,
      outcome,
      failureCode,
      retryDelayMs,
      postcondition,
      postconditionSha256: arenaCleanupPostconditionSha256(postcondition),
    } satisfies Omit<ArenaCleanupStepPayload, "stepReceiptSha256">;
    await input.store.append({
      eventId: `${cleanupId}-${step}-${attempt}`,
      runId: input.worktree.runId,
      occurredAt: new Date().toISOString(),
      type: "arenaCleanupStepRecorded",
      payload: {
        ...withoutReceipt,
        stepReceiptSha256: arenaCleanupStepReceiptSha256(withoutReceipt),
      },
    });
    if (outcome === "retryableFailure") {
      await wait(retryDelayMs!);
    }
  }
}

async function executeStep(
  input: ArenaCleanupRunnerInput,
  step: ArenaCleanupStep,
): Promise<{
  readonly outcome: "succeeded" | "notNeeded";
  readonly postcondition: ArenaCleanupPostcondition;
}> {
  if (step === "quiesceProcesses") {
    if (!input.processQuiescence.terminationConfirmed
      || input.processQuiescence.activeProcessCount !== 0) {
      throw Object.assign(
        new Error("Arena contestant processes remain active."),
        { code: "PROCESS_RUNNING" },
      );
    }
    return { outcome: "succeeded", postcondition: input.processQuiescence };
  }
  if (step === "verifyTarget") {
    return {
      outcome: "succeeded",
      postcondition: await input.executor.captureCleanupPostcondition(
        input.worktree,
        step,
        input.signal,
      ),
    };
  }
  const outcome = step === "unlockGitWorktree"
    ? await input.executor.unlockOwnedWorktree(
      input.worktree,
      input.signal,
    )
    : step === "removeGitWorktree"
      ? await input.executor.removeOwnedWorktree(
        input.worktree,
        input.signal,
      )
      : step === "removeResidualDirectory"
        ? await input.executor.removeResidualDirectory(
          input.worktree,
          input.signal,
        )
        : "succeeded";
  return {
    outcome,
    postcondition: await input.executor.captureCleanupPostcondition(
      input.worktree,
      step,
      input.signal,
    ),
  };
}

function cleanupFailureCode(error: unknown): ArenaCleanupFailureCode {
  const code = errorCode(error);
  if (code === "PROCESS_RUNNING") return "processStillRunning";
  if (code === "EBUSY") return "pathBusy";
  if (code === "ENOTEMPTY") return "directoryNotEmpty";
  if (code === "EPERM" || code === "EACCES") return "sharingViolation";
  if (error instanceof ArenaGitError) {
    if (error.code === "unsafePath") return "unsafePath";
    if (error.code === "registrationMismatch") return "registrationMismatch";
    if (error.code === "worktreeStateMismatch") return "identityMismatch";
    if (error.code === "worktreeExists") return "directoryNotEmpty";
    return "gitRejected";
  }
  return "ioFailure";
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    && typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as { readonly code: string }).code.slice(0, 64)
    : "unknown";
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update("hydra.arena.cleanup.failure-state.v1\u0000", "utf8")
    .update(canonicalArenaManifestJson(value), "utf8")
    .digest("hex");
}

async function requiredReplay(
  store: ArenaManifestStore,
  runId: string,
): Promise<ArenaManifestReplay> {
  const replay = await store.load(runId);
  if (!replay) throw new Error("Arena manifest is missing during cleanup.");
  return replay;
}
