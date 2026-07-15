import * as fs from "node:fs/promises";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  readSync,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";

// In-process per-path mutex. Two concurrent writes against the same filePath
// can interleave bytes (an appendFile can land mid-rename, a parser silently
// drops the corrupted line). Each module previously kept its own chain Map;
// this consolidates them into a single registry keyed by path.
//
// The chain stores Promise<void> regardless of the work's return type — the
// .then(() => undefined, () => undefined) form coerces both success and
// failure, so the next caller's `previous.then(work)` always proceeds.
const writeChains: Map<string, Promise<void>> = new Map();
const atomicWriteChains: Map<string, Promise<void>> = new Map();
const CROSS_PROCESS_LOCK_WAIT_MS = 30_000;
const CROSS_PROCESS_LOCK_TTL_MS = 2 * 60_000;
const CROSS_PROCESS_MARKER_TTL_MS = 2 * 60_000;
const CROSS_PROCESS_LOCK_HEARTBEAT_MS = 30_000;

interface CrossProcessLockRecord {
  token: string;
  createdAt: string;
}

export async function serializePerFile<T>(
  filePath: string,
  work: () => Promise<T>
): Promise<T> {
  const previous = writeChains.get(filePath) ?? Promise.resolve();
  const next = previous.then(work);
  const settled = next.then(() => undefined, () => undefined);
  writeChains.set(filePath, settled);
  try {
    return await next;
  } finally {
    // Only the tail owner may remove the entry; a queued successor replaces it.
    if (writeChains.get(filePath) === settled) writeChains.delete(filePath);
  }
}

// Idempotent "make sure this file exists" helper. Used at startup to seed
// .hydra/* artifact files with their default content. Mirrors the previous
// per-module ensure*File functions, which all had this exact shape.
export async function ensureFile(filePath: string, defaultContent = ""): Promise<void> {
  await assertSafeArtifactParent(filePath, true);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await assertSafeArtifactParent(filePath);
  try {
    // Why: fs.stat follows symlinks, so a malicious workspace that ships
    // .hydra/<artifact> as a symlink to ~/.ssh/authorized_keys would pass
    // the "already exists" check and we'd skip seeding (good) — but if the
    // symlink target didn't exist yet, stat would throw ENOENT and we'd
    // fs.writeFile straight through the symlink. lstat sees the link itself.
    const st = await fs.lstat(filePath);
    assertSafeArtifactFile(st, filePath);
    // Existing safe regular file: nothing to do.
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // ENOENT means we should create; anything else (including our refusal) propagates.
      throw err;
    }
  }
  // Why: O_EXCL ("wx"). A race that plants a symlink between the lstat above
  // and this open still fails closed — open() with O_EXCL refuses to follow
  // a pre-existing symlink and refuses to create over any existing entry.
  const handle = await fs.open(filePath, "wx");
  try {
    await assertSafeArtifactParent(filePath);
    await handle.writeFile(defaultContent, "utf8");
  } finally {
    await handle.close();
  }
}

