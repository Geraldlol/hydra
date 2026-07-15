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
} from "../src/terminalProtocol";
import { terminalReplyAuth } from "../src/terminalBridge";

describe("terminal protocol PowerShell integration", () => {
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
    const promptPath = path.join(dir, "prompt.md");
    const replyPath = path.join(dir, "reply.json");
    const logPath = path.join(dir, "reply.log");
    const lastMessagePath = path.join(dir, "reply.last.txt");
    const dispatchPath = path.join(dir, "dispatch.ps1");
    const prompt = "synthetic prompt";
    const expected = "hydra-synthetic-output";
    const key = "test-only-reply-key";
    await Promise.all([
      fs.writeFile(promptPath, prompt, "utf8"),
      fs.writeFile(replyPath, "", "utf8"),
      fs.writeFile(logPath, "", "utf8"),
      fs.writeFile(lastMessagePath, "", "utf8"),
    ]);
    const script = buildPowerShellDispatchCommand(
      { command: HYDRA_SYNTHETIC_ECHO_COMMAND, args: [expected], cwd: dir },
      promptPath,
      replyPath,
      logPath,
      crypto.createHash("sha256").update(prompt).digest("hex")
    );
    await fs.writeFile(dispatchPath, script, "utf8");

    const invocation = buildPowerShellDispatchInvocation(
      dispatchPath,
      key,
      crypto.createHash("sha256").update(script).digest("hex")
    );
    const result = cp.spawnSync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", invocation],
      { env: { ...process.env, HYDRA_REPLY_NONCE: "legacy-value-must-be-scrubbed" }, encoding: "utf8", windowsHide: true }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const reply = parseTerminalReply(await fs.readFile(replyPath, "utf8"));
    assert.equal(reply.text, expected);
    assert.equal(reply.nonce, undefined);
    assert.match(reply.logSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(reply.auth, terminalReplyAuth(reply, key));
    assert.equal(await fs.readFile(logPath, "utf8"), expected);
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
    const promptPath = path.join(dir, "prompt.md");
    const replyPath = path.join(dir, "reply.json");
    const logPath = path.join(dir, "reply.log");
    const lastMessagePath = path.join(dir, "reply.last.txt");
    const dispatchPath = path.join(dir, "dispatch.ps1");
    const prompt = "child env boundary prompt";
    const key = "must-remain-parent-local";
    await Promise.all([
      fs.writeFile(promptPath, prompt, "utf8"),
      fs.writeFile(replyPath, "", "utf8"),
      fs.writeFile(logPath, "", "utf8"),
      fs.writeFile(lastMessagePath, "", "utf8"),
    ]);
    const script = buildPowerShellDispatchCommand(
      {
        command: powershell,
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "if ([string]::IsNullOrEmpty($env:HYDRA_REPLY_NONCE)) { [Console]::Out.Write('reply-key-not-in-child') } else { [Console]::Out.Write('reply-key-leaked') }",
        ],
        cwd: dir,
      },
      promptPath,
      replyPath,
      logPath,
      crypto.createHash("sha256").update(prompt).digest("hex")
    );
    await fs.writeFile(dispatchPath, script, "utf8");
    const invocation = buildPowerShellDispatchInvocation(
      dispatchPath,
      key,
      crypto.createHash("sha256").update(script).digest("hex")
    );

    const result = cp.spawnSync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", invocation],
      { env: { ...process.env, HYDRA_REPLY_NONCE: "legacy-value-must-be-scrubbed" }, encoding: "utf8", windowsHide: true }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const reply = parseTerminalReply(await fs.readFile(replyPath, "utf8"));
    assert.match(reply.text, /reply-key-not-in-child/);
    assert.doesNotMatch(reply.text, /reply-key-leaked/);
    assert.equal(reply.auth, terminalReplyAuth(reply, key));
  });
});
