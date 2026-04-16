# Daily Operations Checklist

Use this checklist for quick day-to-day service checks after the system is already online.

This document is intentionally shorter than the main operations runbook.

Read this together with:

- [production-operations-runbook.md](/D:/code/OnlineVerification/docs/production-operations-runbook.md)
- [incident-response-playbook.md](/D:/code/OnlineVerification/docs/incident-response-playbook.md)
- [postgres-backup-restore.md](/D:/code/OnlineVerification/docs/postgres-backup-restore.md)
- [observability-guide.md](/D:/code/OnlineVerification/docs/observability-guide.md)

## Start of day

1. Run the local healthcheck.
2. Confirm the public HTTPS URL still opens.
3. Confirm `/api/health` still reports:
   - `GET /api/health`
   - `ok=true`
   - `data.status=ok`
4. Confirm the reported storage drivers still match your intended deployment.

Linux:

```bash
/opt/rocksolidlicense/deploy/linux/healthcheck-rocksolid.sh
```

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\healthcheck-rocksolid.ps1
```

## Backup freshness

Check at least once per day:

1. the newest app backup file exists
2. the timestamp is recent enough
3. the backup directory still has free space

If PostgreSQL is enabled, also check:

1. the newest `.dump` file exists
2. the PostgreSQL backup timer or scheduled task still ran

## Log scan

Check the newest app logs for repeated patterns such as:

- login failures across many users
- heartbeat failures after login
- signature or timestamp validation failures
- repeated device-block or network-rule hits
- storage connection failures
- proxy or TLS renewal failures

Keep this scan short but consistent:

- last `100` to `200` lines at minimum
- longer if a user already reported trouble

## Storage checks

For SQLite:

- confirm the data file still exists
- confirm free disk space is healthy

For PostgreSQL:

- confirm the database is reachable
- confirm the latest dump file is fresh

For Redis:

- confirm the runtime-state store is reachable
- confirm memory and disk are not under obvious pressure

## Auth path spot check

At least once per day, verify one full client path:

1. one admin login
2. one client login
3. one heartbeat

If possible, use a non-production test account or internal project for this check.

## End of day

Before ending the day or handoff:

1. note any repeated warnings or unusual error patterns
2. note whether any backup job failed or ran late
3. note whether certificate expiry or proxy warnings appeared
4. if anything looks unstable, attach the exact timestamp and affected component

## Weekly minimum

Do not rely on daily checks alone.

At least once per week:

1. open one backup archive
2. run one small restore drill in a non-production target
3. confirm token-key publication still looks correct
4. confirm backup retention cleanup still works
