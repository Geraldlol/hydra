import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  promptContextSha256,
  withPrivateFlightContextCommitment,
} from "../src/promptContextCommitment";

describe("prompt context commitment", () => {
  test("is deterministic and changes with component values or order", () => {
    const components = [
      ["sharedContext", "room context"],
      ["nativeCapabilities", "capabilities"],
      ["reviewDiff", undefined],
    ] as const;
    const first = promptContextSha256(components);
    assert.equal(first, promptContextSha256(components));
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.notEqual(first, promptContextSha256([
      ["sharedContext", "changed"],
      ["nativeCapabilities", "capabilities"],
      ["reviewDiff", undefined],
    ]));
    assert.notEqual(first, promptContextSha256([
      ["nativeCapabilities", "capabilities"],
      ["sharedContext", "room context"],
      ["reviewDiff", undefined],
    ]));
  });

  test("distinguishes absent, empty, labels, and component boundaries", () => {
    assert.notEqual(
      promptContextSha256([["value", undefined]]),
      promptContextSha256([["value", ""]]),
    );
    assert.notEqual(
      promptContextSha256([["left", "same"]]),
      promptContextSha256([["right", "same"]]),
    );
    assert.notEqual(
      promptContextSha256([["a", "bc"]]),
      promptContextSha256([["a", "b"], ["c", ""]]),
    );
  });

  test("keeps the private root out of JSON and object spread", () => {
    const envelope = withPrivateFlightContextCommitment(
      { id: "prompt-one", renderedPrompt: "body" },
      "a".repeat(64),
    );
    assert.equal(envelope.flightContextSha256, "a".repeat(64));
    assert.deepEqual(Object.keys(envelope), ["id", "renderedPrompt"]);
    assert.doesNotMatch(JSON.stringify(envelope), /flightContextSha256|a{64}/);
    assert.equal(
      (envelope as { flightContextSha256?: string }).flightContextSha256,
      "a".repeat(64),
    );
    assert.equal(
      (Object.assign({}, envelope) as { flightContextSha256?: string })
        .flightContextSha256,
      undefined,
    );
  });
});
