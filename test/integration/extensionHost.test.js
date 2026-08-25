const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "geraldlol.vscode-hydra-room";

suite("Hydra extension host", () => {
  let hydraDir;

  suiteSetup(async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, "extension-host test workspace was not opened");
    hydraDir = path.join(workspaceRoot, ".hydra");
    await vscode.workspace
      .getConfiguration("hydraRoom")
      .update("autopilotOnStart", false, vscode.ConfigurationTarget.Global);
    await removeHydraDir(hydraDir);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    if (hydraDir) await removeHydraDir(hydraDir);
  });

  test("activates and registers the public command surface", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} was not loaded as the development extension`);
    await extension.activate();
    assert.equal(extension.isActive, true);

    const commands = new Set(await vscode.commands.getCommands(true));
    for (const command of [
      "hydraRoom.start",
      "hydraRoom.open",
      "hydraRoom.openBrowser",
      "hydraRoom.toggleBrowserControl",
      "hydraRoom.runDoctor",
      "hydraRoom.stop",
      "hydraRoom.openDuels",
      "hydraRoom.advanceDuel",
      "hydraRoom.cancelDuel",
      "hydraRoom.openDuelAudit",
      "hydraRoom.correctDuelResult",
      "hydraRoom.runMissionFlightSmokeTest",
      "hydraRoom.runArenaSmokeTest",
    ]) {
      assert.ok(commands.has(command), `${command} was not registered`);
    }
    assert.equal(commands.has("hydraRoom.createDuel"), false, "human-created duels must not be registered");
  });

  test("opens a room and initializes durable workspace state", async () => {
    await vscode.commands.executeCommand("hydraRoom.start");
    const transcript = path.join(hydraDir, "transcript.md");
    await waitForFile(transcript);
    assert.match(await fs.readFile(transcript, "utf8"), /^# Hydra Room Transcript/m);
  });

  test("runs the isolated Mission and Flight smoke command in the extension host", async () => {
    const transcript = path.join(hydraDir, "transcript.md");
    await vscode.commands.executeCommand("hydraRoom.runMissionFlightSmokeTest");
    await waitForText(transcript, /Mission\/Flight smoke test passed\./);
  });

  test("runs the isolated Arena worktree smoke command in the extension host", async function () {
    this.timeout(210_000);
    const transcript = path.join(hydraDir, "transcript.md");
    let commandSettled = false;
    const command = vscode.commands.executeCommand(
      "hydraRoom.runArenaSmokeTest",
    ).finally(() => {
      commandSettled = true;
    });
    try {
      await withTimeout(
        command,
        150_000,
        "Arena worktree smoke command exceeded its extension-host budget",
      );
      await waitForText(
        transcript,
        /Arena worktree smoke test passed\./,
        10_000,
      );
    } finally {
      if (!commandSettled) {
        await vscode.commands.executeCommand("hydraRoom.stop");
        await withTimeout(
          command.catch(() => undefined),
          40_000,
          "Arena worktree smoke did not settle after cancellation",
        );
      }
    }
  });
});

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.fail(`timed out waiting for ${filePath}`);
}

async function removeHydraDir(directory) {
  await fs.rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

async function waitForText(filePath, pattern, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastContent = "";
  while (Date.now() < deadline) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      lastContent = content;
      if (pattern.test(content)) return;
    } catch {
      // The room may still be replacing its transcript atomically.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(
    `timed out waiting for ${pattern} in ${filePath}; last transcript tail: ${
      lastContent.slice(-2_000)
    }`,
  );
}
