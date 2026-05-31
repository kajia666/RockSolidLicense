#!/usr/bin/env node
import path from "node:path";
import {
  buildProductionSwitchBackupRestoreDrillProof,
  buildProductionSwitchPublicHttpsProof,
  buildProductionSwitchSecretEnvProof,
  buildProductionSwitchStorageProfileProof
} from "./staging-proof-utils.mjs";

const SUPPORTED_TARGET_OS = new Set(["linux", "windows"]);
const SUPPORTED_STORAGE_PROFILES = new Set(["sqlite", "postgres-preview"]);
const DEFAULT_ADMIN_PASSWORD_ENV = "RSL_SMOKE_ADMIN_PASSWORD";
const DEFAULT_DEVELOPER_PASSWORD_ENV = "RSL_SMOKE_DEVELOPER_PASSWORD";
const DEFAULT_DEVELOPER_BEARER_TOKEN_ENV = "RSL_DEVELOPER_BEARER_TOKEN";
const SECRET_VALUE_FLAGS = new Set([
  "--admin-password",
  "--developer-password",
  "--developer-bearer-token",
  "--bearer-token",
  "--token",
  "--password"
]);

const OPTION_FLAGS = {
  "--base-url": "baseUrl",
  "--product-code": "productCode",
  "--channel": "channel",
  "--target-os": "targetOs",
  "--storage-profile": "storageProfile",
  "--target-env-file": "targetEnvFile",
  "--app-backup-dir": "appBackupDir",
  "--postgres-backup-dir": "postgresBackupDir",
  "--admin-username": "adminUsername",
  "--developer-username": "developerUsername",
  "--admin-password-env": "adminPasswordEnv",
  "--developer-password-env": "developerPasswordEnv",
  "--developer-bearer-token-env": "developerBearerTokenEnv",
  "--closeout-input-file": "closeoutInputFile",
  "--actions-file": "actionsFile",
  "--profile-output-file": "profileOutputFile",
  "--backup-restore-artifact": "backupRestoreArtifact"
};

function requireArgValue(name, value, inlineValue) {
  const missingValue = value === undefined
    || value === null
    || String(value).trim() === ""
    || (inlineValue === undefined && String(value).startsWith("--"));
  if (missingValue) {
    throw new Error(`${name} requires a value.`);
  }
  return String(value).trim();
}

function readOptionOrEnv(value, envName) {
  const resolved = value ?? process.env[envName] ?? null;
  return resolved === null ? null : String(resolved).trim();
}

