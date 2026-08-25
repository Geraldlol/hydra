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
  syncArenaDirectoryEntry,
  writeArenaPrivateFileAtomically,
  type ArenaDirectoryIdentity,
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
  type ArenaEvidencePreservedPayload,
  type ArenaBrowserJourneyRecordedPayload,
  type ArenaVerificationRecordedPayload,
} from "./arenaRunManifest";

export const ARENA_RUN_INDEX_MAX_BYTES = 8 * 1024 * 1024;
export const ARENA_RUN_INDEX_MAX_ENTRIES = 10_000;
export const ARENA_RUN_DIRECTORY_SCAN_MAX_ENTRIES = 50_000;
export const ARENA_MANIFEST_CLOSURE_EVENT_RESERVE =
  ARENA_MANIFEST_LIMITS.maxContestants
    * (3 + ARENA_CLEANUP_STEPS.length
      * (ARENA_CLEANUP_RETRY_DELAYS_MS.length + 1))
  // One changed-control receipt, postEvidence, publication seal, and finalize.
  + 4;
export const ARENA_MANIFEST_CLOSURE_BYTE_RESERVE = 1024 * 1024;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_DEVICE_BASENAME_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

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
  readonly manifestSegmentsPath: string;
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

export interface ArenaManifestLoadResult {
  readonly replay: ArenaManifestReplay;
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
      | "postEvidence"
      | "publicationSeal";
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
    manifestSegmentsPath: path.join(runPath, "manifest.v1.segments"),
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
        current = await loadArenaManifestHistory(runPaths, boundary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          await fs.lstat(runPaths.manifestSegmentsPath);
          throw new ArenaManifestFileError(
            "invalid",
            "Arena manifest segments exist without a base manifest.",
          );
        } catch (segmentError) {
          if ((segmentError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw segmentError;
          }
        }
        current = { events: [], totalBytes: 0, layout: "missing" };
      }
      const existing = current.events.find((event) =>
        event.eventId === draft.eventId);
      if (existing) {
        if (canonicalArenaManifestJson(eventToDraft(existing))
          === canonicalArenaManifestJson(draft)) {
          const publicationParent = current.layout === "legacy-v1"
            || existing.sequence === 1
            ? runPaths.runPath
            : runPaths.manifestSegmentsPath;
          await assertArenaPrivateDirectory(publicationParent, boundary);
          const publicationParentStat = await fs.lstat(publicationParent);
          if (!publicationParentStat.isDirectory()
            || publicationParentStat.isSymbolicLink()) {
            throw new ArenaManifestFileError(
              "invalid",
              "Arena manifest publication parent is linked or invalid.",
            );
          }
          await syncArenaDirectoryEntry(
            publicationParent,
            arenaDirectoryIdentity(publicationParentStat),
            "Arena manifest publication parent",
          );
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
      const layoutLine = arenaManifestLayoutLine(draft.runId);
      const layoutBytes = current.layout === "segmented-v2"
        ? 0
        : Buffer.byteLength(layoutLine, "utf8");
      const capacity = evaluateArenaManifestAppendCapacity({
        currentEvents: current.events.length,
        currentBytes: current.totalBytes + layoutBytes,
        candidateBytes: lineBytes,
        eventType: candidate.type,
        observationKind: candidate.type === "arenaMainWorkspaceObserved"
          ? (candidate.payload as {
              observationKind:
                | "monitorStarted"
                | "checkpoint"
                | "postEvidence"
                | "publicationSeal";
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
      if (candidate.type === "arenaEvidencePreserved") {
        await verifyArenaEvidencePayloadArtifacts(
          this.privateWorkspaceRoot,
          candidate.payload as ArenaEvidencePreservedPayload,
          candidate.runId,
        );
      }
      if (candidate.type === "arenaVerificationRecorded"
        || candidate.type === "arenaBrowserJourneyRecorded") {
        await verifyArenaAcceptancePayloadReceipt(
          this.privateWorkspaceRoot,
          candidate.runId,
          candidate.payload as
            | ArenaVerificationRecordedPayload
            | ArenaBrowserJourneyRecordedPayload,
        );
      }
      if (current.segmentDirectorySnapshot) {
        await assertArenaManifestSegmentDirectorySnapshot(
          runPaths.manifestSegmentsPath,
          current.segmentDirectorySnapshot,
          boundary,
        );
      }
      // The v2 layout marker makes the v1-named base unreadable to older Hydra
      // builds, so downgrade is fail-closed instead of forking from event one.
      // The base is immutable after creation. Every later authority row is a
      // separately fsynced, no-replace segment, so one append writes at most
      // maxEventBytes instead of rewriting the full bounded history. A legacy
      // v1 base is rewritten exactly once with the marker before extension.
      if (current.events.length === 0) {
        // The segment root is part of the v2 physical authority even before
        // it contains event two. Publish and parent-fsync it first so losing
        // the whole root can never masquerade as a valid base-only history.
        // A crash between these two publications is deliberately fail-closed
        // as an initialized run with no base, rather than reusable authority.
        await ensureArenaPrivateDirectory(
          boundary,
          ["runs", draft.runId, "manifest.v1.segments"],
        );
        await createArenaPrivateFile(filePath, `${layoutLine}${line}`, boundary);
      } else {
        if (current.layout === "legacy-v1") {
          const migrated = `${layoutLine}${current.events.map((event) =>
            `${canonicalArenaManifestJson(event)}\n`).join("")}`;
          await writeArenaPrivateFileAtomically(
            filePath,
            migrated,
            boundary,
          );
        }
        await ensureArenaPrivateDirectory(
          boundary,
          ["runs", draft.runId, "manifest.v1.segments"],
        );
        const segmentPath = path.join(
          runPaths.manifestSegmentsPath,
          arenaManifestSegmentName(candidate.sequence),
        );
        // loadArenaManifestHistory() has already completed the segment
        // domain's 20k-entry, identity-bound temp recovery. Repeating the
        // generic 4k parent scan here would reject healthy long histories and
        // make every append scan the directory twice.
        await createArenaPrivateFile(
          segmentPath,
          line,
          boundary,
          current.segmentDirectorySnapshot
            ? { orphanCreationTempsAlreadyRecovered: true }
            : undefined,
        );
      }
      return candidate;
    });
  }

  async load(runId: string): Promise<ArenaManifestReplay | undefined> {
    return (await this.loadWithMetrics(runId))?.replay;
  }

  async loadWithMetrics(
    runId: string,
  ): Promise<ArenaManifestLoadResult | undefined> {
    const boundary = await this.boundary();
    const runPaths = arenaRunPaths(this.privateWorkspaceRoot, runId);
    const runPath = runPaths.runPath;
    try {
      await assertArenaPrivateDirectory(runPath, boundary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const filePath = runPaths.manifestPath;
    return serializeArenaPrivateWork(boundary, filePath, async () => {
      let loaded: LoadedArenaManifestFile;
      try {
        loaded = await loadArenaManifestHistory(runPaths, boundary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          try {
            await fs.lstat(runPaths.manifestSegmentsPath);
            throw new ArenaManifestFileError(
              "invalid",
              "Arena manifest segments exist without a base manifest.",
            );
          } catch (segmentError) {
            if ((segmentError as NodeJS.ErrnoException).code !== "ENOENT") {
              throw segmentError;
            }
          }
          return undefined;
        }
        throw error;
      }
      const replay = replayArenaManifest(loaded.events);
      if (replay.runId !== runId) {
        throw new ArenaManifestFileError(
          "invalid",
          `Arena manifest path ${runId} contains run ${replay.runId}.`,
        );
      }
      await verifyArenaReplayArtifacts(this.privateWorkspaceRoot, replay);
      return Object.freeze({
        replay,
        manifestBytes: loaded.totalBytes,
      });
    });
  }

  async listRunIds(): Promise<readonly string[]> {
    const boundary = await this.boundary();
    await assertArenaPrivateDirectory(this.paths.runsPath, boundary);
    const directoryBefore = await fs.lstat(this.paths.runsPath);
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
      throw new ArenaManifestFileError(
        "invalid",
        "Arena run root is linked or invalid.",
      );
    }
    let directory: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      directory = await fs.opendir(this.paths.runsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const runIds: string[] = [];
    let scanned = 0;
    try {
      for await (const entry of directory) {
        scanned += 1;
        if (scanned > ARENA_RUN_DIRECTORY_SCAN_MAX_ENTRIES) {
          throw new ArenaManifestFileError(
            "capacity",
            "Arena run directory exceeds its bounded entry limit.",
          );
        }
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (!isPortableArenaIdentifier(entry.name)) continue;
        const candidate = exactChild(this.paths.runsPath, entry.name);
        const stat = await fs.lstat(candidate);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        runIds.push(entry.name);
      }
    } finally {
      await directory.close().catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") {
          throw error;
        }
      });
    }
    await assertArenaPrivateDirectory(this.paths.runsPath, boundary);
    const directoryAfter = await fs.lstat(this.paths.runsPath);
    if (!sameFileIdentity(directoryBefore, directoryAfter)) {
      throw new ArenaManifestFileError(
        "invalid",
        "Arena run root changed during bounded discovery.",
      );
    }
    return runIds.sort(compareUtf8).slice(0, ARENA_RUN_INDEX_MAX_ENTRIES);
  }

  private boundary(): Promise<ArenaPrivateStorageBoundary> {
    this.boundaryPromise ??= prepareArenaPrivateStorage(
      this.privateWorkspaceRoot,
    );
    return this.boundaryPromise;
  }
}

async function verifyArenaEvidencePayloadArtifacts(
  privateWorkspaceRoot: string,
  payload: ArenaEvidencePreservedPayload,
  runId: string,
): Promise<void> {
  try {
    const { verifyArenaArtifactSet } = await import("./arenaEvidence");
    await verifyArenaArtifactSet({
      privateWorkspaceRoot,
      runId,
      contestantId: payload.contestantId,
      payload,
    });
  } catch (error) {
    throw new ArenaManifestFileError(
      "invalid",
      `Arena retained evidence for ${payload.contestantId} is missing or invalid.`,
      { cause: error },
    );
  }
}

async function verifyArenaReplayArtifacts(
  privateWorkspaceRoot: string,
  replay: ArenaManifestReplay,
): Promise<void> {
  for (const contestant of replay.contestants) {
    if (!contestant.evidencePreserved) continue;
    await verifyArenaEvidencePayloadArtifacts(
      privateWorkspaceRoot,
      contestant.evidencePreserved.payload as ArenaEvidencePreservedPayload,
      replay.runId,
    );
  }
  try {
    const { verifyArenaReplayAcceptanceReceipts } = await import(
      "./arenaAcceptance"
    );
    await verifyArenaReplayAcceptanceReceipts(privateWorkspaceRoot, replay);
  } catch (error) {
    throw new ArenaManifestFileError(
      "invalid",
      "Arena acceptance receipts are missing or invalid.",
      { cause: error },
    );
  }
}

async function verifyArenaAcceptancePayloadReceipt(
  privateWorkspaceRoot: string,
  runId: string,
  payload:
    | ArenaVerificationRecordedPayload
    | ArenaBrowserJourneyRecordedPayload,
): Promise<void> {
  try {
    const { verifyArenaAcceptanceReceipt } = await import("./arenaAcceptance");
    await verifyArenaAcceptanceReceipt({
      privateWorkspaceRoot,
      runId,
      event: payload,
    });
  } catch (error) {
    throw new ArenaManifestFileError(
      "invalid",
      `Arena acceptance receipt for ${payload.contestantId} is missing or invalid.`,
      { cause: error },
    );
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
  return serializeArenaPrivateWork(
    boundary,
    store.paths.indexPath,
    async () => {
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
          const loaded = await store.loadWithMetrics(runId);
          const replay = loaded?.replay;
          manifestBytes = loaded?.manifestBytes ?? stat.size;
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
    },
  );
}

interface LoadedArenaManifestFile {
  readonly events: readonly ArenaManifestEvent[];
  readonly totalBytes: number;
  readonly layout: "missing" | "legacy-v1" | "segmented-v2";
  readonly segmentDirectorySnapshot?: ArenaManifestSegmentSnapshot;
}

interface LoadedArenaManifestRecordFile extends LoadedArenaManifestFile {
  readonly fileSnapshot: ArenaManifestSegmentEntrySnapshot;
}

export interface ArenaManifestSegmentEntrySnapshot
  extends ArenaDirectoryIdentity {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface ArenaManifestSegmentSnapshot extends ArenaDirectoryIdentity {
  readonly entries: readonly ArenaManifestSegmentEntrySnapshot[];
}

const ARENA_MANIFEST_SEGMENT_PATTERN = /^(\d{8})\.jsonl$/u;
const ARENA_MANIFEST_LAYOUT_SCHEMA_VERSION = 2;
// Each assertion deliberately checks segment metadata twice around a second
// directory enumeration. Keep those checks bounded-parallel so the 10,000
// event ceiling remains fail-closed without turning every lstat into a serial
// Windows/network-filesystem round trip.
const ARENA_MANIFEST_SEGMENT_STAT_CONCURRENCY = 32;
const ARENA_MANIFEST_SEGMENT_TEMP_PATTERN = new RegExp(
  "^\\.(\\d{8}\\.jsonl)\\.([1-9][0-9]*)-"
    + "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    + "\\.tmp$",
  process.platform === "win32" ? "i" : "",
);

function arenaManifestSegmentName(sequence: number): string {
  if (!Number.isSafeInteger(sequence)
    || sequence < 2
    || sequence > ARENA_MANIFEST_LIMITS.maxEvents) {
    throw new ArenaManifestFileError(
      "invalid",
      `Arena manifest segment sequence ${sequence} is invalid.`,
    );
  }
  return `${String(sequence).padStart(8, "0")}.jsonl`;
}

function arenaManifestLayoutLine(runId: string): string {
  return `${canonicalArenaManifestJson({
    schemaVersion: ARENA_MANIFEST_LAYOUT_SCHEMA_VERSION,
    recordType: "arenaManifestLayout",
    layout: "immutableSegments",
    eventSchemaVersion: ARENA_MANIFEST_SCHEMA_VERSION,
    runId,
  })}\n`;
}

async function loadArenaManifestHistory(
  runPaths: ArenaRunPaths,
  boundary: ArenaPrivateStorageBoundary,
): Promise<LoadedArenaManifestFile> {
  const base = await loadArenaManifestFile(
    runPaths.manifestPath,
    boundary,
    { allowLayoutHeader: true, expectedRunId: path.basename(runPaths.runPath) },
  );
  const events = [...base.events];
  let totalBytes = base.totalBytes;
  try {
    await assertArenaPrivateDirectory(runPaths.manifestSegmentsPath, boundary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (base.layout === "segmented-v2") {
        throw new ArenaManifestFileError(
          "invalid",
          "Arena segmented manifest is missing its mandatory segment root.",
          { cause: error },
        );
      }
      return replayLoadedArenaManifest(events, totalBytes, base.layout);
    }
    throw error;
  }

  let entries: Dirent[];
  let directoryBefore: Stats;
  try {
    directoryBefore = await fs.lstat(runPaths.manifestSegmentsPath);
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
      throw new ArenaManifestFileError(
        "invalid",
        "Arena manifest segment root is linked or invalid.",
      );
    }
    entries = await readBoundedArenaSegmentDirectory(
      runPaths.manifestSegmentsPath,
    );
    if (entries.some((entry) =>
      ARENA_MANIFEST_SEGMENT_TEMP_PATTERN.test(entry.name))) {
      await recoverArenaManifestSegmentTemps(
        runPaths.manifestSegmentsPath,
        entries,
        directoryBefore,
        boundary,
      );
      entries = await readBoundedArenaSegmentDirectory(
        runPaths.manifestSegmentsPath,
      );
      directoryBefore = await fs.lstat(runPaths.manifestSegmentsPath);
      if (!directoryBefore.isDirectory()
        || directoryBefore.isSymbolicLink()) {
        throw new ArenaManifestFileError(
          "invalid",
          "Arena manifest segment root changed during recovery.",
        );
      }
    }
    await assertArenaPrivateDirectory(runPaths.manifestSegmentsPath, boundary);
    const directoryAfter = await fs.lstat(runPaths.manifestSegmentsPath);
    if (!directoryAfter.isDirectory()
      || directoryAfter.isSymbolicLink()
      || !sameFileIdentity(directoryBefore, directoryAfter)) {
      throw new ArenaManifestFileError(
        "invalid",
        "Arena manifest segment root changed during discovery.",
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ArenaManifestFileError(
        "invalid",
        "Arena manifest segment root disappeared during discovery.",
        { cause: error },
      );
    }
    throw error;
  }

  if (base.layout !== "segmented-v2" && entries.length > 0) {
    throw new ArenaManifestFileError(
      "invalid",
      "Arena manifest segments require the downgrade-safe v2 layout marker.",
    );
  }

  const names = entries.map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink()
      || !ARENA_MANIFEST_SEGMENT_PATTERN.test(entry.name)) {
      throw new ArenaManifestFileError(
        "invalid",
        `Arena manifest segment entry ${entry.name} is invalid.`,
      );
    }
    return entry.name;
  }).sort(compareUtf8);
  if (events.length + names.length > ARENA_MANIFEST_LIMITS.maxEvents) {
    throw new ArenaManifestFileError(
      "eventCount",
      `Arena manifest exceeds ${ARENA_MANIFEST_LIMITS.maxEvents} events.`,
    );
  }

  const segmentEntries: ArenaManifestSegmentEntrySnapshot[] = [];
  for (const name of names) {
    const match = ARENA_MANIFEST_SEGMENT_PATTERN.exec(name)!;
    const sequence = Number.parseInt(match[1]!, 10);
    const expectedSequence = events.length + 1;
    if (sequence !== expectedSequence
      || name !== arenaManifestSegmentName(expectedSequence)) {
      throw new ArenaManifestFileError(
        "invalid",
        `Arena manifest segment ${name} is out of sequence.`,
      );
    }
    let segment: LoadedArenaManifestRecordFile;
    try {
      segment = await loadArenaManifestFile(
        path.join(runPaths.manifestSegmentsPath, name),
        boundary,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ArenaManifestFileError(
          "invalid",
          `Arena manifest segment ${name} disappeared during replay.`,
          { cause: error },
        );
      }
      throw error;
    }
    if (segment.events.length !== 1
      || segment.events[0]?.sequence !== expectedSequence) {
      throw new ArenaManifestFileError(
        "invalid",
        `Arena manifest segment ${name} must contain exactly event ${expectedSequence}.`,
      );
    }
    segmentEntries.push(segment.fileSnapshot);
    totalBytes += segment.totalBytes;
    if (totalBytes > ARENA_MANIFEST_LIMITS.maxManifestBytes) {
      throw new ArenaManifestFileError(
        "oversized",
        `Arena manifest exceeds ${ARENA_MANIFEST_LIMITS.maxManifestBytes} bytes.`,
      );
    }
    events.push(segment.events[0]);
  }
  const segmentDirectorySnapshot: ArenaManifestSegmentSnapshot = Object.freeze({
    ...arenaDirectoryIdentity(directoryBefore),
    entries: Object.freeze(segmentEntries),
  });
  await assertArenaManifestSegmentDirectorySnapshot(
    runPaths.manifestSegmentsPath,
    segmentDirectorySnapshot,
    boundary,
  );
  return replayLoadedArenaManifest(
    events,
    totalBytes,
    base.layout,
    segmentDirectorySnapshot,
  );
}

async function recoverArenaManifestSegmentTemps(
  segmentDirectory: string,
  entries: readonly Dirent[],
  expectedDirectory: Stats,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  for (const entry of entries) {
    const match = ARENA_MANIFEST_SEGMENT_TEMP_PATTERN.exec(entry.name);
    if (!match) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new ArenaManifestFileError(
        "invalid",
        `Arena manifest temporary segment ${entry.name} is linked or invalid.`,
      );
    }
    const finalName = match[1]!;
    const segmentMatch = ARENA_MANIFEST_SEGMENT_PATTERN.exec(finalName);
    const sequence = segmentMatch
      ? Number.parseInt(segmentMatch[1]!, 10)
      : 0;
    if (sequence < 2
      || sequence > ARENA_MANIFEST_LIMITS.maxEvents
      || finalName !== arenaManifestSegmentName(sequence)) {
      throw new ArenaManifestFileError(
        "invalid",
        `Arena manifest temporary segment ${entry.name} has an invalid sequence.`,
      );
    }
    const publisherPid = Number(match[2]);
    if (!Number.isSafeInteger(publisherPid)
      || publisherPid <= 0
      || publisherPid > 0x7fff_ffff
      || !isProcessDefinitelyGone(publisherPid)) {
      throw new ArenaManifestFileError(
        "invalid",
        `Arena manifest temporary segment ${entry.name} has a live or ambiguous publisher.`,
      );
    }

    const temporaryPath = path.join(segmentDirectory, entry.name);
    const finalPath = path.join(segmentDirectory, finalName);
    const temporaryBefore = await fs.lstat(temporaryPath);
    assertManifestFilePermissions(temporaryBefore, temporaryPath);
    if (!temporaryBefore.isFile()
      || temporaryBefore.isSymbolicLink()
      || (temporaryBefore.nlink !== 1 && temporaryBefore.nlink !== 2)) {
      throw new ArenaManifestFileError(
        "invalid",
        `Arena manifest temporary segment ${entry.name} is unsafe.`,
      );
    }

    let finalEntry: Stats | undefined;
    try {
      finalEntry = await fs.lstat(finalPath);
      assertManifestFilePermissions(finalEntry, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (finalEntry && sameFileIdentity(temporaryBefore, finalEntry)) {
      if (!finalEntry.isFile()
        || finalEntry.isSymbolicLink()
        || finalEntry.nlink !== 2
        || temporaryBefore.nlink !== 2) {
        throw new ArenaManifestFileError(
          "invalid",
          `Arena manifest committed segment ${finalName} is ambiguously linked.`,
        );
      }
      await assertArenaManifestSegmentDirectory(
        segmentDirectory,
        expectedDirectory,
        boundary,
      );
      const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
        ? fsConstants.O_NOFOLLOW
        : 0;
      const handle = await fs.open(
        finalPath,
        fsConstants.O_RDONLY | noFollow,
      );
      try {
        const [opened, currentFinal, currentTemporary] = await Promise.all([
          handle.stat(),
          fs.lstat(finalPath),
          fs.lstat(temporaryPath),
        ]);
        assertManifestFilePermissions(opened, finalPath);
        assertManifestFilePermissions(currentFinal, finalPath);
        assertManifestFilePermissions(currentTemporary, temporaryPath);
        if (!opened.isFile()
          || opened.isSymbolicLink()
          || opened.nlink !== 2
          || opened.size > ARENA_MANIFEST_LIMITS.maxEventBytes
          || !sameFileIdentity(finalEntry, opened)
          || !sameFileIdentity(opened, currentFinal)
          || !sameFileIdentity(currentFinal, currentTemporary)) {
          throw new ArenaManifestFileError(
            "invalid",
            `Arena manifest committed segment ${finalName} changed during recovery.`,
          );
        }
        await assertArenaManifestSegmentDirectory(
          segmentDirectory,
          expectedDirectory,
          boundary,
        );
        await fs.unlink(temporaryPath);
        await syncArenaDirectoryEntry(
          segmentDirectory,
          arenaDirectoryIdentity(expectedDirectory),
          "Arena manifest segment directory",
        );
        const [after, recovered] = await Promise.all([
          handle.stat(),
          fs.lstat(finalPath),
        ]);
        assertManifestFilePermissions(after, finalPath);
        assertManifestFilePermissions(recovered, finalPath);
        if (!after.isFile()
          || after.isSymbolicLink()
          || after.nlink !== 1
          || !sameFileIdentity(opened, after)
          || !sameFileIdentity(after, recovered)) {
          throw new ArenaManifestFileError(
            "invalid",
            `Arena manifest committed segment ${finalName} changed after recovery.`,
          );
        }
      } finally {
        await handle.close();
      }
      continue;
    }
    if (finalEntry && (finalEntry.isSymbolicLink()
      || !finalEntry.isFile()
      || finalEntry.nlink !== 1)) {
      throw new ArenaManifestFileError(
        "invalid",
        `Arena manifest segment ${finalName} is linked or invalid.`,
      );
    }

    let temporaryCurrent: Stats;
    try {
      temporaryCurrent = await fs.lstat(temporaryPath);
      assertManifestFilePermissions(temporaryCurrent, temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!temporaryCurrent.isFile()
      || temporaryCurrent.isSymbolicLink()
      || temporaryCurrent.nlink !== 1
      || !sameFileIdentity(temporaryBefore, temporaryCurrent)) {
      throw new ArenaManifestFileError(
        "invalid",
        `Arena manifest temporary segment ${entry.name} changed during recovery.`,
      );
    }
    await assertArenaManifestSegmentDirectory(
      segmentDirectory,
      expectedDirectory,
      boundary,
    );
    await fs.unlink(temporaryPath);
    await syncArenaDirectoryEntry(
      segmentDirectory,
      arenaDirectoryIdentity(expectedDirectory),
      "Arena manifest segment directory",
    );
  }
}

async function readBoundedArenaSegmentDirectory(
  segmentDirectory: string,
): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  const directory = await fs.opendir(segmentDirectory);
  try {
    for await (const entry of directory) {
      if (entries.length >= ARENA_MANIFEST_LIMITS.maxEvents * 2) {
        throw new ArenaManifestFileError(
          "eventCount",
          "Arena manifest segment directory exceeds its bounded entry limit.",
        );
      }
      entries.push(entry);
    }
  } finally {
    await directory.close().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") {
        throw error;
      }
    });
  }
  return entries;
}

