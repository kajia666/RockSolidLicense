# RockSolid Windows C API Package

This package is for software authors who only need the low-level C interface.

## Package contents

- `include/rocksolid_sdk.h`: C API header
- `bin/rocksolid_sdk.dll`: runtime DLL
- `lib/rocksolid_sdk.lib`: import library
- `examples/c_api_demo.c`: minimal C example
- `docs/BUILD_WINDOWS.md`: build instructions
- `docs/CHANGELOG.md`: SDK release notes
- `VERSION.txt`: package version
- `manifest.json`: package metadata

## Integration notes

- Do not define `RS_SDK_STATIC` when using the DLL package.
- Your application must be able to load `bin/rocksolid_sdk.dll` at runtime.
- The current DLL exports the low-level C API for:
  - nonce generation
  - device fingerprint generation
  - HMAC request signing
  - `licenseToken` payload decoding
  - `licenseToken` public-key verification
  - runtime SDK version lookup

## Minimal compile example

```bat
cl /nologo examples\c_api_demo.c /I include lib\rocksolid_sdk.lib /Fe:c_api_demo.exe
```

Place `bin\rocksolid_sdk.dll` next to `c_api_demo.exe`, or in a directory available through the system `PATH`.

## Recommended usage

- Use this package when you want a stable C binary interface.
- Build your own higher-level HTTP and TCP integration layer on top of the exported primitives.
