import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  atomicWriteFile,
  ensureFile,
  readFileHead,
  serializePerFileAcrossProcesses,
} from "./fileQueue";
import {
  STEERING_RELAY_LIMITS,
  STEERING_RELAY_SCHEMA_VERSION,
  assertAuthenticationKey,
  authenticateSteeringRelayEnvelope,
  canonicalEnvelope,
  cloneTargetSelection,
  createAuthenticatedSteeringRelayEnvelope,
  isAuthenticatedSteeringRelayEnvelope,
  isSteeringRelayOwnerAdvertisement,
  isSteeringRelayProducerId,
  isSteeringRelayReceipt,
  sha256Utf8,
  steeringRelayPrincipalSha256,
  type AuthenticatedSteeringRelayEnvelope,
  type SteeringRelayClaim,
  type SteeringRelayOwnerAdvertisement,
  type SteeringRelayReceipt,
  type SteeringRelayReceiptCode,
  type SteeringRelayReceiptOutcome,
  type SteeringRelaySource,
  type SteeringRelaySubmissionInput,
  type SteeringTargetSelection,
} from "./steeringRelayProtocol";
import {
  isBoundedIdentifier,
  isCanonicalTimestamp,
  isMissionBindingPair,
  isSha256,
  type SteeringIntent,
} from "./steeringProtocol";

export { steeringRelayPrincipalSha256 } from "./steeringRelayProtocol";

export type SteeringRelayRejectionCode =
  | "invalidConfiguration"
  | "invalidEnvelope"
  | "authenticationFailed"
  | "workspaceMismatch"
  | "unauthorized"
  | "expired"
  | "futureIssued"
  | "lifetimeExceeded"
  | "sequenceConflict"
  | "staleSequence"
  | "queueFull"
  | "producerLimit"
  | "stateInvalid"
  | "claimInvalid"
  | "disposed";

export class SteeringRelayRejectedError extends Error {
  constructor(readonly code: SteeringRelayRejectionCode, message: string) {
    super(message);
    this.name = "SteeringRelayRejectedError";
  }
}

export interface SteeringRelayGrantTarget {
  readonly callId: string;
  readonly generation: string;
  readonly agentId: string;
  readonly selectionSha256: string;
}

/**
 * An in-memory, explicitly-issued grant. It is narrower than possession of the
 * relay authentication key: source, workspace, owner, turn, Mission binding,
 * authority, intent, and exact run selections must all match.
 */
export interface SteeringRelayAuthorizationGrant {
  readonly grantId: string;
  readonly source: SteeringRelaySource;
  readonly workspaceId: string;
  readonly destinationOwnerId: string;
  readonly roomTurnId: string;
  readonly missionDocumentSha256: string | null;
  readonly missionBindingSha256: string;
  readonly authoritySha256: string;
  readonly intents: readonly SteeringIntent[];
  readonly targets: readonly SteeringRelayGrantTarget[];
  readonly expiresAt: string;
}

export type SteeringRelayAuthorizer = (
  envelope: Readonly<AuthenticatedSteeringRelayEnvelope>,
) => boolean;

export interface SteeringRelayLimits {
  readonly maxPendingMessages: number;
  readonly maxPendingBytes: number;
  readonly maxReceipts: number;
  readonly maxProducers: number;
  readonly maxAdvertisements: number;
  readonly claimLeaseMs: number;
}

export interface OpenAuthenticatedSteeringRelayOptions {
  readonly privateWorkspaceRoot: string;
  readonly workspaceId: string;
  /** Load from VS Code SecretStorage (or an equivalent OS-backed secret store). */
  readonly authenticationKey: Uint8Array;
  readonly authorize: SteeringRelayAuthorizer;
  readonly now?: () => string;
  readonly newId?: () => string;
  readonly limits?: Partial<SteeringRelayLimits>;
}

export type SteeringRelayEnqueueResult =
  | {
      readonly status: "queued" | "duplicatePending";
      readonly envelope: AuthenticatedSteeringRelayEnvelope;
    }
  | {
      readonly status: "duplicateCompleted";
      readonly envelope: AuthenticatedSteeringRelayEnvelope;
      readonly receipt: SteeringRelayReceipt;
    };

export interface CompleteSteeringRelayClaimInput {
  readonly outcome: SteeringRelayReceiptOutcome;
  readonly code: SteeringRelayReceiptCode;
  readonly steeringId?: string;
  readonly resultSha256?: string;
}

export type SteeringRelayDeliveryHandler = (
  envelope: Readonly<AuthenticatedSteeringRelayEnvelope>,
) => Promise<CompleteSteeringRelayClaimInput>;

export interface SteeringRelayPaths {
  readonly directory: string;
  readonly statePath: string;
}

interface PendingRelayMessage {
  readonly state: "pending";
  readonly envelope: AuthenticatedSteeringRelayEnvelope;
}

interface ClaimedRelayMessage {
  readonly state: "claimed";
  readonly claimId: string;
  readonly claimedAt: string;
  readonly claimExpiresAt: string;
  readonly envelope: AuthenticatedSteeringRelayEnvelope;
}

type RelayMessageState = PendingRelayMessage | ClaimedRelayMessage;

interface RelayProducerCursor {
  readonly producerId: string;
  readonly lastSequence: number;
}

