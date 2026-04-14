# PostgreSQL Main-Store Preview

当前仓库已经有一条可运行的 PostgreSQL main-store preview 链路，但它的定位需要说清楚：

- `products / policies / cards / entitlements` 四组主数据读侧已经可以通过 PostgreSQL 风格查询运行
- 当 adapter 支持事务接口 `withTransaction(...)` 时，`products / policies / cards / entitlements` 四组核心主数据写侧都可以进入 PostgreSQL preview
- 这仍然不是“整套系统已完整切到 PostgreSQL”，因为还有非 main-store 表仍在 SQLite
- 所以健康检查里的 `implementationStage` 会根据 adapter 能力显示为 `read_side_preview` 或 `core_write_preview`

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
  启用 PostgreSQL main-store preview
- `RSL_POSTGRES_URL`
  PostgreSQL 连接串
- `RSL_POSTGRES_PG_MODULE`
  默认是 `pg`
- `RSL_POSTGRES_PG_MODULE_PATH`
  如果需要接自定义构建或本地替代模块，可以直接指定完整路径
- `RSL_POSTGRES_POOL_MAX`
  `pg` 连接池大小

## Adapter 解析顺序

当 `RSL_MAIN_STORE_DRIVER=postgres` 时，启动时会按这条顺序解析 adapter：

1. 如果代码里显式传了 `postgresMainStoreAdapter`，优先使用自定义 adapter
2. 否则尝试加载 `RSL_POSTGRES_PG_MODULE_PATH`
3. 再否则尝试加载 `RSL_POSTGRES_PG_MODULE`
4. 如果模块不可用或 `RSL_POSTGRES_URL` 缺失，则安全回退到 SQLite main store

## Preview 阶段

如果 adapter 只实现：

```js
query(sql, params, meta)
```

那么当前阶段是：

- `read_side_preview`
- `products / policies / cards / entitlements` 读侧走 PostgreSQL
- 所有写侧仍在 SQLite

如果 adapter 额外实现：

```js
withTransaction(async (tx) => {
  await tx.query(...);
});
```

那么当前阶段会提升为：

- `core_write_preview`
- `products / policies / cards / entitlements` 的核心写侧都走 PostgreSQL

内置的 `pg` 风格连接池 adapter 已经支持这层事务能力。

## 健康检查示例

`GET /api/health` 里的 `storage.mainStore` 会暴露当前阶段：

```json
{
  "driver": "postgres",
  "configuredDriver": "postgres",
  "targetDriver": "postgres",
      "implementationStage": "core_write_preview",
      "fallbackReason": "non_main_store_tables_still_use_sqlite",
  "adapterReady": true,
  "writeAdapterReady": true,
  "adapterSource": "pg_pool",
  "adapterState": "ready",
  "repositoryDrivers": {
    "products": "postgres",
    "policies": "postgres",
    "cards": "postgres",
    "entitlements": "postgres"
  },
      "repositoryWriteDrivers": {
        "products": "postgres",
        "policies": "postgres",
        "cards": "postgres",
        "entitlements": "postgres"
      }
}
```

如果 `pg` 没装好，或者连接串缺失，系统会安全回退到 SQLite，并通过 `adapterState` 说明当前阻塞点。

## 当前限制

- 这还不是“主库已经完整切到 PostgreSQL”
- 当前 preview 覆盖的是 `mainStore` 四组核心主数据，不代表所有辅助表都已迁完
- 开发者账号、客户账号、会话、审计等非 main-store 表仍然主要依赖 SQLite / Redis

## 下一步建议

1. 继续把客户账号、授权生成链路和更多辅助表逐步迁进 PostgreSQL
2. 保留 SQLite 开发模式，避免本地调试成本突然升高
3. 等主要业务链路都稳定后，再考虑把主业务默认库真正切到 PostgreSQL
