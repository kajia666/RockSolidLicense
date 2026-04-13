# RockSolidLicense

面向商业软件授权、网络验证与终端分发的服务端 + Web 后台 + Windows C/C++ SDK 项目。

当前仓库已经覆盖一条可运行的主链路：

- 软件作者在后台创建产品、授权策略、卡密和版本规则
- 终端用户可以注册账号后充值卡密，也可以直接使用卡密登录
- 服务端按策略校验机器绑定、会话状态、版本规则、公告维护窗口与网络规则
- 登录成功后签发 RSA `licenseToken`，并通过心跳维持在线状态
- Windows C/C++ SDK 已支持 HTTP/TCP 通信、签名、令牌验签、版本检查、公告拉取、启动决策辅助、结构化错误处理、绑定查询和自助解绑

这套系统现在更偏向“网络验证 / 软件授权平台”，而不是账单结算系统。代理、库存和结算相关能力保留为辅助运营模块，不是当前仓库的唯一重心。

建模说明：

- 仓库里的 `product` 就是“软件作者的一个软件 / 一个项目”
- `products.id` 是内部主键
- `products.code` 是对外稳定的项目编码，也可以理解成 `projectCode` 或 `softwareCode`
- `products.owner_developer_id` 表示这个项目归属的开发者账号
- `sdkAppId` / `sdkAppSecret` 是 SDK 请求签名凭据，不等同于项目编码

## 核心能力

### 卡密管理

- 批量生成卡密
- 支持时长卡与点数卡
- 卡密导出与状态区分
- 卡密冻结、过期、撤销控制
- 账号充值卡密
- 卡密直接登录

### 用户授权

- 账号注册、登录、退出
- 卡密直登与账号模式双认证
- 机器绑定、换绑检测、手动解绑
- 软件作者自定义硬件/IP 绑定字段
- 是否允许多开由策略控制
- 授权冻结、恢复、续期
- 点数授权登录扣点

### 软件管理

- 产品级功能开关
- 项目 SDK 凭据轮换
- 开发者多项目归属
- 开发者主账号 + 子账号
- 子账号按项目授权与角色控制
- 客户端版本规则
- 强制升级与升级建议
- 客户端公告与维护通知
- 维护期间阻断登录
- SDK 启动期版本检查、公告拉取和本地启动决策

### 验证接口

- HTTP 客户端接口
- TCP 客户端接口
- 登录验证
- 心跳保活
- 卡密充值
- 绑定查询
- 自助解绑

### 安全与控制

- HMAC-SHA256 SDK 请求签名
- RSA 授权令牌签发与公钥验签
- 多公钥 `kid` 发布与轮换
- 设备封禁
- IP / CIDR 网络规则
- 在线会话控制与强制下线
- 审计日志

### 代理与隔离

- 无限级代理基础模型
- 库存下发与层级隔离
- 可选查看下级范围
- 代理价格与结算能力保留，但不是当前主要开发重点

## 项目结构

- `src/`：服务端、HTTP/TCP 网关、后台页面
- `sdk/`：Windows C/C++ SDK、示例和构建说明
- `docs/`：架构、协议、部署和运营文档
- `test/`：Node 端到端回归测试
- `deploy/`：Windows / Linux 部署骨架

开发者子账号和项目级权限说明见 [docs/developer-members.md](/D:/code/OnlineVerification/docs/developer-members.md)，开发者接入中心说明见 [docs/developer-integration.md](/D:/code/OnlineVerification/docs/developer-integration.md)，开发者项目工作台说明见 [docs/developer-projects.md](/D:/code/OnlineVerification/docs/developer-projects.md)，开发者授权策略与卡密工作台说明见 [docs/developer-license.md](/D:/code/OnlineVerification/docs/developer-license.md)，开发者授权运营台说明见 [docs/developer-ops.md](/D:/code/OnlineVerification/docs/developer-ops.md)，开发者发版工作台说明见 [docs/developer-release.md](/D:/code/OnlineVerification/docs/developer-release.md)。

## 本地运行

### 启动服务端

```bash
node src/server.js
```

默认入口：

- 管理后台：`http://127.0.0.1:3000/admin`
- 产品中心：`http://127.0.0.1:3000/admin/products`
- 开发者中心：`http://127.0.0.1:3000/developer`
- 开发者接入中心：`http://127.0.0.1:3000/developer/integration`
- 开发者项目中心：`http://127.0.0.1:3000/developer/projects`
- 开发者授权中心：`http://127.0.0.1:3000/developer/licenses`
- 开发者运营台：`http://127.0.0.1:3000/developer/ops`
- 开发者发版中心：`http://127.0.0.1:3000/developer/releases`
- 开发者安全中心：`http://127.0.0.1:3000/developer/security`
- 公告中心：`http://127.0.0.1:3000/admin/notices`
- 健康检查：`http://127.0.0.1:3000/api/health`
- TCP Gateway：`tcp://127.0.0.1:4000`

