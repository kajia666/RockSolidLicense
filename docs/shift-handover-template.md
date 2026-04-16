# Shift Handover Template

Use this template when handing production operations to another person or to the next day.

The goal is to avoid vague handoff messages like "looks mostly fine".

## Copy template

```text
Date / Time:
Operator:
Environment:

1. Current health
- /api/health status:
- Main store driver:
- Runtime state driver:
- Public HTTPS status:

2. Customer impact
- Any active customer-visible issue:
- Affected products or scope:
- Current severity (P1/P2/P3/P4):

3. Backups
- Latest app backup time:
- Latest PostgreSQL dump time (if enabled):
- Any backup failure or delay:

4. Logs and alerts
- Repeated warnings seen:
- Current alert still open:
- Any alert acknowledged but not resolved:

5. Storage and infra
- SQLite status:
- PostgreSQL status:
- Redis status:
- Proxy / TLS status:
- Disk space concerns:

6. Actions taken this shift
- Changes made:
- Services restarted:
- Temporary workaround applied:

7. Actions still pending
- Next thing to check:
- Deadline or urgency:
- Recommended owner:

8. Notes
- Relevant timestamps:
- Links to docs or commands used:
```

## Minimum handover standard

Before handoff, do not omit these:

- current health status
- any active customer-visible issue
- newest backup freshness
- unresolved alert state
- next action the next person should take

## Good handover example

```text
Date / Time: 2026-04-17 21:30
Operator: ops-a
Environment: production

1. Current health
- /api/health status: ok=true, data.status=ok
- Main store driver: sqlite
- Runtime state driver: redis
- Public HTTPS status: healthy

2. Customer impact
- Any active customer-visible issue: no broad issue confirmed
- Affected products or scope: one customer reported login retry problem, not reproduced broadly
- Current severity (P1/P2/P3/P4): P3

3. Backups
- Latest app backup time: 2026-04-17 03:15
- Latest PostgreSQL dump time (if enabled): n/a
- Any backup failure or delay: none

4. Logs and alerts
- Repeated warnings seen: small increase in login failures for one project
- Current alert still open: no
- Any alert acknowledged but not resolved: one warning ticket for follow-up

5. Storage and infra
- SQLite status: healthy
- PostgreSQL status: n/a
- Redis status: healthy
- Proxy / TLS status: healthy
- Disk space concerns: none

6. Actions taken this shift
- Changes made: none
- Services restarted: none
- Temporary workaround applied: none

7. Actions still pending
- Next thing to check: recheck project-specific login failures tomorrow morning
- Deadline or urgency: normal working hours
- Recommended owner: next day operator

8. Notes
- Relevant timestamps: 2026-04-17 19:20 first customer report
- Links to docs or commands used: daily-operations-checklist.md
```

## Bad handover example

Do not hand over like this:

```text
Everything seems okay.
One alert maybe.
Please keep an eye on it.
```

That kind of note loses:

- actual scope
- actual severity
- actual next action
- actual timing

## When to escalate instead of handing over

Do not quietly hand off a true `P1`.

If the system is broadly down, or core auth flows are failing across multiple users, escalate immediately and use:

- [alert-priority-guide.md](/D:/code/OnlineVerification/docs/alert-priority-guide.md)
- [incident-response-playbook.md](/D:/code/OnlineVerification/docs/incident-response-playbook.md)
