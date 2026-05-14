import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NATIVE_COMMAND_CATALOG } from "../src/nativeCommandCatalog";

describe("native command catalog", () => {
  test("exposes captured and interactive Codex parity presets", () => {
    const codex = NATIVE_COMMAND_CATALOG.filter((item) => item.agent === "codex");
    assert.ok(codex.some((item) => item.line === "mcp --help" && item.mode === "command"));
    assert.ok(codex.some((item) => item.line === "mcp list --json" && item.mode === "command"));
    assert.ok(codex.some((item) => item.line === "plugin --help" && item.mode === "command"));
    assert.ok(codex.some((item) => item.line === "exec --help" && item.mode === "command"));
    assert.ok(codex.some((item) => item.line === "review --help" && item.mode === "command"));
    assert.ok(codex.some((item) => item.line === "app-server --help" && item.mode === "command"));
    assert.ok(codex.some((item) => item.line === "exec-server --help" && item.mode === "command"));
    assert.ok(codex.some((item) => item.line === "login status" && item.mode === "command"));
    assert.ok(codex.some((item) => item.line === "codex logout" && item.mode === "rawLine"));
    assert.ok(codex.some((item) => item.line === "codex resume" && item.mode === "rawLine"));
    assert.ok(codex.some((item) => item.line === "codex resume --last" && item.mode === "rawLine"));
    assert.ok(codex.some((item) => item.line === "codex fork --last" && item.mode === "rawLine"));
    assert.ok(codex.some((item) => item.line === "codex cloud" && item.mode === "rawLine"));
  });

  test("exposes captured and interactive Claude parity presets", () => {
    const claude = NATIVE_COMMAND_CATALOG.filter((item) => item.agent === "claude");
    assert.ok(claude.some((item) => item.line === "doctor" && item.mode === "command"));
    assert.ok(claude.some((item) => item.line === "mcp list" && item.mode === "command"));
    assert.ok(claude.some((item) => item.line === "plugin list --json" && item.mode === "command"));
    assert.ok(claude.some((item) => item.line === "agents --help" && item.mode === "command"));
    assert.ok(claude.some((item) => item.line === "auto-mode defaults" && item.mode === "command"));
    assert.ok(claude.some((item) => item.line === "auth status" && item.mode === "command"));
    assert.ok(claude.some((item) => item.line === "claude auth login" && item.mode === "rawLine"));
    assert.ok(claude.some((item) => item.line === "claude --resume" && item.mode === "rawLine"));
    assert.ok(claude.some((item) => item.line === "claude --worktree" && item.mode === "rawLine"));
  });
});
