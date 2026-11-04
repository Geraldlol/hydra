import * as vscode from "vscode";
import {
  applySpawnEnvironment,
  effectiveSpawnEnvironment,
  mergeNativeEnv,
  mergeNativePathPrepend,
  resolveAgentCommand,
} from "./cli";
import {
  runCodexDebugModels,
  isCodexModelsTerminationError,
  saveCodexModelsSnapshot,
  type CodexModelInfo,
  type CodexModelsSnapshot,
} from "./codexModels";
import type { AgentId } from "./phases";
import {
  applyPhasedSettingChange,
  describePhasedSettingCurrent,
  phasedSettingForScope,
  type PhaseScope,
} from "./phasedSetting";

export interface ModelChooserDeps {
  workspaceRoot: string;
  codexModelsPath: string;
  getCodexModelsSnapshot(): CodexModelsSnapshot | undefined;
  setCodexModelsSnapshot(snapshot: CodexModelsSnapshot): void;
  appendSystemMessage(text: string): Promise<void>;
  postState(): void;
  onUnconfirmedTermination?(): void;
}

/**
 * Refresh the Codex model catalog by running `codex debug models` with the
 * same path/env overlay used for real Codex dispatches, then persist the
 * result to .hydra/codex-models.json so the chooser picks it up.
 */
export async function refreshCodexModelCatalog(deps: ModelChooserDeps): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("hydraRoom");
  const command = cfg.get<string>("codexCommand", "codex");
  const spawn = applySpawnEnvironment(
    { command, args: [], cwd: deps.workspaceRoot },
    deps.workspaceRoot,
    mergeNativeEnv(
      cfg.get<Record<string, string>>("nativeEnv", {}),
      cfg.get<Record<string, string>>("codexNativeEnv", {}),
    ),
    mergeNativePathPrepend(
      cfg.get<string[]>("nativePathPrepend", []),
      cfg.get<string[]>("codexNativePathPrepend", []),
    ),
  );
  const env = effectiveSpawnEnvironment(spawn);
  await deps.appendSystemMessage("Refreshing Codex model catalog via `codex debug models`…");
  try {
    const resolved = await resolveAgentCommand("codex", command, env);
    const models = await runCodexDebugModels(resolved, env);
    const snapshot: CodexModelsSnapshot = {
      fetchedAt: new Date().toISOString(),
      models,
    };
    await saveCodexModelsSnapshot(deps.codexModelsPath, snapshot);
    deps.setCodexModelsSnapshot(snapshot);
    const listable = models.filter((m) => m.visibility === "list");
    await deps.appendSystemMessage(
      `Codex model catalog refreshed: ${listable.length} listable model${listable.length === 1 ? "" : "s"} cached at \`.hydra/codex-models.json\`. The chooser will use this list until you refresh again.`,
    );
  } catch (err) {
    if (isCodexModelsTerminationError(err)) deps.onUnconfirmedTermination?.();
    const msg = err instanceof Error ? err.message : String(err);
    await deps.appendSystemMessage(
      `Codex model refresh failed: ${msg}. The chooser will keep using the built-in curated list.`,
    );
  }
  deps.postState();
}

/**
 * Interactive Hydra: Choose Model flow. Walks the user through:
 *   1. Pick an agent (Claude / Codex)
 *   2. Pick a scope (all / discussion / build / review)
 *   3. Pick a preset, type a custom ID, or refresh the catalog
 * Writes the result to hydraRoom.{agent}Model at global scope because these
 * settings are application-scoped in package.json.
 */
