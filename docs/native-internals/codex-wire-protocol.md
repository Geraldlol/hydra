# Wire Protocol — Codex `exec --json`

Codex v0.130.0 is open-source (Apache-2.0) at github.com/openai/codex. The
authoritative event grammar lives in `codex-rs/exec/src/exec_events.rs` —
when in doubt, read it. This doc is the curated subset Hydra needs.

## Invocation shape

```
codex exec [OPTIONS] [PROMPT]
```

Critical flags for Hydra (full set in `docs/native-internals/codex-help-exec.txt`):

| Flag | Purpose |
| --- | --- |
| `--json` (alias: `--experimental-json`) | One JSONL event per line on stdout. **Required for stream parsing.** |
| `-s, --sandbox <MODE>` | `read-only` · `workspace-write` · `danger-full-access` |
| `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`) | Disable both approvals and sandbox; conflicts with `--ask-for-approval` |
| `-C, --cd <DIR>` | Working root |
| `--add-dir <DIR>` | Additional writable dir(s) |
| `-c, --config <key=value>` | TOML override of `$CODEX_HOME/config.toml` |
| `--enable <FEATURE>` / `--disable <FEATURE>` | Shorthand for `-c features.<name>=true|false` |
| `--ephemeral` | Don't persist session files |
| `--ignore-user-config` | Skip `$CODEX_HOME/config.toml` (auth still uses CODEX_HOME) |
| `--ignore-rules` | Skip user/project execpolicy `.rules` |
| `--skip-git-repo-check` | Allow running outside a Git repo |
| `--output-schema <FILE>` | JSON Schema for the model's final structured response |
| `-o, --output-last-message <FILE>` | Write the final message to a file |
| `-i, --image <FILE>` | Attach images to the initial prompt (repeatable) |

**Hydra-bug callout:** the existing `scripts/native-contract-probe.js` passes
`--ask-for-approval never` to `codex exec`. That flag does **not** exist on
the `exec` subcommand (it's only on the TUI root `codex` and tests like
`dangerous_bypass_conflicts_with_approval_policy` confirm it). The probe
branch will fail to parse. To get equivalent behavior on `exec`, use
`--dangerously-bypass-approvals-and-sandbox` (or just rely on
`--sandbox danger-full-access`, which is what Hydra actually wants).

## Top-level event envelope (`ThreadEvent`)

Every line on stdout is a JSON object with a `"type"` field:

| `type` | Payload | Notes |
| --- | --- | --- |
| `thread.started` | `{ thread_id }` | Always emitted first; `thread_id` is the resume key |
| `turn.started` | `{}` | A new prompt was sent to the model |
| `turn.completed` | `{ usage }` | Followed by an idle period or another `turn.started` |
| `turn.failed` | `{ error: { message } }` | Recoverable model/turn error |
| `item.started` | `{ item: ThreadItem }` | New item in `in_progress` state |
| `item.updated` | `{ item: ThreadItem }` | Mutation to an existing item |
| `item.completed` | `{ item: ThreadItem }` | Item reached terminal state (success or failure) |
| `error` | `{ message }` | Unrecoverable stream-level error |

Compare with Claude: Codex's vocabulary is **item-oriented** (one item per
distinct sub-action), Claude's is **content-block oriented** (deltas inside
an assistant message). Hydra's normalizer should map both into a unified
internal event stream.

## `Usage` object (turn.completed)

```json
{
  "input_tokens": 0,
  "cached_input_tokens": 0,
  "output_tokens": 0,
  "reasoning_output_tokens": 0
}
```

Differences from Claude's `usage`: Codex tracks `cached_input_tokens` and
`reasoning_output_tokens` explicitly (no `cache_creation_input_tokens` /
`cache_read_input_tokens` split, no `server_tool_use`).

## `ThreadItem` shapes (`ThreadItemDetails`)

`ThreadItem = { id, ...details }` where `details.type` is one of:

| `type` | Fields | Meaning |
| --- | --- | --- |
| `agent_message` | `text` | Assistant reply (or JSON string when `--output-schema` is used) |
| `reasoning` | `text` | Chain-of-thought summary |
| `command_execution` | `command`, `aggregated_output`, `exit_code`, `status` | Shell command spawned by the agent. `status`: `in_progress` → `completed`/`failed`/`declined` |
| `file_change` | `changes[]`, `status` | Patch application. Each change: `{ path, kind: add|delete|update }`. `status`: `in_progress` → `completed`/`failed` |
| `mcp_tool_call` | `server`, `tool`, `arguments`, `result?`, `error?`, `status` | MCP server tool invocation. `status`: `in_progress` → `completed`/`failed` |
| `collab_tool_call` | `tool`, `sender_thread_id`, `receiver_thread_ids[]`, `prompt?`, `agents_states`, `status` | Multi-agent collab call. `tool`: `spawn_agent`/`send_input`/`wait`/`close_agent` |
| `web_search` | `id`, `query`, `action` | Native Responses `web_search` tool (only when `--search` is on for TUI; not in exec by default) |
| `todo_list` | `items[]` (each `{ text, completed }`) | The agent's running plan |
| `error` | `message` | Non-fatal error surfaced as an item |

## CommandExecution lifecycle

A typical `exec_command` invocation produces three events:

1. `item.started` with `command_execution` and `status: "in_progress"`,
   `aggregated_output: ""`, `exit_code: null`.
2. Zero or more `item.updated` events as `aggregated_output` grows.
3. `item.completed` with `status: "completed"|"failed"|"declined"` and
   `exit_code` set.

A `declined` status means the user (or the policy) refused the proposed
command. Hydra should treat `declined` as "model attempted but denied" and
not as a failure of Codex itself.

## `--output-schema` mode

When `--output-schema <FILE>` is passed, the final `agent_message.text`
contains a JSON string conforming to that schema rather than free-form
prose. All the streaming events still flow normally; only the *terminal*
agent message changes shape.

## Resuming and forking

The `thread_id` from `thread.started` can be passed back via:

- `codex exec resume <thread-id>` — continues the thread
- `codex resume [--last|<id>]` — interactive picker
- `codex fork [--last|<id>]` — picker for forking

`codex exec` also supports `--ephemeral` to disable session persistence
entirely (no thread_id will be reusable; the started event still fires).
