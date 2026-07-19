// Handoff inbox: validates and ingests handoff packets that the /hydra-handoff
// skill (Claude Code / Codex CLI) drops into <workspace>/.hydra/handoff-inbox/.
// Packets are UNTRUSTED (anything can write to .hydra/), so this module only
// parses and surfaces them — nothing here ever spawns an agent. The room's
// confirm chip is the mandatory gate.

import * as fs from "node:fs/promises";
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
