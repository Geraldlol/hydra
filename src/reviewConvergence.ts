import type { AgentId } from "./phases";

export const REVIEW_CONVERGENCE_MODES = ["human", "unanimous", "majority"] as const;
export type ReviewConvergenceMode = (typeof REVIEW_CONVERGENCE_MODES)[number];

export interface ReviewVerdict {
  agent: AgentId;
  approved: boolean;
}

export type ReviewConvergenceDecision =
  | "approved"
  | "changes-required"
  | "human-resolution-required";

export interface ReviewConvergenceResult {
  approved: boolean;
  approvals: number;
  total: number;
  dissenters: AgentId[];
  decision: ReviewConvergenceDecision;
  requiresHumanResolution: boolean;
}

/**
 * Fold independent reviewer verdicts without losing dissent information.
 * Human mode resolves unanimous approval directly but leaves any multi-head
 * dissent pending for an explicit operator choice. Majority is strict: ties
 * and empty panels fail closed, and unanimous mode advances only when every
 * reviewer approves.
 */
export function evaluateReviewConvergence(
  verdicts: ReadonlyArray<ReviewVerdict>,
  mode: ReviewConvergenceMode,
): ReviewConvergenceResult {
  const total = verdicts.length;
  const approvals = verdicts.reduce(
    (count, verdict) => count + (verdict.approved ? 1 : 0),
    0,
  );
  const dissenters = verdicts
    .filter((verdict) => !verdict.approved)
    .map((verdict) => verdict.agent);
  const unanimousApproval = total > 0 && approvals === total;
  const requiresHumanResolution = mode === "human" && total > 1 && !unanimousApproval;
  const approved = mode === "majority"
    ? total > 0 && approvals * 2 > total
    : unanimousApproval;
  const decision: ReviewConvergenceDecision = approved
    ? "approved"
    : requiresHumanResolution
      ? "human-resolution-required"
      : "changes-required";

  return {
    approved,
    approvals,
    total,
    dissenters,
    decision,
    requiresHumanResolution,
  };
}
