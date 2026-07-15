import type { AgentId } from "./phases";
import type { Phase } from "./prompts";

export type WorkerTransportMode = "oneShot" | "terminalBridge";

export interface ParallelDiscussionWorker {
  agent: AgentId;
  workerId: string;
  traceIdOverride?: string;
  claudeOrdinal?: number;
  claudeTotal?: number;
  manyHeadsDispatch: boolean;
}

export interface BuildParallelDiscussionWorkersArgs {
  /** Independent head identities seated in this room. Defaults to legacy pair. */
  roster?: ReadonlyArray<AgentId>;
  manyHeads: boolean;
  transport: WorkerTransportMode;
  claudeWorkerCount: number;
  makeTraceId: (agent: AgentId, phase: Phase) => string;
}

const MIN_CLAUDE_WORKERS = 1;
const MAX_CLAUDE_WORKERS = 8;

export function clampManyHeadsClaudeWorkerCount(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 3;
  return Math.min(MAX_CLAUDE_WORKERS, Math.max(MIN_CLAUDE_WORKERS, Math.floor(raw)));
}

export function buildParallelDiscussionWorkers(args: BuildParallelDiscussionWorkersArgs): ParallelDiscussionWorker[] {
  const enabled = args.manyHeads && args.transport === "oneShot";
  const claudeTotal = enabled ? clampManyHeadsClaudeWorkerCount(args.claudeWorkerCount) : 1;
  const manyHeadsDispatch = enabled && claudeTotal > 1;
  const roster = [...new Set(args.roster?.length ? args.roster : ["codex", "claude"] as AgentId[])];
  const workers: ParallelDiscussionWorker[] = [];

  for (const agent of roster) {
    const copies = agent === "claude" ? claudeTotal : 1;
    for (let index = 1; index <= copies; index++) {
      workers.push({
        agent,
        workerId: copies > 1 ? `${agent}-${index}` : agent,
        traceIdOverride: enabled ? args.makeTraceId(agent, "parallel") : undefined,
        claudeOrdinal: agent === "claude" ? index : undefined,
        claudeTotal: agent === "claude" ? copies : undefined,
        manyHeadsDispatch: agent === "claude" ? manyHeadsDispatch : false,
      });
    }
  }

  return workers;
}

export function claudeWorkerTraceIds(workers: readonly ParallelDiscussionWorker[]): string[] {
  return workers
    .filter((worker) => worker.agent === "claude" && typeof worker.traceIdOverride === "string")
    .map((worker) => worker.traceIdOverride as string);
}

export function appendClaudeWorkerAssignment(transcript: string, worker: ParallelDiscussionWorker): string {
  if (worker.agent !== "claude" || !worker.claudeOrdinal || !worker.claudeTotal || worker.claudeTotal <= 1) {
    return transcript;
  }
  return [
    transcript,
    "",
    "--- Claude Worker Fanout assignment ---",
    `You are Claude worker ${worker.claudeOrdinal} of ${worker.claudeTotal} for this parallel turn.`,
    "Work independently from the other Claude workers. Keep your output concise, name concrete files or commands you inspect, and do not wait for sibling workers.",
  ].join("\n");
}
