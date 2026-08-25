import { extractTelegramInboundCommand, type TelegramUpdate } from "./telegram";
import {
  STEERING_RELAY_LIMITS,
  isSteeringRelayTargetSelection,
  sha256Utf8,
  steeringRelayPrincipalSha256,
  type SteeringRelaySubmissionInput,
  type SteeringRelaySource,
  type SteeringTargetSelection,
} from "./steeringRelayProtocol";
import { isBoundedIdentifier, isCanonicalTimestamp, isSha256, validateSteeringText } from "./steeringProtocol";

export type TelegramSteeringConfigErrorCode =
  | "invalidBotKey"
  | "invalidChat"
  | "senderAllowlistRequired"
  | "invalidSender"
  | "invalidPrefix"
  | "invalidLifetime";

export class TelegramSteeringConfigError extends Error {
  constructor(readonly code: TelegramSteeringConfigErrorCode, message: string) {
    super(message);
    this.name = "TelegramSteeringConfigError";
  }
}

export type TelegramSteeringRejectionCode =
  | "disabled"
  | "malformedUpdate"
  | "wrongChat"
  | "unauthorizedSender"
  | "botSender"
  | "prefixMismatch"
  | "emptyMessage"
  | "messageTooLarge"
  | "invalidRoute";

export class TelegramSteeringRejectedError extends Error {
  constructor(readonly code: TelegramSteeringRejectionCode, message: string) {
    super(message);
    this.name = "TelegramSteeringRejectedError";
  }
}

export interface DisabledTelegramSteeringPolicy {
  readonly kind: "disabled";
}

export interface EnabledTelegramSteeringPolicy {
  readonly kind: "enabled";
  /** A short SHA-256 derivative such as telegramBotKey(), never the bot token. */
  readonly botKey: string;
  readonly chatId: string;
  readonly allowedSenderIds: readonly string[];
  readonly commandPrefix: string;
  readonly messageTtlMs: number;
}

export type TelegramSteeringPolicy = DisabledTelegramSteeringPolicy | EnabledTelegramSteeringPolicy;

export type TelegramSteeringConfigurationInput =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly botKey: string;
      readonly chatId: string;
      readonly allowedSenderIds: readonly string[];
      readonly commandPrefix: string;
      readonly messageTtlMs?: number;
    };

export interface TelegramSteeringRoute {
  readonly issuedAt: string;
  readonly workspaceId: string;
  readonly destinationOwnerId: string;
  readonly roomTurnId: string;
  readonly targets: readonly SteeringTargetSelection[];
}

const BOT_KEY_PATTERN = /^[a-f0-9]{16}$/;
const TELEGRAM_USER_ID_PATTERN = /^[0-9]{1,20}$/;
const COMMAND_PREFIX_PATTERN = /^\/[A-Za-z0-9_]{1,31}$/;
const MAX_CHAT_ID_CHARS = 128;
const MAX_ALLOWED_SENDERS = 64;
const DEFAULT_MESSAGE_TTL_MS = 2 * 60_000;

/**
 * Telegram steering is deliberately stricter than the legacy inbound-room
 * transport: enabling it requires both an explicit command prefix and at least
 * one exact Telegram user ID. Chat-only authorization is never sufficient for
 * a paid/live steering write.
 */
export function configureTelegramSteering(
  input: TelegramSteeringConfigurationInput,
): TelegramSteeringPolicy {
  if (!input || typeof input !== "object" || (input.enabled !== true && input.enabled !== false)) {
    throw new TelegramSteeringConfigError("invalidBotKey", "Telegram steering configuration is malformed.");
  }
  if (!input.enabled) return { kind: "disabled" };
  if (typeof input.botKey !== "string" || !BOT_KEY_PATTERN.test(input.botKey)) {
    throw new TelegramSteeringConfigError("invalidBotKey", "Telegram steering bot identity is invalid.");
  }
  if (typeof input.chatId !== "string"
    || input.chatId.length < 1
    || input.chatId.length > MAX_CHAT_ID_CHARS
    || input.chatId.trim() !== input.chatId
    || /[\u0000-\u001f\u007f]/u.test(input.chatId)) {
    throw new TelegramSteeringConfigError("invalidChat", "Telegram steering chat ID is invalid.");
  }
  if (!Array.isArray(input.allowedSenderIds) || input.allowedSenderIds.length < 1) {
    throw new TelegramSteeringConfigError(
      "senderAllowlistRequired",
      "Telegram steering requires an explicit sender allowlist.",
    );
  }
  if (input.allowedSenderIds.length > MAX_ALLOWED_SENDERS) {
    throw new TelegramSteeringConfigError("invalidSender", "Telegram steering sender allowlist is too large.");
  }
  const allowedSenderIds = input.allowedSenderIds.map((senderId) => {
    if (typeof senderId !== "string"
      || senderId.trim() !== senderId
      || !TELEGRAM_USER_ID_PATTERN.test(senderId)) {
      throw new TelegramSteeringConfigError("invalidSender", "Telegram steering sender ID is invalid.");
    }
    return senderId;
  });
  if (new Set(allowedSenderIds).size !== allowedSenderIds.length) {
    throw new TelegramSteeringConfigError("invalidSender", "Telegram steering sender allowlist contains duplicates.");
  }
  if (typeof input.commandPrefix !== "string" || !COMMAND_PREFIX_PATTERN.test(input.commandPrefix)) {
    throw new TelegramSteeringConfigError(
      "invalidPrefix",
      "Telegram steering requires a slash command prefix.",
    );
  }
  const messageTtlMs = input.messageTtlMs ?? DEFAULT_MESSAGE_TTL_MS;
  if (!Number.isSafeInteger(messageTtlMs)
    || messageTtlMs < 1_000
    || messageTtlMs > STEERING_RELAY_LIMITS.maxMessageLifetimeMs) {
    throw new TelegramSteeringConfigError("invalidLifetime", "Telegram steering message lifetime is invalid.");
  }
  return {
    kind: "enabled",
    botKey: input.botKey,
    chatId: input.chatId,
    allowedSenderIds,
    commandPrefix: input.commandPrefix,
    messageTtlMs,
  };
}

