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

For the fastest staging setup, generate a secret-free profile draft first. This writes the ten launch-duty output paths under `artifacts/staging/<productCode>/<channel>/` and leaves passwords and bearer tokens out of the file:

```powershell
npm.cmd run staging:profile:init -- --json `
  --base-url https://staging.example.com `
  --product-code SMOKE_ALPHA `
  --channel stable `
  --admin-username admin@example.com `
  --developer-username launch.smoke.owner `
  --target-os linux `
  --storage-profile postgres-preview `
  --target-env-file /etc/rocksolidlicense/staging.env `
  --app-backup-dir /var/lib/rocksolid/backups `
  --postgres-backup-dir /var/lib/rocksolid/postgres-backups `
  --output-file .\artifacts\staging\SMOKE_ALPHA\stable\staging-rehearsal-profile.json
```

Review the generated JSON, set `$env:RSL_SMOKE_ADMIN_PASSWORD`, `$env:RSL_SMOKE_DEVELOPER_PASSWORD`, and `$env:RSL_DEVELOPER_BEARER_TOKEN` in the shell that will run rehearsal commands, then run `staging:rehearsal --profile-file <generated-profile.json>`. The JSON output also includes `readinessActionQueueFile`, `closeoutInitCommand`, and `postCloseoutInitStatusCommand`; keep those commands for the moment after rehearsal writes `filled-closeout-input.draft.json`. `staging:rehearsal` accepts `readinessActionQueueFile` in the profile and shows it as `readiness_action_queue` in the operator preflight recommended files, dry-run command, artifact manifest, launch rehearsal bundle, and final rehearsal packet local files. Those same rehearsal outputs now also print copyable `closeoutInit` and `readinessStatus` commands with `--actions-file <readiness-action-queue.md>`, so launch duty can initialize `filled-closeout-input.json` and refresh the same checklist without returning to the profile-init output.

After the profile-driven rehearsal writes `filled-closeout-input.draft.json`, initialize the real closeout input file from that draft before backfilling evidence:

```powershell
npm.cmd run staging:closeout:init -- --json `
  --draft-file .\artifacts\staging\SMOKE_ALPHA\stable\filled-closeout-input.draft.json `
  --output-file .\artifacts\staging\SMOKE_ALPHA\stable\filled-closeout-input.json `
  --actions-file .\artifacts\staging\SMOKE_ALPHA\stable\readiness-action-queue.md
```

This command removes the `exampleOnly` guard so the file can be loaded by `staging:rehearsal --closeout-input-file`, but it keeps every evidence value empty. The JSON output includes a `statusCommand`; when `--actions-file` is supplied, that command immediately writes or refreshes the readiness action queue and picks the first closeout backfill target. The reload must still report missing fields until real route-map, backup/restore, live-write smoke, receipt visibility, and operator go/no-go evidence are backfilled.

Backfill each real evidence item with `staging:closeout:backfill` as the artifacts and receipt IDs become available:

```powershell
npm.cmd run staging:closeout:backfill -- --json `
  --input-file .\artifacts\staging\SMOKE_ALPHA\stable\filled-closeout-input.json `
  --actions-file .\artifacts\staging\SMOKE_ALPHA\stable\readiness-action-queue.md `
  --key route_map_gate_result `
  --value-json '{"result":"pass","exitCode":0}' `
  --artifact-path artifacts/staging/SMOKE_ALPHA/stable/route-map-gate-output.txt `
  --receipt-id receipt-route-map-001
```

The JSON output includes both the compatible `nextCommand` rehearsal reload and a shorter `statusCommand`. When `--actions-file` is supplied, that `statusCommand` keeps the same checklist path, so launch duty can run the generated backfill command and then copy the returned status command to refresh the same action queue.

For the final closeout decision, write `operator_go_no_go` as object evidence so the same record carries the decision, operator, timestamp, and redacted summary. `staging:closeout:backfill`, `staging:readiness:status`, and `staging:rehearsal --closeout-input-file` all treat the object `decision` as the full-test-window gate:

```powershell
npm.cmd run staging:closeout:backfill -- --json `
  --input-file .\artifacts\staging\SMOKE_ALPHA\stable\filled-closeout-input.json `
  --actions-file .\artifacts\staging\SMOKE_ALPHA\stable\readiness-action-queue.md `
  --key operator_go_no_go `
  --value-json '{"decision":"ready-for-full-test-window","operator":"launch-duty","timestamp":"2026-05-08T10:00:00+08:00","summary":"redacted go/no-go approval"}' `
  --artifact-path artifacts/staging/SMOKE_ALPHA/stable/operator-go-no-go.md
```

At any point after `filled-closeout-input.json` exists, ask the local status command for the current gate and next command:

