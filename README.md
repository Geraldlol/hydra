# Hydra

Hydra is a VS Code room where you, Codex, and Claude work in one shared thread.

The normal path is simple:

1. Open the Command Palette.
2. Run `Hydra: Start`.
3. Hydra Autopilot checks the workspace, native CLIs, and terminal bridge.
4. Type in the room.

Do not type `Hydra` into PowerShell. Hydra is a VS Code command, not a terminal command.

## Requirements

Hydra expects these CLIs on your `PATH` or in a known Windows install location:

- `codex`
- `claude`

If VS Code cannot find a CLI, set `hydraRoom.codexCommand` or `hydraRoom.claudeCommand` to the full executable path.

## Local Development

```powershell
cd C:\Users\geral\Hydra
npm install
npm run compile
npm run dev
```

`npm run dev` resolves the VS Code CLI (via `PATH`, `VSCODE_CLI`, or known Windows install locations), opens a new Extension Development Host window with the repo root already loaded as the workspace, and sets `HYDRA_WORKSPACE_ROOT` for the session.

If `npm run dev` cannot find your VS Code CLI, set `VSCODE_CLI` to the absolute path of `code.cmd` (Windows) or `code` (macOS/Linux), or fall back to the manual form:

```powershell
code --extensionDevelopmentPath . ..\..
```

In the Extension Development Host, run `Hydra: Start`.

## Daily Commands

- `Hydra: Start`
- `Hydra: Send Message`
- `Hydra: Assign Builder`
- `Hydra: Run Verification`
- `Hydra: Request Review`
- `Hydra: Preview Next Prompt`
- `Hydra: Command Center`
- `Hydra: Native Action`
- `Hydra: Poke Codex Terminal`
- `Hydra: Poke Codex With Editor Context`
- `Hydra: Poke Codex With Working Tree`
- `Hydra: Poke Claude Terminal`
- `Hydra: Poke Claude With Editor Context`
- `Hydra: Poke Claude With Working Tree`
- `Hydra: Poke Both Native Terminals`
- `Hydra: Poke Both With Editor Context`
- `Hydra: Poke Both With Working Tree`
- `Hydra: Accept Default Decision`
- `Hydra: Stop Current Turn`
- `Hydra: Run Doctor`
- `Hydra: Show Effective Native Authority`
- `Hydra: Autopilot Start`
- `Hydra: Open Transcript`
- `Hydra: Open Decisions`
- `Hydra: Open Room Objective`
- `Hydra: Open Session Brief`
- `Hydra: Open Support Bundle`
- `Hydra: Capture Native Capabilities`
- `Hydra: Capture Native Data Snapshot`
- `Hydra: Open Native Action Log`

## Advanced Commands

Most users do not need these.

- `Hydra: Advanced: Use Experimental Terminal Bridge`
- `Hydra: Advanced: Run Terminal Bridge Self-Test`
- `Hydra: Advanced: Show Terminal Bridge Health`
- `Hydra: Advanced: Use Safe One-Shot Transport`
- `Hydra: Advanced: Open Native Terminals`
- `Hydra: Advanced: Reset Stuck Turn`
- `Hydra: Setup: Fix Codex CLI Path`
- `Hydra: Setup: Fix Claude CLI Path`

Hydra starts in safe one-shot transport, then Autopilot runs Doctor and the terminal bridge self-test. If both native CLIs are available and the bridge test passes, Hydra switches to the visible terminal bridge automatically. If anything fails, it stays in safe one-shot mode and shows fix buttons in the room.

The native terminal bridge is experimental and routes calls through visible terminals using `.hydra/prompts/*.md`, `.hydra/logs/*.log`, and `.hydra/replies/*.json`. Agent output is echoed in the native terminal and streamed into the room while the command runs. Hydra also writes `.hydra/sessions/codex.session.json` and `.hydra/sessions/claude.session.json` so the panel and Doctor-style health output can show each terminal's current command, state, last activity, and latest log path. The room shows the active transport in the header, has an Open Terminals button for bringing both native CLIs into view, and can switch back with `Hydra: Advanced: Use Safe One-Shot Transport` if terminal mode gets noisy.

