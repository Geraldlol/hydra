import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  MAX_AGENT_STDOUT_BYTES,
  appendBoundedStream,
  type AgentSpawn,
  type BoundedStreamState,
  type RunResult,
} from "./agents";
import { BoundedLineScanner } from "./fileQueue";
import {
  startPersistentAgentProcess,
  type PersistentAgentProcess,
} from "./persistentAgentProcess";
import {
  STEERING_SCHEMA_VERSION,
  isBoundedIdentifier,
  isMissionBindingPair,
  isSha256,
  isSteeringTargetBinding,
  sha256Utf8,
  steeringTextMetrics,
  type SteeringProviderAcknowledgement,
  type SteeringProviderRequest,
} from "./steeringProtocol";
import {
  SteeringProviderError,
  type ActiveRunInspection,
  type LiveActiveSteeringHandle,
} from "./steeringController";
import {
  MISSION_SUBMISSION_WRITTEN,
  MissionSubmissionRejectedError,
  SubmissionCancelledBeforeWriteError,
  type MissionSubmissionGate,
} from "./missionDispatch";

export const CLAUDE_SESSION_PROTOCOL = "claude-stream-json-v2/replayed-user";
export const MIN_CLAUDE_SESSION_VERSION = "2.1.205";
export const CLAUDE_SESSION_CAPABILITY = "msg_lifecycle_v1";

const MAX_EVENT_LINE_CHARS = 1_000_000;
const MAX_EVENT_RECORDS = 20_000;
const MAX_RESULT_SEGMENTS = 64;
const MAX_REPLAY_UUIDS = 128;
const MAX_CAPABILITIES = 64;
const MAX_AGGREGATE_ARRAY_ITEMS = 256;
const MAX_INPUT_LINE_BYTES = 8 * 1024 * 1024;
const OUTPUT_TRUNCATION_MARKER =
  "[Hydra: aggregated Claude session stdout exceeded the native stdout bound]";

export interface ClaudeSessionPlan {
  readonly spawn: AgentSpawn;
}

export type ClaudeSessionPlanResult =
  | { readonly kind: "supported"; readonly plan: ClaudeSessionPlan }
  | { readonly kind: "unsupported"; readonly reason: string };

export interface ClaudeSessionRunBinding {
  readonly callId: string;
  readonly generation: string;
  readonly ownerId: string;
  readonly missionDocumentSha256: string | null;
  readonly missionBindingSha256: string;
  readonly authoritySha256: string;
}

export interface ClaudeSessionRunOptions {
  readonly plan: ClaudeSessionPlan;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly binding: ClaudeSessionRunBinding;
  readonly onChunk: (chunk: string) => void;
  readonly onHandleReady?: (handle: LiveActiveSteeringHandle) => void;
  /** Mission lease gate used only for initial/steering stdin writes. */
  readonly submissionGate?: MissionSubmissionGate;
  /** @internal Deterministic process seam for provider contract tests. */
  readonly startProcess?: typeof startPersistentAgentProcess;
}

interface ParsedClaudeArgs {
  readonly inputFormat?: string;
  readonly outputFormat?: string;
}

const NO_VALUE_FLAGS = new Set([
  "-p",
  "--print",
  "-c",
  "--continue",
  "--allow-dangerously-skip-permissions",
  "--ax-screen-reader",
  "--bare",
  "--brief",
  "--chrome",
  "--dangerously-skip-permissions",
  "--disable-slash-commands",
  "--exclude-dynamic-system-prompt-sections",
  "--fork-session",
  "--forward-subagent-text",
  "--ide",
  "--include-hook-events",
  "--include-partial-messages",
  "--no-chrome",
  "--no-session-persistence",
  "--replay-user-messages",
  "--safe-mode",
  "--strict-mcp-config",
  "--verbose",
]);

const SINGLE_VALUE_FLAGS = new Set([
  "-m",
  "-n",
  "--agent",
  "--agents",
  "--append-system-prompt",
  "--append-system-prompt-file",
  "--debug-file",
  "--effort",
  "--fallback-model",
  "--input-format",
  "--max-budget-usd",
  "--max-turns",
  "--model",
  "--name",
  "--output-format",
  "--permission-mode",
  "--session-id",
  "--setting-sources",
  "--settings",
  "--system-prompt",
  "--system-prompt-file",
]);

const REPEATABLE_SINGLE_VALUE_FLAGS = new Set([
  "--plugin-dir",
  "--plugin-url",
]);

const VARIADIC_VALUE_FLAGS = new Set([
  "--add-dir",
  "--allowedTools",
  "--allowed-tools",
  "--betas",
  "--disallowedTools",
  "--disallowed-tools",
  "--file",
  "--mcp-config",
  "--tools",
]);

const OPTIONAL_VALUE_FLAGS = new Set([
  "-d",
  "-r",
  "--debug",
  "--prompt-suggestions",
  "--resume",
]);

const INCOMPATIBLE_FLAGS = new Map([
  ["--bg", "background mode changes the native process lifecycle"],
  ["--background", "background mode changes the native process lifecycle"],
  ["--from-pr", "PR resume selection is not a deterministic print invocation"],
  ["--json-schema", "multiple structured outputs cannot be losslessly aggregated"],
  ["--remote-control", "Remote Control owns a different persistent transport"],
  ["--remote-control-session-name-prefix", "Remote Control owns a different persistent transport"],
  ["--tmux", "tmux mode changes native process ownership"],
  ["--worktree", "worktree mode changes the invocation working directory"],
  ["-w", "worktree mode changes the invocation working directory"],
]);

/**
 * Promote only a completely understood Claude print invocation. The original
 * argv is retained verbatim, including prepared partial-message and debug-file
 * flags; the four bidirectional stream requirements are appended only when
 * absent.
 */
