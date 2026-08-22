import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  CodexAppServerFallbackError,
  planCodexAppServer,
  runCodexAppServerTurn,
  type CodexAppServerPlan,
  type CodexAppServerRunBinding,
} from "../src/codexAppServerTransport";
import {
  STEERING_SCHEMA_VERSION,
  isSteeringProviderAcknowledgement,
  sha256Utf8,
  type SteeringProviderRequest,
} from "../src/steeringProtocol";
import type { LiveActiveSteeringHandle } from "../src/steeringController";
import { createLiveTextExtractor } from "../src/liveText";
import {
  MISSION_SUBMISSION_WRITTEN,
  MissionSubmissionRejectedError,
  type MissionSubmissionGate,
} from "../src/missionDispatch";
import { HANG_NET_TIMEOUT_MS } from "./testBudgets";

const FAKE_APP_SERVER = path.join(__dirname, "fixtures", "fake-codex-app-server.js");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function codexSpawn(args: string[], cwd = path.resolve("C:\\repo")) {
  return { command: "codex", args, cwd, env: { HYDRA_TEST: "yes" } };
}

function binding(): CodexAppServerRunBinding {
  return {
    callId: "call-1",
    generation: "generation-1",
    ownerId: "owner-1",
    missionDocumentSha256: SHA_C,
    missionBindingSha256: SHA_A,
    authoritySha256: SHA_B,
  };
}

function fakePlan(
  directory: string,
  mode: string,
  logPath?: string,
): CodexAppServerPlan {
  return {
    spawn: {
      command: process.execPath,
      args: [FAKE_APP_SERVER],
      cwd: directory,
      env: {
        HYDRA_FAKE_CODEX_MODE: mode,
        ...(logPath ? { HYDRA_FAKE_CODEX_LOG: logPath } : {}),
      },
      stdin: "",
    },
    threadStartParams: {
      cwd: directory,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      model: "gpt-test",
    },
    expected: {
      cwd: directory,
      sandbox: "read-only",
      model: "gpt-test",
    },
  };
}

function providerRequest(text: string): SteeringProviderRequest {
  const textBytes = Buffer.byteLength(text, "utf8");
  return {
    schemaVersion: STEERING_SCHEMA_VERSION,
    steeringId: "steering-1",
    source: "localUser",
    intent: "steer",
    text,
    textSha256: sha256Utf8(text),
    textCharacters: text.length,
    textBytes,
    target: {
      callId: "call-1",
      generation: "generation-1",
      agentId: "codex",
      roomTurnId: "room-turn-1",
      sequence: 1,
      expectedDelivery: "sameTurn",
      missionDocumentSha256: SHA_C,
      missionBindingSha256: SHA_A,
      authoritySha256: SHA_B,
      initialPromptSha256: sha256Utf8("initial prompt"),
      ownerId: "owner-1",
      workClass: "discussion",
    },
  };
}

function spawnBlockedBySandbox(stderr: string): boolean {
  return /spawn EPERM/.test(stderr);
}

