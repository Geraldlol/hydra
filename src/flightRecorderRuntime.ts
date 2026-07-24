import { randomUUID } from "node:crypto";
import {
  FlightRecorderController,
  writeFlightRecorderMirror,
  type FlightHealthNoticeCode,
  type FlightRecorderHealthNotice,
} from "./flightRecorderController";
import {
  isFlightTraceId,
  type FlightAgentRunSubject,
  type FlightEvidenceClass,
  type FlightFailureCode,
  type FlightNativeActionSubject,
  type FlightOperationObservation,
  type FlightOutputMetadata,
  type FlightSteeringChainMetadata,
  type FlightTerminalStatus,
  type FlightTraceReplay,
  type FlightTraceStartedPayload,
  type FlightUsageSubject,
  type FlightVerificationSubject,
} from "./flightRecorderProtocol";
import {
  cleanupFlightRecorderStorage,
  openFileFlightRecorderStore,
  rebuildFlightRecorderIndex,
  recoverStaleFlightTraces,
  startFlightRecorderOwnerLease,
  type FileFlightRecorderStore,
  type FlightOwnerLease,
  type FlightRetentionResult,
} from "./flightRecorderStore";

export interface FlightRecorderRuntimeRetention {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_FLIGHT_RUNTIME_RETENTION: FlightRecorderRuntimeRetention =
  Object.freeze({
    maxFiles: 512,
    maxTotalBytes: 256 * 1024 * 1024,
  });

export type FlightRecorderRuntimeNoticeCode =
  | "initializationFailed"
  | "recoveryFailed"
  | "indexFailed"
  | "retentionFailed"
  | "recordingDegraded";

/**
 * Deliberately sanitized: no exception text, file path, provider payload,
 * prompt, argv, environment value, or result body crosses this boundary.
 */
export interface FlightRecorderRuntimeNotice {
  readonly code: FlightRecorderRuntimeNoticeCode;
  readonly traceId: string | null;
  readonly recorderCode?: FlightHealthNoticeCode;
}

export interface FlightRecorderRuntimeOptions {
  readonly privateWorkspaceRoot: string;
  readonly ownerId: string;
  /**
   * Optional disposable, redacted projection. This path is never written into
   * an authoritative trace record.
   */
  readonly mirrorPath?: string;
  readonly retention?: FlightRecorderRuntimeRetention;
  readonly now?: () => Date;
  readonly onNotice?: (notice: FlightRecorderRuntimeNotice) => void;
}

export interface FlightRecorderRuntimeStatus {
  readonly available: boolean;
  readonly disposed: boolean;
  readonly notice?: FlightRecorderRuntimeNotice;
  readonly recoveredTraceIds: readonly string[];
  readonly retention?: FlightRetentionResult;
}

export interface BeginFlightRoomTurnInput {
  readonly traceId?: string;
  readonly roomTurnId: string;
  readonly phase: string;
  readonly missionDocumentSha256: string | null;
  readonly missionBindingSha256: string;
  readonly source: FlightTraceStartedPayload["source"];
  readonly baseRevisionSha: string | null;
}

export interface FlightRoomTurnContext {
  readonly traceId: string;
  readonly phaseOperationId: string;
  readonly missionBindingSha256: string;
  readonly startedAtMs: number;
  /**
   * True means the lifecycle was admitted to the ordered recorder queue, not
   * that persistence has completed. `flushDerivedWork()` is the explicit
   * durability barrier. False never means the caller's room turn should be
   * cancelled, retried, or skipped.
   */
  readonly recorded: boolean;
}

export type BeginFlightAgentRunInput = Omit<FlightAgentRunSubject, "kind">;

export interface FlightAgentRunOperation {
  readonly traceId: string;
  readonly phaseOperationId: string;
  readonly operationId: string;
  readonly missionBindingSha256: string;
  readonly startedAtMs: number;
  readonly evidenceClass: FlightEvidenceClass;
  /**
   * True means operation start was admitted behind its phase start. It does
   * not claim persistence; recorder I/O never gates the provider operation.
   */
  readonly recorded: boolean;
}

export interface FlightRecordedOutcome {
  readonly status: FlightTerminalStatus;
  readonly failureCode: FlightFailureCode | null;
}

export interface FlightRunResultLike {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly terminationFailed?: boolean;
  readonly deliveryUnknown?: boolean;
}

export interface FinishFlightAgentRunInput extends FlightRecordedOutcome {
  readonly output: FlightOutputMetadata | null;
  readonly terminalSteeringChain: FlightSteeringChainMetadata;
  readonly actualTransport: string;
  readonly evidenceClass?: FlightEvidenceClass;
}

export interface FinishFlightRoomTurnInput extends FlightRecordedOutcome {}

export type FlightAuxiliaryOperationKind =
  | "verification"
  | "usage"
  | "nativeAction";

export type FlightAuxiliaryOperationSubject =
  | FlightVerificationSubject
  | FlightUsageSubject
  | FlightNativeActionSubject;

export interface BeginFlightAuxiliaryOperationInput {
  readonly subject: FlightAuxiliaryOperationSubject;
  /**
   * Omit for a phase child. Usage normally names its still-open agentRun
   * parent so lifecycle ordering remains explicit.
   */
  readonly parentOperationId?: string;
}

export interface FlightAuxiliaryOperation {
  readonly traceId: string;
  readonly phaseOperationId: string;
  readonly operationId: string;
  readonly parentOperationId: string;
  readonly operationKind: FlightAuxiliaryOperationKind;
  readonly missionBindingSha256: string;
  readonly startedAtMs: number;
  readonly evidenceClass: FlightEvidenceClass;
  readonly recorded: boolean;
}

export interface FinishFlightAuxiliaryOperationInput
  extends FlightRecordedOutcome {
  readonly observation: FlightOperationObservation;
  readonly evidenceClass?: FlightEvidenceClass;
}

export interface RecordFlightPhaseTransitionInput {
  readonly fromPhase: string;
  readonly toPhase: string;
  readonly trigger: string;
  readonly occurredAt?: string;
}

interface MutableRoomTurn {
  context: FlightRoomTurnContext;
  readonly agentOperations: Map<string, MutableAgentOperation>;
  readonly auxiliaryOperations: Map<string, MutableAuxiliaryOperation>;
  finished: boolean;
  traceStarted: boolean;
  phaseStarted: boolean;
}

interface MutableAgentOperation {
  handle: FlightAgentRunOperation;
  finished: boolean;
  started: boolean;
  outcome?: FlightRecordedOutcome;
}

interface MutableAuxiliaryOperation {
  handle: FlightAuxiliaryOperation;
  finished: boolean;
  started: boolean;
  outcome?: FlightRecordedOutcome;
}

/**
 * Maps the process-level result shape without importing panel or accepting
 * stdout/stderr bodies. Termination uncertainty outranks apparent exit state.
 */
export function mapFlightRunResult(result: FlightRunResultLike): FlightRecordedOutcome {
  if (result.terminationFailed === true) {
    return {
      status: "deliveryUnknown",
      failureCode: "terminationUnconfirmed",
    };
  }
  if (result.deliveryUnknown === true) {
    return {
      status: "deliveryUnknown",
      failureCode: "deliveryUnknown",
    };
  }
  if (result.cancelled) {
    return {
      status: "cancelled",
      failureCode: "cancelled",
    };
  }
  if (result.timedOut) {
    return {
      status: "timedOut",
      failureCode: "timeout",
    };
  }
  if (result.exitCode === 0) {
    return {
      status: "succeeded",
      failureCode: null,
    };
  }
  if (result.exitCode === null) {
    return {
      status: "failed",
      failureCode: "transportFailure",
    };
  }
  return {
    status: "failed",
    failureCode: "providerFailure",
  };
}

/**
 * Host lifecycle wrapper around the strict private store and nonthrowing
 * controller. Every public method is observational: recorder failure is
 * reduced to a receipt/notice and never escapes into the caller's operation.
 */
export class FlightRecorderRuntime {
  private readonly options: FlightRecorderRuntimeOptions;
  private readonly retention: FlightRecorderRuntimeRetention;
  private store: FileFlightRecorderStore | undefined;
  private controller: FlightRecorderController | undefined;
  private ownerLease: FlightOwnerLease | undefined;
  private disposed = false;
  private latchedNotice: FlightRecorderRuntimeNotice | undefined;
  private recoveredTraceIds: readonly string[] = [];
  private retentionResult: FlightRetentionResult | undefined;
  private readonly roomTurns = new Map<string, MutableRoomTurn>();
  private readonly authoritativeQueues = new Map<string, Promise<void>>();
  private derivedMaintenanceTail: Promise<void> = Promise.resolve();
  private disposalPromise: Promise<void> | undefined;

