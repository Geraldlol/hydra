import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("CI workflow contracts", () => {
  test("runs unit and extension-host coverage on Linux and Windows", () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
    assert.match(workflow, /os:\s*\[ubuntu-latest, windows-latest\]/);
    assert.match(workflow, /extension-host:/);
    assert.match(workflow, /xvfb-run -a pnpm run test:integration/);
    assert.match(workflow, /if: runner\.os == 'Windows'[\s\S]*pnpm run test:integration/);
  });

  test("uses current released action majors and pins the supported Node runtime", () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
    assert.match(workflow, /actions\/checkout@v7/);
    assert.match(workflow, /actions\/setup-node@v7/);
    assert.match(workflow, /node-version: 22\.22\.1/);
  });
});
