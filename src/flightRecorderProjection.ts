import { createHash } from "node:crypto";
import type { NativeActionReceipt } from "./nativeActions";
import type { FlightRecordedOutcome } from "./flightRecorderRuntime";
import type {
  FlightNativeActionReceiptObservation,
  FlightNativeActionSubject,
  FlightSteeringChainMetadata,
  FlightUsageSummaryObservation,
  FlightUsageSubject,
  FlightVerificationReceiptObservation,
  FlightVerificationSubject,
} from "./flightRecorderProtocol";
import type { UsageRecord } from "./usage";
import {
  verificationProcessForCommand,
  verificationScoringPlanSha256,
  type ResolvedVerificationCommand,
  type VerificationResult,
} from "./verification";

const VERIFICATION_INVOCATION_DOMAIN =
  "hydra-flight-verification-invocation-v1";
const VERIFICATION_RECEIPT_DOMAIN =
  "hydra-flight-verification-receipt-v1";
const NATIVE_ACTION_RECEIPT_DOMAIN =
  "hydra-flight-native-action-receipt-v1";

export interface FlightVerificationSourceBinding {
  readonly runId: string;
  readonly steeringChain: FlightSteeringChainMetadata;
}

export interface BuildFlightVerificationProjectionInput {
  readonly verificationId: string;
  readonly resolution: ResolvedVerificationCommand;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  readonly result: VerificationResult & { readonly cancelled?: boolean };
  readonly source?: FlightVerificationSourceBinding;
  readonly platform?: NodeJS.Platform;
}

export type BuildFlightVerificationStartInput = Omit<
  BuildFlightVerificationProjectionInput,
  "result"
>;

export interface FlightVerificationStartProjection {
  readonly subject: FlightVerificationSubject;
  readonly planSha256: string;
  readonly invocationShapeSha256: string;
}

export interface FlightVerificationProjection {
  readonly subject: FlightVerificationSubject;
  readonly observation: FlightVerificationReceiptObservation;
  readonly outcome: FlightRecordedOutcome;
}

export interface BuildFlightUsageProjectionInput {
  readonly usageId: string;
  readonly runId: string;
  readonly model: string;
  readonly record: UsageRecord;
  readonly steeringChain: FlightSteeringChainMetadata;
}

export interface FlightUsageProjection {
  readonly subject: FlightUsageSubject;
  readonly observation: FlightUsageSummaryObservation;
  readonly outcome: FlightRecordedOutcome;
}

export interface BuildFlightNativeActionProjectionInput {
  readonly receipt: NativeActionReceipt;
  readonly receiptPersisted: boolean;
  readonly actionKind: "prompt" | "command" | "rawLine";
  readonly attachmentCount: number;
}

export interface FlightNativeActionProjection {
  readonly subject: FlightNativeActionSubject;
  readonly observation: FlightNativeActionReceiptObservation;
  readonly outcome: FlightRecordedOutcome;
}

export function buildFlightVerificationProjection(
  input: BuildFlightVerificationProjectionInput,
): FlightVerificationProjection {
  const start = buildFlightVerificationStart(input);
  const planSha256 = start.planSha256;
  const invocationShapeSha256 = start.invocationShapeSha256;
  const sourceRunId = start.subject.sourceRunId;
  const sourceSteeringChain = start.subject.sourceSteeringChain;
  const stdout = outputMetadata(
    input.result.stdout,
    input.result.stdoutBytes,
    input.result.stdoutSha256,
  );
  const stderr = outputMetadata(
    input.result.stderr,
    input.result.stderrBytes,
    input.result.stderrSha256,
  );
  const headRevisionSha = isRevisionHash(input.result.headSha)
    ? input.result.headSha
    : null;
  const outcome = mapVerificationOutcome(input.result);
  const receiptSha256 = sha256Canonical([
    VERIFICATION_RECEIPT_DOMAIN,
    input.verificationId,
    planSha256,
    invocationShapeSha256,
    outcome.status,
    outcome.failureCode,
    input.result.exitCode,
    input.result.timedOut,
    input.result.cancelled === true,
    input.result.terminationFailed === true,
    input.result.durationMs,
    headRevisionSha,
    stdout,
    stderr,
    sourceRunId,
    sourceSteeringChain,
  ]);

  return Object.freeze({
    subject: start.subject,
    observation: Object.freeze({
      kind: "verification",
      observationType: "verificationReceipt",
      receiptSha256,
      headRevisionSha,
      exitCode: input.result.exitCode,
      stdout,
      stderr,
      sourceSteeringChain,
      evidenceClass: "hydraObserved",
    }),
    outcome: Object.freeze(outcome),
  });
}

export function buildFlightVerificationStart(
  input: BuildFlightVerificationStartInput,
): FlightVerificationStartProjection {
  const process = verificationProcessForCommand(
    input.resolution.command,
    input.platform,
  );
  const planSha256 = verificationScoringPlanSha256(
    input.resolution.kind,
    input.resolution.command,
  );
  const invocationShapeSha256 = sha256Canonical([
    VERIFICATION_INVOCATION_DOMAIN,
    input.resolution.kind,
    process.command,
    process.args,
    process.shell,
    input.timeoutMs,
    input.maxOutputChars,
  ]);
  const sourceRunId = input.source?.runId ?? null;
  const sourceSteeringChain = input.source?.steeringChain ?? null;
  return Object.freeze({
    subject: Object.freeze({
      kind: "verification",
      verificationId: input.verificationId,
      planSha256,
      invocationShapeSha256,
      sourceRunId,
      sourceSteeringChain,
      evidenceClass: "hydraObserved",
    }),
    planSha256,
    invocationShapeSha256,
  });
}

