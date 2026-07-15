import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import * as path from "node:path";
import {
  appendFileSafely,
  assertSafeArtifactParent,
  atomicWriteFile,
  ensureFile,
  readFileHead,
  readFileTail,
  serializePerFile,
  serializePerFileAcrossProcesses,
} from "./fileQueue";
import { Phase } from "./prompts";
import { isValidAgentId } from "./agentValidation";

/**
 * Durable transcript role. Agent ids are intentionally stored as their raw,
 * validated registry id so history remains attributable after a head is
 * removed or reordered in configuration.
 */
export type MessageRole = "user" | "system" | "codex" | "claude" | (string & {});

export interface TranscriptMessage {
  role: MessageRole;
  text: string;
  timestamp: string;
  phase?: Phase;
  error?: boolean;
  cancelled?: boolean;
}

export interface TranscriptArchiveResult {
  archivePath: string;
  /** Exact only when the archived transcript fit within the bounded read window. */
  archivedMessages?: number;
  archivedBytes: number;
}

export interface TranscriptContextWindow {
  markdown: string;
  originalChars: number;
  keptChars: number;
  omittedMessages: number;
  omittedChars: number;
  truncated: boolean;
}

const HEADER_RE = /^## (\S+) (You|Codex|Claude|System|@[A-Za-z0-9][A-Za-z0-9_-]*)(?: \(([^)]+)\))?(?: \[([^\]]+)\])?\s*$/;

// Why: Long autonomous sessions can grow the transcript file without bound,
// eventually slowing reads/edits and bloating memory when the transcript is
// loaded for context. Auto-archive at 25 MiB keeps the active transcript
// bounded while preserving full history in the archive dir. Flagged as a
// Low-severity audit item (unbounded transcript growth).
export const MAX_TRANSCRIPT_BYTES = 25 * 1024 * 1024;
const MAX_PARSED_TRANSCRIPT_MESSAGES = 10_000;
const MAX_TRANSCRIPT_HEADER_CHARS = 4_096;
const TRANSCRIPT_HEADER = "# Hydra Room Transcript\n\n";

const VALID_PHASES: ReadonlySet<string> = new Set<Phase>(["opener", "reactor", "closer", "parallel", "build", "review"]);
const LEGACY_PHASE_ALIASES: Readonly<Record<string, Phase>> = {
  round1: "opener",
  round2: "reactor",
};

export function serializeMessage(msg: TranscriptMessage): string {
  const label = transcriptLabelForRole(msg.role);
  const phaseSuffix = msg.phase ? ` (${msg.phase})` : "";
  const tags: string[] = [];
  if (msg.cancelled) tags.push("cancelled");
  if (msg.error) tags.push("error");
  const tagSuffix = tags.length ? ` [${tags.join(", ")}]` : "";
  return `## ${msg.timestamp} ${label}${phaseSuffix}${tagSuffix}\n\n${msg.text}\n`;
}

export async function appendMessage(
  filePath: string,
  msg: TranscriptMessage,
): Promise<TranscriptArchiveResult | undefined> {
  return serializePerFileAcrossProcesses(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    let exists = true;
    let existingBytes = 0;
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error(`Refusing to append an unsafe transcript: ${filePath}`);
      }
      existingBytes = stat.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      exists = false;
    }
    const serialized = serializeMessageForStorage(msg);
    const initialPrefix = exists ? "\n" : TRANSCRIPT_HEADER;
    let archived: TranscriptArchiveResult | undefined;

    // Rotate the existing room before writing the message that crosses the
    // threshold. The filesystem lock is shared by every Hydra append, so a
    // second extension host cannot append into the rename/reset gap.
    if (exists && existingBytes + Buffer.byteLength(initialPrefix + serialized, "utf8") > MAX_TRANSCRIPT_BYTES) {
      try {
        archived = await archiveAndResetTranscriptUnsafe(filePath, new Date());
      } catch {
        // Archive failures are non-fatal. Re-check the active path below so a
        // partially recovered rotation still receives a valid header.
      }
    }

    const activeExists = await fs.lstat(filePath).then((stat) => stat.isFile()).catch(() => false);
    const prefix = activeExists ? "\n" : TRANSCRIPT_HEADER;
    await appendFileSafely(filePath, prefix + serialized);
    return archived;
  });
}

