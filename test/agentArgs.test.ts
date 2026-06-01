import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { insertBeforeStdinDash, withModelArgs, withEffortArgs } from "../src/agentArgs";

// agentArgs.ts does `import * as vscode from "vscode"` at module top-level;
// at runtime VS Code provides that module. For node:test runs we substitute
// a stub via scripts/setup-vscode-stub.js (chained from the "test" npm
// script). The stub exposes `currentConfig` so tests can pretend the user
// has (or hasn't) configured a model / effort. Section is ignored — use
// bare keys (e.g. currentConfig.codexModel = "opus").
const currentConfig = (vscode as unknown as { currentConfig: Record<string, unknown> }).currentConfig;

// ---------------------------------------------------------------------------
// insertBeforeStdinDash — pure helper, no config dependency
// ---------------------------------------------------------------------------

describe("insertBeforeStdinDash", () => {
  test("inserts before a single trailing '-' stdin sentinel", () => {
    assert.deepEqual(
      insertBeforeStdinDash(["exec", "-"], ["--model", "opus"]),
      ["exec", "--model", "opus", "-"],
    );
  });

  test("inserts before the LAST '-' when args contain multiple dashes (lastIndexOf semantics)", () => {
    // The second "-" is the stdin sentinel; the insertion must land at that
    // boundary so the first "-" is preserved as a positional flag value.
    assert.deepEqual(
      insertBeforeStdinDash(["exec", "-", "extra", "-"], ["--flag"]),
      ["exec", "-", "extra", "--flag", "-"],
    );
  });

  test("inserts at the last dash even when it is not in trailing position", () => {
    // Documented behavior is "lastIndexOf", not "trailing only". If "-" is the
    // last "-" but not the final element, insertion still happens there.
    assert.deepEqual(
      insertBeforeStdinDash(["exec", "-", "tail"], ["--flag"]),
      ["exec", "--flag", "-", "tail"],
    );
  });

  test("appends when no '-' is present", () => {
    assert.deepEqual(
      insertBeforeStdinDash(["doctor"], ["--verbose"]),
      ["doctor", "--verbose"],
    );
  });

  test("appends to an empty arg list when no '-' is present", () => {
    assert.deepEqual(insertBeforeStdinDash([], ["--x", "1"]), ["--x", "1"]);
  });

  test("inserts multiple tokens in order, preserving the dash position", () => {
    assert.deepEqual(
      insertBeforeStdinDash(["exec", "-"], ["-c", 'k="v"', "--model", "opus"]),
      ["exec", "-c", 'k="v"', "--model", "opus", "-"],
    );
  });

  test("does not mutate the input args array", () => {
    const input = ["exec", "-"];
    const snapshot = [...input];
    const out = insertBeforeStdinDash(input, ["--model", "opus"]);
    assert.deepEqual(input, snapshot, "input must not be mutated");
    assert.notStrictEqual(out, input, "must return a new array reference");
  });

  test("does not mutate the insertion array", () => {
    const insertion = ["--model", "opus"];
    const snapshot = [...insertion];
    insertBeforeStdinDash(["exec", "-"], insertion);
    assert.deepEqual(insertion, snapshot, "insertion must not be mutated");
  });

  test("empty insertion array is a structural pass-through (still returns a fresh copy)", () => {
    const input = ["exec", "-"];
    const out = insertBeforeStdinDash(input, []);
    assert.deepEqual(out, ["exec", "-"]);
    assert.notStrictEqual(out, input, "still returns a new array");
  });

  test("empty insertion array on dash-less args also returns a fresh copy", () => {
    const input = ["doctor"];
    const out = insertBeforeStdinDash(input, []);
    assert.deepEqual(out, ["doctor"]);
    assert.notStrictEqual(out, input);
  });
});

