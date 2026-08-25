import { createHash } from "node:crypto";
import {
  canonicalArenaManifestJson,
  type ArenaBrowserJourneyStatus,
  type ArenaComparisonClassification,
  type ArenaContestantFailureCode,
  type ArenaContestantFinishedPayload,
  type ArenaContestantTerminalStatus,
  type ArenaEvidencePreservedPayload,
  type ArenaManifestEvent,
  type ArenaManifestReplay,
  type ArenaRunOutcome,
  type ArenaRunFinalizedPayload,
  type ArenaVerificationStatus,
} from "./arenaRunManifest";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVEAL_HASH_DOMAIN = "hydra.arena.product.v1.reveal\u0000";
const SELECTION_HASH_DOMAIN = "hydra.arena.product.v1.selection\u0000";
const SYNTHESIS_HASH_DOMAIN = "hydra.arena.product.v1.synthesis\u0000";

export type ArenaAggregateVerificationStatus =
  | ArenaVerificationStatus
  | "mixed"
  | "notRun";

export type ArenaAggregateBrowserStatus =
  | ArenaBrowserJourneyStatus
  | "mixed"
  | "notRun";

export interface ArenaRevealContestant {
  readonly contestantId: string;
  readonly headId: string;
  readonly agentKind: string;
  readonly terminalStatus: ArenaContestantTerminalStatus | "notFinished";
  readonly failureCode: ArenaContestantFailureCode | null;
  readonly latestVerificationStatus: ArenaAggregateVerificationStatus;
  readonly latestBrowserStatus: ArenaAggregateBrowserStatus;
  readonly verificationAttempts: number;
  readonly browserAttempts: number;
  readonly outputSha256: string | null;
  readonly outputBytes: number;
  readonly artifactSetSha256: string | null;
  readonly patchSha256: string | null;
  readonly patchBytes: number;
  readonly untrackedArchiveSha256: string | null;
  readonly untrackedArchiveBytes: number;
  readonly finalWorkspaceFingerprintSha256: string | null;
}

export interface ArenaReveal {
  readonly schemaVersion: 1;
  readonly revealType: "arenaReveal";
  readonly runId: string;
  readonly missionId: string;
  readonly missionRevision: number;
  readonly missionBindingSha256: string;
  readonly lockEventSha256: string;
  readonly finalizationEventSha256: string;
  readonly evidenceMatrixSha256: string | null;
  readonly outcome: ArenaRunOutcome;
  readonly comparison: ArenaComparisonClassification;
  readonly promotionEligible: boolean;
  readonly compromiseReasons: readonly string[];
  readonly contestants: readonly ArenaRevealContestant[];
  readonly revealSha256: string;
}

export interface ArenaWinnerSelection {
  readonly schemaVersion: 1;
  readonly receiptType: "arenaWinnerSelection";
  readonly selectionId: string;
  readonly occurredAt: string;
  readonly actorId: "local-user";
  readonly action: "Select Arena Winner";
  readonly runId: string;
  readonly revealSha256: string;
  readonly contestantId: string;
  readonly artifactSetSha256: string;
  readonly authorityGranted: false;
  readonly selectionSha256: string;
}

export interface ArenaSynthesisSource {
  readonly contestantId: string;
  readonly artifactSetSha256: string;
  readonly patchSha256: string;
}

export interface ArenaSynthesisRequest {
  readonly schemaVersion: 1;
  readonly receiptType: "arenaSynthesisRequest";
  readonly requestId: string;
  readonly occurredAt: string;
  readonly actorId: "local-user";
  readonly action: "Request Arena Synthesis";
  readonly runId: string;
  readonly revealSha256: string;
  readonly missionBindingSha256: string;
  readonly sources: readonly ArenaSynthesisSource[];
  readonly isolatedRunRequired: true;
  readonly mutatesSourceWorkspace: false;
  readonly synthesisRequestSha256: string;
}

export type ArenaProductReceipt =
  | ArenaWinnerSelection
  | ArenaSynthesisRequest;