// Append through a validated file handle rather than a path-based appendFile.
// Callers typically seed an artifact once and append for the rest of the
// session; checking every append closes the gap where the final file is
// replaced by a symlink or hard link after initialization.
export async function appendFileSafely(filePath: string, content: string): Promise<void> {
  await assertSafeArtifactParent(filePath, true);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await assertSafeArtifactParent(filePath);

  // A missing artifact is created exclusively so a symlink/hard-link planted
  // between discovery and creation loses the race with EEXIST instead of being
  // followed. Retry once through the existing-file validation path.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let before: Stats;
    try {
      before = await fs.lstat(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      try {
        const created = await fs.open(filePath, "ax");
        try {
          await assertSafeArtifactParent(filePath);
          await created.writeFile(content, "utf8");
        } finally {
          await created.close();
        }
        return;
      } catch (createErr) {
        if ((createErr as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw createErr;
      }
    }

    assertSafeArtifactFile(before, filePath);
    let handle: fs.FileHandle;
    try {
      // O_NOFOLLOW is available on POSIX. Windows does not expose it, so the
      // before/open/after identity checks below provide the portable guard.
      const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
      handle = await fs.open(filePath, fsConstants.O_WRONLY | fsConstants.O_APPEND | noFollow);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }

    try {
      const opened = await handle.stat();
      assertSafeArtifactFile(opened, filePath);
      if (!sameFileIdentity(before, opened)) {
        throw new Error(`Refusing to write Hydra artifact after path swap: ${filePath}`);
      }

      // Re-check the directory entry after open. If it changed, the handle is
      // still safe (it references the original inode), but accepting the write
      // would silently lose the artifact behind an attacker-controlled entry.
      const afterOpen = await fs.lstat(filePath);
      assertSafeArtifactFile(afterOpen, filePath);
      if (!sameFileIdentity(opened, afterOpen)) {
        throw new Error(`Refusing to write Hydra artifact after path swap: ${filePath}`);
      }
      await assertSafeArtifactParent(filePath);
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    return;
  }

  throw new Error(`Refusing to write Hydra artifact after repeated path swaps: ${filePath}`);
}

/**
 * Serialize a file mutation both inside this extension host and across other
 * Hydra processes using the same artifact path.
 *
 * The adjacent lease file is deliberately shared by append and rewrite
 * callers. Unique acquisition/recovery intent markers fence stale-lock
 * retirement: once recovery publishes its marker, it waits for every
 * already-started acquisition to either finish or stand down before moving
 * the stale entry. That prevents a stale observation from moving a replacement
 * owner's lock after the original owner released it.
 */
export async function serializePerFileAcrossProcesses<T>(
  filePath: string,
  work: () => Promise<T>,
): Promise<T> {
  return serializePerFile(filePath, () => withCrossProcessFileLock(filePath, work));
}

async function withCrossProcessFileLock<T>(filePath: string, work: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + CROSS_PROCESS_LOCK_WAIT_MS;
  await assertSafeArtifactParent(lockPath, true);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await assertSafeArtifactParent(lockPath);

  let owned: Stats | undefined;
  let ownedHandle: fs.FileHandle | undefined;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Hydra artifact writer lock: ${filePath}`);
    }

    const acquisitionMarker = await createCrossProcessLockMarker(lockPath, "acquire");
    let sawExistingLock = false;
    let acquired = false;
    try {
      if (!(await hasLiveCrossProcessLockMarkers(lockPath, "recover"))) {
        try {
          ownedHandle = await fs.open(lockPath, "wx", 0o600);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          sawExistingLock = true;
        }

        if (ownedHandle) {
          const record: CrossProcessLockRecord = { token, createdAt: new Date().toISOString() };
          await ownedHandle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await ownedHandle.sync();
          owned = await ownedHandle.stat();
          assertSafeArtifactFile(owned, lockPath);

          // A recoverer may have published its intent after our pre-open
          // check. Keep our acquisition marker until the candidate lock is
          // removed so that recoverers cannot pass their quiescence fence.
          if (await hasLiveCrossProcessLockMarkers(lockPath, "recover")) {
            await ownedHandle.close();
            ownedHandle = undefined;
            await releaseCrossProcessLock(lockPath, owned, token);
            owned = undefined;
          } else {
            const inspected = await inspectCrossProcessLock(lockPath);
            acquired = sameFileIdentity(owned, inspected.stat) && inspected.record?.token === token;
            if (!acquired) {
              await ownedHandle.close();
              ownedHandle = undefined;
              owned = undefined;
            }
          }
        }
      }
    } catch (err) {
      if (ownedHandle) {
        await ownedHandle.close().catch(() => undefined);
        ownedHandle = undefined;
      }
      if (owned) {
        await releaseCrossProcessLock(lockPath, owned, token).catch(() => undefined);
        owned = undefined;
      }
      throw err;
    } finally {
      await removeCrossProcessLockMarker(acquisitionMarker);
    }

    if (acquired && owned && ownedHandle) break;
    if (sawExistingLock) await retireExpiredCrossProcessLock(lockPath, deadline);
    await delayCrossProcessLock(25);
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    void ownedHandle?.utimes(now, now).catch(() => undefined);
  }, CROSS_PROCESS_LOCK_HEARTBEAT_MS);
  heartbeat.unref();

  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    await ownedHandle.close().catch(() => undefined);
    await releaseCrossProcessLock(lockPath, owned, token);
  }
}

async function retireExpiredCrossProcessLock(lockPath: string, deadline: number): Promise<boolean> {
  let inspected: { stat: Stats; record?: CrossProcessLockRecord };
  try {
    inspected = await inspectCrossProcessLock(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
  if (!crossProcessLockEntryExpired(inspected.stat)) return false;

  const recoveryMarker = await createCrossProcessLockMarker(lockPath, "recover");
  try {
    // Acquirers publish their intent before touching the lease. Any contender
    // that was already in flight when recovery started must remove that marker
    // before retirement can safely re-inspect and move the canonical entry.
    while (await hasLiveCrossProcessLockMarkers(lockPath, "acquire")) {
      if (Date.now() >= deadline) return false;
      await delayCrossProcessLock(10);
    }

    try {
      inspected = await inspectCrossProcessLock(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw err;
    }
    if (!crossProcessLockEntryExpired(inspected.stat)) return false;

    const stalePath = `${lockPath}.stale-${randomUUID()}`;
    if (!(await moveCrossProcessLockIfIdentityMatches(lockPath, stalePath, inspected.stat))) return false;
    await removeCrossProcessLockEntry(stalePath);
    return true;
  } finally {
    await removeCrossProcessLockMarker(recoveryMarker);
  }
}

async function releaseCrossProcessLock(lockPath: string, owned: Stats, token: string): Promise<void> {
  let inspected: { stat: Stats; record?: CrossProcessLockRecord };
  try {
    inspected = await inspectCrossProcessLock(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (!sameFileIdentity(owned, inspected.stat) || inspected.record?.token !== token) return;
  const releasedPath = `${lockPath}.released-${token}`;
  if (!(await moveCrossProcessLockIfIdentityMatches(lockPath, releasedPath, owned))) return;
  await removeCrossProcessLockEntry(releasedPath);
}

async function inspectCrossProcessLock(
  lockPath: string,
): Promise<{ stat: Stats; record?: CrossProcessLockRecord }> {
  const before = await fs.lstat(lockPath);
  assertSafeArtifactFile(before, lockPath);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(lockPath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    assertSafeArtifactFile(opened, lockPath);
    if (!sameFileIdentity(before, opened)) {
      throw new Error(`Hydra artifact writer lock changed while opening: ${lockPath}`);
    }
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let record: CrossProcessLockRecord | undefined;
    if (bytesRead <= 4096) {
      try {
        const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as Partial<CrossProcessLockRecord>;
        if (typeof parsed.token === "string" && typeof parsed.createdAt === "string") {
          record = { token: parsed.token, createdAt: parsed.createdAt };
        }
      } catch {
        // An exclusive creator can be between open and write. Its fresh mtime
        // keeps the incomplete lease active until it is released or expires.
      }
    }
    return { stat: opened, record };
  } finally {
    await handle.close();
  }
}

function crossProcessLockEntryExpired(stat: Stats): boolean {
  return Date.now() - stat.mtimeMs > CROSS_PROCESS_LOCK_TTL_MS;
}

type CrossProcessLockMarkerKind = "acquire" | "recover";

async function createCrossProcessLockMarker(
  lockPath: string,
  kind: CrossProcessLockMarkerKind,
): Promise<string> {
  const markerPath = `${lockPath}.${kind}-${randomUUID()}`;
  const handle = await fs.open(markerPath, "wx", 0o600);
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return markerPath;
}

async function hasLiveCrossProcessLockMarkers(
  lockPath: string,
  kind: CrossProcessLockMarkerKind,
): Promise<boolean> {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.${kind}-`;
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }

  let live = false;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const markerPath = path.join(directory, name);
    let stat: Stats;
    try {
      stat = await fs.lstat(markerPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    assertSafeArtifactFile(stat, markerPath);
    if (Date.now() - stat.mtimeMs > CROSS_PROCESS_MARKER_TTL_MS) {
      await removeCrossProcessLockEntry(markerPath);
    } else {
      live = true;
    }
  }
  return live;
}

async function removeCrossProcessLockMarker(markerPath: string): Promise<void> {
  await removeCrossProcessLockEntry(markerPath);
}

async function removeCrossProcessLockEntry(entryPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(entryPath);
    assertSafeArtifactFile(stat, entryPath);
    await fs.unlink(entryPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

async function moveCrossProcessLockIfIdentityMatches(
  source: string,
  destination: string,
  expected: Stats,
): Promise<boolean> {
  try {
    await fs.rename(source, destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  const moved = await fs.lstat(destination);
  if (sameFileIdentity(expected, moved)) return true;

  // The intent protocol makes this unreachable for cooperating Hydra
  // processes. Restore only while the canonical name is still absent; if an
  // external writer raced us, leave the unexpected entry quarantined rather
  // than overwrite a newer lock.
  try {
    await fs.rename(destination, source);
  } catch {
    // Fail closed. The caller will retry or time out without entering work.
  }
  return false;
}

function delayCrossProcessLock(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Crash-safe write: mkdir parent, write to a sibling .tmp, then rename.
// fs.rename over an existing file is atomic on POSIX and modern Windows,
// so a crash between truncation and write can't leave a corrupt empty file
// with no recovery path. Mirrors the previous inline copies in
// objective.ts, sessionBrief.ts, sessionState.ts.
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const previous = atomicWriteChains.get(filePath) ?? Promise.resolve();
  const next = previous.then(() => atomicWriteFileUnsafe(filePath, content));
  const settled = next.then(() => undefined, () => undefined);
  atomicWriteChains.set(filePath, settled);
  try {
    await next;
  } finally {
    if (atomicWriteChains.get(filePath) === settled) atomicWriteChains.delete(filePath);
  }
}

/**
 * Stream an append-style text file line by line into an atomic replacement.
 * This is intended for maintenance compaction where holding an entire JSONL
 * ledger and its rewritten copy in memory would defeat the read caps.
 */
export async function rewriteFileLinesAtomically(
  filePath: string,
  transform: (line: string) => string | undefined | Promise<string | undefined>,
  shouldCommit: () => boolean = () => true,
  options: { maxLineChars?: number } = {},
): Promise<void> {
  const previous = atomicWriteChains.get(filePath) ?? Promise.resolve();
  const next = previous.then(() => rewriteFileLinesAtomicallyUnsafe(filePath, transform, shouldCommit, options));
  const settled = next.then(() => undefined, () => undefined);
  atomicWriteChains.set(filePath, settled);
  try {
    await next;
  } finally {
    if (atomicWriteChains.get(filePath) === settled) atomicWriteChains.delete(filePath);
  }
}

async function rewriteFileLinesAtomicallyUnsafe(
  filePath: string,
  transform: (line: string) => string | undefined | Promise<string | undefined>,
  shouldCommit: () => boolean,
  options: { maxLineChars?: number },
): Promise<void> {
  await assertSafeArtifactParent(filePath);
  const before = await fs.lstat(filePath);
  assertSafeArtifactFile(before, filePath);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const source = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  let opened: Stats;
  try {
    opened = await source.stat();
    assertSafeArtifactFile(opened, filePath);
    if (!sameFileIdentity(before, opened)) {
      throw new Error(`Refusing to rewrite Hydra artifact after path swap: ${filePath}`);
    }
  } catch (err) {
    await source.close().catch(() => undefined);
    throw err;
  }

  const tmp = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  let destination: fs.FileHandle;
  try {
    destination = await fs.open(tmp, "wx");
  } catch (err) {
    await source.close().catch(() => undefined);
    throw err;
  }
  const stream = source.createReadStream({ encoding: "utf8", autoClose: false });
  const requestedLineChars = options.maxLineChars ?? DEFAULT_JSONL_READ_BYTES;
  const maxLineChars = Number.isFinite(requestedLineChars)
    ? Math.min(MAX_BOUNDED_READ_BYTES, Math.max(1, Math.floor(requestedLineChars)))
    : DEFAULT_JSONL_READ_BYTES;
  let outputPosition = 0;
  let completed = false;
  const writeLine = async (line: string): Promise<void> => {
    const transformed = await transform(line.endsWith("\r") ? line.slice(0, -1) : line);
    if (transformed === undefined) return;
    const buffer = Buffer.from(`${transformed}\n`, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      const written = await destination.write(buffer, offset, buffer.length - offset, outputPosition);
      if (written.bytesWritten === 0) throw new Error(`Unable to rewrite Hydra artifact: ${filePath}`);
      offset += written.bytesWritten;
      outputPosition += written.bytesWritten;
    }
  };
  try {
    try {
      let pending = "";
      for await (const chunk of stream) {
        pending += String(chunk);
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline < 0) break;
          if (newline > maxLineChars) {
            throw new Error(`Refusing to rewrite Hydra artifact with an oversized line: ${filePath}`);
          }
          await writeLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
        if (pending.length > maxLineChars) {
          throw new Error(`Refusing to rewrite Hydra artifact with an oversized line: ${filePath}`);
        }
      }
      if (pending.length > 0) await writeLine(pending);
      completed = true;
    } finally {
      stream.destroy();
      await Promise.allSettled([source.close(), destination.close()]);
    }
  } catch (err) {
    await unlinkIfRegularFile(tmp).catch(() => undefined);
    throw err;
  }

  if (!completed || !shouldCommit()) {
    await unlinkIfRegularFile(tmp);
    return;
  }

  try {
    const afterRead = await fs.lstat(filePath);
    assertSafeArtifactFile(afterRead, filePath);
    if (!sameFileIdentity(opened, afterRead)) {
      throw new Error(`Refusing to rewrite Hydra artifact after path swap: ${filePath}`);
    }
    await assertSafeArtifactParent(filePath);
    await fs.rename(tmp, filePath);
  } catch (err) {
    await unlinkIfRegularFile(tmp).catch(() => undefined);
    throw err;
  }
}

async function atomicWriteFileUnsafe(filePath: string, content: string): Promise<void> {
  await assertSafeArtifactParent(filePath, true);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await assertSafeArtifactParent(filePath);
  // Why: refuse to write through a symlink at the destination. A malicious
  // workspace can pre-plant .hydra/<artifact>.{md,jsonl} as a symlink to
  // ~/.ssh/authorized_keys etc.; fs.rename below would otherwise overwrite
  // the destination, but if the user later opened that file expecting our
  // content they'd be reading attacker-controlled bytes. We also guard the
  // temporary side uses an unguessable exclusive sibling path.
  await refuseSymlink(filePath);
  const tmp = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, "wx");
  try {
    await assertSafeArtifactParent(filePath);
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await assertSafeArtifactParent(filePath);
    await fs.rename(tmp, filePath);
  } catch (err) {
    await unlinkIfRegularFile(tmp).catch(() => undefined);
    throw err;
  }
}

export interface ReadJsonlOptions {
  /** Keep only the last N items (after type-guard filtering). Useful for log tails. */
  limit?: number;
  /** Maximum trailing file bytes to inspect. Values are clamped to a hard 32 MiB ceiling. */
  maxBytes?: number;
  /** Propagate read failures. The default preserves the historical empty-list behavior. */
  throwOnReadError?: boolean;
}

export interface BoundedFileTail {
  text: string;
  totalBytes: number;
  truncated: boolean;
  startsAtLineBoundary: boolean;
}

export interface BoundedFileHead {
  text: string;
  totalBytes: number;
  truncated: boolean;
}

export const DEFAULT_JSONL_READ_BYTES = 8 * 1024 * 1024;
export const MAX_BOUNDED_READ_BYTES = 32 * 1024 * 1024;
const MAX_JSONL_RECORDS = 20_000;
const MAX_JSONL_RECORD_CHARS = 1_000_000;

export interface BoundedLineScannerOptions {
  /** Maximum characters retained for one line assembled across chunks. */
  maxLineChars: number;
  /** Complete lines handled from the beginning of one push. */
  headLinesPerPush: number;
  /** Complete lines handled from the end when a push exceeds the head cap. */
  tailLinesPerPush: number;
}

/**
 * Incrementally split arbitrary chunks without allocating an array per line.
 *
 * A hostile CLI can place millions of newlines in one bounded stdout chunk.
 * `String#split` turns that into millions of strings, and callers that queue
 * one promise per result amplify it again. This scanner handles a bounded
 * head and tail of each push, keeps only one bounded partial line, and reports
 * skipped/oversized input through `onDrop`. Keeping the tail means terminal
 * result events remain visible when an intermediate stream is noisy.
 */
export class BoundedLineScanner {
  private partial = "";
  private discardingOversizedLine = false;

  constructor(private readonly options: BoundedLineScannerOptions) {}

  push(chunk: string, onLine: (line: string) => void, onDrop: () => void = () => undefined): void {
    if (!chunk) return;
    const headLimit = Math.max(1, Math.floor(this.options.headLinesPerPush));
    const tailLimit = Math.max(0, Math.floor(this.options.tailLinesPerPush));
    let start = 0;
    let handled = 0;

    while (handled < headLimit) {
      const newline = chunk.indexOf("\n", start);
      if (newline < 0) break;
      this.consumeSegment(chunk, start, newline, onLine, onDrop);
      start = newline + 1;
      handled++;
    }

    const nextNewline = chunk.indexOf("\n", start);
    if (nextNewline >= 0) {
      const tailStart = tailLimit > 0 ? tailLineStart(chunk, start, tailLimit) : chunk.length;
      if (tailStart > start) {
        // The partial prefix belongs to a skipped middle line and cannot be
        // joined safely to the first retained tail record.
        this.partial = "";
        this.discardingOversizedLine = false;
        onDrop();
      }
      start = tailStart;
      for (;;) {
        const newline = chunk.indexOf("\n", start);
        if (newline < 0) break;
        this.consumeSegment(chunk, start, newline, onLine, onDrop);
        start = newline + 1;
      }
    }

    this.retainPartial(chunk, start, onDrop);
  }

  flush(onLine: (line: string) => void): void {
    if (!this.discardingOversizedLine && this.partial.length > 0) onLine(this.partial);
    this.partial = "";
    this.discardingOversizedLine = false;
  }

  private consumeSegment(
    chunk: string,
    start: number,
    end: number,
    onLine: (line: string) => void,
    onDrop: () => void,
  ): void {
    if (this.discardingOversizedLine) {
      this.discardingOversizedLine = false;
      this.partial = "";
      return;
    }
    const segmentChars = end - start;
    if (this.partial.length + segmentChars > this.options.maxLineChars) {
      this.partial = "";
      onDrop();
      return;
    }
    const segment = chunk.slice(start, end);
    const line = this.partial ? this.partial + segment : segment;
    this.partial = "";
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }

  private retainPartial(chunk: string, start: number, onDrop: () => void): void {
    if (this.discardingOversizedLine) return;
    const remaining = chunk.length - start;
    if (this.partial.length + remaining > this.options.maxLineChars) {
      this.partial = "";
      this.discardingOversizedLine = true;
      onDrop();
      return;
    }
    if (remaining > 0) this.partial += chunk.slice(start);
  }
}

/**
 * Map non-empty lines from a complete string with bounded record allocation.
 * A prefix and the newest suffix are retained; the suffix is deliberately
 * favored so terminal result/error events survive record floods.
 */
export function mapBoundedNonEmptyLines<T>(
  text: string,
  mapLine: (line: string) => T,
  oversizedValue: () => T,
  options: { maxRecords?: number; headRecords?: number; maxLineChars?: number } = {},
): T[] {
  const maxRecords = clampPositiveInteger(options.maxRecords, MAX_JSONL_RECORDS);
  const headRecords = Math.min(maxRecords, clampPositiveInteger(options.headRecords, Math.floor(maxRecords / 4)));
  const maxLineChars = clampPositiveInteger(options.maxLineChars, MAX_JSONL_RECORD_CHARS);
  const head: T[] = [];
  let cursor = 0;
  let retainedPrefixEnd = 0;
  let overflow = false;

  while (cursor <= text.length) {
    const newline = text.indexOf("\n", cursor);
    const rawEnd = newline < 0 ? text.length : newline;
    const bounds = nonWhitespaceBounds(text, cursor, rawEnd);
    const next = newline < 0 ? text.length + 1 : newline + 1;
    if (bounds) {
      if (head.length >= headRecords) {
        overflow = true;
        break;
      }
      head.push(bounds.end - bounds.start > maxLineChars
        ? oversizedValue()
        : mapLine(text.slice(bounds.start, bounds.end)));
      retainedPrefixEnd = next;
    }
    if (newline < 0) break;
    cursor = next;
  }
  if (!overflow || head.length >= maxRecords) return head;

  const tail: T[] = [];
  let end = text.length;
  const tailCapacity = maxRecords - head.length;
  while (end > retainedPrefixEnd && tail.length < tailCapacity) {
    const newline = text.lastIndexOf("\n", end - 1);
    const start = Math.max(retainedPrefixEnd, newline + 1);
    const bounds = nonWhitespaceBounds(text, start, end);
    if (bounds) {
      tail.push(bounds.end - bounds.start > maxLineChars
        ? oversizedValue()
        : mapLine(text.slice(bounds.start, bounds.end)));
    }
    if (newline < retainedPrefixEnd) break;
    end = newline;
  }
  tail.reverse();
  return head.concat(tail);
}

/**
 * Read at most `maxBytes` from the newest end of a regular file.
 *
 * The handle is identity-checked against the directory entry so a workspace
 * path swap cannot redirect a Hydra read through a symlink or hard link. The
 * returned line-boundary flag lets append-log parsers discard only the torn
 * first record when the byte window starts in the middle of a line.
 */
export async function readFileTail(filePath: string, maxBytes: number): Promise<BoundedFileTail> {
  const byteCap = boundedReadBytes(maxBytes);
  await assertSafeArtifactParent(filePath);
  const before = await fs.lstat(filePath);
  assertSafeArtifactFile(before, filePath);

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    assertSafeArtifactFile(opened, filePath);
    if (!sameFileIdentity(before, opened)) {
      throw new Error(`Refusing to read Hydra artifact after path swap: ${filePath}`);
    }

    const totalBytes = opened.size;
    const start = Math.max(0, totalBytes - byteCap);
    let startsAtLineBoundary = start === 0;
    if (start > 0) {
      const previousByte = Buffer.allocUnsafe(1);
      const previous = await handle.read(previousByte, 0, 1, start - 1);
      startsAtLineBoundary = previous.bytesRead === 1 && previousByte[0] === 0x0a;
    }

    const buffer = Buffer.allocUnsafe(Math.max(0, totalBytes - start));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const next = await handle.read(buffer, bytesRead, buffer.length - bytesRead, start + bytesRead);
      if (next.bytesRead === 0) break;
      bytesRead += next.bytesRead;
    }

    const afterRead = await fs.lstat(filePath);
    assertSafeArtifactFile(afterRead, filePath);
    if (!sameFileIdentity(opened, afterRead)) {
      throw new Error(`Refusing to read Hydra artifact after path swap: ${filePath}`);
    }

    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      totalBytes,
      truncated: start > 0,
      startsAtLineBoundary,
    };
  } finally {
    await handle.close();
  }
}

/** Read at most `maxBytes` from the beginning of a safely-opened regular file. */
export async function readFileHead(filePath: string, maxBytes: number): Promise<BoundedFileHead> {
  const byteCap = boundedReadBytes(maxBytes);
  await assertSafeArtifactParent(filePath);
  const before = await fs.lstat(filePath);
  assertSafeArtifactFile(before, filePath);

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    assertSafeArtifactFile(opened, filePath);
    if (!sameFileIdentity(before, opened)) {
      throw new Error(`Refusing to read Hydra artifact after path swap: ${filePath}`);
    }

    const readLength = Math.min(opened.size, byteCap);
    const buffer = Buffer.allocUnsafe(readLength);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const next = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (next.bytesRead === 0) break;
      bytesRead += next.bytesRead;
    }

    const afterRead = await fs.lstat(filePath);
    assertSafeArtifactFile(afterRead, filePath);
    if (!sameFileIdentity(opened, afterRead)) {
      throw new Error(`Refusing to read Hydra artifact after path swap: ${filePath}`);
    }
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      totalBytes: opened.size,
      truncated: opened.size > readLength,
    };
  } finally {
    await handle.close();
  }
}

