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
  parseHydraWikiWrapupResponse,
  readHydraWikiFiles,
  readHydraWikiPromptContext,
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

    const context = readHydraWikiPromptContext(dir, 8000);

    assert.ok(context);
    assert.match(context.markdown, /--- Hydra wiki context ---/);
    assert.match(context.markdown, /Hydra has a run failure card feature/);
    assert.match(context.markdown, /failure-cards/);
    assert.deepEqual(context.files, [".hydra/wiki/context.md", ".hydra/wiki/index.md"]);
    assert.equal(context.truncated, false);
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
    assert.equal(source.truncated, false);
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

    const applied = await applyHydraWikiWrapupDraft(dir, {
      changed: true,
      title: "Failure card lesson",
      contextMarkdown: "# Hydra Wiki Context\n\nHydra has inline run failure cards.",
      indexMarkdown: "# Hydra Wiki Index\n\n- [[context]]: compiled room memory.",
      logEntryMarkdown: "- Updated failure-card lesson.",
    }, "2026-05-21T12:34:00.000Z");

    assert.equal(applied.changed, true);
    assert.equal(applied.contextChanged, true);
    assert.equal(applied.indexChanged, true);
    assert.equal(applied.logAppended, true);
    assert.match(await fs.readFile(path.join(dir, ".hydra", "wiki", "context.md"), "utf8"), /inline run failure cards/);
    assert.match(await fs.readFile(path.join(dir, ".hydra", "wiki", "index.md"), "utf8"), /\[\[context\]\]/);
    assert.match(await fs.readFile(path.join(dir, ".hydra", "wiki", "log.md"), "utf8"), /## \[2026-05-21\] wrapup | Failure card lesson/);
  });
});
