import * as path from "node:path";
import { appendFileSafely, ensureFile, readJsonlGuarded, serializePerFile } from "./fileQueue";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";

export interface ManyHeadsSmokeAgentCall {
  id: string;
  event: string;
  timestamp?: string;
  agent?: AgentId;
  phase?: Phase;
  exitCode?: number | null;
  timedOut?: boolean;
  cancelled?: boolean;
}

export interface ManyHeadsSmokeLiveFile {
  requestId: string;
  agent: AgentId;
  path: string;
  eventCount: number;
  taskEventCount: number;
}

export interface ManyHeadsSmokeCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ManyHeadsSmokeReport {
  timestamp: string;
  startedAt: string;
  completedAt: string;
  prompt: string;
  expectedClaudeWorkers: number;
  passed: boolean;
  checks: ManyHeadsSmokeCheck[];
  observed: {
    codexStarts: number;
    claudeStarts: number;
    completedCalls: number;
    failedCalls: number;
    liveFiles: number;
    liveEvents: number;
    forwardedTaskEvents: number;
    guardBlocks: number;
  };
}

export interface BuildManyHeadsSmokeReportInput {
  startedAt: string;
  completedAt: string;
  prompt: string;
  expectedClaudeWorkers: number;
  agentCalls: readonly ManyHeadsSmokeAgentCall[];
  liveFiles: readonly ManyHeadsSmokeLiveFile[];
  forwardedTaskEvents: number;
}

export function manyHeadsSmokePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".hydra", "many-heads-smoke.jsonl");
}

export async function ensureManyHeadsSmokeFile(filePath: string): Promise<void> {
  await ensureFile(filePath);
}

export async function appendManyHeadsSmokeReport(filePath: string, report: ManyHeadsSmokeReport): Promise<void> {
  await serializePerFile(filePath, async () => {
    await appendFileSafely(filePath, `${JSON.stringify(report)}\n`);
  });
}

export async function readManyHeadsSmokeReports(filePath: string, limit = 20): Promise<ManyHeadsSmokeReport[]> {
  return readJsonlGuarded(filePath, isManyHeadsSmokeReport, { limit });
}

export function buildManyHeadsSmokeReport(input: BuildManyHeadsSmokeReportInput): ManyHeadsSmokeReport {
  const relevantCalls = input.agentCalls.filter((call) => call.phase === "parallel");
  const started = relevantCalls.filter((call) => call.event === "started");
  const completed = relevantCalls.filter((call) => call.event === "completed");
  const guardBlocks = relevantCalls.filter((call) => call.event === "claudeCreditGuardBlocked").length;
  const codexStarts = started.filter((call) => call.agent === "codex").length;
  const claudeStarts = started.filter((call) => call.agent === "claude").length;
  const failedCalls = completed.filter((call) => call.timedOut || call.cancelled || call.exitCode !== 0).length;
  const expectedTotalCalls = 1 + input.expectedClaudeWorkers;
  const liveEvents = input.liveFiles.reduce((sum, file) => sum + file.eventCount, 0);
  const liveTaskEvents = input.liveFiles.reduce((sum, file) => sum + file.taskEventCount, 0);

  const checks: ManyHeadsSmokeCheck[] = [
    {
      name: "parallel-fanout-started",
      passed: codexStarts >= 1 && claudeStarts >= input.expectedClaudeWorkers,
      detail: `Observed ${codexStarts} Codex and ${claudeStarts}/${input.expectedClaudeWorkers} expected Claude parallel start trace(s).`,
    },
    {
      name: "parallel-calls-completed",
      passed: completed.length >= expectedTotalCalls && failedCalls === 0,
      detail: `Observed ${completed.length}/${expectedTotalCalls} expected completed call trace(s); failed=${failedCalls}.`,
    },
    {
      name: "live-channel-files-written",
      passed: input.liveFiles.length >= expectedTotalCalls && liveEvents > 0,
      detail: `Observed ${input.liveFiles.length}/${expectedTotalCalls} expected live file(s) with ${liveEvents} event(s).`,
    },
    {
      name: "claude-task-events-forwarded",
      passed: input.forwardedTaskEvents > 0 || liveTaskEvents > 0,
      detail: `Observed ${input.forwardedTaskEvents} forwarded task event(s) and ${liveTaskEvents} task event(s) in live files.`,
    },
    {
      name: "credit-guard-did-not-block",
      passed: guardBlocks === 0,
      detail: `Observed ${guardBlocks} Claude credit guard block event(s).`,
    },
  ];

  return {
    timestamp: input.completedAt,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    prompt: input.prompt,
    expectedClaudeWorkers: input.expectedClaudeWorkers,
    passed: checks.every((check) => check.passed),
    checks,
    observed: {
      codexStarts,
      claudeStarts,
      completedCalls: completed.length,
      failedCalls,
      liveFiles: input.liveFiles.length,
      liveEvents,
      forwardedTaskEvents: input.forwardedTaskEvents,
      guardBlocks,
    },
  };
}

export function formatManyHeadsSmokeReport(report: ManyHeadsSmokeReport): string {
  const status = report.passed ? "passed" : "failed";
  const lines = [
    `Claude Worker Fanout smoke test ${status}.`,
    `Expected Claude workers: ${report.expectedClaudeWorkers}`,
    `Observed: ${report.observed.codexStarts} Codex start(s), ${report.observed.claudeStarts} Claude start(s), ${report.observed.liveFiles} live file(s), ${report.observed.forwardedTaskEvents} forwarded task event(s).`,
    "Checks:",
    ...report.checks.map((check) => `- ${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`),
  ];
  return lines.join("\n");
}

export function isManyHeadsSmokeAgentCall(value: unknown): value is ManyHeadsSmokeAgentCall {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ManyHeadsSmokeAgentCall>;
  return typeof record.id === "string" && typeof record.event === "string";
}

export function isManyHeadsSmokeReport(value: unknown): value is ManyHeadsSmokeReport {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ManyHeadsSmokeReport>;
  return typeof record.timestamp === "string" &&
    typeof record.startedAt === "string" &&
    typeof record.completedAt === "string" &&
    typeof record.prompt === "string" &&
    typeof record.expectedClaudeWorkers === "number" &&
    typeof record.passed === "boolean" &&
    Array.isArray(record.checks);
}
