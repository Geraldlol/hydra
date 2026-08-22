import { createHash } from "node:crypto";

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

export type ArenaCleanupPostcondition =
  | {
      readonly kind: "processQuiescence";
      readonly processOwnerSha256: string;
      readonly terminationConfirmed: true;
      readonly activeProcessCount: 0;
    }
  | {
      readonly kind: "ownedTarget";
      readonly worktreePathSha256: string;
      readonly directoryIdentitySha256: string;
      readonly gitRegistrationSha256: string;
    }
  | {
      readonly kind: "gitLockState";
      readonly worktreePathSha256: string;
      readonly gitRegistrationSha256: string;
      readonly locked: false;
      readonly registryEntrySha256: string;
    }
  | {
      readonly kind: "gitRemoval";
      readonly worktreePathSha256: string;
      readonly registryAbsent: true;
    }
  | {
      readonly kind: "gitRegistryAbsence";
      readonly worktreePathSha256: string;
      readonly registrySha256: string;
      readonly absent: true;
    }
  | {
      readonly kind: "pathAbsence";
      readonly worktreePathSha256: string;
      readonly absent: true;
    }
  | {
      readonly kind: "cleanupFailure";
      readonly failureCode: ArenaCleanupFailureCode;
      readonly observedStateSha256: string;
    };

export interface ArenaCleanupStepPayload {
  readonly payloadType: "cleanupStepRecorded";
  readonly runId: string;
  readonly cleanupId: string;
  readonly contestantId: string;
  readonly registrationSha256: string;
  readonly evidenceEventSha256: string;
  readonly step: ArenaCleanupStep;
  readonly attempt: number;
  readonly outcome: ArenaCleanupOutcome;
  readonly failureCode: ArenaCleanupFailureCode | null;
  readonly retryDelayMs: number | null;
  readonly postcondition: ArenaCleanupPostcondition;
  readonly postconditionSha256: string;
  readonly stepReceiptSha256: string;
}

export interface ArenaCleanupStartPreconditions {
  readonly manifestValid: boolean;
  readonly runFinalized: boolean;
  readonly worktreeRegistered: boolean;
  readonly evidencePreserved: boolean;
}

export type ArenaCleanupStartDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason:
        | "invalidManifest"
        | "runNotFinalized"
        | "worktreeNotRegistered"
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
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
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
  if (!input.worktreeRegistered) {
    return { allowed: false, reason: "worktreeNotRegistered" };
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
    "runId",
    "cleanupId",
    "contestantId",
    "registrationSha256",
    "evidenceEventSha256",
    "step",
    "attempt",
    "outcome",
    "failureCode",
    "retryDelayMs",
    "postcondition",
    "postconditionSha256",
    "stepReceiptSha256",
  ], label);
  if (row.payloadType !== "cleanupStepRecorded") {
    invalid(`${label}.payloadType`, "must equal cleanupStepRecorded");
  }
  const runId = identifier(row.runId, `${label}.runId`);
  const cleanupId = identifier(row.cleanupId, `${label}.cleanupId`);
  const contestantId = identifier(row.contestantId, `${label}.contestantId`);
  const registrationSha256 = sha256(
    row.registrationSha256,
    `${label}.registrationSha256`,
  );
  const evidenceEventSha256 = sha256(
    row.evidenceEventSha256,
    `${label}.evidenceEventSha256`,
  );
  const postconditionSha256 = sha256(
    row.postconditionSha256,
    `${label}.postconditionSha256`,
  );
  const stepReceiptSha256 = sha256(
    row.stepReceiptSha256,
    `${label}.stepReceiptSha256`,
  );
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
  const postcondition = parseCleanupPostcondition(
    row.postcondition,
    row.step as ArenaCleanupStep,
    outcome,
    failureCode,
    `${label}.postcondition`,
  );
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

  const payload: ArenaCleanupStepPayload = Object.freeze({
    payloadType: "cleanupStepRecorded",
    runId,
    cleanupId,
    contestantId,
    registrationSha256,
    evidenceEventSha256,
    step: row.step as ArenaCleanupStep,
    attempt,
    outcome,
    failureCode,
    retryDelayMs,
    postcondition,
    postconditionSha256,
    stepReceiptSha256,
  });
  if (arenaCleanupPostconditionSha256(payload.postcondition)
      !== payload.postconditionSha256) {
    invalid(
      `${label}.postconditionSha256`,
      "does not bind the typed cleanup postcondition",
    );
  }
  if (arenaCleanupStepReceiptSha256(payload)
      !== payload.stepReceiptSha256) {
    invalid(`${label}.stepReceiptSha256`, "does not bind the cleanup step receipt");
  }
  return payload;
}

