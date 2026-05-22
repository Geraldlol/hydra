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

export interface TranscriptContextWindow {
  markdown: string;
  omittedMessages: number;
  omittedChars: number;
  truncated: boolean;
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

export function transcriptAsWindowedContext(
  messages: TranscriptMessage[],
  maxChars: number
): TranscriptContextWindow {
  const full = transcriptAsContext(messages);
  const cap = Math.max(0, Math.floor(maxChars));
  if (cap <= 0 || full.length <= cap) {
    return {
      markdown: full,
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
    const chunk = chunks[i];
    const separatorChars = kept.length > 0 ? 1 : 0;
    const nextChars = keptChars + separatorChars + chunk.length;
    if (kept.length > 0 && nextChars > cap) {
      omittedMessages = i + 1;
      omittedChars = chunks.slice(0, i + 1).join("\n").length;
      break;
    }
    kept.unshift(chunk);
    keptChars = nextChars;
  }

  if (omittedMessages === 0) {
    return {
      markdown: full,
      omittedMessages: 0,
      omittedChars: 0,
      truncated: false,
    };
  }

  const notice = [
    "## Hydra Context Window",
    "",
    `[Earlier active transcript omitted by hydraRoom.promptTranscriptMaxChars (cap ${cap} chars): ${omittedMessages} message${omittedMessages === 1 ? "" : "s"}, ${omittedChars} chars. Use Hydra wiki context and .hydra/transcript.md for durable history.]`,
  ].join("\n");

  return {
    markdown: [notice, ...kept].join("\n"),
    omittedMessages,
    omittedChars,
    truncated: true,
  };
}

export function buildPromptContext(
  messages: TranscriptMessage[],
  _phase: Phase,
  _completedUserTurns = 2,
  _maxAgeMs = 24 * 60 * 60 * 1000,
  _nowMs = Date.now(),
  maxChars = 0
): string {
  const promptMessages = messages.filter((message) => !isPromptNoiseSystemMessage(message));
  return transcriptAsWindowedContext(promptMessages, maxChars).markdown;
}

function isPromptNoiseSystemMessage(message: TranscriptMessage): boolean {
  return message.role === "system" && /^Hydra auto-advanced after .*\(send-instruction \d+\/\d+\):/.test(message.text);
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
