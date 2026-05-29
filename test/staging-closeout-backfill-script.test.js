import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const closeoutKeys = [
  "route_map_gate_result",
  "backup_restore_drill_result",
  "live_write_smoke_result",
  "launch_smoke_handoff",
  "launch_mainline_evidence_receipts",
  "receipt_visibility_review",
  "operator_go_no_go"
];

const validRehearsalArgs = [
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

function runBackfill(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/staging-closeout-backfill.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    },
    timeout: 120_000
  });
}

function runBackfillPlain(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/staging-closeout-backfill.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    },
    timeout: 120_000
  });
}

function runRehearsal(args) {
  return spawnSync(process.execPath, ["scripts/staging-rehearsal.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      RSL_DEVELOPER_BEARER_TOKEN: ""
    },
    timeout: 120_000
  });
}

function writeCloseoutInput(file, overrides = {}) {
  const payload = {
    mode: "staging-closeout-input-draft",
    status: "awaiting_real_evidence",
    decision: null,
    acceptanceFields: closeoutKeys.map((key) => ({
      key,
      status: "pending_operator_entry",
      value: null,
      sourceStep: key === "operator_go_no_go" ? "backfill_filled_closeout_input" : `source_${key}`,
      artifactPath: `artifacts/staging/PILOT_ALPHA/stable/${key}.txt`,
      receiptOperations: [],
      operatorNote: "Replace null with real redacted staging evidence."
    })),
    receiptVisibility: {},
    productionSignoff: {
      decision: null,
      conditions: []
    },
    ...overrides
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeAlmostFullTestReadyInput(file) {
  const payload = {
    mode: "staging-closeout-input-draft",
    status: "awaiting_go_no_go",
    decision: null,
    acceptanceFields: closeoutKeys.map((key) => ({
      key,
      status: key === "operator_go_no_go" ? "pending_operator_entry" : "filled",
      value: key === "operator_go_no_go" ? null : { result: "pass" },
      sourceStep: key === "operator_go_no_go" ? "backfill_filled_closeout_input" : `source_${key}`,
      artifactPath: `artifacts/staging/PILOT_ALPHA/stable/${key}.txt`,
      receiptOperations: [],
      operatorNote: "Replace null with real redacted staging evidence."
    })),
    receiptVisibility: {},
    productionSignoff: {
      decision: null,
      conditions: []
    }
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function buildExpectedLaunchEvidenceGate({
  closeoutInputFile,
  actionsFile,
  currentKey,
  currentStatus,
  currentCommand,
  currentArtifactPath,
  closeoutItems,
  completedEvidenceCount,
  closeoutCompleted,
  status = "blocked_until_real_launch_evidence_attached"
}) {
  const archiveRoot = "artifacts/staging/PILOT_ALPHA/stable";
  const statusCommand = `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`;
  const reloadCommand = `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`;
  const signoffItems = [
    {
      order: 8,
      key: "full_test_window_passed",
      type: "production_signoff_condition",
      status: "blocked_after_full_test_window",
      artifactPath: `${archiveRoot}/full-test-output.txt`,
      command: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key full_test_window_passed --value-json <redacted-json> --artifact-path ${archiveRoot}/full-test-output.txt --decision ready-for-production-signoff --actions-file ${actionsFile}`,
      receiptIds: []
    },
    {
      order: 9,
      key: "staging_artifacts_archived",
      type: "production_signoff_condition",
      status: "blocked_after_post_full_test_readiness_status",
      artifactPath: `${archiveRoot}/staging-artifacts-archive.txt`,
      command: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key staging_artifacts_archived --value-json <redacted-json> --artifact-path ${archiveRoot}/staging-artifacts-archive.txt --actions-file ${actionsFile}`,
      receiptIds: []
    },
    {
      order: 10,
      key: "launch_mainline_receipts_visible",
      type: "production_signoff_condition",
      status: "blocked_after_staging_artifacts_archived",
      artifactPath: `${archiveRoot}/launch-mainline-receipts-visible.json`,
      command: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key launch_mainline_receipts_visible --value-json <redacted-json> --artifact-path ${archiveRoot}/launch-mainline-receipts-visible.json --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file ${actionsFile}`,
      receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
    },
    {
      order: 11,
      key: "launch_ops_overview_status_visible",
      type: "production_signoff_condition",
      status: "blocked_after_launch_mainline_receipts_visible",
      artifactPath: `${archiveRoot}/launch-ops-overview-status-visible.json`,
      command: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key launch_ops_overview_status_visible --value-json <redacted-json> --artifact-path ${archiveRoot}/launch-ops-overview-status-visible.json --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file ${actionsFile}`,
      receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
    },
    {
      order: 12,
      key: "backup_restore_drill_passed",
      type: "production_signoff_condition",
      status: "blocked_after_launch_ops_overview_status_visible",
      artifactPath: `${archiveRoot}/backup-restore-drill.txt`,
      command: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key backup_restore_drill_passed --value-json <redacted-json> --artifact-path ${archiveRoot}/backup-restore-drill.txt --receipt-id <record_recovery_drill-receipt-id> --receipt-id <record_backup_verification-receipt-id> --actions-file ${actionsFile}`,
      receiptIds: ["<record_recovery_drill-receipt-id>", "<record_backup_verification-receipt-id>"]
    },
    {
      order: 13,
      key: "rollback_path_confirmed",
      type: "production_signoff_condition",
      status: "blocked_after_backup_restore_drill_passed",
      artifactPath: `${archiveRoot}/rollback-path-confirmed.md`,
      command: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key rollback_path_confirmed --value-json <redacted-json> --artifact-path ${archiveRoot}/rollback-path-confirmed.md --receipt-id <record_rollback_walkthrough-receipt-id> --actions-file ${actionsFile}`,
      receiptIds: ["<record_rollback_walkthrough-receipt-id>"]
    },
    {
      order: 14,
      key: "operator_signoff_recorded",
      type: "production_signoff_condition",
      status: "blocked_after_rollback_path_confirmed",
      artifactPath: `${archiveRoot}/operator-production-signoff.md`,
      command: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key operator_signoff_recorded --value-json <redacted-json> --artifact-path ${archiveRoot}/operator-production-signoff.md --actions-file ${actionsFile}`,
      receiptIds: []
    }
  ];
  const receiptItems = [
    ["launchMainline", "blocked_after_operator_signoff_recorded", "launch-mainline-receipt-visibility.json"],
    ["launchReview", "blocked_after_launchMainline_receipt_visibility", "launch-review-receipt-visibility.json"],
    ["launchSmoke", "blocked_after_launchReview_receipt_visibility", "launch-smoke-receipt-visibility.json"],
    ["developerOps", "blocked_after_launchSmoke_receipt_visibility", "developer-ops-receipt-visibility.json"],
    ["launchOpsOverviewStatus", "blocked_after_developerOps_receipt_visibility", "launch-ops-overview-status-receipt-visibility.json"]
  ].map(([key, laneStatus, fileName], index) => ({
    order: index + 15,
    key,
    type: "receipt_visibility_lane",
    status: laneStatus,
    artifactPath: `${archiveRoot}/${fileName}`,
    command: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --receipt-lane ${key} --value-json <redacted-json> --artifact-path ${archiveRoot}/${fileName} --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file ${actionsFile}`,
    receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
  }));
  return {
    version: "staging-closeout-backfill-launch-evidence-gate/v1",
    status,
    currentGate: "closeout_backfill",
    currentEvidenceKey: currentKey,
    currentEvidenceType: currentKey === "full_test_window_passed" ? "production_signoff_condition" : "closeout_evidence",
    currentEvidenceStatus: currentStatus,
    currentCommand,
    currentArtifactPath,
    closeoutInputFile,
    readinessActionQueueFile: actionsFile,
    archiveRoot,
    evidenceCount: 21,
    closeoutEvidenceCount: 7,
    productionSignoffEvidenceCount: 7,
    receiptVisibilityEvidenceCount: 5,
    launchDutyEvidenceCount: 2,
    completedEvidenceCount,
    pendingEvidenceCount: 21 - completedEvidenceCount,
    readinessStatusCommand: statusCommand,
    rehearsalReloadCommand: reloadCommand,
    fullTestCommand: "npm.cmd test",
    fullTestOutputArtifact: `${archiveRoot}/full-test-output.txt`,
    productionSignoffPacket: `${archiveRoot}/staging-production-signoff-packet.json`,
    launchDayWatchArtifact: `${archiveRoot}/launch-day-watch-summary.md`,
    firstWaveCloseoutArtifact: `${archiveRoot}/first-wave-closeout.md`,
    launchDutyRecordIndexPath: `${archiveRoot}/launch-duty-record-index.json`,
    progress: {
      closeout: { completed: closeoutCompleted, total: 7 },
      productionSignoff: { completed: 0, total: 7 },
      receiptVisibility: { completed: 0, total: 5 },
      launchDuty: { completed: 0, total: 2 }
    },
    evidenceItems: [
      ...closeoutItems,
      ...signoffItems,
      ...receiptItems,
      {
        order: 20,
        key: "launch_day_watch_summary",
        type: "launch_duty_record",
        status: "blocked_after_production_signoff_readiness_status",
        artifactPath: `${archiveRoot}/launch-day-watch-summary.md`,
        command: `npm.cmd run staging:launch-duty:record -- --closeout-input-file ${closeoutInputFile} --key launch_day_watch_summary --artifact-path ${archiveRoot}/launch-day-watch-summary.md --value-json <redacted-json> --receipt-id <record_cutover_walkthrough-receipt-id> --receipt-id <record_launch_day_readiness_review-receipt-id> --record-index-file ${archiveRoot}/launch-duty-record-index.json --actions-file ${actionsFile}`,
        receiptIds: ["<record_cutover_walkthrough-receipt-id>", "<record_launch_day_readiness_review-receipt-id>"]
      },
      {
        order: 21,
        key: "first_wave_closeout",
        type: "launch_duty_record",
        status: "blocked_until_source_records",
        artifactPath: `${archiveRoot}/first-wave-closeout.md`,
        command: `npm.cmd run staging:launch-duty:record -- --closeout-input-file ${closeoutInputFile} --key first_wave_closeout --artifact-path ${archiveRoot}/first-wave-closeout.md --value-json <redacted-json> --receipt-id <record_launch_closeout_review-receipt-id> --source-record first_wave_incident_log=${archiveRoot}/first-wave-incident-log.md --source-record rollback_signal_review=${archiveRoot}/rollback-signal-review.md --source-record stabilization_owner_handoff=${archiveRoot}/stabilization-owner-handoff.md --record-index-file ${archiveRoot}/launch-duty-record-index.json --actions-file ${actionsFile}`,
        receiptIds: ["<record_launch_closeout_review-receipt-id>"],
        sourceRecordKeys: ["first_wave_incident_log", "rollback_signal_review", "stabilization_owner_handoff"]
      }
    ],
    nextAction: "Run readinessStatusCommand, verify the backfilled evidence is reflected, then continue the next launch evidence command."
  };
}

function buildExpectedProductionSwitchProofPacket({
  closeoutInputFile,
  actionsFile,
  archiveRoot,
  currentActionKey,
  currentCommand,
  backupRestoreStatus = "blocked_after_readiness_status",
  liveWriteStatus = "blocked_after_route_map_gate",
  fullTestStatus = "ready_local_baseline_available",
  productionSignoffStatus = "blocked_after_full_test_signoff_backfill",
  launchDutyStatus = "blocked_after_production_signoff_readiness"
}) {
  const backupRestoreCommand = backupRestoreStatus.startsWith("ready_")
    ? null
    : `npm.cmd run staging:closeout:backfill -- --input-file ${closeoutInputFile} --key backup_restore_drill_result --value-json <redacted-json> --artifact-path ${archiveRoot}/backup_restore_drill_result.txt --actions-file ${actionsFile}`;
  const liveWriteCommand = liveWriteStatus.startsWith("ready_")
    ? null
    : `npm.cmd run staging:closeout:backfill -- --input-file ${closeoutInputFile} --key live_write_smoke_result --value-json <redacted-json> --artifact-path ${archiveRoot}/live_write_smoke_result.txt --actions-file ${actionsFile}`;
  const proofItems = [
    {
      order: 1,
      key: "public_https_entrypoint",
      status: "pending_real_environment_value",
      command: null,
      artifactPath: null,
      nextAction: "Keep the public staging entrypoint on HTTPS for all live-write smoke and launch switch checks."
    },
    {
      order: 2,
      key: "non_default_secret_env",
      status: "pending_real_environment_confirmation",
      command: null,
      artifactPath: null,
      nextAction: "Confirm non-default admin, developer, and bearer-token secrets are loaded from environment variables before continuing evidence backfill."
    },
    {
      order: 3,
      key: "storage_profile_selected",
      status: "pending_real_environment_value",
      command: null,
      artifactPath: null,
      nextAction: "Keep storage profile and backup paths aligned through recovery preflight and staging evidence backfill."
    },
    {
      order: 4,
      key: "backup_restore_drill",
      status: backupRestoreStatus,
      command: backupRestoreCommand,
      artifactPath: `${archiveRoot}/backup_restore_drill_result.txt`,
      nextAction: "Attach backup/restore drill evidence before live-write smoke and production sign-off."
    },
    {
      order: 5,
      key: "live_write_smoke",
      status: liveWriteStatus,
      command: liveWriteCommand,
      artifactPath: `${archiveRoot}/live_write_smoke_result.txt`,
      nextAction: "Attach launch:smoke:staging output after no-write preflight and route-map gate pass."
    },
    {
      order: 6,
      key: "full_test_window",
      status: fullTestStatus,
      command: "npm.cmd test",
      artifactPath: `${archiveRoot}/full-test-output.txt`,
      nextAction: "Attach the redacted full-suite output artifact before or while backfilling full_test_window_passed."
    },
    {
      order: 7,
      key: "production_signoff_and_receipts",
      status: productionSignoffStatus,
      command: null,
      artifactPath: `${archiveRoot}/staging-production-signoff-packet.json`,
      nextAction: "Backfill production sign-off conditions and receipt visibility lanes before launch-day watch."
    },
    {
      order: 8,
      key: "launch_day_watch_and_stabilization",
      status: launchDutyStatus,
      command: null,
      artifactPath: `${archiveRoot}/launch-day-watch-summary.md`,
      nextAction: "Record launch-day watch, stabilization, and first-wave closeout records into the shared launch-duty record index."
    }
  ];
  const ready = proofItems.filter((item) => item.status.startsWith("ready_")).length;
  return {
    version: "staging-closeout-backfill-production-switch-proof-packet/v1",
    status: ready === proofItems.length ? "ready_for_production_switch_review" : "blocked_until_real_environment_evidence",
    currentActionKey,
    currentCommand,
    baseUrl: null,
    productCode: "PILOT_ALPHA",
    channel: "stable",
    targetOs: null,
    storageProfile: null,
    archiveRoot,
    closeoutInputFile,
    readinessActionQueueFile: actionsFile,
    launchDutyRecordIndexFile: `${archiveRoot}/launch-duty-record-index.json`,
    secretEnvProof: {
      status: "pending_real_environment_confirmation",
      requiredKeys: [],
      presentKeys: [],
      missingKeys: [],
      requiredCount: 0,
      missingCount: 0,
      currentMissingKey: null,
      targetEnvFile: null,
      currentActionKey: "bind_required_secret_env",
      nextAction: "Bind the required secret environment variable names before continuing production switch proof."
    },
    localFullSuiteBaseline: {
      command: "npm.cmd test",
      status: "available_from_2026-05-28_full_suite_pass",
      testCount: 198,
      failureCount: 0,
      outputArtifact: `${archiveRoot}/full-test-output.txt`,
      nextAction: "Reuse this local baseline unless another meaningful backend/API or launch-control change lands before cutover."
    },
    proofCounts: {
      total: proofItems.length,
      ready,
      blocked: proofItems.length - ready
    },
    proofItems,
    nextAction: "Continue the current closeout evidence command, rerun staging:readiness:status, then use this packet as the production switch proof checklist."
  };
}

test("staging closeout backfill writes one evidence field without clearing remaining readiness", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["staging:closeout:backfill"], "node scripts/staging-closeout-backfill.mjs");

  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-backfill-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeCloseoutInput(closeoutInputFile);

    const result = runBackfill([
      "--input-file",
      closeoutInputFile,
      "--actions-file",
      actionsFile,
      "--key",
      "route_map_gate_result",
      "--value-json",
      "{\"result\":\"pass\",\"exitCode\":0}",
      "--artifact-path",
      "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt",
      "--receipt-id",
      "receipt-route-map-001"
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    const archiveRoot = "artifacts/staging/PILOT_ALPHA/stable";
    const firstCloseoutItems = closeoutKeys.map((key, index) => ({
      order: index + 1,
      key,
      type: "closeout_evidence",
      status: key === "route_map_gate_result" ? "filled" : "pending_operator_entry",
      artifactPath: key === "route_map_gate_result"
        ? "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt"
        : `artifacts/staging/PILOT_ALPHA/stable/${key}.txt`,
      command: `npm.cmd run staging:closeout:backfill -- --input-file ${closeoutInputFile} --key ${key} --value-json <redacted-json> --artifact-path ${
        key === "route_map_gate_result"
          ? "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt"
          : `artifacts/staging/PILOT_ALPHA/stable/${key}.txt`
      } --actions-file ${actionsFile}`,
      receiptIds: key === "route_map_gate_result" ? ["receipt-route-map-001"] : []
    }));
    const launchEvidenceReadinessGate = buildExpectedLaunchEvidenceGate({
      closeoutInputFile,
      actionsFile,
      currentKey: "backup_restore_drill_result",
      currentStatus: "pending_operator_entry",
      currentCommand: `npm.cmd run staging:closeout:backfill -- --input-file ${closeoutInputFile} --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/backup_restore_drill_result.txt --actions-file ${actionsFile}`,
      currentArtifactPath: "artifacts/staging/PILOT_ALPHA/stable/backup_restore_drill_result.txt",
      closeoutItems: firstCloseoutItems,
      completedEvidenceCount: 1,
      closeoutCompleted: 1
    });
    assert.deepEqual(output, {
      status: "written",
      mode: "staging-closeout-backfill",
      inputFile: closeoutInputFile,
      outputFile: closeoutInputFile,
      actionsFile,
      targetType: "closeout_evidence",
      key: "route_map_gate_result",
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt",
      receiptIds: ["receipt-route-map-001"],
      filledFieldCount: 1,
      remainingPlaceholderCount: 6,
      evidenceProgress: {
        status: "awaiting_more_closeout_evidence",
        requiredCount: 7,
        filledCount: 1,
        pendingCount: 6,
        currentTarget: {
          key: "backup_restore_drill_result",
          status: "pending_operator_entry",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/backup_restore_drill_result.txt",
          sourceStep: "source_backup_restore_drill_result",
          receiptOperations: []
        },
        pendingKeys: [
          "backup_restore_drill_result",
          "live_write_smoke_result",
          "launch_smoke_handoff",
          "launch_mainline_evidence_receipts",
          "receipt_visibility_review",
          "operator_go_no_go"
        ],
        nextBackfillCommand: `npm.cmd run staging:closeout:backfill -- --input-file ${closeoutInputFile} --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/backup_restore_drill_result.txt --actions-file ${actionsFile}`,
        statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
        nextAction: "Run statusCommand, then run nextBackfillCommand with real redacted evidence."
      },
      launchEvidenceReadinessGate,
      productionSwitchProofPacket: buildExpectedProductionSwitchProofPacket({
        closeoutInputFile,
        actionsFile,
        archiveRoot,
        currentActionKey: "backfill_closeout_evidence",
        currentCommand: `npm.cmd run staging:closeout:backfill -- --input-file ${closeoutInputFile} --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/backup_restore_drill_result.txt --actions-file ${actionsFile}`
      }),
      nextCloseoutEvidenceHandoff: {
        status: "ready_for_next_closeout_backfill",
        currentActionKey: "backfill_closeout_evidence",
        backfilledKey: "route_map_gate_result",
        progress: {
          requiredCount: 7,
          filledCount: 1,
          pendingCount: 6
        },
        statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
        nextBackfillCommand: `npm.cmd run staging:closeout:backfill -- --input-file ${closeoutInputFile} --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/backup_restore_drill_result.txt --actions-file ${actionsFile}`,
        nextBackfillTarget: {
          key: "backup_restore_drill_result",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/backup_restore_drill_result.txt",
          sourceStep: "source_backup_restore_drill_result",
          receiptOperations: []
        },
        actionQueueFile: actionsFile,
        reloadCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
        nextAction: "Run statusCommand, then nextBackfillCommand with real redacted evidence before the rehearsal reload."
      },
      nextCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
      statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
      operatorNextCommands: [
        {
          key: "readiness_status",
          status: "current",
          command: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
          artifactPath: actionsFile,
          nextAction: "Refresh the readiness action queue after this evidence backfill."
        },
        {
          key: "next_closeout_backfill",
          status: "blocked_after_readiness_status",
          command: `npm.cmd run staging:closeout:backfill -- --input-file ${closeoutInputFile} --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/backup_restore_drill_result.txt --actions-file ${actionsFile}`,
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/backup_restore_drill_result.txt",
          nextAction: "Backfill the next pending closeout evidence item after the readiness action queue is refreshed."
        },
        {
          key: "rehearsal_reload",
          status: "blocked_after_next_closeout_backfill",
          command: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
          artifactPath: closeoutInputFile,
          nextAction: "Reload rehearsal after status confirms the next gate or all closeout evidence is ready."
        }
      ],
      operatorQueueCheckpoint: {
        mode: "staging-closeout-backfill-operator-queue-checkpoint",
        status: "awaiting_closeout_readiness_refresh",
        currentActionKey: "readiness_status",
        currentCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
        actionQueueFile: actionsFile,
        outputFile: closeoutInputFile,
        backfilledTargetType: "closeout_evidence",
        backfilledKey: "route_map_gate_result",
        backfilledArtifactPath: "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt",
        filledFieldCount: 1,
        requiredFieldCount: 7,
        pendingFieldCount: 6,
        nextBackfillType: "closeout_evidence",
        nextBackfillKey: "backup_restore_drill_result",
        nextBackfillCommand: `npm.cmd run staging:closeout:backfill -- --input-file ${closeoutInputFile} --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/backup_restore_drill_result.txt --actions-file ${actionsFile}`,
        nextBackfillArtifactPath: "artifacts/staging/PILOT_ALPHA/stable/backup_restore_drill_result.txt",
        fullTestReadyStatus: null,
        fullTestCommand: null,
        fullTestResultArtifactPath: null,
        productionSignoffPacketPath: null,
        signoffBackfillCommand: null,
        operatorCommandCount: 3,
        nextAction: "Run the readiness status refresh, then continue the next closeout evidence backfill."
      },
      nextAction: "Run statusCommand to pick the next closeout, full-test, or sign-off action."
    });

    const closeoutInput = JSON.parse(readFileSync(closeoutInputFile, "utf8"));
    const field = closeoutInput.acceptanceFields.find((item) => item.key === "route_map_gate_result");
    assert.equal(field.status, "filled");
    assert.deepEqual(field.value, {
      result: "pass",
      exitCode: 0,
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt",
      receiptIds: ["receipt-route-map-001"]
    });
    assert.equal(closeoutInput.acceptanceFields.filter((item) => item.value !== null).length, 1);

    const rehearsal = runRehearsal([
      ...validRehearsalArgs,
      "--closeout-input-file",
      closeoutInputFile
    ]);
    assert.equal(rehearsal.status, 0, rehearsal.stderr || rehearsal.stdout);
    const rehearsalOutput = JSON.parse(rehearsal.stdout);
    assert.equal(rehearsalOutput.closeoutInput.backfillReview.filledFieldCount, 1);
    assert.equal(rehearsalOutput.closeoutInput.backfillReview.missingFieldCount, 6);
    assert.equal(rehearsalOutput.operatorExecutionPlan.readinessSummary.canRunFullTestWindow, false);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging closeout backfill marks bound non-default secret env ready when required env vars are present", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-backfill-secret-env-"));
  try {
    const inputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeCloseoutInput(inputFile, {
      baseUrl: "https://staging.example.com",
      storageProfile: "postgres-preview",
      stagingEnvironmentBinding: {
        environment: {
          targetEnvFile: "/etc/rocksolidlicense/staging.env"
        },
        credentialEnv: {
          adminPassword: "RSL_SMOKE_ADMIN_PASSWORD",
          developerPassword: "RSL_SMOKE_DEVELOPER_PASSWORD",
          developerBearerToken: "RSL_DEVELOPER_BEARER_TOKEN"
        }
      }
    });

    const result = runBackfill([
      "--input-file",
      inputFile,
      "--key",
      "route_map_gate_result",
      "--value-json",
      "{\"result\":\"pass\"}",
      "--artifact-path",
      "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt",
      "--actions-file",
      actionsFile
    ], {
      RSL_SMOKE_ADMIN_PASSWORD: "RealAdminSecret123!",
      RSL_SMOKE_DEVELOPER_PASSWORD: "RealDeveloperSecret123!",
      RSL_DEVELOPER_BEARER_TOKEN: "real-bearer-token"
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(
      output.productionSwitchProofPacket.proofItems.slice(0, 3).map((item) => [item.key, item.status, item.artifactPath]),
      [
        ["public_https_entrypoint", "ready_from_closeout_input", "https://staging.example.com"],
        ["non_default_secret_env", "ready_secret_env_loaded", "/etc/rocksolidlicense/staging.env"],
        ["storage_profile_selected", "ready_from_closeout_input", "postgres-preview"]
      ]
    );
    assert.deepEqual(output.productionSwitchProofPacket.secretEnvProof, {
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
    assert.deepEqual(output.productionSwitchProofPacket.proofCounts, {
      total: 8,
      ready: 4,
      blocked: 4
    });
    assert.doesNotMatch(JSON.stringify(output), /RealAdminSecret123!|RealDeveloperSecret123!|real-bearer-token/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging closeout backfill prints secret env proof in plain output without secret values", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-backfill-secret-env-plain-"));
  try {
    const inputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeCloseoutInput(inputFile, {
      stagingEnvironmentBinding: {
        environment: {
          targetEnvFile: "/etc/rocksolidlicense/staging.env"
        },
        credentialEnv: {
          adminPassword: "RSL_SMOKE_ADMIN_PASSWORD",
          developerPassword: "RSL_SMOKE_DEVELOPER_PASSWORD",
          developerBearerToken: "RSL_DEVELOPER_BEARER_TOKEN"
        }
      }
    });

    const result = runBackfillPlain([
      "--input-file",
      inputFile,
      "--key",
      "route_map_gate_result",
      "--value-json",
      "{\"result\":\"pass\"}",
      "--artifact-path",
      "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt",
      "--actions-file",
      actionsFile
    ], {
      RSL_SMOKE_ADMIN_PASSWORD: "RealAdminSecret123!",
      RSL_SMOKE_DEVELOPER_PASSWORD: "RealDeveloperSecret123!",
      RSL_DEVELOPER_BEARER_TOKEN: ""
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Production switch secret env proof: pending_real_environment_confirmation \(required=3, missing=1, current=RSL_DEVELOPER_BEARER_TOKEN\)/);
    assert.match(result.stdout, /Production switch secret env required: RSL_SMOKE_ADMIN_PASSWORD, RSL_SMOKE_DEVELOPER_PASSWORD, RSL_DEVELOPER_BEARER_TOKEN/);
    assert.match(result.stdout, /Production switch secret env missing: RSL_DEVELOPER_BEARER_TOKEN/);
    assert.doesNotMatch(result.stdout, /RealAdminSecret123!|RealDeveloperSecret123!/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging closeout backfill prints ordered next commands in plain output", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-backfill-plain-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeCloseoutInput(closeoutInputFile);

    const result = runBackfillPlain([
      "--input-file",
      closeoutInputFile,
      "--actions-file",
      actionsFile,
      "--key",
      "route_map_gate_result",
      "--value-json",
      "{\"result\":\"pass\",\"exitCode\":0}",
      "--artifact-path",
      "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt",
      "--receipt-id",
      "receipt-route-map-001"
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Closeout evidence backfilled: route_map_gate_result/);
    assert.match(result.stdout, /Backfilled target: closeout_evidence\/route_map_gate_result/);
    assert.match(result.stdout, /Backfilled artifact path: artifacts\/staging\/PILOT_ALPHA\/stable\/route-map-gate-output\.txt/);
    assert.match(result.stdout, /Backfilled receipt IDs: receipt-route-map-001/);
    assert.match(result.stdout, /Closeout evidence progress: 1\/7 filled, 6 pending/);
    assert.match(result.stdout, /Next closeout target: backup_restore_drill_result/);
    assert.match(result.stdout, /Next target artifact: artifacts\/staging\/PILOT_ALPHA\/stable\/backup_restore_drill_result\.txt/);
    assert.match(result.stdout, /Next target source step: source_backup_restore_drill_result/);
    assert.match(result.stdout, /Next backfill command: npm\.cmd run staging:closeout:backfill -- --input-file .*filled-closeout-input\.json --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/backup_restore_drill_result\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Closeout operator checkpoint: readiness_status \(status=awaiting_closeout_readiness_refresh, commands=3\)/);
    assert.match(result.stdout, /Closeout checkpoint current: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Closeout checkpoint progress: 1\/7 filled, 6 pending/);
    assert.match(result.stdout, /Closeout checkpoint next backfill: closeout_evidence\/backup_restore_drill_result -> npm\.cmd run staging:closeout:backfill -- --input-file .*filled-closeout-input\.json --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/backup_restore_drill_result\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Closeout checkpoint next action: Run the readiness status refresh, then continue the next closeout evidence backfill\./);
    assert.match(result.stdout, /Launch evidence gate: blocked_until_real_launch_evidence_attached \(current=backup_restore_drill_result, pending=20\/21\)/);
    assert.match(result.stdout, /Launch evidence current: closeout_evidence\/backup_restore_drill_result -> npm\.cmd run staging:closeout:backfill -- --input-file .*filled-closeout-input\.json --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/backup_restore_drill_result\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Launch evidence progress: closeout=1\/7, signoff=0\/7, receipts=0\/5, launchDuty=0\/2/);
    assert.match(result.stdout, /Launch evidence readiness status: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Launch evidence full-test: npm\.cmd test -> artifacts\/staging\/PILOT_ALPHA\/stable\/full-test-output\.txt/);
    assert.match(result.stdout, /Launch evidence production signoff packet: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.match(result.stdout, /Launch evidence next action: Run readinessStatusCommand, verify the backfilled evidence is reflected, then continue the next launch evidence command\./);
    assert.match(result.stdout, /Production switch proof packet: blocked_until_real_environment_evidence \(ready=1\/8, blocked=7\/8, current=backfill_closeout_evidence\)/);
    assert.match(result.stdout, /Production switch proof 6\. full_test_window: ready_local_baseline_available -> npm\.cmd test/);
    assert.match(result.stdout, /Production switch next action: Continue the current closeout evidence command, rerun staging:readiness:status, then use this packet as the production switch proof checklist\./);
    assert.match(result.stdout, /Next closeout handoff: ready_for_next_closeout_backfill/);
    assert.match(result.stdout, /Next closeout status refresh: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Next closeout backfill: npm\.cmd run staging:closeout:backfill -- --input-file .*filled-closeout-input\.json --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/backup_restore_drill_result\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Next closeout target: backup_restore_drill_result -> artifacts\/staging\/PILOT_ALPHA\/stable\/backup_restore_drill_result\.txt/);
    assert.match(result.stdout, /Next closeout source step: source_backup_restore_drill_result/);
    assert.match(result.stdout, /Next closeout progress: 1\/7 filled, 6 pending/);
    assert.match(result.stdout, /Next closeout rehearsal reload: npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json/);
    assert.match(result.stdout, /Next closeout next action: Run statusCommand, then nextBackfillCommand with real redacted evidence before the rehearsal reload\./);
    assert.match(result.stdout, /Backfilled status refresh: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Current command: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Action queue file: .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Next backfill after status: npm\.cmd run staging:closeout:backfill -- --input-file .*filled-closeout-input\.json --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/backup_restore_drill_result\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Rehearsal reload: npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json/);
    assert.match(result.stdout, /Next action: Run statusCommand to pick the next closeout, full-test, or sign-off action\./);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging closeout backfill promotes object operator go/no-go evidence to the closeout decision", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-backfill-go-no-go-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-closeout-input.json");
    writeCloseoutInput(closeoutInputFile);

    const result = runBackfill([
      "--input-file",
      closeoutInputFile,
      "--key",
      "operator_go_no_go",
      "--value-json",
      "{\"decision\":\"ready-for-full-test-window\",\"operator\":\"launch-duty\",\"summary\":\"redacted go/no-go approval\"}",
      "--artifact-path",
      "artifacts/staging/PILOT_ALPHA/stable/operator-go-no-go.md"
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const closeoutInput = JSON.parse(readFileSync(closeoutInputFile, "utf8"));
    assert.equal(closeoutInput.decision, "ready-for-full-test-window");
    const field = closeoutInput.acceptanceFields.find((item) => item.key === "operator_go_no_go");
    assert.equal(field.status, "filled");
    assert.deepEqual(field.value, {
      decision: "ready-for-full-test-window",
      operator: "launch-duty",
      summary: "redacted go/no-go approval",
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/operator-go-no-go.md"
    });
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging closeout backfill prints full-test handoff after final go/no-go evidence", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-backfill-full-test-ready-"));
  try {
    const closeoutInputFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "filled-closeout-input.json");
    const plainCloseoutInputFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "filled-closeout-input-plain.json");
    const actionsFile = join(tempDir, "artifacts", "staging", "PILOT_ALPHA", "stable", "readiness-action-queue.md");
    mkdirSync(dirname(closeoutInputFile), { recursive: true });
    writeAlmostFullTestReadyInput(closeoutInputFile);
    writeAlmostFullTestReadyInput(plainCloseoutInputFile);

    const backfillArgs = [
      "--actions-file",
      actionsFile,
      "--key",
      "operator_go_no_go",
      "--value-json",
      "{\"decision\":\"ready-for-full-test-window\",\"operator\":\"launch-duty\",\"summary\":\"redacted go/no-go approval\"}",
      "--artifact-path",
      "artifacts/staging/PILOT_ALPHA/stable/operator-go-no-go.md"
    ];
    const result = runBackfill([
      "--input-file",
      closeoutInputFile,
      ...backfillArgs
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.remainingPlaceholderCount, 0);
    assert.equal(output.evidenceProgress.status, "filled");
    assert.equal(output.evidenceProgress.nextBackfillCommand, null);
    const fullTestCloseoutItems = closeoutKeys.map((key, index) => ({
      order: index + 1,
      key,
      type: "closeout_evidence",
      status: "filled",
      artifactPath: key === "operator_go_no_go"
        ? "artifacts/staging/PILOT_ALPHA/stable/operator-go-no-go.md"
        : `artifacts/staging/PILOT_ALPHA/stable/${key}.txt`,
      command: `npm.cmd run staging:closeout:backfill -- --input-file ${closeoutInputFile} --key ${key} --value-json <redacted-json> --artifact-path ${
        key === "operator_go_no_go"
          ? "artifacts/staging/PILOT_ALPHA/stable/operator-go-no-go.md"
          : `artifacts/staging/PILOT_ALPHA/stable/${key}.txt`
      } --actions-file ${actionsFile}`,
      receiptIds: []
    }));
    assert.deepEqual(output.launchEvidenceReadinessGate, buildExpectedLaunchEvidenceGate({
      closeoutInputFile,
      actionsFile,
      currentKey: "full_test_window_passed",
      currentStatus: "blocked_after_full_test_window",
      currentCommand: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key full_test_window_passed --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/full-test-output.txt --decision ready-for-production-signoff --actions-file ${actionsFile}`,
      currentArtifactPath: "artifacts/staging/PILOT_ALPHA/stable/full-test-output.txt",
      closeoutItems: fullTestCloseoutItems,
      completedEvidenceCount: 7,
      closeoutCompleted: 7
    }));
    assert.deepEqual(output.operatorQueueCheckpoint, {
      mode: "staging-closeout-backfill-operator-queue-checkpoint",
      status: "ready_for_full_test_window",
      currentActionKey: "readiness_status",
      currentCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
      actionQueueFile: actionsFile,
      outputFile: closeoutInputFile,
      backfilledTargetType: "closeout_evidence",
      backfilledKey: "operator_go_no_go",
      backfilledArtifactPath: "artifacts/staging/PILOT_ALPHA/stable/operator-go-no-go.md",
      filledFieldCount: 7,
      requiredFieldCount: 7,
      pendingFieldCount: 0,
      nextBackfillType: null,
      nextBackfillKey: null,
      nextBackfillCommand: null,
      nextBackfillArtifactPath: null,
      fullTestReadyStatus: "ready_for_full_test_window",
      fullTestCommand: "npm.cmd test",
      fullTestResultArtifactPath: "artifacts/staging/PILOT_ALPHA/stable/full-test-output.txt",
      productionSignoffPacketPath: "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json",
      signoffBackfillCommand: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key full_test_window_passed --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/full-test-output.txt --decision ready-for-production-signoff --actions-file ${actionsFile}`,
      operatorCommandCount: 2,
      nextAction: "Run statusCommand to confirm full-test readiness, run fullTestCommand, then use signoffBackfillCommand with the redacted full-test result."
    });
    assert.deepEqual(output.fullTestReadyHandoff, {
      status: "ready_for_full_test_window",
      currentActionKey: "run_full_test_window",
      statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
      reloadCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
      actionQueueFile: actionsFile,
      fullTestCommand: "npm.cmd test",
      fullTestResultArtifactPath: "artifacts/staging/PILOT_ALPHA/stable/full-test-output.txt",
      productionSignoffPacketPath: "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json",
      signoffBackfillCommand: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key full_test_window_passed --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/full-test-output.txt --decision ready-for-production-signoff --actions-file ${actionsFile}`,
      nextAction: "Run statusCommand to confirm full-test readiness, run fullTestCommand, then use signoffBackfillCommand with the redacted full-test result."
    });
    assert.deepEqual(output.productionSwitchProofPacket, buildExpectedProductionSwitchProofPacket({
      closeoutInputFile,
      actionsFile,
      archiveRoot: "artifacts/staging/PILOT_ALPHA/stable",
      currentActionKey: "run_full_test_window",
      currentCommand: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key full_test_window_passed --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/full-test-output.txt --decision ready-for-production-signoff --actions-file ${actionsFile}`,
      backupRestoreStatus: "ready_evidence_attached",
      liveWriteStatus: "ready_evidence_attached"
    }));

    const plainResult = runBackfillPlain([
      "--input-file",
      plainCloseoutInputFile,
      ...backfillArgs
    ]);

    assert.equal(plainResult.status, 0, plainResult.stderr || plainResult.stdout);
    assert.equal(plainResult.stderr, "");
    assert.match(plainResult.stdout, /Closeout evidence progress: 7\/7 filled, 0 pending/);
    assert.match(plainResult.stdout, /Closeout operator checkpoint: readiness_status \(status=ready_for_full_test_window, commands=2\)/);
    assert.match(plainResult.stdout, /Closeout checkpoint current: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input-plain\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(plainResult.stdout, /Closeout checkpoint progress: 7\/7 filled, 0 pending/);
    assert.match(plainResult.stdout, /Closeout checkpoint full-test readiness: ready_for_full_test_window/);
    assert.match(plainResult.stdout, /Closeout checkpoint full-test command: npm\.cmd test/);
    assert.match(plainResult.stdout, /Closeout checkpoint signoff backfill: npm\.cmd run staging:signoff:backfill -- --input-file .*filled-closeout-input-plain\.json --condition-key full_test_window_passed --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/full-test-output\.txt --decision ready-for-production-signoff --actions-file .*readiness-action-queue\.md/);
    assert.match(plainResult.stdout, /Closeout checkpoint next action: Run statusCommand to confirm full-test readiness, run fullTestCommand, then use signoffBackfillCommand with the redacted full-test result\./);
    assert.match(plainResult.stdout, /Launch evidence gate: blocked_until_real_launch_evidence_attached \(current=full_test_window_passed, pending=14\/21\)/);
    assert.match(plainResult.stdout, /Launch evidence current: production_signoff_condition\/full_test_window_passed -> npm\.cmd run staging:signoff:backfill -- --input-file .*filled-closeout-input-plain\.json --condition-key full_test_window_passed --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/full-test-output\.txt --decision ready-for-production-signoff --actions-file .*readiness-action-queue\.md/);
    assert.match(plainResult.stdout, /Launch evidence progress: closeout=7\/7, signoff=0\/7, receipts=0\/5, launchDuty=0\/2/);
    assert.match(plainResult.stdout, /Production switch proof packet: blocked_until_real_environment_evidence \(ready=3\/8, blocked=5\/8, current=run_full_test_window\)/);
    assert.match(plainResult.stdout, /Production switch proof 4\. backup_restore_drill: ready_evidence_attached -> artifacts\/staging\/PILOT_ALPHA\/stable\/backup_restore_drill_result\.txt/);
    assert.match(plainResult.stdout, /Production switch next action: Continue the current closeout evidence command, rerun staging:readiness:status, then use this packet as the production switch proof checklist\./);
    assert.match(plainResult.stdout, /Full-test readiness: ready_for_full_test_window/);
    assert.match(plainResult.stdout, /Full-test status refresh: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input-plain\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(plainResult.stdout, /Full-test rehearsal reload: npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input-plain\.json/);
    assert.match(plainResult.stdout, /Full-test command: npm\.cmd test/);
    assert.match(plainResult.stdout, /Full-test result artifact: artifacts\/staging\/PILOT_ALPHA\/stable\/full-test-output\.txt/);
    assert.match(plainResult.stdout, /Production signoff packet: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.match(plainResult.stdout, /Full-test signoff backfill: npm\.cmd run staging:signoff:backfill -- --input-file .*filled-closeout-input-plain\.json --condition-key full_test_window_passed --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/full-test-output\.txt --decision ready-for-production-signoff --actions-file .*readiness-action-queue\.md/);
    assert.match(plainResult.stdout, /Full-test next action: Run statusCommand to confirm full-test readiness, run fullTestCommand, then use signoffBackfillCommand with the redacted full-test result\./);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging closeout backfill refuses unknown closeout keys", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-backfill-refuse-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-closeout-input.json");
    writeCloseoutInput(closeoutInputFile);

    const result = runBackfill([
      "--input-file",
      closeoutInputFile,
      "--key",
      "unknown_key",
      "--value-json",
      "{\"result\":\"pass\"}"
    ]);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "fail");
    assert.match(output.error.message, /unknown closeout key/i);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
