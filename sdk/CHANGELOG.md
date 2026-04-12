# RockSolid Windows SDK Changelog

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
