#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const ADMIN_PASSWORD_ENV = "RSL_SMOKE_ADMIN_PASSWORD";
const DEVELOPER_PASSWORD_ENV = "RSL_SMOKE_DEVELOPER_PASSWORD";
const DEVELOPER_BEARER_TOKEN_ENV = "RSL_DEVELOPER_BEARER_TOKEN";

const EVIDENCE_ORDER = [
  "Record Launch Rehearsal Run",
  "Record Recovery Drill",
  "Record Backup Verification",
  "Record Operations Walkthrough",
  "Record Deploy Verification",
  "Record Health Verification",
  "Record Rollback Walkthrough",
  "Record Cutover Walkthrough",
  "Record Launch Day Readiness Review",
  "Record First-Wave Ops Sweep",
  "Record Launch Closeout Review",
  "Record Launch Stabilization Review"
];

const EVIDENCE_ACTIONS = [
  ["Record Launch Rehearsal Run", "record_launch_rehearsal_run"],
  ["Record Recovery Drill", "record_recovery_drill"],
  ["Record Backup Verification", "record_backup_verification"],
  ["Record Operations Walkthrough", "record_operations_walkthrough"],
  ["Record Deploy Verification", "record_deploy_verification"],
  ["Record Health Verification", "record_health_verification"],
  ["Record Rollback Walkthrough", "record_rollback_walkthrough"],
  ["Record Cutover Walkthrough", "record_cutover_walkthrough"],
  ["Record Launch Day Readiness Review", "record_launch_day_readiness_review"],
  ["Record First-Wave Ops Sweep", "record_post_launch_ops_sweep"],
  ["Record Launch Closeout Review", "record_launch_closeout_review"],
  ["Record Launch Stabilization Review", "record_launch_stabilization_review"]
];

const RECEIPT_VISIBILITY_KEYS = [
  "launchMainline",
  "launchReview",
  "launchSmoke",
  "developerOps"
];

const PROFILE_ALLOWED_FIELDS = [
  "baseUrl",
  "productCode",
  "channel",
  "adminUsername",
  "developerUsername",
  "targetOs",
  "storageProfile",
  "targetEnvFile",
  "appBackupDir",
  "postgresBackupDir",
  "handoffFile",
  "closeoutFile",
  "runRecordFile",
  "artifactManifestFile",
  "closeoutReloadPacketFile",
  "readinessReviewPacketFile",
  "productionSignoffPacketFile",
  "launchDutyArchiveIndexFile",
  "filledCloseoutDraftFile",
  "closeoutInputFile"
];

const PROFILE_SECRET_FIELDS = [
  "adminPassword",
  "developerPassword",
  "developerBearerToken",
  "bearerToken",
  "token",
  "password"
];

const PROFILE_OPTION_FLAGS = {
  baseUrl: "--base-url",
  productCode: "--product-code",
  channel: "--channel",
  adminUsername: "--admin-username",
  developerUsername: "--developer-username",
  targetOs: "--target-os",
  storageProfile: "--storage-profile",
  targetEnvFile: "--target-env-file",
  appBackupDir: "--app-backup-dir",
  postgresBackupDir: "--postgres-backup-dir",
  handoffFile: "--handoff-file",
  closeoutFile: "--closeout-file",
  runRecordFile: "--run-record-file",
  artifactManifestFile: "--artifact-manifest-file",
  closeoutReloadPacketFile: "--closeout-reload-packet-file",
  readinessReviewPacketFile: "--readiness-review-packet-file",
  productionSignoffPacketFile: "--production-signoff-packet-file",
  launchDutyArchiveIndexFile: "--launch-duty-archive-index-file",
  filledCloseoutDraftFile: "--filled-closeout-draft-file",
  closeoutInputFile: "--closeout-input-file"
};

const CLOSEOUT_SOURCE_STEPS = {
  route_map_gate_result: "run_route_map_gate",
  backup_restore_drill_result: "run_backup_restore_drill",
  live_write_smoke_result: "run_live_write_smoke",
  launch_smoke_handoff: "archive_launch_smoke_handoff",
  launch_mainline_evidence_receipts: "record_launch_mainline_evidence",
  receipt_visibility_review: "verify_receipt_visibility",
  operator_go_no_go: "backfill_filled_closeout_input"
};

const PROFILE_BACKFILL_ARTIFACTS = [
  {
    closeoutKey: "route_map_gate_result",
    artifactKey: "route_map_gate_output",
    fileName: "route-map-gate-output.txt",
    receiptOperations: []
  },
  {
    closeoutKey: "backup_restore_drill_result",
    artifactKey: "backup_restore_drill_log",
    fileName: "backup-restore-drill.txt",
    receiptOperations: ["record_recovery_drill", "record_backup_verification"]
  },
  {
    closeoutKey: "live_write_smoke_result",
    artifactKey: "live_write_smoke_output",
    fileName: "live-write-smoke-output.json",
    receiptOperations: ["record_launch_rehearsal_run"]
  },
  {
    closeoutKey: "launch_smoke_handoff",
    artifactKey: "launch_smoke_handoff",
    fileName: "launch-smoke-handoff.json",
    receiptOperations: ["record_post_launch_ops_sweep"]
  },
  {
    closeoutKey: "launch_mainline_evidence_receipts",
    artifactKey: "launch_mainline_evidence_receipts",
    fileName: "launch-mainline-evidence-receipts.json",
    receiptOperations: EVIDENCE_ACTIONS.map(([, operation]) => operation)
  },
  {
    closeoutKey: "receipt_visibility_review",
    artifactKey: "receipt_visibility_review",
    fileName: "receipt-visibility-review.txt",
    receiptOperations: ["record_post_launch_ops_sweep"]
  },
  {
    closeoutKey: "operator_go_no_go",
    artifactKey: "operator_go_no_go",
    fileName: "operator-go-no-go.md",
    receiptOperations: []
  }
];

function parseArgs(argv) {
  const options = {
    json: false,
    baseUrl: null,
    productCode: null,
    channel: null,
    adminUsername: null,
    adminPassword: null,
    developerUsername: null,
    developerPassword: null,
    targetOs: null,
    storageProfile: null,
    targetEnvFile: null,
    appBackupDir: null,
    postgresBackupDir: null,
    handoffFile: null,
    closeoutFile: null,
    runRecordFile: null,
    artifactManifestFile: null,
    closeoutReloadPacketFile: null,
    readinessReviewPacketFile: null,
    productionSignoffPacketFile: null,
    launchDutyArchiveIndexFile: null,
    filledCloseoutDraftFile: null,
    closeoutInputFile: null,
    profileFile: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }

    const [name, inlineValue] = arg.split("=", 2);
    const value = inlineValue ?? argv[index + 1];
    if (name === "--base-url") {
      options.baseUrl = requireArgValue(name, value, inlineValue);
    } else if (name === "--product-code") {
      options.productCode = requireArgValue(name, value, inlineValue);
    } else if (name === "--channel") {
      options.channel = requireArgValue(name, value, inlineValue);
    } else if (name === "--admin-username") {
      options.adminUsername = requireArgValue(name, value, inlineValue);
    } else if (name === "--admin-password") {
      options.adminPassword = requireArgValue(name, value, inlineValue);
    } else if (name === "--developer-username") {
      options.developerUsername = requireArgValue(name, value, inlineValue);
    } else if (name === "--developer-password") {
      options.developerPassword = requireArgValue(name, value, inlineValue);
    } else if (name === "--target-os") {
      options.targetOs = requireArgValue(name, value, inlineValue);
    } else if (name === "--storage-profile") {
      options.storageProfile = requireArgValue(name, value, inlineValue);
    } else if (name === "--target-env-file") {
      options.targetEnvFile = requireArgValue(name, value, inlineValue);
    } else if (name === "--app-backup-dir") {
      options.appBackupDir = requireArgValue(name, value, inlineValue);
    } else if (name === "--postgres-backup-dir") {
      options.postgresBackupDir = requireArgValue(name, value, inlineValue);
    } else if (name === "--handoff-file") {
      options.handoffFile = requireArgValue(name, value, inlineValue);
    } else if (name === "--closeout-file") {
      options.closeoutFile = requireArgValue(name, value, inlineValue);
    } else if (name === "--run-record-file") {
      options.runRecordFile = requireArgValue(name, value, inlineValue);
    } else if (name === "--artifact-manifest-file") {
      options.artifactManifestFile = requireArgValue(name, value, inlineValue);
    } else if (name === "--closeout-reload-packet-file") {
      options.closeoutReloadPacketFile = requireArgValue(name, value, inlineValue);
    } else if (name === "--readiness-review-packet-file") {
      options.readinessReviewPacketFile = requireArgValue(name, value, inlineValue);
    } else if (name === "--production-signoff-packet-file") {
      options.productionSignoffPacketFile = requireArgValue(name, value, inlineValue);
    } else if (name === "--launch-duty-archive-index-file") {
      options.launchDutyArchiveIndexFile = requireArgValue(name, value, inlineValue);
    } else if (name === "--filled-closeout-draft-file") {
      options.filledCloseoutDraftFile = requireArgValue(name, value, inlineValue);
    } else if (name === "--closeout-input-file") {
      options.closeoutInputFile = requireArgValue(name, value, inlineValue);
    } else if (name === "--profile-file") {
      options.profileFile = requireArgValue(name, value, inlineValue);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (inlineValue === undefined) {
      index += 1;
    }
  }

  const profileFile = readOptionOrEnv(options.profileFile, "RSL_REHEARSAL_PROFILE_FILE");
  const stagingProfile = loadStagingProfile(profileFile);

  return {
    ...options,
    profileFile,
    stagingProfile: summarizeStagingProfile(stagingProfile),
    profileCliOverrideKeys: PROFILE_ALLOWED_FIELDS.filter((key) => options[key] !== null && options[key] !== undefined),
    baseUrl: resolveProfileOption(options.baseUrl, "RSL_STAGING_BASE_URL", stagingProfile, "baseUrl"),
    productCode: resolveProfileOption(options.productCode, "RSL_SMOKE_PRODUCT_CODE", stagingProfile, "productCode"),
    channel: resolveProfileOption(options.channel, "RSL_SMOKE_CHANNEL", stagingProfile, "channel", "stable"),
    adminUsername: resolveProfileOption(options.adminUsername, "RSL_SMOKE_ADMIN_USERNAME", stagingProfile, "adminUsername"),
    adminPassword: readOptionOrEnv(options.adminPassword, "RSL_SMOKE_ADMIN_PASSWORD"),
    developerUsername: resolveProfileOption(options.developerUsername, "RSL_SMOKE_DEVELOPER_USERNAME", stagingProfile, "developerUsername"),
    developerPassword: readOptionOrEnv(options.developerPassword, "RSL_SMOKE_DEVELOPER_PASSWORD"),
    targetOs: resolveProfileOption(options.targetOs, "RSL_RECOVERY_TARGET_OS", stagingProfile, "targetOs"),
    storageProfile: resolveProfileOption(options.storageProfile, "RSL_RECOVERY_STORAGE_PROFILE", stagingProfile, "storageProfile"),
    targetEnvFile: resolveProfileOption(options.targetEnvFile, "RSL_RECOVERY_ENV_FILE", stagingProfile, "targetEnvFile"),
    appBackupDir: resolveProfileOption(options.appBackupDir, "RSL_RECOVERY_APP_BACKUP_DIR", stagingProfile, "appBackupDir"),
    postgresBackupDir: resolveProfileOption(options.postgresBackupDir, "RSL_RECOVERY_POSTGRES_BACKUP_DIR", stagingProfile, "postgresBackupDir"),
    handoffFile: resolveProfileOption(options.handoffFile, "RSL_REHEARSAL_HANDOFF_FILE", stagingProfile, "handoffFile"),
    closeoutFile: resolveProfileOption(options.closeoutFile, "RSL_REHEARSAL_CLOSEOUT_FILE", stagingProfile, "closeoutFile"),
    runRecordFile: resolveProfileOption(options.runRecordFile, "RSL_REHEARSAL_RUN_RECORD_FILE", stagingProfile, "runRecordFile"),
    artifactManifestFile: resolveProfileOption(options.artifactManifestFile, "RSL_REHEARSAL_ARTIFACT_MANIFEST_FILE", stagingProfile, "artifactManifestFile"),
    closeoutReloadPacketFile: resolveProfileOption(options.closeoutReloadPacketFile, "RSL_REHEARSAL_CLOSEOUT_RELOAD_PACKET_FILE", stagingProfile, "closeoutReloadPacketFile"),
    readinessReviewPacketFile: resolveProfileOption(options.readinessReviewPacketFile, "RSL_REHEARSAL_READINESS_REVIEW_PACKET_FILE", stagingProfile, "readinessReviewPacketFile"),
    productionSignoffPacketFile: resolveProfileOption(options.productionSignoffPacketFile, "RSL_REHEARSAL_PRODUCTION_SIGNOFF_PACKET_FILE", stagingProfile, "productionSignoffPacketFile"),
    launchDutyArchiveIndexFile: resolveProfileOption(options.launchDutyArchiveIndexFile, "RSL_REHEARSAL_LAUNCH_DUTY_ARCHIVE_INDEX_FILE", stagingProfile, "launchDutyArchiveIndexFile"),
    filledCloseoutDraftFile: resolveProfileOption(options.filledCloseoutDraftFile, "RSL_REHEARSAL_FILLED_CLOSEOUT_DRAFT_FILE", stagingProfile, "filledCloseoutDraftFile"),
    closeoutInputFile: resolveProfileOption(options.closeoutInputFile, "RSL_REHEARSAL_CLOSEOUT_INPUT_FILE", stagingProfile, "closeoutInputFile")
  };
}

function requireArgValue(name, value, inlineValue) {
  const missingValue = value === undefined
    || value === null
    || String(value).trim() === ""
    || (inlineValue === undefined && String(value).startsWith("--"));
  if (missingValue) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function readOptionOrEnv(value, envName) {
  const resolved = value ?? process.env[envName] ?? null;
  return resolved === null ? null : String(resolved).trim();
}

function resolveProfileOption(value, envName, stagingProfile, key, fallback = null) {
  const optionOrEnv = readOptionOrEnv(value, envName);
  if (optionOrEnv) {
    return optionOrEnv;
  }
  const profileValue = stagingProfile?.values?.[key] ?? null;
  if (profileValue !== null && profileValue !== undefined && String(profileValue).trim() !== "") {
    return String(profileValue).trim();
  }
  return fallback;
}

function loadStagingProfile(profileFile) {
  if (!profileFile) {
    return null;
  }
  const resolvedPath = path.resolve(repoRoot, profileFile);
  const rawProfile = JSON.parse(readFileSync(resolvedPath, "utf8"));
  if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
    throw new Error("staging profile must be a JSON object.");
  }
  const values = rawProfile.stagingRehearsal && typeof rawProfile.stagingRehearsal === "object" && !Array.isArray(rawProfile.stagingRehearsal)
    ? rawProfile.stagingRehearsal
    : rawProfile;
  for (const secretField of PROFILE_SECRET_FIELDS) {
    if (Object.hasOwn(values, secretField)) {
      throw new Error(`staging profile cannot contain secret field: ${secretField}. Use environment variables or CLI flags for secret values.`);
    }
  }
  const unknownKeys = Object.keys(values).filter((key) => !PROFILE_ALLOWED_FIELDS.includes(key));
  if (unknownKeys.length) {
    throw new Error(`staging profile contains unsupported field(s): ${unknownKeys.join(", ")}`);
  }
  return {
    file: resolvedPath,
    values,
    providedKeys: Object.keys(values).sort()
  };
}

function summarizeStagingProfile(stagingProfile) {
  return {
    loaded: Boolean(stagingProfile),
    file: stagingProfile?.file || null,
    providedKeys: stagingProfile?.providedKeys || [],
    secretPolicy: "passwords_and_bearer_tokens_must_come_from_environment_or_cli"
  };
}

function commandValue(value) {
  const text = String(value || "");
  if (/[\s"`]/.test(text)) {
    return `"${text.replace(/"/g, "`\"")}"`;
  }
  return text;
}

function buildProfileDrivenCommand(options) {
  const parts = ["npm.cmd run staging:rehearsal --"];
  if (options.profileFile) {
    parts.push("--profile-file", commandValue(options.profileFile));
  } else {
    parts.push("--profile-file", "<staging-profile.json>");
  }
  for (const key of options.profileCliOverrideKeys || []) {
    const flag = PROFILE_OPTION_FLAGS[key];
    if (flag && options[key]) {
      parts.push(flag, commandValue(options[key]));
    }
  }
  return parts.join(" ");
}

function buildProfileBackfillManifest(options) {
  if (options.stagingProfile?.loaded !== true) {
    return {
      status: "profile_not_loaded",
      willModifyData: false,
      archiveRoot: null,
      closeoutInputPath: null,
      rows: [],
      nextAction: "Load a secret-free staging profile before preparing the profile-driven backfill manifest."
    };
  }
  const productCode = sanitizeArtifactPathSegment(options.productCode, "product");
  const channel = sanitizeArtifactPathSegment(options.channel || "stable", "stable");
  const archiveRoot = path.posix.join("artifacts", "staging", productCode, channel);
  return {
    status: "awaiting_profile_driven_results",
    willModifyData: false,
    archiveRoot,
    closeoutInputPath: path.posix.join(archiveRoot, "filled-closeout-input.json"),
    rows: PROFILE_BACKFILL_ARTIFACTS.map((item) => ({
      closeoutKey: item.closeoutKey,
      sourceStep: CLOSEOUT_SOURCE_STEPS[item.closeoutKey] || "operator_backfill",
      artifactKey: item.artifactKey,
      artifactPath: path.posix.join(archiveRoot, item.fileName),
      receiptOperations: item.receiptOperations,
      operatorNote: "Backfill only redacted statuses, artifact paths, receipt IDs, handoff file names, and operator decisions."
    })),
    nextAction: "After the profile-driven rehearsal steps run, copy these artifact paths and receipt operations into the closeout template before reloading closeout input."
  };
}

function buildStagingProfileLaunchPlan(options) {
  const profileLoaded = options.stagingProfile?.loaded === true;
  const requiredInputs = [
    "baseUrl",
    "productCode",
    "channel",
    "adminUsername",
    "developerUsername",
    "targetOs",
    "storageProfile",
    "targetEnvFile",
    "appBackupDir",
    ...(options.storageProfile === "postgres-preview" ? ["postgresBackupDir"] : [])
  ];
  const outputFiles = ["handoffFile", "closeoutFile", "runRecordFile", "artifactManifestFile", "closeoutReloadPacketFile", "readinessReviewPacketFile", "launchDutyArchiveIndexFile", "filledCloseoutDraftFile"];
  const missingRequiredInputs = requiredInputs.filter((key) => !options[key]);
  const missingOutputFiles = outputFiles.filter((key) => !options[key]);
  const requiredSecretEnv = [
    {
      key: ADMIN_PASSWORD_ENV,
      phase: "before_live_write_smoke",
      present: Boolean(options.adminPassword)
    },
    {
      key: DEVELOPER_PASSWORD_ENV,
      phase: "before_live_write_smoke",
      present: Boolean(options.developerPassword)
    },
    {
      key: DEVELOPER_BEARER_TOKEN_ENV,
      phase: "before_evidence_recording",
      present: Boolean(process.env[DEVELOPER_BEARER_TOKEN_ENV])
    }
  ];
  const status = !profileLoaded
    ? "profile_not_loaded"
    : missingRequiredInputs.length || missingOutputFiles.length
      ? "needs_profile_completion"
      : "ready_for_profile_driven_rehearsal";
  return {
    status,
    willModifyData: false,
    profileFile: options.stagingProfile?.file || null,
    profileProvidedKeys: options.stagingProfile?.providedKeys || [],
    cliOverrideKeys: options.profileCliOverrideKeys || [],
    requiredInputs,
    outputFiles,
    missingRequiredInputs,
    missingOutputFiles,
    requiredSecretEnv,
    recommendedCommand: buildProfileDrivenCommand(options),
    backfillManifest: buildProfileBackfillManifest(options),
    nextAction: profileLoaded
      ? "Set required secret env vars, run the recommended profile-driven rehearsal command, then review the generated handoff and closeout template before live writes."
      : "Create a secret-free staging profile from docs/staging-rehearsal-profile.example.json before the real staging rehearsal."
  };
}

function buildStagingProfileOperatorPreflight(result) {
  const plan = result.stagingProfileLaunchPlan || {};
  const binding = result.stagingEnvironmentBinding || {};
  const runbook = result.stagingExecutionRunbook || {};
  const requiredSecretEnv = Array.isArray(plan.requiredSecretEnv) ? plan.requiredSecretEnv : [];
  const missingSecretEnv = requiredSecretEnv
    .filter((item) => item && item.present !== true)
    .map((item) => item.key)
    .filter(Boolean);
  const missingRequiredInputs = Array.isArray(plan.missingRequiredInputs) ? plan.missingRequiredInputs : [];
  const missingOutputFiles = Array.isArray(plan.missingOutputFiles) ? plan.missingOutputFiles : [];
  const commandSequence = Array.isArray(runbook.commandSequence)
    ? runbook.commandSequence.map((item) => item.key).filter(Boolean)
    : [];
  const reloadStep = Array.isArray(runbook.commandSequence)
    ? runbook.commandSequence.find((item) => item.key === "reload_closeout_input")
    : null;
  const commands = {
    profileDrivenRehearsal: plan.recommendedCommand || null,
    stagingDryRun: binding.dryRunCommand || null,
    routeMapGate: result.nextCommands?.launchRouteMapGate?.command || null,
    liveWriteSmoke: result.nextCommands?.launchSmoke || null,
    closeoutReload: reloadStep?.command || result.closeoutBackfillGuide?.closeoutInputReload?.command || null
  };
  const profileLoaded = Boolean(plan.status) && plan.status !== "profile_not_loaded";
  const canRunDryRun = profileLoaded
    && missingRequiredInputs.length === 0
    && missingOutputFiles.length === 0
    && Boolean(commands.profileDrivenRehearsal)
    && Boolean(commands.stagingDryRun);
  const canRunLiveWriteSmoke = canRunDryRun
    && !missingSecretEnv.includes(ADMIN_PASSWORD_ENV)
    && !missingSecretEnv.includes(DEVELOPER_PASSWORD_ENV);
  const canRecordEvidence = canRunDryRun && !missingSecretEnv.includes(DEVELOPER_BEARER_TOKEN_ENV);
  let status = "ready_for_real_staging_rehearsal";
  if (!profileLoaded) {
    status = "profile_not_loaded";
  } else if (missingRequiredInputs.length || missingOutputFiles.length) {
    status = "missing_profile_inputs";
  } else if (missingSecretEnv.length) {
    status = "blocked_until_secret_env";
  }
  return {
    mode: "staging-profile-operator-preflight",
    status,
    willModifyData: false,
    profileStatus: plan.status || "unknown",
    profileFile: plan.profileFile || null,
    missingRequiredInputs,
    missingOutputFiles,
    requiredSecretEnv,
    missingSecretEnv,
    canRunDryRun,
    canRunLiveWriteSmoke,
    canRecordEvidence,
    recommendedFiles: binding.recommendedOutputFiles || [],
    commandSequence,
    commands,
    checks: [
      {
        key: "profile_file",
        status: profileLoaded ? "ready" : "missing",
        nextAction: profileLoaded
          ? "Keep the secret-free staging profile under versioned launch artifacts."
          : "Create a secret-free staging profile before running the real rehearsal."
      },
      {
        key: "required_inputs",
        status: missingRequiredInputs.length === 0 ? "ready" : "missing",
        missing: missingRequiredInputs,
        nextAction: missingRequiredInputs.length === 0
          ? "Required non-secret staging inputs are present."
          : "Fill missing non-secret profile inputs before generating handoff files."
      },
      {
        key: "output_files",
        status: missingOutputFiles.length === 0 ? "ready" : "missing",
        missing: missingOutputFiles,
        nextAction: missingOutputFiles.length === 0
          ? "Handoff and closeout output paths are available."
          : "Provide handoffFile, closeoutFile, runRecordFile, artifactManifestFile, closeoutReloadPacketFile, readinessReviewPacketFile, launchDutyArchiveIndexFile, and filledCloseoutDraftFile paths for launch duty artifacts."
      },
      {
        key: "secret_env",
        status: missingSecretEnv.length === 0 ? "ready" : "missing",
        missing: missingSecretEnv,
        nextAction: missingSecretEnv.length === 0
          ? "Required secret environment variables are present."
          : "Set missing secret environment variables before live-write smoke and evidence recording."
      },
      {
        key: "runbook_sequence",
        status: commandSequence.length ? "ready" : "missing",
        nextAction: commandSequence.length
          ? "Follow the generated command sequence without skipping the closeout reload."
          : "Generate the staging execution runbook before the real rehearsal."
      }
    ],
    nextAction: status === "ready_for_real_staging_rehearsal"
      ? "Run the staging dry run, route-map gate, recovery drill, live-write smoke, evidence recording, and closeout reload in the generated sequence."
      : status === "blocked_until_secret_env"
        ? "Set missing secret env vars, then run the profile-driven rehearsal sequence."
        : "Complete the staging profile and output paths before the real profile-driven rehearsal."
  };
}

function buildStagingRehearsalExecutionSummary(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const profilePreflight = result.stagingProfileOperatorPreflight || buildStagingProfileOperatorPreflight(result);
  const runbook = result.stagingExecutionRunbook || {};
  const readinessTransition = result.stagingReadinessTransition || {};
  const finalPacket = result.finalRehearsalPacket || {};
  const closeoutReview = runbook.closeoutInputReview
    || finalPacket.closeoutInputReview
    || summarizeCloseoutInputReview(result.closeoutInput?.backfillReview, closeout);
  const commandSequence = Array.isArray(runbook.commandSequence)
    ? runbook.commandSequence.map((item) => item.key).filter(Boolean)
    : [];
  const missingSecretEnv = Array.isArray(profilePreflight.missingSecretEnv) ? profilePreflight.missingSecretEnv : [];
  const orderedNextActions = [
    ...(missingSecretEnv.length ? ["set_missing_secret_env"] : []),
    ...commandSequence
  ];
  const sourceStatuses = {
    profilePreflight: profilePreflight.status || "not_available",
    executionRunbook: runbook.status || "not_available",
    closeoutReview: closeoutReview.status || "not_loaded",
    readinessTransition: readinessTransition.status || "not_available",
    finalPacket: finalPacket.status || "not_available"
  };
  let status = sourceStatuses.readinessTransition || "not_available";
  if (sourceStatuses.readinessTransition === "ready_for_launch_day_watch") {
    status = "ready_for_launch_day_watch";
  } else if (sourceStatuses.readinessTransition === "ready_for_full_test_window") {
    status = "ready_for_full_test_window";
  } else if (sourceStatuses.profilePreflight === "profile_not_loaded" && sourceStatuses.closeoutReview === "not_loaded") {
    status = "profile_not_loaded";
  } else if (missingSecretEnv.length) {
    status = "blocked_until_secret_env";
  } else if (closeoutReview.safeToEnterFullTestWindow !== true) {
    status = "blocked_until_closeout_reload";
  }
  const blockingReasons = [];
  if (status === "ready_for_full_test_window") {
    blockingReasons.push({
      key: "production_signoff_pending",
      status: "blocked",
      nextAction: "Run the full test window, attach sign-off evidence, then reload closeout input for production sign-off."
    });
  } else if (status !== "ready_for_launch_day_watch") {
    if (sourceStatuses.profilePreflight === "profile_not_loaded") {
      blockingReasons.push({
        key: "profile_not_loaded",
        status: "blocked",
        nextAction: "Load a secret-free staging profile before the real rehearsal."
      });
    }
    if (missingSecretEnv.length) {
      blockingReasons.push({
        key: "missing_secret_env",
        status: "blocked",
        missing: missingSecretEnv,
        nextAction: "Set the missing secret environment variables before evidence recording."
      });
    }
    if (closeoutReview.safeToEnterFullTestWindow !== true) {
      blockingReasons.push({
        key: "closeout_input",
        status: closeoutReview.status || "not_loaded",
        missingFieldCount: closeoutReview.missingFieldCount ?? 0,
        placeholderKeys: closeoutReview.placeholderKeys || [],
        nextAction: "Backfill and reload the filled closeout input before the full test window."
      });
    }
    if (!["ready_for_full_test_window", "ready_for_launch_day_watch"].includes(sourceStatuses.readinessTransition)) {
      blockingReasons.push({
        key: "readiness_transition",
        status: sourceStatuses.readinessTransition,
        nextAction: readinessTransition.nextAction || "Complete the generated staging runbook and closeout reload."
      });
    }
  }
  return {
    mode: "staging-rehearsal-execution-summary",
    status,
    willModifyData: false,
    sourceStatuses,
    operatorFocus: {
      missingSecretEnv,
      closeoutPlaceholderKeys: closeoutReview.placeholderKeys || [],
      closeoutMissingFieldCount: closeoutReview.missingFieldCount ?? 0,
      canRunDryRun: profilePreflight.canRunDryRun === true,
      canRunLiveWriteSmoke: profilePreflight.canRunLiveWriteSmoke === true,
      canRecordEvidence: profilePreflight.canRecordEvidence === true,
      canEnterFullTestWindow: closeoutReview.safeToEnterFullTestWindow === true
    },
    blockingReasons,
    orderedNextActions,
    commands: {
      profileDrivenRehearsal: profilePreflight.commands?.profileDrivenRehearsal || null,
      stagingDryRun: profilePreflight.commands?.stagingDryRun || null,
      routeMapGate: profilePreflight.commands?.routeMapGate || null,
      liveWriteSmoke: profilePreflight.commands?.liveWriteSmoke || null,
      closeoutReload: profilePreflight.commands?.closeoutReload || null,
      fullTestWindow: result.fullTestWindowReadiness?.command || closeout.fullTestWindowEntry?.command || "npm.cmd test"
    },
    nextAction: blockingReasons[0]?.nextAction || "Start launch-day watch and stabilization handoff from the final rehearsal packet."
  };
}

