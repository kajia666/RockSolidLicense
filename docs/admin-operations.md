# Admin Operations Guide

This document describes the new backoffice operations endpoints and the `/admin` console workflow.

## What operators can do now

- list customer accounts by product, status, and keyword
- disable or re-enable an account
- inspect device bindings for a user
- release a device binding to free a seat
- block a device fingerprint at the product level
- unblock a previously blocked device fingerprint
- inspect active or expired sessions
- revoke a session immediately
- create client version rules and forced-upgrade thresholds
- disable a client version or mark it for force update
- publish client announcements and maintenance notices
- temporarily block login with an active maintenance notice
- create resellers and allocate card-key inventory by channel
- trace whether reseller-allocated cards remain fresh or have been redeemed
- create IP / CIDR access rules for login, register, recharge, or heartbeat
- read recent audit logs

## HTTP endpoints

### Accounts

- `GET /api/admin/accounts`
- `POST /api/admin/accounts/:accountId/status`

Supported query parameters:

- `productCode`
- `status`
- `search`

Request body for status change:

```json
{
  "status": "disabled"
}
```

Effects:

- switching to `disabled` immediately expires the account's active sessions
- switching back to `active` allows the customer to log in again

### Device bindings

- `GET /api/admin/device-bindings`
- `POST /api/admin/device-bindings/:bindingId/release`
- `POST /api/admin/policies/:policyId/runtime-config`

Supported query parameters:

- `productCode`
- `username`
- `status`
- `search`

Release request body:

```json
{
  "reason": "operator_release"
}
```

Effects:

- marks the binding as released
- expires any active session currently using that binding
- allows the same device to bind again later if the customer logs in

Policy runtime config request body:

```json
{
  "allowConcurrentSessions": false,
  "bindMode": "selected_fields",
  "bindFields": ["machineGuid", "requestIp"]
}
```

Supported bind fields:

- `deviceFingerprint`
- `machineCode`
- `machineGuid`
- `cpuId`
- `diskSerial`
- `boardSerial`
- `biosSerial`
- `macAddress`
- `installationId`
- `requestIp`
- `publicIp`
- `localIp`

Notes:

- `allowConcurrentSessions` controls whether the product allows multiple live sessions for the same account
- `bindMode=strict` keeps the old exact-fingerprint behavior
- `bindMode=selected_fields` lets the author decide which hardware or IP signals count for rebinding detection
- changing bind fields affects future logins; existing bindings remain until they are revalidated or released

### Device blocks

- `GET /api/admin/device-blocks`
- `POST /api/admin/device-blocks`
- `POST /api/admin/device-blocks/:blockId/unblock`

Supported query parameters:

- `productCode`
- `status`
- `search`

Create block request body:

```json
{
  "productCode": "MY_SOFTWARE",
  "deviceFingerprint": "device-001",
  "reason": "fraud_risk",
  "notes": "manual operator review"
}
```

Unblock request body:

```json
{
  "reason": "appeal_approved"
}
```

Effects:

- blocking a device immediately expires active sessions for that fingerprint
- blocking also releases active seat bindings for the same fingerprint
- blocked fingerprints cannot log in until they are unblocked
- unblocking restores future login eligibility but does not recreate a session automatically

### Sessions

- `GET /api/admin/sessions`
- `POST /api/admin/sessions/:sessionId/revoke`

Supported query parameters:

- `productCode`
- `username`
- `status`
- `search`

Revoke request body:

```json
{
  "reason": "manual_review"
}
```

Effects:

- expires the selected session immediately
- future heartbeat requests for that `sessionToken` return `SESSION_INVALID`

### Client versions

- `GET /api/admin/client-versions`
- `POST /api/admin/client-versions`
- `POST /api/admin/client-versions/:versionId/status`

Supported query parameters:

- `productCode`
- `channel`
- `status`
- `search`

Create request body example:

```json
{
  "productCode": "MY_SOFTWARE",
  "version": "1.2.0",
  "channel": "stable",
  "status": "active",
  "forceUpdate": true,
  "downloadUrl": "https://example.com/download/app-1.2.0.exe"
}
```

