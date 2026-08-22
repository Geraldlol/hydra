import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import type { AgentSpawn, RunResult } from "../src/agents";
import {
  CLAUDE_SESSION_CAPABILITY,
  CLAUDE_SESSION_PROTOCOL,
  MIN_CLAUDE_SESSION_VERSION,
  planClaudeSession,
  runClaudeSession,
  type ClaudeSessionPlan,
  type ClaudeSessionRunBinding,
} from "../src/claudeSessionTransport";
import {
  parseClaudeEventStream,
  summarizeClaudeEvents,
  type ClaudeEvent,
} from "../src/claudeEvents";
import type { PersistentAgentProcess } from "../src/persistentAgentProcess";
import {
  STEERING_SCHEMA_VERSION,
  steeringTextMetrics,
  type SteeringProviderAcknowledgement,
  type SteeringProviderRequest,
} from "../src/steeringProtocol";
import {
  SteeringProviderError,
  type LiveActiveSteeringHandle,
} from "../src/steeringController";
import {
  MISSION_SUBMISSION_WRITTEN,
  MissionSubmissionRejectedError,
  type MissionSubmissionGate,
} from "../src/missionDispatch";
import { HANG_NET_TIMEOUT_MS } from "./testBudgets";

const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE = path.join(__dirname, "fixtures", "mock-claude-session-cli.js");
const MISSION_DOCUMENT = "9".repeat(64);
const MISSION_BINDING = "a".repeat(64);
const AUTHORITY = "b".repeat(64);
const INITIAL_PROMPT = "c".repeat(64);
const BINDING: ClaudeSessionRunBinding = {
  callId: "call-claude-session",
  generation: "generation-one",
  ownerId: "owner-one",
  missionDocumentSha256: MISSION_DOCUMENT,
  missionBindingSha256: MISSION_BINDING,
  authoritySha256: AUTHORITY,
};

describe("Claude persistent-session invocation planning", () => {
  test("preserves prepared stream/debug flags and adds the bidirectional contract once", () => {
    const input: AgentSpawn = {
      command: "claude",
      args: [
        "-p",
        "--permission-mode",
        "plan",
        "--ax-screen-reader",
        "--add-dir",
        WORKSPACE_ROOT,
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--debug-file",
        path.join(WORKSPACE_ROOT, ".hydra", "native.log"),
      ],
      cwd: WORKSPACE_ROOT,
      env: { HYDRA_TEST_VALUE: "preserved" },
    };
    const result = planClaudeSession(input);
    assert.equal(result.kind, "supported");
    if (result.kind !== "supported") return;

    assert.deepEqual(
      result.plan.spawn.args.slice(0, input.args.length),
      input.args,
      "the prepared invocation must be a verbatim prefix",
    );
    assert.equal(count(result.plan.spawn.args, "--include-partial-messages"), 1);
    assert.equal(count(result.plan.spawn.args, "--debug-file"), 1);
    assert.equal(count(result.plan.spawn.args, "--output-format"), 1);
    assert.equal(count(result.plan.spawn.args, "--verbose"), 1);
    assert.equal(count(result.plan.spawn.args, "--input-format"), 1);
    assert.equal(count(result.plan.spawn.args, "--replay-user-messages"), 1);
    assert.equal(result.plan.spawn.stdin, "");
    assert.deepEqual(result.plan.spawn.env, input.env);
  });

  test("accepts equals-form dual stream flags without duplicating them", () => {
    const result = planClaudeSession({
      command: "claude",
      args: [
        "--print",
        "--input-format=stream-json",
        "--output-format=stream-json",
        "--verbose",
        "--replay-user-messages",
      ],
      cwd: WORKSPACE_ROOT,
    });
    assert.equal(result.kind, "supported");
    if (result.kind !== "supported") return;
    assert.equal(count(result.plan.spawn.args, "--input-format=stream-json"), 1);
    assert.equal(count(result.plan.spawn.args, "--output-format=stream-json"), 1);
    assert.equal(count(result.plan.spawn.args, "--verbose"), 1);
    assert.equal(count(result.plan.spawn.args, "--replay-user-messages"), 1);
  });

  test("fails closed for non-print, positional, conflicting, structured, unknown, and relative plans", () => {
    const cases: Array<{ args: string[]; cwd?: string; pattern: RegExp }> = [
      { args: ["--permission-mode", "plan"], pattern: /exactly one -p/i },
      { args: ["-p", "prompt in argv"], pattern: /positional prompt/i },
      { args: ["-p", "--output-format", "text"], pattern: /output-format stream-json/i },
      { args: ["-p", "--input-format=json"], pattern: /input-format stream-json/i },
      { args: ["-p", "--json-schema", "{}"], pattern: /cannot preserve --json-schema/i },
      { args: ["-p", "--future-unsafe-flag"], pattern: /does not recognize/i },
      { args: ["-p", "--print"], pattern: /exactly one -p/i },
      { args: ["-p"], cwd: "relative", pattern: /absolute working directory/i },
    ];
    for (const fixture of cases) {
      const result = planClaudeSession({
        command: "claude",
        args: fixture.args,
        cwd: fixture.cwd ?? WORKSPACE_ROOT,
      });
      assert.equal(result.kind, "unsupported", JSON.stringify(fixture.args));
      if (result.kind === "unsupported") assert.match(result.reason, fixture.pattern);
    }
  });
});

