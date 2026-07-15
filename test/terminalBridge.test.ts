import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultTerminalArtifactRoot,
  isProbablyParseError,
  markTerminalTerminationUnconfirmed,
  prepareTerminalArtifactRoot,
  sweepStaleDispatchArtifacts,
  TerminalBridge,
  terminalEnvironmentFingerprint,
  terminalReplyAuth,
  unstreamedTail,
  waitForReply,
} from "../src/terminalBridge";
import { HYDRA_SYNTHETIC_ECHO_COMMAND } from "../src/terminalProtocol";

const vscodeRuntime = require("vscode") as {
  window: Record<string, unknown>;
};

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
    assert.match(result.stderr, /authentication mismatch/);
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

  test("authenticates the final log and returns an immutable snapshot", async () => {
    const dir = await tempDir();
    const replyPath = path.join(dir, "reply.json");
    const logPath = path.join(dir, "reply.log");
    const log = '{"type":"result","result":"done"}\n';
    const key = "private-reply-key";
    await fs.writeFile(logPath, log, "utf8");
    const payload = {
      text: "done",
      logSha256: crypto.createHash("sha256").update(log).digest("hex"),
    };
    const timer = writeReplySoon(replyPath, { ...payload, auth: terminalReplyAuth(payload, key) }, 20);

    const result = await waitForReply(replyPath, logPath, 2000, new AbortController().signal, 5, undefined, key);
    clearTimeout(timer);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "done");
    assert.equal(result.verifiedLog, log);
  });

  test("rejects an authenticated reply when the log bytes were tampered", async () => {
    const dir = await tempDir();
    const replyPath = path.join(dir, "reply.json");
    const logPath = path.join(dir, "reply.log");
    const key = "private-reply-key";
    const payload = {
      text: "done",
      logSha256: crypto.createHash("sha256").update("original").digest("hex"),
    };
    await fs.writeFile(logPath, "tampered", "utf8");
    await fs.writeFile(replyPath, JSON.stringify({ ...payload, auth: terminalReplyAuth(payload, key) }), "utf8");

    const result = await waitForReply(replyPath, logPath, 100, new AbortController().signal, 5, undefined, key);

    assert.equal(result.timedOut, true);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /log integrity mismatch/);
  });

  test("refuses hard-linked replies inside the private artifact boundary", async () => {
    const workspace = await tempDir();
    const storage = await tempDir();
    const boundary = await prepareTerminalArtifactRoot(workspace, storage);
    const outside = path.join(await tempDir(), "outside.json");
    const replyPath = path.join(storage, "replies", "reply.json");
    const logPath = path.join(storage, "logs", "reply.log");
    await fs.writeFile(outside, JSON.stringify({ text: "spoofed", nonce: "n" }), "utf8");
    await fs.link(outside, replyPath);
    await fs.writeFile(logPath, "", "utf8");

    const result = await waitForReply(
      replyPath,
      logPath,
      80,
      new AbortController().signal,
      5,
      undefined,
      "n",
      boundary
    );

    assert.equal(result.timedOut, true);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /linked or non-regular artifact/);
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

describe("terminal bridge artifact storage", () => {
  test("default storage is stable and not under the workspace", async () => {
    const workspace = await tempDir();
    const first = defaultTerminalArtifactRoot(workspace);
    assert.equal(first, defaultTerminalArtifactRoot(workspace));
    assert.equal(path.relative(workspace, first).startsWith(`..${path.sep}`), true);
    assert.doesNotMatch(first, /[\\/]\.hydra[\\/]/);
  });

  test("prepares private subdirectories outside the workspace", async () => {
    const workspace = await tempDir();
    const storage = await tempDir();
    const boundary = await prepareTerminalArtifactRoot(workspace, storage);
    assert.equal(boundary.logicalRoot, path.resolve(storage));
    for (const name of ["prompts", "replies", "logs", "dispatch", "sessions"]) {
      assert.equal((await fs.lstat(path.join(storage, name))).isDirectory(), true);
    }
  });

  test("rejects storage rooted inside the workspace", async () => {
    const workspace = await tempDir();
    await assert.rejects(
      prepareTerminalArtifactRoot(workspace, path.join(workspace, ".private-terminal")),
      /outside the workspace/
    );
  });

  test("rejects a linked artifact subdirectory", async (t) => {
    const workspace = await tempDir();
    const storage = await tempDir();
    const escape = await tempDir();
    await prepareTerminalArtifactRoot(workspace, storage);
    await fs.rmdir(path.join(storage, "logs"));
    try {
      await fs.symlink(escape, path.join(storage, "logs"), process.platform === "win32" ? "junction" : "dir");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Windows symlink creation requires Developer Mode or elevation");
        return;
      }
      throw err;
    }
    await assert.rejects(prepareTerminalArtifactRoot(workspace, storage), /linked or invalid/);
  });

  test("environment fingerprints do not expose secret values", () => {
    const secret = "do-not-persist-this-token";
    const fingerprint = terminalEnvironmentFingerprint({ HYDRA_TOKEN: secret, Path: "C:\\Tools" });
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(fingerprint, new RegExp(secret));
    assert.notEqual(fingerprint, terminalEnvironmentFingerprint({ HYDRA_TOKEN: "different", Path: "C:\\Tools" }));
  });

  test("revalidates the parent and real file after opening, before writing content", async () => {
    const source = (await fs.readFile(path.join(process.cwd(), "src", "terminalBridge.ts"), "utf8"))
      .replace(/\r\n?/g, "\n");
    const start = source.indexOf("async function createPrivateArtifact(");
    const end = source.indexOf("\n}\n\nasync function writePrivateArtifactSnapshot", start);
    assert.ok(start >= 0 && end > start);
    const method = source.slice(start, end);
    const opened = method.indexOf('const handle = await fs.open(filePath, "wx", 0o600)');
    const postOpenParent = method.indexOf("await assertArtifactParent(filePath, boundary)", opened);
    const postOpenRealpath = method.indexOf("await fs.realpath(filePath)", opened);
    const write = method.indexOf("await handle.writeFile(content, \"utf8\")");
    assert.ok(opened >= 0 && postOpenParent > opened);
    assert.ok(postOpenRealpath > postOpenParent);
    assert.ok(write > postOpenRealpath);
  });
});

