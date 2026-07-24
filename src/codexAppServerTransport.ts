import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AgentSpawn, RunResult } from "./agents";
import { BoundedLineScanner } from "./fileQueue";
import { startPersistentAgentProcess, type PersistentAgentProcess } from "./persistentAgentProcess";
import {
  STEERING_SCHEMA_VERSION,
  isBoundedIdentifier,
  isMissionBindingPair,
  isSha256,
  sha256Utf8,
  type SteeringProviderAcknowledgement,
  type SteeringProviderRequest,
} from "./steeringProtocol";
import {
  MISSION_SUBMISSION_WRITTEN,
  MissionSubmissionRejectedError,
  SubmissionCancelledBeforeWriteError,
  type MissionSubmissionPoint,
  type MissionSubmissionGate,
} from "./missionDispatch";
import {
  SteeringProviderError,
  type ActiveRunInspection,
  type LiveActiveSteeringHandle,
} from "./steeringController";

const APP_SERVER_PROTOCOL = "codex-app-server-v2/turn-steer";
const MAX_RPC_LINE_CHARS = 1_000_000;
const MAX_PENDING_RPC_REQUESTS = 64;
const NEGOTIATION_TIMEOUT_MS = 30_000;
const INTERRUPT_GRACE_MS = 400;

type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexAppServerPlan {
  readonly spawn: AgentSpawn;
  readonly threadStartParams: {
    readonly cwd: string;
    readonly approvalPolicy: "never";
    readonly sandbox: CodexSandboxMode;
    readonly ephemeral: boolean;
    readonly model?: string;
  };
  readonly expected: {
    readonly cwd: string;
    readonly sandbox: CodexSandboxMode;
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly workspaceWriteNetworkAccess?: boolean;
  };
}

export type CodexAppServerPlanResult =
  | { readonly kind: "supported"; readonly plan: CodexAppServerPlan }
  | { readonly kind: "unsupported"; readonly reason: string };

export interface CodexAppServerRunBinding {
  readonly callId: string;
  readonly generation: string;
  readonly ownerId: string;
  readonly missionDocumentSha256: string | null;
  readonly missionBindingSha256: string;
  readonly authoritySha256: string;
}

export interface CodexAppServerRunOptions {
  readonly plan: CodexAppServerPlan;
  readonly prompt: string;
  readonly timeoutMs: number;
  /** Absolute wall-clock deadline captured once for the whole promoted run. */
  readonly timeoutDeadlineMs?: number;
  readonly signal: AbortSignal;
  readonly binding: CodexAppServerRunBinding;
  readonly onChunk: (chunk: string) => void;
  readonly onHandleReady?: (handle: LiveActiveSteeringHandle) => void;
  /** Mission lease gate used only for turn/start and turn/steer writes. */
  readonly submissionGate?: MissionSubmissionGate;
}

/**
 * A pre-model compatibility failure. The caller may safely use the original
 * one-shot invocation because no `turn/start` request was sent.
 */
export class CodexAppServerFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppServerFallbackError";
  }
}

/**
 * Map a known `codex exec` invocation onto App Server without weakening or
 * silently changing authority. Unknown and non-equivalent flags stay on the
 * existing one-shot transport.
 */
