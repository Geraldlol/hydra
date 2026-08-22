import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  ARENA_MANIFEST_GENESIS_SHA256,
  ARENA_MANIFEST_LIMITS,
  ARENA_MANIFEST_SCHEMA_VERSION,
  ARENA_POLICY_ID,
  ArenaManifestValidationError,
  arenaArtifactSetSha256,
  arenaEvidenceMatrixSha256,
  arenaReceiptsRootSha256,
  canonicalArenaManifestJson,
  computeArenaManifestEventSha256,
  createArenaManifestEvent,
  isArenaManifestEvent,
  parseArenaManifestEvent,
  replayArenaManifest,
  validateArenaManifestEvents,
  type ArenaBrowserJourneyRecordedPayload,
  type ArenaContestantFinishedPayload,
  type ArenaContestantStartedPayload,
  type ArenaEvidencePreservedPayload,
  type ArenaGitObjectId,
  type ArenaMainWorkspaceObservedPayload,
  type ArenaManifestEvent,
  type ArenaManifestEventDraft,
  type ArenaManifestEventType,
  type ArenaManifestPayload,
  type ArenaRunFinalizedPayload,
  type ArenaRunLockedPayload,
  type ArenaPreparationStatus,
  type ArenaVerificationRecordedPayload,
  type ArenaWorktreeRegisteredPayload,
  type ArenaWorktreeProvisionedPayload,
} from "../src/arenaRunManifest";
import {
  ARENA_CLEANUP_STEPS,
  arenaCleanupPostconditionSha256,
  arenaCleanupStepReceiptSha256,
  type ArenaCleanupOutcome,
  type ArenaCleanupPostcondition,
  type ArenaCleanupStep,
  type ArenaCleanupStepPayload,
} from "../src/arenaCleanup";

const TIME = "2026-07-24T21:00:00.000Z";
const BASE: ArenaGitObjectId = {
  objectFormat: "sha1",
  oid: "a".repeat(40),
};

type DeepMutable<T> = {
  -readonly [Key in keyof T]: DeepMutable<T[Key]>;
};

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function evidenceFixture(
  payload: Omit<ArenaEvidencePreservedPayload, "artifactSetSha256">,
): ArenaEvidencePreservedPayload {
  return {
    ...payload,
    artifactSetSha256: arenaArtifactSetSha256(payload),
  };
}

