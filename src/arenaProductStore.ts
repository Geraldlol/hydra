import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  parseArenaProductReceipt,
  type ArenaProductReceipt,
} from "./arenaProduct";
import {
  assertArenaPrivateDirectory,
  createArenaPrivateFile,
  ensureArenaPrivateDirectory,
  prepareArenaPrivateStorage,
  readArenaPrivateFile,
} from "./arenaPrivateStorage";
import { canonicalArenaManifestJson } from "./arenaRunManifest";
import { arenaRunPaths } from "./arenaStore";

const MAX_PRODUCT_RECEIPTS = 4_096;
const MAX_PRODUCT_RECEIPT_BYTES = 64 * 1024;
const RECEIPT_FILE_PATTERN =
  /^(winner|synthesis)\.([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.v1\.json$/u;

export async function persistArenaProductReceipt(
  privateWorkspaceRoot: string,
  receipt: ArenaProductReceipt,
): Promise<string> {
  const parsed = parseArenaProductReceipt(structuredClone(receipt));
  arenaRunPaths(privateWorkspaceRoot, parsed.runId);
  const boundary = await prepareArenaPrivateStorage(privateWorkspaceRoot);
  const directory = await ensureArenaPrivateDirectory(boundary, [
    "arena",
    "product",
    parsed.runId,
  ]);
  await assertArenaPrivateDirectory(directory, boundary);
  const filePath = path.join(directory, productReceiptFileName(parsed));
  const bytes = Buffer.from(
    `${canonicalArenaManifestJson(parsed)}\n`,
    "utf8",
  );
  if (bytes.byteLength > MAX_PRODUCT_RECEIPT_BYTES) {
    throw new Error("Arena product receipt exceeds its byte limit.");
  }
  try {
    await createArenaPrivateFile(filePath, bytes, boundary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const current = await readArenaPrivateFile(
      filePath,
      MAX_PRODUCT_RECEIPT_BYTES,
      boundary,
    );
    if (!current.equals(bytes)) {
      throw new Error("Arena product receipt conflicts with durable state.");
    }
  }
  return filePath;
}

export async function loadArenaProductReceipts(
  privateWorkspaceRoot: string,
  runId: string,
): Promise<readonly ArenaProductReceipt[]> {
  arenaRunPaths(privateWorkspaceRoot, runId);
  const boundary = await prepareArenaPrivateStorage(privateWorkspaceRoot);
  const directory = await ensureArenaPrivateDirectory(boundary, [
    "arena",
    "product",
    runId,
  ]);
  await assertArenaPrivateDirectory(directory, boundary);
  const entries: { readonly name: string; readonly receipt: ArenaProductReceipt }[] = [];
  const handle = await fs.opendir(directory);
  try {
    for await (const entry of handle) {
      if (entries.length >= MAX_PRODUCT_RECEIPTS) {
        throw new Error("Arena product receipt directory exceeds its entry limit.");
      }
      const match = RECEIPT_FILE_PATTERN.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Arena product receipt directory has unexpected entry ${entry.name}.`);
      }
      const filePath = path.join(directory, entry.name);
      const bytes = await readArenaPrivateFile(
        filePath,
        MAX_PRODUCT_RECEIPT_BYTES,
        boundary,
      );
      if (bytes.at(-1) !== 0x0a) {
        throw new Error("Arena product receipt is missing its final newline.");
      }
      const text = bytes.subarray(0, -1).toString("utf8");
      if (!Buffer.from(`${text}\n`, "utf8").equals(bytes)) {
        throw new Error("Arena product receipt is not canonical UTF-8.");
      }
      let unknown: unknown;
      try {
        unknown = JSON.parse(text);
      } catch (error) {
        throw new Error("Arena product receipt is malformed JSON.", {
          cause: error,
        });
      }
      const receipt = parseArenaProductReceipt(unknown);
      if (receipt.runId !== runId
        || productReceiptFileName(receipt) !== entry.name
        || canonicalArenaManifestJson(receipt) !== text) {
        throw new Error("Arena product receipt path or canonical binding is invalid.");
      }
      entries.push(Object.freeze({ name: entry.name, receipt }));
    }
  } finally {
    await handle.close().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error;
    });
  }
  entries.sort((left, right) => Buffer.compare(
    Buffer.from(left.name, "utf8"),
    Buffer.from(right.name, "utf8"),
  ));
  return Object.freeze(entries.map((entry) => entry.receipt));
}

function productReceiptFileName(receipt: ArenaProductReceipt): string {
  return receipt.receiptType === "arenaWinnerSelection"
    ? `winner.${receipt.selectionId}.v1.json`
    : `synthesis.${receipt.requestId}.v1.json`;
}

export const ARENA_PRODUCT_STORE_LIMITS = Object.freeze({
  maxReceipts: MAX_PRODUCT_RECEIPTS,
  maxReceiptBytes: MAX_PRODUCT_RECEIPT_BYTES,
});