Status update example:

```json
{
  "status": "disabled",
  "forceUpdate": false
}
```

Effects:

- disabled versions can be blocked on login and heartbeat
- active versions marked with `forceUpdate=true` define the minimum allowed version floor
- client startup can use `POST /api/client/version-check` to display upgrade guidance

### Resellers

- `GET /api/admin/resellers`
- `POST /api/admin/resellers`
- `POST /api/admin/resellers/:resellerId/status`
- `GET /api/admin/reseller-inventory`
- `GET /api/admin/reseller-inventory/export`
- `GET /api/admin/reseller-report`
- `GET /api/admin/reseller-price-rules`
- `POST /api/admin/reseller-price-rules`
- `POST /api/admin/reseller-price-rules/:ruleId/status`
- `GET /api/admin/reseller-settlement-report`
- `GET /api/admin/reseller-settlement/export`
- `GET /api/admin/reseller-statements`
- `POST /api/admin/reseller-statements`
- `GET /api/admin/reseller-statements/:statementId/items`
- `POST /api/admin/reseller-statements/:statementId/status`
- `GET /api/admin/reseller-statements/:statementId/export`
- `POST /api/admin/resellers/:resellerId/allocate-cards`

Effects:

- operators can create channel partners with their own reseller code
- disabled resellers cannot receive new inventory allocations
- reseller inventory remains traceable after the customer redeems a card
- recharge responses can now include reseller metadata for settlement or audit use
- filtered reseller inventory can now be exported as CSV
- reseller reporting now summarizes channel activity by reseller and by product
- active price rules can stamp pricing into newly allocated reseller inventory
- settlement reports and settlement CSV export can now be used for payout and reconciliation
- statements can now freeze a payout batch and move through draft, reviewed, and paid states

### Notices

- `GET /api/admin/notices`
- `POST /api/admin/notices`
- `POST /api/admin/notices/:noticeId/status`

Effects:

- active notices can be shown to the client during startup
- maintenance notices can temporarily block login when `blockLogin=true`
- archived notices stop affecting runtime behavior

### Network rules

- `GET /api/admin/network-rules`
- `POST /api/admin/network-rules`
- `POST /api/admin/network-rules/:ruleId/status`

Effects:

- active block rules can reject signed client traffic by IP or CIDR
- rules can be scoped globally or to a product
- rules can target `all`, `register`, `recharge`, `login`, or `heartbeat`

### Audit logs

- `GET /api/admin/audit-logs`

Supported query parameters:

- `limit`
- `eventType`
- `actorType`

## Console workflow

Open [console.html](/D:/code/OnlineVerification/src/web/console.html) through the server route:

- `http://127.0.0.1:3000/admin`

Recommended operator flow:

1. log in as admin
2. refresh the dashboard and list panels
3. click a row in accounts, bindings, blocked devices, or sessions
4. let the console auto-fill the selected ID
5. run disable, revoke, release, block, unblock, version-state updates, notice state updates, or network-rule updates
6. open the reseller center when you need channel inventory allocation or tracing
7. confirm the change in audit logs

## Operational notes

- releasing a device binding is a seat-management action, not a permanent blacklist
- device blocking is now the dedicated long-term control for suspicious fingerprints
- if you need appeal workflows later, keep block creation and unblock approval as separate audit-tracked actions
- version management is documented separately in [client-versioning.md](/D:/code/OnlineVerification/docs/client-versioning.md)
- notice management is documented separately in [notice-center.md](/D:/code/OnlineVerification/docs/notice-center.md)
- network access rules are documented separately in [network-security.md](/D:/code/OnlineVerification/docs/network-security.md)
- reseller operations are documented separately in [reseller-center.md](/D:/code/OnlineVerification/docs/reseller-center.md)
- current audit logs stay in the local database, so back them up with the SQLite file
- for higher-scale production, pair these APIs with PostgreSQL and Redis in a later phase
