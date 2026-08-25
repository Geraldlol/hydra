import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import {
  canonicalArenaManifestJson,
  type ArenaBrowserJourneyLock,
  type ArenaBrowserJourneyRecordedPayload,
  type ArenaGitObjectId,
  type ArenaManifestReplay,
  type ArenaRunLockedPayload,
  type ArenaVerificationCheckLock,
  type ArenaVerificationRecordedPayload,
} from "./arenaRunManifest";
import {
  createArenaPrivateFile,
  ensureArenaPrivateDirectory,
  prepareArenaPrivateStorage,
  readArenaPrivateFile,
  serializeArenaPrivateWork,
} from "./arenaPrivateStorage";

export const ARENA_ACCEPTANCE_SCHEMA_VERSION = 1 as const;
export const ARENA_ACCEPTANCE_LIMITS = Object.freeze({
  maxReceiptBytes: 64 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  maxDurationMs: 24 * 60 * 60 * 1_000,
  maxActions: 10_000,
  maxScreenshots: 1_000,
});

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERIFICATION_PLAN_HASH_DOMAIN =
  "hydra.arena.acceptance.v1.verification-plan\u0000";
const BROWSER_PLAN_HASH_DOMAIN =
  "hydra.arena.acceptance.v1.browser-plan\u0000";
const VERIFICATION_RECEIPT_HASH_DOMAIN =
  "hydra.arena.acceptance.v1.verification-receipt\u0000";
const BROWSER_RECEIPT_HASH_DOMAIN =
  "hydra.arena.acceptance.v1.browser-receipt\u0000";

export interface ArenaAcceptanceWorkspaceState {
  readonly head: ArenaGitObjectId;
  readonly workspaceFingerprintSha256: string;
}

export interface ArenaAcceptanceOutputMetadata {
  readonly bytes: number;
  readonly sha256: string;
}

export interface ArenaVerificationExecutionPlanInput {
  readonly checkId: string;
  readonly command: string;
  readonly controlSha256: string;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
}

export interface ArenaVerificationExecutionPlan
  extends ArenaVerificationExecutionPlanInput {
  readonly planSha256: string;
}

export interface ArenaBrowserJourneyExecutionPlanInput {
  readonly journeyId: string;
  readonly journeyDefinitionSha256: string;
  readonly timeoutMs: number;
}

export interface ArenaBrowserJourneyExecutionPlan
  extends ArenaBrowserJourneyExecutionPlanInput {
  readonly planSha256: string;
}

export interface ArenaVerificationExecutorInput {
  readonly worktreePath: string;
  readonly command: string;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  readonly signal: AbortSignal;
}

export interface ArenaVerificationExecutorResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
  readonly stdout: ArenaAcceptanceOutputMetadata;
  readonly stderr: ArenaAcceptanceOutputMetadata;
  readonly terminationConfirmed: boolean;
  readonly quiescenceReceiptSha256: string | null;
}

