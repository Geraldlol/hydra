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

  test("buildPowerShellDispatchInvocation keeps the reply key local and scrubs the legacy env var before launch", () => {
    const out = buildPowerShellDispatchInvocation(
      "C:\\repo\\.hydra\\dispatch\\turn-1-codex-opener.ps1",
      "abc123"
    );
    assert.match(out, /Remove-Item env:HYDRA_REPLY_NONCE[^;]+; \$__hydraReplyKey = 'abc123'; try \{/);
    assert.doesNotMatch(out, /\$env:HYDRA_REPLY_NONCE\s*=/);
    assert.match(out, /try \{ Invoke-Expression \(Get-Content -LiteralPath 'C:\\repo\\.hydra\\dispatch\\turn-1-codex-opener\.ps1' -Raw\) \}/);
    assert.match(out, /finally \{ \$__hydraReplyKey = \$null; Remove-Variable __hydraReplyKey/);
  });

  test("buildPowerShellDispatchInvocation leaves authentication fail-closed when no key is supplied", () => {
    const out = buildPowerShellDispatchInvocation(
      "C:\\repo\\.hydra\\dispatch\\turn-1-codex-opener.ps1"
    );
    assert.doesNotMatch(out, /\$env:HYDRA_REPLY_NONCE = /);
    assert.match(out, /\$__hydraReplyKey = ''/);
    assert.match(out, /Remove-Item env:HYDRA_REPLY_NONCE/);
  });

  test("buildPowerShellDispatchInvocation doubles single quotes in a nonce so it can't break out of the PS literal", () => {
    const out = buildPowerShellDispatchInvocation(
      "C:\\repo\\.hydra\\dispatch\\d.ps1",
      "abc'; iex 'pwned"
    );
    // quotePowerShell rule: wrap in single quotes, double any embedded '.
    // The malicious "abc'; iex 'pwned" must serialize as the literal string
    // 'abc''; iex ''pwned' — a single PS expression, not a statement chain.
    assert.match(out, /\$__hydraReplyKey = 'abc''; iex ''pwned'/);
    // The literal must be properly terminated before the next statement
    // separator (a `;` we control, not one smuggled inside the nonce).
    assert.match(out, /'abc''; iex ''pwned'; try \{ Invoke-Expression/);
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
    assert.match(out, /reply authentication key is missing/);
    assert.match(out, /__HydraHmacSha256 \(\[string\]\$__hydraReplyKey\)/);
    assert.doesNotMatch(out, /env:HYDRA_REPLY_NONCE/);
    // Reply JSON must still flow through ConvertTo-Json and be written with
    // the existing UTF-8 no-BOM helper.
    assert.match(out, /\$__hydraReplyJson = \$__hydraPayload \| ConvertTo-Json -Compress/);
    assert.match(out, /WriteAllText\(\$__hydraReply, \$__hydraReplyJson, \$__hydraUtf8NoBom\)/);
  });
});
