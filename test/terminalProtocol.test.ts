import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as path from "node:path";
import {
  buildPowerShellDispatchCommand,
  buildPowerShellDispatchInvocation,
  buildTerminalReadyCommand,
  buildTerminalStartupProbeCommand,
  buildTerminalPromptFile,
  expandTerminalCommand,
  HYDRA_SYNTHETIC_ECHO_COMMAND,
  parseTerminalReply,
  quotePowerShell,
  terminalProtocolPaths,
} from "../src/terminalProtocol";

describe("terminal bridge protocol", () => {
  test("expands workspace placeholders in terminal commands", () => {
    assert.equal(
      expandTerminalCommand('codex --cd "${workspaceFolder}"', "C:\\repo with spaces"),
      'codex --cd "C:\\repo with spaces"'
    );
  });

  test("builds prompt and reply paths under .hydra", () => {
    const paths = terminalProtocolPaths("C:\\repo", "turn:1", "codex", "opener");
    assert.equal(paths.promptPath, path.join("C:\\repo", ".hydra", "prompts", "turn-1-codex-opener.md"));
    assert.equal(paths.replyPath, path.join("C:\\repo", ".hydra", "replies", "turn-1-codex-opener.json"));
    assert.equal(paths.logPath, path.join("C:\\repo", ".hydra", "logs", "turn-1-codex-opener.log"));
    assert.equal(paths.dispatchPath, path.join("C:\\repo", ".hydra", "dispatch", "turn-1-codex-opener.ps1"));
  });

  test("quotes PowerShell literals", () => {
    assert.equal(quotePowerShell("C:\\it's\\fine"), "'C:\\it''s\\fine'");
  });

  test("dispatch command runs native CLI and writes JSON reply", () => {
    const out = buildPowerShellDispatchCommand(
      {
        command: "codex",
        args: ["exec", "--sandbox", "read-only", "--cd", "C:\\repo", "-"],
        cwd: "C:\\repo",
      },
      "C:\\repo\\.hydra\\prompts\\p.md",
      "C:\\repo\\.hydra\\replies\\r.json",
      "C:\\repo\\.hydra\\logs\\r.log"
    );
    assert.match(out, /\$__hydraCommandName = 'codex'/);
    assert.match(out, /openai\.chatgpt-\*\\bin\\windows-x86_64\\codex\.exe/);
    assert.match(out, /OpenAI\\Codex\\bin\\codex\.exe/);
    assert.match(out, /OpenAI\.Codex_\*\\LocalCache\\Local\\OpenAI\\Codex\\bin\\codex\.exe/);
    assert.match(out, /\$__hydraArgs = @\('exec', '--sandbox', 'read-only'/);
    assert.match(out, /\[System\.IO\.Directory\]::CreateDirectory\(\$__hydraReplyDir\)/);
    assert.match(out, /\[System\.IO\.Directory\]::CreateDirectory\(\$__hydraLogDir\)/);
    assert.match(out, /\$__hydraLastMessage = \[System\.IO\.Path\]::ChangeExtension\(\$__hydraReply, '.last.txt'\)/);
    assert.match(out, /Remove-Item -LiteralPath \$__hydraLastMessage -Force -ErrorAction SilentlyContinue/);
    assert.match(out, /\$__hydraUtf8NoBom = \[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
    assert.match(out, /\$OutputEncoding = \$__hydraUtf8NoBom/);
    assert.match(out, /\[Console\]::OutputEncoding = \$__hydraUtf8NoBom/);
    assert.match(out, /function __HydraObjectText/);
    assert.match(out, /FullyQualifiedErrorId -eq 'NativeCommandError'/);
    assert.match(out, /WriteAllText\(\$__hydraLog, '', \$__hydraUtf8NoBom\)/);
    assert.match(out, /AppendAllText\(\$__hydraLog, \$__hydraChunk/);
    assert.match(out, /Native output is tee'd to this terminal and the request log/);
    assert.match(out, /Write-Host -NoNewline \$__hydraChunk/);
    assert.match(out, /Reply captured/);
    assert.match(out, /\$__hydraPromptText = \[System\.IO\.File\]::ReadAllText\(\$__hydraPrompt\)/);
    assert.match(out, /\$__hydraCommandLeaf = \[System\.IO\.Path\]::GetFileNameWithoutExtension\(\$__hydraCommand\)\.ToLowerInvariant\(\)/);
    assert.match(out, /\$__hydraList = \[System\.Collections\.Generic\.List\[string\]\]::new\(\)/);
    assert.match(out, /\$__hydraDashIndex = \$__hydraList\.LastIndexOf\('-'\)/);
    assert.match(out, /\$__hydraList\.Insert\(\$__hydraDashIndex, '--output-last-message'\)/);
    assert.match(out, /\$__hydraArgs = \$__hydraList\.ToArray\(\)/);
    assert.doesNotMatch(out, /-contains '-o'/);
    assert.match(out, /\$ErrorActionPreference = 'Continue'/);
    assert.match(out, /\$__hydraPromptText \| & \$__hydraCommand @__hydraArgs 2>&1 \| ForEach-Object/);
    assert.match(out, /\$__hydraChunk = __HydraObjectText \$_/);
    assert.match(out, /finally \{ \$ErrorActionPreference = \$__hydraOldErrorActionPreference \}/);
    assert.match(out, /\$__hydraLastMessageText = ''/);
    assert.match(out, /ReadAllText\(\$__hydraLastMessage, \$__hydraUtf8NoBom\)\.TrimEnd\(\)/);
    assert.match(out, /catch \{ \$__hydraText = \(__HydraObjectText \$_\)\.TrimEnd\(\); \[System\.IO\.File\]::AppendAllText\(\$__hydraLog, \$__hydraText/);
    assert.match(out, /Write-Host -NoNewline \$__hydraText/);
    assert.match(out, /ConvertTo-Json -Compress/);
    assert.match(out, /WriteAllText\(\$__hydraReply, \$__hydraReplyJson, \$__hydraUtf8NoBom\)/);
    assert.doesNotMatch(out, /-Encoding UTF8/);
    assert.doesNotMatch(out, /\[System\.Text\.Encoding\]::UTF8/);
    assert.doesNotMatch(out, /ForEach-Object \{ \$__hydraChunk = \(\$_ \| Out-String\)/);
    assert.doesNotMatch(out, /^Hydra Room request/);
  });

  test("dispatch command receives already-expanded Hydra request files", () => {
    const out = buildPowerShellDispatchCommand(
      {
        command: "claude",
        args: ["-p", "--file", "C:\\repo\\.hydra\\prompts\\p.md", "--json-schema", "C:\\repo\\.hydra\\replies\\r.json"],
        cwd: "C:\\repo",
      },
      "C:\\repo\\.hydra\\prompts\\p.md",
      "C:\\repo\\.hydra\\replies\\r.json",
      "C:\\repo\\.hydra\\logs\\r.log"
    );
    assert.match(out, /'--file', 'C:\\repo\\.hydra\\prompts\\p.md'/);
    assert.match(out, /'--json-schema', 'C:\\repo\\.hydra\\replies\\r.json'/);
    assert.doesNotMatch(out, /\$\{hydraPromptFile\}/);
    assert.doesNotMatch(out, /\$\{hydraReplyFile\}/);
  });

  test("dispatch command applies spawn environment before native invocation", () => {
    const out = buildPowerShellDispatchCommand(
      {
        command: "codex",
        args: ["exec", "-"],
        cwd: "C:\\repo",
        env: { Path: "C:\\Tools;C:\\Windows", DOTNET_ROOT: "C:\\Users\\me\\.dotnet" },
      },
      "C:\\repo\\.hydra\\prompts\\p.md",
      "C:\\repo\\.hydra\\replies\\r.json",
      "C:\\repo\\.hydra\\logs\\r.log"
    );
    assert.match(out, /\$env:Path = 'C:\\Tools;C:\\Windows'/);
    assert.match(out, /\$env:DOTNET_ROOT = 'C:\\Users\\me\\.dotnet'/);
    assert.match(out, /\$env:DOTNET_ROOT = .*;\s*\$ErrorActionPreference = 'Stop'/);
  });

  test("dispatch command rejects malicious env-var names that would break out of the $env:KEY = '...' statement", () => {
    const out = buildPowerShellDispatchCommand(
      {
        command: "codex",
        args: ["exec", "-"],
        cwd: "C:\\repo",
        env: {
          GOOD_VAR: "ok",
          "BAD; iex 'Write-Host PWNED'; #": "x",
          "1STARTS_WITH_DIGIT": "x",
          "HAS-DASH": "x",
          "": "x",
          "HAS SPACE": "x",
        },
      },
      "C:\\repo\\.hydra\\prompts\\p.md",
      "C:\\repo\\.hydra\\replies\\r.json",
      "C:\\repo\\.hydra\\logs\\r.log"
    );
    assert.match(out, /\$env:GOOD_VAR = 'ok'/);
    assert.doesNotMatch(out, /iex/);
    assert.doesNotMatch(out, /PWNED/);
    assert.doesNotMatch(out, /\$env:1STARTS_WITH_DIGIT/);
    assert.doesNotMatch(out, /HAS-DASH/);
    assert.doesNotMatch(out, /HAS SPACE/);
  });

  test("dispatch command supports terminal bridge synthetic echo without external node", () => {
    const out = buildPowerShellDispatchCommand(
      {
        command: HYDRA_SYNTHETIC_ECHO_COMMAND,
        args: ["hydra-terminal-bridge-self-test"],
        cwd: "C:\\repo",
      },
      "C:\\repo\\.hydra\\prompts\\p.md",
      "C:\\repo\\.hydra\\replies\\r.json",
      "C:\\repo\\.hydra\\logs\\r.log"
    );
    assert.match(out, /__hydra_echo__/);
    assert.match(out, /Running terminal bridge synthetic echo/);
    assert.match(out, /AppendAllText\(\$__hydraLog, \$__hydraText/);
    assert.doesNotMatch(out, /process\.execPath/);
    assert.doesNotMatch(out, /Code\.exe/);
  });

  test("dispatch command keeps structured JSON streams in the log instead of teeing raw events to the terminal", () => {
    const out = buildPowerShellDispatchCommand(
      {
        command: "claude",
        args: ["-p", "--output-format", "stream-json", "--verbose"],
        cwd: "C:\\repo",
      },
      "C:\\repo\\.hydra\\prompts\\p.md",
      "C:\\repo\\.hydra\\replies\\r.json",
      "C:\\repo\\.hydra\\logs\\r.log"
    );
    assert.match(out, /\$__hydraStructuredOutput = /);
    assert.match(out, /Structured native events are captured in the request log/);
    assert.match(out, /AppendAllText\(\$__hydraLog, \$__hydraChunk/);
    assert.match(out, /if \(-not \$__hydraStructuredOutput\) \{ Write-Host -NoNewline \$__hydraChunk \}/);
  });

  test("dispatch command keeps known fallbacks for extension-suffixed agent commands", () => {
    const codex = buildPowerShellDispatchCommand(
      {
        command: "codex.cmd",
        args: ["exec", "--sandbox", "read-only", "-"],
        cwd: "C:\\repo",
      },
      "C:\\repo\\.hydra\\prompts\\p.md",
      "C:\\repo\\.hydra\\replies\\r.json",
      "C:\\repo\\.hydra\\logs\\r.log"
    );
    assert.match(codex, /openai\.chatgpt-\*\\bin\\windows-x86_64\\codex\.exe/);
    assert.match(codex, /OpenAI\\Codex\\bin\\codex\.exe/);
    assert.match(codex, /npm\\codex\.cmd/);

    const claude = buildPowerShellDispatchCommand(
      {
        command: "claude.exe",
        args: ["-p", "--permission-mode", "plan"],
        cwd: "C:\\repo",
      },
      "C:\\repo\\.hydra\\prompts\\p.md",
      "C:\\repo\\.hydra\\replies\\r.json",
      "C:\\repo\\.hydra\\logs\\r.log"
    );
    assert.match(claude, /local\\bin\\claude\.exe/);
    assert.match(claude, /npm\\claude\.cmd/);
  });

  test("dispatch invocation keeps terminal input short", () => {
    const out = buildPowerShellDispatchInvocation("C:\\repo\\.hydra\\dispatch\\turn-1-codex-opener.ps1");
    assert.equal(
      out,
      "\r\n; Invoke-Expression (Get-Content -LiteralPath 'C:\\repo\\.hydra\\dispatch\\turn-1-codex-opener.ps1' -Raw)"
    );
    assert.doesNotMatch(out, /__HydraResolveCommand/);
    assert.doesNotMatch(out, /__hydraPrompt/);
  });

  test("dispatch invocation begins with a statement separator so back-to-back sendText calls parse cleanly even if the previous newline is dropped", () => {
    const a = buildPowerShellDispatchInvocation("C:\\repo\\.hydra\\dispatch\\turn-1-codex-build.ps1");
    const b = buildPowerShellDispatchInvocation("C:\\repo\\.hydra\\dispatch\\turn-2-codex-opener.ps1");
    // Worst case: the pty drops the newline between two sendText calls. The
    // result must still tokenize as two separate Invoke-Expression statements,
    // not a single call where the second IE is read as a positional arg.
    const concatenated = a + b;
    assert.match(concatenated, /\)\r\n; Invoke-Expression /);
  });

  test("prompt file contains original prompt and reply path", () => {
    const out = buildTerminalPromptFile("codex", "build", "Do the work.", "C:\\repo\\.hydra\\replies\\r.json");
    assert.match(out, /Hydra terminal request for codex \(build\)/);
    assert.match(out, /Hydra will capture stdout and write the structured room reply to: C:\\repo\\.hydra\\replies\\r.json/);
    assert.match(out, /--- Hydra prompt ---\nDo the work\./);
  });

  test("ready command explains terminal dispatch mode", () => {
    const out = buildTerminalReadyCommand("codex", "C:\\repo");
    assert.match(out, /\[Hydra\] Codex terminal ready\./);
    assert.match(out, /Dispatch mode: leave this shell open/);
    assert.match(out, /short request launchers/);
    assert.match(out, /Workspace: C:\\repo/);
  });

  test("startup probe command writes a ready marker after the ready banner", () => {
    const out = buildTerminalStartupProbeCommand("claude", "C:\\repo", "C:\\repo\\.hydra\\sessions\\claude.ready");
    assert.match(out, /\[Hydra\] Claude terminal ready\./);
    assert.match(out, /\[System\.IO\.Directory\]::CreateDirectory\(\$__hydraStartupProbeDir\)/);
    assert.match(out, /\$__hydraStartupProbe = 'C:\\repo\\.hydra\\sessions\\claude.ready'/);
    assert.match(out, /WriteAllText\(\$__hydraStartupProbe, 'ready', \$__hydraUtf8NoBom\)/);
    assert.doesNotMatch(out, /-Encoding UTF8/);
  });

  test("parses terminal replies", () => {
    assert.deepEqual(parseTerminalReply('{"text":"done"}'), { text: "done", error: undefined });
    assert.deepEqual(parseTerminalReply('\uFEFF{"text":"done"}'), { text: "done", error: undefined });
    assert.deepEqual(parseTerminalReply('{"text":"","error":"failed"}'), { text: "", error: "failed" });
    assert.throws(() => parseTerminalReply("{}"), /must include/);
  });
});
