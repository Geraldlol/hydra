import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  canonicalArenaManifestJson,
} from "./arenaRunManifest";
import {
  assertArenaPrivateDirectory,
  createArenaPrivateFile,
  ensureArenaPrivateDirectory,
  prepareArenaPrivateStorage,
  readArenaPrivateFile,
} from "./arenaPrivateStorage";
import type { ArenaRecoveryProcessGeneration } from "./arenaRecovery";
import type {
  ArenaProcessIntentReceipt,
  ArenaProcessQuiescenceReceipt,
  ArenaProcessSubmissionReceipt,
} from "./arenaProcessSupervisor";

export type ArenaDispatchReceipt =
  | ArenaProcessIntentReceipt
  | ArenaProcessSubmissionReceipt
  | ArenaProcessQuiescenceReceipt;

const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_CONTESTANTS = 8;
const MAX_GENERATIONS = 256;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const INTENT_HASH_DOMAIN = "hydra.arena.process.v1.intent\u0000";
const OWNER_HASH_DOMAIN = "hydra.arena.process.v1.owner\u0000";
const SUBMISSION_HASH_DOMAIN = "hydra.arena.process.v1.submission\u0000";
const QUIESCENCE_HASH_DOMAIN = "hydra.arena.process.v1.quiescence\u0000";

export interface ArenaDispatchGenerationReceiptState {
  readonly generation: ArenaRecoveryProcessGeneration;
  readonly intent: ArenaProcessIntentReceipt;
  readonly submission: ArenaProcessSubmissionReceipt | null;
  readonly quiescence: ArenaProcessQuiescenceReceipt | null;
}

/**
 * Persists metadata-only process receipts. The intent must be published before
 * spawn; if Hydra later finds only an intent, recovery treats delivery as
 * unknown and never retries automatically.
 */
