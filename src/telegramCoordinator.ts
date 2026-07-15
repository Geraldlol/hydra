import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendFileSafely,
  ensureFile,
  readFileHead,
  readJsonlGuarded,
  serializePerFile,
} from "./fileQueue";
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
  token: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface TelegramPollerLease {
  readonly ownerId: string;
  readonly token: string;
  /** Aborted when the lease expires, loses the election, or is released. */
  readonly signal: AbortSignal;
}

export interface TelegramCoordinatorPaths {
  dir: string;
  lockFile: string;
  offsetDir: string;
  offsetFile: string;
  routingFile: string;
  inboxFile: string;
  roomInboxDir: string;
}

const TELEGRAM_RECENT_RECORD_LIMIT = 500;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_TELEGRAM_CONTROL_JSON_BYTES = 64 * 1024;
const MAX_TELEGRAM_INBOX_STATE_BYTES = 1024 * 1024;

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
    offsetDir: path.join(dir, "offset-acks"),
    offsetFile: path.join(dir, "offset.json"),
    routingFile: path.join(dir, "routing.jsonl"),
    inboxFile: path.join(dir, "inbox.jsonl"),
    roomInboxDir: path.join(dir, "room-inboxes"),
  };
}

export async function ensureTelegramCoordinator(paths: TelegramCoordinatorPaths): Promise<void> {
  await ensurePrivateDirectory(paths.dir);
  await ensurePrivateDirectory(paths.roomInboxDir);
  await ensureFile(paths.offsetFile, "{}\n");
  await ensureFile(paths.routingFile, "");
  await ensureFile(paths.inboxFile, "");
  await Promise.all([
    hardenPrivateFile(paths.offsetFile),
    hardenPrivateFile(paths.routingFile),
    hardenPrivateFile(paths.inboxFile),
  ]);
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
    if (!record) continue;
    if (record.chatId !== input.chatId) continue;
    if (typeof input.messageId === "number" && record.messageId === input.messageId) return record;
    if (input.roomToken && record.roomToken === input.roomToken) return record;
  }
  return undefined;
}

export async function appendTelegramInboxRecord(paths: TelegramCoordinatorPaths, record: TelegramInboxRecord): Promise<void> {
  const roomFile = telegramRoomInboxFile(paths, record.roomSessionId);
  await appendTelegramInboxRecordToFile(roomFile, record);
  // Keep the legacy aggregate during migration/support inspection. Delivery
  // reads the per-room log, so traffic for other rooms can no longer evict a
  // dormant room's unread command from a 500-record global tail.
  await appendTelegramInboxRecordToFile(paths.inboxFile, record);
}

async function appendTelegramInboxRecordToFile(filePath: string, record: TelegramInboxRecord): Promise<void> {
  await serializePerFile(filePath, async () => {
    // Why: a crash after the durable inbox append but before the offset commit
    // intentionally causes Telegram to redeliver the update. The deterministic
    // record id makes that retry idempotent instead of growing duplicate work.
    const existing = await readJsonlGuarded(filePath, isTelegramInboxRecord, { maxBytes: 32 * 1024 * 1024 });
    if (existing.some((item) => item.id === record.id)) {
      await flushTelegramFile(filePath);
      return;
    }
    await ensurePrivateDirectory(path.dirname(filePath));
    await appendFileSafely(filePath, `${JSON.stringify(record)}\n`);
    await hardenPrivateFile(filePath);
    await flushTelegramFile(filePath);
  });
}

/** Persist routed work before advancing Telegram's destructive update offset. */
export async function persistTelegramInboxRecordAndOffset(
  paths: TelegramCoordinatorPaths,
  lease: TelegramPollerLease,
  record: TelegramInboxRecord,
  nextOffset: number
): Promise<boolean> {
  if (!(await isTelegramPollerLeaseActive(paths, lease))) return false;
  await appendTelegramInboxRecord(paths, record);
  return await writeTelegramOffset(paths, lease, nextOffset);
}

