import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isValidAgentId } from "./agentValidation";

export const MISSION_CONTRACT_SCHEMA_VERSION = 1 as const;
export const MISSION_CONTRACT_HASH_DOMAIN = "hydra-mission-contract-v1";
export const MISSION_CONTRACT_BINDING_HASH_DOMAIN = "hydra-mission-contract-binding-v1";
export const UNBOUND_MISSION_BINDING_SHA256 = createHash("sha256")
  .update("hydra:mission-contract:unbound:v1", "utf8")
  .digest("hex");
/** @deprecated Use UNBOUND_MISSION_BINDING_SHA256 for new integration. */
export const UNBOUND_MISSION_CONTRACT_SHA256 = UNBOUND_MISSION_BINDING_SHA256;

export const MISSION_CONTRACT_LIMITS = Object.freeze({
  contractBytes: 64 * 1024,
  titleChars: 160,
  outcomeChars: 4_000,
  identifierChars: 128,
  pathChars: 1_024,
  shortTextChars: 500,
  longTextChars: 4_000,
  commandChars: 8_192,
  acceptanceChecks: 64,
  protectedPaths: 128,
  allowedMutationRules: 128,
  evidenceRequirements: 64,
  nonGoals: 64,
  acceptanceRefsPerEvidence: 64,
  outstandingProposals: 64,
  maxCostUsd: 1_000_000_000,
  maxAgentCalls: 1_000_000,
  maxWallClockMs: 365 * 24 * 60 * 60 * 1_000,
  maxRetries: 10_000,
});

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const MUTATION_OPERATION_ORDER = ["create", "modify", "delete", "rename"] as const;
const MUTATION_OPERATIONS = new Set<string>(MUTATION_OPERATION_ORDER);

export type MissionMutationOperation = typeof MUTATION_OPERATION_ORDER[number];

export interface MissionVerificationCommandCheck {
  id: string;
  kind: "verificationCommand";
  label: string;
  command: string;
  expectedExitCode: number;
}

export interface MissionArtifactCheck {
  id: string;
  kind: "artifact";
  label: string;
  path: string;
  requirement: string;
}

export interface MissionBrowserJourneyCheck {
  id: string;
  kind: "browserJourney";
  label: string;
  journey: string;
}

export interface MissionManualCheck {
  id: string;
  kind: "manual";
  label: string;
  instructions: string;
}

export type MissionAcceptanceCheck =
  | MissionVerificationCommandCheck
  | MissionArtifactCheck
  | MissionBrowserJourneyCheck
  | MissionManualCheck;

export interface MissionPathScope {
  path: string;
  includeDescendants: boolean;
  reason: string;
}

export interface MissionMutationRule {
  id: string;
  path: string;
  includeDescendants: boolean;
  operations: MissionMutationOperation[];
  reason: string;
}

export interface MissionBudgets {
  maxCostUsd: number | null;
  maxAgentCalls: number | null;
  maxWallClockMs: number | null;
  maxRetries: number | null;
}

export type MissionEvidenceKind =
  | "verificationReceipt"
  | "diff"
  | "artifact"
  | "browserReceipt"
  | "humanDecision";

export interface MissionEvidenceRequirement {
  id: string;
  kind: MissionEvidenceKind;
  description: string;
  acceptanceCheckIds: string[];
}

export interface MissionContractDocument {
  schemaVersion: typeof MISSION_CONTRACT_SCHEMA_VERSION;
  title: string;
  outcome: string;
  acceptanceChecks: MissionAcceptanceCheck[];
  protectedPaths: MissionPathScope[];
  allowedMutations: MissionMutationRule[];
  budgets: MissionBudgets;
  evidenceRequirements: MissionEvidenceRequirement[];
  nonGoals: string[];
}

export interface MissionContractLocalProposalSource {
  kind: "localUser";
  actorId: "local-user";
}

export interface MissionContractAgentProposalSource {
  kind: "agent";
  agentId: string;
  callId: string;
  messageId: string;
  responseSha256: string;
}

export type MissionContractProposalSource =
  | MissionContractLocalProposalSource
  | MissionContractAgentProposalSource;

export interface MissionContractProposalAdmission {
  actorId: "local-user";
  action: "Record Local Mission Contract Proposal" | "Admit Agent Mission Contract Proposal";
}

export interface MissionContractProposedEvent {
  schemaVersion: typeof MISSION_CONTRACT_SCHEMA_VERSION;
  type: "missionContractProposed";
  eventId: string;
  occurredAt: string;
  missionId: string;
  proposalId: string;
  baseBindingSha256: string;
  proposedBy: MissionContractProposalSource;
  admittedBy: MissionContractProposalAdmission;
  documentSha256: string;
  contract: MissionContractDocument;
}

export interface MissionContractConfirmedEvent {
  schemaVersion: typeof MISSION_CONTRACT_SCHEMA_VERSION;
  type: "missionContractConfirmed";
  eventId: string;
  occurredAt: string;
  missionId: string;
  proposalId: string;
  confirmationId: string;
  documentSha256: string;
  previousBindingSha256: string;
  revision: number;
  confirmedBy: "local-user";
}

export interface MissionContractProposalDismissedEvent {
  schemaVersion: typeof MISSION_CONTRACT_SCHEMA_VERSION;
  type: "missionContractProposalDismissed";
  eventId: string;
  occurredAt: string;
  proposalId: string;
  dismissalId: string;
  dismissedBy: "local-user";
  reason: string;
}

export interface MissionContractRetiredEvent {
  schemaVersion: typeof MISSION_CONTRACT_SCHEMA_VERSION;
  type: "missionContractRetired";
  eventId: string;
  occurredAt: string;
  missionId: string;
  retirementId: string;
  documentSha256: string;
  bindingSha256: string;
  revision: number;
  retiredBy: "local-user";
  reason: string;
}

export type MissionContractEvent =
  | MissionContractProposedEvent
  | MissionContractConfirmedEvent
  | MissionContractProposalDismissedEvent
  | MissionContractRetiredEvent;