/** Synchronous counterpart for bounded, beginning-of-file prompt assembly. */
export function readFileHeadSync(filePath: string, maxBytes: number): BoundedFileHead {
  const byteCap = boundedReadBytes(maxBytes);
  assertSafeArtifactParentSync(filePath);
  const before = lstatSync(filePath);
  assertSafeArtifactFile(before, filePath);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    assertSafeArtifactFile(opened, filePath);
    if (!sameFileIdentity(before, opened)) {
      throw new Error(`Refusing to read Hydra artifact after path swap: ${filePath}`);
    }

    const readLength = Math.min(opened.size, byteCap);
    const buffer = Buffer.allocUnsafe(readLength);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const next = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (next === 0) break;
      bytesRead += next;
    }

    const afterRead = lstatSync(filePath);
    assertSafeArtifactFile(afterRead, filePath);
    if (!sameFileIdentity(opened, afterRead)) {
      throw new Error(`Refusing to read Hydra artifact after path swap: ${filePath}`);
    }

    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      totalBytes: opened.size,
      truncated: opened.size > readLength,
    };
  } finally {
    closeSync(fd);
  }
}

/** Synchronous counterpart for prompt assembly paths that cannot await I/O. */
export function readFileTailSync(filePath: string, maxBytes: number): BoundedFileTail {
  const byteCap = boundedReadBytes(maxBytes);
  assertSafeArtifactParentSync(filePath);
  const before = lstatSync(filePath);
  assertSafeArtifactFile(before, filePath);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    assertSafeArtifactFile(opened, filePath);
    if (!sameFileIdentity(before, opened)) {
      throw new Error(`Refusing to read Hydra artifact after path swap: ${filePath}`);
    }

    const totalBytes = opened.size;
    const start = Math.max(0, totalBytes - byteCap);
    let startsAtLineBoundary = start === 0;
    if (start > 0) {
      const previousByte = Buffer.allocUnsafe(1);
      startsAtLineBoundary = readSync(fd, previousByte, 0, 1, start - 1) === 1 && previousByte[0] === 0x0a;
    }

    const buffer = Buffer.allocUnsafe(Math.max(0, totalBytes - start));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const next = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, start + bytesRead);
      if (next === 0) break;
      bytesRead += next;
    }

    const afterRead = lstatSync(filePath);
    assertSafeArtifactFile(afterRead, filePath);
    if (!sameFileIdentity(opened, afterRead)) {
      throw new Error(`Refusing to read Hydra artifact after path swap: ${filePath}`);
    }

    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      totalBytes,
      truncated: start > 0,
      startsAtLineBoundary,
    };
  } finally {
    closeSync(fd);
  }
}

