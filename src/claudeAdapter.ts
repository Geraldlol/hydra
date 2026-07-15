import type { AgentAdapter, AgentDefinition, InvocationContext, Invocation, AdapterRawOutput } from "./agentAdapter";
import type { UsageTokens, ModelPrices } from "./usage";
import { buildAgentSpawn } from "./cli";
import { insertBeforeStdinDash, withModelArgs, withEffortArgs, isBuiltinAgentId } from "./agentArgs";
import { classifyAgentAuthority } from "./authority";
import { usageFromClaudeSummary, resolveModelPrices, coerceModelPrices } from "./usage";
import { parseClaudeEventStream, summarizeClaudeEvents } from "./claudeEvents";

export const claudeAdapter: AgentAdapter = {
  kind: "claude",
  buildInvocation(def: AgentDefinition, ctx: InvocationContext): Invocation {
    // Why: no withCodexSkipGitRepoCheckArgs step here -- that guard is
    // codex-only (it lives in codexAdapter.buildInvocation).
    let spawn = buildAgentSpawn(def.id, ctx.phase, ctx.command, ctx.rawArgs, ctx.workspaceRoot);
    spawn = withModelArgs(spawn, def.id, ctx.phase);
    // Why: withModelArgs refuses to read the undeclared hydraRoom.${id}Model
    // setting for a non-builtin id (agentArgs.ts) -- that key would otherwise
    // be settable from an untrusted workspace's settings.json. A custom
    // claude-kind head's model must come from its trust-scoped
    // hydraRoom.agents def.model instead. Builtin "claude" is unaffected: it
    // still resolves its model purely via hydraRoom.claudeModel, exactly as
    // before.
    if (!isBuiltinAgentId(def.id) && def.model && !spawn.args.includes("--model") && !spawn.args.includes("-m")) {
      spawn = { ...spawn, args: insertBeforeStdinDash(spawn.args, ["--model", def.model]) };
    }
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
    const base = resolveModelPrices(def.id, def.model, {});
    return coerceModelPrices(def.pricing, base);
  },
  authority(def: AgentDefinition, ctx: InvocationContext) {
    return classifyAgentAuthority(def.id, ctx.phase, ctx.rawArgs);
  },
};
