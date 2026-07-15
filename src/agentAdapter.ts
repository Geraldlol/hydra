import type { ModelPrices, UsageTokens } from "./usage";
import type { AuthorityClassification } from "./authority";
import type { Phase } from "./prompts";
import type { RequestFilePlaceholders } from "./cli";

export const KNOWN_AGENT_KINDS = [
  "codex",
  "claude",
  "gemini",
  "openai-compatible",
  "cli-template",
] as const;
export type AgentKind = (typeof KNOWN_AGENT_KINDS)[number];

export function isAgentKind(value: string): value is AgentKind {
  return (KNOWN_AGENT_KINDS as readonly string[]).includes(value);
}

export interface AgentDefinition {
  id: string;
  displayName: string;
  kind: AgentKind;
  colorIndex?: number;
  model?: string;
  pricing?: Partial<ModelPrices>;
  defaultAuthority?: "read-only" | "workspace-write" | "full-native";
  // openai-compatible (SP2):
  baseUrl?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  // cli-template + vendor command override:
  command?: string;
  argsTemplate?: string[];
}

export type Invocation =
  | { transport: "spawn"; command: string; args: string[]; stdin?: string }
  | { transport: "http"; url: string; method: "POST"; headers: Record<string, string>; body: unknown };

export interface InvocationContext {
  phase: Phase;
  workspaceRoot: string;
  prompt: string;
  command: string; // resolved executable (from `${id}Command` / def.command)
  rawArgs: string[]; // configured exec args for this phase
  requestFiles?: RequestFilePlaceholders;
}

export type AdapterOutputMode = "plain" | "codexJson" | "claudeStreamJson" | "geminiJson" | "openaiJson";

export interface AdapterRawOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  replyFileText?: string; // Codex --output-last-message capture
  outputMode: AdapterOutputMode;
}

export type AuthorityClass = AuthorityClassification;

/**
 * Why: in SP1, `parseReply`/`parseUsage` are NOT yet wired into panel's
 * dispatch — panel.ts calls only `buildInvocation` (and `pricing`/`authority`
 * separately); the reply/usage normalization panel actually uses still lives
 * in panel.ts's own code paths (e.g. `roomTextFromClaudeStreamJson`), not
 * here. Concretely, `claudeAdapter.parseReply` returns raw stdout while
 * `claudeAdapter.parseUsage` parses the stream-json event stream — two
 * different shapes for the same call, which is only harmless because nothing
 * reads them yet. SP2 must wire `parseReply`/`parseUsage` into panel's actual
 * dispatch path and reconcile them with panel's real normalization before
 * relying on either method's output.
 */
export interface AgentAdapter {
  readonly kind: AgentKind;
  buildInvocation(def: AgentDefinition, ctx: InvocationContext): Invocation;
  parseReply(raw: AdapterRawOutput): string;
  parseUsage(raw: AdapterRawOutput): UsageTokens | undefined;
  pricing(def: AgentDefinition): ModelPrices;
  authority(def: AgentDefinition, ctx: InvocationContext): AuthorityClass;
}