export function dropArchivedMessagePrefix<T>(messages: readonly T[], archivedMessages: number): T[] {
  const count = Math.min(messages.length, Math.max(0, Math.floor(archivedMessages)));
  return messages.slice(count);
}

// Test-only helper: lets tests verify the auto-archive trigger without
// having to inflate a real transcript past MAX_TRANSCRIPT_BYTES.
export async function maybeAutoArchive(filePath: string, maxBytes: number): Promise<boolean> {
  return serializePerFileAcrossProcesses(filePath, async () => {
    let size = 0;
    try {
      const stats = await fs.lstat(filePath);
      assertSafeTranscriptStat(stats, filePath);
      size = stats.size;
    } catch {
      return false;
    }
    if (size <= maxBytes) return false;
    try {
      await archiveAndResetTranscriptUnsafe(filePath, new Date());
      return true;
    } catch {
      return false;
    }
  });
}

export async function ensureTranscriptFile(filePath: string): Promise<void> {
  await ensureFile(filePath, TRANSCRIPT_HEADER);
}

export async function archiveAndResetTranscript(
  filePath: string,
  now: Date = new Date()
): Promise<TranscriptArchiveResult> {
  return serializePerFileAcrossProcesses(filePath, () => archiveAndResetTranscriptUnsafe(filePath, now));
}

// Same archive/reset logic as `archiveAndResetTranscript`, but assumes the
// caller already holds the serializePerFile lock for `filePath`. Calling
// this without holding the lock can race with concurrent writes; call the
// wrapper above instead. Exists so `appendMessage` can auto-archive inline
// without re-entering the per-file mutex (which would deadlock).
async function archiveAndResetTranscriptUnsafe(
  filePath: string,
  now: Date
): Promise<TranscriptArchiveResult> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.lstat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await ensureTranscriptFile(filePath);
  }

  // Parse at most one active-transcript window for diagnostics. The archive
  // itself is moved atomically, so even a hostile legacy multi-gigabyte file
  // is never materialized as one JavaScript string.
  const tail = await readFileTail(filePath, MAX_TRANSCRIPT_BYTES);
  const parsedTail = parseTranscriptBounded(tail.text);
  const archivedMessages = tail.truncated || parsedTail.truncated ? undefined : parsedTail.messages.length;
  const archiveDir = path.join(path.dirname(filePath), "archive");
  await assertSafeArtifactParent(path.join(archiveDir, "placeholder.md"), true);
  await fs.mkdir(archiveDir, { recursive: true });
  const archivePath = await availableTranscriptArchivePath(archiveDir, now);
  await assertSafeArtifactParent(archivePath);

  const before = await fs.lstat(filePath);
  assertSafeTranscriptStat(before, filePath);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const source = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  let moved = false;
  try {
    const opened = await source.stat();
    assertSafeTranscriptStat(opened, filePath);
    if (!sameFileIdentity(before, opened)) {
      throw new Error(`Refusing to archive transcript after path swap: ${filePath}`);
    }
    const beforeMove = await fs.lstat(filePath);
    if (!sameFileIdentity(opened, beforeMove)) {
      throw new Error(`Refusing to archive transcript after path swap: ${filePath}`);
    }

    await fs.rename(filePath, archivePath);
    moved = true;
    const archivedStat = await fs.lstat(archivePath);
    assertSafeTranscriptStat(archivedStat, archivePath);
    if (!sameFileIdentity(opened, archivedStat)) {
      throw new Error(`Transcript archive identity changed during rotation: ${archivePath}`);
    }
  } finally {
    await source.close().catch(() => undefined);
  }

  try {
    await atomicWriteFile(filePath, TRANSCRIPT_HEADER);
  } catch (err) {
    if (moved) {
      const activeExists = await fs.lstat(filePath).then(() => true).catch(() => false);
      if (!activeExists) await fs.rename(archivePath, filePath).catch(() => undefined);
    }
    throw err;
  }

  return {
    archivePath,
    archivedMessages,
    archivedBytes: tail.totalBytes,
  };
}

