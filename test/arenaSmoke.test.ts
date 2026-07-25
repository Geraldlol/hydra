import assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import * as vscode from "vscode";
import {
  formatArenaSmokeReport,
  runArenaSmokeTest,
} from "../src/arenaSmoke";

const workspace = vscode.workspace as typeof vscode.workspace & {
  isTrusted?: boolean;
};
let originalTrust: PropertyDescriptor | undefined;
let nativeGitAvailable = false;

before(async () => {
  originalTrust = Object.getOwnPropertyDescriptor(workspace, "isTrusted");
  Object.defineProperty(workspace, "isTrusted", {
    configurable: true,
    writable: true,
    value: true,
  });
  nativeGitAvailable = await new Promise<boolean>((resolve) => {
    const child = cp.spawn("git", ["--version"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
});

after(() => {
  if (originalTrust) {
    Object.defineProperty(workspace, "isTrusted", originalTrust);
  } else {
    delete (workspace as unknown as { isTrusted?: boolean }).isTrusted;
  }
});

test("runs the isolated two-head Arena worktree lifecycle", async (t: TestContext) => {
  if (!nativeGitAvailable) {
    t.skip("native Git is unavailable");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-smoke-test-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const privateRoot = path.join(root, "private");
  const leaseRoot = path.join(root, "global-leases");
  const report = await runArenaSmokeTest({
    privateWorkspaceRoot: privateRoot,
    repositoryLeaseRoot: leaseRoot,
    gitResolutionRoot: process.cwd(),
  });

  assert.equal(report.passed, true);
  assert.equal(report.observed.contestants, 2);
  assert.equal(report.observed.cleanupState, "cleanupComplete");
  assert.equal(report.observed.manifestEvents, 23);
  assert.ok(report.checks.every((check) => check.passed));
  assert.match(
    formatArenaSmokeReport(report),
    /^Arena worktree smoke test passed\. Checks 8\/8;/,
  );
  const smokeParent = path.join(
    privateRoot,
    "arena",
    "support",
    "smoke",
  );
  assert.deepEqual(await fs.readdir(smokeParent), []);
  assert.deepEqual(
    await fs.readdir(path.join(
      privateRoot,
      "arena",
      "support",
      "smoke-recovery",
    )),
    [],
  );
  assert.equal(
    (await fs.readdir(privateRoot)).some((name) => name.startsWith("s-")),
    false,
  );
  assert.deepEqual(await fs.readdir(leaseRoot), []);
});

test("a pre-aborted lifecycle smoke allocates no private or lease state", async (t: TestContext) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-smoke-abort-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const privateRoot = path.join(root, "private");
  const leaseRoot = path.join(root, "global-leases");
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    runArenaSmokeTest({
      privateWorkspaceRoot: privateRoot,
      repositoryLeaseRoot: leaseRoot,
      gitResolutionRoot: process.cwd(),
      signal: ctrl.signal,
    }),
    /cancelled before setup/,
  );
  await assert.rejects(fs.lstat(privateRoot), { code: "ENOENT" });
  await assert.rejects(fs.lstat(leaseRoot), { code: "ENOENT" });
});

test("confirmed cancellation cleans staged lifecycle roots", async (t: TestContext) => {
  if (!nativeGitAvailable) {
    t.skip("native Git is unavailable");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-smoke-stop-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const privateRoot = path.join(root, "private");
  const leaseRoot = path.join(root, "global-leases");
  const ctrl = new AbortController();
  let catalogPublishedBeforeCancellation = false;
  const running = runArenaSmokeTest({
    privateWorkspaceRoot: privateRoot,
    repositoryLeaseRoot: leaseRoot,
    gitResolutionRoot: process.cwd(),
    signal: ctrl.signal,
    onProgress: async (stage) => {
      if (stage !== "setup") return;
      const records = await fs.readdir(path.join(
        privateRoot,
        "arena",
        "support",
        "smoke-recovery",
      ));
      catalogPublishedBeforeCancellation =
        records.length === 1 && records[0]!.endsWith(".v1.json");
      ctrl.abort();
    },
  });
  await assert.rejects(running);
  assert.equal(catalogPublishedBeforeCancellation, true);
  assert.deepEqual(
    await fs.readdir(path.join(privateRoot, "arena", "support", "smoke")),
    [],
  );
  assert.deepEqual(
    await fs.readdir(path.join(
      privateRoot,
      "arena",
      "support",
      "smoke-recovery",
    )),
    [],
  );
  assert.deepEqual(await fs.readdir(leaseRoot), []);
});