function buildStagingRehearsalRunRecordIndex(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const runTemplate = result.stagingRunRecordTemplate || buildStagingRunRecordTemplate(result);
  const executionSummary = result.stagingRehearsalExecutionSummary || buildStagingRehearsalExecutionSummary(result);
  const finalPacket = result.finalRehearsalPacket || {};
  const closeoutInput = result.closeoutInput || null;
  const archiveRoot = runTemplate.archiveRoot || finalPacket.archiveRoot || "artifacts/staging/product/stable";
  const packetFileByKey = new Map((finalPacket.localFiles || []).map((item) => [item.key, item]));
  const closeoutInputPath = packetFileByKey.get("filled_closeout_input")?.path
    || path.posix.join(archiveRoot, "filled-closeout-input.json");
  const requiredRecordKeys = (closeout.acceptanceChecks || []).map((item) => item.key).filter(Boolean);
  const filledRecordKeys = Array.isArray(closeoutInput?.filledKeys) ? closeoutInput.filledKeys : [];
  const missingRecordKeys = Array.isArray(closeoutInput?.missingKeys)
    ? closeoutInput.missingKeys
    : requiredRecordKeys.filter((key) => !filledRecordKeys.includes(key));
  const requiredSignoffKeys = (closeout.productionSignoffConditions?.conditions || [])
    .map((item) => item.key)
    .filter(Boolean);
  const filledSignoffKeys = Array.isArray(closeoutInput?.signoffFilledKeys) ? closeoutInput.signoffFilledKeys : [];
  const missingSignoffKeys = Array.isArray(closeoutInput?.signoffMissingKeys)
    ? closeoutInput.signoffMissingKeys
    : requiredSignoffKeys.filter((key) => !filledSignoffKeys.includes(key));
  const missingReceiptVisibilityKeys = Array.isArray(closeoutInput?.missingReceiptVisibilityKeys)
    ? closeoutInput.missingReceiptVisibilityKeys
    : RECEIPT_VISIBILITY_KEYS;
  const watchAndStabilizationKeys = [
    ...new Set([
      ...(result.launchDayWatchPlan?.requiredEvidenceKeys || []),
      ...(result.stabilizationHandoffPlan?.requiredEvidenceKeys || [])
    ])
  ];
  const recordsByKey = new Map((runTemplate.records || []).map((item) => [item.key, item]));
  const summarizeRecords = (keys) => keys.map((key) => {
    const record = recordsByKey.get(key) || {};
    return {
      key,
      sourcePlan: record.sourcePlan || null,
      artifactPath: record.artifactPath || null,
      receiptOperations: record.receiptOperations || []
    };
  });
  const preFullTestStatus = missingRecordKeys.length === 0 && closeoutInput?.readyForFullTestWindow === true
    ? "ready_for_full_test_window"
    : "awaiting_operator_evidence";
  const productionSignoffStatus = closeoutInput?.readyForProductionSignoff === true
    ? "ready_for_production_signoff"
    : "blocked_until_full_test_window";
  const launchDayStatus = closeoutInput?.readyForProductionSignoff === true
    && result.stagingReadinessTransition?.status === "ready_for_launch_day_watch"
    ? "ready_for_launch_day_watch"
    : "blocked_until_production_signoff";
  let status = "awaiting_evidence_backfill";
  if (launchDayStatus === "ready_for_launch_day_watch") {
    status = "ready_for_launch_day_watch";
  } else if (preFullTestStatus === "ready_for_full_test_window") {
    status = "ready_for_full_test_window";
  }
  const orderedOperatorMilestones = [
    "generate_rehearsal_outputs",
    "collect_pre_full_test_records",
    "backfill_filled_closeout_input",
    "reload_closeout_input",
    "run_full_test_window",
    "backfill_production_signoff",
    "production_signoff_review",
    "start_launch_day_watch",
    "prepare_stabilization_handoff"
  ];
  const nextAction = status === "ready_for_launch_day_watch"
    ? "Start launch-day watch, then hand off stabilization records and rollback signal review."
    : status === "ready_for_full_test_window"
      ? "Run the full test window, backfill production sign-off evidence, then reload closeout input."
      : "Collect the missing pre-full-test record artifacts, backfill filled-closeout-input.json, then reload closeout input.";
  return {
    mode: "staging-rehearsal-run-record-index",
    status,
    willModifyData: false,
    archiveRoot,
    sourceStatuses: {
      runRecordTemplate: runTemplate.status || "not_available",
      executionSummary: executionSummary.status || "not_available",
      finalPacket: finalPacket.status || "not_available",
      closeoutInput: closeoutInput?.status || "not_loaded"
    },
    recordCount: Array.isArray(runTemplate.records) ? runTemplate.records.length : 0,
    closeoutProgress: {
      requiredRecordKeys,
      filledRecordKeys,
      missingRecordKeys,
      missingRecordCount: missingRecordKeys.length,
      closeoutInputPath,
      reloadCommand: finalPacket.commands?.closeoutReload
        || runTemplate.closeoutInputReloadCommand
        || "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>"
    },
    signoffProgress: {
      requiredSignoffKeys,
      filledSignoffKeys,
      missingSignoffKeys,
      missingReceiptVisibilityKeys,
      productionDecision: closeoutInput?.productionDecision || null,
      requiredDecision: closeout.productionSignoffConditions?.requiredDecision || null
    },
    recordGroups: [
      {
        key: "pre_full_test_closeout",
        status: preFullTestStatus,
        recordCount: requiredRecordKeys.length,
        missingRecordKeys,
        records: summarizeRecords(requiredRecordKeys)
      },
      {
        key: "production_signoff",
        status: productionSignoffStatus,
        recordCount: requiredSignoffKeys.length,
        missingSignoffKeys,
        missingReceiptVisibilityKeys,
        records: requiredSignoffKeys.map((key) => ({ key }))
      },
      {
        key: "launch_day_watch_and_stabilization",
        status: launchDayStatus,
        recordCount: watchAndStabilizationKeys.length,
        records: summarizeRecords(watchAndStabilizationKeys)
      }
    ],
    orderedOperatorMilestones,
    nextAction
  };
}

function buildStagingArtifactManifest(result) {
  const binding = result.stagingEnvironmentBinding || {};
  const executionSummary = result.stagingRehearsalExecutionSummary || buildStagingRehearsalExecutionSummary(result);
  const runRecordIndex = result.stagingRehearsalRunRecordIndex || buildStagingRehearsalRunRecordIndex(result);
  const finalPacket = result.finalRehearsalPacket || buildFinalRehearsalPacket(result);
  const files = Array.isArray(binding.recommendedOutputFiles)
    ? binding.recommendedOutputFiles.map((item) => ({
      key: item.key,
      path: item.path || null,
      status: item.status || "not_available"
    }))
    : [];
  const archiveRoot = files.find((item) => item.key === "artifact_archive_root")?.path
    || runRecordIndex.archiveRoot
    || finalPacket.archiveRoot
    || "artifacts/staging/product/stable";
  return {
    mode: "staging-artifact-manifest",
    status: "awaiting_artifact_generation",
    willModifyData: false,
    archiveRoot,
    files,
    sourceStatuses: {
      profilePreflight: result.stagingProfileOperatorPreflight?.status || "not_available",
      executionSummary: executionSummary.status || "not_available",
      runRecordIndex: runRecordIndex.status || "not_available",
      finalPacket: finalPacket.status || "not_available"
    },
    commands: {
      stagingDryRun: binding.dryRunCommand || null,
      routeMapGate: executionSummary.commands?.routeMapGate || finalPacket.commands?.routeMapGate || null,
      liveWriteSmoke: executionSummary.commands?.liveWriteSmoke || finalPacket.commands?.liveWriteSmoke || null,
      closeoutReload: finalPacket.commands?.closeoutReload
        || runRecordIndex.closeoutProgress?.reloadCommand
        || null
    },
    nextAction: "Generate and archive the listed rehearsal artifacts, then fill closeout evidence from the draft before reloading closeout input."
  };
}

function buildStagingCloseoutReloadPacket(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const bindingFiles = new Map((result.stagingEnvironmentBinding?.recommendedOutputFiles || []).map((item) => [item.key, item]));
  const runRecordIndex = result.stagingRehearsalRunRecordIndex || buildStagingRehearsalRunRecordIndex(result);
  const artifactManifest = result.stagingArtifactManifest || buildStagingArtifactManifest(result);
  const finalPacket = result.finalRehearsalPacket || buildFinalRehearsalPacket(result);
  const closeoutReview = result.stagingExecutionRunbook?.closeoutInputReview
    || finalPacket.closeoutInputReview
    || summarizeCloseoutInputReview(result.closeoutInput?.backfillReview, closeout);
  const archiveRoot = artifactManifest.archiveRoot
    || runRecordIndex.archiveRoot
    || finalPacket.archiveRoot
    || "artifacts/staging/product/stable";
  const filledCloseoutInputFile = bindingFiles.get("filled_closeout_input")?.path
    || runRecordIndex.closeoutProgress?.closeoutInputPath
    || path.posix.join(archiveRoot, "filled-closeout-input.json");
  const filledCloseoutDraftFile = result.filledCloseoutDraftFile?.path
    || bindingFiles.get("filled_closeout_draft")?.path
    || result.filledCloseoutInputDraft?.saveAs
    || path.posix.join(archiveRoot, "filled-closeout-input.draft.json");
  const closeoutTemplateFile = result.closeoutFile?.path
    || bindingFiles.get("closeout_file")?.path
    || path.posix.join(archiveRoot, "staging-closeout-template.json");
  const packetFile = result.closeoutReloadPacketFile?.path
    || bindingFiles.get("closeout_reload_packet")?.path
    || path.posix.join(archiveRoot, "staging-closeout-reload-packet.json");
  const requiredCloseoutKeys = (closeout.acceptanceChecks || []).map((item) => item.key).filter(Boolean);
  const missingCloseoutKeys = Array.isArray(result.closeoutInput?.missingKeys)
    ? result.closeoutInput.missingKeys
    : requiredCloseoutKeys;
  const closeoutReload = finalPacket.commands?.closeoutReload
    || runRecordIndex.closeoutProgress?.reloadCommand
    || result.filledCloseoutInputDraft?.reloadCommand
    || `npm.cmd run staging:rehearsal -- --closeout-input-file ${filledCloseoutInputFile}`;
  let status = "awaiting_closeout_backfill";
  if (result.closeoutInput?.readyForFullTestWindow === true) {
    status = "ready_for_full_test_window";
  } else if (result.closeoutInput) {
    status = "reload_needs_backfill";
  }
  return {
    mode: "staging-closeout-reload-packet",
    status,
    willModifyData: false,
    archiveRoot,
    paths: {
      packetFile,
      filledCloseoutDraftFile,
      filledCloseoutInputFile,
      closeoutTemplateFile
    },
    sourceStatuses: {
      closeoutInput: result.closeoutInput?.status || "not_loaded",
      closeoutReview: closeoutReview.status || "not_loaded",
      readinessTransition: result.stagingReadinessTransition?.status || "not_available",
      finalPacket: finalPacket.status || "not_available",
      artifactManifest: artifactManifest.status || "not_available"
    },
    requiredCloseoutKeys,
    missingCloseoutKeys,
    closeoutReview,
    commands: {
      closeoutReload,
      fullTestWindow: finalPacket.commands?.fullTestWindow || closeout.fullTestWindowEntry?.command || "npm.cmd test"
    },
    operatorSteps: [
      {
        key: "promote_filled_closeout_draft",
        status: "operator_copy",
        from: filledCloseoutDraftFile,
        to: filledCloseoutInputFile
      },
      {
        key: "backfill_required_evidence",
        status: missingCloseoutKeys.length ? "operator_backfill" : "ready",
        missingCloseoutKeys
      },
      {
        key: "remove_example_only_guard",
        status: "operator_confirm",
        expected: "exampleOnly must be absent or false before reload."
      },
      {
        key: "reload_closeout_input",
        status: "operator_execute",
        command: closeoutReload
      },
      {
        key: "review_full_test_window_readiness",
        status: result.closeoutInput?.readyForFullTestWindow === true ? "ready" : "blocked",
        command: finalPacket.commands?.fullTestWindow || closeout.fullTestWindowEntry?.command || "npm.cmd test"
      }
    ],
    nextAction: result.closeoutInput?.readyForFullTestWindow === true
      ? "Run npm.cmd test in the reserved full test window, then attach production sign-off evidence."
      : "Backfill the real filled closeout input, reload it, then review full-test-window readiness before running npm.cmd test."
  };
}

function buildStagingReadinessReviewPacket(result) {
  const closeoutReloadPacket = result.stagingCloseoutReloadPacket || buildStagingCloseoutReloadPacket(result);
  const finalPacket = result.finalRehearsalPacket || buildFinalRehearsalPacket(result);
  const fullTestWindow = result.fullTestWindowReadiness || buildFullTestWindowReadiness(result);
  const productionSignoff = result.productionSignoffReadiness || buildProductionSignoffReadiness(result);
  const launchDayWatch = result.launchDayWatchPlan || buildLaunchDayWatchPlan(result);
  const stabilizationHandoff = result.stabilizationHandoffPlan || buildStabilizationHandoffPlan(result);
  const bindingFiles = new Map((result.stagingEnvironmentBinding?.recommendedOutputFiles || []).map((item) => [item.key, item]));
  const archiveRoot = closeoutReloadPacket.archiveRoot || finalPacket.archiveRoot || "artifacts/staging/product/stable";
  const packetFile = result.readinessReviewPacketFile?.path
    || bindingFiles.get("readiness_review_packet")?.path
    || path.posix.join(archiveRoot, "staging-readiness-review-packet.json");
  let status = "blocked_until_closeout_reload";
  if (stabilizationHandoff.canStartStabilizationHandoff === true) {
    status = "ready_for_stabilization_handoff";
  } else if (launchDayWatch.canStartCutoverWatch === true) {
    status = "ready_for_launch_day_watch";
  } else if (productionSignoff.canSignoff === true) {
    status = "ready_for_production_signoff";
  } else if (fullTestWindow.canRun === true) {
    status = "ready_for_full_test_window";
  } else if (closeoutReloadPacket.status === "reload_needs_backfill") {
    status = "reload_needs_backfill";
  }
  return {
    mode: "staging-readiness-review-packet",
    status,
    willModifyData: false,
    archiveRoot,
    packetFile,
    sourceStatuses: {
      closeoutReloadPacket: closeoutReloadPacket.status || "not_available",
      fullTestWindow: fullTestWindow.status || "not_available",
      productionSignoff: productionSignoff.status || "not_available",
      launchDayWatch: launchDayWatch.status || "not_available",
      stabilizationHandoff: stabilizationHandoff.status || "not_available",
      finalPacket: finalPacket.status || "not_available"
    },
    gates: [
      {
        key: "full_test_window",
        status: fullTestWindow.status || "blocked",
        canProceed: fullTestWindow.canRun === true,
        command: fullTestWindow.command || "npm.cmd test",
        closeoutInputStatus: fullTestWindow.closeoutInputStatus || "missing",
        missingCloseoutKeys: fullTestWindow.missingCloseoutKeys || [],
        nextAction: fullTestWindow.nextAction || null
      },
      {
        key: "production_signoff",
        status: productionSignoff.status || "blocked",
        canProceed: productionSignoff.canSignoff === true,
        requiredDecision: productionSignoff.requiredDecision || "ready-for-production-signoff",
        productionDecision: productionSignoff.productionDecision || null,
        missingSignoffKeys: productionSignoff.missingSignoffKeys || [],
        missingReceiptVisibilityKeys: productionSignoff.missingReceiptVisibilityKeys || [],
        nextAction: productionSignoff.nextAction || null
      },
      {
        key: "launch_day_watch",
        status: launchDayWatch.status || "blocked",
        canProceed: launchDayWatch.canStartCutoverWatch === true,
        requiredDecision: launchDayWatch.requiredDecision || "ready-for-production-signoff",
        missingSignoffKeys: launchDayWatch.missingSignoffKeys || [],
        missingReceiptVisibilityKeys: launchDayWatch.missingReceiptVisibilityKeys || [],
        nextAction: launchDayWatch.nextAction || null
      },
      {
        key: "stabilization_handoff",
        status: stabilizationHandoff.status || "blocked",
        canProceed: stabilizationHandoff.canStartStabilizationHandoff === true,
        requiredEvidenceKeys: stabilizationHandoff.requiredEvidenceKeys || [],
        nextAction: stabilizationHandoff.nextAction || null
      }
    ],
    commands: {
      closeoutReload: closeoutReloadPacket.commands?.closeoutReload || finalPacket.commands?.closeoutReload || null,
      fullTestWindow: fullTestWindow.command || finalPacket.commands?.fullTestWindow || "npm.cmd test"
    },
    nextAction: status === "ready_for_stabilization_handoff"
      ? "Start stabilization handoff from the launch-day watch and receipt visibility records."
      : status === "ready_for_launch_day_watch"
        ? "Start launch-day watch, then prepare stabilization handoff records."
        : status === "ready_for_production_signoff"
          ? "Review production sign-off, then enter launch-day watch if approved."
          : status === "ready_for_full_test_window"
            ? "Run npm.cmd test in the reserved full test window, then backfill production sign-off evidence."
            : "Reload filled closeout input, then use this packet to decide whether the full test window can start."
  };
}

function buildStagingProductionSignoffPacket(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const bindingFiles = new Map((result.stagingEnvironmentBinding?.recommendedOutputFiles || []).map((item) => [item.key, item]));
  const fullTestWindow = result.fullTestWindowReadiness || buildFullTestWindowReadiness(result);
  const productionSignoff = result.productionSignoffReadiness || buildProductionSignoffReadiness(result);
  const readinessReviewPacket = result.stagingReadinessReviewPacket || buildStagingReadinessReviewPacket(result);
  const runRecordIndex = result.stagingRehearsalRunRecordIndex || buildStagingRehearsalRunRecordIndex(result);
  const launchDayWatch = result.launchDayWatchPlan || buildLaunchDayWatchPlan(result);
  const archiveRoot = readinessReviewPacket.archiveRoot
    || runRecordIndex.archiveRoot
    || result.finalRehearsalPacket?.archiveRoot
    || "artifacts/staging/product/stable";
  const packetFile = result.productionSignoffPacketFile?.path
    || bindingFiles.get("production_signoff_packet")?.path
    || path.posix.join(archiveRoot, "staging-production-signoff-packet.json");
  const closeoutInputPath = bindingFiles.get("filled_closeout_input")?.path
    || runRecordIndex.closeoutProgress?.closeoutInputPath
    || path.posix.join(archiveRoot, "filled-closeout-input.json");
  const closeoutReload = readinessReviewPacket.commands?.closeoutReload
    || runRecordIndex.closeoutProgress?.reloadCommand
    || productionSignoff.reloadCommand
    || `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputPath}`;
  const canRunFullTestWindow = fullTestWindow.canRun === true;
  const canSignoff = productionSignoff.canSignoff === true;
  let status = "blocked_until_closeout_reload";
  if (canSignoff) {
    status = "ready_for_launch_day_watch";
  } else if (canRunFullTestWindow) {
    status = "ready_for_full_test_window";
  } else if (result.closeoutInput?.status === "loaded") {
    status = "blocked_until_signoff_backfill";
  }
  const missingSignoffKeys = productionSignoff.missingSignoffKeys || [];
  const missingReceiptVisibilityKeys = productionSignoff.missingReceiptVisibilityKeys || [];
  const requiredSignoffKeys = (closeout.productionSignoffConditions?.conditions || [])
    .map((item) => item.key)
    .filter(Boolean);
  const signoffConditions = (closeout.productionSignoffConditions?.conditions || []).map((item) => ({
    key: item.key,
    status: canSignoff ? "filled" : missingSignoffKeys.includes(item.key) ? "missing" : "filled",
    evidence: item.evidence || null
  }));
  return {
    mode: "staging-production-signoff-operator-packet",
    status,
    willModifyData: false,
    archiveRoot,
    packetFile,
    closeoutInputPath,
    sourceStatuses: {
      fullTestWindow: fullTestWindow.status || "not_available",
      productionSignoff: productionSignoff.status || "not_available",
      readinessReviewPacket: readinessReviewPacket.status || "not_available",
      runRecordIndex: runRecordIndex.status || "not_available",
      launchDayWatch: launchDayWatch.status || "not_available"
    },
    decision: {
      requiredDecision: productionSignoff.requiredDecision || "ready-for-production-signoff",
      productionDecision: productionSignoff.productionDecision || null,
      canSignoff,
      readyForFullTestWindow: productionSignoff.readyForFullTestWindow === true,
      closeoutInputStatus: productionSignoff.closeoutInputStatus || "missing"
    },
    requiredSignoffKeys,
    requiredReceiptVisibilityKeys: RECEIPT_VISIBILITY_KEYS,
    missingSignoffKeys,
    missingReceiptVisibilityKeys,
    signoffConditions,
    routes: {
      launchMainline: launchDayWatch.routes?.launchMainline || result.nextCommands?.launchMainline || null,
      developerOps: launchDayWatch.routes?.developerOps || result.resultBackfillSummary?.destinations?.developerOps || null,
      launchReviewSummary: launchDayWatch.routes?.launchReviewSummary || result.nextCommands?.receiptVisibilitySummaries?.launchReviewSummary || null,
      launchSmokeSummary: launchDayWatch.routes?.launchSmokeSummary || result.nextCommands?.receiptVisibilitySummaries?.launchSmokeSummary || null
    },
    commands: {
      closeoutReload,
      fullTestWindow: fullTestWindow.command || readinessReviewPacket.commands?.fullTestWindow || "npm.cmd test"
    },
    operatorSteps: [
      {
        key: "run_full_test_window",
        status: canSignoff ? "complete" : canRunFullTestWindow ? "operator_execute" : "blocked_until_closeout_reload",
        command: fullTestWindow.command || "npm.cmd test"
      },
      {
        key: "backfill_production_signoff",
        status: canSignoff ? "complete" : canRunFullTestWindow ? "operator_backfill" : "blocked_until_full_test_window",
        requiredSignoffKeys,
        missingSignoffKeys
      },
      {
        key: "verify_receipt_visibility",
        status: canSignoff && missingReceiptVisibilityKeys.length === 0 ? "complete" : "operator_backfill",
        requiredReceiptVisibilityKeys: RECEIPT_VISIBILITY_KEYS,
        missingReceiptVisibilityKeys
      },
      {
        key: "reload_closeout_input",
        status: "operator_execute",
        command: closeoutReload
      },
      {
        key: "archive_production_signoff",
        status: canSignoff ? "ready" : "blocked_until_signoff_ready",
        packetFile
      },
      {
        key: "start_launch_day_watch",
        status: launchDayWatch.canStartCutoverWatch === true ? "ready" : "blocked_until_signoff_ready",
        routes: launchDayWatch.routes || {}
      }
    ],
    nextAction: canSignoff
      ? "Archive production sign-off packet, then start launch-day watch and stabilization handoff."
      : canRunFullTestWindow
        ? "Run the full test window, backfill production sign-off conditions, reload closeout input, and re-check this packet."
        : "Reload closeout input, run the full test window when ready, then backfill production sign-off evidence and receipt visibility."
  };
}

function buildStagingLaunchDutyArchiveIndex(result) {
  const bindingFiles = new Map((result.stagingEnvironmentBinding?.recommendedOutputFiles || []).map((item) => [item.key, item]));
  const runRecordIndex = result.stagingRehearsalRunRecordIndex || buildStagingRehearsalRunRecordIndex(result);
  const artifactManifest = result.stagingArtifactManifest || buildStagingArtifactManifest(result);
  const closeoutReloadPacket = result.stagingCloseoutReloadPacket || buildStagingCloseoutReloadPacket(result);
  const readinessReviewPacket = result.stagingReadinessReviewPacket || buildStagingReadinessReviewPacket(result);
  const productionSignoffPacket = result.stagingProductionSignoffPacket || buildStagingProductionSignoffPacket(result);
  const finalPacket = result.finalRehearsalPacket || buildFinalRehearsalPacket(result);
  const archiveRoot = readinessReviewPacket.archiveRoot
    || closeoutReloadPacket.archiveRoot
    || artifactManifest.archiveRoot
    || runRecordIndex.archiveRoot
    || finalPacket.archiveRoot
    || "artifacts/staging/product/stable";
  const indexFile = result.launchDutyArchiveIndexFile?.path
    || bindingFiles.get("launch_duty_archive_index")?.path
    || path.posix.join(archiveRoot, "staging-launch-duty-archive-index.json");
  const packetPath = (key, fallback) => bindingFiles.get(key)?.path || fallback || null;
  return {
    mode: "staging-launch-duty-archive-index",
    status: "awaiting_archive_review",
    willModifyData: false,
    archiveRoot,
    indexFile,
    sourceStatuses: {
      runRecordIndex: runRecordIndex.status || "not_available",
      artifactManifest: artifactManifest.status || "not_available",
      closeoutReloadPacket: closeoutReloadPacket.status || "not_available",
      readinessReviewPacket: readinessReviewPacket.status || "not_available",
      productionSignoffPacket: productionSignoffPacket.status || "not_available",
      finalPacket: finalPacket.status || "not_available"
    },
    packets: [
      {
        key: "run_record_index",
        status: runRecordIndex.status || "not_available",
        path: packetPath("run_record_index", result.runRecordFile?.path)
      },
      {
        key: "artifact_manifest",
        status: artifactManifest.status || "not_available",
        path: packetPath("artifact_manifest", result.artifactManifestFile?.path)
      },
      {
        key: "closeout_reload_packet",
        status: closeoutReloadPacket.status || "not_available",
        path: packetPath("closeout_reload_packet", closeoutReloadPacket.paths?.packetFile)
      },
      {
        key: "readiness_review_packet",
        status: readinessReviewPacket.status || "not_available",
        path: packetPath("readiness_review_packet", readinessReviewPacket.packetFile)
      },
      {
        key: "production_signoff_packet",
        status: productionSignoffPacket.status || "not_available",
        path: packetPath("production_signoff_packet", productionSignoffPacket.packetFile)
      }
    ],
    commands: {
      stagingDryRun: result.stagingEnvironmentBinding?.dryRunCommand || null,
      closeoutReload: readinessReviewPacket.commands?.closeoutReload || closeoutReloadPacket.commands?.closeoutReload || null,
      fullTestWindow: readinessReviewPacket.commands?.fullTestWindow || finalPacket.commands?.fullTestWindow || "npm.cmd test"
    },
    nextAction: "Archive the listed launch-duty packets, then use readiness review to decide whether the full test window can start."
  };
}

