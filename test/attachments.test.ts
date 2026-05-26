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
});
