import * as fs from "node:fs/promises";
import * as cp from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

export interface NativeDataSnapshot {
  generatedAt: string;
  workspaceRoot: string;
  codex: CodexDataSummary;
  claude: ClaudeDataSummary;
}

export interface CodexDataSummary {
  home: string;
  config: Record<string, unknown>;
  enabledPlugins: string[];
  trustedWorkspace: boolean;
  modelCatalog: ModelCatalogSummary;
  stateTables: TableSummary[];
  logsTables: TableSummary[];
  sessionCount: number;
  skillNames: string[];
}

export interface ClaudeDataSummary {
  home: string;
  settings: Record<string, unknown>;
  localSettings: Record<string, unknown>;
  enabledPlugins: string[];
  installedPlugins: string[];
  marketplaces: string[];
  mcpServerNames: string[];
  policyLimits: Record<string, unknown>;
  liveSessions: LiveSessionSummary[];
  projectCount: number;
  projectTranscriptCount: number;
  projectSummaries: ClaudeProjectSummary[];
  skillNames: string[];
  commandNames: string[];
}

export interface ModelCatalogSummary {
  fetchedAt?: string;
  clientVersion?: string;
  count: number;
  models: ModelSummary[];
}

export interface ModelSummary {
  slug: string;
  displayName?: string;
  defaultReasoning?: string;
  supportedReasoning: string[];
  contextWindow?: number;
  maxContextWindow?: number;
  serviceTiers: string[];
  inputModalities: string[];
  supportsSearch?: boolean;
  supportsImages?: boolean;
  supportsParallelTools?: boolean;
  supportsVerbosity?: boolean;
  applyPatchToolType?: string;
  webSearchToolType?: string;
}

export interface TableSummary {
  name: string;
  rows?: number;
  columns: string[];
}

export interface LiveSessionSummary {
  sessionId?: string;
  cwd?: string;
  kind?: string;
  status?: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface ClaudeProjectSummary {
  project: string;
  transcriptCount: number;
  subagentTranscriptCount: number;
  subagentMetaCount: number;
  sessionIds: string[];
  firstEventTypes: string[];
  firstEventKeys: string[];
  subagentTypes: string[];
}

export function nativeDataSnapshotPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".hydra", "native-data-snapshot.md");
}

export async function collectNativeDataSnapshot(workspaceRoot: string): Promise<NativeDataSnapshot> {
  const home = os.homedir();
  const codexHome = path.join(home, ".codex");
  const claudeHome = path.join(home, ".claude");
  const codexConfig = parseTomlSummary(await readText(path.join(codexHome, "config.toml")));
  const claudeSettings = redactedJson(await readJson(path.join(claudeHome, "settings.json"), {})) as Record<string, unknown>;
  const claudeLocalSettings = redactedJson(await readJson(path.join(claudeHome, "settings.local.json"), {})) as Record<string, unknown>;
  const installedPlugins = await readJson(path.join(claudeHome, "plugins", "installed_plugins.json"), {}) as { plugins?: Record<string, unknown> };
  const knownMarketplaces = await readJson(path.join(claudeHome, "plugins", "known_marketplaces.json"), {}) as Record<string, unknown>;

  return {
    generatedAt: new Date().toISOString(),
    workspaceRoot,
    codex: {
      home: codexHome,
      config: codexConfig.publicConfig,
      enabledPlugins: codexConfig.enabledPlugins,
      trustedWorkspace: codexConfig.trustedProjects.some((project) => samePath(project, workspaceRoot)),
      modelCatalog: summarizeModelCatalog(await readJson(path.join(codexHome, "models_cache.json"), {})),
      stateTables: await sqliteTables(path.join(codexHome, "state_5.sqlite")),
      logsTables: await sqliteTables(path.join(codexHome, "logs_2.sqlite")),
      sessionCount: await countFiles(path.join(codexHome, "sessions"), ".jsonl"),
      skillNames: await childDirectoryNames(path.join(codexHome, "skills")),
    },
    claude: {
      home: claudeHome,
      settings: claudeSettings,
      localSettings: summarizeClaudeLocalSettings(claudeLocalSettings),
      enabledPlugins: enabledClaudePlugins(claudeSettings),
      installedPlugins: Object.keys(installedPlugins.plugins ?? {}).sort(),
      marketplaces: Object.keys(knownMarketplaces).sort(),
      mcpServerNames: Object.keys((claudeLocalSettings.mcpServers as Record<string, unknown> | undefined) ?? {}).sort(),
      policyLimits: redactedJson(await readJson(path.join(claudeHome, "policy-limits.json"), {})) as Record<string, unknown>,
      liveSessions: await liveClaudeSessions(path.join(claudeHome, "sessions")),
      projectCount: (await childDirectoryNames(path.join(claudeHome, "projects"))).length,
      projectTranscriptCount: await countFiles(path.join(claudeHome, "projects"), ".jsonl"),
      projectSummaries: await claudeProjectSummaries(path.join(claudeHome, "projects")),
      skillNames: await childDirectoryNames(path.join(claudeHome, "skills")),
      commandNames: (await listFiles(path.join(claudeHome, "commands"), ".md")).map((name) => path.basename(name, ".md")).sort(),
    },
  };
}