export function buildTelegramSteeringSubmission(
  policy: TelegramSteeringPolicy,
  update: TelegramUpdate,
  route: TelegramSteeringRoute,
): SteeringRelaySubmissionInput {
  if (policy.kind !== "enabled") {
    throw new TelegramSteeringRejectedError("disabled", "Telegram steering is disabled.");
  }
  if (!update
    || !Number.isSafeInteger(update.updateId)
    || update.updateId < 0
    || update.updateId >= Number.MAX_SAFE_INTEGER
    || !update.message
    || !Number.isSafeInteger(update.message.messageId)
    || (update.message.messageId as number) < 1
    || typeof update.message.text !== "string"
    || typeof update.message.chatId !== "string") {
    throw new TelegramSteeringRejectedError("malformedUpdate", "Telegram steering update is malformed.");
  }
  const message = update.message;
  if (message.fromIsBot === true) {
    throw new TelegramSteeringRejectedError("botSender", "Telegram bot-authored steering is not accepted.");
  }
  if (message.chatId !== policy.chatId) {
    throw new TelegramSteeringRejectedError("wrongChat", "Telegram steering chat is not authorized.");
  }
  if (typeof message.fromId !== "string" || !policy.allowedSenderIds.includes(message.fromId)) {
    throw new TelegramSteeringRejectedError("unauthorizedSender", "Telegram steering sender is not authorized.");
  }
  const command = extractTelegramInboundCommand(message.text, policy.commandPrefix);
  if (command === undefined) {
    throw new TelegramSteeringRejectedError("prefixMismatch", "Telegram steering command prefix does not match.");
  }
  if (!command.trim()) {
    throw new TelegramSteeringRejectedError("emptyMessage", "Telegram steering message is empty.");
  }
  try {
    validateSteeringText(command);
  } catch {
    throw new TelegramSteeringRejectedError("messageTooLarge", "Telegram steering message exceeds its bound.");
  }
  validateRoute(route);
  const principalSha256 = telegramPrincipalSha256(
    policy.botKey,
    policy.chatId,
    message.fromId,
  );
  const issuedAtMs = Date.parse(route.issuedAt);
  const expiresAt = new Date(issuedAtMs + policy.messageTtlMs).toISOString();
  return {
    workspaceId: route.workspaceId,
    destinationOwnerId: route.destinationOwnerId,
    producerId: `telegram-${policy.botKey}-${principalSha256.slice(0, 16)}`,
    // Telegram update IDs are monotonic and may begin at zero. Adding one
    // preserves ordering while satisfying the relay's positive sequence type.
    sequence: update.updateId + 1,
    issuedAt: route.issuedAt,
    expiresAt,
    source: { transport: "telegram", principalSha256 },
    intent: "steer",
    roomTurnId: route.roomTurnId,
    text: command,
    // Targets come only from the owner's authenticated advertisement. Telegram
    // text is never parsed as target, Mission, or authority metadata.
    targets: route.targets.map((target) => ({
      ...target,
      capability: { ...target.capability },
    })),
  };
}

/** Principal-only predicate for composing Telegram policy with exact relay grants. */
export function isTelegramSteeringRelaySourceAuthorized(
  policy: TelegramSteeringPolicy,
  source: SteeringRelaySource,
): boolean {
  if (policy.kind !== "enabled" || source.transport !== "telegram") return false;
  return policy.allowedSenderIds.some((senderId) =>
    telegramPrincipalSha256(policy.botKey, policy.chatId, senderId) === source.principalSha256
  );
}

export function telegramPrincipalSha256(
  botKey: string,
  chatId: string,
  senderId: string,
): string {
  if (!BOT_KEY_PATTERN.test(botKey)
    || typeof chatId !== "string"
    || chatId.length < 1
    || !TELEGRAM_USER_ID_PATTERN.test(senderId)) {
    throw new TelegramSteeringConfigError("invalidSender", "Telegram steering principal binding is invalid.");
  }
  return steeringRelayPrincipalSha256(
    "telegram",
    sha256Utf8(`hydra-telegram-steering-principal-v1\u0000${botKey}\u0000${chatId}\u0000${senderId}`),
  );
}

function validateRoute(route: TelegramSteeringRoute): void {
  if (!route
    || !isCanonicalTimestamp(route.issuedAt)
    || !isSha256(route.workspaceId)
    || !isBoundedIdentifier(route.destinationOwnerId)
    || !isBoundedIdentifier(route.roomTurnId)
    || !Array.isArray(route.targets)
    || route.targets.length < 1
    || route.targets.length > STEERING_RELAY_LIMITS.maxAdvertisementTargets
    || !route.targets.every((target) =>
      isSteeringRelayTargetSelection(target)
      && target.ownerId === route.destinationOwnerId
      && target.roomTurnId === route.roomTurnId
    )) {
    throw new TelegramSteeringRejectedError("invalidRoute", "Telegram steering route is malformed or inconsistent.");
  }
}
