#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildProductionSwitchBackupRestoreDrillProof,
  buildProductionSwitchPublicHttpsProof,
  buildProductionSwitchSecretEnvProof,
  buildProductionSwitchStorageProfileProof
} from "./staging-proof-utils.mjs";

const ADMIN_PASSWORD_ENV = "RSL_SMOKE_ADMIN_PASSWORD";
const DEVELOPER_PASSWORD_ENV = "RSL_SMOKE_DEVELOPER_PASSWORD";
const DEVELOPER_BEARER_TOKEN_ENV = "RSL_DEVELOPER_BEARER_TOKEN";

const SECRET_FLAGS = new Set([
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
  "--admin-username": "adminUsername",
  "--developer-username": "developerUsername",
  "--target-os": "targetOs",
  "--storage-profile": "storageProfile",
  "--target-env-file": "targetEnvFile",
  "--app-backup-dir": "appBackupDir",
  "--postgres-backup-dir": "postgresBackupDir",
  "--output-file": "outputFile"
};

const REQUIRED_FIELDS = [
  "baseUrl",
  "productCode",
  "adminUsername",
  "developerUsername",
  "targetOs",
  "storageProfile",
  "targetEnvFile",
  "appBackupDir"
];

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

function parseArgs(argv) {
  const options = {
    json: false,
    channel: "stable"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }

    const [name, inlineValue] = arg.split("=", 2);
    if (SECRET_FLAGS.has(name)) {
      throw new Error(`${name} secret values are not accepted in staging profiles. Use environment variables when running staging:rehearsal.`);
    }
    const key = OPTION_FLAGS[name];
    if (!key) {
      throw new Error(`Unknown option: ${name}`);
    }
    const value = inlineValue ?? argv[index + 1];
    options[key] = requireArgValue(name, value, inlineValue);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  const missingFields = REQUIRED_FIELDS.filter((key) => !options[key]);
  if (options.storageProfile === "postgres-preview" && !options.postgresBackupDir) {
    missingFields.push("postgresBackupDir");
  }
  if (missingFields.length) {
    throw new Error(`Missing required staging profile field(s): ${missingFields.join(", ")}`);
  }
  return options;
}

function sanitizeArtifactSegment(value, fallback) {
  const normalized = String(value || fallback || "default")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback || "default";
}

function commandValue(value) {
  const text = String(value || "");
  if (/[\s"`]/.test(text)) {
    return `"${text.replace(/"/g, "`\"")}"`;
  }
  return text;
}

function buildRecoveryPreflightCommand({ options, closeoutInputFile, readinessActionQueueFile }) {
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
    commandValue(options.channel || "stable"),
    "--closeout-input-file",
    commandValue(closeoutInputFile),
    "--actions-file",
    commandValue(readinessActionQueueFile)
  );
  return parts.join(" ");
}

function buildProductionProofPreflightCommand({ outputFile }) {
  return [
    "npm.cmd run launch:production-proof-preflight --",
    "--profile-file",
    commandValue(outputFile)
  ].join(" ");
}

function buildRouteMapGateCommand({ options, closeoutInputFile, readinessActionQueueFile, dryRun = false }) {
  const parts = ["npm.cmd run launch:route-map-gate --"];
  if (dryRun) {
    parts.push("--dry-run", "--json");
  }
  parts.push(
    "--product-code",
    commandValue(options.productCode),
    "--channel",
    commandValue(options.channel || "stable"),
    "--staging-base-url",
    commandValue(options.baseUrl),
    "--closeout-input-file",
    commandValue(closeoutInputFile),
    "--actions-file",
    commandValue(readinessActionQueueFile)
  );
  return parts.join(" ");
}

function buildRouteMapGateBackfillCommand({ closeoutInputFile, readinessActionQueueFile, routeMapGateOutputFile }) {
  return [
    "npm.cmd run staging:closeout:backfill --",
    "--input-file",
    commandValue(closeoutInputFile),
    "--key",
    "route_map_gate_result",
    "--value-json",
    "<redacted-json>",
    "--artifact-path",
    commandValue(routeMapGateOutputFile),
    "--receipt-id",
    "<route-map-gate-receipt-id>",
    "--actions-file",
    commandValue(readinessActionQueueFile)
  ].join(" ");
}

function buildCloseoutEvidenceBackfillCommand({
  closeoutInputFile,
  readinessActionQueueFile,
  key,
  artifactPath,
  receiptIds = []
}) {
  return [
    "npm.cmd run staging:closeout:backfill --",
    "--input-file",
    commandValue(closeoutInputFile),
    "--key",
    key,
    "--value-json",
    "<redacted-json>",
    "--artifact-path",
    commandValue(artifactPath),
    ...receiptIds.flatMap((receiptId) => ["--receipt-id", receiptId]),
    "--actions-file",
    commandValue(readinessActionQueueFile)
  ].join(" ");
}

function buildStagingSmokePreflightCommand(options) {
  return [
    "npm.cmd run staging:preflight --",
    "--base-url",
    commandValue(options.baseUrl),
    "--product-code",
    commandValue(options.productCode),
    "--channel",
    commandValue(options.channel || "stable")
  ].join(" ");
}

function buildLaunchSmokeStagingCommand({ options, closeoutInputFile, readinessActionQueueFile }) {
  return [
    "npm.cmd run launch:smoke:staging --",
    "--base-url",
    commandValue(options.baseUrl),
    "--allow-live-writes",
    "--product-code",
    commandValue(options.productCode),
    "--channel",
    commandValue(options.channel || "stable"),
    "--closeout-input-file",
    commandValue(closeoutInputFile),
    "--actions-file",
    commandValue(readinessActionQueueFile)
  ].join(" ");
}

function buildPostSmokeBackfillCommands({ closeoutInputFile, readinessActionQueueFile, artifactPaths }) {
  return [
    {
      key: "live_write_smoke_result",
      artifactPath: artifactPaths.launchSmokeOutputFile,
      receiptIds: ["<record_launch_rehearsal_run-receipt-id>"]
    },
    {
      key: "launch_smoke_handoff",
      artifactPath: artifactPaths.launchSmokeHandoffFile,
      receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
    },
    {
      key: "launch_mainline_evidence_receipts",
      artifactPath: artifactPaths.launchMainlineEvidenceReceiptsFile,
      receiptIds: ["<record_launch_rehearsal_run-receipt-id>"]
    },
    {
      key: "receipt_visibility_review",
      artifactPath: artifactPaths.receiptVisibilityReviewFile,
      receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
    }
  ].map((item) => ({
    ...item,
    command: [
      "npm.cmd run staging:closeout:backfill --",
      "--input-file",
      commandValue(closeoutInputFile),
      "--key",
      item.key,
      "--value-json",
      "<redacted-json>",
      "--artifact-path",
      commandValue(item.artifactPath),
      ...item.receiptIds.flatMap((receiptId) => ["--receipt-id", receiptId]),
      "--actions-file",
      commandValue(readinessActionQueueFile)
    ].join(" ")
  }));
}

function buildFullTestSignoffBackfillCommand({ closeoutInputFile, readinessActionQueueFile, fullTestOutputFile }) {
  return [
    "npm.cmd run staging:signoff:backfill --",
    "--input-file",
    commandValue(closeoutInputFile),
    "--condition-key",
    "full_test_window_passed",
    "--value-json",
    "<redacted-json>",
    "--artifact-path",
    commandValue(fullTestOutputFile),
    "--decision",
    "ready-for-production-signoff",
    "--actions-file",
    commandValue(readinessActionQueueFile)
  ].join(" ");
}

function buildSignoffBackfillCommand({ closeoutInputFile, readinessActionQueueFile, keyFlag, key, artifactPath, receiptIds = [] }) {
  return [
    "npm.cmd run staging:signoff:backfill --",
    "--input-file",
    commandValue(closeoutInputFile),
    keyFlag,
    key,
    "--value-json",
    "<redacted-json>",
    "--artifact-path",
    commandValue(artifactPath),
    ...receiptIds.flatMap((receiptId) => ["--receipt-id", receiptId]),
    "--actions-file",
    commandValue(readinessActionQueueFile)
  ].join(" ");
}

function receiptVisibilityLaneFileName(key) {
  return `${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-receipt-visibility.json`;
}

function buildProductionSignoffBackfillCommands({
  closeoutInputFile,
  readinessActionQueueFile,
  artifactPaths
}) {
  const targets = [
    {
      key: "staging_artifacts_archived",
      artifactPath: artifactPaths.stagingArtifactsArchiveFile,
      receiptIds: []
    },
    {
      key: "launch_mainline_receipts_visible",
      artifactPath: artifactPaths.launchMainlineReceiptsVisibleFile,
      receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
    },
    {
      key: "launch_ops_overview_status_visible",
      artifactPath: artifactPaths.launchOpsOverviewStatusVisibleFile,
      receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
    },
    {
      key: "backup_restore_drill_passed",
      artifactPath: artifactPaths.backupRestoreArtifactFile,
      receiptIds: ["<record_recovery_drill-receipt-id>", "<record_backup_verification-receipt-id>"]
    },
    {
      key: "rollback_path_confirmed",
      artifactPath: artifactPaths.rollbackPathConfirmedFile,
      receiptIds: ["<record_rollback_walkthrough-receipt-id>"]
    },
    {
      key: "operator_signoff_recorded",
      artifactPath: artifactPaths.operatorProductionSignoffFile,
      receiptIds: []
    }
  ];
  return targets.map((item, index) => ({
    ...item,
    status: index === 0 ? "blocked_after_post_full_test_readiness_status" : `blocked_after_${targets[index - 1].key}`,
    command: buildSignoffBackfillCommand({
      closeoutInputFile,
      readinessActionQueueFile,
      keyFlag: "--condition-key",
      key: item.key,
      artifactPath: item.artifactPath,
      receiptIds: item.receiptIds
    }),
    nextAction: "Backfill this production sign-off condition, refresh readiness, then continue the sign-off and receipt visibility queue."
  }));
}

