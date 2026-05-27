import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function runProfileInit(args) {
  return spawnSync(process.execPath, ["scripts/staging-profile-init.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000
  });
}

function runProfileInitPlain(args) {
  return spawnSync(process.execPath, ["scripts/staging-profile-init.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000
  });
}

function runRehearsal(args) {
  return spawnSync(process.execPath, ["scripts/staging-rehearsal.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      RSL_DEVELOPER_BEARER_TOKEN: "",
      RSL_SMOKE_ADMIN_PASSWORD: "ProfileAdmin123!",
      RSL_SMOKE_DEVELOPER_PASSWORD: "ProfileDeveloper123!"
    },
    timeout: 120_000
  });
}

test("staging profile init writes a secret-free profile with launch-duty output paths", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["staging:profile:init"], "node scripts/staging-profile-init.mjs");

  const tempDir = mkdtempSync(join(tmpdir(), "rsl-profile-init-"));
  try {
    const outputFile = join(tempDir, "staging-profile.json");
    const result = runProfileInit([
      "--base-url",
      "https://staging.example.com",
      "--product-code",
      "PILOT_ALPHA",
      "--channel",
      "beta",
      "--admin-username",
      "admin@example.com",
      "--developer-username",
      "launch.smoke.owner",
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
      "--output-file",
      outputFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.equal(existsSync(outputFile), true);
    const output = JSON.parse(result.stdout);
    const profile = JSON.parse(readFileSync(outputFile, "utf8"));
    const recoveryPreflightCommand = "npm.cmd run recovery:preflight -- --target-os linux --storage-profile postgres-preview --target-env-file /etc/rocksolidlicense/staging.env --app-backup-dir /var/lib/rocksolid/backups --postgres-backup-dir /var/lib/rocksolid/postgres-backups --base-url https://staging.example.com --product-code PILOT_ALPHA --channel beta --closeout-input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md";
    const routeMapGateDryRunCommand = "npm.cmd run launch:route-map-gate -- --dry-run --json --product-code PILOT_ALPHA --channel beta --staging-base-url https://staging.example.com --closeout-input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md";
    const routeMapGateCommand = "npm.cmd run launch:route-map-gate -- --product-code PILOT_ALPHA --channel beta --staging-base-url https://staging.example.com --closeout-input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md";
    const routeMapGateBackfillCommand = "npm.cmd run staging:closeout:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/route-map-gate-output.txt --receipt-id <route-map-gate-receipt-id> --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md";
    const postCloseoutInitStatusCommand = "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md";
    const postRouteMapReadinessStatusCommand = "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md";
    const smokePreflightCommand = "npm.cmd run staging:preflight -- --base-url https://staging.example.com --product-code PILOT_ALPHA --channel beta";
    const launchSmokeStagingCommand = "npm.cmd run launch:smoke:staging -- --base-url https://staging.example.com --allow-live-writes --product-code PILOT_ALPHA --channel beta --closeout-input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md";
    const postSmokeReadinessStatusCommand = "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md";
    const fullTestCommand = "npm.cmd test";
    const fullTestOutputFile = "artifacts/staging/PILOT_ALPHA/beta/full-test-output.txt";
    const fullTestSignoffBackfillCommand = "npm.cmd run staging:signoff:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --condition-key full_test_window_passed --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/full-test-output.txt --decision ready-for-production-signoff --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md";
    const postFullTestReadinessStatusCommand = "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md";
    const productionSignoffBackfillCommands = [
      {
        key: "staging_artifacts_archived",
        status: "blocked_after_post_full_test_readiness_status",
        artifactPath: "artifacts/staging/PILOT_ALPHA/beta/staging-artifacts-archive.txt",
        receiptIds: [],
        command: "npm.cmd run staging:signoff:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --condition-key staging_artifacts_archived --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/staging-artifacts-archive.txt --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
      },
      {
        key: "launch_mainline_receipts_visible",
        status: "blocked_after_staging_artifacts_archived",
        artifactPath: "artifacts/staging/PILOT_ALPHA/beta/launch-mainline-receipts-visible.json",
        receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"],
        command: "npm.cmd run staging:signoff:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --condition-key launch_mainline_receipts_visible --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/launch-mainline-receipts-visible.json --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
      },
      {
        key: "launch_ops_overview_status_visible",
        status: "blocked_after_launch_mainline_receipts_visible",
        artifactPath: "artifacts/staging/PILOT_ALPHA/beta/launch-ops-overview-status-visible.json",
        receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"],
        command: "npm.cmd run staging:signoff:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --condition-key launch_ops_overview_status_visible --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/launch-ops-overview-status-visible.json --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
      },
      {
        key: "backup_restore_drill_passed",
        status: "blocked_after_launch_ops_overview_status_visible",
        artifactPath: "artifacts/staging/PILOT_ALPHA/beta/backup-restore-drill.txt",
        receiptIds: ["<record_recovery_drill-receipt-id>", "<record_backup_verification-receipt-id>"],
        command: "npm.cmd run staging:signoff:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --condition-key backup_restore_drill_passed --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/backup-restore-drill.txt --receipt-id <record_recovery_drill-receipt-id> --receipt-id <record_backup_verification-receipt-id> --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
      },
      {
        key: "rollback_path_confirmed",
        status: "blocked_after_backup_restore_drill_passed",
        artifactPath: "artifacts/staging/PILOT_ALPHA/beta/rollback-path-confirmed.md",
        receiptIds: ["<record_rollback_walkthrough-receipt-id>"],
        command: "npm.cmd run staging:signoff:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --condition-key rollback_path_confirmed --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/rollback-path-confirmed.md --receipt-id <record_rollback_walkthrough-receipt-id> --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
      },
      {
        key: "operator_signoff_recorded",
        status: "blocked_after_rollback_path_confirmed",
        artifactPath: "artifacts/staging/PILOT_ALPHA/beta/operator-production-signoff.md",
        receiptIds: [],
        command: "npm.cmd run staging:signoff:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --condition-key operator_signoff_recorded --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/operator-production-signoff.md --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
      }
    ].map((item) => ({
      ...item,
      nextAction: "Backfill this production sign-off condition, refresh readiness, then continue the sign-off and receipt visibility queue."
    }));
    const receiptVisibilityBackfillCommands = [
      {
        key: "launchMainline",
        status: "blocked_after_operator_signoff_recorded",
        artifactPath: "artifacts/staging/PILOT_ALPHA/beta/launch-mainline-receipt-visibility.json",
        receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"],
        command: "npm.cmd run staging:signoff:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --receipt-lane launchMainline --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/launch-mainline-receipt-visibility.json --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
      },
      {
        key: "launchReview",
        status: "blocked_after_launchMainline_receipt_visibility",
        artifactPath: "artifacts/staging/PILOT_ALPHA/beta/launch-review-receipt-visibility.json",
        receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"],
        command: "npm.cmd run staging:signoff:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --receipt-lane launchReview --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/launch-review-receipt-visibility.json --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
      },
      {
        key: "launchSmoke",
        status: "blocked_after_launchReview_receipt_visibility",
        artifactPath: "artifacts/staging/PILOT_ALPHA/beta/launch-smoke-receipt-visibility.json",
        receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"],
        command: "npm.cmd run staging:signoff:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --receipt-lane launchSmoke --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/launch-smoke-receipt-visibility.json --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
      },
      {
        key: "developerOps",
        status: "blocked_after_launchSmoke_receipt_visibility",
        artifactPath: "artifacts/staging/PILOT_ALPHA/beta/developer-ops-receipt-visibility.json",
        receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"],
        command: "npm.cmd run staging:signoff:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --receipt-lane developerOps --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/developer-ops-receipt-visibility.json --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
      },
      {
        key: "launchOpsOverviewStatus",
        status: "blocked_after_developerOps_receipt_visibility",
        artifactPath: "artifacts/staging/PILOT_ALPHA/beta/launch-ops-overview-status-receipt-visibility.json",
        receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"],
        command: "npm.cmd run staging:signoff:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --receipt-lane launchOpsOverviewStatus --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/launch-ops-overview-status-receipt-visibility.json --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
      }
    ].map((item) => ({
      ...item,
      nextAction: "Backfill this receipt-visibility lane, refresh readiness, then continue toward launch-day watch."
    }));
    const postProductionSignoffReadinessStatusCommand = postFullTestReadinessStatusCommand;
    const postFirstWaveCloseoutReadinessStatusCommand = "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md";
    const postFirstWaveCloseoutRehearsalReloadCommand = "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json";
    const launchDutyRecordIndexFile = "artifacts/staging/PILOT_ALPHA/beta/launch-duty-record-index.json";
    const launchDayWatchSummaryFile = "artifacts/staging/PILOT_ALPHA/beta/launch-day-watch-summary.md";
    const operatorGoNoGoFile = "artifacts/staging/PILOT_ALPHA/beta/operator-go-no-go.md";
    const receiptVisibilitySnapshotFile = "artifacts/staging/PILOT_ALPHA/beta/receipt-visibility-snapshot.txt";
    const firstWaveIncidentLogFile = "artifacts/staging/PILOT_ALPHA/beta/first-wave-incident-log.md";
    const rollbackSignalReviewFile = "artifacts/staging/PILOT_ALPHA/beta/rollback-signal-review.md";
    const stabilizationOwnerHandoffFile = "artifacts/staging/PILOT_ALPHA/beta/stabilization-owner-handoff.md";
    const firstWaveCloseoutFile = "artifacts/staging/PILOT_ALPHA/beta/first-wave-closeout.md";
    const launchDayWatchRecordCommand = "npm.cmd run staging:launch-duty:record -- --closeout-input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --key launch_day_watch_summary --artifact-path artifacts/staging/PILOT_ALPHA/beta/launch-day-watch-summary.md --value-json <redacted-json> --receipt-id <record_cutover_walkthrough-receipt-id> --receipt-id <record_launch_day_readiness_review-receipt-id> --record-index-file artifacts/staging/PILOT_ALPHA/beta/launch-duty-record-index.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md";
    const backupRestoreDrillBackfillCommand = "npm.cmd run staging:closeout:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --key backup_restore_drill_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/backup-restore-drill.txt --receipt-id <record_recovery_drill-receipt-id> --receipt-id <record_backup_verification-receipt-id> --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md";
    const operatorGoNoGoBackfillCommand = "npm.cmd run staging:closeout:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --key operator_go_no_go --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/operator-go-no-go.md --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md";
    const postSmokeBackfillCommands = [
      {
        key: "live_write_smoke_result",
        artifactPath: "artifacts/staging/PILOT_ALPHA/beta/live-write-smoke-output.json",
        receiptIds: ["<record_launch_rehearsal_run-receipt-id>"],
        command: "npm.cmd run staging:closeout:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --key live_write_smoke_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/live-write-smoke-output.json --receipt-id <record_launch_rehearsal_run-receipt-id> --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
      },
      {
        key: "launch_smoke_handoff",
        artifactPath: "artifacts/staging/PILOT_ALPHA/beta/launch-smoke-handoff.json",
        receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"],
        command: "npm.cmd run staging:closeout:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --key launch_smoke_handoff --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/launch-smoke-handoff.json --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
      },
      {
        key: "launch_mainline_evidence_receipts",
        artifactPath: "artifacts/staging/PILOT_ALPHA/beta/launch-mainline-evidence-receipts.json",
        receiptIds: ["<record_launch_rehearsal_run-receipt-id>"],
        command: "npm.cmd run staging:closeout:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --key launch_mainline_evidence_receipts --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/launch-mainline-evidence-receipts.json --receipt-id <record_launch_rehearsal_run-receipt-id> --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
      },
      {
        key: "receipt_visibility_review",
        artifactPath: "artifacts/staging/PILOT_ALPHA/beta/receipt-visibility-review.txt",
        receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"],
        command: "npm.cmd run staging:closeout:backfill -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --key receipt_visibility_review --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/beta/receipt-visibility-review.txt --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
      }
    ];
    const stabilizationRecordCommands = [
      {
        key: "receipt_visibility_snapshot",
        status: "blocked_after_launch_day_watch_summary",
        artifactPath: receiptVisibilitySnapshotFile,
        receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"],
        sourceRecords: [],
        command: "npm.cmd run staging:launch-duty:record -- --closeout-input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --key receipt_visibility_snapshot --artifact-path artifacts/staging/PILOT_ALPHA/beta/receipt-visibility-snapshot.txt --value-json <redacted-json> --receipt-id <record_post_launch_ops_sweep-receipt-id> --record-index-file artifacts/staging/PILOT_ALPHA/beta/launch-duty-record-index.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
        nextAction: "Save receipt visibility snapshots before incident and rollback review records."
      },
      {
        key: "first_wave_incident_log",
        status: "blocked_after_receipt_visibility_snapshot",
        artifactPath: firstWaveIncidentLogFile,
        receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"],
        sourceRecords: [],
        command: "npm.cmd run staging:launch-duty:record -- --closeout-input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --key first_wave_incident_log --artifact-path artifacts/staging/PILOT_ALPHA/beta/first-wave-incident-log.md --value-json <redacted-json> --receipt-id <record_post_launch_ops_sweep-receipt-id> --record-index-file artifacts/staging/PILOT_ALPHA/beta/launch-duty-record-index.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
        nextAction: "Record first-wave incident notes, even when the entry confirms no incidents."
      },
      {
        key: "rollback_signal_review",
        status: "blocked_after_first_wave_incident_log",
        artifactPath: rollbackSignalReviewFile,
        receiptIds: ["<record_rollback_walkthrough-receipt-id>", "<record_launch_stabilization_review-receipt-id>"],
        sourceRecords: [],
        command: "npm.cmd run staging:launch-duty:record -- --closeout-input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --key rollback_signal_review --artifact-path artifacts/staging/PILOT_ALPHA/beta/rollback-signal-review.md --value-json <redacted-json> --receipt-id <record_rollback_walkthrough-receipt-id> --receipt-id <record_launch_stabilization_review-receipt-id> --record-index-file artifacts/staging/PILOT_ALPHA/beta/launch-duty-record-index.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
        nextAction: "Record rollback signal review before handing off stabilization ownership."
      },
      {
        key: "stabilization_owner_handoff",
        status: "blocked_after_rollback_signal_review",
        artifactPath: stabilizationOwnerHandoffFile,
        receiptIds: ["<record_launch_stabilization_review-receipt-id>"],
        sourceRecords: [],
        command: "npm.cmd run staging:launch-duty:record -- --closeout-input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --key stabilization_owner_handoff --artifact-path artifacts/staging/PILOT_ALPHA/beta/stabilization-owner-handoff.md --value-json <redacted-json> --receipt-id <record_launch_stabilization_review-receipt-id> --record-index-file artifacts/staging/PILOT_ALPHA/beta/launch-duty-record-index.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
        nextAction: "Record the stabilization owner handoff before first-wave closeout."
      },
      {
        key: "first_wave_closeout",
        status: "blocked_until_source_records",
        artifactPath: firstWaveCloseoutFile,
        receiptIds: ["<record_launch_closeout_review-receipt-id>"],
        sourceRecords: [
          { key: "first_wave_incident_log", artifactPath: firstWaveIncidentLogFile },
          { key: "rollback_signal_review", artifactPath: rollbackSignalReviewFile },
          { key: "stabilization_owner_handoff", artifactPath: stabilizationOwnerHandoffFile }
        ],
        command: "npm.cmd run staging:launch-duty:record -- --closeout-input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --key first_wave_closeout --artifact-path artifacts/staging/PILOT_ALPHA/beta/first-wave-closeout.md --value-json <redacted-json> --receipt-id <record_launch_closeout_review-receipt-id> --source-record first_wave_incident_log=artifacts/staging/PILOT_ALPHA/beta/first-wave-incident-log.md --source-record rollback_signal_review=artifacts/staging/PILOT_ALPHA/beta/rollback-signal-review.md --source-record stabilization_owner_handoff=artifacts/staging/PILOT_ALPHA/beta/stabilization-owner-handoff.md --record-index-file artifacts/staging/PILOT_ALPHA/beta/launch-duty-record-index.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
        nextAction: "Record first-wave closeout after the incident, rollback, and stabilization handoff source records exist."
      }
    ];
    const launchEvidenceReadinessGate = {
      version: "staging-profile-init-launch-evidence-gate/v1",
      status: "blocked_until_real_launch_evidence_attached",
      currentGate: "profile_rehearsal",
      currentSetupActionKey: "profile_rehearsal",
      currentSetupCommand: `npm.cmd run staging:rehearsal -- --profile-file ${outputFile}`,
      currentEvidenceKey: "route_map_gate_result",
      currentEvidenceType: "closeout_evidence",
      currentEvidenceStatus: "blocked_after_route_map_gate",
      currentCommand: routeMapGateBackfillCommand,
      currentArtifactPath: "artifacts/staging/PILOT_ALPHA/beta/route-map-gate-output.txt",
      closeoutInputFile: "artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json",
      readinessActionQueueFile: "artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
      archiveRoot: "artifacts/staging/PILOT_ALPHA/beta",
      evidenceCount: 21,
      closeoutEvidenceCount: 7,
      productionSignoffEvidenceCount: 7,
      receiptVisibilityEvidenceCount: 5,
      launchDutyEvidenceCount: 2,
      completedEvidenceCount: 0,
      pendingEvidenceCount: 21,
      readinessStatusCommand: postCloseoutInitStatusCommand,
      rehearsalReloadCommand: postFirstWaveCloseoutRehearsalReloadCommand,
      fullTestCommand,
      fullTestOutputArtifact: fullTestOutputFile,
      productionSignoffPacket: "artifacts/staging/PILOT_ALPHA/beta/staging-production-signoff-packet.json",
      launchDayWatchArtifact: launchDayWatchSummaryFile,
      firstWaveCloseoutArtifact: firstWaveCloseoutFile,
      launchDutyRecordIndexPath: launchDutyRecordIndexFile,
      progress: {
        closeout: { completed: 0, total: 7 },
        productionSignoff: { completed: 0, total: 7 },
        receiptVisibility: { completed: 0, total: 5 },
        launchDuty: { completed: 0, total: 2 }
      },
      evidenceItems: [
        {
          order: 1,
          key: "route_map_gate_result",
          type: "closeout_evidence",
          status: "blocked_after_route_map_gate",
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/route-map-gate-output.txt",
          command: routeMapGateBackfillCommand,
          receiptIds: ["<route-map-gate-receipt-id>"]
        },
        {
          order: 2,
          key: "backup_restore_drill_result",
          type: "closeout_evidence",
          status: "blocked_after_recovery_preflight",
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/backup-restore-drill.txt",
          command: backupRestoreDrillBackfillCommand,
          receiptIds: ["<record_recovery_drill-receipt-id>", "<record_backup_verification-receipt-id>"]
        },
        {
          order: 3,
          key: "live_write_smoke_result",
          type: "closeout_evidence",
          status: "blocked_after_launch_smoke_staging",
          artifactPath: postSmokeBackfillCommands[0].artifactPath,
          command: postSmokeBackfillCommands[0].command,
          receiptIds: postSmokeBackfillCommands[0].receiptIds
        },
        {
          order: 4,
          key: "launch_smoke_handoff",
          type: "closeout_evidence",
          status: "blocked_after_live_write_smoke_result",
          artifactPath: postSmokeBackfillCommands[1].artifactPath,
          command: postSmokeBackfillCommands[1].command,
          receiptIds: postSmokeBackfillCommands[1].receiptIds
        },
        {
          order: 5,
          key: "launch_mainline_evidence_receipts",
          type: "closeout_evidence",
          status: "blocked_after_launch_smoke_handoff",
          artifactPath: postSmokeBackfillCommands[2].artifactPath,
          command: postSmokeBackfillCommands[2].command,
          receiptIds: postSmokeBackfillCommands[2].receiptIds
        },
        {
          order: 6,
          key: "receipt_visibility_review",
          type: "closeout_evidence",
          status: "blocked_after_launch_mainline_evidence_receipts",
          artifactPath: postSmokeBackfillCommands[3].artifactPath,
          command: postSmokeBackfillCommands[3].command,
          receiptIds: postSmokeBackfillCommands[3].receiptIds
        },
        {
          order: 7,
          key: "operator_go_no_go",
          type: "closeout_evidence",
          status: "blocked_after_receipt_visibility_review",
          artifactPath: operatorGoNoGoFile,
          command: operatorGoNoGoBackfillCommand,
          receiptIds: []
        },
        {
          order: 8,
          key: "full_test_window_passed",
          type: "production_signoff_condition",
          status: "blocked_after_full_test_window",
          artifactPath: fullTestOutputFile,
          command: fullTestSignoffBackfillCommand,
          receiptIds: []
        },
        ...productionSignoffBackfillCommands.map((item, index) => ({
          order: index + 9,
          key: item.key,
          type: "production_signoff_condition",
          status: item.status,
          artifactPath: item.artifactPath,
          command: item.command,
          receiptIds: item.receiptIds
        })),
        ...receiptVisibilityBackfillCommands.map((item, index) => ({
          order: index + 15,
          key: item.key,
          type: "receipt_visibility_lane",
          status: item.status,
          artifactPath: item.artifactPath,
          command: item.command,
          receiptIds: item.receiptIds
        })),
        {
          order: 20,
          key: "launch_day_watch_summary",
          type: "launch_duty_record",
          status: "blocked_after_production_signoff_readiness_status",
          artifactPath: launchDayWatchSummaryFile,
          command: launchDayWatchRecordCommand,
          receiptIds: ["<record_cutover_walkthrough-receipt-id>", "<record_launch_day_readiness_review-receipt-id>"]
        },
        {
          order: 21,
          key: "first_wave_closeout",
          type: "launch_duty_record",
          status: "blocked_until_source_records",
          artifactPath: firstWaveCloseoutFile,
          command: stabilizationRecordCommands[4].command,
          receiptIds: ["<record_launch_closeout_review-receipt-id>"],
          sourceRecordKeys: ["first_wave_incident_log", "rollback_signal_review", "stabilization_owner_handoff"]
        }
      ],
      nextAction: "Run the current setup command and closeout init, then attach route_map_gate_result as the first real launch evidence item before continuing through readiness refresh, smoke, full-test, signoff, receipt visibility, launch-day watch, and first-wave closeout."
    };
    const productionSwitchProofPacket = {
      version: "staging-profile-init-production-switch-proof-packet/v1",
      status: "blocked_until_real_environment_evidence",
      currentActionKey: "profile_rehearsal",
      currentCommand: `npm.cmd run staging:rehearsal -- --profile-file ${outputFile}`,
      baseUrl: "https://staging.example.com",
      productCode: "PILOT_ALPHA",
      channel: "beta",
      targetOs: "linux",
      storageProfile: "postgres-preview",
      archiveRoot: "artifacts/staging/PILOT_ALPHA/beta",
      closeoutInputFile: "artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json",
      readinessActionQueueFile: "artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
      launchDutyRecordIndexFile,
      localFullSuiteBaseline: {
        command: "npm.cmd test",
        status: "available_from_2026-05-27_full_suite_pass",
        testCount: 192,
        failureCount: 0,
        outputArtifact: fullTestOutputFile,
        nextAction: "Reuse this local baseline unless another meaningful backend/API or launch-control change lands before cutover."
      },
      proofCounts: {
        total: 8,
        ready: 3,
        blocked: 5
      },
      proofItems: [
        {
          order: 1,
          key: "public_https_entrypoint",
          status: "ready_from_profile",
          command: null,
          artifactPath: "https://staging.example.com",
          nextAction: "Keep the public staging entrypoint on HTTPS for all live-write smoke and launch switch checks."
        },
        {
          order: 2,
          key: "non_default_secret_env",
          status: "blocked_until_secret_env_loaded",
          command: `npm.cmd run staging:rehearsal -- --profile-file ${outputFile}`,
          artifactPath: "/etc/rocksolidlicense/staging.env",
          nextAction: "Load non-default admin, developer, and bearer-token secrets from environment variables before rehearsal."
        },
        {
          order: 3,
          key: "storage_profile_selected",
          status: "ready_from_profile",
          command: null,
          artifactPath: "postgres-preview",
          nextAction: "Keep storage profile and backup paths aligned through recovery preflight and staging rehearsal."
        },
        {
          order: 4,
          key: "backup_restore_drill",
          status: "blocked_after_readiness_status",
          command: recoveryPreflightCommand,
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/backup-restore-drill.txt",
          nextAction: "Run recovery preflight and backfill backup_restore_drill_result before live-write smoke."
        },
        {
          order: 5,
          key: "live_write_smoke",
          status: "blocked_after_route_map_gate",
          command: launchSmokeStagingCommand,
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/live-write-smoke-output.json",
          nextAction: "Run launch:smoke:staging only after no-write preflight and route-map gate pass."
        },
        {
          order: 6,
          key: "full_test_window",
          status: "ready_local_baseline_available",
          command: "npm.cmd test",
          artifactPath: fullTestOutputFile,
          nextAction: "Attach the redacted full-suite output artifact before backfilling full_test_window_passed."
        },
        {
          order: 7,
          key: "production_signoff_and_receipts",
          status: "blocked_after_full_test_signoff_backfill",
          command: postProductionSignoffReadinessStatusCommand,
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/staging-production-signoff-packet.json",
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
      ],
      nextAction: "Run profile rehearsal with non-default secrets, execute real-environment proof items in order, then use launch-duty record index as the production switch baseline."
    };
    assert.deepEqual(output.productionSwitchProofPacket, productionSwitchProofPacket);
    assert.deepEqual(
      output.productionSignoffBackfillCommands.map((item) => [item.key, item.status, item.artifactPath, item.command]),
      productionSignoffBackfillCommands.map((item) => [item.key, item.status, item.artifactPath, item.command])
    );
    assert.deepEqual(
      output.receiptVisibilityBackfillCommands.map((item) => [item.key, item.status, item.artifactPath, item.command]),
      receiptVisibilityBackfillCommands.map((item) => [item.key, item.status, item.artifactPath, item.command])
    );
    assert.deepEqual(
      output.operatorNextCommands
        .filter((item) => item.key.startsWith("backfill_production_signoff_"))
        .map((item) => [item.targetKey, item.status, item.command]),
      productionSignoffBackfillCommands.map((item) => [item.key, item.status, item.command])
    );
    assert.deepEqual(
      output.operatorNextCommands
        .filter((item) => item.key.startsWith("backfill_receipt_visibility_"))
        .map((item) => [item.targetKey, item.status, item.command]),
      receiptVisibilityBackfillCommands.map((item) => [item.key, item.status, item.command])
    );
    assert.deepEqual(output.operatorQueueCheckpoint, {
      mode: "staging-profile-operator-queue-checkpoint",
      status: "awaiting_profile_rehearsal",
      currentActionKey: "profile_rehearsal",
      currentCommand: `npm.cmd run staging:rehearsal -- --profile-file ${outputFile}`,
      currentArtifactPath: outputFile,
      actionQueueFile: "artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
      closeoutInputFile: "artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json",
      readinessStatusCommand: "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
      rehearsalReloadCommand: "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json",
      archiveRoot: "artifacts/staging/PILOT_ALPHA/beta",
      totalCommandCount: 39,
      currentCommandCount: 1,
      blockedCommandCount: 38,
      queueCounts: {
        postSmokeBackfillCount: 4,
        productionSignoffBackfillCount: 6,
        receiptVisibilityBackfillCount: 5,
        launchDutyRecordCount: 6,
        stableOperationsCommandCount: 3
      },
      nextMilestoneKey: "closeout_init",
      nextMilestoneCommand: "npm.cmd run staging:closeout:init -- --draft-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.draft.json --output-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
      nextAction: "Run the current profile rehearsal command, then follow closeout_init and readiness_status before recovery preflight."
    });
    assert.deepEqual(output, {
      status: "written",
      mode: "staging-profile-init",
      outputFile,
      productCode: "PILOT_ALPHA",
      channel: "beta",
      archiveRoot: "artifacts/staging/PILOT_ALPHA/beta",
      profileKeyCount: 21,
      secretPolicy: "passwords_and_bearer_tokens_must_stay_in_environment_variables",
      nextCommand: `npm.cmd run staging:rehearsal -- --profile-file ${outputFile}`,
      closeoutDraftFile: "artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.draft.json",
      closeoutInputFile: "artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json",
      readinessActionQueueFile: "artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
      launchLaneFiles: {
        archiveRoot: "artifacts/staging/PILOT_ALPHA/beta",
        profileFile: outputFile,
        closeoutDraftFile: "artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.draft.json",
        closeoutInputFile: "artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json",
        readinessActionQueueFile: "artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
        backupRestoreArtifactFile: "artifacts/staging/PILOT_ALPHA/beta/backup-restore-drill.txt",
        routeMapGateDryRunFile: "artifacts/staging/PILOT_ALPHA/beta/route-map-gate-dry-run.json",
        routeMapGateOutputFile: "artifacts/staging/PILOT_ALPHA/beta/route-map-gate-output.txt",
        launchSmokeOutputFile: "artifacts/staging/PILOT_ALPHA/beta/live-write-smoke-output.json",
        launchSmokeHandoffFile: "artifacts/staging/PILOT_ALPHA/beta/launch-smoke-handoff.json",
        launchMainlineEvidenceReceiptsFile: "artifacts/staging/PILOT_ALPHA/beta/launch-mainline-evidence-receipts.json",
        receiptVisibilityReviewFile: "artifacts/staging/PILOT_ALPHA/beta/receipt-visibility-review.txt",
        operatorGoNoGoFile,
        fullTestOutputFile,
        launchDayWatchSummaryFile,
        receiptVisibilitySnapshotFile,
        firstWaveIncidentLogFile,
        rollbackSignalReviewFile,
        stabilizationOwnerHandoffFile,
        firstWaveCloseoutFile,
        handoffFile: "artifacts/staging/PILOT_ALPHA/beta/staging-rehearsal-handoff.md",
        launchDutyArchiveIndexFile: "artifacts/staging/PILOT_ALPHA/beta/staging-launch-duty-archive-index.json",
        launchDutyRecordIndexFile,
        stableOperationsHandoffArtifacts: [launchDutyRecordIndexFile, firstWaveCloseoutFile],
        nextAction: "Use these paths for the first real staging rehearsal, closeout init, readiness refresh, backup/restore evidence, route-map gate handoff, launch smoke closeout backfills, full-test signoff, launch-day watch records, stabilization records, first-wave closeout, and stable-operations handoff."
      },
      closeoutInitCommand: "npm.cmd run staging:closeout:init -- --draft-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.draft.json --output-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
      postCloseoutInitStatusCommand: "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
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
      stableOperationsHandoff: {
        status: "blocked_until_first_wave_closeout_recorded",
        recordIndexFile: launchDutyRecordIndexFile,
        firstWaveCloseoutArtifactPath: firstWaveCloseoutFile,
        readinessStatusCommand: postFirstWaveCloseoutReadinessStatusCommand,
        rehearsalReloadCommand: postFirstWaveCloseoutRehearsalReloadCommand,
        handoffArtifacts: [launchDutyRecordIndexFile, firstWaveCloseoutFile],
        nextAction: "After first_wave_closeout records 6/6, refresh readiness, reload rehearsal, then hand off the completed record index and first-wave closeout artifact to stable operations."
      },
      operatorQueueCheckpoint: {
        mode: "staging-profile-operator-queue-checkpoint",
        status: "awaiting_profile_rehearsal",
        currentActionKey: "profile_rehearsal",
        currentCommand: `npm.cmd run staging:rehearsal -- --profile-file ${outputFile}`,
        currentArtifactPath: outputFile,
        actionQueueFile: "artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
        closeoutInputFile: "artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json",
        readinessStatusCommand: "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
        rehearsalReloadCommand: "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json",
        archiveRoot: "artifacts/staging/PILOT_ALPHA/beta",
        totalCommandCount: 39,
        currentCommandCount: 1,
        blockedCommandCount: 38,
        queueCounts: {
          postSmokeBackfillCount: 4,
          productionSignoffBackfillCount: 6,
          receiptVisibilityBackfillCount: 5,
          launchDutyRecordCount: 6,
          stableOperationsCommandCount: 3
        },
        nextMilestoneKey: "closeout_init",
        nextMilestoneCommand: "npm.cmd run staging:closeout:init -- --draft-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.draft.json --output-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
        nextAction: "Run the current profile rehearsal command, then follow closeout_init and readiness_status before recovery preflight."
      },
      launchEvidenceReadinessGate,
      productionSwitchProofPacket,
      launchDayWatchRecordCommand,
      stabilizationRecordCommands,
      operatorNextCommands: [
        {
          key: "profile_rehearsal",
          status: "current",
          command: `npm.cmd run staging:rehearsal -- --profile-file ${outputFile}`,
          artifactPath: outputFile,
          nextAction: "Run the profile-driven rehearsal to write launch-duty artifacts and the closeout draft."
        },
        {
          key: "closeout_init",
          status: "blocked_after_profile_rehearsal",
          command: "npm.cmd run staging:closeout:init -- --draft-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.draft.json --output-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json",
          nextAction: "Promote the generated closeout draft into the real filled closeout input."
        },
        {
          key: "readiness_status",
          status: "blocked_after_closeout_init",
          command: "npm.cmd run staging:readiness:status -- --input-file artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.json --actions-file artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
          nextAction: "Refresh the readiness action queue after closeout init."
        },
        {
          key: "recovery_preflight",
          status: "blocked_after_readiness_status",
          command: recoveryPreflightCommand,
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/backup-restore-drill.txt",
          nextAction: "Run recovery preflight to print backup/restore commands and the backup_restore_drill_result closeout backfill handoff."
        },
        {
          key: "route_map_gate_dry_run",
          status: "blocked_after_recovery_preflight",
          command: routeMapGateDryRunCommand,
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/route-map-gate-dry-run.json",
          nextAction: "Review the route-map gate dry-run queue before running the targeted gate."
        },
        {
          key: "route_map_gate",
          status: "blocked_after_route_map_gate_dry_run",
          command: routeMapGateCommand,
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/route-map-gate-output.txt",
          nextAction: "Run the targeted route-map gate, save its output, then follow the route-map operator queue from route_map_gate_result backfill onward."
        },
        {
          key: "route_map_gate_result_backfill",
          status: "blocked_after_route_map_gate",
          command: routeMapGateBackfillCommand,
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/route-map-gate-output.txt",
          nextAction: "Backfill route_map_gate_result after the targeted route-map gate passes."
        },
        {
          key: "post_route_map_readiness_status",
          status: "blocked_after_route_map_gate_result_backfill",
          command: postRouteMapReadinessStatusCommand,
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
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
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/live-write-smoke-output.json",
          nextAction: "Run live-write smoke only after the no-write preflight passes and smoke credentials are loaded."
        },
        {
          key: "backfill_post_smoke_live_write_smoke_result",
          status: "blocked_after_launch_smoke_staging",
          command: postSmokeBackfillCommands[0].command,
          artifactPath: postSmokeBackfillCommands[0].artifactPath,
          targetKey: "live_write_smoke_result",
          receiptIds: postSmokeBackfillCommands[0].receiptIds,
          nextAction: "Backfill the live_write_smoke_result closeout evidence after Launch Smoke writes the output artifact."
        },
        {
          key: "backfill_post_smoke_launch_smoke_handoff",
          status: "blocked_after_live_write_smoke_result",
          command: postSmokeBackfillCommands[1].command,
          artifactPath: postSmokeBackfillCommands[1].artifactPath,
          targetKey: "launch_smoke_handoff",
          receiptIds: postSmokeBackfillCommands[1].receiptIds,
          nextAction: "Backfill the launch_smoke_handoff evidence after saving the smoke handoff JSON."
        },
        {
          key: "backfill_post_smoke_launch_mainline_evidence_receipts",
          status: "blocked_after_launch_smoke_handoff",
          command: postSmokeBackfillCommands[2].command,
          artifactPath: postSmokeBackfillCommands[2].artifactPath,
          targetKey: "launch_mainline_evidence_receipts",
          receiptIds: postSmokeBackfillCommands[2].receiptIds,
          nextAction: "Backfill Launch Mainline evidence receipts after recording the first-wave evidence chain."
        },
        {
          key: "backfill_post_smoke_receipt_visibility_review",
          status: "blocked_after_launch_mainline_evidence_receipts",
          command: postSmokeBackfillCommands[3].command,
          artifactPath: postSmokeBackfillCommands[3].artifactPath,
          targetKey: "receipt_visibility_review",
          receiptIds: postSmokeBackfillCommands[3].receiptIds,
          nextAction: "Backfill receipt_visibility_review after the Launch Review, Launch Smoke, Developer Ops, and Launch Mainline receipt queue is visible."
        },
        {
          key: "post_smoke_readiness_status",
          status: "blocked_after_post_smoke_backfills",
          command: postSmokeReadinessStatusCommand,
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
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
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
          targetKey: "production_signoff",
          nextAction: "Refresh readiness after full_test_window_passed backfill to confirm production sign-off blockers."
        },
        ...productionSignoffBackfillCommands.map((item) => ({
          key: `backfill_production_signoff_${item.key}`,
          status: item.status,
          command: item.command,
          artifactPath: item.artifactPath,
          targetKey: item.key,
          receiptIds: item.receiptIds,
          nextAction: "Backfill this production sign-off condition, refresh readiness, then continue the sign-off and receipt visibility queue."
        })),
        ...receiptVisibilityBackfillCommands.map((item) => ({
          key: `backfill_receipt_visibility_${item.key}`,
          status: item.status,
          command: item.command,
          artifactPath: item.artifactPath,
          targetKey: item.key,
          receiptIds: item.receiptIds,
          nextAction: "Backfill this receipt-visibility lane, refresh readiness, then continue toward launch-day watch."
        })),
        {
          key: "post_production_signoff_readiness_status",
          status: "blocked_after_launchOpsOverviewStatus_receipt_visibility",
          command: postProductionSignoffReadinessStatusCommand,
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
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
        {
          key: "record_stabilization_receipt_visibility_snapshot",
          status: "blocked_after_launch_day_watch_summary",
          command: stabilizationRecordCommands[0].command,
          artifactPath: stabilizationRecordCommands[0].artifactPath,
          targetKey: "receipt_visibility_snapshot",
          receiptIds: stabilizationRecordCommands[0].receiptIds,
          sourceRecords: [],
          recordIndexFile: launchDutyRecordIndexFile,
          nextAction: stabilizationRecordCommands[0].nextAction
        },
        {
          key: "record_stabilization_first_wave_incident_log",
          status: "blocked_after_receipt_visibility_snapshot",
          command: stabilizationRecordCommands[1].command,
          artifactPath: stabilizationRecordCommands[1].artifactPath,
          targetKey: "first_wave_incident_log",
          receiptIds: stabilizationRecordCommands[1].receiptIds,
          sourceRecords: [],
          recordIndexFile: launchDutyRecordIndexFile,
          nextAction: stabilizationRecordCommands[1].nextAction
        },
        {
          key: "record_stabilization_rollback_signal_review",
          status: "blocked_after_first_wave_incident_log",
          command: stabilizationRecordCommands[2].command,
          artifactPath: stabilizationRecordCommands[2].artifactPath,
          targetKey: "rollback_signal_review",
          receiptIds: stabilizationRecordCommands[2].receiptIds,
          sourceRecords: [],
          recordIndexFile: launchDutyRecordIndexFile,
          nextAction: stabilizationRecordCommands[2].nextAction
        },
        {
          key: "record_stabilization_stabilization_owner_handoff",
          status: "blocked_after_rollback_signal_review",
          command: stabilizationRecordCommands[3].command,
          artifactPath: stabilizationRecordCommands[3].artifactPath,
          targetKey: "stabilization_owner_handoff",
          receiptIds: stabilizationRecordCommands[3].receiptIds,
          sourceRecords: [],
          recordIndexFile: launchDutyRecordIndexFile,
          nextAction: stabilizationRecordCommands[3].nextAction
        },
        {
          key: "record_stabilization_first_wave_closeout",
          status: "blocked_until_source_records",
          command: stabilizationRecordCommands[4].command,
          artifactPath: stabilizationRecordCommands[4].artifactPath,
          targetKey: "first_wave_closeout",
          receiptIds: stabilizationRecordCommands[4].receiptIds,
          sourceRecords: stabilizationRecordCommands[4].sourceRecords,
          recordIndexFile: launchDutyRecordIndexFile,
          nextAction: stabilizationRecordCommands[4].nextAction
        },
        {
          key: "post_first_wave_closeout_readiness_status",
          status: "blocked_after_first_wave_closeout",
          command: postFirstWaveCloseoutReadinessStatusCommand,
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md",
          targetKey: "stable_operations_handoff",
          recordIndexFile: launchDutyRecordIndexFile,
          nextAction: "Refresh readiness after first_wave_closeout so the completed launch-duty record index is recognized as stable_operations_handoff."
        },
        {
          key: "post_first_wave_closeout_rehearsal_reload",
          status: "blocked_after_stable_operations_readiness",
          command: postFirstWaveCloseoutRehearsalReloadCommand,
          artifactPath: "artifacts/staging/PILOT_ALPHA/beta/staging-rehearsal-handoff.md",
          targetKey: "stable_operations_handoff",
          recordIndexFile: launchDutyRecordIndexFile,
          nextAction: "Reload rehearsal so the final packet, operator execution plan, and go-live entry surface the stable-operations handoff."
        },
        {
          key: "handoff_stable_operations",
          status: "blocked_after_rehearsal_reload",
          command: null,
          artifactPath: firstWaveCloseoutFile,
          targetKey: "stable_operations_handoff",
          recordIndexFile: launchDutyRecordIndexFile,
          handoffArtifacts: [launchDutyRecordIndexFile, firstWaveCloseoutFile],
          nextAction: "Hand off the completed record index and first-wave closeout artifact to the stable-operations owner."
        }
      ],
      nextAction: "Review the secret-free profile values, set required secret env vars, run nextCommand, then follow operatorNextCommands through closeout init, readiness status, recovery preflight, route-map gate, route-map result backfill, readiness refresh, smoke preflight, live-write smoke, post-smoke closeout backfills, full-test window, full-test signoff backfill, production signoff evidence backfills, receipt visibility backfills, production-signoff readiness refresh, launch-day watch summary, stabilization records, first-wave closeout, and stable-operations handoff."
    });
    assert.deepEqual(profile, {
      baseUrl: "https://staging.example.com",
      productCode: "PILOT_ALPHA",
      channel: "beta",
      adminUsername: "admin@example.com",
      developerUsername: "launch.smoke.owner",
      targetOs: "linux",
      storageProfile: "postgres-preview",
      targetEnvFile: "/etc/rocksolidlicense/staging.env",
      appBackupDir: "/var/lib/rocksolid/backups",
      postgresBackupDir: "/var/lib/rocksolid/postgres-backups",
      handoffFile: "artifacts/staging/PILOT_ALPHA/beta/staging-rehearsal-handoff.md",
      closeoutFile: "artifacts/staging/PILOT_ALPHA/beta/staging-closeout-template.json",
      runRecordFile: "artifacts/staging/PILOT_ALPHA/beta/staging-run-record-index.json",
      artifactManifestFile: "artifacts/staging/PILOT_ALPHA/beta/staging-artifact-manifest.json",
      backupRestorePacketFile: "artifacts/staging/PILOT_ALPHA/beta/staging-backup-restore-drill-packet.json",
      closeoutReloadPacketFile: "artifacts/staging/PILOT_ALPHA/beta/staging-closeout-reload-packet.json",
      readinessReviewPacketFile: "artifacts/staging/PILOT_ALPHA/beta/staging-readiness-review-packet.json",
      productionSignoffPacketFile: "artifacts/staging/PILOT_ALPHA/beta/staging-production-signoff-packet.json",
      launchDutyArchiveIndexFile: "artifacts/staging/PILOT_ALPHA/beta/staging-launch-duty-archive-index.json",
      filledCloseoutDraftFile: "artifacts/staging/PILOT_ALPHA/beta/filled-closeout-input.draft.json",
      readinessActionQueueFile: "artifacts/staging/PILOT_ALPHA/beta/readiness-action-queue.md"
    });
    assert.doesNotMatch(JSON.stringify(profile), /password|bearer|token/i);

    const rehearsal = runRehearsal([
      "--profile-file",
      outputFile,
      "--handoff-file",
      join(tempDir, "handoff.md"),
      "--closeout-file",
      join(tempDir, "closeout.json"),
      "--run-record-file",
      join(tempDir, "run-record-index.json"),
      "--artifact-manifest-file",
      join(tempDir, "artifact-manifest.json"),
      "--backup-restore-packet-file",
      join(tempDir, "backup-restore-packet.json"),
      "--closeout-reload-packet-file",
      join(tempDir, "closeout-reload-packet.json"),
      "--readiness-review-packet-file",
      join(tempDir, "readiness-review-packet.json"),
      "--production-signoff-packet-file",
      join(tempDir, "production-signoff-packet.json"),
      "--launch-duty-archive-index-file",
      join(tempDir, "launch-duty-archive-index.json"),
      "--filled-closeout-draft-file",
      join(tempDir, "filled-closeout-input.draft.json")
    ]);
    assert.equal(rehearsal.status, 0, rehearsal.stderr || rehearsal.stdout);
    assert.equal(rehearsal.stderr, "");
    const rehearsalOutput = JSON.parse(rehearsal.stdout);
    assert.equal(rehearsalOutput.stagingProfile.loaded, true);
    assert.equal(rehearsalOutput.stagingProfile.providedKeys.includes("readinessActionQueueFile"), true);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging profile init prints ordered next commands in plain output", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-profile-init-plain-"));
  try {
    const outputFile = join(tempDir, "staging-profile.json");
    const result = runProfileInitPlain([
      "--base-url",
      "https://staging.example.com",
      "--product-code",
      "PILOT_ALPHA",
      "--channel",
      "beta",
      "--admin-username",
      "admin@example.com",
      "--developer-username",
      "launch.smoke.owner",
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
      "--output-file",
      outputFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Staging profile written: .*staging-profile\.json/);
    assert.match(result.stdout, /Launch lane archive root: artifacts\/staging\/PILOT_ALPHA\/beta/);
    assert.match(result.stdout, /Launch lane profile: .*staging-profile\.json/);
    assert.match(result.stdout, /Launch lane closeout draft: artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.draft\.json/);
    assert.match(result.stdout, /Launch lane closeout input: artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json/);
    assert.match(result.stdout, /Launch lane action queue: artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Launch lane backup\/restore artifact: artifacts\/staging\/PILOT_ALPHA\/beta\/backup-restore-drill\.txt/);
    assert.match(result.stdout, /Launch lane operator go\/no-go: artifacts\/staging\/PILOT_ALPHA\/beta\/operator-go-no-go\.md/);
    assert.match(result.stdout, /Launch lane record index: artifacts\/staging\/PILOT_ALPHA\/beta\/launch-duty-record-index\.json/);
    assert.match(result.stdout, /Operator queue checkpoint: profile_rehearsal \(status=awaiting_profile_rehearsal, total=39, blocked=38\)/);
    assert.match(result.stdout, /Operator queue current: npm\.cmd run staging:rehearsal -- --profile-file .*staging-profile\.json/);
    assert.match(result.stdout, /Operator queue readiness status: npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Operator queue counts: postSmoke=4, signoff=6, receipts=5, launchDutyRecords=6, stableOps=3/);
    assert.match(result.stdout, /Operator queue next milestone: closeout_init -> npm\.cmd run staging:closeout:init -- --draft-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.draft\.json --output-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Launch evidence gate: blocked_until_real_launch_evidence_attached \(current=route_map_gate_result, pending=21\/21\)/);
    assert.match(result.stdout, /Launch evidence setup: profile_rehearsal -> npm\.cmd run staging:rehearsal -- --profile-file .*staging-profile\.json/);
    assert.match(result.stdout, /Launch evidence current: closeout_evidence\/route_map_gate_result -> npm\.cmd run staging:closeout:backfill -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/beta\/route-map-gate-output\.txt --receipt-id <route-map-gate-receipt-id> --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Launch evidence artifact: artifacts\/staging\/PILOT_ALPHA\/beta\/route-map-gate-output\.txt/);
    assert.match(result.stdout, /Launch evidence progress: closeout=0\/7, signoff=0\/7, receipts=0\/5, launchDuty=0\/2/);
    assert.match(result.stdout, /Launch evidence full-test: npm\.cmd test -> artifacts\/staging\/PILOT_ALPHA\/beta\/full-test-output\.txt/);
    assert.match(result.stdout, /Launch evidence production signoff packet: artifacts\/staging\/PILOT_ALPHA\/beta\/staging-production-signoff-packet\.json/);
    assert.match(result.stdout, /Launch evidence launch-day watch: artifacts\/staging\/PILOT_ALPHA\/beta\/launch-day-watch-summary\.md/);
    assert.match(result.stdout, /Launch evidence first-wave closeout: artifacts\/staging\/PILOT_ALPHA\/beta\/first-wave-closeout\.md/);
    assert.match(result.stdout, /Launch evidence next action: Run the current setup command and closeout init, then attach route_map_gate_result as the first real launch evidence item before continuing through readiness refresh, smoke, full-test, signoff, receipt visibility, launch-day watch, and first-wave closeout\./);
    assert.match(result.stdout, /Production switch proof packet: blocked_until_real_environment_evidence \(ready=3\/8, blocked=5\/8, current=profile_rehearsal\)/);
    assert.match(result.stdout, /Production switch local baseline: npm\.cmd test -> artifacts\/staging\/PILOT_ALPHA\/beta\/full-test-output\.txt \(available_from_2026-05-27_full_suite_pass, tests=192, failures=0\)/);
    assert.match(result.stdout, /Production switch proof 1\. public_https_entrypoint: ready_from_profile -> https:\/\/staging\.example\.com/);
    assert.match(result.stdout, /Production switch proof 4\. backup_restore_drill: blocked_after_readiness_status -> npm\.cmd run recovery:preflight -- --target-os linux --storage-profile postgres-preview --target-env-file \/etc\/rocksolidlicense\/staging\.env --app-backup-dir \/var\/lib\/rocksolid\/backups --postgres-backup-dir \/var\/lib\/rocksolid\/postgres-backups --base-url https:\/\/staging\.example\.com --product-code PILOT_ALPHA --channel beta --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Production switch proof 8\. launch_day_watch_and_stabilization: blocked_after_production_signoff_readiness -> npm\.cmd run staging:launch-duty:record -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --key launch_day_watch_summary --artifact-path artifacts\/staging\/PILOT_ALPHA\/beta\/launch-day-watch-summary\.md --value-json <redacted-json> --receipt-id <record_cutover_walkthrough-receipt-id> --receipt-id <record_launch_day_readiness_review-receipt-id> --record-index-file artifacts\/staging\/PILOT_ALPHA\/beta\/launch-duty-record-index\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Production switch next action: Run profile rehearsal with non-default secrets, execute real-environment proof items in order, then use launch-duty record index as the production switch baseline\./);
    assert.match(result.stdout, /Current command: npm\.cmd run staging:rehearsal -- --profile-file .*staging-profile\.json/);
    assert.match(result.stdout, /Closeout init: npm\.cmd run staging:closeout:init -- --draft-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.draft\.json --output-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Readiness status: npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Action queue file: artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Recovery preflight: npm\.cmd run recovery:preflight -- --target-os linux --storage-profile postgres-preview --target-env-file \/etc\/rocksolidlicense\/staging\.env --app-backup-dir \/var\/lib\/rocksolid\/backups --postgres-backup-dir \/var\/lib\/rocksolid\/postgres-backups --base-url https:\/\/staging\.example\.com --product-code PILOT_ALPHA --channel beta --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Route-map gate dry run: npm\.cmd run launch:route-map-gate -- --dry-run --json --product-code PILOT_ALPHA --channel beta --staging-base-url https:\/\/staging\.example\.com --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Route-map gate: npm\.cmd run launch:route-map-gate -- --product-code PILOT_ALPHA --channel beta --staging-base-url https:\/\/staging\.example\.com --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Route-map result backfill: npm\.cmd run staging:closeout:backfill -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/beta\/route-map-gate-output\.txt --receipt-id <route-map-gate-receipt-id> --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Post-route-map readiness status: npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Staging smoke preflight: npm\.cmd run staging:preflight -- --base-url https:\/\/staging\.example\.com --product-code PILOT_ALPHA --channel beta/);
    assert.match(result.stdout, /Launch smoke staging: npm\.cmd run launch:smoke:staging -- --base-url https:\/\/staging\.example\.com --allow-live-writes --product-code PILOT_ALPHA --channel beta --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Post-smoke backfill 1\. live_write_smoke_result: blocked_after_launch_smoke_staging -> npm\.cmd run staging:closeout:backfill -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --key live_write_smoke_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/beta\/live-write-smoke-output\.json --receipt-id <record_launch_rehearsal_run-receipt-id> --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Post-smoke backfill 4\. receipt_visibility_review: blocked_after_launch_mainline_evidence_receipts -> npm\.cmd run staging:closeout:backfill -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --key receipt_visibility_review --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/beta\/receipt-visibility-review\.txt --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Post-smoke readiness status: npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Full-test window: npm\.cmd test/);
    assert.match(result.stdout, /Full-test signoff backfill: npm\.cmd run staging:signoff:backfill -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --condition-key full_test_window_passed --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/beta\/full-test-output\.txt --decision ready-for-production-signoff --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Post-full-test readiness status: npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Production signoff backfill 1\. staging_artifacts_archived: blocked_after_post_full_test_readiness_status -> npm\.cmd run staging:signoff:backfill -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --condition-key staging_artifacts_archived --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/beta\/staging-artifacts-archive\.txt --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Production signoff backfill 6\. operator_signoff_recorded: blocked_after_rollback_path_confirmed -> npm\.cmd run staging:signoff:backfill -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --condition-key operator_signoff_recorded --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/beta\/operator-production-signoff\.md --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Receipt visibility backfill 1\. launchMainline: blocked_after_operator_signoff_recorded -> npm\.cmd run staging:signoff:backfill -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --receipt-lane launchMainline --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/beta\/launch-mainline-receipt-visibility\.json --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Receipt visibility backfill 5\. launchOpsOverviewStatus: blocked_after_developerOps_receipt_visibility -> npm\.cmd run staging:signoff:backfill -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --receipt-lane launchOpsOverviewStatus --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/beta\/launch-ops-overview-status-receipt-visibility\.json --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Post-production-signoff readiness status: npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Launch-day watch record: npm\.cmd run staging:launch-duty:record -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --key launch_day_watch_summary --artifact-path artifacts\/staging\/PILOT_ALPHA\/beta\/launch-day-watch-summary\.md --value-json <redacted-json> --receipt-id <record_cutover_walkthrough-receipt-id> --receipt-id <record_launch_day_readiness_review-receipt-id> --record-index-file artifacts\/staging\/PILOT_ALPHA\/beta\/launch-duty-record-index\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Stabilization record 1\. receipt_visibility_snapshot: blocked_after_launch_day_watch_summary -> npm\.cmd run staging:launch-duty:record -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --key receipt_visibility_snapshot --artifact-path artifacts\/staging\/PILOT_ALPHA\/beta\/receipt-visibility-snapshot\.txt --value-json <redacted-json> --receipt-id <record_post_launch_ops_sweep-receipt-id> --record-index-file artifacts\/staging\/PILOT_ALPHA\/beta\/launch-duty-record-index\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Stabilization record 5\. first_wave_closeout: blocked_until_source_records -> npm\.cmd run staging:launch-duty:record -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --key first_wave_closeout --artifact-path artifacts\/staging\/PILOT_ALPHA\/beta\/first-wave-closeout\.md --value-json <redacted-json> --receipt-id <record_launch_closeout_review-receipt-id> --source-record first_wave_incident_log=artifacts\/staging\/PILOT_ALPHA\/beta\/first-wave-incident-log\.md --source-record rollback_signal_review=artifacts\/staging\/PILOT_ALPHA\/beta\/rollback-signal-review\.md --source-record stabilization_owner_handoff=artifacts\/staging\/PILOT_ALPHA\/beta\/stabilization-owner-handoff\.md --record-index-file artifacts\/staging\/PILOT_ALPHA\/beta\/launch-duty-record-index\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Post-first-wave closeout readiness status: npm\.cmd run staging:readiness:status -- --input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json --actions-file artifacts\/staging\/PILOT_ALPHA\/beta\/readiness-action-queue\.md/);
    assert.match(result.stdout, /Post-first-wave closeout rehearsal reload: npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/beta\/filled-closeout-input\.json/);
    assert.match(result.stdout, /Stable-operations handoff: artifacts\/staging\/PILOT_ALPHA\/beta\/launch-duty-record-index\.json; artifacts\/staging\/PILOT_ALPHA\/beta\/first-wave-closeout\.md/);
    assert.match(result.stdout, /Next action: Review the secret-free profile values, set required secret env vars, run nextCommand, then follow operatorNextCommands through closeout init, readiness status, recovery preflight, route-map gate, route-map result backfill, readiness refresh, smoke preflight, live-write smoke, post-smoke closeout backfills, full-test window, full-test signoff backfill, production signoff evidence backfills, receipt visibility backfills, production-signoff readiness refresh, launch-day watch summary, stabilization records, first-wave closeout, and stable-operations handoff\./);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging profile init refuses secret CLI values", () => {
  const result = runProfileInit([
    "--base-url",
    "https://staging.example.com",
    "--product-code",
    "PILOT_ALPHA",
    "--admin-password",
    "SuperSecret123!"
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "fail");
  assert.match(output.error.message, /secret values are not accepted/i);
  assert.doesNotMatch(result.stdout, /SuperSecret123!/);
});
