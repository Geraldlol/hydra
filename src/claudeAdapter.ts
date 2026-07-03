import type { AgentAdapter, AgentDefinition, InvocationContext, Invocation, AdapterRawOutput } from "./agentAdapter";
import type { UsageTokens, ModelPrices } from "./usage";
import { buildAgentSpawn } from "./cli";
import { withModelArgs, withEffortArgs } from "./agentArgs";
import { classifyAgentAuthority } from "./authority";
import { usageFromClaudeSummary, resolveModelPrices } from "./usage";
import { parseClaudeEventStream, summarizeClaudeEvents } from "./claudeEvents";

export const claudeAdapter: AgentAdapter = {
  kind: "claude",
  buildInvocation(def: AgentDefinition, ctx: InvocationContext): Invocation {
    // Why: no withCodexSkipGitRepoCheckArgs step here -- that guard is
    // codex-only (it lives in codexAdapter.buildInvocation).
    let spawn = buildAgentSpawn(def.id, ctx.phase, ctx.command, ctx.rawArgs, ctx.workspaceRoot);
    spawn = withModelArgs(spawn, def.id, ctx.phase);
    spawn = withEffortArgs(spawn, def.id, ctx.phase);
    return { transport: "spawn", command: spawn.command, args: spawn.args, stdin: ctx.prompt };
  },
  parseReply(raw: AdapterRawOutput): string {
    return raw.stdout;
  },
  parseUsage(raw: AdapterRawOutput): UsageTokens | undefined {
    const summary = summarizeClaudeEvents(parseClaudeEventStream(raw.stdout));
    return usageFromClaudeSummary(summary.usage);
  },
  pricing(def: AgentDefinition): ModelPrices {
    return def.pricing ?? resolveModelPrices(def.id, def.model, {});
  },
  authority(def: AgentDefinition, ctx: InvocationContext) {
    return classifyAgentAuthority(def.id, ctx.phase, ctx.rawArgs);
  },
};
