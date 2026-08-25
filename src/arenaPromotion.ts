import { createHash, randomUUID } from "node:crypto";
import {
  createArenaReveal,
  parseArenaProductReceipt,
  type ArenaReveal,
  type ArenaWinnerSelection,
} from "./arenaProduct";
import {
  canonicalArenaManifestJson,
  type ArenaEvidencePreservedPayload,
  type ArenaGitObjectId,
  type ArenaManifestReplay,
} from "./arenaRunManifest";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PREVIEW_HASH_DOMAIN = "hydra.arena.promotion.v1.preview\u0000";
const CONFIRMATION_HASH_DOMAIN = "hydra.arena.promotion.v1.confirmation\u0000";
const INTENT_HASH_DOMAIN = "hydra.arena.promotion.v1.intent\u0000";
const RESULT_HASH_DOMAIN = "hydra.arena.promotion.v1.result\u0000";
const WORKSPACE_HASH_DOMAIN = "hydra.arena.promotion.v1.workspace\u0000";
const PATCH_CHECK_HASH_DOMAIN = "hydra.arena.promotion.v1.patch-check\u0000";
const MAX_CONFLICT_PATHS = 256;

export type ArenaPromotionMissionDecision =
  | "keepActive"
  | "retireAfterVerifiedPromotion";

export type ArenaPromotionBlockingReason =
  | "runNotCleaned"
  | "comparisonNotEligible"
  | "sourceWorkspaceChanged"
  | "sourceContentChanged"
  | "sourceHeadChanged"
  | "repositoryControlsChanged"
  | "arenaRegistryNotClear"
  | "workspaceNotClean"
  | "patchConflict"
  | "untrackedConflict";

export interface ArenaPromotionWorkspaceSnapshot {
  readonly head: ArenaGitObjectId;
  readonly sourceWorkspaceFingerprintSha256: string;
  readonly contentFingerprintSha256: string;
  readonly repositoryControlSha256: string;
  readonly arenaWorktreesAbsent: boolean;
  readonly workspaceClean: boolean;
}

export interface ArenaPromotionPatchCheck {
  readonly applicable: boolean;
  readonly conflictPaths: readonly string[];
  readonly untrackedConflictPaths: readonly string[];
}

export interface ArenaPromotionPreview {
  readonly schemaVersion: 1;
  readonly previewType: "arenaPromotionPreview";
  readonly promotionId: string;
  readonly occurredAt: string;
  readonly runId: string;
  readonly revealSha256: string;
  readonly selectionSha256: string;
  readonly contestantId: string;
  readonly artifactSetSha256: string;
  readonly patchSha256: string;
  readonly patchBytes: number;
  readonly untrackedArchiveSha256: string | null;
  readonly untrackedArchiveBytes: number;
  readonly expectedFinalContentSha256: string;
  readonly workspaceSnapshotSha256: string;
  readonly patchCheckSha256: string;
  readonly missionDecision: ArenaPromotionMissionDecision;
  readonly blockingReasons: readonly ArenaPromotionBlockingReason[];
  readonly eligible: boolean;
  readonly effects: {
    readonly mutateSourceWorkspace: true;
    readonly createCommit: false;
    readonly push: false;
    readonly publish: false;
    readonly deploy: false;
    readonly deleteEvidence: false;
  };
  readonly previewSha256: string;
}

export interface ArenaPromotionConfirmation {
  readonly schemaVersion: 1;
  readonly confirmationType: "arenaPromotionConfirmation";
  readonly confirmationId: string;
  readonly occurredAt: string;
  readonly actorId: "local-user";
  readonly action: "Promote Arena Winner";
  readonly promotionId: string;
  readonly runId: string;
  readonly previewSha256: string;
  readonly confirmationSha256: string;
}

export interface ArenaPromotionIntentReceipt {
  readonly schemaVersion: 1;
  readonly receiptType: "arenaPromotionIntent";
  readonly promotionId: string;
  readonly occurredAt: string;
  readonly runId: string;
  readonly contestantId: string;
  readonly previewSha256: string;
  readonly confirmationSha256: string;
  readonly artifactSetSha256: string;
  readonly patchSha256: string;
  readonly workspaceBeforeSha256: string;
  readonly intentSha256: string;
}

export type ArenaPromotionFailureCode =
  | "applyFailed"
  | "postApplyInspectionFailed"
  | "finalContentMismatch"
  | "sourceHeadChanged"
  | "repositoryControlsChanged"
  | "arenaRegistryNotClear";

