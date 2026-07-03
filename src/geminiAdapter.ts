import type { AgentAdapter, AgentDefinition, InvocationContext, Invocation, AdapterRawOutput } from "./agentAdapter";
import type { UsageTokens, ModelPrices } from "./usage";
import { buildAgentSpawn } from "./cli";
import { insertBeforeStdinDash, withModelArgs } from "./agentArgs";
import { classifyAgentAuthority } from "./authority";
import { resolveModelPrices, DEFAULT_PRICES_BY_KIND } from "./usage";

export const geminiAdapter: AgentAdapter = {
  kind: "gemini",
  buildInvocation(def: AgentDefinition, ctx: InvocationContext): Invocation {
    const spawn = buildAgentSpawn(def.id, ctx.phase, ctx.command, ctx.rawArgs, ctx.workspaceRoot);
    // Why: same per-phase model resolution as codex/claude — withModelArgs
    // reads `hydraRoom.geminiModel` (string or per-phase object) and respects
    // an explicit --model/-m already present in rawArgs. def.model is only a
    // fallback for when neither the setting nor rawArgs supplied one, so the
    // model chooser's selection actually takes effect and we never emit two
    // --model flags.
    let args = withModelArgs(spawn, def.id, ctx.phase).args;
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
    // Why: unlike codex/claude (whose AgentId key matches a DEFAULT_PRICES
    // entry directly), "gemini" has no DEFAULT_PRICES key, so resolveModelPrices'
    // default agentDefaults param would silently floor to the codex row. Pass
    // the gemini row from DEFAULT_PRICES_BY_KIND explicitly as the fallback.
    return def.pricing ?? resolveModelPrices(def.id, def.model, {}, { gemini: DEFAULT_PRICES_BY_KIND.gemini });
  },
  authority(def: AgentDefinition, ctx: InvocationContext) {
    return classifyAgentAuthority(def.id, ctx.phase, ctx.rawArgs);
  },
};
