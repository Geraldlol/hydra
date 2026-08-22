import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { PathLike } from "node:fs";
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
