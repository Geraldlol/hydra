import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendPromptEnvelope,
  analyzePromptBudget,
  createPromptEnvelope,
  formatCommand,
  promptEnvelopeIndexPath,
  readLatestPromptEnvelope,
  renderPromptEnvelopePreview,
} from "../src/promptPreview";

describe("prompt preview envelopes", () => {
  test("creates a compact prompt envelope", () => {
    const envelope = createPromptEnvelope({
      id: "p1",
      timestamp: "2026-05-09T10:00:00.000Z",
      agent: "codex",
      otherAgent: "claude",
      phase: "opener",
      transport: "terminalBridge",
      cwd: "C:\\repo",
      command: "codex",
      args: ["exec", "--cd", "C:\\repo", "-"],
      objective: "Ship Hydra",
      currentUserMessage: "Preview this.",
      renderedPrompt: "You are Codex.",
    });
    assert.equal(envelope.authorityLevel, "unknown");
    assert.match(envelope.authority, /Unknown\/custom/);
    assert.equal(envelope.objective, "Ship Hydra");
    assert.equal(envelope.attachments.length, 0);
    assert.equal(envelope.budget.chars, "You are Codex.".length);
    assert.equal(envelope.budget.estimatedTokens, 4);
  });

  test("renders preview with command, prompt budget, and prompt body", () => {
    const envelope = createPromptEnvelope({
      id: "p2",
      timestamp: "2026-05-09T10:00:00.000Z",
      agent: "claude",
      otherAgent: "codex",
      phase: "review",
      transport: "oneShot",
      cwd: "C:\\repo with spaces",
      command: "claude",
      args: ["-p", "--add-dir", "C:\\repo with spaces"],
      latestVerificationSummary: "passed: npm test (4s)",
      renderedPrompt: "Review the diff.",
    });
    const preview = renderPromptEnvelopePreview(envelope);
    assert.match(preview, /Command: claude -p --add-dir "C:\\repo with spaces"/);
    assert.match(preview, /Latest verification: passed: npm test/);
    assert.match(preview, /## Prompt Budget/);
    assert.match(preview, /Total: 16 chars \(~4 tokens\)/);
    assert.match(preview, /```text\nReview the diff\.\n```/);
  });

  test("analyzes prompt budget by prompt sections", () => {
    const budget = analyzePromptBudget([
      "Preamble",
      "",
      "--- Shared context ---",
      "User message",
      "",
      "--- Diff to review (git diff HEAD) ---",
      "+change",
    ].join("\n"));
    assert.equal(budget.sections[0].label, "Preamble");
    assert.equal(budget.sections[1].label, "Shared context");
    assert.equal(budget.sections[2].label, "Diff to review (git diff HEAD)");
    assert.equal(budget.estimatedTokens, Math.ceil(budget.chars / 4));
  });

  test("appends envelopes to .hydra prompts index", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-prompt-envelope-"));
    const envelope = createPromptEnvelope({
      id: "p3",
      agent: "codex",
      otherAgent: "claude",
      phase: "build",
      transport: "terminalBridge",
      cwd: dir,
      command: "codex",
      args: ["exec", "-"],
      renderedPrompt: "Build it.",
    });
    await appendPromptEnvelope(dir, envelope);
    const raw = await fs.readFile(promptEnvelopeIndexPath(dir), "utf8");
    assert.equal(JSON.parse(raw).id, "p3");
  });

  test("reads the latest usable prompt envelope from the index", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-latest-prompt-envelope-"));
    await appendPromptEnvelope(dir, createPromptEnvelope({
      id: "old",
      agent: "codex",
      otherAgent: "claude",
      phase: "opener",
      transport: "oneShot",
      cwd: dir,
      command: "codex",
      args: ["exec", "-"],
      renderedPrompt: "Old prompt.",
    }));
    await fs.appendFile(promptEnvelopeIndexPath(dir), "{not json}\n", "utf8");
    await appendPromptEnvelope(dir, createPromptEnvelope({
      id: "new",
      agent: "claude",
      otherAgent: "codex",
      phase: "review",
      transport: "terminalBridge",
      cwd: dir,
      command: "claude",
      args: ["-p"],
      renderedPrompt: "New prompt.",
    }));

    const latest = await readLatestPromptEnvelope(dir);
    assert.equal(latest?.id, "new");
    assert.equal(latest?.renderedPrompt, "New prompt.");
  });

  test("formats readable command strings", () => {
    assert.equal(formatCommand("codex", ["exec", "--cd", "C:\\repo with spaces", "-"]), 'codex exec --cd "C:\\repo with spaces" -');
  });
});
