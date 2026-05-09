import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function runPreflight(args) {
  return spawnSync(process.execPath, ["scripts/recovery-preflight.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000
  });
}

function runPlainPreflight(args) {
  return spawnSync(process.execPath, ["scripts/recovery-preflight.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000
  });
}

test("recovery preflight is exposed as an npm script and rejects unsupported targets", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["recovery:preflight"], "node scripts/recovery-preflight.mjs");

  const result = runPreflight([
    "--target-os",
    "macos",
    "--storage-profile",
    "sqlite"
  ]);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "fail");
  assert.equal(output.mode, "recovery-preflight");
  assert.equal(output.summary.willModifyData, false);
  assert.equal(output.checks.find((item) => item.name === "target-os.supported")?.status, "fail");
});

test("recovery preflight returns no-write linux postgres preview rehearsal commands", () => {
  const result = runPreflight([
    "--target-os",
    "linux",
    "--storage-profile",
    "postgres-preview",
    "--target-env-file",
    "/etc/rocksolidlicense/staging.env",
    "--app-backup-dir",
    "/var/lib/rocksolid/backups",
    "--postgres-backup-dir",
    "/var/lib/rocksolid/postgres-backups"
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "pass");
  assert.equal(output.mode, "recovery-preflight");
  assert.equal(output.summary.targetOs, "linux");
  assert.equal(output.summary.storageProfile, "postgres-preview");
  assert.equal(output.summary.willModifyData, false);
  assert.ok(output.checks.every((item) => item.status === "pass"));
  assert.deepEqual(
    output.requiredAssets.map((item) => item.path),
    [
      "deploy/linux/backup-rocksolid.sh",
      "deploy/linux/healthcheck-rocksolid.sh",
      "deploy/postgres/backup-postgres.sh",
      "deploy/postgres/restore-postgres.sh",
      "deploy/systemd/rocksolid-postgres-backup.timer",
      "docs/postgres-backup-restore.md",
      "docs/production-operations-runbook.md"
    ]
  );
  assert.match(output.nextCommands.appBackup, /deploy\/linux\/backup-rocksolid\.sh/);
  assert.match(output.nextCommands.postgresBackup, /deploy\/postgres\/backup-postgres\.sh/);
  assert.match(output.nextCommands.postgresRestoreDryRun, /restore-postgres\.sh --file \$BACKUP_FILE --no-clean/);
  assert.match(output.nextCommands.healthcheck, /deploy\/linux\/healthcheck-rocksolid\.sh/);
});

test("recovery preflight emits a backup restore closeout backfill handoff", () => {
  const result = runPreflight([
    "--target-os",
    "linux",
    "--storage-profile",
    "postgres-preview",
    "--target-env-file",
    "/etc/rocksolidlicense/staging.env",
    "--app-backup-dir",
    "/var/lib/rocksolid/backups",
    "--postgres-backup-dir",
    "/var/lib/rocksolid/postgres-backups",
    "--product-code",
    "pilot_alpha",
    "--channel",
    "stable"
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.closeoutBackfill.status, "ready_for_backup_restore_backfill");
  assert.equal(output.closeoutBackfill.key, "backup_restore_drill_result");
  assert.equal(output.closeoutBackfill.filledCloseoutInputFile, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.equal(output.closeoutBackfill.readinessActionQueueFile, "artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md");
  assert.equal(output.closeoutBackfill.artifactPath, "artifacts/staging/PILOT_ALPHA/stable/backup-restore-drill.txt");
  assert.deepEqual(output.closeoutBackfill.receiptIds, [
    "<recovery-drill-receipt-id>",
    "<backup-verification-receipt-id>"
  ]);
  assert.equal(
    output.closeoutBackfill.command,
    "npm.cmd run staging:closeout:backfill -- --input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/backup-restore-drill.txt --receipt-id <recovery-drill-receipt-id> --receipt-id <backup-verification-receipt-id> --actions-file artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md"
  );
  assert.equal(
    output.closeoutBackfill.statusCommand,
    "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/stable/readiness-action-queue.md"
  );
  assert.match(output.closeoutBackfill.nextAction, /backfill backup_restore_drill_result/i);
});

test("recovery preflight returns no-write windows sqlite rehearsal commands", () => {
  const result = runPreflight([
    "--target-os",
    "windows",
    "--storage-profile",
    "sqlite",
    "--target-env-file",
    "C:\\RockSolidLicense\\deploy\\windows\\rocksolid.env.ps1",
    "--app-backup-dir",
    "C:\\RockSolidLicense\\backups"
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "pass");
  assert.equal(output.summary.targetOs, "windows");
  assert.equal(output.summary.storageProfile, "sqlite");
  assert.equal(output.summary.willModifyData, false);
  assert.ok(output.checks.every((item) => item.status === "pass"));
  assert.equal(output.nextCommands.postgresBackup, null);
  assert.equal(output.nextCommands.postgresRestoreDryRun, null);
  assert.match(output.nextCommands.appBackup, /backup-rocksolid\.ps1/);
  assert.match(output.nextCommands.restoreDrillReminder, /separate restore target/i);
  assert.match(output.nextCommands.healthcheck, /healthcheck-rocksolid\.ps1/);
});

test("recovery preflight plain output prints closeout backfill handoff", () => {
  const result = runPlainPreflight([
    "--target-os",
    "windows",
    "--storage-profile",
    "sqlite",
    "--target-env-file",
    "C:\\RockSolidLicense\\deploy\\windows\\rocksolid.env.ps1",
    "--app-backup-dir",
    "C:\\RockSolidLicense\\backups",
    "--product-code",
    "pilot_alpha",
    "--channel",
    "stable"
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Recovery preflight passed\. No data was modified\./);
  assert.match(result.stdout, /Recovery closeout backfill current: backup_restore_drill_result/);
  assert.match(result.stdout, /Recovery closeout backfill command: npm\.cmd run staging:closeout:backfill -- --input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/backup-restore-drill\.txt --receipt-id <recovery-drill-receipt-id> --receipt-id <backup-verification-receipt-id> --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md/);
  assert.match(result.stdout, /Recovery readiness status: npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/stable\/readiness-action-queue\.md/);
});
