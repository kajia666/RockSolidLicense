# RockSolidLicense

一个面向商业软件授权场景的网络验证系统起步版，覆盖这些核心链路：

- 作者后台创建产品、策略、卡密批次
- 终端用户注册账号、卡密充值、设备登录
- 服务端基于数据库权限、设备绑定与会话状态下发授权令牌
- 客户端通过心跳维持在线状态，后台可实时查看在线会话
- C/C++ SDK 提供签名、随机数和机器码摘要能力，便于嵌入桌面客户端

这是一版“商业级骨架”。重点先把系统边界、协议、安全基线和可运行主链路搭起来。真正上线前，还需要补齐 TLS 终止、RBAC、多租户、限流、告警和高可用部署。

## 本地运行

```bash
node src/server.js
```

默认入口：

- 控制台: `http://127.0.0.1:3000/admin`
- 健康检查: `http://127.0.0.1:3000/api/health`
- TCP Gateway: `tcp://127.0.0.1:4000`

默认管理员账号：

- 用户名: `admin`
- 密码: `ChangeMe!123`

生产环境建议覆盖：

```bash
RSL_HOST=0.0.0.0
RSL_PORT=3000
RSL_TCP_ENABLED=true
RSL_TCP_HOST=0.0.0.0
RSL_TCP_PORT=4000
RSL_DB_PATH=./data/rocksolid.db
RSL_LICENSE_PRIVATE_KEY_PATH=./data/license_private.pem
RSL_LICENSE_PUBLIC_KEY_PATH=./data/license_public.pem
RSL_TOKEN_ISSUER=RockSolidLicense
RSL_ADMIN_USERNAME=admin
RSL_ADMIN_PASSWORD=PleaseChangeThisNow
```

## 已实现能力

### 管理后台

- 管理员登录
- 创建产品并生成 `sdkAppId` / `sdkAppSecret`
- 创建授权策略
- 批量生成卡密
- 查看在线会话与基础统计

### 客户端接口

- `POST /api/client/register`
- `POST /api/client/recharge`
- `POST /api/client/login`
- `POST /api/client/heartbeat`
- `POST /api/client/logout`
- `TCP client.register / client.recharge / client.login / client.heartbeat / client.logout`
- `GET /api/system/token-key`

### 安全基线

- 管理员 / 终端账户密码使用 `scrypt`
- 客户端请求使用 `x-rs-*` 头做 HMAC-SHA256 签名
- 服务端校验时间戳窗口与 nonce 防重放
- 登录后签发 RSA 签名的 `licenseToken`
- 设备按授权窗口绑定，支持设备数限制与单会话策略
- 心跳超时和令牌过期会被自动踢下线

## 核心数据模型

- `products`: 软件产品
- `policies`: 授权策略，定义有效期、最大设备数、心跳与 token 规则
- `license_keys`: 卡密库存
- `customer_accounts`: 终端用户账号
- `entitlements`: 卡密兑换后形成的授权窗口
- `devices`: 机器码 / 设备指纹
- `device_bindings`: 授权窗口和设备的绑定关系
- `sessions`: 在线会话与实时心跳状态
- `request_nonces`: SDK 请求防重放
- `audit_logs`: 审计日志

更多设计见 [docs/architecture.md](/D:/code/OnlineVerification/docs/architecture.md)。

## SDK 签名协议

客户端在每个 `/api/client/*` 请求上附加：

- `x-rs-app-id`
- `x-rs-timestamp`
- `x-rs-nonce`
- `x-rs-signature`

签名串格式：

```text
HTTP_METHOD
/api/client/login
2026-04-11T12:00:00.000Z
random_nonce
sha256_hex(body)
```

签名算法：

```text
signature = HMAC_SHA256_HEX(sdkAppSecret, canonical_string)
```

SDK 示例和 Windows 加密实现见：

- [sdk/include/rocksolid_sdk.h](/D:/code/OnlineVerification/sdk/include/rocksolid_sdk.h)
- [sdk/include/rocksolid_client.hpp](/D:/code/OnlineVerification/sdk/include/rocksolid_client.hpp)
- [sdk/include/rocksolid_transport_win.hpp](/D:/code/OnlineVerification/sdk/include/rocksolid_transport_win.hpp)
- [sdk/src/rocksolid_crypto_win.cpp](/D:/code/OnlineVerification/sdk/src/rocksolid_crypto_win.cpp)
- [sdk/src/rocksolid_transport_win.cpp](/D:/code/OnlineVerification/sdk/src/rocksolid_transport_win.cpp)
- [sdk/README.md](/D:/code/OnlineVerification/sdk/README.md)
- [sdk/WINDOWS_SDK_GUIDE.md](/D:/code/OnlineVerification/sdk/WINDOWS_SDK_GUIDE.md)
- [sdk/BUILD_WINDOWS.md](/D:/code/OnlineVerification/sdk/BUILD_WINDOWS.md)
- [docs/tcp-protocol.md](/D:/code/OnlineVerification/docs/tcp-protocol.md)

授权令牌验证公钥可通过以下接口获取：

- `GET /api/system/token-key`

## 快速演示流程

1. 管理员登录并创建产品，例如 `MY_SOFTWARE`
2. 创建一个 30 天策略
3. 批量生成一组卡密
4. 客户端拿到 `sdkAppId` / `sdkAppSecret`
5. 客户端先注册账号，再用卡密充值
6. 客户端携带机器码登录并拿到 `sessionToken` 与 `licenseToken`
7. 客户端按策略要求定时发送心跳

## 下一步建议

- 补后台 RBAC 与操作审计检索
- 增加 PostgreSQL / Redis / MQ 存储适配
- 心跳在线状态推送到 WebSocket 面板
- 补 TCP 二进制协议和分布式会话协调
- 为 SDK 加入离线缓存、签名公钥校验和多平台机器码采集
