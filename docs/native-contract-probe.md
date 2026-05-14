# Native Contract Probe

Hydra should behave as close as possible to the native Codex and Claude terminal experience. The contract probe compares supported black-box CLI behavior without inspecting proprietary internals.

## Run

Metadata only:

```powershell
npm run probe:native-contract
```

Execute harmless agent probes:

```powershell
npm run probe:native-contract:execute
```

Use a custom prompt:

```powershell
node scripts/native-contract-probe.js --execute --prompt "Inspect cwd and git status. Do not edit files. Report what tools you used."
```

Reports are written to:

```text
.hydra/native-contract-probe/<timestamp>/
```

## Artifacts

- `prompt.txt` - prompt sent to agent probes.
- `report.json` - structured probe result.
- `report.md` - readable summary.
- `<probe>.stdout.txt` / `<probe>.stderr.txt` - raw captured output.

## Compare With Hydra

Hydra writes runtime call traces to:

```text
.hydra/agent-calls.jsonl
.hydra/prompts/index.jsonl
```

Use the prompt SHA-256 and command/args fields to compare a direct probe against the exact Hydra call path. The most useful differences are usually:

- command and args
- permission or sandbox mode
- one-shot vs terminal bridge transport
- prompt size and context window
- timeout/cancellation behavior
- stdout/stderr shape
- whether the CLI performed tools or only replied with planning text
