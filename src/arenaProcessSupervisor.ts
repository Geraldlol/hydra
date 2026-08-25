import * as cp from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  isWindowsBatchCommand,
  spawnViaCmdShim,
  terminateProcessTree,
} from "./agents";
import {
  canonicalArenaManifestJson,
  type ArenaContestantFailureCode,
  type ArenaContestantTerminalStage,
  type ArenaContestantTerminalStatus,
} from "./arenaRunManifest";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INTENT_HASH_DOMAIN = "hydra.arena.process.v1.intent\u0000";
const OWNER_HASH_DOMAIN = "hydra.arena.process.v1.owner\u0000";
const SUBMISSION_HASH_DOMAIN = "hydra.arena.process.v1.submission\u0000";
const QUIESCENCE_HASH_DOMAIN = "hydra.arena.process.v1.quiescence\u0000";
const NATIVE_BROKER_CAPABILITY_HASH_DOMAIN =
  "hydra.arena.process.v1.native-broker-capability\u0000";
const NATIVE_BROKER_PROOF_HASH_DOMAIN =
  "hydra.arena.process.v1.native-broker-proof\u0000";
const INPUT_HASH_DOMAIN = "hydra.arena.process.v1.input\u0000";
const OUTPUT_HASH_DOMAIN = "hydra.arena.process.v1.output\u0000";
const ENVIRONMENT_HASH_DOMAIN = "hydra.arena.process.v1.environment\u0000";
const DIRECTORY_IDENTITY_HASH_DOMAIN =
  "hydra.arena.git.worktree-directory.v1\u0000";
const FILE_IDENTITY_HASH_DOMAIN = "hydra.arena.process.v1.file-identity\u0000";

export const ARENA_PROCESS_SCHEMA_VERSION = 1 as const;
export const ARENA_PROCESS_LIMITS = Object.freeze({
  maxArgs: 256,
  maxArgBytes: 64 * 1024,
  maxStdinBytes: 4 * 1024 * 1024,
  maxStdoutBytes: 4 * 1024 * 1024,
  maxStderrBytes: 1 * 1024 * 1024,
  maxTimeoutMs: 24 * 60 * 60 * 1_000,
  // Grace between asking a contestant tree to die and force-killing it.
  terminationGraceMs: 1_000,
  // Why this is separate and ten times longer: `close` arrives only once
  // every inherited stdio handle in the tree is released, and on a loaded
  // Windows host that lags well past a second after the force kill. Sharing
  // one grace for both steps made a slow reap look like unconfirmed
  // termination, which resolves the run deliveryUnknown and makes the
  // controller retain it - a scheduling artifact reported as a safety event.
  terminationConfirmMs: 10_000,
});

