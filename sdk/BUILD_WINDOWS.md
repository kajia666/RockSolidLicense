# Build On Windows

The SDK currently targets native Windows system libraries only:

- `bcrypt.lib`
- `winhttp.lib`
- `ws2_32.lib`
- `crypt32.lib`

The SDK release version lives in `sdk/VERSION`. The build scripts regenerate `sdk/include/rocksolid_sdk_version.h` automatically before compiling.

## Recommended release formats

For external software authors, the safest release strategy is:

1. `rocksolid_sdk_static.lib` + headers
2. Optional `rocksolid_sdk.dll` + `rocksolid_sdk.lib` + headers

Recommended default:

- Use `static .lib` as the main distribution for the full C++ SDK
- Use `DLL` mainly for the low-level C API in [rocksolid_sdk.h](/D:/code/OnlineVerification/sdk/include/rocksolid_sdk.h)

Why:

- static lib is simpler for C++ consumers
- static lib avoids C++ ABI and CRT mismatch issues across different Visual Studio setups
- DLL is still useful if you want easier binary replacement or a thinner C-only integration story

For the full C++ static library package, define `RS_SDK_STATIC` in your consuming project.

## Compile the demo with MSVC

Fastest option from PowerShell or `cmd`:

```bat
call sdk\build_demo.bat
```

From a "Developer Command Prompt for VS", the equivalent manual steps are:

```bat
mkdir build\win-sdk-demo 2>nul
cl /EHsc /std:c++17 ^
  /DRS_SDK_STATIC ^
  sdk\src\rocksolid_crypto_win.cpp ^
  sdk\src\rocksolid_transport_win.cpp ^
  sdk\examples\windows_client_demo.cpp ^
  /I sdk\include ^
  /Fobuild\win-sdk-demo\\ ^
  /Fdbuild\win-sdk-demo\\windows_client_demo.pdb ^
  /Febuild\win-sdk-demo\\windows_client_demo.exe ^
  bcrypt.lib winhttp.lib ws2_32.lib crypt32.lib
```

This produces `build\win-sdk-demo\windows_client_demo.exe` and keeps intermediate MSVC files inside the build directory instead of the repository root.

## Build the release libraries

The batch scripts can now locate Visual Studio C++ tools automatically. You can run them from PowerShell, `cmd`, or a Developer Command Prompt.

### Full C++ static library

```bat
call sdk\build_static_lib.bat
```

Outputs:

- `build\win-sdk-release\rocksolid_sdk_static.lib`

This package is intended for:

- `rocksolid_sdk.h`
- `rocksolid_client.hpp`
- `rocksolid_transport_win.hpp`

Consumers of this package should compile with `RS_SDK_STATIC`.

### C API DLL package

```bat
call sdk\build_c_api_dll.bat
```

Outputs:

- `build\win-sdk-release\rocksolid_sdk.dll`
- `build\win-sdk-release\rocksolid_sdk.lib`

This package is intended for:

- `rocksolid_sdk.h`

The current DLL export surface is the C API only. The higher-level C++ wrapper is still best distributed as source or static lib.

## Build the distributable release packages

```bat
call sdk\package_release.bat
```

You can also pass a custom output directory:

```bat
call sdk\package_release.bat build\my-sdk-dist
```

Outputs:

