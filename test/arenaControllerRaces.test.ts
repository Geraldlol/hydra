import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  after,
  before,
  test,
  type TestContext,
} from "node:test";
import * as vscode from "vscode";
import {
  runArenaController,
  type ArenaControllerProcessContext,
  type ArenaControllerProcessSpec,
} from "../src/arenaController";
import {
  createArenaBrowserJourneyExecutionPlan,
  createArenaVerificationExecutionPlan,
} from "../src/arenaAcceptance";
import { verifyArenaFlightProjection } from "../src/arenaFlightProjection";
import type { ArenaFakeHeadRequest } from "../src/arenaFakeHeadCli";
import {
  ArenaGitExecutor,
  runArenaGitCommand,
  type ArenaGitAdmission,
} from "../src/arenaGit";
import {
  ARENA_POLICY_ID,
  canonicalArenaManifestJson,
  type ArenaRunLockedPayload,
} from "../src/arenaRunManifest";
import {
  arenaContestantArtifactPath,
  FileArenaManifestStore,
  openFileArenaManifestStore,
} from "../src/arenaStore";
import {
  arenaProcessEnvironmentPolicySha256,
  arenaProcessFileIdentitySha256,
  sha256ArenaProcessUtf8,
} from "../src/arenaProcessSupervisor";
import { resolveGitExecutable } from "../src/gitExecutable";
import { HANG_NET_TIMEOUT_MS } from "./testBudgets";

const BASE_CONTENT = "Hydra Arena controller race base.\n";
const HEAD_CONTENT = "Hydra Arena controller race result.\n";
const UNTRACKED_CONTENT = "Hydra Arena controller race evidence.\n";
const FIXTURE_PREFIX = "hydra-arena-controller-race-";
const DUAL_HEAD_READY_TIMEOUT_MS = HANG_NET_TIMEOUT_MS * 2;
const HANGING_HEAD_TIMEOUT_MS = HANG_NET_TIMEOUT_MS * 3;
const DUAL_HEAD_RACE_TIMEOUT_MS = HANG_NET_TIMEOUT_MS * 6;

const workspace = vscode.workspace as typeof vscode.workspace & {
  isTrusted?: boolean;
};
let originalTrust: PropertyDescriptor | undefined;

before(() => {
  originalTrust = Object.getOwnPropertyDescriptor(workspace, "isTrusted");
  Object.defineProperty(workspace, "isTrusted", {
    configurable: true,
    writable: true,
    value: true,
  });
});

after(() => {
  if (originalTrust) {
    Object.defineProperty(workspace, "isTrusted", originalTrust);
  } else {
    delete (workspace as unknown as { isTrusted?: boolean }).isTrusted;
  }
});

test(
  "a source mutation inside process preparation reaches no provider and retains recovery authority",
  { timeout: 120_000 },
  async (t: TestContext) => {
    const fixture = await createFixture(t, "preparation");
    if (!fixture) return;
    const worktrees = new Map<string, string>();
    let mutation: Promise<void> | undefined;

    await assert.rejects(
      runArenaController({
        runId: fixture.runId,
        workspaceRoot: fixture.sourceRoot,
        privateWorkspaceRoot: fixture.privateRoot,
        repositoryLeaseRoot: fixture.leaseRoot,
        gitResolutionRoot: process.cwd(),
        lock: fixture.lock,
        assertMissionAuthority: () => {},
        createProcess: async (context) => {
          worktrees.set(
            context.contestant.contestantId,
            context.worktree.worktreePath,
          );
          fixture.worktrees.add(context.worktree.worktreePath);
          mutation ??= fs.writeFile(
            path.join(fixture.sourceRoot, "fixture.txt"),
            "Hydra Arena controller race source mutation.\n",
            "utf8",
          );
          await mutation;
          return fixture.processSpec(context, false);
        },
      }),
      /source controls changed during process preparation/i,
    );

    assert.equal(worktrees.size, 2);
    assert.equal(
      await fs.readFile(
        path.join(fixture.sourceRoot, "fixture.txt"),
        "utf8",
      ),
      "Hydra Arena controller race source mutation.\n",
    );
    for (const worktreePath of worktrees.values()) {
      assert.equal(
        await fs.readFile(path.join(worktreePath, "fixture.txt"), "utf8"),
        BASE_CONTENT,
        "no fake head received stdin or edited its tracked fixture",
      );
      await assert.rejects(
        fs.lstat(path.join(worktreePath, "evidence.txt")),
        { code: "ENOENT" },
      );
    }
    assert.deepEqual(
      await listPrivateFiles(path.join(
        fixture.privateRoot,
        "arena",
        "support",
        "dispatch",
        fixture.runId,
      )),
      [],
      "preparation rejection publishes neither intent nor submission receipts",
    );

    const replay = await (
      await openFileArenaManifestStore(fixture.privateRoot)
    ).load(fixture.runId);
    assert.ok(replay);
    assert.equal(replay.finalization, undefined);
    assert.equal(replay.state, "running");
    assert.equal(
      replay.contestants.every((contestant) =>
        contestant.worktreeRegistered !== undefined
        && contestant.started === undefined),
      true,
      "the manifest retains both registered targets without claiming a start",
    );
    const leaseEvents = await readLeaseEvents(fixture.leaseRoot);
    assert.equal(leaseEvents.at(-1)?.type, "claimAcquired");
    assert.equal(
      leaseEvents.some((event) => event.type === "claimReleased"),
      false,
      "an incomplete registered run intentionally retains repository authority",
    );
  },
);

