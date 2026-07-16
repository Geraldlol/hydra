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
    await fs.rm(hydraDir, { recursive: true, force: true });
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    if (hydraDir) await fs.rm(hydraDir, { recursive: true, force: true });
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
});

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
