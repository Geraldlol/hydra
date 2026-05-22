import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { buildPrompt, APPROVED_SENTINEL_RE, SOFT_APPROVAL_RE } from "../src/prompts";

const TRANSCRIPT = "## 2026-05-08T14:00:00Z You\n\nWhat shall we build?\n";

describe("buildPrompt()", () => {
  test("opener includes preamble, transcript, and opener rules", () => {
    const out = buildPrompt({
      agent: "codex",
      otherAgent: "claude",
      phase: "opener",
      transcript: TRANSCRIPT,
    });
    assert.match(out, /You are Codex in Hydra Room/);
    assert.match(out, /and Claude\./);
    assert.match(out, /Phase: opener\./);
    assert.match(out, /--- Shared context ---/);
    assert.match(out, /active transcript for this turn/);
    assert.doesNotMatch(out, /Older transcript entries may be omitted/);
    assert.match(out, /latest user message is authoritative/);
    assert.match(out, /do not revive the older status as active work/);
    assert.doesNotMatch(out, /Treat it as established truth/);
    assert.match(out, /Source hygiene:/);
    assert.match(out, /treat `\.hydra\/` as Hydra workspace state/);
    assert.match(out, /Exclude `\.hydra\/`, `\.git\/`/);
    assert.match(out, /Prefer targeted `rg`\/glob searches/);
    assert.match(out, /What shall we build\?/);
    assert.match(out, /Operate as a live coworking terminal/);
    assert.match(out, /Discussion is allowed to execute work, not only plan it/);
    assert.match(out, /inspect, edit, or run commands now before replying/);
    assert.match(out, /cite the concrete command\/file action you performed/);
    assert.match(out, /Treat status and orientation prompts/);
    assert.match(out, /pick one concrete next executable action/);
    assert.match(out, /Do not stop at naming a DRI/);
    assert.match(out, /Do not recommend waiting for a user directive/);
    assert.match(out, /Do not claim consensus\./);
    assert.match(out, /Decision Packet/);
    assert.match(out, /Recommendation: <one concrete recommendation>/);
    assert.match(out, /Default next action:/);
    assert.match(out, /Decision needed from user:/);
    assert.match(out, /Blockers:/);
    assert.match(out, /summarize what you did and what remains\./);
  });

  test("adds wiki guidance only when compiled wiki context is present", () => {
    const out = buildPrompt({
      agent: "codex",
      otherAgent: "claude",
      phase: "opener",
      transcript: [
        "--- Hydra wiki context ---",
        "Persistent compiled room knowledge.",
        "",
        TRANSCRIPT,
      ].join("\n"),
    });

    assert.match(out, /Wiki context: the `--- Hydra wiki context ---` section is compiled memory/);
    assert.match(out, /Treat it as established truth unless/);
    assert.match(out, /do not re-derive facts it already gives/);
    assert.match(out, /name that gap explicitly so the wrapup loop can capture it/);
    assert.doesNotMatch(out, /reuse the matching source tag/);
  });

  test("asks agents to cite wiki facts only when wiki source tags are present", () => {
    const out = buildPrompt({
      agent: "claude",
      otherAgent: "codex",
      phase: "reactor",
      transcript: [
        "--- Hydra wiki context ---",
        "Persistent compiled room knowledge.",
        "",
        "- Stable fact. [src:deadbeefcafe]",
        "",
        TRANSCRIPT,
      ].join("\n"),
    });

    assert.match(out, /reuse the matching source tag in your reply/);
    assert.match(out, /measure real wiki usage separately from wiki-name chatter/);
  });

  test("does not treat transcript source tags as wiki source tags", () => {
    const out = buildPrompt({
      agent: "codex",
      otherAgent: "claude",
      phase: "opener",
      transcript: [
        "--- Hydra wiki context ---",
        "Persistent compiled room knowledge without citations.",
        "",
        "--- Full transcript ---",
        "## 2026-05-08T14:00:00Z You",
        "",
        "Mention [src:deadbeefcafe] outside the wiki.",
      ].join("\n"),
    });

    assert.doesNotMatch(out, /reuse the matching source tag/);
  });

  test("opener prompt is byte-identical for same inputs", () => {
    const a = buildPrompt({ agent: "codex", otherAgent: "claude", phase: "opener", transcript: TRANSCRIPT });
    const b = buildPrompt({ agent: "codex", otherAgent: "claude", phase: "opener", transcript: TRANSCRIPT });
    assert.equal(a, b);
  });

  test("includes native CLI capability hints when provided", () => {
    const out = buildPrompt({
      agent: "codex",
      otherAgent: "claude",
      phase: "build",
      transcript: TRANSCRIPT,
      nativeCapabilities: "- Codex CLI via hydraRoom.codexExecArgs* for this phase; Hydra passes raw native args through.\n- Use repo/shell/MCP/plugin/model/config/search/app/remote capabilities exposed by the configured native CLI invocation.",
    });
    assert.match(out, /--- Codex native CLI profile ---/);
    assert.match(out, /real native CLI with this phase's configured authority/);
    assert.match(out, /Codex CLI via hydraRoom\.codexExecArgs/);
    assert.match(out, /MCP\/plugin\/model\/config\/search\/app\/remote/);
    assert.match(out, /Use your native CLI tools and integrations/);
  });

  test("reactor reads from transcript and requires an explicit marker", () => {
    const out = buildPrompt({
      agent: "claude",
      otherAgent: "codex",
      phase: "reactor",
      transcript: `${TRANSCRIPT}\n## 2026-05-08T14:00:01Z Codex (opener)\n\nCodex thinks A.\n`,
    });
    assert.match(out, /You are Claude in Hydra Room/);
    assert.match(out, /Codex thinks A\./);
    assert.doesNotMatch(out, /--- Round 1 replies ---/);
    assert.match(out, /Respond to the opener's latest message/);
    assert.match(out, /Agree:/);
    assert.match(out, /Challenge:/);
    assert.match(out, /Amend:/);
    assert.match(out, /Ask user:/);
    assert.match(out, /Do not pad agreement or re-open settled scope/);
    assert.match(out, /If the opener acted, verify or review the result/);
    assert.match(out, /do useful work now instead of merely approving the plan/);
    assert.match(out, /answered a status\/orientation prompt by waiting/);
    assert.match(out, /If you challenge, give the replacement recommendation/);
    assert.match(out, /Decision Packet/);
    assert.match(out, /Recommendation: <one concrete recommendation>/);
    assert.match(out, /Default next action:/);
    assert.match(out, /Decision needed from user:/);
    assert.match(out, /Blockers:/);
  });

  test("closer responds to the reactor and closes the loop", () => {
    const out = buildPrompt({
      agent: "codex",
      otherAgent: "claude",
      phase: "closer",
      transcript:
        `${TRANSCRIPT}\n` +
        "## 2026-05-08T14:00:01Z Codex (opener)\n\nCodex recommends A.\n\n" +
        "## 2026-05-08T14:00:02Z Claude (reactor)\n\nAmend: choose B.\n",
    });
    assert.match(out, /You are Codex in Hydra Room/);
    assert.match(out, /Phase: closer\./);
    assert.match(out, /Amend: choose B\./);
    assert.match(out, /Respond to the reactor's latest message/);
    assert.match(out, /close the loop/);
    assert.match(out, /Do not restart the debate/);
    assert.match(out, /do it now/);
    assert.match(out, /state the final result and default next action/);
    assert.match(out, /must be executable by Hydra or an agent/);
    assert.match(out, /Decision Packet/);
  });

  test("parallel gives an independent same-time pass", () => {
    const out = buildPrompt({
      agent: "claude",
      otherAgent: "codex",
      phase: "parallel",
      transcript: `${TRANSCRIPT}\n## 2026-05-08T14:00:01Z You\n\nokay both of you do xyz\n`,
    });
    assert.match(out, /Phase: parallel\./);
    assert.match(out, /running Codex and Claude in parallel/);
    assert.match(out, /Give your independent pass/);
    assert.match(out, /do not wait for, answer, or claim agreement/);
    assert.match(out, /inspect, edit, or run commands now before replying/);
    assert.match(out, /avoid handing off work that you can do yourself/);
    assert.match(out, /cite the concrete command\/file action you performed/);
    assert.match(out, /Decision Packet/);
  });

  test("build includes build rules and forbids commit/push", () => {
    const out = buildPrompt({
      agent: "claude",
      otherAgent: "codex",
      phase: "build",
      transcript: TRANSCRIPT,
    });
    assert.match(out, /Phase: build\./);
    assert.match(out, /user assigned you as builder/);
    assert.match(out, /Implement by editing files directly\./);
    assert.match(out, /builder assignment supersedes it/);
    assert.match(out, /Respect existing user\/unrelated changes\./);
    assert.match(out, /Do not commit or push\./);
  });

  test("review includes diff block and APPROVED sentinel rule", () => {
    const out = buildPrompt({
      agent: "codex",
      otherAgent: "claude",
      phase: "review",
      transcript: TRANSCRIPT,
      verification: "Command: npm test\nExit code: 0",
      diff: "diff --git a/foo.ts b/foo.ts\n+new line",
    });
    assert.match(out, /Phase: review\./);
    assert.match(out, /--- Latest verification evidence ---/);
    assert.match(out, /Command: npm test/);
    assert.match(out, /--- Diff to review \(git diff HEAD\) ---/);
    assert.match(out, /\+new line/);
    assert.match(out, /APPROVED: no blockers/);
  });

  test("review throws if diff missing", () => {
    assert.throws(() =>
      buildPrompt({ agent: "codex", otherAgent: "claude", phase: "review", transcript: TRANSCRIPT }),
      /review requires diff/
    );
  });

  test("preamble names the speaking-to-both rule", () => {
    const out = buildPrompt({ agent: "codex", otherAgent: "claude", phase: "opener", transcript: "" });
    assert.match(out, /You are speaking to both the user and the other agent\./);
  });

  test("preamble tells agents exact-output user requests override normal packets", () => {
    const out = buildPrompt({
      agent: "claude",
      otherAgent: "codex",
      phase: "reactor",
      transcript:
        "## 2026-05-10T11:00:00Z You\n\nOld status: npm test timed out.\n\n" +
        "## 2026-05-10T11:05:00Z You\n\nClaude, reply with exactly CLAUDE_OK\n",
    });
    assert.match(out, /Treat newer verification evidence as replacing older timeout or failure claims\./);
    assert.match(out, /obey that exact-output request and omit the normal Decision Packet\./);
  });
});

describe("APPROVED_SENTINEL_RE (Review phase only)", () => {
  test("matches the exact sentinel on its own line", () => {
    assert.ok(APPROVED_SENTINEL_RE.test("APPROVED: no blockers"));
    assert.ok(APPROVED_SENTINEL_RE.test("preamble\nAPPROVED: no blockers\nepilogue"));
  });

  test("tolerates trailing whitespace and CR", () => {
    assert.ok(APPROVED_SENTINEL_RE.test("APPROVED: no blockers   "));
    assert.ok(APPROVED_SENTINEL_RE.test("APPROVED: no blockers\r"));
  });

  test("rejects case variants and decorations", () => {
    assert.ok(!APPROVED_SENTINEL_RE.test("approved: no blockers"));
    assert.ok(!APPROVED_SENTINEL_RE.test("**APPROVED: no blockers**"));
    assert.ok(!APPROVED_SENTINEL_RE.test("APPROVED: no blockers - ship it"));
  });
});

describe("SOFT_APPROVAL_RE (legacy consensus signal)", () => {
  test("matches typical consent phrasings", () => {
    assert.ok(SOFT_APPROVAL_RE.test("I'd approve this plan."));
    assert.ok(SOFT_APPROVAL_RE.test("I would approve."));
    assert.ok(SOFT_APPROVAL_RE.test("  i'd approve"));
  });

  test("matches when the line appears anywhere in a multiline reply", () => {
    assert.ok(SOFT_APPROVAL_RE.test("Some thoughts.\nI'd approve the direction.\nMore notes."));
  });

  test("rejects negation and mid-sentence approve", () => {
    assert.ok(!SOFT_APPROVAL_RE.test("I would never approve this."));
    assert.ok(!SOFT_APPROVAL_RE.test("In summary, I'd approve"));
  });
});
