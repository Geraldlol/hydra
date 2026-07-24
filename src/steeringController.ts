import { randomUUID } from "node:crypto";
import {
  STEERING_LIMITS,
  STEERING_SCHEMA_VERSION,
  acknowledgementMatchesRequest,
  dispositionForDelivery,
  isBoundedIdentifier,
  isCanonicalTimestamp,
  isMissionBindingPair,
  isSha256,
  isSteeringCapability,
  isSteeringProviderAcknowledgement,
  lockedWorkCode,
  sha256Utf8,
  steeringTargetKey,
  validateSteeringText,
  type SteeringCapability,
  type SteeringChainBinding,
  type SteeringDelivery,
  type SteeringIntent,
  type SteeringOutcomeCode,
  type SteeringProviderAcknowledgement,
  type SteeringProviderRequest,
  type SteeringRequestedEvent,
  type SteeringTargetBinding,
  type SteeringTargetOutcomeEvent,
  type SteeringTerminalOutcome,
  type SteeringWorkClass,
} from "./steeringProtocol";
import type { SteeringStore } from "./steeringStore";
import {
  MissionSubmissionRejectedError,
  type MissionSubmissionGate,
} from "./missionDispatch";

export interface ActiveRunInspection {
  readonly callId: string;
  readonly generation: string;
  readonly active: boolean;
  readonly ownerId: string;
  readonly missionDocumentSha256: string | null;
  readonly missionBindingSha256: string;
  readonly authoritySha256: string;
}

interface ActiveSteeringHandleBase {
  readonly capability: SteeringCapability;
  inspect(): Promise<ActiveRunInspection> | ActiveRunInspection;
  close(reason: "completed" | "cancelled" | "failed"): Promise<void>;
}

export interface LiveActiveSteeringHandle extends ActiveSteeringHandleBase {
  readonly capability: Extract<SteeringCapability, { kind: "live" }>;
  steer(
    request: SteeringProviderRequest,
    submissionGate?: MissionSubmissionGate,
  ): Promise<unknown>;
}

export interface NonLiveActiveSteeringHandle extends ActiveSteeringHandleBase {
  readonly capability: Exclude<SteeringCapability, { kind: "live" }>;
}

export type ActiveSteeringHandle = LiveActiveSteeringHandle | NonLiveActiveSteeringHandle;

export interface ActiveSteeringRunRegistration {
  readonly callId: string;
  readonly generation: string;
  readonly agentId: string;
  readonly roomTurnId: string;
  readonly missionDocumentSha256: string | null;
  readonly missionBindingSha256: string;
  readonly authoritySha256: string;
  readonly initialPromptSha256: string;
  readonly ownerId: string;
  readonly workClass: SteeringWorkClass;
  /** Read-only evidence that steering must never modify. */
  readonly phaseSnapshot: string;
  /** Read-only evidence that steering must never reset or extend. */
  readonly timeoutDeadlineMs?: number;
  readonly handle: ActiveSteeringHandle;
}

export interface SteeringTargetSelection {
  readonly callId: string;
  readonly generation: string;
  readonly agentId: string;
  readonly roomTurnId: string;
  readonly missionDocumentSha256: string | null;
  readonly missionBindingSha256: string;
  readonly authoritySha256: string;
  readonly initialPromptSha256: string;
  readonly ownerId: string;
  readonly workClass: SteeringWorkClass;
  readonly capability: SteeringCapability;
  readonly phaseSnapshot: string;
  readonly timeoutDeadlineMs?: number;
  readonly selectionSha256: string;
}

export interface SteeringSendInput {
  readonly source: "localUser";
  readonly intent: SteeringIntent;
  readonly roomTurnId: string;
  readonly text: string;
  readonly targets: readonly SteeringTargetSelection[];
}

export interface SteeringSendReceipt {
  readonly steeringId: string;
  readonly requestEventId: string;
  readonly outcomes: readonly SteeringTargetOutcomeEvent[];
  readonly chainBindings: readonly SteeringChainBinding[];
}