function lockFixture(
  options: {
    base?: ArenaGitObjectId;
    preparationPlanSha256?: string | null;
    browserJourneys?: ArenaRunLockedPayload["browserJourneys"];
    verificationChecks?: ArenaRunLockedPayload["verificationChecks"];
  } = {},
): ArenaRunLockedPayload {
  return {
    payloadType: "runLocked",
    policy: ARENA_POLICY_ID,
    mission: {
      missionId: "mission-arena",
      revision: 3,
      documentSha256: digest("mission-document"),
      bindingSha256: digest("mission-binding"),
    },
    base: {
      revision: options.base ?? BASE,
      repositoryIdentitySha256: digest("repository"),
      baseContentSha256: digest("base-content"),
      sourceWorkspaceFingerprintSha256: digest("main-workspace"),
      repositoryControlSha256: digest("repository-controls"),
    },
    inputBundleSha256: digest("identical-input"),
    preparationPlanSha256: options.preparationPlanSha256 ?? null,
    environmentPolicySha256: digest("environment-policy"),
    budgetSha256: digest("budget"),
    verificationChecks: options.verificationChecks ?? [{
      checkId: "check-test",
      planSha256: digest("verification-plan"),
    }],
    browserJourneys: options.browserJourneys ?? [{
      journeyId: "journey-smoke",
      planSha256: digest("browser-plan"),
    }],
    contestants: [
      {
        contestantId: "contestant-codex",
        headId: "codex",
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
    steering: "disabled",
    confirmation: {
      actorId: "local-user",
      action: "Confirm Arena Run",
      confirmationId: "confirmation-arena",
    },
  };
}

class ManifestBuilder {
  readonly records: ArenaManifestEvent[] = [];

  constructor(
    readonly lock: ArenaRunLockedPayload = lockFixture(),
    readonly runId = "arena-run-one",
  ) {
    this.append("arenaRunLocked", lock, "event-lock");
  }

  append(
    type: ArenaManifestEventType,
    payload: ArenaManifestPayload,
    eventId = `event-${this.records.length + 1}`,
    runId = this.runId,
  ): ArenaManifestEvent {
    const event = createArenaManifestEvent({
      eventId,
      runId,
      occurredAt: TIME,
      type,
      payload,
    }, this.records.length + 1, this.records.at(-1)?.eventSha256
      ?? ARENA_MANIFEST_GENESIS_SHA256);
    this.records.push(event);
    return event;
  }
}

interface CompletedContestant {
  prepared: ArenaManifestEvent;
  started: ArenaManifestEvent;
  finished: ArenaManifestEvent;
  verification: ArenaManifestEvent[];
  browser: ArenaManifestEvent[];
  evidence: ArenaManifestEvent;
}

const MONITOR_EPOCH_ID = "monitor-arena-one";

function ensureMonitorStarted(builder: ManifestBuilder): ArenaManifestEvent {
  const existing = builder.records.find((event) =>
    event.type === "arenaMainWorkspaceObserved"
    && (event.payload as ArenaMainWorkspaceObservedPayload).observationKind
      === "monitorStarted");
  if (existing) return existing;
  return appendUnchangedObservation(builder, "monitorStarted");
}

function ensureAllWorktreesPrepared(
  builder: ManifestBuilder,
  options: {
    readonly preparationStatusByContestant?: Readonly<
      Record<string, ArenaPreparationStatus>
    >;
  } = {},
): ReadonlyMap<string, ArenaManifestEvent> {
  ensureMonitorStarted(builder);
  const registered = new Map(
    builder.records
      .filter((event) => event.type === "arenaWorktreeRegistered")
      .map((event) => [
        (event.payload as ArenaWorktreeRegisteredPayload).contestantId,
        event,
      ]),
  );
  for (const contestant of builder.lock.contestants) {
    if (registered.has(contestant.contestantId)) continue;
    const payload: ArenaWorktreeRegisteredPayload = {
      payloadType: "worktreeRegistered",
      contestantId: contestant.contestantId,
      worktreeId: contestant.worktreeId,
      baseRevision: builder.lock.base.revision,
      registrationSha256: digest(`registration-${contestant.contestantId}`),
      initialFingerprintSha256: builder.lock.base.baseContentSha256,
    };
    registered.set(
      contestant.contestantId,
      builder.append(
        "arenaWorktreeRegistered",
        payload,
        `event-registered-${contestant.contestantId}`,
      ),
    );
  }
  const existing = new Map(
    builder.records
      .filter((event) => event.type === "arenaWorktreeProvisioned")
      .map((event) => [
        (event.payload as ArenaWorktreeProvisionedPayload).contestantId,
        event,
      ]),
  );
  const preparedFingerprintSha256 = builder.lock.preparationPlanSha256
    ? digest("prepared-shared")
    : builder.lock.base.baseContentSha256;
  for (const contestant of builder.lock.contestants) {
    if (existing.has(contestant.contestantId)) continue;
    const payload: ArenaWorktreeProvisionedPayload = {
      payloadType: "worktreeProvisioned",
      contestantId: contestant.contestantId,
      worktreeId: contestant.worktreeId,
      baseRevision: builder.lock.base.revision,
      registrationSha256: (
        registered.get(contestant.contestantId)!
          .payload as ArenaWorktreeRegisteredPayload
      ).registrationSha256,
      initialFingerprintSha256: builder.lock.base.baseContentSha256,
      preparationPlanSha256: builder.lock.preparationPlanSha256,
      preparationStatus:
        options.preparationStatusByContestant?.[contestant.contestantId]
        ?? "succeeded",
      preparationReceiptSha256: builder.lock.preparationPlanSha256
        ? digest(`preparation-receipt-${contestant.contestantId}`)
        : null,
      preparedFingerprintSha256,
    };
    existing.set(
      contestant.contestantId,
      builder.append(
        "arenaWorktreeProvisioned",
        payload,
        `event-prepared-${contestant.contestantId}`,
      ),
    );
  }
  return existing;
}

function completeContestant(
  builder: ManifestBuilder,
  contestantId: string,
  options: {
    finalHead?: ArenaGitObjectId;
    verificationFingerprint?: string;
    browserFingerprint?: string;
    evidenceFingerprint?: string;
  } = {},
): CompletedContestant {
  const contestant = builder.lock.contestants.find((candidate) =>
    candidate.contestantId === contestantId)!;
  const candidateFingerprint = digest(`candidate-${contestantId}`);
  const prepared = ensureAllWorktreesPrepared(builder).get(contestantId)!;
  const preparedFingerprint = (prepared.payload as ArenaWorktreeProvisionedPayload)
    .preparedFingerprintSha256;
  const started = builder.append("arenaContestantStarted", {
    payloadType: "contestantStarted",
    contestantId,
    traceId: `trace-${contestantId}`,
    inputBundleSha256: builder.lock.inputBundleSha256,
    environmentPolicySha256: builder.lock.environmentPolicySha256,
    budgetSha256: builder.lock.budgetSha256,
    promptSha256: digest(`prompt-${contestantId}`),
    contextSha256: digest("identical-context"),
    invocationSha256: contestant.invocationSha256,
    authoritySha256: contestant.authoritySha256,
    preparedFingerprintSha256: preparedFingerprint,
    steering: "disabled",
  }, `event-started-${contestantId}`);
  const finalHead = options.finalHead ?? builder.lock.base.revision;
  const finishedPayload: ArenaContestantFinishedPayload = {
    payloadType: "contestantFinished",
    contestantId,
    stage: "execution",
    traceId: `trace-${contestantId}`,
    status: "succeeded",
    failureCode: null,
    finalHead,
    finalWorkspaceFingerprintSha256: candidateFingerprint,
    outputSha256: digest(`output-${contestantId}`),
    outputBytes: 100,
  };
  const finished = builder.append(
    "arenaContestantFinished",
    finishedPayload,
    `event-finished-${contestantId}`,
  );

  const verification = builder.lock.verificationChecks.map((check) => {
    const payload: ArenaVerificationRecordedPayload = {
      payloadType: "verificationRecorded",
      contestantId,
      checkId: check.checkId,
      attempt: 1,
      planSha256: check.planSha256,
      status: "passed",
      receiptSha256: digest(`verification-${contestantId}-${check.checkId}`),
      head: finalHead,
      workspaceFingerprintSha256: options.verificationFingerprint ?? candidateFingerprint,
    };
    return builder.append(
      "arenaVerificationRecorded",
      payload,
      `event-verification-${contestantId}-${check.checkId}`,
    );
  });
  const browser = builder.lock.browserJourneys.map((journey) => {
    const payload: ArenaBrowserJourneyRecordedPayload = {
      payloadType: "browserJourneyRecorded",
      contestantId,
      journeyId: journey.journeyId,
      attempt: 1,
      planSha256: journey.planSha256,
      status: "passed",
      receiptSha256: digest(`browser-${contestantId}-${journey.journeyId}`),
      head: finalHead,
      workspaceFingerprintSha256: options.browserFingerprint ?? candidateFingerprint,
    };
    return builder.append(
      "arenaBrowserJourneyRecorded",
      payload,
      `event-browser-${contestantId}-${journey.journeyId}`,
    );
  });
  const receiptsRootSha256 = arenaReceiptsRootSha256({
    finished,
    verifications: new Map(builder.lock.verificationChecks.map((check) => [
      check.checkId,
      verification.filter((event) =>
        (event.payload as ArenaVerificationRecordedPayload).checkId === check.checkId),
    ])),
    browserJourneys: new Map(builder.lock.browserJourneys.map((journey) => [
      journey.journeyId,
      browser.filter((event) =>
        (event.payload as ArenaBrowserJourneyRecordedPayload).journeyId === journey.journeyId),
    ])),
  });
  const evidencePayload = evidenceFixture({
    payloadType: "evidencePreserved",
    contestantId,
    receiptsRootSha256,
    patchSha256: digest(`patch-${contestantId}`),
    patchBytes: 42,
    untrackedArchiveSha256: null,
    untrackedArchiveBytes: 0,
    inventorySha256: digest(`inventory-${contestantId}`),
    quiescenceReceiptSha256: digest(`quiescence-${contestantId}`),
    quiescenceWorkspaceFingerprintSha256:
      options.evidenceFingerprint ?? candidateFingerprint,
    finalHead,
    finalWorkspaceFingerprintSha256: options.evidenceFingerprint ?? candidateFingerprint,
  });
  const evidence = builder.append(
    "arenaEvidencePreserved",
    evidencePayload,
    `event-evidence-${contestantId}`,
  );
  return { prepared, started, finished, verification, browser, evidence };
}

function appendUnchangedObservation(
  builder: ManifestBuilder,
  observationKind: ArenaMainWorkspaceObservedPayload["observationKind"] = "postEvidence",
): ArenaManifestEvent {
  const payload: ArenaMainWorkspaceObservedPayload = {
    payloadType: "mainWorkspaceObserved",
    observationKind,
    monitorEpochId: MONITOR_EPOCH_ID,
    monitorReceiptSha256: digest(
      `monitor-${observationKind}-${builder.records.length + 1}`,
    ),
    status: "unchanged",
    sourceWorkspaceFingerprintSha256:
      builder.lock.base.sourceWorkspaceFingerprintSha256,
    repositoryControlSha256: builder.lock.base.repositoryControlSha256,
    head: builder.lock.base.revision,
    watcherChanged: false,
    reasonCode: null,
  };
  return builder.append(
    "arenaMainWorkspaceObserved",
    payload,
    `event-main-${builder.records.length + 1}`,
  );
}

function contestantStartedPayload(
  builder: ManifestBuilder,
  contestantId: string,
  overrides: Partial<ArenaContestantStartedPayload> = {},
): ArenaContestantStartedPayload {
  const contestant = builder.lock.contestants.find((candidate) =>
    candidate.contestantId === contestantId)!;
  const prepared = builder.records.find((event) =>
    event.type === "arenaWorktreeProvisioned"
    && (event.payload as ArenaWorktreeProvisionedPayload).contestantId === contestantId);
  const preparedFingerprintSha256 = prepared
    ? (prepared.payload as ArenaWorktreeProvisionedPayload).preparedFingerprintSha256
    : builder.lock.base.baseContentSha256;
  return {
    payloadType: "contestantStarted",
    contestantId,
    traceId: `trace-${contestantId}`,
    inputBundleSha256: builder.lock.inputBundleSha256,
    environmentPolicySha256: builder.lock.environmentPolicySha256,
    budgetSha256: builder.lock.budgetSha256,
    promptSha256: digest(`prompt-${contestantId}`),
    contextSha256: digest("identical-context"),
    invocationSha256: contestant.invocationSha256,
    authoritySha256: contestant.authoritySha256,
    preparedFingerprintSha256,
    steering: "disabled",
    ...overrides,
  };
}

function evidenceMatrixForBuilder(
  builder: ManifestBuilder,
  postEvidenceObservation: ArenaManifestEvent,
): string {
  return arenaEvidenceMatrixSha256({
    lockEventSha256: builder.records[0]!.eventSha256,
    postEvidenceEventSha256: postEvidenceObservation.eventSha256,
    contestants: builder.lock.contestants.map((contestant) => ({
      contestantId: contestant.contestantId,
      finishedEventSha256: builder.records.find((event) =>
        event.type === "arenaContestantFinished"
        && (event.payload as ArenaContestantFinishedPayload).contestantId
          === contestant.contestantId)!.eventSha256,
      verificationEventSha256s: builder.lock.verificationChecks.flatMap((check) =>
        builder.records.filter((event) =>
          event.type === "arenaVerificationRecorded"
          && (event.payload as ArenaVerificationRecordedPayload).contestantId
            === contestant.contestantId
          && (event.payload as ArenaVerificationRecordedPayload).checkId
            === check.checkId)
          .map((event) => event.eventSha256)),
      browserJourneyEventSha256s: builder.lock.browserJourneys.flatMap((journey) =>
        builder.records.filter((event) =>
          event.type === "arenaBrowserJourneyRecorded"
          && (event.payload as ArenaBrowserJourneyRecordedPayload).contestantId
            === contestant.contestantId
          && (event.payload as ArenaBrowserJourneyRecordedPayload).journeyId
            === journey.journeyId)
          .map((event) => event.eventSha256)),
      evidenceEventSha256: builder.records.find((event) =>
        event.type === "arenaEvidencePreserved"
        && (event.payload as ArenaEvidencePreservedPayload).contestantId
          === contestant.contestantId)!.eventSha256,
    })),
  });
}

function completeComparableRun(builder = new ManifestBuilder()): ManifestBuilder {
  for (const contestant of builder.lock.contestants) {
    completeContestant(builder, contestant.contestantId);
  }
  const postEvidenceObservation = appendUnchangedObservation(builder);
  const finalized: ArenaRunFinalizedPayload = {
    payloadType: "runFinalized",
    outcome: "completed",
    comparison: "comparable",
    reasonCode: null,
    evidenceMatrixSha256: evidenceMatrixForBuilder(builder, postEvidenceObservation),
  };
  builder.append("arenaRunFinalized", finalized, "event-finalized");
  return builder;
}

function cleanupPayload(
  builder: ManifestBuilder,
  contestantId: string,
  step: ArenaCleanupStep,
  overrides: {
    attempt?: number;
    outcome?: ArenaCleanupOutcome;
    cleanupId?: string;
  } = {},
): ArenaCleanupStepPayload {
  const registration = builder.records.find((event) =>
    event.type === "arenaWorktreeRegistered"
    && (event.payload as ArenaWorktreeRegisteredPayload).contestantId
      === contestantId);
  const evidence = builder.records.find((event) =>
    event.type === "arenaEvidencePreserved"
    && (event.payload as ArenaEvidencePreservedPayload).contestantId
      === contestantId);
  const postcondition = cleanupPostcondition(step);
  const draft = {
    payloadType: "cleanupStepRecorded" as const,
    runId: builder.runId,
    cleanupId: overrides.cleanupId ?? `cleanup-${contestantId}`,
    contestantId,
    registrationSha256:
      registration
        ? (registration.payload as ArenaWorktreeRegisteredPayload)
          .registrationSha256
        : digest(`missing-registration-${contestantId}`),
    evidenceEventSha256:
      evidence?.eventSha256 ?? digest(`missing-evidence-${contestantId}`),
    step,
    attempt: overrides.attempt ?? 1,
    outcome: overrides.outcome ?? "succeeded",
    failureCode: null,
    retryDelayMs: null,
    postcondition,
    postconditionSha256: arenaCleanupPostconditionSha256(postcondition),
  };
  return {
    ...draft,
    stepReceiptSha256: arenaCleanupStepReceiptSha256(draft),
  };
}

function cleanupPostcondition(
  step: ArenaCleanupStep,
): ArenaCleanupPostcondition {
  const worktreePathSha256 = digest("cleanup-worktree-path");
  if (step === "quiesceProcesses") {
    return {
      kind: "processQuiescence",
      processOwnerSha256: digest("cleanup-process-owner"),
      terminationConfirmed: true,
      activeProcessCount: 0,
    };
  }
  if (step === "verifyTarget") {
    return {
      kind: "ownedTarget",
      worktreePathSha256,
      directoryIdentitySha256: digest("cleanup-directory"),
      gitRegistrationSha256: digest("cleanup-registration"),
    };
  }
  if (step === "unlockGitWorktree") {
    return {
      kind: "gitLockState",
      worktreePathSha256,
      gitRegistrationSha256: digest("cleanup-registration"),
      locked: false,
      registryEntrySha256: digest("cleanup-registry-entry"),
    };
  }
  if (step === "removeGitWorktree") {
    return { kind: "gitRemoval", worktreePathSha256, registryAbsent: true };
  }
  if (step === "verifyGitRegistrationGone") {
    return {
      kind: "gitRegistryAbsence",
      worktreePathSha256,
      registrySha256: digest("cleanup-registry"),
      absent: true,
    };
  }
  return { kind: "pathAbsence", worktreePathSha256, absent: true };
}

describe("Hydra Arena run manifest", () => {
  test("creates a canonical hash chain and replays a promotion-eligible run", () => {
    const builder = completeComparableRun();
    const replay = replayArenaManifest(builder.records);
    assert.equal(replay.runId, "arena-run-one");
    assert.equal(replay.state, "finalized");
    assert.equal(replay.compromised, false);
    assert.equal(replay.promotionEligible, true);
    assert.equal(replay.contestants.length, 2);
    assert.ok(replay.contestants.every((contestant) =>
      contestant.evidencePreserved !== undefined));
    assert.match(replay.latestEventSha256, /^[a-f0-9]{64}$/);
    assert.ok(Object.isFrozen(replay));
    assert.equal(builder.records[0]?.schemaVersion, ARENA_MANIFEST_SCHEMA_VERSION);
    assert.equal(builder.records[0]?.previousEventSha256, ARENA_MANIFEST_GENESIS_SHA256);
    assert.equal(
      builder.records[0]?.eventSha256,
      "0ba40ed46e8471490da0b14cee4b8c4b322a477db1ef6029a9910b8f459dac6d",
    );
  });

  test("rejects a forged or stale evidence matrix hash", () => {
    const builder = completeComparableRun();
    const forged = structuredClone(builder.records) as DeepMutable<ArenaManifestEvent>[];
    const finalized = forged.at(-1)!;
    assert.equal(finalized.type, "arenaRunFinalized");
    (finalized.payload as DeepMutable<ArenaRunFinalizedPayload>)
      .evidenceMatrixSha256 = digest("forged-matrix");
    assert.throws(
      () => replayArenaManifest(rechain(forged)),
      /does not bind the locked run and complete contestant evidence/,
    );
  });

  test("recomputes artifact-set hashes instead of trusting caller labels", () => {
    const builder = completeComparableRun();
    const forged = structuredClone(builder.records) as
      DeepMutable<ArenaManifestEvent>[];
    const evidence = forged.filter((event) =>
      event.type === "arenaEvidencePreserved").at(-1)!;
    (evidence.payload as DeepMutable<ArenaEvidencePreservedPayload>)
      .patchBytes += 1;
    assert.throws(
      () => replayArenaManifest(rechain(forged)),
      /does not bind the exact retained artifacts/,
    );
  });

  test("never classifies evidence without process-bound quiescence as comparable", () => {
    const builder = completeComparableRun();
    const forged = structuredClone(builder.records) as
      DeepMutable<ArenaManifestEvent>[];
    const evidence = forged.filter((event) =>
      event.type === "arenaEvidencePreserved").at(-1)!;
    const payload =
      evidence.payload as DeepMutable<ArenaEvidencePreservedPayload>;
    payload.quiescenceReceiptSha256 = null;
    payload.quiescenceWorkspaceFingerprintSha256 = null;
    payload.artifactSetSha256 = arenaArtifactSetSha256(payload);
    assert.throws(
      () => replayArenaManifest(rechain(forged)),
      /completed requires successful executions and durable complete evidence/,
    );
  });

  test("finishes cleanup only after every exact target completes every step", () => {
    const builder = completeComparableRun();
    for (const contestant of builder.lock.contestants) {
      for (const step of ARENA_CLEANUP_STEPS) {
        builder.append(
          "arenaCleanupStepRecorded",
          cleanupPayload(builder, contestant.contestantId, step),
          `event-cleanup-${contestant.contestantId}-${step}`,
        );
      }
    }
    const replay = replayArenaManifest(builder.records);
    assert.equal(replay.state, "cleanupComplete");
    assert.ok(replay.contestants.every((contestant) =>
      contestant.cleanup.status === "complete"));
    assert.equal(replay.promotionEligible, true);
  });

  test("accepts SHA-256 object repositories and rejects format/length ambiguity", () => {
    const sha256Base: ArenaGitObjectId = {
      objectFormat: "sha256",
      oid: "b".repeat(64),
    };
    const valid = new ManifestBuilder(lockFixture({ base: sha256Base }));
    assert.equal(replayArenaManifest(valid.records).lock.base.revision.oid, sha256Base.oid);

    const lock = structuredClone(lockFixture()) as DeepMutable<ArenaRunLockedPayload>;
    lock.base.revision = {
      objectFormat: "sha1",
      oid: "b".repeat(64),
    };
    assert.throws(() => new ManifestBuilder(lock), /must be 40/);
  });

  test("rejects unknown fields, duplicate heads/slots/plans, and non-canonical IDs", () => {
    const lock = structuredClone(lockFixture()) as ArenaRunLockedPayload & { surprise?: boolean };
    lock.surprise = true;
    assert.throws(() => new ManifestBuilder(lock), /unknown surprise/);

    const duplicateHead = structuredClone(lockFixture()) as DeepMutable<ArenaRunLockedPayload>;
    duplicateHead.contestants[1] = {
      ...duplicateHead.contestants[1]!,
      headId: duplicateHead.contestants[0]!.headId,
    };
    assert.throws(() => new ManifestBuilder(duplicateHead), /duplicate headId/);

    const duplicateWorktree = structuredClone(lockFixture()) as DeepMutable<ArenaRunLockedPayload>;
    duplicateWorktree.contestants[1] = {
      ...duplicateWorktree.contestants[1]!,
      worktreeId: duplicateWorktree.contestants[0]!.worktreeId,
    };
    assert.throws(() => new ManifestBuilder(duplicateWorktree), /duplicate worktreeId/);

    const duplicateCheck = structuredClone(lockFixture()) as DeepMutable<ArenaRunLockedPayload>;
    duplicateCheck.verificationChecks = [
      duplicateCheck.verificationChecks[0]!,
      duplicateCheck.verificationChecks[0]!,
    ];
    assert.throws(() => new ManifestBuilder(duplicateCheck), /duplicate checkId/);

    const invalidHead = structuredClone(lockFixture()) as DeepMutable<ArenaRunLockedPayload>;
    invalidHead.contestants[0] = {
      ...invalidHead.contestants[0]!,
      headId: "user",
    };
    assert.throws(() => new ManifestBuilder(invalidHead), /valid canonical Hydra agent id/);
  });

  test("binds sequence, previous hash, event hash, run ID, and unique event IDs", () => {
    const builder = completeComparableRun();
    const badSequence = structuredClone(builder.records) as DeepMutable<ArenaManifestEvent>[];
    badSequence[1]!.sequence = 99;
    assert.throws(() => replayArenaManifest(badSequence), /sequence.*must be 2/);

    const badPrevious = structuredClone(builder.records) as DeepMutable<ArenaManifestEvent>[];
    badPrevious[1]!.previousEventSha256 = digest("wrong previous");
    assert.throws(() => replayArenaManifest(badPrevious), /does not bind the previous/);

    const badHash = structuredClone(builder.records) as DeepMutable<ArenaManifestEvent>[];
    badHash[1]!.eventSha256 = digest("forged");
    assert.throws(() => replayArenaManifest(badHash), /does not match the canonical event/);

    const crossRun = new ManifestBuilder();
    crossRun.append(
      "arenaMainWorkspaceObserved",
      {
        payloadType: "mainWorkspaceObserved",
        observationKind: "monitorStarted",
        monitorEpochId: MONITOR_EPOCH_ID,
        monitorReceiptSha256: digest("cross-run-monitor"),
        status: "unchanged",
        sourceWorkspaceFingerprintSha256:
          crossRun.lock.base.sourceWorkspaceFingerprintSha256,
        repositoryControlSha256: crossRun.lock.base.repositoryControlSha256,
        head: crossRun.lock.base.revision,
        watcherChanged: false,
        reasonCode: null,
      },
      "event-other-run",
      "arena-run-other",
    );
    assert.throws(() => replayArenaManifest(crossRun.records), /crosses Arena run identities/);

    const duplicateId = new ManifestBuilder();
    duplicateId.append(
      "arenaMainWorkspaceObserved",
      {
        payloadType: "mainWorkspaceObserved",
        observationKind: "monitorStarted",
        monitorEpochId: MONITOR_EPOCH_ID,
        monitorReceiptSha256: digest("duplicate-id-monitor"),
        status: "unchanged",
        sourceWorkspaceFingerprintSha256:
          duplicateId.lock.base.sourceWorkspaceFingerprintSha256,
        repositoryControlSha256: duplicateId.lock.base.repositoryControlSha256,
        head: duplicateId.lock.base.revision,
        watcherChanged: false,
        reasonCode: null,
      },
      "event-lock",
    );
    assert.throws(() => replayArenaManifest(duplicateId.records), /duplicates event-lock/);
  });

  test("rejects forged unchanged observations and permanently latches real compromise", () => {
    const forged = new ManifestBuilder();
    forged.append("arenaMainWorkspaceObserved", {
      payloadType: "mainWorkspaceObserved",
      observationKind: "monitorStarted",
      monitorEpochId: MONITOR_EPOCH_ID,
      monitorReceiptSha256: digest("forged-monitor"),
      status: "unchanged",
      sourceWorkspaceFingerprintSha256: digest("changed"),
      repositoryControlSha256: forged.lock.base.repositoryControlSha256,
      head: forged.lock.base.revision,
      watcherChanged: false,
      reasonCode: null,
    }, "event-forged-unchanged");
    assert.throws(
      () => replayArenaManifest(forged.records),
      /claims unchanged while a locked source control differs/,
    );

    const compromised = new ManifestBuilder();
    for (const contestant of compromised.lock.contestants) {
      completeContestant(compromised, contestant.contestantId);
    }
    compromised.append("arenaMainWorkspaceObserved", {
      payloadType: "mainWorkspaceObserved",
      observationKind: "checkpoint",
      monitorEpochId: MONITOR_EPOCH_ID,
      monitorReceiptSha256: digest("changed-monitor"),
      status: "changed",
      sourceWorkspaceFingerprintSha256:
        compromised.lock.base.sourceWorkspaceFingerprintSha256,
      repositoryControlSha256: compromised.lock.base.repositoryControlSha256,
      head: compromised.lock.base.revision,
      watcherChanged: true,
      reasonCode: "watcherChanged",
    }, "event-main-changed");
    const postEvidenceObservation = appendUnchangedObservation(compromised);
    compromised.append("arenaRunFinalized", {
      payloadType: "runFinalized",
      outcome: "completed",
      comparison: "compromised",
      reasonCode: "mainWorkspaceChanged",
      evidenceMatrixSha256: evidenceMatrixForBuilder(
        compromised,
        postEvidenceObservation,
      ),
    }, "event-finalized");
    const replay = replayArenaManifest(compromised.records);
    assert.equal(replay.compromised, true);
    assert.deepEqual(replay.compromiseReasons, ["watcherChanged"]);
    assert.equal(replay.promotionEligible, false);
  });

  test("latches detached commits and verifier/browser state mutation immediately", () => {
    const detached = new ManifestBuilder();
    const detachedComplete = completeContestant(detached, "contestant-codex", {
      finalHead: { objectFormat: "sha1", oid: "b".repeat(40) },
    });
    const throughDetachedFinish = rechain(detached.records.slice(
      0,
      detached.records.indexOf(detachedComplete.finished) + 1,
    ));
    assert.deepEqual(
      replayArenaManifest(throughDetachedFinish).compromiseReasons,
      ["contestantHeadChanged"],
    );
    const throughDetachedVerification = rechain(detached.records.slice(
      0,
      detached.records.indexOf(detachedComplete.verification[0]!) + 1,
    ));
    assert.throws(
      () => replayArenaManifest(throughDetachedVerification),
      /cannot verify after a control compromise is latched/,
    );

    const mutated = new ManifestBuilder();
    const mutationComplete = completeContestant(mutated, "contestant-codex");
    const verificationIndex = mutated.records.indexOf(mutationComplete.verification[0]!);
    const throughVerification = structuredClone(
      mutated.records.slice(0, verificationIndex + 1),
    ) as DeepMutable<ArenaManifestEvent>[];
    (throughVerification.at(-1)!.payload as DeepMutable<ArenaVerificationRecordedPayload>)
      .workspaceFingerprintSha256 = digest("verifier-mutated");
    assert.deepEqual(
      replayArenaManifest(rechain(throughVerification)).compromiseReasons,
      ["verificationMutatedWorkspace"],
    );

    const browserIndex = mutated.records.indexOf(mutationComplete.browser[0]!);
    const throughBrowser = structuredClone(
      mutated.records.slice(0, browserIndex + 1),
    ) as DeepMutable<ArenaManifestEvent>[];
    (throughBrowser.at(-1)!.payload as DeepMutable<ArenaBrowserJourneyRecordedPayload>)
      .workspaceFingerprintSha256 = digest("browser-mutated");
    assert.deepEqual(
      replayArenaManifest(rechain(throughBrowser)).compromiseReasons,
      ["browserMutatedWorkspace"],
    );
  });

  test("enforces worktree, start, finish, plan, and attempt lifecycle", () => {
    const startBeforePrepare = new ManifestBuilder();
    const contestant = startBeforePrepare.lock.contestants[0]!;
    startBeforePrepare.append("arenaContestantStarted", {
      payloadType: "contestantStarted",
      contestantId: contestant.contestantId,
      traceId: "trace-early",
      inputBundleSha256: startBeforePrepare.lock.inputBundleSha256,
      environmentPolicySha256: startBeforePrepare.lock.environmentPolicySha256,
      budgetSha256: startBeforePrepare.lock.budgetSha256,
      promptSha256: digest("prompt"),
      contextSha256: digest("context"),
      invocationSha256: contestant.invocationSha256,
      authoritySha256: contestant.authoritySha256,
      preparedFingerprintSha256: digest("prepared"),
      steering: "disabled",
    }, "event-start-early");
    assert.throws(
      () => replayArenaManifest(startBeforePrepare.records),
      /requires a provisioned worktree/,
    );

    const invalidTerminal = new ManifestBuilder();
    const terminalContestant = invalidTerminal.lock.contestants[0]!;
    const baseFingerprint = invalidTerminal.lock.base.baseContentSha256;
    ensureAllWorktreesPrepared(invalidTerminal);
    invalidTerminal.append("arenaContestantStarted", {
      payloadType: "contestantStarted",
      contestantId: terminalContestant.contestantId,
      traceId: "trace-terminal",
      inputBundleSha256: invalidTerminal.lock.inputBundleSha256,
      environmentPolicySha256: invalidTerminal.lock.environmentPolicySha256,
      budgetSha256: invalidTerminal.lock.budgetSha256,
      promptSha256: digest("terminal-prompt"),
      contextSha256: digest("terminal-context"),
      invocationSha256: terminalContestant.invocationSha256,
      authoritySha256: terminalContestant.authoritySha256,
      preparedFingerprintSha256: baseFingerprint,
      steering: "disabled",
    }, "event-terminal-started");
    assert.throws(() => invalidTerminal.append("arenaContestantFinished", {
      payloadType: "contestantFinished",
      contestantId: terminalContestant.contestantId,
      stage: "execution",
      traceId: "trace-terminal",
      status: "cancelled",
      failureCode: "providerFailure",
      finalHead: invalidTerminal.lock.base.revision,
      finalWorkspaceFingerprintSha256: baseFingerprint,
      outputSha256: digest("terminal-output"),
      outputBytes: 0,
    }, "event-terminal-invalid"), /cancelled requires the cancelled failure code/);

    const unknownCheck = new ManifestBuilder();
    const completed = completeContestant(unknownCheck, "contestant-codex");
    const evidenceIndex = unknownCheck.records.indexOf(completed.evidence);
    unknownCheck.records.splice(evidenceIndex, 1);
    const rebuilt = rechain(unknownCheck.records);
    const finishPayload = completed.finished.payload as ArenaContestantFinishedPayload;
    const invalidVerification: ArenaVerificationRecordedPayload = {
      payloadType: "verificationRecorded",
      contestantId: "contestant-codex",
      checkId: "unknown-check",
      attempt: 1,
      planSha256: digest("unknown-plan"),
      status: "failed",
      receiptSha256: digest("receipt"),
      head: finishPayload.finalHead,
      workspaceFingerprintSha256: finishPayload.finalWorkspaceFingerprintSha256,
    };
    rebuilt.push(createArenaManifestEvent({
      eventId: "event-unknown-check",
      runId: "arena-run-one",
      occurredAt: TIME,
      type: "arenaVerificationRecorded",
      payload: invalidVerification,
    }, rebuilt.length + 1, rebuilt.at(-1)!.eventSha256));
    assert.throws(() => replayArenaManifest(rebuilt), /does not bind one locked verification check/);

    const retryAfterPass = new ManifestBuilder();
    const completedRetry = completeContestant(retryAfterPass, "contestant-codex");
    const retryEvidenceIndex = retryAfterPass.records.indexOf(completedRetry.evidence);
    retryAfterPass.records.splice(retryEvidenceIndex, 1);
    const retryRecords = rechain(retryAfterPass.records);
    const firstVerification = completedRetry.verification[0]!
      .payload as ArenaVerificationRecordedPayload;
    retryRecords.push(createArenaManifestEvent({
      eventId: "event-verification-retry",
      runId: "arena-run-one",
      occurredAt: TIME,
      type: "arenaVerificationRecorded",
      payload: { ...firstVerification, attempt: 2, status: "failed" },
    }, retryRecords.length + 1, retryRecords.at(-1)!.eventSha256));
    assert.throws(() => replayArenaManifest(retryRecords), /after a passing receipt/);
  });

  test("requires one stable monitor epoch before provisioning", () => {
    const withoutMonitor = new ManifestBuilder();
    const contestant = withoutMonitor.lock.contestants[0]!;
    withoutMonitor.append("arenaWorktreeProvisioned", {
      payloadType: "worktreeProvisioned",
      contestantId: contestant.contestantId,
      worktreeId: contestant.worktreeId,
      baseRevision: withoutMonitor.lock.base.revision,
      registrationSha256: digest("registration-without-monitor"),
      initialFingerprintSha256: withoutMonitor.lock.base.baseContentSha256,
      preparationPlanSha256: null,
      preparationStatus: "succeeded",
      preparationReceiptSha256: null,
      preparedFingerprintSha256: withoutMonitor.lock.base.baseContentSha256,
    }, "event-prepared-without-monitor");
    assert.throws(
      () => replayArenaManifest(withoutMonitor.records),
      /requires a pre-provision monitor start/,
    );

    const wrongEpoch = new ManifestBuilder();
    ensureMonitorStarted(wrongEpoch);
    wrongEpoch.append("arenaMainWorkspaceObserved", {
      payloadType: "mainWorkspaceObserved",
      observationKind: "checkpoint",
      monitorEpochId: "monitor-other",
      monitorReceiptSha256: digest("wrong-epoch-receipt"),
      status: "unchanged",
      sourceWorkspaceFingerprintSha256:
        wrongEpoch.lock.base.sourceWorkspaceFingerprintSha256,
      repositoryControlSha256: wrongEpoch.lock.base.repositoryControlSha256,
      head: wrongEpoch.lock.base.revision,
      watcherChanged: false,
      reasonCode: null,
    }, "event-wrong-epoch");
    assert.throws(
      () => replayArenaManifest(wrongEpoch.records),
      /does not match the locked monitor epoch/,
    );
  });

  test("requires a unique durable registration before provisioning", () => {
    const missing = new ManifestBuilder();
    const contestant = missing.lock.contestants[0]!;
    ensureMonitorStarted(missing);
    missing.append("arenaWorktreeProvisioned", {
      payloadType: "worktreeProvisioned",
      contestantId: contestant.contestantId,
      worktreeId: contestant.worktreeId,
      baseRevision: missing.lock.base.revision,
      registrationSha256: digest("missing-registration"),
      initialFingerprintSha256: missing.lock.base.baseContentSha256,
      preparationPlanSha256: null,
      preparationStatus: "succeeded",
      preparationReceiptSha256: null,
      preparedFingerprintSha256: missing.lock.base.baseContentSha256,
    }, "event-provision-without-registration");
    assert.throws(
      () => replayArenaManifest(missing.records),
      /requires a durable worktree registration/,
    );

    const duplicate = new ManifestBuilder();
    ensureMonitorStarted(duplicate);
    const sharedRegistration = digest("shared-registration");
    for (const locked of duplicate.lock.contestants) {
      duplicate.append("arenaWorktreeRegistered", {
        payloadType: "worktreeRegistered",
        contestantId: locked.contestantId,
        worktreeId: locked.worktreeId,
        baseRevision: duplicate.lock.base.revision,
        registrationSha256: sharedRegistration,
        initialFingerprintSha256: duplicate.lock.base.baseContentSha256,
      }, `event-registration-${locked.contestantId}`);
    }
    assert.throws(
      () => replayArenaManifest(duplicate.records),
      /duplicates a worktree registration/,
    );
  });

  test("requires every worktree to share one prepared state before dispatch", () => {
    const partial = new ManifestBuilder();
    const prepared = ensureAllWorktreesPrepared(partial);
    const firstPrepared = prepared.get("contestant-codex")!;
    const partialRecords = rechain(partial.records.filter((event) =>
      event.type === "arenaRunLocked"
      || event.type === "arenaMainWorkspaceObserved"
      || event.type === "arenaWorktreeRegistered"
      || event.eventId === firstPrepared.eventId));
    partialRecords.push(createArenaManifestEvent({
      eventId: "event-start-before-all-prepared",
      runId: partial.runId,
      occurredAt: TIME,
      type: "arenaContestantStarted",
      payload: contestantStartedPayload(partial, "contestant-codex"),
    }, partialRecords.length + 1, partialRecords.at(-1)!.eventSha256));
    assert.throws(
      () => replayArenaManifest(partialRecords),
      /requires every locked worktree to be provisioned before dispatch/,
    );

    const planned = new ManifestBuilder(lockFixture({
      preparationPlanSha256: digest("preparation-plan"),
    }));
    ensureAllWorktreesPrepared(planned);
    const mismatched = structuredClone(planned.records) as DeepMutable<ArenaManifestEvent>[];
    const claudePrepared = mismatched.find((event) =>
      event.type === "arenaWorktreeProvisioned"
      && (event.payload as ArenaWorktreeProvisionedPayload).contestantId
        === "contestant-claude")!;
    (claudePrepared.payload as DeepMutable<ArenaWorktreeProvisionedPayload>)
      .preparedFingerprintSha256 = digest("different-prepared-state");
    const rechained = rechain(mismatched);
    const replay = replayArenaManifest(rechained);
    assert.equal(replay.compromised, true);
    assert.deepEqual(replay.compromiseReasons, ["preparationStateMismatch"]);
    rechained.push(createArenaManifestEvent({
      eventId: "event-start-after-preparation-mismatch",
      runId: planned.runId,
      occurredAt: TIME,
      type: "arenaContestantStarted",
      payload: contestantStartedPayload(planned, "contestant-codex"),
    }, rechained.length + 1, rechained.at(-1)!.eventSha256));
    assert.throws(
      () => replayArenaManifest(rechained),
      /cannot dispatch after a control compromise is latched/,
    );
  });

  test("binds locked input, environment, and budget to every dispatch", () => {
    const wrongInput = new ManifestBuilder();
    ensureAllWorktreesPrepared(wrongInput);
    wrongInput.append(
      "arenaContestantStarted",
      contestantStartedPayload(wrongInput, "contestant-codex", {
        inputBundleSha256: digest("different-input"),
      }),
      "event-wrong-input",
    );
    assert.throws(
      () => replayArenaManifest(wrongInput.records),
      /does not match the locked input, environment, budget, invocation, authority, and prepared state/,
    );

    const wrongEnvironment = new ManifestBuilder();
    ensureAllWorktreesPrepared(wrongEnvironment);
    wrongEnvironment.append(
      "arenaContestantStarted",
      contestantStartedPayload(wrongEnvironment, "contestant-codex", {
        environmentPolicySha256: digest("different-environment"),
      }),
      "event-wrong-environment",
    );
    assert.throws(
      () => replayArenaManifest(wrongEnvironment.records),
      /does not match the locked input, environment, budget, invocation, authority, and prepared state/,
    );

    const wrongBudget = new ManifestBuilder();
    ensureAllWorktreesPrepared(wrongBudget);
    wrongBudget.append(
      "arenaContestantStarted",
      contestantStartedPayload(wrongBudget, "contestant-codex", {
        budgetSha256: digest("different-budget"),
      }),
      "event-wrong-budget",
    );
    assert.throws(
      () => replayArenaManifest(wrongBudget.records),
      /does not match the locked input, environment, budget, invocation, authority, and prepared state/,
    );
  });

  test("keeps failed preparation non-dispatchable but safely preservable and cleanable", () => {
    const preparationPlanSha256 = digest("fallible-preparation-plan");
    const dispatchBlocked = new ManifestBuilder(lockFixture({
      preparationPlanSha256,
    }));
    ensureAllWorktreesPrepared(dispatchBlocked, {
      preparationStatusByContestant: { "contestant-codex": "failed" },
    });
    dispatchBlocked.append(
      "arenaContestantStarted",
      contestantStartedPayload(dispatchBlocked, "contestant-claude"),
      "event-start-after-failed-preparation",
    );
    assert.throws(
      () => replayArenaManifest(dispatchBlocked.records),
      /requires successful preparation for every locked worktree/,
    );

    const builder = new ManifestBuilder(lockFixture({ preparationPlanSha256 }));
    const prepared = ensureAllWorktreesPrepared(builder, {
      preparationStatusByContestant: { "contestant-codex": "failed" },
    });
    for (const contestant of builder.lock.contestants) {
      const preparedPayload = prepared.get(contestant.contestantId)!
        .payload as ArenaWorktreeProvisionedPayload;
      const preparationFailed = preparedPayload.preparationStatus === "failed";
      const finished = builder.append("arenaContestantFinished", {
        payloadType: "contestantFinished",
        contestantId: contestant.contestantId,
        stage: "beforeDispatch",
        traceId: null,
        status: preparationFailed ? "failed" : "cancelled",
        failureCode: preparationFailed ? "preparationFailed" : "cancelled",
        finalHead: builder.lock.base.revision,
        finalWorkspaceFingerprintSha256:
          preparedPayload.preparedFingerprintSha256,
        outputSha256: digest(`cancelled-output-${contestant.contestantId}`),
        outputBytes: 0,
      }, `event-cancelled-${contestant.contestantId}`);
      const receiptsRootSha256 = arenaReceiptsRootSha256({
        finished,
        verifications: new Map(),
        browserJourneys: new Map(),
      });
      builder.append("arenaEvidencePreserved", evidenceFixture({
        payloadType: "evidencePreserved",
        contestantId: contestant.contestantId,
        receiptsRootSha256,
        patchSha256: digest(`cancelled-patch-${contestant.contestantId}`),
        patchBytes: 0,
        untrackedArchiveSha256: null,
        untrackedArchiveBytes: 0,
        inventorySha256: digest(`cancelled-inventory-${contestant.contestantId}`),
        quiescenceReceiptSha256: null,
        quiescenceWorkspaceFingerprintSha256: null,
        finalHead: builder.lock.base.revision,
        finalWorkspaceFingerprintSha256:
          preparedPayload.preparedFingerprintSha256,
      }), `event-cancelled-evidence-${contestant.contestantId}`);
    }
    builder.append("arenaRunFinalized", {
      payloadType: "runFinalized",
      outcome: "failed",
      comparison: "incomplete",
      reasonCode: "provisioningFailed",
      evidenceMatrixSha256: null,
    }, "event-cancelled-finalized");
    builder.append(
      "arenaCleanupStepRecorded",
      cleanupPayload(builder, "contestant-codex", "quiesceProcesses"),
      "event-cancelled-cleanup",
    );
    const replay = replayArenaManifest(builder.records);
    assert.equal(replay.state, "finalized");
    assert.equal(replay.promotionEligible, false);
    assert.ok(replay.contestants.every((candidate) =>
      candidate.evidencePreserved !== undefined));
  });

  test("recovers a registered worktree when provisioning never completed", () => {
    const builder = new ManifestBuilder();
    ensureMonitorStarted(builder);
    const contestant = builder.lock.contestants[0]!;
    builder.append("arenaWorktreeRegistered", {
      payloadType: "worktreeRegistered",
      contestantId: contestant.contestantId,
      worktreeId: contestant.worktreeId,
      baseRevision: builder.lock.base.revision,
      registrationSha256: digest("recovered-registration"),
      initialFingerprintSha256: builder.lock.base.baseContentSha256,
    }, "event-recovered-registration");
    const finished = builder.append("arenaContestantFinished", {
      payloadType: "contestantFinished",
      contestantId: contestant.contestantId,
      stage: "beforeDispatch",
      traceId: null,
      status: "failed",
      failureCode: "unknown",
      finalHead: builder.lock.base.revision,
      finalWorkspaceFingerprintSha256: builder.lock.base.baseContentSha256,
      outputSha256: digest("recovered-output"),
      outputBytes: 0,
    }, "event-recovered-finish");
    builder.append("arenaEvidencePreserved", evidenceFixture({
      payloadType: "evidencePreserved",
      contestantId: contestant.contestantId,
      receiptsRootSha256: arenaReceiptsRootSha256({
        finished,
        verifications: new Map(),
        browserJourneys: new Map(),
      }),
      patchSha256: digest("recovered-patch"),
      patchBytes: 0,
      untrackedArchiveSha256: null,
      untrackedArchiveBytes: 0,
      inventorySha256: digest("recovered-inventory"),
      quiescenceReceiptSha256: null,
      quiescenceWorkspaceFingerprintSha256: null,
      finalHead: builder.lock.base.revision,
      finalWorkspaceFingerprintSha256: builder.lock.base.baseContentSha256,
    }), "event-recovered-evidence");
    builder.append("arenaRunFinalized", {
      payloadType: "runFinalized",
      outcome: "failed",
      comparison: "incomplete",
      reasonCode: "provisioningFailed",
      evidenceMatrixSha256: null,
    }, "event-recovered-finalized");
    builder.append(
      "arenaCleanupStepRecorded",
      cleanupPayload(builder, contestant.contestantId, "quiesceProcesses"),
      "event-recovered-cleanup",
    );
    const replay = replayArenaManifest(builder.records);
    assert.equal(replay.state, "finalized");
    assert.equal(
      replay.contestants[0]?.worktreeProvisioned,
      undefined,
    );
    assert.ok(replay.contestants[0]?.worktreeRegistered);
  });

  test("treats uncertain termination as a control compromise and stops checks", () => {
    const builder = new ManifestBuilder();
    ensureAllWorktreesPrepared(builder);
    const started = builder.append(
      "arenaContestantStarted",
      contestantStartedPayload(builder, "contestant-codex"),
      "event-uncertain-start",
    );
    const startedPayload = started.payload as ArenaContestantStartedPayload;
    const fingerprint = digest("uncertain-fingerprint");
    builder.append("arenaContestantFinished", {
      payloadType: "contestantFinished",
      contestantId: "contestant-codex",
      stage: "execution",
      traceId: startedPayload.traceId,
      status: "deliveryUnknown",
      failureCode: "terminationUnconfirmed",
      finalHead: builder.lock.base.revision,
      finalWorkspaceFingerprintSha256: fingerprint,
      outputSha256: digest("uncertain-output"),
      outputBytes: 0,
    }, "event-uncertain-finish");
    assert.deepEqual(
      replayArenaManifest(builder.records).compromiseReasons,
      ["terminationUnconfirmed"],
    );
    const check = builder.lock.verificationChecks[0]!;
    builder.append("arenaVerificationRecorded", {
      payloadType: "verificationRecorded",
      contestantId: "contestant-codex",
      checkId: check.checkId,
      attempt: 1,
      planSha256: check.planSha256,
      status: "unconfirmed",
      receiptSha256: digest("uncertain-verification"),
      head: builder.lock.base.revision,
      workspaceFingerprintSha256: fingerprint,
    }, "event-check-after-uncertain");
    assert.throws(
      () => replayArenaManifest(builder.records),
      /cannot verify after a control compromise is latched/,
    );
  });

  test("rejects uncertain-termination evidence until typed quiescence replay exists", () => {
    const builder = new ManifestBuilder();
    ensureAllWorktreesPrepared(builder);
    const contestant = builder.lock.contestants[0]!;
    const started = builder.append(
      "arenaContestantStarted",
      contestantStartedPayload(builder, contestant.contestantId),
      "event-uncertain-evidence-start",
    );
    const startedPayload = started.payload as ArenaContestantStartedPayload;
    const fingerprint = digest("uncertain-evidence-fingerprint");
    const finished = builder.append("arenaContestantFinished", {
      payloadType: "contestantFinished",
      contestantId: contestant.contestantId,
      stage: "execution",
      traceId: startedPayload.traceId,
      status: "deliveryUnknown",
      failureCode: "terminationUnconfirmed",
      finalHead: builder.lock.base.revision,
      finalWorkspaceFingerprintSha256: fingerprint,
      outputSha256: digest("uncertain-evidence-output"),
      outputBytes: 0,
    }, "event-uncertain-evidence-finish");
    builder.append("arenaEvidencePreserved", evidenceFixture({
      payloadType: "evidencePreserved",
      contestantId: contestant.contestantId,
      receiptsRootSha256: arenaReceiptsRootSha256({
        finished,
        verifications: new Map(),
        browserJourneys: new Map(),
      }),
      patchSha256: digest("uncertain-patch"),
      patchBytes: 0,
      untrackedArchiveSha256: null,
      untrackedArchiveBytes: 0,
      inventorySha256: digest("uncertain-inventory"),
      quiescenceReceiptSha256: digest("caller-supplied-quiescence"),
      quiescenceWorkspaceFingerprintSha256: fingerprint,
      finalHead: builder.lock.base.revision,
      finalWorkspaceFingerprintSha256: fingerprint,
    }), "event-uncertain-evidence");
    assert.throws(
      () => replayArenaManifest(builder.records),
      /typed private process-quiescence receipt/,
    );
  });

  test("permits partial preservation but requires the exact available receipt root", () => {
    const builder = new ManifestBuilder();
    const contestant = builder.lock.contestants[0]!;
    const fingerprint = digest("candidate");
    ensureAllWorktreesPrepared(builder);
    builder.append("arenaContestantStarted", {
      payloadType: "contestantStarted",
      contestantId: contestant.contestantId,
      traceId: "trace-one",
      inputBundleSha256: builder.lock.inputBundleSha256,
      environmentPolicySha256: builder.lock.environmentPolicySha256,
      budgetSha256: builder.lock.budgetSha256,
      promptSha256: digest("prompt"),
      contextSha256: digest("context"),
      invocationSha256: contestant.invocationSha256,
      authoritySha256: contestant.authoritySha256,
      preparedFingerprintSha256: builder.lock.base.baseContentSha256,
      steering: "disabled",
    }, "event-started");
    builder.append("arenaContestantFinished", {
      payloadType: "contestantFinished",
      contestantId: contestant.contestantId,
      stage: "execution",
      traceId: "trace-one",
      status: "succeeded",
      failureCode: null,
      finalHead: builder.lock.base.revision,
      finalWorkspaceFingerprintSha256: fingerprint,
      outputSha256: digest("output"),
      outputBytes: 0,
    }, "event-finished");
    builder.append("arenaEvidencePreserved", evidenceFixture({
      payloadType: "evidencePreserved",
      contestantId: contestant.contestantId,
      receiptsRootSha256: digest("forged-root"),
      patchSha256: digest("patch"),
      patchBytes: 0,
      untrackedArchiveSha256: null,
      untrackedArchiveBytes: 0,
      inventorySha256: digest("inventory"),
      quiescenceReceiptSha256: null,
      quiescenceWorkspaceFingerprintSha256: null,
      finalHead: builder.lock.base.revision,
      finalWorkspaceFingerprintSha256: fingerprint,
    }), "event-evidence");
    assert.throws(
      () => replayArenaManifest(builder.records),
      /does not bind the contestant receipts/,
    );

    const wrongRoot = new ManifestBuilder();
    const complete = completeContestant(wrongRoot, "contestant-codex");
    const mutated = structuredClone(wrongRoot.records) as DeepMutable<ArenaManifestEvent>[];
    const evidence = mutated.find((event) => event.eventId === complete.evidence.eventId)!;
    (evidence.payload as DeepMutable<ArenaEvidencePreservedPayload>)
      .receiptsRootSha256 = digest("wrong-root");
    const rechained = rechain(mutated);
    assert.throws(() => replayArenaManifest(rechained), /does not bind the contestant receipts/);
  });

  test("requires a fresh final source observation for comparable completion", () => {
    const builder = new ManifestBuilder();
    for (const contestant of builder.lock.contestants) {
      completeContestant(builder, contestant.contestantId);
    }
    builder.append("arenaRunFinalized", {
      payloadType: "runFinalized",
      outcome: "completed",
      comparison: "comparable",
      reasonCode: null,
      evidenceMatrixSha256: digest("matrix"),
    }, "event-finalized");
    assert.throws(
      () => replayArenaManifest(builder.records),
      /completed requires a postEvidence source observation after durable evidence/,
    );
  });

  test("allows only one final postEvidence observation", () => {
    const builder = new ManifestBuilder();
    for (const contestant of builder.lock.contestants) {
      completeContestant(builder, contestant.contestantId);
    }
    appendUnchangedObservation(builder, "postEvidence");
    appendUnchangedObservation(builder, "postEvidence");
    assert.throws(
      () => replayArenaManifest(builder.records),
      /duplicates the single final postEvidence observation/,
    );
  });

  test("allows pre-registration failure but refuses to strand a registered target", () => {
    const failed = new ManifestBuilder();
    failed.append("arenaRunFinalized", {
      payloadType: "runFinalized",
      outcome: "failed",
      comparison: "incomplete",
      reasonCode: "provisioningFailed",
      evidenceMatrixSha256: null,
    }, "event-finalized");
    const replay = replayArenaManifest(failed.records);
    assert.equal(replay.state, "finalized");
    assert.equal(replay.promotionEligible, false);

    failed.append("arenaCleanupStepRecorded", cleanupPayload(
      failed,
      "contestant-codex",
      "quiesceProcesses",
    ), "event-cleanup");
    assert.throws(
      () => replayArenaManifest(failed.records),
      /cleanup start rejected: worktreeNotRegistered/,
    );

    const stranded = new ManifestBuilder();
    ensureMonitorStarted(stranded);
    const contestant = stranded.lock.contestants[0]!;
    stranded.append("arenaWorktreeRegistered", {
      payloadType: "worktreeRegistered",
      contestantId: contestant.contestantId,
      worktreeId: contestant.worktreeId,
      baseRevision: stranded.lock.base.revision,
      registrationSha256: digest("stranded-registration"),
      initialFingerprintSha256: stranded.lock.base.baseContentSha256,
    }, "event-stranded-registration");
    stranded.append("arenaRunFinalized", {
      payloadType: "runFinalized",
      outcome: "failed",
      comparison: "incomplete",
      reasonCode: "provisioningFailed",
      evidenceMatrixSha256: null,
    }, "event-stranded-finalized");
    assert.throws(
      () => replayArenaManifest(stranded.records),
      /require terminal evidence for every registered cleanup target/,
    );
  });

  test("allows only cleanup after finalization and never cleanup before evidence", () => {
    const builder = completeComparableRun();
    builder.append("arenaMainWorkspaceObserved", {
      payloadType: "mainWorkspaceObserved",
      observationKind: "postEvidence",
      monitorEpochId: MONITOR_EPOCH_ID,
      monitorReceiptSha256: digest("too-late-monitor"),
      status: "unchanged",
      sourceWorkspaceFingerprintSha256:
        builder.lock.base.sourceWorkspaceFingerprintSha256,
      repositoryControlSha256: builder.lock.base.repositoryControlSha256,
      head: builder.lock.base.revision,
      watcherChanged: false,
      reasonCode: null,
    }, "event-too-late");
    assert.throws(
      () => replayArenaManifest(builder.records),
      /only cleanup records may follow arenaRunFinalized/,
    );

    const beforeFinal = new ManifestBuilder();
    completeContestant(beforeFinal, "contestant-codex");
    beforeFinal.append(
      "arenaCleanupStepRecorded",
      cleanupPayload(builder, "contestant-codex", "quiesceProcesses"),
      "event-cleanup-early",
    );
    assert.throws(() => replayArenaManifest(beforeFinal.records), /before run finalization/);
  });

  test("rejects cleanup fallthrough, cross-contestant cleanup IDs, and unsafe extra data", () => {
    const builder = completeComparableRun();
    builder.append(
      "arenaCleanupStepRecorded",
      cleanupPayload(builder, "contestant-codex", "quiesceProcesses", {
        cleanupId: "shared-cleanup",
      }),
      "event-cleanup-codex",
    );
    builder.append(
      "arenaCleanupStepRecorded",
      cleanupPayload(builder, "contestant-claude", "quiesceProcesses", {
        cleanupId: "shared-cleanup",
      }),
      "event-cleanup-claude",
    );
    assert.throws(() => replayArenaManifest(builder.records), /already bound to another contestant/);

    const extra = structuredClone(completeComparableRun().records[0]) as
      ArenaManifestEvent & { authority?: string };
    extra.authority = "expanded";
    assert.equal(isArenaManifestEvent(extra), false);
    assert.throws(() => parseArenaManifestEvent(extra), /unknown authority/);
  });

  test("enforces preparation parity and immutable evidence archive metadata", () => {
    const plan = digest("preparation-plan");
    const builder = new ManifestBuilder(lockFixture({ preparationPlanSha256: plan }));
    const contestant = builder.lock.contestants[0]!;
    assert.throws(() => builder.append("arenaWorktreeProvisioned", {
      payloadType: "worktreeProvisioned",
      contestantId: contestant.contestantId,
      worktreeId: contestant.worktreeId,
      baseRevision: builder.lock.base.revision,
      registrationSha256: digest("registration"),
      initialFingerprintSha256: builder.lock.base.baseContentSha256,
      preparationPlanSha256: plan,
      preparationStatus: "succeeded",
      preparationReceiptSha256: null,
      preparedFingerprintSha256: digest("prepared"),
    }, "event-prepared"), /preparation plan requires a receipt/);

    const wrongBase = new ManifestBuilder();
    const wrongBaseContestant = wrongBase.lock.contestants[0]!;
    ensureMonitorStarted(wrongBase);
    wrongBase.append("arenaWorktreeRegistered", {
      payloadType: "worktreeRegistered",
      contestantId: wrongBaseContestant.contestantId,
      worktreeId: wrongBaseContestant.worktreeId,
      baseRevision: wrongBase.lock.base.revision,
      registrationSha256: digest("wrong-base-registration"),
      initialFingerprintSha256: digest("not-the-base"),
    }, "event-wrong-base");
    assert.throws(
      () => replayArenaManifest(wrongBase.records),
      /does not match the locked base content/,
    );

    const invalidArchive = structuredClone(lockFixture());
    const archiveBuilder = new ManifestBuilder(invalidArchive);
    const complete = completeContestant(archiveBuilder, "contestant-codex");
    const evidence = structuredClone(
      complete.evidence.payload as ArenaEvidencePreservedPayload,
    ) as DeepMutable<ArenaEvidencePreservedPayload>;
    evidence.untrackedArchiveSha256 = null;
    evidence.untrackedArchiveBytes = 10;
    assert.throws(
      () => parseArenaManifestEvent({
        ...complete.evidence,
        payload: evidence,
        eventSha256: digest("placeholder"),
      }),
      /hash is null exactly when its byte count is zero/,
    );
  });

  test("rejects manifest count overflow, negative zero, and unsupported JSON values", () => {
    const lock = new ManifestBuilder().records[0]!;
    assert.throws(
      () => replayArenaManifest(Array.from(
        { length: ARENA_MANIFEST_LIMITS.maxEvents + 1 },
        () => lock,
      )),
      /must not exceed 10000 events/,
    );
    assert.throws(
      () => canonicalArenaManifestJson({ bytes: -0 }),
      /reject negative zero/,
    );
    assert.throws(
      () => canonicalArenaManifestJson({ missing: undefined }),
      /reject undefined/,
    );
    assert.throws(
      () => canonicalArenaManifestJson(new Date()),
      /plain values/,
    );
  });

  test("returns bounded validation issues and rejects an empty history", () => {
    assert.throws(() => replayArenaManifest([]), ArenaManifestValidationError);
    const issues = validateArenaManifestEvents([]);
    assert.equal(issues.length, 1);
    assert.match(issues[0]!, /must begin with arenaRunLocked/);
  });
});

function rechain(values: readonly ArenaManifestEvent[]): ArenaManifestEvent[] {
  const rebuilt: ArenaManifestEvent[] = [];
  for (const value of values) {
    const draft: ArenaManifestEventDraft = {
      eventId: value.eventId,
      runId: value.runId,
      occurredAt: value.occurredAt,
      type: value.type,
      payload: value.payload,
    };
    rebuilt.push(createArenaManifestEvent(
      draft,
      rebuilt.length + 1,
      rebuilt.at(-1)?.eventSha256 ?? ARENA_MANIFEST_GENESIS_SHA256,
    ));
  }
  return rebuilt;
}
