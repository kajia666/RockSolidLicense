import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("linux deployment assets include runtime, backup, and timer skeletons", () => {
  const envExample = readText("deploy/rocksolid.env.example");
  const runScript = readText("deploy/linux/run-rocksolid.sh");
  const healthcheckScript = readText("deploy/linux/healthcheck-rocksolid.sh");
  const backupScript = readText("deploy/linux/backup-rocksolid.sh");
  const serviceUnit = readText("deploy/systemd/rocksolid.service");
  const backupService = readText("deploy/systemd/rocksolid-backup.service");
  const backupTimer = readText("deploy/systemd/rocksolid-backup.timer");

  assert.match(envExample, /RSL_MAIN_STORE_DRIVER=sqlite/);
  assert.match(envExample, /RSL_STATE_STORE_DRIVER=sqlite/);
  assert.match(envExample, /RSL_SERVER_TOKEN_SECRET=ReplaceThisWithARandomSecret/);

  assert.match(runScript, /rocksolid-server\.log/);
  assert.match(runScript, /\/etc\/rocksolidlicense\/rocksolid\.env/);

  assert.match(healthcheckScript, /\/api\/health/);
  assert.match(healthcheckScript, /--skip-tcp/);

  assert.match(backupScript, /license_private\.pem/);
  assert.match(backupScript, /rocksolid-backup-/);
  assert.match(backupScript, /manifest\.txt/);

  assert.match(serviceUnit, /deploy\/linux\/run-rocksolid\.sh/);
  assert.match(serviceUnit, /StateDirectory=rocksolid/);
  assert.match(serviceUnit, /LogsDirectory=rocksolid/);

  assert.match(backupService, /deploy\/linux\/backup-rocksolid\.sh/);
  assert.match(backupTimer, /OnCalendar=\*-\*-\* 03:15:00/);
});

test("linux deployment guide documents the new operational scripts", () => {
  const guide = readText("docs/linux-deployment.md");

  assert.match(guide, /run-rocksolid\.sh/);
  assert.match(guide, /healthcheck-rocksolid\.sh/);
  assert.match(guide, /backup-rocksolid\.sh/);
  assert.match(guide, /rocksolid-backup\.timer/);
  assert.match(guide, /\/var\/log\/rocksolid\/rocksolid-server\.log/);
  assert.match(guide, /rocksolid\.tls\.conf\.example/);
  assert.match(guide, /Caddyfile\.example/);
});

test("launch checklist and reverse proxy examples are present", () => {
  const checklist = readText("docs/production-launch-checklist.md");
  const linuxCaddy = readText("deploy/linux/Caddyfile.example");
  const nginxTls = readText("deploy/nginx/rocksolid.tls.conf.example");

  assert.match(checklist, /Phase 1: Server ready/);
  assert.match(checklist, /RSL_SERVER_TOKEN_SECRET/);
  assert.match(checklist, /GET \/api\/health/);
  assert.match(checklist, /Caddyfile\.example/);
  assert.match(checklist, /rocksolid\.tls\.conf\.example/);

  assert.match(linuxCaddy, /license\.example\.com/);
  assert.match(linuxCaddy, /reverse_proxy 127\.0\.0\.1:3000/);
  assert.match(linuxCaddy, /4000/);

  assert.match(nginxTls, /listen 443 ssl http2/);
  assert.match(nginxTls, /ssl_certificate/);
  assert.match(nginxTls, /proxy_pass http:\/\/127\.0\.0\.1:3000/);
});

