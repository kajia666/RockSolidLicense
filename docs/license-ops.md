# License Operations

This document covers the new operator-facing license management workflows that focus on card control and entitlement control.

## Card management

HTTP endpoints:

- `GET /api/admin/cards`
- `GET /api/admin/cards/export`
- `POST /api/admin/cards/:cardId/status`

Supported filters:

- `productCode`
- `policyId`
- `batchCode`
- `usageStatus`
- `status`
- `resellerId`
- `search`

Card list output now separates three concepts:

- `usageStatus`: whether the card is still `fresh` or already `redeemed`
- `controlStatus`: manual operator control state, one of `active`, `frozen`, or `revoked`
- `displayStatus`: operator-friendly merged status such as `unused`, `used`, `frozen`, `revoked`, or `expired`

Status update example:

```json
{
  "status": "frozen",
  "notes": "manual fraud review"
}
```

Expiring a card example:

```json
{
  "status": "active",
  "expiresAt": "2026-04-30T23:59:59.000Z"
}
```

Effects:

- frozen or revoked cards can no longer be recharged or used for direct card login
- expired cards are blocked automatically based on `expiresAt`
- if a redeemed card is frozen, active sessions issued from that source card are kicked offline
- CSV export is ready for operator audits or offline reconciliation

## Entitlement management

HTTP endpoints:

- `GET /api/admin/entitlements`
- `POST /api/admin/entitlements/:entitlementId/status`
- `POST /api/admin/entitlements/:entitlementId/extend`

Supported filters:

- `productCode`
- `username`
- `status`
- `search`

Lifecycle status values:

- `active`
- `frozen`
- `expired`

Freeze example:

```json
{
  "status": "frozen"
}
```

Extend example:

```json
{
  "days": 30
}
```

Effects:

- freezing an entitlement immediately expires active sessions under that authorization
- frozen entitlements reject new login requests with `LICENSE_FROZEN`
- extending an entitlement pushes `endsAt` forward without changing the source card or policy
- resuming an entitlement switches it back to `active`, after which login works again if the source card is still available

## Client-side behavior changes

The verification layer now checks both entitlement state and card control state:

- `CARD_FROZEN`
- `CARD_REVOKED`
- `CARD_EXPIRED`
- `LICENSE_FROZEN`
- `LICENSE_EXPIRED`

This means operators can independently control:

- whether a card can be consumed
- whether an already-issued authorization can stay active
- how long the authorization window should remain valid
