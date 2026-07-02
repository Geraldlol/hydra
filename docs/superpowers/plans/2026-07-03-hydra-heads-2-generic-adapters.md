# Hydra Heads — Sub-project 2: Generic Adapters for Open and Local Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Let a user add open/local models as first-class Hydra heads two ways — an OpenAI-compatible HTTP endpoint (Ollama, LM Studio, llama.cpp, vLLM, OpenRouter) and an arbitrary CLI via a command template — configured through a trust-scoped `hydraRoom.agents` array, validated (unique ids, required fields, no inlined secrets, HTTPS-unless-local), priced per head, and dispatched end to end in a two-head room.

**Architecture:** SP1 left `AgentId = string`, an `agentRegistry` with `get`/`list`/`adapterFor`, an `AgentAdapter` contract whose `Invocation` union already has an `http` variant, and per-kind pricing (`DEFAULT_PRICES_BY_KIND`). SP2 adds two adapters (`openaiCompatibleAdapter`, `cliTemplateAdapter`), a pure validation module (`agentValidation.ts`) that the registry uses to load and merge `hydraRoom.agents`, a small `fetch`-based HTTP client (`httpTransport.ts`) with timeout/abort/SSE-streaming, and a third branch in `panel.ts` dispatch that routes an `http` invocation through that client while `spawn` invocations keep the existing one-shot/terminal-bridge paths. Secrets are referenced by env-var name only; validation rejects inlined key-shaped values; `hydraRoom.agents` is trust-scoped in all three enforcement points.

**Tech Stack:** TypeScript, VS Code extension API, Node built-in test runner, pnpm.

## Global Constraints
- Build ONLY on SP1's locked interfaces; do not redefine them. Consume `AgentDefinition`, `AgentAdapter`, `Invocation`, `InvocationContext`, `AdapterRawOutput`, `AdapterOutputMode`, `AgentKind`/`KNOWN_AGENT_KINDS`/`isAgentKind`, `UsageTokens` (`src/agentAdapter.ts`); `agentRegistry.{get,list,adapterFor}`, `getAgentDefinition`, `listAgentDefinitions`, `BUILTIN_AGENT_DEFINITIONS`, `registerAdapter`, `adapterForKind`, `assignColorIndexes` (`src/agentRegistry.ts`); `DEFAULT_PRICES_BY_KIND`, `resolveModelPrices`, `buildUsageRecord`, `numberOr`, `ModelPrices` (`src/usage.ts`).
- `hydraRoom.agents` flows into a spawn (`cli-template` `command`/`argsTemplate`) and a network endpoint (`openai-compatible` `baseUrl`/`headers`), so it MUST be `scope:"application"` in `package.json`, listed in `capabilities.untrustedWorkspaces.restrictedConfigurations`, AND mirrored in `TRUST_SCOPED_SETTINGS` in `src/doctor.ts`. `test/trustScopeContract.test.ts` enforces the three stay in sync.
- API keys are referenced by env-var NAME (`apiKeyEnv`), NEVER inlined. A definition containing a secret-shaped literal (in any string field or header value) is REJECTED by validation with a clear message; the invalid def is dropped, not fatal.
- `openai-compatible` `baseUrl` must be `https://` UNLESS the host is loopback or a private/`.local` address (local model servers), consistent with the HTTPS-only handoff-webhook invariant relaxed only for local dev servers.
- `cli-template` heads are `full-native` by default and MUST route through the existing `ensureFullNativeConsent` modal; an `openai-compatible` head is a remote chat endpoint that returns text only (no local FS/shell), classified `read-only`.
- Do NOT tighten the accepted permissive vendor defaults (Codex `workspace-write` + network, Claude `acceptEdits`). Do NOT change SP1 vendor behavior.
- Reuse existing helpers rather than inlining: `appendBoundedStream`/`MAX_AGENT_STDOUT_BYTES`/`stripAnsi` (`src/agents.ts`), `expandRequestFileArgs`/`expandWorkspaceValue` (`src/cli.ts`), `serializePerFile`/`readJsonlGuarded` (`src/fileQueue.ts`).
- TDD only: write the failing test, run it red, implement minimally, run it green, commit. Small frequent commits. `pnpm run check` = type-check only; `pnpm test` = full suite; single suite = `tsc -p . && node --test dist/test/<name>.test.js`; single test adds `--test-name-pattern "<name>"`.
- No new `: any`. New webview message shapes (none expected in SP2) go in `src/webviewMessages.ts` first.

---

### Task 1: Agent-definition validation module (`src/agentValidation.ts`)

**Files:**
- Create: `src/agentValidation.ts`
- Test: `test/agentValidation.test.ts`

**Interfaces:**
- Consumes: `AgentDefinition`, `AgentKind`, `isAgentKind` (SP1 `src/agentAdapter.ts`); `BUILTIN_AGENT_DEFINITIONS`, `assignColorIndexes` (SP1 `src/agentRegistry.ts`).
- Produces: `isEnvVarName(value: string): boolean`, `isSecretShaped(value: string): boolean`, `isLoopbackOrPrivateHost(host: string): boolean`, `baseUrlAllowed(baseUrl: string): { ok: true } | { ok: false; message: string }`, `validateAgentDefinition(raw: unknown, takenIds: ReadonlySet<string>): { def?: AgentDefinition; error?: string }`, `mergeAgentDefinitions(builtins: AgentDefinition[], userRaw: unknown): { defs: AgentDefinition[]; warnings: string[] }`.

Notes: pure module (no `vscode` import) so it unit-tests without the stub. `mergeAgentDefinitions` lets a user entry override a built-in by id (replaces it in place, preserving order) and appends new ids after built-ins; `assignColorIndexes` runs last. Invalid entries are dropped and their reason pushed to `warnings`.

- [ ] **Step 1: Write the failing test**