export function planClaudeSession(spawn: AgentSpawn): ClaudeSessionPlanResult {
  if (!path.isAbsolute(spawn.cwd)) {
    return unsupported("Claude session steering requires an absolute working directory.");
  }
  const parsed = parseCompatibleClaudeArgs(spawn.args);
  if (parsed.kind === "unsupported") return parsed;
  if (parsed.printCount !== 1) {
    return unsupported("Claude session steering requires exactly one -p/--print flag.");
  }
  if (parsed.values.outputFormat !== undefined && parsed.values.outputFormat !== "stream-json") {
    return unsupported("Claude session steering requires --output-format stream-json.");
  }
  if (parsed.values.inputFormat !== undefined && parsed.values.inputFormat !== "stream-json") {
    return unsupported("Claude session steering requires --input-format stream-json.");
  }

  const args = [...spawn.args];
  if (parsed.values.inputFormat === undefined) args.push("--input-format", "stream-json");
  if (parsed.values.outputFormat === undefined) args.push("--output-format", "stream-json");
  if (!parsed.seenFlags.has("--verbose")) args.push("--verbose");
  if (!parsed.seenFlags.has("--replay-user-messages")) args.push("--replay-user-messages");
  return {
    kind: "supported",
    plan: {
      spawn: {
        ...spawn,
        args,
        // PersistentAgentProcess deliberately ignores AgentSpawn.stdin. Keep
        // this empty so a future generic dispatcher cannot also pipe the raw
        // prompt beside the JSON envelope owned by this transport.
        stdin: "",
      },
    },
  };
}

/** Descriptive alias for callers that name planners after their module. */
export const planClaudeSessionTransport = planClaudeSession;

/**
 * Run one held-open Claude stream-json session. Each accepted stdin user
 * envelope must be replayed exactly and receive its own distinct result before
 * the process is allowed to close.
 */
export async function runClaudeSession(options: ClaudeSessionRunOptions): Promise<RunResult> {
  validateRunOptions(options);

  const protocol = new ClaudeSessionProtocol(options);
  const processHandle = (options.startProcess ?? startPersistentAgentProcess)(
    options.plan.spawn,
    options.timeoutMs,
    (chunk) => {
      protocol.push(chunk);
      try {
        options.onChunk(chunk);
      } catch {
        // PersistentAgentProcess also guards this callback, but keeping the
        // provider parser ahead of UI delivery makes that ordering explicit.
      }
    },
    options.signal,
  );
  protocol.bindProcess(processHandle);

  const exited = processHandle.result.then((result) => {
    protocol.processExited(result);
    return result;
  });

  await protocol.sendInitial(options.prompt);
  const closeReadiness = await protocol.closeReadiness();
  if (closeReadiness.kind === "complete") {
    await processHandle.endInput();
  }
  const raw = await exited;
  const outcome = await protocol.completion();
  protocol.markInactive();
  const providerReportedError = protocol.resultEnvelopes().some(
    (event) => event.is_error === true,
  );

  const protocolDiagnostic = outcome.kind === "failed" ? outcome.message : "";
  const stderr = protocolDiagnostic
    ? appendDiagnostic(raw.stderr, `[Hydra Claude session protocol failure] ${protocolDiagnostic}`)
    : raw.stderr;
  return {
    ...raw,
    stdout: outcome.kind === "complete"
      ? aggregateClaudeStdout(
          raw.stdout,
          protocol.resultEnvelopes(),
          protocol.accountingEnvelopes(),
          protocol.sessionId(),
        )
      : raw.stdout,
    stderr,
    exitCode: (outcome.kind === "failed" || providerReportedError) && raw.exitCode === 0
      ? 1
      : raw.exitCode,
    ...(protocol.initialDeliveryMayBeUnknown()
      && !raw.cancelled
      && !raw.timedOut
      ? { deliveryUnknown: true }
      : {}),
  };
}

/** Integration-friendly alias matching the Codex transport's turn naming. */
export const runClaudeSessionTurn = runClaudeSession;

type ProtocolOutcome =
  | { readonly kind: "complete" }
  | { readonly kind: "failed"; readonly message: string };

interface InputTurn {
  readonly kind: "initial" | "steering";
  readonly text: string;
  readonly textSha256: string;
  readonly outboundUuid: string;
  readonly request?: SteeringProviderRequest;
  readonly replay: Promise<ReplayReceipt>;
  resolveReplay: (receipt: ReplayReceipt) => void;
  rejectReplay: (error: Error) => void;
  writeStarted: boolean;
  replayed: boolean;
}

interface ReplayReceipt {
  readonly uuid: string;
  readonly sessionId: string;
}

class ClaudeSessionProtocol {
  private readonly scanner = new BoundedLineScanner({
    maxLineChars: MAX_EVENT_LINE_CHARS,
    headLinesPerPush: 4_096,
    tailLinesPerPush: 1_024,
  });
  private readonly handle: ClaudeSessionHandle;
  private readonly awaitingReplay: InputTurn[] = [];
  private readonly awaitingResult: InputTurn[] = [];
  private readonly results: Record<string, unknown>[] = [];
  private readonly accountingResults: Record<string, unknown>[] = [];
  private readonly replayUuids = new Set<string>();
  private readonly resultUuids = new Set<string>();
  private readonly preInitSessionIds = new Set<string>();
  private readonly done: Promise<ProtocolOutcome>;
  private resolveDone!: (outcome: ProtocolOutcome) => void;
  private readonly readyToClose: Promise<ProtocolOutcome>;
  private resolveReadyToClose!: (outcome: ProtocolOutcome) => void;
  private processHandle: PersistentAgentProcess | undefined;
  private providerSessionId = "";
  private eventRecords = 0;
  private initialAccepted = false;
  private handlePublished = false;
  private deliveryReservations = 0;
  private closing = false;
  private finished = false;
  private failed = false;
  private flushed = false;
  private initialDeliveryUnknown = false;

  constructor(private readonly options: ClaudeSessionRunOptions) {
    this.handle = new ClaudeSessionHandle(this, options.binding);
    this.done = new Promise<ProtocolOutcome>((resolve) => {
      this.resolveDone = resolve;
    });
    this.readyToClose = new Promise<ProtocolOutcome>((resolve) => {
      this.resolveReadyToClose = resolve;
    });
  }

  bindProcess(processHandle: PersistentAgentProcess): void {
    this.processHandle = processHandle;
  }

