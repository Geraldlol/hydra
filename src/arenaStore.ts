import {
  constants as fsConstants,
  type Dirent,
  type Stats,
} from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import {
  ARENA_CLEANUP_RETRY_DELAYS_MS,
  ARENA_CLEANUP_STEPS,
} from "./arenaCleanup";
import {
  assertArenaPrivateDirectory,
  assertArenaPrivateParent,
  createArenaPrivateFile,
  ensureArenaPrivateDirectory,
  prepareArenaPrivateStorage,
  serializeArenaPrivateWork,
  writeArenaPrivateFileAtomically,
  type ArenaPrivateStorageBoundary,
} from "./arenaPrivateStorage";
import { arenaPhysicalWorktreeSegment } from "./arenaPathBudget";
import {
  ARENA_MANIFEST_GENESIS_SHA256,
  ARENA_MANIFEST_LIMITS,
  ARENA_MANIFEST_SCHEMA_VERSION,
  ArenaManifestValidationError,
  canonicalArenaManifestJson,
  createArenaManifestEvent,
  isArenaManifestEvent,
  replayArenaManifest,
  type ArenaManifestEvent,
  type ArenaManifestEventDraft,
  type ArenaManifestReplay,
} from "./arenaRunManifest";

export const ARENA_RUN_INDEX_MAX_BYTES = 8 * 1024 * 1024;
export const ARENA_RUN_INDEX_MAX_ENTRIES = 10_000;
export const ARENA_MANIFEST_CLOSURE_EVENT_RESERVE =
  ARENA_MANIFEST_LIMITS.maxContestants
    * (3 + ARENA_CLEANUP_STEPS.length
      * (ARENA_CLEANUP_RETRY_DELAYS_MS.length + 1))
  + 3;
export const ARENA_MANIFEST_CLOSURE_BYTE_RESERVE = 1024 * 1024;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ArenaStorePaths {
  readonly rootPath: string;
  readonly runsPath: string;
  readonly artifactsPath: string;
  readonly worktreesPath: string;
  readonly indexPath: string;
}

export interface ArenaRunPaths {
  readonly runPath: string;
  readonly manifestPath: string;
  readonly artifactPath: string;
  readonly worktreePath: string;
}

export interface ArenaRunIndexEntry {
  readonly schemaVersion: typeof ARENA_MANIFEST_SCHEMA_VERSION;
  readonly runId: string;
  readonly state:
    | ArenaManifestReplay["state"]
    | "invalid";
  readonly comparison: "comparable" | "compromised" | "incomplete" | null;
  readonly occurredAt: string | null;
  readonly eventCount: number;
  readonly manifestBytes: number;
}

export type ArenaManifestFileErrorCode =
  | "torn"
  | "malformed"
  | "unknownVersion"
  | "oversized"
  | "blankLine"
  | "eventCount"
  | "nonCanonical"
  | "invalid"
  | "capacity";

export class ArenaManifestFileError extends Error {
  constructor(
    readonly code: ArenaManifestFileErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArenaManifestFileError";
  }
}

export interface ArenaManifestStore {
  append(draft: ArenaManifestEventDraft): Promise<ArenaManifestEvent>;
  load(runId: string): Promise<ArenaManifestReplay | undefined>;
  listRunIds(): Promise<readonly string[]>;
}

export type ArenaManifestCapacityDecision =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reason: "eventCapacity" | "byteCapacity" | "eventSize";
    };

export function evaluateArenaManifestAppendCapacity(
  input: {
    readonly currentEvents: number;
    readonly currentBytes: number;
    readonly candidateBytes: number;
    readonly eventType: ArenaManifestEvent["type"];
    readonly observationKind?:
      | "monitorStarted"
      | "checkpoint"
      | "postEvidence";
    readonly observationStatus?: "unchanged" | "changed" | "unverifiable";
    readonly changedObservationAlreadyRecorded?: boolean;
  },
): ArenaManifestCapacityDecision {
  if (input.candidateBytes > ARENA_MANIFEST_LIMITS.maxEventBytes) {
    return { accepted: false, reason: "eventSize" };
  }
  const nextEvents = input.currentEvents + 1;
  const nextBytes = input.currentBytes + input.candidateBytes;
  if (nextEvents > ARENA_MANIFEST_LIMITS.maxEvents) {
    return { accepted: false, reason: "eventCapacity" };
  }
  if (nextBytes > ARENA_MANIFEST_LIMITS.maxManifestBytes) {
    return { accepted: false, reason: "byteCapacity" };
  }
  if (isArenaClosureEvent(
    input.eventType,
    input.observationKind,
    input.observationStatus,
    input.changedObservationAlreadyRecorded === true,
  )) return { accepted: true };
  if (nextEvents
    > ARENA_MANIFEST_LIMITS.maxEvents - ARENA_MANIFEST_CLOSURE_EVENT_RESERVE) {
    return { accepted: false, reason: "eventCapacity" };
  }
  if (nextBytes
    > ARENA_MANIFEST_LIMITS.maxManifestBytes
      - ARENA_MANIFEST_CLOSURE_BYTE_RESERVE) {
    return { accepted: false, reason: "byteCapacity" };
  }
  return { accepted: true };
}