export function replayArenaCleanupSteps(
  runId: string,
  contestantId: string,
  values: readonly unknown[],
): ArenaCleanupTargetReplay {
  const expectedRunId = identifier(runId, "runId");
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
    if (record.runId !== expectedRunId) {
      invalid(`${label}.runId`, "crosses Arena run identities");
    }
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
  runId: string,
  contestantId: string,
  values: readonly unknown[],
): readonly string[] {
  try {
    replayArenaCleanupSteps(runId, contestantId, values);
    return [];
  } catch (error) {
    if (error instanceof ArenaCleanupValidationError) return [...error.issues];
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function arenaCleanupStepReceiptSha256(
  payload: Omit<ArenaCleanupStepPayload, "stepReceiptSha256">
    | ArenaCleanupStepPayload,
): string {
  const {
    stepReceiptSha256: _ignored,
    ...bound
  } = payload as ArenaCleanupStepPayload;
  return createHash("sha256")
    .update("hydra.arena.cleanup-step-receipt.v1\u0000", "utf8")
    .update(canonicalJson(bound), "utf8")
    .digest("hex");
}

export function arenaCleanupPostconditionSha256(
  postcondition: ArenaCleanupPostcondition,
): string {
  return createHash("sha256")
    .update("hydra.arena.cleanup-postcondition.v1\u0000", "utf8")
    .update(canonicalJson(postcondition), "utf8")
    .digest("hex");
}

function parseCleanupPostcondition(
  value: unknown,
  step: ArenaCleanupStep,
  outcome: ArenaCleanupOutcome,
  failureCode: ArenaCleanupFailureCode | null,
  label: string,
): ArenaCleanupPostcondition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(label, "must be one typed cleanup postcondition");
  }
  const kind = (value as { kind?: unknown }).kind;
  if (outcome === "retryableFailure" || outcome === "blocked") {
    const row = exactRecord(value, [
      "kind",
      "failureCode",
      "observedStateSha256",
    ], label);
    if (row.kind !== "cleanupFailure"
      || row.failureCode !== failureCode) {
      invalid(label, "failure postcondition must bind the exact failure code");
    }
    return Object.freeze({
      kind: "cleanupFailure",
      failureCode: row.failureCode as ArenaCleanupFailureCode,
      observedStateSha256: sha256(
        row.observedStateSha256,
        `${label}.observedStateSha256`,
      ),
    });
  }
  if (step === "quiesceProcesses") {
    const row = exactRecord(value, [
      "kind",
      "processOwnerSha256",
      "terminationConfirmed",
      "activeProcessCount",
    ], label);
    if (row.kind !== "processQuiescence"
      || row.terminationConfirmed !== true
      || row.activeProcessCount !== 0) {
      invalid(label, "quiescence must prove confirmed zero active processes");
    }
    return Object.freeze({
      kind: "processQuiescence",
      processOwnerSha256: sha256(
        row.processOwnerSha256,
        `${label}.processOwnerSha256`,
      ),
      terminationConfirmed: true,
      activeProcessCount: 0,
    });
  }
  if (step === "verifyTarget") {
    const row = exactRecord(value, [
      "kind",
      "worktreePathSha256",
      "directoryIdentitySha256",
      "gitRegistrationSha256",
    ], label);
    if (row.kind !== "ownedTarget") {
      invalid(`${label}.kind`, "must equal ownedTarget");
    }
    return Object.freeze({
      kind: "ownedTarget",
      worktreePathSha256: sha256(
        row.worktreePathSha256,
        `${label}.worktreePathSha256`,
      ),
      directoryIdentitySha256: sha256(
        row.directoryIdentitySha256,
        `${label}.directoryIdentitySha256`,
      ),
      gitRegistrationSha256: sha256(
        row.gitRegistrationSha256,
        `${label}.gitRegistrationSha256`,
      ),
    });
  }
  if (step === "unlockGitWorktree") {
    const row = exactRecord(value, [
      "kind",
      "worktreePathSha256",
      "gitRegistrationSha256",
      "locked",
      "registryEntrySha256",
    ], label);
    if (row.kind !== "gitLockState" || row.locked !== false) {
      invalid(label, "unlock postcondition must prove the exact row is unlocked");
    }
    return Object.freeze({
      kind: "gitLockState",
      worktreePathSha256: sha256(
        row.worktreePathSha256,
        `${label}.worktreePathSha256`,
      ),
      gitRegistrationSha256: sha256(
        row.gitRegistrationSha256,
        `${label}.gitRegistrationSha256`,
      ),
      locked: false,
      registryEntrySha256: sha256(
        row.registryEntrySha256,
        `${label}.registryEntrySha256`,
      ),
    });
  }
  if (step === "removeGitWorktree") {
    const row = exactRecord(value, [
      "kind",
      "worktreePathSha256",
      "registryAbsent",
    ], label);
    if (row.kind !== "gitRemoval" || row.registryAbsent !== true) {
      invalid(label, "removal postcondition must prove registry absence");
    }
    return Object.freeze({
      kind: "gitRemoval",
      worktreePathSha256: sha256(
        row.worktreePathSha256,
        `${label}.worktreePathSha256`,
      ),
      registryAbsent: true,
    });
  }
  if (step === "verifyGitRegistrationGone") {
    const row = exactRecord(value, [
      "kind",
      "worktreePathSha256",
      "registrySha256",
      "absent",
    ], label);
    if (row.kind !== "gitRegistryAbsence" || row.absent !== true) {
      invalid(label, "registry probe must prove exact target absence");
    }
    return Object.freeze({
      kind: "gitRegistryAbsence",
      worktreePathSha256: sha256(
        row.worktreePathSha256,
        `${label}.worktreePathSha256`,
      ),
      registrySha256: sha256(
        row.registrySha256,
        `${label}.registrySha256`,
      ),
      absent: true,
    });
  }
  const row = exactRecord(value, [
    "kind",
    "worktreePathSha256",
    "absent",
  ], label);
  if (kind !== "pathAbsence" || row.absent !== true) {
    invalid(label, "residual-directory probe must prove exact path absence");
  }
  return Object.freeze({
    kind: "pathAbsence",
    worktreePathSha256: sha256(
      row.worktreePathSha256,
      `${label}.worktreePathSha256`,
    ),
    absent: true,
  });
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

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid(label, "must be one lowercase SHA-256 digest");
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null
    || typeof value === "string"
    || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error("Arena cleanup receipts require finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Arena cleanup receipts require plain JSON values.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Arena cleanup receipts require plain JSON values.");
  }
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => {
    const entry = row[key];
    if (entry === undefined) {
      throw new Error("Arena cleanup receipts reject undefined values.");
    }
    return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
  }).join(",")}}`;
}

function invalid(label: string, message: string): never {
  throw new ArenaCleanupValidationError([`${label}: ${message}`]);
}
