import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
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

function runProfileInit(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/staging-profile-init.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    },
    timeout: 120_000
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
  assert.equal(output.realEnvironmentInputContract.status, "blocked_until_real_environment_inputs_ready");
  assert.deepEqual(output.realEnvironmentInputContract.missingRequiredInputKeys, []);
  assert.deepEqual(output.realEnvironmentInputContract.invalidRequiredInputKeys, ["base_url"]);
  assert.deepEqual(output.realEnvironmentInputContract.missingSecretEnvKeys, [
    "RSL_SMOKE_ADMIN_PASSWORD",
    "RSL_SMOKE_DEVELOPER_PASSWORD",
    "RSL_DEVELOPER_BEARER_TOKEN"
  ]);
  assert.equal(
    output.realEnvironmentInputContract.nonSecretInputs.find((item) => item.key === "base_url")?.valid,
    false
  );
  assert.deepEqual(
    output.realEnvironmentInputContract.secretEnvInputs.map((item) => ({
      envName: item.envName,
      present: item.present,
      value: item.value
    })),
    [
      { envName: "RSL_SMOKE_ADMIN_PASSWORD", present: false, value: "<redacted>" },
      { envName: "RSL_SMOKE_DEVELOPER_PASSWORD", present: false, value: "<redacted>" },
      { envName: "RSL_DEVELOPER_BEARER_TOKEN", present: false, value: "<redacted>" }
    ]
  );
  assert.equal(output.productionProofExecutionQueue.status, "blocked_until_real_environment_inputs_ready");
  assert.equal(output.productionProofExecutionQueue.currentActionKey, "prepare_real_environment_inputs");
  assert.equal(output.productionProofExecutionQueue.currentCommand, null);
  assert.deepEqual(
    output.productionProofExecutionQueue.steps.map((item) => ({
      order: item.order,
      key: item.key,
      phase: item.phase,
      status: item.status,
      willWriteLiveData: item.willWriteLiveData
    })),
    [
      {
        order: 1,
        key: "staging_profile_init",
        phase: "no_write",
        status: "blocked_until_real_environment_inputs_ready",
        willWriteLiveData: false
      },
      {
        order: 2,
        key: "recovery_preflight",
        phase: "no_write",
        status: "blocked_until_previous_step_complete",
        willWriteLiveData: false
      },
      {
        order: 3,
        key: "staging_preflight",
        phase: "no_write",
        status: "blocked_until_previous_step_complete",
        willWriteLiveData: false
      },
      {
        order: 4,
        key: "launch_smoke_staging",
        phase: "manual_live_write_gate",
        status: "blocked_until_operator_confirmation",
        willWriteLiveData: true
      },
      {
        order: 5,
        key: "staging_readiness_status",
        phase: "readback",
        status: "blocked_until_previous_step_complete",
        willWriteLiveData: false
      }
    ]
  );
  assert.equal(output.productionProofExecutionPack.mode, "launch-production-proof-execution-pack/v1");
  assert.equal(output.productionProofExecutionPack.status, "blocked_until_real_environment_inputs_ready");
  assert.deepEqual(output.productionProofExecutionPack.executionCursor, {
    from: "0/5",
    to: "5/5",
    expression: "0/5 -> 5/5",
    current: "0/5",
    currentStepKey: "production_proof_preflight",
    nextStepKey: "staging_profile_init"
  });
  assert.equal(output.productionProofExecutionPack.inputCheck.status, "blocked_until_real_environment_inputs_ready");
  assert.deepEqual(
    output.productionProofExecutionPack.noWriteCommands.map((item) => item.key),
    ["staging_profile_init", "recovery_preflight", "staging_preflight"]
  );
  assert.equal(output.productionProofExecutionPack.manualLiveWriteGate.key, "launch_smoke_staging");
  assert.equal(
    output.productionProofExecutionPack.readinessReadback.command,
    output.nextCommands.readinessStatus.command
  );
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
  assert.equal(output.realEnvironmentInputContract.status, "ready_for_production_proof_preflight");
  assert.deepEqual(output.realEnvironmentInputContract.missingRequiredInputKeys, []);
  assert.deepEqual(output.realEnvironmentInputContract.invalidRequiredInputKeys, []);
  assert.deepEqual(output.realEnvironmentInputContract.missingSecretEnvKeys, []);
  assert.deepEqual(output.realEnvironmentInputContract.manualLiveWriteGate, {
    key: "launch_smoke_staging",
    status: "operator_confirmation_required",
    requiresOperatorConfirmation: true,
    willWriteLiveData: true,
    willModifyData: true,
    command: "npm.cmd run launch:smoke:staging -- --base-url https://staging.example.com --allow-live-writes --product-code PILOT_ALPHA --channel beta --admin-username admin@example.com --admin-password $env:RSL_SMOKE_ADMIN_PASSWORD --developer-username launch.smoke.owner --developer-password $env:RSL_SMOKE_DEVELOPER_PASSWORD --closeout-input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
  });
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
  assert.equal(output.productionProofExecutionQueue.mode, "launch-production-proof-execution-queue/v1");
  assert.equal(output.productionProofExecutionQueue.status, "ready_for_no_write_execution");
  assert.equal(output.productionProofExecutionQueue.currentActionKey, "staging_profile_init");
  assert.equal(output.productionProofExecutionQueue.currentCommand, output.nextCommands.profileInit.command);
  assert.equal(output.productionProofExecutionQueue.manualLiveWriteGateKey, "launch_smoke_staging");
  assert.deepEqual(
    output.productionProofExecutionQueue.steps.map((item) => ({
      order: item.order,
      key: item.key,
      phase: item.phase,
      status: item.status,
      requiresOperatorConfirmation: item.requiresOperatorConfirmation,
      willWriteLiveData: item.willWriteLiveData,
      command: item.command
    })),
    [
      {
        order: 1,
        key: "staging_profile_init",
        phase: "no_write",
        status: "operator_execute",
        requiresOperatorConfirmation: false,
        willWriteLiveData: false,
        command: output.nextCommands.profileInit.command
      },
      {
        order: 2,
        key: "recovery_preflight",
        phase: "no_write",
        status: "blocked_until_previous_step_complete",
        requiresOperatorConfirmation: false,
        willWriteLiveData: false,
        command: output.nextCommands.recoveryPreflight.command
      },
      {
        order: 3,
        key: "staging_preflight",
        phase: "no_write",
        status: "blocked_until_previous_step_complete",
        requiresOperatorConfirmation: false,
        willWriteLiveData: false,
        command: output.nextCommands.stagingPreflight.command
      },
      {
        order: 4,
        key: "launch_smoke_staging",
        phase: "manual_live_write_gate",
        status: "blocked_until_operator_confirmation",
        requiresOperatorConfirmation: true,
        willWriteLiveData: true,
        command: output.nextCommands.launchSmokeStaging.command
      },
      {
        order: 5,
        key: "staging_readiness_status",
        phase: "readback",
        status: "blocked_until_previous_step_complete",
        requiresOperatorConfirmation: false,
        willWriteLiveData: false,
        command: output.nextCommands.readinessStatus.command
      }
    ]
  );
  assert.equal(output.productionProofExecutionPack.mode, "launch-production-proof-execution-pack/v1");
  assert.equal(output.productionProofExecutionPack.status, "ready_for_no_write_execution");
  assert.deepEqual(output.productionProofExecutionPack.executionCursor, {
    from: "0/5",
    to: "5/5",
    expression: "0/5 -> 5/5",
    current: "0/5",
    currentStepKey: "staging_profile_init",
    nextStepKey: "staging_profile_init"
  });
  assert.equal(output.productionProofExecutionPack.inputCheck.status, "ready_for_production_proof_preflight");
  assert.deepEqual(
    output.productionProofExecutionPack.noWriteCommands.map((item) => item.command),
    [
      output.nextCommands.profileInit.command,
      output.nextCommands.recoveryPreflight.command,
      output.nextCommands.stagingPreflight.command
    ]
  );
  assert.equal(
    output.productionProofExecutionPack.manualLiveWriteGate.status,
    "operator_confirmation_required_after_no_write_steps"
  );
  assert.equal(output.productionProofExecutionPack.readinessReadback.targetCursor, "5/5");
  assert.doesNotMatch(JSON.stringify(output), /RealAdminSecret123!|RealDeveloperSecret123!|real-bearer-token/);
});

