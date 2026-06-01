import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { classifyAgentAuthority, validateNativeArgs } from "../src/authority";

describe("authority classifier", () => {
  test("classifies Codex sandbox flags including equals form and repeated last-wins values", () => {
    assert.equal(classifyAgentAuthority("codex", "opener", ["exec", "--sandbox", "read-only"]).level, "readOnly");
    assert.equal(classifyAgentAuthority("codex", "build", ["exec", "--sandbox=workspace-write"]).level, "workspaceWrite");
    assert.equal(
      classifyAgentAuthority("codex", "build", ["exec", "--sandbox", "read-only", "--sandbox", "danger-full-access"]).level,
      "fullNative"
    );
  });

  test("treats Codex native review as read-only unless dangerous flags are present", () => {
    assert.equal(classifyAgentAuthority("codex", "review", ["review", "--uncommitted", "-"]).level, "readOnly");
    assert.equal(
      classifyAgentAuthority("codex", "review", ["review", "--dangerously-bypass-approvals-and-sandbox"]).level,
      "fullNative"
    );
  });

  test("classifies Claude permission modes", () => {
    assert.equal(classifyAgentAuthority("claude", "opener", ["-p", "--permission-mode", "plan"]).level, "readOnly");
    assert.equal(classifyAgentAuthority("claude", "opener", ["-p", "--permission-mode", "default"]).level, "readOnly");
    assert.equal(classifyAgentAuthority("claude", "opener", ["-p", "--permission-mode", "dontAsk"]).level, "readOnly");
    assert.equal(classifyAgentAuthority("claude", "build", ["-p", "--permission-mode=acceptEdits"]).level, "workspaceWrite");
    assert.equal(classifyAgentAuthority("claude", "build", ["-p", "--permission-mode=auto"]).level, "workspaceWrite");
    assert.equal(classifyAgentAuthority("claude", "build", ["-p", "--permission-mode", "bypassPermissions"]).level, "fullNative");
  });

  test("returns unknown for unrecognized authority", () => {
    const result = classifyAgentAuthority("claude", "review", ["-p"]);
    assert.equal(result.level, "unknown");
    assert.match(result.detail, /do not declare/);
  });
});