describe("Claude persistent-session provider contract", () => {
  test("marks an ambiguous initial stdin write as delivery unknown", async () => {
    let writes = 0;
    const startProcess = (
      _spawn: AgentSpawn,
      timeoutMs: number,
    ): PersistentAgentProcess => {
      let open = true;
      let resolveResult!: (result: RunResult) => void;
      const result = new Promise<RunResult>((resolve) => {
        resolveResult = resolve;
      });
      const finish = (): void => {
        if (!open) return;
        open = false;
        resolveResult({
          stdout: "",
          stderr: "",
          exitCode: null,
          timedOut: false,
          cancelled: false,
          timeoutMs,
        });
      };
      return {
        child: undefined,
        result,
        get inputOpen(): boolean {
          return open;
        },
        async write(): Promise<void> {
          writes++;
          throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        },
        async endInput(): Promise<void> {
          finish();
        },
        terminate(): void {
          finish();
        },
      };
    };

    const result = await runClaudeSession({
      plan: fixturePlan("normal"),
      prompt: "possibly accepted",
      timeoutMs: HANG_NET_TIMEOUT_MS,
      signal: new AbortController().signal,
      binding: BINDING,
      onChunk: () => undefined,
      startProcess,
    });
    assert.equal(writes, 1);
    assert.equal(result.deliveryUnknown, true);
    assert.match(result.stderr, /safe retry boundary/i);
  });

  test("rejects a stale Mission binding before the initial stdin write", async () => {
    let writes = 0;
    let terminated = false;
    const startProcess = (
      _spawn: AgentSpawn,
      timeoutMs: number,
    ): PersistentAgentProcess => {
      let resolveResult!: (result: RunResult) => void;
      const result = new Promise<RunResult>((resolve) => {
        resolveResult = resolve;
      });
      const finish = () => resolveResult({
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        cancelled: false,
        timeoutMs,
      });
      return {
        child: undefined,
        result,
        inputOpen: true,
        async write(): Promise<void> {
          writes++;
        },
        async endInput(): Promise<void> {
          finish();
        },
        terminate(): void {
          terminated = true;
          finish();
        },
      };
    };
    const submissionGate: MissionSubmissionGate = {
      write: async (point) => {
        assert.equal(point, "claude.initial");
        throw new MissionSubmissionRejectedError("Mission binding changed");
      },
    };

    await assert.rejects(
      runClaudeSession({
        plan: fixturePlan("normal"),
        prompt: "must not be written",
        timeoutMs: HANG_NET_TIMEOUT_MS,
        signal: new AbortController().signal,
        binding: BINDING,
        submissionGate,
        onChunk: () => undefined,
        startProcess,
      }),
      MissionSubmissionRejectedError,
    );
    assert.equal(writes, 0);
    assert.equal(terminated, true);
  });

  test("rejects stale queued steering without failing the live Claude session", async () => {
    const allowGate: MissionSubmissionGate = {
      write: async (_point, performWrite) => {
        assert.equal(await performWrite(), MISSION_SUBMISSION_WRITTEN);
      },
    };
    const rejectGate: MissionSubmissionGate = {
      write: async () => {
        throw new MissionSubmissionRejectedError("Mission binding changed");
      },
    };
    const session = startFixtureSession("normal", "initial mission-gated", allowGate);
    const handle = await session.handle;

    await assert.rejects(
      handle.steer(request("stale-steer", 1, "must not be written"), rejectGate),
      MissionSubmissionRejectedError,
    );
    assert.equal((await handle.inspect()).active, true);
    const acknowledgement = await handle.steer(
      request("valid-steer", 2, "valid correction"),
      allowGate,
    ) as SteeringProviderAcknowledgement;
    assertAcknowledged(acknowledgement, "valid-steer", 2);
    const result = await session.result;
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.stdout, /must not be written/);
    assert.match(result.stdout, /valid correction/);
  });

  test("accepts timeout zero as Hydra's uncapped session mode", async () => {
    let handle: LiveActiveSteeringHandle | undefined;
    const result = await runClaudeSession({
      plan: fixturePlan("normal"),
      prompt: "uncapped session",
      timeoutMs: 0,
      signal: new AbortController().signal,
      binding: BINDING,
      onChunk: () => undefined,
      onHandleReady: (published) => {
        handle = published;
      },
    });

    assert.ok(handle);
    assert.equal(result.timeoutMs, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /reply:uncapped session/);
  });

  test("holds stdin open, acknowledges FIFO replays, and aggregates every distinct result", async () => {
    const session = startFixtureSession("normal", "initial work");
    const handle = await session.handle;
    assert.deepEqual(handle.capability, {
      kind: "live",
      delivery: "sameSessionNextTurn",
      protocol: CLAUDE_SESSION_PROTOCOL,
    });
    assert.deepEqual(await handle.inspect(), { ...BINDING, active: true });

    const acknowledgementOrder: number[] = [];
    const first = (handle.steer(
      request("steering-one", 1, "first redirect"),
    ) as Promise<SteeringProviderAcknowledgement>).then((value) => {
      acknowledgementOrder.push(1);
      return value;
    });
    const second = (handle.steer(
      request("steering-two", 2, "second redirect"),
    ) as Promise<SteeringProviderAcknowledgement>).then((value) => {
      acknowledgementOrder.push(2);
      return value;
    });
    const [firstAck, secondAck, result] = await Promise.all([first, second, session.result]);

    assertAcknowledged(firstAck, "steering-one", 1);
    assertAcknowledged(secondAck, "steering-two", 2);
    assert.deepEqual(acknowledgementOrder, [1, 2]);
    assert.notEqual(
      firstAck.status === "acknowledged" ? firstAck.providerReceiptSha256 : "",
      secondAck.status === "acknowledged" ? secondAck.providerReceiptSha256 : "",
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");

    const events = parsedEvents(result.stdout);
    assert.equal(events.filter((event) => event.type === "user").length, 3);
    const resultEvents = events.filter((event) => event.type === "result");
    assert.equal(resultEvents.length, 1, "raw per-turn results must be replaced by one aggregate");
    const aggregate = resultEvents[0]!;
    assert.equal(
      aggregate.result,
      "reply:initial work\n\nreply:first redirect\n\nreply:second redirect",
    );
    assert.equal(aggregate.total_cost_usd, 0.06);
    assert.equal(aggregate.duration_ms, 60);
    assert.equal(aggregate.duration_api_ms, 30);
    assert.equal(aggregate.num_turns, 6);
    assert.deepEqual(aggregate.usage, {
      input_tokens: 6,
      output_tokens: 12,
      cache_read_input_tokens: 18,
      server_tool_use: { web_search_requests: 6 },
      service_tier: "standard",
    });
    assert.deepEqual(aggregate.modelUsage, {
      "claude-mock": {
        inputTokens: 6,
        outputTokens: 12,
        cacheReadInputTokens: 18,
        cacheCreationInputTokens: 24,
        webSearchRequests: 6,
        costUSD: 0.06,
        contextWindow: 200000,
        maxOutputTokens: 64000,
      },
    });

    const summary = summarizeClaudeEvents(parseClaudeEventStream(result.stdout));
    assert.equal(
      summary.lastAssistantText,
      "reply:initial work\n\nreply:first redirect\n\nreply:second redirect",
    );
    assert.deepEqual(summary.usage, aggregate.usage);
    assert.equal(summary.totalCostUsd, 0.06);
    assert.deepEqual(await handle.inspect(), { ...BINDING, active: false });
    await handle.close("completed");
  });

  test("publishes capability when version is absent but the strict lifecycle capability is present", async () => {
    const session = startFixtureSession("capability-no-version", "capability path");
    const handle = await session.handle;
    assert.equal(handle.capability.delivery, "sameSessionNextTurn");
    const result = await session.result;
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.stderr, /protocol failure/i);
  });

  test("rejects a runtime older than the installed/provider contract before publishing a handle", async () => {
    let published = false;
    const result = await runClaudeSession({
      plan: fixturePlan("old-version"),
      prompt: "old runtime",
      timeoutMs: HANG_NET_TIMEOUT_MS,
      signal: new AbortController().signal,
      binding: BINDING,
      onChunk: () => undefined,
      onHandleReady: () => {
        published = true;
      },
    });
    assert.equal(published, false);
    assert.match(result.stderr, new RegExp(`>=${MIN_CLAUDE_SESSION_VERSION.replace(/\./g, "\\.")}`));
    assert.match(result.stderr, new RegExp(CLAUDE_SESSION_CAPABILITY));
    assert.notEqual(result.exitCode, 0);
  });

  test("checks every local binding and does not write a rejected request", async () => {
    const session = startFixtureSession("normal", "binding check");
    const handle = await session.handle;
    const patches: ReadonlyArray<Partial<SteeringProviderRequest["target"]>> = [
      { generation: "other-generation" },
      { ownerId: "other-owner" },
      { missionDocumentSha256: "d".repeat(64) },
      { missionBindingSha256: "d".repeat(64) },
      { authoritySha256: "d".repeat(64) },
    ];
    for (const [index, patch] of patches.entries()) {
      const malformed = request(`wrong-binding-${index}`, index + 1, "must not cross stdin");
      const acknowledgement = await handle.steer({
        ...malformed,
        target: { ...malformed.target, ...patch },
      }) as SteeringProviderAcknowledgement;
      assert.equal(acknowledgement.status, "rejected");
    }
    const result = await session.result;
    const users = parsedEvents(result.stdout).filter((event) => event.type === "user");
    assert.equal(users.length, 1);
    assert.equal(asRecord(users[0]?.message)?.content, "binding check");
  });

  test("names whether an unreconcilable replay was already reconciled or never written", async () => {
    // Both scenarios drive the identical branch - a replay landing with nothing
    // awaiting reconciliation - and until the diagnostic existed they produced
    // the same message for two situations that call for different responses.
    const unsolicited = startFixtureSession("unsolicited-replay", "initial");
    const unsolicitedResult = await unsolicited.result;
    assert.match(unsolicitedResult.stderr, /replayed a user input that Hydra did not write/i);
    assert.match(
      unsolicitedResult.stderr,
      /alreadyReconciled=false/,
      `expected an unknown-uuid diagnostic, got: ${unsolicitedResult.stderr.slice(0, 400)}`,
    );
    // The discriminators a reader needs are all present, not just the verdict.
    assert.match(unsolicitedResult.stderr, /reconciledSoFar=\d+/);
    assert.match(unsolicitedResult.stderr, /writesAwaitingReplay=0/);
    assert.match(unsolicitedResult.stderr, /parentToolUseId=null/);
    // Content is summarised, never echoed: it can carry workspace text.
    assert.match(unsolicitedResult.stderr, /contentSha256Prefix=[0-9a-f]{12}/);
    assert.doesNotMatch(unsolicitedResult.stderr, /never written by hydra/);

    const duplicate = startFixtureSession("duplicate-replay", "initial");
    const duplicateResult = await duplicate.result;
    assert.match(duplicateResult.stderr, /replayed a user input that Hydra did not write/i);
    assert.match(
      duplicateResult.stderr,
      /alreadyReconciled=true/,
      `expected a duplicate-of-our-own-write diagnostic, got: ${duplicateResult.stderr.slice(0, 400)}`,
    );
  });

  test("accepts steering only after an exact replay and never retries an uncertain delivery", async () => {
    const mismatch = startFixtureSession("mismatched-replay", "initial");
    const mismatchHandle = await mismatch.handle;
    await assert.rejects(
      mismatchHandle.steer(request("mismatch", 1, "exact text")),
      (error: unknown) => error instanceof SteeringProviderError
        && error.code === "providerFailure"
        && error.deliveryMayHaveOccurred,
    );
    const mismatchResult = await mismatch.result;
    assert.match(mismatchResult.stderr, /did not exactly match the FIFO input/i);
    assert.equal(
      occurrences(mismatchResult.stdout, "\"content\":\"exact text-changed\""),
      1,
      "a mismatched uncertain write must not be retried",
    );

    let writes = 0;
    const epipe = startInMemoryEpipeSession(() => {
      writes++;
    });
    const epipeHandle = await epipe.handle;
    await assert.rejects(
      epipeHandle.steer(request("epipe", 1, "uncertain pipe write")),
      (error: unknown) => error instanceof SteeringProviderError
        && error.code === "providerFailure"
        && error.deliveryMayHaveOccurred,
    );
    const epipeResult = await epipe.result;
    assert.equal(writes, 2, "one initial write plus exactly one failed steering write");
    assert.match(epipeResult.stderr, /safe retry boundary/i);
  });

  test("waits for a result distinct from replay acceptance and reports early process exit", async () => {
    const session = startFixtureSession("exit-before-result", "accepted then exits");
    const handle = await session.handle;
    assert.equal((await handle.inspect()).active, true);
    const result = await session.result;
    assert.equal(result.exitCode, 17);
    assert.match(result.stderr, /before every accepted input produced a distinct result/i);
    assert.equal((await handle.inspect()).active, false);
  });

  test("preserves the SDK error-result shape and treats a provider error as a failed run", async () => {
    const session = startFixtureSession("error-result", "initial succeeds");
    const handle = await session.handle;
    const acknowledgement = await handle.steer(
      request("error-turn", 1, "second turn errors"),
    ) as SteeringProviderAcknowledgement;
    assertAcknowledged(acknowledgement, "error-turn", 1);

    const result = await session.result;
    assert.notEqual(result.exitCode, 0);
    const aggregate = parsedEvents(result.stdout).find((event) => event.type === "result");
    assert.equal(aggregate?.subtype, "error_during_execution");
    assert.equal(aggregate?.is_error, true);
    assert.equal(Object.prototype.hasOwnProperty.call(aggregate ?? {}, "result"), false);
    assert.deepEqual(aggregate?.errors, ["fixture execution error"]);
  });

  test("fails closed on malformed JSONL, oversized lines, result-before-replay, and malformed results", async (t) => {
    for (const [scenario, pattern] of [
      ["malformed-output", /malformed non-empty stream-json/i],
      ["oversized-output", /oversized or excessively dense/i],
      ["result-before-replay", /without a matching accepted user input/i],
      ["malformed-result", /malformed result envelope|distinct provider UUID/i],
    ] as const) {
      await t.test(scenario, async () => {
        const result = await runClaudeSession({
          plan: fixturePlan(scenario),
          prompt: "adversarial output",
          timeoutMs: HANG_NET_TIMEOUT_MS,
          signal: new AbortController().signal,
          binding: BINDING,
          onChunk: () => undefined,
        });
        assert.match(result.stderr, pattern);
        assert.notEqual(result.exitCode, 0);
      });
    }
  });

  test("close fences new steering and cancellation uses the one process lifecycle", async () => {
    const session = startFixtureSession("normal", "cancel me");
    const handle = await session.handle;
    await handle.close("cancelled");
    assert.equal((await handle.inspect()).active, false);
    await assert.rejects(
      handle.steer(request("after-close", 1, "must not send")),
      (error: unknown) => error instanceof SteeringProviderError
        && error.code === "processExit"
        && !error.deliveryMayHaveOccurred,
    );
    const result = await session.result;
    assert.match(result.stderr, /closed as cancelled/i);
  });

  test("cancellation rejects an in-flight replay wait before draining the FIFO tail", async () => {
    const session = startFixtureSession("no-steering-replay", "initial succeeds");
    const handle = await session.handle;
    const steering = handle.steer(request("pending-replay", 1, "never replayed"));
    const steeringRejected = assert.rejects(
      steering,
      (error: unknown) => error instanceof SteeringProviderError
        && error.code === "processExit",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    await Promise.race([
      handle.close("cancelled"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("cancel waited for the replay tail")), 1_000)
      ),
    ]);
    await steeringRejected;
    const result = await session.result;
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /closed as cancelled/i);
  });
});