interface SteeringRelayState {
  readonly schemaVersion: typeof STEERING_RELAY_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly advertisements: readonly SteeringRelayOwnerAdvertisement[];
  readonly pending: readonly RelayMessageState[];
  readonly cursors: readonly RelayProducerCursor[];
  readonly receipts: readonly SteeringRelayReceipt[];
  readonly stateAuthTag: string;
}

interface MutableSteeringRelayState {
  schemaVersion: typeof STEERING_RELAY_SCHEMA_VERSION;
  workspaceId: string;
  advertisements: SteeringRelayOwnerAdvertisement[];
  pending: RelayMessageState[];
  cursors: RelayProducerCursor[];
  receipts: SteeringRelayReceipt[];
  stateAuthTag: string;
}

const STATE_AUTH_TAG_PATTERN = /^[a-f0-9]{64}$/;

export function createSteeringRelayGrantAuthorizer(
  grants: readonly SteeringRelayAuthorizationGrant[],
  now: () => string = () => new Date().toISOString(),
): SteeringRelayAuthorizer {
  const checked = grants.map(validateAndCloneGrant);
  return (envelope) => {
    const nowMs = canonicalTimeMs(now());
    return checked.some((grant) => {
      if (canonicalTimeMs(grant.expiresAt) <= nowMs
        || grant.source.transport !== envelope.source.transport
        || grant.source.principalSha256 !== envelope.source.principalSha256
        || grant.workspaceId !== envelope.workspaceId
        || grant.destinationOwnerId !== envelope.destinationOwnerId
        || grant.roomTurnId !== envelope.roomTurnId
        || !grant.intents.includes(envelope.intent)) {
        return false;
      }
      const allowedTargets = new Set(grant.targets.map(grantTargetKey));
      return envelope.targets.every((target) =>
        target.missionDocumentSha256 === grant.missionDocumentSha256
        && target.missionBindingSha256 === grant.missionBindingSha256
        && target.authoritySha256 === grant.authoritySha256
        && allowedTargets.has(grantTargetKey(target))
      );
    });
  };
}

export async function openAuthenticatedSteeringRelay(
  options: OpenAuthenticatedSteeringRelayOptions,
): Promise<AuthenticatedSteeringRelay> {
  try {
    assertAuthenticationKey(options.authenticationKey);
  } catch {
    throw new SteeringRelayRejectedError(
      "invalidConfiguration",
      "Steering relay authentication key is invalid.",
    );
  }
  if (!isSha256(options.workspaceId)) {
    throw new SteeringRelayRejectedError("invalidConfiguration", "Steering relay workspace binding is invalid.");
  }
  if (typeof options.authorize !== "function") {
    throw new SteeringRelayRejectedError("invalidConfiguration", "Steering relay requires an explicit authorizer.");
  }
  const limits = resolveLimits(options.limits);
  const key = Buffer.from(options.authenticationKey);
  let relay: AuthenticatedSteeringRelay | undefined;
  try {
    const requestedRoot = path.resolve(options.privateWorkspaceRoot);
    await fs.mkdir(requestedRoot, { recursive: true, mode: 0o700 });
    const privateRoot = await fs.realpath(requestedRoot);
    const directory = path.join(privateRoot, "steering");
    await ensurePrivateDirectory(directory);
    const paths: SteeringRelayPaths = {
      directory,
      statePath: path.join(directory, "relay.v1.json"),
    };
    await ensureFile(paths.statePath, "");
    await hardenPrivateFile(paths.statePath);
    relay = new AuthenticatedSteeringRelay(
      paths,
      options.workspaceId,
      key,
      options.authorize,
      options.now ?? (() => new Date().toISOString()),
      options.newId ?? (() => `claim-${randomUUID()}`),
      limits,
    );
    await relay.initialize();
    return relay;
  } catch (error) {
    if (relay) relay.dispose();
    else key.fill(0);
    throw error;
  }
}

export class AuthenticatedSteeringRelay {
  private disposed = false;

  constructor(
    readonly paths: SteeringRelayPaths,
    private readonly workspaceId: string,
    private readonly authenticationKey: Buffer,
    private readonly authorize: SteeringRelayAuthorizer,
    private readonly now: () => string,
    private readonly newId: () => string,
    private readonly limits: SteeringRelayLimits,
  ) {}

  async initialize(): Promise<void> {
    this.ensureActive();
    await this.withState(async (state, existed) => {
      if (!existed) return { state: this.emptyState(), value: undefined };
      return { state, value: undefined, unchanged: true };
    });
  }

  async publishOwnerTargets(input: {
    readonly ownerId: string;
    readonly targets: readonly SteeringTargetSelection[];
    readonly expiresAt: string;
  }): Promise<void> {
    this.ensureActive();
    const publishedAt = this.checkedNow();
    const advertisement: SteeringRelayOwnerAdvertisement = {
      schemaVersion: STEERING_RELAY_SCHEMA_VERSION,
      ownerId: input.ownerId,
      workspaceId: this.workspaceId,
      publishedAt,
      expiresAt: input.expiresAt,
      targets: input.targets.map(cloneTargetSelection),
    };
    if (!isSteeringRelayOwnerAdvertisement(advertisement)) {
      throw new SteeringRelayRejectedError("invalidEnvelope", "Steering relay owner advertisement is malformed.");
    }
    this.assertLifetime(publishedAt, advertisement.expiresAt);
    await this.withState(async (state) => {
      this.settleExpired(state, canonicalTimeMs(publishedAt));
      state.advertisements = state.advertisements.filter((entry) => entry.ownerId !== advertisement.ownerId);
      if (state.advertisements.length >= this.limits.maxAdvertisements) {
        throw new SteeringRelayRejectedError("queueFull", "Steering relay owner advertisement capacity is full.");
      }
      state.advertisements.push(advertisement);
      return { state, value: undefined };
    });
  }

