import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureFile, readJsonlGuarded, serializePerFile } from "./fileQueue";
import type { WorkQueueItem } from "./workQueue";

export type WorkQueueDispositionKind = "dismissed" | "snoozed";

export interface WorkQueueDisposition {
  id: string;
  kind: WorkQueueDispositionKind;
  timestamp: string;
  until?: string;
}

export function workQueueStatePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".hydra", "work-queue.jsonl");
}

export async function ensureWorkQueueStateFile(filePath: string): Promise<void> {
  await ensureFile(filePath);
}

export async function appendWorkQueueDisposition(filePath: string, disposition: WorkQueueDisposition): Promise<void> {
  await serializePerFile(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(disposition)}\n`, "utf8");
  });
}

export async function readWorkQueueDispositions(filePath: string): Promise<WorkQueueDisposition[]> {
  return readJsonlGuarded(filePath, isWorkQueueDisposition);
}

export function applyWorkQueueDispositions(
  items: WorkQueueItem[],
  dispositions: WorkQueueDisposition[],
  now: Date = new Date()
): WorkQueueItem[] {
  const latestById = new Map<string, WorkQueueDisposition>();
  for (const disposition of dispositions) latestById.set(disposition.id, disposition);

  return items.filter((item) => {
    const disposition = latestById.get(item.id);
    if (!disposition) return true;
    if (disposition.kind === "dismissed") return false;
    if (disposition.kind === "snoozed") {
      const until = disposition.until ? Date.parse(disposition.until) : Number.NaN;
      // NaN means malformed/missing snooze expiry. Safe default: keep the
      // item hidden (treat as still snoozed) instead of surfacing it as
      // expired — better to need an explicit re-snooze than to flood the
      // queue with ghost items from corrupted state.
      if (Number.isNaN(until)) return false;
      return until <= now.getTime();
    }
    return true;
  });
}

function isWorkQueueDisposition(value: unknown): value is WorkQueueDisposition {
  if (!value || typeof value !== "object") return false;
  const disposition = value as Partial<WorkQueueDisposition>;
  return (
    typeof disposition.id === "string" &&
    (disposition.kind === "dismissed" || disposition.kind === "snoozed") &&
    typeof disposition.timestamp === "string" &&
    (disposition.until === undefined || typeof disposition.until === "string")
  );
}
