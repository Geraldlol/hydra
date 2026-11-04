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
// Explicit native formats control the parser even when Hydra's automatic
// streaming setting is off; text/json formats must remain untouched.

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

  test("selects explicit stream-json output even when automatic streaming is disabled", () => {
    currentConfig.claudeStreamJson = false;
    try {
      assert.equal(shouldUseClaudeStreamJson(spawn(["-p", "--output-format", "stream-json"])), true);
      assert.equal(shouldUseClaudeStreamJson(spawn(["-p", "--output-format=stream-json"])), true);
    } finally {
      delete currentConfig.claudeStreamJson;
    }
  });

  test("respects explicit text and JSON output in equals form", () => {
    assert.equal(shouldUseClaudeStreamJson(spawn(["-p", "--output-format=text"])), false);
    assert.equal(shouldUseClaudeStreamJson(spawn(["-p", "--output-format=json"])), false);
  });

  test("uses the last explicit output format", () => {
    assert.equal(shouldUseClaudeStreamJson(spawn(["-p", "--output-format=text", "--output-format", "stream-json"])), true);
    assert.equal(shouldUseClaudeStreamJson(spawn(["-p", "--output-format", "stream-json", "--output-format=text"])), false);
  });

  test("ignores output-format text used as a known option value or after --", () => {
    currentConfig.claudeStreamJson = false;
    try {
      for (const args of [
        ["-p", "--system-prompt", "--output-format=stream-json"],
        ["-p", "--append-system-prompt", "--output-format", "stream-json"],
        ["-p", "--", "--output-format=stream-json"],
      ]) {
        assert.equal(shouldUseClaudeStreamJson(spawn(args)), false, JSON.stringify(args));
      }
    } finally {
      delete currentConfig.claudeStreamJson;
    }
  });

  test("does not treat a print token in a value or after -- as print mode", () => {
    assert.equal(shouldUseClaudeStreamJson(spawn(["--system-prompt", "-p"])), false);
    assert.equal(shouldUseClaudeStreamJson(spawn(["--", "-p"])), false);
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

  test("keeps an explicit stream-json format and adds required verbose output", () => {
    for (const format of [["--output-format", "stream-json"], ["--output-format=stream-json"]]) {
      const input = spawn(["-p", ...format]);
      const output = withClaudeStreamJsonArgs(input);
      assert.deepEqual(output.args.slice(0, input.args.length), input.args);
      assert.equal(output.args.filter((arg) => arg.startsWith("--output-format")).length, 1);
      assert.ok(output.args.includes("--verbose"));
    }
  });

  test("does not replace an explicit text output format", () => {
    const input = spawn(["-p", "--output-format=text"]);
    assert.strictEqual(withClaudeStreamJsonArgs(input), input);
  });

  test("injects every output flag before -- without changing literal prompt tokens", () => {
    const input = spawn(["-p", "--", "--output-format=text", "--verbose", "--include-partial-messages", "--debug-file"]);
    const output = withClaudeStreamJsonArgs(input, "debug.log");
    assert.deepEqual(output.args, [
      "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--debug-file", "debug.log",
      "--", "--output-format=text", "--verbose", "--include-partial-messages", "--debug-file",
    ]);
    assert.deepEqual(withClaudeStreamJsonArgs(output, "debug.log").args, output.args);
    assert.deepEqual(input.args, ["-p", "--", "--output-format=text", "--verbose", "--include-partial-messages", "--debug-file"]);
  });

  test("does not mistake system prompt values for existing output flags", () => {
    for (const value of ["--output-format=stream-json", "--verbose", "--include-partial-messages", "--debug-file", "--", "-"]) {
      const input = spawn(["-p", "--system-prompt", value]);
      const output = withClaudeStreamJsonArgs(input, "debug.log");
      assert.deepEqual(output.args, [
        ...input.args, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--debug-file", "debug.log",
      ], value);
      assert.deepEqual(withClaudeStreamJsonArgs(output, "debug.log").args, output.args);
    }
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
