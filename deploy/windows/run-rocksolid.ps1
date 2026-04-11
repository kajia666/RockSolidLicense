param(
  [string]$ProjectRoot = "C:\RockSolidLicense",
  [string]$EnvScriptPath = "C:\RockSolidLicense\deploy\windows\rocksolid.env.ps1"
)

$ErrorActionPreference = "Stop"

if (Test-Path $EnvScriptPath) {
  . $EnvScriptPath
}

$dataDir = Join-Path $ProjectRoot "data"
if (-not (Test-Path $dataDir)) {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
}

Set-Location $ProjectRoot
node .\src\server.js
