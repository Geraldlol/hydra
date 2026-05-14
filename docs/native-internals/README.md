# Native Internals

Reverse-engineering log for Claude Code and Codex CLI, used to align Hydra's
native-action and capability layers with the actual behavior of each agent.

## Targets

| Agent  | Binary                                                                                  | Form                              | Source         |
| ------ | --------------------------------------------------------------------------------------- | --------------------------------- | -------------- |
| Claude | `~/.local/bin/claude.exe` (226 MB, internal name "bun", v2.1.138.0)                     | Bun-compiled standalone (PE)      | closed; bundle is JS, extractable |
| Codex  | `…\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\codex\codex.exe` (v0.130.0)     | Native Rust binary                | **Apache-2.0** at github.com/openai/codex |

Codex ships three binaries: `codex.exe` (TUI/exec), `codex-command-runner.exe`
(child process for sandboxed shell execution on Windows), and
`codex-windows-sandbox-setup.exe` (sandbox bootstrap helper). It also vendors
its own `rg.exe`.

## Strategy per surface

| Surface                          | Claude approach                                                          | Codex approach                                                |
| -------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Invocation surface (flags, env)  | `--help` / subcommand `--help` dump + grep extracted bundle for switches | `--help` / subcommand `--help` + read `clap` defs in source   |
| Wire protocol (stream-json)      | Extract Bun bundle → grep for `event_type`, `tool_use`, `partial_*`      | Read source: `codex-rs/exec/src/event_processor*.rs`          |
| Tool schemas + system prompts    | Extract bundle → grep for `system_prompt`, tool-spec literals            | `codex-rs/core/src/tools/`, prompt files in `codex-cli/`      |
| Permission gates / sandbox modes | Bundle: `permission-mode` switch handler                                 | `codex-rs/core/src/exec.rs`, sandbox crates                   |
| File/network/process side effects| `nativeActions.ts` runtime trace + bundle `fs.*` / `net.*` callsites     | Source review + optional ETW/Sysmon trace                     |

## Artifacts captured

Help-surface dumps:
- `claude-help.txt`, `claude-help-<subcommand>.txt` — top-level + per-subcommand `--help` output for v2.1.138.0
- `codex-help.txt`, `codex-help-<subcommand>.txt` — same for Codex v0.130.0

Reverse-engineered specs:
- `wire-protocol.md` — Claude `stream-json` envelope: 13 outer types, 11 system subtypes, 6 SSE delta types, task-notification XML, the six permission modes
- `system-prompts.md` — Claude's three baked roots, dynamic-section flag, simple-prompt feature gate, `--bare` semantics
- `claude-tools.md` — All 28 Claude built-in tools with bundle constants and tool-annotation schema
- `claude-runtime-internals.md` — Hook events (28), settings sources hierarchy, managed-settings paths, Windows policy registry keys, sandbox config schema
- `codex-wire-protocol.md` — Codex `--json` envelope: `ThreadEvent` types, `ThreadItem` shapes (`agent_message`, `command_execution`, `apply_patch` file_change, MCP/collab tool calls, etc.), usage shape
- `codex-tools.md` — Codex built-in tools (apply_patch, shell variants, multi-agent collab, MCP, etc.), sandbox modes (read-only/workspace-write/danger-full-access), approval modes (TUI-only)
- `codex-system-prompts.md` — Codex's `BASE_INSTRUCTIONS` outline, personality wrappers, override paths, full `~/.codex/config.toml` surface

Tooling (under `.hydra/extract/`, gitignored):
- `extract-claude-bundle.js` — pulls JS chunks from `claude.exe`
- `reformat.js` — splits the minified main bundle for grep-friendly inspection

Probe scripts (under `scripts/`):
- `native-contract-probe.js` — black-box version/help/agent comparison
- `codex-json-probe.js` — runs `codex exec --json` and validates the parser
- `claude-stream-json-probe.js` — runs Claude `--output-format=stream-json`
  and validates the parser

See `probe-scripts.md` for details and `.hydra/<probe>/<timestamp>/`
artifact layouts.

## Comparison with Hydra today

Hydra currently treats both CLIs as black-boxes (see `docs/native-contract-probe.md`).
This work flips that: each section above lands a concrete spec that
`src/capabilityProfiles.ts`, `src/nativeActions.ts`, and `src/prompts.ts` can
use to stop *guessing* and start *mirroring*.
