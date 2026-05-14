import * as fs from "node:fs/promises";
import * as path from "node:path";

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

export async function readWorkspaceInstructions(
  workspaceRoot: string,
  maxChars = 12000,
  sources = DEFAULT_WORKSPACE_INSTRUCTION_SOURCES
): Promise<string> {
  const sections: string[] = [];
  let remaining = Math.max(0, maxChars);
  for (const source of sources) {
    if (remaining <= 0) break;
    let text: string;
    try {
      text = await fs.readFile(path.join(workspaceRoot, source.path), "utf8");
    } catch {
      continue;
    }
    const trimmed = text.trim();
    if (!trimmed) continue;
    const header = `--- ${source.label} ---\n`;
    const available = Math.max(0, remaining - header.length);
    const body = trimmed.length > available
      ? `${trimmed.slice(0, Math.max(0, available - 38)).trimEnd()}\n[... truncated by Hydra ...]`
      : trimmed;
    sections.push(`${header}${body}`);
    remaining -= header.length + body.length + 2;
  }
  return sections.join("\n\n");
}

export function workspaceInstructionsAsContext(instructions: string): string {
  const trimmed = instructions.trim();
  if (!trimmed) return "--- Workspace instructions ---\nNone found.";
  return [
    "--- Workspace instructions ---",
    "These repository instructions override generic assumptions about commands, setup, architecture, and workflow.",
    trimmed,
  ].join("\n");
}
