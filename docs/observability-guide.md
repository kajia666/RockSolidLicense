# Observability Guide

This guide describes a practical first production approach for logs, monitoring, and alerts.

It is intentionally operations-focused rather than tool-specific.

Read this together with:

- [production-operations-runbook.md](/D:/code/OnlineVerification/docs/production-operations-runbook.md)
- [daily-operations-checklist.md](/D:/code/OnlineVerification/docs/daily-operations-checklist.md)
- [incident-response-playbook.md](/D:/code/OnlineVerification/docs/incident-response-playbook.md)
- [alert-priority-guide.md](/D:/code/OnlineVerification/docs/alert-priority-guide.md)

## What to observe first

For a first commercial launch, observe these areas before chasing deeper dashboards:

- app liveness
- login success and failure patterns
- heartbeat success and failure patterns
- backup freshness
- PostgreSQL readiness if enabled
- Redis readiness if enabled
- certificate expiry and reverse-proxy health
- disk space for data, logs, and backups

## Minimum daily signals

You should be able to answer these quickly every day:

- Is `/api/health` healthy?
- Did backup jobs run on time?
- Are login failures suddenly higher than usual?
- Are heartbeat failures suddenly higher than usual?
- Is disk still healthy?
- Is TLS still valid?

If the answer to any of those is unknown, observability is not good enough yet.

## Logging guidance

At minimum, keep:

- app logs
- reverse-proxy access logs
- reverse-proxy error logs
- backup job output
- PostgreSQL backup job output if PostgreSQL is enabled

Recommended log retention direction:

- keep enough local logs for short incident review
- ship or archive logs elsewhere if the host has limited disk
- rotate logs before they compete with the database or backups

Useful patterns to search for:

- repeated auth failure bursts
- repeated heartbeat failure bursts
- signature or timestamp verification errors
- PostgreSQL connection failures
- Redis connection failures
- TLS renewal failures
- proxy upstream failures

## Suggested key indicators

### Availability

- local healthcheck success
- public HTTPS reachability
- `/api/health` success rate

### Authentication

- login success rate
- login failure count by product
- card-login failure count
- account-login failure count

### Session stability

- heartbeat success rate
- heartbeat failure count
- sudden session revocation spikes

### Storage

- SQLite disk usage
- PostgreSQL readiness and dump freshness
- Redis reachability and resource pressure

### Security-sensitive signals

- unusual device-block spikes
- unusual network-rule deny spikes
- unknown `kid` or token verification failures
- admin login failure bursts

## Suggested alert rules

Use low-noise rules first.

Recommended early alerts:

- `/api/health` fails repeatedly for several minutes
- no fresh app backup file within the expected window
- no fresh PostgreSQL dump file within the expected window
- certificate expiry enters the warning window
- disk space falls below a safe threshold
- PostgreSQL readiness fails repeatedly
- Redis readiness fails repeatedly

Recommended warning-level alerts:

- login failure rate suddenly spikes
- heartbeat failure rate suddenly spikes
- proxy upstream failures increase sharply
- token verification failures suddenly appear across many clients

For severity routing after an alert fires, also see:

- [alert-priority-guide.md](/D:/code/OnlineVerification/docs/alert-priority-guide.md)

## Alert routing advice

Keep the first version simple:

- critical alerts should wake a person
- warning alerts should open a ticket or go to a team channel
- noisy informational alerts should stay out of paging

If every alert pages, the team will start ignoring all of them.

## Dashboard suggestions

Your first dashboard does not need to be fancy.

A practical first page can be:

1. current health state
2. newest backup timestamps
3. login success and failure trend
4. heartbeat success and failure trend
5. disk usage
6. PostgreSQL and Redis readiness
7. TLS certificate days remaining

## Backup observability

Do not treat backups as "configured therefore safe".

Observe:

- last successful app backup time
- last successful PostgreSQL dump time
- backup size anomalies
- retention cleanup still working

If backups stop being fresh, that should be visible before an outage happens.

## A practical first stack

The repo does not force one monitoring vendor.

A reasonable first production stack could be:

- host-level process or container supervision
- reverse-proxy logs
- disk and memory monitoring
- a simple log search workflow
- one alert channel for warnings
- one alert channel for paging

Choose the simplest stack your team will actually maintain consistently.

## When to level up

Move beyond the minimum when:

- more than one operator depends on the system
- more than one production instance is online
- users are reporting issues before monitoring does
- backup or certificate issues are discovered manually too late
- login or heartbeat regressions become hard to distinguish from infrastructure trouble
