import * as vscode from "vscode";
import type { AgentSpawn } from "./agents";
import { insertBeforeStdinDash } from "./agentArgs";

/**
 * Claude-specific flag-injection helpers. Like codexTransport, each helper
 * assumes the caller has already confirmed the spawn is for Claude (the
 * agent check moves to the call site after extraction from panel.ts).
 */

export function shouldUseClaudeStreamJson(spawn: AgentSpawn): boolean {
  // Explicit native formats select the parser independently of Hydra's
  // automatic streaming setting. Other formats must remain untouched.
  const { options } = claudeOutputOptions(spawn.args);
  if (!options.has("-p") && !options.has("--print")) return false;
  const format = options.get("--output-format");
  if (format !== undefined) return format === "stream-json";
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("claudeStreamJson", true);
}

export function shouldCreateClaudeRequestFiles(spawn: AgentSpawn): boolean {
  if (!shouldUseClaudeStreamJson(spawn)) return false;
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("claudeDebugFile", true);
}

/**
 * Ensure Claude's stream-json output flags without replacing an explicit
 * output format. Adds `--verbose`, required by the CLI for stream-json.
 * Optionally appends
 * `--include-partial-messages` (per hydraRoom.claudeStreamJsonIncludePartialMessages)
 * and `--debug-file <logPath>` (per hydraRoom.claudeDebugFile) so Hydra can
 * capture raw native debug output.
 */
export function withClaudeStreamJsonArgs(spawn: AgentSpawn, logPath?: string): AgentSpawn {
  const { options, terminatorIndex } = claudeOutputOptions(spawn.args);
  const format = options.get("--output-format");
  if (format !== undefined && format !== "stream-json") return spawn;
  const insertion = format === undefined ? ["--output-format", "stream-json"] : [];
  if (!options.has("--verbose")) insertion.push("--verbose");
  const cfg = vscode.workspace.getConfiguration("hydraRoom");
  if (
    cfg.get<boolean>("claudeStreamJsonIncludePartialMessages", true) &&
    !options.has("--include-partial-messages")
  ) {
    insertion.push("--include-partial-messages");
  }
  if (logPath && cfg.get<boolean>("claudeDebugFile", true) && !options.has("--debug-file")) {
    insertion.push("--debug-file", logPath);
  }
  // Claude has no Codex-style stdin dash sentinel; a literal "-" can be an
  // option value. Append when there is no parsed option terminator.
  const insertionIndex = terminatorIndex >= 0 ? terminatorIndex : spawn.args.length;
  return { ...spawn, args: insertBeforeStdinDash(spawn.args, insertion, insertionIndex) };
}

// Known value-taking options must consume their argument before looking for
// output flags. A system prompt or file path can itself look like a flag.
const CLAUDE_VALUE_FLAGS = new Set([
  "--agent", "--agents", "--append-system-prompt", "--append-system-prompt-file",
  "--autocompact", "--debug-file", "--effort", "--environment", "--fallback-model",
  "--input-format", "--json-schema", "--max-budget-usd", "--max-turns", "--model", "-m",
  "--name", "-n", "--output-format", "--permission-mode", "--permission-prompts",
  "--plugin-dir", "--plugin-url", "--remote-control-session-name-prefix", "--session-id",
  "--setting-sources", "--settings", "--system-prompt", "--system-prompt-file", "--system-prompt-snapshot",
  "--add-dir", "--allowedTools", "--allowed-tools", "--betas", "--disallowedTools", "--disallowed-tools",
  "--file", "--mcp-config", "--tools",
]);

function claudeOutputOptions(args: readonly string[]): { options: Map<string, string>; terminatorIndex: number } {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return { options, terminatorIndex: index };
    if (!arg?.startsWith("-")) continue;
    const equalsAt = arg.indexOf("=");
    const flag = equalsAt < 0 ? arg : arg.slice(0, equalsAt);
    const value = equalsAt >= 0 ? arg.slice(equalsAt + 1)
      : CLAUDE_VALUE_FLAGS.has(flag) ? args[++index] ?? "" : "";
    options.set(flag, value);
  }
  return { options, terminatorIndex: -1 };
}
