import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { serializePerFileAcrossProcesses } from "./fileQueue";
import {
  openAuthenticatedSteeringRelay,
  steeringRelayPrincipalSha256,
  type AuthenticatedSteeringRelay,
  type SteeringRelayEnqueueResult,
} from "./steeringRelay";
import type { AuthenticatedSteeringRelayEnvelope } from "./steeringRelayProtocol";
import {
  STEERING_RELAY_LIMITS,
  sha256Utf8,
  type SteeringRelaySource,
  type SteeringRelaySubmissionInput,
  type SteeringTargetSelection as RelayTargetSelection,
} from "./steeringRelayProtocol";
import {
  SteeringRequestRejectedError,
  type SteeringController,
  type SteeringSendReceipt,
  type SteeringTargetSelection,
} from "./steeringController";

const RELAY_KEY_BYTES = 32;
const DEFAULT_ADVERTISEMENT_TTL_MS = 15_000;
const DEFAULT_ADVERTISEMENT_REFRESH_MS = 5_000;
const DEFAULT_CLAIM_POLL_MS = 500;
const DEFAULT_SUBMISSION_TTL_MS = 2 * 60_000;

export interface SteeringRelaySecretStorage {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
}

export interface SteeringRelayController {
  targetSelections(): readonly SteeringTargetSelection[];
  send(input: Parameters<SteeringController["send"]>[0]): Promise<SteeringSendReceipt>;
}

export interface SteeringRelayRuntimeOptions {
  readonly privateWorkspaceRoot: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly authenticationKey: Uint8Array;
  readonly controller: SteeringRelayController;
  readonly authorizeTelegramSource: (source: SteeringRelaySource) => boolean;
  readonly now?: () => string;
  readonly advertisementTtlMs?: number;
  readonly advertisementRefreshMs?: number;
  readonly claimPollMs?: number;
  readonly submissionTtlMs?: number;
  readonly startTimers?: boolean;
  readonly reportError?: (operation: "advertise" | "claim", error: unknown) => void;
}

export interface SubmitWindowSteeringInput {
  readonly text: string;
  readonly targets: readonly RelayTargetSelection[];
}

/**
 * A path-stable workspace binding. The path itself never enters relay state or
 * SecretStorage labels; only this one-way digest does.
 */
export function steeringRelayWorkspaceId(
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = path.normalize(path.resolve(workspaceRoot));
  const canonical = platform === "win32" ? resolved.toLowerCase() : resolved;
  return sha256Utf8(`hydra-steering-workspace-v1\u0000${canonical}`);
}

export function steeringRelaySecretKey(workspaceId: string): string {
  if (!/^[a-f0-9]{64}$/u.test(workspaceId)) {
    throw new Error("Steering relay workspace ID is invalid.");
  }
  return `hydra.steering-relay.v1.${workspaceId}`;
}

/**
 * Creates the per-workspace relay key under a non-secret cross-process lease.
 * Only SecretStorage ever receives the key bytes; the adjacent bootstrap lock
 * contains process identity and timing metadata from fileQueue, never a key.
 */
