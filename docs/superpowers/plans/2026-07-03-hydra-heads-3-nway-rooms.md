# Hydra Heads — Sub-project 3: N-way Rooms and Review Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Let a room seat more than two heads and run all-discuss / one-builds / N-review, converging multiple review verdicts through a user-selected `human`/`unanimous`/`majority` policy — with a default two-head Codex+Claude room behaving exactly as it does today.

**Architecture:** SP1 already opened `AgentId` to a registry-keyed string and replaced the binary `otherAgent` flip with `pickReviewers(builder, roster, policy): AgentId[]` (slicing to a single reviewer). SP3 (a) generalizes `pickReviewers` to return every non-builder under an `"all"` policy, (b) adds a pure `evaluateReviewConvergence(verdicts, mode)` evaluator that replaces the hardcoded `results.every(...)` approval fold in `runParallelReviewPhase`, (c) makes the review states carry the originating builder so a single-builder → multi-reviewer review hands back to that one builder, (d) seats the configured `hydraRoom.roomRoster` into the array-based `ParallelDiscussion`/`ParallelReview` states already present in `src/phases.ts`, and (e) renders N heads in the cost meter/status rail. The existing decision-packet, risk-gate, and work-queue machinery is reused unchanged.

**Tech Stack:** TypeScript, VS Code extension API, Node built-in test runner, pnpm.

## Global Constraints
- Build on SP1's locked interfaces exactly: `type AgentId = string`, `pickReviewers(builder: AgentId, roster: ReadonlyArray<AgentId>, policy?: ParticipationPolicy): AgentId[]`, `DEFAULT_ROSTER: ReadonlyArray<AgentId>`, `agentRegistry.{get,list,adapterFor}`, `listAgentDefinitions()`, `displayNameFor(id)`. Do NOT redefine them differently.
- A default two-head room (`roomRoster` unset → `["codex","claude"]`, `reviewConvergence` default `human`, `reviewParticipation` default `all`) MUST produce today's opener/reactor/closer/build/review sequence byte-for-byte. Task 8 locks this with a regression test.
- `hydraRoom.roomRoster` flows into which spawn-capable heads act, so it is trust-scoped: `scope:"application"` in `package.json`, listed in `capabilities.untrustedWorkspaces.restrictedConfigurations`, AND mirrored in `TRUST_SCOPED_SETTINGS` in `src/doctor.ts`. `test/trustScopeContract.test.ts` enforces the three-way sync.
- `hydraRoom.reviewConvergence` and `hydraRoom.reviewParticipation` are pure decision-logic settings (they inject into no spawn/exec/env/PATH/endpoint) — they are NOT trust-scoped, following the `autoAdvanceActionableDefaults` / `autoSkipCloserOnAgreement` precedent. Add a `// Why NOT scope:"application"` comment next to each reader.
- Auto mode still respects the risk gate: `autoAdvanceActionableDefault` must keep calling `detectRiskySignals` before `currentDecisionAction()` (pinned by `test/panelSourceContract.test.ts:24`). SP3 changes nothing in that ordering.
- Do NOT tighten the accepted permissive vendor defaults (Codex `--sandbox workspace-write` + `network_access=true`, Claude `acceptEdits`).
- TDD only: write the failing test, run it red, implement minimally, run it green, commit. `pnpm run check` = type-check only; `pnpm test` = full suite; single suite = `tsc -p . && node --test dist/test/<name>.test.js`.
- No new `: any` in `src/`. `phases.test.ts` may keep using `(state as any).field` reads — that is the existing test idiom.

---

### Task 1: Review-convergence evaluator + setting

**Files:**
- Create: `src/reviewConvergence.ts`
- Modify: `src/roomSettings.ts` (add a `reviewConvergence()` reader next to `autoSkipCloserOnAgreement` at lines 91-93), `package.json` (add `hydraRoom.reviewConvergence` enum next to `hydraRoom.autoSkipCloserOnAgreement` at lines 907-911)
- Test: `test/reviewConvergence.test.ts`

