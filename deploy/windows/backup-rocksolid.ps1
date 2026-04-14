param(
  [string]$ProjectRoot = "C:\RockSolidLicense",
  [string]$EnvScriptPath = "C:\RockSolidLicense\deploy\windows\rocksolid.env.ps1",
  [string]$BackupRoot = "C:\RockSolidLicense\backups",
  [int]$RetentionDays = 14,
  [string]$Label = "manual"
)

$ErrorActionPreference = "Stop"

if (Test-Path $EnvScriptPath) {
  . $EnvScriptPath
}

if (-not (Test-Path $BackupRoot)) {
  New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$archiveName = "rocksolid-backup-$timestamp-$Label.zip"
$archivePath = Join-Path $BackupRoot $archiveName
$stagingPath = Join-Path $BackupRoot "staging-$timestamp-$Label"

if (Test-Path $stagingPath) {
  Remove-Item -LiteralPath $stagingPath -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $stagingPath | Out-Null

$dbPath = if ($env:RSL_DB_PATH) { $env:RSL_DB_PATH } else { Join-Path $ProjectRoot "data\rocksolid.db" }
$privateKeyPath = if ($env:RSL_LICENSE_PRIVATE_KEY_PATH) { $env:RSL_LICENSE_PRIVATE_KEY_PATH } else { Join-Path $ProjectRoot "data\license_private.pem" }
$publicKeyPath = if ($env:RSL_LICENSE_PUBLIC_KEY_PATH) { $env:RSL_LICENSE_PUBLIC_KEY_PATH } else { Join-Path $ProjectRoot "data\license_public.pem" }
$keyringPath = if ($env:RSL_LICENSE_KEYRING_PATH) { $env:RSL_LICENSE_KEYRING_PATH } else { Join-Path $ProjectRoot "data\license_keyring.json" }

$filesToCopy = @(
  @{ Source = $dbPath; Target = "data\rocksolid.db" },
  @{ Source = $privateKeyPath; Target = "data\license_private.pem" },
  @{ Source = $publicKeyPath; Target = "data\license_public.pem" },
  @{ Source = $keyringPath; Target = "data\license_keyring.json" },
  @{ Source = $EnvScriptPath; Target = "deploy\windows\rocksolid.env.ps1" }
)

$copiedFiles = @()
foreach ($entry in $filesToCopy) {
  if (-not (Test-Path $entry.Source)) {
    continue
  }

  $targetPath = Join-Path $stagingPath $entry.Target
  $targetDir = Split-Path -Parent $targetPath
  if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
  }

  Copy-Item -LiteralPath $entry.Source -Destination $targetPath -Force
  $copiedFiles += $entry.Target
}

$manifest = [ordered]@{
  createdAt = (Get-Date).ToString("o")
  projectRoot = $ProjectRoot
  label = $Label
  copiedFiles = $copiedFiles
  dbPath = $dbPath
  mainStoreDriver = $env:RSL_MAIN_STORE_DRIVER
  stateStoreDriver = $env:RSL_STATE_STORE_DRIVER
}

$manifestPath = Join-Path $stagingPath "manifest.json"
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

if (Test-Path $archivePath) {
  Remove-Item -LiteralPath $archivePath -Force
}

Compress-Archive -Path (Join-Path $stagingPath "*") -DestinationPath $archivePath -Force
Remove-Item -LiteralPath $stagingPath -Recurse -Force

$cutoff = (Get-Date).AddDays(-[Math]::Abs($RetentionDays))
Get-ChildItem -LiteralPath $BackupRoot -Filter "rocksolid-backup-*.zip" -File |
  Where-Object { $_.LastWriteTime -lt $cutoff } |
  ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Force
  }

Write-Host "Backup created at $archivePath"
