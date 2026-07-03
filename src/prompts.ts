import { AgentId } from "./phases";
import { displayNameFor } from "./agentRegistry";

export type Phase = "opener" | "reactor" | "closer" | "parallel" | "build" | "review";

export interface PromptInput {
  agent: AgentId;
  otherAgent: AgentId;
  phase: Phase;
  transcript: string;
  diff?: string;
  verification?: string;
  nativeCapabilities?: string;
}

const DECISION_PACKET =
  "End with a Decision Packet using these exact headings:\n" +
  "Recommendation: <one concrete recommendation>\n" +
  "Default next action: <what Hydra should do next if the user does not redirect>\n" +
  "Decision needed from user: <one narrow decision, or `none`>\n" +
  "Blockers: <real blockers, or `none`>";

const CONTEXT_HYGIENE =
  "Context hygiene: the latest user message is authoritative. If it corrects, closes, or supersedes older transcript status, do not revive the older status as active work. " +
  "Treat newer verification evidence as replacing older timeout or failure claims. " +
  "If the latest user message asks you for an exact/minimal reply, obey that exact-output request and omit the normal Decision Packet.";

const WIKI_CONTEXT_GUIDANCE =
  "Wiki context: the `--- Hydra wiki context ---` section is compiled memory. Treat it as established truth unless the latest user instruction, active transcript, or direct source evidence contradicts it; do not re-derive facts it already gives.\n" +
  "When you notice durable knowledge that is missing, stale, or contradicted in the wiki, name that gap explicitly so the wrapup loop can capture it.";

const WIKI_SOURCE_CITATION_GUIDANCE =
  "When citing or relying on a wiki fact that carries a `[src:<sha12>]` tag, reuse the matching source tag in your reply so Hydra can measure real wiki usage separately from wiki-name chatter.";

const SOURCE_HYGIENE =
  "Source hygiene: treat `.hydra/` as Hydra workspace state, not project source. Exclude `.hydra/`, `.git/`, dependency/vendor/build/cache artifacts, and generated output from broad repo crawls/searches unless the latest user request is explicitly about those artifacts. Prefer targeted `rg`/glob searches before recursive workspace crawls.";

const OPENER_RULES =
  "Operate as a live coworking terminal in the user's workspace. Do not claim consensus. " +
  "Discussion is allowed to execute work, not only plan it. If the latest user request or room objective is actionable and your native CLI authority is sufficient, inspect, edit, or run commands now before replying. " +
  "For actionable workspace requests, your reply must either cite the concrete command/file action you performed or name the specific missing authority/input that blocked action. " +
  "Treat status and orientation prompts such as `where are we at`, `what's next`, or `ok status` as actionable: inspect the workspace, recent transcript, plans, and verification evidence, then report the current state and pick one concrete next executable action. " +
  "Do not stop at naming a DRI, recommending a next step, or asking Hydra to dispatch work when you can perform that work yourself in this call. " +
  "Do not recommend waiting for a user directive unless the user explicitly told Hydra to pause or a real blocker prevents useful local work. " +
  "Only ask one narrow question or name a DRI when action is genuinely blocked by missing information, missing authority, or a required human choice. Do not list broad option menus unless the user asked for options. " +
  "Be concise; after action, summarize what you did and what remains. " +
  DECISION_PACKET;

const REACTOR_RULES =
  "Respond to the opener's latest message in the shared transcript above. " +
  "Start with exactly one of `Agree:`, `Challenge:`, `Amend:`, or `Ask user:`. " +
  "Do not pad agreement or re-open settled scope. If the opener acted, verify or review the result; if the opener only planned and the work is actionable with your authority, do useful work now instead of merely approving the plan. " +
  "If the opener answered a status/orientation prompt by waiting despite no blocker, amend by doing the missing inspection or by naming the next concrete executable action. " +
  "If you challenge, give the replacement recommendation. If you agree, tighten the next action or report verification evidence. " +
  "Use 1-3 short paragraphs before the packet. " +
  DECISION_PACKET;

const CLOSER_RULES =
  "Respond to the reactor's latest message in the shared context above. " +
  "You opened this turn, so close the loop: accept the critique, amend your recommendation, or reject it with one concrete reason. " +
  "Do not restart the debate or list new broad options. If useful work remains and your authority allows it, do it now; otherwise state the final result and default next action for the room. " +
  "The final default next action must be executable by Hydra or an agent unless a blocker or explicit user pause exists. " +
  "Use 1-2 short paragraphs before the packet. " +
  DECISION_PACKET;

