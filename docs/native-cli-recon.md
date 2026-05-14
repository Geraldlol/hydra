# Native CLI Recon

Captured from the local workspace on 2026-05-10 to guide Hydra parity work.

See also `native-data-recon.md` for the user-data/config/cache structures behind these command surfaces.

## Installed Commands

- Codex resolves to the VS Code ChatGPT extension binary: `openai.chatgpt-*/bin/windows-x86_64/codex.exe`, version `0.130.0.0`.
- Claude resolves to the user-local native binary: `.local/bin/claude.exe`, version `2.1.138.0`.
- Codex ships adjacent helper binaries including `codex-command-runner.exe`, `codex-windows-sandbox-setup.exe`, and `rg.exe`.

## Codex Surface

Top-level Codex commands found via `codex --help`:

- Prompt/TUI entry with global flags for config, model, profile, sandbox, approval policy, search, image attachments, remote app-server connection, and cwd/additional dirs.
- Non-interactive agent commands: `exec`, `review`.
- Account and setup: `login`, `logout`, `update`, `completion`.
- Native extension points: `mcp`, `plugin`, `mcp-server`, `app-server`, `remote-control`, `app`, `exec-server`.
- Session/task flows: `resume`, `fork`, `cloud`, `apply`.
- Diagnostics and execution substrate: `features`, `sandbox`, `debug`.

Subcommand details that matter for Hydra:

- `exec` supports stdin prompts, `--json`, `--output-last-message`, `--output-schema`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--skip-git-repo-check`, model/profile/config, sandbox, approval policy, cwd, and image attachments.
- `review` supports `--uncommitted`, `--base`, `--commit`, and `--title`.
- `mcp` supports `list`, `get`, `add`, `remove`, `login`, and `logout`; `list`/`get` can emit JSON.
- `plugin` currently exposes marketplace management; marketplace supports `add`, `upgrade`, and `remove`.
- `cloud` exposes `exec`, `status`, `list`, `apply`, and `diff`.
- `app-server` supports stdio, Unix socket, websocket, auth-token, analytics, and schema/binding generation modes.
- `debug` exposes `models`, `app-server`, and `prompt-input`.
- `features` exposes `list`, `enable`, and `disable`.

## Claude Surface

Top-level Claude commands found via `claude --help`:

- Prompt/TUI entry with print mode, stream/json output, model/effort, IDE integration, Chrome integration, tools allow/deny, MCP config, plugin dirs/URLs, settings, agents, worktree, session resume/continue, remote control, and structured output schema.
- Account and install: `auth`, `setup-token`, `install`, `update|upgrade`.
- Native extension points: `mcp`, `plugin|plugins`, `agents`, `project`.
- Diagnostics and policy: `doctor`, `auto-mode`.
- Cloud review: `ultrareview`.

Subcommand details that matter for Hydra:

- `mcp` supports `add`, `add-json`, `add-from-claude-desktop`, `get`, `list`, `remove`, `reset-project-choices`, and `serve`.
- `plugin` supports `list`, `install`, `enable`, `disable`, `update`, `uninstall`, `marketplace`, `validate`, `tag`, and `prune`.
- `plugin marketplace` supports `add`, `list`, `remove`, and `update`.
- `auth` supports `login`, `logout`, and `status`.
- `auto-mode` supports `config`, `defaults`, and `critique`.
- `project purge` supports dry-run, interactive, yes, all-projects, and path-targeted modes.
- `ultrareview` supports formatted or raw JSON review output and a timeout.

## Hydra Parity Implications

- Keep raw native args as the source of truth. Both CLIs are growing surfaces faster than Hydra can model.
- Catalog presets should be convenience launchers, not validators.
- Commands that mutate account, plugin, project, update, worktree, app, cloud, or remote-control state belong in raw terminal mode unless the native CLI has a clearly non-interactive read-only form.
- Commands with stable read-only output belong in captured command mode, especially help, version, status, list, and JSON/defaults output.
- Hydra should continue to expose effective command/env/runtime diagnostics so the user can prove the extension host matches a normal terminal.
