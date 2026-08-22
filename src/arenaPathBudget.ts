import { createHash } from "node:crypto";
import * as path from "node:path";
import { TextDecoder } from "node:util";

export const ARENA_WINDOWS_MAX_PATH_UTF16_UNITS = 260;
export const ARENA_WINDOWS_PATH_SAFETY_MARGIN_UTF16_UNITS = 12;
export const ARENA_TRACKED_PATHS_MAX_BYTES = 16 * 1024 * 1024;
export const ARENA_TRACKED_PATHS_MAX_RECORDS = 100_000;
export const ARENA_TRACKED_PATH_MAX_BYTES = 4_096;
export const ARENA_PHYSICAL_WORKTREE_HASH_HEX_LENGTH = 32;

const ARENA_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:\\$/;
const WINDOWS_FORBIDDEN_CHARACTER_PATTERN = /[<>:"\\|?*\u0000-\u001f]/u;
const WINDOWS_RESERVED_COMPONENT_PATTERN =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export type ArenaPathBudgetErrorCode =
  | "invalidIdentifier"
  | "invalidOptions"
  | "invalidTargetPath"
  | "trackedPathsOversized"
  | "trackedPathsUnterminated"
  | "trackedPathEmpty"
  | "trackedPathOversized"
  | "trackedPathCount"
  | "trackedPathMalformedUtf8"
  | "trackedPathInvalid";

export class ArenaPathBudgetError extends Error {
  constructor(
    readonly code: ArenaPathBudgetErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArenaPathBudgetError";
  }
}

export interface ArenaTrackedPathSummary {
  readonly trackedPathCount: number;
  readonly trackedPathsBytes: number;
  readonly trackedPathsSha256: string;
  readonly longestTrackedPathUtf8Bytes: number | null;
  readonly longestTrackedPathUtf16Units: number | null;
}

export interface ArenaPathBudgetOptions {
  /**
   * Tests may override the runtime platform. Production callers should omit it.
   */
  readonly platform?: NodeJS.Platform;
  /**
   * Additional UTF-16 code units reserved below MAX_PATH. The terminating NUL
   * is counted separately and is not part of this margin.
   */
  readonly safetyMarginUtf16Units?: number;
}

export type ArenaPathBudgetReason =
  | "notWindows"
  | "withinBudget"
  | "gitMetadataPathTooLong"
  | "trackedPathTooLong";

/**
 * Deliberately contains no target or tracked path text.
 */
export interface ArenaPathBudgetReport extends ArenaTrackedPathSummary {
  readonly schemaVersion: 1;
  readonly platform: NodeJS.Platform;
  readonly applies: boolean;
  readonly accepted: boolean;
  readonly reason: ArenaPathBudgetReason;
  readonly maxPathUtf16Units: typeof ARENA_WINDOWS_MAX_PATH_UTF16_UNITS;
  readonly safetyMarginUtf16Units: number;
  readonly targetPathUtf16Units: number;
  readonly gitMetadataPathUtf16UnitsWithTerminator: number;
  readonly longestTrackedPathUtf16UnitsWithTerminator: number | null;
  readonly worstCaseUtf16UnitsWithMargin: number;
}

/**
 * Maps logical Arena identity to a short, non-secret-bearing physical path
 * segment. The domain and length framing make the mapping stable and
 * unambiguous if arenaStore later adopts it.
 */
export function arenaPhysicalWorktreeSegment(
  runId: string,
  contestantId: string,
): string {
  assertArenaIdentifier(runId);
  assertArenaIdentifier(contestantId);
  const digest = createHash("sha256");
  digest.update("hydra:arena:physical-worktree-segment:v1\0", "utf8");
  updateLengthFramedUtf8(digest, runId);
  updateLengthFramedUtf8(digest, contestantId);
  return `w-${digest.digest("hex").slice(
    0,
    ARENA_PHYSICAL_WORKTREE_HASH_HEX_LENGTH,
  )}`;
}

/**
 * Strictly parses `git ls-files -z` output into redacted aggregate metadata.
 * Non-empty input must end in NUL and empty records are never accepted.
 */
export function parseArenaTrackedPathsZ(
  trackedPathsZ: Uint8Array,
  options: Pick<ArenaPathBudgetOptions, "platform"> = {},
): ArenaTrackedPathSummary {
  const platform = options.platform ?? process.platform;
  if (trackedPathsZ.byteLength > ARENA_TRACKED_PATHS_MAX_BYTES) {
    throw new ArenaPathBudgetError(
      "trackedPathsOversized",
      "Arena tracked-path output exceeded its byte limit.",
    );
  }

  const raw = Buffer.from(
    trackedPathsZ.buffer,
    trackedPathsZ.byteOffset,
    trackedPathsZ.byteLength,
  );
  const trackedPathsSha256 = createHash("sha256").update(raw).digest("hex");
  if (raw.byteLength === 0) {
    return {
      trackedPathCount: 0,
      trackedPathsBytes: 0,
      trackedPathsSha256,
      longestTrackedPathUtf8Bytes: null,
      longestTrackedPathUtf16Units: null,
    };
  }
  if (raw.at(-1) !== 0) {
    throw new ArenaPathBudgetError(
      "trackedPathsUnterminated",
      "Arena tracked-path output was not NUL terminated.",
    );
  }

  let recordStart = 0;
  let trackedPathCount = 0;
  let longestTrackedPathUtf8Bytes: number | null = null;
  let longestTrackedPathUtf16Units: number | null = null;
  for (let cursor = 0; cursor < raw.byteLength; cursor += 1) {
    if (raw[cursor] !== 0) continue;
    const recordBytes = cursor - recordStart;
    trackedPathCount += 1;
    if (trackedPathCount > ARENA_TRACKED_PATHS_MAX_RECORDS) {
      throw new ArenaPathBudgetError(
        "trackedPathCount",
        "Arena tracked-path output exceeded its record limit.",
      );
    }
    if (recordBytes === 0) {
      throw new ArenaPathBudgetError(
        "trackedPathEmpty",
        `Arena tracked-path record ${trackedPathCount} was empty.`,
      );
    }
    if (recordBytes > ARENA_TRACKED_PATH_MAX_BYTES) {
      throw new ArenaPathBudgetError(
        "trackedPathOversized",
        `Arena tracked-path record ${trackedPathCount} exceeded its byte limit.`,
      );
    }

    let trackedPath: string;
    try {
      trackedPath = UTF8_DECODER.decode(raw.subarray(recordStart, cursor));
    } catch (error) {
      throw new ArenaPathBudgetError(
        "trackedPathMalformedUtf8",
        `Arena tracked-path record ${trackedPathCount} was not valid UTF-8.`,
        { cause: error },
      );
    }
    assertTrackedPath(trackedPath, trackedPathCount, platform);

    const utf16Units = trackedPath.length;
    if (
      longestTrackedPathUtf16Units === null
      || utf16Units > longestTrackedPathUtf16Units
      || (
        utf16Units === longestTrackedPathUtf16Units
        && recordBytes > (longestTrackedPathUtf8Bytes ?? -1)
      )
    ) {
      longestTrackedPathUtf16Units = utf16Units;
      longestTrackedPathUtf8Bytes = recordBytes;
    }
    recordStart = cursor + 1;
  }

  return {
    trackedPathCount,
    trackedPathsBytes: raw.byteLength,
    trackedPathsSha256,
    longestTrackedPathUtf8Bytes,
    longestTrackedPathUtf16Units,
  };
}

/**
 * Performs a conservative legacy-Windows MAX_PATH check. Counts UTF-16 code
 * units, the terminating NUL, and an explicit safety margin for both
 * `<target>/.git` and `<target>/<longest tracked path>`.
 */
export function preflightArenaWorktreePathBudget(
  targetPath: string,
  trackedPathsZ: Uint8Array,
  options: ArenaPathBudgetOptions = {},
): ArenaPathBudgetReport {
  const platform = options.platform ?? process.platform;
  const safetyMarginUtf16Units = options.safetyMarginUtf16Units
    ?? ARENA_WINDOWS_PATH_SAFETY_MARGIN_UTF16_UNITS;
  if (
    !Number.isSafeInteger(safetyMarginUtf16Units)
    || safetyMarginUtf16Units < 0
    || safetyMarginUtf16Units >= ARENA_WINDOWS_MAX_PATH_UTF16_UNITS
  ) {
    throw new ArenaPathBudgetError(
      "invalidOptions",
      "Arena path safety margin was invalid.",
    );
  }

  assertTargetPath(targetPath, platform);
  const tracked = parseArenaTrackedPathsZ(trackedPathsZ, { platform });
  const targetPathUtf16Units = targetPath.length;
  const separatorUtf16Units = 1;
  const terminatingNulUtf16Units = 1;
  const gitMetadataPathUtf16UnitsWithTerminator =
    targetPathUtf16Units
    + separatorUtf16Units
    + ".git".length
    + terminatingNulUtf16Units;
  const longestTrackedPathUtf16UnitsWithTerminator =
    tracked.longestTrackedPathUtf16Units === null
      ? null
      : targetPathUtf16Units
        + separatorUtf16Units
        + tracked.longestTrackedPathUtf16Units
        + terminatingNulUtf16Units;
  const worstCandidate = Math.max(
    gitMetadataPathUtf16UnitsWithTerminator,
    longestTrackedPathUtf16UnitsWithTerminator ?? 0,
  );
  const worstCaseUtf16UnitsWithMargin =
    worstCandidate + safetyMarginUtf16Units;

  let reason: ArenaPathBudgetReason;
  let applies: boolean;
  let accepted: boolean;
  if (platform !== "win32") {
    reason = "notWindows";
    applies = false;
    accepted = true;
  } else if (
    gitMetadataPathUtf16UnitsWithTerminator + safetyMarginUtf16Units
    > ARENA_WINDOWS_MAX_PATH_UTF16_UNITS
  ) {
    reason = "gitMetadataPathTooLong";
    applies = true;
    accepted = false;
  } else if (
    longestTrackedPathUtf16UnitsWithTerminator !== null
    && longestTrackedPathUtf16UnitsWithTerminator
      + safetyMarginUtf16Units
      > ARENA_WINDOWS_MAX_PATH_UTF16_UNITS
  ) {
    reason = "trackedPathTooLong";
    applies = true;
    accepted = false;
  } else {
    reason = "withinBudget";
    applies = true;
    accepted = true;
  }

  return {
    schemaVersion: 1,
    platform,
    applies,
    accepted,
    reason,
    maxPathUtf16Units: ARENA_WINDOWS_MAX_PATH_UTF16_UNITS,
    safetyMarginUtf16Units,
    targetPathUtf16Units,
    gitMetadataPathUtf16UnitsWithTerminator,
    longestTrackedPathUtf16UnitsWithTerminator,
    worstCaseUtf16UnitsWithMargin,
    ...tracked,
  };
}

function assertArenaIdentifier(value: string): void {
  if (!ARENA_IDENTIFIER_PATTERN.test(value)) {
    throw new ArenaPathBudgetError(
      "invalidIdentifier",
      "Arena physical path identity was invalid.",
    );
  }
}

function updateLengthFramedUtf8(
  digest: ReturnType<typeof createHash>,
  value: string,
): void {
  const encoded = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(encoded.byteLength);
  digest.update(length);
  digest.update(encoded);
}

function assertTargetPath(
  targetPath: string,
  platform: NodeJS.Platform,
): void {
  if (
    typeof targetPath !== "string"
    || targetPath.length === 0
    || /[\u0000-\u001f]/u.test(targetPath)
  ) {
    invalidTarget();
  }

  if (platform === "win32") {
    if (
      targetPath.includes("/")
      || targetPath.startsWith("\\\\")
      || targetPath.startsWith("\\\\?\\")
      || !path.win32.isAbsolute(targetPath)
    ) {
      invalidTarget();
    }
    const parsed = path.win32.parse(targetPath);
    if (
      !WINDOWS_DRIVE_ROOT_PATTERN.test(parsed.root)
      || targetPath === parsed.root
      || path.win32.normalize(targetPath) !== targetPath
      || targetPath.endsWith("\\")
    ) {
      invalidTarget();
    }
    const relative = targetPath.slice(parsed.root.length);
    for (const component of relative.split("\\")) {
      assertWindowsComponent(component, undefined);
    }
    return;
  }

  if (
    !path.posix.isAbsolute(targetPath)
    || targetPath === "/"
    || path.posix.normalize(targetPath) !== targetPath
    || targetPath.endsWith("/")
  ) {
    invalidTarget();
  }
}

function assertTrackedPath(
  trackedPath: string,
  recordNumber: number,
  platform: NodeJS.Platform,
): void {
  if (
    trackedPath.length === 0
    || trackedPath.startsWith("/")
    || trackedPath.endsWith("/")
    || trackedPath.includes("\\")
    || /^[A-Za-z]:/u.test(trackedPath)
  ) {
    invalidTrackedPath(recordNumber);
  }
  const components = trackedPath.split("/");
  if (
    components.some((component) =>
      component.length === 0 || component === "." || component === "..")
  ) {
    invalidTrackedPath(recordNumber);
  }
  if (platform === "win32") {
    for (const component of components) {
      assertWindowsComponent(component, recordNumber);
    }
  }
}

function assertWindowsComponent(
  component: string,
  recordNumber: number | undefined,
): void {
  if (
    component.length === 0
    || component === "."
    || component === ".."
    || WINDOWS_FORBIDDEN_CHARACTER_PATTERN.test(component)
    || component.endsWith(".")
    || component.endsWith(" ")
    || WINDOWS_RESERVED_COMPONENT_PATTERN.test(component)
  ) {
    if (recordNumber === undefined) invalidTarget();
    invalidTrackedPath(recordNumber);
  }
}

function invalidTarget(): never {
  throw new ArenaPathBudgetError(
    "invalidTargetPath",
    "Arena worktree target path was invalid.",
  );
}

function invalidTrackedPath(recordNumber: number): never {
  throw new ArenaPathBudgetError(
    "trackedPathInvalid",
    `Arena tracked-path record ${recordNumber} was invalid.`,
  );
}
