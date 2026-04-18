# RockSolid Windows C++ SDK Package

This package is for software authors who want the full Windows C++ SDK.

## Package contents

- `include/`: public headers
- `lib/rocksolid_sdk_static.lib`: full C++ static library
- `examples/windows_client_demo.cpp`: high-level client example
- `examples/windows_host_skeleton_template.cpp`: host-app startup/login/heartbeat skeleton
- `examples/cmake_cpp_host_consumer/`: ready-to-adapt CMake host-app project skeleton
  It includes `rocksolid_host_config.env.example`, which lines up with the generated integration-package `.env` keys.
- `docs/WINDOWS_SDK_GUIDE.md`: SDK guide
- `docs/BUILD_WINDOWS.md`: build instructions
- `docs/CHANGELOG.md`: SDK release notes
- `cmake/`: prebuilt package config for `find_package(...)`
- `VERSION.txt`: package version
- `manifest.json`: package metadata

## Integration notes

- Define `RS_SDK_STATIC` in your project.
- Use a compiler with `C++17` support.
- Link these Windows system libraries:
  - `bcrypt.lib`
  - `winhttp.lib`
  - `ws2_32.lib`
  - `crypt32.lib`

The `RS_SDK_STATIC` macro is required because `rocksolid_sdk.h` uses it to choose between static-library declarations and DLL import declarations.

## Minimal compile example

```bat
cl /nologo /EHsc /std:c++17 /DRS_SDK_STATIC ^
  examples\windows_client_demo.cpp ^
  /I include ^
  lib\rocksolid_sdk_static.lib ^
  bcrypt.lib winhttp.lib ws2_32.lib crypt32.lib
```

## Recommended usage

- Integrate `LicenseClientWin` directly.
- Use the high-level HTTP and TCP flows for login, heartbeat, notices, version checks, bindings, and self-unbind.
- Validate `licenseToken` locally and optionally persist startup cache data for short outage recovery.
- Start from `examples/windows_host_skeleton_template.cpp` when you want a host-app-oriented baseline instead of a demo-only sample.
- Start from `examples/cmake_cpp_host_consumer/` when you want a minimal `find_package(...)` project that already wires the host skeleton flow into a standalone executable.
- The `cmake_cpp_host_consumer` example can read `rocksolid_host_config.env`, so you can usually start from the generated integration or release `host-config` download and only add the demo login credentials plus `RS_RUN_NETWORK_DEMO=true`.
- If you use CMake, point `find_package(RockSolidSDK CONFIG REQUIRED)` at the packaged `cmake/` directory and link `RockSolidSDK::cpp_static`.
