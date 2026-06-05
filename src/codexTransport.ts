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
  if (spawn.args[0] !== "exec") return false;
  if (spawn.args.includes("--json") || spawn.args.includes("--experimental-json")) return false;
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("codexJson", true);
}

export function withCodexJsonArgs(spawn: AgentSpawn): AgentSpawn {
  return { ...spawn, args: insertBeforeStdinDash(spawn.args, ["--json"]) };
}

export function withCodexSkipGitRepoCheckArgs(spawn: AgentSpawn): AgentSpawn {
  if (!isCodexExecArgs(spawn.args)) return spawn;
  if (spawn.args.includes("--skip-git-repo-check")) return spawn;
  return { ...spawn, args: insertBeforeStdinDash(spawn.args, ["--skip-git-repo-check"]) };
}

function isCodexExecArgs(args: string[]): boolean {
  return firstCodexPositional(args) === "exec" || firstCodexPositional(args) === "e";
}

function firstCodexPositional(args: string[]): string | undefined {
  const valueFlags = new Set([
    "--color", "--cd", "-C", "--config", "-c", "--profile", "-p",
    "--model", "-m", "--add-dir", "--image", "-i", "--local-provider",
    "--sandbox", "-s", "--output-schema", "-o", "--output-last-message",
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("-")) {
      const eq = arg.indexOf("=");
      if (eq < 0 && valueFlags.has(arg)) i++;
      continue;
    }
    return arg;
  }
  return undefined;
}