const SAFE_ENVIRONMENT_KEYS = new Set([
  "ALL_PROXY",
  "APPDATA",
  "CI",
  "COLORTERM",
  "COMSPEC",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

export interface ArenaBundledProcessHelper {
  /**
   * The exact first argv entry. Only Hydra's compiled fake-head helper may opt
   * the VS Code Electron binary into Node mode.
   */
  readonly scriptPath: string;
  readonly scriptFileIdentitySha256: string;
}

export interface ArenaNativeBrokerCapabilityInput {
  readonly adapterKind: string;
  readonly brokerId: string;
  readonly commandFileIdentitySha256: string;
  readonly platform: NodeJS.Platform;
}

export interface ArenaNativeProcessQuiescenceProof {
  readonly schemaVersion: typeof ARENA_PROCESS_SCHEMA_VERSION;
  readonly proofType: "arenaNativeProcessTreeQuiescence";
  readonly adapterKind: string;
  readonly brokerId: string;
  readonly platform: NodeJS.Platform;
  readonly capabilitySha256: string;
  readonly commandFileIdentitySha256: string;
  readonly processGenerationId: string;
  readonly processOwnerSha256: string;
  readonly terminationConfirmed: true;
  readonly activeProcessCount: 0;
  readonly proofReceiptSha256: string;
}

export interface ArenaNativeProcessBrokerBinding {
  readonly processGenerationId: string;
  readonly processOwnerSha256: string;
}

export interface ArenaNativeBrokerSpawnInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: cp.SpawnOptions;
  readonly binding: ArenaNativeProcessBrokerBinding;
}

export interface ArenaNativeBrokeredProcess {
  readonly child: cp.ChildProcess;
  /**
   * Must settle only after the adapter broker's OS containment primitive has
   * proved that the exact generation has zero active processes. A direct
   * child's `close` event is deliberately insufficient.
   */
  readonly proveQuiescence: (
    binding: ArenaNativeProcessBrokerBinding,
    signal: AbortSignal,
  ) => Promise<ArenaNativeProcessQuiescenceProof>;
}

/**
 * Capability supplied by a platform-specific adapter broker. Hydra ships no
 * implicit native capability: an adapter is admitted only when this exact
 * executable/platform binding is present and the broker later returns a
 * generation-bound zero-process proof.
 */
export interface ArenaNativeProcessQuiescenceBroker
  extends ArenaNativeBrokerCapabilityInput {
  readonly capabilitySha256: string;
  readonly spawn: (
    input: ArenaNativeBrokerSpawnInput,
  ) => ArenaNativeBrokeredProcess;
}

export interface ArenaProcessSupervisorInput {
  readonly runId: string;
  readonly contestantId: string;
  readonly traceId: string;
  readonly registrationSha256: string;
  readonly worktreeDirectoryIdentitySha256: string;
  readonly worktreePath: string;
  readonly command: string;
  readonly commandFileIdentitySha256: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly environmentPolicySha256: string;
  readonly invocationSha256: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly processGenerationId?: string;
  readonly bundledHelper?: ArenaBundledProcessHelper;
  readonly nativeAdapterKind?: string;
  readonly nativeQuiescenceBroker?: ArenaNativeProcessQuiescenceBroker;
  /**
   * Runs after OS process acceptance and before any stdin byte is written.
   * The callback must durably persist this receipt or reject; rejection stops
   * the process without attempting provider delivery.
   */
  readonly onSubmission: (
    receipt: ArenaProcessSubmissionReceipt,
  ) => void | Promise<void>;
  /**
   * Called only after the child's close event. A failure leaves the process
   * receipt valid but deliberately omits the workspace binding.
   */
  readonly postProcessFingerprintSha256?: () => string | Promise<string>;
}

export interface ArenaProcessIntentReceipt {
  readonly schemaVersion: typeof ARENA_PROCESS_SCHEMA_VERSION;
  readonly receiptType: "arenaProcessIntent";
  readonly runId: string;
  readonly contestantId: string;
  readonly traceId: string;
  readonly registrationSha256: string;
  readonly processGenerationId: string;
  readonly processOwnerSha256: string;
  readonly worktreePathSha256: string;
  readonly worktreeDirectoryIdentitySha256: string;
  readonly commandSha256: string;
  readonly commandFileIdentitySha256: string;
  readonly bundledHelperFileIdentitySha256: string | null;
  /** Present only on the new native-broker receipt variant. */
  readonly nativeAdapterKind?: string;
  /** Present only on the new native-broker receipt variant. */
  readonly nativeBrokerCapabilitySha256?: string;
  readonly argsSha256: string;
  readonly promptSha256: string;
  readonly inputSha256: string;
  readonly inputBytes: number;
  readonly environmentPolicySha256: string;
  readonly invocationSha256: string;
  readonly timeoutMs: number;
  readonly intentSha256: string;
}

export interface ArenaProcessSubmissionReceipt {
  readonly schemaVersion: typeof ARENA_PROCESS_SCHEMA_VERSION;
  readonly receiptType: "arenaProcessSubmission";
  readonly runId: string;
  readonly contestantId: string;
  readonly traceId: string;
  readonly registrationSha256: string;
  readonly processGenerationId: string;
  readonly processOwnerSha256: string;
  readonly intentSha256: string;
  readonly submissionReceiptSha256: string;
}

export interface ArenaProcessQuiescenceReceipt {
  readonly schemaVersion: typeof ARENA_PROCESS_SCHEMA_VERSION;
  readonly receiptType: "arenaProcessQuiescence";
  readonly runId: string;
  readonly contestantId: string;
  readonly traceId: string;
  readonly registrationSha256: string;
  readonly processGenerationId: string;
  readonly processOwnerSha256: string;
  readonly intentSha256: string;
  readonly submissionReceiptSha256: string;
  readonly proof:
    | "bundledFakeHeadNoDescendants"
    | "nativeAdapterProcessTreeBroker";
  /** Native-broker proof fields are absent on byte-compatible Stage-3 receipts. */
  readonly adapterKind?: string;
  readonly brokerCapabilitySha256?: string;
  readonly brokerReceiptSha256?: string;
  readonly terminationConfirmed: true;
  readonly activeProcessCount: 0;
  readonly finalWorkspaceFingerprintSha256: string;
  readonly quiescenceReceiptSha256: string;
}

export interface ArenaProcessStreamMetadata {
  readonly bytes: number;
  readonly sha256: string;
  /**
   * False only when Hydra returned without observing the stream close.
   * Output limits stop the process instead of retaining unbounded content.
   */
  readonly complete: boolean;
  readonly exceededLimit: boolean;
  readonly fullByteCountKnown: boolean;
}

export interface ArenaProcessOutputMetadata {
  readonly bytes: number;
  readonly sha256: string;
}

export type ArenaProcessDiagnosticCode =
  | "none"
  | "preDispatchCancelled"
  | "spawnRejected"
  | "stdinWriteFailed"
  | "submissionPersistenceFailed"
  | "stdoutLimitExceeded"
  | "stderrLimitExceeded"
  | "processError"
  | "postProcessFingerprintFailed"
  | "terminationUnconfirmed";

export interface ArenaSupervisedProcessResult {
  readonly runId: string;
  readonly contestantId: string;
  readonly processGenerationId: string;
  readonly processOwnerSha256: string;
  readonly intent: ArenaProcessIntentReceipt;
  readonly intentSha256: string;
  readonly submission: ArenaProcessSubmissionReceipt | null;
  readonly submissionReceiptSha256: string | null;
  readonly quiescence: ArenaProcessQuiescenceReceipt | null;
  readonly quiescenceReceiptSha256: string | null;
  readonly quiescenceWorkspaceFingerprintSha256: string | null;
  readonly terminationConfirmed: boolean;
  readonly stage: ArenaContestantTerminalStage;
  readonly traceId: string | null;
  readonly status: ArenaContestantTerminalStatus;
  readonly failureCode: ArenaContestantFailureCode | null;
  readonly exitCode: number | null;
  readonly stdout: ArenaProcessStreamMetadata;
  readonly stderr: ArenaProcessStreamMetadata;
  readonly output: ArenaProcessOutputMetadata;
  readonly outputSha256: string;
  readonly outputBytes: number;
  readonly diagnosticCode: ArenaProcessDiagnosticCode;
}

export interface ArenaProcessSupervisorDependencies {
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: cp.SpawnOptions,
  ) => cp.ChildProcess;
  readonly terminateProcess?: (
    child: cp.ChildProcess,
    force: boolean,
  ) => Promise<boolean>;
  readonly createProcessGenerationId?: () => string;
  readonly terminationGraceMs?: number;
  readonly terminationConfirmMs?: number;
}

interface ValidatedSupervisorInput extends ArenaProcessSupervisorInput {
  readonly args: readonly string[];
  readonly processGenerationId: string;
  /** Authenticated canonical cwd used for the native spawn. */
  readonly spawnWorktreePath: string;
  /**
   * Authenticated native invocation path. Bundled Electron helpers must use
   * the exact path that bootstrapped the current extension host; other
   * commands execute through their canonical target.
   */
  readonly spawnCommand: string;
  /** Canonical authenticated arguments used for the eventual process spawn. */
  readonly spawnArgs: readonly string[];
  readonly spawnEnvironment: NodeJS.ProcessEnv;
}

export function arenaNativeBrokerCapabilitySha256(
  input: ArenaNativeBrokerCapabilityInput,
): string {
  assertIdentifier(input.adapterKind, "native broker adapterKind");
  assertIdentifier(input.brokerId, "native broker brokerId");
  assertSha256(
    input.commandFileIdentitySha256,
    "native broker commandFileIdentitySha256",
  );
  assertSupportedPlatform(input.platform, "native broker platform");
  return hashCanonical(NATIVE_BROKER_CAPABILITY_HASH_DOMAIN, {
    adapterKind: input.adapterKind,
    brokerId: input.brokerId,
    commandFileIdentitySha256: input.commandFileIdentitySha256,
    platform: input.platform,
  });
}

export function createArenaNativeProcessQuiescenceProof(
  input: ArenaNativeBrokerCapabilityInput & {
    readonly capabilitySha256: string;
    readonly processGenerationId: string;
    readonly processOwnerSha256: string;
  },
): ArenaNativeProcessQuiescenceProof {
  const expectedCapability = arenaNativeBrokerCapabilitySha256(input);
  if (input.capabilitySha256 !== expectedCapability) {
    throw new Error(
      "Arena native broker capability does not match its adapter, platform, and executable binding.",
    );
  }
  assertIdentifier(input.processGenerationId, "native proof processGenerationId");
  assertSha256(input.processOwnerSha256, "native proof processOwnerSha256");
  const withoutHash = {
    schemaVersion: ARENA_PROCESS_SCHEMA_VERSION,
    proofType: "arenaNativeProcessTreeQuiescence" as const,
    adapterKind: input.adapterKind,
    brokerId: input.brokerId,
    platform: input.platform,
    capabilitySha256: input.capabilitySha256,
    commandFileIdentitySha256: input.commandFileIdentitySha256,
    processGenerationId: input.processGenerationId,
    processOwnerSha256: input.processOwnerSha256,
    terminationConfirmed: true as const,
    activeProcessCount: 0 as const,
  };
  return Object.freeze({
    ...withoutHash,
    proofReceiptSha256: hashCanonical(
      NATIVE_BROKER_PROOF_HASH_DOMAIN,
      withoutHash,
    ),
  });
}

