import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
  recoverArenaEvidenceStageTemps,
  releaseArenaEvidenceStageName,
  reserveArenaEvidenceStageName,
} from "../src/arenaEvidenceStageRecovery";
import {
  ensureArenaPrivateDirectory,
  prepareArenaPrivateStorage,
} from "../src/arenaPrivateStorage";

async function fixture(t: TestContext): Promise<{
  readonly artifactDirectory: string;
  readonly boundary: Awaited<ReturnType<typeof prepareArenaPrivateStorage>>;
}> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "hydra-arena-evidence-recovery-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const boundary = await prepareArenaPrivateStorage(root);
  const artifactDirectory = await ensureArenaPrivateDirectory(
    boundary,
    ["artifacts", "run-one", "codex"],
  );
  return { artifactDirectory, boundary };
}

function stageName(artifactName: string, pid: number): string {
  return `.${artifactName}.${pid}-${randomUUID()}.tmp`;
}

describe("Arena evidence stage crash recovery", () => {
  test("keeps a case-renamed current-session stage active on Windows", async (t) => {
    if (process.platform !== "win32") {
      t.skip("Windows case-insensitive stage reservation semantics");
      return;
    }
    const value = await fixture(t);
    const reservation = reserveArenaEvidenceStageName("patch.bin");
    const originalPath = path.join(value.artifactDirectory, reservation.name);
    const renamedPath = path.join(
      value.artifactDirectory,
      reservation.name.toUpperCase(),
    );
    t.after(() => releaseArenaEvidenceStageName(originalPath));
    await fs.writeFile(originalPath, "live", { mode: 0o600 });
    await fs.rename(originalPath, renamedPath);

    await assert.rejects(
      recoverArenaEvidenceStageTemps(
        value.artifactDirectory,
        ["patch.bin"],
        value.boundary,
      ),
      /publisher may still be alive/,
    );
    assert.equal(await fs.readFile(renamedPath, "utf8"), "live");
  });

  test("normalizes Windows reservation keys when releasing by path", async (t) => {
    if (process.platform !== "win32") {
      t.skip("Windows case-insensitive stage reservation semantics");
      return;
    }
    const value = await fixture(t);
    const reservation = reserveArenaEvidenceStageName("patch.bin");
    const stagePath = path.join(value.artifactDirectory, reservation.name);
    await fs.writeFile(stagePath, "inactive", { mode: 0o600 });
    releaseArenaEvidenceStageName(stagePath.toUpperCase());
    t.after(() => releaseArenaEvidenceStageName(stagePath));

    await recoverArenaEvidenceStageTemps(
      value.artifactDirectory,
      ["patch.bin"],
      value.boundary,
    );
    await assert.rejects(fs.lstat(stagePath), { code: "ENOENT" });
  });

  test("reclaims an inactive stage from the current process session", async (t) => {
    const value = await fixture(t);
    const reservation = reserveArenaEvidenceStageName("patch.bin");
    const stagePath = path.join(value.artifactDirectory, reservation.name);
    await fs.writeFile(stagePath, "inactive", { mode: 0o600 });
    releaseArenaEvidenceStageName(stagePath);

    await recoverArenaEvidenceStageTemps(
      value.artifactDirectory,
      ["patch.bin"],
      value.boundary,
    );

    await assert.rejects(fs.lstat(stagePath), { code: "ENOENT" });
  });

  test("removes an uncommitted stage from a publisher that is definitely gone", async (t) => {
    const value = await fixture(t);
    const stagePath = path.join(
      value.artifactDirectory,
      stageName("patch.bin", 2_000_000_000),
    );
    await fs.writeFile(stagePath, "orphan", { mode: 0o600 });

    await recoverArenaEvidenceStageTemps(
      value.artifactDirectory,
      ["patch.bin"],
      value.boundary,
    );
    await assert.rejects(fs.lstat(stagePath), { code: "ENOENT" });
  });

  test("normalizes a dead publisher's exact two-link final publication", async (t) => {
    const value = await fixture(t);
    const stagePath = path.join(
      value.artifactDirectory,
      stageName("untracked.v2.bin", 2_000_000_000),
    );
    const finalPath = path.join(value.artifactDirectory, "untracked.v2.bin");
    await fs.writeFile(stagePath, "committed", { mode: 0o600 });
    await fs.link(stagePath, finalPath);

    await recoverArenaEvidenceStageTemps(
      value.artifactDirectory,
      ["untracked.v2.bin"],
      value.boundary,
    );
    await assert.rejects(fs.lstat(stagePath), { code: "ENOENT" });
    assert.equal(await fs.readFile(finalPath, "utf8"), "committed");
    assert.equal((await fs.lstat(finalPath)).nlink, 1);
  });

  test("fails closed while a matching stage publisher may still be alive", async (t) => {
    const value = await fixture(t);
    const stagePath = path.join(
      value.artifactDirectory,
      stageName("patch.bin", process.pid),
    );
    await fs.writeFile(stagePath, "live", { mode: 0o600 });

    await assert.rejects(
      recoverArenaEvidenceStageTemps(
        value.artifactDirectory,
        ["patch.bin"],
        value.boundary,
      ),
      /publisher may still be alive/,
    );
    assert.equal(await fs.readFile(stagePath, "utf8"), "live");
  });

  test("ignores near-match names because every protocol dot is literal", async (t) => {
    const value = await fixture(t);
    const nearMatch = path.join(
      value.artifactDirectory,
      `Xpatch.binY2000000000-${randomUUID()}Ztmp`,
    );
    await fs.writeFile(nearMatch, "unrelated", { mode: 0o600 });

    await recoverArenaEvidenceStageTemps(
      value.artifactDirectory,
      ["patch.bin"],
      value.boundary,
    );
    assert.equal(await fs.readFile(nearMatch, "utf8"), "unrelated");
  });

  test("durably removes earlier dead stages before a later live stage fails closed", async (t) => {
    const value = await fixture(t);
    const deadStage = path.join(
      value.artifactDirectory,
      stageName("patch.bin", 2_000_000_000),
    );
    const liveStage = path.join(
      value.artifactDirectory,
      stageName("untracked-paths.v1.bin", process.pid),
    );
    await fs.writeFile(deadStage, "dead", { mode: 0o600 });
    await fs.writeFile(liveStage, "live", { mode: 0o600 });

    await assert.rejects(
      recoverArenaEvidenceStageTemps(
        value.artifactDirectory,
        ["patch.bin", "untracked-paths.v1.bin"],
        value.boundary,
      ),
      /publisher may still be alive/,
    );
    await assert.rejects(fs.lstat(deadStage), { code: "ENOENT" });
    assert.equal(await fs.readFile(liveStage, "utf8"), "live");
  });
});