  private constructor(options: FlightRecorderRuntimeOptions) {
    this.options = options;
    this.retention = Object.freeze({
      ...(options.retention ?? DEFAULT_FLIGHT_RUNTIME_RETENTION),
    });
  }

  static async create(
    options: FlightRecorderRuntimeOptions,
  ): Promise<FlightRecorderRuntime> {
    const runtime = new FlightRecorderRuntime(options);
    await runtime.initialize();
    return runtime;
  }

  get enabled(): boolean {
    return this.controller !== undefined && !this.disposed;
  }

  get notice(): FlightRecorderRuntimeNotice | undefined {
    return this.latchedNotice === undefined
      ? undefined
      : Object.freeze({ ...this.latchedNotice });
  }

  status(): FlightRecorderRuntimeStatus {
    return Object.freeze({
      available: this.enabled,
      disposed: this.disposed,
      ...(this.latchedNotice === undefined
        ? {}
        : { notice: Object.freeze({ ...this.latchedNotice }) }),
      recoveredTraceIds: Object.freeze([...this.recoveredTraceIds]),
      ...(this.retentionResult === undefined
        ? {}
        : {
            retention: Object.freeze({
              removedTraceIds: Object.freeze([
                ...this.retentionResult.removedTraceIds,
              ]),
              retainedTraceIds: Object.freeze([
                ...this.retentionResult.retainedTraceIds,
              ]),
              totalBytes: this.retentionResult.totalBytes,
            }),
          }),
    });
  }