test(
  "a parent Stop during process preparation cancels both heads before dispatch and cleans partial evidence",
  { timeout: 120_000 },
  async (t: TestContext) => {
    const fixture = await createFixture(t, "pre-spawn-stop");
    if (!fixture) return;
    const controller = new AbortController();
    const worktrees = new Map<string, string>();
    let releasePreparation!: () => void;
    const preparationStopped = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const running = runArenaController({
      runId: fixture.runId,
      workspaceRoot: fixture.sourceRoot,
      privateWorkspaceRoot: fixture.privateRoot,
      repositoryLeaseRoot: fixture.leaseRoot,
      gitResolutionRoot: process.cwd(),
      lock: fixture.lock,
      signal: controller.signal,
      assertMissionAuthority: () => {},
      createProcess: async (context) => {
        worktrees.set(
          context.contestant.contestantId,
          context.worktree.worktreePath,
        );
        fixture.worktrees.add(context.worktree.worktreePath);
        if (worktrees.size === fixture.lock.contestants.length) {
          controller.abort(new Error("synthetic pre-spawn local-user Stop"));
          releasePreparation();
        }
        await preparationStopped;
        return fixture.processSpec(context, false);
      },
    });
    const result = await running;

    assert.equal(worktrees.size, 2);
    assert.equal(result.contestantResults.length, 2);
    assert.equal(
      result.contestantResults.every((contestant) =>
        contestant.stage === "beforeDispatch"
        && contestant.traceId === null
        && contestant.status === "cancelled"
        && contestant.failureCode === "cancelled"
        && contestant.terminationConfirmed
        && contestant.submission === null
        && contestant.submissionReceiptSha256 === null
        && contestant.quiescence === null
        && contestant.quiescenceReceiptSha256 === null
        && contestant.quiescenceWorkspaceFingerprintSha256 === null),
      true,
    );
    assert.equal(result.replay.state, "cleanupComplete");
    const finalization = result.replay.finalization?.payload as
      | {
          readonly outcome: string;
          readonly comparison: string;
          readonly reasonCode: string | null;
          readonly evidenceMatrixSha256: string | null;
        }
      | undefined;
    assert.deepEqual(finalization, {
      payloadType: "runFinalized",
      outcome: "cancelled",
      comparison: "incomplete",
      reasonCode: "userCancelled",
      evidenceMatrixSha256: null,
    });
    assert.equal(
      result.replay.contestants.every((contestant) => {
        const evidence = contestant.evidencePreserved?.payload as
          | {
              readonly quiescenceReceiptSha256?: string | null;
              readonly quiescenceWorkspaceFingerprintSha256?: string | null;
              readonly patchBytes?: number;
              readonly untrackedArchiveBytes?: number;
            }
          | undefined;
        return evidence?.quiescenceReceiptSha256 === null
          && evidence.quiescenceWorkspaceFingerprintSha256 === null
          && evidence.patchBytes === 0
          && evidence.untrackedArchiveBytes === 0
          && contestant.cleanup.status === "complete";
      }),
      true,
      "each never-dispatched head retains an explicit partial evidence receipt",
    );

    const dispatchFiles = await listPrivateFiles(path.join(
      fixture.privateRoot,
      "arena",
      "support",
      "dispatch",
      fixture.runId,
    ));
    assert.equal(
      dispatchFiles.filter((file) => file.endsWith("intent.v1.json")).length,
      2,
    );
    assert.equal(
      dispatchFiles.some((file) => file.endsWith("submission.v1.json")),
      false,
    );
    assert.equal(
      dispatchFiles.some((file) => file.endsWith("quiescence.v1.json")),
      false,
    );
    for (const contestant of fixture.lock.contestants) {
      const artifactDirectory = arenaContestantArtifactPath(
        fixture.privateRoot,
        fixture.runId,
        contestant.contestantId,
      );
      assert.deepEqual(
        (await fs.readdir(artifactDirectory)).sort(),
        [
          "artifact-set.v1.json",
          "inventory.v2.json",
          "patch.bin",
        ],
      );
      assert.equal(
        (await fs.lstat(path.join(artifactDirectory, "patch.bin"))).size,
        0,
      );
      const worktreePath = worktrees.get(contestant.contestantId);
      assert.ok(worktreePath);
      await assert.rejects(fs.lstat(worktreePath), { code: "ENOENT" });
    }
    assert.equal(
      await fs.readFile(
        path.join(fixture.sourceRoot, "fixture.txt"),
        "utf8",
      ),
      BASE_CONTENT,
    );
    await assert.rejects(
      fs.lstat(path.join(fixture.sourceRoot, "evidence.txt")),
      { code: "ENOENT" },
    );
    const leaseEvents = await readLeaseEvents(fixture.leaseRoot);
    assert.equal(leaseEvents.at(-1)?.type, "claimReleased");
    assert.equal(
      (leaseEvents.at(-1)?.payload as { readonly runId?: string }).runId,
      fixture.runId,
    );
    const retainedPatch = path.join(
      arenaContestantArtifactPath(
        fixture.privateRoot,
        fixture.runId,
        fixture.lock.contestants[0]!.contestantId,
      ),
      "patch.bin",
    );
    await fs.writeFile(retainedPatch, "tampered after cleanup\n", {
      mode: 0o600,
    });
    await assert.rejects(
      (await openFileArenaManifestStore(fixture.privateRoot)).load(
        fixture.runId,
      ),
      /retained evidence .* missing or invalid/i,
    );
  },
);

