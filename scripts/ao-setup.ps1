# Register Kovario with Agent Orchestrator (desktop app, 2026 CLI). Run from the repo root
# after `ao start` reports the daemon running.
#   pwsh scripts/ao-setup.ps1          # register if needed; report drift, change nothing
#   pwsh scripts/ao-setup.ps1 -Apply   # write ao.project.json over the stored config
# Requires PowerShell 7.3+ (5.1 mangles the quotes in --config-json).
# ao.project.json mirrors the project config. The CLI neither shows nor writes some keys
# (autoReview, reviewers, workersRequestReview, agentRulesFile, agent effort): set-config REPLACES the
# config and silently wipes them, so they live in the desktop app's Project Settings and
# must be re-saved there after any -Apply. Without -Apply nothing is written.
param([switch]$Apply)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path "$PSScriptRoot\..").Path
ao status | Out-Null
$existing = (ao project ls --json | ConvertFrom-Json).projects | Where-Object { $_.id -eq "kovario" }
if (-not $existing) {
  ao project add --path $root --id kovario --name Kovario --worker-agent claude-code --orchestrator-agent claude-code
}
$json = Get-Content "$root\ao.project.json" -Raw
$appOnly = "autoReview", "reviewers", "workersRequestReview", "agentRulesFile", "effort"

# Flatten to "key.path=json-value" so nested settings compare one by one.
function Get-Leaves($obj, $prefix) {
  foreach ($p in $obj.PSObject.Properties) {
    $path = if ($prefix) { "$prefix.$($p.Name)" } else { $p.Name }
    if ($p.Value -is [System.Management.Automation.PSCustomObject]) {
      Get-Leaves $p.Value $path   # empty objects ({}) contribute nothing on either side
    } else { "$path=$(ConvertTo-Json -InputObject $p.Value -Compress -Depth 10)" }
  }
}
# Only CLI-visible keys can be compared; app-only keys are invisible to `ao project get`.
$wanted = Get-Leaves ($json | ConvertFrom-Json) "" |
  Where-Object { -not (($_ -split '=', 2)[0] -split '\.' | Where-Object { $_ -in $appOnly }) }
$stored = Get-Leaves (ao project get kovario --json | ConvertFrom-Json).project.config ""
$drift = Compare-Object @($wanted) @($stored) | ForEach-Object {
  $(if ($_.SideIndicator -eq "<=") { "  want:   " } else { "  stored: " }) + $_.InputObject
}

if (-not $drift) {
  Write-Host "kovario config already matches ao.project.json; nothing to apply."
} elseif (-not $Apply) {
  Write-Warning "Stored config differs from ao.project.json:"
  $drift | ForEach-Object { Write-Warning $_ }
  Write-Warning "Change it in the app's Project Settings, or re-run with -Apply (wipes: $($appOnly -join ', '))."
} else {
  ao project set-config kovario --config-json $json
  if ($LASTEXITCODE -ne 0) { throw "ao project set-config failed (exit $LASTEXITCODE)" }
  Write-Warning "Applied. The CLI wiped $($appOnly -join ', '): re-save them in the app's Project Settings for 'kovario'."
}
ao project get kovario
