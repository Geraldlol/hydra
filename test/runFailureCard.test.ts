import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as path from "node:path";
import {
  collapseRepeatedLogLines,
  createRunFailureCard,
  isSafeRunFailureRequestPath,
} from "../src/runFailureCard";

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
    assert.equal(card.diagnosticPreviewSource, "stderr");
    assert.equal(card.diagnosticPreview, "bad native output");
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

  test("falls back to a bounded normalized reply or stdout preview when stderr is empty", () => {
    const usefulPrefix = "typed JSON-stream error: request refused\n";
    const card = createRunFailureCard({
      id: "trace-stdout",
      agent: "codex",
      phase: "opener",
      transport: "oneShot",
      startedAt: 0,
      nowMs: 100,
      promptSha256: "f".repeat(64),
      workspaceRoot,
      result: {
        stdout: usefulPrefix + "x".repeat(1600),
        stderr: "",
        exitCode: 1,
        timedOut: false,
        cancelled: false,
      },
    });

    assert.ok(card);
    assert.equal(card.stderrPreview, undefined);
    assert.equal(card.diagnosticPreviewSource, "normalizedReplyOrStdout");
    assert.equal(card.diagnosticPreviewChars, usefulPrefix.length + 1600);
    assert.match(card.diagnosticPreview || "", /^typed JSON-stream error/);
    assert.match(card.diagnosticPreview || "", /\[truncated \d+ chars\]$/);
    assert.ok((card.diagnosticPreview || "").length < 1300);
  });

  test("keeps a cancellation card when process termination was not confirmed", () => {
    const card = createRunFailureCard({
      id: "trace-unconfirmed",
      agent: "codex",
      phase: "build",
      transport: "oneShot",
      startedAt: 0,
      nowMs: 2000,
      promptSha256: "e".repeat(64),
      workspaceRoot,
      result: {
        stdout: "",
        stderr: "process may still be running",
        exitCode: null,
        timedOut: false,
        cancelled: true,
        terminationFailed: true,
      },
    });

    assert.ok(card);
    assert.equal(card.status, "Process termination unconfirmed");
    assert.equal(card.terminationFailed, true);
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

describe("repeated log line collapsing", () => {
  // The real shape of the codex 0.149.0 models-cache flood: one line repeated
  // every few seconds, each with a distinct timestamp, so plain identical-line
  // dedup would match nothing.
  const noise = (n: number): string => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const mm = String(50 + Math.floor(i / 60)).padStart(2, "0");
      const ss = String(i % 60).padStart(2, "0");
      out.push(
        "2026-08-21T20:" + mm + ":" + ss + ".123456Z ERROR " +
        "codex_models_manager::manager: failed to renew cache TTL: " +
        "missing field base_instructions at line 97 column 5",
      );
    }
    return out.join("\n");
  };

  test("collapses lines that differ only in their leading timestamp", () => {
    const collapsed = collapseRepeatedLogLines(noise(9));
    const lines = collapsed.split("\n");
    assert.equal(lines.length, 2, collapsed);
    assert.match(lines[0]!, /^2026-08-21T20:50:00/);
    assert.equal(lines[1], "[previous line repeated 8 more times]");
  });

  test("leaves distinct lines alone and adds no marker for a single occurrence", () => {
    const input = [
      "2026-08-21T20:50:00.000000Z ERROR alpha",
      "2026-08-21T20:50:01.000000Z ERROR beta",
      "2026-08-21T20:50:02.000000Z ERROR alpha",
    ].join("\n");
    assert.equal(collapseRepeatedLogLines(input), input);
  });

  test("uses singular wording for a run of exactly two", () => {
    const input = [
      "2026-08-21T20:50:00.000000Z ERROR same",
      "2026-08-21T20:50:01.000000Z ERROR same",
    ].join("\n");
    assert.equal(
      collapseRepeatedLogLines(input).split("\n")[1],
      "[previous line repeated 1 more time]",
    );
  });

  test("does not merge non-consecutive matches across intervening content", () => {
    const input = [
      "2026-08-21T20:50:00.000000Z ERROR same",
      "2026-08-21T20:50:01.000000Z ERROR same",
      "2026-08-21T20:50:02.000000Z ERROR different",
      "2026-08-21T20:50:03.000000Z ERROR same",
    ].join("\n");
    const out = collapseRepeatedLogLines(input).split("\n");
    assert.equal(out.length, 4, out.join(" | "));
    assert.equal(out[1], "[previous line repeated 1 more time]");
    assert.match(out[2]!, /different$/);
    assert.match(out[3]!, /same$/);
  });

  test("preserves untimestamped and empty input verbatim", () => {
    assert.equal(collapseRepeatedLogLines("no timestamp here"), "no timestamp here");
    assert.equal(collapseRepeatedLogLines(""), "");
  });

  test("surfaces a diagnostic the raw preview would have truncated away", () => {
    const realCause = "thread 'main' panicked at the actual reason";
    const stderr = noise(400) + "\n" + realCause;
    assert.ok(stderr.length > 20_000, "fixture must overflow the preview budget");

    const card = createRunFailureCard({
      id: "trace-flood",
      agent: "codex",
      phase: "build",
      transport: "oneShot",
      startedAt: 0,
      nowMs: 1000,
      promptSha256: "b".repeat(64),
      workspaceRoot,
      result: {
        stdout: "",
        stderr,
        exitCode: 1,
        timedOut: false,
        cancelled: false,
      },
    });

    assert.ok(card);
    // The real volume is still reported, so collapsing never hides how much
    // the CLI actually wrote.
    assert.equal(card.stderrChars, stderr.length);
    // And the cause now fits inside the preview budget, which is the point.
    assert.ok(
      card.stderrPreview!.includes(realCause),
      "preview lost the cause: " + String(card.stderrPreview).slice(0, 200),
    );
    assert.ok(
      card.diagnosticPreview!.includes(realCause),
      "diagnostic preview lost the cause",
    );
  });
});