export interface ArenaPromotionResultReceipt {
  readonly schemaVersion: 1;
  readonly receiptType: "arenaPromotionResult";
  readonly promotionId: string;
  readonly occurredAt: string;
  readonly runId: string;
  readonly contestantId: string;
  readonly intentSha256: string;
  readonly outcome: "succeeded" | "failed";
  readonly failureCode: ArenaPromotionFailureCode | null;
  readonly workspaceAfterSha256: string | null;
  readonly resultSha256: string;
}

export interface ExecuteArenaPromotionInput {
  readonly preview: ArenaPromotionPreview;
  readonly confirmation: ArenaPromotionConfirmation;
  readonly loadReplay: () => Promise<ArenaManifestReplay>;
  readonly inspectWorkspace: () => Promise<ArenaPromotionWorkspaceSnapshot>;
  readonly verifyArtifactSet: (
    replay: ArenaManifestReplay,
    contestantId: string,
  ) => Promise<void>;
  readonly checkPatch: (
    replay: ArenaManifestReplay,
    contestantId: string,
  ) => Promise<ArenaPromotionPatchCheck>;
  readonly persistIntent: (receipt: ArenaPromotionIntentReceipt) => Promise<void>;
  readonly applyCandidate: (
    replay: ArenaManifestReplay,
    contestantId: string,
  ) => Promise<void>;
  readonly persistResult: (receipt: ArenaPromotionResultReceipt) => Promise<void>;
  readonly now?: () => Date;
}

export function createArenaPromotionPreview(input: {
  readonly replay: ArenaManifestReplay;
  readonly reveal: ArenaReveal;
  readonly selection: ArenaWinnerSelection;
  readonly promotionId: string;
  readonly occurredAt: string;
  readonly missionDecision: ArenaPromotionMissionDecision;
  readonly workspace: ArenaPromotionWorkspaceSnapshot;
  readonly patchCheck: ArenaPromotionPatchCheck;
}): ArenaPromotionPreview {
  assertIdentifier(input.promotionId, "promotion ID");
  assertIso(input.occurredAt, "promotion preview time");
  if (input.missionDecision !== "keepActive"
    && input.missionDecision !== "retireAfterVerifiedPromotion") {
    throw new Error("Arena promotion Mission decision is invalid.");
  }
  const currentReveal = createArenaReveal(input.replay);
  if (canonicalArenaManifestJson(currentReveal)
      !== canonicalArenaManifestJson(input.reveal)) {
    throw new Error("Arena promotion reveal is stale or does not match the run.");
  }
  const selection = parseArenaProductReceipt(input.selection);
  if (selection.receiptType !== "arenaWinnerSelection"
    || selection.runId !== input.replay.runId
    || selection.revealSha256 !== currentReveal.revealSha256) {
    throw new Error("Arena promotion winner selection is stale or run-mismatched.");
  }
  const contestant = input.replay.contestants.find((candidate) =>
    candidate.lock.contestantId === selection.contestantId);
  const evidence = contestant?.evidencePreserved?.payload as
    | ArenaEvidencePreservedPayload
    | undefined;
  if (!contestant || !evidence
    || evidence.artifactSetSha256 !== selection.artifactSetSha256) {
    throw new Error("Arena promotion selection does not bind retained evidence.");
  }
  const workspace = validateWorkspaceSnapshot(input.workspace);
  const patchCheck = validatePatchCheck(input.patchCheck);
  const blockingReasons: ArenaPromotionBlockingReason[] = [];
  if (input.replay.state !== "cleanupComplete") {
    blockingReasons.push("runNotCleaned");
  }
  if (!input.replay.promotionEligible) {
    blockingReasons.push("comparisonNotEligible");
  }
  if (workspace.sourceWorkspaceFingerprintSha256
      !== input.replay.lock.base.sourceWorkspaceFingerprintSha256) {
    blockingReasons.push("sourceWorkspaceChanged");
  }
  if (workspace.contentFingerprintSha256
      !== input.replay.lock.base.baseContentSha256) {
    blockingReasons.push("sourceContentChanged");
  }
  if (!sameGitObject(workspace.head, input.replay.lock.base.revision)) {
    blockingReasons.push("sourceHeadChanged");
  }
  if (workspace.repositoryControlSha256
      !== input.replay.lock.base.repositoryControlSha256) {
    blockingReasons.push("repositoryControlsChanged");
  }
  if (!workspace.arenaWorktreesAbsent) {
    blockingReasons.push("arenaRegistryNotClear");
  }
  if (!workspace.workspaceClean) {
    blockingReasons.push("workspaceNotClean");
  }
  if (!patchCheck.applicable || patchCheck.conflictPaths.length > 0) {
    blockingReasons.push("patchConflict");
  }
  if (patchCheck.untrackedConflictPaths.length > 0) {
    blockingReasons.push("untrackedConflict");
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    previewType: "arenaPromotionPreview" as const,
    promotionId: input.promotionId,
    occurredAt: input.occurredAt,
    runId: input.replay.runId,
    revealSha256: currentReveal.revealSha256,
    selectionSha256: selection.selectionSha256,
    contestantId: selection.contestantId,
    artifactSetSha256: evidence.artifactSetSha256,
    patchSha256: evidence.patchSha256,
    patchBytes: evidence.patchBytes,
    untrackedArchiveSha256: evidence.untrackedArchiveSha256,
    untrackedArchiveBytes: evidence.untrackedArchiveBytes,
    expectedFinalContentSha256: evidence.finalWorkspaceFingerprintSha256,
    workspaceSnapshotSha256: arenaPromotionWorkspaceSha256(workspace),
    patchCheckSha256: hashCanonical(PATCH_CHECK_HASH_DOMAIN, patchCheck),
    missionDecision: input.missionDecision,
    blockingReasons: Object.freeze(blockingReasons),
    eligible: blockingReasons.length === 0,
    effects: Object.freeze({
      mutateSourceWorkspace: true as const,
      createCommit: false as const,
      push: false as const,
      publish: false as const,
      deploy: false as const,
      deleteEvidence: false as const,
    }),
  };
  return Object.freeze({
    ...withoutHash,
    previewSha256: hashCanonical(PREVIEW_HASH_DOMAIN, withoutHash),
  });
}

