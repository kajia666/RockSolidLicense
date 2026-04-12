# RockSolid Windows SDK Changelog

## 0.2.2 - 2026-04-12

- Added packaged `cmake/` config files so software authors can consume the prebuilt SDK with `find_package(RockSolidSDK CONFIG REQUIRED)`.
- Added packaged CMake consumer examples for both the full C++ SDK and the low-level C API package.
- Extended `sdk/verify_release_package.bat` to validate packaged CMake config files and imported targets when `cmake.exe` is available.

## 0.2.1 - 2026-04-12

- Added `SHA256SUMS.txt` and `checksums.json` generation for versioned SDK release bundles.
- Added `sdk/verify_release_package.bat` to smoke-test release packages by compiling the packaged C++ and C examples.
- Added `sdk/release_sdk.bat` to run packaging and smoke tests as a single release workflow.
- Added a root `release-manifest.json` to each release output directory.

## 0.2.0 - 2026-04-12

- Added a formal SDK version file and generated version header.
- Added `rs_sdk_version_string()` for runtime version checks in C and C++ integrations.
- Added versioned Windows SDK release packages with `manifest.json` and `VERSION.txt`.
- Added a distributable changelog to both the C++ and C API release bundles.
- Added build-time generation of SDK version metadata in the Windows build scripts.

## 0.1.0 - 2026-04-12

- Introduced the Windows C/C++ SDK foundation.
- Added request signing, device fingerprint generation, and RSA license-token verification.
- Added WinHTTP and Winsock transports plus the `LicenseClientWin` high-level wrapper.
- Added startup bootstrap helpers, offline token validation, structured API exceptions, and startup cache helpers.
- Added account login, direct card login, binding inspection, self-unbind, and point-quota aware parsed responses.
- Added Windows release packaging for `rocksolid_sdk_static.lib` and the low-level C API DLL.