export function createArenaReveal(replay: ArenaManifestReplay): ArenaReveal {
  const lockEvent = replay.records[0];
  const finalization = replay.finalization;
  if (!lockEvent
    || lockEvent.type !== "arenaRunLocked"
    || !finalization
    || finalization.type !== "arenaRunFinalized") {
    throw new Error("Arena reveal requires one strictly replayed finalized run.");
  }
  const finalized = finalization.payload as ArenaRunFinalizedPayload;
  const contestants = replay.contestants.map((contestant) => {
    const finished = contestant.finished?.payload as
      | ArenaContestantFinishedPayload
      | undefined;
    const evidence = contestant.evidencePreserved?.payload as
      | ArenaEvidencePreservedPayload
      | undefined;
    return Object.freeze({
      contestantId: contestant.lock.contestantId,
      headId: contestant.lock.headId,
      agentKind: contestant.lock.agentKind,
      terminalStatus: finished?.status ?? "notFinished",
      failureCode: finished?.failureCode ?? null,
      latestVerificationStatus: aggregateAttemptStatus(
        contestant.verifications.map((check) =>
          attemptStatus<ArenaVerificationStatus>(check.attempts)),
      ),
      latestBrowserStatus: aggregateAttemptStatus(
        contestant.browserJourneys.map((journey) =>
          attemptStatus<ArenaBrowserJourneyStatus>(journey.attempts)),
      ),
      verificationAttempts: contestant.verifications.reduce(
        (total, check) => total + check.attempts.length,
        0,
      ),
      browserAttempts: contestant.browserJourneys.reduce(
        (total, journey) => total + journey.attempts.length,
        0,
      ),
      outputSha256: finished?.outputSha256 ?? null,
      outputBytes: finished?.outputBytes ?? 0,
      artifactSetSha256: evidence?.artifactSetSha256 ?? null,
      patchSha256: evidence?.patchSha256 ?? null,
      patchBytes: evidence?.patchBytes ?? 0,
      untrackedArchiveSha256: evidence?.untrackedArchiveSha256 ?? null,
      untrackedArchiveBytes: evidence?.untrackedArchiveBytes ?? 0,
      finalWorkspaceFingerprintSha256:
        evidence?.finalWorkspaceFingerprintSha256
        ?? finished?.finalWorkspaceFingerprintSha256
        ?? null,
    } satisfies ArenaRevealContestant);
  });
  const withoutHash = {
    schemaVersion: 1 as const,
    revealType: "arenaReveal" as const,
    runId: replay.runId,
    missionId: replay.lock.mission.missionId,
    missionRevision: replay.lock.mission.revision,
    missionBindingSha256: replay.lock.mission.bindingSha256,
    lockEventSha256: lockEvent.eventSha256,
    finalizationEventSha256: finalization.eventSha256,
    evidenceMatrixSha256: finalized.evidenceMatrixSha256,
    outcome: finalized.outcome,
    comparison: finalized.comparison,
    promotionEligible: replay.promotionEligible,
    compromiseReasons: Object.freeze([...replay.compromiseReasons]),
    contestants: Object.freeze(contestants),
  };
  return Object.freeze({
    ...withoutHash,
    revealSha256: hashCanonical(REVEAL_HASH_DOMAIN, withoutHash),
  });
}

export function createArenaWinnerSelection(input: {
  readonly reveal: ArenaReveal;
  readonly contestantId: string;
  readonly selectionId: string;
  readonly occurredAt: string;
}): ArenaWinnerSelection {
  assertReveal(input.reveal);
  assertIdentifier(input.selectionId, "winner selection ID");
  assertIso(input.occurredAt, "winner selection time");
  const contestant = input.reveal.contestants.find((candidate) =>
    candidate.contestantId === input.contestantId);
  if (!contestant) {
    throw new Error("The selected contestant is not part of the revealed run.");
  }
  if (!contestant.artifactSetSha256) {
    throw new Error("A contestant without immutable evidence cannot be selected.");
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    receiptType: "arenaWinnerSelection" as const,
    selectionId: input.selectionId,
    occurredAt: input.occurredAt,
    actorId: "local-user" as const,
    action: "Select Arena Winner" as const,
    runId: input.reveal.runId,
    revealSha256: input.reveal.revealSha256,
    contestantId: contestant.contestantId,
    artifactSetSha256: contestant.artifactSetSha256,
    authorityGranted: false as const,
  };
  return Object.freeze({
    ...withoutHash,
    selectionSha256: hashCanonical(SELECTION_HASH_DOMAIN, withoutHash),
  });
}