export type SteeringRequestRejectionCode =
  | "invalidSource"
  | "invalidRequest"
  | "invalidTarget"
  | "queueFull";

export class SteeringRequestRejectedError extends Error {
  constructor(
    readonly code: SteeringRequestRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "SteeringRequestRejectedError";
  }
}

/**
 * Provider adapters use this error only when they can classify whether a
 * failed write may already have reached the native runtime. The controller
 * never retries either class automatically.
 */
export class SteeringProviderError extends Error {
  constructor(
    readonly code: Extract<SteeringOutcomeCode, "providerFailure" | "processExit">,
    readonly deliveryMayHaveOccurred: boolean,
    message: string,
  ) {
    super(message);
    this.name = "SteeringProviderError";
  }
}

export type SteeringAcknowledgementWaitResult =
  | { readonly kind: "resolved"; readonly value: unknown }
  | { readonly kind: "rejected"; readonly error: unknown }
  | { readonly kind: "timeout" };

export interface SteeringControllerDependencies {
  readonly store: SteeringStore;
  readonly ownerId: string;
  /**
   * Holds the authoritative Mission ledger lease through only the exact
   * provider/queue write. Provider handles must use this gate at their real
   * stdin/RPC boundary rather than around their full response lifetime.
   */
  readonly missionSubmissionGate: (
    expectedBindingSha256: string,
  ) => MissionSubmissionGate;
  readonly now?: () => string;
  readonly newId?: (kind: "steering" | "event") => string;
  readonly acknowledgementTimeoutMs?: number;
  readonly waitForAcknowledgement?: (
    acknowledgement: Promise<unknown>,
    timeoutMs: number,
  ) => Promise<SteeringAcknowledgementWaitResult>;
  /**
   * Existing Hydra room queue adapter. It is separate from a live provider
   * handle so "queue" can never be mislabeled as native same-turn steering.
   */
  readonly queueNextHydraTurn?: (
    request: SteeringProviderRequest,
    submissionGate: MissionSubmissionGate,
  ) => Promise<unknown>;
}

interface ActiveRunState {
  readonly registration: ActiveSteeringRunRegistration;
  readonly selection: SteeringTargetSelection;
  accepting: boolean;
  closed: boolean;
  lastSequence: number;
  tail: Promise<void>;
}

interface AdmittedTarget {
  readonly state: ActiveRunState;
  readonly binding: SteeringTargetBinding;
}

interface AdmittedRequest {
  readonly event: SteeringRequestedEvent;
  readonly text: string;
  readonly targets: readonly AdmittedTarget[];
}

