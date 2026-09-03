# Changelog

## 0.8.1

- Adds Claude **Fable 5.1** (`claude-fable-5-1`) and **Mythos 5.1** (`claude-mythos-5-1`) to `Hydra: Choose Model`, ahead of Fable 5; the `fable` alias now resolves to Fable 5.1.
- Mirrors the Codex fallback model list to `codex debug models` on codex-cli 0.144.1: adds `gpt-daybreak-blue-latest` and drops the retired `gpt-5.3-codex` and `gpt-5.2`.
- Updates the default cost-meter prices (`hydraRoom.modelPrices`): Fable 5.1 / Mythos 5.1 cache reads bill at the reduced $0.25/MTok rate, Sonnet 5 at its now-standard $2/$10, and the GPT-5.6 family at OpenAI's post-cut rates (Sol $4/$20, Terra $2/$12, Luna $0.20/$1.20).
- Resolves the open Dependabot alerts by pinning the transitive dev dependencies `fast-uri` to 3.1.7 (two high: SSRF via repeated hostname percent-decoding, host confusion via skipped IDN canonicalization) and `qs` to 6.16.0 (two moderate: array-limit bypass, `isBuffer` denial of service). Both reach the repo only through `@vscode/vsce` and `secretlint`; nothing ships in the `.vsix`.

## 0.8.0

Release candidate. Marketplace and GitHub publication remain separate human-approved actions.

### Added

- Adds operator-complete Mission Contracts: local proposal/amendment, exact confirmation, agent-proposal admission, dismissal, retirement, private authoritative replay, readable mirrors, and dispatch-time Mission/hash binding.
- Adds a strict private metadata Flight Recorder for phase, provider, steering, browser/approval, structured tool/edit, verification, usage, and native-action lifecycles. The operator inspector supports safe isolated Replay preparation and hash-bound eval-case creation; Replay does not retain exact prompt/response bodies, reuse provider sessions, or submit automatically.
- Adds capability-negotiated live steering with exact run/Mission/authority targeting, authenticated cross-window delivery, and separately opted-in Telegram steering behind exact bot/chat/sender authorization.
- Adds N-way reviewer selection and deterministic `human`, `unanimous`, and `majority` convergence. Invalid, missing, tied, or non-unanimous results fail closed for human resolution.
- Extends Claude Worker Fanout to one-shot Build and Review. Build extras are isolated no-tool advisers that drain before one ordinary lead writer; duplicate Review attempts collapse to one Claude roster verdict and cannot manufacture votes.
- Completes the built-in Gemini headless adapter contract: stdin JSON mode, strict reply and SessionMetrics usage parsing (including compatible derived-input handling), current model aliases/pricing, raw-output fallback, and phase-aware native-authority classification.
- Adds Arena's isolated core and operator workflows: bounded immutable manifests/evidence, locked verification and browser journeys, a non-authoritative Flight sidecar, simultaneous reveal, explicit winner/synthesis records, exact-previewed and separately confirmed local promotion, startup classification, and explicitly confirmed dead-owner repository-lease takeover. The recovery command does not resume, abort, clean up, or start contestant work.
- Adds a strict deterministic SPDX 2.3 consumer SBOM bound to the recorded VSIX checksum and source-commit epoch, plus digest-bound GitHub build-provenance and SBOM attestations in a minimal signing job isolated from dependency and repository code.

### Changed

- Makes Arena history and evidence bounded, crash-recoverable, path/link hardened, and source-bound across process, cleanup, promotion, and repository-owner receipts.
- Expands CI to Node 22.22.1 and 24.x on Linux, Windows, and macOS, with separate extension-host, dependency-audit, coverage, and package jobs using immutable action revisions and minimal permissions.
- Adds first-class format/lint and coverage gates; coverage requires at least 80% lines, 70% branches, and 80% functions.
- Makes agent-default auto-advance an informed opt-in: it defaults off, requires a trusted-workspace modal acknowledgment to enable, and leaves manual Accept Default available.

### Fixed and security

