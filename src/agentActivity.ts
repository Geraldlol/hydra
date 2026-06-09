export const AGENT_OUTPUT_IDLE_WARNING_MS = 120_000;

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function formatPendingAgentActivity(input: {
  agentLabel: string;
  phase: string;
  elapsedMs: number;
  timeoutMs: number;
  outputIdleMs: number;
}): string {
  const elapsed = formatElapsed(input.elapsedMs);
  const limit = input.timeoutMs > 0
    ? `timeout ${formatElapsed(input.timeoutMs)}`
    : "no wall-clock timeout";
  const idle = input.outputIdleMs >= AGENT_OUTPUT_IDLE_WARNING_MS
    ? ` No output for ${formatElapsed(input.outputIdleMs)}; use Stop current turn if it looks stuck.`
    : " Use Stop current turn if this is not useful.";
  return `${input.agentLabel} is still running ${input.phase} (${elapsed}; ${limit}).${idle}`;
}
