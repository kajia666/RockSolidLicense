# Developer Launch Smoke

The developer launch smoke workspace is available at `/developer/launch-smoke`.

This workspace is the smoke-validation step between launch preparation and launch review.

If you want the full rehearsal order around this step, including what should happen before and after smoke validation, also see:

- [launch-mainline-rehearsal.md](/D:/code/OnlineVerification/docs/launch-mainline-rehearsal.md)

Use it when the software author or launch-duty teammate needs one place to:

- inspect the staged startup bootstrap request
- review which login or recharge smoke paths are actually ready
- see candidate internal accounts, starter entitlements, and fresh launch-card keys
- run `Launch Bootstrap`, `First Batch Setup`, or `Inventory Refill` directly when the smoke lane is still missing starter assets
- keep the latest smoke-action receipt and follow-up steps visible in the same workspace
- move straight into the most relevant review target, such as accounts, entitlements, card inventory, sessions, or audit
  When possible, the routed workspace also carries the first direct focus object so the next workspace can prepare the primary review target automatically.
- see a dedicated `Primary Review Target` before the broader target list, so launch-duty teammates can open the most important follow-up first
  That primary target now also downloads a tighter `Primary match summary`, so the first follow-up file stays centered on the single routed object that smoke validation most needs to recheck.
- jump into the next recommended workspace for runtime follow-up
- download a smoke-validation handoff as `json / summary / checksums / zip`

Compared with the broader `/developer/launch-workflow` page, this workspace is narrower and more execution-oriented.

- `Launch Workflow` is still the control tower for release, startup, authorization, and handoff state.
- `Launch Smoke` is the practical smoke-test workspace for the first internal login, recharge, and heartbeat validation pass.
- `Launch Review` remains the combined recheck workspace after launch initialization or smoke validation has already run.

The page consumes:

- `GET /api/developer/launch-smoke-kit`
- `GET /api/developer/launch-smoke-kit/download`

The repository also includes a command-line launch smoke preflight:

```powershell
npm.cmd --silent run launch:smoke -- --json --product-code SMOKE_ALPHA
```

By default this command starts an ephemeral in-memory app, creates a smoke developer, creates a smoke project and policy, runs first batch setup, downloads the first-wave recommendation summary and checksums, confirms the first-wave handoff, and verifies the Developer Ops handoff index. This is the safest preflight for local or CI use because it does not touch persistent data.

When the preflight passes, the JSON output includes a `handoff` block. That block is the shortest launch-duty bridge into the next manual review step:

- `handoff.nextWorkspace` points to the scoped Launch Review workspace.
- `handoff.reviewWorkspaces.developerOps` points to the scoped Developer Ops watch.
- `handoff.reviewWorkspaces.launchMainline` points to the scoped Launch Mainline evidence workspace.
- `handoff.downloads.firstWaveSummary` and `handoff.downloads.firstWaveChecksums` point to the first-wave evidence files.
- `handoff.downloads.opsHandoffIndex` points to the Developer Ops handoff index.
- `handoff.operatorChecklist` lists the next five launch-duty actions in order: open Launch Review, verify first-wave confirmation evidence, download the Ops handoff index, continue the Developer Ops watch, and open Launch Mainline evidence.

The workspace routes intentionally carry `source=launch-smoke` and `handoff=first-wave`. `/developer/launch-review`, `/developer/ops`, and `/developer/launch-mainline` read those parameters as first-class route-focus context, display them in the handoff card, and keep them on the next workspace links so the launch-duty teammate does not need to re-enter where the review came from.

In local ephemeral mode these entries use routes only because the temporary app shuts down after the script exits. In remote `--base-url` mode they also include absolute `href` values.

Before running the remote write-path smoke against staging, generate or review a secret-free staging profile, validate it without loading secrets, then run the short profile-driven production proof preflight:

```powershell
npm.cmd run staging:profile:check -- `
  --profile-file artifacts/staging/SMOKE_ALPHA/stable/staging-rehearsal-profile.json

npm.cmd run launch:production-proof-preflight -- `
  --profile-file artifacts/staging/SMOKE_ALPHA/stable/staging-rehearsal-profile.json
```

