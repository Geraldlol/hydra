import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants as fsConstants, type PathLike, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import fsPromises = require("node:fs/promises");
import * as os from "node:os";
import * as path from "node:path";
import {
  appendFileSafely,
  artifactNamespaceDurability,
  atomicWriteFile,
  ensureFile,
  readFileHead,
  readFileHeadSync,
  readFileTail,
  readJsonlGuarded,
  rewriteFileLinesAtomically,
  serializePerFile,
  serializePerFileAcrossProcesses,
  syncArtifactDirectory,
} from "../src/fileQueue";

type PromisesFileHandle = Awaited<ReturnType<typeof fsPromises.open>>;

function trackFileSync(handle: PromisesFileHandle, onSync: () => void): PromisesFileHandle {
  return new Proxy(handle, {
    get(target, property) {
      if (property === "sync") {
        return async () => {
          onSync();
          await target.sync();
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function crossProcessOwnerRecord(
  ownerPid: number,
  overrides: Partial<{
    readonly token: string;
    readonly createdAt: string;
    readonly ownerStartedAt: string;
    readonly ownerInstanceId: string;
  }> = {},
): string {
  return `${JSON.stringify({
    token: overrides.token ?? "test-owner-token",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    ownerPid,
    ownerStartedAt:
      overrides.ownerStartedAt ?? "2000-01-01T00:00:00.000Z",
    ownerInstanceId:
      overrides.ownerInstanceId ?? "00000000-0000-4000-8000-000000000001",
  })}\n`;
}

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

  test("publishes lock and marker records atomically from complete temporary files", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-lock-publish-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, ".hydra", "events.jsonl");
    const lock = `${file}.lock`;
    await fs.mkdir(path.dirname(file), { recursive: true });

    const originalLink = fsPromises.link.bind(fsPromises);
    const originalRename = fsPromises.rename.bind(fsPromises);
    let lockPublications = 0;
    let markerPublications = 0;
    t.mock.method(fsPromises, "link", (async (source: PathLike, destination: PathLike) => {
      if (path.resolve(String(destination)) === path.resolve(lock)) {
        assert.doesNotThrow(() => JSON.parse(require("node:fs").readFileSync(source, "utf8")));
        await assert.rejects(fs.lstat(lock), { code: "ENOENT" });
        lockPublications += 1;
      }
      return originalLink(source, destination);
    }) as typeof fsPromises.link);
    t.mock.method(fsPromises, "rename", (async (source: PathLike, destination: PathLike) => {
      const target = String(destination);
      if (target.startsWith(`${lock}.acquire-`)) {
        assert.doesNotThrow(() => JSON.parse(require("node:fs").readFileSync(source, "utf8")));
        await assert.rejects(fs.lstat(target), { code: "ENOENT" });
        markerPublications += 1;
      }
      return originalRename(source, destination);
    }) as typeof fsPromises.rename);

    await serializePerFileAcrossProcesses(file, async () => undefined);

    assert.equal(lockPublications, 1);
    assert.equal(markerPublications, 1);
  });

  test("completes a lock publication interrupted after the canonical hard link", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-lock-interrupted-publish-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, ".hydra", "events.jsonl");
    const lock = `${file}.lock`;
    const token = "00000000-0000-4000-8000-000000000099";
    const temporary = path.join(
      path.dirname(lock),
      `.${path.basename(lock)}.publish-${token}.tmp`,
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temporary, crossProcessOwnerRecord(process.pid, {
      token,
      ownerStartedAt: "1970-01-01T00:00:00.000Z",
    }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.link(temporary, lock);
    const expired = new Date(Date.now() - 3 * 60_000);
    await fs.utimes(temporary, expired, expired);
    await fs.utimes(lock, expired, expired);

    let calls = 0;
    await serializePerFileAcrossProcesses(file, async () => {
      calls += 1;
    });

    assert.equal(calls, 1);
    await assert.rejects(fs.lstat(temporary), { code: "ENOENT" });
    await assert.rejects(fs.lstat(lock), { code: "ENOENT" });
  });

  test("records PID and process-start identity on the cross-process owner", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-lock-owner-identity-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, ".hydra", "events.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });

    await serializePerFileAcrossProcesses(file, async () => {
      const record = JSON.parse(
        await fs.readFile(`${file}.lock`, "utf8"),
      ) as Record<string, unknown>;
      assert.equal(record.ownerPid, process.pid);
      assert.equal(typeof record.ownerStartedAt, "string");
      assert.equal(Number.isFinite(Date.parse(String(record.ownerStartedAt))), true);
      assert.match(
        String(record.ownerInstanceId),
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });

  test(
    "does not steal an expired-looking lock from a live owner and recovers after exit",
    { timeout: 10_000 },
    async (t) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-lock-live-owner-"));
      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      const file = path.join(dir, ".hydra", "events.jsonl");
      const lock = `${file}.lock`;
      await fs.mkdir(path.dirname(file), { recursive: true });

      const owner = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore", windowsHide: true },
      );
      t.after(() => {
        if (owner.exitCode === null && owner.signalCode === null) owner.kill();
      });
      await once(owner, "spawn");
      assert.ok(owner.pid);
      await fs.writeFile(lock, crossProcessOwnerRecord(owner.pid), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const expired = new Date(Date.now() - 3 * 60_000);
      await fs.utimes(lock, expired, expired);

      let workCalls = 0;
      const pending = serializePerFileAcrossProcesses(file, async () => {
        workCalls += 1;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(workCalls, 0, "a live owner must remain authoritative despite stale mtime");
      assert.equal((await fs.lstat(lock)).isFile(), true);

      const exited = once(owner, "exit");
      owner.kill();
      await exited;
      await pending;
      assert.equal(workCalls, 1, "a definitely dead owner may be recovered");
    },
  );

  test("fails closed on an expired owner record without liveness proof", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-lock-ambiguous-owner-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, ".hydra", "events.jsonl");
    const lock = `${file}.lock`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(lock, "legacy-owner-without-liveness-proof\n", "utf8");
    const expired = new Date(Date.now() - 3 * 60_000);
    await fs.utimes(lock, expired, expired);

    let workCalls = 0;
    const pending = serializePerFileAcrossProcesses(file, async () => {
      workCalls += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(workCalls, 0);
    assert.equal((await fs.lstat(lock)).isFile(), true);

    await fs.unlink(lock);
    await pending;
    assert.equal(workCalls, 1);
  });

  test("recovers a dead prior process after a provable PID reuse", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-lock-pid-reuse-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, ".hydra", "events.jsonl");
    const lock = `${file}.lock`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      lock,
      crossProcessOwnerRecord(process.pid, {
        ownerStartedAt: "1970-01-01T00:00:00.000Z",
      }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    const expired = new Date(Date.now() - 3 * 60_000);
    await fs.utimes(lock, expired, expired);

    let workCalls = 0;
    await serializePerFileAcrossProcesses(file, async () => {
      workCalls += 1;
    });
    assert.equal(workCalls, 1);
  });

  test("treats delete-pending lock entries as concurrent disappearance", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-lock-delete-pending-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, ".hydra", "events.jsonl");
    const lock = `${file}.lock`;
    const controlledMarker = `${lock}.acquire-controlled-replacement`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      lock,
      crossProcessOwnerRecord(process.pid, {
        ownerStartedAt: "1970-01-01T00:00:00.000Z",
      }),
      "utf8",
    );
    const expired = new Date(Date.now() - 3 * 60_000);
    await fs.utimes(lock, expired, expired);
    await fs.writeFile(controlledMarker, `${process.pid}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    const originalLstat = fsPromises.lstat.bind(fsPromises);
    const originalOpen = fsPromises.open.bind(fsPromises);
    const originalUnlink = fsPromises.unlink.bind(fsPromises);
    let deleteMarkerOnInspect = false;
    let deleteLockOnInspect = false;
    let observedDeletePendingMarker = false;
    let observedDeletePendingLock = false;

    const deletePendingStat = async (entryPath: string): Promise<Stats> => {
      const handle = await originalOpen(entryPath, "r");
      try {
        await originalUnlink(entryPath);
        const stat = await handle.stat();
        assert.equal(stat.isFile(), true);
        assert.equal(stat.nlink, 0);
        return stat;
      } finally {
        await handle.close();
      }
    };
    const mockedLstat = async (entryPath: PathLike): Promise<Stats> => {
      const candidate = path.resolve(String(entryPath));
      if (
        deleteMarkerOnInspect
        && !observedDeletePendingMarker
        && candidate === path.resolve(controlledMarker)
      ) {
        observedDeletePendingMarker = true;
        return deletePendingStat(controlledMarker);
      }
      if (
        deleteLockOnInspect
        && !observedDeletePendingLock
        && candidate === path.resolve(lock)
      ) {
        observedDeletePendingLock = true;
        return deletePendingStat(lock);
      }
      return originalLstat(entryPath);
    };
    t.mock.method(
      fsPromises,
      "lstat",
      mockedLstat as unknown as typeof fsPromises.lstat,
    );

    let workCalls = 0;
    const pending = serializePerFileAcrossProcesses(file, async () => {
      workCalls += 1;
    });
    await waitForCondition("recovery marker", async () =>
      (await fs.readdir(path.dirname(lock))).some(
        (name) => name.startsWith(`${path.basename(lock)}.recover-`),
      ),
    );

    const retiredFixture = `${lock}.fixture-stale`;
    await fs.rename(lock, retiredFixture);
    await fs.writeFile(lock, `${JSON.stringify({
      token: "controlled-replacement-owner",
      createdAt: new Date().toISOString(),
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });

    deleteMarkerOnInspect = true;
    await waitForCondition(
      "delete-pending acquisition marker",
      () => observedDeletePendingMarker,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(workCalls, 0, "the fresh replacement lease must still block work");

    deleteLockOnInspect = true;
    await waitForCondition(
      "delete-pending replacement lease",
      () => observedDeletePendingLock,
    );
    await pending;

    assert.equal(workCalls, 1);
    await fs.unlink(retiredFixture);
  });
});

describe("fileQueue durability", () => {
  test("fsyncs acknowledged appends and atomic replacements", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-file-sync-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const appendPath = path.join(dir, "append.jsonl");
    const atomicPath = path.join(dir, "atomic.json");
    const rewritePath = path.join(dir, "rewrite.jsonl");
    await fs.writeFile(appendPath, "seed\n", "utf8");
    await fs.writeFile(atomicPath, "old", "utf8");
    await fs.writeFile(rewritePath, "one\ntwo\n", "utf8");

    const originalOpen = fsPromises.open.bind(fsPromises) as unknown as (
      filePath: PathLike,
      flags: string | number,
      mode?: number,
    ) => Promise<PromisesFileHandle>;
    let appendSyncs = 0;
    let atomicSyncs = 0;
    let rewriteSyncs = 0;
    const mockedOpen = async (filePath: PathLike, flags: string | number, mode?: number) => {
      const handle = await originalOpen(filePath, flags, mode);
      const candidate = path.resolve(String(filePath));
      if (candidate === path.resolve(appendPath)
        && typeof flags === "number"
        && (flags & fsConstants.O_APPEND) !== 0) {
        return trackFileSync(handle, () => { appendSyncs += 1; });
      }
      if (candidate.startsWith(`${path.resolve(atomicPath)}.`) && candidate.endsWith(".tmp")) {
        return trackFileSync(handle, () => { atomicSyncs += 1; });
      }
      if (candidate.startsWith(`${path.resolve(rewritePath)}.`) && candidate.endsWith(".tmp")) {
        return trackFileSync(handle, () => { rewriteSyncs += 1; });
      }
      return handle;
    };
    t.mock.method(fsPromises, "open", mockedOpen as unknown as typeof fsPromises.open);

    await appendFileSafely(appendPath, "next\n");
    await atomicWriteFile(atomicPath, "new");
    await rewriteFileLinesAtomically(rewritePath, (line) => line.toUpperCase());

    assert.equal(appendSyncs, 1);
    assert.equal(atomicSyncs, 1);
    assert.equal(rewriteSyncs, 1);
  });

  test("documents and tolerates only the weaker Windows namespace guarantee", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-directory-sync-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    assert.equal(artifactNamespaceDurability("linux"), "file-and-directory");
    assert.equal(artifactNamespaceDurability("win32"), "file-only");

    const originalOpen = fsPromises.open.bind(fsPromises);
    const unsupported = Object.assign(new Error("directory sync unsupported"), { code: "EPERM" });
    t.mock.method(fsPromises, "open", (async (filePath: PathLike, flags: string | number, mode?: number) => {
      if (path.resolve(String(filePath)) === path.resolve(dir)) throw unsupported;
      return (originalOpen as unknown as (
        target: PathLike,
        openFlags: string | number,
        openMode?: number,
      ) => Promise<PromisesFileHandle>)(filePath, flags, mode);
    }) as unknown as typeof fsPromises.open);

    assert.equal(await syncArtifactDirectory(dir, "win32"), "file-only");
    await assert.rejects(() => syncArtifactDirectory(dir, "linux"), /directory sync unsupported/);
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

async function waitForCondition(
  label: string,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