默认管理员账号：

- 用户名：`admin`
- 密码：`ChangeMe!123`

建议通过环境变量覆盖生产配置：

```bash
RSL_HOST=0.0.0.0
RSL_PORT=3000
RSL_TCP_ENABLED=true
RSL_TCP_HOST=0.0.0.0
RSL_TCP_PORT=4000
RSL_DB_PATH=./data/rocksolid.db
RSL_STATE_STORE_DRIVER=sqlite
RSL_POSTGRES_URL=
RSL_REDIS_URL=
RSL_REDIS_KEY_PREFIX=rsl
RSL_LICENSE_PRIVATE_KEY_PATH=./data/license_private.pem
RSL_LICENSE_PUBLIC_KEY_PATH=./data/license_public.pem
RSL_TOKEN_ISSUER=RockSolidLicense
RSL_ADMIN_USERNAME=admin
RSL_ADMIN_PASSWORD=PleaseChangeThisNow
RSL_DEVELOPER_SESSION_HOURS=24
```

### 运行测试

```bash
npm test
```

### PostgreSQL 引导脚本

主业务数据当前仍然跑在 SQLite 上，但仓库已经提供了 PostgreSQL 主库初始化脚本，便于后续迁移：

```bash
npm run db:postgres:init
npm run db:postgres:check
```

对应文件：

- [init.sql](/D:/code/OnlineVerification/deploy/postgres/init.sql)
- [render-postgres-init.mjs](/D:/code/OnlineVerification/scripts/render-postgres-init.mjs)
- [storage-platform.md](/D:/code/OnlineVerification/docs/storage-platform.md)

当前主数据访问层也已经开始抽边界，第一块仓储是：

- [product-repository.js](/D:/code/OnlineVerification/src/data/product-repository.js)
- [policy-repository.js](/D:/code/OnlineVerification/src/data/policy-repository.js)
- [card-repository.js](/D:/code/OnlineVerification/src/data/card-repository.js)

## 终端用户主流程

### 账号模式

1. 客户端启动后调用版本检查和公告接口
2. 用户注册账号
3. 用户使用卡密充值到账号
4. 客户端携带机器指纹登录
5. 服务端校验授权、绑定、版本、公告和网络规则
6. 服务端返回 `sessionToken`、`licenseToken`
7. 客户端按策略发送心跳

### 卡密直登模式

1. 客户端启动后调用版本检查和公告接口
2. 用户直接输入卡密登录
3. 服务端创建卡密直登身份并绑定设备
4. 返回 `sessionToken`、`licenseToken`
5. 客户端持续心跳

## 主要客户端接口

HTTP：

- `POST /api/client/register`
- `POST /api/client/recharge`
- `POST /api/client/card-login`
- `POST /api/client/login`
- `POST /api/client/bindings`
- `POST /api/client/unbind`
- `POST /api/client/version-check`
- `POST /api/client/notices`
- `POST /api/client/heartbeat`
- `POST /api/client/logout`

后台产品配置：

- `GET /api/admin/products`
- `POST /api/admin/products`
- `POST /api/admin/products/:productId/feature-config`
- `POST /api/admin/products/:productId/sdk-credentials/rotate`
- `POST /api/admin/products/:productId/owner`
- `GET /api/admin/developers`
- `POST /api/admin/developers`
- `POST /api/admin/developers/:developerId/status`

说明：

- 绝大多数写接口仍然兼容 `productCode`
- 现在也接受 `projectCode`、`softwareCode` 作为同义字段
- 管理员现在可以创建开发者账号，并把项目归属到某个开发者名下

TCP：

- `client.register`
- `client.recharge`
- `client.card-login`
- `client.login`
- `client.bindings`
- `client.unbind`
- `client.heartbeat`
- `client.logout`

系统接口：

- `GET /api/system/token-key`
- `GET /api/system/token-keys`

产品级功能开关当前支持：

- `allowRegister`
- `allowAccountLogin`
- `allowCardLogin`
- `allowCardRecharge`
- `allowVersionCheck`
- `allowNotices`
- `allowClientUnbind`

软件作者可以按产品维度选择是否开放这些终端能力。关闭 `allowVersionCheck` 或 `allowNotices` 后，客户端对应接口会返回“disabled by product”，登录链路也不会再继续应用该产品的版本限制或维护公告阻断。
仓库现在还提供了一个专门的产品中心页面：`/admin/products`，可直接创建开发者账号、分配项目归属并调整产品级功能开关。

开发者项目管理接口：