  async sendInitial(prompt: string): Promise<void> {
    if (typeof prompt !== "string" || prompt.length === 0) {
      this.fail("The initial Claude prompt must be a non-empty string.", "providerFailure");
      return;
    }
    const turn = this.createTurn("initial", prompt);
    this.awaitingReplay.push(turn);
    await this.writeTurn(turn, this.options.submissionGate);
  }

  completion(): Promise<ProtocolOutcome> {
    return this.done;
  }

  closeReadiness(): Promise<ProtocolOutcome> {
    return this.readyToClose;
  }

  resultEnvelopes(): readonly Record<string, unknown>[] {
    return this.results;
  }

  accountingEnvelopes(): readonly Record<string, unknown>[] {
    return this.accountingResults;
  }

  sessionId(): string {
    return this.providerSessionId;
  }

  initialDeliveryMayBeUnknown(): boolean {
    return this.initialDeliveryUnknown;
  }

  push(chunk: string): void {
    if (this.finished || this.failed) return;
    try {
      this.scanner.push(
        chunk,
        (line) => this.consumeLine(line),
        () => this.fail(
          `Claude emitted an oversized or excessively dense JSONL chunk (line bound ${MAX_EVENT_LINE_CHARS}).`,
          "providerFailure",
        ),
      );
    } catch (error) {
      this.fail(errorMessage(error), "providerFailure");
    }
  }

  processExited(result: RunResult): void {
    this.flush();
    if (this.finished || this.failed) return;
    if (this.closing
      && this.awaitingReplay.length === 0
      && this.awaitingResult.length === 0) {
      this.finished = true;
      this.resolveDone({ kind: "complete" });
      return;
    }
    const suffix = result.timedOut
      ? ` after timing out at ${String(result.timeoutMs)} ms`
      : result.cancelled
        ? " after cancellation"
        : ` with exit code ${String(result.exitCode)}`;
    this.fail(`Claude exited${suffix} before every accepted input produced a distinct result.`, "processExit");
  }

  reserveDelivery(): void {
    this.deliveryReservations++;
  }

  releaseDelivery(): void {
    this.deliveryReservations = Math.max(0, this.deliveryReservations - 1);
    this.scheduleCompletionCheck();
  }

  async deliver(
    request: SteeringProviderRequest,
    submissionGate?: MissionSubmissionGate,
  ): Promise<SteeringProviderAcknowledgement> {
    if (!this.handle.isActive() || this.finished || this.failed || !this.processHandle?.inputOpen) {
      throw new SteeringProviderError("processExit", false, "The Claude session is no longer active.");
    }
    if (!requestMatchesBinding(request, this.options.binding)) {
      return rejectedAcknowledgement(
        request,
        "The steering request does not exactly match this Claude run binding.",
      );
    }
    const turn = this.createTurn("steering", request.text, request);
    this.awaitingReplay.push(turn);
    await this.writeTurn(turn, submissionGate);
    const receipt = await turn.replay;
    return {
      schemaVersion: STEERING_SCHEMA_VERSION,
      status: "acknowledged",
      steeringId: request.steeringId,
      callId: request.target.callId,
      generation: request.target.generation,
      sequence: request.target.sequence,
      textSha256: request.textSha256,
      missionDocumentSha256: request.target.missionDocumentSha256,
      missionBindingSha256: request.target.missionBindingSha256,
      delivery: "sameSessionNextTurn",
      providerReceiptSha256: sha256Utf8(JSON.stringify({
        protocol: CLAUDE_SESSION_PROTOCOL,
        sessionId: receipt.sessionId,
        replayUuid: receipt.uuid,
        steeringId: request.steeringId,
        callId: request.target.callId,
        generation: request.target.generation,
        sequence: request.target.sequence,
        textSha256: request.textSha256,
        missionDocumentSha256: request.target.missionDocumentSha256,
        missionBindingSha256: request.target.missionBindingSha256,
      })),
    };
  }

  async close(reason: "completed" | "cancelled" | "failed"): Promise<void> {
    this.handle.markInactive();
    if (reason === "completed") {
      await this.processHandle?.endInput();
      return;
    }
    this.fail(`The Claude session was closed as ${reason}.`, "processExit");
  }

  markInactive(): void {
    this.handle.markInactive();
  }

  private createTurn(
    kind: InputTurn["kind"],
    text: string,
    request?: SteeringProviderRequest,
  ): InputTurn {
    let resolveReplay!: (receipt: ReplayReceipt) => void;
    let rejectReplay!: (error: Error) => void;
    const replay = new Promise<ReplayReceipt>((resolve, reject) => {
      resolveReplay = resolve;
      rejectReplay = reject;
    });
    // A synchronous EPIPE/protocol failure can precede writeTurn's await.
    // Observe the rejection immediately without changing the promise returned
    // to the delivery operation.
    void replay.catch(() => undefined);
    return {
      kind,
      text,
      textSha256: request?.textSha256 ?? sha256Utf8(text),
      outboundUuid: randomUUID(),
      ...(request ? { request } : {}),
      replay,
      resolveReplay,
      rejectReplay,
      writeStarted: false,
      replayed: false,
    };
  }

