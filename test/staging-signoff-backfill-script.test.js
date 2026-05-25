import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const signoffKeys = [
  "full_test_window_passed",
  "staging_artifacts_archived",
  "launch_mainline_receipts_visible",
  "launch_ops_overview_status_visible",
  "backup_restore_drill_passed",
  "rollback_path_confirmed",
  "operator_signoff_recorded"
];

const signoffArtifactFileNames = {
  full_test_window_passed: "full-test-output.txt",
  staging_artifacts_archived: "staging-artifacts-archive.txt",
  launch_mainline_receipts_visible: "launch-mainline-receipts-visible.json",
  launch_ops_overview_status_visible: "launch-ops-overview-status-visible.json",
  backup_restore_drill_passed: "backup-restore-drill.txt",
  rollback_path_confirmed: "rollback-path-confirmed.md",
  operator_signoff_recorded: "operator-production-signoff.md"
};

const receiptVisibilityKeys = [
  "launchMainline",
  "launchReview",
  "launchSmoke",
  "developerOps",
  "launchOpsOverviewStatus"
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

function runBackfill(args) {
  return spawnSync(process.execPath, ["scripts/staging-signoff-backfill.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000
  });
}

function runBackfillPlain(args) {
  return spawnSync(process.execPath, ["scripts/staging-signoff-backfill.mjs", ...args], {
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
      RSL_DEVELOPER_BEARER_TOKEN: ""
    },
    timeout: 120_000
  });
}

