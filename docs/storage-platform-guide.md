# 存储平台规划

当前仓库已经把“运行时状态”和“主业务数据”拆成了两层：

- 主业务数据：当前主体仍是 SQLite，但已经进入 PostgreSQL 迁移预览阶段
- 运行时状态：支持 `sqlite`、`memory`、`redis`

这样做的目标不是假装已经完成 PostgreSQL 迁移，而是先把最影响多实例部署的边界收出来，后续按阶段推进。

## 主业务数据

主业务表仍然由 [database.js](/D:/code/OnlineVerification/src/database.js) 初始化，默认数据库文件由 `RSL_DB_PATH` 控制：

```bash
RSL_DB_PATH=./data/rocksolid.db
```

当前服务端的默认主业务驱动仍然是 SQLite，适合本地开发、单机调试和当前回归测试。

不过主数据访问已经不再散落在服务层里，核心边界已经收进 `mainStore`：

- [main-store.js](/D:/code/OnlineVerification/src/data/main-store.js)
- [sqlite-main-store.js](/D:/code/OnlineVerification/src/data/sqlite-main-store.js)
- [postgres-main-store.js](/D:/code/OnlineVerification/src/data/postgres-main-store.js)
- [product-repository.js](/D:/code/OnlineVerification/src/data/product-repository.js)
- [policy-repository.js](/D:/code/OnlineVerification/src/data/policy-repository.js)
- [card-repository.js](/D:/code/OnlineVerification/src/data/card-repository.js)
- [entitlement-repository.js](/D:/code/OnlineVerification/src/data/entitlement-repository.js)
- [postgres-product-store.js](/D:/code/OnlineVerification/src/data/postgres-product-store.js)
- [postgres-policy-store.js](/D:/code/OnlineVerification/src/data/postgres-policy-store.js)

`RSL_MAIN_STORE_DRIVER` 当前支持 `sqlite` 和 `postgres`：

- `sqlite`
  默认模式，读写都走 SQLite
- `postgres`
  PostgreSQL 迁移预览模式，能力取决于 adapter 支持程度

当前 PostgreSQL preview 已经分成两层：

- `read_side_preview`
  `products / policies / cards / entitlements` 读侧走 PostgreSQL；写侧仍在 SQLite
- `product_policy_write_preview`
  在上面的基础上，如果 adapter 支持 `withTransaction(...)`，则 `products / policies` 写侧也进入 PostgreSQL

当前四块核心写侧边界都已经进入 `mainStore`：

- `products`
  项目创建、功能开关更新、SDK 凭据轮换、项目归属切换
- `policies`
  策略创建、运行时绑定/多开配置、自助解绑配置
- `cards`
  批量发卡、卡密冻结/恢复/过期控制
- `entitlements`
  授权冻结/恢复、续期、点数调账

其中 `products / policies` 已经可以在事务型 PostgreSQL adapter 下真实写入 PostgreSQL；`cards / entitlements` 当前仍然由 SQLite main store 承担。

## 运行时状态

运行时状态由 [runtime-state.js](/D:/code/OnlineVerification/src/runtime-state.js) 承接，覆盖这些高频数据：

- SDK 请求 `nonce` 防重放
- 在线会话镜像
- 活跃会话统计
- 单开 owner 协调
- runtime invalidation

可用环境变量：

```bash
RSL_STATE_STORE_DRIVER=sqlite
RSL_REDIS_URL=
RSL_REDIS_KEY_PREFIX=rsl
```

各模式说明：

- `sqlite`
  默认模式，运行时状态跟随本地数据库保存，适合单机部署
- `memory`
  适合测试和临时调试，服务重启后状态会丢失
- `redis`
  适合继续演进到多实例部署，`nonce`、会话存在性、owner 抢占和 runtime invalidation 会进入 Redis

## PostgreSQL 引导脚本

仓库现在提供了一份 PostgreSQL 主库初始化脚本：

- [init.sql](/D:/code/OnlineVerification/deploy/postgres/init.sql)

这份文件由 [render-postgres-init.mjs](/D:/code/OnlineVerification/scripts/render-postgres-init.mjs) 从当前 SQLite schema 自动生成，用来给后续 PostgreSQL 迁移打底，而不是表示服务端已经完整切换到 PostgreSQL。

可用命令：

```bash
npm run db:postgres:init
npm run db:postgres:check
```

当前生成脚本已经会把一部分 SQLite 字段映射成更适合的 PostgreSQL 类型：

- 时间字段：`TEXT` -> `TIMESTAMPTZ`
- 布尔字段：`INTEGER DEFAULT 0/1` -> `BOOLEAN DEFAULT FALSE/TRUE`
- JSON 字段：`*_json TEXT` -> `JSONB`

## 健康检查

`GET /api/health` 现在会返回当前存储画像，便于部署时确认主库和 runtime state 的配置状态。

如果 `RSL_POSTGRES_URL` 缺失，或者 `pg` 模块不可用，系统会安全回退到 SQLite，并在健康检查里把当前阶段暴露出来。

## 推荐推进顺序

1. 继续把 `cards / entitlements` 写侧补成 PostgreSQL store
2. 保留 SQLite 开发模式，避免本地调试成本突然升高
3. 让 Redis runtime state 继续承担多实例一致性职责
4. 等四块主数据读写都稳定后，再考虑把主业务默认库真正切到 PostgreSQL

这样改动面会更可控，也更容易保持现有 HTTP/TCP 协议、SDK 和回归测试稳定。
