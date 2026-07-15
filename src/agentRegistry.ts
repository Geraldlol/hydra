import type { AgentDefinition, AgentAdapter, AgentKind } from "./agentAdapter";
import { codexAdapter } from "./codexAdapter";
import { claudeAdapter } from "./claudeAdapter";
import { geminiAdapter } from "./geminiAdapter";
import { openaiCompatibleAdapter } from "./openaiCompatibleAdapter";
import { cliTemplateAdapter } from "./cliTemplateAdapter";
import { mergeAgentDefinitions } from "./agentValidation";
export { assignColorIndexes } from "./agentColors";

export const BUILTIN_AGENT_DEFINITIONS: AgentDefinition[] = [
  { id: "codex", displayName: "Codex", kind: "codex" },
  { id: "claude", displayName: "Claude", kind: "claude" },
  { id: "gemini", displayName: "Gemini", kind: "gemini" },
];

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
let cachedConfigFingerprint: string | undefined;

function userAgentFingerprint(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "unserializable";
  }
}

function loadDefinitions(userAgents: unknown): AgentDefinition[] {
  const merged = mergeAgentDefinitions(BUILTIN_AGENT_DEFINITIONS.map((d) => ({ ...d })), userAgents);
  cachedWarnings = merged.warnings;
  return merged.defs;
}

function definitions(): AgentDefinition[] {
  const userAgents = readUserAgents();
  const fingerprint = userAgentFingerprint(userAgents);
  if (!cached || fingerprint !== cachedConfigFingerprint) {
    cached = loadDefinitions(userAgents);
    cachedConfigFingerprint = fingerprint;
  }
  return cached;
}

/** Drop the memoized roster so a settings change re-merges hydraRoom.agents. */
export function reloadAgentDefinitions(): void {
  cached = undefined;
  cachedWarnings = [];
  cachedConfigFingerprint = undefined;
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

// Why: `${id}Command`/`${id}ExecArgs`/`${id}NativeEnv`/`${id}NativePathPrepend`
// are declared, trust-scoped settings only for these built-in ids. For any
// other id those keys would be UNDECLARED — settable from an untrusted
// workspace's settings.json — so callers must not read interpolated per-agent
// keys unless this returns true (SP1 final-review carry-in constraint).
export function isBuiltinAgentId(id: string): boolean {
  return BUILTIN_AGENT_DEFINITIONS.some((d) => d.id === id);
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
registerAdapter(cliTemplateAdapter);

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