function buildReceiptVisibilityBackfillCommands({
  closeoutInputFile,
  readinessActionQueueFile,
  archiveRoot
}) {
  const targets = [
    "launchMainline",
    "launchReview",
    "launchSmoke",
    "developerOps",
    "launchOpsOverviewStatus"
  ].map((key) => ({
    key,
    artifactPath: path.posix.join(archiveRoot, receiptVisibilityLaneFileName(key)),
    receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
  }));
  return targets.map((item, index) => ({
    ...item,
    status: index === 0 ? "blocked_after_operator_signoff_recorded" : `blocked_after_${targets[index - 1].key}_receipt_visibility`,
    command: buildSignoffBackfillCommand({
      closeoutInputFile,
      readinessActionQueueFile,
      keyFlag: "--receipt-lane",
      key: item.key,
      artifactPath: item.artifactPath,
      receiptIds: item.receiptIds
    }),
    nextAction: "Backfill this receipt-visibility lane, refresh readiness, then continue toward launch-day watch."
  }));
}

function buildRehearsalReloadCommand(closeoutInputFile) {
  return `npm.cmd run staging:rehearsal -- --closeout-input-file ${commandValue(closeoutInputFile)}`;
}

function toPublicStableOperationsHandoff(handoff) {
  const { rehearsalHandoffFile, ...publicHandoff } = handoff;
  return publicHandoff;
}

function buildLaunchDutyRecordCommand({
  closeoutInputFile,
  readinessActionQueueFile,
  launchDutyRecordIndexFile,
  key,
  artifactPath,
  receiptIds = [],
  sourceRecords = []
}) {
  const receiptArgs = receiptIds.flatMap((receiptId) => ["--receipt-id", receiptId]);
  const sourceRecordArgs = sourceRecords.flatMap((record) => [
    "--source-record",
    commandValue(`${record.key}=${record.artifactPath}`)
  ]);
  return [
    "npm.cmd run staging:launch-duty:record --",
    "--closeout-input-file",
    commandValue(closeoutInputFile),
    "--key",
    key,
    "--artifact-path",
    commandValue(artifactPath),
    "--value-json",
    "<redacted-json>",
    ...receiptArgs,
    ...sourceRecordArgs,
    "--record-index-file",
    commandValue(launchDutyRecordIndexFile),
    "--actions-file",
    commandValue(readinessActionQueueFile)
  ].join(" ");
}

function buildStabilizationRecordCommands({
  closeoutInputFile,
  readinessActionQueueFile,
  launchDutyRecordIndexFile,
  artifactPaths
}) {
  const closeoutSourceRecords = [
    { key: "first_wave_incident_log", artifactPath: artifactPaths.firstWaveIncidentLogFile },
    { key: "rollback_signal_review", artifactPath: artifactPaths.rollbackSignalReviewFile },
    { key: "stabilization_owner_handoff", artifactPath: artifactPaths.stabilizationOwnerHandoffFile }
  ];
  return [
    {
      key: "receipt_visibility_snapshot",
      status: "blocked_after_launch_day_watch_summary",
      artifactPath: artifactPaths.receiptVisibilitySnapshotFile,
      receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"],
      sourceRecords: [],
      nextAction: "Save receipt visibility snapshots before incident and rollback review records."
    },
    {
      key: "first_wave_incident_log",
      status: "blocked_after_receipt_visibility_snapshot",
      artifactPath: artifactPaths.firstWaveIncidentLogFile,
      receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"],
      sourceRecords: [],
      nextAction: "Record first-wave incident notes, even when the entry confirms no incidents."
    },
    {
      key: "rollback_signal_review",
      status: "blocked_after_first_wave_incident_log",
      artifactPath: artifactPaths.rollbackSignalReviewFile,
      receiptIds: ["<record_rollback_walkthrough-receipt-id>", "<record_launch_stabilization_review-receipt-id>"],
      sourceRecords: [],
      nextAction: "Record rollback signal review before handing off stabilization ownership."
    },
    {
      key: "stabilization_owner_handoff",
      status: "blocked_after_rollback_signal_review",
      artifactPath: artifactPaths.stabilizationOwnerHandoffFile,
      receiptIds: ["<record_launch_stabilization_review-receipt-id>"],
      sourceRecords: [],
      nextAction: "Record the stabilization owner handoff before first-wave closeout."
    },
    {
      key: "first_wave_closeout",
      status: "blocked_until_source_records",
      artifactPath: artifactPaths.firstWaveCloseoutFile,
      receiptIds: ["<record_launch_closeout_review-receipt-id>"],
      sourceRecords: closeoutSourceRecords,
      nextAction: "Record first-wave closeout after the incident, rollback, and stabilization handoff source records exist."
    }
  ].map((item) => ({
    ...item,
    command: buildLaunchDutyRecordCommand({
      closeoutInputFile,
      readinessActionQueueFile,
      launchDutyRecordIndexFile,
      key: item.key,
      artifactPath: item.artifactPath,
      receiptIds: item.receiptIds,
      sourceRecords: item.sourceRecords
    })
  }));
}

function buildProfile(options) {
  const productCode = sanitizeArtifactSegment(options.productCode, "product");
  const channel = sanitizeArtifactSegment(options.channel || "stable", "stable");
  const archiveRoot = path.posix.join("artifacts", "staging", productCode, channel);
  const profile = {
    baseUrl: options.baseUrl,
    productCode: options.productCode,
    channel: options.channel || "stable",
    adminUsername: options.adminUsername,
    developerUsername: options.developerUsername,
    targetOs: options.targetOs,
    storageProfile: options.storageProfile,
    targetEnvFile: options.targetEnvFile,
    appBackupDir: options.appBackupDir
  };
  if (options.postgresBackupDir) {
    profile.postgresBackupDir = options.postgresBackupDir;
  }
  return {
    archiveRoot,
    profile: {
      ...profile,
      handoffFile: path.posix.join(archiveRoot, "staging-rehearsal-handoff.md"),
      closeoutFile: path.posix.join(archiveRoot, "staging-closeout-template.json"),
      runRecordFile: path.posix.join(archiveRoot, "staging-run-record-index.json"),
      artifactManifestFile: path.posix.join(archiveRoot, "staging-artifact-manifest.json"),
      backupRestorePacketFile: path.posix.join(archiveRoot, "staging-backup-restore-drill-packet.json"),
      closeoutReloadPacketFile: path.posix.join(archiveRoot, "staging-closeout-reload-packet.json"),
      readinessReviewPacketFile: path.posix.join(archiveRoot, "staging-readiness-review-packet.json"),
      productionSignoffPacketFile: path.posix.join(archiveRoot, "staging-production-signoff-packet.json"),
      launchDutyArchiveIndexFile: path.posix.join(archiveRoot, "staging-launch-duty-archive-index.json"),
      filledCloseoutDraftFile: path.posix.join(archiveRoot, "filled-closeout-input.draft.json"),
      readinessActionQueueFile: path.posix.join(archiveRoot, "readiness-action-queue.md")
    }
  };
}

