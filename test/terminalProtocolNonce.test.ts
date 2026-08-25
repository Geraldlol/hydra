import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildPowerShellDispatchCommand,
  buildPowerShellDispatchInvocation,
  parseTerminalReply,
} from "../src/terminalProtocol";

describe("terminal bridge reply nonce", () => {
  test("parseTerminalReply surfaces nonce from JSON reply", () => {
    const reply = parseTerminalReply('{"text":"done","nonce":"abc123"}');
    assert.equal(reply.text, "done");
    assert.equal(reply.nonce, "abc123");
    assert.equal(reply.error, undefined);
  });

  test("parseTerminalReply returns undefined nonce for legacy replies without one", () => {
    const reply = parseTerminalReply('{"text":"done"}');
    assert.equal(reply.text, "done");
    assert.equal(reply.nonce, undefined);
  });

  test("parseTerminalReply ignores non-string nonce fields", () => {
    const reply = parseTerminalReply('{"text":"done","nonce":42}');
    assert.equal(reply.nonce, undefined);
  });

  test("buildPowerShellDispatchInvocation keeps reply-key bytes out of terminal input and scrubs the legacy env var", () => {
    const expectedSha256 = "a".repeat(64);
    const out = buildPowerShellDispatchInvocation(
      "C:\\repo\\.hydra\\dispatch\\turn-1-codex-opener.ps1",
      expectedSha256,
    );
    assert.match(out, /Remove-Item env:HYDRA_REPLY_NONCE[^;]+; try \{/);
    assert.doesNotMatch(out, /\$__hydraReplyKey\s*=\s*'/);
    assert.doesNotMatch(out, /\$env:HYDRA_REPLY_NONCE\s*=/);
    assert.match(out, new RegExp(`-cne '${expectedSha256}'`));
    assert.match(out, /finally \{ if \(\$__hydraReplyKey -is \[byte\[\]\]\)/);
  });

  test("buildPowerShellDispatchInvocation fails closed without a valid launcher digest", () => {
    assert.throws(
      () => buildPowerShellDispatchInvocation(
        "C:\\repo\\.hydra\\dispatch\\turn-1-codex-opener.ps1",
      ),
      /expected SHA-256 digest/,
    );
  });

  test("buildPowerShellDispatchInvocation rejects non-digest command injection text", () => {
    assert.throws(
      () => buildPowerShellDispatchInvocation(
        "C:\\repo\\.hydra\\dispatch\\d.ps1",
        "abc'; iex 'pwned",
      ),
      /expected SHA-256 digest/,
    );
    // quotePowerShell rule: wrap in single quotes, double any embedded '.
    // The malicious "abc'; iex 'pwned" must serialize as the literal string
    // 'abc''; iex ''pwned' — a single PS expression, not a statement chain.
    // The literal must be properly terminated before the next statement
    // separator (a `;` we control, not one smuggled inside the nonce).
  });

  test("dispatch script authenticates from a PowerShell-local key, never a child-visible env var", () => {
    const out = buildPowerShellDispatchCommand(
      {
        command: "codex",
        args: ["exec", "-"],
        cwd: "C:\\repo",
      },
      "C:\\repo\\.hydra\\prompts\\p.md",
      "C:\\repo\\.hydra\\replies\\r.json",
      "C:\\repo\\.hydra\\logs\\r.log"
    );
    assert.match(out, /reply key must contain exactly 32 bytes/);
    assert.match(out, /__HydraHmacSha256 \$__hydraReplyKey/);
    assert.match(out, /param\(\[byte\[\]\]\$Key/);
    assert.doesNotMatch(out, /env:HYDRA_REPLY_NONCE/);
    // Reply JSON must still flow through ConvertTo-Json and be written with
    // the existing UTF-8 no-BOM helper.
    assert.match(out, /\$__hydraReplyJson = \$__hydraPayload \| ConvertTo-Json -Compress/);
    assert.match(out, /WriteAllText\(\$__hydraReply, \$__hydraReplyJson, \$__hydraUtf8NoBom\)/);
  });
});
