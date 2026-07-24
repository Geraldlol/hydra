import { randomUUID } from "node:crypto";
import { atomicWriteFile } from "./fileQueue";
import {
  FlightTraceValidationError,
  type FlightEvidenceClass,
  type FlightFailureCode,
  type FlightLimitReason,
  type FlightOperationKind,
  type FlightOperationObservation,
  type FlightOperationSubject,
  type FlightOutputMetadata,
  type FlightRecord,
  type FlightRecordDraft,
  type FlightSteeringChainMetadata,
  type FlightTerminalStatus,
  type FlightTraceFinishedPayload,
  type FlightTraceReplay,
  type FlightTraceStartedPayload,
} from "./flightRecorderProtocol";
import {
  FlightTraceCapacityError,
  FlightTraceFileError,
  type FlightRecorderStore,
} from "./flightRecorderStore";

export type FlightCompleteness =
  | "active"
  | "complete"
  | "limited"
  | "incomplete"
  | "invalid";

export type FlightHealthNoticeCode =
  | "startFailed"
  | "eventFailed"
  | "finishFailed"
  | "capacityReached"
  | "openOperationLimit"
  | "invalidTrace"
  | "indexFailed"
  | "mirrorFailed";

export interface FlightRecorderHealth {
  readonly traceId: string;
  readonly completeness: FlightCompleteness;
  readonly persistedRecords: number;
  readonly droppedRecords: number;
  readonly finalized: boolean;
  readonly indexHealthy: boolean;
  readonly mirrorHealthy: boolean;
  readonly noticeCode?: FlightHealthNoticeCode;
}

export interface FlightRecorderHealthNotice {
  readonly traceId: string;
  readonly code: FlightHealthNoticeCode;
  readonly completeness: FlightCompleteness;
}

export interface FlightRecorderReceipt {
  readonly ok: boolean;
  readonly traceId: string;
  readonly record?: FlightRecord;
  readonly health: FlightRecorderHealth;
}

export interface StartFlightTraceInput {
  readonly traceId: string;
  readonly roomTurnId: string;
  readonly ownerId: string;
  readonly missionDocumentSha256: string | null;
  readonly missionBindingSha256: string;
  readonly source: FlightTraceStartedPayload["source"];
  readonly baseRevisionSha: string | null;
  readonly occurredAt?: string;
  readonly recordId?: string;
}

export interface StartFlightOperationInput {
  readonly traceId: string;
  readonly operationId: string;
  readonly parentOperationId?: string;
  readonly operationKind: Exclude<FlightOperationKind, "roomTurn">;
  readonly subject: FlightOperationSubject;
  readonly missionBindingSha256?: string;
  readonly occurredAt?: string;
  readonly recordId?: string;
}

export interface RecordFlightOperationEventInput {
  readonly traceId: string;
  readonly operationId: string;
  readonly parentOperationId?: string;
  readonly operationKind: Exclude<FlightOperationKind, "roomTurn">;
  readonly observation: FlightOperationObservation;
  readonly missionBindingSha256?: string;
  readonly occurredAt?: string;
  readonly recordId?: string;
}

export interface FinishFlightOperationInput {
  readonly traceId: string;
  readonly operationId: string;
  readonly parentOperationId?: string;
  readonly operationKind: Exclude<FlightOperationKind, "roomTurn">;
  readonly status: FlightTerminalStatus;
  readonly durationMs: number;
  readonly failureCode: FlightFailureCode | null;
  readonly output: FlightOutputMetadata | null;
  /**
   * Required by the protocol for agentRun completion. This is the terminal
   * acknowledged steering-chain binding, including delivery-unknown state.
   */
  readonly steeringChain: FlightSteeringChainMetadata | null;
  /** Exact transport attempted; required for agentRun and null otherwise. */
  readonly actualTransport: string | null;
  readonly evidenceClass: FlightEvidenceClass;
  readonly missionBindingSha256?: string;
  readonly occurredAt?: string;
  readonly recordId?: string;
}

export interface LimitFlightTraceInput {
  readonly traceId: string;
  readonly reason: FlightLimitReason;
  readonly droppedRecordsAtLeast: number;
  readonly occurredAt?: string;
  readonly recordId?: string;
}