  private async writeTurn(
    turn: InputTurn,
    submissionGate?: MissionSubmissionGate,
  ): Promise<void> {
    const processHandle = this.processHandle;
    if (!processHandle?.inputOpen) {
      this.removeAwaitingReplay(turn);
      const error = new SteeringProviderError(
        "processExit",
        false,
        "The Claude stdin channel closed before the input write began.",
      );
      turn.rejectReplay(error);
      this.fail(error.message, "processExit");
      return;
    }
    const envelope = {
      type: "user",
      uuid: turn.outboundUuid,
      message: {
        role: "user",
        content: turn.text,
      },
      parent_tool_use_id: null,
      origin: { kind: "human" },
      ...(this.providerSessionId ? { session_id: this.providerSessionId } : {}),
    };
    const line = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_INPUT_LINE_BYTES) {
      this.removeAwaitingReplay(turn);
      const error = new SteeringProviderError(
        "providerFailure",
        false,
        `Claude input exceeds the ${MAX_INPUT_LINE_BYTES}-byte transport bound.`,
      );
      turn.rejectReplay(error);
      this.fail(error.message, "providerFailure");
      return;
    }
    try {
      if (submissionGate) {
        await submissionGate.write(
          turn.kind === "initial" ? "claude.initial" : "claude.steer",
          async (): Promise<typeof MISSION_SUBMISSION_WRITTEN> => {
            if (this.options.signal.aborted) {
              throw new SubmissionCancelledBeforeWriteError(
                "Claude input was cancelled before provider submission.",
              );
            }
            turn.writeStarted = true;
            await processHandle.write(line);
            return MISSION_SUBMISSION_WRITTEN;
          },
        );
      } else {
        turn.writeStarted = true;
        await processHandle.write(line);
      }
    } catch (error) {
      if (
        error instanceof MissionSubmissionRejectedError
        || error instanceof SubmissionCancelledBeforeWriteError
      ) {
        this.removeAwaitingReplay(turn);
        turn.rejectReplay(error);
        if (turn.kind === "initial") {
          this.fail(error.message, "providerFailure");
        }
        throw error;
      }
      // A stream callback error can arrive after some or all bytes crossed the
      // pipe. Never retry this envelope or let a later FIFO input overtake it.
      const providerError = new SteeringProviderError(
        "providerFailure",
        true,
        `Claude stdin write failed without a safe retry boundary: ${errorMessage(error)}`,
      );
      if (turn.kind === "initial" && turn.writeStarted) {
        this.initialDeliveryUnknown = true;
      }
      turn.rejectReplay(providerError);
      this.fail(providerError.message, "providerFailure");
    }
  }

  private consumeLine(line: string): void {
    if (this.finished || this.failed || !line.trim()) return;
    this.eventRecords++;
    if (this.eventRecords > MAX_EVENT_RECORDS) {
      this.fail(`Claude exceeded the ${MAX_EVENT_RECORDS}-record session bound.`, "providerFailure");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.fail("Claude emitted malformed non-empty stream-json output.", "providerFailure");
      return;
    }
    const event = asRecord(parsed);
    if (!event || typeof event.type !== "string") {
      this.fail("Claude emitted a stream-json record without an object type discriminator.", "providerFailure");
      return;
    }

    const eventSessionId = stringField(event, "session_id");
    if (this.providerSessionId) {
      if (eventSessionId !== undefined && eventSessionId !== this.providerSessionId) {
        this.fail("Claude changed session_id inside the held-open process.", "providerFailure");
        return;
      }
    } else if (eventSessionId) {
      if (this.preInitSessionIds.size >= 4 && !this.preInitSessionIds.has(eventSessionId)) {
        this.fail("Claude emitted too many pre-init session bindings.", "providerFailure");
        return;
      }
      this.preInitSessionIds.add(eventSessionId);
    }

    if (event.type === "system" && event.subtype === "init") {
      this.consumeInit(event);
      return;
    }
    if (event.type === "user") {
      this.consumeUserReplay(event);
      return;
    }
    if (event.type === "result") {
      this.consumeResult(event);
    }
  }

  private consumeInit(event: Record<string, unknown>): void {
    if (this.providerSessionId) {
      this.fail("Claude emitted more than one system/init envelope.", "providerFailure");
      return;
    }
    const sessionId = stringField(event, "session_id");
    if (!sessionId || !isUuid(sessionId)) {
      this.fail("Claude system/init omitted a valid provider session UUID.", "providerFailure");
      return;
    }
    const cwd = stringField(event, "cwd");
    if (!cwd || !sameResolvedPath(cwd, this.options.plan.spawn.cwd)) {
      this.fail("Claude system/init did not preserve the invocation working directory.", "providerFailure");
      return;
    }
    const capabilities = readCapabilities(event.capabilities);
    if (capabilities === undefined && event.capabilities !== undefined) {
      this.fail("Claude system/init advertised malformed capabilities.", "providerFailure");
      return;
    }
    const version = event.claude_code_version;
    if (version !== undefined && (typeof version !== "string" || !parseClaudeVersion(version))) {
      this.fail("Claude system/init advertised a malformed claude_code_version.", "providerFailure");
      return;
    }
    const versionCompatible = typeof version === "string"
      && versionAtLeast(version, MIN_CLAUDE_SESSION_VERSION);
    const capabilityCompatible = capabilities?.has(CLAUDE_SESSION_CAPABILITY) === true;
    if (!versionCompatible && !capabilityCompatible) {
      this.fail(
        `Claude persistent sessions require Claude Code >=${MIN_CLAUDE_SESSION_VERSION} `
          + `or capability ${CLAUDE_SESSION_CAPABILITY}.`,
        "providerFailure",
      );
      return;
    }
    if ([...this.preInitSessionIds].some((candidate) => candidate !== sessionId)) {
      this.fail("Claude pre-init envelopes did not bind to the initialized session.", "providerFailure");
      return;
    }
    this.providerSessionId = sessionId;
  }

  private consumeUserReplay(event: Record<string, unknown>): void {
    // Tool-result user envelopes and forwarded subagent traffic are evidence,
    // not acknowledgements of Hydra stdin. Only the exact top-level string
    // shape written by writeTurn can accept a pending delivery.
    if (event.parent_tool_use_id !== null || event.isReplay !== true) return;
    const message = objectField(event, "message");
    if (!message || message.role !== "user" || typeof message.content !== "string") return;
    if (!this.providerSessionId) {
      this.fail("Claude replayed a user input before system/init established the session.", "providerFailure");
      return;
    }
    if (event.session_id !== this.providerSessionId) {
      this.fail("Claude replayed a user input under a different session_id.", "providerFailure");
      return;
    }
    const turn = this.awaitingReplay[0];
    if (!turn) {
      this.fail("Claude replayed a user input that Hydra did not write.", "providerFailure");
      return;
    }
    const replayUuid = stringField(event, "uuid");
    if (!replayUuid
      || replayUuid !== turn.outboundUuid
      || !isUuid(replayUuid)
      || this.replayUuids.has(replayUuid)) {
      this.fail("Claude replayed a user input without the exact caller-bound UUID.", "providerFailure");
      return;
    }
    if (message.content !== turn.text || sha256Utf8(message.content) !== turn.textSha256) {
      this.fail("Claude replayed a user envelope that did not exactly match the FIFO input.", "providerFailure");
      return;
    }
    if (this.replayUuids.size >= MAX_REPLAY_UUIDS) {
      this.fail(`Claude exceeded the ${MAX_REPLAY_UUIDS}-replay receipt bound.`, "providerFailure");
      return;
    }

    this.replayUuids.add(replayUuid);
    this.awaitingReplay.shift();
    turn.replayed = true;
    this.awaitingResult.push(turn);
    turn.resolveReplay({ uuid: replayUuid, sessionId: this.providerSessionId });
    if (turn.kind === "initial") {
      this.initialAccepted = true;
      this.publishHandle();
    }
    this.scheduleCompletionCheck();
  }

  private consumeResult(event: Record<string, unknown>): void {
    if (event.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null) return;
    if (!this.providerSessionId || event.session_id !== this.providerSessionId) {
      this.fail("Claude emitted a terminal result outside the initialized session.", "providerFailure");
      return;
    }
    const uuid = stringField(event, "uuid");
    if (!uuid || !isUuid(uuid) || this.resultUuids.has(uuid)) {
      this.fail("Claude emitted a result without a distinct provider UUID.", "providerFailure");
      return;
    }
    const subtype = stringField(event, "subtype");
    const success = subtype === "success";
    const errorSubtype = subtype === "error_during_execution"
      || subtype === "error_max_turns"
      || subtype === "error_max_budget_usd"
      || subtype === "error_max_structured_output_retries";
    if ((!success && !errorSubtype)
      || event.is_error !== !success
      || (success && typeof event.result !== "string")
      || (!success && event.result !== undefined)
      || (success && event.errors !== undefined)
      || (!success && !isStringArray(event.errors))
      || !isFiniteNonNegativeNumber(event.duration_ms)
      || !isFiniteNonNegativeNumber(event.duration_api_ms)
      || !Number.isSafeInteger(event.num_turns)
      || (event.num_turns as number) < 0
      || (event.stop_reason !== null && typeof event.stop_reason !== "string")
      || !isFiniteNonNegativeNumber(event.total_cost_usd)
      || !isBoundedRecord(event.usage)
      || !isBoundedModelUsage(event.modelUsage)
      || !isPermissionDenials(event.permission_denials)) {
      this.fail("Claude emitted a malformed result envelope.", "providerFailure");
      return;
    }
    const originKind = readResultOriginKind(event.origin);
    if (originKind === "invalid") {
      this.fail("Claude emitted a result with a malformed or unknown origin.", "providerFailure");
      return;
    }
    if (this.accountingResults.length >= MAX_RESULT_SEGMENTS * 2) {
      this.fail(`Claude exceeded the ${MAX_RESULT_SEGMENTS * 2}-result accounting bound.`, "providerFailure");
      return;
    }
    this.resultUuids.add(uuid);
    this.accountingResults.push(event);
    if (originKind !== "human") {
      // Background task/coordinator/peer follow-ups are real cost evidence,
      // but they cannot satisfy a Hydra-authored input's result barrier or
      // become its canonical final response.
      return;
    }

    const turn = this.awaitingResult[0];
    if (!turn) {
      this.fail("Claude emitted a result without a matching accepted user input.", "providerFailure");
      return;
    }
    if (!turn.replayed) {
      this.fail("Claude emitted a result before replay acceptance.", "providerFailure");
      return;
    }
    if (event.user_message_uuid !== undefined && event.user_message_uuid !== turn.outboundUuid) {
      this.fail("Claude result user_message_uuid did not bind the accepted FIFO input.", "providerFailure");
      return;
    }
    if (this.results.length >= MAX_RESULT_SEGMENTS) {
      this.fail(`Claude exceeded the ${MAX_RESULT_SEGMENTS}-result session bound.`, "providerFailure");
      return;
    }
    this.awaitingResult.shift();
    this.results.push(event);
    this.scheduleCompletionCheck();
  }

  private publishHandle(): void {
    if (this.handlePublished || !this.initialAccepted || !this.providerSessionId || this.failed) return;
    this.handlePublished = true;
    this.handle.activate();
    try {
      this.options.onHandleReady?.(this.handle);
    } catch (error) {
      this.fail(`Claude steering handle registration failed: ${errorMessage(error)}`, "providerFailure");
    }
  }

  private scheduleCompletionCheck(): void {
    queueMicrotask(() => {
      if (this.finished || this.failed || this.closing || !this.initialAccepted) return;
      if (this.deliveryReservations !== 0
        || this.awaitingReplay.length !== 0
        || this.awaitingResult.length !== 0
        || this.results.length === 0) {
        return;
      }
      this.closing = true;
      this.handle.markInactive();
      this.resolveReadyToClose({ kind: "complete" });
    });
  }

  private fail(message: string, code: "providerFailure" | "processExit"): void {
    if (this.finished || this.failed) return;
    this.failed = true;
    this.handle.markInactive();
    for (const turn of this.awaitingReplay.splice(0)) {
      turn.rejectReplay(new SteeringProviderError(code, turn.writeStarted, message));
    }
    this.processHandle?.terminate();
    this.resolveReadyToClose({ kind: "failed", message });
    this.resolveDone({ kind: "failed", message });
  }

  private flush(): void {
    if (this.flushed) return;
    this.flushed = true;
    this.scanner.flush((line) => this.consumeLine(line));
  }

  private removeAwaitingReplay(turn: InputTurn): void {
    const index = this.awaitingReplay.indexOf(turn);
    if (index >= 0) this.awaitingReplay.splice(index, 1);
  }
}