export async function writeNativeDataSnapshot(filePath: string, markdown: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, markdown, "utf8");
}

export function renderNativeDataSnapshot(snapshot: NativeDataSnapshot): string {
  const lines = [
    "# Hydra Native Data Snapshot",
    "",
    `Generated: ${snapshot.generatedAt}`,
    `Workspace: ${snapshot.workspaceRoot}`,
    "",
    "## Codex",
    "",
    `Home: ${snapshot.codex.home}`,
    `Trusted workspace: ${snapshot.codex.trustedWorkspace ? "yes" : "no"}`,
    `Enabled plugins: ${list(snapshot.codex.enabledPlugins)}`,
    `Skills: ${list(snapshot.codex.skillNames)}`,
    "",
    "### Codex Config",
    "",
    codeBlock(stableJson(snapshot.codex.config), "json"),
    "",
    "### Codex Model Catalog",
    "",
    `Fetched: ${snapshot.codex.modelCatalog.fetchedAt ?? "unknown"}`,
    `Client version: ${snapshot.codex.modelCatalog.clientVersion ?? "unknown"}`,
    `Models: ${snapshot.codex.modelCatalog.count}`,
    ...snapshot.codex.modelCatalog.models.map((model) =>
      `- ${model.slug}${model.displayName ? ` (${model.displayName})` : ""}: reasoning=${model.defaultReasoning ?? "unknown"} [${list(model.supportedReasoning)}], context=${model.contextWindow ?? "unknown"}, max=${model.maxContextWindow ?? "unknown"}, tiers=${list(model.serviceTiers)}, modalities=${list(model.inputModalities)}, search=${model.supportsSearch ? "yes" : "no"}, images=${model.supportsImages ? "yes" : "no"}, parallelTools=${model.supportsParallelTools ? "yes" : "no"}, verbosity=${model.supportsVerbosity ? "yes" : "no"}, applyPatch=${model.applyPatchToolType ?? "unknown"}, webSearch=${model.webSearchToolType ?? "unknown"}`
    ),
    "",
    "### Codex Model Capability Matrix",
    "",
    ...renderModelCapabilityMatrix(snapshot.codex.modelCatalog.models),
    "",
    "### Codex State Tables",
    "",
    ...renderTables(snapshot.codex.stateTables),
    "",
    "### Codex Log Tables",
    "",
    ...renderTables(snapshot.codex.logsTables),
    "",
    `Codex session files: ${snapshot.codex.sessionCount}`,
    "",
    "## Claude",
    "",
    `Home: ${snapshot.claude.home}`,
    `Enabled plugins: ${list(snapshot.claude.enabledPlugins)}`,
    `Installed plugins: ${list(snapshot.claude.installedPlugins)}`,
    `Marketplaces: ${list(snapshot.claude.marketplaces)}`,
    `MCP servers: ${list(snapshot.claude.mcpServerNames)}`,
    `Skills: ${list(snapshot.claude.skillNames)}`,
    `Commands: ${list(snapshot.claude.commandNames)}`,
    `Project roots: ${snapshot.claude.projectCount}`,
    `Project transcript files: ${snapshot.claude.projectTranscriptCount}`,
    "",
    "### Claude Settings",
    "",
    codeBlock(stableJson(snapshot.claude.settings), "json"),
    "",
    "### Claude Local Settings",
    "",
    codeBlock(stableJson(snapshot.claude.localSettings), "json"),
    "",
    "### Claude Policy Limits",
    "",
    codeBlock(stableJson(snapshot.claude.policyLimits), "json"),
    "",
    "### Claude Live Sessions",
    "",
    ...renderLiveSessions(snapshot.claude.liveSessions),
    "",
    "### Claude Projects",
    "",
    ...renderClaudeProjects(snapshot.claude.projectSummaries),
    "",
    "## Redaction",
    "",
    "Credential files, auth tokens, raw transcript bodies, shell snapshots, and large log payloads are intentionally omitted.",
    "",
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

export function redactedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactedJson);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? "[REDACTED]" : redactedJson(child);
  }
  return out;
}