export interface FinishFlightTraceInput {
  readonly traceId: string;
  readonly status: Exclude<FlightTerminalStatus, "incomplete"> | "incomplete";
  readonly durationMs: number;
  readonly incomplete?: boolean;
  readonly occurredAt?: string;
  readonly recordId?: string;
}

export interface FlightRecorderControllerDependencies {
  readonly store: FlightRecorderStore;
  readonly now?: () => string;
  readonly newRecordId?: (prefix: string) => string;
  readonly onHealthNotice?: (notice: FlightRecorderHealthNotice) => void;
  /**
   * A rebuildable discovery projection. Failure never changes trace authority.
   */
  readonly refreshIndex?: () => Promise<void>;
  /**
   * A disposable one-way projection. Failure never changes trace authority.
   */
  readonly writeMirror?: (replay: FlightTraceReplay) => Promise<void>;
}

interface MutableHealth {
  traceId: string;
  completeness: FlightCompleteness;
  persistedRecords: number;
  droppedRecords: number;
  finalized: boolean;
  indexHealthy: boolean;
  mirrorHealthy: boolean;
  noticeCode?: FlightHealthNoticeCode;
  noticeEmitted: boolean;
}

/**
 * Nonthrowing integration facade. Persistence failures latch degradation and
 * return a sanitized receipt; a failed record is never silently retried.
 */
export class FlightRecorderController {
  private readonly store: FlightRecorderStore;
  private readonly now: () => string;
  private readonly newRecordId: (prefix: string) => string;
  private readonly onHealthNotice?: (notice: FlightRecorderHealthNotice) => void;
  private readonly refreshIndex?: () => Promise<void>;
  private readonly writeMirror?: (replay: FlightTraceReplay) => Promise<void>;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly derivedQueues = new Map<string, Promise<void>>();
  private readonly healthByTrace = new Map<string, MutableHealth>();

  constructor(dependencies: FlightRecorderControllerDependencies) {
    this.store = dependencies.store;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.newRecordId = dependencies.newRecordId
      ?? ((prefix) => `${prefix}-${randomUUID()}`);
    this.onHealthNotice = dependencies.onHealthNotice;
    this.refreshIndex = dependencies.refreshIndex;
    this.writeMirror = dependencies.writeMirror;
  }

  startTrace(input: StartFlightTraceInput): Promise<FlightRecorderReceipt> {
    const health = this.ensureHealth(input.traceId);
    return this.enqueue(input.traceId, async () => {
      if (health.completeness !== "active" || health.persistedRecords > 0) {
        return this.dropReceipt(health, "startFailed");
      }
      return this.appendNonthrowing({
        recordId: input.recordId ?? this.newRecordId("flight-trace-start"),
        traceId: input.traceId,
        occurredAt: input.occurredAt ?? this.now(),
        recordType: "traceStarted",
        operationKind: "roomTurn",
        missionBindingSha256: input.missionBindingSha256,
        payload: {
          payloadType: "traceStarted",
          roomTurnId: input.roomTurnId,
          ownerId: input.ownerId,
          source: input.source,
          contentCapture: "off",
          baseRevisionSha: input.baseRevisionSha,
          missionDocumentSha256: input.missionDocumentSha256,
          missionBindingSha256: input.missionBindingSha256,
        },
      }, health, "startFailed");
    });
  }

  startOperation(input: StartFlightOperationInput): Promise<FlightRecorderReceipt> {
    return this.enqueue(input.traceId, async () => {
      const health = this.ensureHealth(input.traceId);
      const binding = await this.resolveMissionBinding(
        input.traceId,
        input.missionBindingSha256,
        health,
      );
      if (!binding) return this.dropReceipt(health, "eventFailed");
      return this.appendNonthrowing({
        recordId: input.recordId ?? this.newRecordId("flight-operation-start"),
        traceId: input.traceId,
        occurredAt: input.occurredAt ?? this.now(),
        recordType: "operationStarted",
        operationKind: input.operationKind,
        operationId: input.operationId,
        ...(input.parentOperationId === undefined
          ? {}
          : { parentOperationId: input.parentOperationId }),
        missionBindingSha256: binding,
        payload: {
          payloadType: "operationStarted",
          subject: input.subject,
        },
      }, health, "eventFailed");
    });
  }