  async unpublishOwner(ownerId: string): Promise<void> {
    this.ensureActive();
    if (!isBoundedIdentifier(ownerId)) {
      throw new SteeringRelayRejectedError("invalidEnvelope", "Steering relay owner ID is invalid.");
    }
    await this.withState(async (state) => {
      this.settleExpired(state, canonicalTimeMs(this.checkedNow()));
      state.advertisements = state.advertisements.filter((entry) => entry.ownerId !== ownerId);
      return { state, value: undefined };
    });
  }

  async listActiveTargets(): Promise<readonly SteeringTargetSelection[]> {
    this.ensureActive();
    const nowMs = canonicalTimeMs(this.checkedNow());
    return this.withState(async (state) => {
      const changed = this.settleExpired(state, nowMs);
      const targets = state.advertisements
        .flatMap((advertisement) => advertisement.targets.map(cloneTargetSelection))
        .sort((left, right) =>
          left.ownerId.localeCompare(right.ownerId)
          || left.callId.localeCompare(right.callId)
          || left.generation.localeCompare(right.generation)
        );
      return { state, value: targets, unchanged: !changed };
    });
  }

  async enqueue(input: SteeringRelaySubmissionInput): Promise<SteeringRelayEnqueueResult> {
    this.ensureActive();
    const envelope = this.createEnvelope(input);
    return this.ingest(envelope);
  }

  async enqueueNext(
    input: Omit<SteeringRelaySubmissionInput, "sequence">,
  ): Promise<SteeringRelayEnqueueResult> {
    this.ensureActive();
    if (!isSteeringRelayProducerId(input.producerId)) {
      throw new SteeringRelayRejectedError("invalidEnvelope", "Steering relay producer ID is invalid.");
    }
    return this.withState(async (state) => {
      this.settleExpired(state, canonicalTimeMs(this.checkedNow()));
      const cursor = state.cursors.find((candidate) => candidate.producerId === input.producerId);
      const sequence = (cursor?.lastSequence ?? 0) + 1;
      if (!Number.isSafeInteger(sequence)) {
        throw new SteeringRelayRejectedError("staleSequence", "Steering relay producer sequence is exhausted.");
      }
      const envelope = this.createEnvelope({ ...input, sequence });
      this.validateNewEnvelope(envelope);
      const value = this.enqueueIntoState(state, envelope);
      return { state, value };
    });
  }

  async ingest(value: unknown): Promise<SteeringRelayEnqueueResult> {
    this.ensureActive();
    if (!isAuthenticatedSteeringRelayEnvelope(value)) {
      throw new SteeringRelayRejectedError("invalidEnvelope", "Steering relay envelope is malformed.");
    }
    if (!authenticateSteeringRelayEnvelope(value, this.authenticationKey)) {
      throw new SteeringRelayRejectedError("authenticationFailed", "Steering relay envelope authentication failed.");
    }
    const envelope = cloneEnvelope(value);
    if (envelope.workspaceId !== this.workspaceId) {
      throw new SteeringRelayRejectedError("workspaceMismatch", "Steering relay workspace binding does not match.");
    }
    return this.withState(async (state) => {
      const changed = this.settleExpired(state, canonicalTimeMs(this.checkedNow()));
      const known = this.knownEnvelopeResult(state, envelope);
      if (known) return { state, value: known, unchanged: !changed };
      this.validateNewEnvelope(envelope);
      const result = this.enqueueIntoState(state, envelope);
      return { state, value: result };
    });
  }

  async claimNext(destinationOwnerId: string): Promise<SteeringRelayClaim | undefined> {
    this.ensureActive();
    if (!isBoundedIdentifier(destinationOwnerId)) {
      throw new SteeringRelayRejectedError("claimInvalid", "Steering relay destination owner ID is invalid.");
    }
    const now = this.checkedNow();
    const nowMs = canonicalTimeMs(now);
    return this.withState(async (state) => {
      let changed = this.settleExpired(state, nowMs);
      for (;;) {
        const index = state.pending.findIndex((entry) =>
          entry.state === "pending" && entry.envelope.destinationOwnerId === destinationOwnerId
        );
        if (index < 0) return { state, value: undefined, unchanged: !changed };
        const pending = state.pending[index];
        if (!pending || pending.state !== "pending") continue;
        if (!this.authorize(pending.envelope)) {
          this.finishAtIndex(state, index, pending.envelope, {
            outcome: "rejected",
            code: "authorizationRevoked",
          }, now);
          changed = true;
          continue;
        }
        const claimId = this.newId();
        if (!isBoundedIdentifier(claimId)) {
          throw new SteeringRelayRejectedError("claimInvalid", "Generated steering relay claim ID is invalid.");
        }
        const envelopeExpiry = canonicalTimeMs(pending.envelope.expiresAt);
        const claimExpiresMs = Math.min(envelopeExpiry, nowMs + this.limits.claimLeaseMs);
        if (claimExpiresMs <= nowMs) {
          this.finishAtIndex(state, index, pending.envelope, {
            outcome: "expired",
            code: "messageExpired",
          }, now);
          changed = true;
          continue;
        }
        const claim: SteeringRelayClaim = {
          claimId,
          claimedAt: now,
          claimExpiresAt: new Date(claimExpiresMs).toISOString(),
          envelope: cloneEnvelope(pending.envelope),
        };
        state.pending[index] = {
          state: "claimed",
          claimId: claim.claimId,
          claimedAt: claim.claimedAt,
          claimExpiresAt: claim.claimExpiresAt,
          envelope: cloneEnvelope(claim.envelope),
        };
        return { state, value: claim };
      }
    });
  }

