import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { AGENT_OUTPUT_IDLE_WARNING_MS, formatPendingAgentActivity } from "../src/agentActivity";

describe("agent activity text", () => {
  test("shows an explicit wall-clock timeout when a positive cap is configured", () => {
    assert.equal(
      formatPendingAgentActivity({
        agentLabel: "Codex",
        phase: "build",
        elapsedMs: 65_000,
        timeoutMs: 600_000,
        outputIdleMs: 10_000,
      }),
      "Codex is still running build (1m 05s; timeout 10m 00s). Use Stop current turn if this is not useful."
    );
  });

  test("zero timeout is rendered as uncapped rather than timeout 0s", () => {
    const text = formatPendingAgentActivity({
      agentLabel: "Claude",
      phase: "parallel",
      elapsedMs: 30_000,
      timeoutMs: 0,
      outputIdleMs: 30_000,
    });
    assert.match(text, /no wall-clock timeout/);
    assert.doesNotMatch(text, /timeout 0s/);
  });

  test("warns when an uncapped call has produced no output for the idle threshold", () => {
    assert.equal(
      formatPendingAgentActivity({
        agentLabel: "Claude",
        phase: "review",
        elapsedMs: 180_000,
        timeoutMs: 0,
        outputIdleMs: AGENT_OUTPUT_IDLE_WARNING_MS,
      }),
      "Claude is still running review (3m 00s; no wall-clock timeout). No output for 2m 00s; use Stop current turn if it looks stuck."
    );
  });
});
