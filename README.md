# Hydra

Hydra puts Codex and Claude Code in one room inside VS Code and has them work the same task together while you stay in control. You send one message, the two agents discuss a plan, one of them builds, the other reviews the diff, and you approve the steps that matter. It drives the Codex and Claude Code CLIs you already have installed, using your existing logins, and writes the whole session (transcript, plan, and every decision) to a `.hydra/` folder in your workspace.

<!-- Screenshots or a demo GIF go here. Capture the shots below, save them under media/screenshots/ as PNG or JPG (the Marketplace does not render SVG), then remove the comment markers around this block to publish. Small PNGs are bundled in the extension, so they show on the in-editor extension page as well as the web listing. A demo GIF can join or replace these later, saved as media/hydra-demo.gif (already kept out of the .vsix download).

![A room turn: Codex and Claude discussing the plan](media/screenshots/room-discussion.png)

![Review pass: one agent flags an issue in the other agent's diff](media/screenshots/review.png)

![Per phase model picker and the live session cost meter](media/screenshots/model-and-cost.png)
-->

**Auto mode.** Every agent turn ends with a short decision packet: what it did, what it recommends next, any blockers, and a safe default action. Hydra can take that default and move the loop forward on its own, from discussion to build to verify to review and back again, running your test or build command after each build. It stops and asks you the moment a step looks risky, such as a push, a delete, or a deploy. That way it handles the routine middle of a task and only interrupts you for the decisions that actually need a person.

## Quick start

1. Open the Command Palette.
2. Run `Hydra: Start`.
3. Hydra checks the workspace, the native CLIs, and the terminal bridge.
4. Type in the room.

Do not type `Hydra` into PowerShell. Hydra is a VS Code command, not a terminal command.

## Requirements

Hydra expects these CLIs on your `PATH` or in a known Windows install location:

- `codex`
- `claude`

If VS Code cannot find a CLI, set `hydraRoom.codexCommand` or `hydraRoom.claudeCommand` to the full executable path.

## Local Development

```powershell
cd C:\path\to\hydra
corepack enable
pnpm install
pnpm run compile
pnpm run dev
```

The repo pins pnpm via `packageManager`; Corepack resolves that exact version.

`pnpm run dev` resolves the VS Code CLI (via `PATH`, `VSCODE_CLI`, or known Windows install locations), opens a new Extension Development Host window with the repo root already loaded as the workspace, and sets `HYDRA_WORKSPACE_ROOT` for the session.

If `pnpm run dev` cannot find your VS Code CLI, set `VSCODE_CLI` to the absolute path of `code.cmd` (Windows) or `code` (macOS/Linux), or fall back to the manual form:

```powershell
code --extensionDevelopmentPath . .
```

In the Extension Development Host, run `Hydra: Start`.

## Daily Commands

- `Hydra: Start`
- `Hydra: Send Message`
- `Hydra: Assign Builder`
- `Hydra: Assign Both Builders`
- `Hydra: Run Verification`
- `Hydra: Request Review`
- `Hydra: Preview Next Prompt`
- `Hydra: Open Last Prompt`
- `Hydra: Insert Prompt Template` (`Ctrl+Alt+T`)
- `Hydra: Choose Model` (`Ctrl+Alt+M`)
- `Hydra: Choose Thinking Level` (`Ctrl+Alt+E`)
- `Hydra: Change Capability Profile`
- `Hydra: Refresh Codex Models`
- `Hydra: Attach Files`
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
- `Hydra: Open Standings`
- `Hydra: Review Score Evidence`
- `Hydra: Record Evidence Verdict`
- `Hydra: Reverse Evidence Verdict`
- `Hydra: Adjudicate Pending Score Claim`
- `Hydra: Open Formal Duels`
- `Hydra: Advance Formal Duel`
- `Hydra: Cancel Formal Duel`
- `Hydra: Open Duel Audit`
- `Hydra: Correct Duel Result`
- `Hydra: Open Room Objective`
- `Hydra: Open Session Brief`
- `Hydra: Open Wiki Context`
- `Hydra: Run Wiki Wrapup Now`
- `Hydra: Open Support Bundle`
- `Hydra: Capture Native Capabilities`
- `Hydra: Capture Native Data Snapshot`
- `Hydra: Open Native Action Log`
- `Hydra: Open Agent Call Log`
- `Hydra: Toggle Auto-advance Safe Defaults`
- `Hydra: Clean Workspace State`
- `Hydra: Archive and Clear Room`
- `Hydra: Send Test Telegram Message`

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

## Keyboard Shortcuts

Hydra ships these default keybindings (macOS uses `Cmd` in place of `Ctrl`):

- `Ctrl+Alt+H` — `Hydra: Command Center`
- `Ctrl+Alt+B` — `Hydra: Assign Builder`
- `Ctrl+Alt+R` — `Hydra: Request Review`
- `Ctrl+Alt+A` — `Hydra: Accept Default Decision`
- `Ctrl+Alt+X` — `Hydra: Stop Current Turn`
- `Ctrl+Alt+T` — `Hydra: Insert Prompt Template` (replaces the composer text with a saved `hydraRoom.promptTemplates` entry)
- `Ctrl+Alt+M` — `Hydra: Choose Model` (pick the per-phase Codex/Claude model live without editing settings)
- `Ctrl+Alt+E` — `Hydra: Choose Thinking Level` (pick the per-phase reasoning/effort level live)

Rebind any of these from VS Code's Keyboard Shortcuts editor.

Hydra starts in safe one-shot transport, then Autopilot runs Doctor and the terminal bridge self-test. By default it stays in safe one-shot mode even when the bridge test passes; set `hydraRoom.preferTerminalBridgeOnStart: true` to opt in to automatic visible terminal bridge use. If setup checks fail, Hydra stays in safe one-shot mode and shows fix buttons in the room.

The native terminal bridge is experimental and routes calls through visible terminals. Its request files, logs, replies, launchers, and session snapshots live in VS Code's private per-workspace extension storage rather than the project tree. Configured environment values are applied to the terminal process and are not written into launcher scripts; launchers and prompts are integrity-checked before execution. Agent output is echoed in the native terminal and streamed into the room while the command runs. The room shows the active transport in the header, has an Open Terminals button for bringing both native CLIs into view, and can switch back with `Hydra: Advanced: Use Safe One-Shot Transport` if terminal mode gets noisy.

Use `Hydra: Native Action` or the in-room Native Action button as the polished entry point for direct terminal work. It opens a picker for Codex, Claude, or both, with optional editor or working-tree context.

Choose `Codex Command` or `Claude Command` in that picker, from the command palette, or from the Direct Terminals tool group when you need exact native subcommand parity instead of a prompt-shaped agent turn. The input is parsed as args after the configured executable, so examples include `doctor`, `mcp list`, `plugin list`, `features`, or any other native CLI subcommand you want Hydra to run and capture.

The same picker also includes a native command catalog based on the current Codex and Claude CLI surfaces: MCP/plugin help and list/status commands, feature/debug/sandbox/app-server inspection, Claude agents/project/auto-mode/ultrareview/auth/install help, and interactive terminal entries for auth/login/logout, resume/continue/fork, worktree, remote-control, app/cloud, install/setup-token, and update flows. The reconnaissance notes live in `docs/native-cli-recon.md`.

Choose `Codex Raw Terminal Line` or `Claude Raw Terminal Line` when the native CLI flow is interactive or terminal-native, such as auth, plugin setup, remote-control sessions, or a TUI. Hydra sends the line into the visible terminal and records the action, but it does not wait for or parse a room reply.

Use `Hydra: Command Center` or the in-room Command Center button when you are not sure which Hydra control to use next. It opens a context-aware picker that prioritizes recovery, default decisions, review, verification, native actions, terminal transport, and diagnostics based on the current room state.

Hydra also adds a VS Code Status Bar item. Click it to open Command Center from anywhere; it shows setup attention, active runs, verification, and Work Queue counts without reopening the room first.

Every direct native action writes a structured receipt to `.hydra/native-actions.jsonl`, including the target heads, attached context summary, prompt envelope ids, redacted native session hints, and final status. The room shows the latest native actions with agent/status filters plus Rerun, Fork, Objective, Discuss, and Clear controls. Rerun sends the same instruction to the same heads with the same attachment options, Fork copies the old instruction into the composer, Objective pins it as room context, Discuss sends it into the normal Hydra room loop, and Clear removes resolved or junk receipts from the visible list and receipt log. Use `Hydra: Open Native Action Log` or the in-room Open Actions button when you need the raw log.

Native session hints are correlation metadata only: recent Codex session ids from `session_index.jsonl` and matching Claude live-session ids from `.claude/sessions`, with status/entrypoint/basename labels where available. Hydra does not import native transcript bodies.

Use the in-room `Poke Codex` and `Poke Claude` buttons, or `Hydra: Poke Codex Terminal` / `Hydra: Poke Claude Terminal`, when you want to talk to one native CLI directly without starting the full opener -> reactor -> closer room loop. Pokes still stream terminal output into the room and are written to the transcript.

Normal room messages use the opener -> reactor -> closer discussion loop by default (`hydraRoom.discussionMode: parallelOnBoth`). If the latest message explicitly addresses the group, such as "all of you", "all heads", "both of you", or "Codex and Claude, ...", Hydra instead runs every seated head in parallel with an independent discussion prompt and returns control after all replies finish. Set `hydraRoom.discussionMode` to `parallel` when latency matters more than serialized critique choreography; set it to `serial` to force the traditional loop even when a message addresses the group.

Codex and Claude now default to the same **Full Native — Equal Maximum Access** profile in discussion, Build, and Review. Codex runs with `danger-full-access`; Claude runs with its equivalent permission bypass. Hydra grants both heads the same maximum permission posture instead of silently weakening one, while each head keeps its own configured workspace and native integration surface. Native CLIs implement and name tools differently, so equal maximum access does not imply identical vendor tool catalogs or provider capabilities. The existing modal consent gate remains mandatory per head and workspace before any full-native call runs, and the Profiles control can deliberately narrow either head.

Set `hydraRoom.roomRoster` in User Settings to choose the ordered heads seated in a room. It accepts at least two registered agent IDs from the built-in heads or `hydraRoom.agents`; the first head is the default opener, and later heads are eligible reactors and reviewers. This roster is the durable identity boundary used when Hydra assigns participants across discussion, Build, and Review.

Hydra adds Codex `exec`'s `--skip-git-repo-check` for normal room turns so new folders can be used before they have a Git repository. Exact `Hydra: Run Codex Native Command` calls remain raw native passthrough.

Use `Attach` in the composer, `Hydra: Attach Files`, or Command Center's `Attach Files` action to add local files or documents to the next room turn. Hydra copies the selected files into `.hydra/attachments/<turn>/`, keeps the durable transcript message to a short attachment summary, and injects the copied workspace paths plus bounded text previews only into the agent prompt. Text previews use `hydraRoom.attachmentPreviewMaxChars`; file copies are bounded by `hydraRoom.attachmentMaxBytes` per file and `hydraRoom.attachmentTotalMaxBytes` across pending attachments. Binary documents are still copied in full within those limits for the native CLIs to inspect directly.

Use `Codex + Editor` / `Claude + Editor`, or the matching command-palette actions, when the active editor matters. Hydra attaches the active selection first; if nothing is selected, it attaches the active file up to `hydraRoom.editorContextMaxChars`. Direct terminal pokes include the active room transcript plus any editor context you explicitly attach.

Use `Codex + Diff` / `Claude + Diff`, or the matching command-palette actions, when the working tree matters. Hydra attaches `git diff HEAD` plus untracked files, capped by `hydraRoom.diffMaxLines`, to one direct native-terminal request.

Visible terminal prompts do not inject repository instructions by default, so each native CLI can rely on its own local context loading. Set `hydraRoom.terminalBridgeWorkspaceInstructionsMaxChars` above 0 to opt in to capped Hydra-injected repository instructions. Both transports filter out the recipient CLI's own native instruction files (Claude → `CLAUDE.md`, Codex → `AGENTS.md` / `.codex/instructions.md`) since the CLI auto-loads them from the workspace root — only the *other* agent's instructions are inlined. One-shot prompts use phase-aware `hydraRoom.oneShotWorkspaceInstructionsMaxChars` defaults of `12000` characters for discussion, Build, and Review.

Use `Poke Both`, `Both + Editor`, or `Both + Diff` when you want Codex and Claude to answer in parallel through their native terminals without the room protocol. Hydra opens both terminals, creates one user transcript entry, and streams both replies into separate agent bubbles.

## Autopilot

Autopilot is the first-run path:

- checks that a workspace is open and `.hydra/` is writable
- resolves `codex` and `claude` from the VS Code extension host environment
- warns when command or raw-args settings are overridden by workspace settings
- runs the terminal bridge self-test
- opens native terminals only after the bridge is usable
- keeps safe one-shot automatically unless `hydraRoom.preferTerminalBridgeOnStart` is enabled

Turn it off with `hydraRoom.autopilotOnStart: false`. Keep one-shot as the automatic default with `hydraRoom.preferTerminalBridgeOnStart: false`.

## Transcript

Hydra keeps the full room log at `.hydra/transcript.md`. Agent prompts include the active room transcript so the agents see the same room history Hydra has on disk.
To keep long rooms from sending the same old discussion back to both agents on every turn, prompt injection keeps only the newest active transcript messages once `hydraRoom.promptTranscriptMaxChars` is exceeded. The default is phase-aware: discussion turns use `80000` characters for lower latency, while Build and Review keep `400000` characters for deeper implementation context. This is a per-call cost and attention guardrail, not a model context-window limit. You can still set a single number to apply to every phase, or use an object like `{ "discussion": 80000, "build": 400000, "review": 400000 }`. When the active transcript crosses the largest configured cap, Hydra also runs a wiki context refresh so durable facts can be compacted into `.hydra/wiki/context.md` before older transcript content is omitted. The omitted history remains in `.hydra/transcript.md` or `.hydra/archive/`.

Hydra also writes:

- `.hydra/objective.md` for the pinned room objective.
- `.hydra/decisions.jsonl` for structured decision packets.
- `.hydra/scoreboard.md` for a derived, human-readable Evidence Standings mirror.
- `.hydra/score-evidence.md` for a derived audit view of the active verdicts currently driving those standings.
- `.hydra/duels.md` for a derived audit of formal challenges, paired reveals, independently adjudicated results, corrections, and domain Elo ratings.
- `.hydra/verification.jsonl` for build/test/check evidence.
- `.hydra/native-actions.jsonl` for direct native terminal action receipts.
- `.hydra/native-capabilities.md` for the latest Codex/Claude version and help snapshot.
- `.hydra/native-data-snapshot.md` for redacted Codex/Claude config, plugin, model, state, and session metadata.
- `.hydra/work-queue.jsonl` for queue dismiss/snooze state.
- `.hydra/session-brief.md` for the latest operator snapshot.
- `.hydra/wiki/` for the compiled project wiki Hydra injects into future prompts.
- `.hydra/support-bundle.md` for the latest diagnostics snapshot.
- `.hydra/prompts/index.jsonl` for prompt envelopes showing the exact command, transport, context, and rendered prompt sent to native CLIs.
- VS Code per-workspace extension storage for ephemeral terminal-bridge request, reply, log, launcher, and session files.

Use `Hydra: Clean Workspace State` to compact old rendered prompt bodies out of `.hydra/prompts/index.jsonl` while keeping envelope metadata such as id, timestamp, agent, phase, transport, command, authority, budget, and body length. Hydra also runs this cleanup after `Archive + Clear`. By default, full prompt bodies are kept for 3 days (`hydraRoom.promptBodyRetentionDays`) and older records become metadata-only diagnostics. Set the retention to `0` to compact prompt bodies whenever cleanup runs. Workspace cleanup also deletes copied room attachments and legacy terminal artifacts after `hydraRoom.diagnosticRetentionDays`; current terminal-bridge storage has its own short retention sweep outside the project tree.

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

## Evidence Standings

Use `Hydra: Record Evidence Verdict` to record a head's falsifiable claim and its deterministic or human-adjudicated outcome, then use `Hydra: Open Standings` to inspect the passive reliability table. `Hydra: Review Score Evidence` exposes active evidence, pending claims, and the complete actor-attributed reversal history. If an adjudication is wrong, `Hydra: Reverse Evidence Verdict` appends a reversal instead of erasing history; `Hydra: Adjudicate Pending Score Claim` can then attach a corrected verdict to that same claim. Deterministic scoring never accepts a free-form claim: it creates an exact claim from the latest passing Hydra verification receipt. Every verdict requires an evidence note, and repeated claims in one round cannot inflate maturity. Scores use a conservative Wilson lower bound and remain provisional until five independently resolved rounds. Peer opinions are stored as advisory context only and do not affect scores. The authoritative append-only ledger lives in VS Code's private per-workspace extension storage; `.hydra/scoreboard.md` and `.hydra/score-evidence.md` are derived mirrors and not sources of truth.

Evidence Standings are observational only. They cannot change native permissions, approvals, builder assignment, speaking order, or orchestration.

Formal Duels are a separate competition with one current path: **agent-initiated, then rated or rejected by policy**. Only a successful reply from the normal serial reactor/closer flow can challenge the head whose reply it just examined by emitting a strict duel intent with a falsifiable proposition, domain, evidence contract, and rationale. There is no human Create Duel action and ordinary user wording does not manufacture agent intent. Set `hydraRoom.agentInitiatedDuels` in User Settings to disable the feature; it is also forced off in untrusted workspaces.

Hydra binds the challenge to the actual challenger, opponent, and source turn, builds one bounded shared evidence packet from the active discussion, and applies admission and anti-farming rules. A rejected challenge is logged and changes no rating; Hydra never downgrades it into an exhibition. An admitted `elo-v3-agent-initiated` duel automatically dispatches both configured heads, seals each private answer before either can see the other, and reveals the pair together. Human involvement is limited to independently adjudicating the revealed evidence or cancelling/correcting the append-only record; the human never supplies either commitment. `Hydra: Advance Formal Duel` opens the next human action for an existing duel, while `Hydra: Open Duel Audit` exposes its provenance.

Both participants run under the versioned `hydra-duel-full-native-v1` policy with equal maximum Hydra-grantable permissions. Before admission, Hydra preflights both actual configured heads under that policy and rejects the challenge unless both resolve to supported local full-native spawns. Codex receives ephemeral `danger-full-access`; Claude receives unrestricted nonpersistent execution. Known configured capability flags for models, profiles, features, MCP configs, plugins, browser/IDE integration, settings, agents, and extra directories carry into the duel launch while Hydra replaces restrictive authority, output, persistence, prompt, and working-directory controls. Hydra locks each participant's effective command, model, arguments, working directory, and environment digest at admission and verifies that lock again before dispatch. The digest binds the effective environment without recording its raw values. Each head retains its configured native integrations and tools, but Codex and Claude can expose different vendor-specific catalogs; parity means equal maximum Hydra-granted permissions, not identical tools or provider capabilities. Automatic commitments require prior persistent full-native consent for both heads and never open a surprise consent modal.

The shared project workspace is read-only by duel contract even though each native runtime remains full-access: participants must not modify, create, delete, or rename project content and must put disposable verification artifacts in the operating-system temp directory. At admission, Hydra fingerprints bounded project content and entry metadata outside Git's `.git` directory and Hydra-owned `.hydra`, rechecks that state around both commitments, and keeps a live mutation monitor over the same project boundary. A detected mutation or unverifiable state automatically cancels the duel with no Elo so the heads do not knowingly evaluate different project evidence. This is an integrity tripwire for ordinary project mutations, not an absolute guarantee against a malicious process running as the same OS user.

Every commitment is head-generated and Hydra-bound. There is no operator-authored answer, manual human initiation, or exhibition fallback. Legacy `elo-v1` exhibition/operator rows remain immutable unranked history, while prior rated policies remain replayable for audit. V3 admission and execution records bind the admission-time workspace fingerprint, participant capability lock, configured head, initiating reply, shared-evidence SHA-256, prompt, effective invocation, timing, transport, and response before SecretStorage seals the answer and confidence. Those records prove Hydra's configured dispatch and response binding, not provider-signed model identity, identical vendor tools, or equal hidden provider state. Full-native processes can access the same OS account, so the workspace guard and SecretStorage are application integrity controls—not defenses against a malicious same-user process.

Duel Elo starts at 1000 with K=24 and is replayed separately per domain. Decisive rated matches move winner and loser by equal-and-opposite amounts; a tie records a draw but moves exactly zero Elo, and void, unresolved, rejected, cancelled, and legacy-unranked matches move nothing. Repeated propositions, reciprocal farming, multiple unresolved duels per head, initiation cooldowns, and daily caps are rejected by Hydra instead of producing noncompetitive matches. Every head sees its rank and exact gap to the domain's #1 in prompt context. Lower-ranked heads are told to work harder and smarter—verify more, expose assumptions, and make sharper falsifiable predictions—to take the crown; the Supreme Head receives the same pressure to defend it. Competitive status remains motivational only: the user's objective, truth, safety, and honesty outrank Elo, and rating never changes permissions, approvals, builder assignment, speaking order, context allocation, or safety authority.

## Work Queue

Hydra computes a live Work Queue from existing durable state: actionable decision defaults, failing verification, and failed or cancelled native actions. Queue items appear in the room with one-click actions such as Accept, Discuss, or Rerun. Use Dismiss to hide an item until its underlying source changes, or Snooze to hide it for one hour. The queue items themselves are the current attention view over `.hydra/decisions.jsonl`, `.hydra/verification.jsonl`, and `.hydra/native-actions.jsonl`; only dismiss/snooze state is stored separately in `.hydra/work-queue.jsonl`.

## Session Brief

Use `Hydra: Open Session Brief` or the in-room Session Brief button to refresh and open `.hydra/session-brief.md`. The brief is a compact human-facing snapshot of the current objective, phase, transport, Work Queue, latest decision, latest verification, recent native actions, and recent room messages. It is not automatically injected into agent prompts; it exists so you can quickly recover the room state after reloads or handoffs without rereading the full transcript.

## Wiki Context

Hydra maintains a small LLM wiki under `.hydra/wiki/`: `schema.md`, `context.md`, `index.md`, `log.md`, and immutable raw wrapup sources under `.hydra/wiki/raw/turns/`. Non-default wiki synthesis is injected into future prompts before the transcript, capped by `hydraRoom.wikiContextMaxChars`. Routine prompts include `context.md` and `index.md`; `log.md` stays out of the prompt by default because it is append-only maintenance evidence, but `hydraRoom.wikiPromptIncludeLog` can opt it back in. When injected, agent preambles tell Codex and Claude to treat the wiki as established compiled memory unless the latest user instruction, active transcript, or direct source evidence contradicts it.

After each successful discussion turn, `hydraRoom.wikiWrapupEnabled` asks one native agent to distill durable facts from that turn into the wiki and append the log. Automatic wiki maintenance is queued in the background from a captured turn snapshot, so the room can hand back to the user or auto-advance without waiting for the wrapup agent. When the active transcript reaches the largest `hydraRoom.promptTranscriptMaxChars` phase cap, Hydra runs an additional context-refresh wrapup from the active transcript snapshot, so the wiki is refreshed at the durable-memory boundary even when discussion prompts use a smaller latency cap. When a wrapup changes the wiki, Hydra also saves the source as a raw snapshot and records its path/SHA in the log, so future cleanup or contradiction passes can cite the exact source. New or materially changed context facts are prompted to carry `[src:<sha12>]` provenance tags back to the raw snapshot; when those tags are present in prompt context, agent preambles ask replies that lean on wiki facts to reuse the matching tag. Hydra records lightweight diagnostic telemetry for agent replies when wiki context was present, splitting real source-citation signal from wiki-name or `.hydra/wiki` path mentions so future tuning can tell if the wiki is actually being used. `hydraRoom.wikiRawTurnsKeepDays` prunes old raw snapshots after wrapups; set it to `0` to retain them forever. `hydraRoom.wikiWrapupAgent` can pin Codex or Claude, or leave `auto` to pick the lower estimated configured discussion-model cost. Use `Hydra: Run Wiki Wrapup Now` to force the latest completed room turn through the same path and surface skip/failure diagnostics. Use `Hydra: Open Wiki Context` to inspect or edit the compiled memory; `Hydra: Command Center` also shows wiki prompt size, raw source count, the latest wrapup, and rolling wiki citation/name-mention rates after telemetry warms up.

## Support Bundle

Use `Hydra: Open Support Bundle` or the in-room Support Bundle button to refresh and open `.hydra/support-bundle.md`. The bundle is a diagnostics snapshot for debugging Hydra itself: Doctor checks, effective native authority, native runtime command/argv/env-key diagnostics, compact native data and model-capability summary, terminal session state, Work Queue, latest decision, verification, recent native actions, and recent messages. It avoids rerunning the terminal bridge self-test unless Doctor has already captured one, so opening it is cheap and non-disruptive.

## Telegram Notifications

Hydra can notify Telegram when an agent decision packet has a non-empty `Decision needed from user` field. Set `hydraRoom.telegramBotToken` and `hydraRoom.telegramChatId` in User Settings, or set `TELEGRAM_BOT_TOKEN` in the extension host environment and keep the token setting blank. Leave `hydraRoom.telegramNotifyOnDecisionNeeded` enabled to send decision-needed alerts.

Run `Hydra: Send Test Telegram Message` from the Command Palette or Hydra Command Center after configuring the bot. A successful test writes a confirmation system message into the room; failures point back to the Telegram settings.

Hydra can also poll Telegram for inbound commands. Enable `hydraRoom.telegramInboundPollingEnabled` in User Settings, then send messages in the configured chat that start with `hydraRoom.telegramInboundCommandPrefix` (default: `/hydra`). For example, `/hydra accept the default and continue` is appended to the room as user input. The first poll skips older Bot API updates and stores the next update offset in `.hydra/telegram-inbound.json` so old messages are not replayed after restart. Inbound polling is disabled by default because Telegram messages are remote untrusted input; only set an empty prefix for a private bot chat you fully trust.

## Verification

Use `Hydra: Run Verification` or the in-room button after a build. Hydra runs `hydraRoom.verifyCommand` from the workspace root. If that setting is blank, Hydra infers a command from `package.json` scripts in this order:

1. `npm run verify:fast`
2. `npm run verify`
3. `npm run check && npm test`
4. `npm test`
5. `npm run check`
6. `npm run lint`

Inference is gated by Workspace Trust. In a trusted workspace, Hydra may run the inferred command. In an untrusted workspace, Hydra refuses inferred `package.json` commands because those scripts are attacker-controlled; set `hydraRoom.verifyCommand` in User or Machine Settings to opt in explicitly, or grant Workspace Trust.

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
cd C:\path\to\hydra
corepack enable
pnpm install
pnpm run check
pnpm test
pnpm run package
```

The package command builds a local `.vsix`. Marketplace release metadata lives in `package.json`; use `docs/release.md` for the release checklist.

To install this working copy into VS Code from the repo root:

```powershell
pnpm run install:local
```

That command runs the package flow, resolves `code.cmd`/`code` from `PATH`, `VSCODE_CLI`, or known VS Code install locations, then installs the newest local `.vsix` with `--force`. If a `.vsix` already exists and you only want to reinstall it, run `pnpm run install:local:existing`.

If PowerShell blocks `pnpm.ps1` because script execution is disabled, use the command shim directly:

```powershell
pnpm.cmd run install:local
```

Or bypass pnpm entirely:

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
