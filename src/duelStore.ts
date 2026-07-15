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
  aggregateDuels,
  DuelValidationError,
  validateDuelEvents,
  type DuelAggregate,
  type DuelEvent,
} from "./duels";

export const MAX_DUEL_LEDGER_BYTES = 16 * 1024 * 1024;
export const MAX_DUEL_EVENTS = 100_000;
// A paired reveal may contain two 4,000-character answers. JSON escaping can
// expand control characters, so keep a bounded row ceiling that still admits
// every payload accepted by the core duel validator.
const MAX_DUEL_LINE_CHARS = 64 * 1024;

export async function ensureDuelLedger(filePath: string): Promise<void> {
  await ensureFile(filePath);
}

/**
 * Loads the complete authoritative duel ledger. Rating and reveal state are
 * replay-derived, so a partial or invalid history must never be accepted.
 */
export async function loadDuelEvents(filePath: string): Promise<DuelEvent[]> {
  await ensureDuelLedger(filePath);
  const bounded = await readFileHead(filePath, MAX_DUEL_LEDGER_BYTES + 1);
  if (bounded.totalBytes > MAX_DUEL_LEDGER_BYTES || bounded.truncated) {
    throw new Error(`Hydra duel ledger exceeds ${MAX_DUEL_LEDGER_BYTES} bytes; archive it before recording more duels.`);
  }

  const parsed: unknown[] = [];
  let start = 0;
  for (let index = 0; index <= bounded.text.length; index += 1) {
    if (index !== bounded.text.length && bounded.text.charCodeAt(index) !== 10) continue;
    const rawLine = bounded.text.slice(start, index).replace(/\r$/, "");
    start = index + 1;
    const line = rawLine.trim();
    if (!line) continue;
    if (rawLine.length > MAX_DUEL_LINE_CHARS || Buffer.byteLength(rawLine, "utf8") > MAX_DUEL_LINE_CHARS) {
      throw new Error("Hydra duel ledger contains an oversized event row.");
    }
    if (parsed.length >= MAX_DUEL_EVENTS) {
      throw new Error(`Hydra duel ledger exceeds ${MAX_DUEL_EVENTS} events; archive it before recording more duels.`);
    }
    try {
      parsed.push(JSON.parse(line));
    } catch {
      throw new Error(`Hydra duel ledger contains malformed JSON at event ${parsed.length + 1}.`);
    }
  }

  const issues = validateDuelEvents(parsed);
  if (issues.length > 0) throw new DuelValidationError(issues);
  return parsed as DuelEvent[];
}

/** Appends one logical batch under a cross-process lease after full replay. */
export async function appendDuelEvents(
  filePath: string,
  additions: readonly DuelEvent[],
): Promise<DuelAggregate> {
  if (additions.length === 0) return aggregateDuels(await loadDuelEvents(filePath));
  return serializePerFileAcrossProcesses(filePath, async () => {
    const current = await loadDuelEvents(filePath);
    const next = [...current, ...additions];
    if (next.length > MAX_DUEL_EVENTS) {
      throw new Error(`Hydra duel ledger cannot exceed ${MAX_DUEL_EVENTS} events.`);
    }
    const issues = validateDuelEvents(next);
    if (issues.length > 0) throw new DuelValidationError(issues);
    const rows = additions.map((event) => JSON.stringify(event));
    if (rows.some((row) => row.length > MAX_DUEL_LINE_CHARS || Buffer.byteLength(row, "utf8") > MAX_DUEL_LINE_CHARS)) {
      throw new Error(`Hydra duel ledger rows cannot exceed ${MAX_DUEL_LINE_CHARS} bytes.`);
    }
    const body = rows.join("\n") + "\n";
    const stat = await fs.stat(filePath);
    if (stat.size + Buffer.byteLength(body, "utf8") > MAX_DUEL_LEDGER_BYTES) {
      throw new Error(`Hydra duel ledger cannot exceed ${MAX_DUEL_LEDGER_BYTES} bytes.`);
    }
    await appendFileSafely(filePath, body);
    return aggregateDuels(next);
  });
}

export async function writeDuelMirror(
  filePath: string,
  events: readonly DuelEvent[],
  displayName: (agentId: string) => string = (agentId) => agentId,
  generatedAt = new Date().toISOString(),
): Promise<void> {
  await atomicWriteFile(filePath, renderDuelMarkdown(events, displayName, generatedAt));
}

/**
 * Renders a disposable human audit. Sealed payloads are intentionally absent:
 * answers appear only when a paired reveal event has made both public together.
 */