// Standard JSONL tail reader: scan newest-to-oldest, JSON.parse each complete
// record, drop lines that fail parse/type guards, then restore chronological
// order. Reverse scanning naturally implements `limit`, preserves the newest
// records under the hard record cap, and avoids `split()` line amplification.
export async function readJsonlGuarded<T>(
  filePath: string,
  guard: (value: unknown) => value is T,
  options: ReadJsonlOptions = {}
): Promise<T[]> {
  let tail: BoundedFileTail;
  try {
    tail = await readFileTail(filePath, options.maxBytes ?? DEFAULT_JSONL_READ_BYTES);
  } catch (err) {
    if (options.throwOnReadError) throw err;
    return [];
  }
  const text = tail.text;
  let minimumIndex = 0;
  if (tail.truncated && !tail.startsAtLineBoundary) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline < 0) return [];
    minimumIndex = firstNewline + 1;
  }
  const requestedLimit = options.limit && options.limit > 0
    ? Math.min(MAX_JSONL_RECORDS, Math.floor(options.limit))
    : MAX_JSONL_RECORDS;
  const newestFirst: T[] = [];
  let recordsInspected = 0;
  let end = text.length;
  while (end > minimumIndex && recordsInspected < MAX_JSONL_RECORDS && newestFirst.length < requestedLimit) {
    const newline = text.lastIndexOf("\n", end - 1);
    const start = Math.max(minimumIndex, newline + 1);
    const bounds = nonWhitespaceBounds(text, start, end);
    if (bounds) {
      recordsInspected++;
      if (bounds.end - bounds.start <= MAX_JSONL_RECORD_CHARS) {
        try {
          const parsed: unknown = JSON.parse(text.slice(bounds.start, bounds.end));
          if (guard(parsed)) newestFirst.push(parsed);
        } catch {
          // Keep Hydra resilient if a user inspects or hand-edits the JSONL.
        }
      }
    }
    if (newline < minimumIndex) break;
    end = newline;
  }
  newestFirst.reverse();
  return newestFirst;
}

