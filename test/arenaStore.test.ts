import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
  ARENA_MANIFEST_CLOSURE_BYTE_RESERVE,
  ARENA_MANIFEST_CLOSURE_EVENT_RESERVE,
  ArenaManifestFileError,
  FileArenaManifestStore,
  arenaContestantArtifactPath,
  arenaContestantWorktreePath,
  arenaRunPaths,
  arenaStorePaths,
  evaluateArenaManifestAppendCapacity,
  openFileArenaManifestStore,
  rebuildArenaRunIndex,
} from "../src/arenaStore";
import { arenaPhysicalWorktreeSegment } from "../src/arenaPathBudget";
import {
  ARENA_MANIFEST_LIMITS,
  ARENA_POLICY_ID,
  type ArenaMainWorkspaceObservedPayload,
  type ArenaManifestEventDraft,
  type ArenaRunLockedPayload,
} from "../src/arenaRunManifest";

const RUN_ID = "arena-store-run";
const TIME = "2026-07-25T13:30:00.000Z";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function lockPayload(): ArenaRunLockedPayload {
  return {
    payloadType: "runLocked",
    policy: ARENA_POLICY_ID,
    mission: {
      missionId: "mission-store",
      revision: 1,
      documentSha256: digest("mission-document"),
      bindingSha256: digest("mission-binding"),
    },
    base: {
      revision: {
        objectFormat: "sha1",
        oid: "a".repeat(40),
      },
      repositoryIdentitySha256: digest("repository"),
      baseContentSha256: digest("base-content"),
      sourceWorkspaceFingerprintSha256: digest("source-workspace"),
      repositoryControlSha256: digest("repository-control"),
    },
    inputBundleSha256: digest("input"),
    preparationPlanSha256: null,
    environmentPolicySha256: digest("environment"),
    budgetSha256: digest("budget"),
    verificationChecks: [],
    browserJourneys: [],
    contestants: [
      {
        contestantId: "contestant-one",
        headId: "codex",
        agentKind: "codex",
        headConfigSha256: digest("codex-config"),
        authoritySha256: digest("codex-authority"),
        invocationSha256: digest("codex-invocation"),
        worktreeId: "worktree-one",
      },
      {
        contestantId: "contestant-two",
        headId: "claude",
        agentKind: "claude",
        headConfigSha256: digest("claude-config"),
        authoritySha256: digest("claude-authority"),
        invocationSha256: digest("claude-invocation"),
        worktreeId: "worktree-two",
      },
    ],
    steering: "disabled",
    confirmation: {
      actorId: "local-user",
      action: "Confirm Arena Run",
      confirmationId: "confirmation-store",
    },
  };
}

function lockDraft(): ArenaManifestEventDraft {
  return {
    eventId: "event-lock",
    runId: RUN_ID,
    occurredAt: TIME,
    type: "arenaRunLocked",
    payload: lockPayload(),
  };
}

function observationDraft(
  eventId: string,
  kind: "monitorStarted" | "checkpoint",
): ArenaManifestEventDraft {
  const lock = lockPayload();
  const payload: ArenaMainWorkspaceObservedPayload = {
    payloadType: "mainWorkspaceObserved",
    observationKind: kind,
    monitorEpochId: "monitor-store",
    monitorReceiptSha256: digest(`receipt-${eventId}`),
    status: "unchanged",
    sourceWorkspaceFingerprintSha256:
      lock.base.sourceWorkspaceFingerprintSha256,
    repositoryControlSha256: lock.base.repositoryControlSha256,
    head: lock.base.revision,
    watcherChanged: false,
    reasonCode: null,
  };
  return {
    eventId,
    runId: RUN_ID,
    occurredAt: TIME,
    type: "arenaMainWorkspaceObserved",
    payload,
  };
}

async function tempRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-store-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

