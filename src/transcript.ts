import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureFile, serializePerFile } from "./fileQueue";
import { Phase } from "./prompts";

export type MessageRole = "user" | "codex" | "claude" | "system";

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
  archivedMessages: number;
  archivedChars: number;
}

const ROLE_TO_LABEL: Record<MessageRole, string> = {
  user: "You",
  codex: "Codex",
  claude: "Claude",
  system: "System",
};

const LABEL_TO_ROLE: Record<string, MessageRole> = {
  You: "user",
  Codex: "codex",
  Claude: "claude",
  System: "system",
};

const HEADER_RE = /^## (\S+) (You|Codex|Claude|System)(?: \(([^)]+)\))?(?: \[([^\]]+)\])?\s*$/;

// Why: Long autonomous sessions can grow the transcript file without bound,
// eventually slowing reads/edits and bloating memory when the transcript is
// loaded for context. Auto-archive at 25 MiB keeps the active transcript
// bounded while preserving full history in the archive dir. Flagged as a
// Low-severity audit item (unbounded transcript growth).
export const MAX_TRANSCRIPT_BYTES = 25 * 1024 * 1024;

const VALID_PHASES: ReadonlySet<string> = new Set<Phase>(["opener", "reactor", "closer", "parallel", "build", "review"]);
const LEGACY_PHASE_ALIASES: Readonly<Record<string, Phase>> = {
  round1: "opener",
  round2: "reactor",
};

export function serializeMessage(msg: TranscriptMessage): string {
  const label = ROLE_TO_LABEL[msg.role];
  const phaseSuffix = msg.phase ? ` (${msg.phase})` : "";
  const tags: string[] = [];
  if (msg.cancelled) tags.push("cancelled");
  if (msg.error) tags.push("error");
  const tagSuffix = tags.length ? ` [${tags.join(", ")}]` : "";
  return `## ${msg.timestamp} ${label}${phaseSuffix}${tagSuffix}\n\n${msg.text}\n`;
}

export async function appendMessage(filePath: string, msg: TranscriptMessage): Promise<void> {
  await serializePerFile(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    let exists = true;
    try {
      await fs.stat(filePath);
    } catch {
      exists = false;
    }
    const prefix = exists ? "\n" : "# Hydra Room Transcript\n\n";
    await fs.appendFile(filePath, prefix + serializeMessage(msg), "utf8");

    // Auto-archive once the transcript crosses the size threshold. We run
    // inline (without re-entering serializePerFile, which would deadlock on
    // the same path) so the archive lands atomically with respect to other
    // writers waiting on the chain.
    try {
      const stats = await fs.stat(filePath);
      if (stats.size > MAX_TRANSCRIPT_BYTES) {
        await archiveAndResetTranscriptUnsafe(filePath, new Date());
      }
    } catch {
      // Swallow archive failures (e.g. read-only archive dir): the user
      // message has already been persisted to the active transcript, and a
      // future append will retry. Better to keep recording than to fail the
      // append on rotation trouble.
    }
  });
}