export interface ArenaBrowserJourneyExecutorInput {
  readonly runId: string;
  readonly contestantId: string;
  readonly journeyId: string;
  readonly journeyDefinitionSha256: string;
  readonly worktreePath: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface ArenaBrowserJourneyExecutorResult {
  readonly status: ArenaBrowserJourneyRecordedPayload["status"];
  readonly durationMs: number;
  readonly actionCount: number;
  readonly screenshotCount: number;
  readonly executionStarted: boolean;
  readonly brokerReceiptSha256: string;
  readonly quiescenceReceiptSha256: string | null;
}

interface ArenaAcceptanceAttemptBase<P, L> {
  readonly privateWorkspaceRoot: string;
  readonly runId: string;
  readonly contestantId: string;
  readonly worktreePath: string;
  readonly plan: P;
  readonly locked: L;
  readonly attempt: number;
  readonly expectedState: ArenaAcceptanceWorkspaceState;
  readonly signal: AbortSignal;
  readonly captureState: () => Promise<ArenaAcceptanceWorkspaceState>;
}

export interface RunArenaVerificationAttemptInput
  extends ArenaAcceptanceAttemptBase<
    ArenaVerificationExecutionPlan,
    ArenaVerificationCheckLock
  > {
  readonly execute: (
    input: ArenaVerificationExecutorInput,
  ) => Promise<ArenaVerificationExecutorResult>;
}

export interface RunArenaBrowserJourneyAttemptInput
  extends ArenaAcceptanceAttemptBase<
    ArenaBrowserJourneyExecutionPlan,
    ArenaBrowserJourneyLock
  > {
  readonly execute: (
    input: ArenaBrowserJourneyExecutorInput,
  ) => Promise<ArenaBrowserJourneyExecutorResult>;
}

export interface ArenaVerificationAttemptReceipt {
  readonly schemaVersion: typeof ARENA_ACCEPTANCE_SCHEMA_VERSION;
  readonly receiptType: "arenaVerificationAttempt";
  readonly runId: string;
  readonly contestantId: string;
  readonly checkId: string;
  readonly attempt: number;
  readonly planSha256: string;
  readonly commandSha256: string;
  readonly initialState: ArenaAcceptanceWorkspaceState;
  readonly finalState: ArenaAcceptanceWorkspaceState;
  readonly status: ArenaVerificationRecordedPayload["status"];
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly terminationConfirmed: boolean;
  readonly quiescenceReceiptSha256: string | null;
  readonly stdout: ArenaAcceptanceOutputMetadata;
  readonly stderr: ArenaAcceptanceOutputMetadata;
  readonly receiptSha256: string;
}

export interface ArenaBrowserJourneyAttemptReceipt {
  readonly schemaVersion: typeof ARENA_ACCEPTANCE_SCHEMA_VERSION;
  readonly receiptType: "arenaBrowserJourneyAttempt";
  readonly runId: string;
  readonly contestantId: string;
  readonly journeyId: string;
  readonly attempt: number;
  readonly planSha256: string;
  readonly journeyDefinitionSha256: string;
  readonly initialState: ArenaAcceptanceWorkspaceState;
  readonly finalState: ArenaAcceptanceWorkspaceState;
  readonly status: ArenaBrowserJourneyRecordedPayload["status"];
  readonly durationMs: number;
  readonly actionCount: number;
  readonly screenshotCount: number;
  readonly executionStarted: boolean;
  readonly brokerReceiptSha256: string;
  readonly quiescenceReceiptSha256: string | null;
  readonly receiptSha256: string;
}

export type ArenaAcceptanceReceipt =
  | ArenaVerificationAttemptReceipt
  | ArenaBrowserJourneyAttemptReceipt;

export function createArenaVerificationExecutionPlan(
  input: ArenaVerificationExecutionPlanInput,
): ArenaVerificationExecutionPlan {
  validateVerificationPlanInput(input);
  return Object.freeze({
    ...input,
    planSha256: hashCanonical(VERIFICATION_PLAN_HASH_DOMAIN, input),
  });
}

export function createArenaBrowserJourneyExecutionPlan(
  input: ArenaBrowserJourneyExecutionPlanInput,
): ArenaBrowserJourneyExecutionPlan {
  validateBrowserPlanInput(input);
  return Object.freeze({
    ...input,
    planSha256: hashCanonical(BROWSER_PLAN_HASH_DOMAIN, input),
  });
}

export function assertArenaAcceptancePlanSet(
  lock: ArenaRunLockedPayload,
  verificationPlans: readonly ArenaVerificationExecutionPlan[],
  browserPlans: readonly ArenaBrowserJourneyExecutionPlan[],
): void {
  if (verificationPlans.length !== lock.verificationChecks.length
    || browserPlans.length !== lock.browserJourneys.length) {
    throw new Error(
      "Arena acceptance executors must provide every locked verification and browser plan exactly once.",
    );
  }
  verificationPlans.forEach((plan, index) => {
    const locked = lock.verificationChecks[index];
    if (!locked) throw new Error("Arena locked verification plan disappeared.");
    assertVerificationPlan(plan, locked);
  });
  browserPlans.forEach((plan, index) => {
    const locked = lock.browserJourneys[index];
    if (!locked) throw new Error("Arena locked browser plan disappeared.");
    assertBrowserPlan(plan, locked);
  });
}

export async function runArenaVerificationAttempt(
  input: RunArenaVerificationAttemptInput,
): Promise<{
  readonly payload: ArenaVerificationRecordedPayload;
  readonly receipt: ArenaVerificationAttemptReceipt;
  readonly receiptPath: string;
}> {
  validateAttemptBase(input);
  assertVerificationPlan(input.plan, input.locked);
  const worktreeIdentity = await captureExactWorktree(input.worktreePath);
  const initialState = validateWorkspaceState(await input.captureState());
  assertSameWorkspaceState(initialState, input.expectedState, "before verification");
  const execution = validateVerificationResult(await input.execute({
    worktreePath: input.worktreePath,
    command: input.plan.command,
    timeoutMs: input.plan.timeoutMs,
    maxOutputChars: input.plan.maxOutputChars,
    signal: input.signal,
  }));
  await assertExactWorktreeIdentity(input.worktreePath, worktreeIdentity);
  const finalState = validateWorkspaceState(await input.captureState());
  const status = verificationStatus(execution);
  const withoutHash = {
    schemaVersion: ARENA_ACCEPTANCE_SCHEMA_VERSION,
    receiptType: "arenaVerificationAttempt" as const,
    runId: input.runId,
    contestantId: input.contestantId,
    checkId: input.plan.checkId,
    attempt: input.attempt,
    planSha256: input.plan.planSha256,
    commandSha256: sha256Utf8(input.plan.command),
    initialState,
    finalState,
    status,
    durationMs: execution.durationMs,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    cancelled: execution.cancelled,
    terminationConfirmed: execution.terminationConfirmed,
    quiescenceReceiptSha256: execution.quiescenceReceiptSha256,
    stdout: execution.stdout,
    stderr: execution.stderr,
  };
  const receipt: ArenaVerificationAttemptReceipt = Object.freeze({
    ...withoutHash,
    receiptSha256: hashCanonical(
      VERIFICATION_RECEIPT_HASH_DOMAIN,
      withoutHash,
    ),
  });
  const receiptPath = await persistAcceptanceReceipt(receipt, input.privateWorkspaceRoot);
  return Object.freeze({
    payload: Object.freeze({
      payloadType: "verificationRecorded",
      contestantId: input.contestantId,
      checkId: input.plan.checkId,
      attempt: input.attempt,
      planSha256: input.plan.planSha256,
      status,
      receiptSha256: receipt.receiptSha256,
      head: finalState.head,
      workspaceFingerprintSha256: finalState.workspaceFingerprintSha256,
    }),
    receipt,
    receiptPath,
  });
}

export async function runArenaBrowserJourneyAttempt(
  input: RunArenaBrowserJourneyAttemptInput,
): Promise<{
  readonly payload: ArenaBrowserJourneyRecordedPayload;
  readonly receipt: ArenaBrowserJourneyAttemptReceipt;
  readonly receiptPath: string;
}> {
  validateAttemptBase(input);
  assertBrowserPlan(input.plan, input.locked);
  const worktreeIdentity = await captureExactWorktree(input.worktreePath);
  const initialState = validateWorkspaceState(await input.captureState());
  assertSameWorkspaceState(initialState, input.expectedState, "before browser journey");
  const execution = validateBrowserResult(await input.execute({
    runId: input.runId,
    contestantId: input.contestantId,
    journeyId: input.plan.journeyId,
    journeyDefinitionSha256: input.plan.journeyDefinitionSha256,
    worktreePath: input.worktreePath,
    timeoutMs: input.plan.timeoutMs,
    signal: input.signal,
  }));
  await assertExactWorktreeIdentity(input.worktreePath, worktreeIdentity);
  const finalState = validateWorkspaceState(await input.captureState());
  const withoutHash = {
    schemaVersion: ARENA_ACCEPTANCE_SCHEMA_VERSION,
    receiptType: "arenaBrowserJourneyAttempt" as const,
    runId: input.runId,
    contestantId: input.contestantId,
    journeyId: input.plan.journeyId,
    attempt: input.attempt,
    planSha256: input.plan.planSha256,
    journeyDefinitionSha256: input.plan.journeyDefinitionSha256,
    initialState,
    finalState,
    status: execution.status,
    durationMs: execution.durationMs,
    actionCount: execution.actionCount,
    screenshotCount: execution.screenshotCount,
    executionStarted: execution.executionStarted,
    brokerReceiptSha256: execution.brokerReceiptSha256,
    quiescenceReceiptSha256: execution.quiescenceReceiptSha256,
  };
  const receipt: ArenaBrowserJourneyAttemptReceipt = Object.freeze({
    ...withoutHash,
    receiptSha256: hashCanonical(BROWSER_RECEIPT_HASH_DOMAIN, withoutHash),
  });
  const receiptPath = await persistAcceptanceReceipt(receipt, input.privateWorkspaceRoot);
  return Object.freeze({
    payload: Object.freeze({
      payloadType: "browserJourneyRecorded",
      contestantId: input.contestantId,
      journeyId: input.plan.journeyId,
      attempt: input.attempt,
      planSha256: input.plan.planSha256,
      status: execution.status,
      receiptSha256: receipt.receiptSha256,
      head: finalState.head,
      workspaceFingerprintSha256: finalState.workspaceFingerprintSha256,
    }),
    receipt,
    receiptPath,
  });
}

export async function verifyArenaAcceptanceReceipt(input: {
  readonly privateWorkspaceRoot: string;
  readonly runId: string;
  readonly event:
    | ArenaVerificationRecordedPayload
    | ArenaBrowserJourneyRecordedPayload;
}): Promise<void> {
  assertIdentifier(input.runId, "runId");
  const receiptPath = acceptanceReceiptPath(
    input.privateWorkspaceRoot,
    input.runId,
    input.event,
  );
  const boundary = await prepareArenaPrivateStorage(input.privateWorkspaceRoot);
  const bytes = await readArenaPrivateFile(
    receiptPath,
    ARENA_ACCEPTANCE_LIMITS.maxReceiptBytes,
    boundary,
  );
  const receipt = parseAcceptanceReceipt(bytes);
  if (receipt.runId !== input.runId
    || receipt.contestantId !== input.event.contestantId
    || receipt.attempt !== input.event.attempt
    || receipt.planSha256 !== input.event.planSha256
    || receipt.status !== input.event.status
    || receipt.receiptSha256 !== input.event.receiptSha256
    || !sameGitObject(receipt.finalState.head, input.event.head)
    || receipt.finalState.workspaceFingerprintSha256
      !== input.event.workspaceFingerprintSha256) {
    throw new Error(
      "Arena acceptance receipt does not bind the manifest event.",
    );
  }
  if (input.event.payloadType === "verificationRecorded") {
    if (receipt.receiptType !== "arenaVerificationAttempt"
      || receipt.checkId !== input.event.checkId) {
      throw new Error("Arena verification receipt type or check ID is invalid.");
    }
  } else if (receipt.receiptType !== "arenaBrowserJourneyAttempt"
    || receipt.journeyId !== input.event.journeyId) {
    throw new Error("Arena browser receipt type or journey ID is invalid.");
  }
}

export async function verifyArenaReplayAcceptanceReceipts(
  privateWorkspaceRoot: string,
  replay: ArenaManifestReplay,
): Promise<void> {
  for (const contestant of replay.contestants) {
    for (const check of contestant.verifications) {
      for (const event of check.attempts) {
        await verifyArenaAcceptanceReceipt({
          privateWorkspaceRoot,
          runId: replay.runId,
          event: event.payload as ArenaVerificationRecordedPayload,
        });
      }
    }
    for (const journey of contestant.browserJourneys) {
      for (const event of journey.attempts) {
        await verifyArenaAcceptanceReceipt({
          privateWorkspaceRoot,
          runId: replay.runId,
          event: event.payload as ArenaBrowserJourneyRecordedPayload,
        });
      }
    }
  }
}

async function persistAcceptanceReceipt(
  receipt: ArenaAcceptanceReceipt,
  privateWorkspaceRoot: string,
): Promise<string> {
  const boundary = await prepareArenaPrivateStorage(privateWorkspaceRoot);
  const kind = receipt.receiptType === "arenaVerificationAttempt"
    ? "verification"
    : "browser";
  const acceptanceId = receipt.receiptType === "arenaVerificationAttempt"
    ? receipt.checkId
    : receipt.journeyId;
  const directory = await ensureArenaPrivateDirectory(boundary, [
    "support",
    "acceptance",
    receipt.runId,
    receipt.contestantId,
    kind,
    acceptanceId,
  ]);
  const filePath = path.join(
    directory,
    `${String(receipt.attempt).padStart(3, "0")}.v1.json`,
  );
  const bytes = Buffer.from(
    `${canonicalArenaManifestJson(receipt)}\n`,
    "utf8",
  );
  if (bytes.byteLength > ARENA_ACCEPTANCE_LIMITS.maxReceiptBytes) {
    throw new Error("Arena acceptance receipt exceeds its private byte bound.");
  }
  await serializeArenaPrivateWork(boundary, filePath, async () => {
    try {
      await createArenaPrivateFile(filePath, bytes, boundary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await readArenaPrivateFile(
        filePath,
        ARENA_ACCEPTANCE_LIMITS.maxReceiptBytes,
        boundary,
      );
      if (!current.equals(bytes)) {
        throw new Error(
          "Arena acceptance receipt retry conflicts with durable state.",
        );
      }
    }
  });
  return filePath;
}

function acceptanceReceiptPath(
  privateWorkspaceRoot: string,
  runId: string,
  event: ArenaVerificationRecordedPayload | ArenaBrowserJourneyRecordedPayload,
): string {
  assertIdentifier(event.contestantId, "contestantId");
  const kind = event.payloadType === "verificationRecorded"
    ? "verification"
    : "browser";
  const acceptanceId = event.payloadType === "verificationRecorded"
    ? event.checkId
    : event.journeyId;
  assertIdentifier(acceptanceId, "acceptance ID");
  assertAttempt(event.attempt);
  return path.resolve(
    privateWorkspaceRoot,
    "arena",
    "support",
    "acceptance",
    runId,
    event.contestantId,
    kind,
    acceptanceId,
    `${String(event.attempt).padStart(3, "0")}.v1.json`,
  );
}

function parseAcceptanceReceipt(bytes: Buffer): ArenaAcceptanceReceipt {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Arena acceptance receipt is not valid UTF-8.");
  }
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
    throw new Error("Arena acceptance receipt must contain one complete JSON row.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    throw new Error("Arena acceptance receipt contains malformed JSON.");
  }
  if (!isRecord(value) || typeof value.receiptType !== "string") {
    throw new Error("Arena acceptance receipt has an invalid schema.");
  }
  const receipt = value.receiptType === "arenaVerificationAttempt"
    ? parseVerificationReceipt(value)
    : value.receiptType === "arenaBrowserJourneyAttempt"
      ? parseBrowserReceipt(value)
      : undefined;
  if (!receipt
    || `${canonicalArenaManifestJson(receipt)}\n` !== text) {
    throw new Error("Arena acceptance receipt is not canonical.");
  }
  return receipt;
}

function parseVerificationReceipt(
  value: Record<string, unknown>,
): ArenaVerificationAttemptReceipt {
  exactKeys(value, [
    "attempt", "cancelled", "checkId", "commandSha256", "contestantId",
    "durationMs", "exitCode", "finalState", "initialState", "planSha256",
    "quiescenceReceiptSha256", "receiptSha256", "receiptType", "runId",
    "schemaVersion", "status", "stderr", "stdout", "terminationConfirmed",
    "timedOut",
  ]);
  const withoutHash = {
    schemaVersion: literalOne(value.schemaVersion),
    receiptType: literalVerification(value.receiptType),
    runId: identifier(value.runId),
    contestantId: identifier(value.contestantId),
    checkId: identifier(value.checkId),
    attempt: attempt(value.attempt),
    planSha256: digest(value.planSha256),
    commandSha256: digest(value.commandSha256),
    initialState: validateWorkspaceState(value.initialState),
    finalState: validateWorkspaceState(value.finalState),
    status: verificationReceiptStatus(value.status),
    durationMs: duration(value.durationMs),
    exitCode: exitCode(value.exitCode),
    timedOut: bool(value.timedOut),
    cancelled: bool(value.cancelled),
    terminationConfirmed: bool(value.terminationConfirmed),
    quiescenceReceiptSha256: nullableDigest(value.quiescenceReceiptSha256),
    stdout: output(value.stdout),
    stderr: output(value.stderr),
  };
  const receiptSha256 = digest(value.receiptSha256);
  if (receiptSha256 !== hashCanonical(
    VERIFICATION_RECEIPT_HASH_DOMAIN,
    withoutHash,
  )) throw new Error("Arena verification receipt hash is invalid.");
  const validatedExecution = validateVerificationResult(withoutHash);
  if (withoutHash.status !== verificationStatus(validatedExecution)) {
    throw new Error("Arena verification receipt status contradicts its result.");
  }
  return Object.freeze({ ...withoutHash, receiptSha256 });
}

function parseBrowserReceipt(
  value: Record<string, unknown>,
): ArenaBrowserJourneyAttemptReceipt {
  exactKeys(value, [
    "actionCount", "attempt", "brokerReceiptSha256", "contestantId",
    "durationMs", "executionStarted", "finalState", "initialState",
    "journeyDefinitionSha256", "journeyId", "planSha256",
    "quiescenceReceiptSha256", "receiptSha256", "receiptType", "runId",
    "schemaVersion", "screenshotCount", "status",
  ]);
  const withoutHash = {
    schemaVersion: literalOne(value.schemaVersion),
    receiptType: literalBrowser(value.receiptType),
    runId: identifier(value.runId),
    contestantId: identifier(value.contestantId),
    journeyId: identifier(value.journeyId),
    attempt: attempt(value.attempt),
    planSha256: digest(value.planSha256),
    journeyDefinitionSha256: digest(value.journeyDefinitionSha256),
    initialState: validateWorkspaceState(value.initialState),
    finalState: validateWorkspaceState(value.finalState),
    status: browserReceiptStatus(value.status),
    durationMs: duration(value.durationMs),
    actionCount: boundedCount(value.actionCount, ARENA_ACCEPTANCE_LIMITS.maxActions),
    screenshotCount: boundedCount(
      value.screenshotCount,
      ARENA_ACCEPTANCE_LIMITS.maxScreenshots,
    ),
    executionStarted: bool(value.executionStarted),
    brokerReceiptSha256: digest(value.brokerReceiptSha256),
    quiescenceReceiptSha256: nullableDigest(value.quiescenceReceiptSha256),
  };
  const receiptSha256 = digest(value.receiptSha256);
  if (receiptSha256 !== hashCanonical(BROWSER_RECEIPT_HASH_DOMAIN, withoutHash)) {
    throw new Error("Arena browser receipt hash is invalid.");
  }
  validateBrowserResult(withoutHash);
  return Object.freeze({ ...withoutHash, receiptSha256 });
}

function assertVerificationPlan(
  plan: ArenaVerificationExecutionPlan,
  locked: ArenaVerificationCheckLock,
): void {
  validateVerificationPlanInput(plan);
  const actual = hashCanonical(VERIFICATION_PLAN_HASH_DOMAIN, {
    checkId: plan.checkId,
    command: plan.command,
    controlSha256: plan.controlSha256,
    timeoutMs: plan.timeoutMs,
    maxOutputChars: plan.maxOutputChars,
  });
  if (plan.planSha256 !== actual
    || locked.checkId !== plan.checkId
    || locked.planSha256 !== actual) {
    throw new Error("Arena verification plan digest does not match the locked check.");
  }
}

function assertBrowserPlan(
  plan: ArenaBrowserJourneyExecutionPlan,
  locked: ArenaBrowserJourneyLock,
): void {
  validateBrowserPlanInput(plan);
  const actual = hashCanonical(BROWSER_PLAN_HASH_DOMAIN, {
    journeyId: plan.journeyId,
    journeyDefinitionSha256: plan.journeyDefinitionSha256,
    timeoutMs: plan.timeoutMs,
  });
  if (plan.planSha256 !== actual
    || locked.journeyId !== plan.journeyId
    || locked.planSha256 !== actual) {
    throw new Error("Arena browser plan digest does not match the locked journey.");
  }
}

function validateVerificationPlanInput(
  input: ArenaVerificationExecutionPlanInput,
): void {
  assertIdentifier(input.checkId, "checkId");
  if (typeof input.command !== "string"
    || input.command.length === 0
    || input.command.includes("\u0000")
    || Buffer.byteLength(input.command, "utf8") > 16 * 1024) {
    throw new Error("Arena verification command is empty or oversized.");
  }
  assertDigest(input.controlSha256, "verification control");
  assertTimeout(input.timeoutMs);
  if (!Number.isSafeInteger(input.maxOutputChars)
    || input.maxOutputChars < 1
    || input.maxOutputChars > 1_000_000) {
    throw new Error("Arena verification output character bound is invalid.");
  }
}

function validateBrowserPlanInput(
  input: ArenaBrowserJourneyExecutionPlanInput,
): void {
  assertIdentifier(input.journeyId, "journeyId");
  assertDigest(input.journeyDefinitionSha256, "browser journey definition");
  assertTimeout(input.timeoutMs);
}

function validateAttemptBase(input: {
  readonly runId: string;
  readonly contestantId: string;
  readonly worktreePath: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
  readonly expectedState: ArenaAcceptanceWorkspaceState;
}): void {
  assertIdentifier(input.runId, "runId");
  assertIdentifier(input.contestantId, "contestantId");
  assertAttempt(input.attempt);
  validateWorkspaceState(input.expectedState);
  if (!(input.signal instanceof AbortSignal)) {
    throw new Error("Arena acceptance signal must be an AbortSignal.");
  }
  if (!path.isAbsolute(input.worktreePath)
    || path.resolve(input.worktreePath) !== input.worktreePath
    || input.worktreePath.includes("\u0000")) {
    throw new Error("Arena acceptance worktree path must be exact and absolute.");
  }
}

interface AcceptanceWorktreeIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly realPath: string;
}