- Bounds every OpenAI-compatible completion request to 4,096 output tokens by default, with a validated per-head override, so provider timeouts and an optional session-cost rail are no longer the only denial-of-wallet controls.
- Replaces Full Native ordinary-room defaults with read-only Discussion, constrained workspace-editing Build, and read-only Review. Full Native remains an explicit consent-gated opt-in. Default Codex Build keeps command networking off and `.git` behind Codex's protected read-only sandbox boundary; ordinary Claude profiles use `--safe-mode` plus explicit phase-minimal tool lists, so non-managed hooks, plugins, shell/web/MCP/browser/skill/subagent surfaces, project/local settings, and session persistence cannot widen them.
- Hardens decision-webhook delivery against DNS rebinding: Hydra now requires HTTPS with no URL credentials, rejects any destination whose complete DNS answer set contains a non-public address, pins the vetted address through the request, rejects redirects, and applies one bounded deadline across DNS plus the HTTPS response with a 64-KiB response cap.
- Makes Arena manifest replay bind the exact segment names and per-file identity/size/change metadata instead of volatile directory timestamps, with bounded-parallel checks at the event ceiling so harmless Windows metadata drift cannot fail healthy runs.
- Makes same-environment VSIX archive creation prove byte-for-byte reproducibility across two independent package processes over one compiled tree and fail closed against source, tests, scripts, docs, nested packages, local/private tool state, credential-shaped files, unsafe ZIP metadata, and missing, extra, or stale manifests/runtime/static assets. The fresh no-OIDC handoff validator independently rebuilds the complete stable VSIX and requires byte equality for the original immutable artifact ID; it never re-uploads mutable validated files, and the attestation-authorized job can consume only that same ID after validation succeeds.
- Resolves the high-severity dependency-audit findings in release/test tooling and hardens process cancellation, cross-process lock ownership, durable parent-directory publication, Gemini authority/argument parsing, and cross-platform Terminal Bridge fallback.
- Removes Terminal Bridge reply-HMAC keys from pasted commands and shell history. Each dispatch now uses a create-new private 32-byte artifact that PowerShell exclusively reads and deletes before resolving the native CLI, with key buffers cleared on every exit path and fresh owner-tagged crash leftovers eligible for early reclamation only after the extension-host PID is definitively gone.

### Known boundaries

- Built-in native Arena heads remain unadmitted and there is no production Start Arena UI. An adapter must first provide platform-specific descendant containment and active-count-zero quiescence proof (for example, a Windows Job Object or a POSIX cgroup/container equivalent). Retained-result management, promotion, recovery, and synthetic/fake-head smoke paths do not weaken that gate.
- No live paid/authenticated Gemini or Claude worker smoke was performed for this release candidate. The implementation is covered by official contract fixtures and deterministic local tests; operators should run a bounded account-specific smoke before enabling those paths.
- Cross-platform CI and extension-host matrices must pass on the release commit, and the human-reviewed artifact digest must be recorded before publication.
- Public promotion remains blocked until a real independent security/workflow reviewer is assigned and an enforced GitHub ruleset or branch-protection policy requires that review and the release gates; a documentation-only or same-owner CODEOWNERS change would not satisfy this boundary.

## 0.7.3

- Stops a single blank line on the Codex App Server's stdout from failing an entire in-flight turn; the RPC reader now skips empty frame separators the way every other JSONL reader in the room already did.
- Gives a terminating native process ten seconds rather than one to confirm that its tree closed, so a slow reap on a Windows CLI behind a `cmd.exe` shim no longer latches the host-wide automation block that only a window reload clears.
- Fails a run closed and names the line cap when an oversized App Server frame is dropped, instead of silently stranding the turn until its timeout with no stated cause.
- Collapses stderr lines that differ only in a leading timestamp before building a failure-card preview, so a chatty CLI can no longer push the real diagnostic out of the preview window.

## 0.7.2

- Adds Claude **Opus 5** (`claude-opus-5`) to `Hydra: Choose Model` and the cost-meter defaults; the `opus` family alias remains available for the current Claude Code default.

## 0.7.1

