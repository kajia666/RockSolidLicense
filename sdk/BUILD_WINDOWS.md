# Build On Windows

The SDK currently targets native Windows system libraries only:

- `bcrypt.lib`
- `winhttp.lib`
- `ws2_32.lib`
- `crypt32.lib`

## Compile the demo with MSVC

From a "Developer Command Prompt for VS":

```bat
cl /EHsc /std:c++17 ^
  sdk\src\rocksolid_crypto_win.cpp ^
  sdk\src\rocksolid_transport_win.cpp ^
  sdk\examples\windows_client_demo.cpp ^
  /I sdk\include ^
  bcrypt.lib winhttp.lib ws2_32.lib crypt32.lib
```

This produces `windows_client_demo.exe`.

## Files to embed in your own project

- `sdk/include/rocksolid_sdk.h`
- `sdk/include/rocksolid_client.hpp`
- `sdk/include/rocksolid_transport_win.hpp`
- `sdk/src/rocksolid_crypto_win.cpp`
- `sdk/src/rocksolid_transport_win.cpp`

## Suggested integration pattern

1. Create one `LicenseClientWin` instance during application startup.
2. Generate a device fingerprint once and cache it per installation.
3. Use HTTP for first-time registration or account operations if that fits your deployment model.
4. Use TCP for long-lived login and heartbeat flows if you want a persistent or socket-friendly transport.
5. Parse the returned JSON in your host application and persist `sessionToken` for heartbeats.
