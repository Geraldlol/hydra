import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants as fsConstants, type PathLike } from "node:fs";
import * as fs from "node:fs/promises";
import fsPromises = require("node:fs/promises");
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
  createArenaPrivateFile,
  ensureArenaPrivateDirectory,
  prepareArenaPrivateStorage,
  readArenaPrivateFile,
  writeArenaPrivateFileAtomically,
  type ArenaPrivateStorageBoundary,
} from "../src/arenaPrivateStorage";

interface PrivateFileFixture {
  readonly boundary: ArenaPrivateStorageBoundary;
  readonly directory: string;
  readonly filePath: string;
}

async function privateFileFixture(
  t: TestContext,
  name = "intent.v1.json",
): Promise<PrivateFileFixture> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "hydra-arena-private-storage-"),
  );
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const boundary = await prepareArenaPrivateStorage(root);
  const directory = await ensureArenaPrivateDirectory(
    boundary,
    ["registrations", "run-one", "contestant-one"],
  );
  return {
    boundary,
    directory,
    filePath: path.join(directory, name),
  };
}

async function temporaryEntries(directory: string): Promise<readonly string[]> {
  return (await fs.readdir(directory))
    .filter((entry) => entry.endsWith(".tmp"))
    .sort();
}

function ioError(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: "EIO" });
}

