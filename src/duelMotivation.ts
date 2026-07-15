export interface DuelMotivationRating {
  readonly agentId: string;
  readonly domain: string;
  readonly rating: number;
  readonly ratedMatches: number;
  readonly provisional: boolean;
}

const MAX_PROMPT_RATING_DOMAINS = 8;

/**
 * Compact competitive context for a specific head. This is deliberately a
 * motivation signal, never an orchestration input: callers append the text to
 * prompts but must not read it when selecting builders, approvals, or native
 * authority.
 */
export function renderDuelMotivationContext(
  agentId: string,
  ratings: readonly DuelMotivationRating[],
  displayName: (id: string) => string = (id) => id,
): string {
  const byDomain = new Map<string, DuelMotivationRating[]>();
  for (const rating of ratings) {
    if (!Number.isFinite(rating.rating)) continue;
    const rows = byDomain.get(rating.domain) ?? [];
    rows.push(rating);
    byDomain.set(rating.domain, rows);
  }

  const lines = [
    "=== FORMAL DUEL RATING ===",
    "Competitive status only. Ratings never change permissions, approvals, builder assignment, speaking order, or safety authority.",
  ];
  const allOwnDomains = [...byDomain]
    .map(([domain, rows]) => ({
      domain,
      rows: [...rows].sort((left, right) => right.rating - left.rating || left.agentId.localeCompare(right.agentId)),
    }))
    .filter(({ rows }) => rows.some((row) => row.agentId === agentId))
    .sort((left, right) => left.domain.localeCompare(right.domain));
  const ownDomains = allOwnDomains.slice(0, MAX_PROMPT_RATING_DOMAINS);

  if (ownDomains.length === 0) {
    lines.push(
      `${displayName(agentId)} is unranked. Establish rank by initiating or winning a policy-admitted formal duel with sealed commitments and independent human evidence judgment.`,
      "Work smarter by making falsifiable claims, testing assumptions, and producing evidence—not by talking louder or taking unsafe shortcuts.",
    );
    lines.push("The user's objective, truth, safety, and honesty outrank Elo.");
    return lines.join("\n");
  }

  for (const { domain, rows } of ownDomains) {
    const ownIndex = rows.findIndex((row) => row.agentId === agentId);
    const own = rows[ownIndex]!;
    const leader = rows[0]!;
    const jointLeaders = rows.filter((row) => row.rating === leader.rating);
    const rank = rows.findIndex((row) => row.rating === own.rating) + 1;
    if (rank === 1) {
      const crown = own.provisional
        ? `${jointLeaders.length > 1 ? "joint provisional #1" : "provisional #1"}; defend the lead and establish the Supreme Head crown through more independently judged matches`
        : `${jointLeaders.length > 1 ? "joint Supreme Head" : "Supreme Head"}; defend the rank under the same evidence rules`;
      lines.push(`${domain}: #1 ${Math.round(own.rating)} Elo — ${crown}.`);
    } else {
      lines.push(
        `${domain}: #${rank} ${Math.round(own.rating)} Elo — ${Math.max(0, Math.round(leader.rating - own.rating))} Elo behind #1 ${displayName(leader.agentId)}.`,
      );
    }
  }
  if (allOwnDomains.length > ownDomains.length) {
    lines.push(`${allOwnDomains.length - ownDomains.length} additional rated domain(s) omitted from prompt context; open Formal Duels for the full table.`);
  }
  lines.push(
    "Use the ranking pressure to work harder and smarter: verify more, expose assumptions, and make sharper falsifiable predictions.",
    "When a consequential disagreement is objectively decidable, initiate a formal challenge instead of waiting for the human to create one. Climb or defend rank through precise reasoning, falsifiable commitments, and independently judged wins. The user's objective, truth, safety, and honesty outrank Elo.",
  );
  return lines.join("\n");
}
