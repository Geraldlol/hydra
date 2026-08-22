import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { persistArenaDispatchReceipt } from "../src/arenaDispatchReceipts";
import { createArenaProcessIntent } from "../src/arenaProcessSupervisor";

test("Arena dispatch intent persists metadata only and retries exactly", async (t) => {
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
    timeoutMs: 1_000,
  });
  const first = await persistArenaDispatchReceipt(root, intent);
  const retry = await persistArenaDispatchReceipt(root, intent);
  assert.equal(retry, first);
  const text = await fs.readFile(first, "utf8");
  assert.doesNotMatch(text, /secret prompt|secret-argument|secret-worktree/u);
  assert.match(text, /arenaProcessIntent/u);
});