test(
  "a Stop with one submitted head drains the later queued head before dispatch",
  { timeout: 120_000 },
  async (t: TestContext) => {
    const fixture = await createFixture(t, "mixed-queue-stop");
    if (!fixture) return;
    const controller = new AbortController();
    const worktrees = new Map<string, string>();
    let releaseLaterHead!: () => void;
    const laterHeadReleased = new Promise<void>((resolve) => {
      releaseLaterHead = resolve;
    });
    let laterHeadBlocked = false;
    const running = runArenaController({
      runId: fixture.runId,
      workspaceRoot: fixture.sourceRoot,
      privateWorkspaceRoot: fixture.privateRoot,
      repositoryLeaseRoot: fixture.leaseRoot,
      gitResolutionRoot: process.cwd(),
      lock: fixture.lock,
      signal: controller.signal,
      assertMissionAuthority: async () => {
        const receiptFiles = await listPrivateFiles(path.join(
          fixture.privateRoot,
          "arena",
          "support",
          "dispatch",
          fixture.runId,
        ));
        const submissions = receiptFiles.filter((file) =>
          file.endsWith("submission.v1.json")).length;
        if (submissions === 1 && !laterHeadBlocked) {
          laterHeadBlocked = true;
          await laterHeadReleased;
        }
      },
      createProcess: (context) => {
        worktrees.set(
          context.contestant.contestantId,
          context.worktree.worktreePath,
        );
        fixture.worktrees.add(context.worktree.worktreePath);
        return fixture.processSpec(context, true);
      },
    });

    let earlyFailure: unknown;
    void running.catch((error: unknown) => {
      earlyFailure = error;
    });
    try {
      await waitFor(async () => {
        if (earlyFailure !== undefined) throw earlyFailure;
        return laterHeadBlocked;
      }, "exactly one durable Arena submission");
    } catch (error) {
      controller.abort(error);
      releaseLaterHead();
      await running.catch(() => undefined);
      throw error;
    }
    controller.abort(new Error("synthetic mixed-queue local-user Stop"));
    releaseLaterHead();
    const result = await running;

    assert.equal(laterHeadBlocked, true);
    assert.equal(worktrees.size, 2);
    assert.equal(result.contestantResults.length, 2);
    const executed = result.contestantResults.filter((contestant) =>
      contestant.stage === "execution");
    const queued = result.contestantResults.filter((contestant) =>
      contestant.stage === "beforeDispatch");
    assert.equal(executed.length, 1);
    assert.equal(queued.length, 1);
    assert.equal(executed[0]?.status, "cancelled");
    assert.equal(executed[0]?.failureCode, "cancelled");
    assert.equal(executed[0]?.terminationConfirmed, true);
    assert.notEqual(executed[0]?.submissionReceiptSha256, null);
    assert.notEqual(executed[0]?.quiescenceReceiptSha256, null);
    assert.notEqual(
      executed[0]?.quiescenceWorkspaceFingerprintSha256,
      null,
    );
    assert.equal(queued[0]?.status, "cancelled");
    assert.equal(queued[0]?.failureCode, "cancelled");
    assert.equal(queued[0]?.terminationConfirmed, true);
    assert.equal(queued[0]?.traceId, null);
    assert.equal(queued[0]?.submission, null);
    assert.equal(queued[0]?.submissionReceiptSha256, null);
    assert.equal(queued[0]?.quiescence, null);
    assert.equal(queued[0]?.quiescenceReceiptSha256, null);
    assert.equal(
      queued[0]?.quiescenceWorkspaceFingerprintSha256,
      null,
    );

    assert.equal(result.replay.state, "cleanupComplete");
    const finalization = result.replay.finalization?.payload as
      | {
          readonly outcome: string;
          readonly comparison: string;
          readonly reasonCode: string | null;
          readonly evidenceMatrixSha256: string | null;
        }
      | undefined;
    assert.deepEqual(finalization, {
      payloadType: "runFinalized",
      outcome: "cancelled",
      comparison: "incomplete",
      reasonCode: "userCancelled",
      evidenceMatrixSha256: null,
    });
    assert.equal(
      result.replay.contestants.every((contestant) =>
        contestant.evidencePreserved !== undefined
        && contestant.cleanup.status === "complete"),
      true,
    );
    const replayStarted = result.replay.contestants.filter((contestant) =>
      contestant.started !== undefined);
    assert.equal(replayStarted.length, 1);
    assert.equal(replayStarted[0]?.lock.contestantId, executed[0]?.contestantId);

    const dispatchFiles = await listPrivateFiles(path.join(
      fixture.privateRoot,
      "arena",
      "support",
      "dispatch",
      fixture.runId,
    ));
    assert.equal(
      dispatchFiles.filter((file) => file.endsWith("intent.v1.json")).length,
      2,
    );
    assert.equal(
      dispatchFiles.filter((file) =>
        file.endsWith("submission.v1.json")).length,
      1,
    );
    assert.equal(
      dispatchFiles.filter((file) =>
        file.endsWith("quiescence.v1.json")).length,
      1,
    );
    for (const contestant of fixture.lock.contestants) {
      const artifactDirectory = arenaContestantArtifactPath(
        fixture.privateRoot,
        fixture.runId,
        contestant.contestantId,
      );
      assert.equal(
        (await fs.readdir(artifactDirectory)).includes(
          "artifact-set.v1.json",
        ),
        true,
      );
      const worktreePath = worktrees.get(contestant.contestantId);
      assert.ok(worktreePath);
      await assert.rejects(fs.lstat(worktreePath), { code: "ENOENT" });
    }
    assert.equal(
      await fs.readFile(
        path.join(fixture.sourceRoot, "fixture.txt"),
        "utf8",
      ),
      BASE_CONTENT,
    );
    await assert.rejects(
      fs.lstat(path.join(fixture.sourceRoot, "evidence.txt")),
      { code: "ENOENT" },
    );
    const leaseEvents = await readLeaseEvents(fixture.leaseRoot);
    assert.equal(leaseEvents.at(-1)?.type, "claimReleased");
    assert.equal(
      (leaseEvents.at(-1)?.payload as { readonly runId?: string }).runId,
      fixture.runId,
    );
  },
);

