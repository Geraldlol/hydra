import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile, ensureFile, serializePerFile } from "./fileQueue";

export const HYDRA_WIKI_DIR = path.join(".hydra", "wiki");

export interface HydraWikiPromptFile {
  relativePath: string;
  label: string;
}

export interface HydraWikiPromptContext {
  markdown: string;
  files: string[];
  originalChars: number;
  truncated: boolean;
}

export interface HydraWikiFiles {
  schema: string;
  context: string;
  index: string;
  log: string;
}

export interface HydraWikiWrapupSource {
  markdown: string;
  key: string;
  originalChars: number;
  truncated: boolean;
}

export interface HydraWikiWrapupDraft {
  changed: boolean;
  title: string;
  contextMarkdown?: string;
  indexMarkdown?: string;
  logEntryMarkdown?: string;
}

export interface AppliedHydraWikiWrapup {
  changed: boolean;
  title: string;
  contextChanged: boolean;
  indexChanged: boolean;
  logAppended: boolean;
}

export interface HydraWikiWrapupPromptInput {
  nowIso: string;
  files: HydraWikiFiles;
  source: HydraWikiWrapupSource;
}

export interface HydraWikiWrapupMessage {
  role: "user" | "codex" | "claude" | "system";
  text: string;
  timestamp: string;
  phase?: string;
}

export const HYDRA_WIKI_PROMPT_FILES: HydraWikiPromptFile[] = [
  { relativePath: path.join(HYDRA_WIKI_DIR, "context.md"), label: "context.md" },
  { relativePath: path.join(HYDRA_WIKI_DIR, "index.md"), label: "index.md" },
  { relativePath: path.join(HYDRA_WIKI_DIR, "log.md"), label: "log.md" },
];

const DEFAULT_WIKI_FILES: Record<string, string> = {
  [path.join(HYDRA_WIKI_DIR, "schema.md")]: `# Hydra Wiki Schema

Hydra wiki is the persistent compiled layer for room knowledge. It should let future agent turns read durable synthesis first instead of rediscovering the same transcript and artifact details every time.

## Layers

- Raw sources: transcript, decisions, verification records, native action logs, agent call traces, user-provided docs, and linked sources. Treat them as history and evidence.
- Wiki core: markdown pages in \`.hydra/wiki/\` owned by the agents. Keep durable facts, architecture notes, decisions, contradictions, open questions, and stable workflows here.
- Schema: this file. Update it when the maintenance workflow changes.

## Operations

- Ingest: read one source, extract durable information, update relevant wiki pages, update \`index.md\`, and append \`log.md\`.
- Query: read \`context.md\` and \`index.md\` first, then drill into wiki pages or raw sources only as needed.
- Wrapup: after a substantial room turn, fold durable facts into \`context.md\`, add or update page links, and append \`log.md\`.
- Lint: flag contradictions, stale claims, orphan pages, missing links, and unresolved questions.

## Prompt Budget Rule

Prefer updating wiki synthesis once over rediscovering the same facts on every turn. The latest user instruction and active transcript still override older wiki claims.
`,
  [path.join(HYDRA_WIKI_DIR, "context.md")]: `# Hydra Wiki Context

This page is the compact, durable synthesis Hydra injects into agent prompts when it contains real content. Replace this starter text with stable project facts, working conventions, current architecture, open questions, and hard-won lessons that should survive transcript archival.
`,
  [path.join(HYDRA_WIKI_DIR, "index.md")]: `# Hydra Wiki Index

List wiki pages here with a one-line summary and useful tags. Hydra reads this after \`context.md\` so agents can open only the relevant pages.
`,
  [path.join(HYDRA_WIKI_DIR, "log.md")]: `# Hydra Wiki Log

Append entries like:

## [2026-05-21] wrapup | Short Title

- Updated: [[context]]
- Sources: transcript, decision packet, verification result
`,
};

export function hydraWikiContextPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, HYDRA_WIKI_DIR, "context.md");
}

export async function ensureHydraWikiFiles(workspaceRoot: string): Promise<void> {
  for (const [relativePath, content] of Object.entries(DEFAULT_WIKI_FILES)) {
    await ensureFile(path.join(workspaceRoot, relativePath), content);
  }
}

export async function readHydraWikiFiles(workspaceRoot: string): Promise<HydraWikiFiles> {
  await ensureHydraWikiFiles(workspaceRoot);
  return {
    schema: await readFileOrDefault(workspaceRoot, "schema.md"),
    context: await readFileOrDefault(workspaceRoot, "context.md"),
    index: await readFileOrDefault(workspaceRoot, "index.md"),
    log: await readFileOrDefault(workspaceRoot, "log.md"),
  };
}

