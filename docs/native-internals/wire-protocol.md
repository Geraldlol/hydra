# Wire Protocol — Claude Code stream-json output

This documents the **outer envelope** Claude Code v2.1.138 emits when invoked
with `--print --output-format stream-json --verbose --include-partial-messages`.
Source: extracted Bun bundle (`chunk-0366`), specifically the `Fl_` async
generator in the `print` flow (search for `runHeadlessStreaming`). Each value
emitted by Claude's queue (`R.enqueue(...)`) is JSON-stringified one per line.

## Top-level envelope shapes

Each line on stdout is a JSON object with a `type` field. The type constellation
observed in the bundle:

| `type`                   | Subtype field                                            | Notes |
| ------------------------ | -------------------------------------------------------- | ----- |
| `system`                 | see "system subtypes" below                              | bookkeeping & lifecycle |
| `user`                   | —                                                        | mirrors a user-message turn (also used by `--replay-user-messages`) |
| `assistant`              | —                                                        | canonical assistant message turn (full Anthropic message body in `.message`) |
| `result`                 | `success`, `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries` | terminal envelope; also carries usage and `is_error` |
| `stream_event`           | wraps an Anthropic Messages SSE event                    | only emitted with `--include-partial-messages` |
| `keep_alive`             | —                                                        | heartbeat; ignore for parsing |
| `prompt_suggestion`      | —                                                        | post-turn suggested next prompt (gated by `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`) |
| `transcript_mirror`      | —                                                        | when `sessionMirror` is enabled, points at on-disk transcript files |
| `auth_status`            | —                                                        | emitted on auth state changes when `enableAuthStatus` is on |
| `rate_limit_event`       | —                                                        | from rate-limit subscription |
| `control_request`        | —                                                        | inbound (used by `--input-format=stream-json` mode) |
| `control_response`       | —                                                        | reply to a `control_request` |
| `control_cancel_request` | —                                                        | inbound cancellation |

Every envelope carries `uuid` (v4) and `session_id` fields except the SSE
`stream_event` and the heartbeats. The `result` line carries `total_cost_usd`,
`duration_ms`, `duration_api_ms`, `num_turns`, `usage`, `modelUsage`,
`permission_denials`, `errors`, `stop_reason`.

## `system` subtypes

Discovered subtypes (search keys: `subtype:"<name>"`):

- `status` — generic state ping; carries `status`, sometimes `permissionMode`, `compact_result`, `compact_error`
- `session_state_changed` — running/idle transitions
- `task_notification` — see "Task notifications" below; same XML shape as the harness Claude is run with
- `task_started`, `task_updated`, `task_progress`, `task_summary` — TaskCreate/TaskUpdate lifecycle mirrors
- `notification` — generic user-visible notice
- `post_turn_summary` — concise turn recap (gated)
- `compact_boundary` — emitted when context window compaction occurred mid-turn
- `api_retry` — retry happened; `error_status` carries the HTTP code
- `plugin_install` — plugin install lifecycle (`status`: `started`/`completed`, `name`, `error`)
- `elicitation_complete` — MCP elicitation flow finished; carries `mcp_server_name`, `elicitation_id`

When parsing a real run, treat any unknown subtype as opaque pass-through —
new ones are added without a versioned envelope bump.

## Inner SSE event grammar (the `stream_event` payload)

This is the standard Anthropic Messages API stream format. Decoder lives at
`MessageStream.consume`-ish handler `VV6` in the bundle. Outer event types:

- `message_start` — carries the bare `message` (id, role, model, usage)
- `message_delta` — patches `container`, `stop_reason`, `stop_sequence`, plus `usage` deltas (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `server_tool_use`, `iterations`)
- `message_stop` — finalize
- `content_block_start` — begin a new block (text / thinking / tool_use / compaction)
- `content_block_delta` — see delta types below
- `content_block_stop` — close the current block

`content_block_delta.delta.type` values handled by the bundle:

| Delta type         | What's inside                                                       |
| ------------------ | ------------------------------------------------------------------- |
| `text_delta`       | `text` chunk for a `text` block                                     |
| `citations_delta`  | `citation` payload appended to a `text` block's `citations[]`       |
| `input_json_delta` | `partial_json` chunk for a `tool_use` block's `input` field (streamed tool args) |
| `thinking_delta`   | `thinking` chunk for a `thinking` block                             |
| `signature_delta`  | `signature` for a `thinking` block (extended-thinking signature)    |
| `compaction_delta` | `compaction.content` snapshot — context-window compaction marker    |

## Task notification XML

The headless mode parses inbound task notifications using XML tags inside the
prompt body. Captured from the `task-notification` branch:

```
<task-id>...</task-id>
<tool-use-id>...</tool-use-id>
<output-file>...</output-file>
<status>completed|failed|stopped|killed</status>   <!-- killed -> stopped -->
<summary>...</summary>
<usage>
  <total_tokens>123</total_tokens>
  <tool_uses>4</tool_uses>
  <duration_ms>1234</duration_ms>
</usage>
```

Hydra emits these into the prompt stream when forwarding subagent task results.

## Permission modes

Six modes are valid (assertion in `onPermissionModeChanged`; also defined as
`Uk` / `PERMISSION_MODES` in the bundle around line 24870):

| Mode | Decision policy | Notes |
| --- | --- | --- |
| `default` | ask | Default. Pause for user approval on anything needing permission. |
| `acceptEdits` | ask, auto-allow file edits | Auto-allows Edit/Write within the workspace. |
| `auto` | classifier | Sends a permission classifier call to a smaller model; can fall back to ask. |
| `plan` | ask, no edits | Read-only planning mode; bypass-available state can short-circuit to allow. |
| `bypassPermissions` | always allow | Skip all permission checks (most permissive). |
| `dontAsk` | **always deny** | Strictest interactive mode: instead of pausing, auto-denies anything that would need permission. Pre-approved allow-rules still pass. Decision logic: `ny8` function, ~line 169407 (`dontAsk -> "deny"`). |

The `dontAsk` quirk matters: its color in the bundle's UI table is `"error"`
(same as `bypassPermissions`), but the *direction* is opposite — `bypassPermissions`
permits everything, `dontAsk` denies anything that escalates. Hydra classifies
`dontAsk` as `readOnly` (safe default) because the *effective* authority
depends entirely on the user's allow-rules. `dontAsk` is also the default
`permissionMode` for Claude's own cron jobs (`scheduled_tasks.json`,
bundle around line 333759) — unattended runs are deny-by-default.

Hydra currently passes `acceptEdits` and `bypassPermissions`. `dontAsk` and
`auto` are valid options it could expose for stricter / classifier-based
profiles.

## Common parser pitfalls

- `--output-format=stream-json` **requires** `--verbose` for `--print`. The CLI
  emits `Error: When using --print, --output-format=stream-json requires --verbose`
  to stderr and exits 1 if you forget.
- The first emitted event is **not** guaranteed to be `message_start`; system
  subtypes (`status`, `task_started`, plugin-install lifecycle) can fire first.
- `stream_event` envelopes are only present with `--include-partial-messages`.
  Without it, you get the materialized `assistant`/`user`/`result` turns only.
- `keep_alive` lines may appear at any time. Never assume two adjacent lines
  belong to the same logical event.
