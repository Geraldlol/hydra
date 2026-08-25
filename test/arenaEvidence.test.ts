import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import fsPromises = require("node:fs/promises");
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
  discardArenaEvidenceCaptureStages,
  preserveArenaEvidence,
  verifyArenaArtifactSet,
} from "../src/arenaEvidence";
import {
  recoverArenaEvidenceStageTemps,
  releaseArenaEvidenceStageName,
  reserveArenaEvidenceStageName,
} from "../src/arenaEvidenceStageRecovery";
import {
  ensureArenaPrivateDirectory,
  readArenaPrivateFile,
  prepareArenaPrivateStorage,
  serializeArenaPrivateWork,
} from "../src/arenaPrivateStorage";
import type { ArenaStagedEvidenceFile } from "../src/arenaGit";
import { arenaContestantArtifactPath } from "../src/arenaStore";
import {
  arenaArtifactSetSha256,
  canonicalArenaManifestJson,
  type ArenaEvidencePreservedPayload,
} from "../src/arenaRunManifest";

const SHA = "a".repeat(64);

async function fixture(t: TestContext): Promise<{
  privateRoot: string;
  worktree: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-evidence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const privateRoot = path.join(root, "private");
  const worktree = path.join(root, "worktree");
  await fs.mkdir(worktree, { recursive: true });
  return { privateRoot, worktree };
}