export function planCodexAppServer(spawn: AgentSpawn): CodexAppServerPlanResult {
  const args = spawn.args;
  if (args[0] !== "exec") {
    return { kind: "unsupported", reason: "Only codex exec invocations can use App Server steering." };
  }

  let sandbox: CodexSandboxMode | undefined;
  let cwd = spawn.cwd;
  let model: string | undefined;
  let ephemeral = false;
  let reasoningEffort: string | undefined;
  let workspaceWriteNetworkAccess: boolean | undefined;
  const appServerConfigArgs: string[] = [];

  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "-") continue;
    if (arg === "--skip-git-repo-check" || arg === "--json") continue;
    if (arg === "--ephemeral") {
      ephemeral = true;
      continue;
    }
    if (arg === "--color") {
      const value = args[++index];
      if (value === undefined) return unsupported(`Missing value for ${arg}.`);
      if (value !== "always" && value !== "never" && value !== "auto") {
        return unsupported(`Unsupported Codex color value: ${value}.`);
      }
      continue;
    }
    if (arg === "--output-last-message") {
      const value = args[++index];
      if (value === undefined) return unsupported(`Missing value for ${arg}.`);
      return unsupported(
        "Codex App Server steering cannot preserve --output-last-message file output.",
      );
    }
    if (arg === "--sandbox" || arg === "-s") {
      const value = args[++index];
      if (!isSandboxMode(value)) return unsupported(`Unsupported Codex sandbox value: ${String(value)}.`);
      sandbox = value;
      continue;
    }
    if (arg === "--cd" || arg === "-C") {
      const value = args[++index];
      if (!value) return unsupported(`Missing value for ${arg}.`);
      cwd = path.resolve(spawn.cwd, value);
      continue;
    }
    if (arg === "--model" || arg === "-m") {
      const value = args[++index];
      if (!value) return unsupported(`Missing value for ${arg}.`);
      model = value;
      continue;
    }
    if (arg === "--config" || arg === "-c") {
      const value = args[++index];
      if (!value) return unsupported(`Missing value for ${arg}.`);
      appServerConfigArgs.push("-c", value);
      const effort = /^model_reasoning_effort=(.+)$/.exec(value)?.[1];
      if (effort) reasoningEffort = stripTomlString(effort);
      const network = /^sandbox_workspace_write\.network_access=(true|false)$/.exec(value)?.[1];
      if (network) workspaceWriteNetworkAccess = network === "true";
      continue;
    }
    // App Server is intentionally not promoted for review/resume, images,
    // profiles, local providers, extra roots, ignored rules/config, output
    // schemas, dangerous bypasses, or any future flag Hydra has not mapped.
    return unsupported(`Codex App Server steering cannot preserve argument ${arg}.`);
  }

  if (!sandbox) {
    return unsupported("Codex App Server steering requires an explicit sandbox mode.");
  }
  if (!path.isAbsolute(cwd)) {
    return unsupported("Codex App Server steering requires an absolute working directory.");
  }

  return {
    kind: "supported",
    plan: {
      spawn: {
        command: spawn.command,
        args: [...appServerConfigArgs, "app-server", "--listen", "stdio://"],
        cwd,
        env: spawn.env,
        stdin: "",
      },
      threadStartParams: {
        cwd,
        approvalPolicy: "never",
        sandbox,
        // Match codex exec's session persistence flag exactly. Hydra still
        // starts a fresh App Server thread per call and never reuses it
        // implicitly.
        ephemeral,
        ...(model ? { model } : {}),
      },
      expected: {
        cwd,
        sandbox,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(workspaceWriteNetworkAccess !== undefined ? { workspaceWriteNetworkAccess } : {}),
      },
    },
  };
}

/**
 * Run one Codex App Server thread/turn and expose its exact active turn as a
 * SteeringController handle. Output is translated to the existing
 * `codex exec --json` grammar so Hydra's live-text, trace, and usage paths do
 * not gain a second provider-specific parser.
 */
