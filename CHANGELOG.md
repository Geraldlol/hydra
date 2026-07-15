# Changelog

## 0.6.0

Current-model refresh and Telegram inbound hardening.

- **Duel capability carry-through** — Known configured model, profile, feature, MCP, plugin, browser/IDE, settings, agent, and extra-directory flags now carry into the forced full-native commitment launch. Legacy rated rows remain audit history but cannot constrain or grant current v3 Elo.

- **Durable N-head rooms** — the ordered `hydraRoom.roomRoster` now drives discussion roles, parallel build/review handoffs, status/authority rails, opener selection, and builder controls without inferring identities from a Codex/Claude binary.
- **Passive evidence standings** — append-only claim, verdict, and actor-attributed reversal events power a new in-room standings inspector, evidence/reversal audit report, and record/reverse/replacement commands. Deterministic claims are generated from the exact passing verification receipt instead of accepting unrelated free-form text; human adjudication can score other falsifiable claims, while peer assessments remain advisory. Scores cannot grant native authority, approvals, builder assignment, speaking priority, or orchestration control.
- **Autonomous full-capability head duels and parity** — Codex and Claude now default to equal maximum Hydra-granted full-native permissions in discussion, Build, and Review, behind the existing explicit per-workspace consent gate. Only a successful reply from the normal serial reactor/closer flow may initiate a strict, source-bound `elo-v3-agent-initiated` challenge against the head it just examined; there is no human Create Duel action. Hydra admits or rejects the challenge under capability, cost, active-duel, cooldown, daily-cap, repeated-proposition, and reciprocal-farming policy, then automatically runs and jointly reveals both sealed head-generated commitments. Human involvement is limited to independently adjudicating, cancelling, or correcting the append-only result. Hydra never creates exhibition or operator-authored fallbacks. Before admission, Hydra preflights both actual configured heads under the same maximum Hydra-granted permission policy and locks each effective command, model, arguments, working directory, and environment digest; raw environment values are not recorded. Each head keeps its configured native integrations, but vendor tool catalogs and provider capabilities may differ. The shared project workspace is read-only by duel contract, so disposable verification belongs in the operating-system temp directory. Hydra fingerprints bounded project content and entry metadata and runs a live mutation monitor outside `.git` and Hydra-owned `.hydra`; a detected mutation or unverifiable state automatically cancels the duel with no Elo. This guard is not an absolute defense against a malicious same-user process. Prior event versions remain replayable history. Domain Elo, exact-zero ties, paired reveal, correction events, and exact chase gaps remain motivational only and never change permissions, approvals, builder assignment, speaking order, context allocation, or safety policy.

- **Model chooser refresh** — `Hydra: Choose Model` now lists the current models: Claude **Fable 5** (`claude-fable-5`), **Mythos 5** (`claude-mythos-5`, approved Project Glasswing orgs only), **Sonnet 5** (`claude-sonnet-5`), **Opus 4.6**, and a `fable` family alias; **GPT-5.6** leads the Codex fallback list. Family aliases (`fable`/`sonnet`/`opus`/`haiku`) are listed first because they always resolve to the current build. The cost meter (`hydraRoom.modelPrices` defaults) prices the new models, and a source-contract test now fails CI if the current flagships drop out of the chooser.
- **Telegram sender-name sanitization** — the untrusted Telegram sender display name is now run through a shared `sanitizeSenderName()` on both the fenced-prompt path and the System-role transcript line, closing a prompt-injection vector where a sender's profile name could reach the agent prompt under Hydra's trusted voice.
- **Per-sender Telegram allowlist** — new `hydraRoom.telegramInboundAllowedSenderIds` (application-scoped, trust-restricted) gates inbound commands to specific Telegram user ids. Empty (default) preserves existing behavior; a non-empty list fails closed on a missing sender id. Setting descriptions now warn that a group `telegramChatId` authorizes every member.

## 0.5.1

Marketplace publish follow-up.

- Changes the Marketplace display name from **Hydra** to **Hydra Agents** because the bare **Hydra** display name is already taken.
- Keeps the durable extension identity unchanged: publisher `geraldlol`, package name `vscode-hydra-room`, extension id `geraldlol.vscode-hydra-room`.

## 0.5.0

Public beta release candidate.

- Adds Marketplace metadata for the public Hydra listing under publisher `geraldlol`.
- Marks the extension as Preview and keeps the visible product name as **Hydra**.
- Adds pre-release VSIX packaging support via `pnpm run package:pre-release`.
- Keeps the existing local-first security posture documented: Hydra can spawn Codex and Claude with workspace-write authority by default, and untrusted workspaces restrict sensitive spawn/configuration settings.

