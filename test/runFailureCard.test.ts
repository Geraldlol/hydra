import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as path from "node:path";
import { createRunFailureCard, isSafeRunFailureRequestPath } from "../src/runFailureCard";

const workspaceRoot = path.resolve("C:/repo");

describe("run failure card", () => {
  test("creates a card for a non-zero agent exit with relative request files", () => {
    const card = createRunFailureCard({
      id: "trace-1",
      agent: "codex",
      phase: "build",
      transport: "oneShot",
      startedAt: 1000,
      nowMs: 3500,
      promptSha256: "a".repeat(64),
      workspaceRoot,
      requestFiles: {
        prompt: path.join(workspaceRoot, ".hydra", "prompts", "request.md"),
        reply: path.join(workspaceRoot, ".hydra", "replies", "request.json"),
        log: path.join(workspaceRoot, ".hydra", "logs", "request.log"),
      },
      result: {
        stdout: "",
        stderr: "bad native output",
        exitCode: 1,
        timedOut: false,
        cancelled: false,
      },
    });

    assert.ok(card);
    assert.equal(card.status, "Exit 1");
    assert.equal(card.durationMs, 2500);
    assert.equal(card.stderrPreview, "bad native output");
    assert.deepEqual(card.requestFiles.map((file) => file.path), [
      ".hydra/prompts/request.md",
      ".hydra/replies/request.json",
      ".hydra/logs/request.log",
    ]);
  });

  test("creates a timeout card and omits unsafe request paths", () => {
    const card = createRunFailureCard({
      id: "trace-2",
      agent: "claude",
      phase: "review",
      transport: "terminalBridge",
      startedAt: 0,
      nowMs: 65000,
      promptSha256: "b".repeat(64),
      workspaceRoot,
      requestFiles: {
        prompt: path.resolve("C:/other/.hydra/prompts/request.md"),
      },
      result: {
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: true,
        timeoutMs: 60000,
        cancelled: false,
      },
    });

    assert.ok(card);
    assert.equal(card.status, "Timed out after 1m 00s");
    assert.equal(card.requestFiles.length, 0);
  });

  test("does not create a card for successful or user-cancelled calls", () => {
    assert.equal(createRunFailureCard({
      id: "trace-3",
      agent: "codex",
      phase: "opener",
      transport: "oneShot",
      startedAt: 0,
      nowMs: 1,
      promptSha256: "c".repeat(64),
      workspaceRoot,
      result: { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, cancelled: false },
    }), undefined);

    assert.equal(createRunFailureCard({
      id: "trace-4",
      agent: "codex",
      phase: "opener",
      transport: "oneShot",
      startedAt: 0,
      nowMs: 1,
      promptSha256: "d".repeat(64),
      workspaceRoot,
      result: { stdout: "", stderr: "stopped", exitCode: null, timedOut: false, cancelled: true },
    }), undefined);
  });

  test("request diagnostic paths are limited to Hydra prompt, reply, and log files", () => {
    assert.equal(isSafeRunFailureRequestPath(".hydra/prompts/a.md"), true);
    assert.equal(isSafeRunFailureRequestPath(".hydra/replies/a.json"), true);
    assert.equal(isSafeRunFailureRequestPath(".hydra/logs/a.log"), true);
    assert.equal(isSafeRunFailureRequestPath(".hydra/agent-calls.jsonl"), false);
    assert.equal(isSafeRunFailureRequestPath("../.hydra/prompts/a.md"), false);
    assert.equal(isSafeRunFailureRequestPath("C:/repo/.hydra/prompts/a.md"), false);
  });
});