  async completeClaim(
    claim: SteeringRelayClaim,
    completion: CompleteSteeringRelayClaimInput,
  ): Promise<SteeringRelayReceipt> {
    this.ensureActive();
    validateCompletion(completion);
    return this.withState(async (state) => {
      const now = this.checkedNow();
      const nowMs = canonicalTimeMs(now);
      const changed = this.settleExpired(state, nowMs);
      const existing = state.receipts.find((receipt) => receipt.messageId === claim.envelope.messageId);
      if (existing) return { state, value: cloneReceipt(existing), unchanged: !changed };
      const index = state.pending.findIndex((entry) =>
        entry.state === "claimed"
        && entry.envelope.messageId === claim.envelope.messageId
      );
      const pending = index >= 0 ? state.pending[index] : undefined;
      if (!pending
        || pending.state !== "claimed"
        || pending.claimId !== claim.claimId
        || pending.envelope.authTag !== claim.envelope.authTag) {
        throw new SteeringRelayRejectedError("claimInvalid", "Steering relay claim is stale or unknown.");
      }
      const receipt = this.finishAtIndex(state, index, pending.envelope, completion, now);
      return { state, value: receipt };
    });
  }

  /**
   * Narrow owner-side integration point. A controller adapter returns only
   * bounded outcome metadata; thrown errors are converted to delivery-unknown
   * and are never copied into durable state (where they could contain a token,
   * prompt, stack trace, or provider response).
   */
  async processNext(
    destinationOwnerId: string,
    deliver: SteeringRelayDeliveryHandler,
  ): Promise<SteeringRelayReceipt | undefined> {
    this.ensureActive();
    if (typeof deliver !== "function") {
      throw new SteeringRelayRejectedError("invalidConfiguration", "Steering relay delivery handler is required.");
    }
    const claim = await this.claimNext(destinationOwnerId);
    if (!claim) return undefined;
    let completion: CompleteSteeringRelayClaimInput;
    try {
      completion = await deliver(cloneEnvelope(claim.envelope));
      validateCompletion(completion);
    } catch {
      completion = { outcome: "deliveryUnknown", code: "handlerFailed" };
    }
    return this.completeClaim(claim, completion);
  }