## 0.4.x

Summary of the major themes shipped across the 0.4 line since 0.1.0 (see `git log` for per-commit detail):

- **Room file attachments** — attach local files to a turn; Hydra copies them into `.hydra/attachments/`, keeps the transcript message short, and injects bounded text previews into the next agent prompt.
- **Live JSON-mode replies** - streams displayable assistant text from Claude `stream-json` and Codex `--json` output while the call runs, then replaces it with the normalized final reply at completion.
- **Claude Opus 4.8** — adds `claude-opus-4-8` to Hydra's Claude model chooser and cost-meter defaults.
- **Workspace cleanup** — `Hydra: Clean Workspace State` plus trust-scoped retention settings (`hydraRoom.promptBodyRetentionDays`, `hydraRoom.diagnosticRetentionDays`) compact old prompt bodies and prune stale terminal-bridge diagnostics; symlinked diagnostic dirs are refused.
- **Project wiki memory** — a compiled `.hydra/wiki/` (`schema.md`, `context.md`, `index.md`, `log.md`, raw turn snapshots) injected into future prompts, with automatic post-turn wrapups, source provenance tags, usage telemetry, and a manual `Run Wiki Wrapup Now`.
- **Prompt replay caps** — phase-aware transcript windows keep discussion turns lean while preserving deeper Build/Review context, and terminal-bridge room turns now respect the same caps as one-shot turns.
- **Model and thinking-level choosers** — live per-phase Codex/Claude model selection (`Hydra: Choose Model`, `Ctrl+Alt+M`) and reasoning/effort selection (`Hydra: Choose Thinking Level`, `Ctrl+Alt+E`), backed by `hydraRoom.codexModel`/`claudeModel` and `hydraRoom.codexReasoning`/`claudeEffort`, plus a session cost meter from `.hydra/usage.jsonl` and `hydraRoom.modelPrices`.
- **Telegram** — outbound decision-needed notifications and optional inbound command polling (prefix-gated, off by default because inbound messages are untrusted), alongside the generic HTTPS handoff webhook.
- **Terminal bridge** — the experimental visible-terminal transport with live output echo, session snapshots, health reporting, and self-test; safe one-shot remains the default transport.
- **Discussion modes** — `hydraRoom.discussionMode` (`parallelOnBoth` default, `serial`, `parallel`) and an `Assign Both Builders` parallel build/review branch.
- **Security hardening** — application-scoped sensitive settings enforced under Workspace Trust, POSIX env-var validation for the dispatch script, HTTPS-only webhook, redacted native data snapshots, and risk-gated auto-advance.

## 0.1.0

