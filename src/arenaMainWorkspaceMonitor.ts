import { createHash, randomUUID } from "node:crypto";
import {
  canonicalArenaManifestJson,
  type ArenaGitObjectId,
  type ArenaMainWorkspaceObservedPayload,
  type ArenaWorkspaceObservationKind,
  type ArenaWorkspaceObservationReason,
} from "./arenaRunManifest";
import {
  watchDuelWorkspaceMutations,
  type DuelWorkspaceMutationMonitor,
} from "./duelWorkspaceGuard";

export interface ArenaMainWorkspaceBaseline {
  readonly runId: string;
  readonly sourceWorkspaceFingerprintSha256: string;
  readonly repositoryControlSha256: string;
  readonly head: ArenaGitObjectId;
}

export interface ArenaMainWorkspaceReceipt {
  readonly schemaVersion: 1;
  readonly receiptType: "arenaMainWorkspaceObservation";
  readonly runId: string;
  readonly epochId: string;
  readonly observationCount: number;
  readonly kind: ArenaWorkspaceObservationKind;
  readonly status: ArenaMainWorkspaceObservedPayload["status"];
  readonly reasonCode: ArenaWorkspaceObservationReason | null;
  readonly watcherChanged: boolean;
  readonly changedPathsSha256: string;
  readonly errorSha256: string | null;
  readonly sourceWorkspaceFingerprintSha256: string | null;
  readonly repositoryControlSha256: string | null;
  readonly head: ArenaGitObjectId | null;
  readonly receiptSha256: string;
}

export interface ArenaMainWorkspaceSnapshot {
  readonly sourceWorkspaceFingerprintSha256: string;
  readonly repositoryControlSha256: string;
  readonly head: ArenaGitObjectId;
}

export interface ArenaMainWorkspaceMonitor {
  readonly epochId: string;
  readonly compromised: boolean;
  observe(
    kind: ArenaWorkspaceObservationKind,
  ): Promise<ArenaMainWorkspaceObservedPayload>;
  close(): void;
}

export interface ArenaMainWorkspaceMonitorDependencies {
  readonly watch?: (
    workspaceRoot: string,
  ) => DuelWorkspaceMutationMonitor;
  readonly randomId?: () => string;
  readonly persistReceipt?: (
    receipt: ArenaMainWorkspaceReceipt,
  ) => void | Promise<void>;
}

/**
 * Starts the recursive sentinel synchronously before returning. Callers must
 * create this object before provisioning or any provider dispatch and append
 * the first `monitorStarted` observation before proceeding.
 */
