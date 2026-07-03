import type { AgentDefinition, AgentAdapter, AgentKind } from "./agentAdapter";
import { codexAdapter } from "./codexAdapter";
import { claudeAdapter } from "./claudeAdapter";
import { geminiAdapter } from "./geminiAdapter";

export const BUILTIN_AGENT_DEFINITIONS: AgentDefinition[] = [
  { id: "codex", displayName: "Codex", kind: "codex" },
  { id: "claude", displayName: "Claude", kind: "claude" },
  { id: "gemini", displayName: "Gemini", kind: "gemini" },
];

/** Assign a 1-based head-ramp slot to any definition missing an explicit one. */
export function assignColorIndexes(defs: AgentDefinition[]): AgentDefinition[] {
  return defs.map((def, i) => ({ ...def, colorIndex: def.colorIndex ?? i + 1 }));
}

// SP1: built-ins only. SP2 merges validated hydraRoom.agents entries here.
function loadDefinitions(): AgentDefinition[] {
  return assignColorIndexes(BUILTIN_AGENT_DEFINITIONS.map((d) => ({ ...d })));
}

let cached: AgentDefinition[] | undefined;
function definitions(): AgentDefinition[] {
  if (!cached) cached = loadDefinitions();
  return cached;
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