- Initial Hydra Room extension.
- Adds a shared VS Code room for the user, Codex CLI, and Claude Code CLI.
- Supports safe one-shot transport and an experimental native terminal bridge.
- Persists full transcript, pinned objective, and decision packets under `.hydra/`.
- Adds Doctor checks, stuck-turn reset, terminal bridge self-test, and package scripts for VSIX builds.
- Adds Autopilot Start for first-run diagnostics, transport selection, and direct CLI path repair buttons.
- Adds actionable decision packets with an Accept Default command and in-room button.
- Adds one-click verification, `.hydra/verification.jsonl`, and review prompts that include latest verification evidence.
- Adds automatic post-build verification with an optional auto-review handoff after passing checks.
- Makes terminal bridge calls visibly live by echoing captured agent output in the native terminal while streaming it into the room.
- Adds terminal session snapshots under `.hydra/sessions/` plus in-room terminal session cards and a Terminal Bridge Health command.
- Adds prompt envelopes, `.hydra/prompts/index.jsonl`, and a Preview Next Prompt command/button for inspecting the exact native CLI call before it runs.
- Adds room file attachments that copy selected local files into `.hydra/attachments/`, show pending attachment chips in the composer, keep durable transcript messages short, and inject attachment paths plus bounded text previews into the next agent prompt.
- Adds native authority classification, capability profile labels, authority badges, and a Show Effective Native Authority command.
- Adds an in-room Open Terminals button so users can bring the native Codex and Claude terminals forward without changing transport mode.
- Adds direct native terminal pokes for Codex and Claude, letting users run one native CLI endpoint from the room without starting the full Hydra loop.
- Adds editor-context native terminal pokes that attach the active selection or active file to one direct Codex/Claude terminal request.
- Adds working-tree native terminal pokes that attach `git diff HEAD` plus untracked files to one direct Codex/Claude terminal request.
- Adds both-terminal native pokes so Codex and Claude can receive the same direct terminal instruction in parallel.
- Adds a Native Action picker that consolidates Codex, Claude, both-head, editor-context, and working-tree terminal pokes behind one polished command/button.
- Adds `.hydra/native-actions.jsonl`, an Open Native Action Log command, and an in-room Open Actions button so direct native terminal actions leave durable structured receipts.
- Adds an in-room native action history board with Rerun and Fork controls for recent direct native terminal actions.
- Adds agent/status filters plus Objective and Discuss promotion controls to the native action history board.
- Adds a live Work Queue that surfaces actionable decision defaults, failing verification, and failed/cancelled native actions with one-click Accept, Discuss, or Rerun controls.
- Adds durable Work Queue Dismiss and Snooze controls backed by `.hydra/work-queue.jsonl`.
- Adds a Session Brief command/button that refreshes `.hydra/session-brief.md` with the current objective, Work Queue, latest decision, verification, recent native actions, and recent messages.
- Adds a Support Bundle command/button that refreshes `.hydra/support-bundle.md` with Doctor checks, native authority, terminal sessions, Work Queue, latest decision, verification, recent native actions, and recent messages.
- Adds a Command Center command/button with a context-aware picker for recovery, default decisions, review, verification, native actions, transport, and diagnostics.
- Adds a VS Code Status Bar entry that opens Command Center and surfaces setup, running, verification, and Work Queue attention.
- Adds prompt context hygiene so latest user corrections and newer verification evidence override stale transcript status, including exact-output requests.
- Clarifies terminal bridge ready text now that visible terminals receive short dispatch launchers instead of full request scripts.
- Groups the room composer footer into primary actions plus collapsible Workflow, Direct Terminals, and Diagnostics tool sections.
- Injects repository instruction files such as `CLAUDE.md`, `AGENTS.md`, and `.codex/instructions.md` into Hydra prompts so local command setup is visible to both agents.
- Preserves native CLI parity for unknown/custom Codex and Claude args: Hydra labels authority instead of blocking new native flag shapes.
- Expands `${hydraPromptFile}`, `${hydraReplyFile}`, and `${hydraLogFile}` inside raw native args so Codex and Claude file/output flags can target the current Hydra request artifacts.
- Adds Native Action command lanes for exact Codex/Claude subcommands such as `doctor`, `mcp list`, `plugin list`, or other native CLI operations that are not prompt-shaped agent turns.
- Promotes exact Codex/Claude native commands to command-palette entries and Direct Terminals room buttons.
- Adds raw terminal-line actions for interactive native CLI flows that should run in the visible terminal without Hydra waiting for a structured reply.
- Adds `hydraRoom.nativePathPrepend` and `hydraRoom.nativeEnv` so one-shot and terminal-bridge dispatches share explicit PATH and environment setup.
- Adds Codex-only and Claude-only native PATH/env overrides layered on top of shared native environment settings.
- Adds native runtime diagnostics to the Support Bundle so resolved commands, args, env keys, and PATH overrides are auditable per agent/profile.
- Adds a Native Capability Snapshot command/button that captures configured Codex and Claude `--version` / `--help` output into `.hydra/native-capabilities.md`.
- Adds a native command catalog to the Native Action picker with Codex and Claude subcommand presets for MCP, plugins, auth/login, resume/continue/fork, worktree, remote-control, app/cloud, update, and diagnostics flows.
- Expands the native command catalog from a deeper local CLI reconnaissance pass and records the findings in `docs/native-cli-recon.md`.
- Adds `docs/native-data-recon.md` with redacted notes on Codex and Claude config, plugin, model, session, and state-file structures for future parity work.
- Adds a Native Data Snapshot command/button that writes redacted Codex and Claude config, plugin, model, state, and session metadata to `.hydra/native-data-snapshot.md`.
- Adds a compact native data summary to the Support Bundle so one diagnostic artifact shows both Hydra runtime state and native CLI state.
- Expands native data diagnostics with Codex model capability summaries for reasoning levels, service tiers, search/image support, parallel tools, verbosity, and apply-patch modes.
- Adds redacted Claude project and subagent metadata summaries to native data diagnostics without ingesting raw transcript bodies.
- Adds redacted native session hints to direct native action receipts so Hydra actions can be correlated with Codex and Claude history without importing raw history.
- Expands the Native Capability Snapshot with read-only MCP, plugin, feature, and auth/status probes plus an integration summary.
- Derives structured integration summary details from native probe output, including plugin/server counts and names from JSON where available.
- Includes the latest native integration probe summary in generated agent prompt profiles when a snapshot exists.
- Makes native integration prompt context task-aware so ordinary coding turns stay lean unless MCP, plugins, auth, feature flags, marketplaces, integrations, or connected tools are relevant.
