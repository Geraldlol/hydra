import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import {
  appendFileSafely,
  atomicWriteFile,
  ensureFile,
  readFileHead,
  readFileHeadSync,
  readFileTail,
  readFileTailSync,
  serializePerFile,
  type BoundedFileHead,
  type BoundedFileTail,
} from "./fileQueue";
import { displayNameFor } from "./agentRegistry";
import type { MessageRole } from "./transcript";

export const HYDRA_WIKI_DIR = path.join(".hydra", "wiki");
export const HYDRA_WIKI_CORE_READ_BYTES = 128 * 1024;
const HYDRA_WIKI_LOG_READ_BYTES = 64 * 1024;

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
  rawMarkdown: string;
  key: string;
  sha256: string;
  kind: "room-turn" | "context-refresh";
  rawSourcePath?: string;
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
  rawSourcePath?: string;
  rawSourceSha256?: string;
  contextChanged: boolean;
  indexChanged: boolean;
  logAppended: boolean;
}

export interface HydraWikiStoredSource {
  relativePath: string;
  sha256: string;
  created: boolean;
}

export interface HydraWikiRawTurnsPruneResult {
  prunedPaths: string[];
  invalidNowIso?: string;
}

export interface HydraWikiStatus {
  contextChars: number;
  contextMaxChars: number;
  promptChars: number;
  promptTruncated: boolean;
  promptFiles: string[];
  rawTurnCount: number;
  lastWrapupDate?: string;
  lastWrapupTitle?: string;
}

export interface HydraWikiWrapupPromptInput {
  nowIso: string;
  files: HydraWikiFiles;
  source: HydraWikiWrapupSource;
}

export interface HydraWikiWrapupMessage {
  role: MessageRole;
  text: string;
  timestamp: string;
  phase?: string;
}

export interface HydraWikiPromptOptions {
  includeLog?: boolean;
}

export const HYDRA_WIKI_PROMPT_FILES: HydraWikiPromptFile[] = [
  { relativePath: path.join(HYDRA_WIKI_DIR, "context.md"), label: "context.md" },
  { relativePath: path.join(HYDRA_WIKI_DIR, "index.md"), label: "index.md" },
];

const HYDRA_WIKI_LOG_PROMPT_FILE: HydraWikiPromptFile = {
  relativePath: path.join(HYDRA_WIKI_DIR, "log.md"),
  label: "log.md",
};

