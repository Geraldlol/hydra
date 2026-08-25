import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const panel = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");

function methodSource(startMarker: string, endMarker: string): string {
  const start = panel.indexOf(startMarker);
  const end = panel.indexOf(endMarker, start);
  assert.ok(start >= 0, `${startMarker} not found`);
  assert.ok(end > start, `${endMarker} did not bound ${startMarker}`);
  return panel.slice(start, end);
}

describe("Claude Build/Review fanout panel contract", () => {
  test("runs read-only Build advisers to completion before dispatching the sole lead", () => {
    const build = methodSource(
      "private async runBuildPhase(",
      "private async runParallelBuildPhase(",
    );
    assert.match(build, /buildClaudeBuildWorkers\(/);
    assert.match(build, /appendClaudeBuildWorkerAssignment\(/);
    assert.match(build, /finalInstructions: adviserInstructions/);
    assert.match(build, /appendClaudeBuildAdvisories\(/);
    assert.match(build, /prepareRestrictedClaudeWorkerInvocation\(/);
    assert.ok(
      build.indexOf("await settleAgentCalls(adviserCalls")
        < build.indexOf("await this.callAgent(builder"),
      "all advisers must drain before the only write-capable lead starts",
    );
  });

  test("does not multiply the explicit parallel room-builder path", () => {
    const parallelBuild = methodSource(
      "private async runParallelBuildPhase(",
      "private async afterSuccessfulBuild(",
    );
    assert.doesNotMatch(parallelBuild, /buildClaudeBuildWorkers|manyHeadsDispatch/);
  });

  test("collapses duplicate Claude reviews before cross-head convergence", () => {
    const serialReview = methodSource(
      "private async runReviewPhase(",
      "private async runParallelReviewPhase(",
    );
    assert.match(serialReview, /buildClaudeReviewWorkers\(/);
    assert.match(serialReview, /collapseClaudeReviewWorkerVerdicts\(/);
    assert.match(serialReview, /finalInstructions: workerInstructions/);

    const parallelReview = methodSource(
      "private async runParallelReviewPhase(",
      "\/\/ ---------------- agent call helper ----------------",
    );
    assert.match(parallelReview, /buildClaudeReviewWorkers\(/);
    assert.match(parallelReview, /finalInstructions: workerInstructions/);
    const collapse = parallelReview.indexOf("collapseClaudeReviewWorkerVerdicts(");
    const roomConvergence = parallelReview.indexOf("evaluateReviewConvergence(");
    assert.ok(collapse >= 0 && roomConvergence > collapse);
  });

  test("honors the isolated cwd and blocks browser/MCP enrichment", () => {
    assert.match(panel, /cwd: inv\.cwd \?\? this\.workspaceRoot/);
    assert.match(panel, /inv\.disableBrowserBroker\s*\?\s*undefined/);
    assert.match(panel, /invocationOverride\?: Invocation/);
    assert.match(panel, /fs\.mkdtemp\(path\.join\(os\.tmpdir\(\), "hydra-claude-worker-"\)\)/);
    assert.match(panel, /cleanupClaudeWorkerIsolations\(/);
    assert.match(panel, /\["finalInstructions", input\.finalInstructions\]/);
  });

  test("persists the restricted worker invocation instead of configured writer metadata", () => {
    const build = methodSource(
      "private async runBuildPhase(",
      "private async runParallelBuildPhase(",
    );
    const serialReview = methodSource(
      "private async runReviewPhase(",
      "private async runParallelReviewPhase(",
    );
    const parallelReview = methodSource(
      "private async runParallelReviewPhase(",
      "// ---------------- agent call helper ----------------",
    );
    for (const source of [build, serialReview, parallelReview]) {
      const restricted = source.indexOf("prepareRestrictedClaudeWorkerInvocation(");
      const rebound = source.indexOf("bindPromptEnvelopeToInvocation(", restricted);
      const persisted = source.indexOf("persistPromptEnvelope(", rebound);
      assert.ok(restricted >= 0 && rebound > restricted && persisted > rebound);
    }
    const binding = methodSource(
      "private async bindPromptEnvelopeToInvocation(",
      "private async cleanupClaudeWorkerIsolations(",
    );
    assert.match(binding, /cwd: invocation\.cwd \?\? this\.workspaceRoot/);
    assert.match(binding, /authorityLevel: authority\.level/);
    assert.match(binding, /withPrivateFlightContextCommitment/);
  });

  test("does not start later fanout workers after cancellation", () => {
    assert.ok(
      (panel.match(/if \(ctrl\.signal\.aborted\) break;/g) ?? []).length >= 3,
      "Build, serial Review, and parallel Review must check cancellation while planning workers",
    );
  });
});
