# Server Sizing Guide

This guide gives a practical starting point for buying a server for RockSolidLicense.

## Recommended default

If you want the safest first production purchase for this project:

- OS: Windows Server 2022 or Windows Server 2025
- CPU: 4 vCPU
- Memory: 8 GB
- Disk: 100 GB SSD
- Bandwidth: at least 5 Mbps public bandwidth or equivalent

That is enough for:

- the current Node.js service
- SQLite-based single-node deployment
- moderate admin usage
- a modest number of concurrent license heartbeats

## Three simple tiers

### Tier 1: Early launch

- 2 vCPU
- 4 GB RAM
- 60 GB SSD

Use this only if:

- traffic is still low
- you are validating the business model
- you can tolerate limited headroom

### Tier 2: Recommended starting production tier

- 4 vCPU
- 8 GB RAM
- 100 GB SSD

Use this if:

- you want a safer launch buffer
- you expect real customers rather than internal testing only
- you may add PostgreSQL or Redis later

### Tier 3: Heavier commercial use

- 8 vCPU
- 16 GB RAM
- 200 GB SSD

Use this if:

- you expect higher heartbeat volume
- you want room for database migration and monitoring tools
- you may colocate reverse proxy, database, and cache temporarily

## Windows vs Linux sizing

For the same budget:

- Linux usually gives you slightly better effective value
- Windows is still acceptable if it reduces your operational mistakes

For your situation, operator familiarity matters. If you manage Windows better today, a slightly more expensive Windows server can still be the right first choice.

## Storage note

Do not undersize the disk.

You need space for:

- database files
- RSA keys and keyring metadata
- audit logs
- crash dumps and diagnostics
- future backups

## Recommended next upgrade path

When business starts growing:

1. move from SQLite to PostgreSQL
2. add Redis for online-session coordination
3. separate reverse proxy and application service if needed
