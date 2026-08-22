import * as path from "node:path";
import {
  appendFileSafely,
  atomicWriteFile,
  ensureFile,
  readFileHead,
  serializePerFileAcrossProcesses,
} from "./fileQueue";
import {
  STEERING_LIMITS,
  STEERING_SCHEMA_VERSION,
  isBoundedIdentifier,
  isSha256,
  sha256Utf8,
  steeringRequestTargetKey,
  type SteeringDeliveryStartedEvent,
  type SteeringEvent,
  type SteeringRequestedEvent,
  type SteeringTargetOutcomeEvent,
} from "./steeringProtocol";
import {
  emptySteeringPendingSnapshot,
  type SteeringStore,
  type SteeringPendingSnapshot,
  type SteeringPersistence,
} from "./steeringStore";
import { randomUUID } from "node:crypto";

const MAX_STEERING_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_STEERING_PENDING_BYTES = 512 * 1024;
const MAX_STEERING_LINE_CHARS = 1_000_000;
const MAX_STEERING_OWNER_LEASE_BYTES = 16 * 1024;
const STEERING_OWNER_HEARTBEAT_MS = 5_000;
const STEERING_OWNER_FRESH_MS = 20_000;
const activeLocalSteeringOwners = new Set<string>();

export interface SteeringPersistencePaths {
  readonly eventsPath: string;
  readonly pendingPath: string;
  readonly orphanRecoveryPath: string;
}

export interface SteeringOwnerLease {
  isOwnerActive(ownerId: string): Promise<boolean>;
  dispose(): void;
}

export function steeringPersistencePaths(privateWorkspaceRoot: string): SteeringPersistencePaths {
  const root = path.join(privateWorkspaceRoot, "steering");
  return {
    eventsPath: path.join(root, "events.v1.jsonl"),
    pendingPath: path.join(root, "pending.v1.json"),
    // This is a lock identity, not an artifact file. fileQueue adds its own
    // adjacent lock/intent records and removes them after every election.
    orphanRecoveryPath: path.join(root, "orphan-recovery.v1"),
  };
}

/**
 * Private authoritative steering persistence. The append-only event stream
 * carries only metadata/hashes; unresolved message bodies live in a separate
 * bounded atomic snapshot and disappear after every target reaches a terminal
 * outcome.
 */
