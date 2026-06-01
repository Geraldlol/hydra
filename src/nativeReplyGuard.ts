export interface NativeReplyLeak {
  reason: string;
  marker: string;
}

// Why: these are the distinctive TAIL fragments of the prompts Hydra actually builds
// (prompts.ts DECISION_PACKET ends every opener/reactor/closer/parallel turn; BUILD_RULES
// ends every build turn). A native CLI that echoes the prompt template instead of
// answering finishes its output on one of these literal placeholder lines; a genuine
// reply fills the `<…>` placeholders in, so they never appear verbatim at the tail of
// real output. test/nativeReplyGuard.test.ts asserts each marker is a real substring of a
// built prompt, so this set cannot silently drift dead when a prompt template is reworded.
export const PROMPT_ENVELOPE_MARKERS = [
  "Recommendation: <one concrete recommendation>",
  "Default next action: <what Hydra should do next if the user does not redirect>",
  "Decision needed from user: <one narrow decision",
  "Blockers: <real blockers, or",
  "End with a one-paragraph summary of what you changed.",
];

// Why: leaked prompt-envelope text only ever lands at the *tail* of a native CLI
// reply (the model finishes the prompt template instead of answering). A body-wide
// includes() check false-positives any legitimate reply that quotes a marker:
// code reviews, security audits, and meta-conversations about Hydra's own
// transcript format would all be flipped to exitCode 1 and treated as failed.
const TAIL_WINDOW_CHARS = 500;

export function detectNativeReplyLeak(text: string): NativeReplyLeak | undefined {
  const normalized = text.replace(/\r\n/g, "\n");
  const tail = normalized.slice(-TAIL_WINDOW_CHARS);
  for (const marker of PROMPT_ENVELOPE_MARKERS) {
    if (tail.includes(marker)) {
      return {
        reason: "Native CLI returned Hydra prompt-envelope text instead of an assistant reply.",
        marker,
      };
    }
  }
  return undefined;
}

export function formatNativeReplyLeakError(leak: NativeReplyLeak): string {
  return `${leak.reason} Marker: ${leak.marker}`;
}
