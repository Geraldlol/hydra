import * as https from "node:https";

export interface TelegramConfig {
  /** Bot token from BotFather, e.g. "123456789:ABCDEF...". */
  botToken: string;
  /** Chat id to send messages to (string for groups/channels, numeric for users). */
  chatId: string;
}

function parseTelegramUpdate(value: unknown): TelegramUpdate | undefined {
  if (!value || typeof value !== "object") return undefined;
  const update = value as {
    update_id?: unknown;
    message?: {
      message_id?: unknown;
      text?: unknown;
      caption?: unknown;
      chat?: { id?: unknown };
      from?: { id?: unknown; first_name?: unknown; username?: unknown; is_bot?: unknown };
      reply_to_message?: { message_id?: unknown };
    };
  };
  if (typeof update.update_id !== "number") return undefined;
  const text = typeof update.message?.text === "string"
    ? update.message.text
    : typeof update.message?.caption === "string"
      ? update.message.caption
      : undefined;
  const chatId = update.message?.chat?.id;
  const result: TelegramUpdate = { updateId: update.update_id };
  if (text && (typeof chatId === "number" || typeof chatId === "string")) {
    const firstName = typeof update.message?.from?.first_name === "string" ? update.message.from.first_name : "";
    const username = typeof update.message?.from?.username === "string" ? `@${update.message.from.username}` : "";
    result.message = {
      messageId: typeof update.message?.message_id === "number" ? update.message.message_id : undefined,
      chatId: String(chatId),
      text,
      replyToMessageId: typeof update.message?.reply_to_message?.message_id === "number"
        ? update.message.reply_to_message.message_id
        : undefined,
      from: [firstName, username].filter(Boolean).join(" ").trim() || undefined,
      // Telegram user ids are numbers; store as a string so it compares cleanly
      // against the string allowlist and survives JSON round-trips in the inbox.
      fromId: typeof update.message?.from?.id === "number"
        ? String(update.message.from.id)
        : typeof update.message?.from?.id === "string"
          ? update.message.from.id
          : undefined,
      fromIsBot: update.message?.from?.is_bot === true,
    };
  }
  return result;
}

function isTelegramUpdate(value: TelegramUpdate | undefined): value is TelegramUpdate {
  return !!value;
}

export interface TelegramSendResult {
  ok: boolean;
  /** Telegram-side message_id when ok, useful for follow-up edits. */
  messageId?: number;
  /** Human-readable failure cause when !ok. */
  error?: string;
  /** HTTP status, if the request reached Telegram. */
  status?: number;
}

export interface TelegramUpdateMessage {
  messageId?: number;
  replyToMessageId?: number;
  chatId: string;
  text: string;
  from?: string;
  /** Telegram numeric user id, as a string. Undefined when the update omits `from`. */
  fromId?: string;
  fromIsBot?: boolean;
}

export interface TelegramUpdate {
  updateId: number;
  message?: TelegramUpdateMessage;
}

export interface TelegramUpdatesResult {
  ok: boolean;
  updates: TelegramUpdate[];
  error?: string;
  status?: number;
}

