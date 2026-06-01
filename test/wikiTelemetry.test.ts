import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { summarizeHydraWikiUsage, summarizeHydraWikiUsageEvents } from "../src/wikiTelemetry";
import type { HydraEvent } from "../src/events";

describe("wiki telemetry", () => {
  test("counts distinct source citations and wiki references", () => {
    const text = "Using Hydra wiki context plus [src:deadbeefcafe] and [src:DEADBEEFCAFE]. See .hydra/wiki/context.md.";
    const telemetry = summarizeHydraWikiUsage(text);

    assert.equal(telemetry.replyChars, text.length);
    assert.equal(telemetry.sourceCitationCount, 2);
    assert.equal(telemetry.distinctSourceCitationCount, 1);
    assert.deepEqual(telemetry.sourceIds, ["deadbeefcafe"]);
    assert.equal(telemetry.mentionsWikiByName, true);
    assert.equal(telemetry.mentionsHydraWikiPath, true);
    assert.equal(telemetry.hasCitationSignal, true);
    assert.equal(telemetry.hasMentionSignal, true);
    assert.equal(telemetry.hasSignal, true);
  });

  test("reports no signal for ordinary replies", () => {
    const telemetry = summarizeHydraWikiUsage("No durable memory reference here.");

    assert.equal(telemetry.sourceCitationCount, 0);
    assert.equal(telemetry.distinctSourceCitationCount, 0);
    assert.deepEqual(telemetry.sourceIds, []);
    assert.equal(telemetry.mentionsWikiByName, false);
    assert.equal(telemetry.mentionsHydraWikiPath, false);
    assert.equal(telemetry.hasCitationSignal, false);
    assert.equal(telemetry.hasMentionSignal, false);
    assert.equal(telemetry.hasSignal, false);
  });

  test("rolls citation rate separately from wiki name and path mentions", () => {
    const events: HydraEvent[] = [
      telemetryEvent({ hasCitationSignal: true, hasMentionSignal: false, distinctSourceCitationCount: 1, replyChars: 100 }),
      telemetryEvent({ hasCitationSignal: false, hasMentionSignal: true, distinctSourceCitationCount: 0, replyChars: 300 }),
      { timestamp: "2026-05-21T00:00:03.000Z", kind: "diagnostic", detail: "Other diagnostic", data: { replyChars: 1000 } },
    ];

    const rollup = summarizeHydraWikiUsageEvents(events, { windowSize: 10, minSampleSize: 20 });

    assert.equal(rollup.sampleSize, 2);
    assert.equal(rollup.warmingUp, true);
    assert.equal(rollup.citationReplies, 1);
    assert.equal(rollup.mentionReplies, 1);
    assert.equal(rollup.citationRate, 0.5);
    assert.equal(rollup.mentionRate, 0.5);
    assert.equal(rollup.meanReplyCharsWithCitation, 100);
    assert.equal(rollup.meanReplyCharsWithoutCitation, 300);
  });

  test("window fills from wiki-usage events even when diluted by other event kinds", () => {
    // Simulate an event-heavy session: many unrelated events interleaved with
    // a steady trickle of wiki-usage telemetry. The rollup must count only the
    // wiki-usage events toward the window, otherwise it warms up forever.
    const events: HydraEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push({ timestamp: "2026-05-21T00:00:00.000Z", kind: "terminalSessionChanged", detail: "noise" });
      events.push(telemetryEvent({ hasCitationSignal: true, hasMentionSignal: false, distinctSourceCitationCount: 1, replyChars: 50 }));
      events.push({ timestamp: "2026-05-21T00:00:00.000Z", kind: "verificationFinished", detail: "more noise" });
    }

    const rollup = summarizeHydraWikiUsageEvents(events, { windowSize: 50, minSampleSize: 8 });

    assert.equal(rollup.sampleSize, 10);
    assert.equal(rollup.warmingUp, false);
    assert.equal(rollup.citationReplies, 10);
    assert.equal(rollup.citationRate, 1);
  });

  test("rollup can read older wiki telemetry event field names", () => {
    const rollup = summarizeHydraWikiUsageEvents([
      telemetryEvent({
        distinctSourceCitationCount: 0,
        mentionsHydraWikiContext: true,
        mentionsWikiContext: true,
        mentionsHydraWikiPath: false,
        replyChars: 200,
      }),
    ]);

    assert.equal(rollup.citationReplies, 0);
    assert.equal(rollup.mentionReplies, 1);
    assert.equal(rollup.mentionRate, 1);
  });
});

function telemetryEvent(data: HydraEvent["data"]): HydraEvent {
  return {
    timestamp: "2026-05-21T00:00:00.000Z",
    kind: "diagnostic",
    detail: "Hydra wiki usage telemetry: Codex opener reply mentioned wiki memory.",
    data,
  };
}
