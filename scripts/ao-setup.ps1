# Register Kovario with Agent Orchestrator (desktop app, 2026 CLI). Run from the repo root
# after `ao start` reports the daemon running. Idempotent: re-running re-applies the config.
#   pwsh scripts/ao-setup.ps1
$ErrorActionPreference = "Stop"
$root = (Resolve-Path "$PSScriptRoot\..").Path
ao status | Out-Null
$existing = (ao project ls --json | ConvertFrom-Json) | Where-Object { $_.id -eq "kovario" }
if (-not $existing) {
  ao project add --path $root --id kovario --name Kovario --worker-agent claude-code --orchestrator-agent claude-code
}
# set-config REPLACES the whole config, so the JSON file is the single source of truth.
$json = Get-Content "$root\ao.project.json" -Raw
ao project set-config kovario --config-json $json
ao project get kovario
