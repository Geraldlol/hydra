import { randomUUID } from "node:crypto";
import {
  MISSION_CONTRACT_SCHEMA_VERSION,
  missionContractSha256,
  normalizeMissionContract,
  type MissionContractAgentProposalSource,
  type MissionContractBinding,
  type MissionContractDocument,
  type MissionContractEvent,
  type MissionContractProposalState,
  type MissionContractProposedEvent,
  type MissionContractSnapshot,
} from "./missionContract";
import {
  assertCurrentMissionContractBinding,
  inspectMissionContractLedger,
  loadMissionContractLedger,
  MissionContractBindingConflictError,
  MissionContractLedgerError,
  mutateMissionContractLedger,
  privateMissionContractLedgerPath,
  withCurrentMissionContractBinding,
  writeMissionContractMirror,
  type MissionContractLedgerState,
} from "./missionContractStore";

export type MissionContractIdKind =
  | "event"
  | "mission"
  | "proposal"
  | "confirmation"
  | "dismissal"
  | "retirement";

export interface MissionContractLifecycleNotice {
  type: MissionContractEvent["type"];
  eventId: string;
  occurredAt: string;
  missionId?: string;
  proposalId?: string;
  documentSha256?: string;
  bindingSha256?: string;
  revision?: number;
  sourceKind?: "localUser" | "agent";
}

export interface MissionContractControllerDependencies {
  privateWorkspaceRoot: string;
  mirrorPath?: string;
  now?: () => string;
  newId?: (kind: MissionContractIdKind) => string;
  onSnapshot?: (snapshot: MissionContractSnapshot) => void;
  onLifecycleEvent?: (notice: MissionContractLifecycleNotice) => void;
  onMirrorError?: (error: Error) => void;
}

export type MissionContractControllerStatus =
  | {
      status: "ready";
      binding: MissionContractBinding;
    }
  | {
      status: "corrupt";
      error: MissionContractLedgerError;
    }
  | {
      status: "unavailable";
      error: Error;
    };

export interface MissionContractMutationResult {
  snapshot: MissionContractSnapshot;
  event: MissionContractEvent;
  mirrorUpdated: boolean;
  mirrorError?: Error;
}

export interface RecordLocalMissionContractProposalInput {
  missionId?: string;
  expectedBaseBindingSha256: string;
  expectedDocumentSha256?: string;
  contract: MissionContractDocument | unknown;
}

export interface AdmitAgentMissionContractProposalInput {
  missionId?: string;
  expectedBaseBindingSha256: string;
  expectedDocumentSha256: string;
  contract: MissionContractDocument | unknown;
  source: Omit<MissionContractAgentProposalSource, "kind">;
}

export interface ConfirmMissionContractProposalInput {
  proposalId: string;
  expectedDocumentSha256: string;
  expectedBaseBindingSha256: string;
}

export interface DismissMissionContractProposalInput {
  proposalId: string;
  expectedDocumentSha256: string;
  reason: string;
}

export interface RetireMissionContractInput {
  expectedMissionId: string;
  expectedRevision: number;
  expectedDocumentSha256: string;
  expectedBindingSha256: string;
  reason: string;
}

export type TryOpenMissionContractControllerResult =
  | {
      status: "ready";
      controller: MissionContractController;
    }
  | {
      status: "corrupt";
      error: MissionContractLedgerError;
    };

export class MissionContractController {
  public readonly ledgerPath: string;
  private ledgerState: MissionContractLedgerState;
  private unavailableError: Error | undefined;
  private readonly now: () => string;
  private readonly newId: (kind: MissionContractIdKind) => string;

  private constructor(
    private readonly deps: MissionContractControllerDependencies,
    state: MissionContractLedgerState,
  ) {
    this.ledgerPath = privateMissionContractLedgerPath(deps.privateWorkspaceRoot);
    this.ledgerState = state;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? ((kind) => `${kind}-${randomUUID()}`);
  }

  static async open(deps: MissionContractControllerDependencies): Promise<MissionContractController> {
    const ledgerPath = privateMissionContractLedgerPath(deps.privateWorkspaceRoot);
    const state = await loadMissionContractLedger(ledgerPath);
    const controller = new MissionContractController(deps, state);
    await controller.publishSnapshotAndMirror();
    return controller;
  }

