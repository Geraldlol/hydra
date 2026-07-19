# Hydra Handoff — design

**Date:** 2026-07-19
**Status:** Approved (brainstorm 2026-07-19)

## Purpose

A `/hydra-handoff` skill, installed globally for both Claude Code and Codex CLI, that packages the current CLI session's context into a handoff packet and delivers it to the Hydra room in the same workspace. Covers two scenarios: end-of-session handoff (room continues the work) and mid-task escalation (room discusses a decision or gnarly problem). The room **auto-ingests** the packet and presents a one-click confirm — it never runs anything without the user's confirmation.

Two deliverables:

1. **Extension feature** — a handoff inbox (`.hydra/handoff-inbox/`) that the room scans on open and watches while open.
2. **Skill** — canonical sources in this repo, with an installer that copies them to `~/.claude/skills/hydra-handoff/SKILL.md` and `~/.codex/prompts/hydra-handoff.md`.

## Packet format

Path: `<workspace>/.hydra/handoff-inbox/<utc-timestamp>-<slug>.json` (timestamp `YYYYMMDDTHHMMSSZ`, slug lowercase kebab from the title), written atomically (write `<name>.json.tmp`, then rename to `<name>.json`). Only `*.json` files are considered by the ingester; `.tmp` files are ignored.

```json
{
  "version": 1,
  "createdAt": "2026-07-19T18:30:00Z",
  "source": "claude-code",
  "title": "Finish JSONL compaction refactor",
  "prompt": "## Objective\n...markdown handoff body...",
  "suggestedAction": "askBoth",
  "context": { "branch": "agent/x", "filesTouched": ["src/foo.ts"] }
}
```

- `version` — literal `1`; unknown versions are rejected.
- `source` — `"claude-code" | "codex"` (display-only; other non-empty strings ≤ 40 chars are tolerated and shown as-is so future agents don't need a schema bump).
- `title` — non-empty, ≤ 200 chars.
- `prompt` — non-empty markdown; the packet **file** must be ≤ 256 KB.
- `suggestedAction` — enum: `"discuss" | "askBoth" | "buildCodex" | "buildClaude"`.
- `context` — optional; `branch` (string) and `filesTouched` (≤ 50 strings) only. Display-only — never fed to spawn args, env, or paths.

## Extension ingest

New module `src/handoffInbox.ts`: free functions behind a narrow deps object (telegramController pattern). Responsibilities:

- Ensure `handoff-inbox/` (plus `consumed/`, `rejected/`) exists under `.hydra/`.
- **Scan on room open** — packets written while VS Code was closed still land.
- **Watch while open** — `fs.watch` on the inbox directory (same `node:fs` `watch` pattern as the score/duel event watchers in `panel.ts`).
- Parse + validate with a type guard enforcing the caps above.

A valid packet produces a system message plus a confirm chip in the webview:

> Handoff from Claude Code: "Finish JSONL compaction refactor" — run as **Ask Both**?

- **Confirm** routes through the *existing* turn entry points — normal user turn (`discuss`), the ask-both path (`askBoth`), or the assign-builder path (`buildCodex`/`buildClaude`). No new spawn paths.
- **Override** — the user can change the action in the room before confirming (the chip offers the standard actions, defaulting to the suggested one).
- **Dismiss** archives without running.
- Consumed and dismissed packets move to `handoff-inbox/consumed/`; malformed or oversized packets move to `handoff-inbox/rejected/` with a system message naming the file.
- New webview messages are added to the `WebviewMessage` discriminated union in `src/webviewMessages.ts`.

### Security fence

`.hydra/` is workspace-writable, so packets are untrusted input (same trust class as agent stdout):

- **Nothing ever auto-runs.** Confirmation in the room is mandatory; the chip shows the title, and a Preview action opens the packet's prompt as a read-only markdown editor tab (`workspace.openTextDocument({ content, language: "markdown" })`) before confirming.
- Ingest only runs when the workspace is trusted (`vscode.workspace.isTrusted`).
- The packet carries prompt text and a closed action enum only — no exec, env, path, or settings data. No new configuration flows into spawn, so no new `scope: "application"` settings and no Doctor `TRUST_SCOPED_SETTINGS` changes.
- Caps (256 KB file, 200-char title, 50 `filesTouched`) bound memory and UI abuse; the rejected/ quarantine prevents re-fire loops.

## Skill

Canonical sources live in this repo at `skills/hydra-handoff/`:

- `SKILL.md` — Claude Code skill format.
- `codex-prompt.md` — Codex CLI custom-prompt format (installs as `~/.codex/prompts/hydra-handoff.md`).
- Installer: `pnpm run install:handoff-skill` (a small Node script in `scripts/`) copies both to their global homes, creating directories as needed.

Invocation: `/hydra-handoff [action] [notes]` (both args optional). Behavior:

1. **Gather context** from the live session: objective, what was done, verification state (tests run and their results), git branch + touched files, open questions, next steps. `notes` from the arg are folded in.
2. **Pick the suggested action** — from the `action` arg if given; otherwise infer from the session (open design question → `discuss`/`askBoth`; concrete implementation work remaining → a build assignment), defaulting to `discuss`.
3. **Compose the handoff markdown** using a fixed section template: `Objective`, `Current state`, `Done + verified`, `Open questions`, `Suggested next steps`, `Pointers` (files/branches).
4. **Write the packet** atomically to `<repo>/.hydra/handoff-inbox/`, creating `.hydra/` if missing.
5. **Report**: tell the user the handoff is queued and that opening the Hydra room in that workspace surfaces the confirm chip.

## Error handling

- **Skill:** missing `.hydra/` → create it. No identifiable workspace root → ask the user for the target. Write failure → report the error, don't retry silently.
- **Extension:** parse/size failures are non-fatal — quarantine to `rejected/`, post a system message, keep watching. Watcher and fs errors are swallowed only with a one-line `// why` comment per house style (e.g. ENOENT race on consumed move).

## Testing

- `test/handoffInbox.test.ts` — validation guard (accepts a good packet; rejects oversized file, bad `suggestedAction`, missing/empty `title`/`prompt`, wrong `version`), scan-on-open ingest, consumed/rejected moves, `.tmp` files ignored.
- Webview contract tests (`test/webviewContract.test.ts`) gain the new confirm-chip element ids.
- `test/panelSourceContract.test.ts` anchor: handoff confirm routes through the existing turn entry points (no new spawn call sites).

## Non-goals (v1)

- No URI-handler push (`vscode://…`) — possible later add-on.
- No auto-run mode.
- No cross-machine or cross-workspace delivery.
- No new spawn-relevant settings.
