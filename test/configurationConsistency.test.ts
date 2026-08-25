import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";

interface ConfigurationProperty {
  default?: unknown;
  enum?: readonly unknown[];
  markdownDescription?: string;
  pattern?: string;
  scope?: string;
  type?: string;
}

function configurationProperties(): Record<string, ConfigurationProperty> {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  ) as {
    contributes?: {
      configuration?: {
        properties?: Record<string, ConfigurationProperty>;
      };
    };
  };
  return manifest.contributes?.configuration?.properties ?? {};
}

describe("public configuration consistency", () => {
  test("describes Codex JSON accounting using its enabled-by-default contract", () => {
    const properties = configurationProperties();
    const codexJson = properties["hydraRoom.codexJson"];
    const costCap = properties["hydraRoom.sessionCostCapUsd"];

    assert.equal(codexJson?.default, true);
    assert.doesNotMatch(costCap?.markdownDescription ?? "", /default[^.]*codexJson:\s*false/i);
    assert.match(costCap?.markdownDescription ?? "", /disable [`']?hydraRoom\.codexJson/i);
  });

  test("allows any registered seated head to be the configured first speaker", () => {
    const firstSpeaker = configurationProperties()["hydraRoom.firstSpeaker"];

    assert.equal(firstSpeaker?.scope, "application");
    assert.equal(firstSpeaker?.type, "string");
    assert.equal(firstSpeaker?.pattern, "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$");
    assert.equal(firstSpeaker?.enum, undefined);
    assert.match(firstSpeaker?.markdownDescription ?? "", /registered.*seated head/i);
    assert.match(firstSpeaker?.markdownDescription ?? "", /first roster entry/i);
  });

  test("describes parallel discussion in terms of the seated roster", () => {
    const discussionMode = configurationProperties()["hydraRoom.discussionMode"];
    const description = discussionMode?.markdownDescription ?? "";

    assert.match(description, /every seated head|entire seated roster/i);
    assert.doesNotMatch(description, /always dispatches Codex and Claude/i);
    assert.doesNotMatch(description, /after both replies/i);
  });

  test("keeps general room guidance neutral to the configured roster", () => {
    const extension = fs.readFileSync(path.join(process.cwd(), "src", "extension.ts"), "utf8");
    const panel = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");

    assert.match(extension, /parallel replies from every seated head when the instruction addresses the group/i);
    assert.doesNotMatch(extension, /parallel Codex \+ Claude replies when the instruction addresses both/i);
    assert.match(panel, /press Send when you want the seated heads to answer/i);
    assert.match(panel, /one-shot dispatch for seated heads/i);
    assert.match(panel, /when you want the seated heads to work/i);
    assert.doesNotMatch(panel, /press Send when you want Codex and Claude to answer/i);
  });

  test("keeps coverage thresholds on executable core and isolates fixture grandchildren", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const coverage = manifest.scripts?.["test:coverage"] ?? "";
    const preload = fs.readFileSync(
      path.join(process.cwd(), "scripts", "coverage-child-isolation.js"),
      "utf8",
    );

    assert.match(coverage, /--require=\.\/scripts\/coverage-child-isolation\.js/);
    assert.match(coverage, /--test-coverage-lines=80/);
    assert.match(coverage, /--test-coverage-branches=70/);
    assert.match(coverage, /--test-coverage-functions=80/);
    for (const hostShell of ["panel", "extension"]) {
      assert.match(coverage, new RegExp(`--test-coverage-exclude=dist/src/${hostShell}\\.js`));
    }
    assert.match(preload, /process\.env\.NODE_TEST_CONTEXT !== undefined/);
    assert.match(preload, /delete process\.env\.NODE_V8_COVERAGE/);
  });
});