function buildOperatorNextCommands({
  outputFile,
  closeoutInputFile,
  readinessActionQueueFile,
  backupRestoreArtifactFile,
  nextCommand,
  closeoutInitCommand,
  postCloseoutInitStatusCommand,
  recoveryPreflightCommand,
  routeMapGateDryRunCommand,
  routeMapGateCommand,
  routeMapGateBackfillCommand,
  postRouteMapReadinessStatusCommand,
  smokePreflightCommand,
  launchSmokeStagingCommand,
  postSmokeBackfillCommands,
  postSmokeReadinessStatusCommand,
  fullTestCommand,
  fullTestOutputFile,
  fullTestSignoffBackfillCommand,
  postFullTestReadinessStatusCommand,
  productionSignoffBackfillCommands,
  receiptVisibilityBackfillCommands,
  postProductionSignoffReadinessStatusCommand,
  postFirstWaveCloseoutReadinessStatusCommand,
  postFirstWaveCloseoutRehearsalReloadCommand,
  stableOperationsHandoff,
  launchDutyRecordIndexFile,
  launchDayWatchRecordCommand,
  launchDayWatchSummaryFile,
  stabilizationRecordCommands,
  routeMapGateDryRunFile,
  routeMapGateOutputFile
}) {
  const stabilizationOperatorCommands = stabilizationRecordCommands.map((item) => ({
    key: `record_stabilization_${item.key}`,
    status: item.status,
    command: item.command,
    artifactPath: item.artifactPath,
    targetKey: item.key,
    receiptIds: item.receiptIds,
    sourceRecords: item.sourceRecords,
    recordIndexFile: launchDutyRecordIndexFile,
    nextAction: item.nextAction
  }));
  const productionSignoffOperatorCommands = productionSignoffBackfillCommands.map((item) => ({
    key: `backfill_production_signoff_${item.key}`,
    status: item.status,
    command: item.command,
    artifactPath: item.artifactPath,
    targetKey: item.key,
    receiptIds: item.receiptIds,
    nextAction: item.nextAction
  }));
  const receiptVisibilityOperatorCommands = receiptVisibilityBackfillCommands.map((item) => ({
    key: `backfill_receipt_visibility_${item.key}`,
    status: item.status,
    command: item.command,
    artifactPath: item.artifactPath,
    targetKey: item.key,
    receiptIds: item.receiptIds,
    nextAction: item.nextAction
  }));
  const lastReceiptVisibilityKey = receiptVisibilityBackfillCommands.at(-1)?.key || "receipt_visibility";
  const stableOperationsOperatorCommands = [
    {
      key: "post_first_wave_closeout_readiness_status",
      status: "blocked_after_first_wave_closeout",
      command: postFirstWaveCloseoutReadinessStatusCommand,
      artifactPath: readinessActionQueueFile,
      targetKey: "stable_operations_handoff",
      recordIndexFile: launchDutyRecordIndexFile,
      nextAction: "Refresh readiness after first_wave_closeout so the completed launch-duty record index is recognized as stable_operations_handoff."
    },
    {
      key: "post_first_wave_closeout_rehearsal_reload",
      status: "blocked_after_stable_operations_readiness",
      command: postFirstWaveCloseoutRehearsalReloadCommand,
      artifactPath: stableOperationsHandoff.rehearsalHandoffFile,
      targetKey: "stable_operations_handoff",
      recordIndexFile: launchDutyRecordIndexFile,
      nextAction: "Reload rehearsal so the final packet, operator execution plan, and go-live entry surface the stable-operations handoff."
    },
    {
      key: "handoff_stable_operations",
      status: "blocked_after_rehearsal_reload",
      command: null,
      artifactPath: stableOperationsHandoff.firstWaveCloseoutArtifactPath,
      targetKey: "stable_operations_handoff",
      recordIndexFile: launchDutyRecordIndexFile,
      handoffArtifacts: stableOperationsHandoff.handoffArtifacts,
      nextAction: "Hand off the completed record index and first-wave closeout artifact to the stable-operations owner."
    }
  ];
  return [
    {
      key: "profile_rehearsal",
      status: "current",
      command: nextCommand,
      artifactPath: outputFile,
      nextAction: "Run the profile-driven rehearsal to write launch-duty artifacts and the closeout draft."
    },
    {
      key: "closeout_init",
      status: "blocked_after_profile_rehearsal",
      command: closeoutInitCommand,
      artifactPath: closeoutInputFile,
      nextAction: "Promote the generated closeout draft into the real filled closeout input."
    },
    {
      key: "readiness_status",
      status: "blocked_after_closeout_init",
      command: postCloseoutInitStatusCommand,
      artifactPath: readinessActionQueueFile,
      nextAction: "Refresh the readiness action queue after closeout init."
    },
    {
      key: "recovery_preflight",
      status: "blocked_after_readiness_status",
      command: recoveryPreflightCommand,
      artifactPath: backupRestoreArtifactFile,
      nextAction: "Run recovery preflight to print backup/restore commands and the backup_restore_drill_result closeout backfill handoff."
    },
    {
      key: "route_map_gate_dry_run",
      status: "blocked_after_recovery_preflight",
      command: routeMapGateDryRunCommand,
      artifactPath: routeMapGateDryRunFile,
      nextAction: "Review the route-map gate dry-run queue before running the targeted gate."
    },
    {
      key: "route_map_gate",
      status: "blocked_after_route_map_gate_dry_run",
      command: routeMapGateCommand,
      artifactPath: routeMapGateOutputFile,
      nextAction: "Run the targeted route-map gate, save its output, then follow the route-map operator queue from route_map_gate_result backfill onward."
    },
    {
      key: "route_map_gate_result_backfill",
      status: "blocked_after_route_map_gate",
      command: routeMapGateBackfillCommand,
      artifactPath: routeMapGateOutputFile,
      nextAction: "Backfill route_map_gate_result after the targeted route-map gate passes."
    },
    {
      key: "post_route_map_readiness_status",
      status: "blocked_after_route_map_gate_result_backfill",
      command: postRouteMapReadinessStatusCommand,
      artifactPath: readinessActionQueueFile,
      nextAction: "Refresh readiness so the action queue reflects route_map_gate_result before smoke preflight."
    },
    {
      key: "staging_smoke_preflight",
      status: "blocked_after_post_route_map_readiness_status",
      command: smokePreflightCommand,
      artifactPath: null,
      nextAction: "Run no-write smoke preflight before any launch:smoke:staging live-write command."
    },
    {
      key: "run_launch_smoke_staging",
      status: "blocked_after_staging_smoke_preflight",
      command: launchSmokeStagingCommand,
      artifactPath: postSmokeBackfillCommands[0].artifactPath,
      nextAction: "Run live-write smoke only after the no-write preflight passes and smoke credentials are loaded."
    },
    {
      key: "backfill_post_smoke_live_write_smoke_result",
      status: "blocked_after_launch_smoke_staging",
      command: postSmokeBackfillCommands[0].command,
      artifactPath: postSmokeBackfillCommands[0].artifactPath,
      targetKey: postSmokeBackfillCommands[0].key,
      receiptIds: postSmokeBackfillCommands[0].receiptIds,
      nextAction: "Backfill the live_write_smoke_result closeout evidence after Launch Smoke writes the output artifact."
    },
    {
      key: "backfill_post_smoke_launch_smoke_handoff",
      status: "blocked_after_live_write_smoke_result",
      command: postSmokeBackfillCommands[1].command,
      artifactPath: postSmokeBackfillCommands[1].artifactPath,
      targetKey: postSmokeBackfillCommands[1].key,
      receiptIds: postSmokeBackfillCommands[1].receiptIds,
      nextAction: "Backfill the launch_smoke_handoff evidence after saving the smoke handoff JSON."
    },
    {
      key: "backfill_post_smoke_launch_mainline_evidence_receipts",
      status: "blocked_after_launch_smoke_handoff",
      command: postSmokeBackfillCommands[2].command,
      artifactPath: postSmokeBackfillCommands[2].artifactPath,
      targetKey: postSmokeBackfillCommands[2].key,
      receiptIds: postSmokeBackfillCommands[2].receiptIds,
      nextAction: "Backfill Launch Mainline evidence receipts after recording the first-wave evidence chain."
    },
    {
      key: "backfill_post_smoke_receipt_visibility_review",
      status: "blocked_after_launch_mainline_evidence_receipts",
      command: postSmokeBackfillCommands[3].command,
      artifactPath: postSmokeBackfillCommands[3].artifactPath,
      targetKey: postSmokeBackfillCommands[3].key,
      receiptIds: postSmokeBackfillCommands[3].receiptIds,
      nextAction: "Backfill receipt_visibility_review after the Launch Review, Launch Smoke, Developer Ops, and Launch Mainline receipt queue is visible."
    },
    {
      key: "post_smoke_readiness_status",
      status: "blocked_after_post_smoke_backfills",
      command: postSmokeReadinessStatusCommand,
      artifactPath: readinessActionQueueFile,
      nextAction: "Refresh readiness after post-smoke closeout backfills before entering the full-test window."
    },
    {
      key: "run_full_test_window",
      status: "blocked_after_post_smoke_readiness_status",
      command: fullTestCommand,
      artifactPath: fullTestOutputFile,
      nextAction: "Run the deferred full-test window only after post-smoke closeout evidence is backfilled."
    },
    {
      key: "backfill_full_test_window_passed",
      status: "blocked_after_full_test_window",
      command: fullTestSignoffBackfillCommand,
      artifactPath: fullTestOutputFile,
      targetKey: "full_test_window_passed",
      nextAction: "Backfill full_test_window_passed with the redacted full-test result."
    },
    {
      key: "post_full_test_readiness_status",
      status: "blocked_after_full_test_window_passed",
      command: postFullTestReadinessStatusCommand,
      artifactPath: readinessActionQueueFile,
      targetKey: "production_signoff",
      nextAction: "Refresh readiness after full_test_window_passed backfill to confirm production sign-off blockers."
    },
    ...productionSignoffOperatorCommands,
    ...receiptVisibilityOperatorCommands,
    {
      key: "post_production_signoff_readiness_status",
      status: `blocked_after_${lastReceiptVisibilityKey}_receipt_visibility`,
      command: postProductionSignoffReadinessStatusCommand,
      artifactPath: readinessActionQueueFile,
      targetKey: "launch_day_watch",
      nextAction: "Refresh readiness after all production sign-off conditions and receipt visibility lanes are backfilled."
    },
    {
      key: "record_launch_day_watch_summary",
      status: "blocked_after_production_signoff_readiness_status",
      command: launchDayWatchRecordCommand,
      artifactPath: launchDayWatchSummaryFile,
      targetKey: "launch_day_watch_summary",
      receiptIds: ["<record_cutover_walkthrough-receipt-id>", "<record_launch_day_readiness_review-receipt-id>"],
      recordIndexFile: launchDutyRecordIndexFile,
      nextAction: "Record launch-day watch summary after production sign-off readiness refresh clears."
    },
    ...stabilizationOperatorCommands,
    ...stableOperationsOperatorCommands
  ];
}

function buildOperatorQueueCheckpoint({
  operatorNextCommands,
  outputFile,
  closeoutInputFile,
  readinessActionQueueFile,
  archiveRoot,
  closeoutInitCommand,
  postCloseoutInitStatusCommand,
  postFirstWaveCloseoutRehearsalReloadCommand,
  postSmokeBackfillCommands,
  productionSignoffBackfillCommands,
  receiptVisibilityBackfillCommands,
  stabilizationRecordCommands
}) {
  const currentCommand = operatorNextCommands.find((item) => item.status === "current") || operatorNextCommands[0] || {};
  const nextMilestone = operatorNextCommands.find((item) => item.key === "closeout_init")
    || operatorNextCommands.find((item) => item.status !== "current")
    || {};
  const currentCommandCount = operatorNextCommands.filter((item) => item.status === "current").length;
  const stableOperationsCommandCount = operatorNextCommands.filter((item) =>
    item.key === "post_first_wave_closeout_readiness_status"
      || item.key === "post_first_wave_closeout_rehearsal_reload"
      || item.key === "handoff_stable_operations"
  ).length;

  return {
    mode: "staging-profile-operator-queue-checkpoint",
    status: currentCommand.key === "profile_rehearsal" ? "awaiting_profile_rehearsal" : "awaiting_operator_queue",
    currentActionKey: currentCommand.key || null,
    currentCommand: currentCommand.command || null,
    currentArtifactPath: currentCommand.artifactPath || outputFile,
    actionQueueFile: readinessActionQueueFile,
    closeoutInputFile,
    readinessStatusCommand: postCloseoutInitStatusCommand,
    rehearsalReloadCommand: postFirstWaveCloseoutRehearsalReloadCommand,
    archiveRoot,
    totalCommandCount: operatorNextCommands.length,
    currentCommandCount,
    blockedCommandCount: Math.max(operatorNextCommands.length - currentCommandCount, 0),
    queueCounts: {
      postSmokeBackfillCount: postSmokeBackfillCommands.length,
      productionSignoffBackfillCount: productionSignoffBackfillCommands.length,
      receiptVisibilityBackfillCount: receiptVisibilityBackfillCommands.length,
      launchDutyRecordCount: 1 + stabilizationRecordCommands.length,
      stableOperationsCommandCount
    },
    nextMilestoneKey: nextMilestone.key || null,
    nextMilestoneCommand: nextMilestone.command || closeoutInitCommand,
    nextAction: "Run the current profile rehearsal command, then follow closeout_init and readiness_status before recovery preflight."
  };
}