test("production proof preflight can load launch inputs from a staging profile file", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "production-proof-profile-"));
  const profileFile = join(tempRoot, "staging-profile.json");
  const executionPackFile = join(tempRoot, "production-proof-execution-pack.md");
  const profileArgs = [
    "--base-url",
    "https://profile-staging.example.com",
    "--product-code",
    "PROFILE_ALPHA",
    "--channel",
    "stable",
    "--admin-username",
    "profile.admin@example.com",
    "--developer-username",
    "profile.dev",
    "--target-os",
    "linux",
    "--storage-profile",
    "postgres-preview",
    "--target-env-file",
    "/etc/rocksolidlicense/profile.env",
    "--app-backup-dir",
    "/var/lib/rocksolid/profile-backups",
    "--postgres-backup-dir",
    "/var/lib/rocksolid/profile-postgres-backups",
    "--output-file",
    profileFile
  ];
  try {
    const profileResult = runProfileInit(profileArgs);
    assert.equal(profileResult.status, 0, profileResult.stderr || profileResult.stdout);
    assert.equal(profileResult.stderr, "");

    const preflightResult = runPreflight([
      "--profile-file",
      profileFile,
      "--execution-pack-file",
      executionPackFile
    ], secretEnv);

    assert.equal(preflightResult.status, 0, preflightResult.stderr || preflightResult.stdout);
    assert.equal(preflightResult.stderr, "");
    const output = JSON.parse(preflightResult.stdout);
    assert.equal(output.status, "pass");
    assert.equal(output.summary.productCode, "PROFILE_ALPHA");
    assert.equal(output.summary.channel, "stable");
    assert.equal(output.realEnvironmentInputContract.status, "ready_for_production_proof_preflight");
    assert.deepEqual(output.realEnvironmentInputContract.missingRequiredInputKeys, []);
    assert.deepEqual(output.realEnvironmentInputContract.invalidRequiredInputKeys, []);
    assert.deepEqual(output.realEnvironmentInputContract.missingSecretEnvKeys, []);
    assert.equal(output.productionProofExecutionPackFile.path, executionPackFile);
    assert.equal(output.productionProofExecutionPackFile.written, true);
    assert.equal(
      output.nextCommands.profileInit.command,
      `npm.cmd run staging:profile:init -- --base-url https://profile-staging.example.com --product-code PROFILE_ALPHA --channel stable --admin-username profile.admin@example.com --developer-username profile.dev --target-os linux --storage-profile postgres-preview --target-env-file /etc/rocksolidlicense/profile.env --app-backup-dir /var/lib/rocksolid/profile-backups --postgres-backup-dir /var/lib/rocksolid/profile-postgres-backups --output-file ${profileFile}`
    );
    assert.equal(
      output.nextCommands.recoveryPreflight.command,
      "npm.cmd run recovery:preflight -- --target-os linux --storage-profile postgres-preview --target-env-file /etc/rocksolidlicense/profile.env --app-backup-dir /var/lib/rocksolid/profile-backups --postgres-backup-dir /var/lib/rocksolid/profile-postgres-backups --base-url https://profile-staging.example.com --product-code PROFILE_ALPHA --channel stable --closeout-input-file artifacts/staging/PROFILE_ALPHA/stable/filled-closeout-input.json --actions-file artifacts/staging/PROFILE_ALPHA/stable/readiness-action-queue.md"
    );
    assert.doesNotMatch(JSON.stringify(output), /RealAdminSecret123!|RealDeveloperSecret123!|real-bearer-token/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("production proof preflight supports --help output", () => {
  const result = spawnSync(process.execPath, ["scripts/production-proof-preflight.mjs", "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Usage: npm\.cmd run launch:production-proof-preflight -- \[options\]/);
  assert.match(result.stdout, /--profile-file <staging-profile\.json>/);
  assert.match(result.stdout, /--execution-pack-file <production-proof-execution-pack\.md>/);
});

test("production proof preflight can write a secret-free markdown execution pack", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "production-proof-pack-"));
  const executionPackFile = join(tempRoot, "production-proof-execution-pack.md");

  try {
    const result = runPreflight([
      ...validArgs,
      "--execution-pack-file",
      executionPackFile
    ], secretEnv);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.equal(existsSync(executionPackFile), true);

    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.productionProofExecutionPackFile, {
      path: executionPackFile,
      written: true,
      format: "markdown",
      secretFree: true
    });

    const markdown = readFileSync(executionPackFile, "utf8");
    assert.match(markdown, /# Production Proof Execution Pack/);
    assert.match(markdown, /Status: ready_for_no_write_execution/);
    assert.match(markdown, /Cursor: 0\/5 -> 5\/5/);
    assert.match(markdown, /Input Check: ready_for_production_proof_preflight/);
    assert.match(markdown, /staging_profile_init/);
    assert.match(markdown, /npm\.cmd run staging:profile:init/);
    assert.match(markdown, /launch_smoke_staging/);
    assert.match(markdown, /\$env:RSL_SMOKE_ADMIN_PASSWORD/);
    assert.match(markdown, /Secret values are not included/);
    assert.doesNotMatch(markdown, /RealAdminSecret123!|RealDeveloperSecret123!|real-bearer-token/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
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
  assert.match(result.stdout, /Production proof real-environment input contract: ready_for_production_proof_preflight \| nonSecret=14\/14 \| secretEnv=3\/3 \| missing=- \| invalid=-/);
  assert.match(result.stdout, /Production proof non-secret input: base_url \| flag=--base-url \| env=RSL_PRODUCTION_SWITCH_BASE_URL,RSL_STAGING_BASE_URL \| required=yes \| present=yes \| valid=yes \| value=https:\/\/staging\.example\.com/);
  assert.match(result.stdout, /Production proof secret env input: admin_password \| env=RSL_SMOKE_ADMIN_PASSWORD \| required=yes \| present=yes \| value=<redacted>/);
  assert.match(result.stdout, /Production proof manual live-write gate: launch_smoke_staging \| status=operator_confirmation_required \| command=npm\.cmd run launch:smoke:staging -- --base-url https:\/\/staging\.example\.com --allow-live-writes/);
  assert.match(result.stdout, /Production proof execution queue: ready_for_no_write_execution \| current=staging_profile_init \| manualGate=launch_smoke_staging/);
  assert.match(result.stdout, /Production proof execution step: 1 \| key=staging_profile_init \| phase=no_write \| status=operator_execute \| write=no \| command=npm\.cmd run staging:profile:init/);
  assert.match(result.stdout, /Production proof execution step: 4 \| key=launch_smoke_staging \| phase=manual_live_write_gate \| status=blocked_until_operator_confirmation \| write=yes \| command=npm\.cmd run launch:smoke:staging/);
  assert.match(result.stdout, /Production proof execution pack: ready_for_no_write_execution \| cursor=0\/5 -> 5\/5 \| current=staging_profile_init \| manualGate=launch_smoke_staging/);
  assert.match(result.stdout, /Production proof execution pack no-write: 1=staging_profile_init, 2=recovery_preflight, 3=staging_preflight/);
  assert.match(result.stdout, /Production proof execution pack manual gate: launch_smoke_staging \| status=operator_confirmation_required_after_no_write_steps \| command=npm\.cmd run launch:smoke:staging/);
  assert.match(result.stdout, /Production proof execution pack readiness readback: staging_readiness_status \| target=5\/5 \| command=npm\.cmd run staging:readiness:status/);
  assert.match(result.stdout, /\$env:RSL_SMOKE_ADMIN_PASSWORD/);
  assert.match(result.stdout, /\$env:RSL_SMOKE_DEVELOPER_PASSWORD/);
  assert.doesNotMatch(result.stdout, /RealAdminSecret123!|RealDeveloperSecret123!|real-bearer-token/);
});

test("production proof preflight plain failure prints a secret-free input contract", () => {
  const result = runPlainPreflight(validArgs, {
    RSL_SMOKE_ADMIN_PASSWORD: "",
    RSL_SMOKE_DEVELOPER_PASSWORD: "",
    RSL_DEVELOPER_BEARER_TOKEN: ""
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Production proof real-environment input contract: blocked_until_real_environment_inputs_ready \| nonSecret=14\/14 \| secretEnv=0\/3 \| missing=RSL_SMOKE_ADMIN_PASSWORD,RSL_SMOKE_DEVELOPER_PASSWORD,RSL_DEVELOPER_BEARER_TOKEN \| invalid=-/);
  assert.match(result.stderr, /Production proof secret env input: admin_password \| env=RSL_SMOKE_ADMIN_PASSWORD \| required=yes \| present=no \| value=<redacted>/);
  assert.match(result.stderr, /Production proof execution queue: blocked_until_real_environment_inputs_ready \| current=prepare_real_environment_inputs \| manualGate=launch_smoke_staging/);
  assert.match(result.stderr, /Production proof execution step: 1 \| key=staging_profile_init \| phase=no_write \| status=blocked_until_real_environment_inputs_ready \| write=no \| command=npm\.cmd run staging:profile:init/);
  assert.match(result.stderr, /Production proof execution pack: blocked_until_real_environment_inputs_ready \| cursor=0\/5 -> 5\/5 \| current=production_proof_preflight \| manualGate=launch_smoke_staging/);
  assert.match(result.stderr, /Production proof execution pack input check: blocked_until_real_environment_inputs_ready \| missing=RSL_SMOKE_ADMIN_PASSWORD,RSL_SMOKE_DEVELOPER_PASSWORD,RSL_DEVELOPER_BEARER_TOKEN \| invalid=-/);
  assert.match(result.stderr, /Production proof execution pack readiness readback: staging_readiness_status \| target=5\/5 \| command=npm\.cmd run staging:readiness:status/);
  assert.doesNotMatch(result.stderr, /RealAdminSecret123!|RealDeveloperSecret123!|real-bearer-token/);
});