function renderTables(tables: TableSummary[]): string[] {
  if (tables.length === 0) return ["No table metadata captured."];
  return tables.map((table) => `- ${table.name}: rows=${table.rows ?? "unknown"}, columns=${list(table.columns)}`);
}

function renderLiveSessions(sessions: LiveSessionSummary[]): string[] {
  if (sessions.length === 0) return ["No live session metadata captured."];
  return sessions.map((session) =>
    `- ${session.sessionId ?? "unknown"}: ${session.kind ?? "unknown"} ${session.status ?? "unknown"} cwd=${session.cwd ?? "unknown"} updated=${session.updatedAt ?? session.startedAt ?? "unknown"}`
  );
}

function renderClaudeProjects(projects: ClaudeProjectSummary[]): string[] {
  if (projects.length === 0) return ["No Claude project metadata captured."];
  return projects.map((project) =>
    `- ${project.project}: transcripts=${project.transcriptCount}, subagentTranscripts=${project.subagentTranscriptCount}, subagentMeta=${project.subagentMetaCount}, sessions=${list(project.sessionIds)}, firstEventTypes=${list(project.firstEventTypes)}, firstEventKeys=${list(project.firstEventKeys)}, subagentTypes=${list(project.subagentTypes)}`
  );
}

function renderModelCapabilityMatrix(models: ModelSummary[]): string[] {
  if (models.length === 0) return ["No model capability metadata captured."];
  return [
    `Search-capable: ${list(models.filter((model) => model.supportsSearch).map((model) => model.slug))}`,
    `Image-capable: ${list(models.filter((model) => model.supportsImages).map((model) => model.slug))}`,
    `Parallel tools: ${list(models.filter((model) => model.supportsParallelTools).map((model) => model.slug))}`,
    `Verbosity control: ${list(models.filter((model) => model.supportsVerbosity).map((model) => model.slug))}`,
    `Apply patch tool: ${list(models.filter((model) => model.applyPatchToolType).map((model) => `${model.slug}:${model.applyPatchToolType}`))}`,
    `Service tiers: ${list(models.flatMap((model) => model.serviceTiers.map((tier) => `${model.slug}:${tier}`)))}`,
  ];
}

function codeBlock(value: string, language: string): string {
  return `\`\`\`${language}\n${value}\n\`\`\``;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(flatKeys(value)).sort(), 2);
}

function flatKeys(value: unknown, keys: Record<string, true> = {}): Record<string, true> {
  if (Array.isArray(value)) {
    for (const item of value) flatKeys(item, keys);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      keys[key] = true;
      flatKeys(child, keys);
    }
  }
  return keys;
}

function list(values: string[]): string {
  return values.length ? values.join(", ") : "none";
}

function isSensitiveKey(key: string): boolean {
  // Why: covers header-credential shapes a hydraRoom.agents `headers` map can
  // carry (e.g. "X-Auth-Key", "Authentication", "WWW-Authenticate", bare
  // "Auth") beyond the "authorization"/"bearer" literals already matched.
  // `\bauth\b` is boundary-guarded so it doesn't also catch "author"/"authorId".
  return /(access|refresh|api[_-]?key|apikey|token|secret|password|passphrase|credential|authorization|authenticat|\bauth\b|bearer|private[_-]?key|ssh[_-]?key|signature|cookie)/i.test(key);
}

