import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { ArenaGitExecutor } from "./arenaGit";
import {
  createArenaPromotionConfirmation,
  newArenaPromotionId,
} from "./arenaPromotion";
import {
  executeArenaPromotionWithGit,
  prepareArenaPromotionWithGit,
} from "./arenaPromotionService";
import {
  loadArenaPromotionCandidate,
  renderArenaPromotionCandidateMarkdown,
} from "./arenaPromotionCandidate";
import {
  createArenaReveal,
  createArenaSynthesisRequest,
  createArenaWinnerSelection,
  renderArenaRevealMarkdown,
  type ArenaWinnerSelection,
} from "./arenaProduct";
import {
  loadArenaProductReceipts,
  persistArenaProductReceipt,
} from "./arenaProductStore";
import { requireArenaRecoveryAction } from "./arenaRecovery";
import { scanArenaRecovery, type ArenaRecoveryScanEntry } from "./arenaRecoveryScan";
import { openFileArenaManifestStore } from "./arenaStore";
import type {
  ArenaEvidencePreservedPayload,
  ArenaManifestReplay,
} from "./arenaRunManifest";

/**
 * A recovered claim must remain reachable for the life of the extension host.
 * Dropping the executor would strand a live-PID lease that no later executor
 * can honestly classify as abandoned.
 */
const recoveredArenaExecutors = new Map<string, ArenaGitExecutor>();

export function arenaOperatorPrivateStorageRoot(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
): string {
  return path.join(
    context.globalStorageUri.fsPath,
    "as",
    createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 24),
  );
}

