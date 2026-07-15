import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { renderDuelMotivationContext } from "../src/duelMotivation";

const ratings = [
  { agentId: "codex", domain: "security", rating: 1036, ratedMatches: 5, provisional: false },
  { agentId: "claude", domain: "security", rating: 1012, ratedMatches: 4, provisional: true },
  { agentId: "gemini", domain: "security", rating: 988, ratedMatches: 3, provisional: true },
  { agentId: "claude", domain: "runtime", rating: 1024, ratedMatches: 2, provisional: true },
  { agentId: "codex", domain: "runtime", rating: 1024, ratedMatches: 2, provisional: true },
];

describe("duel motivation prompt context", () => {
  test("shows lower-ranked heads the exact evidence-based chase gap", () => {
    const text = renderDuelMotivationContext("gemini", ratings, title);
    assert.match(text, /security: #3 988 Elo — 48 Elo behind #1 Codex/);
    assert.match(text, /work harder and smarter/);
    assert.match(text, /Climb or defend rank through precise reasoning/);
    assert.match(text, /user's objective, truth, safety, and honesty outrank Elo/i);
  });

  test("tells leaders to defend a domain crown without granting authority", () => {
    const text = renderDuelMotivationContext("codex", ratings, title);
    assert.match(text, /security: #1 1036 Elo — Supreme Head; defend the rank/);
    assert.match(text, /runtime: #1 1024 Elo — joint provisional #1/);
    assert.match(text, /establish the Supreme Head crown/);
    assert.match(text, /never change permissions, approvals, builder assignment, speaking order, or safety authority/i);
  });

  test("keeps unranked heads focused on formal evidence rather than volume", () => {
    const text = renderDuelMotivationContext("new-head", ratings, title);
    assert.match(text, /New Head is unranked/);
    assert.match(text, /initiating or winning a policy-admitted formal duel with sealed commitments and independent human evidence judgment/);
    assert.match(text, /not by talking louder or taking unsafe shortcuts/);
    assert.match(text, /user's objective, truth, safety, and honesty outrank Elo/i);
  });

  test("bounds prompt growth when a head accumulates many rated domains", () => {
    const manyDomains = Array.from({ length: 12 }, (_, index) => ({
      agentId: "codex",
      domain: `domain-${String(index).padStart(2, "0")}`,
      rating: 1000 + index,
      ratedMatches: 1,
      provisional: true,
    }));
    const text = renderDuelMotivationContext("codex", manyDomains, title);
    assert.equal((text.match(/: #1 /g) ?? []).length, 8);
    assert.match(text, /4 additional rated domain\(s\) omitted from prompt context/);
  });
});

function title(id: string): string {
  return id.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
