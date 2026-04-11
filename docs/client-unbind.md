# Client Self-Unbind

RockSolidLicense now supports policy-controlled self-service unbind for end users.

This matches the common "network verification" behavior seen in commercial systems where the software author can decide:

- whether self-unbind is allowed
- how many times a customer may unbind inside a time window
- whether each unbind should deduct remaining days from the authorization

## Policy configuration

Admin endpoint:

- `POST /api/admin/policies/:policyId/unbind-config`

Request example:

```json
{
  "allowClientUnbind": true,
  "clientUnbindLimit": 1,
  "clientUnbindWindowDays": 30,
  "clientUnbindDeductDays": 3
}
```

Behavior:

- `allowClientUnbind=false` disables self-service unbind completely
- `clientUnbindLimit=0` means no count limit
- `clientUnbindWindowDays` controls the rolling window used for counting client unbinds
- `clientUnbindDeductDays` subtracts remaining authorization days each time the customer unbinds

## Client APIs

HTTP endpoints:

- `POST /api/client/bindings`
- `POST /api/client/unbind`

TCP actions:

- `client.bindings`
- `client.unbind`

Authentication:

- account mode: `username` + `password`
- card-direct mode: `cardKey`

### List bindings

Request example:

```json
{
  "productCode": "MY_APP",
  "username": "alice",
  "password": "StrongPass123"
}
```

Response includes:

- current active entitlement window
- binding list
- self-unbind policy
- recent self-unbind usage inside the configured window

### Unbind

Request example by `bindingId`:

```json
{
  "productCode": "MY_APP",
  "username": "alice",
  "password": "StrongPass123",
  "bindingId": "bind_xxx"
}
```

Request example by `deviceFingerprint`:

```json
{
  "productCode": "MY_APP",
  "cardKey": "RSL-AAAAAA-BBBBBB-CCCCCC-DDDDDD",
  "deviceFingerprint": "old-device-001"
}
```

Effects:

- the target binding is revoked
- active sessions on that binding are expired immediately
- if `clientUnbindDeductDays > 0`, the entitlement end time is reduced
- if deduction consumes all remaining time, the entitlement effectively expires
- the server records the action in both audit logs and entitlement unbind logs

## Error boundary

- `403 CLIENT_UNBIND_DISABLED`
- `429 CLIENT_UNBIND_LIMIT_REACHED`
- `404 BINDING_NOT_FOUND`
- `409 CARD_BOUND_TO_ACCOUNT`
- `403 LICENSE_FROZEN`
- `403 LICENSE_EXPIRED`