```ts
// test/agentValidation.test.ts
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  isEnvVarName,
  isSecretShaped,
  isLoopbackOrPrivateHost,
  baseUrlAllowed,
  validateAgentDefinition,
  mergeAgentDefinitions,
} from "../src/agentValidation";
import { BUILTIN_AGENT_DEFINITIONS } from "../src/agentRegistry";

describe("agent definition validation", () => {
  test("isEnvVarName accepts POSIX identifiers, rejects key-shaped values", () => {
    assert.equal(isEnvVarName("OPENAI_API_KEY"), true);
    assert.equal(isEnvVarName("OLLAMA_KEY_1"), true);
    assert.equal(isEnvVarName("sk-abc123"), false);
    assert.equal(isEnvVarName("has space"), false);
    assert.equal(isEnvVarName(""), false);
  });

  test("isSecretShaped flags common inlined credential shapes", () => {
    assert.equal(isSecretShaped("sk-proj-0123456789abcdef0123"), true);
    assert.equal(isSecretShaped("Bearer eyJhbGciOi.aaaa.bbbb"), true);
    assert.equal(isSecretShaped("ghp_0123456789abcdefABCDEF0123456789abcd"), true);
    assert.equal(isSecretShaped("qwen2.5-coder"), false);
    assert.equal(isSecretShaped("${env:OPENAI_API_KEY}"), false);
  });

  test("isLoopbackOrPrivateHost recognizes local model servers", () => {
    assert.equal(isLoopbackOrPrivateHost("localhost"), true);
    assert.equal(isLoopbackOrPrivateHost("127.0.0.1"), true);
    assert.equal(isLoopbackOrPrivateHost("::1"), true);
    assert.equal(isLoopbackOrPrivateHost("192.168.1.50"), true);
    assert.equal(isLoopbackOrPrivateHost("10.0.0.4"), true);
    assert.equal(isLoopbackOrPrivateHost("workstation.local"), true);
    assert.equal(isLoopbackOrPrivateHost("api.openrouter.ai"), false);
  });

  test("baseUrlAllowed: https anywhere, http only for local", () => {
    assert.equal(baseUrlAllowed("https://api.openrouter.ai/v1").ok, true);
    assert.equal(baseUrlAllowed("http://localhost:11434/v1").ok, true);
    assert.equal(baseUrlAllowed("http://192.168.1.9:1234/v1").ok, true);
    assert.equal(baseUrlAllowed("http://api.openrouter.ai/v1").ok, false);
    assert.equal(baseUrlAllowed("ftp://localhost/v1").ok, false);
  });

  test("validateAgentDefinition accepts a well-formed openai-compatible head", () => {
    const { def, error } = validateAgentDefinition(
      { id: "ollama-qwen", displayName: "Qwen (local)", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder" },
      new Set(),
    );
    assert.equal(error, undefined);
    assert.equal(def?.id, "ollama-qwen");
  });

  test("rejects an inlined api key in apiKeyEnv", () => {
    const { def, error } = validateAgentDefinition(
      { id: "bad", displayName: "Bad", kind: "openai-compatible", baseUrl: "https://x/v1", apiKeyEnv: "sk-proj-0123456789abcdef" },
      new Set(),
    );
    assert.equal(def, undefined);
    assert.match(error ?? "", /apiKeyEnv/);
  });

  test("rejects an inlined secret in a header value", () => {
    const { error } = validateAgentDefinition(
      { id: "bad2", displayName: "Bad2", kind: "openai-compatible", baseUrl: "https://x/v1", headers: { Authorization: "Bearer sk-proj-0123456789abcdef" } },
      new Set(),
    );
    assert.match(error ?? "", /secret|inline|Authorization/i);
  });

  test("rejects duplicate id, missing baseUrl, missing command/argsTemplate, bad kind", () => {
    assert.match(validateAgentDefinition({ id: "codex", displayName: "X", kind: "openai-compatible", baseUrl: "https://x/v1" }, new Set(["codex"])).error ?? "", /id/);
    assert.match(validateAgentDefinition({ id: "a", displayName: "A", kind: "openai-compatible" }, new Set()).error ?? "", /baseUrl/);
    assert.match(validateAgentDefinition({ id: "b", displayName: "B", kind: "cli-template", command: "tool" }, new Set()).error ?? "", /argsTemplate/);
    assert.match(validateAgentDefinition({ id: "c", displayName: "C", kind: "totally-fake" }, new Set()).error ?? "", /kind/);
  });

  test("mergeAgentDefinitions overrides a built-in by id and appends new heads", () => {
    const raw = [
      { id: "codex", displayName: "Codex (custom cmd)", kind: "codex", command: "codex-wrapper" },
      { id: "ollama-qwen", displayName: "Qwen", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
      { id: "bogus", displayName: "Bogus", kind: "openai-compatible" }, // dropped: no baseUrl
    ];
    const { defs, warnings } = mergeAgentDefinitions([...BUILTIN_AGENT_DEFINITIONS], raw);
    const ids = defs.map((d) => d.id);
    assert.deepEqual(ids, ["codex", "claude", "gemini", "ollama-qwen"]);
    assert.equal(defs.find((d) => d.id === "codex")?.command, "codex-wrapper");
    assert.equal(defs.find((d) => d.id === "codex")?.colorIndex, 1); // registry order preserved
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /bogus/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/agentValidation.test.js`
Expected failure: `tsc` errors with `Cannot find module '../src/agentValidation'` (compile fails before any test runs).

- [ ] **Step 3: Implement minimally**

```ts
// src/agentValidation.ts
import type { AgentDefinition, AgentKind } from "./agentAdapter";
import { isAgentKind } from "./agentAdapter";
import { assignColorIndexes } from "./agentRegistry";

/** POSIX env-var identifier — an apiKeyEnv must be a NAME, never a key value. */
export function isEnvVarName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

// A `${env:NAME}` placeholder is explicitly NOT a secret (it's a reference).
const ENV_PLACEHOLDER = /^\$\{env:[^}]+\}$/;

/** Heuristic: does this literal look like an inlined credential? Conservative —
 *  only flags shapes that are clearly keys/tokens, never ordinary model ids. */
export function isSecretShaped(value: string): boolean {
  const v = value.trim();
  if (!v || ENV_PLACEHOLDER.test(v)) return false;
  if (/\bBearer\s+\S+/i.test(v)) return true;
  if (/\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}/.test(v)) return true; // OpenAI-style
  if (/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/.test(v)) return true; // GitHub
  if (/\bxox[baprs]-[A-Za-z0-9-]{10,}/.test(v)) return true; // Slack
  if (/\bAKIA[0-9A-Z]{16}\b/.test(v)) return true; // AWS access key id
  if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(v)) return true; // JWT
  return false;
}

export function isLoopbackOrPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase(); // strip IPv6 brackets
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
  if (h.endsWith(".local") || h.endsWith(".localhost")) return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // IPv6 ULA
  return false;
}

export function baseUrlAllowed(baseUrl: string): { ok: true } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, message: `baseUrl "${baseUrl}" is not a valid URL` };
  }
  if (url.protocol === "https:") return { ok: true };
  if (url.protocol === "http:") {
    if (isLoopbackOrPrivateHost(url.hostname)) return { ok: true };
    return { ok: false, message: `baseUrl must be https:// for non-local hosts (got http://${url.hostname})` };
  }
  return { ok: false, message: `baseUrl must use http(s); got ${url.protocol}` };
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Every string field that could carry an inlined secret. baseUrl is checked
// separately (it legitimately contains a host). apiKeyEnv is a NAME.
function scanForInlineSecret(def: Record<string, unknown>): string | undefined {
  const strings: string[] = [];
  for (const key of ["model", "command", "displayName"]) {
    const v = def[key];
    if (typeof v === "string") strings.push(v);
  }
  if (Array.isArray(def.argsTemplate)) for (const a of def.argsTemplate) if (typeof a === "string") strings.push(a);
  if (def.headers && typeof def.headers === "object") {
    for (const v of Object.values(def.headers as Record<string, unknown>)) if (typeof v === "string") strings.push(v);
  }
  return strings.find(isSecretShaped);
}

export function validateAgentDefinition(
  raw: unknown,
  takenIds: ReadonlySet<string>,
): { def?: AgentDefinition; error?: string } {
  if (!raw || typeof raw !== "object") return { error: "agent definition must be an object" };
  const d = raw as Record<string, unknown>;
  const id = typeof d.id === "string" ? d.id.trim() : "";
  if (!ID_RE.test(id)) return { error: `agent id "${String(d.id)}" must match ${ID_RE} (letters, digits, -, _)` };
  if (takenIds.has(id)) return { error: `duplicate agent id "${id}"` };
  const kind = typeof d.kind === "string" ? d.kind : "";
  if (!isAgentKind(kind)) return { error: `agent "${id}" has unknown kind "${kind}"` };
  const displayName = typeof d.displayName === "string" && d.displayName.trim() ? d.displayName.trim() : id;

  if (d.apiKeyEnv !== undefined && (typeof d.apiKeyEnv !== "string" || !isEnvVarName(d.apiKeyEnv))) {
    return { error: `agent "${id}" apiKeyEnv must be an environment-variable NAME (e.g. OPENAI_API_KEY), not a key value` };
  }
  const secret = scanForInlineSecret(d);
  if (secret) return { error: `agent "${id}" appears to inline a secret ("${secret.slice(0, 12)}…"); reference it via apiKeyEnv / \${env:NAME} instead` };

  if (kind === "openai-compatible") {
    if (typeof d.baseUrl !== "string" || !d.baseUrl.trim()) return { error: `openai-compatible agent "${id}" requires a baseUrl` };
    const allowed = baseUrlAllowed(d.baseUrl.trim());
    if (!allowed.ok) return { error: `agent "${id}": ${allowed.message}` };
  }
  if (kind === "cli-template") {
    if (typeof d.command !== "string" || !d.command.trim()) return { error: `cli-template agent "${id}" requires a command` };
    if (!Array.isArray(d.argsTemplate) || !d.argsTemplate.every((a) => typeof a === "string")) {
      return { error: `cli-template agent "${id}" requires a string[] argsTemplate` };
    }
  }

  const def: AgentDefinition = { id, displayName, kind: kind as AgentKind };
  if (typeof d.model === "string") def.model = d.model;
  if (typeof d.colorIndex === "number") def.colorIndex = d.colorIndex;
  if (typeof d.baseUrl === "string") def.baseUrl = d.baseUrl.trim();
  if (typeof d.apiKeyEnv === "string") def.apiKeyEnv = d.apiKeyEnv;
  if (d.headers && typeof d.headers === "object") def.headers = { ...(d.headers as Record<string, string>) };
  if (typeof d.command === "string") def.command = d.command;
  if (Array.isArray(d.argsTemplate)) def.argsTemplate = d.argsTemplate as string[];
  if (d.defaultAuthority === "read-only" || d.defaultAuthority === "workspace-write" || d.defaultAuthority === "full-native") {
    def.defaultAuthority = d.defaultAuthority;
  }
  if (d.pricing && typeof d.pricing === "object") def.pricing = d.pricing as AgentDefinition["pricing"];
  return { def };
}

