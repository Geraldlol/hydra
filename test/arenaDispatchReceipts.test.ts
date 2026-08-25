import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
  loadArenaDispatchGenerations,
  parseArenaDispatchReceipt,
  persistArenaDispatchReceipt,
} from "../src/arenaDispatchReceipts";
import {
  createArenaProcessIntent,
  createArenaProcessSubmissionReceipt,
} from "../src/arenaProcessSupervisor";
import { canonicalArenaManifestJson } from "../src/arenaRunManifest";
import { HANG_NET_TIMEOUT_MS } from "./testBudgets";

function hash(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(canonicalArenaManifestJson(value), "utf8")
    .digest("hex");
}

async function intentFixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-arena-dispatch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = process.execPath;
  const intent = createArenaProcessIntent({
    runId: "run",
    contestantId: "codex",
    traceId: "trace",
    registrationSha256: "a".repeat(64),
    processGenerationId: "generation",
    worktreePath: path.join(root, "secret-worktree"),
    worktreeDirectoryIdentitySha256: "d".repeat(64),
    command,
    commandFileIdentitySha256: "e".repeat(64),
    args: ["secret-argument"],
    stdin: "secret prompt",
    environmentPolicySha256: "b".repeat(64),
    invocationSha256: "c".repeat(64),
    timeoutMs: HANG_NET_TIMEOUT_MS,
  });
  return { root, intent };
}

test("Arena dispatch intent persists metadata only and retries exactly", async (t) => {
  const { root, intent } = await intentFixture(t);
  const first = await persistArenaDispatchReceipt(root, intent);
  const retry = await persistArenaDispatchReceipt(root, intent);
  assert.equal(retry, first);
  const text = await fs.readFile(first, "utf8");
  assert.doesNotMatch(text, /secret prompt|secret-argument|secret-worktree/u);
  assert.match(text, /arenaProcessIntent/u);
});

describe("Arena dispatch recovery loading", () => {
  test("loads receipts through a canonical-equivalent private-root alias", async (t) => {
    const physicalParent = await fs.mkdtemp(
      path.join(os.tmpdir(), "hydra-arena-dispatch-alias-"),
    );
    const aliasParent = `${physicalParent}-alias`;
    try {
      await fs.symlink(
        physicalParent,
        aliasParent,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      await fs.rm(physicalParent, { recursive: true, force: true });
      t.skip(`directory-link creation unavailable: ${String(error)}`);
      return;
    }
    t.after(async () => {
      await fs.unlink(aliasParent).catch(() => undefined);
      await fs.rm(physicalParent, { recursive: true, force: true });
    });
    const privateRoot = path.join(aliasParent, "private-workspace");
    const command = process.execPath;
    const intent = createArenaProcessIntent({
      runId: "run-alias",
      contestantId: "codex",
      traceId: "trace-alias",
      registrationSha256: "a".repeat(64),
      processGenerationId: "generation-alias",
      worktreePath: path.join(aliasParent, "secret-worktree"),
      worktreeDirectoryIdentitySha256: "d".repeat(64),
      command,
      commandFileIdentitySha256: "e".repeat(64),
      args: [],
      stdin: "secret prompt",
      environmentPolicySha256: "b".repeat(64),
      invocationSha256: "c".repeat(64),
      timeoutMs: HANG_NET_TIMEOUT_MS,
    });

    await persistArenaDispatchReceipt(privateRoot, intent);
    const loaded = await loadArenaDispatchGenerations(privateRoot, intent.runId);

    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.generation.state, "intentOnly");
  });

  test("classifies exact intent-only and submitted generations", async (t) => {
    const { root, intent } = await intentFixture(t);
    await persistArenaDispatchReceipt(root, intent);
    let loaded = await loadArenaDispatchGenerations(root, intent.runId);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.generation.state, "intentOnly");

    const submission = createArenaProcessSubmissionReceipt(intent);
    await persistArenaDispatchReceipt(root, submission);
    loaded = await loadArenaDispatchGenerations(root, intent.runId);
    assert.equal(loaded[0]?.generation.state, "submitted");
    assert.equal(
      loaded[0]?.generation.submissionReceiptSha256,
      submission.submissionReceiptSha256,
    );
  });

  test("accepts one exact native proof variant and rejects mixed native keys", async (t) => {
    const { root, intent: baseIntent } = await intentFixture(t);
    const nativeWithoutHash = {
      ...baseIntent,
      nativeAdapterKind: "codex",
      nativeBrokerCapabilitySha256: "f".repeat(64),
    };
    const { intentSha256: _oldIntentHash, ...nativeFields } = nativeWithoutHash;
    const intent = Object.freeze({
      ...nativeFields,
      intentSha256: hash("hydra.arena.process.v1.intent\0", nativeFields),
    });
    const submission = createArenaProcessSubmissionReceipt(intent);
    const quiescenceWithoutHash = {
      schemaVersion: 1 as const,
      receiptType: "arenaProcessQuiescence" as const,
      runId: intent.runId,
      contestantId: intent.contestantId,
      traceId: intent.traceId,
      registrationSha256: intent.registrationSha256,
      processGenerationId: intent.processGenerationId,
      processOwnerSha256: intent.processOwnerSha256,
      intentSha256: intent.intentSha256,
      submissionReceiptSha256: submission.submissionReceiptSha256,
      proof: "nativeAdapterProcessTreeBroker" as const,
      adapterKind: "codex",
      brokerCapabilitySha256: "f".repeat(64),
      brokerReceiptSha256: "9".repeat(64),
      terminationConfirmed: true as const,
      activeProcessCount: 0 as const,
      finalWorkspaceFingerprintSha256: "8".repeat(64),
    };
    const quiescence = Object.freeze({
      ...quiescenceWithoutHash,
      quiescenceReceiptSha256: hash(
        "hydra.arena.process.v1.quiescence\0",
        quiescenceWithoutHash,
      ),
    });
    await persistArenaDispatchReceipt(root, intent);
    await persistArenaDispatchReceipt(root, submission);
    await persistArenaDispatchReceipt(root, quiescence);
    const loaded = await loadArenaDispatchGenerations(root, intent.runId);
    assert.equal(loaded[0]?.generation.state, "quiescent");
    assert.equal(loaded[0]?.quiescence?.proof, "nativeAdapterProcessTreeBroker");

    assert.throws(
      () => parseArenaDispatchReceipt({
        ...baseIntent,
        nativeAdapterKind: "codex",
      }),
      /exact schema|native/i,
    );
  });
});
