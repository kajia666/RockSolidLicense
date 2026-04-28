# Production Operations Runbook

Use this runbook after the first-launch checklist has already been completed.

It is meant for day-one and early-production operations, where the main goal is to keep licensing, login, heartbeat, and token signing stable while the service starts taking real traffic.

For the author-side launch control path that now feeds those same operations handoffs, also keep:

- [developer-launch-mainline.md](/D:/code/OnlineVerification/docs/developer-launch-mainline.md)

## Read this together with

- [production-launch-checklist.md](/D:/code/OnlineVerification/docs/production-launch-checklist.md)
- [launch-timeline-playbook.md](/D:/code/OnlineVerification/docs/launch-timeline-playbook.md)
- [linux-deployment.md](/D:/code/OnlineVerification/docs/linux-deployment.md)
- [windows-deployment-guide.md](/D:/code/OnlineVerification/docs/windows-deployment-guide.md)
- [storage-deployment-guide.md](/D:/code/OnlineVerification/docs/storage-deployment-guide.md)
- [postgres-backup-restore.md](/D:/code/OnlineVerification/docs/postgres-backup-restore.md)
- [incident-response-playbook.md](/D:/code/OnlineVerification/docs/incident-response-playbook.md)
- [daily-operations-checklist.md](/D:/code/OnlineVerification/docs/daily-operations-checklist.md)
- [observability-guide.md](/D:/code/OnlineVerification/docs/observability-guide.md)
- [alert-priority-guide.md](/D:/code/OnlineVerification/docs/alert-priority-guide.md)
- [shift-handover-template.md](/D:/code/OnlineVerification/docs/shift-handover-template.md)
- [token-key-rotation.md](/D:/code/OnlineVerification/docs/token-key-rotation.md)

## What healthy looks like

The main liveness endpoint is:

- `GET /api/health`

The response should include both:

- `ok=true`
- `data.status=ok`

The storage section should also match the deployment you intended to run:

- `data.storage.mainStore.driver`
- `data.storage.runtimeState.driver`

If the service says `sqlite + sqlite` while you expected `sqlite + redis`, stop and verify your env file before taking more traffic.

## Daily 5-minute checks

For a shorter shift-style version of this section, also see:

- [daily-operations-checklist.md](/D:/code/OnlineVerification/docs/daily-operations-checklist.md)

1. Run the local healthcheck script.
2. Confirm the newest backup file exists and is recent enough.
3. Check the last `100` to `200` lines of the service log.
4. Confirm the public HTTPS entrypoint and `/api/health` both still work.
5. Check disk space for the data directory and backup directory.

Linux examples:

```bash
/opt/rocksolidlicense/deploy/linux/healthcheck-rocksolid.sh
tail -n 150 /var/log/rocksolid/rocksolid-server.log
ls -lt /var/lib/rocksolid/backups | head
```

