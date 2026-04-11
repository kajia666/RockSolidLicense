param(
  [string]$ProjectRoot = "C:\RockSolidLicense",
  [string]$TaskName = "RockSolidLicense",
  [string]$PowerShellExe = "powershell.exe"
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $ProjectRoot "deploy\windows\run-rocksolid.ps1"
if (-not (Test-Path $scriptPath)) {
  throw "run-rocksolid.ps1 was not found at $scriptPath"
}

$action = New-ScheduledTaskAction `
  -Execute $PowerShellExe `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -ProjectRoot `"$ProjectRoot`""

$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null

Write-Host "Scheduled task '$TaskName' registered."