describe("Arena crash-atomic private file publication", () => {
  test("concurrent writers publish exactly one complete record", async (t) => {
    const fixture = await privateFileFixture(t);
    const payloads = Array.from(
      { length: 24 },
      (_, index) => `${JSON.stringify({
        schemaVersion: 1,
        writer: index,
        body: String(index).repeat(4_096),
      })}\n`,
    );
    const results = await Promise.allSettled(
      payloads.map((payload) =>
        createArenaPrivateFile(
          fixture.filePath,
          payload,
          fixture.boundary,
        )),
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, payloads.length - 1);
    for (const result of rejected) {
      assert.equal(
        (result.reason as NodeJS.ErrnoException).code,
        "EEXIST",
      );
    }

    const published = await fs.readFile(fixture.filePath, "utf8");
    assert.ok(payloads.includes(published));
    assert.equal((await fs.lstat(fixture.filePath)).nlink, 1);
    assert.deepEqual(await temporaryEntries(fixture.directory), []);
  });

  test("never silently overwrites an existing final entry", async (t) => {
    const fixture = await privateFileFixture(t);
    await createArenaPrivateFile(
      fixture.filePath,
      "first-complete-record\n",
      fixture.boundary,
    );
    await assert.rejects(
      createArenaPrivateFile(
        fixture.filePath,
        "second-record-must-not-win\n",
        fixture.boundary,
      ),
      (error: unknown) =>
        (error as NodeJS.ErrnoException).code === "EEXIST",
    );
    assert.equal(
      await fs.readFile(fixture.filePath, "utf8"),
      "first-complete-record\n",
    );
    assert.equal((await fs.lstat(fixture.filePath)).nlink, 1);
    assert.deepEqual(await temporaryEntries(fixture.directory), []);
  });

  test("rejects private files whose POSIX permissions become shared", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX private-file permissions");
      return;
    }
    const fixture = await privateFileFixture(t);
    await createArenaPrivateFile(
      fixture.filePath,
      "private record\n",
      fixture.boundary,
    );
    await fs.chmod(fixture.filePath, 0o640);

    await assert.rejects(
      readArenaPrivateFile(
        fixture.filePath,
        1_024,
        fixture.boundary,
      ),
      /permissions are unsafe/,
    );
  });

  test("rejects a private parent whose POSIX permissions become shared", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX private-directory permissions");
      return;
    }
    const fixture = await privateFileFixture(t);
    await fs.chmod(fixture.directory, 0o750);

    await assert.rejects(
      createArenaPrivateFile(
        fixture.filePath,
        "must not publish\n",
        fixture.boundary,
      ),
      /permissions are not private/,
    );
  });

  test("replacement surfaces a parent-directory flush failure after complete publication", async (t) => {
    const fixture = await privateFileFixture(t);
    await createArenaPrivateFile(
      fixture.filePath,
      "first-complete-record\n",
      fixture.boundary,
    );
    const originalOpen = fsPromises.open.bind(fsPromises) as unknown as (
      filePath: PathLike,
      flags: string | number,
      mode?: number,
    ) => Promise<fs.FileHandle>;
    t.mock.method(
      fsPromises,
      "open",
      (async (filePath: PathLike, flags: string | number, mode?: number) => {
        if (path.resolve(String(filePath)) === path.resolve(fixture.directory)
          && flags === fsConstants.O_RDONLY) {
          throw ioError("injected parent-directory flush failure");
        }
        return originalOpen(filePath, flags, mode);
      }) as typeof fsPromises.open,
    );

    await assert.rejects(
      writeArenaPrivateFileAtomically(
        fixture.filePath,
        "second-complete-record\n",
        fixture.boundary,
      ),
      /injected parent-directory flush failure/,
    );
    assert.equal(
      await fs.readFile(fixture.filePath, "utf8"),
      "second-complete-record\n",
    );
    assert.deepEqual(await temporaryEntries(fixture.directory), []);
  });

  test("replacement retries sweep only strict dead-publisher temporary names", async (t) => {
    const fixture = await privateFileFixture(t);
    const deadPid = 2_000_000_000;
    const modern = path.join(
      fixture.directory,
      `.${path.basename(fixture.filePath)}.replace.${deadPid}-${randomUUID()}.tmp`,
    );
    const legacy = path.join(
      fixture.directory,
      `${path.basename(fixture.filePath)}.${deadPid}-${randomUUID()}.tmp`,
    );
    const nearMatch = path.join(
      fixture.directory,
      `X${path.basename(fixture.filePath)}Y${deadPid}-${randomUUID()}Ztmp`,
    );
    await Promise.all([
      fs.writeFile(modern, "orphan", { mode: 0o600 }),
      fs.writeFile(legacy, "orphan", { mode: 0o600 }),
      fs.writeFile(nearMatch, "unrelated", { mode: 0o600 }),
    ]);

    await writeArenaPrivateFileAtomically(
      fixture.filePath,
      "replacement after recovery\n",
      fixture.boundary,
    );
    await assert.rejects(fs.lstat(modern), { code: "ENOENT" });
    await assert.rejects(fs.lstat(legacy), { code: "ENOENT" });
    assert.equal(await fs.readFile(nearMatch, "utf8"), "unrelated");
    assert.equal(
      await fs.readFile(fixture.filePath, "utf8"),
      "replacement after recovery\n",
    );
  });

  test("new nested directories surface parent-entry durability failures", async (t) => {
    const fixture = await privateFileFixture(t);
    const runsPath = path.join(fixture.boundary.logicalRoot, "runs");
    const createdPath = path.join(runsPath, "durability-probe");
    const originalOpen = fsPromises.open.bind(fsPromises) as unknown as (
      filePath: PathLike,
      flags: string | number,
      mode?: number,
    ) => Promise<fs.FileHandle>;
    t.mock.method(
      fsPromises,
      "open",
      (async (filePath: PathLike, flags: string | number, mode?: number) => {
        if (path.resolve(String(filePath)) === path.resolve(runsPath)
          && flags === fsConstants.O_RDONLY) {
          throw ioError("injected directory-entry flush failure");
        }
        return originalOpen(filePath, flags, mode);
      }) as typeof fsPromises.open,
    );

    await assert.rejects(
      ensureArenaPrivateDirectory(
        fixture.boundary,
        ["runs", "durability-probe"],
      ),
      /injected directory-entry flush failure/,
    );
    const created = await fs.lstat(createdPath);
    assert.equal(created.isDirectory() && !created.isSymbolicLink(), true);
  });

  test("an existing directory retry repeats a previously failed parent flush", async (t) => {
    const fixture = await privateFileFixture(t);
    const runsPath = path.join(fixture.boundary.logicalRoot, "runs");
    const originalOpen = fsPromises.open.bind(fsPromises) as unknown as (
      filePath: PathLike,
      flags: string | number,
      mode?: number,
    ) => Promise<fs.FileHandle>;
    let targetFlushes = 0;
    t.mock.method(
      fsPromises,
      "open",
      (async (filePath: PathLike, flags: string | number, mode?: number) => {
        if (path.resolve(String(filePath)) === path.resolve(runsPath)
          && flags === fsConstants.O_RDONLY) {
          targetFlushes += 1;
          if (targetFlushes === 1) {
            throw ioError("injected first directory-entry flush failure");
          }
        }
        return originalOpen(filePath, flags, mode);
      }) as typeof fsPromises.open,
    );

    await assert.rejects(
      ensureArenaPrivateDirectory(
        fixture.boundary,
        ["runs", "retry-durability-probe"],
      ),
      /injected first directory-entry flush failure/,
    );
    await ensureArenaPrivateDirectory(
      fixture.boundary,
      ["runs", "retry-durability-probe"],
    );
    assert.equal(targetFlushes >= 2, true);
  });

  test("an exact file retry repeats a parent flush after publication uncertainty", async (t) => {
    const fixture = await privateFileFixture(t);
    const originalOpen = fsPromises.open.bind(fsPromises) as unknown as (
      filePath: PathLike,
      flags: string | number,
      mode?: number,
    ) => Promise<fs.FileHandle>;
    let parentFlushes = 0;
    t.mock.method(
      fsPromises,
      "open",
      (async (filePath: PathLike, flags: string | number, mode?: number) => {
        if (path.resolve(String(filePath)) === path.resolve(fixture.directory)
          && flags === fsConstants.O_RDONLY) {
          parentFlushes += 1;
          if (parentFlushes === 1) {
            throw ioError("injected first publication flush failure");
          }
        }
        return originalOpen(filePath, flags, mode);
      }) as typeof fsPromises.open,
    );

    await assert.rejects(
      createArenaPrivateFile(
        fixture.filePath,
        "durable exact payload\n",
        fixture.boundary,
      ),
      /injected first publication flush failure/,
    );
    await assert.rejects(
      createArenaPrivateFile(
        fixture.filePath,
        "durable exact payload\n",
        fixture.boundary,
      ),
      (error: unknown) =>
        (error as NodeJS.ErrnoException).code === "EEXIST",
    );
    assert.equal(parentFlushes >= 2, true);
    assert.equal(
      await fs.readFile(fixture.filePath, "utf8"),
      "durable exact payload\n",
    );
  });

  test("replacement preserves Windows when directory handles cannot be flushed", async (t) => {
    if (process.platform !== "win32") {
      t.skip("Windows-specific unsupported directory-handle behavior");
      return;
    }
    const fixture = await privateFileFixture(t);
    await createArenaPrivateFile(
      fixture.filePath,
      "first-complete-record\n",
      fixture.boundary,
    );
    const originalOpen = fsPromises.open.bind(fsPromises) as unknown as (
      filePath: PathLike,
      flags: string | number,
      mode?: number,
    ) => Promise<fs.FileHandle>;
    t.mock.method(
      fsPromises,
      "open",
      (async (filePath: PathLike, flags: string | number, mode?: number) => {
        if (path.resolve(String(filePath)) === path.resolve(fixture.directory)
          && flags === fsConstants.O_RDONLY) {
          throw Object.assign(new Error("directory handles unsupported"), {
            code: "EACCES",
          });
        }
        return originalOpen(filePath, flags, mode);
      }) as typeof fsPromises.open,
    );

    await writeArenaPrivateFileAtomically(
      fixture.filePath,
      "second-complete-record\n",
      fixture.boundary,
    );
    assert.equal(
      await fs.readFile(fixture.filePath, "utf8"),
      "second-complete-record\n",
    );
  });

  test("a publication syscall failure leaves no partial final record", async (t) => {
    const fixture = await privateFileFixture(t);
    t.mock.method(fsPromises, "link", async () => {
      throw ioError("injected link failure");
    });

    await assert.rejects(
      createArenaPrivateFile(
        fixture.filePath,
        "fully-buffered-but-unpublished\n",
        fixture.boundary,
      ),
      /injected link failure/,
    );
    await assert.rejects(
      fs.lstat(fixture.filePath),
      (error: unknown) =>
        (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    assert.deepEqual(await temporaryEntries(fixture.directory), []);
  });

  test("create retries sweep strict pre-commit temporaries from dead publishers", async (t) => {
    const fixture = await privateFileFixture(t);
    const deadPid = 2_000_000_000;
    const orphan = path.join(
      fixture.directory,
      `.${path.basename(fixture.filePath)}.${deadPid}-${randomUUID()}.tmp`,
    );
    const nearMatch = path.join(
      fixture.directory,
      `X${path.basename(fixture.filePath)}Y${deadPid}-${randomUUID()}Ztmp`,
    );
    await fs.writeFile(orphan, "orphan", { mode: 0o600 });
    await fs.writeFile(nearMatch, "unrelated", { mode: 0o600 });

    await createArenaPrivateFile(
      fixture.filePath,
      "created after orphan recovery\n",
      fixture.boundary,
    );
    await assert.rejects(fs.lstat(orphan), { code: "ENOENT" });
    assert.equal(await fs.readFile(nearMatch, "utf8"), "unrelated");
  });

  test("a domain-recovered caller can skip the generic parent scan", async (t) => {
    const fixture = await privateFileFixture(t);
    t.mock.method(
      fsPromises,
      "opendir",
      (async () => {
        throw new Error("generic parent scan must not run");
      }) as typeof fsPromises.opendir,
    );

    await createArenaPrivateFile(
      fixture.filePath,
      "created after domain-specific recovery\n",
      fixture.boundary,
      { orphanCreationTempsAlreadyRecovered: true },
    );

    assert.equal(
      await fs.readFile(fixture.filePath, "utf8"),
      "created after domain-specific recovery\n",
    );
  });

  test("an early post-open failure cleans its same-process temporary before retry", async (t) => {
    const fixture = await privateFileFixture(t);
    const originalOpen = fsPromises.open.bind(fsPromises);
    const originalLstat = fsPromises.lstat.bind(fsPromises);
    let stageOpened = false;
    let failedParentProbe = false;
    t.mock.method(
      fsPromises,
      "open",
      (async (...args: Parameters<typeof fsPromises.open>) => {
        if (String(args[0]).includes(`.${path.basename(fixture.filePath)}.`)
          && args[1] === "wx") {
          stageOpened = true;
        }
        return originalOpen(...args);
      }) as typeof fsPromises.open,
    );
    t.mock.method(
      fsPromises,
      "lstat",
      (async (...args: Parameters<typeof fsPromises.lstat>) => {
        if (stageOpened
          && !failedParentProbe
          && path.resolve(String(args[0])) === path.resolve(fixture.directory)) {
          failedParentProbe = true;
          throw ioError("injected early parent probe failure");
        }
        return originalLstat(...args);
      }) as typeof fsPromises.lstat,
    );

    await assert.rejects(
      createArenaPrivateFile(
        fixture.filePath,
        "first attempt\n",
        fixture.boundary,
      ),
      /injected early parent probe failure/,
    );
    assert.deepEqual(await temporaryEntries(fixture.directory), []);
    await createArenaPrivateFile(
      fixture.filePath,
      "second attempt\n",
      fixture.boundary,
    );
    assert.equal(await fs.readFile(fixture.filePath, "utf8"), "second attempt\n");
  });

  test("a partial temporary write is cleaned without publishing its bytes", async (t) => {
    const fixture = await privateFileFixture(t);
    const probePath = path.join(fixture.directory, "file-handle-probe");
    const probe = await fs.open(probePath, "wx", 0o600);
    const prototype = Object.getPrototypeOf(probe) as {
      writeFile(
        this: fs.FileHandle,
        data: string | Buffer,
      ): Promise<void>;
    };
    const originalWriteFile = prototype.writeFile;
    await probe.close();
    await fs.unlink(probePath);
    t.mock.method(
      prototype,
      "writeFile",
      async function injectedPartialWrite(
        this: fs.FileHandle,
        _data: string | Buffer,
      ): Promise<void> {
        await originalWriteFile.call(this, Buffer.from("partial"));
        throw ioError("injected partial write");
      },
    );

    await assert.rejects(
      createArenaPrivateFile(
        fixture.filePath,
        "this-complete-record-must-never-be-visible\n",
        fixture.boundary,
      ),
      /injected partial write/,
    );
    await assert.rejects(
      fs.lstat(fixture.filePath),
      (error: unknown) =>
        (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    assert.deepEqual(await temporaryEntries(fixture.directory), []);
  });

  test("an unknown link result can expose only the complete synced record", async (t) => {
    const fixture = await privateFileFixture(t);
    const originalLink = fsPromises.link.bind(fsPromises);
    t.mock.method(
      fsPromises,
      "link",
      async (existingPath: PathLike, newPath: PathLike) => {
        await originalLink(existingPath, newPath);
        throw ioError("injected lost link acknowledgement");
      },
    );
    const payload = `${JSON.stringify({
      schemaVersion: 1,
      state: "complete",
      body: "x".repeat(32_768),
    })}\n`;

    await assert.rejects(
      createArenaPrivateFile(
        fixture.filePath,
        payload,
        fixture.boundary,
      ),
      /injected lost link acknowledgement/,
    );
    assert.equal(await fs.readFile(fixture.filePath, "utf8"), payload);
    assert.equal((await fs.lstat(fixture.filePath)).nlink, 1);
    assert.deepEqual(await temporaryEntries(fixture.directory), []);
  });

  test("unexpected extra links fail closed instead of accepting publication", async (t) => {
    const fixture = await privateFileFixture(t);
    const extraLink = path.join(fixture.directory, "unexpected-hardlink");
    const originalLink = fsPromises.link.bind(fsPromises);
    t.mock.method(
      fsPromises,
      "link",
      async (existingPath: PathLike, newPath: PathLike) => {
        await originalLink(existingPath, newPath);
        await originalLink(existingPath, extraLink);
      },
    );

    await assert.rejects(
      createArenaPrivateFile(
        fixture.filePath,
        "must-not-be-trusted-after-link-race\n",
        fixture.boundary,
      ),
      /publication link is linked or invalid/,
    );
    assert.equal((await fs.lstat(fixture.filePath)).nlink, 2);
    await assert.rejects(
      readArenaPrivateFile(
        fixture.filePath,
        1_024,
        fixture.boundary,
      ),
      /linked or invalid|interrupted publication is ambiguous/,
    );
    assert.deepEqual(await temporaryEntries(fixture.directory), []);
  });

  test("recovers a complete publication after its publisher dies before cleanup", async (t) => {
    const fixture = await privateFileFixture(t);
    const modulePath = path.join(
      __dirname,
      "..",
      "src",
      "arenaPrivateStorage.js",
    );
    const payload = `${JSON.stringify({
      schemaVersion: 1,
      state: "committed-before-process-death",
      body: "y".repeat(16_384),
    })}\n`;
    const childScript = String.raw`
const fs = require("node:fs/promises");
const originalLink = fs.link.bind(fs);
fs.link = async (...args) => {
  await originalLink(...args);
  process.stdout.write("linked\n");
  await new Promise(() => {});
};
const storage = require(process.env.ARENA_STORAGE_MODULE);
(async () => {
  const boundary = await storage.prepareArenaPrivateStorage(
    process.env.ARENA_STORAGE_ROOT,
  );
  await storage.createArenaPrivateFile(
    process.env.ARENA_STORAGE_FILE,
    process.env.ARENA_STORAGE_PAYLOAD,
    boundary,
  );
})().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
`;
    const child = spawn(process.execPath, ["-e", childScript], {
      env: {
        ...process.env,
        ARENA_STORAGE_MODULE: modulePath,
        ARENA_STORAGE_ROOT: fixture.boundary.privateWorkspaceRoot,
        ARENA_STORAGE_FILE: fixture.filePath,
        ARENA_STORAGE_PAYLOAD: payload,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const linked = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for child publication: ${stderr}`));
      }, 10_000);
      timeout.unref();
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (!stdout.includes("linked\n")) return;
        clearTimeout(timeout);
        resolve();
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (stdout.includes("linked\n")) return;
        clearTimeout(timeout);
        reject(new Error(
          `Child exited before publication (${code}/${signal}): ${stderr}`,
        ));
      });
    });
    await linked;
    assert.equal(child.kill(), true);
    await once(child, "exit");

    assert.equal((await fs.lstat(fixture.filePath)).nlink, 2);
    assert.equal((await temporaryEntries(fixture.directory)).length, 1);
    assert.equal(
      (
        await readArenaPrivateFile(
          fixture.filePath,
          Buffer.byteLength(payload),
          fixture.boundary,
        )
      ).toString("utf8"),
      payload,
    );
    assert.equal((await fs.lstat(fixture.filePath)).nlink, 1);
    assert.deepEqual(await temporaryEntries(fixture.directory), []);
  });

  test("rejects an in-root linked ancestor instead of redirecting publication", async (t) => {
    const fixture = await privateFileFixture(t);
    const runDirectory = path.dirname(fixture.directory);
    const realRunDirectory = `${runDirectory}-real`;
    await fs.rename(runDirectory, realRunDirectory);
    try {
      await fs.symlink(
        realRunDirectory,
        runDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      t.skip(`directory-link creation unavailable: ${String(error)}`);
      return;
    }
    await assert.rejects(
      createArenaPrivateFile(
        fixture.filePath,
        "must-not-follow-an-in-root-link\n",
        fixture.boundary,
      ),
      /directory component is linked or invalid/,
    );
    await assert.rejects(
      fs.lstat(path.join(realRunDirectory, "contestant-one", "intent.v1.json")),
      (error: unknown) =>
        (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  });
});
