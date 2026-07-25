import { createHash } from "node:crypto";
import { type Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import {
  assertArenaPrivateDirectory,
  createArenaPrivateFile,
  ensureArenaPrivateDirectory,
  prepareArenaPrivateStorage,
  readArenaPrivateFile,
  serializeArenaPrivateWork,
  type ArenaPrivateStorageBoundary,
} from "./arenaPrivateStorage";
import {
  arenaContestantWorktreePath,
  arenaRunPaths,
} from "./arenaStore";
import {
  canonicalArenaManifestJson,
  type ArenaGitObjectFormat,
  type ArenaGitObjectId,
} from "./arenaRunManifest";

export const ARENA_WORKTREE_REGISTRATION_SCHEMA_VERSION = 1 as const;
export const ARENA_WORKTREE_REGISTRATION_MAX_BYTES = 32 * 1024;
export const ARENA_WORKTREE_REGISTRATION_MAX_CONTESTANTS = 8;

const INTENT_HASH_DOMAIN =
  "hydra.arena.worktree-registration-intent.v1\u0000";
const RECEIPT_HASH_DOMAIN =
  "hydra.arena.worktree-registration-receipt.v1\u0000";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface ArenaWorktreeRegistrationIntentDraft {
  readonly intentId: string;
  readonly runId: string;
  readonly contestantId: string;
  readonly worktreeId: string;
  readonly occurredAt: string;
  readonly sourceDirectoryIdentitySha256: string;
  readonly repositoryIdentitySha256: string;
  readonly repositoryControlSha256: string;
  readonly repositoryStaticControlSha256: string;
  readonly worktreeRegistrySha256: string;
  readonly baseRevision: ArenaGitObjectId;
  readonly baseContentSha256: string;
  readonly worktreePath: string;
  readonly lockReason: string;
}

export interface ArenaWorktreeRegistrationIntent
  extends ArenaWorktreeRegistrationIntentDraft {
  readonly schemaVersion:
    typeof ARENA_WORKTREE_REGISTRATION_SCHEMA_VERSION;
  readonly recordType: "worktreeRegistrationIntent";
  readonly intentSha256: string;
}

export interface ArenaWorktreeRegistrationReceiptDraft {
  readonly intentSha256: string;
  readonly runId: string;
  readonly contestantId: string;
  readonly worktreeId: string;
  readonly registeredAt: string;
  readonly realWorktreePathSha256: string;
  readonly directoryIdentitySha256: string;
  readonly gitRegistrationSha256: string;
  readonly head: ArenaGitObjectId;
  readonly initialFingerprintSha256: string;
}

export interface ArenaWorktreeRegistrationReceipt
  extends ArenaWorktreeRegistrationReceiptDraft {
  readonly schemaVersion:
    typeof ARENA_WORKTREE_REGISTRATION_SCHEMA_VERSION;
  readonly recordType: "worktreeRegistrationReceipt";
  readonly registrationSha256: string;
}

export interface ArenaWorktreeRegistrationState {
  readonly intent: ArenaWorktreeRegistrationIntent;
  readonly receipt?: ArenaWorktreeRegistrationReceipt;
}

export interface ArenaWorktreeRegistrationPaths {
  readonly registrationPath: string;
  readonly intentPath: string;
  readonly receiptPath: string;
  readonly leasePath: string;
  readonly operationLeasePath: string;
}

export class ArenaWorktreeRegistrationError extends Error {
  constructor(
    readonly code:
      | "invalid"
      | "collision"
      | "missingIntent"
      | "mismatch"
      | "capacity",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArenaWorktreeRegistrationError";
  }
}

export class FileArenaWorktreeRegistrationStore {
  private boundaryPromise: Promise<ArenaPrivateStorageBoundary> | undefined;

  constructor(readonly privateWorkspaceRoot: string) {}

  async plan(
    draft: ArenaWorktreeRegistrationIntentDraft,
  ): Promise<ArenaWorktreeRegistrationIntent> {
    const [intent] = await this.planMany([draft]);
    if (!intent) {
      throw new ArenaWorktreeRegistrationError(
        "invalid",
        "Arena failed to create its registration intent.",
      );
    }
    return intent;
  }

  async planMany(
    drafts: readonly ArenaWorktreeRegistrationIntentDraft[],
  ): Promise<readonly ArenaWorktreeRegistrationIntent[]> {
    if (drafts.length === 0
      || drafts.length > ARENA_WORKTREE_REGISTRATION_MAX_CONTESTANTS) {
      throw new ArenaWorktreeRegistrationError(
        "capacity",
        "Arena registration planning requires between one and eight contestants.",
      );
    }
    const runId = drafts[0]!.runId;
    if (drafts.some((draft) => draft.runId !== runId)) {
      throw new ArenaWorktreeRegistrationError(
        "invalid",
        "Arena registration batches must belong to one run.",
      );
    }
    const boundary = await this.boundary();
    await ensureArenaPrivateDirectory(
      boundary,
      ["registrations", runId],
    );
    const runLeaseIdentity = path.join(
      boundary.logicalRoot,
      "registrations",
      runId,
      "plan.v1",
    );
    return serializeArenaPrivateWork(
      boundary,
      runLeaseIdentity,
      async () => {
        const requested = drafts.map((draft) =>
          createArenaWorktreeRegistrationIntent(
            draft,
            this.privateWorkspaceRoot,
          ));
        const requestedContestants = new Set<string>();
        for (const intent of requested) {
          if (requestedContestants.has(intent.contestantId)) {
            throw new ArenaWorktreeRegistrationError(
              "collision",
              "Arena registration batch duplicates a contestant.",
            );
          }
          requestedContestants.add(intent.contestantId);
        }
        const existing = await this.listRun(runId);
        const byContestant = new Map(existing.map((state) => [
          state.intent.contestantId,
          state.intent,
        ]));
        const merged = new Map(byContestant);
        for (const intent of requested) {
          const prior = merged.get(intent.contestantId);
          if (prior && canonicalArenaManifestJson(prior)
            !== canonicalArenaManifestJson(intent)) {
            throw new ArenaWorktreeRegistrationError(
              "collision",
              `Arena registration intent collided for ${runId}/${intent.contestantId}.`,
            );
          }
          merged.set(intent.contestantId, prior ?? intent);
        }
        if (merged.size > ARENA_WORKTREE_REGISTRATION_MAX_CONTESTANTS) {
          throw new ArenaWorktreeRegistrationError(
            "capacity",
            "Arena registration run exceeds the contestant limit.",
          );
        }
        assertRegistrationRunConsistency([...merged.values()]);

        const results: ArenaWorktreeRegistrationIntent[] = [];
        for (const intent of requested) {
          const prior = byContestant.get(intent.contestantId);
          if (prior) {
            results.push(prior);
            continue;
          }
          const paths = arenaWorktreeRegistrationPaths(
            this.privateWorkspaceRoot,
            runId,
            intent.contestantId,
          );
          await ensureArenaPrivateDirectory(
            boundary,
            ["registrations", runId, intent.contestantId],
          );
          await createArenaPrivateFile(
            paths.intentPath,
            registrationLine(intent),
            boundary,
          );
          byContestant.set(intent.contestantId, intent);
          results.push(intent);
        }
        return Object.freeze(results);
      },
    );
  }

  async recordReceipt(
    draft: ArenaWorktreeRegistrationReceiptDraft,
  ): Promise<ArenaWorktreeRegistrationReceipt> {
    const boundary = await this.boundary();
    const paths = arenaWorktreeRegistrationPaths(
      this.privateWorkspaceRoot,
      draft.runId,
      draft.contestantId,
    );
    return serializeArenaPrivateWork(boundary, paths.leasePath, async () => {
      let intent: ArenaWorktreeRegistrationIntent;
      try {
        intent = await readRegistrationRecord(
          paths.intentPath,
          boundary,
          (value) => parseArenaWorktreeRegistrationIntent(
            value,
            this.privateWorkspaceRoot,
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ArenaWorktreeRegistrationError(
            "missingIntent",
            "Arena refuses a worktree receipt without its durable intent.",
            { cause: error },
          );
        }
        throw error;
      }
      assertReceiptMatchesIntent(draft, intent);
      const receipt = createArenaWorktreeRegistrationReceipt(draft);
      try {
        await createArenaPrivateFile(
          paths.receiptPath,
          registrationLine(receipt),
          boundary,
        );
        return receipt;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const existing = await readRegistrationRecord(
        paths.receiptPath,
        boundary,
        parseArenaWorktreeRegistrationReceipt,
      );
      if (canonicalArenaManifestJson(existing)
        !== canonicalArenaManifestJson(receipt)) {
        throw new ArenaWorktreeRegistrationError(
          "collision",
          `Arena registration receipt collided for ${draft.runId}/${draft.contestantId}.`,
        );
      }
      return existing;
    });
  }

  async load(
    runId: string,
    contestantId: string,
  ): Promise<ArenaWorktreeRegistrationState | undefined> {
    const boundary = await this.boundary();
    const paths = arenaWorktreeRegistrationPaths(
      this.privateWorkspaceRoot,
      runId,
      contestantId,
    );
    return serializeArenaPrivateWork(boundary, paths.leasePath, async () => {
      let intent: ArenaWorktreeRegistrationIntent;
      try {
        intent = await readRegistrationRecord(
          paths.intentPath,
          boundary,
          (value) => parseArenaWorktreeRegistrationIntent(
            value,
            this.privateWorkspaceRoot,
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      try {
        const receipt = await readRegistrationRecord(
          paths.receiptPath,
          boundary,
          parseArenaWorktreeRegistrationReceipt,
        );
        assertReceiptMatchesIntent(receipt, intent);
        return Object.freeze({ intent, receipt });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return Object.freeze({ intent });
        }
        throw error;
      }
    });
  }

  async listRun(
    runId: string,
  ): Promise<readonly ArenaWorktreeRegistrationState[]> {
    arenaRunPaths(this.privateWorkspaceRoot, runId);
    const boundary = await this.boundary();
    const runPath = path.join(
      boundary.logicalRoot,
      "registrations",
      runId,
    );
    let entries: Dirent[];
    try {
      await assertArenaPrivateDirectory(runPath, boundary);
      entries = await fs.readdir(runPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (entries.some((entry) =>
      !entry.isDirectory()
      || entry.isSymbolicLink()
      || !IDENTIFIER_PATTERN.test(entry.name))) {
      throw new ArenaWorktreeRegistrationError(
        "invalid",
        "Arena registration directory contains an unexpected entry.",
      );
    }
    const names = entries.map((entry) => entry.name).sort(compareUtf8);
    if (names.length > ARENA_WORKTREE_REGISTRATION_MAX_CONTESTANTS) {
      throw new ArenaWorktreeRegistrationError(
        "capacity",
        "Arena registration directory exceeds the contestant limit.",
      );
    }
    const states: ArenaWorktreeRegistrationState[] = [];
    for (const contestantId of names) {
      const state = await this.load(runId, contestantId);
      if (state) states.push(state);
    }
    return Object.freeze(states);
  }

  private boundary(): Promise<ArenaPrivateStorageBoundary> {
    this.boundaryPromise ??= prepareArenaPrivateStorage(
      this.privateWorkspaceRoot,
    );
    return this.boundaryPromise;
  }
}

export function arenaWorktreeRegistrationPaths(
  privateWorkspaceRoot: string,
  runId: string,
  contestantId: string,
): ArenaWorktreeRegistrationPaths {
  arenaRunPaths(privateWorkspaceRoot, runId);
  arenaContestantWorktreePath(privateWorkspaceRoot, runId, contestantId);
  const registrationPath = path.resolve(
    privateWorkspaceRoot,
    "arena",
    "registrations",
    runId,
    contestantId,
  );
  return {
    registrationPath,
    intentPath: path.join(registrationPath, "intent.v1.json"),
    receiptPath: path.join(registrationPath, "receipt.v1.json"),
    leasePath: path.join(registrationPath, "registration.v1"),
    operationLeasePath: path.join(registrationPath, "provision.v1"),
  };
}

export function createArenaWorktreeRegistrationIntent(
  draft: ArenaWorktreeRegistrationIntentDraft,
  privateWorkspaceRoot: string,
): ArenaWorktreeRegistrationIntent {
  assertExactKeys(draft, [
    "baseContentSha256",
    "baseRevision",
    "contestantId",
    "intentId",
    "lockReason",
    "occurredAt",
    "repositoryControlSha256",
    "repositoryIdentitySha256",
    "repositoryStaticControlSha256",
    "runId",
    "sourceDirectoryIdentitySha256",
    "worktreeId",
    "worktreePath",
    "worktreeRegistrySha256",
  ], "Arena registration intent draft");
  assertIdentifier(draft.intentId, "intent ID");
  assertIdentifier(draft.runId, "run ID");
  assertIdentifier(draft.contestantId, "contestant ID");
  assertIdentifier(draft.worktreeId, "worktree ID");
  assertTimestamp(draft.occurredAt, "intent timestamp");
  assertDigest(draft.sourceDirectoryIdentitySha256, "source directory identity");
  assertDigest(draft.repositoryIdentitySha256, "repository identity");
  assertDigest(draft.repositoryControlSha256, "repository control");
  assertDigest(
    draft.repositoryStaticControlSha256,
    "repository static control",
  );
  assertDigest(draft.worktreeRegistrySha256, "worktree registry");
  assertExactKeys(draft.baseRevision, ["objectFormat", "oid"], "base revision");
  assertObjectId(draft.baseRevision, "base revision");
  assertDigest(draft.baseContentSha256, "base content");
  if (!draft.lockReason || draft.lockReason.length > 512
    || /[\u0000-\u001f\u007f]/u.test(draft.lockReason)) {
    invalid("Arena registration lock reason is invalid.");
  }
  const expectedPath = arenaContestantWorktreePath(
    privateWorkspaceRoot,
    draft.runId,
    draft.contestantId,
  );
  if (!samePath(path.resolve(draft.worktreePath), expectedPath)) {
    invalid("Arena registration intent does not use the derived worktree path.");
  }
  const withoutHash = {
    schemaVersion: ARENA_WORKTREE_REGISTRATION_SCHEMA_VERSION,
    recordType: "worktreeRegistrationIntent" as const,
    ...structuredClone(draft),
    baseRevision: {
      objectFormat: draft.baseRevision.objectFormat,
      oid: draft.baseRevision.oid,
    },
    worktreePath: expectedPath,
  };
  return Object.freeze({
    ...withoutHash,
    intentSha256: hashCanonical(INTENT_HASH_DOMAIN, withoutHash),
  });
}

export function createArenaWorktreeRegistrationReceipt(
  draft: ArenaWorktreeRegistrationReceiptDraft,
): ArenaWorktreeRegistrationReceipt {
  assertExactKeys(draft, [
    "contestantId",
    "directoryIdentitySha256",
    "gitRegistrationSha256",
    "head",
    "initialFingerprintSha256",
    "intentSha256",
    "realWorktreePathSha256",
    "registeredAt",
    "runId",
    "worktreeId",
  ], "Arena registration receipt draft");
  assertDigest(draft.intentSha256, "intent");
  assertIdentifier(draft.runId, "run ID");
  assertIdentifier(draft.contestantId, "contestant ID");
  assertIdentifier(draft.worktreeId, "worktree ID");
  assertTimestamp(draft.registeredAt, "registration timestamp");
  assertDigest(draft.realWorktreePathSha256, "real worktree path");
  assertDigest(draft.directoryIdentitySha256, "directory identity");
  assertDigest(draft.gitRegistrationSha256, "Git registration");
  assertExactKeys(draft.head, ["objectFormat", "oid"], "registered HEAD");
  assertObjectId(draft.head, "registered HEAD");
  assertDigest(draft.initialFingerprintSha256, "initial fingerprint");
  const withoutHash = {
    schemaVersion: ARENA_WORKTREE_REGISTRATION_SCHEMA_VERSION,
    recordType: "worktreeRegistrationReceipt" as const,
    ...structuredClone(draft),
    head: {
      objectFormat: draft.head.objectFormat,
      oid: draft.head.oid,
    },
  };
  return Object.freeze({
    ...withoutHash,
    registrationSha256: hashCanonical(RECEIPT_HASH_DOMAIN, withoutHash),
  });
}

export function parseArenaWorktreeRegistrationIntent(
  value: unknown,
  privateWorkspaceRoot?: string,
): ArenaWorktreeRegistrationIntent {
  assertExactKeys(value, [
    "baseContentSha256",
    "baseRevision",
    "contestantId",
    "intentId",
    "intentSha256",
    "lockReason",
    "occurredAt",
    "recordType",
    "repositoryControlSha256",
    "repositoryIdentitySha256",
    "repositoryStaticControlSha256",
    "runId",
    "schemaVersion",
    "sourceDirectoryIdentitySha256",
    "worktreeId",
    "worktreePath",
    "worktreeRegistrySha256",
  ], "Arena registration intent");
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== ARENA_WORKTREE_REGISTRATION_SCHEMA_VERSION
    || row.recordType !== "worktreeRegistrationIntent") {
    invalid("Arena registration intent has an unsupported schema.");
  }
  const expected = createArenaWorktreeRegistrationIntent({
    intentId: text(row.intentId, "intent ID"),
    runId: text(row.runId, "run ID"),
    contestantId: text(row.contestantId, "contestant ID"),
    worktreeId: text(row.worktreeId, "worktree ID"),
    occurredAt: text(row.occurredAt, "intent timestamp"),
    sourceDirectoryIdentitySha256: text(
      row.sourceDirectoryIdentitySha256,
      "source directory identity",
    ),
    repositoryIdentitySha256: text(
      row.repositoryIdentitySha256,
      "repository identity",
    ),
    repositoryControlSha256: text(
      row.repositoryControlSha256,
      "repository control",
    ),
    repositoryStaticControlSha256: text(
      row.repositoryStaticControlSha256,
      "repository static control",
    ),
    worktreeRegistrySha256: text(
      row.worktreeRegistrySha256,
      "worktree registry",
    ),
    baseRevision: objectId(row.baseRevision, "base revision"),
    baseContentSha256: text(row.baseContentSha256, "base content"),
    worktreePath: text(row.worktreePath, "worktree path"),
    lockReason: text(row.lockReason, "lock reason"),
  }, privateWorkspaceRoot
    ?? privateRootFromWorktreePath(text(row.worktreePath, "worktree path")));
  if (row.intentSha256 !== expected.intentSha256) {
    invalid("Arena registration intent hash does not match.");
  }
  return expected;
}

export function parseArenaWorktreeRegistrationReceipt(
  value: unknown,
): ArenaWorktreeRegistrationReceipt {
  assertExactKeys(value, [
    "contestantId",
    "directoryIdentitySha256",
    "gitRegistrationSha256",
    "head",
    "initialFingerprintSha256",
    "intentSha256",
    "realWorktreePathSha256",
    "recordType",
    "registeredAt",
    "registrationSha256",
    "runId",
    "schemaVersion",
    "worktreeId",
  ], "Arena registration receipt");
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== ARENA_WORKTREE_REGISTRATION_SCHEMA_VERSION
    || row.recordType !== "worktreeRegistrationReceipt") {
    invalid("Arena registration receipt has an unsupported schema.");
  }
  const expected = createArenaWorktreeRegistrationReceipt({
    intentSha256: text(row.intentSha256, "intent"),
    runId: text(row.runId, "run ID"),
    contestantId: text(row.contestantId, "contestant ID"),
    worktreeId: text(row.worktreeId, "worktree ID"),
    registeredAt: text(row.registeredAt, "registration timestamp"),
    realWorktreePathSha256: text(
      row.realWorktreePathSha256,
      "real worktree path",
    ),
    directoryIdentitySha256: text(
      row.directoryIdentitySha256,
      "directory identity",
    ),
    gitRegistrationSha256: text(
      row.gitRegistrationSha256,
      "Git registration",
    ),
    head: objectId(row.head, "registered HEAD"),
    initialFingerprintSha256: text(
      row.initialFingerprintSha256,
      "initial fingerprint",
    ),
  });
  if (row.registrationSha256 !== expected.registrationSha256) {
    invalid("Arena registration receipt hash does not match.");
  }
  return expected;
}

function assertReceiptMatchesIntent(
  receipt: ArenaWorktreeRegistrationReceiptDraft,
  intent: ArenaWorktreeRegistrationIntent,
): void {
  if (receipt.intentSha256 !== intent.intentSha256
    || receipt.runId !== intent.runId
    || receipt.contestantId !== intent.contestantId
    || receipt.worktreeId !== intent.worktreeId
    || receipt.head.objectFormat !== intent.baseRevision.objectFormat
    || receipt.head.oid !== intent.baseRevision.oid
    || receipt.initialFingerprintSha256 !== intent.baseContentSha256) {
    throw new ArenaWorktreeRegistrationError(
      "mismatch",
      "Arena worktree receipt does not match its durable registration intent.",
    );
  }
}

function assertRegistrationRunConsistency(
  intents: readonly ArenaWorktreeRegistrationIntent[],
): void {
  if (intents.length === 0) return;
  const first = intents[0]!;
  const intentIds = new Set<string>();
  const worktreeIds = new Set<string>();
  for (const intent of intents) {
    if (intentIds.has(intent.intentId) || worktreeIds.has(intent.worktreeId)) {
      throw new ArenaWorktreeRegistrationError(
        "collision",
        "Arena registration run duplicates an intent or worktree ID.",
      );
    }
    intentIds.add(intent.intentId);
    worktreeIds.add(intent.worktreeId);
    if (intent.runId !== first.runId
      || intent.sourceDirectoryIdentitySha256
        !== first.sourceDirectoryIdentitySha256
      || intent.repositoryIdentitySha256 !== first.repositoryIdentitySha256
      || intent.repositoryControlSha256 !== first.repositoryControlSha256
      || intent.repositoryStaticControlSha256
        !== first.repositoryStaticControlSha256
      || intent.worktreeRegistrySha256 !== first.worktreeRegistrySha256
      || intent.baseRevision.objectFormat !== first.baseRevision.objectFormat
      || intent.baseRevision.oid !== first.baseRevision.oid
      || intent.baseContentSha256 !== first.baseContentSha256) {
      throw new ArenaWorktreeRegistrationError(
        "mismatch",
        "Arena registration run intents do not share one locked source baseline.",
      );
    }
  }
}

async function readRegistrationRecord<T>(
  filePath: string,
  boundary: ArenaPrivateStorageBoundary,
  parser: (value: unknown) => T,
): Promise<T> {
  const bytes = await readArenaPrivateFile(
    filePath,
    ARENA_WORKTREE_REGISTRATION_MAX_BYTES,
    boundary,
  );
  let textValue: string;
  try {
    textValue = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ArenaWorktreeRegistrationError(
      "invalid",
      `Arena registration file is not valid UTF-8: ${filePath}.`,
      { cause: error },
    );
  }
  if (!textValue.endsWith("\n")
    || textValue.slice(0, -1).includes("\n")
    || textValue.length === 1) {
    invalid(`Arena registration file is torn or multiline: ${filePath}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textValue.slice(0, -1));
  } catch (error) {
    throw new ArenaWorktreeRegistrationError(
      "invalid",
      `Arena registration file is malformed: ${filePath}.`,
      { cause: error },
    );
  }
  const record = parser(parsed);
  if (`${canonicalArenaManifestJson(record)}\n` !== textValue) {
    invalid(`Arena registration file is not canonical: ${filePath}.`);
  }
  return record;
}

function registrationLine(value: unknown): string {
  const line = `${canonicalArenaManifestJson(value)}\n`;
  if (Buffer.byteLength(line, "utf8")
    > ARENA_WORKTREE_REGISTRATION_MAX_BYTES) {
    throw new ArenaWorktreeRegistrationError(
      "capacity",
      "Arena worktree registration record exceeds its byte limit.",
    );
  }
  return line;
}

function privateRootFromWorktreePath(worktreePath: string): string {
  const contestantPath = path.resolve(worktreePath);
  const worktreesPath = path.dirname(path.dirname(contestantPath));
  if (path.basename(worktreesPath) !== "worktrees") {
    invalid("Arena registration worktree path has an invalid layout.");
  }
  const arenaRoot = path.dirname(worktreesPath);
  if (path.basename(arenaRoot) !== "arena") {
    invalid("Arena registration worktree path has an invalid storage root.");
  }
  return path.dirname(arenaRoot);
}

function objectId(value: unknown, label: string): ArenaGitObjectId {
  assertExactKeys(value, ["objectFormat", "oid"], label);
  const row = value as Record<string, unknown>;
  const objectFormat = text(row.objectFormat, `${label} format`);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    invalid(`Arena ${label} format is invalid.`);
  }
  const result = {
    objectFormat: objectFormat as ArenaGitObjectFormat,
    oid: text(row.oid, `${label} object ID`),
  };
  assertObjectId(result, label);
  return result;
}

function assertObjectId(value: ArenaGitObjectId, label: string): void {
  const pattern = value.objectFormat === "sha1"
    ? /^[a-f0-9]{40}$/
    : value.objectFormat === "sha256"
      ? /^[a-f0-9]{64}$/
      : null;
  if (!pattern?.test(value.oid)) invalid(`Arena ${label} is invalid.`);
}

function assertDigest(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) invalid(`Arena ${label} digest is invalid.`);
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) invalid(`Arena ${label} is invalid.`);
}

function assertTimestamp(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    invalid(`Arena ${label} is not a canonical ISO timestamp.`);
  }
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid(`${label} must be a plain object.`);
  }
  const actual = Object.keys(value).sort(compareUtf8);
  const sortedExpected = [...expected].sort(compareUtf8);
  if (actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])) {
    invalid(`${label} has unknown or missing fields.`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(`Arena ${label} must be text.`);
  return value;
}

function hashCanonical(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(canonicalArenaManifestJson(value), "utf8")
    .digest("hex");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function invalid(message: string): never {
  throw new ArenaWorktreeRegistrationError("invalid", message);
}
