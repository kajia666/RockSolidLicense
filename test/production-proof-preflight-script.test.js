import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function runPreflight(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/production-proof-preflight.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    },
    timeout: 60_000
  });
}

function runPlainPreflight(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/production-proof-preflight.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    },
    timeout: 60_000
  });
}

const validArgs = [
  "--base-url",
  "https://staging.example.com/",
  "--product-code",
  "pilot_alpha",
  "--channel",
  "beta",
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
  "--admin-username",
  "admin@example.com",
  "--developer-username",
  "launch.smoke.owner"
];

const secretEnv = {
  RSL_SMOKE_ADMIN_PASSWORD: "RealAdminSecret123!",
  RSL_SMOKE_DEVELOPER_PASSWORD: "RealDeveloperSecret123!",
  RSL_DEVELOPER_BEARER_TOKEN: "real-bearer-token"
};

test("production proof preflight is exposed and blocks non-https or missing secrets without leaking values", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["launch:production-proof-preflight"], "node scripts/production-proof-preflight.mjs");

  const result = runPreflight([
    "--base-url",
    "http://staging.example.com",
    "--product-code",
    "pilot_alpha",
    "--channel",
    "beta",
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
    "--admin-username",
    "admin@example.com",
    "--developer-username",
    "launch.smoke.owner"
  ], {
    RSL_SMOKE_ADMIN_PASSWORD: "",
    RSL_SMOKE_DEVELOPER_PASSWORD: "",
    RSL_DEVELOPER_BEARER_TOKEN: ""
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "fail");
  assert.equal(output.mode, "launch-production-proof-preflight");
  assert.equal(output.summary.willWriteLiveData, false);
  assert.equal(output.summary.willModifyData, false);
  assert.equal(output.publicHttpsProof.status, "blocked_until_public_https");
  assert.equal(output.publicHttpsProof.isHttps, false);
  assert.equal(output.secretEnvProof.status, "pending_real_environment_confirmation");
  assert.deepEqual(output.secretEnvProof.missingKeys, [
    "RSL_SMOKE_ADMIN_PASSWORD",
    "RSL_SMOKE_DEVELOPER_PASSWORD",
    "RSL_DEVELOPER_BEARER_TOKEN"
  ]);
  assert.equal(output.secretEnvProof.targetEnvFile, "/etc/rocksolidlicense/staging.env");
  assert.equal(output.checks.find((item) => item.name === "public-https.ready")?.status, "fail");
  assert.equal(output.checks.find((item) => item.name === "secret-env.loaded")?.status, "fail");
  assert.doesNotMatch(JSON.stringify(output), /RealAdminSecret123!|RealDeveloperSecret123!|real-bearer-token/);
});