  async beginRoomTurn(
    input: BeginFlightRoomTurnInput,
  ): Promise<FlightRoomTurnContext> {
    const traceId = input.traceId ?? this.newIdentifier("flight-trace");
    const phaseOperationId = this.newIdentifier("flight-phase");
    const startedAtMs = this.nowMs();
    let context: FlightRoomTurnContext = Object.freeze({
      traceId,
      phaseOperationId,
      missionBindingSha256: input.missionBindingSha256,
      startedAtMs,
      recorded: false,
    });
    const state: MutableRoomTurn = {
      context,
      agentOperations: new Map(),
      auxiliaryOperations: new Map(),
      finished: false,
      traceStarted: false,
      phaseStarted: false,
    };

    try {
      if (this.disposed
        || !this.controller
        || this.roomTurns.has(traceId)
        || !isFlightTraceId(traceId)) {
        this.latchNotice("recordingDegraded", traceId);
        return context;
      }
      const controller = this.controller;
      context = Object.freeze({ ...context, recorded: true });
      state.context = context;
      this.roomTurns.set(traceId, state);
      this.enqueueAuthoritativeWork(traceId, async () => {
        const trace = await controller.startTrace({
          traceId,
          roomTurnId: input.roomTurnId,
          ownerId: this.options.ownerId,
          missionDocumentSha256: input.missionDocumentSha256,
          missionBindingSha256: input.missionBindingSha256,
          source: input.source,
          baseRevisionSha: input.baseRevisionSha,
        });
        if (!trace.ok) {
          this.latchNotice(
            "recordingDegraded",
            traceId,
            trace.health.noticeCode,
          );
          return;
        }
        state.traceStarted = true;
        const phase = await controller.startOperation({
          traceId,
          operationId: phaseOperationId,
          operationKind: "phase",
          subject: {
            kind: "phase",
            phase: input.phase,
          },
          missionBindingSha256: input.missionBindingSha256,
        });
        if (!phase.ok) {
          this.latchNotice(
            "recordingDegraded",
            traceId,
            phase.health.noticeCode,
          );
          return;
        }
        state.phaseStarted = true;
      });
      return context;
    } catch {
      this.latchNotice("recordingDegraded", traceId);
      return context;
    }
  }

