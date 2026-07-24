import * as crypto from "node:crypto";
import * as path from "node:path";
import {
  runAgent,
  type AgentSpawn,
  type RunResult,
} from "./agents";
import {
  CodexAppServerFallbackError,
  planCodexAppServer,
  runCodexAppServerTurn,
  type CodexAppServerRunBinding,
} from "./codexAppServerTransport";
import {
  planClaudeSession,
  runClaudeSessionTurn,
  type ClaudeSessionRunBinding,
} from "./claudeSessionTransport";
import {
  SteeringController,
  type LiveActiveSteeringHandle,
  type SteeringTargetSelection,
} from "./steeringController";
import {
  sha256Utf8,
  type SteeringWorkClass,
} from "./steeringProtocol";

export type NativeSteeringTransport = "codexAppServer" | "claudeSession";

export interface NativeSteeringRuntimeOptions {
  readonly transport: NativeSteeringTransport;
  readonly controller: SteeringController;
  readonly spawn: AgentSpawn;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly callId: string;
  readonly agentId: string;
  readonly roomTurnId: string;
  readonly ownerId: string;
  readonly missionContractSha256: string;
  readonly workClass: SteeringWorkClass;
  readonly phaseSnapshot: string;
  readonly appendTrace: (record: Record<string, unknown>) => Promise<void>;
  readonly onRegistrationChanged: () => void;
}

/**
 * Promote a losslessly understood native invocation to its steerable provider
 * protocol. Provider lifecycle, exact-run binding, no-retry boundaries, and
 * steering-chain closure stay outside HydraRoomPanel; the panel supplies only
 * room identity and narrow UI/trace callbacks.
 */
export function createNativeSteeringRunner(
  options: NativeSteeringRuntimeOptions,
): ((onRawChunk: (chunk: string) => void) => Promise<RunResult>) | undefined {
  const codexPlan = options.transport === "codexAppServer"
    ? planCodexAppServer(options.spawn)
    : undefined;
  const claudePlan = options.transport === "claudeSession"
    ? planClaudeSession(options.spawn)
    : undefined;
  if (codexPlan?.kind === "unsupported" || claudePlan?.kind === "unsupported") {
    // Invocations that cannot be promoted losslessly keep the existing
    // one-shot adapter and are never advertised as live steering targets.
    return undefined;
  }
  if (!codexPlan && !claudePlan) return undefined;

  const generation = `generation-${crypto.randomUUID()}`;
  const binding: CodexAppServerRunBinding & ClaudeSessionRunBinding = {
    callId: options.callId,
    generation,
    ownerId: options.ownerId,
    missionContractSha256: options.missionContractSha256,
    authoritySha256: steeringAuthoritySha256(options.spawn),
  };
  const initialPromptSha256 = sha256Utf8(options.prompt);

  return async (onRawChunk) => {
    let result: RunResult | undefined;
    let selection: SteeringTargetSelection | undefined;
    const timeoutDeadlineMs = options.timeoutMs > 0
      ? Date.now() + options.timeoutMs
      : undefined;
    const onHandleReady = (handle: LiveActiveSteeringHandle): void => {
      selection = options.controller.registerRun({
        ...binding,
        agentId: options.agentId,
        roomTurnId: options.roomTurnId,
        initialPromptSha256,
        workClass: options.workClass,
        phaseSnapshot: options.phaseSnapshot,
        ...(timeoutDeadlineMs === undefined ? {} : { timeoutDeadlineMs }),
        handle,
      });
      options.onRegistrationChanged();
    };

    try {
      if (codexPlan?.kind === "supported") {
        try {
          result = await runCodexAppServerTurn({
            plan: codexPlan.plan,
            prompt: options.prompt,
            timeoutMs: options.timeoutMs,
            ...(timeoutDeadlineMs === undefined ? {} : { timeoutDeadlineMs }),
            signal: options.signal,
            binding,
            onChunk: onRawChunk,
            onHandleReady,
          });
          return result;
        } catch (error) {
          if (!(error instanceof CodexAppServerFallbackError)) throw error;
          // This error class exists only before turn/start submission. The
          // original one-shot request is safe to run once only while the
          // caller still authorizes work and the original wall-clock budget
          // has time remaining. Never submit a fresh paid request after Stop
          // or after negotiation consumed the whole deadline.
          const remainingMs = timeoutDeadlineMs === undefined
            ? undefined
            : timeoutDeadlineMs - Date.now();
          if (options.signal.aborted || (remainingMs !== undefined && remainingMs <= 0)) {
            const cancelled = options.signal.aborted;
            result = {
              stdout: "",
              stderr: cancelled
                ? "Codex App Server negotiation was cancelled before model submission; Hydra did not start a fallback request."
                : "Codex App Server negotiation exhausted the run timeout before model submission; Hydra did not start a fallback request.",
              exitCode: null,
              timedOut: !cancelled,
              cancelled,
              timeoutMs: options.timeoutMs,
            };
            return result;
          }
          const fallbackTimeout = remainingMs === undefined
            ? 0
            : Math.max(1, Math.floor(remainingMs));
          result = await runAgent(
            options.spawn,
            options.prompt,
            fallbackTimeout,
            onRawChunk,
            options.signal,
          );
          return result;
        }
      }

      if (claudePlan?.kind === "supported") {
        // Claude writes its initial stream-json request before runtime
        // capability proof arrives. Any later failure is terminal for this
        // call and must never be replayed through the one-shot adapter.
        result = await runClaudeSessionTurn({
          plan: claudePlan.plan,
          prompt: options.prompt,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          binding,
          onChunk: onRawChunk,
          onHandleReady,
        });
        return result;
      }

      throw new Error("The selected steering transport has no runnable native plan.");
    } finally {
      if (selection) {
        const reason = !result || didRunFail(result)
          ? options.signal.aborted || result?.cancelled ? "cancelled" : "failed"
          : "completed";
        // Closing acceptance is the per-run serialization barrier: it waits
        // behind any delivery already admitted before provider completion.
        // Read the chain only after that queue drains so completion evidence
        // cannot capture a pre-steer hash with a non-terminal sequence.
        await options.controller.closeRun(selection, reason).catch(() => undefined);
        try {
          const chain = options.controller.chainBinding(selection);
          await options.appendTrace({
            id: options.callId,
            event: "steeringChain",
            timestamp: new Date().toISOString(),
            agent: options.agentId,
            phase: options.phaseSnapshot,
            transport: "oneShot",
            generation,
            steeringChainSha256: chain.steeringChainSha256,
            chainIndeterminate: chain.chainIndeterminate,
            lastSequence: chain.lastSequence,
            lastTerminalSequence: chain.lastTerminalSequence,
            lastAcknowledgedSequence: chain.lastAcknowledgedSequence,
          });
        } catch {
          // The private steering ledger remains authoritative. A diagnostic
          // trace failure cannot trigger a provider retry or hide its result.
        }
        options.onRegistrationChanged();
      }
    }
  };
}

export function steeringAuthoritySha256(spawn: AgentSpawn): string {
  return sha256Utf8(JSON.stringify([
    "hydra-steering-authority-v1",
    spawn.command,
    spawn.args,
    path.resolve(spawn.cwd),
    Object.keys(spawn.env ?? {}).sort(),
  ]));
}

function didRunFail(result: RunResult): boolean {
  return !!result.terminationFailed
    || result.cancelled
    || result.timedOut
    || result.exitCode !== 0;
}