export async function openFileSteeringPersistence(
  privateWorkspaceRoot: string,
): Promise<{ persistence: SteeringPersistence; paths: SteeringPersistencePaths }> {
  const paths = steeringPersistencePaths(privateWorkspaceRoot);
  await ensureFile(paths.eventsPath);
  await ensureFile(
    paths.pendingPath,
    `${JSON.stringify(emptySteeringPendingSnapshot())}\n`,
  );

  let baselinePending: SteeringPendingSnapshot | undefined;
  const persistence: SteeringPersistence = {
    async loadEvents(): Promise<readonly unknown[]> {
      const file = await readFileHead(paths.eventsPath, MAX_STEERING_LEDGER_BYTES);
      if (file.totalBytes > MAX_STEERING_LEDGER_BYTES || file.truncated) {
        throw new Error("The private steering ledger exceeds its replay bound.");
      }
      return parseCompleteEventLedger(file.text);
    },
    async loadPending(): Promise<unknown> {
      const file = await readFileHead(paths.pendingPath, MAX_STEERING_PENDING_BYTES);
      if (file.totalBytes > MAX_STEERING_PENDING_BYTES || file.truncated) {
        throw new Error("The private pending steering body snapshot exceeds its bound.");
      }
      try {
        const parsed = JSON.parse(file.text) as unknown;
        if (isMergeablePendingSnapshot(parsed)) {
          baselinePending = clonePendingSnapshot(parsed);
        }
        return parsed;
      } catch {
        // Return an invalid shape so the store's strict recovery path produces
        // its normal fail-closed validation error.
        return { schemaVersion: -1, messages: [] };
      }
    },
    async appendEvents(events: readonly SteeringEvent[]): Promise<void> {
      if (events.length === 0) return;
      const lines = events.map((event) => `${JSON.stringify(event)}\n`).join("");
      await serializePerFileAcrossProcesses(paths.eventsPath, async () => {
        const current = await readFileHead(paths.eventsPath, MAX_STEERING_LEDGER_BYTES);
        if (current.totalBytes + Buffer.byteLength(lines, "utf8") > MAX_STEERING_LEDGER_BYTES) {
          throw new Error("The private steering ledger reached its bounded capacity.");
        }
        await appendFileSafely(paths.eventsPath, lines);
      });
    },
    async writePending(snapshot: SteeringPendingSnapshot): Promise<void> {
      if (snapshot.schemaVersion !== STEERING_SCHEMA_VERSION) {
        throw new Error("Refusing to persist an unknown pending steering snapshot version.");
      }
      const previous = baselinePending;
      if (!previous) {
        throw new Error("Refusing to update pending steering bodies before strict baseline replay.");
      }
      await serializePerFileAcrossProcesses(paths.pendingPath, async () => {
        const currentFile = await readFileHead(paths.pendingPath, MAX_STEERING_PENDING_BYTES);
        if (currentFile.totalBytes > MAX_STEERING_PENDING_BYTES || currentFile.truncated) {
          throw new Error("The private pending steering body snapshot exceeds its bound.");
        }
        let current: unknown;
        try {
          current = JSON.parse(currentFile.text);
        } catch {
          throw new Error("The private pending steering body snapshot is malformed.");
        }
        if (!isMergeablePendingSnapshot(current)) {
          throw new Error("The private pending steering body snapshot has an unknown shape.");
        }
        const merged = mergePendingSnapshots(current, previous, snapshot);
        const content = `${JSON.stringify(merged)}\n`;
        if (Buffer.byteLength(content, "utf8") > MAX_STEERING_PENDING_BYTES) {
          throw new Error("The pending steering body snapshot reached its bounded capacity.");
        }
        await atomicWriteFile(paths.pendingPath, content);
      });
      baselinePending = clonePendingSnapshot(snapshot);
    },
    async withOrphanRecoveryLock<T>(work: () => Promise<T>): Promise<T> {
      return serializePerFileAcrossProcesses(paths.orphanRecoveryPath, work);
    },
  };
  return { persistence, paths };
}

/**
 * A private heartbeat prevents one VS Code window from recovering another
 * window's active, exact-owner steering request as a crash orphan. The PID
 * fence handles abrupt host exits immediately; freshness and the local owner
 * set handle PID reuse and panel reopen inside one extension-host process.
 */
export async function startSteeringOwnerLease(
  privateWorkspaceRoot: string,
  ownerId: string,
): Promise<SteeringOwnerLease> {
  if (!isBoundedIdentifier(ownerId)) throw new Error("Steering owner ID is invalid.");
  const ownerDirectory = path.join(privateWorkspaceRoot, "steering", "owners");
  const leasePath = path.join(ownerDirectory, `${sha256Utf8(ownerId)}.v1.json`);
  let disposed = false;
  activeLocalSteeringOwners.add(ownerId);

  const writeLease = async (active: boolean): Promise<void> => {
    const record = {
      schemaVersion: STEERING_SCHEMA_VERSION,
      ownerId,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      active,
    };
    await serializePerFileAcrossProcesses(leasePath, () =>
      atomicWriteFile(leasePath, `${JSON.stringify(record)}\n`)
    );
  };
  await writeLease(true);
  const heartbeat = setInterval(() => {
    if (!disposed) void writeLease(true).catch(() => undefined);
  }, STEERING_OWNER_HEARTBEAT_MS);
  heartbeat.unref();

  return {
    async isOwnerActive(candidateOwnerId: string): Promise<boolean> {
      if (!isBoundedIdentifier(candidateOwnerId)) return false;
      if (activeLocalSteeringOwners.has(candidateOwnerId)) return true;
      const candidatePath = path.join(
        ownerDirectory,
        `${sha256Utf8(candidateOwnerId)}.v1.json`,
      );
      let file;
      try {
        file = await readFileHead(candidatePath, MAX_STEERING_OWNER_LEASE_BYTES);
      } catch {
        return false;
      }
      if (file.truncated || file.totalBytes > MAX_STEERING_OWNER_LEASE_BYTES) return false;
      let value: unknown;
      try {
        value = JSON.parse(file.text);
      } catch {
        return false;
      }
      const lease = asRecord(value);
      if (!lease
        || lease.schemaVersion !== STEERING_SCHEMA_VERSION
        || lease.ownerId !== candidateOwnerId
        || lease.active !== true
        || !Number.isSafeInteger(lease.pid)
        || (lease.pid as number) < 1
        || typeof lease.updatedAt !== "string") {
        return false;
      }
      if (lease.pid === process.pid) {
        return activeLocalSteeringOwners.has(candidateOwnerId);
      }
      const updatedAtMs = Date.parse(lease.updatedAt);
      if (!Number.isFinite(updatedAtMs)
        || Date.now() - updatedAtMs > STEERING_OWNER_FRESH_MS
        || updatedAtMs - Date.now() > 5_000) {
        return false;
      }
      return processIsAlive(lease.pid as number);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearInterval(heartbeat);
      activeLocalSteeringOwners.delete(ownerId);
      void writeLease(false).catch(() => undefined);
    },
  };
}

