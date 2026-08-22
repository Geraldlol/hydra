import * as fs from "node:fs/promises";
import {
  constants as fsConstants,
  type Stats,
} from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import {
  appendFileSafely,
  atomicWriteFile,
  ensureFile,
  serializePerFileAcrossProcesses,
} from "./fileQueue";
import {
  MISSION_CONTRACT_LIMITS,
  MissionContractValidationError,
  parseMissionContractEvent,
  replayMissionContractEvents,
  type MissionAcceptanceCheck,
  type MissionContractBinding,
  type MissionContractEvent,
  type MissionContractSnapshot,
} from "./missionContract";

export const MAX_MISSION_CONTRACT_LEDGER_BYTES = 16 * 1024 * 1024;
export const MAX_MISSION_CONTRACT_LEDGER_EVENTS = 20_000;
export const MAX_MISSION_CONTRACT_LEDGER_LINE_BYTES = 256 * 1024;

// Proposal writes leave append headroom for local confirmation, dismissal, or
// retirement even when an admitted-agent proposal stream approaches capacity.
// Covers the worst permitted UTF-8/JSON expansion of a 4,000-character
// dismissal/retirement reason plus all bounded ids, hashes, and row framing.
export const MISSION_CONTRACT_TERMINAL_EVENT_RESERVE_BYTES = 24 * 1024;

export type MissionContractLedgerErrorCode = "corrupt" | "capacity" | "invalidAppend";

export class MissionContractLedgerError extends Error {
  constructor(
    public readonly code: MissionContractLedgerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MissionContractLedgerError";
  }
}

export class MissionContractBindingConflictError extends Error {
  constructor(
    public readonly expectedBindingSha256: string,
    public readonly actualBindingSha256: string,
  ) {
    super(
      `Mission Contract binding changed: expected ${expectedBindingSha256}, current ${actualBindingSha256}.`,
    );
    this.name = "MissionContractBindingConflictError";
  }
}

export interface MissionContractLedgerState {
  events: MissionContractEvent[];
  snapshot: MissionContractSnapshot;
  byteLength: number;
}

export type MissionContractLedgerInspection =
  | {
      status: "ready";
      state: MissionContractLedgerState;
    }
  | {
      status: "corrupt";
      error: MissionContractLedgerError;
    };

export interface MissionContractLedgerMutation {
  events: MissionContractEvent[];
  snapshot: MissionContractSnapshot;
  appended: MissionContractEvent[];
}

export interface MissionContractLedgerCapacityInput {
  nextEventCount: number;
  nextByteLength: number;
  pendingProposalCount: number;
  hasActiveBinding: boolean;
}

export type MissionContractLedgerCapacityDecision =
  | {
      allowed: true;
      reservedTerminalEvents: number;
      reservedTerminalBytes: number;
    }
  | {
      allowed: false;
      reason: string;
      reservedTerminalEvents: number;
      reservedTerminalBytes: number;
    };

export function assessMissionContractLedgerCapacity(
  input: MissionContractLedgerCapacityInput,
): MissionContractLedgerCapacityDecision {
  const reservedTerminalEvents = input.pendingProposalCount + (input.hasActiveBinding ? 1 : 0);
  const reservedTerminalBytes = reservedTerminalEvents * MISSION_CONTRACT_TERMINAL_EVENT_RESERVE_BYTES;
  if (input.nextEventCount + reservedTerminalEvents > MAX_MISSION_CONTRACT_LEDGER_EVENTS) {
    return {
      allowed: false,
      reason: "Mission Contract ledger capacity reserve reached; every pending proposal and active binding retains one terminal-action row.",
      reservedTerminalEvents,
      reservedTerminalBytes,
    };
  }
  if (input.nextByteLength + reservedTerminalBytes > MAX_MISSION_CONTRACT_LEDGER_BYTES) {
    return {
      allowed: false,
      reason: "Mission Contract ledger byte reserve reached; terminal confirmation, dismissal, and retirement capacity remains reserved.",
      reservedTerminalEvents,
      reservedTerminalBytes,
    };
  }
  return { allowed: true, reservedTerminalEvents, reservedTerminalBytes };
}

