# Register Kovario with Agent Orchestrator (desktop app, 2026 CLI). Run from the repo root
# after `ao start` reports the daemon running. Idempotent: re-running re-applies the config.
#   pwsh scripts/ao-setup.ps1
# Requires PowerShell 7.3+ (5.1 mangles the quotes in --config-json).
# ao.project.json is the source of truth. If the CLI drops a key (it ignores keys it doesn't
# know), the post-apply check warns; set those keys in the desktop app's Project Settings
# until the CLI catches up, and keep them in the JSON so a future CLI update applies them.
$ErrorActionPreference = "Stop"
$root = (Resolve-Path "$PSScriptRoot\..").Path
ao status | Out-Null
$existing = (ao project ls --json | ConvertFrom-Json).projects | Where-Object { $_.id -eq "kovario" }
if (-not $existing) {
  ao project add --path $root --id kovario --name Kovario --worker-agent claude-code --orchestrator-agent claude-code
}
# set-config REPLACES the whole config, so the JSON file is the single source of truth.
$json = Get-Content "$root\ao.project.json" -Raw
ao project set-config kovario --config-json $json
if ($LASTEXITCODE -ne 0) { throw "ao project set-config failed (exit $LASTEXITCODE)" }

# Post-apply check: every key path in ao.project.json must appear in the stored config.
function Get-KeyPaths($obj, $prefix) {
  foreach ($p in $obj.PSObject.Properties) {
    $path = if ($prefix) { "$prefix.$($p.Name)" } else { $p.Name }
    $path
    if ($p.Value -is [System.Management.Automation.PSCustomObject]) { Get-KeyPaths $p.Value $path }
  }
}
$wanted = Get-KeyPaths ($json | ConvertFrom-Json) ""
$stored = Get-KeyPaths (ao project get kovario --json | ConvertFrom-Json).project.config ""
$dropped = $wanted | Where-Object { $_ -notin $stored }
if ($dropped) {
  Write-Warning "ao dropped these keys from ao.project.json (CLI likely behind the daemon):"
  $dropped | ForEach-Object { Write-Warning "  $_" }
  Write-Warning "Set them in the desktop app: Project Settings for 'kovario'."
}
ao project get kovario