export function createArenaSynthesisRequest(input: {
  readonly reveal: ArenaReveal;
  readonly contestantIds: readonly string[];
  readonly requestId: string;
  readonly occurredAt: string;
}): ArenaSynthesisRequest {
  assertReveal(input.reveal);
  assertIdentifier(input.requestId, "synthesis request ID");
  assertIso(input.occurredAt, "synthesis request time");
  const requested = new Set(input.contestantIds);
  if (requested.size < 2 || requested.size !== input.contestantIds.length) {
    throw new Error("Arena synthesis requires at least two distinct contestants.");
  }
  const sources = input.reveal.contestants.flatMap((contestant) => {
    if (!requested.has(contestant.contestantId)) return [];
    if (!contestant.artifactSetSha256 || !contestant.patchSha256) {
      throw new Error("Arena synthesis sources require immutable contestant evidence.");
    }
    return [Object.freeze({
      contestantId: contestant.contestantId,
      artifactSetSha256: contestant.artifactSetSha256,
      patchSha256: contestant.patchSha256,
    })];
  });
  if (sources.length !== requested.size) {
    throw new Error("An Arena synthesis source is not part of the revealed run.");
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    receiptType: "arenaSynthesisRequest" as const,
    requestId: input.requestId,
    occurredAt: input.occurredAt,
    actorId: "local-user" as const,
    action: "Request Arena Synthesis" as const,
    runId: input.reveal.runId,
    revealSha256: input.reveal.revealSha256,
    missionBindingSha256: input.reveal.missionBindingSha256,
    sources: Object.freeze(sources),
    isolatedRunRequired: true as const,
    mutatesSourceWorkspace: false as const,
  };
  return Object.freeze({
    ...withoutHash,
    synthesisRequestSha256: hashCanonical(SYNTHESIS_HASH_DOMAIN, withoutHash),
  });
}