  async receipt(messageId: string): Promise<SteeringRelayReceipt | undefined> {
    this.ensureActive();
    if (!isBoundedIdentifier(messageId)) return undefined;
    return this.withState(async (state) => {
      const changed = this.settleExpired(state, canonicalTimeMs(this.checkedNow()));
      return {
        state,
        value: cloneOptionalReceipt(state.receipts.find((receipt) => receipt.messageId === messageId)),
        unchanged: !changed,
      };
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.authenticationKey.fill(0);
  }

  private validateNewEnvelope(envelope: AuthenticatedSteeringRelayEnvelope): void {
    if (envelope.workspaceId !== this.workspaceId) {
      throw new SteeringRelayRejectedError("workspaceMismatch", "Steering relay workspace binding does not match.");
    }
    this.assertLifetime(envelope.issuedAt, envelope.expiresAt);
    if (!this.authorize(envelope)) {
      throw new SteeringRelayRejectedError("unauthorized", "Steering relay source or exact target is not authorized.");
    }
  }

  private createEnvelope(input: SteeringRelaySubmissionInput): AuthenticatedSteeringRelayEnvelope {
    try {
      return createAuthenticatedSteeringRelayEnvelope(input, this.authenticationKey);
    } catch {
      throw new SteeringRelayRejectedError(
        "invalidEnvelope",
        "Steering relay submission is malformed or has inconsistent bindings.",
      );
    }
  }

  private assertLifetime(issuedAt: string, expiresAt: string): void {
    const nowMs = canonicalTimeMs(this.checkedNow());
    const issuedMs = canonicalTimeMs(issuedAt);
    const expiresMs = canonicalTimeMs(expiresAt);
    if (issuedMs - nowMs > STEERING_RELAY_LIMITS.maxFutureSkewMs) {
      throw new SteeringRelayRejectedError("futureIssued", "Steering relay message was issued too far in the future.");
    }
    if (expiresMs <= nowMs || expiresMs <= issuedMs) {
      throw new SteeringRelayRejectedError("expired", "Steering relay message has expired.");
    }
    if (expiresMs - issuedMs > STEERING_RELAY_LIMITS.maxMessageLifetimeMs) {
      throw new SteeringRelayRejectedError("lifetimeExceeded", "Steering relay message lifetime exceeds its bound.");
    }
  }

  private enqueueIntoState(
    state: MutableSteeringRelayState,
    envelope: AuthenticatedSteeringRelayEnvelope,
  ): SteeringRelayEnqueueResult {
    const known = this.knownEnvelopeResult(state, envelope);
    if (known) return known;
    const cursorIndex = state.cursors.findIndex((candidate) => candidate.producerId === envelope.producerId);
    const cursor = cursorIndex >= 0 ? state.cursors[cursorIndex] : undefined;
    if (cursor && envelope.sequence <= cursor.lastSequence) {
      throw new SteeringRelayRejectedError("staleSequence", "Steering relay producer sequence is stale.");
    }
    if (!cursor && state.cursors.length >= this.limits.maxProducers) {
      throw new SteeringRelayRejectedError("producerLimit", "Steering relay producer capacity is full.");
    }
    const pendingBytes = state.pending.reduce(
      (total, entry) => total + Buffer.byteLength(entry.envelope.text, "utf8"),
      0,
    );
    const messageBytes = Buffer.byteLength(envelope.text, "utf8");
    if (state.pending.length >= this.limits.maxPendingMessages
      || pendingBytes + messageBytes > this.limits.maxPendingBytes) {
      throw new SteeringRelayRejectedError("queueFull", "Steering relay queue is full.");
    }
    state.pending.push({ state: "pending", envelope: cloneEnvelope(envelope) });
    const nextCursor = { producerId: envelope.producerId, lastSequence: envelope.sequence };
    if (cursorIndex >= 0) state.cursors[cursorIndex] = nextCursor;
    else state.cursors.push(nextCursor);
    state.cursors.sort((left, right) => left.producerId.localeCompare(right.producerId));
    return { status: "queued", envelope: cloneEnvelope(envelope) };
  }

  private knownEnvelopeResult(
    state: MutableSteeringRelayState,
    envelope: AuthenticatedSteeringRelayEnvelope,
  ): SteeringRelayEnqueueResult | undefined {
    const pending = state.pending.find((entry) => entry.envelope.messageId === envelope.messageId);
    if (pending) {
      if (pending.envelope.authTag !== envelope.authTag) {
        throw new SteeringRelayRejectedError("sequenceConflict", "Steering relay producer sequence was already used by another message.");
      }
      return { status: "duplicatePending", envelope: cloneEnvelope(pending.envelope) };
    }
    const receipt = state.receipts.find((entry) => entry.messageId === envelope.messageId);
    if (receipt) {
      if (receipt.envelopeSha256 !== envelopeSha256(envelope)) {
        throw new SteeringRelayRejectedError("sequenceConflict", "Steering relay producer sequence was already used by another message.");
      }
      return {
        status: "duplicateCompleted",
        envelope: cloneEnvelope(envelope),
        receipt: cloneReceipt(receipt),
      };
    }
    return undefined;
  }

  private settleExpired(state: MutableSteeringRelayState, nowMs: number): boolean {
    const now = new Date(nowMs).toISOString();
    let changed = false;
    state.advertisements = state.advertisements.filter((entry) => {
      const keep = canonicalTimeMs(entry.expiresAt) > nowMs;
      changed ||= !keep;
      return keep;
    });
    for (let index = state.pending.length - 1; index >= 0; index -= 1) {
      const entry = state.pending[index];
      if (!entry) continue;
      if (entry.state === "claimed" && canonicalTimeMs(entry.claimExpiresAt) <= nowMs) {
        this.finishAtIndex(state, index, entry.envelope, {
          outcome: "deliveryUnknown",
          code: "claimExpired",
        }, now);
        changed = true;
      } else if (canonicalTimeMs(entry.envelope.expiresAt) <= nowMs) {
        this.finishAtIndex(state, index, entry.envelope, {
          outcome: "expired",
          code: "messageExpired",
        }, now);
        changed = true;
      }
    }
    return changed;
  }

  private finishAtIndex(
    state: MutableSteeringRelayState,
    index: number,
    envelope: AuthenticatedSteeringRelayEnvelope,
    completion: CompleteSteeringRelayClaimInput,
    completedAt: string,
  ): SteeringRelayReceipt {
    state.pending.splice(index, 1);
    const receipt: SteeringRelayReceipt = {
      schemaVersion: STEERING_RELAY_SCHEMA_VERSION,
      messageId: envelope.messageId,
      producerId: envelope.producerId,
      sequence: envelope.sequence,
      envelopeSha256: envelopeSha256(envelope),
      completedAt,
      outcome: completion.outcome,
      code: completion.code,
      ...(completion.steeringId === undefined ? {} : { steeringId: completion.steeringId }),
      ...(completion.resultSha256 === undefined ? {} : { resultSha256: completion.resultSha256 }),
    };
    state.receipts.push(receipt);
    if (state.receipts.length > this.limits.maxReceipts) {
      state.receipts.splice(0, state.receipts.length - this.limits.maxReceipts);
    }
    return cloneReceipt(receipt);
  }

  private checkedNow(): string {
    const value = this.now();
    canonicalTimeMs(value);
    return value;
  }

  private emptyState(): MutableSteeringRelayState {
    return this.signState({
      schemaVersion: STEERING_RELAY_SCHEMA_VERSION,
      workspaceId: this.workspaceId,
      advertisements: [],
      pending: [],
      cursors: [],
      receipts: [],
      stateAuthTag: "",
    });
  }

  private async withState<T>(
    work: (
      state: MutableSteeringRelayState,
      existed: boolean,
    ) => Promise<{ state: MutableSteeringRelayState; value: T; unchanged?: boolean }>,
  ): Promise<T> {
    this.ensureActive();
    return serializePerFileAcrossProcesses(this.paths.statePath, async () => {
      this.ensureActive();
      const loaded = await this.readState();
      const result = await work(loaded.state, loaded.existed);
      if (!result.unchanged) await this.writeState(result.state);
      return result.value;
    });
  }

  private async readState(): Promise<{ state: MutableSteeringRelayState; existed: boolean }> {
    const file = await readFileHead(this.paths.statePath, STEERING_RELAY_LIMITS.maxStateBytes);
    if (file.truncated || file.totalBytes > STEERING_RELAY_LIMITS.maxStateBytes) {
      throw new SteeringRelayRejectedError("stateInvalid", "Private steering relay state exceeds its replay bound.");
    }
    if (!file.text.trim()) return { state: this.emptyState(), existed: false };
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch {
      throw new SteeringRelayRejectedError("stateInvalid", "Private steering relay state is malformed.");
    }
    if (!isRelayStateShape(parsed, this.limits, this.authenticationKey)) {
      throw new SteeringRelayRejectedError("stateInvalid", "Private steering relay state failed validation or authentication.");
    }
    if (parsed.workspaceId !== this.workspaceId) {
      throw new SteeringRelayRejectedError("workspaceMismatch", "Private steering relay workspace binding does not match.");
    }
    if (!authenticateState(parsed, this.authenticationKey)) {
      throw new SteeringRelayRejectedError("stateInvalid", "Private steering relay state authentication failed.");
    }
    return { state: cloneState(parsed), existed: true };
  }

  private async writeState(state: MutableSteeringRelayState): Promise<void> {
    const signed = this.signState(state);
    if (!isRelayStateShape(signed, this.limits, this.authenticationKey)) {
      throw new SteeringRelayRejectedError("stateInvalid", "Refusing to persist invalid steering relay state.");
    }
    const content = `${JSON.stringify(signed)}\n`;
    if (Buffer.byteLength(content, "utf8") > STEERING_RELAY_LIMITS.maxStateBytes) {
      throw new SteeringRelayRejectedError("stateInvalid", "Private steering relay state exceeds its write bound.");
    }
    await atomicWriteFile(this.paths.statePath, content);
    await hardenPrivateFile(this.paths.statePath);
  }

  private signState(state: MutableSteeringRelayState): MutableSteeringRelayState {
    const unsigned = {
      schemaVersion: STEERING_RELAY_SCHEMA_VERSION,
      workspaceId: state.workspaceId,
      advertisements: state.advertisements.map(cloneAdvertisement),
      pending: state.pending.map(clonePending),
      cursors: state.cursors.map((cursor) => ({ ...cursor })),
      receipts: state.receipts.map(cloneReceipt),
    };
    return {
      ...unsigned,
      stateAuthTag: stateHmac(this.authenticationKey, unsigned),
    };
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw new SteeringRelayRejectedError("disposed", "Steering relay is disposed.");
    }
  }
}

function validateAndCloneGrant(grant: SteeringRelayAuthorizationGrant): SteeringRelayAuthorizationGrant {
  if (!isBoundedIdentifier(grant.grantId)
    || (grant.source.transport !== "window" && grant.source.transport !== "telegram")
    || !isSha256(grant.source.principalSha256)
    || !isSha256(grant.workspaceId)
    || !isBoundedIdentifier(grant.destinationOwnerId)
    || !isBoundedIdentifier(grant.roomTurnId)
    || !isMissionBindingPair(grant.missionDocumentSha256, grant.missionBindingSha256)
    || !isSha256(grant.authoritySha256)
    || !Array.isArray(grant.intents)
    || grant.intents.length < 1
    || grant.intents.length > 2
    || new Set(grant.intents).size !== grant.intents.length
    || !grant.intents.every((intent) => intent === "steer" || intent === "queue")
    || !Array.isArray(grant.targets)
    || grant.targets.length < 1
    || grant.targets.length > STEERING_RELAY_LIMITS.maxAdvertisementTargets
    || !grant.targets.every(isGrantTarget)
    || new Set(grant.targets.map(grantTargetKey)).size !== grant.targets.length
    || !isCanonicalTimestamp(grant.expiresAt)) {
    throw new SteeringRelayRejectedError("invalidConfiguration", "Steering relay authorization grant is invalid.");
  }
  return {
    ...grant,
    source: { ...grant.source },
    intents: [...grant.intents],
    targets: grant.targets.map((target) => ({ ...target })),
  };
}

function isGrantTarget(value: unknown): value is SteeringRelayGrantTarget {
  const record = asRecord(value);
  return !!record
    && hasExactKeys(record, ["callId", "generation", "agentId", "selectionSha256"])
    && isBoundedIdentifier(record.callId)
    && isBoundedIdentifier(record.generation)
    && isBoundedIdentifier(record.agentId)
    && isSha256(record.selectionSha256);
}

function grantTargetKey(target: SteeringRelayGrantTarget): string {
  return `${target.callId}\u0000${target.generation}\u0000${target.agentId}\u0000${target.selectionSha256}`;
}

function validateCompletion(completion: CompleteSteeringRelayClaimInput): void {
  const validPair = (completion.outcome === "delivered" && completion.code === "acknowledged")
    || (completion.outcome === "rejected"
      && (completion.code === "controllerRejected" || completion.code === "authorizationRevoked"))
    || (completion.outcome === "deliveryUnknown"
      && (completion.code === "claimExpired" || completion.code === "handlerFailed"))
    || (completion.outcome === "expired" && completion.code === "messageExpired");
  if (!validPair
    || (completion.steeringId !== undefined && !isBoundedIdentifier(completion.steeringId))
    || (completion.resultSha256 !== undefined && !isSha256(completion.resultSha256))) {
    throw new SteeringRelayRejectedError("claimInvalid", "Steering relay completion is malformed.");
  }
}

function resolveLimits(overrides: Partial<SteeringRelayLimits> | undefined): SteeringRelayLimits {
  const limits: SteeringRelayLimits = {
    maxPendingMessages: checkedLimit(
      overrides?.maxPendingMessages,
      STEERING_RELAY_LIMITS.maxPendingMessages,
      1,
    ),
    maxPendingBytes: checkedLimit(
      overrides?.maxPendingBytes,
      STEERING_RELAY_LIMITS.maxPendingBytes,
      1,
    ),
    maxReceipts: checkedLimit(overrides?.maxReceipts, STEERING_RELAY_LIMITS.maxReceipts, 1),
    maxProducers: checkedLimit(overrides?.maxProducers, STEERING_RELAY_LIMITS.maxProducers, 1),
    maxAdvertisements: checkedLimit(
      overrides?.maxAdvertisements,
      STEERING_RELAY_LIMITS.maxAdvertisements,
      1,
    ),
    claimLeaseMs: checkedLimit(overrides?.claimLeaseMs, STEERING_RELAY_LIMITS.claimLeaseMs, 100),
  };
  return limits;
}

function checkedLimit(value: number | undefined, maximum: number, minimum: number): number {
  const resolved = value ?? maximum;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new SteeringRelayRejectedError("invalidConfiguration", "Steering relay limit override is invalid.");
  }
  return resolved;
}