class ClaudeSessionHandle implements LiveActiveSteeringHandle {
  readonly capability = {
    kind: "live",
    delivery: "sameSessionNextTurn",
    protocol: CLAUDE_SESSION_PROTOCOL,
  } as const;
  private active = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly protocol: ClaudeSessionProtocol,
    private readonly binding: ClaudeSessionRunBinding,
  ) {}

  inspect(): ActiveRunInspection {
    return {
      ...this.binding,
      active: this.active,
    };
  }

  steer(
    request: SteeringProviderRequest,
    submissionGate?: MissionSubmissionGate,
  ): Promise<SteeringProviderAcknowledgement> {
    this.protocol.reserveDelivery();
    const delivered = this.tail.then(
      () => this.protocol.deliver(request, submissionGate),
      () => this.protocol.deliver(request, submissionGate),
    );
    const finalized = delivered.finally(() => this.protocol.releaseDelivery());
    this.tail = finalized.then(() => undefined, () => undefined);
    return finalized;
  }

  async close(reason: "completed" | "cancelled" | "failed"): Promise<void> {
    this.active = false;
    // Completion drains requests admitted before the result barrier. Stop and
    // failure close the provider first so a replay wait cannot delay native
    // cancellation; protocol.close rejects any unresolved delivery receipts.
    if (reason === "completed") await this.tail;
    await this.protocol.close(reason);
    if (reason !== "completed") await this.tail;
  }

  activate(): void {
    this.active = true;
  }

  markInactive(): void {
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }
}

