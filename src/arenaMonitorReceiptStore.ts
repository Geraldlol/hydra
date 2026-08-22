import * as path from "node:path";
import {
  canonicalArenaManifestJson,
} from "./arenaRunManifest";
import type { ArenaMainWorkspaceReceipt } from "./arenaMainWorkspaceMonitor";
import {
  createArenaPrivateFile,
  ensureArenaPrivateDirectory,
  prepareArenaPrivateStorage,
  readArenaPrivateFile,
} from "./arenaPrivateStorage";

export async function persistArenaMonitorReceipt(
  privateWorkspaceRoot: string,
  receipt: ArenaMainWorkspaceReceipt,
): Promise<string> {
  const boundary = await prepareArenaPrivateStorage(privateWorkspaceRoot);
  const directory = await ensureArenaPrivateDirectory(boundary, [
    "support",
    "monitor",
    receipt.runId,
    receipt.epochId,
  ]);
  const filePath = path.join(
    directory,
    `${String(receipt.observationCount).padStart(6, "0")}.v1.json`,
  );
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
      throw new Error("Arena monitor receipt retry conflicts with private state.");
    }
  }
  return filePath;
}
