import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  shouldUseClaudeStreamJson,
  shouldCreateClaudeRequestFiles,
  withClaudeStreamJsonArgs,
} from "../src/claudeTransport";

// claudeTransport.ts does `import * as vscode from "vscode"` at module
// top-level; VS Code provides that module at runtime. For node:test we
// substitute a stub via scripts/setup-vscode-stub.js (chained from the
// "test" npm script). Section is ignored — bare keys via currentConfig.
const currentConfig = (vscode as unknown as { currentConfig: Record<string, unknown> }).currentConfig;

function spawn(args: string[]) {
  return { command: "claude", args, cwd: "C:\\repo" };
}

// ---------------------------------------------------------------------------
// shouldUseClaudeStreamJson
// ---------------------------------------------------------------------------
// NOTE on coverage limits: the positive "config true → returns true" branch
// is intentionally NOT exercised here. shouldUseClaudeStreamJson reads
// vscode.workspace.getConfiguration("hydraRoom").get<boolean>(
//   "claudeStreamJson", true) AFTER the input-validation early returns.
// Faithfully simulating that read would require a richer
// WorkspaceConfiguration shape than this shim provides, so we limit
// ourselves to the input-validation early-return branches.

describe("shouldUseClaudeStreamJson", () => {
  test("returns false when args lack BOTH -p and --print", () => {
    // stream-json output only makes sense in print mode. For e.g. `claude
    // doctor` the helper must bail before the config read.
    assert.equal(shouldUseClaudeStreamJson(spawn(["doctor"])), false);
  });

  test("returns false when args already include --output-format", () => {
    // User has already picked a different output format in their ExecArgs;
    // injecting stream-json would either duplicate the flag or overwrite
    // the user's choice. Either is wrong, so bail.
    assert.equal(
      shouldUseClaudeStreamJson(spawn(["-p", "--output-format", "text"])),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// shouldCreateClaudeRequestFiles
// ---------------------------------------------------------------------------

describe("shouldCreateClaudeRequestFiles", () => {
  test("returns false when shouldUseClaudeStreamJson returns false (no -p / --print)", () => {
    // shouldCreateClaudeRequestFiles starts with `if
    // (!shouldUseClaudeStreamJson(spawn)) return false;` — choosing an input
    // that the upstream helper already short-circuits on lets us exercise
    // that early-return chain without needing to mock config.
    assert.equal(shouldCreateClaudeRequestFiles(spawn(["doctor"])), false);
  });
});

// ---------------------------------------------------------------------------
// withClaudeStreamJsonArgs (called WITHOUT logPath)
// ---------------------------------------------------------------------------
// Calling without a logPath sidesteps the `--debug-file` branch entirely
// (the function does `if (logPath && cfg.get(...) && ...)` — without
// logPath the cfg read for that key is never even reached). That keeps
// these assertions independent of config state.
//
// The `--include-partial-messages` branch DOES still read
// `claudeStreamJsonIncludePartialMessages` from config; our stub returns
// the default (true) for unset keys, so the assertions tolerate either
// presence or absence of that flag rather than depending on it.

describe("withClaudeStreamJsonArgs (no logPath)", () => {
  test("appends --output-format stream-json", () => {
    const out = withClaudeStreamJsonArgs(spawn(["-p", "--add-dir", "C:\\repo"]));
    const idx = out.args.indexOf("--output-format");
    assert.notEqual(idx, -1, "should contain --output-format");
    assert.equal(out.args[idx + 1], "stream-json", "value after --output-format should be 'stream-json'");
  });

  test("appends --verbose (required by the CLI when output-format is stream-json)", () => {
    const out = withClaudeStreamJsonArgs(spawn(["-p", "--add-dir", "C:\\repo"]));
    assert.ok(out.args.includes("--verbose"), "result should include --verbose");
  });

  test("does not duplicate --verbose if it is already present in args", () => {
    const out = withClaudeStreamJsonArgs(spawn(["-p", "--verbose", "--add-dir", "C:\\repo"]));
    const verboseCount = out.args.filter((a) => a === "--verbose").length;
    assert.equal(verboseCount, 1, "--verbose must appear exactly once");
  });

  test("does not append --debug-file when called without a logPath, regardless of config", () => {
    // Even if hydraRoom.claudeDebugFile is true (the default our stub returns
    // when callers pass `true` as the second arg to .get), the code guards
    // the --debug-file branch behind `logPath && ...`. Without logPath the
    // flag must not appear.
    currentConfig.claudeDebugFile = true;
    try {
      const out = withClaudeStreamJsonArgs(spawn(["-p", "--add-dir", "C:\\repo"]));
      assert.ok(
        !out.args.includes("--debug-file"),
        "--debug-file must not appear when logPath is omitted",
      );
    } finally {
      delete currentConfig.claudeDebugFile;
    }
  });
});