function startFixtureSession(
  scenario: string,
  prompt: string,
  submissionGate?: MissionSubmissionGate,
): {
  readonly handle: Promise<LiveActiveSteeringHandle>;
  readonly result: Promise<RunResult>;
} {
  let resolveHandle!: (handle: LiveActiveSteeringHandle) => void;
  const handle = new Promise<LiveActiveSteeringHandle>((resolve) => {
    resolveHandle = resolve;
  });
  const result = runClaudeSession({
    plan: fixturePlan(scenario),
    prompt,
    timeoutMs: HANG_NET_TIMEOUT_MS,
    signal: new AbortController().signal,
    binding: BINDING,
    ...(submissionGate ? { submissionGate } : {}),
    onChunk: () => undefined,
    onHandleReady: resolveHandle,
  });
  return { handle, result };
}

function fixturePlan(scenario: string): ClaudeSessionPlan {
  const planned = planClaudeSession({
    command: "claude",
    args: [
      "-p",
      "--permission-mode",
      "plan",
      "--include-partial-messages",
      "--debug-file",
      path.join(WORKSPACE_ROOT, ".hydra", "fixture-debug.log"),
    ],
    cwd: WORKSPACE_ROOT,
  });
  assert.equal(planned.kind, "supported");
  if (planned.kind !== "supported") throw new Error("Fixture Claude plan was unexpectedly unsupported.");
  return {
    spawn: {
      ...planned.plan.spawn,
      command: process.execPath,
      args: [FIXTURE, ...planned.plan.spawn.args],
      env: { HYDRA_MOCK_CLAUDE_SCENARIO: scenario },
    },
  };
}

