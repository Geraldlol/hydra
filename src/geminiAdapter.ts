import type { AgentAdapter, AgentDefinition, InvocationContext, Invocation, AdapterRawOutput } from "./agentAdapter";
import type { UsageTokens, ModelPrices } from "./usage";
import { buildAgentSpawn } from "./cli";
import { insertBeforeStdinDash } from "./agentArgs";
import { classifyAgentAuthority } from "./authority";
import { resolveModelPrices } from "./usage";

export const geminiAdapter: AgentAdapter = {
  kind: "gemini",
  buildInvocation(def: AgentDefinition, ctx: InvocationContext): Invocation {
    const spawn = buildAgentSpawn(def.id, ctx.phase, ctx.command, ctx.rawArgs, ctx.workspaceRoot);
    let args = spawn.args;
    // Why: unlike codex/claude (whose per-phase model comes from the existing
    // `hydraRoom.{codex,claude}Model` settings via withModelArgs), there is no
    // `hydraRoom.geminiModel` setting yet (that lands in a later task), so the model
    // is read straight off the AgentDefinition instead. Respects an explicit
    // --model/-m the caller already put in rawArgs.
    if (def.model && !args.includes("--model") && !args.includes("-m")) {
      args = insertBeforeStdinDash(args, ["--model", def.model]);
    }
    return { transport: "spawn", command: spawn.command, args, stdin: ctx.prompt };
  },
  parseReply(raw: AdapterRawOutput): string {
    // Why: Gemini's non-interactive JSON output (flag name, top-level shape) is
    // UNVERIFIED -- no `gemini` CLI is installed in this environment to run
    // `gemini -p ... --output-format json` and confirm it. Parsing a guessed shape
    // risks silently corrupting replies, so this stays a plain-stdout passthrough
    // until a real install lets us capture and test the actual output.
    return raw.stdout;
  },
  parseUsage(raw: AdapterRawOutput): UsageTokens | undefined {
    // Why: Gemini's usage/token-count fields (candidates include
    // `usageMetadata.promptTokenCount`/`candidatesTokenCount`, or a plain-text
    // footer) are UNVERIFIED for the same reason as parseReply above. Returning
    // undefined here means cost accounting falls back to the per-kind default
    // pricing in `pricing` below, rather than a parser built from guessed field
    // names. Do not implement this from memory -- confirm against a real install.
    void raw;
    return undefined;
  },
  pricing(def: AgentDefinition): ModelPrices {
    return def.pricing ?? resolveModelPrices(def.id, def.model, {});
  },
  authority(def: AgentDefinition, ctx: InvocationContext) {
    return classifyAgentAuthority(def.id, ctx.phase, ctx.rawArgs);
  },
};
