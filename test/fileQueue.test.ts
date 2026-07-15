import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendFileSafely,
  atomicWriteFile,
  ensureFile,
  readFileHead,
  readFileHeadSync,
  readFileTail,
  readJsonlGuarded,
  rewriteFileLinesAtomically,
  serializePerFile,
} from "../src/fileQueue";

// Helper: check whether the host supports creating symlinks. On Windows this
// requires either admin rights or Developer Mode; without those, fs.symlink
// throws EPERM or UNKNOWN and we skip the symlink-specific assertions so CI
// still passes for contributors without elevated privileges.
async function canSymlink(dir: string): Promise<boolean> {
  const target = path.join(dir, ".symlink-probe-target");
  const link = path.join(dir, ".symlink-probe-link");
  try {
    await fs.writeFile(target, "probe");
    await fs.symlink(target, link);
    await fs.unlink(link);
    await fs.unlink(target);
    return true;
  } catch {
    // Best-effort cleanup; ignore failures.
    try { await fs.unlink(link); } catch { /* not created */ }
    try { await fs.unlink(target); } catch { /* not created */ }
    return false;
  }
}

describe("fileQueue symlink safety", () => {
  test("safe append refuses a final-file symlink swapped in after initialization", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-filequeue-"));
    if (!(await canSymlink(dir))) {
      t.skip("symlink creation not permitted on this host");
      return;
    }

    const artifact = path.join(dir, "events.jsonl");
    await ensureFile(artifact, "seed\n");
    await fs.unlink(artifact);

    const sensitive = path.join(dir, "sensitive.txt");
    const sensitiveOriginal = "DO NOT APPEND";
    await fs.writeFile(sensitive, sensitiveOriginal, "utf8");
    await fs.symlink(sensitive, artifact);

    await assert.rejects(
      () => appendFileSafely(artifact, "attacker payload\n"),
      /Refusing to write Hydra artifact through symlink/
    );
    assert.equal(await fs.readFile(sensitive, "utf8"), sensitiveOriginal);
  });

  test("safe append refuses a hard link swapped in after initialization", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-filequeue-"));
    const artifact = path.join(dir, "events.jsonl");
    await ensureFile(artifact, "seed\n");
    await fs.unlink(artifact);

    const sensitive = path.join(dir, "sensitive.txt");
    const sensitiveOriginal = "DO NOT APPEND";
    await fs.writeFile(sensitive, sensitiveOriginal, "utf8");
    try {
      await fs.link(sensitive, artifact);
    } catch {
      t.skip("hard-link creation not supported on this filesystem");
      return;
    }

    await assert.rejects(
      () => appendFileSafely(artifact, "attacker payload\n"),
      /Refusing to write Hydra artifact with multiple hard links/
    );
    assert.equal(await fs.readFile(sensitive, "utf8"), sensitiveOriginal);
  });

  test("safe append refuses a linked .hydra parent directory", async (t) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-filequeue-workspace-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-filequeue-outside-"));
    try {
      await fs.symlink(outside, path.join(workspace, ".hydra"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`directory links are unavailable: ${String(error)}`);
      return;
    }

    const artifact = path.join(workspace, ".hydra", "events.jsonl");
    await assert.rejects(() => appendFileSafely(artifact, "payload\n"), /linked \.hydra directory/i);
    await assert.rejects(() => fs.stat(path.join(outside, "events.jsonl")), { code: "ENOENT" });
  });

  test("safe append creates a missing file and appends to an existing file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-filequeue-"));
    const artifact = path.join(dir, "nested", "events.jsonl");

    await appendFileSafely(artifact, "one\n");
    await appendFileSafely(artifact, "two\n");

    assert.equal(await fs.readFile(artifact, "utf8"), "one\ntwo\n");
  });

  test("atomicWriteFile refuses to write through a destination symlink", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-filequeue-"));
    if (!(await canSymlink(dir))) {
      t.skip("symlink creation not permitted on this host");
      return;
    }

    const sensitive = path.join(dir, "sensitive.txt");
    const sensitiveOriginal = "DO NOT OVERWRITE";
    await fs.writeFile(sensitive, sensitiveOriginal, "utf8");

    const linkPath = path.join(dir, "artifact.md");
    await fs.symlink(sensitive, linkPath);

    await assert.rejects(
      () => atomicWriteFile(linkPath, "attacker payload"),
      /Refusing to write Hydra artifact through symlink/
    );

    // The symlink's target must be untouched.
    const after = await fs.readFile(sensitive, "utf8");
    assert.equal(after, sensitiveOriginal);
  });

  test("atomicWriteFile ignores a planted legacy fixed tmp symlink", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-filequeue-"));
    if (!(await canSymlink(dir))) {
      t.skip("symlink creation not permitted on this host");
      return;
    }

    const sensitive = path.join(dir, "sensitive.txt");
    const sensitiveOriginal = "DO NOT OVERWRITE";
    await fs.writeFile(sensitive, sensitiveOriginal, "utf8");

    // The destination doesn't exist, but an attacker pre-planted the .tmp
    // sidecar as a symlink to ~/.ssh/authorized_keys (simulated by sensitive.txt).
    const dest = path.join(dir, "artifact.md");
    const tmp = `${dest}.tmp`;
    await fs.symlink(sensitive, tmp);

    await atomicWriteFile(dest, "safe payload");

    const after = await fs.readFile(sensitive, "utf8");
    assert.equal(after, sensitiveOriginal);
    assert.equal(await fs.readFile(dest, "utf8"), "safe payload");
  });

  test("atomicWriteFile still works for normal writes (no symlinks involved)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-filequeue-"));
    const dest = path.join(dir, "nested", "artifact.md");

    await atomicWriteFile(dest, "hello world");
    assert.equal(await fs.readFile(dest, "utf8"), "hello world");

    // Second write overwrites cleanly (the rename completes; no stale tmp).
    await atomicWriteFile(dest, "second pass");
    assert.equal(await fs.readFile(dest, "utf8"), "second pass");
  });

  test("atomicWriteFile leaves unrelated stale fixed tmp files untouched", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-filequeue-"));
    const dest = path.join(dir, "artifact.md");
    const tmp = `${dest}.tmp`;
    // Simulate a crash after tmp write but before rename.
    await fs.writeFile(tmp, "stale content from prior crash", "utf8");

    await atomicWriteFile(dest, "fresh content");
    assert.equal(await fs.readFile(dest, "utf8"), "fresh content");
    assert.equal(await fs.readFile(tmp, "utf8"), "stale content from prior crash");
  });

  test("concurrent atomic writes use independent temporary files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-filequeue-"));
    const dest = path.join(dir, "state.json");
    const values = Array.from({ length: 20 }, (_, index) => `value-${index}`);

    await Promise.all(values.map((value) => atomicWriteFile(dest, value)));

    assert.ok(values.includes(await fs.readFile(dest, "utf8")));
    assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  });

  test("ensureFile refuses to seed through a planted symlink", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-filequeue-"));
    if (!(await canSymlink(dir))) {
      t.skip("symlink creation not permitted on this host");
      return;
    }

    const sensitive = path.join(dir, "sensitive.txt");
    const sensitiveOriginal = "DO NOT OVERWRITE";
    await fs.writeFile(sensitive, sensitiveOriginal, "utf8");

    const linkPath = path.join(dir, "transcript.md");
    await fs.symlink(sensitive, linkPath);

    await assert.rejects(
      () => ensureFile(linkPath, "seed default"),
      /Refusing to write Hydra artifact through symlink/
    );

    const after = await fs.readFile(sensitive, "utf8");
    assert.equal(after, sensitiveOriginal);
  });

  test("ensureFile seeds a missing file and is idempotent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-filequeue-"));
    const file = path.join(dir, "nested", "transcript.md");

    await ensureFile(file, "seeded");
    assert.equal(await fs.readFile(file, "utf8"), "seeded");

    // Second call must NOT clobber existing content.
    await ensureFile(file, "different seed");
    assert.equal(await fs.readFile(file, "utf8"), "seeded");
  });
});