export function createArenaPromotionConfirmation(input: {
  readonly preview: ArenaPromotionPreview;
  readonly confirmationId: string;
  readonly occurredAt: string;
}): ArenaPromotionConfirmation {
  assertPromotionPreview(input.preview);
  if (!input.preview.eligible) {
    throw new Error("Arena promotion preview is not eligible for confirmation.");
  }
  assertIdentifier(input.confirmationId, "promotion confirmation ID");
  assertIso(input.occurredAt, "promotion confirmation time");
  const withoutHash = {
    schemaVersion: 1 as const,
    confirmationType: "arenaPromotionConfirmation" as const,
    confirmationId: input.confirmationId,
    occurredAt: input.occurredAt,
    actorId: "local-user" as const,
    action: "Promote Arena Winner" as const,
    promotionId: input.preview.promotionId,
    runId: input.preview.runId,
    previewSha256: input.preview.previewSha256,
  };
  return Object.freeze({
    ...withoutHash,
    confirmationSha256: hashCanonical(CONFIRMATION_HASH_DOMAIN, withoutHash),
  });
}

export async function executeArenaPromotion(
  input: ExecuteArenaPromotionInput,
): Promise<ArenaPromotionResultReceipt> {
  assertPromotionPreview(input.preview);
  assertPromotionConfirmation(input.confirmation, input.preview);
  const replay = await input.loadReplay();
  const reveal = createArenaReveal(replay);
  if (reveal.revealSha256 !== input.preview.revealSha256
    || replay.runId !== input.preview.runId) {
    throw new Error("Arena promotion run changed after confirmation.");
  }
  const contestant = replay.contestants.find((candidate) =>
    candidate.lock.contestantId === input.preview.contestantId);
  const evidence = contestant?.evidencePreserved?.payload as
    | ArenaEvidencePreservedPayload
    | undefined;
  if (!contestant
    || !evidence
    || evidence.artifactSetSha256 !== input.preview.artifactSetSha256
    || evidence.patchSha256 !== input.preview.patchSha256) {
    throw new Error("Arena promotion evidence changed after confirmation.");
  }
  await input.verifyArtifactSet(replay, contestant.lock.contestantId);
  const firstWorkspace = validateWorkspaceSnapshot(await input.inspectWorkspace());
  const patchCheck = validatePatchCheck(
    await input.checkPatch(replay, contestant.lock.contestantId),
  );
  const secondWorkspace = validateWorkspaceSnapshot(await input.inspectWorkspace());
  if (arenaPromotionWorkspaceSha256(firstWorkspace)
      !== input.preview.workspaceSnapshotSha256
    || arenaPromotionWorkspaceSha256(secondWorkspace)
      !== input.preview.workspaceSnapshotSha256
    || hashCanonical(PATCH_CHECK_HASH_DOMAIN, patchCheck)
      !== input.preview.patchCheckSha256) {
    throw new Error("Arena source workspace changed after the promotion preview.");
  }

  const now = input.now ?? (() => new Date());
  const intent = createPromotionIntent(
    input.preview,
    input.confirmation,
    secondWorkspace,
    now().toISOString(),
  );
  await input.persistIntent(intent);
  let after: ArenaPromotionWorkspaceSnapshot | undefined;
  let failureCode: ArenaPromotionFailureCode | null = null;
  try {
    await input.applyCandidate(replay, contestant.lock.contestantId);
    try {
      after = validateWorkspaceSnapshot(await input.inspectWorkspace());
    } catch {
      failureCode = "postApplyInspectionFailed";
    }
    if (after) {
      if (!sameGitObject(after.head, replay.lock.base.revision)) {
        failureCode = "sourceHeadChanged";
      } else if (after.repositoryControlSha256
          !== replay.lock.base.repositoryControlSha256) {
        failureCode = "repositoryControlsChanged";
      } else if (!after.arenaWorktreesAbsent) {
        failureCode = "arenaRegistryNotClear";
      } else if (after.contentFingerprintSha256
          !== input.preview.expectedFinalContentSha256) {
        failureCode = "finalContentMismatch";
      }
    }
  } catch {
    failureCode = "applyFailed";
  }
  const result = createPromotionResult(
    intent,
    after,
    failureCode,
    now().toISOString(),
  );
  await input.persistResult(result);
  return result;
}

