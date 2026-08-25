import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import {
  createArenaBrowserJourneyExecutionPlan,
  createArenaVerificationExecutionPlan,
  runArenaBrowserJourneyAttempt,
  runArenaVerificationAttempt,
  verifyArenaAcceptanceReceipt,
  type ArenaAcceptanceWorkspaceState,
} from "../src/arenaAcceptance";

const HEAD = Object.freeze({ objectFormat: "sha1" as const, oid: "a".repeat(40) });
const STATE: ArenaAcceptanceWorkspaceState = Object.freeze({
  head: HEAD,
  workspaceFingerprintSha256: digest("workspace"),
});

describe("Arena locked acceptance execution", () => {
  test("runs a locked verifier in the contestant worktree and persists metadata-only replay evidence", async (t) => {
    const fixture = await createFixture(t);
    const plan = createArenaVerificationExecutionPlan({
      checkId: "unit-tests",
      command: "pnpm test --filter arena",
      controlSha256: digest("verification-controls"),
      maxOutputChars: 8_192,
      timeoutMs: 30_000,
    });
    let observedWorktree = "";

    const attempt = await runArenaVerificationAttempt({
      privateWorkspaceRoot: fixture.privateRoot,
      runId: "run-one",
      contestantId: "codex",
      worktreePath: fixture.worktree,
      plan,
      locked: { checkId: plan.checkId, planSha256: plan.planSha256 },
      attempt: 1,
      expectedState: STATE,
      signal: new AbortController().signal,
      captureState: async () => STATE,
      execute: async (input) => {
        observedWorktree = input.worktreePath;
        return {
          cancelled: false,
          durationMs: 25,
          exitCode: 0,
          quiescenceReceiptSha256: digest("verification-quiescence"),
          stderr: { bytes: 0, sha256: digest("") },
          stdout: { bytes: 21, sha256: digest("private verifier output") },
          terminationConfirmed: true,
          timedOut: false,
        };
      },
    });

    assert.equal(observedWorktree, fixture.worktree);
    assert.equal(attempt.payload.status, "passed");
    assert.equal(attempt.payload.head.oid, HEAD.oid);
    await verifyArenaAcceptanceReceipt({
      privateWorkspaceRoot: fixture.privateRoot,
      event: attempt.payload,
      runId: "run-one",
    });
    const receiptText = await fs.readFile(attempt.receiptPath, "utf8");
    assert.doesNotMatch(
      receiptText,
      /private verifier output|pnpm test|worktree/u,
    );
    assert.match(receiptText, new RegExp(digest("private verifier output"), "u"));
  });

  test("rejects a verification command that does not match the locked plan digest", async (t) => {
    const fixture = await createFixture(t);
    const plan = createArenaVerificationExecutionPlan({
      checkId: "unit-tests",
      command: "pnpm test",
      controlSha256: digest("controls"),
      maxOutputChars: 8_192,
      timeoutMs: 30_000,
    });
    await assert.rejects(
      runArenaVerificationAttempt({
        privateWorkspaceRoot: fixture.privateRoot,
        runId: "run-one",
        contestantId: "codex",
        worktreePath: fixture.worktree,
        plan: { ...plan, command: "pnpm publish" },
        locked: { checkId: plan.checkId, planSha256: plan.planSha256 },
        attempt: 1,
        expectedState: STATE,
        signal: new AbortController().signal,
        captureState: async () => STATE,
        execute: async () => {
          throw new Error("must not execute");
        },
      }),
      /plan digest/i,
    );
  });

  test("runs an owned browser journey with broker and quiescence receipts", async (t) => {
    const fixture = await createFixture(t);
    const plan = createArenaBrowserJourneyExecutionPlan({
      journeyId: "login-smoke",
      journeyDefinitionSha256: digest("browser-steps"),
      timeoutMs: 45_000,
    });
    const attempt = await runArenaBrowserJourneyAttempt({
      privateWorkspaceRoot: fixture.privateRoot,
      runId: "run-one",
      contestantId: "claude",
      worktreePath: fixture.worktree,
      plan,
      locked: { journeyId: plan.journeyId, planSha256: plan.planSha256 },
      attempt: 1,
      expectedState: STATE,
      signal: new AbortController().signal,
      captureState: async () => STATE,
      execute: async (input) => {
        assert.equal(input.worktreePath, fixture.worktree);
        return {
          actionCount: 4,
          brokerReceiptSha256: digest("browser-broker"),
          durationMs: 80,
          executionStarted: true,
          quiescenceReceiptSha256: digest("browser-quiescence"),
          screenshotCount: 1,
          status: "passed",
        };
      },
    });

    assert.equal(attempt.payload.status, "passed");
    await verifyArenaAcceptanceReceipt({
      privateWorkspaceRoot: fixture.privateRoot,
      event: attempt.payload,
      runId: "run-one",
    });
  });

  test("replay rejects a modified private acceptance receipt", async (t) => {
    const fixture = await createFixture(t);
    const plan = createArenaBrowserJourneyExecutionPlan({
      journeyId: "login-smoke",
      journeyDefinitionSha256: digest("browser-steps"),
      timeoutMs: 45_000,
    });
    const attempt = await runArenaBrowserJourneyAttempt({
      privateWorkspaceRoot: fixture.privateRoot,
      runId: "run-one",
      contestantId: "claude",
      worktreePath: fixture.worktree,
      plan,
      locked: { journeyId: plan.journeyId, planSha256: plan.planSha256 },
      attempt: 1,
      expectedState: STATE,
      signal: new AbortController().signal,
      captureState: async () => STATE,
      execute: async () => ({
        actionCount: 0,
        brokerReceiptSha256: digest("browser-broker"),
        durationMs: 1,
        executionStarted: false,
        quiescenceReceiptSha256: null,
        screenshotCount: 0,
        status: "denied",
      }),
    });
    await fs.writeFile(attempt.receiptPath, "{}\n", { mode: 0o600 });

    await assert.rejects(
      verifyArenaAcceptanceReceipt({
        privateWorkspaceRoot: fixture.privateRoot,
        event: attempt.payload,
        runId: "run-one",
      }),
      /receipt/i,
    );
  });
});

async function createFixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-acceptance-"));
  const privateRoot = path.join(root, "private");
  const worktree = path.join(root, "worktree");
  await fs.mkdir(worktree, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { privateRoot, worktree };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