```powershell
npm.cmd run staging:readiness:status -- --json `
  --input-file .\artifacts\staging\SMOKE_ALPHA\stable\filled-closeout-input.json
```

When launch duty needs a handoff checklist instead of raw JSON, add `--actions-file`:

```powershell
npm.cmd run staging:readiness:status -- --json `
  --input-file .\artifacts\staging\SMOKE_ALPHA\stable\filled-closeout-input.json `
  --actions-file .\artifacts\staging\SMOKE_ALPHA\stable\readiness-action-queue.md
```

Use this after each closeout or sign-off backfill. It is read-only: it reports whether the current gate is `pre_full_test_closeout`, `full_test_window`, `production_signoff`, or `launch_day_watch`, lists the remaining closeout/sign-off/receipt visibility keys, prints the next `staging:closeout:backfill`, `npm.cmd test`, `staging:signoff:backfill`, or `staging:rehearsal --closeout-input-file` command, includes an `actionQueue` with the remaining local commands for the current launch gate, and can write a redacted Markdown action queue that marks the current executable item separately from blocked follow-up items. Each backfill row also includes expected evidence, a redacted `valueJsonExample`, artifact path hints, receipt operations, receipt ID guidance, and a copyable `exampleCommand` template so launch duty can replace placeholders and run the current row without cross-reading the full rehearsal packet. When `--actions-file` is present, the generated JSON `actionsFile.rerunCommand` and every row's `Status check` keep the same action-file path, so copying the status command after a backfill refreshes the same checklist. When the input file lives under `artifacts/staging/<productCode>/<channel>/`, the status command infers that artifact root and uses the concrete path in evidence hints and example commands.

After the full-test window completes, use `staging:signoff:backfill` to attach production sign-off evidence without hand-editing `productionSignoff.conditions`, `productionSignoff.decision`, or receipt visibility lanes:

```powershell
npm.cmd run staging:signoff:backfill -- --json `
  --input-file .\artifacts\staging\SMOKE_ALPHA\stable\filled-closeout-input.json `
  --actions-file .\artifacts\staging\SMOKE_ALPHA\stable\readiness-action-queue.md `
  --condition-key full_test_window_passed `
  --value-json '{"result":"pass","command":"npm.cmd test","failureCount":0}' `
  --artifact-path artifacts/staging/SMOKE_ALPHA/stable/full-test-output.txt `
  --receipt-id receipt-full-test-001 `
  --decision ready-for-production-signoff
```

Then backfill each receipt visibility lane as its latest receipt surface is verified:

```powershell
npm.cmd run staging:signoff:backfill -- --json `
  --input-file .\artifacts\staging\SMOKE_ALPHA\stable\filled-closeout-input.json `
  --actions-file .\artifacts\staging\SMOKE_ALPHA\stable\readiness-action-queue.md `
  --receipt-lane launchMainline `
  --value-json '{"status":"visible","summaryPath":"/developer/launch-mainline?productCode=SMOKE_ALPHA"}' `
  --artifact-path artifacts/staging/SMOKE_ALPHA/stable/launch-mainline-receipt-visibility.json `
  --receipt-id receipt-launch-mainline-001
```

Repeat that command until `statusCommand` reports `launch_day_watch`. Production sign-off remains blocked unless the closeout input is full-test ready, `productionSignoff.decision` is `ready-for-production-signoff`, every sign-off condition has evidence, and `launchMainline`, `launchReview`, `launchSmoke`, `developerOps`, and `launchOpsOverviewStatus` are visible.

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

Do not continue to `launch:smoke:staging --allow-live-writes` until this runner passes. Its output includes the redacted live-write smoke command, the recovery rehearsal commands, the scoped Launch Mainline URL, the evidence recording order, an `evidenceReadiness` block, and an `evidenceActionPlan` block. `evidenceReadiness` checks the selected lane, evidence endpoint, and whether `$env:RSL_DEVELOPER_BEARER_TOKEN` exists without printing the token value. `evidenceActionPlan` lists the real `POST /api/developer/launch-mainline/action` payload for each evidence action, the expected receipt operation, and a copyable PowerShell request that reads the developer bearer token from `$env:RSL_DEVELOPER_BEARER_TOKEN`. When `--handoff-file` is provided and the no-write gates pass, the runner also writes a local Markdown handoff pack with the same smoke, recovery, Launch Mainline, readiness, and executable evidence-action material, without printing or storing smoke passwords. If you need to debug a single gate, run `staging:preflight` or `recovery:preflight` directly.

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

Check `evidenceReadiness.readyToExecute` before copying these commands. If it is `false`, resolve `evidenceReadiness.nextAction` first. This readiness check is still no-write; it only confirms local command inputs and does not prove the remote token permission until the operator intentionally runs the evidence request.

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
