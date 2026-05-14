import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import type { AgentId } from "../src/phases";
import {
  evaluateFullNativeConsent,
  resolveFullNativeConsentChoice,
  fullNativeConsentKey,
  FULL_NATIVE_CONSENT_RUN_ONCE,
  FULL_NATIVE_CONSENT_ALWAYS,
  FULL_NATIVE_CONSENT_CANCEL,
} from "../src/fullNativeConsent";

describe("evaluateFullNativeConsent", () => {
  test("allows non-fullNative authority without prompting", () => {
    for (const level of ["readOnly", "workspaceWrite", "unknown"] as const) {
      const decision = evaluateFullNativeConsent({
        agent: "codex",
        authorityLevel: level,
        alreadyConsented: false,
      });
      assert.equal(decision.kind, "allow");
      if (decision.kind === "allow") {
        assert.equal(decision.reason, "notFullNative");
      }
    }
  });

  test("allows fullNative without prompting when this agent already consented", () => {
    const decision = evaluateFullNativeConsent({
      agent: "claude",
      authorityLevel: "fullNative",
      alreadyConsented: true,
    });
    assert.equal(decision.kind, "allow");
    if (decision.kind === "allow") {
      assert.equal(decision.reason, "previouslyConsented");
    }
  });

  test("requires consent for fullNative when no prior consent recorded", () => {
    const decision = evaluateFullNativeConsent({
      agent: "claude",
      authorityLevel: "fullNative",
      alreadyConsented: false,
    });
    assert.equal(decision.kind, "needsConsent");
    if (decision.kind === "needsConsent") {
      assert.equal(decision.agent, "claude");
    }
  });

  test("tracks consent independently per agent", () => {
    // Codex consented does not unlock Claude.
    const claudeDecision = evaluateFullNativeConsent({
      agent: "claude",
      authorityLevel: "fullNative",
      alreadyConsented: false,
    });
    assert.equal(claudeDecision.kind, "needsConsent");

    // Claude consented does not unlock Codex.
    const codexDecision = evaluateFullNativeConsent({
      agent: "codex",
      authorityLevel: "fullNative",
      alreadyConsented: false,
    });
    assert.equal(codexDecision.kind, "needsConsent");
  });
});

describe("resolveFullNativeConsentChoice", () => {
  test("Run once allows the call but does not persist", () => {
    const result = resolveFullNativeConsentChoice(FULL_NATIVE_CONSENT_RUN_ONCE);
    assert.deepEqual(result, { kind: "allow", persist: false });
  });

  test("Always allows the call and persists", () => {
    const result = resolveFullNativeConsentChoice(FULL_NATIVE_CONSENT_ALWAYS);
    assert.deepEqual(result, { kind: "allow", persist: true });
  });

  test("Cancel denies the call", () => {
    const result = resolveFullNativeConsentChoice(FULL_NATIVE_CONSENT_CANCEL);
    assert.deepEqual(result, { kind: "deny", persist: false });
  });

  test("dismissed modal (undefined) denies the call", () => {
    // VS Code's showWarningMessage resolves to undefined when the user
    // dismisses the dialog without picking an action. Default to deny so
    // an accidental Esc never silently runs a fullNative call.
    const result = resolveFullNativeConsentChoice(undefined);
    assert.deepEqual(result, { kind: "deny", persist: false });
  });

  test("unknown label denies the call", () => {
    const result = resolveFullNativeConsentChoice("Something Else");
    assert.deepEqual(result, { kind: "deny", persist: false });
  });
});

describe("fullNativeConsentKey", () => {
  test("returns a stable per-agent workspaceState key", () => {
    const codex: AgentId = "codex";
    const claude: AgentId = "claude";
    assert.equal(fullNativeConsentKey(codex), "hydraRoom.fullNativeConfirmed.codex");
    assert.equal(fullNativeConsentKey(claude), "hydraRoom.fullNativeConfirmed.claude");
  });
});