export async function readTranscript(filePath: string): Promise<TranscriptMessage[]> {
  try {
    const tail = await readFileTail(filePath, MAX_TRANSCRIPT_BYTES);
    return parseTranscript(tail.text);
  } catch {
    return [];
  }
}

export function parseTranscript(text: string): TranscriptMessage[] {
  return parseTranscriptBounded(text).messages;
}

interface ParsedTranscript {
  messages: TranscriptMessage[];
  /** True when older messages may exist beyond the retained newest window. */
  truncated: boolean;
}

function parseTranscriptBounded(text: string): ParsedTranscript {
  // Headers are the only structural boundaries. Search for them directly
  // from newest to oldest instead of splitting every body newline into an
  // array; this makes a newline-dense 25 MiB legacy transcript cheap and
  // naturally retains the newest room context when the record cap is hit.
  const newestFirst: TranscriptMessage[] = [];
  let bodyEnd = text.length;
  let searchBefore = text.length;
  while (newestFirst.length < MAX_PARSED_TRANSCRIPT_MESSAGES) {
    const header = previousTranscriptHeader(text, searchBefore);
    if (!header) {
      searchBefore = 0;
      break;
    }
    searchBefore = header.start;
    if (!header.match) continue;

    let bodyStart = header.nextLineStart;
    const separatorEnd = text.indexOf("\n", bodyStart);
    if (separatorEnd >= 0 && separatorEnd <= bodyEnd) {
      const separatorRawEnd = separatorEnd > bodyStart && text.charCodeAt(separatorEnd - 1) === 0x0d
        ? separatorEnd - 1
        : separatorEnd;
      if (separatorRawEnd === bodyStart) bodyStart = separatorEnd + 1;
    }
    const trimmedBodyEnd = trimTranscriptBodyEnd(text, bodyStart, bodyEnd);
    newestFirst.push(messageFromTranscriptHeader(
      header.match,
      text.slice(bodyStart, trimmedBodyEnd),
    ));
    bodyEnd = header.start;
  }
  newestFirst.reverse();
  return {
    messages: newestFirst,
    // Conservatively avoid reporting an exact archive count once the cap was
    // reached and there is any unsearched prefix.
    truncated: newestFirst.length >= MAX_PARSED_TRANSCRIPT_MESSAGES && searchBefore > 0,
  };
}

interface TranscriptHeaderMatch {
  start: number;
  nextLineStart: number;
  match?: RegExpExecArray;
}

function previousTranscriptHeader(text: string, before: number): TranscriptHeaderMatch | undefined {
  if (before <= 0) return undefined;
  // Exclude the newline immediately before the already-found newer header.
  const marker = before >= 2 ? text.lastIndexOf("\n## ", before - 2) : -1;
  const start = marker >= 0 ? marker + 1 : (text.startsWith("## ") ? 0 : -1);
  if (start < 0 || start >= before) return undefined;
  const newline = text.indexOf("\n", start);
  const lineTerminator = newline < 0 ? text.length : newline;
  const lineEnd = lineTerminator > start && text.charCodeAt(lineTerminator - 1) === 0x0d
    ? lineTerminator - 1
    : lineTerminator;
  const lineLength = lineEnd - start;
  return {
    start,
    nextLineStart: newline < 0 ? text.length : newline + 1,
    match: lineLength <= MAX_TRANSCRIPT_HEADER_CHARS
      ? HEADER_RE.exec(text.slice(start, lineEnd)) ?? undefined
      : undefined,
  };
}

function trimTranscriptBodyEnd(text: string, start: number, rawEnd: number): number {
  let end = Math.max(start, rawEnd);
  while (end > start && text.charCodeAt(end - 1) === 0x0a) {
    end--;
    if (end > start && text.charCodeAt(end - 1) === 0x0d) end--;
  }
  return end;
}