  recordEvent(input: RecordFlightOperationEventInput): Promise<FlightRecorderReceipt> {
    return this.enqueue(input.traceId, async () => {
      const health = this.ensureHealth(input.traceId);
      const binding = await this.resolveMissionBinding(
        input.traceId,
        input.missionBindingSha256,
        health,
      );
      if (!binding) return this.dropReceipt(health, "eventFailed");
      return this.appendNonthrowing({
        recordId: input.recordId ?? this.newRecordId("flight-operation-event"),
        traceId: input.traceId,
        occurredAt: input.occurredAt ?? this.now(),
        recordType: "operationEvent",
        operationKind: input.operationKind,
        operationId: input.operationId,
        ...(input.parentOperationId === undefined
          ? {}
          : { parentOperationId: input.parentOperationId }),
        missionBindingSha256: binding,
        payload: {
          payloadType: "operationEvent",
          observation: input.observation,
        },
      }, health, "eventFailed");
    });
  }

  finishOperation(input: FinishFlightOperationInput): Promise<FlightRecorderReceipt> {
    return this.enqueue(input.traceId, async () => {
      const health = this.ensureHealth(input.traceId);
      const binding = await this.resolveMissionBinding(
        input.traceId,
        input.missionBindingSha256,
        health,
      );
      if (!binding) return this.dropReceipt(health, "finishFailed");
      return this.appendNonthrowing({
        recordId: input.recordId ?? this.newRecordId("flight-operation-finish"),
        traceId: input.traceId,
        occurredAt: input.occurredAt ?? this.now(),
        recordType: "operationFinished",
        operationKind: input.operationKind,
        operationId: input.operationId,
        ...(input.parentOperationId === undefined
          ? {}
          : { parentOperationId: input.parentOperationId }),
        missionBindingSha256: binding,
        payload: {
          payloadType: "operationFinished",
          status: input.status,
          durationMs: input.durationMs,
          failureCode: input.failureCode,
          output: input.output,
          steeringChain: input.steeringChain,
          actualTransport: input.actualTransport,
          evidenceClass: input.evidenceClass,
        },
      }, health, "finishFailed");
    });
  }

  limitTrace(input: LimitFlightTraceInput): Promise<FlightRecorderReceipt> {
    return this.enqueue(input.traceId, async () => {
      const health = this.ensureHealth(input.traceId);
      if (health.completeness === "limited") {
        return { ok: true, traceId: input.traceId, health: freezeHealth(health) };
      }
      const replay = await this.loadNonthrowing(input.traceId, health);
      if (!replay || replay.state === "finished") return this.dropReceipt(health, "eventFailed");
      const receipt = await this.appendNonthrowing({
        recordId: input.recordId ?? this.newRecordId("flight-trace-limited"),
        traceId: input.traceId,
        occurredAt: input.occurredAt ?? this.now(),
        recordType: "traceLimited",
        operationKind: "roomTurn",
        missionBindingSha256: replay.missionBindingSha256,
        payload: {
          payloadType: "traceLimited",
          reason: input.reason,
          droppedRecordsAtLeast: input.droppedRecordsAtLeast,
          telemetryCompleteness: "limited",
        },
      }, health, "eventFailed", false);
      if (receipt.ok) health.completeness = "limited";
      return { ...receipt, health: freezeHealth(health) };
    });
  }

  finishTrace(input: FinishFlightTraceInput): Promise<FlightRecorderReceipt> {
    return this.enqueue(input.traceId, async () => {
      const health = this.ensureHealth(input.traceId);
      const replay = await this.loadNonthrowing(input.traceId, health);
      if (!replay || replay.state === "finished") return this.dropReceipt(health, "finishFailed");
      const incomplete = replay.limited
        || input.incomplete === true
        || health.completeness === "incomplete"
        || health.completeness === "invalid"
        || replay.openOperationCount > 0;
      const payload: FlightTraceFinishedPayload = {
        payloadType: "traceFinished",
        status: incomplete ? "incomplete" : input.status,
        durationMs: input.durationMs,
        operationCount: replay.operationCount,
        openOperationCount: replay.openOperationCount,
        recordCount: replay.records.length + 1,
        limited: replay.limited,
        incomplete,
      };
      const receipt = await this.appendNonthrowing({
        recordId: input.recordId ?? this.newRecordId("flight-trace-finish"),
        traceId: input.traceId,
        occurredAt: input.occurredAt ?? this.now(),
        recordType: "traceFinished",
        operationKind: "roomTurn",
        missionBindingSha256: replay.missionBindingSha256,
        payload,
      }, health, "finishFailed", false);
      if (!receipt.ok) return receipt;

      health.finalized = true;
      health.completeness = incomplete
        ? "incomplete"
        : replay.limited
          ? "limited"
          : "complete";
      if (this.refreshIndex || this.writeMirror) {
        this.scheduleDerivedFinalizers(input.traceId, health);
      }
      return { ...receipt, health: freezeHealth(health) };
    });
  }