export class SteeringController {
  private readonly runs = new Map<string, ActiveRunState>();
  private readonly activeGenerationByCall = new Map<string, string>();
  private readonly now: () => string;
  private readonly newId: (kind: "steering" | "event") => string;
  private readonly acknowledgementTimeoutMs: number;
  private readonly waitForAcknowledgement: NonNullable<SteeringControllerDependencies["waitForAcknowledgement"]>;
  private admissionTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SteeringControllerDependencies) {
    if (!isBoundedIdentifier(deps.ownerId)) throw new Error("Steering controller owner ID is invalid.");
    if (typeof deps.missionSubmissionGate !== "function") {
      throw new Error("Steering controller requires an authoritative Mission submission gate.");
    }
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? ((kind) => `${kind}-${randomUUID()}`);
    const timeout = deps.acknowledgementTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
      throw new Error("Steering acknowledgement timeout must be between 1 and 60000 ms.");
    }
    this.acknowledgementTimeoutMs = timeout;
    this.waitForAcknowledgement = deps.waitForAcknowledgement ?? waitForAcknowledgement;
  }

  registerRun(registration: ActiveSteeringRunRegistration): SteeringTargetSelection {
    validateRegistration(registration);
    const key = steeringTargetKey(registration);
    if (this.runs.has(key)) {
      throw new Error(`Steering run ${registration.callId}/${registration.generation} is already registered.`);
    }
    const currentGeneration = this.activeGenerationByCall.get(registration.callId);
    if (currentGeneration) {
      const current = this.runs.get(steeringTargetKey({
        callId: registration.callId,
        generation: currentGeneration,
      }));
      if (current && !current.closed) {
        throw new Error(`Call ${registration.callId} already has an active steering generation.`);
      }
    }
    const chain = this.deps.store.chainBinding(
      registration.callId,
      registration.generation,
      registration.initialPromptSha256,
    );
    const selection = createSelection(registration);
    this.runs.set(key, {
      registration,
      selection,
      accepting: true,
      closed: false,
      lastSequence: chain.lastSequence,
      tail: Promise.resolve(),
    });
    this.activeGenerationByCall.set(registration.callId, registration.generation);
    return selection;
  }

  targetSelections(callIds?: readonly string[]): readonly SteeringTargetSelection[] {
    const selected = callIds ? new Set(callIds) : undefined;
    const results: SteeringTargetSelection[] = [];
    for (const state of this.runs.values()) {
      const { registration } = state;
      if (!state.accepting || state.closed) continue;
      if (this.activeGenerationByCall.get(registration.callId) !== registration.generation) continue;
      if (registration.workClass === "hiddenMaintenance") continue;
      if (selected && !selected.has(registration.callId)) continue;
      results.push(cloneSelection(state.selection));
    }
    return results.sort((left, right) =>
      left.callId.localeCompare(right.callId) || left.generation.localeCompare(right.generation)
    );
  }

  async send(input: SteeringSendInput): Promise<SteeringSendReceipt> {
    const admitted = await this.serializeAdmission(() => this.admit(input));
    const outcomes = await Promise.all(admitted.targets.map(({ state, binding }) =>
      this.enqueueRun(state, () => this.deliverTarget(admitted, state, binding))
    ));
    return {
      steeringId: admitted.event.steeringId,
      requestEventId: admitted.event.eventId,
      outcomes,
      chainBindings: admitted.targets.map(({ binding }) =>
        this.deps.store.chainBinding(binding.callId, binding.generation, binding.initialPromptSha256)
      ),
    };
  }

  async closeRun(
    target: Pick<SteeringTargetSelection, "callId" | "generation" | "selectionSha256">,
    reason: "completed" | "cancelled" | "failed",
  ): Promise<void> {
    const state = this.requireSelectedState(target);
    // Acceptance closes synchronously. Already-enqueued steering delivery stays
    // ahead of this close operation; later sends cannot enter the queue.
    state.accepting = false;
    await this.enqueueRun(state, async () => {
      if (state.closed) return;
      state.closed = true;
      if (this.activeGenerationByCall.get(target.callId) === target.generation) {
        this.activeGenerationByCall.delete(target.callId);
      }
      await state.registration.handle.close(reason);
    });
  }

  chainBinding(
    target: Pick<SteeringTargetSelection, "callId" | "generation" | "selectionSha256">,
  ): SteeringChainBinding {
    const state = this.requireSelectedState(target);
    return this.deps.store.chainBinding(
      target.callId,
      target.generation,
      state.registration.initialPromptSha256,
    );
  }

  private async admit(input: SteeringSendInput): Promise<AdmittedRequest> {
    if ((input as { source?: unknown }).source !== "localUser") {
      throw new SteeringRequestRejectedError("invalidSource", "Only direct local-user steering is enabled.");
    }
    if ((input as { intent?: unknown }).intent !== "steer" && input.intent !== "queue") {
      throw new SteeringRequestRejectedError("invalidRequest", "Unknown steering intent.");
    }
    if (!isBoundedIdentifier(input.roomTurnId)) {
      throw new SteeringRequestRejectedError("invalidRequest", "Steering room-turn ID is invalid.");
    }
    let metrics;
    try {
      metrics = validateSteeringText(input.text);
    } catch (error) {
      throw new SteeringRequestRejectedError("invalidRequest", (error as Error).message);
    }
    if (!Array.isArray(input.targets)
      || input.targets.length === 0
      || input.targets.length > STEERING_LIMITS.maxTargetsPerRequest) {
      throw new SteeringRequestRejectedError(
        "invalidTarget",
        `Select between 1 and ${STEERING_LIMITS.maxTargetsPerRequest} exact active runs.`,
      );
    }

    const selectedStates: ActiveRunState[] = [];
    const seen = new Set<string>();
    for (const selection of input.targets) {
      if (!isSelectionShape(selection)) {
        throw new SteeringRequestRejectedError("invalidTarget", "Steering target snapshot is malformed.");
      }
      const key = steeringTargetKey(selection);
      if (seen.has(key)) {
        throw new SteeringRequestRejectedError("invalidTarget", `Steering target ${selection.callId} is duplicated.`);
      }
      seen.add(key);
      const state = this.runs.get(key);
      if (!state || state.selection.selectionSha256 !== selection.selectionSha256) {
        throw new SteeringRequestRejectedError(
          "invalidTarget",
          `Steering target ${selection.callId}/${selection.generation} is not a registered exact snapshot.`,
        );
      }
      if (!equalSelections(state.selection, selection)) {
        throw new SteeringRequestRejectedError(
          "invalidTarget",
          `Steering target ${selection.callId}/${selection.generation} was altered after selection.`,
        );
      }
      if (selection.roomTurnId !== input.roomTurnId) {
        throw new SteeringRequestRejectedError(
          "invalidTarget",
          `Steering target ${selection.callId} belongs to another room turn.`,
        );
      }
      selectedStates.push(state);
    }

    const usage = this.deps.store.pendingUsage();
    if (usage.messages + 1 > STEERING_LIMITS.maxUnresolvedMessagesPerRoom
      || usage.bytes + metrics.bytes > STEERING_LIMITS.maxUnresolvedBytes) {
      throw new SteeringRequestRejectedError("queueFull", "The bounded room steering queue is full.");
    }
    for (const state of selectedStates) {
      const runKey = steeringTargetKey(state.registration);
      if ((usage.perRun.get(runKey) ?? 0) + 1 > STEERING_LIMITS.maxUnresolvedMessagesPerRun) {
        throw new SteeringRequestRejectedError(
          "queueFull",
          `The bounded steering queue for ${state.registration.callId} is full.`,
        );
      }
    }

    const steeringId = checkedGeneratedId(this.newId("steering"), "steering");
    const occurredAt = checkedTimestamp(this.now());
    const targets: AdmittedTarget[] = selectedStates.map((state) => {
      const sequence = state.lastSequence + 1;
      const expectedDelivery = input.intent === "queue"
        ? "nextHydraTurn"
        : state.registration.handle.capability.delivery;
      return {
        state,
        binding: {
          callId: state.registration.callId,
          generation: state.registration.generation,
          agentId: state.registration.agentId,
          roomTurnId: state.registration.roomTurnId,
          sequence,
          expectedDelivery,
          missionDocumentSha256: state.registration.missionDocumentSha256,
          missionBindingSha256: state.registration.missionBindingSha256,
          authoritySha256: state.registration.authoritySha256,
          initialPromptSha256: state.registration.initialPromptSha256,
          ownerId: state.registration.ownerId,
          workClass: state.registration.workClass,
        },
      };
    });
    const event: SteeringRequestedEvent = {
      schemaVersion: STEERING_SCHEMA_VERSION,
      type: "steeringRequested",
      eventId: checkedGeneratedId(this.newId("event"), "event"),
      occurredAt,
      steeringId,
      source: "localUser",
      intent: input.intent,
      roomTurnId: input.roomTurnId,
      textSha256: metrics.sha256,
      textCharacters: metrics.characters,
      textBytes: metrics.bytes,
      targets: targets.map(({ binding }) => binding),
    };
    await this.deps.store.recordRequest(event, input.text);
    for (const target of targets) target.state.lastSequence = target.binding.sequence;
    return { event, text: input.text, targets };
  }

  private async deliverTarget(
    admitted: AdmittedRequest,
    state: ActiveRunState,
    binding: SteeringTargetBinding,
  ): Promise<SteeringTargetOutcomeEvent> {
    const prior = this.deps.store.chainBinding(
      binding.callId,
      binding.generation,
      binding.initialPromptSha256,
    );
    await this.deps.store.recordEvent({
      schemaVersion: STEERING_SCHEMA_VERSION,
      type: "steeringDeliveryStarted",
      eventId: checkedGeneratedId(this.newId("event"), "event"),
      occurredAt: checkedTimestamp(this.now()),
      steeringId: admitted.event.steeringId,
      callId: binding.callId,
      generation: binding.generation,
      sequence: binding.sequence,
      priorSteeringChainSha256: prior.steeringChainSha256,
      priorChainIndeterminate: prior.chainIndeterminate,
    });

    if (state.closed) {
      const activeGeneration = this.activeGenerationByCall.get(binding.callId);
      return this.recordOutcome(
        admitted,
        binding,
        "missedWindow",
        activeGeneration && activeGeneration !== binding.generation
          ? "staleHandle"
          : "endedBeforeAcceptance",
      );
    }
    if (this.activeGenerationByCall.get(binding.callId) !== binding.generation) {
      return this.recordOutcome(admitted, binding, "missedWindow", "staleHandle");
    }
    const lockedCode = lockedWorkCode(binding.workClass);
    if (lockedCode) return this.recordOutcome(admitted, binding, "rejected", lockedCode);
    if (state.registration.handle.capability.kind === "disabled") {
      return this.recordOutcome(admitted, binding, "unsupported", "unsupported");
    }

    let inspection: ActiveRunInspection;
    try {
      inspection = await state.registration.handle.inspect();
    } catch {
      return this.recordOutcome(admitted, binding, "failed", "providerFailure");
    }
    if (!isActiveRunInspection(inspection)) {
      return this.recordOutcome(admitted, binding, "failed", "providerFailure");
    }
    if (inspection.callId !== binding.callId || inspection.generation !== binding.generation) {
      return this.recordOutcome(admitted, binding, "missedWindow", "staleHandle");
    }
    if (!inspection.active) {
      return this.recordOutcome(admitted, binding, "missedWindow", "endedBeforeAcceptance");
    }
    if (inspection.ownerId !== this.deps.ownerId || inspection.ownerId !== binding.ownerId) {
      return this.recordOutcome(admitted, binding, "rejected", "remoteOwner");
    }
    if (inspection.missionDocumentSha256 !== binding.missionDocumentSha256
      || inspection.missionBindingSha256 !== binding.missionBindingSha256) {
      return this.recordOutcome(admitted, binding, "rejected", "missionHashMismatch");
    }
    if (inspection.authoritySha256 !== binding.authoritySha256) {
      return this.recordOutcome(admitted, binding, "rejected", "authorityHashMismatch");
    }
    const request: SteeringProviderRequest = {
      schemaVersion: STEERING_SCHEMA_VERSION,
      steeringId: admitted.event.steeringId,
      source: "localUser",
      intent: admitted.event.intent,
      text: admitted.text,
      textSha256: admitted.event.textSha256,
      textCharacters: admitted.event.textCharacters,
      textBytes: admitted.event.textBytes,
      target: binding,
    };
    let delivery: Promise<unknown>;
    const handle = state.registration.handle;
    const submissionGate = this.deps.missionSubmissionGate(
      binding.missionBindingSha256,
    );
    if (admitted.event.intent === "queue"
      || handle.capability.kind === "nextDispatch") {
      if (!this.deps.queueNextHydraTurn) {
        return this.recordOutcome(admitted, binding, "unsupported", "unsupported");
      }
      delivery = this.deps.queueNextHydraTurn(request, submissionGate);
    } else if (isLiveHandle(handle)) {
      delivery = handle.steer(request, submissionGate);
    } else {
      return this.recordOutcome(admitted, binding, "unsupported", "unsupported");
    }

    const waited = await this.waitForAcknowledgement(delivery, this.acknowledgementTimeoutMs);
    if (waited.kind === "timeout") {
      // The original promise is intentionally left alive and observed; timeout
      // neither cancels the run nor triggers a duplicate write.
      void delivery.catch(() => undefined);
      return this.recordOutcome(admitted, binding, "deliveryUnknown", "acknowledgementTimeout");
    }
    if (waited.kind === "rejected") {
      const error = waited.error;
      if (error instanceof MissionSubmissionRejectedError) {
        return this.recordOutcome(admitted, binding, "rejected", "missionHashMismatch");
      }
      if (error instanceof SteeringProviderError) {
        return this.recordOutcome(
          admitted,
          binding,
          error.deliveryMayHaveOccurred ? "deliveryUnknown" : "failed",
          error.code,
        );
      }
      return this.recordOutcome(admitted, binding, "failed", "providerFailure");
    }
    const acknowledgement = waited.value;
    if (!isSteeringProviderAcknowledgement(acknowledgement)
      || binding.expectedDelivery === "unsupported"
      || !acknowledgementMatchesRequest(acknowledgement, request, binding.expectedDelivery)) {
      return this.recordOutcome(admitted, binding, "deliveryUnknown", "malformedAcknowledgement");
    }
    if (acknowledgement.status === "rejected") {
      return this.recordOutcome(admitted, binding, "rejected", "providerRejected");
    }
    return this.recordOutcome(
      admitted,
      binding,
      "acknowledged",
      "acknowledged",
      acknowledgement,
    );
  }

  private async recordOutcome(
    admitted: AdmittedRequest,
    binding: SteeringTargetBinding,
    outcome: SteeringTerminalOutcome,
    code: SteeringOutcomeCode,
    acknowledgement?: Extract<SteeringProviderAcknowledgement, { status: "acknowledged" }>,
  ): Promise<SteeringTargetOutcomeEvent> {
    const chain = this.deps.store.previewOutcomeBinding(
      binding.callId,
      binding.generation,
      admitted.event.textSha256,
      outcome,
      binding.initialPromptSha256,
    );
    const event: SteeringTargetOutcomeEvent = {
      schemaVersion: STEERING_SCHEMA_VERSION,
      type: "steeringTargetOutcome",
      eventId: checkedGeneratedId(this.newId("event"), "event"),
      occurredAt: checkedTimestamp(this.now()),
      steeringId: admitted.event.steeringId,
      callId: binding.callId,
      generation: binding.generation,
      sequence: binding.sequence,
      outcome,
      disposition: acknowledgement
        ? dispositionForDelivery(acknowledgement.delivery)
        : outcome === "deliveryUnknown" || outcome === "sentUnconfirmed"
          ? "deliveryUnknown"
          : "rejected",
      code,
      ...(acknowledgement
        ? {
            acknowledgedDelivery: acknowledgement.delivery,
            providerReceiptSha256: acknowledgement.providerReceiptSha256,
          }
        : {}),
      steeringChainSha256: chain.steeringChainSha256,
      chainIndeterminate: chain.chainIndeterminate,
    };
    await this.deps.store.recordEvent(event);
    return event;
  }

  private requireSelectedState(
    target: Pick<SteeringTargetSelection, "callId" | "generation" | "selectionSha256">,
  ): ActiveRunState {
    const state = this.runs.get(steeringTargetKey(target));
    if (!state || state.selection.selectionSha256 !== target.selectionSha256) {
      throw new SteeringRequestRejectedError("invalidTarget", "Steering target snapshot is stale or unknown.");
    }
    return state;
  }

  private enqueueRun<T>(state: ActiveRunState, work: () => Promise<T>): Promise<T> {
    const next = state.tail.then(work, work);
    state.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  private serializeAdmission<T>(work: () => Promise<T>): Promise<T> {
    const next = this.admissionTail.then(work, work);
    this.admissionTail = next.then(() => undefined, () => undefined);
    return next;
  }
}

