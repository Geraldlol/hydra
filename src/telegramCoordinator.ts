import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile, ensureFile, readJsonlGuarded, serializePerFile } from "./fileQueue";
import type { TelegramUpdateMessage } from "./telegram";

export interface TelegramRoutingRecord {
  messageId: number;
  botKey: string;
  chatId: string;
  roomSessionId: string;
  roomToken: string;
  workspace: string;
  timestamp: string;
}

export interface TelegramInboxRecord {
  id: string;
  updateId: number;
  botKey: string;
  chatId: string;
  roomSessionId: string;
  workspace: string;
  command: string;
  message: TelegramUpdateMessage;
  receivedAt: string;
}

export interface TelegramInboxState {
  seenIds: string[];
}

export interface TelegramOffsetState {
  offset?: number;
}

interface TelegramLeaseRecord {
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface TelegramCoordinatorPaths {
  dir: string;
  lockFile: string;
  offsetFile: string;
  routingFile: string;
  inboxFile: string;
}

const TELEGRAM_RECENT_RECORD_LIMIT = 500;

export function telegramBotKey(botToken: string): string {
  return crypto.createHash("sha256").update(botToken.trim()).digest("hex").slice(0, 16);
}

export function telegramRoomToken(sessionId: string): string {
  // Why: tokens are only a short manual fallback; direct reply routing uses Telegram message IDs.
  return sessionId.replace(/[^A-Za-z0-9]/g, "").slice(-8);
}

export function telegramCoordinatorPaths(botToken: string): TelegramCoordinatorPaths {
  const botKey = telegramBotKey(botToken);
  const dir = path.join(globalHydraDir(), "telegram", botKey);
  return {
    dir,
    lockFile: path.join(dir, "poller.lock.json"),
    offsetFile: path.join(dir, "offset.json"),
    routingFile: path.join(dir, "routing.jsonl"),
    inboxFile: path.join(dir, "inbox.jsonl"),
  };
}

export async function ensureTelegramCoordinator(paths: TelegramCoordinatorPaths): Promise<void> {
  await ensureFile(paths.offsetFile, "{}\n");
  await ensureFile(paths.routingFile, "");
  await ensureFile(paths.inboxFile, "");
}

export async function appendTelegramRoutingRecord(paths: TelegramCoordinatorPaths, record: TelegramRoutingRecord): Promise<void> {
  await appendJsonl(paths.routingFile, record);
}

export async function findTelegramRoutingRecord(
  paths: TelegramCoordinatorPaths,
  input: { messageId?: number; chatId: string; roomToken?: string }
): Promise<TelegramRoutingRecord | undefined> {
  const records = await readJsonlGuarded(paths.routingFile, isTelegramRoutingRecord, { limit: TELEGRAM_RECENT_RECORD_LIMIT });
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.chatId !== input.chatId) continue;
    if (typeof input.messageId === "number" && record.messageId === input.messageId) return record;
    if (input.roomToken && record.roomToken === input.roomToken) return record;
  }
  return undefined;
}

export async function appendTelegramInboxRecord(paths: TelegramCoordinatorPaths, record: TelegramInboxRecord): Promise<void> {
  await appendJsonl(paths.inboxFile, record);
}

export async function readTelegramInboxForRoom(
  paths: TelegramCoordinatorPaths,
  input: { roomSessionId: string; stateFile: string }
): Promise<TelegramInboxRecord[]> {
  const state = await readTelegramInboxState(input.stateFile);
  const seen = new Set(state.seenIds);
  const records = (await readJsonlGuarded(paths.inboxFile, isTelegramInboxRecord, { limit: TELEGRAM_RECENT_RECORD_LIMIT }))
    .filter((record) => record.roomSessionId === input.roomSessionId && !seen.has(record.id));
  if (records.length) {
    for (const record of records) seen.add(record.id);
    await writeTelegramInboxState(input.stateFile, { seenIds: Array.from(seen).slice(-TELEGRAM_RECENT_RECORD_LIMIT) });
  }
  return records;
}

export async function readTelegramOffset(paths: TelegramCoordinatorPaths): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(paths.offsetFile, "utf8")) as TelegramOffsetState;
    return typeof parsed.offset === "number" ? parsed.offset : undefined;
  } catch {
    // JSONL hand-edit resilience; a corrupt global offset bootstraps again.
    return undefined;
  }
}

export async function writeTelegramOffset(paths: TelegramCoordinatorPaths, offset: number): Promise<void> {
  await atomicWriteFile(paths.offsetFile, `${JSON.stringify({ offset }, null, 2)}\n`);
}

export async function withTelegramPollerLease<T>(
  paths: TelegramCoordinatorPaths,
  ownerId: string,
  ttlMs: number,
  work: () => Promise<T>
): Promise<T | undefined> {
  await fs.mkdir(paths.dir, { recursive: true });
  const now = Date.now();
  try {
    const existing = JSON.parse(await fs.readFile(paths.lockFile, "utf8")) as Partial<TelegramLeaseRecord>;
    if (typeof existing.expiresAt === "string" && Date.parse(existing.expiresAt) < now) {
      await fs.rm(paths.lockFile, { force: true });
    }
  } catch {
    // Missing or corrupt lease files are handled by attempting a fresh lock.
  }

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(paths.lockFile, "wx");
    const lease: TelegramLeaseRecord = {
      ownerId,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`, "utf8");
    await handle.close();
    handle = undefined;
    try {
      return await work();
    } finally {
      await fs.rm(paths.lockFile, { force: true });
    }
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    if (err instanceof Error && "code" in err && err.code === "EEXIST") return undefined;
    throw err;
  }
}

async function readTelegramInboxState(stateFile: string): Promise<TelegramInboxState> {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile, "utf8")) as Partial<TelegramInboxState>;
    return Array.isArray(parsed.seenIds)
      ? { seenIds: parsed.seenIds.filter((id): id is string => typeof id === "string") }
      : { seenIds: [] };
  } catch {
    // First run or hand-edit damage; reprocessing old inbox records is safer than dropping commands.
    return { seenIds: [] };
  }
}

async function writeTelegramInboxState(stateFile: string, state: TelegramInboxState): Promise<void> {
  await atomicWriteFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await serializePerFile(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
  });
}

function globalHydraDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "hydra");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hydra");
}

function isTelegramRoutingRecord(value: unknown): value is TelegramRoutingRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.messageId === "number" &&
    typeof record.botKey === "string" &&
    typeof record.chatId === "string" &&
    typeof record.roomSessionId === "string" &&
    typeof record.roomToken === "string" &&
    typeof record.workspace === "string" &&
    typeof record.timestamp === "string";
}

function isTelegramInboxRecord(value: unknown): value is TelegramInboxRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" &&
    typeof record.updateId === "number" &&
    typeof record.botKey === "string" &&
    typeof record.chatId === "string" &&
    typeof record.roomSessionId === "string" &&
    typeof record.workspace === "string" &&
    typeof record.command === "string" &&
    typeof record.receivedAt === "string" &&
    isTelegramUpdateMessage(record.message);
}

function isTelegramUpdateMessage(value: unknown): value is TelegramUpdateMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (typeof message.messageId === "number" || message.messageId === undefined) &&
    (typeof message.replyToMessageId === "number" || message.replyToMessageId === undefined) &&
    typeof message.chatId === "string" &&
    typeof message.text === "string" &&
    (typeof message.from === "string" || message.from === undefined) &&
    (typeof message.fromIsBot === "boolean" || message.fromIsBot === undefined);
}
