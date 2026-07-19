---
name: hydra-handoff
description: Package the current CLI session into a handoff and queue it for the Hydra room (the VS Code 3-way collaboration extension). Use when the user says "hand this off to Hydra", "send this to the room", "hand off to Codex and Claude", or is wrapping up CLI work and wants the Hydra room to continue it — either as a discussion, an "ask all heads" turn, or a build assignment. Invoke as /hydra-handoff [action] [notes], where action is one of discuss, askBoth, buildCodex, buildClaude.
---

# Hydra Handoff

Write a handoff packet that the Hydra VS Code extension picks up and surfaces as a one-click confirm chip in the room. You do NOT start the room turn — the user confirms it in VS Code.

## Steps

1. **Find the workspace root.** Use the current git repository root (e.g. `git rev-parse --show-toplevel`). This is `<root>`. The packet goes under `<root>/.hydra/handoff-inbox/`.

2. **Choose the action.** If the user passed one of `discuss`, `askBoth`, `buildCodex`, `buildClaude`, use it. Otherwise infer:
   - An open design/decision question → `discuss` (serial) or `askBoth` (parallel, when you want every head to weigh in independently).
   - Concrete implementation work remaining, one clear owner → `buildCodex` or `buildClaude`.
   - Default to `discuss` when unsure.

3. **Compose the handoff prompt** as markdown with these sections (omit a section only if truly empty):
   - `## Objective` — what the room should accomplish.
   - `## Current state` — where things stand right now.
   - `## Done + verified` — what you completed and how it was checked (tests run + results).
   - `## Open questions` — decisions the room should resolve.
   - `## Suggested next steps` — concrete next actions.
   - `## Pointers` — key files, the branch, anything to read first.
   Fold any `[notes]` argument from the user into the relevant sections.

4. **Build the packet JSON.** Fields (all required unless marked optional):
   - `"version"`: `1`
   - `"createdAt"`: current UTC ISO-8601 timestamp
   - `"source"`: `"claude-code"` or `"codex"` (whichever you are)
   - `"title"`: a short one-line title (≤ 200 chars)
   - `"prompt"`: the markdown from step 3
   - `"suggestedAction"`: one of `"discuss"`, `"askBoth"`, `"buildCodex"`, `"buildClaude"`
   - `"context"` (optional): `{ "branch": "<git branch>", "filesTouched": ["<path>", ...] }` (≤ 50 files)
   Keep the packet file under 256 KB total — the extension silently quarantines oversized packets, so keep `"prompt"` reasonably concise.

5. **Write it atomically.** Create the directory, write to a `.json.tmp` file, then rename to `.json` (the extension only reads `*.json`, so this prevents it reading a half-written file). Filename: `<UTC timestamp: YYYYMMDDTHHMMSSZ>-<kebab-slug-of-title>.json`.

   Example (adjust the packet and filename):

   ```bash
   mkdir -p "<root>/.hydra/handoff-inbox"
   cat > "<root>/.hydra/handoff-inbox/20260719T183000Z-finish-refactor.json.tmp" <<'EOF'
   {
     "version": 1,
     "createdAt": "2026-07-19T18:30:00Z",
     "source": "claude-code",
     "title": "Finish JSONL compaction refactor",
     "prompt": "## Objective\n...",
     "suggestedAction": "askBoth",
     "context": { "branch": "agent/x", "filesTouched": ["src/foo.ts"] }
   }
   EOF
   node -e "const fs=require('fs');const f=process.argv[1];fs.renameSync(f,f.replace(/\.tmp$/,''))" "<root>/.hydra/handoff-inbox/20260719T183000Z-finish-refactor.json.tmp"
   ```

   Make sure `"prompt"` is valid JSON (escape newlines as `\n` and quotes as `\"`), or write the JSON with your file-writing tool instead of a heredoc.

6. **Report to the user:** the handoff is queued at `.hydra/handoff-inbox/`; opening (or focusing) the Hydra room in that workspace shows a confirm chip where they pick Confirm / Preview / Dismiss and can override the action.