export function arenaStorePaths(privateWorkspaceRoot: string): ArenaStorePaths {
  const rootPath = path.resolve(privateWorkspaceRoot, "arena");
  return {
    rootPath,
    runsPath: path.join(rootPath, "runs"),
    artifactsPath: path.join(rootPath, "artifacts"),
    worktreesPath: path.join(rootPath, "worktrees"),
    indexPath: path.join(rootPath, "index.v1.jsonl"),
  };
}

export function arenaRunPaths(
  privateWorkspaceRoot: string,
  runId: string,
): ArenaRunPaths {
  assertArenaIdentifier(runId, "run ID");
  const store = arenaStorePaths(privateWorkspaceRoot);
  const runPath = exactChild(store.runsPath, runId);
  return {
    runPath,
    manifestPath: path.join(runPath, "manifest.v1.jsonl"),
    artifactPath: exactChild(store.artifactsPath, runId),
    // Logical run and contestant IDs never become physical worktree path
    // material. Besides avoiding accidental disclosure, the shared short
    // parent leaves substantially more of Windows' legacy MAX_PATH budget for
    // tracked repository paths. The manifest and registration stores retain
    // the full logical identities.
    worktreePath: exactChild(store.worktreesPath, "p"),
  };
}

export function arenaContestantArtifactPath(
  privateWorkspaceRoot: string,
  runId: string,
  contestantId: string,
): string {
  assertArenaIdentifier(contestantId, "contestant ID");
  return exactChild(
    arenaRunPaths(privateWorkspaceRoot, runId).artifactPath,
    contestantId,
  );
}

export function arenaContestantWorktreePath(
  privateWorkspaceRoot: string,
  runId: string,
  contestantId: string,
): string {
  assertArenaIdentifier(contestantId, "contestant ID");
  return exactChild(
    arenaRunPaths(privateWorkspaceRoot, runId).worktreePath,
    arenaPhysicalWorktreeSegment(runId, contestantId),
  );
}

export class FileArenaManifestStore implements ArenaManifestStore {
  readonly paths: ArenaStorePaths;
  private boundaryPromise: Promise<ArenaPrivateStorageBoundary> | undefined;

  constructor(readonly privateWorkspaceRoot: string) {
    this.paths = arenaStorePaths(privateWorkspaceRoot);
  }

