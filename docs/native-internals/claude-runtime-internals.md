# Claude Runtime Internals

Beyond the system prompt and tool catalog, the bundle exposes a number of
runtime extension surfaces that Hydra-managed environments (or any
deployment alongside Claude Code) frequently need: hook events, settings
sources, sandbox configuration, and policy registry locations.

All references below are to the extracted Bun bundle (`chunk-0366` after
reformat).

## Hook events

`TT` array (line ~24870). Twenty-eight distinct events Claude Code will
fire if a matching `hooks` entry is configured in settings:

| Phase | Events |
| --- | --- |
| Tool lifecycle | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch` |
| Permission flow | `PermissionRequest`, `PermissionDenied` |
| Session | `SessionStart`, `SessionEnd`, `Setup`, `Stop`, `StopFailure` |
| Sub-agent | `SubagentStart`, `SubagentStop` |
| Compaction | `PreCompact`, `PostCompact` |
| User input | `UserPromptSubmit`, `UserPromptExpansion`, `Elicitation`, `ElicitationResult`, `Notification` |
| Task tracking | `TaskCreated`, `TaskCompleted` |
| Workspace | `WorktreeCreate`, `WorktreeRemove`, `CwdChanged`, `FileChanged` |
| Other | `TeammateIdle`, `ConfigChange`, `InstructionsLoaded` |

Hook configuration goes in any settings source under `hooks.<EventName>`
and supports matchers, timeouts, and callback ids. Hooks emit `system /
hook_started`, `system / hook_progress`, and `system / hook_response`
stream-json envelopes that `claudeEvents.ts` already documents.

## Session-end reasons

`N5$` array (same neighborhood). The `SessionEnd` hook receives a reason:

`clear` · `resume` · `logout` · `prompt_input_exit` · `other` · `bypass_permissions_disabled`

## Permission decision reason types

`YC6` array (~line 24870). When a permission check returns a result, the
`decisionReason.type` field is one of:

`rule` · `mode` · `subcommandResults` · `permissionPromptTool` · `hook` ·
`asyncAgent` · `sandboxOverride` · `workingDir` · `safetyCheck` ·
`classifier` · `other`

These appear in `permission_denials[]` entries on the `result` envelope,
so Hydra can surface *why* an action was denied rather than just that it
was denied.

## Settings sources

`ZT` array. Five recognized sources, in precedence order from least to
most authoritative:

1. `userSettings` — `~/.claude/settings.json` (per-user)
2. `projectSettings` — `.claude/settings.json` (per-project, checked in)
3. `localSettings` — `.claude/settings.local.json` (per-project, gitignored)
4. `flagSettings` — `--settings <file-or-json>` flag at invocation time
5. `policySettings` — managed-settings (admin-controlled, see below)

`Bk` lists which sources accept rule edits programmatically:
`userSettings` · `projectSettings` · `localSettings`. `flagSettings` and
`policySettings` are read-only at runtime — Hydra cannot mutate them via
Claude's API.

`V68` lists the read-precedence order for fallback lookups:
`localSettings` · `projectSettings` · `userSettings`.

Settings JSON Schema:
<https://json.schemastore.org/claude-code-settings.json>

## Managed-settings paths

`wW()` function (~line 24870). Platform-specific roots where
admin-controlled `managed-settings.d/*.json` files are loaded:

| Platform | Path |
| --- | --- |
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.d` |
| Windows | `C:\Program Files\ClaudeCode\managed-settings.d` |
| Linux (default) | `/etc/claude-code/managed-settings.d` |

The directory is scanned for JSON files at session start. Anything in
`policySettings` wins over user/project/local sources.

## Windows policy registry

`v68` / `k68` constants. On Windows, Claude Code also reads policy values
from the registry:

- `HKLM\SOFTWARE\Policies\ClaudeCode\Settings` (machine-wide)
- `HKCU\SOFTWARE\Policies\ClaudeCode\Settings` (per-user, overrides HKLM
  only when the same key is set in both)

WSL falls back to `/mnt/c/Windows/System32/reg.exe` to read the same
registry from inside a Linux distro.

## Sandbox configuration schema highlights

Heavily decorated Zod schemas (~line 24870). The interesting knobs for
deployments:

### `sandbox.network`

- `allowedDomains: string[]` — wildcard-supported domain allowlist
- `deniedDomains: string[]` — always-blocked domains; defeats allowedDomains
- `allowManagedDomainsOnly: boolean` — when true (managed setting only),
  ignore user/project/local/flag domain rules
- `allowUnixSockets: string[]` *(macOS only; ignored on Linux because
  seccomp can't filter by path)*
- `allowAllUnixSockets: boolean` — disables Unix socket blocking entirely
- `allowMachLookup: string[]` *(macOS only)* — XPC service names with
  optional trailing wildcard
- `httpProxyPort`, `socksProxyPort` — proxy endpoints
- `allowLocalBinding: boolean`

### `sandbox.filesystem`

- `allowWrite`, `denyWrite` — paths to allow/deny writing
- `denyRead`, `allowRead` — paths to deny/re-allow reading (allowRead wins)
- `allowManagedReadPathsOnly: boolean` — managed-settings-only escape hatch
  that restricts read-rules to policySettings

### `sandbox` (top-level)

- `enabled: boolean`
- `failIfUnavailable: boolean` — exit at startup if sandbox can't start.
  Intended for managed deployments that require sandboxing as a hard gate
- `autoAllowBashIfSandboxed: boolean` — auto-approve Bash when sandboxed
- `allowUnsandboxedCommands: boolean` — controls whether
  `dangerouslyDisableSandbox` tool parameter is honored. Default: `true`
- `enableWeakerNetworkIsolation: boolean` *(macOS only)* — allow
  `com.apple.trustd.agent` so Go-based CLIs (gh, gcloud, terraform) can
  verify TLS through a MITM proxy with a custom CA. Trades security for
  compatibility
- `bwrapPath`, `socatPath` *(Linux/WSL only)* — explicit absolute paths,
  managed-settings-only
- `ripgrep: { command, args[] }` — override the bundled ripgrep
- `excludedCommands: string[]` — commands that bypass sandboxing
- `ignoreViolations: Record<string, string[]>`

## Why Hydra cares

- **Hook events**: if a Hydra user wants to react to room-relevant
  lifecycle events (`Stop`, `TaskCompleted`, `PermissionDenied`,
  `WorktreeCreate`), the hooks list above is the menu.
- **Settings sources**: Hydra writes some configuration via VS Code
  settings; co-existing with `policySettings` matters because admin-set
  policy will override Hydra's per-session intent.
- **Managed-settings paths**: a security-conscious deployment may want
  Hydra to verify that no unexpected admin policy is in force before
  raising authority (`Doctor` could grow a check for the presence of
  `managed-settings.d/`).
- **Sandbox schema**: when `--bare` is used (Hydra strips most context),
  the sandbox knobs above are the remaining behavioral surface — anyone
  troubleshooting unexpected denials should look here first.
