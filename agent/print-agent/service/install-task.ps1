# Run as the Windows account that owns the printers and protected agent session.
param([Parameter(Mandatory=$true)][string]$BinaryPath)
$resolvedBinary = (Resolve-Path -LiteralPath $BinaryPath).Path
$action = New-ScheduledTaskAction -Execute $resolvedBinary
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName 'Filletry Print Agent' -Action $action -Trigger $trigger -Settings $settings -Description 'Print agent; run under the paired user with OS printer access'