async function readText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readJson(filePath: string, fallback: unknown): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function parseTomlSummary(text: string): {
  publicConfig: Record<string, unknown>;
  enabledPlugins: string[];
  trustedProjects: string[];
} {
  const publicConfig: Record<string, unknown> = {};
  const enabledPlugins: string[] = [];
  const trustedProjects: string[] = [];
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      const plugin = section.match(/^plugins\."(.+)"$/);
      const project = section.match(/^projects\.'(.+)'$/);
      if (plugin?.[1] !== undefined) enabledPlugins.push(plugin[1]);
      if (project?.[1] !== undefined) trustedProjects.push(project[1]);
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    if (key === undefined) continue;
    const value = parseTomlValue(keyMatch[2] ?? "");
    if (!section) {
      publicConfig[key] = value;
    } else if (section === "windows") {
      publicConfig.windows = { ...((publicConfig.windows as Record<string, unknown> | undefined) ?? {}), [key]: value };
    } else if (section.startsWith("marketplaces.")) {
      const marketplace = section.slice("marketplaces.".length);
      const current = (publicConfig.marketplaces as Record<string, unknown> | undefined) ?? {};
      current[marketplace] = { ...((current[marketplace] as Record<string, unknown> | undefined) ?? {}), [key]: value };
      publicConfig.marketplaces = current;
    }
  }
  return {
    publicConfig: redactedJson(publicConfig) as Record<string, unknown>,
    enabledPlugins: enabledPlugins.sort(),
    trustedProjects,
  };
}

function parseTomlValue(raw: string): unknown {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  const quoted = value.match(/^"(.*)"$/);
  return quoted ? quoted[1] : value;
}

function summarizeModelCatalog(value: unknown): ModelCatalogSummary {
  const catalog = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const models = Array.isArray(catalog.models) ? catalog.models as Record<string, unknown>[] : [];
  return {
    fetchedAt: typeof catalog.fetched_at === "string" ? catalog.fetched_at : undefined,
    clientVersion: typeof catalog.client_version === "string" ? catalog.client_version : undefined,
    count: models.length,
    models: models.slice(0, 12).map((model) => {
      const inputModalities = Array.isArray(model.input_modalities)
        ? model.input_modalities.filter((item): item is string => typeof item === "string")
        : [];
      return {
        slug: String(model.slug ?? "unknown"),
        displayName: typeof model.display_name === "string" ? model.display_name : undefined,
        defaultReasoning: typeof model.default_reasoning_level === "string" ? model.default_reasoning_level : undefined,
        supportedReasoning: summarizeReasoningLevels(model.supported_reasoning_levels),
        contextWindow: typeof model.context_window === "number" ? model.context_window : undefined,
        maxContextWindow: typeof model.max_context_window === "number" ? model.max_context_window : undefined,
        serviceTiers: summarizeServiceTiers(model.service_tiers),
        inputModalities,
        supportsSearch: model.supports_search_tool === true,
        supportsImages: inputModalities.includes("image"),
        supportsParallelTools: model.supports_parallel_tool_calls === true,
        supportsVerbosity: model.support_verbosity === true,
        applyPatchToolType: typeof model.apply_patch_tool_type === "string" ? model.apply_patch_tool_type : undefined,
        webSearchToolType: typeof model.web_search_tool_type === "string" ? model.web_search_tool_type : undefined,
      };
    }),
  };
}

function summarizeReasoningLevels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      const effort = (item as Record<string, unknown>).effort;
      if (typeof effort === "string") return effort;
    }
    return "";
  }).filter(Boolean).sort();
}

function summarizeServiceTiers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      if (typeof record.id === "string") return record.id;
      if (typeof record.name === "string") return record.name;
    }
    return "";
  }).filter(Boolean).sort();
}

function summarizeClaudeLocalSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const clone = redactedJson(settings) as Record<string, unknown>;
  if (clone.mcpServers && typeof clone.mcpServers === "object") {
    clone.mcpServers = Object.fromEntries(Object.keys(clone.mcpServers as Record<string, unknown>).sort().map((name) => [name, "[configured]"]));
  }
  return clone;
}

function enabledClaudePlugins(settings: Record<string, unknown>): string[] {
  const enabled = settings.enabledPlugins;
  if (!enabled || typeof enabled !== "object") return [];
  return Object.entries(enabled as Record<string, unknown>)
    .filter(([, value]) => value === true)
    .map(([name]) => name)
    .sort();
}

