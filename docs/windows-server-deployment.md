# Windows Server Deployment Guide

这份指南面向你当前这套仓库的 `Windows Server` 直接部署路径，目标是先把系统稳定跑起来，再逐步补 HTTPS、备份和运维检查。

## 推荐方式

当前仓库在 Windows 上最稳的方式是：

- 直接运行 Node.js 服务
- 用 `Scheduled Task` 做开机自启
- 用 `Caddy / IIS / 云负载均衡` 之类的反向代理处理 HTTPS
- 保留 TCP 网关独立端口

如果你准备的是第一台正式商用服务器，这条路径已经足够实用。

## 仓库内已提供的 Windows 资产

- [rocksolid.env.ps1.example](/D:/code/OnlineVerification/deploy/windows/rocksolid.env.ps1.example)
- [run-rocksolid.ps1](/D:/code/OnlineVerification/deploy/windows/run-rocksolid.ps1)
- [register-rocksolid-task.ps1](/D:/code/OnlineVerification/deploy/windows/register-rocksolid-task.ps1)
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

## 基础准备

1. 安装 `Node.js 24`。
2. 把仓库放到 `C:\RockSolidLicense`。
3. 复制 [rocksolid.env.ps1.example](/D:/code/OnlineVerification/deploy/windows/rocksolid.env.ps1.example) 为 `C:\RockSolidLicense\deploy\windows\rocksolid.env.ps1`。
4. 至少修改这些值：
   - `RSL_ADMIN_PASSWORD`
   - `RSL_SERVER_TOKEN_SECRET`
   - 如果你要上 Redis / PostgreSQL，也一起填好 `RSL_REDIS_URL` / `RSL_POSTGRES_URL`

## 手工启动一次

先在服务器上跑一遍，确认配置没问题：

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\run-rocksolid.ps1
```

启动后检查：

- 后台入口：`http://127.0.0.1:3000/admin`
- 健康检查：`http://127.0.0.1:3000/api/health`
- TCP 网关：`127.0.0.1:4000`

当前运行脚本会自动把日志追加到：

- `C:\RockSolidLicense\logs\rocksolid-server.log`

## 注册开机自启

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\register-rocksolid-task.ps1
```

这会创建一个系统级 `Scheduled Task`，默认开机自动拉起服务。

## 开放防火墙

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\configure-firewall.ps1
```

默认涉及端口：

- `3000/tcp`：HTTP 管理后台和 API
- `4000/tcp`：TCP Gateway
- 如果你用了 HTTPS 反代，还会有 `80/tcp`、`443/tcp`

## HTTPS 反代

如果你更偏 Windows，又想尽快拿到一个比较省心的 HTTPS 入口，我建议：

- `HTTP / 后台 / API`：用 `Caddy` 或 `IIS`
- `TCP Gateway`：继续走 `4000` 独立端口，或者后面再挂 TCP 负载均衡

仓库里已经放了一个简单模板：

- [Caddyfile.example](/D:/code/OnlineVerification/deploy/windows/Caddyfile.example)

最简思路是：

1. 把 `example.com` 改成你自己的域名
2. 让 Caddy 反代到 `127.0.0.1:3000`
3. 外网只暴露 `443`
4. `4000` 是否开放给公网，按你的 SDK 方案决定

## 备份

手工备份：

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\backup-rocksolid.ps1
```

它会把这些关键文件打成 zip：

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

默认是每天 `03:15` 备份，并清理超过 `14` 天的旧备份。

## 健康检查

你可以用这个脚本做简单巡检：

```powershell
powershell -ExecutionPolicy Bypass -File C:\RockSolidLicense\deploy\windows\healthcheck-rocksolid.ps1
```

它会检查：

- `GET /api/health`
- `TCP 4000` 端口是否可连

如果你只想测 HTTP，可以加：

```powershell
-SkipTcp
```

## 上线前检查单

正式开始运营前，至少确认这些点：

1. 已修改默认管理员密码和 `RSL_SERVER_TOKEN_SECRET`
2. `rocksolid.env.ps1` 已保存到服务器本地，不在公开目录里
3. `/api/health` 正常返回
4. Windows 开机重启后，服务能自动起来
5. 已做一次手工备份并确认 zip 可见
6. 已验证后台能登录、发卡、登录验证、心跳
7. HTTPS 入口可用，证书正常
8. 如果对外开放 TCP，已确认防火墙和云安全组规则正确

## 现阶段建议

如果你准备尽快开始初步运营，我建议这套顺序：

1. 先按 `Windows Server + Scheduled Task + Caddy HTTPS` 跑单机
2. 配好每日备份
3. 先让真实客户端连进来跑一轮
4. 稳定后再考虑把主数据切到 `PostgreSQL + Redis`
