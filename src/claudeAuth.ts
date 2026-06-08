// Claude automation auth/credit guard (Many Heads Mode, Milestone 0).
//
// Why this exists: starting 2026-06-15, subscription-backed `claude -p` /
// Agent SDK usage draws from a capped monthly Agent SDK credit pool rather than
// pay-as-you-go API billing. Hydra runs Claude headlessly every room turn, so a
// subscription-authed user can silently burn that pool. This module is the pure
// data + decision layer for surfacing and (later) gating that exposure. The
// actual dispatch gate (callAgent) and Doctor/UI surfacing wire this in a later
// slice - nothing here changes spawn behavior on its own.

/**
 * The only fields Hydra retains from `claude auth status`. The raw command also
 * emits `email`, `orgId`, and `orgName`; those are sensitive and are dropped at
 * capture time (see sanitizeClaudeAuthStatus) rather than relying on
 * render-time redaction.
 */
export interface ClaudeAuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
  /** Auth resolves to a raw API key - pay-as-you-go, unaffected by the credit pool. A populated subscriptionType outranks this. */
  isApiKey: boolean;
  /** Auth resolves to a first-party subscription (claude.ai / a plan) - credit-pool exposed. A populated subscriptionType wins over an apiKey-looking authMethod. */
  isSubscription: boolean;
}

export type ClaudeAutomationGuardMode = "off" | "warn" | "blockManyHeads" | "blockClaudeAutomation";

export const CLAUDE_AUTOMATION_GUARD_MODES: readonly ClaudeAutomationGuardMode[] = [
  "off",
  "warn",
  "blockManyHeads",
  "blockClaudeAutomation",
];

const API_KEY_PATTERN = /api[ _-]?key/i;
const SUBSCRIPTION_AUTH_PATTERN = /claude\.?ai/i;

/**
 * Extract only the four non-sensitive scalar fields from a parsed
 * `claude auth status` payload and derive the two auth-class booleans. Any
 * other field (email/orgId/orgName/unknowns) is never copied out, so the
 * sanitized object is safe to log, snapshot, or surface in Doctor. Tolerant of
 * malformed input: a non-object yields an empty, non-subscription status.
 */
export function sanitizeClaudeAuthStatus(raw: unknown): ClaudeAuthStatus {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const loggedIn = typeof record.loggedIn === "boolean" ? record.loggedIn : undefined;
  const authMethod = typeof record.authMethod === "string" ? record.authMethod : undefined;
  const apiProvider = typeof record.apiProvider === "string" ? record.apiProvider : undefined;
  const subscriptionType = typeof record.subscriptionType === "string" ? record.subscriptionType : undefined;

  // Precedence (load-bearing for the guard): a populated subscriptionType is a
  // real structured plan field and a stronger signal than a substring match on
  // the free-text authMethod, so it wins. Only when no plan field is present do
  // we fall back to authMethod heuristics. This keeps an ambiguous string like
  // "apiKey via claude.ai" on a genuinely subscription-backed account from being
  // misclassified as API-key (which would silently skip the credit guard).
  const hasSubscriptionType = Boolean(subscriptionType && subscriptionType.trim());
  const apiKeyByAuthMethod = API_KEY_PATTERN.test(authMethod ?? "");
  const isSubscription =
    hasSubscriptionType || (!apiKeyByAuthMethod && SUBSCRIPTION_AUTH_PATTERN.test(authMethod ?? ""));
  const isApiKey = !isSubscription && apiKeyByAuthMethod;

  return { loggedIn, authMethod, apiProvider, subscriptionType, isApiKey, isSubscription };
}

/**
 * Parse `claude auth status --json` stdout into a sanitized status. Returns
 * undefined when the output is not valid JSON (e.g. an error string or a
 * non-JSON build of the CLI), so callers can fall back gracefully.
 */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return sanitizeClaudeAuthStatus(JSON.parse(trimmed));
  } catch {
    // Not JSON output - caller treats Claude auth class as unknown.
    return undefined;
  }
}

export interface ClaudeAutomationGuardInput {
  mode: ClaudeAutomationGuardMode;
  /** Monthly Claude automation spend ceiling in USD. <= 0 disables the threshold. */
  capUsd: number;
  /** Claude automation spend so far this month in USD. */
  monthSpendUsd: number;
  status: ClaudeAuthStatus;
  /** True when the call being evaluated is a Many Heads Mode fanout dispatch. */
  manyHeads: boolean;
}

export interface ClaudeAutomationGuardResult {
  decision: "allow" | "warn" | "block";
  reason: string;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Pure guard decision for a Claude automation dispatch. API-key auth is always
 * allowed (pay-as-you-go is unaffected by the credit pool). For subscription
 * auth, the cap is only a threshold when capUsd > 0; mode decides what happens
 * once monthly Claude spend reaches it.
 */
export function evaluateClaudeAutomationGuard(input: ClaudeAutomationGuardInput): ClaudeAutomationGuardResult {
  const { mode, capUsd, monthSpendUsd, status, manyHeads } = input;

  if (!status.isSubscription) {
    return {
      decision: "allow",
      reason: status.isApiKey
        ? "Claude is on API-key auth (pay-as-you-go); the June 15 Agent SDK credit pool does not apply."
        : "Claude auth is not subscription-backed; the Agent SDK credit guard does not apply.",
    };
  }

  if (mode === "off") {
    return { decision: "allow", reason: "Claude automation credit guard is off." };
  }

  const over = capUsd > 0 && monthSpendUsd >= capUsd;
  if (!over) {
    return {
      decision: "allow",
      reason:
        capUsd > 0
          ? `Claude automation spend ${usd(monthSpendUsd)} is under the ${usd(capUsd)} monthly credit cap.`
          : "No Claude automation credit cap is configured.",
    };
  }

  const plan = status.subscriptionType ? `${status.subscriptionType} subscription` : "subscription";
  const overReason = `Claude is subscription-backed (${plan}); ${usd(monthSpendUsd)} of the ${usd(capUsd)} monthly Agent SDK credit estimate is used.`;

  if (mode === "blockClaudeAutomation") {
    return { decision: "block", reason: `${overReason} Blocking Claude automation until the cap resets or you switch to API-key auth.` };
  }
  if (mode === "blockManyHeads") {
    return manyHeads
      ? { decision: "block", reason: `${overReason} Blocking Many Heads fanout; single Claude turns still run.` }
      : { decision: "warn", reason: overReason };
  }
  // mode === "warn"
  return { decision: "warn", reason: overReason };
}
