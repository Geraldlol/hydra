import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import {
  appendHydraEvent,
  createHydraEvent,
  ensureHydraEventsFile,
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
    assert.equal(events[0].kind, "verificationFinished");
    assert.equal(events[0].data?.exitCode, 0);
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
    assert.equal(events[0].detail, "Recovered");
  });
});