export async function persistArenaDispatchReceipt(
  privateWorkspaceRoot: string,
  receipt: ArenaDispatchReceipt,
): Promise<string> {
  receipt = parseArenaDispatchReceipt(structuredClone(receipt));
  const boundary = await prepareArenaPrivateStorage(privateWorkspaceRoot);
  const directory = await ensureArenaPrivateDirectory(boundary, [
    "support",
    "dispatch",
    receipt.runId,
    receipt.contestantId,
    receipt.processGenerationId,
  ]);
  const fileName = receipt.receiptType === "arenaProcessIntent"
    ? "intent.v1.json"
    : receipt.receiptType === "arenaProcessSubmission"
      ? "submission.v1.json"
      : "quiescence.v1.json";
  const filePath = path.join(directory, fileName);
  const bytes = Buffer.from(
    `${canonicalArenaManifestJson(receipt)}\n`,
    "utf8",
  );
  try {
    await createArenaPrivateFile(filePath, bytes, boundary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const current = await readArenaPrivateFile(
      filePath,
      Math.max(1, bytes.byteLength),
      boundary,
    );
    if (!current.equals(bytes)) {
      throw new Error("Arena dispatch receipt retry conflicts with durable state.");
    }
  }
  return filePath;
}

export function parseArenaDispatchReceipt(value: unknown): ArenaDispatchReceipt {
  const row = exactRecord(value, "dispatch receipt");
  if (row.receiptType === "arenaProcessIntent") return parseIntent(row);
  if (row.receiptType === "arenaProcessSubmission") return parseSubmission(row);
  if (row.receiptType === "arenaProcessQuiescence") return parseQuiescence(row);
  throw new Error("Arena dispatch receipt type is invalid.");
}

export async function loadArenaDispatchGenerations(
  privateWorkspaceRoot: string,
  runId: string,
): Promise<readonly ArenaDispatchGenerationReceiptState[]> {
  identifier(runId, "dispatch run ID");
  const boundary = await prepareArenaPrivateStorage(privateWorkspaceRoot);
  const runDirectory = path.resolve(
    boundary.realRoot,
    "support",
    "dispatch",
    runId,
  );
  try {
    await assertArenaPrivateDirectory(runDirectory, boundary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze([]);
    }
    throw error;
  }
  const contestants = await exactDirectories(runDirectory, MAX_CONTESTANTS);
  const states: ArenaDispatchGenerationReceiptState[] = [];
  for (const contestantId of contestants) {
    identifier(contestantId, "dispatch contestant directory");
    const contestantDirectory = path.join(runDirectory, contestantId);
    await assertArenaPrivateDirectory(contestantDirectory, boundary);
    const remaining = MAX_GENERATIONS - states.length;
    if (remaining < 1) {
      throw new Error("Arena dispatch receipt tree exceeds its generation bound.");
    }
    const generations = await exactDirectories(contestantDirectory, remaining);
    for (const processGenerationId of generations) {
      identifier(processGenerationId, "dispatch generation directory");
      const generationDirectory = path.join(
        contestantDirectory,
        processGenerationId,
      );
      await assertArenaPrivateDirectory(generationDirectory, boundary);
      const names = await exactReceiptNames(generationDirectory);
      const intent = parseArenaDispatchReceipt(await readCanonicalReceipt(
        path.join(generationDirectory, "intent.v1.json"),
        boundary,
      ));
      if (intent.receiptType !== "arenaProcessIntent") {
        throw new Error("Arena dispatch intent file has the wrong receipt type.");
      }
      const submission = names.has("submission.v1.json")
        ? parseArenaDispatchReceipt(await readCanonicalReceipt(
          path.join(generationDirectory, "submission.v1.json"),
          boundary,
        ))
        : null;
      const quiescence = names.has("quiescence.v1.json")
        ? parseArenaDispatchReceipt(await readCanonicalReceipt(
          path.join(generationDirectory, "quiescence.v1.json"),
          boundary,
        ))
        : null;
      if ((submission !== null
          && submission.receiptType !== "arenaProcessSubmission")
        || (quiescence !== null
          && quiescence.receiptType !== "arenaProcessQuiescence")) {
        throw new Error("Arena dispatch receipt file has the wrong receipt type.");
      }
      assertPathBinding(intent, runId, contestantId, processGenerationId);
      if (submission) assertReceiptBinding(intent, submission);
      if (quiescence) {
        if (!submission) {
          throw new Error("Arena quiescence receipt exists without submission.");
        }
        assertReceiptBinding(submission, quiescence);
        const nativeIntent = intent.nativeAdapterKind !== undefined;
        const nativeQuiescence = quiescence.proof
          === "nativeAdapterProcessTreeBroker";
        if (nativeIntent !== nativeQuiescence
          || (nativeIntent
            && (intent.nativeAdapterKind !== quiescence.adapterKind
              || intent.nativeBrokerCapabilitySha256
                !== quiescence.brokerCapabilitySha256))) {
          throw new Error("Arena native dispatch receipts form a mixed proof generation.");
        }
      }
      const state = quiescence
        ? "quiescent" as const
        : submission
          ? "submitted" as const
          : "intentOnly" as const;
      states.push(Object.freeze({
        generation: Object.freeze({
          contestantId,
          processGenerationId,
          processOwnerSha256: intent.processOwnerSha256,
          intentSha256: intent.intentSha256,
          submissionReceiptSha256:
            submission?.submissionReceiptSha256 ?? null,
          quiescenceReceiptSha256:
            quiescence?.quiescenceReceiptSha256 ?? null,
          state,
        }),
        intent,
        submission,
        quiescence,
      }));
    }
  }
  states.sort((left, right) => Buffer.compare(
    Buffer.from(`${left.generation.contestantId}\0${
      left.generation.processGenerationId}`, "utf8"),
    Buffer.from(`${right.generation.contestantId}\0${
      right.generation.processGenerationId}`, "utf8"),
  ));
  return Object.freeze(states);
}

function parseIntent(row: Record<string, unknown>): ArenaProcessIntentReceipt {
  const native = Object.hasOwn(row, "nativeAdapterKind")
    || Object.hasOwn(row, "nativeBrokerCapabilitySha256");
  assertExactKeys(row, [
    "schemaVersion", "receiptType", "runId", "contestantId", "traceId",
    "registrationSha256", "processGenerationId", "processOwnerSha256",
    "worktreePathSha256", "worktreeDirectoryIdentitySha256", "commandSha256",
    "commandFileIdentitySha256", "bundledHelperFileIdentitySha256",
    ...(native ? ["nativeAdapterKind", "nativeBrokerCapabilitySha256"] : []),
    "argsSha256", "promptSha256", "inputSha256", "inputBytes",
    "environmentPolicySha256", "invocationSha256", "timeoutMs", "intentSha256",
  ], "dispatch intent");
  if (row.schemaVersion !== 1 || row.receiptType !== "arenaProcessIntent") {
    throw new Error("Arena dispatch intent version or type is invalid.");
  }
  const parsed = {
    schemaVersion: 1 as const,
    receiptType: "arenaProcessIntent" as const,
    runId: identifier(row.runId, "intent run ID"),
    contestantId: identifier(row.contestantId, "intent contestant ID"),
    traceId: identifier(row.traceId, "intent trace ID"),
    registrationSha256: sha256(row.registrationSha256, "intent registration"),
    processGenerationId: identifier(row.processGenerationId, "intent generation ID"),
    processOwnerSha256: sha256(row.processOwnerSha256, "intent process owner"),
    worktreePathSha256: sha256(row.worktreePathSha256, "intent worktree path"),
    worktreeDirectoryIdentitySha256: sha256(
      row.worktreeDirectoryIdentitySha256,
      "intent worktree identity",
    ),
    commandSha256: sha256(row.commandSha256, "intent command"),
    commandFileIdentitySha256: sha256(
      row.commandFileIdentitySha256,
      "intent command identity",
    ),
    bundledHelperFileIdentitySha256: row.bundledHelperFileIdentitySha256 === null
      ? null
      : sha256(row.bundledHelperFileIdentitySha256, "intent helper identity"),
    ...(native
      ? {
        nativeAdapterKind: identifier(row.nativeAdapterKind, "native adapter kind"),
        nativeBrokerCapabilitySha256: sha256(
          row.nativeBrokerCapabilitySha256,
          "native broker capability",
        ),
      }
      : {}),
    argsSha256: sha256(row.argsSha256, "intent arguments"),
    promptSha256: sha256(row.promptSha256, "intent prompt"),
    inputSha256: sha256(row.inputSha256, "intent input"),
    inputBytes: boundedInteger(row.inputBytes, 0, 4 * 1024 * 1024, "intent input bytes"),
    environmentPolicySha256: sha256(row.environmentPolicySha256, "intent environment"),
    invocationSha256: sha256(row.invocationSha256, "intent invocation"),
    timeoutMs: boundedInteger(row.timeoutMs, 1, 24 * 60 * 60 * 1_000, "intent timeout"),
    intentSha256: sha256(row.intentSha256, "intent receipt"),
  };
  if (native && parsed.bundledHelperFileIdentitySha256 !== null) {
    throw new Error("Arena native intent cannot also bind the bundled helper.");
  }
  const ownerBinding = {
    runId: parsed.runId,
    contestantId: parsed.contestantId,
    traceId: parsed.traceId,
    registrationSha256: parsed.registrationSha256,
    processGenerationId: parsed.processGenerationId,
  };
  const { intentSha256, ...withoutHash } = parsed;
  if (hashCanonical(OWNER_HASH_DOMAIN, ownerBinding) !== parsed.processOwnerSha256
    || hashCanonical(INTENT_HASH_DOMAIN, withoutHash) !== intentSha256) {
    throw new Error("Arena dispatch intent hash binding is invalid.");
  }
  return Object.freeze(parsed);
}

function parseSubmission(
  row: Record<string, unknown>,
): ArenaProcessSubmissionReceipt {
  assertExactKeys(row, [
    "schemaVersion", "receiptType", "runId", "contestantId", "traceId",
    "registrationSha256", "processGenerationId", "processOwnerSha256",
    "intentSha256", "submissionReceiptSha256",
  ], "dispatch submission");
  if (row.schemaVersion !== 1 || row.receiptType !== "arenaProcessSubmission") {
    throw new Error("Arena dispatch submission version or type is invalid.");
  }
  const parsed: ArenaProcessSubmissionReceipt = {
    schemaVersion: 1,
    receiptType: "arenaProcessSubmission",
    runId: identifier(row.runId, "submission run ID"),
    contestantId: identifier(row.contestantId, "submission contestant ID"),
    traceId: identifier(row.traceId, "submission trace ID"),
    registrationSha256: sha256(row.registrationSha256, "submission registration"),
    processGenerationId: identifier(row.processGenerationId, "submission generation ID"),
    processOwnerSha256: sha256(row.processOwnerSha256, "submission process owner"),
    intentSha256: sha256(row.intentSha256, "submission intent"),
    submissionReceiptSha256: sha256(row.submissionReceiptSha256, "submission receipt"),
  };
  const { submissionReceiptSha256, ...withoutHash } = parsed;
  if (hashCanonical(SUBMISSION_HASH_DOMAIN, withoutHash)
      !== submissionReceiptSha256) {
    throw new Error("Arena dispatch submission hash binding is invalid.");
  }
  return Object.freeze(parsed);
}

function parseQuiescence(
  row: Record<string, unknown>,
): ArenaProcessQuiescenceReceipt {
  const native = row.proof === "nativeAdapterProcessTreeBroker";
  assertExactKeys(row, [
    "schemaVersion", "receiptType", "runId", "contestantId", "traceId",
    "registrationSha256", "processGenerationId", "processOwnerSha256",
    "intentSha256", "submissionReceiptSha256", "proof",
    ...(native
      ? ["adapterKind", "brokerCapabilitySha256", "brokerReceiptSha256"]
      : []),
    "terminationConfirmed", "activeProcessCount",
    "finalWorkspaceFingerprintSha256", "quiescenceReceiptSha256",
  ], "dispatch quiescence");
  if (row.schemaVersion !== 1
    || row.receiptType !== "arenaProcessQuiescence"
    || (row.proof !== "bundledFakeHeadNoDescendants" && !native)
    || row.terminationConfirmed !== true
    || row.activeProcessCount !== 0) {
    throw new Error("Arena dispatch quiescence authority fields are invalid.");
  }
  const parsed: ArenaProcessQuiescenceReceipt = {
    schemaVersion: 1,
    receiptType: "arenaProcessQuiescence",
    runId: identifier(row.runId, "quiescence run ID"),
    contestantId: identifier(row.contestantId, "quiescence contestant ID"),
    traceId: identifier(row.traceId, "quiescence trace ID"),
    registrationSha256: sha256(row.registrationSha256, "quiescence registration"),
    processGenerationId: identifier(row.processGenerationId, "quiescence generation ID"),
    processOwnerSha256: sha256(row.processOwnerSha256, "quiescence process owner"),
    intentSha256: sha256(row.intentSha256, "quiescence intent"),
    submissionReceiptSha256: sha256(
      row.submissionReceiptSha256,
      "quiescence submission",
    ),
    proof: native
      ? "nativeAdapterProcessTreeBroker"
      : "bundledFakeHeadNoDescendants",
    ...(native
      ? {
        adapterKind: identifier(row.adapterKind, "quiescence adapter kind"),
        brokerCapabilitySha256: sha256(
          row.brokerCapabilitySha256,
          "quiescence broker capability",
        ),
        brokerReceiptSha256: sha256(
          row.brokerReceiptSha256,
          "quiescence broker receipt",
        ),
      }
      : {}),
    terminationConfirmed: true,
    activeProcessCount: 0,
    finalWorkspaceFingerprintSha256: sha256(
      row.finalWorkspaceFingerprintSha256,
      "quiescence workspace",
    ),
    quiescenceReceiptSha256: sha256(
      row.quiescenceReceiptSha256,
      "quiescence receipt",
    ),
  };
  const { quiescenceReceiptSha256, ...withoutHash } = parsed;
  if (hashCanonical(QUIESCENCE_HASH_DOMAIN, withoutHash)
      !== quiescenceReceiptSha256) {
    throw new Error("Arena dispatch quiescence hash binding is invalid.");
  }
  return Object.freeze(parsed);
}

function assertPathBinding(
  receipt: ArenaDispatchReceipt,
  runId: string,
  contestantId: string,
  processGenerationId: string,
): void {
  if (receipt.runId !== runId
    || receipt.contestantId !== contestantId
    || receipt.processGenerationId !== processGenerationId) {
    throw new Error("Arena dispatch receipt path does not bind its identity.");
  }
}

function assertReceiptBinding(
  earlier: ArenaDispatchReceipt,
  later: ArenaDispatchReceipt,
): void {
  const shared = [
    "runId", "contestantId", "traceId", "registrationSha256",
    "processGenerationId", "processOwnerSha256", "intentSha256",
  ] as const;
  if (shared.some((key) => earlier[key] !== later[key])
    || (later.receiptType === "arenaProcessQuiescence"
      && earlier.receiptType === "arenaProcessSubmission"
      && later.submissionReceiptSha256 !== earlier.submissionReceiptSha256)) {
    throw new Error("Arena dispatch receipt generation binding is invalid.");
  }
}

async function exactDirectories(
  directory: string,
  maximum: number,
): Promise<readonly string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (entries.length > maximum
    || entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error("Arena dispatch receipt tree has invalid or excessive entries.");
  }
  return Object.freeze(entries.map((entry) => entry.name).sort(compareUtf8));
}

