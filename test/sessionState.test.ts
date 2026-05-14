import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createTerminalSession,
  formatCommandForSession,
  terminalSessionPath,
  updateTerminalSession,
  writeTerminalSession,
} from "../src/sessionState";

describe("terminal session state", () => {
  test("creates an idle session snapshot", () => {
    const now = new Date("2026-05-09T10:00:00.000Z");
    const session = createTerminalSession("codex", now);
    assert.equal(session.agent, "codex");
    assert.equal(session.terminalName, "Hydra Codex");
    assert.equal(session.state, "idle");
    assert.equal(session.updatedAt, now.toISOString());
  });

  test("updates activity timestamps and clears old errors on dispatch", () => {
    const first = new Date("2026-05-09T10:00:00.000Z");
    const second = new Date("2026-05-09T10:01:00.000Z");
    const session = updateTerminalSession(
      { ...createTerminalSession("claude", first), lastError: "previous failure" },
      {
        state: "dispatching",
        detail: "Dispatching build",
        currentCommand: "claude -p",
        currentPhase: "build",
      },
      second
    );
    assert.equal(session.state, "dispatching");
    assert.equal(session.startedAt, second.toISOString());
    assert.equal(session.lastActivityAt, second.toISOString());
    assert.equal(session.lastError, undefined);
  });

  test("writes session snapshots under .hydra/sessions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-session-"));
    const session = updateTerminalSession(createTerminalSession("codex"), {
      state: "ready",
      detail: "Terminal ready",
    });
    await writeTerminalSession(dir, session);
    const raw = await fs.readFile(terminalSessionPath(dir, "codex"), "utf8");
    assert.equal(JSON.parse(raw).state, "ready");
  });

  test("formats commands for readable session cards", () => {
    assert.equal(
      formatCommandForSession("codex", ["exec", "--cd", "C:\\repo with spaces", "-"]),
      'codex exec --cd "C:\\repo with spaces" -'
    );
  });
});
