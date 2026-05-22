import type { HydraEvent } from "./events";

export interface HydraWikiUsageTelemetry {
  replyChars: number;
  sourceCitationCount: number;
  distinctSourceCitationCount: number;
  sourceIds: string[];
  mentionsWikiByName: boolean;
  mentionsHydraWikiPath: boolean;
  hasCitationSignal: boolean;
  hasMentionSignal: boolean;
  hasSignal: boolean;
}

export interface HydraWikiUsageRollup {
  sampleSize: number;
  windowSize: number;
  minSampleSize: number;
  warmingUp: boolean;
  citationReplies: number;
  citationRate: number;
  mentionReplies: number;
  mentionRate: number;
  meanReplyCharsWithCitation?: number;
  meanReplyCharsWithoutCitation?: number;
}

const SOURCE_CITATION_RE = /\[src:([a-f0-9]{12})\]/gi;
const WIKI_USAGE_DETAIL_PREFIX = "Hydra wiki usage telemetry:";

export function summarizeHydraWikiUsage(text: string): HydraWikiUsageTelemetry {
  const sourceIds: string[] = [];
  for (const match of text.matchAll(SOURCE_CITATION_RE)) {
    sourceIds.push(match[1].toLowerCase());
  }
  const distinctSourceIds = [...new Set(sourceIds)];
  const mentionsWikiByName = /\bHydra wiki context\b/i.test(text);
  const mentionsHydraWikiPath = /\.hydra[\\/]wiki\b/i.test(text);
  const hasCitationSignal = distinctSourceIds.length > 0;
  const hasMentionSignal = mentionsWikiByName || mentionsHydraWikiPath;

  return {
    replyChars: text.length,
    sourceCitationCount: sourceIds.length,
    distinctSourceCitationCount: distinctSourceIds.length,
    sourceIds: distinctSourceIds,
    mentionsWikiByName,
    mentionsHydraWikiPath,
    hasCitationSignal,
    hasMentionSignal,
    hasSignal: hasCitationSignal || hasMentionSignal,
  };
}

export function summarizeHydraWikiUsageEvents(
  events: readonly HydraEvent[],
  options: { windowSize?: number; minSampleSize?: number } = {}
): HydraWikiUsageRollup {
  const windowSize = Math.max(1, Math.floor(options.windowSize ?? 50));
  const minSampleSize = Math.max(1, Math.floor(options.minSampleSize ?? 20));
  const usageEvents = events.filter(isWikiUsageTelemetryEvent).slice(-windowSize);

  let citationReplies = 0;
  let mentionReplies = 0;
  let replyCharsWithCitation = 0;
  let replyCharsWithoutCitation = 0;
  let repliesWithCitationChars = 0;
  let repliesWithoutCitationChars = 0;

  for (const event of usageEvents) {
    const data = event.data ?? {};
    const hasCitation = booleanField(data, "hasCitationSignal") ??
      (numberField(data, "distinctSourceCitationCount") ?? 0) > 0;
    const hasMention = booleanField(data, "hasMentionSignal") ??
      !!(
        booleanField(data, "mentionsWikiByName") ||
        booleanField(data, "mentionsHydraWikiPath") ||
        booleanField(data, "mentionsHydraWikiContext") ||
        booleanField(data, "mentionsWikiContext")
      );
    const replyChars = numberField(data, "replyChars");

    if (hasCitation) {
      citationReplies += 1;
      if (replyChars !== undefined) {
        replyCharsWithCitation += replyChars;
        repliesWithCitationChars += 1;
      }
    } else if (replyChars !== undefined) {
      replyCharsWithoutCitation += replyChars;
      repliesWithoutCitationChars += 1;
    }
    if (hasMention) mentionReplies += 1;
  }

  const sampleSize = usageEvents.length;
  return {
    sampleSize,
    windowSize,
    minSampleSize,
    warmingUp: sampleSize < minSampleSize,
    citationReplies,
    citationRate: rate(citationReplies, sampleSize),
    mentionReplies,
    mentionRate: rate(mentionReplies, sampleSize),
    meanReplyCharsWithCitation: mean(replyCharsWithCitation, repliesWithCitationChars),
    meanReplyCharsWithoutCitation: mean(replyCharsWithoutCitation, repliesWithoutCitationChars),
  };
}

function isWikiUsageTelemetryEvent(event: HydraEvent): boolean {
  return event.kind === "diagnostic" && event.detail.startsWith(WIKI_USAGE_DETAIL_PREFIX);
}

function booleanField(data: Record<string, string | number | boolean | null>, key: string): boolean | undefined {
  const value = data[key];
  return typeof value === "boolean" ? value : undefined;
}

function numberField(data: Record<string, string | number | boolean | null>, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rate(count: number, sampleSize: number): number {
  return sampleSize > 0 ? count / sampleSize : 0;
}

function mean(total: number, count: number): number | undefined {
  return count > 0 ? total / count : undefined;
}