export async function loadOrCreateSteeringRelayAuthenticationKey(input: {
  readonly secrets: SteeringRelaySecretStorage;
  readonly privateWorkspaceRoot: string;
  readonly workspaceId: string;
  readonly generate?: () => Uint8Array;
}): Promise<Buffer> {
  const secretKey = steeringRelaySecretKey(input.workspaceId);
  const steeringDirectory = path.join(path.resolve(input.privateWorkspaceRoot), "steering");
  await fs.mkdir(steeringDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(steeringDirectory, 0o700);
  const bootstrapLeasePath = path.join(steeringDirectory, ".relay-secret-bootstrap");

  return serializePerFileAcrossProcesses(bootstrapLeasePath, async () => {
    const existing = await input.secrets.get(secretKey);
    if (existing !== undefined) return decodeStoredRelayKey(existing);

    const generated = Buffer.from(input.generate?.() ?? randomBytes(RELAY_KEY_BYTES));
    if (generated.byteLength !== RELAY_KEY_BYTES) {
      generated.fill(0);
      throw new Error(`Steering relay key generator must return exactly ${RELAY_KEY_BYTES} bytes.`);
    }
    const encoded = generated.toString("base64url");
    try {
      await input.secrets.store(secretKey, encoded);
      const confirmed = await input.secrets.get(secretKey);
      if (confirmed === undefined) {
        throw new Error("VS Code SecretStorage did not retain the steering relay key.");
      }
      return decodeStoredRelayKey(confirmed);
    } finally {
      generated.fill(0);
    }
  });
}

export async function openSteeringRelayRuntime(
  options: SteeringRelayRuntimeOptions,
): Promise<SteeringRelayRuntime> {
  let runtime: SteeringRelayRuntime | undefined;
  const relay = await openAuthenticatedSteeringRelay({
    privateWorkspaceRoot: options.privateWorkspaceRoot,
    workspaceId: options.workspaceId,
    authenticationKey: options.authenticationKey,
    authorize: (envelope) => runtime?.authorizeEnvelope(envelope) === true,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  try {
    runtime = new SteeringRelayRuntime(relay, options);
    await runtime.start();
    return runtime;
  } catch (error) {
    if (runtime) await runtime.dispose();
    else relay.dispose();
    throw error;
  }
}

/** Owner-advertisement refresh, sender discovery, and owner claim delivery. */
export class SteeringRelayRuntime {
  private readonly now: () => string;
  private readonly advertisementTtlMs: number;
  private readonly advertisementRefreshMs: number;
  private readonly claimPollMs: number;
  private readonly submissionTtlMs: number;
  private readonly windowSource: SteeringRelaySource;
  private observedTargets: readonly RelayTargetSelection[] = [];
  private advertisementTimer: ReturnType<typeof setInterval> | undefined;
  private claimTimer: ReturnType<typeof setInterval> | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly relay: AuthenticatedSteeringRelay,
    private readonly options: SteeringRelayRuntimeOptions,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.advertisementTtlMs = checkedInterval(
      options.advertisementTtlMs,
      DEFAULT_ADVERTISEMENT_TTL_MS,
      1_000,
      STEERING_RELAY_LIMITS.maxMessageLifetimeMs,
      "advertisement TTL",
    );
    this.advertisementRefreshMs = checkedInterval(
      options.advertisementRefreshMs,
      DEFAULT_ADVERTISEMENT_REFRESH_MS,
      100,
      this.advertisementTtlMs - 1,
      "advertisement refresh interval",
    );
    this.claimPollMs = checkedInterval(
      options.claimPollMs,
      DEFAULT_CLAIM_POLL_MS,
      50,
      60_000,
      "claim poll interval",
    );
    this.submissionTtlMs = checkedInterval(
      options.submissionTtlMs,
      DEFAULT_SUBMISSION_TTL_MS,
      1_000,
      STEERING_RELAY_LIMITS.maxMessageLifetimeMs,
      "submission TTL",
    );
    this.windowSource = {
      transport: "window",
      principalSha256: steeringRelayPrincipalSha256("window", options.workspaceId),
    };
  }

  async start(): Promise<void> {
    this.ensureActive();
    await this.refreshOwnerAdvertisement();
    await this.pumpOwnerClaims();
    if (this.options.startTimers === false) return;
    this.advertisementTimer = setInterval(() => {
      void this.refreshOwnerAdvertisement().catch((error) => this.report("advertise", error));
    }, this.advertisementRefreshMs);
    this.claimTimer = setInterval(() => {
      void this.pumpOwnerClaims().catch((error) => this.report("claim", error));
    }, this.claimPollMs);
  }

  /** Called after a native handle registers or closes; coalesced with timers. */
  notifyOwnerTargetsChanged(): void {
    if (this.disposed) return;
    void this.refreshOwnerAdvertisement()
      .then(() => this.pumpOwnerClaims())
      .catch((error) => this.report("advertise", error));
  }

  async refreshOwnerAdvertisement(): Promise<void> {
    return this.serializeLifecycle(async () => {
      const targets = this.ownerTargets();
      if (targets.length === 0) {
        await this.relay.unpublishOwner(this.options.ownerId);
        this.observedTargets = this.observedTargets.filter((target) => target.ownerId !== this.options.ownerId);
        return;
      }
      const publishedAtMs = Date.parse(this.checkedNow());
      await this.relay.publishOwnerTargets({
        ownerId: this.options.ownerId,
        targets,
        expiresAt: new Date(publishedAtMs + this.advertisementTtlMs).toISOString(),
      });
      this.observedTargets = [
        ...this.observedTargets.filter((target) => target.ownerId !== this.options.ownerId),
        ...targets.map(cloneTarget),
      ];
    });
  }

  async listAdvertisedLiveTargets(): Promise<readonly RelayTargetSelection[]> {
    this.ensureActive();
    const targets = (await this.relay.listActiveTargets()).filter(isRelaySteerableTarget);
    this.observedTargets = targets.map(cloneTarget);
    return this.observedTargets.map(cloneTarget);
  }

  async submitWindowSteering(
    input: SubmitWindowSteeringInput,
  ): Promise<SteeringRelayEnqueueResult> {
    this.ensureActive();
    // Re-read the authenticated advertisements immediately before admission;
    // the synchronous relay authorizer then checks against this exact cache.
    await this.listAdvertisedLiveTargets();
    const targets = input.targets.map(cloneTarget);
    const first = requireSingleDestination(targets);
    const issuedAt = this.checkedNow();
    return this.relay.enqueueNext({
      workspaceId: this.options.workspaceId,
      destinationOwnerId: first.ownerId,
      producerId: `window-${this.windowSource.principalSha256.slice(0, 32)}`,
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + this.submissionTtlMs).toISOString(),
      source: this.windowSource,
      intent: "steer",
      roomTurnId: first.roomTurnId,
      text: input.text,
      targets,
    });
  }

  async submitTelegramSteering(
    input: SteeringRelaySubmissionInput,
  ): Promise<SteeringRelayEnqueueResult> {
    this.ensureActive();
    if (input.source.transport !== "telegram" || input.destinationOwnerId !== this.options.ownerId) {
      throw new Error("Telegram steering must enter through its routed owning window.");
    }
    const result = await this.relay.enqueue(input);
    await this.pumpOwnerClaims();
    return result;
  }

  async pumpOwnerClaims(): Promise<void> {
    return this.serializeLifecycle(async () => {
      for (let index = 0; index < STEERING_RELAY_LIMITS.maxPendingMessages; index += 1) {
        const receipt = await this.relay.processNext(
          this.options.ownerId,
          (envelope) => this.deliverToController(envelope),
        );
        if (!receipt) return;
      }
    });
  }

  authorizeEnvelope(envelope: Readonly<AuthenticatedSteeringRelayEnvelope>): boolean {
    if (this.disposed || envelope.intent !== "steer") return false;
    const sourceAuthorized = envelope.source.transport === "window"
      ? envelope.source.principalSha256 === this.windowSource.principalSha256
      : safeTelegramAuthorization(this.options.authorizeTelegramSource, envelope.source);
    if (!sourceAuthorized) return false;

    const candidates = envelope.destinationOwnerId === this.options.ownerId
      ? this.ownerTargets()
      : this.observedTargets;
    return envelope.targets.length > 0 && envelope.targets.every((target) =>
      candidates.some((candidate) => equalTargets(candidate, target))
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.advertisementTimer) clearInterval(this.advertisementTimer);
    if (this.claimTimer) clearInterval(this.claimTimer);
    this.advertisementTimer = undefined;
    this.claimTimer = undefined;
    await this.lifecycleTail.catch(() => undefined);
    await this.relay.unpublishOwner(this.options.ownerId).catch(() => undefined);
    this.relay.dispose();
  }

  private ownerTargets(): readonly RelayTargetSelection[] {
    return this.options.controller.targetSelections()
      .filter((target) => target.ownerId === this.options.ownerId && isRelaySteerableTarget(target))
      .map(cloneTarget);
  }

  private async deliverToController(
    envelope: Readonly<AuthenticatedSteeringRelayEnvelope>,
  ): Promise<{
    outcome: "delivered" | "rejected" | "deliveryUnknown";
    code: "acknowledged" | "controllerRejected" | "handlerFailed";
    steeringId?: string;
    resultSha256?: string;
  }> {
    try {
      const result = await this.options.controller.send({
        source: "localUser",
        intent: envelope.intent,
        roomTurnId: envelope.roomTurnId,
        text: envelope.text,
        targets: envelope.targets,
      });
      const outcome = relayOutcome(result);
      return {
        ...outcome,
        steeringId: result.steeringId,
        resultSha256: steeringResultSha256(result),
      };
    } catch (error) {
      if (error instanceof SteeringRequestRejectedError) {
        return { outcome: "rejected", code: "controllerRejected" };
      }
      return { outcome: "deliveryUnknown", code: "handlerFailed" };
    }
  }

  private serializeLifecycle(work: () => Promise<void>): Promise<void> {
    this.ensureActive();
    const next = this.lifecycleTail.then(work, work);
    this.lifecycleTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private checkedNow(): string {
    const value = this.now();
    if (!Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
      throw new Error("Steering relay runtime clock is not canonical.");
    }
    return value;
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error("Steering relay runtime is disposed.");
  }

  private report(operation: "advertise" | "claim", error: unknown): void {
    try {
      this.options.reportError?.(operation, error);
    } catch {
      // Diagnostics cannot change relay lifecycle semantics.
    }
  }
}

function decodeStoredRelayKey(value: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error("Stored steering relay key is malformed.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== RELAY_KEY_BYTES || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw new Error("Stored steering relay key is malformed.");
  }
  return decoded;
}

function checkedInterval(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`Steering relay ${label} is invalid.`);
  }
  return resolved;
}