export async function runCodexAppServerTurn(options: CodexAppServerRunOptions): Promise<RunResult> {
  validateRunBinding(options.binding);
  const childAbort = new AbortController();
  let timedOut = false;
  let modelRequestSubmitted = false;
  let turnStarted = false;
  let completionSeen = false;
  let terminalTurnStatus: string | undefined;
  let threadId = "";
  let turnId = "";
  let handle: CodexAppServerHandle | undefined;
  const syntheticStdout: string[] = [];
  let shutdownStarted = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let processHandle!: PersistentAgentProcess;

  const emit = (event: unknown): void => {
    const line = `${JSON.stringify(event)}\n`;
    syntheticStdout.push(line);
    options.onChunk(line);
  };

  const rpc = new JsonLineRpcClient(
    async (line) => processHandle.write(`${line}\n`),
    (notification) => {
      const method = stringField(notification, "method");
      const params = objectField(notification, "params");
      if (!method || !params) return;
      if (method !== "thread/started" && (!threadId || !turnId)) {
        rpc.deferNotification(notification);
        return;
      }
      if (method === "thread/started") {
        const thread = objectField(params, "thread");
        const id = thread && stringField(thread, "id");
        if (id) emit({ type: "thread.started", thread_id: id });
        return;
      }
      if (method === "turn/started") {
        const notificationThreadId = stringField(params, "threadId");
        const turn = objectField(params, "turn");
        const notificationTurnId = turn && stringField(turn, "id");
        if (notificationThreadId === threadId && notificationTurnId === turnId) {
          emit({ type: "turn.started" });
        }
        return;
      }
      if (method === "item/started" || method === "item/completed") {
        if (!matchesActiveTurn(params, threadId, turnId)) return;
        const item = objectField(params, "item");
        let translated = item && translateAppServerItem(item);
        if (method === "item/completed" && translated?.type === "agent_message") {
          const itemId = stringField(translated, "id");
          const completedText = stringField(translated, "text") ?? "";
          if (itemId) {
            if (completedText) {
              rpc.discardAgentMessageText(itemId);
            } else {
              translated = {
                ...translated,
                text: rpc.takeAgentMessageText(itemId),
              };
            }
          }
        }
        if (translated) emit({ type: method === "item/started" ? "item.started" : "item.completed", item: translated });
        return;
      }
      if (method === "item/agentMessage/delta") {
        if (!matchesActiveTurn(params, threadId, turnId)) return;
        const itemId = stringField(params, "itemId");
        const delta = stringField(params, "delta");
        if (!itemId || delta === undefined) return;
        rpc.appendAgentMessageDelta(itemId, delta);
        // App Server sends true deltas. Forward a live-only delta envelope so
        // the webview can stream without materializing and serializing the
        // full cumulative message after every token. The canonical captured
        // stdout receives the terminal item.completed snapshot instead.
        options.onChunk(`${JSON.stringify({
          type: "item.delta",
          item: { id: itemId, type: "agent_message", delta },
        })}\n`);
        return;
      }
      if (method === "thread/tokenUsage/updated") {
        if (!matchesActiveTurn(params, threadId, turnId)) return;
        const tokenUsage = objectField(params, "tokenUsage");
        const total = tokenUsage && objectField(tokenUsage, "total");
        if (total) rpc.setLatestUsage(total);
        return;
      }
      if (method === "turn/completed") {
        const notificationThreadId = stringField(params, "threadId");
        const turn = objectField(params, "turn");
        if (notificationThreadId !== threadId || !turn || stringField(turn, "id") !== turnId) return;
        completionSeen = true;
        handle?.markInactive();
        const status = stringField(turn, "status");
        terminalTurnStatus = status;
        if (status === "completed") {
          emit({ type: "turn.completed", usage: translateUsage(rpc.latestUsage()) });
        } else {
          const error = objectField(turn, "error");
          emit({
            type: "turn.failed",
            error: { message: stringField(error, "message") ?? `Codex turn ${status ?? "failed"}.` },
          });
        }
        rpc.resolveCompletion();
      }
    },
  );

  const startShutdown = async (reason: "abort" | "timeout" | "complete"): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    if (turnStarted && !completionSeen && threadId && turnId) {
      try {
        await Promise.race([
          rpc.request("turn/interrupt", { threadId, turnId }),
          delay(INTERRUPT_GRACE_MS),
        ]);
      } catch {
        // Process-tree termination below is the fail-closed backstop.
      }
    }
    if (reason === "complete") {
      await processHandle.endInput();
    } else {
      childAbort.abort();
    }
  };

  processHandle = startPersistentAgentProcess(
    options.plan.spawn,
    0,
    (chunk) => rpc.push(chunk),
    childAbort.signal,
  );

  const abortListener = (): void => {
    void startShutdown("abort");
  };
  if (options.signal.aborted) abortListener();
  else options.signal.addEventListener("abort", abortListener, { once: true });
  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    const remaining = options.timeoutDeadlineMs === undefined
      ? options.timeoutMs
      : Math.max(1, options.timeoutDeadlineMs - Date.now());
    timeout = setTimeout(() => {
      timedOut = true;
      void startShutdown("timeout");
    }, remaining);
  }

  const processExit = processHandle.result.then((result) => {
    rpc.failAll(new Error(`Codex App Server exited before the protocol completed (exit ${String(result.exitCode)}).`));
    return result;
  });

  try {
    const initialized = await protocolStep(
      rpc.request("initialize", {
        clientInfo: { name: "hydra-agents", title: "Hydra Agents", version: "0.7.1" },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      }),
      processExit,
      NEGOTIATION_TIMEOUT_MS,
      "Codex App Server initialize failed.",
    );
    if (!isInitializeResult(initialized)) {
      throw new CodexAppServerFallbackError("Codex App Server returned an incompatible initialize response.");
    }
    if (!supportsRequiredAppServerVersion(initialized.userAgent)) {
      throw new CodexAppServerFallbackError(
        "Codex App Server is older than Hydra's verified turn/steer schema (0.144.1).",
      );
    }
    await rpc.notify("initialized", {});

    const threadResponse = await protocolStep(
      rpc.request("thread/start", options.plan.threadStartParams),
      processExit,
      NEGOTIATION_TIMEOUT_MS,
      "Codex App Server thread negotiation failed.",
    );
    const validatedThread = validateThreadStartResponse(threadResponse, options.plan);
    if (!validatedThread) {
      throw new CodexAppServerFallbackError(
        "Codex App Server did not preserve the requested model, cwd, approval policy, and sandbox.",
      );
    }
    threadId = validatedThread.threadId;

    modelRequestSubmitted = true;
    const turnResponse = await protocolStep(
      rpc.request("turn/start", {
        threadId,
        clientUserMessageId: `hydra-initial-${randomUUID()}`,
        input: [textInput(options.prompt)],
      }, options.submissionGate, "codex.turnStart", options.signal),
      processExit,
      NEGOTIATION_TIMEOUT_MS,
      "Codex App Server turn start failed.",
    );
    const startedTurnId = readTurnStartId(turnResponse);
    if (!startedTurnId) {
      throw new Error("Codex App Server returned a malformed turn/start response after accepting the model request.");
    }
    turnId = startedTurnId;
    turnStarted = true;
    handle = new CodexAppServerHandle({
      rpc,
      threadId,
      turnId,
      binding: options.binding,
      signal: options.signal,
    });
    options.onHandleReady?.(handle);
    rpc.flushDeferredNotifications();

    await Promise.race([
      rpc.completion(),
      processExit.then(() => {
        throw new Error("Codex App Server exited before turn/completed.");
      }),
    ]);
    await startShutdown("complete");
    const rawResult = await processExit;
    return {
      ...rawResult,
      stdout: syntheticStdout.join(""),
      exitCode: terminalTurnStatus && terminalTurnStatus !== "completed"
        ? (rawResult.exitCode === null ? null : 1)
        : rawResult.exitCode,
      timedOut,
      cancelled: options.signal.aborted && !timedOut,
      timeoutMs: options.timeoutMs,
    };
  } catch (error) {
    handle?.markInactive();
    if (
      error instanceof MissionSubmissionRejectedError
      || error instanceof SubmissionCancelledBeforeWriteError
    ) {
      await startShutdown("abort");
      await processExit;
      throw error;
    }
    if (!modelRequestSubmitted && error instanceof CodexAppServerFallbackError) {
      await startShutdown("abort");
      await processExit;
      throw error;
    }
    if (!modelRequestSubmitted) {
      await startShutdown("abort");
      await processExit;
      throw new CodexAppServerFallbackError(error instanceof Error ? error.message : String(error));
    }
    await startShutdown(options.signal.aborted ? "abort" : timedOut ? "timeout" : "abort");
    const rawResult = await processExit;
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...rawResult,
      stdout: syntheticStdout.join(""),
      stderr: [rawResult.stderr, message].filter(Boolean).join("\n"),
      exitCode: rawResult.exitCode === 0 ? 1 : rawResult.exitCode,
      timedOut,
      cancelled: options.signal.aborted && !timedOut,
      deliveryUnknown: !options.signal.aborted && !timedOut,
      timeoutMs: options.timeoutMs,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal.removeEventListener("abort", abortListener);
    handle?.markInactive();
  }
}