export function arenaPromotionWorkspaceSha256(
  input: ArenaPromotionWorkspaceSnapshot,
): string {
  return hashCanonical(WORKSPACE_HASH_DOMAIN, validateWorkspaceSnapshot(input));
}

export function parseArenaPromotionIntentReceipt(
  value: unknown,
): ArenaPromotionIntentReceipt {
  const row = exactRecord(value, "Arena promotion intent");
  assertExactKeys(row, [
    "artifactSetSha256",
    "confirmationSha256",
    "contestantId",
    "intentSha256",
    "occurredAt",
    "patchSha256",
    "previewSha256",
    "promotionId",
    "receiptType",
    "runId",
    "schemaVersion",
    "workspaceBeforeSha256",
  ], "Arena promotion intent");
  if (row.schemaVersion !== 1 || row.receiptType !== "arenaPromotionIntent") {
    throw new Error("Arena promotion intent type is invalid.");
  }
  const parsed: ArenaPromotionIntentReceipt = Object.freeze({
    schemaVersion: 1,
    receiptType: "arenaPromotionIntent",
    promotionId: requiredIdentifier(row.promotionId, "promotion intent ID"),
    occurredAt: requiredIso(row.occurredAt, "promotion intent time"),
    runId: requiredIdentifier(row.runId, "promotion intent run ID"),
    contestantId: requiredIdentifier(
      row.contestantId,
      "promotion intent contestant ID",
    ),
    previewSha256: requiredSha256(row.previewSha256, "promotion intent preview"),
    confirmationSha256: requiredSha256(
      row.confirmationSha256,
      "promotion intent confirmation",
    ),
    artifactSetSha256: requiredSha256(
      row.artifactSetSha256,
      "promotion intent artifacts",
    ),
    patchSha256: requiredSha256(row.patchSha256, "promotion intent patch"),
    workspaceBeforeSha256: requiredSha256(
      row.workspaceBeforeSha256,
      "promotion intent workspace",
    ),
    intentSha256: requiredSha256(row.intentSha256, "promotion intent"),
  });
  const { intentSha256: _ignored, ...withoutHash } = parsed;
  if (hashCanonical(INTENT_HASH_DOMAIN, withoutHash) !== parsed.intentSha256) {
    throw new Error("Arena promotion intent hash is invalid.");
  }
  return parsed;
}

