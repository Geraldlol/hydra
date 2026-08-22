import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  appendFileSafely,
  atomicWriteFile,
  ensureFile,
  readFileHead,
  serializePerFileAcrossProcesses,
} from "./fileQueue";
import {
  aggregateScoreboard,
  listActiveScoreEvidence,
  listPendingScoreClaims,
  listReversedScoreEvidence,
  ScoreboardValidationError,
  validateScoreboardEvents,
  type ScoreboardAggregate,
  type ScoreboardEvent,
} from "./scoreboard";

export const MAX_SCOREBOARD_LEDGER_BYTES = 16 * 1024 * 1024;
export const MAX_SCOREBOARD_EVENTS = 100_000;
const MAX_SCOREBOARD_LINE_CHARS = 16 * 1024;

export async function ensureScoreboardLedger(filePath: string): Promise<void> {
  await ensureFile(filePath);
}

/**
 * Loads the complete authoritative ledger. Unlike diagnostic JSONL readers,
 * this fails closed on truncation, malformed rows, or invalid references: a
 * silently partial history could award the wrong head.
 */
export async function loadScoreboardEvents(filePath: string): Promise<ScoreboardEvent[]> {
  await ensureScoreboardLedger(filePath);
  const bounded = await readFileHead(filePath, MAX_SCOREBOARD_LEDGER_BYTES + 1);
  if (bounded.totalBytes > MAX_SCOREBOARD_LEDGER_BYTES || bounded.truncated) {
    throw new Error(`Hydra standings ledger exceeds ${MAX_SCOREBOARD_LEDGER_BYTES} bytes; archive it before recording more verdicts.`);
  }

  const parsed: unknown[] = [];
  let start = 0;
  for (let index = 0; index <= bounded.text.length; index += 1) {
    if (index !== bounded.text.length && bounded.text.charCodeAt(index) !== 10) continue;
    const rawLine = bounded.text.slice(start, index).replace(/\r$/, "");
    start = index + 1;
    const line = rawLine.trim();
    if (!line) continue;
    if (rawLine.length > MAX_SCOREBOARD_LINE_CHARS || Buffer.byteLength(rawLine, "utf8") > MAX_SCOREBOARD_LINE_CHARS) {
      throw new Error("Hydra standings ledger contains an oversized event row.");
    }
    if (parsed.length >= MAX_SCOREBOARD_EVENTS) {
      throw new Error(`Hydra standings ledger exceeds ${MAX_SCOREBOARD_EVENTS} events; archive it before recording more verdicts.`);
    }
    try {
      parsed.push(JSON.parse(line));
    } catch {
      throw new Error(`Hydra standings ledger contains malformed JSON at event ${parsed.length + 1}.`);
    }
  }

  const issues = validateScoreboardEvents(parsed);
  if (issues.length > 0) throw new ScoreboardValidationError(issues);
  return parsed as ScoreboardEvent[];
}

/** Appends one logical batch under a cross-process lease after full replay. */
export async function appendScoreboardEvents(
  filePath: string,
  additions: readonly ScoreboardEvent[],
): Promise<ScoreboardAggregate> {
  if (additions.length === 0) return aggregateScoreboard(await loadScoreboardEvents(filePath));
  return serializePerFileAcrossProcesses(filePath, async () => {
    const current = await loadScoreboardEvents(filePath);
    return appendValidatedScoreboardRows(filePath, current, additions);
  });
}

/**
 * Idempotent append for events derived from durable receipts. Exact retries
 * are no-ops; an event-id collision with different content still fails closed.
 */
export async function appendScoreboardEventsIfAbsent(
  filePath: string,
  additions: readonly ScoreboardEvent[],
): Promise<ScoreboardAggregate> {
  if (additions.length === 0) return aggregateScoreboard(await loadScoreboardEvents(filePath));
  return serializePerFileAcrossProcesses(filePath, async () => {
    const current = await loadScoreboardEvents(filePath);
    const byEventId = new Map(current.map((event) => [event.eventId, event]));
    const missing: ScoreboardEvent[] = [];
    for (const addition of additions) {
      const existing = byEventId.get(addition.eventId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(addition)) {
          throw new Error(`Hydra standings event id collision for ${addition.eventId}.`);
        }
        continue;
      }
      byEventId.set(addition.eventId, addition);
      missing.push(addition);
    }
    if (missing.length === 0) return aggregateScoreboard(current);
    return appendValidatedScoreboardRows(filePath, current, missing);
  });
}

