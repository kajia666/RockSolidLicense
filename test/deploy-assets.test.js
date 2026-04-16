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
});
