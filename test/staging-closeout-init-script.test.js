import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

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

function runCloseoutInit(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/staging-closeout-init.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    },
    timeout: 120_000
  });
}

function runCloseoutInitPlain(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/staging-closeout-init.mjs", ...args], {
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

function writeDraft(file, outputFile, overrides = {}) {
  const keys = [
    "route_map_gate_result",
    "backup_restore_drill_result",
    "live_write_smoke_result",
    "launch_smoke_handoff",
    "launch_mainline_evidence_receipts",
    "receipt_visibility_review",
    "operator_go_no_go"
  ];
  const payload = {
    mode: "staging-closeout-input-draft",
    status: "draft_replace_before_use",
    exampleOnly: true,
    doNotSubmitWithoutReplacingPlaceholders: true,
    copyTo: outputFile,
    decision: null,
    acceptanceFields: keys.map((key) => ({
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

function buildExpectedProductionSwitchProofPacket({
  outputFile,
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
    : `npm.cmd run staging:closeout:backfill -- --input-file ${outputFile} --key backup_restore_drill_result --value-json <redacted-json> --artifact-path ${archiveRoot}/backup_restore_drill_result.txt --actions-file ${actionsFile}`;
  const liveWriteCommand = liveWriteStatus.startsWith("ready_")
    ? null
    : `npm.cmd run staging:closeout:backfill -- --input-file ${outputFile} --key live_write_smoke_result --value-json <redacted-json> --artifact-path ${archiveRoot}/live_write_smoke_result.txt --actions-file ${actionsFile}`;
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
    version: "staging-closeout-init-production-switch-proof-packet/v1",
    status: ready === proofItems.length ? "ready_for_production_switch_review" : "blocked_until_real_environment_evidence",
    currentActionKey,
    currentCommand,
    baseUrl: null,
    productCode: "PILOT_ALPHA",
    channel: "stable",
    targetOs: null,
    storageProfile: null,
    archiveRoot,
    closeoutInputFile: outputFile,
    readinessActionQueueFile: actionsFile,
    launchDutyRecordIndexFile: `${archiveRoot}/launch-duty-record-index.json`,
    publicHttpsProof: {
      status: "pending_real_environment_value",
      baseUrl: null,
      scheme: null,
      isHttps: false,
      currentActionKey: "set_public_https_entrypoint",
      nextAction: "Set a public HTTPS base URL before continuing production switch proof."
    },
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

test("staging closeout init promotes a draft without clearing closeout readiness", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["staging:closeout:init"], "node scripts/staging-closeout-init.mjs");

  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-init-"));
  try {
    const draftFile = join(tempDir, "filled-closeout-input.draft.json");
    const outputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeDraft(draftFile, outputFile);

    const result = runCloseoutInit([
      "--draft-file",
      draftFile,
      "--output-file",
      outputFile,
      "--actions-file",
      actionsFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.equal(existsSync(outputFile), true);
    const output = JSON.parse(result.stdout);
    const archiveRoot = "artifacts/staging/PILOT_ALPHA/stable";
    const statusCommand = `npm.cmd run staging:readiness:status -- --input-file ${outputFile} --actions-file ${actionsFile}`;
    const reloadCommand = `npm.cmd run staging:rehearsal -- --closeout-input-file ${outputFile}`;
    const closeoutEvidenceItems = [
      "route_map_gate_result",
      "backup_restore_drill_result",
      "live_write_smoke_result",
      "launch_smoke_handoff",
      "launch_mainline_evidence_receipts",
      "receipt_visibility_review",
      "operator_go_no_go"
    ].map((key, index) => ({
      order: index + 1,
      key,
      type: "closeout_evidence",
      status: "pending_operator_entry",
      artifactPath: `${archiveRoot}/${key}.txt`,
      command: `npm.cmd run staging:closeout:backfill -- --input-file ${outputFile} --key ${key} --value-json <redacted-json> --artifact-path ${archiveRoot}/${key}.txt --actions-file ${actionsFile}`,
      receiptIds: []
    }));
    const productionSignoffEvidenceItems = [
      {
        order: 8,
        key: "full_test_window_passed",
        type: "production_signoff_condition",
        status: "blocked_after_full_test_window",
        artifactPath: `${archiveRoot}/full-test-output.txt`,
        command: `npm.cmd run staging:signoff:backfill -- --input-file ${outputFile} --condition-key full_test_window_passed --value-json <redacted-json> --artifact-path ${archiveRoot}/full-test-output.txt --decision ready-for-production-signoff --actions-file ${actionsFile}`,
        receiptIds: []
      },
      {
        order: 9,
        key: "staging_artifacts_archived",
        type: "production_signoff_condition",
        status: "blocked_after_post_full_test_readiness_status",
        artifactPath: `${archiveRoot}/staging-artifacts-archive.txt`,
        command: `npm.cmd run staging:signoff:backfill -- --input-file ${outputFile} --condition-key staging_artifacts_archived --value-json <redacted-json> --artifact-path ${archiveRoot}/staging-artifacts-archive.txt --actions-file ${actionsFile}`,
        receiptIds: []
      },
      {
        order: 10,
        key: "launch_mainline_receipts_visible",
        type: "production_signoff_condition",
        status: "blocked_after_staging_artifacts_archived",
        artifactPath: `${archiveRoot}/launch-mainline-receipts-visible.json`,
        command: `npm.cmd run staging:signoff:backfill -- --input-file ${outputFile} --condition-key launch_mainline_receipts_visible --value-json <redacted-json> --artifact-path ${archiveRoot}/launch-mainline-receipts-visible.json --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file ${actionsFile}`,
        receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
      },
      {
        order: 11,
        key: "launch_ops_overview_status_visible",
        type: "production_signoff_condition",
        status: "blocked_after_launch_mainline_receipts_visible",
        artifactPath: `${archiveRoot}/launch-ops-overview-status-visible.json`,
        command: `npm.cmd run staging:signoff:backfill -- --input-file ${outputFile} --condition-key launch_ops_overview_status_visible --value-json <redacted-json> --artifact-path ${archiveRoot}/launch-ops-overview-status-visible.json --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file ${actionsFile}`,
        receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
      },
      {
        order: 12,
        key: "backup_restore_drill_passed",
        type: "production_signoff_condition",
        status: "blocked_after_launch_ops_overview_status_visible",
        artifactPath: `${archiveRoot}/backup-restore-drill.txt`,
        command: `npm.cmd run staging:signoff:backfill -- --input-file ${outputFile} --condition-key backup_restore_drill_passed --value-json <redacted-json> --artifact-path ${archiveRoot}/backup-restore-drill.txt --receipt-id <record_recovery_drill-receipt-id> --receipt-id <record_backup_verification-receipt-id> --actions-file ${actionsFile}`,
        receiptIds: ["<record_recovery_drill-receipt-id>", "<record_backup_verification-receipt-id>"]
      },
      {
        order: 13,
        key: "rollback_path_confirmed",
        type: "production_signoff_condition",
        status: "blocked_after_backup_restore_drill_passed",
        artifactPath: `${archiveRoot}/rollback-path-confirmed.md`,
        command: `npm.cmd run staging:signoff:backfill -- --input-file ${outputFile} --condition-key rollback_path_confirmed --value-json <redacted-json> --artifact-path ${archiveRoot}/rollback-path-confirmed.md --receipt-id <record_rollback_walkthrough-receipt-id> --actions-file ${actionsFile}`,
        receiptIds: ["<record_rollback_walkthrough-receipt-id>"]
      },
      {
        order: 14,
        key: "operator_signoff_recorded",
        type: "production_signoff_condition",
        status: "blocked_after_rollback_path_confirmed",
        artifactPath: `${archiveRoot}/operator-production-signoff.md`,
        command: `npm.cmd run staging:signoff:backfill -- --input-file ${outputFile} --condition-key operator_signoff_recorded --value-json <redacted-json> --artifact-path ${archiveRoot}/operator-production-signoff.md --actions-file ${actionsFile}`,
        receiptIds: []
      }
    ];
    const receiptVisibilityEvidenceItems = [
      ["launchMainline", "blocked_after_operator_signoff_recorded", "launch-mainline-receipt-visibility.json"],
      ["launchReview", "blocked_after_launchMainline_receipt_visibility", "launch-review-receipt-visibility.json"],
      ["launchSmoke", "blocked_after_launchReview_receipt_visibility", "launch-smoke-receipt-visibility.json"],
      ["developerOps", "blocked_after_launchSmoke_receipt_visibility", "developer-ops-receipt-visibility.json"],
      ["launchOpsOverviewStatus", "blocked_after_developerOps_receipt_visibility", "launch-ops-overview-status-receipt-visibility.json"]
    ].map(([key, status, fileName], index) => ({
      order: index + 15,
      key,
      type: "receipt_visibility_lane",
      status,
      artifactPath: `${archiveRoot}/${fileName}`,
      command: `npm.cmd run staging:signoff:backfill -- --input-file ${outputFile} --receipt-lane ${key} --value-json <redacted-json> --artifact-path ${archiveRoot}/${fileName} --receipt-id <record_post_launch_ops_sweep-receipt-id> --actions-file ${actionsFile}`,
      receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
    }));
    const launchEvidenceReadinessGate = {
      version: "staging-closeout-init-launch-evidence-gate/v1",
      status: "blocked_until_real_launch_evidence_attached",
      currentGate: "closeout_init",
      currentEvidenceKey: "route_map_gate_result",
      currentEvidenceType: "closeout_evidence",
      currentEvidenceStatus: "pending_operator_entry",
      currentCommand: `npm.cmd run staging:closeout:backfill -- --input-file ${outputFile} --key route_map_gate_result --value-json <redacted-json> --artifact-path ${archiveRoot}/route_map_gate_result.txt --actions-file ${actionsFile}`,
      currentArtifactPath: `${archiveRoot}/route_map_gate_result.txt`,
      closeoutInputFile: outputFile,
      readinessActionQueueFile: actionsFile,
      archiveRoot,
      evidenceCount: 21,
      closeoutEvidenceCount: 7,
      productionSignoffEvidenceCount: 7,
      receiptVisibilityEvidenceCount: 5,
      launchDutyEvidenceCount: 2,
      completedEvidenceCount: 0,
      pendingEvidenceCount: 21,
      readinessStatusCommand: statusCommand,
      rehearsalReloadCommand: reloadCommand,
      fullTestCommand: "npm.cmd test",
      fullTestOutputArtifact: `${archiveRoot}/full-test-output.txt`,
      productionSignoffPacket: `${archiveRoot}/staging-production-signoff-packet.json`,
      launchDayWatchArtifact: `${archiveRoot}/launch-day-watch-summary.md`,
      firstWaveCloseoutArtifact: `${archiveRoot}/first-wave-closeout.md`,
      launchDutyRecordIndexPath: `${archiveRoot}/launch-duty-record-index.json`,
      progress: {
        closeout: { completed: 0, total: 7 },
        productionSignoff: { completed: 0, total: 7 },
        receiptVisibility: { completed: 0, total: 5 },
        launchDuty: { completed: 0, total: 2 }
      },
      evidenceItems: [
        ...closeoutEvidenceItems,
        ...productionSignoffEvidenceItems,
        ...receiptVisibilityEvidenceItems,
        {
          order: 20,
          key: "launch_day_watch_summary",
          type: "launch_duty_record",
          status: "blocked_after_production_signoff_readiness_status",
          artifactPath: `${archiveRoot}/launch-day-watch-summary.md`,
          command: `npm.cmd run staging:launch-duty:record -- --closeout-input-file ${outputFile} --key launch_day_watch_summary --artifact-path ${archiveRoot}/launch-day-watch-summary.md --value-json <redacted-json> --receipt-id <record_cutover_walkthrough-receipt-id> --receipt-id <record_launch_day_readiness_review-receipt-id> --record-index-file ${archiveRoot}/launch-duty-record-index.json --actions-file ${actionsFile}`,
          receiptIds: ["<record_cutover_walkthrough-receipt-id>", "<record_launch_day_readiness_review-receipt-id>"]
        },
        {
          order: 21,
          key: "first_wave_closeout",
          type: "launch_duty_record",
          status: "blocked_until_source_records",
          artifactPath: `${archiveRoot}/first-wave-closeout.md`,
          command: `npm.cmd run staging:launch-duty:record -- --closeout-input-file ${outputFile} --key first_wave_closeout --artifact-path ${archiveRoot}/first-wave-closeout.md --value-json <redacted-json> --receipt-id <record_launch_closeout_review-receipt-id> --source-record first_wave_incident_log=${archiveRoot}/first-wave-incident-log.md --source-record rollback_signal_review=${archiveRoot}/rollback-signal-review.md --source-record stabilization_owner_handoff=${archiveRoot}/stabilization-owner-handoff.md --record-index-file ${archiveRoot}/launch-duty-record-index.json --actions-file ${actionsFile}`,
          receiptIds: ["<record_launch_closeout_review-receipt-id>"],
          sourceRecordKeys: ["first_wave_incident_log", "rollback_signal_review", "stabilization_owner_handoff"]
        }
      ],
      nextAction: "Run readinessStatusCommand, attach the current closeout evidence item, then rerun readiness status before continuing to smoke, full-test, production signoff, receipt visibility, launch-day watch, and first-wave closeout."
    };
    assert.deepEqual(output, {
      status: "written",
      mode: "staging-closeout-init",
      draftFile,
      outputFile,
      actionsFile,
      acceptanceFieldCount: 7,
      placeholderCount: 7,
      evidenceProgress: {
        status: "awaiting_real_evidence",
        requiredCount: 7,
        filledCount: 0,
        pendingCount: 7,
        currentTarget: {
          key: "route_map_gate_result",
          status: "pending_operator_entry",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/route_map_gate_result.txt",
          sourceStep: "source_route_map_gate_result",
          receiptOperations: []
        },
        pendingKeys: [
          "route_map_gate_result",
          "backup_restore_drill_result",
          "live_write_smoke_result",
          "launch_smoke_handoff",
          "launch_mainline_evidence_receipts",
          "receipt_visibility_review",
          "operator_go_no_go"
        ],
        firstBackfillCommand: `npm.cmd run staging:closeout:backfill -- --input-file ${outputFile} --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/route_map_gate_result.txt --actions-file ${actionsFile}`,
        statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${outputFile} --actions-file ${actionsFile}`,
        nextAction: "Run statusCommand, then run firstBackfillCommand with real redacted evidence."
      },
      firstEvidenceBackfillHandoff: {
        status: "ready_for_first_closeout_backfill",
        currentActionKey: "backfill_closeout_evidence",
        statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${outputFile} --actions-file ${actionsFile}`,
        firstBackfillCommand: `npm.cmd run staging:closeout:backfill -- --input-file ${outputFile} --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/route_map_gate_result.txt --actions-file ${actionsFile}`,
        firstBackfillTarget: {
          key: "route_map_gate_result",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/route_map_gate_result.txt",
          sourceStep: "source_route_map_gate_result",
          receiptOperations: []
        },
        actionQueueFile: actionsFile,
        reloadCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${outputFile}`,
        nextAction: "Run statusCommand, then firstBackfillCommand with real redacted evidence before the rehearsal reload."
      },
      nextCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${outputFile}`,
      statusCommand: `npm.cmd run staging:readiness:status -- --input-file ${outputFile} --actions-file ${actionsFile}`,
      launchEvidenceReadinessGate,
      productionSwitchProofPacket: buildExpectedProductionSwitchProofPacket({
        outputFile,
        actionsFile,
        archiveRoot,
        currentActionKey: "backfill_closeout_evidence",
        currentCommand: `npm.cmd run staging:closeout:backfill -- --input-file ${outputFile} --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/route_map_gate_result.txt --actions-file ${actionsFile}`
      }),
      operatorNextCommands: [
        {
          key: "readiness_status",
          status: "current",
          command: `npm.cmd run staging:readiness:status -- --input-file ${outputFile} --actions-file ${actionsFile}`,
          artifactPath: actionsFile,
          nextAction: "Generate or refresh the readiness action queue before backfilling evidence."
        },
        {
          key: "first_closeout_backfill",
          status: "blocked_after_readiness_status",
          command: `npm.cmd run staging:closeout:backfill -- --input-file ${outputFile} --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts/staging/PILOT_ALPHA/stable/route_map_gate_result.txt --actions-file ${actionsFile}`,
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/route_map_gate_result.txt",
          nextAction: "Backfill the first pending closeout evidence item after the readiness action queue is refreshed."
        },
        {
          key: "rehearsal_reload",
          status: "blocked_after_first_closeout_backfill",
          command: `npm.cmd run staging:rehearsal -- --closeout-input-file ${outputFile}`,
          artifactPath: outputFile,
          nextAction: "Reload rehearsal after the current evidence backfill item is recorded."
        }
      ],
      nextAction: "Run statusCommand to pick the first closeout evidence backfill target."
    });

    const closeoutInput = JSON.parse(readFileSync(outputFile, "utf8"));
    assert.equal(closeoutInput.mode, "staging-closeout-input-draft");
    assert.equal(closeoutInput.status, "awaiting_real_evidence");
    assert.equal(Object.hasOwn(closeoutInput, "exampleOnly"), false);
    assert.equal(Object.hasOwn(closeoutInput, "doNotSubmitWithoutReplacingPlaceholders"), false);
    assert.equal(closeoutInput.promotedFromDraft.path, draftFile);
    assert.equal(closeoutInput.acceptanceFields.every((field) => field.value === null), true);

    const rehearsal = runRehearsal([
      ...validRehearsalArgs,
      "--closeout-input-file",
      outputFile
    ]);
    assert.equal(rehearsal.status, 0, rehearsal.stderr || rehearsal.stdout);
    const rehearsalOutput = JSON.parse(rehearsal.stdout);
    assert.equal(rehearsalOutput.closeoutInput.backfillReview.draftPromotionStatus, "draft_needs_values");
    assert.equal(rehearsalOutput.closeoutInput.backfillReview.safeToEnterFullTestWindow, false);
    assert.equal(rehearsalOutput.operatorExecutionPlan.readinessSummary.canRunFullTestWindow, false);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging closeout init marks bound non-default secret env ready when required env vars are present", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-init-secret-env-"));
  try {
    const draftFile = join(tempDir, "filled-closeout-input.draft.json");
    const outputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeDraft(draftFile, outputFile, {
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

    const result = runCloseoutInit([
      "--draft-file",
      draftFile,
      "--output-file",
      outputFile,
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

test("staging closeout init prints secret env proof in plain output without secret values", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-init-secret-env-plain-"));
  try {
    const draftFile = join(tempDir, "filled-closeout-input.draft.json");
    const outputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeDraft(draftFile, outputFile, {
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

    const result = runCloseoutInitPlain([
      "--draft-file",
      draftFile,
      "--output-file",
      outputFile,
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

test("staging closeout init prints ordered next commands in plain output", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-init-plain-"));
  try {
    const draftFile = join(tempDir, "filled-closeout-input.draft.json");
    const outputFile = join(tempDir, "filled-closeout-input.json");
    const actionsFile = join(tempDir, "readiness-action-queue.md");
    writeDraft(draftFile, outputFile);

    const result = runCloseoutInitPlain([
      "--draft-file",
      draftFile,
      "--output-file",
      outputFile,
      "--actions-file",
      actionsFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Filled closeout input initialized: .*filled-closeout-input\.json/);
    assert.match(result.stdout, /Evidence progress: 0\/7 filled, 7 pending/);
    assert.match(result.stdout, /First backfill target: route_map_gate_result/);
    assert.match(result.stdout, /First target artifact: artifacts\/staging\/PILOT_ALPHA\/stable\/route_map_gate_result\.txt/);
    assert.match(result.stdout, /First target source step: source_route_map_gate_result/);
    assert.match(result.stdout, /First backfill command: npm\.cmd run staging:closeout:backfill -- --input-file .*filled-closeout-input\.json --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/route_map_gate_result\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /First target status check: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /First evidence handoff: ready_for_first_closeout_backfill/);
    assert.match(result.stdout, /First evidence status refresh: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /First evidence backfill: npm\.cmd run staging:closeout:backfill -- --input-file .*filled-closeout-input\.json --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/route_map_gate_result\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /First evidence target: route_map_gate_result -> artifacts\/staging\/PILOT_ALPHA\/stable\/route_map_gate_result\.txt/);
    assert.match(result.stdout, /First evidence source step: source_route_map_gate_result/);
    assert.match(result.stdout, /First evidence rehearsal reload: npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json/);
    assert.match(result.stdout, /First evidence next action: Run statusCommand, then firstBackfillCommand with real redacted evidence before the rehearsal reload\./);
    assert.match(result.stdout, /Launch evidence gate: blocked_until_real_launch_evidence_attached \(current=route_map_gate_result, pending=21\/21\)/);
    assert.match(result.stdout, /Launch evidence current: closeout_evidence\/route_map_gate_result -> npm\.cmd run staging:closeout:backfill -- --input-file .*filled-closeout-input\.json --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/route_map_gate_result\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Launch evidence progress: closeout=0\/7, signoff=0\/7, receipts=0\/5, launchDuty=0\/2/);
    assert.match(result.stdout, /Launch evidence readiness status: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Launch evidence full-test: npm\.cmd test -> artifacts\/staging\/PILOT_ALPHA\/stable\/full-test-output\.txt/);
    assert.match(result.stdout, /Launch evidence first-wave closeout: artifacts\/staging\/PILOT_ALPHA\/stable\/first-wave-closeout\.md/);
    assert.match(result.stdout, /Production switch proof packet: blocked_until_real_environment_evidence \(ready=1\/8, blocked=7\/8, current=backfill_closeout_evidence\)/);
    assert.match(result.stdout, /Production switch proof 6\. full_test_window: ready_local_baseline_available -> npm\.cmd test/);
    assert.match(result.stdout, /Production switch next action: Continue the current closeout evidence command, rerun staging:readiness:status, then use this packet as the production switch proof checklist\./);
    assert.match(result.stdout, /Current command: npm\.cmd run staging:readiness:status -- --input-file .*filled-closeout-input\.json --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Action queue file: .*readiness-action-queue\.md/);
    assert.match(result.stdout, /First backfill after status: npm\.cmd run staging:closeout:backfill -- --input-file .*filled-closeout-input\.json --key route_map_gate_result --value-json <redacted-json> --artifact-path artifacts\/staging\/PILOT_ALPHA\/stable\/route_map_gate_result\.txt --actions-file .*readiness-action-queue\.md/);
    assert.match(result.stdout, /Rehearsal reload: npm\.cmd run staging:rehearsal -- --closeout-input-file .*filled-closeout-input\.json/);
    assert.match(result.stdout, /Next action: Run statusCommand to pick the first closeout evidence backfill target\./);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging closeout init refuses non-draft closeout inputs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-closeout-init-refuse-"));
  try {
    const draftFile = join(tempDir, "not-a-draft.json");
    const outputFile = join(tempDir, "filled-closeout-input.json");
    writeFileSync(
      draftFile,
      `${JSON.stringify({ mode: "staging-closeout-template", exampleOnly: true }, null, 2)}\n`,
      "utf8"
    );

    const result = runCloseoutInit([
      "--draft-file",
      draftFile,
      "--output-file",
      outputFile
    ]);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "fail");
    assert.match(output.error.message, /staging-closeout-input-draft/i);
    assert.equal(existsSync(outputFile), false);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