Use `Hydra: Native Action` or the in-room Native Action button as the polished entry point for direct terminal work. It opens a picker for Codex, Claude, or both, with optional editor or working-tree context.

Choose `Codex Command` or `Claude Command` in that picker, from the command palette, or from the Direct Terminals tool group when you need exact native subcommand parity instead of a prompt-shaped agent turn. The input is parsed as args after the configured executable, so examples include `doctor`, `mcp list`, `plugin list`, `features`, or any other native CLI subcommand you want Hydra to run and capture.

The same picker also includes a native command catalog based on the current Codex and Claude CLI surfaces: MCP/plugin help and list/status commands, feature/debug/sandbox/app-server inspection, Claude agents/project/auto-mode/ultrareview/auth/install help, and interactive terminal entries for auth/login/logout, resume/continue/fork, worktree, remote-control, app/cloud, install/setup-token, and update flows. The reconnaissance notes live in `docs/native-cli-recon.md`.

Choose `Codex Raw Terminal Line` or `Claude Raw Terminal Line` when the native CLI flow is interactive or terminal-native, such as auth, plugin setup, remote-control sessions, or a TUI. Hydra sends the line into the visible terminal and records the action, but it does not wait for or parse a room reply.

Use `Hydra: Command Center` or the in-room Command Center button when you are not sure which Hydra control to use next. It opens a context-aware picker that prioritizes recovery, default decisions, review, verification, native actions, terminal transport, and diagnostics based on the current room state.

Hydra also adds a VS Code Status Bar item. Click it to open Command Center from anywhere; it shows setup attention, active runs, verification, and Work Queue counts without reopening the room first.

Every direct native action writes a structured receipt to `.hydra/native-actions.jsonl`, including the target heads, attached context summary, prompt envelope ids, redacted native session hints, and final status. The room shows the latest native actions with agent/status filters plus Rerun, Fork, Objective, Discuss, and Clear controls. Rerun sends the same instruction to the same heads with the same attachment options, Fork copies the old instruction into the composer, Objective pins it as room context, Discuss sends it into the normal Hydra room loop, and Clear removes resolved or junk receipts from the visible list and receipt log. Use `Hydra: Open Native Action Log` or the in-room Open Actions button when you need the raw log.

Native session hints are correlation metadata only: recent Codex session ids from `session_index.jsonl` and matching Claude live-session ids from `.claude/sessions`, with status/entrypoint/basename labels where available. Hydra does not import native transcript bodies.

Use the in-room `Poke Codex` and `Poke Claude` buttons, or `Hydra: Poke Codex Terminal` / `Hydra: Poke Claude Terminal`, when you want to talk to one native CLI directly without starting the full opener -> reactor -> closer room loop. Pokes still stream terminal output into the room and are written to the transcript.

Normal room messages still use the opener -> reactor -> closer discussion loop. If the latest message explicitly addresses both agents, such as "both of you", "you both", or "Codex and Claude, ...", Hydra instead runs Codex and Claude in parallel with independent discussion prompts and returns control after both replies finish.

Use `Codex + Editor` / `Claude + Editor`, or the matching command-palette actions, when the active editor matters. Hydra attaches the active selection first; if nothing is selected, it attaches the active file up to `hydraRoom.editorContextMaxChars`. Direct terminal pokes use the fresh terminal-poke context window, so they do not resend stale week-old transcript unless you explicitly attach it in the prompt.

Use `Codex + Diff` / `Claude + Diff`, or the matching command-palette actions, when the working tree matters. Hydra attaches `git diff HEAD` plus untracked files, capped by `hydraRoom.diffMaxLines`, to one direct native-terminal request.

Visible terminal prompts do not inject repository instructions by default, so each native CLI can rely on its own local context loading. Set `hydraRoom.terminalBridgeWorkspaceInstructionsMaxChars` above 0 to opt in to capped Hydra-injected repository instructions; terminal prompts filter out the recipient CLI's own native instruction files first. One-shot prompts keep `hydraRoom.oneShotWorkspaceInstructionsMaxChars` at 12000 and include the full Hydra instruction set.