async function assertArenaManifestSegmentDirectory(
  segmentDirectory: string,
  expected: Stats,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  let current: Stats;
  try {
    await assertArenaPrivateDirectory(segmentDirectory, boundary);
    current = await fs.lstat(segmentDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ArenaManifestFileError(
        "invalid",
        "Arena manifest segment root disappeared during replay.",
        { cause: error },
      );
    }
    throw error;
  }
  if (!current.isDirectory()
    || current.isSymbolicLink()
    || !sameFileIdentity(expected, current)) {
    throw new ArenaManifestFileError(
      "invalid",
      "Arena manifest segment root changed during recovery.",
    );
  }
}

async function assertArenaManifestSegmentDirectorySnapshot(
  segmentDirectory: string,
  expected: ArenaManifestSegmentSnapshot,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  let current: ArenaManifestSegmentSnapshot;
  try {
    current = await captureArenaManifestSegmentSnapshot(
      segmentDirectory,
      boundary,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ArenaManifestFileError(
        "invalid",
        "Arena manifest segment root or entry disappeared during replay.",
        { cause: error },
      );
    }
    throw error;
  }
  if (!arenaManifestSegmentSnapshotMatches(expected, current)) {
    throw new ArenaManifestFileError(
      "invalid",
      "Arena manifest segment root or entries changed during replay.",
    );
  }
}