export async function manageArenaResults(
  context: vscode.ExtensionContext,
): Promise<void> {
  const workspaceRoot = requiredWorkspaceRoot();
  const privateRoot = arenaOperatorPrivateStorageRoot(context, workspaceRoot);
  const store = await openFileArenaManifestStore(privateRoot);
  const candidates = [] as {
    readonly runId: string;
    readonly reveal: ReturnType<typeof createArenaReveal>;
  }[];
  for (const runId of await store.listRunIds()) {
    const replay = await store.load(runId);
    if (!replay?.finalization) continue;
    candidates.push({ runId, reveal: createArenaReveal(replay) });
  }
  if (candidates.length === 0) {
    await vscode.window.showInformationMessage("Hydra has no finalized Arena results to reveal.");
    return;
  }
  const pickedRun = await vscode.window.showQuickPick(
    candidates.map((candidate) => ({
      label: candidate.runId,
      description: `${candidate.reveal.outcome} · ${candidate.reveal.comparison}`,
      detail: `${candidate.reveal.contestants.length} heads · ${
        candidate.reveal.promotionEligible ? "promotion eligible" : "not promotable"}`,
      candidate,
    })),
    { title: "Hydra Arena Results", placeHolder: "Choose one finalized run" },
  );
  if (!pickedRun) return;
  const { runId, reveal } = pickedRun.candidate;
  await showMarkdown(renderArenaRevealMarkdown(reveal));
  const action = await vscode.window.showQuickPick([
    {
      label: "Select winner",
      description: "Records local preference only; grants no authority",
      value: "winner" as const,
    },
    {
      label: "Request synthesis",
      description: "Records sources for a new isolated Arena run",
      value: "synthesis" as const,
    },
    {
      label: "Promote selected winner",
      description: "Previews exact retained changes, then asks again",
      value: "promote" as const,
    },
    {
      label: "Reveal only",
      description: "Leaves all authority and workspace state unchanged",
      value: "reveal" as const,
    },
  ], { title: `Arena ${runId}`, placeHolder: "Choose a local workflow action" });
  if (!action || action.value === "reveal") return;
  if (action.value === "winner") {
    const picked = await vscode.window.showQuickPick(
      reveal.contestants.map((contestant) => ({
        label: contestant.headId,
        description: contestant.terminalStatus,
        detail: contestant.artifactSetSha256
          ? `Evidence ${contestant.artifactSetSha256}`
          : "No promotable evidence",
        contestant,
      })),
      { title: "Select Arena Winner", placeHolder: "Preference only; no authority is granted" },
    );
    if (!picked) return;
    const receipt = createArenaWinnerSelection({
      reveal,
      contestantId: picked.contestant.contestantId,
      selectionId: `selection-${randomUUID()}`,
      occurredAt: new Date().toISOString(),
    });
    await persistArenaProductReceipt(privateRoot, receipt);
    await vscode.window.showInformationMessage(
      `Arena winner preference recorded for ${picked.label}. No authority was granted.`,
    );
    return;
  }
  if (action.value === "synthesis") {
    const picked = await vscode.window.showQuickPick(
      reveal.contestants.filter((contestant) =>
        contestant.artifactSetSha256 && contestant.patchSha256).map((contestant) => ({
          label: contestant.headId,
          description: contestant.terminalStatus,
          contestant,
          picked: true,
        })),
      {
        title: "Request Arena Synthesis",
        placeHolder: "Choose at least two immutable evidence sources",
        canPickMany: true,
      },
    );
    if (!picked) return;
    if (picked.length < 2) {
      await vscode.window.showWarningMessage("Arena synthesis requires at least two sources.");
      return;
    }
    const receipt = createArenaSynthesisRequest({
      reveal,
      contestantIds: picked.map((item) => item.contestant.contestantId),
      requestId: `synthesis-${randomUUID()}`,
      occurredAt: new Date().toISOString(),
    });
    await persistArenaProductReceipt(privateRoot, receipt);
    await vscode.window.showInformationMessage(
      "Arena synthesis request recorded. It must execute as a new isolated run and cannot mutate this workspace.",
    );
    return;
  }
  if (vscode.workspace.isTrusted !== true) {
    await vscode.window.showWarningMessage("Arena promotion requires a trusted workspace.");
    return;
  }
  const replay = await store.load(runId);
  if (!replay) throw new Error("Arena run disappeared before promotion preview.");
  const receipts = await loadArenaProductReceipts(privateRoot, runId);
  const selections = receipts.filter((receipt): receipt is ArenaWinnerSelection =>
    receipt.receiptType === "arenaWinnerSelection"
    && receipt.revealSha256 === reveal.revealSha256);
  if (selections.length === 0) {
    await vscode.window.showWarningMessage("Select an Arena winner before promotion.");
    return;
  }
  const selected = selections.length === 1
    ? selections[0]!
    : (await vscode.window.showQuickPick(
      selections.map((selection) => ({
        label: selection.contestantId,
        description: selection.occurredAt,
        selection,
      })),
      { title: "Choose Winner Selection", placeHolder: "Choose one exact immutable receipt" },
    ))?.selection;
  if (!selected) return;
  const missionDecision = await vscode.window.showQuickPick([
    { label: "Keep Mission active", value: "keepActive" as const },
    {
      label: "Request retirement after verified promotion",
      description: "Records a requested postcondition; does not retire Mission authority",
      value: "retireAfterVerifiedPromotion" as const,
    },
  ], { title: "Arena Promotion Mission Decision" });
  if (!missionDecision) return;
  const executor = await ArenaGitExecutor.open(
    workspaceRoot,
    privateRoot,
    path.join(context.globalStorageUri.fsPath, "arena-repository-leases"),
  );
  const admission = await executor.inspectAdmission();
  const preview = await prepareArenaPromotionWithGit({
    privateWorkspaceRoot: privateRoot,
    executor,
    admission,
    replay,
    reveal,
    selection: selected,
    promotionId: newArenaPromotionId(),
    occurredAt: new Date().toISOString(),
    missionDecision: missionDecision.value,
  });
  if (!preview.eligible) {
    await vscode.window.showErrorMessage(
      `Arena promotion is blocked: ${preview.blockingReasons.join(", ")}.`,
    );
    return;
  }
  const exactCandidate = await loadArenaPromotionCandidate({
    privateWorkspaceRoot: privateRoot,
    runId,
    contestantId: preview.contestantId,
    payload: promotionEvidence(replay, preview.contestantId),
  });
  await showMarkdown(renderArenaPromotionCandidateMarkdown({
    preview,
    candidate: exactCandidate,
    targetWorkspace: workspaceRoot,
    targetHead: admission.baseRevision.oid,
  }));
  const confirmed = await vscode.window.showWarningMessage(
    `Apply winner ${preview.contestantId} to the current workspace? This mutates files only. It will not commit, push, publish, deploy, or delete Arena evidence. Preview ${preview.previewSha256}.`,
    { modal: true },
    "Promote Arena Winner",
  );
  if (confirmed !== "Promote Arena Winner") return;
  const confirmation = createArenaPromotionConfirmation({
    preview,
    confirmationId: `confirmation-${randomUUID()}`,
    occurredAt: new Date().toISOString(),
  });
  const result = await executeArenaPromotionWithGit({
    privateWorkspaceRoot: privateRoot,
    executor,
    admission,
    preview,
    confirmation,
    loadReplay: async () => {
      const current = await store.load(runId);
      if (!current) throw new Error("Arena run disappeared during promotion.");
      return current;
    },
  });
  if (result.outcome === "succeeded") {
    await vscode.window.showInformationMessage(
      preview.missionDecision === "retireAfterVerifiedPromotion"
        ? "Arena winner was applied. Mission retirement remains a recorded request and was not executed. No commit or external action was created."
        : "Arena winner was applied to the workspace. No commit or external action was created.",
    );
  } else {
    await vscode.window.showErrorMessage(
      `Arena promotion failed (${result.failureCode}). Evidence and the durable intent were retained for inspection.`,
    );
  }
}

