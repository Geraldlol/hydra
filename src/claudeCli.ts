import type { AgentSpawn } from "./agents";

export const CLAUDE_PRINT_FLAGS = ["-p", "--print"] as const;

export type ClaudeInvocationMode = "print" | "interactive";

export function claudePrintArgs(): string[] {
  return [CLAUDE_PRINT_FLAGS[0]];
}

export function claudeUsesPrintModeArgs(args: readonly string[]): boolean {
  return CLAUDE_PRINT_FLAGS.some((flag) => args.includes(flag));
}

export function claudeInvocationMode(spawn: AgentSpawn): ClaudeInvocationMode {
  return claudeUsesPrintModeArgs(spawn.args) ? "print" : "interactive";
}

export function claudeReadsHydraPromptFromStdin(args: readonly string[]): boolean {
  // Hydra's one-shot Claude transport currently feeds the room prompt to
  // print mode over stdin. Keep this behind one helper so a future non-print
  // request path can replace the assumption in one place.
  return claudeUsesPrintModeArgs(args);
}