`staging:profile:check` is a read-only profile lint step. It verifies the real-like HTTPS, storage, recovery, production-proof execution-pack path, single-argument production-proof command, and secret-free policy before the operator loads password or bearer-token environment variables. Its JSON result now includes `operatorHandoff`, and the plain output prints the production proof execution-pack path, required secret environment variable names, no-write boundary, guarded `launch_smoke_staging` gate, and normalized next command on the first screen. The generated profile already stores `productionProofExecutionPackFile`, so the profile-driven preflight command only needs `--profile-file` and still writes the secret-free Markdown execution pack. Older profiles that store the previous `--profile-file ... --execution-pack-file ...` command remain readable, but profile check and rehearsal normalize the next command to the single-argument form. `docs/staging-rehearsal-profile.example.json` is the committed secret-free starting point when preparing a new real-like profile.

If no profile file exists yet, use the direct no-write production proof preflight form:

```powershell
npm.cmd run launch:production-proof-preflight -- `
  --base-url https://staging.example.com `
  --product-code SMOKE_ALPHA `
  --channel stable `
  --target-os linux `
  --storage-profile postgres-preview `
  --target-env-file /etc/rocksolidlicense/staging.env `
  --app-backup-dir /var/lib/rocksolid/backups `
  --postgres-backup-dir /var/lib/rocksolid/postgres-backups `
  --admin-username admin@example.com `
  --developer-username launch.smoke.owner `
  --execution-pack-file artifacts/staging/SMOKE_ALPHA/stable/production-proof-execution-pack.md
```

Without `--execution-pack-file`, this command does not write live data or local files. When launch duty needs an artifact for cutover-day value keeping, add `--execution-pack-file` to write a local secret-free Markdown execution pack only; the file contains copyable commands and environment variable names, not password or bearer-token values. Its `Production proof real-environment input contract` section lists the non-secret CLI or env inputs, required secret environment variable names, missing or invalid fields, and the guarded `launch_smoke_staging` manual gate without printing password or bearer-token values. Its `Production proof execution queue` section then gives launch duty one ordered path: run `staging_profile_init`, run `recovery_preflight`, run `staging_preflight`, stop for explicit operator approval before `launch_smoke_staging`, and finish with the `staging_readiness_status` readback. The JSON response exposes the same machine-readable `productionProofExecutionQueue`, including the current action and current copyable command, so automation or a human operator does not need to rebuild the sequence from separate command fields. The same output now also emits a secret-free `productionProofExecutionPack`, which compresses the input-check status, the `0/5 -> 5/5` execution cursor, the first three no-write commands, the guarded manual live-write gate confirmation row, and the readiness readback command into one block. Its `noWriteContinuationHandoff` then repeats the execution-critical subset as a first-screen operator handoff: current no-write command, completed profile step, remaining no-write commands, live-write gate blocked-by list, and readiness readback. The shared Review, Smoke, Ops, and Mainline handoff surfaces mirror that pack and also expose `productionProofExecutionReadback`: the pack keeps the current cursor visible on the first screen, while the evidence-backed readback reports completed step count, current command, next command, and manual-gate status after each readiness refresh without treating unverified command execution as complete. Those backend/API handoff surfaces also derive `production-proof-execution-pack.md` and include `--execution-pack-file ...` in the copyable production-proof preflight command, so operators starting from Review, Smoke, Ops, or Mainline can generate the secret-free archive pack directly from their first-screen handoff. `staging:profile:init` now also prints the same production-proof preflight command with the derived `production-proof-execution-pack.md` path, and writes that path plus command into the generated `staging-rehearsal-profile.json`, so an operator who starts from profile initialization or receives only the profile artifact can still regenerate and archive the cutover proof pack without hand-building the file argument. After the input contract is ready, continue with the profile-driven no-write staging rehearsal:

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