async function appendValidatedScoreboardRows(
  filePath: string,
  current: readonly ScoreboardEvent[],
  additions: readonly ScoreboardEvent[],
): Promise<ScoreboardAggregate> {
  const next = [...current, ...additions];
  if (next.length > MAX_SCOREBOARD_EVENTS) {
    throw new Error(`Hydra standings ledger cannot exceed ${MAX_SCOREBOARD_EVENTS} events.`);
  }
  const issues = validateScoreboardEvents(next);
  if (issues.length > 0) throw new ScoreboardValidationError(issues);
  const rows = additions.map((event) => JSON.stringify(event));
  if (rows.some((row) => row.length > MAX_SCOREBOARD_LINE_CHARS || Buffer.byteLength(row, "utf8") > MAX_SCOREBOARD_LINE_CHARS)) {
    throw new Error(`Hydra standings ledger rows cannot exceed ${MAX_SCOREBOARD_LINE_CHARS} bytes.`);
  }
  const body = rows.join("\n") + "\n";
  const stat = await fs.stat(filePath);
  if (stat.size + Buffer.byteLength(body, "utf8") > MAX_SCOREBOARD_LEDGER_BYTES) {
    throw new Error(`Hydra standings ledger cannot exceed ${MAX_SCOREBOARD_LEDGER_BYTES} bytes.`);
  }
  await appendFileSafely(filePath, body);
  return aggregateScoreboard(next);
}

export async function writeScoreboardMirror(
  filePath: string,
  aggregate: ScoreboardAggregate,
  displayName: (agentId: string) => string = (agentId) => agentId,
  generatedAt = new Date().toISOString(),
): Promise<void> {
  await atomicWriteFile(filePath, renderScoreboardMarkdown(aggregate, displayName, generatedAt));
}

export async function writeScoreEvidenceMirror(
  filePath: string,
  events: readonly ScoreboardEvent[],
  displayName: (agentId: string) => string = (agentId) => agentId,
  generatedAt = new Date().toISOString(),
): Promise<void> {
  await atomicWriteFile(filePath, renderScoreEvidenceMarkdown(events, displayName, generatedAt));
}