function request(steeringId: string, sequence: number, text: string): SteeringProviderRequest {
  const metrics = steeringTextMetrics(text);
  return {
    schemaVersion: STEERING_SCHEMA_VERSION,
    steeringId,
    source: "localUser",
    intent: "steer",
    text,
    textSha256: metrics.sha256,
    textCharacters: metrics.characters,
    textBytes: metrics.bytes,
    target: {
      callId: BINDING.callId,
      generation: BINDING.generation,
      agentId: "claude",
      roomTurnId: "room-turn-one",
      sequence,
      expectedDelivery: "sameSessionNextTurn",
      missionDocumentSha256: BINDING.missionDocumentSha256,
      missionBindingSha256: BINDING.missionBindingSha256,
      authoritySha256: BINDING.authoritySha256,
      initialPromptSha256: INITIAL_PROMPT,
      ownerId: BINDING.ownerId,
      workClass: "discussion",
    },
  };
}

function assertAcknowledged(
  acknowledgement: SteeringProviderAcknowledgement,
  steeringId: string,
  sequence: number,
): void {
  assert.equal(acknowledgement.status, "acknowledged");
  if (acknowledgement.status !== "acknowledged") return;
  assert.equal(acknowledgement.steeringId, steeringId);
  assert.equal(acknowledgement.sequence, sequence);
  assert.equal(acknowledgement.missionDocumentSha256, BINDING.missionDocumentSha256);
  assert.equal(acknowledgement.missionBindingSha256, BINDING.missionBindingSha256);
  assert.equal(acknowledgement.delivery, "sameSessionNextTurn");
  assert.match(acknowledgement.providerReceiptSha256, /^[a-f0-9]{64}$/);
}

