import type { AgentId } from "./phases";
import type { Phase } from "./prompts";
import type { Invocation } from "./agentAdapter";

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
const BUILD_ADVISORY_MAX_CHARS = 4_000;
const BUILD_ADVISORIES_TOTAL_MAX_CHARS = 24_000;

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

export interface ClaudePhaseWorker {
  agent: AgentId;
  workerId: string;
  role: "lead" | "adviser" | "reviewer";
  ordinal: number;
  total: number;
  traceIdOverride?: string;
  manyHeadsDispatch: boolean;
  restrictedReadOnly: boolean;
}

interface BuildClaudePhaseWorkersArgs {
  agent: AgentId;
  /** True only for the built-in subscription-backed Claude seat. */
  eligible: boolean;
  manyHeads: boolean;
  transport: WorkerTransportMode;
  claudeWorkerCount: number;
  makeTraceId: (agent: AgentId, phase: Phase) => string;
}

export interface ClaudeBuildWorkerPlan {
  advisers: ClaudePhaseWorker[];
  lead: ClaudePhaseWorker;
}

function phaseFanoutEnabled(args: BuildClaudePhaseWorkersArgs): boolean {
  return args.eligible
    && args.manyHeads
    && args.transport === "oneShot"
    && clampManyHeadsClaudeWorkerCount(args.claudeWorkerCount) > 1;
}

/**
 * Build fanout never creates multiple writers. Extra Claude processes are
 * read-only advisers that drain before the ordinary lead Build is dispatched.
 * The configured worker count includes that lead.
 */
export function buildClaudeBuildWorkers(args: BuildClaudePhaseWorkersArgs): ClaudeBuildWorkerPlan {
  const enabled = phaseFanoutEnabled(args);
  const total = enabled ? clampManyHeadsClaudeWorkerCount(args.claudeWorkerCount) : 1;
  const lead: ClaudePhaseWorker = {
    agent: args.agent,
    workerId: args.agent,
    role: "lead",
    ordinal: 1,
    total,
    manyHeadsDispatch: false,
    restrictedReadOnly: false,
  };
  const advisers: ClaudePhaseWorker[] = [];
  for (let ordinal = 2; ordinal <= total; ordinal++) {
    advisers.push({
      agent: args.agent,
      workerId: `${args.agent}-build-${ordinal}`,
      role: "adviser",
      ordinal,
      total,
      traceIdOverride: args.makeTraceId(args.agent, "build"),
      manyHeadsDispatch: true,
      restrictedReadOnly: true,
    });
  }
  return { advisers, lead };
}

/**
 * Review workers are duplicate attempts for one Claude roster identity. The
 * first call preserves ordinary-credit semantics; extras are fanout calls.
 * Every duplicate is isolated/read-only because review has no write authority.
 */
export function buildClaudeReviewWorkers(args: BuildClaudePhaseWorkersArgs): ClaudePhaseWorker[] {
  const enabled = phaseFanoutEnabled(args);
  if (!enabled) {
    return [{
      agent: args.agent,
      workerId: args.agent,
      role: "reviewer",
      ordinal: 1,
      total: 1,
      manyHeadsDispatch: false,
      restrictedReadOnly: false,
    }];
  }
  const total = clampManyHeadsClaudeWorkerCount(args.claudeWorkerCount);
  return Array.from({ length: total }, (_, index): ClaudePhaseWorker => {
    const ordinal = index + 1;
    return {
      agent: args.agent,
      workerId: `${args.agent}-review-${ordinal}`,
      role: "reviewer",
      ordinal,
      total,
      traceIdOverride: args.makeTraceId(args.agent, "review"),
      manyHeadsDispatch: ordinal > 1,
      restrictedReadOnly: true,
    };
  });
}

export function appendClaudeBuildWorkerAssignment(
  transcript: string,
  worker: ClaudePhaseWorker,
): string {
  if (worker.role !== "adviser") return transcript;
  return [
    transcript,
    "",
    "--- Claude Build Worker Fanout assignment ---",
    `You are ${worker.workerId}, read-only advisory worker ${worker.ordinal} of ${worker.total}.`,
    "You run with no native tools in an isolated empty directory and must not edit the user's workspace.",
    "Produce a concise implementation recommendation for the sole lead builder. Name likely files, tests, risks, and an ordered approach using only the supplied room context.",
  ].join("\n");
}

export function appendClaudeReviewWorkerAssignment(
  transcript: string,
  worker: ClaudePhaseWorker,
): string {
  if (worker.role !== "reviewer" || worker.total <= 1) return transcript;
  return [
    transcript,
    "",
    "--- Claude Review Worker Fanout assignment ---",
    `You are ${worker.workerId}, duplicate review worker ${worker.ordinal} of ${worker.total} for one Claude roster identity.`,
    "Inspect only the supplied transcript, verification evidence, and diff. You run with no native tools in an isolated empty directory.",
    "Your worker verdict is collapsed with sibling Claude verdicts and the Claude roster identity counts once in room convergence.",
  ].join("\n");
}