Use `Poke Both`, `Both + Editor`, or `Both + Diff` when you want Codex and Claude to answer in parallel through their native terminals without the room protocol. Hydra opens both terminals, creates one user transcript entry, and streams both replies into separate agent bubbles.

## Autopilot

Autopilot is the first-run path:

- checks that a workspace is open and `.hydra/` is writable
- resolves `codex` and `claude` from the VS Code extension host environment
- warns when command or raw-args settings are overridden by workspace settings
- runs the terminal bridge self-test
- opens native terminals only after the bridge is usable
- picks terminal bridge or safe one-shot automatically

Turn it off with `hydraRoom.autopilotOnStart: false`. Keep one-shot as the automatic default with `hydraRoom.preferTerminalBridgeOnStart: false`.

## Transcript

Hydra keeps the full room log at `.hydra/transcript.md`. Agent prompts use a bounded context window so long sessions do not resend the full transcript every turn.

Hydra also writes:

- `.hydra/objective.md` for the pinned room objective.
- `.hydra/decisions.jsonl` for structured decision packets.
- `.hydra/verification.jsonl` for build/test/check evidence.
- `.hydra/native-actions.jsonl` for direct native terminal action receipts.
- `.hydra/native-capabilities.md` for the latest Codex/Claude version and help snapshot.
- `.hydra/native-data-snapshot.md` for redacted Codex/Claude config, plugin, model, state, and session metadata.
- `.hydra/work-queue.jsonl` for queue dismiss/snooze state.
- `.hydra/session-brief.md` for the latest operator snapshot.
- `.hydra/support-bundle.md` for the latest diagnostics snapshot.
- `.hydra/prompts/index.jsonl` for prompt envelopes showing the exact command, transport, context, and rendered prompt sent to native CLIs.
- `.hydra/prompts/`, `.hydra/replies/`, and `.hydra/logs/` when the experimental terminal bridge is enabled.

Use `Hydra: Preview Next Prompt` or the in-room Preview Prompt button to inspect the next prompt envelope before sending. Preview is read-only: it does not append to the transcript, decision log, or prompt index. Prompt previews and the room header classify each native CLI call as `read-only`, `workspace-write`, `full-native`, or `unknown/custom` based on the effective Codex/Claude args. `unknown/custom` is a visibility label, not a spawn blocker, so newly added native Codex or Claude flags can still pass through before Hydra learns how to classify them.

Raw Codex/Claude args can reference per-request Hydra files with `${hydraPromptFile}`, `${hydraReplyFile}`, and `${hydraLogFile}`. Hydra expands those placeholders after it creates the current request artifacts, which lets native CLI flags consume the rendered prompt file or write to the same reply/log paths without hard-coding `.hydra` filenames.

If the native CLIs need the same PATH or environment you use in a normal shell, set `hydraRoom.nativePathPrepend` and `hydraRoom.nativeEnv`. Both apply to one-shot and terminal-bridge dispatches, and both support `${workspaceFolder}` plus `${env:NAME}` placeholders. Use `hydraRoom.codexNativePathPrepend` / `hydraRoom.codexNativeEnv` and `hydraRoom.claudeNativePathPrepend` / `hydraRoom.claudeNativeEnv` when the two CLIs need different tool roots or environment variables.

Use `Hydra: Capture Native Capabilities` or the Diagnostics `Native Snapshot` button to refresh `.hydra/native-capabilities.md`. Hydra runs version/help plus read-only MCP, plugin, feature, and auth/status probes through the same configured command, PATH, and environment overlays it uses for native dispatch, then summarizes obvious JSON counts/names at the top so CLI updates and integration parity drift are visible without digging through terminal scrollback.

When present and task-relevant, that latest integration probe summary is also included in generated agent prompt envelopes alongside the normal native CLI profile hint. Hydra only injects it for prompt contexts that mention MCP, plugins, auth/login, feature flags, marketplaces, integrations, or connected tools, so ordinary coding turns stay lean.

Use `Hydra: Capture Native Data Snapshot` or the Diagnostics `Native Data` button to refresh `.hydra/native-data-snapshot.md`. The snapshot summarizes Codex and Claude config, enabled plugins, model catalog, model capability flags, MCP names, state-table counts, live sessions, Claude project/subagent metadata, and local skill/command names while omitting credential files, raw transcript bodies, shell snapshots, and large log payloads.