export async function chooseModelInteractively(deps: ModelChooserDeps): Promise<void> {
  const agentPick = await vscode.window.showQuickPick(
    [
      { label: "Claude", description: describePhasedSettingCurrent(readModelSetting("claude")), value: "claude" as AgentId },
      { label: "Codex", description: describePhasedSettingCurrent(readModelSetting("codex")), value: "codex" as AgentId },
      { label: "Gemini", description: describePhasedSettingCurrent(readModelSetting("gemini")), value: "gemini" as AgentId },
    ],
    { placeHolder: "Which agent's model do you want to change?" },
  );
  if (!agentPick) return;
  const agent = agentPick.value;
  const scopePick = await vscode.window.showQuickPick(
    [
      { label: "All phases", description: "One model for discussion, build, and review", value: "all" },
      { label: "Discussion only", description: "Opener / reactor / closer turns", value: "discussion" },
      { label: "Build only", description: "When this head is the assigned builder", value: "build" },
      { label: "Review only", description: "When this head reviews the other's diff", value: "review" },
    ],
    { placeHolder: `Scope the ${agent} model change` },
  );
  if (!scopePick) return;
  const scope = scopePick.value as PhaseScope;

  const presets = agent === "claude" ? CLAUDE_MODEL_PRESETS
    : agent === "gemini" ? GEMINI_MODEL_PRESETS
    : codexPresetsForChooser(deps.getCodexModelsSnapshot());

  const current = readModelSetting(agent);
  const currentForScope = phasedSettingForScope(current, scope);
  const snapshot = deps.getCodexModelsSnapshot();
  const catalogSuffix = agent === "codex" && snapshot
    ? ` · cached ${new Date(snapshot.fetchedAt).toLocaleString()}`
    : agent === "codex"
      ? " · cache empty — using fallback list"
      : "";
  const items: Array<{ label: string; description?: string; value: string }> = [
    { label: "(CLI default)", description: "Clear the override; let the CLI pick", value: "" },
    ...presets.map((p) => ({ label: p.label, description: p.description, value: p.label })),
    { label: "Custom…", description: "Type any model ID (e.g. a preview build the CLI accepts)", value: "__custom__" },
  ];
  if (agent === "codex") {
    items.push({
      label: "$(refresh) Refresh Codex catalog…",
      description: `Run \`codex debug models\` and update the list${catalogSuffix}`,
      value: "__refreshCodex__",
    });
  }
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: currentForScope
      ? `Current ${scope === "all" ? "(all phases)" : scope}: ${currentForScope} — pick a new model for ${agent}`
      : `Pick a model for ${agent} ${scope === "all" ? "(all phases)" : scope} (currently CLI default)`,
  });
  if (!pick) return;
  let value = pick.value;
  if (value === "__refreshCodex__") {
    await refreshCodexModelCatalog(deps);
    // Re-open the chooser so the user lands on the refreshed list
    // without re-navigating from the agent picker.
    await chooseModelInteractively(deps);
    return;
  }
  if (value === "__custom__") {
    const typed = await vscode.window.showInputBox({
      prompt: `Custom model ID for ${agent} (${scope === "all" ? "all phases" : scope})`,
      value: currentForScope,
      validateInput: (v) => (v && v.length > 200 ? "Model ID is suspiciously long" : undefined),
    });
    if (typed === undefined) return;
    value = typed.trim();
  }

  const nextSetting = applyPhasedSettingChange(current, scope, value);
  await vscode.workspace
    .getConfiguration("hydraRoom")
    .update(`${agent}Model`, nextSetting, vscode.ConfigurationTarget.Global);
  const detail = scope === "all" ? "all phases" : `${scope} phase`;
  await deps.appendSystemMessage(
    value
      ? `Model for ${agent} (${detail}) set to "${value}". Next matching dispatch will pass \`--model ${value}\`.`
      : `Model override for ${agent} (${detail}) cleared. Falls back to whatever's set for other phases, then the CLI default.`,
  );
  deps.postState();
}

// Curated Claude model presets for the chooser. Unlike Codex (which has
// `codex debug models`), the Claude Code CLI exposes no "list models" command,
// so this list is maintained by hand — keep it current with the Claude model
// catalog: https://platform.claude.com/docs/en/models/overview (2026-11-05).
// Aliases follow the current model for the CLI's provider and account; exact
// mappings can differ between the Anthropic API and other providers.
// Full IDs follow for pinning a specific version. The chooser also offers a
// free-text "Custom…" entry, so an ID missing here is never a dead end.
// Drift guard: test/modelChooserSourceContract.test.ts pins the current flagships.
const CLAUDE_MODEL_PRESETS: Array<{ label: string; description: string }> = [
  { label: "fable", description: "Alias — current Fable (most capable)" },
  { label: "sonnet", description: "Alias — current Sonnet" },
  { label: "opus", description: "Alias — current Opus" },
  { label: "haiku", description: "Alias — current Haiku" },
  { label: "claude-fable-5-1", description: "Fable 5.1 — most capable (Claude 5, Mythos-class tier above Opus)" },
  { label: "claude-mythos-5-1", description: "Mythos 5.1 — same model as Fable 5.1 (approved Project Glasswing orgs only)" },
  { label: "claude-opus-5-5", description: "Opus 5.5 — latest Opus (Claude Code 2.1.280+)" },
  { label: "claude-sonnet-5-5", description: "Sonnet 5.5 — latest Sonnet (CLI alias updated in 2.1.284)" },
  { label: "claude-haiku-5-5", description: "Haiku 5.5 — latest Haiku (CLI alias updated in 2.1.293)" },
  { label: "claude-sonnet-5", description: "Sonnet 5 (older)" },
  { label: "claude-fable-5", description: "Fable 5 (older)" },
  { label: "claude-mythos-5", description: "Mythos 5 (older; approved Project Glasswing orgs only)" },
  { label: "claude-opus-5", description: "Opus 5 (older)" },
  { label: "claude-opus-4-8", description: "Opus 4.8 (older)" },
  { label: "claude-opus-4-7", description: "Opus 4.7 (older)" },
  { label: "claude-opus-4-6", description: "Opus 4.6 (older)" },
  { label: "claude-sonnet-4-6", description: "Sonnet 4.6 (older)" },
  { label: "claude-sonnet-4-5", description: "Sonnet 4.5 (older)" },
  { label: "claude-opus-4-5", description: "Opus 4.5 (older)" },
  { label: "claude-haiku-4-5-20251001", description: "Haiku 4.5 dated build" },
  { label: "claude-haiku-4-5", description: "Haiku 4.5 alias" },
];