test(
  "a Stop after every contestant finished cannot rewrite the completed run",
  { timeout: 120_000 },
  async (t: TestContext) => {
    const fixture = await createFixture(t, "late-stop-after-finished");
    if (!fixture) return;
    const controller = new AbortController();
    const originalAppend = FileArenaManifestStore.prototype.append;
    let finishedCount = 0;
    t.mock.method(
      FileArenaManifestStore.prototype,
      "append",
      async function stopAfterEveryFinishedEvent(
        this: FileArenaManifestStore,
        ...args: Parameters<typeof originalAppend>
      ) {
        const event = await originalAppend.apply(this, args);
        const payload = args[0].payload as {
          readonly payloadType?: string;
        };
        if (payload.payloadType === "contestantFinished") {
          finishedCount += 1;
          if (finishedCount === fixture.lock.contestants.length) {
            controller.abort(new Error("synthetic late local-user Stop"));
          }
        }
        return event;
      },
    );

    const result = await runArenaController({
      runId: fixture.runId,
      workspaceRoot: fixture.sourceRoot,
      privateWorkspaceRoot: fixture.privateRoot,
      repositoryLeaseRoot: fixture.leaseRoot,
      gitResolutionRoot: process.cwd(),
      lock: fixture.lock,
      signal: controller.signal,
      assertMissionAuthority: () => {},
      createProcess: (context) => {
        fixture.worktrees.add(context.worktree.worktreePath);
        return fixture.processSpec(context, false);
      },
    });

    assert.equal(finishedCount, fixture.lock.contestants.length);
    assert.equal(controller.signal.aborted, true);
    assert.equal(
      result.contestantResults.every((contestant) =>
        contestant.status === "succeeded"),
      true,
    );
    assert.equal(result.replay.state, "cleanupComplete");
    assert.deepEqual(result.replay.finalization?.payload, {
      payloadType: "runFinalized",
      outcome: "completed",
      comparison: "comparable",
      reasonCode: null,
      evidenceMatrixSha256:
        (result.replay.finalization?.payload as {
          readonly evidenceMatrixSha256: string;
        }).evidenceMatrixSha256,
    });
    assert.match(
      (result.replay.finalization?.payload as {
        readonly evidenceMatrixSha256?: string;
      }).evidenceMatrixSha256 ?? "",
      /^[a-f0-9]{64}$/u,
    );
  },
);

