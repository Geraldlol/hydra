import {
  STEERING_LIMITS,
  STEERING_SCHEMA_VERSION,
  computeSteeringChainSha256,
  dispositionForDelivery,
  isBoundedIdentifier,
  isSha256,
  isSteeringEvent,
  steeringRequestTargetKey,
  steeringTargetKey,
  steeringTextMetrics,
  validateSteeringText,
  type SteeringChainBinding,
  type SteeringDeliveryStartedEvent,
  type SteeringEvent,
  type SteeringRequestedEvent,
  type SteeringTargetBinding,
  type SteeringTargetOutcomeEvent,
} from "./steeringProtocol";

export const MAX_STEERING_EVENTS = 100_000;

export type SteeringValidationCode =
  | "invalidEvent"
  | "unknownVersion"
  | "duplicateEvent"
  | "duplicateSteering"
  | "duplicateTarget"
  | "invalidReference"
  | "invalidSequence"
  | "invalidTransition"
  | "invalidOutcome"
  | "hashMismatch"
  | "boundsExceeded"
  | "invalidPending"
  | "missingPending";

export interface SteeringValidationIssue {
  readonly index: number;
  readonly eventId?: string;
  readonly code: SteeringValidationCode;
  readonly message: string;
}

export class SteeringValidationError extends Error {
  constructor(readonly issues: readonly SteeringValidationIssue[]) {
    super(issues.map((issue) => `#${issue.index + 1} ${issue.code}: ${issue.message}`).join("; "));
    this.name = "SteeringValidationError";
  }
}

export interface SteeringPendingTarget {
  readonly callId: string;
  readonly generation: string;
  readonly sequence: number;
}

export interface SteeringPendingMessage {
  readonly steeringId: string;
  readonly text: string;
  readonly textSha256: string;
  readonly textCharacters: number;
  readonly textBytes: number;
  readonly unresolvedTargets: readonly SteeringPendingTarget[];
}

export interface SteeringPendingSnapshot {
  readonly schemaVersion: typeof STEERING_SCHEMA_VERSION;
  readonly messages: readonly SteeringPendingMessage[];
}

export interface SteeringPendingUsage {
  readonly messages: number;
  readonly bytes: number;
  readonly perRun: ReadonlyMap<string, number>;
}

export interface SteeringRequestReplay {
  readonly event: SteeringRequestedEvent;
  readonly startedTargetKeys: ReadonlySet<string>;
  readonly outcomes: ReadonlyMap<string, SteeringTargetOutcomeEvent>;
}

export interface SteeringReplay {
  readonly issues: readonly SteeringValidationIssue[];
  readonly eventCount: number;
  readonly requests: ReadonlyMap<string, SteeringRequestReplay>;
  readonly chainBindings: ReadonlyMap<string, SteeringChainBinding>;
  readonly unresolvedTargets: ReadonlySet<string>;
}

