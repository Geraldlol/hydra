import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  createArenaReveal,
  createArenaSynthesisRequest,
  createArenaWinnerSelection,
  renderArenaRevealMarkdown,
} from "../src/arenaProduct";
import type {
  ArenaContestantFinishedPayload,
  ArenaEvidencePreservedPayload,
  ArenaManifestEvent,
  ArenaManifestReplay,
  ArenaRunFinalizedPayload,
  ArenaVerificationRecordedPayload,
} from "../src/arenaRunManifest";

const TIME = "2026-08-24T12:00:00.000Z";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function event(
  sequence: number,
  type: ArenaManifestEvent["type"],
  payload: ArenaManifestEvent["payload"],
): ArenaManifestEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    runId: "run-one",
    sequence,
    occurredAt: TIME,
    type,
    payload,
    previousEventSha256: digest(`previous-${sequence}`),
    eventSha256: digest(`event-${sequence}`),
  };
}

function evidence(contestantId: string): ArenaManifestEvent {
  return event(5, "arenaEvidencePreserved", {
    payloadType: "evidencePreserved",
    contestantId,
    artifactSetSha256: digest(`${contestantId}-artifacts`),
    receiptsRootSha256: digest(`${contestantId}-receipts`),
    patchSha256: digest(`${contestantId}-patch`),
    patchBytes: 42,
    untrackedArchiveSha256: null,
    untrackedArchiveBytes: 0,
    inventorySha256: digest(`${contestantId}-inventory`),
    quiescenceReceiptSha256: digest(`${contestantId}-quiescence`),
    quiescenceWorkspaceFingerprintSha256: digest(`${contestantId}-workspace`),
    finalHead: { objectFormat: "sha1", oid: "a".repeat(40) },
    finalWorkspaceFingerprintSha256: digest(`${contestantId}-workspace`),
  } satisfies ArenaEvidencePreservedPayload);
}

function replay(
  comparison: ArenaRunFinalizedPayload["comparison"] = "comparable",
  firstHeadId = "codex",
): ArenaManifestReplay {
  const lock = {
    payloadType: "runLocked" as const,
    policy: "hydra-arena-v1" as const,
    mission: {
      missionId: "mission-one",
      revision: 2,
      documentSha256: digest("mission-document"),
      bindingSha256: digest("mission-binding"),
    },
    base: {
      revision: { objectFormat: "sha1" as const, oid: "a".repeat(40) },
      repositoryIdentitySha256: digest("repository"),
      baseContentSha256: digest("base"),
      sourceWorkspaceFingerprintSha256: digest("source"),
      repositoryControlSha256: digest("registry"),
    },
    inputBundleSha256: digest("input"),
    preparationPlanSha256: null,
    environmentPolicySha256: digest("environment"),
    budgetSha256: digest("budget"),
    verificationChecks: [{
      checkId: "unit",
      planSha256: digest("unit-plan"),
    }],
    browserJourneys: [],
    contestants: [
      {
        contestantId: "contestant-codex",
        headId: firstHeadId,
        agentKind: "codex",
        headConfigSha256: digest("codex-config"),
        authoritySha256: digest("codex-authority"),
        invocationSha256: digest("codex-invocation"),
        worktreeId: "worktree-codex",
      },
      {
        contestantId: "contestant-claude",
        headId: "claude",
        agentKind: "claude",
        headConfigSha256: digest("claude-config"),
        authoritySha256: digest("claude-authority"),
        invocationSha256: digest("claude-invocation"),
        worktreeId: "worktree-claude",
      },
    ],
    steering: "disabled" as const,
    confirmation: {
      actorId: "local-user" as const,
      action: "Confirm Arena Run" as const,
      confirmationId: "confirm-run",
    },
  };
  const lockEvent = event(1, "arenaRunLocked", lock);
  const codexFinished = event(2, "arenaContestantFinished", {
    payloadType: "contestantFinished",
    contestantId: "contestant-codex",
    stage: "execution",
    traceId: "trace-codex",
    status: "succeeded",
    failureCode: null,
    finalHead: lock.base.revision,
    finalWorkspaceFingerprintSha256: digest("contestant-codex-workspace"),
    outputSha256: digest("codex-output"),
    outputBytes: 12,
  });
  const codexVerification = event(3, "arenaVerificationRecorded", {
    payloadType: "verificationRecorded",
    contestantId: "contestant-codex",
    checkId: "unit",
    attempt: 1,
    planSha256: digest("unit-plan"),
    status: "passed",
    receiptSha256: digest("codex-verification"),
    head: lock.base.revision,
    workspaceFingerprintSha256: digest("contestant-codex-workspace"),
  });
  const codexEvidence = evidence("contestant-codex");
  const claudeFinished = event(6, "arenaContestantFinished", {
    ...(codexFinished.payload as ArenaContestantFinishedPayload),
    contestantId: "contestant-claude",
    traceId: "trace-claude",
    finalWorkspaceFingerprintSha256: digest("contestant-claude-workspace"),
    outputSha256: digest("claude-output"),
  });
  const claudeVerification = event(7, "arenaVerificationRecorded", {
    ...(codexVerification.payload as ArenaVerificationRecordedPayload),
    contestantId: "contestant-claude",
    receiptSha256: digest("claude-verification"),
    workspaceFingerprintSha256: digest("contestant-claude-workspace"),
  });
  const claudeEvidence = {
    ...evidence("contestant-claude"),
    eventId: "event-8",
    sequence: 8,
    eventSha256: digest("event-8"),
  };
  const finalization = event(9, "arenaRunFinalized", {
    payloadType: "runFinalized",
    outcome: "completed",
    comparison,
    reasonCode: comparison === "comparable" ? null : "mainWorkspaceChanged",
    evidenceMatrixSha256: digest("matrix"),
  });
  return {
    runId: "run-one",
    records: [
      lockEvent,
      codexFinished,
      codexVerification,
      codexEvidence,
      claudeFinished,
      claudeVerification,
      claudeEvidence,
      finalization,
    ],
    lock,
    state: "finalized",
    contestants: [
      {
        lock: lock.contestants[0]!,
        started: event(10, "arenaContestantStarted", {
          payloadType: "contestantStarted",
          contestantId: "contestant-codex",
          traceId: "trace-codex",
          inputBundleSha256: lock.inputBundleSha256,
          environmentPolicySha256: lock.environmentPolicySha256,
          budgetSha256: lock.budgetSha256,
          promptSha256: digest("codex-prompt"),
          contextSha256: digest("codex-context"),
          invocationSha256: lock.contestants[0]!.invocationSha256,
          authoritySha256: lock.contestants[0]!.authoritySha256,
          preparedFingerprintSha256: digest("prepared"),
          steering: "disabled",
        }),
        finished: codexFinished,
        verifications: [{ checkId: "unit", attempts: [codexVerification] }],
        browserJourneys: [],
        evidencePreserved: codexEvidence,
        cleanup: {
          contestantId: "contestant-codex",
          cleanupId: null,
          status: "notStarted",
          records: [],
          completedSteps: [],
          nextStep: "quiesceProcesses",
          nextAttempt: 1,
          blockedFailureCode: null,
        },
      },
      {
        lock: lock.contestants[1]!,
        started: event(11, "arenaContestantStarted", {
          payloadType: "contestantStarted",
          contestantId: "contestant-claude",
          traceId: "trace-claude",
          inputBundleSha256: lock.inputBundleSha256,
          environmentPolicySha256: lock.environmentPolicySha256,
          budgetSha256: lock.budgetSha256,
          promptSha256: digest("claude-prompt"),
          contextSha256: digest("claude-context"),
          invocationSha256: lock.contestants[1]!.invocationSha256,
          authoritySha256: lock.contestants[1]!.authoritySha256,
          preparedFingerprintSha256: digest("prepared"),
          steering: "disabled",
        }),
        finished: claudeFinished,
        verifications: [{ checkId: "unit", attempts: [claudeVerification] }],
        browserJourneys: [],
        evidencePreserved: claudeEvidence,
        cleanup: {
          contestantId: "contestant-claude",
          cleanupId: null,
          status: "notStarted",
          records: [],
          completedSteps: [],
          nextStep: "quiesceProcesses",
          nextAttempt: 1,
          blockedFailureCode: null,
        },
      },
    ],
    mainWorkspaceObservations: [],
    compromised: comparison === "compromised",
    compromiseReasons: comparison === "compromised" ? ["watcherChanged"] : [],
    finalization,
    promotionEligible: comparison === "comparable",
    latestEventSha256: finalization.eventSha256,
  };
}