export interface UnboundMissionContractBinding {
  state: "unbound";
  documentSha256: null;
  bindingSha256: typeof UNBOUND_MISSION_BINDING_SHA256;
}

export interface ActiveMissionContractBinding {
  state: "active";
  missionId: string;
  revision: number;
  documentSha256: string;
  bindingSha256: string;
  proposalId: string;
  confirmationEventId: string;
  contract: MissionContractDocument;
}

export type MissionContractBinding =
  | UnboundMissionContractBinding
  | ActiveMissionContractBinding;

export type MissionContractProposalStatus =
  | "pending"
  | "confirmed"
  | "dismissed"
  | "stale";

export interface MissionContractProposalState {
  proposal: MissionContractProposedEvent;
  status: MissionContractProposalStatus;
  closedByEventId?: string;
}

export interface MissionContractSnapshot {
  eventCount: number;
  binding: MissionContractBinding;
  proposals: MissionContractProposalState[];
}

export type MissionMutationRequest =
  | {
      operation: Exclude<MissionMutationOperation, "rename">;
      path: string;
    }
  | {
      operation: "rename";
      fromPath: string;
      toPath: string;
    };

export interface MissionMutationDecision {
  allowed: boolean;
  reason: string;
  normalizedPaths: string[];
  matchedRuleIds: string[];
}

export class MissionContractValidationError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Invalid Hydra Mission Contract: ${issues.join("; ")}`);
    this.name = "MissionContractValidationError";
  }
}

function invalid(path: string, message: string): never {
  throw new MissionContractValidationError([`${path}: ${message}`]);
}

function asExactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(label, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(label, "must be a plain object");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    const missing = expected.filter((key) => !actual.includes(key));
    const unknown = actual.filter((key) => !expected.includes(key));
    const details = [
      missing.length > 0 ? `missing ${missing.join(", ")}` : "",
      unknown.length > 0 ? `unknown ${unknown.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    invalid(label, `must contain exactly [${expected.join(", ")}]${details ? ` (${details})` : ""}`);
  }
  return record;
}

function boundedText(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== "string") invalid(label, "must be a string");
  if (BIDI_CONTROL_RE.test(value)) invalid(label, "must not contain bidirectional control characters");
  const normalized = value.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (!normalized) invalid(label, "must not be empty");
  if (normalized.length > maxChars) invalid(label, `must not exceed ${maxChars} characters`);
  if (CONTROL_RE.test(normalized.replace(/\n/g, ""))) invalid(label, "must not contain control characters");
  return normalized;
}

function boundedOptionalReason(value: unknown, label: string): string {
  return boundedText(value, label, MISSION_CONTRACT_LIMITS.longTextChars);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string"
    || value.length > MISSION_CONTRACT_LIMITS.identifierChars
    || !IDENTIFIER_RE.test(value)) {
    invalid(label, `must match ${IDENTIFIER_RE} and not exceed ${MISSION_CONTRACT_LIMITS.identifierChars} characters`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    invalid(label, "must be a lowercase SHA-256 hex digest");
  }
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(label, "must be an ISO-8601 timestamp");
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    invalid(label, "must be a canonical UTC ISO-8601 timestamp");
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(label, "must be a boolean");
  return value;
}

function literal<T extends string | number>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) invalid(label, `must equal ${JSON.stringify(expected)}`);
  return expected;
}

function boundedArray(value: unknown, label: string, maxItems: number, minItems = 0): unknown[] {
  if (!Array.isArray(value)) invalid(label, "must be an array");
  if (value.length < minItems) invalid(label, `must contain at least ${minItems} item${minItems === 1 ? "" : "s"}`);
  if (value.length > maxItems) invalid(label, `must not contain more than ${maxItems} items`);
  return value;
}

function nullableBoundedNumber(
  value: unknown,
  label: string,
  maximum: number,
  integerOnly: boolean,
): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalid(label, "must be null or a finite non-negative number");
  }
  if (Object.is(value, -0)) invalid(label, "must not be negative zero");
  if (integerOnly && !Number.isSafeInteger(value)) invalid(label, "must be a safe integer");
  if (value > maximum) invalid(label, `must not exceed ${maximum}`);
  return value;
}

/**
 * Normalize one workspace-relative path. `.` is accepted only as a path-scope
 * root; mutation requests cannot target the workspace root itself.
 */
export function normalizeMissionRelativePath(
  value: unknown,
  label = "path",
  options: { allowWorkspaceRoot?: boolean } = {},
): string {
  if (typeof value !== "string") invalid(label, "must be a string");
  if (!value || value.length > MISSION_CONTRACT_LIMITS.pathChars) {
    invalid(label, `must be 1-${MISSION_CONTRACT_LIMITS.pathChars} characters`);
  }
  if (CONTROL_RE.test(value) || BIDI_CONTROL_RE.test(value)) {
    invalid(label, "must not contain control or bidirectional-control characters");
  }
  const normalized = value.normalize("NFC").replace(/\\/g, "/");
  if (normalized === ".") {
    if (options.allowWorkspaceRoot) return normalized;
    invalid(label, "must identify an entry below the workspace root");
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    invalid(label, "must be workspace-relative");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    invalid(label, "must not contain empty, current-directory, or parent-directory segments");
  }
  if (segments.some((segment) => {
    const lowered = segment.toLowerCase();
    return lowered === ".git" || lowered === ".hydra";
  })) {
    invalid(label, "must not address .git or .hydra");
  }
  if (segments.some((segment) => segment.includes(":"))) {
    invalid(label, "must not contain colon or Windows alternate-data-stream syntax");
  }
  if (segments.some((segment) => /[ .]$/.test(segment))) {
    invalid(label, "segments must not end with a dot or space");
  }
  if (segments.some(isWindowsDeviceSegment)) {
    invalid(label, "must not use a reserved Windows device name");
  }
  return segments.join("/");
}

