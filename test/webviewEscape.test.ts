import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { describe, test } from "node:test";

// Extract the escapeHtml declaration straight from the shipped webview script
// and evaluate it in an isolated context. This pins the actual neutralizer the
// webview uses for untrusted, LLM-controlled message/command text rather than
// re-implementing it here.
function loadEscapeHtml(): (value: unknown) => string {
  const scriptBody = fs.readFileSync(path.join(process.cwd(), "media", "webview.js"), "utf8");
  const match = scriptBody.match(/function escapeHtml\(value\) \{[\s\S]*?\n\}/);
  assert.ok(match, "escapeHtml function not found in media/webview.js");
  const sandbox: { escapeHtml?: (value: unknown) => string } = {};
  vm.runInNewContext(`${match[0]}\nthis.escapeHtml = escapeHtml;`, sandbox);
  assert.equal(typeof sandbox.escapeHtml, "function", "escapeHtml did not evaluate to a function");
  return sandbox.escapeHtml as (value: unknown) => string;
}

describe("webview escapeHtml", () => {
  const escapeHtml = loadEscapeHtml();

  test("converts each HTML-special character to its entity", () => {
    assert.equal(escapeHtml("&"), "&amp;");
    assert.equal(escapeHtml("<"), "&lt;");
    assert.equal(escapeHtml(">"), "&gt;");
    assert.equal(escapeHtml('"'), "&quot;");
    assert.equal(escapeHtml("'"), "&#39;");
    assert.equal(escapeHtml("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&#39;f");
  });

  test("fully neutralizes a markup-injection payload", () => {
    const payload = "</span><img src=x onerror=alert(1)>";
    const escaped = escapeHtml(payload);
    // No raw markup-breaking characters may survive.
    assert.doesNotMatch(escaped, /</, "raw < leaked");
    assert.doesNotMatch(escaped, />/, "raw > leaked");
    assert.doesNotMatch(escaped, /"/, "raw \" leaked");
    // And the encoded forms must be present (proves the pipeline ran).
    assert.match(escaped, /&lt;/);
    assert.match(escaped, /&gt;/);
    assert.equal(
      escaped,
      "&lt;/span&gt;&lt;img src=x onerror=alert(1)&gt;",
    );
  });

  test("treats nullish input as the empty string", () => {
    assert.equal(escapeHtml(undefined), "");
    assert.equal(escapeHtml(null), "");
  });
});
