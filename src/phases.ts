export type AgentId = "codex" | "claude";
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
  | { name: "Review"; reviewer: AgentId }
  | { name: "ParallelReview"; agents: ReadonlyArray<AgentId> }
  | { name: "ReviewDone"; reviewer: AgentId; approved: boolean }
  | { name: "ParallelReviewDone"; agents: ReadonlyArray<AgentId>; approved: boolean };

export type Event =
  | { type: "userSent"; opener: AgentId; parallel?: boolean }
  | { type: "openerDone" }
  | { type: "reactorDone" }
  | { type: "closerDone" }
  | { type: "parallelDone" }
  | { type: "assignBuilder"; builder: AgentId }
  | { type: "assignBuilders"; agents: ReadonlyArray<AgentId> }
  | { type: "buildDone" }
  | { type: "parallelBuildDone" }
  | { type: "requestReview" }
  | { type: "reviewDone"; approved: boolean }
  | { type: "parallelReviewDone"; approved: boolean }
  | { type: "handBack" }
  | { type: "requestReviewSkipped" }
  | { type: "stop" };

const otherAgent = (a: AgentId): AgentId => (a === "codex" ? "claude" : "codex");

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
  if (event.type === "stop") {
    return isInFlight(state) ? { name: "AwaitingUser" } : state;
  }

  switch (state.name) {
    case "Idle":
      if (event.type === "userSent" && event.parallel) return { name: "ParallelDiscussion", agents: ["codex", "claude"] };
      if (event.type === "userSent") return { name: "Opener", opener: event.opener, reactor: otherAgent(event.opener) };
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
      if (event.type === "userSent" && event.parallel) return { name: "ParallelDiscussion", agents: ["codex", "claude"] };
      if (event.type === "userSent") return { name: "Opener", opener: event.opener, reactor: otherAgent(event.opener) };
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
      if (event.type === "userSent" && event.parallel) return { name: "ParallelDiscussion", agents: ["codex", "claude"] };
      if (event.type === "userSent") return { name: "Opener", opener: event.opener, reactor: otherAgent(event.opener) };
      if (event.type === "requestReview")
        return { name: "Review", reviewer: otherAgent(state.builder) };
      if (event.type === "requestReviewSkipped") return { name: "AwaitingUser" };
      return state;
    case "ParallelBuildDone":
      if (event.type === "userSent" && event.parallel) return { name: "ParallelDiscussion", agents: ["codex", "claude"] };
      if (event.type === "userSent") return { name: "Opener", opener: event.opener, reactor: otherAgent(event.opener) };
      if (event.type === "requestReview")
        return { name: "ParallelReview", agents: state.agents };
      if (event.type === "requestReviewSkipped") return { name: "AwaitingUser" };
      return state;
    case "Review":
      if (event.type === "reviewDone")
        return { name: "ReviewDone", reviewer: state.reviewer, approved: event.approved };
      return state;
    case "ParallelReview":
      if (event.type === "parallelReviewDone")
        return { name: "ParallelReviewDone", agents: state.agents, approved: event.approved };
      return state;
    case "ReviewDone":
      if (event.type === "userSent" && event.parallel) return { name: "ParallelDiscussion", agents: ["codex", "claude"] };
      if (event.type === "userSent") return { name: "Opener", opener: event.opener, reactor: otherAgent(event.opener) };
      if (event.type === "handBack")
        return { name: "Build", builder: otherAgent(state.reviewer) };
      return state;
    case "ParallelReviewDone":
      if (event.type === "userSent" && event.parallel) return { name: "ParallelDiscussion", agents: ["codex", "claude"] };
      if (event.type === "userSent") return { name: "Opener", opener: event.opener, reactor: otherAgent(event.opener) };
      if (event.type === "handBack")
        return { name: "ParallelBuild", agents: state.agents };
      return state;
  }
}

export function shouldRunParallelDiscussion(text: string, mode: DiscussionMode = "parallelOnBoth"): boolean {
  if (mode === "parallel") return true;
  if (mode === "serial") return false;

  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const patterns = [
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
