# Linux Deployment Guide

This repository now includes a Linux-oriented single-node deployment skeleton.

## Why Linux is the default deployment target here

This project currently fits Linux especially well because:

- the server is a Node.js service with no Windows-only runtime dependency
- Docker-based deployment is simpler and more common on Linux
- reverse proxy, TLS termination, and service management are typically easier to automate on Linux
- PostgreSQL, Redis, Nginx, and similar production components are most commonly operated on Linux

## Included deployment assets

- [Dockerfile](/D:/code/OnlineVerification/Dockerfile)
- [docker-compose.linux.yml](/D:/code/OnlineVerification/deploy/docker-compose.linux.yml)
- [rocksolid.conf](/D:/code/OnlineVerification/deploy/nginx/rocksolid.conf)
- [rocksolid.service](/D:/code/OnlineVerification/deploy/systemd/rocksolid.service)
- [rocksolid.env.example](/D:/code/OnlineVerification/deploy/rocksolid.env.example)

## Option A: Docker Compose on Linux

1. Install Docker Engine and the Docker Compose plugin.
2. Copy `deploy/rocksolid.env.example` to `deploy/rocksolid.env`.
3. Change the admin password before first boot.
4. From the `deploy` directory run:

```bash
docker compose -f docker-compose.linux.yml up -d --build
```

Default exposed ports:

- `80` for HTTP via Nginx
- `3000` for the app directly
- `4000` for the TCP gateway

## Option B: Direct systemd service

1. Install Node.js 24 on the Linux server.
2. Copy the repo to `/opt/rocksolidlicense`.
3. Create `/etc/rocksolidlicense/rocksolid.env`.
4. Install the service file from `deploy/systemd/rocksolid.service`.
5. Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable rocksolid
sudo systemctl start rocksolid
```

## Production notes

- Put HTTPS in front of the HTTP admin/API entrypoint.
- Keep `4000/tcp` open only if clients need the TCP transport.
- Back up the database and the RSA private key files together.
- If you rotate token keys, keep retired public keys published until old tokens expire.
- The current repo is still single-node storage by default because it uses SQLite.

## Recommended next production step

For real multi-instance deployment, move storage to PostgreSQL and add Redis for session and online-state coordination.