async function captureArenaManifestSegmentSnapshot(
  segmentDirectory: string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<ArenaManifestSegmentSnapshot> {
  await assertArenaPrivateDirectory(segmentDirectory, boundary);
  const directoryBefore = await fs.lstat(segmentDirectory);
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
    throw new ArenaManifestFileError(
      "invalid",
      "Arena manifest segment root is linked or invalid.",
    );
  }
  const names = arenaManifestSegmentEntryNames(
    await readBoundedArenaSegmentDirectory(segmentDirectory),
  );
  const snapshots = await captureArenaManifestSegmentEntrySnapshots(
    segmentDirectory,
    names,
  );

  const namesAfter = arenaManifestSegmentEntryNames(
    await readBoundedArenaSegmentDirectory(segmentDirectory),
  );
  if (!sameArenaManifestSegmentNames(names, namesAfter)) {
    throw new ArenaManifestFileError(
      "invalid",
      "Arena manifest segment entries changed during snapshot capture.",
    );
  }
  const snapshotsAfter = await captureArenaManifestSegmentEntrySnapshots(
    segmentDirectory,
    namesAfter,
  );
  for (const [index, snapshot] of snapshots.entries()) {
    const current = snapshotsAfter[index];
    if (current === undefined
      || !arenaManifestSegmentEntrySnapshotMatches(snapshot, current)) {
      throw new ArenaManifestFileError(
        "invalid",
        `Arena manifest segment ${snapshot.name} changed during snapshot capture.`,
      );
    }
  }
  await assertArenaPrivateDirectory(segmentDirectory, boundary);
  const directoryAfter = await fs.lstat(segmentDirectory);
  if (!directoryAfter.isDirectory()
    || directoryAfter.isSymbolicLink()
    || !sameFileIdentity(directoryBefore, directoryAfter)) {
    throw new ArenaManifestFileError(
      "invalid",
      "Arena manifest segment root changed during snapshot capture.",
    );
  }
  return Object.freeze({
    ...arenaDirectoryIdentity(directoryAfter),
    entries: Object.freeze(snapshots),
  });
}

