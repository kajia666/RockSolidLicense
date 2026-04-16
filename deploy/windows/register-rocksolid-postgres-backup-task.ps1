param(
  [string]$ProjectRoot = "C:\RockSolidLicense",
  [string]$TaskName = "RockSolidLicensePostgresBackup",
  [string]$PowerShellExe = "powershell.exe",
  [string]$EnvScriptPath = "C:\RockSolidLicense\deploy\windows\rocksolid.env.ps1",
  [string]$BackupRoot = "C:\RockSolidLicense\postgres-backups",
  [int]$RetentionDays = 14,
  [int]$Hour = 3,
  [int]$Minute = 35
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $ProjectRoot "deploy\postgres\backup-postgres.ps1"
if (-not (Test-Path $scriptPath)) {
  throw "backup-postgres.ps1 was not found at $scriptPath"
}

$scheduledAt = Get-Date -Hour $Hour -Minute $Minute -Second 0
$action = New-ScheduledTaskAction `
  -Execute $PowerShellExe `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -EnvScriptPath `"$EnvScriptPath`" -BackupRoot `"$BackupRoot`" -RetentionDays $RetentionDays -Label scheduled"

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

Write-Host "Scheduled PostgreSQL backup task '$TaskName' registered."
