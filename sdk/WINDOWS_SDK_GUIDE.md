# Windows SDK Guide

This guide covers the current Windows-native SDK pieces for RockSolidLicense.

Current SDK version source:

- `sdk/VERSION`
- generated header: `sdk/include/rocksolid_sdk_version.h`

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

## Release recommendation

When you publish this SDK to software authors:

- preferred package: `static .lib + headers`
- optional package: `DLL + import lib + headers`

Current recommendation:

- full C++ SDK: distribute `rocksolid_sdk_static.lib`
- low-level C API only: optionally distribute `rocksolid_sdk.dll` + `rocksolid_sdk.lib`
- full C++ static-lib consumers should define `RS_SDK_STATIC`

Reason:

- the C++ wrapper is easier and safer to consume as source/static lib
- the C API is the most stable surface for DLL publishing on Windows

Recommended packaging flow in this repository:

```bat
call sdk\package_release.bat
```

You can optionally pass a different output directory, for example:

```bat
call sdk\package_release.bat build\my-sdk-dist
```

This produces:

- `build\win-sdk-package\rocksolid-sdk-cpp\`
- `build\win-sdk-package\rocksolid-sdk-cpp.zip`
- `build\win-sdk-package\rocksolid-sdk-capi\`
- `build\win-sdk-package\rocksolid-sdk-capi.zip`

Actual package names include the SDK version from `sdk/VERSION`, for example `rocksolid-sdk-cpp-0.2.2.zip`.

Each release directory also includes `SHA256SUMS.txt`, `checksums.json`, and `release-manifest.json` so you can distribute signed-off release metadata together with the SDK archives.

Each package root also includes a `cmake/` folder with `RockSolidSDKConfig.cmake`, so prebuilt package consumers can use CMake `find_package(...)`.

Recommended maintainer workflow:

```bat
call sdk\release_sdk.bat
```

If you only want to verify an already-packaged release directory:

```bat
call sdk\verify_release_package.bat build\win-sdk-package
```

This validation flow checks the packaged C++ and C examples directly, and if `cmake.exe` is available it also validates the packaged `RockSolidSDKConfig.cmake` files.

Use the `cpp` package when the integrator wants the full `LicenseClientWin` feature set.

Use the `capi` package when the integrator only needs the stable low-level C binary interface.

Prebuilt-package CMake example for the C++ SDK:

```cmake
find_package(RockSolidSDK CONFIG REQUIRED PATHS "path/to/rocksolid-sdk-cpp-0.2.2/cmake" NO_DEFAULT_PATH)
add_executable(my_app main.cpp)
target_link_libraries(my_app PRIVATE RockSolidSDK::cpp_static)
```

Prebuilt-package CMake example for the C API package:

```cmake
find_package(RockSolidSDK CONFIG REQUIRED PATHS "path/to/rocksolid-sdk-capi-0.2.2/cmake" NO_DEFAULT_PATH)
add_executable(my_c_app main.c)
target_link_libraries(my_c_app PRIVATE RockSolidSDK::capi)
```

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

## Project-level hardening profiles

The server can now expose a project-scoped client hardening profile through the integration package and startup bootstrap preview.

- `strict`: startup bootstrap, local `licenseToken` validation, and heartbeat-driven feature gating are all expected in the host app
- `balanced`: most client-side hardening stays enabled, but one gate is intentionally relaxed for that project
- `relaxed`: the project leans more on server-side authorization and keeps fewer client-side anti-crack gates enabled

Recommended interpretation:

- `requireStartupBootstrap=true`: call `startup_bootstrap_http(...)` before showing login or recharge UI, then enforce `evaluate_startup_decision(...)`
- `requireLocalTokenValidation=true`: cache token keys or bootstrap payloads and validate `licenseToken` locally after login
- `requireHeartbeatGate=true`: keep protected features behind a healthy heartbeat and react quickly to revoked or expired sessions

These project-level toggles do not disable core protocol security. Request signing, replay protection, and server-side authorization checks remain mandatory.

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
- `ClientStartupBootstrapRequest` and `startup_bootstrap_http(...)` now prefer the dedicated `POST /api/client/startup-bootstrap` route, while still falling back to separate version-check, notice, and token-key calls against older servers.
- `ClientStartupDecision` and `evaluate_startup_decision(...)` turn startup payloads into a simple allow/block/update decision for your login UI.
- `ClientStartupBootstrapCache` plus `serialize_* / parse_* / read_* / write_*` helpers let you persist startup payloads locally for offline startup and short outage recovery.
- `ClientVersionManifestResponse` exposes `allowed/status/latest_version/minimum_allowed_version/latest_download_url`.
- `ClientNoticesResponse` returns the currently active notice list with `block_login` and timing metadata.
- `validate_license_token_with_key_set(...)` lets you validate `licenseToken` locally against keys fetched during startup, without an extra round trip.
- `validate_license_token_with_bootstrap(...)` reuses the cached bootstrap payload directly, so the caller does not need to manage key selection.
- The integration package now includes both a project-specific hardening guide and a project-aware C++ host skeleton so software authors can align startup, token validation, and heartbeat gating with the current project profile.
- The packaged SDK examples now include both `windows_client_demo.cpp` and `windows_host_skeleton_template.cpp`, so software authors can choose between a demo-first sample and a host-app-oriented baseline.
- The packaged SDK now also includes `examples/cmake_cpp_host_consumer/`, which is a minimal `find_package(...)` project that turns the host skeleton flow into a standalone CMake consumer app.
- The CMake host consumer can read `rocksolid_host_config.env`, and its sample env file uses the same `RS_*` keys emitted by the project integration and release package downloads.
- The generated integration and release packages now also emit a matching `CMakeLists.txt`, so software authors can start from the same minimal consumer shape even before they customize the packaged SDK example.
- `ApiException` exposes `code()`, `status()`, `transport_status()`, and `details()` so your client can branch on server error codes like `CLIENT_VERSION_REJECTED` or `LOGIN_BLOCKED_BY_NOTICE`.
- `rs_sdk_version_string()` and `rocksolid::sdk_version_string()` let your host application report the exact SDK build it is using.
- `BindingsRequest` and `UnbindRequest` support either `username/password` or direct `card_key` management flows.
- `BindingsResponse.unbind_policy` tells you whether self-unbind is enabled and how many attempts remain in the current window.
- `LoginRequest`, `CardLoginRequest`, and `HeartbeatRequest` can optionally carry `client_version/channel` for version enforcement, plus hardware/IP profile fields for configurable rebinding detection.
- The server TCP protocol is line-delimited JSON. See [tcp-protocol.md](/D:/code/OnlineVerification/docs/tcp-protocol.md).
- Build steps are in [BUILD_WINDOWS.md](/D:/code/OnlineVerification/sdk/BUILD_WINDOWS.md).
