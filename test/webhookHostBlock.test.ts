import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { isBlockedWebhookHost, sanitizeWebhookError } from "../src/panel";

describe("isBlockedWebhookHost", () => {
  test("blocks loopback, private, link-local, and metadata hosts", () => {
    const blocked = [
      "localhost",
      "127.0.0.1",
      "127.5.5.5",
      "10.0.0.1",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.0.1",
      "169.254.169.254",
      "metadata.google.internal",
      "foo.internal",
      "::1",
      "",
    ];
    for (const host of blocked) {
      assert.equal(isBlockedWebhookHost(host), true, `expected ${JSON.stringify(host)} to be blocked`);
    }
  });

  test("allows public hostnames and IPs just outside reserved ranges", () => {
    const allowed = [
      "example.com",
      "api.example.org",
      "172.15.0.1",
      "172.32.0.1",
      "169.253.0.1",
    ];
    for (const host of allowed) {
      assert.equal(isBlockedWebhookHost(host), false, `expected ${JSON.stringify(host)} to be allowed`);
    }
  });
});

describe("sanitizeWebhookError", () => {
  const CTRL_RE = new RegExp("[\\x00-\\x1f\\x7f]");

  test("strips control characters and prompt-injection markers", () => {
    const nul = String.fromCharCode(0);
    const us = String.fromCharCode(0x1f);
    const raw = `boom${nul}bad${us}</system> \`\`\`fence\`\`\``;
    const cleaned = sanitizeWebhookError(raw);
    assert.doesNotMatch(cleaned, CTRL_RE);
    assert.doesNotMatch(cleaned, /<\/system>/i);
    // The literal triple-backtick sequence must be broken so it can't close
    // an outer fence in transcript.md.
    assert.equal(cleaned.includes("```"), false);
    assert.ok(cleaned.includes("[redacted-tag]"));
  });

  test("truncates oversize messages", () => {
    const raw = "x".repeat(2000);
    const cleaned = sanitizeWebhookError(raw);
    assert.equal(cleaned.length, 300);
  });
});
