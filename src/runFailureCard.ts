import * as path from "node:path";
import type { RunResult } from "./agents";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";

export type RunFailureRequestFileKind = "prompt" | "reply" | "log";

export interface RunFailureRequestFile {
  kind: RunFailureRequestFileKind;
  path: string;
  label: string;
}

export interface RunFailureCard {
  id: string;
  agent: AgentId;
  phase: Phase;
  transport: "oneShot" | "terminalBridge" | "http";
  status: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  terminationFailed?: boolean;
  timeoutMs?: number;
  promptSha256: string;
  stderrChars: number;
  stderrPreview?: string;
  diagnosticPreviewSource?: "stderr" | "normalizedReplyOrStdout";
  diagnosticPreviewChars?: number;
  diagnosticPreview?: string;
  requestFiles: RunFailureRequestFile[];
}

export function createRunFailureCard(input: {
  id: string;
  agent: AgentId;
  phase: Phase;
  transport: "oneShot" | "terminalBridge" | "http";
  startedAt: number;
  result: RunResult;
  promptSha256: string;
  requestFiles?: Partial<Record<RunFailureRequestFileKind, string>>;
  workspaceRoot: string;
  nowMs?: number;
}): RunFailureCard | undefined {
  if (
    (input.result.cancelled && !input.result.terminationFailed) ||
    (!input.result.timedOut && !input.result.terminationFailed && input.result.exitCode === 0)
  ) return undefined;
  const diagnostic = diagnosticPreview(input.result);
  return {
    id: input.id,
    agent: input.agent,
    phase: input.phase,
    transport: input.transport,
    status: failureStatus(input.result),
    durationMs: Math.max(0, (input.nowMs ?? Date.now()) - input.startedAt),
    exitCode: input.result.exitCode,
    timedOut: input.result.timedOut,
    ...(input.result.terminationFailed ? { terminationFailed: true } : {}),
    timeoutMs: input.result.timeoutMs,
    promptSha256: input.promptSha256,
    stderrChars: input.result.stderr.length,
    stderrPreview: input.result.stderr
      ? truncateForRunFailure(collapseRepeatedLogLines(input.result.stderr), 1200)
      : undefined,
    ...(diagnostic ? {
      diagnosticPreviewSource: diagnostic.source,
      diagnosticPreviewChars: diagnostic.value.length,
      diagnosticPreview: truncateForRunFailure(collapseRepeatedLogLines(diagnostic.value), 1200),
    } : {}),
    requestFiles: requestFilesForCard(input.requestFiles, input.workspaceRoot),
  };
}

function diagnosticPreview(result: RunResult): {
  source: "stderr" | "normalizedReplyOrStdout";
  value: string;
} | undefined {
  // One-shot adapters normalize typed JSON-stream errors and reply-file text
  // into stdout. A failed call can therefore have useful diagnostics even
  // when the native process did not write stderr.
  if (result.stderr.trim()) return { source: "stderr", value: result.stderr };
  if (result.stdout.trim()) return { source: "normalizedReplyOrStdout", value: result.stdout };
  return undefined;
}

export function isSafeRunFailureRequestPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized || path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
    return false;
  }
  return /^\.hydra\/(?:prompts|replies|logs)\//.test(normalized);
}

function failureStatus(result: RunResult): string {
  if (result.terminationFailed) return "Process termination unconfirmed";
  if (result.timedOut) {
    return `Timed out after ${formatMs(result.timeoutMs)}`;
  }
  if (result.exitCode === null) return "Spawn failed";
  return `Exit ${result.exitCode}`;
}

function requestFilesForCard(
  requestFiles: Partial<Record<RunFailureRequestFileKind, string>> | undefined,
  workspaceRoot: string
): RunFailureRequestFile[] {
  if (!requestFiles) return [];
  return (["prompt", "reply", "log"] as const).flatMap((kind) => {
    const filePath = requestFiles[kind];
    if (!filePath) return [];
    const label = workspaceRelativePath(workspaceRoot, filePath);
    if (!isSafeRunFailureRequestPath(label)) return [];
    return [{ kind, path: label, label }];
  });
}

function workspaceRelativePath(workspaceRoot: string, filePath: string): string {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(filePath));
  return relative.replace(/\\/g, "/");
}

// Some CLIs prefix every log line with an RFC3339 timestamp, which is why
// plain identical-line dedup does nothing for them: the noise is a thousand
// lines that differ only in that prefix. Strip it before comparing.
const LEADING_LOG_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s*/;

/**
 * Collapse consecutive log lines that are equal once their leading timestamp
 * is ignored, keeping the first of each run.
 *
 * Why: a preview is the first N characters of stderr, so a CLI that repeats
 * one line every few seconds spends the entire budget on noise and truncates
 * away the diagnostic that explains the failure. Collapsing before truncating
 * spends the budget on distinct content instead. Cosmetic only - the full
 * stderr is still recorded, and stderrChars still counts the real length.
 *
 * Deliberately consecutive-only: it keeps ordering intact and never merges two
 * distant occurrences that happen to match, which would misrepresent the log.
 */
export function collapseRepeatedLogLines(value: string): string {
  if (!value) return value;
  const lines = value.split(/\r?\n/);
  const out: string[] = [];
  let runFirst: string | undefined;
  let runKey = "";
  let runCount = 0;
  const flush = (): void => {
    if (runFirst === undefined) return;
    out.push(runFirst);
    // One occurrence is not a run; emitting a marker for it would add noise
    // rather than remove it.
    if (runCount > 1) out.push(`[previous line repeated ${runCount - 1} more time${runCount === 2 ? "" : "s"}]`);
    runFirst = undefined;
    runCount = 0;
  };
  for (const line of lines) {
    const key = line.replace(LEADING_LOG_TIMESTAMP, "");
    if (runCount > 0 && key === runKey) {
      runCount++;
      continue;
    }
    flush();
    runFirst = line;
    runKey = key;
    runCount = 1;
  }
  flush();
  return out.join("\n");
}
function truncateForRunFailure(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function formatMs(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "the configured timeout";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}