export interface SteeringStore {
  recordRequest(event: SteeringRequestedEvent, text: string): Promise<void>;
  recordEvent(event: SteeringDeliveryStartedEvent | SteeringTargetOutcomeEvent): Promise<void>;
  events(): readonly SteeringEvent[];
  pending(): SteeringPendingSnapshot;
  pendingUsage(): SteeringPendingUsage;
  chainBinding(callId: string, generation: string, initialPromptSha256?: string): SteeringChainBinding;
  previewOutcomeBinding(
    callId: string,
    generation: string,
    textSha256: string,
    outcome: SteeringTargetOutcomeEvent["outcome"],
    initialPromptSha256?: string,
  ): Pick<SteeringChainBinding, "steeringChainSha256" | "chainIndeterminate">;
  /**
   * Persisted stores use a cross-process election and reload the latest
   * durable replay before startup orphan classification. In-memory stores do
   * not need this seam.
   */
  withFreshOrphanRecovery?<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * Persistence deliberately exposes whole-snapshot pending writes and
 * append-only event writes. Production wiring can map these to fileQueue's
 * cross-process append and atomic replacement without giving the controller
 * direct filesystem access.
 */
export interface SteeringPersistence {
  loadEvents(): Promise<readonly unknown[]>;
  loadPending(): Promise<unknown>;
  appendEvents(events: readonly SteeringEvent[]): Promise<void>;
  writePending(snapshot: SteeringPendingSnapshot): Promise<void>;
  /**
   * Serialize startup orphan classification across extension hosts. This lock
   * must be distinct from the events and pending-file locks because recovery
   * appends both event classes and compacts pending bodies while holding it.
   */
  withOrphanRecoveryLock?<T>(work: () => Promise<T>): Promise<T>;
}

interface MutableRequestReplay {
  event: SteeringRequestedEvent;
  startedTargetKeys: Set<string>;
  outcomes: Map<string, SteeringTargetOutcomeEvent>;
}

interface MutableRunReplay {
  callId: string;
  generation: string;
  initialPromptSha256: string;
  lastSequence: number;
  lastStartedSequence: number;
  lastTerminalSequence: number;
  lastAcknowledgedSequence: number;
  acknowledgedHashes: string[];
  steeringChainSha256: string;
  chainIndeterminate: boolean;
}

interface InternalReplay {
  publicReplay: SteeringReplay;
  requests: Map<string, MutableRequestReplay>;
  runs: Map<string, MutableRunReplay>;
}

export function emptySteeringPendingSnapshot(): SteeringPendingSnapshot {
  return { schemaVersion: STEERING_SCHEMA_VERSION, messages: [] };
}

export function validateSteeringEvents(events: readonly unknown[]): SteeringValidationIssue[] {
  return replaySteeringEventsInternal(events).publicReplay.issues.slice();
}

export function replaySteeringEvents(events: readonly unknown[]): SteeringReplay {
  return replaySteeringEventsInternal(events).publicReplay;
}

export function assertValidSteeringEvents(events: readonly unknown[]): readonly SteeringEvent[] {
  const issues = validateSteeringEvents(events);
  if (issues.length > 0) throw new SteeringValidationError(issues);
  return events as readonly SteeringEvent[];
}

/**
 * Validates pending message bodies against the authoritative event replay.
 * Resolved target references are safely compacted on recovery; unknown,
 * missing, duplicated, or hash-mismatched bodies fail closed.
 */
export function recoverSteeringPendingSnapshot(
  events: readonly unknown[],
  value: unknown,
): { snapshot: SteeringPendingSnapshot; issues: readonly SteeringValidationIssue[]; changed: boolean } {
  const replay = replaySteeringEventsInternal(events);
  const issues = replay.publicReplay.issues.slice();
  if (issues.length > 0) {
    return { snapshot: emptySteeringPendingSnapshot(), issues, changed: false };
  }

  if (!isPendingSnapshotShape(value)) {
    issues.push(issue(-1, "invalidPending", "Pending steering state has an unknown version or malformed shape."));
    return { snapshot: emptySteeringPendingSnapshot(), issues, changed: false };
  }

  const messages: SteeringPendingMessage[] = [];
  const seenSteeringIds = new Set<string>();
  let changed = false;
  let totalBytes = 0;

  for (const [pendingIndex, pending] of value.messages.entries()) {
    if (seenSteeringIds.has(pending.steeringId)) {
      issues.push(issue(pendingIndex, "invalidPending", `Duplicate pending steering ID ${pending.steeringId}.`));
      continue;
    }
    seenSteeringIds.add(pending.steeringId);
    const request = replay.requests.get(pending.steeringId);
    if (!request) {
      issues.push(issue(pendingIndex, "invalidPending", `Pending steering ID ${pending.steeringId} has no request event.`));
      continue;
    }

    let metrics;
    try {
      metrics = validateSteeringText(pending.text);
    } catch (error) {
      issues.push(issue(pendingIndex, "boundsExceeded", (error as Error).message));
      continue;
    }
    if (metrics.sha256 !== pending.textSha256
      || metrics.sha256 !== request.event.textSha256
      || metrics.characters !== pending.textCharacters
      || metrics.characters !== request.event.textCharacters
      || metrics.bytes !== pending.textBytes
      || metrics.bytes !== request.event.textBytes) {
      issues.push(issue(pendingIndex, "hashMismatch", `Pending body for ${pending.steeringId} does not match its request event.`));
      continue;
    }

    const expected = new Map<string, SteeringPendingTarget>();
    for (const target of request.event.targets) {
      const key = steeringRequestTargetKey(target);
      if (!request.outcomes.has(key)) {
        expected.set(key, {
          callId: target.callId,
          generation: target.generation,
          sequence: target.sequence,
        });
      }
    }
    const actual = new Map<string, SteeringPendingTarget>();
    for (const target of pending.unresolvedTargets) {
      const key = steeringRequestTargetKey(target);
      if (actual.has(key)) {
        issues.push(issue(pendingIndex, "invalidPending", `Pending body ${pending.steeringId} repeats target ${key}.`));
        continue;
      }
      actual.set(key, target);
      if (!request.event.targets.some((candidate) => steeringRequestTargetKey(candidate) === key)) {
        issues.push(issue(pendingIndex, "invalidPending", `Pending body ${pending.steeringId} references an unknown target.`));
      }
    }

    const unresolvedTargets = [...expected.values()];
    if (unresolvedTargets.length === 0) {
      changed = true;
      continue;
    }
    for (const key of expected.keys()) {
      if (!actual.has(key)) {
        issues.push(issue(pendingIndex, "missingPending", `Pending body ${pending.steeringId} omits unresolved target ${key}.`));
      }
    }
    if (actual.size !== expected.size || [...actual.keys()].some((key) => !expected.has(key))) changed = true;
    totalBytes += metrics.bytes;
    messages.push({ ...pending, unresolvedTargets });
  }

  for (const [steeringId, request] of replay.requests) {
    const unresolved = request.event.targets.some((target) =>
      !request.outcomes.has(steeringRequestTargetKey(target))
    );
    if (unresolved && !seenSteeringIds.has(steeringId)) {
      issues.push(issue(-1, "missingPending", `Unresolved steering request ${steeringId} has no recoverable message body.`));
    }
  }

  if (messages.length > STEERING_LIMITS.maxUnresolvedMessagesPerRoom) {
    issues.push(issue(-1, "boundsExceeded", "Pending steering state exceeds the room message bound."));
  }
  if (totalBytes > STEERING_LIMITS.maxUnresolvedBytes) {
    issues.push(issue(-1, "boundsExceeded", "Pending steering state exceeds the total byte bound."));
  }
  const usage = pendingUsageOf({ schemaVersion: STEERING_SCHEMA_VERSION, messages });
  for (const [runKey, count] of usage.perRun) {
    if (count > STEERING_LIMITS.maxUnresolvedMessagesPerRun) {
      issues.push(issue(-1, "boundsExceeded", `Pending steering state exceeds the per-run bound for ${runKey}.`));
    }
  }

  return {
    snapshot: { schemaVersion: STEERING_SCHEMA_VERSION, messages },
    issues,
    changed,
  };
}

export class InMemorySteeringStore implements SteeringStore {
  private currentEvents: SteeringEvent[];
  private currentPending: SteeringPendingSnapshot;
  private replay: InternalReplay;