describe("planCodexAppServer", () => {
  test("maps a fully explicit exec invocation without widening authority", () => {
    const original = codexSpawn([
      "exec",
      "--sandbox",
      "workspace-write",
      "--cd",
      "nested",
      "--model",
      "gpt-5.4",
      "-c",
      "model_reasoning_effort='high'",
      "-c",
      "sandbox_workspace_write.network_access=false",
      "--color",
      "never",
      "--skip-git-repo-check",
      "--json",
      "--ephemeral",
      "-",
    ], path.resolve("C:\\workspace"));
    const result = planCodexAppServer(original);

    assert.equal(result.kind, "supported");
    if (result.kind !== "supported") return;
    const expectedCwd = path.resolve(original.cwd, "nested");
    assert.deepEqual(result.plan.spawn, {
      command: "codex",
      args: [
        "-c",
        "model_reasoning_effort='high'",
        "-c",
        "sandbox_workspace_write.network_access=false",
        "app-server",
        "--listen",
        "stdio://",
      ],
      cwd: expectedCwd,
      env: original.env,
      stdin: "",
    });
    assert.deepEqual(result.plan.threadStartParams, {
      cwd: expectedCwd,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: true,
      model: "gpt-5.4",
    });
    assert.deepEqual(result.plan.expected, {
      cwd: expectedCwd,
      sandbox: "workspace-write",
      model: "gpt-5.4",
      reasoningEffort: "high",
      workspaceWriteNetworkAccess: false,
    });
  });

  test("falls back for non-exec, implicit authority, invalid sandbox, and unknown flags", () => {
    const cases = [
      codexSpawn(["review", "--uncommitted", "-"]),
      codexSpawn(["exec", "-"]),
      codexSpawn(["exec", "--sandbox", "not-a-sandbox", "-"]),
      codexSpawn(["exec", "--sandbox", "read-only", "--color", "ultraviolet", "-"]),
      codexSpawn(["exec", "--sandbox", "read-only", "--profile", "custom", "-"]),
      codexSpawn(["--profile", "custom", "exec", "--sandbox", "read-only", "-"]),
    ];

    for (const candidate of cases) {
      assert.equal(planCodexAppServer(candidate).kind, "unsupported", candidate.args.join(" "));
    }
  });

  test("falls back for missing flag values and relative spawn cwd", () => {
    for (const args of [
      ["exec", "--sandbox"],
      ["exec", "--sandbox", "read-only", "--cd"],
      ["exec", "--sandbox", "read-only", "--model"],
      ["exec", "--sandbox", "read-only", "--config"],
      ["exec", "--sandbox", "read-only", "--color"],
      ["exec", "--sandbox", "read-only", "--output-last-message"],
    ]) {
      assert.equal(planCodexAppServer(codexSpawn(args)).kind, "unsupported", args.join(" "));
    }
    assert.equal(
      planCodexAppServer(codexSpawn(["exec", "--sandbox", "read-only", "-"], "relative-repo")).kind,
      "unsupported",
    );
  });

  test("falls back rather than dropping an explicit last-message file side effect", () => {
    const result = planCodexAppServer(codexSpawn([
      "exec",
      "--sandbox",
      "read-only",
      "--output-last-message",
      path.resolve("reply.txt"),
      "-",
    ]));
    assert.equal(result.kind, "unsupported");
    if (result.kind === "unsupported") {
      assert.match(result.reason, /cannot preserve --output-last-message/);
    }
  });
});

