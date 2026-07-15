import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentId } from "./phases";

const UTF8_MAX_BYTES_PER_CHARACTER = 4;
const TRUNCATION_NOTICE = "\n[... truncated by Hydra ...]";

// `maxChars = 0` historically meant "load everything and cap it later while
// building the prompt". Keep that prompt behavior, but put a finite ceiling on
// how much untrusted workspace data Hydra will read and retain.
export const WORKSPACE_INSTRUCTIONS_SAFE_MAX_CHARS = 1024 * 1024;

export interface WorkspaceInstructionSource {
  path: string;
  label: string;
}

export const DEFAULT_WORKSPACE_INSTRUCTION_SOURCES: WorkspaceInstructionSource[] = [
  { path: "CLAUDE.md", label: "CLAUDE.md" },
  { path: "AGENTS.md", label: "AGENTS.md" },
  { path: path.join(".codex", "instructions.md"), label: ".codex/instructions.md" },
  { path: path.join(".github", "copilot-instructions.md"), label: ".github/copilot-instructions.md" },
];

export interface ReadWorkspaceInstructionsOptions {
  agent?: AgentId;
}

export async function readWorkspaceInstructions(
  workspaceRoot: string,
  maxChars = 12000,
  sources = DEFAULT_WORKSPACE_INSTRUCTION_SOURCES,
  options: ReadWorkspaceInstructionsOptions = {}
): Promise<string> {
  const workspacePath = path.resolve(workspaceRoot);
  let realWorkspacePath: string;
  try {
    const workspaceStat = await fs.stat(workspacePath);
    if (!workspaceStat.isDirectory()) return "";
    realWorkspacePath = await fs.realpath(workspacePath);
  } catch {
    return "";
  }

  const sections: string[] = [];
  const requestedMaxChars = Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars)
    : WORKSPACE_INSTRUCTIONS_SAFE_MAX_CHARS;
  const effectiveMaxChars = Math.min(requestedMaxChars, WORKSPACE_INSTRUCTIONS_SAFE_MAX_CHARS);
  let remaining = effectiveMaxChars;
  for (const source of sources.filter((source) => !isNativeInstructionSourceForAgent(source, options.agent))) {
    if (remaining <= 0) break;
    const candidatePath = path.resolve(workspacePath, source.path);
    if (!isPathWithin(workspacePath, candidatePath)) continue;
    const loaded = await readBoundedWorkspaceFile(candidatePath, realWorkspacePath, remaining);
    if (!loaded) continue;
    const { text, truncatedAtReadLimit } = loaded;
    const trimmed = text.trim();
    if (!trimmed) continue;
    const header = `--- ${source.label} ---\n`;
    const available = Math.max(0, remaining - header.length);
    const body = truncatedAtReadLimit || trimmed.length > available
      ? `${trimmed.slice(0, Math.max(0, available - 38)).trimEnd()}${TRUNCATION_NOTICE}`
      : trimmed;
    sections.push(`${header}${body}`);
    remaining -= header.length + body.length + 2;
  }
  return sections.join("\n\n");
}

async function readBoundedWorkspaceFile(
  candidatePath: string,
  realWorkspacePath: string,
  maxChars: number
): Promise<{ text: string; truncatedAtReadLimit: boolean } | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    // Do not follow a final-component symlink. Parent-directory links are
    // checked by the realpath containment test below.
    const entry = await fs.lstat(candidatePath);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) return undefined;

    const realCandidatePath = await fs.realpath(candidatePath);
    if (!isPathWithin(realWorkspacePath, realCandidatePath)) return undefined;

    const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await fs.open(realCandidatePath, openFlags);
    const openedEntry = await handle.stat();
    if (!openedEntry.isFile() || openedEntry.nlink !== 1 || !sameFileIdentity(entry, openedEntry)) return undefined;

    // Re-check the user-controlled path after opening. Together with the file
    // identity check (and O_NOFOLLOW where the platform provides it), this
    // closes the practical swap window between lstat/realpath and open.
    const currentRealCandidatePath = await fs.realpath(candidatePath);
    if (!isPathWithin(realWorkspacePath, currentRealCandidatePath)) return undefined;

    const maxBytes = Math.max(1, maxChars * UTF8_MAX_BYTES_PER_CHARACTER);
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncatedAtReadLimit = bytesRead > maxBytes;
    return {
      text: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8"),
      truncatedAtReadLimit,
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameFileIdentity(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isNativeInstructionSourceForAgent(source: WorkspaceInstructionSource, agent: AgentId | undefined): boolean {
  if (!agent) return false;
  const normalized = source.path.split(/[\\/]+/).join("/");
  if (agent === "claude") return normalized === "CLAUDE.md";
  return normalized === "AGENTS.md" || normalized === ".codex/instructions.md";
}

export interface WorkspaceInstructionsContextOptions {
  maxChars?: number;
}

export function workspaceInstructionsAsContext(
  // Why: callers keyed by the now-widened AgentId (e.g. panel.ts's
  // workspaceInstructionsByAgent[agent]) may type this as possibly-undefined;
  // treat a missing value the same as an empty instructions file.
  instructions: string | undefined,
  options: WorkspaceInstructionsContextOptions = {}
): string {
  const trimmed = truncateInstructionContext((instructions ?? "").trim(), options.maxChars);
  if (!trimmed) return "--- Workspace instructions ---\nNone found.";
  return [
    "--- Workspace instructions ---",
    "These repository instructions override generic assumptions about commands, setup, architecture, and workflow.",
    trimmed,
  ].join("\n");
}

function truncateInstructionContext(value: string, maxChars: number | undefined): string {
  if (maxChars === undefined || maxChars <= 0 || value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - TRUNCATION_NOTICE.length)).trimEnd()}${TRUNCATION_NOTICE}`;
}
