param(
  [string]$EnvScriptPath = "C:\RockSolidLicense\deploy\windows\rocksolid.env.ps1",
  [string]$BackupRoot = "C:\RockSolidLicense\postgres-backups",
  [int]$RetentionDays = 14,
  [string]$Label = "manual",
  [string]$PgDumpExe = "pg_dump.exe"
)

$ErrorActionPreference = "Stop"

function Resolve-PostgresConfig {
  $host = if ($env:PGHOST) { $env:PGHOST } elseif ($env:POSTGRES_HOST) { $env:POSTGRES_HOST } else { $null }
  $port = if ($env:PGPORT) { $env:PGPORT } elseif ($env:POSTGRES_PORT) { $env:POSTGRES_PORT } else { "5432" }
  $user = if ($env:PGUSER) { $env:PGUSER } elseif ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { $null }
  $password = if ($env:PGPASSWORD) { $env:PGPASSWORD } elseif ($env:POSTGRES_PASSWORD) { $env:POSTGRES_PASSWORD } else { $null }
  $database = if ($env:PGDATABASE) { $env:PGDATABASE } elseif ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { $null }

  if ((-not $host -or -not $user -or -not $database) -and $env:RSL_POSTGRES_URL) {
    $uri = [System.Uri]$env:RSL_POSTGRES_URL
    $host = if ($host) { $host } else { $uri.Host }
    $port = if ($env:PGPORT -or $env:POSTGRES_PORT) { $port } elseif ($uri.Port -gt 0) { [string]$uri.Port } else { "5432" }

    if (-not $user -and $uri.UserInfo) {
      $parts = $uri.UserInfo.Split(":", 2)
      $user = [System.Net.WebUtility]::UrlDecode($parts[0])
      if (-not $password -and $parts.Length -gt 1) {
        $password = [System.Net.WebUtility]::UrlDecode($parts[1])
      }
    }

    if (-not $database) {
      $database = $uri.AbsolutePath.TrimStart("/")
    }
  }

  if (-not $host -or -not $user -or -not $database) {
    throw "PostgreSQL connection settings are incomplete. Set PGHOST/PGUSER/PGDATABASE or RSL_POSTGRES_URL."
  }

  [PSCustomObject]@{
    Host = $host
    Port = $port
    User = $user
    Password = $password
    Database = $database
  }
}

if (Test-Path $EnvScriptPath) {
  . $EnvScriptPath
}

if (-not (Get-Command $PgDumpExe -ErrorAction SilentlyContinue)) {
  throw "pg_dump was not found. Install PostgreSQL client tools or set -PgDumpExe."
}

$config = Resolve-PostgresConfig

$env:PGHOST = $config.Host
$env:PGPORT = $config.Port
$env:PGUSER = $config.User
$env:PGDATABASE = $config.Database
if ($config.Password) {
  $env:PGPASSWORD = $config.Password
}

if (-not (Test-Path $BackupRoot)) {
  New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dumpPath = Join-Path $BackupRoot "rocksolid-postgres-backup-$timestamp-$Label.dump"
$manifestPath = Join-Path $BackupRoot "rocksolid-postgres-backup-$timestamp-$Label.manifest.json"

& $PgDumpExe "--format=custom" "--no-owner" "--file=$dumpPath" $config.Database
if ($LASTEXITCODE -ne 0) {
  throw "pg_dump failed with exit code $LASTEXITCODE"
}

$manifest = [ordered]@{
  createdAt = (Get-Date).ToString("o")
  envScriptPath = $EnvScriptPath
  label = $Label
  host = $config.Host
  port = $config.Port
  database = $config.Database
  user = $config.User
  mainStoreDriver = $env:RSL_MAIN_STORE_DRIVER
  stateStoreDriver = $env:RSL_STATE_STORE_DRIVER
}

$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

$cutoff = (Get-Date).AddDays(-[Math]::Abs($RetentionDays))
Get-ChildItem -LiteralPath $BackupRoot -File |
  Where-Object {
    $_.LastWriteTime -lt $cutoff -and (
      $_.Name -like "rocksolid-postgres-backup-*.dump" -or
      $_.Name -like "rocksolid-postgres-backup-*.manifest.json"
    )
  } |
  ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Force
  }

Write-Host "PostgreSQL backup created at $dumpPath"
