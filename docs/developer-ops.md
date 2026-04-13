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

- `eventType`
- `actorType`
- `limit`

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
