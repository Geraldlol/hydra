import type { AgentAdapter, AgentDefinition, InvocationContext, Invocation, AdapterRawOutput } from "./agentAdapter";
import type { UsageTokens, ModelPrices } from "./usage";
import { DEFAULT_PRICES_BY_KIND } from "./usage";
import type { AuthorityLevel } from "./authority";
import { expandWorkspaceArgs, expandRequestFileArgs, type RequestFilePlaceholders } from "./cli";

export const AUTHORITY_LEVEL_BY_DEFAULT: Record<NonNullable<AgentDefinition["defaultAuthority"]>, AuthorityLevel> = {
  "read-only": "readOnly",
  "workspace-write": "workspaceWrite",
  "full-native": "fullNative",
};

export function expandCliTemplateArgs(
  argsTemplate: string[],
  vars: { prompt: string; model: string; workspaceRoot: string; files?: RequestFilePlaceholders },
): string[] {
  let args = argsTemplate.map((a) => a.replace(/\$\{model\}/g, vars.model).replace(/\$\{prompt\}/g, vars.prompt));
  args = expandWorkspaceArgs(args, vars.workspaceRoot);
  if (vars.files) args = expandRequestFileArgs(args, vars.files);
  return args;
}

export const cliTemplateAdapter: AgentAdapter = {
  kind: "cli-template",
  buildInvocation(def: AgentDefinition, ctx: InvocationContext): Invocation {
    const template = def.argsTemplate ?? [];
    const usesPromptPlaceholder = template.some((a) => a.includes("${prompt}"));
    const args = expandCliTemplateArgs(template, {
      prompt: ctx.prompt,
      model: def.model ?? "",
      workspaceRoot: ctx.workspaceRoot,
      files: ctx.requestFiles,
    });
    return {
      transport: "spawn",
      command: def.command ?? ctx.command,
      args,
      // Why: when ${prompt} is baked into argv, don't also pipe it to stdin.
      stdin: usesPromptPlaceholder ? undefined : ctx.prompt,
    };
  },
  parseReply(raw: AdapterRawOutput): string {
    return raw.replyFileText ?? raw.stdout;
  },
  parseUsage(_raw: AdapterRawOutput): UsageTokens | undefined {
    return undefined; // custom CLIs expose no standard usage; cost uses per-kind default @ 0 tokens
  },
  pricing(def: AgentDefinition): ModelPrices {
    return def.pricing ?? DEFAULT_PRICES_BY_KIND["cli-template"];
  },
  authority(def: AgentDefinition, _ctx: InvocationContext) {
    const level = AUTHORITY_LEVEL_BY_DEFAULT[def.defaultAuthority ?? "full-native"];
    return {
      level,
      label: level === "fullNative" ? "Full native" : level === "workspaceWrite" ? "Workspace-write" : "Read-only",
      detail: `cli-template head "${def.id}" runs ${def.command} with Hydra passing raw templated args through.`,
      warnings: level === "fullNative" ? ["Custom CLI head runs with full native authority; Hydra will confirm before each new workspace."] : [],
    };
  },
};
