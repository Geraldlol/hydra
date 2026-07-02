# Hydra Heads: multi-agent design

- Status: draft for review
- Date: 2026-07-03
- Author: Gerald + Claude Fable 5
- Scope: turn Hydra from a fixed two-agent room (Codex + Claude) into an open, data-driven roster of "heads" that supports as many models as the user configures, closed and open source.

## Summary

Today Hydra hardcodes exactly two agents through the type `AgentId = "codex" | "claude"`, used in 254 places across 34 files, and a binary review handoff (`otherAgent`). This spec opens that up: `AgentId` becomes an opaque string keyed into an **agent registry**, each head is described by a data **definition** and served by a small **adapter**, and the discuss/build/review loop generalizes from "the other agent" to "the reviewers chosen from the rest of the roster." The roster is unlimited. Built-in heads (Codex, Claude, and a new Gemini) work with zero config; users add more via a trust-scoped `hydraRoom.agents` setting, including any OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, and similar) and any CLI tool.

The work is decomposed into three sequential sub-projects, each shippable on its own. Sub-project 1 (open the union) is the foundation and also delivers Gemini.

## Goals

- One registry that holds an unlimited number of head definitions (closed vendor CLIs and open/local models).
- Built-in Codex, Claude, and Gemini heads that require no configuration and preserve today's behavior by default.
- A generic path to reach open and local models two ways: an OpenAI-compatible HTTP endpoint adapter and a CLI-command-template adapter.
- A room that runs a selectable subset of the roster, with lean defaults (two heads) and no hard ceiling.
- Review convergence as a user-selected mode: human arbitrates, unanimous to pass, or majority vote.
- No regression to the security posture: everything that defines a spawn, endpoint, or environment stays trust-scoped.

## Non-goals

- Running every configured head in every turn by default. Participation is a policy with lean defaults, not "all heads always."
- Changing the accepted permissive agent defaults for the built-in vendors (Codex workspace-write + network, Claude acceptEdits). Those remain as documented.
- Reworking the transcript, wiki, or decision-packet formats beyond what N heads require.
- A GUI for editing agent definitions. Configuration is via VS Code settings in this design.

## Background: what is two-bound today

- `src/phases.ts`: `AgentId = "codex" | "claude"`, and the entire serial loop rests on `const otherAgent = (a) => (a === "codex" ? "claude" : "codex")`. The parallel states already carry `agents: ReadonlyArray<AgentId>`, so they are closer to N-ready than the serial states.
- Per-agent modules that are already keyed by agent and only need the union opened: `agentArgs.ts`, `codexTransport.ts`, `claudeTransport.ts`, `authority.ts`, `capabilityProfiles.ts`, `cli.ts` (command/env/PATH resolution), `usage.ts` (pricing), `modelChooser.ts`, `doctor.ts`, `webviewMessages.ts`, `terminalBridge.ts`, `terminalProtocol.ts`, `prompts.ts`, `promptPreview.ts`, `decisions.ts`, `nativeActions.ts`, `sessionState.ts`.
- Hardcoded binary display ternaries (`x === "codex" ? "Codex" : "Claude"`) appear in `hydraWiki.ts`, `decisions.ts`, `nativeActions.ts`, `nativeCapabilities.ts`, and inlined `otherAgent` flips throughout `panel.ts`. These resolve through the registry once it exists.
- The webview already assigns head colors from a `--head-1..8` ramp by index ("many heads, one body"), so it is designed to render an arbitrary roster; today it emits fixed `codex`/`claude`/`user`/`system` role classes that CSS maps to the ramp.

## Locked decisions

1. **Roster is unlimited.** The count of heads that can exist is uncapped. The count that acts in a turn is a policy, defaulting to two.
2. **Built-ins plus a user array.** Codex, Claude, and Gemini ship as built-in definitions. `hydraRoom.agents` (array) adds custom heads and can override built-in fields (model, command). Existing `codexModel` / `claudeModel` / effort / profile settings keep working for the built-ins.
3. **Review convergence is user-selected**, one of: `human` (Hydra surfaces all verdicts, the user decides; auto mode may still take the safe default), `unanimous` (any "needs changes" hands back), `majority` (majority approval advances).
4. **Open and local models via two adapters**: an OpenAI-compatible HTTP endpoint adapter and a CLI-command-template adapter. Users pick per head.
5. **Security is non-negotiable.** `hydraRoom.agents` is `scope:"application"`, listed in `capabilities.untrustedWorkspaces.restrictedConfigurations`, and mirrored in Doctor's `TRUST_SCOPED_SETTINGS`. API keys are referenced by environment-variable name, never inlined.

## Architecture

### AgentId becomes a registry key