  constructor(events: readonly unknown[] = [], pending: unknown = emptySteeringPendingSnapshot()) {
    this.replay = replaySteeringEventsInternal(events);
    if (this.replay.publicReplay.issues.length > 0) {
      throw new SteeringValidationError(this.replay.publicReplay.issues);
    }
    const recovered = recoverSteeringPendingSnapshot(events, pending);
    if (recovered.issues.length > 0) throw new SteeringValidationError(recovered.issues);
    this.currentEvents = [...events] as SteeringEvent[];
    this.currentPending = recovered.snapshot;
  }

  async recordRequest(event: SteeringRequestedEvent, text: string): Promise<void> {
    const metrics = validateSteeringText(text);
    if (metrics.sha256 !== event.textSha256
      || metrics.characters !== event.textCharacters
      || metrics.bytes !== event.textBytes) {
      throw new Error("Steering request text does not match its event bindings.");
    }
    const nextPending: SteeringPendingSnapshot = {
      schemaVersion: STEERING_SCHEMA_VERSION,
      messages: [
        ...this.currentPending.messages,
        {
          steeringId: event.steeringId,
          text,
          textSha256: metrics.sha256,
          textCharacters: metrics.characters,
          textBytes: metrics.bytes,
          unresolvedTargets: event.targets.map(({ callId, generation, sequence }) => ({
            callId,
            generation,
            sequence,
          })),
        },
      ],
    };
    this.commit([...this.currentEvents, event], nextPending);
  }

  async recordEvent(event: SteeringDeliveryStartedEvent | SteeringTargetOutcomeEvent): Promise<void> {
    let nextPending = this.currentPending;
    if (event.type === "steeringTargetOutcome") {
      const targetKey = steeringRequestTargetKey(event);
      nextPending = {
        schemaVersion: STEERING_SCHEMA_VERSION,
        messages: this.currentPending.messages.flatMap((pending) => {
          if (pending.steeringId !== event.steeringId) return [pending];
          const unresolvedTargets = pending.unresolvedTargets.filter((target) =>
            steeringRequestTargetKey(target) !== targetKey
          );
          return unresolvedTargets.length > 0 ? [{ ...pending, unresolvedTargets }] : [];
        }),
      };
    }
    this.commit([...this.currentEvents, event], nextPending);
  }

  events(): readonly SteeringEvent[] {
    return this.currentEvents.slice();
  }

  pending(): SteeringPendingSnapshot {
    return clonePending(this.currentPending);
  }

  pendingUsage(): SteeringPendingUsage {
    return pendingUsageOf(this.currentPending);
  }