function validateNativeQuiescenceProof(
  proof: ArenaNativeProcessQuiescenceProof,
  broker: ArenaNativeProcessQuiescenceBroker,
  intent: ArenaProcessIntentReceipt,
): void {
  const expected = createArenaNativeProcessQuiescenceProof({
    adapterKind: broker.adapterKind,
    brokerId: broker.brokerId,
    platform: broker.platform,
    capabilitySha256: broker.capabilitySha256,
    commandFileIdentitySha256: broker.commandFileIdentitySha256,
    processGenerationId: intent.processGenerationId,
    processOwnerSha256: intent.processOwnerSha256,
  });
  if (canonicalArenaManifestJson(proof)
    !== canonicalArenaManifestJson(expected)) {
    throw new Error(
      "Arena native process broker returned a stale or invalid quiescence proof.",
    );
  }
}

interface MutableStreamMetadata {
  readonly hash: ReturnType<typeof createHash>;
  bytes: number;
  exceededLimit: boolean;
}

type StopReason =
  | "cancelled"
  | "timedOut"
  | "stdinWriteFailed"
  | "submissionPersistenceFailed"
  | "stdoutLimitExceeded"
  | "stderrLimitExceeded"
  | "processError";

export async function prepareArenaProcessIntent(
  rawInput: ArenaProcessSupervisorInput,
  dependencies: ArenaProcessSupervisorDependencies = {},
): Promise<ArenaProcessIntentReceipt> {
  if (rawInput.processGenerationId === undefined) {
    throw new Error(
      "A prepared Arena process intent requires an explicit processGenerationId.",
    );
  }
  const input = await validateSupervisorInput(rawInput, dependencies);
  return createArenaProcessIntent(input);
}

export async function superviseArenaProcess(
  rawInput: ArenaProcessSupervisorInput,
  dependencies: ArenaProcessSupervisorDependencies = {},
): Promise<ArenaSupervisedProcessResult> {
  return superviseArenaProcessAgainstIntent(
    rawInput,
    undefined,
    dependencies,
  );
}

export async function supervisePreparedArenaProcess(
  rawInput: ArenaProcessSupervisorInput,
  expectedIntent: ArenaProcessIntentReceipt,
  dependencies: ArenaProcessSupervisorDependencies = {},
): Promise<ArenaSupervisedProcessResult> {
  return superviseArenaProcessAgainstIntent(
    rawInput,
    expectedIntent,
    dependencies,
  );
}