const DEFAULT_WIKI_FILES: Record<string, string> = {
  [path.join(HYDRA_WIKI_DIR, "schema.md")]: `# Hydra Wiki Schema

Hydra wiki is the persistent compiled layer for room knowledge. It should let future agent turns read durable synthesis first instead of rediscovering the same transcript and artifact details every time.

## Layers

- Raw sources: transcript, decisions, verification records, native action logs, agent call traces, user-provided docs, linked sources, and immutable wrapup snapshots under \`.hydra/wiki/raw/turns/\`. Treat them as history and evidence.
- Wiki core: markdown pages in \`.hydra/wiki/\` owned by the agents. Keep durable facts, architecture notes, decisions, contradictions, open questions, and stable workflows here.
- Schema: this file. Update it when the maintenance workflow changes.

## Operations

- Ingest: read one source, extract durable information, update relevant wiki pages, update \`index.md\`, and append \`log.md\`.
- Query: read \`context.md\` and \`index.md\` first, then drill into wiki pages or raw sources only as needed.
- Wrapup: after a substantial room turn, preserve the room turn as a raw source snapshot, fold durable facts into \`context.md\`, cite new or materially changed facts with \`[src:<sha12>]\`, add or update page links, and append \`log.md\` with the raw source path and SHA.
- Context refresh: when the active transcript reaches the prompt transcript cap, preserve a transcript snapshot and refresh \`context.md\` / \`index.md\` so older details can be compacted into durable memory before prompt windowing omits them.
- Lint: flag contradictions, stale claims, orphan pages, missing links, and unresolved questions.

## Provenance

- Use \`[src:<sha12>]\` on context facts that came from a raw room-turn snapshot. The source id is the 12-character SHA prefix in the raw filename.
- Prefer preserving existing source tags when rewriting a fact. Replace them only when the new source supersedes the older claim.

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
    log: await readWikiLogOrDefault(workspaceRoot),
  };
}

export function readHydraWikiPromptContext(
  workspaceRoot: string,
  maxChars: number,
  options: HydraWikiPromptOptions = {}
): HydraWikiPromptContext | undefined {
  const cap = Math.max(0, Math.floor(maxChars));
  if (cap <= 0) return undefined;

  const sections: string[] = [];
  const files: string[] = [];
  let originalChars = 0;
  let coreReadTruncated = false;
  const promptFiles = options.includeLog
    ? [...HYDRA_WIKI_PROMPT_FILES, HYDRA_WIKI_LOG_PROMPT_FILE]
    : HYDRA_WIKI_PROMPT_FILES;

  for (const source of promptFiles) {
    const absolutePath = path.join(workspaceRoot, source.relativePath);
    const read = source.label === "log.md"
      ? { text: readWikiLogTailSync(absolutePath), truncated: false }
      : readWikiCoreHeadSync(absolutePath, source.label);
    const text = read.text;
    const trimmed = text.trim();
    if (!trimmed || isDefaultWikiTemplate(source.relativePath, text)) continue;
    coreReadTruncated ||= read.truncated;
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
    truncated: clipped.truncated || coreReadTruncated,
  };
}

export async function readHydraWikiStatus(
  workspaceRoot: string,
  maxChars: number,
  options: HydraWikiPromptOptions = {}
): Promise<HydraWikiStatus> {
  await ensureHydraWikiFiles(workspaceRoot);
  const cap = Math.max(0, Math.floor(maxChars));
  const contextPath = path.join(workspaceRoot, HYDRA_WIKI_DIR, "context.md");
  const logPath = path.join(workspaceRoot, HYDRA_WIKI_DIR, "log.md");
  const rawTurnsDir = path.join(workspaceRoot, HYDRA_WIKI_DIR, "raw", "turns");

  const contextText = (await readWikiCoreHead(contextPath, "context.md")).text;
  const contextChars = isDefaultWikiTemplate(path.join(HYDRA_WIKI_DIR, "context.md"), contextText)
    ? 0
    : contextText.trim().length;
  const promptContext = readHydraWikiPromptContext(workspaceRoot, cap, options);
  const rawEntries = await fs.promises.readdir(rawTurnsDir, { withFileTypes: true }).catch(() => []);
  const rawTurnCount = rawEntries.filter((entry) =>
    entry.isFile() && /^\d{4}-\d{2}-\d{2}-[a-f0-9]{12}\.md$/i.test(entry.name)
  ).length;
  const lastWrapup = latestWrapupFromLog(await readWikiLogTail(logPath));

  return {
    contextChars,
    contextMaxChars: cap,
    promptChars: promptContext?.originalChars ?? 0,
    promptTruncated: promptContext?.truncated ?? false,
    promptFiles: promptContext?.files ?? [],
    rawTurnCount,
    lastWrapupDate: lastWrapup?.date,
    lastWrapupTitle: lastWrapup?.title,
  };
}

function latestWrapupFromLog(log: string): { date: string; title: string } | undefined {
  let latest: { date: string; title: string } | undefined;
  for (const match of log.matchAll(/^## \[(\d{4}-\d{2}-\d{2})\]\s+wrapup\s+\|\s+(.+)$/gim)) {
    const date = match[1];
    const title = match[2];
    if (date === undefined || title === undefined) continue;
    latest = { date, title: title.trim() };
  }
  return latest;
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
    rawMarkdown: body,
    key: stableWrapupKey(turnMessages),
    sha256: sha256(body),
    kind: "room-turn",
    originalChars,
    truncated: capped.truncated,
  };
}

export function hydraWikiContextRefreshSourceFromMessages(
  messages: HydraWikiWrapupMessage[],
  maxChars: number
): HydraWikiWrapupSource | undefined {
  const sourceMessages = messages.filter((message) => message.text.trim());
  if (sourceMessages.length < 2) return undefined;

  const body = sourceMessages.map(formatWrapupMessage).join("\n\n").trim();
  if (!body) return undefined;
  const originalChars = body.length;
  const capped = truncateForWrapupSource(body, Math.max(0, Math.floor(maxChars)));
  return {
    markdown: capped.markdown,
    rawMarkdown: body,
    key: `context-refresh:${stableWrapupKey(sourceMessages)}`,
    sha256: sha256(body),
    kind: "context-refresh",
    originalChars,
    truncated: capped.truncated,
  };
}

export function hydraWikiWrapupSourcePath(source: HydraWikiWrapupSource, nowIso: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.test(nowIso) ? nowIso.slice(0, 10) : "unknown-date";
  return path.join(HYDRA_WIKI_DIR, "raw", "turns", `${day}-${source.sha256.slice(0, 12)}.md`)
    .split(path.sep)
    .join("/");
}

export async function writeHydraWikiWrapupSource(
  workspaceRoot: string,
  source: HydraWikiWrapupSource,
  nowIso: string
): Promise<HydraWikiStoredSource> {
  const relativePath = hydraWikiWrapupSourcePath(source, nowIso);
  const absolutePath = path.join(workspaceRoot, ...relativePath.split("/"));
  const content = [
    "---",
    `kind: ${source.kind === "context-refresh" ? "hydra-context-refresh" : "hydra-room-turn"}`,
    `created: "${nowIso}"`,
    `sha256: "${source.sha256}"`,
    `originalChars: ${source.originalChars}`,
    `promptChars: ${source.markdown.length}`,
    `truncatedForPrompt: ${source.truncated ? "true" : "false"}`,
    "---",
    "",
    "# Hydra Raw Room Turn",
    "",
    source.rawMarkdown.trimEnd(),
    "",
  ].join("\n");

  const created = await serializePerFile(absolutePath, async () => {
    const exists = await fs.promises.stat(absolutePath).then(() => true, () => false);
    if (exists) return false;
    await atomicWriteFile(absolutePath, content);
    return true;
  });

  return { relativePath, sha256: source.sha256, created };
}

export async function pruneHydraWikiRawTurns(
  workspaceRoot: string,
  nowIso: string,
  keepDays: number
): Promise<HydraWikiRawTurnsPruneResult> {
  const days = Math.max(0, Math.floor(keepDays));
  if (days <= 0) return { prunedPaths: [] };

  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return { prunedPaths: [], invalidNowIso: nowIso };

  const cutoffDay = new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const boundary = await establishRawTurnsPruneBoundary(workspaceRoot);
  if (!boundary) return { prunedPaths: [] };

  await assertRawTurnsPruneBoundary(boundary);
  const entries = await fs.promises.readdir(boundary.logicalRawTurnsRoot, { withFileTypes: true });
  const prunedPaths: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^(\d{4}-\d{2}-\d{2})-[a-f0-9]{12}\.md$/i.exec(entry.name);
    const entryDay = match?.[1];
    if (entryDay === undefined || entryDay >= cutoffDay) continue;

    if (await unlinkSafeRawTurnSnapshot(boundary, entry.name)) {
      prunedPaths.push(path.join(HYDRA_WIKI_DIR, "raw", "turns", entry.name).split(path.sep).join("/"));
    }
  }

  return { prunedPaths };
}

interface RawTurnsPruneBoundary {
  logicalWorkspaceRoot: string;
  logicalRawTurnsRoot: string;
  realWorkspaceRoot: string;
  realRawTurnsRoot: string;
  parents: Array<{
    logicalPath: string;
    realPath: string;
    dev: number;
    ino: number;
  }>;
}

async function establishRawTurnsPruneBoundary(
  workspaceRoot: string
): Promise<RawTurnsPruneBoundary | undefined> {
  const logicalWorkspaceRoot = path.resolve(workspaceRoot);
  const logicalRawTurnsRoot = path.resolve(logicalWorkspaceRoot, HYDRA_WIKI_DIR, "raw", "turns");
  if (!isPathWithin(logicalWorkspaceRoot, logicalRawTurnsRoot) || samePath(logicalWorkspaceRoot, logicalRawTurnsRoot)) {
    throw unsafeRawTurnsParent(logicalRawTurnsRoot);
  }

  let realWorkspaceRoot: string;
  try {
    realWorkspaceRoot = await fs.promises.realpath(logicalWorkspaceRoot);
    const workspaceStat = await fs.promises.stat(realWorkspaceRoot);
    if (!workspaceStat.isDirectory()) throw unsafeRawTurnsParent(logicalWorkspaceRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }

  const parents: RawTurnsPruneBoundary["parents"] = [];
  const segments = [".hydra", "wiki", "raw", "turns"];
  let logicalParent = logicalWorkspaceRoot;
  let expectedRealParent = realWorkspaceRoot;
  for (const segment of segments) {
    logicalParent = path.join(logicalParent, segment);
    expectedRealParent = path.join(expectedRealParent, segment);
    let parentStat: fs.Stats;
    let realParent: string;
    try {
      parentStat = await fs.promises.lstat(logicalParent);
      realParent = await fs.promises.realpath(logicalParent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    if (
      parentStat.isSymbolicLink()
      || !parentStat.isDirectory()
      || !samePath(realParent, expectedRealParent)
      || !isPathWithin(realWorkspaceRoot, realParent)
    ) {
      throw unsafeRawTurnsParent(logicalParent);
    }
    parents.push({
      logicalPath: logicalParent,
      realPath: realParent,
      dev: parentStat.dev,
      ino: parentStat.ino,
    });
  }

  return {
    logicalWorkspaceRoot,
    logicalRawTurnsRoot,
    realWorkspaceRoot,
    realRawTurnsRoot: parents[parents.length - 1]!.realPath,
    parents,
  };
}

async function assertRawTurnsPruneBoundary(boundary: RawTurnsPruneBoundary): Promise<void> {
  let currentRealWorkspace: string;
  try {
    currentRealWorkspace = await fs.promises.realpath(boundary.logicalWorkspaceRoot);
  } catch {
    throw unsafeRawTurnsParent(boundary.logicalWorkspaceRoot);
  }
  if (!samePath(currentRealWorkspace, boundary.realWorkspaceRoot)) {
    throw unsafeRawTurnsParent(boundary.logicalWorkspaceRoot);
  }

  for (const parent of boundary.parents) {
    try {
      const [currentStat, currentRealPath] = await Promise.all([
        fs.promises.lstat(parent.logicalPath),
        fs.promises.realpath(parent.logicalPath),
      ]);
      if (
        currentStat.isSymbolicLink()
        || !currentStat.isDirectory()
        || currentStat.dev !== parent.dev
        || currentStat.ino !== parent.ino
        || !samePath(currentRealPath, parent.realPath)
        || !isPathWithin(boundary.realWorkspaceRoot, currentRealPath)
      ) {
        throw unsafeRawTurnsParent(parent.logicalPath);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Refusing to prune Hydra Wiki")) throw err;
      throw unsafeRawTurnsParent(parent.logicalPath);
    }
  }
}

async function unlinkSafeRawTurnSnapshot(
  boundary: RawTurnsPruneBoundary,
  entryName: string
): Promise<boolean> {
  await assertRawTurnsPruneBoundary(boundary);
  const filePath = path.resolve(boundary.logicalRawTurnsRoot, entryName);
  if (!isPathWithin(boundary.logicalRawTurnsRoot, filePath) || samePath(filePath, boundary.logicalRawTurnsRoot)) {
    return false;
  }

  let before: fs.Stats;
  let realFilePath: string;
  try {
    before = await fs.promises.lstat(filePath);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) return false;
    realFilePath = await fs.promises.realpath(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }

  const expectedRealFilePath = path.join(boundary.realRawTurnsRoot, entryName);
  if (
    !samePath(realFilePath, expectedRealFilePath)
    || !isPathWithin(boundary.realRawTurnsRoot, realFilePath)
    || !isPathWithin(boundary.realWorkspaceRoot, realFilePath)
  ) {
    return false;
  }

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ELOOP") {
      return false;
    }
    throw err;
  }

  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      return false;
    }

    // Revalidate both the directory chain and the final pathname while the
    // candidate handle remains open. A parent or file swap after enumeration
    // must fail closed instead of redirecting unlink() outside the workspace.
    await assertRawTurnsPruneBoundary(boundary);
    let current: fs.Stats;
    let currentRealFilePath: string;
    try {
      current = await fs.promises.lstat(filePath);
      currentRealFilePath = await fs.promises.realpath(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    if (
      current.isSymbolicLink()
      || !current.isFile()
      || current.nlink !== 1
      || current.dev !== opened.dev
      || current.ino !== opened.ino
      || !samePath(currentRealFilePath, expectedRealFilePath)
      || !isPathWithin(boundary.realRawTurnsRoot, currentRealFilePath)
    ) {
      return false;
    }
    await assertRawTurnsPruneBoundary(boundary);
    await fs.promises.unlink(filePath);
    return true;
  } finally {
    await handle.close();
  }
}

function unsafeRawTurnsParent(parentPath: string): Error {
  return new Error(`Refusing to prune Hydra Wiki through a linked, replaced, or external parent: ${parentPath}`);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isPathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function buildHydraWikiWrapupPrompt(input: HydraWikiWrapupPromptInput): string {
  const logTail = tailMarkdown(input.files.log, 6000);
  const sourceId = input.source.sha256.slice(0, 12);
  const sourceLabel = input.source.kind === "context-refresh"
    ? "active transcript context refresh"
    : "just-finished Hydra room turn";
  return [
    "You maintain Hydra's persistent `.hydra/wiki` memory using the LLM Wiki pattern: compile durable knowledge once, keep the wiki current, and avoid re-deriving old context every future turn.",
    "",
    `Task: update the wiki from the ${sourceLabel}.`,
    "",
    "Rules:",
    "- Keep only durable project knowledge, decisions, conventions, recurring user preferences, architecture facts, unresolved questions, and reusable workflow lessons.",
    "- Drop ephemeral chat filler, greetings, transient progress, and facts that are only useful for the current minute.",
    "- For a context refresh, prioritize compacting still-relevant facts that would be painful to rediscover after old transcript content is omitted from prompts.",
    "- If the turn creates no durable wiki value, return `changed: false` and leave the markdown fields empty.",
    "- `contextMarkdown` and `indexMarkdown` must be full replacement file contents when changed, not patches.",
    "- Keep `context.md` compact. It is injected into future prompts.",
    `- For new or materially changed context facts derived from this turn, append \`[src:${sourceId}]\` to the bullet or sentence.`,
    "- Preserve existing `[src:<sha12>]` tags when rewriting still-valid facts; replace them only when this turn supersedes the claim.",
    "- Update `index.md` only when it helps future agents navigate the wiki.",
    "- `logEntryMarkdown` is appended to `log.md`; use a heading like `## [YYYY-MM-DD] wrapup | Short Title` and cite the raw source path/SHA below.",
    "- Return JSON only. No markdown fence, no prose.",
    "",
    "JSON shape:",
    `{"changed":true,"title":"Short Title","contextMarkdown":"# Hydra Wiki Context\\n\\n- Durable fact. [src:${sourceId}]\\n","indexMarkdown":"# Hydra Wiki Index\\n\\n...","logEntryMarkdown":"## [${input.nowIso.slice(0, 10)}] wrapup | Short Title\\n\\n- Updated: [[context]]\\n- Source: \`${input.source.rawSourcePath ?? hydraWikiWrapupSourcePath(input.source, input.nowIso)}\` (sha256: \`${input.source.sha256}\`)"}`,
    "",
    "Current time:",
    input.nowIso,
    "",
    "Raw source snapshot:",
    input.source.rawSourcePath ?? hydraWikiWrapupSourcePath(input.source, input.nowIso),
    `sha256: ${input.source.sha256}`,
    `source id: ${sourceId}`,
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
    `--- ${sourceLabel} ---`,
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
  nowIso: string,
  source?: HydraWikiStoredSource
): Promise<AppliedHydraWikiWrapup> {
  await ensureHydraWikiFiles(workspaceRoot);
  const title = sanitizeTitle(draft.title) || "Hydra wrapup";
  if (!draft.changed) {
    return {
      changed: false,
      title,
      rawSourcePath: source?.relativePath,
      rawSourceSha256: source?.sha256,
      contextChanged: false,
      indexChanged: false,
      logAppended: false,
    };
  }

  const contextPath = wikiFilePath(workspaceRoot, "context.md");
  const indexPath = wikiFilePath(workspaceRoot, "index.md");
  const logPath = wikiFilePath(workspaceRoot, "log.md");

  const contextChanged = await writeWikiFileIfChanged(contextPath, draft.contextMarkdown);
  const indexChanged = await writeWikiFileIfChanged(indexPath, draft.indexMarkdown);
  const logEntryMarkdown = draft.logEntryMarkdown ?? (source ? "- Updated wiki synthesis from raw source." : undefined);
  const logAppended = await appendWikiLogEntry(logPath, logEntryMarkdown, title, nowIso, source);
  return {
    changed: contextChanged || indexChanged || logAppended,
    title,
    rawSourcePath: source?.relativePath,
    rawSourceSha256: source?.sha256,
    contextChanged,
    indexChanged,
    logAppended,
  };
}