async function captureExactWorktree(
  worktreePath: string,
): Promise<AcceptanceWorktreeIdentity> {
  const stat = await fs.lstat(worktreePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Arena acceptance worktree must be a real directory.");
  }
  const realPath = path.resolve(await fs.realpath(worktreePath));
  if (!samePath(realPath, worktreePath)) {
    throw new Error(
      "Arena acceptance worktree path must already be its canonical target.",
    );
  }
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    realPath,
  });
}

async function assertExactWorktreeIdentity(
  worktreePath: string,
  expected: AcceptanceWorktreeIdentity,
): Promise<void> {
  const current = await captureExactWorktree(worktreePath);
  if (current.dev !== expected.dev
    || current.ino !== expected.ino
    || !samePath(current.realPath, expected.realPath)) {
    throw new Error("Arena acceptance worktree changed identity during execution.");
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function validateVerificationResult(
  result: ArenaVerificationExecutorResult,
): ArenaVerificationExecutorResult {
  if (!isRecord(result)) throw new Error("Arena verification result is invalid.");
  const normalized = {
    exitCode: exitCode(result.exitCode),
    timedOut: bool(result.timedOut),
    cancelled: bool(result.cancelled),
    durationMs: duration(result.durationMs),
    stdout: output(result.stdout),
    stderr: output(result.stderr),
    terminationConfirmed: bool(result.terminationConfirmed),
    quiescenceReceiptSha256: nullableDigest(result.quiescenceReceiptSha256),
  };
  if (normalized.terminationConfirmed
    !== (normalized.quiescenceReceiptSha256 !== null)) {
    throw new Error(
      "Arena verification must pair confirmed termination with a typed quiescence receipt.",
    );
  }
  if (normalized.timedOut && normalized.cancelled) {
    throw new Error("Arena verification cannot be both timed out and cancelled.");
  }
  return Object.freeze(normalized);
}

function validateBrowserResult(
  result: ArenaBrowserJourneyExecutorResult,
): ArenaBrowserJourneyExecutorResult {
  if (!isRecord(result)) throw new Error("Arena browser result is invalid.");
  const normalized = {
    status: browserReceiptStatus(result.status),
    durationMs: duration(result.durationMs),
    actionCount: boundedCount(result.actionCount, ARENA_ACCEPTANCE_LIMITS.maxActions),
    screenshotCount: boundedCount(
      result.screenshotCount,
      ARENA_ACCEPTANCE_LIMITS.maxScreenshots,
    ),
    executionStarted: bool(result.executionStarted),
    brokerReceiptSha256: digest(result.brokerReceiptSha256),
    quiescenceReceiptSha256: nullableDigest(result.quiescenceReceiptSha256),
  };
  if (normalized.executionStarted
    !== (normalized.quiescenceReceiptSha256 !== null)) {
    throw new Error(
      "Arena browser execution must pair a started journey with quiescence proof.",
    );
  }
  if (!normalized.executionStarted
    && normalized.status !== "denied"
    && normalized.status !== "unavailable") {
    throw new Error(
      "Arena browser no-execution receipts must be denied or unavailable.",
    );
  }
  return Object.freeze(normalized);
}

function verificationStatus(
  result: ArenaVerificationExecutorResult,
): ArenaVerificationRecordedPayload["status"] {
  if (!result.terminationConfirmed) return "unconfirmed";
  if (result.cancelled) return "cancelled";
  if (result.timedOut) return "timedOut";
  return result.exitCode === 0 ? "passed" : "failed";
}

function validateWorkspaceState(value: unknown): ArenaAcceptanceWorkspaceState {
  if (!isRecord(value)) throw new Error("Arena acceptance workspace state is invalid.");
  exactKeys(value, ["head", "workspaceFingerprintSha256"]);
  const head = value.head;
  if (!isRecord(head)) throw new Error("Arena acceptance HEAD is invalid.");
  exactKeys(head, ["objectFormat", "oid"]);
  if (head.objectFormat !== "sha1" && head.objectFormat !== "sha256") {
    throw new Error("Arena acceptance Git object format is invalid.");
  }
  const oidLength = head.objectFormat === "sha1" ? 40 : 64;
  if (typeof head.oid !== "string"
    || !new RegExp(`^[a-f0-9]{${oidLength}}$`, "u").test(head.oid)) {
    throw new Error("Arena acceptance Git object ID is invalid.");
  }
  return Object.freeze({
    head: Object.freeze({ objectFormat: head.objectFormat, oid: head.oid }),
    workspaceFingerprintSha256: digest(value.workspaceFingerprintSha256),
  });
}

function assertSameWorkspaceState(
  actual: ArenaAcceptanceWorkspaceState,
  expected: ArenaAcceptanceWorkspaceState,
  label: string,
): void {
  const normalizedExpected = validateWorkspaceState(expected);
  if (!sameGitObject(actual.head, normalizedExpected.head)
    || actual.workspaceFingerprintSha256
      !== normalizedExpected.workspaceFingerprintSha256) {
    throw new Error(`Arena contestant state changed ${label}.`);
  }
}

function sameGitObject(left: ArenaGitObjectId, right: ArenaGitObjectId): boolean {
  return left.objectFormat === right.objectFormat && left.oid === right.oid;
}

function output(value: unknown): ArenaAcceptanceOutputMetadata {
  if (!isRecord(value)) throw new Error("Arena acceptance output metadata is invalid.");
  exactKeys(value, ["bytes", "sha256"]);
  return Object.freeze({
    bytes: boundedCount(value.bytes, ARENA_ACCEPTANCE_LIMITS.maxOutputBytes),
    sha256: digest(value.sha256),
  });
}

function duration(value: unknown): number {
  if (!Number.isSafeInteger(value)
    || (value as number) < 0
    || (value as number) > ARENA_ACCEPTANCE_LIMITS.maxDurationMs) {
    throw new Error("Arena acceptance duration is invalid.");
  }
  return value as number;
}

function boundedCount(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new Error("Arena acceptance bounded count is invalid.");
  }
  return value as number;
}

function exitCode(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)
    || (value as number) < -2_147_483_648
    || (value as number) > 2_147_483_647) {
    throw new Error("Arena verification exit code is invalid.");
  }
  return value as number;
}

