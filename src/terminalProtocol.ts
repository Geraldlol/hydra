import * as path from "node:path";
import { MAX_AGENT_STDOUT_BYTES, type AgentSpawn } from "./agents";
import type { AgentId } from "./phases";
import type { Phase } from "./prompts";
import { displayNameFor } from "./agentRegistry";

export interface TerminalProtocolPaths {
  promptPath: string;
  replyPath: string;
  logPath: string;
  dispatchPath: string;
  replyKeyPath: string;
  lastMessagePath: string;
}

export interface TerminalReply {
  text: string;
  error?: string;
  nonce?: string;
  auth?: string;
  logSha256?: string;
}

export const HYDRA_SYNTHETIC_ECHO_COMMAND = "__hydra_echo__";

export interface TerminalBridgePlatformSupport {
  supported: boolean;
  platform: NodeJS.Platform;
  message: string;
}

/**
 * The visible-terminal protocol is PowerShell, not a generic shell script.
 * Reject unsupported hosts before any command can be pasted into their shell.
 */
export function terminalBridgePlatformSupport(
  platform: NodeJS.Platform = process.platform,
): TerminalBridgePlatformSupport {
  if (platform === "win32") {
    return {
      supported: true,
      platform,
      message: "Terminal bridge is available through Windows PowerShell.",
    };
  }
  return {
    supported: false,
    platform,
    message: `Terminal bridge is unsupported on ${platform}: it requires Windows PowerShell. Safe One-Shot remains active.`,
  };
}

export function expandTerminalCommand(command: string, workspaceRoot: string): string {
  return command.replace(/\$\{workspaceFolder\}/g, workspaceRoot);
}

export function terminalProtocolPaths(
  workspaceRoot: string,
  requestId: string,
  agent: AgentId,
  phase: Phase
): TerminalProtocolPaths {
  return terminalProtocolStoragePaths(path.join(workspaceRoot, ".hydra"), requestId, agent, phase);
}

/** Resolve terminal-bridge files beneath an extension-owned storage root. */
export function terminalProtocolStoragePaths(
  storageRoot: string,
  requestId: string,
  agent: AgentId,
  phase: Phase
): TerminalProtocolPaths {
  const safeSegment = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const base = `${safeSegment(requestId)}-${safeSegment(agent)}-${safeSegment(phase)}`;
  const replyPath = path.join(storageRoot, "replies", `${base}.json`);
  return {
    promptPath: path.join(storageRoot, "prompts", `${base}.md`),
    replyPath,
    logPath: path.join(storageRoot, "logs", `${base}.log`),
    dispatchPath: path.join(storageRoot, "dispatch", `${base}.ps1`),
    replyKeyPath: path.join(storageRoot, "reply-keys", `${base}.key`),
    lastMessagePath: path.join(path.dirname(replyPath), `${base}.last.txt`),
  };
}

function protocolPathFlavor(filePath: string): typeof path.win32 {
  return path.win32.isAbsolute(filePath) ? path.win32 : path.posix;
}

function terminalArtifactRootForFile(filePath: string, expectedDirectory: string): string {
  const flavor = protocolPathFlavor(filePath);
  const directory = flavor.dirname(filePath);
  return flavor.basename(directory).toLowerCase() === expectedDirectory
    ? flavor.dirname(directory)
    : directory;
}

/** Resolve the one-use reply-key artifact paired with a reply file. */
export function terminalReplyKeyPath(replyPath: string): string {
  const flavor = protocolPathFlavor(replyPath);
  const artifactRoot = terminalArtifactRootForFile(replyPath, "replies");
  const extension = flavor.extname(replyPath);
  const base = flavor.basename(replyPath, extension);
  return flavor.join(artifactRoot, "reply-keys", `${base}.key`);
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
  const label = displayNameFor(agent);
  return [
    `Write-Host ${quotePowerShell(`[Hydra] ${label} terminal ready.`)} -ForegroundColor Cyan`,
    `Write-Host ${quotePowerShell("[Hydra] Dispatch mode: leave this shell open; Hydra will paste short request launchers here.")}`,
    `Write-Host ${quotePowerShell(`[Hydra] Workspace: ${workspaceRoot}`)}`,
    `Write-Host ${quotePowerShell("[Hydra] Use the Hydra Room composer to talk to the agents.")}`,
  ].join("; ");
}