## Decision Packets

Agent replies are expected to end with:

- `Recommendation:`
- `Default next action:`
- `Decision needed from user:`
- `Blockers:`

Hydra stores those packets in `.hydra/decisions.jsonl`, shows the latest decisions in the room, and exposes `Accept Default`. When the default clearly names a builder, Hydra assigns that builder. When a build is done, it requests review. When review blockers need a return pass, it hands back to the builder. Otherwise it sends the default back into the room as the next instruction.

## Work Queue

Hydra computes a live Work Queue from existing durable state: actionable decision defaults, failing verification, and failed or cancelled native actions. Queue items appear in the room with one-click actions such as Accept, Discuss, or Rerun. Use Dismiss to hide an item until its underlying source changes, or Snooze to hide it for one hour. The queue items themselves are the current attention view over `.hydra/decisions.jsonl`, `.hydra/verification.jsonl`, and `.hydra/native-actions.jsonl`; only dismiss/snooze state is stored separately in `.hydra/work-queue.jsonl`.

## Session Brief

Use `Hydra: Open Session Brief` or the in-room Session Brief button to refresh and open `.hydra/session-brief.md`. The brief is a compact human-facing snapshot of the current objective, phase, transport, Work Queue, latest decision, latest verification, recent native actions, and recent room messages. It is not automatically injected into agent prompts; it exists so you can quickly recover the room state after reloads or handoffs without rereading the full transcript.

## Support Bundle

Use `Hydra: Open Support Bundle` or the in-room Support Bundle button to refresh and open `.hydra/support-bundle.md`. The bundle is a diagnostics snapshot for debugging Hydra itself: Doctor checks, effective native authority, native runtime command/argv/env-key diagnostics, compact native data and model-capability summary, terminal session state, Work Queue, latest decision, verification, recent native actions, and recent messages. It avoids rerunning the terminal bridge self-test unless Doctor has already captured one, so opening it is cheap and non-disruptive.

## Telegram Notifications

Hydra can notify Telegram when an agent decision packet has a non-empty `Decision needed from user` field. Set `hydraRoom.telegramBotToken` and `hydraRoom.telegramChatId` in User Settings, or set `TELEGRAM_BOT_TOKEN` in the extension host environment and keep the token setting blank. Leave `hydraRoom.telegramNotifyOnDecisionNeeded` enabled to send decision-needed alerts.

Run `Hydra: Send Test Telegram Message` from the Command Palette or Hydra Command Center after configuring the bot. A successful test writes a confirmation system message into the room; failures point back to the Telegram settings.

Hydra can also poll Telegram for inbound commands. Enable `hydraRoom.telegramInboundPollingEnabled` in User Settings, then send messages in the configured chat that start with `hydraRoom.telegramInboundCommandPrefix` (default: `/hydra`). For example, `/hydra accept the default and continue` is appended to the room as user input. The first poll skips older Bot API updates and stores the next update offset in `.hydra/telegram-inbound.json` so old messages are not replayed after restart. Inbound polling is disabled by default because Telegram messages are remote untrusted input; only set an empty prefix for a private bot chat you fully trust.

## Verification

Use `Hydra: Run Verification` or the in-room button after a build. Hydra runs `hydraRoom.verifyCommand` from the workspace root. If that setting is blank, Hydra infers a command from `package.json` scripts in this order:

1. `npm run check && npm test`
2. `npm test`
3. `npm run check`
4. `npm run lint`

The latest verification result is shown in the room, persisted to `.hydra/verification.jsonl`, and included in the next Review prompt.

Hydra also runs verification automatically after a successful Build phase by default (`hydraRoom.autoVerifyAfterBuild`). If you want the room to move straight from a passing automatic verification into Review, enable `hydraRoom.autoRequestReviewAfterPassingVerification`.

## Security

Hydra spawns Codex and Claude with workspace-write authority and network access out of the box:

- Codex discussion/build args grant `--sandbox workspace-write` plus `sandbox_workspace_write.network_access=true`. Codex can edit files in the workspace and call out over the network during agent turns.
- Claude discussion/build/review args use `--permission-mode acceptEdits`. Claude applies file edits without per-tool confirmation.

