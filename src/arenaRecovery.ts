import { createHash } from "node:crypto";
import {
  canonicalArenaManifestJson,
  type ArenaManifestReplay,
} from "./arenaRunManifest";
import type { ArenaCleanupStep } from "./arenaCleanup";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const GENERATION_ROOT_HASH_DOMAIN = "hydra.arena.recovery.v1.generations\u0000";
const RECOVERY_STATE_HASH_DOMAIN = "hydra.arena.recovery.v1.state\u0000";
const RECOVERY_PROOF_HASH_DOMAIN = "hydra.arena.recovery.v1.proof\u0000";

export type ArenaRecoveryGenerationState =
  | "intentOnly"
  | "submitted"
  | "quiescent";

export interface ArenaRecoveryProcessGeneration {
  readonly contestantId: string;
  readonly processGenerationId: string;
  readonly processOwnerSha256: string;
  readonly intentSha256: string;
  readonly submissionReceiptSha256: string | null;
  readonly quiescenceReceiptSha256: string | null;
  readonly state: ArenaRecoveryGenerationState;
}

export type ArenaRecoveryClassification =
  | "noAction"
  | "resumeOrAbort"
  | "resumeCleanup"
  | "cleanupBlocked"
  | "deliveryUnknown"
  | "processQuiescenceUnconfirmed"
  | "receiptStateInvalid"
  | "promotionInterrupted";

export type ArenaRecoveryAction =
  | "resume"
  | "abort"
  | "resumeCleanup"
  | "inspect"
  | "inspectPromotion";

export interface ArenaRecoveryCleanupCursor {
  readonly contestantId: string;
  readonly step: ArenaCleanupStep;
  readonly attempt: number;
}

export interface ArenaRecoveryState {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly classification: ArenaRecoveryClassification;
  readonly manifestState: ArenaManifestReplay["state"];
  readonly manifestLockEventSha256: string;
  readonly manifestLatestEventSha256: string;
  readonly processGenerationRootSha256: string;
  readonly allSubmittedGenerationsQuiescent: boolean;
  readonly takeoverEligible: boolean;
  readonly allowedActions: readonly ArenaRecoveryAction[];
  readonly nextCleanup: readonly ArenaRecoveryCleanupCursor[];
  readonly interruptedPromotionIds: readonly string[];
  readonly supportStateErrorSha256: string | null;
  readonly recoveryStateSha256: string;
}

export interface ArenaRecoveryActionProof {
  readonly schemaVersion: 1;
  readonly proofType: "arenaRecoveryAction";
  readonly runId: string;
  readonly action: "resume" | "abort" | "resumeCleanup";
  readonly recoveryStateSha256: string;
  readonly manifestLockEventSha256: string;
  readonly manifestLatestEventSha256: string;
  readonly processGenerationRootSha256: string;
  readonly allSubmittedGenerationsQuiescent: true;
  readonly recoveryProofSha256: string;
}