  static async tryOpen(
    deps: MissionContractControllerDependencies,
  ): Promise<TryOpenMissionContractControllerResult> {
    const ledgerPath = privateMissionContractLedgerPath(deps.privateWorkspaceRoot);
    const inspection = await inspectMissionContractLedger(ledgerPath);
    if (inspection.status === "corrupt") return inspection;
    const controller = new MissionContractController(deps, inspection.state);
    await controller.publishSnapshotAndMirror();
    return { status: "ready", controller };
  }

  getStatus(): MissionContractControllerStatus {
    if (this.unavailableError) {
      if (this.unavailableError instanceof MissionContractLedgerError
        && this.unavailableError.code === "corrupt") {
        return { status: "corrupt", error: this.unavailableError };
      }
      return { status: "unavailable", error: this.unavailableError };
    }
    return {
      status: "ready",
      binding: structuredClone(this.ledgerState.snapshot.binding),
    };
  }

  currentSnapshot(): MissionContractSnapshot {
    this.assertAvailable();
    return structuredClone(this.ledgerState.snapshot);
  }

  currentBinding(): MissionContractBinding {
    this.assertAvailable();
    return structuredClone(this.ledgerState.snapshot.binding);
  }

  currentBindingSha256(): string {
    this.assertAvailable();
    return this.ledgerState.snapshot.binding.bindingSha256;
  }

  currentDocumentSha256(): string | null {
    this.assertAvailable();
    return this.ledgerState.snapshot.binding.documentSha256;
  }

  async refresh(): Promise<MissionContractSnapshot> {
    try {
      const state = await loadMissionContractLedger(this.ledgerPath);
      this.ledgerState = state;
      this.unavailableError = undefined;
      await this.publishSnapshotAndMirror();
      return this.currentSnapshot();
    } catch (error) {
      this.unavailableError = asError(error);
      throw error;
    }
  }

  /**
   * Strict freshness check under the ledger's cross-process lease. Valid
   * unbound and corrupt states are never conflated.
   */
  async assertCurrentBinding(expectedBindingSha256: string): Promise<MissionContractBinding> {
    try {
      return await assertCurrentMissionContractBinding(this.ledgerPath, expectedBindingSha256);
    } catch (error) {
      this.markCorruptIfNeeded(error);
      throw error;
    }
  }

  /**
   * Holds the ledger lease across a short irreversible provider submission or
   * steering write so confirmation cannot linearize between check and submit.
   */
  async withCurrentBinding<T>(
    expectedBindingSha256: string,
    submit: (binding: MissionContractBinding) => Promise<T>,
  ): Promise<T> {
    try {
      return await withCurrentMissionContractBinding(this.ledgerPath, expectedBindingSha256, submit);
    } catch (error) {
      this.markCorruptIfNeeded(error);
      throw error;
    }
  }

  async recordLocalProposal(
    input: RecordLocalMissionContractProposalInput,
  ): Promise<MissionContractMutationResult> {
    const contract = normalizeMissionContract(input.contract);
    const documentSha256 = missionContractSha256(contract);
    if (input.expectedDocumentSha256 && input.expectedDocumentSha256 !== documentSha256) {
      throw new MissionContractBindingConflictError(input.expectedDocumentSha256, documentSha256);
    }
    const eventId = this.newId("event");
    const proposalId = this.newId("proposal");
    const occurredAt = this.now();
    return this.appendOne((state) => {
      this.assertExpectedBase(state, input.expectedBaseBindingSha256);
      const missionId = input.missionId
        ?? (state.snapshot.binding.state === "active"
          ? state.snapshot.binding.missionId
          : this.newId("mission"));
      const event: MissionContractProposedEvent = {
        schemaVersion: MISSION_CONTRACT_SCHEMA_VERSION,
        type: "missionContractProposed",
        eventId,
        occurredAt,
        missionId,
        proposalId,
        baseBindingSha256: state.snapshot.binding.bindingSha256,
        proposedBy: { kind: "localUser", actorId: "local-user" },
        admittedBy: { actorId: "local-user", action: "Record Local Mission Contract Proposal" },
        documentSha256,
        contract,
      };
      return event;
    });
  }

