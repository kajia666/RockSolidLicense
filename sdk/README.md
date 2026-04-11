# C/C++ SDK Starter

当前仓库提供的是一个“先能接入协议”的 SDK 起步版，重点覆盖：

- 随机 `nonce` 生成
- SHA256 / HMAC-SHA256
- 请求签名
- Windows 机器码摘要

## 暴露的 C API

头文件位置：

- [rocksolid_sdk.h](/D:/code/OnlineVerification/sdk/include/rocksolid_sdk.h)

主要函数：

- `rs_generate_nonce`
- `rs_sha256_hex`
- `rs_hmac_sha256_hex`
- `rs_generate_device_fingerprint`
- `rs_sign_request`

## C++ helper layer

For a more practical client integration path, the repository now also includes:

- [rocksolid_client.hpp](/D:/code/OnlineVerification/sdk/include/rocksolid_client.hpp)
- [rocksolid_transport_win.hpp](/D:/code/OnlineVerification/sdk/include/rocksolid_transport_win.hpp)

It provides:

- UTC ISO-8601 timestamp generation
- Signed HTTP request construction
- TCP frame construction for the RockSolidLicense gateway
- JSON string escaping for `bodyText`
- Native Windows HTTP transport via WinHTTP
- Native Windows TCP transport via Winsock
- A higher-level `LicenseClientWin` wrapper for register/recharge/login/heartbeat/logout

## 请求签名约定

客户端发送到服务端的请求头：

```text
x-rs-app-id
x-rs-timestamp
x-rs-nonce
x-rs-signature
```

服务端签名串拼接规则：

```text
METHOD + "\n" +
PATH + "\n" +
TIMESTAMP + "\n" +
NONCE + "\n" +
SHA256_HEX(BODY)
```

最后计算：

```text
HMAC_SHA256_HEX(sdkAppSecret, canonical_string)
```

## 接入示例

```cpp
#include "rocksolid_sdk.h"

char nonce[RS_NONCE_HEX_LEN + 1] = {0};
char fingerprint[RS_FINGERPRINT_HEX_LEN + 1] = {0};
char signature[RS_HMAC_SHA256_HEX_LEN + 1] = {0};

rs_generate_nonce(nonce, sizeof(nonce));
rs_generate_device_fingerprint("my-product-salt", fingerprint, sizeof(fingerprint));
rs_sign_request(
  "sdk-app-secret",
  "POST",
  "/api/client/login",
  "2026-04-11T12:00:00.000Z",
  nonce,
  "{\"productCode\":\"MY_SOFTWARE\"}",
  signature,
  sizeof(signature)
);
```

Higher-level C++ example:

```cpp
#include "rocksolid_client.hpp"

const std::string body =
  "{\"productCode\":\"MY_SOFTWARE\",\"username\":\"alice\",\"password\":\"StrongPass123\"}";

auto request = rocksolid::build_signed_request(
  "app_xxx",
  "sdk-app-secret",
  "POST",
  "/api/client/login",
  body
);

auto frame = rocksolid::build_tcp_frame("req-001", "client.login", request);
const std::string wire = frame.to_json_line();
```

The TCP gateway protocol is documented in:

- [docs/tcp-protocol.md](/D:/code/OnlineVerification/docs/tcp-protocol.md)
- [BUILD_WINDOWS.md](/D:/code/OnlineVerification/sdk/BUILD_WINDOWS.md)

Example client:

- [windows_client_demo.cpp](/D:/code/OnlineVerification/sdk/examples/windows_client_demo.cpp)

## 当前限制

- 机器码采集目前只实现了 Windows
- 还没做公钥验签版授权令牌
- 还没有内置 JSON 解析器，宿主程序需要自己解析服务端返回值

建议下一步补：

- Linux / macOS 实现
- libcurl / WinHTTP 网络层封装
- 服务端 RSA/Ed25519 公钥验签支持