  async beginAgentRun(
    roomTurn: FlightRoomTurnContext,
    input: BeginFlightAgentRunInput,
  ): Promise<FlightAgentRunOperation> {
    const operationId = this.newIdentifier("flight-agent");
    const startedAtMs = this.nowMs();
    let handle: FlightAgentRunOperation = Object.freeze({
      traceId: roomTurn.traceId,
      phaseOperationId: roomTurn.phaseOperationId,
      operationId,
      missionBindingSha256: roomTurn.missionBindingSha256,
      startedAtMs,
      evidenceClass: input.evidenceClass,
      recorded: false,
    });
    const state = this.roomTurns.get(roomTurn.traceId);

    try {
      if (this.disposed
        || !this.controller
        || !roomTurn.recorded
        || !state
        || state.finished
        || state.context.phaseOperationId !== roomTurn.phaseOperationId
        || state.context.missionBindingSha256 !== roomTurn.missionBindingSha256) {
        return handle;
      }
      const controller = this.controller;
      handle = Object.freeze({ ...handle, recorded: true });
      const operation: MutableAgentOperation = {
        handle,
        finished: false,
        started: false,
      };
      state.agentOperations.set(operationId, operation);
      this.enqueueAuthoritativeWork(roomTurn.traceId, async () => {
        if (!state.phaseStarted) return;
        const receipt = await controller.startOperation({
          traceId: roomTurn.traceId,
          operationId,
          parentOperationId: roomTurn.phaseOperationId,
          operationKind: "agentRun",
          missionBindingSha256: roomTurn.missionBindingSha256,
          subject: {
            kind: "agentRun",
            runId: input.runId,
            headId: input.headId,
            agentKind: input.agentKind,
            phase: input.phase,
            provider: input.provider,
            model: input.model,
            plannedTransport: input.plannedTransport,
            authorityClass: input.authorityClass,
            authoritySha256: input.authoritySha256,
            promptSha256: input.promptSha256,
            contextSha256: input.contextSha256,
            promptCharacters: input.promptCharacters,
            telemetryDetail: input.telemetryDetail,
            initialSteeringChain: {
              sha256: input.initialSteeringChain.sha256,
              indeterminate: input.initialSteeringChain.indeterminate,
            },
            evidenceClass: input.evidenceClass,
          },
        });
        if (!receipt.ok) {
          this.latchNotice(
            "recordingDegraded",
            roomTurn.traceId,
            receipt.health.noticeCode,
          );
          return;
        }
        operation.started = true;
      });
      return handle;
    } catch {
      this.latchNotice("recordingDegraded", roomTurn.traceId);
      return handle;
    }
  }

  async finishAgentRun(
    operation: FlightAgentRunOperation,
    input: FinishFlightAgentRunInput,
  ): Promise<boolean> {
    try {
      const state = this.roomTurns.get(operation.traceId);
      const mutable = state?.agentOperations.get(operation.operationId);
      if (this.disposed
        || !this.controller
        || !operation.recorded
        || !mutable
        || mutable.finished
        || state?.finished
        || mutable.handle.phaseOperationId !== operation.phaseOperationId
        || mutable.handle.missionBindingSha256 !== operation.missionBindingSha256) {
        return false;
      }
      const controller = this.controller;
      const durationMs = this.durationSince(operation.startedAtMs);
      mutable.finished = true;
      mutable.outcome = Object.freeze({
        status: input.status,
        failureCode: input.failureCode,
      });
      this.enqueueAuthoritativeWork(operation.traceId, async () => {
        if (!mutable.started) return;
        const receipt = await controller.finishOperation({
          traceId: operation.traceId,
          operationId: operation.operationId,
          parentOperationId: operation.phaseOperationId,
          operationKind: "agentRun",
          status: input.status,
          durationMs,
          failureCode: input.failureCode,
          output: input.output === null
            ? null
            : {
                bytes: input.output.bytes,
                sha256: input.output.sha256,
              },
          steeringChain: {
            sha256: input.terminalSteeringChain.sha256,
            indeterminate: input.terminalSteeringChain.indeterminate,
          },
          actualTransport: input.actualTransport,
          evidenceClass: input.evidenceClass ?? operation.evidenceClass,
          missionBindingSha256: operation.missionBindingSha256,
        });
        if (!receipt.ok) {
          this.latchNotice(
            "recordingDegraded",
            operation.traceId,
            receipt.health.noticeCode,
          );
        }
      });
      return true;
    } catch {
      this.latchNotice("recordingDegraded", operation.traceId);
      return false;
    }
  }

