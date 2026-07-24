import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import type { AgentSpawn } from "../src/agents";
import {
  createNativeSteeringRunner,
  type NativeSteeringRuntimeOptions,
} from "../src/nativeSteeringRuntime";
import { SteeringController } from "../src/steeringController";
import { InMemorySteeringStore } from "../src/steeringStore";

const CODEX_FIXTURE = path.join(__dirname, "fixtures", "fake-codex-app-server.js");
const CLAUDE_FIXTURE = path.join(__dirname, "fixtures", "mock-claude-session-cli.js");
const OWNER = "runtime-test-owner";
const MISSION = "a".repeat(64);

describe("native steering runtime", () => {
  test("returns undefined when provider argv cannot be promoted losslessly", () => {
    const directory = path.resolve(__dirname, "..");
    const controller = new SteeringController({
      store: new InMemorySteeringStore(),
      ownerId: OWNER,
    });

    assert.equal(createNativeSteeringRunner(runtimeOptions({
      transport: "codexAppServer",
      controller,
      spawn: {
        command: "codex",
        args: ["exec", "--profile", "unmapped", "-"],
        cwd: directory,
      },
    })), undefined);
    assert.equal(createNativeSteeringRunner(runtimeOptions({
      transport: "claudeSession",
      controller,
      spawn: {
        command: "claude",
        args: ["-p", "--output-format", "text"],
        cwd: directory,
      },
    })), undefined);
  });

  test("registers and closes an exact Codex live run while retaining result and chain trace", async () => {
    const fixture = await createNativeCliFixture();
    const store = new InMemorySteeringStore();
    const controller = new SteeringController({
      store,
      ownerId: OWNER,
      acknowledgementTimeoutMs: 2_000,
    });
    const traces: Record<string, unknown>[] = [];
    let registrationChanges = 0;
    let resolveRegistered!: () => void;
    const registered = new Promise<void>((resolve) => {
      resolveRegistered = resolve;
    });

    try {
      const runner = createNativeSteeringRunner(runtimeOptions({
        transport: "codexAppServer",
        controller,
        spawn: fixture.spawn(
          ["exec", "--sandbox", "read-only", "--json", "-"],
          { HYDRA_FAKE_CODEX_MODE: "normal" },
        ),
        appendTrace: async (record) => {
          traces.push(record);
        },
        onRegistrationChanged: () => {
          registrationChanges++;
          if (controller.targetSelections().length === 1) resolveRegistered();
        },
      }));
      assert.ok(runner);

      const chunks: string[] = [];
      const resultPromise = runner((chunk) => chunks.push(chunk));
      await registered;
      const selection = controller.targetSelections();
      assert.equal(selection.length, 1);
      assert.equal(selection[0]?.agentId, "codex");
      assert.equal(selection[0]?.capability.kind, "live");
      assert.equal(
        selection[0]?.capability.kind === "live"
          ? selection[0].capability.delivery
          : undefined,
        "sameTurn",
      );

      const steering = await controller.send({
        source: "localUser",
        intent: "steer",
        roomTurnId: "room-turn-runtime",
        text: "retain this steering chain",
        targets: selection,
      });
      assert.equal(steering.outcomes[0]?.outcome, "acknowledged");

      const result = await resultPromise;
      assert.equal(result.exitCode, 0);
      assert.equal(result.cancelled, false);
      assert.equal(result.timedOut, false);
      assert.match(chunks.join(""), /"type":"item\.delta"/);
      assert.doesNotMatch(result.stdout, /"type":"item\.delta"/);
      assert.match(result.stdout, /initial=initial runtime prompt; steer=retain this steering chain/);
      assert.deepEqual(controller.targetSelections(), []);
      assert.equal(registrationChanges, 2, "registration and close each refresh host state once");
      assert.equal(traces.length, 1);
      assert.equal(traces[0]?.event, "steeringChain");
      assert.equal(traces[0]?.agent, "codex");
      assert.equal(traces[0]?.chainIndeterminate, false);
      assert.equal(traces[0]?.lastSequence, 1);
      assert.equal(traces[0]?.lastAcknowledgedSequence, 1);
      assert.match(String(traces[0]?.steeringChainSha256), /^[a-f0-9]{64}$/);

      const invocations = await fixture.invocations();
      assert.equal(invocations.length, 1);
      assert.ok(invocations[0]?.includes("app-server"));
    } finally {
      await fixture.dispose();
    }
  });

  test("uses the original Codex one-shot exactly once after a pre-submit mismatch", async () => {
    const fixture = await createNativeCliFixture();
    const controller = new SteeringController({
      store: new InMemorySteeringStore(),
      ownerId: OWNER,
    });
    const traces: Record<string, unknown>[] = [];
    let registrationChanges = 0;

    try {
      const originalArgs = ["exec", "--sandbox", "read-only", "--json", "-"];
      const runner = createNativeSteeringRunner(runtimeOptions({
        transport: "codexAppServer",
        controller,
        spawn: fixture.spawn(originalArgs, {
          HYDRA_FAKE_CODEX_MODE: "mismatched-cwd",
        }),
        appendTrace: async (record) => {
          traces.push(record);
        },
        onRegistrationChanged: () => {
          registrationChanges++;
        },
      }));
      assert.ok(runner);

      const result = await runner(() => undefined);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /fallback-one-shot:initial runtime prompt/);
      assert.deepEqual(controller.targetSelections(), []);
      assert.equal(registrationChanges, 0);
      assert.deepEqual(traces, []);

      const invocations = await fixture.invocations();
      assert.equal(invocations.length, 2, "one App Server negotiation plus one one-shot fallback");
      assert.equal(invocations.filter((args) => args.includes("app-server")).length, 1);
      assert.equal(
        invocations.filter((args) => args[0] === "exec").length,
        1,
        "the original model request must be submitted at most once",
      );
      assert.deepEqual(invocations.find((args) => args[0] === "exec"), originalArgs);
    } finally {
      await fixture.dispose();
    }
  });

  test("never starts a fallback request after timeout or cancellation", async () => {
    for (const stopKind of ["timeout", "cancel"] as const) {
      const fixture = await createNativeCliFixture();
      const controller = new SteeringController({
        store: new InMemorySteeringStore(),
        ownerId: OWNER,
      });
      const abort = new AbortController();

      try {
        const runner = createNativeSteeringRunner(runtimeOptions({
          transport: "codexAppServer",
          controller,
          timeoutMs: stopKind === "timeout" ? 25 : 0,
          signal: abort.signal,
          spawn: fixture.spawn(
            ["exec", "--sandbox", "read-only", "--json", "-"],
            { HYDRA_FAKE_CODEX_MODE: "delayed-initialize" },
          ),
        }));
        assert.ok(runner);

        const resultPromise = runner(() => undefined);
        if (stopKind === "cancel") {
          setTimeout(() => abort.abort(), 25);
        }
        const result = await resultPromise;
        assert.equal(result.timedOut, stopKind === "timeout");
        assert.equal(result.cancelled, stopKind === "cancel");
        assert.match(result.stderr, /did not start a fallback request/i);

        const invocations = await fixture.invocations();
        assert.equal(
          invocations.length,
          1,
          `${stopKind} must launch only App Server and never the original codex exec`,
        );
        assert.ok(invocations[0]?.includes("app-server"));
      } finally {
        await fixture.dispose();
      }
    }
  });

  test("drains an admitted steer before recording the terminal chain", async () => {
    const fixture = await createNativeCliFixture();
    const controller = new SteeringController({
      store: new InMemorySteeringStore(),
      ownerId: OWNER,
      acknowledgementTimeoutMs: 2_000,
    });
    const traces: Record<string, unknown>[] = [];
    let resolveRegistered!: () => void;
    const registered = new Promise<void>((resolve) => {
      resolveRegistered = resolve;
    });

    try {
      const runner = createNativeSteeringRunner(runtimeOptions({
        transport: "codexAppServer",
        controller,
        spawn: fixture.spawn(
          ["exec", "--sandbox", "read-only", "--json", "-"],
          { HYDRA_FAKE_CODEX_MODE: "complete-before-steer-ack" },
        ),
        appendTrace: async (record) => {
          traces.push(record);
        },
        onRegistrationChanged: () => {
          if (controller.targetSelections().length === 1) resolveRegistered();
        },
      }));
      assert.ok(runner);

      const resultPromise = runner(() => undefined);
      await registered;
      const sendPromise = controller.send({
        source: "localUser",
        intent: "steer",
        roomTurnId: "room-turn-runtime",
        text: "acknowledge after provider completion",
        targets: controller.targetSelections(),
      });

      const [result, receipt] = await Promise.all([resultPromise, sendPromise]);
      assert.equal(result.exitCode, 0);
      assert.equal(receipt.outcomes[0]?.outcome, "acknowledged");
      assert.equal(traces.length, 1);
      assert.equal(traces[0]?.lastSequence, 1);
      assert.equal(traces[0]?.lastTerminalSequence, 1);
      assert.equal(traces[0]?.lastAcknowledgedSequence, 1);
      assert.equal(traces[0]?.steeringChainSha256, receipt.chainBindings[0]?.steeringChainSha256);
    } finally {
      await fixture.dispose();
    }
  });

  test("does not retry or fall back after a Claude runtime protocol failure", async () => {
    const fixture = await createNativeCliFixture();
    const controller = new SteeringController({
      store: new InMemorySteeringStore(),
      ownerId: OWNER,
    });
    const traces: Record<string, unknown>[] = [];
    let registrationChanges = 0;

    try {
      const runner = createNativeSteeringRunner(runtimeOptions({
        transport: "claudeSession",
        controller,
        spawn: fixture.spawn(["-p"], {
          HYDRA_MOCK_CLAUDE_SCENARIO: "old-version",
        }),
        appendTrace: async (record) => {
          traces.push(record);
        },
        onRegistrationChanged: () => {
          registrationChanges++;
        },
      }));
      assert.ok(runner);

      const result = await runner(() => undefined);
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /Claude session protocol failure/i);
      assert.match(result.stderr, /Claude Code >=2\.1\.205|msg_lifecycle_v1/);
      assert.deepEqual(controller.targetSelections(), []);
      assert.equal(registrationChanges, 0);
      assert.deepEqual(traces, []);

      const invocations = await fixture.invocations();
      assert.equal(invocations.length, 1, "a post-write Claude failure must remain one native submission");
      assert.ok(invocations[0]?.includes("-p"));
      assert.ok(invocations[0]?.includes("--input-format"));
      assert.ok(invocations[0]?.includes("--replay-user-messages"));
      assert.equal(invocations[0]?.includes("exec"), false, "no generic one-shot fallback may run");
    } finally {
      await fixture.dispose();
    }
  });

  test("runs the default uncapped Claude steering path with timeout zero", async () => {
    const fixture = await createNativeCliFixture();
    const controller = new SteeringController({
      store: new InMemorySteeringStore(),
      ownerId: OWNER,
    });

    try {
      const runner = createNativeSteeringRunner(runtimeOptions({
        transport: "claudeSession",
        controller,
        timeoutMs: 0,
        spawn: fixture.spawn(["-p"], {
          HYDRA_MOCK_CLAUDE_SCENARIO: "normal",
        }),
      }));
      assert.ok(runner);

      const result = await runner(() => undefined);
      assert.equal(result.timeoutMs, 0);
      assert.equal(result.timedOut, false);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /reply:initial runtime prompt/);

      const invocations = await fixture.invocations();
      assert.equal(invocations.length, 1);
      assert.ok(invocations[0]?.includes("--input-format"));
      assert.ok(invocations[0]?.includes("--replay-user-messages"));
    } finally {
      await fixture.dispose();
    }
  });
});