These defaults are productive for self-trusted projects, but they mean a prompt-injected agent — for example via a hostile `CLAUDE.md`, `AGENTS.md`, `.codex/instructions.md`, or `.github/copilot-instructions.md` that Hydra reads into the prompt — can edit local files and exfiltrate over the network. When you open a workspace you don't fully trust:

1. Decline VS Code's Workspace Trust prompt. Hydra declares `capabilities.untrustedWorkspaces` as `limited`, so the sensitive settings (CLI command paths, exec args, verify command, handoff webhook, Telegram credentials, transcript path, native env/PATH) are silently ignored from workspace `.vscode/settings.json`. A hostile repo cannot redirect the agent spawn or exfiltration sinks.
2. Switch to a tighter capability profile before sending a turn. Run `Hydra: Change Capability Profile` (Command Palette or the in-room button) and pick `Safe Discussion` (Codex: `--sandbox read-only`, Claude: `--permission-mode default`). Or set `hydraRoom.codexDiscussionProfile` / `hydraRoom.claudeDiscussionProfile` to `safeDiscussion` in User Settings to make safe discussion the default.

Use `Hydra: Show Effective Native Authority` and `Hydra: Preview Next Prompt` to inspect what authority the next call will run with and what content it will receive. `Full Native` profiles (`--dangerously-bypass-approvals-and-sandbox`, `--dangerously-skip-permissions`, etc.) trigger a one-shot or persistent consent modal before dispatch; `unknown/custom` arg combinations are not gated, so the prompt preview is your inspection point for those.

## Packaging

```powershell
cd C:\Users\geral\Hydra
npm install
npm run check
npm test
npm run package
```

The package command builds a local `.vsix`. A Marketplace release still needs a real publisher id, icon, and release notes.

To install this working copy into VS Code from the repo root:

```powershell
npm run install:local
```

That command runs the package flow, resolves `code.cmd`/`code` from `PATH`, `VSCODE_CLI`, or known VS Code install locations, then installs the newest local `.vsix` with `--force`. If a `.vsix` already exists and you only want to reinstall it, run `npm run install:local:existing`.

If PowerShell blocks `npm.ps1` because script execution is disabled, use the command shim directly:

```powershell
npm.cmd run install:local
```

Or bypass npm entirely:

```powershell
node scripts/install-local.js
```

For an isolated smoke test, set `HYDRA_VSCODE_USER_DATA_DIR` and `HYDRA_VSCODE_EXTENSIONS_DIR` to temporary directories before running the script. Leave them unset for the normal install into your VS Code profile.

## Native CLI Internals

Hydra mirrors the actual native invocation surfaces, wire protocols, tool
catalogs, system-prompt assembly, and `config.toml` knobs of both Claude Code
and Codex. The reverse-engineered specs live in `docs/native-internals/`:

- `wire-protocol.md` — Claude `stream-json` envelope (outer types, system
  subtypes, SSE delta types, task-notification XML, six permission modes)
- `system-prompts.md` — the three baked Claude root prompts, dynamic-section
  flag, simple-prompt feature gate, `--bare` semantics
- `claude-tools.md` — every Claude built-in tool with bundle constants and
  the `isReadOnly`/`isDestructive`/`isOpenWorld` annotation schema
- `codex-wire-protocol.md` — Codex `exec --json` `ThreadEvent` and
  `ThreadItem` grammar
- `codex-tools.md` — Codex tools (apply_patch, shell variants, multi-agent
  collab, MCP), sandbox modes, approval modes
- `codex-system-prompts.md` — Codex `BASE_INSTRUCTIONS`, personality wrappers,
  override paths, full `~/.codex/config.toml` surface
- `claude-help.txt` / `codex-help.txt` (+ per-subcommand) — captured `--help`
  output for Claude v2.1.138.0 and Codex v0.130.0

`validateNativeArgs` in `src/authority.ts` cites these specs to flag
known-bad arg combinations (e.g. `--ask-for-approval` on `codex exec`,
`stream-json` without `--verbose`). Doctor surfaces those warnings via the
`Native CLI args` check.
