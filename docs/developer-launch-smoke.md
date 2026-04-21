# Developer Launch Smoke

The developer launch smoke workspace is available at `/developer/launch-smoke`.

This workspace is the smoke-validation step between launch preparation and launch review.

Use it when the software author or launch-duty teammate needs one place to:

- inspect the staged startup bootstrap request
- review which login or recharge smoke paths are actually ready
- see candidate internal accounts, starter entitlements, and fresh launch-card keys
- run `Launch Bootstrap`, `First Batch Setup`, or `Inventory Refill` directly when the smoke lane is still missing starter assets
- keep the latest smoke-action receipt and follow-up steps visible in the same workspace
- move straight into the most relevant review target, such as accounts, entitlements, card inventory, sessions, or audit
  When possible, the routed workspace also carries the first direct focus object so the next workspace can prepare the primary review target automatically.
- see a dedicated `Primary Review Target` before the broader target list, so launch-duty teammates can open the most important follow-up first
- jump into the next recommended workspace for runtime follow-up
- download a smoke-validation handoff as `json / summary / checksums / zip`

Compared with the broader `/developer/launch-workflow` page, this workspace is narrower and more execution-oriented.

- `Launch Workflow` is still the control tower for release, startup, authorization, and handoff state.
- `Launch Smoke` is the practical smoke-test workspace for the first internal login, recharge, and heartbeat validation pass.
- `Launch Review` remains the combined recheck workspace after launch initialization or smoke validation has already run.

The page consumes:

- `GET /api/developer/launch-smoke-kit`
- `GET /api/developer/launch-smoke-kit/download`

It also preserves routed project and lane context from nearby workspaces such as:

- `/developer/projects`
- `/developer/licenses`
- `/developer/launch-workflow`
- `/developer/launch-review`

That means the same `productCode`, `channel`, and route context can flow straight into smoke validation without the software author rebuilding the lane by hand.