function createSelection(registration: ActiveSteeringRunRegistration): SteeringTargetSelection {
  const base = {
    callId: registration.callId,
    generation: registration.generation,
    agentId: registration.agentId,
    roomTurnId: registration.roomTurnId,
    missionDocumentSha256: registration.missionDocumentSha256,
    missionBindingSha256: registration.missionBindingSha256,
    authoritySha256: registration.authoritySha256,
    initialPromptSha256: registration.initialPromptSha256,
    ownerId: registration.ownerId,
    workClass: registration.workClass,
    capability: registration.handle.capability,
    phaseSnapshot: registration.phaseSnapshot,
    ...(registration.timeoutDeadlineMs === undefined
      ? {}
      : { timeoutDeadlineMs: registration.timeoutDeadlineMs }),
  };
  return {
    ...base,
    selectionSha256: selectionHash(base),
  };
}

function selectionHash(
  selection: Omit<SteeringTargetSelection, "selectionSha256">,
): string {
  const capability = selection.capability.kind === "live"
    ? [selection.capability.kind, selection.capability.delivery, selection.capability.protocol]
    : [selection.capability.kind, selection.capability.delivery, selection.capability.reason];
  return sha256Utf8(JSON.stringify([
    "hydra-steering-selection-mission-binding-v1",
    selection.callId,
    selection.generation,
    selection.agentId,
    selection.roomTurnId,
    selection.missionDocumentSha256,
    selection.missionBindingSha256,
    selection.authoritySha256,
    selection.initialPromptSha256,
    selection.ownerId,
    selection.workClass,
    capability,
    selection.phaseSnapshot,
    selection.timeoutDeadlineMs ?? null,
  ]));
}

