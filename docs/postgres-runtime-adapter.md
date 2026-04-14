# PostgreSQL Runtime Adapter

当前仓库已经有一条可运行的 PostgreSQL main-store runtime adapter 链路，但它的定位要说清楚：

- `products / policies / cards / entitlements` 这四组主数据读侧，已经可以通过 `pg` 风格连接池走 PostgreSQL 查询
- 主业务写路径现在仍然保留在 SQLite
- 所以健康检查里的 `implementationStage` 仍会显示 `read_side_preview`

## 环境变量

```bash
RSL_MAIN_STORE_DRIVER=postgres
RSL_POSTGRES_URL=postgres://rocksolid:secret@127.0.0.1:5432/rocksolid
RSL_POSTGRES_PG_MODULE=pg
RSL_POSTGRES_PG_MODULE_PATH=
RSL_POSTGRES_POOL_MAX=10
```

说明：

- `RSL_MAIN_STORE_DRIVER=postgres`
  启用 PostgreSQL main-store runtime adapter 解析
- `RSL_POSTGRES_URL`
  PostgreSQL 连接串
- `RSL_POSTGRES_PG_MODULE`
  默认是 `pg`
- `RSL_POSTGRES_PG_MODULE_PATH`
  如果你想接自定义构建或本地替代模块，可以直接指定完整路径
- `RSL_POSTGRES_POOL_MAX`
  `pg` 连接池大小

## 当前行为

当 `RSL_MAIN_STORE_DRIVER=postgres` 时，启动时会按这条顺序解析 adapter：

1. 如果代码里显式传了 `postgresMainStoreAdapter`，优先使用自定义 adapter
2. 否则尝试加载 `RSL_POSTGRES_PG_MODULE_PATH`
3. 再否则尝试加载 `RSL_POSTGRES_PG_MODULE`
4. 如果模块不可用或 `RSL_POSTGRES_URL` 缺失，则安全回退到 SQLite main store

## 健康检查

`GET /api/health` 里现在会返回 main-store 的 runtime adapter 信息，例如：

```json
{
  "storage": {
    "mainStore": {
      "driver": "postgres",
      "configuredDriver": "postgres",
      "targetDriver": "postgres",
      "implementationStage": "read_side_preview",
      "fallbackReason": "writes_still_use_sqlite",
      "adapterReady": true,
      "adapterSource": "pg_pool",
      "adapterState": "ready",
      "pgModuleTarget": "pg",
      "pgModuleLoaded": true,
      "poolMax": 10,
      "repositoryDrivers": {
        "products": "postgres",
        "policies": "postgres",
        "cards": "postgres",
        "entitlements": "postgres"
      }
    }
  }
}
```

如果 `pg` 没装好，或者连接串缺失，`driver` 会安全回退，`adapterState` 会明确告诉你卡在了哪一步。

## 当前限制

- 只有主数据读侧走 PostgreSQL runtime adapter
- 写路径仍然是 SQLite
- 所以它现在适合做迁移过渡和读侧验证，不适合宣称“主库已经完整切到 PostgreSQL”

## 下一步建议

推荐按这个顺序继续推进：

1. 把写路径逐步抽成 main-store write interface
2. 先迁最关键的产品、策略、卡密、授权写路径
3. 保留 SQLite 开发模式，避免本地调试成本突然升高