  /**
   * The only authoritative path for an agent candidate. Parsing stays
   * ephemeral until the user performs this separate admission action.
   */
  async admitAgentProposalAfterLocalApproval(
    input: AdmitAgentMissionContractProposalInput,
  ): Promise<MissionContractMutationResult> {
    const contract = normalizeMissionContract(input.contract);
    const documentSha256 = missionContractSha256(contract);
    if (input.expectedDocumentSha256 !== documentSha256) {
      throw new MissionContractBindingConflictError(input.expectedDocumentSha256, documentSha256);
    }
    const eventId = this.newId("event");
    const proposalId = this.newId("proposal");
    const occurredAt = this.now();
    return this.appendOne((state) => {
      this.assertExpectedBase(state, input.expectedBaseBindingSha256);
      const missionId = input.missionId
        ?? (state.snapshot.binding.state === "active"
          ? state.snapshot.binding.missionId
          : this.newId("mission"));
      const event: MissionContractProposedEvent = {
        schemaVersion: MISSION_CONTRACT_SCHEMA_VERSION,
        type: "missionContractProposed",
        eventId,
        occurredAt,
        missionId,
        proposalId,
        baseBindingSha256: state.snapshot.binding.bindingSha256,
        proposedBy: {
          kind: "agent",
          agentId: input.source.agentId,
          callId: input.source.callId,
          messageId: input.source.messageId,
          responseSha256: input.source.responseSha256,
        },
        admittedBy: { actorId: "local-user", action: "Admit Agent Mission Contract Proposal" },
        documentSha256,
        contract,
      };
      return event;
    });
  }

  async confirmProposalAfterLocalApproval(
    input: ConfirmMissionContractProposalInput,
  ): Promise<MissionContractMutationResult> {
    const eventId = this.newId("event");
    const confirmationId = this.newId("confirmation");
    const occurredAt = this.now();
    return this.appendOne((state) => {
      this.assertExpectedBase(state, input.expectedBaseBindingSha256);
      const proposal = requirePendingProposal(state.snapshot, input.proposalId);
      if (proposal.proposal.documentSha256 !== input.expectedDocumentSha256) {
        throw new MissionContractBindingConflictError(
          input.expectedDocumentSha256,
          proposal.proposal.documentSha256,
        );
      }
      const revision = state.snapshot.binding.state === "active"
        ? state.snapshot.binding.revision + 1
        : 1;
      return {
        schemaVersion: MISSION_CONTRACT_SCHEMA_VERSION,
        type: "missionContractConfirmed",
        eventId,
        occurredAt,
        missionId: proposal.proposal.missionId,
        proposalId: proposal.proposal.proposalId,
        confirmationId,
        documentSha256: proposal.proposal.documentSha256,
        previousBindingSha256: state.snapshot.binding.bindingSha256,
        revision,
        confirmedBy: "local-user",
      };
    });
  }

  async dismissProposalAfterLocalApproval(
    input: DismissMissionContractProposalInput,
  ): Promise<MissionContractMutationResult> {
    const eventId = this.newId("event");
    const dismissalId = this.newId("dismissal");
    const occurredAt = this.now();
    return this.appendOne((state) => {
      const proposal = requirePendingProposal(state.snapshot, input.proposalId);
      if (proposal.proposal.documentSha256 !== input.expectedDocumentSha256) {
        throw new MissionContractBindingConflictError(
          input.expectedDocumentSha256,
          proposal.proposal.documentSha256,
        );
      }
      return {
        schemaVersion: MISSION_CONTRACT_SCHEMA_VERSION,
        type: "missionContractProposalDismissed",
        eventId,
        occurredAt,
        proposalId: proposal.proposal.proposalId,
        dismissalId,
        dismissedBy: "local-user",
        reason: input.reason,
      };
    });
  }

  async retireActiveAfterLocalApproval(
    input: RetireMissionContractInput,
  ): Promise<MissionContractMutationResult> {
    const eventId = this.newId("event");
    const retirementId = this.newId("retirement");
    const occurredAt = this.now();
    return this.appendOne((state) => {
      const binding = state.snapshot.binding;
      if (binding.state !== "active") {
        throw new MissionContractBindingConflictError(
          input.expectedBindingSha256,
          binding.bindingSha256,
        );
      }
      if (binding.bindingSha256 !== input.expectedBindingSha256
        || binding.documentSha256 !== input.expectedDocumentSha256
        || binding.missionId !== input.expectedMissionId
        || binding.revision !== input.expectedRevision) {
        throw new MissionContractBindingConflictError(
          input.expectedBindingSha256,
          binding.bindingSha256,
        );
      }
      return {
        schemaVersion: MISSION_CONTRACT_SCHEMA_VERSION,
        type: "missionContractRetired",
        eventId,
        occurredAt,
        missionId: binding.missionId,
        retirementId,
        documentSha256: binding.documentSha256,
        bindingSha256: binding.bindingSha256,
        revision: binding.revision,
        retiredBy: "local-user",
        reason: input.reason,
      };
    });
  }

