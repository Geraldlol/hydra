import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("model chooser source contract", () => {
  test("Claude presets include current Opus model", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "modelChooser.ts"), "utf8");
    assert.match(source, /label:\s*"claude-opus-4-8"/);
  });
});
