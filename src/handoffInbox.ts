// Handoff inbox: validates and ingests handoff packets that the /hydra-handoff
// skill (Claude Code / Codex CLI) drops into <workspace>/.hydra/handoff-inbox/.
// Packets are UNTRUSTED (anything can write to .hydra/), so this module only
// parses and surfaces them — nothing here ever spawns an agent. The room's
// confirm chip is the mandatory gate.

import * as fs from "node:fs/promises";
import { watch as watchFileSystem, type FSWatcher } from "node:fs";
import * as path from "node:path";

export type HandoffAction = "discuss" | "askBoth" | "buildCodex" | "buildClaude";

export interface HandoffPacket {
  version: 1;
  createdAt: string;
  source: string;
  title: string;
  prompt: string;
  suggestedAction: HandoffAction;
  context?: { branch?: string; filesTouched?: string[] };
}

export const HANDOFF_ACTIONS: readonly HandoffAction[] = [
  "discuss",
  "askBoth",
  "buildCodex",
  "buildClaude",
];

export const HANDOFF_MAX_FILE_BYTES = 256 * 1024;
export const HANDOFF_MAX_TITLE_CHARS = 200;
export const HANDOFF_MAX_FILES_TOUCHED = 50;
export const HANDOFF_MAX_SOURCE_CHARS = 40;

export type HandoffValidationResult =
  | { ok: true; packet: HandoffPacket }
  | { ok: false; reason: string };

function isHandoffAction(value: unknown): value is HandoffAction {
  return typeof value === "string" && (HANDOFF_ACTIONS as readonly string[]).includes(value);
}

export function validateHandoffPacket(raw: unknown): HandoffValidationResult {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "packet is not an object" };
  const p = raw as Record<string, unknown>;

  if (p.version !== 1) return { ok: false, reason: `unsupported version: ${String(p.version)}` };
  if (typeof p.title !== "string" || !p.title.trim()) return { ok: false, reason: "title missing or empty" };
  if (p.title.length > HANDOFF_MAX_TITLE_CHARS) return { ok: false, reason: "title too long" };
  if (typeof p.prompt !== "string" || !p.prompt.trim()) return { ok: false, reason: "prompt missing or empty" };
  if (!isHandoffAction(p.suggestedAction)) {
    return { ok: false, reason: `invalid suggestedAction: ${String(p.suggestedAction)}` };
  }

  const source =
    typeof p.source === "string" && p.source.trim()
      ? p.source.slice(0, HANDOFF_MAX_SOURCE_CHARS)
      : "unknown";
  const createdAt = typeof p.createdAt === "string" ? p.createdAt : "";

  let context: HandoffPacket["context"];
  if (p.context && typeof p.context === "object") {
    const c = p.context as Record<string, unknown>;
    const branch = typeof c.branch === "string" ? c.branch : undefined;
    let filesTouched: string[] | undefined;
    if (Array.isArray(c.filesTouched)) {
      filesTouched = c.filesTouched
        .filter((x): x is string => typeof x === "string")
        .slice(0, HANDOFF_MAX_FILES_TOUCHED);
    }
    context = { branch, filesTouched };
  }

  return {
    ok: true,
    packet: {
      version: 1,
      createdAt,
      source,
      title: p.title,
      prompt: p.prompt,
      suggestedAction: p.suggestedAction,
      context,
    },
  };
}

export function handoffInboxDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".hydra", "handoff-inbox");
}

export function handoffConsumedDir(workspaceRoot: string): string {
  return path.join(handoffInboxDir(workspaceRoot), "consumed");
}

export function handoffRejectedDir(workspaceRoot: string): string {
  return path.join(handoffInboxDir(workspaceRoot), "rejected");
}

export async function ensureHandoffInboxDirs(workspaceRoot: string): Promise<void> {
  // Creating the leaf children creates the parent inbox dir too.
  await fs.mkdir(handoffConsumedDir(workspaceRoot), { recursive: true });
  await fs.mkdir(handoffRejectedDir(workspaceRoot), { recursive: true });
}

