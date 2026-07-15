import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyHydraWikiWrapupDraft,
  buildHydraWikiWrapupPrompt,
  ensureHydraWikiFiles,
  HYDRA_WIKI_CORE_READ_BYTES,
  hydraWikiContextRefreshSourceFromMessages,
  hydraWikiContextPath,
  hydraWikiWrapupSourceFromMessages,
  hydraWikiWrapupSourcePath,
  parseHydraWikiWrapupResponse,
  pruneHydraWikiRawTurns,
  readHydraWikiFiles,
  readHydraWikiPromptContext,
  readHydraWikiStatus,
  writeHydraWikiWrapupSource,
} from "../src/hydraWiki";

describe("Hydra wiki context", () => {
  test("creates the wiki scaffold under .hydra/wiki", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-"));

    await ensureHydraWikiFiles(dir);

    assert.equal(path.basename(hydraWikiContextPath(dir)), "context.md");
    await fs.stat(path.join(dir, ".hydra", "wiki", "schema.md"));
    await fs.stat(path.join(dir, ".hydra", "wiki", "context.md"));
    await fs.stat(path.join(dir, ".hydra", "wiki", "index.md"));
    await fs.stat(path.join(dir, ".hydra", "wiki", "log.md"));
  });

  test("skips untouched scaffold files in prompt context", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-"));
    await ensureHydraWikiFiles(dir);

    assert.equal(readHydraWikiPromptContext(dir, 8000), undefined);
  });

  test("renders edited wiki files as prompt context", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-"));
    await ensureHydraWikiFiles(dir);
    await fs.writeFile(
      path.join(dir, ".hydra", "wiki", "context.md"),
      "# Hydra Wiki Context\n\nHydra has a run failure card feature.\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(dir, ".hydra", "wiki", "index.md"),
      "# Hydra Wiki Index\n\n- [[failure-cards]]: inline diagnostics for agent timeouts.\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(dir, ".hydra", "wiki", "log.md"),
      "# Hydra Wiki Log\n\n## [2026-05-21] wrapup | Noisy append-only history\n",
      "utf8"
    );

    const context = readHydraWikiPromptContext(dir, 8000);

    assert.ok(context);
    assert.match(context.markdown, /--- Hydra wiki context ---/);
    assert.match(context.markdown, /Hydra has a run failure card feature/);
    assert.match(context.markdown, /failure-cards/);
    assert.doesNotMatch(context.markdown, /Noisy append-only history/);
    assert.deepEqual(context.files, [".hydra/wiki/context.md", ".hydra/wiki/index.md"]);
    assert.equal(context.truncated, false);
  });

  test("can opt into prompt-injecting the wiki log", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-"));
    await ensureHydraWikiFiles(dir);
    await fs.writeFile(path.join(dir, ".hydra", "wiki", "context.md"), "# Hydra Wiki Context\n\nDurable fact.\n", "utf8");
    await fs.writeFile(path.join(dir, ".hydra", "wiki", "log.md"), "# Hydra Wiki Log\n\n## [2026-05-21] wrapup | Durable log\n", "utf8");

    const context = readHydraWikiPromptContext(dir, 8000, { includeLog: true });

    assert.ok(context);
    assert.match(context.markdown, /Durable log/);
    assert.deepEqual(context.files, [".hydra/wiki/context.md", ".hydra/wiki/log.md"]);
  });

  test("caps wiki prompt context", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-"));
    await ensureHydraWikiFiles(dir);
    await fs.writeFile(
      path.join(dir, ".hydra", "wiki", "context.md"),
      `# Hydra Wiki Context\n\n${"A".repeat(400)}`,
      "utf8"
    );

    const context = readHydraWikiPromptContext(dir, 120);

    assert.ok(context);
    assert.equal(context.truncated, true);
    assert.match(context.markdown, /truncated by Hydra wikiContextMaxChars/);
  });

  test("can be disabled with a zero cap", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-"));
    await ensureHydraWikiFiles(dir);
    await fs.writeFile(path.join(dir, ".hydra", "wiki", "context.md"), "Real context", "utf8");

    assert.equal(readHydraWikiPromptContext(dir, 0), undefined);
  });

  test("summarizes wiki status for Command Center", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-"));
    await ensureHydraWikiFiles(dir);
    await fs.writeFile(path.join(dir, ".hydra", "wiki", "context.md"), "# Hydra Wiki Context\n\nDurable fact.\n", "utf8");
    await fs.writeFile(
      path.join(dir, ".hydra", "wiki", "log.md"),
      "# Hydra Wiki Log\n\n## [2026-05-20] wrapup | Older\n\n- Updated: [[context]]\n\n## [2026-05-21] wrapup | Latest Lesson\n\n- Updated: [[context]]\n",
      "utf8"
    );
    const rawDir = path.join(dir, ".hydra", "wiki", "raw", "turns");
    await fs.mkdir(rawDir, { recursive: true });
    await fs.writeFile(path.join(rawDir, "2026-05-21-aaaaaaaaaaaa.md"), "raw", "utf8");
    await fs.writeFile(path.join(rawDir, "notes.md"), "ignored", "utf8");

    const status = await readHydraWikiStatus(dir, 8000);

    assert.equal(status.contextChars, "# Hydra Wiki Context\n\nDurable fact.".length);
    assert.equal(status.contextMaxChars, 8000);
    assert.equal(status.promptTruncated, false);
    assert.deepEqual(status.promptFiles, [".hydra/wiki/context.md"]);
    assert.equal(status.rawTurnCount, 1);
    assert.equal(status.lastWrapupDate, "2026-05-21");
    assert.equal(status.lastWrapupTitle, "Latest Lesson");
  });

  test("reads only the bounded newest tail of a large wiki append log", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-log-tail-"));
    await ensureHydraWikiFiles(dir);
    const logPath = path.join(dir, ".hydra", "wiki", "log.md");
    await fs.writeFile(logPath, [
      "# Hydra Wiki Log",
      "",
      `OLD_START ${"x".repeat(96 * 1024)}`,
      "",
      "## [2026-07-14] wrapup | Bounded Latest",
      "",
      "- Updated: [[context]]",
      "",
    ].join("\n"), "utf8");

    const files = await readHydraWikiFiles(dir);
    const status = await readHydraWikiStatus(dir, 8000);

    assert.match(files.log, /earlier wiki log entries omitted/);
    assert.match(files.log, /Bounded Latest/);
    assert.doesNotMatch(files.log, /OLD_START/);
    assert.ok(Buffer.byteLength(files.log, "utf8") < 66 * 1024);
    assert.equal(status.lastWrapupDate, "2026-07-14");
    assert.equal(status.lastWrapupTitle, "Bounded Latest");
  });

  test("preserves a full maximum-size multibyte generated wiki page", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-core-multibyte-"));
    await ensureHydraWikiFiles(dir);
    const contextPath = path.join(dir, ".hydra", "wiki", "context.md");
    const generated = `# Hydra Wiki Context\n\n${"界".repeat(24_000)}`;
    await fs.writeFile(contextPath, generated, "utf8");

    const files = await readHydraWikiFiles(dir);
    const prompt = readHydraWikiPromptContext(dir, 30_000);

    assert.equal(files.context, generated);
    assert.ok(prompt);
    assert.equal(prompt.truncated, false);
    assert.match(prompt.markdown, /界界界/);
    assert.doesNotMatch(prompt.markdown, /wiki core read cap/);
  });

  test("bounds oversized schema, context, index, status, and prompt reads", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-core-bounded-"));
    await ensureHydraWikiFiles(dir);
    const wikiDir = path.join(dir, ".hydra", "wiki");
    const oversized = (label: string) => [
      `# ${label}`,
      "",
      `${label}_HEAD`,
      "x".repeat(HYDRA_WIKI_CORE_READ_BYTES + 4096),
      `${label}_TAIL_MUST_NOT_BE_READ`,
    ].join("\n");

    await Promise.all([
      fs.writeFile(path.join(wikiDir, "schema.md"), oversized("SCHEMA"), "utf8"),
      fs.writeFile(path.join(wikiDir, "context.md"), oversized("CONTEXT"), "utf8"),
      fs.writeFile(path.join(wikiDir, "index.md"), oversized("INDEX"), "utf8"),
    ]);

    const files = await readHydraWikiFiles(dir);
    const prompt = readHydraWikiPromptContext(dir, HYDRA_WIKI_CORE_READ_BYTES * 3);
    const status = await readHydraWikiStatus(dir, HYDRA_WIKI_CORE_READ_BYTES * 3);

    assert.ok(prompt);
    for (const core of [files.schema, files.context, files.index]) {
      assert.match(core, /wiki core read cap/);
      assert.doesNotMatch(core, /_TAIL_MUST_NOT_BE_READ/);
      assert.ok(Buffer.byteLength(core, "utf8") < HYDRA_WIKI_CORE_READ_BYTES + 128);
    }
    assert.match(prompt.markdown, /CONTEXT_HEAD/);
    assert.match(prompt.markdown, /INDEX_HEAD/);
    assert.doesNotMatch(prompt.markdown, /_TAIL_MUST_NOT_BE_READ/);
    assert.equal(prompt.truncated, true);
    assert.equal(status.promptTruncated, true);
    assert.ok(status.contextChars < HYDRA_WIKI_CORE_READ_BYTES + 128);
  });

  test("replaces an oversized wiki page without an unbounded read-before-write", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-core-replace-"));
    await ensureHydraWikiFiles(dir);
    const contextPath = path.join(dir, ".hydra", "wiki", "context.md");
    await fs.writeFile(contextPath, `# Old\n\n${"x".repeat(HYDRA_WIKI_CORE_READ_BYTES * 2)}`, "utf8");

    const applied = await applyHydraWikiWrapupDraft(dir, {
      changed: true,
      title: "Bounded replacement",
      contextMarkdown: "# Hydra Wiki Context\n\nCompact replacement.",
    }, "2026-07-14T12:00:00.000Z");

    assert.equal(applied.contextChanged, true);
    assert.equal(await fs.readFile(contextPath, "utf8"), "# Hydra Wiki Context\n\nCompact replacement.\n");
  });

  test("builds a wrapup source from the latest room turn only", () => {
    const source = hydraWikiWrapupSourceFromMessages([
      { role: "user", text: "old ask", timestamp: "2026-05-21T10:00:00.000Z" },
      { role: "codex", phase: "opener", text: "old answer", timestamp: "2026-05-21T10:00:01.000Z" },
      { role: "user", text: "new ask", timestamp: "2026-05-21T11:00:00.000Z" },
      { role: "codex", phase: "opener", text: "new durable answer", timestamp: "2026-05-21T11:00:01.000Z" },
    ], 8000);

    assert.ok(source);
    assert.match(source.markdown, /new ask/);
    assert.match(source.markdown, /new durable answer/);
    assert.doesNotMatch(source.markdown, /old answer/);
    assert.match(source.rawMarkdown, /new durable answer/);
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.equal(source.kind, "room-turn");
    assert.equal(source.truncated, false);
  });

  test("builds a context-refresh source from the active transcript window", () => {
    const source = hydraWikiContextRefreshSourceFromMessages([
      { role: "user", text: "old ask " + "A".repeat(120), timestamp: "2026-05-21T10:00:00.000Z" },
      { role: "codex", phase: "opener", text: "old answer", timestamp: "2026-05-21T10:00:01.000Z" },
      { role: "user", text: "new ask", timestamp: "2026-05-21T11:00:00.000Z" },
      { role: "claude", phase: "reactor", text: "new durable answer", timestamp: "2026-05-21T11:00:01.000Z" },
    ], 120);

    assert.ok(source);
    assert.equal(source.kind, "context-refresh");
    assert.match(source.key, /^context-refresh:/);
    assert.match(source.rawMarkdown, /old ask/);
    assert.match(source.rawMarkdown, /new durable answer/);
    assert.match(source.markdown, /new durable answer/);
    assert.equal(source.originalChars, source.rawMarkdown.length);
    assert.equal(source.truncated, true);
  });

  test("stores immutable raw wrapup sources with provenance metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-"));
    const source = hydraWikiWrapupSourceFromMessages([
      { role: "user", text: "persist this source", timestamp: "2026-05-21T12:00:00.000Z" },
      { role: "codex", phase: "opener", text: "Durable source content.", timestamp: "2026-05-21T12:00:01.000Z" },
    ], 8000);

    assert.ok(source);
    const stored = await writeHydraWikiWrapupSource(dir, source, "2026-05-21T12:00:02.000Z");
    const second = await writeHydraWikiWrapupSource(dir, source, "2026-05-21T12:00:02.000Z");

    assert.equal(stored.created, true);
    assert.equal(second.created, false);
    assert.equal(stored.relativePath, hydraWikiWrapupSourcePath(source, "2026-05-21T12:00:02.000Z"));
    const raw = await fs.readFile(path.join(dir, ...stored.relativePath.split("/")), "utf8");
    assert.match(raw, /kind: hydra-room-turn/);
    assert.match(raw, new RegExp(`sha256: "${source.sha256}"`));
    assert.match(raw, /persist this source/);
    assert.match(raw, /Durable source content/);
  });

  test("stores context-refresh raw sources with their source kind", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-"));
    const source = hydraWikiContextRefreshSourceFromMessages([
      { role: "user", text: "refresh this memory", timestamp: "2026-05-21T12:00:00.000Z" },
      { role: "codex", phase: "opener", text: "Durable refresh content.", timestamp: "2026-05-21T12:00:01.000Z" },
    ], 8000);

    assert.ok(source);
    const stored = await writeHydraWikiWrapupSource(dir, source, "2026-05-21T12:00:02.000Z");

    const raw = await fs.readFile(path.join(dir, ...stored.relativePath.split("/")), "utf8");
    assert.match(raw, /kind: hydra-context-refresh/);
    assert.match(raw, /refresh this memory/);
  });

  test("renders a strict wiki wrapup prompt with current wiki files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-"));
    await ensureHydraWikiFiles(dir);
    await fs.writeFile(path.join(dir, ".hydra", "wiki", "context.md"), "# Hydra Wiki Context\n\nExisting fact.\n", "utf8");
    const files = await readHydraWikiFiles(dir);
    const source = hydraWikiWrapupSourceFromMessages([
      { role: "user", text: "remember the new runbook", timestamp: "2026-05-21T12:00:00.000Z" },
      { role: "claude", phase: "reactor", text: "New runbook is durable.", timestamp: "2026-05-21T12:00:01.000Z" },
    ], 8000);

    assert.ok(source);
    const prompt = buildHydraWikiWrapupPrompt({
      nowIso: "2026-05-21T12:00:02.000Z",
      files,
      source,
    });

    assert.match(prompt, /Return JSON only/);
    assert.match(prompt, /Task: update the wiki from the just-finished Hydra room turn\./);
    assert.match(prompt, /--- existing context\.md ---/);
    assert.match(prompt, /Existing fact/);
    assert.match(prompt, /remember the new runbook/);
    assert.match(prompt, /"contextMarkdown"/);
    assert.match(prompt, /Raw source snapshot:/);
    assert.match(prompt, new RegExp(source.sha256));
    assert.match(prompt, new RegExp(`\\[src:${source.sha256.slice(0, 12)}\\]`));
  });

  test("renders context-refresh wrapup prompts with refresh-specific guidance", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-"));
    await ensureHydraWikiFiles(dir);
    const files = await readHydraWikiFiles(dir);
    const source = hydraWikiContextRefreshSourceFromMessages([
      { role: "user", text: "first durable lesson", timestamp: "2026-05-21T12:00:00.000Z" },
      { role: "claude", phase: "reactor", text: "second durable lesson", timestamp: "2026-05-21T12:00:01.000Z" },
    ], 8000);

    assert.ok(source);
    const prompt = buildHydraWikiWrapupPrompt({
      nowIso: "2026-05-21T12:00:02.000Z",
      files,
      source,
    });

    assert.match(prompt, /Task: update the wiki from the active transcript context refresh\./);
    assert.match(prompt, /compact/);
    assert.match(prompt, /--- active transcript context refresh ---/);
  });

  test("parses fenced wiki wrapup JSON", () => {
    const draft = parseHydraWikiWrapupResponse([
      "```json",
      JSON.stringify({
        changed: true,
        title: "Runbook captured",
        contextMarkdown: "# Hydra Wiki Context\n\nDurable runbook.",
        logEntryMarkdown: "## [2026-05-21] wrapup | Runbook captured\n\n- Updated: [[context]]",
      }),
      "```",
    ].join("\n"));

    assert.ok(draft);
    assert.equal(draft.changed, true);
    assert.equal(draft.title, "Runbook captured");
    assert.match(draft.contextMarkdown ?? "", /Durable runbook/);
  });

  test("applies wrapup replacements and appends the log entry", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-"));
    await ensureHydraWikiFiles(dir);

    const source = {
      relativePath: ".hydra/wiki/raw/turns/2026-05-21-deadbeefcafe.md",
      sha256: "d".repeat(64),
      created: true,
    };

    const applied = await applyHydraWikiWrapupDraft(dir, {
      changed: true,
      title: "Failure card lesson",
      contextMarkdown: "# Hydra Wiki Context\n\nHydra has inline run failure cards.",
      indexMarkdown: "# Hydra Wiki Index\n\n- [[context]]: compiled room memory.",
      logEntryMarkdown: "- Updated failure-card lesson.",
    }, "2026-05-21T12:34:00.000Z", source);

    assert.equal(applied.changed, true);
    assert.equal(applied.rawSourcePath, source.relativePath);
    assert.equal(applied.contextChanged, true);
    assert.equal(applied.indexChanged, true);
    assert.equal(applied.logAppended, true);
    assert.match(await fs.readFile(path.join(dir, ".hydra", "wiki", "context.md"), "utf8"), /inline run failure cards/);
    assert.match(await fs.readFile(path.join(dir, ".hydra", "wiki", "index.md"), "utf8"), /\[\[context\]\]/);
    const log = await fs.readFile(path.join(dir, ".hydra", "wiki", "log.md"), "utf8");
    assert.match(log, /## \[2026-05-21\] wrapup | Failure card lesson/);
    assert.match(log, /2026-05-21-deadbeefcafe\.md/);
    assert.match(log, new RegExp("d".repeat(64)));
  });

  test("logs raw source provenance when a sourced wrapup omits a log entry", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-"));
    await ensureHydraWikiFiles(dir);

    const source = {
      relativePath: ".hydra/wiki/raw/turns/2026-05-21-feedface1234.md",
      sha256: "f".repeat(64),
      created: true,
    };

    const applied = await applyHydraWikiWrapupDraft(dir, {
      changed: true,
      title: "Context only",
      contextMarkdown: "# Hydra Wiki Context\n\nContext-only update.",
    }, "2026-05-21T12:34:00.000Z", source);

    assert.equal(applied.changed, true);
    assert.equal(applied.logAppended, true);
    const log = await fs.readFile(path.join(dir, ".hydra", "wiki", "log.md"), "utf8");
    assert.match(log, /Context only/);
    assert.match(log, /feedface1234\.md/);
  });

  test("does not duplicate source logs when the entry cites the 12-char source id", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-"));
    await ensureHydraWikiFiles(dir);

    const source = {
      relativePath: ".hydra/wiki/raw/turns/2026-05-21-feedface1234.md",
      sha256: `feedface1234${"0".repeat(52)}`,
      created: true,
    };

    const applied = await applyHydraWikiWrapupDraft(dir, {
      changed: true,
      title: "Source id cited",
      contextMarkdown: "# Hydra Wiki Context\n\nContext update. [src:feedface1234]",
      logEntryMarkdown: "## [2026-05-21] wrapup | Source id cited\n\n- Source id: feedface1234",
    }, "2026-05-21T12:34:00.000Z", source);

    assert.equal(applied.logAppended, true);
    const log = await fs.readFile(path.join(dir, ".hydra", "wiki", "log.md"), "utf8");
    assert.match(log, /Source id: feedface1234/);
    assert.doesNotMatch(log, /\.hydra\/wiki\/raw\/turns\/2026-05-21-feedface1234\.md/);
  });

  test("prunes raw turn snapshots older than the retention window", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-"));
    const rawDir = path.join(dir, ".hydra", "wiki", "raw", "turns");
    await fs.mkdir(rawDir, { recursive: true });
    await fs.writeFile(path.join(rawDir, "2026-04-20-aaaaaaaaaaaa.md"), "old", "utf8");
    await fs.writeFile(path.join(rawDir, "2026-04-21-bbbbbbbbbbbb.md"), "cutoff", "utf8");
    await fs.writeFile(path.join(rawDir, "2026-05-20-cccccccccccc.md"), "new", "utf8");
    await fs.writeFile(path.join(rawDir, "notes.md"), "not a raw turn snapshot", "utf8");

    const pruned = await pruneHydraWikiRawTurns(dir, "2026-05-21T12:00:00.000Z", 30);

    assert.deepEqual(pruned.prunedPaths, [".hydra/wiki/raw/turns/2026-04-20-aaaaaaaaaaaa.md"]);
    await assert.rejects(fs.stat(path.join(rawDir, "2026-04-20-aaaaaaaaaaaa.md")));
    await fs.stat(path.join(rawDir, "2026-04-21-bbbbbbbbbbbb.md"));
    await fs.stat(path.join(rawDir, "2026-05-20-cccccccccccc.md"));
    await fs.stat(path.join(rawDir, "notes.md"));
  });

  test("refuses to prune through a symlinked raw turns directory", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-linked-parent-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-linked-target-"));
    const rawParent = path.join(dir, ".hydra", "wiki", "raw");
    const rawDir = path.join(rawParent, "turns");
    const outsideFile = path.join(outside, "2026-04-20-aaaaaaaaaaaa.md");
    await fs.mkdir(rawParent, { recursive: true });
    await fs.writeFile(outsideFile, "outside evidence", "utf8");
    try {
      await fs.symlink(outside, rawDir, process.platform === "win32" ? "junction" : "dir");
    } catch (err) {
      t.skip(`directory symlinks are unavailable: ${String(err)}`);
      return;
    }

    await assert.rejects(
      pruneHydraWikiRawTurns(dir, "2026-05-21T12:00:00.000Z", 30),
      /Refusing to prune Hydra Wiki through a linked, replaced, or external parent/
    );
    assert.equal(await fs.readFile(outsideFile, "utf8"), "outside evidence");
  });

  test("does not prune a raw turn snapshot with multiple hard links", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-hardlink-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-hardlink-target-"));
    const rawDir = path.join(dir, ".hydra", "wiki", "raw", "turns");
    const fileName = "2026-04-20-aaaaaaaaaaaa.md";
    const outsideFile = path.join(outside, fileName);
    const linkedFile = path.join(rawDir, fileName);
    await fs.mkdir(rawDir, { recursive: true });
    await fs.writeFile(outsideFile, "shared evidence", "utf8");
    try {
      await fs.link(outsideFile, linkedFile);
    } catch (err) {
      t.skip(`hard links are unavailable: ${String(err)}`);
      return;
    }

    const pruned = await pruneHydraWikiRawTurns(dir, "2026-05-21T12:00:00.000Z", 30);

    assert.deepEqual(pruned.prunedPaths, []);
    assert.equal(await fs.readFile(outsideFile, "utf8"), "shared evidence");
    assert.equal(await fs.readFile(linkedFile, "utf8"), "shared evidence");
  });

  test("aborts if the raw turns parent is swapped after enumeration", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-parent-swap-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-parent-swap-target-"));
    const rawDir = path.join(dir, ".hydra", "wiki", "raw", "turns");
    const savedRawDir = path.join(dir, ".hydra", "wiki", "raw", "turns-before-swap");
    const fileName = "2026-04-20-aaaaaaaaaaaa.md";
    const outsideFile = path.join(outside, fileName);
    await fs.mkdir(rawDir, { recursive: true });
    await fs.writeFile(path.join(rawDir, fileName), "workspace evidence", "utf8");
    await fs.writeFile(outsideFile, "outside evidence", "utf8");

    const probe = path.join(dir, ".hydra", "wiki", "raw", "symlink-probe");
    try {
      await fs.symlink(outside, probe, process.platform === "win32" ? "junction" : "dir");
      await fs.unlink(probe);
    } catch (err) {
      t.skip(`directory symlinks are unavailable: ${String(err)}`);
      return;
    }

    const originalReaddir = nodeFs.promises.readdir;
    let swapped = false;
    Object.defineProperty(nodeFs.promises, "readdir", {
      configurable: true,
      writable: true,
      value: async (target: nodeFs.PathLike, options?: unknown) => {
        const entries = await (originalReaddir as (...args: unknown[]) => Promise<unknown>)(target, options);
        if (!swapped && path.resolve(String(target)) === path.resolve(rawDir)) {
          swapped = true;
          await fs.rename(rawDir, savedRawDir);
          await fs.symlink(outside, rawDir, process.platform === "win32" ? "junction" : "dir");
        }
        return entries;
      },
    });

    try {
      await assert.rejects(
        pruneHydraWikiRawTurns(dir, "2026-05-21T12:00:00.000Z", 30),
        /Refusing to prune Hydra Wiki through a linked, replaced, or external parent/
      );
      assert.equal(swapped, true);
      assert.equal(await fs.readFile(outsideFile, "utf8"), "outside evidence");
      assert.equal(await fs.readFile(path.join(savedRawDir, fileName), "utf8"), "workspace evidence");
    } finally {
      Object.defineProperty(nodeFs.promises, "readdir", {
        configurable: true,
        writable: true,
        value: originalReaddir,
      });
      if (swapped) {
        await fs.unlink(rawDir).catch(() => undefined);
        await fs.rename(savedRawDir, rawDir).catch(() => undefined);
      }
    }
  });

  test("keeps raw turn snapshots indefinitely when retention is zero", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-"));
    const rawDir = path.join(dir, ".hydra", "wiki", "raw", "turns");
    await fs.mkdir(rawDir, { recursive: true });
    await fs.writeFile(path.join(rawDir, "2026-04-20-aaaaaaaaaaaa.md"), "old", "utf8");

    const pruned = await pruneHydraWikiRawTurns(dir, "2026-05-21T12:00:00.000Z", 0);

    assert.deepEqual(pruned.prunedPaths, []);
    await fs.stat(path.join(rawDir, "2026-04-20-aaaaaaaaaaaa.md"));
  });

  test("reports invalid prune timestamps instead of silently skipping retention", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-wiki-"));

    const pruned = await pruneHydraWikiRawTurns(dir, "not-a-date", 30);

    assert.deepEqual(pruned.prunedPaths, []);
    assert.equal(pruned.invalidNowIso, "not-a-date");
  });
});
