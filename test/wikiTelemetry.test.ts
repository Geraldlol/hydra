import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { summarizeHydraWikiUsage } from "../src/wikiTelemetry";

describe("wiki telemetry", () => {
  test("counts distinct source citations and wiki references", () => {
    const text = "Using Hydra wiki context plus [src:deadbeefcafe] and [src:DEADBEEFCAFE]. See .hydra/wiki/context.md.";
    const telemetry = summarizeHydraWikiUsage(text);

    assert.equal(telemetry.replyChars, text.length);
    assert.equal(telemetry.sourceCitationCount, 2);
    assert.equal(telemetry.distinctSourceCitationCount, 1);
    assert.deepEqual(telemetry.sourceIds, ["deadbeefcafe"]);
    assert.equal(telemetry.mentionsHydraWikiContext, true);
    assert.equal(telemetry.mentionsWikiContext, true);
    assert.equal(telemetry.mentionsHydraWikiPath, true);
    assert.equal(telemetry.hasSignal, true);
  });

  test("reports no signal for ordinary replies", () => {
    const telemetry = summarizeHydraWikiUsage("No durable memory reference here.");

    assert.equal(telemetry.sourceCitationCount, 0);
    assert.equal(telemetry.distinctSourceCitationCount, 0);
    assert.deepEqual(telemetry.sourceIds, []);
    assert.equal(telemetry.mentionsHydraWikiContext, false);
    assert.equal(telemetry.mentionsWikiContext, false);
    assert.equal(telemetry.mentionsHydraWikiPath, false);
    assert.equal(telemetry.hasSignal, false);
  });
});
