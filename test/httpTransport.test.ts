import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { runHttpAgent, assembleSseText } from "../src/httpTransport";
import { MAX_AGENT_STDOUT_BYTES } from "../src/agents";
import type { Invocation } from "../src/agentAdapter";

const inv: Extract<Invocation, { transport: "http" }> = {
  transport: "http", url: "http://localhost:11434/v1/chat/completions", method: "POST",
  headers: { "Content-Type": "application/json" }, body: { model: "m", messages: [] },
};

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// Builds a Response whose body streams `totalChars` filler bytes (no
// "data:" prefix and no "\n\n" delimiter anywhere) in `chunkSize`-sized
// pieces, and exposes how many characters the source actually produced
// before the stream stopped being pulled — lets a test prove `runHttpAgent`
// stopped reading early instead of draining (or hanging on) the full body.
function fillerStream(totalChars: number, chunkSize: number, contentType: string) {
  const encoder = new TextEncoder();
  const chunkText = "x".repeat(chunkSize);
  let produced = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced >= totalChars) {
        controller.close();
        return;
      }
      const remaining = totalChars - produced;
      const piece = remaining >= chunkSize ? chunkText : chunkText.slice(0, remaining);
      controller.enqueue(encoder.encode(piece));
      produced += piece.length;
    },
  });
  const response = new Response(stream, { status: 200, headers: { "content-type": contentType } });
  return { response, producedSoFar: () => produced };
}

// Mimics real `fetch`: never settles on its own, only rejects once the
// AbortSignal passed in `init` fires. Lets timeout/abort tests run fast
// without a real network call or a genuinely hanging promise.
function hangingFetch(): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  }) as unknown as typeof fetch;
}

