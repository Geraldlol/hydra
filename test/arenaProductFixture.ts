import { createHash } from "node:crypto";
import type {
  ArenaEvidencePreservedPayload,
  ArenaManifestEvent,
  ArenaManifestReplay,
  ArenaRunFinalizedPayload,
} from "../src/arenaRunManifest";

export const ARENA_FIXTURE_TIME = "2026-08-24T12:00:00.000Z";

export function arenaFixtureDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fixtureEvent(
  sequence: number,
  type: ArenaManifestEvent["type"],
  payload: ArenaManifestEvent["payload"],
): ArenaManifestEvent {
  return {
    schemaVersion: 1,
    eventId: `fixture-${sequence}`,
    runId: "run-one",
    sequence,
    occurredAt: ARENA_FIXTURE_TIME,
    type,
    payload,
    previousEventSha256: arenaFixtureDigest(`previous-${sequence}`),
    eventSha256: arenaFixtureDigest(`fixture-${sequence}`),
  };
}

export function arenaProductReplayFixture(
  comparison: ArenaRunFinalizedPayload["comparison"] = "comparable",
  state: ArenaManifestReplay["state"] = "cleanupComplete",
): ArenaManifestReplay {
  const revision = { objectFormat: "sha1" as const, oid: "a".repeat(40) };
  const contestants = ["codex", "claude"].map((headId) => ({
    contestantId: `contestant-${headId}`,
    headId,
    agentKind: headId,
    headConfigSha256: arenaFixtureDigest(`${headId}-config`),
    authoritySha256: arenaFixtureDigest(`${headId}-authority`),
    invocationSha256: arenaFixtureDigest(`${headId}-invocation`),
    worktreeId: `worktree-${headId}`,
  }));
  const lock = {
    payloadType: "runLocked" as const,
    policy: "hydra-arena-v1" as const,
    mission: {
      missionId: "mission-one",
      revision: 2,
      documentSha256: arenaFixtureDigest("mission-document"),
      bindingSha256: arenaFixtureDigest("mission-binding"),
    },
    base: {
      revision,
      repositoryIdentitySha256: arenaFixtureDigest("repository"),
      baseContentSha256: arenaFixtureDigest("base"),
      sourceWorkspaceFingerprintSha256: arenaFixtureDigest("source"),
      repositoryControlSha256: arenaFixtureDigest("registry"),
    },
    inputBundleSha256: arenaFixtureDigest("input"),
    preparationPlanSha256: null,
    environmentPolicySha256: arenaFixtureDigest("environment"),
    budgetSha256: arenaFixtureDigest("budget"),
    verificationChecks: [],
    browserJourneys: [],
    contestants,
    steering: "disabled" as const,
    confirmation: {
      actorId: "local-user" as const,
      action: "Confirm Arena Run" as const,
      confirmationId: "confirm-run",
    },
  };
  const lockEvent = fixtureEvent(1, "arenaRunLocked", lock);
  const contestantReplays = contestants.map((contestant, index) => {
    const finished = fixtureEvent(2 + index * 2, "arenaContestantFinished", {
      payloadType: "contestantFinished",
      contestantId: contestant.contestantId,
      stage: "execution",
      traceId: `trace-${contestant.headId}`,
      status: "succeeded",
      failureCode: null,
      finalHead: revision,
      finalWorkspaceFingerprintSha256:
        arenaFixtureDigest(`${contestant.contestantId}-workspace`),
      outputSha256: arenaFixtureDigest(`${contestant.contestantId}-output`),
      outputBytes: 12,
    });
    const evidencePayload: ArenaEvidencePreservedPayload = {
      payloadType: "evidencePreserved",
      contestantId: contestant.contestantId,
      artifactSetSha256: arenaFixtureDigest(`${contestant.contestantId}-artifacts`),
      receiptsRootSha256: arenaFixtureDigest(`${contestant.contestantId}-receipts`),
      patchSha256: arenaFixtureDigest(`${contestant.contestantId}-patch`),
      patchBytes: 42,
      untrackedArchiveSha256: null,
      untrackedArchiveBytes: 0,
      inventorySha256: arenaFixtureDigest(`${contestant.contestantId}-inventory`),
      quiescenceReceiptSha256:
        arenaFixtureDigest(`${contestant.contestantId}-quiescence`),
      quiescenceWorkspaceFingerprintSha256:
        arenaFixtureDigest(`${contestant.contestantId}-workspace`),
      finalHead: revision,
      finalWorkspaceFingerprintSha256:
        arenaFixtureDigest(`${contestant.contestantId}-workspace`),
    };
    const evidence = fixtureEvent(
      3 + index * 2,
      "arenaEvidencePreserved",
      evidencePayload,
    );
    return {
      replay: {
        lock: contestant,
        finished,
        verifications: [],
        browserJourneys: [],
        evidencePreserved: evidence,
        cleanup: {
          contestantId: contestant.contestantId,
          cleanupId: state === "cleanupComplete" ? `cleanup-${contestant.headId}` : null,
          status: state === "cleanupComplete" ? "complete" as const : "notStarted" as const,
          records: [],
          completedSteps: state === "cleanupComplete"
            ? [
                "quiesceProcesses" as const,
                "verifyTarget" as const,
                "unlockGitWorktree" as const,
                "removeGitWorktree" as const,
                "verifyGitRegistrationGone" as const,
                "removeResidualDirectory" as const,
              ]
            : [],
          nextStep: state === "cleanupComplete" ? null : "quiesceProcesses" as const,
          nextAttempt: state === "cleanupComplete" ? null : 1,
          blockedFailureCode: null,
        },
      },
      finished,
      evidence,
    };
  });
  const finalization = fixtureEvent(6, "arenaRunFinalized", {
    payloadType: "runFinalized",
    outcome: "completed",
    comparison,
    reasonCode: comparison === "comparable" ? null : "mainWorkspaceChanged",
    evidenceMatrixSha256: arenaFixtureDigest("matrix"),
  });
  const records = [
    lockEvent,
    ...contestantReplays.flatMap((contestant) => [
      contestant.finished,
      contestant.evidence,
    ]),
    finalization,
  ];
  return {
    runId: "run-one",
    records,
    lock,
    state,
    contestants: contestantReplays.map((contestant) => contestant.replay),
    mainWorkspaceObservations: [],
    compromised: comparison === "compromised",
    compromiseReasons: comparison === "compromised" ? ["watcherChanged"] : [],
    finalization,
    promotionEligible: comparison === "comparable",
    latestEventSha256: finalization.eventSha256,
  };
}