  chainBinding(callId: string, generation: string, initialPromptSha256?: string): SteeringChainBinding {
    const key = steeringTargetKey({ callId, generation });
    const existing = this.replay.runs.get(key);
    if (existing) return chainBindingOf(existing);
    if (!initialPromptSha256 || !isSha256(initialPromptSha256)) {
      throw new Error(`No steering chain exists for ${callId}/${generation}.`);
    }
    return {
      schemaVersion: STEERING_SCHEMA_VERSION,
      callId,
      generation,
      steeringChainSha256: computeSteeringChainSha256(initialPromptSha256, []),
      chainIndeterminate: false,
      lastSequence: 0,
      lastTerminalSequence: 0,
      lastAcknowledgedSequence: 0,
    };
  }

  previewOutcomeBinding(
    callId: string,
    generation: string,
    textSha256: string,
    outcome: SteeringTargetOutcomeEvent["outcome"],
    initialPromptSha256?: string,
  ): Pick<SteeringChainBinding, "steeringChainSha256" | "chainIndeterminate"> {
    if (!isSha256(textSha256)) throw new Error("Steering outcome preview requires a message SHA-256.");
    const key = steeringTargetKey({ callId, generation });
    const run = this.replay.runs.get(key);
    if (!run) {
      if (!initialPromptSha256 || !isSha256(initialPromptSha256)) {
        throw new Error(`No steering chain exists for ${callId}/${generation}.`);
      }
      return {
        steeringChainSha256: computeSteeringChainSha256(
          initialPromptSha256,
          outcome === "acknowledged" ? [textSha256] : [],
        ),
        chainIndeterminate: outcome === "deliveryUnknown" || outcome === "sentUnconfirmed",
      };
    }
    return {
      steeringChainSha256: computeSteeringChainSha256(
        run.initialPromptSha256,
        outcome === "acknowledged"
          ? [...run.acknowledgedHashes, textSha256]
          : run.acknowledgedHashes,
      ),
      chainIndeterminate: run.chainIndeterminate
        || outcome === "deliveryUnknown"
        || outcome === "sentUnconfirmed",
    };
  }

  /** Used by the persistence wrapper after its durable writes succeed. */
  replaceWith(next: InMemorySteeringStore): void {
    this.currentEvents = [...next.currentEvents];
    this.currentPending = clonePending(next.currentPending);
    this.replay = replaySteeringEventsInternal(this.currentEvents);
  }

  private commit(events: SteeringEvent[], pending: SteeringPendingSnapshot): void {
    const nextReplay = replaySteeringEventsInternal(events);
    if (nextReplay.publicReplay.issues.length > 0) {
      throw new SteeringValidationError(nextReplay.publicReplay.issues);
    }
    const recovered = recoverSteeringPendingSnapshot(events, pending);
    if (recovered.issues.length > 0) throw new SteeringValidationError(recovered.issues);
    this.currentEvents = events;
    this.currentPending = recovered.snapshot;
    this.replay = nextReplay;
  }
}

export class PersistedSteeringStore implements SteeringStore {
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly persistence: SteeringPersistence,
    private readonly memory: InMemorySteeringStore,
  ) {}

  static async open(persistence: SteeringPersistence): Promise<PersistedSteeringStore> {
    const [events, pending] = await Promise.all([
      persistence.loadEvents(),
      persistence.loadPending(),
    ]);
    const recovered = recoverSteeringPendingSnapshot(events, pending);
    if (recovered.issues.length > 0) throw new SteeringValidationError(recovered.issues);
    const memory = new InMemorySteeringStore(events, recovered.snapshot);
    if (recovered.changed) await persistence.writePending(recovered.snapshot);
    return new PersistedSteeringStore(persistence, memory);
  }

  recordRequest(event: SteeringRequestedEvent, text: string): Promise<void> {
    return this.serialize(async () => {
      const next = new InMemorySteeringStore(this.memory.events(), this.memory.pending());
      await next.recordRequest(event, text);
      // Write-ahead body: a crash cannot leave an unresolved ledger row whose
      // content is silently missing. An orphan body fails closed on recovery.
      await this.persistence.writePending(next.pending());
      try {
        await this.persistence.appendEvents([event]);
      } catch (error) {
        await this.persistence.writePending(this.memory.pending()).catch(() => undefined);
        throw error;
      }
      this.memory.replaceWith(next);
    });
  }

  recordEvent(event: SteeringDeliveryStartedEvent | SteeringTargetOutcomeEvent): Promise<void> {
    return this.serialize(async () => {
      const next = new InMemorySteeringStore(this.memory.events(), this.memory.pending());
      await next.recordEvent(event);
      await this.persistence.appendEvents([event]);
      this.memory.replaceWith(next);
      if (event.type === "steeringTargetOutcome") {
        // A crash here can retain a resolved body, never lose an unresolved
        // one. Recovery compacts terminal target references deterministically.
        await this.persistence.writePending(next.pending());
      }
    });
  }

