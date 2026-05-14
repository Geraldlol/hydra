# Native Data Recon

Captured from local Codex and Claude user data on 2026-05-10. This note records structure and parity implications only; credentials, access tokens, raw transcript bodies, and large log payloads were intentionally not copied.

## Safety Boundary

- Do not ingest `auth.json`, `.credentials.json`, raw session JSONL, shell snapshots, or large SQLite log bodies into Hydra diagnostics by default.
- Prefer counts, schema, filenames, timestamps, enabled names, and redacted key summaries.
- Treat CLI state directories as user-private. Hydra can inspect them only when the user asks for parity/debug information.

## Codex Data Shape

Root: `%USERPROFILE%\.codex`

Core files and folders observed:

- `config.toml`: primary user config. Contains default model/reasoning effort, Windows sandbox setting, enabled plugin list, trusted project roots, and marketplace sources.
- `.codex-global-state.json`: Electron/app UI state. Includes onboarding flags, app window bounds, saved workspace roots, prompt-history metadata, default service tier, and agent-mode preferences.
- `models_cache.json`: large model catalog. Includes model slugs, display names, descriptions, reasoning levels, service tiers, context-window limits, input modalities, tool support, instruction templates, verbosity support, and model-specific capabilities.
- `version.json`: latest available version and check timestamp.
- `rules/default.rules`: approval/prefix-rule state for command execution.
- `session_index.jsonl`: index over previous sessions.
- `sessions/YYYY/MM/DD/*.jsonl`: rollout/session event streams. First-line shape uses `type`, `timestamp`, and `payload`.
- `state_5.sqlite`: durable app/agent state.
- `logs_2.sqlite`: structured logs.
- `plugins/cache`: installed plugin cache from `openai-bundled`, `openai-curated`, and `openai-primary-runtime`.
- `skills`: system and user skills, including `SKILL.md`, assets, scripts, and agent manifests.
- `.sandbox*`, `sandbox.log`, `edge-playwright-profile`, `generated_images`, `tmp`: execution/runtime scratch areas.

`state_5.sqlite` tables observed:

- `threads`: 117 rows. Columns include id, rollout path, source, provider, cwd, title, sandbox policy, approval mode, git metadata, first user message, agent nickname/role, model, reasoning effort, and agent path.
- `thread_dynamic_tools`: 33 rows. Dynamic tool metadata per thread with name, description, input schema, namespace, and deferred-loading flag.
- `thread_goals`: goal/objective tracking.
- `thread_spawn_edges`: parent/child thread relationships.
- `agent_jobs` and `agent_job_items`: batch/agent job structures.
- `remote_control_enrollments`: remote-control websocket/account/server registration state.
- `stage1_outputs`, `jobs`, `backfill_state`, `_sqlx_migrations`.

`logs_2.sqlite` tables observed:

- `logs`: 36,469 rows. Columns include timestamp, level, target, module/file/line, thread id, process uuid, estimated bytes, and feedback log body.
- `_sqlx_migrations`, `sqlite_sequence`.

## Claude Data Shape

Root: `%USERPROFILE%\.claude`

Core files and folders observed:

- `settings.json`: user settings. Contains permission allow rules and enabled plugin map.
- `settings.local.json`: local settings. Contains additional permission allow rules and MCP server config.
- `.credentials.json`: credential material. Do not read into Hydra diagnostics.
- `history.jsonl`: command/session history. Do not ingest by default.
- `stats-cache.json`: usage aggregates by day/model/session. Useful only as redacted aggregate metadata.
- `policy-limits.json`: policy restriction flags.
- `remote-settings.json`: remote feature toggles.
- `mcp-needs-auth-cache.json`: MCP server auth-needed cache.
- `plugins`: installed plugins, marketplaces, blocklist, install counts, and cache/data.
- `skills`: user skills.
- `commands`: custom slash-command markdown.
- `projects`: project-scoped transcripts and subagent records.
- `sessions`: live/known session metadata.
- `session-env`, `shell-snapshots`, `paste-cache`, `file-history`, `tasks`, `todos`, `plans`, `telemetry`, `usage-data`: runtime/session support state.

Claude plugin state observed:

- `plugins/installed_plugins.json`: enabled installs with scope, install path, version, installed/updated timestamps, and commit SHA where available.
- `plugins/known_marketplaces.json`: marketplace names, source repo/path, install location, and last update time.
- `plugins/blocklist.json`: blocked plugin entries with reason/text.
- `plugins/marketplaces/claude-plugins-official`: official marketplace with plugin manifests.
- `plugins/marketplaces/superpowers-extended-cc-marketplace`: third-party marketplace with skills, agents, commands, hooks, docs, and cross-agent install metadata.

Claude project/session state observed:

- `projects/<encoded-path>/<session-id>.jsonl`: JSONL transcript/event streams. First-line keys include `type`, `sessionId`, and `leafUuid`.
- `projects/<encoded-path>/<session-id>/subagents/*.jsonl`: subagent event streams with `agentId`, `cwd`, `entrypoint`, `gitBranch`, `isSidechain`, `message`, `parentUuid`, `promptId`, `sessionId`, `timestamp`, `type`, `userType`, `uuid`, and `version`.
- `projects/<encoded-path>/<session-id>/subagents/*.meta.json`: subagent metadata with `agentType` and `description`.
- `sessions/*.json`: live session metadata with cwd, entrypoint, kind, peer protocol, pid, process start, session id, started/updated timestamps, status, and version.
- `todos/*.json`: per-agent todo arrays, often empty.

## Parity Implications For Hydra

- Add future diagnostics around config/state, but keep them redacted and opt-in. Useful fields: configured model, reasoning effort, sandbox/permission mode, enabled plugins, marketplace names, trusted project presence, session counts, and live-session metadata.
- Codex parity needs awareness of model catalog details: reasoning levels, context windows, service tiers, image support, web search support, and apply-patch/tool shapes. Hydra now surfaces compact catalog-derived capability summaries in the Native Data Snapshot and Support Bundle, while still passing model flags through unchanged.
- Claude parity needs awareness of settings/plugin/MCP state: enabled plugins, custom slash commands, skills, MCP servers, policy limits, live sessions, project sessions, and subagent metadata.
- Both CLIs maintain their own session history. Hydra avoids importing raw history, but links to native session ids, first-event key shapes, and redacted project/subagent counts when debugging.
- Codex has SQLite-backed thread/tool/job state. Claude has filesystem JSONL-backed project/subagent/session state. Hydra’s `.hydra` files are closer to Claude’s transparent state model than Codex’s app database model.
- A useful next parity feature would be adding a visible prompt-context budget/readout for native integration context so users can see when it is active before dispatch.
