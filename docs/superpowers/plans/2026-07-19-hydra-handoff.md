# Hydra Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global `/hydra-handoff` skill (Claude Code + Codex CLI) that writes a handoff packet into `.hydra/handoff-inbox/`, and a Hydra extension feature that surfaces the packet as a one-click confirm chip in the room.

**Architecture:** A new free-function + controller module `src/handoffInbox.ts` validates packets, scans the inbox directory, and (via a narrow deps object, mirroring `src/telegramController.ts`) watches the directory and drives a webview confirm chip. Confirm routes through the single existing `panel.sendUserMessage(text, opener)` entry point — no new spawn paths. The skill is one canonical `SKILL.md` copied to both agents' skill homes by a Node installer script.

**Tech Stack:** TypeScript (VS Code extension), Node's built-in `node:test` runner, plain-JS webview (`media/webview.js`), CommonJS Node scripts.

## Global Constraints

- Package manager: `pnpm@11.1.3` via Corepack. Test command: `pnpm run test:fast` (compiles `tsc --incremental` → `dist/`, then `node --test dist/test/*.test.js`). Single file: `tsc -p . && node --test dist/test/handoffInbox.test.js`.
- No new `: any`. New webview message types go in `src/webviewMessages.ts` (the discriminated union) FIRST.
- Every `<button>` in `src/webview.html.ts` MUST carry `type="button"` (pinned by `test/webviewContract.test.ts:312`).
- Every scripted DOM id MUST be added to `boundIds` in `test/webviewContract.test.ts`; every `vscode.postMessage({ type })` value MUST be added to `hostMessages` there.
- Webview CSP forbids inline scripts/handlers — use `addEventListener` only.
- `catch {}` blocks get a one-line `// why it's safe` comment (house style).
- `Why:` comments only when the why is non-obvious; no what-comments.
- `.hydra/` is already gitignored — no gitignore change needed.
- Trust gate: ingest only runs when `vscode.workspace.isTrusted === true` AND the workspace is ready.
- The handoff packet is UNTRUSTED input (anything can write to `.hydra/`). Nothing auto-runs; confirmation is mandatory.

---

### Task 1: Packet types and validation (pure)

**Files:**
- Create: `src/handoffInbox.ts`
- Test: `test/handoffInbox.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `type HandoffAction = "discuss" | "askBoth" | "buildCodex" | "buildClaude"`
  - `interface HandoffPacket { version: 1; createdAt: string; source: string; title: string; prompt: string; suggestedAction: HandoffAction; context?: { branch?: string; filesTouched?: string[] } }`
  - `const HANDOFF_ACTIONS: readonly HandoffAction[]`
  - `const HANDOFF_MAX_FILE_BYTES`, `HANDOFF_MAX_TITLE_CHARS`, `HANDOFF_MAX_FILES_TOUCHED`, `HANDOFF_MAX_SOURCE_CHARS`
  - `type HandoffValidationResult = { ok: true; packet: HandoffPacket } | { ok: false; reason: string }`
  - `function validateHandoffPacket(raw: unknown): HandoffValidationResult`

- [ ] **Step 1: Write the failing test**

Create `test/handoffInbox.test.ts`:

```ts
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  HANDOFF_ACTIONS,
  HANDOFF_MAX_TITLE_CHARS,
  validateHandoffPacket,
} from "../src/handoffInbox";

function goodRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    createdAt: "2026-07-19T18:30:00Z",
    source: "claude-code",
    title: "Finish JSONL compaction refactor",
    prompt: "## Objective\nDo the thing.",
    suggestedAction: "askBoth",
    context: { branch: "agent/x", filesTouched: ["src/foo.ts"] },
    ...overrides,
  };
}