function runJsonScript(scriptName, args) {
  const result = spawnSync(process.execPath, [path.join("scripts", scriptName), "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000
  });

  const stdout = result.stdout || "";
  let payload = null;
  try {
    payload = stdout ? JSON.parse(stdout) : null;
  } catch {
    payload = {
      status: "fail",
      error: {
        message: `Could not parse JSON from ${scriptName}: ${stdout.slice(0, 200)}`
      }
    };
  }

  if (result.status !== 0 && payload?.status !== "fail") {
    payload = {
      status: "fail",
      error: {
        message: result.stderr || `${scriptName} exited with ${result.status}`
      }
    };
  }

  return payload;
}

function buildStagingPreflightArgs(options) {
  return [
    "--base-url", options.baseUrl,
    "--product-code", options.productCode,
    "--channel", options.channel,
    "--admin-username", options.adminUsername,
    "--admin-password", options.adminPassword,
    "--developer-username", options.developerUsername,
    "--developer-password", options.developerPassword
  ];
}

function buildRecoveryPreflightArgs(options) {
  const args = [
    "--target-os", options.targetOs,
    "--storage-profile", options.storageProfile,
    "--target-env-file", options.targetEnvFile,
    "--app-backup-dir", options.appBackupDir,
    "--base-url", options.baseUrl
  ];
  if (options.postgresBackupDir) {
    args.push("--postgres-backup-dir", options.postgresBackupDir);
  }
  return args;
}

function buildRoute(baseUrl, pathname, params) {
  const url = new URL(pathname, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== "") {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function buildPhases(status) {
  return [
    {
      key: "staging_command_preflight",
      status: status.staging
    },
    {
      key: "recovery_command_preflight",
      status: status.recovery
    },
    {
      key: "run_staging_launch_smoke",
      status: status.liveSmoke
    },
    {
      key: "open_launch_mainline",
      status: status.launchMainline
    },
    {
      key: "record_mainline_evidence",
      status: status.evidence
    }
  ];
}

function firstFailedPhase(phases) {
  return phases.find((phase) => phase.status === "blocked" || phase.status === "fail") || null;
}

function quotePowerShellSingleQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildEvidenceRequest(endpoint, payload) {
  return {
    method: "POST",
    url: endpoint,
    contentType: "application/json",
    bearerTokenEnv: DEVELOPER_BEARER_TOKEN_ENV,
    powershell: [
      `$headers = @{ Authorization = "Bearer $env:${DEVELOPER_BEARER_TOKEN_ENV}" }`,
      "$body = @'",
      JSON.stringify(payload, null, 2),
      "'@",
      `Invoke-RestMethod -Method Post -Uri ${quotePowerShellSingleQuoted(endpoint)} -Headers $headers -ContentType 'application/json' -Body $body`
    ].join("\n")
  };
}

function buildEvidenceActionPlan(options) {
  const endpoint = buildRoute(options.baseUrl, "/api/developer/launch-mainline/action", {});
  return {
    endpoint,
    method: "POST",
    willModifyData: true,
    auth: "developer bearer token",
    items: EVIDENCE_ACTIONS.map(([label, operation], index) => {
      const payload = {
        productCode: options.productCode,
        channel: options.channel,
        operation
      };
      return {
        key: operation,
        label,
        operation,
        order: index + 1,
        payload,
        expectedReceiptOperation: operation,
        request: buildEvidenceRequest(endpoint, payload)
      };
    })
  };
}

function buildEvidenceReadiness(options, actionPlan) {
  const developerBearerToken = process.env[DEVELOPER_BEARER_TOKEN_ENV] || "";
  const targetLaneReady = Boolean(options.productCode && options.channel);
  const endpointReady = Boolean(actionPlan?.endpoint);
  const tokenReady = developerBearerToken.trim() !== "";
  const readyToExecute = targetLaneReady && endpointReady && tokenReady;

  return {
    status: readyToExecute ? "ready" : "needs_operator_input",
    readyToExecute,
    checks: {
      targetLane: targetLaneReady ? "pass" : "missing",
      evidenceEndpoint: endpointReady ? "pass" : "missing",
      developerBearerToken: tokenReady ? "present" : "missing"
    },
    tokenEnv: DEVELOPER_BEARER_TOKEN_ENV,
    targetLane: {
      productCode: options.productCode,
      channel: options.channel
    },
    endpoint: actionPlan?.endpoint || null,
    nextAction: readyToExecute
      ? "Copy evidence request snippets only after the matching launch evidence has actually happened."
      : `Set $env:${DEVELOPER_BEARER_TOKEN_ENV} before copying evidence request snippets.`
  };
}

function buildReceiptVisibilitySummaryDownloads(options) {
  return {
    launchReviewSummary: buildRoute(options.baseUrl, "/api/developer/launch-review/download", {
      productCode: options.productCode,
      channel: options.channel,
      source: "launch-smoke",
      handoff: "first-wave",
      format: "summary"
    }),
    launchSmokeSummary: buildRoute(options.baseUrl, "/api/developer/launch-smoke-kit/download", {
      productCode: options.productCode,
      channel: options.channel,
      operation: "record_post_launch_ops_sweep",
      downloadKey: "launch_smoke_summary",
      format: "summary"
    })
  };
}

function buildLaunchRouteMapGateCommand() {
  return {
    command: "npm.cmd run launch:route-map-gate",
    dryRunCommand: "npm.cmd run launch:route-map-gate -- --dry-run --json",
    willModifyData: false,
    willRunFullSuite: false,
    purpose: "Re-run the Launch Mainline / Launch Smoke / Developer Ops route-map visibility and low-frequency download surface targeted gate before live-write staging smoke."
  };
}

function buildStagingEnvironmentReadiness(options, { recovery = null, launchRouteMapGate = null } = {}) {
  const recoveryCommandKeys = Object.keys(recovery?.nextCommands || {});
  return {
    status: "needs_operator_execution",
    willModifyData: false,
    nextAction: "Complete the operator_confirm and operator_execute items before running the live-write staging smoke command.",
    checks: [
      {
        key: "public_https_entrypoint",
        label: "Public HTTPS entrypoint",
        status: String(options.baseUrl || "").startsWith("https://") ? "pass" : "fail",
        evidence: `Base URL: ${options.baseUrl || "-"}`,
        nextAction: "Keep staging smoke pointed at the public HTTPS endpoint."
      },
      {
        key: "non_default_secrets",
        label: "Non-default secrets",
        status: "operator_confirm",
        evidence: "Smoke commands reference password environment variables and do not print secret values.",
        nextAction: "Confirm the deployed server token secret, admin password, and smoke developer credentials are non-default before live-write smoke."
      },
      {
        key: "persistent_storage",
        label: "Persistent storage",
        status: "operator_confirm",
        evidence: [
          `Storage profile: ${options.storageProfile || "-"}`,
          `Env file: ${options.targetEnvFile || "-"}`,
          `App backup dir: ${options.appBackupDir || "-"}`,
          `Postgres backup dir: ${options.postgresBackupDir || "-"}`
        ].join(" | "),
        nextAction: "Confirm the target uses the intended persistent storage profile and backup directories before writing smoke data."
      },
      {
        key: "backup_restore_drill",
        label: "Backup and restore drill",
        status: "operator_execute",
        evidence: recoveryCommandKeys.length
          ? `Recovery command keys: ${recoveryCommandKeys.join(", ")}`
          : "Recovery commands are not available.",
        commandKeys: recoveryCommandKeys,
        nextAction: "Run the generated backup and restore dry-run commands on a separate restore target before staging sign-off."
      },
      {
        key: "route_map_gate",
        label: "Route-map and download-surface gate",
        status: "operator_execute",
        evidence: launchRouteMapGate?.dryRunCommand || "Run the route-map gate dry run first.",
        command: launchRouteMapGate?.command || null,
        dryRunCommand: launchRouteMapGate?.dryRunCommand || null,
        nextAction: "Run the targeted gate after the rehearsal handoff and before live-write staging smoke."
      },
      {
        key: "live_write_approval",
        label: "Live-write approval",
        status: "operator_confirm",
        evidence: "The generated staging smoke command includes --allow-live-writes and will modify staging data.",
        nextAction: "Get explicit launch-duty approval before running the live-write smoke command."
      }
    ]
  };
}

function buildStagingOperatorChecklist(result) {
  const recoveryCommandKeys = Object.keys(result.nextCommands?.recovery || {});
  const evidenceOperations = Array.isArray(result.evidenceActionPlan?.items)
    ? result.evidenceActionPlan.items.map((item) => item.operation)
    : [];
  return [
    {
      key: "review_environment_readiness",
      order: 1,
      label: "Review environment readiness",
      status: "operator_review",
      summary: "Confirm HTTPS, non-default secrets, storage, recovery, route-map gate, and live-write approval readiness.",
      readinessStatus: result.environmentReadiness?.status || "not_available"
    },
    {
      key: "run_route_map_gate",
      order: 2,
      label: "Run route-map and download-surface gate",
      status: "operator_execute",
      command: result.nextCommands?.launchRouteMapGate?.command || null,
      dryRunCommand: result.nextCommands?.launchRouteMapGate?.dryRunCommand || null,
      summary: "Run the targeted pre-staging gate before any live-write smoke command."
    },
    {
      key: "run_backup_restore_drill",
      order: 3,
      label: "Run backup and restore drill",
      status: "operator_execute",
      commandKeys: recoveryCommandKeys,
      summary: "Run generated backup and restore dry-run commands on a separate restore target."
    },
    {
      key: "approve_live_write_smoke",
      order: 4,
      label: "Approve live-write smoke",
      status: "operator_confirm",
      summary: "Confirm launch duty accepts staging writes before running the smoke command."
    },
    {
      key: "run_live_write_smoke",
      order: 5,
      label: "Run live-write staging smoke",
      status: "operator_execute",
      command: result.nextCommands?.launchSmoke || null,
      summary: "Run launch:smoke:staging only after approvals and recovery checks are complete."
    },
    {
      key: "save_smoke_handoff",
      order: 6,
      label: "Save smoke handoff",
      status: "operator_archive",
      summary: "Keep the launch smoke JSON handoff with duty notes, summary downloads, and route links."
    },
    {
      key: "open_launch_mainline",
      order: 7,
      label: "Open Launch Mainline",
      status: "operator_open",
      route: result.nextCommands?.launchMainline || null,
      summary: "Open the scoped Launch Mainline lane after smoke completes."
    },
    {
      key: "record_launch_mainline_evidence",
      order: 8,
      label: "Record Launch Mainline evidence",
      status: "operator_execute",
      endpoint: result.evidenceActionPlan?.endpoint || null,
      bearerTokenEnv: result.evidenceReadiness?.tokenEnv || DEVELOPER_BEARER_TOKEN_ENV,
      evidenceOperations,
      summary: "Record evidence receipts in the order shown by evidenceActionPlan.items."
    },
    {
      key: "verify_receipt_visibility",
      order: 9,
      label: "Verify receipt visibility",
      status: "operator_review",
      downloads: result.nextCommands?.receiptVisibilitySummaries || null,
      summary: "Verify Launch Review and Launch Smoke receipt-visibility summaries after evidence is recorded."
    }
  ];
}

function buildStagingResultBackfillSummary(result) {
  const productCode = result.summary?.productCode || "";
  const baseUrl = result.summary?.baseUrl || "";
  const developerOps = baseUrl
    ? buildRoute(baseUrl, "/developer/ops", {
      productCode,
      source: "staging-rehearsal",
      handoff: "first-wave"
    })
    : null;
  return {
    status: "awaiting_staging_execution",
    willModifyData: false,
    requiredResultKeys: [
      "route_map_gate_result",
      "backup_restore_drill_result",
      "live_write_smoke_result",
      "launch_smoke_handoff",
      "launch_mainline_evidence_receipts",
      "receipt_visibility_review"
    ],
    destinations: {
      launchMainline: result.nextCommands?.launchMainline || null,
      developerOps
    },
    evidenceEndpoint: result.evidenceActionPlan?.endpoint || null,
    receiptVisibilityDownloads: result.nextCommands?.receiptVisibilitySummaries || null,
    operatorNote: "Do not paste passwords or bearer tokens into the result summary; record pass/fail status, receipt IDs, artifact paths, and redacted handoff file names only."
  };
}

function fileOutputStatus(file) {
  if (!file) {
    return "not_requested";
  }
  return file.written ? "written" : "pending_write";
}

function isFilledCloseoutField(field) {
  if (!field || field.status === "pending_operator_entry") {
    return false;
  }
  if (field.value === null || field.value === undefined) {
    return false;
  }
  if (typeof field.value === "string") {
    return field.value.trim() !== "";
  }
  if (Array.isArray(field.value)) {
    return field.value.length > 0;
  }
  if (typeof field.value === "object") {
    return Object.keys(field.value).length > 0;
  }
  return true;
}

function artifactPathFromCloseoutField(field) {
  if (!field) {
    return null;
  }
  if (typeof field.artifactPath === "string" && field.artifactPath.trim()) {
    return field.artifactPath;
  }
  if (field.value && typeof field.value === "object" && !Array.isArray(field.value)) {
    const artifactPath = field.value.artifactPath;
    return typeof artifactPath === "string" && artifactPath.trim() ? artifactPath : null;
  }
  return null;
}

function buildCloseoutInputBackfillReview(payload, closeout = {}, context = {}) {
  const acceptanceFields = Array.isArray(context.acceptanceFields)
    ? context.acceptanceFields
    : (Array.isArray(payload?.acceptanceFields) ? payload.acceptanceFields : []);
  const fieldsByKey = context.fieldsByKey instanceof Map
    ? context.fieldsByKey
    : new Map(acceptanceFields.filter((field) => field && field.key).map((field) => [field.key, field]));
  const checks = Array.isArray(closeout.acceptanceChecks) ? closeout.acceptanceChecks : [];
  const checkByKey = new Map(checks.filter((check) => check && check.key).map((check) => [check.key, check]));
  const requiredKeys = Array.isArray(context.requiredKeys) && context.requiredKeys.length
    ? context.requiredKeys
    : checks.map((item) => item.key).filter(Boolean);
  const fieldRows = requiredKeys.map((key) => {
    const field = fieldsByKey.get(key) || null;
    const check = checkByKey.get(key) || {};
    const filled = isFilledCloseoutField(field);
    return {
      key,
      label: check.label || null,
      status: filled ? "filled" : (field ? "missing_value" : "missing_field"),
      sourceStep: field?.sourceStep || CLOSEOUT_SOURCE_STEPS[key] || "operator_backfill",
      artifactPath: artifactPathFromCloseoutField(field),
      receiptOperations: field?.receiptOperations || check.operations || [],
      expectedEvidence: check.expectedEvidence || null,
      nextAction: filled
        ? "Keep the redacted evidence artifact linked for audit."
        : "Replace the draft placeholder with redacted evidence before the full test window."
    };
  });
  const filledFields = fieldRows.filter((row) => row.status === "filled");
  const missingFields = fieldRows.filter((row) => row.status !== "filled");
  const decision = context.decision || payload?.decision || null;
  const readyForFullTestWindow = missingFields.length === 0 && decision === "ready-for-full-test-window";
  const sourceMode = payload?.mode || null;
  const draftPromotionStatus = sourceMode === "staging-closeout-input-draft"
    ? (missingFields.length === 0 ? "draft_promoted" : "draft_needs_values")
    : (payload ? "not_draft_source" : "not_loaded");
  const status = !payload
    ? "not_loaded"
    : (readyForFullTestWindow ? "ready_for_full_test_window" : (missingFields.length === 0 ? "decision_pending" : "missing_required_fields"));
  return {
    mode: "staging-closeout-input-review",
    status,
    sourceMode,
    draftPromotionStatus,
    requiredFieldCount: requiredKeys.length,
    filledFieldCount: filledFields.length,
    missingFieldCount: missingFields.length,
    safeToEnterFullTestWindow: readyForFullTestWindow,
    decision,
    requiredDecision: "ready-for-full-test-window",
    placeholderKeys: missingFields.map((item) => item.key),
    missingFields,
    fieldRows,
    nextAction: readyForFullTestWindow
      ? "Closeout input is ready for the full test window; keep production sign-off fields pending until full suite evidence is attached."
      : "Replace missing draft placeholders, confirm operator_go_no_go is ready-for-full-test-window, then reload the closeout input."
  };
}

function summarizeCloseoutInputReview(review, closeout = {}) {
  const source = review || buildCloseoutInputBackfillReview(null, closeout);
  return {
    status: source.status || "not_loaded",
    draftPromotionStatus: source.draftPromotionStatus || "not_loaded",
    missingFieldCount: source.missingFieldCount ?? 0,
    placeholderKeys: Array.isArray(source.placeholderKeys) ? source.placeholderKeys : [],
    safeToEnterFullTestWindow: source.safeToEnterFullTestWindow === true
  };
}

function isReceiptVisibilityVisible(value) {
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    return ["visible", "pass", "confirmed"].includes(value.trim().toLowerCase());
  }
  if (value && typeof value === "object") {
    return [value.status, value.result, value.visibility, value.value]
      .map((item) => String(item || "").trim().toLowerCase())
      .some((item) => ["visible", "pass", "confirmed"].includes(item));
  }
  return false;
}

function buildReceiptVisibilityTemplate() {
  return Object.fromEntries(
    RECEIPT_VISIBILITY_KEYS.map((key) => [
      key,
      {
        status: "pending_operator_entry",
        value: null,
        expectedValue: "visible",
        operatorNote: "Set value to visible only after this lane shows the latest staging evidence receipts."
      }
    ])
  );
}

function buildProductionSignoffInputTemplate(signoff = {}) {
  return {
    decision: null,
    requiredDecision: signoff.requiredDecision || null,
    conditions: (signoff.conditions || []).map((condition) => ({
      key: condition.key,
      status: "pending_operator_entry",
      value: null,
      expectedEvidence: condition.evidence || null,
      operatorNote: "Backfill a redacted pass/confirmed result after the full test window and sign-off review."
    }))
  };
}

function buildCloseoutBackfillGuide(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const orderedBackfillKeys = (closeout.acceptanceChecks || [])
    .map((item) => item.key)
    .filter(Boolean);
  const productionSignoffKeys = (closeout.productionSignoffConditions?.conditions || [])
    .map((item) => item.key)
    .filter(Boolean);
  return {
    status: "awaiting_staging_results",
    willModifyData: false,
    closeoutInputReload: {
      option: "--closeout-input-file",
      command: "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>",
      purpose: "Reload the redacted closeout input after staging results are backfilled."
    },
    orderedBackfillKeys,
    receiptVisibilityKeys: RECEIPT_VISIBILITY_KEYS,
    productionSignoffKeys,
    fullTestWindow: {
      command: closeout.fullTestWindowEntry?.command || "npm.cmd test",
      requiredDecision: closeout.fullTestWindowEntry?.triggerDecision || "ready-for-full-test-window",
      requiredCloseoutKeys: closeout.fullTestWindowEntry?.requiredCloseoutKeys || orderedBackfillKeys
    },
    productionSignoff: {
      requiredDecision: closeout.productionSignoffConditions?.requiredDecision || "ready-for-production-signoff",
      requiredSignoffKeys: productionSignoffKeys,
      requiredReceiptVisibilityKeys: RECEIPT_VISIBILITY_KEYS
    },
    nextAction: "Backfill the generated closeout JSON, reload it with --closeout-input-file, then enter the full test window only after the readiness gaps clear."
  };
}

function buildFullTestWindowReadiness(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const closeoutInput = result.closeoutInput || null;
  const command = closeout.fullTestWindowEntry?.command || "npm.cmd test";
  const missingCloseoutKeys = closeoutInput?.missingKeys
    || (closeout.acceptanceChecks || []).map((item) => item.key).filter(Boolean);
  const canRun = closeoutInput?.readyForFullTestWindow === true;
  return {
    status: canRun ? "ready" : "blocked",
    canRun,
    command,
    willRunFullSuite: closeout.fullTestWindowEntry?.willRunFullSuite !== false,
    willModifyData: false,
    requiredDecision: closeout.fullTestWindowEntry?.triggerDecision || "ready-for-full-test-window",
    closeoutInputStatus: closeoutInput?.status || "missing",
    missingCloseoutKeys,
    reloadCommand: result.closeoutBackfillGuide?.closeoutInputReload?.command || "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>",
    nextAction: canRun
      ? `Run ${command} in the reserved full test window, then backfill productionSignoff.`
      : `Backfill closeout input and reload it before running ${command}.`
  };
}

function buildProductionSignoffReadiness(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const closeoutInput = result.closeoutInput || null;
  const requiredSignoffKeys = (closeout.productionSignoffConditions?.conditions || [])
    .map((item) => item.key)
    .filter(Boolean);
  const canSignoff = closeoutInput?.readyForProductionSignoff === true;
  return {
    status: canSignoff ? "ready" : "blocked",
    canSignoff,
    requiredDecision: closeout.productionSignoffConditions?.requiredDecision || "ready-for-production-signoff",
    productionDecision: closeoutInput?.productionDecision || null,
    closeoutInputStatus: closeoutInput?.status || "missing",
    readyForFullTestWindow: closeoutInput?.readyForFullTestWindow === true,
    missingSignoffKeys: closeoutInput?.signoffMissingKeys || requiredSignoffKeys,
    missingReceiptVisibilityKeys: closeoutInput?.missingReceiptVisibilityKeys || RECEIPT_VISIBILITY_KEYS,
    reloadCommand: result.closeoutBackfillGuide?.closeoutInputReload?.command || "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>",
    nextAction: canSignoff
      ? "Production sign-off is ready; keep the closeout artifact with release evidence before cutover."
      : "Backfill full-test evidence, production sign-off conditions, production decision, and receipt visibility before cutover."
  };
}

function buildLaunchDayWatchPlan(result) {
  const readiness = result.productionSignoffReadiness || buildProductionSignoffReadiness(result);
  const canStartCutoverWatch = readiness?.canSignoff === true;
  return {
    status: canStartCutoverWatch ? "ready" : "blocked",
    canStartCutoverWatch,
    willModifyData: false,
    watchStartGate: "production_signoff_readiness",
    requiredDecision: readiness?.requiredDecision || "ready-for-production-signoff",
    productionDecision: readiness?.productionDecision || null,
    closeoutInputStatus: readiness?.closeoutInputStatus || "missing",
    missingSignoffKeys: readiness?.missingSignoffKeys || [],
    missingReceiptVisibilityKeys: readiness?.missingReceiptVisibilityKeys || [],
    routes: {
      launchMainline: result.nextCommands?.launchMainline || null,
      developerOps: result.resultBackfillSummary?.destinations?.developerOps || null,
      launchReviewSummary: result.nextCommands?.receiptVisibilitySummaries?.launchReviewSummary || null,
      launchSmokeSummary: result.nextCommands?.receiptVisibilitySummaries?.launchSmokeSummary || null
    },
    watchWindows: [
      {
        key: "cutover_watch",
        status: canStartCutoverWatch ? "operator_watch" : "blocked_until_production_signoff",
        window: "T-30m through T+2h",
        summary: "Keep Launch Mainline, Developer Ops, Launch Review, and Launch Smoke receipt visibility open during cutover."
      },
      {
        key: "first_wave_stabilization",
        status: canStartCutoverWatch ? "operator_handoff" : "blocked_until_cutover_watch_started",
        window: "T+2h through T+24h",
        summary: "Hand off first-wave incidents, receipt mismatches, rollback signals, and stabilization notes into Developer Ops."
      }
    ],
    escalationTriggers: [
      "production_signoff_missing",
      "receipt_visibility_missing",
      "launch_mainline_action_failure",
      "developer_ops_receipt_mismatch",
      "backup_restore_or_rollback_unclear"
    ],
    nextAction: canStartCutoverWatch
      ? "Start launch-day watch with Launch Mainline, Developer Ops, Launch Review, and Launch Smoke receipt visibility open."
      : "Do not start launch-day watch until production sign-off readiness is ready."
  };
}

function buildStabilizationHandoffPlan(result) {
  const watchPlan = result.launchDayWatchPlan || buildLaunchDayWatchPlan(result);
  const canStartStabilizationHandoff = watchPlan?.canStartCutoverWatch === true;
  const requiredEvidenceKeys = [
    "launch_day_watch_summary",
    "first_wave_incident_log",
    "receipt_visibility_snapshot",
    "rollback_signal_review",
    "stabilization_owner_handoff"
  ];
  return {
    status: canStartStabilizationHandoff ? "ready" : "blocked",
    canStartStabilizationHandoff,
    willModifyData: false,
    sourceWatchStatus: watchPlan?.status || "not_available",
    requiredWatchWindows: (watchPlan?.watchWindows || []).map((item) => item.key).filter(Boolean),
    requiredEvidenceKeys,
    routes: {
      launchMainline: watchPlan?.routes?.launchMainline || result.nextCommands?.launchMainline || null,
      developerOps: watchPlan?.routes?.developerOps || result.resultBackfillSummary?.destinations?.developerOps || null,
      launchReviewSummary: watchPlan?.routes?.launchReviewSummary || result.nextCommands?.receiptVisibilitySummaries?.launchReviewSummary || null,
      launchSmokeSummary: watchPlan?.routes?.launchSmokeSummary || result.nextCommands?.receiptVisibilitySummaries?.launchSmokeSummary || null
    },
    handoffWindows: [
      {
        key: "stabilization_owner_handoff",
        label: "T+2h stabilization owner handoff",
        status: canStartStabilizationHandoff ? "operator_handoff" : "blocked_until_cutover_watch",
        summary: "Hand off launch-day watch summary, incidents, receipt snapshots, and rollback signals to the stabilization owner."
      },
      {
        key: "first_wave_closeout",
        label: "T+24h first-wave closeout",
        status: canStartStabilizationHandoff ? "operator_closeout" : "blocked_until_stabilization_owner_handoff",
        summary: "Close first-wave stabilization with unresolved incident list, customer impact notes, and next-duty owner."
      }
    ],
    escalationTriggers: [
      ...new Set([
        ...(watchPlan?.escalationTriggers || []),
        "unresolved_first_wave_incident",
        "missing_stabilization_owner"
      ])
    ],
    nextAction: canStartStabilizationHandoff
      ? "Hand off stabilization notes, first-wave incidents, receipt visibility snapshots, and rollback signals to the stabilization owner."
      : "Complete launch-day watch readiness before starting stabilization handoff."
  };
}

function buildStagingRunRecordTemplate(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const ledger = closeout.artifactReceiptLedger || {};
  const archiveRoot = ledger.archiveRoot || path.posix.join(
    "artifacts",
    "staging",
    sanitizeArtifactPathSegment(result.summary?.productCode, "product"),
    sanitizeArtifactPathSegment(result.summary?.channel || "stable", "stable")
  );
  const readiness = {
    fullTestWindow: result.fullTestWindowReadiness?.status || "not_available",
    productionSignoff: result.productionSignoffReadiness?.status || "not_available",
    launchDayWatch: result.launchDayWatchPlan?.status || "not_available",
    stabilizationHandoff: result.stabilizationHandoffPlan?.status || "not_available"
  };
  const ledgerRecords = (ledger.rows || []).map((row) => ({
    key: row.checkKey,
    sourcePlan: "stagingAcceptanceCloseout",
    artifactKey: row.artifactKey || null,
    artifactPath: row.artifactPath || null,
    receiptOperations: row.receiptOperations || [],
    operatorNote: row.operatorNote || null
  }));
  const extraRecords = [
    {
      key: "launch_day_watch_summary",
      sourcePlan: "launchDayWatchPlan",
      artifactKey: "launch_day_watch_summary",
      artifactPath: path.posix.join(archiveRoot, "launch-day-watch-summary.md"),
      receiptOperations: ["record_cutover_walkthrough", "record_launch_day_readiness_review"],
      operatorNote: "Record cutover watch start/end time, owner, route checks, and any operator decisions."
    },
    {
      key: "first_wave_incident_log",
      sourcePlan: "launchDayWatchPlan",
      artifactKey: "first_wave_incident_log",
      artifactPath: path.posix.join(archiveRoot, "first-wave-incident-log.md"),
      receiptOperations: ["record_post_launch_ops_sweep"],
      operatorNote: "Record first-wave incidents, customer impact, mitigation, owner, and status."
    },
    {
      key: "receipt_visibility_snapshot",
      sourcePlan: "launchDayWatchPlan",
      artifactKey: "receipt_visibility_snapshot",
      artifactPath: path.posix.join(archiveRoot, "receipt-visibility-snapshot.txt"),
      receiptOperations: ["record_post_launch_ops_sweep"],
      operatorNote: "Save Launch Mainline, Developer Ops, Launch Review, and Launch Smoke receipt visibility snapshots."
    },
    {
      key: "rollback_signal_review",
      sourcePlan: "stabilizationHandoffPlan",
      artifactKey: "rollback_signal_review",
      artifactPath: path.posix.join(archiveRoot, "rollback-signal-review.md"),
      receiptOperations: ["record_rollback_walkthrough", "record_launch_stabilization_review"],
      operatorNote: "Record whether rollback signals were observed, dismissed, or escalated."
    },
    {
      key: "stabilization_owner_handoff",
      sourcePlan: "stabilizationHandoffPlan",
      artifactKey: "stabilization_owner_handoff",
      artifactPath: path.posix.join(archiveRoot, "stabilization-owner-handoff.md"),
      receiptOperations: ["record_launch_stabilization_review"],
      operatorNote: "Record stabilization owner, timestamp, unresolved items, and next-duty follow-up."
    }
  ];
  const records = [...ledgerRecords, ...extraRecords];
  return {
    status: readiness.stabilizationHandoff === "ready" ? "ready_for_stabilization_handoff" : "awaiting_staging_execution",
    willModifyData: false,
    archiveRoot,
    sourceReadiness: readiness,
    closeoutInputReloadCommand: result.closeoutBackfillGuide?.closeoutInputReload?.command || "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>",
    requiredRecordKeys: records.map((item) => item.key).filter(Boolean),
    records,
    operatorNote: "Keep only redacted artifact paths, receipt IDs, route snapshots, incident summaries, and operator decisions in these records."
  };
}

function buildFilledCloseoutInputExample(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const runTemplate = result.stagingRunRecordTemplate || buildStagingRunRecordTemplate(result);
  const archiveRoot = runTemplate.archiveRoot || "artifacts/staging/product/stable";
  const recordByKey = new Map((runTemplate.records || []).map((record) => [record.key, record]));
  const exampleStatus = "example_replace_before_use";
  const exampleValue = (key) => {
    const record = recordByKey.get(key) || {};
    if (key === "operator_go_no_go") {
      return "ready-for-full-test-window";
    }
    return {
      result: "pass",
      artifactPath: record.artifactPath || path.posix.join(archiveRoot, `${key}.txt`),
      receiptIds: (record.receiptOperations || []).map((operation) => `<${operation}-receipt-id>`)
    };
  };
  const receiptVisibility = Object.fromEntries(
    RECEIPT_VISIBILITY_KEYS.map((key) => [
      key,
      {
        status: exampleStatus,
        value: "visible",
        evidence: `<${key}-visibility-evidence>`
      }
    ])
  );
  return {
    mode: "staging-closeout-input-example",
    status: "example_only",
    exampleOnly: true,
    willModifyData: false,
    doNotSubmitWithoutReplacingPlaceholders: true,
    saveAs: path.posix.join(archiveRoot, "filled-closeout-input.example.json"),
    reloadCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${path.posix.join(archiveRoot, "filled-closeout-input.json")}`,
    decision: "ready-for-full-test-window",
    acceptanceFields: (closeout.acceptanceChecks || []).map((check) => {
      const record = recordByKey.get(check.key) || {};
      return {
        key: check.key,
        status: exampleStatus,
        value: exampleValue(check.key),
        artifactPath: record.artifactPath || null,
        receiptOperations: record.receiptOperations || [],
        operatorNote: "Replace this example value with real redacted staging evidence before loading it."
      };
    }),
    receiptVisibility,
    productionSignoff: {
      decision: closeout.productionSignoffConditions?.requiredDecision || "ready-for-production-signoff",
      conditions: (closeout.productionSignoffConditions?.conditions || []).map((condition) => ({
        key: condition.key,
        status: exampleStatus,
        value: {
          result: "pass",
          evidence: `<${condition.key}-evidence>`
        },
        operatorNote: "Replace this example sign-off value with real full-test and sign-off evidence before loading it."
      })),
      receiptVisibility
    },
    operatorNote: "Copy this shape to filled-closeout-input.json and replace every placeholder/example value with redacted real staging results before using --closeout-input-file."
  };
}

function buildFilledCloseoutInputDraft(result) {
  const plan = result.stagingProfileLaunchPlan || {};
  const manifest = plan.backfillManifest || {};
  if (manifest.status !== "awaiting_profile_driven_results" || !Array.isArray(manifest.rows) || manifest.rows.length === 0) {
    return {
      mode: "staging-closeout-input-draft",
      status: "profile_not_loaded",
      exampleOnly: true,
      willModifyData: false,
      source: "stagingProfileLaunchPlan.backfillManifest",
      saveAs: null,
      copyTo: null,
      reloadCommand: null,
      acceptanceFields: [],
      receiptVisibility: buildReceiptVisibilityTemplate(),
      productionSignoff: buildProductionSignoffInputTemplate(result.stagingAcceptanceCloseout?.productionSignoffConditions || {}),
      nextAction: "Load a secret-free staging profile before generating a profile-driven closeout input draft."
    };
  }
  const closeout = result.stagingAcceptanceCloseout || {};
  const checkByKey = new Map((closeout.acceptanceChecks || []).map((check) => [check.key, check]));
  return {
    mode: "staging-closeout-input-draft",
    status: "draft_replace_before_use",
    exampleOnly: true,
    willModifyData: false,
    source: "stagingProfileLaunchPlan.backfillManifest",
    saveAs: path.posix.join(manifest.archiveRoot, "filled-closeout-input.draft.json"),
    copyTo: manifest.closeoutInputPath,
    reloadCommand: manifest.closeoutInputPath
      ? `npm.cmd run staging:rehearsal -- --closeout-input-file ${manifest.closeoutInputPath}`
      : null,
    doNotSubmitWithoutReplacingPlaceholders: true,
    decision: null,
    acceptanceFields: manifest.rows.map((row) => {
      const check = checkByKey.get(row.closeoutKey) || {};
      return {
        key: row.closeoutKey,
        label: check.label || null,
        status: "pending_operator_entry",
        value: null,
        sourceStep: row.sourceStep,
        artifactPath: row.artifactPath,
        receiptOperations: row.receiptOperations || [],
        expectedEvidence: check.expectedEvidence || null,
        operatorNote: "Replace null with real redacted staging evidence, then remove exampleOnly before loading this as closeout input."
      };
    }),
    receiptVisibility: buildReceiptVisibilityTemplate(),
    productionSignoff: buildProductionSignoffInputTemplate(closeout.productionSignoffConditions || {}),
    nextAction: "Copy this draft to filled-closeout-input.json, replace null values with redacted evidence, remove exampleOnly, then reload the closeout input."
  };
}

function formatPowerShellArg(value) {
  const text = String(value ?? "");
  if (text === "") {
    return "''";
  }
  if (/[\s"'|&;<>()[\]{}]/.test(text)) {
    return `'${text.replace(/'/g, "''")}'`;
  }
  return text;
}

