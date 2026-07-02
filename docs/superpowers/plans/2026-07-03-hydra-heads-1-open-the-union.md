# Hydra Heads — Sub-project 1: Open the Union Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Replace the closed `AgentId = "codex" | "claude"` union with a registry-keyed string served by per-kind adapters, wrap the existing Codex/Claude transport as vendor adapters, and ship a new Gemini built-in — with zero behavior change for a default Codex+Claude room.

**Architecture:** A new `src/agentAdapter.ts` defines the data contract (`AgentDefinition`) and behavior contract (`AgentAdapter`, `Invocation`). A new `src/agentRegistry.ts` loads built-in definitions (codex, claude, gemini), assigns color indexes, and exposes `get`/`list`/`adapterFor`. `phases.ts` opens `AgentId` to `string` and replaces the binary `otherAgent` flip with `pickReviewers(builder, roster, policy)` (single reviewer for a two-head roster, so serial behavior is identical). Vendor adapters delegate to the already-extracted `agentArgs.ts`/`codexTransport.ts`/`claudeTransport.ts`/`cli.ts` helpers so the Codex/Claude spawn argv is byte-identical to today; Gemini is a new spawn adapter. Display ternaries, pricing, doctor trust-scoping, the model chooser, and the webview head rendering all resolve through the registry.

**Tech Stack:** TypeScript, VS Code extension API, Node built-in test runner, pnpm.

## Global Constraints
- `AgentId` is `type AgentId = string` — always a key into the registry; never re-close it to a union.
- Locked shared interfaces (consumed by SP2/SP3) keep the EXACT names/shapes in the spec: `AgentDefinition`, `AgentAdapter`, `Invocation`, `agentRegistry.get/list/adapterFor`, `pickReviewers(builder, roster, policy): AgentId[]`.
- Any new setting that flows into a spawn/exec/env/PATH/endpoint MUST be `scope:"application"` in `package.json`, listed in `capabilities.untrustedWorkspaces.restrictedConfigurations`, AND mirrored in `TRUST_SCOPED_SETTINGS` in `src/doctor.ts`. `test/trustScopeContract.test.ts` enforces the three-way sync.
- Do NOT tighten the accepted permissive vendor defaults (Codex `--sandbox workspace-write` + `network_access=true`, Claude `acceptEdits`).
- Codex+Claude rooms must behave EXACTLY as before. A Codex adapter `buildInvocation` must produce the same `AgentSpawn` as today's `panel.ts:buildSpawn` for the same config; a regression test pins this.
- TDD only: write the failing test, run it red, implement minimally, run it green, commit. Small frequent commits. `pnpm run check` = type-check only; `pnpm test` = full suite; single suite = `tsc -p . && node --test dist/test/<name>.test.js`.
- The webview must keep the `test/webviewContract.test.ts` hooks: exactly one `className = "head-art "` DOM site, one `.head-art {` and one `.head-art img {` CSS rule.
- No new `: any`. New webview message shapes (if any) go in `src/webviewMessages.ts` first.
- Gemini's exact CLI surface (argv, output shape, usage fields) is UNVERIFIED in this repo. Task 5 includes a mandatory verification-against-a-real-install step; do not finalize `geminiAdapter` parse logic from memory.

---

### Task 1: Adapter contract module (`src/agentAdapter.ts`)

**Files:**
- Create: `src/agentAdapter.ts`
- Modify: `src/usage.ts` (add exported `UsageTokens` interface next to `ModelPrices`, verified at lines 30-45 and the token-shape returned by `usageFromClaudeSummary` at 175-189)
- Test: `test/agentAdapter.test.ts`