test(
  "aborting after both hanging heads edit yields quiescent evidence-bound cancellation and exact cleanup",
  { timeout: DUAL_HEAD_RACE_TIMEOUT_MS },
  async (t: TestContext) => {
    const controller = new AbortController();
    let cleanupRun: Promise<unknown> | undefined;
    // TestContext after hooks run in registration order. Register the drain
    // before createFixture registers filesystem cleanup so an outer timeout or
    // assertion failure cannot remove worktrees beneath a live controller.
    t.after(async () => {
      controller.abort(new Error("controller race test cleanup"));
      await cleanupRun?.catch(() => undefined);
    });
    const fixture = await createFixture(t, "cancel");
    if (!fixture) return;
    const worktrees = new Map<string, string>();
    const running = runArenaController({
      runId: fixture.runId,
      workspaceRoot: fixture.sourceRoot,
      privateWorkspaceRoot: fixture.privateRoot,
      repositoryLeaseRoot: fixture.leaseRoot,
      gitResolutionRoot: process.cwd(),
      lock: fixture.lock,
      signal: AbortSignal.any([controller.signal, t.signal]),
      assertMissionAuthority: () => {},
      createProcess: (context) => {
        worktrees.set(
          context.contestant.contestantId,
          context.worktree.worktreePath,
        );
        fixture.worktrees.add(context.worktree.worktreePath);
        return fixture.processSpec(context, true);
      },
    });
    cleanupRun = running;
    let earlyFailure: { readonly error: unknown } | undefined;
    void running.catch((error: unknown) => {
      earlyFailure = { error };
    });
    let readinessDetail = "worktrees=0/2";

    try {
      await waitFor(async () => {
        if (earlyFailure) throw earlyFailure.error;
        const states = await Promise.all([...worktrees.entries()].map(
          async ([contestantId, worktreePath]) => {
            const [fixtureBody, evidenceBody] = await Promise.all([
              readIfPresent(path.join(worktreePath, "fixture.txt")),
              readIfPresent(path.join(worktreePath, "evidence.txt")),
            ]);
            const fixtureState = fixtureBody === undefined
              ? "missing"
              : fixtureBody === HEAD_CONTENT ? "expected" : "other";
            const evidenceState = evidenceBody === undefined
              ? "missing"
              : evidenceBody === UNTRACKED_CONTENT ? "expected" : "other";
            return {
              ready: fixtureState === "expected" && evidenceState === "expected",
              summary: `${contestantId}:fixture=${fixtureState},evidence=${evidenceState}`,
            };
          },
        ));
        readinessDetail = `worktrees=${worktrees.size}/2; ${
          states.map((state) => state.summary).join("; ") || "no contestants dispatched"
        }`;
        return worktrees.size === 2 && states.every((state) => state.ready);
      }, () => (
        `both fake heads to receive stdin and finish their edits (${readinessDetail})`
      ), DUAL_HEAD_READY_TIMEOUT_MS, 100);
    } catch (error) {
      // A failed readiness assertion must not leave the controller running
      // while test hooks remove its worktrees or the next test installs global
      // prototype mocks. Abort and drain before surfacing the original error.
      controller.abort(error);
      await running.catch(() => undefined);
      throw error;
    }
    controller.abort(new Error("synthetic local-user Stop"));
    const result = await running;

    assert.equal(result.contestantResults.length, 2);
    assert.equal(
      result.contestantResults.every((contestant) =>
        contestant.status === "cancelled"
        && contestant.failureCode === "cancelled"
        && contestant.terminationConfirmed
        && contestant.submissionReceiptSha256 !== null
        && contestant.quiescenceReceiptSha256 !== null
        && contestant.quiescenceWorkspaceFingerprintSha256 !== null),
      true,
    );
    assert.equal(result.replay.state, "cleanupComplete");
    const finalization = result.replay.finalization?.payload as
      | {
          readonly outcome: string;
          readonly comparison: string;
          readonly reasonCode: string | null;
          readonly evidenceMatrixSha256: string | null;
        }
      | undefined;
    assert.deepEqual(finalization, {
      payloadType: "runFinalized",
      outcome: "cancelled",
      comparison: "incomplete",
      reasonCode: "userCancelled",
      evidenceMatrixSha256: null,
    });
    assert.equal(
      result.replay.contestants.every((contestant) =>
        contestant.evidencePreserved !== undefined
        && contestant.cleanup.status === "complete"),
      true,
    );

    for (const contestant of fixture.lock.contestants) {
      const artifactDirectory = arenaContestantArtifactPath(
        fixture.privateRoot,
        fixture.runId,
        contestant.contestantId,
      );
      assert.deepEqual(
        (await fs.readdir(artifactDirectory)).sort(),
        [
          "artifact-set.v1.json",
          "inventory.v2.json",
          "patch.bin",
          "untracked.v2.bin",
        ],
      );
      const worktreePath = worktrees.get(contestant.contestantId);
      assert.ok(worktreePath);
      await assert.rejects(fs.lstat(worktreePath), { code: "ENOENT" });
    }
    const dispatchFiles = await listPrivateFiles(path.join(
      fixture.privateRoot,
      "arena",
      "support",
      "dispatch",
      fixture.runId,
    ));
    assert.equal(
      dispatchFiles.filter((file) => file.endsWith("intent.v1.json")).length,
      2,
    );
    assert.equal(
      dispatchFiles.filter((file) =>
        file.endsWith("submission.v1.json")).length,
      2,
    );
    assert.equal(
      dispatchFiles.filter((file) =>
        file.endsWith("quiescence.v1.json")).length,
      2,
    );
    assert.equal(
      await fs.readFile(
        path.join(fixture.sourceRoot, "fixture.txt"),
        "utf8",
      ),
      BASE_CONTENT,
    );
    await assert.rejects(
      fs.lstat(path.join(fixture.sourceRoot, "evidence.txt")),
      { code: "ENOENT" },
    );
    const leaseEvents = await readLeaseEvents(fixture.leaseRoot);
    assert.equal(leaseEvents.at(-1)?.type, "claimReleased");
    assert.equal(
      (leaseEvents.at(-1)?.payload as { readonly runId?: string }).runId,
      fixture.runId,
    );
  },
);

