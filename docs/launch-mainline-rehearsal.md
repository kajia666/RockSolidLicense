# Launch Mainline Rehearsal Guide

Use this guide when you want one realistic rehearsal path for a first commercial launch lane instead of reassembling the flow from multiple launch pages.

This guide is meant for:

- a software author preparing a real rollout lane
- launch-duty teammates who need one rehearsal sequence before widening traffic
- QA or support teammates who need a concrete "what do we run next?" order

Read this together with:

- [developer-launch-workflow.md](/D:/code/OnlineVerification/docs/developer-launch-workflow.md)
- [developer-launch-smoke.md](/D:/code/OnlineVerification/docs/developer-launch-smoke.md)
- [developer-launch-review.md](/D:/code/OnlineVerification/docs/developer-launch-review.md)
- [developer-ops.md](/D:/code/OnlineVerification/docs/developer-ops.md)
- [developer-launch-mainline.md](/D:/code/OnlineVerification/docs/developer-launch-mainline.md)
- [production-launch-checklist.md](/D:/code/OnlineVerification/docs/production-launch-checklist.md)
- [launch-timeline-playbook.md](/D:/code/OnlineVerification/docs/launch-timeline-playbook.md)

## Goal

Take one concrete project and channel from:

- "release and startup inputs exist"

to:

- "the lane has been smoke-tested"
- "the first runtime review path is clear"
- "launch-day and first-week handoff material is ready"
- "the mainline evidence chain can be recorded in order"

This is not only a deployment rehearsal. It is the combined author-side rehearsal for:

- release packaging
- startup bootstrap
- starter inventory
- first login or recharge validation
- routed runtime review
- first-wave ops handoff
- closeout and stabilization handoff

## Inputs

Before starting, fix one lane:

- one `productCode`
- one `channel`
- one intended public entrypoint
- one intended storage/runtime topology

For a staging API rehearsal, run the no-write rehearsal runner before the live-write smoke step:

```powershell
npm.cmd --silent run staging:rehearsal -- --json `
  --base-url https://staging.example.com `
  --product-code SMOKE_ALPHA `
  --channel stable `
  --admin-username admin@example.com `
  --admin-password $env:RSL_SMOKE_ADMIN_PASSWORD `
  --developer-username launch.smoke.owner `
  --developer-password $env:RSL_SMOKE_DEVELOPER_PASSWORD `
  --target-os linux `
  --storage-profile postgres-preview `
  --target-env-file /etc/rocksolidlicense/staging.env `
  --app-backup-dir /var/lib/rocksolid/backups `
  --postgres-backup-dir /var/lib/rocksolid/postgres-backups `
  --handoff-file .\artifacts\staging-rehearsal-handoff.md
```

Do not continue to `launch:smoke:staging --allow-live-writes` until this runner passes. Its output includes the redacted live-write smoke command, the recovery rehearsal commands, the scoped Launch Mainline URL, the evidence recording order, and an `evidenceActionPlan` block. That block lists the real `POST /api/developer/launch-mainline/action` payload for each evidence action, the expected receipt operation, and a copyable PowerShell request that reads the developer bearer token from `$env:RSL_DEVELOPER_BEARER_TOKEN`. When `--handoff-file` is provided and the no-write gates pass, the runner also writes a local Markdown handoff pack with the same smoke, recovery, Launch Mainline, and executable evidence-action material, without printing or storing smoke passwords. If you need to debug a single gate, run `staging:preflight` or `recovery:preflight` directly.

Use `--storage-profile sqlite` when the main store is SQLite. The option is named `--target-env-file` instead of `--env-file` because modern Node versions reserve `--env-file` as a runtime flag before the script can parse it.

Keep these outputs available during the rehearsal:

- release package summary
- launch workflow summary or checklist
- launch smoke kit summary
- launch review summary
- developer ops summary
- launch mainline summary

If you have to keep re-choosing project or channel while rehearsing, stop and narrow the lane first.

## Phase 1: Release And Workflow Precheck

Start in:

- `/developer/releases`
- `/developer/launch-workflow`

Confirm all of these before moving on:

1. The release lane points at the intended `productCode` and `channel`.
2. Version rules, notices, and startup defaults match the build you plan to ship.
3. `Launch Workflow` no longer has unresolved release or startup blockers.
4. If starter policy, starter account, or first launch inventory are still missing, run:
   - `Launch Bootstrap`
   - `First Batch Setup`
   - or `Inventory Refill`
5. Download the current lane handoff files that the next phases will depend on:
   - launch workflow summary
   - launch smoke kit summary
   - launch review summary
   - launch mainline summary

Exit condition:

- the lane is no longer blocked by missing starter assets or obvious release/startup misconfiguration

## Phase 2: Smoke Validation

Continue in:

- `/developer/launch-smoke`

Run the most realistic internal path available for the lane:

1. Confirm the startup bootstrap request is the one you expect the client to use.
2. Pick one real smoke path:
   - account login
   - direct-card login
   - recharge flow
3. Use the staged smoke candidates instead of ad-hoc test data when possible:
   - account candidates
   - starter entitlements
   - fresh direct-card keys
   - fresh recharge keys
4. Confirm one successful login or recharge path completes.
5. Confirm one heartbeat succeeds after login.
6. Download the smoke kit summary if QA or support will repeat the same pass.

Exit condition:

- at least one realistic internal path has completed login and heartbeat successfully for the current lane

## Phase 3: Review The First Runtime Signals

Continue in:

- `/developer/launch-review`
- `/developer/ops`

