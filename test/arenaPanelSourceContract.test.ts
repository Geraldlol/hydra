import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Arena host integration source contracts", () => {
  test("registers a trusted-workspace isolated smoke command", () => {
    const pkg = JSON.parse(read("package.json")) as {
      contributes?: {
        commands?: Array<{
          command?: string;
          title?: string;
          enablement?: string;
        }>;
      };
    };
    const command = pkg.contributes?.commands?.find((candidate) =>
      candidate.command === "hydraRoom.runArenaSmokeTest");
    assert.deepEqual(command, {
      command: "hydraRoom.runArenaSmokeTest",
      title: "Hydra: Advanced: Run Arena Worktree Smoke Test",
      enablement: "isWorkspaceTrusted",
    });
    const extension = read("src/extension.ts");
    assert.match(extension, /"hydraRoom\.runArenaSmokeTest"/);
    assert.match(extension, /vscode\.workspace\.isTrusted !== true/);
    assert.match(extension, /await panel\.runArenaSmokeTest\(\)/);
  });

  test("keeps the smoke synthetic, private, and globally repository-leased", () => {
    const panel = read("src/panel.ts");
    const start = panel.indexOf("async runArenaSmokeTest()");
    const end = panel.indexOf("async runManyHeadsSmokeTest()", start);
    assert.ok(start >= 0 && end > start);
    const method = panel.slice(start, end);
    assert.match(method, /this\.arenaSmokeRunning = true/);
    assert.match(method, /const ctrl = new AbortController\(\)/);
    assert.match(method, /this\.arenaSmokeAbort = ctrl/);
    assert.match(method, /signal: ctrl\.signal/);
    assert.match(method, /hasArenaTerminationUnconfirmed\(error\)/);
    assert.match(method, /this\.latchUnconfirmedNativeTermination/);
    assert.match(method, /privateWorkspaceRoot: this\.arenaSmokePrivateStorageRoot\(\)/);
    assert.match(
      method,
      /this\.context\.globalStorageUri\.fsPath,\s*"arena-repository-leases"/,
    );
    assert.doesNotMatch(method, /privateWorkspaceRoot: this\.workspaceRoot/);
    assert.match(method, /this\.arenaSmokeAbort = undefined/);
    assert.match(method, /this\.arenaSmokeRunning = false/);
    assert.match(
      panel,
      /private arenaSmokePrivateStorageRoot\(\): string[\s\S]{0,350}this\.context\.globalStorageUri\.fsPath[\s\S]{0,350}\.slice\(0, 24\)/,
    );
  });

  test("routes Arena lifecycle smoke through common automation stop gates", () => {
    const panel = read("src/panel.ts");
    assert.match(panel, /private arenaSmokeAbort: AbortController \| undefined/);
    assert.match(panel, /this\.arenaSmokeAbort\?\.abort\(\)/);
    assert.match(
      panel,
      /const canStop =[\s\S]{0,500}this\.arenaSmokeRunning/,
    );
    assert.match(
      panel,
      /async archiveAndClearRoom\(\)[\s\S]{0,500}this\.arenaSmokeRunning/,
    );
    assert.match(
      panel,
      /private async runVerificationInternal\([\s\S]{0,900}this\.arenaSmokeRunning/,
    );
  });
});
