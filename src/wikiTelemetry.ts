export interface HydraWikiUsageTelemetry {
  replyChars: number;
  sourceCitationCount: number;
  distinctSourceCitationCount: number;
  sourceIds: string[];
  mentionsHydraWikiContext: boolean;
  mentionsWikiContext: boolean;
  mentionsHydraWikiPath: boolean;
  hasSignal: boolean;
}

const SOURCE_CITATION_RE = /\[src:([a-f0-9]{12})\]/gi;

export function summarizeHydraWikiUsage(text: string): HydraWikiUsageTelemetry {
  const sourceIds: string[] = [];
  for (const match of text.matchAll(SOURCE_CITATION_RE)) {
    sourceIds.push(match[1].toLowerCase());
  }
  const distinctSourceIds = [...new Set(sourceIds)];
  const mentionsHydraWikiContext = /\bHydra wiki context\b/i.test(text);
  const mentionsWikiContext = /\bwiki context\b/i.test(text);
  const mentionsHydraWikiPath = /\.hydra[\\/]wiki\b/i.test(text);

  return {
    replyChars: text.length,
    sourceCitationCount: sourceIds.length,
    distinctSourceCitationCount: distinctSourceIds.length,
    sourceIds: distinctSourceIds,
    mentionsHydraWikiContext,
    mentionsWikiContext,
    mentionsHydraWikiPath,
    hasSignal: sourceIds.length > 0 || mentionsHydraWikiContext || mentionsWikiContext || mentionsHydraWikiPath,
  };
}