function buildStagingEnvironmentBinding(result, options = {}) {
  const runTemplate = result.stagingRunRecordTemplate || buildStagingRunRecordTemplate(result);
  const archiveRoot = runTemplate.archiveRoot || "artifacts/staging/product/stable";
  const handoffPath = result.handoffFile?.path || path.posix.join(archiveRoot, "staging-rehearsal-handoff.md");
  const closeoutPath = result.closeoutFile?.path || path.posix.join(archiveRoot, "staging-closeout-template.json");
  const runRecordPath = result.runRecordFile?.path || path.posix.join(archiveRoot, "staging-run-record-index.json");
  const artifactManifestPath = result.artifactManifestFile?.path || path.posix.join(archiveRoot, "staging-artifact-manifest.json");
  const closeoutReloadPacketPath = result.closeoutReloadPacketFile?.path || path.posix.join(archiveRoot, "staging-closeout-reload-packet.json");
  const readinessReviewPacketPath = result.readinessReviewPacketFile?.path || path.posix.join(archiveRoot, "staging-readiness-review-packet.json");
  const productionSignoffPacketPath = result.productionSignoffPacketFile?.path || path.posix.join(archiveRoot, "staging-production-signoff-packet.json");
  const launchDutyArchiveIndexPath = result.launchDutyArchiveIndexFile?.path || path.posix.join(archiveRoot, "staging-launch-duty-archive-index.json");
  const filledCloseoutInputPath = path.posix.join(archiveRoot, "filled-closeout-input.json");
  const filledCloseoutDraftPath = result.filledCloseoutDraftFile?.path
    || result.filledCloseoutInputDraft?.saveAs
    || path.posix.join(archiveRoot, "filled-closeout-input.draft.json");
  const filledExamplePath = result.filledCloseoutInputExample?.saveAs || path.posix.join(archiveRoot, "filled-closeout-input.example.json");
  const environment = {
    baseUrl: result.summary?.baseUrl || options.baseUrl || null,
    productCode: result.summary?.productCode || options.productCode || null,
    channel: result.summary?.channel || options.channel || null,
    targetOs: result.summary?.targetOs || options.targetOs || null,
    storageProfile: result.summary?.storageProfile || options.storageProfile || null,
    targetEnvFile: options.targetEnvFile || null,
    appBackupDir: options.appBackupDir || null,
    postgresBackupDir: options.postgresBackupDir || null
  };
  const commandParts = [
    "npm.cmd",
    "run",
    "staging:rehearsal",
    "--",
    "--json",
    "--base-url",
    environment.baseUrl,
    "--product-code",
    environment.productCode,
    "--channel",
    environment.channel,
    "--admin-username",
    options.adminUsername,
    "--admin-password",
    `$env:${ADMIN_PASSWORD_ENV}`,
    "--developer-username",
    options.developerUsername,
    "--developer-password",
    `$env:${DEVELOPER_PASSWORD_ENV}`,
    "--target-os",
    environment.targetOs,
    "--storage-profile",
    environment.storageProfile,
    "--target-env-file",
    environment.targetEnvFile,
    "--app-backup-dir",
    environment.appBackupDir,
    ...(environment.postgresBackupDir
      ? ["--postgres-backup-dir", environment.postgresBackupDir]
      : []),
    "--handoff-file",
    handoffPath,
    "--closeout-file",
    closeoutPath,
    "--run-record-file",
    runRecordPath,
    "--artifact-manifest-file",
    artifactManifestPath,
    "--closeout-reload-packet-file",
    closeoutReloadPacketPath,
    "--readiness-review-packet-file",
    readinessReviewPacketPath,
    "--production-signoff-packet-file",
    productionSignoffPacketPath,
    "--launch-duty-archive-index-file",
    launchDutyArchiveIndexPath,
    "--filled-closeout-draft-file",
    filledCloseoutDraftPath
  ].filter((part) => part !== null && part !== undefined && String(part) !== "");
  return {
    status: "ready_for_real_staging_binding",
    willModifyData: false,
    environment,
    credentialEnv: {
      adminPassword: ADMIN_PASSWORD_ENV,
      developerPassword: DEVELOPER_PASSWORD_ENV,
      developerBearerToken: DEVELOPER_BEARER_TOKEN_ENV
    },
    recommendedOutputFiles: [
      {
        key: "handoff_file",
        path: handoffPath,
        status: result.handoffFile ? fileOutputStatus(result.handoffFile) : "recommended_default"
      },
      {
        key: "closeout_file",
        path: closeoutPath,
        status: result.closeoutFile ? fileOutputStatus(result.closeoutFile) : "recommended_default"
      },
      {
        key: "run_record_index",
        path: runRecordPath,
        status: result.runRecordFile ? fileOutputStatus(result.runRecordFile) : "recommended_default"
      },
      {
        key: "artifact_manifest",
        path: artifactManifestPath,
        status: result.artifactManifestFile ? fileOutputStatus(result.artifactManifestFile) : "recommended_default"
      },
      {
        key: "closeout_reload_packet",
        path: closeoutReloadPacketPath,
        status: result.closeoutReloadPacketFile ? fileOutputStatus(result.closeoutReloadPacketFile) : "recommended_default"
      },
      {
        key: "readiness_review_packet",
        path: readinessReviewPacketPath,
        status: result.readinessReviewPacketFile ? fileOutputStatus(result.readinessReviewPacketFile) : "recommended_default"
      },
      {
        key: "production_signoff_packet",
        path: productionSignoffPacketPath,
        status: result.productionSignoffPacketFile ? fileOutputStatus(result.productionSignoffPacketFile) : "recommended_default"
      },
      {
        key: "launch_duty_archive_index",
        path: launchDutyArchiveIndexPath,
        status: result.launchDutyArchiveIndexFile ? fileOutputStatus(result.launchDutyArchiveIndexFile) : "recommended_default"
      },
      {
        key: "filled_closeout_input",
        path: filledCloseoutInputPath,
        status: "operator_create"
      },
      {
        key: "filled_closeout_draft",
        path: filledCloseoutDraftPath,
        status: result.filledCloseoutDraftFile ? fileOutputStatus(result.filledCloseoutDraftFile) : "example_only"
      },
      {
        key: "filled_closeout_input_example",
        path: filledExamplePath,
        status: "example_only"
      },
      {
        key: "artifact_archive_root",
        path: archiveRoot,
        status: "operator_archive"
      }
    ],
    dryRunCommand: commandParts.map(formatPowerShellArg).join(" "),
    nextAction: "Verify these real staging values, generate handoff and closeout files under the artifact archive root, then run this dry-run command before live-write smoke.",
    operatorNote: "This binding is safe to store: it references password and bearer-token environment variable names only, not raw secret values."
  };
}

function buildStagingExecutionRunbook(result) {
  const binding = result.stagingEnvironmentBinding || null;
  const closeout = result.stagingAcceptanceCloseout || {};
  const ledger = closeout.artifactReceiptLedger || {};
  const ledgerRowsByKey = new Map((ledger.rows || []).map((row) => [row.checkKey, row]));
  const outputFileByKey = new Map((binding?.recommendedOutputFiles || []).map((item) => [item.key, item]));
  const archiveRoot = outputFileByKey.get("artifact_archive_root")?.path
    || ledger.archiveRoot
    || result.stagingRunRecordTemplate?.archiveRoot
    || "artifacts/staging/product/stable";
  const filledCloseoutInputPath = outputFileByKey.get("filled_closeout_input")?.path
    || path.posix.join(archiveRoot, "filled-closeout-input.json");
  const filledExample = result.filledCloseoutInputExample || buildFilledCloseoutInputExample(result);
  const closeoutInputReview = summarizeCloseoutInputReview(result.closeoutInput?.backfillReview, closeout);
  const commandSequence = [
    {
      key: "prepare_secret_env",
      status: "operator_prepare",
      willModifyData: false,
      env: [
        binding?.credentialEnv?.adminPassword || ADMIN_PASSWORD_ENV,
        binding?.credentialEnv?.developerPassword || DEVELOPER_PASSWORD_ENV,
        binding?.credentialEnv?.developerBearerToken || DEVELOPER_BEARER_TOKEN_ENV
      ],
      summary: "Set smoke password env vars and developer bearer token before copying generated commands."
    },
    {
      key: "generate_rehearsal_outputs",
      status: "operator_execute",
      willModifyData: false,
      command: binding?.dryRunCommand || null,
      outputs: ["handoff_file", "closeout_file"],
      summary: "Generate the redacted handoff and closeout template from the real staging binding."
    },
    {
      key: "run_route_map_gate",
      status: "operator_execute",
      willModifyData: false,
      command: result.nextCommands?.launchRouteMapGate?.command || null,
      closeoutKey: "route_map_gate_result",
      artifactPath: ledgerRowsByKey.get("route_map_gate_result")?.artifactPath || null,
      summary: "Run targeted route/download visibility tests before staging writes."
    },
    {
      key: "run_backup_restore_drill",
      status: "operator_execute",
      willModifyData: false,
      commandKeys: Object.keys(result.nextCommands?.recovery || {}),
      closeoutKey: "backup_restore_drill_result",
      artifactPath: ledgerRowsByKey.get("backup_restore_drill_result")?.artifactPath || null,
      summary: "Run backup, restore dry-run, and healthcheck commands on a separate restore target."
    },
    {
      key: "approve_live_write_smoke",
      status: "operator_confirm",
      willModifyData: false,
      summary: "Confirm launch duty accepts staging writes before running launch:smoke:staging."
    },
    {
      key: "run_live_write_smoke",
      status: "operator_execute",
      willModifyData: true,
      command: result.nextCommands?.launchSmoke || null,
      closeoutKey: "live_write_smoke_result",
      artifactPath: ledgerRowsByKey.get("live_write_smoke_result")?.artifactPath || null,
      summary: "Run the HTTPS staging smoke command after approval and archive the redacted output."
    },
    {
      key: "archive_launch_smoke_handoff",
      status: "operator_archive",
      willModifyData: false,
      closeoutKey: "launch_smoke_handoff",
      artifactPath: ledgerRowsByKey.get("launch_smoke_handoff")?.artifactPath || null,
      summary: "Save the Launch Smoke handoff consumed by Launch Review, Developer Ops, and Launch Mainline."
    },
    {
      key: "record_launch_mainline_evidence",
      status: "operator_execute",
      willModifyData: true,
      endpoint: result.evidenceActionPlan?.endpoint || null,
      bearerTokenEnv: result.evidenceReadiness?.tokenEnv || DEVELOPER_BEARER_TOKEN_ENV,
      closeoutKey: "launch_mainline_evidence_receipts",
      artifactPath: ledgerRowsByKey.get("launch_mainline_evidence_receipts")?.artifactPath || null,
      summary: "Record Launch Mainline evidence receipts and attach receipt IDs to closeout."
    },
    {
      key: "verify_receipt_visibility",
      status: "operator_review",
      willModifyData: false,
      downloads: result.nextCommands?.receiptVisibilitySummaries || null,
      closeoutKey: "receipt_visibility_review",
      artifactPath: ledgerRowsByKey.get("receipt_visibility_review")?.artifactPath || null,
      summary: "Verify Launch Mainline, Launch Review, Launch Smoke, and Developer Ops receipt visibility."
    },
    {
      key: "backfill_filled_closeout_input",
      status: "operator_backfill",
      willModifyData: false,
      closeoutInputPath: filledCloseoutInputPath,
      examplePath: outputFileByKey.get("filled_closeout_input_example")?.path || filledExample.saveAs || null,
      closeoutKey: "operator_go_no_go",
      artifactPath: ledgerRowsByKey.get("operator_go_no_go")?.artifactPath || null,
      summary: "Copy the example closeout input, replace placeholders with redacted evidence, and record go/no-go."
    },
    {
      key: "reload_closeout_input",
      status: "operator_execute",
      willModifyData: false,
      command: filledExample.reloadCommand || null,
      closeoutInputReview,
      summary: "Reload the filled closeout input and confirm readiness gaps narrow before the full test window."
    }
  ];
  return {
    status: binding?.status === "ready_for_real_staging_binding"
      ? "ready_for_real_staging_dry_run"
      : "blocked_until_environment_binding",
    willModifyData: false,
    containsLiveWriteStep: true,
    liveWriteRequiresApproval: true,
    sourceBindingStatus: binding?.status || null,
    artifactArchiveRoot: archiveRoot,
    outputFiles: binding?.recommendedOutputFiles || [],
    commandSequence,
    closeoutInputReview,
    closeoutBackfillTargets: (closeout.acceptanceChecks || []).map((check) => {
      const row = ledgerRowsByKey.get(check.key) || {};
      return {
        key: check.key,
        sourceStep: CLOSEOUT_SOURCE_STEPS[check.key] || "operator_backfill",
        artifactPath: row.artifactPath || null,
        receiptOperations: row.receiptOperations || [],
        expectedEvidence: check.expectedEvidence || null,
        operatorNote: row.operatorNote || null
      };
    }),
    nextAction: "Run the command sequence through receipt visibility review, then backfill and reload the filled closeout input before the full test window."
  };
}

function buildStagingReadinessTransition(result) {
  const runbook = result.stagingExecutionRunbook || {};
  const fullTestWindow = result.fullTestWindowReadiness || buildFullTestWindowReadiness(result);
  const productionSignoff = result.productionSignoffReadiness || buildProductionSignoffReadiness(result);
  const launchDayWatch = result.launchDayWatchPlan || buildLaunchDayWatchPlan(result);
  const reloadStep = (runbook.commandSequence || []).find((item) => item.key === "reload_closeout_input") || {};
  const canRunFullTestWindow = fullTestWindow?.canRun === true;
  const canSignoffProduction = productionSignoff?.canSignoff === true;
  const canStartLaunchDayWatch = launchDayWatch?.canStartCutoverWatch === true;
  let status = "blocked_until_closeout_reload";
  let orderedNextActions = [
    "complete_staging_execution_runbook",
    "backfill_filled_closeout_input",
    "reload_closeout_input",
    "enter_full_test_window_after_ready",
    "backfill_production_signoff_after_full_test"
  ];
  let nextAction = "Complete the staging execution runbook, backfill closeout input, and reload it before entering the full test window.";
  if (canStartLaunchDayWatch) {
    status = "ready_for_launch_day_watch";
    orderedNextActions = [
      "archive_production_signoff",
      "start_launch_day_watch",
      "prepare_stabilization_handoff"
    ];
    nextAction = "Archive production sign-off evidence, start launch-day watch, and prepare stabilization handoff.";
  } else if (canRunFullTestWindow) {
    status = "ready_for_full_test_window";
    orderedNextActions = [
      "run_full_test_window",
      "backfill_production_signoff",
      "reload_closeout_input",
      "production_signoff_review"
    ];
    nextAction = "Run the full test window, backfill production sign-off evidence, reload closeout input, and review production sign-off.";
  }
  return {
    status,
    willModifyData: false,
    sourceRunbookStatus: runbook.status || null,
    closeoutInputStatus: result.closeoutInput?.status || "missing",
    reloadStep: {
      key: "reload_closeout_input",
      command: reloadStep.command || fullTestWindow?.reloadCommand || productionSignoff?.reloadCommand || null,
      expectedInputStatus: "loaded",
      expectedTransitions: [
        "ready_for_full_test_window",
        "ready_for_launch_day_watch"
      ]
    },
    gates: [
      {
        key: "full_test_window",
        status: fullTestWindow?.status || "not_available",
        canEnter: canRunFullTestWindow,
        command: fullTestWindow?.command || null,
        requiredDecision: fullTestWindow?.requiredDecision || null,
        closeoutInputStatus: fullTestWindow?.closeoutInputStatus || "missing",
        missingCloseoutKeys: fullTestWindow?.missingCloseoutKeys || [],
        nextAction: fullTestWindow?.nextAction || null
      },
      {
        key: "production_signoff",
        status: productionSignoff?.status || "not_available",
        canEnter: canSignoffProduction,
        requiredDecision: productionSignoff?.requiredDecision || null,
        productionDecision: productionSignoff?.productionDecision || null,
        closeoutInputStatus: productionSignoff?.closeoutInputStatus || "missing",
        missingSignoffKeys: productionSignoff?.missingSignoffKeys || [],
        missingReceiptVisibilityKeys: productionSignoff?.missingReceiptVisibilityKeys || [],
        nextAction: productionSignoff?.nextAction || null
      },
      {
        key: "launch_day_watch",
        status: launchDayWatch?.status || "not_available",
        canEnter: canStartLaunchDayWatch,
        requiredDecision: launchDayWatch?.requiredDecision || null,
        productionDecision: launchDayWatch?.productionDecision || null,
        missingSignoffKeys: launchDayWatch?.missingSignoffKeys || [],
        missingReceiptVisibilityKeys: launchDayWatch?.missingReceiptVisibilityKeys || [],
        nextAction: launchDayWatch?.nextAction || null
      }
    ],
    orderedNextActions,
    nextAction
  };
}

function buildLaunchRehearsalExtensionPoints() {
  const coreRequiredTests = [
    "staging rehearsal runner is exposed as an npm script and combines no-write gates",
    "staging rehearsal runner can write a redacted launch-duty handoff file",
    "staging rehearsal runner can write a redacted closeout template file"
  ];
  return {
    status: "ready_for_incremental_extensions",
    willModifyData: false,
    supportedAdditions: [
      {
        key: "additional_output_file",
        builder: "buildStagingEnvironmentBinding",
        summary: "Add new local output paths or archive destinations through the environment binding first.",
        affectedOutputs: [
          "stagingEnvironmentBinding.recommendedOutputFiles",
          "launchRehearsalBundle.files",
          "finalRehearsalPacket.localFiles"
        ],
        requiredTests: coreRequiredTests
      },
      {
        key: "additional_execution_step",
        builder: "buildStagingExecutionRunbook",
        summary: "Add new operator execution steps through the staging runbook before mirroring them into bundle order.",
        affectedOutputs: [
          "stagingExecutionRunbook.commandSequence",
          "launchRehearsalBundle.executionOrder",
          "finalRehearsalPacket.orderedSteps"
        ],
        requiredTests: coreRequiredTests
      },
      {
        key: "additional_closeout_key",
        builder: "buildStagingAcceptanceCloseout",
        summary: "Add new closeout evidence keys through acceptance checks so reload, gaps, and bundle closeout stay aligned.",
        affectedOutputs: [
          "stagingAcceptanceCloseout.acceptanceChecks",
          "stagingExecutionRunbook.closeoutBackfillTargets",
          "launchRehearsalBundle.closeout.requiredKeys"
        ],
        requiredTests: coreRequiredTests
      },
      {
        key: "additional_readiness_gate",
        builder: "buildStagingReadinessTransition",
        summary: "Add new go/no-go gates through readiness transition so operator blockers and launch-day states remain explainable.",
        affectedOutputs: [
          "stagingReadinessTransition.gates",
          "launchRehearsalBundle.readiness.gates",
          "operatorExecutionPlan.readinessGaps"
        ],
        requiredTests: coreRequiredTests
      }
    ],
    extensionWorkflow: [
      "add_builder_field",
      "mirror_in_launch_rehearsal_bundle",
      "add_rehearsal_assertion",
      "add_handoff_rendering",
      "add_closeout_template_assertion",
      "run_staging_rehearsal_targeted_test",
      "run_launch_route_map_gate"
    ],
    nextAction: "Add new launch features by extending the named builder first, then mirror the field into the bundle and tests."
  };
}

