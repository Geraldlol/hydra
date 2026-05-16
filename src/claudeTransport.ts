import * as vscode from "vscode";
import type { AgentSpawn } from "./agents";
import { claudeInvocationMode } from "./claudeCli";

/**
 * Claude-specific flag-injection helpers. Like codexTransport, each helper
 * assumes the caller has already confirmed the spawn is for Claude (the
 * agent check moves to the call site after extraction from panel.ts).
 */

export function shouldUseClaudeStreamJson(spawn: AgentSpawn): boolean {
  // stream-json output is only meaningful in print mode (`-p` / `--print`)
  // and only when the user hasn't explicitly picked a different
  // --output-format value.
  if (claudeInvocationMode(spawn) !== "print") return false;
  if (spawn.args.includes("--output-format")) return false;
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("claudeStreamJson", true);
}

export function shouldCreateClaudeRequestFiles(spawn: AgentSpawn): boolean {
  if (!shouldUseClaudeStreamJson(spawn)) return false;
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("claudeDebugFile", true);
}

/**
 * Add Claude's stream-json output flags to an existing spawn. Always appends
 * `--output-format stream-json --verbose` (verbose is required by the CLI
 * when output-format is stream-json). Optionally appends
 * `--include-partial-messages` (per hydraRoom.claudeStreamJsonIncludePartialMessages)
 * and `--debug-file <logPath>` (per hydraRoom.claudeDebugFile) so Hydra can
 * capture raw native debug output.
 */
export function withClaudeStreamJsonArgs(spawn: AgentSpawn, logPath?: string): AgentSpawn {
  const args = [...spawn.args, "--output-format", "stream-json"];
  if (!args.includes("--verbose")) args.push("--verbose");
  const cfg = vscode.workspace.getConfiguration("hydraRoom");
  if (
    cfg.get<boolean>("claudeStreamJsonIncludePartialMessages", true) &&
    !args.includes("--include-partial-messages")
  ) {
    args.push("--include-partial-messages");
  }
  if (logPath && cfg.get<boolean>("claudeDebugFile", true) && !args.includes("--debug-file")) {
    args.push("--debug-file", logPath);
  }
  return { ...spawn, args };
}