- `POST /api/developer/login`
- `GET /api/developer/me`
- `GET /api/developer/dashboard`
- `GET /api/developer/integration`
- `POST /api/developer/logout`
- `POST /api/developer/profile`
- `POST /api/developer/change-password`
- `GET /api/developer/members`
- `POST /api/developer/members`
- `POST /api/developer/members/:memberId`
- `GET /api/developer/products`
- `POST /api/developer/products`
- `POST /api/developer/products/:productId/feature-config`
- `POST /api/developer/products/:productId/sdk-credentials/rotate`
- `GET /api/developer/policies`
- `POST /api/developer/policies`
- `POST /api/developer/policies/:policyId/runtime-config`
- `POST /api/developer/policies/:policyId/unbind-config`
- `GET /api/developer/cards`
- `GET /api/developer/cards/export`
- `POST /api/developer/cards/batch`
- `POST /api/developer/cards/:cardId/status`
- `GET /api/developer/accounts`
- `POST /api/developer/accounts/:accountId/status`
- `GET /api/developer/entitlements`
- `POST /api/developer/entitlements/:entitlementId/status`
- `POST /api/developer/entitlements/:entitlementId/extend`
- `POST /api/developer/entitlements/:entitlementId/points`
- `GET /api/developer/sessions`
- `POST /api/developer/sessions/:sessionId/revoke`
- `GET /api/developer/device-bindings`
- `POST /api/developer/device-bindings/:bindingId/release`
- `GET /api/developer/device-blocks`
- `POST /api/developer/device-blocks`
- `POST /api/developer/device-blocks/:blockId/unblock`
- `GET /api/developer/network-rules`
- `POST /api/developer/network-rules`
- `POST /api/developer/network-rules/:ruleId/status`
- `GET /api/developer/audit-logs`
- `GET /api/developer/client-versions`
- `POST /api/developer/client-versions`
- `POST /api/developer/client-versions/:versionId/status`
- `GET /api/developer/notices`
- `POST /api/developer/notices`
- `POST /api/developer/notices/:noticeId/status`

这组接口用于“一个开发者管理多个项目”的场景。现在除了开发者主账号，也支持开发者创建子账号，并按项目分配访问范围。子账号统一走 `/api/developer/login`，但只能看到被分配到自己名下的项目。

当前开发者子账号角色：

- `admin`：可管理已分配项目的功能开关、策略、卡密、版本、公告，以及终端用户授权运营动作
- `operator`：可管理已分配项目的策略、卡密、版本、公告和终端用户授权运营动作，但不能改产品功能开关
- `viewer`：只读查看已分配项目及其策略、卡密、版本、公告，以及授权运营数据

开发者主账号可以自助改密、改资料、创建/禁用子账号、调整项目授权，并轮换自己项目的 `sdkAppSecret` 或整组 SDK 凭据；管理员仍然可以禁用或恢复开发者主账号，也可以在产品中心直接轮换项目凭据。开发者中心现在还会通过 `GET /api/developer/dashboard` 拉取按项目范围隔离的总览统计，直接展示项目数、在线会话、卡密、强更规则、阻断公告和网络规则概况。开发者接入中心位于 `/developer/integration`，适合软件作者集中查看项目 SDK 凭据、公钥集、HTTP/TCP 连接信息和接入示例。开发者项目中心位于 `/developer/projects`，适合软件作者集中处理项目创建、产品级功能开关和 SDK 凭据轮换。开发者授权中心位于 `/developer/licenses`，适合软件作者集中维护策略、卡密批次、卡密状态和卡密导出。开发者授权运营台位于 `/developer/ops`，适合软件作者直接处理账号冻结、授权续期、点数调账、强制下线、设备解绑和设备封禁。开发者发版中心位于 `/developer/releases`，适合软件作者维护客户端版本、强更规则和启动公告。开发者安全中心位于 `/developer/security`，用于维护项目级 IP / CIDR 网络规则；拥有 `products.write` 权限的开发者或子账号可以创建和归档规则，`operator` 和 `viewer` 仍可按项目范围读取规则，但不能修改。

## Windows C/C++ SDK

当前 Windows SDK 已支持：

- 请求签名
- WinHTTP / Winsock 传输
- 账号登录与卡密直登
- 绑定查询与自助解绑
- 版本检查与公告拉取
- 启动聚合助手 `startup_bootstrap_http(...)`
- 本地启动决策 `evaluate_startup_decision(...)`
- 基于已拉取公钥集的本地离线验签
- 启动快照缓存，支持短时离线启动判断
- 结构化 `ApiException`，便于按错误码控制客户端流程
- `licenseToken` 解码与 RSA 公钥验签
- SDK 版本号、版本头文件和发布 changelog

发布建议：