function parseCompatibleClaudeArgs(args: readonly string[]):
  | {
      readonly kind: "supported";
      readonly values: ParsedClaudeArgs;
      readonly seenFlags: ReadonlySet<string>;
      readonly printCount: number;
    }
  | { readonly kind: "unsupported"; readonly reason: string } {
  const values: { inputFormat?: string; outputFormat?: string } = {};
  const seenFlags = new Set<string>();
  const singletonFlags = new Set<string>();
  let printCount = 0;

  for (let index = 0; index < args.length; index++) {
    const raw = args[index];
    if (raw === undefined) continue;
    if (raw === "--" || raw === "-") {
      return unsupported(`Claude session steering cannot preserve positional argument ${raw}.`);
    }
    const equal = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = equal > 0 ? raw.slice(0, equal) : raw;
    const inlineValue = equal > 0 ? raw.slice(equal + 1) : undefined;

    const incompatible = INCOMPATIBLE_FLAGS.get(flag);
    if (incompatible) {
      return unsupported(`Claude session steering cannot preserve ${flag}: ${incompatible}.`);
    }
    if (NO_VALUE_FLAGS.has(flag)) {
      if (inlineValue !== undefined) return unsupported(`Claude flag ${flag} does not take a value.`);
      if (flag === "-p" || flag === "--print") printCount++;
      if (singletonFlags.has(flag) && flag !== "--plugin-dir" && flag !== "--plugin-url") {
        return unsupported(`Claude session steering rejects duplicate flag ${flag}.`);
      }
      singletonFlags.add(flag);
      seenFlags.add(flag);
      continue;
    }
    if (SINGLE_VALUE_FLAGS.has(flag) || REPEATABLE_SINGLE_VALUE_FLAGS.has(flag)) {
      let value = inlineValue;
      if (value === undefined) {
        value = args[++index];
        if (value === undefined || looksLikeFlag(value)) {
          return unsupported(`Claude flag ${flag} is missing its value.`);
        }
      }
      if (!value) return unsupported(`Claude flag ${flag} has an empty value.`);
      if (SINGLE_VALUE_FLAGS.has(flag) && singletonFlags.has(flag)) {
        return unsupported(`Claude session steering rejects duplicate flag ${flag}.`);
      }
      singletonFlags.add(flag);
      seenFlags.add(flag);
      if (flag === "--input-format") values.inputFormat = value;
      if (flag === "--output-format") values.outputFormat = value;
      continue;
    }
    if (OPTIONAL_VALUE_FLAGS.has(flag)) {
      if (singletonFlags.has(flag)) {
        return unsupported(`Claude session steering rejects duplicate flag ${flag}.`);
      }
      singletonFlags.add(flag);
      seenFlags.add(flag);
      if (inlineValue === undefined) {
        const next = args[index + 1];
        if (next !== undefined && !looksLikeFlag(next)) index++;
      } else if (!inlineValue) {
        return unsupported(`Claude flag ${flag} has an empty value.`);
      }
      continue;
    }
    if (VARIADIC_VALUE_FLAGS.has(flag)) {
      seenFlags.add(flag);
      if (inlineValue !== undefined) {
        if (!inlineValue) return unsupported(`Claude flag ${flag} has an empty value.`);
        continue;
      }
      let valuesSeen = 0;
      while (index + 1 < args.length) {
        const next = args[index + 1];
        if (next === undefined || looksLikeFlag(next)) break;
        index++;
        valuesSeen++;
      }
      if (valuesSeen === 0) return unsupported(`Claude flag ${flag} is missing its value.`);
      continue;
    }
    if (!looksLikeFlag(raw)) {
      return unsupported(`Claude session steering cannot preserve positional prompt/command ${raw}.`);
    }
    return unsupported(`Claude session steering does not recognize argument ${raw}.`);
  }
  return { kind: "supported", values, seenFlags, printCount };
}

function requestMatchesBinding(
  request: SteeringProviderRequest,
  binding: ClaudeSessionRunBinding,
): boolean {
  if (request.schemaVersion !== STEERING_SCHEMA_VERSION
    || request.source !== "localUser"
    || request.intent !== "steer"
    || !isSteeringTargetBinding(request.target)
    || request.target.expectedDelivery !== "sameSessionNextTurn") {
    return false;
  }
  const metrics = steeringTextMetrics(request.text);
  return metrics.sha256 === request.textSha256
    && metrics.characters === request.textCharacters
    && metrics.bytes === request.textBytes
    && request.target.callId === binding.callId
    && request.target.generation === binding.generation
    && request.target.ownerId === binding.ownerId
    && request.target.missionDocumentSha256 === binding.missionDocumentSha256
    && request.target.missionBindingSha256 === binding.missionBindingSha256
    && request.target.authoritySha256 === binding.authoritySha256;
}

