# TCP Client Protocol

RockSolidLicense now exposes a TCP gateway for end-user client verification flows.

Default endpoint:

- `tcp://127.0.0.1:4000`

The Web admin console still uses HTTP. The TCP gateway is intended for SDK-integrated desktop clients that want a persistent transport.

## Frame format

Each request is a single JSON line terminated by `\n`.

```json
{
  "id": "req-001",
  "action": "client.login",
  "headers": {
    "x-rs-app-id": "app_xxx",
    "x-rs-timestamp": "2026-04-11T12:00:00.000Z",
    "x-rs-nonce": "abcd1234",
    "x-rs-signature": "..."
  },
  "bodyText": "{\"productCode\":\"MY_APP\",\"username\":\"alice\"}"
}
```

Notes:

- `bodyText` must be the exact JSON string that was used to calculate the HMAC signature.
- The server parses `bodyText` after signature verification.
- Frames larger than 2 MB are rejected.

## Supported actions

- `client.register`
- `client.recharge`
- `client.card-login`
- `client.login`
- `client.heartbeat`
- `client.logout`
- `system.ping`

For client actions, the server reuses the same business logic as the HTTP endpoints:

- `client.register` -> `/api/client/register`
- `client.recharge` -> `/api/client/recharge`
- `client.card-login` -> `/api/client/card-login`
- `client.login` -> `/api/client/login`
- `client.heartbeat` -> `/api/client/heartbeat`
- `client.logout` -> `/api/client/logout`

This means the signature payload should still be built with:

- method: `POST`
- path: the matching HTTP path above
- body: the exact `bodyText` string

## Response format

```json
{
  "id": "req-001",
  "ok": true,
  "data": {
    "sessionToken": "...",
    "licenseToken": "..."
  }
}
```

Error responses:

```json
{
  "id": "req-001",
  "ok": false,
  "error": {
    "status": 401,
    "code": "SDK_SIGNATURE_INVALID",
    "message": "Request signature does not match."
  }
}
```

## SDK integration hint

The C++ helper header [rocksolid_client.hpp](/D:/code/OnlineVerification/sdk/include/rocksolid_client.hpp) can build signed requests and TCP frames directly from a compact JSON body string.
