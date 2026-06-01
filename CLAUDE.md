# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`vscode-hydra-room` (display name "Hydra") is a VS Code extension that runs a 3-way collaboration room between the user, the OpenAI **Codex CLI**, and the Anthropic **Claude Code CLI**. Both agents are invoked as native CLI subprocesses; the extension is the orchestrator, transcript keeper, and decision-packet parser. README.md is the user-facing manual; this file is the architecture and conventions cheat sheet for editing the code.

The package id is `local-tools.vscode-hydra-room`. It is not published to the Marketplace; install locally via `pnpm run package` + `code --install-extension *.vsix`.

## Commands

```powershell
pnpm run check                    # tsc --noEmit (type-check only)
pnpm test                         # rm dist + tsc -p . + copy fixtures + node --test dist/test/*.test.js
pnpm run dev                      # open VS Code Extension Development Host with this repo as the workspace
pnpm run package                  # runs prepackage (pnpm test) then builds .vsix at repo root
pnpm run probe:native-contract    # dry-run inspection of the native Codex/Claude CLI surfaces
```

Use Corepack so `packageManager` resolves pnpm@11.1.3.

### Single-test runs

Tests compile to `dist/test/<name>.test.js`. To run one suite:

```powershell
tsc -p . && node --test dist/test/phasedSetting.test.js
```

To run one named test within a suite, use `--test-name-pattern`:

```powershell
tsc -p . && node --test --test-name-pattern "rejects malicious env-var names" dist/test/terminalProtocol.test.js
```

The project uses Node's default per-file process isolation — each test file gets its own process, which keeps the `node_modules/vscode/` stub state per-file.

### Dev host

`scripts/open-dev-host.js` opens this repo as both the extension-development path AND the dev workspace. To test the extension against a different folder, set `DEV_HOST_WORKSPACE=C:\path\to\other\repo` before `pnpm run dev`.

## Big-picture architecture

### Trust boundary