  async beginAuxiliaryOperation(
    roomTurn: FlightRoomTurnContext,
    input: BeginFlightAuxiliaryOperationInput,
  ): Promise<FlightAuxiliaryOperation> {
    const operationId = this.newIdentifier(`flight-${input.subject.kind}`);
    const startedAtMs = this.nowMs();
    const parentOperationId =
      input.parentOperationId ?? roomTurn.phaseOperationId;
    let handle: FlightAuxiliaryOperation = Object.freeze({
      traceId: roomTurn.traceId,
      phaseOperationId: roomTurn.phaseOperationId,
      operationId,
      parentOperationId,
      operationKind: input.subject.kind,
      missionBindingSha256: roomTurn.missionBindingSha256,
      startedAtMs,
      evidenceClass: input.subject.evidenceClass,
      recorded: false,
    });
    const state = this.roomTurns.get(roomTurn.traceId);
    const parentAgent = parentOperationId === roomTurn.phaseOperationId
      ? undefined
      : state?.agentOperations.get(parentOperationId);

    try {
      if (this.disposed
        || !this.controller
        || !roomTurn.recorded
        || !state
        || state.finished
        || state.context.phaseOperationId !== roomTurn.phaseOperationId
        || state.context.missionBindingSha256
          !== roomTurn.missionBindingSha256
        || (
          parentOperationId !== roomTurn.phaseOperationId
          && (!parentAgent || parentAgent.finished)
        )) {
        return handle;
      }
      const controller = this.controller;
      handle = Object.freeze({ ...handle, recorded: true });
      const operation: MutableAuxiliaryOperation = {
        handle,
        finished: false,
        started: false,
      };
      state.auxiliaryOperations.set(operationId, operation);
      this.enqueueAuthoritativeWork(roomTurn.traceId, async () => {
        if (!state.phaseStarted
          || (
            parentOperationId !== roomTurn.phaseOperationId
            && !parentAgent?.started
          )) {
          return;
        }
        const receipt = await controller.startOperation({
          traceId: roomTurn.traceId,
          operationId,
          parentOperationId,
          operationKind: input.subject.kind,
          missionBindingSha256: roomTurn.missionBindingSha256,
          subject: structuredClone(input.subject),
        });
        if (!receipt.ok) {
          this.latchNotice(
            "recordingDegraded",
            roomTurn.traceId,
            receipt.health.noticeCode,
          );
          return;
        }
        operation.started = true;
      });
      return handle;
    } catch {
      this.latchNotice("recordingDegraded", roomTurn.traceId);
      return handle;
    }
  }

  async finishAuxiliaryOperation(
    operation: FlightAuxiliaryOperation,
    input: FinishFlightAuxiliaryOperationInput,
  ): Promise<boolean> {
    try {
      const state = this.roomTurns.get(operation.traceId);
      const mutable = state?.auxiliaryOperations.get(operation.operationId);
      if (this.disposed
        || !this.controller
        || !operation.recorded
        || !mutable
        || mutable.finished
        || state?.finished
        || mutable.handle.parentOperationId !== operation.parentOperationId
        || mutable.handle.operationKind !== operation.operationKind
        || mutable.handle.missionBindingSha256
          !== operation.missionBindingSha256
        || input.observation.kind !== operation.operationKind) {
        return false;
      }
      const controller = this.controller;
      const durationMs = this.durationSince(operation.startedAtMs);
      mutable.finished = true;
      mutable.outcome = Object.freeze({
        status: input.status,
        failureCode: input.failureCode,
      });
      this.enqueueAuthoritativeWork(operation.traceId, async () => {
        if (!mutable.started) return;
        const event = await controller.recordEvent({
          traceId: operation.traceId,
          operationId: operation.operationId,
          parentOperationId: operation.parentOperationId,
          operationKind: operation.operationKind,
          observation: structuredClone(input.observation),
          missionBindingSha256: operation.missionBindingSha256,
        });
        const finish = await controller.finishOperation({
          traceId: operation.traceId,
          operationId: operation.operationId,
          parentOperationId: operation.parentOperationId,
          operationKind: operation.operationKind,
          status: input.status,
          durationMs,
          failureCode: input.failureCode,
          output: null,
          steeringChain: null,
          actualTransport: null,
          evidenceClass: input.evidenceClass ?? operation.evidenceClass,
          missionBindingSha256: operation.missionBindingSha256,
        });
        if (!event.ok || !finish.ok) {
          this.latchNotice(
            "recordingDegraded",
            operation.traceId,
            event.health.noticeCode ?? finish.health.noticeCode,
          );
        }
      });
      return true;
    } catch {
      this.latchNotice("recordingDegraded", operation.traceId);
      return false;
    }
  }