async function superviseArenaProcessAgainstIntent(
  rawInput: ArenaProcessSupervisorInput,
  expectedIntent: ArenaProcessIntentReceipt | undefined,
  dependencies: ArenaProcessSupervisorDependencies,
): Promise<ArenaSupervisedProcessResult> {
  const input = await validateSupervisorInput(rawInput, dependencies);
  const intent = createArenaProcessIntent(input);
  if (expectedIntent !== undefined
    && canonicalArenaManifestJson(intent)
      !== canonicalArenaManifestJson(expectedIntent)) {
    throw new Error(
      "Arena process input changed after its durable intent was prepared.",
    );
  }

  if (input.signal.aborted) {
    return resultBeforeDispatch(
      input,
      intent,
      "cancelled",
      "cancelled",
      "preDispatchCancelled",
    );
  }

  const spawnProcess = dependencies.spawnProcess ?? defaultSpawnProcess;
  let child: cp.ChildProcess;
  let brokeredProcess: ArenaNativeBrokeredProcess | undefined;
  let abortedDuringSpawn = false;
  const onAbortDuringSpawn = () => {
    abortedDuringSpawn = true;
  };
  input.signal.addEventListener("abort", onAbortDuringSpawn, { once: true });
  try {
    await revalidateSpawnBoundary(input);
    if (input.signal.aborted) {
      input.signal.removeEventListener("abort", onAbortDuringSpawn);
      return resultBeforeDispatch(
        input,
        intent,
        "cancelled",
        "cancelled",
        "preDispatchCancelled",
      );
    }
    const spawnEnvironment = Object.assign(
      Object.create(null) as NodeJS.ProcessEnv,
      input.spawnEnvironment,
    );
    // Node's child_process layer otherwise reintroduces NODE_V8_COVERAGE from
    // process.env even when callers supply an allowlisted environment. An own
    // undefined value suppresses that implicit propagation and preserves the
    // locked policy's ban on every NODE_* variable.
    spawnEnvironment.NODE_V8_COVERAGE = undefined;
    const spawnOptions: cp.SpawnOptions = {
      cwd: input.spawnWorktreePath,
      // Keep Hydra's validated policy object frozen. The runtime receives an
      // isolated, extensible copy and cannot mutate later revalidation state.
      env: spawnEnvironment,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    };
    if (input.nativeQuiescenceBroker) {
      brokeredProcess = input.nativeQuiescenceBroker.spawn({
        command: input.spawnCommand,
        args: input.spawnArgs,
        options: spawnOptions,
        binding: {
          processGenerationId: intent.processGenerationId,
          processOwnerSha256: intent.processOwnerSha256,
        },
      });
      child = brokeredProcess.child;
    } else {
      child = spawnProcess(input.spawnCommand, input.spawnArgs, spawnOptions);
    }
  } catch {
    input.signal.removeEventListener("abort", onAbortDuringSpawn);
    return resultBeforeDispatch(
      input,
      intent,
      "failed",
      "dispatchRejected",
      "spawnRejected",
    );
  }

  return new Promise<ArenaSupervisedProcessResult>((resolve) => {
    const terminate = dependencies.terminateProcess ?? terminateProcessTree;
    const terminationConfirmMs = boundedTerminationConfirm(
      dependencies.terminationConfirmMs,
    );
    const terminationGraceMs = boundedTerminationGrace(
      dependencies.terminationGraceMs,
    );
    const stdout = createMutableStream();
    const stderr = createMutableStream();
    let accepted = false;
    let submission: ArenaProcessSubmissionReceipt | null = null;
    let stopReason: StopReason | null = null;
    let diagnosticCode: ArenaProcessDiagnosticCode = "none";
    let settled = false;
    let finalizing = false;
    let exitCode: number | null = null;
    let submissionGate: Promise<void> = Promise.resolve();
    let stdinSubmitted = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let unconfirmedTimer: ReturnType<typeof setTimeout> | undefined;

    const clearLifecycle = () => {
      if (timeout) clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (unconfirmedTimer) clearTimeout(unconfirmedTimer);
      input.signal.removeEventListener("abort", onAbort);
    };

    const destroyPipes = () => {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    const resolveUnconfirmed = () => {
      if (settled || finalizing) return;
      finalizing = true;
      clearLifecycle();
      destroyPipes();
      // A termination deadline cannot cancel the broker-owned durable
      // submission callback. Keep the supervisor open until that authority
      // boundary settles so the controller cannot close monitoring while a
      // submission receipt is still capable of appearing.
      void submissionGate.then(() => {
        if (settled) return;
        settled = true;
        resolve(buildExecutionResult({
          input,
          intent,
          submission,
          quiescence: null,
          terminationConfirmed: false,
          status: "deliveryUnknown",
          failureCode: "terminationUnconfirmed",
          exitCode: null,
          stdout: finishStream(stdout, false),
          stderr: finishStream(stderr, false),
          diagnosticCode: "terminationUnconfirmed",
        }));
      });
    };

    const beginTermination = (reason: StopReason) => {
      if (settled || finalizing || stopReason !== null) return;
      stopReason = reason;
      diagnosticCode = diagnosticForStopReason(reason);
      void terminate(child, false);
      forceTimer = setTimeout(() => {
        if (settled || finalizing) return;
        void terminate(child, true);
        unconfirmedTimer = setTimeout(resolveUnconfirmed, terminationConfirmMs);
      }, terminationGraceMs);
    };

    const onAbort = () => beginTermination("cancelled");
    input.signal.addEventListener("abort", onAbort, { once: true });
    input.signal.removeEventListener("abort", onAbortDuringSpawn);
    if (abortedDuringSpawn || input.signal.aborted) {
      queueMicrotask(onAbort);
    }
    timeout = setTimeout(() => beginTermination("timedOut"), input.timeoutMs);

    child.stdout?.on("data", (value: Buffer | string) => {
      updateStream(
        stdout,
        value,
        ARENA_PROCESS_LIMITS.maxStdoutBytes,
        () => {
          child.stdout?.destroy();
          beginTermination("stdoutLimitExceeded");
        },
      );
    });
    child.stderr?.on("data", (value: Buffer | string) => {
      updateStream(
        stderr,
        value,
        ARENA_PROCESS_LIMITS.maxStderrBytes,
        () => {
          child.stderr?.destroy();
          beginTermination("stderrLimitExceeded");
        },
      );
    });

    child.stdin?.on("error", () => {
      if (accepted) beginTermination("stdinWriteFailed");
    });

    child.once("spawn", () => {
      if (settled || finalizing) return;
      accepted = true;
      submission = createArenaProcessSubmissionReceipt(intent);
      submissionGate = (async () => {
        try {
          // This callback is the broker-owned durable authority boundary. Do
          // not race it with a timer that cannot cancel the underlying file
          // writes: returning while those writes continue would permit a late
          // start/submission mutation after the controller closes its monitor.
          // Production persistence uses Hydra's bounded cross-process lock.
          await Promise.resolve(input.onSubmission(submission!));
        } catch {
          if (finalizing) {
            stopReason ??= "submissionPersistenceFailed";
            diagnosticCode = "submissionPersistenceFailed";
          } else {
            beginTermination("submissionPersistenceFailed");
          }
          return;
        }
        if (settled
          || finalizing
          || stopReason !== null
          || input.signal.aborted) {
          if (input.signal.aborted) beginTermination("cancelled");
          return;
        }
        try {
          await revalidateSpawnBoundary(input);
          if (!child.stdin || child.stdin.destroyed) {
            beginTermination("stdinWriteFailed");
            return;
          }
          child.stdin.end(input.stdin, "utf8");
          stdinSubmitted = true;
        } catch {
          beginTermination("stdinWriteFailed");
        }
      })();
    });

    child.once("error", () => {
      if (!accepted) {
        if (settled || finalizing) return;
        settled = true;
        clearLifecycle();
        destroyPipes();
        resolve(resultBeforeDispatch(
          input,
          intent,
          "failed",
          "dispatchRejected",
          "spawnRejected",
          finishStream(stdout, true),
          finishStream(stderr, true),
        ));
        return;
      }
      beginTermination("processError");
    });

    child.once("close", (code) => {
      if (settled || finalizing) return;
      finalizing = true;
      exitCode = typeof code === "number" ? code : null;
      clearLifecycle();
      void submissionGate.then(() => {
        if (accepted && !stdinSubmitted && stopReason === null) {
          stopReason = "stdinWriteFailed";
          diagnosticCode = "stdinWriteFailed";
        }
        return finalizeClosedProcess({
          input,
          intent,
          submission,
          stopReason,
          diagnosticCode,
          exitCode,
          stdout: finishStream(stdout, true),
          stderr: finishStream(stderr, true),
          ...(brokeredProcess
             ? {
               proveNativeQuiescence: brokeredProcess.proveQuiescence,
               nativeQuiescenceTimeoutMs: terminationConfirmMs,
             }
             : {}),
        });
      }).then((result) => {
          if (settled) return;
          settled = true;
          resolve(result);
        });
    });
  });
}

export function sanitizedArenaProcessEnvironment(
  source: NodeJS.ProcessEnv,
  allowBundledElectronNodeMode = false,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    const normalized = key.toUpperCase();
    if (normalized.startsWith("GIT_")
      || normalized.startsWith("NODE_")
      || normalized.startsWith("ELECTRON_")
      || normalized.startsWith("VSCODE_")
      || normalized === "NPM_CONFIG_NODE_OPTIONS"
      || normalized === "_NODE_OPTIONS") {
      continue;
    }
    if (SAFE_ENVIRONMENT_KEYS.has(normalized)) {
      sanitized[normalized] = value;
    }
  }
  sanitized.CI = "1";
  sanitized.NO_COLOR = "1";
  if (allowBundledElectronNodeMode) {
    sanitized.ELECTRON_RUN_AS_NODE = "1";
  }
  return sanitized;
}

export function arenaProcessEnvironmentPolicySha256(
  source: NodeJS.ProcessEnv = process.env,
  allowBundledElectronNodeMode = false,
): string {
  return hashCanonical(
    ENVIRONMENT_HASH_DOMAIN,
    sanitizedArenaProcessEnvironment(
      source,
      allowBundledElectronNodeMode,
    ),
  );
}

export async function arenaProcessWorktreeDirectoryIdentitySha256(
  directory: string,
): Promise<string> {
  const exact = await validateExactRealPath(
    directory,
    "Arena worktree",
    "directory",
  );
  const stat = await fs.lstat(exact);
  return hashCanonical(DIRECTORY_IDENTITY_HASH_DOMAIN, {
    path: canonicalPath(exact),
    identity: statIdentity(stat),
  });
}

export async function arenaProcessFileIdentitySha256(
  file: string,
): Promise<string> {
  const exact = await validateExactRealPath(file, "Arena executable", "file");
  const stat = await fs.lstat(exact);
  return fileIdentitySha256(exact, stat);
}