  async flush(traceId: string): Promise<FlightRecorderHealth> {
    await (this.queues.get(traceId) ?? Promise.resolve());
    await (this.derivedQueues.get(traceId) ?? Promise.resolve());
    return freezeHealth(this.ensureHealth(traceId));
  }

  currentHealth(traceId: string): FlightRecorderHealth {
    return freezeHealth(this.ensureHealth(traceId));
  }

  currentReplaySnapshot(traceId: string): Promise<FlightTraceReplay | undefined> {
    return this.enqueueReplay(traceId);
  }

  private async enqueueReplay(traceId: string): Promise<FlightTraceReplay | undefined> {
    await (this.queues.get(traceId) ?? Promise.resolve());
    return this.loadNonthrowing(traceId, this.ensureHealth(traceId));
  }

  private enqueue(
    traceId: string,
    work: () => Promise<FlightRecorderReceipt>,
  ): Promise<FlightRecorderReceipt> {
    const previous = this.queues.get(traceId) ?? Promise.resolve();
    let resolveReceipt!: (receipt: FlightRecorderReceipt) => void;
    const receipt = new Promise<FlightRecorderReceipt>((resolve) => {
      resolveReceipt = resolve;
    });
    const next = previous.then(async () => {
      try {
        resolveReceipt(await work());
      } catch {
        const health = this.ensureHealth(traceId);
        this.degrade(health, "invalid", "invalidTrace");
        resolveReceipt({ ok: false, traceId, health: freezeHealth(health) });
      }
    });
    const settled = next.then(() => undefined, () => undefined);
    this.queues.set(traceId, settled);
    void settled.finally(() => {
      if (this.queues.get(traceId) === settled) this.queues.delete(traceId);
    });
    return receipt;
  }

  private async appendNonthrowing(
    draft: FlightRecordDraft,
    health: MutableHealth,
    failureNotice: FlightHealthNoticeCode,
    autoSealCapacity = true,
  ): Promise<FlightRecorderReceipt> {
    if (health.completeness === "incomplete"
      || health.completeness === "invalid"
      || health.finalized) {
      return this.dropReceipt(health, failureNotice);
    }
    try {
      const record = await this.store.append(draft);
      health.persistedRecords = Math.max(health.persistedRecords, record.sequence);
      return {
        ok: true,
        traceId: draft.traceId,
        record,
        health: freezeHealth(health),
      };
    } catch (error) {
      health.droppedRecords += 1;
      if (autoSealCapacity
        && (error instanceof FlightTraceCapacityError
          || isOpenOperationLimit(error))) {
        const notice = error instanceof FlightTraceCapacityError
          ? "capacityReached"
          : "openOperationLimit";
        await this.sealIncomplete(
          draft.traceId,
          error instanceof FlightTraceCapacityError
            ? error.reason
            : "openOperations",
          health,
          notice,
        );
      } else {
        const invalid = error instanceof FlightTraceFileError;
        this.degrade(health, invalid ? "invalid" : "incomplete", failureNotice);
        if (autoSealCapacity && draft.recordType !== "traceStarted") {
          await this.sealIncomplete(
            draft.traceId,
            "recorderFailure",
            health,
            failureNotice,
          );
        }
      }
      return { ok: false, traceId: draft.traceId, health: freezeHealth(health) };
    }
  }