function isRelaySteerableTarget(target: RelayTargetSelection): boolean {
  return target.capability.kind === "live"
    && ["discussion", "build", "review", "missionTask", "nestedWorker"].includes(target.workClass);
}

function cloneTarget(target: RelayTargetSelection): RelayTargetSelection {
  return { ...target, capability: { ...target.capability } };
}

function requireSingleDestination(
  targets: readonly RelayTargetSelection[],
): RelayTargetSelection {
  const first = targets[0];
  if (!first
    || targets.some((target) =>
      target.ownerId !== first.ownerId || target.roomTurnId !== first.roomTurnId
    )) {
    throw new Error("Cross-window steering requires one exact owner and room turn.");
  }
  return first;
}

function equalTargets(left: RelayTargetSelection, right: RelayTargetSelection): boolean {
  return left.selectionSha256 === right.selectionSha256
    && left.callId === right.callId
    && left.generation === right.generation
    && left.agentId === right.agentId
    && left.roomTurnId === right.roomTurnId
    && left.missionDocumentSha256 === right.missionDocumentSha256
    && left.missionBindingSha256 === right.missionBindingSha256
    && left.authoritySha256 === right.authoritySha256
    && left.initialPromptSha256 === right.initialPromptSha256
    && left.ownerId === right.ownerId
    && left.workClass === right.workClass
    && left.capability.kind === right.capability.kind
    && left.capability.delivery === right.capability.delivery
    && (left.capability.kind !== "live" || right.capability.kind !== "live"
      || left.capability.protocol === right.capability.protocol)
    && (left.capability.kind === "live" || right.capability.kind === "live"
      || left.capability.reason === right.capability.reason)
    && left.phaseSnapshot === right.phaseSnapshot
    && left.timeoutDeadlineMs === right.timeoutDeadlineMs;
}

