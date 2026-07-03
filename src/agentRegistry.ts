import type { AgentDefinition, AgentAdapter, AgentKind } from "./agentAdapter";
import { codexAdapter } from "./codexAdapter";
import { claudeAdapter } from "./claudeAdapter";
import { geminiAdapter } from "./geminiAdapter";
import { openaiCompatibleAdapter } from "./openaiCompatibleAdapter";
import { mergeAgentDefinitions } from "./agentValidation";

export const BUILTIN_AGENT_DEFINITIONS: AgentDefinition[] = [
  { id: "codex", displayName: "Codex", kind: "codex" },
  { id: "claude", displayName: "Claude", kind: "claude" },
  { id: "gemini", displayName: "Gemini", kind: "gemini" },
];

/** Assign a 1-based head-ramp slot to any definition missing an explicit one. */
export function assignColorIndexes(defs: AgentDefinition[]): AgentDefinition[] {
  return defs.map((def, i) => ({ ...def, colorIndex: def.colorIndex ?? i + 1 }));
}

function readUserAgents(): unknown {
  try {
    // Lazy require: registry is imported by pure unit tests that have no
    // vscode config; fall back to no user agents there.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require("vscode") as typeof import("vscode");
    return vscode.workspace.getConfiguration("hydraRoom").get<unknown>("agents", []);
  } catch {
    return [];
  }
}

let cached: AgentDefinition[] | undefined;
let cachedWarnings: string[] = [];

function loadDefinitions(): AgentDefinition[] {
  const merged = mergeAgentDefinitions(BUILTIN_AGENT_DEFINITIONS.map((d) => ({ ...d })), readUserAgents());
  cachedWarnings = merged.warnings;
  return merged.defs;
}

function definitions(): AgentDefinition[] {
  if (!cached) cached = loadDefinitions();
  return cached;
}

/** Drop the memoized roster so a settings change re-merges hydraRoom.agents. */
export function reloadAgentDefinitions(): void {
  cached = undefined;
  cachedWarnings = [];
}

/** Validation warnings from the last load (invalid user defs that were dropped). */
export function agentDefinitionWarnings(): string[] {
  definitions(); // ensure a load has happened
  return [...cachedWarnings];
}

export function listAgentDefinitions(): AgentDefinition[] {
  return definitions();
}

export function getAgentDefinition(id: string): AgentDefinition | undefined {
  return definitions().find((d) => d.id === id);
}

export function displayNameFor(id: string): string {
  return getAgentDefinition(id)?.displayName ?? id;
}

const adapters = new Map<AgentKind, AgentAdapter>();

export function registerAdapter(adapter: AgentAdapter): void {
  adapters.set(adapter.kind, adapter);
}

// Why: run after `adapters` is initialized above -- calling registerAdapter
// any earlier in module-evaluation order would hit the `const adapters` TDZ.
registerAdapter(codexAdapter);
registerAdapter(claudeAdapter);
registerAdapter(geminiAdapter);
registerAdapter(openaiCompatibleAdapter);

export function adapterForKind(kind: AgentKind): AgentAdapter {
  const adapter = adapters.get(kind);
  if (!adapter) throw new Error(`No adapter registered for agent kind "${kind}"`);
  return adapter;
}

export const agentRegistry = {
  get: getAgentDefinition,
  list: listAgentDefinitions,
  adapterFor: (def: AgentDefinition): AgentAdapter => adapterForKind(def.kind),
};