function buildLaunchRehearsalBundle(result) {
  const environmentBinding = result.stagingEnvironmentBinding || {};
  const runbook = result.stagingExecutionRunbook || {};
  const transition = result.stagingReadinessTransition || {};
  const runRecord = result.stagingRunRecordTemplate || {};
  const closeout = result.stagingAcceptanceCloseout || {};
  const fileByKey = new Map((environmentBinding.recommendedOutputFiles || []).map((item) => [item.key, item]));
  const artifactArchiveRoot = environmentBinding.recommendedOutputFiles?.find((item) => item.key === "artifact_archive_root")?.path
    || runbook.artifactArchiveRoot
    || runRecord.archiveRoot
    || "artifacts/staging/product/stable";
  const executionOrder = [
    ...(runbook.commandSequence || []).map((item) => item.key).filter(Boolean),
    "run_full_test_window",
    "production_signoff_review",
    "launch_day_watch",
    "stabilization_handoff"
  ];
  const bundleReady = environmentBinding.status === "ready_for_real_staging_binding"
    && runbook.status === "ready_for_real_staging_dry_run";
  return {
    status: bundleReady ? "ready_for_staging_rehearsal_bundle" : "blocked_until_rehearsal_inputs_ready",
    willModifyData: false,
    containsLiveWriteStep: runbook.containsLiveWriteStep === true,
    liveWriteRequiresApproval: runbook.liveWriteRequiresApproval === true,
    sourceStatuses: {
      environmentBinding: environmentBinding.status || null,
      executionRunbook: runbook.status || null,
      readinessTransition: transition.status || null
    },
    artifactArchiveRoot,
    files: environmentBinding.recommendedOutputFiles || [],
    commands: {
      stagingRehearsalDryRun: environmentBinding.dryRunCommand || null,
      routeMapGate: result.nextCommands?.launchRouteMapGate?.command || null,
      liveWriteSmoke: result.nextCommands?.launchSmoke || null,
      closeoutReload: transition.reloadStep?.command || result.closeoutBackfillGuide?.closeoutInputReload?.command || null,
      fullTestWindow: result.fullTestWindowReadiness?.command || closeout.fullTestWindowEntry?.command || "npm.cmd test"
    },
    executionOrder,
    closeout: {
      requiredKeys: (closeout.acceptanceChecks || []).map((item) => item.key).filter(Boolean),
      filledInputPath: fileByKey.get("filled_closeout_input")?.path || null,
      examplePath: fileByKey.get("filled_closeout_input_example")?.path || null,
      reloadCommand: transition.reloadStep?.command || result.closeoutBackfillGuide?.closeoutInputReload?.command || null,
      backfillTargets: runbook.closeoutBackfillTargets || []
    },
    readiness: {
      status: transition.status || null,
      gates: transition.gates || [],
      orderedNextActions: transition.orderedNextActions || [],
      nextAction: transition.nextAction || null
    },
    operatorRecord: {
      archiveRoot: runRecord.archiveRoot || artifactArchiveRoot,
      requiredRecordKeys: runRecord.requiredRecordKeys || [],
      recordCount: Array.isArray(runRecord.records) ? runRecord.records.length : 0,
      closeoutInputReloadCommand: runRecord.closeoutInputReloadCommand || null
    },
    extensionPoints: buildLaunchRehearsalExtensionPoints(),
    nextAction: bundleReady
      ? "Run the launch rehearsal bundle from executionOrder, keep artifact paths under artifactArchiveRoot, reload closeout input before the full test window, and use extensionPoints for incremental launch features."
      : "Complete staging environment binding and execution runbook generation before using this launch rehearsal bundle."
  };
}

function buildFinalRehearsalPacket(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const runTemplate = result.stagingRunRecordTemplate || buildStagingRunRecordTemplate(result);
  const filledExample = result.filledCloseoutInputExample || buildFilledCloseoutInputExample({
    ...result,
    stagingRunRecordTemplate: runTemplate
  });
  const archiveRoot = runTemplate.archiveRoot || "artifacts/staging/product/stable";
  const filledCloseoutInputPath = path.posix.join(archiveRoot, "filled-closeout-input.json");
  const sourceReadiness = runTemplate.sourceReadiness || {
    fullTestWindow: result.fullTestWindowReadiness?.status || "not_available",
    productionSignoff: result.productionSignoffReadiness?.status || "not_available",
    launchDayWatch: result.launchDayWatchPlan?.status || "not_available",
    stabilizationHandoff: result.stabilizationHandoffPlan?.status || "not_available"
  };
  const readyForLaunchDayWatch = sourceReadiness.fullTestWindow === "ready"
    && sourceReadiness.productionSignoff === "ready"
    && sourceReadiness.launchDayWatch === "ready"
    && sourceReadiness.stabilizationHandoff === "ready";
  const closeoutInputReview = result.stagingExecutionRunbook?.closeoutInputReview
    || summarizeCloseoutInputReview(result.closeoutInput?.backfillReview, closeout);
  const orderedSteps = [
    {
      key: "generate_rehearsal_outputs",
      status: "operator_generate",
      summary: "Generate or archive the Markdown handoff, closeout template, filled closeout input copy, and staging artifact record paths."
    },
    {
      key: "run_route_map_gate",
      status: "operator_execute",
      command: result.nextCommands?.launchRouteMapGate?.command || null,
      summary: "Run the targeted Launch Mainline / Launch Smoke / Developer Ops route-map gate before live writes."
    },
    {
      key: "run_backup_restore_drill",
      status: "operator_execute",
      commandKeys: Object.keys(result.nextCommands?.recovery || {}),
      summary: "Run backup and restore drill commands on a separate restore target."
    },
    {
      key: "run_live_write_smoke",
      status: "operator_execute",
      command: result.nextCommands?.launchSmoke || null,
      summary: "Run the HTTPS live-write staging smoke only after operator approval."
    },
    {
      key: "record_launch_mainline_evidence",
      status: "operator_execute",
      endpoint: result.evidenceActionPlan?.endpoint || null,
      summary: "Record Launch Mainline evidence receipts and attach redacted receipt IDs."
    },
    {
      key: "backfill_filled_closeout_input",
      status: "operator_backfill",
      path: filledCloseoutInputPath,
      summary: "Copy the example to the real filled closeout input path and replace every placeholder with redacted staging evidence."
    },
    {
      key: "reload_closeout_input",
      status: "operator_execute",
      command: filledExample.reloadCommand || null,
      closeoutInputReview,
      summary: "Reload the filled closeout input and verify readiness gaps narrow before the full test window."
    },
    {
      key: "run_full_test_window",
      status: "operator_execute",
      command: closeout.fullTestWindowEntry?.command || "npm.cmd test",
      summary: "Run the full repository test suite in the reserved test window after closeout reload."
    },
    {
      key: "production_signoff_review",
      status: "operator_review",
      requiredDecision: closeout.productionSignoffConditions?.requiredDecision || null,
      summary: "Review production sign-off evidence and receipt visibility before cutover."
    },
    {
      key: "launch_day_watch",
      status: "operator_watch",
      summary: "Start launch-day watch with Launch Mainline, Developer Ops, Launch Review, and Launch Smoke routes open."
    },
    {
      key: "stabilization_handoff",
      status: "operator_handoff",
      summary: "Hand off stabilization records, incidents, receipt snapshots, and rollback signals."
    }
  ];
  return {
    status: readyForLaunchDayWatch ? "ready_for_launch_day_watch" : "ready_for_operator_rehearsal",
    willModifyData: false,
    environmentBindingStatus: result.stagingEnvironmentBinding?.status || null,
    executionRunbookStatus: result.stagingExecutionRunbook?.status || null,
    readinessTransitionStatus: result.stagingReadinessTransition?.status || null,
    launchRehearsalBundleStatus: result.launchRehearsalBundle?.status || null,
    archiveRoot,
    sourceReadiness,
    closeoutInputReview,
    commands: {
      stagingRehearsalDryRun: result.stagingEnvironmentBinding?.dryRunCommand || null,
      routeMapGate: result.nextCommands?.launchRouteMapGate?.command || null,
      liveWriteSmoke: result.nextCommands?.launchSmoke || null,
      closeoutReload: filledExample.reloadCommand || null,
      fullTestWindow: closeout.fullTestWindowEntry?.command || "npm.cmd test"
    },
    localFiles: [
      {
        key: "handoff_file",
        path: result.handoffFile?.path || null,
        status: fileOutputStatus(result.handoffFile)
      },
      {
        key: "closeout_file",
        path: result.closeoutFile?.path || null,
        status: fileOutputStatus(result.closeoutFile)
      },
      {
        key: "run_record_index",
        path: result.runRecordFile?.path || null,
        status: fileOutputStatus(result.runRecordFile)
      },
      {
        key: "artifact_manifest",
        path: result.artifactManifestFile?.path || null,
        status: fileOutputStatus(result.artifactManifestFile)
      },
      {
        key: "closeout_reload_packet",
        path: result.closeoutReloadPacketFile?.path || null,
        status: fileOutputStatus(result.closeoutReloadPacketFile)
      },
      {
        key: "readiness_review_packet",
        path: result.readinessReviewPacketFile?.path || null,
        status: fileOutputStatus(result.readinessReviewPacketFile)
      },
      {
        key: "production_signoff_packet",
        path: result.productionSignoffPacketFile?.path || null,
        status: fileOutputStatus(result.productionSignoffPacketFile)
      },
      {
        key: "launch_duty_archive_index",
        path: result.launchDutyArchiveIndexFile?.path || null,
        status: fileOutputStatus(result.launchDutyArchiveIndexFile)
      },
      {
        key: "filled_closeout_input",
        path: filledCloseoutInputPath,
        status: "operator_copy_from_example"
      },
      {
        key: "filled_closeout_draft",
        path: result.filledCloseoutDraftFile?.path || result.filledCloseoutInputDraft?.saveAs || path.posix.join(archiveRoot, "filled-closeout-input.draft.json"),
        status: result.filledCloseoutDraftFile ? fileOutputStatus(result.filledCloseoutDraftFile) : "example_only"
      },
      {
        key: "filled_closeout_input_example",
        path: filledExample.saveAs || null,
        status: "example_only"
      },
      {
        key: "artifact_archive_root",
        path: archiveRoot,
        status: "operator_archive"
      }
    ],
    orderedSteps,
    nextAction: readyForLaunchDayWatch
      ? "Start launch-day watch and stabilization handoff with the packet artifacts open."
      : "Generate handoff and closeout files, run the ordered rehearsal steps, then reload the filled closeout input before the full test window."
  };
}

function buildCloseoutInput(closeoutInputFile, closeout = {}) {
  if (!closeoutInputFile) {
    return null;
  }
  const resolvedPath = path.resolve(repoRoot, closeoutInputFile);
  const payload = JSON.parse(readFileSync(resolvedPath, "utf8"));
  if (payload.exampleOnly === true || payload.mode === "staging-closeout-input-example") {
    throw new Error("Refusing to load example closeout input; copy it to a real filled closeout input file and replace placeholders first.");
  }
  const acceptanceFields = Array.isArray(payload.acceptanceFields) ? payload.acceptanceFields : [];
  const fieldsByKey = new Map(
    acceptanceFields
      .filter((field) => field && field.key)
      .map((field) => [field.key, field])
  );
  const requiredKeys = (closeout.acceptanceChecks || []).map((item) => item.key).filter(Boolean);
  const filledKeys = requiredKeys.filter((key) => isFilledCloseoutField(fieldsByKey.get(key)));
  const missingKeys = requiredKeys.filter((key) => !filledKeys.includes(key));
  const goNoGoField = fieldsByKey.get("operator_go_no_go");
  const decision = typeof goNoGoField?.value === "string"
    ? goNoGoField.value
    : payload.decision || closeout.decision || null;
  const signoffConditions = Array.isArray(payload.productionSignoff?.conditions)
    ? payload.productionSignoff.conditions
    : [];
  const signoffFieldsByKey = new Map(
    signoffConditions
      .filter((field) => field && field.key)
      .map((field) => [field.key, field])
  );
  const requiredSignoffKeys = (closeout.productionSignoffConditions?.conditions || [])
    .map((item) => item.key)
    .filter(Boolean);
  const signoffFilledKeys = requiredSignoffKeys.filter((key) => isFilledCloseoutField(signoffFieldsByKey.get(key)));
  const signoffMissingKeys = requiredSignoffKeys.filter((key) => !signoffFilledKeys.includes(key));
  const productionDecision = payload.productionSignoff?.decision || null;
  const receiptVisibility = payload.receiptVisibility || payload.productionSignoff?.receiptVisibility || {};
  const receiptVisibilityChecks = Object.fromEntries(
    RECEIPT_VISIBILITY_KEYS.map((key) => [
      key,
      {
        status: isReceiptVisibilityVisible(receiptVisibility[key]) ? "visible" : "missing"
      }
    ])
  );
  const missingReceiptVisibilityKeys = RECEIPT_VISIBILITY_KEYS.filter(
    (key) => receiptVisibilityChecks[key].status !== "visible"
  );
  const readyForReceiptVisibility = missingReceiptVisibilityKeys.length === 0;
  const readyForFullTestWindow = missingKeys.length === 0 && decision === "ready-for-full-test-window";
  const readyForProductionSignoff = readyForFullTestWindow
    && signoffMissingKeys.length === 0
    && productionDecision === closeout.productionSignoffConditions?.requiredDecision
    && readyForReceiptVisibility;
  const backfillReview = buildCloseoutInputBackfillReview(payload, closeout, {
    acceptanceFields,
    fieldsByKey,
    requiredKeys,
    decision
  });
  return {
    status: "loaded",
    path: resolvedPath,
    sourceMode: payload.mode || null,
    willModifyData: false,
    decision,
    fieldCount: acceptanceFields.length,
    requiredKeys,
    filledKeys,
    missingKeys,
    requiredSignoffKeys,
    signoffFilledKeys,
    signoffMissingKeys,
    productionDecision,
    receiptVisibilityStatus: readyForReceiptVisibility ? "visible" : "missing",
    receiptVisibilityChecks,
    missingReceiptVisibilityKeys,
    readyForFullTestWindow,
    readyForReceiptVisibility,
    readyForProductionSignoff,
    backfillReview,
    nextAction: missingKeys.length === 0
      ? "Closeout input is backfilled; confirm operator_go_no_go before entering the full test window."
      : "Backfill missingKeys in the closeout input before entering the full test window."
  };
}

function buildOperatorReadinessGaps(result, { closeout = {}, outputFiles = [] } = {}) {
  const outputStatus = new Map(outputFiles.map((item) => [item.key, item.status]));
  const closeoutInput = result.closeoutInput || null;
  const missingCloseoutKeys = closeoutInput?.missingKeys
    || (closeout.acceptanceChecks || []).map((item) => item.key).filter(Boolean);
  const hasEvidenceReceipts = Array.isArray(closeoutInput?.filledKeys)
    && closeoutInput.filledKeys.includes("launch_mainline_evidence_receipts");
  const gaps = [];
  if (outputStatus.get("handoff_file") === "not_requested") {
    gaps.push({
      key: "handoff_file_not_requested",
      severity: "warning",
      stepKey: "review_generated_bundle",
      summary: "No Markdown handoff file was requested for launch duty.",
      nextAction: "Re-run staging:rehearsal with --handoff-file before live-write smoke."
    });
  }
  if (outputStatus.get("closeout_file") === "not_requested") {
    gaps.push({
      key: "closeout_file_not_requested",
      severity: "warning",
      stepKey: "review_generated_bundle",
      summary: "No JSON closeout template was requested for operator backfill.",
      nextAction: "Re-run staging:rehearsal with --closeout-file before live-write smoke."
    });
  }
  if (result.evidenceReadiness?.checks?.developerBearerToken !== "present" && !hasEvidenceReceipts) {
    gaps.push({
      key: "developer_bearer_token_missing",
      severity: "blocker",
      stepKey: "record_launch_mainline_evidence",
      env: result.evidenceReadiness?.tokenEnv || DEVELOPER_BEARER_TOKEN_ENV,
      summary: "Launch Mainline evidence requests cannot run until the developer bearer token env var is set.",
      nextAction: `Set $env:${result.evidenceReadiness?.tokenEnv || DEVELOPER_BEARER_TOKEN_ENV} before copying evidence request snippets.`
    });
  }
  if (missingCloseoutKeys.length > 0 || closeoutInput?.readyForFullTestWindow !== true) {
    gaps.push({
      key: "closeout_backfill_pending",
      severity: "blocker",
      stepKey: "backfill_closeout_template",
      missingCloseoutKeys,
      summary: "Staging closeout is still waiting for redacted result values, artifact paths, receipt IDs, and operator_go_no_go.",
      nextAction: "Backfill every required closeout key before reserving the full test window."
    });
    gaps.push({
      key: "full_test_window_blocked",
      severity: "blocker",
      stepKey: "reserve_full_test_window",
      command: closeout.fullTestWindowEntry?.command || null,
      summary: "The full repository test window is blocked until closeout is backfilled.",
      nextAction: "Run the full test command only after operator_go_no_go is ready-for-full-test-window."
    });
  }
  const signoffConditionsReady = Array.isArray(closeoutInput?.signoffMissingKeys)
    && closeoutInput.signoffMissingKeys.length === 0;
  const productionDecisionReady = closeoutInput?.productionDecision === closeout.productionSignoffConditions?.requiredDecision;
  if (
    closeoutInput?.readyForFullTestWindow === true
    && signoffConditionsReady
    && productionDecisionReady
    && closeoutInput.readyForReceiptVisibility !== true
  ) {
    gaps.push({
      key: "receipt_visibility_not_confirmed",
      severity: "blocker",
      stepKey: "verify_receipt_visibility",
      missingReceiptVisibilityKeys: closeoutInput.missingReceiptVisibilityKeys || [],
      summary: "Production sign-off needs Launch Mainline, Launch Review, Launch Smoke, and Developer Ops receipt visibility confirmed.",
      nextAction: "Backfill receiptVisibility with visible statuses for every required lane before production sign-off review."
    });
  }
  if (closeoutInput?.readyForProductionSignoff !== true) {
    gaps.push({
      key: "production_signoff_blocked",
      severity: "blocker",
      stepKey: "production_signoff_review",
      requiredDecision: closeout.productionSignoffConditions?.requiredDecision || null,
      missingSignoffKeys: closeoutInput?.signoffMissingKeys || (closeout.productionSignoffConditions?.conditions || []).map((item) => item.key).filter(Boolean),
      missingReceiptVisibilityKeys: closeoutInput?.missingReceiptVisibilityKeys || RECEIPT_VISIBILITY_KEYS,
      summary: "Production sign-off is blocked until the full test window passes and sign-off evidence is attached.",
      nextAction: "Do not move to production cutover before production sign-off review is ready."
    });
  }
  return gaps;
}

function buildStagingOperatorExecutionPlan(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const evidenceOperations = Array.isArray(result.evidenceActionPlan?.items)
    ? result.evidenceActionPlan.items.map((item) => item.operation).filter(Boolean)
    : [];
  const outputFiles = [
    {
      key: "handoff_file",
      label: "Staging rehearsal Markdown handoff",
      status: fileOutputStatus(result.handoffFile),
      path: result.handoffFile?.path || null,
      purpose: "Carry commands, routes, evidence requests, and operator notes into the live-write step."
    },
    {
      key: "closeout_file",
      label: "Staging closeout JSON template",
      status: fileOutputStatus(result.closeoutFile),
      path: result.closeoutFile?.path || null,
      purpose: "Backfill redacted result values, artifact paths, receipt IDs, and go/no-go decision."
    },
    {
      key: "run_record_index",
      label: "Staging run record index JSON",
      status: fileOutputStatus(result.runRecordFile),
      path: result.runRecordFile?.path || null,
      purpose: "Archive the machine-readable record groups, missing keys, reload command, and next operator milestone."
    },
    {
      key: "artifact_manifest",
      label: "Staging artifact manifest JSON",
      status: fileOutputStatus(result.artifactManifestFile),
      path: result.artifactManifestFile?.path || null,
      purpose: "Bundle the generated artifact paths, file statuses, readiness state, and key commands for staging archive review."
    },
    {
      key: "closeout_reload_packet",
      label: "Staging closeout reload packet JSON",
      status: fileOutputStatus(result.closeoutReloadPacketFile),
      path: result.closeoutReloadPacketFile?.path || null,
      purpose: "Show how to promote the draft, backfill real evidence, reload closeout input, and review full-test readiness."
    },
    {
      key: "readiness_review_packet",
      label: "Staging readiness review packet JSON",
      status: fileOutputStatus(result.readinessReviewPacketFile),
      path: result.readinessReviewPacketFile?.path || null,
      purpose: "Summarize full-test, production sign-off, launch-day watch, and stabilization readiness after closeout reload."
    },
    {
      key: "production_signoff_packet",
      label: "Staging production sign-off packet JSON",
      status: fileOutputStatus(result.productionSignoffPacketFile),
      path: result.productionSignoffPacketFile?.path || null,
      purpose: "Centralize production sign-off decision, missing sign-off fields, receipt visibility, reload command, and launch-day watch entry."
    },
    {
      key: "launch_duty_archive_index",
      label: "Staging launch-duty archive index JSON",
      status: fileOutputStatus(result.launchDutyArchiveIndexFile),
      path: result.launchDutyArchiveIndexFile?.path || null,
      purpose: "List the core launch-duty packets, their statuses, archive paths, and handoff commands."
    },
    {
      key: "filled_closeout_draft",
      label: "Staging filled closeout input draft JSON",
      status: fileOutputStatus(result.filledCloseoutDraftFile),
      path: result.filledCloseoutDraftFile?.path || result.filledCloseoutInputDraft?.saveAs || null,
      purpose: "Copy this redacted draft to filled-closeout-input.json, replace null values with real evidence, remove exampleOnly, then reload closeout input."
    }
  ];
  const readinessGaps = buildOperatorReadinessGaps(result, { closeout, outputFiles });
  return {
    status: "ready_for_staging_execution",
    willModifyData: false,
    trigger: "no-write-rehearsal-gates-passed",
    outputFiles,
    readinessSummary: {
      status: readinessGaps.length ? "needs_operator_input" : "ready",
      gapCount: readinessGaps.length,
      canRunLiveWriteSmoke: false,
      canRunFullTestWindow: result.closeoutInput?.readyForFullTestWindow === true,
      canSignoffProduction: result.closeoutInput?.readyForProductionSignoff === true,
      nextAction: "Resolve readinessGaps in order before live-write smoke, full test window, or production sign-off."
    },
    readinessGaps,
    orderedSteps: [
      {
        key: "review_generated_bundle",
        order: 1,
        status: "operator_review",
        outputFileKeys: ["handoff_file", "closeout_file"],
        summary: "Review generated handoff and closeout template before touching staging data."
      },
      {
        key: "run_route_map_gate",
        order: 2,
        status: "operator_execute",
        command: result.nextCommands?.launchRouteMapGate?.command || null,
        dryRunCommand: result.nextCommands?.launchRouteMapGate?.dryRunCommand || null,
        closeoutKey: "route_map_gate_result",
        summary: "Run the repeatable Launch Mainline / Launch Smoke / Developer Ops route-map gate."
      },
      {
        key: "run_backup_restore_drill",
        order: 3,
        status: "operator_execute",
        commandKeys: Object.keys(result.nextCommands?.recovery || {}),
        closeoutKey: "backup_restore_drill_result",
        receiptOperations: ["record_recovery_drill", "record_backup_verification"],
        summary: "Run backup and restore drill on the intended restore target."
      },
      {
        key: "approve_and_run_live_write_smoke",
        order: 4,
        status: "operator_confirm_then_execute",
        command: result.nextCommands?.launchSmoke || null,
        closeoutKey: "live_write_smoke_result",
        receiptOperations: ["record_launch_rehearsal_run"],
        summary: "Confirm staging writes are approved, then run the live-write smoke command."
      },
      {
        key: "archive_launch_smoke_handoff",
        order: 5,
        status: "operator_archive",
        closeoutKey: "launch_smoke_handoff",
        summary: "Archive the redacted Launch Smoke handoff and generated test identifiers."
      },
      {
        key: "record_launch_mainline_evidence",
        order: 6,
        status: "operator_execute",
        endpoint: result.evidenceActionPlan?.endpoint || null,
        bearerTokenEnv: result.evidenceReadiness?.tokenEnv || DEVELOPER_BEARER_TOKEN_ENV,
        closeoutKey: "launch_mainline_evidence_receipts",
        evidenceOperations,
        summary: "Post Launch Mainline evidence actions and capture receipt IDs or handoff filenames."
      },
      {
        key: "verify_receipt_visibility",
        order: 7,
        status: "operator_review",
        downloads: result.nextCommands?.receiptVisibilitySummaries || null,
        closeoutKey: "receipt_visibility_review",
        summary: "Verify Launch Review and Launch Smoke visibility summaries show the recorded receipts."
      },
      {
        key: "backfill_closeout_template",
        order: 8,
        status: "operator_backfill",
        outputFileKey: "closeout_file",
        requiredCloseoutKeys: (closeout.acceptanceChecks || []).map((item) => item.key).filter(Boolean),
        summary: "Fill the closeout template with redacted statuses, artifact paths, receipt IDs, and operator_go_no_go."
      },
      {
        key: "reserve_full_test_window",
        order: 9,
        status: "operator_schedule",
        command: closeout.fullTestWindowEntry?.command || null,
        triggerDecision: closeout.fullTestWindowEntry?.triggerDecision || null,
        summary: "Reserve the full repository test window only after closeout is backfilled."
      },
      {
        key: "production_signoff_review",
        order: 10,
        status: "operator_review",
        requiredDecision: closeout.productionSignoffConditions?.requiredDecision || null,
        summary: "Attach production sign-off evidence before cutover."
      }
    ],
    requiredCloseoutKeys: (closeout.acceptanceChecks || []).map((item) => item.key).filter(Boolean),
    closeoutInput: result.closeoutInput || null,
    artifactArchiveRoot: closeout.artifactReceiptLedger?.archiveRoot || null,
    evidenceOperations,
    fullTestWindow: closeout.fullTestWindowEntry || null,
    productionSignoff: closeout.productionSignoffConditions || null,
    nextAction: "Run the ordered steps in sequence, then backfill closeout with redacted statuses, receipt IDs, and artifact paths before starting the full test window."
  };
}

function sanitizeArtifactPathSegment(value, fallback = "unknown") {
  const segment = String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return segment || fallback;
}

