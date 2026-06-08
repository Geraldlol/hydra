import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  sanitizeClaudeAuthStatus,
  parseClaudeAuthStatus,
  evaluateClaudeAutomationGuard,
  CLAUDE_AUTH_STATUS_PROBE_ARGS,
} from "../src/claudeAuth";

// Why: this machine's real `claude auth status` JSON shape, captured during the
// Milestone 0 discussion. The four safe fields plus the three sensitive ones.
const REAL_SUBSCRIPTION_STATUS = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "anthropic",
  subscriptionType: "Team",
  email: "gmaida@peerstarllc.com",
  orgId: "org_0123456789",
  orgName: "Peerstar LLC",
};

describe("sanitizeClaudeAuthStatus", () => {
  test("keeps only the four safe scalar fields and drops email/orgId/orgName", () => {
    const safe = sanitizeClaudeAuthStatus(REAL_SUBSCRIPTION_STATUS);
    assert.equal(safe.loggedIn, true);
    assert.equal(safe.authMethod, "claude.ai");
    assert.equal(safe.apiProvider, "anthropic");
    assert.equal(safe.subscriptionType, "Team");
    // The sensitive identifiers must never survive capture-time sanitization.
    assert.equal(Object.prototype.hasOwnProperty.call(safe, "email"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(safe, "orgId"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(safe, "orgName"), false);
    const serialized = JSON.stringify(safe);
    assert.equal(serialized.includes("gmaida@peerstarllc.com"), false);
    assert.equal(serialized.includes("Peerstar"), false);
    assert.equal(serialized.includes("org_0123456789"), false);
  });

  test("flags a claude.ai login as subscription-backed, not api-key", () => {
    const safe = sanitizeClaudeAuthStatus(REAL_SUBSCRIPTION_STATUS);
    assert.equal(safe.isSubscription, true);
    assert.equal(safe.isApiKey, false);
  });

  test("flags an API-key login as api-key, not subscription", () => {
    const safe = sanitizeClaudeAuthStatus({
      loggedIn: true,
      authMethod: "apiKey",
      apiProvider: "anthropic",
    });
    assert.equal(safe.isApiKey, true);
    assert.equal(safe.isSubscription, false);
  });

  test("treats a non-empty subscriptionType as subscription even without a known authMethod", () => {
    const safe = sanitizeClaudeAuthStatus({ loggedIn: true, subscriptionType: "Max" });
    assert.equal(safe.isSubscription, true);
    assert.equal(safe.isApiKey, false);
  });

  test("a populated subscriptionType outranks an apiKey-looking authMethod (guard must not skip a real subscription)", () => {
    const safe = sanitizeClaudeAuthStatus({
      loggedIn: true,
      authMethod: "apiKey via claude.ai", // ambiguous free-text that matches the apiKey regex
      subscriptionType: "Team",
    });
    assert.equal(safe.isSubscription, true);
    assert.equal(safe.isApiKey, false);
  });

  test("ignores unknown fields and wrong-typed values", () => {
    const safe = sanitizeClaudeAuthStatus({
      loggedIn: "yes", // not a boolean -> dropped
      authMethod: 42, // not a string -> dropped
      subscriptionType: "Pro",
      somethingElse: { nested: true },
    });
    assert.equal(safe.loggedIn, undefined);
    assert.equal(safe.authMethod, undefined);
    assert.equal(safe.subscriptionType, "Pro");
    assert.equal(Object.prototype.hasOwnProperty.call(safe, "somethingElse"), false);
  });

  test("returns an empty, non-subscription status for non-object input", () => {
    for (const bad of [null, undefined, "string", 7, [1, 2, 3]]) {
      const safe = sanitizeClaudeAuthStatus(bad);
      assert.equal(safe.isSubscription, false);
      assert.equal(safe.isApiKey, false);
      assert.equal(safe.loggedIn, undefined);
    }
  });
});

describe("CLAUDE_AUTH_STATUS_PROBE_ARGS", () => {
  test("probes auth status in JSON so the sanitized parser has structured fields", () => {
    // Slice 3 spawns `claude auth status --json` and feeds stdout to
    // parseClaudeAuthStatus. Pinning the argv keeps the probe and the parser
    // (which assumes JSON) in lockstep.
    assert.deepEqual([...CLAUDE_AUTH_STATUS_PROBE_ARGS], ["auth", "status", "--json"]);
  });
});

describe("evaluateClaudeAutomationGuard fail-open on unknown auth", () => {
  test("an unparseable/failed auth probe is treated as non-subscription and allowed", () => {
    // Why: Slice 3's dispatch wiring passes an empty status when
    // `claude auth status --json` cannot be parsed (binary missing, flag
    // unsupported, timeout). That MUST resolve to allow - a probe hiccup must
    // never strand a legitimate Claude turn, even in the hardest block mode
    // over the cap. The cost guard only engages on a *confirmed* subscription.
    const unknown = sanitizeClaudeAuthStatus(undefined);
    const result = evaluateClaudeAutomationGuard({
      mode: "blockClaudeAutomation",
      capUsd: 200,
      monthSpendUsd: 99999,
      status: unknown,
      manyHeads: true,
    });
    assert.equal(result.decision, "allow");
  });
});

describe("parseClaudeAuthStatus", () => {
  test("parses clean JSON stdout into a sanitized status", () => {
    const status = parseClaudeAuthStatus(JSON.stringify(REAL_SUBSCRIPTION_STATUS));
    assert.ok(status);
    assert.equal(status?.isSubscription, true);
    assert.equal(JSON.stringify(status).includes("gmaida"), false);
  });

  test("returns undefined for unparseable output", () => {
    assert.equal(parseClaudeAuthStatus("not json at all"), undefined);
    assert.equal(parseClaudeAuthStatus(""), undefined);
  });
});

describe("evaluateClaudeAutomationGuard", () => {
  const subscription = sanitizeClaudeAuthStatus(REAL_SUBSCRIPTION_STATUS);
  const apiKey = sanitizeClaudeAuthStatus({ loggedIn: true, authMethod: "apiKey" });

  test("allows API-key auth regardless of spend or mode", () => {
    const result = evaluateClaudeAutomationGuard({
      mode: "blockClaudeAutomation",
      capUsd: 200,
      monthSpendUsd: 5000,
      status: apiKey,
      manyHeads: true,
    });
    assert.equal(result.decision, "allow");
    assert.match(result.reason, /pay-as-you-go|api/i);
  });

  test("mode off always allows even when over cap", () => {
    const result = evaluateClaudeAutomationGuard({
      mode: "off",
      capUsd: 200,
      monthSpendUsd: 5000,
      status: subscription,
      manyHeads: false,
    });
    assert.equal(result.decision, "allow");
  });

  test("warn mode allows under cap and warns at/over cap", () => {
    const under = evaluateClaudeAutomationGuard({
      mode: "warn",
      capUsd: 200,
      monthSpendUsd: 50,
      status: subscription,
      manyHeads: false,
    });
    assert.equal(under.decision, "allow");

    const over = evaluateClaudeAutomationGuard({
      mode: "warn",
      capUsd: 200,
      monthSpendUsd: 250,
      status: subscription,
      manyHeads: false,
    });
    assert.equal(over.decision, "warn");
    assert.match(over.reason, /200/);

    // Pin the inclusive >= boundary the docs call "reaches the cap": spend EXACTLY
    // at the cap must warn. Guards against a silent >= -> > regression.
    const atCap = evaluateClaudeAutomationGuard({
      mode: "warn",
      capUsd: 200,
      monthSpendUsd: 200,
      status: subscription,
      manyHeads: false,
    });
    assert.equal(atCap.decision, "warn");
  });

  test("blocks at exactly the cap, not only over it (inclusive >= boundary)", () => {
    const atCap = evaluateClaudeAutomationGuard({
      mode: "blockClaudeAutomation",
      capUsd: 200,
      monthSpendUsd: 200,
      status: subscription,
      manyHeads: false,
    });
    assert.equal(atCap.decision, "block");
  });

  test("blockManyHeads blocks fanout over cap but only warns a normal turn", () => {
    const fanout = evaluateClaudeAutomationGuard({
      mode: "blockManyHeads",
      capUsd: 200,
      monthSpendUsd: 250,
      status: subscription,
      manyHeads: true,
    });
    assert.equal(fanout.decision, "block");

    const normal = evaluateClaudeAutomationGuard({
      mode: "blockManyHeads",
      capUsd: 200,
      monthSpendUsd: 250,
      status: subscription,
      manyHeads: false,
    });
    assert.equal(normal.decision, "warn");
  });

  test("blockClaudeAutomation blocks every subscription turn over cap", () => {
    const result = evaluateClaudeAutomationGuard({
      mode: "blockClaudeAutomation",
      capUsd: 200,
      monthSpendUsd: 250,
      status: subscription,
      manyHeads: false,
    });
    assert.equal(result.decision, "block");
  });

  test("cap of 0 disables the threshold so nothing warns or blocks", () => {
    const result = evaluateClaudeAutomationGuard({
      mode: "blockClaudeAutomation",
      capUsd: 0,
      monthSpendUsd: 99999,
      status: subscription,
      manyHeads: true,
    });
    assert.equal(result.decision, "allow");
  });
});