  private async sealIncomplete(
    traceId: string,
    reason: FlightLimitReason,
    health: MutableHealth,
    notice: FlightHealthNoticeCode,
  ): Promise<void> {
    this.degrade(health, "incomplete", notice);
    let replay: FlightTraceReplay | undefined;
    try {
      replay = await this.store.load(traceId);
    } catch {
      return;
    }
    if (!replay || replay.state === "finished") return;
    const occurredAt = this.monotonicNow(replay);
    if (!replay.limited) {
      try {
        const limited = await this.store.append({
          recordId: this.newRecordId("flight-trace-limited"),
          traceId,
          occurredAt,
          recordType: "traceLimited",
          operationKind: "roomTurn",
          missionBindingSha256: replay.missionBindingSha256,
          payload: {
            payloadType: "traceLimited",
            reason,
            droppedRecordsAtLeast: Math.max(1, health.droppedRecords),
            telemetryCompleteness: "limited",
          },
        });
        health.persistedRecords = Math.max(health.persistedRecords, limited.sequence);
        replay = await this.store.load(traceId);
      } catch {
        return;
      }
    }
    if (!replay || replay.state === "finished") return;
    try {
      const first = Date.parse(replay.records[0]!.occurredAt);
      const end = Date.parse(occurredAt);
      const finished = await this.store.append({
        recordId: this.newRecordId("flight-trace-finish"),
        traceId,
        occurredAt,
        recordType: "traceFinished",
        operationKind: "roomTurn",
        missionBindingSha256: replay.missionBindingSha256,
        payload: {
          payloadType: "traceFinished",
          status: "incomplete",
          durationMs: Math.max(0, end - first),
          operationCount: replay.operationCount,
          openOperationCount: replay.openOperationCount,
          recordCount: replay.records.length + 1,
          limited: true,
          incomplete: true,
        },
      });
      health.persistedRecords = Math.max(health.persistedRecords, finished.sequence);
      health.finalized = true;
    } catch {
      // The two reserved writes are each attempted once. No retry can invent
      // completeness after an uncertain failure.
    }
  }

  private async resolveMissionBinding(
    traceId: string,
    expected: string | undefined,
    health: MutableHealth,
  ): Promise<string | undefined> {
    if (health.completeness === "incomplete"
      || health.completeness === "invalid"
      || health.finalized) {
      return undefined;
    }
    const replay = await this.loadNonthrowing(traceId, health);
    if (!replay || (expected !== undefined && expected !== replay.missionBindingSha256)) {
      this.degrade(health, "incomplete", "eventFailed");
      return undefined;
    }
    return replay.missionBindingSha256;
  }

  private async loadNonthrowing(
    traceId: string,
    health: MutableHealth,
  ): Promise<FlightTraceReplay | undefined> {
    try {
      const replay = await this.store.load(traceId);
      if (replay) {
        health.persistedRecords = Math.max(health.persistedRecords, replay.records.length);
        health.finalized = replay.state === "finished";
        if (health.completeness !== "incomplete" && health.completeness !== "invalid") {
          health.completeness = replay.completeness;
        }
      }
      return replay;
    } catch {
      this.degrade(health, "invalid", "invalidTrace");
      return undefined;
    }
  }

  private async runDerivedFinalizers(
    replay: FlightTraceReplay,
    health: MutableHealth,
  ): Promise<void> {
    if (this.refreshIndex) {
      try {
        await this.refreshIndex();
      } catch {
        health.indexHealthy = false;
        this.noticeOnce(health, "indexFailed");
      }
    }
    if (this.writeMirror) {
      try {
        await this.writeMirror(replay);
      } catch {
        health.mirrorHealthy = false;
        this.noticeOnce(health, "mirrorFailed");
      }
    }
  }

  private scheduleDerivedFinalizers(
    traceId: string,
    health: MutableHealth,
  ): void {
    const work = Promise.resolve()
      .then(async () => {
        const replay = await this.loadNonthrowing(traceId, health);
        if (replay) await this.runDerivedFinalizers(replay, health);
      })
      .catch(() => {
        // Each projection is guarded independently above. This final fence
        // prevents an unexpected implementation error from becoming an
        // unhandled rejection or changing the authoritative finish receipt.
        if (this.refreshIndex) health.indexHealthy = false;
        if (this.writeMirror) health.mirrorHealthy = false;
        this.noticeOnce(
          health,
          this.refreshIndex ? "indexFailed" : "mirrorFailed",
        );
      });
    this.derivedQueues.set(traceId, work);
    void work.then(() => {
      if (this.derivedQueues.get(traceId) === work) {
        this.derivedQueues.delete(traceId);
      }
    });
  }

  private monotonicNow(replay: FlightTraceReplay): string {
    const candidate = Date.parse(this.now());
    const previous = Date.parse(replay.records.at(-1)!.occurredAt);
    return Number.isFinite(candidate) && candidate >= previous
      ? new Date(candidate).toISOString()
      : replay.records.at(-1)!.occurredAt;
  }