export function buildTerminalStartupProbeCommand(agent: AgentId, workspaceRoot: string, markerPath: string): string {
  const markerDir = path.dirname(markerPath);
  return [
    buildTerminalReadyCommand(agent, workspaceRoot),
    `$__hydraStartupProbeDir = ${quotePowerShell(markerDir)}`,
    "if ($__hydraStartupProbeDir) { [System.IO.Directory]::CreateDirectory($__hydraStartupProbeDir) | Out-Null }",
    `$__hydraStartupProbe = ${quotePowerShell(markerPath)}`,
    "$__hydraUtf8NoBom = [System.Text.UTF8Encoding]::new($false)",
    "[System.IO.File]::WriteAllText($__hydraStartupProbe, 'ready', $__hydraUtf8NoBom)",
  ].join("; ");
}

export function buildPowerShellDispatchCommand(
  spawn: AgentSpawn,
  promptPath: string,
  replyPath: string,
  logPath: string,
  promptSha256?: string
): string {
  const artifactRoot = terminalArtifactRootForFile(replyPath, "replies");
  const replyKeyPath = terminalReplyKeyPath(replyPath);
  const argArray = spawn.args.length > 0 ? `@(${spawn.args.map(quotePowerShell).join(", ")})` : "@()";
  return [
    `$__hydraArtifactRoot = ${quotePowerShell(artifactRoot)}`,
    `$__hydraReplyKeyPath = ${quotePowerShell(replyKeyPath)}`,
    `$__hydraPrompt = ${quotePowerShell(promptPath)}`,
    `$__hydraReply = ${quotePowerShell(replyPath)}`,
    `$__hydraLog = ${quotePowerShell(logPath)}`,
    `$__hydraCommandName = ${quotePowerShell(spawn.command)}`,
    `$__hydraArgs = ${argArray}`,
    `$__hydraPromptExpectedSha256 = ${quotePowerShell(promptSha256 ?? "")}`,
    "$__hydraCandidates = @()",
    ...knownCommandCandidateStatements(spawn.command),
    "$ErrorActionPreference = 'Stop'",
    "$__hydraReplyKey = $null",
    "$__hydraCode = 0",
    "$__hydraReplyDir = Split-Path -Parent $__hydraReply",
    "if ($__hydraReplyDir) { [System.IO.Directory]::CreateDirectory($__hydraReplyDir) | Out-Null }",
    "$__hydraLastMessage = [System.IO.Path]::ChangeExtension($__hydraReply, '.last.txt')",
    "$__hydraLogDir = Split-Path -Parent $__hydraLog",
    "if ($__hydraLogDir) { [System.IO.Directory]::CreateDirectory($__hydraLogDir) | Out-Null }",
    "$__hydraUtf8NoBom = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = $__hydraUtf8NoBom",
    "try { [Console]::OutputEncoding = $__hydraUtf8NoBom } catch {}",
    "function __HydraSha256 { param([byte[]]$Bytes) $__hydraHasher = [System.Security.Cryptography.SHA256]::Create(); try { return ([System.BitConverter]::ToString($__hydraHasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() } finally { $__hydraHasher.Dispose() } }",
    "function __HydraHmacSha256 { param([byte[]]$Key, [string]$Value) $__hydraHmac = [System.Security.Cryptography.HMACSHA256]::new($Key); try { return ([System.BitConverter]::ToString($__hydraHmac.ComputeHash($__hydraUtf8NoBom.GetBytes($Value)))).Replace('-', '').ToLowerInvariant() } finally { $__hydraHmac.Dispose() } }",
    "function __HydraAssertRegularFile { param([string]$FilePath) $__hydraItem = Get-Item -LiteralPath $FilePath -Force -ErrorAction Stop; if ($__hydraItem.PSIsContainer -or (($__hydraItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { throw \"Hydra refused a linked or non-regular terminal artifact: $FilePath\" } }",
    "function __HydraAssertPrivateDirectory { param([string]$DirectoryPath) if ([string]::IsNullOrWhiteSpace($DirectoryPath) -or -not [System.IO.Path]::IsPathRooted($DirectoryPath)) { throw 'Hydra private artifact directory must be absolute.' }; $__hydraDirectoryFull = [System.IO.Path]::GetFullPath($DirectoryPath); $__hydraDirectoryItem = Get-Item -LiteralPath $__hydraDirectoryFull -Force -ErrorAction Stop; if (-not $__hydraDirectoryItem.PSIsContainer -or (($__hydraDirectoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Hydra refused a linked or invalid private artifact directory.' }; return $__hydraDirectoryFull }",
    "function __HydraConsumeReplyKey { param([string]$__hydraReplyKeyPath, [string]$__hydraPrivateRoot) $__hydraKeyBytes = $null; $__hydraKeyStream = $null; $__hydraReplyKeyMayDelete = $false; try { $__hydraRootFull = __HydraAssertPrivateDirectory $__hydraPrivateRoot; $__hydraExpectedKeyDirectory = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($__hydraRootFull, 'reply-keys')); $__hydraExpectedKeyDirectory = __HydraAssertPrivateDirectory $__hydraExpectedKeyDirectory; if ([string]::IsNullOrWhiteSpace($__hydraReplyKeyPath) -or -not [System.IO.Path]::IsPathRooted($__hydraReplyKeyPath)) { throw 'Hydra reply key path escapes the private artifact root.' }; $__hydraReplyKeyFull = [System.IO.Path]::GetFullPath($__hydraReplyKeyPath); $__hydraActualKeyDirectory = [System.IO.Path]::GetFullPath([System.IO.Path]::GetDirectoryName($__hydraReplyKeyFull)); if (-not [string]::Equals($__hydraActualKeyDirectory, $__hydraExpectedKeyDirectory, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Hydra reply key path escapes the private artifact root.' }; if ([System.IO.Path]::GetExtension($__hydraReplyKeyFull) -cne '.key') { throw 'Hydra reply key artifact has an invalid filename.' }; $__hydraKeyItem = Get-Item -LiteralPath $__hydraReplyKeyFull -Force -ErrorAction Stop; if ($__hydraKeyItem.PSIsContainer -or (($__hydraKeyItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Hydra refused a linked or non-regular reply key artifact.' }; $__hydraReplyKeyMayDelete = $true; if ($__hydraKeyItem.Length -ne 32) { throw 'Hydra reply key must contain exactly 32 bytes.' }; $__hydraKeyStream = [System.IO.File]::Open($__hydraReplyKeyFull, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None); try { $__hydraOpenedKeyItem = Get-Item -LiteralPath $__hydraReplyKeyFull -Force -ErrorAction Stop; if ($__hydraOpenedKeyItem.PSIsContainer -or (($__hydraOpenedKeyItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or $__hydraOpenedKeyItem.Length -ne 32 -or $__hydraKeyStream.Length -ne 32) { throw 'Hydra reply key must be a regular 32-byte file.' }; $__hydraKeyBytes = [byte[]]::new(32); $__hydraKeyOffset = 0; while ($__hydraKeyOffset -lt $__hydraKeyBytes.Length) { $__hydraKeyRead = $__hydraKeyStream.Read($__hydraKeyBytes, $__hydraKeyOffset, $__hydraKeyBytes.Length - $__hydraKeyOffset); if ($__hydraKeyRead -le 0) { break }; $__hydraKeyOffset += $__hydraKeyRead }; if ($__hydraKeyOffset -ne 32 -or $__hydraKeyStream.ReadByte() -ne -1) { throw 'Hydra reply key must contain exactly 32 bytes.' } } finally { if ($null -ne $__hydraKeyStream) { $__hydraKeyStream.Dispose(); $__hydraKeyStream = $null } }; Remove-Item -LiteralPath $__hydraReplyKeyPath -Force -ErrorAction Stop; if (Test-Path -LiteralPath $__hydraReplyKeyPath -PathType Any) { throw 'Hydra reply key artifact could not be consumed.' }; $__hydraReplyKeyMayDelete = $false; return ,$__hydraKeyBytes } catch { if ($null -ne $__hydraKeyBytes) { [System.Array]::Clear($__hydraKeyBytes, 0, $__hydraKeyBytes.Length) }; throw } finally { if ($null -ne $__hydraKeyStream) { $__hydraKeyStream.Dispose() }; if ($__hydraReplyKeyMayDelete -and -not [string]::IsNullOrWhiteSpace($__hydraReplyKeyPath)) { Remove-Item -LiteralPath $__hydraReplyKeyPath -Force -ErrorAction SilentlyContinue } } }",
    "__HydraAssertRegularFile $__hydraPrompt",
    "__HydraAssertRegularFile $__hydraReply",
    "__HydraAssertRegularFile $__hydraLog",
    "__HydraAssertRegularFile $__hydraLastMessage",
    "$__hydraReplyKey = [byte[]](__HydraConsumeReplyKey $__hydraReplyKeyPath $__hydraArtifactRoot)",
    "[System.IO.File]::WriteAllText($__hydraLog, '', $__hydraUtf8NoBom)",
    `$__hydraOutputLimit = ${MAX_AGENT_STDOUT_BYTES}`,
    "$__hydraTruncationMarker = \"`n[Hydra: terminal output truncated at $__hydraOutputLimit characters]`n\"",
    "$__hydraCapture = @{ textBuilder = [System.Text.StringBuilder]::new(); textTruncated = $false; logChars = 0; logTruncated = $false }",
    "function __HydraBoundText { param([string]$Value) if ($Value.Length -le $__hydraOutputLimit) { return $Value }; return $Value.Substring(0, $__hydraOutputLimit) + $__hydraTruncationMarker }",
    "function __HydraReadBoundedUtf8File { param([string]$FilePath) $__hydraStream = [System.IO.File]::Open($FilePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite); try { $__hydraByteLimit = [int][Math]::Min([int64]$__hydraOutputLimit, $__hydraStream.Length); $__hydraBytes = [byte[]]::new($__hydraByteLimit); $__hydraRead = 0; while ($__hydraRead -lt $__hydraByteLimit) { $__hydraCount = $__hydraStream.Read($__hydraBytes, $__hydraRead, $__hydraByteLimit - $__hydraRead); if ($__hydraCount -le 0) { break }; $__hydraRead += $__hydraCount }; $__hydraValue = $__hydraUtf8NoBom.GetString($__hydraBytes, 0, $__hydraRead); if ($__hydraStream.Length -gt $__hydraRead) { $__hydraValue += $__hydraTruncationMarker }; return (__HydraBoundText $__hydraValue) } finally { $__hydraStream.Dispose() } }",
    "function __HydraCaptureChunk { param([string]$Chunk) if (-not $__hydraCapture.textTruncated) { $__hydraRemainingText = $__hydraOutputLimit - $__hydraCapture.textBuilder.Length; if ($__hydraRemainingText -gt 0) { [void]$__hydraCapture.textBuilder.Append($Chunk.Substring(0, [Math]::Min($__hydraRemainingText, $Chunk.Length))) }; if ($Chunk.Length -gt $__hydraRemainingText) { [void]$__hydraCapture.textBuilder.Append($__hydraTruncationMarker); $__hydraCapture.textTruncated = $true } }; if (-not $__hydraCapture.logTruncated) { $__hydraRemainingLog = $__hydraOutputLimit - $__hydraCapture.logChars; if ($__hydraRemainingLog -gt 0) { $__hydraAcceptedLog = $Chunk.Substring(0, [Math]::Min($__hydraRemainingLog, $Chunk.Length)); [System.IO.File]::AppendAllText($__hydraLog, $__hydraAcceptedLog, $__hydraUtf8NoBom); $__hydraCapture.logChars += $__hydraAcceptedLog.Length }; if ($Chunk.Length -gt $__hydraRemainingLog) { [System.IO.File]::AppendAllText($__hydraLog, $__hydraTruncationMarker, $__hydraUtf8NoBom); $__hydraCapture.logTruncated = $true } } }",
    "function __HydraObjectText { param($Value) if ($Value -is [System.Management.Automation.ErrorRecord] -and $Value.FullyQualifiedErrorId -eq 'NativeCommandError') { return ([string]$Value.Exception.Message).TrimEnd() + [Environment]::NewLine } return ($Value | Out-String) }",
    "function __HydraResolveCommand { param([string]$Name, [string[]]$Candidates) if ([System.IO.Path]::IsPathRooted($Name) -or $Name.Contains('\\\\') -or $Name.Contains('/')) { if (Test-Path -LiteralPath $Name) { return (Resolve-Path -LiteralPath $Name).Path }; throw \"Hydra could not find native CLI '$Name'. Set the Hydra command setting to a full path or switch to Safe One-Shot.\" } $cmd = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue; if ($cmd) { return $cmd.Source } foreach ($candidate in $Candidates) { $matches = @(Get-Item -Path $candidate -ErrorAction SilentlyContinue | Sort-Object FullName -Descending); if ($matches.Count -gt 0) { return $matches[0].FullName } } throw \"Hydra could not find native CLI '$Name'. Set the Hydra command setting to a full path or switch to Safe One-Shot.\" }",
    `try { if ($__hydraCommandName -eq ${quotePowerShell(HYDRA_SYNTHETIC_ECHO_COMMAND)}) { Write-Host "[Hydra] Running terminal bridge synthetic echo..." -ForegroundColor DarkGray; $__hydraText = if ($__hydraArgs.Count -gt 0) { [string]$__hydraArgs[0] } else { 'ok' }; __HydraCaptureChunk $__hydraText; Write-Host -NoNewline $__hydraText; $__hydraCode = 0 } else { $__hydraCommand = __HydraResolveCommand $__hydraCommandName $__hydraCandidates; $__hydraCommandLeaf = [System.IO.Path]::GetFileNameWithoutExtension($__hydraCommand).ToLowerInvariant(); $__hydraCommandExtension = [System.IO.Path]::GetExtension($__hydraCommand).ToLowerInvariant(); if (($__hydraCommandExtension -eq '.cmd' -or $__hydraCommandExtension -eq '.bat') -and @($__hydraArgs | Where-Object { [string]$_ -match '%[^%]+%|![^!]+!' }).Count -gt 0) { throw 'Hydra refused a Windows batch argument containing variable-expansion syntax. Use the native .exe command or remove %NAME%/!NAME! from configured arguments.' }; $__hydraStructuredOutput = (($__hydraCommandLeaf -eq 'claude' -and ($__hydraArgs -contains '--output-format') -and ($__hydraArgs -contains 'stream-json')) -or ($__hydraCommandLeaf -eq 'codex' -and ($__hydraArgs -contains '--json'))); if ($__hydraCommandLeaf -eq 'codex' -and $__hydraArgs.Count -gt 0 -and [string]$__hydraArgs[0] -eq 'exec' -and -not ($__hydraArgs -contains '--output-last-message')) { $__hydraList = [System.Collections.Generic.List[string]]::new(); foreach ($__hydraArg in $__hydraArgs) { [void]$__hydraList.Add([string]$__hydraArg) }; $__hydraDashIndex = $__hydraList.LastIndexOf('-'); if ($__hydraDashIndex -ge 0) { $__hydraList.Insert($__hydraDashIndex, $__hydraLastMessage); $__hydraList.Insert($__hydraDashIndex, '--output-last-message'); $__hydraArgs = $__hydraList.ToArray() } else { $__hydraArgs += @('--output-last-message', $__hydraLastMessage) } }; if (($__hydraCommandExtension -eq '.cmd' -or $__hydraCommandExtension -eq '.bat') -and @($__hydraArgs | Where-Object { [string]$_ -match '%[^%]+%|![^!]+!' }).Count -gt 0) { throw 'Hydra refused a Windows batch argument containing variable-expansion syntax. Use the native .exe command or remove %NAME%/!NAME! from configured arguments.' }; Write-Host "[Hydra] Dispatching $__hydraCommandName via terminal bridge..." -ForegroundColor DarkGray; if ($__hydraStructuredOutput) { Write-Host "[Hydra] Structured native events are captured in the request log." -ForegroundColor DarkGray } else { Write-Host "[Hydra] Native output is tee'd to this terminal and the request log." -ForegroundColor DarkGray }; $__hydraPromptBytes = [System.IO.File]::ReadAllBytes($__hydraPrompt); if ($__hydraPromptExpectedSha256 -and (__HydraSha256 $__hydraPromptBytes) -cne $__hydraPromptExpectedSha256) { throw 'Hydra terminal prompt integrity check failed.' }; $__hydraPromptText = $__hydraUtf8NoBom.GetString($__hydraPromptBytes); $__hydraOldErrorActionPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { $__hydraPromptText | & $__hydraCommand @__hydraArgs 2>&1 | ForEach-Object { $__hydraChunk = __HydraObjectText $_; __HydraCaptureChunk $__hydraChunk; if (-not $__hydraStructuredOutput) { Write-Host -NoNewline $__hydraChunk } } } finally { $ErrorActionPreference = $__hydraOldErrorActionPreference }; $__hydraCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }; $__hydraText = $__hydraCapture.textBuilder.ToString().TrimEnd(); $__hydraLastMessageText = ''; if (Test-Path -LiteralPath $__hydraLastMessage) { __HydraAssertRegularFile $__hydraLastMessage; $__hydraLastMessageText = (__HydraReadBoundedUtf8File $__hydraLastMessage).TrimEnd() }; $__hydraText = if ([string]::IsNullOrWhiteSpace($__hydraLastMessageText)) { $__hydraText.TrimEnd() } else { $__hydraLastMessageText } } } catch { $__hydraText = (__HydraObjectText $_).TrimEnd(); __HydraCaptureChunk $__hydraText; Write-Host -NoNewline $__hydraText; $__hydraCode = 127 }`,
    "if ([string]::IsNullOrWhiteSpace($__hydraText)) { $__hydraText = '[no output]' }",
    // The one-use key artifact has already been consumed and deleted before
    // native command resolution. Only this PowerShell-local byte array remains.
    "$__hydraLogSha256 = __HydraSha256 ([System.IO.File]::ReadAllBytes($__hydraLog))",
    "$__hydraPayload = [ordered]@{ text = $__hydraText; logSha256 = $__hydraLogSha256 }",
    "if ($__hydraCode -ne 0) { $__hydraPayload.error = \"exit $__hydraCode\" }",
    "$__hydraAuthMaterial = $__hydraText + [char]0 + ([string]$__hydraPayload.error) + [char]0 + $__hydraLogSha256",
    "$__hydraPayload.auth = __HydraHmacSha256 $__hydraReplyKey $__hydraAuthMaterial",
    "$__hydraReplyJson = $__hydraPayload | ConvertTo-Json -Compress",
    "[System.IO.File]::WriteAllText($__hydraReply, $__hydraReplyJson, $__hydraUtf8NoBom)",
    "Write-Host \"`n[Hydra] Reply captured.\" -ForegroundColor DarkGray",
  ].join("; ");
}

