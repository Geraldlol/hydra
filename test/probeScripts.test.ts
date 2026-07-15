import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const PROBE_SCRIPTS = [
  "native-contract-probe.js",
  "codex-json-probe.js",
  "claude-stream-json-probe.js",
] as const;

describe("native probe workspace boundary", () => {
  for (const scriptName of PROBE_SCRIPTS) {
    test(`${scriptName} anchors cwd and artifacts to the repository root`, () => {
      const repoRoot = path.resolve(__dirname, "..", "..");
      const source = fs.readFileSync(path.join(repoRoot, "scripts", scriptName), "utf8");

      assert.match(source, /const repoRoot = path\.resolve\(__dirname, "\.\."\);/);
      assert.doesNotMatch(
        source,
        /const repoRoot = path\.resolve\(__dirname, "\.\.", "\.\.", "\.\."\);/,
        "probe must not escape above the checkout",
      );
    });
  }
});