  async append(draft: ArenaManifestEventDraft): Promise<ArenaManifestEvent> {
    assertExactArenaDraft(draft);
    const runPaths = arenaRunPaths(this.privateWorkspaceRoot, draft.runId);
    const boundary = await this.boundary();
    await ensureArenaPrivateDirectory(boundary, ["runs", draft.runId]);
    const filePath = runPaths.manifestPath;
    return serializeArenaPrivateWork(boundary, filePath, async () => {
      await assertArenaPrivateParent(filePath, boundary);
      let current: LoadedArenaManifestFile;
      try {
        current = await loadArenaManifestFile(filePath, boundary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        current = { events: [], totalBytes: 0 };
      }
      const existing = current.events.find((event) =>
        event.eventId === draft.eventId);
      if (existing) {
        if (canonicalArenaManifestJson(eventToDraft(existing))
          === canonicalArenaManifestJson(draft)) {
          return existing;
        }
        throw new ArenaManifestFileError(
          "invalid",
          `Arena event ID ${draft.eventId} collided with different metadata.`,
        );
      }

      const previous = current.events.at(-1);
      const candidate = createArenaManifestEvent(
        structuredClone(draft),
        current.events.length + 1,
        previous?.eventSha256 ?? ARENA_MANIFEST_GENESIS_SHA256,
      );
      const line = `${canonicalArenaManifestJson(candidate)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      const capacity = evaluateArenaManifestAppendCapacity({
        currentEvents: current.events.length,
        currentBytes: current.totalBytes,
        candidateBytes: lineBytes,
        eventType: candidate.type,
        observationKind: candidate.type === "arenaMainWorkspaceObserved"
          ? (candidate.payload as {
              observationKind:
                | "monitorStarted"
                | "checkpoint"
                | "postEvidence";
            }).observationKind
          : undefined,
        observationStatus: candidate.type === "arenaMainWorkspaceObserved"
          ? (candidate.payload as {
              status: "unchanged" | "changed" | "unverifiable";
            }).status
          : undefined,
        changedObservationAlreadyRecorded: current.events.some((event) =>
          event.type === "arenaMainWorkspaceObserved"
          && (event.payload as {
            status: "unchanged" | "changed" | "unverifiable";
          }).status !== "unchanged"),
      });
      if (!capacity.accepted) {
        throw new ArenaManifestFileError(
          "capacity",
          `Arena manifest reached its reserved ${capacity.reason}.`,
        );
      }

      try {
        replayArenaManifest([...current.events, candidate]);
      } catch (error) {
        if (error instanceof ArenaManifestValidationError) {
          throw new ArenaManifestFileError(
            "invalid",
            `Refusing invalid Arena append: ${error.issues.join("; ")}`,
            { cause: error },
          );
        }
        throw error;
      }
      // Publish the complete validated history as one atomic replacement.
      // Appending directly can leave a syntactically torn final authority row
      // after an extension-host or machine crash. Arena real-run admission
      // therefore relies on the old-or-new property of same-directory rename:
      // replay observes either the prior complete chain or this complete chain,
      // never a partially written next sequence.
      const body = `${current.events
        .map((event) => canonicalArenaManifestJson(event))
        .join("\n")}${current.events.length > 0 ? "\n" : ""}${line}`;
      if (current.events.length === 0) {
        await createArenaPrivateFile(filePath, body, boundary);
      } else {
        await writeArenaPrivateFileAtomically(filePath, body, boundary);
      }
      return candidate;
    });
  }

  async load(runId: string): Promise<ArenaManifestReplay | undefined> {
    const boundary = await this.boundary();
    const runPath = arenaRunPaths(this.privateWorkspaceRoot, runId).runPath;
    try {
      await assertArenaPrivateDirectory(runPath, boundary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const filePath = arenaRunPaths(
      this.privateWorkspaceRoot,
      runId,
    ).manifestPath;
    return serializeArenaPrivateWork(boundary, filePath, async () => {
      let loaded: LoadedArenaManifestFile;
      try {
        loaded = await loadArenaManifestFile(filePath, boundary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      const replay = replayArenaManifest(loaded.events);
      if (replay.runId !== runId) {
        throw new ArenaManifestFileError(
          "invalid",
          `Arena manifest path ${runId} contains run ${replay.runId}.`,
        );
      }
      return replay;
    });
  }

  async listRunIds(): Promise<readonly string[]> {
    const boundary = await this.boundary();
    await assertArenaPrivateDirectory(this.paths.runsPath, boundary);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.paths.runsPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const runIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (!IDENTIFIER_PATTERN.test(entry.name)) continue;
      const candidate = exactChild(this.paths.runsPath, entry.name);
      const stat = await fs.lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      runIds.push(entry.name);
      if (runIds.length >= ARENA_RUN_INDEX_MAX_ENTRIES) break;
    }
    return runIds.sort(compareUtf8);
  }

  private boundary(): Promise<ArenaPrivateStorageBoundary> {
    this.boundaryPromise ??= prepareArenaPrivateStorage(
      this.privateWorkspaceRoot,
    );
    return this.boundaryPromise;
  }
}

export async function openFileArenaManifestStore(
  privateWorkspaceRoot: string,
): Promise<FileArenaManifestStore> {
  const store = new FileArenaManifestStore(privateWorkspaceRoot);
  const boundary = await prepareArenaPrivateStorage(privateWorkspaceRoot);
  try {
    await createArenaPrivateFile(store.paths.indexPath, "", boundary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await assertArenaPrivateParent(store.paths.indexPath, boundary);
    const stat = await fs.lstat(store.paths.indexPath);
    assertSafeManifestFile(stat, store.paths.indexPath);
  }
  return store;
}

/**
 * The index is only a bounded discovery cache. All authority and eligibility
 * checks reload and replay each run's private manifest.
 */
export async function rebuildArenaRunIndex(
  store: FileArenaManifestStore,
): Promise<readonly ArenaRunIndexEntry[]> {
  const boundary = await prepareArenaPrivateStorage(store.privateWorkspaceRoot);
  const entries: ArenaRunIndexEntry[] = [];
  for (const runId of await store.listRunIds()) {
    const manifestPath = arenaRunPaths(
      store.privateWorkspaceRoot,
      runId,
    ).manifestPath;
    let manifestBytes = 0;
    try {
      const stat = await fs.lstat(manifestPath);
      assertSafeManifestFile(stat, manifestPath);
      manifestBytes = stat.size;
      const replay = await store.load(runId);
      entries.push({
        schemaVersion: ARENA_MANIFEST_SCHEMA_VERSION,
        runId,
        state: replay?.state ?? "invalid",
        comparison: replay?.finalization
          ? (replay.finalization.payload as {
              comparison: "comparable" | "compromised" | "incomplete";
            }).comparison
          : null,
        occurredAt: replay?.records.at(-1)?.occurredAt ?? null,
        eventCount: replay?.records.length ?? 0,
        manifestBytes,
      });
    } catch {
      entries.push({
        schemaVersion: ARENA_MANIFEST_SCHEMA_VERSION,
        runId,
        state: "invalid",
        comparison: null,
        occurredAt: null,
        eventCount: 0,
        manifestBytes,
      });
    }
  }

  const bounded: ArenaRunIndexEntry[] = [];
  let bytes = 0;
  for (const entry of entries.slice(0, ARENA_RUN_INDEX_MAX_ENTRIES)) {
    const lineBytes = Buffer.byteLength(`${JSON.stringify(entry)}\n`, "utf8");
    if (bytes + lineBytes > ARENA_RUN_INDEX_MAX_BYTES) break;
    bounded.push(entry);
    bytes += lineBytes;
  }
  const body = bounded.map((entry) => JSON.stringify(entry)).join("\n");
  await writeArenaPrivateFileAtomically(
    store.paths.indexPath,
    body ? `${body}\n` : "",
    boundary,
  );
  return bounded;
}

interface LoadedArenaManifestFile {
  readonly events: readonly ArenaManifestEvent[];
  readonly totalBytes: number;
}

async function loadArenaManifestFile(
  filePath: string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<LoadedArenaManifestFile> {
  const file = await readArenaManifestBytes(filePath, boundary);
  if (file.totalBytes > ARENA_MANIFEST_LIMITS.maxManifestBytes) {
    throw new ArenaManifestFileError(
      "oversized",
      `Arena manifest exceeds ${ARENA_MANIFEST_LIMITS.maxManifestBytes} bytes.`,
    );
  }
  if (file.bytes.length === 0) {
    throw new ArenaManifestFileError(
      "invalid",
      "Arena manifest exists but is empty.",
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(file.bytes);
  } catch (error) {
    throw new ArenaManifestFileError(
      "malformed",
      "Arena manifest is not valid UTF-8.",
      { cause: error },
    );
  }
  if (!text.endsWith("\n")) {
    throw new ArenaManifestFileError(
      "torn",
      "Arena manifest is missing its final newline.",
    );
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > ARENA_MANIFEST_LIMITS.maxEvents) {
    throw new ArenaManifestFileError(
      "eventCount",
      `Arena manifest exceeds ${ARENA_MANIFEST_LIMITS.maxEvents} events.`,
    );
  }
  const events: ArenaManifestEvent[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line) {
      throw new ArenaManifestFileError(
        "blankLine",
        `Arena manifest line ${index + 1} is blank.`,
      );
    }
    if (Buffer.byteLength(`${line}\n`, "utf8")
      > ARENA_MANIFEST_LIMITS.maxEventBytes) {
      throw new ArenaManifestFileError(
        "oversized",
        `Arena manifest line ${index + 1} is oversized.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new ArenaManifestFileError(
        "malformed",
        `Arena manifest line ${index + 1} is malformed JSON.`,
        { cause: error },
      );
    }
    if (typeof parsed === "object"
      && parsed !== null
      && "schemaVersion" in parsed
      && (parsed as { schemaVersion?: unknown }).schemaVersion
        !== ARENA_MANIFEST_SCHEMA_VERSION) {
      throw new ArenaManifestFileError(
        "unknownVersion",
        `Arena manifest line ${index + 1} has an unknown schema version.`,
      );
    }
    if (!isArenaManifestEvent(parsed)) {
      throw new ArenaManifestFileError(
        "invalid",
        `Arena manifest line ${index + 1} has an invalid event shape or hash.`,
      );
    }
    if (line !== canonicalArenaManifestJson(parsed)) {
      throw new ArenaManifestFileError(
        "nonCanonical",
        `Arena manifest line ${index + 1} is not canonical hydra.arena.v1 JSON.`,
      );
    }
    events.push(parsed);
  }
  try {
    replayArenaManifest(events);
  } catch (error) {
    if (error instanceof ArenaManifestValidationError) {
      throw new ArenaManifestFileError(
        "invalid",
        `Arena manifest failed replay: ${error.issues.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }
  return { events, totalBytes: file.totalBytes };
}

async function readArenaManifestBytes(
  filePath: string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<{ readonly bytes: Buffer; readonly totalBytes: number }> {
  await assertArenaPrivateParent(filePath, boundary);
  const before = await fs.lstat(filePath);
  assertSafeManifestFile(before, filePath);
  if (before.size > ARENA_MANIFEST_LIMITS.maxManifestBytes) {
    return { bytes: Buffer.alloc(0), totalBytes: before.size };
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | noFollow,
  );
  try {
    const opened = await handle.stat();
    assertSafeManifestFile(opened, filePath);
    if (!sameFileIdentity(before, opened)) {
      throw new Error(`Refusing to read Arena manifest after path swap: ${filePath}`);
    }
    if (opened.size > ARENA_MANIFEST_LIMITS.maxManifestBytes) {
      return { bytes: Buffer.alloc(0), totalBytes: opened.size };
    }
    await assertArenaPrivateParent(filePath, boundary);
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    await assertArenaPrivateParent(filePath, boundary);
    const after = await fs.lstat(filePath);
    assertSafeManifestFile(after, filePath);
    if (!sameFileIdentity(opened, after)
      || opened.size !== after.size
      || offset !== opened.size) {
      throw new Error(`Refusing to read Arena manifest during mutation: ${filePath}`);
    }
    return { bytes: bytes.subarray(0, offset), totalBytes: opened.size };
  } finally {
    await handle.close();
  }
}

function eventToDraft(event: ArenaManifestEvent): ArenaManifestEventDraft {
  return {
    eventId: event.eventId,
    runId: event.runId,
    occurredAt: event.occurredAt,
    type: event.type,
    payload: event.payload,
  };
}

function isArenaClosureEvent(
  type: ArenaManifestEvent["type"],
  observationKind:
    | "monitorStarted"
    | "checkpoint"
    | "postEvidence"
    | undefined,
  observationStatus: "unchanged" | "changed" | "unverifiable" | undefined,
  changedObservationAlreadyRecorded: boolean,
): boolean {
  return type === "arenaWorktreeRegistered"
    || type === "arenaContestantFinished"
    || type === "arenaEvidencePreserved"
    || (type === "arenaMainWorkspaceObserved"
      && observationKind === "postEvidence")
    || (type === "arenaMainWorkspaceObserved"
      && observationKind === "checkpoint"
      && observationStatus !== undefined
      && observationStatus !== "unchanged"
      && !changedObservationAlreadyRecorded)
    || type === "arenaRunFinalized"
    || type === "arenaCleanupStepRecorded";
}

function assertExactArenaDraft(value: ArenaManifestEventDraft): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ArenaManifestFileError(
      "invalid",
      "Arena manifest drafts must be plain objects.",
    );
  }
  const expected = [
    "eventId",
    "occurredAt",
    "payload",
    "runId",
    "type",
  ];
  const actual = Object.keys(value).sort(compareUtf8);
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new ArenaManifestFileError(
      "invalid",
      `Arena manifest draft has unknown or missing fields: ${actual.join(", ")}.`,
    );
  }
  canonicalArenaManifestJson(value);
}

function assertArenaIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Arena ${label} is not safe for private storage.`);
  }
}

function exactChild(parent: string, identifier: string): string {
  const candidate = path.resolve(parent, identifier);
  if (path.dirname(candidate) !== path.resolve(parent)) {
    throw new Error("Arena private path escapes its exact parent.");
  }
  return candidate;
}

function assertSafeManifestFile(stat: Stats, filePath: string): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(
      `Refusing to read unsafe linked or non-file Arena manifest: ${filePath}`,
    );
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