function isWindowsDeviceSegment(segment: string): boolean {
  const stem = segment.split(".", 1)[0]!.toUpperCase();
  return stem === "CON"
    || stem === "PRN"
    || stem === "AUX"
    || stem === "NUL"
    || /^COM[1-9]$/.test(stem)
    || /^LPT[1-9]$/.test(stem);
}

export function isSafeMissionRelativePath(
  value: unknown,
  options: { allowWorkspaceRoot?: boolean } = {},
): value is string {
  try {
    normalizeMissionRelativePath(value, "path", options);
    return true;
  } catch {
    return false;
  }
}

function normalizeAcceptanceCheck(value: unknown, index: number): MissionAcceptanceCheck {
  const label = `contract.acceptanceChecks[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label, "must be an object");
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "verificationCommand") {
    const row = asExactRecord(value, ["id", "kind", "label", "command", "expectedExitCode"], label);
    const expectedExitCode = row.expectedExitCode;
    if (typeof expectedExitCode !== "number"
      || !Number.isSafeInteger(expectedExitCode)
      || Object.is(expectedExitCode, -0)
      || expectedExitCode < 0
      || expectedExitCode > 255) {
      invalid(`${label}.expectedExitCode`, "must be an integer from 0 through 255");
    }
    return {
      id: identifier(row.id, `${label}.id`),
      kind: literal(row.kind, "verificationCommand", `${label}.kind`),
      label: boundedText(row.label, `${label}.label`, MISSION_CONTRACT_LIMITS.shortTextChars),
      command: boundedText(row.command, `${label}.command`, MISSION_CONTRACT_LIMITS.commandChars),
      expectedExitCode,
    };
  }
  if (kind === "artifact") {
    const row = asExactRecord(value, ["id", "kind", "label", "path", "requirement"], label);
    return {
      id: identifier(row.id, `${label}.id`),
      kind: literal(row.kind, "artifact", `${label}.kind`),
      label: boundedText(row.label, `${label}.label`, MISSION_CONTRACT_LIMITS.shortTextChars),
      path: normalizeMissionRelativePath(row.path, `${label}.path`),
      requirement: boundedText(row.requirement, `${label}.requirement`, MISSION_CONTRACT_LIMITS.longTextChars),
    };
  }
  if (kind === "browserJourney") {
    const row = asExactRecord(value, ["id", "kind", "label", "journey"], label);
    return {
      id: identifier(row.id, `${label}.id`),
      kind: literal(row.kind, "browserJourney", `${label}.kind`),
      label: boundedText(row.label, `${label}.label`, MISSION_CONTRACT_LIMITS.shortTextChars),
      journey: boundedText(row.journey, `${label}.journey`, MISSION_CONTRACT_LIMITS.longTextChars),
    };
  }
  if (kind === "manual") {
    const row = asExactRecord(value, ["id", "kind", "label", "instructions"], label);
    return {
      id: identifier(row.id, `${label}.id`),
      kind: literal(row.kind, "manual", `${label}.kind`),
      label: boundedText(row.label, `${label}.label`, MISSION_CONTRACT_LIMITS.shortTextChars),
      instructions: boundedText(row.instructions, `${label}.instructions`, MISSION_CONTRACT_LIMITS.longTextChars),
    };
  }
  invalid(`${label}.kind`, "must be verificationCommand, artifact, browserJourney, or manual");
}

function normalizePathScope(value: unknown, index: number): MissionPathScope {
  const label = `contract.protectedPaths[${index}]`;
  const row = asExactRecord(value, ["path", "includeDescendants", "reason"], label);
  return {
    path: normalizeMissionRelativePath(row.path, `${label}.path`, { allowWorkspaceRoot: true }),
    includeDescendants: booleanValue(row.includeDescendants, `${label}.includeDescendants`),
    reason: boundedOptionalReason(row.reason, `${label}.reason`),
  };
}

function normalizeMutationRule(value: unknown, index: number): MissionMutationRule {
  const label = `contract.allowedMutations[${index}]`;
  const row = asExactRecord(value, ["id", "path", "includeDescendants", "operations", "reason"], label);
  const operations = boundedArray(row.operations, `${label}.operations`, MUTATION_OPERATION_ORDER.length, 1);
  const normalizedOperations: MissionMutationOperation[] = [];
  for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
    const operation = operations[operationIndex];
    if (typeof operation !== "string" || !MUTATION_OPERATIONS.has(operation)) {
      invalid(`${label}.operations[${operationIndex}]`, "must be create, modify, delete, or rename");
    }
    if (normalizedOperations.includes(operation as MissionMutationOperation)) {
      invalid(`${label}.operations`, `contains duplicate operation ${operation}`);
    }
    normalizedOperations.push(operation as MissionMutationOperation);
  }
  normalizedOperations.sort(
    (left, right) => MUTATION_OPERATION_ORDER.indexOf(left) - MUTATION_OPERATION_ORDER.indexOf(right),
  );
  return {
    id: identifier(row.id, `${label}.id`),
    path: normalizeMissionRelativePath(row.path, `${label}.path`, { allowWorkspaceRoot: true }),
    includeDescendants: booleanValue(row.includeDescendants, `${label}.includeDescendants`),
    operations: normalizedOperations,
    reason: boundedOptionalReason(row.reason, `${label}.reason`),
  };
}

function normalizeBudgets(value: unknown): MissionBudgets {
  const row = asExactRecord(
    value,
    ["maxCostUsd", "maxAgentCalls", "maxWallClockMs", "maxRetries"],
    "contract.budgets",
  );
  return {
    maxCostUsd: nullableBoundedNumber(
      row.maxCostUsd,
      "contract.budgets.maxCostUsd",
      MISSION_CONTRACT_LIMITS.maxCostUsd,
      false,
    ),
    maxAgentCalls: nullableBoundedNumber(
      row.maxAgentCalls,
      "contract.budgets.maxAgentCalls",
      MISSION_CONTRACT_LIMITS.maxAgentCalls,
      true,
    ),
    maxWallClockMs: nullableBoundedNumber(
      row.maxWallClockMs,
      "contract.budgets.maxWallClockMs",
      MISSION_CONTRACT_LIMITS.maxWallClockMs,
      true,
    ),
    maxRetries: nullableBoundedNumber(
      row.maxRetries,
      "contract.budgets.maxRetries",
      MISSION_CONTRACT_LIMITS.maxRetries,
      true,
    ),
  };
}

const EVIDENCE_KINDS = new Set<MissionEvidenceKind>([
  "verificationReceipt",
  "diff",
  "artifact",
  "browserReceipt",
  "humanDecision",
]);

function normalizeEvidenceRequirement(value: unknown, index: number): MissionEvidenceRequirement {
  const label = `contract.evidenceRequirements[${index}]`;
  const row = asExactRecord(value, ["id", "kind", "description", "acceptanceCheckIds"], label);
  if (typeof row.kind !== "string" || !EVIDENCE_KINDS.has(row.kind as MissionEvidenceKind)) {
    invalid(`${label}.kind`, "must be verificationReceipt, diff, artifact, browserReceipt, or humanDecision");
  }
  const refs = boundedArray(
    row.acceptanceCheckIds,
    `${label}.acceptanceCheckIds`,
    MISSION_CONTRACT_LIMITS.acceptanceRefsPerEvidence,
    1,
  ).map((ref, refIndex) => identifier(ref, `${label}.acceptanceCheckIds[${refIndex}]`));
  if (new Set(refs).size !== refs.length) invalid(`${label}.acceptanceCheckIds`, "must not contain duplicates");
  return {
    id: identifier(row.id, `${label}.id`),
    kind: row.kind as MissionEvidenceKind,
    description: boundedText(row.description, `${label}.description`, MISSION_CONTRACT_LIMITS.longTextChars),
    acceptanceCheckIds: refs,
  };
}

function assertUniqueIds(rows: readonly { id: string }[], label: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) invalid(label, `contains duplicate id ${row.id}`);
    seen.add(row.id);
  }
}

/**
 * Parses, exact-key validates, bounds, and canonicalizes an untrusted contract.
 * Returned objects have a stable property order suitable for hashing/storage.
 */
export function normalizeMissionContract(value: unknown): MissionContractDocument {
  const row = asExactRecord(
    value,
    [
      "schemaVersion",
      "title",
      "outcome",
      "acceptanceChecks",
      "protectedPaths",
      "allowedMutations",
      "budgets",
      "evidenceRequirements",
      "nonGoals",
    ],
    "contract",
  );
  literal(row.schemaVersion, MISSION_CONTRACT_SCHEMA_VERSION, "contract.schemaVersion");

  const acceptanceChecks = boundedArray(
    row.acceptanceChecks,
    "contract.acceptanceChecks",
    MISSION_CONTRACT_LIMITS.acceptanceChecks,
    1,
  ).map(normalizeAcceptanceCheck);
  const protectedPaths = boundedArray(
    row.protectedPaths,
    "contract.protectedPaths",
    MISSION_CONTRACT_LIMITS.protectedPaths,
  ).map(normalizePathScope);
  const allowedMutations = boundedArray(
    row.allowedMutations,
    "contract.allowedMutations",
    MISSION_CONTRACT_LIMITS.allowedMutationRules,
  ).map(normalizeMutationRule);
  const evidenceRequirements = boundedArray(
    row.evidenceRequirements,
    "contract.evidenceRequirements",
    MISSION_CONTRACT_LIMITS.evidenceRequirements,
    1,
  ).map(normalizeEvidenceRequirement);
  const nonGoals = boundedArray(
    row.nonGoals,
    "contract.nonGoals",
    MISSION_CONTRACT_LIMITS.nonGoals,
  ).map((item, index) => boundedText(
    item,
    `contract.nonGoals[${index}]`,
    MISSION_CONTRACT_LIMITS.longTextChars,
  ));

  assertUniqueIds(acceptanceChecks, "contract.acceptanceChecks");
  assertUniqueIds(allowedMutations, "contract.allowedMutations");
  assertUniqueIds(evidenceRequirements, "contract.evidenceRequirements");
  const acceptanceIds = new Set(acceptanceChecks.map((check) => check.id));
  for (const requirement of evidenceRequirements) {
    for (const ref of requirement.acceptanceCheckIds) {
      if (!acceptanceIds.has(ref)) {
        invalid(
          `contract.evidenceRequirements.${requirement.id}.acceptanceCheckIds`,
          `references unknown acceptance check ${ref}`,
        );
      }
    }
  }

  const normalized: MissionContractDocument = {
    schemaVersion: MISSION_CONTRACT_SCHEMA_VERSION,
    title: boundedText(row.title, "contract.title", MISSION_CONTRACT_LIMITS.titleChars),
    outcome: boundedText(row.outcome, "contract.outcome", MISSION_CONTRACT_LIMITS.outcomeChars),
    acceptanceChecks,
    protectedPaths: protectedPaths.sort(comparePathScopes),
    allowedMutations: allowedMutations.sort((left, right) =>
      compareCanonicalStrings(left.path, right.path)
      || Number(left.includeDescendants) - Number(right.includeDescendants)
      || compareCanonicalStrings(left.id, right.id)),
    budgets: normalizeBudgets(row.budgets),
    evidenceRequirements,
    nonGoals,
  };
  const encodedBytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
  if (encodedBytes > MISSION_CONTRACT_LIMITS.contractBytes) {
    invalid("contract", `canonical encoding must not exceed ${MISSION_CONTRACT_LIMITS.contractBytes} bytes`);
  }
  return deepFreeze(normalized);
}

function comparePathScopes(left: MissionPathScope, right: MissionPathScope): number {
  return compareCanonicalStrings(left.path, right.path)
    || Number(left.includeDescendants) - Number(right.includeDescendants)
    || compareCanonicalStrings(left.reason, right.reason);
}

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

export function canonicalMissionContractJson(value: MissionContractDocument | unknown): string {
  return JSON.stringify(normalizeMissionContract(value));
}

export function missionContractSha256(value: MissionContractDocument | unknown): string {
  const hash = createHash("sha256");
  hash.update(MISSION_CONTRACT_HASH_DOMAIN, "utf8");
  hash.update("\0", "utf8");
  hash.update(canonicalMissionContractJson(value), "utf8");
  return hash.digest("hex");
}

export function missionContractBindingSha256(input: {
  missionId: string;
  revision: number;
  confirmationEventId: string;
  documentSha256: string;
}): string {
  const canonical = {
    missionId: identifier(input.missionId, "binding.missionId"),
    revision: input.revision,
    confirmationEventId: identifier(input.confirmationEventId, "binding.confirmationEventId"),
    documentSha256: sha256(input.documentSha256, "binding.documentSha256"),
  };
  if (!Number.isSafeInteger(canonical.revision)
    || canonical.revision < 1
    || Object.is(canonical.revision, -0)) {
    invalid("binding.revision", "must be a positive safe integer");
  }
  return createHash("sha256")
    .update(MISSION_CONTRACT_BINDING_HASH_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

function normalizeProposalSource(value: unknown, label: string): MissionContractProposalSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label, "must be an object");
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "localUser") {
    const row = asExactRecord(value, ["kind", "actorId"], label);
    return {
      kind: literal(row.kind, "localUser", `${label}.kind`),
      actorId: literal(row.actorId, "local-user", `${label}.actorId`),
    };
  }
  if (kind === "agent") {
    const row = asExactRecord(
      value,
      ["kind", "agentId", "callId", "messageId", "responseSha256"],
      label,
    );
    if (!isValidAgentId(row.agentId)) invalid(`${label}.agentId`, "must be a valid Hydra agent id");
    return {
      kind: literal(row.kind, "agent", `${label}.kind`),
      agentId: row.agentId,
      callId: identifier(row.callId, `${label}.callId`),
      messageId: identifier(row.messageId, `${label}.messageId`),
      responseSha256: sha256(row.responseSha256, `${label}.responseSha256`),
    };
  }
  invalid(`${label}.kind`, "must be localUser or agent");
}

function normalizeProposalAdmission(
  value: unknown,
  source: MissionContractProposalSource,
  label: string,
): MissionContractProposalAdmission {
  const row = asExactRecord(value, ["actorId", "action"], label);
  const expectedAction = source.kind === "agent"
    ? "Admit Agent Mission Contract Proposal"
    : "Record Local Mission Contract Proposal";
  return {
    actorId: literal(row.actorId, "local-user", `${label}.actorId`),
    action: literal(row.action, expectedAction, `${label}.action`),
  };
}

export function parseMissionContractEvent(value: unknown, index = 0): MissionContractEvent {
  const label = `events[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label, "must be an object");
  const type = (value as Record<string, unknown>).type;
  if (type === "missionContractProposed") {
    const row = asExactRecord(
      value,
      [
        "schemaVersion",
        "type",
        "eventId",
        "occurredAt",
        "missionId",
        "proposalId",
        "baseBindingSha256",
        "proposedBy",
        "admittedBy",
        "documentSha256",
        "contract",
      ],
      label,
    );
    const contract = normalizeMissionContract(row.contract);
    if (!isDeepStrictEqual(row.contract, contract)) {
      invalid(`${label}.contract`, "must already use the canonical normalized representation");
    }
    const proposedBy = normalizeProposalSource(row.proposedBy, `${label}.proposedBy`);
    return {
      schemaVersion: literal(row.schemaVersion, MISSION_CONTRACT_SCHEMA_VERSION, `${label}.schemaVersion`),
      type: literal(row.type, "missionContractProposed", `${label}.type`),
      eventId: identifier(row.eventId, `${label}.eventId`),
      occurredAt: isoTimestamp(row.occurredAt, `${label}.occurredAt`),
      missionId: identifier(row.missionId, `${label}.missionId`),
      proposalId: identifier(row.proposalId, `${label}.proposalId`),
      baseBindingSha256: sha256(row.baseBindingSha256, `${label}.baseBindingSha256`),
      proposedBy,
      admittedBy: normalizeProposalAdmission(row.admittedBy, proposedBy, `${label}.admittedBy`),
      documentSha256: sha256(row.documentSha256, `${label}.documentSha256`),
      contract,
    };
  }
  if (type === "missionContractConfirmed") {
    const row = asExactRecord(
      value,
      [
        "schemaVersion",
        "type",
        "eventId",
        "occurredAt",
        "missionId",
        "proposalId",
        "confirmationId",
        "documentSha256",
        "previousBindingSha256",
        "revision",
        "confirmedBy",
      ],
      label,
    );
    if (typeof row.revision !== "number"
      || !Number.isSafeInteger(row.revision)
      || row.revision < 1
      || Object.is(row.revision, -0)) {
      invalid(`${label}.revision`, "must be a positive safe integer");
    }
    return {
      schemaVersion: literal(row.schemaVersion, MISSION_CONTRACT_SCHEMA_VERSION, `${label}.schemaVersion`),
      type: literal(row.type, "missionContractConfirmed", `${label}.type`),
      eventId: identifier(row.eventId, `${label}.eventId`),
      occurredAt: isoTimestamp(row.occurredAt, `${label}.occurredAt`),
      missionId: identifier(row.missionId, `${label}.missionId`),
      proposalId: identifier(row.proposalId, `${label}.proposalId`),
      confirmationId: identifier(row.confirmationId, `${label}.confirmationId`),
      documentSha256: sha256(row.documentSha256, `${label}.documentSha256`),
      previousBindingSha256: sha256(row.previousBindingSha256, `${label}.previousBindingSha256`),
      revision: row.revision,
      confirmedBy: literal(row.confirmedBy, "local-user", `${label}.confirmedBy`),
    };
  }
  if (type === "missionContractProposalDismissed") {
    const row = asExactRecord(
      value,
      [
        "schemaVersion",
        "type",
        "eventId",
        "occurredAt",
        "proposalId",
        "dismissalId",
        "dismissedBy",
        "reason",
      ],
      label,
    );
    return {
      schemaVersion: literal(row.schemaVersion, MISSION_CONTRACT_SCHEMA_VERSION, `${label}.schemaVersion`),
      type: literal(row.type, "missionContractProposalDismissed", `${label}.type`),
      eventId: identifier(row.eventId, `${label}.eventId`),
      occurredAt: isoTimestamp(row.occurredAt, `${label}.occurredAt`),
      proposalId: identifier(row.proposalId, `${label}.proposalId`),
      dismissalId: identifier(row.dismissalId, `${label}.dismissalId`),
      dismissedBy: literal(row.dismissedBy, "local-user", `${label}.dismissedBy`),
      reason: boundedOptionalReason(row.reason, `${label}.reason`),
    };
  }
  if (type === "missionContractRetired") {
    const row = asExactRecord(
      value,
      [
        "schemaVersion",
        "type",
        "eventId",
        "occurredAt",
        "missionId",
        "retirementId",
        "documentSha256",
        "bindingSha256",
        "revision",
        "retiredBy",
        "reason",
      ],
      label,
    );
    if (typeof row.revision !== "number"
      || !Number.isSafeInteger(row.revision)
      || row.revision < 1
      || Object.is(row.revision, -0)) {
      invalid(`${label}.revision`, "must be a positive safe integer");
    }
    return {
      schemaVersion: literal(row.schemaVersion, MISSION_CONTRACT_SCHEMA_VERSION, `${label}.schemaVersion`),
      type: literal(row.type, "missionContractRetired", `${label}.type`),
      eventId: identifier(row.eventId, `${label}.eventId`),
      occurredAt: isoTimestamp(row.occurredAt, `${label}.occurredAt`),
      missionId: identifier(row.missionId, `${label}.missionId`),
      retirementId: identifier(row.retirementId, `${label}.retirementId`),
      documentSha256: sha256(row.documentSha256, `${label}.documentSha256`),
      bindingSha256: sha256(row.bindingSha256, `${label}.bindingSha256`),
      revision: row.revision,
      retiredBy: literal(row.retiredBy, "local-user", `${label}.retiredBy`),
      reason: boundedOptionalReason(row.reason, `${label}.reason`),
    };
  }
  invalid(`${label}.type`, "must be a supported Mission Contract event type");
}

