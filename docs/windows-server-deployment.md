# Windows Server Deployment Guide

This project can run on Windows Server as well.

## Recommended Windows deployment mode

For this repository, the cleanest Windows approach is:

- run the Node.js service directly on Windows Server
- use a Scheduled Task for auto-start
- optionally put IIS, Nginx for Windows, or a cloud load balancer in front of HTTP

## Included Windows deployment assets

- [rocksolid.env.ps1.example](/D:/code/OnlineVerification/deploy/windows/rocksolid.env.ps1.example)
- [run-rocksolid.ps1](/D:/code/OnlineVerification/deploy/windows/run-rocksolid.ps1)
- [register-rocksolid-task.ps1](/D:/code/OnlineVerification/deploy/windows/register-rocksolid-task.ps1)

## Suggested layout

```text
C:\RockSolidLicense
  src\
  deploy\
  data\
```

## Setup steps

1. Install Node.js 24 on the Windows Server.
2. Copy the repository to `C:\RockSolidLicense`.
3. Copy `deploy\windows\rocksolid.env.ps1.example` to:
   `C:\RockSolidLicense\deploy\windows\rocksolid.env.ps1`
4. Change the admin password before first start.
5. Start once manually:

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\run-rocksolid.ps1
```

6. Register auto-start:

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\register-rocksolid-task.ps1
```

## Ports

- `3000/tcp` for HTTP admin/API
- `4000/tcp` for the TCP gateway

## Reverse proxy options

If you want HTTPS and a cleaner public entrypoint:

- IIS as reverse proxy for the HTTP port
- Nginx on another machine
- Cloud load balancer / reverse proxy in front of the server

The TCP gateway usually stays on its own port unless you place a TCP load balancer in front of it.

## Important note

The repository's Docker deployment assets are Linux-oriented. That does not block Windows deployment, but it does mean:

- Linux currently has the smoother containerized path
- Windows currently has the smoother direct-host Node.js path in this repo
