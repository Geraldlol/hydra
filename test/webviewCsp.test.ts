import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderHtml } from "../src/webview.html";

const heads = {
  cspSource: "vscode-resource:",
  brand: "brand.png",
  codex: "codex.png",
  claude: "claude.png",
  system: "system.png",
  user: "user.png",
};

describe("webview CSP hardening", () => {
  test("CSP keeps default-src 'none' and nonced script-src", () => {
    const html = renderHtml("test-nonce", heads, "vscode-resource:/media/webview.js");
    assert.match(html, /default-src 'none'/);
    assert.match(html, /script-src 'nonce-test-nonce'/);
  });

  test("CSP tightens base-uri, form-action, and frame-ancestors", () => {
    const html = renderHtml("test-nonce", heads, "vscode-resource:/media/webview.js");
    assert.match(html, /base-uri 'none'/);
    assert.match(html, /form-action 'none'/);
    assert.match(html, /frame-ancestors 'none'/);
  });

  test("data-head-assets attribute is HTML-attribute-encoded against malicious URIs", () => {
    const malicious = {
      cspSource: "vscode-resource:",
      brand: "brand.png",
      // Each head asset value below contains every HTML-special character
      // that could break out of the double-quoted attribute or inject markup.
      codex: 'codex"&<>onerror=alert(1)',
      claude: 'claude"><script>x</script>',
      system: "system'&amp;",
      user: "user<img src=x>",
    };
    const html = renderHtml("test-nonce", malicious, "vscode-resource:/media/webview.js");

    // Locate the data-head-assets attribute and isolate its value.
    const match = html.match(/data-head-assets="([^"]*)"/);
    assert.ok(match, "data-head-assets attribute missing or unquoted");
    const attrValue = match[1];

    // The raw payload characters must be encoded inside the attribute. If
    // any of these appear unescaped, an attacker-controlled URI could break
    // out of the attribute and inject markup or JS.
    assert.doesNotMatch(attrValue, /</, "raw < leaked into data-head-assets");
    assert.doesNotMatch(attrValue, />/, "raw > leaked into data-head-assets");
    assert.doesNotMatch(attrValue, /"/, "raw \" leaked into data-head-assets");

    // & must always be encoded as &amp; (or one of its named/numeric
    // equivalents); after the replace pipeline there should be no bare &.
    // We assert that every & in the value is followed by an entity marker.
    const ampOk = attrValue.split("&").slice(1).every((tail) => /^(amp|lt|gt|quot|#\d+);/.test(tail));
    assert.ok(ampOk, "raw & leaked into data-head-assets");

    // And confirm the encoded forms ARE present (proves we exercised the
    // pipeline, not just an empty payload).
    assert.match(attrValue, /&lt;/);
    assert.match(attrValue, /&gt;/);
    assert.match(attrValue, /&quot;/);
    assert.match(attrValue, /&amp;/);
  });
});
