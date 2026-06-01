import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { buildWorkQueue } from "../src/workQueue";

describe("work queue", () => {
  test("surfaces actionable default decisions", () => {
    const items = buildWorkQueue({
      decisionAction: {
        kind: "assignBuilder",
        label: "Accept Default: Build with Codex",
        detail: "Codex was named as implementation owner.",
        builder: "codex",
      },
      nativeActions: [],
    });

    assert.equal(items.length, 1);
    const first = items[0];
    assert.ok(first);
    assert.equal(first.kind, "decision");
    assert.equal(first.actionType, "acceptDefaultDecision");
  });

  test("omits generic send-instruction decisions from the queue", () => {
    const items = buildWorkQueue({
      decisionAction: {
        kind: "sendInstruction",
        label: "Accept Default",
        detail: "Send the default action back into the room as the next user instruction.",
        instruction: "Reload the Extension Development Host and report runtime checks.",
      },
      nativeActions: [],
    });

    assert.deepEqual(items, []);
  });

  test("surfaces failed verification ahead of failed native actions", () => {
    const items = buildWorkQueue({
      decisionAction: { kind: "none", label: "No Default Action", detail: "none" },
      latestVerification: {
        timestamp: "2026-05-09T20:00:00.000Z",
        command: "npm test",
        cwd: "C:/repo",
        exitCode: 1,
        timedOut: false,
        durationMs: 2400,
        stdout: "",
        stderr: "failed",
      },
      nativeActions: [{
        id: "native-1",
        timestamp: "2026-05-09T20:01:00.000Z",
        agents: ["claude"],
        instruction: "Try the patch again.",
        includeEditorContext: false,
        includeWorkspaceDiff: false,
        promptEnvelopeIds: [],
        status: "failed",
      }],
    });

    assert.equal(items.length, 2);
    const first = items[0];
    const second = items[1];
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.kind, "verification");
    assert.equal(first.actionType, "discussVerification");
    assert.equal(second.kind, "nativeAction");
    assert.equal(second.actionId, "native-1");
  });

  test("omits passing verification and completed native actions", () => {
    const items = buildWorkQueue({
      decisionAction: { kind: "none", label: "No Default Action", detail: "none" },
      latestVerification: {
        timestamp: "2026-05-09T20:00:00.000Z",
        command: "npm test",
        cwd: "C:/repo",
        exitCode: 0,
        timedOut: false,
        durationMs: 2400,
        stdout: "ok",
        stderr: "",
      },
      nativeActions: [{
        id: "native-1",
        timestamp: "2026-05-09T20:01:00.000Z",
        agents: ["codex", "claude"],
        instruction: "Done.",
        includeEditorContext: false,
        includeWorkspaceDiff: false,
        promptEnvelopeIds: [],
        status: "completed",
      }],
    });

    assert.deepEqual(items, []);
  });
});
