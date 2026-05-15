import * as vscode from "vscode";
import type { AgentId } from "./phases";
import {
  applyPhasedSettingChange,
  describePhasedSettingCurrent,
  phasedSettingForScope,
  type PhaseScope,
} from "./phasedSetting";

export interface EffortChooserDeps {
  appendSystemMessage(text: string): Promise<void>;
  postState(): void;
}

/**
 * Interactive Hydra: Choose Thinking Level flow. Same agent/scope/value
 * walk as the model chooser, but writes to hydraRoom.claudeEffort or
 * hydraRoom.codexReasoning depending on the agent. Claude supports an
 * extra `max` level above `xhigh`; Codex caps at `xhigh`.
 */
export async function chooseEffortInteractively(deps: EffortChooserDeps): Promise<void> {
  const agentPick = await vscode.window.showQuickPick(
    [
      { label: "Claude", description: describePhasedSettingCurrent(readEffortSetting("claude")), value: "claude" as AgentId },
      { label: "Codex", description: describePhasedSettingCurrent(readEffortSetting("codex")), value: "codex" as AgentId },
    ],
    { placeHolder: "Which agent's thinking level do you want to change?" },
  );
  if (!agentPick) return;
  const agent = agentPick.value;
  const scopePick = await vscode.window.showQuickPick(
    [
      { label: "All phases", description: "One level for discussion, build, and review", value: "all" },
      { label: "Discussion only", description: "Opener / reactor / closer turns", value: "discussion" },
      { label: "Build only", description: "When this head is the assigned builder", value: "build" },
      { label: "Review only", description: "When this head reviews the other's diff", value: "review" },
    ],
    { placeHolder: `Scope the ${agent} thinking level change` },
  );
  if (!scopePick) return;
  const scope = scopePick.value as PhaseScope;

  const presets = agent === "claude" ? [...BASE_LEVELS, CLAUDE_MAX] : BASE_LEVELS;
  const currentRaw = readEffortSetting(agent);
  const currentForScope = phasedSettingForScope(currentRaw, scope);
  const items: Array<{ label: string; description?: string; value: string }> = [
    { label: "(CLI default)", description: "Clear the override; let the CLI/model pick", value: "" },
    ...presets.map((p) => ({ label: p.label, description: p.description, value: p.label })),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: currentForScope
      ? `Current ${scope === "all" ? "(all phases)" : scope}: ${currentForScope} — pick a thinking level for ${agent}`
      : `Pick a thinking level for ${agent} ${scope === "all" ? "(all phases)" : scope} (currently CLI default)`,
  });
  if (!pick) return;
  const next = applyPhasedSettingChange(currentRaw, scope, pick.value);
  const settingKey = agent === "claude" ? "claudeEffort" : "codexReasoning";
  await vscode.workspace
    .getConfiguration("hydraRoom")
    .update(settingKey, next, vscode.ConfigurationTarget.Workspace);
  const detail = scope === "all" ? "all phases" : `${scope} phase`;
  const flag = agent === "claude" ? `--effort ${pick.value}` : `-c model_reasoning_effort="${pick.value}"`;
  await deps.appendSystemMessage(
    pick.value
      ? `Thinking level for ${agent} (${detail}) set to "${pick.value}". Next matching dispatch will pass \`${flag}\`.`
      : `Thinking level override for ${agent} (${detail}) cleared.`,
  );
  deps.postState();
}

const BASE_LEVELS = [
  { label: "low", description: "Fast, less deliberation" },
  { label: "medium", description: "Balanced (CLI default for most models)" },
  { label: "high", description: "Greater reasoning depth" },
  { label: "xhigh", description: "Extra-high — slower, more thorough" },
];

const CLAUDE_MAX = { label: "max", description: "Claude-only — maximum effort" };

function readEffortSetting(agent: AgentId): unknown {
  const key = agent === "claude" ? "claudeEffort" : "codexReasoning";
  return vscode.workspace.getConfiguration("hydraRoom").get<unknown>(key);
}
