import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile, ensureFile, readJsonlGuarded, serializePerFile } from "../src/fileQueue";

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

  test("atomicWriteFile refuses to write through a planted tmp symlink", async (t) => {
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

    await assert.rejects(
      () => atomicWriteFile(dest, "attacker payload"),
      // Either O_EXCL refuses (EEXIST) or the destination guard fires; both
      // are acceptable, both prove the symlink wasn't followed.
      (err: NodeJS.ErrnoException) =>
        err.code === "EEXIST" || /Refusing to write Hydra artifact through symlink/.test(err.message)
    );

    const after = await fs.readFile(sensitive, "utf8");
    assert.equal(after, sensitiveOriginal);
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

  test("atomicWriteFile clears stale regular-file tmp from a prior crash", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-filequeue-"));
    const dest = path.join(dir, "artifact.md");
    const tmp = `${dest}.tmp`;
    // Simulate a crash after tmp write but before rename.
    await fs.writeFile(tmp, "stale content from prior crash", "utf8");

    await atomicWriteFile(dest, "fresh content");
    assert.equal(await fs.readFile(dest, "utf8"), "fresh content");
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
});