function buildStagingArtifactReceiptLedger(result) {
  const productCode = sanitizeArtifactPathSegment(result.summary?.productCode, "product");
  const channel = sanitizeArtifactPathSegment(result.summary?.channel || "stable", "stable");
  const archiveRoot = path.posix.join("artifacts", "staging", productCode, channel);
  const evidenceOperations = Array.isArray(result.evidenceActionPlan?.items)
    ? result.evidenceActionPlan.items.map((item) => item.operation).filter(Boolean)
    : [];
  const row = ({
    checkKey,
    artifactKey,
    fileName,
    receiptOperations = [],
    closeoutStatus = "pending",
    operatorNote = "",
    allowedDecisions = null
  }) => ({
    checkKey,
    artifactKey,
    artifactPath: path.posix.join(archiveRoot, fileName),
    receiptOperations,
    closeoutStatus,
    operatorNote,
    ...(allowedDecisions ? { allowedDecisions } : {})
  });
  return {
    status: "awaiting_staging_artifacts",
    willModifyData: false,
    archiveRoot,
    columns: [
      "check_key",
      "artifact_key",
      "artifact_path",
      "receipt_operations",
      "closeout_status",
      "operator_note"
    ],
    rows: [
      row({
        checkKey: "route_map_gate_result",
        artifactKey: "route_map_gate_output",
        fileName: "route-map-gate-output.txt",
        operatorNote: "Attach the targeted gate output after secrets have been redacted."
      }),
      row({
        checkKey: "backup_restore_drill_result",
        artifactKey: "backup_restore_drill_log",
        fileName: "backup-restore-drill.txt",
        receiptOperations: ["record_recovery_drill", "record_backup_verification"],
        operatorNote: "Record backup, restore dry-run, and healthcheck artifact paths."
      }),
      row({
        checkKey: "live_write_smoke_result",
        artifactKey: "live_write_smoke_output",
        fileName: "live-write-smoke-output.json",
        receiptOperations: ["record_launch_rehearsal_run"],
        operatorNote: "Attach the live-write smoke output with generated test identifiers only."
      }),
      row({
        checkKey: "launch_smoke_handoff",
        artifactKey: "launch_smoke_handoff",
        fileName: "launch-smoke-handoff.json",
        receiptOperations: ["record_post_launch_ops_sweep"],
        operatorNote: "Save the Launch Smoke handoff used by Launch Review, Developer Ops, and Launch Mainline."
      }),
      row({
        checkKey: "launch_mainline_evidence_receipts",
        artifactKey: "launch_mainline_evidence_receipts",
        fileName: "launch-mainline-evidence-receipts.json",
        receiptOperations: evidenceOperations,
        operatorNote: "List the Launch Mainline receipt IDs or handoff file names for every evidence action."
      }),
      row({
        checkKey: "receipt_visibility_review",
        artifactKey: "receipt_visibility_review",
        fileName: "receipt-visibility-review.txt",
        receiptOperations: ["record_post_launch_ops_sweep"],
        operatorNote: "Record the Launch Review and Launch Smoke visibility summary review result."
      }),
      row({
        checkKey: "operator_go_no_go",
        artifactKey: "operator_go_no_go",
        fileName: "operator-go-no-go.md",
        allowedDecisions: ["ready-for-full-test-window", "hold", "rollback-follow-up"],
        operatorNote: "Record the final staging decision, operator, timestamp, and reason."
      })
    ],
    operatorNote: "Keep artifact paths and receipt identifiers here; do not paste passwords, bearer tokens, or raw secret-bearing logs."
  };
}

function buildFullTestWindowEntry(result, acceptanceChecks = [], artifactReceiptLedger = null) {
  return {
    status: "blocked_until_staging_closeout",
    command: "npm.cmd test",
    willRunFullSuite: true,
    willModifyData: false,
    triggerDecision: "ready-for-full-test-window",
    requiredCloseoutKeys: acceptanceChecks.map((item) => item.key).filter(Boolean),
    archiveRoot: artifactReceiptLedger?.archiveRoot || null,
    entryCriteria: [
      {
        key: "staging_closeout_completed",
        status: "operator_confirm",
        summary: "All staging acceptance closeout checks have redacted results."
      },
      {
        key: "artifact_receipt_ledger_filled",
        status: "operator_confirm",
        summary: "Every required artifact path and Launch Mainline receipt operation is recorded."
      },
      {
        key: "operator_go_no_go_ready",
        status: "operator_confirm",
        summary: "Operator decision is ready-for-full-test-window, not hold or rollback-follow-up."
      },
      {
        key: "test_window_reserved",
        status: "operator_confirm",
        summary: "A quiet test window is reserved for the full repository suite and follow-up fixes."
      }
    ],
    nextAction: "Do not run the full suite until staging closeout is backfilled and operator_go_no_go is ready-for-full-test-window."
  };
}

function buildProductionSignoffConditions(result) {
  return {
    status: "blocked_until_full_test_window",
    requiredDecision: "ready-for-production-signoff",
    willModifyData: false,
    conditions: [
      {
        key: "full_test_window_passed",
        status: "required",
        evidence: "Attach the full `npm.cmd test` output summary and failure count."
      },
      {
        key: "staging_artifacts_archived",
        status: "required",
        evidence: "Confirm the artifact/receipt ledger archive paths exist and contain redacted artifacts."
      },
      {
        key: "launch_mainline_receipts_visible",
        status: "required",
        evidence: "Confirm Launch Mainline, Launch Review, Launch Smoke, and Developer Ops show the latest receipts."
      },
      {
        key: "backup_restore_drill_passed",
        status: "required",
        evidence: "Confirm the backup and restore drill passed on the intended staging storage profile."
      },
      {
        key: "rollback_path_confirmed",
        status: "required",
        evidence: "Confirm rollback walkthrough and recovery handoff are current before production cutover."
      },
      {
        key: "operator_signoff_recorded",
        status: "required",
        evidence: "Record operator, timestamp, decision, and reason in the go/no-go artifact."
      }
    ],
    nextAction: "Only move to production cutover after every condition is attached to the staging closeout and the full test window has passed."
  };
}

function buildStagingAcceptanceCloseout(result) {
  const resultBackfill = result.resultBackfillSummary || null;
  const evidenceOperations = Array.isArray(result.evidenceActionPlan?.items)
    ? result.evidenceActionPlan.items.map((item) => item.operation).filter(Boolean)
    : [];
  const artifactReceiptLedger = buildStagingArtifactReceiptLedger(result);
  const acceptanceChecks = [
    {
      key: "route_map_gate_result",
      label: "Route-map and download-surface targeted gate",
      required: true,
      command: result.nextCommands?.launchRouteMapGate?.command || null,
      expectedEvidence: "Record the targeted gate exit status, pass count, and redacted output artifact path."
    },
    {
      key: "backup_restore_drill_result",
      label: "Backup and restore drill",
      required: true,
      commandKeys: result.environmentReadiness?.checks?.find((item) => item.key === "backup_restore_drill")?.commandKeys || [],
      expectedEvidence: "Record backup artifact path, restore dry-run result, and post-restore healthcheck result."
    },
    {
      key: "live_write_smoke_result",
      label: "Live-write staging smoke",
      required: true,
      command: result.nextCommands?.launchSmoke || null,
      expectedEvidence: "Record smoke exit status, created test project/account/card identifiers, and the redacted smoke output artifact path."
    },
    {
      key: "launch_smoke_handoff",
      label: "Launch smoke handoff archive",
      required: true,
      expectedEvidence: "Save the launch smoke handoff JSON or Markdown path with passwords and bearer tokens redacted."
    },
    {
      key: "launch_mainline_evidence_receipts",
      label: "Launch Mainline evidence receipts",
      required: true,
      endpoint: result.evidenceActionPlan?.endpoint || null,
      operations: evidenceOperations,
      expectedEvidence: "Record the Launch Mainline receipt IDs or handoff file names produced by each evidence action."
    },
    {
      key: "receipt_visibility_review",
      label: "Receipt visibility review",
      required: true,
      downloads: result.nextCommands?.receiptVisibilitySummaries || null,
      expectedEvidence: "Verify Launch Review and Launch Smoke receipt-visibility summaries show the recorded first-wave receipt."
    },
    {
      key: "operator_go_no_go",
      label: "Operator go/no-go decision",
      required: true,
      expectedEvidence: "Record ready-for-full-test-window, hold, or rollback-follow-up with the operator name and timestamp."
    }
  ];
  return {
    status: "awaiting_operator_closeout",
    willModifyData: false,
    decision: "pending_staging_results",
    requiredResultKeys: resultBackfill?.requiredResultKeys || [],
    evidenceOperations,
    acceptanceChecks,
    destinations: {
      launchMainline: resultBackfill?.destinations?.launchMainline || result.nextCommands?.launchMainline || null,
      developerOps: resultBackfill?.destinations?.developerOps || null,
      evidenceEndpoint: result.evidenceActionPlan?.endpoint || null,
      receiptVisibilityDownloads: result.nextCommands?.receiptVisibilitySummaries || null
    },
    nextAction: "Run the real staging steps, backfill the redacted result values, then schedule the full repository test window before production sign-off.",
    operatorNote: "Use redacted result values only: statuses, receipt IDs, artifact paths, handoff file names, and operator decisions. Do not paste passwords or bearer tokens.",
    artifactReceiptLedger,
    fullTestWindowEntry: buildFullTestWindowEntry(result, acceptanceChecks, artifactReceiptLedger),
    productionSignoffConditions: buildProductionSignoffConditions(result)
  };
}

function buildResult(options) {
  const staging = runJsonScript("staging-preflight.mjs", buildStagingPreflightArgs(options));
  const recovery = runJsonScript("recovery-preflight.mjs", buildRecoveryPreflightArgs(options));
  const gatesPassed = staging?.status === "pass" && recovery?.status === "pass";
  const status = gatesPassed ? "pass" : "fail";
  const phaseStatus = {
    staging: staging?.status === "pass" ? "pass" : "fail",
    recovery: recovery?.status === "pass" ? "pass" : "fail",
    liveSmoke: gatesPassed ? "next" : "blocked",
    launchMainline: gatesPassed ? "next" : "blocked",
    evidence: gatesPassed ? "next" : "blocked"
  };
  const phases = buildPhases(phaseStatus);
  const launchMainline = gatesPassed
    ? buildRoute(options.baseUrl, "/developer/launch-mainline", {
      productCode: options.productCode,
      channel: options.channel,
      source: "staging-rehearsal",
      handoff: "first-wave"
    })
    : null;
  const evidenceActionPlan = gatesPassed ? buildEvidenceActionPlan(options) : null;
  const receiptVisibilitySummaries = gatesPassed ? buildReceiptVisibilitySummaryDownloads(options) : null;
  const launchRouteMapGate = gatesPassed ? buildLaunchRouteMapGateCommand() : null;
  const environmentReadiness = gatesPassed
    ? buildStagingEnvironmentReadiness(options, { recovery, launchRouteMapGate })
    : null;

  const result = {
    status,
    mode: "staging-rehearsal",
    generatedAt: new Date().toISOString(),
    summary: {
      baseUrl: options.baseUrl,
      productCode: options.productCode,
      channel: options.channel,
      targetOs: options.targetOs,
      storageProfile: options.storageProfile,
      willModifyData: false
    },
    stagingProfile: options.stagingProfile,
    stagingProfileLaunchPlan: buildStagingProfileLaunchPlan(options),
    preflights: {
      staging,
      recovery
    },
    phases,
    nextCommands: {
      launchSmoke: gatesPassed ? staging.nextCommand?.powershell || null : null,
      recovery: gatesPassed ? recovery.nextCommands || null : null,
      launchRouteMapGate,
      launchMainline,
      receiptVisibilitySummaries
    },
    evidenceOrder: gatesPassed ? EVIDENCE_ORDER : [],
    evidenceActionPlan,
    evidenceReadiness: gatesPassed ? buildEvidenceReadiness(options, evidenceActionPlan) : null,
    environmentReadiness,
    ...(options.handoffFile
      ? {
        handoffFile: {
          path: path.resolve(repoRoot, options.handoffFile),
          written: false
        }
      }
      : {}),
    ...(options.closeoutFile
      ? {
        closeoutFile: {
          path: path.resolve(repoRoot, options.closeoutFile),
          written: false
        }
      }
      : {}),
    ...(options.runRecordFile
      ? {
        runRecordFile: {
          path: path.resolve(repoRoot, options.runRecordFile),
          written: false
        }
      }
      : {}),
    ...(options.artifactManifestFile
      ? {
        artifactManifestFile: {
          path: path.resolve(repoRoot, options.artifactManifestFile),
          written: false
        }
      }
      : {}),
    ...(options.closeoutReloadPacketFile
      ? {
        closeoutReloadPacketFile: {
          path: path.resolve(repoRoot, options.closeoutReloadPacketFile),
          written: false
        }
      }
      : {}),
    ...(options.readinessReviewPacketFile
      ? {
        readinessReviewPacketFile: {
          path: path.resolve(repoRoot, options.readinessReviewPacketFile),
          written: false
        }
      }
      : {}),
    ...(options.productionSignoffPacketFile
      ? {
        productionSignoffPacketFile: {
          path: path.resolve(repoRoot, options.productionSignoffPacketFile),
          written: false
        }
      }
      : {}),
    ...(options.launchDutyArchiveIndexFile
      ? {
        launchDutyArchiveIndexFile: {
          path: path.resolve(repoRoot, options.launchDutyArchiveIndexFile),
          written: false
        }
      }
      : {}),
    ...(options.filledCloseoutDraftFile
      ? {
        filledCloseoutDraftFile: {
          path: path.resolve(repoRoot, options.filledCloseoutDraftFile),
          written: false
        }
      }
      : {}),
    ...(status === "fail"
      ? {
        failedPhase: firstFailedPhase(phases),
        error: {
          message: "A no-write rehearsal gate failed; live-write staging smoke remains blocked."
        }
      }
      : {})
  };
  const operatorChecklist = gatesPassed ? buildStagingOperatorChecklist(result) : [];
  const resultWithBackfill = {
    ...result,
    operatorChecklist,
    resultBackfillSummary: gatesPassed ? buildStagingResultBackfillSummary(result) : null
  };
  const resultWithCloseout = {
    ...resultWithBackfill,
    stagingAcceptanceCloseout: gatesPassed ? buildStagingAcceptanceCloseout(resultWithBackfill) : null
  };
  const closeoutInput = gatesPassed ? buildCloseoutInput(options.closeoutInputFile, resultWithCloseout.stagingAcceptanceCloseout) : null;
  const resultWithCloseoutInput = {
    ...resultWithCloseout,
    closeoutInput
  };
  const resultWithCloseoutBackfillGuide = {
    ...resultWithCloseoutInput,
    closeoutBackfillGuide: gatesPassed ? buildCloseoutBackfillGuide(resultWithCloseoutInput) : null
  };
  const resultWithFullTestWindowReadiness = {
    ...resultWithCloseoutBackfillGuide,
    fullTestWindowReadiness: gatesPassed ? buildFullTestWindowReadiness(resultWithCloseoutBackfillGuide) : null
  };
  const resultWithProductionSignoffReadiness = {
    ...resultWithFullTestWindowReadiness,
    productionSignoffReadiness: gatesPassed ? buildProductionSignoffReadiness(resultWithFullTestWindowReadiness) : null
  };
  const resultWithLaunchDayWatchPlan = {
    ...resultWithProductionSignoffReadiness,
    launchDayWatchPlan: gatesPassed ? buildLaunchDayWatchPlan(resultWithProductionSignoffReadiness) : null
  };
  const resultWithStabilizationHandoffPlan = {
    ...resultWithLaunchDayWatchPlan,
    stabilizationHandoffPlan: gatesPassed ? buildStabilizationHandoffPlan(resultWithLaunchDayWatchPlan) : null
  };
  const resultWithStagingRunRecordTemplate = {
    ...resultWithStabilizationHandoffPlan,
    stagingRunRecordTemplate: gatesPassed ? buildStagingRunRecordTemplate(resultWithStabilizationHandoffPlan) : null
  };
  const resultWithFilledCloseoutInputExample = {
    ...resultWithStagingRunRecordTemplate,
    filledCloseoutInputExample: gatesPassed ? buildFilledCloseoutInputExample(resultWithStagingRunRecordTemplate) : null
  };
  const resultWithFilledCloseoutInputDraft = {
    ...resultWithFilledCloseoutInputExample,
    filledCloseoutInputDraft: gatesPassed ? buildFilledCloseoutInputDraft(resultWithFilledCloseoutInputExample) : null
  };
  const resultWithStagingEnvironmentBinding = {
    ...resultWithFilledCloseoutInputDraft,
    stagingEnvironmentBinding: gatesPassed ? buildStagingEnvironmentBinding(resultWithFilledCloseoutInputDraft, options) : null
  };
  const resultWithStagingExecutionRunbook = {
    ...resultWithStagingEnvironmentBinding,
    stagingExecutionRunbook: gatesPassed ? buildStagingExecutionRunbook(resultWithStagingEnvironmentBinding) : null
  };
  const resultWithStagingProfileOperatorPreflight = {
    ...resultWithStagingExecutionRunbook,
    stagingProfileOperatorPreflight: gatesPassed ? buildStagingProfileOperatorPreflight(resultWithStagingExecutionRunbook) : null
  };
  const resultWithStagingReadinessTransition = {
    ...resultWithStagingProfileOperatorPreflight,
    stagingReadinessTransition: gatesPassed ? buildStagingReadinessTransition(resultWithStagingProfileOperatorPreflight) : null
  };
  const resultWithLaunchRehearsalBundle = {
    ...resultWithStagingReadinessTransition,
    launchRehearsalBundle: gatesPassed ? buildLaunchRehearsalBundle(resultWithStagingReadinessTransition) : null
  };
  const resultWithFinalRehearsalPacket = {
    ...resultWithLaunchRehearsalBundle,
    finalRehearsalPacket: gatesPassed ? buildFinalRehearsalPacket(resultWithLaunchRehearsalBundle) : null
  };
  const resultWithStagingRehearsalExecutionSummary = {
    ...resultWithFinalRehearsalPacket,
    stagingRehearsalExecutionSummary: gatesPassed ? buildStagingRehearsalExecutionSummary(resultWithFinalRehearsalPacket) : null
  };
  const resultWithStagingRehearsalRunRecordIndex = {
    ...resultWithStagingRehearsalExecutionSummary,
    stagingRehearsalRunRecordIndex: gatesPassed ? buildStagingRehearsalRunRecordIndex(resultWithStagingRehearsalExecutionSummary) : null
  };
  const resultWithStagingArtifactManifest = {
    ...resultWithStagingRehearsalRunRecordIndex,
    stagingArtifactManifest: gatesPassed ? buildStagingArtifactManifest(resultWithStagingRehearsalRunRecordIndex) : null
  };
  const resultWithStagingCloseoutReloadPacket = {
    ...resultWithStagingArtifactManifest,
    stagingCloseoutReloadPacket: gatesPassed ? buildStagingCloseoutReloadPacket(resultWithStagingArtifactManifest) : null
  };
  const resultWithStagingReadinessReviewPacket = {
    ...resultWithStagingCloseoutReloadPacket,
    stagingReadinessReviewPacket: gatesPassed ? buildStagingReadinessReviewPacket(resultWithStagingCloseoutReloadPacket) : null
  };
  const resultWithStagingProductionSignoffPacket = {
    ...resultWithStagingReadinessReviewPacket,
    stagingProductionSignoffPacket: gatesPassed ? buildStagingProductionSignoffPacket(resultWithStagingReadinessReviewPacket) : null
  };
  const resultWithStagingLaunchDutyArchiveIndex = {
    ...resultWithStagingProductionSignoffPacket,
    stagingLaunchDutyArchiveIndex: gatesPassed ? buildStagingLaunchDutyArchiveIndex(resultWithStagingProductionSignoffPacket) : null
  };
  return {
    ...resultWithStagingLaunchDutyArchiveIndex,
    operatorExecutionPlan: gatesPassed ? buildStagingOperatorExecutionPlan(resultWithStagingLaunchDutyArchiveIndex) : null
  };
}

function renderCommandList(commands) {
  if (!commands) {
    return "- Not available";
  }
  if (typeof commands === "string") {
    return `\`\`\`powershell\n${commands}\n\`\`\``;
  }
  return Object.entries(commands)
    .map(([key, value]) => `- ${key}: \`${value}\``)
    .join("\n");
}

function renderEvidenceActions(plan) {
  if (!plan) {
    return "- Not available";
  }
  return plan.items
    .map((item) => [
      `${item.order}. ${item.label} - \`${item.operation}\``,
      "",
      "```powershell",
      item.request.powershell,
      "```"
    ].join("\n"))
    .join("\n\n");
}

function renderEvidenceReadiness(readiness) {
  if (!readiness) {
    return "- Not available";
  }
  return [
    `- Ready to execute evidence requests: ${readiness.readyToExecute ? "yes" : "no"}`,
    `- Target lane: ${readiness.targetLane.productCode} / ${readiness.targetLane.channel}`,
    `- Evidence endpoint: ${readiness.endpoint}`,
    `- Developer bearer token env: ${readiness.tokenEnv}`,
    `- Developer bearer token status: ${readiness.checks.developerBearerToken}`,
    `- Next action: ${readiness.nextAction}`
  ].join("\n");
}

function renderReceiptVisibilitySummaries(downloads) {
  if (!downloads) {
    return "- Not available";
  }
  return [
    `- Launch Review summary: \`${downloads.launchReviewSummary}\``,
    `- Launch Smoke Kit summary: \`${downloads.launchSmokeSummary}\``
  ].join("\n");
}

function renderLaunchRouteMapGate(command) {
  if (!command) {
    return "- Not available";
  }
  return [
    `- Command: \`${command.command}\``,
    `- Dry run: \`${command.dryRunCommand}\``,
    `- Writes data: ${command.willModifyData ? "yes" : "no"}`,
    `- Runs full suite: ${command.willRunFullSuite ? "yes" : "no"}`,
    `- Purpose: ${command.purpose}`
  ].join("\n");
}

function renderStagingProfileLaunchPlan(plan) {
  if (!plan) {
    return "- Not available";
  }
  const lines = [
    `- Profile launch plan status: ${plan.status || "-"}`,
    `- Writes data by itself: ${plan.willModifyData ? "yes" : "no"}`,
    `- Profile file: ${plan.profileFile || "-"}`,
    `- CLI override keys: ${(plan.cliOverrideKeys || []).join(", ") || "-"}`,
    `- Missing required inputs: ${(plan.missingRequiredInputs || []).join(", ") || "-"}`,
    `- Missing output files: ${(plan.missingOutputFiles || []).join(", ") || "-"}`,
    `- Recommended command: \`${plan.recommendedCommand || "-"}\``,
    `- Next action: ${plan.nextAction || "-"}`
  ];
  if (Array.isArray(plan.requiredSecretEnv) && plan.requiredSecretEnv.length) {
    lines.push("- Required secret env:");
    for (const item of plan.requiredSecretEnv) {
      lines.push(`  - ${item.key || "-"}: ${item.present ? "set" : "missing"} ${item.phase || "-"}`);
    }
  }
  if (plan.backfillManifest) {
    lines.push(`- Backfill manifest: ${plan.backfillManifest.status || "-"}`);
    lines.push(`  - archiveRoot: ${plan.backfillManifest.archiveRoot || "-"}`);
    lines.push(`  - closeoutInputPath: ${plan.backfillManifest.closeoutInputPath || "-"}`);
    if (Array.isArray(plan.backfillManifest.rows) && plan.backfillManifest.rows.length) {
      lines.push("  - rows:");
      for (const row of plan.backfillManifest.rows) {
        lines.push(`    - ${row.closeoutKey || "-"}: ${row.sourceStep || "-"} -> ${row.artifactPath || "-"}`);
      }
    }
  }
  return lines.join("\n");
}

function renderStagingProfileOperatorPreflight(preflight) {
  if (!preflight) {
    return "- Not available";
  }
  const lines = [
    `- Profile preflight status: ${preflight.status || "-"}`,
    `- Writes data by itself: ${preflight.willModifyData ? "yes" : "no"}`,
    `- Profile status: ${preflight.profileStatus || "-"}`,
    `- Profile file: ${preflight.profileFile || "-"}`,
    `- Missing required inputs: ${(preflight.missingRequiredInputs || []).join(", ") || "-"}`,
    `- Missing output files: ${(preflight.missingOutputFiles || []).join(", ") || "-"}`,
    `- Missing secret env: ${(preflight.missingSecretEnv || []).join(", ") || "-"}`,
    `- Can run dry run: ${preflight.canRunDryRun ? "yes" : "no"}`,
    `- Can run live-write smoke: ${preflight.canRunLiveWriteSmoke ? "yes" : "no"}`,
    `- Can record evidence: ${preflight.canRecordEvidence ? "yes" : "no"}`,
    `- Command sequence: ${(preflight.commandSequence || []).join(", ") || "-"}`,
    `- Profile command: \`${preflight.commands?.profileDrivenRehearsal || "-"}\``,
    `- Staging dry run: \`${preflight.commands?.stagingDryRun || "-"}\``,
    `- Route-map gate: \`${preflight.commands?.routeMapGate || "-"}\``,
    `- Closeout reload: \`${preflight.commands?.closeoutReload || "-"}\``,
    `- Next action: ${preflight.nextAction || "-"}`
  ];
  if (Array.isArray(preflight.recommendedFiles) && preflight.recommendedFiles.length) {
    lines.push("- Recommended files:");
    for (const file of preflight.recommendedFiles) {
      lines.push(`  - ${file.key || "-"}: ${file.path || "-"} (${file.status || "-"})`);
    }
  }
  return lines.join("\n");
}

function renderStagingRehearsalExecutionSummary(summary) {
  if (!summary) {
    return "- Not available";
  }
  const focus = summary.operatorFocus || {};
  const statuses = summary.sourceStatuses || {};
  const lines = [
    `- Execution summary status: ${summary.status || "-"}`,
    `- Writes data by itself: ${summary.willModifyData ? "yes" : "no"}`,
    `- Source statuses: profilePreflight=${statuses.profilePreflight || "-"}, executionRunbook=${statuses.executionRunbook || "-"}, closeoutReview=${statuses.closeoutReview || "-"}, readinessTransition=${statuses.readinessTransition || "-"}, finalPacket=${statuses.finalPacket || "-"}`,
    `- Missing secret env: ${(focus.missingSecretEnv || []).join(", ") || "-"}`,
    `- Closeout review: ${statuses.closeoutReview || "-"} (missing=${focus.closeoutMissingFieldCount ?? 0})`,
    `- Can run dry run: ${focus.canRunDryRun ? "yes" : "no"}`,
    `- Can run live-write smoke: ${focus.canRunLiveWriteSmoke ? "yes" : "no"}`,
    `- Can record evidence: ${focus.canRecordEvidence ? "yes" : "no"}`,
    `- Can enter full test window: ${focus.canEnterFullTestWindow ? "yes" : "no"}`,
    `- Ordered next actions: ${(summary.orderedNextActions || []).join(", ") || "-"}`,
    `- Staging dry run: \`${summary.commands?.stagingDryRun || "-"}\``,
    `- Closeout reload: \`${summary.commands?.closeoutReload || "-"}\``,
    `- Next action: ${summary.nextAction || "-"}`
  ];
  if (Array.isArray(summary.blockingReasons) && summary.blockingReasons.length) {
    lines.push("- Blocking reasons:");
    for (const reason of summary.blockingReasons) {
      lines.push(`  - ${reason.key || "-"}: ${reason.status || "-"}`);
      if (Array.isArray(reason.missing) && reason.missing.length) {
        lines.push(`    - missing: ${reason.missing.join(", ")}`);
      }
      if (Array.isArray(reason.placeholderKeys) && reason.placeholderKeys.length) {
        lines.push(`    - placeholders: ${reason.placeholderKeys.join(", ")}`);
      }
      lines.push(`    - nextAction: ${reason.nextAction || "-"}`);
    }
  }
  return lines.join("\n");
}

