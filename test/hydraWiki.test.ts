import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyHydraWikiWrapupDraft,
  buildHydraWikiWrapupPrompt,
  ensureHydraWikiFiles,
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
    assert.equal(source.truncated, false);
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
    assert.match(prompt, /--- existing context\.md ---/);
    assert.match(prompt, /Existing fact/);
    assert.match(prompt, /remember the new runbook/);
    assert.match(prompt, /"contextMarkdown"/);
    assert.match(prompt, /Raw source snapshot:/);
    assert.match(prompt, new RegExp(source.sha256));
    assert.match(prompt, new RegExp(`\\[src:${source.sha256.slice(0, 12)}\\]`));
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