`AgentId` changes from a closed union to `type AgentId = string`. It is always a key into the agent registry. Code that today branches on the literal `"codex"` / `"claude"` values is replaced by registry lookups and adapter calls. The default roster remains `["codex", "claude"]`, so behavior is unchanged out of the box.

### AgentDefinition (data)

```ts
interface AgentDefinition {
  id: string;                 // unique registry key: "codex", "claude", "gemini", "ollama-qwen"
  displayName: string;        // "Codex", "Claude", "Qwen 2.5 (local)"
  kind: "codex" | "claude" | "gemini" | "openai-compatible" | "cli-template";
  colorIndex?: number;        // webview head ramp slot; defaults to registry order
  model?: string;             // default model for this head
  pricing?: ModelPrices;      // per-head cost; falls back to a per-kind default
  defaultAuthority?: "read-only" | "workspace-write" | "full-native";

  // openai-compatible:
  baseUrl?: string;           // e.g. http://localhost:11434/v1
  apiKeyEnv?: string;         // NAME of the env var holding the key, never the key
  headers?: Record<string, string>;

  // cli-template:
  command?: string;           // executable (also used by vendor kinds to override)
  argsTemplate?: string[];    // placeholders: ${prompt}, ${model}, ${hydraPromptFile}, ${hydraReplyFile}
}
```

### AgentAdapter (behavior)

Each `kind` has an adapter implementing one contract, so the rest of Hydra never special-cases a vendor again.

```ts
interface AgentAdapter {
  readonly kind: AgentDefinition["kind"];
  buildInvocation(def: AgentDefinition, ctx: InvocationContext): Invocation;
  parseReply(raw: AdapterRawOutput): string;
  parseUsage(raw: AdapterRawOutput): UsageTokens | undefined;
  pricing(def: AgentDefinition): ModelPrices;
  authority(def: AgentDefinition, ctx: InvocationContext): AuthorityClass;
}

type Invocation =
  | { transport: "spawn"; command: string; args: string[]; stdin?: string }
  | { transport: "http"; url: string; method: "POST"; headers: Record<string, string>; body: unknown };
```

- **Vendor adapters** (`codex`, `claude`, `gemini`) wrap existing transport code. Codex and Claude reuse `codexTransport.ts` / `claudeTransport.ts` / `agentArgs.ts`. Gemini is new: its adapter shells the `gemini` CLI, and its arg/output/usage handling is reverse-engineered the way `docs/native-internals/` documents Codex and Claude.
- **OpenAI-compatible adapter** emits an `http` invocation to `${baseUrl}/chat/completions`, injecting the key from `apiKeyEnv`. Covers Ollama, LM Studio, llama.cpp server, vLLM, and hosted open-model APIs through one path.
- **CLI-template adapter** emits a `spawn` invocation by expanding `argsTemplate` (reusing `cli.ts` placeholder expansion). Its authority is `full-native` unless the definition narrows it, and it routes through the existing full-native consent flow.

### Registry (`src/agentRegistry.ts`)

Loads built-in definitions, merges user definitions from `hydraRoom.agents` (user entries override built-ins by id), validates them (unique ids, required fields per kind, no inline secrets), assigns color indexes, and exposes `get(id)`, `list()`, and `adapterFor(def)`. Invalid definitions are dropped with a surfaced warning rather than crashing the room.

### Transport layer gains an HTTP mode

`panel.ts:runAgentTransport` currently chooses one-shot spawn vs. terminal bridge. It gains a third path: when an adapter returns an `http` invocation, a small HTTP client performs the request (with timeout, abort signal, and the same live-text streaming hook used for spawn output where the endpoint supports streaming). The normalized reply and usage flow through the existing pipeline unchanged.

### Generalized phase machine

- `otherAgent(a)` is replaced by `pickReviewers(builder, roster, policy): AgentId[]`.
- The room state carries the active `roster` and a `participation` policy per phase. Serial two-head behavior is the default policy, so `phases.ts` semantics are unchanged for a two-head roster.
- Review convergence (`human` / `unanimous` / `majority`) is evaluated when reviewers finish, deciding hand-back vs. advance. Setting: `hydraRoom.reviewConvergence`.

### Settings and migration

- New: `hydraRoom.agents` (array of `AgentDefinition`), `hydraRoom.roomRoster` (which head ids are seated; default `["codex","claude"]`), `hydraRoom.reviewConvergence` (`human` default), and per-phase participation counts (default two).
- Built-ins keep reading `codexModel` / `claudeModel` / `codexReasoning` / `claudeEffort` / the profile settings, so no user migration is required.
- Cost: `usage.ts` resolves pricing from the head's definition first, then a per-kind default, then the existing per-agent default.

### Webview

