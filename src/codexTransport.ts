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
  return vscode.workspace.getConfiguration("hydraRoom").get<boolean>("codexJson", false);
}

export function withCodexJsonArgs(spawn: AgentSpawn): AgentSpawn {
  return { ...spawn, args: insertBeforeStdinDash(spawn.args, ["--json"]) };
}
