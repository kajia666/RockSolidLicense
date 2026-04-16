# Linux Deployment Guide

This repository now includes a Linux-oriented single-node deployment skeleton that is much closer to day-one production use.

## Why Linux is still the default production target here

Linux remains the best default fit for this project because:

- the backend is a Node.js service with no Windows-only server dependency
- reverse proxy, TLS termination, system services, PostgreSQL, and Redis are usually simpler to operate on Linux
- container workflows are more common and cheaper to run on Linux hosts
- the repo now includes Linux startup, healthcheck, backup, and systemd timer assets in addition to Docker / Nginx / systemd

## Included deployment assets

- [Dockerfile](/D:/code/OnlineVerification/Dockerfile)
- [docker-compose.linux.yml](/D:/code/OnlineVerification/deploy/docker-compose.linux.yml)
- [rocksolid.env.example](/D:/code/OnlineVerification/deploy/rocksolid.env.example)
- [rocksolid.conf](/D:/code/OnlineVerification/deploy/nginx/rocksolid.conf)
- [rocksolid.tls.conf.example](/D:/code/OnlineVerification/deploy/nginx/rocksolid.tls.conf.example)
- [rocksolid.service](/D:/code/OnlineVerification/deploy/systemd/rocksolid.service)
- [rocksolid-backup.service](/D:/code/OnlineVerification/deploy/systemd/rocksolid-backup.service)
- [rocksolid-backup.timer](/D:/code/OnlineVerification/deploy/systemd/rocksolid-backup.timer)
- [rocksolid-postgres-backup.service](/D:/code/OnlineVerification/deploy/systemd/rocksolid-postgres-backup.service)
- [rocksolid-postgres-backup.timer](/D:/code/OnlineVerification/deploy/systemd/rocksolid-postgres-backup.timer)
- [Caddyfile.example](/D:/code/OnlineVerification/deploy/linux/Caddyfile.example)
- [run-rocksolid.sh](/D:/code/OnlineVerification/deploy/linux/run-rocksolid.sh)
- [healthcheck-rocksolid.sh](/D:/code/OnlineVerification/deploy/linux/healthcheck-rocksolid.sh)
- [backup-rocksolid.sh](/D:/code/OnlineVerification/deploy/linux/backup-rocksolid.sh)

## Recommended paths

```text
/opt/rocksolidlicense
  src/
  docs/
  deploy/

/etc/rocksolidlicense
  rocksolid.env

/var/lib/rocksolid
  data/
  backups/

/var/log/rocksolid
  rocksolid-server.log
```

## Option A: Docker Compose on Linux

1. Install Docker Engine and the Docker Compose plugin.
2. Copy [rocksolid.env.example](/D:/code/OnlineVerification/deploy/rocksolid.env.example) to `deploy/rocksolid.env`.
3. Change at least:
   - `RSL_ADMIN_PASSWORD`
   - `RSL_SERVER_TOKEN_SECRET`
4. From the `deploy` directory run:

```bash
docker compose -f docker-compose.linux.yml up -d --build
```

Default exposed ports:

- `80` for HTTP via Nginx
- `3000` for the app directly
- `4000` for the TCP gateway

If you prefer automatic HTTPS with a lighter setup, you can also use:

- [Caddyfile.example](/D:/code/OnlineVerification/deploy/linux/Caddyfile.example)

## Additional compose profiles

If you want a more production-oriented storage setup than plain SQLite, the repo now also includes:

- [docker-compose.redis-runtime.yml](/D:/code/OnlineVerification/deploy/docker-compose.redis-runtime.yml)
  Recommended for earlier production because main business data stays on SQLite while runtime state moves to Redis.
- [docker-compose.pg-redis.preview.yml](/D:/code/OnlineVerification/deploy/docker-compose.pg-redis.preview.yml)
  Recommended for preview / staging / gradual migration because PostgreSQL main-store support is still staged.

Matching env templates:

- [rocksolid.redis-runtime.env.example](/D:/code/OnlineVerification/deploy/rocksolid.redis-runtime.env.example)
- [rocksolid.pg-redis.preview.env.example](/D:/code/OnlineVerification/deploy/rocksolid.pg-redis.preview.env.example)

Recommended reading:

- [storage-deployment-guide.md](/D:/code/OnlineVerification/docs/storage-deployment-guide.md)
- [postgres-backup-restore.md](/D:/code/OnlineVerification/docs/postgres-backup-restore.md)

## Option B: Direct systemd service

1. Install `Node.js 24`.
2. Copy the repo to `/opt/rocksolidlicense`.
3. Create a dedicated service account:

```bash
sudo useradd --system --create-home --home-dir /var/lib/rocksolid --shell /usr/sbin/nologin rocksolid
```

4. Create the runtime directories:

