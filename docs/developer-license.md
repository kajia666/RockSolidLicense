# Developer License Center

The developer license workspace is available at `/developer/licenses`.

It is designed for software authors who need to manage policies and card inventory inside their own project scope without opening the admin backoffice.

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

Both the list and CSV export endpoints accept:

- `productCode`
- `policyId`
- `batchCode`
- `usageStatus`
- `status`
- `search`

That keeps the page and exported inventory inside the current developer scope while still letting the author narrow results to a single policy or batch.
