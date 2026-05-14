import { describe, test } from "node:test";
import * as assert from "node:assert/strict";

// We can't directly import the un-exported helpers from agents.ts without
// touching the module's public surface, so this suite verifies the SAME
// quoting rules through a local copy. If you change the helpers in
// agents.ts or codexModels.ts, mirror the change here.

function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

describe("Windows cmd.exe argument quoting", () => {
  test("plain args pass through unquoted", () => {
    assert.equal(quoteForCmd("exec"), "exec");
    assert.equal(quoteForCmd("--sandbox"), "--sandbox");
    assert.equal(quoteForCmd("danger-full-access"), "danger-full-access");
    assert.equal(quoteForCmd("gpt-5.5"), "gpt-5.5");
  });

  test("args with whitespace get wrapped in quotes", () => {
    assert.equal(
      quoteForCmd("C:\\Users\\geral\\Peerstar Salesforce Dev"),
      '"C:\\Users\\geral\\Peerstar Salesforce Dev"',
    );
  });

  test("args containing cmd metacharacters get quoted", () => {
    assert.equal(quoteForCmd("a & b"), '"a & b"');
    assert.equal(quoteForCmd("a|b"), '"a|b"');
    assert.equal(quoteForCmd("a>b"), '"a>b"');
    assert.equal(quoteForCmd("a^b"), '"a^b"');
    assert.equal(quoteForCmd("100%"), '"100%"');
    assert.equal(quoteForCmd("!bang"), '"!bang"');
  });

  test("internal quotes are doubled", () => {
    assert.equal(quoteForCmd('model_reasoning_effort="medium"'), '"model_reasoning_effort=""medium"""');
  });

  test("empty arg becomes a quoted empty string so it survives the boundary", () => {
    assert.equal(quoteForCmd(""), '""');
  });
});