export function readHydraWikiPromptContext(
  workspaceRoot: string,
  maxChars: number
): HydraWikiPromptContext | undefined {
  const cap = Math.max(0, Math.floor(maxChars));
  if (cap <= 0) return undefined;

  const sections: string[] = [];
  const files: string[] = [];
  let originalChars = 0;

  for (const source of HYDRA_WIKI_PROMPT_FILES) {
    const absolutePath = path.join(workspaceRoot, source.relativePath);
    const text = readFileIfExists(absolutePath);
    const trimmed = text.trim();
    if (!trimmed || isDefaultWikiTemplate(source.relativePath, text)) continue;
    originalChars += trimmed.length;
    files.push(source.relativePath.split(path.sep).join("/"));
    sections.push(`### ${source.label}\n\n${trimmed}`);
  }

  if (sections.length === 0) return undefined;

  const body = sections.join("\n\n");
  const clipped = truncateMarkdown(body, cap);
  return {
    markdown: [
      "--- Hydra wiki context ---",
      "Persistent compiled room knowledge from `.hydra/wiki/`. Use it before re-deriving older facts; latest user instructions and the active transcript still win on conflict.",
      `Files: ${files.join(", ")}`,
      "",
      clipped.markdown,
    ].join("\n"),
    files,
    originalChars,
    truncated: clipped.truncated,
  };
}

function readFileIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    // Wiki files are optional until the user initializes them.
    return "";
  }
}

function isDefaultWikiTemplate(relativePath: string, text: string): boolean {
  const template = DEFAULT_WIKI_FILES[relativePath];
  return !!template && text.trim() === template.trim();
}

function truncateMarkdown(markdown: string, maxChars: number): { markdown: string; truncated: boolean } {
  if (markdown.length <= maxChars) return { markdown, truncated: false };
  const suffix = "\n[... truncated by Hydra wikiContextMaxChars ...]";
  return {
    markdown: `${markdown.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`,
    truncated: true,
  };
}

export function hydraWikiWrapupSourceFromMessages(
  messages: HydraWikiWrapupMessage[],
  maxChars: number
): HydraWikiWrapupSource | undefined {
  const lastUserIndex = findLastIndex(messages, (message) => message.role === "user");
  if (lastUserIndex < 0) return undefined;
  const turnMessages = messages.slice(lastUserIndex).filter((message) => message.text.trim());
  if (turnMessages.length < 2) return undefined;

  const body = turnMessages.map(formatWrapupMessage).join("\n\n").trim();
  if (!body) return undefined;
  const originalChars = body.length;
  const capped = truncateForWrapupSource(body, Math.max(0, Math.floor(maxChars)));
  return {
    markdown: capped.markdown,
    key: stableWrapupKey(turnMessages),
    originalChars,
    truncated: capped.truncated,
  };
}

export function buildHydraWikiWrapupPrompt(input: HydraWikiWrapupPromptInput): string {
  const logTail = tailMarkdown(input.files.log, 6000);
  return [
    "You maintain Hydra's persistent `.hydra/wiki` memory using the LLM Wiki pattern: compile durable knowledge once, keep the wiki current, and avoid re-deriving old context every future turn.",
    "",
    "Task: update the wiki from the just-finished Hydra room turn.",
    "",
    "Rules:",
    "- Keep only durable project knowledge, decisions, conventions, recurring user preferences, architecture facts, unresolved questions, and reusable workflow lessons.",
    "- Drop ephemeral chat filler, greetings, transient progress, and facts that are only useful for the current minute.",
    "- If the turn creates no durable wiki value, return `changed: false` and leave the markdown fields empty.",
    "- `contextMarkdown` and `indexMarkdown` must be full replacement file contents when changed, not patches.",
    "- Keep `context.md` compact. It is injected into future prompts.",
    "- Update `index.md` only when it helps future agents navigate the wiki.",
    "- `logEntryMarkdown` is appended to `log.md`; use a heading like `## [YYYY-MM-DD] wrapup | Short Title`.",
    "- Return JSON only. No markdown fence, no prose.",
    "",
    "JSON shape:",
    `{"changed":true,"title":"Short Title","contextMarkdown":"# Hydra Wiki Context\\n\\n...","indexMarkdown":"# Hydra Wiki Index\\n\\n...","logEntryMarkdown":"## [${input.nowIso.slice(0, 10)}] wrapup | Short Title\\n\\n- Updated: [[context]]\\n- Sources: active room turn"}`,
    "",
    "Current time:",
    input.nowIso,
    "",
    "--- schema.md ---",
    input.files.schema.trim(),
    "",
    "--- existing context.md ---",
    input.files.context.trim(),
    "",
    "--- existing index.md ---",
    input.files.index.trim(),
    "",
    "--- log.md tail ---",
    logTail.trim(),
    "",
    "--- just-finished room turn ---",
    input.source.markdown,
  ].join("\n");
}

export function parseHydraWikiWrapupResponse(text: string): HydraWikiWrapupDraft | undefined {
  const jsonText = extractJsonObject(text.trim());
  if (!jsonText) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const value = parsed as Record<string, unknown>;
  const changed = value.changed === true;
  const title = sanitizeTitle(typeof value.title === "string" ? value.title : "");
  const contextMarkdown = optionalMarkdown(value.contextMarkdown);
  const indexMarkdown = optionalMarkdown(value.indexMarkdown);
  const logEntryMarkdown = optionalMarkdown(value.logEntryMarkdown);
  if (!changed) return { changed: false, title: title || "No durable update" };
  if (!title) return undefined;
  if (!contextMarkdown && !indexMarkdown && !logEntryMarkdown) return undefined;
  return {
    changed,
    title,
    contextMarkdown,
    indexMarkdown,
    logEntryMarkdown,
  };
}