export function privateMissionContractLedgerPath(privateWorkspaceRoot: string): string {
  return path.join(privateWorkspaceRoot, "mission", "contract-events.v1.jsonl");
}

export async function ensureMissionContractLedger(filePath: string): Promise<void> {
  await ensureFile(filePath);
}

interface BoundedMissionContractLedgerBytes {
  bytes: Buffer;
  totalBytes: number;
  truncated: boolean;
}

function assertSafeMissionContractLedgerFile(stat: Stats, filePath: string): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing to read Hydra Mission Contract ledger through a non-file entry: ${filePath}`);
  }
  if (stat.nlink !== 1) {
    throw new Error(`Refusing to read Hydra Mission Contract ledger with multiple hard links: ${filePath}`);
  }
}

function sameMissionContractLedgerFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Reads raw bytes from a safely opened ledger handle. The caller must hold the
 * ledger lease so a cooperating extension window cannot expose a partial
 * append between the size snapshot and the final read.
 */
async function readMissionContractLedgerBytesWhileLeased(
  filePath: string,
  maxBytes: number,
): Promise<BoundedMissionContractLedgerBytes> {
  await ensureMissionContractLedger(filePath);
  const before = await fs.lstat(filePath);
  assertSafeMissionContractLedgerFile(before, filePath);

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    assertSafeMissionContractLedgerFile(opened, filePath);
    if (!sameMissionContractLedgerFile(before, opened)) {
      throw new Error(`Refusing to read Hydra Mission Contract ledger after path swap: ${filePath}`);
    }

    const readLength = Math.min(opened.size, maxBytes);
    const bytes = Buffer.allocUnsafe(readLength);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const next = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (next.bytesRead === 0) break;
      bytesRead += next.bytesRead;
    }

    const afterRead = await fs.lstat(filePath);
    assertSafeMissionContractLedgerFile(afterRead, filePath);
    if (!sameMissionContractLedgerFile(opened, afterRead)) {
      throw new Error(`Refusing to read Hydra Mission Contract ledger after path swap: ${filePath}`);
    }
    if (afterRead.size !== opened.size) {
      throw new Error(`Hydra Mission Contract ledger changed during a leased read: ${filePath}`);
    }
    return {
      bytes: bytes.subarray(0, bytesRead),
      totalBytes: opened.size,
      truncated: opened.size > readLength,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Loads and replays the entire authoritative stream. Empty is a valid,
 * explicitly unbound state; malformed history throws and is never downgraded
 * to unbound.
 */
async function loadMissionContractLedgerWhileLeased(
  filePath: string,
): Promise<MissionContractLedgerState> {
  const bounded = await readMissionContractLedgerBytesWhileLeased(
    filePath,
    MAX_MISSION_CONTRACT_LEDGER_BYTES + 1,
  );
  if (bounded.totalBytes > MAX_MISSION_CONTRACT_LEDGER_BYTES || bounded.truncated) {
    throw new MissionContractLedgerError(
      "corrupt",
      `Hydra Mission Contract ledger exceeds ${MAX_MISSION_CONTRACT_LEDGER_BYTES} bytes.`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bounded.bytes);
  } catch (error) {
    throw new MissionContractLedgerError(
      "corrupt",
      "Hydra Mission Contract ledger is not valid canonical UTF-8.",
      { cause: error },
    );
  }
  if (Buffer.byteLength(text, "utf8") !== bounded.totalBytes) {
    throw new MissionContractLedgerError(
      "corrupt",
      "Hydra Mission Contract ledger is not valid canonical UTF-8.",
    );
  }
  if (text.length > 0 && !text.endsWith("\n")) {
    throw new MissionContractLedgerError(
      "corrupt",
      "Hydra Mission Contract ledger has a torn final row (missing final newline).",
    );
  }

  const parsed: unknown[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    const rawLine = text.slice(start, index).replace(/\r$/, "");
    start = index + 1;
    if (!rawLine.trim()) {
      throw new MissionContractLedgerError(
        "corrupt",
        `Hydra Mission Contract ledger contains an empty row at line ${parsed.length + 1}.`,
      );
    }
    if (Buffer.byteLength(rawLine, "utf8") > MAX_MISSION_CONTRACT_LEDGER_LINE_BYTES) {
      throw new MissionContractLedgerError(
        "corrupt",
        `Hydra Mission Contract ledger contains an oversized row at line ${parsed.length + 1}.`,
      );
    }
    if (parsed.length >= MAX_MISSION_CONTRACT_LEDGER_EVENTS) {
      throw new MissionContractLedgerError(
        "corrupt",
        `Hydra Mission Contract ledger exceeds ${MAX_MISSION_CONTRACT_LEDGER_EVENTS} events.`,
      );
    }
    try {
      parsed.push(JSON.parse(rawLine));
    } catch (error) {
      throw new MissionContractLedgerError(
        "corrupt",
        `Hydra Mission Contract ledger contains malformed JSON at line ${parsed.length + 1}.`,
        { cause: error },
      );
    }
  }

  try {
    const snapshot = replayMissionContractEvents(parsed);
    return {
      events: parsed as MissionContractEvent[],
      snapshot,
      byteLength: bounded.totalBytes,
    };
  } catch (error) {
    if (error instanceof MissionContractValidationError) {
      throw new MissionContractLedgerError(
        "corrupt",
        `Hydra Mission Contract ledger failed replay: ${error.issues.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function loadMissionContractLedger(filePath: string): Promise<MissionContractLedgerState> {
  return serializePerFileAcrossProcesses(
    filePath,
    () => loadMissionContractLedgerWhileLeased(filePath),
  );
}

/**
 * Read API for hosts that must distinguish a valid unbound ledger from corrupt
 * private state without treating unrelated I/O failures as corruption.
 */
export async function inspectMissionContractLedger(
  filePath: string,
): Promise<MissionContractLedgerInspection> {
  try {
    return { status: "ready", state: await loadMissionContractLedger(filePath) };
  } catch (error) {
    if (error instanceof MissionContractLedgerError && error.code === "corrupt") {
      return { status: "corrupt", error };
    }
    throw error;
  }
}

/**
 * Strictly reloads the ledger while holding the same cross-process lease used
 * for confirmation and retirement. This distinguishes a valid unbound
 * sentinel from corruption and detects identical-document amendments because
 * it compares the binding digest, not only the document digest.
 */
export async function assertCurrentMissionContractBinding(
  filePath: string,
  expectedBindingSha256: string,
): Promise<MissionContractBinding> {
  return serializePerFileAcrossProcesses(filePath, async () => {
    const current = await loadMissionContractLedgerWhileLeased(filePath);
    if (current.snapshot.binding.bindingSha256 !== expectedBindingSha256) {
      throw new MissionContractBindingConflictError(
        expectedBindingSha256,
        current.snapshot.binding.bindingSha256,
      );
    }
    return current.snapshot.binding;
  });
}

/**
 * Linearizes a short provider submission/steering write against contract
 * amendments. Keep `work` limited to the irreversible submit/write boundary;
 * the private-ledger lease intentionally remains held until it settles.
 */
export async function withCurrentMissionContractBinding<T>(
  filePath: string,
  expectedBindingSha256: string,
  work: (binding: MissionContractBinding) => Promise<T>,
): Promise<T> {
  return serializePerFileAcrossProcesses(filePath, async () => {
    const current = await loadMissionContractLedgerWhileLeased(filePath);
    if (current.snapshot.binding.bindingSha256 !== expectedBindingSha256) {
      throw new MissionContractBindingConflictError(
        expectedBindingSha256,
        current.snapshot.binding.bindingSha256,
      );
    }
    return work(current.snapshot.binding);
  });
}

/**
 * Cross-process compare-and-append primitive. The builder observes a fresh
 * complete replay while holding the file lease; callers perform expected-base
 * checks there, not against a stale controller cache.
 */
export async function mutateMissionContractLedger(
  filePath: string,
  buildAdditions: (
    state: Readonly<MissionContractLedgerState>,
  ) => readonly MissionContractEvent[] | Promise<readonly MissionContractEvent[]>,
): Promise<MissionContractLedgerMutation> {
  return serializePerFileAcrossProcesses(filePath, async () => {
    const current = await loadMissionContractLedgerWhileLeased(filePath);
    const builderView: MissionContractLedgerState = {
      events: structuredClone(current.events),
      snapshot: structuredClone(current.snapshot),
      byteLength: current.byteLength,
    };
    const built = [...await buildAdditions(builderView)];
    const additions = built.map((event, index) =>
      parseMissionContractEvent(structuredClone(event), current.events.length + index));
    if (additions.length === 0) {
      return {
        events: current.events,
        snapshot: current.snapshot,
        appended: [],
      };
    }
    const nextValues: unknown[] = [...current.events, ...additions];
    let snapshot: MissionContractSnapshot;
    try {
      snapshot = replayMissionContractEvents(nextValues);
    } catch (error) {
      if (error instanceof MissionContractValidationError) {
        throw new MissionContractLedgerError(
          "invalidAppend",
          `Refusing invalid Mission Contract append: ${error.issues.join("; ")}`,
          { cause: error },
        );
      }
      throw error;
    }

    const rows = additions.map((event) => JSON.stringify(event));
    for (const row of rows) {
      if (Buffer.byteLength(row, "utf8") > MAX_MISSION_CONTRACT_LEDGER_LINE_BYTES) {
        throw new MissionContractLedgerError(
          "capacity",
          `Mission Contract event rows cannot exceed ${MAX_MISSION_CONTRACT_LEDGER_LINE_BYTES} bytes.`,
        );
      }
    }
    const body = `${rows.join("\n")}\n`;
    const bodyBytes = Buffer.byteLength(body, "utf8");
    const capacity = assessMissionContractLedgerCapacity({
      nextEventCount: nextValues.length,
      nextByteLength: current.byteLength + bodyBytes,
      pendingProposalCount: snapshot.proposals.filter((proposal) => proposal.status === "pending").length,
      hasActiveBinding: snapshot.binding.state === "active",
    });
    if (!capacity.allowed) {
      throw new MissionContractLedgerError(
        "capacity",
        capacity.reason,
      );
    }
    await appendFileSafely(filePath, body);
    return {
      events: nextValues as MissionContractEvent[],
      snapshot,
      appended: additions,
    };
  });
}

export async function writeMissionContractMirror(
  filePath: string,
  snapshot: MissionContractSnapshot,
  generatedAt = new Date().toISOString(),
): Promise<void> {
  await atomicWriteFile(filePath, renderMissionContractMarkdown(snapshot, generatedAt));
}

/**
 * One-way disposable mirror. Unconfirmed contract bodies are deliberately not
 * copied into the workspace, while the complete confirmed contract is shown.
 */
export function renderMissionContractMarkdown(
  snapshot: MissionContractSnapshot,
  generatedAt = new Date().toISOString(),
): string {
  const pending = snapshot.proposals.filter((proposal) => proposal.status === "pending");
  const lines = [
    "# Hydra Mission Contract",
    "",
    "> Disposable human-readable mirror. The private Mission Contract ledger is authoritative.",
    "> Editing this file cannot activate, amend, retire, or grant authority.",
    "> A contract only narrows independently configured permissions.",
    "",
    `Generated: ${safeInline(generatedAt)}`,
    `Ledger events: ${snapshot.eventCount}`,
    `Binding state: ${snapshot.binding.state}`,
    `Binding SHA-256: ${safeInline(snapshot.binding.bindingSha256)}`,
    `Document SHA-256: ${snapshot.binding.documentSha256 ? safeInline(snapshot.binding.documentSha256) : "none"}`,
    "",
  ];

  if (snapshot.binding.state === "unbound") {
    lines.push(
      "## Active contract",
      "",
      "No Mission Contract is active. This is a valid explicit unbound state, not evidence of a corrupted ledger.",
      "",
    );
  } else {
    const binding = snapshot.binding;
    const contract = binding.contract;
    lines.push(
      "## Active contract",
      "",
      `Mission ID: ${safeInline(binding.missionId)}`,
      `Revision: ${binding.revision}`,
      `Proposal ID: ${safeInline(binding.proposalId)}`,
      "",
      `### ${safeInline(contract.title)}`,
      "",
      ...blockquote(contract.outcome),
      "",
      "### Budgets",
      "",
      `- Maximum cost (USD): ${formatBudget(contract.budgets.maxCostUsd)}`,
      `- Maximum agent calls: ${formatBudget(contract.budgets.maxAgentCalls)}`,
      `- Maximum wall-clock milliseconds: ${formatBudget(contract.budgets.maxWallClockMs)}`,
      `- Maximum retries: ${formatBudget(contract.budgets.maxRetries)}`,
      "",
      "### Acceptance checks",
      "",
    );
    contract.acceptanceChecks.forEach((check) => {
      lines.push(...renderAcceptanceCheck(check), "");
    });
    lines.push("### Protected paths", "");
    if (contract.protectedPaths.length === 0) {
      lines.push("No additional protected path scopes. `.git` and `.hydra` remain intrinsically protected.");
    } else {
      for (const scope of contract.protectedPaths) {
        lines.push(`- ${safeInline(scope.path)}${scope.includeDescendants ? " (including descendants)" : ""}: ${safeInline(scope.reason)}`);
      }
    }
    lines.push("", "### Allowed mutations", "");
    if (contract.allowedMutations.length === 0) {
      lines.push("No workspace mutations are allowed by this contract.");
    } else {
      for (const rule of contract.allowedMutations) {
        lines.push(
          `- ${safeInline(rule.id)} — ${safeInline(rule.path)}${rule.includeDescendants ? " (including descendants)" : ""}; operations: ${rule.operations.join(", ")}; ${safeInline(rule.reason)}`,
        );
      }
    }
    lines.push("", "### Evidence requirements", "");
    for (const requirement of contract.evidenceRequirements) {
      lines.push(
        `- ${safeInline(requirement.id)} [${safeInline(requirement.kind)}], checks ${requirement.acceptanceCheckIds.map(safeInline).join(", ")}: ${safeInline(requirement.description)}`,
      );
    }
    lines.push("", "### Non-goals", "");
    if (contract.nonGoals.length === 0) {
      lines.push("None recorded.");
    } else {
      contract.nonGoals.forEach((nonGoal) => lines.push(`- ${safeInline(nonGoal)}`));
    }
    lines.push("");
  }

  lines.push("## Outstanding proposals", "");
  if (pending.length === 0) {
    lines.push("No outstanding proposals.");
  } else {
    lines.push(
      `Outstanding: ${pending.length} / ${MISSION_CONTRACT_LIMITS.outstandingProposals}`,
      "",
      "| Proposal | Mission |",
      "| --- | --- |",
    );
    for (const state of pending) {
      const proposal = state.proposal;
      lines.push(
        `| ${safeCell(proposal.proposalId)} | ${safeCell(proposal.missionId)} |`,
      );
    }
    lines.push(
      "",
      "Unconfirmed proposal bodies remain private and have no authority effect.",
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderAcceptanceCheck(check: MissionAcceptanceCheck): string[] {
  const prefix = `- ${safeInline(check.id)} [${safeInline(check.kind)}] ${safeInline(check.label)}`;
  if (check.kind === "verificationCommand") {
    return [
      prefix,
      `  Expected exit code: ${check.expectedExitCode}`,
      "  Command (recorded only; this mirror does not execute it):",
      ...indentedCode(check.command),
    ];
  }
  if (check.kind === "artifact") {
    return [prefix, `  Path: ${safeInline(check.path)}`, `  Requirement: ${safeInline(check.requirement)}`];
  }
  if (check.kind === "browserJourney") {
    return [prefix, `  Journey: ${safeInline(check.journey)}`];
  }
  return [prefix, `  Instructions: ${safeInline(check.instructions)}`];
}

function formatBudget(value: number | null): string {
  return value === null ? "unbounded by contract" : String(value);
}

function blockquote(value: string): string[] {
  return value.split("\n").map((line) => `> ${safeInline(line)}`);
}

function indentedCode(value: string): string[] {
  return value.split("\n").map((line) => `      ${sanitizeText(line)}`);
}

function sanitizeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[<>]/g, (character) =>
    character === "<" ? "&lt;" : "&gt;");
}

function safeInline(value: string): string {
  return sanitizeText(value)
    .replace(/([\\`*_[\]{}()#+.!|>-])/g, "\\$1")
    .replace(/\s+/g, " ")
    .trim();
}

function safeCell(value: string): string {
  return sanitizeText(value).replace(/[\r\n|]/g, " ").replace(/\s+/g, " ").trim();
}