const PARALLEL_RULES =
  "The user addressed both agents, so Hydra is running Codex and Claude in parallel. " +
  "Give your independent pass on the latest user request; do not wait for, answer, or claim agreement with the other agent's still-running reply. " +
  "If the request is actionable and your native CLI authority is sufficient, inspect, edit, or run commands now before replying. Use concrete evidence and avoid handing off work that you can do yourself. " +
  "For actionable workspace requests, your reply must either cite the concrete command/file action you performed or name the specific missing authority/input that blocked action. " +
  "Be concise; after action, summarize what you did and what remains. " +
  DECISION_PACKET;

const BUILD_RULES =
  "The user assigned you as builder from the Hydra room. Treat that assignment as explicit implementation authority for the current room objective and latest discussion. " +
  "Implement by editing files directly. If the prior default next action was survey or planning, the builder assignment supersedes it. " +
  "Use your native CLI tools and integrations when they help. " +
  "Respect existing user/unrelated changes. Do not commit or push. " +
  "End with a one-paragraph summary of what you changed.";

const REVIEW_RULES =
  "Builder has implemented the plan. The latest verification evidence and diff appear below the transcript. " +
  "Use your native review capabilities when they help. Review it: cite `file:line`, raise concerns, suggest changes, or end with " +
  "`APPROVED: no blockers` on its own line if you have no blockers.";

const PHASE_RULES: Record<Phase, string> = {
  opener: OPENER_RULES,
  reactor: REACTOR_RULES,
  closer: CLOSER_RULES,
  parallel: PARALLEL_RULES,
  build: BUILD_RULES,
  review: REVIEW_RULES,
};

export function buildPrompt(input: PromptInput): string {
  const me = displayNameFor(input.agent);
  const them = displayNameFor(input.otherAgent);
  const wikiContext = wikiContextBlock(input.transcript);
  const hasWikiContext = wikiContext !== undefined;
  const hasWikiSourceCitations = wikiContext ? /\[src:[a-f0-9]{12}\]/i.test(wikiContext) : false;

  const preamble = [
    `You are ${me} in Hydra Room — a 3-way collaboration with the user`,
    `and ${them}. The shared context below is Hydra's active transcript for this turn.`,
    `Do not invent prior context not in the shared context.`,
    `You are speaking to both the user and the other agent.`,
    CONTEXT_HYGIENE,
    ...(hasWikiContext ? [WIKI_CONTEXT_GUIDANCE] : []),
    ...(hasWikiContext && hasWikiSourceCitations ? [WIKI_SOURCE_CITATION_GUIDANCE] : []),
    SOURCE_HYGIENE,
    `Phase: ${input.phase}.`,
  ].join("\n");

  const parts: string[] = [preamble, "", "--- Shared context ---", input.transcript];

  if (input.nativeCapabilities?.trim()) {
    parts.push(
      "",
      `--- ${me} native CLI profile ---`,
      "Hydra invokes your real native CLI with this phase's configured authority.",
      input.nativeCapabilities.trim()
    );
  }

  if (input.phase === "review") {
    if (input.diff === undefined) throw new Error("review requires diff");
    if (input.verification?.trim()) {
      parts.push("", "--- Latest verification evidence ---", input.verification.trim());
    }
    parts.push("", "--- Diff to review (git diff HEAD) ---", input.diff);
  }

  parts.push("", PHASE_RULES[input.phase]);
  return parts.join("\n");
}

export const APPROVED_SENTINEL_RE = /^APPROVED: no blockers\s*$/m;
export const SOFT_APPROVAL_RE = /^\s*I\s*('?d|\s+would)\s+approve\b/im;

function wikiContextBlock(transcript: string): string | undefined {
  const marker = "--- Hydra wiki context ---";
  const start = transcript.indexOf(marker);
  if (start < 0) return undefined;
  const rest = transcript.slice(start);
  const fullTranscriptStart = rest.indexOf("\n--- Full transcript ---");
  return fullTranscriptStart >= 0 ? rest.slice(0, fullTranscriptStart) : rest;
}
