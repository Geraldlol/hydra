# Codex System Prompts and Config Surface

Where Codex v0.130.0 gets its system instructions, how to override them, and
what `~/.codex/config.toml` exposes that Hydra cares about.

## Active prompt sources

Three prompts are baked in. The other `gpt_5_*_prompt.md` and
`gpt-5.1-codex-max_prompt.md` files in `codex-rs/core/` are reference
snapshots / test fixtures — **they are not loaded by the runtime**.

| Constant | File | Loaded by | Purpose |
| --- | --- | --- | --- |
| `BASE_INSTRUCTIONS` | `codex-rs/models-manager/prompt.md` (275 lines) | `models-manager/src/model_info.rs:16` via `include_str!` | Canonical Codex CLI system prompt for every model |
| `REVIEW_PROMPT`     | `codex-rs/core/review_prompt.md` (87 lines) | `codex-rs/core/src/client_common.rs:19` | Special prompt for `codex review` and the review subcommand |
| Compact template    | `codex-rs/core/templates/compact/prompt.md` | Used during context compaction (mid-session squash) | Summarizes prior conversation when token budget is tight |

## `BASE_INSTRUCTIONS` outline

Sections (from `codex-rs/models-manager/prompt.md`):

1. **(opening)** — `You are a coding agent running in the Codex CLI…`
2. **Personality** — tone calibration; replaced when a model has a personality wrapper (see below)
3. **Responsiveness** — when to reply with what cadence
   - **Preamble messages** — short pre-action announcements
4. **Planning** — when to use `update_plan`, with examples
5. **Task execution** — high-level execution rules
6. **Validating your work** — testing and verification expectations
7. **Ambition vs. precision** — scope discipline
8. **Sharing progress updates** — interim updates during long work
9. **Presenting your work and final message** — formatting rules for the final reply
   - **Final answer structure and style guidelines** — bullet/header/inline-code conventions
10. **Shell commands** — preferred shell idioms (`rg` over `grep`, etc.)
11. **`update_plan`** — explicit usage of the planning tool

This gives Hydra a clean shape to reason about: when Hydra adds a prompt
section, it should slot it AFTER the BASE_INSTRUCTIONS so it doesn't break
the sectioning the model expects.

## Personality wrapping (gpt-5.2-codex / exp-codex-personality only)

`codex-rs/models-manager/src/model_info.rs:104` (`local_personality_messages_for_slug`):

```
{DEFAULT_PERSONALITY_HEADER}
{{ personality }}
{BASE_INSTRUCTIONS}
```

Where:
- `DEFAULT_PERSONALITY_HEADER` = "You are Codex, a coding agent based on
  GPT-5. You and the user share the same workspace and collaborate to
  achieve the user's goals."
- `{{ personality }}` is one of:
  - empty (default)
  - `personality_friendly` = "You optimize for team morale and being a
    supportive teammate as much as code quality."
  - `personality_pragmatic` = "You are a deeply pragmatic, effective
    software engineer."

Other models skip the wrapper entirely — they get just `BASE_INSTRUCTIONS`.
The personality choice is selected by `[personality]` in `config.toml` or
the `--personality` flag (if present in your version).

## How to override the system prompt

There are five ways to influence Codex's prompt without rebuilding:

1. **`-c instructions="…"`** (CLI) or `instructions = "…"` (`config.toml`) —
   appended to BASE_INSTRUCTIONS as additional user-supplied instructions.
2. **`-c developer_instructions="…"`** or `developer_instructions = "…"` —
   slot reserved for IDE/harness-supplied developer-role instructions.
3. **`model_instructions_file = "/path/to/file"`** in `config.toml` — point
   at a file whose contents replace `BASE_INSTRUCTIONS`. Most aggressive
   override; use when you need a fully custom prompt.
4. **`-c compact_prompt="…"`** — replaces the context-compaction template
   used when long sessions get squashed.
5. **`base_instructions` override** in `ModelsManagerConfig` (programmatic;
   not exposed at CLI). Hydra would only hit this via `-c
   models.<slug>.base_instructions=…` patterns.

Hydra should prefer **option 2** (`developer_instructions`) for harness-level
context injection — it's the slot Codex reserves for tools like Hydra.
`instructions` should mirror what a user would type at the prompt; replacing
`base_instructions` outright loses Codex's careful section ordering.