function isRelayStateShape(
  value: unknown,
  limits: SteeringRelayLimits,
  authenticationKey: Uint8Array,
): value is SteeringRelayState {
  const state = asRecord(value);
  if (!state || !hasExactKeys(state, [
    "schemaVersion",
    "workspaceId",
    "advertisements",
    "pending",
    "cursors",
    "receipts",
    "stateAuthTag",
  ])) return false;
  if (state.schemaVersion !== STEERING_RELAY_SCHEMA_VERSION
    || !isSha256(state.workspaceId)
    || !Array.isArray(state.advertisements)
    || state.advertisements.length > limits.maxAdvertisements
    || !Array.isArray(state.pending)
    || state.pending.length > limits.maxPendingMessages
    || !Array.isArray(state.cursors)
    || state.cursors.length > limits.maxProducers
    || !Array.isArray(state.receipts)
    || state.receipts.length > limits.maxReceipts
    || typeof state.stateAuthTag !== "string"
    || !STATE_AUTH_TAG_PATTERN.test(state.stateAuthTag)) {
    return false;
  }
  const ownerIds = new Set<string>();
  for (const advertisement of state.advertisements) {
    if (!isSteeringRelayOwnerAdvertisement(advertisement)
      || advertisement.workspaceId !== state.workspaceId
      || canonicalTimeMs(advertisement.expiresAt) <= canonicalTimeMs(advertisement.publishedAt)
      || canonicalTimeMs(advertisement.expiresAt) - canonicalTimeMs(advertisement.publishedAt)
        > STEERING_RELAY_LIMITS.maxMessageLifetimeMs
      || ownerIds.has(advertisement.ownerId)) return false;
    ownerIds.add(advertisement.ownerId);
  }
  const messageIds = new Set<string>();
  let pendingBytes = 0;
  for (const pending of state.pending) {
    if (!isRelayMessageState(pending, authenticationKey)
      || pending.envelope.workspaceId !== state.workspaceId
      || messageIds.has(pending.envelope.messageId)) return false;
    messageIds.add(pending.envelope.messageId);
    pendingBytes += Buffer.byteLength(pending.envelope.text, "utf8");
  }
  if (pendingBytes > limits.maxPendingBytes) return false;
  const producerIds = new Set<string>();
  for (const cursor of state.cursors) {
    const record = asRecord(cursor);
    if (!record
      || !hasExactKeys(record, ["producerId", "lastSequence"])
      || !isSteeringRelayProducerId(record.producerId)
      || !isPositiveSafeInteger(record.lastSequence)
      || producerIds.has(record.producerId)) return false;
    producerIds.add(record.producerId);
  }
  const cursors = new Map(state.cursors.map((cursor) => [cursor.producerId, cursor.lastSequence]));
  for (const pending of state.pending) {
    if ((cursors.get(pending.envelope.producerId) ?? 0) < pending.envelope.sequence) return false;
    if (pending.state === "claimed"
      && (canonicalTimeMs(pending.claimExpiresAt) <= canonicalTimeMs(pending.claimedAt)
        || canonicalTimeMs(pending.claimExpiresAt) > canonicalTimeMs(pending.envelope.expiresAt))) {
      return false;
    }
  }
  for (const receipt of state.receipts) {
    if (!isSteeringRelayReceipt(receipt)
      || messageIds.has(receipt.messageId)
      || (cursors.get(receipt.producerId) ?? 0) < receipt.sequence) return false;
    messageIds.add(receipt.messageId);
  }
  return true;
}

