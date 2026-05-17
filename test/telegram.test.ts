import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { buildDecisionNotificationHtml, escapeTelegramHtml, extractTelegramInboundCommand } from "../src/telegram";

describe("escapeTelegramHtml", () => {
  test("escapes the three Telegram-significant characters and nothing else", () => {
    assert.equal(escapeTelegramHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
    assert.equal(escapeTelegramHtml("plain"), "plain");
    assert.equal(escapeTelegramHtml("'quoted' \"double\""), "'quoted' \"double\"");
  });
});

describe("buildDecisionNotificationHtml", () => {
  test("renders the headline, decision, default, recommendation, and timestamp", () => {
    const html = buildDecisionNotificationHtml({
      agent: "codex",
      phase: "opener",
      workspace: "C:\\Users\\me\\repo",
      decisionNeededFromUser: "Approve push to origin/main?",
      defaultNextAction: "Hydra runs `git push origin main`",
      recommendation: "Push now; the build is green",
      blockers: "none",
      timestamp: "2026-05-12T16:00:00Z",
    });
    assert.match(html, /<b>Hydra needs you<\/b>/);
    assert.match(html, /codex \(opener\)/);
    assert.match(html, /Approve push to origin\/main\?/);
    assert.match(html, /<code>Hydra runs `git push origin main`<\/code>/);
    assert.match(html, /Push now; the build is green/);
    // "none" blockers should be hidden so the notification stays tight.
    assert.equal(html.includes("Blockers:"), false);
    assert.match(html, /2026-05-12T16:00:00Z/);
  });

  test("escapes HTML-special characters in user content so they don't break Telegram parsing", () => {
    const html = buildDecisionNotificationHtml({
      agent: "claude",
      decisionNeededFromUser: "<script>evil</script> & more",
      timestamp: "2026-05-12T16:00:00Z",
    });
    assert.match(html, /&lt;script&gt;evil&lt;\/script&gt; &amp; more/);
    assert.equal(html.includes("<script>"), false);
  });

  test("truncates very long fields", () => {
    const big = "x".repeat(1000);
    const html = buildDecisionNotificationHtml({
      agent: "claude",
      decisionNeededFromUser: "real question",
      defaultNextAction: big,
      timestamp: "2026-05-12T16:00:00Z",
    });
    assert.ok(html.length < 1200, `expected truncation but got ${html.length} chars`);
    assert.match(html, /…/);
  });
});

describe("extractTelegramInboundCommand", () => {
  test("accepts prefixed direct and group bot commands", () => {
    assert.equal(extractTelegramInboundCommand("/hydra continue", "/hydra"), "continue");
    assert.equal(extractTelegramInboundCommand("/hydra@my_bot continue", "/hydra"), "continue");
    assert.equal(extractTelegramInboundCommand("  /hydra\ncontinue  ", "/hydra"), "continue");
  });

  test("rejects unprefixed messages unless prefix is explicitly empty", () => {
    assert.equal(extractTelegramInboundCommand("continue", "/hydra"), undefined);
    assert.equal(extractTelegramInboundCommand("continue", ""), "continue");
  });

  test("returns an empty command for a bare prefix", () => {
    assert.equal(extractTelegramInboundCommand("/hydra", "/hydra"), "");
  });
});
