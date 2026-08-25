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

  test("pins released actions immutably and retains the supported Node runtime", () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
    const release = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "release-candidate.yml"), "utf8");
    assert.match(workflow, /actions\/checkout@[a-f0-9]{40} # v7\.0\.1/);
    assert.match(workflow, /actions\/setup-node@[a-f0-9]{40} # v7\.0\.0/);
    assert.match(workflow, /pnpm\/action-setup@[a-f0-9]{40} # v6/);
    assert.match(release, /actions\/upload-artifact@[a-f0-9]{40} # v7\.0\.1/);
    const actionRefs = [...`${workflow}\n${release}`.matchAll(/uses:\s+[^\s]+@([^\s#]+)/g)]
      .map((match) => match[1]);
    assert.ok(actionRefs.length > 0);
    assert.equal(actionRefs.every((ref) => /^[a-f0-9]{40}$/.test(ref ?? "")), true);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /node-version: 22\.22\.1/);
  });

  test("publishes one stable required gate that fails closed over every CI job", () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
    const requiredStart = workflow.indexOf("  required-ci:");

    assert.match(workflow, /^  merge_group:\s*\n\s+types: \[checks_requested\]/m);
    assert.ok(requiredStart >= 0);
    const required = workflow.slice(requiredStart);
    assert.match(required, /^\s+name: Required CI$/m);
    assert.match(required, /^\s+permissions: \{\}$/m);
    assert.match(required, /^\s+if: \$\{\{ always\(\) \}\}$/m);
    assert.match(required, /^\s+needs: \[build, extension-host\]$/m);
    assert.match(required, /BUILD_RESULT: \$\{\{ needs\.build\.result \}\}/);
    assert.match(required, /EXTENSION_HOST_RESULT: \$\{\{ needs\['extension-host'\]\.result \}\}/);
    assert.match(required, /for result in .*BUILD_RESULT.*EXTENSION_HOST_RESULT/s);
    assert.match(required, /if \[ "\$result" != "success" \]/);
  });
});
