import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { parseCodexDebugModels } from "../src/codexModels";

describe("parseCodexDebugModels", () => {
  test("extracts slug + display + reasoning + API support, drops base_instructions blob", () => {
    const json = JSON.stringify({
      models: [
        {
          slug: "gpt-5.5",
          display_name: "GPT-5.5",
          description: "Frontier model for complex coding.",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low", description: "fast" },
            { effort: "medium", description: "balanced" },
            { effort: "high", description: "deep" },
            { effort: "xhigh", description: "deepest" },
          ],
          supported_in_api: true,
          visibility: "list",
          base_instructions: "x".repeat(10_000),
          availability_nux: { message: "y".repeat(5_000) },
        },
        {
          slug: "gpt-5.3-codex-spark",
          display_name: "GPT-5.3-Codex-Spark",
          default_reasoning_level: "high",
          supported_reasoning_levels: [{ effort: "high" }],
          supported_in_api: false,
          visibility: "list",
        },
        {
          slug: "hidden-internal-model",
          display_name: "Hidden",
          supported_in_api: true,
          visibility: "hidden",
        },
      ],
    });
    const models = parseCodexDebugModels(json);
    assert.equal(models.length, 3);
    const flagship = models.find((m) => m.slug === "gpt-5.5");
    assert.ok(flagship);
    assert.equal(flagship!.displayName, "GPT-5.5");
    assert.equal(flagship!.defaultReasoning, "medium");
    assert.deepEqual(flagship!.reasoningLevels, ["low", "medium", "high", "xhigh"]);
    assert.equal(flagship!.supportedInApi, true);
    assert.equal(flagship!.visibility, "list");
    // Make sure we didn't carry the giant blobs into the parsed shape.
    assert.equal((flagship as unknown as { base_instructions?: unknown }).base_instructions, undefined);
    assert.equal((flagship as unknown as { availability_nux?: unknown }).availability_nux, undefined);

    const spark = models.find((m) => m.slug === "gpt-5.3-codex-spark");
    assert.ok(spark);
    assert.equal(spark!.supportedInApi, false);

    const hidden = models.find((m) => m.slug === "hidden-internal-model");
    assert.ok(hidden);
    assert.equal(hidden!.visibility, "hidden");
  });

  test("returns [] on malformed input rather than throwing", () => {
    assert.deepEqual(parseCodexDebugModels(""), []);
    assert.deepEqual(parseCodexDebugModels("not json"), []);
    assert.deepEqual(parseCodexDebugModels("{}"), []);
    assert.deepEqual(parseCodexDebugModels('{"models":"oops"}'), []);
    assert.deepEqual(parseCodexDebugModels('{"models":[{}]}'), []);
  });

  test("defaults supportedInApi to true and visibility to list when the CLI omits them", () => {
    const json = JSON.stringify({
      models: [{ slug: "gpt-test", display_name: "Test" }],
    });
    const [m] = parseCodexDebugModels(json);
    assert.ok(m);
    assert.equal(m.supportedInApi, true);
    assert.equal(m.visibility, "list");
    assert.deepEqual(m.reasoningLevels, []);
  });
});