function parsedEvents(stdout: string): ClaudeEvent[] {
  return parseClaudeEventStream(stdout).filter(
    (event): event is ClaudeEvent => event !== null,
  );
}

function startInMemoryEpipeSession(onWrite: () => void): {
  readonly handle: Promise<LiveActiveSteeringHandle>;
  readonly result: Promise<RunResult>;
} {
  let resolveHandle!: (handle: LiveActiveSteeringHandle) => void;
  const handle = new Promise<LiveActiveSteeringHandle>((resolve) => {
    resolveHandle = resolve;
  });
  let writeCount = 0;
  const startProcess = (
    _spawn: AgentSpawn,
    timeoutMs: number,
    onChunk: (chunk: string) => void,
    _signal: AbortSignal,
  ): PersistentAgentProcess => {
    let open = true;
    let resolveResult!: (result: RunResult) => void;
    const result = new Promise<RunResult>((resolve) => {
      resolveResult = resolve;
    });
    const finish = (): void => {
      if (!open) return;
      open = false;
      resolveResult({
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        cancelled: false,
        timeoutMs,
      });
    };
    return {
      child: undefined,
      result,
      get inputOpen(): boolean {
        return open;
      },
      async write(data: string): Promise<void> {
        writeCount++;
        onWrite();
        if (writeCount === 1) {
          const envelope = JSON.parse(data) as Record<string, unknown>;
          const content = asRecord(envelope.message)?.content;
          onChunk([
            JSON.stringify({
              type: "system",
              subtype: "init",
              cwd: WORKSPACE_ROOT,
              session_id: "44444444-4444-4444-8444-444444444444",
              claude_code_version: "2.1.218",
              capabilities: ["msg_lifecycle_v1"],
              uuid: "55555555-5555-4555-8555-555555555551",
            }),
            JSON.stringify({
              type: "user",
              message: { role: "user", content },
              parent_tool_use_id: null,
              session_id: "44444444-4444-4444-8444-444444444444",
              isReplay: true,
              uuid: envelope.uuid,
            }),
            "",
          ].join("\n"));
          return;
        }
        const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        throw error;
      },
      async endInput(): Promise<void> {
        finish();
      },
      terminate(): void {
        finish();
      },
    };
  };
  const planned = planClaudeSession({
    command: "claude",
    args: ["-p"],
    cwd: WORKSPACE_ROOT,
  });
  assert.equal(planned.kind, "supported");
  if (planned.kind !== "supported") throw new Error("In-memory Claude plan was unexpectedly unsupported.");
  const result = runClaudeSession({
    plan: planned.plan,
    prompt: "initial in-memory",
    timeoutMs: HANG_NET_TIMEOUT_MS,
    signal: new AbortController().signal,
    binding: BINDING,
    onChunk: () => undefined,
    onHandleReady: resolveHandle,
    startProcess,
  });
  return { handle, result };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function count(values: readonly string[], target: string): number {
  return values.filter((value) => value === target).length;
}

function occurrences(value: string, needle: string): number {
  let count = 0;
  let cursor = 0;
  while ((cursor = value.indexOf(needle, cursor)) >= 0) {
    count++;
    cursor += needle.length;
  }
  return count;
}