function verificationReceiptStatus(
  value: unknown,
): ArenaVerificationRecordedPayload["status"] {
  if (!["passed", "failed", "cancelled", "timedOut", "unconfirmed"].includes(String(value))) {
    throw new Error("Arena verification receipt status is invalid.");
  }
  return value as ArenaVerificationRecordedPayload["status"];
}

function browserReceiptStatus(
  value: unknown,
): ArenaBrowserJourneyRecordedPayload["status"] {
  if (!["passed", "failed", "cancelled", "timedOut", "denied", "unavailable"]
    .includes(String(value))) {
    throw new Error("Arena browser receipt status is invalid.");
  }
  return value as ArenaBrowserJourneyRecordedPayload["status"];
}

function literalOne(value: unknown): typeof ARENA_ACCEPTANCE_SCHEMA_VERSION {
  if (value !== ARENA_ACCEPTANCE_SCHEMA_VERSION) {
    throw new Error("Arena acceptance receipt schema version is invalid.");
  }
  return ARENA_ACCEPTANCE_SCHEMA_VERSION;
}

function literalVerification(value: unknown): "arenaVerificationAttempt" {
  if (value !== "arenaVerificationAttempt") {
    throw new Error("Arena verification receipt type is invalid.");
  }
  return value;
}

function literalBrowser(value: unknown): "arenaBrowserJourneyAttempt" {
  if (value !== "arenaBrowserJourneyAttempt") {
    throw new Error("Arena browser receipt type is invalid.");
  }
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Arena acceptance boolean is invalid.");
  return value;
}

function nullableDigest(value: unknown): string | null {
  return value === null ? null : digest(value);
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error("Arena acceptance digest is invalid.");
  }
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error("Arena acceptance identifier is invalid.");
  }
  return value;
}

function attempt(value: unknown): number {
  assertAttempt(value);
  return value;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Arena acceptance ${label} is invalid.`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`Arena acceptance ${label} digest is invalid.`);
  }
}

function assertAttempt(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100) {
    throw new Error("Arena acceptance attempt is outside its manifest bound.");
  }
}

function assertTimeout(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value)
    || (value as number) < 1
    || (value as number) > ARENA_ACCEPTANCE_LIMITS.maxDurationMs) {
    throw new Error("Arena acceptance timeout is invalid.");
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new Error("Arena acceptance receipt has unknown or missing fields.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hashCanonical(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(canonicalArenaManifestJson(value), "utf8")
    .digest("hex");
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
