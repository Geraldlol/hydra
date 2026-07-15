import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  appendMessage,
  archiveAndResetTranscript,
  buildPromptContext,
  maybeAutoArchive,
  MAX_TRANSCRIPT_BYTES,
  readTranscript,
  parseTranscript,
  serializeMessage,
  ensureGitignore,
  ensureTranscriptFile,
  isAgentMessageRole,
  dropArchivedMessagePrefix,
  TranscriptMessage,
  transcriptAsContext,
  transcriptAsWindowedContext,
} from "../src/transcript";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "hydra-test-"));
}

describe("transcript", () => {
  test("drops only the persisted prefix after automatic rotation", () => {
    const pending = { id: "pending" };
    assert.deepEqual(dropArchivedMessagePrefix([{ id: "old-1" }, { id: "old-2" }, pending], 2), [pending]);
    assert.deepEqual(dropArchivedMessagePrefix([pending], -1), [pending]);
    assert.deepEqual(dropArchivedMessagePrefix([pending], 99), []);
  });

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
    assert.equal(read[0]!.role, "user");
    assert.equal(read[0]!.text, "first");
    assert.equal(read[1]!.role, "codex");
    assert.equal(read[1]!.phase, "opener");
    assert.equal(read[2]!.role, "claude");
    assert.equal(read[2]!.text, "answer B");
  });

  test("parseTranscript preserves cancelled and error tags", () => {
    const text =
      "# Hydra Room Transcript\n\n" +
      "## 2026-05-08T14:00:00Z Codex (opener) [cancelled]\n\npartial reply\n\n" +
      "## 2026-05-08T14:00:01Z Claude (reactor) [error]\n\nfailed\n";
    const messages = parseTranscript(text);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.cancelled, true);
    assert.equal(messages[1]!.error, true);
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

  test("buildPromptContext keeps the full active transcript", () => {
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
    assert.doesNotMatch(out, /Hydra context window/);
    assert.match(out, /u1/);
    assert.match(out, /old opener/);
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

  test("buildPromptContext keeps stale messages from the active transcript", () => {
    const now = Date.parse("2026-05-08T12:00:00.000Z");
    const messages: TranscriptMessage[] = [
      { role: "user", text: "week old task", timestamp: "2026-05-01T12:00:00.000Z" },
      { role: "codex", text: "week old answer", timestamp: "2026-05-01T12:00:01.000Z", phase: "opener" },
      { role: "user", text: "today task", timestamp: "2026-05-08T11:59:00.000Z" },
      { role: "codex", text: "today opener", timestamp: "2026-05-08T11:59:01.000Z", phase: "opener" },
    ];

    const out = buildPromptContext(messages, "reactor", 2, 24 * 60 * 60 * 1000, now);
    assert.doesNotMatch(out, /Hydra context window/);
    assert.match(out, /week old task/);
    assert.match(out, /week old answer/);
    assert.match(out, /today task/);
    assert.match(out, /today opener/);
  });

  test("buildPromptContext ignores terminal-poke turn limits", () => {
    const now = Date.parse("2026-05-08T12:00:00.000Z");
    const messages: TranscriptMessage[] = [
      { role: "user", text: "prior task", timestamp: "2026-05-08T11:00:00.000Z" },
      { role: "codex", text: "prior answer", timestamp: "2026-05-08T11:00:01.000Z", phase: "closer" },
      { role: "user", text: "current poke", timestamp: "2026-05-08T11:59:00.000Z" },
      { role: "codex", text: "current opener", timestamp: "2026-05-08T11:59:01.000Z", phase: "opener" },
    ];

    const out = buildPromptContext(messages, "reactor", 0, 24 * 60 * 60 * 1000, now);
    assert.match(out, /prior task/);
    assert.match(out, /prior answer/);
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
    assert.doesNotMatch(out, /Hydra context window/);
    assert.match(out, /original task/);
    assert.doesNotMatch(out, /Hydra auto-advanced after discussion/);
    assert.doesNotMatch(out, /default="Run npm test"/);
    assert.match(out, /Accepted default next action/);
    assert.match(out, /Run npm test/);
  });

  test("buildPromptContext windows long active transcripts by chars", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", text: "old task " + "A".repeat(80), timestamp: "t1" },
      { role: "codex", text: "old answer " + "B".repeat(80), timestamp: "t2", phase: "opener" },
      { role: "user", text: "fresh task", timestamp: "t3" },
      { role: "claude", text: "fresh answer", timestamp: "t4", phase: "reactor" },
    ];

    const out = buildPromptContext(messages, "closer", 2, 24 * 60 * 60 * 1000, Date.now(), 160);

    assert.match(out, /Hydra Context Window/);
    assert.match(out, /promptTranscriptMaxChars/);
    assert.doesNotMatch(out, /old task/);
    assert.doesNotMatch(out, /old answer/);
    assert.match(out, /fresh task/);
    assert.match(out, /fresh answer/);
  });

  test("transcriptAsWindowedContext reports omitted transcript cost", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", text: "old task " + "A".repeat(60), timestamp: "t1" },
      { role: "codex", text: "old answer " + "B".repeat(60), timestamp: "t2", phase: "opener" },
      { role: "user", text: "fresh task", timestamp: "t3" },
    ];

    const out = transcriptAsWindowedContext(messages, 80);

    assert.equal(out.truncated, true);
    assert.ok(out.originalChars > out.keptChars);
    assert.ok(out.keptChars > 0);
    assert.equal(out.omittedMessages, 2);
    assert.ok(out.omittedChars > 0);
    assert.doesNotMatch(out.markdown, /old answer/);
    assert.match(out.markdown, /fresh task/);
  });

  test("custom head ids round-trip without collapsing into system", () => {
    const serialized = serializeMessage({
      role: "gemini",
      text: "independent answer",
      timestamp: "2026-05-08T14:00:03Z",
      phase: "parallel",
    });
    assert.equal(serialized, "## 2026-05-08T14:00:03Z @gemini (parallel)\n\nindependent answer\n");
    const [parsed] = parseTranscript(`# Hydra Room Transcript\n\n${serialized}`);
    assert.equal(parsed?.role, "gemini");
    assert.equal(parsed?.phase, "parallel");
    assert.equal(isAgentMessageRole(parsed?.role ?? "system"), true);
  });

  test("refuses unsafe custom role ids that could forge transcript headers", () => {
    assert.throws(
      () => serializeMessage({ role: "bad role\n## forged", text: "x", timestamp: "t" }),
      /invalid Hydra agent role/,
    );
  });

  test("a single newest message cannot bypass the transcript character cap", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", text: `important prefix ${"X".repeat(2_000)}`, timestamp: "t1" },
    ];

    const out = transcriptAsWindowedContext(messages, 120);

    assert.equal(out.truncated, true);
    assert.equal(out.omittedMessages, 0);
    assert.ok(out.keptChars <= 120);
    assert.match(out.markdown, /important prefix/);
    assert.match(out.markdown, /newest message truncated/);
    assert.ok(out.originalChars > out.keptChars);
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

  test("ensureGitignore remains bounded and idempotent for oversized files", async () => {
    const dir = await makeTmpDir();
    const gitignore = path.join(dir, ".gitignore");
    await fs.writeFile(gitignore, "ignored-entry\n".repeat(25_000), "utf8");
    await ensureGitignore(dir);
    await ensureGitignore(dir);
    const tail = (await fs.readFile(gitignore, "utf8")).slice(-64);
    assert.equal((tail.match(/^\.hydra\/$/gm) ?? []).length, 1);
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
    assert.equal(read[0]!.text, body.trimEnd());
  });

  test("parseTranscript drops invalid phase tokens rather than corrupting them", () => {
    const text =
      "# Hydra Room Transcript\n\n" +
      "## 2026-05-08T14:00:00Z Codex (notarealphase)\n\nbody\n";
    const messages = parseTranscript(text);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.phase, undefined);
    assert.equal(messages[0]!.text, "body");
  });

  test("parseTranscript accepts legacy round phase aliases", () => {
    const text =
      "# Hydra Room Transcript\n\n" +
      "## 2026-05-08T14:00:00Z Codex (round1)\n\nold opener\n\n" +
      "## 2026-05-08T14:00:01Z Claude (round2)\n\nold reactor\n";
    const messages = parseTranscript(text);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.phase, "opener");
    assert.equal(messages[1]!.phase, "reactor");
  });

  test("parses a newline-dense body without allocating one entry per line", () => {
    const text = "# Hydra Room Transcript\n\n"
      + "## 2026-05-08T14:00:00Z Codex (opener)\n\n"
      + "\n".repeat(250_000);
    const messages = parseTranscript(text);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.text, "");
  });

  test("caps parsed messages at the newest transcript window", () => {
    const text = Array.from({ length: 10_005 }, (_, index) =>
      `## t-${index} System\n\nmessage-${index}\n`).join("\n");
    const messages = parseTranscript(text);
    assert.equal(messages.length, 10_000);
    assert.equal(messages[0]!.timestamp, "t-5");
    assert.equal(messages.at(-1)!.timestamp, "t-10004");
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
    const archived = await fs.readFile(path.join(archiveDir, archives[0]!), "utf8");
    assert.match(archived, /hello/);
    assert.match(archived, /padding/);

    // A subsequent append goes to the fresh transcript and round-trips.
    await appendMessage(file, { role: "user", text: "after rotate", timestamp: "2026-05-08T14:00:02Z" });
    const messages = await readTranscript(file);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.text, "after rotate");
  });

  test("append reports a pre-write rotation and keeps the newest message active", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, ".hydra", "transcript.md");
    const old = { role: "user" as const, text: "old", timestamp: "2026-05-08T14:00:00Z" };
    await appendMessage(file, old);

    // Inflate the existing active transcript past the production threshold;
    // the next ordinary append must rotate the old prefix before it writes.
    await fs.appendFile(file, "x".repeat(MAX_TRANSCRIPT_BYTES), "utf8");
    const newest = { role: "system" as const, text: "newest survives", timestamp: "2026-05-08T14:00:01Z" };
    const archived = await appendMessage(file, newest);

    assert.ok(archived);
    assert.equal(archived.archivedMessages, undefined);
    assert.deepEqual(await readTranscript(file), [newest]);
    assert.match(await fs.readFile(archived.archivePath, "utf8"), /old/);
  });

  test("bounds a single pathological message before it reaches disk", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, ".hydra", "transcript.md");
    await appendMessage(file, {
      role: "user",
      text: "z".repeat(MAX_TRANSCRIPT_BYTES + 1024),
      timestamp: "2026-05-08T14:00:00Z",
    });

    const stat = await fs.stat(file);
    assert.ok(stat.size <= MAX_TRANSCRIPT_BYTES);
    const messages = await readTranscript(file);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!.text, /transcript message truncated from/);
  });

  test("serializes rotation and appends across extension-host processes", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, ".hydra", "transcript.md");
    const barrier = path.join(dir, "start.barrier");
    const childScript = path.join(dir, "append-child.js");
    const transcriptModule = path.join(__dirname, "..", "src", "transcript.js");
    const prefix = "# Hydra Room Transcript\n\n## 2026-05-08T14:00:00Z You\n\nold-prefix\n";
    const paddingBytes = MAX_TRANSCRIPT_BYTES - Buffer.byteLength(prefix, "utf8") - 64;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${prefix}${"x".repeat(paddingBytes)}\n`, "utf8");
    await fs.writeFile(childScript, [
      'const fs = require("node:fs");',
      'const [modulePath, filePath, barrierPath, role, text, timestamp] = process.argv.slice(2);',
      '(async () => {',
      '  while (!fs.existsSync(barrierPath)) await new Promise((resolve) => setTimeout(resolve, 5));',
      '  const { appendMessage } = require(modulePath);',
      '  const result = await appendMessage(filePath, { role, text, timestamp });',
      '  process.stdout.write(JSON.stringify(result || null));',
      '})().catch((error) => { console.error(error); process.exitCode = 1; });',
    ].join("\n"), "utf8");

    const first = runAppendChild(childScript, [
      transcriptModule, file, barrier, "codex", "child-one", "2026-05-08T14:00:01Z",
    ]);
    const second = runAppendChild(childScript, [
      transcriptModule, file, barrier, "claude", "child-two", "2026-05-08T14:00:02Z",
    ]);
    await fs.writeFile(barrier, "go", "utf8");
    const outcomes = await Promise.all([first, second]);

    const active = await readTranscript(file);
    const archives = await fs.readdir(path.join(dir, ".hydra", "archive"));
    assert.equal(archives.length, 1);
    const archiveText = await fs.readFile(path.join(dir, ".hydra", "archive", archives[0]!), "utf8");
    const allMessages = [...parseTranscript(archiveText), ...active];
    assert.equal(allMessages.filter((message) => message.text.startsWith("old-prefix")).length, 1);
    assert.equal(allMessages.filter((message) => message.text === "child-one").length, 1);
    assert.equal(allMessages.filter((message) => message.text === "child-two").length, 1);
    assert.equal(allMessages.length, 3, `child outcomes: ${outcomes.join(" | ")}`);
    await assert.rejects(fs.stat(`${file}.lock`), { code: "ENOENT" });
  });

  test("recovers an expired malformed filesystem writer lock", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, ".hydra", "transcript.md");
    await appendMessage(file, { role: "user", text: "before stale lock", timestamp: "2026-05-08T14:00:00Z" });
    const lock = `${file}.lock`;
    await fs.writeFile(lock, "malformed", "utf8");
    const expired = new Date(Date.now() - 3 * 60_000);
    await fs.utimes(lock, expired, expired);

    await appendMessage(file, { role: "system", text: "after stale lock", timestamp: "2026-05-08T14:00:01Z" });
    assert.deepEqual((await readTranscript(file)).map((message) => message.text), [
      "before stale lock",
      "after stale lock",
    ]);
    await assert.rejects(fs.stat(lock), { code: "ENOENT" });
  });

  test("stale-lock recovery does not move an in-flight replacement owner", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, ".hydra", "transcript.md");
    await appendMessage(file, { role: "user", text: "before recovery", timestamp: "2026-05-08T14:00:00Z" });
    const lock = `${file}.lock`;
    await fs.writeFile(lock, "stale-owner", "utf8");
    const expired = new Date(Date.now() - 3 * 60_000);
    await fs.utimes(lock, expired, expired);

    // Model a contender that announced its acquisition just before recovery.
    // The recovery marker must fence retirement until this contender either
    // publishes and validates its replacement lease or stands down.
    const acquisitionMarker = `${lock}.acquire-controlled-replacement`;
    await fs.writeFile(acquisitionMarker, `${process.pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const pendingAppend = appendMessage(file, {
      role: "system",
      text: "after replacement",
      timestamp: "2026-05-08T14:00:01Z",
    });
    await waitForDirectoryEntry(path.dirname(lock), `${path.basename(lock)}.recover-`);

    const retiredFixture = `${lock}.fixture-stale`;
    await fs.rename(lock, retiredFixture);
    const replacementToken = "controlled-replacement-owner";
    await fs.writeFile(lock, `${JSON.stringify({
      token: replacementToken,
      createdAt: new Date().toISOString(),
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.unlink(acquisitionMarker);

    let earlyAppend: "completed" | "pending";
    let canonicalToken: string | undefined;
    try {
      earlyAppend = await Promise.race([
        pendingAppend.then(() => "completed" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
      ]);
      canonicalToken = (JSON.parse(await fs.readFile(lock, "utf8")) as { token?: string }).token;
    } finally {
      await fs.unlink(acquisitionMarker).catch(() => undefined);
      await fs.unlink(lock).catch(() => undefined);
      await pendingAppend;
      await fs.unlink(retiredFixture).catch(() => undefined);
    }
    assert.equal(earlyAppend, "pending", "replacement owner must remain canonical and block the waiter");
    assert.equal(canonicalToken, replacementToken);
    assert.deepEqual((await readTranscript(file)).map((message) => message.text), [
      "before recovery",
      "after replacement",
    ]);
    await assert.rejects(fs.stat(lock), { code: "ENOENT" });
  });

  test("parseTranscript accepts parallel discussion phase", () => {
    const text =
      "# Hydra Room Transcript\n\n" +
      "## 2026-05-08T14:00:00Z Codex (parallel)\n\nindependent pass\n";
    const messages = parseTranscript(text);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.phase, "parallel");
  });
});

function runAppendChild(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [script, ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-8_192); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_192); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`append child exited ${code}: ${stderr}`));
    });
  });
}

async function waitForDirectoryEntry(directory: string, prefix: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const entries = await fs.readdir(directory);
    if (entries.some((entry) => entry.startsWith(prefix))) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${prefix} in ${directory}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
