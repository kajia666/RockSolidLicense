# Windows SDK Guide

This guide covers the current Windows-native SDK pieces for RockSolidLicense.

## Implemented layers

- Cryptography: SHA256, HMAC-SHA256, nonce generation
- Device fingerprint: Windows host fingerprint hash
- Request signing: HTTP and TCP
- License token verification: RSA public-key verification
- Response parsing: built-in lightweight JSON parser and typed SDK responses
- HTTP transport: WinHTTP
- TCP transport: Winsock
- High-level client wrapper: `LicenseClientWin`
- Dual client auth modes: account login and direct card login
- Binding inspection and self-unbind: account mode and direct card mode
- Point-quota awareness: parsed recharge/login responses expose remaining points
- Startup bootstrap helpers: version-check and active notice polling
- Local startup decision and offline token verification helpers
- Structured API exceptions with `code/status/details`
- Startup bootstrap cache serialization and file helpers

## Main headers

- [rocksolid_sdk.h](/D:/code/OnlineVerification/sdk/include/rocksolid_sdk.h)
- [rocksolid_client.hpp](/D:/code/OnlineVerification/sdk/include/rocksolid_client.hpp)
- [rocksolid_transport_win.hpp](/D:/code/OnlineVerification/sdk/include/rocksolid_transport_win.hpp)

## Main source files

- [rocksolid_crypto_win.cpp](/D:/code/OnlineVerification/sdk/src/rocksolid_crypto_win.cpp)
- [rocksolid_transport_win.cpp](/D:/code/OnlineVerification/sdk/src/rocksolid_transport_win.cpp)

## High-level usage

```cpp
#include "rocksolid_transport_win.hpp"

rocksolid::ClientIdentity identity{
  "app_xxx",
  "sdk-secret",
  "my-product-salt"
};

rocksolid::HttpEndpoint http_endpoint;
http_endpoint.host = L"127.0.0.1";
http_endpoint.port = 3000;

rocksolid::TcpEndpoint tcp_endpoint;
tcp_endpoint.host = "127.0.0.1";
tcp_endpoint.port = 4000;

rocksolid::LicenseClientWin client(identity, http_endpoint, tcp_endpoint);

rocksolid::LoginRequest request{
  "MY_SOFTWARE",
  "alice",
  "StrongPass123",
  client.generate_device_fingerprint(),
  "Alice Workstation"
};

const auto result = client.login_tcp(request);
```

Parsed high-level usage:

```cpp
const rocksolid::ClientStartupBootstrapResponse startup =
  client.startup_bootstrap_http({"MY_SOFTWARE", "1.0.0", "stable", true});

const rocksolid::ClientStartupDecision decision =
  rocksolid::LicenseClientWin::evaluate_startup_decision(startup);

const rocksolid::ClientStartupBootstrapCache cache{
  1,
  rocksolid::iso8601_now_utc(),
  startup
};
rocksolid::LicenseClientWin::write_startup_bootstrap_cache_file(
  "startup_cache.json",
  cache
);

const rocksolid::LoginResponse login = client.login_tcp_parsed(request);
const std::string binding_id = login.binding.id;
const bool metered = login.quota.metered;
const rocksolid::TokenValidationResult validation =
  rocksolid::LicenseClientWin::validate_license_token_with_bootstrap(
    login.license_token,
    cache.bootstrap
  );

// When the server returns ok=false, parsed helpers throw rocksolid::ApiException.
```

Direct card login usage:

```cpp
rocksolid::CardLoginRequest card_request{
  "MY_SOFTWARE",
  "RSL-AAAAAA-BBBBBB-CCCCCC-DDDDDD",
  client.generate_device_fingerprint(),
  "Alice Workstation"
};

const rocksolid::LoginResponse card_login = client.card_login_tcp_parsed(card_request);
```

Optional rebinding profile:

