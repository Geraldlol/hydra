import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { runHttpAgent, assembleSseText } from "../src/httpTransport";
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
