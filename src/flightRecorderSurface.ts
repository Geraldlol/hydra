import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  appendFileSafely,
  atomicWriteFile,
  ensureFile,
  serializePerFileAcrossProcesses,
} from "./fileQueue";
import {
  FLIGHT_SCHEMA_VERSION,
  isFlightTraceId,
  type FlightOperationKind,
  type FlightRecord,
  type FlightTerminalStatus,
  type FlightTraceReplay,
  type FlightTraceStartedPayload,
} from "./flightRecorderProtocol";
import {
  FileFlightRecorderStore,
} from "./flightRecorderStore";
import { UNBOUND_MISSION_BINDING_SHA256 } from "./missionContract";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EVAL_GENESIS_SHA256 = sha256Text("hydra.flight.eval.v1.genesis");
const MAX_SURFACE_TRACES = 100;
const MAX_SURFACE_OPERATIONS = 256;
const MAX_EVAL_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_EVAL_EVENTS = 10_000;
const MAX_EVAL_EVENT_BYTES = 16 * 1024;
const MAX_REPLAY_INPUT_BYTES = 128 * 1024;

export type FlightSurfaceCompleteness =
  | "active"
  | "complete"
  | "limited"
  | "incomplete"
  | "invalid";

export interface FlightTraceChoice {
  readonly traceId: string;
  readonly expectedRootSha256: string;
  readonly expectedMissionBindingSha256: string;
}

export interface FlightSurfaceGate {
  readonly eligible: boolean;
  readonly reason: string;
}

export interface FlightSurfaceOperation {
  readonly operationId: string;
  readonly parentOperationId: string | null;
  readonly operationKind: Exclude<FlightOperationKind, "roomTurn">;
  readonly label: string;
  readonly lifecycle: "open" | FlightTerminalStatus;
  readonly startedSequence: number;
  readonly finishedSequence: number | null;
}

export interface FlightTraceSurfaceEntry extends FlightTraceChoice {
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly source: FlightTraceStartedPayload["source"] | "unknown";
  readonly phase: string;
  readonly completeness: FlightSurfaceCompleteness;
  readonly terminalStatus: FlightTerminalStatus | null;
  readonly recordCount: number;
  readonly operationCount: number;
  readonly openOperationCount: number;
  readonly baseRevisionSha: string | null;
  readonly contentCapture: "off";
  readonly replay: FlightSurfaceGate;
  readonly createEval: FlightSurfaceGate;
  readonly operations: readonly FlightSurfaceOperation[];
  readonly issue: string | null;
}

export interface FlightTraceSurfaceSnapshot {
  readonly status: "idle" | "ready" | "unavailable";
  readonly traces: readonly FlightTraceSurfaceEntry[];
  readonly selectedTraceId: string | null;
  readonly error: string | null;
}

export type FlightEvalOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked";

export interface FlightEvalCreatedEvent {
  readonly schemaVersion: typeof FLIGHT_SCHEMA_VERSION;
  readonly eventType: "evalCaseCreated";
  readonly eventId: string;
  readonly evalCaseId: string;
  readonly caseVersion: 1;
  readonly occurredAt: string;
  readonly sourceTraceId: string;
  readonly sourceRootSha256: string;
  readonly missionBindingSha256: string;
  readonly contractSha256: string;
  readonly acceptancePlanSha256: string;
  readonly expectedOutcome: FlightEvalOutcome;
  readonly outcomeSource: "human";
  readonly previousEventSha256: string;
  readonly eventSha256: string;
}

export interface CreateFlightEvalInput extends FlightTraceChoice {
  readonly currentMissionBindingSha256: string;
  readonly contractSha256: string;
  readonly acceptancePlanSha256: string;
  readonly expectedOutcome: FlightEvalOutcome;
  readonly occurredAt?: string;
  readonly evalCaseId?: string;
  readonly eventId?: string;
}