interface TelegramRequestOptions {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

interface TelegramHttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

async function telegramRequest(url: string, options: TelegramRequestOptions): Promise<TelegramHttpResponse> {
  try {
    return await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    // Node's undici fetch can fail Telegram's dual-stack hostname path on some
    // Windows networks while node:https succeeds when pinned to IPv4.
    return await telegramHttpsRequest(url, options);
  }
}

function telegramHttpsRequest(url: string, options: TelegramRequestOptions): Promise<TelegramHttpResponse> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException("This operation was aborted", "AbortError"));
      return;
    }

    const req = https.request(
      new URL(url),
      {
        method: options.method,
        headers: options.headers,
        family: 4,
        timeout: 60_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => body,
            json: async () => JSON.parse(body),
          });
        });
        res.on("error", reject);
      }
    );

    const abort = (): void => {
      req.destroy(new DOMException("This operation was aborted", "AbortError"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Telegram HTTPS request timed out")));
    req.on("close", () => options.signal?.removeEventListener("abort", abort));
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Send a Markdown-formatted message via the Telegram Bot API. Uses the
 * MarkdownV2-safe subset by default (HTML mode actually — simpler escaping)
 * to keep mention/heading/code formatting predictable across clients.
 *
 * Returns an object describing the outcome; callers should NOT throw on
 * failure — Telegram outages must not break the normal Hydra flow.
 */
export async function sendTelegramMessage(
  config: TelegramConfig,
  text: string,
  options: { parseMode?: "HTML" | "MarkdownV2" | "Markdown"; disableNotification?: boolean } = {},
): Promise<TelegramSendResult> {
  const token = config.botToken.trim();
  const chatId = config.chatId.trim();
  if (!token || !chatId) {
    return { ok: false, error: "Telegram bot token or chat id is empty" };
  }
  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: options.parseMode ?? "HTML",
    disable_notification: options.disableNotification ?? false,
    disable_web_page_preview: true,
  };
  try {
    const res = await telegramRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: text.slice(0, 500) || `HTTP ${res.status}` };
    }
    const parsed = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id?: number }; description?: string };
    if (parsed.ok === false) {
      return { ok: false, status: res.status, error: parsed.description ?? "Telegram returned ok:false" };
    }
    return { ok: true, status: res.status, messageId: parsed.result?.message_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getTelegramUpdates(
  config: Pick<TelegramConfig, "botToken">,
  options: { offset?: number; limit?: number; timeoutSeconds?: number; signal?: AbortSignal } = {},
): Promise<TelegramUpdatesResult> {
  const token = config.botToken.trim();
  if (!token) {
    return { ok: false, updates: [], error: "Telegram bot token is empty" };
  }
  const params = new URLSearchParams();
  if (typeof options.offset === "number") params.set("offset", String(options.offset));
  params.set("limit", String(Math.max(1, Math.min(100, options.limit ?? 25))));
  params.set("timeout", String(Math.max(0, Math.min(50, options.timeoutSeconds ?? 0))));
  params.set("allowed_updates", JSON.stringify(["message"]));
  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates?${params.toString()}`;
  try {
    const res = await telegramRequest(url, { method: "GET", signal: options.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, updates: [], status: res.status, error: text.slice(0, 500) || `HTTP ${res.status}` };
    }
    const parsed = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: unknown[];
      description?: string;
    };
    if (parsed.ok === false) {
      return { ok: false, updates: [], status: res.status, error: parsed.description ?? "Telegram returned ok:false" };
    }
    const updates = Array.isArray(parsed.result)
      ? parsed.result.map(parseTelegramUpdate).filter(isTelegramUpdate)
      : [];
    return { ok: true, status: res.status, updates };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { ok: false, updates: [], error: "aborted" };
    return { ok: false, updates: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export function extractTelegramInboundCommand(text: string, prefix: string): string | undefined {
  const trimmed = text.trim();
  const commandPrefix = prefix.trim();
  if (!commandPrefix) return trimmed || undefined;
  if (trimmed === commandPrefix) return "";
  if (trimmed.startsWith(`${commandPrefix} `) || trimmed.startsWith(`${commandPrefix}\n`)) {
    return trimmed.slice(commandPrefix.length).trim();
  }
  const mentionMatch = /^\/([A-Za-z0-9_]+)@([A-Za-z0-9_]+)(?:\s+|$)/.exec(trimmed);
  if (mentionMatch && commandPrefix === `/${mentionMatch[1]}`) {
    return trimmed.slice(mentionMatch[0].length).trim();
  }
  return undefined;
}

/** Escape a string for safe embedding inside HTML parse_mode. */
export function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build a compact notification body for a "decision needs user" event.
 * Uses HTML parse mode so we can bold the headline and use <code> for the
 * default action without worrying about Telegram's MarkdownV2 escaping.
 */
export interface DecisionNotificationInput {
  agent: string;
  phase?: string;
  workspace?: string;
  decisionNeededFromUser: string;
  defaultNextAction?: string;
  recommendation?: string;
  blockers?: string;
  roomToken?: string;
  timestamp: string;
}

export function buildDecisionNotificationHtml(input: DecisionNotificationInput): string {
  const lines: string[] = [];
  lines.push(`<b>Hydra needs you</b> · ${escapeTelegramHtml(input.agent)}${input.phase ? ` (${escapeTelegramHtml(input.phase)})` : ""}`);
  if (input.workspace) lines.push(`<i>${escapeTelegramHtml(shortenWorkspacePath(input.workspace))}</i>`);
  lines.push("");
  lines.push(`<b>Decision needed:</b> ${escapeTelegramHtml(input.decisionNeededFromUser)}`);
  if (input.defaultNextAction && input.defaultNextAction.trim()) {
    lines.push(`<b>Default:</b> <code>${escapeTelegramHtml(truncate(input.defaultNextAction, 300))}</code>`);
  }
  if (input.recommendation && input.recommendation.trim()) {
    lines.push(`<b>Recommendation:</b> ${escapeTelegramHtml(truncate(input.recommendation, 300))}`);
  }
  if (input.blockers && input.blockers.trim() && !/^none$/i.test(input.blockers.trim())) {
    lines.push(`<b>Blockers:</b> ${escapeTelegramHtml(truncate(input.blockers, 300))}`);
  }
  if (input.roomToken && input.roomToken.trim()) {
    lines.push(`<b>Room:</b> <code>${escapeTelegramHtml(input.roomToken.trim())}</code>`);
  }
  lines.push("");
  lines.push(`<i>${escapeTelegramHtml(input.timestamp)}</i>`);
  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  const v = value.replace(/\s+/g, " ").trim();
  return v.length <= max ? v : `${v.slice(0, max - 1).trimEnd()}…`;
}

function shortenWorkspacePath(p: string): string {
  // Show last two path segments so the user can tell rooms apart without
  // leaking the full machine path on the wire.
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join("/")}`;
}
