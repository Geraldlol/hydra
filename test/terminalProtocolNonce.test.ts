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

  test("buildPowerShellDispatchInvocation injects the nonce env var and a scrub-in-finally", () => {
    const out = buildPowerShellDispatchInvocation(
      "C:\\repo\\.hydra\\dispatch\\turn-1-codex-opener.ps1",
      "abc123"
    );
    assert.match(out, /\$env:HYDRA_REPLY_NONCE = 'abc123'/);
    assert.match(out, /try \{ Invoke-Expression \(Get-Content -LiteralPath 'C:\\repo\\.hydra\\dispatch\\turn-1-codex-opener\.ps1' -Raw\) \}/);
    assert.match(out, /finally \{ Remove-Item env:HYDRA_REPLY_NONCE -ErrorAction SilentlyContinue \}/);
  });

  test("buildPowerShellDispatchInvocation omits the env var assignment when no nonce is supplied", () => {
    const out = buildPowerShellDispatchInvocation(
      "C:\\repo\\.hydra\\dispatch\\turn-1-codex-opener.ps1"
    );
    assert.doesNotMatch(out, /\$env:HYDRA_REPLY_NONCE = /);
    // The scrub-in-finally still runs so any leftover env var from a prior
    // dispatch (e.g. an earlier call that did pass a nonce) is cleared.
    assert.match(out, /finally \{ Remove-Item env:HYDRA_REPLY_NONCE -ErrorAction SilentlyContinue \}/);
  });

  test("buildPowerShellDispatchInvocation doubles single quotes in a nonce so it can't break out of the PS literal", () => {
    const out = buildPowerShellDispatchInvocation(
      "C:\\repo\\.hydra\\dispatch\\d.ps1",
      "abc'; iex 'pwned"
    );
    // quotePowerShell rule: wrap in single quotes, double any embedded '.
    // The malicious "abc'; iex 'pwned" must serialize as the literal string
    // 'abc''; iex ''pwned' — a single PS expression, not a statement chain.
    assert.match(out, /\$env:HYDRA_REPLY_NONCE = 'abc''; iex ''pwned'/);
    // The literal must be properly terminated before the next statement
    // separator (a `;` we control, not one smuggled inside the nonce).
    assert.match(out, /'abc''; iex ''pwned'; try \{ Invoke-Expression/);
  });

  test("dispatch script reads HYDRA_REPLY_NONCE from the live PS session and embeds it in the reply payload", () => {
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
    // The nonce must come from the env var (live PS session memory), not from
    // a string literal baked into the on-disk .ps1.
    assert.match(out, /\$__hydraPayload = \[ordered\]@\{ text = \$__hydraText; nonce = \(\$env:HYDRA_REPLY_NONCE\) \}/);
    // Reply JSON must still flow through ConvertTo-Json and be written with
    // the existing UTF-8 no-BOM helper.
    assert.match(out, /\$__hydraReplyJson = \$__hydraPayload \| ConvertTo-Json -Compress/);
    assert.match(out, /WriteAllText\(\$__hydraReply, \$__hydraReplyJson, \$__hydraUtf8NoBom\)/);
  });
});
