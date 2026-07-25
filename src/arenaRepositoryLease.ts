import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { serializePerFileAcrossProcesses } from "./fileQueue";

export const ARENA_REPOSITORY_LEASE_SCHEMA_VERSION = 1 as const;
export const ARENA_REPOSITORY_LEASE_GENESIS_SHA256 = "0".repeat(64);

const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
const MAX_LEDGER_EVENTS = 4_096;
const MAX_EVENT_BYTES = 16 * 1024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const activeLocalOwners = new Set<string>();

export interface ArenaRepositoryLeaseBoundary {
  readonly logicalRoot: string;
  readonly realRoot: string;
  readonly identity: {
    readonly dev: string;
    readonly ino: string;
  };
}

export interface ArenaRepositoryRunClaimInput {
  readonly runId: string;
  readonly repositoryIdentitySha256: string;
  readonly sourceDirectoryIdentitySha256: string;
  readonly privateStorageIdentitySha256: string;
  readonly repositoryControlSha256: string;
  readonly baseRevisionSha256: string;
  readonly manifestLockEventSha256: string;
  readonly recoveryProofSha256: string | null;
}

export interface ArenaRepositoryRunClaim {
  readonly runId: string;
  readonly repositoryIdentitySha256: string;
  readonly ownerId: string;
  readonly claimSha256: string;
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
  releaseWithProof(
    createCompletionReceipt: () => Promise<string>,
  ): Promise<void>;
  abandon(): void;
}

type ArenaRepositoryLeaseEventType =
  | "claimAcquired"
  | "claimRecovered"
  | "claimReleased";

interface ArenaRepositoryClaimPayload extends ArenaRepositoryRunClaimInput {
  readonly payloadType: "claimAcquired" | "claimRecovered";
  readonly ownerId: string;
  readonly pid: number;
  readonly priorClaimSha256: string | null;
}

interface ArenaRepositoryReleasePayload {
  readonly payloadType: "claimReleased";
  readonly runId: string;
  readonly repositoryIdentitySha256: string;
  readonly ownerId: string;
  readonly claimSha256: string;
  readonly completionReceiptSha256: string;
}

type ArenaRepositoryLeasePayload =
  | ArenaRepositoryClaimPayload
  | ArenaRepositoryReleasePayload;

interface ArenaRepositoryLeaseEvent {
  readonly schemaVersion: typeof ARENA_REPOSITORY_LEASE_SCHEMA_VERSION;
  readonly sequence: number;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly type: ArenaRepositoryLeaseEventType;
  readonly payload: ArenaRepositoryLeasePayload;
  readonly previousEventSha256: string;
  readonly eventSha256: string;
}

interface ArenaRepositoryLeaseReplay {
  readonly events: readonly ArenaRepositoryLeaseEvent[];
  readonly claimedRunIds: ReadonlySet<string>;
  readonly releasedCompletionByRun: ReadonlyMap<string, string>;
  readonly activeClaim?: ArenaRepositoryLeaseEvent & {
    readonly payload: ArenaRepositoryClaimPayload;
  };
}

