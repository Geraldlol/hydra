import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentId } from "./phases";

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
  const sections: string[] = [];
  const capped = maxChars > 0;
  let remaining = capped ? Math.floor(maxChars) : Number.POSITIVE_INFINITY;
  for (const source of sources.filter((source) => !isNativeInstructionSourceForAgent(source, options.agent))) {
    if (capped && remaining <= 0) break;
    let text: string;
    try {
      text = await fs.readFile(path.join(workspaceRoot, source.path), "utf8");
    } catch {
      continue;
    }
    const trimmed = text.trim();
    if (!trimmed) continue;
    const header = `--- ${source.label} ---\n`;
    const available = capped ? Math.max(0, remaining - header.length) : trimmed.length;
    const body = capped && trimmed.length > available
      ? `${trimmed.slice(0, Math.max(0, available - 38)).trimEnd()}\n[... truncated by Hydra ...]`
      : trimmed;
    sections.push(`${header}${body}`);
    remaining -= header.length + body.length + 2;
  }
  return sections.join("\n\n");
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
  const suffix = "\n[... truncated by Hydra ...]";
  return `${value.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`;
}