// The dispatch hash travels through the live terminal command, not the script
// file, so a modified launcher is rejected before Invoke-Expression executes.
export function buildPowerShellDispatchInvocation(
  dispatchPath: string,
  expectedSha256?: string
): string {
  // Leading newline + `; ` guards against a race where the previous dispatch's
  // newline is dropped by the pty (or the prompt hasn't repainted yet) and
  // two `Invoke-Expression` calls would otherwise concatenate onto one
  // PowerShell input line, producing
  //   "Invoke-Expression : A positional parameter cannot be found".
  //
  // The command pasted into the interactive shell contains only private paths
  // and the launcher digest. The HMAC key itself is read by the hash-verified
  // launcher from its one-use artifact, so shell history never receives it.
  const flavor = protocolPathFlavor(dispatchPath);
  if (!flavor.isAbsolute(dispatchPath) || flavor.extname(dispatchPath).toLowerCase() !== ".ps1") {
    throw new Error("Terminal dispatch path must be an absolute PowerShell script path.");
  }
  if (!expectedSha256 || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error("Terminal dispatch requires an expected SHA-256 digest.");
  }
  const artifactRoot = terminalArtifactRootForFile(dispatchPath, "dispatch");
  const base = flavor.basename(dispatchPath, flavor.extname(dispatchPath));
  const replyKeyPath = flavor.join(artifactRoot, "reply-keys", `${base}.key`);
  const replyKeyDirectory = flavor.dirname(replyKeyPath);
  const dispatchRead = `$__hydraDispatchBytes = [System.IO.File]::ReadAllBytes(${quotePowerShell(dispatchPath)}); $__hydraDispatchHasher = [System.Security.Cryptography.SHA256]::Create(); try { $__hydraDispatchActualSha256 = ([System.BitConverter]::ToString($__hydraDispatchHasher.ComputeHash($__hydraDispatchBytes))).Replace('-', '').ToLowerInvariant() } finally { $__hydraDispatchHasher.Dispose() }; if ($__hydraDispatchActualSha256 -cne ${quotePowerShell(expectedSha256)}) { throw 'Hydra terminal dispatch integrity check failed.' }; Invoke-Expression ([System.Text.UTF8Encoding]::new($false).GetString($__hydraDispatchBytes))`;
  const safeKeyCleanup = `try { $__hydraCleanupRoot = Get-Item -LiteralPath ${quotePowerShell(artifactRoot)} -Force -ErrorAction Stop; $__hydraCleanupDirectory = Get-Item -LiteralPath ${quotePowerShell(replyKeyDirectory)} -Force -ErrorAction Stop; $__hydraCleanupKey = Get-Item -LiteralPath ${quotePowerShell(replyKeyPath)} -Force -ErrorAction Stop; if ($__hydraCleanupRoot.PSIsContainer -and -not (($__hydraCleanupRoot.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -and $__hydraCleanupDirectory.PSIsContainer -and -not (($__hydraCleanupDirectory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -and -not $__hydraCleanupKey.PSIsContainer -and -not (($__hydraCleanupKey.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { Remove-Item -LiteralPath ${quotePowerShell(replyKeyPath)} -Force -ErrorAction SilentlyContinue } } catch {}`;
  return `\r\n; Remove-Item env:HYDRA_REPLY_NONCE -ErrorAction SilentlyContinue; try { ${dispatchRead} } finally { if ($__hydraReplyKey -is [byte[]]) { [System.Array]::Clear($__hydraReplyKey, 0, $__hydraReplyKey.Length) }; $__hydraReplyKey = $null; Remove-Variable __hydraReplyKey -ErrorAction SilentlyContinue; ${safeKeyCleanup}; Remove-Item env:HYDRA_REPLY_NONCE -ErrorAction SilentlyContinue }; $null = $null`;
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
  const nonce = typeof record.nonce === "string" ? record.nonce : undefined;
  const auth = typeof record.auth === "string" ? record.auth : undefined;
  const logSha256 = typeof record.logSha256 === "string" ? record.logSha256 : undefined;
  if (!text.trim() && !error) {
    throw new Error("Terminal reply JSON must include a non-empty `text` string or `error` string.");
  }
  return { text, error, nonce, auth, logSha256 };
}
