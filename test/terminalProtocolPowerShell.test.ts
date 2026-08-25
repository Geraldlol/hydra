import { strict as assert } from "node:assert";
import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import {
  buildPowerShellDispatchCommand,
  buildPowerShellDispatchInvocation,
  HYDRA_SYNTHETIC_ECHO_COMMAND,
  parseTerminalReply,
  terminalProtocolStoragePaths,
} from "../src/terminalProtocol";
import { terminalReplyAuth } from "../src/terminalBridge";

async function writeSyntheticKeyFixture(
  dir: string,
  requestId: string,
  key: string | Uint8Array,
): Promise<{
  paths: ReturnType<typeof terminalProtocolStoragePaths>;
  script: string;
}> {
  const paths = terminalProtocolStoragePaths(dir, requestId, "codex", "opener");
  await Promise.all(Object.values(paths).map((filePath) => fs.mkdir(path.dirname(filePath), { recursive: true })));
  const prompt = `fixture prompt ${requestId}`;
  await Promise.all([
    fs.writeFile(paths.promptPath, prompt, "utf8"),
    fs.writeFile(paths.replyPath, "", "utf8"),
    fs.writeFile(paths.logPath, "", "utf8"),
    fs.writeFile(paths.lastMessagePath, "", "utf8"),
    fs.writeFile(paths.replyKeyPath, key),
  ]);
  const script = buildPowerShellDispatchCommand(
    { command: HYDRA_SYNTHETIC_ECHO_COMMAND, args: ["fixture-output"], cwd: dir },
    paths.promptPath,
    paths.replyPath,
    paths.logPath,
    crypto.createHash("sha256").update(prompt).digest("hex"),
  );
  await fs.writeFile(paths.dispatchPath, script, "utf8");
  return { paths, script };
}

