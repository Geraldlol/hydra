import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as path from "node:path";
import { runAgent, RunResult, stripAnsi } from "../src/agents";

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
