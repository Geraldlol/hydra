import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PromptAttachmentSummary } from "./promptPreview";

export interface PendingRoomAttachment {
  id: string;
  name: string;
  sourceLabel: string;
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  previewText?: string;
  previewOriginalChars?: number;
  previewTruncated?: boolean;
  binary: boolean;
}

export interface PrepareRoomAttachmentInput {
  id: string;
  sourcePath: string;
  sourceLabel: string;
  attachmentDir: string;
  relativeAttachmentDir: string;
  previewMaxChars: number;
  maxBytes: number;
}

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".go",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mdx",
  ".py",
  ".rs",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export async function prepareRoomAttachment(input: PrepareRoomAttachmentInput): Promise<PendingRoomAttachment> {
  const stats = await fs.stat(input.sourcePath);
  if (!stats.isFile()) {
    throw new Error(`${input.sourceLabel} is not a regular file.`);
  }
  if (Number.isFinite(input.maxBytes) && input.maxBytes >= 0 && stats.size > input.maxBytes) {
    throw new Error(`${input.sourceLabel} is ${formatBytes(stats.size)}, above the ${formatBytes(input.maxBytes)} attachment limit.`);
  }

  await fs.mkdir(input.attachmentDir, { recursive: true });
  const name = sanitizeAttachmentFileName(path.basename(input.sourcePath));
  const absolutePath = await uniqueAttachmentPath(input.attachmentDir, name);
  await fs.copyFile(input.sourcePath, absolutePath);
  const relativePath = toPosixPath(path.join(input.relativeAttachmentDir, path.basename(absolutePath)));
  const preview = await readAttachmentPreview(input.sourcePath, name, Math.max(0, Math.floor(input.previewMaxChars)));

  return {
    id: input.id,
    name: path.basename(absolutePath),
    sourceLabel: input.sourceLabel,
    relativePath,
    absolutePath,
    sizeBytes: stats.size,
    previewText: preview.text,
    previewOriginalChars: preview.originalChars,
    previewTruncated: preview.truncated,
    binary: preview.binary,
  };
}

export function renderRoomAttachmentsForPrompt(attachments: PendingRoomAttachment[]): string {
  if (attachments.length === 0) return "";
  const lines = [
    "--- Uploaded files ---",
    "The user attached the following files for this turn. Hydra copied them into the workspace so both native CLIs can inspect them directly. Treat these paths as explicit user-provided attachments even though they live under `.hydra/attachments/`.",
  ];
  for (const attachment of attachments) {
    lines.push(
      "",
      `File: ${attachment.name}`,
      `Path: ${attachment.relativePath}`,
      `Original source: ${attachment.sourceLabel}`,
      `Size: ${formatBytes(attachment.sizeBytes)}`
    );
    if (attachment.previewText !== undefined) {
      lines.push(
        attachment.previewTruncated
          ? `Preview: first ${attachment.previewText.length}/${attachment.previewOriginalChars ?? attachment.previewText.length} chars`
          : `Preview: full text (${attachment.previewOriginalChars ?? attachment.previewText.length} chars)`,
        "",
        "```text",
        attachment.previewText,
        "```"
      );
    } else {
      lines.push("Preview: binary or unsupported text encoding; inspect the copied file path directly.");
    }
  }
  return lines.join("\n");
}

export function roomAttachmentSummaries(attachments: PendingRoomAttachment[]): PromptAttachmentSummary[] {
  return attachments.map((attachment) => ({
    kind: attachment.binary ? "file" : "text-file",
    label: `${attachment.name} -> ${attachment.relativePath}`,
    chars: attachment.previewText?.length ?? 0,
  }));
}

export function attachmentDisplaySummary(attachments: PendingRoomAttachment[]): string {
  if (attachments.length === 0) return "";
  const names = attachments.map((attachment) => attachment.name).join(", ");
  return `[Attached ${attachments.length} file${attachments.length === 1 ? "" : "s"}: ${names}]`;
}

export function sanitizeAttachmentFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "attachment";
}

async function uniqueAttachmentPath(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  for (let i = 0; i < 1000; i++) {
    const candidate = path.join(dir, i === 0 ? fileName : `${base}-${i}${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error(`Could not allocate attachment file name for ${fileName}.`);
}

async function readAttachmentPreview(
  filePath: string,
  fileName: string,
  maxChars: number
): Promise<{ text?: string; originalChars?: number; truncated?: boolean; binary: boolean }> {
  if (maxChars <= 0) return { binary: true };
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(maxChars * 4 + 4096, 512 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const chunk = buffer.subarray(0, bytesRead);
    if (!isProbablyText(chunk, fileName)) return { binary: true };
    const decoded = chunk.toString("utf8");
    const text = decoded.length > maxChars ? decoded.slice(0, maxChars) : decoded;
    return {
      text,
      originalChars: decoded.length,
      truncated: decoded.length > maxChars,
      binary: false,
    };
  } finally {
    await handle.close();
  }
}

function isProbablyText(buffer: Buffer, fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (buffer.length === 0) return true;
  if (buffer.includes(0)) return false;
  let suspicious = 0;
  for (const byte of buffer) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte >= 32) continue;
    suspicious++;
  }
  return suspicious / buffer.length < 0.02;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}