export async function readTelegramInboxForRoom(
  paths: TelegramCoordinatorPaths,
  input: { roomSessionId: string; stateFile: string }
): Promise<TelegramInboxRecord[]> {
  const state = await readTelegramInboxState(input.stateFile);
  const seen = new Set(state.seenIds);
  const roomFile = telegramRoomInboxFile(paths, input.roomSessionId);
  const [roomRecords, legacyRecords] = await Promise.all([
    readJsonlGuarded(roomFile, isTelegramInboxRecord, { maxBytes: 32 * 1024 * 1024 }),
    readJsonlGuarded(paths.inboxFile, isTelegramInboxRecord, { maxBytes: 32 * 1024 * 1024 }),
  ]);
  const unique = new Map<string, TelegramInboxRecord>();
  for (const record of [...legacyRecords, ...roomRecords]) {
    if (record.roomSessionId === input.roomSessionId) unique.set(record.id, record);
  }
  return [...unique.values()]
    .filter((record) => !seen.has(record.id))
    .sort((left, right) => left.updateId - right.updateId);
}

/**
 * Mark one room inbox record handled after its turn/system record is durable.
 * The append-only acknowledgement sidecar prevents two stale read-modify-write
 * completions from losing each other's seen ids.
 */
export async function acknowledgeTelegramInboxRecord(stateFile: string, recordId: string): Promise<void> {
  const id = recordId.trim();
  if (!id) throw new Error("Telegram inbox acknowledgement requires a record id");
  const ackFile = telegramInboxAckFile(stateFile);
  await serializePerFile(ackFile, async () => {
    const existing = await readJsonlGuarded(ackFile, isTelegramInboxAckRecord, { limit: TELEGRAM_RECENT_RECORD_LIMIT });
    if (existing.some((record) => record.id === id)) {
      await flushTelegramFile(ackFile);
      return;
    }
    await fs.mkdir(path.dirname(ackFile), { recursive: true });
    await appendFileSafely(ackFile, `${JSON.stringify({ id, acknowledgedAt: new Date().toISOString() })}\n`);
    await flushTelegramFile(ackFile);
  });
}

export async function readTelegramOffset(paths: TelegramCoordinatorPaths): Promise<number | undefined> {
  let highest: number | undefined;
  try {
    const parsed = await readSmallJson<TelegramOffsetState>(paths.offsetFile, MAX_TELEGRAM_CONTROL_JSON_BYTES);
    if (isTelegramOffset(parsed.offset)) highest = parsed.offset;
  } catch {
    // JSONL hand-edit resilience; a corrupt global offset bootstraps again.
  }

  try {
    const entries = await fs.readdir(paths.offsetDir);
    for (const entry of entries) {
      const offset = telegramOffsetFromAckName(entry);
      if (offset !== undefined && (highest === undefined || offset > highest)) highest = offset;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return highest;
}

/**
 * Durably acknowledge a Telegram offset while the supplied lease still owns
 * the poller election. Offset markers are monotonic: a stale lower completion
 * cannot overwrite a newer acknowledgement even across extension processes.
 */
export async function writeTelegramOffset(
  paths: TelegramCoordinatorPaths,
  lease: TelegramPollerLease,
  offset: number
): Promise<boolean> {
  if (!isTelegramOffset(offset)) throw new Error(`Invalid Telegram offset: ${offset}`);
  return await serializePerFile(paths.offsetFile, async () => {
    if (!(await isTelegramPollerLeaseActive(paths, lease))) return false;
    const current = await readTelegramOffset(paths);
    if (current !== undefined && current >= offset) return await isTelegramPollerLeaseActive(paths, lease);

    await ensurePrivateDirectory(paths.offsetDir);
    if (!(await isTelegramPollerLeaseActive(paths, lease))) return false;
    const ackPath = path.join(paths.offsetDir, telegramOffsetAckName(offset, lease.token));
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(ackPath, "wx", PRIVATE_FILE_MODE);
      await handle.writeFile(`${JSON.stringify({ offset, leaseToken: lease.token, acknowledgedAt: new Date().toISOString() })}\n`, "utf8");
      // Why: advancing getUpdates is the destructive acknowledgement. Flush
      // the marker before a later poll is allowed to skip the persisted work.
      await handle.sync();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      await handle?.close();
    }

    if (!(await isTelegramPollerLeaseActive(paths, lease))) {
      await fs.rm(ackPath, { force: true }).catch(() => undefined);
      return false;
    }
    await removeOlderOffsetAcks(paths.offsetDir, offset);
    return true;
  });
}

export async function withTelegramPollerLease<T>(
  paths: TelegramCoordinatorPaths,
  ownerId: string,
  ttlMs: number,
  work: (lease: TelegramPollerLease) => Promise<T>
): Promise<T | undefined> {
  const durationMs = Number.isFinite(ttlMs) ? Math.max(25, Math.floor(ttlMs)) : 25;
  try {
    await ensureTelegramLeaseDirectory(paths);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw err;
  }
  if (await activeTelegramLease(paths)) return undefined;
  const now = Date.now();
  const token = crypto.randomUUID();
  const leaseFile = telegramLeaseFile(paths, token);
  const record: TelegramLeaseRecord = {
    ownerId,
    token,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + durationMs).toISOString(),
  };
  const handle = await fs.open(leaseFile, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  const abort = new AbortController();
  const lease: TelegramPollerLease = { ownerId, token, signal: abort.signal };
  // Give contenders that observed the same empty directory one event-loop
  // turn to publish their candidates before the deterministic election.
  await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, Math.max(2, Math.floor(durationMs / 10)))));
  if (!(await isTelegramPollerLeaseActive(paths, lease))) {
    abort.abort();
    await fs.rm(leaseFile, { force: true });
    return undefined;
  }

  // Fixed-expiry tokens are deliberate: a delayed heartbeat must never
  // resurrect an expired generation after a successor has won the election.
  const expiryTimer = setTimeout(() => abort.abort(), durationMs);
  expiryTimer.unref?.();
  try {
    return await work(lease);
  } finally {
    clearTimeout(expiryTimer);
    abort.abort();
    // Each generation owns a unique file, so stale cleanup cannot delete a
    // successor's lease (the old single lock path allowed exactly that race).
    await fs.rm(leaseFile, { force: true });
  }
}