/**
 * Close requests orphaned by an extension-host crash. A target whose delivery
 * started is permanently marked delivery-unknown; one that never reached the
 * provider is marked missed-window. Neither class is replayed automatically.
 */
export async function resolveOrphanedSteeringOnStartup(
  store: SteeringStore,
  isOwnerActive?: (ownerId: string) => Promise<boolean>,
): Promise<number> {
  if (store.withFreshOrphanRecovery) {
    return store.withFreshOrphanRecovery(
      () => resolveOrphanedSteeringFromCurrentReplay(store, isOwnerActive),
    );
  }
  return resolveOrphanedSteeringFromCurrentReplay(store, isOwnerActive);
}

async function resolveOrphanedSteeringFromCurrentReplay(
  store: SteeringStore,
  isOwnerActive?: (ownerId: string) => Promise<boolean>,
): Promise<number> {
  const events = store.events();
  const requests = new Map<string, SteeringRequestedEvent>();
  const started = new Set<string>();
  const terminal = new Set<string>();
  for (const event of events) {
    if (event.type === "steeringRequested") {
      requests.set(event.steeringId, event);
    } else if (event.type === "steeringDeliveryStarted") {
      started.add(`${event.steeringId}\u0000${steeringRequestTargetKey(event)}`);
    } else {
      terminal.add(`${event.steeringId}\u0000${steeringRequestTargetKey(event)}`);
    }
  }

  let resolved = 0;
  for (const pending of store.pending().messages) {
    const request = requests.get(pending.steeringId);
    if (!request) throw new Error(`Pending steering request ${pending.steeringId} has no ledger event.`);
    for (const targetRef of pending.unresolvedTargets) {
      const target = request.targets.find((candidate) =>
        candidate.callId === targetRef.callId
        && candidate.generation === targetRef.generation
        && candidate.sequence === targetRef.sequence
      );
      if (!target) throw new Error(`Pending steering target ${targetRef.callId}/${targetRef.generation} is unbound.`);
      if (isOwnerActive && await isOwnerActive(target.ownerId)) continue;
      const compoundKey = `${request.steeringId}\u0000${steeringRequestTargetKey(target)}`;
      if (terminal.has(compoundKey)) continue;

      const wasSubmitted = started.has(compoundKey);
      if (!wasSubmitted) {
        const prior = store.chainBinding(
          target.callId,
          target.generation,
          target.initialPromptSha256,
        );
        const deliveryStarted: SteeringDeliveryStartedEvent = {
          schemaVersion: STEERING_SCHEMA_VERSION,
          type: "steeringDeliveryStarted",
          eventId: `event-${randomUUID()}`,
          occurredAt: new Date().toISOString(),
          steeringId: request.steeringId,
          callId: target.callId,
          generation: target.generation,
          sequence: target.sequence,
          priorSteeringChainSha256: prior.steeringChainSha256,
          priorChainIndeterminate: prior.chainIndeterminate,
        };
        await store.recordEvent(deliveryStarted);
        started.add(compoundKey);
      }

      const outcome = wasSubmitted ? "deliveryUnknown" : "missedWindow";
      const chain = store.previewOutcomeBinding(
        target.callId,
        target.generation,
        request.textSha256,
        outcome,
        target.initialPromptSha256,
      );
      const terminalEvent: SteeringTargetOutcomeEvent = {
        schemaVersion: STEERING_SCHEMA_VERSION,
        type: "steeringTargetOutcome",
        eventId: `event-${randomUUID()}`,
        occurredAt: new Date().toISOString(),
        steeringId: request.steeringId,
        callId: target.callId,
        generation: target.generation,
        sequence: target.sequence,
        outcome,
        disposition: wasSubmitted ? "deliveryUnknown" : "rejected",
        code: wasSubmitted ? "processExit" : "endedBeforeAcceptance",
        steeringChainSha256: chain.steeringChainSha256,
        chainIndeterminate: chain.chainIndeterminate,
      };
      await store.recordEvent(terminalEvent);
      terminal.add(compoundKey);
      resolved += 1;
    }
  }
  return resolved;
}

