# Probe Scripts

Three probe scripts live under `scripts/`, each producing a structured
snapshot of one aspect of native CLI behavior. All three write artifacts
under `.hydra/<probe-name>/<timestamp>/` so multiple runs don't collide.

## `scripts/native-contract-probe.js`

Compares supported black-box CLI behavior of both `codex` and `claude` —
captures version, --help, and harmless agent invocations across each
agent's documented sandbox / permission modes. Records command, args, exit
code, duration, stdout/stderr, and a SHA-256 of the prompt so a direct
probe call can be diff'd against `.hydra/agent-calls.jsonl` records from a
real Hydra run.

```powershell
node scripts/native-contract-probe.js              # metadata only
node scripts/native-contract-probe.js --execute    # also call agents
node scripts/native-contract-probe.js --execute --prompt "..."
```

Artifacts under `.hydra/native-contract-probe/<timestamp>/`:

- `prompt.txt`, `report.json`, `report.md`
- `<probe-id>.stdout.txt`, `<probe-id>.stderr.txt` per agent probe

**Bug fix landed by RE work:** the danger-full-access branch originally
passed `--ask-for-approval never` to `codex exec`. That flag exists only
on the TUI root (`codex` interactive), not on `exec` — clap fails to
parse it. The fix uses `--dangerously-bypass-approvals-and-sandbox`
(alias `--yolo`) which is the exec-equivalent. See
`docs/native-internals/codex-wire-protocol.md`.

## `scripts/codex-json-probe.js`

Runs `codex exec --json --sandbox read-only` against a small read-only
prompt and pipes stdout through the typed parser in `src/codexEvents.ts`.
Verifies the parser handles real Codex output and gives a one-shot
diagnostic for confirming a Codex install is wired up correctly with the
same sandbox semantics Hydra uses.

```powershell
node scripts/codex-json-probe.js
node scripts/codex-json-probe.js --prompt "Explain this repo in one sentence."
node scripts/codex-json-probe.js --sandbox workspace-write
node scripts/codex-json-probe.js --timeout-ms 60000
```

Artifacts under `.hydra/codex-json-probe/<timestamp>/`:

- `prompt.txt`, `stdout.jsonl`, `stderr.txt`, `meta.json`
- `summary.json` — `CodexThreadSummary` (typed)
- `summary.txt` — `formatCodexThreadSummary` rendering

Requires `npm run compile` first so `dist/src/codexEvents.js` is on disk.
Windows: handles `.cmd` shims via PATHEXT + `shell: true` (Node 20.12+
refuses to spawn .bat/.cmd shims otherwise).

## `scripts/claude-stream-json-probe.js`

Symmetric companion to the Codex probe. Runs
`claude -p --permission-mode plan --output-format stream-json --verbose
--include-partial-messages` against a small read-only prompt and pipes
stdout through `src/claudeEvents.ts`.

```powershell
node scripts/claude-stream-json-probe.js
node scripts/claude-stream-json-probe.js --prompt "Reply with one word."
node scripts/claude-stream-json-probe.js --permission-mode acceptEdits
node scripts/claude-stream-json-probe.js --timeout-ms 60000
```

Artifacts under `.hydra/claude-stream-json-probe/<timestamp>/`:

- `prompt.txt`, `stdout.jsonl`, `stderr.txt`, `meta.json`
- `summary.json` — `ClaudeStreamSummary` (typed)
- `summary.txt` — `formatClaudeStreamSummary` rendering

The `system / init` envelope alone is a useful diagnostic: it dumps the
resolved tool list, MCP servers + status, plugins, skills, slash_commands,
permissionMode, output_style, and `fast_mode_state` without making a
model call beyond the trivial probe prompt.

## Regression fixtures

Each parser is pinned to a captured fixture so a future CLI release that
changes the wire format flips a test:

- `test/fixtures/codex-exec-json-real.jsonl` — captured by
  `codex-json-probe.js` against codex v0.130.0 on 2026-05-10. Covers
  `thread.started`, `turn.started`, two `command_execution` item
  lifecycles (item.started + item.completed coalesced by id), one
  `agent_message` item, and `turn.completed` with usage.
- `test/fixtures/claude-stream-json-real.jsonl` — captured by
  `claude-stream-json-probe.js` against Claude Code v2.1.138 on
  2026-05-10. Covers `hook_started` + `hook_response` (redacted),
  `system / init`, `system / status`, all six SSE inner content_block
  lifecycle events (`message_start`, `content_block_start`,
  `content_block_delta`, `content_block_stop`, `message_delta`,
  `message_stop`), `assistant`, `rate_limit_event`, and `result` with
  full `usage` including `cache_creation_input_tokens` and
  `cache_read_input_tokens`.

The hook payload fields are redacted in both fixtures — live
hook_response content tends to embed user-specific skill blobs.

## When to use which probe

| You want to … | Use |
| --- | --- |
| Confirm both CLIs install and run, with no model call | `native-contract-probe.js` (no `--execute`) |
| Compare a direct CLI call against what Hydra would send | `native-contract-probe.js --execute` |
| Verify Codex's JSON event stream is structurally what Hydra expects | `codex-json-probe.js` |
| Inspect Claude's full session state (tools, MCP, plugins, skills) without a model turn | `claude-stream-json-probe.js` (the `system / init` envelope) |
| Diagnose a parser regression after a CLI upgrade | run the JSON probe matching the upgraded CLI, then re-run `npm test` |