  events(): readonly SteeringEvent[] {
    return this.memory.events();
  }

  pending(): SteeringPendingSnapshot {
    return this.memory.pending();
  }

  pendingUsage(): SteeringPendingUsage {
    return this.memory.pendingUsage();
  }

  chainBinding(callId: string, generation: string, initialPromptSha256?: string): SteeringChainBinding {
    return this.memory.chainBinding(callId, generation, initialPromptSha256);
  }

  previewOutcomeBinding(
    callId: string,
    generation: string,
    textSha256: string,
    outcome: SteeringTargetOutcomeEvent["outcome"],
    initialPromptSha256?: string,
  ): Pick<SteeringChainBinding, "steeringChainSha256" | "chainIndeterminate"> {
    return this.memory.previewOutcomeBinding(
      callId,
      generation,
      textSha256,
      outcome,
      initialPromptSha256,
    );
  }

  async withFreshOrphanRecovery<T>(work: () => Promise<T>): Promise<T> {
    const reloadAndRun = async (): Promise<T> => {
      const [events, pending] = await Promise.all([
        this.persistence.loadEvents(),
        this.persistence.loadPending(),
      ]);
      const recovered = recoverSteeringPendingSnapshot(events, pending);
      if (recovered.issues.length > 0) throw new SteeringValidationError(recovered.issues);
      const refreshed = new InMemorySteeringStore(events, recovered.snapshot);
      if (recovered.changed) await this.persistence.writePending(recovered.snapshot);
      this.memory.replaceWith(refreshed);
      return work();
    };
    return this.persistence.withOrphanRecoveryLock
      ? this.persistence.withOrphanRecoveryLock(reloadAndRun)
      : reloadAndRun();
  }

  private serialize(work: () => Promise<void>): Promise<void> {
    const next = this.mutationTail.then(work);
    this.mutationTail = next.then(() => undefined, () => undefined);
    return next;
  }
}

function replaySteeringEventsInternal(events: readonly unknown[]): InternalReplay {
  const issues: SteeringValidationIssue[] = [];
  const requests = new Map<string, MutableRequestReplay>();
  const runs = new Map<string, MutableRunReplay>();
  const eventIds = new Set<string>();
  const unresolvedMessages = new Set<string>();
  const unresolvedPerRun = new Map<string, number>();

  if (events.length > MAX_STEERING_EVENTS) {
    issues.push(issue(-1, "boundsExceeded", `Steering ledger exceeds ${MAX_STEERING_EVENTS} events.`));
  }

  events.slice(0, MAX_STEERING_EVENTS + 1).forEach((raw, index) => {
    const rawRecord = asRecord(raw);
    if (rawRecord && rawRecord.schemaVersion !== undefined && rawRecord.schemaVersion !== STEERING_SCHEMA_VERSION) {
      issues.push(issue(index, "unknownVersion", `Unknown steering schema version ${String(rawRecord.schemaVersion)}.`));
      return;
    }
    if (!isSteeringEvent(raw)) {
      issues.push(issue(index, "invalidEvent", "Malformed steering event."));
      return;
    }
    if (eventIds.has(raw.eventId)) {
      issues.push(issue(index, "duplicateEvent", `Duplicate event ID ${raw.eventId}.`, raw.eventId));
      return;
    }
    eventIds.add(raw.eventId);

    if (raw.type === "steeringRequested") {
      replayRequest(raw, index, requests, runs, unresolvedMessages, unresolvedPerRun, issues);
    } else if (raw.type === "steeringDeliveryStarted") {
      replayDeliveryStarted(raw, index, requests, runs, issues);
    } else {
      replayOutcome(raw, index, requests, runs, unresolvedMessages, unresolvedPerRun, issues);
    }
  });

  const publicRequests = new Map<string, SteeringRequestReplay>();
  const unresolvedTargets = new Set<string>();
  for (const [steeringId, request] of requests) {
    publicRequests.set(steeringId, {
      event: request.event,
      startedTargetKeys: new Set(request.startedTargetKeys),
      outcomes: new Map(request.outcomes),
    });
    for (const target of request.event.targets) {
      const key = steeringRequestTargetKey(target);
      if (!request.outcomes.has(key)) unresolvedTargets.add(`${steeringId}\u0000${key}`);
    }
  }
  const chainBindings = new Map<string, SteeringChainBinding>();
  for (const [key, run] of runs) chainBindings.set(key, chainBindingOf(run));
  const publicReplay: SteeringReplay = {
    issues,
    eventCount: events.length,
    requests: publicRequests,
    chainBindings,
    unresolvedTargets,
  };
  return { publicReplay, requests, runs };
}