function writeReadyForFullTestInput(file) {
  const payload = {
    mode: "staging-closeout-template",
    decision: "ready-for-full-test-window",
    acceptanceFields: closeoutKeys.map((key) => ({
      key,
      status: "filled",
      value: key === "operator_go_no_go"
        ? "ready-for-full-test-window"
        : { result: "pass" }
    })),
    receiptVisibility: {},
    productionSignoff: {
      decision: null,
      conditions: signoffKeys.map((key) => ({
        key,
        status: "pending_operator_entry",
        value: null
      }))
    }
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeReadyForLaunchDutyInput(file) {
  const payload = {
    mode: "staging-closeout-template",
    decision: "ready-for-full-test-window",
    acceptanceFields: closeoutKeys.map((key) => ({
      key,
      status: "filled",
      value: key === "operator_go_no_go"
        ? "ready-for-full-test-window"
        : { result: "pass" }
    })),
    receiptVisibility: Object.fromEntries(
      receiptVisibilityKeys.slice(0, -1).map((key) => [
        key,
        {
          status: "visible",
          artifactPath: `artifacts/staging/PILOT_ALPHA/stable/${key}.json`
        }
      ])
    ),
    productionSignoff: {
      decision: "ready-for-production-signoff",
      conditions: signoffKeys.map((key) => ({
        key,
        status: "filled",
        value: { result: "pass" },
        artifactPath: `artifacts/staging/PILOT_ALPHA/stable/${signoffArtifactFileNames[key]}`
      }))
    }
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function buildCloseoutEvidenceBackfillCommand({ closeoutInputFile, actionsFile, key, artifactPath }) {
  return [
    "npm.cmd run staging:closeout:backfill --",
    `--input-file ${closeoutInputFile}`,
    `--key ${key}`,
    "--value-json <redacted-json>",
    `--artifact-path ${artifactPath}`,
    `--actions-file ${actionsFile}`
  ].join(" ");
}

function buildSignoffEvidenceBackfillCommand({
  closeoutInputFile,
  actionsFile,
  keyFlag,
  key,
  artifactPath,
  receiptIds = [],
  decision = null
}) {
  return [
    "npm.cmd run staging:signoff:backfill --",
    `--input-file ${closeoutInputFile}`,
    `${keyFlag} ${key}`,
    "--value-json <redacted-json>",
    `--artifact-path ${artifactPath}`,
    ...receiptIds.flatMap((receiptId) => ["--receipt-id", receiptId]),
    ...(decision ? ["--decision", decision] : []),
    `--actions-file ${actionsFile}`
  ].join(" ");
}

function buildLaunchDutyRecordCommand({
  closeoutInputFile,
  actionsFile,
  archiveRoot,
  key,
  artifactPath,
  receiptIds = [],
  sourceRecords = []
}) {
  return [
    "npm.cmd run staging:launch-duty:record --",
    `--closeout-input-file ${closeoutInputFile}`,
    `--key ${key}`,
    `--artifact-path ${artifactPath}`,
    "--value-json <redacted-json>",
    ...receiptIds.flatMap((receiptId) => ["--receipt-id", receiptId]),
    ...sourceRecords.flatMap((record) => ["--source-record", `${record.key}=${record.artifactPath}`]),
    `--record-index-file ${archiveRoot}/launch-duty-record-index.json`,
    `--actions-file ${actionsFile}`
  ].join(" ");
}

function buildExpectedLaunchEvidenceGate({
  closeoutInputFile,
  actionsFile,
  currentKey,
  currentType,
  currentStatus,
  currentCommand,
  currentArtifactPath,
  completedEvidenceCount,
  productionSignoffCompleted,
  receiptVisibilityCompleted,
  signoffStatuses = {},
  receiptStatuses = {},
  status = "blocked_until_real_launch_evidence_attached"
}) {
  const archiveRoot = "artifacts/staging/PILOT_ALPHA/stable";
  const statusCommand = `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`;
  const reloadCommand = `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`;
  const closeoutItems = closeoutKeys.map((key, index) => {
    const artifactPath = `${archiveRoot}/${key}.txt`;
    return {
      order: index + 1,
      key,
      type: "closeout_evidence",
      status: "filled",
      artifactPath,
      command: buildCloseoutEvidenceBackfillCommand({
        closeoutInputFile,
        actionsFile,
        key,
        artifactPath
      }),
      receiptIds: []
    };
  });
  const signoffDefinitions = [
    ["full_test_window_passed", "blocked_after_full_test_window", "full-test-output.txt", [], "ready-for-production-signoff"],
    ["staging_artifacts_archived", "blocked_after_post_full_test_readiness_status", "staging-artifacts-archive.txt", []],
    ["launch_mainline_receipts_visible", "blocked_after_staging_artifacts_archived", "launch-mainline-receipts-visible.json", ["<record_post_launch_ops_sweep-receipt-id>"]],
    ["launch_ops_overview_status_visible", "blocked_after_launch_mainline_receipts_visible", "launch-ops-overview-status-visible.json", ["<record_post_launch_ops_sweep-receipt-id>"]],
    ["backup_restore_drill_passed", "blocked_after_launch_ops_overview_status_visible", "backup-restore-drill.txt", ["<record_recovery_drill-receipt-id>", "<record_backup_verification-receipt-id>"]],
    ["rollback_path_confirmed", "blocked_after_backup_restore_drill_passed", "rollback-path-confirmed.md", ["<record_rollback_walkthrough-receipt-id>"]],
    ["operator_signoff_recorded", "blocked_after_rollback_path_confirmed", "operator-production-signoff.md", []]
  ];
  const signoffItems = signoffDefinitions.map(([key, blockedStatus, fileName, receiptIds, decision], index) => {
    const artifactPath = `${archiveRoot}/${fileName}`;
    return {
      order: index + 8,
      key,
      type: "production_signoff_condition",
      status: signoffStatuses[key] || blockedStatus,
      artifactPath,
      command: buildSignoffEvidenceBackfillCommand({
        closeoutInputFile,
        actionsFile,
        keyFlag: "--condition-key",
        key,
        artifactPath,
        receiptIds,
        decision
      }),
      receiptIds
    };
  });
  const receiptItems = [
    ["launchMainline", "blocked_after_operator_signoff_recorded", "launch-mainline-receipt-visibility.json"],
    ["launchReview", "blocked_after_launchMainline_receipt_visibility", "launch-review-receipt-visibility.json"],
    ["launchSmoke", "blocked_after_launchReview_receipt_visibility", "launch-smoke-receipt-visibility.json"],
    ["developerOps", "blocked_after_launchSmoke_receipt_visibility", "developer-ops-receipt-visibility.json"],
    ["launchOpsOverviewStatus", "blocked_after_developerOps_receipt_visibility", "launch-ops-overview-status-receipt-visibility.json"]
  ].map(([key, blockedStatus, fileName], index) => {
    const artifactPath = `${archiveRoot}/${fileName}`;
    const receiptIds = ["<record_post_launch_ops_sweep-receipt-id>"];
    return {
      order: index + 15,
      key,
      type: "receipt_visibility_lane",
      status: receiptStatuses[key] || blockedStatus,
      artifactPath,
      command: buildSignoffEvidenceBackfillCommand({
        closeoutInputFile,
        actionsFile,
        keyFlag: "--receipt-lane",
        key,
        artifactPath,
        receiptIds
      }),
      receiptIds
    };
  });
  const firstWaveSourceRecords = [
    { key: "first_wave_incident_log", artifactPath: `${archiveRoot}/first-wave-incident-log.md` },
    { key: "rollback_signal_review", artifactPath: `${archiveRoot}/rollback-signal-review.md` },
    { key: "stabilization_owner_handoff", artifactPath: `${archiveRoot}/stabilization-owner-handoff.md` }
  ];
  const launchDutyItems = [
    {
      order: 20,
      key: "launch_day_watch_summary",
      type: "launch_duty_record",
      status: "blocked_after_production_signoff_readiness_status",
      artifactPath: `${archiveRoot}/launch-day-watch-summary.md`,
      command: buildLaunchDutyRecordCommand({
        closeoutInputFile,
        actionsFile,
        archiveRoot,
        key: "launch_day_watch_summary",
        artifactPath: `${archiveRoot}/launch-day-watch-summary.md`,
        receiptIds: ["<record_cutover_walkthrough-receipt-id>", "<record_launch_day_readiness_review-receipt-id>"]
      }),
      receiptIds: ["<record_cutover_walkthrough-receipt-id>", "<record_launch_day_readiness_review-receipt-id>"]
    },
    {
      order: 21,
      key: "first_wave_closeout",
      type: "launch_duty_record",
      status: "blocked_until_source_records",
      artifactPath: `${archiveRoot}/first-wave-closeout.md`,
      command: buildLaunchDutyRecordCommand({
        closeoutInputFile,
        actionsFile,
        archiveRoot,
        key: "first_wave_closeout",
        artifactPath: `${archiveRoot}/first-wave-closeout.md`,
        receiptIds: ["<record_launch_closeout_review-receipt-id>"],
        sourceRecords: firstWaveSourceRecords
      }),
      receiptIds: ["<record_launch_closeout_review-receipt-id>"],
      sourceRecordKeys: ["first_wave_incident_log", "rollback_signal_review", "stabilization_owner_handoff"]
    }
  ];

  return {
    version: "staging-signoff-backfill-launch-evidence-gate/v1",
    status,
    currentGate: "production_signoff_backfill",
    currentEvidenceKey: currentKey,
    currentEvidenceType: currentType,
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
      closeout: { completed: 7, total: 7 },
      productionSignoff: { completed: productionSignoffCompleted, total: 7 },
      receiptVisibility: { completed: receiptVisibilityCompleted, total: 5 },
      launchDuty: { completed: 0, total: 2 }
    },
    evidenceItems: [
      ...closeoutItems,
      ...signoffItems,
      ...receiptItems,
      ...launchDutyItems
    ],
    nextAction: "Run readinessStatusCommand, verify the backfilled sign-off or receipt evidence is reflected, then continue the next launch evidence command."
  };
}

test("staging signoff backfill writes one signoff condition and one receipt visibility lane", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["staging:signoff:backfill"], "node scripts/staging-signoff-backfill.mjs");

  const tempDir = mkdtempSync(join(tmpdir(), "rsl-signoff-backfill-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeReadyForFullTestInput(closeoutInputFile);

    const signoffResult = runBackfill([
      "--input-file",
      closeoutInputFile,
      "--actions-file",
      actionsFile,
      "--condition-key",
      "full_test_window_passed",
      "--value-json",
      "{\"result\":\"pass\",\"command\":\"npm.cmd test\",\"failureCount\":0}",
      "--artifact-path",
      "artifacts/staging/PILOT_ALPHA/stable/full-test-output.txt",
      "--receipt-id",
      "receipt-full-test-001",
      "--decision",
      "ready-for-production-signoff"
    ]);

    assert.equal(signoffResult.status, 0, signoffResult.stderr || signoffResult.stdout);
    assert.equal(signoffResult.stderr, "");
    const signoffOutput = JSON.parse(signoffResult.stdout);
    const {
      launchEvidenceReadinessGate: signoffLaunchEvidenceGate,
      ...signoffOutputWithoutGate
    } = signoffOutput;
    assert.deepEqual(signoffLaunchEvidenceGate, buildExpectedLaunchEvidenceGate({
      closeoutInputFile,
      actionsFile,
      currentKey: "staging_artifacts_archived",
      currentType: "production_signoff_condition",
      currentStatus: "blocked_after_post_full_test_readiness_status",
      currentCommand: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key staging_artifacts_archived --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/staging-artifacts-archive.txt --actions-file ${actionsFile}`,
      currentArtifactPath: "artifacts/staging/PILOT_ALPHA/stable/staging-artifacts-archive.txt",
      completedEvidenceCount: 8,
      productionSignoffCompleted: 1,
      receiptVisibilityCompleted: 0,
      signoffStatuses: {
        full_test_window_passed: "filled"
      }
    }));
    assert.deepEqual(signoffOutputWithoutGate, {
      status: "written",
      mode: "staging-signoff-backfill",
      inputFile: closeoutInputFile,
      outputFile: closeoutInputFile,
      actionsFile,
      targetType: "production_signoff_condition",
      key: "full_test_window_passed",
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/full-test-output.txt",
      receiptIds: ["receipt-full-test-001"],
      productionDecision: "ready-for-production-signoff",
      filledConditionCount: 1,
      visibleReceiptLaneCount: 0,
      missingConditionCount: 6,
      missingReceiptLaneCount: 5,
      signoffProgress: {
        status: "awaiting_more_signoff_evidence",
        requiredConditionCount: 7,
        filledConditionCount: 1,
        pendingConditionCount: 6,
        requiredReceiptLaneCount: 5,
        visibleReceiptLaneCount: 0,
        pendingReceiptLaneCount: 5,
        currentTarget: {
          type: "production_signoff_condition",
          key: "staging_artifacts_archived",
          status: "pending_operator_entry",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/staging-artifacts-archive.txt",
          sourceStep: "archive_staging_artifacts",
          receiptOperations: []
        },
        pendingConditionKeys: [
          "staging_artifacts_archived",
          "launch_mainline_receipts_visible",
          "launch_ops_overview_status_visible",
          "backup_restore_drill_passed",
          "rollback_path_confirmed",
          "operator_signoff_recorded"
        ],
        pendingReceiptLaneKeys: receiptVisibilityKeys,
        nextBackfillCommand: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key staging_artifacts_archived --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/staging-artifacts-archive.txt --actions-file ${actionsFile}`,
        statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
        nextAction: "Run statusCommand, then run nextBackfillCommand with real redacted sign-off or receipt evidence."
      },
      nextCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
      statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
      operatorNextCommands: [
        {
          key: "readiness_status",
          status: "current",
          command: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
          artifactPath: actionsFile,
          nextAction: "Refresh the readiness action queue after this sign-off backfill."
        },
        {
          key: "next_signoff_backfill",
          status: "blocked_after_readiness_status",
          command: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key staging_artifacts_archived --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/staging-artifacts-archive.txt --actions-file ${actionsFile}`,
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/staging-artifacts-archive.txt",
          nextAction: "Backfill the next pending production sign-off or receipt visibility item after the readiness action queue is refreshed."
        },
        {
          key: "rehearsal_reload",
          status: "blocked_after_next_signoff_backfill",
          command: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
          artifactPath: closeoutInputFile,
          nextAction: "Reload rehearsal after status confirms the next sign-off, receipt visibility, or launch-day watch gate."
        }
      ],
      operatorQueueCheckpoint: {
        mode: "staging-signoff-backfill-operator-queue-checkpoint",
        status: "awaiting_signoff_readiness_refresh",
        currentActionKey: "readiness_status",
        currentCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
        actionQueueFile: actionsFile,
        outputFile: closeoutInputFile,
        backfilledTargetType: "production_signoff_condition",
        backfilledKey: "full_test_window_passed",
        backfilledArtifactPath: "artifacts/staging/PILOT_ALPHA/stable/full-test-output.txt",
        productionDecision: "ready-for-production-signoff",
        filledConditionCount: 1,
        requiredConditionCount: 7,
        pendingConditionCount: 6,
        visibleReceiptLaneCount: 0,
        requiredReceiptLaneCount: 5,
        pendingReceiptLaneCount: 5,
        nextBackfillType: "production_signoff_condition",
        nextBackfillKey: "staging_artifacts_archived",
        nextBackfillCommand: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key staging_artifacts_archived --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/staging-artifacts-archive.txt --actions-file ${actionsFile}`,
        nextBackfillArtifactPath: "artifacts/staging/PILOT_ALPHA/stable/staging-artifacts-archive.txt",
        rehearsalReloadCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
        operatorCommandCount: 3,
        nextAction: "Run the readiness status refresh, then continue the next production sign-off or receipt visibility backfill."
      },
      nextAction: "Run statusCommand to pick the next sign-off, receipt visibility, or launch-day watch action."
    });

    const receiptResult = runBackfill([
      "--input-file",
      closeoutInputFile,
      "--actions-file",
      actionsFile,
      "--receipt-lane",
      "launchMainline",
      "--value-json",
      "{\"status\":\"visible\",\"summaryPath\":\"/developer/launch-mainline?productCode=PILOT_ALPHA\"}",
      "--artifact-path",
      "artifacts/staging/PILOT_ALPHA/stable/launch-mainline-receipt-visibility.json",
      "--receipt-id",
      "receipt-launch-mainline-001"
    ]);

    assert.equal(receiptResult.status, 0, receiptResult.stderr || receiptResult.stdout);
    assert.equal(receiptResult.stderr, "");
    const receiptOutput = JSON.parse(receiptResult.stdout);
    const {
      launchEvidenceReadinessGate: receiptLaunchEvidenceGate,
      ...receiptOutputWithoutGate
    } = receiptOutput;
    assert.deepEqual(receiptLaunchEvidenceGate, buildExpectedLaunchEvidenceGate({
      closeoutInputFile,
      actionsFile,
      currentKey: "staging_artifacts_archived",
      currentType: "production_signoff_condition",
      currentStatus: "blocked_after_post_full_test_readiness_status",
      currentCommand: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key staging_artifacts_archived --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/staging-artifacts-archive.txt --actions-file ${actionsFile}`,
      currentArtifactPath: "artifacts/staging/PILOT_ALPHA/stable/staging-artifacts-archive.txt",
      completedEvidenceCount: 9,
      productionSignoffCompleted: 1,
      receiptVisibilityCompleted: 1,
      signoffStatuses: {
        full_test_window_passed: "filled"
      },
      receiptStatuses: {
        launchMainline: "visible"
      }
    }));
    assert.deepEqual(receiptOutputWithoutGate, {
      status: "written",
      mode: "staging-signoff-backfill",
      inputFile: closeoutInputFile,
      outputFile: closeoutInputFile,
      actionsFile,
      targetType: "receipt_visibility_lane",
      key: "launchMainline",
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-mainline-receipt-visibility.json",
      receiptIds: ["receipt-launch-mainline-001"],
      productionDecision: "ready-for-production-signoff",
      filledConditionCount: 1,
      visibleReceiptLaneCount: 1,
      missingConditionCount: 6,
      missingReceiptLaneCount: 4,
      signoffProgress: {
        status: "awaiting_more_signoff_evidence",
        requiredConditionCount: 7,
        filledConditionCount: 1,
        pendingConditionCount: 6,
        requiredReceiptLaneCount: 5,
        visibleReceiptLaneCount: 1,
        pendingReceiptLaneCount: 4,
        currentTarget: {
          type: "production_signoff_condition",
          key: "staging_artifacts_archived",
          status: "pending_operator_entry",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/staging-artifacts-archive.txt",
          sourceStep: "archive_staging_artifacts",
          receiptOperations: []
        },
        pendingConditionKeys: [
          "staging_artifacts_archived",
          "launch_mainline_receipts_visible",
          "launch_ops_overview_status_visible",
          "backup_restore_drill_passed",
          "rollback_path_confirmed",
          "operator_signoff_recorded"
        ],
        pendingReceiptLaneKeys: receiptVisibilityKeys.slice(1),
        nextBackfillCommand: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key staging_artifacts_archived --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/staging-artifacts-archive.txt --actions-file ${actionsFile}`,
        statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
        nextAction: "Run statusCommand, then run nextBackfillCommand with real redacted sign-off or receipt evidence."
      },
      nextCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
      statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
      operatorNextCommands: [
        {
          key: "readiness_status",
          status: "current",
          command: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
          artifactPath: actionsFile,
          nextAction: "Refresh the readiness action queue after this sign-off backfill."
        },
        {
          key: "next_signoff_backfill",
          status: "blocked_after_readiness_status",
          command: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key staging_artifacts_archived --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/staging-artifacts-archive.txt --actions-file ${actionsFile}`,
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/staging-artifacts-archive.txt",
          nextAction: "Backfill the next pending production sign-off or receipt visibility item after the readiness action queue is refreshed."
        },
        {
          key: "rehearsal_reload",
          status: "blocked_after_next_signoff_backfill",
          command: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
          artifactPath: closeoutInputFile,
          nextAction: "Reload rehearsal after status confirms the next sign-off, receipt visibility, or launch-day watch gate."
        }
      ],
      operatorQueueCheckpoint: {
        mode: "staging-signoff-backfill-operator-queue-checkpoint",
        status: "awaiting_signoff_readiness_refresh",
        currentActionKey: "readiness_status",
        currentCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
        actionQueueFile: actionsFile,
        outputFile: closeoutInputFile,
        backfilledTargetType: "receipt_visibility_lane",
        backfilledKey: "launchMainline",
        backfilledArtifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-mainline-receipt-visibility.json",
        productionDecision: "ready-for-production-signoff",
        filledConditionCount: 1,
        requiredConditionCount: 7,
        pendingConditionCount: 6,
        visibleReceiptLaneCount: 1,
        requiredReceiptLaneCount: 5,
        pendingReceiptLaneCount: 4,
        nextBackfillType: "production_signoff_condition",
        nextBackfillKey: "staging_artifacts_archived",
        nextBackfillCommand: `npm.cmd run staging:signoff:backfill -- --input-file ${closeoutInputFile} --condition-key staging_artifacts_archived --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/staging-artifacts-archive.txt --actions-file ${actionsFile}`,
        nextBackfillArtifactPath: "artifacts/staging/PILOT_ALPHA/stable/staging-artifacts-archive.txt",
        rehearsalReloadCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
        operatorCommandCount: 3,
        nextAction: "Run the readiness status refresh, then continue the next production sign-off or receipt visibility backfill."
      },
      nextAction: "Run statusCommand to pick the next sign-off, receipt visibility, or launch-day watch action."
    });

    const closeoutInput = JSON.parse(readFileSync(closeoutInputFile, "utf8"));
    assert.equal(closeoutInput.productionSignoff.decision, "ready-for-production-signoff");
    assert.deepEqual(
      closeoutInput.productionSignoff.conditions.find((item) => item.key === "full_test_window_passed"),
      {
        key: "full_test_window_passed",
        status: "filled",
        value: {
          result: "pass",
          command: "npm.cmd test",
          failureCount: 0,
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/full-test-output.txt",
          receiptIds: ["receipt-full-test-001"]
        },
        artifactPath: "artifacts/staging/PILOT_ALPHA/stable/full-test-output.txt",
        receiptIds: ["receipt-full-test-001"]
      }
    );
    assert.deepEqual(closeoutInput.receiptVisibility.launchMainline, {
      status: "visible",
      summaryPath: "/developer/launch-mainline?productCode=PILOT_ALPHA",
      artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-mainline-receipt-visibility.json",
      receiptIds: ["receipt-launch-mainline-001"]
    });

    const rehearsal = runRehearsal([
      ...validRehearsalArgs,
      "--closeout-input-file",
      closeoutInputFile
    ]);
    assert.equal(rehearsal.status, 0, rehearsal.stderr || rehearsal.stdout);
    const rehearsalOutput = JSON.parse(rehearsal.stdout);
    assert.equal(rehearsalOutput.closeoutInput.readyForFullTestWindow, true);
    assert.equal(rehearsalOutput.closeoutInput.readyForProductionSignoff, false);
    assert.deepEqual(rehearsalOutput.closeoutInput.signoffFilledKeys, ["full_test_window_passed"]);
    assert.deepEqual(rehearsalOutput.closeoutInput.missingReceiptVisibilityKeys, receiptVisibilityKeys.slice(1));
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging signoff backfill prints ordered next commands in plain output", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-signoff-backfill-plain-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeReadyForFullTestInput(closeoutInputFile);

    const result = runBackfillPlain([
      "--input-file",
      closeoutInputFile,
      "--actions-file",
      actionsFile,
      "--condition-key",
      "full_test_window_passed",
      "--value-json",
      "{\"result\":\"pass\",\"command\":\"npm.cmd test\",\"failureCount\":0}",
      "--artifact-path",
      "artifacts/staging/PILOT_ALPHA/stable/full-test-output.txt",
      "--receipt-id",
      "receipt-full-test-001",
      "--decision",
      "ready-for-production-signoff"
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Production sign-off evidence backfilled: full_test_window_passed/);
    assert.match(result.stdout, /Backfilled target: production_signoff_condition\/full_test_window_passed/);
    assert.match(result.stdout, /Backfilled artifact path: artifacts\/staging\/PILOT_ALPHA\/stable\/full-test-output\.txt/);
    assert.match(result.stdout, /Backfilled receipt IDs: receipt-full-test-001/);
    assert.match(result.stdout, /Sign-off progress: 1\/7 conditions filled, 0\/5 receipt lanes visible/);
    assert.match(result.stdout, /Next sign-off target: production_signoff_condition\/staging_artifacts_archived/);
    assert.match(result.stdout, /Next sign-off artifact: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-artifacts-archive\.txt/);
    assert.match(result.stdout, /Next sign-off source step: archive_staging_artifacts/);
    assert.match(result.stdout, /Next sign-off backfill command: npm\.cmd run staging:signoff:backfill -- --input-file .*filled-closeout-input\.json --condition-key staging_artifacts_archived --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/staging-artifacts-archive\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Sign-off operator checkpoint: readiness_status \(status=awaiting_signoff_readiness_refresh, commands=3\)/);
    assert.match(result.stdout, /Sign-off checkpoint current: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Sign-off checkpoint progress: conditions=1\/7, receipts=0\/5/);
    assert.match(result.stdout, /Sign-off checkpoint next backfill: production_signoff_condition\/staging_artifacts_archived -> npm\.cmd run staging:signoff:backfill -- --input-file .*filled-closeout-input\.json --condition-key staging_artifacts_archived --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/staging-artifacts-archive\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Sign-off checkpoint rehearsal reload: npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json/);
    assert.match(result.stdout, /Sign-off checkpoint next action: Run the readiness status refresh, then continue the next production sign-off or receipt visibility backfill\./);
    assert.match(result.stdout, /Launch evidence gate: blocked_until_real_launch_evidence_attached \(current=staging_artifacts_archived, pending=13\/21\)/);
    assert.match(result.stdout, /Launch evidence current: production_signoff_condition\/staging_artifacts_archived -> npm\.cmd run staging:signoff:backfill -- --input-file .*filled-closeout-input\.json --condition-key staging_artifacts_archived --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/staging-artifacts-archive\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Launch evidence progress: closeout=7\/7, signoff=1\/7, receipts=0\/5, launchDuty=0\/2/);
    assert.match(result.stdout, /Launch evidence readiness status: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Launch evidence production signoff packet: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.match(result.stdout, /Launch evidence next action: Run readinessStatusCommand, verify the backfilled sign-off or receipt evidence is reflected, then continue the next launch evidence command\./);
    assert.match(result.stdout, /Backfilled status refresh: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Current command: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Action queue file: .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Next sign-off backfill after status: npm\.cmd run staging:signoff:backfill -- --input-file .*filled-closeout-input\.json --condition-key staging_artifacts_archived --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/staging-artifacts-archive\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Rehearsal reload: npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json/);
    assert.match(result.stdout, /Next action: Run statusCommand to pick the next sign-off, receipt visibility, or launch-day watch action\./);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging signoff backfill prints launch-duty ready handoff after final receipt lane", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-signoff-backfill-ready-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-closeout-input.json");
    const plainCloseoutInputFile = join(tempDir, "filled-closeout-input-plain.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeReadyForLaunchDutyInput(closeoutInputFile);
    writeReadyForLaunchDutyInput(plainCloseoutInputFile);

    const backfillArgs = [
      "--actions-file",
      actionsFile,
      "--receipt-lane",
      "launchOpsOverviewStatus",
      "--value-json",
      "{\"status\":\"visible\",\"summaryPath\":\"/developer/launch-ops-overview-status?productCode=PILOT_ALPHA\"}",
      "--artifact-path",
      "artifacts/staging/PILOT_ALPHA/stable/launch-ops-overview-status-receipt-visibility.json",
      "--receipt-id",
      "receipt-launch-ops-overview-001"
    ];
    const result = runBackfill([
      "--input-file",
      closeoutInputFile,
      ...backfillArgs
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.missingConditionCount, 0);
    assert.equal(output.missingReceiptLaneCount, 0);
    assert.equal(output.signoffProgress.status, "filled");
    assert.equal(output.signoffProgress.nextBackfillCommand, null);
    assert.deepEqual(output.launchEvidenceReadinessGate, buildExpectedLaunchEvidenceGate({
      closeoutInputFile,
      actionsFile,
      currentKey: "launch_day_watch_summary",
      currentType: "launch_duty_record",
      currentStatus: "blocked_after_production_signoff_readiness_status",
      currentCommand: buildLaunchDutyRecordCommand({
        closeoutInputFile,
        actionsFile,
        archiveRoot: "artifacts/staging/PILOT_ALPHA/stable",
        key: "launch_day_watch_summary",
        artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md",
        receiptIds: ["<record_cutover_walkthrough-receipt-id>", "<record_launch_day_readiness_review-receipt-id>"]
      }),
      currentArtifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md",
      completedEvidenceCount: 19,
      productionSignoffCompleted: 7,
      receiptVisibilityCompleted: 5,
      signoffStatuses: Object.fromEntries(signoffKeys.map((key) => [key, "filled"])),
      receiptStatuses: Object.fromEntries(receiptVisibilityKeys.map((key) => [key, "visible"]))
    }));
    assert.deepEqual(output.launchDutyReadyHandoff, {
      status: "ready_for_launch_day_watch",
      currentActionKey: "archive_production_signoff",
      statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${closeoutInputFile} --actions-file ${actionsFile}`,
      reloadCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${closeoutInputFile}`,
      actionQueueFile: actionsFile,
      productionSignoffPacketPath: "artifacts/staging/PILOT_ALPHA/stable/staging-production-signoff-packet.json",
      launchDutyArchiveIndexPath: "artifacts/staging/PILOT_ALPHA/stable/staging-launch-duty-archive-index.json",
      launchDutyRecordIndexPath: "artifacts/staging/PILOT_ALPHA/stable/launch-duty-record-index.json",
      nextAction: "Run statusCommand to confirm launch-day watch readiness, then run reloadCommand and archive the production sign-off packet."
    });

    const plainResult = runBackfillPlain([
      "--input-file",
      plainCloseoutInputFile,
      ...backfillArgs
    ]);

    assert.equal(plainResult.status, 0, plainResult.stderr || plainResult.stdout);
    assert.equal(plainResult.stderr, "");
    assert.match(plainResult.stdout, /Sign-off progress: 7\/7 conditions filled, 5\/5 receipt lanes visible/);
    assert.match(plainResult.stdout, /Launch evidence gate: blocked_until_real_launch_evidence_attached \(current=launch_day_watch_summary, pending=2\/21\)/);
    assert.match(plainResult.stdout, /Launch evidence current: launch_duty_record\/launch_day_watch_summary -> npm\.cmd run staging:launch-duty:record -- --closeout-input-file .*filled-closeout-input-plain\.json --key launch_day_watch_summary --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md --value-json <redacted-json> --receipt-id <record_cutover_walkthrough-receipt-id> --receipt-id <record_launch_day_readiness_review-receipt-id> --record-index-file artifacts\/staging\/PILOT_ALPHA\/stable\/launch-duty-record-index\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(plainResult.stdout, /Launch evidence progress: closeout=7\/7, signoff=7\/7, receipts=5\/5, launchDuty=0\/2/);
    assert.match(plainResult.stdout, /Launch duty readiness: ready_for_launch_day_watch/);
    assert.match(plainResult.stdout, /Launch duty status refresh: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input-plain\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(plainResult.stdout, /Launch duty reload: npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input-plain\.json/);
    assert.match(plainResult.stdout, /Launch duty production signoff packet: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-production-signoff-packet\.json/);
    assert.match(plainResult.stdout, /Launch duty archive index: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-launch-duty-archive-index\.json/);
    assert.match(plainResult.stdout, /Launch duty record index: artifacts\/staging\/PILOT_ALPHA\/stable\/launch-duty-record-index\.json/);
    assert.match(plainResult.stdout, /Launch duty next action: Run statusCommand to confirm launch-day watch readiness, then run reloadCommand and archive the production sign-off packet\./);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging signoff backfill refuses unknown signoff and receipt keys", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-signoff-backfill-refuse-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-closeout-input.json");
    writeReadyForFullTestInput(closeoutInputFile);

    const unknownCondition = runBackfill([
      "--input-file",
      closeoutInputFile,
      "--condition-key",
      "unknown_condition",
      "--value-json",
      "{\"result\":\"pass\"}"
    ]);

    assert.equal(unknownCondition.status, 1);
    assert.equal(unknownCondition.stderr, "");
    assert.match(JSON.parse(unknownCondition.stdout).error.message, /unknown production sign-off condition/i);

    const unknownLane = runBackfill([
      "--input-file",
      closeoutInputFile,
      "--receipt-lane",
      "unknownLane",
      "--value-json",
      "{\"status\":\"visible\"}"
    ]);

    assert.equal(unknownLane.status, 1);
    assert.equal(unknownLane.stderr, "");
    assert.match(JSON.parse(unknownLane.stdout).error.message, /unknown receipt visibility lane/i);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
