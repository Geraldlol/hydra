import * as path from "node:path";
import {
  canonicalArenaManifestJson,
} from "./arenaRunManifest";
import {
  createArenaPrivateFile,
  ensureArenaPrivateDirectory,
  prepareArenaPrivateStorage,
  readArenaPrivateFile,
} from "./arenaPrivateStorage";
import type {
  ArenaProcessIntentReceipt,
  ArenaProcessQuiescenceReceipt,
  ArenaProcessSubmissionReceipt,
} from "./arenaProcessSupervisor";

export type ArenaDispatchReceipt =
  | ArenaProcessIntentReceipt
  | ArenaProcessSubmissionReceipt
  | ArenaProcessQuiescenceReceipt;

/**
 * Persists metadata-only process receipts. The intent must be published before
 * spawn; if Hydra later finds only an intent, recovery treats delivery as
 * unknown and never retries automatically.
 */
export async function persistArenaDispatchReceipt(
  privateWorkspaceRoot: string,
  receipt: ArenaDispatchReceipt,
): Promise<string> {
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