interface CodexAppServerHandleOptions {
  readonly rpc: JsonLineRpcClient;
  readonly threadId: string;
  readonly turnId: string;
  readonly binding: CodexAppServerRunBinding;
  readonly signal: AbortSignal;
}

class CodexAppServerHandle implements LiveActiveSteeringHandle {
  readonly capability = {
    kind: "live",
    delivery: "sameTurn",
    protocol: APP_SERVER_PROTOCOL,
  } as const;
  private active = true;

  constructor(private readonly options: CodexAppServerHandleOptions) {}

  inspect(): ActiveRunInspection {
    return {
      ...this.options.binding,
      active: this.active,
    };
  }

  async steer(
    request: SteeringProviderRequest,
    submissionGate?: MissionSubmissionGate,
  ): Promise<SteeringProviderAcknowledgement> {
    if (!this.active) {
      throw new SteeringProviderError("processExit", false, "The Codex turn is no longer active.");
    }
    if (!requestMatchesBinding(request, this.options.binding)) {
      return rejectedAcknowledgement(request, "sameTurn", "The steering request does not match this Codex run binding.");
    }
    let response: unknown;
    try {
      response = await this.options.rpc.request("turn/steer", {
        threadId: this.options.threadId,
        expectedTurnId: this.options.turnId,
        clientUserMessageId: `hydra-steer-${request.steeringId}-${request.target.sequence}`,
        input: [textInput(request.text)],
      }, submissionGate, "codex.turnSteer", this.options.signal);
    } catch (error) {
      if (error instanceof MissionSubmissionRejectedError) throw error;
      throw new SteeringProviderError(
        "providerFailure",
        true,
        error instanceof Error ? error.message : String(error),
      );
    }
    const result = asRecord(response);
    if (!result || stringField(result, "turnId") !== this.options.turnId) {
      throw new SteeringProviderError(
        "providerFailure",
        true,
        "Codex returned a malformed or stale turn/steer acknowledgement.",
      );
    }
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
      delivery: "sameTurn",
      providerReceiptSha256: sha256Utf8(JSON.stringify({
        protocol: APP_SERVER_PROTOCOL,
        threadId: this.options.threadId,
        expectedTurnId: this.options.turnId,
        returnedTurnId: result.turnId,
        clientUserMessageId: `hydra-steer-${request.steeringId}-${request.target.sequence}`,
        missionDocumentSha256: request.target.missionDocumentSha256,
        missionBindingSha256: request.target.missionBindingSha256,
      })),
    };
  }

  async close(reason: "completed" | "cancelled" | "failed"): Promise<void> {
    const wasActive = this.active;
    this.active = false;
    if (wasActive && reason === "cancelled") {
      try {
        await this.options.rpc.request("turn/interrupt", {
          threadId: this.options.threadId,
          turnId: this.options.turnId,
        });
      } catch {
        // The process lifecycle owns the forceful termination backstop.
      }
    }
  }

  markInactive(): void {
    this.active = false;
  }
}

