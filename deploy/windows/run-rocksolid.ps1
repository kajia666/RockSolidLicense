param(
  [string]$ProjectRoot = "C:\RockSolidLicense",
  [string]$EnvScriptPath = "C:\RockSolidLicense\deploy\windows\rocksolid.env.ps1",
  [string]$LogDir = "C:\RockSolidLicense\logs"
)

$ErrorActionPreference = "Stop"

if (Test-Path $EnvScriptPath) {
  . $EnvScriptPath
}

$dataDir = Join-Path $ProjectRoot "data"
if (-not (Test-Path $dataDir)) {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
}

if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

$logPath = Join-Path $LogDir "rocksolid-server.log"

Set-Location $ProjectRoot
node .\src\server.js *>> $logPath
