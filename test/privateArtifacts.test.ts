import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  cleanupPrivateArtifacts,
  createPrivateArtifact,
  preparePrivateArtifactRoot,
  readPrivateArtifactUtf8,
  redactPrivateArtifactArgs,
  redactPrivateArtifactText,
  sweepPrivateArtifacts,
} from "../src/privateArtifacts";

async function fixture(): Promise<{ base: string; workspace: string; storage: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-private-artifacts-"));
  const workspace = path.join(base, "workspace");
  const storage = path.join(base, "storage", "one-shot");
  await fs.mkdir(workspace, { recursive: true });
  return { base, workspace, storage };
}

describe("private request artifacts", () => {
  test("creates, reads, and cleans a bounded private artifact outside the workspace", async () => {
    const { base, workspace, storage } = await fixture();
    try {
      const boundary = await preparePrivateArtifactRoot(workspace, storage, ["prompts", "replies", "logs"]);
      const reply = path.join(storage, "replies", "reply.txt");
      await createPrivateArtifact(reply, "winner", boundary);
      assert.equal(await readPrivateArtifactUtf8(reply, boundary, 64), "winner");
      await cleanupPrivateArtifacts([reply], boundary);
      await assert.rejects(fs.stat(reply), { code: "ENOENT" });
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  test("rejects a private root that resolves inside the workspace", async () => {
    const { base, workspace } = await fixture();
    try {
      const rejectedRoot = path.join(workspace, ".hydra", "one-shot");
      await assert.rejects(
        preparePrivateArtifactRoot(workspace, rejectedRoot, ["replies"]),
        /outside the workspace/
      );
      await assert.rejects(fs.stat(rejectedRoot), { code: "ENOENT" });
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  test("refuses to load a reply larger than its byte budget", async () => {
    const { base, workspace, storage } = await fixture();
    try {
      const boundary = await preparePrivateArtifactRoot(workspace, storage, ["replies"]);
      const reply = path.join(storage, "replies", "oversized.txt");
      await createPrivateArtifact(reply, "12345", boundary);
      await assert.rejects(readPrivateArtifactUtf8(reply, boundary, 4), /4-byte read limit/);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  test("refuses linked private artifacts and linked parent directories", async (t) => {
    const { base, workspace, storage } = await fixture();
    try {
      const boundary = await preparePrivateArtifactRoot(workspace, storage, ["replies"]);
      const outside = path.join(base, "outside.txt");
      const hardlink = path.join(storage, "replies", "hardlink.txt");
      await fs.writeFile(outside, "outside", "utf8");
      await fs.link(outside, hardlink);
      await assert.rejects(readPrivateArtifactUtf8(hardlink, boundary, 64), /linked|non-regular/);

      const linkedFile = path.join(storage, "replies", "symlink.txt");
      try {
        await fs.symlink(outside, linkedFile, "file");
      } catch (err) {
        if (["EPERM", "EACCES", "ENOSYS"].includes((err as NodeJS.ErrnoException).code ?? "")) {
          t.diagnostic("Symlink creation is unavailable; hardlink coverage still ran.");
        } else {
          throw err;
        }
      }
      if (await fs.lstat(linkedFile).then(() => true).catch(() => false)) {
        await assert.rejects(readPrivateArtifactUtf8(linkedFile, boundary, 64), /linked|non-regular/);
      }

      const replies = path.join(storage, "replies");
      const escaped = path.join(base, "escaped");
      await fs.rm(replies, { recursive: true, force: true });
      await fs.mkdir(escaped);
      try {
        await fs.symlink(escaped, replies, "junction");
      } catch (err) {
        if (["EPERM", "EACCES", "ENOSYS"].includes((err as NodeJS.ErrnoException).code ?? "")) {
          t.diagnostic("Directory-link creation is unavailable on this platform.");
          return;
        }
        throw err;
      }
      await assert.rejects(
        createPrivateArtifact(path.join(replies, "escaped.txt"), "secret", boundary),
        /linked|invalid|escapes/,
      );
      await assert.rejects(fs.stat(path.join(escaped, "escaped.txt")), { code: "ENOENT" });
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  test("hardens pre-existing roots, children, and new files on POSIX", { skip: process.platform === "win32" }, async () => {
    const { base, workspace, storage } = await fixture();
    try {
      await fs.mkdir(path.join(storage, "replies"), { recursive: true, mode: 0o777 });
      await fs.chmod(storage, 0o777);
      await fs.chmod(path.join(storage, "replies"), 0o777);
      const boundary = await preparePrivateArtifactRoot(workspace, storage, ["replies"]);
      const reply = path.join(storage, "replies", "private.txt");
      await createPrivateArtifact(reply, "private", boundary);
      assert.equal((await fs.stat(storage)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(path.join(storage, "replies"))).mode & 0o777, 0o700);
      assert.equal((await fs.stat(reply)).mode & 0o777, 0o600);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  test("sweeps abandoned files but leaves current requests alone", async () => {
    const { base, workspace, storage } = await fixture();
    try {
      const boundary = await preparePrivateArtifactRoot(workspace, storage, ["prompts"]);
      const oldPath = path.join(storage, "prompts", "old.md");
      const currentPath = path.join(storage, "prompts", "current.md");
      await createPrivateArtifact(oldPath, "old", boundary);
      await createPrivateArtifact(currentPath, "current", boundary);
      const oldDate = new Date(Date.now() - 120_000);
      await fs.utimes(oldPath, oldDate, oldDate);
      await sweepPrivateArtifacts(boundary, ["prompts"], 60_000);
      await assert.rejects(fs.stat(oldPath), { code: "ENOENT" });
      assert.equal(await fs.readFile(currentPath, "utf8"), "current");
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  test("redacts private artifact paths embedded in durable argv traces", () => {
    const privatePath = path.join("C:\\private", "replies", "request.last.txt");
    assert.deepEqual(
      redactPrivateArtifactArgs(["--output-last-message", privatePath, `--reply=${privatePath}`], [privatePath]),
      [
        "--output-last-message",
        "[private extension storage]/request.last.txt",
        "--reply=[private extension storage]/request.last.txt",
      ]
    );
    assert.equal(
      redactPrivateArtifactText(`failed to write ${privatePath}`, [privatePath]),
      "failed to write [private extension storage]/request.last.txt"
    );
  });
});
