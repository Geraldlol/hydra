import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

// Drift guard: the Claude preset list is hand-maintained (the Claude Code CLI
// has no "list models" command), so it silently rots as new models ship. These
// assertions fail CI when the current flagships fall out of the chooser, which
// is exactly the staleness these tests exist to catch.
describe("model chooser source contract", () => {
  const modelChooser = () =>
    fs.readFileSync(path.join(process.cwd(), "src", "modelChooser.ts"), "utf8");

  test("Claude presets include the current flagship models", () => {
    const source = modelChooser();
    assert.match(source, /label:\s*"claude-fable-5"/, "Fable 5 missing from Claude presets");
    assert.match(source, /label:\s*"claude-sonnet-5"/, "Sonnet 5 missing from Claude presets");
    assert.match(source, /label:\s*"claude-opus-4-8"/, "Opus 4.8 missing from Claude presets");
  });

  test("Claude presets expose the never-stale family aliases", () => {
    const source = modelChooser();
    for (const alias of ["fable", "sonnet", "opus", "haiku"]) {
      assert.match(source, new RegExp(`label:\\s*"${alias}"`), `alias "${alias}" missing`);
    }
  });

  test("Codex fallback presets seed the current flagship", () => {
    const source = modelChooser();
    assert.match(source, /label:\s*"gpt-5\.6"/, "gpt-5.6 missing from Codex fallback presets");
  });
});