```cpp
rocksolid::LoginRequest request{
  "MY_SOFTWARE",
  "alice",
  "StrongPass123",
  client.generate_device_fingerprint(),
  "Alice Workstation",
  "1.0.0",
  "stable"
};

request.device_profile.machine_guid = "GUID-001";
request.device_profile.cpu_id = "CPU-ABC";
request.device_profile.disk_serial = "DISK-XYZ";
request.device_profile.public_ip = "198.51.100.10";
```

Bindings and self-unbind:

```cpp
rocksolid::BindingsRequest bindings_request{
  "MY_SOFTWARE",
  "alice",
  "StrongPass123",
  ""
};

const rocksolid::BindingsResponse bindings = client.bindings_http_parsed(bindings_request);

rocksolid::UnbindRequest unbind_request{
  "MY_SOFTWARE",
  "alice",
  "StrongPass123",
  "",
  bindings.bindings.front().id,
  "",
  "user_replace_device"
};

const rocksolid::UnbindResponse unbind = client.unbind_tcp_parsed(unbind_request);
```

## Notes

- Use `GET /api/system/token-key` to retrieve the server public key for SDK distribution or verification bootstrap.
- Use `GET /api/system/token-keys` if you want the full published key set for `kid`-based verification.
- `rocksolid::verify_license_token(...)` can validate the returned `licenseToken` locally.
- `rocksolid::decode_license_token_payload(...)` returns the token payload JSON as text.
- The SDK now also exposes parsed response structs for the main client flows.
- `LoginResponse.auth_mode` tells you whether the session came from `account` login or direct `card` login.
- `LoginResponse.card_masked_key` is populated for direct card login responses.
- `LoginResponse.binding` exposes the server-side binding id, bind mode, and matched hardware fields.
- `LoginResponse.quota` exposes point-based quota consumption after each successful login.
- `RechargeResponse.grant_type` and `RechargeResponse.remaining_points` help distinguish duration cards from point cards.
- `ClientVersionCheckRequest` and `ClientNoticesRequest` let the SDK drive the same startup flow documented on the server side.
- `ClientStartupBootstrapRequest` and `startup_bootstrap_http(...)` bundle version-check, active notices, and token-key fetch into one startup helper.
- `ClientStartupDecision` and `evaluate_startup_decision(...)` turn startup payloads into a simple allow/block/update decision for your login UI.
- `ClientStartupBootstrapCache` plus `serialize_* / parse_* / read_* / write_*` helpers let you persist startup payloads locally for offline startup and short outage recovery.
- `ClientVersionManifestResponse` exposes `allowed/status/latest_version/minimum_allowed_version/latest_download_url`.
- `ClientNoticesResponse` returns the currently active notice list with `block_login` and timing metadata.
- `validate_license_token_with_key_set(...)` lets you validate `licenseToken` locally against keys fetched during startup, without an extra round trip.
- `validate_license_token_with_bootstrap(...)` reuses the cached bootstrap payload directly, so the caller does not need to manage key selection.
- `ApiException` exposes `code()`, `status()`, `transport_status()`, and `details()` so your client can branch on server error codes like `CLIENT_VERSION_REJECTED` or `LOGIN_BLOCKED_BY_NOTICE`.
- `BindingsRequest` and `UnbindRequest` support either `username/password` or direct `card_key` management flows.
- `BindingsResponse.unbind_policy` tells you whether self-unbind is enabled and how many attempts remain in the current window.
- `LoginRequest`, `CardLoginRequest`, and `HeartbeatRequest` can optionally carry `client_version/channel` for version enforcement, plus hardware/IP profile fields for configurable rebinding detection.
- The server TCP protocol is line-delimited JSON. See [tcp-protocol.md](/D:/code/OnlineVerification/docs/tcp-protocol.md).
- Build steps are in [BUILD_WINDOWS.md](/D:/code/OnlineVerification/sdk/BUILD_WINDOWS.md).
