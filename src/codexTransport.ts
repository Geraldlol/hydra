import * as vscode from "vscode";
import type { AgentSpawn } from "./agents";
import { insertBeforeStdinDash } from "./agentArgs";

/**
 * Codex-specific flag-injection helpers. Each `should*` returns whether
 * the corresponding feature is enabled for this spawn; each `with*Args`
 * returns a new spawn with the appropriate flags inserted before the
 * trailing stdin dash.
 *
 * Callers must already know they're dealing with Codex — the previous
 * inline panel.ts copies took `agent: AgentId` and returned false for
 * non-codex, which pushed dispatch into the helpers themselves. After
 * the agent-transport extraction the agent check moves up to the caller
 * so each helper is mono-agent and clearer.
 */

export function shouldCaptureCodexLastMessage(spawn: AgentSpawn): boolean {
  if (spawn.args[0] !== "exec") return false;
  if (spawn.args.includes("--output-last-message")) return false;
  return vscode.workspace
    .getConfiguration("hydraRoom")
    .get<boolean>("codexCaptureLastMessage", true);
}

export function withCodexLastMessageArgs(spawn: AgentSpawn, replyPath: string): AgentSpawn {
  return {
    ...spawn,
    args: insertBeforeStdinDash(spawn.args, ["--output-last-message", replyPath]),
  };
}

export function shouldUseCodexJson(spawn: AgentSpawn): boolean {
  if (!isCodexExecArgs(spawn.args)) return false;
  // This also chooses the reply/usage parser. An explicit native JSON flag
  // requires parsing even when Hydra's automatic JSON setting is disabled.
  const { flags } = codexOutputOptions(spawn.args);
  if (flags.has("--json") || flags.has("--experimental-json")) return true;
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("codexJson", true);
}

export function withCodexJsonArgs(spawn: AgentSpawn): AgentSpawn {
  const { flags, terminatorIndex } = codexOutputOptions(spawn.args);
  if (flags.has("--json") || flags.has("--experimental-json")) return spawn;
  return { ...spawn, args: insertBeforeStdinDash(spawn.args, ["--json"], terminatorIndex) };
}

export function withCodexSkipGitRepoCheckArgs(spawn: AgentSpawn): AgentSpawn {
  if (!isCodexExecArgs(spawn.args)) return spawn;
  if (spawn.args.includes("--skip-git-repo-check")) return spawn;
  return { ...spawn, args: insertBeforeStdinDash(spawn.args, ["--skip-git-repo-check"]) };
}

export function isCodexExecArgs(args: string[]): boolean {
  return firstCodexPositional(args) === "exec" || firstCodexPositional(args) === "e";
}

const CODEX_VALUE_FLAGS = new Set([
  "--color", "--cd", "-C", "--config", "-c", "--profile", "-p",
  "--model", "-m", "--add-dir", "--image", "-i", "--local-provider",
  "--sandbox", "-s", "--output-schema", "-o", "--output-last-message",
  "--enable", "--disable", "--ask-for-approval", "-a",
]);

function codexOutputOptions(args: readonly string[]): { flags: Set<string>; terminatorIndex: number } {
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return { flags, terminatorIndex: index };
    if (!arg?.startsWith("-")) continue;
    flags.add(arg);
    if (CODEX_VALUE_FLAGS.has(arg)) index++;
  }
  return { flags, terminatorIndex: -1 };
}

function firstCodexPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--") return undefined;
    if (arg.startsWith("-")) {
      const eq = arg.indexOf("=");
      if (eq < 0 && CODEX_VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    return arg;
  }
  return undefined;
}