- Makes an empty duel ledger visible as a real 1000-Elo, zero-match provisional baseline for every seated head and supported duel domain, while preserving replayed ratings as the sole source of ranked Elo changes.
- Adds live duel readiness and blocker reporting for workspace trust, configuration, equal full-native profiles, persistent consent, cost caps, and serial discussion eligibility.
- Adds `Hydra: Run Duel Readiness Test` and an in-panel readiness button. The deterministic host-side check validates the exact hidden challenge protocol without calling an agent, creating a duel event, or changing Elo.
- Records the latest eligible duel-protocol outcome, including valid requests, rejected requests, and eligible reactor/closer replies that intentionally emitted no consequential challenge.

## 0.7.0

- Adds a `/hydra-handoff` skill for the Codex CLI and Claude Code that packages the current CLI session into a handoff packet written to `.hydra/handoff-inbox/`, so work can be continued in the Hydra room. One canonical `SKILL.md` installs to both agents via `pnpm run install:handoff-skill`.
- Ingests handoff packets in the room as a one-click confirm chip with Confirm, an action override (discuss / ask all heads / build), Preview, and Dismiss; confirmation routes through the existing room turn with no new spawn path. Packets are treated as untrusted: nothing runs without an explicit confirmation, ingest is gated on a ready and trusted workspace, only prompt text and a re-validated action enum reach the room, and oversized (over 256 KB) or malformed packets are quarantined instead of ingested.

- Makes Integrated Browser routing fail closed: turns without the Hydra browser connection now report the unavailable in-app surface instead of silently substituting Chrome or another browser, while the enable flow makes clear that only newly started turns receive the session-scoped connection.
- Makes agent-initiated duels observable in real rooms by reserving top-level `Challenge:` for the strict source-bound control record, placing that protocol after generic phase prose, and reporting missing markers without guessing duel fields from prose.
- Makes the passive scoreboard active by default for evidence-bound changed serial builds. Hydra latches an absolute eligible package-script verifier and its bounded conventional control surface before dispatch, withholds points if either changes or cannot be frozen safely, correlates repeated same-plan receipts into one maturity round, skips no-op/parallel/non-clean or state-changing runs, appends receipts idempotently, and refreshes already-open windows from the private ledger.
- Hardens Windows cancellation by repeatedly discovering and terminating late-spawned descendants before reporting success, while retaining the bounded `taskkill` fallback when PowerShell/CIM cannot confirm cleanup.

- Adds a visible, native in-editor browser through VS Code's Integrated Browser, with a room button and command-palette entry plus Simple Browser fallback.
- Adds explicit, session-only agent browser control backed by schema-checked VS Code browser tools, per-head page ownership, per-action confirmation, a status-bar kill switch, and quota-limited private screenshots.
- Exposes the browser to Codex and Claude as an authenticated loopback Streamable HTTP MCP server, with per-dispatch environment tokens, collected-output redaction, safe one-shot transport, and a Node-based CLI fallback for other local heads.
- Hardens the browser consent path after a red-team pass: the Allow Once modal now reveals the full executed length of long text (so a benign prefix cannot hide a large payload) and flags agent-supplied target labels as untrusted, `hover` is confirmed like other interactions, and URL validation rejects link-local / cloud-metadata hosts and credential-bearing URLs while keeping loopback and LAN dev servers browsable.
- Documents the Code - OSS fork tradeoff and the native-browser architecture in ADR 003.

## 0.6.1

Marketplace presentation and packaging follow-up.

- Refreshes the README for durable N-head rooms, equal maximum Codex/Claude authority, passive evidence standings, agent-initiated formal duels, domain Elo, current Telegram routing, and the shipped security boundary.
- Adds current product screenshots for the three-head room, evidence scoreboard, and formal duel/Elo panel, stored under `media/` so they render from the packaged Marketplace README.
- Aligns the local webview preview with the shipped Full Native defaults and agent-initiated duel provenance, and fixes a malformed separator in the duel origin label.
- Pins `@types/vscode` to the declared VS Code 1.120 engine baseline so `vsce package` validates the extension without narrowing its supported editor range.

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
