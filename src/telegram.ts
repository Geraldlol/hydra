export interface TelegramConfig {
  /** Bot token from BotFather, e.g. "123456789:ABCDEF...". */
  botToken: string;
  /** Chat id to send messages to (string for groups/channels, numeric for users). */
  chatId: string;
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
    const res = await fetch(url, {
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