export interface FlightReplayPlan {
  readonly schemaVersion: typeof FLIGHT_SCHEMA_VERSION;
  readonly replayId: string;
  readonly createdAt: string;
  readonly sourceTraceId: string;
  readonly sourceRootSha256: string;
  readonly missionBindingSha256: string;
  readonly baseRevisionSha: string;
  readonly exactContentAvailable: false;
  readonly contentBinding: "derived";
  readonly replacementInputSha256: string;
  readonly replacementInputBytes: number;
  readonly isolatedWorktree: true;
  readonly worktreePathSha256: string;
}

export interface PrepareFlightReplayInput extends FlightTraceChoice {
  readonly currentMissionBindingSha256: string;
  readonly replacementInput: string;
  readonly workspaceRoot: string;
  readonly privateWorkspaceRoot: string;
  readonly runGit: (
    args: readonly string[],
    cwd: string,
  ) => Promise<void>;
  readonly now?: () => Date;
  readonly replayId?: string;
}

export interface PreparedFlightReplay {
  readonly plan: FlightReplayPlan;
  readonly worktreePath: string;
  /**
   * The replacement body is deliberately returned only in memory. It is never
   * written to Flight storage or the disposable worktree by this workflow.
   */
  readonly replacementInput: string;
}

export class FlightRecorderSurface {
  private constructor(
    readonly privateWorkspaceRoot: string,
    private readonly store: FileFlightRecorderStore,
  ) {}

  static async open(privateWorkspaceRoot: string): Promise<FlightRecorderSurface> {
    // The rebuildable index is deliberately not opened here. Operator
    // eligibility must remain available when that cache is missing, stale, or
    // unsafe; discovery comes only from strictly named authoritative files.
    const store = new FileFlightRecorderStore(privateWorkspaceRoot);
    return new FlightRecorderSurface(path.resolve(privateWorkspaceRoot), store);
  }

  async snapshot(
    currentMissionBindingSha256: string,
    selectedTraceId?: string,
  ): Promise<FlightTraceSurfaceSnapshot> {
    try {
      const entries: FlightTraceSurfaceEntry[] = [];
      // Trace IDs are intentionally opaque and therefore carry no chronology.
      // Validate every bounded authoritative file, then choose the newest
      // projections by recorded time. Slicing the lexicographically sorted IDs
      // would make a random ID, rather than lifecycle evidence, decide what the
      // operator can see.
      const ids = await this.store.listTraceIds();
      for (const traceId of ids) {
        try {
          const replay = await this.store.load(traceId);
          if (replay) {
            entries.push(projectFlightTraceForOperator(
              replay,
              currentMissionBindingSha256,
            ));
          }
        } catch {
          entries.push(invalidTraceEntry(traceId));
        }
      }
      entries.sort(compareSurfaceEntries);
      entries.splice(MAX_SURFACE_TRACES);
      const selected = selectedTraceId
        && entries.some((entry) => entry.traceId === selectedTraceId)
        ? selectedTraceId
        : entries[0]?.traceId ?? null;
      const boundedEntries = entries.map((entry) => entry.traceId === selected
        ? entry
        : freezeSurfaceEntry({ ...entry, operations: Object.freeze([]) }));
      return Object.freeze({
        status: "ready",
        traces: Object.freeze(boundedEntries),
        selectedTraceId: selected,
        error: null,
      });
    } catch {
      return Object.freeze({
        status: "unavailable",
        traces: Object.freeze([]),
        selectedTraceId: null,
        error: "Authoritative Flight traces are unavailable or failed strict validation.",
      });
    }
  }

  async requireExactTrace(
    choice: FlightTraceChoice,
    currentMissionBindingSha256?: string,
  ): Promise<FlightTraceReplay> {
    assertTraceChoice(choice);
    if (currentMissionBindingSha256 !== undefined) {
      assertSha256(currentMissionBindingSha256, "current Mission binding");
    }
    const replay = await this.store.load(choice.traceId);
    if (!replay) throw new Error("The selected Flight trace no longer exists.");
    if (replay.rootRecordSha256 !== choice.expectedRootSha256
      || replay.missionBindingSha256 !== choice.expectedMissionBindingSha256) {
      throw new Error("The selected Flight trace changed; refresh the inspector before continuing.");
    }
    if (currentMissionBindingSha256 !== undefined
      && replay.missionBindingSha256 !== currentMissionBindingSha256) {
      throw new Error("The selected Flight trace is bound to a different Mission Contract revision.");
    }
    return replay;
  }