/** Renders only active verdicts: these are the evidence rows currently driving standings. */
export function renderScoreEvidenceMarkdown(
  events: readonly ScoreboardEvent[],
  displayName: (agentId: string) => string = (agentId) => agentId,
  generatedAt = new Date().toISOString(),
): string {
  const active = listActiveScoreEvidence(events);
  const pending = listPendingScoreClaims(events);
  const reversed = listReversedScoreEvidence(events);
  const lines = [
    "# Hydra Active Score Evidence",
    "",
    "> Human-auditable evidence for the passive standings. Reversals append a new ledger event; history is never erased.",
    "> Peer assessments are advisory and do not affect scores or any operational authority.",
    "",
    `Generated: ${safeCell(generatedAt)}`,
    `Active verdicts: ${active.length}`,
    `Pending claims: ${pending.length}`,
    `Reversed verdicts: ${reversed.length}`,
    "",
  ];

  lines.push("## Active evidence", "");
  if (active.length === 0) {
    lines.push("No active verdicts yet.");
  } else {
    lines.push(
      "| Head | Domain | Outcome | Source | Round | Claim | Evidence | Rationale | Verdict ID |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const { claim, verdict } of active) {
      lines.push(`| ${safeCell(displayName(claim.agentId))} | ${safeCell(claim.domain)} | ${safeCell(verdict.outcome)} | ${safeCell(`${verdict.source}:${verdict.adjudicatorId}`)} | ${safeCell(claim.roundId)} | ${safeCell(claim.statement)} | ${safeCell(verdict.evidenceRef)} | ${safeCell(verdict.rationale)} | ${safeCell(verdict.verdictId)} |`);
    }
  }

  lines.push("", "## Pending replacement adjudication", "");
  if (pending.length === 0) {
    lines.push("No pending claims.");
  } else {
    lines.push("| Head | Domain | Round | Claim | Claim ID |", "| --- | --- | --- | --- | --- |");
    for (const claim of pending) {
      lines.push(`| ${safeCell(displayName(claim.agentId))} | ${safeCell(claim.domain)} | ${safeCell(claim.roundId)} | ${safeCell(claim.statement)} | ${safeCell(claim.claimId)} |`);
    }
  }

  lines.push("", "## Reversal history", "");
  if (reversed.length === 0) {
    lines.push("No reversed verdicts.");
  } else {
    lines.push(
      "| Head | Claim | Original verdict | Original evidence | Reversed by | Reversal reason | Reversed at |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const { claim, verdict, reversal } of reversed) {
      lines.push(`| ${safeCell(displayName(claim.agentId))} | ${safeCell(claim.statement)} | ${safeCell(verdict.outcome)} (${safeCell(verdict.source)}) | ${safeCell(verdict.evidenceRef)} — ${safeCell(verdict.rationale)} | ${safeCell(reversal.reversedBy)} | ${safeCell(reversal.reason)} | ${safeCell(reversal.occurredAt)} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function renderScoreboardMarkdown(
  aggregate: ScoreboardAggregate,
  displayName: (agentId: string) => string = (agentId) => agentId,
  generatedAt = new Date().toISOString(),
): string {
  const lines = [
    "# Hydra Standings",
    "",
    "> Passive evidence tracker only. Standings never grant filesystem, terminal, network, approval, or orchestration authority.",
    "> Peer opinions are advisory and do not affect score. Duel ratings are a separate future system.",
    "",
    `Generated: ${safeCell(generatedAt)}`,
    `Ledger events: ${aggregate.eventCount}`,
    "",
    "## Overall",
    "",
  ];

  if (aggregate.overallStandings.length === 0) {
    lines.push("No adjudicated claims yet.");
  } else {
    lines.push("| Rank | Head | Score | Accuracy | Reliability | Evidence | Record | Status |", "| ---: | --- | ---: | ---: | ---: | ---: | --- | --- |");
    let scoredPosition = 0;
    let visibleRank = 0;
    let previousScore: number | undefined;
    aggregate.overallStandings.forEach((row) => {
      const record = `${row.counts.trustedCorrect}W / ${row.counts.trustedPartial}P / ${row.counts.trustedIncorrect}L`;
      if (row.score !== null) {
        scoredPosition += 1;
        if (previousScore === undefined || row.score !== previousScore) visibleRank = scoredPosition;
        previousScore = row.score;
      }
      const rank = row.score === null ? "—" : String(visibleRank);
      lines.push(`| ${rank} | ${safeCell(displayName(row.agentId))} | ${percent(row.score)} | ${percent(row.weightedAccuracy)} | ${percent(row.reliability)} | ${row.counts.independentRounds} rounds | ${record} | ${row.provisional ? "provisional" : "established"} |`);
    });
  }

  lines.push("", "## By domain", "");
  if (aggregate.standings.length === 0) {
    lines.push("No domain standings yet.");
  } else {
    lines.push("| Domain | Head | Score | Evidence | Advisory | Record |", "| --- | --- | ---: | ---: | ---: | --- |");
    for (const row of aggregate.standings) {
      const record = `${row.counts.trustedCorrect}W / ${row.counts.trustedPartial}P / ${row.counts.trustedIncorrect}L`;
      lines.push(`| ${safeCell(row.domain)} | ${safeCell(displayName(row.agentId))} | ${percent(row.score)} | ${row.counts.independentRounds} rounds | ${row.counts.advisoryResolved} | ${record} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function privateScoreboardPath(storageRoot: string): string {
  return path.join(storageRoot, "competition", "score-events.jsonl");
}

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function safeCell(value: string): string {
  return value.replace(/[\r\n|]/g, " ").replace(/\s+/g, " ").trim();
}
