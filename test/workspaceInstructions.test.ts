import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readWorkspaceInstructions, workspaceInstructionsAsContext } from "../src/workspaceInstructions";

describe("workspace instructions", () => {
  test("reads known repository instruction files into prompt context", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-instructions-"));
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "Use local dotnet from $env:USERPROFILE\\.dotnet.", "utf8");
    await fs.writeFile(path.join(dir, "AGENTS.md"), "Prefer rg before slower search.", "utf8");

    const out = await readWorkspaceInstructions(dir);
    assert.match(out, /--- CLAUDE\.md ---/);
    assert.match(out, /Use local dotnet/);
    assert.match(out, /--- AGENTS\.md ---/);
    assert.match(out, /Prefer rg/);
  });

  test("filters the recipient agent's native instruction files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-instructions-"));
    await fs.mkdir(path.join(dir, ".codex"), { recursive: true });
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "Claude-native guidance.", "utf8");
    await fs.writeFile(path.join(dir, "AGENTS.md"), "Codex-native guidance.", "utf8");
    await fs.writeFile(path.join(dir, ".codex", "instructions.md"), "Codex-local guidance.", "utf8");

    const codex = await readWorkspaceInstructions(dir, 12000, undefined, { agent: "codex" });
    assert.match(codex, /Claude-native guidance/);
    assert.doesNotMatch(codex, /Codex-native guidance/);
    assert.doesNotMatch(codex, /Codex-local guidance/);

    const claude = await readWorkspaceInstructions(dir, 12000, undefined, { agent: "claude" });
    assert.doesNotMatch(claude, /Claude-native guidance/);
    assert.match(claude, /Codex-native guidance/);
    assert.match(claude, /Codex-local guidance/);
  });

  test("truncates long instruction context", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-instructions-"));
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "x".repeat(200), "utf8");

    const out = await readWorkspaceInstructions(dir, 80);
    assert.ok(out.length <= 100);
    assert.match(out, /\[\.\.\. truncated by Hydra \.\.\.\]/);
  });

  test("supports unbounded instruction loading for prompt-time caps", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-instructions-"));
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "x".repeat(200), "utf8");

    const out = await readWorkspaceInstructions(dir, 0);
    assert.match(out, /x{200}/);
    assert.doesNotMatch(out, /\[\.\.\. truncated by Hydra \.\.\.\]/);
  });

  test("renders an explicit workspace instructions section", () => {
    const out = workspaceInstructionsAsContext("--- CLAUDE.md ---\nRun dotnet with local PATH.");
    assert.match(out, /--- Workspace instructions ---/);
    assert.match(out, /override generic assumptions/);
    assert.match(out, /Run dotnet with local PATH/);
  });

  test("caps rendered instruction context for compact prompt modes", () => {
    const out = workspaceInstructionsAsContext(`--- CLAUDE.md ---\n${"x".repeat(200)}`, { maxChars: 80 });
    assert.match(out, /--- Workspace instructions ---/);
    assert.match(out, /\[\.\.\. truncated by Hydra \.\.\.\]/);
    assert.ok(out.length < 260);
  });

  test("renders none when no instruction files exist", () => {
    assert.equal(workspaceInstructionsAsContext(""), "--- Workspace instructions ---\nNone found.");
  });
});
