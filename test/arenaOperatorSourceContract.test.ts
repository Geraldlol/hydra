import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, test } from "node:test";

describe("Arena operator surfaces", () => {
  test("registers result and recovery commands and starts a read-only recovery scan", async () => {
    const extension = await fs.readFile(
      path.resolve(process.cwd(), "src", "extension.ts"),
      "utf8",
    );
    const manifest = JSON.parse(await fs.readFile(
      path.resolve(process.cwd(), "package.json"),
      "utf8",
    )) as { contributes?: { commands?: readonly { command: string }[] } };
    const commands = new Set(
      manifest.contributes?.commands?.map((command) => command.command) ?? [],
    );
    assert.ok(commands.has("hydraRoom.manageArenaResults"));
    assert.ok(commands.has("hydraRoom.recoverArenaRuns"));
    assert.match(extension, /scanArenaRecoveryOnStartup\(context\)/u);
    assert.match(extension, /manageArenaResults\(context\)/u);
    assert.match(extension, /manageArenaRecovery\(context\)/u);
  });

  test("keeps promotion behind a separate exact modal confirmation", async () => {
    const operator = await fs.readFile(
      path.resolve(process.cwd(), "src", "arenaOperator.ts"),
      "utf8",
    );
    assert.match(operator, /showWarningMessage\([\s\S]*\{ modal: true \}[\s\S]*"Promote Arena Winner"/u);
    assert.match(operator, /confirmed !== "Promote Arena Winner"/u);
    assert.match(operator, /createArenaPromotionConfirmation/u);
    assert.match(operator, /No process was started automatically/u);
    assert.doesNotMatch(operator, /git\s+(?:commit|push)|\bdeploy\(/u);
  });

  test("takes over recovery authority only after exact revalidation and confirmation", async () => {
    const operator = await fs.readFile(
      path.resolve(process.cwd(), "src", "arenaOperator.ts"),
      "utf8",
    );
    assert.match(operator, /scanArenaRecovery\([\s\S]*recoveryStateSha256/u);
    assert.match(operator, /executor\.inspectAdmission\(\)/u);
    assert.match(operator, /\{ modal: true \}[\s\S]*"Take Over Arena Lease"/u);
    assert.match(operator, /executor\.recoverRepositoryRun\(/u);
    assert.match(operator, /lease takeover only[\s\S]*No process was started automatically/iu);
    assert.match(operator, /workspaceFolders\.length !== 1/u);
  });
});