describe("validateNativeArgs", () => {
  test("flags --ask-for-approval on codex exec (TUI-only flag)", () => {
    const warnings = validateNativeArgs("codex", [
      "exec",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /interactive root command|not on `codex exec`|not valid on `codex exec`/);
    assert.match(warnings[0]!, /--dangerously-bypass-approvals-and-sandbox/);
  });

  test("does not flag --ask-for-approval on codex (TUI root)", () => {
    // No `exec` positional -> interactive root; flag is valid there.
    assert.deepEqual(
      validateNativeArgs("codex", ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"]),
      []
    );
  });

  test("flags removed --full-auto on codex regardless of subcommand", () => {
    const warnings = validateNativeArgs("codex", ["exec", "--full-auto"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /--full-auto.*removed|removed.*--full-auto/i);
  });

  test("flags mutually exclusive codex review modes", () => {
    const warnings = validateNativeArgs("codex", [
      "review",
      "--uncommitted",
      "--base",
      "main",
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /mutually exclusive/);
    assert.match(warnings[0]!, /--uncommitted/);
    assert.match(warnings[0]!, /--base/);
  });

  test("does not flag codex review with a single mode", () => {
    assert.deepEqual(
      validateNativeArgs("codex", ["review", "--uncommitted"]),
      []
    );
    assert.deepEqual(
      validateNativeArgs("codex", ["review", "--base", "main"]),
      []
    );
    assert.deepEqual(
      validateNativeArgs("codex", ["review", "--commit", "abc1234"]),
      []
    );
  });

  test("does not flag review-style flags when used outside codex review", () => {
    // --base on `codex exec` is a different namespace; clap won't have this
    // collision because exec doesn't expose those flags. Our check is
    // scoped to the `review` subcommand.
    assert.deepEqual(
      validateNativeArgs("codex", ["exec", "--sandbox", "workspace-write"]),
      []
    );
  });

  test("flags claude --print --output-format=stream-json without --verbose", () => {
    const warnings = validateNativeArgs("claude", [
      "-p",
      "--output-format",
      "stream-json",
      "--add-dir",
      ".",
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /--verbose/);
  });

  test("does not flag claude stream-json when --verbose is present", () => {
    assert.deepEqual(
      validateNativeArgs("claude", ["-p", "--output-format", "stream-json", "--verbose"]),
      []
    );
  });

  test("flags claude --input-format=stream-json without matching output format", () => {
    const warnings = validateNativeArgs("claude", ["-p", "--input-format", "stream-json"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /--input-format=stream-json/);
  });

  test("flags claude --include-partial-messages without stream-json output", () => {
    const warnings = validateNativeArgs("claude", ["-p", "--include-partial-messages"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /--include-partial-messages/);
  });

  test("flags claude --include-hook-events without stream-json output", () => {
    const warnings = validateNativeArgs("claude", ["-p", "--include-hook-events"]);
    assert.ok(warnings.some((w) => /--include-hook-events/.test(w)));
  });

  test("flags claude print-only flags used without --print", () => {
    const warnings = validateNativeArgs("claude", [
      "--max-budget-usd",
      "5",
      "--fallback-model",
      "haiku",
      "--no-session-persistence",
    ]);
    assert.equal(warnings.length, 3);
    assert.ok(warnings.some((w) => /--max-budget-usd/.test(w) && /--print/.test(w)));
    assert.ok(warnings.some((w) => /--fallback-model/.test(w) && /--print/.test(w)));
    assert.ok(warnings.some((w) => /--no-session-persistence/.test(w) && /--print/.test(w)));
  });

  test("does not flag claude print-only flags when --print is present", () => {
    assert.deepEqual(
      validateNativeArgs("claude", ["-p", "--max-budget-usd", "5"]),
      []
    );
  });

  test("flags claude --replay-user-messages without dual stream-json", () => {
    // Only output stream-json is set; input still text -> warn
    const warnings = validateNativeArgs("claude", [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--replay-user-messages",
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /--replay-user-messages/);
    assert.match(warnings[0]!, /--input-format=stream-json/);
  });

  test("does not flag claude --replay-user-messages when both formats are stream-json", () => {
    assert.deepEqual(
      validateNativeArgs("claude", [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--replay-user-messages",
      ]),
      []
    );
  });

  test("flags claude --session-id with malformed UUID", () => {
    const warnings = validateNativeArgs("claude", ["-p", "--session-id", "not-a-uuid"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /must be a valid UUID/);
    assert.match(warnings[0]!, /not-a-uuid/);
  });

  test("does not flag claude --session-id with a valid UUID", () => {
    assert.deepEqual(
      validateNativeArgs("claude", ["-p", "--session-id", "12345678-1234-1234-1234-123456789abc"]),
      []
    );
  });

  test("flags codex --sandbox with an unknown enum value", () => {
    const warnings = validateNativeArgs("codex", ["exec", "--sandbox", "danger-write"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /--sandbox.*one of/);
    assert.match(warnings[0]!, /danger-write/);
  });

  test("does not flag codex --sandbox with the three valid modes", () => {
    for (const mode of ["read-only", "workspace-write", "danger-full-access"]) {
      assert.deepEqual(
        validateNativeArgs("codex", ["exec", "--sandbox", mode]),
        [],
        `expected ${mode} to validate cleanly`
      );
    }
  });

  test("flags codex --remote with non-websocket URL", () => {
    const warnings = validateNativeArgs("codex", ["--remote", "https://example.com"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /ws:\/\/ or wss:\/\//);
    assert.match(warnings[0]!, /https:\/\/example\.com/);
  });

  test("does not flag codex --remote with ws:// or wss:// schemes", () => {
    assert.deepEqual(validateNativeArgs("codex", ["--remote", "ws://localhost:7890"]), []);
    assert.deepEqual(validateNativeArgs("codex", ["--remote", "wss://example.com:443/sock"]), []);
  });

  test("flags codex --local-provider with an unknown value", () => {
    const warnings = validateNativeArgs("codex", ["--oss", "--local-provider", "ggml"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /lmstudio or ollama/);
    assert.match(warnings[0]!, /ggml/);
  });

  test("does not flag codex --local-provider with lmstudio or ollama", () => {
    assert.deepEqual(validateNativeArgs("codex", ["--oss", "--local-provider", "lmstudio"]), []);
    assert.deepEqual(validateNativeArgs("codex", ["--oss", "--local-provider", "ollama"]), []);
  });

  test("flags claude --permission-mode with an unknown enum value", () => {
    const warnings = validateNativeArgs("claude", ["-p", "--permission-mode", "yolo"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /--permission-mode.*one of/);
    assert.match(warnings[0]!, /yolo/);
  });

  test("flags claude --output-format and --input-format typos", () => {
    const warnings1 = validateNativeArgs("claude", ["-p", "--output-format", "streamjson"]);
    assert.ok(warnings1.some((w) => /--output-format/.test(w) && /streamjson/.test(w)));
    const warnings2 = validateNativeArgs("claude", ["-p", "--input-format", "stream", "--output-format", "stream-json", "--verbose"]);
    assert.ok(warnings2.some((w) => /--input-format/.test(w) && /"stream"/.test(w)));
  });

  test("flags claude --effort with an unknown level", () => {
    const warnings = validateNativeArgs("claude", ["-p", "--effort", "ultra"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /--effort.*one of/);
    assert.match(warnings[0]!, /ultra/);
  });

  test("does not flag claude --effort with valid levels", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      assert.deepEqual(
        validateNativeArgs("claude", ["-p", "--effort", level]),
        [],
        `expected ${level} to validate cleanly`
      );
    }
  });

  test("classifyAgentAuthority surfaces validation warnings alongside authority warnings", () => {
    const result = classifyAgentAuthority("codex", "build", [
      "exec",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
    ]);
    assert.equal(result.level, "workspaceWrite");
    assert.ok(result.warnings.some((w) => /interactive root command/.test(w)));
  });
});