function renderStagingEnvironmentReadiness(readiness) {
  if (!readiness) {
    return "- Not available";
  }
  const lines = [
    `- Status: ${readiness.status}`,
    `- Writes data: ${readiness.willModifyData ? "yes" : "no"}`,
    `- Next action: ${readiness.nextAction}`
  ];
  for (const check of readiness.checks || []) {
    lines.push(`- ${check.key}: ${check.status}`);
    lines.push(`  - Evidence: ${check.evidence || "-"}`);
    if (check.command) {
      lines.push(`  - Command: \`${check.command}\``);
    }
    if (check.dryRunCommand) {
      lines.push(`  - Dry run: \`${check.dryRunCommand}\``);
    }
    if (Array.isArray(check.commandKeys) && check.commandKeys.length) {
      lines.push(`  - Command keys: ${check.commandKeys.join(", ")}`);
    }
    lines.push(`  - Next action: ${check.nextAction || "-"}`);
  }
  return lines.join("\n");
}

function renderStagingOperatorChecklist(checklist = []) {
  if (!Array.isArray(checklist) || checklist.length === 0) {
    return "- Not available";
  }
  return checklist
    .map((item) => {
      const details = [
        `${item.order}. ${item.label}`,
        `   - status: ${item.status}`,
        `   - summary: ${item.summary}`
      ];
      if (item.command) {
        details.push(`   - command: \`${item.command}\``);
      }
      if (item.dryRunCommand) {
        details.push(`   - dryRun: \`${item.dryRunCommand}\``);
      }
      if (item.route) {
        details.push(`   - route: ${item.route}`);
      }
      if (item.endpoint) {
        details.push(`   - endpoint: ${item.endpoint}`);
      }
      if (Array.isArray(item.commandKeys) && item.commandKeys.length) {
        details.push(`   - commandKeys: ${item.commandKeys.join(", ")}`);
      }
      if (Array.isArray(item.evidenceOperations) && item.evidenceOperations.length) {
        details.push(`   - evidenceOperations: ${item.evidenceOperations.join(", ")}`);
      }
      return details.join("\n");
    })
    .join("\n");
}

function renderOperatorExecutionPlan(plan) {
  if (!plan) {
    return "- Not available";
  }
  const lines = [
    `- Status: ${plan.status || "-"}`,
    `- Writes data: ${plan.willModifyData ? "yes" : "no"}`,
    `- Trigger: ${plan.trigger || "-"}`,
    `- Artifact archive root: ${plan.artifactArchiveRoot || "-"}`,
    `- Required closeout keys: ${(plan.requiredCloseoutKeys || []).join(", ")}`,
    `- Evidence operations: ${(plan.evidenceOperations || []).join(", ")}`,
    `- Full test command: ${plan.fullTestWindow?.command || "-"}`,
    `- Production sign-off decision: ${plan.productionSignoff?.requiredDecision || "-"}`,
    `- Readiness status: ${plan.readinessSummary?.status || "-"}`,
    `- Readiness gap count: ${plan.readinessSummary?.gapCount ?? "-"}`,
    `- Next action: ${plan.nextAction || "-"}`
  ];
  if (Array.isArray(plan.outputFiles) && plan.outputFiles.length) {
    lines.push("- Output files:");
    for (const file of plan.outputFiles) {
      lines.push(`  - ${file.key || "-"}: ${file.status || "-"}`);
      lines.push(`    - path: ${file.path || "-"}`);
      lines.push(`    - purpose: ${file.purpose || "-"}`);
    }
  }
  if (Array.isArray(plan.readinessGaps) && plan.readinessGaps.length) {
    lines.push("- Readiness gaps:");
    for (const gap of plan.readinessGaps) {
      lines.push(`  - ${gap.key || "-"}: ${gap.severity || "-"}`);
      lines.push(`    - stepKey: ${gap.stepKey || "-"}`);
      lines.push(`    - summary: ${gap.summary || "-"}`);
      if (gap.command) {
        lines.push(`    - command: \`${gap.command}\``);
      }
      if (gap.env) {
        lines.push(`    - env: ${gap.env}`);
      }
      if (Array.isArray(gap.missingCloseoutKeys) && gap.missingCloseoutKeys.length) {
        lines.push(`    - missingCloseoutKeys: ${gap.missingCloseoutKeys.join(", ")}`);
      }
      if (Array.isArray(gap.missingSignoffKeys) && gap.missingSignoffKeys.length) {
        lines.push(`    - missingSignoffKeys: ${gap.missingSignoffKeys.join(", ")}`);
      }
      if (Array.isArray(gap.missingReceiptVisibilityKeys) && gap.missingReceiptVisibilityKeys.length) {
        lines.push(`    - missingReceiptVisibilityKeys: ${gap.missingReceiptVisibilityKeys.join(", ")}`);
      }
      lines.push(`    - nextAction: ${gap.nextAction || "-"}`);
    }
  }
  if (Array.isArray(plan.orderedSteps) && plan.orderedSteps.length) {
    lines.push("- Ordered steps:");
    for (const step of plan.orderedSteps) {
      lines.push(`  - ${step.order || "-"}: ${step.key || "-"}`);
      lines.push(`    - status: ${step.status || "-"}`);
      lines.push(`    - summary: ${step.summary || "-"}`);
      if (step.command) {
        lines.push(`    - command: \`${step.command}\``);
      }
      if (step.endpoint) {
        lines.push(`    - endpoint: ${step.endpoint}`);
      }
      if (step.closeoutKey) {
        lines.push(`    - closeoutKey: ${step.closeoutKey}`);
      }
    }
  }
  return lines.join("\n");
}

function renderStagingResultBackfillSummary(summary) {
  if (!summary) {
    return "- Not available";
  }
  return [
    `- Status: ${summary.status}`,
    `- Writes data: ${summary.willModifyData ? "yes" : "no"}`,
    `- Required result keys: ${(summary.requiredResultKeys || []).join(", ")}`,
    `- Launch Mainline: ${summary.destinations?.launchMainline || "-"}`,
    `- Developer Ops: ${summary.destinations?.developerOps || "-"}`,
    `- Evidence endpoint: ${summary.evidenceEndpoint || "-"}`,
    `- Launch Review visibility: ${summary.receiptVisibilityDownloads?.launchReviewSummary || "-"}`,
    `- Launch Smoke visibility: ${summary.receiptVisibilityDownloads?.launchSmokeSummary || "-"}`,
    `- Operator note: ${summary.operatorNote || "-"}`
  ].join("\n");
}

function renderStagingAcceptanceCloseout(closeout) {
  if (!closeout) {
    return "- Not available";
  }
  const lines = [
    `- Status: ${closeout.status}`,
    `- Decision: ${closeout.decision}`,
    `- Writes data: ${closeout.willModifyData ? "yes" : "no"}`,
    `- Required result keys: ${(closeout.requiredResultKeys || []).join(", ")}`,
    `- Evidence operations: ${(closeout.evidenceOperations || []).join(", ")}`,
    `- Launch Mainline: ${closeout.destinations?.launchMainline || "-"}`,
    `- Developer Ops: ${closeout.destinations?.developerOps || "-"}`,
    `- Evidence endpoint: ${closeout.destinations?.evidenceEndpoint || "-"}`,
    `- Launch Review visibility: ${closeout.destinations?.receiptVisibilityDownloads?.launchReviewSummary || "-"}`,
    `- Launch Smoke visibility: ${closeout.destinations?.receiptVisibilityDownloads?.launchSmokeSummary || "-"}`,
    `- Next action: ${closeout.nextAction || "-"}`,
    `- Operator note: ${closeout.operatorNote || "-"}`
  ];
  if (Array.isArray(closeout.acceptanceChecks) && closeout.acceptanceChecks.length) {
    lines.push("- Acceptance checks:");
    for (const check of closeout.acceptanceChecks) {
      lines.push(`  - ${check.key}: ${check.label || "-"}`);
      lines.push(`    - required: ${check.required ? "yes" : "no"}`);
      if (check.command) {
        lines.push(`    - command: \`${check.command}\``);
      }
      if (Array.isArray(check.commandKeys) && check.commandKeys.length) {
        lines.push(`    - commandKeys: ${check.commandKeys.join(", ")}`);
      }
      if (check.endpoint) {
        lines.push(`    - endpoint: ${check.endpoint}`);
      }
      if (Array.isArray(check.operations) && check.operations.length) {
        lines.push(`    - operations: ${check.operations.join(", ")}`);
      }
      if (check.downloads) {
        lines.push(`    - launchReviewVisibility: ${check.downloads.launchReviewSummary || "-"}`);
        lines.push(`    - launchSmokeVisibility: ${check.downloads.launchSmokeSummary || "-"}`);
      }
      lines.push(`    - expectedEvidence: ${check.expectedEvidence || "-"}`);
    }
  }
  return lines.join("\n");
}

function renderCloseoutBackfillGuide(guide) {
  if (!guide) {
    return "- Not available";
  }
  return [
    `- Status: ${guide.status || "-"}`,
    `- Writes data: ${guide.willModifyData ? "yes" : "no"}`,
    `- Closeout input reload: \`${guide.closeoutInputReload?.command || "-"}\``,
    `- Ordered backfill keys: ${(guide.orderedBackfillKeys || []).join(", ")}`,
    `- Receipt visibility keys: ${(guide.receiptVisibilityKeys || []).join(", ")}`,
    `- Production sign-off keys: ${(guide.productionSignoffKeys || []).join(", ")}`,
    `- Full test window command: \`${guide.fullTestWindow?.command || "-"}\``,
    `- Full test window decision: ${guide.fullTestWindow?.requiredDecision || "-"}`,
    `- Production sign-off decision: ${guide.productionSignoff?.requiredDecision || "-"}`,
    `- Next action: ${guide.nextAction || "-"}`
  ].join("\n");
}

function renderCloseoutInputBackfillReview(review) {
  const safeReview = review || buildCloseoutInputBackfillReview(null, {});
  const lines = [
    `- Review status: ${safeReview.status || "-"}`,
    `- Source mode: ${safeReview.sourceMode || "-"}`,
    `- Draft promotion: ${safeReview.draftPromotionStatus || "-"}`,
    `- Required fields: ${safeReview.requiredFieldCount ?? 0}`,
    `- Filled fields: ${safeReview.filledFieldCount ?? 0}`,
    `- Missing fields: ${safeReview.missingFieldCount ?? 0}`,
    `- Decision: ${safeReview.decision || "-"}`,
    `- Safe to enter full test window: ${safeReview.safeToEnterFullTestWindow ? "yes" : "no"}`,
    `- Next action: ${safeReview.nextAction || "-"}`
  ];
  if (Array.isArray(safeReview.missingFields) && safeReview.missingFields.length) {
    lines.push("- Missing field details:");
    for (const field of safeReview.missingFields) {
      lines.push(`  - ${field.key || "-"}: ${field.sourceStep || "-"} -> ${field.artifactPath || "-"}`);
      lines.push(`    - nextAction: ${field.nextAction || "-"}`);
    }
  }
  return lines.join("\n");
}

function renderArtifactReceiptLedger(ledger) {
  if (!ledger) {
    return "- Not available";
  }
  const lines = [
    `- Status: ${ledger.status || "-"}`,
    `- Writes data: ${ledger.willModifyData ? "yes" : "no"}`,
    `- Archive root: ${ledger.archiveRoot || "-"}`,
    `- Columns: ${(ledger.columns || []).join(", ")}`,
    `- Operator note: ${ledger.operatorNote || "-"}`
  ];
  if (Array.isArray(ledger.rows) && ledger.rows.length) {
    lines.push("- Rows:");
    for (const item of ledger.rows) {
      lines.push(`  - ${item.checkKey || "-"} -> ${item.artifactKey || "-"}`);
      lines.push(`    - artifactPath: ${item.artifactPath || "-"}`);
      lines.push(`    - receiptOperations: ${(item.receiptOperations || []).join(", ") || "-"}`);
      if (Array.isArray(item.allowedDecisions) && item.allowedDecisions.length) {
        lines.push(`    - allowedDecisions: ${item.allowedDecisions.join(", ")}`);
      }
      lines.push(`    - closeoutStatus: ${item.closeoutStatus || "-"}`);
      lines.push(`    - operatorNote: ${item.operatorNote || "-"}`);
    }
  }
  return lines.join("\n");
}

function renderFullTestWindowEntry(entry) {
  if (!entry) {
    return "- Not available";
  }
  const lines = [
    `- Status: ${entry.status || "-"}`,
    `- Command: \`${entry.command || "-"}\``,
    `- Runs full suite: ${entry.willRunFullSuite ? "yes" : "no"}`,
    `- Writes data: ${entry.willModifyData ? "yes" : "no"}`,
    `- Trigger decision: ${entry.triggerDecision || "-"}`,
    `- Required closeout keys: ${(entry.requiredCloseoutKeys || []).join(", ")}`,
    `- Archive root: ${entry.archiveRoot || "-"}`,
    `- Next action: ${entry.nextAction || "-"}`
  ];
  if (Array.isArray(entry.entryCriteria) && entry.entryCriteria.length) {
    lines.push("- Entry criteria:");
    for (const item of entry.entryCriteria) {
      lines.push(`  - ${item.key || "-"}: ${item.status || "-"}`);
      lines.push(`    - summary: ${item.summary || "-"}`);
    }
  }
  return lines.join("\n");
}

function renderFullTestWindowReadiness(readiness) {
  if (!readiness) {
    return "- Not available";
  }
  return [
    `- Status: ${readiness.status || "-"}`,
    `- Can run: ${readiness.canRun ? "yes" : "no"}`,
    `- Command: \`${readiness.command || "-"}\``,
    `- Runs full suite: ${readiness.willRunFullSuite ? "yes" : "no"}`,
    `- Writes data: ${readiness.willModifyData ? "yes" : "no"}`,
    `- Required decision: ${readiness.requiredDecision || "-"}`,
    `- Closeout input status: ${readiness.closeoutInputStatus || "-"}`,
    `- Missing closeout keys: ${(readiness.missingCloseoutKeys || []).join(", ") || "-"}`,
    `- Reload command: \`${readiness.reloadCommand || "-"}\``,
    `- Next action: ${readiness.nextAction || "-"}`
  ].join("\n");
}

function renderProductionSignoffReadiness(readiness) {
  if (!readiness) {
    return "- Not available";
  }
  return [
    `- Status: ${readiness.status || "-"}`,
    `- Can sign off: ${readiness.canSignoff ? "yes" : "no"}`,
    `- Required decision: ${readiness.requiredDecision || "-"}`,
    `- Production decision: ${readiness.productionDecision || "-"}`,
    `- Closeout input status: ${readiness.closeoutInputStatus || "-"}`,
    `- Full test window ready: ${readiness.readyForFullTestWindow ? "yes" : "no"}`,
    `- Missing sign-off keys: ${(readiness.missingSignoffKeys || []).join(", ") || "-"}`,
    `- Missing receipt visibility keys: ${(readiness.missingReceiptVisibilityKeys || []).join(", ") || "-"}`,
    `- Reload command: \`${readiness.reloadCommand || "-"}\``,
    `- Next action: ${readiness.nextAction || "-"}`
  ].join("\n");
}

function renderStagingProductionSignoffPacket(packet) {
  if (!packet) {
    return "- Not available";
  }
  const decision = packet.decision || {};
  const lines = [
    `- Packet status: ${packet.status || "-"}`,
    `- Writes data by itself: ${packet.willModifyData ? "yes" : "no"}`,
    `- Archive root: ${packet.archiveRoot || "-"}`,
    `- Packet file: ${packet.packetFile || "-"}`,
    `- Closeout input: ${packet.closeoutInputPath || "-"}`,
    `- Required decision: ${decision.requiredDecision || "-"}`,
    `- Production decision: ${decision.productionDecision || "-"}`,
    `- Can sign off: ${decision.canSignoff ? "yes" : "no"}`,
    `- Full test window ready: ${decision.readyForFullTestWindow ? "yes" : "no"}`,
    `- Missing sign-off keys: ${(packet.missingSignoffKeys || []).join(", ") || "-"}`,
    `- Missing receipt visibility keys: ${(packet.missingReceiptVisibilityKeys || []).join(", ") || "-"}`,
    `- Closeout reload: \`${packet.commands?.closeoutReload || "-"}\``,
    `- Full test window: \`${packet.commands?.fullTestWindow || "-"}\``,
    `- Next action: ${packet.nextAction || "-"}`
  ];
  if (Array.isArray(packet.operatorSteps) && packet.operatorSteps.length) {
    lines.push("- Operator steps:");
    for (const step of packet.operatorSteps) {
      lines.push(`  - ${step.key || "-"}: ${step.status || "-"}`);
    }
  }
  return lines.join("\n");
}

function renderLaunchDayWatchPlan(plan) {
  if (!plan) {
    return "- Not available";
  }
  const routes = plan.routes || {};
  const watchWindows = Array.isArray(plan.watchWindows) ? plan.watchWindows : [];
  const lines = [
    `- Status: ${plan.status || "-"}`,
    `- Can start cutover watch: ${plan.canStartCutoverWatch ? "yes" : "no"}`,
    `- Watch start gate: ${plan.watchStartGate || "-"}`,
    `- Required decision: ${plan.requiredDecision || "-"}`,
    `- Production decision: ${plan.productionDecision || "-"}`,
    `- Closeout input status: ${plan.closeoutInputStatus || "-"}`,
    `- Missing sign-off keys: ${(plan.missingSignoffKeys || []).join(", ") || "-"}`,
    `- Missing receipt visibility keys: ${(plan.missingReceiptVisibilityKeys || []).join(", ") || "-"}`,
    `- Launch Mainline: ${routes.launchMainline || "-"}`,
    `- Developer Ops: ${routes.developerOps || "-"}`,
    `- Launch Review summary: ${routes.launchReviewSummary || "-"}`,
    `- Launch Smoke summary: ${routes.launchSmokeSummary || "-"}`,
    `- Watch windows: ${watchWindows.map((item) => item.key).filter(Boolean).join(", ") || "-"}`,
    `- Escalation triggers: ${(plan.escalationTriggers || []).join(", ") || "-"}`,
    `- Next action: ${plan.nextAction || "-"}`
  ];
  for (const item of watchWindows) {
    lines.push(`  - ${item.key || "-"}: ${item.status || "-"}`);
    lines.push(`    - window: ${item.window || "-"}`);
    lines.push(`    - summary: ${item.summary || "-"}`);
  }
  return lines.join("\n");
}

function renderStabilizationHandoffPlan(plan) {
  if (!plan) {
    return "- Not available";
  }
  const routes = plan.routes || {};
  const handoffWindows = Array.isArray(plan.handoffWindows) ? plan.handoffWindows : [];
  const lines = [
    `- Status: ${plan.status || "-"}`,
    `- Can start stabilization handoff: ${plan.canStartStabilizationHandoff ? "yes" : "no"}`,
    `- Source watch status: ${plan.sourceWatchStatus || "-"}`,
    `- Required watch windows: ${(plan.requiredWatchWindows || []).join(", ") || "-"}`,
    `- Required evidence keys: ${(plan.requiredEvidenceKeys || []).join(", ") || "-"}`,
    `- Launch Mainline: ${routes.launchMainline || "-"}`,
    `- Developer Ops: ${routes.developerOps || "-"}`,
    `- Launch Review summary: ${routes.launchReviewSummary || "-"}`,
    `- Launch Smoke summary: ${routes.launchSmokeSummary || "-"}`,
    `- Handoff windows: ${handoffWindows.map((item) => item.label || item.key).filter(Boolean).join(", ") || "-"}`,
    `- Escalation triggers: ${(plan.escalationTriggers || []).join(", ") || "-"}`,
    `- Next action: ${plan.nextAction || "-"}`
  ];
  for (const item of handoffWindows) {
    lines.push(`  - ${item.key || "-"}: ${item.status || "-"}`);
    lines.push(`    - label: ${item.label || "-"}`);
    lines.push(`    - summary: ${item.summary || "-"}`);
  }
  return lines.join("\n");
}

function renderStagingRunRecordTemplate(template) {
  if (!template) {
    return "- Not available";
  }
  const lines = [
    `- Status: ${template.status || "-"}`,
    `- Writes data: ${template.willModifyData ? "yes" : "no"}`,
    `- Archive root: ${template.archiveRoot || "-"}`,
    `- Closeout reload: \`${template.closeoutInputReloadCommand || "-"}\``,
    `- Source readiness: fullTestWindow=${template.sourceReadiness?.fullTestWindow || "-"}, productionSignoff=${template.sourceReadiness?.productionSignoff || "-"}, launchDayWatch=${template.sourceReadiness?.launchDayWatch || "-"}, stabilizationHandoff=${template.sourceReadiness?.stabilizationHandoff || "-"}`,
    `- Required record keys: ${(template.requiredRecordKeys || []).join(", ") || "-"}`,
    `- Operator note: ${template.operatorNote || "-"}`
  ];
  if (Array.isArray(template.records) && template.records.length) {
    lines.push("- Records:");
    for (const record of template.records) {
      lines.push(`  - ${record.key || "-"}: ${record.artifactPath || "-"}`);
      lines.push(`    - sourcePlan: ${record.sourcePlan || "-"}`);
      lines.push(`    - receiptOperations: ${(record.receiptOperations || []).join(", ") || "-"}`);
      lines.push(`    - operatorNote: ${record.operatorNote || "-"}`);
    }
  }
  return lines.join("\n");
}

function renderFilledCloseoutInputExample(example) {
  if (!example) {
    return "- Not available";
  }
  return [
    `- Status: ${example.status || "-"}`,
    `- Example only: ${example.exampleOnly ? "yes" : "no"}`,
    `- Save as: ${example.saveAs || "-"}`,
    `- Reload command: \`${example.reloadCommand || "-"}\``,
    `- Do not submit without replacing placeholders: ${example.doNotSubmitWithoutReplacingPlaceholders ? "yes" : "no"}`,
    `- Acceptance field keys: ${(example.acceptanceFields || []).map((item) => item.key).join(", ") || "-"}`,
    `- Receipt visibility keys: ${Object.keys(example.receiptVisibility || {}).join(", ") || "-"}`,
    `- Production sign-off decision: ${example.productionSignoff?.decision || "-"}`,
    `- Operator note: ${example.operatorNote || "-"}`
  ].join("\n");
}

function renderFilledCloseoutInputDraft(draft) {
  if (!draft) {
    return "- Not available";
  }
  const lines = [
    `- Draft status: ${draft.status || "-"}`,
    `- Example only: ${draft.exampleOnly ? "yes" : "no"}`,
    `- Source: ${draft.source || "-"}`,
    `- Save as: ${draft.saveAs || "-"}`,
    `- Copy to: ${draft.copyTo || "-"}`,
    `- Reload command: \`${draft.reloadCommand || "-"}\``,
    `- Do not submit without replacing placeholders: ${draft.doNotSubmitWithoutReplacingPlaceholders ? "yes" : "no"}`,
    `- Next action: ${draft.nextAction || "-"}`
  ];
  if (Array.isArray(draft.acceptanceFields) && draft.acceptanceFields.length) {
    lines.push("- Draft fields:");
    for (const field of draft.acceptanceFields) {
      lines.push(`  - ${field.key || "-"}: ${field.sourceStep || "-"} -> ${field.artifactPath || "-"}`);
    }
  }
  return lines.join("\n");
}

function renderStagingRehearsalRunRecordIndex(index) {
  if (!index) {
    return "- Not available";
  }
  const statuses = index.sourceStatuses || {};
  const closeout = index.closeoutProgress || {};
  const signoff = index.signoffProgress || {};
  const lines = [
    `- Run record index status: ${index.status || "-"}`,
    `- Writes data by itself: ${index.willModifyData ? "yes" : "no"}`,
    `- Archive root: ${index.archiveRoot || "-"}`,
    `- Source statuses: runRecordTemplate=${statuses.runRecordTemplate || "-"}, executionSummary=${statuses.executionSummary || "-"}, finalPacket=${statuses.finalPacket || "-"}, closeoutInput=${statuses.closeoutInput || "-"}`,
    `- Total records: ${index.recordCount ?? 0}`,
    `- Closeout progress: missing=${closeout.missingRecordCount ?? 0}, filled=${(closeout.filledRecordKeys || []).length}`,
    `- Missing closeout keys: ${(closeout.missingRecordKeys || []).join(", ") || "-"}`,
    `- Closeout input path: \`${closeout.closeoutInputPath || "-"}\``,
    `- Reload command: \`${closeout.reloadCommand || "-"}\``,
    `- Sign-off progress: missing=${(signoff.missingSignoffKeys || []).length}, receiptVisibilityMissing=${(signoff.missingReceiptVisibilityKeys || []).length}`,
    `- Ordered milestones: ${(index.orderedOperatorMilestones || []).join(", ") || "-"}`,
    "- Record groups:"
  ];
  for (const group of index.recordGroups || []) {
    lines.push(`  - ${group.key || "-"}: ${group.status || "-"} (records=${group.recordCount ?? 0})`);
    if (Array.isArray(group.missingRecordKeys) && group.missingRecordKeys.length) {
      lines.push(`    - missingRecordKeys: ${group.missingRecordKeys.join(", ")}`);
    }
    if (Array.isArray(group.missingSignoffKeys) && group.missingSignoffKeys.length) {
      lines.push(`    - missingSignoffKeys: ${group.missingSignoffKeys.join(", ")}`);
    }
    if (Array.isArray(group.missingReceiptVisibilityKeys) && group.missingReceiptVisibilityKeys.length) {
      lines.push(`    - missingReceiptVisibilityKeys: ${group.missingReceiptVisibilityKeys.join(", ")}`);
    }
  }
  lines.push(`- Next action: ${index.nextAction || "-"}`);
  return lines.join("\n");
}

function renderStagingEnvironmentBinding(binding) {
  if (!binding) {
    return "- Not available";
  }
  const fileByKey = new Map((binding.recommendedOutputFiles || []).map((item) => [item.key, item]));
  return [
    `- Binding status: ${binding.status || "-"}`,
    `- Writes data: ${binding.willModifyData ? "yes" : "no"}`,
    `- Base URL: ${binding.environment?.baseUrl || "-"}`,
    `- Product code: ${binding.environment?.productCode || "-"}`,
    `- Channel: ${binding.environment?.channel || "-"}`,
    `- Target OS: ${binding.environment?.targetOs || "-"}`,
    `- Storage profile: ${binding.environment?.storageProfile || "-"}`,
    `- Target env file: ${binding.environment?.targetEnvFile || "-"}`,
    `- App backup dir: ${binding.environment?.appBackupDir || "-"}`,
    `- Postgres backup dir: ${binding.environment?.postgresBackupDir || "-"}`,
    `- Admin password env: ${binding.credentialEnv?.adminPassword || "-"}`,
    `- Developer password env: ${binding.credentialEnv?.developerPassword || "-"}`,
    `- Developer bearer token env: ${binding.credentialEnv?.developerBearerToken || "-"}`,
    `- Handoff file: ${fileByKey.get("handoff_file")?.path || "-"}`,
    `- Closeout file: ${fileByKey.get("closeout_file")?.path || "-"}`,
    `- Production sign-off packet: ${fileByKey.get("production_signoff_packet")?.path || "-"}`,
    `- Filled closeout input: ${fileByKey.get("filled_closeout_input")?.path || "-"}`,
    `- Artifact archive root: ${fileByKey.get("artifact_archive_root")?.path || "-"}`,
    `- Dry run command: \`${binding.dryRunCommand || "-"}\``,
    `- Next action: ${binding.nextAction || "-"}`
  ].join("\n");
}

