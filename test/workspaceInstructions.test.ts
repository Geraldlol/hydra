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

  test("truncates long instruction context", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-instructions-"));
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "x".repeat(200), "utf8");

    const out = await readWorkspaceInstructions(dir, 80);
    assert.ok(out.length <= 100);
    assert.match(out, /\[\.\.\. truncated by Hydra \.\.\.\]/);
  });

  test("renders an explicit workspace instructions section", () => {
    const out = workspaceInstructionsAsContext("--- CLAUDE.md ---\nRun dotnet with local PATH.");
    assert.match(out, /--- Workspace instructions ---/);
    assert.match(out, /override generic assumptions/);
    assert.match(out, /Run dotnet with local PATH/);
  });

  test("renders none when no instruction files exist", () => {
    assert.equal(workspaceInstructionsAsContext(""), "--- Workspace instructions ---\nNone found.");
  });
});