function mergePendingSnapshots(
  current: SteeringPendingSnapshot,
  previous: SteeringPendingSnapshot,
  next: SteeringPendingSnapshot,
): SteeringPendingSnapshot {
  const merged = new Map(current.messages.map((message) => [
    message.steeringId,
    clonePendingMessage(message),
  ]));
  const previousById = new Map(previous.messages.map((message) => [message.steeringId, message]));
  const nextById = new Map(next.messages.map((message) => [message.steeringId, message]));
  const changedIds = new Set([...previousById.keys(), ...nextById.keys()]);

  for (const steeringId of changedIds) {
    const before = previousById.get(steeringId);
    const after = nextById.get(steeringId);
    if (before && after && pendingMessagesEqual(before, after)) continue;
    if (!before && after) {
      const existing = merged.get(steeringId);
      if (existing && !pendingMessagesEqual(existing, after)) {
        throw new Error(`Pending steering ID ${steeringId} collided across extension hosts.`);
      }
      merged.set(steeringId, clonePendingMessage(after));
      continue;
    }
    if (before && !after) {
      merged.delete(steeringId);
      continue;
    }
    if (!before || !after || !samePendingBody(before, after)) {
      throw new Error(`Pending steering body ${steeringId} changed its immutable bindings.`);
    }
    const currentMessage = merged.get(steeringId);
    if (!currentMessage || !samePendingBody(currentMessage, before)) {
      throw new Error(`Pending steering body ${steeringId} changed across extension hosts.`);
    }
    const beforeTargets = new Map(before.unresolvedTargets.map((target) => [
      steeringRequestTargetKey(target),
      target,
    ]));
    const afterTargets = new Map(after.unresolvedTargets.map((target) => [
      steeringRequestTargetKey(target),
      target,
    ]));
    const currentTargets = new Map(currentMessage.unresolvedTargets.map((target) => [
      steeringRequestTargetKey(target),
      target,
    ]));
    for (const key of beforeTargets.keys()) {
      if (!afterTargets.has(key)) currentTargets.delete(key);
    }
    for (const [key, target] of afterTargets) {
      if (!beforeTargets.has(key)) currentTargets.set(key, target);
    }
    if (currentTargets.size === 0) {
      merged.delete(steeringId);
    } else {
      merged.set(steeringId, {
        ...currentMessage,
        unresolvedTargets: [...currentTargets.values()].map((target) => ({ ...target })),
      });
    }
  }

  const snapshot: SteeringPendingSnapshot = {
    schemaVersion: STEERING_SCHEMA_VERSION,
    messages: [...merged.values()].sort((left, right) =>
      left.steeringId.localeCompare(right.steeringId)
    ),
  };
  if (!isMergeablePendingSnapshot(snapshot)) {
    throw new Error("Merged pending steering bodies exceed their schema bounds.");
  }
  return snapshot;
}

