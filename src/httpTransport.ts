import type { Invocation } from "./agentAdapter";
import type { RunResult } from "./agents";
import { appendBoundedStream, MAX_AGENT_STDOUT_BYTES, type BoundedStreamState } from "./agents";

export interface HttpAgentResult extends RunResult {
  rawBody: string;
}

type HttpInvocation = Extract<Invocation, { transport: "http" }>;

interface OpenAiStreamChunk {
  choices?: Array<{ delta?: { content?: unknown } }>;
  usage?: unknown;
}

/**
 * Parse an SSE body into the assembled assistant text plus the raw JSON text
 * of whichever chunk carried token usage (if any). Tolerant of blank lines,
 * the terminal `data: [DONE]` sentinel, and non-JSON keep-alive lines.
 */
export function assembleSseText(sseBody: string): { text: string; usageJson: string | undefined } {
  let text = "";
  let usageJson: string | undefined;
  for (const rawLine of sseBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as OpenAiStreamChunk;
      const delta = obj.choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
      if (obj.usage) usageJson = payload;
    } catch {
      // Non-JSON keep-alive/comment line (e.g. SSE `: ping`) — skip.
    }
  }
  return { text, usageJson };
}

function cancelledResult(): HttpAgentResult {
  return { stdout: "", stderr: "", exitCode: null, timedOut: false, cancelled: true, rawBody: "" };
}

/** Read a response body through `cap` so a huge non-streaming or error body
 *  can't buffer unbounded memory before we get a chance to slice/parse it.
 *  Falls back to `res.text()` when the runtime's fetch doesn't expose a body
 *  reader (rare) — guarded by `content-length` so a body that's declared
 *  huge upfront is refused instead of buffered in one shot. */
async function readBoundedText(res: Response, cap: number, marker: string): Promise<string> {
  if (!res.body) {
    const declaredLength = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > cap) return `\n${marker}\n`;
    return res.text().catch(() => "");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const state: BoundedStreamState = { text: "", truncated: false };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    appendBoundedStream(state, decoder.decode(value, { stream: true }), cap, marker);
    if (state.truncated) {
      void reader.cancel().catch(() => {
        // Reader already closed/errored on our own early-stop — nothing to clean up.
      });
      break;
    }
  }
  if (!state.truncated) state.text += decoder.decode();
  return state.text;
}

/** Pull `choices[0].message.content` out of a non-streaming chat-completion
 *  JSON body; falls back to the raw text for endpoints that reply in plain
 *  text instead of the OpenAI JSON envelope. */
function extractNonStreamingContent(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
  } catch {
    // Not JSON — endpoint replied with plain text.
  }
  return rawBody;
}