const LAUNCH_EXECUTION_PHASES = [
  {
    key: "profile_and_closeout",
    label: "Profile rehearsal and closeout init",
    commandKeys: ["profile_rehearsal", "closeout_init", "readiness_status"]
  },
  {
    key: "recovery_and_route_gate",
    label: "Recovery drill and route-map gate",
    commandKeys: [
      "recovery_preflight",
      "route_map_gate_dry_run",
      "route_map_gate",
      "route_map_gate_result_backfill",
      "post_route_map_readiness_status"
    ]
  },
  {
    key: "live_write_smoke",
    label: "No-write preflight, live-write smoke, and post-smoke closeout",
    commandKeys: [
      "staging_smoke_preflight",
      "run_launch_smoke_staging",
      "backfill_post_smoke_live_write_smoke_result",
      "backfill_post_smoke_launch_smoke_handoff",
      "backfill_post_smoke_launch_mainline_evidence_receipts",
      "backfill_post_smoke_receipt_visibility_review",
      "post_smoke_readiness_status"
    ]
  },
  {
    key: "full_test_window",
    label: "Full-test window and local go-live baseline",
    commandKeys: ["run_full_test_window", "backfill_full_test_window_passed", "post_full_test_readiness_status"]
  },
  {
    key: "production_signoff_and_receipts",
    label: "Production sign-off and receipt visibility",
    commandKeys: [
      "backfill_production_signoff_staging_artifacts_archived",
      "backfill_production_signoff_launch_mainline_receipts_visible",
      "backfill_production_signoff_launch_ops_overview_status_visible",
      "backfill_production_signoff_backup_restore_drill_passed",
      "backfill_production_signoff_rollback_path_confirmed",
      "backfill_production_signoff_operator_signoff_recorded",
      "backfill_receipt_visibility_launchMainline",
      "backfill_receipt_visibility_launchReview",
      "backfill_receipt_visibility_launchSmoke",
      "backfill_receipt_visibility_developerOps",
      "backfill_receipt_visibility_launchOpsOverviewStatus",
      "post_production_signoff_readiness_status"
    ]
  },
  {
    key: "launch_day_watch_and_stabilization",
    label: "Launch-day watch and stabilization records",
    commandKeys: [
      "record_launch_day_watch_summary",
      "record_stabilization_receipt_visibility_snapshot",
      "record_stabilization_first_wave_incident_log",
      "record_stabilization_rollback_signal_review",
      "record_stabilization_stabilization_owner_handoff",
      "record_stabilization_first_wave_closeout"
    ]
  },
  {
    key: "stable_operations_handoff",
    label: "Stable-operations handoff",
    commandKeys: [
      "post_first_wave_closeout_readiness_status",
      "post_first_wave_closeout_rehearsal_reload",
      "handoff_stable_operations"
    ]
  }
];

function buildLaunchExecutionPhasePlan({ operatorNextCommands }) {
  const commandsByKey = new Map((operatorNextCommands || []).map((item) => [item.key, item]));
  const phases = LAUNCH_EXECUTION_PHASES.map((definition, index) => {
    const commands = definition.commandKeys
      .map((key) => commandsByKey.get(key))
      .filter(Boolean);
    const currentCommand = commands.find((item) => item.status === "current") || null;
    const firstBlockedCommand = commands.find((item) => item.status !== "current") || null;
    const firstCommand = commands[0] || null;
    const finalCommand = commands.at(-1) || null;
    const currentCommandCount = commands.filter((item) => item.status === "current").length;
    const blockedCommandCount = Math.max(commands.length - currentCommandCount, 0);
    const nextCommand = currentCommand || firstBlockedCommand || firstCommand || {};

    return {
      order: index + 1,
      key: definition.key,
      label: definition.label,
      status: currentCommand ? "current" : "blocked",
      totalCommandCount: commands.length,
      currentCommandCount,
      blockedCommandCount,
      commandKeys: commands.map((item) => item.key),
      firstActionKey: firstCommand?.key || null,
      currentActionKey: currentCommand?.key || null,
      firstBlockedActionKey: firstBlockedCommand?.key || null,
      currentCommand: currentCommand?.command || null,
      nextCommand: nextCommand.command || null,
      finalActionKey: finalCommand?.key || null,
      nextAction: nextCommand.nextAction || null
    };
  });
  const currentPhase = phases.find((phase) => phase.status === "current") || phases[0] || null;
  const nextBlockedPhase = currentPhase
    ? phases.find((phase) => phase.order > currentPhase.order && phase.status === "blocked")
    : phases.find((phase) => phase.status === "blocked");
  const currentCommand = currentPhase?.currentCommand
    ? (operatorNextCommands || []).find((item) => item.command === currentPhase.currentCommand) || null
    : null;
  const currentPhaseCount = phases.filter((phase) => phase.status === "current").length;
  const totalCommandCount = phases.reduce((sum, phase) => sum + phase.totalCommandCount, 0);

  return {
    mode: "staging-profile-launch-execution-phase-plan",
    status: currentCommand?.key === "profile_rehearsal" ? "awaiting_profile_rehearsal" : "awaiting_operator_queue",
    currentPhaseKey: currentPhase?.key || null,
    currentActionKey: currentCommand?.key || null,
    currentCommand: currentCommand?.command || null,
    totalPhaseCount: phases.length,
    currentPhaseCount,
    blockedPhaseCount: Math.max(phases.length - currentPhaseCount, 0),
    totalCommandCount,
    nextBlockedPhaseKey: nextBlockedPhase?.key || null,
    nextAction: currentPhase && nextBlockedPhase
      ? `Complete the current ${currentPhase.key} phase, then continue with ${nextBlockedPhase.key}.`
      : "Continue the current launch execution phase until the next generated command is unblocked.",
    phases
  };
}

function buildLaunchEvidenceItem({
  order,
  key,
  type,
  status,
  artifactPath,
  command,
  receiptIds = [],
  sourceRecordKeys = []
}) {
  const item = {
    order,
    key,
    type,
    status,
    artifactPath,
    command,
    receiptIds: Array.isArray(receiptIds) ? receiptIds.slice() : []
  };
  if (Array.isArray(sourceRecordKeys) && sourceRecordKeys.length) {
    item.sourceRecordKeys = sourceRecordKeys.slice();
  }
  return item;
}

function buildProfileLaunchEvidenceReadinessGate({
  nextCommand,
  closeoutInputFile,
  readinessActionQueueFile,
  archiveRoot,
  routeMapGateBackfillCommand,
  routeMapGateOutputFile,
  backupRestoreDrillBackfillCommand,
  backupRestoreArtifactFile,
  postSmokeBackfillCommands,
  operatorGoNoGoBackfillCommand,
  operatorGoNoGoFile,
  fullTestCommand,
  fullTestOutputFile,
  fullTestSignoffBackfillCommand,
  productionSignoffBackfillCommands,
  receiptVisibilityBackfillCommands,
  postCloseoutInitStatusCommand,
  postFirstWaveCloseoutRehearsalReloadCommand,
  launchDutyRecordIndexFile,
  launchDayWatchRecordCommand,
  launchDayWatchSummaryFile,
  stabilizationRecordCommands,
  firstWaveCloseoutFile
}) {
  const postSmokeEvidenceStatuses = [
    "blocked_after_launch_smoke_staging",
    "blocked_after_live_write_smoke_result",
    "blocked_after_launch_smoke_handoff",
    "blocked_after_launch_mainline_evidence_receipts"
  ];
  const closeoutEvidenceItems = [
    buildLaunchEvidenceItem({
      order: 1,
      key: "route_map_gate_result",
      type: "closeout_evidence",
      status: "blocked_after_route_map_gate",
      artifactPath: routeMapGateOutputFile,
      command: routeMapGateBackfillCommand,
      receiptIds: ["<route-map-gate-receipt-id>"]
    }),
    buildLaunchEvidenceItem({
      order: 2,
      key: "backup_restore_drill_result",
      type: "closeout_evidence",
      status: "blocked_after_recovery_preflight",
      artifactPath: backupRestoreArtifactFile,
      command: backupRestoreDrillBackfillCommand,
      receiptIds: ["<record_recovery_drill-receipt-id>", "<record_backup_verification-receipt-id>"]
    }),
    ...postSmokeBackfillCommands.map((item, index) => buildLaunchEvidenceItem({
      order: index + 3,
      key: item.key,
      type: "closeout_evidence",
      status: item.status || postSmokeEvidenceStatuses[index] || "blocked_after_post_smoke_evidence",
      artifactPath: item.artifactPath,
      command: item.command,
      receiptIds: item.receiptIds
    })),
    buildLaunchEvidenceItem({
      order: 7,
      key: "operator_go_no_go",
      type: "closeout_evidence",
      status: "blocked_after_receipt_visibility_review",
      artifactPath: operatorGoNoGoFile,
      command: operatorGoNoGoBackfillCommand,
      receiptIds: []
    })
  ];
  const productionSignoffEvidenceItems = [
    buildLaunchEvidenceItem({
      order: 8,
      key: "full_test_window_passed",
      type: "production_signoff_condition",
      status: "blocked_after_full_test_window",
      artifactPath: fullTestOutputFile,
      command: fullTestSignoffBackfillCommand,
      receiptIds: []
    }),
    ...productionSignoffBackfillCommands.map((item, index) => buildLaunchEvidenceItem({
      order: index + 9,
      key: item.key,
      type: "production_signoff_condition",
      status: item.status,
      artifactPath: item.artifactPath,
      command: item.command,
      receiptIds: item.receiptIds
    }))
  ];
  const receiptVisibilityEvidenceItems = receiptVisibilityBackfillCommands.map((item, index) => buildLaunchEvidenceItem({
    order: index + 15,
    key: item.key,
    type: "receipt_visibility_lane",
    status: item.status,
    artifactPath: item.artifactPath,
    command: item.command,
    receiptIds: item.receiptIds
  }));
  const firstWaveCloseout = stabilizationRecordCommands.find((item) => item.key === "first_wave_closeout") || {};
  const launchDutyEvidenceItems = [
    buildLaunchEvidenceItem({
      order: 20,
      key: "launch_day_watch_summary",
      type: "launch_duty_record",
      status: "blocked_after_production_signoff_readiness_status",
      artifactPath: launchDayWatchSummaryFile,
      command: launchDayWatchRecordCommand,
      receiptIds: ["<record_cutover_walkthrough-receipt-id>", "<record_launch_day_readiness_review-receipt-id>"]
    }),
    buildLaunchEvidenceItem({
      order: 21,
      key: "first_wave_closeout",
      type: "launch_duty_record",
      status: firstWaveCloseout.status || "blocked_until_source_records",
      artifactPath: firstWaveCloseout.artifactPath || firstWaveCloseoutFile,
      command: firstWaveCloseout.command || null,
      receiptIds: firstWaveCloseout.receiptIds || ["<record_launch_closeout_review-receipt-id>"],
      sourceRecordKeys: (firstWaveCloseout.sourceRecords || []).map((record) => record.key)
    })
  ];
  const evidenceItems = [
    ...closeoutEvidenceItems,
    ...productionSignoffEvidenceItems,
    ...receiptVisibilityEvidenceItems,
    ...launchDutyEvidenceItems
  ];
  const currentEvidence = evidenceItems[0] || null;
  const completedEvidenceCount = evidenceItems.filter((item) =>
    item.status === "filled" || item.status === "visible" || item.status === "recorded"
  ).length;
  const pendingEvidenceCount = evidenceItems.length - completedEvidenceCount;
  const closeoutEvidenceCount = closeoutEvidenceItems.length;
  const productionSignoffEvidenceCount = productionSignoffEvidenceItems.length;
  const receiptVisibilityEvidenceCount = receiptVisibilityEvidenceItems.length;
  const launchDutyEvidenceCount = launchDutyEvidenceItems.length;

  return {
    version: "staging-profile-init-launch-evidence-gate/v1",
    status: pendingEvidenceCount > 0
      ? "blocked_until_real_launch_evidence_attached"
      : "ready_for_stabilization_handoff",
    currentGate: "profile_rehearsal",
    currentSetupActionKey: "profile_rehearsal",
    currentSetupCommand: nextCommand,
    currentEvidenceKey: currentEvidence?.key || null,
    currentEvidenceType: currentEvidence?.type || null,
    currentEvidenceStatus: currentEvidence?.status || null,
    currentCommand: currentEvidence?.command || null,
    currentArtifactPath: currentEvidence?.artifactPath || null,
    closeoutInputFile,
    readinessActionQueueFile,
    archiveRoot,
    evidenceCount: evidenceItems.length,
    closeoutEvidenceCount,
    productionSignoffEvidenceCount,
    receiptVisibilityEvidenceCount,
    launchDutyEvidenceCount,
    completedEvidenceCount,
    pendingEvidenceCount,
    readinessStatusCommand: postCloseoutInitStatusCommand,
    rehearsalReloadCommand: postFirstWaveCloseoutRehearsalReloadCommand,
    fullTestCommand,
    fullTestOutputArtifact: fullTestOutputFile,
    productionSignoffPacket: path.posix.join(archiveRoot, "staging-production-signoff-packet.json"),
    launchDayWatchArtifact: launchDayWatchSummaryFile,
    firstWaveCloseoutArtifact: firstWaveCloseoutFile,
    launchDutyRecordIndexPath: launchDutyRecordIndexFile,
    progress: {
      closeout: { completed: 0, total: closeoutEvidenceCount },
      productionSignoff: { completed: 0, total: productionSignoffEvidenceCount },
      receiptVisibility: { completed: 0, total: receiptVisibilityEvidenceCount },
      launchDuty: { completed: 0, total: launchDutyEvidenceCount }
    },
    evidenceItems,
    nextAction: "Run the current setup command and closeout init, then attach route_map_gate_result as the first real launch evidence item before continuing through readiness refresh, smoke, full-test, signoff, receipt visibility, launch-day watch, and first-wave closeout."
  };
}