export function parseArenaPromotionResultReceipt(
  value: unknown,
): ArenaPromotionResultReceipt {
  const row = exactRecord(value, "Arena promotion result");
  assertExactKeys(row, [
    "contestantId",
    "failureCode",
    "intentSha256",
    "occurredAt",
    "outcome",
    "promotionId",
    "receiptType",
    "resultSha256",
    "runId",
    "schemaVersion",
    "workspaceAfterSha256",
  ], "Arena promotion result");
  if (row.schemaVersion !== 1
    || row.receiptType !== "arenaPromotionResult"
    || (row.outcome !== "succeeded" && row.outcome !== "failed")
    || (row.outcome === "succeeded"
      ? row.failureCode !== null || typeof row.workspaceAfterSha256 !== "string"
      : !isArenaPromotionFailureCode(row.failureCode))) {
    throw new Error("Arena promotion result type or outcome is invalid.");
  }
  const failureCode: ArenaPromotionFailureCode | null = row.failureCode === null
    ? null
    : row.failureCode as ArenaPromotionFailureCode;
  const parsed: ArenaPromotionResultReceipt = Object.freeze({
    schemaVersion: 1,
    receiptType: "arenaPromotionResult",
    promotionId: requiredIdentifier(row.promotionId, "promotion result ID"),
    occurredAt: requiredIso(row.occurredAt, "promotion result time"),
    runId: requiredIdentifier(row.runId, "promotion result run ID"),
    contestantId: requiredIdentifier(
      row.contestantId,
      "promotion result contestant ID",
    ),
    intentSha256: requiredSha256(row.intentSha256, "promotion result intent"),
    outcome: row.outcome,
    failureCode,
    workspaceAfterSha256: row.workspaceAfterSha256 === null
      ? null
      : requiredSha256(row.workspaceAfterSha256, "promotion result workspace"),
    resultSha256: requiredSha256(row.resultSha256, "promotion result"),
  });
  const { resultSha256: _ignored, ...withoutHash } = parsed;
  if (hashCanonical(RESULT_HASH_DOMAIN, withoutHash) !== parsed.resultSha256) {
    throw new Error("Arena promotion result hash is invalid.");
  }
  return parsed;
}

function createPromotionIntent(
  preview: ArenaPromotionPreview,
  confirmation: ArenaPromotionConfirmation,
  workspace: ArenaPromotionWorkspaceSnapshot,
  occurredAt: string,
): ArenaPromotionIntentReceipt {
  assertIso(occurredAt, "promotion intent time");
  const withoutHash = {
    schemaVersion: 1 as const,
    receiptType: "arenaPromotionIntent" as const,
    promotionId: preview.promotionId,
    occurredAt,
    runId: preview.runId,
    contestantId: preview.contestantId,
    previewSha256: preview.previewSha256,
    confirmationSha256: confirmation.confirmationSha256,
    artifactSetSha256: preview.artifactSetSha256,
    patchSha256: preview.patchSha256,
    workspaceBeforeSha256: arenaPromotionWorkspaceSha256(workspace),
  };
  return Object.freeze({
    ...withoutHash,
    intentSha256: hashCanonical(INTENT_HASH_DOMAIN, withoutHash),
  });
}

function createPromotionResult(
  intent: ArenaPromotionIntentReceipt,
  workspace: ArenaPromotionWorkspaceSnapshot | undefined,
  failureCode: ArenaPromotionFailureCode | null,
  occurredAt: string,
): ArenaPromotionResultReceipt {
  assertIso(occurredAt, "promotion result time");
  const withoutHash = {
    schemaVersion: 1 as const,
    receiptType: "arenaPromotionResult" as const,
    promotionId: intent.promotionId,
    occurredAt,
    runId: intent.runId,
    contestantId: intent.contestantId,
    intentSha256: intent.intentSha256,
    outcome: failureCode === null ? "succeeded" as const : "failed" as const,
    failureCode,
    workspaceAfterSha256: workspace
      ? arenaPromotionWorkspaceSha256(workspace)
      : null,
  };
  return Object.freeze({
    ...withoutHash,
    resultSha256: hashCanonical(RESULT_HASH_DOMAIN, withoutHash),
  });
}

function assertPromotionPreview(preview: ArenaPromotionPreview): void {
  assertSha256(preview.previewSha256, "promotion preview");
  const { previewSha256: _ignored, ...withoutHash } = preview;
  if (hashCanonical(PREVIEW_HASH_DOMAIN, withoutHash)
      !== preview.previewSha256) {
    throw new Error("Arena promotion preview hash is invalid.");
  }
}