describe("serializePerFile serialization", () => {
  test("serializes concurrent read-modify-append against one path without interleaving", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-serialize-"));
    const file = path.join(dir, "appends.txt");
    await fs.writeFile(file, "", "utf8");

    // Launch many concurrent read-modify-write cycles against the SAME path.
    // Without the per-file mutex these would read a stale length, then write
    // back over each other and lose tokens. With serialization, every token
    // lands exactly once. Each `work` reads the whole file, appends its unique
    // token, and writes the whole file back — the classic lost-update race.
    const count = 50;
    const tasks: Array<Promise<void>> = [];
    for (let i = 0; i < count; i++) {
      const token = `tok-${i}`;
      tasks.push(serializePerFile(file, async () => {
        const current = await fs.readFile(file, "utf8");
        // Yield to the event loop mid-cycle to maximize the interleaving window;
        // the mutex must still prevent any other cycle from running between the
        // read above and the write below.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await fs.writeFile(file, current + token + "\n", "utf8");
      }));
    }
    await Promise.all(tasks);

    const lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
    assert.equal(lines.length, count, "every token must be present, none lost to interleaving");
    const seen = new Set(lines);
    assert.equal(seen.size, count, "no token should appear more than once");
    for (let i = 0; i < count; i++) {
      assert.ok(seen.has(`tok-${i}`), `missing token tok-${i}`);
    }
  });

  test("returns the work's resolved value to the caller", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-serialize-ret-"));
    const file = path.join(dir, "ret.txt");
    const value = await serializePerFile(file, async () => 42);
    assert.equal(value, 42);
  });
});