The webview renders heads from the active roster by color index instead of hardcoded role classes, completing the data-driven-index TODO noted in `CLAUDE.md`. Avatars keep the existing `.head-art` orb + glow treatment.

## Security

- `hydraRoom.agents`, `hydraRoom.roomRoster`, and any new command/endpoint/env field are `scope:"application"`, added to `restrictedConfigurations`, and mirrored in `TRUST_SCOPED_SETTINGS`. The `trustScopeContract` test enforces all three stay in sync.
- Secrets are referenced by env-var name (`apiKeyEnv`); a definition containing an inline key-shaped value is rejected by registry validation, and the redaction regex in `nativeDataSnapshot.ts` is extended to cover the new fields.
- OpenAI-compatible endpoints default to HTTPS; `http://` is allowed only for loopback and private hosts (local model servers), consistent with intent, and surfaced in prompt-preview authority.
- CLI-template heads are `full-native` by default and go through the existing consent modal and authority classification, so a custom head cannot silently run elevated.

## Sub-project decomposition

Each sub-project is independently shippable, has its own implementation plan, and leaves the test suite green.

### Sub-project 1: Open the union (foundation + Gemini)

- **Goal:** replace the `AgentId` union with a registry-keyed string, add the registry and adapter interface, wrap Codex and Claude as vendor adapters, and add a Gemini built-in. Room still runs two heads.
- **In scope:** `agentRegistry.ts`, `agentAdapter.ts`, vendor adapters (Codex, Claude, Gemini), replacing inlined binary ternaries and `otherAgent` with registry/`pickReviewers` (still returning a single reviewer for a two-head roster), Gemini settings + trust-scoping, webview role rendering by index, cost + doctor + contract-test updates.
- **Out of scope:** generic open/local adapters, rosters larger than two, review-convergence modes beyond today's single-reviewer behavior.
- **Acceptance:** Codex+Claude rooms behave exactly as before; a user can select Gemini for any phase and it discusses/builds/reviews; `pnpm test` green including updated `panelSourceContract`, `trustScopeContract`, `modelChooserSourceContract`, and new registry/adapter tests.

### Sub-project 2: Generic adapters for open and local models

- **Goal:** add the OpenAI-compatible HTTP adapter and the CLI-template adapter, plus the HTTP transport path.
- **In scope:** both generic adapters, `hydraRoom.agents` user definitions, HTTP transport in `runAgentTransport`, per-head pricing, registry validation of user entries, secret-by-env-var enforcement, redaction updates.
- **Out of scope:** rosters larger than two, review-convergence modes.
- **Acceptance:** a user adds an Ollama head (OpenAI-compatible) and a CLI-template head via settings, selects either into a two-head room, and it works end to end; invalid or secret-inlining definitions are rejected with a clear message; trust-scoping tests green.

### Sub-project 3: N-way rooms and review convergence

- **Goal:** allow rosters larger than two and implement the three review-convergence modes.
- **In scope:** participation policy per phase, `pickReviewers` returning multiple reviewers, `reviewConvergence` evaluation, webview layout for more than two heads, cost meter for N, prompt references to "the other heads," parallel-mode reuse where possible.
- **Out of scope:** anything beyond the agreed policies.
- **Acceptance:** a three-head room can run all-discuss / one-builds / two-review; each convergence mode behaves as specified; auto mode still respects the risk gate; latency and prompt-cost behavior documented.

## Testing strategy

- Update the source-contract tests that pin the current structure: `panelSourceContract` (transport wiring, `otherAgent` call sites), `modelChooserSourceContract`, `trustScopeContract`, and the `phases` tests.
- New unit tests: registry load/validate/override, each adapter's `buildInvocation` / `parseReply` / `parseUsage`, `pickReviewers`, and each review-convergence mode.
- Preserve the two-head default behavior with a regression test asserting a default room still produces today's opener/reactor/build/review sequence.

## Risks and open questions

- **Prompt cost scales with roster size** (each head receives the transcript). The existing phase-aware transcript caps mitigate this; sub-project 3 should tune them for N.
- **Serial N-way latency.** Hydra is already ~2.5x slower than a native CLI due to serialized runs; N heads worsen it. Favor the existing parallel-mode states for multi-head phases.
- **Gemini CLI surface** must be verified against a real install before the sub-project 1 plan is finalized.
- **Review-convergence UX** for the `human` mode: how multiple verdicts render in the room and the work queue needs a small design pass in sub-project 3.

## Backward compatibility

Default roster is `["codex", "claude"]`, built-ins read existing settings, participation defaults to two with single-reviewer review, and `reviewConvergence` defaults to `human`. A current user upgrading sees no behavior change until they add heads or change the roster.