Windows examples:

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\healthcheck-rocksolid.ps1
Get-Content C:\RockSolidLicense\logs\rocksolid-server.log -Tail 150
Get-ChildItem C:\RockSolidLicense\backups | Sort-Object LastWriteTime -Descending | Select-Object -First 5
```

Look for repeated patterns such as:

- login failures across many users
- heartbeat failures after login succeeds
- signature or timestamp validation failures
- repeated device-block or network-rule denials that were not expected

## First-wave launch duty handoff path

When the service has just opened traffic, use `/developer/launch-mainline` as the short author-side control tower for the first operating window. The practical order is:

1. `cutover-handoff`
   Use this during deployment and immediate verify/rollback readiness.
2. `post-launch-sweep-handoff`
   Use this once real traffic exists and the first routed runtime review should begin.
3. `closeout-handoff`
   Use this at the end of launch day when the first-wave review has actually been completed.
4. `stabilization-handoff`
   Use this during the first quiet steady-state window when launch duty hands the lane over to normal daily operations.

The matching evidence path in `/developer/launch-mainline` should usually be recorded in the same order:

1. `Record Launch Rehearsal Run`
2. `Record Cutover Walkthrough`
3. `Record Launch Day Readiness Review`
4. `Record First-Wave Ops Sweep`
5. `Record Launch Closeout Review`
6. `Record Launch Stabilization Review`

That sequence is useful because it keeps the end-to-end rehearsal, launch-day duty, launch closeout, and early steady-state handoff inside one verifiable chain instead of leaving the last mile to shift notes alone.

When `Record First-Wave Ops Sweep` is captured through `/api/developer/launch-mainline/action`, the returned receipt now also includes a `visibility` block, a `receipt_visibility` last-action section, matching handoff text, `receiptVisibility` inside Developer Ops latest launch receipts, and matching lines in the Developer Ops summary, launch receipt next-follow-up, handoff-index, Launch Review summary, Launch Smoke Kit summary, Launch Mainline post-launch handoff index, and Launch Mainline `format=handoff-download-routes` route-map downloads. These point directly to the next operator review locations: Developer Ops summary, launch receipt next follow-up, post-launch sweep handoff, post-launch handoff index, handoff download routes, Launch Review receipt visibility summary, and Launch Smoke Kit receipt visibility summary. The same visibility block now carries the staging result backfill checklist, including the required route-map, backup/restore, live-write smoke, launch smoke handoff, Launch Mainline evidence receipt, and receipt-visibility review keys; the Launch Mainline / Developer Ops destinations; and a reminder not to paste passwords or bearer tokens into the backfill notes.

After `launch:smoke` or `launch:smoke:staging` passes, keep the CLI `handoff` JSON with the launch-duty notes. It now includes direct Launch Review summary and Launch Smoke Kit summary downloads before the Ops handoff index step, so the operator can verify those receipt-visibility sections without rebuilding the scoped routes by hand. If a reviewer needs the whole first-wave download map without extracting the Launch Mainline zip, use `/api/developer/launch-mainline/download?...&format=handoff-download-routes`; the file includes the Ops handoff index, Launch Mainline JSON/summary/checksums/zip routes, post-launch handoff index, and the Launch Review / Launch Smoke receipt-visibility summary hrefs. From Developer Ops, `/api/developer/ops/export/download?...&format=launch-mainline-handoff-routes` now provides a direct Ops-side copy of those Launch Mainline download hrefs, is included in the Ops zip/checksum package as `launch-mainline-handoff-routes.txt`, and appears in Ops readiness / handoff-index recommended downloads for first-wave review.

For logging, dashboard, and alert suggestions, also see:

- [observability-guide.md](/D:/code/OnlineVerification/docs/observability-guide.md)
- [alert-priority-guide.md](/D:/code/OnlineVerification/docs/alert-priority-guide.md)

## Weekly checks

1. Run one manual backup and verify the archive opens.
2. Perform one restore drill in a non-production path, VM, or staging machine.
3. Confirm scheduled backup automation is still enabled.
4. Review certificate expiry and proxy logs.
5. Review token key state and confirm the published key set still matches the active signer.

Recommended weekly endpoints:

- `GET /api/health`
- `GET /api/system/token-key`
- `GET /api/system/token-keys`

Suggested weekly order:

1. Check the newest app backup artifact.
2. If PostgreSQL is enabled, check the newest PostgreSQL dump artifact too.
3. Verify both backup schedules are still enabled.
4. Run one small restore drill on a non-production target.
5. Confirm the health endpoint and one real client login still work after the drill.

For shift-to-shift communication, also keep:

- [shift-handover-template.md](/D:/code/OnlineVerification/docs/shift-handover-template.md)

## Backup expectations by storage topology

### SQLite + SQLite

The current Linux and Windows backup scripts already cover the most important recovery inputs:

- `rocksolid.db`
- `license_private.pem`
- `license_public.pem`
- `license_keyring.json`
- runtime env file copy

### SQLite + Redis

Treat SQLite as the system of record for business data.

Redis in this topology is runtime state, not the main source of truth for:

- accounts
- cards
- entitlements
- policies
- product configuration

If Redis is lost, users may need to log in again and live session state may be rebuilt, but the main business data should still recover from SQLite plus the key files.

### PostgreSQL Preview + Redis

The current app backup scripts still matter because they preserve:

- token signing keys
- keyring metadata
- env configuration
- any file-based fallback data under the configured data directory

But they are not enough on their own for the PostgreSQL main store.

If `RSL_MAIN_STORE_DRIVER=postgres`, add one of these to your production backup plan:

- regular `pg_dump` exports
- volume snapshots for the PostgreSQL data volume
- database-level backup automation provided by your managed PostgreSQL service

Repository references:

- [backup-postgres.sh](/D:/code/OnlineVerification/deploy/postgres/backup-postgres.sh)
- [restore-postgres.sh](/D:/code/OnlineVerification/deploy/postgres/restore-postgres.sh)
- [backup-postgres.ps1](/D:/code/OnlineVerification/deploy/postgres/backup-postgres.ps1)
- [restore-postgres.ps1](/D:/code/OnlineVerification/deploy/postgres/restore-postgres.ps1)
- [rocksolid-postgres-backup.service](/D:/code/OnlineVerification/deploy/systemd/rocksolid-postgres-backup.service)
- [rocksolid-postgres-backup.timer](/D:/code/OnlineVerification/deploy/systemd/rocksolid-postgres-backup.timer)
- [register-rocksolid-postgres-backup-task.ps1](/D:/code/OnlineVerification/deploy/windows/register-rocksolid-postgres-backup-task.ps1)
- [postgres-backup-restore.md](/D:/code/OnlineVerification/docs/postgres-backup-restore.md)

For Redis in this topology, losing runtime state is usually survivable, but expect active sessions and heartbeat state to be rebuilt.

## Manual backup commands

Before a staging recovery drill, run the repository rehearsal runner from a checkout of this project. It does not back up, restore, run smoke, or modify data; it verifies that the selected OS/storage profile has the expected scripts, combines the smoke and recovery gates, prints the next commands to run on the target, and includes `environmentReadiness`, `operatorChecklist`, `resultBackfillSummary`, `receiptVisibilitySummaries`, `evidenceReadiness`, plus `evidenceActionPlan.items` for the later Launch Mainline evidence receipts. The environment readiness block tracks the public HTTPS entrypoint, non-default secret confirmation, persistent storage profile, backup/restore drill command keys, route-map gate execution, and explicit live-write approval without printing password values. The operator checklist orders the staging handoff from environment review, route-map gate, backup/restore drill, live-write approval, live-write smoke, smoke handoff archival, Launch Mainline opening, evidence recording, and receipt-visibility verification. The result backfill summary names the redacted result keys to carry forward into Launch Mainline and Developer Ops after the real staging run: route-map gate result, backup/restore drill result, live-write smoke result, launch smoke handoff, Launch Mainline evidence receipts, and receipt-visibility review. The evidence readiness block checks the target lane, evidence endpoint, and whether `$env:RSL_DEVELOPER_BEARER_TOKEN` exists without printing the token. Each evidence item also includes a copyable PowerShell request that posts to `/api/developer/launch-mainline/action` with `$env:RSL_DEVELOPER_BEARER_TOKEN`. Add `--handoff-file` when launch duty needs a local Markdown pack to carry the smoke command, the local `npm.cmd run launch:route-map-gate` targeted route-map and download-surface gate, recovery commands, Launch Mainline URL, Launch Review / Launch Smoke receipt-visibility summary downloads, environment readiness, operator checklist, result backfill summary, evidence readiness, evidence recording order, and evidence request snippets into the staging/live-write step without copying passwords into notes.

Linux PostgreSQL preview example:

```powershell
npm.cmd --silent run staging:rehearsal -- --json `
  --base-url https://staging.example.com `
  --product-code SMOKE_ALPHA `
  --channel stable `
  --admin-username admin@example.com `
  --admin-password $env:RSL_SMOKE_ADMIN_PASSWORD `
  --developer-username launch.smoke.owner `
  --developer-password $env:RSL_SMOKE_DEVELOPER_PASSWORD `
  --target-os linux `
  --storage-profile postgres-preview `
  --target-env-file /etc/rocksolidlicense/staging.env `
  --app-backup-dir /var/lib/rocksolid/backups `
  --postgres-backup-dir /var/lib/rocksolid/postgres-backups `
  --handoff-file .\artifacts\staging-rehearsal-handoff.md
```