describe("readJsonlGuarded", () => {
  const isWidget = (value: unknown): value is { name: string } =>
    !!value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string";

  test("skips malformed lines and blank lines, keeps guarded records", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-readjsonl-"));
    const file = path.join(dir, "data.jsonl");
    await fs.writeFile(file, [
      JSON.stringify({ name: "a" }),
      "{not json",                       // malformed -> skipped
      "",                                // blank -> skipped
      "   ",                             // whitespace-only -> skipped
      JSON.stringify({ name: "b" }),
      JSON.stringify({ noName: true }),  // fails the guard -> skipped
      JSON.stringify({ name: "c" }),
    ].join("\n"), "utf8");

    const items = await readJsonlGuarded(file, isWidget);
    assert.deepEqual(items.map((w) => w.name), ["a", "b", "c"]);
  });

  test("returns an empty list for a missing file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-readjsonl-missing-"));
    const items = await readJsonlGuarded(path.join(dir, "absent.jsonl"), isWidget);
    assert.deepEqual(items, []);
  });

  test("limit slices to the trailing N guarded records", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-readjsonl-limit-"));
    const file = path.join(dir, "data.jsonl");
    await fs.writeFile(file, [
      JSON.stringify({ name: "a" }),
      JSON.stringify({ name: "b" }),
      JSON.stringify({ name: "c" }),
      JSON.stringify({ name: "d" }),
    ].join("\n"), "utf8");

    const items = await readJsonlGuarded(file, isWidget, { limit: 2 });
    assert.deepEqual(items.map((w) => w.name), ["c", "d"]);
  });

  test("reads a bounded chronological tail from a large JSONL file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-readjsonl-large-"));
    const file = path.join(dir, "data.jsonl");
    const recent = ["new-1", "new-2", "new-3"].map((name) => JSON.stringify({ name })).join("\n");
    await fs.writeFile(file, `${"x".repeat(2 * 1024 * 1024)}\n${recent}\n`, "utf8");

    const items = await readJsonlGuarded(file, isWidget, { maxBytes: 256 });

    assert.deepEqual(items.map((w) => w.name), ["new-1", "new-2", "new-3"]);
  });

  test("ignores torn edge records while retaining complete newest records", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-readjsonl-torn-"));
    const file = path.join(dir, "data.jsonl");
    await fs.writeFile(file, [
      JSON.stringify({ name: "old-with-a-long-prefix" }),
      JSON.stringify({ name: "recent-a" }),
      JSON.stringify({ name: "recent-b" }),
      '{"name":"torn',
    ].join("\n"), "utf8");

    const items = await readJsonlGuarded(file, isWidget, { maxBytes: 80 });

    assert.deepEqual(items.map((w) => w.name), ["recent-a", "recent-b"]);
  });

  test("does not amplify newline-dense tails and still keeps the newest record", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-readjsonl-newlines-"));
    const file = path.join(dir, "data.jsonl");
    await fs.writeFile(file, "\n".repeat(250_000) + JSON.stringify({ name: "final" }) + "\n", "utf8");

    const items = await readJsonlGuarded(file, isWidget, { limit: 1 });

    assert.deepEqual(items.map((w) => w.name), ["final"]);
  });
});

describe("bounded file reads and rewrites", () => {
  test("head and tail helpers enforce their byte caps", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-bounded-read-"));
    const file = path.join(dir, "data.log");
    await fs.writeFile(file, "0123456789", "utf8");

    const head = await readFileHead(file, 4);
    const syncHead = readFileHeadSync(file, 4);
    const tail = await readFileTail(file, 4);

    assert.equal(head.text, "0123");
    assert.deepEqual(syncHead, head);
    assert.equal(tail.text, "6789");
    assert.equal(head.totalBytes, 10);
    assert.equal(tail.totalBytes, 10);
    assert.equal(head.truncated, true);
    assert.equal(tail.truncated, true);
  });

  test("streaming rewrite preserves chronological lines and a partial final record", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-line-rewrite-"));
    const file = path.join(dir, "data.jsonl");
    await fs.writeFile(file, 'one\ntwo\n{"partial"', "utf8");

    await rewriteFileLinesAtomically(file, (line) => line === "two" ? "TWO" : line);

    assert.equal(await fs.readFile(file, "utf8"), 'one\nTWO\n{"partial"\n');
  });

  test("streaming rewrite leaves the source untouched when compaction has no changes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-line-rewrite-noop-"));
    const file = path.join(dir, "data.jsonl");
    await fs.writeFile(file, "one\ntwo\n", "utf8");

    await rewriteFileLinesAtomically(file, (line) => line.toUpperCase(), () => false);

    assert.equal(await fs.readFile(file, "utf8"), "one\ntwo\n");
    assert.deepEqual((await fs.readdir(dir)).sort(), ["data.jsonl"]);
  });

  test("streaming rewrite refuses oversized individual records without leaving a temp file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-line-rewrite-cap-"));
    const file = path.join(dir, "data.jsonl");
    await fs.writeFile(file, "short\nthis-line-is-too-large\n", "utf8");

    await assert.rejects(
      () => rewriteFileLinesAtomically(file, (line) => line, () => true, { maxLineChars: 8 }),
      /oversized line/,
    );

    assert.equal(await fs.readFile(file, "utf8"), "short\nthis-line-is-too-large\n");
    assert.deepEqual((await fs.readdir(dir)).sort(), ["data.jsonl"]);
  });
});
