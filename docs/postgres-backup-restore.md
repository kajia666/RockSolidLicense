# PostgreSQL Backup And Restore

This guide is for the `PostgreSQL Preview + Redis` deployment path.

It complements:

- [storage-deployment-guide.md](/D:/code/OnlineVerification/docs/storage-deployment-guide.md)
- [production-operations-runbook.md](/D:/code/OnlineVerification/docs/production-operations-runbook.md)
- [linux-deployment.md](/D:/code/OnlineVerification/docs/linux-deployment.md)
- [windows-deployment-guide.md](/D:/code/OnlineVerification/docs/windows-deployment-guide.md)

## What this covers

The repository now includes host-side PostgreSQL client scripts for both Linux and Windows:

- [backup-postgres.sh](/D:/code/OnlineVerification/deploy/postgres/backup-postgres.sh)
- [restore-postgres.sh](/D:/code/OnlineVerification/deploy/postgres/restore-postgres.sh)
- [backup-postgres.ps1](/D:/code/OnlineVerification/deploy/postgres/backup-postgres.ps1)
- [restore-postgres.ps1](/D:/code/OnlineVerification/deploy/postgres/restore-postgres.ps1)
- [rocksolid-postgres-backup.service](/D:/code/OnlineVerification/deploy/systemd/rocksolid-postgres-backup.service)
- [rocksolid-postgres-backup.timer](/D:/code/OnlineVerification/deploy/systemd/rocksolid-postgres-backup.timer)
- [register-rocksolid-postgres-backup-task.ps1](/D:/code/OnlineVerification/deploy/windows/register-rocksolid-postgres-backup-task.ps1)
- [unregister-rocksolid-postgres-backup-task.ps1](/D:/code/OnlineVerification/deploy/windows/unregister-rocksolid-postgres-backup-task.ps1)

These scripts are meant for environments where:

- `RSL_MAIN_STORE_DRIVER=postgres`
- the app is already configured to use PostgreSQL as the main store
- you want a repeatable `pg_dump` / restore workflow in addition to app-key backups

## Prerequisites

Install PostgreSQL client tools on the machine that runs the scripts:

- Linux: `pg_dump`, `pg_restore`, and `psql`
- Windows: `pg_dump.exe`, `pg_restore.exe`, and `psql.exe`

The scripts resolve connection settings in this order:

1. `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`
2. `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
3. `RSL_POSTGRES_URL`

That means you can keep using the app's existing env file and override only the host-side connection fields when needed.

## Docker Compose preview note

The preview compose file now binds PostgreSQL to the local host only:

- [docker-compose.pg-redis.preview.yml](/D:/code/OnlineVerification/deploy/docker-compose.pg-redis.preview.yml)

The relevant bind is:

- `127.0.0.1:5432:5432`

This is intentional:

- the app container still talks to the `postgres` service name inside Docker
- host-side backup scripts can talk to PostgreSQL through `127.0.0.1:5432`
- the database is not exposed publicly by default

The preview env example also includes matching host-side `PG*` values:

- [rocksolid.pg-redis.preview.env.example](/D:/code/OnlineVerification/deploy/rocksolid.pg-redis.preview.env.example)

## Linux backup

Typical command:

```bash
ENV_FILE=/etc/rocksolidlicense/rocksolid.env \
BACKUP_DIR=/var/lib/rocksolid/postgres-backups \
/opt/rocksolidlicense/deploy/postgres/backup-postgres.sh
```

Output:

- one `.dump` file
- one `.manifest.txt` file

Defaults:

- format: PostgreSQL custom dump
- retention: `14` days
- label: `manual`

Useful overrides:

```bash
LABEL=pre-upgrade
RETENTION_DAYS=30
PG_DUMP_BIN=/usr/lib/postgresql/17/bin/pg_dump
```

## Linux scheduled backup with systemd

The repository now also includes:

- [rocksolid-postgres-backup.service](/D:/code/OnlineVerification/deploy/systemd/rocksolid-postgres-backup.service)
- [rocksolid-postgres-backup.timer](/D:/code/OnlineVerification/deploy/systemd/rocksolid-postgres-backup.timer)

Suggested installation:

```bash
sudo cp /opt/rocksolidlicense/deploy/systemd/rocksolid-postgres-backup.service /etc/systemd/system/
sudo cp /opt/rocksolidlicense/deploy/systemd/rocksolid-postgres-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rocksolid-postgres-backup.timer
```

Current default schedule:

- every day at `03:35`

That intentionally runs after the file-based app backup timer so the two jobs do not start at the exact same moment.

## Linux restore

Typical command:

```bash
ENV_FILE=/etc/rocksolidlicense/rocksolid.env \
/opt/rocksolidlicense/deploy/postgres/restore-postgres.sh \
  --file /var/lib/rocksolid/postgres-backups/rocksolid-postgres-backup-20260417-030000-manual.dump
```

Default behavior:

- `.dump` restores use `pg_restore --clean --if-exists`
- `.sql` and `.sql.gz` restores use `psql`

If you do not want the script to clean existing objects first:

```bash
/opt/rocksolidlicense/deploy/postgres/restore-postgres.sh \
  --file /path/to/backup.dump \
  --no-clean
```

## Windows backup

Typical command:

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\postgres\backup-postgres.ps1
```

Useful overrides:

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\postgres\backup-postgres.ps1 `
  -EnvScriptPath C:\RockSolidLicense\deploy\windows\rocksolid.env.ps1 `
  -BackupRoot C:\RockSolidLicense\postgres-backups `
  -RetentionDays 30 `
  -Label pre-upgrade
```

Output:

- one `.dump` file
- one `.manifest.json` file

## Windows restore

Typical command:

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\postgres\restore-postgres.ps1 `
  -BackupPath C:\RockSolidLicense\postgres-backups\rocksolid-postgres-backup-20260417-030000-manual.dump
```

If you need to keep existing objects and avoid the cleanup pass:

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\postgres\restore-postgres.ps1 `
  -BackupPath C:\RockSolidLicense\postgres-backups\rocksolid-postgres-backup-20260417-030000-manual.dump `
  -SkipClean
```

## Windows scheduled backup with Scheduled Task

The repository now also includes:

- [register-rocksolid-postgres-backup-task.ps1](/D:/code/OnlineVerification/deploy/windows/register-rocksolid-postgres-backup-task.ps1)
- [unregister-rocksolid-postgres-backup-task.ps1](/D:/code/OnlineVerification/deploy/windows/unregister-rocksolid-postgres-backup-task.ps1)

Register the daily PostgreSQL backup task:

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\register-rocksolid-postgres-backup-task.ps1
```

Default task settings:

- task name: `RockSolidLicensePostgresBackup`
- run account: `SYSTEM`
- schedule: every day at `03:35`

Remove the task later if needed:

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\unregister-rocksolid-postgres-backup-task.ps1
```

## Recommended restore drill

Do not wait for a real outage to test PostgreSQL recovery.

Suggested drill:

1. Run an app backup so token keys and env files are current.
2. Run a PostgreSQL dump with the new PostgreSQL backup script.
3. Restore the dump to a staging database or recovery target.
4. Start the app against that restored target.
5. Verify `/api/health`.
6. Log into the admin console.
7. Run one client login and one heartbeat.

## What these scripts do not replace

These scripts are helpful, but they do not replace:

- storage-level snapshots
- managed PostgreSQL backup features
- monitoring on replication, disk growth, or WAL retention
- app-key backups for `license_private.pem`, `license_public.pem`, and `license_keyring.json`

For a real production plan, keep both layers:

- app backup
- PostgreSQL backup