async function readFileOrDefault(workspaceRoot: string, fileName: "schema.md" | "context.md" | "index.md"): Promise<string> {
  const relativePath = path.join(HYDRA_WIKI_DIR, fileName);
  const text = (await readWikiCoreHead(path.join(workspaceRoot, relativePath), fileName)).text;
  return text || DEFAULT_WIKI_FILES[relativePath] || "";
}

interface BoundedWikiCoreRead {
  text: string;
  truncated: boolean;
}

async function readWikiCoreHead(filePath: string, fileName: string): Promise<BoundedWikiCoreRead> {
  try {
    return boundedWikiCoreRead(await readFileHead(filePath, HYDRA_WIKI_CORE_READ_BYTES), fileName);
  } catch {
    // Wiki files are optional until initialization and remain best-effort context.
    return { text: "", truncated: false };
  }
}

function readWikiCoreHeadSync(filePath: string, fileName: string): BoundedWikiCoreRead {
  try {
    return boundedWikiCoreRead(readFileHeadSync(filePath, HYDRA_WIKI_CORE_READ_BYTES), fileName);
  } catch {
    // Prompt assembly is synchronous; a missing or unsafe optional file is ignored.
    return { text: "", truncated: false };
  }
}

function boundedWikiCoreRead(head: BoundedFileHead, fileName: string): BoundedWikiCoreRead {
  if (!head.truncated) return { text: head.text, truncated: false };
  const suffix = `\n[... remaining ${fileName} content omitted by Hydra wiki core read cap ...]\n`;
  return {
    text: `${head.text.trimEnd()}${suffix}`,
    truncated: true,
  };
}