function messageFromTranscriptHeader(match: RegExpExecArray, body: string): TranscriptMessage {
  // HEADER_RE groups 1 and 2 are required by the expression.
  const timestamp = match[1] ?? "";
  const label = match[2] ?? "";
  const phase = normalizePhase(match[3]);
  const tags = (match[4] ?? "").split(",").map((tag) => tag.trim());
  const message: TranscriptMessage = {
    role: transcriptRoleFromLabel(label),
    text: body,
    timestamp,
  };
  if (phase) message.phase = phase;
  if (tags.includes("error")) message.error = true;
  if (tags.includes("cancelled")) message.cancelled = true;
  return message;
}

/** True for a durable agent role, including a configured or historical head. */
export function isAgentMessageRole(role: MessageRole): boolean {
  return isValidAgentId(role);
}

function transcriptLabelForRole(role: MessageRole): string {
  if (role === "user") return "You";
  if (role === "system") return "System";
  // Preserve the legacy built-in labels so existing transcripts remain easy
  // to read and byte-compatible. Every other head uses an unambiguous @id.
  if (role === "codex") return "Codex";
  if (role === "claude") return "Claude";
  if (!isValidAgentId(role)) {
    throw new Error(`Refusing to serialize an invalid Hydra agent role: ${role}`);
  }
  return `@${role}`;
}

function transcriptRoleFromLabel(label: string): MessageRole {
  if (label === "You") return "user";
  if (label === "System") return "system";
  if (label === "Codex") return "codex";
  if (label === "Claude") return "claude";
  if (label.startsWith("@") && isValidAgentId(label.slice(1))) return label.slice(1);
  return "system";
}

function serializeMessageForStorage(message: TranscriptMessage): string {
  const serialized = serializeMessage(message);
  const maxSerializedBytes = MAX_TRANSCRIPT_BYTES - Buffer.byteLength(TRANSCRIPT_HEADER, "utf8") - 1;
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (originalBytes <= maxSerializedBytes) return serialized;

  const marker = `\n[... transcript message truncated from ${originalBytes} bytes by Hydra ...]`;
  const empty = serializeMessage({ ...message, text: "" });
  const textBudget = Math.max(
    0,
    maxSerializedBytes - Buffer.byteLength(empty, "utf8") - Buffer.byteLength(marker, "utf8"),
  );
  const text = `${truncateUtf8Prefix(message.text, textBudget)}${marker}`;
  return serializeMessage({ ...message, text });
}

function truncateUtf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && end < value.length) {
    const last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
  }
  return value.slice(0, end);
}

async function availableTranscriptArchivePath(archiveDir: string, now: Date): Promise<string> {
  const base = path.join(archiveDir, `transcript-${archiveTimestamp(now)}.md`);
  try {
    await fs.lstat(base);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return base;
    throw err;
  }
  return path.join(
    archiveDir,
    `transcript-${archiveTimestamp(now)}-${crypto.randomUUID().slice(0, 8)}.md`,
  );
}

function assertSafeTranscriptStat(stat: Stats, filePath: string): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`Refusing unsafe transcript entry: ${filePath}`);
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function normalizePhase(phaseRaw: string | undefined): Phase | undefined {
  if (!phaseRaw) return undefined;
  if (VALID_PHASES.has(phaseRaw)) return phaseRaw as Phase;
  return LEGACY_PHASE_ALIASES[phaseRaw];
}

export function transcriptAsContext(messages: TranscriptMessage[]): string {
  return messages.map(serializeMessage).join("\n");
}