  async createEval(input: CreateFlightEvalInput): Promise<FlightEvalCreatedEvent> {
    const replay = await this.requireExactTrace(
      input,
      input.currentMissionBindingSha256,
    );
    const projected = projectFlightTraceForOperator(
      replay,
      input.currentMissionBindingSha256,
    );
    if (!projected.createEval.eligible) {
      throw new Error(projected.createEval.reason);
    }
    assertSha256(input.contractSha256, "eval contract");
    assertSha256(input.acceptancePlanSha256, "eval acceptance plan");
    if (!isFlightEvalOutcome(input.expectedOutcome)) {
      throw new Error("Eval expected outcome is invalid.");
    }
    const draft = {
      schemaVersion: FLIGHT_SCHEMA_VERSION,
      eventType: "evalCaseCreated" as const,
      eventId: input.eventId ?? `flight-eval-event-${randomUUID()}`,
      evalCaseId: input.evalCaseId ?? `flight-eval-${randomUUID()}`,
      caseVersion: 1 as const,
      occurredAt: (input.occurredAt === undefined
        ? new Date()
        : new Date(input.occurredAt)).toISOString(),
      sourceTraceId: replay.traceId,
      sourceRootSha256: replay.rootRecordSha256,
      missionBindingSha256: replay.missionBindingSha256,
      contractSha256: input.contractSha256,
      acceptancePlanSha256: input.acceptancePlanSha256,
      expectedOutcome: input.expectedOutcome,
      outcomeSource: "human" as const,
    };
    return appendFlightEvalCreatedEvent(this.privateWorkspaceRoot, draft);
  }

