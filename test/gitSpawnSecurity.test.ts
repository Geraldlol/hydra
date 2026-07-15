import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  resolveGitExecutable,
  workspaceGitExecutionAllowed,
} from "../src/gitExecutable";

describe("Git spawn security contract", () => {
  test("workspace operations resolve Git before spawning with a workspace cwd", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    for (const relativePath of ["src/panel.ts", "src/verification.ts"]) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(source, /cp\.spawn\(["']git["']/);
      assert.match(source, /resolveGitExecutable\(cwd\)/);
    }
  });

  test("untrusted workspaces cannot resolve a Git executable", async () => {
    const workspace = vscode.workspace as typeof vscode.workspace & { isTrusted?: boolean };
    const original = Object.getOwnPropertyDescriptor(workspace, "isTrusted");
    Object.defineProperty(workspace, "isTrusted", {
      configurable: true,
      writable: true,
      value: false,
    });
    try {
      assert.equal(workspaceGitExecutionAllowed(), false);
      assert.equal(await resolveGitExecutable(process.cwd()), undefined);
    } finally {
      if (original) Object.defineProperty(workspace, "isTrusted", original);
      else delete (workspace as unknown as { isTrusted?: boolean }).isTrusted;
    }
  });

  test("panel initialization and every panel Git spawn fail closed on Workspace Trust", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");

    const initStart = source.indexOf("private async initialize()");
    const initEnd = source.indexOf("private createTerminalBridge()", initStart);
    assert.ok(initStart >= 0 && initEnd > initStart, "panel initialization body not found");
    const initialize = source.slice(initStart, initEnd);
    assert.match(
      initialize,
      /this\.gitAvailable = workspaceGitExecutionAllowed\(\) && await isGitWorkspace\(this\.workspaceRoot\)/,
    );

    const runStart = source.indexOf("async function runGit(");
    const runEnd = source.indexOf("const MAX_GIT_OUTPUT_CHARS", runStart);
    assert.ok(runStart >= 0 && runEnd > runStart, "runGit body not found");
    const runGit = source.slice(runStart, runEnd);
    const runTrust = runGit.indexOf("workspaceGitExecutionAllowed()");
    const runResolve = runGit.indexOf("resolveGitExecutable(cwd)");
    const runSpawn = runGit.indexOf("cp.spawn(");
    assert.ok(runTrust >= 0 && runTrust < runResolve && runResolve < runSpawn);

    const probeStart = source.indexOf("async function isGitWorkspace(");
    assert.ok(probeStart >= 0, "isGitWorkspace body not found");
    const probe = source.slice(probeStart);
    const probeTrust = probe.indexOf("workspaceGitExecutionAllowed()");
    const probeResolve = probe.indexOf("resolveGitExecutable(cwd)");
    const probeSpawn = probe.indexOf("cp.spawn(");
    assert.ok(probeTrust >= 0 && probeTrust < probeResolve && probeResolve < probeSpawn);
  });

  test("the shared resolver checks trust before cached PATH results", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "gitExecutable.ts"), "utf8");
    const gate = source.indexOf("if (!workspaceGitExecutionAllowed()) return undefined");
    const cache = source.indexOf("cachedGitExecutables.get(cacheKey)");
    const pathLookup = source.indexOf("findExecutableOnPath(");
    assert.ok(gate >= 0 && gate < cache && cache < pathLookup);
  });

  test("working-tree diffs disable external diff and textconv drivers", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
    const start = source.indexOf("async function captureGitDiff(");
    const end = source.indexOf("async function captureGitStatusChanges(", start);
    assert.ok(start >= 0 && end > start, "captureGitDiff body not found");
    const capture = source.slice(start, end);
    assert.match(
      capture,
      /\["diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD"\]/,
    );
  });
});