function buildLaunchLaneFiles({
  archiveRoot,
  outputFile,
  profile,
  closeoutInputFile,
  readinessActionQueueFile,
  productionProofExecutionPackFile,
  backupRestoreArtifactFile,
  routeMapGateDryRunFile,
  routeMapGateOutputFile,
  launchSmokeOutputFile,
  launchSmokeHandoffFile,
  launchMainlineEvidenceReceiptsFile,
  receiptVisibilityReviewFile,
  operatorGoNoGoFile,
  fullTestOutputFile,
  launchDayWatchSummaryFile,
  receiptVisibilitySnapshotFile,
  firstWaveIncidentLogFile,
  rollbackSignalReviewFile,
  stabilizationOwnerHandoffFile,
  firstWaveCloseoutFile,
  launchDutyRecordIndexFile
}) {
  return {
    archiveRoot,
    profileFile: outputFile,
    closeoutDraftFile: profile.filledCloseoutDraftFile,
    closeoutInputFile,
    readinessActionQueueFile,
    productionProofExecutionPackFile,
    backupRestoreArtifactFile,
    routeMapGateDryRunFile,
    routeMapGateOutputFile,
    launchSmokeOutputFile,
    launchSmokeHandoffFile,
    launchMainlineEvidenceReceiptsFile,
    receiptVisibilityReviewFile,
    operatorGoNoGoFile,
    fullTestOutputFile,
    launchDayWatchSummaryFile,
    receiptVisibilitySnapshotFile,
    firstWaveIncidentLogFile,
    rollbackSignalReviewFile,
    stabilizationOwnerHandoffFile,
    firstWaveCloseoutFile,
    handoffFile: profile.handoffFile,
    launchDutyArchiveIndexFile: profile.launchDutyArchiveIndexFile,
    launchDutyRecordIndexFile,
    stableOperationsHandoffArtifacts: [launchDutyRecordIndexFile, firstWaveCloseoutFile],
    nextAction: "Use these paths for the first real staging rehearsal, production proof execution pack, closeout init, readiness refresh, backup/restore evidence, route-map gate handoff, launch smoke closeout backfills, full-test signoff, launch-day watch records, stabilization records, first-wave closeout, and stable-operations handoff."
  };
}

function buildProductionSwitchProofPacket({
  options,
  archiveRoot,
  outputFile,
  closeoutInputFile,
  readinessActionQueueFile,
  productionProofExecutionPackFile,
  productionProofPreflightCommand,
  nextCommand,
  recoveryPreflightCommand,
  launchSmokeStagingCommand,
  fullTestCommand,
  fullTestOutputFile,
  postProductionSignoffReadinessStatusCommand,
  launchDayWatchRecordCommand,
  launchDayWatchSummaryFile,
  launchDutyRecordIndexFile
}) {
  const publicHttpsProof = buildProductionSwitchPublicHttpsProof(options.baseUrl);
  const storageProfileProof = buildProductionSwitchStorageProfileProof(options.storageProfile);
  const backupRestoreArtifactPath = path.posix.join(archiveRoot, "backup-restore-drill.txt");
  const backupRestoreDrillProof = buildProductionSwitchBackupRestoreDrillProof({
    status: "blocked_after_readiness_status",
    closeoutInputFile,
    artifactPath: backupRestoreArtifactPath,
    command: recoveryPreflightCommand,
    receiptOperations: ["record_recovery_drill", "record_backup_verification"]
  });
  const httpsReady = publicHttpsProof.isHttps;
  const secretEnvProof = buildProductionSwitchSecretEnvProof({
    stagingEnvironmentBinding: {
      credentialEnv: {
        adminPassword: ADMIN_PASSWORD_ENV,
        developerPassword: DEVELOPER_PASSWORD_ENV,
        developerBearerToken: DEVELOPER_BEARER_TOKEN_ENV
      }
    }
  }, options.targetEnvFile);
  const secretEnvStatus = secretEnvProof.status === "ready_secret_env_loaded"
    ? "ready_secret_env_loaded"
    : "blocked_until_secret_env_loaded";
  const proofItems = [
    {
      order: 1,
      key: "public_https_entrypoint",
      status: httpsReady ? "ready_from_profile" : "blocked_until_public_https",
      command: null,
      artifactPath: options.baseUrl,
      nextAction: "Keep the public staging entrypoint on HTTPS for all live-write smoke and launch switch checks."
    },
    {
      order: 2,
      key: "non_default_secret_env",
      status: secretEnvStatus,
      command: nextCommand,
      artifactPath: options.targetEnvFile,
      nextAction: "Load non-default admin, developer, and bearer-token secrets from environment variables before rehearsal."
    },
    {
      order: 3,
      key: "storage_profile_selected",
      status: "ready_from_profile",
      command: null,
      artifactPath: options.storageProfile,
      nextAction: "Keep storage profile and backup paths aligned through recovery preflight and staging rehearsal."
    },
    {
      order: 4,
      key: "backup_restore_drill",
      status: backupRestoreDrillProof.status,
      command: backupRestoreDrillProof.command,
      artifactPath: backupRestoreDrillProof.artifactPath,
      nextAction: "Run recovery preflight and backfill backup_restore_drill_result before live-write smoke."
    },
    {
      order: 5,
      key: "live_write_smoke",
      status: "blocked_after_route_map_gate",
      command: launchSmokeStagingCommand,
      artifactPath: path.posix.join(archiveRoot, "live-write-smoke-output.json"),
      nextAction: "Run launch:smoke:staging only after no-write preflight and route-map gate pass."
    },
    {
      order: 6,
      key: "full_test_window",
      status: "ready_local_baseline_available",
      command: fullTestCommand,
      artifactPath: fullTestOutputFile,
      nextAction: "Attach the redacted full-suite output artifact before backfilling full_test_window_passed."
    },
    {
      order: 7,
      key: "production_signoff_and_receipts",
      status: "blocked_after_full_test_signoff_backfill",
      command: postProductionSignoffReadinessStatusCommand,
      artifactPath: path.posix.join(archiveRoot, "staging-production-signoff-packet.json"),
      nextAction: "Backfill six production sign-off conditions and five receipt-visibility lanes before launch-day watch."
    },
    {
      order: 8,
      key: "launch_day_watch_and_stabilization",
      status: "blocked_after_production_signoff_readiness",
      command: launchDayWatchRecordCommand,
      artifactPath: launchDayWatchSummaryFile,
      nextAction: "Record launch-day watch, stabilization, and first-wave closeout records into the shared launch-duty record index."
    }
  ];
  const ready = proofItems.filter((item) => String(item.status || "").startsWith("ready_")).length;
  return {
    version: "staging-profile-init-production-switch-proof-packet/v1",
    status: "blocked_until_real_environment_evidence",
    currentActionKey: "profile_rehearsal",
    currentCommand: nextCommand,
    baseUrl: options.baseUrl,
    productCode: options.productCode,
    channel: options.channel || "stable",
    targetOs: options.targetOs,
    storageProfile: options.storageProfile,
    archiveRoot,
    closeoutInputFile,
    readinessActionQueueFile,
    productionProofExecutionPackFile,
    productionProofPreflightCommand,
    launchDutyRecordIndexFile,
    publicHttpsProof,
    storageProfileProof,
    backupRestoreDrillProof,
    secretEnvProof,
    localFullSuiteBaseline: {
      command: fullTestCommand,
      status: "available_from_2026-05-28_full_suite_pass",
      testCount: 198,
      failureCount: 0,
      outputArtifact: fullTestOutputFile,
      nextAction: "Reuse this local baseline unless another meaningful backend/API or launch-control change lands before cutover."
    },
    proofCounts: {
      total: proofItems.length,
      ready,
      blocked: proofItems.length - ready
    },
    proofItems,
    nextAction: "Run profile rehearsal with non-default secrets, execute real-environment proof items in order, then use launch-duty record index as the production switch baseline."
  };
}