**Interfaces:**
- Consumes: `ModelPrices` (from `src/usage.ts`, existing), `AuthorityClassification` (from `src/authority.ts` line 7), `Phase` (from `src/prompts.ts`), `RequestFilePlaceholders` (from `src/cli.ts` line 89).
- Produces: `AgentDefinition`, `AgentAdapter`, `Invocation`, `InvocationContext`, `AdapterRawOutput`, `AdapterOutputMode`, `AuthorityClass`, `AgentKind`, `KNOWN_AGENT_KINDS`, `isAgentKind(value: string): value is AgentKind`, and `UsageTokens` (added to `usage.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// test/agentAdapter.test.ts
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { KNOWN_AGENT_KINDS, isAgentKind } from "../src/agentAdapter";

describe("agent adapter contract", () => {
  test("KNOWN_AGENT_KINDS lists the five kinds in spec order", () => {
    assert.deepEqual(
      [...KNOWN_AGENT_KINDS],
      ["codex", "claude", "gemini", "openai-compatible", "cli-template"],
    );
  });

  test("isAgentKind narrows only known kinds", () => {
    assert.equal(isAgentKind("gemini"), true);
    assert.equal(isAgentKind("codex"), true);
    assert.equal(isAgentKind("ollama-qwen"), false);
    assert.equal(isAgentKind(""), false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/agentAdapter.test.js`
Expected failure: `tsc` errors with `Cannot find module '../src/agentAdapter'` (compile fails before the test runs).

- [ ] **Step 3: Implement minimally**

```ts
// src/agentAdapter.ts
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
```

Add to `src/usage.ts` immediately after the `ModelPrices` interface (line 39):

```ts
/** Normalized per-call token counts shared across adapters. */
export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  reasoningTokens: number;
}
```

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/agentAdapter.test.js`
Expected pass: `# pass 2  # fail 0`.

- [ ] **Step 5: Commit**

`git add src/agentAdapter.ts src/usage.ts test/agentAdapter.test.ts && git commit -m "Add AgentAdapter contract types and UsageTokens

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 2: Open the `AgentId` union + `pickReviewers` in `phases.ts`

**Files:**
- Modify: `src/phases.ts` (line 1 union; `otherAgent` at line 37; the `["codex","claude"]` literals in `transition` at lines 59/75/91/98/113/119)
- Test: `test/phases.test.ts` (append a `pickReviewers` describe block; existing serial-sequence tests at lines 5-40 must still pass unchanged)

**Interfaces:**
- Consumes: nothing new.
- Produces: `type AgentId = string`, `type ParticipationPolicy = "serial"`, `function pickReviewers(builder: AgentId, roster: ReadonlyArray<AgentId>, policy?: ParticipationPolicy): AgentId[]`, `const DEFAULT_ROSTER: ReadonlyArray<AgentId>`.

- [ ] **Step 1: Write the failing test** (append to `test/phases.test.ts`)

```ts
import { pickReviewers, DEFAULT_ROSTER } from "../src/phases";

describe("pickReviewers()", () => {
  test("two-head roster returns the single non-builder as reviewer", () => {
    assert.deepEqual(pickReviewers("codex", ["codex", "claude"]), ["claude"]);
    assert.deepEqual(pickReviewers("claude", ["codex", "claude"]), ["codex"]);
  });

  test("gemini can be the builder in a codex+gemini roster", () => {
    assert.deepEqual(pickReviewers("gemini", ["codex", "gemini"]), ["codex"]);
  });

  test("default roster is codex then claude", () => {
    assert.deepEqual([...DEFAULT_ROSTER], ["codex", "claude"]);
  });

  test("serial policy never returns more than one reviewer (SP1)", () => {
    assert.equal(pickReviewers("codex", ["codex", "claude", "gemini"], "serial").length, 1);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/phases.test.js`
Expected failure: `tsc` error `Module '"../src/phases"' has no exported member 'pickReviewers'`.

- [ ] **Step 3: Implement minimally** — edit `src/phases.ts`

Replace line 1 and the `otherAgent` helper (line 37):

```ts
export type AgentId = string;
export type ParticipationPolicy = "serial";
export type DiscussionMode = "serial" | "parallelOnBoth" | "parallel";

export const DEFAULT_ROSTER: ReadonlyArray<AgentId> = ["codex", "claude"];

/**
 * Reviewers for a builder's diff, chosen from the rest of the roster.
 * SP1 is serial-only: a two-head roster yields exactly one reviewer, so
 * `transition()` behavior is unchanged. SP3 relaxes this to N reviewers.
 */
export function pickReviewers(
  builder: AgentId,
  roster: ReadonlyArray<AgentId>,
  _policy: ParticipationPolicy = "serial",
): AgentId[] {
  return roster.filter((a) => a !== builder).slice(0, 1);
}

// Why: keep the internal binary flip used by transition() but route it through
// pickReviewers over the default two-head roster, so the state machine stays
// exactly as-is while the reviewer choice has a single generalized home.
const otherAgent = (a: AgentId): AgentId => pickReviewers(a, DEFAULT_ROSTER)[0] ?? a;
```

Leave the `["codex", "claude"]` literals inside `transition` as-is for SP1 (default two-head roster). `pnpm run check` should stay green because `string` is wider than the old union.

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/phases.test.js` — expected `# fail 0`.
Then drive out any residual type errors across the tree:
Command: `pnpm run check`
Expected: exits 0. If any errors surface, they follow this PATTERN (opening a union is widening, so errors are rare and localized):
- `Record<AgentId, X>` literals now type as `Record<string, X>`; indexing by a possibly-unknown id is still `X` (no `noUncheckedIndexedAccess` in this project) — no change needed.
- Representative sites that DO NOT error but are SEMANTIC and handled in later tasks: `usage.ts:41` `DEFAULT_PRICES`, `usage.ts:333` `byAgent` literal, `prompts.ts:15` / `panel.ts:310` `AGENT_NAMES`. Do not touch them here.
Fix any genuine `pnpm run check` error at its site before committing; do not attempt a blanket sweep.

- [ ] **Step 5: Commit**

`git add src/phases.ts test/phases.test.ts && git commit -m "Open AgentId union to string; add pickReviewers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 3: Registry with built-in definitions (`src/agentRegistry.ts`)

**Files:**
- Create: `src/agentRegistry.ts`
- Test: `test/agentRegistry.test.ts`

**Interfaces:**
- Consumes: `AgentDefinition`, `AgentAdapter`, `AgentKind`, `isAgentKind` (Task 1).
- Produces: `BUILTIN_AGENT_DEFINITIONS: AgentDefinition[]`, `listAgentDefinitions(): AgentDefinition[]`, `getAgentDefinition(id: string): AgentDefinition | undefined`, `displayNameFor(id: string): string`, `registerAdapter(adapter: AgentAdapter): void`, `adapterForKind(kind: AgentKind): AgentAdapter`, and the singleton `agentRegistry = { get, list, adapterFor }` matching the locked spec. Also `assignColorIndexes(defs): AgentDefinition[]`.

Notes: SP1 loads built-ins + assigns color index by registry order. `hydraRoom.agents` user definitions and full validation are SP2 — SP1 merges an (empty by default) user array read but does not yet validate/parse custom kinds. `adapterFor` throws if no adapter is registered for a kind (adapters register in Tasks 4-5).

- [ ] **Step 1: Write the failing test**

```ts
// test/agentRegistry.test.ts
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  BUILTIN_AGENT_DEFINITIONS,
  listAgentDefinitions,
  getAgentDefinition,
  displayNameFor,
  assignColorIndexes,
} from "../src/agentRegistry";

describe("agent registry", () => {
  test("ships codex, claude, gemini built-ins", () => {
    const ids = BUILTIN_AGENT_DEFINITIONS.map((d) => d.id);
    assert.deepEqual(ids, ["codex", "claude", "gemini"]);
  });

  test("built-in kinds map one-to-one", () => {
    assert.equal(getAgentDefinition("codex")?.kind, "codex");
    assert.equal(getAgentDefinition("claude")?.kind, "claude");
    assert.equal(getAgentDefinition("gemini")?.kind, "gemini");
  });

  test("colorIndex is assigned by registry order (codex=1, claude=2, gemini=3)", () => {
    const withColors = assignColorIndexes([...BUILTIN_AGENT_DEFINITIONS]);
    assert.equal(withColors[0]?.colorIndex, 1);
    assert.equal(withColors[1]?.colorIndex, 2);
    assert.equal(withColors[2]?.colorIndex, 3);
  });

  test("displayNameFor falls back to the id for unknown heads", () => {
    assert.equal(displayNameFor("codex"), "Codex");
    assert.equal(displayNameFor("gemini"), "Gemini");
    assert.equal(displayNameFor("ollama-qwen"), "ollama-qwen");
  });

  test("listAgentDefinitions returns built-ins when no user agents configured", () => {
    assert.deepEqual(listAgentDefinitions().map((d) => d.id), ["codex", "claude", "gemini"]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/agentRegistry.test.js`
Expected failure: `Cannot find module '../src/agentRegistry'`.

- [ ] **Step 3: Implement minimally**

```ts
// src/agentRegistry.ts
import type { AgentDefinition, AgentAdapter, AgentKind } from "./agentAdapter";

export const BUILTIN_AGENT_DEFINITIONS: AgentDefinition[] = [
  { id: "codex", displayName: "Codex", kind: "codex" },
  { id: "claude", displayName: "Claude", kind: "claude" },
  { id: "gemini", displayName: "Gemini", kind: "gemini" },
];

/** Assign a 1-based head-ramp slot to any definition missing an explicit one. */
export function assignColorIndexes(defs: AgentDefinition[]): AgentDefinition[] {
  return defs.map((def, i) => ({ ...def, colorIndex: def.colorIndex ?? i + 1 }));
}

// SP1: built-ins only. SP2 merges validated hydraRoom.agents entries here.
function loadDefinitions(): AgentDefinition[] {
  return assignColorIndexes(BUILTIN_AGENT_DEFINITIONS.map((d) => ({ ...d })));
}

let cached: AgentDefinition[] | undefined;
function definitions(): AgentDefinition[] {
  if (!cached) cached = loadDefinitions();
  return cached;
}

export function listAgentDefinitions(): AgentDefinition[] {
  return definitions();
}

export function getAgentDefinition(id: string): AgentDefinition | undefined {
  return definitions().find((d) => d.id === id);
}

export function displayNameFor(id: string): string {
  return getAgentDefinition(id)?.displayName ?? id;
}

const adapters = new Map<AgentKind, AgentAdapter>();

export function registerAdapter(adapter: AgentAdapter): void {
  adapters.set(adapter.kind, adapter);
}

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
```

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/agentRegistry.test.js` — expected `# fail 0`.

- [ ] **Step 5: Commit**

`git add src/agentRegistry.ts test/agentRegistry.test.ts && git commit -m "Add agent registry with codex/claude/gemini built-ins

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 4: Codex + Claude vendor adapters (wrap existing transport)

**Files:**
- Create: `src/codexAdapter.ts`, `src/claudeAdapter.ts`
- Modify: `src/agentRegistry.ts` (import the adapter modules so their `registerAdapter(...)` side-effect runs)
- Test: `test/codexAdapter.test.ts`, `test/claudeAdapter.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter`, `AgentDefinition`, `InvocationContext`, `Invocation`, `AdapterRawOutput` (Task 1); `insertBeforeStdinDash`, `withModelArgs`, `withEffortArgs` (`src/agentArgs.ts`); `withCodexSkipGitRepoCheckArgs` (`src/codexTransport.ts`); `buildAgentSpawn` (`src/cli.ts` line 157); `classifyAgentAuthority` (`src/authority.ts`); `usageFromCodexSummary`/`usageFromClaudeSummary`/`resolveModelPrices` (`src/usage.ts`); `registerAdapter` (Task 3).
- Produces: `codexAdapter: AgentAdapter`, `claudeAdapter: AgentAdapter` (kind `"codex"`/`"claude"`). Their `buildInvocation` output for a codex/claude head reproduces today's `panel.ts:buildSpawn` argv exactly.

Note on `buildInvocation`: today `panel.ts:buildSpawn` (lines 4062-4088) does `buildAgentSpawn(agent, phase, command, rawArgs, root)` → `if (agent === "codex") withCodexSkipGitRepoCheckArgs` → `withModelArgs` → `withEffortArgs`. The adapter reproduces exactly that chain (minus `applySpawnEnvironment`, which stays in panel as a post-step so env resolution is unchanged). `parseReply`/`parseUsage` wrap the existing normalizers; panel keeps its outputMode-keyed normalize plumbing in SP1 (generalized for gemini in Task 8/12).

- [ ] **Step 1: Write the failing test**

```ts
// test/codexAdapter.test.ts
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { codexAdapter } from "../src/codexAdapter";
import type { AgentDefinition, InvocationContext } from "../src/agentAdapter";

const codexDef: AgentDefinition = { id: "codex", displayName: "Codex", kind: "codex" };
const ctx = (over: Partial<InvocationContext> = {}): InvocationContext => ({
  phase: "build",
  workspaceRoot: "C:/repo",
  prompt: "do the thing",
  command: "codex",
  rawArgs: ["exec", "--sandbox", "workspace-write", "-"],
  ...over,
});

describe("codex adapter", () => {
  test("buildInvocation produces a spawn invocation reading stdin", () => {
    const inv = codexAdapter.buildInvocation(codexDef, ctx());
    assert.equal(inv.transport, "spawn");
    if (inv.transport !== "spawn") return;
    assert.equal(inv.command, "codex");
    assert.equal(inv.args[0], "exec");
    // skip-git-repo-check is injected before the trailing stdin dash
    assert.ok(inv.args.includes("--skip-git-repo-check"));
    assert.equal(inv.args[inv.args.length - 1], "-");
    assert.equal(inv.stdin, "do the thing");
  });

  test("parseUsage reads codex token summary fields", () => {
    const usage = codexAdapter.parseUsage({
      stdout: "",
      stderr: "",
      exitCode: 0,
      outputMode: "codexJson",
      // parseUsage delegates to usageFromCodexSummary via a token block on stdout;
      // this asserts the plain-total path returns undefined for empty output.
    });
    assert.equal(usage, undefined);
  });

  test("kind is codex", () => {
    assert.equal(codexAdapter.kind, "codex");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/codexAdapter.test.js`
Expected failure: `Cannot find module '../src/codexAdapter'`.

- [ ] **Step 3: Implement minimally**

```ts
// src/codexAdapter.ts
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
    return def.pricing ?? resolveModelPrices(def.id, def.model, {}, undefined);
  },
  authority(def: AgentDefinition, ctx: InvocationContext) {
    return classifyAgentAuthority(def.id, ctx.phase, ctx.rawArgs);
  },
};

void usageFromCodexSummary; // structured-JSON usage stays wired via panel outputMode in SP1
```

`src/claudeAdapter.ts` mirrors it: `buildInvocation` calls `buildAgentSpawn` → `withModelArgs` → `withEffortArgs` (NO skip-git-repo-check — that guard is codex-only, per `panel.ts:4073`), `parseReply` returns `raw.stdout`, `parseUsage` delegates to the claude summary path (returns `undefined` for empty), `pricing`/`authority` as above with `def.id`.

Add to `src/agentRegistry.ts` (top, after imports) so registration runs on import:

```ts
import { codexAdapter } from "./codexAdapter";
import { claudeAdapter } from "./claudeAdapter";
registerAdapter(codexAdapter);
registerAdapter(claudeAdapter);
```

`resolveModelPrices`'s 4th arg is currently required (`agentDefaults: Record<AgentId, ModelPrices> = DEFAULT_PRICES`); it already has a default, so passing `undefined` is invalid — pass nothing: `resolveModelPrices(def.id, def.model, {})`. Adjust the call accordingly.

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/codexAdapter.test.js dist/test/claudeAdapter.test.js` — expected `# fail 0`.

- [ ] **Step 5: Commit**

`git add src/codexAdapter.ts src/claudeAdapter.ts src/agentRegistry.ts test/codexAdapter.test.ts test/claudeAdapter.test.ts && git commit -m "Wrap Codex and Claude as vendor adapters over existing transport

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 5: Gemini vendor adapter (+ verify against a real install)

**Files:**
- Create: `src/geminiAdapter.ts`
- Modify: `src/agentRegistry.ts` (register the gemini adapter)
- Test: `test/geminiAdapter.test.ts`

**Interfaces:**
- Consumes: adapter contract (Task 1); `buildAgentSpawn` (`src/cli.ts`); `classifyAgentAuthority` (`src/authority.ts`); `registerAdapter` (Task 3); `numberOr` (`src/usage.ts` line 459).
- Produces: `geminiAdapter: AgentAdapter` (kind `"gemini"`), `parseGeminiUsage(raw): UsageTokens | undefined`, `roomTextFromGeminiJson(raw: string): string`.

- [ ] **Step 0: Verify the real Gemini CLI surface BEFORE writing parse logic** (mandatory; do not skip)

Run against a real install and record outputs into the test as fixtures:
```
gemini --help
gemini --version
gemini -p "reply with exactly OK" --output-format json   # confirm the flag name + JSON shape
```
Confirm and write down: (a) the non-interactive prompt flag (`-p`/`--prompt`/positional), (b) the model flag (`-m`/`--model`), (c) whether a JSON/structured output flag exists and its top-level shape, (d) where token usage appears (field names like `usageMetadata.promptTokenCount`/`candidatesTokenCount`, or a footer line). If the CLI has no JSON mode, `outputMode` for gemini stays `"plain"` and `parseUsage` returns `undefined` (cost falls back to per-kind default pricing). Encode the observed shape as the fixture in Step 1. If no `gemini` is installed on this machine, mark Step 1's usage fixture with a `// VERIFY:` comment and keep `parseUsage` returning `undefined` until a real capture exists — ship the spawn/`parseReply` path (which only needs the prompt flag) and leave usage as a follow-up.

- [ ] **Step 1: Write the failing test** (fixture values reflect the Step 0 capture)

```ts
// test/geminiAdapter.test.ts
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { geminiAdapter, roomTextFromGeminiJson, parseGeminiUsage } from "../src/geminiAdapter";
import type { AgentDefinition, InvocationContext } from "../src/agentAdapter";

const geminiDef: AgentDefinition = { id: "gemini", displayName: "Gemini", kind: "gemini" };
const ctx: InvocationContext = {
  phase: "build",
  workspaceRoot: "C:/repo",
  prompt: "do the thing",
  command: "gemini",
  rawArgs: ["-p", "-"], // VERIFY against Step 0; stdin sentinel or ${prompt}
};

describe("gemini adapter", () => {
  test("buildInvocation spawns the gemini command with the prompt on stdin", () => {
    const inv = geminiAdapter.buildInvocation(geminiDef, ctx);
    assert.equal(inv.transport, "spawn");
    if (inv.transport !== "spawn") return;
    assert.equal(inv.command, "gemini");
    assert.equal(inv.stdin, "do the thing");
  });

  test("model from the definition is injected as --model", () => {
    const inv = geminiAdapter.buildInvocation({ ...geminiDef, model: "gemini-2.5-pro" }, ctx);
    if (inv.transport !== "spawn") return;
    const mi = inv.args.indexOf("--model");
    assert.ok(mi >= 0 && inv.args[mi + 1] === "gemini-2.5-pro");
  });

  test("parseGeminiUsage reads token counts from the captured JSON shape", () => {
    // Fixture from Step 0 real capture:
    const raw = JSON.stringify({ usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40 } });
    const usage = parseGeminiUsage(raw);
    assert.deepEqual(usage, {
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      reasoningTokens: 0,
    });
  });

  test("roomTextFromGeminiJson extracts the assistant text", () => {
    const raw = JSON.stringify({ response: "hello world" }); // VERIFY field name
    assert.equal(roomTextFromGeminiJson(raw), "hello world");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/geminiAdapter.test.js`
Expected failure: `Cannot find module '../src/geminiAdapter'`.

- [ ] **Step 3: Implement minimally** (field names must match the Step 0 capture)

```ts
// src/geminiAdapter.ts
import type { AgentAdapter, AgentDefinition, InvocationContext, Invocation, AdapterRawOutput } from "./agentAdapter";
import type { UsageTokens, ModelPrices } from "./usage";
import { buildAgentSpawn } from "./cli";
import { insertBeforeStdinDash } from "./agentArgs";
import { classifyAgentAuthority } from "./authority";
import { resolveModelPrices, numberOr } from "./usage";

export function roomTextFromGeminiJson(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { response?: unknown };
    if (typeof parsed.response === "string") return parsed.response;
  } catch {
    // Not JSON (plain mode / partial output) — return as-is.
  }
  return raw;
}

export function parseGeminiUsage(raw: string): UsageTokens | undefined {
  try {
    const parsed = JSON.parse(raw) as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
    const meta = parsed.usageMetadata;
    if (!meta) return undefined;
    const input = numberOr(meta.promptTokenCount, 0);
    const output = numberOr(meta.candidatesTokenCount, 0);
    if (input + output === 0) return undefined;
    return { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 };
  } catch {
    return undefined;
  }
}

export const geminiAdapter: AgentAdapter = {
  kind: "gemini",
  buildInvocation(def: AgentDefinition, ctx: InvocationContext): Invocation {
    const spawn = buildAgentSpawn(def.id, ctx.phase, ctx.command, ctx.rawArgs, ctx.workspaceRoot);
    let args = spawn.args;
    if (def.model && !args.includes("--model") && !args.includes("-m")) {
      args = insertBeforeStdinDash(args, ["--model", def.model]);
    }
    return { transport: "spawn", command: spawn.command, args, stdin: ctx.prompt };
  },
  parseReply(raw: AdapterRawOutput): string {
    return raw.outputMode === "geminiJson" ? roomTextFromGeminiJson(raw.stdout) : raw.stdout;
  },
  parseUsage(raw: AdapterRawOutput): UsageTokens | undefined {
    return raw.outputMode === "geminiJson" ? parseGeminiUsage(raw.stdout) : undefined;
  },
  pricing(def: AgentDefinition): ModelPrices {
    return def.pricing ?? resolveModelPrices(def.id, def.model, {});
  },
  authority(def: AgentDefinition, ctx: InvocationContext) {
    return classifyAgentAuthority(def.id, ctx.phase, ctx.rawArgs);
  },
};
```

Register in `src/agentRegistry.ts`: `import { geminiAdapter } from "./geminiAdapter"; registerAdapter(geminiAdapter);`

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/geminiAdapter.test.js` — expected `# fail 0`.

- [ ] **Step 5: Commit**

`git add src/geminiAdapter.ts src/agentRegistry.ts test/geminiAdapter.test.ts && git commit -m "Add Gemini vendor adapter (spawn) with verified CLI surface

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 6: Registry-driven pricing in `src/usage.ts`

**Files:**
- Modify: `src/usage.ts` (`DEFAULT_PRICES` at 41-45; `resolveModelPrices` at 98-116; `summarizeUsage` byAgent literal at 333-337 and 356-358)
- Test: `test/usage.test.ts` (append)

**Interfaces:**
- Consumes: `getAgentDefinition` (Task 3) — imported lazily to avoid a cycle (usage ← adapters ← usage). Use a local `pricingForAgent` that reads `def.pricing ?? DEFAULT_PRICES_BY_KIND[kind] ?? per-agent default`.
- Produces: `DEFAULT_PRICES_BY_KIND: Record<AgentKind, ModelPrices>`, unchanged `resolveModelPrices` signature, `summarizeUsage` returning a dynamic `byAgent: Record<string, {...}>`.

Note: `usage.ts` must NOT import `agentRegistry.ts` (which imports the adapters, which import `usage.ts`) — keep the cycle out by adding a per-kind price table here and letting adapters pass `def.pricing`/`def.model` in. `byAgent` becomes dynamic so a gemini row aggregates without a hardcoded seat.

- [ ] **Step 1: Write the failing test** (append to `test/usage.test.ts`)

```ts
import { DEFAULT_PRICES_BY_KIND, summarizeUsage, buildUsageRecord } from "../src/usage";

describe("registry-driven pricing", () => {
  test("per-kind defaults exist for codex, claude, gemini", () => {
    assert.ok(DEFAULT_PRICES_BY_KIND.codex.inputPerMTok > 0);
    assert.ok(DEFAULT_PRICES_BY_KIND.claude.inputPerMTok > 0);
    assert.ok(DEFAULT_PRICES_BY_KIND.gemini.inputPerMTok > 0);
  });

  test("summarizeUsage aggregates an arbitrary agent id without a hardcoded seat", () => {
    const rec = buildUsageRecord({
      sessionId: "s", agent: "gemini", phase: "build", source: "unknown",
      tokens: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
    });
    const summary = summarizeUsage([rec]);
    assert.equal(summary.byAgent.gemini?.turns, 1);
    assert.equal(summary.byAgent.gemini?.totalTokens, 150);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/usage.test.js`
Expected failure: `Module '"../src/usage"' has no exported member 'DEFAULT_PRICES_BY_KIND'` and, once that is added, `summary.byAgent.gemini` is `undefined` (the literal only seats codex/claude).

- [ ] **Step 3: Implement minimally** — edit `src/usage.ts`

Add after `DEFAULT_PRICES` (line 45):

```ts
import type { AgentKind } from "./agentAdapter";

/** Per-kind fallback prices when a head has no explicit pricing and no known model. */
export const DEFAULT_PRICES_BY_KIND: Record<AgentKind, ModelPrices> = {
  codex: DEFAULT_PRICES.codex,
  claude: DEFAULT_PRICES.claude,
  gemini: { inputPerMTok: 1.25, outputPerMTok: 5, cacheReadPerMTok: 0.3125, cacheCreatePerMTok: 1.25 }, // VERIFY vs Gemini public pricing
  "openai-compatible": DEFAULT_PRICES.codex, // SP2 refines
  "cli-template": DEFAULT_PRICES.codex,
};
```

Change `summarizeUsage` (line 324-337) so `byAgent` starts empty and seats lazily:

```ts
const summary: UsageSummary = {
  turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheCreateTokens: 0, reasoningTokens: 0, totalTokens: 0, costUsd: 0,
  byAgent: {},
};
```

In the fold loop (line 348-353) seat on first sight:

```ts
if (!summary.byAgent[r.agent]) summary.byAgent[r.agent] = { turns: 0, totalTokens: 0, costUsd: 0 };
const a = summary.byAgent[r.agent];
```

Apply the same lazy-seat in `addRecordToSummary` (line 402). Change the `UsageSummary.byAgent` type (line 311) from `Record<AgentId, ...>` to `Record<string, ...>` (already compatible since `AgentId = string`, but drop the now-misleading literal-completeness expectation). Leave `resolveModelPrices`'s `agentDefaults[agent] ?? DEFAULT_PRICES[agent]` fallback but add a final guard so an unknown agent id resolves to a per-kind default rather than `undefined` — resolve via `DEFAULT_PRICES[agent] ?? DEFAULT_PRICES_BY_KIND.codex`.

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/usage.test.js` — expected `# fail 0`. Then `pnpm run check` — expected 0 (webview `agents.codex`/`agents.claude` reads in `media/webview.js` are plain JS, untyped, still fine; Task 11 updates them).

- [ ] **Step 5: Commit**

`git add src/usage.ts test/usage.test.ts && git commit -m "Make usage pricing per-kind and byAgent aggregation dynamic

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 7: Replace display ternaries + `AGENT_NAMES` with `displayNameFor`

**Files:**
- Modify: `src/decisions.ts` (lines 150-151), `src/hydraWiki.ts` (line 540), `src/nativeCapabilities.ts` (line 183), `src/nativeActions.ts` (line 89), `src/workQueue.ts` (line 82), `src/terminalProtocol.ts` (line 54), `src/prompts.ts` (`AGENT_NAMES` line 15, uses 97-98), `src/terminalPoke.ts` (`AGENT_NAMES` line 5, uses 26-29), `src/telegramController.ts` (`AGENT_NAMES` line 33, use 461), `src/panel.ts` (`AGENT_NAMES` line 310 + ~20 call sites)
- Test: `test/decisions.test.ts` and `test/nativeActions.test.ts` (append gemini display assertions); `pnpm run check`

**Interfaces:**
- Consumes: `displayNameFor` (Task 3).
- Produces: no new exports. Every `x === "codex" ? "Codex" : "Claude"` and `AGENT_NAMES[x]` becomes `displayNameFor(x)`, so a gemini head renders "Gemini" instead of being mislabeled "Claude".

Transformation PATTERN (3 representative examples):

1. `src/decisions.ts:150` — `label: \`Accept Default: Build with ${builder === "codex" ? "Codex" : "Claude"}\`` → `label: \`Accept Default: Build with ${displayNameFor(builder)}\`` (add `import { displayNameFor } from "./agentRegistry";`).
2. `src/nativeActions.ts:89` — `.map((agent) => agent === "codex" ? "Codex" : "Claude")` → `.map((agent) => displayNameFor(agent))`.
3. `src/panel.ts:310` — delete `const AGENT_NAMES: Record<AgentId, string> = { codex: "Codex", claude: "Claude" };`, import `displayNameFor`, and replace every `AGENT_NAMES[x]` (e.g. lines 845, 2023, 5794-5803) with `displayNameFor(x)`.

Then let the type-checker and grep confirm no stragglers.

- [ ] **Step 1: Write the failing test** (append to `test/nativeActions.test.ts`)

```ts
import { displayNameFor } from "../src/agentRegistry";

describe("multi-head display labels", () => {
  test("a gemini head is labeled Gemini, not Claude", () => {
    // Before this task, agent === "codex" ? "Codex" : "Claude" mislabeled gemini.
    assert.equal(displayNameFor("gemini"), "Gemini");
    assert.equal(displayNameFor("codex"), "Codex");
    assert.equal(displayNameFor("claude"), "Claude");
  });
});
```

(This asserts the shared helper; the per-file edits are verified by `pnpm run check` + grep in Step 2/4.)

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/nativeActions.test.js`
Expected: the new test passes only after Task 3 (it will pass), so instead confirm the WORK is not yet done by grepping for the ternaries:
Command: `rg -n '\? "Codex" : "Claude"' src`
Expected failure state: matches in `decisions.ts`, `nativeActions.ts`, `nativeCapabilities.ts`, `workQueue.ts`, `terminalProtocol.ts`, `hydraWiki.ts` still present.

- [ ] **Step 3: Implement minimally**

Apply the transformation pattern to all listed files. For `AGENT_NAMES` modules (`prompts.ts`, `terminalPoke.ts`, `telegramController.ts`, `panel.ts`), delete the local `AGENT_NAMES` const and replace lookups with `displayNameFor(...)`. In `prompts.ts:97-98`, `const me = displayNameFor(input.agent); const them = displayNameFor(input.otherAgent);`.

- [ ] **Step 4: Run to confirm pass**

Command: `rg -n '\? "Codex" : "Claude"' src` — expected: no matches.
Command: `rg -n 'AGENT_NAMES' src` — expected: no matches.
Command: `pnpm run check` — expected exit 0.
Command: `tsc -p . && node --test dist/test/nativeActions.test.js dist/test/decisions.test.js dist/test/prompts.test.js` — expected `# fail 0`.

- [ ] **Step 5: Commit**

`git add src test/nativeActions.test.ts && git commit -m "Resolve agent display names through the registry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 8: Generalize keyed lookups so a Gemini head flows (cli/authority/agentArgs)

**Files:**
- Modify: `src/cli.ts` (`CAPABILITIES` record at 18-27; `nativeCapabilitySummary` at 228-230; `knownAgentExecutableCandidates` at 193-226 — add a gemini/default branch), `src/authority.ts` (line 33 `agent === "codex" ? classifyCodexAuthority : classifyClaudeAuthority`), `src/agentArgs.ts` (`effortForPhase` at 63-69)
- Test: `test/cli.test.ts`, `test/authority.test.ts`, `test/agentArgs.test.ts` (append)

**Interfaces:**
- Consumes: `getAgentDefinition`/`isAgentKind` where helpful.
- Produces: no signature changes; `nativeCapabilitySummary(agent)` returns a generic line for unknown agents instead of throwing on `CAPABILITIES[agent]` being undefined; `classifyAgentAuthority` classifies a gemini/unknown kind via a generic (non-throwing) path; `effortForPhase` returns `""` for kinds without an effort/reasoning flag.

- [ ] **Step 1: Write the failing test** (append to `test/cli.test.ts` and `test/agentArgs.test.ts`)

```ts
// test/cli.test.ts
import { nativeCapabilitySummary } from "../src/cli";
describe("capabilities for arbitrary heads", () => {
  test("an unknown/gemini head gets a generic capability line, not a crash", () => {
    const summary = nativeCapabilitySummary("gemini");
    assert.ok(summary.length > 0);
    assert.doesNotThrow(() => nativeCapabilitySummary("ollama-qwen"));
  });
});
```

```ts
// test/agentArgs.test.ts
import { effortForPhase } from "../src/agentArgs";
describe("effort for non codex/claude heads", () => {
  test("gemini has no effort/reasoning setting -> empty string", () => {
    assert.equal(effortForPhase("gemini", "build"), "");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/cli.test.js dist/test/agentArgs.test.js`
Expected failure: `nativeCapabilitySummary("gemini")` throws `Cannot read properties of undefined (reading 'map')` (CAPABILITIES has no gemini key); `effortForPhase("gemini",...)` reads `codexReasoning` and may return a configured non-empty value (wrong).

- [ ] **Step 3: Implement minimally**

`src/cli.ts:228`:
```ts
const GENERIC_CAPABILITIES = [
  "Native CLI via hydraRoom.{id}ExecArgs* for this phase; Hydra passes raw native args through.",
  "Use whatever repo/shell/model/tool capabilities the configured native CLI invocation exposes.",
];
export function nativeCapabilitySummary(agent: AgentId): string {
  return (CAPABILITIES[agent] ?? GENERIC_CAPABILITIES).map((capability) => `- ${capability}`).join("\n");
}
```

`src/authority.ts:33`:
```ts
const base =
  agent === "codex" ? classifyCodexAuthority(phase, args)
  : agent === "claude" ? classifyClaudeAuthority(phase, args)
  : classifyGenericAuthority(phase, args); // gemini + custom heads: no vendor-specific sandbox flags known
```
Add a small `classifyGenericAuthority` that returns `workspaceWrite`/`unknown` without vendor-specific flag parsing (the `dangerousFlag` gate at line 20 still catches `--dangerously-*`).

`src/agentArgs.ts:63`:
```ts
export function effortForPhase(agent: AgentId, phase: Phase): string {
  const key = agent === "claude" ? "claudeEffort" : agent === "codex" ? "codexReasoning" : undefined;
  if (!key) return ""; // heads without an effort/reasoning knob (e.g. gemini) inject no flag
  return effectivePhasedSetting(
    vscode.workspace.getConfiguration("hydraRoom").get<unknown>(key),
    profileForPhase(phase),
  );
}
```

Add a gemini fallback branch to `knownAgentExecutableCandidates` (return `[]` for gemini so `resolveAgentCommand` falls through to PATH lookup — no bespoke install locations known yet; note this in a `// Why:` comment).

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/cli.test.js dist/test/agentArgs.test.js dist/test/authority.test.js` — expected `# fail 0`.

- [ ] **Step 5: Commit**

`git add src/cli.ts src/authority.ts src/agentArgs.ts test/cli.test.ts test/agentArgs.test.ts && git commit -m "Generalize capabilities/authority/effort lookups for non-vendor heads

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 9: Gemini settings + trust-scoping

**Files:**
- Modify: `package.json` (add `hydraRoom.geminiCommand`, `hydraRoom.geminiModel`, `hydraRoom.geminiExecArgsDiscussion/Build/Review`, `hydraRoom.geminiNativeEnv`, `hydraRoom.geminiNativePathPrepend`; add each to `capabilities.untrustedWorkspaces.restrictedConfigurations` near lines 1230-1244), `src/doctor.ts` (`TRUST_SCOPED_SETTINGS` at 63-106)
- Test: `test/trustScopeContract.test.ts` (already enforces the sync; append explicit gemini assertions)

**Interfaces:**
- Consumes: nothing.
- Produces: the gemini settings keys, read by `buildSpawn`/`buildInvocation` via the existing `${agent}Command` / `${agent}ExecArgs*` / `${agent}NativeEnv` conventions in `panel.ts:buildSpawn` and `cli.ts`.

- [ ] **Step 1: Write the failing test** (append to `test/trustScopeContract.test.ts`)

```ts
test("gemini spawn settings are trust-scoped", () => {
  const geminiKeys = [
    "geminiCommand", "geminiExecArgsDiscussion", "geminiExecArgsBuild",
    "geminiExecArgsReview", "geminiModel", "geminiNativeEnv", "geminiNativePathPrepend",
  ];
  for (const key of geminiKeys) {
    assert.ok(
      (TRUST_SCOPED_SETTINGS as readonly string[]).includes(key),
      `${key} must be trust-scoped — it flows into a native spawn`,
    );
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/trustScopeContract.test.js`
Expected failure: the new test fails (`geminiCommand must be trust-scoped`) AND the existing lockstep test fails once you add keys to only one side — proving the three-way guard works.

- [ ] **Step 3: Implement minimally**

Add to `package.json` `contributes.configuration.properties` (model each after the codex analog at lines 346-371 and 1047-1072), all with `"scope": "application"`. `geminiExecArgsBuild` default should mirror codex's write-capable shape but with gemini's real argv (from Task 5 Step 0), e.g.:
```json
"hydraRoom.geminiCommand": { "scope": "application", "type": "string", "default": "gemini", "markdownDescription": "Executable name or wrapper script for the Google Gemini CLI." },
"hydraRoom.geminiModel": { "scope": "application", "default": "", "anyOf": [ { "type": "string" }, { "type": "object", "properties": { "discussion": {"type":"string"}, "build": {"type":"string"}, "review": {"type":"string"} }, "additionalProperties": false } ], "markdownDescription": "Model passed to the Gemini CLI as `--model <id>`. String or per-phase object." }
```
Add each of the seven keys (prefixed `hydraRoom.`) to `capabilities.untrustedWorkspaces.restrictedConfigurations`. Add the same seven (un-prefixed) to `TRUST_SCOPED_SETTINGS` in `src/doctor.ts`.

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/trustScopeContract.test.js` — expected `# fail 0` (all three assertions: lockstep set-equality, scope:"application", gemini keys present).

- [ ] **Step 5: Commit**

`git add package.json src/doctor.ts test/trustScopeContract.test.ts && git commit -m "Add trust-scoped Gemini spawn settings

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 10: Gemini in the model chooser

**Files:**
- Modify: `src/modelChooser.ts` (agent picker at 86-92; `GEMINI_MODEL_PRESETS` new; `presets` selection at 107-109; `readModelSetting` already generic via `${agent}Model`)
- Test: `test/modelChooserSourceContract.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GEMINI_MODEL_PRESETS` in `modelChooser.ts`; the chooser offers Gemini as a third agent.

- [ ] **Step 1: Write the failing test** (append to `test/modelChooserSourceContract.test.ts`)

```ts
test("Gemini appears in the model chooser with a preset flagship", () => {
  const source = modelChooser();
  assert.match(source, /value:\s*"gemini"/, "Gemini missing from the agent picker");
  assert.match(source, /GEMINI_MODEL_PRESETS/, "Gemini presets missing");
  assert.match(source, /label:\s*"gemini-2\.5-pro"/, "current Gemini flagship missing"); // VERIFY id
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/modelChooserSourceContract.test.js`
Expected failure: `Gemini missing from the agent picker`.

- [ ] **Step 3: Implement minimally**

Add a third `showQuickPick` entry at `modelChooser.ts:86`:
```ts
{ label: "Gemini", description: describePhasedSettingCurrent(readModelSetting("gemini")), value: "gemini" as AgentId },
```
Add `GEMINI_MODEL_PRESETS` (hand-maintained like `CLAUDE_MODEL_PRESETS`, models confirmed against the real CLI in Task 5 Step 0):
```ts
const GEMINI_MODEL_PRESETS: Array<{ label: string; description: string }> = [
  { label: "gemini-2.5-pro", description: "Gemini 2.5 Pro — most capable" },
  { label: "gemini-2.5-flash", description: "Gemini 2.5 Flash — faster / cheaper" },
];
```
Extend the `presets` selection (line 107):
```ts
const presets = agent === "claude" ? CLAUDE_MODEL_PRESETS
  : agent === "gemini" ? GEMINI_MODEL_PRESETS
  : codexPresetsForChooser(deps.getCodexModelsSnapshot());
```

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/modelChooserSourceContract.test.js` — expected `# fail 0`.

- [ ] **Step 5: Commit**

`git add src/modelChooser.ts test/modelChooserSourceContract.test.ts && git commit -m "Add Gemini to the model chooser

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 11: Webview renders heads by color index

**Files:**
- Modify: `media/webview.js` (`labels` at 153; `head-art` className at 751; `renderAgentStatus` calls at 1108-1109; usage stats at 1417-1418; agent-name mapping at 1301; `headGlyph` at 1751-1752), `src/panel.ts` (state payload sent to webview — add `roster`/head metadata; the `postState`/state serializer that today emits `statuses.codex`/`statuses.claude`)
- Test: `test/webviewContract.test.ts` (must still pass; append a colorIndex-class assertion)

**Interfaces:**
- Consumes: `listAgentDefinitions` (Task 3) in `panel.ts` to send `{ id, displayName, colorIndex }[]` to the webview.
- Produces: webview maps `m.role`/agent id → `head-<colorIndex>` class from the roster metadata, falling back to the existing `codex`/`claude`/`user`/`system` classes so the CSS ramp still resolves. The single `className = "head-art "` site (pinned by `webviewContract`) is preserved — only the appended class string changes.

Note: `webviewContract.test.ts:369` asserts `className = "head-art "` appears EXACTLY once. Keep that exact literal; compute the color class into a variable and append it: `art.className = "head-art " + headColorClass(m.role);` — the literal `"head-art "` stays intact and singular.

- [ ] **Step 1: Write the failing test** (append to `test/webviewContract.test.ts`)

```ts
test("head color class derives from roster colorIndex metadata", () => {
  const scriptBody = fs.readFileSync(path.join(process.cwd(), "media", "webview.js"), "utf8");
  assert.match(scriptBody, /function headColorClass\(/, "webview must map role -> head-<index> class");
  // The single head-art DOM site is preserved (also pinned elsewhere in this file).
  assert.equal((scriptBody.match(/className = "head-art "/g) ?? []).length, 1);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/webviewContract.test.js`
Expected failure: `webview must map role -> head-<index> class` (no `headColorClass` function yet).

- [ ] **Step 3: Implement minimally**

In `media/webview.js`, capture roster metadata from state (a new `state.roster: {id,displayName,colorIndex}[]`) into a module `rosterById` map, and add:
```js
function headColorClass(role) {
  const def = rosterById[role];
  if (def && def.colorIndex) return "head-" + def.colorIndex;
  return role || "system"; // fallback: existing codex/claude/user/system classes
}
```
Change line 751 to `art.className = "head-art " + headColorClass(m.role);`. Ensure CSS in `src/webview.html.ts` maps both the legacy role classes AND `head-1..8` to the `--head-N` ramp (the ramp variables already exist per CLAUDE.md). In `src/panel.ts`, add `roster: listAgentDefinitions().map(({ id, displayName, colorIndex }) => ({ id, displayName, colorIndex }))` to the state object posted to the webview.

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/webviewContract.test.js dist/test/webviewCsp.test.js` — expected `# fail 0` (both structure and CSP hooks intact).

- [ ] **Step 5: Commit**

`git add media/webview.js src/webview.html.ts src/panel.ts test/webviewContract.test.ts && git commit -m "Render webview heads by roster color index

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 12: Wire `pickReviewers` + registry-driven spawn into `panel.ts`

**Files:**
- Modify: `src/panel.ts` (`otherAgent` imports/uses at 881 and 2694; `buildSpawn` at 4062-4088 — delegate the base spawn to `adapterForKind(def.kind).buildInvocation`; the `["codex","claude"]` and codex-branch dispatch)
- Test: `test/panelSourceContract.test.ts` (update the review-handoff expectation and add a registry-delegation assertion)

**Interfaces:**
- Consumes: `pickReviewers`, `DEFAULT_ROSTER` (Task 2); `getAgentDefinition`, `adapterForKind` (Task 3).
- Produces: `panel.ts:buildSpawn` builds the vendor spawn via the adapter (so codex/claude argv is identical AND a gemini head dispatches through the same path), and review handoff computes the reviewer via `pickReviewers(builder, this.roster())[0]`.

Note: keep `buildSpawn` returning an `AgentSpawn` — map the adapter's `Invocation` (which for SP1 vendor kinds is always `{transport:"spawn"}`) back to `{ command, args, cwd: workspaceRoot }` and then apply `applySpawnEnvironment` exactly as today (lines 4076-4087). The `withModelArgs`/`withEffortArgs`/`withCodexSkipGitRepoCheckArgs` calls MOVE into the adapter (Task 4), so `buildSpawn` no longer calls them inline. HTTP-transport handling is SP2 — assert `inv.transport === "spawn"` and throw a clear "not yet supported in SP1" error otherwise.

Transformation PATTERN (representative):
- `panel.ts:881` `reviewer = otherAgent(this.state.builder)` → `reviewer = pickReviewers(this.state.builder, this.roster())[0] ?? this.state.builder` (add a `private roster(): AgentId[] { return [...DEFAULT_ROSTER]; }` helper for SP1; SP3 makes it configurable).
- `panel.ts:2694` `const reactor = otherAgent(opener)` → same pattern with the roster.
- `buildSpawn` (4062-4075): replace the inline `buildAgentSpawn(...) → withCodexSkipGitRepoCheckArgs → withModelArgs → withEffortArgs` chain with:
```ts
const def = getAgentDefinition(agent) ?? { id: agent, displayName: agent, kind: "codex" as const };
const inv = adapterForKind(def.kind).buildInvocation(def, {
  phase, workspaceRoot: this.workspaceRoot, prompt: "", command, rawArgs,
});
if (inv.transport !== "spawn") throw new Error(`HTTP transport for kind "${def.kind}" is not supported until Sub-project 2`);
let spawn: AgentSpawn = { command: inv.command, args: inv.args, cwd: this.workspaceRoot };
```
(`prompt` is empty here because `buildSpawn` only forms argv; stdin is written separately by `runAgent`.)

- [ ] **Step 1: Write the failing test** (update/append in `test/panelSourceContract.test.ts`)

```ts
describe("multi-head wiring source contract", () => {
  const source = () => fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");

  test("review handoff uses pickReviewers, not the removed binary otherAgent", () => {
    const src = source();
    assert.match(src, /pickReviewers\(this\.state\.builder, this\.roster\(\)\)/);
    assert.doesNotMatch(src, /otherAgent\(/);
  });

  test("buildSpawn delegates argv construction to the registry adapter", () => {
    const src = source();
    const start = src.indexOf("private buildSpawn(");
    const end = src.indexOf("private async buildNativeCommandSpawn(", start);
    const body = src.slice(start, end);
    assert.match(body, /adapterForKind\(def\.kind\)\.buildInvocation\(/);
    assert.doesNotMatch(body, /withCodexSkipGitRepoCheckArgs\(spawn\)/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/panelSourceContract.test.js`
Expected failure: `pickReviewers(...)` not found; `otherAgent(` still matches; `adapterForKind(...)` not in `buildSpawn`.

- [ ] **Step 3: Implement minimally**

Apply the transformation pattern above. Remove the now-unused `withModelArgs`/`withEffortArgs`/`withCodexSkipGitRepoCheckArgs` imports from `panel.ts` if `buildSpawn` was their only caller (verify with grep; several other call sites may remain — only drop truly-orphaned imports per CLAUDE.md's surgical-changes rule). Add the `private roster()` helper.

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/panelSourceContract.test.js` — expected `# fail 0`.
Command: `pnpm run check` — expected exit 0 (drives out any remaining `otherAgent`/import stragglers site-by-site).

- [ ] **Step 5: Commit**

`git add src/panel.ts test/panelSourceContract.test.ts && git commit -m "Wire pickReviewers and registry-driven spawn into panel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 13: Regression + acceptance suite; full green

**Files:**
- Create: `test/hydraHeadsRegression.test.ts`
- Test: `test/hydraHeadsRegression.test.ts` + full `pnpm test`

**Interfaces:**
- Consumes: `transition`, `pickReviewers`, `DEFAULT_ROSTER` (`src/phases.ts`); `getAgentDefinition`, `adapterForKind` (`src/agentRegistry.ts`); `codexAdapter` (`src/codexAdapter.ts`).
- Produces: a locked regression proving (a) the default two-head serial sequence is unchanged, and (b) a gemini head is selectable and produces a spawn invocation for every phase.

- [ ] **Step 1: Write the failing test**

```ts
// test/hydraHeadsRegression.test.ts
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { transition, pickReviewers, DEFAULT_ROSTER } from "../src/phases";
import { getAgentDefinition, adapterForKind } from "../src/agentRegistry";
import "../src/geminiAdapter"; // ensure registration side-effect

describe("hydra heads SP1 regression", () => {
  test("default room still runs opener -> reactor -> closer -> awaiting with codex+claude", () => {
    let s = transition({ name: "Idle" }, { type: "userSent", opener: "codex" });
    assert.equal(s.name, "Opener");
    assert.equal((s as any).opener, "codex");
    assert.equal((s as any).reactor, "claude");
    s = transition(s, { type: "openerDone" });
    assert.equal(s.name, "Reactor");
    s = transition(s, { type: "reactorDone" });
    assert.equal(s.name, "Closer");
    s = transition(s, { type: "closerDone" });
    assert.equal(s.name, "AwaitingUser");
  });

  test("build -> review handoff still names the other head as reviewer", () => {
    const built = transition({ name: "AwaitingUser" }, { type: "assignBuilder", builder: "codex" });
    const done = transition(built, { type: "buildDone" });
    const review = transition(done, { type: "requestReview" });
    assert.equal(review.name, "Review");
    assert.equal((review as any).reviewer, "claude");
    assert.deepEqual(pickReviewers("codex", [...DEFAULT_ROSTER]), ["claude"]);
  });

  test("gemini is selectable and yields a spawn invocation for every phase", () => {
    const def = getAgentDefinition("gemini");
    assert.ok(def, "gemini must be a registered head");
    for (const phase of ["opener", "build", "review"] as const) {
      const inv = adapterForKind(def!.kind).buildInvocation(def!, {
        phase, workspaceRoot: "C:/repo", prompt: "hi", command: "gemini", rawArgs: ["-p", "-"],
      });
      assert.equal(inv.transport, "spawn");
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/hydraHeadsRegression.test.js`
Expected failure (if run before Tasks 2-5 land): compile/module errors. Run at the end of the sub-project — expected to pass immediately once Tasks 1-12 are complete; if any assertion fails, a prior task regressed behavior.

- [ ] **Step 3: Implement minimally**

No new production code — this task exists to lock the acceptance criteria. If an assertion fails, fix the offending prior task (do not weaken the assertion).

- [ ] **Step 4: Run to confirm pass**

Command: `pnpm test`
Expected: the whole suite is green — `# fail 0`, including `agentAdapter`, `agentRegistry`, `codexAdapter`, `claudeAdapter`, `geminiAdapter`, `phases`, `usage`, `trustScopeContract`, `modelChooserSourceContract`, `panelSourceContract`, `webviewContract`, and `hydraHeadsRegression`.

- [ ] **Step 5: Commit**

`git add test/hydraHeadsRegression.test.ts && git commit -m "Lock SP1 acceptance: default room unchanged, Gemini selectable

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`
