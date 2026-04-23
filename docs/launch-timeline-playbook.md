# Launch Timeline Playbook

Use this guide when you want a time-based launch sequence instead of a topic-based checklist.

This document is meant for:

- the first commercial launch
- a cautious pilot launch
- a small real-user rollout before wider traffic

Read this together with:

- [production-launch-checklist.md](/D:/code/OnlineVerification/docs/production-launch-checklist.md)
- [production-operations-runbook.md](/D:/code/OnlineVerification/docs/production-operations-runbook.md)
- [daily-operations-checklist.md](/D:/code/OnlineVerification/docs/daily-operations-checklist.md)
- [incident-response-playbook.md](/D:/code/OnlineVerification/docs/incident-response-playbook.md)
- [developer-launch-mainline.md](/D:/code/OnlineVerification/docs/developer-launch-mainline.md)

## T minus 1 day

Focus:

- freeze risky config changes
- verify backups and restore path
- make sure the public entrypoint is stable

Checklist:

1. Confirm the chosen storage topology is final for launch week.
2. Run the host-side healthcheck.
3. Verify the public HTTPS entrypoint and `/api/health`.
4. Run one manual app backup.
5. If PostgreSQL is enabled, run one manual PostgreSQL dump too.
6. Confirm scheduled backups are enabled.
7. Confirm the admin account can still log in.
8. Confirm one test client can log in and send one heartbeat.
9. Confirm certificate expiry is not close to the launch window.
10. Avoid making non-essential policy or infrastructure changes after this point.
11. Open `/developer/launch-mainline` and confirm the current lane already has the latest `production-handoff`, `cutover-handoff`, and `recovery-drill-handoff` available for tomorrow's shift.

Recommended outcome:

- backups are fresh
- health is green
- one known-good client path works end to end

## Launch morning

Focus:

- confirm the system is healthy before real users arrive
- do not make large changes unless something is broken

Checklist:

1. Re-run the local healthcheck.
2. Confirm `GET /api/health` still returns `ok=true` and `data.status=ok`.
3. Confirm the reported main-store and runtime-state drivers are correct.
4. Check the newest app log lines.
5. Check the newest backup timestamps.
6. If PostgreSQL is enabled, check the newest dump timestamp too.
7. Confirm the proxy and TLS layer are healthy.
8. Confirm one admin login, one client login, and one heartbeat still succeed.
9. Use the current `cutover-handoff` from `/developer/launch-mainline` as the launch-duty checklist instead of rebuilding deploy, verify, and rollback notes by hand.

Do not start launch-day troubleshooting from user reports alone.

First verify the health endpoint and the last known-good internal checks.

## First 30 minutes after opening traffic

Focus:

- watch for broad failure patterns
- avoid overreacting to one isolated client report

Watch these first:

- login failure spikes
- heartbeat failure spikes
- reverse-proxy errors
- storage readiness changes
- sudden device-block or network-rule denial spikes

If something fails broadly:

1. pause new risky changes
2. capture logs and health state
3. use [incident-response-playbook.md](/D:/code/OnlineVerification/docs/incident-response-playbook.md)

If traffic is healthy, keep the lane moving through the current `post-launch-sweep-handoff` so the first routed runtime review does not drift into an unstructured manual recheck.

## First 4 hours

Focus:

- stabilize
- verify that success rates stay consistent

Checklist:

1. Scan logs at least twice.
2. Confirm backup jobs still look healthy.
3. Confirm there is no unusual certificate, proxy, PostgreSQL, or Redis warning.
4. Confirm no single project is failing due to feature toggles, notices, or version rules.
5. Keep one person watching infrastructure and one person watching auth behavior if possible.
6. Record the first-wave ops sweep in `/developer/launch-mainline` once the initial routed review has actually been completed.

## End of launch day

Focus:

- capture what happened while it is still fresh
- do not assume silence means success

Checklist:

1. Record whether any alerts fired.
2. Record whether any customer-visible auth or heartbeat issue occurred.
3. Record the exact time and scope of any incident.
4. Confirm fresh backup artifacts exist after launch traffic.
5. Decide whether the launch can stay in the current topology for the rest of the week.
6. Use the `closeout-handoff` and record the launch closeout review before handing the lane off to the next operating window.

## Day 2 to Day 7

Focus:

- keep the environment stable
- delay migrations unless there is a real reason

Checklist:

1. Use [daily-operations-checklist.md](/D:/code/OnlineVerification/docs/daily-operations-checklist.md) every day.
2. Review login and heartbeat behavior daily.
3. Review backup freshness daily.
4. If PostgreSQL is enabled, review dump freshness daily too.
5. Perform one restore drill during the first week if you did not already do one before launch.
6. Avoid large storage migrations during the first week unless the current path is actually failing.
7. Use the `stabilization-handoff` and record the launch stabilization review once the lane has had a quiet, steady-state observation window.

## Suggested rollout strategy

For a cautious first launch:

1. launch with a small number of trusted users first
2. observe for several hours
3. expand traffic gradually
4. only after the first week is stable, consider bigger storage or infrastructure changes

## When not to push wider traffic yet

Do not expand rollout if any of these are still true:

- `/api/health` is unstable
- backups are not fresh
- PostgreSQL dumps are stale when PostgreSQL is enabled
- login failures are already elevated
- heartbeat failures are already elevated
- the proxy or certificate layer is unstable

## Escalation rule of thumb

If the same error pattern appears in:

- multiple users
- multiple products
- both login and heartbeat
- or both internal checks and customer traffic

Treat it as a platform issue first, not a single-user issue.