export function classifyArenaRecovery(input: {
  readonly replay: ArenaManifestReplay;
  readonly generations: readonly ArenaRecoveryProcessGeneration[];
  readonly interruptedPromotionIds: readonly string[];
  readonly supportStateErrorSha256?: string | null;
}): ArenaRecoveryState {
  const lockEvent = input.replay.records[0];
  if (!lockEvent || lockEvent.type !== "arenaRunLocked") {
    throw new Error("Arena recovery requires one strictly replayed locked manifest.");
  }
  const generations = validateGenerations(input.generations);
  const interruptedPromotionIds = validateDistinctIdentifiers(
    input.interruptedPromotionIds,
    "interrupted promotion ID",
  );
  const supportStateErrorSha256 = input.supportStateErrorSha256 ?? null;
  if (supportStateErrorSha256 !== null) {
    assertSha256(supportStateErrorSha256, "recovery support-state error");
  }
  const intentOnly = generations.some((generation) =>
    generation.state === "intentOnly");
  const submittedWithoutQuiescence = generations.some((generation) =>
    generation.state === "submitted");
  const startedContestants = new Set(input.replay.contestants.flatMap((contestant) =>
    contestant.started ? [contestant.lock.contestantId] : []));
  const receiptedContestants = new Set(generations.map((generation) =>
    generation.contestantId));
  const receiptStateMissing = [...startedContestants].some((contestantId) =>
    !receiptedContestants.has(contestantId));
  const processGenerationRootSha256 = hashCanonical(
    GENERATION_ROOT_HASH_DOMAIN,
    generations,
  );
  const allSubmittedGenerationsQuiescent = supportStateErrorSha256 === null
    && !intentOnly
    && !submittedWithoutQuiescence
    && !receiptStateMissing;
  const nextCleanup = input.replay.contestants.flatMap((contestant) => {
    if (!contestant.cleanup.nextStep || contestant.cleanup.nextAttempt === null) {
      return [];
    }
    return [Object.freeze({
      contestantId: contestant.lock.contestantId,
      step: contestant.cleanup.nextStep,
      attempt: contestant.cleanup.nextAttempt,
    })];
  });

  let classification: ArenaRecoveryClassification;
  let allowedActions: readonly ArenaRecoveryAction[];
  let takeoverEligible = false;
  if (interruptedPromotionIds.length > 0) {
    classification = "promotionInterrupted";
    allowedActions = ["inspectPromotion"];
  } else if (supportStateErrorSha256 !== null) {
    classification = "receiptStateInvalid";
    allowedActions = ["inspect"];
  } else if (input.replay.state === "cleanupComplete") {
    classification = "noAction";
    allowedActions = [];
  } else if (input.replay.state === "cleanupBlocked") {
    classification = "cleanupBlocked";
    allowedActions = ["inspect"];
  } else if (receiptStateMissing) {
    classification = "receiptStateInvalid";
    allowedActions = ["inspect"];
  } else if (intentOnly) {
    classification = "deliveryUnknown";
    allowedActions = ["inspect"];
  } else if (submittedWithoutQuiescence) {
    classification = "processQuiescenceUnconfirmed";
    allowedActions = ["inspect"];
  } else if (input.replay.state === "finalized") {
    classification = "resumeCleanup";
    allowedActions = ["resumeCleanup"];
    takeoverEligible = true;
  } else {
    classification = "resumeOrAbort";
    allowedActions = ["resume", "abort"];
    takeoverEligible = true;
  }

  const withoutHash = {
    schemaVersion: 1 as const,
    runId: input.replay.runId,
    classification,
    manifestState: input.replay.state,
    manifestLockEventSha256: lockEvent.eventSha256,
    manifestLatestEventSha256: input.replay.latestEventSha256,
    processGenerationRootSha256,
    allSubmittedGenerationsQuiescent,
    takeoverEligible,
    allowedActions: Object.freeze([...allowedActions]),
    nextCleanup: Object.freeze(nextCleanup),
    interruptedPromotionIds: Object.freeze(interruptedPromotionIds),
    supportStateErrorSha256,
  };
  return Object.freeze({
    ...withoutHash,
    recoveryStateSha256: hashCanonical(RECOVERY_STATE_HASH_DOMAIN, withoutHash),
  });
}

export function requireArenaRecoveryAction(
  recovery: ArenaRecoveryState,
  expectedRecoveryStateSha256: string,
  action: ArenaRecoveryAction,
): ArenaRecoveryActionProof {
  assertRecoveryState(recovery);
  if (expectedRecoveryStateSha256 !== recovery.recoveryStateSha256) {
    throw new Error("Arena recovery state changed; refresh before choosing an action.");
  }
  if (!recovery.allowedActions.includes(action)
    || !recovery.takeoverEligible
    || !recovery.allSubmittedGenerationsQuiescent
    || (action !== "resume"
      && action !== "abort"
      && action !== "resumeCleanup")) {
    throw new Error("Arena recovery action is not authorized by the current state.");
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    proofType: "arenaRecoveryAction" as const,
    runId: recovery.runId,
    action,
    recoveryStateSha256: recovery.recoveryStateSha256,
    manifestLockEventSha256: recovery.manifestLockEventSha256,
    manifestLatestEventSha256: recovery.manifestLatestEventSha256,
    processGenerationRootSha256: recovery.processGenerationRootSha256,
    allSubmittedGenerationsQuiescent: true as const,
  };
  return Object.freeze({
    ...withoutHash,
    recoveryProofSha256: hashCanonical(RECOVERY_PROOF_HASH_DOMAIN, withoutHash),
  });
}