function isRelayMessageState(value: unknown, key: Uint8Array): value is RelayMessageState {
  const record = asRecord(value);
  if (!record) return false;
  if (record.state === "pending") {
    return hasExactKeys(record, ["state", "envelope"])
      && authenticateSteeringRelayEnvelope(record.envelope, key);
  }
  return record.state === "claimed"
    && hasExactKeys(record, ["state", "claimId", "claimedAt", "claimExpiresAt", "envelope"])
    && isBoundedIdentifier(record.claimId)
    && isCanonicalTimestamp(record.claimedAt)
    && isCanonicalTimestamp(record.claimExpiresAt)
    && authenticateSteeringRelayEnvelope(record.envelope, key);
}

function authenticateState(state: SteeringRelayState, key: Uint8Array): boolean {
  const expected = stateHmac(key, {
    schemaVersion: state.schemaVersion,
    workspaceId: state.workspaceId,
    advertisements: state.advertisements,
    pending: state.pending,
    cursors: state.cursors,
    receipts: state.receipts,
  });
  if (!STATE_AUTH_TAG_PATTERN.test(state.stateAuthTag)) return false;
  return timingSafeEqual(
    Buffer.from(state.stateAuthTag, "hex"),
    Buffer.from(expected, "hex"),
  );
}

function stateHmac(
  key: Uint8Array,
  state: Omit<SteeringRelayState, "stateAuthTag">,
): string {
  return createHmac("sha256", key)
    .update(canonicalState(state), "utf8")
    .digest("hex");
}

