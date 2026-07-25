export const ARENA_CLEANUP_STEPS = Object.freeze([
  "quiesceProcesses",
  "verifyTarget",
  "unlockGitWorktree",
  "removeGitWorktree",
  "verifyGitRegistrationGone",
  "removeResidualDirectory",
] as const);

export type ArenaCleanupStep = typeof ARENA_CLEANUP_STEPS[number];

export const ARENA_CLEANUP_RETRY_DELAYS_MS = Object.freeze([
  50,
  100,
  250,
  500,
  1_000,
  2_000,
] as const);

export type ArenaCleanupOutcome =
  | "succeeded"
  | "notNeeded"
  | "retryableFailure"
  | "blocked";

export type ArenaCleanupFailureCode =
  | "processStillRunning"
  | "sharingViolation"
  | "pathBusy"
  | "directoryNotEmpty"
  | "gitRejected"
  | "registrationMismatch"
  | "unsafePath"
  | "identityMismatch"
  | "evidenceMissing"
  | "symlinkDetected"
  | "ioFailure"
  | "retryExhausted"
  | "unknown";

export interface ArenaCleanupStepPayload {
  readonly payloadType: "cleanupStepRecorded";
  readonly cleanupId: string;
  readonly contestantId: string;
  readonly step: ArenaCleanupStep;
  readonly attempt: number;
  readonly outcome: ArenaCleanupOutcome;
  readonly failureCode: ArenaCleanupFailureCode | null;
  readonly retryDelayMs: number | null;
}

export interface ArenaCleanupStartPreconditions {
  readonly manifestValid: boolean;
  readonly runFinalized: boolean;
  readonly worktreeProvisioned: boolean;
  readonly evidencePreserved: boolean;
}

export type ArenaCleanupStartDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason:
        | "invalidManifest"
        | "runNotFinalized"
        | "worktreeNotProvisioned"
        | "evidenceNotPreserved";
    };

export interface ArenaCleanupTargetReplay {
  readonly contestantId: string;
  readonly cleanupId: string | null;
  readonly status: "notStarted" | "active" | "complete" | "blocked";
  readonly records: readonly ArenaCleanupStepPayload[];
  readonly completedSteps: readonly ArenaCleanupStep[];
  readonly nextStep: ArenaCleanupStep | null;
  readonly nextAttempt: number | null;
  readonly blockedFailureCode: ArenaCleanupFailureCode | null;
}

