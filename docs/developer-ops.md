# Developer Authorization Operations

This page describes the developer-side authorization operations workspace exposed at `/developer/ops`.

The goal is simple:

- software authors can manage end-user authorization under their own projects
- delegated developer members can perform the same operations inside their assigned project scope
- no developer can inspect or modify another developer's customer data
- project-level SDK signing credentials can still be rotated from the developer project center when needed

## Dedicated UI

- `/developer/ops`

This page is intended for day-to-day authorization operations:

- inspect customer accounts
- freeze or re-enable an account
- inspect entitlements
- freeze, resume, extend, or adjust point entitlements
- inspect sessions and revoke them immediately
- inspect device bindings and release them
- block or unblock a device fingerprint
- read scoped developer audit logs
- use common audit presets and click an audit row to backfill matching filters and quick-control ids
- review focus account, session, and device detail lists directly from the snapshot overview, including severity, next-action hints, and a recommended action queue, and click them back into the active filters or quick controls
- use the `Escalate First` slice inside the scoped snapshot overview to jump straight into `Open Control` or `Load Full Context` for the highest-priority queue items
- the scoped snapshot now also keeps a `Prepared Control` recap after focus or escalation actions, so developers can reapply the same focus or jump back to the prepared quick-control target without rebuilding context by hand
- after a scoped quick-control action succeeds, the overview now also renders a `Last Action Result` recap with mitigation and follow-up guidance, so the developer can tell whether the current focus is resolved or still needs attention
- that recap no longer depends only on snapshot-origin focus clicks; it now also attempts to infer the active scoped target from the quick-control form itself, so table-driven operations can still produce a useful result recap
- the follow-up recap now also compresses scoped impact hints and adapts its next actions to the refreshed result state, so developers get a more specific "what now" path instead of the same generic buttons every time
- the same recap now also shows whether the object stayed inside or left `Escalate First`, which makes it easier to tell if a scoped high-priority item is truly de-escalated after an action
- the result recap now also keeps the current focus title/summary and matching snapshot-hit tags, so developers can see which scoped object was just handled without bouncing back to the tables
- export a scoped troubleshooting snapshot as JSON, summary text, checksums, or zip

## Developer APIs

- `GET /api/developer/accounts`
- `POST /api/developer/accounts/:accountId/status`
- `GET /api/developer/entitlements`
- `POST /api/developer/entitlements/:entitlementId/status`
- `POST /api/developer/entitlements/:entitlementId/extend`
- `POST /api/developer/entitlements/:entitlementId/points`
- `GET /api/developer/sessions`
- `POST /api/developer/sessions/:sessionId/revoke`
- `GET /api/developer/device-bindings`
- `POST /api/developer/device-bindings/:bindingId/release`
- `GET /api/developer/device-blocks`
- `POST /api/developer/device-blocks`
- `POST /api/developer/device-blocks/:blockId/unblock`
- `GET /api/developer/audit-logs`
- `GET /api/developer/ops/export`
- `GET /api/developer/ops/export/download`

## Supported query parameters

### Accounts

- `productCode`
- `status`
- `search`

### Entitlements

- `productCode`
- `username`
- `status`
- `grantType`
- `search`

### Sessions

- `productCode`
- `username`
- `status`
- `search`

### Device bindings

- `productCode`
- `username`
- `status`
- `search`

### Device blocks

- `productCode`
- `status`
- `search`

### Audit logs

- `productCode`
- `username`
- `search`
- `eventType`
- `actorType`
- `entityType`
- `limit`

### Ops snapshot export

- `productCode`
- `username`
- `search`
- `eventType`
- `actorType`
- `entityType`
- `limit`

The download route also accepts:

- `format=json|summary|checksums|zip`

## Role behavior

- `owner`
  Full control over all owned projects and all developer operations.
- `admin`
  Full control over assigned projects, including product feature toggles and authorization operations.
- `operator`
  Full control over authorization operations inside assigned projects, but cannot edit project feature toggles.