**Interfaces:**
- Consumes: `AgentId` (from `src/phases.ts`).
- Produces: `type ReviewConvergenceMode = "human" | "unanimous" | "majority"`, `REVIEW_CONVERGENCE_MODES`, `interface ReviewVerdict { agent: AgentId; approved: boolean }`, `evaluateReviewConvergence(verdicts: ReviewVerdict[], mode: ReviewConvergenceMode): { approved: boolean; approvals: number; total: number; dissenters: AgentId[] }`, and `reviewConvergence(): ReviewConvergenceMode` (in `roomSettings.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// test/reviewConvergence.test.ts
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  evaluateReviewConvergence,
  REVIEW_CONVERGENCE_MODES,
  type ReviewVerdict,
} from "../src/reviewConvergence";

const v = (agent: string, approved: boolean): ReviewVerdict => ({ agent, approved });

describe("evaluateReviewConvergence", () => {
  test("the three spec modes are listed", () => {
    assert.deepEqual([...REVIEW_CONVERGENCE_MODES], ["human", "unanimous", "majority"]);
  });

  test("unanimous: approves only when every reviewer approves", () => {
    assert.equal(evaluateReviewConvergence([v("codex", true), v("claude", true)], "unanimous").approved, true);
    const split = evaluateReviewConvergence([v("codex", true), v("claude", false)], "unanimous");
    assert.equal(split.approved, false);
    assert.deepEqual(split.dissenters, ["claude"]);
  });

  test("majority: approves when strictly more than half approve", () => {
    // 2 of 3 -> majority approves
    assert.equal(evaluateReviewConvergence([v("a", true), v("b", true), v("c", false)], "majority").approved, true);
    // 1 of 2 is a tie, not a majority -> hands back
    assert.equal(evaluateReviewConvergence([v("a", true), v("b", false)], "majority").approved, false);
  });

  test("human: safe default treats any dissent as not-approved (user arbitrates the split)", () => {
    assert.equal(evaluateReviewConvergence([v("a", true), v("b", true)], "human").approved, true);
    assert.equal(evaluateReviewConvergence([v("a", true), v("b", false)], "human").approved, false);
  });

  test("empty verdict set never approves", () => {
    assert.equal(evaluateReviewConvergence([], "majority").approved, false);
  });

  test("single reviewer reduces to that reviewer's verdict in every mode", () => {
    for (const mode of REVIEW_CONVERGENCE_MODES) {
      assert.equal(evaluateReviewConvergence([v("codex", true)], mode).approved, true);
      assert.equal(evaluateReviewConvergence([v("codex", false)], mode).approved, false);
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/reviewConvergence.test.js`
Expected failure: `tsc` errors with `Cannot find module '../src/reviewConvergence'` (compile fails before the test runs).

- [ ] **Step 3: Implement minimally**

```ts
// src/reviewConvergence.ts
import type { AgentId } from "./phases";

export const REVIEW_CONVERGENCE_MODES = ["human", "unanimous", "majority"] as const;
export type ReviewConvergenceMode = (typeof REVIEW_CONVERGENCE_MODES)[number];

export interface ReviewVerdict {
  agent: AgentId;
  approved: boolean;
}

export interface ConvergenceResult {
  approved: boolean;
  approvals: number;
  total: number;
  dissenters: AgentId[];
}

/**
 * Fold N reviewer verdicts into a single advance/hand-back decision.
 * - unanimous: any "needs changes" hands back.
 * - majority: a strict majority of approvals advances (a tie hands back).
 * - human: Hydra surfaces all verdicts and the user decides; when a caller
 *   (auto mode) must pick without the user, it takes the SAFE default —
 *   treat any dissent as not-approved, i.e. identical to unanimous.
 */
export function evaluateReviewConvergence(
  verdicts: ReviewVerdict[],
  mode: ReviewConvergenceMode,
): ConvergenceResult {
  const total = verdicts.length;
  const approvals = verdicts.filter((verdict) => verdict.approved).length;
  const dissenters = verdicts.filter((verdict) => !verdict.approved).map((verdict) => verdict.agent);
  let approved: boolean;
  switch (mode) {
    case "majority":
      approved = total > 0 && approvals * 2 > total;
      break;
    case "unanimous":
    case "human":
    default:
      approved = total > 0 && approvals === total;
      break;
  }
  return { approved, approvals, total, dissenters };
}
```

Add to `src/roomSettings.ts` after `autoSkipCloserOnAgreement` (line 93):

```ts
// Why NOT scope:"application": review convergence only selects how Hydra folds
// reviewer verdicts into advance/hand-back — it injects into no
// spawn/exec/env/PATH/terminal/webhook/Telegram sink, so it follows the
// autoSkipCloserOnAgreement precedent and stays out of TRUST_SCOPED_SETTINGS.
export function reviewConvergence(): ReviewConvergenceMode {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<string>("reviewConvergence", "human");
  return (REVIEW_CONVERGENCE_MODES as readonly string[]).includes(raw) ? (raw as ReviewConvergenceMode) : "human";
}
```

Add the import at the top of `src/roomSettings.ts` (next to the other type imports at lines 15-19):

```ts
import { REVIEW_CONVERGENCE_MODES, type ReviewConvergenceMode } from "./reviewConvergence";
```

Add to `package.json` `contributes.configuration.properties` after `hydraRoom.autoSkipCloserOnAgreement` (line 911), with NO `scope` key (window-scoped like its neighbor):

```json
"hydraRoom.reviewConvergence": {
  "type": "string",
  "enum": [
    "human",
    "unanimous",
    "majority"
  ],
  "default": "human",
  "markdownDescription": "How Hydra folds multiple reviewer verdicts when more than one head reviews a diff. `human`: surface every verdict and let the user decide (auto-advance takes the safe default — any dissent hands back). `unanimous`: any `needs changes` hands the diff back to the builder. `majority`: a strict majority of `APPROVED` advances. Ignored when only one head reviews."
}
```

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/reviewConvergence.test.js`
Expected pass: `# pass 6  # fail 0`.
Command: `pnpm run check` — expected exit 0.

- [ ] **Step 5: Commit**

`git add src/reviewConvergence.ts src/roomSettings.ts package.json test/reviewConvergence.test.ts && git commit -m "Add review-convergence evaluator and reviewConvergence setting

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 2: Roster setting + participation policy; generalize `pickReviewers` to N

**Files:**
- Modify: `src/phases.ts` (SP1 left `pickReviewers` at the top with a `.slice(0, 1)` and `type ParticipationPolicy = "serial"`), `src/roomSettings.ts` (add `roomRoster()` and `reviewParticipation()` readers), `package.json` (add `hydraRoom.roomRoster` trust-scoped + `hydraRoom.reviewParticipation`; add `hydraRoom.roomRoster` to `capabilities.untrustedWorkspaces.restrictedConfigurations` at lines 1227-1257), `src/doctor.ts` (`TRUST_SCOPED_SETTINGS` at lines 63-106 — add `roomRoster`)
- Test: `test/phases.test.ts` (append a participation describe block), `test/trustScopeContract.test.ts` (append an explicit `roomRoster` assertion)

**Interfaces:**
- Consumes: `AgentId`, `DEFAULT_ROSTER` (SP1, `src/phases.ts`); `TRUST_SCOPED_SETTINGS` (`src/doctor.ts`).
- Produces: widened `type ParticipationPolicy = "serial" | "all"`; `pickReviewers(builder, roster, policy?)` returns EVERY non-builder for `"all"` (its new default) and the first non-builder for `"serial"`; `roomRoster(): AgentId[]` and `reviewParticipation(): ParticipationPolicy` in `roomSettings.ts`.

- [ ] **Step 1: Write the failing test** (append to `test/phases.test.ts`)

```ts
import { pickReviewers, DEFAULT_ROSTER } from "../src/phases";

describe("pickReviewers() N-way (SP3)", () => {
  test("default 'all' policy returns every non-builder", () => {
    assert.deepEqual(pickReviewers("codex", ["codex", "claude", "gemini"]), ["claude", "gemini"]);
  });

  test("two-head roster still yields exactly one reviewer under the default policy", () => {
    assert.deepEqual(pickReviewers("codex", [...DEFAULT_ROSTER]), ["claude"]);
    assert.deepEqual(pickReviewers("claude", [...DEFAULT_ROSTER]), ["codex"]);
  });

  test("'serial' policy still caps at a single reviewer for a large roster", () => {
    assert.deepEqual(pickReviewers("codex", ["codex", "claude", "gemini"], "serial"), ["claude"]);
  });

  test("builder absent from roster is a no-op filter", () => {
    assert.deepEqual(pickReviewers("gemini", ["codex", "claude"]), ["codex", "claude"]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/phases.test.js`
Expected failure: the `default 'all' policy returns every non-builder` test fails with `AssertionError [ERR_ASSERTION]: Expected values to be loosely deep-equal` — SP1's `pickReviewers` still returns `["claude"]` (`.slice(0, 1)`) instead of `["claude", "gemini"]`.

- [ ] **Step 3: Implement minimally** — edit `src/phases.ts`

Replace SP1's `ParticipationPolicy` type and `pickReviewers` body:

```ts
export type ParticipationPolicy = "serial" | "all";

/**
 * Reviewers for a builder's diff, chosen from the rest of the roster.
 * - "all" (default): every non-builder reviews — a two-head roster still
 *   yields exactly one reviewer, so today's serial behavior is unchanged,
 *   while a three-head roster produces the "two-review" fan-out.
 * - "serial": only the first non-builder reviews, regardless of roster size.
 */
export function pickReviewers(
  builder: AgentId,
  roster: ReadonlyArray<AgentId>,
  policy: ParticipationPolicy = "all",
): AgentId[] {
  const others = roster.filter((agent) => agent !== builder);
  return policy === "serial" ? others.slice(0, 1) : others;
}
```

Leave the internal `otherAgent` helper SP1 added (`const otherAgent = (a) => pickReviewers(a, DEFAULT_ROSTER)[0] ?? a;`) intact — for a two-head roster `pickReviewers` under `"all"` still returns a single-element array, so `[0]` is unchanged.

Add to `src/roomSettings.ts` (import `ParticipationPolicy` from `./phases` near line 16, then add readers after `discussionMode` at line 98):

```ts
// Why scope:"application" in package.json: roomRoster selects which
// spawn-capable heads act in a turn. An untrusted workspace override could
// re-seat the roster to auto-run a head the user never intended, so it is
// trust-scoped alongside the command/env settings.
export function roomRoster(): AgentId[] {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<unknown>("roomRoster", []);
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return ids;
}

// Why NOT scope:"application": reviewParticipation only picks how many heads
// review (single vs. all non-builders) — pure decision logic, no spawn/env
// sink — so like reviewConvergence it stays out of TRUST_SCOPED_SETTINGS.
export function reviewParticipation(): ParticipationPolicy {
  const raw = vscode.workspace.getConfiguration("hydraRoom").get<string>("reviewParticipation", "all");
  return raw === "serial" ? "serial" : "all";
}
```

Add the import at the top of `src/roomSettings.ts`:

```ts
import type { AgentId, DiscussionMode, ParticipationPolicy } from "./phases";
```

(replacing the existing `import type { DiscussionMode } from "./phases";` at line 16).

Add to `package.json` `contributes.configuration.properties` (near the other roster/agent settings):

```json
"hydraRoom.roomRoster": {
  "scope": "application",
  "type": "array",
  "items": { "type": "string" },
  "default": [
    "codex",
    "claude"
  ],
  "markdownDescription": "Head ids seated in the room, in display order. Defaults to the two built-in heads. Ids must resolve in the agent registry (built-ins plus `hydraRoom.agents`); unknown ids are dropped. Trust-scoped because it selects which spawn-capable heads act."
},
"hydraRoom.reviewParticipation": {
  "type": "string",
  "enum": [
    "single",
    "all"
  ],
  "default": "all",
  "markdownDescription": "Who reviews a builder's diff. `all` (default): every non-builder head reviews — a two-head room still means one reviewer, a three-head room means two reviewers. `single`: only one non-builder reviews, regardless of roster size."
}
```

Note the setting value `"single"` maps to the `"serial"` participation policy (the `reviewParticipation()` reader does `raw === "serial" ? "serial" : "all"` — change the reader comparison to `raw === "single"`):

```ts
  return raw === "single" ? "serial" : "all";
```

Add `hydraRoom.roomRoster` to `capabilities.untrustedWorkspaces.restrictedConfigurations` (after line 1229) and `roomRoster` to `TRUST_SCOPED_SETTINGS` in `src/doctor.ts` (after `workspaceRoot` at line 65). Do NOT add `reviewConvergence`/`reviewParticipation`.

- [ ] **Step 2b: Write the trust-scope assertion** (append to `test/trustScopeContract.test.ts` inside the existing `describe`)

```ts
test("roomRoster is trust-scoped; reviewConvergence/reviewParticipation are not", () => {
  assert.ok(
    (TRUST_SCOPED_SETTINGS as readonly string[]).includes("roomRoster"),
    "roomRoster must be trust-scoped — it seats which spawn-capable heads act",
  );
  assert.ok(
    !(TRUST_SCOPED_SETTINGS as readonly string[]).includes("reviewConvergence"),
    "reviewConvergence is pure decision logic and must NOT be trust-scoped",
  );
  assert.ok(
    !(TRUST_SCOPED_SETTINGS as readonly string[]).includes("reviewParticipation"),
    "reviewParticipation is pure decision logic and must NOT be trust-scoped",
  );
});
```

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/phases.test.js dist/test/trustScopeContract.test.js`
Expected pass: `# fail 0` (the phases N-way tests pass, and the three-way lockstep `restrictedConfigurations`/`TRUST_SCOPED_SETTINGS`/`scope:"application"` set-equality holds with `roomRoster` on all three sides).
Command: `pnpm run check` — expected exit 0.

- [ ] **Step 5: Commit**

`git add src/phases.ts src/roomSettings.ts src/doctor.ts package.json test/phases.test.ts test/trustScopeContract.test.ts && git commit -m "Add roomRoster + reviewParticipation; generalize pickReviewers to N

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 3: Builder-aware review states in the phase machine

**Files:**
- Modify: `src/phases.ts` (`State` union at lines 4-18; `Event` union at lines 20-35; `transition` cases for `BuildDone`/`ParallelBuildDone`/`Review`/`ParallelReview`/`ReviewDone`/`ParallelReviewDone` at lines 82-123)
- Test: `test/phases.test.ts` (append a multi-reviewer transition describe block; existing serial-sequence tests at lines 5-45 must still pass unchanged)

**Interfaces:**
- Consumes: `pickReviewers` (Task 2), `AgentId`.
- Produces: `Review`/`ReviewDone`/`ParallelReview`/`ParallelReviewDone` states each gain an optional `builder?: AgentId`; the `requestReview` event gains an optional `reviewers?: AgentId[]`. `BuildDone + requestReview` routes to `ParallelReview` when `reviewers.length > 1` and remembers the single builder so hand-back returns to that one builder.

Design note: today `ReviewDone + handBack → Build{ builder: otherAgent(reviewer) }` infers the builder from the 2-head flip. With N heads that inference is wrong, so the review states now carry the originating builder explicitly. Optional field + `?? otherAgent(...)` fallback keeps the 2-head path byte-identical (for `[codex,claude]`, `state.builder` equals `otherAgent(reviewer)`). The existing `ParallelBuildDone → ParallelReview` (multiple builders) path passes NO `builder`, so its hand-back still returns to `ParallelBuild`.

- [ ] **Step 1: Write the failing test** (append to `test/phases.test.ts`)

```ts
import type { State } from "../src/phases";

describe("multi-reviewer review states (SP3)", () => {
  test("BuildDone + requestReview with >1 reviewer -> ParallelReview carrying the single builder", () => {
    const next = transition(
      { name: "BuildDone", builder: "codex" },
      { type: "requestReview", reviewers: ["claude", "gemini"] },
    );
    assert.equal(next.name, "ParallelReview");
    assert.deepEqual((next as any).agents, ["claude", "gemini"]);
    assert.equal((next as any).builder, "codex");
  });

  test("BuildDone + requestReview with 1 reviewer -> single Review carrying the builder", () => {
    const next = transition(
      { name: "BuildDone", builder: "codex" },
      { type: "requestReview", reviewers: ["claude"] },
    );
    assert.equal(next.name, "Review");
    assert.equal((next as any).reviewer, "claude");
    assert.equal((next as any).builder, "codex");
  });

  test("ParallelReview from a single builder hands back to that one builder", () => {
    let s: State = { name: "ParallelReview", agents: ["claude", "gemini"], builder: "codex" };
    s = transition(s, { type: "parallelReviewDone", approved: false });
    assert.equal(s.name, "ParallelReviewDone");
    assert.equal((s as any).builder, "codex");
    s = transition(s, { type: "handBack" });
    assert.equal(s.name, "Build");
    assert.equal((s as any).builder, "codex");
  });

  test("ParallelReview from parallel build (no single builder) still hands back to ParallelBuild", () => {
    let s: State = { name: "ParallelReview", agents: ["codex", "claude"] };
    s = transition(s, { type: "parallelReviewDone", approved: false });
    s = transition(s, { type: "handBack" });
    assert.equal(s.name, "ParallelBuild");
    assert.deepEqual((s as any).agents, ["codex", "claude"]);
  });

  test("legacy BuildDone + requestReview with no reviewers list falls back to the 2-head flip", () => {
    const next = transition({ name: "BuildDone", builder: "codex" }, { type: "requestReview" });
    assert.equal(next.name, "Review");
    assert.equal((next as any).reviewer, "claude");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/phases.test.js`
Expected failure: `tsc` errors because the `requestReview` event has no `reviewers` member and `ParallelReview` has no `builder` member (`Object literal may only specify known properties, and 'reviewers' does not exist in type ...`).

- [ ] **Step 3: Implement minimally** — edit `src/phases.ts`

Add the optional `builder` field to the four review states (lines 15-18):

```ts
  | { name: "Review"; reviewer: AgentId; builder?: AgentId }
  | { name: "ParallelReview"; agents: ReadonlyArray<AgentId>; builder?: AgentId }
  | { name: "ReviewDone"; reviewer: AgentId; approved: boolean; builder?: AgentId }
  | { name: "ParallelReviewDone"; agents: ReadonlyArray<AgentId>; approved: boolean; builder?: AgentId };
```

Add the optional `reviewers` field to the `requestReview` event (line 30):

```ts
  | { type: "requestReview"; reviewers?: ReadonlyArray<AgentId> }
```

Change the `BuildDone` case (lines 90-96) so `requestReview` fans out:

```ts
    case "BuildDone":
      if (event.type === "userSent" && event.parallel) return { name: "ParallelDiscussion", agents: ["codex", "claude"] };
      if (event.type === "userSent") return { name: "Opener", opener: event.opener, reactor: otherAgent(event.opener) };
      if (event.type === "requestReview") {
        const reviewers = event.reviewers ?? [otherAgent(state.builder)];
        return reviewers.length > 1
          ? { name: "ParallelReview", agents: [...reviewers], builder: state.builder }
          : { name: "Review", reviewer: reviewers[0] ?? otherAgent(state.builder), builder: state.builder };
      }
      if (event.type === "requestReviewSkipped") return { name: "AwaitingUser" };
      return state;
```

Keep the `ParallelBuildDone` case's `requestReview → ParallelReview{ agents: state.agents }` (line 100-101) unchanged (no `builder` → parallel-build origin).

Propagate `builder` through the review-done transitions:

```ts
    case "Review":
      if (event.type === "reviewDone")
        return { name: "ReviewDone", reviewer: state.reviewer, approved: event.approved, builder: state.builder };
      return state;
```

```ts
    case "ParallelReview":
      if (event.type === "parallelReviewDone")
        return { name: "ParallelReviewDone", agents: state.agents, approved: event.approved, builder: state.builder };
      return state;
```

Update both hand-back cases to prefer the carried builder:

```ts
    case "ReviewDone":
      if (event.type === "userSent" && event.parallel) return { name: "ParallelDiscussion", agents: ["codex", "claude"] };
      if (event.type === "userSent") return { name: "Opener", opener: event.opener, reactor: otherAgent(event.opener) };
      if (event.type === "handBack")
        return { name: "Build", builder: state.builder ?? otherAgent(state.reviewer) };
      return state;
```

```ts
    case "ParallelReviewDone":
      if (event.type === "userSent" && event.parallel) return { name: "ParallelDiscussion", agents: ["codex", "claude"] };
      if (event.type === "userSent") return { name: "Opener", opener: event.opener, reactor: otherAgent(event.opener) };
      if (event.type === "handBack")
        return state.builder
          ? { name: "Build", builder: state.builder }
          : { name: "ParallelBuild", agents: state.agents };
      return state;
```

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/phases.test.js`
Expected pass: `# fail 0` — the new SP3 transitions pass AND every SP1/existing `transition()` test (serial opener/reactor/closer, 2-head review handoff, parallel build/review) still passes.
Command: `pnpm run check` — expected exit 0.

- [ ] **Step 5: Commit**

`git add src/phases.ts test/phases.test.ts && git commit -m "Carry originating builder through review states for N-way hand-back

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 4: Wire roster + N reviewers + convergence into `panel.ts`

**Files:**
- Modify: `src/panel.ts` (`private roster()` helper added by SP1 Task 12; `requestReview` at lines 865-890; `runParallelReviewPhase` verdict fold at line 3601; imports)
- Test: `test/panelSourceContract.test.ts` (append an SP3 review-wiring describe block)

**Interfaces:**
- Consumes: `pickReviewers` (Task 2), `evaluateReviewConvergence`/`ReviewVerdict` (Task 1), `reviewConvergence`/`reviewParticipation`/`roomRoster` (Task 1/2), `listAgentDefinitions`/`displayNameFor` (SP1), `APPROVED_SENTINEL_RE` (`src/prompts.ts:138`).
- Produces: `panel.ts:requestReview` computes `reviewers = pickReviewers(builder, this.roster(), reviewParticipation())` and dispatches `runParallelReviewPhase(reviewers)` when `reviewers.length > 1` else `runReviewPhase(reviewers[0])`, passing `reviewers` into the `requestReview` event; `runParallelReviewPhase` folds verdicts via `evaluateReviewConvergence` and surfaces each head's verdict.

Design note: SP1 Task 12 added `private roster(): AgentId[] { return [...DEFAULT_ROSTER]; }`. SP3 makes it read the setting and filter to registered heads.

- [ ] **Step 1: Write the failing test** (append to `test/panelSourceContract.test.ts`)

```ts
describe("N-way review wiring source contract (SP3)", () => {
  const source = () => fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");

  test("roster() reads the configured roomRoster, not a hardcoded pair", () => {
    const src = source();
    const start = src.indexOf("private roster(");
    assert.ok(start >= 0, "roster() helper not found");
    const body = src.slice(start, start + 400);
    assert.match(body, /roomRoster\(\)/);
  });

  test("requestReview fans out to every reviewer via pickReviewers + reviewParticipation", () => {
    const src = source();
    const start = src.indexOf("async requestReview(");
    const end = src.indexOf("async runVerification(", start);
    const body = src.slice(start, end);
    assert.match(body, /pickReviewers\(this\.state\.builder, this\.roster\(\), reviewParticipation\(\)\)/);
    assert.match(body, /reviewers\.length > 1/);
    assert.match(body, /runParallelReviewPhase\(/);
  });

  test("parallel review folds verdicts through the convergence policy, not a hardcoded every()", () => {
    const src = source();
    const start = src.indexOf("private async runParallelReviewPhase(");
    const end = src.indexOf("private async callAgent(", start);
    const body = src.slice(start, end);
    assert.match(body, /evaluateReviewConvergence\(/);
    assert.match(body, /reviewConvergence\(\)/);
    assert.doesNotMatch(body, /results\.every\(\(\{ text \}\) => APPROVED_SENTINEL_RE\.test\(text\)\)/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/panelSourceContract.test.js`
Expected failure: `roster() reads the configured roomRoster` fails (SP1's helper returns `[...DEFAULT_ROSTER]`), `requestReview fans out...` fails (SP1 uses `pickReviewers(...)[0]`), and `parallel review folds...` fails (line 3601 still `results.every(...)`).

- [ ] **Step 3: Implement minimally** — edit `src/panel.ts`

Add imports (grouped with the existing `phases`/`roomSettings` imports):

```ts
import { pickReviewers, DEFAULT_ROSTER } from "./phases";
import { roomRoster, reviewParticipation, reviewConvergence } from "./roomSettings";
import { evaluateReviewConvergence, type ReviewVerdict } from "./reviewConvergence";
import { listAgentDefinitions, displayNameFor } from "./agentRegistry";
```

(`pickReviewers`, `DEFAULT_ROSTER`, `listAgentDefinitions`, `displayNameFor` are already imported by SP1 — extend the existing import lines rather than duplicating; add only `roomRoster`, `reviewParticipation`, `reviewConvergence`, `evaluateReviewConvergence`, `ReviewVerdict`.)

Replace the SP1 `roster()` helper:

```ts
// Seated heads for this room, filtered to ids the registry actually knows.
// Falls back to the two built-ins when the setting is empty or resolves to
// no known heads, so a mis-typed roomRoster never produces an empty room.
private roster(): AgentId[] {
  const known = new Set(listAgentDefinitions().map((def) => def.id));
  const seated = roomRoster().filter((id) => known.has(id));
  return seated.length > 0 ? seated : [...DEFAULT_ROSTER];
}
```

Rewrite the `BuildDone` branch of `requestReview` (lines 876-888) to fan out:

```ts
    let parallelAgents: AgentId[] | undefined;
    let reviewer: AgentId | undefined;
    let reviewers: AgentId[] = [];
    if (this.state.name === "ParallelBuildDone") {
      parallelAgents = [...this.state.agents];
      this.applyEvent({ type: "requestReview" });
    } else {
      reviewers = pickReviewers(this.state.builder, this.roster(), reviewParticipation());
      if (reviewers.length === 0) reviewers = [this.state.builder]; // solo-head room: the builder self-reviews
      this.applyEvent({ type: "requestReview", reviewers });
      if (reviewers.length > 1) {
        parallelAgents = reviewers;
      } else {
        reviewer = reviewers[0];
      }
    }
    if (parallelAgents) {
      await this.runParallelReviewPhase(parallelAgents);
    } else if (reviewer) {
      await this.runReviewPhase(reviewer);
    }
    await this.drainQueuedUserMessages();
```

(Delete the old `this.applyEvent({ type: "requestReview" });` at line 883 — the branches above now emit it with the reviewers payload.)

Replace the verdict fold in `runParallelReviewPhase` (line 3601):

```ts
      } else {
        const verdicts: ReviewVerdict[] = results.map(({ text }, index) => ({
          agent: reviewers[index] ?? `reviewer-${index}`,
          approved: APPROVED_SENTINEL_RE.test(text),
        }));
        const mode = reviewConvergence();
        const outcome = evaluateReviewConvergence(verdicts, mode);
        // Surface every verdict so the user can arbitrate (human mode) or see
        // why a majority/unanimous decision landed the way it did.
        await this.appendSystemMessage(
          `Review verdicts (${mode}): ${verdicts.map((verdict) => `${displayNameFor(verdict.agent)} ${verdict.approved ? "approved" : "needs changes"}`).join(", ")} → ${outcome.approved ? "advancing" : "handing back to the builder"}.`,
        );
        this.applyEvent({ type: "parallelReviewDone", approved: outcome.approved });
      }
```

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/panelSourceContract.test.js`
Expected pass: `# fail 0` (all three SP3 assertions plus the existing codex-transport / auto-advance-gate / terminal-bridge contracts).
Command: `pnpm run check` — expected exit 0.

- [ ] **Step 5: Commit**

`git add src/panel.ts test/panelSourceContract.test.ts && git commit -m "Fan review out to N heads and fold verdicts via convergence policy

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 5: All-discuss over the seated roster

**Files:**
- Modify: `src/claudeWorkers.ts` (`BuildParallelDiscussionWorkersArgs` at lines 15-20; `buildParallelDiscussionWorkers` at lines 30-55), `src/panel.ts` (the `buildParallelDiscussionWorkers({...})` call in `runParallelDiscussionTurn` at lines 2862-2867)
- Test: `test/claudeWorkers.test.ts` (append a roster describe block — create the file if it does not exist)

**Interfaces:**
- Consumes: `AgentId`; `buildParallelDiscussionWorkers` args.
- Produces: `buildParallelDiscussionWorkers` accepts a `roster: ReadonlyArray<AgentId>` and emits one worker per seated head (preserving the many-heads Claude-fan-out only for the built-in `claude` head), so a 3-head parallel discussion dispatches all three heads.

Design note: today `buildParallelDiscussionWorkers` hardcodes one `codex` worker + N `claude` workers. SP3 iterates the roster; the experimental many-heads Claude multi-worker fan-out (`manyHeadsClaudeWorkerCount`) is preserved but applies only to a `claude`-kind head so the existing 2-head experimental behavior is unchanged.

- [ ] **Step 1: Write the failing test** (create/append `test/claudeWorkers.test.ts`)

```ts
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { buildParallelDiscussionWorkers } from "../src/claudeWorkers";

const makeTraceId = (agent: string) => `${agent}-trace`;

describe("buildParallelDiscussionWorkers roster (SP3)", () => {
  test("emits one worker per seated head when many-heads is off", () => {
    const workers = buildParallelDiscussionWorkers({
      manyHeads: false,
      transport: "oneShot",
      claudeWorkerCount: 3,
      makeTraceId,
      roster: ["codex", "claude", "gemini"],
    });
    assert.deepEqual(workers.map((worker) => worker.agent), ["codex", "claude", "gemini"]);
  });

  test("default two-head roster is unchanged: codex then claude", () => {
    const workers = buildParallelDiscussionWorkers({
      manyHeads: false,
      transport: "oneShot",
      claudeWorkerCount: 3,
      makeTraceId,
      roster: ["codex", "claude"],
    });
    assert.deepEqual(workers.map((worker) => worker.agent), ["codex", "claude"]);
  });

  test("many-heads still fans out the claude head into multiple workers", () => {
    const workers = buildParallelDiscussionWorkers({
      manyHeads: true,
      transport: "oneShot",
      claudeWorkerCount: 3,
      makeTraceId,
      roster: ["codex", "claude"],
    });
    assert.equal(workers.filter((worker) => worker.agent === "claude").length, 3);
    assert.equal(workers.filter((worker) => worker.agent === "codex").length, 1);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/claudeWorkers.test.js`
Expected failure: `tsc` errors — `roster` is not a member of `BuildParallelDiscussionWorkersArgs` (`Object literal may only specify known properties`).

- [ ] **Step 3: Implement minimally** — edit `src/claudeWorkers.ts`

Add `roster` to the args interface:

```ts
export interface BuildParallelDiscussionWorkersArgs {
  manyHeads: boolean;
  transport: WorkerTransportMode;
  claudeWorkerCount: number;
  makeTraceId: (agent: AgentId, phase: Phase) => string;
  roster: ReadonlyArray<AgentId>;
}
```

Rewrite the body to iterate the roster:

```ts
export function buildParallelDiscussionWorkers(args: BuildParallelDiscussionWorkersArgs): ParallelDiscussionWorker[] {
  const enabled = args.manyHeads && args.transport === "oneShot";
  const workers: ParallelDiscussionWorker[] = [];
  for (const agent of args.roster) {
    // Why: the many-heads Claude fan-out is a claude-only experimental path.
    // Every other head (codex, gemini, custom) gets exactly one worker so an
    // N-head roster runs each head once in parallel.
    if (agent === "claude") {
      const claudeTotal = enabled ? clampManyHeadsClaudeWorkerCount(args.claudeWorkerCount) : 1;
      const manyHeadsDispatch = enabled && claudeTotal > 1;
      for (let index = 1; index <= claudeTotal; index++) {
        workers.push({
          agent: "claude",
          workerId: claudeTotal > 1 ? `claude-${index}` : "claude",
          traceIdOverride: enabled ? args.makeTraceId("claude", "parallel") : undefined,
          claudeOrdinal: index,
          claudeTotal,
          manyHeadsDispatch,
        });
      }
    } else {
      workers.push({
        agent,
        workerId: agent,
        traceIdOverride: enabled ? args.makeTraceId(agent, "parallel") : undefined,
        manyHeadsDispatch: false,
      });
    }
  }
  return workers;
}
```

In `src/panel.ts:runParallelDiscussionTurn`, pass the roster into the call (line 2862-2867):

```ts
      const workers = buildParallelDiscussionWorkers({
        manyHeads: manyHeadsMode(),
        transport: this.transportMode(),
        claudeWorkerCount: manyHeadsClaudeWorkerCount(),
        makeTraceId,
        roster: this.roster(),
      });
```

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/claudeWorkers.test.js`
Expected pass: `# fail 0` (roster fan-out, unchanged 2-head order, and preserved many-heads Claude fan-out).
Command: `pnpm run check` — expected exit 0.

- [ ] **Step 5: Commit**

`git add src/claudeWorkers.ts src/panel.ts test/claudeWorkers.test.ts && git commit -m "Seat the full roster into parallel discussion workers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 6: Prompt references to "the other heads"

**Files:**
- Modify: `src/prompts.ts` (`PromptInput` at lines 5-13; `buildPrompt` preamble at lines 96-113), `src/panel.ts` (the `buildPromptEnvelope({ agent, otherAgent, ... })` call sites for `parallel`/`review` phases — lines 2883-2889 and 3580-3587)
- Test: `test/prompts.test.ts` (append an "other heads" describe block)

**Interfaces:**
- Consumes: `displayNameFor` (SP1 replaced `AGENT_NAMES` in `prompts.ts` with it in SP1 Task 7).
- Produces: `PromptInput` gains an optional `otherAgents?: AgentId[]`; when present with more than one id, `buildPrompt` renders "and the other heads (Claude, Gemini)" instead of a single name, so a head in an N-way turn is told there are several peers.

Design note: `otherAgent` stays required (single-peer serial phases still use it). `otherAgents` is additive; panel passes it only for the array-based `parallel`/`review` fan-out. For a two-head turn `otherAgents` is either omitted or a single-element list, so the rendered preamble is unchanged.

- [ ] **Step 1: Write the failing test** (append to `test/prompts.test.ts`)

```ts
import { buildPrompt } from "../src/prompts";

describe("multi-head prompt preamble (SP3)", () => {
  test("names all peers when otherAgents lists more than one head", () => {
    const prompt = buildPrompt({
      agent: "codex",
      otherAgent: "claude",
      otherAgents: ["claude", "gemini"],
      phase: "parallel",
      transcript: "hi",
    });
    assert.match(prompt, /the other heads \(Claude, Gemini\)/);
  });

  test("two-head turn preamble is unchanged (single peer named)", () => {
    const prompt = buildPrompt({
      agent: "codex",
      otherAgent: "claude",
      phase: "opener",
      transcript: "hi",
    });
    assert.match(prompt, /a 3-way collaboration with the user/);
    assert.match(prompt, /and Claude\./);
    assert.doesNotMatch(prompt, /the other heads/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/prompts.test.js`
Expected failure: `tsc` errors — `otherAgents` is not a member of `PromptInput`.

- [ ] **Step 3: Implement minimally** — edit `src/prompts.ts`

Add the optional field to `PromptInput`:

```ts
export interface PromptInput {
  agent: AgentId;
  otherAgent: AgentId;
  otherAgents?: AgentId[];
  phase: Phase;
  transcript: string;
  diff?: string;
  verification?: string;
  nativeCapabilities?: string;
}
```

In `buildPrompt`, after `const them = displayNameFor(input.otherAgent);` (SP1's line ~98), compute the peer clause and use it in the preamble:

```ts
  const peers = (input.otherAgents ?? []).filter((id) => id !== input.agent).map((id) => displayNameFor(id));
  const peerClause = peers.length > 1 ? `the other heads (${peers.join(", ")})` : them;
```

Change the two preamble lines that name the peer (lines 104-107) to use `peerClause`:

```ts
    `You are ${me} in Hydra Room — a collaboration with the user`,
    `and ${peerClause}. The shared context below is Hydra's active transcript for this turn.`,
    `Do not invent prior context not in the shared context.`,
    `You are speaking to both the user and the other head(s).`,
```

(Keep "a 3-way collaboration with the user" for the single-peer path so Task 6's second test — and the existing 2-head prompt tests — stay green; only widen the wording when `peers.length > 1`. Concretely: `` `You are ${me} in Hydra Room — a ${peers.length > 1 ? "" : "3-way "}collaboration with the user`, ``.)

In `src/panel.ts`, add `otherAgents: this.roster()` to the `buildPromptEnvelope` calls in `runParallelDiscussionTurn` (line 2883) and `runParallelReviewPhase` (line 3580). Leave the serial opener/reactor/closer/build calls untouched (single peer).

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/prompts.test.js`
Expected pass: `# fail 0` (multi-head clause renders; two-head preamble unchanged).
Command: `pnpm run check` — expected exit 0.

- [ ] **Step 5: Commit**

`git add src/prompts.ts src/panel.ts test/prompts.test.ts && git commit -m "Reference the other heads plurally in N-way prompts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 7: Cost meter and status rail for N heads

**Files:**
- Modify: `media/webview.js` (`renderUsagePanel` per-agent stats at lines 1415-1421), `src/panel.ts` (the state payload's `roster` metadata — SP1 Task 11 already sends `roster: {id,displayName,colorIndex}[]`)
- Test: `test/webviewContract.test.ts` (append an N-head cost-meter assertion; the existing head-art / CSP hooks must still pass)

**Interfaces:**
- Consumes: SP1's `state.roster` webview metadata (`{ id, displayName, colorIndex }[]`) and SP1 Task 6's dynamic `summary.byAgent: Record<string, {...}>`.
- Produces: `renderUsagePanel` iterates `summary.byAgent` for every seated head instead of the hardcoded `agents.codex` / `agents.claude` pair, so a Gemini (or any Nth head) gets its own cost tile.

Design note: SP1 Task 6 already made `byAgent` dynamic and SP1 Task 11 already sends `roster` metadata and renders heads by color index. This task only generalizes the two hardcoded `usageStat("codex"...)` / `usageStat("claude"...)` tiles into a loop over the roster.

- [ ] **Step 1: Write the failing test** (append to `test/webviewContract.test.ts`)

```ts
test("usage panel renders a cost tile per seated head, not a hardcoded codex/claude pair", () => {
  const scriptBody = fs.readFileSync(path.join(process.cwd(), "media", "webview.js"), "utf8");
  const start = scriptBody.indexOf("function renderUsagePanel(");
  const end = scriptBody.indexOf("function ", start + 1);
  const body = scriptBody.slice(start, end);
  // The per-head tiles must be generated from the roster/byAgent map, not two literals.
  assert.doesNotMatch(body, /usageStat\(agentUsageLabel\("codex", agents\.codex\), "codex"\)/);
  assert.match(body, /rosterAgentIds|Object\.keys\(agents\)|lastState\.roster/);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/webviewContract.test.js`
Expected failure: the new test fails — `usageStat(agentUsageLabel("codex", agents.codex), "codex")` still matches (the hardcoded pair is present) and no roster-driven iteration exists.

- [ ] **Step 3: Implement minimally** — edit `media/webview.js`

Replace the hardcoded pair of per-agent tiles (lines 1415-1421) with a roster-driven loop:

```js
  const agents = summary.byAgent || {};
  // Per-head cost tiles, ordered by the seated roster (falls back to whatever
  // ids appear in byAgent so a head that acted without being seated still shows).
  const roster = (lastState.roster || []).map((head) => head.id);
  const seen = new Set();
  const rosterAgentIds = [];
  for (const id of roster.concat(Object.keys(agents))) {
    if (id && !seen.has(id)) { seen.add(id); rosterAgentIds.push(id); }
  }
  for (const id of rosterAgentIds) {
    usageSummary.append(usageStat(agentUsageLabel(id, agents[id]), id));
  }
  usageSummary.append(
    usageStat(formatTokens(summary.totalTokens || 0), "total incl. cache"),
    usageStat(formatTokens(week.totalTokens || 0), "7d total incl. cache")
  );
```

(Keep the `agentUsageLabel` helper as-is; it already takes an agent id and a per-agent summary entry.)

- [ ] **Step 4: Run to confirm pass**

Command: `tsc -p . && node --test dist/test/webviewContract.test.js dist/test/webviewCsp.test.js`
Expected pass: `# fail 0` — the roster-driven cost tiles pass AND every existing `webviewContract` hook (single `.head-art ` DOM site, CSP, breakpoints, `type=` on buttons) plus the CSP test remain green.

- [ ] **Step 5: Commit**

`git add media/webview.js test/webviewContract.test.ts && git commit -m "Render a per-head cost tile for every seated head

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 8: Regression + acceptance suite; full green

**Files:**
- Create: `test/nwayRooms.test.ts`
- Test: `test/nwayRooms.test.ts` + full `pnpm test`

**Interfaces:**
- Consumes: `transition`, `pickReviewers`, `DEFAULT_ROSTER` (`src/phases.ts`); `evaluateReviewConvergence` (`src/reviewConvergence.ts`); `buildParallelDiscussionWorkers` (`src/claudeWorkers.ts`).
- Produces: a locked acceptance suite proving (a) a 3-head room runs all-discuss / one-builds / two-review, (b) each convergence mode behaves as specified, (c) auto mode's risk gate is untouched, and (d) a default 2-head room still produces today's opener/reactor/closer/build/review sequence.

- [ ] **Step 1: Write the failing test**

```ts
// test/nwayRooms.test.ts
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { transition, pickReviewers, DEFAULT_ROSTER, type State } from "../src/phases";
import { buildParallelDiscussionWorkers } from "../src/claudeWorkers";
import { evaluateReviewConvergence, type ReviewVerdict } from "../src/reviewConvergence";

const ROSTER3 = ["codex", "claude", "gemini"] as const;
const v = (agent: string, approved: boolean): ReviewVerdict => ({ agent, approved });

describe("SP3 acceptance: 3-head room", () => {
  test("all-discuss seats every head as a parallel worker", () => {
    const workers = buildParallelDiscussionWorkers({
      manyHeads: false,
      transport: "oneShot",
      claudeWorkerCount: 3,
      makeTraceId: (agent) => `${agent}-t`,
      roster: [...ROSTER3],
    });
    assert.deepEqual(workers.map((worker) => worker.agent), ["codex", "claude", "gemini"]);
  });

  test("one-builds / two-review: codex builds, claude+gemini review, then hand back to codex", () => {
    const reviewers = pickReviewers("codex", [...ROSTER3]); // default "all"
    assert.deepEqual(reviewers, ["claude", "gemini"]);
    let s: State = transition({ name: "AwaitingUser" }, { type: "assignBuilder", builder: "codex" });
    assert.equal(s.name, "Build");
    s = transition(s, { type: "buildDone" });
    s = transition(s, { type: "requestReview", reviewers });
    assert.equal(s.name, "ParallelReview");
    assert.deepEqual((s as any).agents, ["claude", "gemini"]);
    s = transition(s, { type: "parallelReviewDone", approved: false });
    s = transition(s, { type: "handBack" });
    assert.equal(s.name, "Build");
    assert.equal((s as any).builder, "codex");
  });

  test("convergence modes over a 2-approve/1-reject split", () => {
    const split = [v("claude", true), v("gemini", true), v("codex", false)];
    assert.equal(evaluateReviewConvergence(split, "unanimous").approved, false);
    assert.equal(evaluateReviewConvergence(split, "majority").approved, true);
    assert.equal(evaluateReviewConvergence(split, "human").approved, false); // safe default
  });
});

describe("SP3 regression: default 2-head room unchanged", () => {
  test("opener -> reactor -> closer -> awaiting with codex+claude", () => {
    let s: State = transition({ name: "Idle" }, { type: "userSent", opener: "codex" });
    assert.equal(s.name, "Opener");
    assert.equal((s as any).reactor, "claude");
    s = transition(s, { type: "openerDone" });
    assert.equal(s.name, "Reactor");
    s = transition(s, { type: "reactorDone" });
    assert.equal(s.name, "Closer");
    s = transition(s, { type: "closerDone" });
    assert.equal(s.name, "AwaitingUser");
  });

  test("build -> single review -> hand back to the original builder", () => {
    const reviewers = pickReviewers("codex", [...DEFAULT_ROSTER]);
    assert.deepEqual(reviewers, ["claude"]);
    let s: State = transition({ name: "AwaitingUser" }, { type: "assignBuilder", builder: "codex" });
    s = transition(s, { type: "buildDone" });
    s = transition(s, { type: "requestReview", reviewers });
    assert.equal(s.name, "Review");
    assert.equal((s as any).reviewer, "claude");
    s = transition(s, { type: "reviewDone", approved: false });
    s = transition(s, { type: "handBack" });
    assert.equal(s.name, "Build");
    assert.equal((s as any).builder, "codex");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Command: `tsc -p . && node --test dist/test/nwayRooms.test.js`
Expected failure (if run before Tasks 2-5 land): compile/module errors or assertion failures. Run at the end of the sub-project — expected to pass immediately once Tasks 1-7 are complete; if any assertion fails, a prior task regressed behavior.

- [ ] **Step 3: Implement minimally**

No new production code — this task locks the acceptance criteria. If an assertion fails, fix the offending prior task (do not weaken the assertion). The auto-mode risk gate is verified by the untouched `test/panelSourceContract.test.ts:24` contract, which `pnpm test` runs.

- [ ] **Step 4: Run to confirm pass**

Command: `pnpm test`
Expected: the whole suite is green — `# fail 0`, including `reviewConvergence`, `phases`, `trustScopeContract`, `panelSourceContract`, `claudeWorkers`, `prompts`, `webviewContract`, `webviewCsp`, `nwayRooms`, and every SP1 suite (`agentRegistry`, `codexAdapter`, `claudeAdapter`, `geminiAdapter`, `usage`).

- [ ] **Step 5: Commit**

`git add test/nwayRooms.test.ts && git commit -m "Lock SP3 acceptance: 3-head room, convergence modes, 2-head regression

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`