```bash
sudo install -d -o rocksolid -g rocksolid /etc/rocksolidlicense
sudo install -d -o rocksolid -g rocksolid /var/lib/rocksolid/data
sudo install -d -o rocksolid -g rocksolid /var/lib/rocksolid/backups
sudo install -d -o rocksolid -g rocksolid /var/log/rocksolid
```

5. Copy `deploy/rocksolid.env.example` to `/etc/rocksolidlicense/rocksolid.env` and update secrets.
6. Copy [rocksolid.service](/D:/code/OnlineVerification/deploy/systemd/rocksolid.service) to `/etc/systemd/system/rocksolid.service`.
7. Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable rocksolid
sudo systemctl start rocksolid
```

## Manual start

If you want to dry-run the service once before wiring systemd:

```bash
PROJECT_ROOT=/opt/rocksolidlicense \
ENV_FILE=/etc/rocksolidlicense/rocksolid.env \
/opt/rocksolidlicense/deploy/linux/run-rocksolid.sh
```

The script appends logs to:

- `/var/log/rocksolid/rocksolid-server.log`

## Healthcheck

You can run a simple HTTP + TCP check with:

```bash
/opt/rocksolidlicense/deploy/linux/healthcheck-rocksolid.sh
```

If you only want to verify the HTTP admin/API entrypoint:

```bash
/opt/rocksolidlicense/deploy/linux/healthcheck-rocksolid.sh --skip-tcp
```

## Backups

Run a manual backup with:

```bash
PROJECT_ROOT=/opt/rocksolidlicense \
ENV_FILE=/etc/rocksolidlicense/rocksolid.env \
/opt/rocksolidlicense/deploy/linux/backup-rocksolid.sh
```

The archive includes the files that currently matter most for recovery:

- `rocksolid.db`
- `license_private.pem`
- `license_public.pem`
- `license_keyring.json`
- `rocksolid.env`
- a small manifest describing the backup

The default output directory is:

- `/var/lib/rocksolid/backups`

Old archives older than `14` days are removed automatically by default.

If your main store is PostgreSQL instead of SQLite, also add host-level PostgreSQL dump and restore operations:

- [backup-postgres.sh](/D:/code/OnlineVerification/deploy/postgres/backup-postgres.sh)
- [restore-postgres.sh](/D:/code/OnlineVerification/deploy/postgres/restore-postgres.sh)
- [rocksolid-postgres-backup.service](/D:/code/OnlineVerification/deploy/systemd/rocksolid-postgres-backup.service)
- [rocksolid-postgres-backup.timer](/D:/code/OnlineVerification/deploy/systemd/rocksolid-postgres-backup.timer)
- [postgres-backup-restore.md](/D:/code/OnlineVerification/docs/postgres-backup-restore.md)

## Scheduled backups with systemd timer

1. Copy [rocksolid-backup.service](/D:/code/OnlineVerification/deploy/systemd/rocksolid-backup.service) to `/etc/systemd/system/rocksolid-backup.service`.
2. Copy [rocksolid-backup.timer](/D:/code/OnlineVerification/deploy/systemd/rocksolid-backup.timer) to `/etc/systemd/system/rocksolid-backup.timer`.
3. Enable the timer:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rocksolid-backup.timer
```

The current timer runs every day at `03:15`.

If you also enable the PostgreSQL preview main store path, you can add a second daily timer for `pg_dump`:

1. Copy [rocksolid-postgres-backup.service](/D:/code/OnlineVerification/deploy/systemd/rocksolid-postgres-backup.service) to `/etc/systemd/system/rocksolid-postgres-backup.service`.
2. Copy [rocksolid-postgres-backup.timer](/D:/code/OnlineVerification/deploy/systemd/rocksolid-postgres-backup.timer) to `/etc/systemd/system/rocksolid-postgres-backup.timer`.
3. Enable the timer:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rocksolid-postgres-backup.timer
```

The current PostgreSQL timer runs every day at `03:35`.

## Production notes

- Put HTTPS in front of the HTTP admin/API entrypoint.
- Keep `4000/tcp` open only if clients actually use the TCP transport.
- Back up the database and token private key files together.
- If you rotate token keys, keep retired public keys published until old tokens expire.
- SQLite is still the default single-node storage choice in this repo.

TLS-oriented reference files in the repo:

- simple container HTTP proxy: [rocksolid.conf](/D:/code/OnlineVerification/deploy/nginx/rocksolid.conf)
- host-level Nginx TLS example: [rocksolid.tls.conf.example](/D:/code/OnlineVerification/deploy/nginx/rocksolid.tls.conf.example)
- host-level Caddy example: [Caddyfile.example](/D:/code/OnlineVerification/deploy/linux/Caddyfile.example)

## Suggested first production upgrade

For a real multi-instance deployment, keep the same app layer and move:

- main data to PostgreSQL
- runtime state to Redis

That lets this architecture grow without throwing away the current codebase.
