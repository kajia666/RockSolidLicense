# 生产存储底座

当前版本已经把“运行时状态”从业务服务里抽成了独立的 state store 抽象，主要覆盖两类数据：

- SDK 请求 nonce 防重放
- 在线会话计数与生命周期镜像

这一步的目标不是假装已经完成 PostgreSQL / Redis 全量迁移，而是先把后续迁移最容易卡住的边界抽出来。

## 当前可用模式

- 主业务数据库：固定为 SQLite
- 运行时状态存储：`sqlite`、`memory` 或 `redis`

环境变量：

```bash
RSL_DB_PATH=./data/rocksolid.db
RSL_STATE_STORE_DRIVER=sqlite
RSL_POSTGRES_URL=
RSL_REDIS_URL=
RSL_REDIS_KEY_PREFIX=rsl
```

说明：

- `RSL_STATE_STORE_DRIVER=sqlite`：默认模式，nonce 与在线会话统计依然依附本地数据库。
- `RSL_STATE_STORE_DRIVER=memory`：适合测试或单进程调试，nonce 和在线状态保存在进程内存里，服务重启后会丢失。
- `RSL_STATE_STORE_DRIVER=redis`：nonce 防重放会走 Redis，在线会话会同步一份 Redis 运行时镜像，便于继续演进到多实例部署。
- `RSL_POSTGRES_URL`：当前仍然是主业务数据库迁移的规划配置占位。
- `RSL_REDIS_URL`：当 `RSL_STATE_STORE_DRIVER=redis` 时必填。

## 健康检查

`GET /api/health` 现在会返回存储画像，例如：

```json
{
  "ok": true,
  "data": {
    "status": "ok",
    "env": "development",
    "storage": {
      "database": {
        "driver": "sqlite",
        "postgresUrlConfigured": false
      },
      "runtimeState": {
        "driver": "redis",
        "nonceReplayStore": "redis",
        "sessionPresenceStore": "redis_mirror",
        "externalReady": true
      }
    }
  }
}
```

## 下一阶段建议

推荐按这个顺序继续推进：

1. 先把 SQLite 直连 SQL 访问继续收敛成 repository / gateway 边界。
2. 再把 Redis 在线会话镜像从“运行时镜像”推进到真正多实例协调。
3. 最后再迁主业务数据到 PostgreSQL。

这样改动面会小很多，也更容易保持现有 HTTP/TCP 协议和测试稳定。