function writeOperatorQueueCheckpointPlain(checkpoint) {
  if (!checkpoint) {
    return;
  }
  console.log(
    `Operator queue checkpoint: ${checkpoint.currentActionKey || "-"}`
      + ` (status=${checkpoint.status || "-"}, total=${checkpoint.totalCommandCount ?? "-"}, blocked=${checkpoint.blockedCommandCount ?? "-"})`
  );
  console.log(`Operator queue current: ${checkpoint.currentCommand || "-"}`);
  console.log(`Operator queue readiness status: ${checkpoint.readinessStatusCommand || "-"}`);
  console.log(
    `Operator queue counts: postSmoke=${checkpoint.queueCounts?.postSmokeBackfillCount ?? "-"}`
      + `, signoff=${checkpoint.queueCounts?.productionSignoffBackfillCount ?? "-"}`
      + `, receipts=${checkpoint.queueCounts?.receiptVisibilityBackfillCount ?? "-"}`
      + `, launchDutyRecords=${checkpoint.queueCounts?.launchDutyRecordCount ?? "-"}`
      + `, stableOps=${checkpoint.queueCounts?.stableOperationsCommandCount ?? "-"}`
  );
  console.log(`Operator queue next milestone: ${checkpoint.nextMilestoneKey || "-"} -> ${checkpoint.nextMilestoneCommand || "-"}`);
}

function writeLaunchExecutionPhasePlanPlain(plan) {
  if (!plan) {
    return;
  }
  console.log(
    `Launch execution phase plan: ${plan.status || "-"}`
      + ` (current=${plan.currentPhaseKey || "-"}, phases=${plan.totalPhaseCount ?? "-"}`
      + `, blocked=${plan.blockedPhaseCount ?? "-"}, commands=${plan.totalCommandCount ?? "-"})`
  );
  (plan.phases || []).forEach((phase) => {
    console.log(
      `Launch execution phase ${phase.order}. ${phase.key}: ${phase.status}`
        + ` (commands=${phase.totalCommandCount ?? "-"}, blocked=${phase.blockedCommandCount ?? "-"}`
        + `, current=${phase.currentActionKey || "-"}, next=${phase.currentActionKey || phase.firstBlockedActionKey || "-"})`
    );
  });
  console.log(`Launch execution next action: ${plan.nextAction || "-"}`);
}

function writeLaunchEvidenceReadinessGatePlain(gate) {
  if (!gate) {
    return;
  }
  console.log(
    `Launch evidence gate: ${gate.status || "-"}`
      + ` (current=${gate.currentEvidenceKey || "-"}, pending=${gate.pendingEvidenceCount ?? "-"}/${gate.evidenceCount ?? "-"})`
  );
  console.log(`Launch evidence setup: ${gate.currentSetupActionKey || "-"} -> ${gate.currentSetupCommand || "-"}`);
  console.log(`Launch evidence current: ${gate.currentEvidenceType || "-"}/${gate.currentEvidenceKey || "-"} -> ${gate.currentCommand || "-"}`);
  console.log(`Launch evidence artifact: ${gate.currentArtifactPath || "-"}`);
  console.log(
    `Launch evidence progress: closeout=${gate.progress?.closeout?.completed ?? "-"}/${gate.progress?.closeout?.total ?? "-"}`
      + `, signoff=${gate.progress?.productionSignoff?.completed ?? "-"}/${gate.progress?.productionSignoff?.total ?? "-"}`
      + `, receipts=${gate.progress?.receiptVisibility?.completed ?? "-"}/${gate.progress?.receiptVisibility?.total ?? "-"}`
      + `, launchDuty=${gate.progress?.launchDuty?.completed ?? "-"}/${gate.progress?.launchDuty?.total ?? "-"}`
  );
  console.log(`Launch evidence full-test: ${gate.fullTestCommand || "-"} -> ${gate.fullTestOutputArtifact || "-"}`);
  console.log(`Launch evidence production signoff packet: ${gate.productionSignoffPacket || "-"}`);
  console.log(`Launch evidence launch-day watch: ${gate.launchDayWatchArtifact || "-"}`);
  console.log(`Launch evidence first-wave closeout: ${gate.firstWaveCloseoutArtifact || "-"}`);
  console.log(`Launch evidence next action: ${gate.nextAction || "-"}`);
}

function writeProductionSwitchProofPacketPlain(packet) {
  if (!packet) {
    return;
  }
  const counts = packet.proofCounts || {};
  console.log(
    `Production switch proof packet: ${packet.status || "-"}`
      + ` (ready=${counts.ready ?? "-"}/${counts.total ?? "-"}`
      + `, blocked=${counts.blocked ?? "-"}/${counts.total ?? "-"}`
      + `, current=${packet.currentActionKey || "-"})`
  );
  const publicHttpsProof = packet.publicHttpsProof || {};
  if (publicHttpsProof.status) {
    console.log(
      `Production switch public HTTPS proof: ${publicHttpsProof.status || "-"}`
        + ` (scheme=${publicHttpsProof.scheme || "-"}, url=${publicHttpsProof.baseUrl || "-"})`
    );
  }
  const storageProfileProof = packet.storageProfileProof || {};
  if (storageProfileProof.status) {
    console.log(
      `Production switch storage profile proof: ${storageProfileProof.status || "-"}`
        + ` (profile=${storageProfileProof.storageProfile || "-"})`
    );
  }
  const backupRestoreDrillProof = packet.backupRestoreDrillProof || {};
  if (backupRestoreDrillProof.status) {
    console.log(
      `Production switch backup/restore proof: ${backupRestoreDrillProof.status || "-"}`
        + ` (key=${backupRestoreDrillProof.closeoutKey || "-"}`
        + `, artifact=${backupRestoreDrillProof.artifactPath || "-"}`
        + `, receipts=${(backupRestoreDrillProof.receiptOperations || []).join(", ") || "-"})`
    );
  }
  const secretEnvProof = packet.secretEnvProof || {};
  if (secretEnvProof.status) {
    console.log(
      `Production switch secret env proof: ${secretEnvProof.status || "-"}`
        + ` (required=${secretEnvProof.requiredCount ?? "-"}`
        + `, missing=${secretEnvProof.missingCount ?? "-"}`
        + `, current=${secretEnvProof.currentMissingKey || "-"})`
    );
    console.log(`Production switch secret env required: ${(secretEnvProof.requiredKeys || []).join(", ") || "-"}`);
    console.log(`Production switch secret env missing: ${(secretEnvProof.missingKeys || []).join(", ") || "-"}`);
  }
  const baseline = packet.localFullSuiteBaseline || {};
  console.log(
    `Production switch local baseline: ${baseline.command || "-"} -> ${baseline.outputArtifact || "-"}`
      + ` (${baseline.status || "-"}, tests=${baseline.testCount ?? "-"}, failures=${baseline.failureCount ?? "-"})`
  );
  (packet.proofItems || []).forEach((item) => {
    console.log(`Production switch proof ${item.order}. ${item.key}: ${item.status} -> ${item.command || item.artifactPath || "-"}`);
  });
  console.log(`Production switch next action: ${packet.nextAction || "-"}`);
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.status === "written") {
    console.log(`Staging profile written: ${result.outputFile}`);
    if (result.launchLaneFiles) {
      const files = result.launchLaneFiles;
      console.log(`Launch lane archive root: ${files.archiveRoot}`);
      console.log(`Launch lane profile: ${files.profileFile}`);
      console.log(`Launch lane closeout draft: ${files.closeoutDraftFile}`);
      console.log(`Launch lane closeout input: ${files.closeoutInputFile}`);
      console.log(`Launch lane action queue: ${files.readinessActionQueueFile}`);
      console.log(`Launch lane production proof execution pack: ${files.productionProofExecutionPackFile}`);
      console.log(`Launch lane backup/restore artifact: ${files.backupRestoreArtifactFile}`);
      console.log(`Launch lane route-map dry run: ${files.routeMapGateDryRunFile}`);
      console.log(`Launch lane route-map output: ${files.routeMapGateOutputFile}`);
      console.log(`Launch lane operator go/no-go: ${files.operatorGoNoGoFile}`);
      console.log(`Launch lane record index: ${files.launchDutyRecordIndexFile}`);
    }
    if (result.productionProofPreflightCommand) {
      console.log(`Production proof preflight: ${result.productionProofPreflightCommand}`);
    }
    writeOperatorQueueCheckpointPlain(result.operatorQueueCheckpoint);
    writeLaunchExecutionPhasePlanPlain(result.launchExecutionPhasePlan);
    writeLaunchEvidenceReadinessGatePlain(result.launchEvidenceReadinessGate);
    writeProductionSwitchProofPacketPlain(result.productionSwitchProofPacket);
    const currentCommand = result.operatorNextCommands?.find((item) => item.status === "current");
    const closeoutInit = result.operatorNextCommands?.find((item) => item.key === "closeout_init");
    const readinessStatus = result.operatorNextCommands?.find((item) => item.key === "readiness_status");
    const recoveryPreflight = result.operatorNextCommands?.find((item) => item.key === "recovery_preflight");
    const routeMapGateDryRun = result.operatorNextCommands?.find((item) => item.key === "route_map_gate_dry_run");
    const routeMapGate = result.operatorNextCommands?.find((item) => item.key === "route_map_gate");
    const routeMapGateBackfill = result.operatorNextCommands?.find((item) => item.key === "route_map_gate_result_backfill");
    const postRouteMapReadinessStatus = result.operatorNextCommands?.find((item) => item.key === "post_route_map_readiness_status");
    const smokePreflight = result.operatorNextCommands?.find((item) => item.key === "staging_smoke_preflight");
    const launchSmokeStaging = result.operatorNextCommands?.find((item) => item.key === "run_launch_smoke_staging");
    const postSmokeBackfills = (result.operatorNextCommands || []).filter((item) => item.key?.startsWith("backfill_post_smoke_"));
    const postSmokeReadinessStatus = result.operatorNextCommands?.find((item) => item.key === "post_smoke_readiness_status");
    const fullTestWindow = result.operatorNextCommands?.find((item) => item.key === "run_full_test_window");
    const fullTestSignoffBackfill = result.operatorNextCommands?.find((item) => item.key === "backfill_full_test_window_passed");
    const postFullTestReadinessStatus = result.operatorNextCommands?.find((item) => item.key === "post_full_test_readiness_status");
    const productionSignoffBackfills = (result.operatorNextCommands || []).filter((item) => item.key?.startsWith("backfill_production_signoff_"));
    const receiptVisibilityBackfills = (result.operatorNextCommands || []).filter((item) => item.key?.startsWith("backfill_receipt_visibility_"));
    const postProductionSignoffReadinessStatus = result.operatorNextCommands?.find((item) => item.key === "post_production_signoff_readiness_status");
    const launchDayWatchRecord = result.operatorNextCommands?.find((item) => item.key === "record_launch_day_watch_summary");
    const stabilizationRecords = (result.operatorNextCommands || []).filter((item) => item.key?.startsWith("record_stabilization_"));
    const postFirstWaveCloseoutReadinessStatus = result.operatorNextCommands?.find((item) => item.key === "post_first_wave_closeout_readiness_status");
    const postFirstWaveCloseoutRehearsalReload = result.operatorNextCommands?.find((item) => item.key === "post_first_wave_closeout_rehearsal_reload");
    const stableOperationsHandoff = result.operatorNextCommands?.find((item) => item.key === "handoff_stable_operations");
    if (currentCommand) {
      console.log(`Current command: ${currentCommand.command}`);
    } else {
      console.log(result.nextCommand);
    }
    if (closeoutInit) {
      console.log(`Closeout init: ${closeoutInit.command}`);
    } else {
      console.log(result.closeoutInitCommand);
    }
    if (readinessStatus) {
      console.log(`Readiness status: ${readinessStatus.command}`);
      if (readinessStatus.artifactPath) {
        console.log(`Action queue file: ${readinessStatus.artifactPath}`);
      }
    } else {
      console.log(result.postCloseoutInitStatusCommand);
    }
    if (recoveryPreflight) {
      console.log(`Recovery preflight: ${recoveryPreflight.command}`);
    }
    if (routeMapGateDryRun) {
      console.log(`Route-map gate dry run: ${routeMapGateDryRun.command}`);
    }
    if (routeMapGate) {
      console.log(`Route-map gate: ${routeMapGate.command}`);
    }
    if (routeMapGateBackfill) {
      console.log(`Route-map result backfill: ${routeMapGateBackfill.command}`);
    }
    if (postRouteMapReadinessStatus) {
      console.log(`Post-route-map readiness status: ${postRouteMapReadinessStatus.command}`);
    }
    if (smokePreflight) {
      console.log(`Staging smoke preflight: ${smokePreflight.command}`);
    }
    if (launchSmokeStaging) {
      console.log(`Launch smoke staging: ${launchSmokeStaging.command}`);
    }
    if (postSmokeBackfills.length) {
      postSmokeBackfills.forEach((item, index) => {
        console.log(`Post-smoke backfill ${index + 1}. ${item.targetKey}: ${item.status} -> ${item.command}`);
      });
    }
    if (postSmokeReadinessStatus) {
      console.log(`Post-smoke readiness status: ${postSmokeReadinessStatus.command}`);
    }
    if (fullTestWindow) {
      console.log(`Full-test window: ${fullTestWindow.command}`);
    }
    if (fullTestSignoffBackfill) {
      console.log(`Full-test signoff backfill: ${fullTestSignoffBackfill.command}`);
    }
    if (postFullTestReadinessStatus) {
      console.log(`Post-full-test readiness status: ${postFullTestReadinessStatus.command}`);
    }
    if (productionSignoffBackfills.length) {
      productionSignoffBackfills.forEach((item, index) => {
        console.log(`Production signoff backfill ${index + 1}. ${item.targetKey}: ${item.status} -> ${item.command}`);
      });
    }
    if (receiptVisibilityBackfills.length) {
      receiptVisibilityBackfills.forEach((item, index) => {
        console.log(`Receipt visibility backfill ${index + 1}. ${item.targetKey}: ${item.status} -> ${item.command}`);
      });
    }
    if (postProductionSignoffReadinessStatus) {
      console.log(`Post-production-signoff readiness status: ${postProductionSignoffReadinessStatus.command}`);
    }
    if (launchDayWatchRecord) {
      console.log(`Launch-day watch record: ${launchDayWatchRecord.command}`);
    }
    if (stabilizationRecords.length) {
      stabilizationRecords.forEach((item, index) => {
        console.log(`Stabilization record ${index + 1}. ${item.targetKey}: ${item.status} -> ${item.command}`);
      });
    }
    if (postFirstWaveCloseoutReadinessStatus) {
      console.log(`Post-first-wave closeout readiness status: ${postFirstWaveCloseoutReadinessStatus.command}`);
    }
    if (postFirstWaveCloseoutRehearsalReload) {
      console.log(`Post-first-wave closeout rehearsal reload: ${postFirstWaveCloseoutRehearsalReload.command}`);
    }
    if (stableOperationsHandoff) {
      console.log(`Stable-operations handoff: ${(stableOperationsHandoff.handoffArtifacts || []).join("; ") || "-"}`);
    }
    console.log(`Next action: ${result.nextAction}`);
    return;
  }
  console.log(`Staging profile init failed: ${result.error.message}`);
}