async function captureArenaManifestSegmentEntrySnapshots(
  segmentDirectory: string,
  names: readonly string[],
): Promise<ArenaManifestSegmentEntrySnapshot[]> {
  const snapshots: ArenaManifestSegmentEntrySnapshot[] = [];
  for (let offset = 0;
    offset < names.length;
    offset += ARENA_MANIFEST_SEGMENT_STAT_CONCURRENCY) {
    const chunk = await Promise.all(
      names.slice(
        offset,
        offset + ARENA_MANIFEST_SEGMENT_STAT_CONCURRENCY,
      ).map(async (name) => {
        const filePath = path.join(segmentDirectory, name);
        const stat = await fs.lstat(filePath);
        assertSafeManifestFile(stat, filePath);
        return arenaManifestSegmentEntrySnapshot(name, stat);
      }),
    );
    snapshots.push(...chunk);
  }
  return snapshots;
}

function arenaManifestSegmentEntryNames(entries: readonly Dirent[]): string[] {
  return entries.map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink()
      || !ARENA_MANIFEST_SEGMENT_PATTERN.test(entry.name)) {
      throw new ArenaManifestFileError(
        "invalid",
        `Arena manifest segment entry ${entry.name} is invalid.`,
      );
    }
    return entry.name;
  }).sort(compareUtf8);
}