function rejectedAcknowledgement(
  request: SteeringProviderRequest,
  reason: string,
): SteeringProviderAcknowledgement {
  return {
    schemaVersion: STEERING_SCHEMA_VERSION,
    status: "rejected",
    steeringId: request.steeringId,
    callId: request.target.callId,
    generation: request.target.generation,
    sequence: request.target.sequence,
    textSha256: request.textSha256,
    missionDocumentSha256: request.target.missionDocumentSha256,
    missionBindingSha256: request.target.missionBindingSha256,
    delivery: "sameSessionNextTurn",
    reason,
  };
}

function aggregateClaudeStdout(
  stdout: string,
  resultEvents: readonly Record<string, unknown>[],
  accountingEvents: readonly Record<string, unknown>[],
  sessionId: string,
): string {
  if (resultEvents.length === 0 || !sessionId) return stdout;
  const withoutResults = omitTopLevelResultLines(stdout);
  const aggregate = buildAggregateResult(resultEvents, accountingEvents, sessionId);
  const state: BoundedStreamState = { text: withoutResults, truncated: false };
  let line = `${JSON.stringify(aggregate)}\n`;
  const available = Math.max(0, MAX_AGENT_STDOUT_BYTES - state.text.length);
  if (line.length > available && typeof aggregate.result === "string") {
    aggregate.result = fitJsonResultText(aggregate, available);
    line = `${JSON.stringify(aggregate)}\n`;
  }
  appendBoundedStream(
    state,
    line,
    MAX_AGENT_STDOUT_BYTES,
    OUTPUT_TRUNCATION_MARKER,
  );
  return state.text;
}

function buildAggregateResult(
  events: readonly Record<string, unknown>[],
  accountingEvents: readonly Record<string, unknown>[],
  sessionId: string,
): Record<string, unknown> {
  const last = events[events.length - 1]!;
  const firstError = events.find((event) => event.is_error === true);
  const texts = events
    .map((event) => typeof event.result === "string" ? event.result : "")
    .filter((text) => text.length > 0);
  const usageRecords = accountingEvents
    .map((event) => asRecord(event.usage))
    .filter((value): value is Record<string, unknown> => value !== undefined);
  const modelUsageRecords = accountingEvents
    .map((event) => asRecord(event.modelUsage))
    .filter((value): value is Record<string, unknown> => value !== undefined);
  const permissionDenials = accountingEvents.flatMap((event) =>
    Array.isArray(event.permission_denials) ? event.permission_denials : []
  ).slice(0, MAX_AGGREGATE_ARRAY_ITEMS);
  const errors = accountingEvents.flatMap((event) =>
    Array.isArray(event.errors) ? event.errors : []
  ).slice(0, MAX_AGGREGATE_ARRAY_ITEMS);
  const aggregate: Record<string, unknown> = {
    type: "result",
    subtype: stringField(firstError ?? last, "subtype") ?? "success",
    is_error: firstError !== undefined,
    duration_ms: sumNumericField(accountingEvents, "duration_ms"),
    duration_api_ms: sumNumericField(accountingEvents, "duration_api_ms"),
    num_turns: sumNumericField(accountingEvents, "num_turns"),
    session_id: sessionId,
    total_cost_usd: sumNumericField(accountingEvents, "total_cost_usd"),
    usage: mergeNumericRecords(usageRecords),
    modelUsage: mergeModelUsage(modelUsageRecords),
    permission_denials: permissionDenials,
    stop_reason: last.stop_reason ?? null,
    terminal_reason: last.terminal_reason ?? null,
    uuid: randomUUID(),
  };
  if (!firstError) aggregate.result = texts.join("\n\n");
  if (errors.length > 0) aggregate.errors = errors;
  if (last.api_error_status !== undefined) aggregate.api_error_status = last.api_error_status;
  if (last.fast_mode_state !== undefined) aggregate.fast_mode_state = last.fast_mode_state;
  return aggregate;
}

function omitTopLevelResultLines(stdout: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < stdout.length) {
    const newline = stdout.indexOf("\n", cursor);
    const end = newline < 0 ? stdout.length : newline;
    const line = stdout.slice(cursor, end);
    let omit = false;
    if (line.length <= MAX_EVENT_LINE_CHARS) {
      try {
        const event = asRecord(JSON.parse(line));
        omit = event?.type === "result"
          && (event.parent_tool_use_id === undefined || event.parent_tool_use_id === null);
      } catch {
        // Successful protocol completion cannot contain malformed lines, but
        // preserving an unexpected diagnostic is safer than deleting it.
      }
    }
    if (!omit) output += line + (newline < 0 ? "" : "\n");
    cursor = newline < 0 ? stdout.length : newline + 1;
  }
  return output;
}

function fitJsonResultText(aggregate: Record<string, unknown>, maxLineChars: number): string {
  const original = typeof aggregate.result === "string" ? aggregate.result : "";
  if (!original || maxLineChars <= 0) return "";
  let low = 0;
  let high = original.length;
  const suffix = "\n[Hydra: aggregate result text truncated]";
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    aggregate.result = original.slice(0, middle) + suffix;
    const length = JSON.stringify(aggregate).length + 1;
    if (length <= maxLineChars) low = middle;
    else high = middle - 1;
  }
  aggregate.result = original.slice(0, low) + (low < original.length ? suffix : "");
  return String(aggregate.result);
}

function mergeModelUsage(
  records: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const byModel = new Map<string, Record<string, unknown>[]>();
  for (const record of records) {
    for (const [model, value] of Object.entries(record)) {
      const usage = asRecord(value);
      if (!usage) continue;
      if (!byModel.has(model) && byModel.size >= 64) continue;
      const list = byModel.get(model) ?? [];
      list.push(usage);
      byModel.set(model, list);
    }
  }
  return Object.fromEntries(
    [...byModel.entries()].map(([model, values]) => [model, mergeModelUsageRecords(values)]),
  );
}

