// Handoff inbox: validates and ingests handoff packets that the /hydra-handoff
// skill (Claude Code / Codex CLI) drops into <workspace>/.hydra/handoff-inbox/.
// Packets are UNTRUSTED (anything can write to .hydra/), so this module only
// parses and surfaces them — nothing here ever spawns an agent. The room's
// confirm chip is the mandatory gate.

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