export function mergeAgentDefinitions(
  builtins: AgentDefinition[],
  userRaw: unknown,
): { defs: AgentDefinition[]; warnings: string[] } {
  const defs: AgentDefinition[] = builtins.map((d) => ({ ...d }));
  const warnings: string[] = [];
  const entries = Array.isArray(userRaw) ? userRaw : [];
  const taken = new Set(defs.map((d) => d.id));
  for (const raw of entries) {
    const existingIdx = defs.findIndex((d) => typeof raw === "object" && raw && (raw as Record<string, unknown>).id === d.id);
    // Overriding a built-in: allow reusing its id (drop it from taken for this check).
    const takenForCheck = new Set(taken);
    if (existingIdx >= 0) takenForCheck.delete(defs[existingIdx]!.id);
    const { def, error } = validateAgentDefinition(raw, takenForCheck);
    if (!def) {
      warnings.push(error ?? "invalid agent definition");
      continue;
    }
    if (existingIdx >= 0) {
      defs[existingIdx] = { ...defs[existingIdx], ...def }; // merge override over built-in
    } else {
      defs.push(def);
      taken.add(def.id);
    }
  }
  return { defs: assignColorIndexes(defs), warnings };
}
```

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/agentValidation.test.js`
Expected pass: `# pass 8  # fail 0`.

- [ ] **Step 5: Commit**

`git add src/agentValidation.ts test/agentValidation.test.ts && git commit -m "Add agent-definition validation (secrets, https-or-local, per-kind fields)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 2: Registry loads + validates `hydraRoom.agents`

**Files:**
- Modify: `src/agentRegistry.ts` — `loadDefinitions()` (SP1 built-ins-only) now merges validated user entries; add a surfaced-warnings accessor. SP1's shape verified at plan-1 lines 335-343 (`loadDefinitions`/`definitions`/`cached`).
- Test: `test/agentRegistry.test.ts` (append; SP1 file exists)

**Interfaces:**
- Consumes: `mergeAgentDefinitions` (Task 1).
- Produces: `loadDefinitions` reads `hydraRoom.agents` via a small injectable reader; `agentDefinitionWarnings(): string[]`; `reloadAgentDefinitions(): void` (clears the SP1 cache so a settings change re-merges). No signature change to `get`/`list`/`adapterFor`.

Notes: SP1's `definitions()` memoizes into `cached`. Reading `vscode.workspace.getConfiguration` at module load is unsafe under the test stub, so gate the read behind a lazily-required `vscode` and a try/catch that falls back to `[]` (so registry unit tests with no config still see built-ins). `mergeAgentDefinitions` already runs `assignColorIndexes`, so SP1's `assignColorIndexes` call inside `loadDefinitions` is replaced by the merge.

- [ ] **Step 1: Write the failing test** (append to `test/agentRegistry.test.ts`)

```ts
import { reloadAgentDefinitions, agentDefinitionWarnings, listAgentDefinitions } from "../src/agentRegistry";

