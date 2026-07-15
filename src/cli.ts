import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSpawn } from "./agents";
import { classifyAgentAuthority } from "./authority";
import { findExecutableOnPath } from "./executablePath";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";

export type CliProfile = "discussion" | "build" | "review";

const PROFILE_SUFFIX: Record<CliProfile, string> = {
  discussion: "Discussion",
  build: "Build",
  review: "Review",
};

const CAPABILITIES: Record<AgentId, string[]> = {
  codex: [
    "Codex CLI via hydraRoom.codexExecArgs* for this phase; Hydra passes raw native args through.",
    "Use repo/shell/MCP/plugin/model/config/search/app/remote capabilities exposed by the configured native CLI invocation.",
  ],
  claude: [
    "Claude Code CLI via hydraRoom.claudeExecArgs* for this phase; Hydra passes raw native args through.",
    "Use Bash/Edit/Read, IDE, MCP, plugins, skills, agents, memory, hooks, settings, and worktree capabilities exposed by the configured native CLI invocation.",
  ],
};

export function profileForPhase(phase: Phase): CliProfile {
  if (phase === "build") return "build";
  if (phase === "review") return "review";
  return "discussion";
}

export function argsSettingKey(agent: AgentId, phase: Phase): string {
  return `${agent}ExecArgs${PROFILE_SUFFIX[profileForPhase(phase)]}`;
}

export function expandWorkspaceArgs(args: string[], workspaceRoot: string): string[] {
  return args.map((arg) => arg.replace(/\$\{workspaceFolder\}/g, workspaceRoot));
}

export function expandWorkspaceValue(value: string, workspaceRoot: string): string {
  return value
    .replace(/\$\{workspaceFolder\}/g, workspaceRoot)
    .replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => process.env[name] ?? "");
}

export function applySpawnEnvironment(
  spawn: AgentSpawn,
  workspaceRoot: string,
  env: Record<string, string>,
  pathPrepend: string[]
): AgentSpawn {
  const expandedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.trim()) continue;
    expandedEnv[key] = expandWorkspaceValue(value, workspaceRoot);
  }
  const expandedPath = pathPrepend
    .map((entry) => expandWorkspaceValue(entry, workspaceRoot))
    .filter(Boolean);
  if (expandedPath.length > 0) {
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    const currentPath = expandedEnv[pathKey] ?? process.env[pathKey] ?? process.env.PATH ?? "";
    expandedEnv[pathKey] = [...expandedPath, currentPath].filter(Boolean).join(path.delimiter);
  }
  if (Object.keys(expandedEnv).length === 0) return spawn;
  return {
    ...spawn,
    env: {
      ...(spawn.env ?? {}),
      ...expandedEnv,
    },
  };
}

export function effectiveSpawnEnvironment(
  spawn: Pick<AgentSpawn, "env">,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...base, ...(spawn.env ?? {}) };
}

export function mergeNativeEnv(
  shared: Record<string, string>,
  agentSpecific: Record<string, string>
): Record<string, string> {
  return { ...shared, ...agentSpecific };
}

export function mergeNativePathPrepend(shared: string[], agentSpecific: string[]): string[] {
  return [...shared, ...agentSpecific];
}

export interface RequestFilePlaceholders {
  hydraPromptFile: string;
  hydraReplyFile: string;
  hydraLogFile: string;
}

export function expandRequestFileArgs(args: string[], files: RequestFilePlaceholders): string[] {
  return args.map((arg) => expandRequestFileValue(arg, files));
}

export function expandRequestFileSpawn(spawn: AgentSpawn, files: RequestFilePlaceholders): AgentSpawn {
  return {
    ...spawn,
    command: expandRequestFileValue(spawn.command, files),
    args: expandRequestFileArgs(spawn.args, files),
  };
}

export function hasRequestFilePlaceholders(spawn: AgentSpawn): boolean {
  return [spawn.command, ...spawn.args].some((value) => /\$\{hydra(?:Prompt|Reply|Log)File\}/.test(value));
}

export function splitNativeArgs(commandLine: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaping = false;

  for (let index = 0; index < commandLine.length; index++) {
    const char = commandLine[index];
    if (char === undefined) continue;
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      const next = commandLine[index + 1];
      if (next === "\\" || next === "\"" || next === "'" || /\s/.test(next ?? "")) {
        escaping = true;
      } else {
        current += char;
      }
      continue;
    }
    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (current) args.push(current);
  return args;
}

export function buildAgentSpawn(
  agent: AgentId,
  phase: Phase,
  command: string,
  rawArgs: string[],
  workspaceRoot: string
): AgentSpawn {
  assertPhaseAuthority(agent, phase, rawArgs);
  return {
    command: command || agent,
    args: expandWorkspaceArgs(rawArgs, workspaceRoot),
    cwd: workspaceRoot,
  };
}