Windows SQLite example:

```powershell
npm.cmd --silent run staging:rehearsal -- --json `
  --base-url https://staging.example.com `
  --product-code SMOKE_ALPHA `
  --channel stable `
  --admin-username admin@example.com `
  --admin-password $env:RSL_SMOKE_ADMIN_PASSWORD `
  --developer-username launch.smoke.owner `
  --developer-password $env:RSL_SMOKE_DEVELOPER_PASSWORD `
  --target-os windows `
  --storage-profile sqlite `
  --target-env-file C:\RockSolidLicense\deploy\windows\rocksolid.env.ps1 `
  --app-backup-dir C:\RockSolidLicense\backups `
  --handoff-file .\artifacts\staging-rehearsal-handoff.md
```

Use `recovery:preflight` directly when you only need to inspect the backup/restore command gate. Use `--target-env-file` here rather than `--env-file`; `--env-file` is a Node runtime option in newer Node versions and can be intercepted before the script runs.

Linux:

```bash
PROJECT_ROOT=/opt/rocksolidlicense \
ENV_FILE=/etc/rocksolidlicense/rocksolid.env \
/opt/rocksolidlicense/deploy/linux/backup-rocksolid.sh
```

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\backup-rocksolid.ps1
```

After each manual backup, verify:

- a new archive exists
- the archive contains the expected database and key files
- the archive timestamp matches the run you just performed

## Restore drill: SQLite-based deployments

Use this for:

- `sqlite + sqlite`
- `sqlite + redis`

Suggested drill:

