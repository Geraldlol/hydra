import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureFile, readJsonlGuarded, serializePerFile } from "./fileQueue";
import type { AgentId } from "./phases";

export type NativeActionStatus = "completed" | "cancelled" | "failed";

export interface NativeActionEditorContextSummary {
  label: string;
  selected: boolean;
  startLine: number;
  endLine: number;
  chars: number;
  originalChars: number;
  truncated: boolean;
}

export interface NativeActionReceipt {
  id: string;
  timestamp: string;
  agents: AgentId[];
  instruction: string;
  includeEditorContext: boolean;
  includeWorkspaceDiff: boolean;
  editorContext?: NativeActionEditorContextSummary;
  workspaceDiffChars?: number;
  promptEnvelopeIds: string[];
  nativeSessionHints?: NativeSessionHint[];
  status: NativeActionStatus;
}

export interface NativeSessionHint {
  agent: AgentId;
  source: "codex-session-index" | "claude-live-session";
  sessionId?: string;
  status?: string;
  kind?: string;
  entrypoint?: string;
  updatedAt?: string;
  pathLabel?: string;
}

export function nativeActionsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".hydra", "native-actions.jsonl");
}

export async function ensureNativeActionsFile(filePath: string): Promise<void> {
  await ensureFile(filePath);
}

export async function appendNativeAction(filePath: string, receipt: NativeActionReceipt): Promise<void> {
  await serializePerFile(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(receipt)}\n`, "utf8");
  });
}

export async function writeNativeActions(filePath: string, receipts: NativeActionReceipt[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = receipts.length > 0
    ? receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n"
    : "";
  await fs.writeFile(filePath, body, "utf8");
}

export async function collectNativeSessionHints(
  workspaceRoot: string,
  agents: AgentId[],
  home = os.homedir()
): Promise<NativeSessionHint[]> {
  const hints: NativeSessionHint[] = [];
  const targets = new Set(agents);
  if (targets.has("codex")) {
    hints.push(...await codexSessionHints(path.join(home, ".codex", "session_index.jsonl")));
  }
  if (targets.has("claude")) {
    hints.push(...await claudeLiveSessionHints(path.join(home, ".claude", "sessions"), workspaceRoot));
  }
  return hints;
}

export async function readNativeActions(filePath: string): Promise<NativeActionReceipt[]> {
  return readJsonlGuarded(filePath, isNativeActionReceipt);
}

export function nativeActionSummary(receipt: NativeActionReceipt | undefined): string {
  if (!receipt) return "No native actions yet";
  const agents = receipt.agents.map((agent) => agent === "codex" ? "Codex" : "Claude").join(" + ");
  const attachments = [
    receipt.includeEditorContext ? "editor" : "",
    receipt.includeWorkspaceDiff ? "diff" : "",
  ].filter(Boolean).join(", ");
  return `${receipt.status}: ${agents}${attachments ? ` (${attachments})` : ""}`;
}

function isNativeActionReceipt(value: unknown): value is NativeActionReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<NativeActionReceipt>;
  return (
    typeof receipt.id === "string" &&
    typeof receipt.timestamp === "string" &&
    Array.isArray(receipt.agents) &&
    receipt.agents.every((agent) => agent === "codex" || agent === "claude") &&
    typeof receipt.instruction === "string" &&
    typeof receipt.includeEditorContext === "boolean" &&
    typeof receipt.includeWorkspaceDiff === "boolean" &&
    Array.isArray(receipt.promptEnvelopeIds) &&
    receipt.promptEnvelopeIds.every((id) => typeof id === "string") &&
    (receipt.nativeSessionHints === undefined ||
      (Array.isArray(receipt.nativeSessionHints) && receipt.nativeSessionHints.every(isNativeSessionHint))) &&
    (receipt.status === "completed" || receipt.status === "cancelled" || receipt.status === "failed")
  );
}

function isNativeSessionHint(value: unknown): value is NativeSessionHint {
  if (!value || typeof value !== "object") return false;
  const hint = value as Partial<NativeSessionHint>;
  return (
    (hint.agent === "codex" || hint.agent === "claude") &&
    (hint.source === "codex-session-index" || hint.source === "claude-live-session")
  );
}

async function codexSessionHints(indexPath: string): Promise<NativeSessionHint[]> {
  const text = await readText(indexPath);
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => parseJsonObject(line))
    .filter((value): value is Record<string, unknown> => !!value)
    .slice(-3)
    .map((item) => ({
      agent: "codex",
      source: "codex-session-index",
      sessionId: stringValue(item.id),
      updatedAt: stringValue(item.updated_at),
      pathLabel: path.basename(indexPath),
    }));
}

async function claudeLiveSessionHints(dir: string, workspaceRoot: string): Promise<NativeSessionHint[]> {
  const files = await listFiles(dir, ".json");
  const hints: NativeSessionHint[] = [];
  for (const file of files) {
    const item = await readJson(file);
    if (!item) continue;
    const cwd = stringValue(item.cwd);
    if (cwd && !samePath(cwd, workspaceRoot)) continue;
    hints.push({
      agent: "claude",
      source: "claude-live-session",
      sessionId: stringValue(item.sessionId),
      status: stringValue(item.status),
      kind: stringValue(item.kind),
      entrypoint: stringValue(item.entrypoint),
      updatedAt: isoishTime(item.updatedAt),
      pathLabel: path.basename(file),
    });
  }
  return hints
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, 3);
}

async function listFiles(dir: string, extension: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function readText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  return parseJsonObject(await readText(filePath));
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isoishTime(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
  }
  return undefined;
}