The extension code, user settings, and the workspace folder are *semi-trusted*; the spawned Codex/Claude CLI stdout is *untrusted* (LLM-controlled and prompt-injectable from repo files like `CLAUDE.md`, `AGENTS.md`); inbound Telegram messages are *untrusted*. The webview is a sibling iframe with a strict CSP (`default-src 'none'`, nonce'd + cspSource script-src) — all data flows from host → webview via `postMessage` and from webview → host via `vscode.postMessage` with a typed discriminated union (`src/webviewMessages.ts`).

### Phase state machine

`src/phases.ts` is the canonical state machine. A serialized turn is `Idle → Opener → Reactor → Closer → AwaitingUser`. A turn that addresses both agents ("both of you", "Codex and Claude…") shortcuts to `ParallelDiscussion`. After `AwaitingUser`, `assignBuilder` → `Build` → `BuildDone` → `requestReview` → `Review` → `ReviewDone` → `handBack` cycles back to Build. The parallel build/review branch (driven by the `Assign Both Builders` command) mirrors that cycle for both agents at once: `assignBuilders` → `ParallelBuild` → `ParallelBuildDone` → `requestReview` → `ParallelReview` → `ParallelReviewDone` → `handBack` (back to `ParallelBuild`). `transition()` in `src/phases.ts` is the canonical event handler; `panel.ts:applyEvent` is the only call site that uses it. `archiveAndClearRoom` is the sole place in panel.ts that assigns `this.state` directly — it wipes the room (messages, agent statuses, transcript) so modeling it as a phase event would conflate concerns; the invariant is enforced by `test/panelSourceContract.test.ts`. New phase logic must always route through `transition()`.

### Transport layer (two modes)

1. **One-shot** (`src/agents.ts:runAgent`) — `cp.spawn` the CLI with argv, pipe the prompt to stdin, collect stdout/stderr. Default and stable.
2. **Terminal bridge** (`src/terminalBridge.ts`) — writes a PowerShell dispatch script to `.hydra/dispatch/<id>.ps1` and runs it inside a visible VS Code Terminal. The CLI's reply lands in `.hydra/replies/<id>.json`; Hydra polls for it. Used when the user wants to see live agent output in a real shell.

Both transports route through `panel.ts:runAgentTransport`, which decides based on `this.transportMode()`. Per-agent CLI flag injection (`--output-last-message`, `--json`, `--output-format stream-json`, `--model`, `--effort`, etc.) lives in three free-function modules — **never re-inline these flag-injection helpers in panel.ts**:

- `src/agentArgs.ts` — cross-agent: `insertBeforeStdinDash`, `modelForPhase`/`withModelArgs`, `effortForPhase`/`withEffortArgs`
- `src/codexTransport.ts` — Codex-only: `shouldCaptureCodexLastMessage`, `withCodexLastMessageArgs`, `shouldUseCodexJson`, `withCodexJsonArgs`
- `src/claudeTransport.ts` — Claude-only: `shouldUseClaudeStreamJson`, `withClaudeStreamJsonArgs`, `shouldCreateClaudeRequestFiles`

### .hydra/ workspace state

Every per-workspace artifact lives under `.hydra/` (gitignored). Key files include: `transcript.md`, `decisions.jsonl`, `verification.jsonl`, `native-actions.jsonl`, `events.jsonl`, `agent-calls.jsonl`, `usage.jsonl`, `work-queue.jsonl` (dismiss/snooze state), `objective.md`, `session-brief.md`, `support-bundle.md`, `native-capabilities.md`, `native-data-snapshot.md`, `telegram-inbound.json` (inbound poll offset), plus subdirectories: `prompts/` (including the durable `prompts/index.jsonl` prompt-envelope log), `replies/`, `logs/`, `dispatch/`, and `sessions/` for terminal-bridge artifacts; `attachments/<turn>/` for copied room attachments; `archive/` for cleared rooms; and `wiki/` (`schema.md`, `context.md`, `index.md`, `log.md`, and immutable `raw/turns/` snapshots) for the compiled project memory. `src/fileQueue.ts` is the single source for all .hydra reads/writes — see below.

### Webview

The HTML template + CSS live in `src/webview.html.ts` (~1160 lines, mostly inline CSS). The webview script is **external**: `media/webview.js`, loaded via `webview.asWebviewUri(...)`. `HEAD_ASSETS` (the avatar URIs) is passed from host → webview via an HTML-escaped JSON `data-head-assets` attribute on `<body>`. The webview reads it defensively with try/catch.

Editing the webview script: edit `media/webview.js` directly (it's plain JS with `// @ts-check` and runs as-is, no compile step). The file ships unmodified inside the `.vsix`.

## Repeated-pattern helpers — use these instead of inlining

| Need | Helper | Module |
|---|---|---|
| Per-file write mutex (no interleaving JSONL appends) | `serializePerFile(filePath, work)` | `src/fileQueue.ts` |
| Read JSONL with type guard | `readJsonlGuarded(filePath, guard, { limit? })` | `src/fileQueue.ts` |
| Create-if-missing artifact file | `ensureFile(filePath, defaultContent?)` | `src/fileQueue.ts` |
| Crash-safe write (tmp + rename) | `atomicWriteFile(filePath, content)` | `src/fileQueue.ts` |
| Spawn a Windows `.cmd`/`.bat` via cmd.exe wrap | `spawnViaCmdShim(command, args, opts)` | `src/agents.ts` |
| `${workspaceFolder}` + `${env:NAME}` expansion in CLI args | `expandWorkspaceValue` / `expandWorkspaceArgs` | `src/cli.ts` |
| "Setting is either string or `{discussion,build,review}` object" | `phasedSettingForScope`, `applyPhasedSettingChange`, `summarizePhasedSetting`, `describePhasedSettingCurrent`, `effectivePhasedSetting` | `src/phasedSetting.ts` |

Several test files have `*SourceContract*` or similar names that source-grep the implementation files. When moving a function across modules, update the contract test's `path.join(...)` target — `test/panelSourceContract.test.ts` currently points at `src/codexTransport.ts` after the transport extraction.

## Security invariants — do NOT regress

These were locked in by the security audit in commits `cc977f9`, `40cf52a`, `4f7321b`, `5c72dc1`:

1. **`scope: "application"` settings** — `package.json` marks every setting that flows into a spawn, exec args, env, PATH, terminal startup, verify command, transcript path, webhook URL, or Telegram credential as `scope: "application"`. New settings of that kind MUST get the same treatment, AND must be added to `capabilities.untrustedWorkspaces.restrictedConfigurations` so VS Code Workspace Trust enforces it for users who haven't migrated. Doctor's `TRUST_SCOPED_SETTINGS` in `src/doctor.ts` must stay in sync — a test asserts this.
2. **Env-var key validation** — `src/terminalProtocol.ts:environmentStatements` rejects keys that aren't POSIX identifiers (`/^[A-Za-z_][A-Za-z0-9_]*$/`). A malicious workspace-supplied key like `FOO; iex 'evil'` would otherwise inject PowerShell into the generated dispatch script. Regression test in `test/terminalProtocol.test.ts`.
3. **HTTPS-only handoff webhook** — `panel.ts:fireWebhookForDecision` requires `https://`. `http://` is refused with a user-visible system message.
4. **Redaction regex** — `src/nativeDataSnapshot.ts:isSensitiveKey` matches token/password/secret/private-key/ssh-key/passphrase/signature/cookie variants. The snapshot file is workspace-local and only generated on explicit user action, but the regex should grow if new MCP servers or plugins introduce new credential field names.
5. **Permissive agent defaults are intentional** — Codex discussion/build defaults to `--sandbox workspace-write` + `network_access=true`; Claude defaults to `--permission-mode acceptEdits`. The user explicitly accepted this trade-off (see `## Security` section in README). Mitigations are documented there: Workspace Trust + the `safeDiscussion` capability profile. **Do not "fix" these defaults to be safer without an explicit user ask** — the productivity cost is real and was the deciding factor.

## Conventions

- **Comments**: project style is to write a `Why:` comment when the WHY is non-obvious (a workaround for a CVE mitigation, a subtle race, a setting that's load-bearing for some other invariant). Do NOT comment on what the code does when the names already say it.
- **Error swallowing**: when you write `catch {}`, leave a one-line comment explaining what error you're swallowing and why it's safe (e.g., `// ENOENT on first run`, `// terminal already disposed`, `// JSONL hand-edit resilience`). The codebase has many of these and every one is justified by a nearby comment — keep that ratio.
- **No new `: any`** — `panel.ts:onWebviewMessage` was the last one and it's now typed via the `WebviewMessage` discriminated union in `src/webviewMessages.ts`. New webview message types go there first.
- **`docs/native-internals/`** is the reverse-engineered spec for Codex and Claude CLI internals (wire protocols, system prompts, tool catalogs). The arg-validation logic in `src/authority.ts` cites these documents — keep the citations accurate when updating.

## Spireslap origin

This repo was seeded from `C:\Users\geral\Spireslap\tools\vscode-hydra-room` and is now the canonical working copy. The Spireslap copy is upstream-stale; do not assume it tracks this repo. There is no two-way sync.

## Common pitfalls

- **`code` CLI on Windows is `code.cmd`** — Node's CVE-2024-27980 mitigation refuses to spawn `.cmd` shims with `shell: false`. Always route through `spawnViaCmdShim` (don't reinvent the wrap, several modules already learned this the hard way).
- **`vsce` ignores `.gitignore`** — `.vscodeignore` is what controls the `.vsix` contents. Workspace-local state directories (`.claude/`, `.npm-cache/`, etc.) must be in `.vscodeignore` even when they're already in `.gitignore`, or they ship to end users.
- **Workspace path math** — `scripts/open-dev-host.js` opens the repo itself as the dev workspace because the extension IS the repo root now (legacy `<Spireslap>/tools/vscode-hydra-room` two-levels-up math was removed in commit `0fd61cd`). Override via `DEV_HOST_WORKSPACE` env var.