function sameArenaManifestSegmentNames(
  expected: readonly string[],
  actual: readonly string[],
): boolean {
  return expected.length === actual.length
    && expected.every((name, index) => name === actual[index]);
}

function arenaDirectoryIdentity(stat: Stats): ArenaDirectoryIdentity {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function arenaManifestSegmentEntrySnapshot(
  name: string,
  stat: Stats,
): ArenaManifestSegmentEntrySnapshot {
  return Object.freeze({
    name,
    ...arenaDirectoryIdentity(stat),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
}

function arenaManifestSegmentEntrySnapshotMatches(
  expected: ArenaManifestSegmentEntrySnapshot,
  actual: ArenaManifestSegmentEntrySnapshot,
): boolean {
  return String(expected.dev) === String(actual.dev)
    && String(expected.ino) === String(actual.ino)
    && expected.name === actual.name
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs;
}

export function arenaManifestSegmentSnapshotMatches(
  expected: ArenaManifestSegmentSnapshot,
  actual: ArenaManifestSegmentSnapshot,
): boolean {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.entries.length === actual.entries.length
    && expected.entries.every((entry, index) => {
      const other = actual.entries[index];
      return other !== undefined
        && arenaManifestSegmentEntrySnapshotMatches(entry, other);
    });
}

function isProcessDefinitelyGone(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function replayLoadedArenaManifest(
  events: readonly ArenaManifestEvent[],
  totalBytes: number,
  layout: LoadedArenaManifestFile["layout"],
  segmentDirectorySnapshot?: ArenaManifestSegmentSnapshot,
): LoadedArenaManifestFile {
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
  return {
    events,
    totalBytes,
    layout,
    ...(segmentDirectorySnapshot ? { segmentDirectorySnapshot } : {}),
  };
}

async function loadArenaManifestFile(
  filePath: string,
  boundary: ArenaPrivateStorageBoundary,
  options: {
    readonly allowLayoutHeader?: boolean;
    readonly expectedRunId?: string;
  } = {},
): Promise<LoadedArenaManifestRecordFile> {
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
  let layout: LoadedArenaManifestFile["layout"] = "legacy-v1";
  let eventLines = lines;
  if (options.allowLayoutHeader
    && Buffer.byteLength(`${lines[0] ?? ""}\n`, "utf8")
      > ARENA_MANIFEST_LIMITS.maxEventBytes) {
    throw new ArenaManifestFileError(
      "oversized",
      "Arena manifest first line exceeds the per-record byte limit.",
    );
  }
  if (options.allowLayoutHeader
    && isArenaManifestLayoutHeaderLine(lines[0], options.expectedRunId)) {
    layout = "segmented-v2";
    eventLines = lines.slice(1);
    if (eventLines.length === 0) {
      throw new ArenaManifestFileError(
        "invalid",
        "Arena segmented manifest has no authority events.",
      );
    }
  }
  if (eventLines.length > ARENA_MANIFEST_LIMITS.maxEvents) {
    throw new ArenaManifestFileError(
      "eventCount",
      `Arena manifest exceeds ${ARENA_MANIFEST_LIMITS.maxEvents} events.`,
    );
  }
  const events: ArenaManifestEvent[] = [];
  for (const [index, line] of eventLines.entries()) {
    if (!line) {
      throw new ArenaManifestFileError(
        "blankLine",
        `Arena manifest event line ${index + 1} is blank.`,
      );
    }
    if (Buffer.byteLength(`${line}\n`, "utf8")
      > ARENA_MANIFEST_LIMITS.maxEventBytes) {
      throw new ArenaManifestFileError(
        "oversized",
        `Arena manifest event line ${index + 1} is oversized.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new ArenaManifestFileError(
        "malformed",
        `Arena manifest event line ${index + 1} is malformed JSON.`,
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
        `Arena manifest event line ${index + 1} has an unknown schema version.`,
      );
    }
    if (!isArenaManifestEvent(parsed)) {
      throw new ArenaManifestFileError(
        "invalid",
        `Arena manifest event line ${index + 1} has an invalid event shape or hash.`,
      );
    }
    if (line !== canonicalArenaManifestJson(parsed)) {
      throw new ArenaManifestFileError(
        "nonCanonical",
        `Arena manifest event line ${index + 1} is not canonical hydra.arena.v1 JSON.`,
      );
    }
    events.push(parsed);
  }
  return {
    events,
    totalBytes: file.totalBytes,
    layout,
    fileSnapshot: file.fileSnapshot,
  };
}

function isArenaManifestLayoutHeaderLine(
  line: string | undefined,
  expectedRunId: string | undefined,
): boolean {
  if (!line) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const value = parsed as Record<string, unknown>;
  if (value.schemaVersion !== ARENA_MANIFEST_LAYOUT_SCHEMA_VERSION
    && value.recordType !== "arenaManifestLayout") {
    return false;
  }
  const expectedKeys = [
    "eventSchemaVersion",
    "layout",
    "recordType",
    "runId",
    "schemaVersion",
  ];
  const actualKeys = Object.keys(value).sort(compareUtf8);
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || value.schemaVersion !== ARENA_MANIFEST_LAYOUT_SCHEMA_VERSION
    || value.recordType !== "arenaManifestLayout"
    || value.layout !== "immutableSegments"
    || value.eventSchemaVersion !== ARENA_MANIFEST_SCHEMA_VERSION
    || typeof value.runId !== "string"
    || value.runId !== expectedRunId
    || !isPortableArenaIdentifier(value.runId)) {
    throw new ArenaManifestFileError(
      "invalid",
      "Arena manifest layout header is invalid or path-mismatched.",
    );
  }
  if (line !== canonicalArenaManifestJson(value)) {
    throw new ArenaManifestFileError(
      "nonCanonical",
      "Arena manifest layout header is not canonical JSON.",
    );
  }
  return true;
}

async function readArenaManifestBytes(
  filePath: string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<{
  readonly bytes: Buffer;
  readonly totalBytes: number;
  readonly fileSnapshot: ArenaManifestSegmentEntrySnapshot;
}> {
  await assertArenaPrivateParent(filePath, boundary);
  const before = await fs.lstat(filePath);
  assertSafeManifestFile(before, filePath);
  const beforeSnapshot = arenaManifestSegmentEntrySnapshot(
    path.basename(filePath),
    before,
  );
  if (before.size > ARENA_MANIFEST_LIMITS.maxManifestBytes) {
    return {
      bytes: Buffer.alloc(0),
      totalBytes: before.size,
      fileSnapshot: beforeSnapshot,
    };
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
    const openedSnapshot = arenaManifestSegmentEntrySnapshot(
      path.basename(filePath),
      opened,
    );
    if (!arenaManifestSegmentEntrySnapshotMatches(
      beforeSnapshot,
      openedSnapshot,
    )) {
      throw new Error(`Refusing to read Arena manifest after path swap: ${filePath}`);
    }
    if (opened.size > ARENA_MANIFEST_LIMITS.maxManifestBytes) {
      return {
        bytes: Buffer.alloc(0),
        totalBytes: opened.size,
        fileSnapshot: openedSnapshot,
      };
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
    const afterSnapshot = arenaManifestSegmentEntrySnapshot(
      path.basename(filePath),
      after,
    );
    if (!arenaManifestSegmentEntrySnapshotMatches(
      openedSnapshot,
      afterSnapshot,
    )
      || offset !== opened.size) {
      throw new Error(`Refusing to read Arena manifest during mutation: ${filePath}`);
    }
    return {
      bytes: bytes.subarray(0, offset),
      totalBytes: opened.size,
      fileSnapshot: afterSnapshot,
    };
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
    | "publicationSeal"
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
      && observationKind === "publicationSeal")
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
  if (!isPortableArenaIdentifier(value)) {
    throw new Error(`Arena ${label} is not safe for private storage.`);
  }
}

function isPortableArenaIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value)
    && !value.endsWith(".")
    && !WINDOWS_DEVICE_BASENAME_PATTERN.test(value);
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
  assertManifestFilePermissions(stat, filePath);
}

function assertManifestFilePermissions(stat: Stats, filePath: string): void {
  if (process.platform !== "win32"
    && ((stat.mode & 0o077) !== 0
      || (typeof process.getuid === "function"
        && stat.uid !== process.getuid()))) {
    throw new Error(
      `Refusing Arena manifest with unsafe ownership or permissions: ${filePath}`,
    );
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
