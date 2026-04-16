# 存储部署指南

这份文档专门回答一个问题：

- 当前这套系统在正式部署时，应该怎么选 `SQLite / PostgreSQL / Redis`

先说结论：

- 想尽快稳定上线：优先 `SQLite + Redis`
- 想做渐进式主库迁移验证：再考虑 `PostgreSQL Preview + Redis`

## 当前存储是怎么拆的

现在仓库已经把存储拆成了两层：

- 主业务数据：`mainStore`
- 运行时状态：`runtimeState`

这两层可以独立演进，所以不需要一次性全量切库。

## 方案 A：SQLite + SQLite

适合：

- 本地开发
- 单机调试
- 功能验证

配置示例：

```bash
RSL_MAIN_STORE_DRIVER=sqlite
RSL_STATE_STORE_DRIVER=sqlite
RSL_DB_PATH=./data/rocksolid.db
```

特点：

- 最简单
- 依赖最少
- 不适合多实例

## 方案 B：SQLite + Redis

这是当前更推荐的“早期生产”路线。

适合：

- 第一台正式商用服务器
- 先把在线状态协调做好
- 暂时不想把主库迁移复杂度带进首发阶段

配置示例：

```bash
RSL_MAIN_STORE_DRIVER=sqlite
RSL_STATE_STORE_DRIVER=redis
RSL_REDIS_URL=redis://127.0.0.1:6379
RSL_DB_PATH=./data/rocksolid.db
```

仓库样例：

- [rocksolid.redis-runtime.env.example](/D:/code/OnlineVerification/deploy/rocksolid.redis-runtime.env.example)
- [docker-compose.redis-runtime.yml](/D:/code/OnlineVerification/deploy/docker-compose.redis-runtime.yml)

当前价值：

- `nonce` 防重放走 Redis
- 在线会话索引走 Redis
- 单开 owner 协调走 Redis
- runtime invalidation 走 Redis

也就是说，虽然主业务数据还在 SQLite，但运行时协调已经更接近多实例形态。

## 方案 C：PostgreSQL Preview + Redis

这条路线更适合：

- 预生产
- 灰度
- 渐进式迁移
- 主库切换验证

配置示例：

```bash
RSL_MAIN_STORE_DRIVER=postgres
RSL_STATE_STORE_DRIVER=redis
RSL_POSTGRES_URL=postgres://rocksolid:secret@127.0.0.1:5432/rocksolid
RSL_REDIS_URL=redis://127.0.0.1:6379
RSL_DB_PATH=./data/rocksolid-fallback.db
```

仓库样例：

- [rocksolid.pg-redis.preview.env.example](/D:/code/OnlineVerification/deploy/rocksolid.pg-redis.preview.env.example)
- [docker-compose.pg-redis.preview.yml](/D:/code/OnlineVerification/deploy/docker-compose.pg-redis.preview.yml)
- [init.sql](/D:/code/OnlineVerification/deploy/postgres/init.sql)

这里要明确：

- 现在不是“系统已经完全摆脱 SQLite”
- 当前 PostgreSQL 能力属于分阶段 preview
- 更准确的说法是“主数据访问边界已经完成抽离，并支持逐步迁移”

## Docker Compose 应该怎么选

### 想先稳稳上线

优先：

- [docker-compose.redis-runtime.yml](/D:/code/OnlineVerification/deploy/docker-compose.redis-runtime.yml)

原因：

- 风险更低
- 对现有业务链路影响更小
- 能先把运行时一致性问题交给 Redis

### 想做渐进式迁移验证

再用：

- [docker-compose.pg-redis.preview.yml](/D:/code/OnlineVerification/deploy/docker-compose.pg-redis.preview.yml)

原因：

- 可以在不假装“全量切库完成”的前提下验证 PostgreSQL 路径
- 能和 Redis 运行时状态一起做更接近中期架构的预演

## Health 里要看哪些字段

切换存储后，先看：

- `storage.mainStore.driver`
- `storage.mainStore.implementationStage`
- `storage.mainStore.adapterReady`
- `storage.runtimeState.driver`
- `storage.runtimeState.externalReady`

如果你切了 `redis` 或 `postgres`，但 health 里没反映出来，优先排查：

- 环境变量有没有真的加载进服务
- 容器或服务是否 ready
- 连接串是否写对

## 当前对 PostgreSQL 的真实定位

建议结合下面几份文档一起看：

- [postgres-main-store-preview.md](/D:/code/OnlineVerification/docs/postgres-main-store-preview.md)
- [postgres-runtime-adapter.md](/D:/code/OnlineVerification/docs/postgres-runtime-adapter.md)
- [storage-platform-guide.md](/D:/code/OnlineVerification/docs/storage-platform-guide.md)

重点理解这几点：

- `read_side_preview`
- `core_write_preview`
- `postgres_partial`

这些阶段名不是装饰，它们就是当前能力边界。

## 推荐推进顺序

更稳的顺序是：

1. 先用 `SQLite + SQLite` 跑通开发和单机部署。
2. 再切到 `SQLite + Redis`，把运行时状态层稳定住。
3. 然后做 `PostgreSQL Preview + Redis` 验证。
4. 最后再考虑把更多主数据默认切到 PostgreSQL。

## 一句话建议

如果你现在是“准备初步上线运营”：

- 选 `SQLite + Redis`

如果你现在是“准备做中期存储迁移验证”：

- 选 `PostgreSQL Preview + Redis`