describe("Arena result reveal", () => {
  test("reveals every contestant together and binds immutable evidence", () => {
    const reveal = createArenaReveal(replay());

    assert.equal(reveal.runId, "run-one");
    assert.equal(reveal.comparison, "comparable");
    assert.deepEqual(reveal.contestants.map((row) => row.headId), ["codex", "claude"]);
    assert.deepEqual(reveal.contestants.map((row) => row.latestVerificationStatus), [
      "passed",
      "passed",
    ]);
    assert.match(reveal.revealSha256, /^[a-f0-9]{64}$/u);
    assert.equal(reveal.contestants[0]?.artifactSetSha256, digest("contestant-codex-artifacts"));

    const markdown = renderArenaRevealMarkdown(reveal);
    assert.match(markdown, /\| Codex \| succeeded \| passed \|/u);
    assert.match(markdown, /Evidence matrix: `[^`]+`/u);
    assert.doesNotMatch(markdown, /worktree-codex/u);
  });

  test("escapes backslashes before pipes in rendered head labels", () => {
    const reveal = createArenaReveal(replay("comparable", "codex\\|review"));
    const markdown = renderArenaRevealMarkdown(reveal);

    assert.ok(markdown.includes(String.raw`| Codex\\\|review |`));
  });

  test("records winner selection as preference without granting promotion authority", () => {
    const reveal = createArenaReveal(replay());
    const selection = createArenaWinnerSelection({
      reveal,
      contestantId: "contestant-codex",
      selectionId: "selection-one",
      occurredAt: TIME,
    });

    assert.equal(selection.actorId, "local-user");
    assert.equal(selection.authorityGranted, false);
    assert.equal(selection.artifactSetSha256, digest("contestant-codex-artifacts"));
    assert.match(selection.selectionSha256, /^[a-f0-9]{64}$/u);
    assert.throws(
      () => createArenaWinnerSelection({
        reveal,
        contestantId: "missing",
        selectionId: "selection-two",
        occurredAt: TIME,
      }),
      /not part of the revealed run/u,
    );
  });

  test("requests synthesis as a new isolated run over exact revealed sources", () => {
    const reveal = createArenaReveal(replay("compromised"));
    const request = createArenaSynthesisRequest({
      reveal,
      contestantIds: ["contestant-claude", "contestant-codex"],
      requestId: "synthesis-one",
      occurredAt: TIME,
    });

    assert.equal(request.isolatedRunRequired, true);
    assert.equal(request.mutatesSourceWorkspace, false);
    assert.deepEqual(request.sources.map((source) => source.contestantId), [
      "contestant-codex",
      "contestant-claude",
    ]);
    assert.match(request.synthesisRequestSha256, /^[a-f0-9]{64}$/u);
  });
});