function cloneSelection(selection: SteeringTargetSelection): SteeringTargetSelection {
  return {
    ...selection,
    capability: { ...selection.capability },
  };
}

function equalSelections(left: SteeringTargetSelection, right: SteeringTargetSelection): boolean {
  if (left.selectionSha256 !== right.selectionSha256) return false;
  const { selectionSha256: _leftHash, ...leftBase } = left;
  const { selectionSha256: _rightHash, ...rightBase } = right;
  return selectionHash(leftBase) === selectionHash(rightBase);
}

function isSelectionShape(value: unknown): value is SteeringTargetSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([
    "callId",
    "generation",
    "agentId",
    "roomTurnId",
    "missionDocumentSha256",
    "missionBindingSha256",
    "authoritySha256",
    "initialPromptSha256",
    "ownerId",
    "workClass",
    "capability",
    "phaseSnapshot",
    "timeoutDeadlineMs",
    "selectionSha256",
  ]);
  const required = [...allowed].filter((key) => key !== "timeoutDeadlineMs");
  if (!keys.every((key) => allowed.has(key))
    || !required.every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    return false;
  }
  const selection = value as Partial<SteeringTargetSelection>;
  return isBoundedIdentifier(selection.callId)
    && isBoundedIdentifier(selection.generation)
    && isBoundedIdentifier(selection.agentId)
    && isBoundedIdentifier(selection.roomTurnId)
    && isMissionBindingPair(selection.missionDocumentSha256, selection.missionBindingSha256)
    && isSha256(selection.authoritySha256)
    && isSha256(selection.initialPromptSha256)
    && isBoundedIdentifier(selection.ownerId)
    && typeof selection.workClass === "string"
    && [
      "discussion",
      "build",
      "review",
      "missionTask",
      "nestedWorker",
      "sealedJury",
      "formalDuel",
      "deterministicReferee",
      "hiddenMaintenance",
      "verification",
      "arenaLocked",
    ].includes(selection.workClass)
    && isSteeringCapability(selection.capability)
    && isBoundedIdentifier(selection.phaseSnapshot)
    && (selection.timeoutDeadlineMs === undefined
      || (Number.isFinite(selection.timeoutDeadlineMs) && selection.timeoutDeadlineMs >= 0))
    && isSha256(selection.selectionSha256);
}