  async recordPhaseTransition(
    roomTurn: FlightRoomTurnContext,
    input: RecordFlightPhaseTransitionInput,
  ): Promise<boolean> {
    try {
      const state = this.roomTurns.get(roomTurn.traceId);
      if (this.disposed
        || !this.controller
        || !roomTurn.recorded
        || !state
        || state.finished
        || state.context.phaseOperationId !== roomTurn.phaseOperationId
        || state.context.missionBindingSha256
          !== roomTurn.missionBindingSha256) {
        return false;
      }
      const controller = this.controller;
      this.enqueueAuthoritativeWork(roomTurn.traceId, async () => {
        if (!state.phaseStarted) return;
        const receipt = await controller.recordEvent({
          traceId: roomTurn.traceId,
          operationId: roomTurn.phaseOperationId,
          operationKind: "phase",
          missionBindingSha256: roomTurn.missionBindingSha256,
          ...(input.occurredAt === undefined
            ? {}
            : { occurredAt: input.occurredAt }),
          observation: {
            kind: "phase",
            observationType: "phaseTransition",
            fromPhase: input.fromPhase,
            toPhase: input.toPhase,
            trigger: input.trigger,
          },
        });
        if (!receipt.ok) {
          this.latchNotice(
            "recordingDegraded",
            roomTurn.traceId,
            receipt.health.noticeCode,
          );
        }
      });
      return true;
    } catch {
      this.latchNotice("recordingDegraded", roomTurn.traceId);
      return false;
    }
  }

  async finishRoomTurn(
    roomTurn: FlightRoomTurnContext,
    input: FinishFlightRoomTurnInput,
  ): Promise<boolean> {
    try {
      const state = this.roomTurns.get(roomTurn.traceId);
      if (!state || state.finished) return false;
      state.finished = true;
      if (this.disposed
        || !this.controller
        || !roomTurn.recorded
        || state.context.phaseOperationId !== roomTurn.phaseOperationId
        || state.context.missionBindingSha256 !== roomTurn.missionBindingSha256) {
        this.roomTurns.delete(roomTurn.traceId);
        return false;
      }

      const controller = this.controller;
      const outcome = this.aggregateRoomTurnOutcome(state, input);
      const durationMs = this.durationSince(roomTurn.startedAtMs);
      this.enqueueAuthoritativeWork(roomTurn.traceId, async () => {
        let phaseOk = false;
        if (state.phaseStarted) {
          const phase = await controller.finishOperation({
            traceId: roomTurn.traceId,
            operationId: roomTurn.phaseOperationId,
            operationKind: "phase",
            status: outcome.status,
            durationMs,
            failureCode: outcome.failureCode,
            output: null,
            steeringChain: null,
            actualTransport: null,
            evidenceClass: "hydraObserved",
            missionBindingSha256: roomTurn.missionBindingSha256,
          });
          phaseOk = phase.ok;
          if (!phase.ok) {
            this.latchNotice(
              "recordingDegraded",
              roomTurn.traceId,
              phase.health.noticeCode,
            );
          }
        }
        if (!state.traceStarted) {
          this.roomTurns.delete(roomTurn.traceId);
          return;
        }
        const trace = await controller.finishTrace({
          traceId: roomTurn.traceId,
          status: phaseOk ? outcome.status : "incomplete",
          durationMs,
          incomplete: !phaseOk || outcome.status === "incomplete",
        });
        if (!trace.ok) {
          this.latchNotice(
            "recordingDegraded",
            roomTurn.traceId,
            trace.health.noticeCode,
          );
        }
        this.roomTurns.delete(roomTurn.traceId);
      });
      return true;
    } catch {
      this.roomTurns.delete(roomTurn.traceId);
      this.latchNotice("recordingDegraded", roomTurn.traceId);
      return false;
    }
  }