async function liveClaudeSessions(dir: string): Promise<LiveSessionSummary[]> {
  const files = await listFiles(dir, ".json");
  const sessions: LiveSessionSummary[] = [];
  for (const file of files.slice(0, 20)) {
    const value = await readJson(file, {});
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    sessions.push({
      sessionId: stringValue(item.sessionId),
      cwd: stringValue(item.cwd),
      kind: stringValue(item.kind),
      status: stringValue(item.status),
      startedAt: stringValue(item.startedAt),
      updatedAt: stringValue(item.updatedAt),
    });
  }
  return sessions;
}

async function claudeProjectSummaries(dir: string): Promise<ClaudeProjectSummary[]> {
  const projects = await childDirectoryNames(dir);
  const summaries: ClaudeProjectSummary[] = [];
  for (const project of projects.slice(0, 20)) {
    const projectDir = path.join(dir, project);
    const topLevelTranscripts = await topLevelFiles(projectDir, ".jsonl");
    const subagentTranscripts = (await listFiles(projectDir, ".jsonl")).filter((file) => file.includes(`${path.sep}subagents${path.sep}`));
    const subagentMetaFiles = await listFiles(projectDir, ".meta.json");
    const firstEvents = await Promise.all(topLevelTranscripts.slice(0, 10).map(firstJsonLine));
    const metaValues = await Promise.all(subagentMetaFiles.slice(0, 20).map((file) => readJson(file, {})));
    summaries.push({
      project,
      transcriptCount: topLevelTranscripts.length,
      subagentTranscriptCount: subagentTranscripts.length,
      subagentMetaCount: subagentMetaFiles.length,
      sessionIds: uniqueSorted(firstEvents.map((event) => stringValue(event?.sessionId))),
      firstEventTypes: uniqueSorted(firstEvents.map((event) => stringValue(event?.type))),
      firstEventKeys: uniqueSorted(firstEvents.flatMap((event) => event ? Object.keys(event) : [])),
      subagentTypes: uniqueSorted(metaValues.map((value) =>
        value && typeof value === "object" ? stringValue((value as Record<string, unknown>).agentType) : undefined
      )),
    });
  }
  return summaries;
}

async function sqliteTables(filePath: string): Promise<TableSummary[]> {
  try {
    await fs.access(filePath);
  } catch {
    return [];
  }
  // Why: table names come from the DB's own sqlite_master and are therefore
  // untrusted identifiers. Even in read-only mode, bare f-string interpolation
  // into `pragma table_info("{name}")` / `select count(*) from "{name}"` lets a
  // name containing a double-quote break out of the quoted identifier. q()
  // wraps the name in double quotes and doubles any embedded quote — the SQL
  // standard escape for a quoted identifier — closing that gap.
  const script = [
    "import json, sqlite3, sys",
    "p=sys.argv[1]",
    "con=sqlite3.connect(f'file:{p}?mode=ro', uri=True)",
    "cur=con.cursor()",
    "def q(n): return '\"' + n.replace('\"', '\"\"') + '\"'",
    "out=[]",
    "for (name,) in cur.execute(\"select name from sqlite_master where type='table' order by name\").fetchall():",
    "    cols=[r[1] for r in cur.execute(f'pragma table_info({q(name)})').fetchall()]",
    "    try:",
    "        rows=cur.execute(f'select count(*) from {q(name)}').fetchone()[0]",
    "    except Exception:",
    "        rows=None",
    "    out.append({'name':name,'columns':cols,'rows':rows})",
    "print(json.dumps(out))",
  ].join("\n");
  const output = await execFile("python", ["-c", script, filePath]);
  if (!output) return [];
  try {
    return JSON.parse(output) as TableSummary[];
  } catch {
    return [];
  }
}

async function childDirectoryNames(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function countFiles(dir: string, extension: string): Promise<number> {
  return (await listFiles(dir, extension)).length;
}

async function listFiles(dir: string, extension: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        found.push(full);
      }
    }
  }
  await walk(dir);
  return found.sort();
}

async function topLevelFiles(dir: string, extension: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function firstJsonLine(filePath: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(filePath);
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return undefined;
  try {
    const value = JSON.parse(firstLine);
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function uniqueSorted(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))].sort();
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function execFile(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    cp.execFile(command, args, { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      resolve(err ? "" : stdout.trim());
    });
  });
}
