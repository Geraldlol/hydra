import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  atomicWriteFile,
  readFileHead,
  serializePerFileAcrossProcesses,
} from "./fileQueue";
import {
  MISSION_CONTRACT_SCHEMA_VERSION,
  normalizeMissionContract,
  type MissionContractBinding,
  type MissionContractDocument,
} from "./missionContract";
import {
  MissionContractController,
  type MissionContractIdKind,
} from "./missionContractController";
import {
  loadMissionContractLedger,
  MissionContractBindingConflictError,
} from "./missionContractStore";
import {
  createFlightRecorderRuntime,
  type FlightRecorderRuntime,
} from "./flightRecorderRuntime";
import {
  type FlightOperationKind,
  type FlightRecord,
  type FlightSteeringChainMetadata,
  type FlightTraceReplay,
} from "./flightRecorderProtocol";
import { flightTracePath } from "./flightRecorderStore";

export const MISSION_FLIGHT_SMOKE_SCHEMA_VERSION = 1 as const;
export const MISSION_FLIGHT_SMOKE_REPORT_MAX_BYTES = 64 * 1024;

const SMOKE_REPORT_TYPE = "missionFlightSmoke" as const;
const RUN_ID_RE = /^mission-flight-smoke-[a-f0-9-]{8,96}$/;
const MAX_REPORT_TEXT_CHARS = 500;
const MAX_REPORT_RECORDS = 32;
const MAX_INSPECTION_BYTES = 1024 * 1024;
const OWNER_QUIESCENCE_TIMEOUT_MS = 2_000;
const PRIVATE_CONTENT_CANARY = "HYDRA_MISSION_FLIGHT_PRIVATE_CONTENT_CANARY";

export type MissionFlightSmokeFailureStage =
  | "mission"
  | "flight"
  | "inspection"
  | "cleanup";

export type MissionFlightSmokeCheckId =
  | "mission-proposal-unbound"
  | "mission-confirm-amend"
  | "mission-stale-binding-rejected"
  | "flight-phase-transition"
  | "flight-usage"
  | "flight-verification"
  | "flight-native-action"
  | "flight-complete"
  | "metadata-only"
  | "sandbox-cleanup";

const CHECK_IDS: readonly MissionFlightSmokeCheckId[] = Object.freeze([
  "mission-proposal-unbound",
  "mission-confirm-amend",
  "mission-stale-binding-rejected",
  "flight-phase-transition",
  "flight-usage",
  "flight-verification",
  "flight-native-action",
  "flight-complete",
  "metadata-only",
  "sandbox-cleanup",
]);

const EXPECTED_RECORD_ORDER = Object.freeze([
  "traceStarted:roomTurn",
  "operationStarted:phase",
  "operationEvent:phase",
  "operationStarted:agentRun",
  "operationStarted:usage",
  "operationEvent:usage",
  "operationFinished:usage",
  "operationFinished:agentRun",
  "operationStarted:verification",
  "operationEvent:verification",
  "operationFinished:verification",
  "operationStarted:nativeAction",
  "operationEvent:nativeAction",
  "operationFinished:nativeAction",
  "operationFinished:phase",
  "traceFinished:roomTurn",
]);

export interface MissionFlightSmokeCheck {
  readonly id: MissionFlightSmokeCheckId;
  readonly passed: boolean;
  readonly detail: string;
}

export interface MissionFlightSmokeObserved {
  readonly missionEventCount: number;
  readonly missionRevision: number;
  readonly flightRecordCount: number;
  readonly flightCompleteness:
    | "active"
    | "complete"
    | "limited"
    | "incomplete"
    | "invalid"
    | "missing";
  readonly operationKinds: readonly FlightOperationKind[];
  readonly recordOrder: readonly string[];
}

export interface MissionFlightSmokeReport {
  readonly schemaVersion: typeof MISSION_FLIGHT_SMOKE_SCHEMA_VERSION;
  readonly reportType: typeof SMOKE_REPORT_TYPE;
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly passed: boolean;
  readonly failureStage: MissionFlightSmokeFailureStage | null;
  readonly checks: readonly MissionFlightSmokeCheck[];
  readonly observed: MissionFlightSmokeObserved;
}

export interface RunMissionFlightSmokeOptions {
  readonly privateWorkspaceRoot: string;
  readonly now?: () => Date;
  readonly runId?: string;
}

export type MissionFlightSmokeErrorCode =
  | "storageUnavailable"
  | "reportInvalid"
  | "reportPersistenceFailed";

export class MissionFlightSmokeError extends Error {
  constructor(readonly code: MissionFlightSmokeErrorCode) {
    super({
      storageUnavailable:
        "Mission/Flight smoke storage is unavailable.",
      reportInvalid:
        "The Mission/Flight smoke report failed strict validation.",
      reportPersistenceFailed:
        "The Mission/Flight smoke report could not be persisted.",
    }[code]);
    this.name = "MissionFlightSmokeError";
  }
}