function canonicalState(state: Omit<SteeringRelayState, "stateAuthTag">): string {
  return JSON.stringify([
    "hydra-authenticated-steering-relay-state-v1",
    state.schemaVersion,
    state.workspaceId,
    state.advertisements.map((advertisement) => [
      advertisement.ownerId,
      advertisement.workspaceId,
      advertisement.publishedAt,
      advertisement.expiresAt,
      advertisement.targets,
    ]),
    state.pending.map((pending) => pending.state === "pending"
      ? ["pending", canonicalEnvelopeWithoutTag(pending.envelope), pending.envelope.authTag]
      : [
          "claimed",
          pending.claimId,
          pending.claimedAt,
          pending.claimExpiresAt,
          canonicalEnvelopeWithoutTag(pending.envelope),
          pending.envelope.authTag,
        ]),
    state.cursors.map((cursor) => [cursor.producerId, cursor.lastSequence]),
    state.receipts.map((receipt) => [
      receipt.messageId,
      receipt.producerId,
      receipt.sequence,
      receipt.envelopeSha256,
      receipt.completedAt,
      receipt.outcome,
      receipt.code,
      receipt.steeringId ?? null,
      receipt.resultSha256 ?? null,
    ]),
  ]);
}

function canonicalEnvelopeWithoutTag(envelope: AuthenticatedSteeringRelayEnvelope): string {
  const { authTag: _authTag, ...unsigned } = envelope;
  return canonicalEnvelope(unsigned);
}

function envelopeSha256(envelope: AuthenticatedSteeringRelayEnvelope): string {
  return sha256Utf8(canonicalEnvelopeWithoutTag(envelope));
}

function cloneState(state: SteeringRelayState): MutableSteeringRelayState {
  return {
    schemaVersion: state.schemaVersion,
    workspaceId: state.workspaceId,
    advertisements: state.advertisements.map(cloneAdvertisement),
    pending: state.pending.map(clonePending),
    cursors: state.cursors.map((cursor) => ({ ...cursor })),
    receipts: state.receipts.map(cloneReceipt),
    stateAuthTag: state.stateAuthTag,
  };
}

function cloneAdvertisement(advertisement: SteeringRelayOwnerAdvertisement): SteeringRelayOwnerAdvertisement {
  return {
    ...advertisement,
    targets: advertisement.targets.map(cloneTargetSelection),
  };
}

function clonePending(pending: RelayMessageState): RelayMessageState {
  return pending.state === "pending"
    ? { state: "pending", envelope: cloneEnvelope(pending.envelope) }
    : {
        state: "claimed",
        claimId: pending.claimId,
        claimedAt: pending.claimedAt,
        claimExpiresAt: pending.claimExpiresAt,
        envelope: cloneEnvelope(pending.envelope),
      };
}

function cloneEnvelope(envelope: AuthenticatedSteeringRelayEnvelope): AuthenticatedSteeringRelayEnvelope {
  return {
    ...envelope,
    source: { ...envelope.source },
    targets: envelope.targets.map(cloneTargetSelection),
  };
}

function cloneReceipt(receipt: SteeringRelayReceipt): SteeringRelayReceipt {
  return { ...receipt };
}

function cloneOptionalReceipt(receipt: SteeringRelayReceipt | undefined): SteeringRelayReceipt | undefined {
  return receipt ? cloneReceipt(receipt) : undefined;
}

function canonicalTimeMs(value: string): number {
  if (!isCanonicalTimestamp(value)) {
    throw new SteeringRelayRejectedError("invalidEnvelope", "Steering relay timestamp is not canonical.");
  }
  return Date.parse(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SteeringRelayRejectedError("stateInvalid", "Private steering relay path is not a directory.");
  }
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
}

async function hardenPrivateFile(filePath: string): Promise<void> {
  if (process.platform !== "win32") await fs.chmod(filePath, 0o600);
}
