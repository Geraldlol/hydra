import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendDecision,
  decisionHasNoUserBlockers,
  detectRiskySignals,
  ensureDecisionsFile,
  parseDecisionPacket,
  readDecisions,
  resolveDecisionAction,
} from "../src/decisions";

describe("decision packets", () => {
  test("parses the required decision packet headings", () => {
    const packet = parseDecisionPacket(
      [
        "Accepted. Ship the visible room state first.",
        "",
        "Recommendation: Build Live Room v0.",
        "Default next action: Codex patches decision persistence.",
        "Decision needed from user: none",
        "Blockers: none",
      ].join("\n"),
      {
        agent: "codex",
        phase: "closer",
        sourceMessageTimestamp: "2026-05-08T20:00:00.000Z",
        timestamp: "2026-05-08T20:00:01.000Z",
      }
    );

    assert.deepEqual(packet, {
      timestamp: "2026-05-08T20:00:01.000Z",
      agent: "codex",
      phase: "closer",
      recommendation: "Build Live Room v0.",
      defaultNextAction: "Codex patches decision persistence.",
      decisionNeededFromUser: "none",
      blockers: "none",
      sourceMessageTimestamp: "2026-05-08T20:00:00.000Z",
    });
  });

  test("keeps multiline packet fields until the next heading", () => {
    const packet = parseDecisionPacket(
      [
        "Recommendation: Patch two things:",
        "- persist packets",
        "- show latest packet",
        "Default next action: Run checks.",
        "Decision needed from user: none",
        "Blockers: CLI smoke test still pending.",
      ].join("\n"),
      {
        agent: "claude",
        phase: "reactor",
        sourceMessageTimestamp: "2026-05-08T20:00:00.000Z",
      }
    );

    assert.equal(packet?.recommendation, "Patch two things:\n- persist packets\n- show latest packet");
    assert.equal(packet?.blockers, "CLI smoke test still pending.");
  });

  test("returns undefined when a required heading is missing", () => {
    const packet = parseDecisionPacket(
      [
        "Recommendation: Build it.",
        "Default next action: Patch.",
        "Blockers: none",
      ].join("\n"),
      {
        agent: "codex",
        phase: "opener",
        sourceMessageTimestamp: "2026-05-08T20:00:00.000Z",
      }
    );

    assert.equal(packet, undefined);
  });

  test("creates, appends, and reads decision JSONL", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-decisions-"));
    const file = path.join(dir, ".hydra", "decisions.jsonl");

    await ensureDecisionsFile(file);
    assert.deepEqual(await readDecisions(file), []);

    const packet = parseDecisionPacket(
      [
        "Recommendation: Persist decision packets.",
        "Default next action: Add tests.",
        "Decision needed from user: none",
        "Blockers: none",
      ].join("\n"),
      {
        agent: "codex",
        phase: "closer",
        sourceMessageTimestamp: "2026-05-08T20:00:00.000Z",
        timestamp: "2026-05-08T20:00:01.000Z",
      }
    );
    assert.ok(packet);
    await appendDecision(file, packet);
    await fs.appendFile(file, "\nnot json\n", "utf8");

    assert.deepEqual(await readDecisions(file), [packet]);
  });

  test("resolves builder defaults into assign-builder actions", () => {
    const packet = parseDecisionPacket(
      [
        "Recommendation: Patch the room.",
        "Default next action: Codex patches the live work board.",
        "Decision needed from user: none",
        "Blockers: none",
      ].join("\n"),
      {
        agent: "claude",
        phase: "reactor",
        sourceMessageTimestamp: "2026-05-08T20:00:00.000Z",
      }
    );

    const action = resolveDecisionAction(packet, "AwaitingUser");
    assert.equal(action.kind, "assignBuilder");
    assert.equal(action.builder, "codex");
    assert.match(action.label, /Codex/);
  });

  test("resolves build-done and review-done actions from room state", () => {
    const packet = parseDecisionPacket(
      [
        "Recommendation: Keep moving.",
        "Default next action: Request review.",
        "Decision needed from user: none",
        "Blockers: none",
      ].join("\n"),
      {
        agent: "codex",
        phase: "build",
        sourceMessageTimestamp: "2026-05-08T20:00:00.000Z",
      }
    );

    assert.equal(resolveDecisionAction(packet, "BuildDone").kind, "requestReview");

    const handBack = parseDecisionPacket(
      [
        "Recommendation: Fix review blockers.",
        "Default next action: Hand back to builder.",
        "Decision needed from user: none",
        "Blockers: tests need an update",
      ].join("\n"),
      {
        agent: "claude",
        phase: "review",
        sourceMessageTimestamp: "2026-05-08T20:00:00.000Z",
      }
    );
    assert.equal(resolveDecisionAction(handBack, "ReviewDone").kind, "handBack");
  });

  test("falls back to sending the default as an instruction", () => {
    const packet = parseDecisionPacket(
      [
        "Recommendation: Choose the next feature.",
        "Default next action: Ask both agents to compare release risks.",
        "Decision needed from user: none",
        "Blockers: none",
      ].join("\n"),
      {
        agent: "codex",
        phase: "closer",
        sourceMessageTimestamp: "2026-05-08T20:00:00.000Z",
      }
    );

    const action = resolveDecisionAction(packet, "AwaitingUser");
    assert.equal(action.kind, "sendInstruction");
    assert.match(action.instruction ?? "", /Accepted default next action/);
  });

  test("does not send host-only AwaitingUser defaults back into the room", () => {
    const transition = parseDecisionPacket(
      [
        "Recommendation: Transition the room to AwaitingUser.",
        "Default next action: Hydra should transition this turn to `AwaitingUser` so the Assign Builder controls can become visible.",
        "Decision needed from user: none",
        "Blockers: none",
      ].join("\n"),
      {
        agent: "codex",
        phase: "closer",
        sourceMessageTimestamp: "2026-05-08T20:00:00.000Z",
      }
    );
    const reveal = parseDecisionPacket(
      [
        "Recommendation: Transition the room to AwaitingUser.",
        "Default next action: Hydra should reveal the Assign Builder controls so the user can choose the builder.",
        "Decision needed from user: none",
        "Blockers: none",
      ].join("\n"),
      {
        agent: "codex",
        phase: "opener",
        sourceMessageTimestamp: "2026-05-08T20:00:01.000Z",
      }
    );

    assert.equal(resolveDecisionAction(transition, "AwaitingUser").kind, "none");
    assert.equal(resolveDecisionAction(reveal, "AwaitingUser").kind, "none");
  });

  test("uses packet author for executable defaults with no named agent", () => {
    const packet = parseDecisionPacket(
      [
        "Recommendation: Verify the extension.",
        "Default next action: Hydra runs npm test in tools/vscode-hydra-room and reports back.",
        "Decision needed from user: none",
        "Blockers: none",
      ].join("\n"),
      {
        agent: "codex",
        phase: "closer",
        sourceMessageTimestamp: "2026-05-08T20:00:00.000Z",
      }
    );

    const action = resolveDecisionAction(packet, "AwaitingUser");
    assert.equal(action.kind, "assignBuilder");
    assert.equal(action.builder, "codex");
  });

  test("treats self-owned diff review and staging defaults as builder authority", () => {
    const packet = parseDecisionPacket(
      [
        "Recommendation: Let the agent that picked up the work continue.",
        "Default next action: Review the diff, propose a commit grouping, and either present it for approval or start staging.",
        "Decision needed from user: none",
        "Blockers: none",
      ].join("\n"),
      {
        agent: "codex",
        phase: "opener",
        sourceMessageTimestamp: "2026-05-16T17:34:27.854Z",
      }
    );

    const action = resolveDecisionAction(packet, "AwaitingUser");
    assert.equal(action.kind, "assignBuilder");
    assert.equal(action.builder, "codex");
  });

  test("treats unnamed self-claim defaults as authority for the packet author", () => {
    const packet = parseDecisionPacket(
      [
        "Recommendation: Let Claude keep the work he picked up.",
        "Default next action: I've got this; let me continue.",
        "Decision needed from user: none",
        "Blockers: none",
      ].join("\n"),
      {
        agent: "claude",
        phase: "opener",
        sourceMessageTimestamp: "2026-05-16T17:38:16.826Z",
      }
    );

    const action = resolveDecisionAction(packet, "AwaitingUser");
    assert.equal(action.kind, "assignBuilder");
    assert.equal(action.builder, "claude");
  });

  test("detects auto-advanceable decisions with no user blockers", () => {
    const packet = parseDecisionPacket(
      [
        "Recommendation: Implement the patch.",
        "Default next action: Codex patches the room.",
        "Decision needed from user: none",
        "Blockers: none",
      ].join("\n"),
      {
        agent: "claude",
        phase: "reactor",
        sourceMessageTimestamp: "2026-05-08T20:00:00.000Z",
      }
    );
    const blocked = parseDecisionPacket(
      [
        "Recommendation: Implement the patch.",
        "Default next action: Codex patches the room.",
        "Decision needed from user: choose the UI label",
        "Blockers: none",
      ].join("\n"),
      {
        agent: "claude",
        phase: "reactor",
        sourceMessageTimestamp: "2026-05-08T20:00:00.000Z",
      }
    );

    assert.equal(decisionHasNoUserBlockers(packet), true);
    assert.equal(decisionHasNoUserBlockers(blocked), false);
    assert.equal(decisionHasNoUserBlockers(undefined), false);
  });

  test("detectRiskySignals flags destructive patterns in default action or recommendation", () => {
    const base = {
      timestamp: "2026-05-12T00:00:00.000Z",
      agent: "codex" as const,
      sourceMessageTimestamp: "2026-05-12T00:00:00.000Z",
      decisionNeededFromUser: "none",
      blockers: "none",
      recommendation: "Recommendation text",
      defaultNextAction: "Default text",
    };
    assert.equal(detectRiskySignals(undefined).risky, false);
    assert.equal(detectRiskySignals(base).risky, false);
    assert.deepEqual(
      detectRiskySignals({ ...base, defaultNextAction: "Run git push --force to origin main" }).reasons.sort(),
      ["force-push", "push"].sort(),
    );
    assert.equal(detectRiskySignals({ ...base, recommendation: "rm -rf node_modules and rebuild" }).reasons[0], "rm -rf");
    assert.equal(detectRiskySignals({ ...base, defaultNextAction: "Run the migration to add the new column" }).reasons[0], "migration");
    assert.equal(detectRiskySignals({ ...base, recommendation: "drop table users and recreate it cleanly" }).reasons[0], "drop-table");
    assert.equal(detectRiskySignals({ ...base, defaultNextAction: "Use --no-verify to skip the failing hook" }).reasons[0], "skip-hooks");
    // Non-destructive push (e.g. dry-run) should not trigger the bare push pattern.
    assert.equal(detectRiskySignals({ ...base, defaultNextAction: "git push --dry-run origin main" }).reasons.includes("push"), false);
  });
});
