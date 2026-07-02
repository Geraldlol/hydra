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
  pricing?: ModelPrices;
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

export type AdapterOutputMode = "plain" | "codexJson" | "claudeStreamJson" | "geminiJson";

export interface AdapterRawOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  replyFileText?: string; // Codex --output-last-message capture
  outputMode: AdapterOutputMode;
}

export type AuthorityClass = AuthorityClassification;

export interface AgentAdapter {
  readonly kind: AgentKind;
  buildInvocation(def: AgentDefinition, ctx: InvocationContext): Invocation;
  parseReply(raw: AdapterRawOutput): string;
  parseUsage(raw: AdapterRawOutput): UsageTokens | undefined;
  pricing(def: AgentDefinition): ModelPrices;
  authority(def: AgentDefinition, ctx: InvocationContext): AuthorityClass;
}