export class ArenaCleanupValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid Hydra Arena cleanup history: ${issues.join("; ")}`);
    this.name = "ArenaCleanupValidationError";
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CLEANUP_OUTCOMES = new Set<ArenaCleanupOutcome>([
  "succeeded",
  "notNeeded",
  "retryableFailure",
  "blocked",
]);
const CLEANUP_FAILURE_CODES = new Set<ArenaCleanupFailureCode>([
  "processStillRunning",
  "sharingViolation",
  "pathBusy",
  "directoryNotEmpty",
  "gitRejected",
  "registrationMismatch",
  "unsafePath",
  "identityMismatch",
  "evidenceMissing",
  "symlinkDetected",
  "ioFailure",
  "retryExhausted",
  "unknown",
]);
const RETRYABLE_FAILURE_CODES = new Set<ArenaCleanupFailureCode>([
  "processStillRunning",
  "sharingViolation",
  "pathBusy",
  "directoryNotEmpty",
]);
const MAX_ATTEMPTS_PER_STEP = ARENA_CLEANUP_RETRY_DELAYS_MS.length + 1;

export function evaluateArenaCleanupStart(
  input: ArenaCleanupStartPreconditions,
): ArenaCleanupStartDecision {
  if (!input.manifestValid) return { allowed: false, reason: "invalidManifest" };
  if (!input.runFinalized) return { allowed: false, reason: "runNotFinalized" };
  if (!input.worktreeProvisioned) {
    return { allowed: false, reason: "worktreeNotProvisioned" };
  }
  if (!input.evidencePreserved) return { allowed: false, reason: "evidenceNotPreserved" };
  return { allowed: true };
}

export function isArenaCleanupRetryableFailure(
  failureCode: ArenaCleanupFailureCode,
): boolean {
  return RETRYABLE_FAILURE_CODES.has(failureCode);
}

export function arenaCleanupRetryDelayMs(attempt: number): number | null {
  if (!Number.isSafeInteger(attempt) || attempt < 1) return null;
  return ARENA_CLEANUP_RETRY_DELAYS_MS[attempt - 1] ?? null;
}

export function parseArenaCleanupStepPayload(
  value: unknown,
  label = "cleanup",
): ArenaCleanupStepPayload {
  const row = exactRecord(value, [
    "payloadType",
    "cleanupId",
    "contestantId",
    "step",
    "attempt",
    "outcome",
    "failureCode",
    "retryDelayMs",
  ], label);
  if (row.payloadType !== "cleanupStepRecorded") {
    invalid(`${label}.payloadType`, "must equal cleanupStepRecorded");
  }
  const cleanupId = identifier(row.cleanupId, `${label}.cleanupId`);
  const contestantId = identifier(row.contestantId, `${label}.contestantId`);
  if (typeof row.step !== "string"
    || !ARENA_CLEANUP_STEPS.includes(row.step as ArenaCleanupStep)) {
    invalid(`${label}.step`, "must be a supported Arena cleanup step");
  }
  if (!Number.isSafeInteger(row.attempt)
    || (row.attempt as number) < 1
    || (row.attempt as number) > MAX_ATTEMPTS_PER_STEP) {
    invalid(
      `${label}.attempt`,
      `must be a safe integer from 1 through ${MAX_ATTEMPTS_PER_STEP}`,
    );
  }
  if (typeof row.outcome !== "string"
    || !CLEANUP_OUTCOMES.has(row.outcome as ArenaCleanupOutcome)) {
    invalid(`${label}.outcome`, "must be a supported Arena cleanup outcome");
  }
  if (row.failureCode !== null
    && (typeof row.failureCode !== "string"
      || !CLEANUP_FAILURE_CODES.has(row.failureCode as ArenaCleanupFailureCode))) {
    invalid(`${label}.failureCode`, "must be null or a supported cleanup failure code");
  }
  if (row.retryDelayMs !== null
    && (!Number.isSafeInteger(row.retryDelayMs) || (row.retryDelayMs as number) < 0)) {
    invalid(`${label}.retryDelayMs`, "must be null or a non-negative safe integer");
  }

  const attempt = row.attempt as number;
  const outcome = row.outcome as ArenaCleanupOutcome;
  const failureCode = row.failureCode as ArenaCleanupFailureCode | null;
  const retryDelayMs = row.retryDelayMs as number | null;
  if (outcome === "succeeded" || outcome === "notNeeded") {
    if (failureCode !== null || retryDelayMs !== null) {
      invalid(label, `${outcome} must not carry failure or retry metadata`);
    }
  } else if (outcome === "retryableFailure") {
    if (failureCode === null || !isArenaCleanupRetryableFailure(failureCode)) {
      invalid(
        `${label}.failureCode`,
        "retryableFailure requires an allowlisted transient failure code",
      );
    }
    const expectedDelay = arenaCleanupRetryDelayMs(attempt);
    if (expectedDelay === null) {
      invalid(label, "the retry schedule is exhausted; record blocked/retryExhausted");
    }
    if (retryDelayMs !== expectedDelay) {
      invalid(
        `${label}.retryDelayMs`,
        `attempt ${attempt} must use the fixed ${expectedDelay} ms retry delay`,
      );
    }
  } else {
    if (failureCode === null || retryDelayMs !== null) {
      invalid(label, "blocked requires one failure code and no automatic retry delay");
    }
    if (failureCode === "retryExhausted" && attempt !== MAX_ATTEMPTS_PER_STEP) {
      invalid(
        `${label}.failureCode`,
        `retryExhausted is valid only on attempt ${MAX_ATTEMPTS_PER_STEP}`,
      );
    }
    if (attempt < MAX_ATTEMPTS_PER_STEP
      && isArenaCleanupRetryableFailure(failureCode)) {
      invalid(
        `${label}.failureCode`,
        "an allowlisted transient failure must follow the bounded retry schedule",
      );
    }
    if (attempt === MAX_ATTEMPTS_PER_STEP
      && isArenaCleanupRetryableFailure(failureCode)) {
      invalid(
        `${label}.failureCode`,
        "a transient failure on the final bounded attempt must terminalize as retryExhausted",
      );
    }
  }

  return Object.freeze({
    payloadType: "cleanupStepRecorded",
    cleanupId,
    contestantId,
    step: row.step as ArenaCleanupStep,
    attempt,
    outcome,
    failureCode,
    retryDelayMs,
  });
}

export function replayArenaCleanupSteps(
  contestantId: string,
  values: readonly unknown[],
): ArenaCleanupTargetReplay {
  const expectedContestantId = identifier(contestantId, "contestantId");
  const records = values.map((value, index) =>
    parseArenaCleanupStepPayload(value, `cleanup[${index}]`));
  let cleanupId: string | null = null;
  let stepIndex = 0;
  let nextAttempt = 1;
  let blockedFailureCode: ArenaCleanupFailureCode | null = null;
  const completedSteps: ArenaCleanupStep[] = [];

  records.forEach((record, index) => {
    const label = `cleanup[${index}]`;
    if (record.contestantId !== expectedContestantId) {
      invalid(`${label}.contestantId`, "crosses cleanup target identities");
    }
    cleanupId ??= record.cleanupId;
    if (record.cleanupId !== cleanupId) {
      invalid(`${label}.cleanupId`, "crosses cleanup attempt identities");
    }
    if (blockedFailureCode !== null || stepIndex >= ARENA_CLEANUP_STEPS.length) {
      invalid(label, "appears after cleanup reached a terminal state");
    }
    const expectedStep = ARENA_CLEANUP_STEPS[stepIndex];
    if (record.step !== expectedStep) {
      invalid(`${label}.step`, `must be ${expectedStep}`);
    }
    if (record.attempt !== nextAttempt) {
      invalid(`${label}.attempt`, `must be ${nextAttempt}`);
    }

    if (record.outcome === "retryableFailure") {
      nextAttempt += 1;
      return;
    }
    if (record.outcome === "blocked") {
      blockedFailureCode = record.failureCode;
      return;
    }
    completedSteps.push(record.step);
    stepIndex += 1;
    nextAttempt = 1;
  });

  const complete = stepIndex === ARENA_CLEANUP_STEPS.length;
  const status: ArenaCleanupTargetReplay["status"] = records.length === 0
    ? "notStarted"
    : blockedFailureCode !== null
      ? "blocked"
      : complete
        ? "complete"
        : "active";
  return Object.freeze({
    contestantId: expectedContestantId,
    cleanupId,
    status,
    records: Object.freeze([...records]),
    completedSteps: Object.freeze([...completedSteps]),
    nextStep: complete || blockedFailureCode !== null
      ? null
      : ARENA_CLEANUP_STEPS[stepIndex] ?? null,
    nextAttempt: complete || blockedFailureCode !== null ? null : nextAttempt,
    blockedFailureCode,
  });
}

export function validateArenaCleanupSteps(
  contestantId: string,
  values: readonly unknown[],
): readonly string[] {
  try {
    replayArenaCleanupSteps(contestantId, values);
    return [];
  } catch (error) {
    if (error instanceof ArenaCleanupValidationError) return [...error.issues];
    return [error instanceof Error ? error.message : String(error)];
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(label, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(label, "must be a plain object");
  }
  const row = value as Record<string, unknown>;
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    const missing = expected.filter((key) => !actual.includes(key));
    const unknown = actual.filter((key) => !expected.includes(key));
    const details = [
      missing.length > 0 ? `missing ${missing.join(", ")}` : "",
      unknown.length > 0 ? `unknown ${unknown.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    invalid(label, `must contain exactly [${expected.join(", ")}]${details ? ` (${details})` : ""}`);
  }
  return row;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    invalid(label, `must match ${IDENTIFIER_PATTERN}`);
  }
  return value;
}

function invalid(label: string, message: string): never {
  throw new ArenaCleanupValidationError([`${label}: ${message}`]);
}
