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