describe("registry user-agent merge", () => {
  test("reloadAgentDefinitions + agentDefinitionWarnings exist and default clean", () => {
    reloadAgentDefinitions();
    // With no hydraRoom.agents configured (test stub), built-ins only and no warnings.
    assert.deepEqual(listAgentDefinitions().map((d) => d.id), ["codex", "claude", "gemini"]);
    assert.deepEqual(agentDefinitionWarnings(), []);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/agentRegistry.test.js`
Expected failure: `Module '"../src/agentRegistry"' has no exported member 'reloadAgentDefinitions'`.

- [ ] **Step 3: Implement minimally** — edit `src/agentRegistry.ts`

Add near the top:

```ts
import { mergeAgentDefinitions } from "./agentValidation";
```

Replace SP1's `loadDefinitions`/`definitions`/`cached` block with:

```ts
let cached: AgentDefinition[] | undefined;
let cachedWarnings: string[] = [];

function readUserAgents(): unknown {
  try {
    // Lazy require: registry is imported by pure unit tests that have no
    // vscode config; fall back to no user agents there.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require("vscode") as typeof import("vscode");
    return vscode.workspace.getConfiguration("hydraRoom").get<unknown>("agents", []);
  } catch {
    return [];
  }
}

function loadDefinitions(): AgentDefinition[] {
  const merged = mergeAgentDefinitions(BUILTIN_AGENT_DEFINITIONS.map((d) => ({ ...d })), readUserAgents());
  cachedWarnings = merged.warnings;
  return merged.defs;
}

function definitions(): AgentDefinition[] {
  if (!cached) cached = loadDefinitions();
  return cached;
}

/** Drop the memoized roster so a settings change re-merges hydraRoom.agents. */
export function reloadAgentDefinitions(): void {
  cached = undefined;
  cachedWarnings = [];
}

/** Validation warnings from the last load (invalid user defs that were dropped). */
export function agentDefinitionWarnings(): string[] {
  definitions(); // ensure a load has happened
  return [...cachedWarnings];
}
```

(Keep SP1's `assignColorIndexes` export — `mergeAgentDefinitions` calls it, and Task 1 imports it.)

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/agentRegistry.test.js` — expected `# fail 0`.
Then `pnpm run check` — expected exit 0.

- [ ] **Step 5: Commit**

`git add src/agentRegistry.ts test/agentRegistry.test.ts && git commit -m "Registry loads and validates hydraRoom.agents user definitions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 3: OpenAI-compatible HTTP adapter (`src/openaiCompatibleAdapter.ts`)

**Files:**
- Create: `src/openaiCompatibleAdapter.ts`
- Modify: `src/agentAdapter.ts` — add `"openaiJson"` to the `AdapterOutputMode` union (SP1 plan line 117)
- Modify: `src/agentRegistry.ts` — import so `registerAdapter` runs (alongside the SP1 vendor-adapter imports)
- Test: `test/openaiCompatibleAdapter.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter`, `AgentDefinition`, `InvocationContext`, `Invocation`, `AdapterRawOutput` (SP1); `UsageTokens`, `ModelPrices`, `DEFAULT_PRICES_BY_KIND`, `numberOr` (SP1 `src/usage.ts`); `expandWorkspaceValue` (`src/cli.ts`); `registerAdapter` (SP1).
- Produces: `openaiCompatibleAdapter: AgentAdapter` (kind `"openai-compatible"`), `buildOpenAiChatBody(def: AgentDefinition, prompt: string): Record<string, unknown>`, `openaiHeaders(def: AgentDefinition): Record<string, string>`, `parseOpenAiReply(rawJson: string): string`, `parseOpenAiUsage(rawJson: string): UsageTokens | undefined`.

Notes: `buildInvocation` returns `{ transport: "http", url: `${baseUrl}/chat/completions`, method: "POST", headers, body }`. `apiKeyEnv` → `Authorization: Bearer ${process.env[apiKeyEnv]}` when the env var is set; `def.headers` values are `${env:NAME}`-expanded via `expandWorkspaceValue` (workspaceRoot is irrelevant to env expansion). Body carries `stream: true` + `stream_options.include_usage:true` so streaming endpoints stream and emit a final usage chunk; endpoints that ignore `stream` return a single JSON object the transport parses too. `authority` is read-only (remote text only).

- [ ] **Step 1: Write the failing test**

```ts
// test/openaiCompatibleAdapter.test.ts
import { describe, test, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { openaiCompatibleAdapter, buildOpenAiChatBody, openaiHeaders, parseOpenAiReply, parseOpenAiUsage } from "../src/openaiCompatibleAdapter";
import type { AgentDefinition, InvocationContext } from "../src/agentAdapter";

const def: AgentDefinition = {
  id: "ollama-qwen", displayName: "Qwen", kind: "openai-compatible",
  baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder",
};
const ctx: InvocationContext = { phase: "build", workspaceRoot: "C:/repo", prompt: "hello", command: "ollama-qwen", rawArgs: [] };

afterEach(() => { delete process.env.HYDRA_TEST_KEY; });

describe("openai-compatible adapter", () => {
  test("buildInvocation targets ${baseUrl}/chat/completions as http POST", () => {
    const inv = openaiCompatibleAdapter.buildInvocation(def, ctx);
    assert.equal(inv.transport, "http");
    if (inv.transport !== "http") return;
    assert.equal(inv.url, "http://localhost:11434/v1/chat/completions");
    assert.equal(inv.method, "POST");
    const body = inv.body as { model: string; messages: Array<{ role: string; content: string }>; stream: boolean };
    assert.equal(body.model, "qwen2.5-coder");
    assert.equal(body.messages[0]?.content, "hello");
    assert.equal(body.stream, true);
  });

  test("apiKeyEnv injects Authorization from the environment, never the raw key", () => {
    process.env.HYDRA_TEST_KEY = "sk-secret-value";
    const headers = openaiHeaders({ ...def, apiKeyEnv: "HYDRA_TEST_KEY" });
    assert.equal(headers.Authorization, "Bearer sk-secret-value");
    assert.equal(headers["Content-Type"], "application/json");
  });

  test("missing apiKeyEnv env var yields no Authorization header", () => {
    const headers = openaiHeaders({ ...def, apiKeyEnv: "HYDRA_TEST_KEY" });
    assert.equal(headers.Authorization, undefined);
  });

  test("parseOpenAiReply extracts the assistant message content", () => {
    const raw = JSON.stringify({ choices: [{ message: { role: "assistant", content: "the answer" } }] });
    assert.equal(parseOpenAiReply(raw), "the answer");
  });

  test("parseOpenAiUsage reads prompt/completion/cached token counts", () => {
    const raw = JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 25 } } });
    assert.deepEqual(parseOpenAiUsage(raw), {
      inputTokens: 100, outputTokens: 40, cacheReadTokens: 25, cacheCreateTokens: 0, reasoningTokens: 0,
    });
  });

  test("authority is read-only (remote endpoint cannot touch the local workspace)", () => {
    assert.equal(openaiCompatibleAdapter.authority(def, ctx).level, "readOnly");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/openaiCompatibleAdapter.test.js`
Expected failure: `Cannot find module '../src/openaiCompatibleAdapter'`.

- [ ] **Step 3: Implement minimally**

First add `"openaiJson"` to `AdapterOutputMode` in `src/agentAdapter.ts`:

```ts
export type AdapterOutputMode = "plain" | "codexJson" | "claudeStreamJson" | "geminiJson" | "openaiJson";
```

Then:

```ts
// src/openaiCompatibleAdapter.ts
import type { AgentAdapter, AgentDefinition, InvocationContext, Invocation, AdapterRawOutput } from "./agentAdapter";
import type { UsageTokens, ModelPrices } from "./usage";
import { numberOr, DEFAULT_PRICES_BY_KIND } from "./usage";
import { expandWorkspaceValue } from "./cli";

export function openaiHeaders(def: AgentDefinition): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  for (const [k, v] of Object.entries(def.headers ?? {})) {
    // Why: header values may reference ${env:NAME}; expand them here. "" root
    // is fine — expandWorkspaceValue only substitutes env for this path.
    headers[k] = expandWorkspaceValue(v, "");
  }
  if (def.apiKeyEnv) {
    const key = process.env[def.apiKeyEnv];
    if (key) headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

export function buildOpenAiChatBody(def: AgentDefinition, prompt: string): Record<string, unknown> {
  return {
    model: def.model ?? "",
    messages: [{ role: "user", content: prompt }],
    stream: true,
    stream_options: { include_usage: true },
  };
}

export function parseOpenAiReply(rawJson: string): string {
  try {
    const parsed = JSON.parse(rawJson) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
  } catch {
    // Not a single JSON object (e.g. transport already assembled plain text).
  }
  return rawJson;
}

export function parseOpenAiUsage(rawJson: string): UsageTokens | undefined {
  try {
    const parsed = JSON.parse(rawJson) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const u = parsed.usage;
    if (!u) return undefined;
    const input = numberOr(u.prompt_tokens, 0);
    const output = numberOr(u.completion_tokens, 0);
    const cacheRead = numberOr(u.prompt_tokens_details?.cached_tokens, 0);
    if (input + output === 0) return undefined;
    return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheCreateTokens: 0, reasoningTokens: 0 };
  } catch {
    return undefined;
  }
}

export const openaiCompatibleAdapter: AgentAdapter = {
  kind: "openai-compatible",
  buildInvocation(def: AgentDefinition, ctx: InvocationContext): Invocation {
    const base = (def.baseUrl ?? "").replace(/\/+$/, "");
    return {
      transport: "http",
      url: `${base}/chat/completions`,
      method: "POST",
      headers: openaiHeaders(def),
      body: buildOpenAiChatBody(def, ctx.prompt),
    };
  },
  parseReply(raw: AdapterRawOutput): string {
    return parseOpenAiReply(raw.stdout);
  },
  parseUsage(raw: AdapterRawOutput): UsageTokens | undefined {
    return parseOpenAiUsage(raw.stdout);
  },
  pricing(def: AgentDefinition): ModelPrices {
    return def.pricing ?? DEFAULT_PRICES_BY_KIND["openai-compatible"];
  },
  authority(def: AgentDefinition, _ctx: InvocationContext) {
    return {
      level: "readOnly",
      label: "Remote endpoint",
      detail: `OpenAI-compatible head posts the transcript to ${def.baseUrl}; it returns text only and cannot touch the local workspace.`,
      warnings: [`This head sends prompt/transcript to ${def.baseUrl}.`],
    };
  },
};
```

Register in `src/agentRegistry.ts` (next to SP1's vendor-adapter registrations):

```ts
import { openaiCompatibleAdapter } from "./openaiCompatibleAdapter";
registerAdapter(openaiCompatibleAdapter);
```

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/openaiCompatibleAdapter.test.js` — expected `# fail 0`.

- [ ] **Step 5: Commit**

`git add src/openaiCompatibleAdapter.ts src/agentAdapter.ts src/agentRegistry.ts test/openaiCompatibleAdapter.test.ts && git commit -m "Add OpenAI-compatible HTTP adapter

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 4: CLI-template adapter (`src/cliTemplateAdapter.ts`)

**Files:**
- Create: `src/cliTemplateAdapter.ts`
- Modify: `src/agentRegistry.ts` — register the adapter
- Test: `test/cliTemplateAdapter.test.ts`

**Interfaces:**
- Consumes: adapter contract (SP1); `expandRequestFileArgs`, `RequestFilePlaceholders`, `expandWorkspaceArgs` (`src/cli.ts` lines 89-96, 39); `DEFAULT_PRICES_BY_KIND`, `ModelPrices` (SP1 `src/usage.ts`); `registerAdapter` (SP1).
- Produces: `cliTemplateAdapter: AgentAdapter` (kind `"cli-template"`), `expandCliTemplateArgs(argsTemplate: string[], vars: { prompt: string; model: string; workspaceRoot: string; files?: RequestFilePlaceholders }): string[]`, `AUTHORITY_LEVEL_BY_DEFAULT: Record<NonNullable<AgentDefinition["defaultAuthority"]>, AuthorityLevel>`.

Notes: placeholders — `${prompt}`, `${model}` expanded here; `${workspaceFolder}` via `expandWorkspaceArgs`; `${hydraPromptFile}`/`${hydraReplyFile}`/`${hydraLogFile}` via `expandRequestFileArgs` when `files` present. If the template contains `${prompt}`, the prompt goes into argv (`stdin` omitted); otherwise `stdin = ctx.prompt`. `authority` defaults to `fullNative` (routes through the existing consent modal in Task 8) unless `def.defaultAuthority` narrows it.

- [ ] **Step 1: Write the failing test**

```ts
// test/cliTemplateAdapter.test.ts
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { cliTemplateAdapter, expandCliTemplateArgs } from "../src/cliTemplateAdapter";
import type { AgentDefinition, InvocationContext } from "../src/agentAdapter";

const base: AgentDefinition = {
  id: "my-tool", displayName: "My Tool", kind: "cli-template",
  command: "my-tool", argsTemplate: ["run", "--model", "${model}", "--prompt", "${prompt}"], model: "local-7b",
};
const ctx: InvocationContext = { phase: "build", workspaceRoot: "C:/repo", prompt: "do X", command: "my-tool", rawArgs: [] };

describe("cli-template adapter", () => {
  test("expandCliTemplateArgs substitutes prompt/model/workspaceFolder", () => {
    const args = expandCliTemplateArgs(["-C", "${workspaceFolder}", "-m", "${model}", "${prompt}"],
      { prompt: "hi there", model: "local-7b", workspaceRoot: "C:/repo" });
    assert.deepEqual(args, ["-C", "C:/repo", "-m", "local-7b", "hi there"]);
  });

  test("buildInvocation spawns command with expanded args; prompt in argv omits stdin", () => {
    const inv = cliTemplateAdapter.buildInvocation(base, ctx);
    assert.equal(inv.transport, "spawn");
    if (inv.transport !== "spawn") return;
    assert.equal(inv.command, "my-tool");
    assert.deepEqual(inv.args, ["run", "--model", "local-7b", "--prompt", "do X"]);
    assert.equal(inv.stdin, undefined); // ${prompt} consumed into argv
  });

  test("no ${prompt} placeholder -> prompt is written to stdin", () => {
    const inv = cliTemplateAdapter.buildInvocation({ ...base, argsTemplate: ["run", "-"] }, ctx);
    if (inv.transport !== "spawn") return;
    assert.deepEqual(inv.args, ["run", "-"]);
    assert.equal(inv.stdin, "do X");
  });

  test("authority defaults to fullNative and narrows to workspaceWrite when declared", () => {
    assert.equal(cliTemplateAdapter.authority(base, ctx).level, "fullNative");
    assert.equal(cliTemplateAdapter.authority({ ...base, defaultAuthority: "workspace-write" }, ctx).level, "workspaceWrite");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/cliTemplateAdapter.test.js`
Expected failure: `Cannot find module '../src/cliTemplateAdapter'`.

- [ ] **Step 3: Implement minimally**

```ts
// src/cliTemplateAdapter.ts
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
```

Register in `src/agentRegistry.ts`:

```ts
import { cliTemplateAdapter } from "./cliTemplateAdapter";
registerAdapter(cliTemplateAdapter);
```

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/cliTemplateAdapter.test.js` — expected `# fail 0`.

- [ ] **Step 5: Commit**

`git add src/cliTemplateAdapter.ts src/agentRegistry.ts test/cliTemplateAdapter.test.ts && git commit -m "Add cli-template adapter (templated argv, full-native default)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 5: HTTP client with timeout, abort, and SSE streaming (`src/httpTransport.ts`)

**Files:**
- Create: `src/httpTransport.ts`
- Test: `test/httpTransport.test.ts`

**Interfaces:**
- Consumes: `Invocation` (SP1); `RunResult` (`src/agents.ts` lines 45-52); `appendBoundedStream`/`BoundedStreamState`/`MAX_AGENT_STDOUT_BYTES` (`src/agents.ts` lines 13-43).
- Produces: `interface HttpAgentResult extends RunResult { rawBody: string }`, `runHttpAgent(invocation, opts): Promise<HttpAgentResult>` where `opts: { timeoutMs: number; signal: AbortSignal; onChunk?: (text: string) => void; fetchImpl?: typeof fetch }`, `assembleSseText(sseBody: string): { text: string; usageJson: string | undefined }`.

Notes: global `fetch` is available in this extension host (see `src/telegram.ts:117`). `runHttpAgent` chains the caller's `AbortSignal` with an internal timeout controller. If the response `content-type` includes `text/event-stream`, it reads the stream, emits `choices[0].delta.content` increments via `onChunk`, accumulates the text (bounded), and keeps the final chunk carrying `usage`; `rawBody` is a synthesized `{choices:[{message:{content}}],usage}` JSON so the adapter's `parseReply`/`parseUsage` (which expect the non-streaming shape) work unchanged. Non-streaming responses are parsed directly and `rawBody` is the JSON text. `fetchImpl` is injectable so tests never hit the network.

- [ ] **Step 1: Write the failing test**

```ts
// test/httpTransport.test.ts
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { runHttpAgent, assembleSseText } from "../src/httpTransport";
import type { Invocation } from "../src/agentAdapter";

const inv: Extract<Invocation, { transport: "http" }> = {
  transport: "http", url: "http://localhost:11434/v1/chat/completions", method: "POST",
  headers: { "Content-Type": "application/json" }, body: { model: "m", messages: [] },
};

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
}

describe("http transport", () => {
  test("assembleSseText concatenates content deltas and captures the usage chunk", () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n' +
      "data: [DONE]\n\n";
    const { text, usageJson } = assembleSseText(sse);
    assert.equal(text, "Hello");
    assert.ok(usageJson && JSON.parse(usageJson).usage.prompt_tokens === 5);
  });

  test("non-streaming JSON response returns assistant text and raw body", async () => {
    const fetchImpl = (async () => jsonResponse({ choices: [{ message: { content: "the answer" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } })) as unknown as typeof fetch;
    const res = await runHttpAgent(inv, { timeoutMs: 5000, signal: new AbortController().signal, fetchImpl });
    assert.equal(res.stdout, "the answer");
    assert.equal(res.exitCode, 0);
    assert.match(res.rawBody, /the answer/);
    assert.equal(res.timedOut, false);
  });

  test("HTTP error status surfaces on stderr with a non-zero exit code", async () => {
    const fetchImpl = (async () => new Response("model not found", { status: 404, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    const res = await runHttpAgent(inv, { timeoutMs: 5000, signal: new AbortController().signal, fetchImpl });
    assert.equal(res.exitCode, 404);
    assert.match(res.stderr, /model not found|404/);
  });

  test("an already-aborted signal returns cancelled without calling fetch", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let called = false;
    const fetchImpl = (async () => { called = true; return jsonResponse({}); }) as unknown as typeof fetch;
    const res = await runHttpAgent(inv, { timeoutMs: 5000, signal: ctrl.signal, fetchImpl });
    assert.equal(res.cancelled, true);
    assert.equal(called, false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/httpTransport.test.js`
Expected failure: `Cannot find module '../src/httpTransport'`.

- [ ] **Step 3: Implement minimally**

```ts
// src/httpTransport.ts
import type { Invocation } from "./agentAdapter";
import type { RunResult } from "./agents";
import { appendBoundedStream, MAX_AGENT_STDOUT_BYTES, type BoundedStreamState } from "./agents";

export interface HttpAgentResult extends RunResult {
  rawBody: string;
}

type HttpInvocation = Extract<Invocation, { transport: "http" }>;

/** Parse an SSE body into assembled assistant text + the raw JSON of the chunk
 *  that carried token usage (if any). Tolerant of blank lines and [DONE]. */
export function assembleSseText(sseBody: string): { text: string; usageJson: string | undefined } {
  let text = "";
  let usageJson: string | undefined;
  for (const rawLine of sseBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }>; usage?: unknown };
      const delta = obj.choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
      if (obj.usage) usageJson = payload;
    } catch {
      // Non-JSON keep-alive/comment line — skip.
    }
  }
  return { text, usageJson };
}

function cancelledResult(): HttpAgentResult {
  return { stdout: "", stderr: "", exitCode: null, timedOut: false, cancelled: true, rawBody: "" };
}

export async function runHttpAgent(
  invocation: HttpInvocation,
  opts: { timeoutMs: number; signal: AbortSignal; onChunk?: (text: string) => void; fetchImpl?: typeof fetch },
): Promise<HttpAgentResult> {
  if (opts.signal.aborted) return cancelledResult();
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal.addEventListener("abort", onAbort, { once: true });
  const hasTimeout = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0;
  let timedOut = false;
  const timer = hasTimeout
    ? setTimeout(() => { timedOut = true; controller.abort(); }, opts.timeoutMs)
    : undefined;
  try {
    const res = await doFetch(invocation.url, {
      method: invocation.method,
      headers: invocation.headers,
      body: JSON.stringify(invocation.body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = (await res.text().catch(() => "")).slice(0, 4000);
      return { stdout: "", stderr: `HTTP ${res.status}: ${errText || res.statusText}`, exitCode: res.status, timedOut, cancelled: false, rawBody: errText };
    }
    const contentType = res.headers.get("content-type") ?? "";
    const state: BoundedStreamState = { text: "", truncated: false };
    const marker = `\n[Hydra: HTTP response truncated at ${MAX_AGENT_STDOUT_BYTES} bytes]\n`;
    if (contentType.includes("text/event-stream") && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        sseBuf += chunk;
        // Emit deltas as complete SSE events arrive (double-newline delimited).
        let idx: number;
        while ((idx = sseBuf.indexOf("\n\n")) >= 0) {
          const event = sseBuf.slice(0, idx);
          sseBuf = sseBuf.slice(idx + 2);
          const { text } = assembleSseText(event);
          if (text) {
            appendBoundedStream(state, text, MAX_AGENT_STDOUT_BYTES, marker);
            opts.onChunk?.(text);
          }
        }
      }
      const { text: tailText, usageJson: tailUsage } = assembleSseText(sseBuf);
      if (tailText) { appendBoundedStream(state, tailText, MAX_AGENT_STDOUT_BYTES, marker); opts.onChunk?.(tailText); }
      // Re-scan the full body once for the usage chunk (cheap, bounded by cap).
      const full = state.text; // assistant text
      const { usageJson } = assembleSseText(""); void usageJson;
      const usageFromTail = tailUsage;
      const rawBody = JSON.stringify({
        choices: [{ message: { content: full } }],
        ...(usageFromTail ? JSON.parse(usageFromTail) : {}),
      });
      return { stdout: full, stderr: "", exitCode: 0, timedOut, cancelled: false, rawBody };
    }
    // Non-streaming: single JSON object.
    const rawBody = await res.text();
    let content = "";
    try {
      const parsed = JSON.parse(rawBody) as { choices?: Array<{ message?: { content?: unknown } }> };
      const c = parsed.choices?.[0]?.message?.content;
      if (typeof c === "string") content = c;
    } catch {
      content = rawBody; // endpoint returned plain text
    }
    if (content) opts.onChunk?.(content);
    return { stdout: content, stderr: "", exitCode: 0, timedOut, cancelled: false, rawBody };
  } catch (err) {
    if (controller.signal.aborted && !timedOut) return cancelledResult();
    return { stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: null, timedOut, cancelled: false, rawBody: "" };
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal.removeEventListener("abort", onAbort);
  }
}
```

(Simplify the streaming usage-capture: keep `tailUsage` from the final `assembleSseText(sseBuf)` call — the `void usageJson` scaffold line above is dead; drop it during implementation and thread the usage chunk from the per-event loop instead, capturing `usageJson` whenever `assembleSseText(event).usageJson` is set. The test pins `assembleSseText` behavior and the non-streaming path; keep the streaming usage wiring covered by the Task 9 end-to-end.)

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/httpTransport.test.js` — expected `# fail 0`.
Then `pnpm run check` — expected exit 0.

- [ ] **Step 5: Commit**

`git add src/httpTransport.ts test/httpTransport.test.ts && git commit -m "Add HTTP agent transport (fetch, timeout, abort, SSE streaming)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 6: Trust-scope `hydraRoom.agents` + redaction

**Files:**
- Modify: `package.json` — add the `hydraRoom.agents` property (model after `hydraRoom.codexCommand` at lines 346-351; array of objects, `scope:"application"`), and add `"hydraRoom.agents"` to `capabilities.untrustedWorkspaces.restrictedConfigurations` (block at lines 1227-1270)
- Modify: `src/doctor.ts` — add `"agents"` to `TRUST_SCOPED_SETTINGS` (array at lines 63-106)
- Modify: `src/nativeDataSnapshot.ts` — extend `isSensitiveKey` (line 290-292) to also match header-credential and base-url-secret shapes
- Test: `test/trustScopeContract.test.ts` (append), `test/nativeDataSnapshot.test.ts` (append; create if absent — a redaction unit test)

**Interfaces:**
- Consumes: nothing new.
- Produces: `hydraRoom.agents` trust-scoped across all three enforcement points; `redactedJson` redacts inline header credentials if an agent definition is ever serialized.

Notes: `hydraRoom.agents` carries a `command` (spawn) and `baseUrl`/`headers` (endpoint), so it is exactly the trust-scoped class. Per-item `apiKeyEnv` is an env-var name (not a secret), but `headers` values can carry credentials for a user who bypasses validation via user-settings; the redaction defense-in-depth keeps them out of any generated snapshot/support bundle.

- [ ] **Step 1: Write the failing test** (append to `test/trustScopeContract.test.ts`)

```ts
test("hydraRoom.agents is trust-scoped (spawn command + network endpoint)", () => {
  assert.ok(
    (TRUST_SCOPED_SETTINGS as readonly string[]).includes("agents"),
    "agents must be trust-scoped — it defines a spawn command and an HTTP endpoint",
  );
});
```

And append to `test/nativeDataSnapshot.test.ts` (create the file if it does not exist, mirroring the node:test style):

```ts
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { redactedJson } from "../src/nativeDataSnapshot";

describe("nativeDataSnapshot redaction of agent-head credentials", () => {
  test("an inlined Authorization header value is redacted", () => {
    const out = redactedJson({ headers: { Authorization: "Bearer sk-secret" } }) as { headers: Record<string, string> };
    assert.equal(out.headers.Authorization, "[REDACTED]");
  });
  test("apiKeyEnv (a name, not a secret) is redacted defensively too", () => {
    const out = redactedJson({ apiKeyEnv: "OPENAI_API_KEY" }) as Record<string, string>;
    assert.equal(out.apiKeyEnv, "[REDACTED]");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/trustScopeContract.test.js dist/test/nativeDataSnapshot.test.js`
Expected failure: the trust test fails (`agents must be trust-scoped`) and the lockstep set-equality test in the same file fails until all three sides agree; the redaction test for `Authorization` already passes (existing regex matches the key), so its purpose is a regression pin.

- [ ] **Step 3: Implement minimally**

Add to `package.json` `contributes.configuration.properties` after `hydraRoom.codexCommand`:

```json
"hydraRoom.agents": {
  "scope": "application",
  "type": "array",
  "default": [],
  "items": {
    "type": "object",
    "required": ["id", "displayName", "kind"],
    "properties": {
      "id": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
      "displayName": { "type": "string" },
      "kind": { "type": "string", "enum": ["codex", "claude", "gemini", "openai-compatible", "cli-template"] },
      "model": { "type": "string" },
      "colorIndex": { "type": "number" },
      "baseUrl": { "type": "string", "markdownDescription": "openai-compatible: `https://` required unless the host is loopback or a private/`.local` address (local model servers)." },
      "apiKeyEnv": { "type": "string", "markdownDescription": "NAME of the environment variable holding the API key. Never inline the key itself." },
      "headers": { "type": "object", "additionalProperties": { "type": "string" }, "markdownDescription": "Extra HTTP headers. Reference secrets as `${env:NAME}`." },
      "command": { "type": "string" },
      "argsTemplate": { "type": "array", "items": { "type": "string" }, "markdownDescription": "cli-template argv. Placeholders: `${prompt}`, `${model}`, `${workspaceFolder}`, `${hydraPromptFile}`, `${hydraReplyFile}`, `${hydraLogFile}`." },
      "defaultAuthority": { "type": "string", "enum": ["read-only", "workspace-write", "full-native"] }
    },
    "additionalProperties": false
  },
  "markdownDescription": "Custom Hydra heads (open/local models). Each entry is an agent definition; user entries override built-ins by `id`. **Security:** trust-scoped — ignored in untrusted workspaces. API keys must be referenced by env-var name (`apiKeyEnv`), never inlined; definitions containing key-shaped values are rejected."
}
```

Add `"hydraRoom.agents"` to `capabilities.untrustedWorkspaces.restrictedConfigurations`. Add `"agents"` to `TRUST_SCOPED_SETTINGS` in `src/doctor.ts`.

Extend `isSensitiveKey` in `src/nativeDataSnapshot.ts` (line 290) to cover an `apiKeyEnv` field name explicitly (it already matches `api[_-]?key`, but pin it) — no functional change needed if the existing regex already matches; keep the edit minimal and only add missing alternations you find are uncovered by the two new assertions. If both assertions already pass with the current regex, record that in the commit body and skip the regex edit.

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/trustScopeContract.test.js dist/test/nativeDataSnapshot.test.js` — expected `# fail 0` (lockstep set-equality, `scope:"application"`, agents present, redaction pins).

- [ ] **Step 5: Commit**

`git add package.json src/doctor.ts src/nativeDataSnapshot.ts test/trustScopeContract.test.ts test/nativeDataSnapshot.test.ts && git commit -m "Trust-scope hydraRoom.agents and pin head-credential redaction

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 7: Per-head pricing seats every registered head

**Files:**
- Modify: `src/usage.ts` — add `seatDefinitionPrices` next to `DEFAULT_PRICES_BY_KIND` (added by SP1 Task 6 after `DEFAULT_PRICES` at line 45)
- Modify: `src/panel.ts` — `modelPrices()` (lines 4297-4321) seats custom-head prices before returning `agentDefaults`
- Test: `test/usage.test.ts` (append)

**Interfaces:**
- Consumes: `AgentKind`, `ModelPrices`, `DEFAULT_PRICES_BY_KIND` (SP1 `src/usage.ts`); `listAgentDefinitions` (SP1 `src/agentRegistry.ts`).
- Produces: `seatDefinitionPrices(base: Record<AgentId, ModelPrices>, defs: Array<{ id: string; kind: AgentKind; pricing?: ModelPrices }>): Record<string, ModelPrices>`.

Notes: keeps the codex/claude entries `modelPrices()` already builds (settings-driven), and seats each additional registered head from `def.pricing ?? DEFAULT_PRICES_BY_KIND[def.kind]`. `resolveModelPrices(agent, …, agentDefaults)` then finds a per-head base for a custom id instead of falling to the SP1 per-kind guard.

- [ ] **Step 1: Write the failing test** (append to `test/usage.test.ts`)

```ts
import { seatDefinitionPrices, DEFAULT_PRICES_BY_KIND, DEFAULT_PRICES } from "../src/usage";

describe("per-head pricing", () => {
  test("seatDefinitionPrices keeps existing seats and adds custom heads from def.pricing or per-kind default", () => {
    const base = { codex: DEFAULT_PRICES.codex, claude: DEFAULT_PRICES.claude };
    const custom = { inputPerMTok: 0.2, outputPerMTok: 0.4, cacheReadPerMTok: 0, cacheCreatePerMTok: 0 };
    const seated = seatDefinitionPrices(base, [
      { id: "codex", kind: "codex" },
      { id: "ollama-qwen", kind: "openai-compatible", pricing: custom },
      { id: "my-tool", kind: "cli-template" },
    ]);
    assert.equal(seated.codex, DEFAULT_PRICES.codex); // untouched
    assert.deepEqual(seated["ollama-qwen"], custom); // explicit per-head pricing
    assert.deepEqual(seated["my-tool"], DEFAULT_PRICES_BY_KIND["cli-template"]); // per-kind fallback
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/usage.test.js`
Expected failure: `Module '"../src/usage"' has no exported member 'seatDefinitionPrices'`.

- [ ] **Step 3: Implement minimally**

Add to `src/usage.ts` (after `DEFAULT_PRICES_BY_KIND`):

```ts
/** Seat a per-head price base for every registered definition. Existing seats
 *  (codex/claude from settings) are left as-is; custom heads take def.pricing
 *  or their per-kind default. */
export function seatDefinitionPrices(
  base: Record<AgentId, ModelPrices>,
  defs: Array<{ id: string; kind: AgentKind; pricing?: ModelPrices }>,
): Record<string, ModelPrices> {
  const out: Record<string, ModelPrices> = { ...base };
  for (const def of defs) {
    if (out[def.id]) continue;
    out[def.id] = def.pricing ?? DEFAULT_PRICES_BY_KIND[def.kind];
  }
  return out;
}
```

In `src/panel.ts`, import `seatDefinitionPrices` and `listAgentDefinitions`, and change `modelPrices()` (line ~4321) to seat before returning:

```ts
    return { agentDefaults: seatDefinitionPrices(agentDefaults, listAgentDefinitions()), modelOverrides };
```

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/usage.test.js` — expected `# fail 0`.
Then `pnpm run check` — expected exit 0.

- [ ] **Step 5: Commit**

`git add src/usage.ts src/panel.ts test/usage.test.ts && git commit -m "Seat per-head pricing for registered custom heads

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 8: Wire the HTTP invocation path into `panel.ts` dispatch

**Files:**
- Modify: `src/panel.ts` — add `buildInvocationFor(agent, phase, prompt)`; branch the turn dispatch (around the `buildSpawn` call at line 3669 feeding `runAgentTransport` at line 3748) so an `http` invocation runs through a new `runHttpPipeline`; route full-native consent (`ensureFullNativeConsent`, line 3760-3763) through the adapter's `authority` so a `cli-template` head triggers the modal
- Test: `test/panelSourceContract.test.ts` (append multi-adapter wiring assertions)

**Interfaces:**
- Consumes: `getAgentDefinition`, `adapterForKind` (SP1); `runHttpAgent`, `HttpAgentResult` (Task 5); `openaiCompatibleAdapter`/`cliTemplateAdapter` registrations (Tasks 3-4); `Invocation`, `InvocationContext` (SP1).
- Produces: `panel.ts` dispatches `http` heads via `runHttpAgent` (trace + failure-card + usage plumbing mirrored from `runOneShotPipeline`), and consent is derived from `adapterForKind(def.kind).authority(...)`.

Notes: `runOneShotPipeline` (line 3297) is spawn-specific (`runAgent`), so `http` gets a sibling `runHttpPipeline` rather than reuse. It reuses `messagesById` chunk/replace, `appendAgentCallTrace` (`transport:"http"`), `recordRunFailureCard`, and `recordUsage` via the adapter's `parseUsage`. `cli-template` remains a `spawn` invocation and flows through the existing one-shot path — but its argv comes from `buildInvocationFor` (which passes the real `prompt` so `${prompt}` expands), NOT the empty-prompt SP1 `buildSpawn`. Keep `buildSpawn` for previews/diagnostics (empty-prompt argv is display-only). Because the default roster is codex+claude, spawn-only diagnostics that iterate `["codex","claude"]` are unaffected.

Representative wiring (PATTERN):

1. New helper, near `buildSpawn` (line 4062):
```ts
private buildInvocationFor(agent: AgentId, phase: Phase, prompt: string): Invocation {
  const def = getAgentDefinition(agent) ?? { id: agent, displayName: agent, kind: "codex" as const };
  const cfg = vscode.workspace.getConfiguration("hydraRoom");
  const command = cfg.get<string>(`${agent}Command`, agent);
  const rawArgs = cfg.get<string[]>(argsSettingKey(agent, phase), []);
  return adapterForKind(def.kind).buildInvocation(def, { phase, workspaceRoot: this.workspaceRoot, prompt, command, rawArgs });
}
```

2. In the dispatch method (line ~3669), after consent, branch on transport:
```ts
const inv = this.buildInvocationFor(agent, phase, prompt);
if (inv.transport === "http") {
  return await this.runHttpPipeline(agent, phase, inv, prompt, messageId, timeout, signal, traceIdOverride, markOutput);
}
// spawn kinds keep using this.buildSpawn(...) → runAgentTransport as today
```
(Preserve today's `buildSpawn` → `runAgentTransport` for spawn; only add the http branch. For `cli-template` the spawn args must come from `buildInvocationFor` so `${prompt}` expands — thread its `inv.args`/`inv.command`/`inv.stdin` into the spawn passed to `runAgentTransport`, or special-case cli-template through a spawn path that uses `inv`.)

3. Consent via adapter authority — in `ensureFullNativeConsent` (line 3763):
```ts
const def = getAgentDefinition(agent);
const authority = def ? adapterForKind(def.kind).authority(def, { phase, workspaceRoot: this.workspaceRoot, prompt: "", command: "", rawArgs: spawn.args })
  : classifyAgentAuthority(agent, phase, spawn.args);
```
(For codex/claude the adapter delegates to `classifyAgentAuthority`, so behavior is identical; for `cli-template` it returns `fullNative` and the modal fires.)

4. `runHttpPipeline` (new, mirrors `runOneShotPipeline`'s trace/usage skeleton):
```ts
private async runHttpPipeline(
  agent: AgentId, phase: Phase, inv: Extract<Invocation, { transport: "http" }>,
  prompt: string, messageId: string, timeout: number, signal: AbortSignal,
  traceIdOverride: string | undefined, markOutput?: () => void,
): Promise<RunResult> {
  const traceId = traceIdOverride ?? makeTraceId(agent, phase);
  const startedAt = Date.now();
  await this.appendAgentCallTrace({ id: traceId, event: "started", timestamp: new Date(startedAt).toISOString(), agent, phase, transport: "http", command: inv.url, args: [], envKeys: [], timeoutMs: timeout, promptChars: prompt.length, promptSha256: sha256(prompt), outputMode: "openaiJson" });
  const result = await runHttpAgent(inv, {
    timeoutMs: timeout, signal,
    onChunk: (chunk) => { markOutput?.(); const m = this.messagesById.get(messageId); if (m) m.text += chunk; this.panel.webview.postMessage({ type: "chunk", messageId, text: chunk }); },
  });
  const def = getAgentDefinition(agent);
  const adapter = def ? adapterForKind(def.kind) : undefined;
  const raw = { stdout: result.rawBody, stderr: result.stderr, exitCode: result.exitCode, outputMode: "openaiJson" as const };
  const replyText = adapter ? adapter.parseReply(raw) : result.stdout;
  const m = this.messagesById.get(messageId);
  if (m && replyText && replyText !== m.text) { m.text = replyText; this.panel.webview.postMessage({ type: "replaceMessageText", messageId, text: replyText }); }
  this.recordRunFailureCard(messageId, { id: traceId, agent, phase, transport: "http", startedAt, result: { ...result, stdout: replyText }, promptSha256: sha256(prompt) });
  await this.appendAgentCallTrace(completedAgentCallTrace(traceId, agent, phase, "http", startedAt, { ...result, stdout: replyText }));
  const tokens = adapter?.parseUsage(raw);
  if (tokens && !result.cancelled && !result.timedOut) {
    await this.recordUsage({ agent, phase, requestId: traceId, model: def?.model, source: "unknown", tokens });
  }
  return { ...result, stdout: replyText };
}
```
(If `appendAgentCallTrace`/`completedAgentCallTrace` types constrain `transport` to `"oneShot"|"terminalBridge"`, widen that union to add `"http"` at its definition — grep for the trace type in `src/agentCallTrace.ts` or wherever `completedAgentCallTrace` lives, and add `"http"`. `recordUsage.source` accepts `"unknown"` per `UsageRecord["source"]`.)

- [ ] **Step 1: Write the failing test** (append to `test/panelSourceContract.test.ts`)

```ts
describe("generic-adapter dispatch source contract", () => {
  const source = () => fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");

  test("dispatch builds an Invocation and branches on the http transport", () => {
    const src = source();
    assert.match(src, /buildInvocationFor\(/);
    assert.match(src, /inv\.transport === "http"/);
    assert.match(src, /runHttpPipeline\(/);
    assert.match(src, /runHttpAgent\(/);
  });

  test("full-native consent derives authority from the registry adapter", () => {
    const src = source();
    const start = src.indexOf("ensureFullNativeConsent");
    const body = src.slice(start, start + 1200);
    assert.match(body, /adapterForKind\(def\.kind\)\.authority\(/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/panelSourceContract.test.js`
Expected failure: `buildInvocationFor(` / `runHttpPipeline(` / `adapterForKind(def.kind).authority(` not found.

- [ ] **Step 3: Implement minimally**

Apply the wiring pattern above. Add imports at the top of `src/panel.ts`: `runHttpAgent` from `./httpTransport`, `openaiCompatibleAdapter`/`cliTemplateAdapter` are pulled transitively through `./agentRegistry` (already imported for SP1), so no extra import is needed beyond `Invocation` type. Widen the agent-call-trace `transport` union to include `"http"` if the compiler flags it (`pnpm run check` drives this out).

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/panelSourceContract.test.js` — expected `# fail 0`.
Command: `pnpm run check` — expected exit 0 (drives out trace-union / import stragglers site-by-site).

- [ ] **Step 5: Commit**

`git add src/panel.ts test/panelSourceContract.test.ts && git commit -m "Dispatch http heads via runHttpAgent; consent via adapter authority

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 9: End-to-end acceptance + full green

**Files:**
- Create: `test/genericAdaptersE2E.test.ts`
- Test: `test/genericAdaptersE2E.test.ts` + full `pnpm test`

**Interfaces:**
- Consumes: `mergeAgentDefinitions` (Task 1); `adapterForKind`, `getAgentDefinition` (SP1); `openaiCompatibleAdapter`/`cliTemplateAdapter` (Tasks 3-4); `runHttpAgent` (Task 5).
- Produces: a locked acceptance proving (a) an Ollama (openai-compatible) head + a cli-template head merge cleanly and build a correct invocation, (b) `runHttpAgent` returns text for a fake Ollama endpoint, (c) invalid + secret-inlining defs are rejected with a clear message.

- [ ] **Step 1: Write the failing test**

```ts
// test/genericAdaptersE2E.test.ts
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mergeAgentDefinitions } from "../src/agentValidation";
import { BUILTIN_AGENT_DEFINITIONS, adapterForKind } from "../src/agentRegistry";
import "../src/openaiCompatibleAdapter";
import "../src/cliTemplateAdapter";
import { runHttpAgent } from "../src/httpTransport";
import type { Invocation, InvocationContext } from "../src/agentAdapter";

const ctx = (prompt: string): InvocationContext => ({ phase: "build", workspaceRoot: "C:/repo", prompt, command: "", rawArgs: [] });

describe("generic adapters end to end", () => {
  test("a user seats an Ollama head and a cli-template head via settings", () => {
    const { defs, warnings } = mergeAgentDefinitions([...BUILTIN_AGENT_DEFINITIONS], [
      { id: "ollama-qwen", displayName: "Qwen (local)", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder" },
      { id: "shell-llm", displayName: "Shell LLM", kind: "cli-template", command: "llm", argsTemplate: ["-m", "${model}", "${prompt}"], model: "local-7b", defaultAuthority: "full-native" },
    ]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(defs.map((d) => d.id), ["codex", "claude", "gemini", "ollama-qwen", "shell-llm"]);

    const ollama = defs.find((d) => d.id === "ollama-qwen")!;
    const httpInv = adapterForKind(ollama.kind).buildInvocation(ollama, ctx("build the thing"));
    assert.equal(httpInv.transport, "http");
    if (httpInv.transport === "http") assert.equal(httpInv.url, "http://localhost:11434/v1/chat/completions");

    const shell = defs.find((d) => d.id === "shell-llm")!;
    const spawnInv = adapterForKind(shell.kind).buildInvocation(shell, ctx("build the thing"));
    assert.equal(spawnInv.transport, "spawn");
    if (spawnInv.transport === "spawn") assert.deepEqual(spawnInv.args, ["-m", "local-7b", "build the thing"]);
    assert.equal(adapterForKind(shell.kind).authority(shell, ctx("")).level, "fullNative");
  });

  test("the http transport returns the assistant reply for a fake Ollama endpoint", async () => {
    const inv: Extract<Invocation, { transport: "http" }> = {
      transport: "http", url: "http://localhost:11434/v1/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json" }, body: {},
    };
    const fetchImpl = (async () => new Response(
      JSON.stringify({ choices: [{ message: { content: "ollama says hi" } }], usage: { prompt_tokens: 8, completion_tokens: 3 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
    const res = await runHttpAgent(inv, { timeoutMs: 5000, signal: new AbortController().signal, fetchImpl });
    assert.equal(res.stdout, "ollama says hi");
  });

  test("invalid and secret-inlining definitions are rejected with clear messages", () => {
    const { defs, warnings } = mergeAgentDefinitions([...BUILTIN_AGENT_DEFINITIONS], [
      { id: "no-url", displayName: "No URL", kind: "openai-compatible" },
      { id: "leaky", displayName: "Leaky", kind: "openai-compatible", baseUrl: "https://x/v1", headers: { Authorization: "Bearer sk-proj-0123456789abcdef" } },
      { id: "remote-http", displayName: "Remote HTTP", kind: "openai-compatible", baseUrl: "http://api.openrouter.ai/v1" },
    ]);
    assert.deepEqual(defs.map((d) => d.id), ["codex", "claude", "gemini"]); // none of the three seated
    assert.equal(warnings.length, 3);
    assert.match(warnings.join(" | "), /baseUrl/);
    assert.match(warnings.join(" | "), /secret|inline/i);
    assert.match(warnings.join(" | "), /https/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/genericAdaptersE2E.test.js`
Expected failure (if run before Tasks 1-8 land): compile/module errors. Run at the end of the sub-project — expected to pass immediately once Tasks 1-8 are complete; a failing assertion means a prior task regressed.

- [ ] **Step 3: Implement minimally**

No new production code — this task locks the acceptance criteria. If an assertion fails, fix the offending prior task (do not weaken the assertion).

- [ ] **Step 4: Run to confirm pass**

Command: `pnpm test`
Expected: the whole suite is green — `# fail 0`, including `agentValidation`, `agentRegistry`, `openaiCompatibleAdapter`, `cliTemplateAdapter`, `httpTransport`, `usage`, `trustScopeContract`, `nativeDataSnapshot`, `panelSourceContract`, and `genericAdaptersE2E`, plus all SP1 suites.

- [ ] **Step 5: Commit**

`git add test/genericAdaptersE2E.test.ts && git commit -m "Lock SP2 acceptance: Ollama + cli-template heads end to end; invalid defs rejected

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`
