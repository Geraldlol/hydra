import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  HANDOFF_ACTIONS,
  HANDOFF_MAX_FILE_BYTES,
  HANDOFF_MAX_TITLE_CHARS,
  ensureHandoffInboxDirs,
  handoffConsumedDir,
  handoffInboxDir,
  handoffRejectedDir,
  moveHandoffFile,
  scanHandoffInbox,
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
