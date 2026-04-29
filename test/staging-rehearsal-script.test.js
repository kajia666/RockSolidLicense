import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function runRehearsal(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/staging-rehearsal.mjs", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      RSL_DEVELOPER_BEARER_TOKEN: "",
      ...env
    },
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
  assert.deepEqual(output.nextCommands.launchRouteMapGate, {
    command: "npm.cmd run launch:route-map-gate",
    dryRunCommand: "npm.cmd run launch:route-map-gate -- --dry-run --json",
    willModifyData: false,
    willRunFullSuite: false,
    purpose: "Re-run the Launch Mainline / Launch Smoke / Developer Ops route-map visibility and low-frequency download surface targeted gate before live-write staging smoke."
  });
  assert.match(output.nextCommands.launchMainline, /\/developer\/launch-mainline\?productCode=PILOT_ALPHA&channel=stable/);
  assert.deepEqual(output.nextCommands.receiptVisibilitySummaries, {
    launchReviewSummary: "https://staging.example.com/api/developer/launch-review/download?productCode=PILOT_ALPHA&channel=stable&source=launch-smoke&handoff=first-wave&format=summary",
    launchSmokeSummary: "https://staging.example.com/api/developer/launch-smoke-kit/download?productCode=PILOT_ALPHA&channel=stable&operation=record_post_launch_ops_sweep&downloadKey=launch_smoke_summary&format=summary"
  });
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
  assert.deepEqual(output.evidenceActionPlan.items[0].request, {
    method: "POST",
    url: "https://staging.example.com/api/developer/launch-mainline/action",
    contentType: "application/json",
    bearerTokenEnv: "RSL_DEVELOPER_BEARER_TOKEN",
    powershell: [
      "$headers = @{ Authorization = \"Bearer $env:RSL_DEVELOPER_BEARER_TOKEN\" }",
      "$body = @'",
      "{",
      "  \"productCode\": \"PILOT_ALPHA\",",
      "  \"channel\": \"stable\",",
      "  \"operation\": \"record_launch_rehearsal_run\"",
      "}",
      "'@",
      "Invoke-RestMethod -Method Post -Uri 'https://staging.example.com/api/developer/launch-mainline/action' -Headers $headers -ContentType 'application/json' -Body $body"
    ].join("\n")
  });
  assert.doesNotMatch(output.evidenceActionPlan.items[0].request.powershell, /StrongAdmin123!|StrongDeveloper123!/);
  assert.deepEqual(output.evidenceReadiness, {
    status: "needs_operator_input",
    readyToExecute: false,
    checks: {
      targetLane: "pass",
      evidenceEndpoint: "pass",
      developerBearerToken: "missing"
    },
    tokenEnv: "RSL_DEVELOPER_BEARER_TOKEN",
    targetLane: {
      productCode: "PILOT_ALPHA",
      channel: "stable"
    },
    endpoint: "https://staging.example.com/api/developer/launch-mainline/action",
    nextAction: "Set $env:RSL_DEVELOPER_BEARER_TOKEN before copying evidence request snippets."
  });
  assert.equal(output.environmentReadiness.status, "needs_operator_execution");
  assert.equal(output.environmentReadiness.willModifyData, false);
  assert.deepEqual(
    output.environmentReadiness.checks.map((item) => item.key),
    [
      "public_https_entrypoint",
      "non_default_secrets",
      "persistent_storage",
      "backup_restore_drill",
      "route_map_gate",
      "live_write_approval"
    ]
  );
  const readinessChecks = Object.fromEntries(
    output.environmentReadiness.checks.map((item) => [item.key, item])
  );
  assert.equal(readinessChecks.public_https_entrypoint.status, "pass");
  assert.match(readinessChecks.public_https_entrypoint.evidence, /https:\/\/staging\.example\.com/);
  assert.equal(readinessChecks.non_default_secrets.status, "operator_confirm");
  assert.match(readinessChecks.non_default_secrets.nextAction, /Confirm the deployed server token secret/);
  assert.equal(readinessChecks.persistent_storage.status, "operator_confirm");
  assert.match(readinessChecks.persistent_storage.evidence, /postgres-preview/);
  assert.equal(readinessChecks.backup_restore_drill.status, "operator_execute");
  assert.deepEqual(readinessChecks.backup_restore_drill.commandKeys, [
    "appBackup",
    "postgresBackup",
    "postgresRestoreDryRun",
    "restoreDrillReminder",
    "healthcheck"
  ]);
  assert.equal(readinessChecks.route_map_gate.status, "operator_execute");
  assert.equal(readinessChecks.route_map_gate.command, "npm.cmd run launch:route-map-gate");
  assert.equal(readinessChecks.live_write_approval.status, "operator_confirm");
  assert.match(readinessChecks.live_write_approval.evidence, /--allow-live-writes/);
  assert.doesNotMatch(JSON.stringify(output.environmentReadiness), /StrongAdmin123!|StrongDeveloper123!/);
  assert.deepEqual(
    output.operatorChecklist.map((item) => item.key),
    [
      "review_environment_readiness",
      "run_route_map_gate",
      "run_backup_restore_drill",
      "approve_live_write_smoke",
      "run_live_write_smoke",
      "save_smoke_handoff",
      "open_launch_mainline",
      "record_launch_mainline_evidence",
      "verify_receipt_visibility"
    ]
  );
  assert.equal(output.operatorChecklist[0].status, "operator_review");
  assert.match(output.operatorChecklist[1].command, /launch:route-map-gate/);
  assert.match(output.operatorChecklist[4].command, /launch:smoke:staging/);
  assert.equal(output.operatorChecklist[7].endpoint, "https://staging.example.com/api/developer/launch-mainline/action");
  assert.deepEqual(output.operatorChecklist[7].evidenceOperations.slice(0, 3), [
    "record_launch_rehearsal_run",
    "record_recovery_drill",
    "record_backup_verification"
  ]);
  assert.doesNotMatch(JSON.stringify(output.operatorChecklist), /StrongAdmin123!|StrongDeveloper123!/);
  assert.equal(output.operatorExecutionPlan.status, "ready_for_staging_execution");
  assert.equal(output.operatorExecutionPlan.willModifyData, false);
  assert.equal(output.operatorExecutionPlan.trigger, "no-write-rehearsal-gates-passed");
  assert.deepEqual(
    output.operatorExecutionPlan.outputFiles.map((item) => [item.key, item.status]),
    [
      ["handoff_file", "not_requested"],
      ["closeout_file", "not_requested"]
    ]
  );
  assert.deepEqual(
    output.operatorExecutionPlan.orderedSteps.map((item) => item.key),
    [
      "review_generated_bundle",
      "run_route_map_gate",
      "run_backup_restore_drill",
      "approve_and_run_live_write_smoke",
      "archive_launch_smoke_handoff",
      "record_launch_mainline_evidence",
      "verify_receipt_visibility",
      "backfill_closeout_template",
      "reserve_full_test_window",
      "production_signoff_review"
    ]
  );
  assert.equal(output.operatorExecutionPlan.orderedSteps[1].command, "npm.cmd run launch:route-map-gate");
  assert.equal(output.operatorExecutionPlan.orderedSteps[5].endpoint, output.evidenceActionPlan.endpoint);
  assert.deepEqual(
    output.operatorExecutionPlan.requiredCloseoutKeys,
    output.stagingAcceptanceCloseout.acceptanceChecks.map((item) => item.key)
  );
  assert.equal(output.operatorExecutionPlan.fullTestWindow.command, "npm.cmd test");
  assert.equal(output.operatorExecutionPlan.productionSignoff.requiredDecision, "ready-for-production-signoff");
  assert.deepEqual(output.fullTestWindowReadiness, {
    status: "blocked",
    canRun: false,
    command: "npm.cmd test",
    willRunFullSuite: true,
    willModifyData: false,
    requiredDecision: "ready-for-full-test-window",
    closeoutInputStatus: "missing",
    missingCloseoutKeys: output.stagingAcceptanceCloseout.acceptanceChecks.map((item) => item.key),
    reloadCommand: "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>",
    nextAction: "Backfill closeout input and reload it before running npm.cmd test."
  });
  assert.deepEqual(output.productionSignoffReadiness, {
    status: "blocked",
    canSignoff: false,
    requiredDecision: "ready-for-production-signoff",
    productionDecision: null,
    closeoutInputStatus: "missing",
    readyForFullTestWindow: false,
    missingSignoffKeys: output.stagingAcceptanceCloseout.productionSignoffConditions.conditions.map((item) => item.key),
    missingReceiptVisibilityKeys: [
      "launchMainline",
      "launchReview",
      "launchSmoke",
      "developerOps"
    ],
    reloadCommand: "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>",
    nextAction: "Backfill full-test evidence, production sign-off conditions, production decision, and receipt visibility before cutover."
  });
  assert.equal(output.launchDayWatchPlan.status, "blocked");
  assert.equal(output.launchDayWatchPlan.canStartCutoverWatch, false);
  assert.equal(output.launchDayWatchPlan.requiredDecision, "ready-for-production-signoff");
  assert.equal(output.launchDayWatchPlan.productionDecision, null);
  assert.deepEqual(output.launchDayWatchPlan.missingSignoffKeys, output.productionSignoffReadiness.missingSignoffKeys);
  assert.deepEqual(output.launchDayWatchPlan.missingReceiptVisibilityKeys, [
    "launchMainline",
    "launchReview",
    "launchSmoke",
    "developerOps"
  ]);
  assert.deepEqual(
    output.launchDayWatchPlan.watchWindows.map((item) => item.key),
    ["cutover_watch", "first_wave_stabilization"]
  );
  assert.equal(
    output.launchDayWatchPlan.routes.developerOps,
    "https://staging.example.com/developer/ops?productCode=PILOT_ALPHA&source=staging-rehearsal&handoff=first-wave"
  );
  assert.deepEqual(output.launchDayWatchPlan.escalationTriggers, [
    "production_signoff_missing",
    "receipt_visibility_missing",
    "launch_mainline_action_failure",
    "developer_ops_receipt_mismatch",
    "backup_restore_or_rollback_unclear"
  ]);
  assert.equal(output.stabilizationHandoffPlan.status, "blocked");
  assert.equal(output.stabilizationHandoffPlan.canStartStabilizationHandoff, false);
  assert.equal(output.stabilizationHandoffPlan.sourceWatchStatus, "blocked");
  assert.deepEqual(output.stabilizationHandoffPlan.requiredWatchWindows, [
    "cutover_watch",
    "first_wave_stabilization"
  ]);
  assert.deepEqual(output.stabilizationHandoffPlan.requiredEvidenceKeys, [
    "launch_day_watch_summary",
    "first_wave_incident_log",
    "receipt_visibility_snapshot",
    "rollback_signal_review",
    "stabilization_owner_handoff"
  ]);
  assert.equal(
    output.stabilizationHandoffPlan.routes.developerOps,
    "https://staging.example.com/developer/ops?productCode=PILOT_ALPHA&source=staging-rehearsal&handoff=first-wave"
  );
  assert.deepEqual(output.stabilizationHandoffPlan.escalationTriggers, [
    "production_signoff_missing",
    "receipt_visibility_missing",
    "launch_mainline_action_failure",
    "developer_ops_receipt_mismatch",
    "backup_restore_or_rollback_unclear",
    "unresolved_first_wave_incident",
    "missing_stabilization_owner"
  ]);
  assert.equal(output.stagingRunRecordTemplate.status, "awaiting_staging_execution");
  assert.equal(output.stagingRunRecordTemplate.willModifyData, false);
  assert.equal(output.stagingRunRecordTemplate.archiveRoot, "artifacts/staging/PILOT_ALPHA/stable");
  assert.equal(
    output.stagingRunRecordTemplate.closeoutInputReloadCommand,
    "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>"
  );
  assert.deepEqual(output.stagingRunRecordTemplate.sourceReadiness, {
    fullTestWindow: "blocked",
    productionSignoff: "blocked",
    launchDayWatch: "blocked",
    stabilizationHandoff: "blocked"
  });
  assert.deepEqual(output.stagingRunRecordTemplate.requiredRecordKeys, [
    "route_map_gate_result",
    "backup_restore_drill_result",
    "live_write_smoke_result",
    "launch_smoke_handoff",
    "launch_mainline_evidence_receipts",
    "receipt_visibility_review",
    "operator_go_no_go",
    "launch_day_watch_summary",
    "first_wave_incident_log",
    "receipt_visibility_snapshot",
    "rollback_signal_review",
    "stabilization_owner_handoff"
  ]);
  assert.deepEqual(
    output.stagingRunRecordTemplate.records.slice(-5).map((item) => [item.key, item.sourcePlan, item.artifactPath]),
    [
      ["launch_day_watch_summary", "launchDayWatchPlan", "artifacts/staging/PILOT_ALPHA/stable/launch-day-watch-summary.md"],
      ["first_wave_incident_log", "launchDayWatchPlan", "artifacts/staging/PILOT_ALPHA/stable/first-wave-incident-log.md"],
      ["receipt_visibility_snapshot", "launchDayWatchPlan", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-snapshot.txt"],
      ["rollback_signal_review", "stabilizationHandoffPlan", "artifacts/staging/PILOT_ALPHA/stable/rollback-signal-review.md"],
      ["stabilization_owner_handoff", "stabilizationHandoffPlan", "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"]
    ]
  );
  assert.equal(output.filledCloseoutInputExample.mode, "staging-closeout-input-example");
  assert.equal(output.filledCloseoutInputExample.status, "example_only");
  assert.equal(output.filledCloseoutInputExample.exampleOnly, true);
  assert.equal(output.filledCloseoutInputExample.doNotSubmitWithoutReplacingPlaceholders, true);
  assert.equal(output.filledCloseoutInputExample.saveAs, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.example.json");
  assert.equal(output.filledCloseoutInputExample.reloadCommand, "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.deepEqual(
    output.filledCloseoutInputExample.acceptanceFields.map((item) => item.key),
    output.stagingAcceptanceCloseout.acceptanceChecks.map((item) => item.key)
  );
  assert.equal(
    output.filledCloseoutInputExample.acceptanceFields.find((item) => item.key === "operator_go_no_go").value,
    "ready-for-full-test-window"
  );
  assert.equal(output.filledCloseoutInputExample.receiptVisibility.launchMainline.value, "visible");
  assert.equal(output.filledCloseoutInputExample.productionSignoff.decision, "ready-for-production-signoff");
  assert.deepEqual(
    output.filledCloseoutInputExample.productionSignoff.conditions.map((item) => item.key),
    output.stagingAcceptanceCloseout.productionSignoffConditions.conditions.map((item) => item.key)
  );
  assert.equal(output.stagingEnvironmentBinding.status, "ready_for_real_staging_binding");
  assert.equal(output.stagingEnvironmentBinding.willModifyData, false);
  assert.deepEqual(output.stagingEnvironmentBinding.environment, {
    baseUrl: "https://staging.example.com",
    productCode: "PILOT_ALPHA",
    channel: "stable",
    targetOs: "linux",
    storageProfile: "postgres-preview",
    targetEnvFile: "/etc/rocksolidlicense/staging.env",
    appBackupDir: "/var/lib/rocksolid/backups",
    postgresBackupDir: "/var/lib/rocksolid/postgres-backups"
  });
  assert.deepEqual(output.stagingEnvironmentBinding.credentialEnv, {
    adminPassword: "RSL_SMOKE_ADMIN_PASSWORD",
    developerPassword: "RSL_SMOKE_DEVELOPER_PASSWORD",
    developerBearerToken: "RSL_DEVELOPER_BEARER_TOKEN"
  });
  assert.deepEqual(
    output.stagingEnvironmentBinding.recommendedOutputFiles.map((item) => [item.key, item.path, item.status]),
    [
      ["handoff_file", "artifacts/staging/PILOT_ALPHA/stable/staging-rehearsal-handoff.md", "recommended_default"],
      ["closeout_file", "artifacts/staging/PILOT_ALPHA/stable/staging-closeout-template.json", "recommended_default"],
      ["filled_closeout_input", "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json", "operator_create"],
      ["filled_closeout_input_example", "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.example.json", "example_only"],
      ["artifact_archive_root", "artifacts/staging/PILOT_ALPHA/stable", "operator_archive"]
    ]
  );
  assert.match(output.stagingEnvironmentBinding.dryRunCommand, /npm\.cmd run staging:rehearsal -- --json/);
  assert.match(output.stagingEnvironmentBinding.dryRunCommand, /--base-url https:\/\/staging\.example\.com/);
  assert.match(output.stagingEnvironmentBinding.dryRunCommand, /--admin-password \$env:RSL_SMOKE_ADMIN_PASSWORD/);
  assert.match(output.stagingEnvironmentBinding.dryRunCommand, /--developer-password \$env:RSL_SMOKE_DEVELOPER_PASSWORD/);
  assert.match(output.stagingEnvironmentBinding.dryRunCommand, /--handoff-file artifacts\/staging\/PILOT_ALPHA\/stable\/staging-rehearsal-handoff\.md/);
  assert.match(output.stagingEnvironmentBinding.dryRunCommand, /--closeout-file artifacts\/staging\/PILOT_ALPHA\/stable\/staging-closeout-template\.json/);
  assert.doesNotMatch(JSON.stringify(output.stagingEnvironmentBinding), /StrongAdmin123!|StrongDeveloper123!/);
  assert.equal(output.stagingExecutionRunbook.status, "ready_for_real_staging_dry_run");
  assert.equal(output.stagingExecutionRunbook.willModifyData, false);
  assert.equal(output.stagingExecutionRunbook.containsLiveWriteStep, true);
  assert.equal(output.stagingExecutionRunbook.liveWriteRequiresApproval, true);
  assert.equal(output.stagingExecutionRunbook.sourceBindingStatus, "ready_for_real_staging_binding");
  assert.equal(output.stagingExecutionRunbook.artifactArchiveRoot, "artifacts/staging/PILOT_ALPHA/stable");
  assert.deepEqual(
    output.stagingExecutionRunbook.commandSequence.map((item) => item.key),
    [
      "prepare_secret_env",
      "generate_rehearsal_outputs",
      "run_route_map_gate",
      "run_backup_restore_drill",
      "approve_live_write_smoke",
      "run_live_write_smoke",
      "archive_launch_smoke_handoff",
      "record_launch_mainline_evidence",
      "verify_receipt_visibility",
      "backfill_filled_closeout_input",
      "reload_closeout_input"
    ]
  );
  const runbookSteps = Object.fromEntries(
    output.stagingExecutionRunbook.commandSequence.map((item) => [item.key, item])
  );
  assert.deepEqual(runbookSteps.prepare_secret_env.env, [
    "RSL_SMOKE_ADMIN_PASSWORD",
    "RSL_SMOKE_DEVELOPER_PASSWORD",
    "RSL_DEVELOPER_BEARER_TOKEN"
  ]);
  assert.equal(runbookSteps.generate_rehearsal_outputs.command, output.stagingEnvironmentBinding.dryRunCommand);
  assert.deepEqual(runbookSteps.generate_rehearsal_outputs.outputs, ["handoff_file", "closeout_file"]);
  assert.equal(runbookSteps.run_route_map_gate.command, "npm.cmd run launch:route-map-gate");
  assert.deepEqual(runbookSteps.run_backup_restore_drill.commandKeys, [
    "appBackup",
    "postgresBackup",
    "postgresRestoreDryRun",
    "restoreDrillReminder",
    "healthcheck"
  ]);
  assert.equal(runbookSteps.run_live_write_smoke.willModifyData, true);
  assert.match(runbookSteps.run_live_write_smoke.command, /launch:smoke:staging/);
  assert.equal(runbookSteps.record_launch_mainline_evidence.endpoint, output.evidenceActionPlan.endpoint);
  assert.equal(runbookSteps.backfill_filled_closeout_input.closeoutInputPath, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.equal(runbookSteps.reload_closeout_input.command, "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.deepEqual(
    output.stagingExecutionRunbook.closeoutBackfillTargets.map((item) => [item.key, item.sourceStep, item.artifactPath]),
    [
      ["route_map_gate_result", "run_route_map_gate", "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt"],
      ["backup_restore_drill_result", "run_backup_restore_drill", "artifacts/staging/PILOT_ALPHA/stable/backup-restore-drill.txt"],
      ["live_write_smoke_result", "run_live_write_smoke", "artifacts/staging/PILOT_ALPHA/stable/live-write-smoke-output.json"],
      ["launch_smoke_handoff", "archive_launch_smoke_handoff", "artifacts/staging/PILOT_ALPHA/stable/launch-smoke-handoff.json"],
      ["launch_mainline_evidence_receipts", "record_launch_mainline_evidence", "artifacts/staging/PILOT_ALPHA/stable/launch-mainline-evidence-receipts.json"],
      ["receipt_visibility_review", "verify_receipt_visibility", "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-review.txt"],
      ["operator_go_no_go", "backfill_filled_closeout_input", "artifacts/staging/PILOT_ALPHA/stable/operator-go-no-go.md"]
    ]
  );
  assert.doesNotMatch(JSON.stringify(output.stagingExecutionRunbook), /StrongAdmin123!|StrongDeveloper123!/);
  assert.equal(output.stagingReadinessTransition.status, "blocked_until_closeout_reload");
  assert.equal(output.stagingReadinessTransition.willModifyData, false);
  assert.equal(output.stagingReadinessTransition.sourceRunbookStatus, "ready_for_real_staging_dry_run");
  assert.equal(output.stagingReadinessTransition.closeoutInputStatus, "missing");
  assert.equal(output.stagingReadinessTransition.reloadStep.command, "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.deepEqual(
    output.stagingReadinessTransition.gates.map((item) => [item.key, item.status, item.canEnter]),
    [
      ["full_test_window", "blocked", false],
      ["production_signoff", "blocked", false],
      ["launch_day_watch", "blocked", false]
    ]
  );
  assert.deepEqual(output.stagingReadinessTransition.orderedNextActions, [
    "complete_staging_execution_runbook",
    "backfill_filled_closeout_input",
    "reload_closeout_input",
    "enter_full_test_window_after_ready",
    "backfill_production_signoff_after_full_test"
  ]);
  assert.doesNotMatch(JSON.stringify(output.stagingReadinessTransition), /StrongAdmin123!|StrongDeveloper123!/);
  assert.equal(output.launchRehearsalBundle.status, "ready_for_staging_rehearsal_bundle");
  assert.equal(output.launchRehearsalBundle.willModifyData, false);
  assert.equal(output.launchRehearsalBundle.containsLiveWriteStep, true);
  assert.equal(output.launchRehearsalBundle.liveWriteRequiresApproval, true);
  assert.deepEqual(output.launchRehearsalBundle.sourceStatuses, {
    environmentBinding: "ready_for_real_staging_binding",
    executionRunbook: "ready_for_real_staging_dry_run",
    readinessTransition: "blocked_until_closeout_reload"
  });
  assert.equal(output.launchRehearsalBundle.artifactArchiveRoot, "artifacts/staging/PILOT_ALPHA/stable");
  assert.deepEqual(
    output.launchRehearsalBundle.files.map((item) => [item.key, item.path]),
    output.stagingEnvironmentBinding.recommendedOutputFiles.map((item) => [item.key, item.path])
  );
  assert.deepEqual(output.launchRehearsalBundle.commands, {
    stagingRehearsalDryRun: output.stagingEnvironmentBinding.dryRunCommand,
    routeMapGate: "npm.cmd run launch:route-map-gate",
    liveWriteSmoke: output.nextCommands.launchSmoke,
    closeoutReload: "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json",
    fullTestWindow: "npm.cmd test"
  });
  assert.deepEqual(
    output.launchRehearsalBundle.executionOrder,
    [
      "prepare_secret_env",
      "generate_rehearsal_outputs",
      "run_route_map_gate",
      "run_backup_restore_drill",
      "approve_live_write_smoke",
      "run_live_write_smoke",
      "archive_launch_smoke_handoff",
      "record_launch_mainline_evidence",
      "verify_receipt_visibility",
      "backfill_filled_closeout_input",
      "reload_closeout_input",
      "run_full_test_window",
      "production_signoff_review",
      "launch_day_watch",
      "stabilization_handoff"
    ]
  );
  assert.deepEqual(
    output.launchRehearsalBundle.closeout.requiredKeys,
    output.stagingAcceptanceCloseout.acceptanceChecks.map((item) => item.key)
  );
  assert.equal(output.launchRehearsalBundle.closeout.filledInputPath, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
  assert.equal(output.launchRehearsalBundle.closeout.examplePath, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.example.json");
  assert.deepEqual(
    output.launchRehearsalBundle.closeout.backfillTargets.map((item) => [item.key, item.sourceStep]),
    output.stagingExecutionRunbook.closeoutBackfillTargets.map((item) => [item.key, item.sourceStep])
  );
  assert.deepEqual(
    output.launchRehearsalBundle.readiness.gates.map((item) => [item.key, item.status, item.canEnter]),
    output.stagingReadinessTransition.gates.map((item) => [item.key, item.status, item.canEnter])
  );
  assert.equal(output.launchRehearsalBundle.operatorRecord.requiredRecordKeys.length, output.stagingRunRecordTemplate.requiredRecordKeys.length);
  assert.equal(output.launchRehearsalBundle.extensionPoints.status, "ready_for_incremental_extensions");
  assert.equal(output.launchRehearsalBundle.extensionPoints.willModifyData, false);
  assert.deepEqual(
    output.launchRehearsalBundle.extensionPoints.supportedAdditions.map((item) => [item.key, item.builder]),
    [
      ["additional_output_file", "buildStagingEnvironmentBinding"],
      ["additional_execution_step", "buildStagingExecutionRunbook"],
      ["additional_closeout_key", "buildStagingAcceptanceCloseout"],
      ["additional_readiness_gate", "buildStagingReadinessTransition"]
    ]
  );
  assert.deepEqual(output.launchRehearsalBundle.extensionPoints.extensionWorkflow, [
    "add_builder_field",
    "mirror_in_launch_rehearsal_bundle",
    "add_rehearsal_assertion",
    "add_handoff_rendering",
    "add_closeout_template_assertion",
    "run_staging_rehearsal_targeted_test",
    "run_launch_route_map_gate"
  ]);
  assert.ok(
    output.launchRehearsalBundle.extensionPoints.supportedAdditions
      .find((item) => item.key === "additional_closeout_key")
      .affectedOutputs.includes("launchRehearsalBundle.closeout.requiredKeys")
  );
  assert.doesNotMatch(JSON.stringify(output.launchRehearsalBundle), /StrongAdmin123!|StrongDeveloper123!/);
  assert.equal(output.finalRehearsalPacket.status, "ready_for_operator_rehearsal");
  assert.equal(output.finalRehearsalPacket.willModifyData, false);
  assert.equal(output.finalRehearsalPacket.environmentBindingStatus, "ready_for_real_staging_binding");
  assert.equal(output.finalRehearsalPacket.executionRunbookStatus, "ready_for_real_staging_dry_run");
  assert.equal(output.finalRehearsalPacket.readinessTransitionStatus, "blocked_until_closeout_reload");
  assert.equal(output.finalRehearsalPacket.launchRehearsalBundleStatus, "ready_for_staging_rehearsal_bundle");
  assert.equal(output.finalRehearsalPacket.archiveRoot, "artifacts/staging/PILOT_ALPHA/stable");
  assert.equal(output.finalRehearsalPacket.commands.stagingRehearsalDryRun, output.stagingEnvironmentBinding.dryRunCommand);
  assert.equal(output.finalRehearsalPacket.commands.routeMapGate, "npm.cmd run launch:route-map-gate");
  assert.equal(output.finalRehearsalPacket.commands.fullTestWindow, "npm.cmd test");
  assert.equal(
    output.finalRehearsalPacket.commands.closeoutReload,
    "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json"
  );
  assert.deepEqual(
    output.finalRehearsalPacket.localFiles.map((item) => [item.key, item.path]),
    [
      ["handoff_file", null],
      ["closeout_file", null],
      ["filled_closeout_input", "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json"],
      ["filled_closeout_input_example", "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.example.json"],
      ["artifact_archive_root", "artifacts/staging/PILOT_ALPHA/stable"]
    ]
  );
  assert.deepEqual(
    output.finalRehearsalPacket.orderedSteps.map((item) => item.key),
    [
      "generate_rehearsal_outputs",
      "run_route_map_gate",
      "run_backup_restore_drill",
      "run_live_write_smoke",
      "record_launch_mainline_evidence",
      "backfill_filled_closeout_input",
      "reload_closeout_input",
      "run_full_test_window",
      "production_signoff_review",
      "launch_day_watch",
      "stabilization_handoff"
    ]
  );
  assert.equal(output.finalRehearsalPacket.nextAction, "Generate handoff and closeout files, run the ordered rehearsal steps, then reload the filled closeout input before the full test window.");
  assert.deepEqual(output.operatorExecutionPlan.readinessSummary, {
    status: "needs_operator_input",
    gapCount: 6,
    canRunLiveWriteSmoke: false,
    canRunFullTestWindow: false,
    canSignoffProduction: false,
    nextAction: "Resolve readinessGaps in order before live-write smoke, full test window, or production sign-off."
  });
  assert.deepEqual(
    output.operatorExecutionPlan.readinessGaps.map((item) => item.key),
    [
      "handoff_file_not_requested",
      "closeout_file_not_requested",
      "developer_bearer_token_missing",
      "closeout_backfill_pending",
      "full_test_window_blocked",
      "production_signoff_blocked"
    ]
  );
  assert.equal(
    output.operatorExecutionPlan.readinessGaps.find((item) => item.key === "closeout_backfill_pending").missingCloseoutKeys.length,
    output.stagingAcceptanceCloseout.acceptanceChecks.length
  );
  assert.equal(
    output.operatorExecutionPlan.readinessGaps.find((item) => item.key === "full_test_window_blocked").command,
    "npm.cmd test"
  );
  assert.match(output.operatorExecutionPlan.nextAction, /Run the ordered steps/);
  assert.doesNotMatch(JSON.stringify(output.operatorExecutionPlan), /StrongAdmin123!|StrongDeveloper123!/);
  assert.equal(output.resultBackfillSummary.status, "awaiting_staging_execution");
  assert.equal(output.resultBackfillSummary.willModifyData, false);
  assert.deepEqual(
    output.resultBackfillSummary.requiredResultKeys,
    [
      "route_map_gate_result",
      "backup_restore_drill_result",
      "live_write_smoke_result",
      "launch_smoke_handoff",
      "launch_mainline_evidence_receipts",
      "receipt_visibility_review"
    ]
  );
  assert.equal(output.resultBackfillSummary.destinations.launchMainline, output.nextCommands.launchMainline);
  assert.equal(
    output.resultBackfillSummary.destinations.developerOps,
    "https://staging.example.com/developer/ops?productCode=PILOT_ALPHA&source=staging-rehearsal&handoff=first-wave"
  );
  assert.equal(output.resultBackfillSummary.evidenceEndpoint, "https://staging.example.com/api/developer/launch-mainline/action");
  assert.deepEqual(output.resultBackfillSummary.receiptVisibilityDownloads, output.nextCommands.receiptVisibilitySummaries);
  assert.match(output.resultBackfillSummary.operatorNote, /Do not paste passwords/);
  assert.doesNotMatch(JSON.stringify(output.resultBackfillSummary), /StrongAdmin123!|StrongDeveloper123!/);
  assert.equal(output.stagingAcceptanceCloseout.status, "awaiting_operator_closeout");
  assert.equal(output.stagingAcceptanceCloseout.willModifyData, false);
  assert.equal(output.stagingAcceptanceCloseout.decision, "pending_staging_results");
  assert.deepEqual(output.stagingAcceptanceCloseout.requiredResultKeys, output.resultBackfillSummary.requiredResultKeys);
  assert.deepEqual(
    output.stagingAcceptanceCloseout.acceptanceChecks.map((item) => item.key),
    [
      "route_map_gate_result",
      "backup_restore_drill_result",
      "live_write_smoke_result",
      "launch_smoke_handoff",
      "launch_mainline_evidence_receipts",
      "receipt_visibility_review",
      "operator_go_no_go"
    ]
  );
  assert.equal(output.stagingAcceptanceCloseout.acceptanceChecks[0].command, "npm.cmd run launch:route-map-gate");
  assert.equal(output.stagingAcceptanceCloseout.destinations.launchMainline, output.nextCommands.launchMainline);
  assert.equal(output.stagingAcceptanceCloseout.destinations.developerOps, output.resultBackfillSummary.destinations.developerOps);
  assert.equal(output.stagingAcceptanceCloseout.destinations.evidenceEndpoint, output.evidenceActionPlan.endpoint);
  assert.deepEqual(output.stagingAcceptanceCloseout.destinations.receiptVisibilityDownloads, output.nextCommands.receiptVisibilitySummaries);
  assert.deepEqual(
    output.stagingAcceptanceCloseout.evidenceOperations.slice(0, 3),
    [
      "record_launch_rehearsal_run",
      "record_recovery_drill",
      "record_backup_verification"
    ]
  );
  assert.match(output.stagingAcceptanceCloseout.nextAction, /full repository test window/);
  assert.match(output.stagingAcceptanceCloseout.operatorNote, /redacted result values/);
  assert.equal(output.stagingAcceptanceCloseout.artifactReceiptLedger.status, "awaiting_staging_artifacts");
  assert.equal(output.stagingAcceptanceCloseout.artifactReceiptLedger.willModifyData, false);
  assert.equal(output.stagingAcceptanceCloseout.artifactReceiptLedger.archiveRoot, "artifacts/staging/PILOT_ALPHA/stable");
  assert.deepEqual(
    output.stagingAcceptanceCloseout.artifactReceiptLedger.columns,
    [
      "check_key",
      "artifact_key",
      "artifact_path",
      "receipt_operations",
      "closeout_status",
      "operator_note"
    ]
  );
  assert.deepEqual(
    output.stagingAcceptanceCloseout.artifactReceiptLedger.rows.map((item) => item.checkKey),
    [
      "route_map_gate_result",
      "backup_restore_drill_result",
      "live_write_smoke_result",
      "launch_smoke_handoff",
      "launch_mainline_evidence_receipts",
      "receipt_visibility_review",
      "operator_go_no_go"
    ]
  );
  assert.match(
    output.stagingAcceptanceCloseout.artifactReceiptLedger.rows[0].artifactPath,
    /artifacts\/staging\/PILOT_ALPHA\/stable\/route-map-gate-output\.txt$/
  );
  assert.deepEqual(
    output.stagingAcceptanceCloseout.artifactReceiptLedger.rows.find((item) => item.checkKey === "backup_restore_drill_result").receiptOperations,
    ["record_recovery_drill", "record_backup_verification"]
  );
  assert.deepEqual(
    output.stagingAcceptanceCloseout.artifactReceiptLedger.rows.find((item) => item.checkKey === "launch_mainline_evidence_receipts").receiptOperations,
    output.evidenceActionPlan.items.map((item) => item.operation)
  );
  assert.deepEqual(
    output.stagingAcceptanceCloseout.artifactReceiptLedger.rows.find((item) => item.checkKey === "operator_go_no_go").allowedDecisions,
    ["ready-for-full-test-window", "hold", "rollback-follow-up"]
  );
  assert.doesNotMatch(JSON.stringify(output.stagingAcceptanceCloseout.artifactReceiptLedger), /StrongAdmin123!|StrongDeveloper123!/);
  assert.equal(output.stagingAcceptanceCloseout.fullTestWindowEntry.status, "blocked_until_staging_closeout");
  assert.equal(output.stagingAcceptanceCloseout.fullTestWindowEntry.command, "npm.cmd test");
  assert.equal(output.stagingAcceptanceCloseout.fullTestWindowEntry.willRunFullSuite, true);
  assert.equal(output.stagingAcceptanceCloseout.fullTestWindowEntry.willModifyData, false);
  assert.equal(output.stagingAcceptanceCloseout.fullTestWindowEntry.triggerDecision, "ready-for-full-test-window");
  assert.deepEqual(
    output.stagingAcceptanceCloseout.fullTestWindowEntry.requiredCloseoutKeys,
    output.stagingAcceptanceCloseout.acceptanceChecks.map((item) => item.key)
  );
  assert.deepEqual(
    output.stagingAcceptanceCloseout.fullTestWindowEntry.entryCriteria.map((item) => item.key),
    [
      "staging_closeout_completed",
      "artifact_receipt_ledger_filled",
      "operator_go_no_go_ready",
      "test_window_reserved"
    ]
  );
  assert.match(output.stagingAcceptanceCloseout.fullTestWindowEntry.nextAction, /Do not run the full suite/);
  assert.equal(output.stagingAcceptanceCloseout.productionSignoffConditions.status, "blocked_until_full_test_window");
  assert.equal(output.stagingAcceptanceCloseout.productionSignoffConditions.requiredDecision, "ready-for-production-signoff");
  assert.deepEqual(
    output.stagingAcceptanceCloseout.productionSignoffConditions.conditions.map((item) => item.key),
    [
      "full_test_window_passed",
      "staging_artifacts_archived",
      "launch_mainline_receipts_visible",
      "backup_restore_drill_passed",
      "rollback_path_confirmed",
      "operator_signoff_recorded"
    ]
  );
  assert.match(output.stagingAcceptanceCloseout.productionSignoffConditions.nextAction, /production cutover/);
  assert.doesNotMatch(JSON.stringify(output.stagingAcceptanceCloseout), /StrongAdmin123!|StrongDeveloper123!/);
});

test("staging rehearsal runner can load a non-secret staging profile file", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-rehearsal-profile-"));
  const profileFile = join(tempDir, "staging-profile.json");
  try {
    const handoffFile = join(tempDir, "profile-handoff.md");
    const closeoutFile = join(tempDir, "profile-closeout.json");
    writeFileSync(profileFile, JSON.stringify({
      baseUrl: "https://profile-staging.example.com",
      productCode: "PROFILE_PRODUCT",
      channel: "beta",
      adminUsername: "profile-admin@example.com",
      developerUsername: "profile.developer",
      targetOs: "linux",
      storageProfile: "postgres-preview",
      targetEnvFile: "/etc/rocksolidlicense/profile.env",
      appBackupDir: "/var/lib/rocksolid/profile-backups",
      postgresBackupDir: "/var/lib/rocksolid/profile-postgres-backups"
    }, null, 2));

    const result = runRehearsal([
      "--profile-file",
      profileFile,
      "--channel",
      "stable",
      "--handoff-file",
      handoffFile,
      "--closeout-file",
      closeoutFile
    ], {
      RSL_SMOKE_ADMIN_PASSWORD: "ProfileAdmin123!",
      RSL_SMOKE_DEVELOPER_PASSWORD: "ProfileDeveloper123!"
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "pass");
    assert.deepEqual(output.stagingProfile, {
      loaded: true,
      file: profileFile,
      providedKeys: [
        "adminUsername",
        "appBackupDir",
        "baseUrl",
        "channel",
        "developerUsername",
        "postgresBackupDir",
        "productCode",
        "storageProfile",
        "targetEnvFile",
        "targetOs"
      ],
      secretPolicy: "passwords_and_bearer_tokens_must_come_from_environment_or_cli"
    });
    assert.equal(output.summary.baseUrl, "https://profile-staging.example.com");
    assert.equal(output.summary.productCode, "PROFILE_PRODUCT");
    assert.equal(output.summary.channel, "stable");
    assert.equal(output.summary.storageProfile, "postgres-preview");
    assert.equal(output.stagingProfileLaunchPlan.status, "ready_for_profile_driven_rehearsal");
    assert.equal(output.stagingProfileLaunchPlan.willModifyData, false);
    assert.equal(output.stagingProfileLaunchPlan.profileFile, profileFile);
    assert.deepEqual(output.stagingProfileLaunchPlan.cliOverrideKeys, [
      "channel",
      "handoffFile",
      "closeoutFile"
    ]);
    assert.deepEqual(output.stagingProfileLaunchPlan.missingRequiredInputs, []);
    assert.deepEqual(output.stagingProfileLaunchPlan.missingOutputFiles, []);
    assert.deepEqual(
      output.stagingProfileLaunchPlan.requiredSecretEnv.map((item) => [item.key, item.phase, item.present]),
      [
        ["RSL_SMOKE_ADMIN_PASSWORD", "before_live_write_smoke", true],
        ["RSL_SMOKE_DEVELOPER_PASSWORD", "before_live_write_smoke", true],
        ["RSL_DEVELOPER_BEARER_TOKEN", "before_evidence_recording", false]
      ]
    );
    assert.match(output.stagingProfileLaunchPlan.recommendedCommand, /npm\.cmd run staging:rehearsal -- --profile-file /);
    assert.match(output.stagingProfileLaunchPlan.recommendedCommand, /--channel stable/);
    assert.match(output.stagingProfileLaunchPlan.recommendedCommand, /--handoff-file /);
    assert.match(output.stagingProfileLaunchPlan.nextAction, /Set required secret env vars/);
    assert.equal(output.stagingProfileOperatorPreflight.mode, "staging-profile-operator-preflight");
    assert.equal(output.stagingProfileOperatorPreflight.status, "blocked_until_secret_env");
    assert.equal(output.stagingProfileOperatorPreflight.profileStatus, "ready_for_profile_driven_rehearsal");
    assert.equal(output.stagingProfileOperatorPreflight.profileFile, profileFile);
    assert.deepEqual(output.stagingProfileOperatorPreflight.missingRequiredInputs, []);
    assert.deepEqual(output.stagingProfileOperatorPreflight.missingOutputFiles, []);
    assert.deepEqual(output.stagingProfileOperatorPreflight.missingSecretEnv, ["RSL_DEVELOPER_BEARER_TOKEN"]);
    assert.equal(output.stagingProfileOperatorPreflight.canRunDryRun, true);
    assert.equal(output.stagingProfileOperatorPreflight.canRunLiveWriteSmoke, true);
    assert.equal(output.stagingProfileOperatorPreflight.canRecordEvidence, false);
    assert.deepEqual(
      output.stagingProfileOperatorPreflight.recommendedFiles.map((item) => [item.key, item.path, item.status]),
      [
        ["handoff_file", handoffFile, "pending_write"],
        ["closeout_file", closeoutFile, "pending_write"],
        ["filled_closeout_input", "artifacts/staging/PROFILE_PRODUCT/stable/filled-closeout-input.json", "operator_create"],
        ["filled_closeout_input_example", "artifacts/staging/PROFILE_PRODUCT/stable/filled-closeout-input.example.json", "example_only"],
        ["artifact_archive_root", "artifacts/staging/PROFILE_PRODUCT/stable", "operator_archive"]
      ]
    );
    assert.deepEqual(
      output.stagingProfileOperatorPreflight.commandSequence,
      [
        "prepare_secret_env",
        "generate_rehearsal_outputs",
        "run_route_map_gate",
        "run_backup_restore_drill",
        "approve_live_write_smoke",
        "run_live_write_smoke",
        "archive_launch_smoke_handoff",
        "record_launch_mainline_evidence",
        "verify_receipt_visibility",
        "backfill_filled_closeout_input",
        "reload_closeout_input"
      ]
    );
    assert.equal(output.stagingProfileOperatorPreflight.commands.profileDrivenRehearsal, output.stagingProfileLaunchPlan.recommendedCommand);
    assert.equal(output.stagingProfileOperatorPreflight.commands.stagingDryRun, output.stagingEnvironmentBinding.dryRunCommand);
    assert.equal(output.stagingProfileOperatorPreflight.commands.routeMapGate, "npm.cmd run launch:route-map-gate");
    assert.equal(output.stagingProfileOperatorPreflight.commands.closeoutReload, "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PROFILE_PRODUCT/stable/filled-closeout-input.json");
    assert.equal(output.stagingProfileLaunchPlan.backfillManifest.status, "awaiting_profile_driven_results");
    assert.equal(output.stagingProfileLaunchPlan.backfillManifest.archiveRoot, "artifacts/staging/PROFILE_PRODUCT/stable");
    assert.equal(output.stagingProfileLaunchPlan.backfillManifest.closeoutInputPath, "artifacts/staging/PROFILE_PRODUCT/stable/filled-closeout-input.json");
    assert.deepEqual(
      output.stagingProfileLaunchPlan.backfillManifest.rows.map((item) => [item.closeoutKey, item.sourceStep, item.artifactPath]),
      [
        ["route_map_gate_result", "run_route_map_gate", "artifacts/staging/PROFILE_PRODUCT/stable/route-map-gate-output.txt"],
        ["backup_restore_drill_result", "run_backup_restore_drill", "artifacts/staging/PROFILE_PRODUCT/stable/backup-restore-drill.txt"],
        ["live_write_smoke_result", "run_live_write_smoke", "artifacts/staging/PROFILE_PRODUCT/stable/live-write-smoke-output.json"],
        ["launch_smoke_handoff", "archive_launch_smoke_handoff", "artifacts/staging/PROFILE_PRODUCT/stable/launch-smoke-handoff.json"],
        ["launch_mainline_evidence_receipts", "record_launch_mainline_evidence", "artifacts/staging/PROFILE_PRODUCT/stable/launch-mainline-evidence-receipts.json"],
        ["receipt_visibility_review", "verify_receipt_visibility", "artifacts/staging/PROFILE_PRODUCT/stable/receipt-visibility-review.txt"],
        ["operator_go_no_go", "backfill_filled_closeout_input", "artifacts/staging/PROFILE_PRODUCT/stable/operator-go-no-go.md"]
      ]
    );
    assert.deepEqual(
      output.stagingProfileLaunchPlan.backfillManifest.rows.find((item) => item.closeoutKey === "backup_restore_drill_result").receiptOperations,
      ["record_recovery_drill", "record_backup_verification"]
    );
    assert.ok(
      output.stagingProfileLaunchPlan.backfillManifest.rows
        .find((item) => item.closeoutKey === "launch_mainline_evidence_receipts")
        .receiptOperations.includes("record_launch_stabilization_review")
    );
    assert.match(output.nextCommands.launchSmoke, /profile-staging\.example\.com/);
    assert.match(output.nextCommands.launchSmoke, /\$env:RSL_SMOKE_ADMIN_PASSWORD/);
    assert.equal(output.stagingEnvironmentBinding.environment.targetEnvFile, "/etc/rocksolidlicense/profile.env");
    assert.equal(output.stagingEnvironmentBinding.environment.appBackupDir, "/var/lib/rocksolid/profile-backups");
    assert.equal(output.stagingEnvironmentBinding.environment.postgresBackupDir, "/var/lib/rocksolid/profile-postgres-backups");
    const handoff = readFileSync(handoffFile, "utf8");
    assert.match(handoff, new RegExp(`Staging profile: ${profileFile.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
    assert.match(handoff, /Profile keys: adminUsername, appBackupDir, baseUrl, channel, developerUsername, postgresBackupDir, productCode, storageProfile, targetEnvFile, targetOs/);
    assert.match(handoff, /## Staging Profile Launch Plan/);
    assert.match(handoff, /Profile launch plan status: ready_for_profile_driven_rehearsal/);
    assert.match(handoff, /CLI override keys: channel, handoffFile, closeoutFile/);
    assert.match(handoff, /RSL_DEVELOPER_BEARER_TOKEN: missing before_evidence_recording/);
    assert.match(handoff, /## Staging Profile Operator Preflight/);
    assert.match(handoff, /Profile preflight status: blocked_until_secret_env/);
    assert.match(handoff, /Missing secret env: RSL_DEVELOPER_BEARER_TOKEN/);
    assert.match(handoff, /Can run dry run: yes/);
    assert.match(handoff, /Can record evidence: no/);
    assert.match(handoff, /Backfill manifest: awaiting_profile_driven_results/);
    assert.match(handoff, /backup_restore_drill_result: run_backup_restore_drill -> artifacts\/staging\/PROFILE_PRODUCT\/stable\/backup-restore-drill\.txt/);
    assert.match(handoff, /launch_mainline_evidence_receipts: record_launch_mainline_evidence -> artifacts\/staging\/PROFILE_PRODUCT\/stable\/launch-mainline-evidence-receipts\.json/);
    const template = JSON.parse(readFileSync(closeoutFile, "utf8"));
    assert.deepEqual(template.stagingProfile, output.stagingProfile);
    assert.deepEqual(template.stagingProfileLaunchPlan, output.stagingProfileLaunchPlan);
    assert.deepEqual(template.stagingProfileOperatorPreflight, output.stagingProfileOperatorPreflight);
    assert.equal(output.filledCloseoutInputDraft.mode, "staging-closeout-input-draft");
    assert.equal(output.filledCloseoutInputDraft.status, "draft_replace_before_use");
    assert.equal(output.filledCloseoutInputDraft.exampleOnly, true);
    assert.equal(output.filledCloseoutInputDraft.source, "stagingProfileLaunchPlan.backfillManifest");
    assert.equal(output.filledCloseoutInputDraft.copyTo, "artifacts/staging/PROFILE_PRODUCT/stable/filled-closeout-input.json");
    assert.equal(output.filledCloseoutInputDraft.saveAs, "artifacts/staging/PROFILE_PRODUCT/stable/filled-closeout-input.draft.json");
    assert.deepEqual(
      output.filledCloseoutInputDraft.acceptanceFields.map((item) => [item.key, item.sourceStep, item.artifactPath, item.value]),
      [
        ["route_map_gate_result", "run_route_map_gate", "artifacts/staging/PROFILE_PRODUCT/stable/route-map-gate-output.txt", null],
        ["backup_restore_drill_result", "run_backup_restore_drill", "artifacts/staging/PROFILE_PRODUCT/stable/backup-restore-drill.txt", null],
        ["live_write_smoke_result", "run_live_write_smoke", "artifacts/staging/PROFILE_PRODUCT/stable/live-write-smoke-output.json", null],
        ["launch_smoke_handoff", "archive_launch_smoke_handoff", "artifacts/staging/PROFILE_PRODUCT/stable/launch-smoke-handoff.json", null],
        ["launch_mainline_evidence_receipts", "record_launch_mainline_evidence", "artifacts/staging/PROFILE_PRODUCT/stable/launch-mainline-evidence-receipts.json", null],
        ["receipt_visibility_review", "verify_receipt_visibility", "artifacts/staging/PROFILE_PRODUCT/stable/receipt-visibility-review.txt", null],
        ["operator_go_no_go", "backfill_filled_closeout_input", "artifacts/staging/PROFILE_PRODUCT/stable/operator-go-no-go.md", null]
      ]
    );
    assert.deepEqual(template.filledCloseoutInputDraft, output.filledCloseoutInputDraft);
    assert.doesNotMatch(JSON.stringify(output), /ProfileAdmin123!|ProfileDeveloper123!/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("staging rehearsal runner refuses staging profile files containing secret values", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-rehearsal-profile-secret-"));
  const profileFile = join(tempDir, "staging-profile.json");
  try {
    writeFileSync(profileFile, JSON.stringify({
      baseUrl: "https://profile-staging.example.com",
      productCode: "PROFILE_PRODUCT",
      adminPassword: "DoNotStoreThisPassword123!"
    }, null, 2));

    const result = runRehearsal([
      "--profile-file",
      profileFile
    ]);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "fail");
    assert.match(output.error.message, /staging profile cannot contain secret field: adminPassword/);
    assert.doesNotMatch(JSON.stringify(output), /DoNotStoreThisPassword123!/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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
  assert.equal(output.stagingAcceptanceCloseout, null);
});

test("staging rehearsal runner can write a redacted launch-duty handoff file", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-rehearsal-handoff-"));
  try {
    const handoffFile = join(tempDir, "staging-rehearsal-handoff.md");
    const result = runRehearsal([
      ...validArgs,
      "--handoff-file",
      handoffFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "pass");
    assert.equal(output.handoffFile.path, handoffFile);
    assert.equal(output.handoffFile.written, true);
    assert.equal(existsSync(handoffFile), true);

    const handoff = readFileSync(handoffFile, "utf8");
    assert.match(handoff, /# Staging Rehearsal Handoff/);
    assert.match(handoff, /launch:smoke:staging/);
    assert.match(handoff, /## Staging Profile Operator Preflight/);
    assert.match(handoff, /Profile preflight status: profile_not_loaded/);
    assert.match(handoff, /## Launch Route Map Targeted Gate/);
    assert.match(handoff, /npm\.cmd run launch:route-map-gate/);
    assert.match(handoff, /npm\.cmd run launch:route-map-gate -- --dry-run --json/);
    assert.match(handoff, /## Receipt Visibility Summary Downloads/);
    assert.match(handoff, /Launch Review summary: `https:\/\/staging\.example\.com\/api\/developer\/launch-review\/download\?productCode=PILOT_ALPHA&channel=stable&source=launch-smoke&handoff=first-wave&format=summary`/);
    assert.match(handoff, /Launch Smoke Kit summary: `https:\/\/staging\.example\.com\/api\/developer\/launch-smoke-kit\/download\?productCode=PILOT_ALPHA&channel=stable&operation=record_post_launch_ops_sweep&downloadKey=launch_smoke_summary&format=summary`/);
    assert.match(handoff, /\/api\/developer\/launch-mainline\/action/);
    assert.match(handoff, /record_launch_rehearsal_run/);
    assert.match(handoff, /Record Launch Stabilization Review/);
    assert.match(handoff, /\$env:RSL_DEVELOPER_BEARER_TOKEN/);
    assert.match(handoff, /Invoke-RestMethod -Method Post/);
    assert.match(handoff, /"operation": "record_launch_rehearsal_run"/);
    assert.match(handoff, /## Evidence Readiness/);
    assert.match(handoff, /Ready to execute evidence requests: no/);
    assert.match(handoff, /## Staging Environment Readiness/);
    assert.match(handoff, /public_https_entrypoint: pass/);
    assert.match(handoff, /non_default_secrets: operator_confirm/);
    assert.match(handoff, /backup_restore_drill: operator_execute/);
    assert.match(handoff, /route_map_gate: operator_execute/);
    assert.match(handoff, /## Staging Operator Checklist/);
    assert.match(handoff, /1\. Review environment readiness/);
    assert.match(handoff, /2\. Run route-map and download-surface gate/);
    assert.match(handoff, /5\. Run live-write staging smoke/);
    assert.match(handoff, /8\. Record Launch Mainline evidence/);
    assert.match(handoff, /## Staging Result Backfill Summary/);
    assert.match(handoff, /route_map_gate_result/);
    assert.match(handoff, /launch_mainline_evidence_receipts/);
    assert.match(handoff, /Developer Ops: https:\/\/staging\.example\.com\/developer\/ops\?productCode=PILOT_ALPHA&source=staging-rehearsal&handoff=first-wave/);
    assert.match(handoff, /## Staging Acceptance Closeout/);
    assert.match(handoff, /Decision: pending_staging_results/);
    assert.match(handoff, /operator_go_no_go/);
    assert.match(handoff, /full repository test window/);
    assert.match(handoff, /## Closeout Backfill Guide/);
    assert.match(handoff, /Closeout input reload: `npm\.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout\.json>`/);
    assert.match(handoff, /Full test window command: `npm\.cmd test`/);
    assert.match(handoff, /Production sign-off decision: ready-for-production-signoff/);
    assert.match(handoff, /## Full Test Window Readiness/);
    assert.match(handoff, /Status: blocked/);
    assert.match(handoff, /Can run: no/);
    assert.match(handoff, /Reload command: `npm\.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout\.json>`/);
    assert.match(handoff, /## Production Sign-Off Readiness/);
    assert.match(handoff, /Can sign off: no/);
    assert.match(handoff, /Missing sign-off keys: full_test_window_passed, staging_artifacts_archived, launch_mainline_receipts_visible, backup_restore_drill_passed, rollback_path_confirmed, operator_signoff_recorded/);
    assert.match(handoff, /Missing receipt visibility keys: launchMainline, launchReview, launchSmoke, developerOps/);
    assert.match(handoff, /## Launch Day Watch Plan/);
    assert.match(handoff, /Can start cutover watch: no/);
    assert.match(handoff, /Watch windows: cutover_watch, first_wave_stabilization/);
    assert.match(handoff, /Escalation triggers: production_signoff_missing, receipt_visibility_missing, launch_mainline_action_failure, developer_ops_receipt_mismatch, backup_restore_or_rollback_unclear/);
    assert.match(handoff, /## Stabilization Handoff Plan/);
    assert.match(handoff, /Can start stabilization handoff: no/);
    assert.match(handoff, /Required evidence keys: launch_day_watch_summary, first_wave_incident_log, receipt_visibility_snapshot, rollback_signal_review, stabilization_owner_handoff/);
    assert.match(handoff, /Handoff windows: T\+2h stabilization owner handoff, T\+24h first-wave closeout/);
    assert.match(handoff, /## Staging Run Record Template/);
    assert.match(handoff, /Archive root: artifacts\/staging\/PILOT_ALPHA\/stable/);
    assert.match(handoff, /Closeout reload: `npm\.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout\.json>`/);
    assert.match(handoff, /launch_day_watch_summary: artifacts\/staging\/PILOT_ALPHA\/stable\/launch-day-watch-summary\.md/);
    assert.match(handoff, /stabilization_owner_handoff: artifacts\/staging\/PILOT_ALPHA\/stable\/stabilization-owner-handoff\.md/);
    assert.match(handoff, /## Staging Environment Binding/);
    assert.match(handoff, /Binding status: ready_for_real_staging_binding/);
    assert.match(handoff, /Admin password env: RSL_SMOKE_ADMIN_PASSWORD/);
    assert.match(handoff, /Developer password env: RSL_SMOKE_DEVELOPER_PASSWORD/);
    assert.ok(handoff.includes(`Handoff file: ${handoffFile}`));
    assert.match(handoff, /Closeout file: artifacts\/staging\/PILOT_ALPHA\/stable\/staging-closeout-template\.json/);
    assert.match(handoff, /Dry run command: `npm\.cmd run staging:rehearsal -- --json/);
    assert.match(handoff, /## Staging Execution Runbook/);
    assert.match(handoff, /Runbook status: ready_for_real_staging_dry_run/);
    assert.match(handoff, /Contains live-write step: yes/);
    assert.match(handoff, /Command sequence: prepare_secret_env, generate_rehearsal_outputs, run_route_map_gate, run_backup_restore_drill, approve_live_write_smoke, run_live_write_smoke, archive_launch_smoke_handoff, record_launch_mainline_evidence, verify_receipt_visibility, backfill_filled_closeout_input, reload_closeout_input/);
    assert.match(handoff, /Closeout review: not_loaded \(missing=7, safeForFullTest=no\)/);
    assert.match(handoff, /route_map_gate_result: run_route_map_gate -> artifacts\/staging\/PILOT_ALPHA\/stable\/route-map-gate-output\.txt/);
    assert.match(handoff, /operator_go_no_go: backfill_filled_closeout_input -> artifacts\/staging\/PILOT_ALPHA\/stable\/operator-go-no-go\.md/);
    assert.match(handoff, /## Staging Readiness Transition/);
    assert.match(handoff, /Transition status: blocked_until_closeout_reload/);
    assert.match(handoff, /Closeout input status: missing/);
    assert.match(handoff, /full_test_window: blocked \(canEnter=no\)/);
    assert.match(handoff, /Ordered next actions: complete_staging_execution_runbook, backfill_filled_closeout_input, reload_closeout_input, enter_full_test_window_after_ready, backfill_production_signoff_after_full_test/);
    assert.match(handoff, /## Launch Rehearsal Bundle/);
    assert.match(handoff, /Bundle status: ready_for_staging_rehearsal_bundle/);
    assert.match(handoff, /Readiness transition: blocked_until_closeout_reload/);
    assert.match(handoff, /Execution order: prepare_secret_env, generate_rehearsal_outputs, run_route_map_gate, run_backup_restore_drill, approve_live_write_smoke, run_live_write_smoke, archive_launch_smoke_handoff, record_launch_mainline_evidence, verify_receipt_visibility, backfill_filled_closeout_input, reload_closeout_input, run_full_test_window, production_signoff_review, launch_day_watch, stabilization_handoff/);
    assert.match(handoff, /Closeout reload: `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json`/);
    assert.match(handoff, /route_map_gate_result -> artifacts\/staging\/PILOT_ALPHA\/stable\/route-map-gate-output\.txt/);
    assert.match(handoff, /Extension status: ready_for_incremental_extensions/);
    assert.match(handoff, /additional_execution_step: buildStagingExecutionRunbook/);
    assert.match(handoff, /Extension workflow: add_builder_field, mirror_in_launch_rehearsal_bundle, add_rehearsal_assertion, add_handoff_rendering, add_closeout_template_assertion, run_staging_rehearsal_targeted_test, run_launch_route_map_gate/);
    assert.match(handoff, /## Filled Closeout Input Example/);
    assert.match(handoff, /Example only: yes/);
    assert.match(handoff, /Save as: artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.example\.json/);
    assert.match(handoff, /Reload command: `npm\.cmd run staging:rehearsal -- --closeout-input-file artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json`/);
    assert.match(handoff, /Do not submit without replacing placeholders: yes/);
    assert.match(handoff, /## Filled Closeout Input Draft/);
    assert.match(handoff, /Draft status: profile_not_loaded/);
    assert.match(handoff, /## Loaded Closeout Input Review/);
    assert.match(handoff, /Review status: not_loaded/);
    assert.match(handoff, /## Final Rehearsal Packet/);
    assert.match(handoff, /Packet status: ready_for_operator_rehearsal/);
    assert.match(handoff, /Filled closeout input: artifacts\/staging\/PILOT_ALPHA\/stable\/filled-closeout-input\.json/);
    assert.match(handoff, /Closeout review: not_loaded \(missing=7, safeForFullTest=no\)/);
    assert.match(handoff, /Ordered packet steps: generate_rehearsal_outputs, run_route_map_gate, run_backup_restore_drill, run_live_write_smoke, record_launch_mainline_evidence, backfill_filled_closeout_input, reload_closeout_input, run_full_test_window, production_signoff_review, launch_day_watch, stabilization_handoff/);
    assert.match(handoff, /## Artifact \/ Receipt Ledger/);
    assert.match(handoff, /artifacts\/staging\/PILOT_ALPHA\/stable/);
    assert.match(handoff, /launch_mainline_evidence_receipts/);
    assert.match(handoff, /record_recovery_drill, record_backup_verification/);
    assert.match(handoff, /## Full Test Window Entry/);
    assert.match(handoff, /Command: `npm\.cmd test`/);
    assert.match(handoff, /blocked_until_staging_closeout/);
    assert.match(handoff, /Do not run the full suite/);
    assert.match(handoff, /## Production Sign-Off Conditions/);
    assert.match(handoff, /blocked_until_full_test_window/);
    assert.match(handoff, /ready-for-production-signoff/);
    assert.match(handoff, /## Operator Execution Plan/);
    assert.match(handoff, /review_generated_bundle/);
    assert.match(handoff, /backfill_closeout_template/);
    assert.match(handoff, /production_signoff_review/);
    assert.match(handoff, /Readiness gaps/);
    assert.match(handoff, /closeout_backfill_pending/);
    assert.match(handoff, /developer_bearer_token_missing/);
    assert.match(handoff, /missingReceiptVisibilityKeys: launchMainline, launchReview, launchSmoke, developerOps/);
    assert.doesNotMatch(handoff, /StrongAdmin123!|StrongDeveloper123!/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging rehearsal runner can write a redacted closeout template file", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-rehearsal-closeout-"));
  try {
    const closeoutFile = join(tempDir, "staging-closeout-template.json");
    const result = runRehearsal([
      ...validArgs,
      "--closeout-file",
      closeoutFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "pass");
    assert.equal(output.closeoutFile.path, closeoutFile);
    assert.equal(output.closeoutFile.written, true);
    assert.equal(
      output.operatorExecutionPlan.outputFiles.find((item) => item.key === "closeout_file").status,
      "written"
    );
    assert.equal(
      output.operatorExecutionPlan.outputFiles.find((item) => item.key === "closeout_file").path,
      closeoutFile
    );
    assert.deepEqual(
      output.operatorExecutionPlan.readinessGaps.map((item) => item.key),
      [
        "handoff_file_not_requested",
        "developer_bearer_token_missing",
        "closeout_backfill_pending",
        "full_test_window_blocked",
        "production_signoff_blocked"
      ]
    );
    assert.equal(existsSync(closeoutFile), true);

    const template = JSON.parse(readFileSync(closeoutFile, "utf8"));
    assert.equal(template.mode, "staging-closeout-template");
    assert.equal(template.status, "awaiting_operator_closeout");
    assert.equal(template.productCode, "PILOT_ALPHA");
    assert.equal(template.channel, "stable");
    assert.equal(template.willModifyData, false);
    assert.deepEqual(template.stagingProfile, {
      loaded: false,
      file: null,
      providedKeys: [],
      secretPolicy: "passwords_and_bearer_tokens_must_come_from_environment_or_cli"
    });
    assert.equal(template.stagingProfileLaunchPlan.status, "profile_not_loaded");
    assert.equal(template.stagingProfileOperatorPreflight.status, "profile_not_loaded");
    assert.deepEqual(
      template.acceptanceFields.map((item) => item.key),
      output.stagingAcceptanceCloseout.acceptanceChecks.map((item) => item.key)
    );
    assert.equal(template.acceptanceFields.every((item) => item.status === "pending_operator_entry"), true);
    assert.equal(template.acceptanceFields.every((item) => item.value === null), true);
    const smokeField = template.acceptanceFields.find((item) => item.key === "live_write_smoke_result");
    assert.equal(smokeField.artifactPath, "artifacts/staging/PILOT_ALPHA/stable/live-write-smoke-output.json");
    assert.deepEqual(smokeField.receiptOperations, ["record_launch_rehearsal_run"]);
    assert.equal(template.fullTestWindowEntry.command, "npm.cmd test");
    assert.equal(template.fullTestWindowEntry.status, "blocked_until_staging_closeout");
    assert.equal(template.productionSignoffConditions.requiredDecision, "ready-for-production-signoff");
    assert.deepEqual(Object.keys(template.receiptVisibility), [
      "launchMainline",
      "launchReview",
      "launchSmoke",
      "developerOps"
    ]);
    assert.equal(template.receiptVisibility.launchMainline.status, "pending_operator_entry");
    assert.equal(template.receiptVisibility.launchMainline.value, null);
    assert.equal(template.receiptVisibility.launchMainline.expectedValue, "visible");
    assert.deepEqual(
      template.productionSignoff.conditions.map((item) => item.key),
      template.productionSignoffConditions.conditions.map((item) => item.key)
    );
    assert.equal(template.productionSignoff.decision, null);
    assert.equal(template.productionSignoff.requiredDecision, "ready-for-production-signoff");
    assert.equal(template.productionSignoff.conditions.every((item) => item.status === "pending_operator_entry"), true);
    assert.equal(template.productionSignoff.conditions.every((item) => item.value === null), true);
    assert.equal(template.filledCloseoutInputDraft.status, "profile_not_loaded");
    assert.equal(template.closeoutInputReview.status, "not_loaded");
    assert.equal(template.closeoutBackfillGuide.status, "awaiting_staging_results");
    assert.equal(template.closeoutBackfillGuide.closeoutInputReload.command, "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>");
    assert.deepEqual(
      template.closeoutBackfillGuide.orderedBackfillKeys,
      template.acceptanceFields.map((item) => item.key)
    );
    assert.deepEqual(template.closeoutBackfillGuide.receiptVisibilityKeys, [
      "launchMainline",
      "launchReview",
      "launchSmoke",
      "developerOps"
    ]);
    assert.equal(template.closeoutBackfillGuide.fullTestWindow.command, "npm.cmd test");
    assert.equal(template.closeoutBackfillGuide.fullTestWindow.requiredDecision, "ready-for-full-test-window");
    assert.equal(template.closeoutBackfillGuide.productionSignoff.requiredDecision, "ready-for-production-signoff");
    assert.equal(template.fullTestWindowReadiness.status, "blocked");
    assert.equal(template.fullTestWindowReadiness.canRun, false);
    assert.equal(template.fullTestWindowReadiness.command, "npm.cmd test");
    assert.equal(template.fullTestWindowReadiness.reloadCommand, "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>");
    assert.equal(template.productionSignoffReadiness.status, "blocked");
    assert.equal(template.productionSignoffReadiness.canSignoff, false);
    assert.deepEqual(
      template.productionSignoffReadiness.missingSignoffKeys,
      template.productionSignoffConditions.conditions.map((item) => item.key)
    );
    assert.deepEqual(template.productionSignoffReadiness.missingReceiptVisibilityKeys, [
      "launchMainline",
      "launchReview",
      "launchSmoke",
      "developerOps"
    ]);
    assert.equal(template.launchDayWatchPlan.status, "blocked");
    assert.equal(template.launchDayWatchPlan.canStartCutoverWatch, false);
    assert.deepEqual(
      template.launchDayWatchPlan.watchWindows.map((item) => item.key),
      ["cutover_watch", "first_wave_stabilization"]
    );
    assert.deepEqual(template.launchDayWatchPlan.missingReceiptVisibilityKeys, [
      "launchMainline",
      "launchReview",
      "launchSmoke",
      "developerOps"
    ]);
    assert.equal(template.stabilizationHandoffPlan.status, "blocked");
    assert.equal(template.stabilizationHandoffPlan.canStartStabilizationHandoff, false);
    assert.deepEqual(template.stabilizationHandoffPlan.requiredEvidenceKeys, [
      "launch_day_watch_summary",
      "first_wave_incident_log",
      "receipt_visibility_snapshot",
      "rollback_signal_review",
      "stabilization_owner_handoff"
    ]);
    assert.deepEqual(
      template.stabilizationHandoffPlan.handoffWindows.map((item) => item.key),
      ["stabilization_owner_handoff", "first_wave_closeout"]
    );
    assert.equal(template.stagingRunRecordTemplate.status, "awaiting_staging_execution");
    assert.equal(template.stagingRunRecordTemplate.archiveRoot, "artifacts/staging/PILOT_ALPHA/stable");
    assert.deepEqual(template.stagingRunRecordTemplate.requiredRecordKeys.slice(-5), [
      "launch_day_watch_summary",
      "first_wave_incident_log",
      "receipt_visibility_snapshot",
      "rollback_signal_review",
      "stabilization_owner_handoff"
    ]);
    assert.equal(
      template.stagingRunRecordTemplate.records.find((item) => item.key === "stabilization_owner_handoff").artifactPath,
      "artifacts/staging/PILOT_ALPHA/stable/stabilization-owner-handoff.md"
    );
    assert.equal(template.filledCloseoutInputExample.mode, "staging-closeout-input-example");
    assert.equal(template.filledCloseoutInputExample.exampleOnly, true);
    assert.equal(template.filledCloseoutInputExample.saveAs, "artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.example.json");
    assert.equal(
      template.filledCloseoutInputExample.acceptanceFields.find((item) => item.key === "launch_mainline_evidence_receipts").value.artifactPath,
      "artifacts/staging/PILOT_ALPHA/stable/launch-mainline-evidence-receipts.json"
    );
    assert.equal(template.filledCloseoutInputExample.receiptVisibility.developerOps.value, "visible");
    assert.equal(template.filledCloseoutInputExample.productionSignoff.decision, "ready-for-production-signoff");
    assert.equal(template.stagingEnvironmentBinding.status, "ready_for_real_staging_binding");
    assert.equal(
      template.stagingEnvironmentBinding.recommendedOutputFiles.find((item) => item.key === "closeout_file").path,
      closeoutFile
    );
    assert.match(template.stagingEnvironmentBinding.dryRunCommand, /--closeout-file /);
    assert.doesNotMatch(JSON.stringify(template.stagingEnvironmentBinding), /StrongAdmin123!|StrongDeveloper123!/);
    assert.equal(template.stagingExecutionRunbook.status, "ready_for_real_staging_dry_run");
    assert.equal(
      template.stagingExecutionRunbook.commandSequence.find((item) => item.key === "generate_rehearsal_outputs").command,
      template.stagingEnvironmentBinding.dryRunCommand
    );
    assert.equal(
      template.stagingExecutionRunbook.closeoutBackfillTargets.find((item) => item.key === "launch_smoke_handoff").sourceStep,
      "archive_launch_smoke_handoff"
    );
    assert.equal(template.stagingReadinessTransition.status, "blocked_until_closeout_reload");
    assert.equal(template.stagingReadinessTransition.gates.find((item) => item.key === "full_test_window").canEnter, false);
    assert.equal(template.launchRehearsalBundle.status, "ready_for_staging_rehearsal_bundle");
    assert.equal(template.launchRehearsalBundle.commands.closeoutReload, "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
    assert.deepEqual(template.launchRehearsalBundle.executionOrder.slice(-4), [
      "run_full_test_window",
      "production_signoff_review",
      "launch_day_watch",
      "stabilization_handoff"
    ]);
    assert.equal(template.launchRehearsalBundle.extensionPoints.status, "ready_for_incremental_extensions");
    assert.deepEqual(
      template.launchRehearsalBundle.extensionPoints.supportedAdditions.find((item) => item.key === "additional_execution_step").affectedOutputs,
      [
        "stagingExecutionRunbook.commandSequence",
        "launchRehearsalBundle.executionOrder",
        "finalRehearsalPacket.orderedSteps"
      ]
    );
    assert.equal(template.finalRehearsalPacket.status, "ready_for_operator_rehearsal");
    assert.equal(template.finalRehearsalPacket.environmentBindingStatus, "ready_for_real_staging_binding");
    assert.equal(template.finalRehearsalPacket.executionRunbookStatus, "ready_for_real_staging_dry_run");
    assert.equal(template.finalRehearsalPacket.readinessTransitionStatus, "blocked_until_closeout_reload");
    assert.equal(template.finalRehearsalPacket.launchRehearsalBundleStatus, "ready_for_staging_rehearsal_bundle");
    assert.equal(template.finalRehearsalPacket.commands.stagingRehearsalDryRun, template.stagingEnvironmentBinding.dryRunCommand);
    assert.equal(template.finalRehearsalPacket.commands.closeoutReload, "npm.cmd run staging:rehearsal -- --closeout-input-file artifacts/staging/PILOT_ALPHA/stable/filled-closeout-input.json");
    assert.equal(
      template.finalRehearsalPacket.localFiles.find((item) => item.key === "closeout_file").path,
      closeoutFile
    );
    assert.deepEqual(
      template.finalRehearsalPacket.orderedSteps.slice(-3).map((item) => item.key),
      ["production_signoff_review", "launch_day_watch", "stabilization_handoff"]
    );
    assert.equal(template.operatorExecutionPlan.status, "ready_for_staging_execution");
    assert.equal(
      template.operatorExecutionPlan.outputFiles.find((item) => item.key === "closeout_file").status,
      "written"
    );
    assert.deepEqual(
      template.operatorExecutionPlan.readinessGaps.map((item) => item.key),
      [
        "handoff_file_not_requested",
        "developer_bearer_token_missing",
        "closeout_backfill_pending",
        "full_test_window_blocked",
        "production_signoff_blocked"
      ]
    );
    assert.deepEqual(
      template.operatorExecutionPlan.orderedSteps.slice(-3).map((item) => item.key),
      [
        "backfill_closeout_template",
        "reserve_full_test_window",
        "production_signoff_review"
      ]
    );
    assert.equal(template.nextCommands.launchRouteMapGate.command, "npm.cmd run launch:route-map-gate");
    assert.doesNotMatch(JSON.stringify(template), /StrongAdmin123!|StrongDeveloper123!/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging rehearsal runner can read a redacted closeout input file to narrow readiness gaps", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-rehearsal-closeout-input-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-closeout.json");
    const closeoutInput = {
      mode: "staging-closeout-template",
      decision: "ready-for-full-test-window",
      acceptanceFields: [
        {
          key: "route_map_gate_result",
          status: "filled",
          value: {
            result: "pass",
            artifactPath: "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt"
          }
        },
        {
          key: "backup_restore_drill_result",
          status: "filled",
          value: {
            result: "pass",
            artifactPath: "artifacts/staging/PILOT_ALPHA/stable/backup-restore-drill.txt"
          }
        },
        {
          key: "live_write_smoke_result",
          status: "filled",
          value: {
            result: "pass",
            artifactPath: "artifacts/staging/PILOT_ALPHA/stable/live-write-smoke-output.json"
          }
        },
        {
          key: "launch_smoke_handoff",
          status: "filled",
          value: {
            artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-smoke-handoff.json"
          }
        },
        {
          key: "launch_mainline_evidence_receipts",
          status: "filled",
          value: {
            receiptIds: ["receipt-1", "receipt-2"]
          }
        },
        {
          key: "receipt_visibility_review",
          status: "filled",
          value: {
            result: "visible"
          }
        },
        {
          key: "operator_go_no_go",
          status: "filled",
          value: "ready-for-full-test-window"
        }
      ]
    };
    writeFileSync(closeoutInputFile, `${JSON.stringify(closeoutInput, null, 2)}\n`, "utf8");

    const result = runRehearsal([
      ...validArgs,
      "--closeout-input-file",
      closeoutInputFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.closeoutInput.path, closeoutInputFile);
    assert.equal(output.closeoutInput.status, "loaded");
    assert.equal(output.closeoutInput.decision, "ready-for-full-test-window");
    assert.deepEqual(output.closeoutInput.missingKeys, []);
    assert.equal(output.closeoutInput.backfillReview.mode, "staging-closeout-input-review");
    assert.equal(output.closeoutInput.backfillReview.status, "ready_for_full_test_window");
    assert.equal(output.closeoutInput.backfillReview.sourceMode, "staging-closeout-template");
    assert.equal(output.closeoutInput.backfillReview.draftPromotionStatus, "not_draft_source");
    assert.equal(output.closeoutInput.backfillReview.requiredFieldCount, 7);
    assert.equal(output.closeoutInput.backfillReview.filledFieldCount, 7);
    assert.equal(output.closeoutInput.backfillReview.missingFieldCount, 0);
    assert.equal(output.closeoutInput.backfillReview.safeToEnterFullTestWindow, true);
    assert.deepEqual(output.closeoutInput.backfillReview.missingFields, []);
    assert.deepEqual(output.stagingExecutionRunbook.closeoutInputReview, {
      status: "ready_for_full_test_window",
      draftPromotionStatus: "not_draft_source",
      missingFieldCount: 0,
      placeholderKeys: [],
      safeToEnterFullTestWindow: true
    });
    assert.equal(
      output.stagingExecutionRunbook.commandSequence.find((item) => item.key === "reload_closeout_input").closeoutInputReview.status,
      "ready_for_full_test_window"
    );
    assert.deepEqual(output.finalRehearsalPacket.closeoutInputReview, output.stagingExecutionRunbook.closeoutInputReview);
    assert.deepEqual(
      output.closeoutInput.filledKeys,
      output.stagingAcceptanceCloseout.acceptanceChecks.map((item) => item.key)
    );
    assert.deepEqual(
      output.operatorExecutionPlan.readinessGaps.map((item) => item.key),
      [
        "handoff_file_not_requested",
        "closeout_file_not_requested",
        "production_signoff_blocked"
      ]
    );
    assert.equal(output.operatorExecutionPlan.readinessSummary.canRunFullTestWindow, true);
    assert.equal(output.fullTestWindowReadiness.status, "ready");
    assert.equal(output.fullTestWindowReadiness.canRun, true);
    assert.deepEqual(output.fullTestWindowReadiness.missingCloseoutKeys, []);
    assert.equal(output.fullTestWindowReadiness.nextAction, "Run npm.cmd test in the reserved full test window, then backfill productionSignoff.");
    assert.equal(output.stagingReadinessTransition.status, "ready_for_full_test_window");
    assert.deepEqual(
      output.stagingReadinessTransition.gates.map((item) => [item.key, item.status, item.canEnter]),
      [
        ["full_test_window", "ready", true],
        ["production_signoff", "blocked", false],
        ["launch_day_watch", "blocked", false]
      ]
    );
    assert.deepEqual(output.stagingReadinessTransition.orderedNextActions, [
      "run_full_test_window",
      "backfill_production_signoff",
      "reload_closeout_input",
      "production_signoff_review"
    ]);
    assert.equal(output.finalRehearsalPacket.readinessTransitionStatus, "ready_for_full_test_window");
    assert.equal(output.operatorExecutionPlan.readinessSummary.canSignoffProduction, false);
    assert.equal(output.operatorExecutionPlan.readinessSummary.gapCount, 3);
    assert.equal(
      output.operatorExecutionPlan.readinessGaps.some((item) => item.key === "developer_bearer_token_missing"),
      false
    );
    assert.equal(
      output.operatorExecutionPlan.readinessGaps.some((item) => item.key === "closeout_backfill_pending"),
      false
    );
    assert.equal(
      output.operatorExecutionPlan.readinessGaps.some((item) => item.key === "full_test_window_blocked"),
      false
    );
    assert.doesNotMatch(result.stdout, /StrongAdmin123!|StrongDeveloper123!/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging rehearsal runner reports unfilled draft promotion fields without clearing readiness", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-rehearsal-draft-review-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-closeout-input.json");
    const closeoutInput = {
      mode: "staging-closeout-input-draft",
      decision: "ready-for-full-test-window",
      acceptanceFields: [
        {
          key: "route_map_gate_result",
          status: "filled",
          sourceStep: "run_route_map_gate",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/route-map-gate-output.txt",
          value: {
            result: "pass"
          }
        },
        {
          key: "backup_restore_drill_result",
          status: "pending_operator_entry",
          sourceStep: "run_backup_restore_drill",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/backup-restore-drill.txt",
          value: null
        },
        {
          key: "live_write_smoke_result",
          status: "pending_operator_entry",
          sourceStep: "run_live_write_smoke",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/live-write-smoke-output.json",
          value: null
        },
        {
          key: "launch_smoke_handoff",
          status: "filled",
          sourceStep: "archive_launch_smoke_handoff",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-smoke-handoff.json",
          value: {
            artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-smoke-handoff.json"
          }
        },
        {
          key: "launch_mainline_evidence_receipts",
          status: "filled",
          sourceStep: "record_launch_mainline_evidence",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/launch-mainline-evidence-receipts.json",
          value: {
            receiptIds: ["receipt-1"]
          }
        },
        {
          key: "receipt_visibility_review",
          status: "filled",
          sourceStep: "verify_receipt_visibility",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/receipt-visibility-review.txt",
          value: {
            result: "visible"
          }
        },
        {
          key: "operator_go_no_go",
          status: "filled",
          sourceStep: "backfill_filled_closeout_input",
          artifactPath: "artifacts/staging/PILOT_ALPHA/stable/operator-go-no-go.md",
          value: "ready-for-full-test-window"
        }
      ]
    };
    writeFileSync(closeoutInputFile, `${JSON.stringify(closeoutInput, null, 2)}\n`, "utf8");

    const result = runRehearsal([
      ...validArgs,
      "--closeout-input-file",
      closeoutInputFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.closeoutInput.readyForFullTestWindow, false);
    assert.equal(output.closeoutInput.backfillReview.status, "missing_required_fields");
    assert.equal(output.closeoutInput.backfillReview.sourceMode, "staging-closeout-input-draft");
    assert.equal(output.closeoutInput.backfillReview.draftPromotionStatus, "draft_needs_values");
    assert.equal(output.closeoutInput.backfillReview.requiredFieldCount, 7);
    assert.equal(output.closeoutInput.backfillReview.filledFieldCount, 5);
    assert.equal(output.closeoutInput.backfillReview.missingFieldCount, 2);
    assert.equal(output.closeoutInput.backfillReview.safeToEnterFullTestWindow, false);
    assert.deepEqual(output.stagingExecutionRunbook.closeoutInputReview, {
      status: "missing_required_fields",
      draftPromotionStatus: "draft_needs_values",
      missingFieldCount: 2,
      placeholderKeys: [
        "backup_restore_drill_result",
        "live_write_smoke_result"
      ],
      safeToEnterFullTestWindow: false
    });
    assert.deepEqual(output.finalRehearsalPacket.closeoutInputReview, output.stagingExecutionRunbook.closeoutInputReview);
    assert.deepEqual(
      output.finalRehearsalPacket.orderedSteps.find((item) => item.key === "reload_closeout_input").closeoutInputReview.placeholderKeys,
      [
        "backup_restore_drill_result",
        "live_write_smoke_result"
      ]
    );
    assert.deepEqual(
      output.closeoutInput.backfillReview.missingFields.map((item) => [item.key, item.sourceStep, item.artifactPath, item.nextAction]),
      [
        [
          "backup_restore_drill_result",
          "run_backup_restore_drill",
          "artifacts/staging/PILOT_ALPHA/stable/backup-restore-drill.txt",
          "Replace the draft placeholder with redacted evidence before the full test window."
        ],
        [
          "live_write_smoke_result",
          "run_live_write_smoke",
          "artifacts/staging/PILOT_ALPHA/stable/live-write-smoke-output.json",
          "Replace the draft placeholder with redacted evidence before the full test window."
        ]
      ]
    );
    assert.deepEqual(output.closeoutInput.backfillReview.placeholderKeys, [
      "backup_restore_drill_result",
      "live_write_smoke_result"
    ]);
    assert.equal(
      output.operatorExecutionPlan.readinessGaps.find((item) => item.key === "closeout_backfill_pending").missingCloseoutKeys.length,
      2
    );
    assert.doesNotMatch(result.stdout, /StrongAdmin123!|StrongDeveloper123!/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging rehearsal runner can read full-test signoff evidence to clear production signoff gap", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-rehearsal-signoff-input-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-signoff-closeout.json");
    const acceptanceFields = [
      "route_map_gate_result",
      "backup_restore_drill_result",
      "live_write_smoke_result",
      "launch_smoke_handoff",
      "launch_mainline_evidence_receipts",
      "receipt_visibility_review",
      "operator_go_no_go"
    ].map((key) => ({
      key,
      status: "filled",
      value: key === "operator_go_no_go" ? "ready-for-full-test-window" : { result: "pass" }
    }));
    const signoffConditions = [
      "full_test_window_passed",
      "staging_artifacts_archived",
      "launch_mainline_receipts_visible",
      "backup_restore_drill_passed",
      "rollback_path_confirmed",
      "operator_signoff_recorded"
    ].map((key) => ({
      key,
      status: "filled",
      value: key === "full_test_window_passed"
        ? { result: "pass", command: "npm.cmd test", failureCount: 0 }
        : { result: "confirmed" }
    }));
    const closeoutInput = {
      mode: "staging-closeout-template",
      decision: "ready-for-full-test-window",
      acceptanceFields,
      receiptVisibility: {
        launchMainline: "visible",
        launchReview: "visible",
        launchSmoke: "visible",
        developerOps: {
          status: "filled",
          value: "visible"
        }
      },
      productionSignoff: {
        decision: "ready-for-production-signoff",
        conditions: signoffConditions
      }
    };
    writeFileSync(closeoutInputFile, `${JSON.stringify(closeoutInput, null, 2)}\n`, "utf8");

    const result = runRehearsal([
      ...validArgs,
      "--closeout-input-file",
      closeoutInputFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.closeoutInput.readyForFullTestWindow, true);
    assert.equal(output.closeoutInput.readyForProductionSignoff, true);
    assert.equal(output.closeoutInput.readyForReceiptVisibility, true);
    assert.equal(output.closeoutInput.productionDecision, "ready-for-production-signoff");
    assert.deepEqual(output.closeoutInput.signoffMissingKeys, []);
    assert.deepEqual(output.closeoutInput.missingReceiptVisibilityKeys, []);
    assert.deepEqual(
      output.closeoutInput.signoffFilledKeys,
      output.stagingAcceptanceCloseout.productionSignoffConditions.conditions.map((item) => item.key)
    );
    assert.deepEqual(
      output.operatorExecutionPlan.readinessGaps.map((item) => item.key),
      [
        "handoff_file_not_requested",
        "closeout_file_not_requested"
      ]
    );
    assert.equal(output.operatorExecutionPlan.readinessSummary.canRunFullTestWindow, true);
    assert.equal(output.operatorExecutionPlan.readinessSummary.canSignoffProduction, true);
    assert.equal(output.productionSignoffReadiness.status, "ready");
    assert.equal(output.productionSignoffReadiness.canSignoff, true);
    assert.equal(output.productionSignoffReadiness.productionDecision, "ready-for-production-signoff");
    assert.deepEqual(output.productionSignoffReadiness.missingSignoffKeys, []);
    assert.deepEqual(output.productionSignoffReadiness.missingReceiptVisibilityKeys, []);
    assert.equal(output.productionSignoffReadiness.nextAction, "Production sign-off is ready; keep the closeout artifact with release evidence before cutover.");
    assert.equal(output.launchDayWatchPlan.status, "ready");
    assert.equal(output.launchDayWatchPlan.canStartCutoverWatch, true);
    assert.deepEqual(output.launchDayWatchPlan.missingSignoffKeys, []);
    assert.deepEqual(output.launchDayWatchPlan.missingReceiptVisibilityKeys, []);
    assert.equal(output.launchDayWatchPlan.nextAction, "Start launch-day watch with Launch Mainline, Developer Ops, Launch Review, and Launch Smoke receipt visibility open.");
    assert.equal(output.stabilizationHandoffPlan.status, "ready");
    assert.equal(output.stabilizationHandoffPlan.canStartStabilizationHandoff, true);
    assert.equal(output.stabilizationHandoffPlan.sourceWatchStatus, "ready");
    assert.equal(output.stabilizationHandoffPlan.nextAction, "Hand off stabilization notes, first-wave incidents, receipt visibility snapshots, and rollback signals to the stabilization owner.");
    assert.equal(output.stagingRunRecordTemplate.status, "ready_for_stabilization_handoff");
    assert.deepEqual(output.stagingRunRecordTemplate.sourceReadiness, {
      fullTestWindow: "ready",
      productionSignoff: "ready",
      launchDayWatch: "ready",
      stabilizationHandoff: "ready"
    });
    assert.equal(output.filledCloseoutInputExample.status, "example_only");
    assert.equal(output.stagingReadinessTransition.status, "ready_for_launch_day_watch");
    assert.deepEqual(
      output.stagingReadinessTransition.gates.map((item) => [item.key, item.status, item.canEnter]),
      [
        ["full_test_window", "ready", true],
        ["production_signoff", "ready", true],
        ["launch_day_watch", "ready", true]
      ]
    );
    assert.deepEqual(output.stagingReadinessTransition.orderedNextActions, [
      "archive_production_signoff",
      "start_launch_day_watch",
      "prepare_stabilization_handoff"
    ]);
    assert.equal(output.finalRehearsalPacket.status, "ready_for_launch_day_watch");
    assert.equal(output.finalRehearsalPacket.readinessTransitionStatus, "ready_for_launch_day_watch");
    assert.deepEqual(output.finalRehearsalPacket.sourceReadiness, {
      fullTestWindow: "ready",
      productionSignoff: "ready",
      launchDayWatch: "ready",
      stabilizationHandoff: "ready"
    });
    assert.equal(output.operatorExecutionPlan.readinessSummary.gapCount, 2);
    assert.equal(
      output.operatorExecutionPlan.readinessGaps.some((item) => item.key === "production_signoff_blocked"),
      false
    );
    assert.doesNotMatch(result.stdout, /StrongAdmin123!|StrongDeveloper123!/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging rehearsal runner refuses generated closeout input examples as real input", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-rehearsal-example-input-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-closeout-input.example.json");
    writeFileSync(
      closeoutInputFile,
      `${JSON.stringify({ mode: "staging-closeout-input-example", exampleOnly: true }, null, 2)}\n`,
      "utf8"
    );

    const result = runRehearsal([
      ...validArgs,
      "--closeout-input-file",
      closeoutInputFile
    ]);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "fail");
    assert.match(output.error.message, /example closeout input/i);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging rehearsal runner blocks production signoff until all receipt visibility lanes are visible", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "rsl-rehearsal-receipt-visibility-"));
  try {
    const closeoutInputFile = join(tempDir, "filled-signoff-closeout.json");
    const acceptanceFields = [
      "route_map_gate_result",
      "backup_restore_drill_result",
      "live_write_smoke_result",
      "launch_smoke_handoff",
      "launch_mainline_evidence_receipts",
      "receipt_visibility_review",
      "operator_go_no_go"
    ].map((key) => ({
      key,
      status: "filled",
      value: key === "operator_go_no_go" ? "ready-for-full-test-window" : { result: "pass" }
    }));
    const signoffConditions = [
      "full_test_window_passed",
      "staging_artifacts_archived",
      "launch_mainline_receipts_visible",
      "backup_restore_drill_passed",
      "rollback_path_confirmed",
      "operator_signoff_recorded"
    ].map((key) => ({
      key,
      status: "filled",
      value: key === "full_test_window_passed"
        ? { result: "pass", command: "npm.cmd test", failureCount: 0 }
        : { result: "confirmed" }
    }));
    const closeoutInput = {
      mode: "staging-closeout-template",
      decision: "ready-for-full-test-window",
      acceptanceFields,
      receiptVisibility: {
        launchMainline: "visible",
        launchReview: "visible",
        launchSmoke: "visible"
      },
      productionSignoff: {
        decision: "ready-for-production-signoff",
        conditions: signoffConditions
      }
    };
    writeFileSync(closeoutInputFile, `${JSON.stringify(closeoutInput, null, 2)}\n`, "utf8");

    const result = runRehearsal([
      ...validArgs,
      "--closeout-input-file",
      closeoutInputFile
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.closeoutInput.readyForFullTestWindow, true);
    assert.equal(output.closeoutInput.readyForReceiptVisibility, false);
    assert.equal(output.closeoutInput.readyForProductionSignoff, false);
    assert.deepEqual(output.closeoutInput.missingReceiptVisibilityKeys, ["developerOps"]);
    assert.deepEqual(
      output.operatorExecutionPlan.readinessGaps.map((item) => item.key),
      [
        "handoff_file_not_requested",
        "closeout_file_not_requested",
        "receipt_visibility_not_confirmed",
        "production_signoff_blocked"
      ]
    );
    assert.deepEqual(
      output.operatorExecutionPlan.readinessGaps.find((item) => item.key === "receipt_visibility_not_confirmed").missingReceiptVisibilityKeys,
      ["developerOps"]
    );
    assert.equal(output.operatorExecutionPlan.readinessSummary.canRunFullTestWindow, true);
    assert.equal(output.operatorExecutionPlan.readinessSummary.canSignoffProduction, false);
    assert.equal(output.productionSignoffReadiness.status, "blocked");
    assert.equal(output.productionSignoffReadiness.canSignoff, false);
    assert.deepEqual(output.productionSignoffReadiness.missingReceiptVisibilityKeys, ["developerOps"]);
    assert.doesNotMatch(result.stdout, /StrongAdmin123!|StrongDeveloper123!/);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("staging rehearsal runner marks evidence requests ready when bearer token env exists without printing it", () => {
  const result = runRehearsal(validArgs, {
    RSL_DEVELOPER_BEARER_TOKEN: "developer-secret-token"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.evidenceReadiness.status, "ready");
  assert.equal(output.evidenceReadiness.readyToExecute, true);
  assert.equal(output.evidenceReadiness.checks.developerBearerToken, "present");
  assert.equal(output.evidenceReadiness.nextAction, "Copy evidence request snippets only after the matching launch evidence has actually happened.");
  assert.equal(
    output.operatorExecutionPlan.readinessGaps.some((item) => item.key === "developer_bearer_token_missing"),
    false
  );
  assert.doesNotMatch(result.stdout, /developer-secret-token/);
});