export async function runHttpAgent(
  invocation: HttpInvocation,
  opts: { timeoutMs: number; signal: AbortSignal; onChunk?: (text: string) => void; fetchImpl?: typeof fetch },
): Promise<HttpAgentResult> {
  if (opts.signal.aborted) return cancelledResult();

  const doFetch = opts.fetchImpl ?? fetch;
  // Chain the caller's AbortSignal with an internal timeout controller: either
  // firing aborts the same underlying fetch/stream-read; `timedOut` records
  // which one fired so the caller can tell a deadline apart from a user Stop.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal.addEventListener("abort", onAbort, { once: true });
  const hasTimeout = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0;
  let timedOut = false;
  const timer = hasTimeout
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, opts.timeoutMs)
    : undefined;

  const state: BoundedStreamState = { text: "", truncated: false };
  const marker = `\n[Hydra: HTTP response truncated at ${MAX_AGENT_STDOUT_BYTES} bytes]\n`;

  try {
    const res = await doFetch(invocation.url, {
      method: invocation.method,
      headers: invocation.headers,
      body: JSON.stringify(invocation.body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = (await readBoundedText(res, MAX_AGENT_STDOUT_BYTES, marker).catch(() => "")).slice(0, 4000);
      return { stdout: "", stderr: `HTTP ${res.status}: ${errText || res.statusText}`, exitCode: res.status, timedOut, cancelled: false, rawBody: errText };
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream") && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = "";
      let usageJson: string | undefined;
      let stopped = false;
      const stopReading = () => {
        stopped = true;
        void reader.cancel().catch(() => {
          // Reader already closed/errored on our own early-stop — nothing to clean up.
        });
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        // Emit deltas as complete SSE events (double-newline delimited) arrive.
        let idx: number;
        while ((idx = sseBuf.indexOf("\n\n")) >= 0) {
          const event = sseBuf.slice(0, idx);
          sseBuf = sseBuf.slice(idx + 2);
          const { text, usageJson: eventUsage } = assembleSseText(event);
          if (eventUsage) usageJson = eventUsage;
          if (text) {
            appendBoundedStream(state, text, MAX_AGENT_STDOUT_BYTES, marker);
            opts.onChunk?.(text);
          }
          if (state.truncated) {
            // Already at the output cap — stop pulling more network data
            // we'd only have to discard.
            stopReading();
            break;
          }
        }
        if (stopped) break;
        // Why: bound the RAW buffer independent of delimiter position. A
        // server that sends one arbitrarily large `data:` line — or never
        // emits a blank-line delimiter at all — would otherwise grow
        // `sseBuf` without bound while we wait for a "\n\n" that may never
        // arrive. `appendBoundedStream` only caps the *extracted* text, so
        // this raw-length check is the independent cap for the pre-delimiter
        // buffer itself.
        if (sseBuf.length > MAX_AGENT_STDOUT_BYTES) {
          const { text, usageJson: eventUsage } = assembleSseText(sseBuf);
          if (eventUsage) usageJson = eventUsage;
          if (text) {
            appendBoundedStream(state, text, MAX_AGENT_STDOUT_BYTES, marker);
            opts.onChunk?.(text);
          }
          if (!state.truncated) {
            state.truncated = true;
            state.text += `\n${marker}\n`;
          }
          sseBuf = "";
          stopReading();
          break;
        }
      }
      // Why: flush any bytes TextDecoder buffered internally in case the
      // stream ended mid-multi-byte-sequence (a truncated connection) —
      // the spec-recommended decode() no-arg call at end-of-stream.
      sseBuf += decoder.decode();
      // Flush a trailing partial event left in the buffer (server closed the
      // connection without a final blank-line delimiter).
      const { text: tailText, usageJson: tailUsage } = assembleSseText(sseBuf);
      if (tailUsage) usageJson = tailUsage;
      if (tailText) {
        appendBoundedStream(state, tailText, MAX_AGENT_STDOUT_BYTES, marker);
        opts.onChunk?.(tailText);
      }
      const rawBody = JSON.stringify({
        choices: [{ message: { content: state.text } }],
        ...(usageJson ? { usage: (JSON.parse(usageJson) as { usage?: unknown }).usage } : {}),
      });
      return { stdout: state.text, stderr: "", exitCode: 0, timedOut, cancelled: false, rawBody };
    }

    // Non-streaming: single JSON object (or plain text).
    const rawBody = await readBoundedText(res, MAX_AGENT_STDOUT_BYTES, marker);
    const content = extractNonStreamingContent(rawBody);
    if (content) opts.onChunk?.(content);
    return { stdout: content, stderr: "", exitCode: 0, timedOut, cancelled: false, rawBody };
  } catch (err) {
    if (controller.signal.aborted) {
      // Timeout or external Stop fired mid-request/mid-stream: keep whatever
      // text streamed in before the abort rather than discarding a partial
      // reply (mirrors runAgent's stdoutState handling in agents.ts).
      return {
        stdout: state.text,
        stderr: timedOut ? `HTTP request timed out after ${opts.timeoutMs}ms` : "",
        exitCode: null,
        timedOut,
        cancelled: !timedOut,
        rawBody: "",
      };
    }
    return { stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: null, timedOut, cancelled: false, rawBody: "" };
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal.removeEventListener("abort", onAbort);
  }
}
