#requires -Version 5.1
# Pull the Hydra Room source from Spireslap into this workspace, then init git.
# Run from C:\Users\geral\Hydra in a normal PowerShell window (not via Hydra CLI).

param(
    [string]$Source = 'C:\Users\geral\Spireslap\tools\vscode-hydra-room',
    [string]$Destination = 'C:\Users\geral\Hydra',
    [switch]$InitGit
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Source)) {
    throw "Source not found: $Source"
}
if (-not (Test-Path -LiteralPath $Destination)) {
    throw "Destination not found: $Destination"
}

Write-Host "[hydra-pull] Source:      $Source"
Write-Host "[hydra-pull] Destination: $Destination"

# Mirror source -> destination.
# /E recurses (including empty dirs).
# Skip node_modules, build output, vscode test cache, any nested git/hydra state.
# Skip *.vsix packages and the existing destination .gitignore (we manage it below).
$excludeDirs  = @('node_modules', 'out', 'dist', '.vscode-test', '.git', '.hydra')
$excludeFiles = @('*.vsix', '.gitignore')

$rcArgs = @($Source, $Destination, '/E')
$rcArgs += '/XD'; $rcArgs += $excludeDirs
$rcArgs += '/XF'; $rcArgs += $excludeFiles
$rcArgs += '/NFL','/NDL','/NJH','/NJS','/NC','/NS','/NP'

robocopy @rcArgs
$rcCode = $LASTEXITCODE
# robocopy exit codes < 8 are success (0 = no change, 1-7 = files copied / mismatches).
if ($rcCode -ge 8) {
    throw "robocopy failed with exit code $rcCode"
}
Write-Host "[hydra-pull] robocopy completed (exit $rcCode)."

# Ensure .gitignore keeps Hydra session state out of git.
$gitignorePath = Join-Path $Destination '.gitignore'
$srcGitignore  = Join-Path $Source '.gitignore'
$merged = New-Object System.Collections.Generic.List[string]
if (Test-Path -LiteralPath $srcGitignore) {
    Get-Content -LiteralPath $srcGitignore | ForEach-Object { [void]$merged.Add($_) }
}
$required = @('node_modules/', 'out/', 'dist/', '.vscode-test/', '*.vsix', '.hydra/')
foreach ($line in $required) {
    if (-not ($merged | Where-Object { $_.Trim() -eq $line })) {
        [void]$merged.Add($line)
    }
}
Set-Content -LiteralPath $gitignorePath -Value $merged -Encoding utf8
Write-Host "[hydra-pull] Wrote .gitignore with $($merged.Count) entries."

if ($InitGit) {
    Push-Location -LiteralPath $Destination
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $Destination '.git'))) {
            git init -b main
            git add -A
            git commit -m 'chore: initial import of Hydra Room from Spireslap' --allow-empty
            Write-Host '[hydra-pull] git initialized and initial commit created.'
        } else {
            Write-Host '[hydra-pull] .git already present; skipping init.'
        }
    } finally {
        Pop-Location
    }
}

Write-Host '[hydra-pull] Done.'
