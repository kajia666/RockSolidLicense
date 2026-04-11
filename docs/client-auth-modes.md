# Client Authentication Modes

RockSolidLicense now supports two end-user verification modes for the same product.

This matches the common "network verification" product shape seen in commercial systems:

- account mode: register an account, recharge the account with a card key, then log in
- card mode: skip account registration and log in directly with a card key

The implementation here is our own API design, informed by the product direction described in:

- [16hex introduction](https://www.16hex.cc/introduction)
- [T3 guide](https://www.t3yanzheng.com/docs/guide/)

## Account mode

HTTP flow:

1. `POST /api/client/register`
2. `POST /api/client/recharge`
3. `POST /api/client/login`
4. `POST /api/client/heartbeat`
5. `POST /api/client/logout`

Use this mode when the operator wants:

- user-managed accounts
- password-based sign-in
- multiple cards recharged onto the same named user

## Card-direct mode

HTTP flow:

1. `POST /api/client/card-login`
2. `POST /api/client/heartbeat`
3. `POST /api/client/logout`

TCP flow:

1. `client.card-login`
2. `client.heartbeat`
3. `client.logout`

Request body for direct card login:

```json
{
  "productCode": "MY_APP",
  "cardKey": "RSL-AAAAAA-BBBBBB-CCCCCC-DDDDDD",
  "deviceFingerprint": "machine-code-001",
  "deviceName": "Alice PC",
  "clientVersion": "1.2.3",
  "channel": "stable"
}
```

Behavior:

- a fresh card can activate itself and log in immediately
- a redeemed card can log in again only if it belongs to the direct-card mode
- a card that was already recharged onto a named account is rejected for direct login
- direct-card sessions still use the same device binding, heartbeat, token signing, notice blocking, version checks, and IP/network rules as account login

## Rebind detection

Login and card-login can now carry an optional `deviceProfile` object:

```json
{
  "productCode": "MY_APP",
  "username": "alice",
  "password": "StrongPass123",
  "deviceFingerprint": "fp-001",
  "deviceName": "Alice PC",
  "deviceProfile": {
    "machineGuid": "GUID-001",
    "cpuId": "CPU-ABC",
    "diskSerial": "DISK-XYZ",
    "requestIp": "not sent by client",
    "publicIp": "198.51.100.10",
    "localIp": "192.168.1.20"
  }
}
```

The software author can configure, per policy:

- whether concurrent sessions are allowed
- whether rebinding should stay strict to the exact `deviceFingerprint`
- or whether rebinding should be decided by selected hardware/IP fields instead

When `bindMode=selected_fields`, the server can treat a new fingerprint as the same logical device if the selected fields still match.

## Internal model

Sessions in this project are still account-backed.

To preserve compatibility with the existing data model, direct card login creates an internal account mapping behind the scenes:

- one direct-login card maps to one internal account
- the card still redeems into a normal entitlement row
- session issuance stays identical to account login after the mapping is resolved

This means we can support both verification modes without changing the session or entitlement tables.

## Error boundary

Direct card login returns:

- `404 CARD_NOT_AVAILABLE` when the card is invalid or unavailable
- `409 CARD_BOUND_TO_ACCOUNT` when the card was already recharged onto a named account
- `403 LICENSE_INACTIVE` when the card exists but has no active entitlement window
- the same blocking errors as account login for version policy, maintenance notices, device bans, and network rules