export async function applyHydraWikiWrapupDraft(
  workspaceRoot: string,
  draft: HydraWikiWrapupDraft,
  nowIso: string
): Promise<AppliedHydraWikiWrapup> {
  await ensureHydraWikiFiles(workspaceRoot);
  const title = sanitizeTitle(draft.title) || "Hydra wrapup";
  if (!draft.changed) {
    return { changed: false, title, contextChanged: false, indexChanged: false, logAppended: false };
  }

  const contextPath = wikiFilePath(workspaceRoot, "context.md");
  const indexPath = wikiFilePath(workspaceRoot, "index.md");
  const logPath = wikiFilePath(workspaceRoot, "log.md");

  const contextChanged = await writeWikiFileIfChanged(contextPath, draft.contextMarkdown);
  const indexChanged = await writeWikiFileIfChanged(indexPath, draft.indexMarkdown);
  const logAppended = await appendWikiLogEntry(logPath, draft.logEntryMarkdown, title, nowIso);
  return {
    changed: contextChanged || indexChanged || logAppended,
    title,
    contextChanged,
    indexChanged,
    logAppended,
  };
}

async function readFileOrDefault(workspaceRoot: string, fileName: "schema.md" | "context.md" | "index.md" | "log.md"): Promise<string> {
  const relativePath = path.join(HYDRA_WIKI_DIR, fileName);
  const text = await fs.promises.readFile(path.join(workspaceRoot, relativePath), "utf8").catch(() => "");
  return text || DEFAULT_WIKI_FILES[relativePath] || "";
}

function wikiFilePath(workspaceRoot: string, fileName: "context.md" | "index.md" | "log.md"): string {
  return path.join(workspaceRoot, HYDRA_WIKI_DIR, fileName);
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function formatWrapupMessage(message: HydraWikiWrapupMessage): string {
  const phase = message.phase ? ` (${message.phase})` : "";
  const role = message.role === "user" ? "You" : message.role === "system" ? "System" : message.role === "codex" ? "Codex" : "Claude";
  return `## ${message.timestamp} ${role}${phase}\n\n${message.text.trim()}`;
}

function stableWrapupKey(messages: HydraWikiWrapupMessage[]): string {
  return messages.map((message) => `${message.timestamp}\0${message.role}\0${message.phase ?? ""}`).join("\n");
}

function truncateForWrapupSource(markdown: string, maxChars: number): { markdown: string; truncated: boolean } {
  if (maxChars <= 0 || markdown.length <= maxChars) return { markdown, truncated: false };
  const suffix = "\n[... earlier room-turn content truncated by Hydra wikiWrapupMaxSourceChars ...]";
  return {
    markdown: `${suffix}\n${markdown.slice(Math.max(0, markdown.length - maxChars + suffix.length)).trimStart()}`,
    truncated: true,
  };
}

function tailMarkdown(markdown: string, maxChars: number): string {
  if (markdown.length <= maxChars) return markdown;
  return `[... earlier log entries omitted ...]\n${markdown.slice(markdown.length - maxChars).trimStart()}`;
}

function extractJsonObject(text: string): string | undefined {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  const candidate = fenced ? fenced[1].trim() : text;
  if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : undefined;
}

function optionalMarkdown(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return clipWikiWrite(trimmed);
}

function sanitizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function clipWikiWrite(markdown: string): string {
  const maxChars = 24000;
  if (markdown.length <= maxChars) return `${markdown.trimEnd()}\n`;
  const suffix = "\n[... clipped by Hydra wiki wrapup write cap ...]\n";
  return `${markdown.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`;
}

async function writeWikiFileIfChanged(filePath: string, markdown: string | undefined): Promise<boolean> {
  if (!markdown) return false;
  const next = markdown.trimEnd() + "\n";
  const current = await fs.promises.readFile(filePath, "utf8").catch(() => "");
  if (current.trimEnd() === next.trimEnd()) return false;
  await serializePerFile(filePath, () => atomicWriteFile(filePath, next));
  return true;
}

async function appendWikiLogEntry(
  filePath: string,
  entry: string | undefined,
  title: string,
  nowIso: string
): Promise<boolean> {
  if (!entry) return false;
  const normalized = normalizeLogEntry(entry, title, nowIso);
  await serializePerFile(filePath, async () => {
    const current = await fs.promises.readFile(filePath, "utf8").catch(() => "");
    const separator = current.trim() ? "\n\n" : "";
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.appendFile(filePath, `${separator}${normalized}\n`, "utf8");
  });
  return true;
}

function normalizeLogEntry(entry: string, title: string, nowIso: string): string {
  const trimmed = entry.trim();
  if (/^## \[\d{4}-\d{2}-\d{2}\]/m.test(trimmed)) return trimmed;
  return [`## [${nowIso.slice(0, 10)}] wrapup | ${title}`, "", trimmed].join("\n");
}
