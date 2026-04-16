# Windows Deployment Guide

这份指南面向当前仓库的 `Windows Server` 直接部署路径，目标是让你先把服务稳定跑起来，再逐步补齐 HTTPS、备份、巡检和后续扩展。

如果你更熟悉 Windows，这条路完全可以先上线。当前仓库也已经配好了对应的 PowerShell 脚本、计划任务、备份和健康检查骨架。

## 当前推荐方案

Windows 上当前最稳的首发方式是：

- 直接运行 Node.js 服务
- 用 `Scheduled Task` 做开机自启
- 用 `Caddy` 或 `IIS` 放在前面处理 HTTPS
- 按需决定是否对外开放 `4000/tcp` 给 TCP Gateway

如果你准备的是第一台正式商用服务器，这条路线已经足够实用。

## 仓库内已提供的 Windows 资产

- [rocksolid.env.ps1.example](/D:/code/OnlineVerification/deploy/windows/rocksolid.env.ps1.example)
- [run-rocksolid.ps1](/D:/code/OnlineVerification/deploy/windows/run-rocksolid.ps1)
- [register-rocksolid-task.ps1](/D:/code/OnlineVerification/deploy/windows/register-rocksolid-task.ps1)
- [unregister-rocksolid-task.ps1](/D:/code/OnlineVerification/deploy/windows/unregister-rocksolid-task.ps1)
- [configure-firewall.ps1](/D:/code/OnlineVerification/deploy/windows/configure-firewall.ps1)
- [backup-rocksolid.ps1](/D:/code/OnlineVerification/deploy/windows/backup-rocksolid.ps1)
- [register-rocksolid-backup-task.ps1](/D:/code/OnlineVerification/deploy/windows/register-rocksolid-backup-task.ps1)
- [healthcheck-rocksolid.ps1](/D:/code/OnlineVerification/deploy/windows/healthcheck-rocksolid.ps1)
- [Caddyfile.example](/D:/code/OnlineVerification/deploy/windows/Caddyfile.example)

## 建议目录

```text
C:\RockSolidLicense
  src\
  docs\
  deploy\
  data\
  logs\
  backups\
```

建议把仓库放在固定路径，避免后面计划任务、日志路径和备份脚本还要一起改。

## 基础准备

1. 安装 `Node.js 24`。
2. 把仓库放到 `C:\RockSolidLicense`。
3. 复制 [rocksolid.env.ps1.example](/D:/code/OnlineVerification/deploy/windows/rocksolid.env.ps1.example) 为 `C:\RockSolidLicense\deploy\windows\rocksolid.env.ps1`。
4. 至少修改这些值：
   - `RSL_ADMIN_PASSWORD`
   - `RSL_SERVER_TOKEN_SECRET`
5. 如果你准备启用 Redis 或 PostgreSQL，再补：
   - `RSL_MAIN_STORE_DRIVER`
   - `RSL_STATE_STORE_DRIVER`
   - `RSL_REDIS_URL`
   - `RSL_POSTGRES_URL`

默认建议：

- 单机最简单：`sqlite + sqlite`
- 更适合早期生产：`sqlite + redis`
- 后续升级路径：`postgres preview + redis`

存储组合的详细说明建议结合这两份文档一起看：

- [storage-deployment-guide.md](/D:/code/OnlineVerification/docs/storage-deployment-guide.md)
- [production-operations-runbook.md](/D:/code/OnlineVerification/docs/production-operations-runbook.md)

## 手工启动一次

先在服务器上手工跑一遍，确认配置和路径都没有问题：

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\run-rocksolid.ps1
```

启动后重点确认：

- 管理后台：`http://127.0.0.1:3000/admin`
- 健康检查：`http://127.0.0.1:3000/api/health`
- TCP Gateway：`127.0.0.1:4000`

当前运行脚本会把日志追加到：

- `C:\RockSolidLicense\logs\rocksolid-server.log`

## 健康检查

仓库里已经提供了 Windows 健康检查脚本：

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\healthcheck-rocksolid.ps1
```

它会检查：

- `GET /api/health`
- `TCP 4000` 是否可连

如果只想验证 HTTP：

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\healthcheck-rocksolid.ps1 -SkipTcp
```

当前健康返回要重点看这两个值：

- `ok=true`
- `data.status=ok`

如果这里不对，不要急着把流量接进来，先回头检查环境变量、端口占用和数据目录。