export function renderArenaRevealMarkdown(reveal: ArenaReveal): string {
  assertReveal(reveal);
  const lines = [
    "# Hydra Arena Reveal",
    "",
    `Run: \`${reveal.runId}\``,
    `Mission: \`${reveal.missionId}\` revision ${reveal.missionRevision}`,
    `Outcome: **${reveal.outcome}** · comparison: **${reveal.comparison}**`,
    `Evidence matrix: \`${reveal.evidenceMatrixSha256 ?? "unavailable"}\``,
    `Promotion: **${reveal.promotionEligible ? "eligible after separate confirmation" : "unavailable"}**`,
    "",
    "| Head | Result | Verification | Browser | Evidence |",
    "| --- | --- | --- | --- | --- |",
    ...reveal.contestants.map((contestant) =>
      `| ${markdownCell(displayHead(contestant.headId))} | ${contestant.terminalStatus} | ${contestant.latestVerificationStatus} | ${contestant.latestBrowserStatus} | ${contestant.artifactSetSha256 ? `\`${contestant.artifactSetSha256.slice(0, 12)}…\`` : "missing"} |`),
    "",
    "Winner selection is a local workflow preference. It grants no authority. Promotion is a separate, exact confirmation and never commits, pushes, publishes, or deploys.",
  ];
  if (reveal.compromiseReasons.length > 0) {
    lines.push("", `Compromise latch: ${reveal.compromiseReasons.map(markdownCell).join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

export function parseArenaProductReceipt(value: unknown): ArenaProductReceipt {
  const row = exactRecord(value, "Arena product receipt");
  if (row.receiptType === "arenaWinnerSelection") {
    assertExactKeys(row, [
      "action",
      "actorId",
      "artifactSetSha256",
      "authorityGranted",
      "contestantId",
      "occurredAt",
      "receiptType",
      "revealSha256",
      "runId",
      "schemaVersion",
      "selectionId",
      "selectionSha256",
    ], "Arena winner selection");
    if (row.schemaVersion !== 1
      || row.actorId !== "local-user"
      || row.action !== "Select Arena Winner"
      || row.authorityGranted !== false) {
      throw new Error("Arena winner selection authority fields are invalid.");
    }
    const parsed: ArenaWinnerSelection = Object.freeze({
      schemaVersion: 1,
      receiptType: "arenaWinnerSelection",
      selectionId: requiredIdentifier(row.selectionId, "winner selection ID"),
      occurredAt: requiredIso(row.occurredAt, "winner selection time"),
      actorId: "local-user",
      action: "Select Arena Winner",
      runId: requiredIdentifier(row.runId, "winner run ID"),
      revealSha256: requiredSha256(row.revealSha256, "winner reveal"),
      contestantId: requiredIdentifier(row.contestantId, "winner contestant ID"),
      artifactSetSha256: requiredSha256(row.artifactSetSha256, "winner artifacts"),
      authorityGranted: false,
      selectionSha256: requiredSha256(row.selectionSha256, "winner selection"),
    });
    const { selectionSha256: _ignored, ...withoutHash } = parsed;
    if (hashCanonical(SELECTION_HASH_DOMAIN, withoutHash)
        !== parsed.selectionSha256) {
      throw new Error("Arena winner selection hash is invalid.");
    }
    return parsed;
  }
  if (row.receiptType === "arenaSynthesisRequest") {
    assertExactKeys(row, [
      "action",
      "actorId",
      "isolatedRunRequired",
      "missionBindingSha256",
      "mutatesSourceWorkspace",
      "occurredAt",
      "receiptType",
      "requestId",
      "revealSha256",
      "runId",
      "schemaVersion",
      "sources",
      "synthesisRequestSha256",
    ], "Arena synthesis request");
    if (row.schemaVersion !== 1
      || row.actorId !== "local-user"
      || row.action !== "Request Arena Synthesis"
      || row.isolatedRunRequired !== true
      || row.mutatesSourceWorkspace !== false
      || !Array.isArray(row.sources)
      || row.sources.length < 2
      || row.sources.length > 8) {
      throw new Error("Arena synthesis request authority fields are invalid.");
    }
    const sourceIds = new Set<string>();
    const sources = row.sources.map((value, index) => {
      const source = exactRecord(value, `Arena synthesis source ${index + 1}`);
      assertExactKeys(source, [
        "artifactSetSha256",
        "contestantId",
        "patchSha256",
      ], `Arena synthesis source ${index + 1}`);
      const contestantId = requiredIdentifier(
        source.contestantId,
        `synthesis source ${index + 1} contestant ID`,
      );
      if (sourceIds.has(contestantId)) {
        throw new Error("Arena synthesis request contains duplicate sources.");
      }
      sourceIds.add(contestantId);
      return Object.freeze({
        contestantId,
        artifactSetSha256: requiredSha256(
          source.artifactSetSha256,
          `synthesis source ${index + 1} artifacts`,
        ),
        patchSha256: requiredSha256(
          source.patchSha256,
          `synthesis source ${index + 1} patch`,
        ),
      });
    });
    const parsed: ArenaSynthesisRequest = Object.freeze({
      schemaVersion: 1,
      receiptType: "arenaSynthesisRequest",
      requestId: requiredIdentifier(row.requestId, "synthesis request ID"),
      occurredAt: requiredIso(row.occurredAt, "synthesis request time"),
      actorId: "local-user",
      action: "Request Arena Synthesis",
      runId: requiredIdentifier(row.runId, "synthesis run ID"),
      revealSha256: requiredSha256(row.revealSha256, "synthesis reveal"),
      missionBindingSha256: requiredSha256(
        row.missionBindingSha256,
        "synthesis Mission binding",
      ),
      sources: Object.freeze(sources),
      isolatedRunRequired: true,
      mutatesSourceWorkspace: false,
      synthesisRequestSha256: requiredSha256(
        row.synthesisRequestSha256,
        "synthesis request",
      ),
    });
    const { synthesisRequestSha256: _ignored, ...withoutHash } = parsed;
    if (hashCanonical(SYNTHESIS_HASH_DOMAIN, withoutHash)
        !== parsed.synthesisRequestSha256) {
      throw new Error("Arena synthesis request hash is invalid.");
    }
    return parsed;
  }
  throw new Error("Arena product receipt type is unknown.");
}

function attemptStatus<T extends string>(attempts: readonly ArenaManifestEvent[]): T | "notRun" {
  const payload = attempts.at(-1)?.payload as { readonly status?: T } | undefined;
  return payload?.status ?? "notRun";
}

function aggregateAttemptStatus<T extends string>(
  statuses: readonly (T | "notRun")[],
): T | "mixed" | "notRun" {
  if (statuses.length === 0) return "notRun";
  const distinct = new Set(statuses);
  return distinct.size === 1 ? statuses[0]! : "mixed";
}

function assertReveal(reveal: ArenaReveal): void {
  assertIdentifier(reveal.runId, "reveal run ID");
  assertSha256(reveal.revealSha256, "reveal");
  const { revealSha256: _ignored, ...withoutHash } = reveal;
  if (hashCanonical(REVEAL_HASH_DOMAIN, withoutHash) !== reveal.revealSha256) {
    throw new Error("Arena reveal hash does not match its immutable evidence binding.");
  }
}

function hashCanonical(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(canonicalArenaManifestJson(value), "utf8")
    .digest("hex");
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) throw new Error(`Arena ${label} is invalid.`);
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error(`Arena ${label} SHA-256 is invalid.`);
}

function assertIso(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`Arena ${label} is invalid.`);
  }
}

function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Arena ${label} is invalid.`);
  assertIdentifier(value, label);
  return value;
}

function requiredSha256(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Arena ${label} SHA-256 is invalid.`);
  assertSha256(value, label);
  return value;
}

function requiredIso(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Arena ${label} is invalid.`);
  assertIso(value, label);
  return value;
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} has unknown or missing fields.`);
  }
}

function displayHead(value: string): string {
  return value.length === 0 ? "Unknown" : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function markdownCell(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\\/gu, "\\\\")
    .replace(/\|/gu, "\\|")
    .trim();
}