test("storage deployment guide and compose examples cover redis runtime and postgres preview paths", () => {
  const storageGuide = readText("docs/storage-deployment-guide.md");
  const redisEnv = readText("deploy/rocksolid.redis-runtime.env.example");
  const previewEnv = readText("deploy/rocksolid.pg-redis.preview.env.example");
  const redisCompose = readText("deploy/docker-compose.redis-runtime.yml");
  const previewCompose = readText("deploy/docker-compose.pg-redis.preview.yml");
  const linuxGuide = readText("docs/linux-deployment.md");

  assert.match(storageGuide, /SQLite \+ Redis/);
  assert.match(storageGuide, /PostgreSQL Preview \+ Redis/);
  assert.match(storageGuide, /docker-compose\.redis-runtime\.yml/);
  assert.match(storageGuide, /docker-compose\.pg-redis\.preview\.yml/);

  assert.match(redisEnv, /RSL_MAIN_STORE_DRIVER=sqlite/);
  assert.match(redisEnv, /RSL_STATE_STORE_DRIVER=redis/);
  assert.match(redisEnv, /RSL_REDIS_URL=redis:\/\/redis:6379/);

  assert.match(previewEnv, /RSL_MAIN_STORE_DRIVER=postgres/);
  assert.match(previewEnv, /RSL_STATE_STORE_DRIVER=redis/);
  assert.match(previewEnv, /RSL_POSTGRES_URL=postgres:\/\/rocksolid:/);
  assert.match(previewEnv, /POSTGRES_PASSWORD=ChangeThisPostgresPassword/);

  assert.match(redisCompose, /image: redis:7\.2-alpine/);
  assert.match(redisCompose, /rocksolid\.redis-runtime\.env/);
  assert.match(redisCompose, /condition: service_healthy/);

  assert.match(previewCompose, /image: postgres:17-alpine/);
  assert.match(previewCompose, /rocksolid\.pg-redis\.preview\.env/);
  assert.match(previewCompose, /init\.sql/);

  assert.match(linuxGuide, /docker-compose\.redis-runtime\.yml/);
  assert.match(linuxGuide, /docker-compose\.pg-redis\.preview\.yml/);
});

test("operations runbook and windows healthcheck document the real health response shape", () => {
  const readme = readText("README.md");
  const checklist = readText("docs/production-launch-checklist.md");
  const runbook = readText("docs/production-operations-runbook.md");
  const windowsHealthcheck = readText("deploy/windows/healthcheck-rocksolid.ps1");

  assert.match(readme, /production-operations-runbook\.md/);

  assert.match(checklist, /ok=true/);
  assert.match(checklist, /data\.status=ok/);

  assert.match(runbook, /healthcheck-rocksolid\.sh/);
  assert.match(runbook, /healthcheck-rocksolid\.ps1/);
  assert.match(runbook, /SQLite \+ Redis/);
  assert.match(runbook, /PostgreSQL Preview \+ Redis/);
  assert.match(runbook, /token-key-rotation\.md/);
  assert.match(runbook, /data\.storage\.mainStore\.driver/);

  assert.match(windowsHealthcheck, /\$response\.data/);
  assert.match(windowsHealthcheck, /\$healthData\.status/);
  assert.match(windowsHealthcheck, /\$healthData\.storage/);
  assert.match(windowsHealthcheck, /\$response\.ok/);
});