  private async appendOne(
    build: (state: Readonly<MissionContractLedgerState>) => MissionContractEvent,
  ): Promise<MissionContractMutationResult> {
    try {
      const mutation = await mutateMissionContractLedger(this.ledgerPath, (state) => [build(state)]);
      const event = mutation.appended[0];
      if (!event) throw new Error("Mission Contract append unexpectedly produced no event.");
      this.ledgerState = {
        events: mutation.events,
        snapshot: mutation.snapshot,
        byteLength: -1,
      };
      this.unavailableError = undefined;
      const mirror = await this.publishSnapshotAndMirror();
      this.emitLifecycleNotice(event);
      return {
        snapshot: this.currentSnapshot(),
        event: structuredClone(event),
        mirrorUpdated: mirror.updated,
        ...(mirror.error ? { mirrorError: mirror.error } : {}),
      };
    } catch (error) {
      this.markCorruptIfNeeded(error);
      throw error;
    }
  }

  private assertExpectedBase(
    state: Readonly<MissionContractLedgerState>,
    expectedBindingSha256: string,
  ): void {
    const actual = state.snapshot.binding.bindingSha256;
    if (actual !== expectedBindingSha256) {
      throw new MissionContractBindingConflictError(expectedBindingSha256, actual);
    }
  }

  private assertAvailable(): void {
    if (this.unavailableError) {
      throw new Error(
        "Mission Contract controller is unavailable; strict refresh is required before bound work.",
        { cause: this.unavailableError },
      );
    }
  }

  private markCorruptIfNeeded(error: unknown): void {
    if (error instanceof MissionContractLedgerError && error.code === "corrupt") {
      this.unavailableError = error;
    }
  }

  private async publishSnapshotAndMirror(): Promise<{ updated: boolean; error?: Error }> {
    try {
      this.deps.onSnapshot?.(structuredClone(this.ledgerState.snapshot));
    } catch {
      // Observers cannot roll back or invalidate already-durable authority state.
    }
    if (!this.deps.mirrorPath) return { updated: false };
    try {
      await writeMissionContractMirror(
        this.deps.mirrorPath,
        this.ledgerState.snapshot,
        this.now(),
      );
      return { updated: true };
    } catch (error) {
      const mirrorError = asError(error);
      try {
        this.deps.onMirrorError?.(mirrorError);
      } catch {
        // Error observers are advisory.
      }
      return { updated: false, error: mirrorError };
    }
  }

  private emitLifecycleNotice(event: MissionContractEvent): void {
    const notice: MissionContractLifecycleNotice = {
      type: event.type,
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      ...("missionId" in event ? { missionId: event.missionId } : {}),
      ...("proposalId" in event ? { proposalId: event.proposalId } : {}),
      ...("documentSha256" in event ? { documentSha256: event.documentSha256 } : {}),
      ...(event.type === "missionContractRetired" ? { bindingSha256: event.bindingSha256 } : {}),
      ...("revision" in event ? { revision: event.revision } : {}),
      ...(event.type === "missionContractProposed" ? { sourceKind: event.proposedBy.kind } : {}),
    };
    try {
      this.deps.onLifecycleEvent?.(notice);
    } catch {
      // Observers cannot change durable state.
    }
  }
}

export async function openMissionContractController(
  deps: MissionContractControllerDependencies,
): Promise<MissionContractController> {
  return MissionContractController.open(deps);
}

export async function tryOpenMissionContractController(
  deps: MissionContractControllerDependencies,
): Promise<TryOpenMissionContractControllerResult> {
  return MissionContractController.tryOpen(deps);
}

function requirePendingProposal(
  snapshot: MissionContractSnapshot,
  proposalId: string,
): MissionContractProposalState {
  const proposal = snapshot.proposals.find((candidate) => candidate.proposal.proposalId === proposalId);
  if (!proposal) throw new Error(`Unknown Mission Contract proposal ${proposalId}.`);
  if (proposal.status !== "pending") {
    throw new Error(`Mission Contract proposal ${proposalId} is ${proposal.status}, not pending.`);
  }
  return proposal;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