test(
  "a source mutation while postEvidence publication resolves is sealed as compromised",
  { timeout: 120_000 },
  async (t: TestContext) => {
    const controller = new AbortController();
    let cleanupRun: Promise<unknown> | undefined;
    // Drain production work before createFixture removes any worktree state.
    t.after(async () => {
      controller.abort(new Error("controller race test cleanup"));
      await cleanupRun?.catch(() => undefined);
    });
    const fixture = await createFixture(t, "post-evidence-publication");
    if (!fixture) return;
    const originalAppend = FileArenaManifestStore.prototype.append;
    let injected = false;
    t.mock.method(
      FileArenaManifestStore.prototype,
      "append",
      async function injectDuringPublication(
        this: FileArenaManifestStore,
        ...args: Parameters<typeof originalAppend>
      ) {
        const event = await originalAppend.apply(this, args);
        const payload = args[0].payload as {
          readonly observationKind?: string;
        };
        if (!injected && payload.observationKind === "postEvidence") {
          injected = true;
          await fs.writeFile(
            path.join(fixture.sourceRoot, "fixture.txt"),
            "mutated while postEvidence append resolved\n",
            "utf8",
          );
        }
        return event;
      },
    );

    const running = runArenaController({
      runId: fixture.runId,
      workspaceRoot: fixture.sourceRoot,
      privateWorkspaceRoot: fixture.privateRoot,
      repositoryLeaseRoot: fixture.leaseRoot,
      gitResolutionRoot: process.cwd(),
      lock: fixture.lock,
      signal: AbortSignal.any([controller.signal, t.signal]),
      assertMissionAuthority: () => {},
      createProcess: (context) => {
        fixture.worktrees.add(context.worktree.worktreePath);
        return fixture.processSpec(context, false);
      },
    });
    cleanupRun = running;
    const result = await running;

    assert.equal(injected, true);
    assert.equal(result.replay.state, "cleanupComplete");
    assert.equal(result.replay.compromised, true);
    assert.equal(result.replay.promotionEligible, false);
    assert.equal(
      (result.replay.finalization?.payload as { comparison?: string })
        .comparison,
      "compromised",
    );
    const terminalObservation = result.replay.mainWorkspaceObservations.at(-1)
      ?.payload as {
        readonly observationKind?: string;
        readonly status?: string;
        readonly publicationOfEventSha256?: string;
      };
    assert.equal(terminalObservation.observationKind, "publicationSeal");
    assert.equal(terminalObservation.status, "changed");
    assert.match(
      terminalObservation.publicationOfEventSha256 ?? "",
      /^[a-f0-9]{64}$/u,
    );
  },
);

test(
  "an ignored file created after capture cannot cross the evidence publication gap",
  { timeout: 120_000 },
  async (t: TestContext) => {
    const fixture = await createFixture(t, "ignored-publication-gap");
    if (!fixture) return;
    const originalCapture =
      ArenaGitExecutor.prototype.captureOwnedEvidenceState;
    let injected = false;
    t.mock.method(
      ArenaGitExecutor.prototype,
      "captureOwnedEvidenceState",
      async function injectedIgnoredFile(
        this: ArenaGitExecutor,
        ...args: Parameters<typeof originalCapture>
      ) {
        const state = await originalCapture.apply(this, args);
        if (!injected) {
          injected = true;
          await fs.writeFile(
            path.join(args[0].worktreePath, "late-output.ignored"),
            "created after staged evidence capture\n",
            "utf8",
          );
        }
        return state;
      },
    );

    await assert.rejects(
      runArenaController({
        runId: fixture.runId,
        workspaceRoot: fixture.sourceRoot,
        privateWorkspaceRoot: fixture.privateRoot,
        repositoryLeaseRoot: fixture.leaseRoot,
        gitResolutionRoot: process.cwd(),
        lock: fixture.lock,
        assertMissionAuthority: () => {},
        createProcess: (context) => {
          fixture.worktrees.add(context.worktree.worktreePath);
          return fixture.processSpec(context, false);
        },
      }),
      /refuses ignored contestant files/i,
    );
    assert.equal(injected, true);
  },
);

test(
  "locked verification and browser plans execute in every contestant worktree and project to Flight",
  { timeout: 120_000 },
  async (t: TestContext) => {
    const fixture = await createFixture(t, "acceptance-flight");
    if (!fixture) return;
    const verificationPlan = createArenaVerificationExecutionPlan({
      checkId: "locked-check",
      command: "hydra-test --locked-check",
      controlSha256: digest("locked-check-control"),
      timeoutMs: 30_000,
      maxOutputChars: 8_192,
    });
    const browserPlan = createArenaBrowserJourneyExecutionPlan({
      journeyId: "locked-journey",
      journeyDefinitionSha256: digest("locked-journey-definition"),
      timeoutMs: 30_000,
    });
    const lock: ArenaRunLockedPayload = {
      ...fixture.lock,
      verificationChecks: [{
        checkId: verificationPlan.checkId,
        planSha256: verificationPlan.planSha256,
      }],
      browserJourneys: [{
        journeyId: browserPlan.journeyId,
        planSha256: browserPlan.planSha256,
      }],
    };
    const worktrees = new Map<string, string>();
    const verifiedWorktrees: string[] = [];
    const browserWorktrees: string[] = [];

    const result = await runArenaController({
      runId: fixture.runId,
      workspaceRoot: fixture.sourceRoot,
      privateWorkspaceRoot: fixture.privateRoot,
      repositoryLeaseRoot: fixture.leaseRoot,
      gitResolutionRoot: process.cwd(),
      lock,
      verificationPlans: [verificationPlan],
      browserJourneyPlans: [browserPlan],
      assertMissionAuthority: () => {},
      createProcess: (context) => {
        worktrees.set(
          context.contestant.contestantId,
          context.worktree.worktreePath,
        );
        fixture.worktrees.add(context.worktree.worktreePath);
        return fixture.processSpec(context, false);
      },
      executeVerification: async (execution) => {
        verifiedWorktrees.push(execution.worktreePath);
        assert.equal(execution.command, verificationPlan.command);
        return {
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          durationMs: 5,
          stdout: { bytes: 0, sha256: digest("") },
          stderr: { bytes: 0, sha256: digest("") },
          terminationConfirmed: true,
          quiescenceReceiptSha256: digest(
            `verification-quiescence:${execution.worktreePath}`,
          ),
        };
      },
      executeBrowserJourney: async (execution) => {
        browserWorktrees.push(execution.worktreePath);
        assert.equal(
          execution.journeyDefinitionSha256,
          browserPlan.journeyDefinitionSha256,
        );
        return {
          status: "passed",
          durationMs: 7,
          actionCount: 2,
          screenshotCount: 1,
          executionStarted: true,
          brokerReceiptSha256: digest(
            `browser-broker:${execution.worktreePath}`,
          ),
          quiescenceReceiptSha256: digest(
            `browser-quiescence:${execution.worktreePath}`,
          ),
        };
      },
    });

    const expectedWorktrees = [...worktrees.values()].sort();
    assert.deepEqual(verifiedWorktrees.sort(), expectedWorktrees);
    assert.deepEqual(browserWorktrees.sort(), expectedWorktrees);
    assert.equal(result.flightProjectionComplete, true);
    assert.equal(
      (result.replay.finalization?.payload as { readonly comparison?: string })
        .comparison,
      "comparable",
    );
    assert.equal(
      result.replay.contestants.every((contestant) =>
        contestant.verifications[0]?.attempts.length === 1
        && contestant.browserJourneys[0]?.attempts.length === 1),
      true,
    );
    const acceptanceFiles = await listPrivateFiles(path.join(
      fixture.privateRoot,
      "arena",
      "support",
      "acceptance",
      fixture.runId,
    ));
    assert.equal(acceptanceFiles.length, lock.contestants.length * 2);
    await verifyArenaFlightProjection(fixture.privateRoot, result.replay);
  },
);