export function startArenaMainWorkspaceMonitor(
  workspaceRoot: string,
  baseline: ArenaMainWorkspaceBaseline,
  captureSnapshot: () => Promise<ArenaMainWorkspaceSnapshot>,
  dependencies: ArenaMainWorkspaceMonitorDependencies = {},
): ArenaMainWorkspaceMonitor {
  assertDigest(baseline.sourceWorkspaceFingerprintSha256);
  assertDigest(baseline.repositoryControlSha256);
  assertObjectId(baseline.head);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(baseline.runId)) {
    throw new Error("Arena main-workspace run ID is invalid.");
  }
  const watcher = (dependencies.watch ?? watchDuelWorkspaceMutations)(
    workspaceRoot,
  );
  const epochId = `arena-monitor-${
    (dependencies.randomId ?? randomUUID)()
  }`;
  let closed = false;
  let compromised = false;
  let observationCount = 0;

  return {
    epochId,
    get compromised() {
      return compromised;
    },
    async observe(kind) {
      if (closed) {
        throw new Error("Arena main-workspace monitor is closed.");
      }
      if (!["monitorStarted", "checkpoint", "postEvidence"].includes(kind)) {
        throw new Error("Arena main-workspace observation kind is invalid.");
      }
      if ((observationCount === 0) !== (kind === "monitorStarted")) {
        throw new Error(
          observationCount === 0
            ? "Arena monitor must begin with monitorStarted."
            : "Arena monitorStarted may be recorded only once.",
        );
      }
      observationCount += 1;
      await watcher.settle();

      let snapshot: ArenaMainWorkspaceSnapshot | undefined;
      let reasonCode: ArenaWorkspaceObservationReason | null = null;
      let status: ArenaMainWorkspaceObservedPayload["status"] = "unchanged";
      try {
        snapshot = await captureSnapshot();
        assertDigest(snapshot.sourceWorkspaceFingerprintSha256);
        assertDigest(snapshot.repositoryControlSha256);
        assertObjectId(snapshot.head);
      } catch {
        status = "unverifiable";
        reasonCode = watcher.error ? "monitorFailed" : "fingerprintFailed";
      }

      // The manifest schema separates a definite path event from a failed
      // watcher. `DuelWorkspaceMutationMonitor.changed` includes both, so do
      // not mislabel monitor failure as a witnessed mutation.
      const watcherChanged = watcher.error === undefined && watcher.changed;
      if (snapshot) {
        if (watcher.error) {
          status = "unverifiable";
          reasonCode = "monitorFailed";
        } else if (watcherChanged) {
          status = "changed";
          reasonCode = "watcherChanged";
        } else if (snapshot.sourceWorkspaceFingerprintSha256
            !== baseline.sourceWorkspaceFingerprintSha256) {
          status = "changed";
          reasonCode = "workspaceFingerprintChanged";
        } else if (!sameObjectId(snapshot.head, baseline.head)) {
          status = "changed";
          reasonCode = "headChanged";
        } else if (snapshot.repositoryControlSha256
            !== baseline.repositoryControlSha256) {
          status = "changed";
          reasonCode = "repositoryControlChanged";
        }
      }
      compromised ||= status !== "unchanged";

      const changedPathsSha256 = hash(
        "hydra.arena.monitor.changed-paths.v1\u0000",
        watcher.changedPaths,
      );
      const errorSha256 = watcher.error
        ? hash("hydra.arena.monitor.error.v1\u0000", watcher.error)
        : null;
      const receiptBody = {
        schemaVersion: 1 as const,
        receiptType: "arenaMainWorkspaceObservation" as const,
        runId: baseline.runId,
        epochId,
        observationCount,
        kind,
        status,
        reasonCode,
        watcherChanged,
        changedPathsSha256,
        errorSha256,
        sourceWorkspaceFingerprintSha256:
          snapshot?.sourceWorkspaceFingerprintSha256 ?? null,
        repositoryControlSha256:
          snapshot?.repositoryControlSha256 ?? null,
        head: snapshot?.head ?? null,
      };
      const receiptSha256 = hash(
        "hydra.arena.monitor.receipt.v1\u0000",
        receiptBody,
      );
      const receipt: ArenaMainWorkspaceReceipt = Object.freeze({
        ...receiptBody,
        receiptSha256,
      });
      await dependencies.persistReceipt?.(receipt);
      return Object.freeze({
        payloadType: "mainWorkspaceObserved",
        observationKind: kind,
        monitorEpochId: epochId,
        monitorReceiptSha256: receiptSha256,
        status,
        sourceWorkspaceFingerprintSha256:
          snapshot?.sourceWorkspaceFingerprintSha256 ?? null,
        repositoryControlSha256:
          snapshot?.repositoryControlSha256 ?? null,
        head: snapshot?.head ?? null,
        watcherChanged,
        reasonCode,
      });
    },
    close() {
      if (closed) return;
      closed = true;
      watcher.close();
    },
  };
}

function sameObjectId(
  left: ArenaGitObjectId,
  right: ArenaGitObjectId,
): boolean {
  return left.objectFormat === right.objectFormat && left.oid === right.oid;
}

function hash(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(canonicalArenaManifestJson(value), "utf8")
    .digest("hex");
}

function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("Arena main-workspace digest is invalid.");
  }
}

function assertObjectId(value: ArenaGitObjectId): void {
  if ((value.objectFormat !== "sha1" && value.objectFormat !== "sha256")
    || !new RegExp(`^[a-f0-9]{${
      value.objectFormat === "sha1" ? 40 : 64
    }}$`, "u").test(value.oid)) {
    throw new Error("Arena main-workspace Git object ID is invalid.");
  }
}
