# Alert Priority Guide

Use this guide to decide how urgent an alert really is before everyone starts paging each other.

This document is meant to reduce two common problems:

- under-reacting to a platform-wide outage
- over-reacting to one noisy but non-critical warning

Read this together with:

- [observability-guide.md](/D:/code/OnlineVerification/docs/observability-guide.md)
- [incident-response-playbook.md](/D:/code/OnlineVerification/docs/incident-response-playbook.md)
- [production-operations-runbook.md](/D:/code/OnlineVerification/docs/production-operations-runbook.md)

## Priority levels

### P1

Use `P1` when the platform is broadly unavailable or customers cannot use core licensing flows.

Typical examples:

- `/api/health` is failing for the production service
- admin/API is broadly unreachable
- login is failing for many users across multiple products
- heartbeat is failing broadly after login
- PostgreSQL main store is unavailable and core auth flows are failing
- TLS or reverse proxy is down and customers cannot reach the service

Expected response:

- wake a person immediately
- pause risky changes
- start incident handling now

### P2

Use `P2` when production is degraded in a meaningful way, but not fully down.

Typical examples:

- one major product cannot log in while others still work
- heartbeat failures are elevated but not total
- PostgreSQL dumps are stale even though the live service is still healthy
- Redis runtime state is unstable but core business data is still intact
- certificate expiry is close enough to be a real risk

Expected response:

- same-shift attention
- investigation should begin quickly
- fix before the issue grows into a P1

### P3

Use `P3` for operational issues that need work, but are not actively harming most users yet.

Typical examples:

- one backup job ran late but the latest backup is still recent enough
- disk usage is trending up but not critical yet
- warning-level login failure increase without clear customer impact
- dashboard or log shipping trouble while the core service remains healthy

Expected response:

- handle during normal working hours
- create a tracked follow-up if it cannot be fixed immediately

### P4

Use `P4` for informational or housekeeping issues.

Typical examples:

- noisy but known non-critical alerts
- documentation drift
- low-risk cleanup work
- expected test or staging signal that accidentally reached an ops channel

Expected response:

- do not wake anyone
- clean it up in routine maintenance

## Fast decision rules

Ask these questions in order:

1. Is the production service broadly unreachable?
2. Are core customer flows failing across multiple users or products?
3. Is this getting worse right now if nobody intervenes?
4. Is the risk operational only, or already customer-visible?

If the answer is "yes" to the first two, it is usually `P1`.

If the issue is real but still contained, it is usually `P2`.

If it only needs planned follow-up, it is usually `P3` or `P4`.

## Severity by symptom

- `health endpoint failing`
  Usually `P1`
- `public HTTPS down`
  Usually `P1`
- `all-product login failure spike`
  Usually `P1`
- `one-product login failure spike`
  Usually `P2`
- `heartbeat degradation after login`
  Usually `P1` or `P2` depending on scope
- `no fresh app backup within expected window`
  Usually `P2`
- `no fresh PostgreSQL dump within expected window`
  Usually `P2`
- `certificate nearing expiry warning`
  Usually `P2` before it becomes `P1`
- `disk usage warning with safe headroom left`
  Usually `P3`
- `log shipping or dashboard-only issue`
  Usually `P3`

## Escalation examples

- `One customer reports login trouble`
  Start as local investigation, not automatic `P1`
- `Multiple customers across different products report login trouble`
  Escalate quickly toward `P1`
- `Backups stopped overnight but service is still healthy`
  Usually `P2`
- `A stale PostgreSQL dump plus disk pressure plus query errors`
  Escalate toward `P1`

## Reclassification rule

Do not keep the first severity forever just because it was chosen first.

Reclassify upward when:

- more users are affected than first reported
- multiple products are now failing
- the health endpoint degrades
- storage or TLS issues become customer-visible

Reclassify downward when:

- the problem is isolated
- customer impact is lower than expected
- a false positive or noisy alert is confirmed

## Routing suggestion

- `P1`
  page immediately and open active incident handling
- `P2`
  alert the responsible operator the same shift
- `P3`
  send to the team channel or issue tracker
- `P4`
  keep as non-paging maintenance backlog