interface SmokeStorage {
  readonly diagnosticsRoot: string;
  readonly runsRoot: string;
  readonly realRunsRoot: string;
  readonly runRoot: string;
}

interface SmokeState {
  missionProposalUnbound: boolean;
  missionConfirmAmend: boolean;
  missionStaleBindingRejected: boolean;
  flightPhaseTransition: boolean;
  flightUsage: boolean;
  flightVerification: boolean;
  flightNativeAction: boolean;
  flightComplete: boolean;
  metadataOnly: boolean;
  sandboxCleanup: boolean;
  missionEventCount: number;
  missionRevision: number;
  flightRecordCount: number;
  flightCompleteness: MissionFlightSmokeObserved["flightCompleteness"];
  operationKinds: FlightOperationKind[];
  recordOrder: string[];
}

interface MonotonicClock {
  readonly nextDate: () => Date;
  readonly nextIso: () => string;
}

export function missionFlightSmokeDiagnosticsRoot(
  privateWorkspaceRoot: string,
): string {
  return path.join(
    privateWorkspaceRoot,
    "diagnostics",
    "mission-flight-smoke",
  );
}

export function missionFlightSmokeLatestReportPath(
  privateWorkspaceRoot: string,
): string {
  return path.join(
    missionFlightSmokeDiagnosticsRoot(privateWorkspaceRoot),
    "latest.v1.json",
  );
}

/**
 * Runs a fixed, zero-cost Mission/Flight lifecycle entirely beneath an
 * extension-private disposable child. It never receives a workspace path,
 * agent runner, verifier, browser, or live Mission/Flight controller.
 */
export async function runMissionFlightSmokeTest(
  options: RunMissionFlightSmokeOptions,
): Promise<MissionFlightSmokeReport> {
  const runId = options.runId ?? `mission-flight-smoke-${randomUUID()}`;
  if (!RUN_ID_RE.test(runId)) {
    throw new MissionFlightSmokeError("storageUnavailable");
  }
  const clock = createMonotonicClock(options.now);
  const startedAt = clock.nextIso();
  let storage: SmokeStorage;
  try {
    storage = await prepareSmokeStorage(options.privateWorkspaceRoot);
  } catch {
    throw new MissionFlightSmokeError("storageUnavailable");
  }

  const state: SmokeState = {
    missionProposalUnbound: false,
    missionConfirmAmend: false,
    missionStaleBindingRejected: false,
    flightPhaseTransition: false,
    flightUsage: false,
    flightVerification: false,
    flightNativeAction: false,
    flightComplete: false,
    metadataOnly: false,
    sandboxCleanup: false,
    missionEventCount: 0,
    missionRevision: 0,
    flightRecordCount: 0,
    flightCompleteness: "missing",
    operationKinds: [],
    recordOrder: [],
  };

  let failureStage: MissionFlightSmokeFailureStage | null = null;
  let runtime: FlightRecorderRuntime | undefined;
  let traceId: string | undefined;
  let finalBinding: MissionContractBinding | undefined;
  let ownerLeaseQuiesced = true;

  try {
    const mission = await exerciseMissionLifecycle(
      storage.runRoot,
      runId,
      clock,
    );
    finalBinding = mission.binding;
    state.missionProposalUnbound = mission.proposalUnbound;
    state.missionConfirmAmend = mission.confirmAmend;
    state.missionStaleBindingRejected = mission.staleBindingRejected;
    state.missionEventCount = mission.eventCount;
    state.missionRevision = mission.revision;
  } catch {
    failureStage = "mission";
  }

  if (finalBinding?.state === "active") {
    try {
      traceId = `trace-${runId}`;
      const mirrorPath = path.join(
        storage.runRoot,
        "mirrors",
        "flight-recorder.md",
      );
      // Retain ownership immediately after creation so every later lifecycle
      // failure still reaches dispose/quiescence before exact-child cleanup.
      runtime = await createFlightRecorderRuntime({
        privateWorkspaceRoot: storage.runRoot,
        ownerId: `owner-${runId}`,
        mirrorPath,
        now: clock.nextDate,
      });
      const flight = await exerciseFlightLifecycle(
        runtime,
        storage.runRoot,
        mirrorPath,
        traceId,
        runId,
        finalBinding,
        clock,
      );
      state.flightPhaseTransition = flight.phaseTransition;
      state.flightUsage = flight.usage;
      state.flightVerification = flight.verification;
      state.flightNativeAction = flight.nativeAction;
      state.flightComplete = flight.complete;
      state.metadataOnly = flight.metadataOnly;
      state.flightRecordCount = flight.replay?.records.length ?? 0;
      state.flightCompleteness =
        flight.replay?.completeness ?? "missing";
      state.operationKinds = flight.operationKinds;
      state.recordOrder = flight.recordOrder;
      if (!flight.complete && failureStage === null) {
        failureStage = "inspection";
      }
    } catch {
      failureStage ??= "flight";
    }
  }

  if (runtime) {
    try {
      runtime.dispose();
      if (traceId) await runtime.flushDerivedWork(traceId);
      ownerLeaseQuiesced =
        await waitForDisposedFlightOwner(storage.runRoot);
    } catch {
      ownerLeaseQuiesced = false;
      failureStage ??= "flight";
    }
  }

  state.sandboxCleanup = ownerLeaseQuiesced
    && await removeExactSmokeRun(storage);
  if (!state.sandboxCleanup) failureStage ??= "cleanup";

  if (
    failureStage === null
    && (
      !state.missionProposalUnbound
      || !state.missionConfirmAmend
      || !state.missionStaleBindingRejected
    )
  ) {
    failureStage = "mission";
  }
  if (
    failureStage === null
    && (
      !state.flightPhaseTransition
      || !state.flightUsage
      || !state.flightVerification
      || !state.flightNativeAction
      || !state.flightComplete
      || !state.metadataOnly
    )
  ) {
    failureStage = "inspection";
  }

  let report = buildReport(
    runId,
    startedAt,
    clock.nextIso(),
    failureStage,
    state,
  );
  if (
    JSON.stringify(report).includes(PRIVATE_CONTENT_CANARY)
    || JSON.stringify(report).includes(storage.runRoot)
    || (
      finalBinding?.state === "active"
      && JSON.stringify(report).includes(finalBinding.bindingSha256)
    )
  ) {
    state.metadataOnly = false;
    failureStage ??= "inspection";
    report = buildReport(
      runId,
      startedAt,
      clock.nextIso(),
      failureStage,
      state,
    );
  }

  await persistLatestReport(options.privateWorkspaceRoot, report);
  return report;
}

