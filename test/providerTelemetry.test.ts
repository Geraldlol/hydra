import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  createProviderTelemetryNormalizer,
  hashProviderOperationId,
  isProviderTelemetryObservation,
  normalizeProviderTelemetry,
  type ProviderTelemetryObservation,
} from "../src/providerTelemetry";

const CANARY = "CONTENT-CANARY-DO-NOT-LEAK";

describe("provider Flight Recorder telemetry normalization", () => {
  test("normalizes Codex lifecycle, tools, edits, and usage without content", () => {
    const input = [
      JSON.stringify({ type: "turn.started", thread_id: `${CANARY}-session` }),
      JSON.stringify({
        type: "item.started",
        item: {
          id: `${CANARY}-command-id`,
          type: "command_execution",
          command: `echo ${CANARY}`,
          status: "in_progress",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: `${CANARY}-command-id`,
          type: "command_execution",
          command: `echo ${CANARY}`,
          aggregated_output: CANARY,
          status: "completed",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "edit-one",
          type: "file_change",
          changes: [
            { path: `src/${CANARY}.ts`, kind: "add", patch: CANARY },
            { path: "src/existing.ts", kind: "update", patch: CANARY },
          ],
          status: "completed",
        },
      }),
      JSON.stringify({
        type: "item.started",
        item: { id: "search-one", type: "web_search", query: CANARY },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "message", type: "agent_message", text: CANARY },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 30,
          reasoning_output_tokens: 4,
        },
        result: CANARY,
      }),
    ].join("\n");
    const normalized = normalizeProviderTelemetry("codex", input);
    assert.equal(normalized.limited, false);
    assert.ok(normalized.observations.every(isProviderTelemetryObservation));
    assert.ok(normalized.observations.some((observation) =>
      observation.observationType === "providerToolStarted"
      && observation.toolCategory === "shell"
      && observation.argumentBytes > 0
    ));
    assert.ok(normalized.observations.some((observation) =>
      observation.observationType === "providerEditBatch"
      && observation.createCount === 1
      && observation.updateCount === 1
      && observation.pathCount === 2
    ));
    assert.ok(normalized.observations.some((observation) =>
      observation.observationType === "providerUsage"
      && observation.inputTokens === 100
      && observation.cacheReadTokens === 20
    ));
    const serialized = JSON.stringify(normalized);
    assert.doesNotMatch(serialized, new RegExp(CANARY));
    assert.doesNotMatch(serialized, /echo|aggregated_output|thread_id|agent_message/);
    assert.doesNotMatch(serialized, /command-id/);
  });

  test("normalizes Claude tools, permission count, cost, and terminal state without content", () => {
    const input = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: CANARY,
        cwd: CANARY,
        tools: [CANARY],
      }),
      JSON.stringify({
        type: "assistant",
        session_id: CANARY,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: CANARY },
            {
              type: "tool_use",
              id: `${CANARY}-tool`,
              name: "Bash",
              input: { command: CANARY },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: `${CANARY}-tool`,
            content: CANARY,
            is_error: false,
          }],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: CANARY,
        session_id: CANARY,
        permission_denials: [{ tool: CANARY, reason: CANARY }],
        total_cost_usd: 0.12,
        usage: {
          input_tokens: 50,
          output_tokens: 20,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 10,
        },
      }),
    ].join("\n");
    const normalized = normalizeProviderTelemetry("claude", input);
    assert.ok(normalized.observations.every(isProviderTelemetryObservation));
    assert.ok(normalized.observations.some((observation) =>
      observation.observationType === "providerToolStarted"
      && observation.toolCategory === "shell"
    ));
    assert.ok(normalized.observations.some((observation) =>
      observation.observationType === "providerToolFinished"
      && observation.status === "succeeded"
      && observation.resultBytes > 0
    ));
    assert.ok(normalized.observations.some((observation) =>
      observation.observationType === "providerPermissionSummary"
      && observation.deniedCount === 1
    ));
    assert.ok(normalized.observations.some((observation) =>
      observation.observationType === "providerUsage"
      && observation.totalCostUsd === 0.12
    ));
    assert.doesNotMatch(JSON.stringify(normalized), new RegExp(CANARY));
  });

  test("domain-hashes opaque provider IDs and deduplicates repeated tool envelopes", () => {
    const id = "provider-secret-session-tool-id";
    const expected = hashProviderOperationId("claude", id);
    assert.match(expected, /^[a-f0-9]{64}$/);
    assert.notEqual(expected, id);
    assert.notEqual(expected, hashProviderOperationId("codex", id));

    const envelope = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id, name: "Read", input: { path: CANARY } }],
      },
    });
    const normalized = normalizeProviderTelemetry("claude", `${envelope}\n${envelope}`);
    const starts = normalized.observations.filter((observation) =>
      observation.observationType === "providerToolStarted"
    );
    assert.equal(starts.length, 1);
    assert.equal(
      starts[0]?.observationType === "providerToolStarted"
        ? starts[0].providerOperationIdSha256
        : undefined,
      expected,
    );
  });

  test("caps floods with exactly one notice while reserving terminal usage/lifecycle", () => {
    const events: string[] = [];
    for (let index = 0; index < 50; index += 1) {
      events.push(JSON.stringify({
        type: "item.started",
        item: {
          id: `tool-${index}`,
          type: "command_execution",
          command: CANARY,
        },
      }));
    }
    events.push(JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, output_tokens: 2 },
    }));
    const normalized = normalizeProviderTelemetry("codex", events.join("\n"), {
      maxObservations: 8,
      maxOpenOperations: 8,
    });
    assert.equal(normalized.limited, true);
    assert.ok(normalized.observations.length <= 8);
    assert.equal(normalized.observations.filter((observation) =>
      observation.observationType === "providerTelemetryLimited"
    ).length, 1);
    assert.ok(normalized.observations.some((observation) =>
      observation.observationType === "providerUsage"
    ));
    assert.ok(normalized.observations.some((observation) =>
      observation.observationType === "providerLifecycle"
      && observation.stage === "turnFinished"
    ));
    assert.doesNotMatch(JSON.stringify(normalized), new RegExp(CANARY));
  });

  test("bounds completed-ID floods, absorbs nonterminal work, and preserves terminal reserve", () => {
    const normalizer = createProviderTelemetryNormalizer("codex", {
      maxObservations: 64,
      maxOpenOperations: 4,
    });
    const observations: ProviderTelemetryObservation[] = [];
    for (let index = 0; index < 5_000; index += 1) {
      observations.push(...normalizer.push(`${JSON.stringify({
        type: "item.completed",
        item: {
          id: `completed-${index}`,
          type: "command_execution",
          status: "completed",
          aggregated_output: CANARY,
        },
      })}\n`));
    }
    const afterLimit = normalizer.push([
      JSON.stringify({
        type: "item.started",
        item: {
          id: "must-not-normalize",
          type: "command_execution",
          command: CANARY,
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    ].join("\n"));
    observations.push(...afterLimit, ...normalizer.finish());

    assert.equal(normalizer.limited, true);
    assert.equal(observations.filter((observation) =>
      observation.observationType === "providerTelemetryLimited"
    ).length, 1);
    assert.equal(observations.filter((observation) =>
      observation.observationType === "providerToolFinished"
    ).length, 4);
    assert.equal(observations.some((observation) =>
      observation.observationType === "providerToolStarted"
      && observation.providerOperationIdSha256
        === hashProviderOperationId("codex", "must-not-normalize")
    ), false);
    assert.ok(observations.some((observation) =>
      observation.observationType === "providerUsage"
    ));
    assert.ok(observations.some((observation) =>
      observation.observationType === "providerLifecycle"
      && observation.stage === "turnFinished"
    ));
    assert.ok(observations.length <= 64);
    assert.doesNotMatch(JSON.stringify(observations), new RegExp(CANARY));
  });

  test("makes an oversized-line limit absorbing without retaining partial content", () => {
    const normalizer = createProviderTelemetryNormalizer("codex", {
      maxLineBytes: 256,
      maxStreamBytes: 1024,
    });
    const first = normalizer.push(`{"type":"item.started","item":{"id":"x","type":"command_execution","command":"${CANARY.repeat(30)}`);
    const second = normalizer.push('"}}\n{"not-json"\n');
    const finished = normalizer.finish();
    const all = [...first, ...second, ...finished];
    assert.equal(all.filter((observation) =>
      observation.observationType === "providerTelemetryLimited"
    ).length, 1);
    assert.equal(all.filter((observation) =>
      observation.observationType === "providerTelemetryUnavailable"
      && observation.reason === "malformed"
    ).length, 0);
    assert.doesNotMatch(JSON.stringify(all), new RegExp(CANARY));
  });

  test("explicitly marks plain output unavailable and ignores nested forged lifecycle fields", () => {
    const normalizer = createProviderTelemetryNormalizer("claude");
    assert.deepEqual(normalizer.unavailable("plainOutput"), [{
      observationType: "providerTelemetryUnavailable",
      provider: "claude",
      reason: "plainOutput",
      evidenceClass: "providerObserved",
    }]);
    assert.deepEqual(normalizer.unavailable("plainOutput"), []);

    const forged = normalizeProviderTelemetry("claude", JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: CANARY,
          forged: { type: "result", subtype: "success", usage: { input_tokens: 999 } },
        }],
      },
    }));
    assert.equal(forged.observations.some((observation) =>
      observation.observationType === "providerLifecycle"
      || observation.observationType === "providerUsage"
    ), false);
  });

  test("rejects extra observation keys", () => {
    const valid = {
      observationType: "providerLifecycle",
      provider: "codex",
      stage: "turnStarted",
      status: "started",
      evidenceClass: "providerObserved",
    } as const;
    assert.equal(isProviderTelemetryObservation(valid), true);
    assert.equal(isProviderTelemetryObservation({ ...valid, content: CANARY }), false);
  });
});