export async function manageArenaRecovery(
  context: vscode.ExtensionContext,
): Promise<void> {
  const workspaceRoot = requiredWorkspaceRoot();
  const privateRoot = arenaOperatorPrivateStorageRoot(context, workspaceRoot);
  const entries = await scanArenaRecovery(privateRoot);
  const actionable = entries.filter(isRecoveryAttention);
  if (actionable.length === 0) {
    await vscode.window.showInformationMessage("Hydra found no Arena run requiring recovery.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    actionable.map((entry) => ({
      label: entry.runId,
      description: entry.status === "manifestInvalid"
        ? "manifestInvalid"
        : entry.recovery.classification,
      detail: entry.status === "manifestInvalid"
        ? `Invalid manifest evidence ${entry.errorSha256}`
        : `Allowed: ${entry.recovery.allowedActions.join(", ") || "inspect only"}`,
      entry,
    })),
    { title: "Hydra Arena Recovery", placeHolder: "Choose one exact startup classification" },
  );
  if (!picked) return;
  await showMarkdown(renderRecoveryMarkdown(picked.entry));
  if (picked.entry.status !== "classified"
    || !picked.entry.recovery.takeoverEligible) return;
  const allowed = picked.entry.recovery.allowedActions.filter((action) =>
    action === "resume" || action === "abort" || action === "resumeCleanup");
  const chosen = await vscode.window.showQuickPick(
    allowed.map((action) => ({ label: action, action })),
    {
      title: "Authorize Arena Recovery",
      placeHolder: "Creates an exact proof; execution still revalidates the lease",
    },
  );
  if (!chosen) return;
  if (vscode.workspace.isTrusted !== true) {
    await vscode.window.showWarningMessage(
      "Arena recovery takeover requires a trusted workspace.",
    );
    return;
  }
  const refreshedEntries = await scanArenaRecovery(privateRoot);
  const refreshed = refreshedEntries.find((entry) =>
    entry.runId === picked.entry.runId);
  if (!refreshed || refreshed.status !== "classified") {
    await vscode.window.showWarningMessage(
      "Arena recovery evidence changed; review the run again before takeover.",
    );
    return;
  }
  const proof = requireArenaRecoveryAction(
    refreshed.recovery,
    picked.entry.recovery.recoveryStateSha256,
    chosen.action,
  );
  const recoveryKey = `${workspaceRoot}\0${proof.runId}`;
  if (recoveredArenaExecutors.has(recoveryKey)) {
    await vscode.window.showInformationMessage(
      `Arena ${proof.runId} recovery lease is already held by this extension host. No process was started automatically.`,
    );
    return;
  }
  const executor = await ArenaGitExecutor.open(
    workspaceRoot,
    privateRoot,
    path.join(context.globalStorageUri.fsPath, "arena-repository-leases"),
  );
  const admission = await executor.inspectAdmission();
  const confirmed = await vscode.window.showWarningMessage(
    `Take over the abandoned Arena lease for ${proof.runId}? This authorizes ${proof.action} against recovery state ${proof.recoveryStateSha256} and HEAD ${admission.baseRevision.oid}. It does not start a process or execute the authorized action.`,
    { modal: true },
    "Take Over Arena Lease",
  );
  if (confirmed !== "Take Over Arena Lease") return;
  const recovered = await executor.recoverRepositoryRun(
    proof.runId,
    admission,
    proof,
  );
  recoveredArenaExecutors.set(recoveryKey, executor);
  await vscode.window.showInformationMessage(
    `Arena ${proof.runId} lease takeover only succeeded (${recovered.claimSha256}); ${recovered.authorizedAction} is authorized but was not executed. No process was started automatically.`,
  );
}