function renderStagingExecutionRunbook(runbook) {
  if (!runbook) {
    return "- Not available";
  }
  const review = runbook.closeoutInputReview || {};
  const lines = [
    `- Runbook status: ${runbook.status || "-"}`,
    `- Writes data by itself: ${runbook.willModifyData ? "yes" : "no"}`,
    `- Contains live-write step: ${runbook.containsLiveWriteStep ? "yes" : "no"}`,
    `- Live-write requires approval: ${runbook.liveWriteRequiresApproval ? "yes" : "no"}`,
    `- Source binding status: ${runbook.sourceBindingStatus || "-"}`,
    `- Artifact archive root: ${runbook.artifactArchiveRoot || "-"}`,
    `- Command sequence: ${(runbook.commandSequence || []).map((item) => item.key).join(", ") || "-"}`,
    `- Closeout review: ${review.status || "-"} (missing=${review.missingFieldCount ?? 0}, safeForFullTest=${review.safeToEnterFullTestWindow ? "yes" : "no"})`,
    `- Next action: ${runbook.nextAction || "-"}`
  ];
  if (Array.isArray(review.placeholderKeys) && review.placeholderKeys.length) {
    lines.push(`- Closeout placeholders: ${review.placeholderKeys.join(", ")}`);
  }
  if (Array.isArray(runbook.closeoutBackfillTargets) && runbook.closeoutBackfillTargets.length) {
    lines.push("- Closeout backfill targets:");
    for (const target of runbook.closeoutBackfillTargets) {
      lines.push(`  - ${target.key || "-"}: ${target.sourceStep || "-"} -> ${target.artifactPath || "-"}`);
      lines.push(`    - receiptOperations: ${(target.receiptOperations || []).join(", ") || "-"}`);
    }
  }
  return lines.join("\n");
}

function renderStagingReadinessTransition(transition) {
  if (!transition) {
    return "- Not available";
  }
  const lines = [
    `- Transition status: ${transition.status || "-"}`,
    `- Writes data: ${transition.willModifyData ? "yes" : "no"}`,
    `- Source runbook status: ${transition.sourceRunbookStatus || "-"}`,
    `- Closeout input status: ${transition.closeoutInputStatus || "-"}`,
    `- Reload command: \`${transition.reloadStep?.command || "-"}\``,
    `- Ordered next actions: ${(transition.orderedNextActions || []).join(", ") || "-"}`,
    `- Next action: ${transition.nextAction || "-"}`
  ];
  if (Array.isArray(transition.gates) && transition.gates.length) {
    lines.push("- Gates:");
    for (const gate of transition.gates) {
      lines.push(`  - ${gate.key || "-"}: ${gate.status || "-"} (canEnter=${gate.canEnter ? "yes" : "no"})`);
      if (gate.command) {
        lines.push(`    - command: \`${gate.command}\``);
      }
      if (Array.isArray(gate.missingCloseoutKeys) && gate.missingCloseoutKeys.length) {
        lines.push(`    - missingCloseoutKeys: ${gate.missingCloseoutKeys.join(", ")}`);
      }
      if (Array.isArray(gate.missingSignoffKeys) && gate.missingSignoffKeys.length) {
        lines.push(`    - missingSignoffKeys: ${gate.missingSignoffKeys.join(", ")}`);
      }
      if (Array.isArray(gate.missingReceiptVisibilityKeys) && gate.missingReceiptVisibilityKeys.length) {
        lines.push(`    - missingReceiptVisibilityKeys: ${gate.missingReceiptVisibilityKeys.join(", ")}`);
      }
    }
  }
  return lines.join("\n");
}

function renderLaunchRehearsalBundle(bundle) {
  if (!bundle) {
    return "- Not available";
  }
  const lines = [
    `- Bundle status: ${bundle.status || "-"}`,
    `- Writes data by itself: ${bundle.willModifyData ? "yes" : "no"}`,
    `- Contains live-write step: ${bundle.containsLiveWriteStep ? "yes" : "no"}`,
    `- Live-write requires approval: ${bundle.liveWriteRequiresApproval ? "yes" : "no"}`,
    `- Readiness transition: ${bundle.sourceStatuses?.readinessTransition || "-"}`,
    `- Artifact archive root: ${bundle.artifactArchiveRoot || "-"}`,
    `- Dry run: \`${bundle.commands?.stagingRehearsalDryRun || "-"}\``,
    `- Route-map gate: \`${bundle.commands?.routeMapGate || "-"}\``,
    `- Live-write smoke: \`${bundle.commands?.liveWriteSmoke || "-"}\``,
    `- Closeout reload: \`${bundle.commands?.closeoutReload || "-"}\``,
    `- Full test window: \`${bundle.commands?.fullTestWindow || "-"}\``,
    `- Execution order: ${(bundle.executionOrder || []).join(", ") || "-"}`,
    `- Extension status: ${bundle.extensionPoints?.status || "-"}`,
    `- Extension workflow: ${(bundle.extensionPoints?.extensionWorkflow || []).join(", ") || "-"}`,
    `- Next action: ${bundle.nextAction || "-"}`
  ];
  if (Array.isArray(bundle.extensionPoints?.supportedAdditions) && bundle.extensionPoints.supportedAdditions.length) {
    lines.push("- Extension points:");
    for (const point of bundle.extensionPoints.supportedAdditions) {
      lines.push(`  - ${point.key || "-"}: ${point.builder || "-"}`);
    }
  }
  if (Array.isArray(bundle.files) && bundle.files.length) {
    lines.push("- Files:");
    for (const file of bundle.files) {
      lines.push(`  - ${file.key || "-"}: ${file.path || "-"}`);
    }
  }
  if (Array.isArray(bundle.closeout?.backfillTargets) && bundle.closeout.backfillTargets.length) {
    lines.push("- Closeout targets:");
    for (const target of bundle.closeout.backfillTargets) {
      lines.push(`  - ${target.key || "-"} -> ${target.artifactPath || "-"}`);
    }
  }
  return lines.join("\n");
}

function renderFinalRehearsalPacket(packet) {
  if (!packet) {
    return "- Not available";
  }
  const fileByKey = new Map((packet.localFiles || []).map((item) => [item.key, item]));
  const review = packet.closeoutInputReview || {};
  return [
    `- Packet status: ${packet.status || "-"}`,
    `- Writes data: ${packet.willModifyData ? "yes" : "no"}`,
    `- Environment binding status: ${packet.environmentBindingStatus || "-"}`,
    `- Execution runbook status: ${packet.executionRunbookStatus || "-"}`,
    `- Readiness transition status: ${packet.readinessTransitionStatus || "-"}`,
    `- Launch rehearsal bundle status: ${packet.launchRehearsalBundleStatus || "-"}`,
    `- Archive root: ${packet.archiveRoot || "-"}`,
    `- Staging rehearsal dry run: \`${packet.commands?.stagingRehearsalDryRun || "-"}\``,
    `- Route-map gate: \`${packet.commands?.routeMapGate || "-"}\``,
    `- Live-write smoke: \`${packet.commands?.liveWriteSmoke || "-"}\``,
    `- Closeout reload: \`${packet.commands?.closeoutReload || "-"}\``,
    `- Full test window: \`${packet.commands?.fullTestWindow || "-"}\``,
    `- Handoff file: ${fileByKey.get("handoff_file")?.path || "-"}`,
    `- Closeout file: ${fileByKey.get("closeout_file")?.path || "-"}`,
    `- Filled closeout input: ${fileByKey.get("filled_closeout_input")?.path || "-"}`,
    `- Filled closeout input example: ${fileByKey.get("filled_closeout_input_example")?.path || "-"}`,
    `- Source readiness: fullTestWindow=${packet.sourceReadiness?.fullTestWindow || "-"}, productionSignoff=${packet.sourceReadiness?.productionSignoff || "-"}, launchDayWatch=${packet.sourceReadiness?.launchDayWatch || "-"}, stabilizationHandoff=${packet.sourceReadiness?.stabilizationHandoff || "-"}`,
    `- Closeout review: ${review.status || "-"} (missing=${review.missingFieldCount ?? 0}, safeForFullTest=${review.safeToEnterFullTestWindow ? "yes" : "no"})`,
    `- Ordered packet steps: ${(packet.orderedSteps || []).map((item) => item.key).join(", ") || "-"}`,
    `- Next action: ${packet.nextAction || "-"}`
  ].join("\n");
}

function renderProductionSignoffConditions(signoff) {
  if (!signoff) {
    return "- Not available";
  }
  const lines = [
    `- Status: ${signoff.status || "-"}`,
    `- Required decision: ${signoff.requiredDecision || "-"}`,
    `- Writes data: ${signoff.willModifyData ? "yes" : "no"}`,
    `- Next action: ${signoff.nextAction || "-"}`
  ];
  if (Array.isArray(signoff.conditions) && signoff.conditions.length) {
    lines.push("- Conditions:");
    for (const item of signoff.conditions) {
      lines.push(`  - ${item.key || "-"}: ${item.status || "-"}`);
      lines.push(`    - evidence: ${item.evidence || "-"}`);
    }
  }
  return lines.join("\n");
}

function renderHandoffFile(result) {
  return [
    "# Staging Rehearsal Handoff",
    "",
    `Generated at: ${result.generatedAt}`,
    "",
    "## Lane",
    "",
    `- Base URL: ${result.summary.baseUrl}`,
    `- Product code: ${result.summary.productCode}`,
    `- Channel: ${result.summary.channel}`,
    `- Target OS: ${result.summary.targetOs}`,
    `- Storage profile: ${result.summary.storageProfile}`,
    `- Rehearsal writes data: ${result.summary.willModifyData ? "yes" : "no"}`,
    `- Staging profile: ${result.stagingProfile?.loaded ? result.stagingProfile.file : "not loaded"}`,
    `- Profile keys: ${(result.stagingProfile?.providedKeys || []).join(", ") || "-"}`,
    "",
    "## Staging Profile Launch Plan",
    "",
    renderStagingProfileLaunchPlan(result.stagingProfileLaunchPlan),
    "",
    "## Staging Profile Operator Preflight",
    "",
    renderStagingProfileOperatorPreflight(result.stagingProfileOperatorPreflight),
    "",
    "## Staging Rehearsal Execution Summary",
    "",
    renderStagingRehearsalExecutionSummary(result.stagingRehearsalExecutionSummary),
    "",
    "## Gate Status",
    "",
    result.phases.map((phase) => `- ${phase.key}: ${phase.status}`).join("\n"),
    "",
    "## Next Live-Write Smoke Command",
    "",
    renderCommandList(result.nextCommands.launchSmoke),
    "",
    "## Recovery Commands",
    "",
    renderCommandList(result.nextCommands.recovery),
    "",
    "## Launch Mainline",
    "",
    result.nextCommands.launchMainline || "Not available",
    "",
    "## Launch Route Map Targeted Gate",
    "",
    renderLaunchRouteMapGate(result.nextCommands.launchRouteMapGate),
    "",
    "## Receipt Visibility Summary Downloads",
    "",
    renderReceiptVisibilitySummaries(result.nextCommands.receiptVisibilitySummaries),
    "",
    "## Staging Environment Readiness",
    "",
    renderStagingEnvironmentReadiness(result.environmentReadiness),
    "",
    "## Staging Operator Checklist",
    "",
    renderStagingOperatorChecklist(result.operatorChecklist),
    "",
    "## Operator Execution Plan",
    "",
    renderOperatorExecutionPlan(result.operatorExecutionPlan),
    "",
    "## Staging Result Backfill Summary",
    "",
    renderStagingResultBackfillSummary(result.resultBackfillSummary),
    "",
    "## Staging Acceptance Closeout",
    "",
    renderStagingAcceptanceCloseout(result.stagingAcceptanceCloseout),
    "",
    "## Closeout Backfill Guide",
    "",
    renderCloseoutBackfillGuide(result.closeoutBackfillGuide),
    "",
    "## Loaded Closeout Input Review",
    "",
    renderCloseoutInputBackfillReview(result.closeoutInput?.backfillReview),
    "",
    "## Artifact / Receipt Ledger",
    "",
    renderArtifactReceiptLedger(result.stagingAcceptanceCloseout?.artifactReceiptLedger),
    "",
    "## Full Test Window Entry",
    "",
    renderFullTestWindowEntry(result.stagingAcceptanceCloseout?.fullTestWindowEntry),
    "",
    "## Full Test Window Readiness",
    "",
    renderFullTestWindowReadiness(result.fullTestWindowReadiness),
    "",
    "## Production Sign-Off Readiness",
    "",
    renderProductionSignoffReadiness(result.productionSignoffReadiness),
    "",
    "## Staging Production Sign-Off Packet",
    "",
    renderStagingProductionSignoffPacket(result.stagingProductionSignoffPacket),
    "",
    "## Launch Day Watch Plan",
    "",
    renderLaunchDayWatchPlan(result.launchDayWatchPlan),
    "",
    "## Stabilization Handoff Plan",
    "",
    renderStabilizationHandoffPlan(result.stabilizationHandoffPlan),
    "",
    "## Staging Run Record Template",
    "",
    renderStagingRunRecordTemplate(result.stagingRunRecordTemplate),
    "",
    "## Staging Rehearsal Run Record Index",
    "",
    renderStagingRehearsalRunRecordIndex(result.stagingRehearsalRunRecordIndex),
    "",
    "## Staging Environment Binding",
    "",
    renderStagingEnvironmentBinding(result.stagingEnvironmentBinding),
    "",
    "## Staging Execution Runbook",
    "",
    renderStagingExecutionRunbook(result.stagingExecutionRunbook),
    "",
    "## Staging Readiness Transition",
    "",
    renderStagingReadinessTransition(result.stagingReadinessTransition),
    "",
    "## Launch Rehearsal Bundle",
    "",
    renderLaunchRehearsalBundle(result.launchRehearsalBundle),
    "",
    "## Filled Closeout Input Example",
    "",
    renderFilledCloseoutInputExample(result.filledCloseoutInputExample),
    "",
    "## Filled Closeout Input Draft",
    "",
    renderFilledCloseoutInputDraft(result.filledCloseoutInputDraft),
    "",
    "## Final Rehearsal Packet",
    "",
    renderFinalRehearsalPacket(result.finalRehearsalPacket),
    "",
    "## Production Sign-Off Conditions",
    "",
    renderProductionSignoffConditions(result.stagingAcceptanceCloseout?.productionSignoffConditions),
    "",
    "## Evidence Readiness",
    "",
    renderEvidenceReadiness(result.evidenceReadiness),
    "",
    "## Evidence Action Plan",
    "",
    `Endpoint: ${result.evidenceActionPlan?.endpoint || "Not available"}`,
    `Method: ${result.evidenceActionPlan?.method || "Not available"}`,
    `Will modify data: ${result.evidenceActionPlan?.willModifyData ? "yes" : "no"}`,
    "",
    renderEvidenceActions(result.evidenceActionPlan),
    "",
    "## Handling Notes",
    "",
    "- This file is generated only after no-write rehearsal gates pass.",
    "- Password values stay in environment variables and are not written to this handoff.",
    "- Run the live-write smoke command only when launch duty intentionally allows staging writes.",
    ""
  ].join("\n");
}

function buildCloseoutTemplate(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const ledger = closeout.artifactReceiptLedger || {};
  const ledgerRowsByKey = new Map((ledger.rows || []).map((row) => [row.checkKey, row]));
  return {
    mode: "staging-closeout-template",
    source: "staging-rehearsal",
    generatedAt: result.generatedAt,
    status: closeout.status || "not_available",
    decision: closeout.decision || "pending_staging_results",
    willModifyData: false,
    baseUrl: result.summary?.baseUrl || null,
    productCode: result.summary?.productCode || null,
    channel: result.summary?.channel || null,
    targetOs: result.summary?.targetOs || null,
    storageProfile: result.summary?.storageProfile || null,
    stagingProfile: result.stagingProfile || summarizeStagingProfile(null),
    stagingProfileLaunchPlan: result.stagingProfileLaunchPlan || null,
    stagingProfileOperatorPreflight: result.stagingProfileOperatorPreflight || buildStagingProfileOperatorPreflight(result),
    stagingRehearsalExecutionSummary: result.stagingRehearsalExecutionSummary || buildStagingRehearsalExecutionSummary(result),
    stagingRehearsalRunRecordIndex: result.stagingRehearsalRunRecordIndex || buildStagingRehearsalRunRecordIndex(result),
    stagingArtifactManifest: result.stagingArtifactManifest || buildStagingArtifactManifest(result),
    stagingCloseoutReloadPacket: result.stagingCloseoutReloadPacket || buildStagingCloseoutReloadPacket(result),
    stagingReadinessReviewPacket: result.stagingReadinessReviewPacket || buildStagingReadinessReviewPacket(result),
    stagingProductionSignoffPacket: result.stagingProductionSignoffPacket || buildStagingProductionSignoffPacket(result),
    stagingLaunchDutyArchiveIndex: result.stagingLaunchDutyArchiveIndex || buildStagingLaunchDutyArchiveIndex(result),
    requiredResultKeys: closeout.requiredResultKeys || [],
    evidenceOperations: closeout.evidenceOperations || [],
    archiveRoot: ledger.archiveRoot || null,
    acceptanceFields: (closeout.acceptanceChecks || []).map((check) => {
      const row = ledgerRowsByKey.get(check.key) || {};
      return {
        key: check.key,
        label: check.label || null,
        required: check.required === true,
        status: "pending_operator_entry",
        value: null,
        expectedEvidence: check.expectedEvidence || null,
        command: check.command || null,
        commandKeys: check.commandKeys || null,
        endpoint: check.endpoint || null,
        operations: check.operations || null,
        downloads: check.downloads || null,
        artifactKey: row.artifactKey || null,
        artifactPath: row.artifactPath || null,
        receiptOperations: row.receiptOperations || [],
        allowedDecisions: row.allowedDecisions || null,
        operatorNote: row.operatorNote || null
      };
    }),
    resultBackfillSummary: result.resultBackfillSummary || null,
    artifactReceiptLedger: ledger,
    receiptVisibility: buildReceiptVisibilityTemplate(),
    productionSignoff: buildProductionSignoffInputTemplate(closeout.productionSignoffConditions || {}),
    closeoutBackfillGuide: result.closeoutBackfillGuide || buildCloseoutBackfillGuide(result),
    closeoutInputReview: result.closeoutInput?.backfillReview || buildCloseoutInputBackfillReview(null, closeout),
    fullTestWindowReadiness: result.fullTestWindowReadiness || buildFullTestWindowReadiness(result),
    productionSignoffReadiness: result.productionSignoffReadiness || buildProductionSignoffReadiness(result),
    launchDayWatchPlan: result.launchDayWatchPlan || buildLaunchDayWatchPlan(result),
    stabilizationHandoffPlan: result.stabilizationHandoffPlan || buildStabilizationHandoffPlan(result),
    stagingRunRecordTemplate: result.stagingRunRecordTemplate || buildStagingRunRecordTemplate(result),
    stagingEnvironmentBinding: result.stagingEnvironmentBinding || null,
    stagingExecutionRunbook: result.stagingExecutionRunbook || null,
    stagingReadinessTransition: result.stagingReadinessTransition || null,
    launchRehearsalBundle: result.launchRehearsalBundle || null,
    filledCloseoutInputExample: result.filledCloseoutInputExample || buildFilledCloseoutInputExample(result),
    filledCloseoutInputDraft: result.filledCloseoutInputDraft || buildFilledCloseoutInputDraft(result),
    finalRehearsalPacket: result.finalRehearsalPacket || buildFinalRehearsalPacket(result),
    closeoutInput: result.closeoutInput || null,
    operatorExecutionPlan: result.operatorExecutionPlan || null,
    fullTestWindowEntry: closeout.fullTestWindowEntry || null,
    productionSignoffConditions: closeout.productionSignoffConditions || null,
    destinations: closeout.destinations || null,
    nextCommands: {
      launchSmoke: result.nextCommands?.launchSmoke || null,
      recovery: result.nextCommands?.recovery || null,
      launchRouteMapGate: result.nextCommands?.launchRouteMapGate || null,
      launchMainline: result.nextCommands?.launchMainline || null,
      receiptVisibilitySummaries: result.nextCommands?.receiptVisibilitySummaries || null
    },
    operatorChecklist: result.operatorChecklist || [],
    operatorNote: closeout.operatorNote || null,
    nextAction: closeout.nextAction || null
  };
}

function writeHandoffFile(result) {
  if (!result.handoffFile) {
    return result;
  }
  if (result.status !== "pass") {
    return result;
  }

  const nextResult = {
    ...result,
    handoffFile: {
      ...result.handoffFile,
      written: true
    }
  };
  mkdirSync(path.dirname(result.handoffFile.path), { recursive: true });
  writeFileSync(result.handoffFile.path, renderHandoffFile(refreshOperatorExecutionPlan(nextResult)), "utf8");
  return nextResult;
}

function writeCloseoutFile(result) {
  if (!result.closeoutFile) {
    return result;
  }
  if (result.status !== "pass") {
    return result;
  }

  const nextResult = {
    ...result,
    closeoutFile: {
      ...result.closeoutFile,
      written: true
    }
  };
  mkdirSync(path.dirname(result.closeoutFile.path), { recursive: true });
  writeFileSync(result.closeoutFile.path, `${JSON.stringify(buildCloseoutTemplate(refreshOperatorExecutionPlan(nextResult)), null, 2)}\n`, "utf8");
  return nextResult;
}

function writeRunRecordFile(result) {
  if (!result.runRecordFile) {
    return result;
  }
  if (result.status !== "pass") {
    return result;
  }

  const nextResult = {
    ...result,
    runRecordFile: {
      ...result.runRecordFile,
      written: true
    }
  };
  mkdirSync(path.dirname(result.runRecordFile.path), { recursive: true });
  writeFileSync(result.runRecordFile.path, `${JSON.stringify(result.stagingRehearsalRunRecordIndex, null, 2)}\n`, "utf8");
  return nextResult;
}

function writeArtifactManifestFile(result) {
  if (!result.artifactManifestFile) {
    return result;
  }
  if (result.status !== "pass") {
    return result;
  }

  const nextResult = {
    ...result,
    artifactManifestFile: {
      ...result.artifactManifestFile,
      written: true
    }
  };
  mkdirSync(path.dirname(result.artifactManifestFile.path), { recursive: true });
  writeFileSync(result.artifactManifestFile.path, `${JSON.stringify(result.stagingArtifactManifest, null, 2)}\n`, "utf8");
  return nextResult;
}

function writeCloseoutReloadPacketFile(result) {
  if (!result.closeoutReloadPacketFile) {
    return result;
  }
  if (result.status !== "pass") {
    return result;
  }

  const nextResult = {
    ...result,
    closeoutReloadPacketFile: {
      ...result.closeoutReloadPacketFile,
      written: true
    }
  };
  mkdirSync(path.dirname(result.closeoutReloadPacketFile.path), { recursive: true });
  writeFileSync(result.closeoutReloadPacketFile.path, `${JSON.stringify(result.stagingCloseoutReloadPacket, null, 2)}\n`, "utf8");
  return nextResult;
}

function writeReadinessReviewPacketFile(result) {
  if (!result.readinessReviewPacketFile) {
    return result;
  }
  if (result.status !== "pass") {
    return result;
  }

  const nextResult = {
    ...result,
    readinessReviewPacketFile: {
      ...result.readinessReviewPacketFile,
      written: true
    }
  };
  mkdirSync(path.dirname(result.readinessReviewPacketFile.path), { recursive: true });
  writeFileSync(result.readinessReviewPacketFile.path, `${JSON.stringify(result.stagingReadinessReviewPacket, null, 2)}\n`, "utf8");
  return nextResult;
}

function writeProductionSignoffPacketFile(result) {
  if (!result.productionSignoffPacketFile) {
    return result;
  }
  if (result.status !== "pass") {
    return result;
  }

  const nextResult = {
    ...result,
    productionSignoffPacketFile: {
      ...result.productionSignoffPacketFile,
      written: true
    }
  };
  mkdirSync(path.dirname(result.productionSignoffPacketFile.path), { recursive: true });
  writeFileSync(result.productionSignoffPacketFile.path, `${JSON.stringify(result.stagingProductionSignoffPacket, null, 2)}\n`, "utf8");
  return nextResult;
}

function writeLaunchDutyArchiveIndexFile(result) {
  if (!result.launchDutyArchiveIndexFile) {
    return result;
  }
  if (result.status !== "pass") {
    return result;
  }

  const nextResult = {
    ...result,
    launchDutyArchiveIndexFile: {
      ...result.launchDutyArchiveIndexFile,
      written: true
    }
  };
  mkdirSync(path.dirname(result.launchDutyArchiveIndexFile.path), { recursive: true });
  writeFileSync(result.launchDutyArchiveIndexFile.path, `${JSON.stringify(result.stagingLaunchDutyArchiveIndex, null, 2)}\n`, "utf8");
  return nextResult;
}

function writeFilledCloseoutDraftFile(result) {
  if (!result.filledCloseoutDraftFile) {
    return result;
  }
  if (result.status !== "pass") {
    return result;
  }

  const nextResult = {
    ...result,
    filledCloseoutDraftFile: {
      ...result.filledCloseoutDraftFile,
      written: true
    }
  };
  mkdirSync(path.dirname(result.filledCloseoutDraftFile.path), { recursive: true });
  writeFileSync(result.filledCloseoutDraftFile.path, `${JSON.stringify(result.filledCloseoutInputDraft, null, 2)}\n`, "utf8");
  return nextResult;
}

function refreshOperatorExecutionPlan(result) {
  if (!result.operatorExecutionPlan) {
    return result;
  }
  return {
    ...result,
    operatorExecutionPlan: buildStagingOperatorExecutionPlan(result)
  };
}

function writeOutputFiles(result) {
  return refreshOperatorExecutionPlan(
    writeLaunchDutyArchiveIndexFile(
      writeProductionSignoffPacketFile(
        writeReadinessReviewPacketFile(
          writeCloseoutReloadPacketFile(
            writeArtifactManifestFile(
              writeFilledCloseoutDraftFile(
                writeRunRecordFile(
                  writeCloseoutFile(
                    writeHandoffFile(result)
                  )
                )
              )
            )
          )
        )
      )
    )
  );
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.status === "pass") {
    console.log("Staging rehearsal gates passed. No data was modified.");
    console.log(result.nextCommands.launchSmoke);
    console.log(result.nextCommands.launchRouteMapGate?.command || "");
    console.log(result.nextCommands.launchMainline);
    console.log(result.environmentReadiness?.nextAction || "");
    console.log(result.nextCommands.receiptVisibilitySummaries?.launchReviewSummary || "");
    console.log(result.nextCommands.receiptVisibilitySummaries?.launchSmokeSummary || "");
    return;
  }

  console.error(`Staging rehearsal blocked: ${result.error.message}`);
  if (result.failedPhase) {
    console.error(`Failed phase: ${result.failedPhase.key}`);
  }
}

function main() {
  let json = process.argv.includes("--json");
  try {
    const options = parseArgs(process.argv.slice(2));
    json = options.json;
    const result = writeOutputFiles(buildResult(options));
    writeResult(result, json);
    if (result.status !== "pass") {
      process.exitCode = 1;
    }
  } catch (error) {
    const result = {
      status: "fail",
      mode: "staging-rehearsal",
      generatedAt: new Date().toISOString(),
      summary: {
        willModifyData: false
      },
      stagingProfile: {
        loaded: false,
        file: null,
        providedKeys: [],
        secretPolicy: "passwords_and_bearer_tokens_must_come_from_environment_or_cli"
      },
      preflights: {
        staging: null,
        recovery: null
      },
      phases: [],
      nextCommands: {
        launchSmoke: null,
        recovery: null,
        launchMainline: null
      },
      evidenceOrder: [],
      error: {
        message: error.message
      }
    };
    writeResult(result, json);
    process.exitCode = 1;
  }
}

main();
