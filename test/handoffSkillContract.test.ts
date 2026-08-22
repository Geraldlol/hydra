import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { HANDOFF_ACTIONS } from "../src/handoffInbox";

const skillPath = path.join(__dirname, "..", "..", "skills", "hydra-handoff", "SKILL.md");

describe("hydra-handoff skill contract", () => {
  const skill = fs.readFileSync(skillPath, "utf8");

  test("has name + description frontmatter", () => {
    // Why: the literal brief regex required a "\n" immediately before "name:",
    // which can never match when name is (correctly) the first frontmatter
    // key right after the opening "---\n" -- that newline is already
    // consumed by "^---\n" itself. Verified unsatisfiable against a real
    // two-key-first skill (~/.claude/skills/monday-ticket-inbox/SKILL.md).
    assert.match(skill, /^---\n[\s\S]*name: hydra-handoff\n[\s\S]*description: [\s\S]+?\n---/);
  });

  test("documents every handoff action string", () => {
    for (const action of HANDOFF_ACTIONS) {
      assert.match(skill, new RegExp(`"${action}"`), `skill must document action ${action}`);
    }
  });

  test("writes packets to the inbox path the extension scans", () => {
    assert.match(skill, /\.hydra\/handoff-inbox\//);
    assert.match(skill, /\.json\.tmp/); // atomic write via tmp then rename
  });

  test("documents the required packet fields", () => {
    for (const field of ["version", "title", "prompt", "suggestedAction"]) {
      assert.match(skill, new RegExp(`"${field}"`), `skill must document field ${field}`);
    }
  });
});
