import { describe, test } from "node:test";
import type { TestContext } from "node:test";
import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import https = require("node:https");
import { PassThrough } from "node:stream";
import {
  buildDecisionNotificationHtml,
  escapeTelegramHtml,
  extractTelegramInboundCommand,
  getTelegramUpdates,
  sendTelegramMessage,
} from "../src/telegram";

function installTelegramHttpsMock(t: TestContext, responseBody: string, statusCode = 200): { bodies: string[] } {
  const bodies: string[] = [];
  t.mock.method(https, "request", ((url: string | URL, options: https.RequestOptions, callback?: (res: IncomingMessage) => void) => {
    assert.match(String(url), /^https:\/\/api\.telegram\.org\//);
    assert.equal(options.family, 4);
    const req = new EventEmitter() as ClientRequest;
    let body = "";
    req.write = ((chunk: string | Buffer) => {
      body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      return true;
    }) as ClientRequest["write"];
    req.end = ((callbackArg?: () => void) => {
      queueMicrotask(() => {
        bodies.push(body);
        const stream = new PassThrough();
        const res = stream as unknown as IncomingMessage;
        res.statusCode = statusCode;
        callback?.(res);
        stream.end(responseBody);
        callbackArg?.();
      });
      return req;
    }) as ClientRequest["end"];
    req.setTimeout = (() => req) as ClientRequest["setTimeout"];
    req.destroy = ((error?: Error) => {
      if (error) queueMicrotask(() => req.emit("error", error));
      return req;
    }) as ClientRequest["destroy"];
    return req;
  }) as typeof https.request);
  return { bodies };
}

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
      roomToken: "abc123",
      timestamp: "2026-05-12T16:00:00Z",
    });
    assert.match(html, /<b>Hydra needs you<\/b>/);
    assert.match(html, /codex \(opener\)/);
    assert.match(html, /Approve push to origin\/main\?/);
    assert.match(html, /<code>Hydra runs `git push origin main`<\/code>/);
    assert.match(html, /Push now; the build is green/);
    assert.match(html, /<b>Room:<\/b> <code>abc123<\/code>/);
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

describe("Telegram API transport", () => {
  test("falls back to IPv4 node:https when fetch cannot send a Telegram message", async (t) => {
    t.mock.method(globalThis, "fetch", (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    const httpsMock = installTelegramHttpsMock(t, JSON.stringify({ ok: true, result: { message_id: 123 } }));

    const result = await sendTelegramMessage({ botToken: "123:test-token", chatId: "456" }, "Hydra ping");

    assert.deepEqual(result, { ok: true, status: 200, messageId: 123 });
    assert.equal(httpsMock.bodies.length, 1);
    assert.match(httpsMock.bodies[0] ?? "", /"chat_id":"456"/);
    assert.match(httpsMock.bodies[0] ?? "", /"text":"Hydra ping"/);
  });

  test("falls back to IPv4 node:https when fetch cannot poll Telegram updates", async (t) => {
    t.mock.method(globalThis, "fetch", (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    installTelegramHttpsMock(t, JSON.stringify({
      ok: true,
      result: [
        {
          update_id: 77,
          message: {
            message_id: 9,
            text: "/hydra continue",
            chat: { id: 456 },
            from: { id: 123, first_name: "Alice" },
          },
        },
      ],
    }));

    const result = await getTelegramUpdates({ botToken: "123:test-token" }, { offset: 76, limit: 1, timeoutSeconds: 0 });

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.updates[0]?.updateId, 77);
    assert.equal(result.updates[0]?.message?.chatId, "456");
    assert.equal(result.updates[0]?.message?.text, "/hydra continue");
    assert.equal(result.updates[0]?.message?.fromId, "123");
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
