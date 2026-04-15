# Developer Integration Center

The developer integration center is available at `/developer/integration`.

It is designed to help software authors connect the SDK to their own software by aggregating:

- scoped project credentials
- product feature toggles
- HTTP and TCP listener information
- public token keys
- example request payloads

The page now also summarizes how many visible projects currently have each of the 7 product-level switches enabled:

- `allowRegister`
- `allowAccountLogin`
- `allowCardLogin`
- `allowCardRecharge`
- `allowVersionCheck`
- `allowNotices`
- `allowClientUnbind`

## API

- `GET /api/developer/integration`

This route requires a normal developer bearer token and is scoped to projects visible to the current actor.

## Returned data

- `developer`
- `actor`
- `transport.http`
- `transport.tcp`
- `signing`
- `tokenKeys`
- `products`
- `examples`

Typical shape:

```json
{
  "transport": {
    "http": {
      "protocol": "http",
      "host": "0.0.0.0",
      "port": 3000,
      "baseUrl": "http://127.0.0.1:3000"
    },
    "tcp": {
      "enabled": true,
      "host": "0.0.0.0",
      "port": 4000
    }
  },
  "signing": {
    "requestAlgorithm": "HMAC-SHA256",
    "requestSkewSeconds": 300,
    "tokenAlgorithm": "RS256",
    "tokenIssuer": "RockSolidLicense",
    "activeKeyId": "kid_xxx"
  }
}
```

## Role behavior

- owner account: can view every owned project inside the integration snapshot
- member account: only sees explicitly assigned projects
- the route is read-only and does not change project state

## Practical use

The page and API are useful when the software author needs to:

- copy the correct `sdkAppId` and `sdkAppSecret`
- confirm whether HTTP or TCP endpoints are enabled
- fetch the current public key set used for `licenseToken` verification
- adapt example register/login/card-login/heartbeat requests for their own client
- confirm whether recharge and client-unbind are open for a scoped project before exposing those SDK flows

## Request signing headers

The HTTP integration example uses the same request signing headers as the runtime client APIs:

- `x-rs-app-id`
- `x-rs-timestamp`
- `x-rs-nonce`
- `x-rs-signature`
