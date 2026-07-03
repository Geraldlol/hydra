import type { AgentId } from "./phases";
import type { EditorContextAttachment } from "./editorContext";
import { renderEditorContextAttachment } from "./editorContext";
import { displayNameFor } from "./agentRegistry";

const SOURCE_HYGIENE =
  "Treat `.hydra/` as Hydra workspace state, not project source. Exclude `.hydra/`, `.git/`, dependency/vendor/build/cache artifacts, and generated output from broad repo crawls/searches unless the user explicitly asks about those artifacts. Prefer targeted `rg`/glob searches before recursive workspace crawls.";

export interface DirectTerminalPokePromptInput {
  agent: AgentId;
  otherAgent: AgentId;
  roomContext: string;
  instruction: string;
  editorContext?: EditorContextAttachment;
  workspaceDiff?: string;
  latestDecisionDefault?: string;
  latestVerificationSummary?: string;
}

export function buildDirectTerminalPokePrompt(input: DirectTerminalPokePromptInput): string {
  return [
    `You are ${displayNameFor(input.agent)} in Hydra Room.`,
    "",
    "This is a direct native-terminal poke from the user, not a full Hydra discussion turn.",
    `The user is speaking directly to your native ${displayNameFor(input.agent)} CLI endpoint. Do not wait for ${displayNameFor(input.otherAgent)} to answer first.`,
    "Use the native CLI capabilities available through your current Hydra command/profile. If the user asks you to build, edit, inspect, test, or review, act directly within that authority.",
    SOURCE_HYGIENE,
    "Keep the response practical. If you change files, end with what changed and what verification ran. If you cannot act, name the concrete blocker.",
    "",
    input.latestDecisionDefault ? `Latest default decision: ${input.latestDecisionDefault}` : "Latest default decision: none",
    input.latestVerificationSummary ? `Latest verification: ${input.latestVerificationSummary}` : "Latest verification: none",
    "",
    input.roomContext,
    "",
    input.editorContext ? renderEditorContextAttachment(input.editorContext) : "--- Active editor context ---\nNone attached.",
    "",
    input.workspaceDiff !== undefined ? renderWorkspaceDiffAttachment(input.workspaceDiff) : "--- Working tree diff ---\nNone attached.",
    "",
    "--- Direct user instruction ---",
    input.instruction,
  ].join("\n");
}

export function renderWorkspaceDiffAttachment(diff: string): string {
  const body = diff.trim() || "[git working tree clean]";
  return [
    "--- Working tree diff ---",
    "Source: git diff HEAD plus untracked files",
    "",
    "```diff",
    body,
    "```",
  ].join("\n");
}
