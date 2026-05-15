import * as path from "node:path";
import type { AgentSpawn } from "./agents";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";

export interface TerminalProtocolPaths {
  promptPath: string;
  replyPath: string;
  logPath: string;
  dispatchPath: string;
}

export interface TerminalReply {
  text: string;
  error?: string;
}

export const HYDRA_SYNTHETIC_ECHO_COMMAND = "__hydra_echo__";

export function expandTerminalCommand(command: string, workspaceRoot: string): string {
  return command.replace(/\$\{workspaceFolder\}/g, workspaceRoot);
}

export function terminalProtocolPaths(
  workspaceRoot: string,
  requestId: string,
  agent: AgentId,
  phase: Phase
): TerminalProtocolPaths {
  const safeId = requestId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const base = `${safeId}-${agent}-${phase}`;
  return {
    promptPath: path.join(workspaceRoot, ".hydra", "prompts", `${base}.md`),
    replyPath: path.join(workspaceRoot, ".hydra", "replies", `${base}.json`),
    logPath: path.join(workspaceRoot, ".hydra", "logs", `${base}.log`),
    dispatchPath: path.join(workspaceRoot, ".hydra", "dispatch", `${base}.ps1`),
  };
}

export function buildTerminalPromptFile(agent: AgentId, phase: Phase, prompt: string, replyPath: string): string {
  return [
    `# Hydra terminal request for ${agent} (${phase})`,
    "",
    "Hydra is dispatching this prompt through your native CLI in a visible terminal.",
    `Hydra will capture stdout and write the structured room reply to: ${replyPath}`,
    "",
    "--- Hydra prompt ---",
    prompt,
  ].join("\n");
}

export function buildTerminalReadyCommand(agent: AgentId, workspaceRoot: string): string {
  const label = agent === "codex" ? "Codex" : "Claude";
  return [
    `Write-Host ${quotePowerShell(`[Hydra] ${label} terminal ready.`)} -ForegroundColor Cyan`,
    `Write-Host ${quotePowerShell("[Hydra] Dispatch mode: leave this shell open; Hydra will paste short request launchers here.")}`,
    `Write-Host ${quotePowerShell(`[Hydra] Workspace: ${workspaceRoot}`)}`,
    `Write-Host ${quotePowerShell("[Hydra] Use the Hydra Room composer to talk to the agents.")}`,
  ].join("; ");
}

