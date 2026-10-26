# Install the Kovario PR review loop as a per-user scheduled task that starts at logon and
# runs hidden. Creates a dedicated worktree (default ~/src/kovario-reviewer) on origin/main
# that scripts/review-loop-service.sh keeps current. Re-run to reinstall; -Uninstall removes.
#   pwsh scripts/install-review-service.ps1 [-Uninstall] [-StartNow]
param([switch]$Uninstall, [switch]$StartNow,
      [string]$Worktree = "$HOME\src\kovario-reviewer",
      [string]$TaskName = "Kovario review loop")
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path "$PSScriptRoot\..").Path

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*review-loop-service.sh*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "Removed task '$TaskName' (worktree $Worktree left in place)."
  return
}

if (-not (Test-Path "$HOME\.kovario-reviewer-pat")) { throw "Put the reviewer PAT in $HOME\.kovario-reviewer-pat first." }
$bash = "C:\Program Files\Git\bin\bash.exe"
if (-not (Test-Path $bash)) { throw "Git Bash not found at $bash" }

git -C $repo fetch -q origin main
if (-not (Test-Path $Worktree)) { git -C $repo worktree add -q --detach $Worktree origin/main }
if ($LASTEXITCODE -ne 0) { throw "git worktree add failed" }

# pwsh -WindowStyle Hidden keeps bash's console from showing; the loop itself runs from the worktree.
$svc = Join-Path $Worktree "scripts\review-loop-service.sh"
$action = New-ScheduledTaskAction -Execute "pwsh.exe" -Argument (
  "-NoProfile -WindowStyle Hidden -Command `"& '$bash' '$svc'`"")
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Installed '$TaskName' (runs at logon from $Worktree; log ~/.ao/kovario-review-loop.log)."
if ($StartNow) { Start-ScheduledTask -TaskName $TaskName; Write-Host "Started." }