1. Prepare a separate restore path or a staging machine.
2. Stop the app service before replacing files.
3. Extract the newest backup archive.
4. Restore `rocksolid.db`, token keys, keyring, and env file to the configured paths.
5. Start the app again.
6. Run the healthcheck script.
7. Log into the admin console with a known test account.
8. Verify one test client can log in and send one heartbeat.

If runtime state uses Redis, it is acceptable for online session state to start empty after the drill.

## Restore drill: PostgreSQL Preview + Redis

Use this when:

- `RSL_MAIN_STORE_DRIVER=postgres`
- `RSL_STATE_STORE_DRIVER=redis`

Suggested drill:

1. Restore the app key files and env file from the app backup archive.
2. Restore PostgreSQL from a dump or volume snapshot.
3. Start PostgreSQL and confirm it is reachable before starting the app.
4. Start the app and verify `GET /api/health`.
5. Treat Redis runtime state as rebuildable unless you have a separate persistence requirement for it.
6. Re-run one end-to-end login and heartbeat test.

Do not discover your PostgreSQL restore procedure for the first time during a real outage.

Practical commands now live in:

- [postgres-backup-restore.md](/D:/code/OnlineVerification/docs/postgres-backup-restore.md)

## TLS and reverse proxy maintenance

The app should normally sit behind HTTPS.

Current repo examples:

- Linux Caddy: [Caddyfile.example](/D:/code/OnlineVerification/deploy/linux/Caddyfile.example)
- Linux Nginx TLS: [rocksolid.tls.conf.example](/D:/code/OnlineVerification/deploy/nginx/rocksolid.tls.conf.example)
- Windows Caddy: [Caddyfile.example](/D:/code/OnlineVerification/deploy/windows/Caddyfile.example)

Operational reminders:

- Caddy usually renews certificates automatically, but still verify renewal is happening.
- If you use Nginx, IIS, Certbot, or a cloud load balancer, put certificate expiry on a recurring calendar reminder.
- After certificate renewal, verify the public admin URL and `/api/health` over HTTPS.
- Keep `3000/tcp` private when a reverse proxy is present.
- Only expose `4000/tcp` publicly if clients actually use TCP in production.

## Token key maintenance

Token signing keys are part of your recovery plan, not just a security feature.

Before rotating keys:

1. Confirm backups are recent.
2. Record the current active `kid`.
3. Confirm clients can fetch the full published key set.

After rotating keys:

1. Verify `GET /api/system/token-keys` publishes both the new active key and retired keys.
2. Keep retired public keys published long enough for older tokens to expire naturally.
3. If you suspect private-key compromise, treat it as a security incident and decide whether you also need forced session invalidation.

Reference:

- [token-key-rotation.md](/D:/code/OnlineVerification/docs/token-key-rotation.md)

## First-response playbooks

For a more detailed symptom-by-symptom recovery order, also see:

- [incident-response-playbook.md](/D:/code/OnlineVerification/docs/incident-response-playbook.md)

### Symptom: admin page or API is unreachable

1. Run the local healthcheck script on the host.
2. Check whether the app process or container is running.
3. Check the service log for startup errors, missing env values, port binding failures, or disk-full conditions.
4. If the app is healthy locally but not publicly reachable, inspect the reverse proxy, firewall, and DNS.

### Symptom: login fails or heartbeat drops for many clients

1. Verify the health endpoint first.
2. Check whether a maintenance notice or forced-version rule is blocking traffic.
3. Check whether a product-level feature toggle disabled register, login, recharge, or notices.
4. If runtime state uses Redis, verify Redis is reachable.
5. Check for server clock drift because timestamp-sensitive request validation depends on correct time.

### Symptom: storage backend problems

For SQLite:

- verify file path, permissions, free disk space, and whether the database file still exists

For PostgreSQL:

- verify the connection URL, credentials, `pg_isready`, and data-volume health
- verify the latest scheduled `pg_dump` job actually produced a fresh dump file

For Redis:

- verify `redis-cli ping`, AOF persistence status if enabled, and free disk space

### Symptom: suspected signing-key compromise

1. Pause and preserve evidence first.
2. Rotate signing keys.
3. Review whether you need to revoke active sessions.
4. Restore trust from known-good backups only after you understand the cause.
5. Communicate to software authors if they need to refresh published public keys or packaged integration assets.

## Recovery acceptance checklist

After any restore or outage recovery, do not stop at "the process is up".

Confirm all of the following:

- admin login works
- one project can be queried in the backoffice
- one test client can log in
- one heartbeat succeeds
- `/api/health` reports `ok=true` and `data.status=ok`
- the active token key set is readable
- the newest backup job still runs after recovery
