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

To run the same write-path preflight against an already running staging API, pass a base URL and explicit write consent:

```powershell
npm.cmd --silent run launch:smoke -- --json `
  --base-url https://staging.example.com `
  --allow-live-writes `
  --admin-username admin@example.com `
  --admin-password $env:RSL_SMOKE_ADMIN_PASSWORD `
  --developer-username launch.smoke.owner `
  --developer-password $env:RSL_SMOKE_DEVELOPER_PASSWORD `
  --product-code SMOKE_ALPHA
```

Remote mode intentionally requires `--allow-live-writes` because it creates a developer, product, policy, first-batch card inventory, and a first-wave handoff confirmation. Use it for staging or a deliberately scoped production pilot project, not against an existing customer project.

It also preserves routed project and lane context from nearby workspaces such as:

- `/developer/projects`
- `/developer/licenses`
- `/developer/launch-workflow`
- `/developer/launch-review`

That means the same `productCode`, `channel`, and route context can flow straight into smoke validation without the software author rebuilding the lane by hand.