export function createArenaProcessIntent(
  input: Pick<
    ArenaProcessSupervisorInput,
    | "runId"
    | "contestantId"
    | "traceId"
    | "registrationSha256"
    | "worktreeDirectoryIdentitySha256"
    | "processGenerationId"
    | "worktreePath"
    | "command"
    | "commandFileIdentitySha256"
    | "args"
    | "stdin"
    | "environmentPolicySha256"
    | "invocationSha256"
    | "timeoutMs"
    | "bundledHelper"
    | "nativeAdapterKind"
    | "nativeQuiescenceBroker"
  >,
): ArenaProcessIntentReceipt {
  if (input.processGenerationId === undefined) {
    throw new Error(
      "Arena process intent requires an explicit processGenerationId.",
    );
  }
  assertIdentifier(input.processGenerationId, "processGenerationId");
  const promptBytes = Buffer.byteLength(input.stdin, "utf8");
  const promptSha256 = sha256Utf8(input.stdin);
  const processOwnerSha256 = hashCanonical(OWNER_HASH_DOMAIN, {
    runId: input.runId,
    contestantId: input.contestantId,
    traceId: input.traceId,
    registrationSha256: input.registrationSha256,
    processGenerationId: input.processGenerationId,
  });
  const withoutHash = {
    schemaVersion: ARENA_PROCESS_SCHEMA_VERSION,
    receiptType: "arenaProcessIntent" as const,
    runId: input.runId,
    contestantId: input.contestantId,
    traceId: input.traceId,
    registrationSha256: input.registrationSha256,
    processGenerationId: input.processGenerationId,
    processOwnerSha256,
    worktreePathSha256: sha256Utf8(canonicalPath(input.worktreePath)),
    worktreeDirectoryIdentitySha256:
      input.worktreeDirectoryIdentitySha256,
    commandSha256: sha256Utf8(canonicalPath(input.command)),
    commandFileIdentitySha256: input.commandFileIdentitySha256,
    bundledHelperFileIdentitySha256:
      input.bundledHelper?.scriptFileIdentitySha256 ?? null,
    ...(input.nativeAdapterKind && input.nativeQuiescenceBroker
      ? {
        nativeAdapterKind: input.nativeAdapterKind,
        nativeBrokerCapabilitySha256:
          input.nativeQuiescenceBroker.capabilitySha256,
      }
      : {}),
    argsSha256: hashCanonical(INPUT_HASH_DOMAIN, [...input.args]),
    promptSha256,
    inputSha256: hashCanonical(INPUT_HASH_DOMAIN, {
      promptSha256,
      inputBytes: promptBytes,
    }),
    inputBytes: promptBytes,
    environmentPolicySha256: input.environmentPolicySha256,
    invocationSha256: input.invocationSha256,
    timeoutMs: input.timeoutMs,
  };
  return Object.freeze({
    ...withoutHash,
    intentSha256: hashCanonical(INTENT_HASH_DOMAIN, withoutHash),
  });
}

export function createArenaProcessSubmissionReceipt(
  intent: ArenaProcessIntentReceipt,
): ArenaProcessSubmissionReceipt {
  const withoutHash = {
    schemaVersion: ARENA_PROCESS_SCHEMA_VERSION,
    receiptType: "arenaProcessSubmission" as const,
    runId: intent.runId,
    contestantId: intent.contestantId,
    traceId: intent.traceId,
    registrationSha256: intent.registrationSha256,
    processGenerationId: intent.processGenerationId,
    processOwnerSha256: intent.processOwnerSha256,
    intentSha256: intent.intentSha256,
  };
  return Object.freeze({
    ...withoutHash,
    submissionReceiptSha256: hashCanonical(SUBMISSION_HASH_DOMAIN, withoutHash),
  });
}

function createArenaProcessQuiescenceReceipt(
  submission: ArenaProcessSubmissionReceipt,
  finalWorkspaceFingerprintSha256: string,
  nativeProof?: ArenaNativeProcessQuiescenceProof,
): ArenaProcessQuiescenceReceipt {
  assertSha256(
    finalWorkspaceFingerprintSha256,
    "finalWorkspaceFingerprintSha256",
  );
  const withoutHash = {
    schemaVersion: ARENA_PROCESS_SCHEMA_VERSION,
    receiptType: "arenaProcessQuiescence" as const,
    runId: submission.runId,
    contestantId: submission.contestantId,
    traceId: submission.traceId,
    registrationSha256: submission.registrationSha256,
    processGenerationId: submission.processGenerationId,
    processOwnerSha256: submission.processOwnerSha256,
    intentSha256: submission.intentSha256,
    submissionReceiptSha256: submission.submissionReceiptSha256,
    proof: nativeProof
      ? "nativeAdapterProcessTreeBroker" as const
      : "bundledFakeHeadNoDescendants" as const,
    ...(nativeProof
      ? {
        adapterKind: nativeProof.adapterKind,
        brokerCapabilitySha256: nativeProof.capabilitySha256,
        brokerReceiptSha256: nativeProof.proofReceiptSha256,
      }
      : {}),
    terminationConfirmed: true as const,
    activeProcessCount: 0 as const,
    finalWorkspaceFingerprintSha256,
  };
  return Object.freeze({
    ...withoutHash,
    quiescenceReceiptSha256: hashCanonical(QUIESCENCE_HASH_DOMAIN, withoutHash),
  });
}

