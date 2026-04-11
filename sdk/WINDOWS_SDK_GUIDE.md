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
const rocksolid::LoginResponse login = client.login_tcp_parsed(request);
const rocksolid::TokenValidationResult validation =
  client.validate_license_token_online(login.license_token);
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
  "Alice Workstation"
};

request.device_profile.machine_guid = "GUID-001";
request.device_profile.cpu_id = "CPU-ABC";
request.device_profile.disk_serial = "DISK-XYZ";
request.device_profile.public_ip = "198.51.100.10";
```

## Notes

- Use `GET /api/system/token-key` to retrieve the server public key for SDK distribution or verification bootstrap.
- Use `GET /api/system/token-keys` if you want the full published key set for `kid`-based verification.
- `rocksolid::verify_license_token(...)` can validate the returned `licenseToken` locally.
- `rocksolid::decode_license_token_payload(...)` returns the token payload JSON as text.
- The SDK now also exposes parsed response structs for the main client flows.
- `LoginResponse.auth_mode` tells you whether the session came from `account` login or direct `card` login.
- `LoginResponse.card_masked_key` is populated for direct card login responses.
- `LoginRequest` and `CardLoginRequest` can optionally carry hardware/IP profile fields for configurable rebinding detection.
- The server TCP protocol is line-delimited JSON. See [tcp-protocol.md](/D:/code/OnlineVerification/docs/tcp-protocol.md).
- Build steps are in [BUILD_WINDOWS.md](/D:/code/OnlineVerification/sdk/BUILD_WINDOWS.md).
