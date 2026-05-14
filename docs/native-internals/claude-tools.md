# Claude Code Built-in Tools

Catalog of every built-in tool name found in the Claude Code v2.1.138 bundle,
the constant Bun chose for its identifier (so we can find it again after the
next minifier reroll), and what each tool is. Tools are grouped by capability.

The tool surface is gated by **"simple system prompt" mode** (see
`system-prompts.md`). Many tools have two description variants — a long form
and a short form returned by helper functions like `h8q(H)` (for `Grep`).
The short form fires when `IY(model)` is true (model is `claude-opus-4-7`,
or the `tengu_velvet_cascade` / `tengu_vellum_lantern` flags are on, or
`CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=1`). Hydra should ask the bundle which
variant is in play before sizing prompts.

## File and shell tools

| Name             | Bundle const | Notes |
| ---------------- | ------------ | ----- |
| `Bash`           | `k$`         | Long-running shell; supports `BashOutput` and `KillBash` follow-ups (these are Bash subcommands, not separate tools). |
| `Read`           | `HK`         | File read; covers regular files, images, PDFs, Jupyter notebooks. NotebookRead is folded in. |
| `Write`          | `r_`         | New-file or overwrite (requires prior `Read` for existing paths). |
| `Edit`           | `T7`         | Exact-string find/replace; preferred over `Write` for existing files. |
| `NotebookEdit`   | `bX`         | `.ipynb` cell edit/insert/delete. |
| `Glob`           | `S1`         | Filename pattern match. |
| `Grep`           | `J4`         | ripgrep wrapper. **Has two description variants** (long + short). |

## Web tools

| Name        | Bundle const | Notes |
| ----------- | ------------ | ----- |
| `WebFetch`  | `Lw`         | Fetch a URL and summarize/extract via prompt. |
| `WebSearch` | `Ny`         | Search the web (US-only at the time of v2.1.138). |

## Planning, todos, agent dispatch

| Name              | Bundle const  | Notes |
| ----------------- | ------------- | ----- |
| `Task` / `Agent`  | `Bx` / `_7`   | Same tool, two visible names. Code path: `H!=="Agent"&&H!=="Task"` filter. Dispatches a sub-agent run. |
| `TodoWrite`       | `TI`          | In-session todo list (the "I'll track this with TodoWrite" tool). |
| `EnterPlanMode`   | `AYH`         | Switch to plan mode (no edits until exit). |
| `ExitPlanMode`    | `BJ` / `UJ`   | Two const aliases for the same tool name. |
| `Skill`           | `CP`          | Invoke a registered skill (slash-command surface). |
| `SlashCommand`    | (not bound to a `var`; referenced as the `"SlashCommand"` literal) | Generic slash-command dispatch. |

## User comms

| Name                | Bundle const | Notes |
| ------------------- | ------------ | ----- |
| `AskUserQuestion`   | `O5`         | Multi-question / multi-option / preview-rendered prompt. Max 12 options? (constant `smK=12`.) |
| `SendUserMessage`   | `U$H`        | Bundle-internal name `BRIEF_TOOL_NAME`; **legacy alias** `Brief` (`Q1q`). Active only with `--brief`. |
| `PushNotification`  | `da`         | Terminal notification + Remote Control mobile push. Gated by `tengu_kairos_push_notifications` and `agentPushNotifEnabled`. |

## Long-running orchestration

| Name             | Bundle const | Notes |
| ---------------- | ------------ | ----- |
| `Monitor`        | `_L`         | Stream events from a long-running script. Gated by `tengu_amber_sentinel`. |
| `ScheduleWakeup` | `vj`         | Self-pace re-entry for `/loop` dynamic mode. |
| `CronCreate`     | `cX`         | Schedule a recurring job (durable in `.claude/scheduled_tasks.json` if `H` truthy, else session). |
| `CronDelete`     | `pN`         | Cancel by ID. Description literal: `a1q="Cancel a scheduled cron job by ID"`. |
| `CronList`       | `y0H`        | List scheduled jobs. Description literal: `t1q="List scheduled cron jobs"`. |

## Worktrees

| Name           | Bundle const | Notes |
| -------------- | ------------ | ----- |
| `EnterWorktree`| `qBH`        | Create / switch into a worktree. |
| `ExitWorktree` | `qs8`        | Leave back to the host workspace. |

## Task primitives (TaskCreate family)

These mirror the harness's TaskCreate/Update/etc. surface and are visible to
the model so it can self-checklist:

| Name         | Bundle const |
| ------------ | ------------ |
| `TaskCreate` | `mN`         |
| `TaskUpdate` | `Ey`         |
| `TaskGet`    | `la`         |
| `TaskList`   | `eG`         |
| `TaskOutput` | `bc`         |
| `TaskStop`   | `wu`         |

## MCP and remote orchestration

| Name                    | Bundle const | Notes |
| ----------------------- | ------------ | ----- |
| `ListMcpResourcesTool`  | `ezH`        | List resources exposed by a connected MCP server. |
| `ReadMcpResourceTool`   | `a16`        | Read a single resource by name from a connected MCP server. |
| `WaitForMcpServers`     | `YYH`        | Block until specified (or all) MCP servers are connected. |
| `ToolSearch`            | `yz`         | Discover deferred tools by keyword + load their schemas. |
| `RemoteTrigger`         | `_vH`        | Remote-control bridge trigger. |
| `ShareOnboardingGuide`  | `_P8`        | Upload local ONBOARDING.md → org-shared guide; returns a short-code link. |

## Tool annotations (from MCP-style metadata)

The bundle exposes `LG1` as the default tool descriptor; tools override these
by spreading `LG1` and overriding individual fields. The annotation surface:

| Field              | Default | Meaning                                                      |
| ------------------ | ------- | ------------------------------------------------------------ |
| `isEnabled`        | `true`  | Whether the tool is callable in the current run              |
| `isConcurrencySafe`| `false` | Safe to call in parallel with other tool calls (parser hint) |
| `isReadOnly`       | `false` | Promises no side effects (safe under stricter permissions)   |
| `isDestructive`    | `false` | Should require explicit confirmation under `default` mode    |
| `isOpenWorld`      | `false` | Reaches out to the network (vs. local-only)                  |
| `checkPermissions` | allow   | Per-call gate; can return `{ behavior: "allow", updatedInput }` or deny |
| `toAutoClassifierInput` | `""` | Used by the auto-mode classifier feature                  |
| `userFacingName`   | `""`    | Pretty name for permission UI                                |

`MCP server reports` from the bundle (`F8` function) include these annotations
*per server tool*, not per built-in tool — but the same flags are surfaced.

## Notes for Hydra

- The constants above (`k$`, `J4`, `T7`, …) are minifier output — **they will
  rename on every Bun rebuild**. Match by string literal value
  (`"Bash"`, `"Edit"`, …), never by const name.
- `BashOutput` and `KillBash` are *not* separate top-level tools; they're
  Bash subcommands surfaced through the same tool name.
- `NotebookRead` is folded into `Read` — passing a `.ipynb` path returns
  cells + outputs.
- `Task` and `Agent` are interchangeable in the matcher; treat as one tool.
- `--allowedTools` accepts `"<Tool>(<filter>)"` shapes for `Bash` and `Edit`
  (e.g. `"Bash(git *) Edit"`). The grammar lives in the same handler that
  builds `Y8` / `XH` — search for `A1(` (alias matcher) in the bundle.