export async function readMissionFlightSmokeLatestReport(
  privateWorkspaceRoot: string,
): Promise<MissionFlightSmokeReport | undefined> {
  const filePath = missionFlightSmokeLatestReportPath(privateWorkspaceRoot);
  let bounded;
  try {
    bounded = await readFileHead(
      filePath,
      MISSION_FLIGHT_SMOKE_REPORT_MAX_BYTES,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new MissionFlightSmokeError("reportInvalid");
  }
  if (bounded.truncated) {
    throw new MissionFlightSmokeError("reportInvalid");
  }
  try {
    const value: unknown = JSON.parse(bounded.text);
    if (!isMissionFlightSmokeReport(value)) {
      throw new MissionFlightSmokeError("reportInvalid");
    }
    return value;
  } catch (error) {
    if (error instanceof MissionFlightSmokeError) throw error;
    throw new MissionFlightSmokeError("reportInvalid");
  }
}

export function formatMissionFlightSmokeReport(
  report: MissionFlightSmokeReport,
): string {
  return [
    `Mission/Flight smoke test ${report.passed ? "passed" : "failed"}.`,
    `Mission events: ${report.observed.missionEventCount}; final synthetic revision: ${report.observed.missionRevision}.`,
    `Flight records: ${report.observed.flightRecordCount}; completeness: ${report.observed.flightCompleteness}.`,
    "Checks:",
    ...report.checks.map((check) =>
      `- ${check.passed ? "PASS" : "FAIL"} ${check.id}: ${check.detail}`),
  ].join("\n");
}

export function isMissionFlightSmokeReport(
  value: unknown,
): value is MissionFlightSmokeReport {
  if (!isExactRecord(value, [
    "schemaVersion",
    "reportType",
    "runId",
    "startedAt",
    "completedAt",
    "passed",
    "failureStage",
    "checks",
    "observed",
  ])) return false;
  if (
    value.schemaVersion !== MISSION_FLIGHT_SMOKE_SCHEMA_VERSION
    || value.reportType !== SMOKE_REPORT_TYPE
    || typeof value.runId !== "string"
    || !RUN_ID_RE.test(value.runId)
    || !isCanonicalTimestamp(value.startedAt)
    || !isCanonicalTimestamp(value.completedAt)
    || Date.parse(value.completedAt) < Date.parse(value.startedAt)
    || typeof value.passed !== "boolean"
    || !isFailureStage(value.failureStage)
    || !Array.isArray(value.checks)
    || value.checks.length !== CHECK_IDS.length
  ) return false;

  const checks: MissionFlightSmokeCheck[] = [];
  for (let index = 0; index < CHECK_IDS.length; index++) {
    const expectedId = CHECK_IDS[index];
    const candidate = value.checks[index];
    if (
      expectedId === undefined
      || !isExactRecord(candidate, ["id", "passed", "detail"])
      || candidate.id !== expectedId
      || typeof candidate.passed !== "boolean"
      || !isBoundedReportText(candidate.detail)
    ) return false;
    checks.push(candidate as unknown as MissionFlightSmokeCheck);
  }
  if (value.passed !== checks.every((check) => check.passed)) return false;
  if (
    (value.passed && value.failureStage !== null)
    || (!value.passed && value.failureStage === null)
  ) return false;

  return isSmokeObserved(value.observed);
}

async function exerciseMissionLifecycle(
  runRoot: string,
  runId: string,
  clock: MonotonicClock,
): Promise<{
  binding: MissionContractBinding;
  proposalUnbound: boolean;
  confirmAmend: boolean;
  staleBindingRejected: boolean;
  eventCount: number;
  revision: number;
}> {
  let idSequence = 0;
  const newId = (kind: MissionContractIdKind): string =>
    `${runId}-${kind}-${++idSequence}`;
  const contract = smokeMissionContract();
  const first = await MissionContractController.open({
    privateWorkspaceRoot: runRoot,
    now: clock.nextIso,
    newId,
  });
  const firstProposal = await first.recordLocalProposal({
    missionId: `mission-${runId}`,
    expectedBaseBindingSha256: first.currentBindingSha256(),
    contract,
  });
  if (firstProposal.event.type !== "missionContractProposed") {
    throw new Error("Synthetic proposal did not produce the expected event.");
  }
  const proposalUnbound = firstProposal.snapshot.binding.state === "unbound";
  const firstProposalId = firstProposal.event.proposalId;

  const second = await MissionContractController.open({
    privateWorkspaceRoot: runRoot,
    now: clock.nextIso,
    newId,
  });
  const secondSawPending = second.currentSnapshot().proposals.some(
    (proposal) =>
      proposal.status === "pending"
      && proposal.proposal.proposalId === firstProposalId,
  );
  const firstConfirmation = await first.confirmProposalAfterLocalApproval({
    proposalId: firstProposal.event.proposalId,
    expectedDocumentSha256: firstProposal.event.documentSha256,
    expectedBaseBindingSha256:
      firstProposal.snapshot.binding.bindingSha256,
  });
  if (firstConfirmation.snapshot.binding.state !== "active") {
    throw new Error("Synthetic Mission confirmation did not activate.");
  }
  const firstBinding = firstConfirmation.snapshot.binding;
  const refreshed = await second.refresh();
  const secondSawConfirmation =
    refreshed.binding.state === "active"
    && refreshed.binding.bindingSha256 === firstBinding.bindingSha256;

  const amendment = await first.recordLocalProposal({
    expectedBaseBindingSha256: firstBinding.bindingSha256,
    expectedDocumentSha256: firstBinding.documentSha256,
    contract,
  });
  if (amendment.event.type !== "missionContractProposed") {
    throw new Error("Synthetic amendment did not produce a proposal.");
  }
  const amended = await first.confirmProposalAfterLocalApproval({
    proposalId: amendment.event.proposalId,
    expectedDocumentSha256: amendment.event.documentSha256,
    expectedBaseBindingSha256: firstBinding.bindingSha256,
  });
  if (amended.snapshot.binding.state !== "active") {
    throw new Error("Synthetic Mission amendment did not activate.");
  }
  const finalBinding = amended.snapshot.binding;

  let staleBindingRejected = false;
  try {
    await second.assertCurrentBinding(firstBinding.bindingSha256);
  } catch (error) {
    staleBindingRejected =
      error instanceof MissionContractBindingConflictError;
  }
  const finalRefresh = await second.refresh();
  let gateVisits = 0;
  await second.withCurrentBinding(
    finalBinding.bindingSha256,
    async () => {
      gateVisits += 1;
    },
  );

  const ledger = await loadMissionContractLedger(first.ledgerPath);
  const confirmAmend =
    secondSawPending
    && secondSawConfirmation
    && finalRefresh.binding.state === "active"
    && finalRefresh.binding.bindingSha256 === finalBinding.bindingSha256
    && firstBinding.documentSha256 === finalBinding.documentSha256
    && firstBinding.bindingSha256 !== finalBinding.bindingSha256
    && firstBinding.revision === 1
    && finalBinding.revision === 2
    && gateVisits === 1;

  return {
    binding: finalBinding,
    proposalUnbound,
    confirmAmend,
    staleBindingRejected,
    eventCount: ledger.events.length,
    revision: finalBinding.revision,
  };
}

async function exerciseFlightLifecycle(
  runtime: FlightRecorderRuntime,
  runRoot: string,
  mirrorPath: string,
  traceId: string,
  runId: string,
  binding: Extract<MissionContractBinding, { state: "active" }>,
  clock: MonotonicClock,
): Promise<{
  replay: FlightTraceReplay | undefined;
  phaseTransition: boolean;
  usage: boolean;
  verification: boolean;
  nativeAction: boolean;
  complete: boolean;
  metadataOnly: boolean;
  operationKinds: FlightOperationKind[];
  recordOrder: string[];
}> {
  const room = await runtime.beginRoomTurn({
    traceId,
    roomTurnId: `room-${runId}`,
    phase: "Opener",
    missionDocumentSha256: binding.documentSha256,
    missionBindingSha256: binding.bindingSha256,
    source: "system",
    baseRevisionSha: null,
  });
  const phaseAdmitted = await runtime.recordPhaseTransition(room, {
    fromPhase: "Idle",
    toPhase: "Opener",
    trigger: "diagnosticSmoke",
    occurredAt: clock.nextIso(),
  });

  const steeringChain: FlightSteeringChainMetadata = {
    sha256: smokeSha256("steering-chain"),
    indeterminate: false,
  };
  const syntheticRunId = `synthetic-${runId}`;
  const agent = await runtime.beginAgentRun(room, {
    runId: syntheticRunId,
    headId: "smoke",
    agentKind: "diagnostic",
    phase: "opener",
    provider: "hydra",
    model: "diagnostic-none",
    plannedTransport: "notSubmitted",
    authorityClass: "readOnly",
    authoritySha256: smokeSha256("authority"),
    promptSha256: smokeSha256(
      `prompt:${PRIVATE_CONTENT_CANARY}`,
    ),
    contextSha256: smokeSha256(
      `context:${PRIVATE_CONTENT_CANARY}`,
    ),
    promptCharacters: PRIVATE_CONTENT_CANARY.length,
    telemetryDetail: "notApplicable",
    initialSteeringChain: steeringChain,
    evidenceClass: "hydraObserved",
  });

  const usage = await runtime.beginAuxiliaryOperation(room, {
    parentOperationId: agent.operationId,
    subject: {
      kind: "usage",
      usageId: `usage-${runId}`,
      runId: syntheticRunId,
      model: "diagnostic-none",
      source: "computed",
      evidenceClass: "hydraObserved",
    },
  });
  const usageFinished = await runtime.finishAuxiliaryOperation(usage, {
    status: "succeeded",
    failureCode: null,
    observation: {
      kind: "usage",
      observationType: "usageSummary",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      totalCostUsd: 0,
      costSource: "computed",
      steeringChain,
      evidenceClass: "hydraObserved",
    },
  });
  const agentFinished = await runtime.finishAgentRun(agent, {
    status: "succeeded",
    failureCode: null,
    output: {
      bytes: 0,
      sha256: smokeSha256(""),
    },
    terminalSteeringChain: steeringChain,
    actualTransport: "notSubmitted",
    evidenceClass: "hydraObserved",
  });

  const verification = await runtime.beginAuxiliaryOperation(room, {
    subject: {
      kind: "verification",
      verificationId: `verification-${runId}`,
      planSha256: smokeSha256(
        `verification-plan:${PRIVATE_CONTENT_CANARY}`,
      ),
      invocationShapeSha256: smokeSha256(
        `verification-shape:${PRIVATE_CONTENT_CANARY}`,
      ),
      sourceRunId: syntheticRunId,
      sourceSteeringChain: steeringChain,
      evidenceClass: "hydraObserved",
    },
  });
  const verificationFinished = await runtime.finishAuxiliaryOperation(
    verification,
    {
      status: "succeeded",
      failureCode: null,
      observation: {
        kind: "verification",
        observationType: "verificationReceipt",
        receiptSha256: smokeSha256(
          `verification-receipt:${PRIVATE_CONTENT_CANARY}`,
        ),
        headRevisionSha: null,
        exitCode: 0,
        stdout: {
          bytes: Buffer.byteLength(PRIVATE_CONTENT_CANARY, "utf8"),
          sha256: smokeSha256(PRIVATE_CONTENT_CANARY),
        },
        stderr: {
          bytes: 0,
          sha256: smokeSha256(""),
        },
        sourceSteeringChain: steeringChain,
        evidenceClass: "hydraObserved",
      },
    },
  );

  const nativeAction = await runtime.beginAuxiliaryOperation(room, {
    subject: {
      kind: "nativeAction",
      nativeActionId: `native-${runId}`,
      actionKind: "command",
      headCount: 0,
      attachmentCount: 0,
      evidenceClass: "hydraObserved",
    },
  });
  const nativeActionFinished = await runtime.finishAuxiliaryOperation(
    nativeAction,
    {
      status: "succeeded",
      failureCode: null,
      observation: {
        kind: "nativeAction",
        observationType: "nativeActionReceipt",
        receiptSha256: smokeSha256(
          `native-receipt:${PRIVATE_CONTENT_CANARY}`,
        ),
        status: "recorded",
        evidenceClass: "hydraObserved",
      },
    },
  );

  const roomFinished = await runtime.finishRoomTurn(room, {
    status: "succeeded",
    failureCode: null,
  });
  const replay = await runtime.inspectTrace(traceId);
  const recordOrder = replay?.records.map(recordOrderKey) ?? [];
  const operationKinds = uniqueOperationKinds(replay?.records ?? []);
  const phaseTransition = phaseAdmitted
    && hasObservation(replay, "phaseTransition");
  const usageRecorded = usageFinished
    && hasObservation(replay, "usageSummary")
    && usageChainMatchesAgentFinish(replay, steeringChain.sha256);
  const verificationRecorded = verificationFinished
    && hasObservation(replay, "verificationReceipt");
  const nativeActionRecorded = nativeActionFinished
    && hasObservation(replay, "nativeActionReceipt");
  const complete = room.recorded
    && agent.recorded
    && usage.recorded
    && verification.recorded
    && nativeAction.recorded
    && agentFinished
    && roomFinished
    && replay?.state === "finished"
    && replay.completeness === "complete"
    && replay.openOperationCount === 0
    && replay.records.every(
      (record) =>
        record.missionBindingSha256 === binding.bindingSha256,
    )
    && arraysEqual(recordOrder, EXPECTED_RECORD_ORDER);

  const traceText = await readFileHead(
    flightTracePath(runRoot, traceId),
    MAX_INSPECTION_BYTES,
  );
  const mirror = await readFileHead(mirrorPath, MAX_INSPECTION_BYTES);
  const metadataOnly =
    !traceText.truncated
    && !mirror.truncated
    && !traceText.text.includes(PRIVATE_CONTENT_CANARY)
    && !mirror.text.includes(PRIVATE_CONTENT_CANARY)
    && !mirror.text.includes(binding.bindingSha256)
    && !traceText.text.includes("\"argv\"")
    && !traceText.text.includes("\"env\"")
    && !traceText.text.includes("\"promptBody\"")
    && !traceText.text.includes("\"resultBody\"");

  return {
    replay,
    phaseTransition,
    usage: usageRecorded,
    verification: verificationRecorded,
    nativeAction: nativeActionRecorded,
    complete,
    metadataOnly,
    operationKinds,
    recordOrder,
  };
}

function smokeMissionContract(): MissionContractDocument {
  return normalizeMissionContract({
    schemaVersion: MISSION_CONTRACT_SCHEMA_VERSION,
    title: "Mission and Flight Recorder isolated smoke",
    outcome:
      "Validate private Mission binding and metadata-only Flight lifecycles without external work.",
    acceptanceChecks: [{
      id: "smoke-report",
      kind: "manual",
      label: "Inspect the bounded smoke report",
      instructions:
        "Confirm every isolated Mission and Flight lifecycle check passed.",
    }],
    protectedPaths: [],
    allowedMutations: [],
    budgets: {
      maxCostUsd: 0,
      maxAgentCalls: 0,
      maxWallClockMs: 10_000,
      maxRetries: 0,
    },
    evidenceRequirements: [{
      id: "smoke-human-check",
      kind: "humanDecision",
      description:
        "The local operator may inspect the sanitized latest report.",
      acceptanceCheckIds: ["smoke-report"],
    }],
    nonGoals: [
      "No provider, verifier, browser, workspace mutation, or live authority work.",
    ],
  });
}

async function prepareSmokeStorage(
  privateWorkspaceRoot: string,
): Promise<SmokeStorage> {
  const privateRoot = path.resolve(privateWorkspaceRoot);
  await fs.mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await assertRealDirectory(privateRoot);
  const realPrivateRoot = await fs.realpath(privateRoot);

  const diagnosticsRoot = path.resolve(
    missionFlightSmokeDiagnosticsRoot(privateRoot),
  );
  const runsRoot = path.join(diagnosticsRoot, "runs");
  await fs.mkdir(runsRoot, { recursive: true, mode: 0o700 });
  await assertRealDirectory(diagnosticsRoot);
  await assertRealDirectory(runsRoot);
  const realDiagnosticsRoot = await fs.realpath(diagnosticsRoot);
  const realRunsRoot = await fs.realpath(runsRoot);
  if (
    !isPathWithin(realPrivateRoot, realDiagnosticsRoot)
    || !isPathWithin(realDiagnosticsRoot, realRunsRoot)
  ) {
    throw new Error("Smoke storage escaped its private root.");
  }

  const runRoot = await fs.mkdtemp(path.join(runsRoot, "run-"));
  await assertRealDirectory(runRoot);
  const realRunRoot = await fs.realpath(runRoot);
  if (
    !samePath(path.dirname(path.resolve(runRoot)), runsRoot)
    || !samePath(path.dirname(realRunRoot), realRunsRoot)
  ) {
    throw new Error("Smoke run storage is not a direct private child.");
  }
  await fs.chmod(runRoot, 0o700).catch(() => undefined);
  return {
    diagnosticsRoot,
    runsRoot,
    realRunsRoot,
    runRoot,
  };
}

async function removeExactSmokeRun(storage: SmokeStorage): Promise<boolean> {
  const resolvedRun = path.resolve(storage.runRoot);
  if (!samePath(path.dirname(resolvedRun), storage.runsRoot)) return false;
  let before;
  try {
    before = await fs.lstat(resolvedRun);
    if (!before.isDirectory() || before.isSymbolicLink()) return false;
    const realRun = await fs.realpath(resolvedRun);
    if (!samePath(path.dirname(realRun), storage.realRunsRoot)) return false;
  } catch {
    return false;
  }

  const tombstone = path.join(
    storage.runsRoot,
    `.cleanup-${randomUUID()}`,
  );
  try {
    await fs.rename(resolvedRun, tombstone);
    const moved = await fs.lstat(tombstone);
    if (
      !moved.isDirectory()
      || moved.isSymbolicLink()
      || moved.dev !== before.dev
      || moved.ino !== before.ino
    ) {
      return false;
    }
    const realMoved = await fs.realpath(tombstone);
    if (!samePath(path.dirname(realMoved), storage.realRunsRoot)) {
      return false;
    }
    await fs.rm(tombstone, {
      recursive: true,
      force: false,
      maxRetries: 2,
      retryDelay: 25,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Flight owner disposal intentionally writes its inactive lease in the
 * background. Wait for that fixed private write to settle before renaming the
 * disposable parent; otherwise the late write could recreate the old path.
 */
async function waitForDisposedFlightOwner(
  runRoot: string,
): Promise<boolean> {
  const ownersRoot = path.join(runRoot, "flight", "owners");
  const deadline = Date.now() + OWNER_QUIESCENCE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const entries = await fs.readdir(ownersRoot, {
        withFileTypes: true,
      });
      const leaseFiles = entries.filter((entry) =>
        entry.isFile() && entry.name.endsWith(".v1.json"));
      const hasLockArtifact = entries.some((entry) =>
        entry.name.includes(".lock"));
      if (leaseFiles.length === 1 && !hasLockArtifact) {
        const leasePath = path.join(
          ownersRoot,
          leaseFiles[0]!.name,
        );
        const bounded = await readFileHead(leasePath, 4 * 1024);
        if (!bounded.truncated) {
          const value: unknown = JSON.parse(bounded.text);
          if (
            value
            && typeof value === "object"
            && !Array.isArray(value)
            && (value as { active?: unknown }).active === false
          ) {
            return true;
          }
        }
      }
    } catch {
      // The background inactive-lease replacement may be between names.
    }
    await delay(20);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistLatestReport(
  privateWorkspaceRoot: string,
  report: MissionFlightSmokeReport,
): Promise<void> {
  if (!isMissionFlightSmokeReport(report)) {
    throw new MissionFlightSmokeError("reportInvalid");
  }
  const body = `${JSON.stringify(report)}\n`;
  if (
    Buffer.byteLength(body, "utf8")
      > MISSION_FLIGHT_SMOKE_REPORT_MAX_BYTES
  ) {
    throw new MissionFlightSmokeError("reportInvalid");
  }
  const filePath =
    missionFlightSmokeLatestReportPath(privateWorkspaceRoot);
  try {
    await serializePerFileAcrossProcesses(
      filePath,
      () => atomicWriteFile(filePath, body),
    );
  } catch {
    throw new MissionFlightSmokeError("reportPersistenceFailed");
  }
}

function buildReport(
  runId: string,
  startedAt: string,
  completedAt: string,
  failureStage: MissionFlightSmokeFailureStage | null,
  state: SmokeState,
): MissionFlightSmokeReport {
  const checks: readonly MissionFlightSmokeCheck[] = Object.freeze([
    check(
      "mission-proposal-unbound",
      state.missionProposalUnbound,
      "A proposal remained non-authoritative before its separate synthetic local confirmation.",
    ),
    check(
      "mission-confirm-amend",
      state.missionConfirmAmend,
      "Two isolated controllers observed exact confirmation and an identical-document revision change.",
    ),
    check(
      "mission-stale-binding-rejected",
      state.missionStaleBindingRejected,
      "The previous active binding was rejected after the isolated amendment.",
    ),
    check(
      "flight-phase-transition",
      state.flightPhaseTransition,
      "The accepted synthetic phase transition was recorded beneath the phase operation.",
    ),
    check(
      "flight-usage",
      state.flightUsage,
      "A zero-token, zero-cost usage summary retained the terminal steering-chain binding.",
    ),
    check(
      "flight-verification",
      state.flightVerification,
      "A synthetic hashed verification receipt was recorded without executing a command.",
    ),
    check(
      "flight-native-action",
      state.flightNativeAction,
      "A synthetic native-action receipt was recorded without dispatching native work.",
    ),
    check(
      "flight-complete",
      state.flightComplete,
      "Strict replay produced the expected complete 16-record lifecycle with no open operations.",
    ),
    check(
      "metadata-only",
      state.metadataOnly,
      "Private content canaries, raw execution fields, and Mission hashes were absent from disposable outputs.",
    ),
    check(
      "sandbox-cleanup",
      state.sandboxCleanup,
      "The exact isolated private run child was removed after recorder disposal.",
    ),
  ]);
  const passed = checks.every((item) => item.passed);
  const finalFailureStage = passed
    ? null
    : failureStage ?? "inspection";
  return Object.freeze({
    schemaVersion: MISSION_FLIGHT_SMOKE_SCHEMA_VERSION,
    reportType: SMOKE_REPORT_TYPE,
    runId,
    startedAt,
    completedAt,
    passed,
    failureStage: finalFailureStage,
    checks,
    observed: Object.freeze({
      missionEventCount: state.missionEventCount,
      missionRevision: state.missionRevision,
      flightRecordCount: state.flightRecordCount,
      flightCompleteness: state.flightCompleteness,
      operationKinds: Object.freeze([...state.operationKinds]),
      recordOrder: Object.freeze([...state.recordOrder]),
    }),
  });
}

function check(
  id: MissionFlightSmokeCheckId,
  passed: boolean,
  detail: string,
): MissionFlightSmokeCheck {
  return Object.freeze({ id, passed, detail });
}

function hasObservation(
  replay: FlightTraceReplay | undefined,
  observationType: string,
): boolean {
  return replay?.records.some((record) =>
    record.payload.payloadType === "operationEvent"
    && record.payload.observation.observationType === observationType)
    ?? false;
}

function usageChainMatchesAgentFinish(
  replay: FlightTraceReplay | undefined,
  expectedSha256: string,
): boolean {
  if (!replay) return false;
  const usage = replay.records.find((record) =>
    record.payload.payloadType === "operationEvent"
    && record.payload.observation.observationType === "usageSummary");
  const agent = replay.records.find((record) =>
    record.operationKind === "agentRun"
    && record.payload.payloadType === "operationFinished");
  return usage?.payload.payloadType === "operationEvent"
    && usage.payload.observation.observationType === "usageSummary"
    && usage.payload.observation.steeringChain.sha256 === expectedSha256
    && agent?.payload.payloadType === "operationFinished"
    && agent.payload.steeringChain?.sha256 === expectedSha256;
}

function uniqueOperationKinds(
  records: readonly FlightRecord[],
): FlightOperationKind[] {
  const seen = new Set<FlightOperationKind>();
  for (const record of records) seen.add(record.operationKind);
  return [...seen];
}

function recordOrderKey(record: FlightRecord): string {
  return `${record.recordType}:${record.operationKind}`;
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function smokeSha256(value: string): string {
  return createHash("sha256")
    .update("hydra-mission-flight-smoke-v1", "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function createMonotonicClock(
  source: (() => Date) | undefined,
): MonotonicClock {
  let initial: Date;
  try {
    initial = source?.() ?? new Date();
  } catch {
    initial = new Date();
  }
  const base = Number.isFinite(initial.getTime())
    ? initial.getTime()
    : Date.now();
  let tick = 0;
  const nextDate = (): Date => new Date(base + tick++);
  return {
    nextDate,
    nextIso: () => nextDate().toISOString(),
  };
}

async function assertRealDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Smoke storage requires real directories.");
  }
}

function isSmokeObserved(value: unknown): value is MissionFlightSmokeObserved {
  if (!isExactRecord(value, [
    "missionEventCount",
    "missionRevision",
    "flightRecordCount",
    "flightCompleteness",
    "operationKinds",
    "recordOrder",
  ])) return false;
  if (
    !isNonNegativeSafeInteger(value.missionEventCount)
    || !isNonNegativeSafeInteger(value.missionRevision)
    || !isNonNegativeSafeInteger(value.flightRecordCount)
    || !isCompleteness(value.flightCompleteness)
    || !Array.isArray(value.operationKinds)
    || value.operationKinds.length > 16
    || !value.operationKinds.every(isFlightOperationKind)
    || new Set(value.operationKinds).size !== value.operationKinds.length
    || !Array.isArray(value.recordOrder)
    || value.recordOrder.length > MAX_REPORT_RECORDS
    || !value.recordOrder.every(isBoundedReportText)
  ) return false;
  return value.flightRecordCount === value.recordOrder.length;
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return arraysEqual(actual, expected);
}

function isFailureStage(
  value: unknown,
): value is MissionFlightSmokeFailureStage | null {
  return value === null
    || value === "mission"
    || value === "flight"
    || value === "inspection"
    || value === "cleanup";
}

function isCompleteness(
  value: unknown,
): value is MissionFlightSmokeObserved["flightCompleteness"] {
  return value === "complete"
    || value === "active"
    || value === "limited"
    || value === "incomplete"
    || value === "invalid"
    || value === "missing";
}

function isFlightOperationKind(
  value: unknown,
): value is FlightOperationKind {
  return value === "roomTurn"
    || value === "phase"
    || value === "agentRun"
    || value === "toolCall"
    || value === "editBatch"
    || value === "approval"
    || value === "steeringDelivery"
    || value === "verification"
    || value === "usage"
    || value === "nativeAction"
    || value === "browserAction"
    || value === "replay"
    || value === "evalCase";
}

function isBoundedReportText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_REPORT_TEXT_CHARS
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const time = Date.parse(value);
  return Number.isFinite(time)
    && new Date(time).toISOString() === value;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(normalizePath(root), normalizePath(candidate));
  return relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}

function samePath(left: string, right: string): boolean {
  return normalizePath(path.resolve(left))
    === normalizePath(path.resolve(right));
}

function normalizePath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