  private ensureHealth(traceId: string): MutableHealth {
    let health = this.healthByTrace.get(traceId);
    if (!health) {
      health = {
        traceId,
        completeness: "active",
        persistedRecords: 0,
        droppedRecords: 0,
        finalized: false,
        indexHealthy: true,
        mirrorHealthy: true,
        noticeEmitted: false,
      };
      this.healthByTrace.set(traceId, health);
    }
    return health;
  }

  private dropReceipt(
    health: MutableHealth,
    notice: FlightHealthNoticeCode,
  ): FlightRecorderReceipt {
    health.droppedRecords += 1;
    if (health.completeness === "active" || health.completeness === "limited") {
      this.degrade(health, "incomplete", notice);
    } else {
      this.noticeOnce(health, notice);
    }
    return { ok: false, traceId: health.traceId, health: freezeHealth(health) };
  }

  private degrade(
    health: MutableHealth,
    completeness: Extract<FlightCompleteness, "incomplete" | "invalid">,
    notice: FlightHealthNoticeCode,
  ): void {
    if (health.completeness !== "invalid") health.completeness = completeness;
    this.noticeOnce(health, notice);
  }

  private noticeOnce(health: MutableHealth, code: FlightHealthNoticeCode): void {
    health.noticeCode ??= code;
    if (health.noticeEmitted) return;
    health.noticeEmitted = true;
    try {
      this.onHealthNotice?.({
        traceId: health.traceId,
        code,
        completeness: health.completeness,
      });
    } catch {
      // Health reporting must never escape the nonthrowing recorder boundary.
    }
  }
}

/**
 * Disposable one-way mirror. It deliberately omits payload fields and every
 * content-derived hash, including mission, prompt, context, output, and record
 * hashes, so it cannot become a dictionary oracle.
 */
export function renderFlightRecorderMirror(
  replay: FlightTraceReplay,
  generatedAt = new Date().toISOString(),
): string {
  const lines = [
    "# Hydra Flight Recorder",
    "",
    "> Disposable metadata-only mirror. Private per-trace files are authoritative.",
    "> This mirror is never replay, eval, Mission Contract, or authority evidence.",
    "",
    `Generated: ${safeMirrorCell(generatedAt)}`,
    `Completeness: ${replay.completeness}`,
    `Records: ${replay.records.length}`,
    `Operations: ${replay.operationCount}`,
    "",
    "| Seq | Time | Record | Operation | Lifecycle |",
    "| ---: | --- | --- | --- | --- |",
  ];
  for (const record of replay.records) {
    lines.push(
      `| ${record.sequence} | ${safeMirrorCell(record.occurredAt)} | ${record.recordType} | ${record.operationKind} | ${payloadLifecycle(record)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeFlightRecorderMirror(
  filePath: string,
  replay: FlightTraceReplay,
  generatedAt = new Date().toISOString(),
): Promise<void> {
  await atomicWriteFile(filePath, renderFlightRecorderMirror(replay, generatedAt));
}

function freezeHealth(health: MutableHealth): FlightRecorderHealth {
  return Object.freeze({
    traceId: health.traceId,
    completeness: health.completeness,
    persistedRecords: health.persistedRecords,
    droppedRecords: health.droppedRecords,
    finalized: health.finalized,
    indexHealthy: health.indexHealthy,
    mirrorHealthy: health.mirrorHealthy,
    ...(health.noticeCode === undefined ? {} : { noticeCode: health.noticeCode }),
  });
}

function payloadLifecycle(record: FlightRecord): string {
  switch (record.payload.payloadType) {
    case "traceStarted":
      return "started";
    case "operationStarted":
      return "started";
    case "operationEvent":
      return record.payload.observation.observationType;
    case "operationFinished":
      return record.payload.status;
    case "traceLimited":
      return "limited";
    case "traceFinished":
      return record.payload.status;
  }
}

function safeMirrorCell(value: string): string {
  return value.replace(/[\r\n|]/g, " ").replace(/\s+/g, " ").trim();
}

function isOpenOperationLimit(error: unknown): boolean {
  return error instanceof FlightTraceValidationError
    && error.issues.some((issue) => issue.code === "openOperationLimit");
}
