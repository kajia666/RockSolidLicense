param(
  [Parameter(Mandatory = $true)]
  [string]$BackupPath,
  [string]$EnvScriptPath = "C:\RockSolidLicense\deploy\windows\rocksolid.env.ps1",
  [switch]$SkipClean,
  [string]$PgRestoreExe = "pg_restore.exe",
  [string]$PsqlExe = "psql.exe"
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

if (-not (Test-Path $BackupPath)) {
  throw "Backup file was not found: $BackupPath"
}

if (Test-Path $EnvScriptPath) {
  . $EnvScriptPath
}

$config = Resolve-PostgresConfig

$env:PGHOST = $config.Host
$env:PGPORT = $config.Port
$env:PGUSER = $config.User
$env:PGDATABASE = $config.Database
if ($config.Password) {
  $env:PGPASSWORD = $config.Password
}

$extension = [System.IO.Path]::GetExtension($BackupPath).ToLowerInvariant()

switch ($extension) {
  ".dump" {
    if (-not (Get-Command $PgRestoreExe -ErrorAction SilentlyContinue)) {
      throw "pg_restore was not found. Install PostgreSQL client tools or set -PgRestoreExe."
    }

    $args = @("--no-owner", "--dbname=$($config.Database)")
    if (-not $SkipClean) {
      $args = @("--clean", "--if-exists") + $args
    }

    & $PgRestoreExe @args $BackupPath
    if ($LASTEXITCODE -ne 0) {
      throw "pg_restore failed with exit code $LASTEXITCODE"
    }
  }
  ".sql" {
    if (-not (Get-Command $PsqlExe -ErrorAction SilentlyContinue)) {
      throw "psql was not found. Install PostgreSQL client tools or set -PsqlExe."
    }

    & $PsqlExe "-v" "ON_ERROR_STOP=1" "-d" $config.Database "-f" $BackupPath
    if ($LASTEXITCODE -ne 0) {
      throw "psql restore failed with exit code $LASTEXITCODE"
    }
  }
  default {
    throw "Unsupported backup file format: $BackupPath"
  }
}

Write-Host "PostgreSQL restore completed from $BackupPath"