export function buildFlightUsageProjection(
  input: BuildFlightUsageProjectionInput,
): FlightUsageProjection | undefined {
  const integers = [
    input.record.inputTokens,
    input.record.outputTokens,
    input.record.cacheReadTokens,
    input.record.cacheCreateTokens,
    input.record.reasoningTokens,
  ];
  if (!integers.every(isNonNegativeSafeInteger)
    || !Number.isFinite(input.record.costUsd)
    || input.record.costUsd < 0) {
    return undefined;
  }
  const model = boundedLabel(input.model, "provider-default");
  const steeringChain = Object.freeze({
    sha256: input.steeringChain.sha256,
    indeterminate: input.steeringChain.indeterminate,
  });
  return Object.freeze({
    subject: Object.freeze({
      kind: "usage",
      usageId: input.usageId,
      runId: input.runId,
      model,
      source: input.record.costSource,
      evidenceClass: "providerObserved",
    }),
    observation: Object.freeze({
      kind: "usage",
      observationType: "usageSummary",
      inputTokens: input.record.inputTokens,
      outputTokens: input.record.outputTokens,
      cacheReadTokens: input.record.cacheReadTokens,
      cacheCreationTokens: input.record.cacheCreateTokens,
      reasoningTokens: input.record.reasoningTokens,
      totalCostUsd: input.record.costUsd,
      costSource: input.record.costSource,
      steeringChain,
      evidenceClass: "providerObserved",
    }),
    outcome: Object.freeze({
      status: "succeeded",
      failureCode: null,
    }),
  });
}

export function buildFlightNativeActionProjection(
  input: BuildFlightNativeActionProjectionInput,
): FlightNativeActionProjection {
  const receiptSha256 = sha256Canonical([
    NATIVE_ACTION_RECEIPT_DOMAIN,
    input.receipt.id,
    input.receipt.timestamp,
    input.receipt.agents,
    sha256Text(input.receipt.instruction),
    input.receipt.includeEditorContext,
    input.receipt.includeWorkspaceDiff,
    input.receipt.editorContext ?? null,
    input.receipt.workspaceDiffChars ?? null,
    input.receipt.promptEnvelopeIds,
    input.receipt.nativeSessionHints ?? [],
    input.receipt.status,
  ]);
  const outcome: FlightRecordedOutcome = !input.receiptPersisted
    ? { status: "incomplete", failureCode: "recorderFailure" }
    : input.receipt.status === "completed"
      ? { status: "succeeded", failureCode: null }
      : input.receipt.status === "cancelled"
        ? { status: "cancelled", failureCode: "cancelled" }
        : { status: "failed", failureCode: "providerFailure" };
  return Object.freeze({
    subject: Object.freeze({
      kind: "nativeAction",
      nativeActionId: input.receipt.id,
      actionKind: input.actionKind,
      headCount: input.receipt.agents.length,
      attachmentCount: input.attachmentCount,
      evidenceClass: "hydraObserved",
    }),
    observation: Object.freeze({
      kind: "nativeAction",
      observationType: "nativeActionReceipt",
      receiptSha256,
      status: input.receiptPersisted ? "recorded" : "failed",
      evidenceClass: "hydraObserved",
    }),
    outcome: Object.freeze(outcome),
  });
}

function mapVerificationOutcome(
  result: VerificationResult & { readonly cancelled?: boolean },
): FlightRecordedOutcome {
  if (result.terminationFailed === true) {
    return {
      status: "deliveryUnknown",
      failureCode: "terminationUnconfirmed",
    };
  }
  if (result.cancelled === true) {
    return { status: "cancelled", failureCode: "cancelled" };
  }
  if (result.timedOut) {
    return { status: "timedOut", failureCode: "timeout" };
  }
  if (result.exitCode === 0) {
    return { status: "succeeded", failureCode: null };
  }
  if (result.exitCode === null) {
    return { status: "failed", failureCode: "transportFailure" };
  }
  return { status: "failed", failureCode: "validationFailure" };
}

function outputMetadata(
  value: string,
  fullBytes?: number,
  fullSha256?: string,
): Readonly<{
  bytes: number;
  sha256: string;
}> {
  const hasCompleteFullMetadata =
    Number.isSafeInteger(fullBytes)
    && fullBytes! >= 0
    && typeof fullSha256 === "string"
    && /^[0-9a-f]{64}$/i.test(fullSha256);
  return Object.freeze({
    bytes: hasCompleteFullMetadata
      ? fullBytes!
      : Buffer.byteLength(value, "utf8"),
    sha256: hasCompleteFullMetadata
      ? fullSha256!.toLowerCase()
      : sha256Text(value),
  });
}

function sha256Canonical(value: unknown): string {
  return sha256Text(JSON.stringify(value));
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isRevisionHash(value: unknown): value is string {
  return typeof value === "string"
    && (/^[0-9a-f]{40}$/i.test(value) || /^[0-9a-f]{64}$/i.test(value));
}

function boundedLabel(value: string, fallback: string): string {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128
    ? normalized
    : fallback;
}