export function renderDuelMarkdown(
  events: readonly DuelEvent[],
  displayName: (agentId: string) => string = (agentId) => agentId,
  generatedAt = new Date().toISOString(),
): string {
  const aggregate = aggregateDuels(events);
  const records = events.map(asRecord);
  const challenges = new Map<string, Record<string, unknown>>();
  const accepted = new Map<string, Record<string, unknown>>();
  const declined = new Map<string, Record<string, unknown>>();
  const cancelled = new Map<string, Record<string, unknown>>();
  const seals = new Map<string, Set<string>>();
  const reveals = new Map<string, Record<string, unknown>>();
  const resolutions = new Map<string, Record<string, unknown>>();
  const resolutionByDuel = new Map<string, string[]>();
  const reversedResolutionIds = new Set<string>();
  const reversals: Record<string, unknown>[] = [];

  for (const event of records) {
    const duelId = stringField(event, "duelId");
    if (!duelId) continue;
    switch (event.type) {
      case "duelChallenged":
        challenges.set(duelId, event);
        break;
      case "duelAccepted":
      case "duelAdmitted":
        accepted.set(duelId, event);
        break;
      case "duelDeclined":
        declined.set(duelId, event);
        break;
      case "duelCancelled":
        cancelled.set(duelId, event);
        break;
      case "duelCommitmentSealed": {
        const participantId = stringField(event, "participantId");
        const participants = seals.get(duelId) ?? new Set<string>();
        if (participantId) participants.add(participantId);
        seals.set(duelId, participants);
        break;
      }
      case "duelCommitmentsRevealed":
        reveals.set(duelId, event);
        break;
      case "duelResolved": {
        const resolutionId = stringField(event, "resolutionId");
        if (!resolutionId) break;
        resolutions.set(resolutionId, event);
        const ids = resolutionByDuel.get(duelId) ?? [];
        ids.push(resolutionId);
        resolutionByDuel.set(duelId, ids);
        break;
      }
      case "duelResolutionReversed": {
        const target = stringField(event, "targetResolutionId");
        if (target) reversedResolutionIds.add(target);
        reversals.push(event);
        break;
      }
    }
  }

  const lines = [
    "# Hydra Formal Duels",
    "",
    "> Competitive rating only. Duel results never grant filesystem, terminal, network, approval, safety, builder, speaking-order, or orchestration authority.",
    "> Rated head-run receipts are Hydra-bound: they prove Hydra dispatched the configured head and bound its response, not provider-signed model identity.",
    "> Heads initiate new v3 duels from their own room replies. Hydra admits or rejects them by policy, then runs both actual heads under the same maximum native capability contract; no human initiation, manual answer, or exhibition fallback is created.",
    "> Historical exhibition/operator rows remain visible as legacy unranked evidence and never affect Elo.",
    "> The private event ledger is authoritative. This `.hydra/duels.md` file is a disposable, read-only mirror.",
    "",
    `Generated: ${safeCell(generatedAt)}`,
    `Ledger events: ${events.length}`,
    "",
    "## Domain ratings",
    "",
  ];

  const ratings = aggregateRows(aggregate, ["ratings", "domainRatings", "standings"]);
  if (ratings.length === 0) {
    lines.push("No rated decisive duels yet.");
  } else {
    lines.push(
      "| Domain | Rank | Head | Rating | Gap to #1 | Rated record | Status |",
      "| --- | --- | --- | ---: | --- | --- | --- |",
    );
    const ratingsByDomain = new Map<string, Record<string, unknown>[]>();
    for (const rating of ratings) {
      const domain = stringField(rating, "domain") ?? "unknown";
      const domainRatings = ratingsByDomain.get(domain) ?? [];
      domainRatings.push(rating);
      ratingsByDomain.set(domain, domainRatings);
    }
    for (const [domain, domainRatings] of [...ratingsByDomain.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const sorted = [...domainRatings].sort((left, right) => {
        const ratingDelta = (numberField(right, "rating") ?? Number.NEGATIVE_INFINITY)
          - (numberField(left, "rating") ?? Number.NEGATIVE_INFINITY);
        if (ratingDelta !== 0) return ratingDelta;
        return displayName(stringField(left, "agentId") ?? "unknown")
          .localeCompare(displayName(stringField(right, "agentId") ?? "unknown"));
      });
      const leaderRating = numberField(sorted[0] ?? {}, "rating");
      const leaderCount = sorted.filter((rating) => numberField(rating, "rating") === leaderRating).length;
      let previousRating: number | undefined;
      let visibleRank = 0;
      for (const [index, rating] of sorted.entries()) {
        const agentId = stringField(rating, "agentId") ?? "unknown";
        const currentRating = numberField(rating, "rating");
        if (index === 0 || currentRating !== previousRating) visibleRank = index + 1;
        previousRating = currentRating;
        const provisional = rating.provisional === true;
        const rankLabel = visibleRank === 1
          ? provisional
            ? leaderCount > 1 ? "Joint provisional #1" : "Provisional #1"
            : leaderCount > 1 ? "Joint #1" : "Supreme Head · #1"
          : `#${visibleRank}`;
        const gapLabel = leaderRating === undefined || currentRating === undefined
          ? "—"
          : visibleRank === 1
            ? leaderCount > 1 ? "0 Elo · joint" : "0 Elo · defend"
            : `${Math.max(0, Math.round(leaderRating - currentRating))} Elo to #1`;
        const wins = numberField(rating, "wins") ?? numberField(nestedRecord(rating, "record"), "wins") ?? 0;
        const losses = numberField(rating, "losses") ?? numberField(nestedRecord(rating, "record"), "losses") ?? 0;
        const draws = numberField(rating, "draws")
          ?? numberField(rating, "ties")
          ?? numberField(nestedRecord(rating, "record"), "draws")
          ?? numberField(nestedRecord(rating, "record"), "ties")
          ?? 0;
        lines.push(`| ${safeCell(domain)} | ${rankLabel} | ${safeCell(displayName(agentId))} | ${formatRating(currentRating)} | ${gapLabel} | ${wins}W / ${draws}D / ${losses}L | ${provisional ? "provisional" : "established"} |`);
      }
    }
  }

  lines.push("", "## Active duels", "");
  const active = [...challenges.entries()].filter(([duelId]) => {
    if (declined.has(duelId) || cancelled.has(duelId)) return false;
    return !activeResolutionId(duelId, resolutionByDuel, reversedResolutionIds);
  });
  if (active.length === 0) {
    lines.push("No active formal duels.");
  } else {
    lines.push("| Duel | Domain | Match | Origin | Status | Commitments | Rating | Proposition |", "| --- | --- | --- | --- | --- | ---: | --- | --- |");
    for (const [duelId, challenge] of active) {
      const challenger = stringField(challenge, "challengerId") ?? "unknown";
      const challenged = stringField(challenge, "challengedId") ?? "unknown";
      const acceptance = accepted.get(duelId);
      const origin = stringField(challenge, "createdBy") === "hydra-runtime" ? "agent-initiated" : "legacy operator";
      const sealedCount = seals.get(duelId)?.size ?? 0;
      const status = reveals.has(duelId)
        ? "revealed — awaiting adjudication"
        : acceptance
          ? sealedCount === 2
            ? "both sealed — awaiting paired reveal"
            : sealedCount === 1
              ? "accepted — awaiting second seal"
              : "accepted — awaiting commitments"
          : "challenge pending";
      const ratingClass = acceptance ? stringField(acceptance, "ratingClass") ?? "rated" : "pending";
      lines.push(`| ${safeCell(duelId)} | ${safeCell(stringField(challenge, "domain") ?? "unknown")} | ${safeCell(`${displayName(challenger)} vs ${displayName(challenged)}`)} | ${origin} | ${safeCell(status)} | ${sealedCount}/2 sealed | ${safeCell(ratingClass)} | ${safeCell(stringField(challenge, "proposition") ?? "")} |`);
    }
  }

  lines.push("", "## Revealed commitments", "");
  if (reveals.size === 0) {
    lines.push("No paired commitments have been revealed.");
  } else {
    lines.push("| Duel | Head | Capture | Hydra receipt | Answer | Confidence |", "| --- | --- | --- | --- | --- | ---: |");
    for (const [duelId, reveal] of reveals) {
      for (const commitment of recordArray(reveal.payloads)) {
        const participantId = stringField(commitment, "participantId") ?? "unknown";
        const captureType = stringField(commitment, "captureType");
        const captureLabel = captureType === "agent-call"
          ? "Hydra-bound head run"
          : captureType === "operator"
            ? "legacy operator entry (unranked history only)"
            : captureType ?? "unknown";
        const captureRef = stringField(commitment, "captureRef");
        const receipt = nestedRecord(commitment, "agentReceipt");
        const packetBinding = stringField(receipt, "sharedEvidenceSha256");
        const capabilityPolicy = stringField(receipt, "capabilityPolicy");
        const receiptLabel = captureType === "agent-call"
          ? `${captureRef ?? "unavailable"} (Hydra-bound; not provider-signed${capabilityPolicy ? `; capability:${capabilityPolicy}` : ""}${packetBinding ? `; shared evidence sha256:${packetBinding}` : ""})`
          : "not applicable";
        lines.push(`| ${safeCell(duelId)} | ${safeCell(displayName(participantId))} | ${safeCell(captureLabel)} | ${safeCell(receiptLabel)} | ${safeCell(stringField(commitment, "answer") ?? "")} | ${formatConfidence(numberField(commitment, "confidence"))} |`);
      }
    }
  }

  lines.push("", "## Recent results", "");
  const recentResults = [...resolutions.entries()]
    .sort((a, b) => (stringField(b[1], "occurredAt") ?? "").localeCompare(stringField(a[1], "occurredAt") ?? ""))
    .slice(0, 20);
  if (recentResults.length === 0) {
    lines.push("No adjudicated duel results.");
  } else {
    lines.push("| Duel | Outcome | Evidence | Rationale | Status |", "| --- | --- | --- | --- | --- |");
    for (const [resolutionId, result] of recentResults) {
      lines.push(`| ${safeCell(stringField(result, "duelId") ?? "unknown")} | ${safeCell(stringField(result, "outcome") ?? "unknown")} | ${safeCell(stringField(result, "evidenceRef") ?? "")} | ${safeCell(stringField(result, "rationale") ?? "")} | ${reversedResolutionIds.has(resolutionId) ? "reversed" : "active"} |`);
    }
  }

  lines.push("", "## Legacy unranked history", "");
  const exhibitions = [...accepted.entries()].filter(([, event]) => stringField(event, "ratingClass") === "exhibition");
  if (exhibitions.length === 0) {
    lines.push("No legacy exhibition records. New anti-farming conflicts are rejected before acceptance.");
  } else {
    lines.push("| Duel | Reasons |", "| --- | --- |");
    for (const [duelId, event] of exhibitions) {
      lines.push(`| ${safeCell(duelId)} | ${safeCell(stringArray(event.eligibilityReasons).join(", ") || "anti-farming policy")} |`);
    }
  }

  lines.push("", "## Corrections and cancellations", "");
  if (reversals.length === 0 && cancelled.size === 0 && declined.size === 0) {
    lines.push("No corrected, cancelled, or declined duels.");
  } else {
    lines.push("| Duel | Kind | Actor | Reason | At |", "| --- | --- | --- | --- | --- |");
    for (const event of reversals) {
      lines.push(`| ${safeCell(stringField(event, "duelId") ?? "unknown")} | result reversed | ${safeCell(stringField(event, "reversedBy") ?? "unknown")} | ${safeCell(stringField(event, "reason") ?? "")} | ${safeCell(stringField(event, "occurredAt") ?? "")} |`);
    }
    for (const [duelId, event] of cancelled) {
      lines.push(`| ${safeCell(duelId)} | cancelled | ${safeCell(stringField(event, "cancelledBy") ?? "unknown")} | ${safeCell(stringField(event, "reason") ?? "")} | ${safeCell(stringField(event, "occurredAt") ?? "")} |`);
    }
    for (const [duelId, event] of declined) {
      lines.push(`| ${safeCell(duelId)} | declined | ${safeCell(stringField(event, "declinedBy") ?? "unknown")} | ${safeCell(stringField(event, "reason") ?? "")} | ${safeCell(stringField(event, "occurredAt") ?? "")} |`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

export function privateDuelLedgerPath(storageRoot: string): string {
  return path.join(storageRoot, "competition", "duel-events.jsonl");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nestedRecord(record: Record<string, unknown>, field: string): Record<string, unknown> {
  return asRecord(record[field]);
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  return typeof record[field] === "string" ? record[field] : undefined;
}

function numberField(record: Record<string, unknown>, field: string): number | undefined {
  return typeof record[field] === "number" && Number.isFinite(record[field]) ? record[field] : undefined;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function aggregateRows(aggregate: DuelAggregate, fields: readonly string[]): Record<string, unknown>[] {
  const record = asRecord(aggregate);
  for (const field of fields) {
    const rows = recordArray(record[field]);
    if (rows.length > 0) return rows;
  }
  return [];
}

function activeResolutionId(
  duelId: string,
  resolutionByDuel: ReadonlyMap<string, readonly string[]>,
  reversedResolutionIds: ReadonlySet<string>,
): string | undefined {
  return [...(resolutionByDuel.get(duelId) ?? [])].reverse().find((id) => !reversedResolutionIds.has(id));
}

function formatRating(value: number | undefined): string {
  return value === undefined ? "—" : String(Math.round(value));
}

function formatConfidence(value: number | undefined): string {
  return value === undefined ? "—" : `${(value * 100).toFixed(0)}%`;
}

function safeCell(value: string): string {
  return value.replace(/[\r\n|]/g, " ").replace(/\s+/g, " ").trim();
}