function parseArgs(argv) {
  const options = {
    json: false,
    baseUrl: null,
    productCode: null,
    channel: null,
    targetOs: null,
    storageProfile: null,
    targetEnvFile: null,
    appBackupDir: null,
    postgresBackupDir: null,
    adminUsername: null,
    developerUsername: null,
    adminPasswordEnv: DEFAULT_ADMIN_PASSWORD_ENV,
    developerPasswordEnv: DEFAULT_DEVELOPER_PASSWORD_ENV,
    developerBearerTokenEnv: DEFAULT_DEVELOPER_BEARER_TOKEN_ENV,
    closeoutInputFile: null,
    actionsFile: null,
    profileOutputFile: null,
    backupRestoreArtifact: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (SECRET_VALUE_FLAGS.has(arg.split("=", 1)[0])) {
      throw new Error(`${arg.split("=", 1)[0]} secret values are not accepted. Set secret environment variables instead.`);
    }

    const [name, inlineValue] = arg.split("=", 2);
    const key = OPTION_FLAGS[name];
    if (!key) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = inlineValue ?? argv[index + 1];
    options[key] = requireArgValue(name, value, inlineValue);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return normalizeOptions(options);
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function sanitizeArtifactSegment(value, fallback) {
  const normalized = String(value || fallback || "default")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback || "default";
}

function normalizeOptions(options) {
  const productCode = String(readOptionOrEnv(options.productCode, "RSL_PRODUCTION_SWITCH_PRODUCT_CODE")
    || readOptionOrEnv(null, "RSL_SMOKE_PRODUCT_CODE")
    || "PRODUCTION_SWITCH").trim().toUpperCase();
  const channel = String(readOptionOrEnv(options.channel, "RSL_PRODUCTION_SWITCH_CHANNEL")
    || readOptionOrEnv(null, "RSL_SMOKE_CHANNEL")
    || "stable").trim().toLowerCase();
  const artifactRoot = path.posix.join(
    "artifacts",
    "staging",
    sanitizeArtifactSegment(productCode, "product"),
    sanitizeArtifactSegment(channel, "stable")
  );

  return {
    json: options.json,
    baseUrl: normalizeBaseUrl(
      readOptionOrEnv(options.baseUrl, "RSL_PRODUCTION_SWITCH_BASE_URL")
        || readOptionOrEnv(null, "RSL_STAGING_BASE_URL")
    ),
    productCode,
    channel,
    targetOs: String(readOptionOrEnv(options.targetOs, "RSL_RECOVERY_TARGET_OS") || "").trim().toLowerCase(),
    storageProfile: String(readOptionOrEnv(options.storageProfile, "RSL_RECOVERY_STORAGE_PROFILE") || "").trim().toLowerCase(),
    targetEnvFile: readOptionOrEnv(options.targetEnvFile, "RSL_RECOVERY_ENV_FILE"),
    appBackupDir: readOptionOrEnv(options.appBackupDir, "RSL_RECOVERY_APP_BACKUP_DIR"),
    postgresBackupDir: readOptionOrEnv(options.postgresBackupDir, "RSL_RECOVERY_POSTGRES_BACKUP_DIR"),
    adminUsername: readOptionOrEnv(options.adminUsername, "RSL_SMOKE_ADMIN_USERNAME"),
    developerUsername: readOptionOrEnv(options.developerUsername, "RSL_SMOKE_DEVELOPER_USERNAME"),
    adminPasswordEnv: String(options.adminPasswordEnv || DEFAULT_ADMIN_PASSWORD_ENV).trim(),
    developerPasswordEnv: String(options.developerPasswordEnv || DEFAULT_DEVELOPER_PASSWORD_ENV).trim(),
    developerBearerTokenEnv: String(options.developerBearerTokenEnv || DEFAULT_DEVELOPER_BEARER_TOKEN_ENV).trim(),
    closeoutInputFile: options.closeoutInputFile || path.posix.join(artifactRoot, "filled-closeout-input.json"),
    actionsFile: options.actionsFile || path.posix.join(artifactRoot, "readiness-action-queue.md"),
    profileOutputFile: options.profileOutputFile || path.posix.join(artifactRoot, "staging-rehearsal-profile.json"),
    backupRestoreArtifact: options.backupRestoreArtifact || path.posix.join(artifactRoot, "backup-restore-drill.txt"),
    artifactRoot
  };
}

function commandValue(value) {
  const text = String(value || "");
  if (/[\s"`]/.test(text)) {
    return `"${text.replace(/"/g, "`\"")}"`;
  }
  return text;
}

function makeCheck(name, passed, message) {
  return {
    name,
    status: passed ? "pass" : "fail",
    message
  };
}

function buildSecretEnvSource(options) {
  return {
    stagingEnvironmentBinding: {
      credentialEnv: {
        adminPassword: options.adminPasswordEnv,
        developerPassword: options.developerPasswordEnv,
        developerBearerToken: options.developerBearerTokenEnv
      }
    }
  };
}

function buildRecoveryPreflightCommand(options) {
  const parts = [
    "npm.cmd run recovery:preflight --",
    "--target-os",
    commandValue(options.targetOs),
    "--storage-profile",
    commandValue(options.storageProfile),
    "--target-env-file",
    commandValue(options.targetEnvFile),
    "--app-backup-dir",
    commandValue(options.appBackupDir)
  ];
  if (options.postgresBackupDir) {
    parts.push("--postgres-backup-dir", commandValue(options.postgresBackupDir));
  }
  parts.push(
    "--base-url",
    commandValue(options.baseUrl),
    "--product-code",
    commandValue(options.productCode),
    "--channel",
    commandValue(options.channel),
    "--closeout-input-file",
    commandValue(options.closeoutInputFile),
    "--actions-file",
    commandValue(options.actionsFile)
  );
  return parts.join(" ");
}

function buildProfileInitCommand(options) {
  const parts = [
    "npm.cmd run staging:profile:init --",
    "--base-url",
    commandValue(options.baseUrl),
    "--product-code",
    commandValue(options.productCode),
    "--channel",
    commandValue(options.channel),
    "--admin-username",
    commandValue(options.adminUsername),
    "--developer-username",
    commandValue(options.developerUsername),
    "--target-os",
    commandValue(options.targetOs),
    "--storage-profile",
    commandValue(options.storageProfile),
    "--target-env-file",
    commandValue(options.targetEnvFile),
    "--app-backup-dir",
    commandValue(options.appBackupDir)
  ];
  if (options.postgresBackupDir) {
    parts.push("--postgres-backup-dir", commandValue(options.postgresBackupDir));
  }
  parts.push("--output-file", commandValue(options.profileOutputFile));
  return parts.join(" ");
}

function buildStagingPreflightCommand(options) {
  return [
    "npm.cmd run staging:preflight --",
    "--base-url",
    commandValue(options.baseUrl),
    "--product-code",
    commandValue(options.productCode),
    "--channel",
    commandValue(options.channel),
    "--admin-username",
    commandValue(options.adminUsername),
    "--admin-password",
    commandValue(`$env:${options.adminPasswordEnv}`),
    "--developer-username",
    commandValue(options.developerUsername),
    "--developer-password",
    commandValue(`$env:${options.developerPasswordEnv}`)
  ].join(" ");
}

function buildLaunchSmokeStagingCommand(options) {
  return [
    "npm.cmd run launch:smoke:staging --",
    "--base-url",
    commandValue(options.baseUrl),
    "--allow-live-writes",
    "--product-code",
    commandValue(options.productCode),
    "--channel",
    commandValue(options.channel),
    "--admin-username",
    commandValue(options.adminUsername),
    "--admin-password",
    commandValue(`$env:${options.adminPasswordEnv}`),
    "--developer-username",
    commandValue(options.developerUsername),
    "--developer-password",
    commandValue(`$env:${options.developerPasswordEnv}`),
    "--closeout-input-file",
    commandValue(options.closeoutInputFile),
    "--actions-file",
    commandValue(options.actionsFile)
  ].join(" ");
}

function buildReadinessStatusCommand(options) {
  return [
    "npm.cmd run staging:readiness:status --",
    "--input-file",
    commandValue(options.closeoutInputFile),
    "--actions-file",
    commandValue(options.actionsFile)
  ].join(" ");
}

function envNameIsValid(value) {
  return /^[A-Z_][A-Z0-9_]*$/.test(String(value || ""));
}

function validateOptions(options, proofs) {
  const checks = [];
  checks.push(makeCheck(
    "product-code.format",
    /^[A-Z0-9_-]{2,64}$/.test(options.productCode),
    "Product code must be 2-64 characters using A-Z, 0-9, _ or -."
  ));
  checks.push(makeCheck(
    "channel.format",
    /^[a-z0-9_-]{2,32}$/.test(options.channel),
    "Channel must be 2-32 characters using a-z, 0-9, _ or -."
  ));
  checks.push(makeCheck(
    "public-https.ready",
    proofs.publicHttpsProof.status === "ready_public_https_entrypoint",
    "Set --base-url to a public https:// staging or production-switch URL before continuing."
  ));
  checks.push(makeCheck(
    "target-os.supported",
    SUPPORTED_TARGET_OS.has(options.targetOs),
    "Use --target-os linux or --target-os windows."
  ));
  checks.push(makeCheck(
    "storage-profile.supported",
    SUPPORTED_STORAGE_PROFILES.has(options.storageProfile),
    "Use --storage-profile sqlite or --storage-profile postgres-preview."
  ));
  checks.push(makeCheck(
    "target-env-file.present",
    Boolean(options.targetEnvFile),
    "Pass --target-env-file for the target environment file path."
  ));
  checks.push(makeCheck(
    "app-backup-dir.present",
    Boolean(options.appBackupDir),
    "Pass --app-backup-dir for the target app backup directory."
  ));
  checks.push(makeCheck(
    "postgres-backup-dir.present",
    options.storageProfile !== "postgres-preview" || Boolean(options.postgresBackupDir),
    "Pass --postgres-backup-dir for PostgreSQL preview backup/restore proof."
  ));
  checks.push(makeCheck(
    "admin-username.format",
    /^[A-Za-z0-9._@-]{3,80}$/.test(String(options.adminUsername || "")),
    "Set --admin-username or RSL_SMOKE_ADMIN_USERNAME."
  ));
  checks.push(makeCheck(
    "developer-username.format",
    /^[A-Za-z0-9._@-]{3,80}$/.test(String(options.developerUsername || "")),
    "Set --developer-username or RSL_SMOKE_DEVELOPER_USERNAME."
  ));
  checks.push(makeCheck(
    "secret-env.names",
    [options.adminPasswordEnv, options.developerPasswordEnv, options.developerBearerTokenEnv].every(envNameIsValid),
    "Secret env variable names must use A-Z, 0-9, and underscores, and cannot start with a number."
  ));
  checks.push(makeCheck(
    "secret-env.loaded",
    proofs.secretEnvProof.requiredCount === 3 && proofs.secretEnvProof.missingCount === 0,
    "Load RSL_SMOKE_ADMIN_PASSWORD, RSL_SMOKE_DEVELOPER_PASSWORD, and RSL_DEVELOPER_BEARER_TOKEN in the target shell."
  ));
  checks.push(makeCheck(
    "backup-restore-artifact.path",
    Boolean(options.backupRestoreArtifact),
    "Keep a backup/restore drill artifact path for backup_restore_drill_result."
  ));
  return checks;
}

function buildNextCommands(options, backupRestoreDrillProof) {
  return {
    profileInit: {
      key: "staging_profile_init",
      label: "Create or refresh the secret-free staging profile.",
      command: buildProfileInitCommand(options),
      willWriteLiveData: false,
      willModifyData: false
    },
    recoveryPreflight: {
      key: "recovery_preflight",
      label: "Generate backup/restore drill commands without modifying data.",
      command: backupRestoreDrillProof.command,
      willWriteLiveData: false,
      willModifyData: false
    },
    stagingPreflight: {
      key: "staging_preflight",
      label: "Validate HTTPS and smoke credentials before live-write smoke.",
      command: buildStagingPreflightCommand(options),
      willWriteLiveData: false,
      willModifyData: false
    },
    launchSmokeStaging: {
      key: "launch_smoke_staging",
      label: "Manual live-write smoke gate; run only after preflight passes.",
      command: buildLaunchSmokeStagingCommand(options),
      willWriteLiveData: true,
      willModifyData: true
    },
    readinessStatus: {
      key: "staging_readiness_status",
      label: "Refresh readiness after each backfill or record action.",
      command: buildReadinessStatusCommand(options),
      willWriteLiveData: false,
      willModifyData: false
    }
  };
}

function buildRealEnvironmentInputContract(options, proofs, nextCommands) {
  const nonSecretInput = ({
    key,
    flag,
    envNames = [],
    value = null,
    required = true,
    valid = Boolean(value)
  }) => {
    const present = Boolean(value);
    return {
      key,
      flag,
      envNames,
      required,
      present,
      valid,
      ready: valid && (!required || present),
      value: present ? value : null
    };
  };
  const nonSecretInputs = [
    nonSecretInput({
      key: "base_url",
      flag: "--base-url",
      envNames: ["RSL_PRODUCTION_SWITCH_BASE_URL", "RSL_STAGING_BASE_URL"],
      value: options.baseUrl,
      valid: proofs.publicHttpsProof.status === "ready_public_https_entrypoint"
    }),
    nonSecretInput({
      key: "product_code",
      flag: "--product-code",
      envNames: ["RSL_PRODUCTION_SWITCH_PRODUCT_CODE", "RSL_SMOKE_PRODUCT_CODE"],
      value: options.productCode,
      valid: /^[A-Z0-9_-]{2,64}$/.test(options.productCode)
    }),
    nonSecretInput({
      key: "channel",
      flag: "--channel",
      envNames: ["RSL_PRODUCTION_SWITCH_CHANNEL", "RSL_SMOKE_CHANNEL"],
      value: options.channel,
      valid: /^[a-z0-9_-]{2,32}$/.test(options.channel)
    }),
    nonSecretInput({
      key: "target_os",
      flag: "--target-os",
      envNames: ["RSL_RECOVERY_TARGET_OS"],
      value: options.targetOs,
      valid: SUPPORTED_TARGET_OS.has(options.targetOs)
    }),
    nonSecretInput({
      key: "storage_profile",
      flag: "--storage-profile",
      envNames: ["RSL_RECOVERY_STORAGE_PROFILE"],
      value: options.storageProfile,
      valid: SUPPORTED_STORAGE_PROFILES.has(options.storageProfile)
    }),
    nonSecretInput({
      key: "target_env_file",
      flag: "--target-env-file",
      envNames: ["RSL_RECOVERY_ENV_FILE"],
      value: options.targetEnvFile
    }),
    nonSecretInput({
      key: "app_backup_dir",
      flag: "--app-backup-dir",
      envNames: ["RSL_RECOVERY_APP_BACKUP_DIR"],
      value: options.appBackupDir
    }),
    nonSecretInput({
      key: "postgres_backup_dir",
      flag: "--postgres-backup-dir",
      envNames: ["RSL_RECOVERY_POSTGRES_BACKUP_DIR"],
      value: options.postgresBackupDir,
      required: options.storageProfile === "postgres-preview",
      valid: options.storageProfile !== "postgres-preview" || Boolean(options.postgresBackupDir)
    }),
    nonSecretInput({
      key: "admin_username",
      flag: "--admin-username",
      envNames: ["RSL_SMOKE_ADMIN_USERNAME"],
      value: options.adminUsername,
      valid: /^[A-Za-z0-9._@-]{3,80}$/.test(String(options.adminUsername || ""))
    }),
    nonSecretInput({
      key: "developer_username",
      flag: "--developer-username",
      envNames: ["RSL_SMOKE_DEVELOPER_USERNAME"],
      value: options.developerUsername,
      valid: /^[A-Za-z0-9._@-]{3,80}$/.test(String(options.developerUsername || ""))
    }),
    nonSecretInput({
      key: "closeout_input_file",
      flag: "--closeout-input-file",
      value: options.closeoutInputFile
    }),
    nonSecretInput({
      key: "actions_file",
      flag: "--actions-file",
      value: options.actionsFile
    }),
    nonSecretInput({
      key: "profile_output_file",
      flag: "--profile-output-file",
      value: options.profileOutputFile
    }),
    nonSecretInput({
      key: "backup_restore_artifact",
      flag: "--backup-restore-artifact",
      value: options.backupRestoreArtifact
    })
  ];
  const secretEnvInputs = [
    ["admin_password", options.adminPasswordEnv],
    ["developer_password", options.developerPasswordEnv],
    ["developer_bearer_token", options.developerBearerTokenEnv]
  ].map(([key, envName]) => ({
    key,
    envName,
    required: true,
    present: proofs.secretEnvProof.presentKeys.includes(envName),
    value: "<redacted>"
  }));
  const missingRequiredInputKeys = nonSecretInputs
    .filter((item) => item.required && !item.present)
    .map((item) => item.key);
  const invalidRequiredInputKeys = nonSecretInputs
    .filter((item) => item.required && item.present && !item.valid)
    .map((item) => item.key);
  const missingSecretEnvKeys = secretEnvInputs
    .filter((item) => item.required && !item.present)
    .map((item) => item.envName);
  const ready = missingRequiredInputKeys.length === 0
    && invalidRequiredInputKeys.length === 0
    && missingSecretEnvKeys.length === 0;
  return {
    mode: "launch-production-proof-preflight-input-contract/v1",
    status: ready
      ? "ready_for_production_proof_preflight"
      : "blocked_until_real_environment_inputs_ready",
    ready,
    willWriteLiveData: false,
    willModifyData: false,
    nonSecretReadyCount: nonSecretInputs.filter((item) => item.ready).length,
    nonSecretInputCount: nonSecretInputs.length,
    secretEnvReadyCount: secretEnvInputs.filter((item) => item.present).length,
    secretEnvInputCount: secretEnvInputs.length,
    missingRequiredInputKeys,
    invalidRequiredInputKeys,
    missingSecretEnvKeys,
    nonSecretInputs,
    secretEnvInputs,
    manualLiveWriteGate: {
      key: "launch_smoke_staging",
      status: "operator_confirmation_required",
      requiresOperatorConfirmation: true,
      willWriteLiveData: true,
      willModifyData: true,
      command: nextCommands.launchSmokeStaging.command
    },
    nextAction: ready
      ? "Run the no-write profile, recovery, and staging preflight commands before manually approving launch_smoke_staging."
      : "Fill missing or invalid real-environment inputs and secret environment variables, then rerun production proof preflight."
  };
}

function buildProductionProofExecutionQueue(realEnvironmentInputContract, nextCommands) {
  const readyForNoWriteExecution = realEnvironmentInputContract.ready === true;
  return {
    mode: "launch-production-proof-execution-queue/v1",
    status: readyForNoWriteExecution
      ? "ready_for_no_write_execution"
      : "blocked_until_real_environment_inputs_ready",
    currentActionKey: readyForNoWriteExecution
      ? "staging_profile_init"
      : "prepare_real_environment_inputs",
    currentCommand: readyForNoWriteExecution
      ? nextCommands.profileInit.command
      : null,
    manualLiveWriteGateKey: "launch_smoke_staging",
    steps: [
      {
        order: 1,
        phase: "no_write",
        status: readyForNoWriteExecution
          ? "operator_execute"
          : "blocked_until_real_environment_inputs_ready",
        requiresOperatorConfirmation: false,
        ...nextCommands.profileInit
      },
      {
        order: 2,
        phase: "no_write",
        status: "blocked_until_previous_step_complete",
        requiresOperatorConfirmation: false,
        ...nextCommands.recoveryPreflight
      },
      {
        order: 3,
        phase: "no_write",
        status: "blocked_until_previous_step_complete",
        requiresOperatorConfirmation: false,
        ...nextCommands.stagingPreflight
      },
      {
        order: 4,
        phase: "manual_live_write_gate",
        status: "blocked_until_operator_confirmation",
        requiresOperatorConfirmation: true,
        ...nextCommands.launchSmokeStaging
      },
      {
        order: 5,
        phase: "readback",
        status: "blocked_until_previous_step_complete",
        requiresOperatorConfirmation: false,
        ...nextCommands.readinessStatus
      }
    ],
    nextAction: readyForNoWriteExecution
      ? "Run staging_profile_init first, then execute each no-write step in order. Confirm the manual live-write gate before launch_smoke_staging."
      : "Fill the real-environment input contract, then rerun production proof preflight before executing the queue."
  };
}

function buildProductionProofExecutionPack(realEnvironmentInputContract, productionProofExecutionQueue, nextCommands) {
  const readyForNoWriteExecution = realEnvironmentInputContract.ready === true;
  const noWriteCommands = (productionProofExecutionQueue.steps || [])
    .filter((item) => item.phase === "no_write")
    .slice(0, 3)
    .map((item) => ({
      order: item.order,
      key: item.key,
      command: item.command,
      willWriteLiveData: item.willWriteLiveData === true,
      willModifyData: item.willModifyData === true
    }));
  return {
    mode: "launch-production-proof-execution-pack/v1",
    status: readyForNoWriteExecution
      ? "ready_for_no_write_execution"
      : "blocked_until_real_environment_inputs_ready",
    currentActionKey: readyForNoWriteExecution
      ? "staging_profile_init"
      : "production_proof_preflight",
    executionCursor: {
      from: "0/5",
      to: "5/5",
      expression: "0/5 -> 5/5",
      current: "0/5",
      currentStepKey: readyForNoWriteExecution
        ? "staging_profile_init"
        : "production_proof_preflight",
      nextStepKey: "staging_profile_init"
    },
    inputCheck: {
      status: realEnvironmentInputContract.status || "blocked_until_real_environment_inputs_ready",
      missingInputKeys: [
        ...(realEnvironmentInputContract.missingRequiredInputKeys || []),
        ...(realEnvironmentInputContract.missingSecretEnvKeys || [])
      ],
      invalidInputKeys: realEnvironmentInputContract.invalidRequiredInputKeys || []
    },
    noWriteCommands,
    manualLiveWriteGate: {
      key: realEnvironmentInputContract.manualLiveWriteGate?.key || "launch_smoke_staging",
      status: readyForNoWriteExecution
        ? "operator_confirmation_required_after_no_write_steps"
        : "blocked_until_real_environment_inputs_ready",
      command: realEnvironmentInputContract.manualLiveWriteGate?.command || nextCommands.launchSmokeStaging.command,
      confirmation: "manual_confirmation_required",
      willWriteLiveData: true,
      willModifyData: true
    },
    readinessReadback: {
      key: "staging_readiness_status",
      targetCursor: "5/5",
      command: nextCommands.readinessStatus.command
    },
    nextAction: readyForNoWriteExecution
      ? "Execute the first three no-write commands in order, confirm launch_smoke_staging manually, then refresh readiness until the downstream readback reaches 5/5."
      : "Resolve input-check gaps first, then rerun production proof preflight before entering the no-write execution lane."
  };
}

function buildResult(options) {
  const publicHttpsProof = buildProductionSwitchPublicHttpsProof(options.baseUrl);
  const storageProfileProof = buildProductionSwitchStorageProfileProof(options.storageProfile);
  const secretEnvProof = buildProductionSwitchSecretEnvProof(buildSecretEnvSource(options), options.targetEnvFile);
  const recoveryPreflightCommand = buildRecoveryPreflightCommand(options);
  const backupRestoreDrillProof = buildProductionSwitchBackupRestoreDrillProof({
    status: "blocked_after_recovery_preflight",
    closeoutInputFile: options.closeoutInputFile,
    artifactPath: options.backupRestoreArtifact,
    command: recoveryPreflightCommand,
    closeoutKey: "backup_restore_drill_result",
    receiptOperations: ["record_recovery_drill", "record_backup_verification"]
  });
  const proofs = {
    publicHttpsProof,
    storageProfileProof,
    secretEnvProof,
    backupRestoreDrillProof
  };
  const checks = validateOptions(options, proofs);
  const failedChecks = checks.filter((item) => item.status === "fail");
  const status = failedChecks.length === 0 ? "pass" : "fail";
  const proofStatus = status === "pass"
    ? "ready_for_real_environment_proof_start"
    : "blocked_before_real_environment_proof_start";
  const nextCommands = buildNextCommands(options, backupRestoreDrillProof);
  const realEnvironmentInputContract = buildRealEnvironmentInputContract(options, proofs, nextCommands);
  const productionProofExecutionQueue = buildProductionProofExecutionQueue(
    realEnvironmentInputContract,
    nextCommands
  );
  const productionProofExecutionPack = buildProductionProofExecutionPack(
    realEnvironmentInputContract,
    productionProofExecutionQueue,
    nextCommands
  );
  return {
    status,
    mode: "launch-production-proof-preflight",
    generatedAt: new Date().toISOString(),
    summary: {
      productCode: options.productCode,
      channel: options.channel,
      targetOs: options.targetOs || null,
      storageProfile: options.storageProfile || null,
      artifactRoot: options.artifactRoot,
      checksPassed: checks.length - failedChecks.length,
      checksFailed: failedChecks.length,
      proofStatus,
      willWriteLiveData: false,
      willModifyData: false
    },
    publicHttpsProof,
    storageProfileProof,
    secretEnvProof,
    backupRestoreDrillProof,
    checks,
    credentialEnv: [
      options.adminPasswordEnv,
      options.developerPasswordEnv,
      options.developerBearerTokenEnv
    ],
    realEnvironmentInputContract,
    productionProofExecutionQueue,
    productionProofExecutionPack,
    nextCommands,
    nextAction: status === "pass"
      ? "Run profileInit and recoveryPreflight first; run stagingPreflight before launchSmokeStaging, and backfill backup_restore_drill_result after the recovery drill passes."
      : failedChecks[0]?.message || "Resolve failed production proof preflight checks before continuing.",
    ...(status === "fail"
      ? { error: { message: failedChecks[0]?.message || "Production proof preflight failed." } }
      : {})
  };
}

function writeRealEnvironmentInputContract(contract, writeLine) {
  if (!contract || typeof contract !== "object") {
    return;
  }
  writeLine(
    `Production proof real-environment input contract: ${contract.status || "-"}`
      + ` | nonSecret=${contract.nonSecretReadyCount ?? "-"}/${contract.nonSecretInputCount ?? "-"}`
      + ` | secretEnv=${contract.secretEnvReadyCount ?? "-"}/${contract.secretEnvInputCount ?? "-"}`
      + ` | missing=${[
        ...(contract.missingRequiredInputKeys || []),
        ...(contract.missingSecretEnvKeys || [])
      ].join(",") || "-"}`
      + ` | invalid=${(contract.invalidRequiredInputKeys || []).join(",") || "-"}`
  );
  for (const input of contract.nonSecretInputs || []) {
    writeLine(
      `Production proof non-secret input: ${input.key || "-"}`
        + ` | flag=${input.flag || "-"}`
        + ` | env=${(input.envNames || []).join(",") || "-"}`
        + ` | required=${input.required ? "yes" : "no"}`
        + ` | present=${input.present ? "yes" : "no"}`
        + ` | valid=${input.valid ? "yes" : "no"}`
        + ` | value=${input.value || "-"}`
    );
  }
  for (const input of contract.secretEnvInputs || []) {
    writeLine(
      `Production proof secret env input: ${input.key || "-"}`
        + ` | env=${input.envName || "-"}`
        + ` | required=${input.required ? "yes" : "no"}`
        + ` | present=${input.present ? "yes" : "no"}`
        + ` | value=<redacted>`
    );
  }
  writeLine(
    `Production proof manual live-write gate: ${contract.manualLiveWriteGate?.key || "-"}`
      + ` | status=${contract.manualLiveWriteGate?.status || "-"}`
      + ` | command=${contract.manualLiveWriteGate?.command || "-"}`
  );
}

function writeProductionProofExecutionQueue(queue, writeLine) {
  if (!queue || typeof queue !== "object") {
    return;
  }
  writeLine(
    `Production proof execution queue: ${queue.status || "-"}`
      + ` | current=${queue.currentActionKey || "-"}`
      + ` | manualGate=${queue.manualLiveWriteGateKey || "-"}`
  );
  for (const step of queue.steps || []) {
    writeLine(
      `Production proof execution step: ${step.order ?? "-"}`
        + ` | key=${step.key || "-"}`
        + ` | phase=${step.phase || "-"}`
        + ` | status=${step.status || "-"}`
        + ` | write=${step.willWriteLiveData ? "yes" : "no"}`
        + ` | command=${step.command || "-"}`
    );
  }
}

function writeProductionProofExecutionPack(pack, writeLine) {
  if (!pack || typeof pack !== "object") {
    return;
  }
  writeLine(
    `Production proof execution pack: ${pack.status || "-"}`
      + ` | cursor=${pack.executionCursor?.expression || "-"}`
      + ` | current=${pack.executionCursor?.currentStepKey || "-"}`
      + ` | manualGate=${pack.manualLiveWriteGate?.key || "-"}`
  );
  writeLine(
    `Production proof execution pack input check: ${pack.inputCheck?.status || "-"}`
      + ` | missing=${(pack.inputCheck?.missingInputKeys || []).join(",") || "-"}`
      + ` | invalid=${(pack.inputCheck?.invalidInputKeys || []).join(",") || "-"}`
  );
  writeLine(
    `Production proof execution pack no-write: ${[
      `1=${pack.noWriteCommands?.[0]?.key || "-"}`,
      `2=${pack.noWriteCommands?.[1]?.key || "-"}`,
      `3=${pack.noWriteCommands?.[2]?.key || "-"}`
    ].join(", ")}`
  );
  writeLine(
    `Production proof execution pack manual gate: ${pack.manualLiveWriteGate?.key || "-"}`
      + ` | status=${pack.manualLiveWriteGate?.status || "-"}`
      + ` | command=${pack.manualLiveWriteGate?.command || "-"}`
  );
  writeLine(
    `Production proof execution pack readiness readback: ${pack.readinessReadback?.key || "-"}`
      + ` | target=${pack.readinessReadback?.targetCursor || "-"}`
      + ` | command=${pack.readinessReadback?.command || "-"}`
  );
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.status === "pass") {
    console.log("Production proof preflight passed. No data was modified.");
    console.log(`Production proof status: ${result.summary.proofStatus}`);
    writeRealEnvironmentInputContract(result.realEnvironmentInputContract, console.log);
    writeProductionProofExecutionQueue(result.productionProofExecutionQueue, console.log);
    writeProductionProofExecutionPack(result.productionProofExecutionPack, console.log);
    console.log(`Production proof profile init: ${result.nextCommands.profileInit.command}`);
    console.log(`Production proof recovery preflight: ${result.nextCommands.recoveryPreflight.command}`);
    console.log(`Production proof staging preflight: ${result.nextCommands.stagingPreflight.command}`);
    console.log(`Production proof live-write smoke (manual gate): ${result.nextCommands.launchSmokeStaging.command}`);
    console.log(`Production proof readiness refresh: ${result.nextCommands.readinessStatus.command}`);
    return;
  }

  console.error(`Production proof preflight failed: ${result.error.message}`);
  writeRealEnvironmentInputContract(result.realEnvironmentInputContract, console.error);
  writeProductionProofExecutionQueue(result.productionProofExecutionQueue, console.error);
  writeProductionProofExecutionPack(result.productionProofExecutionPack, console.error);
  for (const check of result.checks) {
    console.error(`- ${check.status.toUpperCase()} ${check.name}: ${check.message}`);
  }
}

function main() {
  let json = process.argv.includes("--json");
  try {
    const options = parseArgs(process.argv.slice(2));
    json = options.json;
    const result = buildResult(options);
    writeResult(result, json);
    if (result.status !== "pass") {
      process.exitCode = 1;
    }
  } catch (error) {
    const result = {
      status: "fail",
      mode: "launch-production-proof-preflight",
      generatedAt: new Date().toISOString(),
      summary: {
        willWriteLiveData: false,
        willModifyData: false
      },
      checks: [],
      error: {
        message: error.message
      }
    };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Production proof preflight failed: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

main();