function replayRequest(
  event: SteeringRequestedEvent,
  index: number,
  requests: Map<string, MutableRequestReplay>,
  runs: Map<string, MutableRunReplay>,
  unresolvedMessages: Set<string>,
  unresolvedPerRun: Map<string, number>,
  issues: SteeringValidationIssue[],
): void {
  if (requests.has(event.steeringId)) {
    issues.push(issue(index, "duplicateSteering", `Duplicate steering ID ${event.steeringId}.`, event.eventId));
    return;
  }
  const targetKeys = new Set<string>();
  let requestValid = true;
  for (const target of event.targets) {
    if (target.roomTurnId !== event.roomTurnId) {
      issues.push(issue(index, "invalidReference", `Target ${target.callId} is bound to a different room turn.`, event.eventId));
      requestValid = false;
    }
    const runKey = steeringTargetKey(target);
    if (targetKeys.has(runKey)) {
      issues.push(issue(index, "duplicateTarget", `Request repeats run ${target.callId}/${target.generation}.`, event.eventId));
      requestValid = false;
      continue;
    }
    targetKeys.add(runKey);
    const run = runs.get(runKey);
    if (run) {
      if (run.initialPromptSha256 !== target.initialPromptSha256) {
        issues.push(issue(index, "hashMismatch", `Initial prompt binding changed for ${target.callId}/${target.generation}.`, event.eventId));
        requestValid = false;
      }
      if (target.sequence !== run.lastSequence + 1) {
        issues.push(issue(index, "invalidSequence", `Steering sequence for ${target.callId}/${target.generation} must be ${run.lastSequence + 1}.`, event.eventId));
        requestValid = false;
      }
    } else if (target.sequence !== 1) {
      issues.push(issue(index, "invalidSequence", `First steering sequence for ${target.callId}/${target.generation} must be 1.`, event.eventId));
      requestValid = false;
    }
  }
  if (!requestValid) return;

  if (unresolvedMessages.size + 1 > STEERING_LIMITS.maxUnresolvedMessagesPerRoom) {
    issues.push(issue(index, "boundsExceeded", "Unresolved steering requests exceed the room bound.", event.eventId));
    return;
  }
  for (const target of event.targets) {
    const runKey = steeringTargetKey(target);
    if ((unresolvedPerRun.get(runKey) ?? 0) + 1 > STEERING_LIMITS.maxUnresolvedMessagesPerRun) {
      issues.push(issue(index, "boundsExceeded", `Unresolved steering requests exceed the bound for ${target.callId}/${target.generation}.`, event.eventId));
      return;
    }
  }

  requests.set(event.steeringId, {
    event,
    startedTargetKeys: new Set(),
    outcomes: new Map(),
  });
  unresolvedMessages.add(event.steeringId);
  for (const target of event.targets) {
    const runKey = steeringTargetKey(target);
    const run = runs.get(runKey) ?? {
      callId: target.callId,
      generation: target.generation,
      initialPromptSha256: target.initialPromptSha256,
      lastSequence: 0,
      lastStartedSequence: 0,
      lastTerminalSequence: 0,
      lastAcknowledgedSequence: 0,
      acknowledgedHashes: [],
      steeringChainSha256: computeSteeringChainSha256(target.initialPromptSha256, []),
      chainIndeterminate: false,
    };
    run.lastSequence = target.sequence;
    runs.set(runKey, run);
    unresolvedPerRun.set(runKey, (unresolvedPerRun.get(runKey) ?? 0) + 1);
  }
}

function replayDeliveryStarted(
  event: SteeringDeliveryStartedEvent,
  index: number,
  requests: Map<string, MutableRequestReplay>,
  runs: Map<string, MutableRunReplay>,
  issues: SteeringValidationIssue[],
): void {
  const resolved = referencedTarget(event, index, requests, issues);
  if (!resolved) return;
  const { request, target, targetKey } = resolved;
  if (request.startedTargetKeys.has(targetKey)) {
    issues.push(issue(index, "invalidTransition", "Delivery already started for this target.", event.eventId));
    return;
  }
  if (request.outcomes.has(targetKey)) {
    issues.push(issue(index, "invalidTransition", "Delivery cannot start after a terminal outcome.", event.eventId));
    return;
  }
  const run = runs.get(steeringTargetKey(target));
  if (!run) {
    issues.push(issue(index, "invalidReference", "Delivery references an unknown run.", event.eventId));
    return;
  }
  if (event.sequence !== run.lastStartedSequence + 1) {
    issues.push(issue(index, "invalidSequence", `Delivery start sequence must be ${run.lastStartedSequence + 1}.`, event.eventId));
    return;
  }
  if (event.priorSteeringChainSha256 !== run.steeringChainSha256
    || event.priorChainIndeterminate !== run.chainIndeterminate) {
    issues.push(issue(index, "hashMismatch", "Delivery start does not bind the current steering chain.", event.eventId));
    return;
  }
  request.startedTargetKeys.add(targetKey);
  run.lastStartedSequence = event.sequence;
}

