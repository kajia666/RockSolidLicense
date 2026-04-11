# Reseller Center

This document describes the reseller / distributor inventory workflow that now lives at `/admin/resellers`.

## What operators can do now

- create channel resellers with a unique `code`
- disable or re-enable a reseller without deleting historical inventory
- allocate card batches to a reseller for a specific product and policy
- track every allocated card key back to the reseller and allocation batch
- inspect whether a reseller-issued card is still `fresh` or already `redeemed`

## HTTP endpoints

### Resellers

- `GET /api/admin/resellers`
- `POST /api/admin/resellers`
- `POST /api/admin/resellers/:resellerId/status`

Supported query parameters:

- `status`
- `search`

Create request example:

```json
{
  "code": "AGENT_EAST",
  "name": "East Region Partner",
  "contactName": "Zhang San",
  "contactEmail": "agent@example.com",
  "notes": "Primary Windows desktop reseller"
}
```

Status change example:

```json
{
  "status": "disabled"
}
```

Effects:

- disabling a reseller blocks future inventory allocations to that reseller
- disabling does not invalidate already-issued cards
- re-enabling allows allocation again without losing history

### Reseller inventory

- `GET /api/admin/reseller-inventory`
- `POST /api/admin/resellers/:resellerId/allocate-cards`

Supported query parameters:

- `resellerId`
- `productCode`
- `cardStatus`
- `search`

Allocate request example:

```json
{
  "productCode": "MY_SOFTWARE",
  "policyId": "pol_123",
  "count": 50,
  "prefix": "AGENT1",
  "notes": "2026Q2 launch batch"
}
```

Effects:

- allocation creates brand-new card keys and binds them to a reseller inventory record
- inventory records remain traceable after redemption
- when a customer redeems a reseller-issued card, the recharge response now includes reseller metadata
- audit logs record reseller creation, allocation, and status changes

## Operator workflow

Open [reseller-center.html](/D:/code/OnlineVerification/src/web/reseller-center.html) through:

- `http://127.0.0.1:3000/admin/resellers`

Recommended flow:

1. log in as admin
2. create a reseller with a stable code for channel settlement
3. prepare product and policy in the main console
4. allocate a batch to the reseller
5. inspect inventory by `fresh` and `redeemed`
6. use audit logs to confirm who created or changed a reseller record

## Notes

- a reseller is a commercial channel object, not an end-user account
- inventory is tied to both product and policy, so plan pricing and duration before batch allocation
- if you later add commission settlement, `allocationBatchCode` is a good anchor for reconciliation
