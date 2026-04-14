param(
  [string]$ProjectRoot = "C:\RockSolidLicense",
  [string]$TaskName = "RockSolidLicenseBackup",
  [string]$PowerShellExe = "powershell.exe",
  [string]$BackupRoot = "C:\RockSolidLicense\backups",
  [int]$RetentionDays = 14,
  [int]$Hour = 3,
  [int]$Minute = 15
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $ProjectRoot "deploy\windows\backup-rocksolid.ps1"
if (-not (Test-Path $scriptPath)) {
  throw "backup-rocksolid.ps1 was not found at $scriptPath"
}

$scheduledAt = Get-Date -Hour $Hour -Minute $Minute -Second 0
$action = New-ScheduledTaskAction `
  -Execute $PowerShellExe `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -ProjectRoot `"$ProjectRoot`" -BackupRoot `"$BackupRoot`" -RetentionDays $RetentionDays -Label scheduled"

$trigger = New-ScheduledTaskTrigger -Daily -At $scheduledAt
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null

Write-Host "Scheduled backup task '$TaskName' registered."