function main() {
  const json = process.argv.includes("--json");
  try {
    const options = parseArgs(process.argv.slice(2));
    const { archiveRoot, profile } = buildProfile(options);
    const closeoutDraftFile = profile.filledCloseoutDraftFile;
    const closeoutInputFile = path.posix.join(archiveRoot, "filled-closeout-input.json");
    const readinessActionQueueFile = profile.readinessActionQueueFile;
    const productionProofExecutionPackFile = path.posix.join(archiveRoot, "production-proof-execution-pack.md");
    const backupRestoreArtifactFile = path.posix.join(archiveRoot, "backup-restore-drill.txt");
    const routeMapGateDryRunFile = path.posix.join(archiveRoot, "route-map-gate-dry-run.json");
    const routeMapGateOutputFile = path.posix.join(archiveRoot, "route-map-gate-output.txt");
    const launchSmokeOutputFile = path.posix.join(archiveRoot, "live-write-smoke-output.json");
    const launchSmokeHandoffFile = path.posix.join(archiveRoot, "launch-smoke-handoff.json");
    const launchMainlineEvidenceReceiptsFile = path.posix.join(archiveRoot, "launch-mainline-evidence-receipts.json");
    const receiptVisibilityReviewFile = path.posix.join(archiveRoot, "receipt-visibility-review.txt");
    const operatorGoNoGoFile = path.posix.join(archiveRoot, "operator-go-no-go.md");
    const fullTestOutputFile = path.posix.join(archiveRoot, "full-test-output.txt");
    const stagingArtifactsArchiveFile = path.posix.join(archiveRoot, "staging-artifacts-archive.txt");
    const launchMainlineReceiptsVisibleFile = path.posix.join(archiveRoot, "launch-mainline-receipts-visible.json");
    const launchOpsOverviewStatusVisibleFile = path.posix.join(archiveRoot, "launch-ops-overview-status-visible.json");
    const rollbackPathConfirmedFile = path.posix.join(archiveRoot, "rollback-path-confirmed.md");
    const operatorProductionSignoffFile = path.posix.join(archiveRoot, "operator-production-signoff.md");
    const launchDutyRecordIndexFile = path.posix.join(archiveRoot, "launch-duty-record-index.json");
    const launchDayWatchSummaryFile = path.posix.join(archiveRoot, "launch-day-watch-summary.md");
    const receiptVisibilitySnapshotFile = path.posix.join(archiveRoot, "receipt-visibility-snapshot.txt");
    const firstWaveIncidentLogFile = path.posix.join(archiveRoot, "first-wave-incident-log.md");
    const rollbackSignalReviewFile = path.posix.join(archiveRoot, "rollback-signal-review.md");
    const stabilizationOwnerHandoffFile = path.posix.join(archiveRoot, "stabilization-owner-handoff.md");
    const firstWaveCloseoutFile = path.posix.join(archiveRoot, "first-wave-closeout.md");
    const outputFile = options.outputFile
      ? path.resolve(options.outputFile)
      : path.resolve("artifacts", "staging", sanitizeArtifactSegment(options.productCode, "product"), sanitizeArtifactSegment(options.channel || "stable", "stable"), "staging-rehearsal-profile.json");
    const nextCommand = `npm.cmd run staging:rehearsal -- --profile-file ${commandValue(outputFile)}`;
    const closeoutInitCommand = `npm.cmd run staging:closeout:init -- --draft-file ${commandValue(closeoutDraftFile)} --output-file ${commandValue(closeoutInputFile)} --actions-file ${commandValue(readinessActionQueueFile)}`;
    const postCloseoutInitStatusCommand = `npm.cmd run staging:readiness:status -- --input-file ${commandValue(closeoutInputFile)} --actions-file ${commandValue(readinessActionQueueFile)}`;
    const recoveryPreflightCommand = buildRecoveryPreflightCommand({
      options,
      closeoutInputFile,
      readinessActionQueueFile
    });
    const productionProofPreflightCommand = buildProductionProofPreflightCommand({
      options,
      closeoutInputFile,
      readinessActionQueueFile,
      outputFile,
      backupRestoreArtifactFile,
      productionProofExecutionPackFile
    });
    profile.productionProofExecutionPackFile = productionProofExecutionPackFile;
    profile.productionProofPreflightCommand = productionProofPreflightCommand;
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    const routeMapGateDryRunCommand = buildRouteMapGateCommand({
      options,
      closeoutInputFile,
      readinessActionQueueFile,
      dryRun: true
    });
    const routeMapGateCommand = buildRouteMapGateCommand({
      options,
      closeoutInputFile,
      readinessActionQueueFile
    });
    const routeMapGateBackfillCommand = buildRouteMapGateBackfillCommand({
      closeoutInputFile,
      readinessActionQueueFile,
      routeMapGateOutputFile
    });
    const backupRestoreDrillBackfillCommand = buildCloseoutEvidenceBackfillCommand({
      closeoutInputFile,
      readinessActionQueueFile,
      key: "backup_restore_drill_result",
      artifactPath: backupRestoreArtifactFile,
      receiptIds: ["<record_recovery_drill-receipt-id>", "<record_backup_verification-receipt-id>"]
    });
    const operatorGoNoGoBackfillCommand = buildCloseoutEvidenceBackfillCommand({
      closeoutInputFile,
      readinessActionQueueFile,
      key: "operator_go_no_go",
      artifactPath: operatorGoNoGoFile
    });
    const postRouteMapReadinessStatusCommand = postCloseoutInitStatusCommand;
    const smokePreflightCommand = buildStagingSmokePreflightCommand(options);
    const launchSmokeStagingCommand = buildLaunchSmokeStagingCommand({
      options,
      closeoutInputFile,
      readinessActionQueueFile
    });
    const postSmokeBackfillCommands = buildPostSmokeBackfillCommands({
      closeoutInputFile,
      readinessActionQueueFile,
      artifactPaths: {
        launchSmokeOutputFile,
        launchSmokeHandoffFile,
        launchMainlineEvidenceReceiptsFile,
        receiptVisibilityReviewFile
      }
    });
    const postSmokeReadinessStatusCommand = postCloseoutInitStatusCommand;
    const fullTestCommand = "npm.cmd test";
    const fullTestSignoffBackfillCommand = buildFullTestSignoffBackfillCommand({
      closeoutInputFile,
      readinessActionQueueFile,
      fullTestOutputFile
    });
    const postFullTestReadinessStatusCommand = postCloseoutInitStatusCommand;
    const productionSignoffBackfillCommands = buildProductionSignoffBackfillCommands({
      closeoutInputFile,
      readinessActionQueueFile,
      artifactPaths: {
        stagingArtifactsArchiveFile,
        launchMainlineReceiptsVisibleFile,
        launchOpsOverviewStatusVisibleFile,
        backupRestoreArtifactFile,
        rollbackPathConfirmedFile,
        operatorProductionSignoffFile
      }
    });
    const receiptVisibilityBackfillCommands = buildReceiptVisibilityBackfillCommands({
      closeoutInputFile,
      readinessActionQueueFile,
      archiveRoot
    });
    const postProductionSignoffReadinessStatusCommand = postCloseoutInitStatusCommand;
    const postFirstWaveCloseoutReadinessStatusCommand = postCloseoutInitStatusCommand;
    const postFirstWaveCloseoutRehearsalReloadCommand = buildRehearsalReloadCommand(closeoutInputFile);
    const launchDayWatchRecordCommand = buildLaunchDutyRecordCommand({
      closeoutInputFile,
      readinessActionQueueFile,
      launchDutyRecordIndexFile,
      key: "launch_day_watch_summary",
      artifactPath: launchDayWatchSummaryFile,
      receiptIds: ["<record_cutover_walkthrough-receipt-id>", "<record_launch_day_readiness_review-receipt-id>"]
    });
    const stabilizationRecordCommands = buildStabilizationRecordCommands({
      closeoutInputFile,
      readinessActionQueueFile,
      launchDutyRecordIndexFile,
      artifactPaths: {
        receiptVisibilitySnapshotFile,
        firstWaveIncidentLogFile,
        rollbackSignalReviewFile,
        stabilizationOwnerHandoffFile,
        firstWaveCloseoutFile
      }
    });
    const stableOperationsHandoff = {
      status: "blocked_until_first_wave_closeout_recorded",
      recordIndexFile: launchDutyRecordIndexFile,
      firstWaveCloseoutArtifactPath: firstWaveCloseoutFile,
      readinessStatusCommand: postFirstWaveCloseoutReadinessStatusCommand,
      rehearsalReloadCommand: postFirstWaveCloseoutRehearsalReloadCommand,
      rehearsalHandoffFile: profile.handoffFile,
      handoffArtifacts: [launchDutyRecordIndexFile, firstWaveCloseoutFile],
      nextAction: "After first_wave_closeout records 6/6, refresh readiness, reload rehearsal, then hand off the completed record index and first-wave closeout artifact to stable operations."
    };
    const launchLaneFiles = buildLaunchLaneFiles({
      archiveRoot,
      outputFile,
      profile,
      closeoutInputFile,
      readinessActionQueueFile,
      productionProofExecutionPackFile,
      backupRestoreArtifactFile,
      routeMapGateDryRunFile,
      routeMapGateOutputFile,
      launchSmokeOutputFile,
      launchSmokeHandoffFile,
      launchMainlineEvidenceReceiptsFile,
      receiptVisibilityReviewFile,
      operatorGoNoGoFile,
      fullTestOutputFile,
      launchDayWatchSummaryFile,
      receiptVisibilitySnapshotFile,
      firstWaveIncidentLogFile,
      rollbackSignalReviewFile,
      stabilizationOwnerHandoffFile,
      firstWaveCloseoutFile,
      launchDutyRecordIndexFile
    });
    const operatorNextCommands = buildOperatorNextCommands({
      outputFile,
      closeoutInputFile,
      readinessActionQueueFile,
      backupRestoreArtifactFile,
      nextCommand,
      closeoutInitCommand,
      postCloseoutInitStatusCommand,
      recoveryPreflightCommand,
      routeMapGateDryRunCommand,
      routeMapGateCommand,
      routeMapGateBackfillCommand,
      postRouteMapReadinessStatusCommand,
      smokePreflightCommand,
      launchSmokeStagingCommand,
      postSmokeBackfillCommands,
      postSmokeReadinessStatusCommand,
      fullTestCommand,
      fullTestOutputFile,
      fullTestSignoffBackfillCommand,
      postFullTestReadinessStatusCommand,
      productionSignoffBackfillCommands,
      receiptVisibilityBackfillCommands,
      postProductionSignoffReadinessStatusCommand,
      postFirstWaveCloseoutReadinessStatusCommand,
      postFirstWaveCloseoutRehearsalReloadCommand,
      stableOperationsHandoff,
      launchDutyRecordIndexFile,
      launchDayWatchRecordCommand,
      launchDayWatchSummaryFile,
      stabilizationRecordCommands,
      routeMapGateDryRunFile,
      routeMapGateOutputFile
    });
    const operatorQueueCheckpoint = buildOperatorQueueCheckpoint({
      operatorNextCommands,
      outputFile,
      closeoutInputFile,
      readinessActionQueueFile,
      archiveRoot,
      closeoutInitCommand,
      postCloseoutInitStatusCommand,
      postFirstWaveCloseoutRehearsalReloadCommand,
      postSmokeBackfillCommands,
      productionSignoffBackfillCommands,
      receiptVisibilityBackfillCommands,
      stabilizationRecordCommands
    });
    const launchExecutionPhasePlan = buildLaunchExecutionPhasePlan({
      operatorNextCommands
    });
    const launchEvidenceReadinessGate = buildProfileLaunchEvidenceReadinessGate({
      nextCommand,
      closeoutInputFile,
      readinessActionQueueFile,
      archiveRoot,
      routeMapGateBackfillCommand,
      routeMapGateOutputFile,
      backupRestoreDrillBackfillCommand,
      backupRestoreArtifactFile,
      postSmokeBackfillCommands,
      operatorGoNoGoBackfillCommand,
      operatorGoNoGoFile,
      fullTestCommand,
      fullTestOutputFile,
      fullTestSignoffBackfillCommand,
      productionSignoffBackfillCommands,
      receiptVisibilityBackfillCommands,
      postCloseoutInitStatusCommand,
      postFirstWaveCloseoutRehearsalReloadCommand,
      launchDutyRecordIndexFile,
      launchDayWatchRecordCommand,
      launchDayWatchSummaryFile,
      stabilizationRecordCommands,
      firstWaveCloseoutFile
    });
    const productionSwitchProofPacket = buildProductionSwitchProofPacket({
      options,
      archiveRoot,
      outputFile,
      closeoutInputFile,
      readinessActionQueueFile,
      productionProofExecutionPackFile,
      productionProofPreflightCommand,
      nextCommand,
      recoveryPreflightCommand,
      launchSmokeStagingCommand,
      fullTestCommand,
      fullTestOutputFile,
      postProductionSignoffReadinessStatusCommand,
      launchDayWatchRecordCommand,
      launchDayWatchSummaryFile,
      launchDutyRecordIndexFile
    });
    writeResult({
      status: "written",
      mode: "staging-profile-init",
      outputFile,
      productCode: profile.productCode,
      channel: profile.channel,
      archiveRoot,
      profileKeyCount: Object.keys(profile).length,
      secretPolicy: "passwords_and_bearer_tokens_must_stay_in_environment_variables",
      nextCommand,
      closeoutDraftFile,
      closeoutInputFile,
      readinessActionQueueFile,
      productionProofExecutionPackFile,
      productionProofPreflightCommand,
      launchLaneFiles,
      closeoutInitCommand,
      postCloseoutInitStatusCommand,
      recoveryPreflightCommand,
      routeMapGateDryRunCommand,
      routeMapGateCommand,
      routeMapGateBackfillCommand,
      postRouteMapReadinessStatusCommand,
      smokePreflightCommand,
      launchSmokeStagingCommand,
      postSmokeBackfillCommands,
      postSmokeReadinessStatusCommand,
      fullTestCommand,
      fullTestOutputFile,
      fullTestSignoffBackfillCommand,
      postFullTestReadinessStatusCommand,
      productionSignoffBackfillCommands,
      receiptVisibilityBackfillCommands,
      postProductionSignoffReadinessStatusCommand,
      postFirstWaveCloseoutReadinessStatusCommand,
      postFirstWaveCloseoutRehearsalReloadCommand,
      stableOperationsHandoff: toPublicStableOperationsHandoff(stableOperationsHandoff),
      operatorQueueCheckpoint,
      launchExecutionPhasePlan,
      launchEvidenceReadinessGate,
      productionSwitchProofPacket,
      launchDayWatchRecordCommand,
      stabilizationRecordCommands,
      operatorNextCommands,
      nextAction: "Review the secret-free profile values, set required secret env vars, run nextCommand, then follow operatorNextCommands through closeout init, readiness status, recovery preflight, route-map gate, route-map result backfill, readiness refresh, smoke preflight, live-write smoke, post-smoke closeout backfills, full-test window, full-test signoff backfill, production signoff evidence backfills, receipt visibility backfills, production-signoff readiness refresh, launch-day watch summary, stabilization records, first-wave closeout, and stable-operations handoff."
    }, options.json);
  } catch (error) {
    writeResult({
      status: "fail",
      mode: "staging-profile-init",
      error: {
        message: error.message
      }
    }, json);
    process.exitCode = 1;
  }
}

main();