function assertPromotionConfirmation(
  confirmation: ArenaPromotionConfirmation,
  preview: ArenaPromotionPreview,
): void {
  const { confirmationSha256: _ignored, ...withoutHash } = confirmation;
  if (confirmation.schemaVersion !== 1
    || confirmation.confirmationType !== "arenaPromotionConfirmation"
    || confirmation.actorId !== "local-user"
    || confirmation.action !== "Promote Arena Winner"
    || confirmation.promotionId !== preview.promotionId
    || confirmation.runId !== preview.runId
    || confirmation.previewSha256 !== preview.previewSha256
    || !SHA256_PATTERN.test(confirmation.confirmationSha256)
    || hashCanonical(CONFIRMATION_HASH_DOMAIN, withoutHash)
      !== confirmation.confirmationSha256) {
    throw new Error("Arena promotion confirmation is stale or invalid.");
  }
}

function validateWorkspaceSnapshot(
  input: ArenaPromotionWorkspaceSnapshot,
): ArenaPromotionWorkspaceSnapshot {
  assertGitObject(input.head, "promotion source HEAD");
  assertSha256(input.sourceWorkspaceFingerprintSha256, "promotion source workspace");
  assertSha256(input.contentFingerprintSha256, "promotion source content");
  assertSha256(input.repositoryControlSha256, "promotion repository controls");
  if (typeof input.arenaWorktreesAbsent !== "boolean"
    || typeof input.workspaceClean !== "boolean") {
    throw new Error("Arena promotion workspace state flags are invalid.");
  }
  return Object.freeze({
    head: Object.freeze({ ...input.head }),
    sourceWorkspaceFingerprintSha256: input.sourceWorkspaceFingerprintSha256,
    contentFingerprintSha256: input.contentFingerprintSha256,
    repositoryControlSha256: input.repositoryControlSha256,
    arenaWorktreesAbsent: input.arenaWorktreesAbsent,
    workspaceClean: input.workspaceClean,
  });
}

function validatePatchCheck(input: ArenaPromotionPatchCheck): ArenaPromotionPatchCheck {
  if (typeof input.applicable !== "boolean"
    || !Array.isArray(input.conflictPaths)
    || !Array.isArray(input.untrackedConflictPaths)
    || input.conflictPaths.length > MAX_CONFLICT_PATHS
    || input.untrackedConflictPaths.length > MAX_CONFLICT_PATHS) {
    throw new Error("Arena promotion patch check is invalid or oversized.");
  }
  const conflicts = input.conflictPaths.map((value) => safeRelativePath(value));
  const untracked = input.untrackedConflictPaths.map((value) => safeRelativePath(value));
  if (new Set(conflicts).size !== conflicts.length
    || new Set(untracked).size !== untracked.length) {
    throw new Error("Arena promotion patch check contains duplicate paths.");
  }
  return Object.freeze({
    applicable: input.applicable,
    conflictPaths: Object.freeze(conflicts),
    untrackedConflictPaths: Object.freeze(untracked),
  });
}

function safeRelativePath(value: string): string {
  if (typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > 4_096
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || value.split(/[\\/]/u).some((segment) =>
      segment.length === 0 || segment === "." || segment === "..")
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Arena promotion conflict path is unsafe.");
  }
  return value.replace(/\\/gu, "/");
}

function sameGitObject(left: ArenaGitObjectId, right: ArenaGitObjectId): boolean {
  return left.objectFormat === right.objectFormat && left.oid === right.oid;
}

function assertGitObject(value: ArenaGitObjectId, label: string): void {
  const length = value.objectFormat === "sha1"
    ? 40
    : value.objectFormat === "sha256"
      ? 64
      : 0;
  if (length === 0 || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value.oid)) {
    throw new Error(`Arena ${label} is invalid.`);
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) throw new Error(`Arena ${label} is invalid.`);
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error(`Arena ${label} SHA-256 is invalid.`);
}

function assertIso(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`Arena ${label} is invalid.`);
  }
}

function hashCanonical(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(canonicalArenaManifestJson(value), "utf8")
    .digest("hex");
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  row: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(row).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} has unknown or missing fields.`);
  }
}

function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Arena ${label} is invalid.`);
  assertIdentifier(value, label);
  return value;
}

function requiredSha256(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Arena ${label} SHA-256 is invalid.`);
  assertSha256(value, label);
  return value;
}

function requiredIso(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Arena ${label} is invalid.`);
  assertIso(value, label);
  return value;
}

function isArenaPromotionFailureCode(
  value: unknown,
): value is ArenaPromotionFailureCode {
  return value === "applyFailed"
    || value === "postApplyInspectionFailed"
    || value === "finalContentMismatch"
    || value === "sourceHeadChanged"
    || value === "repositoryControlsChanged"
    || value === "arenaRegistryNotClear";
}

export function newArenaPromotionId(): string {
  return `promotion-${randomUUID()}`;
}
