import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureFile, readJsonlGuarded } from "./fileQueue";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";

export type HydraEventKind =
  | "terminalSessionChanged"
  | "verificationStarted"
  | "verificationFinished"
  | "commandInvoked"
  | "error";

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

export async function appendHydraEvent(filePathOrWorkspaceRoot: string, event: HydraEvent): Promise<void> {
  const filePath = filePathOrWorkspaceRoot.endsWith(".jsonl")
    ? filePathOrWorkspaceRoot
    : hydraEventsPath(filePathOrWorkspaceRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
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

function isHydraEvent(value: unknown): value is HydraEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<HydraEvent>;
  return typeof event.timestamp === "string" &&
    typeof event.kind === "string" &&
    typeof event.detail === "string";
}
