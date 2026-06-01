import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import {
  appendHydraEvent,
  createHydraEvent,
  ensureHydraEventsFile,
  HYDRA_EVENT_KINDS,
  hydraEventsPath,
  readHydraEvents,
} from "../src/events";

describe("hydra events", () => {
  test("resolves the workspace event log path", () => {
    assert.equal(hydraEventsPath("/repo"), path.join("/repo", ".hydra", "events.jsonl"));
  });

  test("appends and reads bounded local events", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-events-"));
    const file = hydraEventsPath(dir);
    await ensureHydraEventsFile(file);
    await appendHydraEvent(file, createHydraEvent({
      kind: "terminalSessionChanged",
      agent: "codex",
      phase: "opener",
      detail: "opener dispatched",
      data: { state: "dispatching", hasError: false },
    }, new Date("2026-05-13T12:00:00.000Z")));
    await appendHydraEvent(file, createHydraEvent({
      kind: "verificationFinished",
      detail: "Verification passed",
      data: { exitCode: 0 },
    }, new Date("2026-05-13T12:01:00.000Z")));

    const events = await readHydraEvents(file, 1);
    assert.equal(events.length, 1);
    const event0 = events[0];
    assert.ok(event0);
    assert.equal(event0.kind, "verificationFinished");
    assert.equal(event0.data?.exitCode, 0);
  });

  test("skips malformed JSONL lines", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-events-bad-"));
    const file = hydraEventsPath(dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, [
      "{bad",
      JSON.stringify(createHydraEvent({ kind: "error", detail: "Recovered" })),
      "",
    ].join("\n"), "utf8");

    const events = await readHydraEvents(file);
    assert.equal(events.length, 1);
    const event0 = events[0];
    assert.ok(event0);
    assert.equal(event0.detail, "Recovered");
  });

  test("includes phaseTransition in the canonical event-kind set", () => {
    assert.ok(HYDRA_EVENT_KINDS.includes("phaseTransition"));
  });

  test("drops rows whose kind is not a known HydraEventKind", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-events-kind-"));
    const file = hydraEventsPath(dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, [
      // A hand-edited / attacker-supplied line with an unknown kind must not
      // widen the union and must be skipped on read.
      JSON.stringify({ timestamp: "2026-05-13T12:00:00.000Z", kind: "totally-made-up", detail: "evil" }),
      JSON.stringify(createHydraEvent({ kind: "phaseTransition", detail: "opener -> reactor" }, new Date("2026-05-13T12:01:00.000Z"))),
    ].join("\n"), "utf8");

    const events = await readHydraEvents(file);
    assert.equal(events.length, 1);
    const event0 = events[0];
    assert.ok(event0);
    assert.equal(event0.kind, "phaseTransition");
    assert.equal(event0.detail, "opener -> reactor");
  });
});