describe("validateHandoffPacket", () => {
  test("accepts a well-formed packet and normalizes it", () => {
    const result = validateHandoffPacket(goodRaw());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.packet.title, "Finish JSONL compaction refactor");
    assert.equal(result.packet.suggestedAction, "askBoth");
    assert.deepEqual(result.packet.context?.filesTouched, ["src/foo.ts"]);
  });

  test("rejects a non-object", () => {
    assert.equal(validateHandoffPacket("nope").ok, false);
    assert.equal(validateHandoffPacket(null).ok, false);
  });

  test("rejects an unsupported version", () => {
    assert.equal(validateHandoffPacket(goodRaw({ version: 2 })).ok, false);
  });

  test("rejects a missing or empty title", () => {
    assert.equal(validateHandoffPacket(goodRaw({ title: "" })).ok, false);
    assert.equal(validateHandoffPacket(goodRaw({ title: "   " })).ok, false);
    assert.equal(validateHandoffPacket(goodRaw({ title: 123 })).ok, false);
  });

  test("rejects an over-long title", () => {
    assert.equal(validateHandoffPacket(goodRaw({ title: "x".repeat(HANDOFF_MAX_TITLE_CHARS + 1) })).ok, false);
  });

  test("rejects a missing or empty prompt", () => {
    assert.equal(validateHandoffPacket(goodRaw({ prompt: "" })).ok, false);
    assert.equal(validateHandoffPacket(goodRaw({ prompt: undefined })).ok, false);
  });

  test("rejects an invalid suggestedAction", () => {
    assert.equal(validateHandoffPacket(goodRaw({ suggestedAction: "nuke" })).ok, false);
    assert.equal(validateHandoffPacket(goodRaw({ suggestedAction: undefined })).ok, false);
  });

  test("accepts every declared action", () => {
    for (const action of HANDOFF_ACTIONS) {
      assert.equal(validateHandoffPacket(goodRaw({ suggestedAction: action })).ok, true, action);
    }
  });

  test("tolerates a missing context and caps filesTouched at the limit", () => {
    const noCtx = validateHandoffPacket(goodRaw({ context: undefined }));
    assert.equal(noCtx.ok, true);
    const many = Array.from({ length: 200 }, (_v, i) => `f${i}.ts`);
    const capped = validateHandoffPacket(goodRaw({ context: { filesTouched: many } }));
    assert.equal(capped.ok, true);
    if (!capped.ok) return;
    assert.equal(capped.packet.context?.filesTouched?.length, 50);
  });

  test("drops non-string filesTouched entries defensively", () => {
    const result = validateHandoffPacket(goodRaw({ context: { filesTouched: ["ok.ts", 5, null, "ok2.ts"] } }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.packet.context?.filesTouched, ["ok.ts", "ok2.ts"]);
  });

  test("falls back to a safe source for a missing/over-long source", () => {
    const missing = validateHandoffPacket(goodRaw({ source: undefined }));
    assert.equal(missing.ok, true);
    if (!missing.ok) return;
    assert.equal(missing.packet.source, "unknown");
    const long = validateHandoffPacket(goodRaw({ source: "z".repeat(500) }));
    assert.equal(long.ok, true);
    if (!long.ok) return;
    assert.ok(long.packet.source.length <= 40);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -p . && node --test dist/test/handoffInbox.test.js`
Expected: FAIL — `Cannot find module '../src/handoffInbox'` (or compile error).

- [ ] **Step 3: Write minimal implementation**

Create `src/handoffInbox.ts`:

```ts
// Handoff inbox: validates and ingests handoff packets that the /hydra-handoff
// skill (Claude Code / Codex CLI) drops into <workspace>/.hydra/handoff-inbox/.
// Packets are UNTRUSTED (anything can write to .hydra/), so this module only
// parses and surfaces them — nothing here ever spawns an agent. The room's
// confirm chip is the mandatory gate.

export type HandoffAction = "discuss" | "askBoth" | "buildCodex" | "buildClaude";

export interface HandoffPacket {
  version: 1;
  createdAt: string;
  source: string;
  title: string;
  prompt: string;
  suggestedAction: HandoffAction;
  context?: { branch?: string; filesTouched?: string[] };
}

export const HANDOFF_ACTIONS: readonly HandoffAction[] = [
  "discuss",
  "askBoth",
  "buildCodex",
  "buildClaude",
];

export const HANDOFF_MAX_FILE_BYTES = 256 * 1024;
export const HANDOFF_MAX_TITLE_CHARS = 200;
export const HANDOFF_MAX_FILES_TOUCHED = 50;
export const HANDOFF_MAX_SOURCE_CHARS = 40;

export type HandoffValidationResult =
  | { ok: true; packet: HandoffPacket }
  | { ok: false; reason: string };

function isHandoffAction(value: unknown): value is HandoffAction {
  return typeof value === "string" && (HANDOFF_ACTIONS as readonly string[]).includes(value);
}

export function validateHandoffPacket(raw: unknown): HandoffValidationResult {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "packet is not an object" };
  const p = raw as Record<string, unknown>;

  if (p.version !== 1) return { ok: false, reason: `unsupported version: ${String(p.version)}` };
  if (typeof p.title !== "string" || !p.title.trim()) return { ok: false, reason: "title missing or empty" };
  if (p.title.length > HANDOFF_MAX_TITLE_CHARS) return { ok: false, reason: "title too long" };
  if (typeof p.prompt !== "string" || !p.prompt.trim()) return { ok: false, reason: "prompt missing or empty" };
  if (!isHandoffAction(p.suggestedAction)) {
    return { ok: false, reason: `invalid suggestedAction: ${String(p.suggestedAction)}` };
  }

  const source =
    typeof p.source === "string" && p.source.trim()
      ? p.source.slice(0, HANDOFF_MAX_SOURCE_CHARS)
      : "unknown";
  const createdAt = typeof p.createdAt === "string" ? p.createdAt : "";

  let context: HandoffPacket["context"];
  if (p.context && typeof p.context === "object") {
    const c = p.context as Record<string, unknown>;
    const branch = typeof c.branch === "string" ? c.branch : undefined;
    let filesTouched: string[] | undefined;
    if (Array.isArray(c.filesTouched)) {
      filesTouched = c.filesTouched
        .filter((x): x is string => typeof x === "string")
        .slice(0, HANDOFF_MAX_FILES_TOUCHED);
    }
    context = { branch, filesTouched };
  }

  return {
    ok: true,
    packet: {
      version: 1,
      createdAt,
      source,
      title: p.title,
      prompt: p.prompt,
      suggestedAction: p.suggestedAction,
      context,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -p . && node --test dist/test/handoffInbox.test.js`
Expected: PASS (all `validateHandoffPacket` tests green).

- [ ] **Step 5: Commit**

```bash
git add src/handoffInbox.ts test/handoffInbox.test.ts
git commit -m "feat(handoff): packet types and validation"
```

---

### Task 2: Inbox filesystem helpers (scan + move)

**Files:**
- Modify: `src/handoffInbox.ts` (append)
- Test: `test/handoffInbox.test.ts` (append)

**Interfaces:**
- Consumes: `HandoffPacket`, `validateHandoffPacket`, `HANDOFF_MAX_FILE_BYTES` (Task 1).
- Produces:
  - `function handoffInboxDir(workspaceRoot: string): string`
  - `function handoffConsumedDir(workspaceRoot: string): string`
  - `function handoffRejectedDir(workspaceRoot: string): string`
  - `function ensureHandoffInboxDirs(workspaceRoot: string): Promise<void>`
  - `interface ScannedHandoff { file: string; packet: HandoffPacket }`
  - `interface HandoffScanResult { valid: ScannedHandoff[]; rejected: { file: string; reason: string }[] }`
  - `function scanHandoffInbox(workspaceRoot: string): Promise<HandoffScanResult>`
  - `function moveHandoffFile(file: string, destDir: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Append to `test/handoffInbox.test.ts` (add these imports to the existing import block at the top: `scanHandoffInbox`, `moveHandoffFile`, `handoffInboxDir`, `handoffConsumedDir`, `handoffRejectedDir`, `ensureHandoffInboxDirs`, `HANDOFF_MAX_FILE_BYTES`; and add `import * as fs from "node:fs/promises"; import * as os from "node:os"; import * as path from "node:path";`):

```ts
describe("scanHandoffInbox", () => {
  async function tmpWorkspace(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-handoff-"));
    await ensureHandoffInboxDirs(root);
    return root;
  }
  async function writePacket(root: string, name: string, body: unknown): Promise<string> {
    const file = path.join(handoffInboxDir(root), name);
    await fs.writeFile(file, typeof body === "string" ? body : JSON.stringify(body), "utf8");
    return file;
  }
  function goodPacket(): Record<string, unknown> {
    return {
      version: 1,
      createdAt: "2026-07-19T18:30:00Z",
      source: "codex",
      title: "Do the thing",
      prompt: "Please do the thing.",
      suggestedAction: "discuss",
    };
  }

  test("returns an empty result when the inbox does not exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-handoff-empty-"));
    const scan = await scanHandoffInbox(root);
    assert.deepEqual(scan.valid, []);
    assert.deepEqual(scan.rejected, []);
  });

  test("collects a valid packet and ignores .tmp and subdirectories", async () => {
    const root = await tmpWorkspace();
    await writePacket(root, "20260719T183000Z-do-the-thing.json", goodPacket());
    await writePacket(root, "20260719T183001Z-half-written.json.tmp", goodPacket());
    const scan = await scanHandoffInbox(root);
    assert.equal(scan.valid.length, 1);
    assert.equal(scan.rejected.length, 0);
    assert.equal(scan.valid[0].packet.title, "Do the thing");
  });

  test("rejects malformed JSON and oversized files", async () => {
    const root = await tmpWorkspace();
    await writePacket(root, "20260719T183000Z-bad.json", "{ not json");
    await writePacket(root, "20260719T183002Z-big.json", "x".repeat(HANDOFF_MAX_FILE_BYTES + 1));
    const scan = await scanHandoffInbox(root);
    assert.equal(scan.valid.length, 0);
    assert.equal(scan.rejected.length, 2);
  });

  test("rejects a schema-invalid packet", async () => {
    const root = await tmpWorkspace();
    await writePacket(root, "20260719T183000Z-nope.json", { version: 1, title: "", prompt: "", suggestedAction: "x" });
    const scan = await scanHandoffInbox(root);
    assert.equal(scan.valid.length, 0);
    assert.equal(scan.rejected.length, 1);
  });
});

describe("moveHandoffFile", () => {
  test("moves a file into the destination directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-handoff-move-"));
    await ensureHandoffInboxDirs(root);
    const file = path.join(handoffInboxDir(root), "20260719T183000Z-x.json");
    await fs.writeFile(file, "{}", "utf8");
    await moveHandoffFile(file, handoffConsumedDir(root));
    await assert.rejects(() => fs.access(file));
    await fs.access(path.join(handoffConsumedDir(root), "20260719T183000Z-x.json"));
  });

  test("does not throw when the source was already moved", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-handoff-move2-"));
    await ensureHandoffInboxDirs(root);
    const missing = path.join(handoffInboxDir(root), "gone.json");
    await moveHandoffFile(missing, handoffRejectedDir(root));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -p . && node --test dist/test/handoffInbox.test.js`
Expected: FAIL — `scanHandoffInbox`/`moveHandoffFile` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/handoffInbox.ts` (add imports at the top of the file, under the header comment):

```ts
import * as fs from "node:fs/promises";
import * as path from "node:path";

export function handoffInboxDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".hydra", "handoff-inbox");
}

export function handoffConsumedDir(workspaceRoot: string): string {
  return path.join(handoffInboxDir(workspaceRoot), "consumed");
}

export function handoffRejectedDir(workspaceRoot: string): string {
  return path.join(handoffInboxDir(workspaceRoot), "rejected");
}

export async function ensureHandoffInboxDirs(workspaceRoot: string): Promise<void> {
  // Creating the leaf children creates the parent inbox dir too.
  await fs.mkdir(handoffConsumedDir(workspaceRoot), { recursive: true });
  await fs.mkdir(handoffRejectedDir(workspaceRoot), { recursive: true });
}

export interface ScannedHandoff {
  file: string;
  packet: HandoffPacket;
}

export interface HandoffScanResult {
  valid: ScannedHandoff[];
  rejected: { file: string; reason: string }[];
}

export async function scanHandoffInbox(workspaceRoot: string): Promise<HandoffScanResult> {
  const dir = handoffInboxDir(workspaceRoot);
  const result: HandoffScanResult = { valid: [], rejected: [] };

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    // ENOENT before the inbox is ensured on first run — nothing to scan.
    return result;
  }

  for (const name of entries) {
    // Only *.json are packets. This skips *.tmp half-writes and the
    // consumed/ and rejected/ subdirectory names.
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);

    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      // Vanished between readdir and stat (concurrent consume) — skip.
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > HANDOFF_MAX_FILE_BYTES) {
      result.rejected.push({ file, reason: `file exceeds ${HANDOFF_MAX_FILE_BYTES} bytes` });
      continue;
    }

    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      // Race with a consume/reject move — skip; a later scan re-reads if present.
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      result.rejected.push({ file, reason: "invalid JSON" });
      continue;
    }

    const validation = validateHandoffPacket(parsed);
    if (validation.ok) result.valid.push({ file, packet: validation.packet });
    else result.rejected.push({ file, reason: validation.reason });
  }

  return result;
}

export async function moveHandoffFile(file: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(file));
  try {
    await fs.rename(file, dest);
  } catch {
    // rename fails across devices, or on Windows when dest exists. Fall back to
    // copy+unlink; if the source is already gone (concurrent scan), do nothing.
    try {
      await fs.copyFile(file, dest);
      await fs.unlink(file);
    } catch {
      // Source already moved by a concurrent scan — nothing to do.
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -p . && node --test dist/test/handoffInbox.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/handoffInbox.ts test/handoffInbox.test.ts
git commit -m "feat(handoff): inbox scan and move helpers"
```

---

### Task 3: HandoffInboxController (deps + watcher + confirm/dismiss)

**Files:**
- Modify: `src/handoffInbox.ts` (append)
- Test: `test/handoffInbox.test.ts` (append)

**Interfaces:**
- Consumes: everything from Tasks 1-2.
- Produces:
  - `interface HandoffInboxDeps { workspaceRoot(): string; isReady(): boolean; appendSystemMessage(text: string): Promise<void>; postState(): void; runHandoff(action: HandoffAction, prompt: string): Promise<void>; openMarkdownPreview(title: string, body: string): Promise<void> }`
  - `interface PendingHandoffSummary { title: string; source: string; suggestedAction: HandoffAction }`
  - `class HandoffInboxController { constructor(deps: HandoffInboxDeps); start(): Promise<void>; scanNow(): Promise<void>; pending(): PendingHandoffSummary | undefined; confirm(overrideAction?: HandoffAction): Promise<void>; dismiss(): Promise<void>; preview(): Promise<void>; dispose(): void }`

- [ ] **Step 1: Write the failing test**

Append to `test/handoffInbox.test.ts` (add `HandoffInboxController`, `HandoffAction`, `PendingHandoffSummary` to the imports; `HandoffAction`/`PendingHandoffSummary` are type-only so use `import type` for them):

```ts
describe("HandoffInboxController", () => {
  function makeDeps(root: string) {
    const calls = {
      system: [] as string[],
      handoffs: [] as { action: string; prompt: string }[],
      previews: [] as { title: string; body: string }[],
      posts: 0,
    };
    const deps = {
      workspaceRoot: () => root,
      isReady: () => true,
      appendSystemMessage: async (t: string) => { calls.system.push(t); },
      postState: () => { calls.posts += 1; },
      runHandoff: async (action: string, prompt: string) => { calls.handoffs.push({ action, prompt }); },
      openMarkdownPreview: async (title: string, body: string) => { calls.previews.push({ title, body }); },
    };
    return { deps, calls };
  }
  function goodPacket(action = "discuss"): Record<string, unknown> {
    return { version: 1, createdAt: "t", source: "codex", title: "Do X", prompt: "Body", suggestedAction: action };
  }
  async function tmpWorkspace(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-handoff-ctrl-"));
    await ensureHandoffInboxDirs(root);
    return root;
  }

  test("scanNow surfaces the oldest valid packet as pending and announces it", async () => {
    const root = await tmpWorkspace();
    const { deps, calls } = makeDeps(root);
    await fs.writeFile(path.join(handoffInboxDir(root), "20260719T183001Z-b.json"), JSON.stringify(goodPacket()), "utf8");
    await fs.writeFile(path.join(handoffInboxDir(root), "20260719T183000Z-a.json"), JSON.stringify(goodPacket("askBoth")), "utf8");
    const ctrl = new HandoffInboxController(deps);
    await ctrl.scanNow();
    const pending = ctrl.pending();
    assert.ok(pending);
    assert.equal(pending?.suggestedAction, "askBoth"); // the -a file sorts first
    assert.equal(calls.system.length, 1);
    ctrl.dispose();
  });

  test("scanNow quarantines a rejected packet and keeps scanning", async () => {
    const root = await tmpWorkspace();
    const { deps, calls } = makeDeps(root);
    await fs.writeFile(path.join(handoffInboxDir(root), "20260719T183000Z-bad.json"), "{ broken", "utf8");
    const ctrl = new HandoffInboxController(deps);
    await ctrl.scanNow();
    assert.equal(ctrl.pending(), undefined);
    await fs.access(path.join(handoffRejectedDir(root), "20260719T183000Z-bad.json"));
    assert.ok(calls.system.some((m) => m.includes("rejected")));
    ctrl.dispose();
  });

  test("confirm runs the suggested action, moves the file to consumed, clears pending", async () => {
    const root = await tmpWorkspace();
    const { deps, calls } = makeDeps(root);
    const file = path.join(handoffInboxDir(root), "20260719T183000Z-x.json");
    await fs.writeFile(file, JSON.stringify(goodPacket("discuss")), "utf8");
    const ctrl = new HandoffInboxController(deps);
    await ctrl.scanNow();
    await ctrl.confirm();
    assert.equal(ctrl.pending(), undefined);
    assert.deepEqual(calls.handoffs, [{ action: "discuss", prompt: "Body" }]);
    await fs.access(path.join(handoffConsumedDir(root), "20260719T183000Z-x.json"));
    ctrl.dispose();
  });

  test("confirm honors an override action", async () => {
    const root = await tmpWorkspace();
    const { deps, calls } = makeDeps(root);
    await fs.writeFile(path.join(handoffInboxDir(root), "20260719T183000Z-x.json"), JSON.stringify(goodPacket("discuss")), "utf8");
    const ctrl = new HandoffInboxController(deps);
    await ctrl.scanNow();
    await ctrl.confirm("buildClaude");
    assert.equal(calls.handoffs[0].action, "buildClaude");
    ctrl.dispose();
  });

  test("dismiss archives the packet without running it", async () => {
    const root = await tmpWorkspace();
    const { deps, calls } = makeDeps(root);
    const file = path.join(handoffInboxDir(root), "20260719T183000Z-x.json");
    await fs.writeFile(file, JSON.stringify(goodPacket()), "utf8");
    const ctrl = new HandoffInboxController(deps);
    await ctrl.scanNow();
    await ctrl.dismiss();
    assert.equal(ctrl.pending(), undefined);
    assert.equal(calls.handoffs.length, 0);
    await fs.access(path.join(handoffConsumedDir(root), "20260719T183000Z-x.json"));
    ctrl.dispose();
  });

  test("preview forwards the pending packet body", async () => {
    const root = await tmpWorkspace();
    const { deps, calls } = makeDeps(root);
    await fs.writeFile(path.join(handoffInboxDir(root), "20260719T183000Z-x.json"), JSON.stringify(goodPacket()), "utf8");
    const ctrl = new HandoffInboxController(deps);
    await ctrl.scanNow();
    await ctrl.preview();
    assert.deepEqual(calls.previews, [{ title: "Do X", body: "Body" }]);
    ctrl.dispose();
  });

  test("scanNow does not replace a packet already pending confirmation", async () => {
    const root = await tmpWorkspace();
    const { deps } = makeDeps(root);
    await fs.writeFile(path.join(handoffInboxDir(root), "20260719T183000Z-a.json"), JSON.stringify(goodPacket("discuss")), "utf8");
    const ctrl = new HandoffInboxController(deps);
    await ctrl.scanNow();
    const first = ctrl.pending();
    await fs.writeFile(path.join(handoffInboxDir(root), "20260719T183001Z-b.json"), JSON.stringify(goodPacket("askBoth")), "utf8");
    await ctrl.scanNow();
    assert.equal(ctrl.pending()?.suggestedAction, first?.suggestedAction);
    ctrl.dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -p . && node --test dist/test/handoffInbox.test.js`
Expected: FAIL — `HandoffInboxController` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to the imports at the top of `src/handoffInbox.ts` (extend the `node:fs` import — the controller needs the sync `watch`):

```ts
import { watch as watchFileSystem, type FSWatcher } from "node:fs";
```

Append the controller to `src/handoffInbox.ts`:

```ts
export interface HandoffInboxDeps {
  workspaceRoot(): string;
  // Ready = workspace folder loaded AND workspace trusted. Handoff ingest is
  // gated on both; see panel wiring.
  isReady(): boolean;
  appendSystemMessage(text: string): Promise<void>;
  postState(): void;
  // Routes an accepted handoff through the panel's single sendUserMessage entry
  // point. The panel maps action -> (opener, framing); this module never spawns.
  runHandoff(action: HandoffAction, prompt: string): Promise<void>;
  openMarkdownPreview(title: string, body: string): Promise<void>;
}

export interface PendingHandoffSummary {
  title: string;
  source: string;
  suggestedAction: HandoffAction;
}

/**
 * Owns the .hydra/handoff-inbox watcher and drives the room's confirm chip.
 *
 * Untrusted-input invariants:
 *  - nothing here runs an agent; confirm() only calls deps.runHandoff after an
 *    explicit user click,
 *  - one packet is presented at a time (a pending chip blocks re-scan), so a
 *    flood of packets cannot spam the room,
 *  - rejected packets are quarantined to rejected/ so they cannot re-fire.
 */
export class HandoffInboxController {
  private watcher: FSWatcher | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private pendingPacket: HandoffPacket | undefined;
  private pendingFile: string | undefined;

  constructor(private readonly deps: HandoffInboxDeps) {}

  async start(): Promise<void> {
    if (this.disposed || !this.deps.isReady()) return;
    try {
      await ensureHandoffInboxDirs(this.deps.workspaceRoot());
    } catch {
      // Cannot create inbox dirs (read-only FS / perms). Handoff ingest is a
      // best-effort convenience; degrade silently rather than block the room.
      return;
    }
    await this.scanNow();
    this.startWatcher();
  }

  private startWatcher(): void {
    try {
      const dir = handoffInboxDir(this.deps.workspaceRoot());
      const watcher = watchFileSystem(dir, { persistent: false }, () => {
        if (this.disposed) return;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = undefined;
          void this.scanNow();
        }, 300);
      });
      // Watch failure must not crash the host; scan-on-open already surfaced
      // anything written before the room opened.
      watcher.on("error", () => watcher.close());
      this.watcher = watcher;
    } catch {
      // Some remote/custom filesystems cannot be watched. Scan-on-open remains.
    }
  }

  async scanNow(): Promise<void> {
    if (this.disposed || !this.deps.isReady()) return;
    // One at a time: a pending chip must be resolved before the next surfaces.
    if (this.pendingPacket) return;

    const root = this.deps.workspaceRoot();
    const scan = await scanHandoffInbox(root);

    for (const bad of scan.rejected) {
      await moveHandoffFile(bad.file, handoffRejectedDir(root));
      await this.deps.appendSystemMessage(
        `Hydra rejected a handoff packet (${basename(bad.file)}): ${bad.reason}. Moved to handoff-inbox/rejected/.`
      );
    }

    if (!scan.valid.length) {
      if (scan.rejected.length) this.deps.postState();
      return;
    }

    // Filenames are timestamp-prefixed, so lexicographic order is chronological.
    const chosen = scan.valid
      .slice()
      .sort((a, b) => basename(a.file).localeCompare(basename(b.file)))[0];
    this.pendingPacket = chosen.packet;
    this.pendingFile = chosen.file;
    await this.deps.appendSystemMessage(
      `Handoff from ${chosen.packet.source}: "${chosen.packet.title}". Confirm in the banner to run it, or dismiss it.`
    );
    this.deps.postState();
  }

  pending(): PendingHandoffSummary | undefined {
    if (!this.pendingPacket) return undefined;
    return {
      title: this.pendingPacket.title,
      source: this.pendingPacket.source,
      suggestedAction: this.pendingPacket.suggestedAction,
    };
  }

  async confirm(overrideAction?: HandoffAction): Promise<void> {
    const packet = this.pendingPacket;
    const file = this.pendingFile;
    if (!packet || !file) return;
    const action = overrideAction && isHandoffActionExported(overrideAction) ? overrideAction : packet.suggestedAction;
    // Clear pending and archive BEFORE the (possibly long) turn so a watcher
    // re-scan cannot re-present the same packet.
    this.pendingPacket = undefined;
    this.pendingFile = undefined;
    await moveHandoffFile(file, handoffConsumedDir(this.deps.workspaceRoot()));
    this.deps.postState();
    await this.deps.runHandoff(action, packet.prompt);
  }

  async dismiss(): Promise<void> {
    const file = this.pendingFile;
    this.pendingPacket = undefined;
    this.pendingFile = undefined;
    if (file) await moveHandoffFile(file, handoffConsumedDir(this.deps.workspaceRoot()));
    await this.deps.appendSystemMessage("Handoff dismissed.");
    this.deps.postState();
    // Slot is free; surface the next queued packet if any.
    await this.scanNow();
  }

  async preview(): Promise<void> {
    const packet = this.pendingPacket;
    if (!packet) return;
    await this.deps.openMarkdownPreview(packet.title, packet.prompt);
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.watcher?.close();
  }
}

function basename(file: string): string {
  return path.basename(file);
}

function isHandoffActionExported(value: string): value is HandoffAction {
  return (HANDOFF_ACTIONS as readonly string[]).includes(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -p . && node --test dist/test/handoffInbox.test.js`
Expected: PASS (all controller tests green).

- [ ] **Step 5: Commit**

```bash
git add src/handoffInbox.ts test/handoffInbox.test.ts
git commit -m "feat(handoff): inbox controller with confirm/dismiss/preview"
```

---

### Task 4: Webview confirm chip (messages + HTML + JS + contract tests)

**Files:**
- Modify: `src/webviewMessages.ts`
- Modify: `src/webview.html.ts` (inside `ribbonStack`, before its closing `</div>` at line ~1651)
- Modify: `media/webview.js`
- Modify: `test/webviewContract.test.ts`

**Interfaces:**
- Consumes: `HandoffAction` (Task 1); the `pendingHandoff` field posted by panel `postState` (Task 5) — shape `{ title: string; source: string; suggestedAction: HandoffAction } | null`.
- Produces: webview messages `{ type: "confirmHandoff"; action?: HandoffAction }`, `{ type: "dismissHandoff" }`, `{ type: "previewHandoff" }`; DOM ids `handoffStrip`, `handoffTitle`, `handoffSource`, `handoffAction`, `handoffConfirmBtn`, `handoffPreviewBtn`, `handoffDismissBtn`.

- [ ] **Step 1: Add the message types (no test yet — types compile-checked)**

In `src/webviewMessages.ts`, add the import at the top:

```ts
import type { HandoffAction } from "./handoffInbox";
```

Add these three variants to the `WebviewMessage` union (place them just after the `{ type: "handBack" }` line):

```ts
  | { type: "confirmHandoff"; action?: HandoffAction }
  | { type: "dismissHandoff" }
  | { type: "previewHandoff" }
```

- [ ] **Step 2: Write the failing contract test**

In `test/webviewContract.test.ts`, add the seven ids to the `boundIds` array and the three types to the `hostMessages` array. Then add this focused test at the end of the file (before the final closing brace of the suite):

```ts
test("renders the handoff confirm chip and wires its controls", () => {
  assert.match(html, /id="handoffStrip"/);
  assert.match(html, /<select id="handoffAction"/);
  assert.match(html, /<button id="handoffConfirmBtn" [^>]*type="button"/);
  assert.match(html, /<button id="handoffPreviewBtn" [^>]*type="button"/);
  assert.match(html, /<button id="handoffDismissBtn" [^>]*type="button"/);
  assert.match(surface, /vscode\.postMessage\(\{ type: "confirmHandoff", action: [^}]+\}\)/);
  assert.match(surface, /vscode\.postMessage\(\{ type: "dismissHandoff" \}\)/);
  assert.match(surface, /vscode\.postMessage\(\{ type: "previewHandoff" \}\)/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `tsc -p . && node --test dist/test/webviewContract.test.js`
Expected: FAIL — missing `#handoffStrip` (and the new `boundIds`/`hostMessages` entries assert missing).

- [ ] **Step 4: Add the chip HTML**

In `src/webview.html.ts`, inside `<div class="ribbon-stack" id="ribbonStack">`, immediately after the `decisionStrip` block's closing `</div>` and before `ribbonStack`'s own closing `</div>` (line ~1650-1651), insert:

```html
<div id="handoffStrip" class="decision-strip hidden">
  <div class="decision-title">Handoff<span id="handoffSource" class="decision-count"></span><button class="secondary ribbon-collapse-btn" type="button" data-ribbon-toggle="handoffStrip" data-ribbon-label="Handoff" aria-label="Collapse Handoff" title="Collapse Handoff" aria-expanded="true">&#8722;</button></div>
  <div class="decision-field decision-needed"><strong>Queued handoff</strong><span id="handoffTitle">None</span></div>
  <div class="decision-actions">
    <label class="handoff-action-label">Run as
      <select id="handoffAction" class="handoff-action-select">
        <option value="discuss">Discuss</option>
        <option value="askBoth">Ask all heads</option>
        <option value="buildCodex">Build (Codex)</option>
        <option value="buildClaude">Build (Claude)</option>
      </select>
    </label>
    <button id="handoffConfirmBtn" class="suggested" type="button">Confirm</button>
    <button id="handoffPreviewBtn" class="secondary" type="button">Preview</button>
    <button id="handoffDismissBtn" class="secondary" type="button">Dismiss</button>
  </div>
</div>
```

- [ ] **Step 5: Wire the chip in `media/webview.js`**

Add element handles near the other `getElementById` calls (~lines 41-110):

```js
const handoffStrip = document.getElementById("handoffStrip");
const handoffTitle = document.getElementById("handoffTitle");
const handoffSource = document.getElementById("handoffSource");
const handoffAction = document.getElementById("handoffAction");
const handoffConfirmBtn = document.getElementById("handoffConfirmBtn");
const handoffPreviewBtn = document.getElementById("handoffPreviewBtn");
const handoffDismissBtn = document.getElementById("handoffDismissBtn");
```

Add click handlers near the other direct handlers (~lines 325-369):

```js
handoffConfirmBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "confirmHandoff", action: handoffAction.value });
});
handoffPreviewBtn.addEventListener("click", () => vscode.postMessage({ type: "previewHandoff" }));
handoffDismissBtn.addEventListener("click", () => vscode.postMessage({ type: "dismissHandoff" }));
```

Add the render function (place it next to `renderDecision`):

```js
function renderHandoff(pending) {
  handoffStrip.classList.toggle("hidden", !pending);
  if (!pending) return;
  handoffTitle.textContent = pending.title || "Untitled handoff";
  handoffSource.textContent = pending.source ? " (" + pending.source + ")" : "";
  if (pending.suggestedAction) handoffAction.value = pending.suggestedAction;
}
```

Call it from `renderState` (near the `renderDecision(...)` call):

```js
renderHandoff(msg.pendingHandoff);
```

Add `"handoffStrip"` to the ribbon ids array at line ~795:

```js
["setupStrip", "verificationStrip", "nativeActionStrip", "workQueueStrip", "decisionStrip", "handoffStrip"]
```

- [ ] **Step 6: Run test to verify it passes**

Run: `tsc -p . && node --test dist/test/webviewContract.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/webviewMessages.ts src/webview.html.ts media/webview.js test/webviewContract.test.ts
git commit -m "feat(handoff): webview confirm chip"
```

---

### Task 5: Panel wiring (construct, start, dispose, route, postState)

**Files:**
- Modify: `src/panel.ts`
- Modify: `test/panelSourceContract.test.ts`

**Interfaces:**
- Consumes: `HandoffInboxController`, `HandoffAction`, `HandoffInboxDeps` (Task 3); webview message variants (Task 4); the panel's own `sendUserMessage`, `getFirstSpeaker`, `roster`, `normalizeAgentId`, `appendSystemMessage`, `postState`, `workspaceRoot`, `workspaceReady`.
- Produces: `postState` envelope field `pendingHandoff: PendingHandoffSummary | null`; private methods `runHandoff(action, prompt)` and `openHandoffPreview(title, body)`; the `handoffInbox` field.

- [ ] **Step 1: Write the failing source-contract test**

In `test/panelSourceContract.test.ts`, add a test asserting the wiring anchors. Match the file's house style: each test reads the source fresh into a local `const source` via `fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8")` (see the existing test at line 31). Add this as a new `describe`/`test` at the end of the file:

```ts
describe("handoff inbox source contract", () => {
  test("handoff inbox is wired through the single sendUserMessage entry point", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    assert.match(source, /new HandoffInboxController\(/);
    assert.match(source, /private async runHandoff\(/);
    // All four actions must route through sendUserMessage — no assignBuilder path.
    assert.match(source, /case "askBoth":[\s\S]*?All of you:[\s\S]*?this\.sendUserMessage\(/);
    assert.match(source, /case "buildClaude":[\s\S]*?this\.sendUserMessage\(/);
    assert.match(source, /pendingHandoff: this\.handoffInbox/);
    // The handoff must never reach assignBuilder (needs AwaitingUser; cold room can't).
    assert.doesNotMatch(source, /runHandoff[\s\S]*?assignBuilder\(/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -p . && node --test dist/test/panelSourceContract.test.js`
Expected: FAIL — anchors not present.

- [ ] **Step 3: Add the import and field**

In `src/panel.ts`, add to the imports (near the `telegramController` import):

```ts
import {
  HandoffInboxController,
  type HandoffAction,
} from "./handoffInbox";
```

Add the field near the `private telegram` / other controller fields (search for `private readonly disposables`):

```ts
private handoffInbox!: HandoffInboxController;
```

- [ ] **Step 4: Construct the controller in the constructor**

In the constructor, right after `this.telegram = new TelegramController({ ... });`, add:

```ts
this.handoffInbox = new HandoffInboxController({
  workspaceRoot: () => this.workspaceRoot,
  isReady: () => this.workspaceReady && vscode.workspace.isTrusted === true,
  appendSystemMessage: (text) => this.appendSystemMessage(text),
  postState: () => this.postState(),
  runHandoff: (action, prompt) => this.runHandoff(action, prompt),
  openMarkdownPreview: (title, body) => this.openHandoffPreview(title, body),
});
```

- [ ] **Step 5: Add the routing + preview methods**

Add these private methods to the `HydraRoomPanel` class (near `sendUserMessage`):

```ts
// Why: the single entry point for an accepted handoff. Every action routes
// through sendUserMessage — assignBuilder needs AwaitingUser and cannot run
// from a cold room, so a build handoff seats the target head as opener and
// lets the normal discussion->build phase machine take over.
private async runHandoff(action: HandoffAction, prompt: string): Promise<void> {
  const first = this.getFirstSpeaker();
  switch (action) {
    case "discuss":
      await this.sendUserMessage(prompt, first);
      break;
    case "askBoth":
      // "All of you:" is head-count-agnostic and makes shouldRunParallelDiscussion
      // fire deterministically (unless discussionMode is "serial", respected).
      await this.sendUserMessage(`All of you:\n\n${prompt}`, first);
      break;
    case "buildCodex":
      await this.sendUserMessage(prompt, normalizeAgentId("codex", first, this.roster()));
      break;
    case "buildClaude":
      await this.sendUserMessage(prompt, normalizeAgentId("claude", first, this.roster()));
      break;
  }
}

private async openHandoffPreview(title: string, body: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    content: `# ${title}\n\n${body}`,
    language: "markdown",
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}
```

- [ ] **Step 6: Start the controller in `initialize()`**

In `initialize()`, after the transcript is loaded and `workspaceReady` is set (near where Telegram inbound polling starts, ~line 1040-1055), add:

```ts
await this.handoffInbox.start();
```

- [ ] **Step 7: Dispose the controller**

In `dispose()`, next to `this.telegram` disposal, add:

```ts
this.handoffInbox?.dispose();
```

- [ ] **Step 8: Add the postState field**

In `postState()`, in the `this.panel.webview.postMessage({ type: "state", ... })` envelope (~line 8947), add:

```ts
pendingHandoff: this.handoffInbox.pending() ?? null,
```

- [ ] **Step 9: Handle the webview messages**

In `onWebviewMessage`'s `switch (msg.type)`, add three cases (near the `acceptDefaultDecision` case):

```ts
case "confirmHandoff":
  await this.handoffInbox.confirm(msg.action);
  break;
case "dismissHandoff":
  await this.handoffInbox.dismiss();
  break;
case "previewHandoff":
  await this.handoffInbox.preview();
  break;
```

- [ ] **Step 10: Run the full test suite**

Run: `pnpm run test:fast`
Expected: PASS — including `handoffInbox`, `webviewContract`, `panelSourceContract`. Also run `pnpm run check` (tsc no-emit) to confirm the `msg.action` type flows (it is `HandoffAction | undefined`, matching `confirm`'s param).

- [ ] **Step 11: Commit**

```bash
git add src/panel.ts test/panelSourceContract.test.ts
git commit -m "feat(handoff): wire inbox controller into the room panel"
```

---

### Task 6: The /hydra-handoff skill + installer

**Files:**
- Create: `skills/hydra-handoff/SKILL.md`
- Create: `scripts/install-handoff-skill.js`
- Modify: `package.json` (add `install:handoff-skill` script)
- Modify: `.vscodeignore` (exclude `skills/` from the `.vsix`)
- Create: `test/handoffSkillContract.test.ts`

**Interfaces:**
- Consumes: `HANDOFF_ACTIONS` (Task 1) — the skill contract test asserts the skill documents exactly these actions.
- Produces: a global skill installable to `~/.claude/skills/hydra-handoff/SKILL.md` and `~/.codex/skills/hydra-handoff/SKILL.md`.

- [ ] **Step 1: Write the skill contract test**

Create `test/handoffSkillContract.test.ts`:

```ts
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { HANDOFF_ACTIONS } from "../src/handoffInbox";

const skillPath = path.join(__dirname, "..", "..", "skills", "hydra-handoff", "SKILL.md");

describe("hydra-handoff skill contract", () => {
  const skill = fs.readFileSync(skillPath, "utf8");

  test("has name + description frontmatter", () => {
    assert.match(skill, /^---\n[\s\S]*\nname: hydra-handoff\n[\s\S]*\ndescription: [\s\S]+?\n---/);
  });

  test("documents every handoff action string", () => {
    for (const action of HANDOFF_ACTIONS) {
      assert.match(skill, new RegExp(`"${action}"`), `skill must document action ${action}`);
    }
  });

  test("writes packets to the inbox path the extension scans", () => {
    assert.match(skill, /\.hydra\/handoff-inbox\//);
    assert.match(skill, /\.json\.tmp/); // atomic write via tmp then rename
  });

  test("documents the required packet fields", () => {
    for (const field of ["version", "title", "prompt", "suggestedAction"]) {
      assert.match(skill, new RegExp(`"${field}"`), `skill must document field ${field}`);
    }
  });
});
```

Note the `__dirname` path: the test compiles to `dist/test/`, so `../../skills/...` reaches the repo root. (`copy-fixtures` does not copy `skills/`, so reference the source tree via `../..`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -p . && node --test dist/test/handoffSkillContract.test.js`
Expected: FAIL — `ENOENT` on `skills/hydra-handoff/SKILL.md`.

- [ ] **Step 3: Write the skill**

Create `skills/hydra-handoff/SKILL.md`:

````markdown
---
name: hydra-handoff
description: Package the current CLI session into a handoff and queue it for the Hydra room (the VS Code 3-way collaboration extension). Use when the user says "hand this off to Hydra", "send this to the room", "hand off to Codex and Claude", or is wrapping up CLI work and wants the Hydra room to continue it — either as a discussion, an "ask all heads" turn, or a build assignment. Invoke as /hydra-handoff [action] [notes], where action is one of discuss, askBoth, buildCodex, buildClaude.
---

# Hydra Handoff

Write a handoff packet that the Hydra VS Code extension picks up and surfaces as a one-click confirm chip in the room. You do NOT start the room turn — the user confirms it in VS Code.

## Steps

1. **Find the workspace root.** Use the current git repository root (e.g. `git rev-parse --show-toplevel`). This is `<root>`. The packet goes under `<root>/.hydra/handoff-inbox/`.

2. **Choose the action.** If the user passed one of `discuss`, `askBoth`, `buildCodex`, `buildClaude`, use it. Otherwise infer:
   - An open design/decision question → `discuss` (serial) or `askBoth` (parallel, when you want every head to weigh in independently).
   - Concrete implementation work remaining, one clear owner → `buildCodex` or `buildClaude`.
   - Default to `discuss` when unsure.

3. **Compose the handoff prompt** as markdown with these sections (omit a section only if truly empty):
   - `## Objective` — what the room should accomplish.
   - `## Current state` — where things stand right now.
   - `## Done + verified` — what you completed and how it was checked (tests run + results).
   - `## Open questions` — decisions the room should resolve.
   - `## Suggested next steps` — concrete next actions.
   - `## Pointers` — key files, the branch, anything to read first.
   Fold any `[notes]` argument from the user into the relevant sections.

4. **Build the packet JSON.** Fields (all required unless marked optional):
   - `"version"`: `1`
   - `"createdAt"`: current UTC ISO-8601 timestamp
   - `"source"`: `"claude-code"` or `"codex"` (whichever you are)
   - `"title"`: a short one-line title (≤ 200 chars)
   - `"prompt"`: the markdown from step 3
   - `"suggestedAction"`: one of `"discuss"`, `"askBoth"`, `"buildCodex"`, `"buildClaude"`
   - `"context"` (optional): `{ "branch": "<git branch>", "filesTouched": ["<path>", ...] }` (≤ 50 files)

5. **Write it atomically.** Create the directory, write to a `.json.tmp` file, then rename to `.json` (the extension only reads `*.json`, so this prevents it reading a half-written file). Filename: `<UTC timestamp: YYYYMMDDTHHMMSSZ>-<kebab-slug-of-title>.json`.

   Example (adjust the packet and filename):

   ```bash
   mkdir -p "<root>/.hydra/handoff-inbox"
   cat > "<root>/.hydra/handoff-inbox/20260719T183000Z-finish-refactor.json.tmp" <<'EOF'
   {
     "version": 1,
     "createdAt": "2026-07-19T18:30:00Z",
     "source": "claude-code",
     "title": "Finish JSONL compaction refactor",
     "prompt": "## Objective\n...",
     "suggestedAction": "askBoth",
     "context": { "branch": "agent/x", "filesTouched": ["src/foo.ts"] }
   }
   EOF
   node -e "const fs=require('fs');const f=process.argv[1];fs.renameSync(f,f.replace(/\.tmp$/,''))" "<root>/.hydra/handoff-inbox/20260719T183000Z-finish-refactor.json.tmp"
   ```

   Make sure `"prompt"` is valid JSON (escape newlines as `\n` and quotes as `\"`), or write the JSON with your file-writing tool instead of a heredoc.

6. **Report to the user:** the handoff is queued at `.hydra/handoff-inbox/`; opening (or focusing) the Hydra room in that workspace shows a confirm chip where they pick Confirm / Preview / Dismiss and can override the action.
````

- [ ] **Step 4: Write the installer script**

Create `scripts/install-handoff-skill.js`:

```js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const source = path.resolve(__dirname, "..", "skills", "hydra-handoff", "SKILL.md");
if (!fs.existsSync(source)) {
  console.error(`Cannot find skill source: ${source}`);
  process.exit(1);
}

const targets = [
  path.join(os.homedir(), ".claude", "skills", "hydra-handoff", "SKILL.md"),
  path.join(os.homedir(), ".codex", "skills", "hydra-handoff", "SKILL.md"),
];

for (const target of targets) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  console.log(`Installed ${target}`);
}
```

- [ ] **Step 5: Add the package.json script**

In `package.json`, add to the `"scripts"` block:

```json
"install:handoff-skill": "node scripts/install-handoff-skill.js",
```

- [ ] **Step 6: Exclude `skills/` from the `.vsix`**

In `.vscodeignore`, add a line (the installer runs from the repo via `pnpm run`, so the skill never needs to ship inside the extension):

```
skills/**
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `tsc -p . && node --test dist/test/handoffSkillContract.test.js`
Expected: PASS.

- [ ] **Step 8: Smoke-test the installer**

Run: `node scripts/install-handoff-skill.js`
Expected: prints two `Installed ...` lines; `~/.claude/skills/hydra-handoff/SKILL.md` and `~/.codex/skills/hydra-handoff/SKILL.md` now exist and match the source.

- [ ] **Step 9: Commit**

```bash
git add skills/hydra-handoff/SKILL.md scripts/install-handoff-skill.js package.json .vscodeignore test/handoffSkillContract.test.ts
git commit -m "feat(handoff): /hydra-handoff skill and installer"
```

---

### Task 7: Full verification + README note

**Files:**
- Modify: `README.md` (short user-facing note)

- [ ] **Step 1: Run the complete test suite**

Run: `pnpm test`
Expected: PASS across all files (clean build + every `dist/test/*.test.js`). Confirm no `: any` was introduced: `pnpm run check` is clean.

- [ ] **Step 2: Add a README note**

In `README.md`, find the section listing commands/skills (or the feature list) and add a short subsection:

```markdown
### Handing off from the Codex / Claude CLI

Run `/hydra-handoff [discuss|askBoth|buildCodex|buildClaude] [notes]` inside a Codex or Claude Code session to package the current work into a handoff. It writes a packet to `.hydra/handoff-inbox/`; the Hydra room (open or next opened in that workspace) shows a confirm chip where you Preview, override the action, and Confirm to run it — or Dismiss. Install the skill once with `pnpm run install:handoff-skill`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(handoff): document the /hydra-handoff skill"
```

---

## Self-Review

**Spec coverage:**
- Packet format + caps → Task 1 (validation), Task 2 (256 KB file cap in scan).
- Atomic write / `*.json`-only ingest → Task 2 (scan ignores `.tmp`), Task 6 (skill writes `.tmp` then renames).
- Scan on open + watch while open → Task 3 (`start`/`scanNow`/`startWatcher`), Task 5 (`initialize` calls `start`).
- Confirm chip (title, override, preview, dismiss) → Task 4 (HTML/JS), Task 3 (controller), Task 5 (routing).
- Confirm routes through existing entry point → Task 5 (`runHandoff` → `sendUserMessage`), pinned by `panelSourceContract` anchor.
- Security fence (no auto-run, trust gate, quarantine, one-at-a-time) → Task 3 (controller invariants), Task 5 (`isReady` trust gate).
- Consumed/rejected moves → Task 2 (`moveHandoffFile`), Task 3 (confirm/dismiss/scan).
- Skill (one canonical `SKILL.md`, both homes, installer) → Task 6.
- No new spawn-relevant settings / no `scope: "application"` change → confirmed: no `package.json` config added, only a script.
- Tests → Tasks 1-6 each add tests; Task 7 runs the full suite.

**Placeholder scan:** No TBD/TODO; every code step shows complete code.

**Type consistency:** `HandoffAction`, `HandoffPacket`, `PendingHandoffSummary`, `HandoffInboxController` used consistently across tasks. `msg.action` (webview, `HandoffAction | undefined`) matches `confirm(overrideAction?: HandoffAction)`. `pendingHandoff` field shape (`{title, source, suggestedAction} | null`) matches `renderHandoff`'s reads.

**Known caveats (documented, not gaps):**
- `askBoth` won't go parallel if the user set `discussionMode: "serial"` — respected by design.
- `buildCodex`/`buildClaude` assume the two-agent roster; in a future N-way room the action enum would grow. v1 scope.
- The skill relies on the agent to emit valid JSON; the extension's validator + `rejected/` quarantine is the safety net.