async function exactReceiptNames(directory: string): Promise<ReadonlySet<string>> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const allowed = new Set([
    "intent.v1.json",
    "submission.v1.json",
    "quiescence.v1.json",
  ]);
  if (entries.length < 1
    || entries.length > 3
    || entries.some((entry) =>
      !allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink())
    || !entries.some((entry) => entry.name === "intent.v1.json")) {
    throw new Error("Arena dispatch generation directory has an invalid exact layout.");
  }
  return new Set(entries.map((entry) => entry.name));
}

async function readCanonicalReceipt(
  filePath: string,
  boundary: Awaited<ReturnType<typeof prepareArenaPrivateStorage>>,
): Promise<unknown> {
  const bytes = await readArenaPrivateFile(filePath, MAX_RECEIPT_BYTES, boundary);
  if (bytes.at(-1) !== 0x0a) {
    throw new Error("Arena dispatch receipt is missing its final newline.");
  }
  const text = bytes.subarray(0, -1).toString("utf8");
  if (!Buffer.from(`${text}\n`, "utf8").equals(bytes)) {
    throw new Error("Arena dispatch receipt is not canonical UTF-8.");
  }
  const value = JSON.parse(text) as unknown;
  if (canonicalArenaManifestJson(value) !== text) {
    throw new Error("Arena dispatch receipt is not canonical JSON.");
  }
  return value;
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Arena ${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Arena ${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  row: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(row).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length
    || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`Arena ${label} has an invalid exact schema.`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Arena ${label} is invalid.`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`Arena ${label} SHA-256 is invalid.`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum) {
    throw new Error(`Arena ${label} is invalid.`);
  }
  return value as number;
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
