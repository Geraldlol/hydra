import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import {
  arenaFlightProjectionRecordPath,
  createArenaFlightProjectingManifestStore,
  openFileArenaFlightProjectionStore,
} from "../src/arenaFlightProjection";
import {
  ARENA_MANIFEST_GENESIS_SHA256,
  createArenaManifestEvent,
  type ArenaManifestEvent,
  type ArenaRunLockedPayload,
} from "../src/arenaRunManifest";
import type { ArenaManifestStore } from "../src/arenaStore";

describe("Arena Flight extension projection", () => {
  test("projects lifecycle and evidence references without source content or paths", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-flight-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = await openFileArenaFlightProjectionStore(root);
    const events = manifestEvents();

    for (const event of events) await store.project(event);
    const replay = await store.load("run-one");

    assert.equal(replay.records.length, events.length);
    assert.equal(replay.records[0]?.arenaEventType, "arenaRunLocked");
    assert.equal(replay.records[1]?.arenaEventType, "arenaContestantFinished");
    assert.equal(replay.records[2]?.arenaEventType, "arenaEvidencePreserved");
    assert.equal(
      replay.records[2]?.artifactSetSha256,
      digest("artifact-set"),
    );
    const serialized = JSON.stringify(replay.records);
    assert.doesNotMatch(serialized, /secret source|C:\\repo|\/repo/u);
  });

  test("is exact-retry idempotent and replay rejects a modified projection row", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-flight-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = await openFileArenaFlightProjectionStore(root);
    const first = manifestEvents()[0]!;
    const projected = await store.project(first);
    assert.deepEqual(await store.project(first), projected);
    const recordPath = arenaFlightProjectionRecordPath(root, "run-one", 1);
    await fs.writeFile(recordPath, "{}\n", { mode: 0o600 });

    await assert.rejects(store.load("run-one"), /projection/i);
  });

  test("a projection failure is fenced from authoritative manifest appends", async () => {
    const events = manifestEvents();
    let next = 0;
    const source: ArenaManifestStore = {
      append: async () => events[next++]!,
      load: async () => undefined,
      listRunIds: async () => ["run-one"],
    };
    const projectedSequences: number[] = [];
    const projectionFailures: number[] = [];
    const store = createArenaFlightProjectingManifestStore(
      source,
      {
        project: async (event) => {
          projectedSequences.push(event.sequence);
          if (event.sequence === 2) throw new Error("synthetic recorder outage");
          return {} as never;
        },
      },
      (_error, event) => projectionFailures.push(event.sequence),
    );

    for (const event of events) {
      const appended = await store.append({
        eventId: event.eventId,
        runId: event.runId,
        occurredAt: event.occurredAt,
        type: event.type,
        payload: event.payload,
      });
      assert.equal(appended.sequence, event.sequence);
    }

    assert.equal(await store.flushProjection(), false);
    assert.deepEqual(projectedSequences, [1, 2]);
    assert.deepEqual(projectionFailures, [2]);
    assert.deepEqual(await store.listRunIds(), ["run-one"]);
  });
});

function manifestEvents(): readonly ArenaManifestEvent[] {
  const lock: ArenaRunLockedPayload = {
    payloadType: "runLocked",
    policy: "hydra-arena-v1",
    mission: {
      missionId: "mission-one",
      revision: 1,
      documentSha256: digest("mission-document"),
      bindingSha256: digest("mission-binding"),
    },
    base: {
      revision: { objectFormat: "sha1", oid: "a".repeat(40) },
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
        contestantId: "codex",
        headId: "codex",
        agentKind: "codex",
        headConfigSha256: digest("head-config"),
        authoritySha256: digest("authority"),
        invocationSha256: digest("invocation"),
        worktreeId: "worktree-codex",
      },
      {
        contestantId: "claude",
        headId: "claude",
        agentKind: "claude",
        headConfigSha256: digest("head-config-claude"),
        authoritySha256: digest("authority-claude"),
        invocationSha256: digest("invocation-claude"),
        worktreeId: "worktree-claude",
      },
    ],
    steering: "disabled",
    confirmation: {
      actorId: "local-user",
      action: "Confirm Arena Run",
      confirmationId: "confirmation-one",
    },
  };
  const drafts = [
    { type: "arenaRunLocked" as const, payload: lock },
    {
      type: "arenaContestantFinished" as const,
      payload: {
        payloadType: "contestantFinished" as const,
        contestantId: "codex",
        stage: "execution" as const,
        traceId: "trace-codex",
        status: "succeeded" as const,
        failureCode: null,
        finalHead: lock.base.revision,
        finalWorkspaceFingerprintSha256: digest("final-workspace"),
        outputSha256: digest("secret source"),
        outputBytes: 64,
      },
    },
    {
      type: "arenaEvidencePreserved" as const,
      payload: {
        payloadType: "evidencePreserved" as const,
        contestantId: "codex",
        artifactSetSha256: digest("artifact-set"),
        receiptsRootSha256: digest("receipts"),
        patchSha256: digest("secret patch"),
        patchBytes: 100,
        untrackedArchiveSha256: null,
        untrackedArchiveBytes: 0,
        inventorySha256: digest("inventory"),
        quiescenceReceiptSha256: digest("quiescence"),
        quiescenceWorkspaceFingerprintSha256: digest("final-workspace"),
        finalHead: lock.base.revision,
        finalWorkspaceFingerprintSha256: digest("final-workspace"),
      },
    },
  ];
  const events: ArenaManifestEvent[] = [];
  for (const [index, draft] of drafts.entries()) {
    events.push(createArenaManifestEvent({
      eventId: `event-${index + 1}`,
      runId: "run-one",
      occurredAt: new Date(1_700_000_000_000 + index).toISOString(),
      type: draft.type,
      payload: draft.payload,
    }, index + 1, events.at(-1)?.eventSha256 ?? ARENA_MANIFEST_GENESIS_SHA256));
  }
  return events;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
