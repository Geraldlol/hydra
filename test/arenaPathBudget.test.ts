import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ARENA_PHYSICAL_WORKTREE_HASH_HEX_LENGTH,
  ARENA_TRACKED_PATH_MAX_BYTES,
  ARENA_TRACKED_PATHS_MAX_BYTES,
  ARENA_TRACKED_PATHS_MAX_RECORDS,
  ArenaPathBudgetError,
  arenaPhysicalWorktreeSegment,
  parseArenaTrackedPathsZ,
  preflightArenaWorktreePathBudget,
} from "../src/arenaPathBudget";

function pathsZ(...paths: readonly string[]): Buffer {
  if (paths.length === 0) return Buffer.alloc(0);
  return Buffer.from(`${paths.join("\0")}\0`, "utf8");
}

function assertPathError(
  expectedCode: ArenaPathBudgetError["code"],
  work: () => unknown,
): void {
  assert.throws(work, (error: unknown) =>
    error instanceof ArenaPathBudgetError
    && error.code === expectedCode);
}

describe("Arena physical worktree segments", () => {
  test("deterministically maps both logical identifiers to a short segment", () => {
    const first = arenaPhysicalWorktreeSegment("arena-run", "codex");
    assert.equal(first, arenaPhysicalWorktreeSegment("arena-run", "codex"));
    assert.notEqual(first, arenaPhysicalWorktreeSegment("arena-run-2", "codex"));
    assert.notEqual(first, arenaPhysicalWorktreeSegment("arena-run", "claude"));
    assert.match(
      first,
      new RegExp(`^w-[a-f0-9]{${
        ARENA_PHYSICAL_WORKTREE_HASH_HEX_LENGTH
      }}$`),
    );
    assert.equal(first.length, 2 + ARENA_PHYSICAL_WORKTREE_HASH_HEX_LENGTH);
  });

  test("rejects identifiers that could become physical path material", () => {
    assertPathError(
      "invalidIdentifier",
      () => arenaPhysicalWorktreeSegment("../run", "codex"),
    );
    assertPathError(
      "invalidIdentifier",
      () => arenaPhysicalWorktreeSegment("run", ""),
    );
    assertPathError(
      "invalidIdentifier",
      () => arenaPhysicalWorktreeSegment("run", "head/one"),
    );
  });
});

describe("parseArenaTrackedPathsZ", () => {
  test("returns only redacted bounded aggregate metadata", () => {
    const secretPath = "private/token-\u{1f600}.ts";
    const result = parseArenaTrackedPathsZ(
      pathsZ("a.ts", secretPath),
      { platform: "win32" },
    );

    assert.equal(result.trackedPathCount, 2);
    assert.equal(result.longestTrackedPathUtf16Units, secretPath.length);
    assert.equal(
      result.longestTrackedPathUtf8Bytes,
      Buffer.byteLength(secretPath, "utf8"),
    );
    assert.match(result.trackedPathsSha256, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(result), /private|token/u);
  });

  test("accepts an empty repository listing", () => {
    assert.deepEqual(
      parseArenaTrackedPathsZ(Buffer.alloc(0), { platform: "win32" }),
      {
        trackedPathCount: 0,
        trackedPathsBytes: 0,
        trackedPathsSha256:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        longestTrackedPathUtf8Bytes: null,
        longestTrackedPathUtf16Units: null,
      },
    );
  });

  test("fails closed on missing termination, empty records, and malformed UTF-8", () => {
    assertPathError(
      "trackedPathsUnterminated",
      () => parseArenaTrackedPathsZ(Buffer.from("a.ts"), { platform: "win32" }),
    );
    assertPathError(
      "trackedPathEmpty",
      () => parseArenaTrackedPathsZ(Buffer.from("a.ts\0\0"), {
        platform: "win32",
      }),
    );
    assertPathError(
      "trackedPathMalformedUtf8",
      () => parseArenaTrackedPathsZ(Buffer.from([0xc3, 0x28, 0]), {
        platform: "win32",
      }),
    );
  });

  test("fails closed on traversal, absolute, ambiguous, and Windows-reserved paths", () => {
    for (const invalid of [
      "../secret",
      "/absolute",
      "dir//file",
      "dir\\file",
      "C:/drive",
      "CON.txt",
      "trailing.",
      "wild*.ts",
    ]) {
      assertPathError(
        "trackedPathInvalid",
        () => parseArenaTrackedPathsZ(pathsZ(invalid), { platform: "win32" }),
      );
    }
  });

  test("enforces field, record, and total byte limits", () => {
    assertPathError(
      "trackedPathOversized",
      () => parseArenaTrackedPathsZ(
        pathsZ("x".repeat(ARENA_TRACKED_PATH_MAX_BYTES + 1)),
        { platform: "win32" },
      ),
    );

    const excessiveRecords = Buffer.from(
      "a\0".repeat(ARENA_TRACKED_PATHS_MAX_RECORDS + 1),
      "utf8",
    );
    assertPathError(
      "trackedPathCount",
      () => parseArenaTrackedPathsZ(excessiveRecords, { platform: "win32" }),
    );

    const excessiveBytes = Buffer.alloc(ARENA_TRACKED_PATHS_MAX_BYTES + 1, 1);
    assertPathError(
      "trackedPathsOversized",
      () => parseArenaTrackedPathsZ(excessiveBytes, { platform: "win32" }),
    );
  });
});