export interface ScannedHandoff {
  file: string;
  packet: HandoffPacket;
}

export interface HandoffScanResult {
  valid: ScannedHandoff[];
  rejected: { file: string; reason: string }[];
}

export async function scanHandoffInbox(workspaceRoot: string): Promise<HandoffScanResult> {
  const dir = handoffInboxDir(workspaceRoot);
  const result: HandoffScanResult = { valid: [], rejected: [] };

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    // ENOENT before the inbox is ensured on first run — nothing to scan.
    return result;
  }

  for (const name of entries) {
    // Only *.json are packets. This skips *.tmp half-writes and the
    // consumed/ and rejected/ subdirectory names.
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);

    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      // Vanished between readdir and stat (concurrent consume) — skip.
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > HANDOFF_MAX_FILE_BYTES) {
      result.rejected.push({ file, reason: `file exceeds ${HANDOFF_MAX_FILE_BYTES} bytes` });
      continue;
    }

    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      // Race with a consume/reject move — skip; a later scan re-reads if present.
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      result.rejected.push({ file, reason: "invalid JSON" });
      continue;
    }

    const validation = validateHandoffPacket(parsed);
    if (validation.ok) result.valid.push({ file, packet: validation.packet });
    else result.rejected.push({ file, reason: validation.reason });
  }

  return result;
}

export async function moveHandoffFile(file: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(file));
  try {
    await fs.rename(file, dest);
  } catch {
    // rename fails across devices, or on Windows when dest exists. Fall back to
    // copy+unlink; if the source is already gone (concurrent scan), do nothing.
    try {
      await fs.copyFile(file, dest);
      await fs.unlink(file);
    } catch {
      // Source already moved by a concurrent scan — nothing to do.
    }
  }
}

export interface HandoffInboxDeps {
  workspaceRoot(): string;
  // Ready = workspace folder loaded AND workspace trusted. Handoff ingest is
  // gated on both; see panel wiring.
  isReady(): boolean;
  appendSystemMessage(text: string): Promise<void>;
  postState(): void;
  // Routes an accepted handoff through the panel's single sendUserMessage entry
  // point. The panel maps action -> (opener, framing); this module never spawns.
  runHandoff(action: HandoffAction, prompt: string): Promise<void>;
  openMarkdownPreview(title: string, body: string): Promise<void>;
}

export interface PendingHandoffSummary {
  title: string;
  source: string;
  suggestedAction: HandoffAction;
}

/**
 * Owns the .hydra/handoff-inbox watcher and drives the room's confirm chip.
 *
 * Untrusted-input invariants:
 *  - nothing here runs an agent; confirm() only calls deps.runHandoff after an
 *    explicit user click,
 *  - one packet is presented at a time (a pending chip blocks re-scan), so a
 *    flood of packets cannot spam the room,
 *  - rejected packets are quarantined to rejected/ so they cannot re-fire,
 *  - a processed-set of basenames guards against moveHandoffFile (best-effort,
 *    returns void even on failure) leaving a handled packet's file behind and
 *    having a later scan re-present it.
 */
export class HandoffInboxController {
  private watcher: FSWatcher | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private pendingPacket: HandoffPacket | undefined;
  private pendingFile: string | undefined;
  // Basenames handled this session (consumed or rejected). See class doc.
  private readonly processed = new Set<string>();

  constructor(private readonly deps: HandoffInboxDeps) {}

  async start(): Promise<void> {
    if (this.disposed || !this.deps.isReady()) return;
    try {
      await ensureHandoffInboxDirs(this.deps.workspaceRoot());
    } catch {
      // Cannot create inbox dirs (read-only FS / perms). Handoff ingest is a
      // best-effort convenience; degrade silently rather than block the room.
      return;
    }
    await this.scanNow();
    this.startWatcher();
  }

