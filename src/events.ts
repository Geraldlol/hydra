import * as fs from "node:fs/promises";
import * as path from "node:path";
import { appendFileSafely, ensureFile, readJsonlGuarded, serializePerFile } from "./fileQueue";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";

// The single source of truth for the event-kind union. isHydraEvent validates
// against this array so a hand-edited or attacker-supplied JSONL line can't
// widen the union with an arbitrary string.
export const HYDRA_EVENT_KINDS = [
  "terminalSessionChanged",
  "verificationStarted",
  "verificationFinished",
  "phaseTransition",
  "diagnostic",
  "commandInvoked",
  "error",
] as const;

export type HydraEventKind = (typeof HYDRA_EVENT_KINDS)[number];

export interface HydraEvent {
  timestamp: string;
  kind: HydraEventKind;
  agent?: AgentId;
  phase?: Phase;
  detail: string;
  data?: Record<string, string | number | boolean | null>;
}

export function hydraEventsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".hydra", "events.jsonl");
}

export async function ensureHydraEventsFile(filePath: string): Promise<void> {
  await ensureFile(filePath);
}

// Why: directories we've already mkdir'd this process. Lets us drop the
// per-append fs.mkdir while still being safe on first run — we mkdir once per
// path, then trust the cache for every subsequent append.
const ensuredDirs = new Set<string>();

async function ensureDirOnce(dir: string): Promise<void> {
  if (ensuredDirs.has(dir)) return;
  await fs.mkdir(dir, { recursive: true });
  ensuredDirs.add(dir);
}

export async function appendHydraEvent(filePathOrWorkspaceRoot: string, event: HydraEvent): Promise<void> {
  const filePath = filePathOrWorkspaceRoot.endsWith(".jsonl")
    ? filePathOrWorkspaceRoot
    : hydraEventsPath(filePathOrWorkspaceRoot);
  await serializePerFile(filePath, async () => {
    await ensureDirOnce(path.dirname(filePath));
    await appendFileSafely(filePath, `${JSON.stringify(event)}\n`);
  });
}

export async function readHydraEvents(filePath: string, limit = 50): Promise<HydraEvent[]> {
  return readJsonlGuarded(filePath, isHydraEvent, { limit });
}

export function createHydraEvent(input: Omit<HydraEvent, "timestamp">, now: Date = new Date()): HydraEvent {
  return {
    timestamp: now.toISOString(),
    ...input,
  };
}

const HYDRA_EVENT_KIND_SET: ReadonlySet<string> = new Set(HYDRA_EVENT_KINDS);

function isHydraEvent(value: unknown): value is HydraEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<HydraEvent>;
  return typeof event.timestamp === "string" &&
    typeof event.kind === "string" &&
    HYDRA_EVENT_KIND_SET.has(event.kind) &&
    typeof event.detail === "string";
}
