import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  appendMessage,
  archiveAndResetTranscript,
  buildPromptContext,
  maybeAutoArchive,
  readTranscript,
  parseTranscript,
  serializeMessage,
  ensureGitignore,
  ensureTranscriptFile,
  TranscriptMessage,
  transcriptAsContext,
} from "../src/transcript";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "hydra-test-"));
}

describe("transcript", () => {
  test("serializeMessage formats user message", () => {
    const out = serializeMessage({
      role: "user",
      text: "hello",
      timestamp: "2026-05-08T14:00:00Z",
    });
    assert.equal(out, "## 2026-05-08T14:00:00Z You\n\nhello\n");
  });

  test("serializeMessage tags phase, error, cancelled", () => {
    const out = serializeMessage({
      role: "claude",
      text: "partial",
      timestamp: "2026-05-08T14:00:00Z",
      phase: "opener",
      cancelled: true,
    });
    assert.equal(out, "## 2026-05-08T14:00:00Z Claude (opener) [cancelled]\n\npartial\n");
  });

  test("appendMessage writes header on first call", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "t.md");
    await appendMessage(file, { role: "user", text: "hi", timestamp: "2026-05-08T14:00:00Z" });
    const text = await fs.readFile(file, "utf8");
    assert.match(text, /^# Hydra Room Transcript\n/);
    assert.match(text, /## 2026-05-08T14:00:00Z You\n\nhi\n$/);
  });

  test("appendMessage round-trips via readTranscript", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "t.md");
    const messages: TranscriptMessage[] = [
      { role: "user", text: "first", timestamp: "2026-05-08T14:00:00Z" },
      { role: "codex", text: "answer A", timestamp: "2026-05-08T14:00:01Z", phase: "opener" },
      { role: "claude", text: "answer B", timestamp: "2026-05-08T14:00:02Z", phase: "reactor" },
    ];
    for (const m of messages) await appendMessage(file, m);
    const read = await readTranscript(file);
    assert.equal(read.length, 3);
    assert.equal(read[0].role, "user");
    assert.equal(read[0].text, "first");
    assert.equal(read[1].role, "codex");
    assert.equal(read[1].phase, "opener");
    assert.equal(read[2].role, "claude");
    assert.equal(read[2].text, "answer B");
  });

  test("parseTranscript preserves cancelled and error tags", () => {
    const text =
      "# Hydra Room Transcript\n\n" +
      "## 2026-05-08T14:00:00Z Codex (opener) [cancelled]\n\npartial reply\n\n" +
      "## 2026-05-08T14:00:01Z Claude (reactor) [error]\n\nfailed\n";
    const messages = parseTranscript(text);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].cancelled, true);
    assert.equal(messages[1].error, true);
  });

  test("transcriptAsContext joins messages without trailing whitespace blowup", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", text: "a", timestamp: "t1" },
      { role: "codex", text: "b", timestamp: "t2", phase: "opener" },
    ];
    const out = transcriptAsContext(messages);
    assert.match(out, /## t1 You\n\na\n/);
    assert.match(out, /## t2 Codex \(opener\)\n\nb\n/);
  });

  test("buildPromptContext keeps current turn plus two prior user turns", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", text: "u1", timestamp: "t1" },
      { role: "codex", text: "old opener", timestamp: "t2", phase: "opener" },
      { role: "user", text: "u2", timestamp: "t3" },
      { role: "claude", text: "turn 2 opener", timestamp: "t4", phase: "opener" },
      { role: "user", text: "u3", timestamp: "t5" },
      { role: "codex", text: "turn 3 opener", timestamp: "t6", phase: "opener" },
      { role: "claude", text: "turn 3 reactor", timestamp: "t7", phase: "reactor" },
      { role: "user", text: "u4 current", timestamp: "t8" },
      { role: "codex", text: "current opener", timestamp: "t9", phase: "opener" },
      { role: "claude", text: "current reactor", timestamp: "t10", phase: "reactor" },
    ];

    const out = buildPromptContext(messages, "closer");
    assert.match(out, /Hydra context window: 2 message\(s\) omitted/);
    assert.doesNotMatch(out, /u1/);
    assert.doesNotMatch(out, /old opener/);
    assert.match(out, /u2/);
    assert.match(out, /u3/);
    assert.match(out, /u4 current/);
    assert.match(out, /current opener/);
    assert.match(out, /current reactor/);
  });

  test("buildPromptContext leaves short transcripts unchanged", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", text: "u1", timestamp: "t1" },
      { role: "codex", text: "opener", timestamp: "t2", phase: "opener" },
      { role: "user", text: "u2", timestamp: "t3" },
    ];
    const out = buildPromptContext(messages, "opener");
    assert.doesNotMatch(out, /Hydra context window/);
    assert.match(out, /u1/);
    assert.match(out, /opener/);
    assert.match(out, /u2/);
  });

  test("buildPromptContext drops stale messages even when they are in the turn window", () => {
    const now = Date.parse("2026-05-08T12:00:00.000Z");
    const messages: TranscriptMessage[] = [
      { role: "user", text: "week old task", timestamp: "2026-05-01T12:00:00.000Z" },
      { role: "codex", text: "week old answer", timestamp: "2026-05-01T12:00:01.000Z", phase: "opener" },
      { role: "user", text: "today task", timestamp: "2026-05-08T11:59:00.000Z" },
      { role: "codex", text: "today opener", timestamp: "2026-05-08T11:59:01.000Z", phase: "opener" },
    ];

    const out = buildPromptContext(messages, "reactor", 2, 24 * 60 * 60 * 1000, now);
    assert.match(out, /older than 1d/);
    assert.doesNotMatch(out, /week old/);
    assert.match(out, /today task/);
    assert.match(out, /today opener/);
  });

  test("buildPromptContext supports terminal-poke windows with no previous turns", () => {
    const now = Date.parse("2026-05-08T12:00:00.000Z");
    const messages: TranscriptMessage[] = [
      { role: "user", text: "prior task", timestamp: "2026-05-08T11:00:00.000Z" },
      { role: "codex", text: "prior answer", timestamp: "2026-05-08T11:00:01.000Z", phase: "closer" },
      { role: "user", text: "current poke", timestamp: "2026-05-08T11:59:00.000Z" },
      { role: "codex", text: "current opener", timestamp: "2026-05-08T11:59:01.000Z", phase: "opener" },
    ];

    const out = buildPromptContext(messages, "reactor", 0, 24 * 60 * 60 * 1000, now);
    assert.doesNotMatch(out, /prior task/);
    assert.doesNotMatch(out, /prior answer/);
    assert.match(out, /current poke/);
    assert.match(out, /current opener/);
  });

  test("buildPromptContext omits auto-advance system bookkeeping from prompts", () => {
    const now = Date.parse("2026-05-08T12:00:00.000Z");
    const messages: TranscriptMessage[] = [
      { role: "user", text: "original task", timestamp: "2026-05-08T11:59:00.000Z" },
      {
        role: "system",
        text:
          "Hydra auto-advanced after discussion (send-instruction 1/3): Send the default action back into the room as the next user instruction.\n" +
          "  why: codex closer @ 2026-05-08T11:59:05.000Z · default=\"Run npm test\" · needs-user=none · blockers=none",
        timestamp: "2026-05-08T11:59:05.000Z",
      },
      { role: "user", text: "Accepted default next action:\n\nRun npm test", timestamp: "2026-05-08T11:59:06.000Z" },
    ];

    const out = buildPromptContext(messages, "opener", 0, 24 * 60 * 60 * 1000, now);
    assert.match(out, /Hydra context window: 2 message\(s\) omitted/);
    assert.doesNotMatch(out, /Hydra auto-advanced after discussion/);
    assert.doesNotMatch(out, /default="Run npm test"/);
    assert.match(out, /Accepted default next action/);
    assert.match(out, /Run npm test/);
  });

  test("readTranscript returns [] when file does not exist", async () => {
    const dir = await makeTmpDir();
    const out = await readTranscript(path.join(dir, "missing.md"));
    assert.deepEqual(out, []);
  });

  test("archiveAndResetTranscript moves current history into .hydra archive and clears active transcript", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, ".hydra", "transcript.md");
    await appendMessage(file, { role: "user", text: "old task", timestamp: "2026-05-08T14:00:00Z" });
    await appendMessage(file, { role: "codex", text: "old answer", timestamp: "2026-05-08T14:00:01Z", phase: "opener" });

    const result = await archiveAndResetTranscript(file, new Date("2026-05-10T01:02:03.004Z"));

    assert.equal(result.archivePath, path.join(dir, ".hydra", "archive", "transcript-2026-05-10T01-02-03-004Z.md"));
    assert.equal(result.archivedMessages, 2);
    assert.match(await fs.readFile(result.archivePath, "utf8"), /old task/);
    assert.equal(await fs.readFile(file, "utf8"), "# Hydra Room Transcript\n\n");
  });

  test("ensureGitignore adds .hydra/ to a fresh .gitignore", async () => {
    const dir = await makeTmpDir();
    await ensureGitignore(dir);
    const text = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    assert.match(text, /^\.hydra\/$/m);
  });

  test("ensureGitignore is idempotent", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n.hydra/\n", "utf8");
    await ensureGitignore(dir);
    const text = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    const matches = text.match(/^\.hydra\/$/gm) ?? [];
    assert.equal(matches.length, 1);
  });

  test("ensureGitignore appends with separator if file lacks trailing newline", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/", "utf8");
    await ensureGitignore(dir);
    const text = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    assert.match(text, /node_modules\/\n\.hydra\/\n/);
  });

  test("ensureTranscriptFile creates file with header if missing", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "nested", "transcript.md");
    await ensureTranscriptFile(file);
    const text = await fs.readFile(file, "utf8");
    assert.equal(text, "# Hydra Room Transcript\n\n");
  });

  test("ensureTranscriptFile leaves existing file untouched", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "transcript.md");
    await fs.writeFile(file, "## existing content\n", "utf8");
    await ensureTranscriptFile(file);
    const text = await fs.readFile(file, "utf8");
    assert.equal(text, "## existing content\n");
  });

  test("multiline body with markdown headings round-trips intact", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "t.md");
    const body = "Here's a plan:\n\n### Step 1\nDo a thing.\n\n### Step 2\nDo another thing.\n";
    await appendMessage(file, {
      role: "claude",
      text: body,
      timestamp: "2026-05-08T14:00:00Z",
      phase: "opener",
    });
    const read = await readTranscript(file);
    assert.equal(read.length, 1);
    assert.equal(read[0].text, body.trimEnd());
  });

  test("parseTranscript drops invalid phase tokens rather than corrupting them", () => {
    const text =
      "# Hydra Room Transcript\n\n" +
      "## 2026-05-08T14:00:00Z Codex (notarealphase)\n\nbody\n";
    const messages = parseTranscript(text);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].phase, undefined);
    assert.equal(messages[0].text, "body");
  });

  test("parseTranscript accepts legacy round phase aliases", () => {
    const text =
      "# Hydra Room Transcript\n\n" +
      "## 2026-05-08T14:00:00Z Codex (round1)\n\nold opener\n\n" +
      "## 2026-05-08T14:00:01Z Claude (round2)\n\nold reactor\n";
    const messages = parseTranscript(text);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].phase, "opener");
    assert.equal(messages[1].phase, "reactor");
  });

  test("auto-archives when transcript file exceeds size threshold", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, ".hydra", "transcript.md");

    // Seed the transcript with a couple of messages.
    await appendMessage(file, { role: "user", text: "hello", timestamp: "2026-05-08T14:00:00Z" });
    await appendMessage(file, {
      role: "codex",
      text: "padding ".repeat(64),
      timestamp: "2026-05-08T14:00:01Z",
      phase: "opener",
    });

    const before = await fs.readFile(file, "utf8");
    assert.ok(before.length > 64, "seed should produce a non-trivial transcript");

    // Use a tiny threshold so the existing seeded transcript trips it. This
    // verifies the auto-archive trigger without writing 25 MB of test data.
    const rotated = await maybeAutoArchive(file, 16);
    assert.equal(rotated, true);

    // Active transcript is reset to the header.
    const active = await fs.readFile(file, "utf8");
    assert.equal(active, "# Hydra Room Transcript\n\n");

    // Exactly one archive file was created, containing the prior content.
    const archiveDir = path.join(dir, ".hydra", "archive");
    const archives = await fs.readdir(archiveDir);
    assert.equal(archives.length, 1);
    const archived = await fs.readFile(path.join(archiveDir, archives[0]), "utf8");
    assert.match(archived, /hello/);
    assert.match(archived, /padding/);

    // A subsequent append goes to the fresh transcript and round-trips.
    await appendMessage(file, { role: "user", text: "after rotate", timestamp: "2026-05-08T14:00:02Z" });
    const messages = await readTranscript(file);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, "after rotate");
  });

  test("parseTranscript accepts parallel discussion phase", () => {
    const text =
      "# Hydra Room Transcript\n\n" +
      "## 2026-05-08T14:00:00Z Codex (parallel)\n\nindependent pass\n";
    const messages = parseTranscript(text);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].phase, "parallel");
  });
});