function expandRequestFileValue(value: string, files: RequestFilePlaceholders): string {
  return value
    .replace(/\$\{hydraPromptFile\}/g, files.hydraPromptFile)
    .replace(/\$\{hydraReplyFile\}/g, files.hydraReplyFile)
    .replace(/\$\{hydraLogFile\}/g, files.hydraLogFile);
}

export async function resolveAgentCommand(
  agent: AgentId,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (hasPathSeparator(command) || path.isAbsolute(command)) return command;
  const found = await findExecutableOnPath(command, { env });
  if (found) return found;
  const fallback = shouldUseKnownAgentFallback(agent, command)
    ? await findKnownAgentExecutable(agent, env)
    : undefined;
  if (fallback) return fallback;
  throw new Error(
    `Hydra could not resolve native CLI '${command}' to an absolute executable. ` +
    "Install it on PATH or set the Hydra command setting to a full path."
  );
}

export function shouldUseKnownAgentFallback(agent: AgentId, command: string): boolean {
  return command.trim().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "") === agent;
}

export async function knownAgentExecutableCandidates(
  agent: AgentId,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<string[]> {
  if (platform !== "win32") return [];

  const home = env.USERPROFILE;
  const appData = env.APPDATA;
  const localAppData = env.LOCALAPPDATA;
  const candidates: string[] = [];

  if (agent === "claude") {
    if (home) candidates.push(path.join(home, ".local", "bin", "claude.exe"));
    if (appData) candidates.push(path.join(appData, "npm", "claude.cmd"));
    return unique(candidates);
  }

  if (agent !== "codex") {
    // Why: no bespoke install locations are known yet for gemini/custom
    // heads; return [] so resolveAgentCommand falls through to a plain
    // PATH lookup instead of guessing at codex-shaped install paths.
    return [];
  }

  if (appData) candidates.push(path.join(appData, "npm", "codex.cmd"));
  if (home) {
    candidates.push(path.join(home, ".local", "bin", "codex.exe"));
    candidates.push(path.join(home, ".local", "bin", "codex.cmd"));
    candidates.push(...await vscodeExtensionCodexCandidates(path.join(home, ".vscode", "extensions")));
    candidates.push(path.join(home, "scoop", "shims", "codex.exe"));
    candidates.push(path.join(home, "scoop", "shims", "codex.cmd"));
  }
  if (localAppData) {
    candidates.push(path.join(localAppData, "OpenAI", "Codex", "bin", "codex.exe"));
    candidates.push(path.join(localAppData, "Microsoft", "WinGet", "Links", "codex.exe"));
    candidates.push(path.join(localAppData, "Microsoft", "WinGet", "Links", "codex.cmd"));
    candidates.push(...await packagedCodexCandidates(path.join(localAppData, "Packages")));
  }
  return unique(candidates);
}

// Why: CAPABILITIES is keyed by the now-widened AgentId; an id outside the
// built-in codex/claude table (gemini, custom heads) has no vendor-specific
// capability list, so it falls back to this generic line instead of an
// empty (or crashing) summary. A function (not a static array) so the real
// agent id is interpolated into the ExecArgs setting name instead of a
// literal "{id}" placeholder leaking into the prompt.
function genericCapabilities(agent: string): string[] {
  return [
    `Native CLI via hydraRoom.${agent}ExecArgs* for this phase; Hydra passes raw native args through.`,
    "Use whatever repo/shell/model/tool capabilities the configured native CLI invocation exposes.",
  ];
}

export function nativeCapabilitySummary(agent: AgentId): string {
  return (CAPABILITIES[agent] ?? genericCapabilities(agent)).map((capability) => `- ${capability}`).join("\n");
}

// Phase authority gate. The design rule is native CLI parity:
// unknown/custom authority is allowed because the native CLIs can grow flags
// faster than Hydra can classify them. Profiles and Doctor still surface
// the effective call honestly.
export function assertPhaseAuthority(agent: AgentId, phase: Phase, args: string[]): void {
  void classifyAgentAuthority(agent, phase, args);
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

async function findKnownAgentExecutable(
  agent: AgentId,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  return firstExisting(await knownAgentExecutableCandidates(agent, env));
}

async function vscodeExtensionCodexCandidates(extensionRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(extensionRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("openai.chatgpt-"))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a))
      .map((name) => path.join(extensionRoot, name, "bin", "windows-x86_64", "codex.exe"));
  } catch {
    return [];
  }
}

async function packagedCodexCandidates(packagesRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(packagesRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("OpenAI.Codex_"))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a))
      .map((entry) =>
        path.join(packagesRoot, entry, "LocalCache", "Local", "OpenAI", "Codex", "bin", "codex.exe")
      );
  } catch {
    return [];
  }
}

async function firstExisting(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