function runtimeOptions(
  overrides: Partial<NativeSteeringRuntimeOptions> & Pick<
    NativeSteeringRuntimeOptions,
    "transport" | "controller" | "spawn"
  >,
): NativeSteeringRuntimeOptions {
  return {
    prompt: "initial runtime prompt",
    timeoutMs: 4_000,
    signal: new AbortController().signal,
    callId: "call-runtime",
    agentId: overrides.transport === "codexAppServer" ? "codex" : "claude",
    roomTurnId: "room-turn-runtime",
    ownerId: OWNER,
    missionContractSha256: MISSION,
    workClass: "discussion",
    phaseSnapshot: "Opener",
    appendTrace: async () => undefined,
    onRegistrationChanged: () => undefined,
    ...overrides,
  };
}

interface NativeCliFixture {
  spawn(args: string[], env?: Record<string, string>): AgentSpawn;
  invocations(): Promise<string[][]>;
  dispose(): Promise<void>;
}

async function createNativeCliFixture(): Promise<NativeCliFixture> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-native-steering-runtime-"));
  const bridgePath = path.join(directory, "native-cli-bridge.js");
  const invocationLog = path.join(directory, "invocations.jsonl");
  const bridgeSource = [
    "#!/usr/bin/env node",
    '"use strict";',
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(process.env.HYDRA_RUNTIME_INVOCATIONS, `${JSON.stringify(args)}\\n`, \"utf8\");",
    `if (args.includes("app-server")) require(${JSON.stringify(CODEX_FIXTURE)});`,
    `else if (args.includes("-p") || args.includes("--print")) require(${JSON.stringify(CLAUDE_FIXTURE)});`,
    "else {",
    '  let input = "";',
    '  process.stdin.setEncoding("utf8");',
    '  process.stdin.on("data", (chunk) => { input += chunk; });',
    '  process.stdin.on("end", () => process.stdout.write(`fallback-one-shot:${input}`));',
    "}",
    "",
  ].join("\n");
  await fs.writeFile(bridgePath, bridgeSource, "utf8");

  let command = bridgePath;
  if (process.platform === "win32") {
    command = path.join(directory, "native-cli.cmd");
    await fs.writeFile(
      command,
      `@echo off\r\n"${process.execPath}" "${bridgePath}" %*\r\n`,
      "utf8",
    );
  } else {
    await fs.chmod(bridgePath, 0o755);
  }

  return {
    spawn(args, env = {}) {
      return {
        command,
        args,
        cwd: directory,
        env: {
          ...env,
          HYDRA_RUNTIME_INVOCATIONS: invocationLog,
        },
      };
    },
    async invocations() {
      const text = await fs.readFile(invocationLog, "utf8");
      return text
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    },
    async dispose() {
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}
