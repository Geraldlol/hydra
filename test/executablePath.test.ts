import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findExecutableOnPath } from "../src/executablePath";

describe("safe executable PATH resolution", () => {
  test("skips cwd-relative PATH entries and returns an absolute executable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-executable-path-"));
    const trustedBin = path.join(root, "trusted-bin");
    await fs.mkdir(trustedBin);
    const executableName = process.platform === "win32" ? "git.exe" : "git";
    const executable = path.join(trustedBin, executableName);
    await fs.writeFile(executable, "");
    if (process.platform !== "win32") await fs.chmod(executable, 0o755);

    const env: NodeJS.ProcessEnv = process.platform === "win32"
      ? { Path: `.;${trustedBin}`, PATHEXT: ".EXE" }
      : { PATH: `.:${trustedBin}` };
    const resolved = await findExecutableOnPath("git", { env });

    assert.equal(resolved, await fs.realpath(executable));
    assert.ok(path.isAbsolute(resolved ?? ""));
  });

  test("never resolves a command from a relative-only PATH", async () => {
    const env: NodeJS.ProcessEnv = process.platform === "win32"
      ? { Path: ".", PATHEXT: ".EXE" }
      : { PATH: "." };
    assert.equal(await findExecutableOnPath("git", { env }), undefined);
  });

  test("rejects absolute PATH candidates inside the workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-executable-boundary-"));
    const workspace = path.join(root, "workspace");
    const trustedBin = path.join(root, "trusted-bin");
    await fs.mkdir(workspace);
    await fs.mkdir(trustedBin);
    const executableName = process.platform === "win32" ? "git.exe" : "git";
    const workspaceGit = path.join(workspace, executableName);
    const trustedGit = path.join(trustedBin, executableName);
    await fs.writeFile(workspaceGit, "");
    await fs.writeFile(trustedGit, "");
    if (process.platform !== "win32") {
      await fs.chmod(workspaceGit, 0o755);
      await fs.chmod(trustedGit, 0o755);
    }
    const delimiter = path.delimiter;
    const env: NodeJS.ProcessEnv = process.platform === "win32"
      ? { Path: `${workspace}${delimiter}${trustedBin}`, PATHEXT: ".EXE" }
      : { PATH: `${workspace}${delimiter}${trustedBin}` };

    const resolved = await findExecutableOnPath("git", {
      env,
      forbiddenRoots: [workspace],
      allowedWindowsExtensions: [".EXE", ".COM"],
    });

    assert.equal(resolved, await fs.realpath(trustedGit));
  });
});