  async inspectTrace(
    traceId: string,
  ): Promise<FlightTraceReplay | undefined> {
    if (!isFlightTraceId(traceId)) return undefined;
    try {
      await this.flushDerivedWork(traceId);
      return await this.store?.load(traceId);
    } catch {
      this.latchNotice("recordingDegraded", traceId);
      return undefined;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const controller = this.controller;
    const ownerLease = this.ownerLease;
    if (!controller) {
      ownerLease?.dispose();
      this.ownerLease = undefined;
      this.roomTurns.clear();
      return;
    }

    const traceIds = [...this.roomTurns.keys()];
    for (const [traceId, state] of this.roomTurns) {
      if (state.finished) continue;
      state.finished = true;
      const durationMs = this.durationSince(state.context.startedAtMs);
      this.enqueueAuthoritativeWork(traceId, async () => {
        if (state.traceStarted) {
          const receipt = await controller.finishTrace({
            traceId,
            status: "incomplete",
            durationMs,
            incomplete: true,
          });
          if (!receipt.ok) {
            this.latchNotice(
              "recordingDegraded",
              traceId,
              receipt.health.noticeCode,
            );
          }
        }
        this.roomTurns.delete(traceId);
      });
    }

    const authoritative = [...this.authoritativeQueues.values()];
    const disposal = Promise.all(authoritative)
      .then(async () => {
        await Promise.all(traceIds.map((traceId) => controller.flush(traceId)));
        await this.derivedMaintenanceTail;
      })
      .catch(() => {
        this.latchNotice("recordingDegraded", null);
      })
      .finally(() => {
        ownerLease?.dispose();
        if (this.ownerLease === ownerLease) this.ownerLease = undefined;
        if (this.controller === controller) this.controller = undefined;
        this.roomTurns.clear();
      });
    // The chain is rejection-fenced above; retaining it lets an explicit
    // flush wait for safe incomplete closure during shutdown.
    this.disposalPromise = disposal.catch(() => {
      this.latchNotice("recordingDegraded", null);
    });
  }

  private async initialize(): Promise<void> {
    let lease: FlightOwnerLease | undefined;
    try {
      const store = await openFileFlightRecorderStore(
        this.options.privateWorkspaceRoot,
      );
      lease = await startFlightRecorderOwnerLease(
        this.options.privateWorkspaceRoot,
        this.options.ownerId,
      );
      this.store = store;
      this.ownerLease = lease;
      this.controller = new FlightRecorderController({
        store,
        now: () => this.nowIso(),
        onHealthNotice: (notice) => this.onControllerNotice(notice),
        refreshIndex: async () => {
          const healthy = await this.enqueueDerivedMaintenance();
          if (!healthy) {
            // The controller converts this sanitized rejection into derived
            // health only; the authoritative trace receipt is already final.
            throw new Error("Flight Recorder derived maintenance failed.");
          }
        },
        ...(this.options.mirrorPath === undefined
          ? {}
          : {
              writeMirror: (replay) =>
                writeFlightRecorderMirror(
                  this.options.mirrorPath!,
                  replay,
                  this.nowIso(),
                ),
            }),
      });
    } catch {
      lease?.dispose();
      this.store = undefined;
      this.ownerLease = undefined;
      this.controller = undefined;
      this.latchNotice("initializationFailed", null);
      return;
    }

    const store = this.store;
    const ownerLease = this.ownerLease;
    void this.enqueueDerivedWork(async () => {
      try {
        this.recoveredTraceIds = Object.freeze([
          ...await recoverStaleFlightTraces(
            store,
            (ownerId) => ownerLease.isOwnerActive(ownerId),
            { now: () => this.nowIso() },
          ),
        ]);
      } catch {
        this.latchNotice("recoveryFailed", null);
      }
      return this.enforceRetention();
    });
  }

  /**
   * Waits only when an explicit diagnostic or test requires fresh derived
   * projections. Normal provider/turn completion must not call this method.
   */
  async flushDerivedWork(traceId: string): Promise<void> {
    try {
      await (this.authoritativeQueues.get(traceId) ?? Promise.resolve());
      await this.controller?.flush(traceId);
      await this.derivedMaintenanceTail;
      await this.disposalPromise;
    } catch {
      this.latchNotice("recordingDegraded", traceId);
    }
  }

  private enqueueDerivedMaintenance(): Promise<boolean> {
    return this.enqueueDerivedWork(() => this.enforceRetention());
  }

  private enqueueDerivedWork(
    work: () => Promise<boolean>,
  ): Promise<boolean> {
    const result = this.derivedMaintenanceTail
      .then(work)
      .catch(() => {
        this.latchNotice("recordingDegraded", null);
        return false;
      });
    this.derivedMaintenanceTail = result.then(() => undefined);
    return result;
  }

  private enqueueAuthoritativeWork(
    traceId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const previous = this.authoritativeQueues.get(traceId)
      ?? Promise.resolve();
    const settled = previous
      .then(work)
      .catch(() => {
        this.latchNotice("recordingDegraded", traceId);
      });
    this.authoritativeQueues.set(traceId, settled);
    void settled.then(() => {
      if (this.authoritativeQueues.get(traceId) === settled) {
        this.authoritativeQueues.delete(traceId);
      }
    });
    return settled;
  }

  private async enforceRetention(): Promise<boolean> {
    if (!this.store) return false;
    try {
      this.retentionResult = await cleanupFlightRecorderStorage(
        this.store,
        this.retention,
      );
    } catch {
      this.latchNotice("retentionFailed", null);
      return false;
    }
    try {
      await rebuildFlightRecorderIndex(this.store);
    } catch {
      this.latchNotice("indexFailed", null);
      return false;
    }
    return true;
  }

  private aggregateRoomTurnOutcome(
    state: MutableRoomTurn,
    parent: FlightRecordedOutcome,
  ): FlightRecordedOutcome {
    const childOutcomes = [
      ...state.agentOperations.values(),
      ...state.auxiliaryOperations.values(),
    ];
    for (const operation of childOutcomes) {
      if (
        operation.outcome?.status === "deliveryUnknown"
        || operation.outcome?.failureCode === "terminationUnconfirmed"
      ) {
        return operation.outcome;
      }
    }
    if (parent.status === "cancelled" || parent.failureCode === "cancelled") {
      return parent;
    }
    const parentIsCoarse = parent.status === "succeeded"
      || (
        parent.status === "failed"
        && (
          parent.failureCode === "providerFailure"
          || parent.failureCode === "unknown"
        )
    );
    if (!parentIsCoarse) return parent;
    for (const operation of childOutcomes) {
      if (operation.outcome && operation.outcome.status !== "succeeded") {
        return operation.outcome;
      }
    }
    return parent;
  }

  private onControllerNotice(notice: FlightRecorderHealthNotice): void {
    this.latchNotice(
      "recordingDegraded",
      notice.traceId,
      notice.code,
    );
  }

  private latchNotice(
    code: FlightRecorderRuntimeNoticeCode,
    traceId: string | null,
    recorderCode?: FlightHealthNoticeCode,
  ): void {
    if (this.latchedNotice !== undefined) return;
    const notice: FlightRecorderRuntimeNotice = Object.freeze({
      code,
      traceId: isFlightTraceId(traceId) ? traceId : null,
      ...(recorderCode === undefined ? {} : { recorderCode }),
    });
    this.latchedNotice = notice;
    try {
      this.options.onNotice?.(notice);
    } catch {
      // Health presentation cannot breach the recorder's nonthrowing boundary.
    }
  }

  private newIdentifier(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }

  private nowMs(): number {
    try {
      const value = (this.options.now?.() ?? new Date()).getTime();
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  private durationSince(startedAtMs: number): number {
    return Math.max(0, this.nowMs() - startedAtMs);
  }
}

export function createFlightRecorderRuntime(
  options: FlightRecorderRuntimeOptions,
): Promise<FlightRecorderRuntime> {
  return FlightRecorderRuntime.create(options);
}
