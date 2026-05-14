# Codex Built-in Tools and Sandbox Modes

Catalog of the tools Codex v0.130.0 surfaces to the model, plus the sandbox
and approval modes that gate them. Source: `codex-rs/core/src/tools/handlers/`
and `codex-rs/utils/cli/`.

Tool names are protocol-level wire strings (snake_case), not Rust enum
variants. Hydra should match by string; Codex doesn't have a single canonical
enum the way an SDK might — `ToolName` is a wrapper around an arbitrary string
that allows MCP-namespaced names like `mcp__memory__create_entities`.

## Built-in tool inventory

### Shell / process

| Wire name        | Source                                                | Notes |
| ---------------- | ----------------------------------------------------- | ----- |
| `shell`          | `tools/handlers/shell.rs:136` (`ToolName::plain("shell")`) | Generic shell tool surfaced to most models |
| `local_shell`    | `tools/handlers/shell.rs:107` (`ToolName::plain("local_shell")`) | Variant for local execution path |
| `container.exec` | `tools/handlers/shell.rs:87` (`ToolName::plain("container.exec")`) | Sandbox container exec path |
| `exec_command`  | `tools/handlers/unified_exec.rs:91` | Unified-exec entrypoint (start a command) |
| `write_stdin`    | `tools/handlers/unified_exec.rs:141` | Send input to a running unified-exec session |

The three shell variants (`shell`, `local_shell`, `container.exec`) are not
all exposed at once — Codex picks the right one based on the model's tool
schema and the active sandbox. Hydra treats them as equivalent for logging.

### File mutation

| Wire name      | Source                          | Notes |
| -------------- | ------------------------------- | ----- |
| `apply_patch`  | `tools/handlers/apply_patch.rs:11` (uses lark grammar `apply_patch.lark`) | Single canonical file-edit tool. Streams progress via `file_change` items. |

### Planning

| Wire name      | Source                       |
| -------------- | ---------------------------- |
| `update_plan`  | `tools/handlers/plan.rs:34`  |

Surfaces the agent's evolving todo list. Emits `todo_list` items in the
event stream.

### Multi-agent / collab

| Wire name                     | Source                                         | Notes |
| ----------------------------- | ---------------------------------------------- | ----- |
| `spawn_agent`                 | `tools/handlers/multi_agents.rs:50`            | Start a sub-agent thread |
| `send_input`                  | `tools/handlers/multi_agents.rs:124`           | Forward input to a running sub-agent |
| `send_message`                | `tools/handlers/multi_agents.rs:151`           | Send a chat message to a sub-agent |
| `followup_task`               | `tools/handlers/multi_agents.rs:182`           | Queue a followup for a sub-agent |
| `resume_agent`                | `tools/handlers/multi_agents.rs:199`           | Resume a previously paused sub-agent |
| `wait_agent`                  | `tools/handlers/multi_agents.rs:212`           | Block until a sub-agent reaches a state |
| `list_agents`                 | `tools/handlers/multi_agents.rs:244`           | List all known sub-agent threads |
| `close_agent`                 | `tools/handlers/multi_agents.rs:262`           | Terminate a sub-agent |
| `spawn_agents_on_csv`         | `tools/handlers/agent_jobs.rs:56`              | Batch fan-out from a CSV input |
| `report_agent_job_result`     | `tools/handlers/agent_jobs.rs:90`              | Sub-agent reports back to the parent |

These produce `collab_tool_call` items in the event stream.

### MCP

| Wire name                        | Source                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| `list_mcp_resources`             | `tools/handlers/mcp_resource.rs:25`                        |
| `list_mcp_resource_templates`    | `tools/handlers/mcp_resource.rs:53`                        |
| `read_mcp_resource`              | `tools/handlers/mcp_resource.rs:81`                        |
| `mcp__<server>__<tool>`          | `tools/handlers/mcp.rs` (namespaced; one per server tool)  |

MCP-server tool calls produce `mcp_tool_call` items.

### User interaction

| Wire name                  | Source                                          | Notes |
| -------------------------- | ----------------------------------------------- | ----- |
| `request_user_input`       | `tools/handlers/request_user_input.rs:25`       | Ask the user a question; response feeds back into the thread |
| `request_permissions`      | `tools/handlers/request_permissions.rs`         | Escalate beyond current sandbox (under `untrusted` / `on-request` approval modes) |
| `request_plugin_install`   | `tools/handlers/request_plugin_install.rs:187`  | Suggest installing a Codex plugin |

