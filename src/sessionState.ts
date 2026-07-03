import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "./fileQueue";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";

export type TerminalSessionState =
  | "idle"
  | "creating"
  | "ready"
  | "dispatching"
  | "streaming"
  | "replied"
  | "error"
  | "timedOut"
  | "cancelled";

export interface TerminalSession {
  agent: AgentId;
  terminalName: string;
  state: TerminalSessionState;
  detail: string;
  requestId?: string;
  currentPhase?: Phase;
  currentCommand?: string;
  lastPromptPath?: string;
  lastReplyPath?: string;
  lastLogPath?: string;
  startedAt?: string;
  lastActivityAt?: string;
  updatedAt: string;
  lastError?: string;
}

export type TerminalSessionPatch = Partial<Omit<TerminalSession, "agent" | "terminalName">>;

// Single source of truth for the displayed terminal names. Other modules
// (terminalBridge) import this rather than duplicate the literal map.
export const TERMINAL_NAMES: Record<AgentId, string> = {
  codex: "Hydra Codex",
  claude: "Hydra Claude",
};

export function createTerminalSession(agent: AgentId, now: Date = new Date()): TerminalSession {
  const timestamp = now.toISOString();
  return {
    agent,
    // Why: TERMINAL_NAMES is keyed by the now-widened AgentId; fall back to the
    // raw id for an agent outside the built-in codex/claude table.
    terminalName: TERMINAL_NAMES[agent] ?? agent,
    state: "idle",
    detail: "Terminal has not been opened yet.",
    updatedAt: timestamp,
  };
}

export function updateTerminalSession(
  session: TerminalSession,
  patch: TerminalSessionPatch,
  now: Date = new Date()
): TerminalSession {
  const timestamp = now.toISOString();
  const next: TerminalSession = {
    ...session,
    ...patch,
    updatedAt: timestamp,
  };

  // startedAt marks the start of the CURRENT turn, not the session lifetime.
  // Clear it when the turn finishes (replied/error/timedOut/cancelled) or when
  // we go back to creating/ready/idle — otherwise the next dispatch sees a
  // truthy startedAt from a prior turn and the timestamp is stale forever.
  const TURN_TERMINAL: TerminalSessionState[] = ["replied", "error", "timedOut", "cancelled", "idle", "ready", "creating"];
  if (patch.state && TURN_TERMINAL.includes(patch.state)) {
    next.startedAt = undefined;
  }
  if ((patch.state === "dispatching" || patch.state === "streaming") && !next.startedAt) {
    next.startedAt = timestamp;
  }
  if (
    patch.state === "creating" ||
    patch.state === "ready" ||
    patch.state === "dispatching" ||
    patch.state === "streaming" ||
    patch.state === "replied" ||
    patch.state === "error" ||
    patch.state === "timedOut" ||
    patch.state === "cancelled"
  ) {
    next.lastActivityAt = patch.lastActivityAt ?? timestamp;
  }
  if (patch.state === "dispatching") {
    next.lastError = undefined;
  }
  return next;
}

export function terminalSessionDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".hydra", "sessions");
}

export function terminalSessionPath(workspaceRoot: string, agent: AgentId): string {
  return path.join(terminalSessionDir(workspaceRoot), `${agent}.session.json`);
}

export async function writeTerminalSession(workspaceRoot: string, session: TerminalSession): Promise<void> {
  await atomicWriteFile(
    terminalSessionPath(workspaceRoot, session.agent),
    `${JSON.stringify(session, null, 2)}\n`
  );
}

export function formatCommandForSession(command: string, args: string[]): string {
  return [command, ...args].map(formatCommandPart).join(" ");
}

function formatCommandPart(value: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