function validateRegistration(registration: ActiveSteeringRunRegistration): void {
  for (const [label, value] of [
    ["call ID", registration.callId],
    ["generation", registration.generation],
    ["agent ID", registration.agentId],
    ["room-turn ID", registration.roomTurnId],
    ["owner ID", registration.ownerId],
    ["phase snapshot", registration.phaseSnapshot],
  ] as const) {
    if (!isBoundedIdentifier(value)) throw new Error(`Steering ${label} is invalid.`);
  }
  if (!isMissionBindingPair(
    registration.missionDocumentSha256,
    registration.missionBindingSha256,
  )) {
    throw new Error("Steering Mission document/binding hashes are invalid or inconsistent.");
  }
  for (const [label, value] of [
    ["authority", registration.authoritySha256],
    ["initial prompt", registration.initialPromptSha256],
  ] as const) {
    if (!isSha256(value)) throw new Error(`Steering ${label} hash is invalid.`);
  }
  if (!isSteeringCapability(registration.handle.capability)) {
    throw new Error("Steering provider capability is malformed.");
  }
  if (registration.handle.capability.kind === "live"
    && typeof (registration.handle as Partial<LiveActiveSteeringHandle>).steer !== "function") {
    throw new Error("Live steering capability requires a steer function.");
  }
  if (typeof registration.handle.inspect !== "function" || typeof registration.handle.close !== "function") {
    throw new Error("Steering handle lifecycle functions are required.");
  }
  if (registration.timeoutDeadlineMs !== undefined
    && (!Number.isFinite(registration.timeoutDeadlineMs) || registration.timeoutDeadlineMs < 0)) {
    throw new Error("Steering timeout deadline snapshot is invalid.");
  }
  if (![
    "discussion",
    "build",
    "review",
    "missionTask",
    "nestedWorker",
    "sealedJury",
    "formalDuel",
    "deterministicReferee",
    "hiddenMaintenance",
    "verification",
    "arenaLocked",
  ].includes(registration.workClass)) {
    throw new Error("Steering work class is invalid.");
  }
}