  async prepareReplay(
    input: PrepareFlightReplayInput,
  ): Promise<PreparedFlightReplay> {
    const replay = await this.requireExactTrace(
      input,
      input.currentMissionBindingSha256,
    );
    const projected = projectFlightTraceForOperator(
      replay,
      input.currentMissionBindingSha256,
    );
    if (!projected.replay.eligible) throw new Error(projected.replay.reason);
    if (!projected.baseRevisionSha) {
      throw new Error("Replay requires an exact recorded Git base revision.");
    }
    const replacement = input.replacementInput.trim();
    const replacementBytes = Buffer.byteLength(replacement, "utf8");
    if (replacementBytes === 0 || replacementBytes > MAX_REPLAY_INPUT_BYTES) {
      throw new Error("Derived Replay replacement input must be between 1 byte and 128 KiB.");
    }
    const requestedPrivateRoot = path.resolve(input.privateWorkspaceRoot);
    if (requestedPrivateRoot !== this.privateWorkspaceRoot) {
      throw new Error("Flight Replay private storage binding changed.");
    }
    const replayId = input.replayId ?? `flight-replay-${randomUUID()}`;
    assertIdentifier(replayId, "replay ID");
    const workspaceRoot = path.resolve(input.workspaceRoot);
    const replayRoot = path.resolve(
      this.privateWorkspaceRoot,
      "flight",
      "replays",
      replayId,
    );
    const worktreePath = path.join(replayRoot, "worktree");
    assertOutsideWorkspace(workspaceRoot, replayRoot);
    await ensureNewReplayRoot(this.privateWorkspaceRoot, replayRoot);

    let worktreeRegistered = false;
    try {
      await input.runGit(
        ["worktree", "add", "--detach", worktreePath, projected.baseRevisionSha],
        workspaceRoot,
      );
      worktreeRegistered = true;
      await assertReplayWorktree(replayRoot, worktreePath);
      const plan: FlightReplayPlan = Object.freeze({
        schemaVersion: FLIGHT_SCHEMA_VERSION,
        replayId,
        createdAt: (input.now?.() ?? new Date()).toISOString(),
        sourceTraceId: replay.traceId,
        sourceRootSha256: replay.rootRecordSha256,
        missionBindingSha256: replay.missionBindingSha256,
        baseRevisionSha: projected.baseRevisionSha,
        exactContentAvailable: false,
        contentBinding: "derived",
        replacementInputSha256: sha256Text(replacement),
        replacementInputBytes: replacementBytes,
        isolatedWorktree: true,
        worktreePathSha256: sha256Text(path.resolve(worktreePath)),
      });
      await atomicWriteFile(
        path.join(replayRoot, "plan.v1.json"),
        `${JSON.stringify(plan)}\n`,
      );
      return Object.freeze({
        plan,
        worktreePath,
        replacementInput: replacement,
      });
    } catch (error) {
      if (worktreeRegistered) {
        await input.runGit(
          ["worktree", "remove", "--force", worktreePath],
          workspaceRoot,
        ).catch(() => undefined);
      }
      await fs.rm(replayRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export function projectFlightTraceForOperator(
  replay: FlightTraceReplay,
  currentMissionBindingSha256: string,
): FlightTraceSurfaceEntry {
  assertSha256(currentMissionBindingSha256, "current Mission binding");
  const start = replay.records[0]?.payload;
  const started = start?.payloadType === "traceStarted" ? start : undefined;
  const terminalRecord = replay.records.at(-1);
  const terminalPayload = terminalRecord?.payload.payloadType === "traceFinished"
    ? terminalRecord.payload
    : undefined;
  const phase = replay.records.find((record) =>
    record.payload.payloadType === "operationStarted"
    && record.payload.subject.kind === "phase"
  );
  const phaseLabel = phase?.payload.payloadType === "operationStarted"
    && phase.payload.subject.kind === "phase"
    ? phase.payload.subject.phase
    : "Unknown";
  const exactMission = replay.missionBindingSha256 === currentMissionBindingSha256;
  const activeMission = currentMissionBindingSha256 !== UNBOUND_MISSION_BINDING_SHA256;
  const complete = replay.state === "finished" && replay.completeness === "complete";
  const replayReason = !complete
    ? "Only a complete, strictly validated trace can be replayed."
    : !exactMission
      ? "The current Mission Contract binding differs from this trace."
      : started?.baseRevisionSha === null || started?.baseRevisionSha === undefined
        ? "This trace has no exact Git base revision for an isolated replay."
        : "Eligible for a derived replay after replacement input and local confirmation.";
  const evalReason = !complete
    ? "Only a complete, strictly validated trace can create an eval case."
    : !exactMission
      ? "The current Mission Contract binding differs from this trace."
      : !activeMission
        ? "Create Eval requires an active Mission Contract."
      : "Eligible for a human-adjudicated eval case.";

  return freezeSurfaceEntry({
    traceId: replay.traceId,
    expectedRootSha256: replay.rootRecordSha256,
    expectedMissionBindingSha256: replay.missionBindingSha256,
    startedAt: replay.records[0]?.occurredAt ?? null,
    finishedAt: terminalPayload ? terminalRecord?.occurredAt ?? null : null,
    source: started?.source ?? "unknown",
    phase: phaseLabel,
    completeness: replay.completeness,
    terminalStatus: terminalPayload?.status ?? null,
    recordCount: replay.records.length,
    operationCount: replay.operationCount,
    openOperationCount: replay.openOperationCount,
    baseRevisionSha: started?.baseRevisionSha ?? null,
    contentCapture: "off",
    replay: Object.freeze({
      eligible: complete && exactMission && started?.baseRevisionSha != null,
      reason: replayReason,
    }),
    createEval: Object.freeze({
      eligible: complete && exactMission && activeMission,
      reason: evalReason,
    }),
    operations: Object.freeze(boundedSurfaceOperations(projectOperations(replay))),
    issue: null,
  });
}

function projectOperations(replay: FlightTraceReplay): FlightSurfaceOperation[] {
  const recordsBySequence = new Map<number, FlightRecord>(
    replay.records.map((record) => [record.sequence, record]),
  );
  return replay.operations.map((operation) => {
    const start = recordsBySequence.get(operation.startedSequence);
    const finish = operation.finishedSequence === undefined
      ? undefined
      : recordsBySequence.get(operation.finishedSequence);
    const lifecycle = finish?.payload.payloadType === "operationFinished"
      ? finish.payload.status
      : "open";
    return Object.freeze({
      operationId: operation.operationId,
      parentOperationId: operation.parentOperationId ?? null,
      operationKind: operation.operationKind,
      label: safeOperationLabel(start),
      lifecycle,
      startedSequence: operation.startedSequence,
      finishedSequence: operation.finishedSequence ?? null,
    });
  });
}

function boundedSurfaceOperations(
  operations: readonly FlightSurfaceOperation[],
): readonly FlightSurfaceOperation[] {
  if (operations.length <= MAX_SURFACE_OPERATIONS) return operations;
  const first = Math.floor(MAX_SURFACE_OPERATIONS / 2);
  return [
    ...operations.slice(0, first),
    ...operations.slice(operations.length - (MAX_SURFACE_OPERATIONS - first)),
  ];
}

function safeOperationLabel(record: FlightRecord | undefined): string {
  if (record?.payload.payloadType !== "operationStarted") return "Recorded operation";
  const subject = record.payload.subject;
  switch (subject.kind) {
    case "phase":
      return subject.phase;
    case "agentRun":
      return `${subject.headId} · ${subject.phase} · ${subject.provider}/${subject.model}`;
    case "toolCall":
      return `${subject.provider} · ${subject.toolName}`;
    case "editBatch":
      return `${subject.provider} · ${subject.pathCount} paths`;
    case "approval":
      return `${subject.approvalKind} approval · ${subject.source}`;
    case "steeringDelivery":
      return `steering ${subject.sequence} · ${subject.deliveryClass}`;
    case "verification":
      return "verification receipt";
    case "usage":
      return `${subject.model} · ${subject.source} usage`;
    case "nativeAction":
      return `${subject.actionKind} · ${subject.headCount} heads`;
    case "browserAction":
      return `${subject.action} · ${subject.approvalRequired ? "approval required" : "read only"}`;
    case "replay":
      return subject.exactContentAvailable ? "exact replay" : "derived replay";
    case "evalCase":
      return `${subject.outcomeSource} eval · version ${subject.caseVersion}`;
  }
}

async function appendFlightEvalCreatedEvent(
  privateWorkspaceRoot: string,
  draft: Omit<FlightEvalCreatedEvent, "previousEventSha256" | "eventSha256">,
): Promise<FlightEvalCreatedEvent> {
  const ledgerPath = flightEvalLedgerPath(privateWorkspaceRoot);
  return serializePerFileAcrossProcesses(ledgerPath, async () => {
    await ensureFile(ledgerPath);
    const before = await fs.readFile(ledgerPath, "utf8");
    const existing = parseFlightEvalLedger(before);
    if (existing.some((event) => event.evalCaseId === draft.evalCaseId)) {
      throw new Error("Flight eval case ID already exists.");
    }
    const previousEventSha256 = existing.at(-1)?.eventSha256
      ?? EVAL_GENESIS_SHA256;
    const withoutHash = Object.freeze({ ...draft, previousEventSha256 });
    const event: FlightEvalCreatedEvent = Object.freeze({
      ...withoutHash,
      eventSha256: flightEvalEventSha256(withoutHash),
    });
    const line = `${JSON.stringify(event)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > MAX_EVAL_EVENT_BYTES
      || existing.length + 1 > MAX_EVAL_EVENTS
      || Buffer.byteLength(before, "utf8") + lineBytes > MAX_EVAL_LEDGER_BYTES) {
      throw new Error("Flight eval ledger reached its bounded capacity.");
    }
    await appendFileSafely(ledgerPath, line);
    return event;
  });
}

export function flightEvalLedgerPath(privateWorkspaceRoot: string): string {
  return path.resolve(privateWorkspaceRoot, "flight", "evals", "events.v1.jsonl");
}

export function parseFlightEvalLedger(text: string): readonly FlightEvalCreatedEvent[] {
  if (text.length === 0) return Object.freeze([]);
  if (!text.endsWith("\n")) throw new Error("Flight eval ledger is torn.");
  if (Buffer.byteLength(text, "utf8") > MAX_EVAL_LEDGER_BYTES) {
    throw new Error("Flight eval ledger exceeds its byte bound.");
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > MAX_EVAL_EVENTS) {
    throw new Error("Flight eval ledger exceeds its record bound.");
  }
  const events: FlightEvalCreatedEvent[] = [];
  let previous = EVAL_GENESIS_SHA256;
  const eventIds = new Set<string>();
  const caseIds = new Set<string>();
  for (const line of lines) {
    if (Buffer.byteLength(`${line}\n`, "utf8") > MAX_EVAL_EVENT_BYTES) {
      throw new Error("Flight eval event exceeds its record bound.");
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("Flight eval ledger contains malformed JSON.");
    }
    if (!isFlightEvalCreatedEvent(value)) {
      throw new Error("Flight eval ledger contains an invalid event.");
    }
    if (JSON.stringify(value) !== line) {
      throw new Error("Flight eval ledger contains non-canonical JSON.");
    }
    if (value.previousEventSha256 !== previous
      || value.eventSha256 !== flightEvalEventSha256(withoutEventHash(value))) {
      throw new Error("Flight eval ledger hash chain is invalid.");
    }
    if (eventIds.has(value.eventId) || caseIds.has(value.evalCaseId)) {
      throw new Error("Flight eval ledger contains a duplicate identifier.");
    }
    eventIds.add(value.eventId);
    caseIds.add(value.evalCaseId);
    previous = value.eventSha256;
    events.push(Object.freeze({ ...value }));
  }
  return Object.freeze(events);
}

function isFlightEvalCreatedEvent(value: unknown): value is FlightEvalCreatedEvent {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const expected = [
    "schemaVersion",
    "eventType",
    "eventId",
    "evalCaseId",
    "caseVersion",
    "occurredAt",
    "sourceTraceId",
    "sourceRootSha256",
    "missionBindingSha256",
    "contractSha256",
    "acceptancePlanSha256",
    "expectedOutcome",
    "outcomeSource",
    "previousEventSha256",
    "eventSha256",
  ];
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
    && value.schemaVersion === FLIGHT_SCHEMA_VERSION
    && value.eventType === "evalCaseCreated"
    && isIdentifier(value.eventId)
    && isIdentifier(value.evalCaseId)
    && value.caseVersion === 1
    && isIso(value.occurredAt)
    && isFlightTraceId(value.sourceTraceId)
    && isSha256(value.sourceRootSha256)
    && isSha256(value.missionBindingSha256)
    && isSha256(value.contractSha256)
    && isSha256(value.acceptancePlanSha256)
    && isFlightEvalOutcome(value.expectedOutcome)
    && value.outcomeSource === "human"
    && isSha256(value.previousEventSha256)
    && isSha256(value.eventSha256);
}

function withoutEventHash(
  event: FlightEvalCreatedEvent,
): Omit<FlightEvalCreatedEvent, "eventSha256"> {
  const { eventSha256: _eventSha256, ...rest } = event;
  return rest;
}

function flightEvalEventSha256(value: unknown): string {
  return sha256Text(`hydra.flight.eval.v1.event\u0000${JSON.stringify(value)}`);
}

function invalidTraceEntry(traceId: string): FlightTraceSurfaceEntry {
  const unavailable: FlightSurfaceGate = Object.freeze({
    eligible: false,
    reason: "This trace failed strict validation.",
  });
  return freezeSurfaceEntry({
    traceId,
    expectedRootSha256: "0".repeat(64),
    expectedMissionBindingSha256: "0".repeat(64),
    startedAt: null,
    finishedAt: null,
    source: "unknown",
    phase: "Unknown",
    completeness: "invalid",
    terminalStatus: null,
    recordCount: 0,
    operationCount: 0,
    openOperationCount: 0,
    baseRevisionSha: null,
    contentCapture: "off",
    replay: unavailable,
    createEval: unavailable,
    operations: Object.freeze([]),
    issue: "Strict replay rejected this private trace. It cannot drive Replay or Create Eval.",
  });
}

function freezeSurfaceEntry(entry: FlightTraceSurfaceEntry): FlightTraceSurfaceEntry {
  return Object.freeze({
    ...entry,
    replay: Object.freeze({ ...entry.replay }),
    createEval: Object.freeze({ ...entry.createEval }),
    operations: Object.freeze(entry.operations.map((operation) =>
      Object.freeze({ ...operation })
    )),
  });
}

function compareSurfaceEntries(
  left: FlightTraceSurfaceEntry,
  right: FlightTraceSurfaceEntry,
): number {
  return (right.finishedAt ?? right.startedAt ?? "")
    .localeCompare(left.finishedAt ?? left.startedAt ?? "")
    || right.traceId.localeCompare(left.traceId);
}

async function ensureNewReplayRoot(
  privateWorkspaceRoot: string,
  replayRoot: string,
): Promise<void> {
  await fs.mkdir(privateWorkspaceRoot, { recursive: true });
  await assertPrivateDirectory(privateWorkspaceRoot, privateWorkspaceRoot);
  let current = privateWorkspaceRoot;
  for (const segment of ["flight", "replays"]) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current, { recursive: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertPrivateDirectory(privateWorkspaceRoot, current);
  }
  try {
    await fs.mkdir(replayRoot, { recursive: false });
  } catch {
    throw new Error("Flight Replay ID already exists or private storage is unavailable.");
  }
  await assertPrivateDirectory(privateWorkspaceRoot, replayRoot);
}

async function assertReplayWorktree(
  replayRoot: string,
  worktreePath: string,
): Promise<void> {
  await assertPrivateDirectory(replayRoot, worktreePath);
}

async function assertPrivateDirectory(
  boundaryRoot: string,
  candidate: string,
): Promise<void> {
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Flight Replay private storage contains an unsafe linked directory.");
  }
  const boundaryStat = candidate === boundaryRoot
    ? stat
    : await fs.lstat(boundaryRoot);
  if (boundaryStat.isSymbolicLink() || !boundaryStat.isDirectory()) {
    throw new Error("Flight Replay private storage boundary changed.");
  }
  const [realBoundary, realCandidate] = await Promise.all([
    fs.realpath(boundaryRoot),
    fs.realpath(candidate),
  ]);
  if (!pathContains(realBoundary, realCandidate)) {
    throw new Error("Flight Replay private storage escapes its bound root.");
  }
}

function assertOutsideWorkspace(workspaceRoot: string, replayRoot: string): void {
  if (pathContains(workspaceRoot, replayRoot)
    || pathContains(replayRoot, workspaceRoot)) {
    throw new Error("Flight Replay worktrees must live outside the source workspace.");
  }
}

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function assertTraceChoice(choice: FlightTraceChoice): void {
  if (!isFlightTraceId(choice.traceId)) throw new Error("Flight trace ID is invalid.");
  assertSha256(choice.expectedRootSha256, "Flight trace root");
  assertSha256(choice.expectedMissionBindingSha256, "Flight Mission binding");
}

function assertSha256(value: string, label: string): void {
  if (!isSha256(value)) throw new Error(`${label} SHA-256 is invalid.`);
}

function assertIdentifier(value: string, label: string): void {
  if (!isIdentifier(value)) throw new Error(`Flight ${label} is invalid.`);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && value.trim() === value
    && !/[\\/\u0000-\u001f\u007f]/u.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isFlightEvalOutcome(value: unknown): value is FlightEvalOutcome {
  return value === "succeeded"
    || value === "failed"
    || value === "cancelled"
    || value === "blocked";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export const FLIGHT_SURFACE_LIMITS = Object.freeze({
  maxTraces: MAX_SURFACE_TRACES,
  maxOperationsPerTrace: MAX_SURFACE_OPERATIONS,
  maxEvalLedgerBytes: MAX_EVAL_LEDGER_BYTES,
  maxEvalEvents: MAX_EVAL_EVENTS,
  maxEvalEventBytes: MAX_EVAL_EVENT_BYTES,
  maxReplayInputBytes: MAX_REPLAY_INPUT_BYTES,
});
