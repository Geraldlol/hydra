import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  HANDOFF_ACTIONS,
  HANDOFF_MAX_FILE_BYTES,
  HANDOFF_MAX_TITLE_CHARS,
  HandoffInboxController,
  ensureHandoffInboxDirs,
  handoffConsumedDir,
  handoffInboxDir,
  handoffRejectedDir,
  moveHandoffFile,
  scanHandoffInbox,
  validateHandoffPacket,
} from "../src/handoffInbox";
import type { HandoffAction, PendingHandoffSummary } from "../src/handoffInbox";

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
    assert.equal(scan.valid[0]?.packet.title, "Do the thing");
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
    assert.equal(calls.handoffs[0]?.action, "buildClaude");
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

  // Deviation 2: an in-memory processed-set guard so a failed/best-effort
  // moveHandoffFile can never re-present an already-handled packet. Here we
  // simulate that failure directly: after confirm() consumes the packet, a
  // file with the SAME basename reappears in the inbox dir (as if the move
  // never actually removed the source) and scanNow must not resurrect it.
  test("scanNow does not re-surface a packet whose move silently failed to remove the source", async () => {
    const root = await tmpWorkspace();
    const { deps } = makeDeps(root);
    const name = "20260719T183000Z-x.json";
    const file = path.join(handoffInboxDir(root), name);
    await fs.writeFile(file, JSON.stringify(goodPacket()), "utf8");
    const ctrl = new HandoffInboxController(deps);
    await ctrl.scanNow();
    assert.ok(ctrl.pending());
    await ctrl.confirm();
    assert.equal(ctrl.pending(), undefined);
    // Simulate the move silently failing: the same basename is back in the
    // inbox dir, but the controller already recorded it as processed.
    await fs.writeFile(file, JSON.stringify(goodPacket()), "utf8");
    await ctrl.scanNow();
    assert.equal(ctrl.pending(), undefined);
    ctrl.dispose();
  });
});