- 对软件作者的主分发，优先提供 `static .lib + 头文件`
- 如果需要二进制替换能力，再额外提供 `DLL + import lib + 头文件`
- 当前仓库里，完整 C++ SDK 更适合发 `rocksolid_sdk_static.lib`
- `DLL` 形态当前更适合作为底层 C API 发布
- 如果发完整 C++ 静态库，接入方工程里记得定义 `RS_SDK_STATIC`

仓库已经内置一键打包脚本：

```bat
call sdk\package_release.bat
```

也可以显式指定输出目录，例如：

```bat
call sdk\package_release.bat build\my-sdk-dist
```

会输出：

- `build/win-sdk-package/rocksolid-sdk-cpp-<version>/`
- `build/win-sdk-package/rocksolid-sdk-cpp-<version>.zip`
- `build/win-sdk-package/rocksolid-sdk-capi-<version>/`
- `build/win-sdk-package/rocksolid-sdk-capi-<version>.zip`

SDK 版本源文件在 `sdk/VERSION`，构建脚本会自动生成 `sdk/include/rocksolid_sdk_version.h`，并把 `VERSION.txt`、`manifest.json`、`docs/CHANGELOG.md` 一起打进发布包。

发布目录还会额外生成：

- `SHA256SUMS.txt`
- `checksums.json`
- `release-manifest.json`

每个 SDK 包目录里还会带一个 `cmake/` 目录，软件作者可以直接用 `find_package(RockSolidSDK CONFIG REQUIRED)` 接入预编译包。

如果你要走完整的“打包 + 校验”流程，可以直接运行：

```bat
call sdk\release_sdk.bat
```

如果你只是想对已经打好的发布包做 smoke test：

```bat
call sdk\verify_release_package.bat build\win-sdk-package
```

当前这轮 SDK 版本是 `0.2.2`。

主要文件：

- `sdk/include/rocksolid_sdk.h`
- `sdk/include/rocksolid_sdk_version.h`
- `sdk/include/rocksolid_client.hpp`
- `sdk/include/rocksolid_transport_win.hpp`
- `sdk/src/rocksolid_crypto_win.cpp`
- `sdk/src/rocksolid_transport_win.cpp`
- `sdk/examples/windows_client_demo.cpp`
- `sdk/WINDOWS_SDK_GUIDE.md`
- `sdk/BUILD_WINDOWS.md`

编译示例：

```bat
cl /EHsc /std:c++17 ^
  /DRS_SDK_STATIC ^
  sdk\src\rocksolid_crypto_win.cpp ^
  sdk\src\rocksolid_transport_win.cpp ^
  sdk\examples\windows_client_demo.cpp ^
  /I sdk\include ^
  bcrypt.lib winhttp.lib ws2_32.lib crypt32.lib
```

更完整的 Windows 构建步骤请看 `sdk/BUILD_WINDOWS.md`。

## 数据模型摘要

- `products`：软件产品
- `policies`：授权策略
- `policy_grant_configs`：时长卡 / 点数卡配置
- `license_keys`：卡密库存
- `license_key_controls`：卡密冻结 / 过期控制
- `customer_accounts`：终端用户账号
- `entitlements`：授权主体
- `entitlement_metering`：点数授权计量
- `devices`：设备指纹
- `device_bindings`：授权与设备绑定
- `sessions`：在线会话
- `device_blocks`：设备封禁
- `network_rules`：IP / CIDR 规则
- `client_versions`：版本规则
- `notices`：公告和维护通知
- `request_nonces`：请求防重放
- `audit_logs`：审计日志

## 部署建议

- Windows Server 可直接运行当前 Node.js 服务和 Windows SDK 配套体系
- Linux 更适合作为长期生产主环境，仓库也已提供 Docker / Nginx / systemd 部署骨架
- 当前已经把 nonce 防重放和在线会话抽成 runtime state store，并已支持 `redis` 运行时状态层、在线会话索引、单开 owner 索引和心跳期 runtime invalidation
- 真正上线前建议继续补齐 PostgreSQL、Redis、TLS、RBAC、限流、监控和备份策略

## 重点文档

- `docs/architecture.md`
- `docs/tcp-protocol.md`
- `docs/client-auth-modes.md`
- `docs/client-unbind.md`
- `docs/client-versioning.md`
- `docs/notice-center.md`
- `docs/license-ops.md`
- `docs/admin-operations.md`
- `docs/developer-members.md`
- `docs/developer-ops.md`
- `docs/developer-release.md`
- `docs/storage-platform.md`
- `docs/linux-deployment.md`
- `docs/windows-server-deployment.md`

## 当前状态

仓库已经具备“商业级网络验证系统”的第一阶段骨架，适合继续往这些方向推进：

- PostgreSQL + Redis 多实例部署底座
- 更完整的客户端缓存、公钥轮换与离线校验策略
- 更成熟的后台前端
- 更细粒度的 RBAC、限流和告警