function boundedReadBytes(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_JSONL_READ_BYTES;
  return Math.min(MAX_BOUNDED_READ_BYTES, Math.max(0, Math.floor(value)));
}

function tailLineStart(chunk: string, minimumStart: number, lineCount: number): number {
  let boundary = chunk.lastIndexOf("\n");
  if (boundary < minimumStart) return minimumStart;
  let start = boundary + 1;
  for (let count = 0; count < lineCount && boundary >= minimumStart; count++) {
    const previous = chunk.lastIndexOf("\n", boundary - 1);
    start = Math.max(minimumStart, previous + 1);
    boundary = previous;
  }
  return start;
}

function nonWhitespaceBounds(text: string, rawStart: number, rawEnd: number): { start: number; end: number } | undefined {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && isJsonWhitespace(text.charCodeAt(start))) start++;
  while (end > start && isJsonWhitespace(text.charCodeAt(end - 1))) end--;
  return start < end ? { start, end } : undefined;
}

function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return Math.max(1, fallback);
  return Math.max(1, Math.floor(value));
}

// Why: lstat (NOT stat) so we see the link itself, not its target. A
// missing path is not an error — the caller will create it.
async function refuseSymlink(filePath: string): Promise<void> {
  try {
    const st = await fs.lstat(filePath);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to write Hydra artifact through symlink: ${filePath}`);
    }
  } catch (err) {
    // ENOENT: nothing to refuse yet — caller will create the path.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function assertSafeArtifactFile(stat: Stats, filePath: string): void {
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to write Hydra artifact through symlink: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing to write Hydra artifact through non-file entry: ${filePath}`);
  }
  // A regular file with nlink > 1 may be a hard link to an unrelated file.
  // Path-based append would mutate every name for that inode.
  if (stat.nlink !== 1) {
    throw new Error(`Refusing to write Hydra artifact with multiple hard links: ${filePath}`);
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function assertSafeArtifactParent(filePath: string, allowMissing = false): Promise<void> {
  const boundary = hydraBoundary(filePath);
  if (!boundary) return;
  try {
    const rootStat = await fs.lstat(boundary.hydraRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error(`Refusing to write Hydra artifact through linked .hydra directory: ${filePath}`);
    }
    const [realWorkspace, realHydra, realParent] = await Promise.all([
      fs.realpath(boundary.workspaceRoot),
      fs.realpath(boundary.hydraRoot),
      fs.realpath(path.dirname(filePath)),
    ]);
    const expectedHydra = path.join(realWorkspace, ".hydra");
    if (!samePath(realHydra, expectedHydra) || !isPathWithin(realHydra, realParent)) {
      throw new Error(`Refusing to write Hydra artifact through linked parent directory: ${filePath}`);
    }
  } catch (err) {
    if (allowMissing && (err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

function assertSafeArtifactParentSync(filePath: string): void {
  const boundary = hydraBoundary(filePath);
  if (!boundary) return;
  const rootStat = lstatSync(boundary.hydraRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Refusing to read Hydra artifact through linked .hydra directory: ${filePath}`);
  }
  const realWorkspace = realpathSync(boundary.workspaceRoot);
  const realHydra = realpathSync(boundary.hydraRoot);
  const realParent = realpathSync(path.dirname(filePath));
  const expectedHydra = path.join(realWorkspace, ".hydra");
  if (!samePath(realHydra, expectedHydra) || !isPathWithin(realHydra, realParent)) {
    throw new Error(`Refusing to read Hydra artifact through linked parent directory: ${filePath}`);
  }
}

function hydraBoundary(filePath: string): { workspaceRoot: string; hydraRoot: string } | undefined {
  let current = path.dirname(path.resolve(filePath));
  for (;;) {
    const name = path.basename(current);
    if (process.platform === "win32" ? name.toLowerCase() === ".hydra" : name === ".hydra") {
      return { workspaceRoot: path.dirname(current), hydraRoot: current };
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isPathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Why: we want to clear stale .tmp files left by a prior crash, but we
// must NOT unlink a symlink (attacker-planted) or directory — leaving
// those in place causes the subsequent fs.open(..., "wx") to fail closed.
async function unlinkIfRegularFile(filePath: string): Promise<void> {
  try {
    const st = await fs.lstat(filePath);
    if (st.isFile()) {
      await fs.unlink(filePath);
    }
  } catch (err) {
    // ENOENT: nothing to clean up.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