- `build\win-sdk-package\rocksolid-sdk-cpp\`
- `build\win-sdk-package\rocksolid-sdk-capi\`
- `build\win-sdk-package\rocksolid-sdk-cpp.zip`
- `build\win-sdk-package\rocksolid-sdk-capi.zip`

Actual package names include the SDK version from `sdk/VERSION`, for example:

- `build\win-sdk-package\rocksolid-sdk-cpp-0.2.2\`
- `build\win-sdk-package\rocksolid-sdk-cpp-0.2.2.zip`
- `build\win-sdk-package\rocksolid-sdk-capi-0.2.2\`
- `build\win-sdk-package\rocksolid-sdk-capi-0.2.2.zip`

The `rocksolid-sdk-cpp` package contains the full C++ SDK static library, headers, docs, the high-level demo source, a host-app-oriented C++ skeleton template, and a CMake consumer skeleton.

When software authors pull a project-scoped integration or release package from the backoffice, they now also receive a generated C++ host skeleton alongside the quickstart snippet so the host app can wire startup bootstrap, local token validation, and heartbeat gating in the order recommended by the current project profile.

The `rocksolid-sdk-capi` package contains the low-level C API header, DLL, import library, docs, and a C demo source.

Each release output directory now also includes:

- `SHA256SUMS.txt`
- `checksums.json`
- `release-manifest.json`

Each package root also includes a `cmake/` directory with `RockSolidSDKConfig.cmake`, so consumers can use `find_package(RockSolidSDK CONFIG REQUIRED)`.

## Run the release smoke test

```bat
call sdk\verify_release_package.bat
```

This script compiles the packaged C++ and C examples from the versioned release bundles and runs the C API demo to verify the packaged DLL reports the expected SDK version.

If `cmake.exe` is available, it also validates the packaged `RockSolidSDKConfig.cmake` files and imported targets.

## Run the full release workflow

```bat
call sdk\release_sdk.bat
```

This runs packaging plus the smoke test in one command.

## Files to embed in your own project

- `sdk/include/rocksolid_sdk.h`
- `sdk/include/rocksolid_sdk_version.h`
- `sdk/include/rocksolid_client.hpp`
- `sdk/include/rocksolid_transport_win.hpp`
- `sdk/include/rocksolid_json.hpp`
- `sdk/src/rocksolid_crypto_win.cpp`
- `sdk/src/rocksolid_transport_win.cpp`
- `sdk/build_demo.bat`
- `sdk/build_static_lib.bat`
- `sdk/build_c_api_dll.bat`
- `sdk/verify_release_package.bat`
- `sdk/release_sdk.bat`
- `sdk/package_release.bat`

## Suggested integration pattern

1. Create one `LicenseClientWin` instance during application startup.
2. Generate a device fingerprint once and cache it per installation.
3. Use HTTP startup calls such as `startup_bootstrap_http`, `version_check_http_parsed`, and `notices_http_parsed` before showing the login UI. `startup_bootstrap_http` now prefers the dedicated `/api/client/startup-bootstrap` route and falls back to older split calls when needed.
4. Use HTTP for first-time registration or account operations if that fits your deployment model.
5. Use TCP for long-lived login and heartbeat flows if you want a persistent or socket-friendly transport.
6. Prefer the parsed helpers such as `login_tcp_parsed`, `bindings_http_parsed`, `unbind_tcp_parsed`, and `startup_bootstrap_http` so your host app can directly consume quota, binding, notice, and self-unbind metadata.
7. Use `evaluate_startup_decision(...)` to decide whether the local login UI should be blocked for maintenance or update requirements before hitting the login endpoint.
8. Persist `sessionToken` for heartbeats, and for point-based policies also cache the latest `LoginResponse.quota` snapshot for your UI.
9. Catch `rocksolid::ApiException` around parsed helper calls if your host application needs stable `error.code` branching.
10. Persist `ClientStartupBootstrapCache` if you want offline startup decisions or local token verification during short network outages.

## Matching the project hardening profile

When you hand this SDK to a software author, match the host app behavior to the project's exported hardening profile:

1. `strict`: keep startup bootstrap, local token validation, and heartbeat feature gating all enabled.
2. `balanced`: keep most of the flow above, but follow the exported hardening guide for the one relaxed gate.
3. `relaxed`: the host app can lean more on server-side authorization, but startup bootstrap and local token validation are still recommended where practical.

The generated integration package and release package now include a project-specific hardening guide text file. Use that file as the final source of truth for the current project's startup, token-validation, and heartbeat expectations.