describe("terminal bridge lifecycle fences", () => {
  function installTerminalWindowStub(): { created: unknown[] } {
    const created: unknown[] = [];
    vscodeRuntime.window.onDidCloseTerminal = () => ({ dispose() {} });
    vscodeRuntime.window.createTerminal = () => {
      const terminal = {
        sendText() {},
        show() {},
        dispose() {},
      };
      created.push(terminal);
      return terminal;
    };
    return { created };
  }

  test("an already-aborted call creates no request artifacts or terminal", async (t) => {
    const { created } = installTerminalWindowStub();
    const workspace = await tempDir();
    const storage = await tempDir();
    const bridge = new TerminalBridge(workspace, { artifactRoot: storage });
    t.after(() => bridge.dispose());
    const controller = new AbortController();
    controller.abort();

    const result = await bridge.callAgent(
      "codex",
      "opener",
      { command: "must-not-run", args: [], cwd: workspace },
      "must not persist",
      1000,
      controller.signal
    );

    assert.equal(result.cancelled, true);
    assert.equal(created.length, 0);
    await assert.rejects(fs.access(result.promptPath), /ENOENT/);
    await assert.rejects(fs.access(result.replyPath), /ENOENT/);
    await assert.rejects(fs.access(result.logPath), /ENOENT/);
  });

  test("disposed bridges reject before creating request artifacts or terminals", async () => {
    const { created } = installTerminalWindowStub();
    const workspace = await tempDir();
    const storage = await tempDir();
    const bridge = new TerminalBridge(workspace, { artifactRoot: storage });
    bridge.dispose();

    await assert.rejects(
      bridge.callAgent(
        "codex",
        "opener",
        { command: "must-not-run", args: [], cwd: workspace },
        "must not persist",
        1000,
        new AbortController().signal
      ),
      /disposed/
    );
    assert.equal(created.length, 0);
  });

  test("self-test alone may dispatch Hydra's synthetic echo without resolving an external executable", async (t) => {
    const { created } = installTerminalWindowStub();
    const workspace = await tempDir();
    const storage = await tempDir();
    const bridge = new TerminalBridge(workspace, {
      artifactRoot: storage,
      postDispatchSettleMs: 0,
    });
    t.after(() => bridge.dispose());

    const result = await bridge.selfTest(10);

    assert.equal(result.ok, false);
    assert.equal(created.length, 1);
    assert.doesNotMatch(result.message, /could not resolve native CLI/i);
  });

  test("ordinary calls cannot opt into Hydra's internal synthetic echo command", async (t) => {
    const { created } = installTerminalWindowStub();
    const workspace = await tempDir();
    const storage = await tempDir();
    const bridge = new TerminalBridge(workspace, { artifactRoot: storage });
    t.after(() => bridge.dispose());

    await assert.rejects(
      bridge.callAgent(
        "codex",
        "opener",
        { command: HYDRA_SYNTHETIC_ECHO_COMMAND, args: ["must-not-run"], cwd: workspace },
        "must not bypass executable resolution",
        1000,
        new AbortController().signal
      ),
      /could not resolve native CLI/i
    );
    assert.equal(created.length, 0);
  });

  test("post-dispatch timeout and cancellation remain unconfirmed after terminal disposal", () => {
    for (const result of [
      { stdout: "", stderr: "timeout", exitCode: null, timedOut: true, cancelled: false },
      { stdout: "", stderr: "", exitCode: null, timedOut: false, cancelled: true },
    ]) {
      const marked = markTerminalTerminationUnconfirmed(result);
      assert.equal(marked.terminationFailed, true);
      assert.match(marked.stderr, /cannot confirm that its native process tree exited/i);
    }

    const clean = { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, cancelled: false };
    assert.equal(markTerminalTerminationUnconfirmed(clean), clean);
  });

  test("panel latches terminal-bridge and self-test termination failures", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    assert.match(source, /latchUnconfirmedNativeTermination\(normalized, `\$\{agent\} \$\{phase\} terminal bridge`/);
    assert.match(source, /latchUnconfirmedNativeTermination\(result, "terminal bridge self-test"/);
    assert.match(source, /latchUnconfirmedNativeTermination\(bridgeResult, "Doctor terminal bridge self-test"/);
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
    const dispatchDir = path.join(root, "dispatch");
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

  test("does not throw when the storage root has no artifact dirs", async () => {
    const root = await tempDir();
    await sweepStaleDispatchArtifacts(root);
  });

  test("sweeps stale replies and logs too", async () => {
    const root = await tempDir();
    const repliesDir = path.join(root, "replies");
    const logsDir = path.join(root, "logs");
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

  test("sweeps crashed prompt, last-message, and session leftovers", async () => {
    const root = await tempDir();
    const files = [
      path.join(root, "prompts", "old.md"),
      path.join(root, "replies", "old.last.txt"),
      path.join(root, "sessions", "old.ready"),
      path.join(root, "sessions", "codex.session.json"),
    ];
    await Promise.all(files.map(async (file) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "old", "utf8");
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await fs.utimes(file, twoHoursAgo, twoHoursAgo);
    }));

    await sweepStaleDispatchArtifacts(root);

    for (const file of files) await assert.rejects(fs.access(file), /ENOENT/);
  });
});