export interface ClaudeBuildAdvisory {
  workerId: string;
  text: string;
}

/** Append deterministic, bounded advisory text to the sole writer's context. */
export function appendClaudeBuildAdvisories(
  transcript: string,
  advisories: ReadonlyArray<ClaudeBuildAdvisory>,
): string {
  const ordered = [...advisories].sort((left, right) => {
    if (left.workerId < right.workerId) return -1;
    if (left.workerId > right.workerId) return 1;
    return left.text < right.text ? -1 : left.text > right.text ? 1 : 0;
  });
  const sections: string[] = [];
  let remaining = BUILD_ADVISORIES_TOTAL_MAX_CHARS;
  for (const advisory of ordered) {
    if (remaining <= 0) break;
    const clean = advisory.text.trim();
    if (!clean) continue;
    const allowed = Math.min(BUILD_ADVISORY_MAX_CHARS, remaining);
    const clipped = clean.length <= allowed
      ? clean
      : `${clean.slice(0, Math.max(0, allowed - 30))}\n[... advisory truncated ...]`;
    const section = `### ${advisory.workerId}\n${clipped}`;
    sections.push(section);
    remaining -= section.length;
  }
  if (sections.length === 0) return transcript;
  return [
    transcript,
    "",
    "--- Claude Build Worker Fanout advisories (non-authoritative) ---",
    "These read-only suggestions are context for the sole lead builder; verify them before acting.",
    ...sections,
  ].join("\n");
}

export interface ClaudeReviewWorkerVerdict {
  workerId: string;
  approved: boolean;
}

export interface CollapsedClaudeReviewVerdict {
  approved: boolean;
  approvals: number;
  total: number;
  dissentingWorkerIds: string[];
}

/**
 * Fold duplicate Claude attempts into one conservative roster verdict. A
 * duplicate worker can never add another vote to cross-head majority policy.
 */
export function collapseClaudeReviewWorkerVerdicts(
  verdicts: ReadonlyArray<ClaudeReviewWorkerVerdict>,
): CollapsedClaudeReviewVerdict {
  const byWorker = new Map<string, boolean>();
  for (const verdict of verdicts) {
    const previous = byWorker.get(verdict.workerId);
    byWorker.set(verdict.workerId, previous === undefined ? verdict.approved : previous && verdict.approved);
  }
  const ordered = [...byWorker.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const approvals = ordered.reduce((count, [, approved]) => count + (approved ? 1 : 0), 0);
  const dissentingWorkerIds = ordered.filter(([, approved]) => !approved).map(([workerId]) => workerId);
  return {
    approved: ordered.length > 0 && approvals === ordered.length,
    approvals,
    total: ordered.length,
    dissentingWorkerIds,
  };
}

const SAFE_CLAUDE_WORKER_BOOLEAN_FLAGS = new Set([
  "-p",
  "--print",
  "--verbose",
  "--include-partial-messages",
]);

const SAFE_CLAUDE_WORKER_VALUE_FLAGS = new Set([
  "--output-format",
  "--input-format",
  "--model",
  "-m",
  "--effort",
  "--fallback-model",
  "--max-budget-usd",
  "--max-turns",
  "--json-schema",
]);

function restrictedClaudeArgs(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const equalsAt = arg.indexOf("=");
    const flag = equalsAt >= 0 ? arg.slice(0, equalsAt) : arg;
    if (SAFE_CLAUDE_WORKER_BOOLEAN_FLAGS.has(flag)) {
      kept.push(arg);
      continue;
    }
    if (SAFE_CLAUDE_WORKER_VALUE_FLAGS.has(flag)) {
      if (equalsAt >= 0) {
        kept.push(arg);
      } else if (index + 1 < args.length && !args[index + 1]!.startsWith("-")) {
        kept.push(arg);
        kept.push(args[index + 1]!);
        index += 1;
      }
    }
  }
  if (!kept.includes("-p") && !kept.includes("--print")) kept.unshift("-p");
  return [
    ...kept,
    "--permission-mode", "plan",
    "--tools", "",
    "--setting-sources", "local",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
    "--no-chrome",
  ];
}

/**
 * Defense in depth for fanout auxiliaries: empty isolated cwd, no built-in
 * tools, no inherited settings/hooks/plugins/MCPs/browser broker, and Claude
 * plan permission mode. The ordinary lead invocation is never rewritten.
 */
export function restrictClaudeWorkerInvocation(
  invocation: Invocation,
  isolatedCwd: string,
): Extract<Invocation, { transport: "spawn" }> {
  if (invocation.transport !== "spawn") {
    throw new Error("Claude Worker Fanout requires the subscription-backed spawn transport");
  }
  return {
    ...invocation,
    args: restrictedClaudeArgs(invocation.args),
    cwd: isolatedCwd,
    disableBrowserBroker: true,
  };
}