interface ControllerFixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly privateRoot: string;
  readonly leaseRoot: string;
  readonly git: string;
  readonly runId: string;
  readonly lock: ArenaRunLockedPayload;
  readonly worktrees: Set<string>;
  processSpec(
    context: ArenaControllerProcessContext,
    hang: boolean,
  ): ArenaControllerProcessSpec;
}

async function createFixture(
  t: TestContext,
  label: string,
): Promise<ControllerFixture | undefined> {
  const git = await resolveGitExecutable(process.cwd());
  if (!git) {
    t.skip("native Git is unavailable");
    return undefined;
  }
  const tempParent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempParent, FIXTURE_PREFIX));
  const sourceRoot = path.join(root, "source");
  const privateRoot = path.join(root, "private");
  const leaseRoot = path.join(root, "lease");
  const worktrees = new Set<string>();
  t.after(async () => {
    await removeFixtureExactly({
      tempParent,
      root,
      sourceRoot,
      privateRoot,
      git,
      worktrees,
    });
  });
  await fs.mkdir(sourceRoot);
  await initializeRepository(git, sourceRoot);
  const inspector = await ArenaGitExecutor.open(
    sourceRoot,
    privateRoot,
    leaseRoot,
    process.cwd(),
  );
  const admission = await inspector.inspectAdmission();
  const runId = `race-${label}-${randomUUID()}`;
  const lock = raceLock(runId, admission);
  const fakeHelper = path.resolve(
    __dirname,
    "..",
    "src",
    "arenaFakeHeadCli.js",
  );
  const fakeHelperIdentitySha256 =
    await arenaProcessFileIdentitySha256(fakeHelper);

  return {
    root,
    sourceRoot,
    privateRoot,
    leaseRoot,
    git,
    runId,
    lock,
    worktrees,
    processSpec(context, hang) {
      const input = "Identical controller race input.";
      const request: ArenaFakeHeadRequest = {
        schemaVersion: 1,
        requestType: "arenaFakeHead",
        runId,
        contestantId: context.contestant.contestantId,
        traceId: context.traceId,
        registrationSha256: context.worktree.registrationSha256,
        processGenerationId: context.processGenerationId,
        input,
        inputSha256: sha256ArenaProcessUtf8(input),
        fixtureRelativePath: "fixture.txt",
        fixtureContent: HEAD_CONTENT,
        untrackedRelativePath: "evidence.txt",
        untrackedContent: UNTRACKED_CONTENT,
        delayMs: 0,
        exitCode: 0,
        hang,
      };
      return {
        command: path.resolve(process.execPath),
        args: [fakeHelper],
        stdin: `${canonicalArenaManifestJson(request)}\n`,
        contextSha256: digest(
          `${runId}:${context.contestant.contestantId}:context`,
        ),
        // Hanging heads are stopped by the race under test. Their own timeout
        // must outlive two-head Windows dispatch/readiness contention so it
        // cannot win the race and change the asserted outcome.
        timeoutMs: hang ? HANGING_HEAD_TIMEOUT_MS : HANG_NET_TIMEOUT_MS,
        bundledHelper: {
          scriptPath: fakeHelper,
          scriptFileIdentitySha256: fakeHelperIdentitySha256,
        },
      };
    },
  };
}