async function readTelegramInboxState(stateFile: string): Promise<TelegramInboxState> {
  const seenIds: string[] = [];
  try {
    const parsed = await readSmallJson<Partial<TelegramInboxState>>(stateFile, MAX_TELEGRAM_INBOX_STATE_BYTES);
    if (Array.isArray(parsed.seenIds)) {
      seenIds.push(...parsed.seenIds.filter((id): id is string => typeof id === "string"));
    }
  } catch {
    // First run or hand-edit damage; reprocessing old inbox records is safer than dropping commands.
  }
  const acknowledgements = await readJsonlGuarded(
    telegramInboxAckFile(stateFile),
    isTelegramInboxAckRecord,
    { maxBytes: 32 * 1024 * 1024 }
  );
  seenIds.push(...acknowledgements.map((record) => record.id));
  return { seenIds: Array.from(new Set(seenIds)) };
}

export async function isTelegramPollerLeaseActive(
  paths: TelegramCoordinatorPaths,
  lease: Pick<TelegramPollerLease, "ownerId" | "token">
): Promise<boolean> {
  const active = await activeTelegramLease(paths);
  return active?.ownerId === lease.ownerId && active.token === lease.token;
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await serializePerFile(filePath, async () => {
    await ensurePrivateDirectory(path.dirname(filePath));
    await appendFileSafely(filePath, `${JSON.stringify(value)}\n`);
    await hardenPrivateFile(filePath);
  });
}

async function ensurePrivateDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  await hardenPrivateDirectory(dirPath);
}