// Curated Gemini presets checked against the official Gemini CLI model schema
// on 2026-08-24. Prefer aliases: the CLI resolves them to the current model for
// the authenticated tier. Concrete IDs remain available for reproducibility,
// and the chooser's free-text entry covers newer/organization-specific builds.
// Drift guard: test/modelChooserSourceContract.test.ts pins the current flagship.
const GEMINI_MODEL_PRESETS: Array<{ label: string; description: string }> = [
  { label: "auto", description: "CLI-selected current model (recommended)" },
  { label: "pro", description: "Alias — current Pro tier" },
  { label: "flash", description: "Alias — current Flash tier" },
  { label: "flash-lite", description: "Alias — current Flash-Lite tier" },
  { label: "gemini-3.1-pro-preview", description: "Gemini 3.1 Pro Preview" },
  { label: "gemini-3.5-flash", description: "Gemini 3.5 Flash" },
  { label: "gemini-3.1-flash-lite", description: "Gemini 3.1 Flash-Lite" },
  { label: "gemini-2.5-pro", description: "Gemini 2.5 Pro (stable fallback)" },
  { label: "gemini-2.5-flash", description: "Gemini 2.5 Flash (stable fallback)" },
  { label: "gemini-2.5-flash-lite", description: "Gemini 2.5 Flash-Lite (stable fallback)" },
];

// Current general-purpose Codex models, checked against official documentation
// on 2026-11-05: https://developers.openai.com/codex/models
// Seed these even when a cached CLI catalog predates their release. An explicit
// catalog entry still controls visibility and supplies the live description.
const CODEX_CURRENT_MODEL_PRESETS: Array<{ label: string; description: string }> = [
  { label: "gpt-6-astra", description: "GPT-6 Astra - most capable for complex work" },
  { label: "gpt-6.1-sol", description: "GPT-6.1 Sol - current workhorse for coding and everyday work" },
  { label: "gpt-6.1-terra", description: "GPT-6.1 Terra - efficient writing and visual work (Codex CLI 0.159.0+)" },
  { label: "gpt-6-sol", description: "GPT-6 Sol - previous-generation workhorse" },
  { label: "gpt-6-luna", description: "GPT-6 Luna - fast, efficient focused tasks" },
];

function codexPresetsForChooser(
  snapshot: CodexModelsSnapshot | undefined,
): Array<{ label: string; description: string }> {
  if (snapshot && snapshot.models.length) {
    const knownSlugs = new Set(snapshot.models.map((m) => m.slug));
    const missingCurrentModels = CODEX_CURRENT_MODEL_PRESETS.filter((p) => !knownSlugs.has(p.label));
    const listable = snapshot.models.filter((m) => m.visibility === "list");
    const sorted = [...listable].sort((a, b) => a.slug.localeCompare(b.slug, "en", { numeric: true }));
    return [
      ...missingCurrentModels,
      ...sorted.map((m) => ({
        label: m.slug,
        description: codexModelDescription(m),
      })),
    ];
  }
  // Older models remain available for existing workflows and API-key users.
  // Account access still depends on the CLI, provider, and rollout.
  return [
    ...CODEX_CURRENT_MODEL_PRESETS,
    { label: "gpt-5.6-sol", description: "GPT-5.6 Sol - previous-generation coding model" },
    { label: "gpt-5.6-terra", description: "GPT-5.6 Terra - balanced capability and cost" },
    { label: "gpt-5.6-luna", description: "GPT-5.6 Luna - fastest / lowest-cost 5.6 model" },
    { label: "gpt-daybreak-blue-latest", description: "Daybreak Blue - restricted model; Daybreak program approval required" },
    { label: "gpt-5.5", description: "GPT-5.5 - API key only; retired from ChatGPT sign-in on 2026-10-14" },
    { label: "gpt-5.4", description: "GPT-5.4 - API key only; retired from ChatGPT sign-in" },
    { label: "gpt-5.4-mini", description: "GPT-5.4 Mini - API key only; retired from ChatGPT sign-in" },
  ];
}

function codexModelDescription(model: CodexModelInfo): string {
  const bits: string[] = [];
  if (model.displayName && model.displayName !== model.slug) bits.push(model.displayName);
  if (model.defaultReasoning) bits.push(`reasoning: ${model.defaultReasoning}`);
  if (!model.supportedInApi) bits.push("interactive only — no API (codex exec won't work)");
  if (model.description) bits.push((model.description.split(/[.!?]/)[0] ?? "").trim());
  return bits.join(" · ") || model.slug;
}

function readModelSetting(agent: AgentId): unknown {
  return vscode.workspace.getConfiguration("hydraRoom").get<unknown>(`${agent}Model`);
}