describe("preflightArenaWorktreePathBudget", () => {
  test("checks .git and the longest tracked path with terminator and margin", () => {
    const target = "C:\\as\\w-0123456789abcdef";
    const longest = `src/${"x".repeat(80)}.ts`;
    const result = preflightArenaWorktreePathBudget(
      target,
      pathsZ("short.ts", longest),
      { platform: "win32", safetyMarginUtf16Units: 12 },
    );

    assert.equal(result.applies, true);
    assert.equal(result.accepted, true);
    assert.equal(result.reason, "withinBudget");
    assert.equal(
      result.gitMetadataPathUtf16UnitsWithTerminator,
      target.length + 1 + ".git".length + 1,
    );
    assert.equal(
      result.longestTrackedPathUtf16UnitsWithTerminator,
      target.length + 1 + longest.length + 1,
    );
    assert.equal(
      result.worstCaseUtf16UnitsWithMargin,
      target.length + 1 + longest.length + 1 + 12,
    );
    assert.doesNotMatch(JSON.stringify(result), /short\.ts|src\//u);
  });

  test("rejects when .git consumes the path budget", () => {
    const target = `C:\\${"a".repeat(244)}`;
    const result = preflightArenaWorktreePathBudget(
      target,
      Buffer.alloc(0),
      { platform: "win32", safetyMarginUtf16Units: 12 },
    );

    assert.equal(result.accepted, false);
    assert.equal(result.reason, "gitMetadataPathTooLong");
  });

  test("rejects when the longest tracked path consumes the path budget", () => {
    const target = "C:\\arena\\worktree";
    const result = preflightArenaWorktreePathBudget(
      target,
      pathsZ("x".repeat(235)),
      { platform: "win32", safetyMarginUtf16Units: 12 },
    );

    assert.equal(result.accepted, false);
    assert.equal(result.reason, "trackedPathTooLong");
  });

  test("parses strictly but marks the budget not applicable off Windows", () => {
    const result = preflightArenaWorktreePathBudget(
      "/private/arena/worktree",
      pathsZ("src/index.ts"),
      { platform: "linux" },
    );
    assert.equal(result.applies, false);
    assert.equal(result.accepted, true);
    assert.equal(result.reason, "notWindows");

    assertPathError(
      "trackedPathsUnterminated",
      () => preflightArenaWorktreePathBudget(
        "/private/arena/worktree",
        Buffer.from("src/index.ts"),
        { platform: "linux" },
      ),
    );
  });

  test("fails closed on invalid targets and margins", () => {
    for (const invalid of [
      "relative\\worktree",
      "C:/mixed/separators",
      "C:\\arena\\..\\escape",
      "\\\\server\\share\\arena",
      "C:\\arena\\CON",
    ]) {
      assertPathError(
        "invalidTargetPath",
        () => preflightArenaWorktreePathBudget(
          invalid,
          pathsZ("a.ts"),
          { platform: "win32" },
        ),
      );
    }
    assertPathError(
      "invalidOptions",
      () => preflightArenaWorktreePathBudget(
        "C:\\arena\\worktree",
        pathsZ("a.ts"),
        { platform: "win32", safetyMarginUtf16Units: 260 },
      ),
    );
  });
});
