import type { AgentId } from "./phases";
import type { AuthorityLevel } from "./authority";

export const FULL_NATIVE_CONSENT_RUN_ONCE = "Run once";
export const FULL_NATIVE_CONSENT_ALWAYS = "Always for this workspace";
export const FULL_NATIVE_CONSENT_CANCEL = "Cancel";

export type FullNativeConsentDecision =
  | { kind: "allow"; reason: "notFullNative" | "previouslyConsented" }
  | { kind: "needsConsent"; agent: AgentId };

export interface EvaluateFullNativeConsentInput {
  agent: AgentId;
  authorityLevel: AuthorityLevel;
  alreadyConsented: boolean;
}

// Pure decider: should this call be allowed to proceed without a modal,
// or do we need to ask the user first? Per-agent consent is tracked by
// the caller (Panel persists to workspaceState); this function only
// makes the policy decision so it can be unit-tested without VS Code.
export function evaluateFullNativeConsent(input: EvaluateFullNativeConsentInput): FullNativeConsentDecision {
  if (input.authorityLevel !== "fullNative") {
    return { kind: "allow", reason: "notFullNative" };
  }
  if (input.alreadyConsented) {
    return { kind: "allow", reason: "previouslyConsented" };
  }
  return { kind: "needsConsent", agent: input.agent };
}

export type FullNativeConsentResolution =
  | { kind: "allow"; persist: boolean }
  | { kind: "deny"; persist: false };

// Map the modal's button label back to a (allow|deny, persist) decision.
// Undefined covers the case where the user dismisses the dialog with Esc;
// any unrecognized label is treated as deny to keep this fail-closed.
export function resolveFullNativeConsentChoice(choice: string | undefined): FullNativeConsentResolution {
  if (choice === FULL_NATIVE_CONSENT_ALWAYS) return { kind: "allow", persist: true };
  if (choice === FULL_NATIVE_CONSENT_RUN_ONCE) return { kind: "allow", persist: false };
  return { kind: "deny", persist: false };
}

export function fullNativeConsentKey(agent: AgentId): string {
  return `hydraRoom.fullNativeConfirmed.${agent}`;
}
