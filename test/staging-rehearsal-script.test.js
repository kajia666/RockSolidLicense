import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function runRehearsal(args) {
  return spawnSync(process.execPath, ["scripts/staging-rehearsal.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000
  });
}

const validArgs = [
  "--base-url",
  "https://staging.example.com",
  "--product-code",
  "PILOT_ALPHA",
  "--channel",
  "stable",
  "--admin-username",
  "admin@example.com",
  "--admin-password",
  "StrongAdmin123!",
  "--developer-username",
  "launch.smoke.owner",
  "--developer-password",
  "StrongDeveloper123!",
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
];

test("staging rehearsal runner is exposed as an npm script and combines no-write gates", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["staging:rehearsal"], "node scripts/staging-rehearsal.mjs");

  const result = runRehearsal(validArgs);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "pass");
  assert.equal(output.mode, "staging-rehearsal");
  assert.equal(output.summary.baseUrl, "https://staging.example.com");
  assert.equal(output.summary.productCode, "PILOT_ALPHA");
  assert.equal(output.summary.channel, "stable");
  assert.equal(output.summary.storageProfile, "postgres-preview");
  assert.equal(output.summary.willModifyData, false);
  assert.deepEqual(
    output.phases.map((item) => item.key),
    [
      "staging_command_preflight",
      "recovery_command_preflight",
      "run_staging_launch_smoke",
      "open_launch_mainline",
      "record_mainline_evidence"
    ]
  );
  assert.equal(output.preflights.staging.status, "pass");
  assert.equal(output.preflights.recovery.status, "pass");
  assert.match(output.nextCommands.launchSmoke, /launch:smoke:staging/);
  assert.doesNotMatch(output.nextCommands.launchSmoke, /StrongAdmin123!|StrongDeveloper123!/);
  assert.match(output.nextCommands.recovery.appBackup, /backup-rocksolid\.sh/);
  assert.match(output.nextCommands.launchMainline, /\/developer\/launch-mainline\?productCode=PILOT_ALPHA&channel=stable/);
  assert.deepEqual(output.evidenceOrder.slice(0, 3), [
    "Record Launch Rehearsal Run",
    "Record Recovery Drill",
    "Record Backup Verification"
  ]);
  assert.equal(output.evidenceActionPlan.endpoint, "https://staging.example.com/api/developer/launch-mainline/action");
  assert.equal(output.evidenceActionPlan.method, "POST");
  assert.equal(output.evidenceActionPlan.willModifyData, true);
  assert.deepEqual(
    output.evidenceActionPlan.items.slice(0, 4).map((item) => item.operation),
    [
      "record_launch_rehearsal_run",
      "record_recovery_drill",
      "record_backup_verification",
      "record_operations_walkthrough"
    ]
  );
  assert.deepEqual(output.evidenceActionPlan.items[0].payload, {
    productCode: "PILOT_ALPHA",
    channel: "stable",
    operation: "record_launch_rehearsal_run"
  });
  assert.equal(output.evidenceActionPlan.items[0].expectedReceiptOperation, "record_launch_rehearsal_run");
});

test("staging rehearsal runner stops before live-write steps when a no-write gate fails", () => {
  const result = runRehearsal([
    ...validArgs.slice(0, 1),
    "http://staging.example.com",
    ...validArgs.slice(2)
  ]);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "fail");
  assert.equal(output.summary.willModifyData, false);
  assert.equal(output.preflights.staging.status, "fail");
  assert.equal(output.preflights.recovery.status, "pass");
  assert.equal(output.nextCommands.launchSmoke, null);
  assert.equal(output.failedPhase.key, "staging_command_preflight");
  assert.equal(output.evidenceActionPlan, null);
});