function isActiveRunInspection(value: unknown): value is ActiveRunInspection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const expected = new Set([
    "callId",
    "generation",
    "active",
    "ownerId",
    "missionDocumentSha256",
    "missionBindingSha256",
    "authoritySha256",
  ]);
  if (keys.length !== expected.size || !keys.every((key) => expected.has(key))) return false;
  const inspection = value as Partial<ActiveRunInspection>;
  return isBoundedIdentifier(inspection.callId)
    && isBoundedIdentifier(inspection.generation)
    && typeof inspection.active === "boolean"
    && isBoundedIdentifier(inspection.ownerId)
    && isMissionBindingPair(inspection.missionDocumentSha256, inspection.missionBindingSha256)
    && isSha256(inspection.authoritySha256);
}

function isLiveHandle(handle: ActiveSteeringHandle): handle is LiveActiveSteeringHandle {
  return handle.capability.kind === "live" && typeof (handle as Partial<LiveActiveSteeringHandle>).steer === "function";
}

function checkedGeneratedId(value: string, kind: string): string {
  if (!isBoundedIdentifier(value)) throw new Error(`Generated steering ${kind} ID is invalid.`);
  return value;
}

function checkedTimestamp(value: string): string {
  if (!isCanonicalTimestamp(value)) throw new Error("Generated steering timestamp is invalid.");
  return value;
}

async function waitForAcknowledgement(
  acknowledgement: Promise<unknown>,
  timeoutMs: number,
): Promise<SteeringAcknowledgementWaitResult> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "timeout" });
    }, timeoutMs);
    timer.unref();
    void acknowledgement.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "resolved", value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "rejected", error });
      },
    );
  });
}
