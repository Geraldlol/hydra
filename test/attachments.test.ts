import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  prepareRoomAttachment,
  renderRoomAttachmentsForPrompt,
  roomAttachmentSummaries,
  sanitizeAttachmentFileName,
} from "../src/attachments";

function attachmentInput(workspace: string, sourcePath: string, overrides: Partial<Parameters<typeof prepareRoomAttachment>[0]> = {}) {
  return {
    id: "a1",
    sourcePath,
    sourceLabel: path.basename(sourcePath),
    attachmentDir: path.join(workspace, ".hydra", "attachments", "turn"),
    relativeAttachmentDir: ".hydra/attachments/turn",
    previewMaxChars: 100,
    maxBytes: 1024 * 1024,
    ...overrides,
  };
}

async function withFirstFileReadHook(hook: () => Promise<void>, work: () => Promise<void>): Promise<void> {
  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-attach-read-hook-"));
  const probePath = path.join(probeDir, "probe");
  await fs.writeFile(probePath, "probe");
  const probe = await fs.open(probePath, "r");
  const prototype = Object.getPrototypeOf(probe) as {
    read: (...args: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }>;
  };
  await probe.close();
  const originalRead = prototype.read;
  let fired = false;
  prototype.read = async function (...args: unknown[]): Promise<{ bytesRead: number; buffer: Buffer }> {
    const result = await originalRead.apply(this, args);
    if (!fired && result.bytesRead > 0) {
      fired = true;
      await hook();
    }
    return result;
  };
  try {
    await work();
  } finally {
    prototype.read = originalRead;
  }
}