## Config surface relevant to Hydra

From `codex-rs/config/src/config_toml.rs`:

| TOML field | Purpose |
| --- | --- |
| `model` | Active model slug (overridable via `-m`) |
| `review_model` | Model to use for `codex review` |
| `model_provider` | Provider key from `[model_providers]` |
| `approval_policy` | Default `--ask-for-approval` (TUI only) |
| `sandbox_mode` | Default `--sandbox` |
| `sandbox_workspace_write` | Sub-table; `network_access` here is the network-toggle-in-workspace-write knob |
| `default_permissions` | String name of a permissions preset |
| `permissions` | `[permissions]` sub-table with allow/deny lists |
| `instructions` | Appended user-instruction text |
| `developer_instructions` | Reserved for harness/IDE injection — **the slot Hydra should use** |
| `include_permissions_instructions` / `include_apps_instructions` / `include_environment_context` | Booleans gating dynamic prompt sections |
| `model_instructions_file` | Replace BASE_INSTRUCTIONS |
| `compact_prompt` | Replace context-compaction template |
| `commit_attribution` | Attribution string for commits |
| `mcp_servers` | `[mcp_servers.<name>]` sub-tables; can also set `default_tools_approval_mode` |
| `model_providers` | `[model_providers.<name>]` for custom backends |
| `notify` | External notify command ($CODEX_HOME/notifications) |
| `hide_agent_reasoning` / `show_raw_agent_reasoning` | Reasoning-trace visibility |
| `model_reasoning_effort` / `model_reasoning_summary` / `model_verbosity` | Reasoning controls |
| `personality` | One of the personality variants above |
| `tui`, `audio`, `realtime` | TUI / realtime knobs (not relevant for `codex exec`) |
| `tools` | `[tools]` sub-table — toggle which built-in tools are exposed |
| `tool_suggest` | Tool suggestion behavior |
| `hooks` | `[hooks]` sub-table — pre/post tool-use hooks |
| `plugins` | `[plugins.<name>]` and `[marketplaces.<name>]` |
| `web_search` | Web-search mode |
| `agents` | `[agents]` sub-table for multi-agent config |
| `memories` | `[memories]` sub-table |
| `skills` | `[skills]` sub-table |
| `experimental_thread_store_endpoint`, `experimental_realtime_*` | Experimental knobs (don't depend on these from Hydra) |

## $CODEX_HOME

Defaults to `~/.codex/` on macOS/Linux, `%USERPROFILE%\.codex\` on Windows.
Honored even with `--ignore-user-config` (only `config.toml` is skipped, not
auth files).

Files Hydra may want to be aware of:

- `$CODEX_HOME/config.toml` — main config (skipped under `--ignore-user-config`)
- `$CODEX_HOME/auth.json` — OAuth/credential blob (always read; skip via env)
- `$CODEX_HOME/sessions/` — persisted thread state (skipped under `--ephemeral`)
- `$CODEX_HOME/log/` — log files (path overridable via `log_dir`)
- `$CODEX_HOME/scheduled_tasks.json` — recurring agent jobs (mirror of Claude's `.claude/scheduled_tasks.json`)

## Hydra-side implications

- **Use `-c developer_instructions=…`** to inject the room context into
  Codex's prompt. Stop synthesizing custom prompts via `--system-prompt`-style
  flags (Codex doesn't have one).
- **Mirror `--add-dir`** semantics: in `workspace-write` sandbox, only `cwd`
  + each `--add-dir` is writable.
- **Network access in sandbox** = `-c sandbox_workspace_write.network_access=true`.
  Surface this as a first-class capability in `capabilityProfiles.ts`.
- **Codex doesn't have permission modes** like Claude's `acceptEdits` /
  `bypassPermissions`. The closest equivalent is sandbox mode + approval
  policy. Hydra's normalizer should not assume the same enum on both sides.
- **Reasoning effort** maps differently. Claude has `--effort low|medium|high|xhigh|max`;
  Codex has `model_reasoning_effort` in TOML (no CLI flag). For symmetry
  Hydra would set it via `-c model_reasoning_effort=high`.
