import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  parseArenaPromotionIntentReceipt,
  parseArenaPromotionResultReceipt,
  type ArenaPromotionIntentReceipt,
  type ArenaPromotionResultReceipt,
} from "./arenaPromotion";
import {
  assertArenaPrivateDirectory,
  createArenaPrivateFile,
  ensureArenaPrivateDirectory,
  prepareArenaPrivateStorage,
  readArenaPrivateFile,
  type ArenaPrivateStorageBoundary,
} from "./arenaPrivateStorage";
import { canonicalArenaManifestJson } from "./arenaRunManifest";
import { arenaRunPaths } from "./arenaStore";

const MAX_PROMOTIONS = 4_096;
const MAX_RECEIPT_BYTES = 64 * 1024;
const RECEIPT_PATTERN =
  /^(intent|result)\.([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.v1\.json$/u;

export interface ArenaPromotionReceiptState {
  readonly promotionId: string;
  readonly state: "interrupted" | "succeeded" | "failed";
  readonly intent: ArenaPromotionIntentReceipt;
  readonly result: ArenaPromotionResultReceipt | null;
}

export async function persistArenaPromotionIntent(
  privateWorkspaceRoot: string,
  receipt: ArenaPromotionIntentReceipt,
): Promise<string> {
  const parsed = parseArenaPromotionIntentReceipt(structuredClone(receipt));
  const { boundary, directory } = await promotionDirectory(
    privateWorkspaceRoot,
    parsed.runId,
  );
  return publishExactReceipt(
    path.join(directory, `intent.${parsed.promotionId}.v1.json`),
    parsed,
    boundary,
  );
}

export async function persistArenaPromotionResult(
  privateWorkspaceRoot: string,
  receipt: ArenaPromotionResultReceipt,
): Promise<string> {
  const parsed = parseArenaPromotionResultReceipt(structuredClone(receipt));
  const states = await loadArenaPromotionReceipts(
    privateWorkspaceRoot,
    parsed.runId,
  );
  const state = states.find((candidate) =>
    candidate.promotionId === parsed.promotionId);
  if (!state
    || state.intent.intentSha256 !== parsed.intentSha256
    || state.intent.contestantId !== parsed.contestantId) {
    throw new Error("Arena promotion result requires its exact durable intent.");
  }
  const { boundary, directory } = await promotionDirectory(
    privateWorkspaceRoot,
    parsed.runId,
  );
  return publishExactReceipt(
    path.join(directory, `result.${parsed.promotionId}.v1.json`),
    parsed,
    boundary,
  );
}

export async function loadArenaPromotionReceipts(
  privateWorkspaceRoot: string,
  runId: string,
): Promise<readonly ArenaPromotionReceiptState[]> {
  const { boundary, directory } = await promotionDirectory(
    privateWorkspaceRoot,
    runId,
  );
  const intents = new Map<string, ArenaPromotionIntentReceipt>();
  const results = new Map<string, ArenaPromotionResultReceipt>();
  let scanned = 0;
  const handle = await fs.opendir(directory);
  try {
    for await (const entry of handle) {
      scanned += 1;
      if (scanned > MAX_PROMOTIONS * 2) {
        throw new Error("Arena promotion receipt directory exceeds its entry limit.");
      }
      const match = RECEIPT_PATTERN.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Arena promotion receipt directory has unexpected entry ${entry.name}.`);
      }
      const value = await readCanonicalReceipt(
        path.join(directory, entry.name),
        boundary,
      );
      if (match[1] === "intent") {
        const receipt = parseArenaPromotionIntentReceipt(value);
        if (receipt.runId !== runId
          || receipt.promotionId !== match[2]
          || intents.has(receipt.promotionId)) {
          throw new Error("Arena promotion intent path or identity is invalid.");
        }
        intents.set(receipt.promotionId, receipt);
      } else {
        const receipt = parseArenaPromotionResultReceipt(value);
        if (receipt.runId !== runId
          || receipt.promotionId !== match[2]
          || results.has(receipt.promotionId)) {
          throw new Error("Arena promotion result path or identity is invalid.");
        }
        results.set(receipt.promotionId, receipt);
      }
    }
  } finally {
    await handle.close().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error;
    });
  }
  for (const promotionId of results.keys()) {
    if (!intents.has(promotionId)) {
      throw new Error("Arena promotion result exists without its durable intent.");
    }
  }
  const states = [...intents.values()].map((intent) => {
    const result = results.get(intent.promotionId) ?? null;
    if (result
      && (result.intentSha256 !== intent.intentSha256
        || result.contestantId !== intent.contestantId)) {
      throw new Error("Arena promotion result does not bind its exact intent.");
    }
    return Object.freeze({
      promotionId: intent.promotionId,
      state: result?.outcome ?? "interrupted",
      intent,
      result,
    } satisfies ArenaPromotionReceiptState);
  });
  states.sort((left, right) => Buffer.compare(
    Buffer.from(left.promotionId, "utf8"),
    Buffer.from(right.promotionId, "utf8"),
  ));
  return Object.freeze(states);
}

async function promotionDirectory(
  privateWorkspaceRoot: string,
  runId: string,
): Promise<{
  readonly boundary: ArenaPrivateStorageBoundary;
  readonly directory: string;
}> {
  arenaRunPaths(privateWorkspaceRoot, runId);
  const boundary = await prepareArenaPrivateStorage(privateWorkspaceRoot);
  const directory = await ensureArenaPrivateDirectory(boundary, [
    "arena",
    "promotions",
    runId,
  ]);
  await assertArenaPrivateDirectory(directory, boundary);
  return Object.freeze({ boundary, directory });
}

async function publishExactReceipt(
  filePath: string,
  receipt: ArenaPromotionIntentReceipt | ArenaPromotionResultReceipt,
  boundary: ArenaPrivateStorageBoundary,
): Promise<string> {
  const bytes = Buffer.from(
    `${canonicalArenaManifestJson(receipt)}\n`,
    "utf8",
  );
  if (bytes.byteLength > MAX_RECEIPT_BYTES) {
    throw new Error("Arena promotion receipt exceeds its byte limit.");
  }
  try {
    await createArenaPrivateFile(filePath, bytes, boundary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const current = await readArenaPrivateFile(
      filePath,
      MAX_RECEIPT_BYTES,
      boundary,
    );
    if (!current.equals(bytes)) {
      throw new Error("Arena promotion receipt conflicts with durable state.");
    }
  }
  return filePath;
}

async function readCanonicalReceipt(
  filePath: string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<unknown> {
  const bytes = await readArenaPrivateFile(
    filePath,
    MAX_RECEIPT_BYTES,
    boundary,
  );
  if (bytes.at(-1) !== 0x0a) {
    throw new Error("Arena promotion receipt is missing its final newline.");
  }
  const text = bytes.subarray(0, -1).toString("utf8");
  if (!Buffer.from(`${text}\n`, "utf8").equals(bytes)) {
    throw new Error("Arena promotion receipt is not canonical UTF-8.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("Arena promotion receipt is malformed JSON.", {
      cause: error,
    });
  }
  if (canonicalArenaManifestJson(value) !== text) {
    throw new Error("Arena promotion receipt is not canonical JSON.");
  }
  return value;
}

export const ARENA_PROMOTION_STORE_LIMITS = Object.freeze({
  maxPromotions: MAX_PROMOTIONS,
  maxReceiptBytes: MAX_RECEIPT_BYTES,
});