describe("room attachments", () => {
  test("copies an uploaded text file into .hydra attachments and renders prompt context", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-attach-"));
    const source = path.join(dir, "notes.md");
    await fs.writeFile(source, "hello attached file\nsecond line", "utf8");

    const attachment = await prepareRoomAttachment({
      id: "a1",
      sourcePath: source,
      sourceLabel: "notes.md",
      attachmentDir: path.join(dir, ".hydra", "attachments", "turn"),
      relativeAttachmentDir: ".hydra/attachments/turn",
      previewMaxChars: 100,
      maxBytes: 1024,
    });

    assert.equal(attachment.name, "notes.md");
    assert.equal(attachment.relativePath, ".hydra/attachments/turn/notes.md");
    assert.equal(await fs.readFile(attachment.absolutePath, "utf8"), "hello attached file\nsecond line");
    assert.equal(attachment.binary, false);
    assert.match(attachment.previewText ?? "", /hello attached file/);

    const rendered = renderRoomAttachmentsForPrompt([attachment]);
    assert.match(rendered, /--- Uploaded files ---/);
    assert.match(rendered, /Path: \.hydra\/attachments\/turn\/notes\.md/);
    assert.match(rendered, /```text\nhello attached file/);
    assert.deepEqual(roomAttachmentSummaries([attachment]), [{
      kind: "text-file",
      label: "notes.md -> .hydra/attachments/turn/notes.md",
      chars: "hello attached file\nsecond line".length,
    }]);
  });

  test("sanitizes dangerous attachment names", () => {
    assert.equal(sanitizeAttachmentFileName("..\\secret?.txt"), ".._secret_.txt");
    assert.equal(sanitizeAttachmentFileName("   "), "attachment");
  });

  test("refuses files above the attachment size limit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-attach-limit-"));
    const source = path.join(dir, "large.bin");
    await fs.writeFile(source, Buffer.alloc(8));

    await assert.rejects(
      prepareRoomAttachment({
        id: "a1",
        sourcePath: source,
        sourceLabel: "large.bin",
        attachmentDir: path.join(dir, ".hydra", "attachments", "turn"),
        relativeAttachmentDir: ".hydra/attachments/turn",
        previewMaxChars: 100,
        maxBytes: 4,
      }),
      /above the 4 B attachment limit/
    );
  });

  test("refuses a selected source symlink without reading its target", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-attach-source-link-"));
    const secret = path.join(dir, "secret.txt");
    const source = path.join(dir, "selected.txt");
    await fs.writeFile(secret, "do not copy", "utf8");
    try {
      await fs.symlink(secret, source, "file");
    } catch (err) {
      t.skip(`symlink creation unavailable: ${String(err)}`);
      return;
    }

    await assert.rejects(prepareRoomAttachment(attachmentInput(dir, source)), /symbolic link/);
    await assert.rejects(fs.access(path.join(dir, ".hydra", "attachments", "turn", "selected.txt")));
  });

  test("refuses a selected source hard link", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-attach-source-hardlink-"));
    const secret = path.join(dir, "secret.txt");
    const source = path.join(dir, "selected.txt");
    await fs.writeFile(secret, "do not copy", "utf8");
    try {
      await fs.link(secret, source);
    } catch (err) {
      t.skip(`hard-link creation unavailable: ${String(err)}`);
      return;
    }

    await assert.rejects(prepareRoomAttachment(attachmentInput(dir, source)), /multiple hard links/);
  });

  test("does not write through a linked .hydra parent", async (t) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-attach-parent-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-attach-parent-outside-"));
    const source = path.join(workspace, "notes.md");
    await fs.writeFile(source, "safe bytes", "utf8");
    try {
      await fs.symlink(outside, path.join(workspace, ".hydra"), process.platform === "win32" ? "junction" : "dir");
    } catch (err) {
      t.skip(`directory links are unavailable: ${String(err)}`);
      return;
    }

    await assert.rejects(prepareRoomAttachment(attachmentInput(workspace, source)), /linked or non-directory attachment parent/);
    assert.deepEqual(await fs.readdir(outside), []);
  });

  test("does not write through a linked .hydra/attachments directory", async (t) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-attach-root-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-attach-root-outside-"));
    const source = path.join(workspace, "notes.md");
    await fs.writeFile(source, "safe bytes", "utf8");
    await fs.mkdir(path.join(workspace, ".hydra"));
    try {
      await fs.symlink(
        outside,
        path.join(workspace, ".hydra", "attachments"),
        process.platform === "win32" ? "junction" : "dir"
      );
    } catch (err) {
      t.skip(`directory links are unavailable: ${String(err)}`);
      return;
    }

    await assert.rejects(prepareRoomAttachment(attachmentInput(workspace, source)), /linked or non-directory attachment parent/);
    assert.deepEqual(await fs.readdir(outside), []);
  });

  test("leaves planted destination symlinks untouched and creates an exclusive sibling", async (t) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-attach-destination-link-"));
    const sourceDir = path.join(workspace, "source");
    const attachmentDir = path.join(workspace, ".hydra", "attachments", "turn");
    const source = path.join(sourceDir, "notes.md");
    const victim = path.join(workspace, "victim.txt");
    await fs.mkdir(sourceDir);
    await fs.mkdir(attachmentDir, { recursive: true });
    await fs.writeFile(source, "new attachment", "utf8");
    await fs.writeFile(victim, "victim bytes", "utf8");
    try {
      await fs.symlink(victim, path.join(attachmentDir, "notes.md"), "file");
    } catch (err) {
      t.skip(`symlink creation unavailable: ${String(err)}`);
      return;
    }

    const attachment = await prepareRoomAttachment(attachmentInput(workspace, source));
    assert.equal(attachment.name, "notes-1.md");
    assert.equal(await fs.readFile(victim, "utf8"), "victim bytes");
    assert.equal(await fs.readFile(attachment.absolutePath, "utf8"), "new attachment");
  });

  test("leaves planted destination hard links untouched and creates an exclusive sibling", async (t) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-attach-destination-hardlink-"));
    const sourceDir = path.join(workspace, "source");
    const attachmentDir = path.join(workspace, ".hydra", "attachments", "turn");
    const source = path.join(sourceDir, "notes.md");
    const victim = path.join(workspace, "victim.txt");
    await fs.mkdir(sourceDir);
    await fs.mkdir(attachmentDir, { recursive: true });
    await fs.writeFile(source, "new attachment", "utf8");
    await fs.writeFile(victim, "victim bytes", "utf8");
    try {
      await fs.link(victim, path.join(attachmentDir, "notes.md"));
    } catch (err) {
      t.skip(`hard-link creation unavailable: ${String(err)}`);
      return;
    }

    const attachment = await prepareRoomAttachment(attachmentInput(workspace, source));
    assert.equal(attachment.name, "notes-1.md");
    assert.equal(await fs.readFile(victim, "utf8"), "victim bytes");
    assert.equal(await fs.readFile(attachment.absolutePath, "utf8"), "new attachment");
  });

  test("rejects a source path swapped while copying and removes the untrusted copy", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-attach-source-swap-"));
    const source = path.join(workspace, "notes.md");
    const original = path.join(workspace, "notes-original.md");
    const replacement = path.join(workspace, "replacement.md");
    await fs.writeFile(source, Buffer.alloc(128 * 1024, 0x61));
    await fs.writeFile(replacement, "replacement secret", "utf8");

    await withFirstFileReadHook(async () => {
      await fs.rename(source, original);
      await fs.rename(replacement, source);
    }, async () => {
      await assert.rejects(
        prepareRoomAttachment(attachmentInput(workspace, source, { maxBytes: 256 * 1024 })),
        /(?:source path swap|source changed)/
      );
    });

    const attachmentDir = path.join(workspace, ".hydra", "attachments", "turn");
    assert.deepEqual(await fs.readdir(attachmentDir), []);
  });

  test("enforces the byte cap while copying a growing source", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-attach-growing-source-"));
    const source = path.join(workspace, "growing.bin");
    await fs.writeFile(source, Buffer.alloc(128 * 1024, 0x61));

    await withFirstFileReadHook(async () => {
      await fs.appendFile(source, Buffer.alloc(96 * 1024, 0x62));
    }, async () => {
      await assert.rejects(
        prepareRoomAttachment(attachmentInput(workspace, source, { maxBytes: 160 * 1024 })),
        /above the 160\.0 KiB attachment limit/
      );
    });

    const attachmentDir = path.join(workspace, ".hydra", "attachments", "turn");
    assert.deepEqual(await fs.readdir(attachmentDir), []);
  });

  test("rejects a display path that escapes .hydra/attachments", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-attach-relative-path-"));
    const source = path.join(workspace, "notes.md");
    await fs.writeFile(source, "safe bytes", "utf8");
    await assert.rejects(
      prepareRoomAttachment(attachmentInput(workspace, source, { relativeAttachmentDir: ".hydra/attachments/../../outside" })),
      /outside \.hydra\/attachments/
    );
  });

  test("rejects a destination outside a workspace .hydra/attachments root", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-attach-absolute-path-"));
    const source = path.join(workspace, "notes.md");
    await fs.writeFile(source, "safe bytes", "utf8");
    await assert.rejects(
      prepareRoomAttachment(attachmentInput(workspace, source, { attachmentDir: path.join(workspace, "outside") })),
      /outside a workspace \.hydra\/attachments root/
    );
  });
});
