export type AgentId = string;
export type ParticipationPolicy = "serial" | "all";
export type DiscussionMode = "serial" | "parallelOnBoth" | "parallel";

export type State =
  | { name: "Idle" }
  | { name: "Opener"; opener: AgentId; reactor: AgentId }
  | { name: "Reactor"; opener: AgentId; reactor: AgentId }
  | { name: "Closer"; opener: AgentId; reactor: AgentId }
  | { name: "ParallelDiscussion"; agents: ReadonlyArray<AgentId> }
  | { name: "AwaitingUser" }
  | { name: "Build"; builder: AgentId }
  | { name: "ParallelBuild"; agents: ReadonlyArray<AgentId> }
  | { name: "BuildDone"; builder: AgentId }
  | { name: "ParallelBuildDone"; agents: ReadonlyArray<AgentId> }
  | { name: "Review"; reviewer: AgentId; builder: AgentId }
  | { name: "ParallelReview"; agents: ReadonlyArray<AgentId>; builders: ReadonlyArray<AgentId> }
  | { name: "ReviewDone"; reviewer: AgentId; builder: AgentId; approved: boolean }
  | {
      name: "ParallelReviewDone";
      agents: ReadonlyArray<AgentId>;
      builders: ReadonlyArray<AgentId>;
      approved: boolean;
      resolutionRequired?: boolean;
    };

export type Event =
  | {
      type: "userSent";
      opener: AgentId;
      parallel?: boolean;
      /** Explicit identity chosen from the active room roster. */
      reactor?: AgentId;
      /** Explicit identities chosen from the active room roster. */
      parallelAgents?: ReadonlyArray<AgentId>;
    }
  | { type: "openerDone" }
  | { type: "reactorDone" }
  | { type: "closerDone" }
  | { type: "parallelDone" }
  | { type: "assignBuilder"; builder: AgentId }
  | { type: "assignBuilders"; agents: ReadonlyArray<AgentId> }
  | { type: "buildDone" }
  | { type: "parallelBuildDone" }
  | { type: "requestReview"; reviewers?: ReadonlyArray<AgentId> }
  | { type: "reviewDone"; approved: boolean }
  | { type: "parallelReviewDone"; approved: boolean; resolutionRequired?: boolean }
  | { type: "resolveReview"; approved: boolean }
  | { type: "handBack" }
  | { type: "requestReviewSkipped" }
  | { type: "reservationFailed"; restore: State }
  | { type: "stop" };

export const DEFAULT_ROSTER: ReadonlyArray<AgentId> = ["codex", "claude"];

/**
 * Reviewers for a builder's diff, chosen from the rest of the roster.
 * The default seats every non-builder reviewer. A two-head roster still
 * yields one reviewer, preserving the legacy serial sequence. The explicit
 * serial policy caps larger rooms at their first eligible reviewer.
 */
export function pickReviewers(
  builder: AgentId,
  roster: ReadonlyArray<AgentId>,
  policy: ParticipationPolicy = "all",
): AgentId[] {
  const reviewers = roster.filter((agent) => agent !== builder);
  return policy === "serial" ? reviewers.slice(0, 1) : reviewers;
}

const defaultPeer = (agent: AgentId): AgentId => pickReviewers(agent, DEFAULT_ROSTER)[0] ?? agent;

function beginDiscussion(event: Extract<Event, { type: "userSent" }>): State {
  if (event.parallel) {
    const agents = event.parallelAgents?.length ? event.parallelAgents : DEFAULT_ROSTER;
    return { name: "ParallelDiscussion", agents: [...agents] };
  }
  return {
    name: "Opener",
    opener: event.opener,
    reactor: event.reactor ?? defaultPeer(event.opener),
  };
}

function requestedReviewers(event: Extract<Event, { type: "requestReview" }>): ReadonlyArray<AgentId> {
  return event.reviewers?.length ? event.reviewers : [];
}

export function isInFlight(state: State): boolean {
  return (
    state.name === "Opener" ||
    state.name === "Reactor" ||
    state.name === "Closer" ||
    state.name === "ParallelDiscussion" ||
    state.name === "Build" ||
    state.name === "ParallelBuild" ||
    state.name === "Review" ||
    state.name === "ParallelReview"
  );
}

