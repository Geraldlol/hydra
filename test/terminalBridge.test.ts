import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  isProbablyParseError,
  sweepStaleDispatchArtifacts,
  unstreamedTail,
  waitForReply,
} from "../src/terminalBridge";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "hydra-terminal-bridge-"));
}

function writeReplySoon(replyPath: string, payload: Record<string, unknown>, afterMs: number): NodeJS.Timeout {
  return setTimeout(() => {
    void fs.mkdir(path.dirname(replyPath), { recursive: true })
      .then(() => fs.writeFile(replyPath, JSON.stringify(payload), "utf8"))
      // Test fixture write; if the test already finished there's nothing to do.
      .catch(() => undefined);
  }, afterMs);
}

describe("waitForReply nonce reconciliation", () => {
  test("ignores a wrong-nonce reply file and times out", async () => {
    const dir = await tempDir();
    const replyPath = path.join(dir, "reply.json");
    const logPath = path.join(dir, "reply.log");
    // A co-tenant pre-writes a spoofed reply with the wrong nonce.
    await fs.writeFile(replyPath, JSON.stringify({ text: "spoofed", nonce: "attacker" }), "utf8");

    const result = await waitForReply(
      replyPath,
      logPath,
      120,
      new AbortController().signal,
      5,
      undefined,
      "expected-nonce"
    );

    assert.equal(result.timedOut, true);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /nonce mismatch/);
  });

  test("returns a correct-nonce reply", async () => {
    const dir = await tempDir();
    const replyPath = path.join(dir, "reply.json");
    const logPath = path.join(dir, "reply.log");
    const timer = writeReplySoon(replyPath, { text: "hello world", nonce: "expected-nonce" }, 20);

    const result = await waitForReply(
      replyPath,
      logPath,
      2000,
      new AbortController().signal,
      5,
      undefined,
      "expected-nonce"
    );
    clearTimeout(timer);

    assert.equal(result.timedOut, false);
    assert.equal(result.cancelled, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "hello world");
  });

  test("zero timeout waits until reply or abort", async () => {
    const dir = await tempDir();
    const replyPath = path.join(dir, "reply.json");
    const logPath = path.join(dir, "reply.log");
    const timer = writeReplySoon(replyPath, { text: "uncapped", nonce: "n" }, 50);

    const result = await waitForReply(replyPath, logPath, 0, new AbortController().signal, 5, undefined, "n");
    clearTimeout(timer);

    assert.equal(result.timedOut, false);
    assert.equal(result.cancelled, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "uncapped");
  });

  test("surfaces a reply error string with exit code 1", async () => {
    const dir = await tempDir();
    const replyPath = path.join(dir, "reply.json");
    const logPath = path.join(dir, "reply.log");
    const timer = writeReplySoon(replyPath, { text: "partial", nonce: "n", error: "exit 127" }, 20);

    const result = await waitForReply(replyPath, logPath, 2000, new AbortController().signal, 5, undefined, "n");
    clearTimeout(timer);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, "exit 127");
    assert.equal(result.stdout, "partial");
  });

  test("de-dups streamed log content against the final reply text", async () => {
    const dir = await tempDir();
    const replyPath = path.join(dir, "reply.json");
    const logPath = path.join(dir, "reply.log");
    // Live log shows the first half; the final reply repeats the whole thing.
    await fs.writeFile(logPath, "hello ", "utf8");
    const chunks: string[] = [];
    const timer = writeReplySoon(replyPath, { text: "hello world", nonce: "n" }, 30);

    const result = await waitForReply(
      replyPath,
      logPath,
      2000,
      new AbortController().signal,
      5,
      (chunk) => chunks.push(chunk),
      "n"
    );
    clearTimeout(timer);

    assert.equal(result.exitCode, 0);
    // Because onChunk already showed "hello ", only the unstreamed tail returns.
    assert.equal(result.stdout, "world");
    assert.equal(chunks.join(""), "hello ");
  });
});

describe("unstreamedTail", () => {
  test("returns the suffix not already streamed", () => {
    assert.equal(unstreamedTail("hello world", "hello "), "world");
  });
  test("returns only the trailing whitespace when stream is the full prefix", () => {
    // startsWith hits first: the stream already showed "done", so just the
    // trailing newline remains to be appended.
    assert.equal(unstreamedTail("done\n", "done"), "\n");
  });
  test("returns empty when final equals stream only modulo trailing whitespace", () => {
    // Trailing whitespace differs so startsWith fails, but trimEnd matches.
    assert.equal(unstreamedTail("done", "done\n"), "");
  });
  test("returns full final text when stream is empty", () => {
    assert.equal(unstreamedTail("abc", ""), "abc");
  });
  test("returns full final text when stream diverges", () => {
    assert.equal(unstreamedTail("abc", "xyz"), "abc");
  });
});

describe("isProbablyParseError", () => {
  test("treats ENOENT (file not yet written) as not a parse error", () => {
    assert.equal(isProbablyParseError({ code: "ENOENT" }), false);
  });
  test("treats JSON.parse failures as parse errors", () => {
    assert.equal(isProbablyParseError(new SyntaxError("Unexpected token")), true);
  });
});

describe("sweepStaleDispatchArtifacts", () => {
  test("removes only stale files and ignores non-files and missing dirs", async () => {
    const root = await tempDir();
    const dispatchDir = path.join(root, ".hydra", "dispatch");
    await fs.mkdir(dispatchDir, { recursive: true });

    const stale = path.join(dispatchDir, "stale.ps1");
    const recent = path.join(dispatchDir, "recent.ps1");
    await fs.writeFile(stale, "stale", "utf8");
    await fs.writeFile(recent, "recent", "utf8");
    // A directory entry must be skipped (sweep only unlinks files).
    await fs.mkdir(path.join(dispatchDir, "subdir"));

    // Backdate the stale file two hours; the gate is one hour.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(stale, twoHoursAgo, twoHoursAgo);

    // The replies/logs dirs intentionally don't exist — sweep must not throw.
    await sweepStaleDispatchArtifacts(root);

    await assert.rejects(fs.access(stale), /ENOENT/);
    await fs.access(recent); // recent survives
    await fs.access(path.join(dispatchDir, "subdir")); // non-file survives
  });

  test("does not throw when the workspace has no .hydra dirs at all", async () => {
    const root = await tempDir();
    await sweepStaleDispatchArtifacts(root);
  });

  test("sweeps stale replies and logs too", async () => {
    const root = await tempDir();
    const repliesDir = path.join(root, ".hydra", "replies");
    const logsDir = path.join(root, ".hydra", "logs");
    await fs.mkdir(repliesDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });
    const staleReply = path.join(repliesDir, "old.json");
    const staleLog = path.join(logsDir, "old.log");
    await fs.writeFile(staleReply, "{}", "utf8");
    await fs.writeFile(staleLog, "log", "utf8");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(staleReply, twoHoursAgo, twoHoursAgo);
    await fs.utimes(staleLog, twoHoursAgo, twoHoursAgo);

    await sweepStaleDispatchArtifacts(root);

    await assert.rejects(fs.access(staleReply), /ENOENT/);
    await assert.rejects(fs.access(staleLog), /ENOENT/);
  });
});
