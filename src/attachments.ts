import * as fs from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
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

const COPY_BUFFER_BYTES = 64 * 1024;
const MAX_PREVIEW_BYTES = 512 * 1024;

export async function prepareRoomAttachment(input: PrepareRoomAttachmentInput): Promise<PendingRoomAttachment> {
  const maxBytes = normalizeByteLimit(input.maxBytes);
  const relativeAttachmentDir = validateRelativeAttachmentDir(input.relativeAttachmentDir);
  const name = sanitizeAttachmentFileName(path.basename(input.sourcePath));
  const sourceBefore = await fs.lstat(input.sourcePath);
  assertSafeSourceFile(sourceBefore, input.sourceLabel);

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const source = await fs.open(input.sourcePath, fsConstants.O_RDONLY | noFollow);
  let absolutePath: string | undefined;
  let destination: fs.FileHandle | undefined;
  let destinationIdentity: Stats | undefined;
  try {
    const sourceOpened = await source.stat();
    assertSafeSourceFile(sourceOpened, input.sourceLabel);
    if (!sameFileIdentity(sourceBefore, sourceOpened)) {
      throw new Error(`Refusing attachment after source path swap: ${input.sourceLabel}.`);
    }
    const sourceAfterOpen = await fs.lstat(input.sourcePath);
    assertSafeSourceFile(sourceAfterOpen, input.sourceLabel);
    if (!sameFileIdentity(sourceOpened, sourceAfterOpen)) {
      throw new Error(`Refusing attachment after source path swap: ${input.sourceLabel}.`);
    }
    assertWithinAttachmentLimit(input.sourceLabel, sourceOpened.size, maxBytes);

    await ensureSafeAttachmentDirectory(input.attachmentDir);
    const allocated = await openUniqueAttachmentDestination(input.attachmentDir, name);
    absolutePath = allocated.filePath;
    destination = allocated.handle;
    destinationIdentity = allocated.identity;

    const previewByteLimit = previewBufferLimit(input.previewMaxChars);
    const previewParts: Buffer[] = [];
    let previewBytes = 0;
    let copiedBytes = 0;
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    for (;;) {
      const read = await source.read(buffer, 0, buffer.length, copiedBytes);
      if (read.bytesRead === 0) break;
      if (copiedBytes + read.bytesRead > maxBytes) {
        throw attachmentLimitError(input.sourceLabel, copiedBytes + read.bytesRead, maxBytes);
      }

      const chunk = buffer.subarray(0, read.bytesRead);
      if (previewBytes < previewByteLimit) {
        const keep = Math.min(chunk.length, previewByteLimit - previewBytes);
        previewParts.push(Buffer.from(chunk.subarray(0, keep)));
        previewBytes += keep;
      }
      await writeAll(destination, chunk, copiedBytes);
      copiedBytes += read.bytesRead;
    }

    const sourceAfterCopy = await source.stat();
    assertSafeSourceFile(sourceAfterCopy, input.sourceLabel);
    if (!sameStableFile(sourceOpened, sourceAfterCopy) || copiedBytes !== sourceAfterCopy.size) {
      throw new Error(`Refusing attachment because the source changed while it was being copied: ${input.sourceLabel}.`);
    }
    const sourceAfterPath = await fs.lstat(input.sourcePath);
    assertSafeSourceFile(sourceAfterPath, input.sourceLabel);
    if (!sameFileIdentity(sourceAfterCopy, sourceAfterPath)) {
      throw new Error(`Refusing attachment after source path swap: ${input.sourceLabel}.`);
    }

    await destination.sync();
    await assertSafeCompletedDestination(absolutePath, input.attachmentDir, destination, destinationIdentity, copiedBytes);
    const preview = attachmentPreview(
      Buffer.concat(previewParts, previewBytes),
      name,
      input.previewMaxChars,
      copiedBytes > previewBytes
    );
    const relativePath = toPosixPath(path.posix.join(relativeAttachmentDir, path.basename(absolutePath)));

    return {
      id: input.id,
      name: path.basename(absolutePath),
      sourceLabel: input.sourceLabel,
      relativePath,
      absolutePath,
      sizeBytes: copiedBytes,
      previewText: preview.text,
      previewOriginalChars: preview.originalChars,
      previewTruncated: preview.truncated,
      binary: preview.binary,
    };
  } catch (err) {
    if (destination) {
      await destination.close().catch(() => undefined);
      destination = undefined;
    }
    if (absolutePath && destinationIdentity) {
      await unlinkCreatedDestination(absolutePath, input.attachmentDir, destinationIdentity).catch(() => undefined);
    }
    throw err;
  } finally {
    await Promise.allSettled([source.close(), destination?.close() ?? Promise.resolve()]);
  }
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
          ? attachment.previewOriginalChars === undefined
            ? `Preview: first ${attachment.previewText.length} chars (truncated)`
            : `Preview: first ${attachment.previewText.length}/${attachment.previewOriginalChars} chars`
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

async function openUniqueAttachmentDestination(
  dir: string,
  fileName: string
): Promise<{ filePath: string; handle: fs.FileHandle; identity: Stats }> {
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  for (let i = 0; i < 1000; i++) {
    const candidate = path.join(dir, i === 0 ? fileName : `${base}-${i}${ext}`);
    try {
      await assertSafeAttachmentDirectory(dir);
      const handle = await fs.open(
        candidate,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
        0o600
      );
      let identity: Stats | undefined;
      try {
        identity = await handle.stat();
        assertSafeDestinationFile(identity, candidate);
        const entry = await fs.lstat(candidate);
        assertSafeDestinationFile(entry, candidate);
        if (!sameFileIdentity(identity, entry)) {
          throw new Error(`Refusing attachment destination after path swap: ${candidate}`);
        }
        await assertSafeAttachmentDirectory(dir);
        return { filePath: candidate, handle, identity };
      } catch (err) {
        await handle.close().catch(() => undefined);
        if (identity) {
          await unlinkCreatedDestination(candidate, dir, identity).catch(() => undefined);
        }
        throw err;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error(`Could not allocate attachment file name for ${fileName}.`);
}

function attachmentPreview(
  bytes: Buffer,
  fileName: string,
  requestedMaxChars: number,
  omittedBytes: boolean
): { text?: string; originalChars?: number; truncated?: boolean; binary: boolean } {
  const maxChars = normalizePreviewChars(requestedMaxChars);
  if (maxChars <= 0) return { binary: true };
  if (!isProbablyText(bytes, fileName)) return { binary: true };
  const decoded = bytes.toString("utf8");
  const text = decoded.length > maxChars ? decoded.slice(0, maxChars) : decoded;
  return {
    text,
    // If bytes were omitted, decoded.length is only the size of the bounded
    // sample and must not be presented as the full source character count.
    originalChars: omittedBytes ? undefined : decoded.length,
    truncated: omittedBytes || decoded.length > maxChars,
    binary: false,
  };
}

async function writeAll(handle: fs.FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    if (result.bytesWritten === 0) throw new Error("Unable to copy attachment bytes.");
    offset += result.bytesWritten;
  }
}

function normalizeByteLimit(value: number): number {
  if (!Number.isFinite(value) || value < 0) return Number.MAX_SAFE_INTEGER;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function normalizePreviewChars(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function previewBufferLimit(requestedMaxChars: number): number {
  const maxChars = normalizePreviewChars(requestedMaxChars);
  if (maxChars <= 0) return 0;
  return Math.min(MAX_PREVIEW_BYTES, maxChars > (MAX_PREVIEW_BYTES - 4096) / 4 ? MAX_PREVIEW_BYTES : maxChars * 4 + 4096);
}

function assertWithinAttachmentLimit(label: string, size: number, maxBytes: number): void {
  if (size > maxBytes) throw attachmentLimitError(label, size, maxBytes);
}

function attachmentLimitError(label: string, size: number, maxBytes: number): Error {
  return new Error(`${label} is ${formatBytes(size)}, above the ${formatBytes(maxBytes)} attachment limit.`);
}

function assertSafeSourceFile(stat: Stats, label: string): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} is not a regular file or is a symbolic link.`);
  }
  if (stat.nlink !== 1) {
    throw new Error(`${label} has multiple hard links and cannot be attached safely.`);
  }
}

function assertSafeDestinationFile(stat: Stats, filePath: string): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Refusing unsafe attachment destination: ${filePath}`);
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: Stats, right: Stats): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function validateRelativeAttachmentDir(value: string): string {
  const normalized = path.posix.normalize(toPosixPath(value));
  if (
    path.posix.isAbsolute(normalized)
    || normalized === ".hydra/attachments"
    || !normalized.startsWith(".hydra/attachments/")
    || normalized.split("/").includes("..")
  ) {
    throw new Error(`Refusing attachment path outside .hydra/attachments: ${value}`);
  }
  return normalized;
}

interface AttachmentBoundary {
  workspaceRoot: string;
  hydraRoot: string;
  attachmentsRoot: string;
  attachmentDir: string;
}

function attachmentBoundary(attachmentDir: string): AttachmentBoundary {
  const resolvedDir = path.resolve(attachmentDir);
  let current = resolvedDir;
  for (;;) {
    const parent = path.dirname(current);
    if (sameName(path.basename(current), "attachments") && sameName(path.basename(parent), ".hydra")) {
      return {
        workspaceRoot: path.dirname(parent),
        hydraRoot: parent,
        attachmentsRoot: current,
        attachmentDir: resolvedDir,
      };
    }
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Refusing attachment directory outside a workspace .hydra/attachments root: ${attachmentDir}`);
}

async function ensureSafeAttachmentDirectory(attachmentDir: string): Promise<void> {
  const boundary = attachmentBoundary(attachmentDir);
  await assertNoLinkedExistingDirectoryChain(boundary);
  await fs.mkdir(boundary.attachmentDir, { recursive: true, mode: 0o700 });
  await assertSafeAttachmentDirectory(boundary.attachmentDir);
}

async function assertNoLinkedExistingDirectoryChain(boundary: AttachmentBoundary): Promise<void> {
  let current = boundary.hydraRoot;
  for (;;) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Refusing linked or non-directory attachment parent: ${current}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (samePath(current, boundary.attachmentDir)) return;
    const next = path.join(current, path.relative(current, boundary.attachmentDir).split(path.sep)[0] ?? "");
    if (samePath(next, current)) return;
    current = next;
  }
}

async function assertSafeAttachmentDirectory(attachmentDir: string): Promise<void> {
  const boundary = attachmentBoundary(attachmentDir);
  await assertNoLinkedExistingDirectoryChain(boundary);
  const [realWorkspace, realHydra, realAttachments, realDir] = await Promise.all([
    fs.realpath(boundary.workspaceRoot),
    fs.realpath(boundary.hydraRoot),
    fs.realpath(boundary.attachmentsRoot),
    fs.realpath(boundary.attachmentDir),
  ]);
  if (
    !samePath(realHydra, path.join(realWorkspace, ".hydra"))
    || !samePath(realAttachments, path.join(realHydra, "attachments"))
    || !isPathWithin(realAttachments, realDir)
  ) {
    throw new Error(`Refusing attachment directory through a linked parent: ${attachmentDir}`);
  }
}

async function assertSafeCompletedDestination(
  filePath: string,
  attachmentDir: string,
  handle: fs.FileHandle,
  openedIdentity: Stats,
  copiedBytes: number
): Promise<void> {
  const openedAfter = await handle.stat();
  assertSafeDestinationFile(openedAfter, filePath);
  if (!sameFileIdentity(openedIdentity, openedAfter) || openedAfter.size !== copiedBytes) {
    throw new Error(`Refusing attachment destination after file change: ${filePath}`);
  }
  const entry = await fs.lstat(filePath);
  assertSafeDestinationFile(entry, filePath);
  if (!sameFileIdentity(openedAfter, entry)) {
    throw new Error(`Refusing attachment destination after path swap: ${filePath}`);
  }
  await assertSafeAttachmentDirectory(attachmentDir);
}

async function unlinkCreatedDestination(filePath: string, attachmentDir: string, identity: Stats): Promise<void> {
  await assertSafeAttachmentDirectory(attachmentDir);
  const entry = await fs.lstat(filePath);
  assertSafeDestinationFile(entry, filePath);
  if (!sameFileIdentity(identity, entry)) return;
  await fs.unlink(filePath);
}

function sameName(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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