export async function scanArenaRecoveryOnStartup(
  context: vscode.ExtensionContext,
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) return;
  if (workspaceFolders.length !== 1) {
    await vscode.window.showWarningMessage(
      "Hydra Arena recovery scan requires exactly one workspace folder. Nothing was scanned, resumed, or reapplied.",
    );
    return;
  }
  const workspace = workspaceFolders[0]!.uri.fsPath;
  const entries = await scanArenaRecovery(
    arenaOperatorPrivateStorageRoot(context, path.resolve(workspace)),
  );
  if (!entries.some(isRecoveryAttention)) return;
  const action = await vscode.window.showWarningMessage(
    "Hydra found Arena state that needs explicit recovery review. Nothing was resumed or reapplied automatically.",
    "Review Arena Recovery",
  );
  if (action === "Review Arena Recovery") {
    await vscode.commands.executeCommand("hydraRoom.recoverArenaRuns");
  }
}

function isRecoveryAttention(entry: ArenaRecoveryScanEntry): boolean {
  return entry.status === "manifestInvalid"
    || entry.recovery.classification !== "noAction";
}

function renderRecoveryMarkdown(entry: ArenaRecoveryScanEntry): string {
  if (entry.status === "manifestInvalid") {
    return `# Hydra Arena Recovery\n\nRun: \`${entry.runId}\`\n\nClassification: **manifestInvalid**\n\nError evidence: \`${entry.errorSha256}\`\n\nNo takeover or automatic action is permitted.\n`;
  }
  const recovery = entry.recovery;
  return [
    "# Hydra Arena Recovery",
    "",
    `Run: \`${recovery.runId}\``,
    `Classification: **${recovery.classification}**`,
    `Manifest state: **${recovery.manifestState}**`,
    `All submitted generations quiescent: **${recovery.allSubmittedGenerationsQuiescent}**`,
    `Takeover eligible: **${recovery.takeoverEligible}**`,
    `Allowed actions: ${recovery.allowedActions.join(", ") || "none"}`,
    `Recovery state: \`${recovery.recoveryStateSha256}\``,
    "",
    "Startup scanning never resumes, aborts, takes ownership, or reapplies promotion automatically.",
  ].join("\n") + "\n";
}

async function showMarkdown(content: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    language: "markdown",
    content,
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

function requiredWorkspaceRoot(): string {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length !== 1) {
    throw new Error("Arena requires exactly one open workspace folder.");
  }
  const workspace = workspaceFolders[0]!.uri.fsPath;
  return path.resolve(workspace);
}

function promotionEvidence(
  replay: ArenaManifestReplay,
  contestantId: string,
): ArenaEvidencePreservedPayload {
  const event = replay.contestants.find((contestant) =>
    contestant.lock.contestantId === contestantId)?.evidencePreserved;
  if (!event
    || event.type !== "arenaEvidencePreserved"
    || event.payload.payloadType !== "evidencePreserved") {
    throw new Error("Arena winner has no retained promotion evidence.");
  }
  return event.payload as ArenaEvidencePreservedPayload;
}