function isMergeablePendingSnapshot(value: unknown): value is SteeringPendingSnapshot {
  const snapshot = asRecord(value);
  if (!snapshot
    || snapshot.schemaVersion !== STEERING_SCHEMA_VERSION
    || !Array.isArray(snapshot.messages)
    || snapshot.messages.length > STEERING_LIMITS.maxUnresolvedMessagesPerRoom) {
    return false;
  }
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const candidate of snapshot.messages) {
    const message = asRecord(candidate);
    if (!message
      || !isBoundedIdentifier(message.steeringId)
      || ids.has(message.steeringId as string)
      || typeof message.text !== "string"
      || !isSha256(message.textSha256)
      || !Number.isSafeInteger(message.textCharacters)
      || (message.textCharacters as number) < 1
      || !Number.isSafeInteger(message.textBytes)
      || (message.textBytes as number) < 1
      || Buffer.byteLength(message.text, "utf8") !== message.textBytes
      || !Array.isArray(message.unresolvedTargets)
      || message.unresolvedTargets.length < 1
      || message.unresolvedTargets.length > STEERING_LIMITS.maxTargetsPerRequest) {
      return false;
    }
    ids.add(message.steeringId as string);
    totalBytes += message.textBytes as number;
    const targets = new Set<string>();
    for (const candidateTarget of message.unresolvedTargets) {
      const target = asRecord(candidateTarget);
      if (!target
        || !isBoundedIdentifier(target.callId)
        || !isBoundedIdentifier(target.generation)
        || !Number.isSafeInteger(target.sequence)
        || (target.sequence as number) < 1) {
        return false;
      }
      const key = steeringRequestTargetKey(target as {
        callId: string;
        generation: string;
        sequence: number;
      });
      if (targets.has(key)) return false;
      targets.add(key);
    }
  }
  return totalBytes <= STEERING_LIMITS.maxUnresolvedBytes;
}

function clonePendingSnapshot(snapshot: SteeringPendingSnapshot): SteeringPendingSnapshot {
  return {
    schemaVersion: STEERING_SCHEMA_VERSION,
    messages: snapshot.messages.map(clonePendingMessage),
  };
}

function clonePendingMessage(
  message: SteeringPendingSnapshot["messages"][number],
): SteeringPendingSnapshot["messages"][number] {
  return {
    ...message,
    unresolvedTargets: message.unresolvedTargets.map((target) => ({ ...target })),
  };
}

function samePendingBody(
  left: SteeringPendingSnapshot["messages"][number],
  right: SteeringPendingSnapshot["messages"][number],
): boolean {
  return left.steeringId === right.steeringId
    && left.text === right.text
    && left.textSha256 === right.textSha256
    && left.textCharacters === right.textCharacters
    && left.textBytes === right.textBytes;
}

function pendingMessagesEqual(
  left: SteeringPendingSnapshot["messages"][number],
  right: SteeringPendingSnapshot["messages"][number],
): boolean {
  return samePendingBody(left, right)
    && left.unresolvedTargets.length === right.unresolvedTargets.length
    && left.unresolvedTargets.every((target, index) => {
      const other = right.unresolvedTargets[index];
      return other !== undefined
        && steeringRequestTargetKey(target) === steeringRequestTargetKey(other);
    });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseCompleteEventLedger(text: string): unknown[] {
  const events: unknown[] = [];
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && text.charCodeAt(index) !== 10) continue;
    let line = text.slice(start, index);
    start = index + 1;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    if (line.length > MAX_STEERING_LINE_CHARS) {
      throw new Error("The private steering ledger contains an oversized record.");
    }
    try {
      // Keep malformed-schema objects in the returned stream so full replay,
      // rather than a filtering reader, fails closed on them.
      events.push(JSON.parse(line) as unknown);
    } catch {
      events.push({ malformedSteeringLedgerRecord: true });
    }
  }
  return events;
}
