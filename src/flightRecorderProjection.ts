import { createHash } from "node:crypto";
import type { NativeActionReceipt } from "./nativeActions";
import type { FlightRecordedOutcome } from "./flightRecorderRuntime";
import type {
  FlightEditBatchSubject,
  FlightOperationObservation,
  FlightToolCallResultObservation,
  FlightToolCallSubject,
  FlightNativeActionReceiptObservation,
  FlightNativeActionSubject,
  FlightSteeringChainMetadata,
  FlightUsageSummaryObservation,
  FlightUsageSubject,
  FlightVerificationReceiptObservation,
  FlightVerificationSubject,
} from "./flightRecorderProtocol";
import type {
  ProviderTelemetryObservation,
  ProviderToolCategory,
} from "./providerTelemetry";
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

export interface FlightProviderChildProjection {
  readonly subject: FlightToolCallSubject | FlightEditBatchSubject;
  readonly observation: FlightToolCallResultObservation
    | Extract<FlightOperationObservation, { readonly kind: "editBatch" }>;
  readonly outcome: FlightRecordedOutcome;
}

export interface FlightProviderTelemetryProjection {
  readonly agentObservations: readonly Extract<
    FlightOperationObservation,
    { readonly kind: "agentRun" }
  >[];
  readonly childOperations: readonly FlightProviderChildProjection[];
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

/**
 * Convert the content-free provider normalizer stream into strict Flight
 * child operations. Provider IDs are already one-way hashes and tool names
 * are low-cardinality categories; raw arguments/results never cross this API.
 */
export function buildFlightProviderTelemetryProjection(
  observations: readonly ProviderTelemetryObservation[],
  workspaceBeforeSha256?: string,
  workspaceAfterSha256?: string,
): FlightProviderTelemetryProjection {
  const agentObservations: Array<Extract<
    FlightOperationObservation,
    { readonly kind: "agentRun" }
  >> = [];
  const childOperations: FlightProviderChildProjection[] = [];
  const tools = new Map<string, {
    provider: string;
    category: ProviderToolCategory;
    argumentBytes: number;
  }>();
  const finished = new Set<string>();

  for (const observation of observations) {
    switch (observation.observationType) {
      case "providerToolStarted":
        if (!tools.has(observation.providerOperationIdSha256)) {
          tools.set(observation.providerOperationIdSha256, {
            provider: observation.provider,
            category: observation.toolCategory,
            argumentBytes: observation.argumentBytes,
          });
        }
        break;
      case "providerToolFinished": {
        if (finished.has(observation.providerOperationIdSha256)) break;
        const started = tools.get(observation.providerOperationIdSha256);
        const lifecycleComplete = started !== undefined
          && started.provider === observation.provider
          && started.category === observation.toolCategory;
        childOperations.push(toolProjection({
          provider: started?.provider ?? observation.provider,
          category: started?.category ?? observation.toolCategory,
          providerOperationIdSha256: observation.providerOperationIdSha256,
          argumentBytes: started?.argumentBytes ?? 0,
          status: observation.status,
          resultBytes: observation.resultBytes,
          lifecycleComplete,
        }));
        if (!lifecycleComplete) {
          addAvailability(agentObservations, "unavailable", "malformed");
        }
        tools.delete(observation.providerOperationIdSha256);
        finished.add(observation.providerOperationIdSha256);
        break;
      }
      case "providerEditBatch":
        if (isDigest(workspaceBeforeSha256) && isDigest(workspaceAfterSha256)) {
          childOperations.push(Object.freeze({
            subject: Object.freeze({
              kind: "editBatch",
              provider: observation.provider,
              createCount: observation.createCount,
              updateCount: observation.updateCount,
              deleteCount: observation.deleteCount,
              pathCount: observation.pathCount,
              workspaceBeforeSha256,
              evidenceClass: "providerObserved",
            }),
            observation: Object.freeze({
              kind: "editBatch",
              observationType: "workspaceMutation",
              createCount: observation.createCount,
              updateCount: observation.updateCount,
              deleteCount: observation.deleteCount,
              pathCount: observation.pathCount,
              workspaceAfterSha256,
              evidenceClass: "providerObserved",
            }),
            outcome: Object.freeze({
              status: "succeeded",
              failureCode: null,
            }),
          }));
        } else {
          addAvailability(agentObservations, "unavailable", "unsupported");
        }
        break;
      case "providerTelemetryLimited":
        addAvailability(agentObservations, "limited", "providerFlood");
        break;
      case "providerTelemetryUnavailable":
        addAvailability(agentObservations, "unavailable", observation.reason);
        break;
      case "providerPermissionSummary":
        if (observation.deniedCount > 0) {
          addAvailability(agentObservations, "limited", "unsupported");
        }
        break;
      case "providerLifecycle":
      case "providerUsage":
        break;
    }
  }

  for (const [providerOperationIdSha256, started] of tools) {
    childOperations.push(toolProjection({
      provider: started.provider,
      category: started.category,
      providerOperationIdSha256,
      argumentBytes: started.argumentBytes,
      status: "unknown",
      resultBytes: 0,
      lifecycleComplete: false,
    }));
  }
  return Object.freeze({
    agentObservations: Object.freeze(agentObservations),
    childOperations: Object.freeze(childOperations),
  });
}

function toolProjection(input: {
  readonly provider: string;
  readonly category: ProviderToolCategory;
  readonly providerOperationIdSha256: string;
  readonly argumentBytes: number;
  readonly status: "succeeded" | "failed" | "unknown";
  readonly resultBytes: number;
  readonly lifecycleComplete: boolean;
}): FlightProviderChildProjection {
  const outcome: FlightRecordedOutcome = !input.lifecycleComplete
    ? { status: "incomplete", failureCode: "unknown" }
    : input.status === "succeeded"
    ? { status: "succeeded", failureCode: null }
    : input.status === "failed"
      ? { status: "failed", failureCode: "providerFailure" }
      : { status: "incomplete", failureCode: "unknown" };
  return Object.freeze({
    subject: Object.freeze({
      kind: "toolCall",
      provider: input.provider,
      toolName: input.category,
      providerOperationIdSha256: input.providerOperationIdSha256,
      argumentBytes: input.argumentBytes,
      evidenceClass: "providerObserved",
    }),
    observation: Object.freeze({
      kind: "toolCall",
      observationType: "toolCallResult",
      status: input.status,
      resultBytes: input.resultBytes,
      evidenceClass: "providerObserved",
    }),
    outcome: Object.freeze(outcome),
  });
}

function addAvailability(
  target: Array<Extract<FlightOperationObservation, { readonly kind: "agentRun" }>>,
  detail: "unavailable" | "limited",
  reason: "plainOutput" | "unsupported" | "malformed" | "providerFlood",
): void {
  if (target.some((observation) =>
    observation.observationType === "telemetryAvailability"
    && observation.detail === detail
    && observation.reason === reason
  )) return;
  target.push(Object.freeze({
    kind: "agentRun",
    observationType: "telemetryAvailability",
    detail,
    reason,
  }));
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
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