export function transcriptAsWindowedContext(
  messages: TranscriptMessage[],
  maxChars: number
): TranscriptContextWindow {
  const full = transcriptAsContext(messages);
  const cap = Math.max(0, Math.floor(maxChars));
  if (cap <= 0 || full.length <= cap) {
    return {
      markdown: full,
      originalChars: full.length,
      keptChars: full.length,
      omittedMessages: 0,
      omittedChars: 0,
      truncated: false,
    };
  }

  const chunks = messages.map(serializeMessage);
  const kept: string[] = [];
  let keptChars = 0;
  let omittedMessages = 0;
  let omittedChars = 0;

  for (let i = chunks.length - 1; i >= 0; i--) {
    // Why: i ranges over valid indices of chunks, so the element is defined.
    const chunk = chunks[i] ?? "";
    const separatorChars = kept.length > 0 ? 1 : 0;
    const nextChars = keptChars + separatorChars + chunk.length;
    if (nextChars > cap) {
      if (kept.length === 0) {
        // A single newest message can itself exceed the entire context cap.
        // Preserve its beginning (where the instruction normally lives) while
        // bounding the serialized chunk; older messages remain fully omitted.
        const marker = "\n[... newest message truncated ...]";
        const prefixChars = Math.max(0, cap - marker.length);
        const clipped = `${chunk.slice(0, prefixChars)}${marker.slice(0, cap - prefixChars)}`;
        kept.unshift(clipped);
        keptChars = clipped.length;
        omittedMessages = i;
        const olderChars = i > 0 ? chunks.slice(0, i).join("\n").length + 1 : 0;
        omittedChars = olderChars + (chunk.length - clipped.length);
      } else {
        omittedMessages = i + 1;
        omittedChars = chunks.slice(0, i + 1).join("\n").length;
      }
      break;
    }
    kept.unshift(chunk);
    keptChars = nextChars;
  }

  if (omittedChars === 0) {
    return {
      markdown: full,
      originalChars: full.length,
      keptChars: full.length,
      omittedMessages: 0,
      omittedChars: 0,
      truncated: false,
    };
  }

  const notice = [
    "## Hydra Context Window",
    "",
    `[Active transcript content omitted by hydraRoom.promptTranscriptMaxChars (cap ${cap} chars): ${omittedMessages} complete earlier message${omittedMessages === 1 ? "" : "s"}, ${omittedChars} chars. Use Hydra wiki context and .hydra/transcript.md for durable history.]`,
  ].join("\n");
  const keptMarkdown = kept.join("\n");

  return {
    markdown: [notice, keptMarkdown].join("\n"),
    originalChars: full.length,
    keptChars: keptMarkdown.length,
    omittedMessages,
    omittedChars,
    truncated: true,
  };
}

export function buildPromptContextWindow(
  messages: TranscriptMessage[],
  _phase: Phase,
  _completedUserTurns = 2,
  _maxAgeMs = 24 * 60 * 60 * 1000,
  _nowMs = Date.now(),
  maxChars = 0
): TranscriptContextWindow {
  const promptMessages = messages.filter((message) => !isPromptNoiseSystemMessage(message));
  return transcriptAsWindowedContext(promptMessages, maxChars);
}

export function buildPromptContext(
  messages: TranscriptMessage[],
  _phase: Phase,
  _completedUserTurns = 2,
  _maxAgeMs = 24 * 60 * 60 * 1000,
  _nowMs = Date.now(),
  maxChars = 0
): string {
  return buildPromptContextWindow(messages, _phase, _completedUserTurns, _maxAgeMs, _nowMs, maxChars).markdown;
}

function isPromptNoiseSystemMessage(message: TranscriptMessage): boolean {
  return message.role === "system" && /^Hydra auto-advanced after .*\(send-instruction \d+\/\d+\):/.test(message.text);
}

function archiveTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export async function ensureGitignore(workspaceRoot: string, ignoreLine: string = ".hydra/"): Promise<void> {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  await serializePerFile(gitignorePath, async () => {
    let head = { text: "", totalBytes: 0, truncated: false };
    let tail = { text: "", totalBytes: 0, truncated: false };
    try {
      [head, tail] = await Promise.all([
        readFileHead(gitignorePath, 128 * 1024),
        readFileTail(gitignorePath, 128 * 1024),
      ]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // No .gitignore yet; appendFileSafely creates it below.
    }
    const trimmedTarget = ignoreLine.replace(/\/$/, "");
    const lines = `${head.text}\n${tail.text}`.split(/\r?\n/);
    if (lines.some((line) => line.trim() === ignoreLine || line.trim() === trimmedTarget)) {
      return;
    }
    // If the original entry lived outside both bounded windows, one duplicate
    // may be appended. That copy is then in the tail, keeping future starts
    // idempotent without ever loading an unbounded ignore file.
    const sep = tail.totalBytes === 0 || tail.text.endsWith("\n") ? "" : "\n";
    await appendFileSafely(gitignorePath, `${sep}${ignoreLine}\n`);
  });
}
