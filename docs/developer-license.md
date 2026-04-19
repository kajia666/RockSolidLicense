# Developer License Center

The developer license workspace is available at `/developer/licenses`.

It is designed for software authors who need to manage policies and card inventory inside their own project scope without opening the admin backoffice.

The same page now also accepts routed query parameters such as `productId`, `productCode`, `channel`, `autofocus`, `routeTitle`, and `routeReason`. That lets `/developer/launch-workflow`, `/developer/projects`, or other routed actions drop a software author directly into:

- launch authorization quickstart review
- starter policy creation
- policy runtime / unbind controls
- starter card inventory and card status

without losing the current project context.

The page now also includes a `Launch Authorization Quickstart` block. It combines routed project context, scoped dashboard metrics, current feature config, policy inventory, and card inventory into one starter checklist so software authors can see:

- the current launch login mode and hardening posture
- whether starter policies already exist
- whether fresh cards are staged for direct-card login or recharge
- whether account-login launches still need open registration or seeded starter accounts

That quickstart block can also prefill the two most common launch templates:

- starter duration policy
- starter points policy

and it can prefill a starter card-batch draft using the current project code and the first active policy in scope.

## Scope

- owners can manage every product they own
- member accounts only see products explicitly assigned to them
- `viewer` members stay read-only
- write actions still follow the existing project-scoped permission checks

## Policy APIs

- `GET /api/developer/policies`
- `POST /api/developer/policies`
- `POST /api/developer/policies/:policyId/runtime-config`
- `POST /api/developer/policies/:policyId/unbind-config`

Typical creation body:

```json
{
  "productCode": "ALPHA_APP",
  "name": "Standard 30 Days",
  "grantType": "duration",
  "durationDays": 30,
  "maxDevices": 1,
  "allowConcurrentSessions": false,
  "heartbeatIntervalSeconds": 60,
  "heartbeatTimeoutSeconds": 180,
  "tokenTtlSeconds": 300,
  "bindMode": "selected_fields",
  "bindFields": ["machineGuid", "requestIp"],
  "allowClientUnbind": true,
  "clientUnbindLimit": 1,
  "clientUnbindWindowDays": 30,
  "clientUnbindDeductDays": 0
}
```

## Card APIs

- `GET /api/developer/cards`
- `GET /api/developer/cards/export`
- `GET /api/developer/cards/export/download`
- `POST /api/developer/cards/batch`
- `POST /api/developer/cards/:cardId/status`

Typical batch body:

```json
{
  "productCode": "ALPHA_APP",
  "policyId": "pol_xxx",
  "count": 50,
  "prefix": "ALPHA",
  "expiresAt": "2026-12-31T23:59:59+08:00",
  "notes": "Spring promotion"
}
```

Typical card control body:

```json
{
  "status": "frozen",
  "expiresAt": null,
  "notes": "Suspicious distribution"
}
```

Supported card control statuses:

- `active`
- `frozen`
- `revoked`

## Filter support

The list endpoint, the legacy CSV export endpoint, and the download endpoint all accept:

- `productCode`
- `policyId`
- `batchCode`
- `usageStatus`
- `status`
- `search`

That keeps the page and exported inventory inside the current developer scope while still letting the author narrow results to a single policy or batch.

## Export delivery

- `GET /api/developer/cards/export` keeps returning CSV for backward compatibility.
- `GET /api/developer/cards/export/download` accepts `format=json|csv|summary|checksums|zip`.
- `summary` gives a human-readable project and batch recap for support handoff.
- `checksums` emits SHA-256 digests for the generated JSON, summary, and CSV files.
- `zip` bundles JSON, summary, CSV, and `SHA256SUMS.txt` into one delivery archive.

## Routed launch fixes

Launch workflow can now send a software author straight into this page when authorization-readiness detects:

- no starter policies
- no fresh cards for direct-card login
- no fresh cards for recharge / renewal
- no viable first-launch account path

When that happens, the page renders a `Route Focus` card, prefills the routed project code, and can scroll to the relevant policy or card controls so the author can fix the blocker faster.

If the blocker is really about the login model itself rather than policy or inventory, the same quickstart block can now send the software author back to `/developer/projects?autofocus=auth-preset` so the project-level authorization preset can be adjusted directly.