  private startWatcher(): void {
    try {
      const dir = handoffInboxDir(this.deps.workspaceRoot());
      const watcher = watchFileSystem(dir, { persistent: false }, () => {
        if (this.disposed) return;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = undefined;
          void this.scanNow();
        }, 300);
      });
      // Watch failure must not crash the host; scan-on-open already surfaced
      // anything written before the room opened.
      watcher.on("error", () => watcher.close());
      this.watcher = watcher;
    } catch {
      // Some remote/custom filesystems cannot be watched. Scan-on-open remains.
    }
  }

  async scanNow(): Promise<void> {
    if (this.disposed || !this.deps.isReady()) return;
    // One at a time: a pending chip must be resolved before the next surfaces.
    if (this.pendingPacket) return;

    const root = this.deps.workspaceRoot();
    const scan = await scanHandoffInbox(root);

    for (const bad of scan.rejected) {
      // Already handled this session (e.g. a prior move left the file behind) — skip.
      if (this.processed.has(basename(bad.file))) continue;
      await moveHandoffFile(bad.file, handoffRejectedDir(root));
      await this.deps.appendSystemMessage(
        `Hydra rejected a handoff packet (${basename(bad.file)}): ${bad.reason}. Moved to handoff-inbox/rejected/.`
      );
      this.processed.add(basename(bad.file));
    }

    const candidates = scan.valid.filter((v) => !this.processed.has(basename(v.file)));
    if (!candidates.length) {
      if (scan.rejected.length) this.deps.postState();
      return;
    }

    // Filenames are timestamp-prefixed, so lexicographic order is chronological.
    const sorted = candidates.slice().sort((a, b) => basename(a.file).localeCompare(basename(b.file)));
    // Why: candidates.length > 0 guarantees sorted[0] exists, but
    // noUncheckedIndexedAccess still widens the index read to T | undefined.
    const chosen = sorted[0];
    if (!chosen) return;
    this.pendingPacket = chosen.packet;
    this.pendingFile = chosen.file;
    await this.deps.appendSystemMessage(
      `Handoff from ${chosen.packet.source}: "${chosen.packet.title}". Confirm in the banner to run it, or dismiss it.`
    );
    this.deps.postState();
  }

  pending(): PendingHandoffSummary | undefined {
    if (!this.pendingPacket) return undefined;
    return {
      title: this.pendingPacket.title,
      source: this.pendingPacket.source,
      suggestedAction: this.pendingPacket.suggestedAction,
    };
  }

  async confirm(overrideAction?: HandoffAction): Promise<void> {
    const packet = this.pendingPacket;
    const file = this.pendingFile;
    if (!packet || !file) return;
    const action = overrideAction && isHandoffAction(overrideAction) ? overrideAction : packet.suggestedAction;
    // Clear pending and mark processed BEFORE the (possibly long) archive
    // await so a watcher re-scan cannot re-present the same packet in the
    // window before the move completes.
    this.pendingPacket = undefined;
    this.pendingFile = undefined;
    this.processed.add(basename(file));
    await moveHandoffFile(file, handoffConsumedDir(this.deps.workspaceRoot()));
    this.deps.postState();
    await this.deps.runHandoff(action, packet.prompt);
  }

  async dismiss(): Promise<void> {
    const file = this.pendingFile;
    this.pendingPacket = undefined;
    this.pendingFile = undefined;
    // Mark processed BEFORE the archive await — see confirm()'s comment.
    if (file) {
      this.processed.add(basename(file));
      await moveHandoffFile(file, handoffConsumedDir(this.deps.workspaceRoot()));
    }
    await this.deps.appendSystemMessage("Handoff dismissed.");
    this.deps.postState();
    // Slot is free; surface the next queued packet if any.
    await this.scanNow();
  }

  async preview(): Promise<void> {
    const packet = this.pendingPacket;
    if (!packet) return;
    await this.deps.openMarkdownPreview(packet.title, packet.prompt);
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.watcher?.close();
  }
}

function basename(file: string): string {
  return path.basename(file);
}
