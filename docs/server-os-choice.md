# Server OS Choice

For this repository, the default recommendation is:

- buy a Linux server

## Why Linux is the better fit here

- The current backend is a Node.js service and does not depend on Windows-only server components.
- The repo now includes Linux deployment assets:
  Docker, Docker Compose, Nginx, and systemd.
- PostgreSQL, Redis, reverse proxies, and container workflows are usually simpler and more common on Linux.
- Linux avoids the extra Windows Server licensing layer that often comes with hosted Windows instances.

## When Windows server would make sense

Buy Windows only if you specifically need one of these:

- IIS-only operational standards in your company
- Windows-only server-side COM/.NET Framework dependencies
- Active Directory or RDP-heavy admin workflows that must live on the same box
- Windows container standardization across an existing Windows estate

## Practical recommendation for this project

- Public production server: Linux
- Development workstation for the C/C++ SDK: Windows
- If budget is limited: Linux first, because it matches the current service stack better
