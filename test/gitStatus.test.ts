import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { parseGitStatusEntries, gitStatusKind, type WorkspaceChange } from "../src/gitStatus";

// These feed real `git status --porcelain=v1 -z` byte strings. The -z format
// emits each entry as `XY<space>PATH` terminated by a NUL (\0). Rename/copy
// entries (R/C) emit TWO NUL-separated fields: the NEW path first, then the
// ORIG path — the parser must keep the NEW path and consume the ORIG field so
// it is not re-emitted as a phantom change.

describe("parseGitStatusEntries", () => {
  test("parses a modified (unstaged) tracked file", () => {
    // ` M` = worktree-modified, not staged.
    const raw = " M src/panel.ts\0";
    assert.deepEqual<WorkspaceChange[]>(parseGitStatusEntries(raw), [
      { path: "src/panel.ts", status: "M", kind: "modified" },
    ]);
  });

  test("parses an untracked file", () => {
    const raw = "?? media/new-asset.png\0";
    assert.deepEqual<WorkspaceChange[]>(parseGitStatusEntries(raw), [
      { path: "media/new-asset.png", status: "??", kind: "untracked" },
    ]);
  });

  test("parses a staged add", () => {
    // `A ` = added to the index (staged), clean worktree.
    const raw = "A  src/gitStatus.ts\0";
    assert.deepEqual<WorkspaceChange[]>(parseGitStatusEntries(raw), [
      { path: "src/gitStatus.ts", status: "A", kind: "added" },
    ]);
  });

  test("rename keeps the NEW path and consumes the trailing ORIG entry", () => {
    // `R ` = staged rename. In -z output the NEW path is the first field and
    // the ORIG path follows in the next NUL-separated field.
    const raw = "R  src/newName.ts\0src/oldName.ts\0";
    const changes = parseGitStatusEntries(raw);
    assert.equal(changes.length, 1, "rename must emit exactly one change");
    assert.equal(changes[0].path, "src/newName.ts", "must keep the NEW path");
    assert.equal(changes[0].kind, "renamed");
    assert.equal(changes[0].status, "R");
    // The ORIG path must NOT appear as its own change.
    assert.ok(
      !changes.some((c) => c.path === "src/oldName.ts"),
      "ORIG path must be consumed, not emitted as a separate change"
    );
  });

  test("copy consumes the trailing ORIG entry just like a rename", () => {
    const raw = "C  src/copy.ts\0src/source.ts\0";
    const changes = parseGitStatusEntries(raw);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, "src/copy.ts");
    assert.equal(changes[0].kind, "copied");
    assert.ok(!changes.some((c) => c.path === "src/source.ts"));
  });

  test("parses a mixed stream including a rename without leaking the ORIG path", () => {
    const raw =
      " M src/panel.ts\0" +
      "?? media/new-asset.png\0" +
      "R  src/newName.ts\0src/oldName.ts\0" +
      "A  src/gitStatus.ts\0";
    const changes = parseGitStatusEntries(raw);
    assert.deepEqual<WorkspaceChange[]>(changes, [
      { path: "src/panel.ts", status: "M", kind: "modified" },
      { path: "media/new-asset.png", status: "??", kind: "untracked" },
      { path: "src/newName.ts", status: "R", kind: "renamed" },
      { path: "src/gitStatus.ts", status: "A", kind: "added" },
    ]);
    assert.ok(!changes.some((c) => c.path === "src/oldName.ts"));
  });

  test("skips entries shorter than the XY<space> prefix", () => {
    // The trailing empty field after the final NUL must not become a change.
    const raw = " M src/panel.ts\0";
    assert.equal(parseGitStatusEntries(raw).length, 1);
  });
});

describe("gitStatusKind", () => {
  test("classifies each porcelain status code", () => {
    assert.equal(gitStatusKind("??"), "untracked");
    assert.equal(gitStatusKind("A "), "added");
    assert.equal(gitStatusKind(" D"), "deleted");
    assert.equal(gitStatusKind("R "), "renamed");
    assert.equal(gitStatusKind("C "), "copied");
    assert.equal(gitStatusKind(" M"), "modified");
    assert.equal(gitStatusKind("??"), "untracked");
  });

  test("falls back to 'changed' for unrecognized codes", () => {
    assert.equal(gitStatusKind("!!"), "changed");
  });
});
