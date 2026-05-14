# System Prompts — Claude Code

Three canonical root prompts are baked into the bundle. The CLI picks one of
them depending on how it was invoked, and Hydra needs to know which it will get
so its own `--append-system-prompt` doesn't fight the default.

## The three roots

| Variant constant | When it applies | Text |
| --- | --- | --- |
| `G8q` (default CLI) | Interactive `claude` and `claude --print` invocations | `You are Claude Code, Anthropic's official CLI for Claude.` |
| `a2K` (SDK-CLI hybrid) | When Claude Code is running inside an Agent SDK harness | `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.` |
| `s2K` (pure SDK)       | When the binary is being used as a generic Agent SDK runtime, not as Claude Code | `You are a Claude agent, built on Anthropic's Claude Agent SDK.` |

Bundle reference: identifiers `G8q`, `a2K`, `s2K` near the `XG1=[G8q, a2K, s2K]` array (≈line 105972 of `chunk-0366` after reformat). The set `ec8 = new Set(XG1)` is used to detect "is this a stock root prompt?" before deciding whether to append additional sections.

## Dynamic sections appended to the root

The default system prompt is composed: root + dynamic sections. With
`--exclude-dynamic-system-prompt-sections`, those sections are moved into the
first user message instead of the system prompt — improving prompt-cache reuse
across machines (see help text for the flag).

This flag only applies when the **default** system prompt is in use. If
`--system-prompt` is passed, the flag is ignored.

### The env block (in-system-prompt variant)

Bundle reference: function `MNA` at line ~346740 in `chunk-0366` after
reformat. This is the literal template Claude assembles before the env
block goes into the system prompt:

```
Here is useful information about the environment you are running in:
<env>
Working directory: <cwd>
Is directory a git repo: <Yes|No>
Additional working directories: <comma-joined --add-dir>     (only if any)
Platform: <process.platform>
<shell line>                                                  (Gpq())
OS Version: <os.release()>
</env>
You are powered by the model named <pretty>. The exact model ID is <id>.   (or "You are powered by the model <id>." when no pretty name)
Assistant knowledge cutoff is <cutoff>.                       (only if known)
```

### The Environment block (user-message variant)

Function `ONA` at line ~346769. When `--exclude-dynamic-system-prompt-sections`
is set, the env info is rendered as a more elaborate Markdown block injected
into the first user message:

```
# Environment
You have been invoked in the following environment:
 - Primary working directory: <cwd>
 - This is a git worktree — an isolated copy of the repository. ...   (only if worktree)
 - Is a git repository: <true|false>
 - Additional working directories:                                    (only if --add-dir)
   ...
 - Platform: <process.platform>
 - <shell line>
 - OS Version: <os.release()>
 - You are powered by the model named <pretty>. The exact model ID is <id>.
 - Assistant knowledge cutoff is <cutoff>.                            (only if known)
 - The most recent Claude model family is Claude 4.X. Model IDs — Opus 4.7: 'claude-opus-4-7', Sonnet 4.6: 'claude-sonnet-4-6', Haiku 4.5: 'claude-haiku-4-5-20251001'. When building AI applications, default to the latest and most capable Claude models.
 - Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code), and IDE extensions (VS Code, JetBrains).
 - Fast mode for Claude Code uses Claude <fast-model> with faster output (it does not downgrade to a smaller model). It can be toggled with /fast and is only available on <fast-model>.
```

### Git status section

Bundle reference: line ~132143. When the cwd is a git repo, Claude appends a
git-status block (truncated to 2000 chars) with this exact framing:

```
This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.
Current branch: <branch>
Main branch (you will usually use this for PRs): <main-branch>
Git user: <user>                       (only when configured)
Status:
<porcelain output, or "(clean)" when empty>
Recent commits:
<git log --oneline -10 output>
```

Past 2000 chars the body is replaced with: `... (truncated because it exceeds 2k characters. If you need more information, run "git status" using <Bash>)`.

## Append vs. replace

Two CLI flags interact with the system prompt:

- `--system-prompt <prompt>` — replaces the entire root + dynamic sections.
  When set, the bundle skips the `excludeDynamicSections` branch entirely.
- `--append-system-prompt <prompt>` — appended **after** the dynamic sections.
  Safe to combine with the default root.

Hydra's `prompts.ts` should prefer append-only and never replace, otherwise we
lose the tool descriptions and memory wiring baked into the dynamic sections.

## "Simple system prompt" mode (Velvet Cascade gate)

The bundle has a feature flag (`tengu_velvet_cascade`) that, when on, activates
a much shorter system prompt and shorter tool descriptions. The decision
function is `IY` / `UG1`:

```
isSimple = model is claude-opus-4-7
        || env CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT is truthy
        || tengu_velvet_cascade.models contains substring of current model
        || clientDataCache.simple_system_prompt has model:true
        || tengu_vellum_lantern feature flag
```

When `IY` is true, several tool descriptions emit a *short* variant. Example
captured for `Grep`:

> Content search built on ripgrep. Prefer this over `grep`/`rg` via Bash —
> results integrate with the permission UI and file links.
>
> - Full regex syntax (e.g. "log.*Error", "function\s+\w+"). Ripgrep, not
>   grep — escape literal braces (`interface\{\}`).
> - Filter with `glob` (e.g. "**/*.tsx") or `type` (e.g. "js", "py", "rust").
> - `output_mode`: "content" (matching lines), "files_with_matches" (paths
>   only, default), or "count".
> - `multiline: true` for patterns that span lines.

Versus the standard description (~3× longer). For Hydra, the practical effect
is that prompt size — and therefore token count of the system prompt — depends
on the resolved model. Hydra's prompt-size estimator should branch on this.

## `--bare` mode

The `--bare` flag is the strictest minimal mode: it skips hooks, LSP, plugin
sync, attribution, auto-memory, background prefetches, keychain reads, and
`CLAUDE.md` auto-discovery, and sets `CLAUDE_CODE_SIMPLE=1`. Auth is forced to
`ANTHROPIC_API_KEY` or `apiKeyHelper`; OAuth and keychain are *not* read.

Skills still resolve via `/skill-name` slash commands, so Hydra's slash-command
surface continues to work in `--bare`. Anything Hydra wants in context must be
provided explicitly via `--system-prompt`/`--append-system-prompt` (and their
`-file` variants), `--add-dir`, `--mcp-config`, `--settings`, `--agents`, or
`--plugin-dir`.