The rehearsal runner checks that the staging base URL is HTTPS, the smoke credentials are present and non-default, the product/channel are explicit, and the backup/restore rehearsal command shape is ready. When it passes, the JSON output includes a redacted `nextCommands.launchSmoke` value for the real `launch:smoke:staging` run, so passwords stay in environment variables instead of being printed into handoff notes. It also includes `evidenceReadiness` for the target lane, evidence endpoint, and `$env:RSL_DEVELOPER_BEARER_TOKEN` presence, plus `evidenceActionPlan.items` for the later Launch Mainline evidence receipts. Those items use the real `/api/developer/launch-mainline/action` payloads and copyable PowerShell requests that read the developer bearer token from the environment. With `--handoff-file`, the same pass writes a local Markdown handoff pack for launch duty, containing the smoke command, recovery commands, Launch Mainline URL, evidence readiness, evidence order, and evidence request snippets without storing smoke passwords or bearer token values. `recovery:preflight` also emits `stagingContinuationHandoff`, which keeps the backup/restore closeout backfill command, the env-driven `staging:preflight` command, required smoke credential env names, readiness refresh, and the blocked `launch_smoke_staging` manual gate together after the recovery drill. If you only need to debug the smoke command gate, run `staging:preflight` directly.

To run the same write-path preflight against an already running staging API, use the staging wrapper. It adds `--require-https` so the rehearsal fails before writing if the base URL is accidentally pointed at plain HTTP:

```powershell
npm.cmd --silent run launch:smoke:staging -- --json `
  --base-url https://staging.example.com `
  --allow-live-writes `
  --admin-username admin@example.com `
  --admin-password $env:RSL_SMOKE_ADMIN_PASSWORD `
  --developer-username launch.smoke.owner `
  --developer-password $env:RSL_SMOKE_DEVELOPER_PASSWORD `
  --product-code SMOKE_ALPHA
```

Remote mode intentionally requires `--allow-live-writes` because it creates a developer, product, policy, first-batch card inventory, and a first-wave handoff confirmation. Use it for staging or a deliberately scoped production pilot project, not against an existing customer project.

The preceding `staging:preflight` output also includes `liveWriteSmokeHandoff`. That handoff keeps the exact `launch:smoke:staging` command, explicit closeout/action file paths, required smoke secret env names, expected post-smoke closeout backfill keys, readiness refresh, and the operator-confirmed `launch_smoke_staging` live-write gate together before the write command is run. After `launch:smoke:staging` succeeds, continue with its emitted `handoff.closeoutBackfill` queue to backfill `live_write_smoke_result`, `launch_smoke_handoff`, `launch_mainline_evidence_receipts`, and `receipt_visibility_review`. The same successful Launch Smoke result now also emits `handoff.postSmokeCloseoutHandoff`, which keeps the current closeout command, closeout/action files, readiness refresh command, remaining evidence keys, and blocked production sign-off gate together on the first screen. After those backfills are written, rerun `staging:readiness:status`; its `postSmokeReadinessBridge` reports the post-smoke closeout count, closeout readiness count, current full-test or sign-off command, `full_test_window_passed` backfill command, readiness refresh, and production sign-off gate in one readback. After the full-test result is backfilled with `staging:signoff:backfill --condition-key full_test_window_passed`, the script emits `postFullTestSignoffBridge`, which keeps the readiness refresh, next production sign-off backfill, launch-day watch blockers, and rehearsal reload together before the operator continues sign-off evidence. After the final receipt visibility lane is backfilled, `postReceiptVisibilityLaunchDayBridge` keeps the readiness refresh, rehearsal reload, production sign-off packet, launch-duty record index, `launch_day_watch_summary` command, and first-wave closeout artifact together for the launch-day watch handoff.

If you intentionally need to run a remote smoke against a local HTTP test server, keep using `launch:smoke` directly. For staging and launch rehearsal, prefer `launch:smoke:staging` so HTTPS enforcement is part of the command instead of a manual checklist item.

It also preserves routed project and lane context from nearby workspaces such as:

- `/developer/projects`
- `/developer/licenses`
- `/developer/launch-workflow`
- `/developer/launch-review`

That means the same `productCode`, `channel`, and route context can flow straight into smoke validation without the software author rebuilding the lane by hand.