function replayOutcome(
  event: SteeringTargetOutcomeEvent,
  index: number,
  requests: Map<string, MutableRequestReplay>,
  runs: Map<string, MutableRunReplay>,
  unresolvedMessages: Set<string>,
  unresolvedPerRun: Map<string, number>,
  issues: SteeringValidationIssue[],
): void {
  const resolved = referencedTarget(event, index, requests, issues);
  if (!resolved) return;
  const { request, target, targetKey } = resolved;
  if (!request.startedTargetKeys.has(targetKey)) {
    issues.push(issue(index, "invalidTransition", "Terminal outcome precedes delivery start.", event.eventId));
    return;
  }
  if (request.outcomes.has(targetKey)) {
    issues.push(issue(index, "invalidTransition", "Target already has a terminal outcome.", event.eventId));
    return;
  }
  const runKey = steeringTargetKey(target);
  const run = runs.get(runKey);
  if (!run) {
    issues.push(issue(index, "invalidReference", "Outcome references an unknown run.", event.eventId));
    return;
  }
  if (event.sequence !== run.lastTerminalSequence + 1) {
    issues.push(issue(index, "invalidSequence", `Terminal sequence must be ${run.lastTerminalSequence + 1}.`, event.eventId));
    return;
  }

  const expectedHashes = event.outcome === "acknowledged"
    ? [...run.acknowledgedHashes, request.event.textSha256]
    : run.acknowledgedHashes;
  const expectedChain = computeSteeringChainSha256(run.initialPromptSha256, expectedHashes);
  const expectedIndeterminate = run.chainIndeterminate
    || event.outcome === "deliveryUnknown"
    || event.outcome === "sentUnconfirmed";
  if (event.steeringChainSha256 !== expectedChain || event.chainIndeterminate !== expectedIndeterminate) {
    issues.push(issue(index, "hashMismatch", "Target outcome does not bind the replay-derived steering chain.", event.eventId));
    return;
  }
  if (!validOutcomeSemantics(event, target)) {
    issues.push(issue(index, "invalidOutcome", "Target outcome fields form an impossible delivery state.", event.eventId));
    return;
  }

  request.outcomes.set(targetKey, event);
  run.lastTerminalSequence = event.sequence;
  run.steeringChainSha256 = expectedChain;
  run.chainIndeterminate = expectedIndeterminate;
  if (event.outcome === "acknowledged") {
    run.acknowledgedHashes.push(request.event.textSha256);
    run.lastAcknowledgedSequence = event.sequence;
  }
  unresolvedPerRun.set(runKey, Math.max(0, (unresolvedPerRun.get(runKey) ?? 1) - 1));
  if (request.event.targets.every((candidate) =>
    request.outcomes.has(steeringRequestTargetKey(candidate))
  )) {
    unresolvedMessages.delete(event.steeringId);
  }
}

function referencedTarget(
  event: SteeringDeliveryStartedEvent | SteeringTargetOutcomeEvent,
  index: number,
  requests: Map<string, MutableRequestReplay>,
  issues: SteeringValidationIssue[],
): { request: MutableRequestReplay; target: SteeringTargetBinding; targetKey: string } | undefined {
  const request = requests.get(event.steeringId);
  if (!request) {
    issues.push(issue(index, "invalidReference", `Unknown steering ID ${event.steeringId}.`, event.eventId));
    return undefined;
  }
  const target = request.event.targets.find((candidate) =>
    candidate.callId === event.callId
    && candidate.generation === event.generation
    && candidate.sequence === event.sequence
  );
  if (!target) {
    issues.push(issue(index, "invalidReference", "Event does not match an exact requested target binding.", event.eventId));
    return undefined;
  }
  return { request, target, targetKey: steeringRequestTargetKey(target) };
}