export async function prepareArenaRepositoryLeaseRoot(
  leaseRoot: string,
): Promise<ArenaRepositoryLeaseBoundary> {
  if (!path.isAbsolute(leaseRoot)) {
    throw new Error("Arena repository lease root must be absolute.");
  }
  const logicalRoot = path.resolve(leaseRoot);
  await fs.mkdir(logicalRoot, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(logicalRoot);
  assertRealDirectory(stat, "Arena repository lease root");
  const realRoot = await fs.realpath(logicalRoot);
  await fs.chmod(logicalRoot, 0o700).catch(() => undefined);
  return Object.freeze({
    logicalRoot,
    realRoot,
    identity: statIdentity(stat),
  });
}

export async function assertArenaRepositoryLeaseBoundary(
  boundary: ArenaRepositoryLeaseBoundary,
): Promise<void> {
  const stat = await fs.lstat(boundary.logicalRoot);
  assertRealDirectory(stat, "Arena repository lease root");
  if (!samePath(await fs.realpath(boundary.logicalRoot), boundary.realRoot)
    || !sameIdentity(stat, boundary.identity)) {
    throw new Error("Arena repository lease root changed identity.");
  }
}

export class FileArenaRepositoryRunLeaseStore {
  constructor(readonly boundary: ArenaRepositoryLeaseBoundary) {}

  async withRepositoryLock<T>(
    repositoryIdentitySha256: string,
    work: () => Promise<T>,
  ): Promise<T> {
    assertSha256(repositoryIdentitySha256, "repository identity");
    await assertArenaRepositoryLeaseBoundary(this.boundary);
    const lockPath = path.join(
      this.boundary.realRoot,
      `${repositoryIdentitySha256}.lock.v1`,
    );
    return serializePerFileAcrossProcesses(lockPath, async () => {
      await assertArenaRepositoryLeaseBoundary(this.boundary);
      try {
        return await work();
      } finally {
        await assertArenaRepositoryLeaseBoundary(this.boundary);
      }
    });
  }

  async claim(
    input: ArenaRepositoryRunClaimInput,
  ): Promise<ArenaRepositoryRunClaim> {
    validateClaimInput(input);
    const ownerId = randomUUID();
    const ledgerPath = this.ledgerPath(input.repositoryIdentitySha256);
    let claimEvent!: ArenaRepositoryLeaseEvent & {
      readonly payload: ArenaRepositoryClaimPayload;
    };
    await this.withRepositoryLock(
      input.repositoryIdentitySha256,
      async () => {
        const replay = await loadLedger(
          ledgerPath,
          this.boundary,
          input.repositoryIdentitySha256,
        );
        const active = replay.activeClaim;
        if (active && !sameClaimBinding(active.payload, input)) {
          throw new Error(
            `Arena repository remains owned by unreleased run ${
              active.payload.runId
            }.`,
          );
        }
        if (active) {
          throw new Error(
            "Arena repository restart takeover is disabled until a typed private process-quiescence receipt is replay-validated.",
          );
        }
        if (!active && replay.claimedRunIds.has(input.runId)) {
          throw new Error(
            `Arena repository run ${input.runId} was already released and cannot be reused.`,
          );
        }
        const type: ArenaRepositoryLeaseEventType = "claimAcquired";
        claimEvent = await appendLedgerEvent(
          ledgerPath,
          replay,
          {
            eventId: randomUUID(),
            occurredAt: new Date().toISOString(),
            type,
            payload: {
              payloadType: type,
              ...input,
              ownerId,
              pid: process.pid,
              priorClaimSha256: null,
            },
          },
          this.boundary,
        ) as typeof claimEvent;
        activeLocalOwners.add(ownerId);
      },
    );

    let disposed = false;
    let lost = false;
    const stopLocal = () => {
      if (disposed) return;
      disposed = true;
      activeLocalOwners.delete(ownerId);
    };
    const assertOwned = async (): Promise<void> => {
      if (disposed || lost || !activeLocalOwners.has(ownerId)) {
        throw new Error("Arena repository run claim is no longer active.");
      }
      const replay = await loadLedger(
        ledgerPath,
        this.boundary,
        input.repositoryIdentitySha256,
      );
      const active = replay.activeClaim;
      if (!active
        || active.eventSha256 !== claimEvent.eventSha256
        || active.payload.ownerId !== ownerId
        || active.payload.pid !== process.pid) {
        lost = true;
        activeLocalOwners.delete(ownerId);
        throw new Error("Arena repository run claim changed ownership.");
      }
    };

    return Object.freeze({
      runId: input.runId,
      repositoryIdentitySha256: input.repositoryIdentitySha256,
      ownerId,
      claimSha256: claimEvent.eventSha256,
      runExclusive: async <T>(work: () => Promise<T>): Promise<T> =>
        this.withRepositoryLock(
          input.repositoryIdentitySha256,
          async () => {
            await assertOwned();
            const result = await work();
            await assertOwned();
            return result;
          },
        ),
      releaseWithProof: async (
        createCompletionReceipt: () => Promise<string>,
      ): Promise<void> => {
        await this.withRepositoryLock(
          input.repositoryIdentitySha256,
          async () => {
            const before = await loadLedger(
              ledgerPath,
              this.boundary,
              input.repositoryIdentitySha256,
            );
            const existingRelease = before.events.find((event) =>
              event.type === "claimReleased"
              && (event.payload as ArenaRepositoryReleasePayload)
                .claimSha256 === claimEvent.eventSha256
              && (event.payload as ArenaRepositoryReleasePayload)
                .ownerId === ownerId);
            if (existingRelease) return;
            await assertOwned();
            const completionReceiptSha256 =
              await createCompletionReceipt();
            assertSha256(completionReceiptSha256, "completion receipt");
            await assertOwned();
            const replay = await loadLedger(
              ledgerPath,
              this.boundary,
              input.repositoryIdentitySha256,
            );
            await appendLedgerEvent(
              ledgerPath,
              replay,
              {
                eventId: randomUUID(),
                occurredAt: new Date().toISOString(),
                type: "claimReleased",
                payload: {
                  payloadType: "claimReleased",
                  runId: input.runId,
                  repositoryIdentitySha256:
                    input.repositoryIdentitySha256,
                  ownerId,
                  claimSha256: claimEvent.eventSha256,
                  completionReceiptSha256,
                },
              },
              this.boundary,
            );
          },
        );
        stopLocal();
      },
      abandon: stopLocal,
    });
  }

  async releasedCompletion(
    input: ArenaRepositoryRunClaimInput,
  ): Promise<string | undefined> {
    validateClaimInput(input);
    return this.withRepositoryLock(
      input.repositoryIdentitySha256,
      async () => {
        const replay = await loadLedger(
          this.ledgerPath(input.repositoryIdentitySha256),
          this.boundary,
          input.repositoryIdentitySha256,
        );
        const completion =
          replay.releasedCompletionByRun.get(input.runId);
        if (!completion) return undefined;
        const claim = replay.events.find((event) =>
          (event.type === "claimAcquired"
            || event.type === "claimRecovered")
          && (event.payload as ArenaRepositoryClaimPayload).runId
            === input.runId) as
              | (ArenaRepositoryLeaseEvent & {
                  readonly payload: ArenaRepositoryClaimPayload;
                })
              | undefined;
        if (!claim || !sameClaimBinding(claim.payload, input)) {
          throw new Error(
            "Arena released run binding does not match the requested manifest.",
          );
        }
        return completion;
      },
    );
  }

  private ledgerPath(repositoryIdentitySha256: string): string {
    assertSha256(repositoryIdentitySha256, "repository identity");
    return path.join(
      this.boundary.realRoot,
      `${repositoryIdentitySha256}.owner.v1.jsonl`,
    );
  }
}

async function loadLedger(
  ledgerPath: string,
  boundary: ArenaRepositoryLeaseBoundary,
  expectedRepositoryIdentitySha256: string,
): Promise<ArenaRepositoryLeaseReplay> {
  await assertArenaRepositoryLeaseBoundary(boundary);
  let before: Stats;
  try {
    before = await fs.lstat(ledgerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({
        events: Object.freeze([]),
        claimedRunIds: new Set<string>(),
        releasedCompletionByRun: new Map<string, string>(),
      });
    }
    throw error;
  }
  assertSafeFile(before, ledgerPath);
  if (before.size === 0 || before.size > MAX_LEDGER_BYTES) {
    throw new Error("Arena repository owner ledger is empty or oversized.");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
  const handle = await fs.open(ledgerPath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    assertSafeFile(opened, ledgerPath);
    if (!sameFileIdentity(before, opened)) {
      throw new Error("Arena repository owner ledger changed while opening.");
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) {
        throw new Error("Arena repository owner ledger was truncated during read.");
      }
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (!sameFileIdentity(opened, after) || after.size !== opened.size) {
      throw new Error("Arena repository owner ledger changed during read.");
    }
    return replayLedger(
      parseLedgerBytes(bytes),
      expectedRepositoryIdentitySha256,
    );
  } finally {
    await handle.close();
  }
}

function parseLedgerBytes(bytes: Buffer): readonly ArenaRepositoryLeaseEvent[] {
  if (bytes.at(-1) !== 0x0a) {
    throw new Error("Arena repository owner ledger has a torn final record.");
  }
  const lines = bytes.subarray(0, -1).toString("utf8").split("\n");
  if (!Buffer.from(`${lines.join("\n")}\n`, "utf8").equals(bytes)) {
    throw new Error("Arena repository owner ledger is not canonical UTF-8.");
  }
  if (lines.length > MAX_LEDGER_EVENTS) {
    throw new Error("Arena repository owner ledger exceeds its event bound.");
  }
  return Object.freeze(lines.map((line, index) => {
    if (line.length === 0
      || Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) {
      throw new Error("Arena repository owner ledger contains an invalid line.");
    }
    const value = parseLeaseEvent(JSON.parse(line) as unknown);
    if (canonicalJson(value) !== line) {
      throw new Error(
        `Arena repository owner event ${index + 1} is not canonical JSON.`,
      );
    }
    return value;
  }));
}

function replayLedger(
  events: readonly ArenaRepositoryLeaseEvent[],
  expectedRepositoryIdentitySha256?: string,
): ArenaRepositoryLeaseReplay {
  let activeClaim:
    | (ArenaRepositoryLeaseEvent & {
        readonly payload: ArenaRepositoryClaimPayload;
      })
    | undefined;
  let previous = ARENA_REPOSITORY_LEASE_GENESIS_SHA256;
  const claimedRunIds = new Set<string>();
  const releasedCompletionByRun = new Map<string, string>();
  events.forEach((event, index) => {
    if (event.sequence !== index + 1
      || event.previousEventSha256 !== previous
      || event.eventSha256 !== leaseEventSha256(event)) {
      throw new Error("Arena repository owner ledger hash chain is invalid.");
    }
    if (event.type === "claimAcquired") {
      if (activeClaim) {
        throw new Error("Arena repository owner ledger acquires while active.");
      }
      const payload = event.payload as ArenaRepositoryClaimPayload;
      if (expectedRepositoryIdentitySha256
          && payload.repositoryIdentitySha256
            !== expectedRepositoryIdentitySha256) {
        throw new Error("Arena repository owner ledger is stored under the wrong identity.");
      }
      if (payload.payloadType !== "claimAcquired"
        || payload.priorClaimSha256 !== null
        || claimedRunIds.has(payload.runId)) {
        throw new Error("Arena repository claim-acquired payload is invalid.");
      }
      claimedRunIds.add(payload.runId);
      activeClaim = event as ArenaRepositoryLeaseEvent & {
        readonly payload: ArenaRepositoryClaimPayload;
      };
    } else if (event.type === "claimRecovered") {
      const payload = event.payload as ArenaRepositoryClaimPayload;
      if (expectedRepositoryIdentitySha256
          && payload.repositoryIdentitySha256
            !== expectedRepositoryIdentitySha256) {
        throw new Error("Arena repository recovery is stored under the wrong identity.");
      }
      if (!activeClaim
        || payload.payloadType !== "claimRecovered"
        || payload.priorClaimSha256 !== activeClaim.eventSha256
        || !sameClaimBinding(payload, activeClaim.payload)) {
        throw new Error("Arena repository recovery does not bind its active claim.");
      }
      activeClaim = event as ArenaRepositoryLeaseEvent & {
        readonly payload: ArenaRepositoryClaimPayload;
      };
    } else {
      const payload = event.payload as ArenaRepositoryReleasePayload;
      if (expectedRepositoryIdentitySha256
          && payload.repositoryIdentitySha256
            !== expectedRepositoryIdentitySha256) {
        throw new Error("Arena repository release is stored under the wrong identity.");
      }
      if (!activeClaim
        || payload.payloadType !== "claimReleased"
        || payload.runId !== activeClaim.payload.runId
        || payload.repositoryIdentitySha256
          !== activeClaim.payload.repositoryIdentitySha256
        || payload.ownerId !== activeClaim.payload.ownerId
        || payload.claimSha256 !== activeClaim.eventSha256) {
        throw new Error("Arena repository release does not bind its active claim.");
      }
      releasedCompletionByRun.set(
        payload.runId,
        payload.completionReceiptSha256,
      );
      activeClaim = undefined;
    }
    previous = event.eventSha256;
  });
  return Object.freeze({
    events: Object.freeze([...events]),
    claimedRunIds,
    releasedCompletionByRun,
    ...(activeClaim ? { activeClaim } : {}),
  });
}

async function appendLedgerEvent(
  ledgerPath: string,
  replay: ArenaRepositoryLeaseReplay,
  draft: {
    readonly eventId: string;
    readonly occurredAt: string;
    readonly type: ArenaRepositoryLeaseEventType;
    readonly payload: ArenaRepositoryLeasePayload;
  },
  boundary: ArenaRepositoryLeaseBoundary,
): Promise<ArenaRepositoryLeaseEvent> {
  const reservesRelease = draft.type !== "claimReleased";
  const eventLimit = reservesRelease
    ? MAX_LEDGER_EVENTS - 1
    : MAX_LEDGER_EVENTS;
  if (replay.events.length >= eventLimit) {
    throw new Error(
      reservesRelease
        ? "Arena repository owner ledger lacks reserved release capacity."
        : "Arena repository owner ledger reached its event bound.",
    );
  }
  const eventWithoutHash = {
    schemaVersion: ARENA_REPOSITORY_LEASE_SCHEMA_VERSION,
    sequence: replay.events.length + 1,
    eventId: draft.eventId,
    occurredAt: draft.occurredAt,
    type: draft.type,
    payload: draft.payload,
    previousEventSha256:
      replay.events.at(-1)?.eventSha256
      ?? ARENA_REPOSITORY_LEASE_GENESIS_SHA256,
  } as const;
  const event: ArenaRepositoryLeaseEvent = Object.freeze({
    ...eventWithoutHash,
    eventSha256: hashCanonical(
      "hydra.arena.repository-lease-event.v1\u0000",
      eventWithoutHash,
    ),
  });
  replayLedger(
    [...replay.events, event],
    draft.payload.repositoryIdentitySha256,
  );
  const line = `${canonicalJson(event)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) {
    throw new Error("Arena repository owner event exceeds its byte bound.");
  }
  await assertArenaRepositoryLeaseBoundary(boundary);
  const currentBytes = replay.events.length === 0
    ? 0
    : (await fs.lstat(ledgerPath)).size;
  const nextBytes = currentBytes + Buffer.byteLength(line, "utf8");
  const byteLimit = reservesRelease
    ? MAX_LEDGER_BYTES - MAX_EVENT_BYTES
    : MAX_LEDGER_BYTES;
  if (nextBytes > byteLimit) {
    throw new Error(
      reservesRelease
        ? "Arena repository owner ledger lacks reserved release bytes."
        : "Arena repository owner ledger reached its byte bound.",
    );
  }
  if (replay.events.length === 0) {
    const handle = await fs.open(ledgerPath, "wx", 0o600);
    try {
      const opened = await handle.stat();
      assertSafeFile(opened, ledgerPath);
      await handle.writeFile(line, "utf8");
      await handle.sync();
      const entry = await fs.lstat(ledgerPath);
      if (!sameFileIdentity(opened, entry)) {
        throw new Error("Arena repository owner ledger changed during create.");
      }
    } finally {
      await handle.close();
    }
    return event;
  }
  const before = await fs.lstat(ledgerPath);
  assertSafeFile(before, ledgerPath);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
  const handle = await fs.open(
    ledgerPath,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | noFollow,
  );
  try {
    const opened = await handle.stat();
    if (!sameFileIdentity(before, opened)) {
      throw new Error("Arena repository owner ledger changed before append.");
    }
    await assertArenaRepositoryLeaseBoundary(boundary);
    const entry = await fs.lstat(ledgerPath);
    if (!sameFileIdentity(opened, entry)) {
      throw new Error("Arena repository owner ledger changed during append.");
    }
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return event;
}

function parseLeaseEvent(value: unknown): ArenaRepositoryLeaseEvent {
  const row = exactRecord(value, [
    "schemaVersion",
    "sequence",
    "eventId",
    "occurredAt",
    "type",
    "payload",
    "previousEventSha256",
    "eventSha256",
  ], "owner event");
  if (row.schemaVersion !== ARENA_REPOSITORY_LEASE_SCHEMA_VERSION
    || !Number.isSafeInteger(row.sequence)
    || (row.sequence as number) < 1
    || typeof row.eventId !== "string"
    || !IDENTIFIER_PATTERN.test(row.eventId)
    || typeof row.occurredAt !== "string"
    || !validTimestamp(row.occurredAt)
    || typeof row.type !== "string"
    || !["claimAcquired", "claimRecovered", "claimReleased"].includes(row.type)
    || typeof row.previousEventSha256 !== "string"
    || !SHA256_PATTERN.test(row.previousEventSha256)
    || typeof row.eventSha256 !== "string"
    || !SHA256_PATTERN.test(row.eventSha256)) {
    throw new Error("Arena repository owner event contains invalid metadata.");
  }
  const type = row.type as ArenaRepositoryLeaseEventType;
  const payload = type === "claimReleased"
    ? parseReleasePayload(row.payload)
    : parseClaimPayload(row.payload, type);
  return Object.freeze({
    schemaVersion: ARENA_REPOSITORY_LEASE_SCHEMA_VERSION,
    sequence: row.sequence as number,
    eventId: row.eventId,
    occurredAt: row.occurredAt,
    type,
    payload,
    previousEventSha256: row.previousEventSha256,
    eventSha256: row.eventSha256,
  });
}

function parseClaimPayload(
  value: unknown,
  type: "claimAcquired" | "claimRecovered",
): ArenaRepositoryClaimPayload {
  const row = exactRecord(value, [
    "payloadType",
    "runId",
    "repositoryIdentitySha256",
    "sourceDirectoryIdentitySha256",
    "privateStorageIdentitySha256",
    "repositoryControlSha256",
    "baseRevisionSha256",
    "manifestLockEventSha256",
    "recoveryProofSha256",
    "ownerId",
    "pid",
    "priorClaimSha256",
  ], "claim payload");
  const input: ArenaRepositoryRunClaimInput = {
    runId: boundedIdentifier(row.runId, "run ID"),
    repositoryIdentitySha256:
      sha256(row.repositoryIdentitySha256, "repository identity"),
    sourceDirectoryIdentitySha256:
      sha256(row.sourceDirectoryIdentitySha256, "source identity"),
    privateStorageIdentitySha256:
      sha256(row.privateStorageIdentitySha256, "private identity"),
    repositoryControlSha256:
      sha256(row.repositoryControlSha256, "repository controls"),
    baseRevisionSha256:
      sha256(row.baseRevisionSha256, "base revision"),
    manifestLockEventSha256:
      sha256(row.manifestLockEventSha256, "manifest lock"),
    recoveryProofSha256: row.recoveryProofSha256 === null
      ? null
      : sha256(row.recoveryProofSha256, "recovery proof"),
  };
  if (row.payloadType !== type
    || typeof row.ownerId !== "string"
    || !IDENTIFIER_PATTERN.test(row.ownerId)
    || !Number.isSafeInteger(row.pid)
    || (row.pid as number) < 1
    || (row.priorClaimSha256 !== null
      && (typeof row.priorClaimSha256 !== "string"
        || !SHA256_PATTERN.test(row.priorClaimSha256)))) {
    throw new Error("Arena repository claim payload contains invalid values.");
  }
  return Object.freeze({
    payloadType: type,
    ...input,
    ownerId: row.ownerId,
    pid: row.pid as number,
    priorClaimSha256: row.priorClaimSha256 as string | null,
  });
}

function parseReleasePayload(value: unknown): ArenaRepositoryReleasePayload {
  const row = exactRecord(value, [
    "payloadType",
    "runId",
    "repositoryIdentitySha256",
    "ownerId",
    "claimSha256",
    "completionReceiptSha256",
  ], "release payload");
  if (row.payloadType !== "claimReleased") {
    throw new Error("Arena repository release payload type is invalid.");
  }
  return Object.freeze({
    payloadType: "claimReleased",
    runId: boundedIdentifier(row.runId, "run ID"),
    repositoryIdentitySha256:
      sha256(row.repositoryIdentitySha256, "repository identity"),
    ownerId: boundedIdentifier(row.ownerId, "owner ID"),
    claimSha256: sha256(row.claimSha256, "claim"),
    completionReceiptSha256:
      sha256(row.completionReceiptSha256, "completion receipt"),
  });
}

function leaseEventSha256(event: ArenaRepositoryLeaseEvent): string {
  const {
    eventSha256: _ignored,
    ...withoutHash
  } = event;
  return hashCanonical(
    "hydra.arena.repository-lease-event.v1\u0000",
    withoutHash,
  );
}

function validateClaimInput(input: ArenaRepositoryRunClaimInput): void {
  boundedIdentifier(input.runId, "run ID");
  assertSha256(input.repositoryIdentitySha256, "repository identity");
  assertSha256(input.sourceDirectoryIdentitySha256, "source identity");
  assertSha256(input.privateStorageIdentitySha256, "private storage identity");
  assertSha256(input.repositoryControlSha256, "repository controls");
  assertSha256(input.baseRevisionSha256, "base revision");
  assertSha256(input.manifestLockEventSha256, "manifest lock event");
  if (input.recoveryProofSha256 !== null) {
    assertSha256(input.recoveryProofSha256, "recovery proof");
  }
}

function sameClaimBinding(
  left: ArenaRepositoryRunClaimInput,
  right: ArenaRepositoryRunClaimInput,
): boolean {
  return left.runId === right.runId
    && left.repositoryIdentitySha256 === right.repositoryIdentitySha256
    && left.sourceDirectoryIdentitySha256
      === right.sourceDirectoryIdentitySha256
    && left.privateStorageIdentitySha256
      === right.privateStorageIdentitySha256
    && left.repositoryControlSha256 === right.repositoryControlSha256
    && left.baseRevisionSha256 === right.baseRevisionSha256
    && left.manifestLockEventSha256 === right.manifestLockEventSha256;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error(`Arena ${label} must be a plain object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Arena ${label} has an invalid exact schema.`);
  }
  return value;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Arena ${label} is invalid.`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`Arena ${label} must be one lowercase SHA-256 digest.`);
  }
  return value;
}

function assertSha256(value: string, label: string): void {
  sha256(value, label);
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function assertRealDirectory(stat: Stats, label: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

function assertSafeFile(stat: Stats, label: string): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be one unlinked regular file.`);
  }
}

function statIdentity(stat: Stats): { readonly dev: string; readonly ino: string } {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameIdentity(
  stat: Stats,
  identity: { readonly dev: string; readonly ino: string },
): boolean {
  return String(stat.dev) === identity.dev && String(stat.ino) === identity.ino;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hashCanonical(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null
    || typeof value === "string"
    || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error("Arena lease JSON requires finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (!isPlainRecord(value)) {
    throw new Error("Arena lease JSON requires plain JSON values.");
  }
  return `{${Object.keys(value).sort().map((key) => {
    const entry = value[key];
    if (entry === undefined) {
      throw new Error("Arena lease JSON rejects undefined values.");
    }
    return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
  }).join(",")}}`;
}
