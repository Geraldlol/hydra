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
    await fs.stat(filePath);
  } catch {
    await fs.writeFile(filePath, defaultContent, "utf8");
  }
}

// Crash-safe write: mkdir parent, write to a sibling .tmp, then rename.
// fs.rename over an existing file is atomic on POSIX and modern Windows,
// so a crash between truncation and write can't leave a corrupt empty file
// with no recovery path. Mirrors the previous inline copies in
// objective.ts, sessionBrief.ts, sessionState.ts.
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
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