function validOutcomeSemantics(
  event: SteeringTargetOutcomeEvent,
  target: SteeringTargetBinding,
): boolean {
  if (event.outcome === "acknowledged") {
    return event.code === "acknowledged"
      && event.acknowledgedDelivery === target.expectedDelivery
      && event.disposition === dispositionForDelivery(event.acknowledgedDelivery)
      && isSha256(event.providerReceiptSha256);
  }
  if (event.acknowledgedDelivery !== undefined || event.providerReceiptSha256 !== undefined) return false;
  if (event.outcome === "deliveryUnknown" || event.outcome === "sentUnconfirmed") {
    return event.disposition === "deliveryUnknown"
      && (event.code === "acknowledgementTimeout"
        || event.code === "malformedAcknowledgement"
        || event.code === "processExit"
        || event.code === "providerFailure");
  }
  if (event.disposition !== "rejected" || event.code === "acknowledged") return false;
  switch (event.outcome) {
    case "missedWindow":
      return event.code === "staleHandle" || event.code === "endedBeforeAcceptance";
    case "unsupported":
      return event.code === "unsupported";
    case "rejected":
      return event.code === "sealedWork"
        || event.code === "lockedArena"
        || event.code === "nonInteractiveWork"
        || event.code === "missionHashMismatch"
        || event.code === "authorityHashMismatch"
        || event.code === "remoteOwner"
        || event.code === "providerRejected"
        || event.code === "queueFull";
    case "failed":
      return event.code === "providerFailure" || event.code === "processExit";
    default:
      return false;
  }
}

function isPendingSnapshotShape(value: unknown): value is SteeringPendingSnapshot {
  const record = asRecord(value);
  if (!record
    || record.schemaVersion !== STEERING_SCHEMA_VERSION
    || !Array.isArray(record.messages)
    || record.messages.length > STEERING_LIMITS.maxUnresolvedMessagesPerRoom
    || !hasExactKeys(record, ["schemaVersion", "messages"])) {
    return false;
  }
  return record.messages.every((entry) => {
    const pending = asRecord(entry);
    return !!pending
      && hasExactKeys(pending, [
        "steeringId",
        "text",
        "textSha256",
        "textCharacters",
        "textBytes",
        "unresolvedTargets",
      ])
      && isBoundedIdentifier(pending.steeringId)
      && typeof pending.text === "string"
      && Buffer.byteLength(pending.text, "utf8") <= STEERING_LIMITS.maxMessageBytes
      && isSha256(pending.textSha256)
      && Number.isSafeInteger(pending.textCharacters)
      && (pending.textCharacters as number) > 0
      && Number.isSafeInteger(pending.textBytes)
      && (pending.textBytes as number) > 0
      && Array.isArray(pending.unresolvedTargets)
      && pending.unresolvedTargets.length > 0
      && pending.unresolvedTargets.length <= STEERING_LIMITS.maxTargetsPerRequest
      && pending.unresolvedTargets.every((target) => {
        const binding = asRecord(target);
        return !!binding
          && hasExactKeys(binding, ["callId", "generation", "sequence"])
          && isBoundedIdentifier(binding.callId)
          && isBoundedIdentifier(binding.generation)
          && Number.isSafeInteger(binding.sequence)
          && (binding.sequence as number) > 0;
      });
  });
}

function pendingUsageOf(snapshot: SteeringPendingSnapshot): SteeringPendingUsage {
  const perRun = new Map<string, number>();
  let bytes = 0;
  for (const message of snapshot.messages) {
    bytes += message.textBytes;
    for (const target of message.unresolvedTargets) {
      const key = steeringTargetKey(target);
      perRun.set(key, (perRun.get(key) ?? 0) + 1);
    }
  }
  return { messages: snapshot.messages.length, bytes, perRun };
}

function chainBindingOf(run: MutableRunReplay): SteeringChainBinding {
  return {
    schemaVersion: STEERING_SCHEMA_VERSION,
    callId: run.callId,
    generation: run.generation,
    steeringChainSha256: run.steeringChainSha256,
    chainIndeterminate: run.chainIndeterminate,
    lastSequence: run.lastSequence,
    lastTerminalSequence: run.lastTerminalSequence,
    lastAcknowledgedSequence: run.lastAcknowledgedSequence,
  };
}

function clonePending(snapshot: SteeringPendingSnapshot): SteeringPendingSnapshot {
  return {
    schemaVersion: STEERING_SCHEMA_VERSION,
    messages: snapshot.messages.map((message) => ({
      ...message,
      unresolvedTargets: message.unresolvedTargets.map((target) => ({ ...target })),
    })),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  const allowed = new Set(keys);
  return actual.length === keys.length && actual.every((key) => allowed.has(key));
}

function issue(
  index: number,
  code: SteeringValidationCode,
  message: string,
  eventId?: string,
): SteeringValidationIssue {
  return { index, code, message, ...(eventId ? { eventId } : {}) };
}