async function input(
  value: Awaited<ReturnType<typeof fixture>>,
  untrackedPathsZ = Buffer.alloc(0),
): Promise<{
  privateWorkspaceRoot: string;
  runId: string;
  contestantId: string;
  worktreePath: string;
  patch: ArenaStagedEvidenceFile;
  untrackedPaths: ArenaStagedEvidenceFile;
  receiptsRootSha256: string;
  quiescenceReceiptSha256: string;
  quiescenceWorkspaceFingerprintSha256: string;
  finalHead: { objectFormat: "sha1"; oid: string };
  finalWorkspaceFingerprintSha256: string;
  confirmSnapshotBeforePublication: () => Promise<void>;
  confirmSnapshotAfterPublication: () => Promise<void>;
}> {
  const runId = "run-one";
  const contestantId = "codex";
  const boundary = await prepareArenaPrivateStorage(value.privateRoot);
  await ensureArenaPrivateDirectory(boundary, [
    "artifacts",
    runId,
    contestantId,
  ]);
  const artifactDirectory = arenaContestantArtifactPath(
    value.privateRoot,
    runId,
    contestantId,
  );
  const stage = async (
    artifactName: string,
    bytes: Buffer,
  ): Promise<ArenaStagedEvidenceFile> => {
    const stagePath = path.join(
      artifactDirectory,
      `.${artifactName}.${process.pid}-${randomUUID()}-${randomUUID()}.tmp`,
    );
    const handle = await fs.open(stagePath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      const stat = await handle.stat();
      assert.equal(stat.size, bytes.byteLength);
    } finally {
      await handle.close();
    }
    return Object.freeze({
      path: stagePath,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  };
  return {
    privateWorkspaceRoot: value.privateRoot,
    runId,
    contestantId,
    worktreePath: value.worktree,
    patch: await stage("patch.bin", Buffer.from("binary patch\n", "utf8")),
    untrackedPaths: await stage("untracked-paths.v1.bin", untrackedPathsZ),
    receiptsRootSha256: SHA,
    quiescenceReceiptSha256: "b".repeat(64),
    quiescenceWorkspaceFingerprintSha256: "c".repeat(64),
    finalHead: {
      objectFormat: "sha1" as const,
      oid: "1".repeat(40),
    },
    finalWorkspaceFingerprintSha256: "c".repeat(64),
    confirmSnapshotBeforePublication: async () => {},
    confirmSnapshotAfterPublication: async () => {},
  };
}

async function reservedInput(
  t: TestContext,
  value: Awaited<ReturnType<typeof fixture>>,
): Promise<Awaited<ReturnType<typeof input>>> {
  const capture = await input(value);
  await Promise.all([
    fs.unlink(capture.patch.path),
    fs.unlink(capture.untrackedPaths.path),
  ]);
  const artifactDirectory = path.dirname(capture.patch.path);
  const stage = async (
    artifactName: string,
    bytes: Buffer,
  ): Promise<ArenaStagedEvidenceFile> => {
    const reservation = reserveArenaEvidenceStageName(artifactName);
    const stagePath = path.join(artifactDirectory, reservation.name);
    await fs.writeFile(stagePath, bytes, { mode: 0o600 });
    t.after(() => releaseArenaEvidenceStageName(stagePath));
    return Object.freeze({
      path: stagePath,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  };
  return Object.freeze({
    ...capture,
    patch: await stage("patch.bin", Buffer.from("reserved patch\n", "utf8")),
    untrackedPaths: await stage("untracked-paths.v1.bin", Buffer.alloc(0)),
  });
}

describe("Arena evidence preservation", () => {
  test("a cleanup failure releases its reservation for strict same-session recovery", async (t) => {
    const value = await fixture(t);
    const boundary = await prepareArenaPrivateStorage(value.privateRoot);
    const artifactDirectory = await ensureArenaPrivateDirectory(boundary, [
      "artifacts",
      "run-one",
      "codex",
    ]);
    const createReservedStage = async (
      artifactName: string,
      bytes: Buffer,
    ): Promise<ArenaStagedEvidenceFile> => {
      const reservation = reserveArenaEvidenceStageName(artifactName);
      const stagePath = path.join(artifactDirectory, reservation.name);
      await fs.writeFile(stagePath, bytes, { mode: 0o600 });
      t.after(() => releaseArenaEvidenceStageName(stagePath));
      return Object.freeze({
        path: stagePath,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    };
    const patch = await createReservedStage(
      "patch.bin",
      Buffer.from("patch\n", "utf8"),
    );
    const untrackedPaths = await createReservedStage(
      "untracked-paths.v1.bin",
      Buffer.alloc(0),
    );
    const originalUnlink = fsPromises.unlink.bind(fsPromises);
    let injected = false;
    const unlinkMock = t.mock.method(
      fsPromises,
      "unlink",
      (async (...args: Parameters<typeof fsPromises.unlink>) => {
        if (!injected
          && path.resolve(String(args[0])) === path.resolve(patch.path)) {
          injected = true;
          throw Object.assign(new Error("injected cleanup failure"), {
            code: "EIO",
          });
        }
        return originalUnlink(...args);
      }) as typeof fsPromises.unlink,
    );

    await assert.rejects(
      discardArenaEvidenceCaptureStages({
        privateWorkspaceRoot: value.privateRoot,
        runId: "run-one",
        contestantId: "codex",
        patch,
        untrackedPaths,
      }),
      /cleanup failed/,
    );
    assert.equal(injected, true);
    unlinkMock.mock.restore();

    await recoverArenaEvidenceStageTemps(
      artifactDirectory,
      ["patch.bin", "untracked-paths.v1.bin"],
      boundary,
    );
    await assert.rejects(fs.lstat(patch.path), { code: "ENOENT" });
    await assert.rejects(fs.lstat(untrackedPaths.path), { code: "ENOENT" });
  });

  test("missing-directory cleanup releases both stage reservations", async (t) => {
    const value = await fixture(t);
    const capture = await reservedInput(t, value);
    const artifactDirectory = path.dirname(capture.patch.path);
    await fs.rm(artifactDirectory, { recursive: true, force: true });

    await discardArenaEvidenceCaptureStages({
      privateWorkspaceRoot: value.privateRoot,
      runId: capture.runId,
      contestantId: capture.contestantId,
      patch: capture.patch,
      untrackedPaths: capture.untrackedPaths,
    });

    const boundary = await prepareArenaPrivateStorage(value.privateRoot);
    await ensureArenaPrivateDirectory(boundary, [
      "artifacts",
      capture.runId,
      capture.contestantId,
    ]);
    await Promise.all([
      fs.writeFile(capture.patch.path, "stale patch", { mode: 0o600 }),
      fs.writeFile(capture.untrackedPaths.path, "stale paths", { mode: 0o600 }),
    ]);
    await recoverArenaEvidenceStageTemps(
      artifactDirectory,
      ["patch.bin", "untracked-paths.v1.bin"],
      boundary,
    );
    await assert.rejects(fs.lstat(capture.patch.path), { code: "ENOENT" });
    await assert.rejects(fs.lstat(capture.untrackedPaths.path), { code: "ENOENT" });
  });

  test("preservation setup failure releases both stage reservations", async (t) => {
    const value = await fixture(t);
    const capture = await reservedInput(t, value);
    const artifactDirectory = path.dirname(capture.patch.path);
    const originalLstat = fsPromises.lstat.bind(fsPromises);
    let injected = false;
    const lstatMock = t.mock.method(
      fsPromises,
      "lstat",
      (async (...args: Parameters<typeof fsPromises.lstat>) => {
        if (!injected
          && path.resolve(String(args[0])) === path.resolve(artifactDirectory)) {
          injected = true;
          throw Object.assign(new Error("injected setup failure"), { code: "EIO" });
        }
        return originalLstat(...args);
      }) as typeof fsPromises.lstat,
    );

    await assert.rejects(
      preserveArenaEvidence(capture),
      /injected setup failure/,
    );
    assert.equal(injected, true);
    lstatMock.mock.restore();

    const boundary = await prepareArenaPrivateStorage(value.privateRoot);
    await recoverArenaEvidenceStageTemps(
      artifactDirectory,
      ["patch.bin", "untracked-paths.v1.bin"],
      boundary,
    );
    await assert.rejects(fs.lstat(capture.patch.path), { code: "ENOENT" });
    await assert.rejects(fs.lstat(capture.untrackedPaths.path), { code: "ENOENT" });
  });

  test("publishes binary patch, deterministic untracked archive, inventory, and receipt", async (t) => {
    const value = await fixture(t);
    await fs.mkdir(path.join(value.worktree, "nested"));
    await fs.writeFile(path.join(value.worktree, "nested", "new.bin"), Buffer.from([0, 1, 2]));
    const result = await preserveArenaEvidence(await input(
      value,
      Buffer.from("nested/new.bin\0", "utf8"),
    ));
    assert.match(result.payload.artifactSetSha256, /^[a-f0-9]{64}$/u);
    assert.equal(result.payload.untrackedArchiveBytes > 0, true);
    const boundary = await prepareArenaPrivateStorage(value.privateRoot);
    const receipt = await readArenaPrivateFile(
      path.join(result.artifactDirectory, "artifact-set.v1.json"),
      64 * 1024,
      boundary,
    );
    assert.match(receipt.toString("utf8"), /arenaArtifactSet/u);
    assert.deepEqual(
      (await fs.readdir(result.artifactDirectory)).sort(),
      [
        "artifact-set.v1.json",
        "inventory.v2.json",
        "patch.bin",
        "untracked.v2.bin",
      ],
    );

    const retry = await preserveArenaEvidence(await input(
      value,
      Buffer.from("nested/new.bin\0", "utf8"),
    ));
    assert.deepEqual(retry.payload, result.payload);
  });

  test("requires the quiescence fingerprint to equal the final capture", async (t) => {
    const value = await fixture(t);
    const capture = await input(value);
    await assert.rejects(
      preserveArenaEvidence({
        ...capture,
        finalWorkspaceFingerprintSha256: "d".repeat(64),
      }),
      /quiescence and final fingerprints/,
    );
    assert.deepEqual(await fs.readdir(path.dirname(capture.patch.path)), []);
  });

  test("publishes nothing and removes owned stages when snapshot confirmation fails", async (t) => {
    const value = await fixture(t);
    await fs.writeFile(path.join(value.worktree, "new.txt"), "evidence");
    const capture = await input(
      value,
      Buffer.from("new.txt\0", "utf8"),
    );
    const artifactDirectory = path.dirname(capture.patch.path);

    await assert.rejects(
      preserveArenaEvidence({
        ...capture,
        confirmSnapshotBeforePublication: async () => {
          assert.equal(
            (await fs.readdir(artifactDirectory))
              .some((name) => !name.startsWith(".")),
            false,
          );
          throw new Error("synthetic snapshot mismatch");
        },
      }),
      /synthetic snapshot mismatch/,
    );
    assert.deepEqual(await fs.readdir(artifactDirectory), []);
  });

  test("post-publication mismatch retains coherent finals but grants no successful result", async (t) => {
    const value = await fixture(t);
    const tracked = path.join(value.worktree, "tracked.txt");
    await fs.writeFile(tracked, "snapshot A", "utf8");
    const capture = await input(value);
    const artifactDirectory = path.dirname(capture.patch.path);

    await assert.rejects(
      preserveArenaEvidence({
        ...capture,
        confirmSnapshotAfterPublication: async () => {
          await fs.writeFile(tracked, "snapshot B", "utf8");
          throw new Error("synthetic publication-window mutation");
        },
      }),
      /publication-window mutation/,
    );
    assert.deepEqual(
      (await fs.readdir(artifactDirectory)).sort(),
      [
        "artifact-set.v1.json",
        "inventory.v2.json",
        "patch.bin",
      ],
      "published immutable evidence remains available for recovery without stages",
    );
  });

  test("empty evidence recovers a dead archive stage before publishing", async (t) => {
    const value = await fixture(t);
    const capture = await input(value);
    const artifactDirectory = path.dirname(capture.patch.path);
    const orphan = path.join(
      artifactDirectory,
      `.untracked.v2.bin.2000000000-${randomUUID()}.tmp`,
    );
    await fs.writeFile(orphan, "orphan", { mode: 0o600 });

    const result = await preserveArenaEvidence(capture);

    assert.equal(result.payload.untrackedArchiveSha256, null);
    assert.equal(
      (await fs.readdir(artifactDirectory)).some((entry) =>
        entry.endsWith(".tmp")),
      false,
    );
  });

  test("empty evidence rejects an unbound final archive", async (t) => {
    const value = await fixture(t);
    const capture = await input(value);
    const artifactDirectory = path.dirname(capture.patch.path);
    await fs.writeFile(
      path.join(artifactDirectory, "untracked.v2.bin"),
      "stale archive",
      { mode: 0o600 },
    );

    await assert.rejects(
      preserveArenaEvidence(capture),
      /exists for an empty evidence inventory/,
    );
  });

  test("a changed retry cannot publish finals beside an authoritative empty set", async (t) => {
    const value = await fixture(t);
    const first = await preserveArenaEvidence(await input(value));
    await fs.writeFile(path.join(value.worktree, "later.bin"), "later", "utf8");

    await assert.rejects(
      preserveArenaEvidence(await input(
        value,
        Buffer.from("later.bin\0", "utf8"),
      )),
      /authoritative artifact-set receipt/,
    );
    assert.deepEqual(
      (await fs.readdir(first.artifactDirectory)).sort(),
      ["artifact-set.v1.json", "inventory.v2.json", "patch.bin"],
    );
  });

  test("artifact verification rejects retained-byte corruption", async (t) => {
    const value = await fixture(t);
    const result = await preserveArenaEvidence(await input(value));
    await fs.writeFile(
      path.join(result.artifactDirectory, "patch.bin"),
      "corrupted retained patch\n",
      { mode: 0o600 },
    );

    await assert.rejects(
      verifyArenaArtifactSet({
        privateWorkspaceRoot: value.privateRoot,
        runId: "run-one",
        contestantId: "codex",
        payload: result.payload,
      }),
      /byte count|receipt/,
    );
  });

  test("artifact verification normalizes a dead publisher's final link", async (t) => {
    const value = await fixture(t);
    const result = await preserveArenaEvidence(await input(value));
    const patchPath = path.join(result.artifactDirectory, "patch.bin");
    const orphan = path.join(
      result.artifactDirectory,
      `.patch.bin.2000000000-${randomUUID()}.tmp`,
    );
    await fs.link(patchPath, orphan);

    await verifyArenaArtifactSet({
      privateWorkspaceRoot: value.privateRoot,
      runId: "run-one",
      contestantId: "codex",
      payload: result.payload,
    });

    assert.equal((await fs.lstat(patchPath)).nlink, 1);
    await assert.rejects(fs.lstat(orphan), { code: "ENOENT" });
  });

  test("artifact verification waits for the artifact-set publication lock", async (t) => {
    const value = await fixture(t);
    const result = await preserveArenaEvidence(await input(value));
    const boundary = await prepareArenaPrivateStorage(value.privateRoot);
    const receiptPath = path.join(
      result.artifactDirectory,
      "artifact-set.v1.json",
    );
    const patchPath = path.join(result.artifactDirectory, "patch.bin");
    const displacedPatchPath = path.join(
      result.artifactDirectory,
      "patch.displaced-for-lock-test",
    );
    let releaseBlocker!: () => void;
    let reportAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      reportAcquired = resolve;
    });
    const blocker = serializeArenaPrivateWork(
      boundary,
      receiptPath,
      async () => {
        await fs.rename(patchPath, displacedPatchPath);
        await fs.writeFile(patchPath, "not the retained patch", { mode: 0o600 });
        reportAcquired();
        await new Promise<void>((resolve) => {
          releaseBlocker = resolve;
        });
        await fs.unlink(patchPath);
        await fs.rename(displacedPatchPath, patchPath);
      },
    );
    await acquired;

    const verification = verifyArenaArtifactSet({
      privateWorkspaceRoot: value.privateRoot,
      runId: "run-one",
      contestantId: "codex",
      payload: result.payload,
    });
    try {
      const earlyState = await Promise.race([
        verification.then(
          () => "settled" as const,
          () => "settled" as const,
        ),
        new Promise<"waiting">((resolve) => {
          setTimeout(() => resolve("waiting"), 100);
        }),
      ]);
      assert.equal(earlyState, "waiting");
    } finally {
      releaseBlocker();
      await blocker;
    }
    await verification;
  });

  test("artifact verification rejects a file replaced after hashing", async (t) => {
    const value = await fixture(t);
    const result = await preserveArenaEvidence(await input(value));
    const patchPath = path.join(result.artifactDirectory, "patch.bin");
    const originalOpendir = fsPromises.opendir.bind(fsPromises);
    let artifactDirectoryScans = 0;
    let replaced = false;
    t.mock.method(
      fsPromises,
      "opendir",
      (async (...args: Parameters<typeof fsPromises.opendir>) => {
        if (path.resolve(String(args[0])) === path.resolve(result.artifactDirectory)) {
          artifactDirectoryScans += 1;
          // Recovery and generation inference scan first. Replace the already
          // hashed file immediately before the final exact-set enumeration.
          if (artifactDirectoryScans === 3) {
            const retained = await fs.readFile(patchPath);
            await fs.writeFile(
              patchPath,
              Buffer.alloc(retained.byteLength, 0x78),
              { mode: 0o600 },
            );
            replaced = true;
          }
        }
        return originalOpendir(...args);
      }) as typeof fsPromises.opendir,
    );

    await assert.rejects(
      verifyArenaArtifactSet({
        privateWorkspaceRoot: value.privateRoot,
        runId: "run-one",
        contestantId: "codex",
        payload: result.payload,
      }),
      /changed|receipt/,
    );
    assert.equal(replaced, true);
  });

  test("artifact verification rejects archive byte claims above the protocol cap before opening files", async (t) => {
    const value = await fixture(t);
    const result = await preserveArenaEvidence(await input(value));
    const oversized = {
      ...result.payload,
      untrackedArchiveSha256: "d".repeat(64),
      untrackedArchiveBytes: (64 * 1024 * 1024) + 1,
    } satisfies ArenaEvidencePreservedPayload;
    const payload = Object.freeze({
      ...oversized,
      artifactSetSha256: arenaArtifactSetSha256(oversized),
    });

    await assert.rejects(
      verifyArenaArtifactSet({
        privateWorkspaceRoot: value.privateRoot,
        runId: "run-one",
        contestantId: "codex",
        payload,
      }),
      /untracked archive exceeds its byte limit/,
    );
  });

  test("patch preservation and verification share the 64 MiB protocol cap", async (t) => {
    const value = await fixture(t);
    const capture = await input(value);
    await fs.unlink(capture.patch.path);
    const oversizedPatch = Object.freeze({
      ...capture.patch,
      bytes: (64 * 1024 * 1024) + 1,
    });
    await assert.rejects(
      preserveArenaEvidence({
        ...capture,
        patch: oversizedPatch,
      }),
      /patch exceeds its byte limit/,
    );

    const result = await preserveArenaEvidence(await input(value));
    const oversized = {
      ...result.payload,
      patchBytes: (64 * 1024 * 1024) + 1,
    } satisfies ArenaEvidencePreservedPayload;
    const payload = Object.freeze({
      ...oversized,
      artifactSetSha256: arenaArtifactSetSha256(oversized),
    });
    await assert.rejects(
      verifyArenaArtifactSet({
        privateWorkspaceRoot: value.privateRoot,
        runId: "run-one",
        contestantId: "codex",
        payload,
      }),
      /patch exceeds its byte limit/,
    );
  });

  test("empty artifact verification recovers dead v1 and v2 archive stages", async (t) => {
    const value = await fixture(t);
    const result = await preserveArenaEvidence(await input(value));
    const stages = ["untracked.v1.bin", "untracked.v2.bin"].map((name) =>
      path.join(
        result.artifactDirectory,
        `.${name}.2000000000-${randomUUID()}.tmp`,
      ));
    await Promise.all(stages.map((stagePath) =>
      fs.writeFile(stagePath, "dead changed-retry stage", { mode: 0o600 })));

    await verifyArenaArtifactSet({
      privateWorkspaceRoot: value.privateRoot,
      runId: "run-one",
      contestantId: "codex",
      payload: result.payload,
    });
    await Promise.all(stages.map((stagePath) =>
      assert.rejects(fs.lstat(stagePath), { code: "ENOENT" })));
  });

  test("artifact verification accepts one exact historical v1 artifact generation", async (t) => {
    const value = await fixture(t);
    const boundary = await prepareArenaPrivateStorage(value.privateRoot);
    const runId = "legacy-run";
    const contestantId = "codex";
    await ensureArenaPrivateDirectory(boundary, [
      "artifacts",
      runId,
      contestantId,
    ]);
    const artifactDirectory = arenaContestantArtifactPath(
      value.privateRoot,
      runId,
      contestantId,
    );
    const patch = Buffer.from("legacy patch\n", "utf8");
    const untrackedBytes = Buffer.from("legacy evidence", "utf8");
    const gitPath = "legacy.txt";
    const encodedPath = Buffer.from(gitPath, "utf8");
    const header = Buffer.alloc(12);
    header.writeUInt32BE(encodedPath.byteLength, 0);
    header.writeBigUInt64BE(BigInt(untrackedBytes.byteLength), 4);
    const archive = Buffer.concat([
      Buffer.from("HYDRA-ARENA-UNTRACKED-V1\0", "ascii"),
      header,
      encodedPath,
      untrackedBytes,
    ]);
    const inventory = Buffer.from(`${canonicalArenaManifestJson({
      schemaVersion: 1,
      entries: [{
        path: gitPath,
        bytes: untrackedBytes.byteLength,
        sha256: createHash("sha256").update(untrackedBytes).digest("hex"),
      }],
    })}\n`, "utf8");
    const withoutArtifactSet = {
      payloadType: "evidencePreserved" as const,
      contestantId,
      receiptsRootSha256: SHA,
      patchSha256: createHash("sha256").update(patch).digest("hex"),
      patchBytes: patch.byteLength,
      untrackedArchiveSha256:
        createHash("sha256").update(archive).digest("hex"),
      untrackedArchiveBytes: archive.byteLength,
      inventorySha256:
        createHash("sha256").update(inventory).digest("hex"),
      quiescenceReceiptSha256: "b".repeat(64),
      quiescenceWorkspaceFingerprintSha256: "c".repeat(64),
      finalHead: { objectFormat: "sha1" as const, oid: "1".repeat(40) },
      finalWorkspaceFingerprintSha256: "c".repeat(64),
    } satisfies Omit<ArenaEvidencePreservedPayload, "artifactSetSha256">;
    const payload: ArenaEvidencePreservedPayload = Object.freeze({
      ...withoutArtifactSet,
      artifactSetSha256: arenaArtifactSetSha256(withoutArtifactSet),
    });
    const receipt = Buffer.from(`${canonicalArenaManifestJson({
      schemaVersion: 1,
      recordType: "arenaArtifactSet",
      payload,
    })}\n`, "utf8");
    await Promise.all([
      fs.writeFile(path.join(artifactDirectory, "patch.bin"), patch, { mode: 0o600 }),
      fs.writeFile(
        path.join(artifactDirectory, "inventory.v1.json"),
        inventory,
        { mode: 0o600 },
      ),
      fs.writeFile(
        path.join(artifactDirectory, "untracked.v1.bin"),
        archive,
        { mode: 0o600 },
      ),
      fs.writeFile(
        path.join(artifactDirectory, "artifact-set.v1.json"),
        receipt,
        { mode: 0o600 },
      ),
    ]);

    await verifyArenaArtifactSet({
      privateWorkspaceRoot: value.privateRoot,
      runId,
      contestantId,
      payload,
    });
  });

  test("artifact verification rejects mixed v1 and v2 generations", async (t) => {
    const value = await fixture(t);
    const result = await preserveArenaEvidence(await input(value));
    await fs.copyFile(
      path.join(result.artifactDirectory, "inventory.v2.json"),
      path.join(result.artifactDirectory, "inventory.v1.json"),
    );

    await assert.rejects(
      verifyArenaArtifactSet({
        privateWorkspaceRoot: value.privateRoot,
        runId: "run-one",
        contestantId: "codex",
        payload: result.payload,
      }),
      /exactly match|exceeds its authoritative entry count/,
    );
  });

  test("rejects a parent swapped outside the worktree before leaf open", async (t) => {
    const value = await fixture(t);
    const nested = path.join(value.worktree, "nested");
    const originalNested = path.join(value.worktree, "nested-original");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-evidence-outside-"));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, "race.bin"), "inside", "utf8");
    await fs.writeFile(path.join(outside, "race.bin"), "outside", "utf8");
    const probe = path.join(value.worktree, "link-probe");
    try {
      await fs.symlink(
        outside,
        probe,
        process.platform === "win32" ? "junction" : "dir",
      );
      await fs.unlink(probe);
    } catch (error) {
      t.skip(`directory-link creation unavailable: ${String(error)}`);
      return;
    }
    const capture = await input(
      value,
      Buffer.from("nested/race.bin\0", "utf8"),
    );
    const originalLstat = fsPromises.lstat.bind(fsPromises);
    let swapped = false;
    t.mock.method(
      fsPromises,
      "lstat",
      (async (...args: Parameters<typeof fsPromises.lstat>) => {
        const stat = await originalLstat(...args);
        if (!swapped
          && path.resolve(String(args[0])) === path.resolve(nested)) {
          swapped = true;
          await fs.rename(nested, originalNested);
          await fs.symlink(
            outside,
            nested,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        return stat;
      }) as typeof fsPromises.lstat,
    );

    await assert.rejects(
      preserveArenaEvidence(capture),
      /parent changed identity|linked or invalid parent|escaped its authenticated root/,
    );
    assert.equal(swapped, true);
  });

  test("rejects traversal, malformed framing, symlinks, and hard links", async (t) => {
    const value = await fixture(t);
    await assert.rejects(
      preserveArenaEvidence(await input(value, Buffer.from("../escape\0"))),
      /unsafe/,
    );
    await assert.rejects(
      preserveArenaEvidence(await input(value, Buffer.from("unterminated"))),
      /not NUL terminated/,
    );

    const source = path.join(value.worktree, "source.txt");
    await fs.writeFile(source, "secret");
    const linked = path.join(value.worktree, "linked.txt");
    try {
      await fs.symlink(source, linked);
      await assert.rejects(
        preserveArenaEvidence(await input(value, Buffer.from("linked.txt\0"))),
        /linked or not a regular/,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }

    const hard = path.join(value.worktree, "hard.txt");
    await fs.link(source, hard);
    await assert.rejects(
      preserveArenaEvidence(await input(value, Buffer.from("hard.txt\0"))),
      /linked or not a regular/,
    );
  });

  test("streams a multi-megabyte untracked file into a sealed archive", async (t) => {
    const value = await fixture(t);
    const payload = Buffer.alloc(8 * 1024 * 1024, 0x5a);
    await fs.writeFile(path.join(value.worktree, "large.bin"), payload);

    const result = await preserveArenaEvidence(await input(
      value,
      Buffer.from("large.bin\0", "utf8"),
    ));
    const boundary = await prepareArenaPrivateStorage(value.privateRoot);
    const archive = await readArenaPrivateFile(
      path.join(result.artifactDirectory, "untracked.v2.bin"),
      9 * 1024 * 1024,
      boundary,
    );

    assert.equal(
      createHash("sha256").update(archive).digest("hex"),
      result.payload.untrackedArchiveSha256,
    );
    assert.equal(archive.subarray(-payload.byteLength).equals(payload), true);
    assert.equal(
      (await fs.readdir(result.artifactDirectory))
        .some((name) => name.endsWith(".tmp")),
      false,
    );
  });

  test("v2 inventory and archive bind executable mode bits", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX executable-mode evidence");
      return;
    }
    const value = await fixture(t);
    const executable = path.join(value.worktree, "tool.sh");
    await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o751 });
    await fs.chmod(executable, 0o751);
    const result = await preserveArenaEvidence(await input(
      value,
      Buffer.from("tool.sh\0", "utf8"),
    ));
    const inventory = JSON.parse(await fs.readFile(
      path.join(result.artifactDirectory, "inventory.v2.json"),
      "utf8",
    )) as {
      readonly schemaVersion: number;
      readonly entries: readonly [{ readonly mode: number }];
    };
    assert.equal(inventory.schemaVersion, 2);
    assert.equal(inventory.entries[0].mode, 0o751);

    const archive = await fs.readFile(
      path.join(result.artifactDirectory, "untracked.v2.bin"),
    );
    const magicBytes = Buffer.byteLength("HYDRA-ARENA-UNTRACKED-V2\0", "ascii");
    assert.equal(archive.readUInt32BE(magicBytes + 12), 0o751);
  });

  test("rejects a same-inode resize between discovery and open", async (t) => {
    const value = await fixture(t);
    const target = path.join(value.worktree, "racing.bin");
    await fs.writeFile(target, "before", "utf8");
    const capture = await input(
      value,
      Buffer.from("racing.bin\0", "utf8"),
    );
    const originalOpen = fsPromises.open.bind(fsPromises);
    let changed = false;
    t.mock.method(
      fsPromises,
      "open",
      (async (...args: Parameters<typeof fsPromises.open>) => {
        if (!changed && path.resolve(String(args[0])) === path.resolve(target)) {
          changed = true;
          await fs.appendFile(target, "-after-lstat", "utf8");
        }
        return originalOpen(...args);
      }) as typeof fsPromises.open,
    );

    await assert.rejects(
      preserveArenaEvidence(capture),
      /changed while opening/,
    );
    assert.equal(changed, true);
  });
});