async function validateSupervisorInput(
  input: ArenaProcessSupervisorInput,
  dependencies: ArenaProcessSupervisorDependencies,
): Promise<ValidatedSupervisorInput> {
  assertIdentifier(input.runId, "runId");
  assertIdentifier(input.contestantId, "contestantId");
  assertIdentifier(input.traceId, "traceId");
  assertSha256(input.registrationSha256, "registrationSha256");
  assertSha256(
    input.worktreeDirectoryIdentitySha256,
    "worktreeDirectoryIdentitySha256",
  );
  assertSha256(input.environmentPolicySha256, "environmentPolicySha256");
  assertSha256(input.invocationSha256, "invocationSha256");
  assertSha256(input.commandFileIdentitySha256, "commandFileIdentitySha256");
  if (!Number.isSafeInteger(input.timeoutMs)
    || input.timeoutMs < 1
    || input.timeoutMs > ARENA_PROCESS_LIMITS.maxTimeoutMs) {
    throw new Error(
      `Arena process timeoutMs must be an integer from 1 through ${ARENA_PROCESS_LIMITS.maxTimeoutMs}.`,
    );
  }
  if (!(input.signal instanceof AbortSignal)) {
    throw new Error("Arena process signal must be an AbortSignal.");
  }
  const spawnWorktreePath = await validateExactRealPath(
    input.worktreePath,
    "Arena worktree",
    "directory",
  );
  const canonicalCommand = await validateExactRealPath(
    input.command,
    "Arena command",
    "file",
  );
  const actualWorktreeIdentity =
    await arenaProcessWorktreeDirectoryIdentitySha256(spawnWorktreePath);
  if (actualWorktreeIdentity !== input.worktreeDirectoryIdentitySha256) {
    throw new Error(
      "Arena process worktree directory identity does not match its locked registration.",
    );
  }
  const actualCommandIdentity =
    await arenaProcessFileIdentitySha256(canonicalCommand);
  if (actualCommandIdentity !== input.commandFileIdentitySha256) {
    throw new Error(
      "Arena process executable identity does not match its locked invocation.",
    );
  }
  if (!Array.isArray(input.args)
    || input.args.length > ARENA_PROCESS_LIMITS.maxArgs) {
    throw new Error(
      `Arena process args must contain at most ${ARENA_PROCESS_LIMITS.maxArgs} entries.`,
    );
  }
  let argBytes = 0;
  const args = input.args.map((value, index) => {
    if (typeof value !== "string" || value.includes("\u0000")) {
      throw new Error(`Arena process args[${index}] must be a NUL-free string.`);
    }
    argBytes += Buffer.byteLength(value, "utf8");
    return value;
  });
  if (argBytes > ARENA_PROCESS_LIMITS.maxArgBytes) {
    throw new Error(
      `Arena process args exceed ${ARENA_PROCESS_LIMITS.maxArgBytes} UTF-8 bytes.`,
    );
  }
  if (typeof input.stdin !== "string"
    || Buffer.byteLength(input.stdin, "utf8") > ARENA_PROCESS_LIMITS.maxStdinBytes) {
    throw new Error(
      `Arena process stdin must be at most ${ARENA_PROCESS_LIMITS.maxStdinBytes} UTF-8 bytes.`,
    );
  }
  const processGenerationId = input.processGenerationId
    ?? dependencies.createProcessGenerationId?.()
    ?? `generation-${randomUUID()}`;
  assertIdentifier(processGenerationId, "processGenerationId");

  let bundledHelper: ArenaBundledProcessHelper | undefined;
  let spawnCommand = canonicalCommand;
  let spawnArgs: readonly string[] = args;
  if (input.bundledHelper !== undefined) {
    assertSha256(
      input.bundledHelper.scriptFileIdentitySha256,
      "bundledHelper.scriptFileIdentitySha256",
    );
    const scriptPath = await validateExactRealPath(
      input.bundledHelper.scriptPath,
      "Arena bundled helper",
      "file",
    );
    const installedFakeHeadHelper = await validateExactRealPath(
      path.resolve(__dirname, "arenaFakeHeadCli.js"),
      "Hydra installed Arena helper",
      "file",
    );
    if (path.basename(scriptPath).toLowerCase() !== "arenafakeheadcli.js"
      || !samePath(scriptPath, installedFakeHeadHelper)) {
      throw new Error(
        "Arena bundled Electron Node mode is restricted to Hydra's installed arenaFakeHeadCli.js.",
      );
    }
    const extensionHostInvocation = path.resolve(process.execPath);
    const extensionHostExecutable = await validateExactRealPath(
      extensionHostInvocation,
      "Hydra extension-host executable",
      "file",
    );
    if (!samePath(canonicalCommand, extensionHostExecutable)
      || !samePath(input.command, extensionHostInvocation)) {
      throw new Error(
        "Arena bundled helper must run under Hydra's exact extension-host executable.",
      );
    }
    const actualScriptIdentity = await arenaProcessFileIdentitySha256(
      scriptPath,
    );
    if (actualScriptIdentity
      !== input.bundledHelper.scriptFileIdentitySha256) {
      throw new Error(
        "Arena bundled helper identity does not match the installed helper.",
      );
    }
    const firstArg = args[0];
    if (typeof firstArg !== "string"
      || firstArg !== input.bundledHelper.scriptPath
      || !samePath(
        await validateExactRealPath(
          firstArg,
          "Arena bundled helper argument",
          "file",
        ),
        scriptPath,
      )) {
      throw new Error(
        "Arena bundled helper must be the exact first process argument.",
      );
    }
    // Electron's Windows bootstrap path is part of the running host contract.
    // A realpath-equivalent target is suitable for identity binding, but it
    // is not necessarily a supported way to re-enter that installation in
    // ELECTRON_RUN_AS_NODE mode. Preserve that exact authenticated invocation
    // while opening the helper itself through its canonical path so an
    // upstream junction cannot be retargeted after validation.
    spawnCommand = extensionHostInvocation;
    spawnArgs = [scriptPath, ...args.slice(1)];
    args[0] = scriptPath;
    bundledHelper = Object.freeze({
      scriptPath,
      scriptFileIdentitySha256: actualScriptIdentity,
    });
  }

  let nativeAdapterKind: string | undefined;
  let nativeQuiescenceBroker: ArenaNativeProcessQuiescenceBroker | undefined;
  if (input.nativeAdapterKind !== undefined
    || input.nativeQuiescenceBroker !== undefined) {
    if (bundledHelper) {
      throw new Error(
        "Arena process supervision cannot combine the bundled helper with a native broker.",
      );
    }
    if (input.nativeAdapterKind === undefined
      || input.nativeQuiescenceBroker === undefined) {
      throw new Error(
        "Arena native admission requires both an adapter kind and a process-tree broker.",
      );
    }
    assertIdentifier(input.nativeAdapterKind, "nativeAdapterKind");
    const broker = input.nativeQuiescenceBroker;
    assertIdentifier(broker.adapterKind, "native broker adapterKind");
    assertIdentifier(broker.brokerId, "native broker brokerId");
    assertSha256(broker.capabilitySha256, "native broker capabilitySha256");
    assertSha256(
      broker.commandFileIdentitySha256,
      "native broker commandFileIdentitySha256",
    );
    assertSupportedPlatform(broker.platform, "native broker platform");
    if (broker.adapterKind !== input.nativeAdapterKind) {
      throw new Error(
        "Arena native process broker does not match the selected adapter kind.",
      );
    }
    if (broker.platform !== process.platform) {
      throw new Error(
        "Arena native process broker is not valid on this platform.",
      );
    }
    if (broker.commandFileIdentitySha256 !== actualCommandIdentity) {
      throw new Error(
        "Arena native process broker executable identity does not match the locked command.",
      );
    }
    const expectedCapability = arenaNativeBrokerCapabilitySha256(broker);
    if (broker.capabilitySha256 !== expectedCapability) {
      throw new Error(
        "Arena native process broker capability digest is invalid.",
      );
    }
    nativeAdapterKind = input.nativeAdapterKind;
    nativeQuiescenceBroker = broker;
  }

  const spawnEnvironment = sanitizedArenaProcessEnvironment(
    process.env,
    bundledHelper !== undefined,
  );
  const actualEnvironmentPolicySha256 = hashCanonical(
    ENVIRONMENT_HASH_DOMAIN,
    spawnEnvironment,
  );
  if (actualEnvironmentPolicySha256 !== input.environmentPolicySha256) {
    throw new Error(
      "Arena process environment does not match the locked environment policy.",
    );
  }

  return Object.freeze({
    ...input,
    worktreePath: spawnWorktreePath,
    command: canonicalCommand,
    args: Object.freeze(args),
    processGenerationId,
    spawnWorktreePath,
    spawnCommand,
    spawnArgs: Object.freeze([...spawnArgs]),
    spawnEnvironment: Object.freeze({ ...spawnEnvironment }),
    ...(bundledHelper ? { bundledHelper } : {}),
    ...(nativeAdapterKind ? { nativeAdapterKind } : {}),
    ...(nativeQuiescenceBroker ? { nativeQuiescenceBroker } : {}),
  });
}

