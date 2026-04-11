# Reseller Center

This document describes the reseller / distributor inventory workflow that now lives at `/admin/resellers`.

Finance operations now also have a dedicated page at `/admin/resellers/finance`.

## What operators can do now

- create channel resellers with a unique `code`
- disable or re-enable a reseller without deleting historical inventory
- allocate card batches to a reseller for a specific product and policy
- track every allocated card key back to the reseller and allocation batch
- inspect whether a reseller-issued card is still `fresh` or already `redeemed`
- export filtered reseller inventory as CSV
- view aggregate report data by reseller and by product
- define reseller pricing rules per product or per policy
- inspect settlement totals and export settlement CSV

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
- `GET /api/admin/reseller-inventory/export`
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

### Reseller reports

- `GET /api/admin/reseller-report`

Supported query parameters:

- `resellerId`
- `productCode`
- `cardStatus`
- `search`

Effects:

- report output summarizes `total`, `fresh`, and `redeemed` channel keys
- `byReseller` helps identify which channel is consuming inventory fastest
- `byProduct` helps compare channel activity across software lines
- CSV export reuses the same filter rules as the inventory list

### Reseller price rules

- `GET /api/admin/reseller-price-rules`
- `POST /api/admin/reseller-price-rules`
- `POST /api/admin/reseller-price-rules/:ruleId/status`

Create request example:

```json
{
  "resellerId": "reseller_123",
  "productCode": "MY_SOFTWARE",
  "policyId": "pol_123",
  "currency": "CNY",
  "unitPrice": 99,
  "unitCost": 49,
  "notes": "stable desktop channel"
}
```

Effects:

- an active rule is resolved when new inventory is allocated to that reseller
- exact `reseller + product + policy` rules win over product-level default rules
- allocation stores a settlement snapshot, so later rule changes do not rewrite historical pricing
- archive old rules instead of deleting them

### Reseller settlement

- `GET /api/admin/reseller-settlement-report`
- `GET /api/admin/reseller-settlement/export`

Effects:

- settlement totals show priced vs unpriced keys
- redeemed totals show the finance-side amount that has actually converted into usage
- grouped settlement rows are separated by currency to avoid mixing totals across currencies
- CSV export is ready for reconciliation or manual payout workflows

## Operator workflow

Open [reseller-ops.html](/D:/code/OnlineVerification/src/web/reseller-ops.html) through:

- `http://127.0.0.1:3000/admin/resellers`

Open [reseller-finance.html](/D:/code/OnlineVerification/src/web/reseller-finance.html) through:

- `http://127.0.0.1:3000/admin/resellers/finance`

Recommended flow:

1. log in as admin
2. create a reseller with a stable code for channel settlement
3. prepare product and policy in the main console
4. allocate a batch to the reseller
5. inspect inventory by `fresh` and `redeemed`
6. load the report panel to review reseller and product aggregates
7. export filtered inventory when finance, channel support, or audit needs an extract
8. use audit logs to confirm who created or changed a reseller record

Recommended finance flow:

1. define an active price rule before allocating a batch
2. allocate inventory so settlement snapshots are captured immediately
3. review settlement by currency, reseller, and product
4. export settlement CSV for accounting or payout review

## Notes

- a reseller is a commercial channel object, not an end-user account
- inventory is tied to both product and policy, so plan pricing and duration before batch allocation
- if you later add commission settlement, `allocationBatchCode` is a good anchor for reconciliation