// Test-only helper: lets tests verify the auto-archive trigger without
// having to inflate a real transcript past MAX_TRANSCRIPT_BYTES. Skips the
// outer serializePerFile wrapper (so callers must not already hold the
// per-file lock). Returns true when an archive happened.
export async function maybeAutoArchive(filePath: string, maxBytes: number): Promise<boolean> {
  return serializePerFile(filePath, async () => {
    let size = 0;
    try {
      const stats = await fs.stat(filePath);
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
  await ensureFile(filePath, "# Hydra Room Transcript\n\n");
}

export async function archiveAndResetTranscript(
  filePath: string,
  now: Date = new Date()
): Promise<TranscriptArchiveResult> {
  return serializePerFile(filePath, () => archiveAndResetTranscriptUnsafe(filePath, now));
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
  let current = "";
  try {
    current = await fs.readFile(filePath, "utf8");
  } catch {
    current = "# Hydra Room Transcript\n\n";
  }

  const archiveDir = path.join(path.dirname(filePath), "archive");
  await fs.mkdir(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, `transcript-${archiveTimestamp(now)}.md`);
  const archiveBody = current.trim() ? current : "# Hydra Room Transcript\n\n";
  await fs.writeFile(archivePath, archiveBody.endsWith("\n") ? archiveBody : `${archiveBody}\n`, "utf8");
  await fs.writeFile(filePath, "# Hydra Room Transcript\n\n", "utf8");

  return {
    archivePath,
    archivedMessages: parseTranscript(current).length,
    archivedChars: current.length,
  };
}

export async function readTranscript(filePath: string): Promise<TranscriptMessage[]> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return parseTranscript(text);
}

export function parseTranscript(text: string): TranscriptMessage[] {
  const lines = text.split(/\r?\n/);
  const messages: TranscriptMessage[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = HEADER_RE.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const [, ts, label, phaseRaw, tagsRaw] = m;
    const role = LABEL_TO_ROLE[label];
    const phase = normalizePhase(phaseRaw);
    const tags = (tagsRaw ?? "").split(",").map((s) => s.trim());
    i++;
    if (i < lines.length && lines[i] === "") i++;
    const bodyLines: string[] = [];
    while (i < lines.length && !HEADER_RE.test(lines[i])) {
      bodyLines.push(lines[i]);
      i++;
    }
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") bodyLines.pop();
    const out: TranscriptMessage = {
      role,
      text: bodyLines.join("\n"),
      timestamp: ts,
    };
    if (phase) out.phase = phase;
    if (tags.includes("error")) out.error = true;
    if (tags.includes("cancelled")) out.cancelled = true;
    messages.push(out);
  }
  return messages;
}

function normalizePhase(phaseRaw: string | undefined): Phase | undefined {
  if (!phaseRaw) return undefined;
  if (VALID_PHASES.has(phaseRaw)) return phaseRaw as Phase;
  return LEGACY_PHASE_ALIASES[phaseRaw];
}

export function transcriptAsContext(messages: TranscriptMessage[]): string {
  return messages.map(serializeMessage).join("\n");
}

export function windowTranscriptMessages(
  messages: TranscriptMessage[],
  phase: Phase,
  completedUserTurns = 2,
  maxAgeMs = 24 * 60 * 60 * 1000,
  nowMs = Date.now()
): TranscriptMessage[] {
  const freshMessages = filterFreshMessages(messages, maxAgeMs, nowMs);
  const userIndexes: number[] = [];
  freshMessages.forEach((message, index) => {
    if (message.role === "user") userIndexes.push(index);
  });

  if (freshMessages.length === 0 || userIndexes.length === 0) return freshMessages;

  const turnLimit = Math.max(0, Math.floor(completedUserTurns));
  if (phase === "opener" || phase === "reactor" || phase === "closer" || phase === "parallel") {
    const currentUserIndex = userIndexes[userIndexes.length - 1];
    const completedBeforeCurrent = userIndexes.filter((index) => index < currentUserIndex);
    const previousStart = completedBeforeCurrent[Math.max(0, completedBeforeCurrent.length - turnLimit)];
    return freshMessages.slice(previousStart ?? currentUserIndex);
  }

  const start = turnLimit === 0
    ? userIndexes[userIndexes.length - 1]
    : userIndexes[Math.max(0, userIndexes.length - turnLimit)];
  return freshMessages.slice(start);
}

export function buildPromptContext(
  messages: TranscriptMessage[],
  phase: Phase,
  completedUserTurns = 2,
  maxAgeMs = 24 * 60 * 60 * 1000,
  nowMs = Date.now()
): string {
  const windowed = windowTranscriptMessages(messages, phase, completedUserTurns, maxAgeMs, nowMs);
  const omitted = messages.length - windowed.length;
  const context = transcriptAsContext(windowed);
  if (omitted === 0) return context;
  const freshnessNote = maxAgeMs > 0 ? ` and/or older than ${formatDuration(maxAgeMs)}` : "";
  return `[Hydra context window: ${omitted} message(s) omitted by turn limit${freshnessNote}. Full history remains in .hydra/transcript.md.]\n\n${context}`;
}

function filterFreshMessages(
  messages: TranscriptMessage[],
  maxAgeMs: number,
  nowMs: number
): TranscriptMessage[] {
  if (maxAgeMs <= 0) return messages;
  return messages.filter((message) => {
    const timestampMs = Date.parse(message.timestamp);
    if (!Number.isFinite(timestampMs)) return true;
    return nowMs - timestampMs <= maxAgeMs;
  });
}

function formatDuration(ms: number): string {
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours > 0 && hours % 24 === 0) return `${hours / 24}d`;
  if (hours > 0) return `${hours}h`;
  return `${ms}ms`;
}

function archiveTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export async function ensureGitignore(workspaceRoot: string, ignoreLine: string = ".hydra/"): Promise<void> {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  let current = "";
  try {
    current = await fs.readFile(gitignorePath, "utf8");
  } catch {
    // no .gitignore yet — we'll create it
  }
  const trimmedTarget = ignoreLine.replace(/\/$/, "");
  const lines = current.split(/\r?\n/);
  if (lines.some((line) => line.trim() === ignoreLine || line.trim() === trimmedTarget)) {
    return;
  }
  const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  await fs.appendFile(gitignorePath, `${sep}${ignoreLine}\n`, "utf8");
}