export function buildPowerShellDispatchCommand(
  spawn: AgentSpawn,
  promptPath: string,
  replyPath: string,
  logPath: string
): string {
  const argArray = spawn.args.length > 0 ? `@(${spawn.args.map(quotePowerShell).join(", ")})` : "@()";
  return [
    `$__hydraPrompt = ${quotePowerShell(promptPath)}`,
    `$__hydraReply = ${quotePowerShell(replyPath)}`,
    `$__hydraLog = ${quotePowerShell(logPath)}`,
    `$__hydraCommandName = ${quotePowerShell(spawn.command)}`,
    `$__hydraArgs = ${argArray}`,
    "$__hydraCandidates = @()",
    ...knownCommandCandidateStatements(spawn.command),
    ...environmentStatements(spawn.env ?? {}),
    "$ErrorActionPreference = 'Stop'",
    "$__hydraCode = 0",
    "$__hydraReplyDir = Split-Path -Parent $__hydraReply",
    "if ($__hydraReplyDir) { New-Item -ItemType Directory -Path $__hydraReplyDir -Force | Out-Null }",
    "$__hydraLastMessage = [System.IO.Path]::ChangeExtension($__hydraReply, '.last.txt')",
    "Remove-Item -LiteralPath $__hydraLastMessage -Force -ErrorAction SilentlyContinue",
    "$__hydraLogDir = Split-Path -Parent $__hydraLog",
    "if ($__hydraLogDir) { New-Item -ItemType Directory -Path $__hydraLogDir -Force | Out-Null }",
    "$__hydraUtf8NoBom = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = $__hydraUtf8NoBom",
    "try { [Console]::OutputEncoding = $__hydraUtf8NoBom } catch {}",
    "[System.IO.File]::WriteAllText($__hydraLog, '', $__hydraUtf8NoBom)",
    "function __HydraObjectText { param($Value) if ($Value -is [System.Management.Automation.ErrorRecord] -and $Value.FullyQualifiedErrorId -eq 'NativeCommandError') { return ([string]$Value.Exception.Message).TrimEnd() + [Environment]::NewLine } return ($Value | Out-String) }",
    "function __HydraResolveCommand { param([string]$Name, [string[]]$Candidates) if ([System.IO.Path]::IsPathRooted($Name) -or $Name.Contains('\\\\') -or $Name.Contains('/')) { if (Test-Path -LiteralPath $Name) { return (Resolve-Path -LiteralPath $Name).Path }; throw \"Hydra could not find native CLI '$Name'. Set the Hydra command setting to a full path or switch to Safe One-Shot.\" } $cmd = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue; if ($cmd) { return $cmd.Source } foreach ($candidate in $Candidates) { $matches = @(Get-Item -Path $candidate -ErrorAction SilentlyContinue | Sort-Object FullName -Descending); if ($matches.Count -gt 0) { return $matches[0].FullName } } throw \"Hydra could not find native CLI '$Name'. Set the Hydra command setting to a full path or switch to Safe One-Shot.\" }",
    `try { if ($__hydraCommandName -eq ${quotePowerShell(HYDRA_SYNTHETIC_ECHO_COMMAND)}) { Write-Host "[Hydra] Running terminal bridge synthetic echo..." -ForegroundColor DarkGray; $__hydraText = if ($__hydraArgs.Count -gt 0) { [string]$__hydraArgs[0] } else { 'ok' }; [System.IO.File]::AppendAllText($__hydraLog, $__hydraText, $__hydraUtf8NoBom); Write-Host -NoNewline $__hydraText; $__hydraCode = 0 } else { $__hydraCommand = __HydraResolveCommand $__hydraCommandName $__hydraCandidates; $__hydraCommandLeaf = [System.IO.Path]::GetFileNameWithoutExtension($__hydraCommand).ToLowerInvariant(); if ($__hydraCommandLeaf -eq 'codex' -and $__hydraArgs.Count -gt 0 -and [string]$__hydraArgs[0] -eq 'exec' -and -not ($__hydraArgs -contains '--output-last-message')) { $__hydraList = [System.Collections.Generic.List[string]]::new(); foreach ($__hydraArg in $__hydraArgs) { [void]$__hydraList.Add([string]$__hydraArg) }; $__hydraDashIndex = $__hydraList.LastIndexOf('-'); if ($__hydraDashIndex -ge 0) { $__hydraList.Insert($__hydraDashIndex, $__hydraLastMessage); $__hydraList.Insert($__hydraDashIndex, '--output-last-message'); $__hydraArgs = $__hydraList.ToArray() } else { $__hydraArgs += @('--output-last-message', $__hydraLastMessage) } }; Write-Host "[Hydra] Dispatching $__hydraCommandName via terminal bridge..." -ForegroundColor DarkGray; Write-Host "[Hydra] Raw native output is captured in the request log, not echoed into this terminal." -ForegroundColor DarkGray; $__hydraText = ''; $__hydraPromptText = [System.IO.File]::ReadAllText($__hydraPrompt); $__hydraOldErrorActionPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { $__hydraPromptText | & $__hydraCommand @__hydraArgs 2>&1 | ForEach-Object { $__hydraChunk = __HydraObjectText $_; $__hydraText += $__hydraChunk; [System.IO.File]::AppendAllText($__hydraLog, $__hydraChunk, $__hydraUtf8NoBom) } } finally { $ErrorActionPreference = $__hydraOldErrorActionPreference }; $__hydraCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }; $__hydraLastMessageText = ''; if (Test-Path -LiteralPath $__hydraLastMessage) { $__hydraLastMessageText = [System.IO.File]::ReadAllText($__hydraLastMessage, $__hydraUtf8NoBom).TrimEnd() }; $__hydraText = if ([string]::IsNullOrWhiteSpace($__hydraLastMessageText)) { $__hydraText.TrimEnd() } else { $__hydraLastMessageText } } } catch { $__hydraText = (__HydraObjectText $_).TrimEnd(); [System.IO.File]::AppendAllText($__hydraLog, $__hydraText, $__hydraUtf8NoBom); Write-Host -NoNewline $__hydraText; $__hydraCode = 127 }`,
    "if ([string]::IsNullOrWhiteSpace($__hydraText)) { $__hydraText = '[no output]' }",
    "$__hydraPayload = [ordered]@{ text = $__hydraText }",
    "if ($__hydraCode -ne 0) { $__hydraPayload.error = \"exit $__hydraCode\" }",
    "$__hydraReplyJson = $__hydraPayload | ConvertTo-Json -Compress",
    "[System.IO.File]::WriteAllText($__hydraReply, $__hydraReplyJson, $__hydraUtf8NoBom)",
    "Write-Host \"`n[Hydra] Reply captured.\" -ForegroundColor DarkGray",
  ].join("; ");
}

function environmentStatements(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([key, value]) => key.trim() && value !== undefined)
    .map(([key, value]) => `$env:${key} = ${quotePowerShell(value ?? "")}`);
}

export function buildPowerShellDispatchInvocation(dispatchPath: string): string {
  // Leading newline + `; ` guards against a race where the previous dispatch's
  // newline is dropped by the pty (or the prompt hasn't repainted yet) and
  // two `Invoke-Expression` calls would otherwise concatenate onto one
  // PowerShell input line, producing
  //   "Invoke-Expression : A positional parameter cannot be found".
  return `\r\n; Invoke-Expression (Get-Content -LiteralPath ${quotePowerShell(dispatchPath)} -Raw)`;
}

export function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function knownCommandCandidateStatements(command: string): string[] {
  const name = path.basename(command).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
  if (name === "codex") {
    return [
      "if ($env:USERPROFILE) { $__hydraCandidates += (Join-Path $env:USERPROFILE '.vscode\\extensions\\openai.chatgpt-*\\bin\\windows-x86_64\\codex.exe') }",
      "if ($env:LOCALAPPDATA) { $__hydraCandidates += (Join-Path $env:LOCALAPPDATA 'OpenAI\\Codex\\bin\\codex.exe') }",
      "if ($env:LOCALAPPDATA) { $__hydraCandidates += (Join-Path $env:LOCALAPPDATA 'Packages\\OpenAI.Codex_*\\LocalCache\\Local\\OpenAI\\Codex\\bin\\codex.exe') }",
      "if ($env:APPDATA) { $__hydraCandidates += (Join-Path $env:APPDATA 'npm\\codex.cmd') }",
    ];
  }
  if (name === "claude") {
    return [
      "if ($env:USERPROFILE) { $__hydraCandidates += (Join-Path $env:USERPROFILE '.local\\bin\\claude.exe') }",
      "if ($env:APPDATA) { $__hydraCandidates += (Join-Path $env:APPDATA 'npm\\claude.cmd') }",
    ];
  }
  return [];
}

export function parseTerminalReply(raw: string): TerminalReply {
  const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Terminal reply must be a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text : "";
  const error = typeof record.error === "string" ? record.error : undefined;
  if (!text.trim() && !error) {
    throw new Error("Terminal reply JSON must include a non-empty `text` string or `error` string.");
  }
  return { text, error };
}
