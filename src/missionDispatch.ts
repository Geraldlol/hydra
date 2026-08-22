import type { MissionContractBinding } from "./missionContract";

export const MISSION_SUBMISSION_WRITTEN: unique symbol =
  Symbol("hydra.missionSubmissionWritten");

export type MissionSubmissionWritten = typeof MISSION_SUBMISSION_WRITTEN;

export type MissionSubmissionPoint =
  | "native.oneShot"
  | "http.request"
  | "terminal.dispatch"
  | "terminal.rawLine"
  | "codex.turnStart"
  | "codex.turnSteer"
  | "claude.initial"
  | "claude.steer"
  | "hydra.queueNext";

/**
 * Serializes only a branded irreversible provider write against Mission
 * Contract confirmation. A model-completion Promise cannot satisfy this
 * contract accidentally.
 */
export interface MissionSubmissionGate {
  write(
    point: MissionSubmissionPoint,
    performWrite: () => MissionSubmissionWritten | Promise<MissionSubmissionWritten>,
  ): Promise<void>;
}

/** The authoritative binding changed or became unreadable before any write. */
export class MissionSubmissionRejectedError extends Error {
  constructor(message = "Mission Contract binding rejected before provider submission.") {
    super(message);
    this.name = "MissionSubmissionRejectedError";
  }
}

/** Cancellation was observed at the exact gate before any provider write. */
export class SubmissionCancelledBeforeWriteError extends Error {
  constructor(message = "Submission was cancelled before any provider write.") {
    super(message);
    this.name = "SubmissionCancelledBeforeWriteError";
  }
}

export type MissionDispatchAuthorization =
  | {
      readonly kind: "bound";
      readonly binding: MissionContractBinding;
      readonly roomTurnId: string;
      readonly submissionGate: MissionSubmissionGate;
    }
  | {
      readonly kind: "maintenanceExempt";
      readonly reason: "diagnosticProbe";
    };

/**
 * Some transports start the paid/native request synchronously and return a
 * Promise for its full lifetime. Wrap that Promise in a value so the Mission
 * lease is released after start, not after completion.
 */
export async function startMissionBoundSubmission<T>(
  gate: MissionSubmissionGate,
  point: Extract<MissionSubmissionPoint, "native.oneShot" | "http.request">,
  start: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let completion: Promise<T> | undefined;
  await gate.write(point, () => {
    if (signal?.aborted) {
      throw new SubmissionCancelledBeforeWriteError(
        `${point} was cancelled before provider submission.`,
      );
    }
    completion = start();
    return MISSION_SUBMISSION_WRITTEN;
  });
  if (!completion) {
    throw new Error(`Mission submission gate did not start ${point}.`);
  }
  return completion;
}

export function missionDispatchTraceFields(
  authorization: MissionDispatchAuthorization,
): Record<string, string | null> {
  if (authorization.kind === "maintenanceExempt") {
    return { missionDispatchExemption: authorization.reason };
  }
  return {
    missionBindingSha256: authorization.binding.bindingSha256,
    missionDocumentSha256: authorization.binding.documentSha256,
    roomTurnId: authorization.roomTurnId,
  };
}