test("production proof preflight returns no-write launch commands when real-environment bindings are ready", () => {
  const result = runPreflight(validArgs, secretEnv);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "pass");
  assert.equal(output.mode, "launch-production-proof-preflight");
  assert.equal(output.summary.productCode, "PILOT_ALPHA");
  assert.equal(output.summary.channel, "beta");
  assert.equal(output.summary.willWriteLiveData, false);
  assert.equal(output.summary.willModifyData, false);
  assert.equal(output.summary.proofStatus, "ready_for_real_environment_proof_start");
  assert.ok(output.checks.every((item) => item.status === "pass"));
  assert.deepEqual(output.publicHttpsProof, {
    status: "ready_public_https_entrypoint",
    baseUrl: "https://staging.example.com",
    scheme: "https",
    isHttps: true,
    currentActionKey: "confirm_public_https_entrypoint",
    nextAction: "Public HTTPS entrypoint is configured; keep live-write smoke and launch switch checks on this URL."
  });
  assert.deepEqual(output.storageProfileProof, {
    status: "ready_storage_profile_selected",
    storageProfile: "postgres-preview",
    isSelected: true,
    currentActionKey: "confirm_storage_profile_selected",
    nextAction: "Storage profile is selected; keep backup and recovery proof aligned to this profile."
  });
  assert.deepEqual(output.secretEnvProof, {
    status: "ready_secret_env_loaded",
    requiredKeys: [
      "RSL_SMOKE_ADMIN_PASSWORD",
      "RSL_SMOKE_DEVELOPER_PASSWORD",
      "RSL_DEVELOPER_BEARER_TOKEN"
    ],
    presentKeys: [
      "RSL_SMOKE_ADMIN_PASSWORD",
      "RSL_SMOKE_DEVELOPER_PASSWORD",
      "RSL_DEVELOPER_BEARER_TOKEN"
    ],
    missingKeys: [],
    requiredCount: 3,
    missingCount: 0,
    currentMissingKey: null,
    targetEnvFile: "/etc/rocksolidlicense/staging.env",
    currentActionKey: "confirm_secret_env_loaded",
    nextAction: "Required secret environment variables are loaded; continue production switch proof."
  });
  assert.deepEqual(output.backupRestoreDrillProof, {
    status: "blocked_after_recovery_preflight",
    closeoutKey: "backup_restore_drill_result",
    closeoutInputFile: "artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json",
    artifactPath: "artifacts/staging/PILOT_ALPHA/beta/backup-restore-drill.txt",
    command: "npm.cmd run recovery:preflight -- --target-os linux --storage-profile postgres-preview --target-env-file /etc/rocksolidlicense/staging.env --app-backup-dir /var/lib/rocksolid/backups --postgres-backup-dir /var/lib/rocksolid/postgres-backups --base-url https://staging.example.com --product-code PILOT_ALPHA --channel beta --closeout-input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
    receiptOperations: ["record_recovery_drill", "record_backup_verification"],
    currentActionKey: "backfill_backup_restore_drill_evidence",
    nextAction: "Backfill backup_restore_drill_result with redacted evidence and required receipt IDs before continuing production switch proof."
  });
  assert.equal(
    output.nextCommands.profileInit.command,
    "npm.cmd run staging:profile:init -- --base-url https://staging.example.com --product-code PILOT_ALPHA --channel beta --admin-username admin@example.com --developer-username launch.smoke.owner --target-os linux --storage-profile postgres-preview --target-env-file /etc/rocksolidlicense/staging.env --app-backup-dir /var/lib/rocksolid/backups --postgres-backup-dir /var/lib/rocksolid/postgres-backups --output-file artifacts/staging/PILOT_ALPHA/beta/staging-rehearsal-profile.json"
  );
  assert.equal(output.nextCommands.profileInit.willWriteLiveData, false);
  assert.equal(output.nextCommands.recoveryPreflight.command, output.backupRestoreDrillProof.command);
  assert.equal(output.nextCommands.recoveryPreflight.willModifyData, false);
  assert.equal(
    output.nextCommands.stagingPreflight.command,
    "npm.cmd run staging:preflight -- --base-url https://staging.example.com --product-code PILOT_ALPHA --channel beta --admin-username admin@example.com --admin-password $env:RSL_SMOKE_ADMIN_PASSWORD --developer-username launch.smoke.owner --developer-password $env:RSL_SMOKE_DEVELOPER_PASSWORD"
  );
  assert.equal(output.nextCommands.stagingPreflight.willWriteLiveData, false);
  assert.equal(
    output.nextCommands.launchSmokeStaging.command,
    "npm.cmd run launch:smoke:staging -- --base-url https://staging.example.com --allow-live-writes --product-code PILOT_ALPHA --channel beta --admin-username admin@example.com --admin-password $env:RSL_SMOKE_ADMIN_PASSWORD --developer-username launch.smoke.owner --developer-password $env:RSL_SMOKE_DEVELOPER_PASSWORD --closeout-input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
  );
  assert.equal(output.nextCommands.launchSmokeStaging.willWriteLiveData, true);
  assert.doesNotMatch(JSON.stringify(output), /RealAdminSecret123!|RealDeveloperSecret123!|real-bearer-token/);
});

test("production proof preflight plain output prints copyable commands without secret values", () => {
  const result = runPlainPreflight(validArgs, secretEnv);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Production proof preflight passed\. No data was modified\./);
  assert.match(result.stdout, /Production proof profile init: npm\.cmd run staging:profile:init -- --base-url https:\/\/staging\.example\.com/);
  assert.match(result.stdout, /Production proof recovery preflight: npm\.cmd run recovery:preflight -- --target-os linux --storage-profile postgres-preview/);
  assert.match(result.stdout, /Production proof staging preflight: npm\.cmd run staging:preflight -- --base-url https:\/\/staging\.example\.com/);
  assert.match(result.stdout, /Production proof live-write smoke \(manual gate\): npm\.cmd run launch:smoke:staging -- --base-url https:\/\/staging\.example\.com --allow-live-writes/);
  assert.match(result.stdout, /\$env:RSL_SMOKE_ADMIN_PASSWORD/);
  assert.match(result.stdout, /\$env:RSL_SMOKE_DEVELOPER_PASSWORD/);
  assert.doesNotMatch(result.stdout, /RealAdminSecret123!|RealDeveloperSecret123!|real-bearer-token/);
});