function raceLock(
  runId: string,
  admission: ArenaGitAdmission,
): ArenaRunLockedPayload {
  return {
    payloadType: "runLocked",
    policy: ARENA_POLICY_ID,
    mission: {
      missionId: `${runId}-mission`,
      revision: 1,
      documentSha256: digest(`${runId}:mission-document`),
      bindingSha256: digest(`${runId}:mission-binding`),
    },
    base: {
      revision: admission.baseRevision,
      repositoryIdentitySha256: admission.repositoryIdentitySha256,
      baseContentSha256: admission.baseContentSha256,
      sourceWorkspaceFingerprintSha256:
        admission.sourceWorkspaceFingerprintSha256,
      repositoryControlSha256: admission.repositoryControlSha256,
    },
    inputBundleSha256: digest(`${runId}:input`),
    preparationPlanSha256: null,
    environmentPolicySha256:
      arenaProcessEnvironmentPolicySha256(process.env, true),
    budgetSha256: digest(`${runId}:budget`),
    verificationChecks: [],
    browserJourneys: [],
    contestants: ["codex", "claude"].map((contestantId) => ({
      contestantId,
      headId: contestantId,
      agentKind: contestantId,
      headConfigSha256: digest(`${runId}:${contestantId}:config`),
      authoritySha256: digest(`${runId}:${contestantId}:authority`),
      invocationSha256: digest(`${runId}:${contestantId}:invocation`),
      worktreeId: `${contestantId}-worktree`,
    })),
    steering: "disabled",
    confirmation: {
      actorId: "local-user",
      action: "Confirm Arena Run",
      confirmationId: `${runId}-confirmation`,
    },
  };
}

async function initializeRepository(
  git: string,
  sourceRoot: string,
): Promise<void> {
  await runGit(git, sourceRoot, [
    "init",
    "--quiet",
    "--initial-branch=main",
  ]);
  await runGit(git, sourceRoot, [
    "config",
    "--local",
    "user.name",
    "Hydra Arena Controller Race",
  ]);
  await runGit(git, sourceRoot, [
    "config",
    "--local",
    "user.email",
    "arena-controller-race@invalid.local",
  ]);
  await fs.writeFile(
    path.join(sourceRoot, "fixture.txt"),
    BASE_CONTENT,
    "utf8",
  );
  await fs.writeFile(
    path.join(sourceRoot, ".gitignore"),
    "*.ignored\n",
    "utf8",
  );
  await runGit(git, sourceRoot, ["add", "--", ".gitignore", "fixture.txt"]);
  await runGit(
    git,
    sourceRoot,
    ["commit", "--quiet", "-m", "Arena controller race base"],
  );
}

async function runGit(
  git: string,
  cwd: string,
  args: readonly string[],
): Promise<void> {
  await runArenaGitCommand(
    git,
    cwd,
    [
      "--no-pager",
      "--no-optional-locks",
      "--no-replace-objects",
      "--no-lazy-fetch",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      ...args,
    ],
    { timeoutMs: 30_000 },
  );
}

async function listPrivateFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string, relative: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const childRelative = relative
        ? path.join(relative, entry.name)
        : entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(absolute, childRelative);
      } else {
        assert.equal(entry.isFile(), true);
        assert.equal(entry.isSymbolicLink(), false);
        files.push(childRelative);
      }
    }
  };
  await visit(root, "");
  return files.sort();
}

async function readLeaseEvents(
  leaseRoot: string,
): Promise<readonly {
  readonly type: string;
  readonly payload: unknown;
}[]> {
  const entries = await fs.readdir(leaseRoot);
  const ledgers = entries.filter((entry) =>
    entry.endsWith(".owner.v1.jsonl"));
  assert.equal(ledgers.length, 1);
  const body = await fs.readFile(path.join(leaseRoot, ledgers[0]!), "utf8");
  return body.trimEnd().split("\n").map((line) =>
    JSON.parse(line) as { readonly type: string; readonly payload: unknown });
}

async function waitFor(
  predicate: () => Promise<boolean>,
  label: string | (() => string),
  timeoutMs = HANG_NET_TIMEOUT_MS,
  pollMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  const detail = typeof label === "function" ? label() : label;
  throw new Error(`Timed out waiting for ${detail}.`);
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function removeFixtureExactly(input: {
  readonly tempParent: string;
  readonly root: string;
  readonly sourceRoot: string;
  readonly privateRoot: string;
  readonly git: string;
  readonly worktrees: ReadonlySet<string>;
}): Promise<void> {
  for (const worktreePath of input.worktrees) {
    let stat;
    try {
      stat = await fs.lstat(worktreePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const expectedParent = path.join(
      input.privateRoot,
      "arena",
      "worktrees",
      "p",
    );
    assert.equal(path.dirname(worktreePath), expectedParent);
    assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true);
    assert.equal(await fs.realpath(worktreePath), worktreePath);
    await runGit(input.git, input.sourceRoot, [
      "worktree",
      "remove",
      "--force",
      "--force",
      worktreePath,
    ]);
    await assert.rejects(fs.lstat(worktreePath), { code: "ENOENT" });
  }
  await runGit(input.git, input.sourceRoot, [
    "worktree",
    "prune",
    "--expire=now",
  ]);

  const absoluteRoot = path.resolve(input.root);
  assert.equal(path.dirname(absoluteRoot), input.tempParent);
  assert.equal(path.basename(absoluteRoot).startsWith(FIXTURE_PREFIX), true);
  const stat = await fs.lstat(absoluteRoot);
  assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true);
  assert.equal(await fs.realpath(absoluteRoot), absoluteRoot);
  await fs.rm(absoluteRoot, {
    recursive: true,
    force: false,
    maxRetries: 20,
    retryDelay: 100,
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
