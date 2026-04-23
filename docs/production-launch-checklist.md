# Production Launch Checklist

This checklist is meant to help you take RockSolidLicense from "the server is running" to "the service is ready for real customers".

It is intentionally practical and is designed for both:

- a first Windows Server launch
- a first Linux single-node launch

After the first launch is complete, continue with:

- [production-operations-runbook.md](/D:/code/OnlineVerification/docs/production-operations-runbook.md)
- [launch-timeline-playbook.md](/D:/code/OnlineVerification/docs/launch-timeline-playbook.md)
- [launch-mainline-rehearsal.md](/D:/code/OnlineVerification/docs/launch-mainline-rehearsal.md)

## Phase 1: Server ready

- Buy a server with enough headroom for launch traffic.
- Make sure the machine clock is synced with NTP.
- Install `Node.js 24`.
- Put the repo in a stable path:
  - Windows: `C:\RockSolidLicense`
  - Linux: `/opt/rocksolidlicense`
- Create writable runtime directories for:
  - data
  - logs
  - backups

## Phase 2: Secrets and runtime config

- Copy the environment template before first boot.
- Change `RSL_ADMIN_PASSWORD`.
- Change `RSL_SERVER_TOKEN_SECRET`.
- Keep the env file outside public web roots.
- Confirm RSA key paths and database paths point to persistent storage.

Recommended first-launch storage choices:

- single-node pilot: `sqlite + sqlite`
- multi-instance preparation: `postgres + redis`

## Phase 3: Transport and firewall

- Decide whether clients really need the TCP gateway on `4000`.
- If not needed yet, keep `4000/tcp` closed externally.
- Put HTTPS in front of the HTTP admin/API entrypoint.
- Expose:
  - `443/tcp` publicly for admin/API
  - `80/tcp` only if you need HTTP to HTTPS redirect or ACME validation
  - `4000/tcp` only if the SDK uses TCP in production
- Keep `3000/tcp` private when a reverse proxy is present.

Useful reverse proxy examples in this repo:

- Linux Caddy: [Caddyfile.example](/D:/code/OnlineVerification/deploy/linux/Caddyfile.example)
- Linux Nginx TLS: [rocksolid.tls.conf.example](/D:/code/OnlineVerification/deploy/nginx/rocksolid.tls.conf.example)
- Windows Caddy: [Caddyfile.example](/D:/code/OnlineVerification/deploy/windows/Caddyfile.example)

## Phase 4: First boot checks

- Start the service manually once.
- Verify `GET /api/health` returns `ok=true` and `data.status=ok`.
- Verify the admin page opens through the intended URL.
- Verify the log file is being written.
- Verify token key files were created in the expected data directory.

Recommended smoke tests:

1. Log into the admin console.
2. Create one project.
3. Create one policy.
4. Create one card batch.
5. Register or card-login from a client flow.
6. Send a heartbeat.
7. Confirm the session shows up online and can be revoked.

## Phase 5: Backup and recovery

- Run one manual backup before taking traffic.
- Confirm the archive contains:
  - database
  - RSA private/public keys
  - keyring
  - environment file copy
- Turn on the scheduled backup job or timer.
- Perform one restore drill on a non-production directory or machine.
- If `RSL_MAIN_STORE_DRIVER=postgres`, also verify your PostgreSQL dump and restore path:
  - [postgres-backup-restore.md](/D:/code/OnlineVerification/docs/postgres-backup-restore.md)
  - make sure the PostgreSQL scheduled backup timer or task is enabled too

## Phase 6: Launch-day checks

- HTTPS certificate is valid.
- Admin login works through the public HTTPS URL.
- `/api/health` is healthy behind the proxy path you actually use, with `ok=true` and `data.status=ok`.
- Firewall or security group rules match your intended exposure.
- Time on the server is correct within a few seconds.
- At least one test client can:
  - login
  - receive a token
  - heartbeat successfully
- `/developer/launch-mainline` has fresh `Record Launch Rehearsal Run` evidence after one realistic release, smoke, review, ops, and mainline rehearsal.

## Phase 7: First-week operations

- Check logs every day for repeated auth or heartbeat failures.
- Watch backup output and retention cleanup.
- Confirm audit logs are being written.
- Watch active session counts and blocked-device events for anomalies.
- Delay any large storage migration until the single-node launch path is stable.

## Suggested order for a cautious first launch

1. Launch single-node first.
2. Put HTTPS and backups in place.
3. Run a small set of real users through the service.
4. Only after that, move main storage to PostgreSQL and runtime state to Redis.