export function parseArenaRecoveryActionProof(
  value: unknown,
): ArenaRecoveryActionProof {
  if (!isPlainRecord(value)) {
    throw new Error("Arena recovery proof must be a plain object.");
  }
  const expectedKeys = [
    "schemaVersion",
    "proofType",
    "runId",
    "action",
    "recoveryStateSha256",
    "manifestLockEventSha256",
    "manifestLatestEventSha256",
    "processGenerationRootSha256",
    "allSubmittedGenerationsQuiescent",
    "recoveryProofSha256",
  ].sort();
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Arena recovery proof has an invalid exact schema.");
  }
  const actionValue = value.action;
  if (value.schemaVersion !== 1
    || value.proofType !== "arenaRecoveryAction"
    || typeof value.runId !== "string"
    || !IDENTIFIER_PATTERN.test(value.runId)
    || (actionValue !== "resume"
      && actionValue !== "abort"
      && actionValue !== "resumeCleanup")
    || value.allSubmittedGenerationsQuiescent !== true) {
    throw new Error("Arena recovery proof contains invalid authority fields.");
  }
  const action = actionValue as ArenaRecoveryActionProof["action"];
  const recoveryStateSha256 = proofSha256(
    value.recoveryStateSha256,
    "recovery state",
  );
  const manifestLockEventSha256 = proofSha256(
    value.manifestLockEventSha256,
    "manifest lock event",
  );
  const manifestLatestEventSha256 = proofSha256(
    value.manifestLatestEventSha256,
    "manifest latest event",
  );
  const processGenerationRootSha256 = proofSha256(
    value.processGenerationRootSha256,
    "process generation root",
  );
  const recoveryProofSha256 = proofSha256(
    value.recoveryProofSha256,
    "recovery proof",
  );
  const withoutHash = {
    schemaVersion: 1 as const,
    proofType: "arenaRecoveryAction" as const,
    runId: value.runId,
    action,
    recoveryStateSha256,
    manifestLockEventSha256,
    manifestLatestEventSha256,
    processGenerationRootSha256,
    allSubmittedGenerationsQuiescent: true as const,
  };
  if (hashCanonical(RECOVERY_PROOF_HASH_DOMAIN, withoutHash)
      !== recoveryProofSha256) {
    throw new Error("Arena recovery proof hash is invalid.");
  }
  return Object.freeze({ ...withoutHash, recoveryProofSha256 });
}

function validateGenerations(
  values: readonly ArenaRecoveryProcessGeneration[],
): readonly ArenaRecoveryProcessGeneration[] {
  const ids = new Set<string>();
  const result = values.map((value) => {
    assertIdentifier(value.contestantId, "recovery contestant ID");
    assertIdentifier(value.processGenerationId, "process generation ID");
    assertSha256(value.processOwnerSha256, "process owner");
    assertSha256(value.intentSha256, "process intent");
    const key = `${value.contestantId}\u0000${value.processGenerationId}`;
    if (ids.has(key)) throw new Error("Arena recovery duplicates a process generation.");
    ids.add(key);
    if (value.state === "intentOnly") {
      if (value.submissionReceiptSha256 !== null
        || value.quiescenceReceiptSha256 !== null) {
        throw new Error("Arena intent-only generation has later receipts.");
      }
    } else if (value.state === "submitted") {
      if (value.submissionReceiptSha256 === null
        || value.quiescenceReceiptSha256 !== null) {
        throw new Error("Arena submitted generation receipt state is invalid.");
      }
      assertSha256(value.submissionReceiptSha256, "process submission");
    } else if (value.state === "quiescent") {
      if (value.submissionReceiptSha256 === null
        || value.quiescenceReceiptSha256 === null) {
        throw new Error("Arena quiescent generation is missing a receipt.");
      }
      assertSha256(value.submissionReceiptSha256, "process submission");
      assertSha256(value.quiescenceReceiptSha256, "process quiescence");
    } else {
      throw new Error("Arena recovery process generation state is invalid.");
    }
    return Object.freeze({ ...value });
  });
  result.sort((left, right) => Buffer.compare(
    Buffer.from(`${left.contestantId}\u0000${left.processGenerationId}`, "utf8"),
    Buffer.from(`${right.contestantId}\u0000${right.processGenerationId}`, "utf8"),
  ));
  return Object.freeze(result);
}

function validateDistinctIdentifiers(
  values: readonly string[],
  label: string,
): readonly string[] {
  const result = values.map((value) => {
    assertIdentifier(value, label);
    return value;
  });
  if (new Set(result).size !== result.length) {
    throw new Error(`Arena ${label} list contains duplicates.`);
  }
  result.sort((left, right) => Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  ));
  return Object.freeze(result);
}

function assertRecoveryState(recovery: ArenaRecoveryState): void {
  assertSha256(recovery.recoveryStateSha256, "recovery state");
  const { recoveryStateSha256: _ignored, ...withoutHash } = recovery;
  if (hashCanonical(RECOVERY_STATE_HASH_DOMAIN, withoutHash)
      !== recovery.recoveryStateSha256) {
    throw new Error("Arena recovery state hash is invalid.");
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) throw new Error(`Arena ${label} is invalid.`);
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error(`Arena ${label} SHA-256 is invalid.`);
}

function proofSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`Arena ${label} SHA-256 is invalid.`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hashCanonical(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(canonicalArenaManifestJson(value), "utf8")
    .digest("hex");
}
