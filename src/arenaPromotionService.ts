import type { ArenaGitAdmission, ArenaGitExecutor } from "./arenaGit";
import { verifyArenaArtifactSet } from "./arenaEvidence";
import {
  createArenaPromotionPreview,
  executeArenaPromotion,
  type ArenaPromotionConfirmation,
  type ArenaPromotionMissionDecision,
  type ArenaPromotionPreview,
  type ArenaPromotionResultReceipt,
} from "./arenaPromotion";
import { loadArenaPromotionCandidate } from "./arenaPromotionCandidate";
import {
  persistArenaPromotionIntent,
  persistArenaPromotionResult,
} from "./arenaPromotionStore";
import type { ArenaReveal, ArenaWinnerSelection } from "./arenaProduct";
import type {
  ArenaEvidencePreservedPayload,
  ArenaManifestReplay,
} from "./arenaRunManifest";

export async function prepareArenaPromotionWithGit(input: {
  readonly privateWorkspaceRoot: string;
  readonly executor: ArenaGitExecutor;
  readonly admission: ArenaGitAdmission;
  readonly replay: ArenaManifestReplay;
  readonly reveal: ArenaReveal;
  readonly selection: ArenaWinnerSelection;
  readonly promotionId: string;
  readonly occurredAt: string;
  readonly missionDecision: ArenaPromotionMissionDecision;
}): Promise<ArenaPromotionPreview> {
  const evidence = requiredEvidence(
    input.replay,
    input.selection.contestantId,
  );
  const candidate = await loadArenaPromotionCandidate({
    privateWorkspaceRoot: input.privateWorkspaceRoot,
    runId: input.replay.runId,
    contestantId: input.selection.contestantId,
    payload: evidence,
  });
  const [workspace, patchCheck] = await Promise.all([
    input.executor.inspectPromotionWorkspace(
      input.admission,
      input.replay.runId,
    ),
    input.executor.checkPromotionCandidate(candidate),
  ]);
  return createArenaPromotionPreview({
    replay: input.replay,
    reveal: input.reveal,
    selection: input.selection,
    promotionId: input.promotionId,
    occurredAt: input.occurredAt,
    missionDecision: input.missionDecision,
    workspace,
    patchCheck,
  });
}

export async function executeArenaPromotionWithGit(input: {
  readonly privateWorkspaceRoot: string;
  readonly executor: ArenaGitExecutor;
  readonly admission: ArenaGitAdmission;
  readonly preview: ArenaPromotionPreview;
  readonly confirmation: ArenaPromotionConfirmation;
  readonly loadReplay: () => Promise<ArenaManifestReplay>;
  readonly now?: () => Date;
}): Promise<ArenaPromotionResultReceipt> {
  return input.executor.runPromotionExclusive(input.admission, () =>
    executeArenaPromotion({
    preview: input.preview,
    confirmation: input.confirmation,
    loadReplay: input.loadReplay,
    inspectWorkspace: () => input.executor.inspectPromotionWorkspace(
      input.admission,
      input.preview.runId,
    ),
    verifyArtifactSet: async (replay, contestantId) => {
      await verifyArenaArtifactSet({
        privateWorkspaceRoot: input.privateWorkspaceRoot,
        runId: replay.runId,
        contestantId,
        payload: requiredEvidence(replay, contestantId),
      });
    },
    checkPatch: async (replay, contestantId) => {
      const candidate = await loadArenaPromotionCandidate({
        privateWorkspaceRoot: input.privateWorkspaceRoot,
        runId: replay.runId,
        contestantId,
        payload: requiredEvidence(replay, contestantId),
      });
      return input.executor.checkPromotionCandidate(candidate);
    },
    persistIntent: (receipt) => persistArenaPromotionIntent(
      input.privateWorkspaceRoot,
      receipt,
    ).then(() => undefined),
    applyCandidate: async (replay, contestantId) => {
      const candidate = await loadArenaPromotionCandidate({
        privateWorkspaceRoot: input.privateWorkspaceRoot,
        runId: replay.runId,
        contestantId,
        payload: requiredEvidence(replay, contestantId),
      });
      await input.executor.applyPromotionCandidate(candidate);
    },
    persistResult: (receipt) => persistArenaPromotionResult(
      input.privateWorkspaceRoot,
      receipt,
    ).then(() => undefined),
    ...(input.now ? { now: input.now } : {}),
    }));
}

function requiredEvidence(
  replay: ArenaManifestReplay,
  contestantId: string,
): ArenaEvidencePreservedPayload {
  const contestant = replay.contestants.find((candidate) =>
    candidate.lock.contestantId === contestantId);
  if (!contestant?.evidencePreserved
    || contestant.evidencePreserved.type !== "arenaEvidencePreserved"
    || contestant.evidencePreserved.payload.payloadType
      !== "evidencePreserved") {
    throw new Error("Arena promotion contestant lacks retained evidence.");
  }
  return contestant.evidencePreserved.payload as ArenaEvidencePreservedPayload;
}