// ---------------------------------------------------------------------------
// withModelArgs / withEffortArgs — limited coverage
// ---------------------------------------------------------------------------
// NOTE on coverage limits: modelForPhase / effortForPhase read
// vscode.workspace.getConfiguration("hydraRoom").get(...) UNCONDITIONALLY
// at the top of withModelArgs / withEffortArgs (before any early-return).
// We can drive that read deterministically via `currentConfig` above, but
// per the task description we deliberately do NOT exercise the positive
// "inject the flag" branch here — that's the behavior under config control,
// and we leave it for an integration test that owns the real vscode shape.
// We DO cover:
//   - the "no model/effort configured → return spawn unchanged" path
//     (config returns undefined → effectivePhasedSetting → "" → early return),
//   - the "user already wrote --model/-m/--effort in their ExecArgs → respect
//     it" path (config returns a value but the existing arg short-circuits),
//   - the "Codex non-exec subcommand → skip" path (model/reasoning flags are
//     only meaningful on `codex exec`).

function spawn(args: string[]) {
  return { command: "codex", args, cwd: "C:\\repo" };
}

describe("withModelArgs", () => {
  test("returns spawn unchanged when no model is configured (config undefined)", () => {
    delete currentConfig.codexModel;
    delete currentConfig.claudeModel;
    const s = spawn(["exec", "-"]);
    const out = withModelArgs(s, "codex", "build");
    assert.strictEqual(out, s, "no model set → identical reference returned");
  });

  test("returns spawn unchanged when args already contain --model (codex exec)", () => {
    currentConfig.codexModel = "opus"; // would otherwise be injected
    const s = spawn(["exec", "--model", "gpt-5.4", "-"]);
    const out = withModelArgs(s, "codex", "build");
    assert.strictEqual(out, s, "explicit --model in argv wins; same ref returned");
  });

  test("returns spawn unchanged when args already contain the short -m flag", () => {
    currentConfig.codexModel = "opus";
    const s = spawn(["exec", "-m", "gpt-5.4", "-"]);
    const out = withModelArgs(s, "codex", "build");
    assert.strictEqual(out, s);
  });

  test("returns spawn unchanged for Codex non-exec subcommand even when a model is configured", () => {
    // --model is only valid on `codex exec`; for `codex doctor` (or any other
    // subcommand) we must leave args alone rather than risk a CLI error.
    currentConfig.codexModel = "opus";
    const s = spawn(["doctor"]);
    const out = withModelArgs(s, "codex", "build");
    assert.strictEqual(out, s);
  });

  // Positive splice case ("--model <value>" actually gets inserted before "-")
  // intentionally skipped — see note above.
});

describe("withEffortArgs", () => {
  test("returns spawn unchanged when no effort is configured (config undefined) — claude", () => {
    delete currentConfig.claudeEffort;
    const s = { command: "claude", args: ["-p", "--add-dir", "C:\\repo"], cwd: "C:\\repo" };
    const out = withEffortArgs(s, "claude", "build");
    assert.strictEqual(out, s);
  });

  test("returns spawn unchanged when no reasoning is configured (config undefined) — codex", () => {
    delete currentConfig.codexReasoning;
    const s = spawn(["exec", "-"]);
    const out = withEffortArgs(s, "codex", "build");
    assert.strictEqual(out, s);
  });

  test("returns spawn unchanged when claude args already contain --effort", () => {
    currentConfig.claudeEffort = "high";
    const s = { command: "claude", args: ["-p", "--effort", "low", "--add-dir", "C:\\repo"], cwd: "C:\\repo" };
    const out = withEffortArgs(s, "claude", "build");
    assert.strictEqual(out, s, "explicit --effort in argv wins; same ref returned");
  });

  test("returns spawn unchanged for Codex non-exec subcommand even when reasoning is configured", () => {
    currentConfig.codexReasoning = "high";
    const s = spawn(["doctor"]);
    const out = withEffortArgs(s, "codex", "build");
    assert.strictEqual(out, s);
  });

  test("returns spawn unchanged when codex args already contain model_reasoning_effort=", () => {
    // Detection uses `args.some(a => a.startsWith("model_reasoning_effort="))`
    // — the user has hand-written the `-c key=value` override in their
    // ExecArgs, so we respect it rather than appending a duplicate.
    currentConfig.codexReasoning = "high";
    const s = spawn(["exec", "-c", "model_reasoning_effort=low", "-"]);
    const out = withEffortArgs(s, "codex", "build");
    assert.strictEqual(out, s);
  });

  // Positive splice cases (claude --effort injection, codex -c model_reasoning_effort
  // injection) intentionally skipped — they exercise config-driven behavior
  // that belongs in an integration test with a real-shaped vscode config.
});