async function hardenPrivateDirectory(dirPath: string): Promise<void> {
  const stat = await fs.lstat(dirPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing unsafe Telegram coordinator directory: ${dirPath}`);
  }
  try {
    await fs.chmod(dirPath, PRIVATE_DIR_MODE);
  } catch (err) {
    if (process.platform !== "win32") throw err;
  }
}

async function hardenPrivateFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`Refusing unsafe Telegram coordinator file: ${filePath}`);
  }
  try {
    await fs.chmod(filePath, PRIVATE_FILE_MODE);
  } catch (err) {
    if (process.platform !== "win32") throw err;
  }
}

function globalHydraDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "hydra");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hydra");
}

async function flushTelegramFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function telegramInboxAckFile(stateFile: string): string {
  return `${stateFile}.acks.jsonl`;
}

function telegramRoomInboxFile(paths: TelegramCoordinatorPaths, roomSessionId: string): string {
  const roomKey = crypto.createHash("sha256").update(roomSessionId).digest("hex").slice(0, 32);
  return path.join(paths.roomInboxDir, `${roomKey}.jsonl`);
}

function isTelegramInboxAckRecord(value: unknown): value is { id: string; acknowledgedAt: string } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.acknowledgedAt === "string";
}

function isTelegramOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function telegramOffsetAckName(offset: number, token: string): string {
  return `offset-${String(offset).padStart(20, "0")}-${token}.json`;
}

function telegramOffsetFromAckName(name: string): number | undefined {
  const match = /^offset-(\d{20})-[0-9a-f-]+\.json$/i.exec(name);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return isTelegramOffset(value) ? value : undefined;
}

async function removeOlderOffsetAcks(offsetDir: string, keepOffset: number): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(offsetDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  await Promise.all(entries.map(async (entry) => {
    const offset = telegramOffsetFromAckName(entry);
    if (offset === undefined || offset >= keepOffset) return;
    await fs.rm(path.join(offsetDir, entry), { force: true });
  }));
}

function telegramLeaseFile(paths: TelegramCoordinatorPaths, token: string): string {
  return path.join(paths.lockFile, `${token}.json`);
}

async function ensureTelegramLeaseDirectory(paths: TelegramCoordinatorPaths): Promise<void> {
  await ensurePrivateDirectory(paths.dir);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.mkdir(paths.lockFile, { mode: PRIVATE_DIR_MODE });
      await hardenPrivateDirectory(paths.lockFile);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const stat = await fs.lstat(paths.lockFile).catch(() => undefined);
    if (!stat) continue;
    if (stat.isDirectory()) {
      await hardenPrivateDirectory(paths.lockFile);
      return;
    }

    // Migrate the previous single-file lease format without stealing a live
    // lease from an older extension window. Once converted to a directory,
    // old builds fail their exclusive-file acquisition closed on EEXIST.
    let legacyActive = false;
    try {
      const legacy = await readSmallJson<Partial<TelegramLeaseRecord>>(paths.lockFile, MAX_TELEGRAM_CONTROL_JSON_BYTES);
      legacyActive = typeof legacy.expiresAt === "string" && Date.parse(legacy.expiresAt) > Date.now();
    } catch {
      // Corrupt legacy locks never represented a valid active owner.
    }
    if (legacyActive) throw telegramLeaseUnavailableError();
    await fs.rm(paths.lockFile, { force: true });
  }
  throw new Error(`Unable to initialize Telegram poller lease directory: ${paths.lockFile}`);
}

async function activeTelegramLease(paths: TelegramCoordinatorPaths): Promise<TelegramLeaseRecord | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(paths.lockFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // A live lease from a pre-token build is active but cannot authorize a new
    // token. Callers therefore fail closed until it expires and is migrated.
    if ((err as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw err;
  }
  const now = Date.now();
  const active: TelegramLeaseRecord[] = [];
  for (const entry of entries) {
    if (!/^[0-9a-f-]+\.json$/i.test(entry)) continue;
    try {
      const parsed = await readSmallJson<Partial<TelegramLeaseRecord>>(
        path.join(paths.lockFile, entry),
        MAX_TELEGRAM_CONTROL_JSON_BYTES
      );
      if (!isTelegramLeaseRecord(parsed) || Date.parse(parsed.expiresAt) <= now) continue;
      active.push(parsed);
    } catch {
      // A half-written/corrupt candidate cannot win the lease election.
    }
  }
  active.sort((left, right) => {
    const byAcquiredAt = Date.parse(left.acquiredAt) - Date.parse(right.acquiredAt);
    return byAcquiredAt || left.token.localeCompare(right.token);
  });
  return active[0];
}

async function readSmallJson<T>(filePath: string, maxBytes: number): Promise<T> {
  const bounded = await readFileHead(filePath, maxBytes);
  if (bounded.truncated) {
    throw new Error(`Refusing oversized Telegram coordinator JSON: ${filePath}`);
  }
  return JSON.parse(bounded.text) as T;
}

function isTelegramLeaseRecord(value: Partial<TelegramLeaseRecord>): value is TelegramLeaseRecord {
  return typeof value.ownerId === "string" &&
    typeof value.token === "string" &&
    typeof value.acquiredAt === "string" &&
    Number.isFinite(Date.parse(value.acquiredAt)) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt));
}

function telegramLeaseUnavailableError(): Error {
  const error = new Error("Telegram poller lease is held by an older extension process") as NodeJS.ErrnoException;
  error.code = "EEXIST";
  return error;
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
    (typeof message.fromId === "string" || message.fromId === undefined) &&
    (typeof message.fromIsBot === "boolean" || message.fromIsBot === undefined);
}