describe("terminal protocol PowerShell integration", () => {
  test("malformed reply-key bytes fail closed and are deleted", async (t) => {
    if (process.platform !== "win32" || !process.env.SystemRoot) {
      t.skip("PowerShell integration is Windows-specific");
      return;
    }
    const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-terminal-key-format-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const { paths, script } = await writeSyntheticKeyFixture(dir, "invalid-size", Buffer.alloc(31, 0x41));
    const invocation = buildPowerShellDispatchInvocation(
      paths.dispatchPath,
      crypto.createHash("sha256").update(script).digest("hex"),
    );

    const result = cp.spawnSync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", invocation],
      { encoding: "utf8", windowsHide: true },
    );

    assert.notEqual(result.status, 0, "a malformed key must stop the dispatch");
    assert.match(result.stderr, /exactly 32 bytes/i);
    assert.equal(await fs.readFile(paths.replyPath, "utf8"), "");
    await assert.rejects(fs.access(paths.replyKeyPath), /ENOENT/);
  });

  test("a hash-valid launcher still rejects a reply-key path outside its private root", async (t) => {
    if (process.platform !== "win32" || !process.env.SystemRoot) {
      t.skip("PowerShell integration is Windows-specific");
      return;
    }
    const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-terminal-key-containment-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-terminal-key-outside-"));
    t.after(() => Promise.all([
      fs.rm(dir, { recursive: true, force: true }),
      fs.rm(outsideDir, { recursive: true, force: true }),
    ]));
    const key = Buffer.alloc(32, 0x42);
    const { paths, script } = await writeSyntheticKeyFixture(dir, "outside-root", key);
    const outsideKeyPath = path.join(outsideDir, "outside-root.key");
    await fs.writeFile(outsideKeyPath, key);
    const quotedExpected = `'${paths.replyKeyPath.replace(/'/g, "''")}'`;
    const quotedOutside = `'${outsideKeyPath.replace(/'/g, "''")}'`;
    const tamperedScript = script.replace(quotedExpected, quotedOutside);
    assert.notEqual(tamperedScript, script, "fixture must redirect the embedded key path");
    await fs.writeFile(paths.dispatchPath, tamperedScript, "utf8");
    const invocation = buildPowerShellDispatchInvocation(
      paths.dispatchPath,
      crypto.createHash("sha256").update(tamperedScript).digest("hex"),
    );

    const result = cp.spawnSync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", invocation],
      { encoding: "utf8", windowsHide: true },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /escapes the private artifact root/i);
    assert.deepEqual(await fs.readFile(outsideKeyPath), key);
    assert.equal(await fs.readFile(paths.replyPath, "utf8"), "");
    await assert.rejects(fs.access(paths.replyKeyPath), /ENOENT/);
  });

  test("a reparse-point reply-key directory fails closed without touching its target", async (t) => {
    if (process.platform !== "win32" || !process.env.SystemRoot) {
      t.skip("PowerShell integration is Windows-specific");
      return;
    }
    const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-terminal-key-reparse-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-terminal-key-target-"));
    t.after(() => Promise.all([
      fs.rm(dir, { recursive: true, force: true }),
      fs.rm(outsideDir, { recursive: true, force: true }),
    ]));
    const key = Buffer.alloc(32, 0x43);
    const { paths, script } = await writeSyntheticKeyFixture(dir, "reparse", key);
    const replyKeyDirectory = path.dirname(paths.replyKeyPath);
    const outsideKeyPath = path.join(outsideDir, path.basename(paths.replyKeyPath));
    await fs.rename(paths.replyKeyPath, outsideKeyPath);
    await fs.rmdir(replyKeyDirectory);
    try {
      await fs.symlink(outsideDir, replyKeyDirectory, "junction");
    } catch (err) {
      if (["EPERM", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? "")) {
        t.skip("Windows junction creation is unavailable");
        return;
      }
      throw err;
    }
    const invocation = buildPowerShellDispatchInvocation(
      paths.dispatchPath,
      crypto.createHash("sha256").update(script).digest("hex"),
    );

    const result = cp.spawnSync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", invocation],
      { encoding: "utf8", windowsHide: true },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /linked or invalid private artifact directory/i);
    assert.deepEqual(await fs.readFile(outsideKeyPath), key);
    assert.equal(await fs.readFile(paths.replyPath, "utf8"), "");
  });

  test("reply key travels through a one-use private artifact and is deleted before dispatch completes", async (t) => {
    if (process.platform !== "win32") {
      t.skip("PowerShell integration is Windows-specific");
      return;
    }
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) {
      t.skip("SystemRoot is unavailable");
      return;
    }
    const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-terminal-key-artifact-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const generatedPaths = terminalProtocolStoragePaths(dir, "request", "codex", "opener");
    const paths = {
      ...generatedPaths,
      replyKeyPath: path.join(dir, "reply-keys", "request-codex-opener.key"),
    };
    await Promise.all(Object.values(paths).map((filePath) => fs.mkdir(path.dirname(filePath), { recursive: true })));
    const prompt = "one-use key prompt";
    const expected = "one-use-key-output";
    const key = "0123456789abcdef0123456789abcdef";
    await Promise.all([
      fs.writeFile(paths.promptPath, prompt, "utf8"),
      fs.writeFile(paths.replyPath, "", "utf8"),
      fs.writeFile(paths.logPath, "", "utf8"),
      fs.writeFile(paths.lastMessagePath, "", "utf8"),
      fs.writeFile(paths.replyKeyPath, key, "utf8"),
    ]);
    const script = buildPowerShellDispatchCommand(
      { command: HYDRA_SYNTHETIC_ECHO_COMMAND, args: [expected], cwd: dir },
      paths.promptPath,
      paths.replyPath,
      paths.logPath,
      crypto.createHash("sha256").update(prompt).digest("hex"),
    );
    await fs.writeFile(paths.dispatchPath, script, "utf8");
    const invocation = buildPowerShellDispatchInvocation(
      paths.dispatchPath,
      crypto.createHash("sha256").update(script).digest("hex"),
    );

    assert.doesNotMatch(invocation, new RegExp(key));
    const result = cp.spawnSync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", invocation],
      { encoding: "utf8", windowsHide: true },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const reply = parseTerminalReply(await fs.readFile(paths.replyPath, "utf8"));
    assert.equal(reply.auth, terminalReplyAuth(reply, key));
    await assert.rejects(fs.access(paths.replyKeyPath), /ENOENT/);
  });

  test("synthetic dispatch emits an authenticated, log-bound reply", async (t) => {
    if (process.platform !== "win32") {
      t.skip("PowerShell integration is Windows-specific");
      return;
    }
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) {
      t.skip("SystemRoot is unavailable");
      return;
    }
    const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-terminal-protocol-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const paths = terminalProtocolStoragePaths(dir, "authenticated", "codex", "opener");
    await Promise.all(Object.values(paths).map((filePath) => fs.mkdir(path.dirname(filePath), { recursive: true })));
    const prompt = "synthetic prompt";
    const expected = "hydra-synthetic-output";
    const key = Buffer.from(Array.from({ length: 32 }, (_, index) => (index * 17 + 3) & 0xff));
    await Promise.all([
      fs.writeFile(paths.promptPath, prompt, "utf8"),
      fs.writeFile(paths.replyPath, "", "utf8"),
      fs.writeFile(paths.logPath, "", "utf8"),
      fs.writeFile(paths.lastMessagePath, "", "utf8"),
      fs.writeFile(paths.replyKeyPath, key),
    ]);
    const script = buildPowerShellDispatchCommand(
      { command: HYDRA_SYNTHETIC_ECHO_COMMAND, args: [expected], cwd: dir },
      paths.promptPath,
      paths.replyPath,
      paths.logPath,
      crypto.createHash("sha256").update(prompt).digest("hex")
    );
    await fs.writeFile(paths.dispatchPath, script, "utf8");

    const invocation = buildPowerShellDispatchInvocation(
      paths.dispatchPath,
      crypto.createHash("sha256").update(script).digest("hex"),
    );
    const result = cp.spawnSync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", invocation],
      { env: { ...process.env, HYDRA_REPLY_NONCE: "legacy-value-must-be-scrubbed" }, encoding: "utf8", windowsHide: true }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const reply = parseTerminalReply(await fs.readFile(paths.replyPath, "utf8"));
    assert.equal(reply.text, expected);
    assert.equal(reply.nonce, undefined);
    assert.match(reply.logSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(reply.auth, terminalReplyAuth(reply, key));
    assert.equal(await fs.readFile(paths.logPath, "utf8"), expected);
    await assert.rejects(fs.access(paths.replyKeyPath), /ENOENT/);
  });

  test("the reply HMAC key is absent from the invoked native child environment", async (t) => {
    if (process.platform !== "win32") {
      t.skip("PowerShell integration is Windows-specific");
      return;
    }
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) {
      t.skip("SystemRoot is unavailable");
      return;
    }
    const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-terminal-child-env-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const paths = terminalProtocolStoragePaths(dir, "child-boundary", "codex", "opener");
    await Promise.all(Object.values(paths).map((filePath) => fs.mkdir(path.dirname(filePath), { recursive: true })));
    const prompt = "child env boundary prompt";
    const key = "fedcba9876543210fedcba9876543210";
    const quotedKeyPath = paths.replyKeyPath.replace(/'/g, "''");
    await Promise.all([
      fs.writeFile(paths.promptPath, prompt, "utf8"),
      fs.writeFile(paths.replyPath, "", "utf8"),
      fs.writeFile(paths.logPath, "", "utf8"),
      fs.writeFile(paths.lastMessagePath, "", "utf8"),
      fs.writeFile(paths.replyKeyPath, key, "utf8"),
    ]);
    const script = buildPowerShellDispatchCommand(
      {
        command: powershell,
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `if ([string]::IsNullOrEmpty($env:HYDRA_REPLY_NONCE) -and -not (Test-Path -LiteralPath '${quotedKeyPath}')) { [Console]::Out.Write('reply-key-not-in-child') } else { [Console]::Out.Write('reply-key-leaked') }`,
        ],
        cwd: dir,
      },
      paths.promptPath,
      paths.replyPath,
      paths.logPath,
      crypto.createHash("sha256").update(prompt).digest("hex")
    );
    await fs.writeFile(paths.dispatchPath, script, "utf8");
    const invocation = buildPowerShellDispatchInvocation(
      paths.dispatchPath,
      crypto.createHash("sha256").update(script).digest("hex"),
    );

    const result = cp.spawnSync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", invocation],
      { env: { ...process.env, HYDRA_REPLY_NONCE: "legacy-value-must-be-scrubbed" }, encoding: "utf8", windowsHide: true }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const reply = parseTerminalReply(await fs.readFile(paths.replyPath, "utf8"));
    assert.match(reply.text, /reply-key-not-in-child/);
    assert.doesNotMatch(reply.text, /reply-key-leaked/);
    assert.equal(reply.auth, terminalReplyAuth(reply, key));
    await assert.rejects(fs.access(paths.replyKeyPath), /ENOENT/);
  });
});
