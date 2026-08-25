import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { startPersistentAgentProcess } from "../src/persistentAgentProcess";
import { HANG_NET_TIMEOUT_MS } from "./testBudgets";

function spawnInline(script: string) {
  return {
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
  };
}

function spawnBlockedBySandbox(stderr: string): boolean {
  return /spawn EPERM/.test(stderr);
}

describe("startPersistentAgentProcess", () => {
  test("serializes concurrent writes before endInput and rejects writes admitted after close", async () => {
    const chunks: string[] = [];
    const processHandle = startPersistentAgentProcess(
      spawnInline([
        "let body = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { body += chunk; });",
        "process.stdin.on('end', () => { process.stdout.write(body); });",
      ].join("")),
      HANG_NET_TIMEOUT_MS,
      (chunk) => chunks.push(chunk),
      new AbortController().signal,
    );

    const first = processHandle.write("first\n");
    const second = processHandle.write("second\n");
    const close = processHandle.endInput();
    const late = processHandle.write("late\n");

    await Promise.all([first, second, close]);
    await assert.rejects(late, /stdin channel is closed/);
    const result = await processHandle.result;
    if (spawnBlockedBySandbox(result.stderr)) return;

    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.cancelled, false);
    assert.equal(result.stdout, "first\nsecond\n");
    assert.equal(chunks.join(""), "first\nsecond\n");
    assert.equal(processHandle.inputOpen, false);
  });

  test("endInput is idempotent after the child has closed", async () => {
    const processHandle = startPersistentAgentProcess(
      spawnInline("process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"),
      HANG_NET_TIMEOUT_MS,
      () => undefined,
      new AbortController().signal,
    );

    await processHandle.endInput();
    const result = await processHandle.result;
    if (spawnBlockedBySandbox(result.stderr)) return;

    await processHandle.endInput();
    assert.equal(result.exitCode, 0);
    assert.equal(processHandle.inputOpen, false);
    await assert.rejects(processHandle.write("after-close"), /stdin channel is closed/);
  });

  test("preserves UTF-8 code points split across native stdout and stderr chunks", async () => {
    const chunks: string[] = [];
    const processHandle = startPersistentAgentProcess(
      spawnInline([
        "process.stdout.write(Buffer.from([0xf0,0x9f]));",
        "process.stderr.write(Buffer.from([0xf0,0x9f]));",
        "setTimeout(() => {",
        "process.stdout.write(Buffer.from([0x90,0x8d,0x0a]));",
        "process.stderr.write(Buffer.from([0x90,0x8d,0x0a]));",
        "}, 20);",
      ].join("")),
      HANG_NET_TIMEOUT_MS,
      (chunk) => chunks.push(chunk),
      new AbortController().signal,
    );

    await processHandle.endInput();
    const result = await processHandle.result;
    if (spawnBlockedBySandbox(result.stderr)) return;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "🐍\n");
    assert.equal(result.stderr, "🐍\n");
    assert.equal(chunks.join(""), "🐍\n");
  });

  test("reports a missing executable without exposing a writable input channel", async () => {
    const processHandle = startPersistentAgentProcess(
      {
        command: "hydra-definitely-missing-persistent-agent",
        args: [],
        cwd: process.cwd(),
      },
      HANG_NET_TIMEOUT_MS,
      () => undefined,
      new AbortController().signal,
    );

    const result = await processHandle.result;
    assert.equal(processHandle.inputOpen, false);
    assert.equal(result.exitCode, null);
    assert.match(result.stderr, /Failed to start native CLI command/);
    await assert.rejects(processHandle.write("nope"), /(did not start|stdin channel is closed)/);
    await processHandle.endInput();
  });
});
