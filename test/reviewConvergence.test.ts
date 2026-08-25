import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  evaluateReviewConvergence,
  REVIEW_CONVERGENCE_MODES,
  type ReviewVerdict,
} from "../src/reviewConvergence";

const verdict = (agent: string, approved: boolean): ReviewVerdict => ({ agent, approved });

describe("evaluateReviewConvergence", () => {
  test("lists the three supported policies", () => {
    assert.deepEqual([...REVIEW_CONVERGENCE_MODES], ["human", "unanimous", "majority"]);
  });

  test("unanimous requires every reviewer and surfaces every dissenter", () => {
    assert.equal(
      evaluateReviewConvergence([verdict("claude", true), verdict("gemini", true)], "unanimous").approved,
      true,
    );
    const split = evaluateReviewConvergence(
      [verdict("claude", false), verdict("gemini", true), verdict("local", false)],
      "unanimous",
    );
    assert.equal(split.approved, false);
    assert.equal(split.requiresHumanResolution, false);
    assert.deepEqual(split.dissenters, ["claude", "local"]);
  });

  test("majority requires strictly more than half and never approves a tie", () => {
    const majority = evaluateReviewConvergence(
      [verdict("a", true), verdict("b", true), verdict("c", false)],
      "majority",
    );
    assert.equal(majority.approved, true);
    assert.deepEqual(majority.dissenters, ["c"], "an approving majority must not erase dissent");
    const tie = evaluateReviewConvergence(
      [verdict("a", true), verdict("b", false)],
      "majority",
    );
    assert.equal(tie.approved, false);
    assert.equal(tie.requiresHumanResolution, false);
  });

  test("human mode requires an explicit decision whenever a multi-reviewer panel has dissent", () => {
    const unanimous = evaluateReviewConvergence(
      [verdict("a", true), verdict("b", true)],
      "human",
    );
    assert.equal(unanimous.approved, true);
    assert.equal(unanimous.requiresHumanResolution, false);

    const split = evaluateReviewConvergence(
      [verdict("a", true), verdict("b", false)],
      "human",
    );
    assert.equal(split.approved, false);
    assert.equal(split.requiresHumanResolution, true);
    assert.equal(split.decision, "human-resolution-required");

    const unanimousRejection = evaluateReviewConvergence(
      [verdict("a", false), verdict("b", false)],
      "human",
    );
    assert.equal(unanimousRejection.approved, false);
    assert.equal(unanimousRejection.requiresHumanResolution, true);
  });

  test("empty and ambiguous verdict sets fail closed", () => {
    for (const mode of REVIEW_CONVERGENCE_MODES) {
      const result = evaluateReviewConvergence([], mode);
      assert.equal(result.approved, false);
      assert.equal(result.requiresHumanResolution, false);
      assert.equal(result.total, 0);
    }
  });

  test("one reviewer reduces to that reviewer's verdict in every mode", () => {
    for (const mode of REVIEW_CONVERGENCE_MODES) {
      assert.equal(evaluateReviewConvergence([verdict("codex", true)], mode).approved, true);
      assert.equal(evaluateReviewConvergence([verdict("codex", false)], mode).approved, false);
    }
  });
});
