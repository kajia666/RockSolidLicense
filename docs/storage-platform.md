# 生产存储规划

当前仓库已经把“运行时状态”和“主业务数据”拆成了两层：

- 主业务数据：当前仍使用 SQLite
- 运行时状态：支持 `sqlite`、`memory`、`redis`

这样做的目标不是假装已经完成 PostgreSQL 迁移，而是先把最影响多实例部署的边界收出来，后续可以分阶段推进。

## 当前存储模型

### 主业务数据

主业务表现在仍然由 [database.js](/D:/code/OnlineVerification/src/database.js) 初始化，默认数据库文件由 `RSL_DB_PATH` 控制：

```bash
RSL_DB_PATH=./data/rocksolid.db
```

当前服务端的主业务数据驱动仍然是 SQLite，适合本地开发、单机调试和当前回归测试。

当前已经开始把主库读写边界从大体量服务逻辑里抽出来。第一块抽离的是项目/产品查询仓储：

- [product-repository.js](/D:/code/OnlineVerification/src/data/product-repository.js)
- [policy-repository.js](/D:/code/OnlineVerification/src/data/policy-repository.js)
- [card-repository.js](/D:/code/OnlineVerification/src/data/card-repository.js)

这一步的重点不是换库，而是先把“主数据访问层”收成可复用边界，后面接 PostgreSQL 时就不需要直接在 [services.js](/D:/code/OnlineVerification/src/services.js) 里到处改 SQL。

### 运行时状态

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

- `sqlite`：默认模式，运行时状态跟随本地数据库保存，适合单机部署。
- `memory`：适合测试和临时调试，服务重启后状态会丢失。
- `redis`：适合继续演进到多实例部署，`nonce`、会话存在性、owner 抢占和 runtime invalidation 会进入 Redis。

## PostgreSQL 引导脚本

仓库现在新增了一份 PostgreSQL 主库初始化脚本：

- [init.sql](/D:/code/OnlineVerification/deploy/postgres/init.sql)

这份文件由 [render-postgres-init.mjs](/D:/code/OnlineVerification/scripts/render-postgres-init.mjs) 从当前 SQLite schema 自动生成，用来给后续 PostgreSQL 迁移打底，而不是表示服务端已经切换到 PostgreSQL。

可用命令：

```bash
npm run db:postgres:init
npm run db:postgres:check
```

说明：

- `db:postgres:init`：重新生成 `deploy/postgres/init.sql`
- `db:postgres:check`：检查生成物是否和当前 SQLite schema 保持同步

当前生成脚本已经会把一部分 SQLite 字段映射成更合适的 PostgreSQL 类型：

- 时间字段：`TEXT` -> `TIMESTAMPTZ`
- 布尔字段：`INTEGER DEFAULT 0/1` -> `BOOLEAN DEFAULT FALSE/TRUE`
- JSON 字段：`*_json TEXT` -> `JSONB`

## 健康检查

`GET /api/health` 现在会返回当前存储画像，便于部署时确认主库与 runtime state 的配置状态。例如：

```json
{
  "ok": true,
  "data": {
    "status": "ok",
    "env": "development",
    "storage": {
      "database": {
        "driver": "sqlite",
        "location": "./data/rocksolid.db",
        "postgresUrlConfigured": false
      },
      "runtimeState": {
        "driver": "redis",
        "nonceReplayStore": "redis",
        "sessionPresenceStore": "redis",
        "activeSessions": 3,
        "externalReady": true
      }
    }
  }
}
```

`RSL_POSTGRES_URL` 当前仍然是“迁移规划占位配置”。也就是说，它现在会出现在健康检查里，但主业务数据还没有真正切换。

## 推荐推进顺序

建议按下面顺序继续演进：

1. 继续把 SQLite 直连访问整理成更清晰的数据访问边界。
2. 让 Redis runtime state 承担更多多实例一致性职责。
3. 再把主业务数据从 SQLite 迁到 PostgreSQL。

这样改动面会更可控，也更容易保持现有 HTTP/TCP 协议、SDK 和回归测试稳定。
