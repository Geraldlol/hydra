import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const panel = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
const extension = fs.readFileSync(path.join(process.cwd(), "src", "extension.ts"), "utf8");
const manifest = fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8");
const motivation = fs.readFileSync(path.join(process.cwd(), "src", "duelMotivation.ts"), "utf8");

function methodSource(startToken: string, endToken: string): string {
  const start = panel.indexOf(startToken);
  const end = panel.indexOf(endToken, start);
  assert.ok(start >= 0, `missing ${startToken}`);
  assert.ok(end > start, `could not bound ${startToken}`);
  return panel.slice(start, end);
}

describe("formal duel host contracts", () => {
  test("keeps duel creation agent-initiated while routing observer and adjudication actions", () => {
    for (const command of [
      "openDuels",
      "advanceDuel",
      "cancelDuel",
      "openDuelAudit",
      "correctDuelResult",
    ]) {
      assert.match(manifest, new RegExp(`hydraRoom\\.${command}`));
      assert.match(extension, new RegExp(`hydraRoom\\.${command}`));
      assert.match(panel, new RegExp(`case "${command}"`));
    }
    assert.doesNotMatch(manifest, /hydraRoom\.createDuel/);
    assert.doesNotMatch(extension, /hydraRoom\.createDuel/);
    assert.doesNotMatch(panel, /case "createDuel"/);
    assert.doesNotMatch(panel, /async createDuel\(/);
    assert.doesNotMatch(panel, /createDuelAcceptance/);
    assert.match(panel, /case "advanceDuel":[\s\S]*this\.advanceDuel\(String\(msg\.duelId \?\? ""\)\)/);
    assert.match(panel, /case "cancelDuel":[\s\S]*this\.cancelDuel\(String\(msg\.duelId \?\? ""\)\)/);

    const advance = methodSource("async advanceDuel(", "private async sealDuelCommitment(");
    assert.match(advance, /will not advance a human-created or pre-v3 match/);
    assert.match(advance, /this\.enqueueAgentDuelAutomation\(duel\.duelId\)/);
    assert.doesNotMatch(advance, /runDuelCommitmentHead\(|createDuelCommitment\(|operator:local-user/);
  });

  test("lets the operator cancel every accepted unresolved duel and deletes only its durable secret refs", () => {
    const cancellation = methodSource("async cancelDuel(", "async correctDuelResult(");
    assert.match(cancellation, /status !== "awaiting_acceptance"/);
    assert.match(cancellation, /type: "duelCancelled"/);
    assert.match(cancellation, /await this\.appendDuelEventFromUi\(cancelled/);
    assert.match(cancellation, /commitmentId: event\.commitmentId/);
    assert.match(cancellation, /deleteDuelCommitmentSecrets\(\s*this\.context\.secrets,\s*this\.duelCommitmentIndexUri\.fsPath,\s*duel\.duelId,\s*secretRefs/);
    assert.match(cancellation, /DUEL_TERMINAL_LATE_SECRET_SWEEP_DELAY_MS/);
    const durableCancel = cancellation.indexOf("appendDuelEventFromUi(cancelled");
    const authoritativeReload = cancellation.indexOf("cleanupEvents = await loadDuelEvents", durableCancel);
    const secretCleanup = cancellation.indexOf("deleteDuelCommitmentSecrets", authoritativeReload);
    assert.ok(
      durableCancel >= 0 && authoritativeReload > durableCancel && secretCleanup > authoritativeReload,
      "cancellation must reload the authoritative ledger before deleting every commitment ordered before it",
    );
  });

  test("injects rank and Elo-gap motivation into room prompts only", () => {
    const context = methodSource(
      "private buildPromptContextSnapshotFromMessages(",
      "private oneShotWorkspaceInstructionsMaxChars(",
    );
    assert.match(context, /if \(agent && use === "room" && agentInitiatedDuels\(\)\)/);
    assert.match(context, /renderDuelMotivationContext\(agent, this\.duels\.ratings, displayNameFor\)/);
    assert.match(context, /Ratings are a visible motivation signal only/);
    assert.doesNotMatch(context, /suggestedBuilder\s*=|assignBuilder\(|applyEvent\(/);
    assert.match(panel, /active: this\.duels\.activeDuels\.slice\(0, 50\)/);
    assert.match(panel, /ratings: this\.duels\.ratings\.slice\(0, 200\)/);
    assert.match(panel, /recent: this\.duels\.recentDuels\.slice\(0, 20\)/);
    assert.match(panel, /ratedDuelCount: Math\.floor\(this\.duels\.ratings\.reduce/);
    assert.match(panel, /watchFileSystem\(this\.duelEventsUri\.fsPath/);
    assert.match(panel, /private async refreshDuelsFromLedgerWatcher\(\)/);
  });

  test("admits a head's challenge atomically and automatically seals both actual heads", () => {
    const admission = methodSource(
      "private async admitAgentInitiatedDuel(",
      "private enqueueAgentDuelAutomation(",
    );
    const automation = methodSource(
      "private async runAgentDuelAutomation(",
      "private startDuelLedgerWatcher(",
    );
    const commitment = methodSource(
      "private async sealDuelCommitment(",
      "async cancelDuel(",
    );

    assert.match(admission, /buildAgentDuelEvidencePacket\(\{/);
    assert.match(admission, /createdBy: "hydra-runtime"/);
    assert.match(admission, /protocol: "agent-intent-v1"/);
    assert.match(admission, /workspaceFingerprintSha256 = \(await captureDuelWorkspaceFingerprint\(this\.workspaceRoot\)\)\.sha256/);
    assert.match(admission, /initiation: \{[\s\S]*workspaceFingerprintSha256,/);
    assert.match(admission, /sourceTraceId: request\.sourceTraceId/);
    assert.match(admission, /capabilityLocks,/);
    assert.ok(
      admission.indexOf("captureDuelWorkspaceFingerprint(this.workspaceRoot)")
        < admission.indexOf("const challenge = makeChallenge("),
      "the shared workspace must be fingerprinted before the v3 challenge is made durable",
    );
    assert.match(admission, /createDuelAdmission\(\[\.\.\.events, challenge\]/);
    assert.match(admission, /appendDuelEvents\(this\.duelEventsUri\.fsPath, \[challenge, admission\]\)/);
    assert.match(admission, /this\.enqueueAgentDuelAutomation\(duelId\)/);
    assert.doesNotMatch(admission, /createDuelAcceptance|showQuickPick|showInputBox/);

    assert.match(automation, /duel\.createdBy !== "hydra-runtime"/);
    assert.match(automation, /watchDuelWorkspaceMutations\(this\.workspaceRoot\)/);
    assert.match(automation, /const workspaceFingerprintSha256 = duel\.initiation\?\.workspaceFingerprintSha256/);
    assert.match(automation, /ensureAgentDuelWorkspaceIntegrity\(duel, "before either commitment", mutationMonitor\)/);
    assert.match(automation, /for \(const participant of \[duel\.challengerId, duel\.challengedId\]\)/);
    assert.match(automation, /capabilityLocks\.find\(\(lock\) => lock\.agentId === participant\)/);
    assert.match(automation, /workspaceFingerprintSha256,\s*capabilityLock\.profileSha256/);
    assert.match(automation, /`after \$\{displayNameFor\(participant\)\} committed`,\s*mutationMonitor/);
    assert.match(automation, /const current = await captureDuelWorkspaceFingerprint\(this\.workspaceRoot\);[\s\S]*if \(current\.sha256 === expected\) return true/);
    assert.match(automation, /type: "duelCancelled"[\s\S]*cancelledBy: "hydra-runtime"/);
    assert.match(automation, /appendDuelEvents\(this\.duelEventsUri\.fsPath, \[cancellation\]\)/);
    const integrityCancellation = automation.indexOf("private async cancelAgentDuelForIntegrity(");
    const cancellationAppend = automation.indexOf("appendDuelEvents(this.duelEventsUri.fsPath, [cancellation])", integrityCancellation);
    const cancellationSecretDelete = automation.indexOf("deleteDuelCommitmentSecrets(", cancellationAppend);
    assert.ok(
      integrityCancellation >= 0 && cancellationAppend > integrityCancellation && cancellationSecretDelete > cancellationAppend,
      "workspace drift must be durably cancelled before any sealed preimages are deleted",
    );
    assert.match(automation, /this\.revealDuelCommitmentsIfReady\(duelId, false\)/);
    assert.match(automation, /awaiting your independent evidence judgment/);
    assert.doesNotMatch(automation, /showQuickPick|showInputBox|createDuelAcceptance|manual answer/i);

    assert.match(commitment, /runDuelCommitmentHead\(\s*duel,\s*participant,\s*commitmentId,\s*controller\.signal,\s*false,\s*workspaceFingerprintSha256,\s*capabilityLockSha256/);
    assert.doesNotMatch(commitment, /manual exhibition answer|captureRef = "operator:local-user"/i);
    assert.match(commitment, /appendRequiredDuelReceipt/);
    assert.match(commitment, /workspaceFingerprintSha256: captured\.receipt\.workspaceFingerprintSha256/);
    assert.match(commitment, /capabilityLockSha256: captured\.receipt\.capabilityLockSha256/);
    assert.match(commitment, /storeDuelCommitmentSecret\([\s\S]*this\.duelCommitmentIndexUri\.fsPath,[\s\S]*duel\.duelId,[\s\S]*created\.payload/);
    assert.match(commitment, /appendDuelEvents\(this\.duelEventsUri\.fsPath, \[created\.event\]\)/);
    assert.ok(
      commitment.indexOf("storeDuelCommitmentSecret(") < commitment.indexOf("appendDuelEvents("),
      "secret preimage must be stored before its public hash seal",
    );
    assert.ok(
      commitment.indexOf("appendRequiredDuelReceipt(") < commitment.indexOf("storeDuelCommitmentSecret("),
      "rated head receipt must be durable before the secret and seal",
    );
  });

  test("publishes agent-duel setting changes and resumes queued automation when re-enabled", () => {
    const configuration = methodSource("private constructor(", "dispose(): void");
    assert.match(
      configuration,
      /if \(e\.affectsConfiguration\("hydraRoom\.agentInitiatedDuels"\)\) \{[\s\S]*this\.requeueOutstandingAgentDuels\(\);[\s\S]*queueMicrotask\(\(\) => void this\.drainAgentDuelAutomation\(\)\)/,
    );
    const automation = methodSource(
      "private async drainAgentDuelAutomation(",
      "private async runAgentDuelAutomation(",
    );
    assert.match(automation, /if \([\s\S]*!agentInitiatedDuels\(\)/);
    assert.match(automation, /while \(\s*agentInitiatedDuels\(\)/);

    const retry = methodSource(
      "private async scheduleAgentDuelAutomationRetry(",
      "private requeueOutstandingAgentDuels(",
    );
    assert.match(retry, /MAX_AGENT_DUEL_AUTOMATION_ATTEMPTS/);
    assert.match(retry, /setTimeout\(\(\) => \{/);
    assert.match(retry, /this\.enqueueAgentDuelAutomation\(duelId\)/);
    assert.match(retry, /No exhibition or manual answer was substituted/);
  });

  test("binds autonomous initiation to the completed source call before background admission", () => {
    const finalization = methodSource(
      "private async finalizePendingMessage(",
      "private async recordWikiUsageTelemetry(",
    );
    assert.match(finalization, /const sourceTraceId = this\.pendingAgentTraceIds\.get\(messageId\)/);
    assert.match(finalization, /sourceTraceId,/);
    assert.match(finalization, /sourceMessageText: rawAgentReplyText/);
    assert.match(finalization, /hasReservedAgentDuelChallengePrefix\(m\.text\)/);
    assert.match(finalization, /duelContext\.duelProtocolExpected/);
    assert.match(finalization, /parseDecisionPacket\(m\.text/);
    assert.match(finalization, /omitted the required HYDRA_DUEL_CHALLENGE_V1 control record/);
    assert.match(finalization, /await this\.persistTranscriptMessage\(\{/);
    assert.match(finalization, /this\.enqueueAgentDuelAdmission\(agentDuelRequest\)/);
    assert.ok(
      finalization.indexOf("await this.persistTranscriptMessage({")
        < finalization.indexOf("this.enqueueAgentDuelAdmission(agentDuelRequest)"),
      "normal message persistence must complete before autonomous duel admission is queued",
    );
    const turn = methodSource("private async runTurn(", "private async runDiscussionTurn(");
    assert.match(turn, /this\.currentAbort = undefined/);
    assert.match(turn, /this\.drainAgentDuelAdmissions\(\)/);
    assert.ok(
      turn.indexOf("this.currentAbort = undefined") < turn.indexOf("this.drainAgentDuelAdmissions()"),
      "heavy admission must be deferred until the complete room turn is idle",
    );
    assert.match(panel, /stdoutSha256: sha256\(result\.stdout\)/);
    assert.match(panel, /const duelProtocolExpected = agentInitiatedDuels\(\)[\s\S]*input\.phase === "reactor"[\s\S]*input\.phase === "closer"/);
    assert.match(panel, /allowAgentDuelChallenge: duelProtocolExpected/);
    assert.match(panel, /reactorEnvelope\.duelProtocolExpected/);
    assert.match(panel, /closerEnvelope\.duelProtocolExpected/);
    assert.doesNotMatch(panel, /renderedPrompt\.includes\(AGENT_DUEL_CHALLENGE_MARKER\)/);
  });

  test("keeps head-generated commitments out of the room and live-channel paths", () => {
    const runner = methodSource(
      "private async runDuelCommitmentHead(",
      "private async runHeadlessDuelHttpAgent(",
    );
    assert.match(runner, /buildDuelCommitmentPrompt\(/);
    assert.match(runner, /const sharedEvidencePacket = duel\.sharedEvidencePacket/);
    assert.match(runner, /sharedEvidencePacket,[\s\S]*rankingMotivation/);
    assert.doesNotMatch(runner, /duelHeadSandboxRoot|mkdtemp|sandboxRoot/);
    assert.match(runner, /buildDuelCommitmentInvocation\(participantId, prompt\)/);
    assert.match(runner, /cwd: this\.workspaceRoot/);
    assert.match(runner, /parseDuelAgentCommitmentResponse\(result\.stdout/);
    assert.match(runner, /traceKind: "duelCommitment", captureLiveChannel: false, sensitive: true/);
    assert.doesNotMatch(runner, /openPendingMessage|finalizePendingMessage|persistPromptEnvelope|appendUserMessage/);
    assert.match(runner, /phase: Phase = "review"/);
    assert.match(runner, /if \(definition\.kind === "claude"\)/);
    assert.match(runner, /duel\.ratingPolicy === DUEL_AGENT_RATING_POLICY && !workspaceFingerprintSha256/);
    assert.match(runner, /sharedEvidenceSha256: hashDuelSharedEvidencePacket\(sharedEvidencePacket\)/);
    assert.match(runner, /capabilityPolicy: DUEL_FULL_ACCESS_POLICY_ID/);
    assert.match(runner, /\.\.\.\(workspaceFingerprintSha256 \? \{ workspaceFingerprintSha256 \} : \{\}\)/);
    assert.ok(
      runner.indexOf("const prepared = await this.prepareOneShotRequestFiles")
        < runner.indexOf("command: prepared.spawn.command"),
      "receipt must fingerprint the prepared invocation Hydra actually executes",
    );

    const oneShot = methodSource(
      "private async runOneShotPipeline(",
      "private async runHttpPipeline(",
    );
    assert.match(oneShot, /if \(!sensitive && prepared\.outputMode === "claudeStreamJson"\)/);
    assert.match(oneShot, /else if \(!sensitive && prepared\.outputMode === "codexJson"\)/);

    const invocation = methodSource(
      "private buildDuelCommitmentInvocation(",
      "private async runOneShotPipeline(",
    );
    assert.match(invocation, /duelCommitmentFullAccessArgs\(definition\.kind, configuredInvocation\.args\)/);
    assert.match(invocation, /command: configuredInvocation\.command/);
    assert.match(invocation, /const configuredInvocation = this\.buildInvocationFor\(agent, phase, prompt\)/);
    assert.match(invocation, /workspaceRoot: this\.workspaceRoot/);
    assert.match(invocation, /has no Hydra full-access rated duel profile/);
    assert.doesNotMatch(invocation, /manual exhibition|if \(!rated\)/);
  });

  test("reveals exactly one validated pair before deleting either secret", () => {
    const reveal = methodSource(
      "private async revealDuelCommitmentsIfReady(",
      "private async adjudicateDuel(",
    );
    assert.match(reveal, /sealRefs\[0\]\.participantId,[\s\S]*sealRefs\[0\]\.commitmentId/);
    assert.match(reveal, /sealRefs\[1\]\.participantId,[\s\S]*sealRefs\[1\]\.commitmentId/);
    assert.match(reveal, /payloads = \[challenger, challenged\]/);
    assert.match(reveal, /createDuelReveal\(events,/);
    assert.match(reveal, /DUEL_TERMINAL_LATE_SECRET_SWEEP_DELAY_MS/);
    const durableAppend = reveal.lastIndexOf("appendDuelEvents(");
    const durableDelete = reveal.lastIndexOf("deleteDuelCommitmentSecrets(");
    assert.ok(durableAppend >= 0 && durableDelete > durableAppend, "paired reveal must be durable before secret deletion");
  });

  test("locks human evidence, refuses fake deterministic receipts, and removes reversed Elo by replay", () => {
    const adjudication = methodSource("private async adjudicateDuel(", "async openNativeActions(");
    const correction = methodSource("async correctDuelResult(", "private async appendDuelEventFromUi(");
    assert.match(adjudication, /adjudicatorType: duel\.adjudicatorType/);
    assert.match(adjudication, /adjudicatorId: duel\.adjudicatorId/);
    assert.match(adjudication, /if \(duel\.adjudicatorType !== "human"\)/);
    assert.match(adjudication, /will not let a human-selected winner borrow an unrelated verification receipt/);
    assert.doesNotMatch(adjudication, /latestVerification\(\)/);
    assert.match(adjudication, /Durable Ruling Evidence/);
    assert.match(adjudication, /value\.trim\(\)\.length > 512/);
    assert.match(adjudication, /A timestamp alone is not evidence/);
    assert.doesNotMatch(adjudication, /const evidenceRef = `human:local-user:/);
    assert.match(correction, /type: "duelResolutionReversed"/);
    assert.match(correction, /Its Elo effect was removed by full replay/);
    assert.match(motivation, /Competitive status only\. Ratings never change permissions, approvals, builder assignment, speaking order, or safety authority/);
  });
});