function safeTelegramAuthorization(
  authorize: (source: SteeringRelaySource) => boolean,
  source: SteeringRelaySource,
): boolean {
  try {
    return authorize(source) === true;
  } catch {
    return false;
  }
}

function relayOutcome(result: SteeringSendReceipt): {
  outcome: "delivered" | "rejected" | "deliveryUnknown";
  code: "acknowledged" | "controllerRejected" | "handlerFailed";
} {
  if (result.outcomes.some((outcome) => outcome.outcome === "deliveryUnknown")) {
    return { outcome: "deliveryUnknown", code: "handlerFailed" };
  }
  if (result.outcomes.length < 1
    || result.outcomes.some((outcome) => outcome.outcome !== "acknowledged")) {
    return { outcome: "rejected", code: "controllerRejected" };
  }
  return { outcome: "delivered", code: "acknowledged" };
}

function steeringResultSha256(result: SteeringSendReceipt): string {
  return sha256Utf8(JSON.stringify([
    "hydra-relayed-steering-result-v1",
    result.steeringId,
    result.requestEventId,
    result.outcomes.map((outcome) => [
      outcome.callId,
      outcome.generation,
      outcome.sequence,
      outcome.outcome,
      outcome.code,
      outcome.steeringChainSha256,
      outcome.chainIndeterminate,
    ]),
  ]));
}
