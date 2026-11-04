import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  shouldCaptureCodexLastMessage,
  withCodexLastMessageArgs,
  shouldUseCodexJson,
  withCodexJsonArgs,
  withCodexSkipGitRepoCheckArgs,
} from "../src/codexTransport";

// codexTransport.ts does `import * as vscode from "vscode"` at module
// top-level; VS Code provides that module at runtime. For node:test we
// substitute a stub via scripts/setup-vscode-stub.js (chained from the
// "test" npm script). The stub returns the `defaultValue` for every config
// read by default; currentConfig lets explicit flag tests distinguish native
// output selection from Hydra's automatic flag settings.

function spawn(args: string[]) {
  return { command: "codex", args, cwd: "C:\\repo" };
}

const currentConfig = (vscode as unknown as { currentConfig: Record<string, unknown> }).currentConfig;

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
// This predicate also selects the reply/usage parser, so explicit native JSON
// flags must be recognized independently of Hydra's automatic flag setting.

describe("shouldUseCodexJson", () => {
  test("returns false for a non-exec subcommand", () => {
    // `--json` is only meaningful on `codex exec`; bail before config read.
    assert.equal(shouldUseCodexJson(spawn(["review", "-"])), false);
  });

  test("selects JSON parsing for an explicit --json even when automatic JSON is disabled", () => {
    currentConfig.codexJson = false;
    try {
      assert.equal(shouldUseCodexJson(spawn(["exec", "--json", "-"])), true);
    } finally {
      delete currentConfig.codexJson;
    }
  });

  test("selects JSON parsing for the legacy explicit JSON flag", () => {
    assert.equal(shouldUseCodexJson(spawn(["exec", "--experimental-json", "-"])), true);
  });

  test("recognizes exec after global flags and keeps the automatic JSON setting", () => {
    assert.equal(shouldUseCodexJson(spawn(["--profile", "hydra", "exec", "-"])), true);
    assert.equal(shouldUseCodexJson(spawn(["--profile=hydra", "exec", "-"])), true);
    currentConfig.codexJson = false;
    try {
      assert.equal(shouldUseCodexJson(spawn(["--profile", "hydra", "exec", "-"])), false);
    } finally {
      delete currentConfig.codexJson;
    }
  });

  test("does not mistake a global option value for the exec subcommand", () => {
    assert.equal(shouldUseCodexJson(spawn(["--profile", "exec", "review"])), false);
  });

  test("ignores JSON tokens after -- and JSON-looking option values", () => {
    currentConfig.codexJson = false;
    try {
      for (const args of [
        ["exec", "--", "--json"],
        ["exec", "--", "--experimental-json"],
        ["exec", "--output-last-message", "--json", "-"],
        ["exec", "--output-last-message", "--experimental-json", "-"],
      ]) {
        assert.equal(shouldUseCodexJson(spawn(args)), false, JSON.stringify(args));
      }
    } finally {
      delete currentConfig.codexJson;
    }
  });
});

describe("Codex exec argument recognition", () => {
  test("recognizes global flags and the exec alias without matching option values", () => {
    assert.equal(shouldUseCodexJson(spawn(["--profile", "hydra", "exec", "-"])), true);
    assert.equal(shouldUseCodexJson(spawn(["--enable", "search", "exec", "-"])), true);
    assert.equal(shouldUseCodexJson(spawn(["--profile=hydra", "e", "-"])), true);
    assert.equal(shouldUseCodexJson(spawn(["--profile", "exec", "review"])), false);
    assert.equal(shouldUseCodexJson(spawn(["--", "exec"])), false);
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

  test("preserves explicit JSON flags without injecting duplicates", () => {
    for (const flag of ["--json", "--experimental-json"]) {
      const input = spawn(["exec", flag, "-"]);
      assert.strictEqual(withCodexJsonArgs(input), input);
    }
  });

  test("inserts JSON before -- even when the prompt is a JSON flag or stdin dash", () => {
    for (const prompt of ["--json", "--experimental-json", "-"]) {
      const input = spawn(["exec", "--", prompt]);
      const output = withCodexJsonArgs(input);
      assert.deepEqual(output.args, ["exec", "--json", "--", prompt]);
      assert.strictEqual(withCodexJsonArgs(output), output);
      assert.deepEqual(input.args, ["exec", "--", prompt]);
    }
  });

  test("ignores a JSON-looking output path when inserting JSON", () => {
    const input = spawn(["exec", "--output-last-message", "--json", "-"]);
    const output = withCodexJsonArgs(input);
    assert.deepEqual(output.args, ["exec", "--output-last-message", "--json", "--json", "-"]);
    assert.strictEqual(withCodexJsonArgs(output), output);
  });
});

describe("withCodexSkipGitRepoCheckArgs", () => {
  test("inserts --skip-git-repo-check before the trailing '-' stdin sentinel", () => {
    const out = withCodexSkipGitRepoCheckArgs(
      spawn(["exec", "--sandbox", "workspace-write", "--cd", "C:\\new-workspace", "-"]),
    );
    assert.deepEqual(out.args, [
      "exec",
      "--sandbox",
      "workspace-write",
      "--cd",
      "C:\\new-workspace",
      "--skip-git-repo-check",
      "-",
    ]);
  });

  test("does not duplicate --skip-git-repo-check", () => {
    const s = spawn(["exec", "--skip-git-repo-check", "-"]);
    const out = withCodexSkipGitRepoCheckArgs(s);
    assert.strictEqual(out, s);
  });

  test("leaves non-exec Codex subcommands alone", () => {
    const s = spawn(["review", "--uncommitted", "-"]);
    const out = withCodexSkipGitRepoCheckArgs(s);
    assert.strictEqual(out, s);
  });

  test("detects exec when global Codex flags precede the subcommand", () => {
    const out = withCodexSkipGitRepoCheckArgs(
      spawn(["--profile", "hydra", "exec", "--sandbox", "read-only", "-"]),
    );
    assert.deepEqual(out.args, [
      "--profile",
      "hydra",
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-",
    ]);
  });
});
