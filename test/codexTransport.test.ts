import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  shouldCaptureCodexLastMessage,
  withCodexLastMessageArgs,
  shouldUseCodexJson,
  withCodexJsonArgs,
} from "../src/codexTransport";

// codexTransport.ts does `import * as vscode from "vscode"` at module
// top-level; VS Code provides that module at runtime. For node:test we
// substitute a stub via scripts/setup-vscode-stub.js (chained from the
// "test" npm script). The stub returns the `defaultValue` for every config
// read by default, which is enough to exercise the input-validation
// early-return branches below. Positive config-driven `should*` branches
// stay uncovered here.

function spawn(args: string[]) {
  return { command: "codex", args, cwd: "C:\\repo" };
}

// ---------------------------------------------------------------------------
// shouldCaptureCodexLastMessage
// ---------------------------------------------------------------------------
// NOTE on coverage limits: the positive "config true → returns true" branch
// is intentionally NOT exercised here. shouldCaptureCodexLastMessage reads
// vscode.workspace.getConfiguration("hydraRoom").get<boolean>(
//   "codexCaptureLastMessage", true) AFTER the input-validation early
// returns. Faithfully simulating that read would require a richer
// WorkspaceConfiguration shape than this shim provides, so we limit
// ourselves to the input-validation early-return branches that fire BEFORE
// the config read.

describe("shouldCaptureCodexLastMessage", () => {
  test("returns false when args[0] is not 'exec'", () => {
    // `--output-last-message` is only valid on `codex exec`; for `codex review`
    // (or any other subcommand) the helper must bail before the config read.
    assert.equal(shouldCaptureCodexLastMessage(spawn(["review", "-"])), false);
  });

  test("returns false when args already include --output-last-message", () => {
    // User has already wired --output-last-message into their ExecArgs;
    // injecting again would duplicate the flag.
    assert.equal(
      shouldCaptureCodexLastMessage(
        spawn(["exec", "--output-last-message", "C:\\reply.last.txt", "-"]),
      ),
      false,
    );
  });

  // Positive branch ("config codexCaptureLastMessage === true → returns true")
  // intentionally skipped — see module-level note above.
});

// ---------------------------------------------------------------------------
// withCodexLastMessageArgs
// ---------------------------------------------------------------------------

describe("withCodexLastMessageArgs", () => {
  test("inserts --output-last-message <replyPath> before the trailing '-' stdin sentinel", () => {
    // Key invariant: anything inserted must land BEFORE the trailing "-",
    // otherwise codex exec would treat our flag pair as positionals to the
    // stdin reader rather than flags on `exec`.
    const out = withCodexLastMessageArgs(
      spawn(["exec", "--sandbox", "read-only", "-"]),
      "C:\\repo\\.hydra\\replies\\r.last.txt",
    );
    assert.deepEqual(out.args, [
      "exec",
      "--sandbox",
      "read-only",
      "--output-last-message",
      "C:\\repo\\.hydra\\replies\\r.last.txt",
      "-",
    ]);
  });

  test("appends when no trailing '-' is present", () => {
    // Non-exec / non-stdin shapes (e.g. someone wired their own non-stdin
    // codex flow) get an append, matching insertBeforeStdinDash's fallback.
    const out = withCodexLastMessageArgs(
      spawn(["exec", "--sandbox", "read-only"]),
      "C:\\reply.last.txt",
    );
    assert.deepEqual(out.args, [
      "exec",
      "--sandbox",
      "read-only",
      "--output-last-message",
      "C:\\reply.last.txt",
    ]);
  });

  test("does not mutate the input spawn (returns a new object; input args array unchanged)", () => {
    const inputArgs = ["exec", "--sandbox", "read-only", "-"];
    const argsSnapshot = [...inputArgs];
    const s = spawn(inputArgs);
    const out = withCodexLastMessageArgs(s, "C:\\reply.last.txt");
    assert.deepEqual(inputArgs, argsSnapshot, "input args must not be mutated");
    assert.notStrictEqual(out, s, "must return a new spawn object");
    assert.notStrictEqual(out.args, inputArgs, "must return a new args array");
  });
});

// ---------------------------------------------------------------------------
// shouldUseCodexJson
// ---------------------------------------------------------------------------
// Same coverage rationale as shouldCaptureCodexLastMessage above — only the
// input-validation early returns are unit-testable without a richer config
// shim.

describe("shouldUseCodexJson", () => {
  test("returns false when args[0] is not 'exec'", () => {
    // `--json` is only meaningful on `codex exec`; bail before config read.
    assert.equal(shouldUseCodexJson(spawn(["review", "-"])), false);
  });

  test("returns false when args already include --json", () => {
    // User has already opted into the JSON stream in their ExecArgs.
    assert.equal(shouldUseCodexJson(spawn(["exec", "--json", "-"])), false);
  });

  test("returns false when args already include --experimental-json", () => {
    // Older codex builds expose the JSON stream under --experimental-json;
    // helper must respect either spelling so it doesn't inject a duplicate.
    assert.equal(shouldUseCodexJson(spawn(["exec", "--experimental-json", "-"])), false);
  });
});

// ---------------------------------------------------------------------------
// withCodexJsonArgs
// ---------------------------------------------------------------------------

describe("withCodexJsonArgs", () => {
  test("splices --json before the trailing '-' stdin sentinel", () => {
    const out = withCodexJsonArgs(spawn(["exec", "--sandbox", "read-only", "-"]));
    assert.deepEqual(out.args, ["exec", "--sandbox", "read-only", "--json", "-"]);
  });

  test("appends --json at end when no '-' is present", () => {
    const out = withCodexJsonArgs(spawn(["exec", "--sandbox", "read-only"]));
    assert.deepEqual(out.args, ["exec", "--sandbox", "read-only", "--json"]);
  });
});
