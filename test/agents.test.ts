import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as cp from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  runAgent,
  RunResult,
  stripAnsi,
  terminateWindowsProcessTreeSnapshot,
} from "../src/agents";

const MOCK_CLI = path.join(__dirname, "fixtures", "mock-cli.js");

function nodeSpawn(args: string[]) {
  return { command: process.execPath, args: [MOCK_CLI, ...args], cwd: process.cwd() };
}

function spawnBlockedBySandbox(result: RunResult): boolean {
  return result.exitCode === null && /spawn EPERM/.test(result.stderr);
}

describe("runAgent", () => {
  test("streams chunks via onChunk and resolves with full stdout", async () => {
    const chunks: string[] = [];
    const result: RunResult = await runAgent(
      nodeSpawn(["--emit", "hello ", "world"]),
      "",
      5000,
      (c) => chunks.push(c),
      new AbortController().signal
    );
    if (spawnBlockedBySandbox(result)) return;
    assert.equal(result.exitCode, 0);
    assert.equal(result.cancelled, false);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout, "hello world");
    assert.deepEqual(chunks.join(""), "hello world");
    assert.ok(chunks.length >= 1);
  });

  test("forwards prompt to stdin", async () => {
    // mock-cli does not read stdin, but the call should not hang because we end stdin.
    const result = await runAgent(
      nodeSpawn(["--emit", "ok"]),
      "this is the prompt body",
      5000,
      () => {},
      new AbortController().signal
    );
    if (spawnBlockedBySandbox(result)) return;
    assert.equal(result.exitCode, 0);
  });

  test("spawn.stdin overrides the prompt argument when set", async () => {
    // Why: cli-template heads can bake ${prompt} into argv; the adapter then
    // sets Invocation.stdin=undefined and dispatch passes spawn.stdin="" so
    // the prompt is not ALSO piped. spawn.stdin, when present, must win.
    const echo = { command: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], cwd: process.cwd() };
    const result = await runAgent(
      { ...echo, stdin: "from-spawn-stdin" },
      "prompt-arg-must-not-be-piped",
      5000,
      () => {},
      new AbortController().signal
    );
    if (spawnBlockedBySandbox(result)) return;
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "from-spawn-stdin");
  });

  test("empty spawn.stdin suppresses the prompt argument entirely", async () => {
    const echo = { command: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], cwd: process.cwd() };
    const result = await runAgent(
      { ...echo, stdin: "" },
      "prompt-arg-must-not-be-piped",
      5000,
      () => {},
      new AbortController().signal
    );
    if (spawnBlockedBySandbox(result)) return;
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
  });

  test("non-zero exit reflected in exitCode", async () => {
    const result = await runAgent(
      nodeSpawn(["--emit", "boom", "--fail"]),
      "",
      5000,
      () => {},
      new AbortController().signal
    );
    if (spawnBlockedBySandbox(result)) return;
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "boom");
  });

  test("AbortSignal terminates the child and sets cancelled=true", async () => {
    const ctrl = new AbortController();
    let sawFirstChunk!: () => void;
    const firstChunk = new Promise<void>((resolve) => {
      sawFirstChunk = resolve;
    });
    const promise = runAgent(
      nodeSpawn(["--emit", "starting...", "--hang"]),
      "",
      30000,
      () => sawFirstChunk(),
      ctrl.signal
    );
    await firstChunk;
    ctrl.abort();
    const result = await promise;
    if (spawnBlockedBySandbox(result)) return;
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
    assert.match(result.stdout, /starting\.\.\./);
  });

  test("timeout terminates the child and sets timedOut=true", async () => {
    const result = await runAgent(
      nodeSpawn(["--hang"]),
      "",
      300,
      () => {},
      new AbortController().signal
    );
    if (spawnBlockedBySandbox(result)) return;
    assert.equal(result.timedOut, true);
    assert.equal(result.cancelled, false);
  });

  test("timeout kills a detached grandchild before returning", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-agent-tree-"));
    const pidFile = path.join(dir, "grandchild.pid");
    const script = path.join(dir, "spawn-tree.js");
    await fs.writeFile(script, [
      'const cp = require("node:child_process");',
      'const fs = require("node:fs");',
      'const child = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'fs.writeFileSync(process.argv[2], String(child.pid));',
      'setInterval(() => {}, 1000);',
    ].join("\n"), "utf8");

    let pid = 0;
    try {
      const result = await runAgent(
        { command: process.execPath, args: [script, pidFile], cwd: dir },
        "",
        400,
        () => {},
        new AbortController().signal,
      );
      if (spawnBlockedBySandbox(result)) return;
      assert.equal(result.timedOut, true);
      pid = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10);
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      assert.equal(await waitForProcessExit(pid), true, `grandchild ${pid} should be gone`);
    } finally {
      if (pid > 0 && processIsAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("Windows snapshot termination rescans descendants and fails closed when its helper fails", async () => {
    let capturedArgs: readonly string[] = [];
    const helper = new EventEmitter() as cp.ChildProcess;
    helper.kill = () => true;
    const spawnProcess = ((_command: string, args: readonly string[]) => {
      capturedArgs = args;
      queueMicrotask(() => helper.emit("close", 1));
      return helper;
    }) as typeof cp.spawn;

    assert.equal(await terminateWindowsProcessTreeSnapshot(4242, spawnProcess), false);
    const script = capturedArgs.at(-1) ?? "";
    assert.match(script, /\$ErrorActionPreference='Stop'/);
    assert.match(script, /function Add-HydraDescendants/);
    assert.match(script, /\$known\.Contains\(\$parentProcessId\)/);
    assert.equal(
      script.match(/Get-CimInstance Win32_Process -ErrorAction Stop/g)?.length,
      2,
      "the helper must take an initial snapshot and a fresh snapshot after each kill pass",
    );
    assert.match(script, /for\(\$pass=0;\$pass -lt \$maxPasses;\$pass\+\+\)/);
    assert.match(script, /Stop-Process .* -ErrorAction Stop/);
    assert.match(script, /\$known\.Count -eq \$knownCountBeforeRefresh -and \$alive\.Count -eq 0\)\{exit 0\}/);
    assert.match(script, /catch \{\s*exit 1\s*\}/);
  });

  test("zero timeout disables the wall-clock cap", async () => {
    const result = await runAgent(
      nodeSpawn(["--delay", "150", "--emit", "slow ok"]),
      "",
      0,
      () => {},
      new AbortController().signal
    );
    if (spawnBlockedBySandbox(result)) return;
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout, "slow ok");
  });

  test("missing native command returns a clear spawn failure", async () => {
    const result = await runAgent(
      { command: "hydra-definitely-missing-cli", args: [], cwd: process.cwd() },
      "",
      5000,
      () => {},
      new AbortController().signal
    );
    assert.equal(result.exitCode, null);
    assert.match(result.stderr, /Failed to start native CLI command: hydra-definitely-missing-cli/);
    if (!spawnBlockedBySandbox(result)) {
      assert.match(result.stderr, /Hydra could not find this executable/);
    }
  });

  test("onChunk that throws does not crash runAgent", async () => {
    let firstChunkSeen = false;
    const result = await runAgent(
      nodeSpawn(["--emit", "before ", "after"]),
      "",
      5000,
      (_c) => {
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          throw new Error("simulated webview disposed");
        }
      },
      new AbortController().signal
    );
    if (spawnBlockedBySandbox(result)) return;
    assert.equal(result.exitCode, 0);
    assert.equal(result.cancelled, false);
    assert.equal(result.stdout, "before after");
  });

  test("pre-aborted signal cancels the spawn", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await runAgent(
      nodeSpawn(["--hang"]),
      "",
      5000,
      () => {},
      ctrl.signal
    );
    if (spawnBlockedBySandbox(result)) return;
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
  });

  test("stripAnsi removes color codes", () => {
    const raw = "\x1B[31mred\x1B[0m text";
    assert.equal(stripAnsi(raw), "red text");
  });

  test("stripAnsi removes OSC sequences (BEL- and ST-terminated)", () => {
    // OSC 9 working-directory notification, BEL terminator
    assert.equal(stripAnsi("\x1B]9;9;/some/cwd\x07hello"), "hello");
    // OSC 133 shell integration mark, ESC \ string terminator
    assert.equal(stripAnsi("before\x1B]133;A\x1B\\after"), "beforeafter");
    // Mixed CSI + OSC in same buffer
    assert.equal(
      stripAnsi("\x1B[1;31mERROR\x1B[0m\x1B]0;title\x07 done"),
      "ERROR done"
    );
  });

  test("stripAnsi removes DCS and APC sequences", () => {
    assert.equal(stripAnsi("\x1BPpayload\x1B\\kept"), "kept");
    assert.equal(stripAnsi("\x1B_apc-data\x1B\\kept"), "kept");
  });
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return !processIsAlive(pid);
}