function mergeModelUsageRecords(
  records: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const additive = new Set([
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "webSearchRequests",
    "costUSD",
  ]);
  const gauges = new Set(["contextWindow", "maxOutputTokens"]);
  const keys = new Set(records.flatMap((record) => Object.keys(record)));
  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    const values = records.map((record) => record[key]).filter((value) => value !== undefined);
    if (values.length === 0) continue;
    if (additive.has(key) && values.every(isFiniteNonNegativeNumber)) {
      merged[key] = safeSum(values);
    } else if (gauges.has(key) && values.every(isFiniteNonNegativeNumber)) {
      merged[key] = Math.max(...values);
    } else {
      merged[key] = values[values.length - 1];
    }
  }
  return merged;
}

function mergeNumericRecords(
  records: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const keys = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (keys.size >= 256 && !keys.has(key)) continue;
      keys.add(key);
    }
  }
  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    const values = records.map((record) => record[key]).filter((value) => value !== undefined);
    if (values.length === 0) continue;
    if (values.every((value) => isFiniteNonNegativeNumber(value))) {
      merged[key] = safeSum(values as number[]);
      continue;
    }
    const nested = values.map(asRecord).filter(
      (value): value is Record<string, unknown> => value !== undefined,
    );
    if (nested.length === values.length) {
      merged[key] = mergeNumericRecords(nested);
      continue;
    }
    if (values.every(Array.isArray)) {
      merged[key] = (values as unknown[][]).flat().slice(0, MAX_AGGREGATE_ARRAY_ITEMS);
      continue;
    }
    merged[key] = values[values.length - 1];
  }
  return merged;
}

function sumNumericField(records: readonly Record<string, unknown>[], key: string): number {
  return safeSum(records.map((record) => record[key]).filter(isFiniteNonNegativeNumber));
}

function safeSum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  }
  return total;
}

function validateRunOptions(options: ClaudeSessionRunOptions): void {
  for (const [label, value] of [
    ["call ID", options.binding.callId],
    ["generation", options.binding.generation],
    ["owner ID", options.binding.ownerId],
  ] as const) {
    if (!isBoundedIdentifier(value)) throw new Error(`Claude session ${label} is invalid.`);
  }
  if (!isMissionBindingPair(
    options.binding.missionDocumentSha256,
    options.binding.missionBindingSha256,
  ) || !isSha256(options.binding.authoritySha256)) {
    throw new Error("Claude session Mission document/binding or authority hashes are invalid.");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new Error("Claude session timeout must be a non-negative finite number.");
  }
}

function readCapabilities(value: unknown): Set<string> | undefined {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) return undefined;
  const result = new Set<string>();
  for (const capability of value) {
    if (!isBoundedIdentifier(capability) || result.has(capability)) return undefined;
    result.add(capability);
  }
  return result;
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const left = parseClaudeVersion(actual);
  const right = parseClaudeVersion(minimum);
  if (!left || !right || left.prerelease) return false;
  for (let index = 0; index < 3; index++) {
    const leftPart = left.parts[index] ?? 0;
    const rightPart = right.parts[index] ?? 0;
    if (leftPart !== rightPart) return leftPart > rightPart;
  }
  return true;
}

function parseClaudeVersion(value: string):
  | { readonly parts: readonly [number, number, number]; readonly prerelease: boolean }
  | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return undefined;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (parts.some((part) => !Number.isSafeInteger(part))) return undefined;
  return { parts, prerelease: match[4] !== undefined };
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function appendDiagnostic(stderr: string, diagnostic: string): string {
  const prefix = stderr && !stderr.endsWith("\n") ? "\n" : "";
  return `${stderr}${prefix}${diagnostic}\n`;
}

function unsupported(reason: string): { readonly kind: "unsupported"; readonly reason: string } {
  return { kind: "unsupported", reason };
}

function looksLikeFlag(value: string): boolean {
  return value.startsWith("-");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isBoundedRecord(value: unknown, maxKeys = 256): value is Record<string, unknown> {
  const record = asRecord(value);
  return record !== undefined && Object.keys(record).length <= maxKeys;
}

function isBoundedModelUsage(value: unknown): value is Record<string, unknown> {
  const record = asRecord(value);
  if (!record || Object.keys(record).length > 64) return false;
  const numericFields = [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "webSearchRequests",
    "costUSD",
    "contextWindow",
    "maxOutputTokens",
  ] as const;
  return Object.values(record).every((candidate) => {
    const usage = asRecord(candidate);
    if (!usage || Object.keys(usage).length > 64) return false;
    return numericFields.every((field) =>
      usage[field] === undefined || isFiniteNonNegativeNumber(usage[field])
    );
  });
}

function isPermissionDenials(value: unknown): value is unknown[] {
  return Array.isArray(value)
    && value.length <= MAX_AGGREGATE_ARRAY_ITEMS
    && value.every((candidate) => {
      const denial = asRecord(candidate);
      return denial !== undefined
        && typeof denial.tool_name === "string"
        && denial.tool_name.length > 0
        && typeof denial.tool_use_id === "string"
        && denial.tool_use_id.length > 0
        && isBoundedRecord(denial.tool_input);
    });
}

function objectField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  return asRecord(record[key]);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] as string : undefined;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_AGGREGATE_ARRAY_ITEMS
    && value.every((item) => typeof item === "string");
}

function readResultOriginKind(value: unknown): "human" | "synthetic" | "invalid" {
  if (value === undefined) return "human";
  const origin = asRecord(value);
  if (!origin || typeof origin.kind !== "string") return "invalid";
  if (origin.kind === "human" && Object.keys(origin).length === 1) return "human";
  if (origin.kind === "task-notification"
    || origin.kind === "coordinator"
    || origin.kind === "auto-continuation"
    || origin.kind === "observer-activity") {
    return "synthetic";
  }
  if (origin.kind === "observer") {
    return typeof origin.from === "string"
      && origin.from.length > 0
      && typeof origin.senderTaskId === "string"
      && origin.senderTaskId.length > 0
      ? "synthetic"
      : "invalid";
  }
  if (origin.kind === "channel") {
    return typeof origin.server === "string" && origin.server.length > 0 ? "synthetic" : "invalid";
  }
  if (origin.kind === "peer") {
    return typeof origin.from === "string" && origin.from.length > 0 ? "synthetic" : "invalid";
  }
  return "invalid";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
