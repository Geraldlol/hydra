import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { synthesizeUntrackedFileDiff } from "../src/panel";

describe("untracked diff safety", () => {
  test("does not follow an untracked symlink outside the workspace", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-diff-root-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-diff-outside-"));
    const secret = "HYDRA_EXTERNAL_SECRET";
    const target = path.join(outside, "secret.txt");
    await fs.writeFile(target, secret, "utf8");
    const link = path.join(root, "linked.txt");
    try {
      await fs.symlink(target, link, "file");
    } catch (err) {
      t.skip(`symlink creation unavailable: ${String(err)}`);
      return;
    }

    const diff = await synthesizeUntrackedFileDiff(root, "linked.txt");
    assert.doesNotMatch(diff, new RegExp(secret));
    assert.match(diff, /omitted untracked file/i);
  });

  test("does not read an untracked hardlink", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-diff-hardlink-"));
    const target = path.join(root, "target.txt");
    const link = path.join(root, "linked.txt");
    const secret = "HYDRA_HARDLINK_SECRET";
    await fs.writeFile(target, secret, "utf8");
    try {
      await fs.link(target, link);
    } catch (err) {
      t.skip(`hardlink creation unavailable: ${String(err)}`);
      return;
    }

    const diff = await synthesizeUntrackedFileDiff(root, "linked.txt");
    assert.doesNotMatch(diff, new RegExp(secret));
    assert.match(diff, /omitted untracked file/i);
  });

  test("bounds oversized untracked files before decoding", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-diff-large-"));
    await fs.writeFile(path.join(root, "large.txt"), "x".repeat(3 * 1024 * 1024), "utf8");

    const diff = await synthesizeUntrackedFileDiff(root, "large.txt", 4);
    assert.ok(diff.length < 70 * 1024);
    assert.match(diff, /untracked file truncated/i);
  });
});