async function readWikiLogOrDefault(workspaceRoot: string): Promise<string> {
  const relativePath = path.join(HYDRA_WIKI_DIR, "log.md");
  const text = await readWikiLogTail(path.join(workspaceRoot, relativePath));
  return text || DEFAULT_WIKI_FILES[relativePath] || "";
}

async function readWikiLogTail(filePath: string): Promise<string> {
  try {
    return markdownTail(await readFileTail(filePath, HYDRA_WIKI_LOG_READ_BYTES));
  } catch {
    // Wiki files are optional until initialization and remain best-effort context.
    return "";
  }
}

function readWikiLogTailSync(filePath: string): string {
  try {
    return markdownTail(readFileTailSync(filePath, HYDRA_WIKI_LOG_READ_BYTES));
  } catch {
    // Wiki files are optional until initialization and remain best-effort context.
    return "";
  }
}

function markdownTail(tail: BoundedFileTail): string {
  if (!tail.truncated) return tail.text;
  const nextHeading = tail.text.indexOf("\n## ");
  const completeTail = nextHeading >= 0 ? tail.text.slice(nextHeading + 1) : tail.text;
  return `[... earlier wiki log entries omitted ...]\n${completeTail.trimStart()}`;
}

function wikiFilePath(workspaceRoot: string, fileName: "context.md" | "index.md" | "log.md"): string {
  return path.join(workspaceRoot, HYDRA_WIKI_DIR, fileName);
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    // Why: index is bounded by items.length-1..0, so items[index] is always present.
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function formatWrapupMessage(message: HydraWikiWrapupMessage): string {
  const phase = message.phase ? ` (${message.phase})` : "";
  const role = message.role === "user" ? "You" : message.role === "system" ? "System" : displayNameFor(message.role);
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
  const candidate = fenced?.[1] !== undefined ? fenced[1].trim() : text;
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
  return serializePerFile(filePath, async () => {
    const current = await readFileHead(filePath, HYDRA_WIKI_CORE_READ_BYTES).catch(() => undefined);
    if (current && !current.truncated && current.text.trimEnd() === next.trimEnd()) return false;
    await atomicWriteFile(filePath, next);
    return true;
  });
}

async function appendWikiLogEntry(
  filePath: string,
  entry: string | undefined,
  title: string,
  nowIso: string,
  source?: HydraWikiStoredSource
): Promise<boolean> {
  if (!entry) return false;
  const normalized = normalizeLogEntry(entry, title, nowIso, source);
  await serializePerFile(filePath, async () => {
    const current = await readFileTail(filePath, 1024).catch(() => undefined);
    const separator = current && current.totalBytes > 0 ? "\n\n" : "";
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await appendFileSafely(filePath, `${separator}${normalized}\n`);
  });
  return true;
}

function normalizeLogEntry(entry: string, title: string, nowIso: string, source?: HydraWikiStoredSource): string {
  const trimmed = entry.trim();
  const withHeading = /^## \[\d{4}-\d{2}-\d{2}\]/m.test(trimmed)
    ? trimmed
    : [`## [${nowIso.slice(0, 10)}] wrapup | ${title}`, "", trimmed].join("\n");
  if (!source) return withHeading;
  const sourceId = source.sha256.slice(0, 12);
  if (withHeading.includes(source.relativePath) || withHeading.includes(source.sha256) || withHeading.includes(sourceId)) {
    return withHeading;
  }
  return `${withHeading.trimEnd()}\n\n- Source: \`${source.relativePath}\` (sha256: \`${source.sha256}\`)`;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
