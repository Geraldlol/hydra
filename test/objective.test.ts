import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureObjectiveFile,
  objectiveAsContext,
  parseObjective,
  readObjective,
  writeObjective,
} from "../src/objective";

describe("room objective", () => {
  test("creates and round-trips the objective file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-objective-"));
    const file = path.join(dir, ".hydra", "objective.md");

    await ensureObjectiveFile(file);
    assert.equal(await readObjective(file), "");

    await writeObjective(file, "Keep Hydra focused on shipping the VS Code room.");
    assert.equal(await readObjective(file), "Keep Hydra focused on shipping the VS Code room.");
  });

  test("parseObjective strips the generated heading", () => {
    assert.equal(
      parseObjective("# Hydra Room Objective\n\nFix the bounded context cold-start problem.\n"),
      "Fix the bounded context cold-start problem."
    );
  });

  test("objectiveAsContext emits a pinned context block", () => {
    assert.match(objectiveAsContext("Ship Hydra."), /--- Pinned room objective ---\nShip Hydra\./);
    assert.match(objectiveAsContext(""), /Not set/);
  });

  test("parseObjective strips multiple leading header copies (recovery from corrupted file)", () => {
    // Simulates a file that has somehow accumulated duplicate headers from a
    // pre-fix round-trip bug. Parser must strip ALL leading copies so the
    // next write doesn't grow the file again.
    const corrupted = "# Hydra Room Objective\n\n# Hydra Room Objective\n\nReal objective.\n";
    assert.equal(parseObjective(corrupted), "Real objective.");
  });

  test("writeObjective is idempotent across round-trips even when input already has the header", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-objective-"));
    const file = path.join(dir, ".hydra", "objective.md");

    // First write: clean input.
    await writeObjective(file, "Ship the room.");
    const firstPass = await fs.readFile(file, "utf8");

    // Round-trip: read then re-write the read value verbatim (a real caller
    // might pass through readObjective's output). Pre-fix this would have
    // accumulated a second header line.
    const read1 = await readObjective(file);
    await writeObjective(file, read1);
    const secondPass = await fs.readFile(file, "utf8");
    assert.equal(secondPass, firstPass);

    // Even passing the raw header-prefixed file content shouldn't grow it.
    await writeObjective(file, firstPass);
    const thirdPass = await fs.readFile(file, "utf8");
    assert.equal(thirdPass, firstPass);
  });
});