async function validateExactRealPath(
  value: string,
  label: string,
  kind: "file" | "directory",
): Promise<string> {
  if (typeof value !== "string"
    || value.includes("\u0000")
    || !path.isAbsolute(value)
    || value !== path.resolve(value)) {
    throw new Error(`${label} path must be an exact normalized absolute path.`);
  }
  const stat = await fs.lstat(value);
  if (stat.isSymbolicLink()
    || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) {
    throw new Error(`${label} must be a real ${kind}, not a link.`);
  }
  const real = await fs.realpath(value);
  const realStat = await fs.lstat(real);
  if (realStat.isSymbolicLink()
    || (kind === "file" ? !realStat.isFile() : !realStat.isDirectory())
    || String(stat.dev) !== String(realStat.dev)
    || String(stat.ino) !== String(realStat.ino)) {
    throw new Error(
      `${label} changed identity while resolving its canonical path.`,
    );
  }
  // Hosted runners and user profiles can sit below an OS-managed junction.
  // Return the authenticated canonical target for identities and native
  // boundaries so such an upstream alias cannot name two different objects.
  // A link at the final component is still rejected above.
  return path.resolve(real);
}

async function revalidateSpawnBoundary(
  input: ValidatedSupervisorInput,
): Promise<void> {
  const worktreeIdentity =
    await arenaProcessWorktreeDirectoryIdentitySha256(input.worktreePath);
  if (worktreeIdentity !== input.worktreeDirectoryIdentitySha256) {
    throw new Error("Arena worktree identity changed across the spawn boundary.");
  }
  const commandIdentity = await arenaProcessFileIdentitySha256(input.command);
  if (commandIdentity !== input.commandFileIdentitySha256) {
    throw new Error("Arena executable identity changed across the spawn boundary.");
  }
  if (input.bundledHelper) {
    const extensionHostInvocation = path.resolve(process.execPath);
    if (!samePath(input.spawnCommand, extensionHostInvocation)
      || await arenaProcessFileIdentitySha256(extensionHostInvocation)
        !== input.commandFileIdentitySha256) {
      throw new Error(
        "Arena extension-host executable changed across the spawn boundary.",
      );
    }
    const helperIdentity = await arenaProcessFileIdentitySha256(
      input.bundledHelper.scriptPath,
    );
    if (helperIdentity !== input.bundledHelper.scriptFileIdentitySha256) {
      throw new Error(
        "Arena bundled helper identity changed across the spawn boundary.",
      );
    }
  }
}

function defaultSpawnProcess(
  command: string,
  args: readonly string[],
  options: cp.SpawnOptions,
): cp.ChildProcess {
  if (isWindowsBatchCommand(command)) {
    return spawnViaCmdShim(command, [...args], options);
  }
  return cp.spawn(command, [...args], options);
}

async function finalizeClosedProcess(input: {
  readonly input: ValidatedSupervisorInput;
  readonly intent: ArenaProcessIntentReceipt;
  readonly submission: ArenaProcessSubmissionReceipt | null;
  readonly stopReason: StopReason | null;
  readonly diagnosticCode: ArenaProcessDiagnosticCode;
  readonly exitCode: number | null;
  readonly stdout: ArenaProcessStreamMetadata;
  readonly stderr: ArenaProcessStreamMetadata;
  readonly proveNativeQuiescence?: (
    binding: ArenaNativeProcessBrokerBinding,
    signal: AbortSignal,
  ) => Promise<ArenaNativeProcessQuiescenceProof>;
  readonly nativeQuiescenceTimeoutMs?: number;
}): Promise<ArenaSupervisedProcessResult> {
  if (input.submission === null) {
    if (input.stopReason === "cancelled") {
      return resultBeforeDispatch(
        input.input,
        input.intent,
        "cancelled",
        "cancelled",
        "preDispatchCancelled",
        input.stdout,
        input.stderr,
      );
    }
    if (input.stopReason === "timedOut") {
      return resultBeforeDispatch(
        input.input,
        input.intent,
        "timedOut",
        "timeout",
        "none",
        input.stdout,
        input.stderr,
      );
    }
    return resultBeforeDispatch(
      input.input,
      input.intent,
      "failed",
      "dispatchRejected",
      "spawnRejected",
      input.stdout,
      input.stderr,
    );
  }

  let quiescence: ArenaProcessQuiescenceReceipt | null = null;
  let diagnosticCode = input.diagnosticCode;
  if ((input.input.bundledHelper || input.input.nativeQuiescenceBroker)
    && input.input.postProcessFingerprintSha256) {
    try {
      let nativeProof: ArenaNativeProcessQuiescenceProof | undefined;
      if (input.input.nativeQuiescenceBroker) {
        if (!input.proveNativeQuiescence) {
          throw new Error(
            "Arena native process broker omitted its quiescence proof callback.",
          );
        }
        nativeProof = await proveNativeQuiescenceWithinBound(
          input.proveNativeQuiescence,
          {
            processGenerationId: input.intent.processGenerationId,
            processOwnerSha256: input.intent.processOwnerSha256,
          },
          input.nativeQuiescenceTimeoutMs
            ?? ARENA_PROCESS_LIMITS.terminationConfirmMs,
        );
        validateNativeQuiescenceProof(
          nativeProof,
          input.input.nativeQuiescenceBroker,
          input.intent,
        );
      }
      const fingerprint = await input.input.postProcessFingerprintSha256();
      assertSha256(fingerprint, "postProcessFingerprintSha256 result");
      quiescence = createArenaProcessQuiescenceReceipt(
        input.submission,
        fingerprint,
        nativeProof,
      );
    } catch {
      if (diagnosticCode === "none") {
        diagnosticCode = "postProcessFingerprintFailed";
      }
    }
  }
  const classification = classifyClosedOutcome(
    input.stopReason,
    input.exitCode,
  );
  return buildExecutionResult({
    input: input.input,
    intent: input.intent,
    submission: input.submission,
    quiescence,
    terminationConfirmed: true,
    ...classification,
    exitCode: input.exitCode,
    stdout: input.stdout,
    stderr: input.stderr,
    diagnosticCode,
  });
}

async function proveNativeQuiescenceWithinBound(
  prove: (
    binding: ArenaNativeProcessBrokerBinding,
    signal: AbortSignal,
  ) => Promise<ArenaNativeProcessQuiescenceProof>,
  binding: ArenaNativeProcessBrokerBinding,
  timeoutMs: number,
): Promise<ArenaNativeProcessQuiescenceProof> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => prove(binding, controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error(
            "Arena native descendant-quiescence proof exceeded its bound.",
          ));
          reject(controller.signal.reason);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classifyClosedOutcome(
  stopReason: StopReason | null,
  exitCode: number | null,
): {
  readonly status: ArenaContestantTerminalStatus;
  readonly failureCode: ArenaContestantFailureCode | null;
} {
  if (stopReason === "cancelled") {
    return { status: "cancelled", failureCode: "cancelled" };
  }
  if (stopReason === "timedOut") {
    return { status: "timedOut", failureCode: "timeout" };
  }
  if (stopReason !== null) {
    return { status: "failed", failureCode: "transportFailure" };
  }
  if (exitCode === 0) {
    return { status: "succeeded", failureCode: null };
  }
  return {
    status: "failed",
    failureCode: exitCode === null ? "transportFailure" : "providerFailure",
  };
}