### Misc

| Wire name      | Source                                  | Notes |
| -------------- | --------------------------------------- | ----- |
| `view_image`   | `tools/handlers/view_image.rs`          | Read an image into the conversation |
| `tool_search`  | `tools/handlers/tool_search.rs`         | Discover deferred tools (parallel to Claude's `ToolSearch`) |
| `goal`         | `tools/handlers/goal.rs`                | Goal-tracking primitive (used internally) |

## Sandbox modes

Defined in `codex-rs/utils/cli/src/sandbox_mode_cli_arg.rs`:

| `--sandbox` value      | Behavior |
| ---------------------- | -------- |
| `read-only`            | Default. Only `disk-full-read-access`; no writes anywhere |
| `workspace-write`      | Read everything; write only to cwd + each `--add-dir`. Network blocked unless `-c sandbox_workspace_write.network_access=true` |
| `danger-full-access`   | No sandbox at all. Combined with approvals, still prompts; combined with `--yolo`, both are off |

The sandbox is enforced platform-specifically:
- **macOS:** Apple Seatbelt (`sandbox_exec`); base policy at `codex-rs/sandboxing/src/seatbelt_base_policy.sbpl`
- **Linux:** landlock + seccomp (`codex-rs/sandboxing/src/landlock.rs`)
- **Windows:** there is *no real sandbox* — Codex falls back to an approval-only model. The `codex-windows-sandbox-setup.exe` and `codex-command-runner.exe` binaries handle the IPC required for the approval flow on Windows.

`-c sandbox_workspace_write.network_access=true` opens network access in
workspace-write mode (verified in test fixtures). Hydra should expose this
as a separate boolean rather than burying it in raw `-c` overrides.

## Approval modes

Defined in `codex-rs/utils/cli/src/approval_mode_cli_arg.rs`. **Only valid on
the interactive root `codex` (TUI) command, not on `codex exec`.** On exec,
sandbox + `--yolo` covers the same surface.

| `--ask-for-approval` value | Maps to              | Behavior |
| -------------------------- | -------------------- | -------- |
| `untrusted`                | `UnlessTrusted`      | Default. Run "trusted" set without ask; escalate everything else |
| `on-failure`               | `OnFailure` *(deprecated)* | Run all; ask only when a sandboxed command fails |
| `on-request`               | `OnRequest`          | Model decides when to ask |
| `never`                    | `Never`              | Never ask. Failures are returned to the model |

The "trusted" set under `untrusted` mode is a curated list (e.g., `ls`, `cat`,
`sed`, `grep`, `git status`, …). Defined in `codex-rs/core/src/exec_policy.rs`
and the `.rules` files under `codex-rs/execpolicy/`.

The `--full-auto` flag is **removed** as of v0.130.0 (a hidden compat trap
remains; it conflicts with `--dangerously-bypass-approvals-and-sandbox` and
emits a warning). Don't pass it.

## What `default_tools_approval_mode` controls

In `~/.codex/config.toml`, an MCP server entry can set
`default_tools_approval_mode` to override the global approval policy for
that server's tools (see `codex-rs/cli/src/mcp_cmd.rs:308`). This is *per
server*, not per tool. Hydra's MCP config writer should plumb this through.

## Tool annotations (`is_mutating`)

`ToolHandler` exposes a single safety hint: `is_mutating(invocation) -> bool`.
It defaults to `false` and tool authors are expected to override it
defensively (return `true` if there's *any* doubt). This is far simpler than
Claude's `isReadOnly` / `isDestructive` / `isOpenWorld` matrix, but Hydra
should still surface it in receipts so the user sees which tool calls
mutated the workspace.

## Pre/post hook payloads

Codex supports user-defined pre/post tool-use hooks via
`pre_tool_use_payload` and `post_tool_use_payload` on the handler trait.
Hooks are configured in `~/.codex/config.toml` under `[hooks]` and can be
keyed by `flat_tool_name` (which collapses MCP namespacing into
`mcp__server__tool`). Hydra users who want to instrument Codex should write
hook scripts there rather than wrapping the binary.