describe("Arena private manifest store", () => {
  test("constructs exact private paths and rejects path traversal identifiers", async (t) => {
    const root = await tempRoot(t);
    const paths = arenaStorePaths(root);
    const run = arenaRunPaths(root, RUN_ID);
    assert.equal(run.manifestPath, path.join(paths.runsPath, RUN_ID, "manifest.v1.jsonl"));
    assert.equal(
      arenaContestantArtifactPath(root, RUN_ID, "contestant-one"),
      path.join(paths.artifactsPath, RUN_ID, "contestant-one"),
    );
    assert.equal(
      arenaContestantWorktreePath(root, RUN_ID, "contestant-one"),
      path.join(
        paths.worktreesPath,
        "p",
        arenaPhysicalWorktreeSegment(RUN_ID, "contestant-one"),
      ),
    );
    assert.throws(() => arenaRunPaths(root, "../escape"), /not safe/);
    assert.throws(
      () => arenaContestantWorktreePath(root, RUN_ID, ".."),
      /not safe/,
    );
  });

  test("appends under a cross-process lease, replays, and treats exact retries as idempotent", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileArenaManifestStore(root);
    const first = await store.append(lockDraft());
    const retry = await store.append(structuredClone(lockDraft()));
    assert.deepEqual(retry, first);

    await store.append(observationDraft("event-monitor", "monitorStarted"));
    const replay = await store.load(RUN_ID);
    assert.ok(replay);
    assert.equal(replay.records.length, 2);
    assert.equal(replay.state, "locked");

    const collision: ArenaManifestEventDraft = {
      ...structuredClone(lockDraft()),
      occurredAt: "2026-07-25T13:31:00.000Z",
    };
    await assert.rejects(
      store.append(collision),
      (error: unknown) =>
        error instanceof ArenaManifestFileError
        && error.code === "invalid"
        && /collided/.test(error.message),
    );
  });

  test("rejects unknown draft fields before canonicalization", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileArenaManifestStore(root);
    const draft = {
      ...lockDraft(),
      authority: "expanded",
    } as ArenaManifestEventDraft;
    await assert.rejects(
      store.append(draft),
      (error: unknown) =>
        error instanceof ArenaManifestFileError
        && error.code === "invalid"
        && /unknown or missing fields/.test(error.message),
    );
    assert.equal(await store.load(RUN_ID), undefined);
  });

  test("binds a replayed manifest to its exact private run path", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileArenaManifestStore(root);
    await store.append(lockDraft());
    const copiedRunId = "arena-copied-run";
    const copied = arenaRunPaths(root, copiedRunId);
    await fs.mkdir(copied.runPath, { recursive: true });
    await fs.copyFile(
      arenaRunPaths(root, RUN_ID).manifestPath,
      copied.manifestPath,
    );
    await assert.rejects(
      store.load(copiedRunId),
      /contains run arena-store-run/,
    );
  });

  test("serializes concurrent store instances without losing or interleaving events", async (t) => {
    const root = await tempRoot(t);
    const left = new FileArenaManifestStore(root);
    const right = new FileArenaManifestStore(root);
    await left.append(lockDraft());
    await left.append(observationDraft("event-monitor", "monitorStarted"));
    await Promise.all([
      left.append(observationDraft("event-checkpoint-left", "checkpoint")),
      right.append(observationDraft("event-checkpoint-right", "checkpoint")),
    ]);
    const replay = await right.load(RUN_ID);
    assert.ok(replay);
    assert.equal(replay.records.length, 4);
    assert.deepEqual(
      new Set(replay.records.map((event) => event.eventId)),
      new Set([
        "event-lock",
        "event-monitor",
        "event-checkpoint-left",
        "event-checkpoint-right",
      ]),
    );
  });

  test("fails closed on torn, malformed UTF-8, non-canonical, and oversized files", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileArenaManifestStore(root);
    await store.append(lockDraft());
    const manifest = arenaRunPaths(root, RUN_ID).manifestPath;
    const canonical = await fs.readFile(manifest);

    await fs.writeFile(manifest, canonical.subarray(0, canonical.length - 1));
    await assert.rejects(
      store.load(RUN_ID),
      (error: unknown) =>
        error instanceof ArenaManifestFileError && error.code === "torn",
    );

    await fs.writeFile(manifest, Buffer.from([0xff, 0x0a]));
    await assert.rejects(
      store.load(RUN_ID),
      (error: unknown) =>
        error instanceof ArenaManifestFileError && error.code === "malformed",
    );

    await fs.writeFile(
      manifest,
      ` ${canonical.toString("utf8").trim()}\n`,
      "utf8",
    );
    await assert.rejects(
      store.load(RUN_ID),
      (error: unknown) =>
        error instanceof ArenaManifestFileError
        && error.code === "nonCanonical",
    );

    await fs.writeFile(
      manifest,
      Buffer.alloc(ARENA_MANIFEST_LIMITS.maxManifestBytes + 1, 0x61),
    );
    await assert.rejects(
      store.load(RUN_ID),
      (error: unknown) =>
        error instanceof ArenaManifestFileError && error.code === "oversized",
    );
  });

  test("treats an existing empty manifest as corrupt instead of a new run", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileArenaManifestStore(root);
    await store.append(lockDraft());
    const manifest = arenaRunPaths(root, RUN_ID).manifestPath;
    await fs.writeFile(manifest, "");
    await assert.rejects(
      store.load(RUN_ID),
      (error: unknown) =>
        error instanceof ArenaManifestFileError
        && error.code === "invalid"
        && /empty/.test(error.message),
    );
    await assert.rejects(
      store.append(lockDraft()),
      (error: unknown) =>
        error instanceof ArenaManifestFileError
        && error.code === "invalid",
    );
  });

  test("refuses manifest symlinks", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileArenaManifestStore(root);
    await store.append(lockDraft());
    const manifest = arenaRunPaths(root, RUN_ID).manifestPath;
    const outside = path.join(root, "outside.jsonl");
    await fs.writeFile(outside, await fs.readFile(manifest));
    await fs.rm(manifest);
    try {
      await fs.symlink(outside, manifest, "file");
    } catch (error) {
      t.skip(`symbolic-link creation unavailable: ${String(error)}`);
      return;
    }
    await assert.rejects(store.load(RUN_ID), /unsafe|symbolic|linked/i);
  });

  test("refuses manifest hard links", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileArenaManifestStore(root);
    await store.append(lockDraft());
    const manifest = arenaRunPaths(root, RUN_ID).manifestPath;
    const outside = path.join(root, "outside.jsonl");
    await fs.writeFile(outside, await fs.readFile(manifest));
    await fs.rm(manifest);
    try {
      await fs.link(outside, manifest);
    } catch (error) {
      t.skip(`hard-link creation unavailable: ${String(error)}`);
      return;
    }
    await assert.rejects(store.load(RUN_ID), /unsafe|hard|linked/i);
  });

  test("refuses a linked run parent that resolves outside Arena storage", async (t) => {
    const root = await tempRoot(t);
    await openFileArenaManifestStore(root);
    const runsPath = arenaStorePaths(root).runsPath;
    const runPath = path.join(runsPath, RUN_ID);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-run-outside-"));
    t.after(async () => {
      await fs.rm(outside, { recursive: true, force: true });
    });
    try {
      await fs.symlink(
        outside,
        runPath,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      t.skip(`directory-link creation unavailable: ${String(error)}`);
      return;
    }
    const store = new FileArenaManifestStore(root);
    await assert.rejects(store.append(lockDraft()), /linked|escapes|invalid/i);
  });

  test("reserves bounded closure capacity for terminal and cleanup receipts", () => {
    assert.equal(ARENA_MANIFEST_CLOSURE_EVENT_RESERVE, 363);
    assert.equal(
      evaluateArenaManifestAppendCapacity({
        currentEvents:
          ARENA_MANIFEST_LIMITS.maxEvents
            - ARENA_MANIFEST_CLOSURE_EVENT_RESERVE,
        currentBytes: 0,
        candidateBytes: 1,
        eventType: "arenaContestantStarted",
      }).accepted,
      false,
    );
    assert.equal(
      evaluateArenaManifestAppendCapacity({
        currentEvents: ARENA_MANIFEST_LIMITS.maxEvents - 1,
        currentBytes: 0,
        candidateBytes: 1,
        eventType: "arenaMainWorkspaceObserved",
        observationKind: "checkpoint",
        observationStatus: "unchanged",
      }).accepted,
      false,
    );
    assert.equal(
      evaluateArenaManifestAppendCapacity({
        currentEvents: ARENA_MANIFEST_LIMITS.maxEvents - 1,
        currentBytes: 0,
        candidateBytes: 1,
        eventType: "arenaMainWorkspaceObserved",
        observationKind: "checkpoint",
        observationStatus: "changed",
        changedObservationAlreadyRecorded: false,
      }).accepted,
      true,
    );
    assert.equal(
      evaluateArenaManifestAppendCapacity({
        currentEvents: ARENA_MANIFEST_LIMITS.maxEvents - 1,
        currentBytes: 0,
        candidateBytes: 1,
        eventType: "arenaMainWorkspaceObserved",
        observationKind: "checkpoint",
        observationStatus: "changed",
        changedObservationAlreadyRecorded: true,
      }).accepted,
      false,
    );
    assert.equal(
      evaluateArenaManifestAppendCapacity({
        currentEvents: ARENA_MANIFEST_LIMITS.maxEvents - 1,
        currentBytes: 0,
        candidateBytes: 1,
        eventType: "arenaMainWorkspaceObserved",
        observationKind: "postEvidence",
      }).accepted,
      true,
    );
    assert.equal(
      evaluateArenaManifestAppendCapacity({
        currentEvents: ARENA_MANIFEST_LIMITS.maxEvents - 1,
        currentBytes: 0,
        candidateBytes: 1,
        eventType: "arenaWorktreeRegistered",
      }).accepted,
      true,
    );
    assert.equal(
      evaluateArenaManifestAppendCapacity({
        currentEvents: ARENA_MANIFEST_LIMITS.maxEvents - 1,
        currentBytes: 0,
        candidateBytes: 1,
        eventType: "arenaCleanupStepRecorded",
      }).accepted,
      true,
    );
    assert.equal(
      evaluateArenaManifestAppendCapacity({
        currentEvents: 1,
        currentBytes:
          ARENA_MANIFEST_LIMITS.maxManifestBytes
            - ARENA_MANIFEST_CLOSURE_BYTE_RESERVE,
        candidateBytes: 1,
        eventType: "arenaVerificationRecorded",
      }).accepted,
      false,
    );
  });

  test("rebuilds a bounded discovery index without trusting stale index contents", async (t) => {
    const root = await tempRoot(t);
    const store = await openFileArenaManifestStore(root);
    await store.append(lockDraft());
    await fs.writeFile(
      store.paths.indexPath,
      '{"runId":"forged-authority","state":"comparable"}\n',
      "utf8",
    );
    assert.deepEqual(await store.listRunIds(), [RUN_ID]);
    const rebuilt = await rebuildArenaRunIndex(store);
    assert.equal(rebuilt.length, 1);
    assert.equal(rebuilt[0]?.runId, RUN_ID);
    assert.equal(rebuilt[0]?.state, "locked");
    assert.equal(rebuilt[0]?.comparison, null);
    assert.doesNotMatch(
      await fs.readFile(store.paths.indexPath, "utf8"),
      /forged-authority/,
    );
  });
});
