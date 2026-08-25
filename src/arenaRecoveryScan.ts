import { createHash } from "node:crypto";
import { loadArenaDispatchGenerations } from "./arenaDispatchReceipts";
import { loadArenaPromotionReceipts } from "./arenaPromotionStore";
import { classifyArenaRecovery, type ArenaRecoveryState } from "./arenaRecovery";
import { canonicalArenaManifestJson } from "./arenaRunManifest";
import { openFileArenaManifestStore } from "./arenaStore";
import type { ArenaManifestReplay } from "./arenaRunManifest";

export type ArenaRecoveryScanEntry =
  | {
      readonly runId: string;
      readonly status: "classified";
      readonly recovery: ArenaRecoveryState;
    }
  | {
      readonly runId: string;
      readonly status: "manifestInvalid";
      readonly errorSha256: string;
    };

export interface ArenaRecoveryScanDependencies {
  readonly openManifestStore: (privateWorkspaceRoot: string) => Promise<{
    listRunIds(): Promise<readonly string[]>;
    load(runId: string): Promise<ArenaManifestReplay | undefined>;
  }>;
  readonly loadDispatchGenerations: typeof loadArenaDispatchGenerations;
  readonly loadPromotionReceipts: typeof loadArenaPromotionReceipts;
}

const DEFAULT_DEPENDENCIES: ArenaRecoveryScanDependencies = Object.freeze({
  openManifestStore: openFileArenaManifestStore,
  loadDispatchGenerations: loadArenaDispatchGenerations,
  loadPromotionReceipts: loadArenaPromotionReceipts,
});

/** Read-only authority scan. It never resumes, aborts, takes a lease, or
 * reapplies an interrupted promotion; those remain explicit operator actions. */
export async function scanArenaRecovery(
  privateWorkspaceRoot: string,
  dependencies: ArenaRecoveryScanDependencies = DEFAULT_DEPENDENCIES,
): Promise<readonly ArenaRecoveryScanEntry[]> {
  const store = await dependencies.openManifestStore(privateWorkspaceRoot);
  const runIds = await store.listRunIds();
  const entries: ArenaRecoveryScanEntry[] = [];
  for (const runId of runIds) {
    let replay;
    try {
      replay = await store.load(runId);
      if (!replay) throw new Error("Arena indexed run has no manifest replay.");
    } catch (error) {
      entries.push(Object.freeze({
        runId,
        status: "manifestInvalid" as const,
        errorSha256: errorDigest("manifest", error),
      }));
      continue;
    }
    let generations = [] as Awaited<ReturnType<
      typeof loadArenaDispatchGenerations
    >>;
    let interruptedPromotionIds: readonly string[] = [];
    const supportErrors: { readonly component: string; readonly sha256: string }[] = [];
    try {
      generations = await dependencies.loadDispatchGenerations(
        privateWorkspaceRoot,
        runId,
      );
    } catch (error) {
      supportErrors.push({
        component: "dispatch",
        sha256: errorDigest("dispatch", error),
      });
    }
    try {
      const promotions = await dependencies.loadPromotionReceipts(
        privateWorkspaceRoot,
        runId,
      );
      interruptedPromotionIds = promotions.flatMap((promotion) =>
        promotion.state === "interrupted" ? [promotion.promotionId] : []);
    } catch (error) {
      supportErrors.push({
        component: "promotion",
        sha256: errorDigest("promotion", error),
      });
    }
    supportErrors.sort((left, right) => Buffer.compare(
      Buffer.from(left.component, "utf8"),
      Buffer.from(right.component, "utf8"),
    ));
    const supportStateErrorSha256 = supportErrors.length === 0
      ? null
      : createHash("sha256")
        .update("hydra.arena.recovery-scan.v1.support-errors\0", "utf8")
        .update(canonicalArenaManifestJson(supportErrors), "utf8")
        .digest("hex");
    entries.push(Object.freeze({
      runId,
      status: "classified" as const,
      recovery: classifyArenaRecovery({
        replay,
        generations: generations.map((state) => state.generation),
        interruptedPromotionIds,
        supportStateErrorSha256,
      }),
    }));
  }
  entries.sort((left, right) => Buffer.compare(
    Buffer.from(left.runId, "utf8"),
    Buffer.from(right.runId, "utf8"),
  ));
  return Object.freeze(entries);
}

function errorDigest(component: string, error: unknown): string {
  const name = error instanceof Error ? error.name : "NonError";
  const message = error instanceof Error ? error.message : String(error);
  return createHash("sha256")
    .update("hydra.arena.recovery-scan.v1.error\0", "utf8")
    .update(canonicalArenaManifestJson({ component, name, message }), "utf8")
    .digest("hex");
}