class JsonLineRpcClient {
  private readonly scanner = new BoundedLineScanner({
    maxLineChars: MAX_RPC_LINE_CHARS,
    headLinesPerPush: 2_048,
    tailLinesPerPush: 512,
  });
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly messageText = new Map<string, string[]>();
  private readonly deferredNotifications: Record<string, unknown>[] = [];
  private nextId = 1;
  private completionPromise: Promise<void>;
  private resolveCompleted!: () => void;
  private rejectCompleted!: (error: Error) => void;
  private latestUsageValue: Record<string, unknown> | undefined;

  constructor(
    private readonly sendLine: (line: string) => Promise<void>,
    private readonly onNotification: (notification: Record<string, unknown>) => void,
  ) {
    this.completionPromise = new Promise<void>((resolve, reject) => {
      this.resolveCompleted = resolve;
      this.rejectCompleted = reject;
    });
    // Negotiation can fail before the run begins awaiting completion. Keep a
    // fail-closed process exit from becoming an unhandled rejection while
    // preserving the original promise for the normal lifecycle await.
    void this.completionPromise.catch(() => undefined);
  }

  push(chunk: string): void {
    this.scanner.push(chunk, (line) => this.consumeLine(line));
  }

  request(
    method: string,
    params: unknown,
    submissionGate?: MissionSubmissionGate,
    submissionPoint?: Extract<MissionSubmissionPoint, "codex.turnStart" | "codex.turnSteer">,
    submissionSignal?: AbortSignal,
  ): Promise<unknown> {
    if (this.pending.size >= MAX_PENDING_RPC_REQUESTS) {
      return Promise.reject(new Error("Codex App Server RPC queue is full."));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const send = () => this.sendLine(JSON.stringify({ id, method, params }));
      const submission = submissionGate && submissionPoint
        ? submissionGate.write(submissionPoint, async (): Promise<typeof MISSION_SUBMISSION_WRITTEN> => {
            if (submissionSignal?.aborted) {
              throw new SubmissionCancelledBeforeWriteError(
                `Codex ${submissionPoint} was cancelled before provider submission.`,
              );
            }
            await send();
            return MISSION_SUBMISSION_WRITTEN;
          })
        : send();
      void submission.catch((error) => {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.sendLine(JSON.stringify({ method, params }));
  }

  completion(): Promise<void> {
    return this.completionPromise;
  }

  resolveCompletion(): void {
    this.resolveCompleted();
  }

  failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.rejectCompleted(error);
  }

  appendAgentMessageDelta(itemId: string, delta: string): void {
    const chunks = this.messageText.get(itemId);
    if (chunks) {
      chunks.push(delta);
    } else {
      this.messageText.set(itemId, [delta]);
    }
  }

  takeAgentMessageText(itemId: string): string {
    const chunks = this.messageText.get(itemId);
    this.messageText.delete(itemId);
    return chunks?.join("") ?? "";
  }

  discardAgentMessageText(itemId: string): void {
    this.messageText.delete(itemId);
  }

  setLatestUsage(value: Record<string, unknown>): void {
    this.latestUsageValue = value;
  }

  latestUsage(): Record<string, unknown> | undefined {
    return this.latestUsageValue;
  }

  deferNotification(notification: Record<string, unknown>): void {
    if (this.deferredNotifications.length >= 256) {
      this.failAll(new Error("Codex App Server emitted too many pre-binding notifications."));
      return;
    }
    this.deferredNotifications.push(notification);
  }

  flushDeferredNotifications(): void {
    const deferred = this.deferredNotifications.splice(0);
    for (const notification of deferred) this.onNotification(notification);
  }

  private consumeLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.failAll(new Error("Codex App Server emitted malformed JSONL."));
      return;
    }
    const message = asRecord(parsed);
    if (!message) {
      this.failAll(new Error("Codex App Server emitted a non-object message."));
      return;
    }
    const id = rpcIdField(message, "id");
    if (typeof id === "number" && !("method" in message)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      const error = objectField(message, "error");
      if (error) {
        pending.reject(new Error(stringField(error, "message") ?? "Codex App Server request failed."));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    const method = stringField(message, "method");
    if (!method) return;
    if (id !== undefined) {
      // The steering transport has no approval/elicitation UI. Answer every
      // server request explicitly and fail closed instead of hanging it.
      void this.sendLine(JSON.stringify({
        id,
        error: {
          code: -32000,
          message: "Hydra App Server steering does not support interactive server requests.",
        },
      })).catch(() => undefined);
      return;
    }
    this.onNotification(message);
  }
}

function translateAppServerItem(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const id = stringField(item, "id");
  const type = stringField(item, "type");
  if (!id || !type) return undefined;
  switch (type) {
    case "agentMessage":
      return { id, type: "agent_message", text: stringField(item, "text") ?? "" };
    case "reasoning": {
      const summary = stringArray(item.summary);
      return { id, type: "reasoning", text: summary.join("\n") };
    }
    case "commandExecution":
      return {
        id,
        type: "command_execution",
        command: stringField(item, "command") ?? "",
        aggregated_output: stringField(item, "aggregatedOutput") ?? "",
        exit_code: nullableNumber(item.exitCode),
        status: translateStatus(stringField(item, "status")),
      };
    case "fileChange":
      return {
        id,
        type: "file_change",
        changes: Array.isArray(item.changes) ? item.changes : [],
        status: translateStatus(stringField(item, "status")),
      };
    case "mcpToolCall":
      return {
        id,
        type: "mcp_tool_call",
        server: stringField(item, "server") ?? "",
        tool: stringField(item, "tool") ?? "",
        arguments: item.arguments,
        result: item.result,
        error: item.error,
        status: translateStatus(stringField(item, "status")),
      };
    case "webSearch":
      return {
        id,
        type: "web_search",
        query: stringField(item, "query") ?? "",
        action: item.action ?? {},
      };
    case "collabAgentToolCall":
      return {
        id,
        type: "collab_tool_call",
        tool: stringField(item, "tool") ?? "wait",
        sender_thread_id: stringField(item, "senderThreadId") ?? "",
        receiver_thread_ids: stringArray(item.receiverThreadIds),
        prompt: stringField(item, "prompt"),
        agents_states: objectField(item, "agentsStates") ?? {},
        status: translateStatus(stringField(item, "status")),
      };
    default:
      return undefined;
  }
}

function translateStatus(value: string | undefined): string {
  if (value === "inProgress") return "in_progress";
  return value ?? "failed";
}

function translateUsage(value: Record<string, unknown> | undefined): Record<string, number> {
  return {
    input_tokens: nonNegativeNumber(value?.inputTokens),
    cached_input_tokens: nonNegativeNumber(value?.cachedInputTokens),
    output_tokens: nonNegativeNumber(value?.outputTokens),
    reasoning_output_tokens: nonNegativeNumber(value?.reasoningOutputTokens),
  };
}

function validateThreadStartResponse(
  value: unknown,
  plan: CodexAppServerPlan,
): { threadId: string } | undefined {
  const response = asRecord(value);
  const thread = response && objectField(response, "thread");
  const threadId = thread && stringField(thread, "id");
  const ephemeral = thread?.ephemeral;
  const cwd = response && stringField(response, "cwd");
  const model = response && stringField(response, "model");
  const approvalPolicy = response && response.approvalPolicy;
  const sandbox = response && objectField(response, "sandbox");
  if (!threadId || !cwd || path.resolve(cwd) !== path.resolve(plan.expected.cwd)) return undefined;
  if (ephemeral !== plan.threadStartParams.ephemeral) return undefined;
  if (approvalPolicy !== "never") return undefined;
  if (plan.expected.model && model !== plan.expected.model) return undefined;
  if (!sandboxMatches(sandbox, plan.expected)) return undefined;
  if (plan.expected.reasoningEffort) {
    const effort = stringField(response, "reasoningEffort");
    if (effort !== plan.expected.reasoningEffort) return undefined;
  }
  return { threadId };
}

function sandboxMatches(
  sandbox: Record<string, unknown> | undefined,
  expected: CodexAppServerPlan["expected"],
): boolean {
  if (!sandbox) return false;
  const type = stringField(sandbox, "type");
  if (expected.sandbox === "danger-full-access") return type === "dangerFullAccess";
  if (expected.sandbox === "read-only") return type === "readOnly";
  if (type !== "workspaceWrite") return false;
  if (expected.workspaceWriteNetworkAccess !== undefined
    && sandbox.networkAccess !== expected.workspaceWriteNetworkAccess) return false;
  return true;
}

function readTurnStartId(value: unknown): string | undefined {
  const response = asRecord(value);
  const turn = response && objectField(response, "turn");
  return turn && stringField(turn, "id");
}

function textInput(text: string): Record<string, unknown> {
  return { type: "text", text, text_elements: [] };
}

function requestMatchesBinding(
  request: SteeringProviderRequest,
  binding: CodexAppServerRunBinding,
): boolean {
  return request.target.callId === binding.callId
    && request.target.generation === binding.generation
    && request.target.ownerId === binding.ownerId
    && request.target.missionDocumentSha256 === binding.missionDocumentSha256
    && request.target.missionBindingSha256 === binding.missionBindingSha256
    && request.target.authoritySha256 === binding.authoritySha256;
}

function rejectedAcknowledgement(
  request: SteeringProviderRequest,
  delivery: "sameTurn",
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
    delivery,
    reason,
  };
}

function validateRunBinding(binding: CodexAppServerRunBinding): void {
  for (const [label, value] of [
    ["call ID", binding.callId],
    ["generation", binding.generation],
    ["owner ID", binding.ownerId],
  ] as const) {
    if (!isBoundedIdentifier(value)) throw new Error(`Codex App Server ${label} is invalid.`);
  }
  if (!isMissionBindingPair(binding.missionDocumentSha256, binding.missionBindingSha256)
    || !isSha256(binding.authoritySha256)) {
    throw new Error("Codex App Server Mission document/binding or authority hashes are invalid.");
  }
}

async function protocolStep(
  request: Promise<unknown>,
  processExit: Promise<RunResult>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CodexAppServerFallbackError(timeoutMessage)), timeoutMs);
  });
  try {
    return await Promise.race([
      request,
      processExit.then((result) => {
        throw new Error(`Codex App Server exited during negotiation (exit ${String(result.exitCode)}).`);
      }),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matchesActiveTurn(
  params: Record<string, unknown>,
  threadId: string,
  turnId: string,
): boolean {
  return stringField(params, "threadId") === threadId && stringField(params, "turnId") === turnId;
}

function isInitializeResult(value: unknown): value is Record<string, unknown> & { userAgent: string } {
  const result = asRecord(value);
  return !!result
    && typeof result.userAgent === "string"
    && typeof result.codexHome === "string"
    && typeof result.platformFamily === "string"
    && typeof result.platformOs === "string";
}

function supportsRequiredAppServerVersion(userAgent: string): boolean {
  const match = /\/(\d+)\.(\d+)\.(\d+)(?:\b|[-+])/u.exec(userAgent);
  if (!match) return false;
  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  const patch = Number.parseInt(match[3] ?? "", 10);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  if (major !== 0) return major > 0;
  if (minor !== 144) return minor > 144;
  return patch >= 1;
}

function unsupported(reason: string): CodexAppServerPlanResult {
  return { kind: "unsupported", reason };
}

function isSandboxMode(value: unknown): value is CodexSandboxMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

function stripTomlString(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function objectField(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  return record ? asRecord(record[key]) : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  return record && typeof record[key] === "string" ? record[key] as string : undefined;
}

function rpcIdField(record: Record<string, unknown>, key: string): string | number | undefined {
  const value = record[key];
  if (typeof value === "string" && value.length > 0 && value.length <= 256) return value;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
