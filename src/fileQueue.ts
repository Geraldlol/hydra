import * as fs from "node:fs/promises";
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

export async function serializePerFile<T>(
  filePath: string,
  work: () => Promise<T>
): Promise<T> {
  const previous = writeChains.get(filePath) ?? Promise.resolve();
  const next = previous.then(work);
  writeChains.set(filePath, next.then(() => undefined, () => undefined));
  return next;
}

// Idempotent "make sure this file exists" helper. Used at startup to seed
// .hydra/* artifact files with their default content. Mirrors the previous
// per-module ensure*File functions, which all had this exact shape.
export async function ensureFile(filePath: string, defaultContent = ""): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    // Why: fs.stat follows symlinks, so a malicious workspace that ships
    // .hydra/<artifact> as a symlink to ~/.ssh/authorized_keys would pass
    // the "already exists" check and we'd skip seeding (good) — but if the
    // symlink target didn't exist yet, stat would throw ENOENT and we'd
    // fs.writeFile straight through the symlink. lstat sees the link itself.
    const st = await fs.lstat(filePath);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to write Hydra artifact through symlink: ${filePath}`);
    }
    // exists as a regular file/directory — nothing to do
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
    await handle.writeFile(defaultContent, "utf8");
  } finally {
    await handle.close();
  }
}

// Crash-safe write: mkdir parent, write to a sibling .tmp, then rename.
// fs.rename over an existing file is atomic on POSIX and modern Windows,
// so a crash between truncation and write can't leave a corrupt empty file
// with no recovery path. Mirrors the previous inline copies in
// objective.ts, sessionBrief.ts, sessionState.ts.
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Why: refuse to write through a symlink at the destination. A malicious
  // workspace can pre-plant .hydra/<artifact>.{md,jsonl} as a symlink to
  // ~/.ssh/authorized_keys etc.; fs.rename below would otherwise overwrite
  // the destination, but if the user later opened that file expecting our
  // content they'd be reading attacker-controlled bytes. We also guard the
  // tmp side because fs.writeFile follows a pre-existing tmp symlink.
  await refuseSymlink(filePath);
  const tmp = `${filePath}.tmp`;
  // Clear a stale-tmp from a prior crash, but only when it's a regular file;
  // if it's a symlink (planted) or directory, leave it so the fs.open below
  // fails closed with EEXIST instead of silently unlinking attacker bait.
  await unlinkIfRegularFile(tmp);
  // O_EXCL ("wx"): if tmp still exists (including as a symlink), fail closed.
  const handle = await fs.open(tmp, "wx");
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
}

export interface ReadJsonlOptions {
  /** Keep only the last N items (after type-guard filtering). Useful for log tails. */
  limit?: number;
}

// Standard JSONL reader: split lines, JSON.parse each, drop lines that fail
// parse or the type guard. Treats a missing file as an empty list (the
// .hydra/* artifacts are seeded lazily and may not exist on first run).
// Other I/O errors (permission denied, ENOMEM) are still swallowed to match
// the prior per-module behavior; usage.ts uses a stricter ENOENT-only
// discipline and is intentionally not migrated here.
export async function readJsonlGuarded<T>(
  filePath: string,
  guard: (value: unknown) => value is T,
  options: ReadJsonlOptions = {}
): Promise<T[]> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const items: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (guard(parsed)) items.push(parsed);
    } catch {
      // Keep Hydra resilient if a user inspects or hand-edits the JSONL.
    }
  }
  return options.limit && options.limit > 0 ? items.slice(-options.limit) : items;
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