describe("http transport", () => {
  test("assembleSseText concatenates content deltas and captures the usage chunk", () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n' +
      "data: [DONE]\n\n";
    const { text, usageJson } = assembleSseText(sse);
    assert.equal(text, "Hello");
    assert.ok(usageJson && JSON.parse(usageJson).usage.prompt_tokens === 5);
  });

  test("non-streaming JSON response returns assistant text and raw body", async () => {
    const fetchImpl = (async () => jsonResponse({ choices: [{ message: { content: "the answer" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } })) as unknown as typeof fetch;
    const res = await runHttpAgent(inv, { timeoutMs: 5000, signal: new AbortController().signal, fetchImpl });
    assert.equal(res.stdout, "the answer");
    assert.equal(res.exitCode, 0);
    assert.match(res.rawBody, /the answer/);
    assert.equal(res.timedOut, false);
  });

  test("HTTP error status surfaces on stderr with a non-zero exit code", async () => {
    const fetchImpl = (async () => new Response("model not found", { status: 404, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    const res = await runHttpAgent(inv, { timeoutMs: 5000, signal: new AbortController().signal, fetchImpl });
    assert.equal(res.exitCode, 404);
    assert.match(res.stderr, /model not found|404/);
  });

  test("an already-aborted signal returns cancelled without calling fetch", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let called = false;
    const fetchImpl = (async () => { called = true; return jsonResponse({}); }) as unknown as typeof fetch;
    const res = await runHttpAgent(inv, { timeoutMs: 5000, signal: ctrl.signal, fetchImpl });
    assert.equal(res.cancelled, true);
    assert.equal(called, false);
  });

  test("zero timeoutMs disables the wall-clock cap", async () => {
    const fetchImpl = (async () => jsonResponse({ choices: [{ message: { content: "ok" } }] })) as unknown as typeof fetch;
    const res = await runHttpAgent(inv, { timeoutMs: 0, signal: new AbortController().signal, fetchImpl });
    assert.equal(res.timedOut, false);
    assert.equal(res.stdout, "ok");
  });

  test("streaming SSE response emits onChunk increments and synthesizes rawBody with usage", async () => {
    const events = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchImpl = (async () => sseResponse(events)) as unknown as typeof fetch;
    const chunks: string[] = [];
    const res = await runHttpAgent(inv, {
      timeoutMs: 5000,
      signal: new AbortController().signal,
      fetchImpl,
      onChunk: (c) => chunks.push(c),
    });
    assert.equal(res.stdout, "Hello");
    assert.equal(chunks.join(""), "Hello");
    assert.equal(res.exitCode, 0);
    assert.equal(res.timedOut, false);
    const parsed = JSON.parse(res.rawBody) as { choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number } };
    assert.equal(parsed.choices[0]?.message.content, "Hello");
    assert.equal(parsed.usage.prompt_tokens, 5);
  });

  test("streams CRLF-delimited SSE events before the response closes", async () => {
    const encoder = new TextEncoder();
    const chunks: string[] = [];
    let firstEventArrivedBeforeClose = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\r\n\r\n'));
        setTimeout(() => {
          firstEventArrivedBeforeClose = chunks.join("") === "Hel";
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"lo"}}]}\r\n\r\n'));
          controller.close();
        }, 0);
      },
    });
    const fetchImpl = (async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;

    const res = await runHttpAgent(inv, {
      timeoutMs: 5000,
      signal: new AbortController().signal,
      fetchImpl,
      onChunk: (chunk) => chunks.push(chunk),
    });

    assert.equal(firstEventArrivedBeforeClose, true);
    assert.equal(chunks.join(""), "Hello");
    assert.equal(res.stdout, "Hello");
  });

  test("bounds live SSE chunks as tightly as the accumulated result", async () => {
    const oversized = "x".repeat(MAX_AGENT_STDOUT_BYTES + 1024);
    const fetchImpl = (async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: oversized } }] })}\n\n`,
    ])) as unknown as typeof fetch;
    const chunks: string[] = [];

    const res = await runHttpAgent(inv, {
      timeoutMs: 5000,
      signal: new AbortController().signal,
      fetchImpl,
      onChunk: (chunk) => chunks.push(chunk),
    });

    assert.match(res.stdout, /truncated/);
    assert.equal(chunks.join(""), res.stdout);
    assert.ok(chunks.join("").length <= MAX_AGENT_STDOUT_BYTES + 200);
  });

  test("an oversized, undelimited SSE stream is bounded and stops reading early (no hang)", async () => {
    const totalChars = MAX_AGENT_STDOUT_BYTES + 8 * 1024 * 1024; // ~24MB, well past the cap
    const chunkSize = 1024 * 1024; // 1MB per read, no "data:" prefix and no "\n\n" ever
    const { response, producedSoFar } = fillerStream(totalChars, chunkSize, "text/event-stream");
    const fetchImpl = (async () => response) as unknown as typeof fetch;
    const res = await runHttpAgent(inv, { timeoutMs: 5000, signal: new AbortController().signal, fetchImpl });
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.length <= MAX_AGENT_STDOUT_BYTES + 200, `stdout should be bounded, was ${res.stdout.length}`);
    assert.match(res.stdout, /truncated/);
    // The source was never asked to produce the full oversized body — proves
    // runHttpAgent stopped reading once the raw buffer crossed the cap
    // instead of draining (or hanging on) the rest of the stream.
    assert.ok(producedSoFar() < totalChars, `expected an early stop, but all ${totalChars} chars were produced`);
  });

  test("an oversized non-streaming response body is bounded, not fully buffered", async () => {
    const totalChars = MAX_AGENT_STDOUT_BYTES + 8 * 1024 * 1024; // ~24MB, well past the cap
    const chunkSize = 1024 * 1024;
    const { response, producedSoFar } = fillerStream(totalChars, chunkSize, "application/json");
    const fetchImpl = (async () => response) as unknown as typeof fetch;
    const res = await runHttpAgent(inv, { timeoutMs: 5000, signal: new AbortController().signal, fetchImpl });
    assert.equal(res.exitCode, 0);
    assert.ok(res.rawBody.length <= MAX_AGENT_STDOUT_BYTES + 200, `rawBody should be bounded, was ${res.rawBody.length}`);
    assert.ok(res.stdout.length <= MAX_AGENT_STDOUT_BYTES + 200, `stdout should be bounded, was ${res.stdout.length}`);
    assert.match(res.stdout, /truncated/);
    assert.ok(producedSoFar() < totalChars, `expected an early stop, but all ${totalChars} chars were produced`);
  });

  test("reassembles an SSE delta split across two stream reads", async () => {
    const full = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
    const splitAt = 20;
    const fetchImpl = (async () => sseResponse([full.slice(0, splitAt), full.slice(splitAt)])) as unknown as typeof fetch;
    const res = await runHttpAgent(inv, { timeoutMs: 5000, signal: new AbortController().signal, fetchImpl });
    assert.equal(res.stdout, "Hello");
  });

  test("timeout aborts the fetch and reports timedOut without cancelled", async () => {
    const res = await runHttpAgent(inv, { timeoutMs: 30, signal: new AbortController().signal, fetchImpl: hangingFetch() });
    assert.equal(res.timedOut, true);
    assert.equal(res.cancelled, false);
    assert.equal(res.exitCode, null);
  });

  test("external abort mid-request reports cancelled without timedOut", async () => {
    const ctrl = new AbortController();
    const promise = runHttpAgent(inv, { timeoutMs: 5000, signal: ctrl.signal, fetchImpl: hangingFetch() });
    ctrl.abort();
    const res = await promise;
    assert.equal(res.cancelled, true);
    assert.equal(res.timedOut, false);
    assert.equal(res.exitCode, null);
  });

  test("timeout while reading an HTTP error body is classified as a timeout", async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        },
      });
      return new Response(stream, { status: 503, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;

    const res = await runHttpAgent(inv, {
      timeoutMs: 30,
      signal: new AbortController().signal,
      fetchImpl,
    });

    assert.equal(res.timedOut, true);
    assert.equal(res.cancelled, false);
    assert.equal(res.exitCode, null);
  });

  test("a throwing live consumer does not turn a successful response into a failure", async () => {
    const fetchImpl = (async () => jsonResponse({
      choices: [{ message: { content: "still succeeds" } }],
    })) as unknown as typeof fetch;

    const res = await runHttpAgent(inv, {
      timeoutMs: 5000,
      signal: new AbortController().signal,
      fetchImpl,
      onChunk: () => {
        throw new Error("disposed webview");
      },
    });

    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout, "still succeeds");
  });

  test("a network failure does not leak the Authorization header value", async () => {
    const secretInv: Extract<Invocation, { transport: "http" }> = {
      ...inv,
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-super-secret-123" },
    };
    const fetchImpl = (async () => { throw new Error("getaddrinfo ENOTFOUND localhost"); }) as unknown as typeof fetch;
    const res = await runHttpAgent(secretInv, { timeoutMs: 5000, signal: new AbortController().signal, fetchImpl });
    assert.equal(res.exitCode, null);
    assert.ok(!res.stderr.includes("sk-super-secret-123"));
    assert.ok(!res.rawBody.includes("sk-super-secret-123"));
  });
});