## 注册开机自启

确认手工启动正常后，再注册计划任务：

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\register-rocksolid-task.ps1
```

这个脚本会创建一个系统级 `Scheduled Task`：

- 默认任务名：`RockSolidLicense`
- 运行账号：`SYSTEM`
- 触发方式：开机启动
- 失败后会自动尝试重启

如果你后续要移除它，可以使用：

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\unregister-rocksolid-task.ps1
```

## 防火墙

如果你准备直接对外开放服务端口，可以先执行：

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\configure-firewall.ps1
```

脚本默认会处理：

- `3000/tcp`：HTTP 管理后台和 API
- `4000/tcp`：TCP Gateway

更推荐的公网暴露方式是：

- 对外只开放 `443/tcp`
- `80/tcp` 只用于跳转或证书验证
- `3000/tcp` 保持内网可见
- `4000/tcp` 只有在 SDK 真的使用 TCP 模式时才开放到公网

## HTTPS 反向代理

如果你准备先用 Windows 服务器直接上线，最省心的一条路通常是：

- `HTTP / 后台 / API` 走 `Caddy` 或 `IIS`
- `TCP Gateway` 继续使用独立的 `4000/tcp`

仓库里已经给了一个简单模板：

- [Caddyfile.example](/D:/code/OnlineVerification/deploy/windows/Caddyfile.example)

最简思路是：

1. 把 `example.com` 改成你的真实域名。
2. 让 `Caddy` 反代到 `127.0.0.1:3000`。
3. 对外主要暴露 `443/tcp`。
4. 只有在客户端启用了 TCP 传输时，再决定是否开放 `4000/tcp`。

如果你已经有 IIS、云负载均衡或其他网关，也可以继续沿用，但建议整个入口层只保留一层 HTTPS 终结点，避免排查时链路过深。

## 备份

手工备份命令：

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\backup-rocksolid.ps1
```

它默认会把这些关键文件打包成 zip：

- `rocksolid.db`
- `license_private.pem`
- `license_public.pem`
- `license_keyring.json`
- `rocksolid.env.ps1`

默认输出目录：

- `C:\RockSolidLicense\backups`

注册每日自动备份：

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\register-rocksolid-backup-task.ps1
```

默认配置是：

- 每天 `03:15` 执行
- 以 `SYSTEM` 身份运行
- 自动清理超过 `14` 天的旧备份

如果你启用了 `postgres` 作为主库，要注意这个脚本仍然很重要，但它本身并不替代 PostgreSQL 的数据库级备份。那种情况下还需要额外做：

- `pg_dump`
- 数据卷快照
- 或托管 PostgreSQL 的备份策略

## 上线前最少要确认的事

1. 已经修改默认管理员密码和 `RSL_SERVER_TOKEN_SECRET`。
2. `rocksolid.env.ps1` 只保存在服务器本地，不放进公开目录。
3. 手工启动能成功，日志正常写入 `C:\RockSolidLicense\logs\rocksolid-server.log`。
4. `GET /api/health` 返回 `ok=true` 且 `data.status=ok`。
5. Windows 重启后，计划任务能把服务自动拉起来。
6. 至少做过一次手工备份，并确认 zip 能正常打开。
7. 后台能登录，能创建项目、策略、卡密，并能跑通一次登录验证和心跳。
8. HTTPS 入口可用，证书状态正常。
9. 如果 TCP 对公网开放，防火墙和云安全组规则已经核对过。

## 推荐的首发顺序

如果你是准备尽快先跑起来，我建议按这个顺序：

1. 先按 `Windows Server + Scheduled Task + Caddy HTTPS` 跑单机。
2. 先把备份和健康检查固定下来。
3. 先接一小批真实项目或真实客户端流量。
4. 稳定后再考虑把主数据推进到 `PostgreSQL Preview + Redis`。

## 继续往下看

这几份文档和这份 Windows 指南是配套关系：

- [production-launch-checklist.md](/D:/code/OnlineVerification/docs/production-launch-checklist.md)
- [production-operations-runbook.md](/D:/code/OnlineVerification/docs/production-operations-runbook.md)
- [storage-deployment-guide.md](/D:/code/OnlineVerification/docs/storage-deployment-guide.md)
- [server-os-choice.md](/D:/code/OnlineVerification/docs/server-os-choice.md)