interface MutableProposalState {
  proposal: MissionContractProposedEvent;
  status: MissionContractProposalStatus;
  closedByEventId?: string;
}

function unboundBinding(): UnboundMissionContractBinding {
  return {
    state: "unbound",
    documentSha256: null,
    bindingSha256: UNBOUND_MISSION_BINDING_SHA256,
  };
}

function stalePendingProposals(
  proposals: Map<string, MutableProposalState>,
  exceptProposalId: string | undefined,
  eventId: string,
): void {
  for (const [proposalId, state] of proposals) {
    if (proposalId === exceptProposalId || state.status !== "pending") continue;
    state.status = "stale";
    state.closedByEventId = eventId;
  }
}

/**
 * Replays the complete stream. Any unknown field, malformed reference, stale
 * base, duplicate identifier, or illegal authority transition throws.
 */
export function replayMissionContractEvents(values: readonly unknown[]): MissionContractSnapshot {
  const events = values.map((value, index) => parseMissionContractEvent(value, index));
  const eventIds = new Set<string>();
  const proposalIds = new Set<string>();
  const confirmationIds = new Set<string>();
  const dismissalIds = new Set<string>();
  const retirementIds = new Set<string>();
  const activatedMissionIds = new Set<string>();
  const proposals = new Map<string, MutableProposalState>();
  let binding: MissionContractBinding = unboundBinding();

  events.forEach((event, index) => {
    const label = `events[${index}]`;
    if (eventIds.has(event.eventId)) invalid(`${label}.eventId`, `duplicates ${event.eventId}`);
    eventIds.add(event.eventId);

    if (event.type === "missionContractProposed") {
      if (proposalIds.has(event.proposalId)) invalid(`${label}.proposalId`, `duplicates ${event.proposalId}`);
      proposalIds.add(event.proposalId);
      if (event.baseBindingSha256 !== binding.bindingSha256) {
        invalid(`${label}.baseBindingSha256`, "does not match the active binding at proposal time");
      }
      if (binding.state === "active" && event.missionId !== binding.missionId) {
        invalid(`${label}.missionId`, "an amendment must keep the active mission id");
      }
      if (binding.state === "unbound" && activatedMissionIds.has(event.missionId)) {
        invalid(`${label}.missionId`, "a retired mission id cannot be reused for a new initial activation");
      }
      const outstandingCount = [...proposals.values()].filter((state) => state.status === "pending").length;
      if (outstandingCount >= MISSION_CONTRACT_LIMITS.outstandingProposals) {
        invalid(
          label,
          `cannot exceed ${MISSION_CONTRACT_LIMITS.outstandingProposals} outstanding proposals`,
        );
      }
      const computedHash = missionContractSha256(event.contract);
      if (event.documentSha256 !== computedHash) {
        invalid(`${label}.documentSha256`, "does not match the canonical contract document");
      }
      proposals.set(event.proposalId, { proposal: event, status: "pending" });
      return;
    }

    if (event.type === "missionContractConfirmed") {
      if (confirmationIds.has(event.confirmationId)) {
        invalid(`${label}.confirmationId`, `duplicates ${event.confirmationId}`);
      }
      confirmationIds.add(event.confirmationId);
      const state = proposals.get(event.proposalId);
      if (!state) invalid(`${label}.proposalId`, "references an unknown or later proposal");
      if (state.status !== "pending") invalid(`${label}.proposalId`, `references a ${state.status} proposal`);
      const proposal = state.proposal;
      if (event.missionId !== proposal.missionId) invalid(`${label}.missionId`, "does not match the proposal");
      if (event.documentSha256 !== proposal.documentSha256) {
        invalid(`${label}.documentSha256`, "does not match the proposal");
      }
      if (event.previousBindingSha256 !== binding.bindingSha256
        || proposal.baseBindingSha256 !== binding.bindingSha256) {
        invalid(`${label}.previousBindingSha256`, "does not match the current active binding");
      }
      const expectedRevision = binding.state === "active" ? binding.revision + 1 : 1;
      if (event.revision !== expectedRevision) {
        invalid(`${label}.revision`, `must be ${expectedRevision}`);
      }
      if (binding.state === "active" && event.missionId !== binding.missionId) {
        invalid(`${label}.missionId`, "an amendment must keep the active mission id");
      }
      if (binding.state === "unbound" && activatedMissionIds.has(event.missionId)) {
        invalid(`${label}.missionId`, "a retired mission id cannot be reactivated");
      }
      state.status = "confirmed";
      state.closedByEventId = event.eventId;
      stalePendingProposals(proposals, event.proposalId, event.eventId);
      const bindingSha256 = missionContractBindingSha256({
        missionId: event.missionId,
        revision: event.revision,
        confirmationEventId: event.eventId,
        documentSha256: event.documentSha256,
      });
      binding = {
        state: "active",
        missionId: event.missionId,
        revision: event.revision,
        documentSha256: event.documentSha256,
        bindingSha256,
        proposalId: event.proposalId,
        confirmationEventId: event.eventId,
        contract: proposal.contract,
      };
      activatedMissionIds.add(event.missionId);
      return;
    }

    if (event.type === "missionContractProposalDismissed") {
      if (dismissalIds.has(event.dismissalId)) invalid(`${label}.dismissalId`, `duplicates ${event.dismissalId}`);
      dismissalIds.add(event.dismissalId);
      const state = proposals.get(event.proposalId);
      if (!state) invalid(`${label}.proposalId`, "references an unknown or later proposal");
      if (state.status !== "pending") invalid(`${label}.proposalId`, `references a ${state.status} proposal`);
      state.status = "dismissed";
      state.closedByEventId = event.eventId;
      return;
    }

    if (retirementIds.has(event.retirementId)) invalid(`${label}.retirementId`, `duplicates ${event.retirementId}`);
    retirementIds.add(event.retirementId);
    if (binding.state !== "active") invalid(label, "cannot retire while no contract is active");
    if (event.missionId !== binding.missionId
      || event.documentSha256 !== binding.documentSha256
      || event.bindingSha256 !== binding.bindingSha256
      || event.revision !== binding.revision) {
      invalid(label, "does not bind the exact active mission, revision, and hash");
    }
    stalePendingProposals(proposals, undefined, event.eventId);
    binding = unboundBinding();
  });

  return {
    eventCount: events.length,
    binding,
    proposals: [...proposals.values()].map((state) => ({
      proposal: state.proposal,
      status: state.status,
      ...(state.closedByEventId ? { closedByEventId: state.closedByEventId } : {}),
    })),
  };
}