The goal here is not only "smoke passed". The goal is "the first runtime follow-up can be reviewed without rebuilding filters."

Run this order:

1. Open the `Primary Review Target` from `Launch Review`.
2. In `/developer/ops`, use the routed `Primary Match` first.
3. Review the `Next Match` if one exists.
4. Export or hand off the `Primary Match Summary` when another teammate needs the same review target.
5. If the queue is larger than one item, keep the `remaining routed review queue` together instead of breaking it into manual ad-hoc searches.

Things to confirm:

- the expected account, entitlement, session, device, or audit event appears in the routed review
- the first runtime object can be explained from existing filters and not only from memory
- any anomalies are visible in the same scoped ops view

Exit condition:

- the first runtime review path is clear and the routed follow-up no longer depends on hand-built filters

## Phase 4: Production Readiness And Launch-Day Handoffs

Continue in:

- `/developer/launch-mainline`

Use the production gate as the final control point for this lane.

Confirm the gate is not blocked by foundational production problems such as:

- default secrets
- loopback entrypoints
- single-host readiness mismatches
- HTTP exposure where HTTPS is expected
- missing token-key depth

Download and inspect the current handoff files in this order:

1. `production-handoff`
2. `cutover-handoff`
3. `recovery-drill-handoff`
4. `operations-handoff`
5. `post-launch-sweep-handoff`
6. `closeout-handoff`
7. `stabilization-handoff`

Use them for these purposes:

- `production-handoff`
  deployment, storage, healthcheck, and backup/restore material
- `cutover-handoff`
  launch-day deploy, verify, and rollback readiness
- `recovery-drill-handoff`
  explicit backup and restore rehearsal
- `operations-handoff`
  first-wave monitoring and incident response expectations
- `post-launch-sweep-handoff`
  first routed runtime review after traffic opens
- `closeout-handoff`
  end-of-day first-wave closeout
- `stabilization-handoff`
  first steady-state handoff into normal daily operations

Exit condition:

- the lane has one consistent author-side handoff path from deployment through first-week stabilization
- `staging:rehearsal` has confirmed the smoke command, recovery command, Launch Mainline URL, evidence order, and `evidenceActionPlan` payloads before any live-write smoke run begins

## Phase 5: Evidence Recording Order

Once the lane has actually been rehearsed or observed, record evidence in `/developer/launch-mainline` in this order:

1. `Record Launch Rehearsal Run`
2. `Record Recovery Drill`
3. `Record Backup Verification`
4. `Record Operations Walkthrough`
5. `Record Deploy Verification`
6. `Record Health Verification`
7. `Record Rollback Walkthrough`
8. `Record Cutover Walkthrough`
9. `Record Launch Day Readiness Review`
10. `Record First-Wave Ops Sweep`
11. `Record Launch Closeout Review`
12. `Record Launch Stabilization Review`

When using the CLI runner, use `evidenceActionPlan.endpoint` with the matching entry from `evidenceActionPlan.items`. The plan and item together contain:

- `endpoint`
  `POST /api/developer/launch-mainline/action`
- `payload.productCode`
  the selected rehearsal project
- `payload.channel`
  the selected rehearsal channel
- `payload.operation`
  the backend operation key, such as `record_launch_rehearsal_run` or `record_backup_verification`
- `expectedReceiptOperation`
  the receipt operation you should see after the action succeeds
- `request.powershell`
  a copyable `Invoke-RestMethod` command that posts the payload with `Authorization: Bearer $env:RSL_DEVELOPER_BEARER_TOKEN`

Why this order works:

- the early entries prove the production path is recoverable
- the middle entries prove the lane can actually be cut over safely
- the final entries prove the lane was reviewed, closed out, and handed into steady-state operations

The first entry is intentionally broad: `Record Launch Rehearsal Run` is the proof that the release, smoke, review, ops, and mainline lane was rehearsed as one chain before the narrower production evidence is treated as ready.

If the later evidence is recorded before the earlier steps are genuinely rehearsed, the gate may look green while the lane is still operationally weak.

## Rehearsal Exit Criteria

Treat the rehearsal as good enough for a cautious first rollout only when all of these are true:

1. One realistic internal login or recharge path succeeded.
2. One heartbeat succeeded after login.
3. The first routed runtime review path was actually opened and understood.
4. The mainline production gate is not blocked by basic production-readiness failures.
5. The current cutover, post-launch, closeout, and stabilization handoffs are downloadable for the lane.
6. The generated `staging-rehearsal-handoff.md` or equivalent local handoff pack is available to launch duty.
7. The operator can explain who will own:
   - launch-day cutover
   - first-wave review
   - end-of-day closeout
   - first steady-state handoff

## When To Stop The Rehearsal

Stop and fix the lane before widening traffic if any of these stay true:

- launch workflow still needs bootstrap or starter inventory work
- smoke validation cannot complete one realistic path
- routed review only works when someone manually rebuilds filters
- launch mainline is still blocked by default secrets, loopback endpoints, or wrong topology
- handoff material exists in code or docs, but the current lane cannot actually download it

## Suggested Minimal Artifact Set

If you only hand one small pack to another teammate after rehearsal, use:

1. launch workflow summary
2. launch smoke kit summary
3. launch review summary
4. developer ops primary match summary
5. launch mainline summary
6. rehearsal-guide
7. cutover-handoff
8. post-launch-sweep-handoff
9. closeout-handoff
10. stabilization-handoff

That pack is usually enough for QA, support, release duty, or launch-duty handoff without asking them to reconstruct the lane from memory.
