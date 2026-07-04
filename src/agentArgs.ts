import * as vscode from "vscode";
import type { AgentSpawn } from "./agents";
import { profileForPhase } from "./cli";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";
import { effectivePhasedSetting } from "./phasedSetting";

/**
 * Proxy for agentRegistry's `isBuiltinAgentId`, via a lazy `require` rather
 * than a top-level import.
 *
 * Why: agentRegistry.ts imports every vendor adapter (which import this
 * module) and calls `registerAdapter()` for each, synchronously, at its own
 * module top level -- before it finishes defining `isBuiltinAgentId`. A
 * top-level `import { isBuiltinAgentId } from "./agentRegistry"` here would
 * complete that cycle mid-load: agentRegistry.ts would get back its own
 * still-loading (adapter-less) exports and crash on
 * `registerAdapter(undefined)`. Deferring the require to call time -- well
 * after every module has finished loading -- sidesteps that. Exported so the
 * vendor adapters (codexAdapter.ts, claudeAdapter.ts) share this one
 * workaround instead of each re-deriving it.
 */
export function isBuiltinAgentId(id: AgentId): boolean {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (require("./agentRegistry") as typeof import("./agentRegistry")).isBuiltinAgentId(id);
}

/**
 * Splice extra args in just before the trailing "-" stdin sentinel.
 *
 * Codex's `codex exec` reads the prompt from stdin when its final
 * positional argument is "-". Anything we add must land *before* that
 * dash or the CLI will treat our extra args as positionals to the read,
 * not flags on exec. Used by every with*Args helper that injects a flag
 * into an already-formed argv.
 *
 * If there's no trailing dash (Claude or non-`exec` Codex subcommands),
 * fall back to appending. Both behaviors match the previous inline copy
 * that lived in panel.ts.
 */
export function insertBeforeStdinDash(args: string[], insertion: string[]): string[] {
  const next = [...args];
  const dashIndex = next.lastIndexOf("-");
  if (dashIndex >= 0) {
    next.splice(dashIndex, 0, ...insertion);
    return next;
  }
  return [...next, ...insertion];
}

/**
 * Resolve the model string the user has configured for this agent + phase.
 * `hydraRoom.claudeModel` and `hydraRoom.codexModel` accept either a single
 * string (applies to every phase) or an object keyed by profile (discussion
 * / build / review). Empty string means "let the CLI pick its default."
 *
 * Why: `hydraRoom.${agent}Model` is a declared, trust-scoped setting only for
 * built-in head ids (codex/claude/gemini). For a custom head id that key is
 * UNDECLARED -- settable from an untrusted workspace's settings.json -- so a
 * non-builtin id must never read it (mirrors the ${id}NativeEnv/${id}Command
 * fence in agentRegistry.ts/panel.ts). Callers fall back to the trust-scoped
 * `def.model` for a non-builtin id instead (see codexAdapter/claudeAdapter).
 */
export function modelForPhase(agent: AgentId, phase: Phase): string {
  if (!isBuiltinAgentId(agent)) return "";
  return effectivePhasedSetting(
    vscode.workspace.getConfiguration("hydraRoom").get<unknown>(`${agent}Model`),
    profileForPhase(phase),
  );
}

/**
 * Inject the configured model flag for the current agent + phase. Respects
 * any explicit --model / -m the user already put in their *ExecArgs* setting
 * (chooser is a convenience layer; raw args win so power users can lock a
 * specific model per phase). For Codex, --model is only valid on `exec`; we
 * leave non-exec subcommands alone rather than risk a bad arg.
 */
export function withModelArgs(spawn: AgentSpawn, agent: AgentId, phase: Phase): AgentSpawn {
  const model = modelForPhase(agent, phase);
  if (!model) return spawn;
  if (spawn.args.includes("--model") || spawn.args.includes("-m")) return spawn;
  if (agent === "codex" && spawn.args[0] !== "exec") return spawn;
  return { ...spawn, args: insertBeforeStdinDash(spawn.args, ["--model", model]) };
}

/**
 * Resolve the reasoning/effort level configured for this agent + phase.
 * `claudeEffort` and `codexReasoning` share the same string-or-object shape.
 */
export function effortForPhase(agent: AgentId, phase: Phase): string {
  const key = agent === "claude" ? "claudeEffort" : agent === "codex" ? "codexReasoning" : undefined;
  if (!key) return ""; // heads without an effort/reasoning knob (e.g. gemini) inject no flag
  return effectivePhasedSetting(
    vscode.workspace.getConfiguration("hydraRoom").get<unknown>(key),
    profileForPhase(phase),
  );
}

/**
 * Inject the configured effort/reasoning flag for the current agent + phase.
 *   - Claude exposes `--effort <level>`.
 *   - Codex uses `-c model_reasoning_effort=<level>` (config override)
 *     because exec has no direct --reasoning-effort flag, and only on the
 *     `exec` subcommand. The value is a bare TOML identifier (low/medium/
 *     high/xhigh) — Codex's `-c key=value` parser treats an unquoted token
 *     as a string, so quotes are unnecessary and would otherwise be passed
 *     through literally as part of the value.
 * Respects an explicit override already present in *ExecArgs*.
 */
export function withEffortArgs(spawn: AgentSpawn, agent: AgentId, phase: Phase): AgentSpawn {
  const level = effortForPhase(agent, phase);
  if (!level) return spawn;
  if (agent === "claude") {
    if (spawn.args.includes("--effort")) return spawn;
    return { ...spawn, args: insertBeforeStdinDash(spawn.args, ["--effort", level]) };
  }
  if (spawn.args[0] !== "exec") return spawn;
  if (spawn.args.some((a) => a.startsWith("model_reasoning_effort="))) return spawn;
  return {
    ...spawn,
    args: insertBeforeStdinDash(spawn.args, ["-c", `model_reasoning_effort=${level}`]),
  };
}
