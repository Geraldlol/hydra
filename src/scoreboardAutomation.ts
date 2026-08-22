import { createHash } from "node:crypto";
import { isValidAgentId } from "./agentValidation";
import type {
  ClaimRegisteredEvent,
  VerdictRecordedEvent,
} from "./scoreboard";
import type { VerificationResult } from "./verification";
import { verificationScoringPlanSha256, type ResolvedVerificationCommand } from "./verification";

const AUTOMATIC_SCORE_VERSION = "hydra-verified-build-score-v2";
const AUTOMATIC_ROUND_VERSION = "hydra-verified-build-round-v2";
const VERIFICATION_RECEIPT_VERSION = "hydra-verification-receipt-sha256-v1";
const SHA256_RE = /^[a-f0-9]{64}$/;

export interface PostBuildWorkspaceEvidence {
  /** SHA-256 fingerprint captured after the serial builder completed. */
  readonly fingerprintSha256: string;
  /** Whether the builder-produced workspace differs from its pre-build state. */
  readonly didChange: boolean;
}

export interface VerifiedBuildScoreInput {
  readonly agentId: string;
  readonly verification: VerificationResult;
  readonly postBuild: PostBuildWorkspaceEvidence;
  readonly verifier: {
    readonly resolutionKind: ResolvedVerificationCommand["kind"];
    readonly planSha256: string;
    readonly controlSha256: string;
    readonly controlsUnchanged: boolean;
  };
}

export type VerifiedBuildScoreEvents =
  | readonly []
  | readonly [ClaimRegisteredEvent, VerdictRecordedEvent];

/**
 * Produces the passive-score events justified by a serial builder's clean
 * verification result. Every value is derived from durable evidence so
 * retrying the same input yields the same event ids and payloads.
 */
export function scoreboardEventsForVerifiedBuild(
  input: VerifiedBuildScoreInput,
): VerifiedBuildScoreEvents {
  if (!isValidInput(input)) return [];

  const receiptSha256 = verificationReceiptSha256(input.verification);
  const fingerprintSha256 = input.postBuild.fingerprintSha256;
  const planSha256 = input.verifier.planSha256;
  const controlSha256 = input.verifier.controlSha256;
  const scoreKey = sha256(JSON.stringify([
    AUTOMATIC_SCORE_VERSION,
    input.agentId,
    receiptSha256,
    fingerprintSha256,
    planSha256,
    controlSha256,
  ]));
  // Repeated passing receipts under one unchanged evidence regime are
  // correlated observations, not independent rounds. Keep each claim
  // auditable while sharing the aggregation cap across heads and retries.
  const roundKey = sha256(JSON.stringify([
    AUTOMATIC_ROUND_VERSION,
    planSha256,
    controlSha256,
  ]));
  const claimId = `verified-build-claim-${scoreKey}`;
  const verdictId = `verified-build-verdict-${scoreKey}`;
  const occurredAt = input.verification.timestamp;

  const claim: ClaimRegisteredEvent = {
    type: "claimRegistered",
    eventId: `event-${claimId}`,
    occurredAt,
    claimId,
    roundId: `verified-build-round-${roundKey}`,
    agentId: input.agentId,
    domain: "build-verification",
    statement: `Post-build Git-visible workspace state ${fingerprintSha256} following ${input.agentId}'s changed serial Build passed verification receipt ${receiptSha256} under pre-dispatch plan ${planSha256} with unchanged verifier controls ${controlSha256}.`,
    confidence: null,
  };
  const verdict: VerdictRecordedEvent = {
    type: "verdictRecorded",
    eventId: `event-${verdictId}`,
    occurredAt,
    verdictId,
    claimId,
    outcome: "correct",
    source: "deterministic",
    adjudicatorId: "hydra-verification",
    evidenceRef: `verification-sha256:${receiptSha256};post-build-workspace-sha256:${fingerprintSha256};verification-plan-sha256:${planSha256};verification-controls-sha256:${controlSha256}`,
    rationale: "The verification receipt reports a clean command pass and is bound to the changed post-build workspace, the command plan frozen before dispatch, and an unchanged bounded verifier-control inventory. This establishes only that the recorded state passed that command, not authorship of every change or global correctness.",
  };

  return [claim, verdict];
}

function isValidInput(input: VerifiedBuildScoreInput): boolean {
  return !!input
    && isValidAgentId(input.agentId)
    && isVerificationReceipt(input.verification)
    && input.verification.exitCode === 0
    && !input.verification.timedOut
    && !input.verification.terminationFailed
    && !!input.postBuild
    && input.postBuild.didChange === true
    && SHA256_RE.test(input.postBuild.fingerprintSha256)
    && !!input.verifier
    && (input.verifier.resolutionKind === "explicit" || input.verifier.resolutionKind === "inferred")
    && input.verifier.controlsUnchanged === true
    && SHA256_RE.test(input.verifier.planSha256)
    && SHA256_RE.test(input.verifier.controlSha256)
    && input.verifier.planSha256 === verificationScoringPlanSha256(
      input.verifier.resolutionKind,
      input.verification.command,
    );
}

function isVerificationReceipt(value: VerificationResult): boolean {
  return !!value
    && typeof value.timestamp === "string"
    && value.timestamp.length > 0
    && value.timestamp === value.timestamp.trim()
    && Number.isFinite(Date.parse(value.timestamp))
    && typeof value.command === "string"
    && value.command.trim().length > 0
    && typeof value.cwd === "string"
    && value.cwd.trim().length > 0
    && (typeof value.exitCode === "number" || value.exitCode === null)
    && typeof value.timedOut === "boolean"
    && typeof value.durationMs === "number"
    && Number.isFinite(value.durationMs)
    && value.durationMs >= 0
    && typeof value.stdout === "string"
    && typeof value.stderr === "string"
    && (value.terminationFailed === undefined || typeof value.terminationFailed === "boolean")
    && (value.headSha === undefined || typeof value.headSha === "string");
}

function verificationReceiptSha256(result: VerificationResult): string {
  return sha256(JSON.stringify([
    VERIFICATION_RECEIPT_VERSION,
    result.timestamp,
    result.command,
    result.cwd,
    result.exitCode,
    result.timedOut,
    result.durationMs,
    result.stdout,
    result.stderr,
    result.terminationFailed ?? false,
    result.headSha ?? null,
  ]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