export function transition(state: State, event: Event): State {
  if (event.type === "reservationFailed") {
    return isInFlight(state) && !isInFlight(event.restore) ? event.restore : state;
  }
  if (event.type === "stop") {
    return isInFlight(state) ? { name: "AwaitingUser" } : state;
  }

  switch (state.name) {
    case "Idle":
      if (event.type === "userSent") return beginDiscussion(event);
      return state;
    case "Opener":
      if (event.type === "openerDone") return { name: "Reactor", opener: state.opener, reactor: state.reactor };
      return state;
    case "Reactor":
      if (event.type === "reactorDone") return { name: "Closer", opener: state.opener, reactor: state.reactor };
      return state;
    case "Closer":
      if (event.type === "closerDone") return { name: "AwaitingUser" };
      return state;
    case "ParallelDiscussion":
      if (event.type === "parallelDone") return { name: "AwaitingUser" };
      return state;
    case "AwaitingUser":
      if (event.type === "userSent") return beginDiscussion(event);
      if (event.type === "assignBuilder")
        return { name: "Build", builder: event.builder };
      if (event.type === "assignBuilders")
        return { name: "ParallelBuild", agents: event.agents };
      return state;
    case "Build":
      if (event.type === "buildDone")
        return { name: "BuildDone", builder: state.builder };
      return state;
    case "ParallelBuild":
      if (event.type === "parallelBuildDone")
        return { name: "ParallelBuildDone", agents: state.agents };
      return state;
    case "BuildDone":
      if (event.type === "userSent") return beginDiscussion(event);
      if (event.type === "requestReview") {
        const reviewers = requestedReviewers(event);
        const selected = reviewers.length ? reviewers : [defaultPeer(state.builder)];
        return selected.length > 1
          ? { name: "ParallelReview", agents: [...selected], builders: [state.builder] }
          : { name: "Review", reviewer: selected[0] ?? defaultPeer(state.builder), builder: state.builder };
      }
      if (event.type === "requestReviewSkipped") return { name: "AwaitingUser" };
      return state;
    case "ParallelBuildDone":
      if (event.type === "userSent") return beginDiscussion(event);
      if (event.type === "requestReview") {
        const reviewers = requestedReviewers(event);
        return {
          name: "ParallelReview",
          agents: [...(reviewers.length ? reviewers : state.agents)],
          builders: [...state.agents],
        };
      }
      if (event.type === "requestReviewSkipped") return { name: "AwaitingUser" };
      return state;
    case "Review":
      if (event.type === "reviewDone")
        return { name: "ReviewDone", reviewer: state.reviewer, builder: state.builder, approved: event.approved };
      return state;
    case "ParallelReview":
      if (event.type === "parallelReviewDone")
        return {
          name: "ParallelReviewDone",
          agents: state.agents,
          builders: state.builders,
          approved: event.approved,
          resolutionRequired: event.resolutionRequired,
        };
      return state;
    case "ReviewDone":
      if (event.type === "userSent") return beginDiscussion(event);
      if (event.type === "handBack")
        return { name: "Build", builder: state.builder };
      return state;
    case "ParallelReviewDone":
      if (event.type === "userSent") return beginDiscussion(event);
      if (event.type === "resolveReview" && state.resolutionRequired)
        return { ...state, approved: event.approved, resolutionRequired: false };
      if (event.type === "handBack") {
        if (state.builders.length === 1) return { name: "Build", builder: state.builders[0]! };
        if (state.builders.length > 1) return { name: "ParallelBuild", agents: state.builders };
        return { name: "AwaitingUser" };
      }
      return state;
  }
}

export function shouldRunParallelDiscussion(text: string, mode: DiscussionMode = "parallelOnBoth"): boolean {
  if (mode === "parallel") return true;
  if (mode === "serial") return false;

  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const patterns = [
    /\ball\s+of\s+you\b/,
    /\byou\s+all\b/,
    /\ball\s+(?:agents|heads)\b/,
    /\bboth\s+of\s+you\b/,
    /\byou\s+both\b/,
    /\bboth\s+(?:agents|heads)\b/,
    /\bboth\s+(?:please\s+)?(?:do|run|look|review|think|analy[sz]e|investigate|work|take|give|tell|answer|respond|handle)\b/,
    /\byou\s+and\s+(?:codex|claude)\s*,/,
    /\byou\s+and\s+(?:codex|claude)\s+(?:please\s+)?(?:do|run|look|review|think|analy[sz]e|investigate|work|take|give|tell|answer|respond|handle)\b/,
    /\b(?:codex\s+and\s+claude|claude\s+and\s+codex)\s*,/,
    /\b(?:codex\s+and\s+claude|claude\s+and\s+codex)\s+(?:please\s+)?(?:do|run|look|review|think|analy[sz]e|investigate|work|take|give|tell|answer|respond|handle)\b/,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}