describe("runCodexAppServerTurn", () => {
  test("rejects a stale Mission binding before turn/start and never falls back", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-codex-mission-reject-"));
    const logPath = path.join(directory, "requests.jsonl");
    let gateCalls = 0;
    const submissionGate: MissionSubmissionGate = {
      write: async (point) => {
        gateCalls++;
        assert.equal(point, "codex.turnStart");
        throw new MissionSubmissionRejectedError("Mission binding changed");
      },
    };
    try {
      await assert.rejects(
        runCodexAppServerTurn({
          plan: fakePlan(directory, "normal", logPath),
          prompt: "must never cross turn/start",
          timeoutMs: HANG_NET_TIMEOUT_MS,
          signal: new AbortController().signal,
          binding: binding(),
          submissionGate,
          onChunk: () => undefined,
        }),
        MissionSubmissionRejectedError,
      );
      assert.equal(gateCalls, 1);
      const methods = (await fs.readFile(logPath, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => (JSON.parse(line) as { method?: string }).method);
      assert.deepEqual(methods, ["initialize", "initialized", "thread/start"]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects stale turn steering with zero RPC bytes and keeps the turn usable", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-codex-steer-gate-"));
    const logPath = path.join(directory, "requests.jsonl");
    let handleReady!: (handle: LiveActiveSteeringHandle) => void;
    const handlePromise = new Promise<LiveActiveSteeringHandle>((resolve) => {
      handleReady = resolve;
    });
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
    try {
      const run = runCodexAppServerTurn({
        plan: fakePlan(directory, "normal", logPath),
        prompt: "initial prompt",
        timeoutMs: HANG_NET_TIMEOUT_MS,
        signal: new AbortController().signal,
        binding: binding(),
        submissionGate: allowGate,
        onChunk: () => undefined,
        onHandleReady: handleReady,
      });
      const handle = await handlePromise;
      await assert.rejects(
        handle.steer(providerRequest("must not be written"), rejectGate),
        MissionSubmissionRejectedError,
      );
      const acknowledgement = await handle.steer(
        providerRequest("valid correction"),
        allowGate,
      );
      assert.ok(isSteeringProviderAcknowledgement(acknowledgement));
      const result = await run;
      if (spawnBlockedBySandbox(result.stderr)) return;
      assert.equal(result.exitCode, 0);
      const methods = (await fs.readFile(logPath, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => (JSON.parse(line) as { method?: string }).method);
      assert.equal(methods.filter((method) => method === "turn/steer").length, 1);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("streams many App Server deltas without cumulative quadratic capture", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-codex-many-deltas-"));
    const live = createLiveTextExtractor("codexJson");
    assert.ok(live);
    let streamed = "";

    try {
      const result = await runCodexAppServerTurn({
        plan: fakePlan(directory, "many-deltas"),
        prompt: "initial prompt",
        timeoutMs: HANG_NET_TIMEOUT_MS,
        signal: new AbortController().signal,
        binding: binding(),
        onChunk: (chunk) => {
          streamed += live.push(chunk);
        },
      });
      if (spawnBlockedBySandbox(result.stderr)) return;

      const expected = "abcdefgh".repeat(4096);
      assert.equal(streamed, expected);
      assert.equal(result.exitCode, 0);
      assert.ok(
        result.stdout.length < 100_000,
        `terminal capture should be linear, got ${result.stdout.length} characters`,
      );
      assert.doesNotMatch(result.stdout, /"type":"item\.delta"/);
      assert.match(result.stdout, new RegExp(expected.slice(0, 64)));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("negotiates, starts, steers the exact active turn, and translates completion", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-codex-app-server-"));
    const logPath = path.join(directory, "requests.jsonl");
    let handleReady!: (handle: LiveActiveSteeringHandle) => void;
    const handlePromise = new Promise<LiveActiveSteeringHandle>((resolve) => {
      handleReady = resolve;
    });
    const chunks: string[] = [];

    try {
      const runPromise = runCodexAppServerTurn({
        plan: fakePlan(directory, "normal", logPath),
        prompt: "initial prompt",
        timeoutMs: HANG_NET_TIMEOUT_MS,
        signal: new AbortController().signal,
        binding: binding(),
        onChunk: (chunk) => chunks.push(chunk),
        onHandleReady: handleReady,
      });
      const handle = await handlePromise;
      assert.deepEqual(handle.inspect(), { ...binding(), active: true });

      for (const targetPatch of [
        { authoritySha256: "d".repeat(64) },
        { missionDocumentSha256: "d".repeat(64) },
        { missionBindingSha256: "d".repeat(64) },
      ]) {
        const wrongBinding = providerRequest("must not leave Hydra");
        const rejected = await handle.steer({
          ...wrongBinding,
          target: {
            ...wrongBinding.target,
            ...targetPatch,
          },
        });
        assert.ok(isSteeringProviderAcknowledgement(rejected));
        assert.equal(rejected.status, "rejected");
      }

      const acknowledgement = await handle.steer(providerRequest("focus on tests"));
      assert.ok(isSteeringProviderAcknowledgement(acknowledgement));
      assert.equal(acknowledgement.status, "acknowledged");
      assert.equal(acknowledgement.delivery, "sameTurn");
      assert.equal(acknowledgement.callId, "call-1");
      assert.equal(acknowledgement.missionDocumentSha256, SHA_C);
      assert.equal(acknowledgement.missionBindingSha256, SHA_A);

      const result = await runPromise;
      if (spawnBlockedBySandbox(result.stderr)) return;
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);
      assert.equal(result.cancelled, false);
      assert.match(chunks.join(""), /"type":"item\.delta"/);
      assert.doesNotMatch(result.stdout, /"type":"item\.delta"/);
      assert.match(result.stdout, /"type":"thread\.started"/);
      assert.match(result.stdout, /"type":"turn\.started"/);
      assert.match(result.stdout, /initial=initial prompt; steer=focus on tests/);
      assert.match(result.stdout, /"input_tokens":11/);
      assert.deepEqual(handle.inspect(), { ...binding(), active: false });

      const requests = (await fs.readFile(logPath, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { method?: string; params?: unknown });
      assert.deepEqual(
        requests.map((request) => request.method),
        ["initialize", "initialized", "thread/start", "turn/start", "turn/steer"],
      );
      const threadStart = requests.find((request) => request.method === "thread/start");
      const turnStart = requests.find((request) => request.method === "turn/start");
      const turnSteer = requests.find((request) => request.method === "turn/steer");
      assert.deepEqual(threadStart?.params, {
        cwd: directory,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        model: "gpt-test",
      });
      assert.deepEqual(
        (turnStart?.params as { input: unknown }).input,
        [{ type: "text", text: "initial prompt", text_elements: [] }],
      );
      assert.deepEqual(
        (turnSteer?.params as { expectedTurnId: string; input: unknown }).expectedTurnId,
        "turn-1",
      );
      assert.deepEqual(
        (turnSteer?.params as { input: unknown }).input,
        [{ type: "text", text: "focus on tests", text_elements: [] }],
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("fails over before turn/start when negotiated authority does not match", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-codex-fallback-"));
    const logPath = path.join(directory, "requests.jsonl");
    try {
      await assert.rejects(
        runCodexAppServerTurn({
          plan: fakePlan(directory, "mismatched-cwd", logPath),
          prompt: "must not be submitted",
          timeoutMs: HANG_NET_TIMEOUT_MS,
          signal: new AbortController().signal,
          binding: binding(),
          onChunk: () => undefined,
        }),
        CodexAppServerFallbackError,
      );
      const methods = (await fs.readFile(logPath, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => (JSON.parse(line) as { method?: string }).method);
      assert.deepEqual(methods, ["initialize", "initialized", "thread/start"]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("fails over before thread/start when the App Server schema version is too old", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-codex-old-server-"));
    const logPath = path.join(directory, "requests.jsonl");
    try {
      await assert.rejects(
        runCodexAppServerTurn({
          plan: fakePlan(directory, "old-version", logPath),
          prompt: "must not be submitted",
          timeoutMs: HANG_NET_TIMEOUT_MS,
          signal: new AbortController().signal,
          binding: binding(),
          onChunk: () => undefined,
        }),
        CodexAppServerFallbackError,
      );
      const methods = (await fs.readFile(logPath, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => (JSON.parse(line) as { method?: string }).method);
      assert.deepEqual(methods, ["initialize"]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("replays notifications batched behind turn/start only after the turn binding exists", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-codex-batched-"));
    try {
      const result = await runCodexAppServerTurn({
        plan: fakePlan(directory, "batched-start-and-complete"),
        prompt: "initial prompt",
        timeoutMs: HANG_NET_TIMEOUT_MS,
        signal: new AbortController().signal,
        binding: binding(),
        onChunk: () => undefined,
      });
      if (spawnBlockedBySandbox(result.stderr)) return;
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);
      assert.match(result.stdout, /"type":"turn\.started"/);
      assert.match(result.stdout, /initial=initial prompt; steer=/);
      assert.match(result.stdout, /"input_tokens":11/);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed on a dropped protocol frame instead of stranding the turn", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-codex-oversized-"));
    try {
      const dropped = await runCodexAppServerTurn({
        plan: fakePlan(directory, "oversized-frame"),
        prompt: "initial prompt",
        timeoutMs: HANG_NET_TIMEOUT_MS,
        signal: new AbortController().signal,
        binding: binding(),
        onChunk: () => undefined,
      });
      if (spawnBlockedBySandbox(dropped.stderr)) return;
      assert.match(dropped.stderr, /protocol frame was dropped/);
      assert.notEqual(dropped.exitCode, 0);
      assert.equal(
        dropped.deliveryUnknown,
        true,
        "a frame dropped after submission cannot claim a trustworthy receipt",
      );

      // The same run under the cap must still succeed, or the rule is just
      // "large payloads fail" rather than "dropped frames fail".
      const kept = await runCodexAppServerTurn({
        plan: fakePlan(directory, "large-frame"),
        prompt: "initial prompt",
        timeoutMs: HANG_NET_TIMEOUT_MS,
        signal: new AbortController().signal,
        binding: binding(),
        onChunk: () => undefined,
      });
      assert.doesNotMatch(kept.stderr, /protocol frame was dropped/);
      assert.equal(kept.exitCode, 0);
      assert.equal(kept.timedOut, false);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  test("treats blank framing lines as framing, not malformed JSONL", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-codex-blank-"));
    try {
      const result = await runCodexAppServerTurn({
        plan: fakePlan(directory, "blank-line-framing"),
        prompt: "initial prompt",
        timeoutMs: HANG_NET_TIMEOUT_MS,
        signal: new AbortController().signal,
        binding: binding(),
        onChunk: () => undefined,
      });
      if (spawnBlockedBySandbox(result.stderr)) return;
      assert.doesNotMatch(result.stderr, /malformed JSONL/);
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);
      assert.match(result.stdout, /"type":"turn.started"/);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  test("never advertises fallback after the model request may have been accepted", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-codex-post-submit-"));
    try {
      for (const mode of [
        "malformed-turn-start",
        "exit-after-turn-start",
        "exit-zero-after-turn-start",
      ]) {
        const result = await runCodexAppServerTurn({
          plan: fakePlan(directory, mode),
          prompt: "possibly accepted",
          // Generous on purpose: deliveryUnknown is suppressed by timedOut (here
          // and in claudeSessionTransport), so a budget this scenario can actually
          // exhaust under load stops testing the post-submission classification and
          // starts testing the timeout instead. None of these modes needs the time;
          // the budget is only a hang net.
          timeoutMs: HANG_NET_TIMEOUT_MS,
          signal: new AbortController().signal,
          binding: binding(),
          onChunk: () => undefined,
        });
        assert.match(
          result.stderr,
          /(malformed turn\/start response|exited (?:during negotiation|before the protocol completed))/i,
          mode,
        );
        assert.notEqual(result.exitCode, 0, `${mode} must never look successful`);
        assert.equal(
          result.deliveryUnknown,
          true,
          `${mode} crossed the model submission boundary without a trustworthy terminal receipt`,
        );
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects an interactive server request with its exact string request ID", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-codex-server-request-"));
    const logPath = path.join(directory, "requests.jsonl");
    try {
      const result = await runCodexAppServerTurn({
        plan: fakePlan(directory, "string-server-request", logPath),
        prompt: "do not prompt interactively",
        timeoutMs: HANG_NET_TIMEOUT_MS,
        signal: new AbortController().signal,
        binding: binding(),
        onChunk: () => undefined,
      });
      if (spawnBlockedBySandbox(result.stderr)) return;
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);

      const messages = (await fs.readFile(logPath, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as {
          id?: string | number;
          error?: { code?: number; message?: string };
        });
      const denial = messages.find((message) => message.id === "approval-request-1");
      assert.equal(denial?.error?.code, -32_000);
      assert.match(denial?.error?.message ?? "", /does not support interactive server requests/);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