- `viewer`
  Read-only access to assigned projects, including account, entitlement, session, binding, block, and audit visibility.

## Isolation rules

- every developer operation re-checks the current actor against the target product
- list endpoints are pre-filtered to the actor's accessible project ids
- direct write operations return `403` when the target resource belongs to another project
- project transfers made by the platform admin apply immediately to developer operations too

## Operational effects

- disabling an account immediately revokes the customer's active sessions
- freezing an entitlement immediately revokes sessions bound to that entitlement
- extending an entitlement updates the license end time without creating a new card
- point adjustment works only for point-based entitlements
- revoking a session causes the next heartbeat to fail
- releasing a binding frees the device seat and expires any active session using that binding
- blocking a device fingerprint kicks matching sessions offline and prevents the device from logging in again until unblocked
- the ops snapshot zip bundles the current scoped project list, accounts, entitlements, sessions, bindings, blocks, and audit logs into one handoff package with SHA-256 checksums
- the ops snapshot preview and JSON payload now include an `overview` block with a headline, attention counters, highlight bullets, top audit-event counts, common reasons, a recommended action queue, and focus account/session/device detail lists with severity, next-action hints, and recommended-control metadata for faster scoped troubleshooting
- `/developer/ops` now also surfaces an `Escalate First` view for the most urgent queue items, including compressed impact tags and direct shortcuts into the quick-control form or full context loading flow
- the same scoped overview now renders a `Prepared Control` card once a focus item or escalation shortcut has primed a quick control, which makes repeated scoped handling less error-prone
- the scoped overview now also compares the focused object before and after a quick-control mutation, then renders a short mitigation/follow-up recap instead of forcing the developer to infer the result only from refreshed tables
- quick-control actions now try to infer the active target from the current account / entitlement / session / binding / block inputs as well, so a recap can still be generated even when the developer starts from a table row instead of the snapshot overview
- the mutation recap now also folds scoped impact hints into the follow-up section and retunes button labels around outcomes like mitigation, queue exit, lowered risk, or still-urgent objects
- that mutation recap now also tracks `Escalate First` entry/exit and priority changes, then exposes them as recap tags and mitigation guidance for scoped follow-up
- the recap now also keeps a lightweight per-object context card and `Snapshot hits` tag list, which makes scoped troubleshooting easier during repeated follow-up passes
- focus items in the `/developer/ops` overview can backfill username, reason, fingerprint, and quick-control ids so the next action starts from the right scoped target

The same workspace now also supports routed launch follow-up. When Launch Workflow or the inline project launch summary sends a software author into `/developer/ops`, the page can preserve `productId`, `productCode`, `channel`, `autofocus`, `routeTitle`, and `routeReason`, then show an `Ops Route Focus` card for `snapshot`, `audit`, `sessions`, `accounts`, `entitlements`, or `devices`.

Those routed links can also prefill scoped ops filters:

- `username`
- `search`
- `eventType`
- `actorType`
- `entityType`

That routed focus is meant to shorten the first post-launch loop:

- watch first sign-ins and heartbeat state from `snapshot`
- watch first card-redemption or launch-day anomalies from `audit`
- review early online sessions and device churn from `sessions` or `devices`
- jump back to Projects, Launch Workflow, Licenses, or Releases without rebuilding the current lane context by hand

The routed launch follow-up now also renders a `Route Review` block right inside `/developer/ops`. It summarizes the matching routed counts for accounts, entitlements, sessions, devices, and audit logs, keeps the highlighted audit-event list visible, and marks matching rows in the scoped tables with a `route-hit` state so launch-day follow-up is easier to scan without rebuilding filters by hand. That same block can now switch the page into a routed-hits-only review mode and jump straight into `accounts`, `entitlements`, `sessions`, `devices`, or `audit`, which shortens the first post-launch recheck loop after bootstrap, first-batch setup, or inventory refill. Launch Workflow and Launch Authorization Quickstart can now route into `/developer/ops` with `reviewMode=matched`, so those follow-up links land on the narrower review state immediately instead of asking the software author to toggle the slice first.
