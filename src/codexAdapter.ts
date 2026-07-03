import type { AgentAdapter, AgentDefinition, InvocationContext, Invocation, AdapterRawOutput } from "./agentAdapter";
import type { UsageTokens, ModelPrices } from "./usage";
import { buildAgentSpawn } from "./cli";
import { withModelArgs, withEffortArgs } from "./agentArgs";
import { withCodexSkipGitRepoCheckArgs } from "./codexTransport";
import { classifyAgentAuthority } from "./authority";
import { usageFromCodexSummary, resolveModelPrices, parseCodexTextTokens } from "./usage";

export const codexAdapter: AgentAdapter = {
  kind: "codex",
  buildInvocation(def: AgentDefinition, ctx: InvocationContext): Invocation {
    let spawn = buildAgentSpawn(def.id, ctx.phase, ctx.command, ctx.rawArgs, ctx.workspaceRoot);
    spawn = withCodexSkipGitRepoCheckArgs(spawn);
    spawn = withModelArgs(spawn, def.id, ctx.phase);
    spawn = withEffortArgs(spawn, def.id, ctx.phase);
    return { transport: "spawn", command: spawn.command, args: spawn.args, stdin: ctx.prompt };
  },
  parseReply(raw: AdapterRawOutput): string {
    return raw.replyFileText ?? raw.stdout;
  },
  parseUsage(raw: AdapterRawOutput): UsageTokens | undefined {
    const total = parseCodexTextTokens(`${raw.stdout}\n${raw.stderr}`);
    if (total === undefined) return undefined;
    return { inputTokens: total, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 };
  },
  pricing(def: AgentDefinition): ModelPrices {
    return def.pricing ?? resolveModelPrices(def.id, def.model, {});
  },
  authority(def: AgentDefinition, ctx: InvocationContext) {
    return classifyAgentAuthority(def.id, ctx.phase, ctx.rawArgs);
  },
};

void usageFromCodexSummary; // structured-JSON usage stays wired via panel outputMode in SP1
