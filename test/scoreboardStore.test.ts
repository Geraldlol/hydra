import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendScoreboardEvents,
  ensureScoreboardLedger,
  loadScoreboardEvents,
  renderScoreEvidenceMarkdown,
  renderScoreboardMarkdown,
} from "../src/scoreboardStore";
import type { ScoreboardEvent } from "../src/scoreboard";

function round(agentId: string, suffix: string): ScoreboardEvent[] {
  const occurredAt = "2026-07-14T12:00:00.000Z";
  return [
    {
      type: "claimRegistered",
      eventId: `event-claim-${suffix}`,
      occurredAt,
      claimId: `claim-${suffix}`,
      roundId: "round-1",
      agentId,
      domain: "runtime",
      statement: `${agentId} prediction`,
      confidence: 0.7,
    },
    {
      type: "verdictRecorded",
      eventId: `event-verdict-${suffix}`,
      occurredAt,
      verdictId: `verdict-${suffix}`,
      claimId: `claim-${suffix}`,
      outcome: "correct",
      source: "human",
      adjudicatorId: "local-user",
      evidenceRef: `human:local-user:${occurredAt}`,
      rationale: "Confirmed during review.",
    },
  ];
}

describe("scoreboard persistence", () => {
  test("creates, appends, replays, and aggregates the authoritative ledger", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-scoreboard-"));
    const file = path.join(dir, "score-events.jsonl");
    await ensureScoreboardLedger(file);
    assert.deepEqual(await loadScoreboardEvents(file), []);
    const aggregate = await appendScoreboardEvents(file, round("codex", "codex"));
    assert.equal(aggregate.eventCount, 2);
    assert.equal(aggregate.overallStandings[0]?.agentId, "codex");
    assert.deepEqual(await loadScoreboardEvents(file), round("codex", "codex"));
  });

  test("serializes concurrent logical batches without losing either round", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-scoreboard-race-"));
    const file = path.join(dir, "score-events.jsonl");
    await ensureScoreboardLedger(file);
    await Promise.all([
      appendScoreboardEvents(file, round("codex", "a")),
      appendScoreboardEvents(file, round("claude", "b")),
    ]);
    const events = await loadScoreboardEvents(file);
    assert.equal(events.length, 4);
    assert.deepEqual(new Set(events.filter((event) => event.type === "claimRegistered").map((event) => event.agentId)), new Set(["codex", "claude"]));
  });

  test("fails closed on malformed or referentially invalid history", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-scoreboard-invalid-"));
    const malformed = path.join(dir, "malformed.jsonl");
    await fs.writeFile(malformed, "{not-json}\n", "utf8");
    await assert.rejects(loadScoreboardEvents(malformed), /malformed JSON/);

    const invalid = path.join(dir, "invalid.jsonl");
    await fs.writeFile(invalid, `${JSON.stringify(round("codex", "x")[1])}\n`, "utf8");
    await assert.rejects(loadScoreboardEvents(invalid), /unknown or later claim/);
  });

  test("renders an inspectable passive-only mirror", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-scoreboard-render-"));
    const file = path.join(dir, "score-events.jsonl");
    const aggregate = await appendScoreboardEvents(file, round("codex", "render"));
    const markdown = renderScoreboardMarkdown(aggregate, (id) => id === "codex" ? "Codex" : id, "2026-07-14T13:00:00.000Z");
    assert.match(markdown, /Passive evidence tracker only/);
    assert.match(markdown, /never grant filesystem, terminal, network, approval, or orchestration authority/);
    assert.match(markdown, /\| 1 \| Codex \|/);
    assert.match(markdown, /Peer opinions are advisory/);

    const tied = await appendScoreboardEvents(file, round("claude", "render-tie"));
    const tiedMarkdown = renderScoreboardMarkdown(tied, (id) => id === "codex" ? "Codex" : id === "claude" ? "Claude" : id, "2026-07-14T13:01:00.000Z");
    assert.match(tiedMarkdown, /\| 1 \| Codex \|/);
    assert.match(tiedMarkdown, /\| 1 \| Claude \|/);
    assert.doesNotMatch(tiedMarkdown, /\| 2 \| (?:Codex|Claude) \|/);
  });

  test("renders the active evidence behind the standings", () => {
    const events = round("codex", "evidence");
    const markdown = renderScoreEvidenceMarkdown(events, (id) => id === "codex" ? "Codex" : id, "2026-07-14T13:00:00.000Z");
    assert.match(markdown, /Hydra Active Score Evidence/);
    assert.match(markdown, /Active verdicts: 1/);
    assert.match(markdown, /Codex/);
    assert.match(markdown, /codex prediction/);
    assert.match(markdown, /human:local-user/);
    assert.match(markdown, /Confirmed during review/);
    assert.match(markdown, /verdict-evidence/);
    assert.match(markdown, /operational authority/);

    const reversed = renderScoreEvidenceMarkdown([
      ...events,
      {
        type: "verdictReversed",
        eventId: "event-reverse-evidence",
        occurredAt: "2026-07-14T14:00:00.000Z",
        targetVerdictId: "verdict-evidence",
        reversedBy: "local-user",
        reason: "The fixture did not test the recorded claim.",
      },
    ], (id) => id, "2026-07-14T14:01:00.000Z");
    assert.match(reversed, /Pending claims: 1/);
    assert.match(reversed, /Reversed verdicts: 1/);
    assert.match(reversed, /Pending replacement adjudication/);
    assert.match(reversed, /Reversal history/);
    assert.match(reversed, /The fixture did not test the recorded claim/);
    assert.match(reversed, /human:local-user/);
  });
});