test("windows deployment guide documents scheduled task, healthcheck, backup, and caddy flow", () => {
  const readme = readText("README.md");
  const runbook = readText("docs/production-operations-runbook.md");
  const guide = readText("docs/windows-deployment-guide.md");
  const windowsCaddy = readText("deploy/windows/Caddyfile.example");
  const taskScript = readText("deploy/windows/register-rocksolid-task.ps1");
  const backupTaskScript = readText("deploy/windows/register-rocksolid-backup-task.ps1");

  assert.match(readme, /windows-deployment-guide\.md/);
  assert.match(runbook, /windows-deployment-guide\.md/);

  assert.match(guide, /register-rocksolid-task\.ps1/);
  assert.match(guide, /healthcheck-rocksolid\.ps1/);
  assert.match(guide, /register-rocksolid-backup-task\.ps1/);
  assert.match(guide, /Caddyfile\.example/);
  assert.match(guide, /C:\\RockSolidLicense\\logs\\rocksolid-server\.log/);
  assert.match(guide, /ok=true/);
  assert.match(guide, /data\.status=ok/);
  assert.match(guide, /sqlite \+ redis/i);
  assert.match(guide, /PostgreSQL Preview \+ Redis/);

  assert.match(windowsCaddy, /reverse_proxy 127\.0\.0\.1:3000/);
  assert.match(taskScript, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(backupTaskScript, /New-ScheduledTaskTrigger -Daily/);
});

test("postgres backup and restore assets cover linux, windows, and preview compose access", () => {
  const readme = readText("README.md");
  const runbook = readText("docs/production-operations-runbook.md");
  const linuxGuide = readText("docs/linux-deployment.md");
  const windowsGuide = readText("docs/windows-deployment-guide.md");
  const postgresGuide = readText("docs/postgres-backup-restore.md");
  const previewEnv = readText("deploy/rocksolid.pg-redis.preview.env.example");
  const linuxEnv = readText("deploy/rocksolid.env.example");
  const windowsEnv = readText("deploy/windows/rocksolid.env.ps1.example");
  const previewCompose = readText("deploy/docker-compose.pg-redis.preview.yml");
  const backupShell = readText("deploy/postgres/backup-postgres.sh");
  const restoreShell = readText("deploy/postgres/restore-postgres.sh");
  const backupPs = readText("deploy/postgres/backup-postgres.ps1");
  const restorePs = readText("deploy/postgres/restore-postgres.ps1");
  const postgresBackupService = readText("deploy/systemd/rocksolid-postgres-backup.service");
  const postgresBackupTimer = readText("deploy/systemd/rocksolid-postgres-backup.timer");
  const registerPostgresTask = readText("deploy/windows/register-rocksolid-postgres-backup-task.ps1");
  const unregisterPostgresTask = readText("deploy/windows/unregister-rocksolid-postgres-backup-task.ps1");

  assert.match(readme, /postgres-backup-restore\.md/);
  assert.match(readme, /backup-postgres\.sh/);
  assert.match(readme, /restore-postgres\.ps1/);
  assert.match(readme, /rocksolid-postgres-backup\.timer/);
  assert.match(readme, /register-rocksolid-postgres-backup-task\.ps1/);

  assert.match(runbook, /postgres-backup-restore\.md/);
  assert.match(runbook, /backup-postgres\.sh/);
  assert.match(runbook, /backup-postgres\.ps1/);
  assert.match(runbook, /rocksolid-postgres-backup\.timer/);

  assert.match(linuxGuide, /postgres-backup-restore\.md/);
  assert.match(linuxGuide, /backup-postgres\.sh/);
  assert.match(linuxGuide, /rocksolid-postgres-backup\.service/);
  assert.match(linuxGuide, /03:35/);
  assert.match(windowsGuide, /postgres-backup-restore\.md/);
  assert.match(windowsGuide, /backup-postgres\.ps1/);
  assert.match(windowsGuide, /register-rocksolid-postgres-backup-task\.ps1/);
  assert.match(windowsGuide, /RockSolidLicensePostgresBackup/);

  assert.match(postgresGuide, /127\.0\.0\.1:5432:5432/);
  assert.match(postgresGuide, /pg_dump/);
  assert.match(postgresGuide, /pg_restore/);
  assert.match(postgresGuide, /restore-postgres\.ps1/);
  assert.match(postgresGuide, /rocksolid-postgres-backup\.timer/);
  assert.match(postgresGuide, /03:35/);
  assert.match(postgresGuide, /register-rocksolid-postgres-backup-task\.ps1/);

  assert.match(previewEnv, /PGHOST=127\.0\.0\.1/);
  assert.match(previewEnv, /PGDATABASE=rocksolid/);
  assert.match(linuxEnv, /# PGHOST=127\.0\.0\.1/);
  assert.match(windowsEnv, /\$env:PGHOST = "127\.0\.0\.1"/);

  assert.match(previewCompose, /127\.0\.0\.1:5432:5432/);

  assert.match(backupShell, /pg_dump/);
  assert.match(backupShell, /--format=custom/);
  assert.match(backupShell, /RSL_POSTGRES_URL/);
  assert.match(restoreShell, /pg_restore/);
  assert.match(restoreShell, /--no-clean/);
  assert.match(restoreShell, /\.sql\.gz/);

  assert.match(backupPs, /pg_dump\.exe/);
  assert.match(backupPs, /RSL_POSTGRES_URL/);
  assert.match(restorePs, /pg_restore\.exe/);
  assert.match(restorePs, /SkipClean/);

  assert.match(postgresBackupService, /deploy\/postgres\/backup-postgres\.sh/);
  assert.match(postgresBackupService, /BACKUP_DIR=\/var\/lib\/rocksolid\/postgres-backups/);
  assert.match(postgresBackupTimer, /OnCalendar=\*-\*-\* 03:35:00/);
  assert.match(registerPostgresTask, /RockSolidLicensePostgresBackup/);
  assert.match(registerPostgresTask, /backup-postgres\.ps1/);
  assert.match(registerPostgresTask, /Minute = 35/);
  assert.match(unregisterPostgresTask, /RockSolidLicensePostgresBackup/);
  assert.match(unregisterPostgresTask, /Unregister-ScheduledTask/);
});