export function validateMissionContractEvents(values: readonly unknown[]): string[] {
  try {
    replayMissionContractEvents(values);
    return [];
  } catch (error) {
    if (error instanceof MissionContractValidationError) return [...error.issues];
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function assertValidMissionContractEvents(
  values: readonly unknown[],
): asserts values is readonly MissionContractEvent[] {
  replayMissionContractEvents(values);
}

export function missionContractBindingForPrompt(binding: MissionContractBinding): {
  schemaVersion: 1;
  state: "unbound" | "active";
  missionId: string | null;
  revision: number | null;
  documentSha256: string | null;
  bindingSha256: string;
  contract: MissionContractDocument | null;
} {
  if (binding.state === "unbound") {
    return {
      schemaVersion: 1,
      state: "unbound",
      missionId: null,
      revision: null,
      documentSha256: null,
      bindingSha256: UNBOUND_MISSION_BINDING_SHA256,
      contract: null,
    };
  }
  return {
    schemaVersion: 1,
    state: "active",
    missionId: binding.missionId,
    revision: binding.revision,
    documentSha256: binding.documentSha256,
    bindingSha256: binding.bindingSha256,
    contract: binding.contract,
  };
}

export function renderMissionContractPromptContext(binding: MissionContractBinding): string {
  return [
    "HYDRA_MISSION_CONTRACT_V1",
    "This binding narrows configured authority; it never grants additional authority.",
    JSON.stringify(missionContractBindingForPrompt(binding)),
  ].join("\n");
}

function intrinsicProtected(pathValue: string): boolean {
  return pathValue.split("/").some((segment) => {
    const lowered = segment.toLowerCase();
    return lowered === ".git" || lowered === ".hydra";
  });
}

function pathWithinScope(
  candidate: string,
  scope: Pick<MissionPathScope, "path" | "includeDescendants">,
  caseSensitive: boolean,
): boolean {
  const normalizeCase = (value: string): string => caseSensitive ? value : value.toLowerCase();
  const pathValue = normalizeCase(candidate);
  const root = normalizeCase(scope.path);
  if (root === ".") return scope.includeDescendants;
  return pathValue === root || (scope.includeDescendants && pathValue.startsWith(`${root}/`));
}

function checkOneMutationPath(
  contract: MissionContractDocument,
  operation: MissionMutationOperation,
  rawPath: string,
  caseSensitive: boolean,
): {
  allowed: boolean;
  reason: string;
  normalizedPath?: string;
  matchedRuleIds: string[];
} {
  let normalizedPath: string;
  try {
    // Preserve a dedicated intrinsic-protection reason for these reserved
    // paths instead of collapsing them into a generic unsafe-path result.
    const normalizedCandidate = rawPath.replace(/\\/g, "/");
    if (intrinsicProtected(normalizedCandidate)) {
      return {
        allowed: false,
        reason: ".git and .hydra are intrinsically protected",
        matchedRuleIds: [],
      };
    }
    normalizedPath = normalizeMissionRelativePath(rawPath, "mutation.path");
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : "unsafe workspace-relative path",
      matchedRuleIds: [],
    };
  }
  const protectedScope = contract.protectedPaths.find((scope) =>
    pathWithinScope(normalizedPath, scope, caseSensitive));
  if (protectedScope) {
    return {
      allowed: false,
      reason: `protected path rule: ${protectedScope.reason}`,
      normalizedPath,
      matchedRuleIds: [],
    };
  }
  const matchingRules = contract.allowedMutations.filter((rule) =>
    rule.operations.includes(operation)
    && pathWithinScope(normalizedPath, rule, caseSensitive));
  if (matchingRules.length === 0) {
    return {
      allowed: false,
      reason: `no allowed mutation rule covers ${operation} of ${normalizedPath}`,
      normalizedPath,
      matchedRuleIds: [],
    };
  }
  return {
    allowed: true,
    reason: `allowed by ${matchingRules.map((rule) => rule.id).join(", ")}`,
    normalizedPath,
    matchedRuleIds: matchingRules.map((rule) => rule.id),
  };
}

/**
 * Evaluates only the contract's narrowing policy. A true result does not grant
 * native authority and must still pass Hydra's independent permission gates.
 */
export function evaluateMissionMutation(
  contractValue: MissionContractDocument | unknown,
  request: MissionMutationRequest,
  options: { caseSensitive?: boolean } = {},
): MissionMutationDecision {
  const contract = normalizeMissionContract(contractValue);
  const caseSensitive = options.caseSensitive ?? process.platform !== "win32";
  if (request.operation !== "rename") {
    const result = checkOneMutationPath(contract, request.operation, request.path, caseSensitive);
    return {
      allowed: result.allowed,
      reason: result.reason,
      normalizedPaths: result.normalizedPath ? [result.normalizedPath] : [],
      matchedRuleIds: result.matchedRuleIds,
    };
  }
  const source = checkOneMutationPath(contract, "rename", request.fromPath, caseSensitive);
  if (!source.allowed) {
    return {
      allowed: false,
      reason: `rename source denied: ${source.reason}`,
      normalizedPaths: source.normalizedPath ? [source.normalizedPath] : [],
      matchedRuleIds: source.matchedRuleIds,
    };
  }
  const destination = checkOneMutationPath(contract, "rename", request.toPath, caseSensitive);
  if (!destination.allowed) {
    return {
      allowed: false,
      reason: `rename destination denied: ${destination.reason}`,
      normalizedPaths: [
        ...(source.normalizedPath ? [source.normalizedPath] : []),
        ...(destination.normalizedPath ? [destination.normalizedPath] : []),
      ],
      matchedRuleIds: [...new Set([...source.matchedRuleIds, ...destination.matchedRuleIds])],
    };
  }
  return {
    allowed: true,
    reason: `rename source and destination allowed by ${[
      ...new Set([...source.matchedRuleIds, ...destination.matchedRuleIds]),
    ].join(", ")}`,
    normalizedPaths: [source.normalizedPath!, destination.normalizedPath!],
    matchedRuleIds: [...new Set([...source.matchedRuleIds, ...destination.matchedRuleIds])],
  };
}

/**
 * Adds a read-only filesystem containment check to the pure contract policy.
 * The actual mutator must still use race-resistant file handles: this check
 * intentionally does not turn a preflight realpath result into authority.
 */
export async function evaluateMissionMutationOnDisk(
  workspaceRoot: string,
  contractValue: MissionContractDocument | unknown,
  request: MissionMutationRequest,
  options: { caseSensitive?: boolean } = {},
): Promise<MissionMutationDecision> {
  const policy = evaluateMissionMutation(contractValue, request, options);
  if (!policy.allowed) return policy;
  const unsafePath = await firstFilesystemEscape(workspaceRoot, policy.normalizedPaths);
  if (unsafePath) {
    return {
      allowed: false,
      reason: `filesystem containment denied ${unsafePath.path}: ${unsafePath.reason}`,
      normalizedPaths: policy.normalizedPaths,
      matchedRuleIds: policy.matchedRuleIds,
    };
  }
  return {
    ...policy,
    reason: `${policy.reason}; existing path ancestry resolves inside the workspace`,
  };
}

async function firstFilesystemEscape(
  workspaceRoot: string,
  normalizedPaths: readonly string[],
): Promise<{ path: string; reason: string } | undefined> {
  const rootAbsolute = path.resolve(workspaceRoot);
  const rootReal = await fs.realpath(rootAbsolute);
  for (const relativePath of normalizedPaths) {
    const candidate = path.resolve(rootAbsolute, ...relativePath.split("/"));
    if (!pathIsWithin(rootAbsolute, candidate)) {
      return { path: relativePath, reason: "lexically escapes the workspace" };
    }
    let existing = candidate;
    for (;;) {
      try {
        await fs.lstat(existing);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(existing);
        if (parent === existing || !pathIsWithin(rootAbsolute, parent)) {
          return { path: relativePath, reason: "has no contained existing ancestor" };
        }
        existing = parent;
      }
    }
    const existingReal = await fs.realpath(existing);
    if (!pathIsWithin(rootReal, existingReal)) {
      return { path: relativePath, reason: "traverses a symlink or junction outside the workspace" };
    }
    const realRelative = path.relative(rootReal, existingReal);
    if (intrinsicProtected(realRelative.replace(/\\/g, "/"))) {
      return { path: relativePath, reason: "resolves into intrinsically protected .git or .hydra metadata" };
    }
  }
  return undefined;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const normalizeCase = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const relative = path.relative(normalizeCase(root), normalizeCase(candidate));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
