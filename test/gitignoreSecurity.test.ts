import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..");

describe("repository secret-state ignore contract", () => {
  test("ignores modern and legacy Salesforce CLI state directories", () => {
    const gitignore = fs.readFileSync(path.join(REPOSITORY_ROOT, ".gitignore"), "utf8");
    assert.match(gitignore, /^\.sf\/$/m);
    assert.match(gitignore, /^\.sfdx\/$/m);
  });
});