function diagnosticForStopReason(
  reason: StopReason,
): ArenaProcessDiagnosticCode {
  if (reason === "cancelled" || reason === "timedOut") return "none";
  return reason;
}

function buildExecutionResult(input: {
  readonly input: ValidatedSupervisorInput;
  readonly intent: ArenaProcessIntentReceipt;
  readonly submission: ArenaProcessSubmissionReceipt | null;
  readonly quiescence: ArenaProcessQuiescenceReceipt | null;
  readonly terminationConfirmed: boolean;
  readonly status: ArenaContestantTerminalStatus;
  readonly failureCode: ArenaContestantFailureCode | null;
  readonly exitCode: number | null;
  readonly stdout: ArenaProcessStreamMetadata;
  readonly stderr: ArenaProcessStreamMetadata;
  readonly diagnosticCode: ArenaProcessDiagnosticCode;
}): ArenaSupervisedProcessResult {
  const output = combinedOutputMetadata(input.stdout, input.stderr);
  return Object.freeze({
    runId: input.input.runId,
    contestantId: input.input.contestantId,
    processGenerationId: input.input.processGenerationId,
    processOwnerSha256: input.intent.processOwnerSha256,
    intent: input.intent,
    intentSha256: input.intent.intentSha256,
    submission: input.submission,
    submissionReceiptSha256:
      input.submission?.submissionReceiptSha256 ?? null,
    quiescence: input.quiescence,
    quiescenceReceiptSha256:
      input.quiescence?.quiescenceReceiptSha256 ?? null,
    quiescenceWorkspaceFingerprintSha256:
      input.quiescence?.finalWorkspaceFingerprintSha256 ?? null,
    terminationConfirmed: input.terminationConfirmed,
    stage: "execution",
    traceId: input.input.traceId,
    status: input.status,
    failureCode: input.failureCode,
    exitCode: input.exitCode,
    stdout: input.stdout,
    stderr: input.stderr,
    output,
    outputSha256: output.sha256,
    outputBytes: output.bytes,
    diagnosticCode: input.diagnosticCode,
  });
}

function resultBeforeDispatch(
  input: ValidatedSupervisorInput,
  intent: ArenaProcessIntentReceipt,
  status: "failed" | "cancelled" | "timedOut",
  failureCode: ArenaContestantFailureCode,
  diagnosticCode: ArenaProcessDiagnosticCode,
  stdout: ArenaProcessStreamMetadata = emptyStreamMetadata(),
  stderr: ArenaProcessStreamMetadata = emptyStreamMetadata(),
): ArenaSupervisedProcessResult {
  const output = combinedOutputMetadata(stdout, stderr);
  return Object.freeze({
    runId: input.runId,
    contestantId: input.contestantId,
    processGenerationId: input.processGenerationId,
    processOwnerSha256: intent.processOwnerSha256,
    intent,
    intentSha256: intent.intentSha256,
    submission: null,
    submissionReceiptSha256: null,
    quiescence: null,
    quiescenceReceiptSha256: null,
    quiescenceWorkspaceFingerprintSha256: null,
    terminationConfirmed: true,
    stage: "beforeDispatch",
    traceId: null,
    status,
    failureCode,
    exitCode: null,
    stdout,
    stderr,
    output,
    outputSha256: output.sha256,
    outputBytes: output.bytes,
    diagnosticCode,
  });
}

function createMutableStream(): MutableStreamMetadata {
  return {
    hash: createHash("sha256"),
    bytes: 0,
    exceededLimit: false,
  };
}

function updateStream(
  state: MutableStreamMetadata,
  value: Buffer | string,
  limit: number,
  exceeded: () => void,
): void {
  if (state.exceededLimit) return;
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const remaining = Math.max(0, limit - state.bytes);
  const retained = buffer.subarray(0, remaining);
  if (retained.length > 0) {
    state.hash.update(retained);
    state.bytes += retained.length;
  }
  if (retained.length < buffer.length) {
    state.exceededLimit = true;
    exceeded();
  }
}

function finishStream(
  state: MutableStreamMetadata,
  complete: boolean,
): ArenaProcessStreamMetadata {
  return Object.freeze({
    bytes: state.bytes,
    sha256: state.hash.digest("hex"),
    complete,
    exceededLimit: state.exceededLimit,
    fullByteCountKnown: !state.exceededLimit,
  });
}

function emptyStreamMetadata(): ArenaProcessStreamMetadata {
  return Object.freeze({
    bytes: 0,
    sha256: sha256Utf8(""),
    complete: true,
    exceededLimit: false,
    fullByteCountKnown: true,
  });
}

function combinedOutputMetadata(
  stdout: ArenaProcessStreamMetadata,
  stderr: ArenaProcessStreamMetadata,
): ArenaProcessOutputMetadata {
  return Object.freeze({
    bytes: stdout.bytes + stderr.bytes,
    sha256: hashCanonical(OUTPUT_HASH_DOMAIN, {
      stdout,
      stderr,
    }),
  });
}

function boundedTerminationGrace(value: number | undefined): number {
  if (value === undefined) return ARENA_PROCESS_LIMITS.terminationGraceMs;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error("Arena terminationGraceMs must be an integer from 1 through 10000.");
  }
  return value;
}

function boundedTerminationConfirm(value: number | undefined): number {
  if (value === undefined) return ARENA_PROCESS_LIMITS.terminationConfirmMs;
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new Error("Arena terminationConfirmMs must be an integer from 1 through 60000.");
  }
  return value;
}

function hashCanonical(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(canonicalArenaManifestJson(value), "utf8")
    .digest("hex");
}

export function sha256ArenaProcessUtf8(value: string): string {
  return sha256Utf8(value);
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Arena process ${label} must match ${IDENTIFIER_PATTERN}.`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`Arena process ${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertSupportedPlatform(
  value: unknown,
  label: string,
): asserts value is NodeJS.Platform {
  if (typeof value !== "string"
    || ![
      "aix",
      "android",
      "darwin",
      "freebsd",
      "haiku",
      "linux",
      "openbsd",
      "sunos",
      "win32",
      "cygwin",
      "netbsd",
    ].includes(value)) {
    throw new Error(`Arena process ${label} is unsupported.`);
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function statIdentity(stat: {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}): {
  readonly dev: string;
  readonly ino: string;
} {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
  };
}

function fileIdentitySha256(
  file: string,
  stat: {
    readonly dev: number | bigint;
    readonly ino: number | bigint;
    readonly size: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
  },
): string {
  return hashCanonical(FILE_IDENTITY_HASH_DOMAIN, {
    path: canonicalPath(file),
    identity: statIdentity(stat),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
}
