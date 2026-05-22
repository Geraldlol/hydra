import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { createPromptEnvelope, appendPromptEnvelope, promptEnvelopeIndexPath } from "../src/promptPreview";
import { cleanWorkspaceState, pruneDiagnosticArtifacts } from "../src/workspaceCleanup";

describe("workspace cleanup", () => {
  test("prunes stale terminal diagnostics while preserving recent files and prompt index", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-diagnostic-cleanup-"));
    const now = new Date("2026-05-22T00:00:00.000Z");
    const old = new Date("2026-05-01T00:00:00.000Z");
    const recent = new Date("2026-05-21T00:00:00.000Z");

    const oldLog = await writeDiagnostic(dir, ".hydra/logs/old.log", "old log", old);
    const recentLog = await writeDiagnostic(dir, ".hydra/logs/recent.log", "recent log", recent);
    const oldReply = await writeDiagnostic(dir, ".hydra/replies/old.json", "{}", old);
    const oldDispatch = await writeDiagnostic(dir, ".hydra/dispatch/old.ps1", "Write-Host old", old);
    const oldPromptFile = await writeDiagnostic(dir, ".hydra/prompts/old.md", "old prompt", old);
    const promptIndex = await writeDiagnostic(dir, ".hydra/prompts/index.jsonl", "{\"id\":\"keep\"}\n", old);

    const summary = await pruneDiagnosticArtifacts(dir, { retentionDays: 7, now });

    assert.equal(summary.deletedFiles, 4);
    assert.equal(summary.failedDeletes, 0);
    assert.ok(summary.deletedBytes > 0);
    await assert.rejects(fs.stat(oldLog), /ENOENT/);
    await assert.rejects(fs.stat(oldReply), /ENOENT/);
    await assert.rejects(fs.stat(oldDispatch), /ENOENT/);
    await assert.rejects(fs.stat(oldPromptFile), /ENOENT/);
    assert.equal(await fs.readFile(recentLog, "utf8"), "recent log");
    assert.equal(await fs.readFile(promptIndex, "utf8"), "{\"id\":\"keep\"}\n");
  });

  test("full cleanup compacts prompt bodies and prunes stale diagnostics", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-workspace-cleanup-"));
    const now = new Date("2026-05-22T00:00:00.000Z");
    const old = new Date("2026-05-01T00:00:00.000Z");
    await appendPromptEnvelope(dir, createPromptEnvelope({
      id: "old",
      timestamp: old.toISOString(),
      agent: "codex",
      otherAgent: "claude",
      phase: "opener",
      transport: "oneShot",
      cwd: dir,
      command: "codex",
      args: ["exec", "-"],
      renderedPrompt: "Old prompt body.",
    }));
    const oldLog = await writeDiagnostic(dir, ".hydra/logs/old.log", "old log", old);

    const summary = await cleanWorkspaceState(dir, {
      promptBodyRetentionDays: 3,
      diagnosticRetentionDays: 7,
      now,
    });

    assert.equal(summary.promptBodies.compactedRecords, 1);
    assert.equal(summary.diagnostics.deletedFiles, 1);
    await assert.rejects(fs.stat(oldLog), /ENOENT/);
    const raw = await fs.readFile(promptEnvelopeIndexPath(dir), "utf8");
    const record = JSON.parse(raw.trim());
    assert.equal(record.renderedPrompt, "");
    assert.equal(record.renderedPromptOmitted, true);
  });
});

async function writeDiagnostic(root: string, relativePath: string, body: string, mtime: Date): Promise<string> {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, body, "utf8");
  await fs.utimes(filePath, mtime, mtime);
  return filePath;
}

