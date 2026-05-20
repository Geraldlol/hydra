export interface NativeReplyLeak {
  reason: string;
  marker: string;
}

const PROMPT_ENVELOPE_MARKERS = [
  "--- End Hydra prompt ---",
  "After your reply, exit so the wrapper can capture the transcript.",
  "Recommendation: <one concrete recommendation>",
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
